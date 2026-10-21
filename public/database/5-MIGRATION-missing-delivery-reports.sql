USE hardware_db;

SET @has_type = (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
                   AND COLUMN_NAME = 'report_type' AND COLUMN_TYPE LIKE '%''Missing''%');
SET @step = IF(@has_type > 0,
    'SELECT ''returned_items.report_type already has Missing'' AS note',
    'ALTER TABLE returned_items MODIFY COLUMN report_type ENUM(''Return'', ''Damaged'', ''Refunded'', ''Missing'') NOT NULL DEFAULT ''Return''');
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

SET @has_column = (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
                     AND COLUMN_NAME = 'po_id');
SET @step = IF(@has_column > 0,
    'SELECT ''returned_items.po_id is already there'' AS note',
    'ALTER TABLE returned_items ADD COLUMN po_id INT NULL AFTER sale_id, ADD FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE RESTRICT ON UPDATE CASCADE');
PREPARE step FROM @step;
EXECUTE step;
DEALLOCATE PREPARE step;

SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'returned_items'
  AND COLUMN_NAME IN ('report_type', 'po_id');
