-- ==========================================
-- UPGRADE AN EXISTING hardware_db
--
-- Use this file only when you already have a hardware_db with real data in it
-- and you do not want to lose that data. It adds what the new version needs
-- and changes nothing else.
--
-- On a fresh computer, ignore this file. Run database.sql and
-- stored_Procedure.sql instead; they already contain everything below.
--
-- Run this once, then run stored_Procedure.sql to reload the procedures.
--
--     mysql -u root -p < public/database/upgrade.sql
--     mysql -u root -p < public/database/stored_Procedure.sql
--
-- Running it twice is harmless: every step checks first.
-- ==========================================
USE hardware_db;

-- ------------------------------------------------------------------
-- 1. staff.middle_initial
--    Two people can share a first and last name. The initial is what
--    tells them apart on every screen.
-- ------------------------------------------------------------------
SET @has_initial = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'hardware_db'
      AND TABLE_NAME = 'staff'
      AND COLUMN_NAME = 'middle_initial'
);

SET @sql = IF(@has_initial = 0,
    'ALTER TABLE staff ADD COLUMN middle_initial VARCHAR(5) NULL AFTER first_name',
    'SELECT "middle_initial is already there" AS note');

PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

-- ------------------------------------------------------------------
-- 2. staff.full_name
--    One definition of a staff name for the whole system, so the
--    directory, the receipt, the audit trail and every report spell it
--    the same way. It is generated, so nothing writes to it.
-- ------------------------------------------------------------------
SET @has_full_name = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'hardware_db'
      AND TABLE_NAME = 'staff'
      AND COLUMN_NAME = 'full_name'
);

SET @sql = IF(@has_full_name = 0,
    'ALTER TABLE staff ADD COLUMN full_name VARCHAR(220) AS (
         CONCAT(first_name,
                IF(middle_initial IS NULL OR middle_initial = \'\', \'\',
                   CONCAT(\' \', UPPER(LEFT(middle_initial, 1)), \'.\')),
                \' \', last_name)
     ) VIRTUAL',
    'SELECT "full_name is already there" AS note');

PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

-- ------------------------------------------------------------------
-- 3. The archive view has to be rebuilt so it uses full_name
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_archives AS
SELECT 'Staff' AS module, s.staff_id AS record_id,
       s.full_name AS record_name,
       r.role_name AS detail, s.archived_at,
       a.full_name AS archived_by
FROM staff s
JOIN roles r ON r.role_id = s.role_id
LEFT JOIN staff a ON a.staff_id = s.archived_by_staff_id
WHERE s.is_active = FALSE
UNION ALL
SELECT 'Inventory', p.product_id, p.product_name,
       CONCAT('Stock ', COALESCE(i.quantity_in_stock, 0)), p.archived_at,
       a.full_name
FROM products p
LEFT JOIN inventory i ON i.product_id = p.product_id
LEFT JOIN staff a ON a.staff_id = p.archived_by_staff_id
WHERE p.is_archived = TRUE
UNION ALL
SELECT 'Sales', sa.sale_id, CONCAT('Sale #', sa.sale_id),
       CONCAT(sa.payment_method, ' ', FORMAT(sa.final_amount, 2)), sa.archived_at,
       a.full_name
FROM sales sa
LEFT JOIN staff a ON a.staff_id = sa.archived_by_staff_id
WHERE sa.is_archived = TRUE
UNION ALL
SELECT 'Delivery', d.delivery_id, CONCAT('Delivery #', d.delivery_id),
       d.status, d.archived_at,
       a.full_name
FROM deliveries d
LEFT JOIN staff a ON a.staff_id = d.archived_by_staff_id
WHERE d.is_archived = TRUE;

-- ------------------------------------------------------------------
-- 4. notifications.created_by_staff_id
--    An alert now says who raised it as well as when. It stays NULL
--    for alerts the system raised on its own, and those read as
--    "System" on screen.
-- ------------------------------------------------------------------
SET @has_author = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'hardware_db'
      AND TABLE_NAME = 'notifications'
      AND COLUMN_NAME = 'created_by_staff_id'
);

SET @sql = IF(@has_author = 0,
    'ALTER TABLE notifications
        ADD COLUMN created_by_staff_id INT NULL AFTER product_id,
        ADD CONSTRAINT fk_notifications_author
            FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id)
            ON DELETE SET NULL ON UPDATE CASCADE',
    'SELECT "created_by_staff_id is already there" AS note');

PREPARE statement FROM @sql;
EXECUTE statement;
DEALLOCATE PREPARE statement;

-- ------------------------------------------------------------------
-- 5. Repair sales that were written before the payment status was set
--    A Credit or COD sale takes no money at the counter, so it is not
--    Paid. They were being saved as Paid with nothing paid on them,
--    which kept them out of receivables and out of the driver's
--    collection list.
-- ------------------------------------------------------------------
UPDATE sales
SET payment_status = CASE
        WHEN amount_paid <= 0                 THEN 'Unpaid'
        WHEN amount_paid < final_amount       THEN 'Partial'
        ELSE 'Paid'
    END
WHERE payment_method IN ('Credit', 'COD')
  AND payment_status = 'Paid'
  AND amount_paid < final_amount;

SELECT 'Upgrade finished. Now run stored_Procedure.sql.' AS next_step;
