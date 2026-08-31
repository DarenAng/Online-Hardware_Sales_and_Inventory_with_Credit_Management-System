DROP DATABASE IF EXISTS hardware_db;
CREATE DATABASE hardware_db;
USE hardware_db;

-- 1. Roles & Users
CREATE TABLE roles (
    role_id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
    role_id INT NOT NULL,
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 2. Entities: Categories, Brands, Units, Suppliers, & Customers
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
    address TEXT
);

CREATE TABLE customer_credits (
    credit_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL UNIQUE,
    total_purchase DECIMAL(12,2) DEFAULT 0.00,
    credit_limit DECIMAL(12,2) DEFAULT 0.00,
    current_credit DECIMAL(12,2) DEFAULT 0.00,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 3. Products & Inventory
CREATE TABLE products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    brand_id INT,
    category_id INT,
    unit_id INT,
    price DECIMAL(10,2) NOT NULL,
    reorder_point INT DEFAULT 10,
    status VARCHAR(100),
    supplier_id INT,
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

-- 4. Procurement & Returns
CREATE TABLE purchase_orders (
    po_id INT AUTO_INCREMENT PRIMARY KEY,
    supplier_id INT NOT NULL,
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('Pending', 'Received', 'Cancelled') DEFAULT 'Pending',
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE purchase_order_items (
    po_item_id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_cost DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE returned_items (
    return_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    reason TEXT,
    return_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 5. Sales & Line Items
CREATE TABLE sales (
    sale_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NULL,
    cashier_id INT NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL,
    discount DECIMAL(10,2) DEFAULT 0.00,
    final_amount DECIMAL(12,2) NOT NULL,
    amount_paid DECIMAL(12,2) NOT NULL,
    change_given DECIMAL(12,2) DEFAULT 0.00,
    payment_method VARCHAR(30) NOT NULL,
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (cashier_id) REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE sale_items (
    sale_item_id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 6. Fulfillment & Seed Data
CREATE TABLE deliveries (
    delivery_id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,
    delivery_person_id INT NULL,
    delivery_address TEXT NOT NULL,
    status ENUM('Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed') DEFAULT 'Pending',
    remarks TEXT,
    scheduled_date DATE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (delivery_person_id) REFERENCES users(user_id) ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO roles (role_name) VALUES 
('System Administrator'),
('Manager'),
('Inventory Clerk'),
('Cashier'),
('Delivery Personnel');

-- 1. Roles & Users
-- Note: 'roles' may have been inserted in the previous script, but included here for completeness.
INSERT IGNORE INTO roles (role_id, role_name) VALUES 
(1, 'System Administrator'),
(2, 'Manager'),
(3, 'Inventory Clerk'),
(4, 'Cashier'),
(5, 'Delivery Personnel');

-- Using dummy hashed passwords for illustration
INSERT INTO users (first_name, email, password, must_change_password, role_id) VALUES 
('Admin', 'admin@hardware.com', 'admin123', FALSE, 1),
('Manager', 'manager@hardware.com', 'manager123', TRUE, 2),
('Clerk', 'clerk@hardware.com', 'clerk123', TRUE, 3),
('Cashier', 'cashier@hardware.com', 'cashier123', TRUE, 4),
('Delivery', 'delivery@hardware.com', 'delivery123', TRUE, 5);

-- Reset first-login testing for every non-administrator account.
UPDATE users
SET must_change_password = TRUE
WHERE role_id IN (2, 3, 4, 5);

-- 2. Entities: Categories, Brands, Units, Suppliers, & Customers
INSERT INTO categories (category_name) VALUES 
('Hand Tools'), 
('Power Tools'), 
('Plumbing'), 
('Electrical'), 
('Construction Materials');

INSERT INTO brands (brand_name) VALUES 
('Makita'), 
('DeWalt'), 
('Stanley'), 
('Boysen'), 
('Pioneer');

INSERT INTO units (unit_name) VALUES 
('pcs'), 
('bag'), 
('liter'), 
('meter'), 
('box');

INSERT INTO suppliers (supplier_name, contact_person, contact_number, email, address) VALUES 
('Manila Hardware Supply', 'Juan Dela Cruz', '0917-123-4567', 'sales@manilahardware.ph', 'Binondo, Manila'),
('Cebu Tool Co.', 'Maria Santos', '0918-987-6543', 'contact@cebutool.com', 'Mandaue City, Cebu');

INSERT INTO customers (first_name, last_name, phone, address) VALUES 
('Pedro', 'Penduko', '0922-333-4444', 'Quezon City, Metro Manila'),
('Juan', 'Tamad', '0999-888-7777', 'Pasig City, Metro Manila');

INSERT INTO customer_credits (customer_id, total_purchase, credit_limit, current_credit) VALUES 
(1, 15000.00, 50000.00, 10000.00),
(2, 5000.00, 20000.00, 0.00);

-- 3. Products & Inventory
-- Pricing is in PHP (Philippine Peso)
INSERT INTO products (product_name, brand_id, category_id, unit_id, price, reorder_point, status, supplier_id) VALUES 
('Cordless Drill 18V', 1, 2, 1, 8500.00, 5, 'Active', 1),   -- Makita, Power Tools
('Claw Hammer', 3, 1, 1, 450.00, 20, 'Active', 2),         -- Stanley, Hand Tools
('PVC Pipe 1/2"', NULL, 3, 4, 120.00, 50, 'Active', 1),     -- Generic, Plumbing
('Latex Paint White', 4, 5, 3, 750.00, 15, 'Active', 1),    -- Boysen, Construction Materials
('Epoxy A & B', 5, 5, 5, 180.00, 30, 'Active', 2);          -- Pioneer, Construction Materials

INSERT INTO inventory (product_id, quantity_in_stock) VALUES 
(1, 12),
(2, 45),
(3, 150),
(4, 30),
(5, 60);

-- 4. Procurement & Returns
INSERT INTO purchase_orders (supplier_id, status) VALUES 
(1, 'Received'),
(2, 'Pending');

-- Unit cost is the raw cost from the supplier (lower than selling price)
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES 
(1, 1, 10, 7000.00),  -- Cost: ₱7,000 | SRP: ₱8,500
(1, 3, 100, 90.00),   -- Cost: ₱90 | SRP: ₱120
(2, 2, 50, 300.00);   -- Cost: ₱300 | SRP: ₱450

INSERT INTO returned_items (product_id, quantity, reason) VALUES 
(1, 1, 'Defective battery'),
(4, 2, 'Wrong color delivered by mistake');

-- 5. Sales & Line Items
INSERT INTO sales (customer_id, cashier_id, total_amount, discount, final_amount, amount_paid, change_given, payment_method) VALUES 
(1, 4, 8950.00, 0.00, 8950.00, 9000.00, 50.00, 'Cash'),  -- Sale 1: Drill + Hammer
(2, 4, 1500.00, 0.00, 1500.00, 1500.00, 0.00, 'Credit'); -- Sale 2: Paint x2 on credit

INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal) VALUES 
(1, 1, 1, 8500.00, 8500.00), -- 1x Cordless Drill
(1, 2, 1, 450.00, 450.00),   -- 1x Claw Hammer
(2, 4, 2, 750.00, 1500.00);  -- 2x Latex Paint

-- 6. Fulfillment
INSERT INTO deliveries (sale_id, delivery_person_id, delivery_address, status, remarks, scheduled_date) VALUES 
(1, 5, 'Quezon City, Metro Manila', 'Delivered', 'Delivered safely to customer front door', '2026-08-28'),
(2, 5, 'Pasig City, Metro Manila', 'Pending', 'Awaiting truck dispatch', '2026-08-29');