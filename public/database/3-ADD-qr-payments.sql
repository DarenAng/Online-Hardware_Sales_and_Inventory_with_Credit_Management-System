USE hardware_db;

CREATE TABLE IF NOT EXISTS qr_payments (
    qr_payment_id INT AUTO_INCREMENT PRIMARY KEY,
    provider ENUM('paymongo','sim') NOT NULL,
    mode ENUM('test','live') NOT NULL,
    provider_intent_id VARCHAR(80) NOT NULL,
    provider_payment_id VARCHAR(80) NULL,
    amount DECIMAL(12,2) NOT NULL,
    wallet ENUM('GCash','PayMaya','Bank Transfer') NOT NULL,
    bank_code VARCHAR(20) NULL,
    bank_name VARCHAR(80) NULL,
    account_name VARCHAR(100) NULL,
    account_number VARCHAR(30) NULL,
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
