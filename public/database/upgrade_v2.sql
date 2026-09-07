-- ==========================================================================
-- upgrade_v2.sql
-- Hardware Sales & Inventory with Credit Management
--
-- Widens the audit trail so a recorded action says who, from where, what
-- kind of action it was, and exactly what changed.
--
-- Safe on a database that already holds real data, and safe to run twice:
-- every step checks information_schema first and does nothing if the column
-- or index is already there. Nothing here drops or rewrites a row.
--
--     mysql -u root -p < public/database/upgrade_v2.sql
--
-- Run public/database/stored_Procedure.sql afterwards only if you also
-- changed a procedure; this file does not touch them.
-- ==========================================================================

USE hardware_db;

-- --------------------------------------------------------------------------
-- A small helper so each change can be asked for once and skipped if it is
-- already in place. It is dropped again at the bottom of the file, so the
-- database is left with exactly the eighteen procedures it started with.
-- --------------------------------------------------------------------------
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
-- 1. THE AUDIT TRAIL
--
-- The table recorded a staff id, a free-text action and a line of detail.
-- That is enough to say something happened and not enough to answer the
-- questions an audit actually gets asked: which role was this person in at
-- the time, which machine did it come from, was this a create or a void, and
-- what were the values before and after.
--
-- role_name is a snapshot on purpose. A person moves between roles, and an
-- entry that reads the role off the staff record today would quietly rewrite
-- last month's history the moment somebody is promoted.
-- ==========================================================================
CALL sp_upgrade_add_column('audit_logs', 'role_name',
    'VARCHAR(50) NULL AFTER staff_id');

CALL sp_upgrade_add_column('audit_logs', 'ip_address',
    'VARCHAR(45) NULL AFTER role_name');

-- The category the action falls into, kept beside the free-text action rather
-- than replacing it: the action names what happened, the type is what the
-- audit screen filters and groups on.
CALL sp_upgrade_add_column('audit_logs', 'action_type',
    "ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP','LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT','OTHER') NOT NULL DEFAULT 'OTHER' AFTER action");

-- Before-and-after values, as JSON. TEXT rather than the JSON type so a
-- backup taken here still restores on an older MySQL 8 point release.
CALL sp_upgrade_add_column('audit_logs', 'metadata',
    'TEXT NULL AFTER details');

-- The audit screen reads newest first and filters by type and by day, so
-- those are the two indexes it needs.
SET @has_index = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'audit_logs'
      AND INDEX_NAME = 'idx_audit_when'
);
SET @statement = IF(@has_index = 0,
    'CREATE INDEX idx_audit_when ON audit_logs (created_at DESC)',
    'SELECT 1');
PREPARE upgrade_stmt FROM @statement;
EXECUTE upgrade_stmt;
DEALLOCATE PREPARE upgrade_stmt;

SET @has_index = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'audit_logs'
      AND INDEX_NAME = 'idx_audit_type'
);
SET @statement = IF(@has_index = 0,
    'CREATE INDEX idx_audit_type ON audit_logs (action_type)',
    'SELECT 1');
PREPARE upgrade_stmt FROM @statement;
EXECUTE upgrade_stmt;
DEALLOCATE PREPARE upgrade_stmt;

-- --------------------------------------------------------------------------
-- Entries written before this upgrade all carry the default type OTHER,
-- which would make the new filter useless on the history that already
-- exists. Their action names still say what they were, so they are sorted
-- once, here. Rows written from now on arrive with their type already set.
-- --------------------------------------------------------------------------
UPDATE audit_logs SET action_type = 'LOGIN'    WHERE action_type = 'OTHER' AND action = 'LOGIN';
UPDATE audit_logs SET action_type = 'LOGOUT'   WHERE action_type = 'OTHER' AND action = 'LOGOUT';
UPDATE audit_logs SET action_type = 'CREATE'   WHERE action_type = 'OTHER' AND action LIKE 'CREATE%';
UPDATE audit_logs SET action_type = 'UPDATE'   WHERE action_type = 'OTHER' AND action LIKE 'UPDATE%';
UPDATE audit_logs SET action_type = 'UPDATE'   WHERE action_type = 'OTHER' AND action IN ('ACTIVATE_ACCOUNT', 'DEACTIVATE_ACCOUNT');
UPDATE audit_logs SET action_type = 'SECURITY' WHERE action_type = 'OTHER' AND action LIKE '%PASSWORD%';
UPDATE audit_logs SET action_type = 'RESTORE'  WHERE action_type = 'OTHER' AND action LIKE '%RESTORE%';
UPDATE audit_logs SET action_type = 'BACKUP'   WHERE action_type = 'OTHER' AND action LIKE '%BACKUP%';
UPDATE audit_logs SET action_type = 'DELETE'   WHERE action_type = 'OTHER' AND (action LIKE 'DELETE%' OR action LIKE 'ARCHIVE%');
UPDATE audit_logs SET action_type = 'VOID'     WHERE action_type = 'OTHER' AND action LIKE '%VOID%';
UPDATE audit_logs SET action_type = 'PAYMENT'  WHERE action_type = 'OTHER' AND action LIKE '%PAYMENT%';

-- The role behind an old entry can still be filled in, because a person who
-- has not changed role since is in the role the entry was written under. It
-- is only ever a best guess for history, so it is done once and never again.
UPDATE audit_logs l
JOIN staff s ON s.staff_id = l.staff_id
JOIN roles r ON r.role_id = s.role_id
SET l.role_name = r.role_name
WHERE l.role_name IS NULL;

-- ==========================================================================
-- 2. TIDY UP
-- ==========================================================================
DROP PROCEDURE IF EXISTS sp_upgrade_add_column;

SELECT 'upgrade_v2.sql finished. The audit trail now records role, IP address, action type and metadata.' AS result;
