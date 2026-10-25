USE hardware_db;

DELIMITER //

DROP VIEW IF EXISTS vw_customer_credit //
DROP VIEW IF EXISTS vw_customer_credit_facts //
DROP VIEW IF EXISTS vw_customer_loyalty //
DROP VIEW IF EXISTS vw_archives //

CREATE VIEW vw_customer_credit_facts AS

SELECT
    c.customer_id,
    c.full_name AS customer_name,
    c.phone,
    c.address,
    COALESCE(cc.credit_limit, 0.00) AS credit_limit,
    COALESCE(cc.standing, 'Good') AS manual_standing,
    cc.notes AS credit_notes,
    cc.updated_at AS credit_updated_at,

    cc.penalty_rate AS penalty_rate_override,
    COALESCE(cc.penalty_rate, (SELECT penalty_rate FROM store_settings WHERE setting_id = 1), 3.00)
        AS penalty_rate,

    COALESCE((SELECT SUM(s.final_amount)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE), 0.00) AS total_purchase,

    COALESCE((SELECT SUM(s.amount_due - s.amount_paid)
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS current_credit,

    COALESCE((SELECT SUM(LEAST(s.penalty_amount, GREATEST(s.amount_due - s.amount_paid, 0)))
              FROM sales s
              WHERE s.customer_id = c.customer_id
                AND s.is_archived = FALSE
                AND s.payment_status <> 'Paid'), 0.00) AS penalties_owed,

    (SELECT COUNT(*) FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_status <> 'Paid'
       AND DATE(s.sale_date) < DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS overdue_sales,

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

CREATE VIEW vw_customer_credit AS
SELECT
    f.*,

    CASE
        WHEN f.credit_limit > 0 AND f.current_credit > f.credit_limit THEN 'Hold'
        WHEN f.oldest_debt_days > 90                                   THEN 'Hold'
        WHEN f.oldest_debt_days > 30                                   THEN 'Watch'
        WHEN f.credit_limit > 0 AND f.current_credit >= f.credit_limit * 0.75 THEN 'Watch'
        ELSE 'Good'
    END AS computed_standing,

    CASE
        WHEN f.manual_standing = 'Hold'                                THEN 'Hold'
        WHEN f.credit_limit > 0 AND f.current_credit > f.credit_limit THEN 'Hold'
        WHEN f.oldest_debt_days > 90                                   THEN 'Hold'
        WHEN f.manual_standing = 'Watch'                               THEN 'Watch'
        WHEN f.oldest_debt_days > 30                                   THEN 'Watch'
        WHEN f.credit_limit > 0 AND f.current_credit >= f.credit_limit * 0.75 THEN 'Watch'
        ELSE 'Good'
    END AS standing,

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

CREATE VIEW vw_customer_loyalty AS
SELECT
    c.customer_id,

    (SELECT COALESCE(SUM(s.final_amount - s.refunded_amount), 0.00)
     FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_method NOT IN ('Credit', 'COD')
       AND s.payment_status = 'Paid'
       AND s.sale_date >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
       AND s.sale_date <  DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS last_month_paid,

    (SELECT COALESCE(SUM(s.final_amount - s.refunded_amount), 0.00)
     FROM sales s
     WHERE s.customer_id = c.customer_id
       AND s.is_archived = FALSE
       AND s.payment_method NOT IN ('Credit', 'COD')
       AND s.payment_status = 'Paid'
       AND s.sale_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
       AND s.sale_date <  DATE_FORMAT(CURDATE() + INTERVAL 1 MONTH, '%Y-%m-01')) AS this_month_paid

FROM customers c //

CREATE VIEW vw_archives AS
SELECT 'Staff' AS module, s.staff_id AS record_id,
       s.full_name AS record_name,
       r.role_name AS detail, s.archived_at,
       a.full_name AS archived_by
FROM staff s
JOIN roles r ON r.role_id = s.role_id
LEFT JOIN staff a ON a.staff_id = s.archived_by_staff_id
WHERE s.archived_at IS NOT NULL
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
DROP PROCEDURE IF EXISTS sp_decide_purchase_order //
DROP PROCEDURE IF EXISTS sp_receive_purchase_order //
DROP PROCEDURE IF EXISTS sp_file_return_report //
DROP PROCEDURE IF EXISTS sp_file_return_reports //
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
DROP PROCEDURE IF EXISTS sp_set_penalty_policy //
DROP PROCEDURE IF EXISTS sp_apply_late_penalties //
DROP PROCEDURE IF EXISTS sp_update_store_bank_details //
DROP PROCEDURE IF EXISTS sp_set_sale_reference //
DROP PROCEDURE IF EXISTS sp_create_qr_payment //
DROP PROCEDURE IF EXISTS sp_set_qr_payment_result //
DROP PROCEDURE IF EXISTS sp_link_qr_payment_to_sale //
DROP PROCEDURE IF EXISTS sp_set_system_permission //
DROP PROCEDURE IF EXISTS sp_save_connected_system //
DROP PROCEDURE IF EXISTS sp_upgrade_add_column //
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_reset_user_password failed (', @err_no, '): ', LEFT(@err_text, 180));
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_staff_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_staff_account failed (', @err_no, '): ', LEFT(@err_text, 180));
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_update_staff_account failed (', @err_no, '): ', LEFT(@err_text, 180));
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

CREATE PROCEDURE sp_set_staff_status (
    IN p_staff_id INT,
    IN p_is_active BOOLEAN,
    IN p_by_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_staff_count INT DEFAULT 0;
    DECLARE v_admin_count INT DEFAULT 0;
    DECLARE v_admin_total INT DEFAULT 0;
    DECLARE v_role_id INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_staff_status failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE staff_id = p_staff_id;
    IF v_staff_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Staff record not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT role_id INTO v_role_id FROM staff WHERE staff_id = p_staff_id;

    START TRANSACTION;

    IF p_is_active = FALSE AND v_role_id = 1 THEN
        SELECT COUNT(*) INTO v_admin_total
        FROM staff
        WHERE role_id = 1
        FOR UPDATE;

        SELECT COUNT(*) INTO v_admin_count
        FROM staff
        WHERE role_id = 1 AND is_active = TRUE AND staff_id <> p_staff_id
        FOR UPDATE;

        IF v_admin_count = 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = 'You cannot deactivate the last active system administrator.';
            LEAVE PROC_BODY;
        END IF;
    END IF;

    IF p_is_active = FALSE THEN
        UPDATE staff
        SET is_active = FALSE, deactivated_at = COALESCE(deactivated_at, NOW())
        WHERE staff_id = p_staff_id;
    ELSE
        UPDATE staff
        SET is_active = TRUE, deactivated_at = NULL, archived_at = NULL, archived_by_staff_id = NULL
        WHERE staff_id = p_staff_id;
    END IF;

    COMMIT;

    SET p_status_code = 200;
    SET p_message = 'Account status updated.';
END //
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_login_for_staff failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
    END;

    SELECT p.product_name, COALESCE(i.quantity_in_stock, 0), p.reorder_point
    INTO v_name, v_stock, v_point
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.product_id
    WHERE p.product_id = p_product_id AND p.is_archived = FALSE;

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

    UPDATE notifications
    SET is_read = TRUE
    WHERE product_id = p_product_id
      AND notif_type IN ('Low Stock', 'Out of Stock')
      AND notif_type <> v_type
      AND is_read = FALSE;

    SELECT COUNT(*) INTO v_open
    FROM notifications
    WHERE product_id = p_product_id AND notif_type = v_type AND is_read = FALSE;

    IF v_open > 0 THEN
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (3, v_type, v_title, v_message, p_product_id, p_actor_staff_id);

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (2, v_type, v_title, v_message, p_product_id, p_actor_staff_id);
END //

CREATE PROCEDURE sp_create_sale_transaction (
    IN p_customer_id INT,
    IN p_walk_in_name VARCHAR(150),
    IN p_cashier_staff_id INT,
    IN p_expected_discount DECIMAL(10,2),
    IN p_amount_paid DECIMAL(12,2),
    IN p_payment_method VARCHAR(30),
    IN p_items_json JSON,
    IN p_down_payment_method VARCHAR(30),
    IN p_qr_payment_id INT,
    IN p_pay_details JSON,
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
    DECLARE v_needed DECIMAL(12,3);
    DECLARE v_unit VARCHAR(20);
    DECLARE v_base_unit VARCHAR(20);
    DECLARE v_units_per DECIMAL(12,3);
    DECLARE v_pack_price DECIMAL(10,2);
    DECLARE v_base_quantity DECIMAL(12,3);
    DECLARE v_product_name VARCHAR(150);

    DECLARE v_discount DECIMAL(10,2) DEFAULT 0.00;
    DECLARE v_amount_paid DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_calculated_total DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_final_amount DECIMAL(12,2) DEFAULT 0.00;

    DECLARE v_loyalty_rate DECIMAL(5,2) DEFAULT 0.00;
    DECLARE v_loyalty_threshold DECIMAL(12,2) DEFAULT 5000.00;
    DECLARE v_loyalty_paid DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_loyalty_on BOOLEAN DEFAULT FALSE;

    DECLARE v_credit_limit DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_current_credit DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_standing VARCHAR(10) DEFAULT 'Good';
    DECLARE v_on_credit BOOLEAN DEFAULT FALSE;
    DECLARE v_on_account BOOLEAN DEFAULT FALSE;
    DECLARE v_new_exposure DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_locked_customer_id INT DEFAULT NULL;
    DECLARE v_down_method VARCHAR(30) DEFAULT 'Cash';
    DECLARE v_payment_status VARCHAR(10) DEFAULT 'Paid';
    DECLARE v_walk_in_name VARCHAR(150) DEFAULT NULL;

    DECLARE v_qr_found INT DEFAULT 0;
    DECLARE v_qr_status VARCHAR(12) DEFAULT NULL;
    DECLARE v_qr_sale INT DEFAULT NULL;
    DECLARE v_qr_amount DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_qr_wallet VARCHAR(20) DEFAULT NULL;
    DECLARE v_qr_method VARCHAR(30) DEFAULT NULL;

    DECLARE v_taken_method VARCHAR(30) DEFAULT NULL;
    DECLARE v_payment_row INT DEFAULT NULL;

    DECLARE v_registration VARCHAR(10) DEFAULT 'VAT';
    DECLARE v_vat_rate DECIMAL(5,2) DEFAULT 12.00;
    DECLARE v_vat_amount DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_vatable_sale DECIMAL(12,2) DEFAULT 0.00;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        SET p_sale_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_sale_transaction failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_sale_id = NULL;
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

    SET v_on_credit = (p_payment_method = 'Credit');
    SET v_on_account = (p_payment_method IN ('Credit', 'COD'));
    SET v_down_method = IFNULL(NULLIF(TRIM(IFNULL(p_down_payment_method, '')), ''), 'Cash');

    IF p_customer_id IS NULL THEN
        SET v_walk_in_name = NULLIF(TRIM(IFNULL(p_walk_in_name, '')), '');
    ELSE
        SET v_walk_in_name = NULL;
    END IF;

    SET v_loyalty_on = FALSE;
    IF p_customer_id IS NOT NULL AND p_payment_method NOT IN ('Credit', 'COD') THEN
        SELECT loyalty_rate, loyalty_threshold
        INTO v_loyalty_rate, v_loyalty_threshold
        FROM store_settings
        WHERE setting_id = 1;

        IF v_loyalty_rate > 0 THEN
            SELECT COALESCE(SUM(s.final_amount - s.refunded_amount), 0.00)
            INTO v_loyalty_paid
            FROM sales s
            WHERE s.customer_id = p_customer_id
              AND s.is_archived = FALSE
              AND s.payment_method NOT IN ('Credit', 'COD')
              AND s.payment_status = 'Paid'
              AND s.sale_date >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
              AND s.sale_date <  DATE_FORMAT(CURDATE(), '%Y-%m-01');

            SET v_loyalty_on = (v_loyalty_paid >= v_loyalty_threshold);
        END IF;
    END IF;

    DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
    CREATE TEMPORARY TABLE tmp_sale_needed (
        product_id INT PRIMARY KEY,
        product_name VARCHAR(150),
        unit_name VARCHAR(20),
        needed DECIMAL(12,3) NOT NULL
    );

    START TRANSACTION;

    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_unit       = NULLIF(TRIM(IFNULL(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].unit'))), 'null'), '')), '');

        IF v_quantity IS NULL OR v_quantity <= 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('Quantity for Product ID ', IFNULL(v_product_id, 0), ' must be greater than zero.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        SET v_unit_price = NULL;
        SET v_stock = NULL;
        SET v_base_unit = NULL;
        SET v_product_name = NULL;

        SELECT p.price, p.product_name, u.unit_name
        INTO v_unit_price, v_product_name, v_base_unit
        FROM products p
        LEFT JOIN units u ON u.unit_id = p.unit_id
        WHERE p.product_id = v_product_id AND p.status = 'Active';

        IF v_unit_price IS NULL THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = CONCAT('Product ID ', IFNULL(v_product_id, 0), ' is invalid or inactive.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        SET v_units_per = 1;
        IF v_unit IS NOT NULL AND LOWER(v_unit) <> LOWER(IFNULL(v_base_unit, '')) THEN
            SET v_units_per = NULL;
            SET v_pack_price = NULL;
            SELECT pu.units_per, pu.price INTO v_units_per, v_pack_price
            FROM product_units pu
            WHERE pu.product_id = v_product_id AND LOWER(pu.unit_name) = LOWER(v_unit)
            LIMIT 1;

            IF v_units_per IS NULL OR v_units_per <= 0 THEN
                ROLLBACK;
                SET p_status_code = 400;
                SET p_message = CONCAT(v_product_name, ' is not sold by the ', v_unit, '.');
                DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
                LEAVE PROC_BODY;
            END IF;
            SET v_unit_price = IFNULL(v_pack_price, ROUND(v_unit_price * v_units_per, 2));
        END IF;

        IF v_unit_price IS NULL OR v_unit_price <= 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT(v_product_name, ' has no price yet, so it cannot be sold. Ask the manager to set the price.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        SET v_base_quantity = ROUND(v_quantity * v_units_per, 3);
        INSERT INTO tmp_sale_needed (product_id, product_name, unit_name, needed)
        VALUES (v_product_id, v_product_name, v_base_unit, v_base_quantity)
        ON DUPLICATE KEY UPDATE needed = needed + VALUES(needed);

        SET v_calculated_total = v_calculated_total + ROUND(v_unit_price * v_quantity, 2);
        SET v_i = v_i + 1;
    END WHILE;

    SET v_discount = 0.00;
    IF v_loyalty_on THEN
        SET v_discount = ROUND(v_calculated_total * v_loyalty_rate / 100, 0);
    END IF;

    IF p_expected_discount IS NOT NULL AND p_expected_discount <> v_discount THEN
        ROLLBACK;
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        SET p_status_code = 409;
        SET p_message = CONCAT('The loyalty discount changed to ', CHAR(0xE282B1 USING utf8mb4),
                               FORMAT(v_discount, 2), '. Check the amount and try again.');
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_stock
    FROM inventory
    WHERE product_id IN (SELECT product_id FROM tmp_sale_needed)
    FOR UPDATE;

    SET v_product_id = NULL;
    SELECT t.product_id, t.product_name, t.unit_name, t.needed, IFNULL(i.quantity_in_stock, 0)
    INTO v_product_id, v_product_name, v_base_unit, v_needed, v_stock
    FROM tmp_sale_needed t
    LEFT JOIN inventory i ON i.product_id = t.product_id
    WHERE IFNULL(i.quantity_in_stock, 0) < t.needed
    ORDER BY t.product_id
    LIMIT 1
    FOR UPDATE;

    IF v_product_id IS NOT NULL THEN
        ROLLBACK;
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        SET p_status_code = 400;
        SET p_message = CONCAT('Insufficient stock for ', v_product_name,
                               '. Asked for: ', v_needed, ' ', IFNULL(v_base_unit, ''),
                               ', available: ', v_stock, ' ', IFNULL(v_base_unit, ''));
        LEAVE PROC_BODY;
    END IF;

    SET v_final_amount = v_calculated_total - v_discount;

    IF v_final_amount < 0 THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Discount is larger than the total.';
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        LEAVE PROC_BODY;
    END IF;

    IF v_on_account THEN
        IF v_on_credit THEN
            IF v_amount_paid < 0 THEN
                SET v_amount_paid = 0.00;
            END IF;
            IF v_amount_paid > v_final_amount THEN
                SET v_amount_paid = v_final_amount;
            END IF;
        ELSE
            SET v_amount_paid = 0.00;
        END IF;

        SET v_new_exposure = v_final_amount - v_amount_paid;

        SELECT c.customer_id, COALESCE(cc.credit_limit, 0.00)
        INTO v_locked_customer_id, v_credit_limit
        FROM customers c
        LEFT JOIN customer_credits cc ON cc.customer_id = c.customer_id
        WHERE c.customer_id = p_customer_id
        FOR UPDATE;

        SELECT COALESCE(SUM(s.amount_due - s.amount_paid), 0.00)
        INTO v_current_credit
        FROM sales s
        WHERE s.customer_id = p_customer_id
          AND s.is_archived = FALSE
          AND s.payment_status <> 'Paid'
        FOR UPDATE;

        SELECT standing
        INTO v_standing
        FROM vw_customer_credit
        WHERE customer_id = p_customer_id;

        IF v_standing = 'Hold' AND v_new_exposure > 0 THEN
            ROLLBACK;
            SET p_status_code = 403;
            IF v_on_credit THEN
                SET p_message = CONCAT('This account is on hold and cannot take new credit. ',
                                       'Take the full ', FORMAT(v_final_amount, 2),
                                       ' now, or ask a manager to lift the hold.');
            ELSE
                SET p_message = CONCAT('This account is on hold, so a COD order cannot be placed. ',
                                       'Take the full ', FORMAT(v_final_amount, 2),
                                       ' now, or ask a manager to lift the hold.');
            END IF;
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF v_current_credit + v_new_exposure > v_credit_limit THEN
            ROLLBACK;
            SET p_status_code = 400;
            IF v_on_credit THEN
                SET p_message = CONCAT('Credit limit exceeded. Remaining credit: ',
                                       FORMAT(GREATEST(v_credit_limit - v_current_credit, 0), 2),
                                       '. Take a down payment of at least ',
                                       FORMAT(GREATEST(v_new_exposure - (v_credit_limit - v_current_credit), 0), 2),
                                       ', or raise an extension request.');
            ELSE
                SET p_message = CONCAT('Credit limit exceeded. Remaining credit: ',
                                       FORMAT(GREATEST(v_credit_limit - v_current_credit, 0), 2),
                                       '. This COD order is for ', FORMAT(v_final_amount, 2),
                                       '. Take payment now, or raise an extension request.');
            END IF;
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF NOT v_on_credit THEN
            SET v_payment_status = 'Unpaid';
        ELSEIF v_amount_paid >= v_final_amount THEN
            SET v_payment_status = 'Paid';
        ELSEIF v_amount_paid > 0 THEN
            SET v_payment_status = 'Partial';
        ELSE
            SET v_payment_status = 'Unpaid';
        END IF;

    ELSEIF v_amount_paid < v_final_amount THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Amount paid is less than the total balance due.';
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        LEAVE PROC_BODY;
    ELSE
        SET v_payment_status = 'Paid';
    END IF;

    IF p_qr_payment_id IS NOT NULL THEN
        IF v_on_credit THEN
            SET v_qr_method = v_down_method;
        ELSE
            SET v_qr_method = p_payment_method;
        END IF;

        SELECT COUNT(*), MAX(status), MAX(sale_id), MAX(amount), MAX(wallet)
          INTO v_qr_found, v_qr_status, v_qr_sale, v_qr_amount, v_qr_wallet
        FROM qr_payments WHERE qr_payment_id = p_qr_payment_id
        FOR UPDATE;

        IF v_qr_found = 0 THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'That QR payment is not on record. Make a new QR code.';
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_status <> 'paid' THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('This QR payment has not been paid (it is ', v_qr_status, '), so nothing was recorded.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_sale IS NOT NULL THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('This QR payment is already recorded on OR-', LPAD(v_qr_sale, 6, '0'),
                                   '. One payment cannot pay for two things.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_amount <> v_amount_paid THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('The QR payment was for ', FORMAT(v_qr_amount, 2), ' but ',
                                   FORMAT(v_amount_paid, 2), ' is being taken now. Nothing was recorded.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_wallet <> v_qr_method THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('The QR payment was made with ', v_qr_wallet, ', not ', v_qr_method,
                                   '. Nothing was recorded.');
            DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
            LEAVE PROC_BODY;
        END IF;
    END IF;

    IF v_on_credit THEN
        IF v_amount_paid > 0 THEN
            SET v_taken_method = v_down_method;
        END IF;
    ELSEIF NOT v_on_account THEN
        SET v_taken_method = p_payment_method;
    END IF;

    IF v_taken_method = 'Cheque' AND p_pay_details IS NULL THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'A cheque needs its account name, account number, bank, branch and date.';
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        LEAVE PROC_BODY;
    END IF;
    IF v_taken_method = 'Bank Transfer' AND p_qr_payment_id IS NULL AND p_pay_details IS NULL THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'A bank transfer needs its bank, account name and account number.';
        DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;
        LEAVE PROC_BODY;
    END IF;

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
        SET v_vat_rate = 0.00;
        SET v_vat_amount = 0.00;
        SET v_vatable_sale = 0.00;
    END IF;

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

    SET v_i = 0;
    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_unit       = NULLIF(TRIM(IFNULL(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].unit'))), 'null'), '')), '');

        SET v_unit_price = NULL;
        SET v_base_unit = NULL;
        SELECT p.price, u.unit_name INTO v_unit_price, v_base_unit
        FROM products p
        LEFT JOIN units u ON u.unit_id = p.unit_id
        WHERE p.product_id = v_product_id;

        SET v_units_per = 1;
        IF v_unit IS NOT NULL AND LOWER(v_unit) <> LOWER(IFNULL(v_base_unit, '')) THEN
            SET v_pack_price = NULL;
            SELECT pu.units_per, pu.price, pu.unit_name INTO v_units_per, v_pack_price, v_unit
            FROM product_units pu
            WHERE pu.product_id = v_product_id AND LOWER(pu.unit_name) = LOWER(v_unit)
            LIMIT 1;
            SET v_unit_price = IFNULL(v_pack_price, ROUND(v_unit_price * v_units_per, 2));
        ELSE
            SET v_unit = NULL;
        END IF;
        SET v_base_quantity = ROUND(v_quantity * v_units_per, 3);

        INSERT INTO sale_items (sale_id, product_id, quantity, sold_unit, sold_quantity, unit_price)
        VALUES (p_sale_id, v_product_id, v_base_quantity, v_unit,
                IF(v_unit IS NULL, NULL, v_quantity), v_unit_price);

        UPDATE inventory
        SET quantity_in_stock = quantity_in_stock - v_base_quantity
        WHERE product_id = v_product_id;

        SET v_i = v_i + 1;
    END WHILE;

    IF v_on_credit AND v_amount_paid > 0 THEN
        INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method,
                                     reference_no, received_by_staff_id)
        VALUES (p_customer_id, p_sale_id, v_amount_paid, v_down_method,
                'Down payment at counter', p_cashier_staff_id);
        SET v_payment_row = LAST_INSERT_ID();
    END IF;

    IF v_taken_method = 'Bank Transfer' AND p_qr_payment_id IS NOT NULL THEN
        INSERT INTO payment_details (sale_id, payment_id, method, account_name, account_number,
                                     bank_name, qr_payment_id, created_by_staff_id)
        SELECT p_sale_id, v_payment_row, 'Bank Transfer', account_name, account_number,
               bank_name, qr_payment_id, p_cashier_staff_id
        FROM qr_payments WHERE qr_payment_id = p_qr_payment_id;
    ELSEIF v_taken_method IN ('Cheque', 'Bank Transfer') THEN
        INSERT INTO payment_details (sale_id, payment_id, method, account_name, account_number,
                                     bank_name, branch, cheque_date, created_by_staff_id)
        VALUES (p_sale_id, v_payment_row, v_taken_method,
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.accountName')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.accountNumber')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.bank')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.branch')),
                CAST(JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.chequeDate')) AS DATE),
                p_cashier_staff_id);
    END IF;

    IF p_qr_payment_id IS NOT NULL THEN
        UPDATE qr_payments SET sale_id = p_sale_id, error_message = NULL
        WHERE qr_payment_id = p_qr_payment_id;

        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_cashier_staff_id, 'QR_PAYMENT_LINKED', 'PAYMENT',
                CONCAT('QR payment #', p_qr_payment_id, ' recorded on OR-', LPAD(p_sale_id, 6, '0')));
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_cashier_staff_id, 'SALE', 'CREATE',
            CONCAT('Sale #', p_sale_id, ' for ', FORMAT(v_final_amount, 2),
                   IF(v_on_credit AND v_amount_paid > 0,
                      CONCAT(', ', FORMAT(v_amount_paid, 2), ' down, ',
                             FORMAT(v_final_amount - v_amount_paid, 2), ' on account'),
                      '')));

    COMMIT;
    DROP TEMPORARY TABLE IF EXISTS tmp_sale_needed;

    SET v_i = 0;
    WHILE v_i < v_item_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        CALL sp_raise_stock_alert(v_product_id, p_cashier_staff_id);
        SET v_i = v_i + 1;
    END WHILE;

    SET p_status_code = 200;
    SET p_message = 'Sale transaction completed successfully.';
END //

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
    DECLARE v_first_reference VARCHAR(60);
    DECLARE v_delivery_status VARCHAR(20);
    DECLARE v_payment_status VARCHAR(10);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_archive_record failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_module = 'Staff' THEN
        SELECT COUNT(*) INTO v_found FROM staff WHERE staff_id = p_record_id AND archived_at IS NULL;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Staff record not found, or it is already archived.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found FROM staff WHERE staff_id = p_record_id AND is_active = TRUE;
        IF v_found > 0 THEN
            SET p_status_code = 409;
            SET p_message = 'Only a deactivated account can be archived. Deactivate it first.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE staff
        SET archived_at = NOW(), archived_by_staff_id = p_staff_id,
            deactivated_at = COALESCE(deactivated_at, NOW())
        WHERE staff_id = p_record_id;

    ELSEIF p_module = 'Inventory' THEN
        SELECT COUNT(*) INTO v_found FROM products WHERE product_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active product record not found.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COALESCE(quantity_in_stock, 0) INTO v_stock
        FROM inventory WHERE product_id = p_record_id;
        IF v_stock > 0 THEN
            SET p_status_code = 409;
            SET p_message = CONCAT('This material still has ', v_stock, ' on hand. ',
                                   'Sell it off or write it off before archiving it.');
            LEAVE PROC_BODY;
        END IF;

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
        START TRANSACTION;

        SET v_sale_day = NULL;
        SELECT DATE(sale_date) INTO v_sale_day
        FROM sales WHERE sale_id = p_record_id AND is_archived = FALSE
        FOR UPDATE;

        IF v_sale_day IS NULL THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'Active sale record not found.';
            LEAVE PROC_BODY;
        END IF;

        IF v_sale_day <> CURDATE() THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'A sale can only be voided on the day it was made. Correct an older one with a return or a refund.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found FROM deliveries
        WHERE sale_id = p_record_id AND is_archived = FALSE
          AND status IN ('Out for Delivery', 'Delivered')
        FOR UPDATE;
        IF v_found > 0 THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'The goods on this sale are out for delivery or delivered. It cannot be voided from here.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found FROM returned_items WHERE sale_id = p_record_id;
        IF v_found = 0 THEN
            SELECT COUNT(*) INTO v_found FROM credit_payments WHERE sale_id = p_record_id;

            SET v_first_reference = NULL;
            SELECT reference_no INTO v_first_reference FROM credit_payments
            WHERE sale_id = p_record_id
            ORDER BY payment_id
            LIMIT 1;

            IF v_found > 0 AND IFNULL(v_first_reference, '') = 'Down payment at counter' THEN
                SET v_found = v_found - 1;
            END IF;
        END IF;
        IF v_found > 0 THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'Money has already moved on this sale (a payment or a refund report was recorded after it was rung up). It cannot be voided; correct it with a refund instead.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found
        FROM inventory
        WHERE product_id IN (SELECT product_id FROM sale_items WHERE sale_id = p_record_id)
        FOR UPDATE;

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

        UPDATE deliveries
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE sale_id = p_record_id AND is_archived = FALSE;

        UPDATE sales
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE sale_id = p_record_id;

        COMMIT;

    ELSEIF p_module = 'Delivery' THEN
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_restore_archive failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_module = 'Staff' THEN
        SELECT COUNT(*) INTO v_found FROM staff WHERE staff_id = p_record_id AND archived_at IS NOT NULL;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Archived staff record not found.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE staff
        SET is_active = TRUE, deactivated_at = NULL, archived_at = NULL, archived_by_staff_id = NULL
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
        START TRANSACTION;

        SELECT COUNT(*) INTO v_found FROM sales
        WHERE sale_id = p_record_id AND is_archived = TRUE
        FOR UPDATE;
        IF v_found = 0 THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'Archived sale record not found.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_found
        FROM inventory
        WHERE product_id IN (SELECT product_id FROM sale_items WHERE sale_id = p_record_id)
        FOR UPDATE;

        SELECT COUNT(*) INTO v_found
        FROM sale_items si JOIN inventory i ON i.product_id = si.product_id
        WHERE si.sale_id = p_record_id AND i.quantity_in_stock < si.quantity;
        IF v_found > 0 THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'The stock on this sale has been sold since it was voided. It cannot be restored.';
            LEAVE PROC_BODY;
        END IF;

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

CREATE PROCEDURE sp_record_credit_payment (
    IN p_sale_id INT,
    IN p_amount DECIMAL(12,2),
    IN p_payment_method VARCHAR(30),
    IN p_reference_no VARCHAR(60),
    IN p_staff_id INT,
    IN p_qr_payment_id INT,
    IN p_pay_details JSON,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_customer_id INT;
    DECLARE v_final DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_paid DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_status VARCHAR(10);
    DECLARE v_method VARCHAR(30);
    DECLARE v_voided BOOLEAN DEFAULT FALSE;

    DECLARE v_qr_found INT DEFAULT 0;
    DECLARE v_qr_status VARCHAR(12) DEFAULT NULL;
    DECLARE v_qr_sale INT DEFAULT NULL;
    DECLARE v_qr_amount DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_qr_wallet VARCHAR(20) DEFAULT NULL;
    DECLARE v_payment_row INT DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_record_credit_payment failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Payment amount must be greater than zero.';
        LEAVE PROC_BODY;
    END IF;

    IF p_payment_method = 'Cheque' AND p_pay_details IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A cheque needs its account name, account number, bank, branch and date.';
        LEAVE PROC_BODY;
    END IF;
    IF p_payment_method = 'Bank Transfer' AND p_qr_payment_id IS NULL AND p_pay_details IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A bank transfer needs its bank, account name and account number.';
        LEAVE PROC_BODY;
    END IF;

    IF LOWER(TRIM(IFNULL(p_reference_no, ''))) = 'down payment at counter' THEN
        SET p_status_code = 400;
        SET p_message = 'That reference is kept for the down payment taken at the counter; use another.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SET v_customer_id = NULL;
    SELECT customer_id, amount_due, amount_paid, payment_status, is_archived, payment_method
    INTO v_customer_id, v_final, v_paid, v_status, v_voided, v_method
    FROM sales WHERE sale_id = p_sale_id
    FOR UPDATE;

    IF v_customer_id IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Sale not found, or it has no customer to bill.';
        LEAVE PROC_BODY;
    END IF;

    IF v_voided THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = 'That sale was voided; no payment can be taken on it.';
        LEAVE PROC_BODY;
    END IF;

    IF v_method NOT IN ('Credit', 'COD') THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = 'Only Credit and COD sales take payments afterwards; this one was paid when it was rung up.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status = 'Paid' THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = 'That sale is already paid in full.';
        LEAVE PROC_BODY;
    END IF;

    IF v_paid + p_amount > v_final THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = CONCAT('Payment is larger than the balance due of ', FORMAT(v_final - v_paid, 2));
        LEAVE PROC_BODY;
    END IF;

    IF p_qr_payment_id IS NOT NULL THEN
        SELECT COUNT(*), MAX(status), MAX(sale_id), MAX(amount), MAX(wallet)
          INTO v_qr_found, v_qr_status, v_qr_sale, v_qr_amount, v_qr_wallet
        FROM qr_payments WHERE qr_payment_id = p_qr_payment_id
        FOR UPDATE;

        IF v_qr_found = 0 THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'That QR payment is not on record. Make a new QR code.';
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_status <> 'paid' THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('This QR payment has not been paid (it is ', v_qr_status, '), so nothing was recorded.');
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_sale IS NOT NULL THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('This QR payment is already recorded on OR-', LPAD(v_qr_sale, 6, '0'),
                                   '. One payment cannot pay for two things.');
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_amount <> p_amount THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('The QR payment was for ', FORMAT(v_qr_amount, 2), ' but ',
                                   FORMAT(p_amount, 2), ' is being taken now. Nothing was recorded.');
            LEAVE PROC_BODY;
        END IF;

        IF v_qr_wallet <> p_payment_method THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = CONCAT('The QR payment was made with ', v_qr_wallet, ', not ', p_payment_method,
                                   '. Nothing was recorded.');
            LEAVE PROC_BODY;
        END IF;
    END IF;

    INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method, reference_no, received_by_staff_id)
    VALUES (v_customer_id, p_sale_id, p_amount, p_payment_method, p_reference_no, p_staff_id);
    SET v_payment_row = LAST_INSERT_ID();

    IF p_payment_method = 'Bank Transfer' AND p_qr_payment_id IS NOT NULL THEN
        INSERT INTO payment_details (sale_id, payment_id, method, account_name, account_number,
                                     bank_name, qr_payment_id, created_by_staff_id)
        SELECT p_sale_id, v_payment_row, 'Bank Transfer', account_name, account_number,
               bank_name, qr_payment_id, p_staff_id
        FROM qr_payments WHERE qr_payment_id = p_qr_payment_id;
    ELSEIF p_payment_method IN ('Cheque', 'Bank Transfer') THEN
        INSERT INTO payment_details (sale_id, payment_id, method, account_name, account_number,
                                     bank_name, branch, cheque_date, created_by_staff_id)
        VALUES (p_sale_id, v_payment_row, p_payment_method,
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.accountName')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.accountNumber')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.bank')),
                JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.branch')),
                CAST(JSON_UNQUOTE(JSON_EXTRACT(p_pay_details, '$.chequeDate')) AS DATE),
                p_staff_id);
    END IF;

    IF p_qr_payment_id IS NOT NULL THEN
        UPDATE qr_payments SET sale_id = p_sale_id, error_message = NULL
        WHERE qr_payment_id = p_qr_payment_id;

        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'QR_PAYMENT_LINKED', 'PAYMENT',
                CONCAT('QR payment #', p_qr_payment_id, ' recorded on OR-', LPAD(p_sale_id, 6, '0')));
    END IF;

    UPDATE sales
    SET amount_paid = amount_paid + p_amount,
        payment_status = CASE WHEN v_paid + p_amount >= v_final THEN 'Paid' ELSE 'Partial' END
    WHERE sale_id = p_sale_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PAYMENT', 'PAYMENT', CONCAT('Sale #', p_sale_id, ' paid ', FORMAT(p_amount, 2), ' by ', p_payment_method));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = 'Payment recorded.';
END //

CREATE PROCEDURE sp_adjust_stock (
    IN p_product_id INT,
    IN p_adjustment_type VARCHAR(10),
    IN p_quantity DECIMAL(12,3),
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
    DECLARE v_size_count INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_adjust_stock failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A reason is required for every stock adjustment.';
        LEAVE PROC_BODY;
    END IF;

    IF p_quantity IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A quantity is required.';
        LEAVE PROC_BODY;
    END IF;

    IF p_adjustment_type = 'Recount' THEN
        IF p_quantity < 0 THEN
            SET p_status_code = 400;
            SET p_message = 'A recount cannot be below zero.';
            LEAVE PROC_BODY;
        END IF;
    ELSEIF p_quantity <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Add and Remove need a quantity greater than zero.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SET v_before = NULL;
    SELECT quantity_in_stock INTO v_before
    FROM inventory WHERE product_id = p_product_id FOR UPDATE;

    IF v_before IS NULL THEN
        ROLLBACK;
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
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Type must be Add, Remove, or Recount.';
        LEAVE PROC_BODY;
    END IF;

    SET v_after = v_before + v_change;

    IF v_after < 0 THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = CONCAT('That would leave stock at ', v_after, '. Only ', v_before, ' on hand.');
        LEAVE PROC_BODY;
    END IF;

    SELECT u.unit_name INTO v_current_unit
    FROM products p
    LEFT JOIN units u ON u.unit_id = p.unit_id
    WHERE p.product_id = p_product_id;

    SET v_unit = NULLIF(TRIM(IFNULL(p_unit_name, '')), '');

    IF v_unit IS NOT NULL AND v_current_unit IS NOT NULL
       AND LOWER(v_unit) <> LOWER(v_current_unit) THEN
        IF p_adjustment_type <> 'Recount' THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = 'A different unit can only be set on a Recount. Leave Counted in empty, or choose Recount.';
            LEAVE PROC_BODY;
        END IF;

        SELECT COUNT(*) INTO v_size_count FROM product_units WHERE product_id = p_product_id;
        IF v_size_count > 0 THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'This material has selling sizes set up, so its unit cannot change. Fix the selling sizes first.';
            LEAVE PROC_BODY;
        END IF;
    END IF;

    IF v_unit IS NULL THEN
        SET v_unit = v_current_unit;
    END IF;

    IF v_unit IS NOT NULL THEN
        SELECT unit_id INTO v_unit_id
        FROM units WHERE LOWER(unit_name) = LOWER(v_unit) LIMIT 1;

        IF v_unit_id IS NULL THEN
            INSERT INTO units (unit_name) VALUES (v_unit);
            SET v_unit_id = LAST_INSERT_ID();
        ELSE
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_reorder_point failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    IF p_supplier_id IS NOT NULL AND p_supplier_id > 0 THEN
        IF EXISTS (SELECT 1 FROM suppliers WHERE supplier_id = p_supplier_id) THEN
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_product_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_material failed (', @err_no, '): ', LEFT(@err_text, 180));
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
    DECLARE v_new_name VARCHAR(150);
    DECLARE v_brand VARCHAR(100);
    DECLARE v_category VARCHAR(50);
    DECLARE v_unit VARCHAR(20);
    DECLARE v_pack_name VARCHAR(20);
    DECLARE v_pack_size DECIMAL(12,3);
    DECLARE v_pack_count DECIMAL(12,3);
    DECLARE v_supplier INT;
    DECLARE v_made BOOLEAN DEFAULT FALSE;
    DECLARE v_supplier_made BOOLEAN DEFAULT FALSE;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_po_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_purchase_order failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    INSERT INTO purchase_orders (supplier_id, status, raised_by_staff_id)
    VALUES (v_supplier, 'For Approval', p_staff_id);
    SET p_po_id = LAST_INSERT_ID();

    WHILE v_i < v_count DO
        SET v_product_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_quantity   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_new_name   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].new_name'))), 'null');
        SET v_brand      = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].brand_name'))), 'null');
        SET v_category   = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].category_name'))), 'null');
        SET v_unit       = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].unit_name'))), 'null');
        SET v_pack_name  = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].pack_name'))), 'null');
        SET v_pack_size  = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].pack_size'))), 'null');
        SET v_pack_count = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items_json, CONCAT('$[', v_i, '].pack_count'))), 'null');
        IF v_pack_name IS NULL OR TRIM(v_pack_name) = '' OR v_pack_size IS NULL OR v_pack_size <= 0 THEN
            SET v_pack_name = NULL; SET v_pack_size = NULL; SET v_pack_count = NULL;
        END IF;

        IF v_quantity IS NULL OR v_quantity <= 0 THEN
            ROLLBACK;
            SET p_po_id = NULL;
            SET p_status_code = 400;
            SET p_message = 'Every line needs a quantity greater than zero.';
            LEAVE PROC_BODY;
        END IF;

        SET v_made = FALSE;
        CALL sp_ensure_material(v_new_name, v_brand, v_category, v_unit,
                                0.00, v_supplier,
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

        INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost, pack_name, pack_size, pack_count)
        VALUES (p_po_id, v_product_id, v_quantity, 0.00, v_pack_name, v_pack_size, v_pack_count);

        SET v_i = v_i + 1;
    END WHILE;

    IF v_supplier_made THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'SUPPLIER', 'CREATE',
                CONCAT('Supplier #', v_supplier, ' "', TRIM(p_supplier_name),
                       '" added while raising purchase order #', p_po_id));
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PURCHASE_ORDER', 'CREATE',
            CONCAT('PO #', p_po_id, ' raised with ', v_count, ' line(s), for the manager to confirm'));

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (2, 'Purchase Order', CONCAT('Purchase order #', p_po_id, ' waits for your confirmation'),
            CONCAT(v_count, ' line(s) to ', COALESCE(NULLIF(TRIM(p_supplier_name), ''), CONCAT('supplier #', v_supplier)),
                   '. Confirm it from Purchase Orders before it is sent.'), p_staff_id);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Purchase order #', p_po_id, ' sent to the manager to confirm',
        IF(p_new_materials > 0,
           CONCAT(', and ', p_new_materials, ' new material(s) added to the list.'), '.'));
END //

CREATE PROCEDURE sp_decide_purchase_order (
    IN p_po_id INT,
    IN p_approve BOOLEAN,
    IN p_note VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_supplier VARCHAR(100);
    DECLARE v_lines INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_decide_purchase_order failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    START TRANSACTION;

    SET v_status = NULL;
    SELECT po.status, s.supplier_name INTO v_status, v_supplier
    FROM purchase_orders po JOIN suppliers s ON s.supplier_id = po.supplier_id
    WHERE po.po_id = p_po_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Purchase order not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status <> 'For Approval' THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('This purchase order is already ', LOWER(v_status), '.');
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_lines
    FROM purchase_order_items WHERE po_id = p_po_id;

    UPDATE purchase_orders
    SET status = IF(p_approve, 'Pending', 'Cancelled'),
        confirmed_by_staff_id = p_staff_id,
        confirmed_at = NOW(),
        decision_note = NULLIF(TRIM(IFNULL(p_note, '')), '')
    WHERE po_id = p_po_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, IF(p_approve, 'PO_CONFIRMED', 'PO_DECLINED'), 'UPDATE',
            CONCAT('PO #', p_po_id, ' to ', v_supplier, ' ', IF(p_approve, 'confirmed', 'declined'),
                   IF(p_note IS NULL OR TRIM(p_note) = '', '', CONCAT(': ', TRIM(p_note)))));

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (3, 'Purchase Order',
            CONCAT('Purchase order #', p_po_id, IF(p_approve, ' confirmed', ' declined')),
            IF(p_approve,
               CONCAT(v_lines, ' line(s) to ', v_supplier,
                      '. Send it to the supplier: they set the prices when they accept it. ',
                      'Check the goods against it when they arrive.'),
               CONCAT('The manager declined the order to ', v_supplier,
                      IF(p_note IS NULL OR TRIM(p_note) = '', '.', CONCAT(': ', TRIM(p_note))))),
            p_staff_id);

    COMMIT;

    SET p_status_code = 200;
    SET p_message = IF(p_approve,
        CONCAT('Purchase order #', p_po_id, ' confirmed. It is now waiting for the delivery from ', v_supplier, '.'),
        CONCAT('Purchase order #', p_po_id, ' declined. The clerk has been told.'));
END //

CREATE PROCEDURE sp_receive_purchase_order (
    IN p_po_id INT,
    IN p_received_json JSON,
    IN p_discount DECIMAL(12,2),
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
    DECLARE v_cost DECIMAL(12,4);
    DECLARE v_unit_cost DECIMAL(12,4);
    DECLARE v_supplier INT;
    DECLARE v_made BOOLEAN DEFAULT FALSE;
    DECLARE v_short INT DEFAULT 0;

    DECLARE cur CURSOR FOR
        SELECT product_id, quantity, unit_cost FROM purchase_order_items WHERE po_id = p_po_id;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_receive_purchase_order failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    IF v_status = 'For Approval' THEN
        SET p_status_code = 400;
        SET p_message = 'This purchase order has not been confirmed by the manager yet.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status <> 'Pending' THEN
        SET p_status_code = 400;
        SET p_message = CONCAT('This purchase order is already ', LOWER(v_status), '.');
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO purchase_order_ordered_items (po_id, product_id, quantity, pack_name, pack_size, pack_count)
    SELECT po_id, product_id, quantity, pack_name, pack_size, pack_count
    FROM purchase_order_items WHERE po_id = p_po_id;

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
                                0.00, v_supplier,
                                v_json_id, v_made);

        IF v_json_id IS NOT NULL THEN
            IF v_made THEN
                INSERT INTO audit_logs (staff_id, action, action_type, details)
                VALUES (p_staff_id, 'MATERIAL', 'CREATE',
                        CONCAT('Material #', v_json_id, ' "', TRIM(IFNULL(v_new_name, '')),
                               '" added while receiving purchase order #', p_po_id));
            END IF;

            UPDATE products
            SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL
            WHERE product_id = v_json_id AND is_archived = TRUE;

            INSERT IGNORE INTO inventory (product_id, quantity_in_stock)
            VALUES (v_json_id, 0);

            IF EXISTS (SELECT 1 FROM purchase_order_items
                       WHERE po_id = p_po_id AND product_id = v_json_id) THEN
                UPDATE purchase_order_items
                SET quantity = IFNULL(v_json_qty, quantity),
                    pack_count = IF(pack_size IS NULL OR pack_size <= 0, NULL,
                                    ROUND(IFNULL(v_json_qty, quantity) / pack_size, 3))
                WHERE po_id = p_po_id AND product_id = v_json_id;
            ELSE
                IF IFNULL(v_cost, 0) <= 0 THEN
                    ROLLBACK;
                    SET p_status_code = 400;
                    SET p_message = 'A material that was not on the order needs a cost above zero.';
                    LEAVE PROC_BODY;
                END IF;

                INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost)
                VALUES (p_po_id, v_json_id, IFNULL(v_json_qty, 0), v_cost);
                SET p_extras = p_extras + 1;
            END IF;
        END IF;

        SET v_i = v_i + 1;
    END WHILE;

    OPEN cur;
    read_loop: LOOP
        FETCH cur INTO v_product_id, v_ordered, v_unit_cost;
        IF v_done = 1 THEN
            LEAVE read_loop;
        END IF;

        SET v_arrived = v_ordered;

        IF v_arrived > 0 THEN
            IF v_unit_cost > 0 THEN
                UPDATE products SET last_cost = v_unit_cost WHERE product_id = v_product_id;
            END IF;

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

            CALL sp_raise_stock_alert(v_product_id, p_staff_id);

            SET p_lines = p_lines + 1;
        ELSE
            SET v_short = v_short + 1;
        END IF;
    END LOOP;
    CLOSE cur;

    DELETE FROM purchase_order_items WHERE po_id = p_po_id AND quantity <= 0;

    UPDATE purchase_orders
    SET status = 'Received', received_at = NOW(), discount = GREATEST(IFNULL(p_discount, 0.00), 0.00)
    WHERE po_id = p_po_id;

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

CREATE PROCEDURE sp_file_return_report (
    IN p_product_id INT,
    IN p_sale_id INT,
    IN p_report_type VARCHAR(20),
    IN p_quantity DECIMAL(12,3),
    IN p_reason TEXT,
    IN p_refund_amount DECIMAL(12,2),
    IN p_disposition VARCHAR(20),
    IN p_po_id INT,
    IN p_inside_batch BOOLEAN,
    IN p_staff_id INT,
    OUT p_report_id INT,
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
    DECLARE v_missing BOOLEAN DEFAULT FALSE;
    DECLARE v_po_status VARCHAR(20);
    DECLARE v_ordered DECIMAL(12,3) DEFAULT 0;
    DECLARE v_told DECIMAL(12,3) DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_report_id = NULL;
        SET p_off_balance = 0.00;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_file_return_report failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_report_id = NULL;
    SET p_off_balance = 0.00;

    IF p_report_type NOT IN ('Return', 'Damaged', 'Refunded', 'Missing') THEN
        SET p_status_code = 400;
        SET p_message = 'Type must be Return, Damaged, Refunded, or Missing.';
        LEAVE PROC_BODY;
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'Quantity must be greater than zero.';
        LEAVE PROC_BODY;
    END IF;

    SET v_missing = (p_report_type = 'Missing');
    IF v_missing THEN
        SET p_sale_id = NULL;
        SET p_refund_amount = 0.00;
        SET p_disposition = NULL;
        IF p_po_id IS NULL THEN
            SET p_status_code = 400;
            SET p_message = 'A missing-goods report must name the purchase order.';
            LEAVE PROC_BODY;
        END IF;
    ELSE
        SET p_po_id = NULL;
    END IF;

    IF p_report_type = 'Refunded' AND p_sale_id IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A refund must be filed against a sale.';
        LEAVE PROC_BODY;
    END IF;

    IF p_refund_amount IS NOT NULL AND p_refund_amount < 0 THEN
        SET p_status_code = 400;
        SET p_message = 'The refund amount cannot be negative.';
        LEAVE PROC_BODY;
    END IF;

    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A reason is required for every report.';
        LEAVE PROC_BODY;
    END IF;

    SET v_where = NULLIF(TRIM(IFNULL(p_disposition, '')), '');

    SET v_awaiting = (v_where IS NULL AND p_report_type = 'Refunded');

    IF NOT v_awaiting AND NOT v_missing AND (v_where IS NULL OR v_where NOT IN ('Return to Stock', 'Write-Off')) THEN
        SET p_status_code = 400;
        SET p_message = 'Say where the goods go: Return to Stock, or Write-Off.';
        LEAVE PROC_BODY;
    END IF;

    SET v_restock = IFNULL(v_where = 'Return to Stock', FALSE);

    SET v_name = NULL;
    SELECT product_name INTO v_name FROM products WHERE product_id = p_product_id;

    IF v_name IS NULL THEN
        SET p_status_code = 404;
        SET p_message = 'Product not found.';
        LEAVE PROC_BODY;
    END IF;

    IF NOT p_inside_batch THEN
        START TRANSACTION;
    END IF;

    IF v_missing THEN
        SET v_po_status = NULL;
        SELECT status INTO v_po_status FROM purchase_orders WHERE po_id = p_po_id FOR UPDATE;

        IF v_po_status IS NULL THEN
            ROLLBACK;
            SET p_status_code = 404;
            SET p_message = 'That purchase order was not found.';
            LEAVE PROC_BODY;
        END IF;

        IF v_po_status <> 'Pending' THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = IF(v_po_status = 'Received',
                CONCAT('Purchase order #', p_po_id, ' is already received, so its delivery cannot be reported missing any more.'),
                CONCAT('Purchase order #', p_po_id, ' is cancelled or still waiting for the manager, so no delivery is due from it.'));
            LEAVE PROC_BODY;
        END IF;

        SELECT COALESCE(SUM(quantity), 0) INTO v_ordered
        FROM purchase_order_items WHERE po_id = p_po_id AND product_id = p_product_id;

        IF v_ordered = 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = CONCAT('That item is not on purchase order #', p_po_id, '.');
            LEAVE PROC_BODY;
        END IF;

        SELECT COALESCE(SUM(quantity), 0) INTO v_told
        FROM returned_items
        WHERE po_id = p_po_id AND product_id = p_product_id AND report_type = 'Missing';

        IF p_quantity > v_ordered - v_told + 0.0005 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = IF(v_ordered - v_told <= 0,
                CONCAT('That item is already reported missing in full on purchase order #', p_po_id, '.'),
                CONCAT('Only ', TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(v_ordered - v_told AS CHAR))),
                       ' of that item can be reported missing on purchase order #', p_po_id, '.'));
            LEAVE PROC_BODY;
        END IF;
    END IF;

    SET v_before = 0;
    SELECT COALESCE(quantity_in_stock, 0) INTO v_before
    FROM inventory WHERE product_id = p_product_id
    FOR UPDATE;

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

        IF v_voided THEN
            ROLLBACK;
            SET p_status_code = 409;
            SET p_message = 'That sale was voided; there is nothing to refund.';
            LEAVE PROC_BODY;
        END IF;

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

    IF v_missing OR v_awaiting THEN
        SET v_change = 0;
    ELSEIF v_restock THEN
        SET v_change = p_quantity;
    ELSEIF p_sale_id IS NULL THEN
        SET v_change = -LEAST(p_quantity, v_before);
    END IF;

    INSERT INTO returned_items
        (product_id, sale_id, po_id, report_type, quantity, reason, disposition,
         refund_amount, restocked, status, reported_by_staff_id)
    VALUES
        (p_product_id, p_sale_id, p_po_id, p_report_type, p_quantity, TRIM(p_reason), v_where,
         IFNULL(p_refund_amount, 0.00), v_restock, 'Open', p_staff_id);

    SET p_report_id = LAST_INSERT_ID();

    IF v_on_sale AND IFNULL(p_refund_amount, 0) > 0 THEN
        SET v_off = LEAST(p_refund_amount, GREATEST(v_due - v_paid, 0.00));

        IF v_off > 0 THEN
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

    IF NOT p_inside_batch THEN
        IF v_missing THEN
            INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
            VALUES (2, 'Purchase Order', CONCAT('Missing from delivery: ', v_name),
                    CONCAT(p_quantity, ' unit(s) did not arrive on purchase order #', p_po_id, ': ',
                           LEFT(TRIM(p_reason), 110)),
                    p_product_id, p_staff_id);
        ELSE
            SET v_notif = IF(p_report_type = 'Refunded', 'Refund Report', 'Damage Report');

            INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
            VALUES (2, v_notif, CONCAT(p_report_type, ' filed for ', v_name),
                    CONCAT(p_quantity, ' unit(s), ', IF(v_awaiting, 'awaiting the clerk''s inspection', v_where),
                           ': ', LEFT(TRIM(p_reason), 110)),
                    p_product_id, p_staff_id);
        END IF;
    END IF;

    IF v_awaiting THEN
        INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
        VALUES (3, 'Refund Report', CONCAT('Inspect ', v_name, ' returned at the counter'),
                CONCAT(p_quantity, ' unit(s) refunded, report #', p_report_id, '. Check whether it can be ',
                       'sold again: back on the shelf, or written off. ', LEFT(TRIM(p_reason), 100)),
                p_product_id, p_staff_id);
    END IF;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, UPPER(REPLACE(p_report_type, ' ', '_')), 'CREATE',
            CONCAT(v_name, ' x', p_quantity, ' (report #', p_report_id,
                   IF(v_missing, CONCAT(', purchase order #', p_po_id), ''), ')'));

    IF NOT p_inside_batch THEN
        COMMIT;
    END IF;

    IF v_change < 0 THEN
        CALL sp_raise_stock_alert(p_product_id, p_staff_id);
    END IF;

    SET p_status_code = 201;
    SET p_message = IF(v_awaiting,
        CONCAT(p_report_type, ' report filed. The goods are set aside for the stockroom to inspect.'),
        IF(v_missing, 'Missing-goods report filed.', CONCAT(p_report_type, ' report filed.')));

    IF v_on_sale THEN
        IF v_off > 0 THEN
            SET p_message = CONCAT(p_message, ' ', FORMAT(v_off, 2), ' came off what the customer owes.');
        END IF;
        IF p_refund_amount > v_off THEN
            SET p_message = CONCAT(p_message, ' ', FORMAT(p_refund_amount - v_off, 2), ' is cash to hand back.');
        END IF;
    END IF;
END //

CREATE PROCEDURE sp_file_return_reports (
    IN p_items JSON,
    IN p_sale_id INT,
    IN p_report_type VARCHAR(20),
    IN p_reason TEXT,
    IN p_disposition VARCHAR(20),
    IN p_po_id INT,
    IN p_staff_id INT,
    OUT p_report_ids VARCHAR(1000),
    OUT p_off_balance DECIMAL(12,2),
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_i INT DEFAULT 0;
    DECLARE v_product INT;
    DECLARE v_qty DECIMAL(12,3);
    DECLARE v_refund DECIMAL(12,2);
    DECLARE v_report INT;
    DECLARE v_off DECIMAL(12,2);
    DECLARE v_code INT;
    DECLARE v_text VARCHAR(255);
    DECLARE v_name VARCHAR(150);
    DECLARE v_first_product INT;
    DECLARE v_names VARCHAR(1000) DEFAULT '';
    DECLARE v_ids VARCHAR(1000) DEFAULT '';
    DECLARE v_off_total DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_refund_total DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_notif VARCHAR(20);
    DECLARE v_title VARCHAR(150);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_report_ids = NULL;
        SET p_off_balance = 0.00;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_file_return_reports failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_report_ids = NULL;
    SET p_off_balance = 0.00;

    SET v_count = IFNULL(JSON_LENGTH(p_items), 0);
    IF v_count < 1 OR v_count > 50 THEN
        SET p_status_code = 400;
        SET p_message = 'A report needs between 1 and 50 items.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    WHILE v_i < v_count DO
        SET v_product = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items, CONCAT('$[', v_i, '].product_id'))), 'null');
        SET v_qty     = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items, CONCAT('$[', v_i, '].quantity'))), 'null');
        SET v_refund  = IFNULL(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p_items, CONCAT('$[', v_i, '].refund_amount'))), 'null'), 0);

        CALL sp_file_return_report(v_product, p_sale_id, p_report_type, v_qty, p_reason, v_refund,
                                   p_disposition, p_po_id, TRUE, p_staff_id,
                                   v_report, v_off, v_code, v_text);

        IF v_code <> 201 THEN
            ROLLBACK;
            SET v_name = NULL;
            SELECT product_name INTO v_name FROM products WHERE product_id = v_product;
            SET p_status_code = v_code;
            SET p_message = LEFT(CONCAT(IFNULL(CONCAT(v_name, ': '), ''), v_text,
                                        ' Nothing was filed.'), 255);
            LEAVE PROC_BODY;
        END IF;

        IF v_i = 0 THEN
            SET v_first_product = v_product;
        END IF;
        SET v_ids = CONCAT(v_ids, IF(v_i = 0, '', ','), v_report);
        SET v_off_total = v_off_total + v_off;
        SET v_refund_total = v_refund_total + IF(p_report_type = 'Refunded', v_refund, 0);
        SET v_name = NULL;
        SELECT product_name INTO v_name FROM products WHERE product_id = v_product;
        IF CHAR_LENGTH(v_names) < 150 THEN
            SET v_names = CONCAT(v_names, IF(v_i = 0, '', ', '), LEFT(v_name, 60), ' x',
                              TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(v_qty AS CHAR))));
        END IF;

        SET v_i = v_i + 1;
    END WHILE;

    IF p_report_type = 'Missing' THEN
        SET v_notif = 'Purchase Order';
        SET v_title = CONCAT('Missing from delivery: purchase order #', p_po_id);
    ELSE
        SET v_notif = IF(p_report_type = 'Refunded', 'Refund Report', 'Damage Report');
        SET v_title = CONCAT(p_report_type, ' filed for ', v_count, ' item(s)');
    END IF;

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (2, v_notif, v_title,
            CONCAT(LEFT(v_names, 150), IF(CHAR_LENGTH(v_names) >= 150, ' and more', ''), '. ',
                   LEFT(TRIM(p_reason), 70)),
            IF(v_count = 1, v_first_product, NULL), p_staff_id);

    COMMIT;

    SET p_report_ids = v_ids;
    SET p_off_balance = v_off_total;
    SET p_status_code = 201;
    SET p_message = IF(p_report_type = 'Missing',
        CONCAT('Missing-goods report filed for ', v_count, ' item(s) on purchase order #', p_po_id, '.'),
        CONCAT(p_report_type, ' report filed for ', v_count, ' item(s).'));
    IF v_off_total > 0 THEN
        SET p_message = CONCAT(p_message, ' ', FORMAT(v_off_total, 2), ' came off what the customer owes.');
    END IF;
    IF v_refund_total > v_off_total THEN
        SET p_message = CONCAT(p_message, ' ', FORMAT(v_refund_total - v_off_total, 2), ' is cash to hand back.');
    END IF;
END //

CREATE PROCEDURE sp_resolve_return_report (
    IN p_report_id INT,
    IN p_disposition VARCHAR(20),
    IN p_note VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_where VARCHAR(20);
    DECLARE v_verdict VARCHAR(20);
    DECLARE v_product_id INT;
    DECLARE v_sale_id INT;
    DECLARE v_quantity DECIMAL(12,3);
    DECLARE v_type VARCHAR(20);
    DECLARE v_name VARCHAR(150);
    DECLARE v_before DECIMAL(12,3) DEFAULT 0;
    DECLARE v_change DECIMAL(12,3) DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_resolve_return_report failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    START TRANSACTION;

    SET v_status = NULL;
    SELECT r.status, r.disposition, r.product_id, r.sale_id, r.quantity, r.report_type, p.product_name
    INTO v_status, v_where, v_product_id, v_sale_id, v_quantity, v_type, v_name
    FROM returned_items r
    JOIN products p ON p.product_id = r.product_id
    WHERE r.return_id = p_report_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Report not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status = 'Resolved' THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'That report is already resolved.';
        LEAVE PROC_BODY;
    END IF;

    SET v_verdict = NULLIF(TRIM(IFNULL(p_disposition, '')), '');

    IF v_where IS NOT NULL OR v_type = 'Missing' THEN
        UPDATE returned_items
        SET status = 'Resolved',
            inspected_by_staff_id = p_staff_id,
            inspected_at = NOW(),
            inspection_note = NULLIF(TRIM(IFNULL(p_note, '')), '')
        WHERE return_id = p_report_id AND status = 'Open';

        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, 'REPORT_RESOLVED', 'UPDATE', CONCAT('Report #', p_report_id));

        COMMIT;

        SET p_status_code = 200;
        SET p_message = 'Report marked resolved.';
        LEAVE PROC_BODY;
    END IF;

    IF v_verdict IS NULL OR v_verdict NOT IN ('Return to Stock', 'Write-Off') THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = 'Say what the inspection found: Return to Stock if it can be sold again, or Write-Off if not.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COALESCE(quantity_in_stock, 0) INTO v_before
    FROM inventory WHERE product_id = v_product_id
    FOR UPDATE;

    IF v_verdict = 'Return to Stock' THEN
        SET v_change = v_quantity;
    ELSEIF v_sale_id IS NULL THEN
        SET v_change = -LEAST(v_quantity, v_before);
    END IF;

    IF v_change <> 0 THEN
        UPDATE inventory
        SET quantity_in_stock = v_before + v_change
        WHERE product_id = v_product_id;

        INSERT INTO stock_adjustments
            (product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, adjusted_by_staff_id)
        VALUES
            (v_product_id, IF(v_change > 0, 'Add', 'Remove'), v_before, v_change, v_before + v_change,
             CONCAT(v_type, ' report #', p_report_id, ' inspected: ', v_verdict,
                    IF(p_note IS NULL OR TRIM(p_note) = '', '', CONCAT(' - ', LEFT(TRIM(p_note), 110)))),
             p_staff_id);
    END IF;

    UPDATE returned_items
    SET disposition = v_verdict,
        restocked = (v_verdict = 'Return to Stock'),
        status = 'Resolved',
        inspected_by_staff_id = p_staff_id,
        inspected_at = NOW(),
        inspection_note = NULLIF(TRIM(IFNULL(p_note, '')), '')
    WHERE return_id = p_report_id AND status = 'Open';

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'REPORT_INSPECTED', 'UPDATE',
            CONCAT('Report #', p_report_id, ' (', v_name, ' x', v_quantity, '): ', v_verdict,
                   IF(p_note IS NULL OR TRIM(p_note) = '', '', CONCAT(' - ', LEFT(TRIM(p_note), 120)))));

    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (2, 'Refund Report',
            CONCAT(v_name, IF(v_verdict = 'Return to Stock', ' inspected: back on the shelf', ' inspected: written off')),
            CONCAT('Report #', p_report_id, ', ', v_quantity, ' unit(s). ',
                   IF(v_verdict = 'Return to Stock', 'Sellable, stock is up by that much.', 'Not sellable.'),
                   IF(p_note IS NULL OR TRIM(p_note) = '', '', CONCAT(' ', LEFT(TRIM(p_note), 100)))),
            v_product_id, p_staff_id);
    INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id)
    VALUES (4, 'Refund Report',
            CONCAT(v_name, IF(v_verdict = 'Return to Stock', ' inspected: back on the shelf', ' inspected: written off')),
            CONCAT('Report #', p_report_id, ' from the counter has been checked by the stockroom. ',
                   IF(v_verdict = 'Return to Stock', 'It can be sold again.', 'It cannot be sold again.')),
            v_product_id, p_staff_id);

    COMMIT;

    IF v_change < 0 THEN
        CALL sp_raise_stock_alert(v_product_id, p_staff_id);
    END IF;

    SET p_status_code = 200;
    SET p_message = IF(v_verdict = 'Return to Stock',
        CONCAT(v_name, ' is back on the shelf: stock up by ', v_quantity, '.'),
        CONCAT(v_name, ' is written off. It does not go back on the shelf.'));
END //

CREATE PROCEDURE sp_create_delivery (
    IN p_sale_id INT,
    IN p_address TEXT,
    IN p_scheduled_date DATETIME,
    IN p_remarks TEXT,
    IN p_contact_name VARCHAR(150),
    IN p_contact_phone VARCHAR(30),
    IN p_created_date DATE,
    IN p_staff_id INT,
    IN p_driver_staff_id INT,
    OUT p_delivery_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_voided BOOLEAN DEFAULT NULL;
    DECLARE v_already INT DEFAULT 0;
    DECLARE v_driver_ok INT DEFAULT 0;
    DECLARE v_contact_name VARCHAR(150) DEFAULT NULL;
    DECLARE v_contact_phone VARCHAR(30) DEFAULT NULL;
    DECLARE v_created DATE DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_delivery_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_delivery failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_delivery_id = NULL;

    IF p_address IS NULL OR TRIM(p_address) = '' THEN
        SET p_status_code = 400;
        SET p_message = 'A delivery address is required.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SELECT is_archived INTO v_voided FROM sales WHERE sale_id = p_sale_id FOR UPDATE;

    IF v_voided IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That sale does not exist.';
        LEAVE PROC_BODY;
    END IF;

    IF v_voided THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = 'That sale was voided; there is nothing to deliver.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_already FROM deliveries WHERE sale_id = p_sale_id AND is_archived = FALSE;

    IF v_already > 0 THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = 'This sale already has a delivery.';
        LEAVE PROC_BODY;
    END IF;

    IF p_driver_staff_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_driver_ok
        FROM staff st
        JOIN roles r ON r.role_id = st.role_id
        WHERE st.staff_id = p_driver_staff_id AND r.role_name = 'Delivery Personnel'
          AND st.is_active = TRUE AND st.archived_at IS NULL;

        IF v_driver_ok = 0 THEN
            ROLLBACK;
            SET p_status_code = 400;
            SET p_message = 'That driver is not an active delivery staff member.';
            LEAVE PROC_BODY;
        END IF;
    END IF;

    SET v_created = IFNULL(p_created_date, CURDATE());
    SET v_contact_name  = NULLIF(TRIM(IFNULL(p_contact_name, '')), '');
    SET v_contact_phone = NULLIF(TRIM(IFNULL(p_contact_phone, '')), '');

    IF v_contact_name IS NULL THEN
        SELECT COALESCE(NULLIF(c.full_name, ''),
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

    INSERT INTO deliveries (sale_id, delivery_staff_id, delivery_address, contact_name, contact_phone,
                            status, remarks, cashier_remarks, created_date, scheduled_date)
    VALUES (p_sale_id, p_driver_staff_id, p_address, v_contact_name, v_contact_phone,
            'Pending', p_remarks, p_remarks, v_created, p_scheduled_date);

    SET p_delivery_id = LAST_INSERT_ID();

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'DELIVERY_CREATED', 'CREATE', CONCAT('Delivery #', p_delivery_id, ' for sale #', p_sale_id));

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (5, 'Delivery', CONCAT('Delivery #', p_delivery_id, ' created'),
            CONCAT('Sale #', p_sale_id, ' needs delivering to ', LEFT(p_address, 90)), p_staff_id);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Delivery #', p_delivery_id, ' created.');
END //

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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_update_delivery_status failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_status NOT IN ('Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed', 'Failed') THEN
        SET p_status_code = 400;
        SET p_message = 'That is not a valid delivery status.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SET v_current = NULL;
    SELECT status INTO v_current FROM deliveries
    WHERE delivery_id = p_delivery_id AND is_archived = FALSE
    FOR UPDATE;

    IF v_current IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Delivery not found.';
        LEAVE PROC_BODY;
    END IF;

    IF v_current = p_status THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = CONCAT('This delivery is already marked ', p_status, '.');
        LEAVE PROC_BODY;
    END IF;

    IF v_current = 'Delivered' THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('Delivery #', p_delivery_id,
                               ' is already delivered and cannot be reopened.');
        LEAVE PROC_BODY;
    END IF;

    IF p_status = 'Delivered' AND p_role_id <> 5 THEN
        ROLLBACK;
        SET p_status_code = 403;
        SET p_message = 'Only delivery personnel can mark an order Delivered.';
        LEAVE PROC_BODY;
    END IF;

    IF p_role_id NOT IN (2, 5) THEN
        ROLLBACK;
        SET p_status_code = 403;
        SET p_message = 'Your role cannot change a delivery status.';
        LEAVE PROC_BODY;
    END IF;

    SET v_allowed =
        CASE v_current
            WHEN 'Pending'          THEN p_status IN ('In Transit')
            WHEN 'In Transit'       THEN p_status IN ('Out for Delivery')
            WHEN 'Out for Delivery' THEN p_status IN ('Delivered', 'Delayed', 'Failed')
            WHEN 'Delayed'          THEN p_status IN ('Out for Delivery', 'Failed')
            WHEN 'Failed'           THEN p_status IN ('Pending')
            ELSE 0
        END;

    IF v_allowed = 0 THEN
        ROLLBACK;
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

    COMMIT;

    SET p_status_code = 200;
    SET p_message = CONCAT('Delivery #', p_delivery_id, ' marked ', p_status, '.');
END //

CREATE PROCEDURE sp_set_credit_limit (
    IN p_customer_id INT,
    IN p_credit_limit DECIMAL(12,2),
    IN p_standing VARCHAR(10),
    IN p_penalty_rate DECIMAL(5,2),
    IN p_notes VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_customer_count INT DEFAULT 0;
    DECLARE v_owed DECIMAL(12,2) DEFAULT 0.00;
    DECLARE v_name VARCHAR(220);
    DECLARE v_shop_rate DECIMAL(5,2) DEFAULT 3.00;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_credit_limit failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    IF p_penalty_rate IS NOT NULL AND (p_penalty_rate < 1 OR p_penalty_rate > 3) THEN
        SET p_status_code = 400;
        SET p_message = 'A late-payment rate is 1 to 3 percent a month. Leave it blank for the shop''s rate.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_customer_count FROM customers WHERE customer_id = p_customer_id;
    IF v_customer_count = 0 THEN
        SET p_status_code = 404;
        SET p_message = 'Customer not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT full_name INTO v_name
    FROM customers WHERE customer_id = p_customer_id;

    SELECT current_credit INTO v_owed
    FROM vw_customer_credit WHERE customer_id = p_customer_id;

    SELECT penalty_rate INTO v_shop_rate FROM store_settings WHERE setting_id = 1;

    START TRANSACTION;

    INSERT INTO customer_credits (customer_id, credit_limit, standing, penalty_rate, notes, updated_by_staff_id)
    VALUES (p_customer_id, p_credit_limit, p_standing, p_penalty_rate,
            NULLIF(TRIM(IFNULL(p_notes, '')), ''), p_staff_id)
    ON DUPLICATE KEY UPDATE
        credit_limit = p_credit_limit,
        standing = p_standing,
        penalty_rate = p_penalty_rate,
        notes = NULLIF(TRIM(IFNULL(p_notes, '')), ''),
        updated_by_staff_id = p_staff_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'CREDIT_LIMIT', 'UPDATE',
            CONCAT(v_name, ': limit ', FORMAT(p_credit_limit, 2), ', standing ', p_standing,
                   ', late-payment rate ',
                   IF(p_penalty_rate IS NULL, CONCAT('the shop''s ', FORMAT(v_shop_rate, 2), '% a month'),
                      CONCAT(FORMAT(p_penalty_rate, 2), '% a month'))));

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
    DECLARE v_name VARCHAR(220);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_request_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_request_credit_extension failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_request_id = NULL;

    START TRANSACTION;

    SET v_name = NULL;
    SELECT full_name INTO v_name
    FROM customers WHERE customer_id = p_customer_id
    FOR UPDATE;

    IF v_name IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'Customer not found.';
        LEAVE PROC_BODY;
    END IF;

    SELECT COALESCE(credit_limit, 0.00) INTO v_current_limit
    FROM vw_customer_credit WHERE customer_id = p_customer_id;

    IF p_requested_limit IS NULL OR p_requested_limit <= v_current_limit THEN
        ROLLBACK;
        SET p_status_code = 400;
        SET p_message = CONCAT('The requested limit has to be more than the current ',
                               FORMAT(v_current_limit, 2), '.');
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_pending
    FROM credit_requests
    WHERE customer_id = p_customer_id AND status = 'Pending';

    IF v_pending > 0 THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('A request for ', v_name, ' is already waiting for a manager. ',
                               'Adding another would not make it arrive sooner.');
        LEAVE PROC_BODY;
    END IF;

    INSERT INTO credit_requests (customer_id, previous_limit, requested_limit,
                                 reason, requested_by_staff_id)
    VALUES (p_customer_id, v_current_limit, p_requested_limit,
            NULLIF(TRIM(IFNULL(p_reason, '')), ''), p_staff_id);

    SET p_request_id = LAST_INSERT_ID();

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (2, 'Credit Request',
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_decide_credit_request failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    START TRANSACTION;

    SET v_status = NULL;
    SELECT status, customer_id, requested_limit
    INTO v_status, v_customer_id, v_requested
    FROM credit_requests WHERE request_id = p_request_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That request no longer exists.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status <> 'Pending' THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('This request was already ', LOWER(v_status),
                               '. Raise a new one to change the limit again.');
        LEAVE PROC_BODY;
    END IF;

    SELECT full_name INTO v_name
    FROM customers WHERE customer_id = v_customer_id;

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

CREATE PROCEDURE sp_create_customer (
    IN p_first_name VARCHAR(100),
    IN p_middle_name VARCHAR(100),
    IN p_last_name VARCHAR(100),
    IN p_phone VARCHAR(20),
    IN p_address TEXT,
    IN p_address_street VARCHAR(150),
    IN p_address_barangay VARCHAR(100),
    IN p_address_city VARCHAR(100),
    IN p_address_province VARCHAR(100),
    IN p_address_landmark VARCHAR(150),
    IN p_staff_id INT,
    OUT p_customer_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_first VARCHAR(100);
    DECLARE v_middle VARCHAR(100);
    DECLARE v_last VARCHAR(100);
    DECLARE v_phone VARCHAR(20);
    DECLARE v_address TEXT;
    DECLARE v_existing INT DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_customer_id = NULL;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_customer failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_customer_id = NULL;
    SET v_first   = NULLIF(TRIM(IFNULL(p_first_name, '')), '');
    SET v_middle  = NULLIF(TRIM(IFNULL(p_middle_name, '')), '');
    SET v_last    = NULLIF(TRIM(IFNULL(p_last_name, '')), '');
    SET v_phone   = NULLIF(TRIM(IFNULL(p_phone, '')), '');
    SET v_address = NULLIF(TRIM(IFNULL(p_address, '')), '');

    IF v_first IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'A customer needs at least a first name.';
        LEAVE PROC_BODY;
    END IF;

    IF v_last IS NULL THEN
        SET v_last = '';
    END IF;

    SELECT customer_id INTO v_existing
    FROM customers
    WHERE LOWER(TRIM(first_name)) = LOWER(v_first)
      AND LOWER(TRIM(IFNULL(middle_name, ''))) = LOWER(IFNULL(v_middle, ''))
      AND LOWER(TRIM(IFNULL(last_name, ''))) = LOWER(v_last)
      AND ((v_phone IS NULL AND (phone IS NULL OR TRIM(phone) = ''))
           OR TRIM(IFNULL(phone, '')) = v_phone)
    ORDER BY customer_id
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
        SET p_customer_id = v_existing;
        SET p_status_code = 200;

        SELECT CONCAT(full_name, ' already has an account. This sale was attached to it.')
        INTO p_message
        FROM customers WHERE customer_id = v_existing;

        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO customers (first_name, middle_name, last_name, phone, address,
                           address_street, address_barangay, address_city,
                           address_province, address_landmark)
    VALUES (v_first, v_middle, v_last, v_phone, v_address,
            NULLIF(TRIM(IFNULL(p_address_street, '')), ''),
            NULLIF(TRIM(IFNULL(p_address_barangay, '')), ''),
            NULLIF(TRIM(IFNULL(p_address_city, '')), ''),
            NULLIF(TRIM(IFNULL(p_address_province, '')), ''),
            NULLIF(TRIM(IFNULL(p_address_landmark, '')), ''));

    SET p_customer_id = LAST_INSERT_ID();

    INSERT INTO customer_credits (customer_id, credit_limit, standing, updated_by_staff_id)
    VALUES (p_customer_id, 5000.00, 'Good', p_staff_id);

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    SELECT p_staff_id, 'CUSTOMER_CREATED', 'CREATE',
           CONCAT('Customer #', p_customer_id, ' ', full_name,
                  ' opened at the counter with a starting credit limit of 5,000.00')
    FROM customers WHERE customer_id = p_customer_id;

    COMMIT;

    SET p_status_code = 201;
    SELECT CONCAT(full_name, ' now has an account with a starting credit limit of 5,000.00.')
    INTO p_message
    FROM customers WHERE customer_id = p_customer_id;
END //

CREATE PROCEDURE sp_update_store_settings (
    IN p_store_name VARCHAR(150),
    IN p_proprietor VARCHAR(150),
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_update_store_settings failed (', @err_no, '): ', LEFT(@err_text, 180));
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

    INSERT INTO store_settings (setting_id, store_name, proprietor, address, tin,
                                registration_type, vat_rate, invoice_note,
                                updated_by_staff_id)
    VALUES (1, v_name, NULLIF(TRIM(IFNULL(p_proprietor, '')), ''), v_address, v_tin, v_type, v_rate,
            NULLIF(TRIM(IFNULL(p_invoice_note, '')), ''), p_staff_id)
    ON DUPLICATE KEY UPDATE
        store_name = v_name,
        proprietor = NULLIF(TRIM(IFNULL(p_proprietor, '')), ''),
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
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_rename_unit failed (', @err_no, '): ', LEFT(@err_text, 180));
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

CREATE PROCEDURE sp_set_penalty_policy (
    IN p_penalty_rate DECIMAL(5,2),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_old_rate DECIMAL(5,2) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_penalty_policy failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    IF p_penalty_rate IS NULL OR p_penalty_rate < 1 OR p_penalty_rate > 3 THEN
        SET p_status_code = 400;
        SET p_message = 'The late-payment rate is 1 to 3 percent a month. The default is 3.';
        LEAVE PROC_BODY;
    END IF;

    SELECT penalty_rate INTO v_old_rate FROM store_settings WHERE setting_id = 1;

    START TRANSACTION;

    INSERT INTO store_settings (setting_id, penalty_rate, updated_by_staff_id)
    VALUES (1, p_penalty_rate, p_staff_id)
    ON DUPLICATE KEY UPDATE
        penalty_rate = p_penalty_rate,
        updated_by_staff_id = p_staff_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'PENALTY_POLICY', 'UPDATE',
            CONCAT('Late-payment penalty set to ', FORMAT(p_penalty_rate, 2), '% a month of the unpaid balance',
                   IF(v_old_rate IS NULL OR v_old_rate = p_penalty_rate, '',
                      CONCAT(' (was ', FORMAT(v_old_rate, 2), '%)'))));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = CONCAT('Saved. A credit sale past its due date is now charged ',
                           FORMAT(p_penalty_rate, 2), '% of what is still unpaid on it, every month it stays overdue.');
END //

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
               c.full_name,
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
          AND CEILING(DATEDIFF(CURDATE(), DATE_ADD(DATE(s.sale_date), INTERVAL 30 DAY)) / 30) > s.penalty_months;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
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

CREATE PROCEDURE sp_sweep_archives (
    OUT p_deliveries INT,
    OUT p_materials INT
)
BEGIN
    DECLARE v_staff INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_deliveries = -1;
        SET p_materials = -1;
    END;

    START TRANSACTION;

    SET p_deliveries = 0;

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

    UPDATE staff
    SET archived_at = NOW(), archived_by_staff_id = NULL
    WHERE is_active = FALSE AND archived_at IS NULL
      AND deactivated_at IS NOT NULL AND deactivated_at <= DATE_SUB(NOW(), INTERVAL 30 DAY);
    SET v_staff = ROW_COUNT();

    IF v_staff > 0 THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (NULL, 'ARCHIVE_SWEEP', 'DELETE',
                CONCAT('Archived ', v_staff, ' staff ', IF(v_staff = 1, 'account', 'accounts'),
                       ' deactivated for 30 days'));
    END IF;

    IF p_materials > 0 THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (NULL, 'ARCHIVE_SWEEP', 'DELETE',
                CONCAT('Archived ', p_materials, ' materials with no stock and no movement in 180 days ',
                       '(deliveries are never archived)'));
    END IF;

    COMMIT;
END //

CREATE PROCEDURE sp_update_store_bank_details (
    IN p_bank_name VARCHAR(100),
    IN p_account_name VARCHAR(150),
    IN p_account_number VARCHAR(50),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_bank VARCHAR(100);
    DECLARE v_name VARCHAR(150);
    DECLARE v_number VARCHAR(50);
    DECLARE v_filled INT DEFAULT 0;
    DECLARE v_old_bank VARCHAR(100) DEFAULT NULL;
    DECLARE v_old_number VARCHAR(50) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_update_store_bank_details failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET v_bank = NULLIF(TRIM(IFNULL(p_bank_name, '')), '');
    SET v_name = NULLIF(TRIM(IFNULL(p_account_name, '')), '');
    SET v_number = NULLIF(TRIM(IFNULL(p_account_number, '')), '');
    SET v_filled = (v_bank IS NOT NULL) + (v_name IS NOT NULL) + (v_number IS NOT NULL);

    IF v_filled NOT IN (0, 3) THEN
        SET p_status_code = 400;
        SET p_message = 'Give the bank, the account name and the account number together, or leave all three empty.';
        LEAVE PROC_BODY;
    END IF;

    SELECT bank_name, bank_account_number INTO v_old_bank, v_old_number
    FROM store_settings WHERE setting_id = 1;

    START TRANSACTION;

    INSERT INTO store_settings (setting_id, bank_name, bank_account_name, bank_account_number,
                                updated_by_staff_id)
    VALUES (1, v_bank, v_name, v_number, p_staff_id)
    ON DUPLICATE KEY UPDATE
        bank_name = v_bank,
        bank_account_name = v_name,
        bank_account_number = v_number,
        updated_by_staff_id = p_staff_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'STORE_BANK_DETAILS_UPDATED', 'UPDATE',
            IF(v_filled = 0,
               CONCAT('Bank transfer details cleared',
                      IF(v_old_bank IS NULL, '', CONCAT(' (was ', v_old_bank, ')'))),
               CONCAT('Bank transfers now go to ', v_bank, ', ', v_name, ', account ending ',
                      RIGHT(REPLACE(REPLACE(v_number, ' ', ''), '-', ''), 4),
                      IF(v_old_bank IS NULL, '',
                         CONCAT(' (was ', v_old_bank, ', ending ',
                                RIGHT(REPLACE(REPLACE(IFNULL(v_old_number, ''), ' ', ''), '-', ''), 4), ')')))));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = IF(v_filled = 0,
        'No bank account is on file now, so the till says so when Bank Transfer is chosen.',
        CONCAT('Bank transfers now go to ', v_bank, '. The till and the invoice show the account.'));
END //

CREATE PROCEDURE sp_set_sale_reference (
    IN p_sale_id INT,
    IN p_reference_no VARCHAR(60),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_reference VARCHAR(60);
    DECLARE v_found INT DEFAULT 0;
    DECLARE v_existing VARCHAR(60) DEFAULT NULL;
    DECLARE v_method VARCHAR(30) DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_sale_reference failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET v_reference = NULLIF(TRIM(IFNULL(p_reference_no, '')), '');

    IF v_reference IS NULL THEN
        SET p_status_code = 400;
        SET p_message = 'There is no reference to save.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SELECT COUNT(*), MAX(NULLIF(TRIM(reference_no), '')), MAX(payment_method)
      INTO v_found, v_existing, v_method
    FROM sales WHERE sale_id = p_sale_id
    FOR UPDATE;

    IF v_found = 0 THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That sale does not exist.';
        LEAVE PROC_BODY;
    END IF;

    IF v_existing IS NOT NULL THEN
        ROLLBACK;
        IF v_existing = v_reference THEN
            SET p_status_code = 200;
            SET p_message = 'The sale already carries that reference.';
        ELSE
            SET p_status_code = 409;
            SET p_message = CONCAT('Sale #', p_sale_id, ' already carries reference ', v_existing,
                                   '. It is not overwritten.');
        END IF;
        LEAVE PROC_BODY;
    END IF;

    UPDATE sales SET reference_no = v_reference WHERE sale_id = p_sale_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'SALE_REFERENCE_SET', 'PAYMENT',
            CONCAT('Sale #', p_sale_id, ' (', v_method, ') recorded with reference ', v_reference));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = CONCAT('Reference ', v_reference, ' saved on the sale.');
END //

CREATE PROCEDURE sp_create_qr_payment (
    IN p_provider VARCHAR(10),
    IN p_mode VARCHAR(10),
    IN p_provider_intent_id VARCHAR(80),
    IN p_amount DECIMAL(12,2),
    IN p_wallet VARCHAR(20),
    IN p_purpose VARCHAR(20),
    IN p_seconds INT,
    IN p_staff_id INT,
    IN p_note VARCHAR(150),
    IN p_bank_code VARCHAR(20),
    IN p_bank_name VARCHAR(80),
    IN p_account_name VARCHAR(100),
    IN p_account_number VARCHAR(30),
    OUT p_qr_payment_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_create_qr_payment failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_qr_payment_id = NULL;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        SET p_status_code = 400;
        SET p_message = 'A QR payment needs an amount above zero.';
        LEAVE PROC_BODY;
    END IF;

    IF p_wallet NOT IN ('GCash', 'PayMaya', 'Bank Transfer') THEN
        SET p_status_code = 400;
        SET p_message = 'Only GCash, Maya and bank transfers can be paid by QR code.';
        LEAVE PROC_BODY;
    END IF;

    IF p_wallet = 'Bank Transfer' AND (p_bank_code IS NULL OR p_bank_name IS NULL
       OR p_account_name IS NULL OR p_account_number IS NULL) THEN
        SET p_status_code = 400;
        SET p_message = 'A bank transfer needs the bank, the account name and the account number.';
        LEAVE PROC_BODY;
    END IF;

    IF p_purpose NOT IN ('sale', 'credit_payment') THEN
        SET p_status_code = 400;
        SET p_message = 'A QR payment is either for a sale or for a payment on a balance.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    INSERT INTO qr_payments
        (provider, mode, provider_intent_id, amount, wallet, bank_code, bank_name,
         account_name, account_number, purpose, status, created_by_staff_id, expires_at)
    VALUES
        (p_provider, p_mode, p_provider_intent_id, p_amount, p_wallet, p_bank_code, p_bank_name,
         p_account_name, p_account_number, p_purpose, 'pending',
         p_staff_id, NOW() + INTERVAL GREATEST(IFNULL(p_seconds, 600), 1) SECOND);

    SET p_qr_payment_id = LAST_INSERT_ID();

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'QR_PAYMENT_CREATED', 'PAYMENT',
            CONCAT('QR payment #', p_qr_payment_id, ' made: ', p_wallet,
                   IFNULL(CONCAT(' (', p_bank_name, ')'), ''), ' ', FORMAT(p_amount, 2),
                   IFNULL(CONCAT(' ', p_note), ''), ' (', p_provider, ', ', p_mode, ')'));

    COMMIT;

    SET p_status_code = 201;
    SET p_message = 'QR code ready.';
END //

CREATE PROCEDURE sp_set_qr_payment_result (
    IN p_qr_payment_id INT,
    IN p_status VARCHAR(12),
    IN p_provider_payment_id VARCHAR(80),
    IN p_error_message VARCHAR(255),
    IN p_staff_id INT,
    OUT p_changed BOOLEAN,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_found INT DEFAULT 0;
    DECLARE v_status VARCHAR(12) DEFAULT NULL;
    DECLARE v_error VARCHAR(255) DEFAULT NULL;
    DECLARE v_wallet VARCHAR(20) DEFAULT NULL;
    DECLARE v_amount DECIMAL(12,2) DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_changed = FALSE;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_set_qr_payment_result failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    SET p_changed = FALSE;

    IF p_status NOT IN ('paid', 'failed', 'expired', 'cancelled') THEN
        SET p_status_code = 400;
        SET p_message = 'A QR payment ends as paid, failed, expired or cancelled.';
        LEAVE PROC_BODY;
    END IF;

    START TRANSACTION;

    SELECT COUNT(*), MAX(status), MAX(error_message), MAX(wallet), MAX(amount)
      INTO v_found, v_status, v_error, v_wallet, v_amount
    FROM qr_payments WHERE qr_payment_id = p_qr_payment_id
    FOR UPDATE;

    IF v_found = 0 THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That QR payment does not exist.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status = 'pending' OR (p_status = 'paid' AND v_status <> 'paid') THEN
        UPDATE qr_payments
        SET status = p_status,
            provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
            error_message = p_error_message,
            paid_at = IF(p_status = 'paid', NOW(), paid_at),
            closed_at = NOW()
        WHERE qr_payment_id = p_qr_payment_id;
        SET p_changed = TRUE;
    ELSEIF v_status = p_status THEN
        IF p_error_message IS NOT NULL AND NOT (v_error <=> p_error_message) THEN
            UPDATE qr_payments
            SET error_message = p_error_message,
                provider_payment_id = COALESCE(provider_payment_id, p_provider_payment_id)
            WHERE qr_payment_id = p_qr_payment_id;
            SET p_changed = TRUE;
        END IF;
    ELSE
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('This QR payment is already ', v_status, ', so it cannot be ', p_status, ' now.');
        LEAVE PROC_BODY;
    END IF;

    IF p_changed THEN
        INSERT INTO audit_logs (staff_id, action, action_type, details)
        VALUES (p_staff_id, CONCAT('QR_PAYMENT_', UPPER(p_status)), 'PAYMENT',
                CONCAT('QR payment #', p_qr_payment_id, ' (', v_wallet, ' ', FORMAT(v_amount, 2), ') ',
                       IF(v_status = p_status, CONCAT('still ', p_status), p_status),
                       IFNULL(CONCAT(': ', p_error_message), '')));
    END IF;

    COMMIT;

    SET p_status_code = 200;
    SET p_message = CONCAT('The QR payment is ', p_status, '.');
END //

CREATE PROCEDURE sp_link_qr_payment_to_sale (
    IN p_qr_payment_id INT,
    IN p_sale_id INT,
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_found INT DEFAULT 0;
    DECLARE v_status VARCHAR(12) DEFAULT NULL;
    DECLARE v_sale INT DEFAULT NULL;
    DECLARE v_sale_found INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @err_no = MYSQL_ERRNO, @err_text = MESSAGE_TEXT;
        ROLLBACK;
        SET p_status_code = 500;
        SET p_message = CONCAT('sp_link_qr_payment_to_sale failed (', @err_no, '): ', LEFT(@err_text, 180));
    END;

    START TRANSACTION;

    SELECT COUNT(*), MAX(status), MAX(sale_id)
      INTO v_found, v_status, v_sale
    FROM qr_payments WHERE qr_payment_id = p_qr_payment_id
    FOR UPDATE;

    IF v_found = 0 THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That QR payment does not exist.';
        LEAVE PROC_BODY;
    END IF;

    IF v_status <> 'paid' THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('This QR payment is ', v_status, ', not paid.');
        LEAVE PROC_BODY;
    END IF;

    IF v_sale IS NOT NULL THEN
        ROLLBACK;
        SET p_status_code = 409;
        SET p_message = CONCAT('This QR payment is already recorded on OR-', LPAD(v_sale, 6, '0'), '.');
        LEAVE PROC_BODY;
    END IF;

    SELECT COUNT(*) INTO v_sale_found FROM sales WHERE sale_id = p_sale_id;
    IF v_sale_found = 0 THEN
        ROLLBACK;
        SET p_status_code = 404;
        SET p_message = 'That sale does not exist.';
        LEAVE PROC_BODY;
    END IF;

    UPDATE qr_payments SET sale_id = p_sale_id, error_message = NULL
    WHERE qr_payment_id = p_qr_payment_id;

    INSERT INTO audit_logs (staff_id, action, action_type, details)
    VALUES (p_staff_id, 'QR_PAYMENT_LINKED', 'PAYMENT',
            CONCAT('QR payment #', p_qr_payment_id, ' recorded on OR-', LPAD(p_sale_id, 6, '0')));

    COMMIT;

    SET p_status_code = 200;
    SET p_message = 'The QR payment is recorded on the sale.';
END //

DELIMITER ;
