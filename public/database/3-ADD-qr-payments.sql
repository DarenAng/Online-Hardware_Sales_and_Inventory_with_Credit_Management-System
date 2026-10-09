-- ==========================================================================
-- 3-ADD-qr-payments.sql
-- Lucelyn Hardware - adds QR payments (GCash and Maya, through PayMongo) to a
-- database that already holds real data.
--
-- Only for an existing hardware_db made before QR payments. A database built
-- from the current 1-RUN-FIRST-database.sql already has this table, and running
-- this file there changes nothing. It adds one table and touches no row.
--
--   mysql -u root -p < public/database/3-ADD-qr-payments.sql
--   mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
--
-- File 2 brings the three procedures the table is written through
-- (sp_create_qr_payment, sp_set_qr_payment_result, sp_link_qr_payment_to_sale).
-- Restarting the server does the same: it loads file 2 by itself when the
-- database has fewer procedures than the code expects.
-- ==========================================================================

USE hardware_db;

-- the same table as in 1-RUN-FIRST-database.sql; see the notes there
CREATE TABLE IF NOT EXISTS qr_payments (
    qr_payment_id INT AUTO_INCREMENT PRIMARY KEY,
    provider ENUM('paymongo','sim') NOT NULL,
    mode ENUM('test','live') NOT NULL,
    provider_intent_id VARCHAR(80) NOT NULL,
    provider_payment_id VARCHAR(80) NULL,
    amount DECIMAL(12,2) NOT NULL,
    wallet ENUM('GCash','PayMaya') NOT NULL,
    purpose ENUM('sale','credit_payment') NOT NULL,
    status ENUM('pending','paid','failed','expired','cancelled') NOT NULL DEFAULT 'pending',
    error_message VARCHAR(255) NULL,
    sale_id INT NULL,
    created_by_staff_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    paid_at TIMESTAMP NULL,
    closed_at TIMESTAMP NULL,
    UNIQUE KEY uq_qr_payments_intent (provider_intent_id),
    INDEX idx_qr_payments_created (created_at),
    INDEX idx_qr_payments_status (status),
    FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
);
