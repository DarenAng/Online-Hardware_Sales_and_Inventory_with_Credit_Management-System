-- ==========================================================================
-- 5-MIGRATION-missing-delivery-reports.sql
-- Lucelyn Hardware - report goods that are missing from a supplier's delivery.
--
-- Before: a report could be Damaged, Refunded or a plain Return, for one
-- material at a time. After: the Inventory Clerk can also file a report of
-- type Missing against a purchase order, for several materials at once. A
-- Missing report never changes the stock (the goods never arrived).
--
-- What this file changes (it never drops a table or the database, and no
-- row is deleted):
--   1. adds 'Missing' to the report types of returned_items
--   2. adds returned_items.po_id (empty on every report that exists today)
--      with a link to purchase_orders
--
-- It does not hold the procedures. They are in 2-RUN-SECOND-stored-procedures.sql
-- (sp_file_return_report has two more parameters, sp_file_return_reports is
-- new, sp_resolve_return_report closes a Missing report): run that file after
-- this one. Until it is run, filing a report fails.
--
-- Safe to run more than once: each step checks first. The server also does
-- steps 1 and 2 by itself when it starts, and loads file 2 again when it finds
-- the older procedures, so on a PC you only need to restart the server.
--
-- How to run it by hand (local MySQL):
--   mysql -u root -p < public/database/5-MIGRATION-missing-delivery-reports.sql
--   mysql -u root -p < public/database/2-RUN-SECOND-stored-procedures.sql
--
-- On Aiven run the same files, with the USE line below changed to the Aiven
-- database name (it is "defaultdb" unless you made another).
-- ==========================================================================

USE hardware_db;

-- 1. the new report type
SET @has_type = (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
                   AND COLUMN_NAME = 'report_type' AND COLUMN_TYPE LIKE '%''Missing''%');
SET @step = IF(@has_type > 0,
    'SELECT ''returned_items.report_type already has Missing'' AS note',
    'ALTER TABLE returned_items MODIFY COLUMN report_type ENUM(''Return'', ''Damaged'', ''Refunded'', ''Missing'') NOT NULL DEFAULT ''Return''');
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

-- 2. the purchase order a Missing report is about
SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
                     AND COLUMN_NAME = 'po_id');
SET @step = IF(@has_column > 0,
    'SELECT ''returned_items.po_id is already there'' AS note',
    'ALTER TABLE returned_items ADD COLUMN po_id INT NULL AFTER sale_id, ADD FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE RESTRICT ON UPDATE CASCADE');
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

-- shows the result; run 2-RUN-SECOND-stored-procedures.sql next
SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
  AND COLUMN_NAME IN ('report_type', 'po_id');
