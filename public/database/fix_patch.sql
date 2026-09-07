-- ==========================================
-- PATCH: money and stock fixes
--
-- SKIP THIS FILE ON A NEW COMPUTER.
-- All three changes below are already inside database.sql,
-- so a fresh run of database.sql gives you the fixed schema.
--
-- Use this file only on a machine where hardware_db already exists
-- and you want to keep the rows in it.
-- ==========================================
USE hardware_db;

-- 1. Rebuild the customer credit view.
--    Outstanding money is billed minus paid on any sale not yet marked Paid.
--    Payments already sit in sales.amount_paid, so they are not subtracted twice.
CREATE OR REPLACE VIEW vw_customer_credit AS
SELECT
    c.customer_id,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    COALESCE(cc.credit_limit, 0.00) AS credit_limit,
    COALESCE((SELECT SUM(s.final_amount)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE), 0.00) AS total_purchase,
    COALESCE((SELECT SUM(s.final_amount - s.amount_paid)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS current_credit
FROM customers c
LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id;

-- 2. Allow a later payment on a walk-in sale, which has no customer.
ALTER TABLE credit_payments MODIFY customer_id INT NULL;

-- 3. Repair the seeded sale 8. Its money was recorded in two places,
--    which is where the negative balances came from.
UPDATE sales SET amount_paid = 7440.00 WHERE sale_id = 8;

-- 4. Check the result. No customer should read a negative balance.
SELECT customer_id, customer_name, credit_limit, current_credit
FROM vw_customer_credit
ORDER BY customer_id;
