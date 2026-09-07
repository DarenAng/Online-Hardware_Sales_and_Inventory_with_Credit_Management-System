-- ==========================================================================
-- upgrade_v5.sql
-- Hardware Sales & Inventory with Credit Management
--
-- Makes a returned item say where it went.
--
-- The record held a true/false called "restocked", which is a question about
-- a checkbox rather than about the item in somebody's hand. Nobody read it,
-- and a return filed with it off left the goods unaccounted for: not on the
-- shelf, not written off, just gone from the system while still sitting in a
-- box behind the counter.
--
-- disposition replaces it as the thing that is decided and recorded, in
-- words. restocked stays, because it is what the stock movement is driven
-- from, but it is derived from the disposition now rather than set
-- separately, so the two cannot disagree.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v5.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- The second line is not optional: the return procedure takes the new
-- disposition instead of the old flag.
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
-- 1. WHERE THE GOODS WENT
-- ==========================================================================
CALL sp_upgrade_add_column('returned_items', 'disposition',
    "ENUM('Return to Stock', 'Write-Off') NOT NULL DEFAULT 'Write-Off' AFTER reason");

-- Existing rows already carry the answer in restocked; this just writes it
-- down in the column that will be read from now on.
UPDATE returned_items
SET disposition = IF(restocked = TRUE, 'Return to Stock', 'Write-Off');

-- ==========================================================================
-- 2. A REASON THAT IS ACTUALLY THERE
--
-- The column allowed NULL, so a report could be filed with nothing said. Any
-- row that came through that way is marked rather than invented, because a
-- made-up reason in an audit trail is worse than an admitted gap.
-- ==========================================================================
UPDATE returned_items
SET reason = 'No reason was recorded when this report was filed.'
WHERE reason IS NULL OR TRIM(reason) = '';

ALTER TABLE returned_items MODIFY reason TEXT NOT NULL;

-- ==========================================================================
-- 3. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v5.sql finished. Now load stored_Procedure.sql to pick up the new return procedure.' AS result;
