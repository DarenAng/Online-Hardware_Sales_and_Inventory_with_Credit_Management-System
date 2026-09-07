-- ==========================================================================
-- upgrade_v4.sql
-- Hardware Sales & Inventory with Credit Management
--
-- Turns the credit book from a single number into something a shop can
-- actually run on.
--
-- Before this, a customer had a credit limit and that was the whole policy.
-- Three things were missing, and every one of them is something a hardware
-- shop does every week:
--
--   STANDING.  A customer who always pays and a customer who owes you for
--   four months both fit under a limit. One should be sold to on account and
--   the other should not, and the limit alone cannot tell them apart. So a
--   customer is Good, Watch, or Hold, and Hold refuses new credit outright.
--
--   EXTENSIONS.  A cashier at the counter with a regular customer over their
--   limit has two options today: refuse the sale, or find the manager. The
--   first loses the sale and the second stops the queue. A request raised at
--   the counter and decided by a manager on their own screen is the third.
--
--   PART PAYMENT.  Somebody paying half now and owing half is the commonest
--   credit transaction there is, and the system had nowhere to put it: a
--   sale was either paid in full or entirely on account.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v4.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- The second line is not optional this time: this upgrade changes what the
-- sale procedure has to do, and the procedures come from that file.
-- ==========================================================================

USE hardware_db;

DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

DELIMITER $$

CREATE PROCEDURE sp_upgrade_add_column(
    IN in_table   VARCHAR(64),
    IN in_column  VARCHAR(64),
    IN in_clause  VARCHAR(500)
)
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = in_table
          AND COLUMN_NAME = in_column
    ) THEN
        SET @statement = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `',
                                in_column, '` ', in_clause);
        PREPARE upgrade_stmt FROM @statement;
        EXECUTE upgrade_stmt;
        DEALLOCATE PREPARE upgrade_stmt;
    END IF;
END$$

DELIMITER ;

-- ==========================================================================
-- 1. CREDIT STANDING
-- ==========================================================================

-- Good  sell on account as normal
-- Watch still allowed, but every screen says to look at this account
-- Hold   no new credit at all until a manager lifts it
CALL sp_upgrade_add_column('customer_credits', 'standing',
    "ENUM('Good','Watch','Hold') NOT NULL DEFAULT 'Good' AFTER credit_limit");

-- why the limit is what it is, and why the standing is what it is
CALL sp_upgrade_add_column('customer_credits', 'notes',
    'VARCHAR(255) NULL AFTER standing');

CALL sp_upgrade_add_column('customer_credits', 'updated_at',
    'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER notes');

CALL sp_upgrade_add_column('customer_credits', 'updated_by_staff_id',
    'INT NULL AFTER updated_at');

-- A customer with no credit row at all has no limit and no standing, which
-- reads on every screen as an error rather than as a walk-in. Everybody gets
-- a row; a limit of zero is a perfectly good way of saying "cash only".
INSERT INTO customer_credits (customer_id, credit_limit)
SELECT c.customer_id, 0.00
FROM customers c
LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id
WHERE cc.credit_id IS NULL;

-- ==========================================================================
-- 2. CREDIT EXTENSION REQUESTS
--
-- Raised at the counter, decided by a manager. The requested limit and the
-- limit at the time are both recorded, so an approval a month later cannot
-- be read as approving a bigger jump than was actually asked for.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS credit_requests (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    previous_limit DECIMAL(12,2) NOT NULL,
    requested_limit DECIMAL(12,2) NOT NULL,
    reason VARCHAR(255) NULL,
    status ENUM('Pending','Approved','Declined') NOT NULL DEFAULT 'Pending',
    requested_by_staff_id INT NULL,
    decided_by_staff_id INT NULL,
    decision_note VARCHAR(255) NULL,
    decided_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_credit_request_status (status, created_at),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (requested_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (decided_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- ==========================================================================
-- 3. THE CREDIT VIEW, REBUILT
--
-- It answered two questions: what is the limit, and what is owed. A screen
-- that has to decide whether to sell needs four more: how much is left, how
-- long the oldest debt has been sitting there, how many sales are open, and
-- whether a manager has put a stop on the account.
--
-- Everything here is still derived. Nothing about a balance is stored, so
-- nothing about a balance can go stale.
-- ==========================================================================
CREATE OR REPLACE VIEW vw_customer_credit AS
SELECT
    c.customer_id,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    c.phone,
    c.address,
    COALESCE(cc.credit_limit, 0.00) AS credit_limit,
    COALESCE(cc.standing, 'Good') AS standing,
    cc.notes AS credit_notes,
    cc.updated_at AS credit_updated_at,

    COALESCE((SELECT SUM(s.final_amount)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE), 0.00) AS total_purchase,

    -- outstanding money is billed minus paid on any sale not yet marked Paid.
    -- payments already sit in sales.amount_paid, so they are not subtracted twice
    COALESCE((SELECT SUM(s.final_amount - s.amount_paid)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS current_credit,

    -- What is left to spend. Never negative: an account already over its
    -- limit has nothing available, and a negative figure on that line reads
    -- as a credit balance, which is the opposite of what it means.
    GREATEST(COALESCE(cc.credit_limit, 0.00) -
             COALESCE((SELECT SUM(s.final_amount - s.amount_paid)
                       FROM sales s
                       WHERE s.customer_id = c.customer_id
                         AND s.is_archived = FALSE
                         AND s.payment_status <> 'Paid'), 0.00), 0.00) AS available_credit,

    (SELECT COUNT(*) FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_status <> 'Paid') AS open_sales,

    -- how long the oldest unpaid sale has been sitting there, which is the
    -- figure that actually tells a slow payer from a bad one
    (SELECT DATEDIFF(CURDATE(), DATE(MIN(s.sale_date)))
     FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_status <> 'Paid') AS oldest_debt_days,

    (SELECT MAX(s.sale_date) FROM sales s
     WHERE s.customer_id = c.customer_id AND s.is_archived = FALSE) AS last_purchase,

    (SELECT MAX(p.payment_date) FROM credit_payments p
     WHERE p.customer_id = c.customer_id) AS last_payment

FROM customers c
LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id;

-- ==========================================================================
-- 4. SEED STANDING, SO THE SCREEN HAS SOMETHING TO SHOW
--
-- Only accounts still on the default are touched, so running this twice does
-- not undo a manager's decision.
-- ==========================================================================
UPDATE customer_credits cc
JOIN vw_customer_credit v ON v.customer_id = cc.customer_id
SET cc.standing = 'Watch',
    cc.notes = 'Placed on watch automatically: oldest unpaid sale is over 30 days.'
WHERE cc.standing = 'Good'
  AND cc.notes IS NULL
  AND COALESCE(v.oldest_debt_days, 0) > 30;

-- ==========================================================================
-- 5. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v4.sql finished. Now load stored_Procedure.sql to pick up the credit procedures.' AS result;
