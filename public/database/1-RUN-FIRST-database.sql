-- ==========================================================================
-- 1-RUN-FIRST-database.sql
-- Hardware Sales & Inventory with Credit Management
--
-- WHAT THIS IS
--   The whole database: 23 tables, 2 views, and the demo data.
--   This is the complete, current schema. There are no separate upgrade
--   files to apply on top of it any more; every past upgrade is already
--   folded in here.
--
-- HOW TO RUN IT (MySQL Workbench)
--   File > Open SQL Script... > pick this file > click the lightning bolt.
--   Then open 2-RUN-SECOND-stored-procedures.sql and run that.
--
-- HOW TO RUN IT (command line)
--   mysql -u root -p < public/database/1-RUN-FIRST-database.sql
--   mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
--
-- READ THIS BEFORE RUNNING
--   The first line below DROPS hardware_db. Every row in it is destroyed and
--   replaced with the demo data. On a machine that holds work you want to
--   keep, take a backup first (the System Administrator's Backup & Recovery
--   screen writes one into backups/).
-- ==========================================================================

DROP DATABASE IF EXISTS hardware_db;
CREATE DATABASE hardware_db;
USE hardware_db;

-- ==========================================
-- 1. ROLES, STAFF & USERS
-- ==========================================
CREATE TABLE roles (
    role_id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

-- middle_initial separates two people who share a first and last name.
-- It is optional, so older records and single-name staff stay valid.
CREATE TABLE staff (
    staff_id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    middle_initial VARCHAR(5) NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role_id INT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- One definition of a staff name for the whole system, so the directory,
    -- the receipt, the audit trail and every report spell it the same way.
    full_name VARCHAR(220) AS (
        CONCAT(first_name,
               IF(middle_initial IS NULL OR middle_initial = '', '',
                  CONCAT(' ', UPPER(LEFT(middle_initial, 1)), '.')),
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
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- An audit entry has to survive the questions an audit actually gets asked:
-- who did it, in which role, from which machine, what kind of action it was,
-- and what the values were before and after.
--
-- role_name is a snapshot, not a join. People move between roles, and reading
-- the role off the staff record today would quietly rewrite last month's
-- history the moment somebody is promoted.
--
-- metadata holds the before and after values as JSON, kept as TEXT so a
-- backup taken here restores on any MySQL 8 point release.
CREATE TABLE audit_logs (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id INT NULL,
    role_name VARCHAR(50) NULL,
    ip_address VARCHAR(45) NULL,
    action VARCHAR(100) NOT NULL,
    action_type ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP',
                     'LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT','OTHER')
                NOT NULL DEFAULT 'OTHER',
    details TEXT,
    metadata TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_when (created_at DESC),
    INDEX idx_audit_type (action_type),
    FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- ==========================================
-- 2. ENTITIES
-- ==========================================
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

-- credit_limit and standing are real attributes; they are decisions somebody
-- made. Balances are derived from the sales, so they live in a view and
-- cannot go stale.
--
-- A limit alone is not a credit policy. A customer who always pays and one
-- who has owed for four months both fit under the same limit, and only one of
-- them should be sold to on account. Standing is what separates them:
--   Good   sell on account as normal
--   Watch  still allowed, but every screen says to look at this account
--   Hold   no new credit at all until a manager lifts it
CREATE TABLE customer_credits (
    credit_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL UNIQUE,
    credit_limit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    standing ENUM('Good','Watch','Hold') NOT NULL DEFAULT 'Good',
    notes VARCHAR(255) NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by_staff_id INT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (updated_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Raised at the counter, decided by a manager.
--
-- A cashier standing with a regular customer who is over their limit has two
-- options otherwise: refuse the sale, or go and find the manager. The first
-- loses the sale and the second stops the queue.
--
-- previous_limit is recorded alongside the requested one so an approval read
-- a month later cannot be mistaken for approving a bigger jump than was
-- actually asked for.
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

-- ==========================================
-- 3. PRODUCTS & INVENTORY
-- ==========================================
CREATE TABLE products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    brand_id INT,
    category_id INT,
    unit_id INT,
    price DECIMAL(10,2) NOT NULL,
    -- The reorder point somebody typed. It is still what a Manual product
    -- uses, and it is what a Dynamic product falls back to when there is not
    -- enough sales history to calculate anything honest from.
    reorder_point INT NOT NULL DEFAULT 10,
    -- The two figures the formula needs that sales history cannot supply:
    --     ROP = (average daily sales x lead time) + safety stock
    -- Average daily sales is already in sale_items. How long the supplier
    -- takes, and how much cover the shop wants on top, are decisions.
    lead_time_days INT NOT NULL DEFAULT 7,
    safety_stock INT NOT NULL DEFAULT 0,
    -- Per product on purpose. A fast-moving consumable earns its formula; a
    -- slow item nobody has bought in a year would only get a reorder point of
    -- zero out of one, which is worse than the number a person chose.
    reorder_mode ENUM('Manual','Dynamic') NOT NULL DEFAULT 'Manual',
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
    quantity_in_stock INT NOT NULL DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- ==========================================
-- 4. PROCUREMENT & RETURNS
-- ==========================================
CREATE TABLE purchase_orders (
    po_id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_id INT NOT NULL,
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('Pending', 'Received', 'Cancelled') NOT NULL DEFAULT 'Pending',
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE purchase_order_items (
    po_item_id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_cost DECIMAL(10,2) NOT NULL,
    line_cost DECIMAL(12,2) AS (quantity * unit_cost) STORED,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- every stock movement leaves a trail
CREATE TABLE stock_adjustments (
    adjustment_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    adjustment_type ENUM('Add', 'Remove', 'Recount') NOT NULL,
    quantity_before INT NOT NULL,
    quantity_change INT NOT NULL,
    quantity_after INT NOT NULL,
    -- What the figure was counted in, as text and as at the time it was
    -- filed. A hardware shop counts almost nothing in the same unit twice,
    -- and "+20" against Portland Cement is twenty of something nobody can
    -- name six months later.
    --
    -- Text rather than a link to the units table on purpose: renaming a unit
    -- next year must not rewrite what last year's entries say they counted.
    -- A log that quietly changes its own history is worse than a terse one.
    unit_name VARCHAR(20) NULL,
    reason VARCHAR(255) NOT NULL,
    adjusted_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (adjusted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Low stock warnings and the rest of the alerts land here, one row per role
-- that needs to see it. created_by_staff_id is whose action raised the alert;
-- it stays NULL when the system raised it on its own, and the screen then
-- says "System" rather than pretending somebody did it.
CREATE TABLE notifications (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    target_role_id INT NULL,
    notif_type ENUM('Low Stock', 'Out of Stock', 'Damage Report', 'Refund Report', 'Purchase Order', 'Stock Adjustment', 'Delivery') NOT NULL,
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

-- ==========================================
-- 5. SALES & FULFILLMENT
-- ==========================================
-- ==========================================
-- WHO THE SHOP IS, AND HOW IT IS REGISTERED
--
-- The invoice used to print a shop name hard-coded into a JavaScript file, no
-- TIN, and no tax breakdown, which is not a document a Philippine shop can
-- hand a customer. RR 7-2024 wants the seller's registered name, address and
-- TIN on it, and a VAT-registered seller has to show the sale split into
-- VATable Sale, VAT, VAT-Exempt Sale and Zero-Rated Sale.
--
-- Registration is a setting because both kinds of hardware shop exist. Below
-- the 3,000,000 annual threshold a shop is non-VAT: it charges no VAT at all,
-- so a VAT block on its invoice would be a fiction, and it prints Sales
-- Subject to Percentage Tax instead.
--
-- One row, id 1, and a CHECK that keeps it that way. A settings table that
-- can hold two rows is one that eventually does, and then half the screens
-- read one row and half read the other.
--
-- The defaults are obvious placeholders on purpose: a shop that has not
-- filled this in should notice on its first invoice rather than hand a
-- customer somebody else's TIN.
-- ==========================================
CREATE TABLE store_settings (
    setting_id INT PRIMARY KEY DEFAULT 1,
    store_name VARCHAR(150) NOT NULL DEFAULT 'Hardware Sales & Inventory',
    address VARCHAR(255) NOT NULL DEFAULT 'Set your address in System Administration',
    tin VARCHAR(30) NOT NULL DEFAULT '000-000-000-00000',
    registration_type ENUM('VAT','NON-VAT') NOT NULL DEFAULT 'VAT',
    -- a rate written into source code is a rate nobody can change when it moves
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 12.00,
    -- the line under the barcode: a returns policy, a thank you, anything
    invoice_note VARCHAR(255) NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by_staff_id INT NULL,
    CONSTRAINT chk_store_settings_single_row CHECK (setting_id = 1),
    CONSTRAINT chk_store_settings_rate CHECK (vat_rate >= 0 AND vat_rate <= 100)
);

CREATE TABLE sales (
    sale_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NULL,
    -- The name of somebody who is not on the credit book. A sale recorded as
    -- "Walk-in" and nothing else cannot be reprinted a week later for the
    -- person who bought it, and a delivery booked against it has nobody's
    -- name on the manifest. This is not an account and does not become one:
    -- an account is created deliberately, from the counter, when the cashier
    -- says so. NULL means nobody asked, which is a different fact from an
    -- empty name.
    walk_in_name VARCHAR(150) NULL,
    cashier_staff_id INT NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    final_amount DECIMAL(12,2) AS (total_amount - discount) STORED,
    amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    change_given DECIMAL(12,2) AS (GREATEST(amount_paid - (total_amount - discount), 0)) STORED,
    payment_method ENUM('Cash','Cheque','GCash','PayMaya','PayPal','Bank Transfer','COD','Credit') NOT NULL,
    payment_status ENUM('Paid','Partial','Unpaid') NOT NULL DEFAULT 'Paid',

    -- WHAT THIS SALE WAS MADE OF, FOR TAX
    --
    -- Philippine posted prices already include VAT, so the 12% is extracted
    -- from the total rather than added to it:
    --
    --     vat_amount   = final_amount x rate/(100+rate)      -- 12/112
    --     vatable_sale = final_amount - vat_amount
    --
    -- The VAT is rounded first and the VATable sale is the remainder, so the
    -- two lines always add back to the total exactly. Dividing by 1.12 and
    -- rounding both can leave an invoice a centavo short of itself.
    --
    -- These are recorded on the sale rather than derived when an invoice is
    -- reprinted. An invoice is a record of what was charged on the day it was
    -- issued, and a shop that later crosses the VAT threshold, or a rate that
    -- moves, must not silently rewrite every invoice already handed out.
    -- A non-VAT shop stores zeroes here and its whole sale is subject to
    -- percentage tax instead.
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
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(12,2) AS (quantity * unit_price) STORED,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE deliveries (
    delivery_id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    delivery_staff_id INT NULL,
    delivery_address TEXT NOT NULL,
    -- Who the driver is actually looking for, as written down when the
    -- delivery was booked. Reading the name off the sale's customer row left
    -- a walk-in delivery with no name and no number, which is an address and
    -- nobody to ring on arrival. These win over the joined customer record
    -- because the person who took the order is closer to the truth than a
    -- customer row from six months ago.
    contact_name VARCHAR(150) NULL,
    contact_phone VARCHAR(30) NULL,
    status ENUM('Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed', 'Failed') NOT NULL DEFAULT 'Pending',
    remarks TEXT,
    -- The day it was written up, kept apart from the day it is meant to
    -- arrive. Those answer different questions, and updated_at answers
    -- neither once a driver has touched the row.
    booked_date DATE NULL,
    -- "Tuesday" is not a delivery slot. "Tuesday 2pm" is, and a shop moving a
    -- delivery around a conflict needs the hour or the reschedule says
    -- nothing.
    scheduled_date DATETIME NULL,
    delivered_at TIMESTAMP NULL,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMP NULL,
    archived_by_staff_id INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (delivery_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
    -- A delivery that says it arrived has to say when. Reports group on this
    -- date, so a Delivered row without one quietly reports under the wrong day.
    CONSTRAINT chk_delivered_has_timestamp
        CHECK (status <> 'Delivered' OR delivered_at IS NOT NULL)
);

-- A returned item has to answer two questions, and the second one was being
-- answered by a checkbox nobody read: where do the goods go?
--
-- disposition is that answer, written in words rather than as a true/false.
-- "Return to Stock" and "Write-Off" mean something to the person choosing;
-- restocked = 0 does not, and a return filed with it left the goods
-- unaccounted for on a shelf somebody would later count.
--
-- restocked is kept because it is what the stock movement is driven from, but
-- it is now derived from the disposition rather than set separately, so the
-- two can never disagree.
--
-- reason is NOT NULL here on purpose. A return with no reason is the return
-- that gets queried three months later and cannot be explained.
CREATE TABLE returned_items (
    return_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    sale_id INT NULL,
    report_type ENUM('Return', 'Damaged', 'Refunded') NOT NULL DEFAULT 'Return',
    quantity INT NOT NULL,
    reason TEXT NOT NULL,
    disposition ENUM('Return to Stock', 'Write-Off') NOT NULL DEFAULT 'Write-Off',
    refund_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    restocked BOOLEAN NOT NULL DEFAULT FALSE,
    status ENUM('Open', 'Resolved') NOT NULL DEFAULT 'Open',
    reported_by_staff_id INT NULL,
    return_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (reported_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- ==========================================
-- 6. VIEWS
-- ==========================================
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

-- one row per archived record, whatever module it came from
CREATE OR REPLACE VIEW vw_archives AS
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
WHERE d.is_archived = TRUE;

-- ==========================================
-- 7. SEED DATA
-- ==========================================
-- The one settings row. Its defaults are deliberately obvious placeholders:
-- a shop that has not filled this in should notice on its first invoice
-- rather than hand a customer somebody else's TIN.
INSERT INTO store_settings (setting_id) VALUES (1);

INSERT INTO roles (role_id, role_name) VALUES
(1, 'System Administrator'), (2, 'Manager'), (3, 'Inventory Clerk'),
(4, 'Cashier'), (5, 'Delivery Personnel');

INSERT INTO staff (staff_id, first_name, middle_initial, last_name, phone, role_id, is_active) VALUES
(1, 'Admin',    'S', 'User',    '09170000001', 1, TRUE),
(2, 'Manager',  'M', 'User',    '09170000002', 2, TRUE),
(3, 'Clerk',    'I', 'User',    '09170000003', 3, TRUE),
(4, 'Cashier',  'C', 'User',    '09170000004', 4, TRUE),
(5, 'Delivery', 'D', 'User',    '09170000005', 5, TRUE),
(6, 'Ana',      'B', 'Reyes',   '09170000006', 4, TRUE),
(7, 'Ben',      'L', 'Cruz',    '09170000007', 5, FALSE);

UPDATE staff SET archived_at = '2026-08-18 09:00:00', archived_by_staff_id = 1 WHERE staff_id = 7;

INSERT INTO users (staff_id, email, password, must_change_password) VALUES
(1, 'admin@hardware.com', 'admin123', FALSE),
(2, 'manager@hardware.com', 'manager123', TRUE),
(3, 'clerk@hardware.com', 'clerk123', TRUE),
(4, 'cashier@hardware.com', 'cashier123', TRUE),
(5, 'delivery@hardware.com', 'delivery123', TRUE),
(6, 'ana.reyes@hardware.com', 'ana12345', TRUE);

INSERT INTO categories (category_name) VALUES
('Hand Tools'), ('Power Tools'), ('Plumbing'), ('Electrical'), ('Construction Materials');

INSERT INTO brands (brand_name) VALUES
('Makita'), ('DeWalt'), ('Stanley'), ('Boysen'), ('Pioneer');

-- A hardware shop counts nails by the kilo, wire by the roll and sand by the
-- sack. The list is not fixed: a unit typed on a stock adjustment that is not
-- here yet gets added, so it grows from what the shop actually sells.
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

-- One of each standing, so the credit screen has something to show on a
-- fresh database: a good account, one being watched, and one on hold.
INSERT INTO customer_credits (customer_id, credit_limit, standing, notes, updated_by_staff_id) VALUES
(1, 50000.00, 'Good',  NULL, NULL),
(2, 20000.00, 'Watch', 'Two sales past 30 days. Chase before extending further.', 2),
(3, 30000.00, 'Good',  NULL, NULL),
(4, 15000.00, 'Hold',  'Cheque bounced in August. No new credit until it clears.', 2);

-- Two products start on the dynamic reorder point so the Stocks screen has
-- something real to show on a fresh database: the cement and the pipe are the
-- two that actually move here.
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

INSERT INTO purchase_orders (supplier_id, status) VALUES
(1, 'Received'), (2, 'Pending'), (1, 'Pending');

INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(1, 1, 10, 7000.00), (1, 3, 100, 90.00),
(2, 2, 50, 300.00), (3, 6, 80, 210.00), (3, 7, 30, 480.00);

-- final_amount and change_given are generated, so they are not listed here
INSERT INTO sales (customer_id, cashier_staff_id, total_amount, discount, amount_paid, payment_method, payment_status, reference_no, sale_date) VALUES
(1, 4, 8950.00,  0.00,   9000.00, 'Cash',          'Paid',    NULL,          '2026-08-20 09:15:00'),
(2, 4, 1500.00,  0.00,   0.00,    'Credit',        'Unpaid',  NULL,          '2026-08-21 10:05:00'),
(1, 6, 2600.00,  100.00, 2500.00, 'GCash',         'Paid',    'GC-88213',    '2026-08-24 14:20:00'),
(3, 4, 3720.00,  0.00,   0.00,    'COD',           'Unpaid',  NULL,          '2026-08-26 11:40:00'),
(3, 6, 900.00,   0.00,   900.00,  'PayMaya',       'Paid',    'PM-40021',    '2026-08-27 16:02:00'),
(4, 4, 12400.00, 400.00, 6000.00, 'Cheque',        'Partial', 'CHQ-771904',  '2026-08-28 08:55:00'),
(1, 6, 540.00,   0.00,   540.00,  'PayPal',        'Paid',    'PP-5521XZ',   '2026-08-29 13:11:00'),
(2, 4, 7440.00,  0.00,   7440.00, 'COD',           'Paid',    NULL,          '2026-08-30 10:25:00'),
(NULL, 6, 360.00, 0.00,  400.00,  'Cash',          'Paid',    NULL,          '2026-08-31 17:45:00'),
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