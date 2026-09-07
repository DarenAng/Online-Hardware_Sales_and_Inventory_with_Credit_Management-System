-- ==========================================================================
-- upgrade_v3.sql
-- Hardware Sales & Inventory with Credit Management
--
-- Gives every product the two figures a reorder point is calculated from,
-- so the system can work out when to reorder instead of being told.
--
--     ROP = (average daily sales x lead time) + safety stock
--
-- Average daily sales the system already knows: it is in sale_items. What it
-- did not know is how long a supplier takes to deliver, and how much cover
-- the shop wants to hold on top. Those two are attributes of the product and
-- the arrangement with its supplier, so they live on the product.
--
-- reorder_point stays exactly where it was and keeps working. A product is
-- Manual until somebody switches it to Dynamic, and a Manual product still
-- uses the number a person typed. Nothing changes on its own.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v3.sql
--
-- Run upgrade_v2.sql first if you have not already.
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
-- 1. THE REORDER POLICY
-- ==========================================================================

-- How many days pass between raising a purchase order with this product's
-- supplier and the goods being on the shelf. Seven is a working default for a
-- Metro Manila supplier; it is meant to be corrected per product.
CALL sp_upgrade_add_column('products', 'lead_time_days',
    'INT NOT NULL DEFAULT 7 AFTER reorder_point');

-- The cushion held on top of expected demand, for the week the supplier is
-- late or the week a contractor buys three months of cement at once.
CALL sp_upgrade_add_column('products', 'safety_stock',
    'INT NOT NULL DEFAULT 0 AFTER lead_time_days');

-- Manual keeps using the reorder_point somebody typed. Dynamic recalculates
-- it from actual sales. It is a per-product choice on purpose: a fast-moving
-- consumable earns its formula, and a slow item nobody has bought in a year
-- would only get a reorder point of zero out of one.
CALL sp_upgrade_add_column('products', 'reorder_mode',
    "ENUM('Manual','Dynamic') NOT NULL DEFAULT 'Manual' AFTER safety_stock");

-- --------------------------------------------------------------------------
-- A sensible starting lead time by category, so the first look at the screen
-- is not seven days for everything. Only rows still on the default are
-- touched, so running this twice does not undo a correction somebody made.
-- --------------------------------------------------------------------------
UPDATE products p
JOIN categories c ON c.category_id = p.category_id
SET p.lead_time_days = CASE c.category_name
        WHEN 'Construction Materials' THEN 10
        WHEN 'Power Tools'            THEN 14
        WHEN 'Electrical'             THEN 5
        WHEN 'Plumbing'               THEN 5
        ELSE 7
    END
WHERE p.lead_time_days = 7;

-- ==========================================================================
-- 2. THE AUDIT TRAIL, AS THE PROCEDURES WRITE IT
--
-- Three stored procedures write their own audit entries, and they were
-- written before action_type existed, so everything they record has been
-- landing under OTHER. The procedures themselves are corrected in
-- stored_Procedure.sql; this sorts the entries already written.
-- ==========================================================================
UPDATE audit_logs SET action_type = 'PAYMENT'
    WHERE action = 'PAYMENT' AND action_type = 'OTHER';
UPDATE audit_logs SET action_type = 'UPDATE'
    WHERE action = 'DELIVERY_STATUS' AND action_type = 'OTHER';
UPDATE audit_logs SET action_type = 'CREATE'
    WHERE action = 'SALE' AND action_type = 'OTHER';

-- ==========================================================================
-- 3. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v3.sql finished. Products now carry a lead time, a safety stock and a reorder mode.' AS result;
