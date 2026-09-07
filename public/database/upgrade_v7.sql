-- ==========================================================================
-- upgrade_v7.sql
-- Hardware Sales & Inventory with Credit Management
--
-- The invoice starts telling the truth about tax.
--
-- WHY THE OLD RECEIPT WAS NOT AN INVOICE
--
-- It printed a shop name that was hard-coded into a JavaScript file, no TIN,
-- and no tax breakdown of any kind. Under RR 7-2024 that is not a document a
-- Philippine shop can hand a customer: the primary document for a sale of
-- goods is an Invoice, it carries the seller's registered name, address and
-- TIN, and a VAT-registered seller has to show the sale split into VATable
-- Sale, VAT, VAT-Exempt Sale and Zero-Rated Sale.
--
-- HOW THE VAT IS WORKED OUT
--
-- Philippine posted prices already include VAT. The 12% is not added to the
-- total; it is extracted from it, and the customer pays the same figure
-- either way. So it is not total x 12%:
--
--     VAT      = total x 12/112          (about 10.71% of the total)
--     VATable  = total - VAT
--
-- The VAT is rounded first and the VATable sale is what is left, rather than
-- dividing by 1.12 and rounding both. On a 213.50 sale, 213.50/1.12 is
-- 190.625, which rounds to 190.63 and then no longer adds back to 213.50.
-- Rounding the VAT first guarantees the two lines sum to the total exactly,
-- which is what a printed invoice has to do.
--
-- NOT EVERY HARDWARE SHOP IS VAT-REGISTERED
--
-- Below the 3,000,000 annual threshold a shop is non-VAT and pays percentage
-- tax instead. It charges no VAT at all, so a VAT block on its invoice would
-- be a fiction: its invoice says NON-VAT REG TIN and breaks the sale into
-- Sales Subject to Percentage Tax and Exempt Sales. Both kinds of shop exist
-- locally, so the registration is a setting rather than something baked into
-- the code, and store_settings is where it lives.
--
-- WHY THE FIGURES ARE STORED ON THE SALE
--
-- An invoice is a record of what was charged on the day it was issued. If the
-- tax split were computed when the invoice is reprinted, then a shop crossing
-- the VAT threshold, or a change in the rate, would silently rewrite every
-- invoice it had ever issued. So each sale carries its own registration type,
-- its own rate and its own split, and changing the setting affects only sales
-- rung up after the change. That is the correct behaviour, not a limitation.
--
-- Nothing here changes any amount a customer pays. The total is the total;
-- these columns only say what it was made of.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v7.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- The second line is not optional: the sale procedure now writes the tax
-- split, and a new procedure saves the store settings.
-- ==========================================================================

USE hardware_db;

DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

DELIMITER $$

CREATE PROCEDURE sp_upgrade_add_column(
    IN in_table   VARCHAR(64),
    IN in_column  VARCHAR(64),
    IN in_clause  VARCHAR(500)
)
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = in_table
          AND COLUMN_NAME = in_column
    ) THEN
        SET @statement = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `',
                                in_column, '` ', in_clause);
        PREPARE upgrade_stmt FROM @statement;
        EXECUTE upgrade_stmt;
        DEALLOCATE PREPARE upgrade_stmt;
    END IF;
END$$

DELIMITER ;

-- ==========================================================================
-- 1. WHO THE SHOP IS, AND HOW IT IS REGISTERED
--
-- One row, id 1, and a CHECK that keeps it that way. A settings table that
-- can hold two rows is a settings table that eventually does, and then half
-- the screens read one row and half read the other.
--
-- The defaults are deliberately obvious placeholders. A shop that has not
-- filled this in should notice on the first invoice it prints, rather than
-- hand a customer somebody else's TIN.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS store_settings (
    setting_id INT PRIMARY KEY DEFAULT 1,
    store_name VARCHAR(150) NOT NULL DEFAULT 'Hardware Sales & Inventory',
    address VARCHAR(255) NOT NULL DEFAULT 'Set your address in System Administration',
    tin VARCHAR(30) NOT NULL DEFAULT '000-000-000-00000',

    -- VAT     charges 12% inside the price, prints the VAT block
    -- NON-VAT below the threshold, pays percentage tax, prints no VAT at all
    registration_type ENUM('VAT','NON-VAT') NOT NULL DEFAULT 'VAT',

    -- Kept as a figure rather than hard-coded at 12, because a rate written
    -- into source code is a rate nobody can change when it moves.
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 12.00,

    -- the line under the barcode: a returns policy, a thank you, anything
    invoice_note VARCHAR(255) NULL,

    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by_staff_id INT NULL,

    CONSTRAINT chk_store_settings_single_row CHECK (setting_id = 1),
    CONSTRAINT chk_store_settings_rate CHECK (vat_rate >= 0 AND vat_rate <= 100)
);

INSERT INTO store_settings (setting_id) VALUES (1)
ON DUPLICATE KEY UPDATE setting_id = setting_id;

-- ==========================================================================
-- 2. WHAT EACH SALE WAS MADE OF
--
-- Every one of these is a fact about the moment the invoice was issued, not
-- a calculation to be redone later. NOT NULL with a zero default, because a
-- NULL on a tax line reads as "unknown" on a document whose whole job is to
-- be certain.
-- ==========================================================================
CALL sp_upgrade_add_column('sales', 'tax_registration',
    "ENUM('VAT','NON-VAT') NOT NULL DEFAULT 'VAT' AFTER payment_status");

CALL sp_upgrade_add_column('sales', 'vat_rate',
    "DECIMAL(5,2) NOT NULL DEFAULT 12.00 AFTER tax_registration");

CALL sp_upgrade_add_column('sales', 'vatable_sale',
    "DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vat_rate");

CALL sp_upgrade_add_column('sales', 'vat_amount',
    "DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vatable_sale");

CALL sp_upgrade_add_column('sales', 'vat_exempt_sale',
    "DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vat_amount");

CALL sp_upgrade_add_column('sales', 'zero_rated_sale',
    "DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vat_exempt_sale");

-- ==========================================================================
-- 3. THE SALES THAT ARE ALREADY THERE
--
-- They were rung up before any of this existed, so their split has to be
-- worked out now from the only thing that was recorded: the total. That is
-- sound, because the total is exactly what a VAT-inclusive price means.
--
-- The registration used is whatever store_settings says at the moment this
-- upgrade runs. A shop that is non-VAT should therefore set that FIRST:
--
--     UPDATE store_settings SET registration_type = 'NON-VAT' WHERE setting_id = 1;
--
-- and then run this file. Only rows still untouched are filled in, so this
-- is safe to run twice and will not overwrite a split already written.
-- ==========================================================================
UPDATE sales s
JOIN store_settings cfg ON cfg.setting_id = 1
SET s.tax_registration = cfg.registration_type,
    s.vat_rate = IF(cfg.registration_type = 'VAT', cfg.vat_rate, 0.00),
    s.vat_amount = IF(cfg.registration_type = 'VAT',
                      ROUND(s.final_amount * cfg.vat_rate / (100 + cfg.vat_rate), 2),
                      0.00),
    s.vatable_sale = IF(cfg.registration_type = 'VAT',
                        s.final_amount -
                        ROUND(s.final_amount * cfg.vat_rate / (100 + cfg.vat_rate), 2),
                        0.00)
WHERE s.vatable_sale = 0.00 AND s.vat_amount = 0.00;

-- ==========================================================================
-- 4. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v7.sql finished. Now load stored_Procedure.sql, then set your shop name, TIN and registration under System Administration.' AS result;
