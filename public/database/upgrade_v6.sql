-- ==========================================================================
-- upgrade_v6.sql
-- Hardware Sales & Inventory with Credit Management
--
-- The counter stops throwing away the customer's name.
--
-- A sale to somebody who is not on the credit book was recorded as "Walk-in"
-- and nothing else, so a receipt reprinted a week later could not say who it
-- was for, and a delivery booked against that sale had nobody's name on it.
-- The cashier always knew the name; the database simply had nowhere to put
-- it. walk_in_name is that place. It is not a customer account and does not
-- pretend to be one: an account is created deliberately, from the counter,
-- when the cashier says so.
--
-- The delivery record gains the same honesty. It used to read the name and
-- the phone number off the sale's customer, which meant a delivery for a
-- walk-in had neither, and a driver holding the manifest had an address and
-- no one to ring on arrival. contact_name and contact_phone are what the
-- cashier actually wrote down when the delivery was booked, and they win
-- over the joined customer row because the person who took the order is
-- closer to the truth than a record from six months ago.
--
-- scheduled_date widens from DATE to DATETIME. "Tuesday" is not a delivery
-- slot; "Tuesday 2pm" is, and a shop rescheduling around a conflict needs
-- the hour or the reschedule means nothing. Widening a DATE to a DATETIME
-- keeps every existing row, at midnight of the day it already held.
--
-- booked_date is the day the delivery was written up, kept separately from
-- the day it is meant to arrive, because those two dates answer different
-- questions and updated_at answers neither once a driver has touched the row.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v6.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- The second line is not optional: the sale and delivery procedures both
-- take new parameters, and a new procedure creates a customer from the
-- counter.
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
-- 1. THE NAME ON A SALE THAT HAS NO ACCOUNT
--
-- NULL, not empty string, when there is genuinely no name: "we did not ask"
-- and "the customer is called nothing" are different facts and only one of
-- them is true.
-- ==========================================================================
CALL sp_upgrade_add_column('sales', 'walk_in_name',
    "VARCHAR(150) NULL AFTER customer_id");

-- ==========================================================================
-- 2. WHO THE DRIVER IS ACTUALLY LOOKING FOR
-- ==========================================================================
CALL sp_upgrade_add_column('deliveries', 'contact_name',
    "VARCHAR(150) NULL AFTER delivery_address");

CALL sp_upgrade_add_column('deliveries', 'contact_phone',
    "VARCHAR(30) NULL AFTER contact_name");

CALL sp_upgrade_add_column('deliveries', 'booked_date',
    "DATE NULL AFTER remarks");

-- Existing rows were booked on some day; updated_at is the closest thing the
-- old schema recorded to it, and it is right for every delivery a driver has
-- not touched since. Only rows with nothing at all are filled in.
UPDATE deliveries
SET booked_date = DATE(updated_at)
WHERE booked_date IS NULL;

-- ==========================================================================
-- 3. A SLOT, NOT A DAY
--
-- Every existing scheduled_date becomes midnight of the day it already held,
-- which is what a DATE meant anyway. Nothing is lost and nothing moves.
-- Running this twice is harmless: MySQL accepts MODIFY to the type a column
-- already has.
-- ==========================================================================
ALTER TABLE deliveries MODIFY scheduled_date DATETIME NULL;

-- ==========================================================================
-- 4. EVERY CUSTOMER HAS A CREDIT ROW
--
-- vw_customer_credit copes with a missing row by coalescing to zero, so this
-- changes no figure anywhere. It exists so that a customer created at the
-- counter and a customer created by a manager are the same shape of record,
-- and a manager raising a limit is editing a row rather than discovering it
-- is not there.
-- ==========================================================================
INSERT INTO customer_credits (customer_id, credit_limit, standing)
SELECT c.customer_id, 0.00, 'Good'
FROM customers c
LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id
WHERE cc.credit_id IS NULL;

-- ==========================================================================
-- 5. A NAME WITH NO TRAILING SPACE
--
-- A one-word name is ordinary, and the empty surname beside it left every
-- screen printing "Boyet " with a space on the end. The view is replaced
-- rather than altered because a view is a definition and not data: nothing is
-- stored in it, so nothing is lost by rewriting it.
-- ==========================================================================
CREATE OR REPLACE VIEW vw_customer_credit AS
SELECT
    c.customer_id,
    -- A one-word name is ordinary, and the empty surname beside it must not
    -- leave a trailing space on every screen that prints the name.
    TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
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

    -- What is left to spend. Never negative: an account already over its limit
    -- has nothing available, and a negative figure on that line reads as a
    -- credit balance, which is the opposite of what it means.
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
-- 6. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v6.sql finished. Now load stored_Procedure.sql to pick up the sale, delivery and customer procedures.' AS result;
