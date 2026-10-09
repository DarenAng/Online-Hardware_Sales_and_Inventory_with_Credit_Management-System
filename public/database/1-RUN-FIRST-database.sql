DROP DATABASE IF EXISTS hardware_db;
CREATE DATABASE hardware_db;
USE hardware_db;

-- MySQL Workbench's "safe update mode" refuses an UPDATE whose WHERE names no
-- key column (error 1175). The mock data below touches a few rows by name, so
-- the mode is switched off for this session only; it is a client-side guard
-- and has no effect on the database itself.
SET SQL_SAFE_UPDATES = 0;

CREATE TABLE roles (
    role_id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE staff (
    staff_id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100) NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role_id INT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    full_name VARCHAR(220) AS (
        CONCAT(first_name,
               IF(middle_name IS NULL OR middle_name = '', '',
                  CONCAT(' ', UPPER(LEFT(middle_name, 1)), '.')),
               ' ', last_name)
    ) VIRTUAL,
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id INT NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
    -- wrong passwords in a row; at the limit the account is held until held_until
    failed_attempts INT NOT NULL DEFAULT 0,
    held_until TIMESTAMP NULL,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- "Forgot your password?": one row per six-digit code emailed. Only the
-- scrypt hash of the code is kept. A code lasts 15 minutes and five wrong
-- tries; used_at is set when it is used, or when a newer code retires it.
CREATE TABLE password_resets (
    reset_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    used_at TIMESTAMP NULL,
    requested_ip VARCHAR(45) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_password_resets_user (user_id, created_at),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE audit_logs (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id INT NULL,
    role_name VARCHAR(50) NULL,
    ip_address VARCHAR(45) NULL,
    action VARCHAR(100) NOT NULL,
    action_type ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP',
                     'LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT',
                     'ACCESS','OTHER')
                NOT NULL DEFAULT 'OTHER',
    details TEXT,
    metadata TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_when (created_at DESC),
    INDEX idx_audit_type (action_type),
    FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE role_feature_permissions (
    permission_id INT AUTO_INCREMENT PRIMARY KEY,
    role_id INT NOT NULL,
    -- the screen's key in the catalogue: lower case, letters, digits, hyphens
    feature_key VARCHAR(40) NOT NULL,
    -- TRUE grants a screen not held by default; FALSE takes away one that is
    is_granted BOOLEAN NOT NULL DEFAULT TRUE,
    note VARCHAR(255) NULL,
    granted_by_staff_id INT NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_role_feature (role_id, feature_key),
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (granted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);
-- 2. ENTITIES
CREATE TABLE categories (
    category_id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE brands (
    brand_id INT AUTO_INCREMENT PRIMARY KEY,
    brand_name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE units (
    unit_id INT AUTO_INCREMENT PRIMARY KEY,
    unit_name VARCHAR(20) NOT NULL UNIQUE
);

CREATE TABLE suppliers (
    supplier_id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_name VARCHAR(100) NOT NULL,
    contact_person VARCHAR(100),
    contact_number VARCHAR(20),
    email VARCHAR(100),
    address TEXT
);

CREATE TABLE customers (
    customer_id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- credit_limit and standing are decisions; balances are derived in a view.
--   Good   sell on account as normal
--   Watch  still allowed, but every screen says to look at this account
--   Hold   no new credit at all until a manager lifts it
-- penalty_rate is the manager's word on one account, 1 to 3 percent a month:
-- NULL means the shop's late-payment rate (store_settings.penalty_rate)
-- applies as it does to everyone.
CREATE TABLE customer_credits (
    credit_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL UNIQUE,
    credit_limit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    standing ENUM('Good','Watch','Hold') NOT NULL DEFAULT 'Good',
    penalty_rate DECIMAL(5,2) NULL,
    notes VARCHAR(255) NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by_staff_id INT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (updated_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Raised at the counter, decided by a manager. previous_limit is recorded so
-- an approval read later cannot be mistaken for a bigger jump than was asked.
CREATE TABLE credit_requests (
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

CREATE TABLE credit_payments (
    payment_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NULL, -- NULL allows a later payment on a walk-in sale
    sale_id INT NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_method ENUM('Cash','Cheque','GCash','PayMaya','PayPal','Bank Transfer') NOT NULL DEFAULT 'Cash',
    reference_no VARCHAR(60),
    received_by_staff_id INT NULL,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (received_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- 3. PRODUCTS & INVENTORY
CREATE TABLE products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    brand_id INT,
    category_id INT,
    unit_id INT,
    price DECIMAL(10,2) NOT NULL,
    -- the typed reorder point; a Dynamic product falls back to it without enough history
    reorder_point INT NOT NULL DEFAULT 10,
    --     ROP = (average daily sales x lead time) + safety stock
    lead_time_days INT NOT NULL DEFAULT 7,
    safety_stock INT NOT NULL DEFAULT 0,
    -- per product: a slow item would only get a reorder point of zero from the formula
    reorder_mode ENUM('Manual','Dynamic') NOT NULL DEFAULT 'Manual',
    -- how the supplier delivers it: a "box" of 20 of the unit above. Orders and
    -- deliveries are counted in packs; stock stays in the unit. Set by the clerk.
    pack_name VARCHAR(20) NULL,
    pack_size DECIMAL(12,3) NULL,
    status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
    supplier_id INT,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (brand_id) REFERENCES brands(brand_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (unit_id) REFERENCES units(unit_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE inventory (
    inventory_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL UNIQUE,
    -- a fraction: nails by the kilo, wire by the metre
    quantity_in_stock DECIMAL(12,3) NOT NULL DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE product_units (
    product_unit_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    unit_name VARCHAR(20) NOT NULL,
    units_per DECIMAL(12,3) NOT NULL,
    price DECIMAL(10,2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_product_unit (product_id, unit_name),
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- ==========================================
-- 4. PROCUREMENT & RETURNS
-- ==========================================
-- The clerk raises an order (For Approval); the manager confirms it (Pending,
-- sent to the supplier) or declines it (Cancelled); a delivery counted in
-- against it makes it Received.
CREATE TABLE purchase_orders (
    po_id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_id INT NOT NULL,
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('For Approval', 'Pending', 'Received', 'Cancelled') NOT NULL DEFAULT 'For Approval',
    raised_by_staff_id INT NULL,
    confirmed_by_staff_id INT NULL,
    confirmed_at TIMESTAMP NULL,
    decision_note VARCHAR(255) NULL,
    -- the supplier prices the order: unit costs go on the lines and any
    -- discount goes here when the delivery is counted in, not when it is raised
    discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    -- the supplier's answer to the approved order: the printed order carries
    -- a link and QR code with this code (made when the manager approves it),
    -- kept as it is so every reprint carries the same working link
    supplier_code VARCHAR(64) NULL,
    supplier_sent_at TIMESTAMP NULL,
    supplier_response ENUM('Accepted', 'Declined') NULL,
    supplier_responded_at TIMESTAMP NULL,
    supplier_note VARCHAR(255) NULL,
    UNIQUE INDEX idx_purchase_orders_supplier_code (supplier_code),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (raised_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (confirmed_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE purchase_order_items (
    po_item_id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_cost DECIMAL(10,2) NOT NULL,
    line_cost DECIMAL(12,2) AS (quantity * unit_cost) STORED,
    -- how the line was ordered when it was ordered in packs: 20 box of 20 kg
    -- is quantity 400; the pack is kept so the printed order says "20 box"
    pack_name VARCHAR(20) NULL,
    pack_size DECIMAL(12,3) NULL,
    pack_count DECIMAL(12,3) NULL,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- every stock movement leaves a trail
CREATE TABLE stock_adjustments (
    adjustment_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    adjustment_type ENUM('Add', 'Remove', 'Recount') NOT NULL,
    quantity_before DECIMAL(12,3) NOT NULL,
    quantity_change DECIMAL(12,3) NOT NULL,
    quantity_after DECIMAL(12,3) NOT NULL,
    -- What the figure was counted in, as text at the time it was filed, so
    -- renaming a unit next year does not rewrite last year's entries.
    unit_name VARCHAR(20) NULL,
    reason VARCHAR(255) NOT NULL,
    adjusted_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (adjusted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- one row per role that needs to see it; created_by_staff_id NULL means the system raised it
CREATE TABLE notifications (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    target_role_id INT NULL,
    notif_type ENUM('Low Stock', 'Out of Stock', 'Damage Report', 'Refund Report', 'Purchase Order', 'Stock Adjustment', 'Delivery', 'Credit Request', 'Late Penalty') NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT,
    product_id INT NULL,
    created_by_staff_id INT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_role_id) REFERENCES roles(role_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE store_settings (
    setting_id INT PRIMARY KEY DEFAULT 1,
    store_name VARCHAR(150) NOT NULL DEFAULT 'Lucelyn Hardware',
    -- the owner, printed under the registered name as "Prop." on every invoice
    proprietor VARCHAR(150) NULL,
    address VARCHAR(255) NOT NULL DEFAULT 'Set your address in System Administration',
    tin VARCHAR(30) NOT NULL DEFAULT '000-000-000-00000',
    registration_type ENUM('VAT','NON-VAT') NOT NULL DEFAULT 'VAT',
    -- a rate written into source code is a rate nobody can change when it moves
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 12.00,
    -- the line under the barcode: a returns policy, a thank you, anything
    invoice_note VARCHAR(255) NULL,
    -- the late-payment penalty: this much of the goods still unpaid is added
    -- to a credit sale for every month (or part of one) it is past its 30-day
    -- due date. The rate is 1 to 3 percent a month; the default is 3. A
    -- manager can set another rate for the shop, or for one account
    -- (customer_credits.penalty_rate).
    penalty_rate DECIMAL(5,2) NOT NULL DEFAULT 3.00,
    -- the account a customer sends a bank transfer to, shown at the till and
    -- printed on the invoice: all three are set together or none is
    bank_name VARCHAR(100) NULL,
    bank_account_name VARCHAR(150) NULL,
    bank_account_number VARCHAR(50) NULL,
    -- the receipt's layout as JSON: paper width, text size, title, the paid
    -- stamp, the shop's own header and footer lines, and what is shown. Set in
    -- Receipt Maintenance; the server fills it with its defaults on first start.
    receipt_layout TEXT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by_staff_id INT NULL,
    CONSTRAINT chk_store_settings_single_row CHECK (setting_id = 1),
    CONSTRAINT chk_store_settings_rate CHECK (vat_rate >= 0 AND vat_rate <= 100),
    CONSTRAINT chk_store_settings_penalty CHECK (penalty_rate >= 1 AND penalty_rate <= 3)
);

CREATE TABLE sales (
    sale_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NULL,
    -- the name of somebody not on the credit book; NULL means nobody asked
    walk_in_name VARCHAR(150) NULL,
    cashier_staff_id INT NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    final_amount DECIMAL(12,2) AS (total_amount - discount) STORED,
    amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    change_given DECIMAL(12,2) AS (GREATEST(amount_paid - (total_amount - discount), 0)) STORED,
    -- The late-payment penalty, charged by sp_apply_late_penalties for each
    -- month a Credit sale is past its due date still owing: the rate it was
    -- last charged at, how many months have been charged, what they add up
    -- to, and when the last one was. amount_due is the bill with the
    -- penalty on it, and is what every balance is measured against;
    -- final_amount stays the sale itself, for the sales figures.
    penalty_rate DECIMAL(5,2) NULL,
    penalty_months INT NOT NULL DEFAULT 0,
    penalty_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    penalty_applied_at TIMESTAMP NULL,
    amount_due DECIMAL(12,2) AS (total_amount - discount + penalty_amount) STORED,
    payment_method ENUM('Cash','Cheque','GCash','PayMaya','PayPal','Bank Transfer','COD','Credit') NOT NULL,
    payment_status ENUM('Paid','Partial','Unpaid') NOT NULL DEFAULT 'Paid',

    tax_registration ENUM('VAT','NON-VAT') NOT NULL DEFAULT 'VAT',
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 12.00,
    vatable_sale DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    vat_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    vat_exempt_sale DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    zero_rated_sale DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    reference_no VARCHAR(60),
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (cashier_staff_id) REFERENCES staff(staff_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE sale_items (
    sale_item_id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    product_id INT NOT NULL,
    -- 2.500 for two and a half kilos of nails, always in the product's own
    -- unit so stock comes off it directly; see inventory.quantity_in_stock
    quantity DECIMAL(12,3) NOT NULL,
    -- What the customer was charged for, when it was not the product's own
    -- unit: 2 sacks of nails is sold_quantity 2, sold_unit 'sack', with
    -- quantity holding the 50 kilos that left the shelf. NULL on a plain line.
    sold_unit VARCHAR(20) NULL,
    sold_quantity DECIMAL(12,3) NULL,
    -- the price of one sold unit (one sack, or one kilo on a plain line)
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(12,2) AS (ROUND(COALESCE(sold_quantity, quantity) * unit_price, 2)) STORED,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE deliveries (
    delivery_id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    delivery_staff_id INT NULL,
    delivery_address TEXT NOT NULL,
    -- who the driver is looking for, as written when booked; wins over the customer row
    contact_name VARCHAR(150) NULL,
    contact_phone VARCHAR(30) NULL,
    status ENUM('Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed', 'Failed') NOT NULL DEFAULT 'Pending',
    remarks TEXT,
    -- the day it was written up, kept apart from the day it is meant to arrive
    booked_date DATE NULL,
    -- "Tuesday 2pm", not "Tuesday": the hour matters when moving a delivery
    scheduled_date DATETIME NULL,
    delivered_at TIMESTAMP NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (delivery_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
    -- a Delivered row without a timestamp would report under the wrong day
    CONSTRAINT chk_delivered_has_timestamp
        CHECK (status <> 'Delivered' OR delivered_at IS NOT NULL)
);

-- disposition says in words where the goods go; restocked is derived from
-- it so the two cannot disagree. reason is NOT NULL on purpose.
CREATE TABLE returned_items (
    return_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    sale_id INT NULL,
    report_type ENUM('Return', 'Damaged', 'Refunded') NOT NULL DEFAULT 'Return',
    quantity DECIMAL(12,3) NOT NULL,
    reason TEXT NOT NULL,
    -- Where the goods go. NULL is a refund the cashier took back that the
    -- clerk has not inspected yet: nothing has moved on the shelf, and the
    -- clerk's verdict (sellable or not) fills it in and closes the report.
    disposition ENUM('Return to Stock', 'Write-Off') NULL,
    refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    restocked BOOLEAN NOT NULL DEFAULT FALSE,
    status ENUM('Open', 'Resolved') NOT NULL DEFAULT 'Open',
    reported_by_staff_id INT NULL,
    -- the clerk's inspection: who looked, when, and what they found
    inspected_by_staff_id INT NULL,
    inspected_at TIMESTAMP NULL,
    inspection_note VARCHAR(255) NULL,
    return_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (reported_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (inspected_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Every GCash or Maya payment attempt made by QR code, whatever became of it,
-- so the shop can see which went through and which did not. A row starts
-- pending and is closed once: paid, failed, expired (not paid in time) or
-- cancelled (by the cashier). sale_id is filled when the money is recorded
-- on a sale (a new one, or a payment on a balance); a paid row with no sale
-- is money the shop holds without a record, and error_message says so.
-- Written only through sp_create_qr_payment, sp_set_qr_payment_result and
-- sp_link_qr_payment_to_sale.
CREATE TABLE qr_payments (
    qr_payment_id INT AUTO_INCREMENT PRIMARY KEY,
    -- who took the money: PayMongo, or the offline simulation; test or real money
    provider ENUM('paymongo','sim') NOT NULL,
    mode ENUM('test','live') NOT NULL,
    provider_intent_id VARCHAR(80) NOT NULL,
    -- the provider's own number for the payment: the reference on the invoice
    provider_payment_id VARCHAR(80) NULL,
    amount DECIMAL(12,2) NOT NULL,
    wallet ENUM('GCash','PayMaya') NOT NULL,
    purpose ENUM('sale','credit_payment') NOT NULL,
    status ENUM('pending','paid','failed','expired','cancelled') NOT NULL DEFAULT 'pending',
    error_message VARCHAR(255) NULL,
    sale_id INT NULL,
    created_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- after this a pending code is closed as expired
    expires_at TIMESTAMP NULL,
    paid_at TIMESTAMP NULL,
    closed_at TIMESTAMP NULL,
    UNIQUE KEY uq_qr_payments_intent (provider_intent_id),
    INDEX idx_qr_payments_created (created_at),
    INDEX idx_qr_payments_status (status),
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- ------------------------------------------------------------
-- The server's own tables, so any copy of it can answer any request (Vercel
-- runs many). Not shop data: a backup leaves them out and a restore leaves
-- them be. The server also creates them itself on start-up if they are
-- missing. Times are milliseconds since 1970, free of any time zone.
-- ------------------------------------------------------------

-- who is signed in; token_hash is the SHA-256 of the cookie, never the cookie.
-- A session somebody else ended keeps its row a day with the reason, so the
-- screen left behind is told why.
CREATE TABLE user_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    staff_id INT NOT NULL,
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    role_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL,
    started_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    ended_reason VARCHAR(255) NULL,
    ended_at BIGINT NULL,
    INDEX idx_user_sessions_staff (staff_id),
    INDEX idx_user_sessions_expires (expires_at)
);

-- the live-update log: change_id is the version every screen asks after
CREATE TABLE live_changes (
    change_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    scope VARCHAR(30) NOT NULL,
    detail VARCHAR(255) NULL,
    origin VARCHAR(64) NULL,
    created_at BIGINT NOT NULL
);

-- a new account waiting for the administrator's second look; sealed with a
-- key only the administrator's screen holds, gone after ten minutes
CREATE TABLE account_drafts (
    draft_hash CHAR(64) PRIMARY KEY,
    staff_id INT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    payload TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);

-- backups when there is no disk to keep them on (HARDWARE_BACKUP_STORE=database)
CREATE TABLE backup_files (
    file_name VARCHAR(100) PRIMARY KEY,
    bytes INT NOT NULL,
    created_at BIGINT NOT NULL,
    content LONGBLOB NOT NULL
);

-- small switches, such as the daily backup's on/off
CREATE TABLE app_flags (
    flag_key VARCHAR(50) PRIMARY KEY,
    flag_value VARCHAR(255) NULL,
    updated_at BIGINT NOT NULL
);

-- the offline payment simulator's codes (PAYMENT_PROVIDER=sim)
CREATE TABLE qr_sim_intents (
    intent_id VARCHAR(40) PRIMARY KEY,
    token VARCHAR(40) NOT NULL UNIQUE,
    amount DECIMAL(12,2) NOT NULL,
    wallet VARCHAR(20) NOT NULL,
    description VARCHAR(255) NULL,
    return_url VARCHAR(500) NOT NULL,
    status VARCHAR(10) NOT NULL,
    payment_id VARCHAR(40) NULL,
    error_message VARCHAR(255) NULL,
    created_at BIGINT NOT NULL
);

INSERT INTO store_settings (setting_id) VALUES (1);

INSERT INTO roles (role_id, role_name) VALUES
(1, 'System Administrator'), (2, 'Manager'), (3, 'Inventory Clerk'),
(4, 'Cashier'), (5, 'Delivery Personnel');

INSERT INTO staff (staff_id, first_name, middle_name, last_name, phone, role_id, is_active) VALUES
(1, 'Admin',    'Santos',    'User',    '+639170000001', 1, TRUE),
(2, 'Manager',  'Mendoza',   'User',    '+639170000002', 2, TRUE),
(3, 'Clerk',    'Ibarra',    'User',    '+639170000003', 3, TRUE),
(4, 'Cashier',  'Castro',    'User',    '+639170000004', 4, TRUE),
(5, 'Delivery', 'Dela Cruz', 'User',    '+639170000005', 5, TRUE);
UPDATE staff SET created_at = '2026-01-05 08:00:00' WHERE staff_id BETWEEN 1 AND 5;

INSERT INTO users (staff_id, email, password, must_change_password) VALUES
(1, 'admin@hardware.com', 'admin123', FALSE),
(2, 'manager@hardware.com', 'manager123', TRUE),
(3, 'clerk@hardware.com', 'clerk123', TRUE),
(4, 'cashier@hardware.com', 'cashier123', TRUE),
(5, 'delivery@hardware.com', 'delivery123', TRUE);

INSERT INTO categories (category_name) VALUES
('Hand Tools'), ('Power Tools'), ('Plumbing'), ('Electrical'), ('Construction Materials');

INSERT INTO brands (brand_name) VALUES
('Makita'), ('DeWalt'), ('Stanley'), ('Boysen'), ('Pioneer');

INSERT INTO units (unit_name) VALUES
('pcs'), ('bag'), ('liter'), ('meter'), ('box'),
('kilogram'), ('gram'), ('sack'), ('roll'), ('set'),
('pack'), ('gallon'), ('sheet'), ('tube'), ('foot');

INSERT INTO suppliers (supplier_name, contact_person, contact_number, email, address) VALUES
('Manila Hardware Supply', 'Juan Dela Cruz', '0917-123-4567', 'sales@manilahardware.ph', 'Binondo, Manila'),
('Cebu Tool Co.', 'Maria Santos', '0918-987-6543', 'contact@cebutool.com', 'Mandaue City, Cebu');

INSERT INTO customers (first_name, last_name, phone, address) VALUES
('Pedro', 'Penduko', '0922-333-4444', 'Quezon City, Metro Manila'),
('Juan', 'Tamad', '0999-888-7777', 'Pasig City, Metro Manila'),
('Rosa', 'Villamor', '0917-555-1212', 'Caloocan City, Metro Manila'),
('Mark', 'Aguilar', '0918-444-3131', 'Taguig City, Metro Manila');

-- one of each standing, so the credit screen has something to show
INSERT INTO customer_credits (customer_id, credit_limit, standing, notes, updated_by_staff_id) VALUES
(1, 50000.00, 'Good',  NULL, NULL),
(2, 20000.00, 'Watch', 'Two sales past 30 days. Chase before extending further.', 2),
(3, 30000.00, 'Good',  NULL, NULL),
(4, 15000.00, 'Hold',  'Cheque bounced in August. No new credit until it clears.', 2);

-- two products start on the dynamic reorder point so the Stocks screen has something to show
INSERT INTO products (product_name, brand_id, category_id, unit_id, price,
                      reorder_point, lead_time_days, safety_stock, reorder_mode,
                      status, supplier_id, is_archived) VALUES
('Cordless Drill 18V',   1,    2, 1, 8500.00,  5, 14,  2, 'Manual',  'Active',   1, FALSE),
('Claw Hammer',          3,    1, 1,  450.00, 20,  7,  5, 'Manual',  'Active',   2, FALSE),
('PVC Pipe 1/2"',        NULL, 3, 4,  120.00, 50,  5, 20, 'Dynamic', 'Active',   1, FALSE),
('Latex Paint White',    4,    5, 3,  750.00, 15, 10,  4, 'Manual',  'Active',   1, FALSE),
('Epoxy A & B',          5,    5, 5,  180.00, 30, 10,  8, 'Manual',  'Active',   2, FALSE),
('Portland Cement 40kg', NULL, 5, 2,  260.00, 40, 10, 15, 'Dynamic', 'Active',   1, FALSE),
('Circuit Breaker 20A',  2,    4, 1,  620.00, 12,  5,  3, 'Manual',  'Active',   2, FALSE),
('Old Kerosene Lamp',    NULL, 4, 1,  350.00,  5,  7,  0, 'Manual',  'Inactive', 2, TRUE);

UPDATE products SET archived_at = '2026-08-21 10:30:00', archived_by_staff_id = 2 WHERE product_id = 8;

INSERT INTO inventory (product_id, quantity_in_stock) VALUES
(1, 12), (2, 45), (3, 150), (4, 8), (5, 60), (6, 18), (7, 4), (8, 0);

INSERT INTO purchase_orders (supplier_id, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at) VALUES
(1, 'Received', 3, 2, NOW()), (2, 'Pending', 3, 2, NOW()), (1, 'Pending', 3, 2, NOW()),
(2, 'For Approval', 3, NULL, NULL);

INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(1, 1, 10, 7000.00), (1, 3, 100, 90.00),
(2, 2, 50, 300.00), (3, 6, 80, 210.00), (3, 7, 30, 480.00),
(4, 4, 20, 150.00), (4, 5, 60, 85.00);

-- final_amount and change_given are generated, so they are not listed here
INSERT INTO sales (customer_id, cashier_staff_id, total_amount, discount, amount_paid, payment_method, payment_status, reference_no, sale_date) VALUES
(1, 4, 8950.00,  0.00,   9000.00, 'Cash',          'Paid',    NULL,          '2026-08-20 09:15:00'),
(2, 4, 1500.00,  0.00,   0.00,    'Credit',        'Unpaid',  NULL,          '2026-08-21 10:05:00'),
(1, 4, 2600.00,  100.00, 2500.00, 'GCash',         'Paid',    'GC-88213',    '2026-08-24 14:20:00'),
(3, 4, 3720.00,  0.00,   0.00,    'COD',           'Unpaid',  NULL,          '2026-08-26 11:40:00'),
(3, 4, 900.00,   0.00,   900.00,  'PayMaya',       'Paid',    'PM-40021',    '2026-08-27 16:02:00'),
(4, 4, 12400.00, 400.00, 6000.00, 'Cheque',        'Partial', 'CHQ-771904',  '2026-08-28 08:55:00'),
(1, 4, 540.00,   0.00,   540.00,  'PayPal',        'Paid',    'PP-5521XZ',   '2026-08-29 13:11:00'),
(2, 4, 7440.00,  0.00,   7440.00, 'COD',           'Paid',    NULL,          '2026-08-30 10:25:00'),
(NULL, 4, 360.00, 0.00,  400.00,  'Cash',          'Paid',    NULL,          '2026-08-31 17:45:00'),
(4, 4, 1860.00,  0.00,   1860.00, 'Bank Transfer', 'Paid',    'BT-9930',     '2026-09-01 09:30:00');

-- subtotal is generated, so it is not listed here
INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES
(1, 1, 1, 8500.00), (1, 2, 1, 450.00),
(2, 4, 2, 750.00),
(3, 6, 10, 260.00),
(4, 7, 6, 620.00),
(5, 5, 5, 180.00),
(6, 1, 1, 8500.00), (6, 6, 15, 260.00),
(7, 3, 3, 120.00), (7, 5, 1, 180.00),
(8, 4, 8, 750.00), (8, 3, 12, 120.00),
(9, 3, 3, 120.00),
(10, 7, 3, 620.00);

INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method, reference_no, received_by_staff_id, payment_date) VALUES
(4, 6, 6000.00, 'Cheque', 'CHQ-771904', 4, '2026-08-28 09:00:00'),
(2, 8, 7440.00, 'Cash',   NULL,         5, '2026-08-30 15:10:00');

INSERT INTO deliveries (sale_id, delivery_staff_id, delivery_address, status, remarks, scheduled_date, delivered_at) VALUES
(1, 5, 'Quezon City, Metro Manila',  'Delivered',        'Delivered safely to customer front door', '2026-08-21', '2026-08-21 14:30:00'),
(2, 5, 'Pasig City, Metro Manila',   'Pending',          'Awaiting truck dispatch',                 '2026-08-29', NULL),
(4, 5, 'Caloocan City, Metro Manila','Out for Delivery', 'Driver left the warehouse 9:00 AM',       '2026-09-02', NULL),
(6, 5, 'Taguig City, Metro Manila',  'In Transit',       'Bulk cement load, two stops',             '2026-09-02', NULL),
(8, 5, 'Pasig City, Metro Manila',   'Delivered',        'COD collected in full',                   '2026-08-30', '2026-08-30 15:05:00'),
(10, 5,'Taguig City, Metro Manila',  'Delayed',          'Heavy rain, rescheduled',                 '2026-09-03', NULL);

-- archived by hand; the sweep would do it after ninety days
INSERT INTO deliveries (sale_id, delivery_staff_id, delivery_address, status, remarks, scheduled_date, delivered_at, is_archived, archived_at, archived_by_staff_id) VALUES
(3, 5, 'Quezon City, Metro Manila', 'Delivered', 'Old route, closed out', '2026-08-25', '2026-08-25 16:20:00', TRUE, '2026-08-26 08:00:00', 2);

INSERT INTO returned_items (product_id, sale_id, report_type, quantity, reason, disposition, refund_amount, restocked, status, reported_by_staff_id) VALUES
(1, 1,    'Damaged',  1, 'Defective battery pack, will not hold charge',   'Write-Off',      0.00,   FALSE, 'Open',     3),
(4, NULL, 'Damaged',  2, 'Two tins dented in the stockroom, unsellable',   'Write-Off',      0.00,   FALSE, 'Resolved', 3),
(4, 8,    'Refunded', 1, 'Wrong colour delivered, customer refunded',      'Return to Stock', 750.00, TRUE,  'Resolved', 3),
(3, 7,    'Return',   2, 'Customer over-ordered, pipes returned unopened', 'Return to Stock', 240.00, TRUE,  'Resolved', 3),
(7, NULL, 'Damaged',  1, 'Casing cracked during unloading',                'Write-Off',      0.00,   FALSE, 'Open',     3);

INSERT INTO stock_adjustments (product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, adjusted_by_staff_id, created_at) VALUES
(6, 'Add',     10,  8,  18, 'Delivery received from Manila Hardware Supply', 3, '2026-08-25 08:30:00'),
(4, 'Remove',  10, -2,   8, 'Two dented tins written off',                   3, '2026-08-27 14:10:00'),
(7, 'Recount', 6,  -2,   4, 'Physical count corrected the system figure',    3, '2026-08-31 16:45:00'),
(2, 'Add',     40,  5,  45, 'Returned stock put back on the shelf',          3, '2026-09-01 09:20:00');

INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id, is_read, created_at) VALUES
(3, 'Low Stock',    'Circuit Breaker 20A is low',   'Stock is 4, reorder point is 12. Raise a purchase order.', 7, 3, FALSE, '2026-08-31 16:45:00'),
(2, 'Low Stock',    'Circuit Breaker 20A is low',   'Stock is 4, reorder point is 12. Raise a purchase order.', 7, 3, FALSE, '2026-08-31 16:45:00'),
(3, 'Low Stock',    'Latex Paint White is low',     'Stock is 8, reorder point is 15. Raise a purchase order.', 4, 3, FALSE, '2026-08-27 14:10:00'),
(2, 'Low Stock',    'Latex Paint White is low',     'Stock is 8, reorder point is 15. Raise a purchase order.', 4, 3, TRUE,  '2026-08-27 14:10:00'),
(3, 'Damage Report','Damage filed for Cordless Drill 18V', '1 unit reported damaged: defective battery pack.',  1, 3, FALSE, '2026-08-22 11:00:00'),
(2, 'Damage Report','Damage filed for Cordless Drill 18V', '1 unit reported damaged: defective battery pack.',  1, 3, FALSE, '2026-08-22 11:00:00'),
(5, 'Delivery',     'Delivery #3 booked',           'Sale #4 needs delivering to Caloocan City, Metro Manila.', NULL, 4, FALSE, '2026-08-28 09:20:00'),
(2, 'Purchase Order','Purchase order #3 raised',    '2 line(s) ordered, awaiting delivery.',                    NULL, 3, TRUE,  '2026-08-29 08:05:00');

-- ==========================================
-- 8. MOCK DATA
--
-- Six months of trading for a hardware shop in Nasugbu, Batangas, generated
-- by a script with a fixed seed so it is the same on every machine. The
-- credit book holds one account of each standing, worked out by the rules
-- in vw_customer_credit. Ids continue from the demo data above. Every row
-- is the work of one of the five accounts; there are no other staff.
-- ==========================================
INSERT INTO customers (first_name, last_name, phone, address, created_at) VALUES
('Maria Luisa', 'Santos', '0966-602-8036', 'Brgy. Wawa, Nasugbu, Batangas', '2026-02-10 12:55:52'),
('Ernesto', 'Ramos', '0925-784-6117', 'Brgy. Bucana, Nasugbu, Batangas', '2026-04-15 16:15:29'),
('Jocelyn', 'Dela Cruz', '0941-735-9689', 'Poblacion, Nasugbu, Batangas', '2026-05-21 17:00:46'),
('Rodrigo', 'Mendoza', '0952-982-6717', 'Brgy. Lumbangan, Nasugbu, Batangas', '2026-05-06 15:35:21'),
('Cristina', 'Bautista', '0920-968-9684', 'Brgy. Tumalim, Nasugbu, Batangas', '2026-02-25 12:55:46'),
('Alfredo', 'Garcia', '0916-550-9078', 'Brgy. Balaytigui, Nasugbu, Batangas', '2026-02-15 13:00:41'),
('Nenita', 'Reyes', '0992-324-6743', 'Brgy. Aga, Nasugbu, Batangas', '2026-01-30 08:45:08'),
('Dominador', 'Torres', '0953-425-3552', 'Brgy. Kaylaway, Nasugbu, Batangas', '2026-05-21 14:00:48'),
('Evelyn', 'Flores', '0952-992-5182', 'Brgy. Munting Indan, Nasugbu, Batangas', '2026-05-24 09:55:57'),
('Renato', 'Castillo', '0987-116-4477', 'Brgy. Bilaran, Nasugbu, Batangas', '2026-02-04 16:00:26'),
('Lorna', 'Villanueva', '0974-678-2903', 'Brgy. Pantalan, Nasugbu, Batangas', '2026-02-12 08:05:25'),
('Benjamin', 'Aquino', '0963-554-2964', 'Brgy. Banilad, Nasugbu, Batangas', '2026-03-11 15:00:19'),
('Marites', 'Navarro', '0950-142-5423', 'Brgy. Cogunan, Nasugbu, Batangas', '2026-01-11 09:40:12'),
('Ricardo', 'Pascual', '0990-218-9562', 'Brgy. Papaya, Nasugbu, Batangas', '2026-03-12 10:00:06'),
('Divina', 'Mercado', '0993-149-8408', 'Brgy. Looc, Nasugbu, Batangas', '2026-04-17 11:40:59'),
('Arturo', 'Salazar', '0922-619-3416', 'Brgy. Bunducan, Nasugbu, Batangas', '2026-05-05 17:00:18'),
('Imelda', 'Fernandez', '0985-840-9273', 'Brgy. Utod, Nasugbu, Batangas', '2026-04-12 16:50:48'),
('Danilo', 'Manalo', '0986-871-8097', 'Brgy. Calayo, Nasugbu, Batangas', '2026-02-10 11:40:44'),
('JR Construction', '', '0941-241-9001', 'Brgy. Bulihan, Nasugbu, Batangas', '2026-02-19 16:35:53'),
('Sta. Rosa Builders', '', '0971-541-5405', 'Lian, Batangas', '2026-02-19 08:25:23'),
('Fely', 'Trinidad', '0995-663-7642', 'Brgy. Catandaan, Nasugbu, Batangas', '2026-05-29 10:55:01'),
('Gerardo', 'Lumbao', '0938-866-1295', 'Brgy. Dayap, Nasugbu, Batangas', '2026-04-13 14:10:04'),
('Susan', 'Macaraig', '0967-672-3652', 'Tuy, Batangas', '2026-04-15 08:20:35'),
('Wilfredo', 'Panganiban', '0978-910-3504', 'Brgy. Malapad na Bato, Nasugbu, Batangas', '2026-03-26 11:20:47'),
('Aurora', 'Marasigan', '0979-471-7270', 'Brgy. Natipuan, Nasugbu, Batangas', '2026-04-14 08:15:14'),
('Teodoro', 'Ilagan', '0973-863-8042', 'Brgy. Reparo, Nasugbu, Batangas', '2026-02-19 13:40:14');

INSERT INTO customer_credits (customer_id, credit_limit, standing, notes, updated_by_staff_id, updated_at) VALUES
(5, 40000.00, 'Good', NULL, 2, '2026-05-24 17:45:54'),
(6, 25000.00, 'Good', NULL, 2, '2026-05-31 10:00:36'),
(7, 15000.00, 'Good', NULL, 2, '2026-04-09 15:25:31'),
(8, 60000.00, 'Good', NULL, 2, '2026-04-18 15:30:58'),
(9, 10000.00, 'Good', NULL, 2, '2026-04-28 08:20:08'),
(10, 30000.00, 'Watch', 'Paid late twice in May. Watch before extending.', 2, '2026-04-28 12:40:18'),
(11, 20000.00, 'Good', NULL, 2, '2026-04-07 14:10:39'),
(12, 50000.00, 'Good', NULL, 2, '2026-04-03 08:40:26'),
(13, 12000.00, 'Good', NULL, 2, '2026-04-04 16:15:22'),
(14, 35000.00, 'Good', NULL, 2, '2026-05-22 10:30:04'),
(15, 18000.00, 'Good', NULL, 2, '2026-06-07 11:25:19'),
(16, 25000.00, 'Hold', 'Cheque returned in July. On hold until the balance is cleared.', 2, '2026-06-04 16:15:25'),
(17, 8000.00, 'Good', NULL, 2, '2026-04-07 13:05:27'),
(18, 45000.00, 'Good', NULL, 2, '2026-03-14 09:35:16'),
(19, 0.00, 'Good', NULL, 2, '2026-05-25 11:35:07'),
(20, 22000.00, 'Good', NULL, 2, '2026-05-07 13:55:49'),
(23, 150000.00, 'Good', 'Contractor account, settles monthly.', 2, '2026-05-09 15:50:54'),
(24, 120000.00, 'Good', 'Site account, PO-backed.', 2, '2026-04-20 13:10:28'),
(26, 16000.00, 'Good', NULL, 2, '2026-04-26 11:10:34'),
(27, 9000.00, 'Good', NULL, 2, '2026-05-04 15:50:01');

INSERT INTO suppliers (supplier_name, contact_person, contact_number, email, address) VALUES
('Batangas Builders Depot', 'Ricky Alonzo', '0917-201-4455', 'orders@bbdepot.ph', 'Diversion Road, Balayan, Batangas'),
('Southern Tagalog Paints', 'Mila Cortez', '0918-334-9021', 'sales@stpaints.com.ph', 'Lipa City, Batangas'),
('Luzon Electrical Supply', 'Arnel Jacinto', '0920-777-1010', 'arnel@luzonelectrical.ph', 'Calamba, Laguna'),
('Metro Fasteners Inc.', 'Grace Tan', '0915-606-2020', 'grace.tan@metrofasteners.com', 'Valenzuela City, Metro Manila');
INSERT INTO brands (brand_name) VALUES ('Bosch'), ('3M'), ('Rain or Shine'), ('Davies'), ('Omni'), ('Firefly'), ('Tolsen'), ('Ingco'), ('Republic');
INSERT INTO categories (category_name) VALUES ('Paint & Finishes'), ('Fasteners'), ('Safety & Workwear');

INSERT INTO products (product_name, brand_id, category_id, unit_id, price, reorder_point, lead_time_days, safety_stock, reorder_mode, status, supplier_id, is_archived, created_at) VALUES
('Angle Grinder 4"', 6, 2, 1, 3250.00, 4, 14, 2, 'Manual', 'Active', 2, FALSE, '2026-01-25 15:40:02'),
('Circular Saw 7-1/4"', 1, 2, 1, 6800.00, 3, 14, 1, 'Manual', 'Active', 2, FALSE, '2026-02-17 16:35:44'),
('Impact Driver 18V', 2, 2, 1, 7900.00, 3, 14, 1, 'Manual', 'Active', 2, FALSE, '2026-02-01 09:05:31'),
('Jigsaw 600W', 6, 2, 1, 4100.00, 3, 14, 1, 'Manual', 'Active', 2, FALSE, '2026-01-17 14:05:23'),
('Heat Gun 2000W', 13, 2, 1, 1450.00, 3, 10, 1, 'Manual', 'Active', 2, FALSE, '2026-01-16 17:00:39'),
('Screwdriver Set 6pc', 3, 1, 10, 680.00, 10, 7, 3, 'Manual', 'Active', 3, FALSE, '2026-02-01 11:15:48'),
('Adjustable Wrench 10"', 12, 1, 1, 320.00, 12, 7, 4, 'Manual', 'Active', 3, FALSE, '2026-02-18 13:25:25'),
('Measuring Tape 5m', 3, 1, 1, 180.00, 25, 7, 8, 'Dynamic', 'Active', 3, FALSE, '2026-02-12 09:45:25'),
('Spirit Level 24"', 3, 1, 1, 540.00, 8, 7, 2, 'Manual', 'Active', 3, FALSE, '2026-02-02 08:05:03'),
('Hacksaw Frame', 12, 1, 1, 260.00, 10, 7, 3, 'Manual', 'Active', 3, FALSE, '2026-01-21 10:40:47'),
('Pliers Combination 8"', 13, 1, 1, 295.00, 15, 7, 5, 'Manual', 'Active', 3, FALSE, '2026-02-22 10:00:11'),
('Chisel Set 4pc', 3, 1, 10, 890.00, 5, 7, 2, 'Manual', 'Active', 3, FALSE, '2026-01-17 13:15:12'),
('Trowel Plastering', 12, 1, 1, 210.00, 15, 7, 5, 'Manual', 'Active', 3, FALSE, '2026-01-21 13:10:52'),
('PVC Pipe 1"', NULL, 3, 4, 185.00, 40, 5, 15, 'Dynamic', 'Active', 1, FALSE, '2026-02-02 13:30:50'),
('PVC Elbow 1/2"', NULL, 3, 1, 12.00, 100, 5, 40, 'Dynamic', 'Active', 1, FALSE, '2026-02-17 17:35:06'),
('PVC Solvent Cement 200cc', NULL, 3, 1, 95.00, 20, 5, 8, 'Manual', 'Active', 1, FALSE, '2026-01-22 11:35:41'),
('Teflon Tape', 7, 3, 9, 18.00, 60, 5, 20, 'Dynamic', 'Active', 1, FALSE, '2026-02-05 16:15:08'),
('Faucet Brass 1/2"', NULL, 3, 1, 420.00, 10, 7, 3, 'Manual', 'Active', 1, FALSE, '2026-02-10 12:05:10'),
('Water Closet Set', NULL, 3, 10, 4200.00, 2, 14, 1, 'Manual', 'Active', 1, FALSE, '2026-01-16 11:30:37'),
('THHN Wire 2.0mm 75m', NULL, 4, 9, 2350.00, 6, 10, 2, 'Manual', 'Active', 5, FALSE, '2026-02-22 12:50:13'),
('THHN Wire 3.5mm 75m', NULL, 4, 9, 3900.00, 4, 10, 2, 'Manual', 'Active', 5, FALSE, '2026-02-03 08:45:03'),
('LED Bulb 9W', 11, 4, 1, 120.00, 40, 5, 15, 'Dynamic', 'Active', 5, FALSE, '2026-01-23 11:40:50'),
('Outlet Duplex', 10, 4, 1, 85.00, 30, 5, 10, 'Manual', 'Active', 5, FALSE, '2026-01-29 08:00:18'),
('Switch 1-Gang', 10, 4, 1, 75.00, 30, 5, 10, 'Manual', 'Active', 5, FALSE, '2026-01-19 09:00:55'),
('Electrical Tape', 7, 4, 9, 45.00, 40, 5, 15, 'Dynamic', 'Active', 5, FALSE, '2026-02-04 09:00:43'),
('Extension Cord 5m', 11, 4, 1, 380.00, 8, 7, 3, 'Manual', 'Active', 5, FALSE, '2026-02-03 09:10:21'),
('Deformed Bar 10mm x 6m', NULL, 5, 1, 245.00, 100, 7, 40, 'Dynamic', 'Active', 3, FALSE, '2026-02-15 13:15:39'),
('Hollow Block 4"', NULL, 5, 1, 14.00, 500, 5, 200, 'Dynamic', 'Active', 3, FALSE, '2026-01-26 15:50:34'),
-- Sand and gravel are archived: six months of sales lines still point at them.
('Sand Washed', NULL, 5, 8, 180.00, 30, 5, 10, 'Manual', 'Inactive', 3, TRUE, '2026-02-20 10:15:13'),
('Gravel 3/4"', NULL, 5, 8, 210.00, 30, 5, 10, 'Manual', 'Inactive', 3, TRUE, '2026-01-31 09:20:43'),
('Plywood 1/2" 4x8', NULL, 5, 13, 780.00, 20, 7, 8, 'Manual', 'Active', 3, FALSE, '2026-01-29 11:25:42'),
('GI Sheet Corrugated 8ft', NULL, 5, 13, 460.00, 25, 7, 10, 'Manual', 'Active', 3, FALSE, '2026-02-12 09:45:33'),
('Elastomeric Roof Paint 4L', 8, 6, 12, 1450.00, 6, 10, 2, 'Manual', 'Active', 4, FALSE, '2026-02-15 16:00:08'),
('Enamel Paint Gloss 1L', 4, 6, 3, 320.00, 15, 10, 5, 'Manual', 'Active', 4, FALSE, '2026-02-14 14:10:38'),
('Primer Flat 4L', 9, 6, 12, 890.00, 8, 10, 3, 'Manual', 'Active', 4, FALSE, '2026-01-31 14:40:07'),
('Paint Roller 7"', NULL, 6, 1, 110.00, 20, 7, 8, 'Manual', 'Active', 4, FALSE, '2026-02-05 12:10:12'),
('Common Wire Nails 2"', 14, 7, 6, 78.00, 50, 7, 20, 'Dynamic', 'Active', 6, FALSE, '2026-02-18 15:30:59'),
('Concrete Nails 3"', 14, 7, 6, 95.00, 30, 7, 10, 'Dynamic', 'Active', 6, FALSE, '2026-01-19 16:40:33'),
('Tox Screw Set 100pc', NULL, 7, 11, 150.00, 15, 7, 5, 'Manual', 'Active', 6, FALSE, '2026-01-19 14:30:09'),
('Work Gloves Rubberised', 12, 8, 11, 65.00, 30, 7, 10, 'Manual', 'Active', 6, FALSE, '2026-02-05 17:05:12'),
('Safety Helmet', 12, 8, 1, 260.00, 10, 7, 3, 'Manual', 'Inactive', 6, TRUE, '2026-02-03 09:45:10'),
('Old Model Sander', 1, 2, 1, 2200.00, 2, 14, 0, 'Manual', 'Inactive', 2, TRUE, '2026-02-06 10:35:54'),
('Discontinued Enamel Ivory', 4, 6, 3, 290.00, 5, 10, 0, 'Manual', 'Active', 4, FALSE, '2026-02-07 14:00:59');
UPDATE products SET archived_at = '2026-05-12 10:15:00', archived_by_staff_id = 3 WHERE product_id = 49;
UPDATE products SET archived_at = '2026-07-03 15:40:00', archived_by_staff_id = 10 WHERE product_id = 50;
UPDATE products SET archived_at = '2026-09-15 09:00:00', archived_by_staff_id = 3
WHERE product_name IN ('Sand Washed', 'Gravel 3/4"');

INSERT INTO inventory (product_id, quantity_in_stock) VALUES
(9, 7),
(10, 3),
(11, 5),
(12, 2),
(13, 6),
(14, 22),
(15, 30),
(16, 41),
(17, 11),
(18, 16),
(19, 27),
(20, 6),
(21, 9),
(22, 120),
(23, 310),
(24, 34),
(25, 145),
(26, 14),
(27, 3),
(28, 9),
(29, 2),
(30, 96),
(31, 58),
(32, 47),
(33, 71),
(34, 12),
(35, 260),
(36, 1850),
(37, 44),
(38, 38),
(39, 26),
(40, 33),
(41, 8),
(42, 21),
(43, 5),
(44, 29),
(45, 120),
(46, 18),
(47, 24),
(48, 40),
(49, 13),
(50, 0),
(51, 0);

-- The sizes some products also sell in. Stock stays in the product's own
-- unit; the till offers these beside it.
INSERT INTO product_units (product_id, unit_name, units_per, price)
SELECT p.product_id, v.unit_name, v.units_per, v.price
FROM (
    SELECT 'Common Wire Nails 2"'  AS product_name, 'box'    AS unit_name,   5.000 AS units_per,  380.00 AS price UNION ALL
    SELECT 'Common Wire Nails 2"',                  'sack',                 25.000,              1850.00 UNION ALL
    SELECT 'Concrete Nails 3"',                     'box',                   5.000,               460.00 UNION ALL
    SELECT 'PVC Pipe 1/2"',                         'length',                3.000,               350.00 UNION ALL
    SELECT 'PVC Pipe 1"',                           'length',                3.000,               540.00 UNION ALL
    SELECT 'PVC Elbow 1/2"',                        'pack',                 25.000,               280.00 UNION ALL
    SELECT 'LED Bulb 9W',                           'box',                  10.000,              1150.00 UNION ALL
    SELECT 'Hollow Block 4"',                       'pallet',              100.000,              1350.00 UNION ALL
    SELECT 'Portland Cement 40kg',                  'pallet',               40.000,                 NULL UNION ALL
    SELECT 'Latex Paint White',                     'gallon',                4.000,              2900.00 UNION ALL
    SELECT 'Deformed Bar 10mm x 6m',                'bundle',               10.000,              2400.00
) AS v
JOIN products p ON p.product_name = v.product_name;

INSERT INTO purchase_orders (supplier_id, order_date, status) VALUES
(4, '2026-03-18 16:05:32', 'Received'),
(6, '2026-04-02 17:50:24', 'Received'),
(6, '2026-04-22 08:45:07', 'Received'),
(5, '2026-05-09 17:20:11', 'Cancelled'),
(4, '2026-05-27 08:10:25', 'Received'),
(2, '2026-06-15 17:35:07', 'Received'),
(1, '2026-07-06 15:05:23', 'Received'),
(5, '2026-07-28 16:40:54', 'Received'),
(2, '2026-08-19 17:15:59', 'Received'),
(6, '2026-09-08 12:30:56', 'Pending'),
(2, '2026-09-11 13:50:55', 'Pending');
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(4, 42, 20, 232.80),
(4, 44, 50, 71.45),
(4, 51, 100, 205.50),
(4, 43, 3, 642.76),
(5, 46, 50, 70.95),
(5, 47, 30, 98.96),
(5, 45, 20, 59.89),
(6, 48, 20, 43.38),
(6, 47, 20, 98.96),
(7, 33, 100, 28.95),
(7, 28, 10, 1845.26),
(7, 29, 10, 2605.99),
(7, 30, 50, 85.63),
(8, 42, 10, 232.80),
(8, 41, 10, 899.81),
(8, 51, 20, 205.50),
(9, 13, 3, 994.88),
(9, 7, 5, 393.31),
(9, 5, 20, 123.80),
(10, 26, 30, 268.54),
(10, 6, 30, 207.24),
(11, 29, 6, 2605.99),
(11, 31, 30, 57.10),
(11, 32, 10, 51.49),
(11, 34, 20, 275.65),
(12, 11, 6, 5730.16),
(12, 13, 3, 994.88),
(13, 45, 10, 59.89),
(13, 48, 20, 43.38),
(13, 46, 50, 70.95),
(14, 5, 100, 123.80),
(14, 13, 10, 994.88),
(14, 10, 10, 4846.65),
(14, 11, 2, 5730.16);

INSERT INTO sales (sale_id, customer_id, walk_in_name, cashier_staff_id, total_amount, discount, amount_paid, payment_method, payment_status, reference_no, sale_date, tax_registration, vat_rate, vatable_sale, vat_amount) VALUES
(11, 9, NULL, 4, 5440.00, 50.00, 5390.00, 'Cash', 'Paid', NULL, '2026-03-22 17:40:28', 'VAT', 12.00, 4812.50, 577.50),
(12, 8, NULL, 4, 15485.00, 0.00, 15485.00, 'Cash', 'Paid', NULL, '2026-03-22 10:05:38', 'VAT', 12.00, 13825.89, 1659.11),
(13, 20, NULL, 4, 4890.00, 50.00, 4840.00, 'COD', 'Paid', NULL, '2026-03-24 13:35:31', 'VAT', 12.00, 4321.43, 518.57),
(14, 19, NULL, 4, 17750.00, 0.00, 17800.00, 'Cash', 'Paid', NULL, '2026-03-26 08:15:11', 'VAT', 12.00, 15848.21, 1901.79),
(15, NULL, NULL, 4, 6800.00, 0.00, 6900.00, 'Cash', 'Paid', NULL, '2026-03-27 11:35:49', 'VAT', 12.00, 6071.43, 728.57),
(16, 14, NULL, 4, 2160.00, 0.00, 2160.00, 'Credit', 'Paid', NULL, '2026-03-28 14:15:01', 'VAT', 12.00, 1928.57, 231.43),
(17, 3, NULL, 4, 8130.00, 200.00, 8000.00, 'Cash', 'Paid', NULL, '2026-03-28 12:00:35', 'VAT', 12.00, 7080.36, 849.64),
(18, NULL, 'Tricycle driver', 4, 7800.00, 50.00, 7750.00, 'Cheque', 'Paid', 'CHQ-319464', '2026-03-29 10:10:34', 'VAT', 12.00, 6919.64, 830.36),
(19, 26, NULL, 4, 7405.00, 200.00, 7300.00, 'Cash', 'Paid', NULL, '2026-03-31 13:45:58', 'VAT', 12.00, 6433.04, 771.96),
(20, 18, NULL, 4, 7900.00, 0.00, 7900.00, 'PayMaya', 'Paid', 'PM-402162', '2026-04-03 12:55:03', 'VAT', 12.00, 7053.57, 846.43),
(21, 12, NULL, 4, 4810.00, 200.00, 0.00, 'COD', 'Unpaid', NULL, '2026-04-04 15:20:57', 'VAT', 12.00, 4116.07, 493.93),
(22, 20, NULL, 4, 3670.00, 100.00, 3570.00, 'Credit', 'Paid', NULL, '2026-04-05 14:05:47', 'VAT', 12.00, 3187.50, 382.50),
(23, 18, NULL, 4, 840.00, 0.00, 840.00, 'PayMaya', 'Paid', 'PM-536400', '2026-04-05 17:25:43', 'VAT', 12.00, 750.00, 90.00),
(24, 11, NULL, 4, 580.00, 0.00, 580.00, 'Credit', 'Paid', NULL, '2026-04-06 09:50:11', 'VAT', 12.00, 517.86, 62.14),
(25, 5, NULL, 4, 12425.00, 0.00, 12425.00, 'GCash', 'Paid', 'GC-633066', '2026-04-06 13:45:31', 'VAT', 12.00, 11093.75, 1331.25),
(26, 20, NULL, 4, 8920.00, 150.00, 8770.00, 'Credit', 'Paid', NULL, '2026-04-11 11:10:05', 'VAT', 12.00, 7830.36, 939.64),
(27, 3, NULL, 4, 6342.00, 0.00, 6342.00, 'Bank Transfer', 'Paid', 'BT-691689', '2026-04-21 09:15:27', 'VAT', 12.00, 5662.50, 679.50),
(28, NULL, 'Mang Tonyo', 4, 6120.00, 50.00, 6100.00, 'Cash', 'Paid', NULL, '2026-04-27 09:50:29', 'VAT', 12.00, 5419.64, 650.36),
(29, 29, NULL, 4, 5380.00, 0.00, 5380.00, 'COD', 'Paid', NULL, '2026-04-28 15:20:11', 'VAT', 12.00, 4803.57, 576.43),
(30, 22, NULL, 4, 9365.00, 0.00, 9365.00, 'Bank Transfer', 'Paid', 'BT-494181', '2026-04-29 14:10:57', 'VAT', 12.00, 8361.61, 1003.39),
(31, NULL, 'Ate Baby', 4, 18180.00, 50.00, 18130.00, 'Bank Transfer', 'Paid', 'BT-732987', '2026-05-06 13:40:35', 'VAT', 12.00, 16187.50, 1942.50),
(32, 28, NULL, 4, 5600.00, 0.00, 5600.00, 'COD', 'Paid', NULL, '2026-05-07 12:05:35', 'VAT', 12.00, 5000.00, 600.00),
(33, 7, NULL, 4, 6000.00, 0.00, 6000.00, 'Cash', 'Paid', NULL, '2026-05-08 10:10:55', 'VAT', 12.00, 5357.14, 642.86),
(34, 19, NULL, 4, 7980.00, 150.00, 7830.00, 'GCash', 'Paid', 'GC-304441', '2026-05-11 15:30:59', 'VAT', 12.00, 6991.07, 838.93),
(35, 27, NULL, 4, 240.00, 0.00, 240.00, 'Credit', 'Paid', NULL, '2026-05-11 16:30:52', 'VAT', 12.00, 214.29, 25.71),
(36, 11, NULL, 4, 8910.00, 150.00, 8760.00, 'Credit', 'Paid', NULL, '2026-05-12 15:05:17', 'VAT', 12.00, 7821.43, 938.57),
(37, 19, NULL, 4, 180.00, 0.00, 180.00, 'Credit', 'Paid', NULL, '2026-05-13 12:00:42', 'VAT', 12.00, 160.71, 19.29),
(38, 22, NULL, 4, 9838.00, 0.00, 9838.00, 'Cheque', 'Paid', 'CHQ-294267', '2026-05-14 14:35:06', 'VAT', 12.00, 8783.93, 1054.07),
(39, NULL, NULL, 4, 2842.00, 100.00, 2742.00, 'GCash', 'Paid', 'GC-917467', '2026-05-16 17:55:13', 'VAT', 12.00, 2448.21, 293.79),
(40, 10, NULL, 4, 780.00, 0.00, 780.00, 'Cash', 'Paid', NULL, '2026-05-16 16:10:44', 'VAT', 12.00, 696.43, 83.57),
(41, 16, NULL, 4, 2390.00, 0.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-05-17 14:20:57', 'VAT', 12.00, 2133.93, 256.07),
(42, 3, NULL, 4, 6875.00, 0.00, 6875.00, 'Cash', 'Paid', NULL, '2026-05-17 12:55:47', 'VAT', 12.00, 6138.39, 736.61),
(43, NULL, 'Mang Tonyo', 4, 20530.00, 200.00, 20330.00, 'COD', 'Paid', NULL, '2026-05-17 15:25:10', 'VAT', 12.00, 18151.79, 2178.21),
(44, 13, NULL, 4, 1125.00, 0.00, 1125.00, 'Cash', 'Paid', NULL, '2026-05-18 11:20:20', 'VAT', 12.00, 1004.46, 120.54),
(45, 3, NULL, 4, 4861.00, 0.00, 4861.00, 'Cash', 'Paid', NULL, '2026-05-18 16:45:13', 'VAT', 12.00, 4340.18, 520.82),
(46, 22, NULL, 4, 8340.00, 0.00, 8340.00, 'COD', 'Paid', NULL, '2026-05-20 11:15:06', 'VAT', 12.00, 7446.43, 893.57),
(47, 17, NULL, 4, 3780.00, 150.00, 3630.00, 'Credit', 'Paid', NULL, '2026-05-20 15:20:03', 'VAT', 12.00, 3241.07, 388.93),
(48, NULL, 'Mang Tonyo', 4, 12580.00, 0.00, 12580.00, 'COD', 'Paid', NULL, '2026-05-21 08:00:02', 'VAT', 12.00, 11232.14, 1347.86),
(49, 12, NULL, 4, 6610.00, 100.00, 6510.00, 'Cash', 'Paid', NULL, '2026-05-24 14:00:54', 'VAT', 12.00, 5812.50, 697.50),
(50, 22, NULL, 4, 6700.00, 0.00, 6700.00, 'COD', 'Paid', NULL, '2026-05-24 16:15:48', 'VAT', 12.00, 5982.14, 717.86),
(51, 15, NULL, 4, 1010.00, 0.00, 1100.00, 'Cash', 'Paid', NULL, '2026-05-25 17:55:59', 'VAT', 12.00, 901.79, 108.21),
(52, 9, NULL, 4, 260.00, 0.00, 260.00, 'Bank Transfer', 'Paid', 'BT-536807', '2026-05-27 10:50:55', 'VAT', 12.00, 232.14, 27.86),
(53, 8, NULL, 4, 3260.00, 50.00, 3210.00, 'Cash', 'Paid', NULL, '2026-05-27 11:20:41', 'VAT', 12.00, 2866.07, 343.93),
(54, 17, NULL, 4, 3560.00, 0.00, 3560.00, 'GCash', 'Paid', 'GC-974536', '2026-05-29 12:00:03', 'VAT', 12.00, 3178.57, 381.43),
(55, 27, NULL, 4, 4350.00, 0.00, 4350.00, 'Credit', 'Paid', NULL, '2026-05-30 12:45:27', 'VAT', 12.00, 3883.93, 466.07),
(56, 9, NULL, 4, 1485.00, 150.00, 1335.00, 'GCash', 'Paid', 'GC-956130', '2026-06-02 15:25:33', 'VAT', 12.00, 1191.96, 143.04),
(57, 3, NULL, 4, 2050.00, 0.00, 2050.00, 'COD', 'Paid', NULL, '2026-06-03 15:40:47', 'VAT', 12.00, 1830.36, 219.64),
(58, 18, NULL, 4, 360.00, 0.00, 306.00, 'Credit', 'Partial', NULL, '2026-06-08 15:40:28', 'VAT', 12.00, 321.43, 38.57),
(59, 14, NULL, 4, 7279.00, 0.00, 7279.00, 'Cash', 'Paid', NULL, '2026-06-08 13:35:31', 'VAT', 12.00, 6499.11, 779.89),
(60, NULL, NULL, 4, 10914.00, 0.00, 10914.00, 'GCash', 'Paid', 'GC-712760', '2026-06-08 17:35:01', 'VAT', 12.00, 9744.64, 1169.36),
(61, 22, NULL, 4, 8804.00, 0.00, 8804.00, 'COD', 'Paid', NULL, '2026-06-12 10:35:33', 'VAT', 12.00, 7860.71, 943.29),
(62, 24, NULL, 4, 2520.00, 0.00, 2520.00, 'Cash', 'Paid', NULL, '2026-06-13 15:40:29', 'VAT', 12.00, 2250.00, 270.00),
(63, 7, NULL, 4, 3320.00, 0.00, 3320.00, 'GCash', 'Paid', 'GC-344932', '2026-06-14 14:10:37', 'VAT', 12.00, 2964.29, 355.71),
(64, 26, NULL, 4, 6800.00, 100.00, 6700.00, 'Credit', 'Paid', NULL, '2026-06-17 10:15:06', 'VAT', 12.00, 5982.14, 717.86),
(65, 3, NULL, 4, 3735.00, 0.00, 3735.00, 'PayMaya', 'Paid', 'PM-781304', '2026-06-19 10:55:43', 'VAT', 12.00, 3334.82, 400.18),
(66, 17, NULL, 4, 520.00, 0.00, 520.00, 'Credit', 'Paid', NULL, '2026-06-20 09:50:50', 'VAT', 12.00, 464.29, 55.71),
(67, 17, NULL, 4, 5400.00, 0.00, 5400.00, 'GCash', 'Paid', 'GC-859189', '2026-06-25 15:05:54', 'VAT', 12.00, 4821.43, 578.57),
(68, 14, NULL, 4, 16520.00, 0.00, 16520.00, 'Cash', 'Paid', NULL, '2026-06-26 14:45:06', 'VAT', 12.00, 14750.00, 1770.00),
(69, 20, NULL, 4, 1290.00, 50.00, 1240.00, 'PayMaya', 'Paid', 'PM-772067', '2026-06-27 17:55:18', 'VAT', 12.00, 1107.14, 132.86),
(70, 8, NULL, 4, 13270.00, 200.00, 13070.00, 'GCash', 'Paid', 'GC-663814', '2026-06-28 14:40:45', 'VAT', 12.00, 11669.64, 1400.36),
(71, NULL, NULL, 4, 2100.00, 150.00, 1950.00, 'Cash', 'Paid', NULL, '2026-06-28 10:00:25', 'VAT', 12.00, 1741.07, 208.93),
(72, 1, NULL, 4, 960.00, 0.00, 960.00, 'Cheque', 'Paid', 'CHQ-769581', '2026-06-29 12:15:23', 'VAT', 12.00, 857.14, 102.86),
(73, NULL, 'Ate Baby', 4, 312.00, 0.00, 312.00, 'Cash', 'Paid', NULL, '2026-07-01 16:25:55', 'VAT', 12.00, 278.57, 33.43),
(74, 25, NULL, 4, 1470.00, 0.00, 1470.00, 'GCash', 'Paid', 'GC-550053', '2026-07-02 09:30:58', 'VAT', 12.00, 1312.50, 157.50),
(75, 11, NULL, 4, 5790.00, 200.00, 5590.00, 'Credit', 'Paid', NULL, '2026-07-03 16:10:36', 'VAT', 12.00, 4991.07, 598.93),
(76, 12, NULL, 4, 7260.00, 0.00, 7260.00, 'Credit', 'Paid', NULL, '2026-07-09 10:30:53', 'VAT', 12.00, 6482.14, 777.86),
(77, 26, NULL, 4, 21700.00, 100.00, 21600.00, 'COD', 'Paid', NULL, '2026-07-10 12:10:56', 'VAT', 12.00, 19285.71, 2314.29),
(78, 24, NULL, 4, 6080.00, 0.00, 3648.00, 'Credit', 'Partial', NULL, '2026-07-12 11:05:01', 'VAT', 12.00, 5428.57, 651.43),
(79, 21, NULL, 4, 24025.00, 0.00, 24025.00, 'GCash', 'Paid', 'GC-801851', '2026-07-14 14:40:38', 'VAT', 12.00, 21450.89, 2574.11),
(80, 24, NULL, 4, 644.00, 0.00, 644.00, 'GCash', 'Paid', 'GC-426479', '2026-07-18 08:35:54', 'VAT', 12.00, 575.00, 69.00),
(81, 15, NULL, 4, 5420.00, 0.00, 5420.00, 'Credit', 'Paid', NULL, '2026-07-19 16:00:01', 'VAT', 12.00, 4839.29, 580.71),
(82, 29, NULL, 4, 914.00, 0.00, 914.00, 'COD', 'Paid', NULL, '2026-07-20 17:55:25', 'VAT', 12.00, 816.07, 97.93),
(83, 21, NULL, 4, 5970.00, 0.00, 6000.00, 'Cash', 'Paid', NULL, '2026-07-20 12:15:17', 'VAT', 12.00, 5330.36, 639.64),
(84, 1, NULL, 4, 1080.00, 100.00, 980.00, 'COD', 'Paid', NULL, '2026-07-23 12:45:49', 'VAT', 12.00, 875.00, 105.00),
(85, 14, NULL, 4, 630.00, 0.00, 630.00, 'Cash', 'Paid', NULL, '2026-07-23 15:50:19', 'VAT', 12.00, 562.50, 67.50),
(86, 1, NULL, 4, 240.00, 0.00, 240.00, 'Bank Transfer', 'Paid', 'BT-613794', '2026-07-26 13:55:19', 'VAT', 12.00, 214.29, 25.71),
(87, 11, NULL, 4, 31105.00, 150.00, 30955.00, 'COD', 'Paid', NULL, '2026-07-26 14:10:26', 'VAT', 12.00, 27638.39, 3316.61),
(88, 10, NULL, 4, 750.00, 0.00, 225.00, 'Credit', 'Partial', NULL, '2026-07-27 10:55:14', 'VAT', 12.00, 669.64, 80.36),
(89, 9, NULL, 4, 12526.00, 0.00, 12600.00, 'Cash', 'Paid', NULL, '2026-07-27 17:40:07', 'VAT', 12.00, 11183.93, 1342.07),
(90, NULL, NULL, 4, 13900.00, 150.00, 13750.00, 'Cash', 'Paid', NULL, '2026-07-30 12:45:49', 'VAT', 12.00, 12276.79, 1473.21),
(91, 7, NULL, 4, 2660.00, 0.00, 2700.00, 'Cash', 'Paid', NULL, '2026-07-31 09:30:14', 'VAT', 12.00, 2375.00, 285.00),
(92, 21, NULL, 4, 928.00, 0.00, 928.00, 'Cheque', 'Paid', 'CHQ-168842', '2026-08-03 11:25:55', 'VAT', 12.00, 828.57, 99.43),
(93, 14, NULL, 4, 16980.00, 0.00, 16980.00, 'Credit', 'Paid', NULL, '2026-08-03 13:00:34', 'VAT', 12.00, 15160.71, 1819.29),
(94, NULL, NULL, 4, 1260.00, 0.00, 1300.00, 'Cash', 'Paid', NULL, '2026-08-04 12:35:55', 'VAT', 12.00, 1125.00, 135.00),
(95, 4, NULL, 4, 23300.00, 0.00, 23300.00, 'COD', 'Paid', NULL, '2026-08-06 15:50:20', 'VAT', 12.00, 20803.57, 2496.43),
(96, 5, NULL, 4, 5652.00, 200.00, 5452.00, 'Cash', 'Paid', NULL, '2026-08-08 16:05:57', 'VAT', 12.00, 4867.86, 584.14),
(97, 12, NULL, 4, 4350.00, 0.00, 4350.00, 'COD', 'Paid', NULL, '2026-08-12 08:15:32', 'VAT', 12.00, 3883.93, 466.07),
(98, 9, NULL, 4, 384.00, 0.00, 384.00, 'Cheque', 'Paid', 'CHQ-839553', '2026-08-13 13:15:14', 'VAT', 12.00, 342.86, 41.14),
(99, 9, NULL, 4, 8450.00, 0.00, 8500.00, 'Cash', 'Paid', NULL, '2026-08-14 14:30:51', 'VAT', 12.00, 7544.64, 905.36),
(100, NULL, 'Aling Nena', 4, 10690.00, 0.00, 10690.00, 'Cash', 'Paid', NULL, '2026-08-18 14:40:45', 'VAT', 12.00, 9544.64, 1145.36),
(101, 22, NULL, 4, 9750.00, 0.00, 9750.00, 'Bank Transfer', 'Paid', 'BT-459817', '2026-08-18 11:55:38', 'VAT', 12.00, 8705.36, 1044.64),
(102, 7, NULL, 4, 26980.00, 0.00, 27000.00, 'Cash', 'Paid', NULL, '2026-08-18 14:40:09', 'VAT', 12.00, 24089.29, 2890.71),
(103, 23, NULL, 4, 51300.00, 0.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-08-22 12:10:20', 'VAT', 12.00, 45803.57, 5496.43),
(104, 6, NULL, 4, 6050.00, 0.00, 6050.00, 'GCash', 'Paid', 'GC-107771', '2026-08-26 10:45:49', 'VAT', 12.00, 5401.79, 648.21),
(105, NULL, 'Mang Tonyo', 4, 10319.00, 0.00, 10319.00, 'Cash', 'Paid', NULL, '2026-08-27 09:15:15', 'VAT', 12.00, 9213.39, 1105.61),
(106, 13, NULL, 4, 13200.00, 0.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-08-31 15:10:11', 'VAT', 12.00, 11785.71, 1414.29),
(107, 3, NULL, 4, 380.00, 0.00, 380.00, 'COD', 'Paid', NULL, '2026-09-01 15:55:46', 'VAT', 12.00, 339.29, 40.71),
(108, 8, NULL, 4, 13215.00, 0.00, 6607.50, 'Credit', 'Partial', NULL, '2026-09-03 09:40:17', 'VAT', 12.00, 11799.11, 1415.89),
(109, 29, NULL, 4, 25815.00, 0.00, 25815.00, 'Cash', 'Paid', NULL, '2026-09-03 14:05:06', 'VAT', 12.00, 23049.11, 2765.89),
(110, 7, NULL, 4, 11500.00, 50.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-09-04 15:50:35', 'VAT', 12.00, 10223.21, 1226.79),
(111, 13, NULL, 4, 2670.00, 0.00, 2670.00, 'Cash', 'Paid', NULL, '2026-09-04 17:30:21', 'VAT', 12.00, 2383.93, 286.07),
(112, 6, NULL, 4, 4515.00, 150.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-09-05 12:05:04', 'VAT', 12.00, 3897.32, 467.68),
(113, 5, NULL, 4, 1374.00, 0.00, 0.00, 'Credit', 'Unpaid', NULL, '2026-09-08 14:20:29', 'VAT', 12.00, 1226.79, 147.21),
(114, NULL, 'Tricycle driver', 4, 495.00, 0.00, 495.00, 'GCash', 'Paid', 'GC-976658', '2026-09-08 15:15:46', 'VAT', 12.00, 441.96, 53.04),
(115, 6, NULL, 4, 9750.00, 0.00, 4875.00, 'Credit', 'Partial', NULL, '2026-09-09 10:10:31', 'VAT', 12.00, 8705.36, 1044.64);
INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES
(11, 14, 8, 680.00),
(12, 10, 2, 6800.00),
(12, 48, 29, 65.00),
(13, 47, 7, 150.00),
(13, 42, 12, 320.00),
(14, 29, 2, 3900.00),
(14, 1, 1, 8500.00),
(14, 41, 1, 1450.00),
(15, 10, 1, 6800.00),
(16, 17, 4, 540.00),
(17, 5, 6, 180.00),
(17, 28, 3, 2350.00),
(18, 39, 10, 780.00),
(19, 33, 50, 45.00),
(19, 35, 11, 245.00),
(19, 51, 6, 290.00),
(19, 30, 6, 120.00),
(20, 11, 1, 7900.00),
(21, 13, 3, 1450.00),
(21, 40, 1, 460.00),
(22, 26, 3, 420.00),
(22, 51, 7, 290.00),
(22, 34, 1, 380.00),
(23, 3, 7, 120.00),
(24, 51, 2, 290.00),
(25, 39, 10, 780.00),
(25, 26, 1, 420.00),
(25, 38, 1, 210.00),
(25, 31, 47, 85.00),
(26, 39, 9, 780.00),
(26, 34, 5, 380.00),
(27, 25, 49, 18.00),
(27, 39, 7, 780.00),
(28, 14, 9, 680.00),
(29, 12, 1, 4100.00),
(29, 15, 4, 320.00),
(30, 41, 2, 1450.00),
(30, 18, 6, 260.00),
(30, 22, 3, 185.00),
(30, 32, 58, 75.00),
(31, 19, 4, 295.00),
(31, 1, 2, 8500.00),
(32, 9, 1, 3250.00),
(32, 28, 1, 2350.00),
(33, 4, 8, 750.00),
(34, 37, 11, 180.00),
(34, 34, 4, 380.00),
(34, 51, 8, 290.00),
(34, 17, 4, 540.00),
(35, 30, 2, 120.00),
(36, 17, 8, 540.00),
(36, 20, 3, 890.00),
(36, 15, 6, 320.00),
(37, 37, 1, 180.00),
(38, 23, 9, 12.00),
(38, 27, 1, 4200.00),
(38, 14, 6, 680.00),
(38, 51, 5, 290.00),
(39, 38, 3, 210.00),
(39, 36, 38, 14.00),
(39, 26, 4, 420.00),
(40, 18, 3, 260.00),
(41, 43, 1, 890.00),
(41, 4, 2, 750.00),
(42, 7, 10, 620.00),
(42, 33, 15, 45.00),
(43, 9, 3, 3250.00),
(43, 13, 3, 1450.00),
(43, 51, 11, 290.00),
(43, 17, 6, 540.00),
(44, 32, 15, 75.00),
(45, 25, 57, 18.00),
(45, 38, 12, 210.00),
(45, 51, 2, 290.00),
(45, 35, 3, 245.00),
(46, 16, 12, 180.00),
(46, 3, 6, 120.00),
(46, 46, 42, 95.00),
(46, 35, 6, 245.00),
(47, 34, 9, 380.00),
(47, 3, 3, 120.00),
(48, 20, 12, 890.00),
(48, 34, 5, 380.00),
(49, 17, 8, 540.00),
(49, 38, 4, 210.00),
(49, 41, 1, 1450.00),
(50, 27, 1, 4200.00),
(50, 47, 8, 150.00),
(50, 6, 5, 260.00),
(51, 16, 5, 180.00),
(51, 44, 1, 110.00),
(52, 6, 1, 260.00),
(53, 30, 12, 120.00),
(53, 6, 7, 260.00),
(54, 43, 4, 890.00),
(55, 13, 3, 1450.00),
(56, 5, 4, 180.00),
(56, 33, 17, 45.00),
(57, 47, 4, 150.00),
(57, 41, 1, 1450.00),
(58, 5, 2, 180.00),
(59, 24, 48, 95.00),
(59, 23, 12, 12.00),
(59, 16, 3, 180.00),
(59, 22, 11, 185.00),
(60, 36, 7, 14.00),
(60, 25, 57, 18.00),
(60, 43, 11, 890.00),
(61, 30, 3, 120.00),
(61, 43, 1, 890.00),
(61, 28, 3, 2350.00),
(61, 25, 28, 18.00),
(62, 26, 6, 420.00),
(63, 6, 4, 260.00),
(63, 34, 6, 380.00),
(64, 10, 1, 6800.00),
(65, 5, 10, 180.00),
(65, 33, 43, 45.00),
(66, 48, 8, 65.00),
(67, 2, 12, 450.00),
(68, 48, 32, 65.00),
(68, 4, 10, 750.00),
(68, 7, 8, 620.00),
(68, 16, 11, 180.00),
(69, 4, 1, 750.00),
(69, 16, 3, 180.00),
(70, 24, 46, 95.00),
(70, 43, 2, 890.00),
(70, 20, 8, 890.00),
(71, 38, 2, 210.00),
(71, 21, 8, 210.00),
(72, 42, 3, 320.00),
(73, 23, 26, 12.00),
(74, 21, 7, 210.00),
(75, 41, 3, 1450.00),
(75, 30, 12, 120.00),
(76, 28, 3, 2350.00),
(76, 38, 1, 210.00),
(77, 1, 2, 8500.00),
(77, 28, 2, 2350.00),
(78, 26, 2, 420.00),
(78, 51, 4, 290.00),
(78, 14, 6, 680.00),
(79, 35, 7, 245.00),
(79, 51, 9, 290.00),
(79, 11, 2, 7900.00),
(79, 45, 50, 78.00),
(80, 36, 46, 14.00),
(81, 18, 5, 260.00),
(81, 2, 1, 450.00),
(81, 3, 11, 120.00),
(81, 28, 1, 2350.00),
(82, 25, 33, 18.00),
(82, 42, 1, 320.00),
(83, 48, 25, 65.00),
(83, 51, 11, 290.00),
(83, 35, 3, 245.00),
(83, 21, 2, 210.00),
(84, 30, 9, 120.00),
(85, 2, 1, 450.00),
(85, 37, 1, 180.00),
(86, 30, 2, 120.00),
(87, 10, 3, 6800.00),
(87, 38, 1, 210.00),
(87, 29, 2, 3900.00),
(87, 35, 11, 245.00),
(88, 47, 5, 150.00),
(89, 29, 3, 3900.00),
(89, 36, 59, 14.00),
(90, 47, 2, 150.00),
(90, 10, 2, 6800.00),
(91, 21, 9, 210.00),
(91, 44, 7, 110.00),
(92, 25, 16, 18.00),
(92, 15, 2, 320.00),
(93, 17, 6, 540.00),
(93, 5, 8, 180.00),
(93, 12, 3, 4100.00),
(94, 38, 6, 210.00),
(95, 10, 3, 6800.00),
(95, 41, 2, 1450.00),
(96, 16, 8, 180.00),
(96, 45, 54, 78.00),
(97, 41, 3, 1450.00),
(98, 23, 32, 12.00),
(99, 9, 2, 3250.00),
(99, 14, 2, 680.00),
(99, 19, 2, 295.00),
(100, 41, 1, 1450.00),
(100, 4, 6, 750.00),
(100, 42, 12, 320.00),
(100, 5, 5, 180.00),
(101, 9, 3, 3250.00),
(102, 1, 3, 8500.00),
(102, 22, 8, 185.00),
(103, 35, 100, 245.00),
(103, 36, 800, 14.00),
(103, 6, 60, 260.00),
(104, 33, 50, 45.00),
(104, 34, 10, 380.00),
(105, 22, 3, 185.00),
(105, 25, 48, 18.00),
(105, 20, 10, 890.00),
(106, 1, 1, 8500.00),
(106, 32, 2, 2350.00),
(107, 34, 1, 380.00),
(108, 27, 1, 4200.00),
(108, 32, 37, 75.00),
(108, 21, 9, 210.00),
(108, 13, 3, 1450.00),
(109, 10, 2, 6800.00),
(109, 20, 10, 890.00),
(109, 48, 51, 65.00),
(110, 1, 1, 8500.00),
(110, 4, 4, 750.00),
(111, 43, 3, 890.00),
(112, 35, 11, 245.00),
(112, 18, 7, 260.00),
(113, 25, 53, 18.00),
(113, 21, 2, 210.00),
(114, 33, 11, 45.00),
(115, 9, 3, 3250.00);
INSERT INTO credit_payments (customer_id, sale_id, amount, payment_method, reference_no, received_by_staff_id, payment_date) VALUES
(20, 13, 4840.00, 'Cash', NULL, 5, '2026-03-27 14:18:17'),
(14, 16, 2160.00, 'Bank Transfer', NULL, 4, '2026-04-22 14:15:01'),
(20, 22, 3570.00, 'Bank Transfer', NULL, 4, '2026-04-20 14:05:47'),
(11, 24, 580.00, 'GCash', NULL, 4, '2026-04-16 09:50:11'),
(20, 26, 8770.00, 'Bank Transfer', NULL, 4, '2026-04-26 11:10:05'),
(29, 29, 5380.00, 'Cash', NULL, 5, '2026-05-01 15:17:57'),
(28, 32, 5600.00, 'Cash', NULL, 5, '2026-05-09 16:02:06'),
(27, 35, 240.00, 'Bank Transfer', NULL, 4, '2026-05-17 16:30:52'),
(11, 36, 8760.00, 'Bank Transfer', NULL, 4, '2026-05-23 15:05:17'),
(19, 37, 180.00, 'Cash', NULL, 4, '2026-06-02 12:00:42'),
(NULL, 43, 20330.00, 'Cash', NULL, 5, '2026-05-18 15:03:23'),
(22, 46, 8340.00, 'Cash', NULL, 5, '2026-05-22 13:12:01'),
(17, 47, 3630.00, 'GCash', NULL, 4, '2026-06-02 15:20:03'),
(NULL, 48, 12580.00, 'Cash', NULL, 5, '2026-05-24 14:48:52'),
(22, 50, 6700.00, 'Cash', NULL, 5, '2026-05-26 16:07:38'),
(27, 55, 4350.00, 'GCash', NULL, 4, '2026-06-04 12:45:27'),
(3, 57, 2050.00, 'Cash', NULL, 5, '2026-06-06 15:03:45'),
(18, 58, 306.00, 'Cash', NULL, 4, '2026-06-08 15:40:28'),
(22, 61, 8804.00, 'Cash', NULL, 5, '2026-06-14 10:14:06'),
(26, 64, 6700.00, 'GCash', NULL, 4, '2026-06-22 10:15:06'),
(17, 66, 520.00, 'Cash', NULL, 4, '2026-07-10 09:50:50'),
(11, 75, 5590.00, 'GCash', NULL, 4, '2026-07-22 16:10:36'),
(12, 76, 7260.00, 'GCash', NULL, 4, '2026-07-21 10:30:53'),
(26, 77, 21600.00, 'Cash', NULL, 5, '2026-07-11 10:13:36'),
(24, 78, 3648.00, 'Cash', NULL, 4, '2026-07-12 11:05:01'),
(15, 81, 5420.00, 'GCash', NULL, 4, '2026-07-26 16:00:01'),
(29, 82, 914.00, 'Cash', NULL, 5, '2026-07-21 12:00:00'),
(1, 84, 980.00, 'Cash', NULL, 5, '2026-07-24 12:09:15'),
(11, 87, 30955.00, 'Cash', NULL, 5, '2026-07-29 17:26:00'),
(10, 88, 225.00, 'Cash', NULL, 4, '2026-07-27 10:55:14'),
(14, 93, 16980.00, 'Bank Transfer', NULL, 4, '2026-08-23 13:00:34'),
(4, 95, 23300.00, 'Cash', NULL, 5, '2026-08-08 11:29:36'),
(12, 97, 4350.00, 'Cash', NULL, 5, '2026-08-13 17:04:40'),
(3, 107, 380.00, 'Cash', NULL, 5, '2026-09-04 13:23:07'),
(8, 108, 6607.50, 'Cash', NULL, 4, '2026-09-03 09:40:17'),
(6, 115, 4875.00, 'Cash', NULL, 4, '2026-09-09 10:10:31');

UPDATE sales SET is_archived = TRUE, archived_at = DATE_ADD(sale_date, INTERVAL 40 MINUTE), archived_by_staff_id = 2 WHERE sale_id IN (62, 68);

INSERT INTO deliveries (sale_id, delivery_staff_id, delivery_address, contact_name, contact_phone, status, remarks, booked_date, scheduled_date, delivered_at, is_archived, archived_at, archived_by_staff_id) VALUES
(13, 5, 'Brgy. Bunducan, Nasugbu, Batangas', 'Arturo Salazar', '0978-574-6318', 'Delivered', 'Rescheduled by customer', '2026-03-24', '2026-03-27 13:00:17', '2026-03-27 14:18:17', TRUE, '2026-09-12 02:00:00', NULL),
(19, 5, 'Brgy. Dayap, Nasugbu, Batangas', 'Gerardo Lumbao', '0931-216-7099', 'Delivered', NULL, '2026-03-31', '2026-04-02 09:00:44', '2026-04-02 10:10:44', TRUE, '2026-09-12 02:00:00', NULL),
(21, 5, 'Brgy. Kaylaway, Nasugbu, Batangas', 'Dominador Torres', '0995-376-8737', 'Failed', 'Deliver before noon', '2026-04-04', '2026-04-07 10:00:58', NULL, FALSE, NULL, NULL),
(29, 5, 'Brgy. Natipuan, Nasugbu, Batangas', 'Aurora Marasigan', '0924-564-7329', 'Delivered', 'Truck breakdown, moved to next day', '2026-04-28', '2026-05-01 13:00:57', '2026-05-01 15:17:57', TRUE, '2026-09-12 02:00:00', NULL),
(32, 5, 'Brgy. Malapad na Bato, Nasugbu, Batangas', 'Wilfredo Panganiban', '0957-639-9653', 'Delivered', NULL, '2026-05-07', '2026-05-09 14:00:06', '2026-05-09 16:02:06', TRUE, '2026-09-12 02:00:00', NULL),
(39, 5, 'Poblacion, Nasugbu, Batangas', 'Customer', '0936-629-5110', 'Delivered', NULL, '2026-05-16', '2026-05-18 10:00:10', '2026-05-18 11:28:10', TRUE, '2026-09-12 02:00:00', NULL),
(43, 5, 'Caloocan City, Metro Manila', 'Mang Tonyo', '0989-158-8397', 'Delivered', 'Call on arrival', '2026-05-17', '2026-05-18 13:00:23', '2026-05-18 15:03:23', TRUE, '2026-09-12 02:00:00', NULL),
(41, 5, 'Brgy. Banilad, Nasugbu, Batangas', 'Benjamin Aquino', '0947-778-6092', 'Delivered', NULL, '2026-05-17', '2026-05-18 09:00:38', '2026-05-18 10:18:38', FALSE, NULL, NULL),
(44, 5, 'Brgy. Munting Indan, Nasugbu, Batangas', 'Evelyn Flores', '0961-762-9463', 'Delivered', NULL, '2026-05-18', '2026-05-19 10:00:53', '2026-05-19 11:15:53', TRUE, '2026-09-12 02:00:00', NULL),
(46, 5, 'Brgy. Calayo, Nasugbu, Batangas', 'Danilo Manalo', '0968-745-1340', 'Delivered', 'Second floor, no lift', '2026-05-20', '2026-05-22 13:00:01', '2026-05-22 13:12:01', TRUE, '2026-09-12 02:00:00', NULL),
(48, 5, 'Poblacion, Nasugbu, Batangas', 'Mang Tonyo', '0930-596-3858', 'Delivered', 'Truck breakdown, moved to next day', '2026-05-21', '2026-05-24 13:00:52', '2026-05-24 14:48:52', TRUE, '2026-09-12 02:00:00', NULL),
(50, 5, 'Brgy. Calayo, Nasugbu, Batangas', 'Danilo Manalo', '0933-950-5641', 'Delivered', 'Call on arrival', '2026-05-24', '2026-05-26 15:00:38', '2026-05-26 16:07:38', TRUE, '2026-09-12 02:00:00', NULL),
(51, 5, 'Brgy. Pantalan, Nasugbu, Batangas', 'Lorna Villanueva', '0988-634-7426', 'Delivered', NULL, '2026-05-25', '2026-05-26 09:00:35', '2026-05-26 10:10:35', TRUE, '2026-09-12 02:00:00', NULL),
(57, 5, 'Caloocan City, Metro Manila', 'Customer', '0977-985-3498', 'Delivered', NULL, '2026-06-03', '2026-06-06 15:00:45', '2026-06-06 15:03:45', TRUE, '2026-09-12 02:00:00', NULL),
(60, 5, 'Poblacion, Nasugbu, Batangas', 'Customer', '0968-900-3246', 'Delivered', NULL, '2026-06-08', '2026-06-10 10:00:24', '2026-06-10 11:33:24', TRUE, '2026-09-12 02:00:00', NULL),
(61, 5, 'Brgy. Calayo, Nasugbu, Batangas', 'Danilo Manalo', '0972-603-4490', 'Delivered', 'Deliver before noon', '2026-06-12', '2026-06-14 10:00:06', '2026-06-14 10:14:06', FALSE, NULL, NULL),
(77, 5, 'Brgy. Dayap, Nasugbu, Batangas', 'Gerardo Lumbao', '0938-355-6235', 'Delivered', 'Nobody home, retry tomorrow', '2026-07-10', '2026-07-11 10:00:36', '2026-07-11 10:13:36', FALSE, NULL, NULL),
(78, 5, 'Lian, Batangas', 'Sta. Rosa Builders', '0925-414-5330', 'Delivered', NULL, '2026-07-12', '2026-07-13 09:00:12', '2026-07-13 10:13:12', FALSE, NULL, NULL),
(82, 5, 'Brgy. Natipuan, Nasugbu, Batangas', 'Aurora Marasigan', '0919-300-8531', 'Delivered', 'Nobody home, retry tomorrow', '2026-07-20', '2026-07-21 10:00:00', '2026-07-21 12:00:00', FALSE, NULL, NULL),
(84, 5, 'Poblacion, Nasugbu, Batangas', 'Customer', '0940-374-1401', 'Delivered', 'Rescheduled by customer', '2026-07-23', '2026-07-24 09:00:15', '2026-07-24 12:09:15', FALSE, NULL, NULL),
(87, 5, 'Brgy. Aga, Nasugbu, Batangas', 'Nenita Reyes', '0942-833-3216', 'Delivered', 'Nobody home, retry tomorrow', '2026-07-26', '2026-07-29 15:00:00', '2026-07-29 17:26:00', FALSE, NULL, NULL),
(93, 5, 'Brgy. Bilaran, Nasugbu, Batangas', 'Renato Castillo', '0953-138-9589', 'Delivered', NULL, '2026-08-03', '2026-08-05 09:00:20', '2026-08-05 10:03:20', FALSE, NULL, NULL),
(95, 5, 'Poblacion, Nasugbu, Batangas', 'Customer', '0960-386-2066', 'Delivered', 'Truck breakdown, moved to next day', '2026-08-06', '2026-08-08 09:00:36', '2026-08-08 11:29:36', FALSE, NULL, NULL),
(97, 5, 'Brgy. Kaylaway, Nasugbu, Batangas', 'Dominador Torres', '0916-452-7592', 'Delivered', 'Deliver before noon', '2026-08-12', '2026-08-13 14:00:40', '2026-08-13 17:04:40', FALSE, NULL, NULL),
(102, 5, 'Poblacion, Nasugbu, Batangas', 'Jocelyn Dela Cruz', '0944-650-9906', 'Delivered', NULL, '2026-08-18', '2026-08-19 14:00:10', '2026-08-19 15:06:10', FALSE, NULL, NULL),
(106, 5, 'Brgy. Munting Indan, Nasugbu, Batangas', 'Evelyn Flores', '0924-867-7979', 'Delivered', NULL, '2026-08-31', '2026-09-01 10:00:37', '2026-09-01 11:33:37', FALSE, NULL, NULL),
(107, 5, 'Pasig City, Metro Manila', 'Customer', '0924-671-4228', 'Delivered', 'Rescheduled by customer', '2026-09-01', '2026-09-04 10:00:07', '2026-09-04 13:23:07', FALSE, NULL, NULL);

INSERT INTO returned_items (product_id, sale_id, report_type, quantity, reason, disposition, refund_amount, restocked, status, reported_by_staff_id, return_date) VALUES
(22, NULL, 'Damaged', 2, 'Two bulbs arrived with cracked bases in the supplier carton; cannot be sold.', 'Write-Off', 0.00, FALSE, 'Resolved', 3, '2026-04-05 16:25:03'),
(16, 46, 'Refunded', 1, 'Customer bought the wrong pipe size, returned unopened the same afternoon.', 'Return to Stock', 185.00, TRUE, 'Resolved', 4, '2026-04-18 13:45:54'),
(34, NULL, 'Damaged', 1, 'Tin dented and leaking after a fall from the top shelf during restocking.', 'Write-Off', 0.00, FALSE, 'Resolved', 3, '2026-05-01 10:55:47'),
(2, 67, 'Return', 1, 'Handle came loose on first use; supplier replacement requested.', 'Write-Off', 0.00, FALSE, 'Resolved', 3, '2026-05-14 12:55:53'),
(24, 59, 'Refunded', 3, 'Outlets refunded, customer changed the wiring plan.', 'Return to Stock', 255.00, TRUE, 'Resolved', 4, '2026-05-27 12:55:41'),
(45, 79, 'Refunded', 10, 'Screw set returned, customer needed a larger gauge.', 'Return to Stock', 1500.00, TRUE, 'Resolved', 4, '2026-06-09 12:40:12'),
(9, NULL, 'Damaged', 1, 'Grinder guard cracked in transit from the supplier.', 'Write-Off', 0.00, FALSE, 'Resolved', 3, '2026-06-22 17:25:19'),
(30, 19, 'Return', 2, 'Roof paint returned, colour did not match the sample.', 'Return to Stock', 0.00, TRUE, 'Resolved', 3, '2026-07-05 15:30:18'),
(39, NULL, 'Damaged', 6, 'Plywood sheets warped after rain came through the stockroom door.', 'Write-Off', 0.00, FALSE, 'Resolved', 3, '2026-07-18 17:00:46'),
(6, 50, 'Refunded', 5, 'Five bags of cement refunded; customer cancelled the job.', 'Return to Stock', 1300.00, TRUE, 'Open', 4, '2026-07-31 14:45:44'),
(48, 12, 'Return', 2, 'Helmets returned, wrong size ordered by site.', 'Return to Stock', 0.00, TRUE, 'Open', 3, '2026-08-13 14:50:54'),
(17, NULL, 'Damaged', 15, 'A box of elbows crushed under a pallet in the stockroom.', 'Write-Off', 0.00, FALSE, 'Open', 3, '2026-08-26 10:50:59');

INSERT INTO stock_adjustments (product_id, adjustment_type, quantity_before, quantity_change, quantity_after, unit_name, reason, adjusted_by_staff_id, created_at) VALUES
(29, 'Add', 116, 44, 160, 'roll', 'Returned goods put back on the shelf', 3, '2026-03-20 13:00:53'),
(45, 'Recount', 104, -3, 101, 'kilogram', 'Monthly physical count corrected the figure', 3, '2026-03-27 11:15:45'),
(4, 'Add', 61, 27, 88, 'liter', 'Returned goods put back on the shelf', 3, '2026-04-03 11:00:22'),
(46, 'Recount', 27, -3, 24, 'kilogram', 'Quarter-end count', 3, '2026-04-10 10:55:07'),
(6, 'Recount', 50, -2, 48, 'bag', 'Monthly physical count corrected the figure', 3, '2026-04-17 17:55:09'),
(1, 'Add', 52, 22, 74, 'pcs', 'Found in the back store during count', 3, '2026-04-24 11:15:27'),
(27, 'Recount', 31, 2, 33, 'set', 'Recount after a shelf move', 3, '2026-05-01 09:50:50'),
(40, 'Recount', 64, -3, 61, 'sheet', 'Recount after a shelf move', 3, '2026-05-08 14:00:42'),
(33, 'Add', 111, 43, 154, 'roll', 'Supplier replacement stock booked in', 3, '2026-05-15 08:00:20'),
(38, 'Recount', 47, -1, 46, 'sack', 'Monthly physical count corrected the figure', 3, '2026-05-22 12:45:55'),
(21, 'Recount', 103, -2, 101, 'pcs', 'Quarter-end count', 3, '2026-05-29 08:40:49'),
(3, 'Recount', 63, -3, 60, 'meter', 'Monthly physical count corrected the figure', 3, '2026-06-05 08:45:47'),
(22, 'Add', 104, 48, 152, 'meter', 'Supplier replacement stock booked in', 3, '2026-06-12 13:05:48'),
(11, 'Recount', 27, -2, 25, 'pcs', 'Monthly physical count corrected the figure', 3, '2026-06-19 15:35:59'),
(2, 'Recount', 10, -1, 9, 'pcs', 'Recount after a shelf move', 3, '2026-06-26 09:20:43'),
(51, 'Add', 8, 15, 23, 'liter', 'Delivery received against purchase order', 3, '2026-07-03 08:00:56'),
(9, 'Remove', 52, -5, 47, 'pcs', 'Used for shop repairs', 3, '2026-07-10 11:00:22'),
(21, 'Recount', 24, 4, 28, 'pcs', 'Recount after a shelf move', 3, '2026-07-17 12:20:32'),
(16, 'Recount', 25, -2, 23, 'pcs', 'Monthly physical count corrected the figure', 3, '2026-07-24 08:00:48'),
(4, 'Recount', 103, 2, 105, 'liter', 'Monthly physical count corrected the figure', 3, '2026-07-31 12:25:40'),
(33, 'Recount', 79, 1, 80, 'roll', 'Monthly physical count corrected the figure', 3, '2026-08-07 12:25:14'),
(46, 'Recount', 56, -3, 53, 'kilogram', 'Recount after a shelf move', 3, '2026-08-14 13:45:08'),
(3, 'Add', 92, 44, 136, 'meter', 'Supplier replacement stock booked in', 3, '2026-08-21 09:10:02'),
(39, 'Add', 14, 18, 32, 'sheet', 'Found in the back store during count', 3, '2026-08-28 10:25:30'),
(1, 'Add', 72, 51, 123, 'pcs', 'Delivery received against purchase order', 3, '2026-09-04 11:30:10'),
(34, 'Add', 20, 45, 65, 'pcs', 'Found in the back store during count', 3, '2026-09-11 08:45:44');

INSERT INTO credit_requests (customer_id, previous_limit, requested_limit, reason, status, requested_by_staff_id, decided_by_staff_id, decision_note, decided_at, created_at) VALUES
(23, 100000.00, 150000.00, 'Contractor taking on the school extension, needs room for rebar and cement.', 'Approved', 4, 2, 'Settles monthly without fail. Approved.', '2026-08-12 15:25:04', '2026-08-11 13:25:04'),
(10, 30000.00, 45000.00, 'Wants to take the whole roofing order on account.', 'Declined', 4, 2, 'Two late payments in May. Not until the balance is clear.', '2026-08-02 18:10:14', '2026-08-01 16:10:14'),
(24, 80000.00, 120000.00, 'Site account, purchase order from the developer attached.', 'Approved', 4, 2, 'PO-backed. Approved.', '2026-07-18 10:45:35', '2026-07-17 08:45:35'),
(8, 40000.00, 60000.00, 'Regular since 2024, buying for a second house.', 'Approved', 4, 2, 'Good history. Approved.', '2026-07-03 17:55:39', '2026-07-02 15:55:39'),
(16, 25000.00, 35000.00, 'Asked at the counter, wants to add a water closet set.', 'Declined', 4, 2, 'Cheque returned in July. On hold.', '2026-08-22 19:15:02', '2026-08-21 17:15:02'),
(5, 40000.00, 50000.00, 'Buying materials for a boarding house build.', 'Pending', 4, NULL, NULL, NULL, '2026-09-07 13:15:42'),
(13, 12000.00, 18000.00, 'Over the limit on the drill and wire, wants the rest on account.', 'Pending', 4, NULL, NULL, NULL, '2026-09-08 17:45:05'),
(14, 35000.00, 35000.00, 'Asked about terms, no increase needed in the end.', 'Declined', 4, 2, 'Same figure as the current limit; nothing to raise.', '2026-06-18 15:50:38', '2026-06-17 13:50:38');

INSERT INTO notifications (target_role_id, notif_type, title, message, product_id, created_by_staff_id, is_read, created_at) VALUES
(2, 'Low Stock', 'Circular Saw 7-1/4" is low', 'Stock is 3, reorder point is 3. Raise a purchase order.', 10, NULL, FALSE, '2026-09-06 16:50:48'),
(3, 'Low Stock', 'Circular Saw 7-1/4" is low', 'Stock is 3, reorder point is 3. Raise a purchase order.', 10, NULL, TRUE, '2026-09-08 14:00:25'),
(2, 'Low Stock', 'Jigsaw 600W is low', 'Stock is 2, reorder point is 3. Raise a purchase order.', 12, NULL, FALSE, '2026-09-05 13:35:29'),
(3, 'Low Stock', 'Jigsaw 600W is low', 'Stock is 2, reorder point is 3. Raise a purchase order.', 12, NULL, FALSE, '2026-09-10 14:30:09'),
(2, 'Low Stock', 'Trowel Plastering is low', 'Stock is 9, reorder point is 15. Raise a purchase order.', 21, NULL, FALSE, '2026-09-07 09:40:58'),
(3, 'Low Stock', 'Trowel Plastering is low', 'Stock is 9, reorder point is 15. Raise a purchase order.', 21, NULL, FALSE, '2026-09-05 12:35:20'),
(2, 'Low Stock', 'THHN Wire 3.5mm 75m is low', 'Stock is 2, reorder point is 4. Raise a purchase order.', 29, NULL, FALSE, '2026-09-05 12:30:43'),
(3, 'Low Stock', 'THHN Wire 3.5mm 75m is low', 'Stock is 2, reorder point is 4. Raise a purchase order.', 29, NULL, FALSE, '2026-09-04 10:50:10'),
(2, 'Low Stock', 'Primer Flat 4L is low', 'Stock is 5, reorder point is 8. Raise a purchase order.', 43, NULL, FALSE, '2026-09-10 09:55:07'),
(3, 'Low Stock', 'Primer Flat 4L is low', 'Stock is 5, reorder point is 8. Raise a purchase order.', 43, NULL, TRUE, '2026-09-03 09:15:53'),
(2, 'Low Stock', 'Concrete Nails 3" is low', 'Stock is 18, reorder point is 30. Raise a purchase order.', 46, NULL, TRUE, '2026-09-04 12:50:28'),
(3, 'Low Stock', 'Concrete Nails 3" is low', 'Stock is 18, reorder point is 30. Raise a purchase order.', 46, NULL, TRUE, '2026-09-11 17:55:02'),
(2, 'Out of Stock', 'Discontinued Enamel Ivory is out of stock', 'Nothing left on the shelf. The register will not sell it until it is restocked.', 51, NULL, FALSE, '2026-09-11 08:15:21'),
(3, 'Out of Stock', 'Discontinued Enamel Ivory is out of stock', 'Nothing left on the shelf. The register will not sell it until it is restocked.', 51, NULL, FALSE, '2026-09-09 13:45:53'),
(2, 'Damage Report', 'Damage filed for Plywood 1/2" 4x8', '6 sheets reported damaged: warped after rain came through the stockroom door.', 39, 3, FALSE, '2026-09-07 16:05:23'),
(2, 'Refund Report', 'Refund filed for Tox Screw Set 100pc', '10 packs refunded at the counter: customer needed a larger gauge.', 45, 4, TRUE, '2026-09-01 10:30:35'),
(3, 'Purchase Order', 'Purchase order #13 raised', '3 line(s) ordered from Luzon Electrical Supply, awaiting delivery.', NULL, 2, FALSE, '2026-09-11 12:40:52'),
(3, 'Purchase Order', 'Purchase order #12 raised', '2 line(s) ordered from Batangas Builders Depot, awaiting delivery.', NULL, 2, TRUE, '2026-09-08 13:05:30'),
(5, 'Delivery', 'Delivery booked for Brgy. Wawa, Nasugbu', 'A COD order needs a driver tomorrow morning.', NULL, 4, FALSE, '2026-09-11 13:15:15'),
(5, 'Delivery', 'Delivery booked for Poblacion, Nasugbu', 'Cement and hollow blocks, two stops.', NULL, 4, TRUE, '2026-09-09 14:15:26'),
(2, 'Stock Adjustment', 'Recount on Hollow Block 4"', 'The monthly count corrected the figure by -3.', 36, 3, TRUE, '2026-09-04 12:30:14');

INSERT INTO audit_logs (staff_id, role_name, ip_address, action, action_type, details, metadata, created_at) VALUES
(4, 'Cashier', '192.168.1.22', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-03-16 13:40:21'),
(3, 'Inventory Clerk', '192.168.1.13', 'FILE_RETURN', 'CREATE', 'Return report filed', NULL, '2026-03-18 17:45:27'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-03-21 14:25:54'),
(5, 'Delivery Personnel', '192.168.1.24', 'RECORD_PAYMENT', 'PAYMENT', 'Payment of 6000.00 recorded on sale #90', NULL, '2026-03-23 13:40:01'),
(3, 'Inventory Clerk', '192.168.1.13', 'LOGIN', 'LOGIN', 'clerk@hardware.com signed in', NULL, '2026-03-26 08:35:42'),
(5, 'Delivery Personnel', '192.168.1.19', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-03-29 16:10:53'),
(2, 'Manager', '192.168.1.12', 'LOGIN', 'LOGIN', 'manager@hardware.com signed in', NULL, '2026-03-31 16:30:34'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-04-03 11:45:42'),
(4, 'Cashier', '192.168.1.22', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for cashier@hardware.com: wrong password', '{"email":"cashier@hardware.com","reason":"wrong_password"}', '2026-04-05 15:35:33'),
(3, 'Inventory Clerk', '192.168.1.13', 'ADJUST_STOCK', 'UPDATE', 'Stock adjusted on product #5', NULL, '2026-04-08 09:45:10'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-04-11 09:35:27'),
(4, 'Cashier', '192.168.1.23', 'FILE_RETURN', 'CREATE', 'Return report filed', NULL, '2026-04-13 11:20:18'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-04-16 12:00:18'),
(5, 'Delivery Personnel', '192.168.1.19', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-04-18 15:00:55'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-04-21 13:50:40'),
(4, 'Cashier', '192.168.1.18', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for cashier@hardware.com: wrong password', '{"email":"cashier@hardware.com","reason":"wrong_password"}', '2026-04-24 11:30:26'),
(3, 'Inventory Clerk', '192.168.1.13', 'ADJUST_STOCK', 'UPDATE', 'Stock adjusted on product #9', NULL, '2026-04-26 09:35:17'),
(1, 'System Administrator', '192.168.1.11', 'LOGIN', 'LOGIN', 'admin@hardware.com signed in', NULL, '2026-04-29 13:00:55'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for delivery@hardware.com: wrong password', '{"email":"delivery@hardware.com","reason":"wrong_password"}', '2026-05-01 10:35:37'),
(3, 'Inventory Clerk', '192.168.1.20', 'LOGIN', 'LOGIN', 'clerk@hardware.com signed in', NULL, '2026-05-04 16:40:13'),
(4, 'Cashier', '192.168.1.14', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for cashier@hardware.com: wrong password', '{"email":"cashier@hardware.com","reason":"wrong_password"}', '2026-05-07 13:00:06'),
(2, 'Manager', '192.168.1.12', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for manager@hardware.com: wrong password', '{"email":"manager@hardware.com","reason":"wrong_password"}', '2026-05-09 15:35:14'),
(3, 'Inventory Clerk', '192.168.1.13', 'ARCHIVE', 'DELETE', 'Inventory record #49', NULL, '2026-05-12 10:15:00'),
(4, 'Cashier', '192.168.1.14', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-05-12 12:50:01'),
(4, 'Cashier', '192.168.1.16', 'FILE_RETURN', 'CREATE', 'Return report filed', NULL, '2026-05-14 09:05:51'),
(3, 'Inventory Clerk', '192.168.1.13', 'FILE_RETURN', 'CREATE', 'Return report filed', NULL, '2026-05-17 14:55:30'),
(2, 'Manager', '192.168.1.21', 'LOGOUT', 'LOGOUT', 'manager@hardware.com signed out', NULL, '2026-05-20 12:55:48'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-05-22 17:05:40'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-05-25 17:35:10'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-05-27 14:30:55'),
(4, 'Cashier', '192.168.1.18', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-05-30 10:35:54'),
(4, 'Cashier', '192.168.1.14', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-06-02 14:40:34'),
(2, 'Manager', '192.168.1.12', 'LOGIN', 'LOGIN', 'manager@hardware.com signed in', NULL, '2026-06-04 14:05:49'),
(5, 'Delivery Personnel', '192.168.1.15', 'RECORD_PAYMENT', 'PAYMENT', 'Payment of 2500.00 recorded on sale #109', NULL, '2026-06-07 17:40:26'),
(1, 'System Administrator', '192.168.1.11', 'LOGIN', 'LOGIN', 'admin@hardware.com signed in', NULL, '2026-06-09 08:55:46'),
(2, 'Manager', '192.168.1.12', 'CREATE_PURCHASE_ORDER', 'CREATE', 'Purchase order #10 raised', NULL, '2026-06-12 17:15:57'),
(2, 'Manager', '192.168.1.12', 'UPDATE_CREDIT_LIMIT', 'UPDATE', 'Credit limit set for customer #11', '{"changes":{"credit_limit":{"before":"20000.00","after":"25000.00"}}}', '2026-06-15 08:10:06'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-06-17 17:10:58'),
(2, 'Manager', '192.168.1.12', 'VOID_SALE', 'VOID', 'Sale #62 voided: rung up twice by mistake', NULL, '2026-06-20 11:00:00'),
(2, 'Manager', '192.168.1.12', 'VOID_SALE', 'VOID', 'Sale #68 voided: rung up twice by mistake', NULL, '2026-06-20 11:00:00'),
(4, 'Cashier', '192.168.1.14', 'LOGOUT', 'LOGOUT', 'cashier@hardware.com signed out', NULL, '2026-06-20 13:25:36'),
(5, 'Delivery Personnel', '192.168.1.19', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-06-22 09:25:42'),
(3, 'Inventory Clerk', '192.168.1.20', 'LOGIN', 'LOGIN', 'clerk@hardware.com signed in', NULL, '2026-06-25 09:35:36'),
(2, 'Manager', '192.168.1.12', 'LOGIN', 'LOGIN', 'manager@hardware.com signed in', NULL, '2026-06-28 12:40:16'),
(3, 'Inventory Clerk', '192.168.1.13', 'LOGIN', 'LOGIN', 'clerk@hardware.com signed in', NULL, '2026-06-30 15:05:36'),
(1, 'System Administrator', '192.168.1.11', 'ARCHIVE', 'DELETE', 'Staff record #12', NULL, '2026-06-30 17:30:00'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-07-03 14:40:02'),
(3, 'Inventory Clerk', '192.168.1.20', 'ARCHIVE', 'DELETE', 'Inventory record #50', NULL, '2026-07-03 15:40:00'),
(4, 'Cashier', '192.168.1.23', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-07-05 11:30:02'),
(3, 'Inventory Clerk', '192.168.1.20', 'RECORD_PAYMENT', 'PAYMENT', 'Payment of 2500.00 recorded on sale #49', NULL, '2026-07-08 13:40:20'),
(4, 'Cashier', '192.168.1.16', 'RECORD_PAYMENT', 'PAYMENT', 'Payment of 6000.00 recorded on sale #44', NULL, '2026-07-11 08:00:54'),
(4, 'Cashier', '192.168.1.18', 'LOGOUT', 'LOGOUT', 'cashier@hardware.com signed out', NULL, '2026-07-13 15:10:55'),
(2, 'Manager', '192.168.1.21', 'CREATE_PURCHASE_ORDER', 'CREATE', 'Purchase order #4 raised', NULL, '2026-07-16 16:35:22'),
(5, 'Delivery Personnel', '192.168.1.24', 'RECORD_PAYMENT', 'PAYMENT', 'Payment of 6000.00 recorded on sale #108', NULL, '2026-07-18 16:40:20'),
(2, 'Manager', '192.168.1.12', 'LOGIN', 'LOGIN', 'manager@hardware.com signed in', NULL, '2026-07-21 16:45:44'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for delivery@hardware.com: wrong password', '{"email":"delivery@hardware.com","reason":"wrong_password"}', '2026-07-24 10:55:27'),
(4, 'Cashier', '192.168.1.16', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-07-26 10:25:56'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-07-29 14:05:27'),
(1, 'System Administrator', '192.168.1.11', 'LOGIN', 'LOGIN', 'admin@hardware.com signed in', NULL, '2026-07-31 13:00:08'),
(4, 'Cashier', '192.168.1.23', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-08-03 08:40:52'),
(4, 'Cashier', '192.168.1.23', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-08-06 14:30:50'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-08-08 14:10:48'),
(1, 'System Administrator', '192.168.1.11', 'LOGIN', 'LOGIN', 'admin@hardware.com signed in', NULL, '2026-08-11 14:35:33'),
(5, 'Delivery Personnel', '192.168.1.19', 'UPDATE_DELIVERY_STATUS', 'UPDATE', 'Delivery #17 marked Delivered', '{"changes":{"status":{"before":"Out for Delivery","after":"Delivered"}}}', '2026-08-13 08:30:27'),
(4, 'Cashier', '192.168.1.22', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for cashier@hardware.com: wrong password', '{"email":"cashier@hardware.com","reason":"wrong_password"}', '2026-08-16 09:05:18'),
(3, 'Inventory Clerk', '192.168.1.13', 'LOGIN', 'LOGIN', 'clerk@hardware.com signed in', NULL, '2026-08-19 10:55:27'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-08-21 09:10:14'),
(5, 'Delivery Personnel', '192.168.1.24', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-08-24 11:10:36'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-08-26 10:45:13'),
(4, 'Cashier', '192.168.1.14', 'LOGIN', 'LOGIN', 'cashier@hardware.com signed in', NULL, '2026-08-29 08:40:11'),
(4, 'Cashier', '192.168.1.23', 'CREATE_SALE', 'CREATE', 'Sale #102 completed', NULL, '2026-09-01 12:50:44'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-09-03 14:40:23'),
(5, 'Delivery Personnel', '192.168.1.15', 'LOGIN', 'LOGIN', 'delivery@hardware.com signed in', NULL, '2026-09-06 16:00:24'),
(2, 'Manager', '192.168.1.12', 'LOGIN_FAILURE', 'LOGIN_FAILURE', 'Sign-in refused for manager@hardware.com: wrong password', '{"email":"manager@hardware.com","reason":"wrong_password"}', '2026-09-08 12:25:35'),
(4, 'Cashier', '192.168.1.14', 'FILE_RETURN', 'CREATE', 'Return report filed', NULL, '2026-09-11 08:10:32'),
(NULL, NULL, NULL, 'ARCHIVE_SWEEP', 'DELETE', 'Archived 13 closed deliveries older than 90 days', NULL, '2026-09-12 02:00:00');
