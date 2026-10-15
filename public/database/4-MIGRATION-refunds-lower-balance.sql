-- ==========================================================================
-- 4-MIGRATION-refunds-lower-balance.sql
-- Lucelyn Hardware - a refund now comes off what the customer owes.
--
-- Before: a refund only wrote a row in returned_items; the sale still owed
-- the same amount. After: a refund filed on a sale lowers its balance, up to
-- what is still owed. Whatever is more than the balance is cash handed back,
-- so the amount owed never goes below zero. A sale that was paid in full
-- keeps its status; a sale whose balance reaches zero turns Paid. Refunds on
-- one sale never add up to more than the customer was charged (after the
-- discount), and a line cannot be refunded more times than it was sold.
--
-- What this file changes (it never drops a table or the database, and no
-- row is deleted):
--   1. adds sales.refunded_amount (0.00 on every sale that exists today)
--   2. makes sales.amount_due = total - discount + penalty - refunded_amount
--   3. re-creates sp_file_return_report (raises refunded_amount, checks the
--      refund against the sale under a lock, and has a new OUT parameter,
--      p_off_balance) and sp_apply_late_penalties (a penalty is charged on
--      the goods still unpaid after refunds)
--   4. re-creates the two credit views, which show a penalty only up to the
--      balance still owed on its sale
--
-- Needs the late-payment penalty columns (sales.penalty_amount,
-- penalty_applied_at and amount_due). Every database made from
-- 1-RUN-FIRST-database.sql has them, and the server adds them to an older one
-- when it starts. On a database that has not got them yet, steps 1 and 2 say
-- so and skip, and the file stops before it drops anything: start the server
-- once, then run this file again.
--
-- Safe to run more than once: each step checks first. Refunds filed before
-- this change are not touched; they were already settled in cash.
--
-- How to run it (local MySQL; the server also does steps 1 and 2 by itself
-- when it starts, and loads file 2 again when it finds the older procedures):
--   mysql -u root -p < public/database/4-MIGRATION-refunds-lower-balance.sql
--
-- On Aiven run this same file, with the USE line below changed to the Aiven
-- database name (it is "defaultdb" unless you made another).
--
-- File 2 holds the same procedures and views; run it after any later change
-- to them. It now holds a newer sp_file_return_report (two more parameters,
-- for Missing reports; see 5-MIGRATION-missing-delivery-reports.sql), so on a
-- database that already has that, run file 2 again after this file.
-- ==========================================================================

USE hardware_db;

-- 1. the new column, placed before amount_due, which is worked out from it
SET @has_due = (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
                  AND COLUMN_NAME = 'amount_due');
SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
                     AND COLUMN_NAME = 'refunded_amount');
SET @step = IF(@has_column > 0,
    'SELECT ''sales.refunded_amount is already there'' AS note',
    IF(@has_due = 0,
       'SELECT ''Skipped: this database has no sales.amount_due yet. Start the server once, then run this file again.'' AS note',
       'ALTER TABLE sales ADD COLUMN refunded_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER penalty_applied_at'));
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

-- 2. amount_due takes the refunds off
SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
                     AND COLUMN_NAME = 'refunded_amount');
SET @uses_it = (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'
                  AND COLUMN_NAME = 'amount_due'
                  AND GENERATION_EXPRESSION LIKE '%refunded_amount%');
SET @step = IF(@uses_it > 0,
    'SELECT ''sales.amount_due already takes refunds off'' AS note',
    IF(@has_due = 0 OR @has_column = 0,
       'SELECT ''Skipped: sales.refunded_amount or sales.amount_due is missing (see the top of this file).'' AS note',
       'ALTER TABLE sales MODIFY COLUMN amount_due DECIMAL(12,2) AS (total_amount - discount + penalty_amount - refunded_amount) STORED'));
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

-- Stops here, with "Unknown column", before anything is dropped, when the
-- columns above are not there (see the note at the top).
SELECT refunded_amount, amount_due FROM sales LIMIT 0;

-- 3 and 4. the procedures and views (the same text as in 2-RUN-SECOND-stored-procedures.sql)
DELIMITER //

DROP PROCEDURE IF EXISTS sp_file_return_report //
CREATE PROCEDURE sp_file_return_report (
    IN p_product_id INT,
    IN p_sale_id INT,
    IN p_report_type VARCHAR(20),
    IN p_quantity DECIMAL(12,3),
    IN p_reason TEXT,
    IN p_refund_amount DECIMAL(12,2),
    -- Where the goods go, in words; restocked is derived from it. A Refunded
    -- report may leave it NULL: the goods wait for the clerk to inspect them
    -- (sp_resolve_return_report), and nothing moves on the shelf until then.
    IN p_disposition VARCHAR(20),
    IN p_staff_id INT,
    OUT p_report_id INT,
    -- how much of a refund came off what the customer owes on the sale
    OUT p_off_balance DECIMAL(12,2),
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_due DECIMAL(12,2);
    DECLARE v_paid DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_final DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_sold DECIMAL(12,3) DEFAULT 0;
    DECLARE v_taken DECIMAL(12,3) DEFAULT 0;
    DECLARE v_refunded_before DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_off DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_on_sale BOOLEAN DEFAULT FALSE;
    DECLARE v_before DECIMAL(12,3);
    DECLARE v_change DECIMAL(12,3) DEFAULT 0;
    DECLARE v_notif VARCHAR(20);
    DECLARE v_restock BOOLEAN DEFAULT FALSE;
    DECLARE v_where VARCHAR(20);
    DECLARE v_awaiting BOOLEAN DEFAULT FALSE;
    DECLARE v_voided BOOLEAN DEFAULT FALSE;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- first, before anything clears it: the real error, for the server log
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_report_id = NULL;
        SET p_off_balance = 0.00;
        SET p_status_code = 500;
        -- the server logs this and sends the browser a plain sentence instead
        SET p_message = CONCAT('sp_file_return_report failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_report_id = NULL;
    SET p_off_balance = 0.00;

    IF p_report_type NOT IN ('Return', 'Damaged', 'Refunded') THEN
        SET p_status_code = 400;
        SET p_message = 'Type must be Return, Damaged, or Refunded.';
        LEAVE PROC_BODY;
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Quantity must be greater than zero.';
        LEAVE PROC_BODY;
    END IF;

    -- A refund is money going back against a sale, so it must name the sale.
    -- Without one, nothing checks the amount against what was charged.
    IF p_report_type = 'Refunded' AND p_sale_id IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A refund must be filed against a sale.';
        LEAVE PROC_BODY;
    END IF;

    -- a negative refund would put money back on the customer's bill
    IF p_refund_amount IS NOT NULL AND p_refund_amount < 0 THEN
        SET p_status_code = 400;
        SET p_message = 'The refund amount cannot be negative.';
        LEAVE PROC_BODY;
    END IF;

    -- the bar is a sentence rather than a word
    IF p_reason IS NULL OR CHAR_LENGTH(TRIM(p_reason)) < 10 THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('Say what happened, in a sentence. ',
                               'A write-off queried three months from now has to be ',
                               'explainable from this line alone.');
        LEAVE PROC_BODY;
    END IF;

    SET v_where = NULLIF(TRIM(IFNULL(p_disposition, '')), '');

    -- a refund taken back at the counter is the clerk's to judge; anything
    -- else (damage found in the stockroom) is filed by the person who judged it
    SET v_awaiting = (v_where IS NULL AND p_report_type = 'Refunded');

    IF NOT v_awaiting AND (v_where IS NULL OR v_where NOT IN ('Return to Stock', 'Write-Off')) THEN
        SET p_status_code = 400;
        SET p_message = 'Say where the goods go: Return to Stock, or Write-Off.';
        LEAVE PROC_BODY;
    END IF;

    -- one decision, one flag; restocked is no longer set separately (and
    -- false, not null, while the goods wait to be inspected)
    SET v_restock = IFNULL(v_where = 'Return to Stock', FALSE);

    SET v_name = NULL;
    SELECT product_name INTO v_name FROM products WHERE product_id = p_product_id;

    IF v_name IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Product not found.';
        LEAVE PROC_BODY;
    END IF;

    -- The shelf row is read FOR UPDATE inside the transaction, the same as in
    -- sp_adjust_stock: a report and an adjustment on the same material at the
    -- same moment cannot both read the old figure and write over each other.
    START TRANSACTION;

    SET v_before = 0;
    SELECT COALESCE(quantity_in_stock, 0) INTO v_before
    FROM inventory WHERE product_id = p_product_id
    FOR UPDATE;

    -- A refund on a sale is checked against the sale, and this is the real
    -- guard (the route only words the same refusals nicely). The sale row is
    -- locked FOR UPDATE first and the figures are read after the lock, so two
    -- refunds of the same line at the same moment take turns: the second one
    -- sees the first one's report and is refused if nothing is left to refund.
    IF p_report_type = 'Refunded' AND p_sale_id IS NOT NULL THEN
        SET v_due = NULL;
        SELECT amount_due, amount_paid, final_amount, is_archived
        INTO v_due, v_paid, v_final, v_voided
        FROM sales WHERE sale_id = p_sale_id
        FOR UPDATE;

        IF v_due IS NULL THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'That sale was not found.';
            LEAVE PROC_BODY;
        END IF;

        -- a voided sale was cancelled and its stock put back; refunding it
        -- would pay out money that was never taken
        IF v_voided THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'That sale was voided; there is nothing to refund.';
            LEAVE PROC_BODY;
        END IF;

        -- what the sale holds of this product, and what has already come back
        SELECT COALESCE(SUM(quantity), 0) INTO v_sold
        FROM sale_items WHERE sale_id = p_sale_id AND product_id = p_product_id;

        SELECT COALESCE(SUM(quantity), 0) INTO v_taken
        FROM returned_items
        WHERE sale_id = p_sale_id AND product_id = p_product_id
          AND report_type IN ('Refunded', 'Return');

        IF v_sold = 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = 'That item is not on this sale.';
            LEAVE PROC_BODY;
        END IF;

        IF p_quantity > v_sold - v_taken + 0.0005 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = IF(v_sold - v_taken <= 0,
                'That item has already been refunded in full.',
                CONCAT('Only ', TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(v_sold - v_taken AS CHAR))),
                       ' of that item can still be refunded.'));
            LEAVE PROC_BODY;
        END IF;

        -- Refunds on one sale never add up to more than the customer was
        -- charged (final_amount, after the discount). That also means the cash
        -- handed back can never be more than was paid: cash back only starts
        -- once the balance is gone, and then it is at most final_amount minus
        -- what came off the balance, which is at most what the customer paid.
        SELECT COALESCE(SUM(refund_amount), 0) INTO v_refunded_before
        FROM returned_items
        WHERE sale_id = p_sale_id AND report_type = 'Refunded';

        IF v_refunded_before + IFNULL(p_refund_amount, 0) > v_final + 0.01 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('Refunds on this sale would come to more than the customer was charged (',
                                   FORMAT(v_final, 2), '). ', FORMAT(v_refunded_before, 2), ' is refunded already.');
            LEAVE PROC_BODY;
        END IF;

        SET v_on_sale = TRUE;
    END IF;

    -- Return to Stock always adds. Write-Off subtracts only when the goods were
    -- still counted as stock (a customer's return was deducted when sold).
    -- Awaiting inspection moves nothing: the clerk's verdict does that.
    IF v_awaiting THEN
        SET v_change = 0;
    ELSEIF v_restock THEN
        SET v_change = p_quantity;
    ELSEIF p_sale_id IS NULL THEN
        SET v_change = -LEAST(p_quantity, v_before);
    END IF;

    INSERT INTO returned_items
        (product_id, sale_id, report_type, quantity, reason, disposition,
         refund_amount, restocked, status, reported_by_staff_id)
    VALUES
        (p_product_id, p_sale_id, p_report_type, p_quantity, TRIM(p_reason), v_where,
         IFNULL(p_refund_amount, 0.00), v_restock, 'Open', p_staff_id);

    SET p_report_id = LAST_INSERT_ID();

    -- A refund on a sale comes off what the customer owes, up to the balance.
    -- Anything over that is cash handed back, so the bill never falls below
    -- what has been paid. The sale row is already locked (above), so a payment
    -- at the same moment cannot be counted twice.
    IF v_on_sale AND IFNULL(p_refund_amount, 0) > 0 THEN
        SET v_off = LEAST(p_refund_amount, GREATEST(v_due - v_paid, 0.00));

        IF v_off > 0 THEN
            -- amount_due is worked out from refunded_amount by the table;
            -- the status turns Paid when nothing is left to collect
            UPDATE sales
            SET refunded_amount = refunded_amount + v_off,
                payment_status = IF(v_paid >= v_due - v_off, 'Paid', payment_status)
            WHERE sale_id = p_sale_id;
        END IF;
    END IF;
    SET p_off_balance = v_off;

    IF v_change <> 0 THEN
        UPDATE inventory
        SET quantity_in_stock = v_before + v_change
        WHERE product_id = p_product_id;

        INSERT INTO stock_adjustments
            (product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, adjusted_by_staff_id)
        VALUES
            (p_product_id, IF(v_change > 0, 'Add', 'Remove'), v_before, v_change, v_before + v_change,
             CONCAT(p_report_type, ' report #', p_report_id, ': ', v_where,
                    ' - ', LEFT(TRIM(p_reason), 120)), p_staff_id);
    END IF;

    SET v_notif = IF(p_report_type = 'Refunded', 'Refund Report', 'Damage Report');

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (2, v_notif, CONCAT(p_report_type, ' filed for ', v_name),
            CONCAT(p_quantity, ' unit(s), ', IF(v_awaiting, 'awaiting the clerk''s inspection', v_where),
                   ': ', LEFT(TRIM(p_reason), 110)),
            p_product_id, p_staff_id);

    -- the clerk is asked to look at what came back
    IF v_awaiting THEN
        INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
        VALUES (3, 'Refund Report', CONCAT('Inspect ', v_name, ' returned at the counter'),
                CONCAT(p_quantity, ' unit(s) refunded, report #', p_report_id, '. Check whether it can be ',
                       'sold again: back on the shelf, or written off. ', LEFT(TRIM(p_reason), 100)),
                p_product_id, p_staff_id);
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, UPPER(REPLACE(p_report_type, ' ', '_')), 'CREATE',
            CONCAT(v_name, ' x', p_quantity, ' (report #', p_report_id, ')'));

    COMMIT;

    IF v_change < 0 THEN
        CALL sp_raise_stock_alert(p_product_id, p_staff_id);
    END IF;

    SET p_status_code = 201;
    SET p_message = IF(v_awaiting,
        CONCAT(p_report_type, ' report filed. The goods are set aside for the stockroom to inspect.'),
        CONCAT(p_report_type, ' report filed.'));

    -- say where the money went when the refund was on a sale
    IF v_on_sale THEN
        IF v_off > 0 THEN
            SET p_message = CONCAT(p_message, ' ', FORMAT(v_off, 2), ' came off what the customer owes.');
        END IF;
        IF p_refund_amount > v_off THEN
            SET p_message = CONCAT(p_message, ' ', FORMAT(p_refund_amount - v_off, 2), ' is cash to hand back.');
        END IF;
    END IF;
END //

DROP PROCEDURE IF EXISTS sp_apply_late_penalties //
CREATE PROCEDURE sp_apply_late_penalties (
    OUT p_applied INT,
    OUT p_total DECIMAL(12,2)
)
BEGIN
    DECLARE v_done INT DEFAULT 0;
    DECLARE v_sale_id INT;
    DECLARE v_customer_id INT;
    DECLARE v_name VARCHAR(220);
    DECLARE v_unpaid DECIMAL(12,2);
    DECLARE v_balance DECIMAL(12,2);
    DECLARE v_rate DECIMAL(5,2);
    DECLARE v_months_due INT;
    DECLARE v_months_charged INT;
    DECLARE v_months_new INT;
    DECLARE v_penalty DECIMAL(12,2);
    DECLARE v_days INT;

    DECLARE cur CURSOR FOR
        SELECT s.sale_id, s.customer_id,
               TRIM(CONCAT(c.first_name, ' ', c.last_name)),
               GREATEST(s.final_amount - s.refunded_amount - s.amount_paid, 0.00),
               s.amount_due - s.amount_paid,
               COALESCE(cc.penalty_rate, (SELECT penalty_rate FROM store_settings WHERE setting_id = 1), 3.00),
               DATEDIFF(CURDATE(), DATE_ADD(DATE(s.sale_date), INTERVAL 30 DAY)),
               s.penalty_months
        FROM sales s
        JOIN customers c ON c.customer_id = s.customer_id
        LEFT JOIN customer_credits cc ON cc.customer_id = s.customer_id
        WHERE s.is_archived = FALSE
          AND s.payment_method = 'Credit'
          AND s.payment_status <> 'Paid'
          AND s.final_amount - s.refunded_amount - s.amount_paid > 0
          AND DATE(s.sale_date) < DATE_SUB(CURDATE(), INTERVAL 30 DAY)
          -- a month or part of one past due that has not been charged yet
          AND CEILING(DATEDIFF(CURDATE(), DATE_ADD(DATE(s.sale_date), INTERVAL 30 DAY)) / 30) > s.penalty_months;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- first, before anything clears it: the real error, for the server log
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_applied = -1;
        SET p_total = 0.00;
    END;

    SET p_applied = 0;
    SET p_total = 0.00;

    START TRANSACTION;

    OPEN cur;
    read_loop: LOOP
        FETCH cur INTO v_sale_id, v_customer_id, v_name, v_unpaid, v_balance, v_rate, v_days, v_months_charged;
        IF v_done = 1 THEN LEAVE read_loop; END IF;

        -- day 1 past due is month 1; day 31 is month 2
        SET v_months_due = CEILING(v_days / 30);
        SET v_months_new = v_months_due - v_months_charged;
        SET v_penalty = ROUND(v_unpaid * v_rate / 100 * v_months_new, 2);

        UPDATE sales
        SET penalty_rate = v_rate,
            penalty_months = v_months_due,
            penalty_amount = penalty_amount + v_penalty,
            penalty_applied_at = NOW()
        WHERE sale_id = v_sale_id;

        IF v_penalty > 0 THEN
            INSERT INTO audit_logs (staff_id, action, action_type, details)
            VALUES (NULL, 'LATE_PENALTY', 'UPDATE',
                    CONCAT('Sale #', v_sale_id, ' (', v_name, '): ', FORMAT(v_rate, 2), '% of ',
                           FORMAT(v_unpaid, 2), ' unpaid for ', v_months_new, IF(v_months_new = 1, ' month', ' months'),
                           ' = ', FORMAT(v_penalty, 2), ' penalty; month ', v_months_due, ' overdue, ',
                           v_days, IF(v_days = 1, ' day', ' days'), ' past due'));

            -- the manager, who sets the rate, and the cashier, who takes the payment
            INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
            VALUES (2, 'Late Penalty',
                    CONCAT('Late penalty of ', FORMAT(v_penalty, 2), ' on sale #', v_sale_id),
                    CONCAT(v_name, ' is ', v_days, IF(v_days = 1, ' day', ' days'), ' past the due date with ',
                           FORMAT(v_unpaid, 2), ' of goods unpaid. Month ', v_months_due, ' overdue: ',
                           FORMAT(v_rate, 2), '% was added; the sale now owes ',
                           FORMAT(v_balance + v_penalty, 2), '.'), NULL);
            INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
            VALUES (4, 'Late Penalty',
                    CONCAT('Late penalty of ', FORMAT(v_penalty, 2), ' on sale #', v_sale_id),
                    CONCAT(v_name, ' is ', v_days, IF(v_days = 1, ' day', ' days'), ' past the due date, month ',
                           v_months_due, ' overdue. The balance to collect on this sale is now ',
                           FORMAT(v_balance + v_penalty, 2), '.'), NULL);
        END IF;

        SET p_applied = p_applied + 1;
        SET p_total = p_total + v_penalty;
    END LOOP;
    CLOSE cur;

    COMMIT;
END //

DROP VIEW IF EXISTS vw_customer_credit //
DROP VIEW IF EXISTS vw_customer_credit_facts //

CREATE VIEW vw_customer_credit_facts AS

SELECT
    c.customer_id,
    TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
    c.phone,
    c.address,
    COALESCE(cc.credit_limit, 0.00) AS credit_limit,
    COALESCE(cc.standing, 'Good') AS manual_standing,
    cc.notes AS credit_notes,
    cc.updated_at AS credit_updated_at,

    -- the late-payment rate: the manager's word on this account, else the shop's
    cc.penalty_rate AS penalty_rate_override,
    COALESCE(cc.penalty_rate, (SELECT penalty_rate FROM store_settings WHERE setting_id = 1), 3.00)
        AS penalty_rate,

    COALESCE((SELECT SUM(s.final_amount)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE), 0.00) AS total_purchase,

    -- billed, with any late penalty on it, minus paid on any sale not yet marked Paid
    COALESCE((SELECT SUM(s.amount_due - s.amount_paid)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS current_credit,

    -- how much of that is late-payment penalty rather than goods
    -- (a penalty is shown only up to the balance left on its sale: after a
    -- payment or a refund the balance can be smaller than the penalty charged)
    COALESCE((SELECT SUM(LEAST(s.penalty_amount, GREATEST(s.amount_due - s.amount_paid, 0)))
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS penalties_owed,

    -- sales that have passed their 30-day due date still owing
    (SELECT COUNT(*) FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_status <> 'Paid'
       AND DATE(s.sale_date) < DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS overdue_sales,

    -- never negative: an account over its limit has nothing available
    GREATEST(COALESCE(cc.credit_limit, 0.00) -
             COALESCE((SELECT SUM(s.amount_due - s.amount_paid)
                       FROM sales s
                       WHERE s.customer_id = c.customer_id
                         AND s.is_archived = FALSE
                         AND s.payment_status <> 'Paid'), 0.00), 0.00) AS available_credit,

    (SELECT COUNT(*) FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_status <> 'Paid') AS open_sales,

    -- how long the oldest unpaid sale has been sitting there
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
LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id //

-- ==========================================
-- WHAT "STANDING" MEANS
--
--   HOLD   over the credit limit, oldest unpaid sale over 90 days, or a
--          manager put the account on hold
--   WATCH  oldest unpaid sale over 30 days, balance 75% or more of the
--          limit, or a manager flagged the account
--   GOOD   none of the above
--
-- The manager's word (customer_credits.standing) only makes it stricter;
-- Good means "let the figures decide". The thresholds are written twice
-- (tier and reason) in the same order, so the two cannot disagree.
-- ==========================================
CREATE VIEW vw_customer_credit AS
SELECT
    f.*,

    -- the tier the figures alone would give, before the manager's word
    CASE
        WHEN f.credit_limit > 0 AND f.current_credit > f.credit_limit THEN 'Hold'
        WHEN f.oldest_debt_days > 90                                   THEN 'Hold'
        WHEN f.oldest_debt_days > 30                                   THEN 'Watch'
        WHEN f.credit_limit > 0 AND f.current_credit >= f.credit_limit * 0.75 THEN 'Watch'
        ELSE 'Good'
    END AS computed_standing,

    -- the tier in force: the stricter of the figures and the manager's word
    CASE
        WHEN f.manual_standing = 'Hold'                                THEN 'Hold'
        WHEN f.credit_limit > 0 AND f.current_credit > f.credit_limit THEN 'Hold'
        WHEN f.oldest_debt_days > 90                                   THEN 'Hold'
        WHEN f.manual_standing = 'Watch'                               THEN 'Watch'
        WHEN f.oldest_debt_days > 30                                   THEN 'Watch'
        WHEN f.credit_limit > 0 AND f.current_credit >= f.credit_limit * 0.75 THEN 'Watch'
        ELSE 'Good'
    END AS standing,

    -- why, in words, for the screen that shows the badge
    CASE
        WHEN f.manual_standing = 'Hold' THEN
            CONCAT('Put on hold by a manager',
                   IF(f.credit_notes IS NULL OR f.credit_notes = '', '', CONCAT(': ', f.credit_notes)))
        WHEN f.credit_limit > 0 AND f.current_credit > f.credit_limit THEN
            CONCAT('Over the limit by ', FORMAT(f.current_credit - f.credit_limit, 2))
        WHEN f.oldest_debt_days > 90 THEN
            CONCAT('Oldest unpaid sale is ', f.oldest_debt_days, ' days old; the limit is 90')
        WHEN f.manual_standing = 'Watch' THEN
            CONCAT('Flagged by a manager',
                   IF(f.credit_notes IS NULL OR f.credit_notes = '', '', CONCAT(': ', f.credit_notes)))
        WHEN f.oldest_debt_days > 30 THEN
            CONCAT('Oldest unpaid sale is ', f.oldest_debt_days, ' days old; watched past 30')
        WHEN f.credit_limit > 0 AND f.current_credit >= f.credit_limit * 0.75 THEN
            CONCAT('Owes ', ROUND(f.current_credit / f.credit_limit * 100), '% of the limit; watched from 75%')
        WHEN f.current_credit > 0 THEN 'Owes within terms'
        ELSE 'Nothing owed'
    END AS standing_reason

FROM vw_customer_credit_facts f //

DELIMITER ;
