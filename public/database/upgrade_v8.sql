-- ==========================================================================
-- upgrade_v8.sql
-- Hardware Sales & Inventory with Credit Management
--
-- The stock adjustment starts saying what it counted.
--
-- WHAT WAS WRONG
--
-- A hardware shop counts almost nothing in the same unit twice: cement in
-- bags, pipe in metres, nails by the kilo, paint in litres, fittings by the
-- piece. The units table shipped with five names and no kilogram in it, and
-- the only way a new one could appear was for somebody to open the database
-- and INSERT it. A clerk holding a sack of nails had no way to say so.
--
-- Worse, the adjustment log recorded a bare figure. "+20" against Portland
-- Cement is twenty of something, and six months later nobody reading the log
-- can say whether that was twenty bags or twenty kilos. The unit was known at
-- the moment it was typed and thrown away immediately afterwards.
--
-- WHAT THIS CHANGES
--
-- stock_adjustments.unit_name records what the figure was counted in, as text
-- and at the time. Text rather than a foreign key on purpose: a unit renamed
-- next year must not rewrite what last year's entries say they counted, and a
-- log that quietly changes its own history is worse than one that is terse.
--
-- unit_name on the units table itself gains nothing new, but the adjustment
-- procedure will now create a unit that does not exist yet rather than
-- refusing, so the list grows from real use instead of from a DBA.
--
-- Existing rows are backfilled from the product's current unit. That is the
-- best available answer and it is usually right, but it is a reconstruction
-- rather than a record, so rows filled in this way are marked by having been
-- filled at all: anything genuinely unknown stays NULL.
--
-- Safe on a database that already holds real data, and safe to run twice.
--
--     mysql -u root -p < public/database/upgrade_v8.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- The second line is not optional: the adjustment procedure takes the unit
-- now, and a new procedure renames and merges units.
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
-- 1. WHAT THE FIGURE WAS COUNTED IN
--
-- Held as text, not as a link to the units table. The log is history: if
-- somebody renames "bag" to "sack" next year, the entries filed under bags
-- have to keep saying bags, because that is what the clerk wrote down and
-- what the delivery note said.
-- ==========================================================================
CALL sp_upgrade_add_column('stock_adjustments', 'unit_name',
    "VARCHAR(20) NULL AFTER quantity_after");

-- The product's unit today is the best available answer for entries filed
-- before the column existed, and it is right for every material whose unit
-- has not changed since. Only rows with nothing at all are touched, so this
-- is safe to run twice and will never overwrite a unit actually recorded.
UPDATE stock_adjustments sa
JOIN products p ON p.product_id = sa.product_id
LEFT JOIN units u ON u.unit_id = p.unit_id
SET sa.unit_name = u.unit_name
WHERE sa.unit_name IS NULL AND u.unit_name IS NOT NULL;

-- ==========================================================================
-- 2. THE UNITS A HARDWARE SHOP ACTUALLY USES
--
-- The five that shipped were pcs, bag, liter, meter and box. A shop that
-- sells nails by the kilo, wire by the roll and sand by the cubic metre could
-- not record any of it. These are added if missing and left alone if a name
-- is already there, so a shop that has been typing its own units keeps them.
-- ==========================================================================
INSERT INTO units (unit_name)
SELECT wanted.unit_name
FROM (
    SELECT 'kilogram' AS unit_name UNION ALL
    SELECT 'gram'     UNION ALL
    SELECT 'sack'     UNION ALL
    SELECT 'roll'     UNION ALL
    SELECT 'set'      UNION ALL
    SELECT 'pack'     UNION ALL
    SELECT 'gallon'   UNION ALL
    SELECT 'sheet'    UNION ALL
    SELECT 'tube'     UNION ALL
    SELECT 'foot'
) AS wanted
LEFT JOIN units u ON LOWER(u.unit_name) = wanted.unit_name
WHERE u.unit_id IS NULL;

-- ==========================================================================
-- 3. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v8.sql finished. Now load stored_Procedure.sql to pick up the adjustment and unit procedures.' AS result;
