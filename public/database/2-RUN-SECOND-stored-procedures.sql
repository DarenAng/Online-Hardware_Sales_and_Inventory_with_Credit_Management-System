-- ==========================================================================
-- 2-RUN-SECOND-stored-procedures.sql
-- Hardware Sales & Inventory with Credit Management
--
-- WHAT THIS IS
--   The 24 stored procedures the application calls. The tables have to exist
--   before these can be created, which is why this file runs second.
--
-- HOW TO RUN IT (MySQL Workbench)
--   Run 1-RUN-FIRST-database.sql first, then:
--   File > Open SQL Script... > pick this file > click the lightning bolt.
--
-- HOW TO RUN IT (command line)
--   mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
--
-- WHEN TO RUN IT AGAIN
--   Safe to re-run on its own at any time: it drops and recreates the
--   procedures and touches no table and no row. If the server starts with
--   "PROCEDURE does not exist", this file is what fixes it.
-- ==========================================================================

USE hardware_db;

DELIMITER //

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
    IN p_middle_initial VARCHAR(5),
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

    INSERT INTO staff (first_name, middle_initial, last_name, phone, role_id, is_active)
    VALUES (p_first_name, NULLIF(TRIM(IFNULL(p_middle_initial, '')), ''),
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
    IN p_middle_initial VARCHAR(5),
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
        middle_initial = NULLIF(TRIM(IFNULL(p_middle_initial, '')), ''),
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
    DECLARE v_stock INT DEFAULT 0;
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

    -- Stock is healthy again, so retire anything still warning about it.
    -- Without this the bell keeps a solved problem on screen forever, and
    -- people learn to ignore it.
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

    -- the other kind of warning no longer describes the situation, so a
    -- product that has gone from empty to merely low stops saying "out of stock"
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
    -- The name of a buyer who has no account, taken at the counter. Ignored
    -- entirely when p_customer_id is given: a named customer's name lives in
    -- the customers table and copying it here would give the same sale two
    -- names that can drift apart.
    IN p_walk_in_name VARCHAR(150),
    IN p_cashier_staff_id INT,
    IN p_discount DECIMAL(10,2),
    IN p_amount_paid DECIMAL(12,2),
    IN p_payment_method VARCHAR(30),
    IN p_items_json JSON,
    -- How a down payment on a Credit sale was actually tendered. The sale's
    -- own method says Credit, which is not a way of handing over money, so
    -- the part that was handed over needs its own name or the payment
    -- history cannot say how it arrived.
    IN p_down_payment_method VARCHAR(30),
    OUT p_sale_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_i INT DEFAULT 0;
    DECLARE v_item_count INT DEFAULT 0;
    DECLARE v_product_id INT;
    DECLARE v_quantity INT;
    DECLARE v_unit_price DECIMAL(10,2);
    DECLARE v_stock INT;
    -- what the whole basket asks of this material, not just the line in hand
    DECLARE v_needed INT;

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

    -- WHAT THE SALE IS MADE OF, FOR TAX
    --
    -- Philippine posted prices already include VAT, so the rate is extracted
    -- from the total rather than added to it, and the customer pays the same
    -- figure either way. The VAT is rounded first and the VATable sale is
    -- what is left, so the two lines always add back to the total exactly;
    -- dividing by 1.12 and rounding both can leave the invoice a centavo
    -- short of itself.
    --
    -- The registration and the rate are copied onto the sale rather than
    -- looked up when an invoice is reprinted. An invoice records what was
    -- charged on the day it was issued, and a shop crossing the VAT threshold
    -- later must not silently rewrite every invoice it has ever handed out.
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

    -- Credit and Cash on Delivery are both settled after the goods leave the
    -- counter: on account for Credit, at the customer's door for COD.
    --
    -- They part company over a down payment. Half now and half on the book is
    -- the commonest credit transaction a hardware shop does, so a Credit sale
    -- accepts whatever is handed over at the counter and books only the rest.
    -- COD takes nothing at the register by definition: the money is collected
    -- at the door or it is not collected at all.
    SET v_on_credit = (p_payment_method = 'Credit');
    SET v_on_account = (p_payment_method IN ('Credit', 'COD'));
    SET v_down_method = IFNULL(NULLIF(TRIM(IFNULL(p_down_payment_method, '')), ''), 'Cash');

    -- A sale belongs to an account or to a name, never to both. Blank and
    -- whitespace collapse to NULL so "we did not ask" stays distinguishable
    -- from "the customer is called nothing".
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

        -- WHAT THE WHOLE BASKET ASKS FOR
        --
        -- Each line used to be weighed against stock on its own, and pass two
        -- then deducted every line regardless. One material listed on two lines
        -- therefore passed twice against the same shelf and was sold twice: 18
        -- bags of cement on two lines of 18 was accepted, and the inventory
        -- came out at minus 18. The count is signed, so nothing complained.
        --
        -- The question a line has to answer is not "is there enough for me" but
        -- "is there enough for everything on this receipt", so the check adds up
        -- every line naming this material before comparing.
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
        -- A down payment cannot exceed the bill. Anything over it is change,
        -- and there is no change on a sale that is going on the book.
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

        -- A stop on an account is a decision a manager made, and a limit with
        -- room left in it is not permission to ignore it. Checked before the
        -- limit, because "this account is on hold" is a more useful refusal
        -- than "you are 300 pesos over".
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

        -- Paid, part paid, or wholly on the book. Writing this down correctly
        -- is what keeps receivables, the customer's balance and the driver's
        -- collection list telling the same story.
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

    -- A shop with no settings row is a shop mid-install, not a shop that is
    -- non-VAT, so the defaults stand rather than the sale being refused.
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
        -- A non-VAT shop charges no VAT at all. Zeroes here are the honest
        -- answer, and its whole sale is subject to percentage tax instead.
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

    -- A down payment is a payment, and it belongs in the payment history with
    -- every other one. Without this row the customer's credit page would show
    -- a balance that had moved with no record of what moved it.
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

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
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

        UPDATE products
        SET is_archived = TRUE, status = 'Inactive', archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE product_id = p_record_id;

    ELSEIF p_module = 'Sales' THEN
        SELECT COUNT(*) INTO v_found FROM sales WHERE sale_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active sale record not found.';
            LEAVE PROC_BODY;
        END IF;

        UPDATE sales
        SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = p_staff_id
        WHERE sale_id = p_record_id;

    ELSEIF p_module = 'Delivery' THEN
        SELECT COUNT(*) INTO v_found FROM deliveries WHERE delivery_id = p_record_id AND is_archived = FALSE;
        IF v_found = 0 THEN
            SET p_status_code = 404;
            SET p_message = 'Active delivery record not found.';
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

        UPDATE sales
        SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL
        WHERE sale_id = p_record_id;

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

    -- ONE PAYMENT AT A TIME AGAINST ONE SALE
    --
    -- The balance was read, checked and written back outside any transaction,
    -- so a cashier at the counter and a driver at the customer's door taking
    -- the last two payments on the same order at the same moment both read the
    -- same "already paid" figure, both passed the check, and the second write
    -- overwrote the first. Two rows in the payment history, one of them missing
    -- from the balance, and an order that reads as still owing money that is
    -- sitting in the till.
    --
    -- Reading the sale row FOR UPDATE inside the transaction makes the second
    -- one wait for the first to finish and then see its result.
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
    IN p_quantity INT,
    -- WHAT THE FIGURE IS COUNTED IN
    --
    -- A hardware shop counts almost nothing in the same unit twice, and a
    -- bare "+20" against Portland Cement is twenty of something nobody can
    -- name six months later. The clerk knows at the moment they type it, so
    -- this is where that knowledge is kept.
    --
    -- A unit that does not exist yet is created rather than refused. The
    -- alternative is a clerk holding a sack of nails and no way to say so,
    -- and a list of units that only a DBA can grow is a list that stays
    -- wrong. Passing NULL or an empty string keeps the material's current
    -- unit, so a caller that does not care is not forced to have an opinion.
    IN p_unit_name VARCHAR(20),
    IN p_reason VARCHAR(255),
    IN p_staff_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_before INT;
    DECLARE v_change INT DEFAULT 0;
    DECLARE v_after INT DEFAULT 0;
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

    -- A unit typed for the first time joins the list rather than being
    -- refused. Matched case-insensitively so that "Bag" and "bag" do not
    -- become two units meaning the same thing.
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
-- A hardware shop buys from whoever has the stock this week. The list of
-- suppliers is therefore never finished, and a purchase order screen that can
-- only pick from the finished list is a screen that cannot raise the order
-- the shop actually needs to raise today.
--
-- So the name is the input, not the id. A name already on file is matched and
-- reused, and anything else joins the list. Matching is on the trimmed name,
-- case-insensitively, because "Vista Steel" typed on a Tuesday and "vista
-- steel" typed on a Thursday are one company and two rows is how a supplier
-- ends up with half its orders.
--
-- No transaction control in here on purpose: it is called from inside
-- sp_create_purchase_order, which owns the transaction, and a COMMIT here
-- would break the order it is part of.
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
            -- details typed alongside a known company fill in blanks; they
            -- never overwrite something already recorded, because the person
            -- raising an order is not the person who maintains the file
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
-- The same argument as the supplier above, and the one the clerks actually
-- complain about: the picker suggests what is in the database, so the one
-- thing it will not let you do is take delivery of something new. A pallet of
-- something the shop has never stocked arrives, and the clerk cannot book it
-- in until somebody with a different login adds it first.
--
-- This is the way out. A name that matches a material already on the books
-- returns that material; a name that matches nothing creates it, with its
-- unit, category and brand created alongside it if those are new too, and an
-- inventory row at zero so the receiving that follows has something to add
-- to.
--
-- Deliberately NOT archived-aware in the lookup: if a material was archived
-- last year and turns up on a lorry today, the right answer is the material
-- that already exists with its history intact, not a second row with the same
-- name. Bringing it back out of the archive is the receiving step's job.
--
-- No transaction control here either. Its caller owns the transaction.
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
        -- the words the clerk typed join the shop's lists rather than being
        -- refused; a unit typed for the first time is a new unit, not a typo
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
-- 15. ADD A MATERIAL ON ITS OWN
--
-- The wrapper the "add a material" form calls when a clerk adds one straight
-- from a picker rather than in the middle of an order. Same rules, its own
-- transaction, and it says which of the two things happened so the screen can
-- tell the truth: made a new one, or found the one you already had.
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
-- WHAT CHANGED, AND WHY
--
-- This used to take a supplier id and a list of product ids, which meant a
-- purchase order could only ever be raised for companies and materials that
-- were already in the database. That is the wrong way round: a purchase order
-- is how a shop buys something it does not have yet, frequently from somebody
-- it has not bought from before.
--
-- So the supplier arrives as a name, and a line arrives as either a product id
-- or a name with the few facts needed to open a record for it. Anything new is
-- created here, inside the same transaction as the order, so a failure half
-- way through leaves neither a half-written order nor an orphan material.
--
-- The item JSON is a list of objects; every line needs a quantity, and either
-- an id or a name:
--
--   { "product_id": 12, "quantity": 40, "unit_cost": 25.00 }
--   { "new_name": "Roofing nail 3in", "unit_name": "kilogram",
--     "category_name": "Fasteners", "brand_name": "Vista",
--     "price": 180.00, "quantity": 20, "unit_cost": 120.00 }
--
-- WHY EVERY READ IS WRAPPED IN NULLIF(..., 'null')
--
-- JSON_UNQUOTE turns a JSON null into the four-character string "null" rather
-- than into SQL NULL; only a key that is absent altogether comes back as NULL.
-- A browser sending {"product_id": null, "new_name": "Cement"} is doing the
-- ordinary thing, and without the guard that null lands in an INT variable as
-- the word "null", which under strict mode raises and rolls the whole order
-- back behind a message that says nothing about what actually went wrong.
-- Every read of caller-supplied JSON below is guarded for that reason.
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
    DECLARE v_quantity INT;
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

    INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)
    VALUES (2, 'Purchase Order', CONCAT('Purchase order #', p_po_id, ' raised'),
            CONCAT(v_count, ' line(s) ordered, awaiting delivery.'), p_staff_id);

    COMMIT;

    SET p_status_code = 201;
    SET p_message = CONCAT('Purchase order #', p_po_id, ' created',
        IF(p_new_materials > 0,
           CONCAT(', and ', p_new_materials, ' new material(s) added to the list.'), '.'));
END //

-- ==========================================
-- 17. RECEIVE A PURCHASE ORDER
--
-- WHAT CHANGED, AND WHY
--
-- This used to read the order and add exactly what the order said, on the
-- assumption that what was ordered is what arrives. In a hardware shop it
-- routinely is not: a line comes up short, a line comes over, a substitution
-- turns up that nobody ordered at all. The clerk had two options, both wrong:
-- receive the order as written and correct the shelf afterwards with a stock
-- adjustment nobody can tie back to the delivery, or not receive it.
--
-- So receiving now takes a count sheet. p_received_json is what actually came
-- off the lorry:
--
--   { "product_id": 12, "quantity": 38 }                      a short line
--   { "new_name": "Anchor bolt M12", "unit_name": "pcs",
--     "quantity": 24, "unit_cost": 30.00 }                    never ordered
--
-- A line on the order that is missing from the sheet is received in full, so
-- an unedited sheet behaves exactly as the old procedure did. A quantity of
-- zero is a line that did not arrive: the order still closes, and the shelf is
-- not touched.
--
-- The order's own lines are corrected to match what arrived, because a
-- purchase order that says forty when thirty-eight came is a document that
-- will be believed later and will be wrong.
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
    DECLARE v_before INT;
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
    -- Done first, so an extra material becomes a line of the order and is
    -- then stocked by the same loop as everything else. One path into the
    -- shelf, whatever arrived.
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

            -- a material that had been archived is on a lorry again, so it
            -- belongs back on the working list
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

    -- a line that did not arrive at all is not left on the order pretending
    -- it did; the order closes, and the record says nothing came
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
    IN p_quantity INT,
    IN p_reason TEXT,
    IN p_refund_amount DECIMAL(12,2),
    -- Where the goods go, in words. It used to be a true/false called
    -- "restock", which is a question about a checkbox rather than about the
    -- item in somebody's hand; restocked is now derived from this, so the
    -- record of what was decided and the stock movement cannot disagree.
    IN p_disposition VARCHAR(20),
    IN p_staff_id INT,
    OUT p_report_id INT,
    OUT p_status_code INT,
    OUT p_message VARCHAR(255)
)
PROC_BODY: BEGIN
    DECLARE v_name VARCHAR(150);
    DECLARE v_before INT;
    DECLARE v_change INT DEFAULT 0;
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

    -- A reason of "damaged" explains nothing three months later when the
    -- write-off is queried, so the bar is a sentence rather than a word.
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

    -- Where the stock actually moves, and it is not symmetrical.
    --
    -- Return to Stock always adds: the goods are back on the shelf and
    -- sellable, whether they came back from a customer or off the floor.
    --
    -- Write-Off only subtracts when the goods were still counted as stock.
    -- Something a customer is handing back was deducted when it was sold, so
    -- writing it off now takes nothing further off the shelf; the loss is the
    -- refund, not the unit. Something found broken in the stockroom, with no
    -- sale behind it, is still on the count and has to come off.
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
    -- A slot rather than a day. A shop moving a delivery around a conflict
    -- needs the hour, and "Tuesday" cannot be rescheduled to "Tuesday".
    IN p_scheduled_date DATETIME,
    IN p_remarks TEXT,
    -- Who the driver is looking for and what number to ring on arrival, as
    -- written at the counter. Falls back to the sale's customer record when
    -- the cashier left them blank, so a delivery for an account customer
    -- still carries a name without anyone retyping it.
    IN p_contact_name VARCHAR(150),
    IN p_contact_phone VARCHAR(30),
    -- The day this was written up. Defaults to today when the caller does
    -- not say, which is the honest answer for a delivery booked at the till.
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

    -- Nothing typed at the counter means the sale already knows the answer:
    -- the account customer's own name and number, or the walk-in name that
    -- was taken when the sale was rung up.
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

    -- ------------------------------------------------------------------
    -- WHO MAY MOVE A DELIVERY
    -- Roles: 1 Administrator, 2 Manager, 3 Inventory Clerk,
    --        4 Cashier, 5 Delivery Personnel
    -- ------------------------------------------------------------------

    -- A delivered order is closed. Fixing a mistake means a new record with
    -- a reason on it, not a quiet rewrite of what already happened.
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

    -- Every other move belongs to the driver, with the manager able to step in
    -- when a run has to be reassigned or called off. Nobody else takes part.
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
-- The manager's half of credit management. Limit and standing move together
-- because they are one decision: "this customer may owe us up to this much,
-- and here is how much I trust them at the moment."
--
-- Lowering a limit below what is already owed is allowed and is not a
-- mistake. It is how a shop stops an account growing without pretending the
-- existing debt is not there. The message says so, so nobody thinks the
-- figure failed to save.
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

    -- a customer may have no credit row at all, so this creates one rather
    -- than failing on an account nobody has set a limit for before
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
-- 23. ASK FOR A HIGHER LIMIT
--
-- Raised at the counter by whoever is standing there when a sale will not
-- fit. It changes nothing on its own; it puts the question on the manager's
-- screen so the queue can move on.
--
-- One pending request per customer at a time. Three cashiers hitting the same
-- limit in one afternoon should produce one decision to make, not three.
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
-- 24. DECIDE A CREDIT EXTENSION
--
-- Approving raises the limit in the same transaction that closes the request,
-- so there is never a moment where a request reads Approved and the limit has
-- not moved. Declining records why, because "no" without a reason is a
-- question the cashier will have to ask again tomorrow.
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

    -- A decision already made stands. Reopening it would rewrite the reason
    -- an extension was granted, which is the one thing an audit needs to keep.
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
        -- the limit moves in the same transaction that closes the request, so
        -- there is no moment where one says yes and the other has not caught up
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
-- A regular who has been buying for months and has never been typed into the
-- customers table is invisible to every screen that matters: no purchase
-- history, no credit book entry, and a name the cashier retypes on every
-- sale. The counter is where that regular is standing, so the counter is
-- where the account gets opened.
--
-- What a cashier can do here is create the record. What they cannot do is
-- give it any credit: the limit is zero and the standing is Good, which
-- together mean "known customer, sells for cash", and only a manager moves
-- the limit off zero. Opening an account is therefore not a way to grant
-- credit to yourself, which is the reason it is safe to hand to a cashier.
--
-- The duplicate check is on name and phone together. Two Juan Cruzes with
-- different numbers are two people; the same name with the same number,
-- typed twice in a week, is one person and a queue. Rather than refuse, it
-- hands back the account that already exists, because the cashier's actual
-- goal is to have this sale attached to the right customer and a 409 in the
-- middle of a transaction does not achieve that.
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

    -- One-word names are ordinary. Rather than refuse the sale over it, the
    -- surname column takes an empty string, and CONCAT still produces a
    -- readable name everywhere it is joined.
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

        -- the name as the book already spells it, not as it was typed just
        -- now, so the cashier sees which account they have landed on
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

    -- Zero limit, Good standing: a known customer who buys for cash. Only a
    -- manager moves that limit.
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
-- One row that decides what every invoice says about the seller. It is a
-- procedure rather than a plain UPDATE because changing a TIN or flipping a
-- shop between VAT and non-VAT is exactly the sort of change somebody will
-- want to trace later, and the audit entry records what it moved from as
-- well as to.
--
-- Changing the registration does not touch a single sale already rung up.
-- Those carry their own registration and rate, which is the point: an invoice
-- reprinted next year has to say what was charged on the day it was issued.
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

    -- A VAT shop with a zero rate would print a VAT block full of zeroes,
    -- which says the sale was taxed at nothing rather than that the shop is
    -- not VAT-registered. Those are different claims and only one is true.
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
-- Units grow by being typed on a stock adjustment, which is the right way for
-- a list nobody wants to maintain and the wrong way for a list nobody can
-- correct: one clerk types "kilogrms" once and the shop has a unit that will
-- sit there forever, splitting its nails across two names.
--
-- Renaming onto a name that already exists is a merge, not an error. That is
-- almost always what the person actually meant: they are looking at
-- "kilogrms" and "kilogram" side by side and want one of them gone. Every
-- product on the old unit is repointed at the surviving one and the duplicate
-- is deleted.
--
-- The adjustment log is deliberately left alone. It stores the unit as text
-- as at the time it was filed, so an entry that said kilogrms still says
-- kilogrms: that is what was written down, and history that edits itself to
-- look tidier is not history.
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

    -- A merge. Everything on the misspelt unit moves to the real one and the
    -- misspelling goes, so the shop stops having its nails in two places.
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

DELIMITER ;
