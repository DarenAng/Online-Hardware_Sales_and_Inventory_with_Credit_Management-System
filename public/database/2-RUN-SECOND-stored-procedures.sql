-- ==========================================================================
-- 2-RUN-SECOND-stored-procedures.sql
-- Hardware Sales & Inventory with Credit Management
--
-- The 3 views and the 30 stored procedures. Runs after 1-RUN-FIRST because
-- the tables must exist. Safe to re-run at any time: it drops and recreates
-- the views and procedures and touches no row. If the server starts with
-- "PROCEDURE does not exist", this file is what fixes it.
--
--   mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
-- ==========================================================================

USE hardware_db;

DELIMITER //

-- ==========================================
-- 0. VIEWS -- here rather than file 1 because this is the file safe to re-run
-- ==========================================
DROP VIEW IF EXISTS vw_customer_credit //
DROP VIEW IF EXISTS vw_customer_credit_facts //
DROP VIEW IF EXISTS vw_archives //

-- Balances are derived from the sales, so they live here and cannot go stale.
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

    COALESCE((SELECT SUM(s.final_amount)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE), 0.00) AS total_purchase,

    -- billed minus paid on any sale not yet marked Paid
    COALESCE((SELECT SUM(s.final_amount - s.amount_paid)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS current_credit,

    -- never negative: an account over its limit has nothing available
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

-- one row per archived record, whatever module it came from
CREATE VIEW vw_archives AS
SELECT 'Staff' AS module, s.staff_id AS record_id,
       s.full_name AS record_name,
       r.role_name AS detail, s.archived_at,
       a.full_name AS archived_by
FROM staff s
JOIN roles r ON r.role_id = s.role_id
LEFT JOIN staff a ON a.staff_id = s.archived_by_staff_id
WHERE s.is_active = FALSE
UNION ALL
SELECT 'Inventory', p.product_id, p.product_name,
       CONCAT('Stock ', COALESCE(i.quantity_in_stock, 0)), p.archived_at,
       a.full_name
FROM products p
LEFT JOIN inventory i ON i.product_id = p.product_id
LEFT JOIN staff a ON a.staff_id = p.archived_by_staff_id
WHERE p.is_archived = TRUE
UNION ALL
SELECT 'Sales', sa.sale_id, CONCAT('Sale #', sa.sale_id),
       CONCAT(sa.payment_method, ' ', FORMAT(sa.final_amount, 2)), sa.archived_at,
       a.full_name
FROM sales sa
LEFT JOIN staff a ON a.staff_id = sa.archived_by_staff_id
WHERE sa.is_archived = TRUE
UNION ALL
SELECT 'Delivery', d.delivery_id, CONCAT('Delivery #', d.delivery_id),
       d.status, d.archived_at,
       a.full_name
FROM deliveries d
LEFT JOIN staff a ON a.staff_id = d.archived_by_staff_id
WHERE d.is_archived = TRUE //

DROP PROCEDURE IF EXISTS sp_reset_user_password //
DROP PROCEDURE IF EXISTS sp_create_sale_transaction //
DROP PROCEDURE IF EXISTS sp_create_staff_account //
DROP PROCEDURE IF EXISTS sp_update_staff_account //
DROP PROCEDURE IF EXISTS sp_set_staff_status //
DROP PROCEDURE IF EXISTS sp_create_login_for_staff //
DROP PROCEDURE IF EXISTS sp_archive_record //
DROP PROCEDURE IF EXISTS sp_restore_archive //
DROP PROCEDURE IF EXISTS sp_record_credit_payment //
DROP PROCEDURE IF EXISTS sp_raise_stock_alert //
DROP PROCEDURE IF EXISTS sp_adjust_stock //
DROP PROCEDURE IF EXISTS sp_set_reorder_point //
DROP PROCEDURE IF EXISTS sp_ensure_supplier //
DROP PROCEDURE IF EXISTS sp_ensure_material //
DROP PROCEDURE IF EXISTS sp_create_material //
DROP PROCEDURE IF EXISTS sp_create_purchase_order //
DROP PROCEDURE IF EXISTS sp_receive_purchase_order //
DROP PROCEDURE IF EXISTS sp_file_return_report //
DROP PROCEDURE IF EXISTS sp_resolve_return_report //
DROP PROCEDURE IF EXISTS sp_create_delivery //
DROP PROCEDURE IF EXISTS sp_update_delivery_status //
DROP PROCEDURE IF EXISTS sp_set_credit_limit //
DROP PROCEDURE IF EXISTS sp_request_credit_extension //
DROP PROCEDURE IF EXISTS sp_decide_credit_request //
DROP PROCEDURE IF EXISTS sp_create_customer //
DROP PROCEDURE IF EXISTS sp_rename_unit //
DROP PROCEDURE IF EXISTS sp_update_store_settings //
DROP PROCEDURE IF EXISTS sp_sweep_archives //
DROP PROCEDURE IF EXISTS sp_set_system_permission //
DROP PROCEDURE IF EXISTS sp_save_connected_system //
-- ==========================================
-- 1. PASSWORD RESET
-- ==========================================
CREATE PROCEDURE sp_reset_user_password (
    IN p_staff_id INT,
    IN p_new_password VARCHAR(255),
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_user_count INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Database error occurred during password reset.';
    END;

    IF p_new_password IS NULL OR CHAR_LENGTH(p_new_password) < 8 THEN
        SET p_status_code = 400;
        SET p_message = 'Password must contain at least 8 characters.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_user_count FROM users WHERE staff_id = p_staff_id;

    IF v_user_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'This staff member has no login account.';
        LEAVE PROC_BODY;
    END IF;

    UPDATE users
    SET password = p_new_password,
        must_change_password = TRUE
    WHERE staff_id = p_staff_id;

    SET p_status_code = 200;
    SET p_message = 'Password reset. The user must change it on next login.';
END //

-- ==========================================
-- 2. CREATE STAFF + LOGIN ACCOUNT
-- ==========================================
CREATE PROCEDURE sp_create_staff_account (
    IN p_first_name VARCHAR(100),
    IN p_middle_name VARCHAR(100),
    IN p_last_name VARCHAR(100),
    IN p_phone VARCHAR(20),
    IN p_role_id INT,
    IN p_email VARCHAR(100),
    IN p_password VARCHAR(255),
    OUT p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_role_count INT DEFAULT 0;
    DECLARE v_email_count INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_staff_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Unable to create the account. All changes rolled back.';
    END;

    SET p_staff_id = NULL;

    SELECT COUNT(*) INTO v_role_count FROM roles WHERE role_id = p_role_id;
    IF v_role_count = 0 THEN
        SET p_status_code = 400;
        SET p_message = 'The selected role does not exist.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_email_count FROM users WHERE email = p_email;
    IF v_email_count > 0 THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('The email ', p_email, ' already signs in to another account. ',
                               'Two people may share a name, but not an email address. ',
                               'Give this account its own email.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO staff (first_name, middle_name, last_name, phone, role_id, is_active)
    VALUES (p_first_name, NULLIF(TRIM(IFNULL(p_middle_name, '')), ''),
            p_last_name, p_phone, p_role_id, TRUE);

    SET p_staff_id = LAST_INSERT_ID();

    INSERT INTO users (staff_id, email, password, must_change_password)
    VALUES (p_staff_id, p_email, p_password, TRUE);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = 'Account created successfully.';
END //

-- ==========================================
-- 3. UPDATE STAFF + LOGIN ACCOUNT
-- ==========================================
CREATE PROCEDURE sp_update_staff_account (
    IN p_staff_id INT,
    IN p_first_name VARCHAR(100),
    IN p_middle_name VARCHAR(100),
    IN p_last_name VARCHAR(100),
    IN p_phone VARCHAR(20),
    IN p_role_id INT,
    IN p_email VARCHAR(100),
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_staff_count INT DEFAULT 0;
    DECLARE v_role_count INT DEFAULT 0;
    DECLARE v_email_count INT DEFAULT 0;
    DECLARE v_user_count INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to update the account. All changes rolled back.';
    END;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE staff_id = p_staff_id;
    IF v_staff_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Staff record not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_role_count FROM roles WHERE role_id = p_role_id;
    IF v_role_count = 0 THEN
        SET p_status_code = 400;
        SET p_message = 'The selected role does not exist.';
        LEAVE PROC_BODY;
    END IF;

    -- email must be unique across every other account
    SELECT COUNT(*) INTO v_email_count
    FROM users
    WHERE email = p_email AND staff_id <> p_staff_id;

    IF v_email_count > 0 THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('The email ', p_email, ' already signs in to another account. ',
                               'Give this account its own email.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    UPDATE staff
    SET first_name     = p_first_name,
        middle_name    = NULLIF(TRIM(IFNULL(p_middle_name, '')), ''),
        last_name      = p_last_name,
        phone          = p_phone,
        role_id        = p_role_id
    WHERE staff_id = p_staff_id;

    SELECT COUNT(*) INTO v_user_count FROM users WHERE staff_id = p_staff_id;

    IF v_user_count > 0 AND p_email IS NOT NULL AND p_email <> '' THEN
        UPDATE users SET email = p_email WHERE staff_id = p_staff_id;
    END IF;

    COMMIT;

    SET p_status_code = 200;
    SET p_message = 'Account updated successfully.';
END //

-- ==========================================
-- 4. ACTIVATE / DEACTIVATE STAFF
-- ==========================================
CREATE PROCEDURE sp_set_staff_status (
    IN p_staff_id INT,
    IN p_is_active BOOLEAN,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_staff_count INT DEFAULT 0;
    DECLARE v_admin_count INT DEFAULT 0;
    DECLARE v_role_id INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Unable to change the account status.';
    END;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE staff_id = p_staff_id;
    IF v_staff_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Staff record not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT role_id INTO v_role_id FROM staff WHERE staff_id = p_staff_id;

    -- block locking yourself out of the system
    IF p_is_active = FALSE AND v_role_id = 1 THEN
        SELECT COUNT(*) INTO v_admin_count
        FROM staff
        WHERE role_id = 1 AND is_active = TRUE AND staff_id <> p_staff_id;

        IF v_admin_count = 0 THEN
            SET p_status_code = 400;
            SET p_message = 'You cannot deactivate the last active system administrator.';
            LEAVE PROC_BODY;
        END IF;
    END IF;

    UPDATE staff SET is_active = p_is_active WHERE staff_id = p_staff_id;

    SET p_status_code = 200;
    SET p_message = 'Account status updated.';
END //
-- ==========================================
-- 5. CREATE A LOGIN FOR EXISTING STAFF
-- ==========================================
CREATE PROCEDURE sp_create_login_for_staff (
    IN p_staff_id INT,
    IN p_email VARCHAR(100),
    IN p_password VARCHAR(255),
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_staff_count INT DEFAULT 0;
    DECLARE v_user_count INT DEFAULT 0;
    DECLARE v_email_count INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Unable to create the login account.';
    END;

    IF p_password IS NULL OR CHAR_LENGTH(p_password) < 8 THEN
        SET p_status_code = 400;
        SET p_message = 'Password must contain at least 8 characters.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE staff_id = p_staff_id;
    IF v_staff_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Staff record not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_user_count FROM users WHERE staff_id = p_staff_id;
    IF v_user_count > 0 THEN
        SET p_status_code = 409;
        SET p_message = 'This staff member already has a login account.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_email_count FROM users WHERE email = p_email;
    IF v_email_count > 0 THEN
        SET p_status_code = 409;
        SET p_message = 'Email is already in use.';
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO users (staff_id, email, password, must_change_password)
    VALUES (p_staff_id, p_email, p_password, TRUE);

    SET p_status_code = 201;
    SET p_message = 'Login account created.';
END //
-- ==========================================
-- 5. SALES TRANSACTION (AUTOMATIC INVENTORY DEDUCTION)
-- ==========================================
CREATE PROCEDURE sp_raise_stock_alert (
    IN p_product_id INT,
    IN p_actor_staff_id INT
)
PROC_BODY: BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_stock DECIMAL(12,3) DEFAULT 0;
    DECLARE v_point INT DEFAULT 0;
    DECLARE v_type VARCHAR(20);
    DECLARE v_title VARCHAR(150);
    DECLARE v_message TEXT;
    DECLARE v_open INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN END;

    SELECT p.product_name, COALESCE(i.quantity_in_stock, 0), p.reorder_point
    INTO v_name, v_stock, v_point
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.product_id
    WHERE p.product_id = p_product_id AND p.is_archived = FALSE;

    -- stock is healthy again, so retire anything still warning about it
    IF v_name IS NOT NULL AND v_stock > v_point THEN
        UPDATE notifications
        SET is_read = TRUE
        WHERE product_id = p_product_id
          AND notif_type IN ('Low Stock', 'Out of Stock')
          AND is_read = FALSE;
    END IF;

    IF v_name IS NULL OR v_stock > v_point THEN
        LEAVE PROC_BODY;
    END IF;

    IF v_stock = 0 THEN
        SET v_type = 'Out of Stock';
        SET v_title = CONCAT(v_name, ' is out of stock');
        SET v_message = CONCAT('Stock has reached zero. Reorder point is ', v_point, '.');
    ELSE
        SET v_type = 'Low Stock';
        SET v_title = CONCAT(v_name, ' is low');
        SET v_message = CONCAT('Stock is ', v_stock, ', reorder point is ', v_point, '. Raise a purchase order.');
    END IF;

    -- a product that has gone from empty to merely low stops saying "out of stock"
    UPDATE notifications
    SET is_read = TRUE
    WHERE product_id = p_product_id
      AND notif_type IN ('Low Stock', 'Out of Stock')
      AND notif_type <> v_type
      AND is_read = FALSE;

    -- do not repeat an alert nobody has read yet
    SELECT COUNT(*) INTO v_open
    FROM notifications
    WHERE product_id = p_product_id AND notif_type = v_type AND is_read = FALSE;

    IF v_open > 0 THEN
        LEAVE PROC_BODY;
    END IF;

    -- the clerk who has to reorder it, and the manager who signs it off
    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (3, v_type, v_title, v_message, p_product_id, p_actor_staff_id);

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (2, v_type, v_title, v_message, p_product_id, p_actor_staff_id);
END //

-- ==========================================
CREATE PROCEDURE sp_create_sale_transaction (
    IN p_customer_id INT,
    -- the name of a buyer with no account; ignored when p_customer_id is given
    IN p_walk_in_name VARCHAR(150),
    IN p_cashier_staff_id INT,
    IN p_discount DECIMAL(10,2),
    IN p_amount_paid DECIMAL(12,2),
    IN p_payment_method VARCHAR(30),
    IN p_items_json JSON,
    -- how a down payment on a Credit sale was actually tendered
    IN p_down_payment_method VARCHAR(30),
    OUT p_sale_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_i INT DEFAULT 0;
    DECLARE v_item_count INT DEFAULT 0;
    DECLARE v_product_id INT;
    DECLARE v_quantity DECIMAL(12,3);
    DECLARE v_unit_price DECIMAL(10,2);
    DECLARE v_stock DECIMAL(12,3);
    -- what the whole basket asks of this material, not just the line in hand
    DECLARE v_needed DECIMAL(12,3);

    DECLARE v_discount DECIMAL(10,2) DEFAULT 0.00;
    DECLARE v_amount_paid DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_calculated_total DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_final_amount DECIMAL(12,2) DEFAULT 0.00;

    DECLARE v_credit_limit DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_current_credit DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_standing VARCHAR(10) DEFAULT 'Good';
    DECLARE v_on_credit BOOLEAN DEFAULT FALSE;
    DECLARE v_on_account BOOLEAN DEFAULT FALSE;
    DECLARE v_new_exposure DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_down_method VARCHAR(30) DEFAULT 'Cash';
    DECLARE v_payment_status VARCHAR(10) DEFAULT 'Paid';
    DECLARE v_walk_in_name VARCHAR(150) DEFAULT NULL;

    -- Posted prices include VAT, so it is extracted from the total; VAT is
    -- rounded first so the lines add back exactly. The registration and rate
    -- are copied onto the sale so a later change does not rewrite invoices.
    DECLARE v_registration VARCHAR(10) DEFAULT 'VAT';
    DECLARE v_vat_rate DECIMAL(5,2) DEFAULT 12.00;
    DECLARE v_vat_amount DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_vatable_sale DECIMAL(12,2) DEFAULT 0.00;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_sale_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Transaction failed. All changes rolled back.';
    END;

    SET p_sale_id = NULL;
    SET v_discount = IFNULL(p_discount, 0.00);
    SET v_amount_paid = IFNULL(p_amount_paid, 0.00);
    SET v_item_count = JSON_LENGTH(p_items_json);

    IF v_item_count IS NULL OR v_item_count = 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Sale cannot be processed without line items.';
        LEAVE PROC_BODY;
    END IF;

    IF p_payment_method IN ('Credit', 'COD') AND p_customer_id IS NULL THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('A ', p_payment_method, ' sale needs a named customer.');
        LEAVE PROC_BODY;
    END IF;

    -- Credit accepts a down payment and books the rest; COD takes nothing at
    -- the register.
    SET v_on_credit = (p_payment_method = 'Credit');
    SET v_on_account = (p_payment_method IN ('Credit', 'COD'));
    SET v_down_method = IFNULL(NULLIF(TRIM(IFNULL(p_down_payment_method, '')), ''), 'Cash');

    -- a sale belongs to an account or to a name, never both; blank collapses to NULL
    IF p_customer_id IS NULL THEN
        SET v_walk_in_name = NULLIF(TRIM(IFNULL(p_walk_in_name, '')), '');
    ELSE
        SET v_walk_in_name = NULL;
    END IF;

    START TRANSACTION;

    -- PASS 1: validate every line and build the total
    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');

        IF v_quantity IS NULL OR v_quantity <= 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('Quantity for Product ID ', IFNULL(v_product_id, 0), ' must be greater than zero.');
            LEAVE PROC_BODY;
        END IF;

        -- reset first, otherwise a missing row keeps the value from the last loop
        SET v_unit_price = NULL;
        SET v_stock = NULL;

        SELECT price INTO v_unit_price
        FROM products
        WHERE product_id = v_product_id AND status = 'Active';

        IF v_unit_price IS NULL THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = CONCAT('Product ID ', IFNULL(v_product_id, 0), ' is invalid or inactive.');
            LEAVE PROC_BODY;
        END IF;

        SELECT quantity_in_stock INTO v_stock
        FROM inventory
        WHERE product_id = v_product_id
        FOR UPDATE;

        -- The check adds up every line naming this material before comparing,
        -- so one material on two lines cannot be sold twice against the same shelf.
        SET v_needed = (
            SELECT SUM(line.quantity)
            FROM JSON_TABLE(p_items_json, '$[*]' COLUMNS (
                     product_id INT PATH '$.product_id',
                     quantity   INT PATH '$.quantity'
                 )) AS line
            WHERE line.product_id = v_product_id
        );

        IF v_stock IS NULL OR v_stock < v_needed THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('Insufficient stock for Product ID ', v_product_id,
                                   '. Asked for: ', IFNULL(v_needed, v_quantity),
                                   ', available: ', IFNULL(v_stock, 0));
            LEAVE PROC_BODY;
        END IF;

        SET v_calculated_total = v_calculated_total + (v_unit_price * v_quantity);
        SET v_i = v_i + 1;
    END WHILE;

    SET v_final_amount = v_calculated_total - v_discount;

    IF v_final_amount < 0 THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Discount is larger than the total.';
        LEAVE PROC_BODY;
    END IF;

    IF v_on_credit THEN
        -- a down payment cannot exceed the bill: there is no change on a sale going on the book
        IF v_amount_paid < 0 THEN
            SET v_amount_paid = 0.00;
        END IF;
        IF v_amount_paid > v_final_amount THEN
            SET v_amount_paid = v_final_amount;
        END IF;

        -- what actually goes on the account is the part that was not paid
        SET v_new_exposure = v_final_amount - v_amount_paid;

        SELECT credit_limit, current_credit, standing
        INTO v_credit_limit, v_current_credit, v_standing
        FROM vw_customer_credit
        WHERE customer_id = p_customer_id;

        -- checked before the limit: "on hold" is a more useful refusal than "300 over"
        IF v_standing = 'Hold' AND v_new_exposure > 0 THEN
            ROLLBACK;
            SET p_status_code = 403;
            SET p_message = CONCAT('This account is on hold and cannot take new credit. ',
                                   'Take the full ', FORMAT(v_final_amount, 2),
                                   ' now, or ask a manager to lift the hold.');
            LEAVE PROC_BODY;
        END IF;

        IF v_current_credit + v_new_exposure > v_credit_limit THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('Credit limit exceeded. Remaining credit: ',
                                   FORMAT(GREATEST(v_credit_limit - v_current_credit, 0), 2),
                                   '. Take a down payment of at least ',
                                   FORMAT(GREATEST(v_new_exposure - (v_credit_limit - v_current_credit), 0), 2),
                                   ', or raise an extension request.');
            LEAVE PROC_BODY;
        END IF;

        -- paid, part paid, or wholly on the book
        IF v_amount_paid >= v_final_amount THEN
            SET v_payment_status = 'Paid';
        ELSEIF v_amount_paid > 0 THEN
            SET v_payment_status = 'Partial';
        ELSE
            SET v_payment_status = 'Unpaid';
        END IF;

    ELSEIF v_on_account THEN
        -- COD: nothing is tendered at the register
        SET v_amount_paid = 0.00;
        SET v_payment_status = 'Unpaid';

    ELSEIF v_amount_paid < v_final_amount THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Amount paid is less than the total balance due.';
        LEAVE PROC_BODY;
    ELSE
        SET v_payment_status = 'Paid';
    END IF;

    -- no settings row means mid-install, so the defaults stand
    SELECT registration_type, vat_rate
    INTO v_registration, v_vat_rate
    FROM store_settings
    WHERE setting_id = 1;

    SET v_registration = IFNULL(v_registration, 'VAT');
    SET v_vat_rate = IFNULL(v_vat_rate, 12.00);

    IF v_registration = 'VAT' AND v_vat_rate > 0 THEN
        SET v_vat_amount = ROUND(v_final_amount * v_vat_rate / (100 + v_vat_rate), 2);
        SET v_vatable_sale = v_final_amount - v_vat_amount;
    ELSE
        -- a non-VAT shop charges no VAT at all
        SET v_vat_rate = 0.00;
        SET v_vat_amount = 0.00;
        SET v_vatable_sale = 0.00;
    END IF;

    -- final_amount and change_given are generated columns, so they are not inserted
    INSERT INTO sales (
        customer_id, walk_in_name, cashier_staff_id, total_amount, discount, amount_paid,
        payment_method, payment_status,
        tax_registration, vat_rate, vatable_sale, vat_amount
    ) VALUES (
        p_customer_id, v_walk_in_name, p_cashier_staff_id, v_calculated_total, v_discount, v_amount_paid,
        p_payment_method, v_payment_status,
        v_registration, v_vat_rate, v_vatable_sale, v_vat_amount
    );

    SET p_sale_id = LAST_INSERT_ID();

    -- PASS 2: write the lines and deduct stock
    SET v_i = 0;
    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');

        SET v_unit_price = NULL;
        SELECT price INTO v_unit_price FROM products WHERE product_id = v_product_id;

        -- subtotal is a generated column, so it is not inserted
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price)
        VALUES (p_sale_id, v_product_id, v_quantity, v_unit_price);

        UPDATE inventory
        SET quantity_in_stock = quantity_in_stock - v_quantity
        WHERE product_id = v_product_id;

        SET v_i = v_i + 1;
    END WHILE;

    -- a down payment is a payment and belongs in the payment history
    IF v_on_credit AND v_amount_paid > 0 THEN
        INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method,
                                     reference_no, received_by_staff_id)
        VALUES (p_customer_id, p_sale_id, v_amount_paid, v_down_method,
                'Down payment at counter', p_cashier_staff_id);
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_cashier_staff_id, 'SALE', 'CREATE',
            CONCAT('Sale #', p_sale_id, ' for ', FORMAT(v_final_amount, 2),
                   IF(v_on_credit AND v_amount_paid > 0,
                      CONCAT(', ', FORMAT(v_amount_paid, 2), ' down, ',
                             FORMAT(v_final_amount - v_amount_paid, 2), ' on account'),
                      '')));

    COMMIT;

    -- selling is the commonest way stock falls, so warn on every line sold
    SET v_i = 0;
    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        CALL sp_raise_stock_alert(v_product_id, p_cashier_staff_id);
        SET v_i = v_i + 1;
    END WHILE;

    SET p_status_code = 200;
    SET p_message = 'Sale transaction completed successfully.';
END //

-- ==========================================
-- 7. ARCHIVE A RECORD (manager module)
-- ==========================================
CREATE PROCEDURE sp_archive_record (
    IN p_module VARCHAR(20),
    IN p_record_id INT,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_found INT DEFAULT 0;
    DECLARE v_admin_count INT DEFAULT 0;
    DECLARE v_role_id INT DEFAULT 0;
    DECLARE v_stock DECIMAL(12,3) DEFAULT 0;
    DECLARE v_sale_day DATE;
    DECLARE v_delivery_status VARCHAR(20);
    DECLARE v_payment_status VARCHAR(10);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to archive the record.';
    END;

    IF p_module = 'Staff' THEN
        SELECT COUNT(*) INTO v_found FROM staff WHERE staff_id = p_record_id AND is_active = TRUE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active staff record not found.';
            LEAVE PROC_BODY;
        END IF;

        SELECT role_id INTO v_role_id FROM staff WHERE staff_id = p_record_id;

        IF v_role_id = 1 THEN
            SELECT COUNT(*) INTO v_admin_count
            FROM staff
            WHERE role_id = 1 AND is_active = TRUE AND staff_id <> p_record_id;

            IF v_admin_count = 0 THEN
                SET p_status_code = 400;
                SET p_message = 'You cannot archive the last active system administrator.';
                LEAVE PROC_BODY;
            END IF;
        END IF;

        UPDATE staff
        SET is_active = FALSE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE staff_id = p_record_id;

    ELSEIF p_module = 'Inventory' THEN
        SELECT COUNT(*) INTO v_found FROM products WHERE product_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active product record not found.';
            LEAVE PROC_BODY;
        END IF;

        -- a material with stock on hand is still on a shelf; sell or write it off first
        SELECT COALESCE(quantity_in_stock, 0) INTO v_stock
        FROM inventory WHERE product_id = p_record_id;
        IF v_stock > 0 THEN
            SET p_status_code = 409;
            SET p_message = CONCAT('This material still has ', v_stock, ' on hand. ',
                                   'Sell it off or write it off before archiving it.');
            LEAVE PROC_BODY;
        END IF;

        -- and one that is on its way from a supplier is not discontinued
        SELECT COUNT(*) INTO v_found
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.po_id = poi.po_id
        WHERE poi.product_id = p_record_id AND po.status = 'Pending';
        IF v_found > 0 THEN
            SET p_status_code = 409;
            SET p_message = 'This material is on a purchase order that has not arrived. Receive or cancel the order first.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE products
        SET is_archived = TRUE, status = 'Inactive', archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE product_id = p_record_id;

    ELSEIF p_module = 'Sales' THEN
        -- Archiving a sale is voiding it: same day only, goods not out for
        -- delivery, and the stock goes back on the shelf with a movement in the log.
        SELECT COUNT(*) INTO v_found FROM sales WHERE sale_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active sale record not found.';
            LEAVE PROC_BODY;
        END IF;

        SELECT DATE(sale_date) INTO v_sale_day FROM sales WHERE sale_id = p_record_id;
        IF v_sale_day <> CURDATE() THEN
            SET p_status_code = 409;
            SET p_message = 'A sale can only be voided on the day it was made. Correct an older one with a return or a refund.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found FROM deliveries
        WHERE sale_id = p_record_id AND is_archived = FALSE
          AND status IN ('Out for Delivery', 'Delivered');
        IF v_found > 0 THEN
            SET p_status_code = 409;
            SET p_message = 'The goods on this sale are out for delivery or delivered. It cannot be voided from here.';
            LEAVE PROC_BODY;
        END IF;

        START TRANSACTION;

        -- every line goes back on the shelf, and the log says why
        INSERT INTO stock_adjustments
            (product_id, adjustment_type, quantity_before, quantity_change, quantity_after,
             unit_name, reason, adjusted_by_staff_id)
        SELECT si.product_id, 'Add', i.quantity_in_stock, si.quantity,
               i.quantity_in_stock + si.quantity, u.unit_name,
               CONCAT('Sale #', p_record_id, ' voided; stock returned'), p_staff_id
        FROM sale_items si
        JOIN inventory i ON i.product_id = si.product_id
        LEFT JOIN products pr ON pr.product_id = si.product_id
        LEFT JOIN units u ON u.unit_id = pr.unit_id
        WHERE si.sale_id = p_record_id;

        UPDATE inventory i
        JOIN sale_items si ON si.product_id = i.product_id AND si.sale_id = p_record_id
        SET i.quantity_in_stock = i.quantity_in_stock + si.quantity;

        -- a delivery booked for it and not yet on the road is cancelled with it
        UPDATE deliveries
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE sale_id = p_record_id AND is_archived = FALSE;

        UPDATE sales
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE sale_id = p_record_id;

        COMMIT;

    ELSEIF p_module = 'Delivery' THEN
        -- a delivery is archived once closed (Delivered and paid, or Failed); the
        -- sweep does it after ninety days, a manager may do it sooner
        SELECT COUNT(*) INTO v_found FROM deliveries WHERE delivery_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active delivery record not found.';
            LEAVE PROC_BODY;
        END IF;

        SELECT d.status, s.payment_status INTO v_delivery_status, v_payment_status
        FROM deliveries d JOIN sales s ON s.sale_id = d.sale_id
        WHERE d.delivery_id = p_record_id;

        IF v_delivery_status NOT IN ('Delivered', 'Failed') THEN
            SET p_status_code = 409;
            SET p_message = CONCAT('This delivery is ', v_delivery_status, '. Only a Delivered or Failed delivery can be archived.');
            LEAVE PROC_BODY;
        END IF;
        IF v_delivery_status = 'Delivered' AND v_payment_status <> 'Paid' THEN
            SET p_status_code = 409;
            SET p_message = 'The goods arrived but money is still owed on the sale. Record the payment first.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE deliveries
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE delivery_id = p_record_id;

    ELSE
        SET p_status_code = 400;
        SET p_message = 'Unknown module. Use Staff, Inventory, Sales, or Delivery.';
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'ARCHIVE', 'DELETE', CONCAT(p_module, ' record #', p_record_id));

    SET p_status_code = 200;
    SET p_message = 'Record archived.';
END //

-- ==========================================
-- 8. RESTORE AN ARCHIVED RECORD
-- ==========================================
CREATE PROCEDURE sp_restore_archive (
    IN p_module VARCHAR(20),
    IN p_record_id INT,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_found INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to restore the record.';
    END;

    IF p_module = 'Staff' THEN
        SELECT COUNT(*) INTO v_found FROM staff WHERE staff_id = p_record_id AND is_active = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Archived staff record not found.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE staff
        SET is_active = TRUE, archived_at = NULL, archived_by_staff_id = NULL
        WHERE staff_id = p_record_id;

    ELSEIF p_module = 'Inventory' THEN
        SELECT COUNT(*) INTO v_found FROM products WHERE product_id = p_record_id AND is_archived = TRUE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Archived product record not found.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE products
        SET is_archived = FALSE, status = 'Active', archived_at = NULL, archived_by_staff_id = NULL
        WHERE product_id = p_record_id;

    ELSEIF p_module = 'Sales' THEN
        SELECT COUNT(*) INTO v_found FROM sales WHERE sale_id = p_record_id AND is_archived = TRUE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Archived sale record not found.';
            LEAVE PROC_BODY;
        END IF;

        -- un-voiding takes the goods off the shelf again, and cannot if they were since sold
        SELECT COUNT(*) INTO v_found
        FROM sale_items si JOIN inventory i ON i.product_id = si.product_id
        WHERE si.sale_id = p_record_id AND i.quantity_in_stock < si.quantity;
        IF v_found > 0 THEN
            SET p_status_code = 409;
            SET p_message = 'The stock on this sale has been sold since it was voided. It cannot be restored.';
            LEAVE PROC_BODY;
        END IF;

        START TRANSACTION;

        INSERT INTO stock_adjustments
            (product_id, adjustment_type, quantity_before, quantity_change, quantity_after,
             unit_name, reason, adjusted_by_staff_id)
        SELECT si.product_id, 'Remove', i.quantity_in_stock, -si.quantity,
               i.quantity_in_stock - si.quantity, u.unit_name,
               CONCAT('Sale #', p_record_id, ' restored; stock taken back off the shelf'), p_staff_id
        FROM sale_items si
        JOIN inventory i ON i.product_id = si.product_id
        LEFT JOIN products pr ON pr.product_id = si.product_id
        LEFT JOIN units u ON u.unit_id = pr.unit_id
        WHERE si.sale_id = p_record_id;

        UPDATE inventory i
        JOIN sale_items si ON si.product_id = i.product_id AND si.sale_id = p_record_id
        SET i.quantity_in_stock = i.quantity_in_stock - si.quantity;

        UPDATE sales
        SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL
        WHERE sale_id = p_record_id;

        COMMIT;

    ELSEIF p_module = 'Delivery' THEN
        SELECT COUNT(*) INTO v_found FROM deliveries WHERE delivery_id = p_record_id AND is_archived = TRUE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Archived delivery record not found.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE deliveries
        SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL
        WHERE delivery_id = p_record_id;

    ELSE
        SET p_status_code = 400;
        SET p_message = 'Unknown module. Use Staff, Inventory, Sales, or Delivery.';
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'RESTORE', 'RESTORE', CONCAT(p_module, ' record #', p_record_id));

    SET p_status_code = 200;
    SET p_message = 'Record restored.';
END //

-- ==========================================
-- 9. RECORD A CREDIT / COD PAYMENT
-- ==========================================
CREATE PROCEDURE sp_record_credit_payment (
    IN p_sale_id INT,
    IN p_amount DECIMAL(12,2),
    IN p_payment_method VARCHAR(30),
    IN p_reference_no VARCHAR(60),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_customer_id INT;
    DECLARE v_final DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_paid DECIMAL(12,2) DEFAULT 0.00;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to record the payment. All changes rolled back.';
    END;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Payment amount must be greater than zero.';
        LEAVE PROC_BODY;
    END IF;

    -- The sale row is read FOR UPDATE inside the transaction, so two payments
    -- on the same order at the same moment cannot both pass the balance check.
    START TRANSACTION;

    SET v_customer_id = NULL;
    SELECT customer_id, final_amount INTO v_customer_id, v_final
    FROM sales WHERE sale_id = p_sale_id
    FOR UPDATE;

    IF v_customer_id IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Sale not found, or it has no customer to bill.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM credit_payments WHERE sale_id = p_sale_id;

    IF v_paid + p_amount > v_final THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = CONCAT('Payment is larger than the balance due of ', FORMAT(v_final - v_paid, 2));
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method, reference_no, received_by_staff_id)
    VALUES (v_customer_id, p_sale_id, p_amount, p_payment_method, p_reference_no, p_staff_id);

    UPDATE sales
    SET amount_paid = v_paid + p_amount,
        payment_status = CASE WHEN v_paid + p_amount >= v_final THEN 'Paid' ELSE 'Partial' END
    WHERE sale_id = p_sale_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PAYMENT', 'PAYMENT', CONCAT('Sale #', p_sale_id, ' paid ', FORMAT(p_amount, 2), ' by ', p_payment_method));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = 'Payment recorded.';
END //

-- ==========================================
-- 10. RAISE A LOW STOCK ALERT
-- called by the stock procedures below, warns the clerk and the manager

-- ==========================================
-- 11. STOCK ADJUSTMENT
-- ==========================================
CREATE PROCEDURE sp_adjust_stock (
    IN p_product_id INT,
    IN p_adjustment_type VARCHAR(10),
    IN p_quantity DECIMAL(12,3),
    -- What the figure is counted in. A unit that does not exist yet is created;
    -- NULL or empty keeps the material's current unit.
    IN p_unit_name VARCHAR(20),
    IN p_reason VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_before DECIMAL(12,3);
    DECLARE v_change DECIMAL(12,3) DEFAULT 0;
    DECLARE v_after DECIMAL(12,3) DEFAULT 0;
    DECLARE v_unit VARCHAR(20) DEFAULT NULL;
    DECLARE v_unit_id INT DEFAULT NULL;
    DECLARE v_current_unit VARCHAR(20) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Stock adjustment failed. All changes rolled back.';
    END;

    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A reason is required for every stock adjustment.';
        LEAVE PROC_BODY;
    END IF;

    IF p_quantity IS NULL OR p_quantity < 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Quantity cannot be negative.';
        LEAVE PROC_BODY;
    END IF;

    SET v_before = NULL;
    SELECT quantity_in_stock INTO v_before
    FROM inventory WHERE product_id = p_product_id FOR UPDATE;

    IF v_before IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'No inventory record for that product.';
        LEAVE PROC_BODY;
    END IF;

    IF p_adjustment_type = 'Add' THEN
        SET v_change = p_quantity;
    ELSEIF p_adjustment_type = 'Remove' THEN
        SET v_change = -p_quantity;
    ELSEIF p_adjustment_type = 'Recount' THEN
        SET v_change = p_quantity - v_before;
    ELSE
        SET p_status_code = 400;
        SET p_message = 'Type must be Add, Remove, or Recount.';
        LEAVE PROC_BODY;
    END IF;

    SET v_after = v_before + v_change;

    IF v_after < 0 THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('That would leave stock at ', v_after, '. Only ', v_before, ' on hand.');
        LEAVE PROC_BODY;
    END IF;

    -- what the material is counted in today, before anything is changed
    SELECT u.unit_name INTO v_current_unit
    FROM products p
    LEFT JOIN units u ON u.unit_id = p.unit_id
    WHERE p.product_id = p_product_id;

    SET v_unit = NULLIF(TRIM(IFNULL(p_unit_name, '')), '');

    IF v_unit IS NULL THEN
        SET v_unit = v_current_unit;
    END IF;

    START TRANSACTION;

    -- a unit typed for the first time joins the list; matched case-insensitively
    IF v_unit IS NOT NULL THEN
        SELECT unit_id INTO v_unit_id
        FROM units WHERE LOWER(unit_name) = LOWER(v_unit) LIMIT 1;

        IF v_unit_id IS NULL THEN
            INSERT INTO units (unit_name) VALUES (v_unit);
            SET v_unit_id = LAST_INSERT_ID();
        ELSE
            -- keep the spelling the list already agreed on
            SELECT unit_name INTO v_unit FROM units WHERE unit_id = v_unit_id;
        END IF;

        UPDATE products SET unit_id = v_unit_id WHERE product_id = p_product_id;
    END IF;

    UPDATE inventory SET quantity_in_stock = v_after WHERE product_id = p_product_id;

    INSERT INTO stock_adjustments
        (product_id, adjustment_type, quantity_before, quantity_change, quantity_after,
         unit_name, reason, adjusted_by_staff_id)
    VALUES
        (p_product_id, p_adjustment_type, v_before, v_change, v_after,
         v_unit, p_reason, p_staff_id);

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'STOCK_ADJUST', 'UPDATE',
            CONCAT('Product #', p_product_id, ' ', v_before, ' -> ', v_after, ' (', p_reason, ')'));

    COMMIT;

    CALL sp_raise_stock_alert(p_product_id, p_staff_id);

    SET p_status_code = 200;
    SET p_message = CONCAT('Stock updated from ', v_before, ' to ', v_after,
                           IFNULL(CONCAT(' ', v_unit), ''), '.',
                           IF(v_current_unit IS NOT NULL AND v_unit IS NOT NULL
                              AND LOWER(v_current_unit) <> LOWER(v_unit),
                              CONCAT(' This material is now counted in ', v_unit,
                                     ' rather than ', v_current_unit, '.'), ''));
END //

-- ==========================================
-- 12. REORDER POINT SETTINGS
-- ==========================================
CREATE PROCEDURE sp_set_reorder_point (
    IN p_product_id INT,
    IN p_reorder_point INT,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_found INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Unable to save the reorder point.';
    END;

    IF p_reorder_point IS NULL OR p_reorder_point < 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Reorder point cannot be negative.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_found
    FROM products WHERE product_id = p_product_id AND is_archived = FALSE;

    IF v_found = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Active product not found.';
        LEAVE PROC_BODY;
    END IF;

    UPDATE products SET reorder_point = p_reorder_point WHERE product_id = p_product_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'REORDER_POINT', 'UPDATE', CONCAT('Product #', p_product_id, ' set to ', p_reorder_point));

    CALL sp_raise_stock_alert(p_product_id, p_staff_id);

    SET p_status_code = 200;
    SET p_message = 'Reorder point saved.';
END //

-- ==========================================
-- 13. A SUPPLIER, FOUND OR MADE
--
-- The name is the input, not the id: a name on file is matched (trimmed,
-- case-insensitive) and reused, anything else joins the list. No transaction
-- control here: sp_create_purchase_order owns the transaction.
-- ==========================================
CREATE PROCEDURE sp_ensure_supplier (
    IN p_supplier_name VARCHAR(100),
    IN p_contact_person VARCHAR(100),
    IN p_contact_number VARCHAR(20),
    IN p_email VARCHAR(100),
    IN p_address TEXT,
    INOUT p_supplier_id INT,
    OUT p_was_created BOOLEAN
)
BEGIN
    DECLARE v_name VARCHAR(100);

    SET p_was_created = FALSE;
    SET v_name = TRIM(IFNULL(p_supplier_name, ''));

    -- an id that is already good is the end of it
    IF p_supplier_id IS NOT NULL AND p_supplier_id > 0 THEN
        IF EXISTS (SELECT 1 FROM suppliers WHERE supplier_id = p_supplier_id) THEN
            -- details typed alongside a known company fill in blanks, never overwrite
            UPDATE suppliers
            SET contact_person = COALESCE(NULLIF(contact_person, ''), NULLIF(TRIM(IFNULL(p_contact_person, '')), '')),
                contact_number = COALESCE(NULLIF(contact_number, ''), NULLIF(TRIM(IFNULL(p_contact_number, '')), '')),
                email          = COALESCE(NULLIF(email, ''),          NULLIF(TRIM(IFNULL(p_email, '')), '')),
                address        = COALESCE(NULLIF(address, ''),        NULLIF(TRIM(IFNULL(p_address, '')), ''))
            WHERE supplier_id = p_supplier_id;
            SET p_supplier_id = p_supplier_id;
        ELSE
            SET p_supplier_id = NULL;
        END IF;
    ELSE
        SET p_supplier_id = NULL;
    END IF;

    IF p_supplier_id IS NULL AND v_name <> '' THEN
        SELECT supplier_id INTO p_supplier_id
        FROM suppliers
        WHERE LOWER(supplier_name) = LOWER(v_name)
        ORDER BY supplier_id
        LIMIT 1;
    END IF;

    IF p_supplier_id IS NULL AND v_name <> '' THEN
        INSERT INTO suppliers (supplier_name, contact_person, contact_number, email, address)
        VALUES (v_name,
                NULLIF(TRIM(IFNULL(p_contact_person, '')), ''),
                NULLIF(TRIM(IFNULL(p_contact_number, '')), ''),
                NULLIF(TRIM(IFNULL(p_email, '')), ''),
                NULLIF(TRIM(IFNULL(p_address, '')), ''));

        SET p_supplier_id = LAST_INSERT_ID();
        SET p_was_created = TRUE;
    END IF;
END //

-- ==========================================
-- 14. A MATERIAL, FOUND OR MADE
--
-- A name matching a material on the books returns it (archived ones
-- included, so a returning material keeps its history); a new name creates
-- it with its unit, category and brand, and an inventory row at zero. No
-- transaction control here: the caller owns it.
-- ==========================================
CREATE PROCEDURE sp_ensure_material (
    IN p_product_name VARCHAR(150),
    IN p_brand_name VARCHAR(100),
    IN p_category_name VARCHAR(50),
    IN p_unit_name VARCHAR(20),
    IN p_price DECIMAL(10,2),
    IN p_supplier_id INT,
    INOUT p_product_id INT,
    OUT p_was_created BOOLEAN
)
BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_brand VARCHAR(100);
    DECLARE v_category VARCHAR(50);
    DECLARE v_unit VARCHAR(20);
    DECLARE v_brand_id INT DEFAULT NULL;
    DECLARE v_category_id INT DEFAULT NULL;
    DECLARE v_unit_id INT DEFAULT NULL;

    SET p_was_created = FALSE;
    SET v_name     = TRIM(IFNULL(p_product_name, ''));
    SET v_brand    = TRIM(IFNULL(p_brand_name, ''));
    SET v_category = TRIM(IFNULL(p_category_name, ''));
    SET v_unit     = TRIM(IFNULL(p_unit_name, ''));

    IF p_product_id IS NOT NULL AND p_product_id > 0 THEN
        IF NOT EXISTS (SELECT 1 FROM products WHERE product_id = p_product_id) THEN
            SET p_product_id = NULL;
        END IF;
    ELSE
        SET p_product_id = NULL;
    END IF;

    IF p_product_id IS NULL AND v_name <> '' THEN
        SELECT product_id INTO p_product_id
        FROM products
        WHERE LOWER(product_name) = LOWER(v_name)
        ORDER BY product_id
        LIMIT 1;
    END IF;

    IF p_product_id IS NULL AND v_name <> '' THEN
        -- the words the clerk typed join the shop's lists rather than being refused
        IF v_brand <> '' THEN
            SELECT brand_id INTO v_brand_id FROM brands WHERE LOWER(brand_name) = LOWER(v_brand) LIMIT 1;
            IF v_brand_id IS NULL THEN
                INSERT INTO brands (brand_name) VALUES (v_brand);
                SET v_brand_id = LAST_INSERT_ID();
            END IF;
        END IF;

        IF v_category <> '' THEN
            SELECT category_id INTO v_category_id FROM categories WHERE LOWER(category_name) = LOWER(v_category) LIMIT 1;
            IF v_category_id IS NULL THEN
                INSERT INTO categories (category_name) VALUES (v_category);
                SET v_category_id = LAST_INSERT_ID();
            END IF;
        END IF;

        IF v_unit <> '' THEN
            SELECT unit_id INTO v_unit_id FROM units WHERE LOWER(unit_name) = LOWER(v_unit) LIMIT 1;
            IF v_unit_id IS NULL THEN
                INSERT INTO units (unit_name) VALUES (v_unit);
                SET v_unit_id = LAST_INSERT_ID();
            END IF;
        END IF;

        INSERT INTO products
            (product_name, brand_id, category_id, unit_id, price, reorder_point,
             lead_time_days, safety_stock, reorder_mode, status, supplier_id)
        VALUES
            (v_name, v_brand_id, v_category_id, v_unit_id,
             GREATEST(IFNULL(p_price, 0.00), 0.00), 10, 7, 0, 'Manual', 'Active',
             IF(p_supplier_id > 0, p_supplier_id, NULL));

        SET p_product_id = LAST_INSERT_ID();

        INSERT INTO inventory (product_id, quantity_in_stock) VALUES (p_product_id, 0);

        SET p_was_created = TRUE;
    END IF;
END //

-- ==========================================
-- 15. ADD A MATERIAL ON ITS OWN -- same rules as 14, its own transaction,
-- and says whether it made a new one or found the existing one
-- ==========================================
CREATE PROCEDURE sp_create_material (
    IN p_product_name VARCHAR(150),
    IN p_brand_name VARCHAR(100),
    IN p_category_name VARCHAR(50),
    IN p_unit_name VARCHAR(20),
    IN p_price DECIMAL(10,2),
    IN p_supplier_id INT,
    IN p_staff_id INT,
    OUT p_product_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_created BOOLEAN DEFAULT FALSE;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_product_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Unable to add the material. All changes rolled back.';
    END;

    SET p_product_id = NULL;

    IF TRIM(IFNULL(p_product_name, '')) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A material needs a name.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    CALL sp_ensure_material(p_product_name, p_brand_name, p_category_name,
                            p_unit_name, p_price, p_supplier_id,
                            p_product_id, v_created);

    IF v_created THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'MATERIAL', 'CREATE',
                CONCAT('Material #', p_product_id, ' "', TRIM(p_product_name), '" added from the shop floor'));
    END IF;

    COMMIT;

    SET p_status_code = IF(v_created, 201, 200);
    SET p_message = IF(v_created,
        CONCAT(TRIM(p_product_name), ' added to the material list.'),
        CONCAT(TRIM(p_product_name), ' is already on the material list, so that one was used.'));
END //

-- ==========================================
-- 16. CREATE A PURCHASE ORDER
--
-- The supplier arrives as a name and a line as a product id or a name with
-- the facts to open a record; anything new is created inside the order's
-- transaction. Every line needs a quantity and either an id or a name:
--
--   { "product_id": 12, "quantity": 40, "unit_cost": 25.00 }
--   { "new_name": "Roofing nail 3in", "unit_name": "kilogram",
--     "category_name": "Fasteners", "brand_name": "Vista",
--     "price": 180.00, "quantity": 20, "unit_cost": 120.00 }
--
-- Every JSON read is wrapped in NULLIF(..., 'null') because JSON_UNQUOTE
-- turns a JSON null into the string "null", which raises under strict mode.
-- ==========================================
CREATE PROCEDURE sp_create_purchase_order (
    IN p_supplier_id INT,
    IN p_supplier_name VARCHAR(100),
    IN p_contact_person VARCHAR(100),
    IN p_contact_number VARCHAR(20),
    IN p_supplier_email VARCHAR(100),
    IN p_supplier_address TEXT,
    IN p_items_json JSON,
    IN p_staff_id INT,
    OUT p_po_id INT,
    OUT p_supplier_id_out INT,
    OUT p_new_materials INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_i INT DEFAULT 0;
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_product_id INT;
    DECLARE v_quantity DECIMAL(12,3);
    DECLARE v_cost DECIMAL(10,2);
    DECLARE v_new_name VARCHAR(150);
    DECLARE v_brand VARCHAR(100);
    DECLARE v_category VARCHAR(50);
    DECLARE v_unit VARCHAR(20);
    DECLARE v_price DECIMAL(10,2);
    DECLARE v_supplier INT;
    DECLARE v_made BOOLEAN DEFAULT FALSE;
    DECLARE v_supplier_made BOOLEAN DEFAULT FALSE;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_po_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Purchase order failed. All changes rolled back.';
    END;

    SET p_po_id = NULL;
    SET p_new_materials = 0;
    SET p_supplier_id_out = NULL;
    SET v_count = JSON_LENGTH(p_items_json);

    IF v_count IS NULL OR v_count = 0 THEN
        SET p_status_code = 400;
        SET p_message = 'A purchase order needs at least one item.';
        LEAVE PROC_BODY;
    END IF;

    IF (p_supplier_id IS NULL OR p_supplier_id = 0)
       AND TRIM(IFNULL(p_supplier_name, '')) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A purchase order needs a supplier company name.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SET v_supplier = p_supplier_id;
    CALL sp_ensure_supplier(p_supplier_name, p_contact_person, p_contact_number,
                            p_supplier_email, p_supplier_address,
                            v_supplier, v_supplier_made);

    IF v_supplier IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That supplier could not be found or created.';
        LEAVE PROC_BODY;
    END IF;

    SET p_supplier_id_out = v_supplier;

    INSERT INTO purchase_orders (supplier_id, status) VALUES (v_supplier, 'Pending');
    SET p_po_id = LAST_INSERT_ID();

    WHILE v_i < v_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_cost       = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].unit_cost'))), 'null');
        SET v_new_name   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].new_name'))), 'null');
        SET v_brand      = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].brand_name'))), 'null');
        SET v_category   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].category_name'))), 'null');
        SET v_unit       = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].unit_name'))), 'null');
        SET v_price      = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].price'))), 'null');

        IF v_quantity IS NULL OR v_quantity <= 0 THEN
            ROLLBACK;
            SET p_po_id = NULL;
            SET p_status_code = 400;
            SET p_message = 'Every line needs a quantity greater than zero.';
            LEAVE PROC_BODY;
        END IF;

        SET v_made = FALSE;
        CALL sp_ensure_material(v_new_name, v_brand, v_category, v_unit,
                                IFNULL(v_price, IFNULL(v_cost, 0.00)), v_supplier,
                                v_product_id, v_made);

        IF v_product_id IS NULL THEN
            ROLLBACK;
            SET p_po_id = NULL;
            SET p_status_code = 400;
            SET p_message = 'Every line needs either a material from the list or a name for a new one.';
            LEAVE PROC_BODY;
        END IF;

        IF v_made THEN
            SET p_new_materials = p_new_materials + 1;
            INSERT INTO audit_logs (staff_id, action, action_type, details)
            VALUES (p_staff_id, 'MATERIAL', 'CREATE',
                    CONCAT('Material #', v_product_id, ' "', TRIM(v_new_name),
                           '" added while raising a purchase order'));
        END IF;

        INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost)
        VALUES (p_po_id, v_product_id, v_quantity, IFNULL(v_cost, 0.00));

        SET v_i = v_i + 1;
    END WHILE;

    IF v_supplier_made THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'SUPPLIER', 'CREATE',
                CONCAT('Supplier #', v_supplier, ' "', TRIM(p_supplier_name),
                       '" added while raising purchase order #', p_po_id));
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PURCHASE_ORDER', 'CREATE', CONCAT('PO #', p_po_id, ' raised with ', v_count, ' line(s)'));

    -- the clerk is told: a delivery is coming, and this is the order to count it against
    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (3, 'Purchase Order', CONCAT('Purchase order #', p_po_id, ' raised'),
            CONCAT(v_count, ' line(s) ordered, awaiting delivery. Check the goods against it when they arrive.'), p_staff_id);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Purchase order #', p_po_id, ' created',
        IF(p_new_materials > 0,
           CONCAT(', and ', p_new_materials, ' new material(s) added to the list.'), '.'));
END //

-- ==========================================
-- 17. RECEIVE A PURCHASE ORDER
--
-- p_received_json is the count sheet, what actually came off the lorry:
--   { "product_id": 12, "quantity": 38 }                      a short line
--   { "new_name": "Anchor bolt M12", "unit_name": "pcs",
--     "quantity": 24, "unit_cost": 30.00 }                    never ordered
-- A line missing from the sheet is received in full; a quantity of zero did
-- not arrive. The order's own lines are corrected to match what arrived.
-- ==========================================
CREATE PROCEDURE sp_receive_purchase_order (
    IN p_po_id INT,
    IN p_received_json JSON,
    IN p_staff_id INT,
    OUT p_lines INT,
    OUT p_extras INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_done INT DEFAULT 0;
    DECLARE v_product_id INT;
    DECLARE v_ordered INT;
    DECLARE v_arrived INT;
    DECLARE v_before DECIMAL(12,3);
    DECLARE v_i INT DEFAULT 0;
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_json_id INT;
    DECLARE v_json_qty INT;
    DECLARE v_new_name VARCHAR(150);
    DECLARE v_unit VARCHAR(20);
    DECLARE v_category VARCHAR(50);
    DECLARE v_brand VARCHAR(100);
    DECLARE v_cost DECIMAL(10,2);
    DECLARE v_supplier INT;
    DECLARE v_made BOOLEAN DEFAULT FALSE;
    DECLARE v_short INT DEFAULT 0;

    DECLARE cur CURSOR FOR
        SELECT product_id, quantity FROM purchase_order_items WHERE po_id = p_po_id;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Receiving failed. All changes rolled back.';
    END;

    SET p_lines = 0;
    SET p_extras = 0;
    SET v_status = NULL;

    SELECT status, supplier_id INTO v_status, v_supplier
    FROM purchase_orders WHERE po_id = p_po_id;

    IF v_status IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Purchase order not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status <> 'Pending' THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('This purchase order is already ', v_status, '.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    -- ---- 1. anything on the sheet that was never on the order ----
    -- done first, so an extra material becomes a line and is stocked by the same loop
    SET v_count = IFNULL(JSON_LENGTH(p_received_json), 0);

    WHILE v_i < v_count DO
        SET v_json_id  = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_json_qty = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_new_name = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].new_name'))), 'null');
        SET v_unit     = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].unit_name'))), 'null');
        SET v_category = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].category_name'))), 'null');
        SET v_brand    = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].brand_name'))), 'null');
        SET v_cost     = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_received_json, CONCAT('$[', v_i, '].unit_cost'))), 'null');

        IF IFNULL(v_json_qty, 0) < 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = 'A received quantity cannot be less than zero.';
            LEAVE PROC_BODY;
        END IF;

        SET v_made = FALSE;
        CALL sp_ensure_material(v_new_name, v_brand, v_category, v_unit,
                                IFNULL(v_cost, 0.00), v_supplier,
                                v_json_id, v_made);

        IF v_json_id IS NOT NULL THEN
            IF v_made THEN
                INSERT INTO audit_logs (staff_id, action, action_type, details)
                VALUES (p_staff_id, 'MATERIAL', 'CREATE',
                        CONCAT('Material #', v_json_id, ' "', TRIM(IFNULL(v_new_name, '')),
                               '" added while receiving purchase order #', p_po_id));
            END IF;

            -- an archived material on a lorry again belongs back on the working list
            UPDATE products
            SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL
            WHERE product_id = v_json_id AND is_archived = TRUE;

            INSERT IGNORE INTO inventory (product_id, quantity_in_stock)
            VALUES (v_json_id, 0);

            IF EXISTS (SELECT 1 FROM purchase_order_items
                       WHERE po_id = p_po_id AND product_id = v_json_id) THEN
                -- the order already has this line; the sheet corrects it
                UPDATE purchase_order_items
                SET quantity = IFNULL(v_json_qty, quantity)
                WHERE po_id = p_po_id AND product_id = v_json_id;
            ELSE
                INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost)
                VALUES (p_po_id, v_json_id, IFNULL(v_json_qty, 0), IFNULL(v_cost, 0.00));
                SET p_extras = p_extras + 1;
            END IF;
        END IF;

        SET v_i = v_i + 1;
    END WHILE;

    -- ---- 2. everything the order now says, onto the shelf ----
    OPEN cur;
    read_loop: LOOP
        FETCH cur INTO v_product_id, v_ordered;
        IF v_done = 1 THEN
            LEAVE read_loop;
        END IF;

        SET v_arrived = v_ordered;

        IF v_arrived > 0 THEN
            SET v_before = 0;
            SELECT quantity_in_stock INTO v_before FROM inventory WHERE product_id = v_product_id FOR UPDATE;

            UPDATE inventory
            SET quantity_in_stock = quantity_in_stock + v_arrived
            WHERE product_id = v_product_id;

            INSERT INTO stock_adjustments
                (product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, adjusted_by_staff_id)
            VALUES
                (v_product_id, 'Add', v_before, v_arrived, v_before + v_arrived,
                 CONCAT('Received on purchase order #', p_po_id), p_staff_id);

            -- goods arriving is exactly when a low stock warning should go away
            CALL sp_raise_stock_alert(v_product_id, p_staff_id);

            SET p_lines = p_lines + 1;
        ELSE
            SET v_short = v_short + 1;
        END IF;
    END LOOP;
    CLOSE cur;

    -- a line that did not arrive is not left on the order pretending it did
    DELETE FROM purchase_order_items WHERE po_id = p_po_id AND quantity <= 0;

    UPDATE purchase_orders SET status = 'Received' WHERE po_id = p_po_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PO_RECEIVED', 'UPDATE',
            CONCAT('PO #', p_po_id, ' received, ', p_lines, ' line(s) stocked',
                   IF(p_extras > 0, CONCAT(', ', p_extras, ' not on the order'), ''),
                   IF(v_short > 0, CONCAT(', ', v_short, ' line(s) did not arrive'), '')));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = CONCAT('Purchase order #', p_po_id, ' received. ',
        p_lines, ' line(s) added to stock',
        IF(p_extras > 0, CONCAT(', including ', p_extras, ' that was not on the order'), ''),
        IF(v_short > 0, CONCAT('. ', v_short, ' line(s) did not arrive'), ''), '.');
END //

-- ==========================================
-- 18. FILE A DAMAGE, REFUND, OR RETURN REPORT
-- ==========================================
CREATE PROCEDURE sp_file_return_report (
    IN p_product_id INT,
    IN p_sale_id INT,
    IN p_report_type VARCHAR(20),
    IN p_quantity DECIMAL(12,3),
    IN p_reason TEXT,
    IN p_refund_amount DECIMAL(12,2),
    -- where the goods go, in words; restocked is derived from it
    IN p_disposition VARCHAR(20),
    IN p_staff_id INT,
    OUT p_report_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_before DECIMAL(12,3);
    DECLARE v_change DECIMAL(12,3) DEFAULT 0;
    DECLARE v_notif VARCHAR(20);
    DECLARE v_restock BOOLEAN DEFAULT FALSE;
    DECLARE v_where VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_report_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Report failed. All changes rolled back.';
    END;

    SET p_report_id = NULL;

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

    -- the bar is a sentence rather than a word
    IF p_reason IS NULL OR CHAR_LENGTH(TRIM(p_reason)) < 10 THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('Say what happened, in a sentence. ',
                               'A write-off queried three months from now has to be ',
                               'explainable from this line alone.');
        LEAVE PROC_BODY;
    END IF;

    SET v_where = NULLIF(TRIM(IFNULL(p_disposition, '')), '');

    IF v_where IS NULL OR v_where NOT IN ('Return to Stock', 'Write-Off') THEN
        SET p_status_code = 400;
        SET p_message = 'Say where the goods go: Return to Stock, or Write-Off.';
        LEAVE PROC_BODY;
    END IF;

    -- one decision, one flag; restocked is no longer set separately
    SET v_restock = (v_where = 'Return to Stock');

    SET v_name = NULL;
    SELECT product_name INTO v_name FROM products WHERE product_id = p_product_id;

    IF v_name IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Product not found.';
        LEAVE PROC_BODY;
    END IF;

    SET v_before = 0;
    SELECT COALESCE(quantity_in_stock, 0) INTO v_before FROM inventory WHERE product_id = p_product_id;

    -- Return to Stock always adds. Write-Off subtracts only when the goods were
    -- still counted as stock (a customer's return was deducted when sold).
    IF v_restock THEN
        SET v_change = p_quantity;
    ELSEIF p_sale_id IS NULL THEN
        SET v_change = -LEAST(p_quantity, v_before);
    END IF;

    START TRANSACTION;

    INSERT INTO returned_items
        (product_id, sale_id, report_type, quantity, reason, disposition,
         refund_amount, restocked, status, reported_by_staff_id)
    VALUES
        (p_product_id, p_sale_id, p_report_type, p_quantity, TRIM(p_reason), v_where,
         IFNULL(p_refund_amount, 0.00), v_restock, 'Open', p_staff_id);

    SET p_report_id = LAST_INSERT_ID();

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
            CONCAT(p_quantity, ' unit(s), ', v_where, ': ', LEFT(TRIM(p_reason), 110)),
            p_product_id, p_staff_id);

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, UPPER(REPLACE(p_report_type, ' ', '_')), 'CREATE',
            CONCAT(v_name, ' x', p_quantity, ' (report #', p_report_id, ')'));

    COMMIT;

    IF v_change < 0 THEN
        CALL sp_raise_stock_alert(p_product_id, p_staff_id);
    END IF;

    SET p_status_code = 201;
    SET p_message = CONCAT(p_report_type, ' report filed.');
END //

-- ==========================================
-- 19. RESOLVE A REPORT
-- ==========================================
CREATE PROCEDURE sp_resolve_return_report (
    IN p_report_id INT,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Unable to resolve the report.';
    END;

    SET v_status = NULL;
    SELECT status INTO v_status FROM returned_items WHERE return_id = p_report_id;

    IF v_status IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Report not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status = 'Resolved' THEN
        SET p_status_code = 400;
        SET p_message = 'That report is already resolved.';
        LEAVE PROC_BODY;
    END IF;

    UPDATE returned_items SET status = 'Resolved' WHERE return_id = p_report_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'REPORT_RESOLVED', 'UPDATE', CONCAT('Report #', p_report_id));

    SET p_status_code = 200;
    SET p_message = 'Report marked resolved.';
END //

-- ==========================================
-- 20. BOOK A DELIVERY FOR A SALE
-- ==========================================
CREATE PROCEDURE sp_create_delivery (
    IN p_sale_id INT,
    IN p_address TEXT,
    -- a slot rather than a day
    IN p_scheduled_date DATETIME,
    IN p_remarks TEXT,
    -- who the driver is looking for, as written at the counter; falls back to the customer record
    IN p_contact_name VARCHAR(150),
    IN p_contact_phone VARCHAR(30),
    -- defaults to today when the caller does not say
    IN p_booked_date DATE,
    IN p_staff_id INT,
    OUT p_delivery_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_exists INT DEFAULT 0;
    DECLARE v_already INT DEFAULT 0;
    DECLARE v_contact_name VARCHAR(150) DEFAULT NULL;
    DECLARE v_contact_phone VARCHAR(30) DEFAULT NULL;
    DECLARE v_booked DATE DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_delivery_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Unable to book the delivery. All changes rolled back.';
    END;

    SET p_delivery_id = NULL;

    IF p_address IS NULL OR TRIM(p_address) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A delivery address is required.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_exists FROM sales WHERE sale_id = p_sale_id;

    IF v_exists = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'That sale does not exist.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_already FROM deliveries WHERE sale_id = p_sale_id AND is_archived = FALSE;

    IF v_already > 0 THEN
        SET p_status_code = 409;
        SET p_message = 'This sale already has a delivery booked.';
        LEAVE PROC_BODY;
    END IF;

    SET v_booked = IFNULL(p_booked_date, CURDATE());
    SET v_contact_name  = NULLIF(TRIM(IFNULL(p_contact_name, '')), '');
    SET v_contact_phone = NULLIF(TRIM(IFNULL(p_contact_phone, '')), '');

    -- nothing typed means the sale already knows: the account customer or the walk-in name
    IF v_contact_name IS NULL THEN
        SELECT COALESCE(NULLIF(TRIM(CONCAT(IFNULL(c.first_name, ''), ' ',
                                           IFNULL(c.last_name, ''))), ''),
                        NULLIF(TRIM(IFNULL(s.walk_in_name, '')), ''))
        INTO v_contact_name
        FROM sales s
        LEFT JOIN customers c ON c.customer_id = s.customer_id
        WHERE s.sale_id = p_sale_id;
    END IF;

    IF v_contact_phone IS NULL THEN
        SELECT NULLIF(TRIM(IFNULL(c.phone, '')), '')
        INTO v_contact_phone
        FROM sales s
        LEFT JOIN customers c ON c.customer_id = s.customer_id
        WHERE s.sale_id = p_sale_id;
    END IF;

    START TRANSACTION;

    INSERT INTO deliveries (sale_id, delivery_address, contact_name, contact_phone,
                            status, remarks, booked_date, scheduled_date)
    VALUES (p_sale_id, p_address, v_contact_name, v_contact_phone,
            'Pending', p_remarks, v_booked, p_scheduled_date);

    SET p_delivery_id = LAST_INSERT_ID();

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'DELIVERY_BOOKED', 'CREATE', CONCAT('Delivery #', p_delivery_id, ' for sale #', p_sale_id));

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (5, 'Delivery', CONCAT('Delivery #', p_delivery_id, ' booked'),
            CONCAT('Sale #', p_sale_id, ' needs delivering to ', LEFT(p_address, 90)), p_staff_id);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Delivery #', p_delivery_id, ' booked.');
END //

-- ==========================================
-- 21. UPDATE A DELIVERY STATUS
-- ==========================================
CREATE PROCEDURE sp_update_delivery_status (
    IN p_delivery_id INT,
    IN p_status VARCHAR(20),
    IN p_remarks TEXT,
    IN p_staff_id INT,
    IN p_role_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_current VARCHAR(20);
    DECLARE v_allowed INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET p_status_code = 500;
        SET p_message = 'Unable to update the delivery.';
    END;

    IF p_status NOT IN ('Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed', 'Failed') THEN
        SET p_status_code = 400;
        SET p_message = 'That is not a valid delivery status.';
        LEAVE PROC_BODY;
    END IF;

    SET v_current = NULL;
    SELECT status INTO v_current FROM deliveries WHERE delivery_id = p_delivery_id AND is_archived = FALSE;

    IF v_current IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Delivery not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_current = p_status THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('This delivery is already marked ', p_status, '.');
        LEAVE PROC_BODY;
    END IF;

    -- Roles: 1 Administrator, 2 Manager, 3 Inventory Clerk, 4 Cashier, 5 Delivery Personnel

    -- a delivered order is closed; a mistake means a new record with a reason
    IF v_current = 'Delivered' THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('Delivery #', p_delivery_id,
                               ' is already delivered and cannot be reopened.');
        LEAVE PROC_BODY;
    END IF;

    -- Only the person standing at the customer's door can say the goods arrived.
    IF p_status = 'Delivered' AND p_role_id <> 5 THEN
        SET p_status_code = 403;
        SET p_message = 'Only delivery personnel can mark an order Delivered.';
        LEAVE PROC_BODY;
    END IF;

    -- every other move belongs to the driver, with the manager able to step in
    IF p_role_id NOT IN (2, 5) THEN
        SET p_status_code = 403;
        SET p_message = 'Your role cannot change a delivery status.';
        LEAVE PROC_BODY;
    END IF;

    -- A run moves forward through its stages. It does not skip backwards.
    SET v_allowed =
        CASE v_current
            WHEN 'Pending'          THEN p_status IN ('In Transit', 'Out for Delivery', 'Delayed', 'Failed')
            WHEN 'In Transit'       THEN p_status IN ('Out for Delivery', 'Delayed', 'Failed')
            WHEN 'Out for Delivery' THEN p_status IN ('Delivered', 'Delayed', 'Failed')
            WHEN 'Delayed'          THEN p_status IN ('In Transit', 'Out for Delivery', 'Failed')
            WHEN 'Failed'           THEN p_status IN ('Pending', 'In Transit', 'Out for Delivery')
            ELSE 0
        END;

    IF v_allowed = 0 THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('A delivery cannot go from ', v_current, ' to ', p_status, '.');
        LEAVE PROC_BODY;
    END IF;

    UPDATE deliveries
    SET status = p_status,
        remarks = IFNULL(NULLIF(TRIM(IFNULL(p_remarks, '')), ''), remarks),
        delivered_at = IF(p_status = 'Delivered', NOW(), delivered_at)
    WHERE delivery_id = p_delivery_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'DELIVERY_STATUS', 'UPDATE',
            CONCAT('Delivery #', p_delivery_id, ' ', v_current, ' -> ', p_status));

    SET p_status_code = 200;
    SET p_message = CONCAT('Delivery #', p_delivery_id, ' marked ', p_status, '.');
END //

-- ==========================================
-- 22. SET A CREDIT LIMIT AND STANDING
--
-- Lowering a limit below what is already owed is allowed; the message says so.
-- ==========================================
CREATE PROCEDURE sp_set_credit_limit (
    IN p_customer_id INT,
    IN p_credit_limit DECIMAL(12,2),
    IN p_standing VARCHAR(10),
    IN p_notes VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_customer_count INT DEFAULT 0;
    DECLARE v_owed DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_name VARCHAR(220);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to save the credit limit. All changes rolled back.';
    END;

    IF p_credit_limit IS NULL OR p_credit_limit < 0 THEN
        SET p_status_code = 400;
        SET p_message = 'A credit limit cannot be negative. Use zero for a cash-only customer.';
        LEAVE PROC_BODY;
    END IF;

    IF p_standing NOT IN ('Good', 'Watch', 'Hold') THEN
        SET p_status_code = 400;
        SET p_message = 'Standing must be Good, Watch or Hold.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_customer_count FROM customers WHERE customer_id = p_customer_id;
    IF v_customer_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Customer not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT CONCAT(first_name, ' ', last_name) INTO v_name
    FROM customers WHERE customer_id = p_customer_id;

    SELECT current_credit INTO v_owed
    FROM vw_customer_credit WHERE customer_id = p_customer_id;

    START TRANSACTION;

    -- a customer may have no credit row yet
    INSERT INTO customer_credits (customer_id, credit_limit, standing, notes, updated_by_staff_id)
    VALUES (p_customer_id, p_credit_limit, p_standing,
            NULLIF(TRIM(IFNULL(p_notes, '')), ''), p_staff_id)
    ON DUPLICATE KEY UPDATE
        credit_limit = p_credit_limit,
        standing = p_standing,
        notes = NULLIF(TRIM(IFNULL(p_notes, '')), ''),
        updated_by_staff_id = p_staff_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'CREDIT_LIMIT', 'UPDATE',
            CONCAT(v_name, ': limit ', FORMAT(p_credit_limit, 2), ', standing ', p_standing));

    COMMIT;

    SET p_status_code = 200;

    IF p_credit_limit < v_owed THEN
        SET p_message = CONCAT('Saved. ', v_name, ' already owes ', FORMAT(v_owed, 2),
                               ', which is over the new limit, so no further credit can be taken ',
                               'until it is paid down.');
    ELSEIF p_standing = 'Hold' THEN
        SET p_message = CONCAT('Saved. ', v_name, ' is on hold and cannot take new credit.');
    ELSE
        SET p_message = CONCAT('Saved. ', v_name, ' may owe up to ', FORMAT(p_credit_limit, 2), '.');
    END IF;
END //

-- ==========================================
-- 23. ASK FOR A HIGHER LIMIT -- one pending request per customer at a time
-- ==========================================
CREATE PROCEDURE sp_request_credit_extension (
    IN p_customer_id INT,
    IN p_requested_limit DECIMAL(12,2),
    IN p_reason VARCHAR(255),
    IN p_staff_id INT,
    OUT p_request_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_current_limit DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_pending INT DEFAULT 0;
    DECLARE v_customer_count INT DEFAULT 0;
    DECLARE v_name VARCHAR(220);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_request_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Unable to raise the request.';
    END;

    SET p_request_id = NULL;

    SELECT COUNT(*) INTO v_customer_count FROM customers WHERE customer_id = p_customer_id;
    IF v_customer_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Customer not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT CONCAT(first_name, ' ', last_name) INTO v_name
    FROM customers WHERE customer_id = p_customer_id;

    SELECT COALESCE(credit_limit, 0.00) INTO v_current_limit
    FROM vw_customer_credit WHERE customer_id = p_customer_id;

    IF p_requested_limit IS NULL OR p_requested_limit <= v_current_limit THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('The requested limit has to be more than the current ',
                               FORMAT(v_current_limit, 2), '.');
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_pending
    FROM credit_requests
    WHERE customer_id = p_customer_id AND status = 'Pending';

    IF v_pending > 0 THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('A request for ', v_name, ' is already waiting for a manager. ',
                               'Adding another would not make it arrive sooner.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO credit_requests (customer_id, previous_limit, requested_limit,
                                 reason, requested_by_staff_id)
    VALUES (p_customer_id, v_current_limit, p_requested_limit,
            NULLIF(TRIM(IFNULL(p_reason, '')), ''), p_staff_id);

    SET p_request_id = LAST_INSERT_ID();

    -- the manager needs to know without being told in person
    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (2, 'Purchase Order',
            CONCAT('Credit extension asked for: ', v_name),
            CONCAT(FORMAT(v_current_limit, 2), ' to ', FORMAT(p_requested_limit, 2),
                   '. ', IFNULL(NULLIF(TRIM(IFNULL(p_reason, '')), ''), 'No reason given.')),
            p_staff_id);

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'CREDIT_REQUEST', 'CREATE',
            CONCAT(v_name, ': ', FORMAT(v_current_limit, 2), ' -> ', FORMAT(p_requested_limit, 2)));

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Request raised for ', v_name, '. A manager will decide it.');
END //

-- ==========================================
-- 24. DECIDE A CREDIT EXTENSION -- approving raises the limit in the same
-- transaction; declining records why
-- ==========================================
CREATE PROCEDURE sp_decide_credit_request (
    IN p_request_id INT,
    IN p_approve BOOLEAN,
    IN p_note VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_status VARCHAR(10);
    DECLARE v_customer_id INT;
    DECLARE v_requested DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_name VARCHAR(220);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to record the decision. All changes rolled back.';
    END;

    SET v_status = NULL;
    SELECT status, customer_id, requested_limit
    INTO v_status, v_customer_id, v_requested
    FROM credit_requests WHERE request_id = p_request_id;

    IF v_status IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'That request no longer exists.';
        LEAVE PROC_BODY;
    END IF;

    -- a decision already made stands
    IF v_status <> 'Pending' THEN
        SET p_status_code = 409;
        SET p_message = CONCAT('This request was already ', LOWER(v_status),
                               '. Raise a new one to change the limit again.');
        LEAVE PROC_BODY;
    END IF;

    SELECT CONCAT(first_name, ' ', last_name) INTO v_name
    FROM customers WHERE customer_id = v_customer_id;

    START TRANSACTION;

    UPDATE credit_requests
    SET status = IF(p_approve, 'Approved', 'Declined'),
        decided_by_staff_id = p_staff_id,
        decision_note = NULLIF(TRIM(IFNULL(p_note, '')), ''),
        decided_at = NOW()
    WHERE request_id = p_request_id;

    IF p_approve THEN
        INSERT INTO customer_credits (customer_id, credit_limit, updated_by_staff_id)
        VALUES (v_customer_id, v_requested, p_staff_id)
        ON DUPLICATE KEY UPDATE
            credit_limit = v_requested,
            updated_by_staff_id = p_staff_id;
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id,
            IF(p_approve, 'CREDIT_APPROVED', 'CREDIT_DECLINED'),
            'UPDATE',
            CONCAT(v_name, ': request #', p_request_id, ' ',
                   IF(p_approve, CONCAT('approved at ', FORMAT(v_requested, 2)), 'declined')));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = IF(p_approve,
        CONCAT(v_name, ' may now owe up to ', FORMAT(v_requested, 2), '.'),
        CONCAT('The request for ', v_name, ' was declined. Their limit is unchanged.'));
END //

-- ==========================================
-- 25. OPEN AN ACCOUNT FROM THE COUNTER
--
-- Creates the record with a zero limit and Good standing; only a manager
-- moves the limit. The same name and phone hands back the existing account
-- rather than refusing.
-- ==========================================
CREATE PROCEDURE sp_create_customer (
    IN p_first_name VARCHAR(100),
    IN p_last_name VARCHAR(100),
    IN p_phone VARCHAR(20),
    IN p_address TEXT,
    IN p_staff_id INT,
    OUT p_customer_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_first VARCHAR(100);
    DECLARE v_last VARCHAR(100);
    DECLARE v_phone VARCHAR(20);
    DECLARE v_address TEXT;
    DECLARE v_existing INT DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_customer_id = NULL;
        SET p_status_code = 500;
        SET p_message = 'Unable to create the customer. All changes rolled back.';
    END;

    SET p_customer_id = NULL;
    SET v_first   = NULLIF(TRIM(IFNULL(p_first_name, '')), '');
    SET v_last    = NULLIF(TRIM(IFNULL(p_last_name, '')), '');
    SET v_phone   = NULLIF(TRIM(IFNULL(p_phone, '')), '');
    SET v_address = NULLIF(TRIM(IFNULL(p_address, '')), '');

    IF v_first IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A customer needs at least a first name.';
        LEAVE PROC_BODY;
    END IF;

    -- one-word names are ordinary: the surname takes an empty string
    IF v_last IS NULL THEN
        SET v_last = '';
    END IF;

    SELECT customer_id INTO v_existing
    FROM customers
    WHERE LOWER(TRIM(first_name)) = LOWER(v_first)
      AND LOWER(TRIM(IFNULL(last_name, ''))) = LOWER(v_last)
      AND ((v_phone IS NULL AND (phone IS NULL OR TRIM(phone) = ''))
           OR TRIM(IFNULL(phone, '')) = v_phone)
    ORDER BY customer_id
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
        SET p_customer_id = v_existing;
        SET p_status_code = 200;

        -- the name as the book already spells it
        SELECT CONCAT(TRIM(CONCAT(first_name, ' ', IFNULL(last_name, ''))),
                      ' already has an account. This sale was attached to it.')
        INTO p_message
        FROM customers WHERE customer_id = v_existing;

        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO customers (first_name, last_name, phone, address)
    VALUES (v_first, v_last, v_phone, v_address);

    SET p_customer_id = LAST_INSERT_ID();

    -- zero limit, Good standing: a known customer who buys for cash
    INSERT INTO customer_credits (customer_id, credit_limit, standing, updated_by_staff_id)
    VALUES (p_customer_id, 0.00, 'Good', p_staff_id);

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'CUSTOMER_CREATED', 'CREATE',
            CONCAT('Customer #', p_customer_id, ' ', TRIM(CONCAT(v_first, ' ', v_last)),
                   ' opened at the counter with no credit limit'));

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT(TRIM(CONCAT(v_first, ' ', v_last)),
                           ' now has an account. A manager sets any credit limit.');
END //

-- ==========================================
-- 26. WHO THE SHOP IS, AND HOW IT IS REGISTERED
--
-- A procedure rather than a plain UPDATE so the audit entry records what it
-- moved from. Sales already rung up carry their own registration and rate.
-- ==========================================
CREATE PROCEDURE sp_update_store_settings (
    IN p_store_name VARCHAR(150),
    IN p_address VARCHAR(255),
    IN p_tin VARCHAR(30),
    IN p_registration_type VARCHAR(10),
    IN p_vat_rate DECIMAL(5,2),
    IN p_invoice_note VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_address VARCHAR(255);
    DECLARE v_tin VARCHAR(30);
    DECLARE v_type VARCHAR(10);
    DECLARE v_rate DECIMAL(5,2);
    DECLARE v_old_type VARCHAR(10) DEFAULT NULL;
    DECLARE v_old_rate DECIMAL(5,2) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to save the store settings. All changes rolled back.';
    END;

    SET v_name = NULLIF(TRIM(IFNULL(p_store_name, '')), '');
    SET v_address = NULLIF(TRIM(IFNULL(p_address, '')), '');
    SET v_tin = NULLIF(TRIM(IFNULL(p_tin, '')), '');
    SET v_type = UPPER(TRIM(IFNULL(p_registration_type, '')));
    SET v_rate = IFNULL(p_vat_rate, 12.00);

    IF v_name IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'The shop needs a registered name. It is printed on every invoice.';
        LEAVE PROC_BODY;
    END IF;

    IF v_address IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'The shop needs an address. It is printed on every invoice.';
        LEAVE PROC_BODY;
    END IF;

    IF v_tin IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'The shop needs a TIN. An invoice without one is not a valid invoice.';
        LEAVE PROC_BODY;
    END IF;

    IF v_type NOT IN ('VAT', 'NON-VAT') THEN
        SET p_status_code = 400;
        SET p_message = 'Registration must be either VAT or NON-VAT.';
        LEAVE PROC_BODY;
    END IF;

    -- a VAT shop with a zero rate would print a VAT block full of zeroes
    IF v_type = 'VAT' AND (v_rate <= 0 OR v_rate > 100) THEN
        SET p_status_code = 400;
        SET p_message = 'A VAT-registered shop needs a rate above zero. The Philippine rate is 12.';
        LEAVE PROC_BODY;
    END IF;

    IF v_type = 'NON-VAT' THEN
        SET v_rate = 0.00;
    END IF;

    SELECT registration_type, vat_rate INTO v_old_type, v_old_rate
    FROM store_settings WHERE setting_id = 1;

    START TRANSACTION;

    INSERT INTO store_settings (setting_id, store_name, address, tin,
                                registration_type, vat_rate, invoice_note,
                                updated_by_staff_id)
    VALUES (1, v_name, v_address, v_tin, v_type, v_rate,
            NULLIF(TRIM(IFNULL(p_invoice_note, '')), ''), p_staff_id)
    ON DUPLICATE KEY UPDATE
        store_name = v_name,
        address = v_address,
        tin = v_tin,
        registration_type = v_type,
        vat_rate = v_rate,
        invoice_note = NULLIF(TRIM(IFNULL(p_invoice_note, '')), ''),
        updated_by_staff_id = p_staff_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'STORE_SETTINGS_UPDATED', 'UPDATE',
            CONCAT(v_name, ' set to ', v_type,
                   IF(v_type = 'VAT', CONCAT(' at ', FORMAT(v_rate, 2), '%'), ''),
                   IF(v_old_type IS NULL OR v_old_type = v_type, '',
                      CONCAT(' (was ', v_old_type,
                             IF(v_old_type = 'VAT', CONCAT(' at ', FORMAT(IFNULL(v_old_rate, 0), 2), '%'), ''),
                             ')'))));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = IF(v_type = 'VAT',
        CONCAT('Saved. Invoices now show a ', FORMAT(v_rate, 2), '% VAT breakdown.'),
        'Saved. Invoices now print NON-VAT REG TIN and no VAT breakdown.');
END //

-- ==========================================
-- 27. FIX A UNIT'S NAME
--
-- Renaming onto a name that already exists is a merge: products move to the
-- surviving unit and the duplicate is deleted. The adjustment log keeps the
-- unit text as it was filed.
-- ==========================================
CREATE PROCEDURE sp_rename_unit (
    IN p_unit_id INT,
    IN p_new_name VARCHAR(20),
    IN p_staff_id INT,
    OUT p_merged INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_old_name VARCHAR(20) DEFAULT NULL;
    DECLARE v_new VARCHAR(20);
    DECLARE v_clash_id INT DEFAULT NULL;
    DECLARE v_moved INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to rename the unit. All changes rolled back.';
    END;

    SET p_merged = 0;
    SET v_new = NULLIF(TRIM(IFNULL(p_new_name, '')), '');

    IF v_new IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A unit needs a name.';
        LEAVE PROC_BODY;
    END IF;

    SELECT unit_name INTO v_old_name FROM units WHERE unit_id = p_unit_id;

    IF v_old_name IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'That unit does not exist.';
        LEAVE PROC_BODY;
    END IF;

    IF LOWER(v_old_name) = LOWER(v_new) AND v_old_name = v_new THEN
        SET p_status_code = 200;
        SET p_message = CONCAT('Nothing changed. It was already called ', v_old_name, '.');
        LEAVE PROC_BODY;
    END IF;

    SELECT unit_id INTO v_clash_id
    FROM units WHERE LOWER(unit_name) = LOWER(v_new) AND unit_id <> p_unit_id
    LIMIT 1;

    START TRANSACTION;

    IF v_clash_id IS NULL THEN
        UPDATE units SET unit_name = v_new WHERE unit_id = p_unit_id;

        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'UNIT_RENAMED', 'UPDATE',
                CONCAT('Unit "', v_old_name, '" renamed to "', v_new, '"'));

        COMMIT;

        SET p_status_code = 200;
        SET p_message = CONCAT('Renamed ', v_old_name, ' to ', v_new, '.');
        LEAVE PROC_BODY;
    END IF;

    -- a merge
    SELECT COUNT(*) INTO v_moved FROM products WHERE unit_id = p_unit_id;

    UPDATE products SET unit_id = v_clash_id WHERE unit_id = p_unit_id;
    DELETE FROM units WHERE unit_id = p_unit_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'UNIT_MERGED', 'UPDATE',
            CONCAT('Unit "', v_old_name, '" merged into "', v_new, '", ',
                   v_moved, ' material(s) moved'));

    COMMIT;

    SET p_merged = 1;
    SET p_status_code = 200;
    SET p_message = CONCAT(v_new, ' already existed, so ', v_old_name, ' was merged into it. ',
                           v_moved, IF(v_moved = 1, ' material now uses ', ' materials now use '),
                           v_new, '.');
END //

-- ==========================================
-- 28. THE ARCHIVE SWEEP -- called by the server at startup and once a day
--
--   DELIVERIES  Delivered and fully paid, or Failed, ninety days after close
--   MATERIALS   nothing on the shelf and not sold, moved or ordered in 180 days
--
-- Nothing else is archived automatically. Each run that put something away
-- writes one audit line with no staff id, so the screen shows "System".
-- ==========================================
CREATE PROCEDURE sp_sweep_archives (
    OUT p_deliveries INT,
    OUT p_materials INT
)
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_deliveries = -1;
        SET p_materials = -1;
    END;

    START TRANSACTION;

    UPDATE deliveries d
    JOIN sales s ON s.sale_id = d.sale_id
    SET d.is_archived = TRUE, d.archived_at = NOW(), d.archived_by_staff_id = NULL
    WHERE d.is_archived = FALSE
      AND (
            (d.status = 'Delivered' AND s.payment_status = 'Paid'
             AND d.delivered_at < DATE_SUB(NOW(), INTERVAL 90 DAY))
         OR (d.status = 'Failed'
             AND d.updated_at < DATE_SUB(NOW(), INTERVAL 90 DAY))
      );
    SET p_deliveries = ROW_COUNT();

    UPDATE products p
    JOIN inventory i ON i.product_id = p.product_id
    SET p.is_archived = TRUE, p.status = 'Inactive', p.archived_at = NOW(), p.archived_by_staff_id = NULL
    WHERE p.is_archived = FALSE
      AND i.quantity_in_stock = 0
      AND p.created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)
      AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.sale_id = si.sale_id
                      WHERE si.product_id = p.product_id
                        AND s.sale_date > DATE_SUB(NOW(), INTERVAL 180 DAY))
      AND NOT EXISTS (SELECT 1 FROM stock_adjustments sa
                      WHERE sa.product_id = p.product_id
                        AND sa.created_at > DATE_SUB(NOW(), INTERVAL 180 DAY))
      AND NOT EXISTS (SELECT 1 FROM purchase_order_items poi JOIN purchase_orders po ON po.po_id = poi.po_id
                      WHERE poi.product_id = p.product_id AND po.status = 'Pending');
    SET p_materials = ROW_COUNT();

    IF p_deliveries > 0 OR p_materials > 0 THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (NULL, 'ARCHIVE_SWEEP', 'DELETE',
                CONCAT('Archived ', p_deliveries, ' closed deliveries older than 90 days and ',
                       p_materials, ' materials with no stock and no movement in 180 days'));
    END IF;

    COMMIT;
END //

-- ==========================================
-- 29. WHO MAY REACH A CONNECTED SYSTEM
--
-- One call sets the three levels and the note; all three FALSE removes the
-- row. Manage and control force monitor. Refused for a person with no login,
-- a deactivated account, or an administrator. The OUT values carry the
-- levels as they stood before; p_changed says whether anything moved.
-- ==========================================
CREATE PROCEDURE sp_set_system_permission (
    IN p_staff_id INT,
    IN p_system_key VARCHAR(40),
    IN p_can_monitor BOOLEAN,
    IN p_can_manage BOOLEAN,
    IN p_can_control BOOLEAN,
    IN p_note VARCHAR(255),
    IN p_granted_by_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255),
    OUT p_was_monitor BOOLEAN,
    OUT p_was_manage BOOLEAN,
    OUT p_was_control BOOLEAN,
    OUT p_changed BOOLEAN
)
PROC_BODY: BEGIN
    DECLARE v_system_id INT DEFAULT NULL;
    DECLARE v_system_name VARCHAR(100) DEFAULT NULL;
    DECLARE v_staff_count INT DEFAULT 0;
    DECLARE v_role_id INT DEFAULT 0;
    DECLARE v_is_active BOOLEAN DEFAULT FALSE;
    DECLARE v_has_login INT DEFAULT 0;
    DECLARE v_staff_name VARCHAR(220) DEFAULT '';
    DECLARE v_monitor BOOLEAN;
    DECLARE v_manage BOOLEAN;
    DECLARE v_control BOOLEAN;
    DECLARE v_note VARCHAR(255);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to change this permission. Nothing was saved.';
    END;

    SET p_was_monitor = FALSE;
    SET p_was_manage = FALSE;
    SET p_was_control = FALSE;
    SET p_changed = FALSE;

    -- manage and control both carry monitor with them
    SET v_manage = IFNULL(p_can_manage, FALSE);
    SET v_control = IFNULL(p_can_control, FALSE);
    SET v_monitor = IFNULL(p_can_monitor, FALSE) OR v_manage OR v_control;
    SET v_note = NULLIF(TRIM(IFNULL(p_note, '')), '');

    SELECT system_id, system_name INTO v_system_id, v_system_name
    FROM connected_systems WHERE system_key = p_system_key LIMIT 1;

    IF v_system_id IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'No connected system is registered under that name.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE staff_id = p_staff_id;
    IF v_staff_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Staff record not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT s.role_id, s.is_active, s.full_name INTO v_role_id, v_is_active, v_staff_name
    FROM staff s WHERE s.staff_id = p_staff_id;
    SELECT COUNT(*) INTO v_has_login FROM users WHERE staff_id = p_staff_id;

    IF v_role_id = 1 THEN
        SET p_status_code = 400;
        SET p_message = 'A System Administrator already holds every level on every system. There is nothing to grant.';
        LEAVE PROC_BODY;
    END IF;

    -- what stood before, for the audit entry
    SELECT can_monitor, can_manage, can_control
      INTO p_was_monitor, p_was_manage, p_was_control
    FROM system_permissions
    WHERE staff_id = p_staff_id AND system_id = v_system_id
    LIMIT 1;

    SET p_was_monitor = IFNULL(p_was_monitor, FALSE);
    SET p_was_manage = IFNULL(p_was_manage, FALSE);
    SET p_was_control = IFNULL(p_was_control, FALSE);

    -- revoking is allowed on any account; granting only to one that can sign in
    IF v_monitor AND (v_has_login = 0) THEN
        SET p_status_code = 400;
        SET p_message = CONCAT(v_staff_name, ' has no login account, so there is nobody to give access to. Create the login first.');
        LEAVE PROC_BODY;
    END IF;

    IF v_monitor AND (v_is_active = FALSE) THEN
        SET p_status_code = 400;
        SET p_message = CONCAT(v_staff_name, ' is deactivated. Restore the account before giving it access to anything.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    IF v_monitor = FALSE THEN
        DELETE FROM system_permissions
        WHERE staff_id = p_staff_id AND system_id = v_system_id;

        SET p_changed = (ROW_COUNT() > 0);
        SET p_message = IF(p_changed,
            CONCAT(v_staff_name, ' no longer has any access to ', v_system_name, '.'),
            CONCAT(v_staff_name, ' already had no access to ', v_system_name, '.'));
    ELSE
        INSERT INTO system_permissions
            (staff_id, system_id, can_monitor, can_manage, can_control, note, granted_by_staff_id)
        VALUES
            (p_staff_id, v_system_id, v_monitor, v_manage, v_control, v_note, p_granted_by_staff_id)
        ON DUPLICATE KEY UPDATE
            can_monitor = v_monitor,
            can_manage = v_manage,
            can_control = v_control,
            note = v_note,
            granted_by_staff_id = p_granted_by_staff_id;

        SET p_changed = (p_was_monitor <> v_monitor OR p_was_manage <> v_manage
                         OR p_was_control <> v_control);
        SET p_message = CONCAT(v_staff_name, ' may now ',
            CASE WHEN v_manage AND v_control THEN 'monitor, manage and control'
                 WHEN v_manage THEN 'monitor and manage'
                 WHEN v_control THEN 'monitor and control'
                 ELSE 'monitor' END,
            ' ', v_system_name, '.');
    END IF;

    COMMIT;

    SET p_status_code = 200;
END //

-- ==========================================
-- 30. REGISTERING A CONNECTED SYSTEM, OR CHANGING ONE
--
-- Told apart by whether the key is on the register. The key is never
-- renamed. Internal systems are seeded by the server; anything registered
-- from a screen is External and must have an address. Switching a system
-- off keeps its row and its permissions.
-- ==========================================
CREATE PROCEDURE sp_save_connected_system (
    IN p_system_key VARCHAR(40),
    IN p_system_name VARCHAR(100),
    IN p_description VARCHAR(255),
    IN p_endpoint_url VARCHAR(255),
    IN p_is_enabled BOOLEAN,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255),
    OUT p_system_id INT,
    OUT p_created BOOLEAN
)
PROC_BODY: BEGIN
    DECLARE v_key VARCHAR(40);
    DECLARE v_name VARCHAR(100);
    DECLARE v_url VARCHAR(255);
    DECLARE v_kind VARCHAR(10) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = 'Unable to save the connected system. Nothing was changed.';
    END;

    SET p_system_id = NULL;
    SET p_created = FALSE;
    SET v_key = LOWER(TRIM(IFNULL(p_system_key, '')));
    SET v_name = NULLIF(TRIM(IFNULL(p_system_name, '')), '');
    SET v_url = NULLIF(TRIM(IFNULL(p_endpoint_url, '')), '');

    IF v_key = '' OR v_key NOT REGEXP '^[a-z0-9][a-z0-9-]{1,39}$' THEN
        SET p_status_code = 400;
        SET p_message = 'A system key is 2 to 40 characters of lower-case letters, digits and hyphens.';
        LEAVE PROC_BODY;
    END IF;

    IF v_name IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'The system needs a name.';
        LEAVE PROC_BODY;
    END IF;

    SELECT system_id, system_kind INTO p_system_id, v_kind
    FROM connected_systems WHERE system_key = v_key LIMIT 1;

    -- an internal system has no address to edit; an external one is nothing without one
    IF v_kind = 'Internal' THEN
        SET v_url = NULL;
    ELSEIF v_url IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'An external system needs the address it answers at, starting http:// or https://.';
        LEAVE PROC_BODY;
    ELSEIF v_url NOT REGEXP '^https?://[^[:space:]/@]+(/[^[:space:]]*)?$' THEN
        SET p_status_code = 400;
        SET p_message = 'The address must start http:// or https:// and carry no username or password.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    IF p_system_id IS NULL THEN
        INSERT INTO connected_systems
            (system_key, system_name, system_kind, description, endpoint_url, is_enabled, created_by_staff_id)
        VALUES
            (v_key, v_name, 'External', NULLIF(TRIM(IFNULL(p_description, '')), ''),
             v_url, IFNULL(p_is_enabled, TRUE), p_staff_id);

        SET p_system_id = LAST_INSERT_ID();
        SET p_created = TRUE;
        SET p_message = CONCAT(v_name, ' is registered. Nobody but the administrator can reach it until access is granted.');
    ELSE
        UPDATE connected_systems
        SET system_name = v_name,
            description = NULLIF(TRIM(IFNULL(p_description, '')), ''),
            endpoint_url = v_url,
            is_enabled = IFNULL(p_is_enabled, is_enabled)
        WHERE system_id = p_system_id;

        SET p_message = CONCAT(v_name, ' was updated.');
    END IF;

    COMMIT;

    SET p_status_code = 200;
END //

DELIMITER ;
