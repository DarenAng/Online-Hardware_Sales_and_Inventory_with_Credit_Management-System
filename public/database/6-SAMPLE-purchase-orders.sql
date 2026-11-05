-- Sample purchase orders for the Receive Deliveries screen.
-- Run after 1-database.sql and 2-stored-procedures.sql. It only adds rows.
-- Running it twice adds the orders twice.
--
-- What it adds:
--   Out for Delivery, arrives in 3 days       (Manila Hardware Supply)
--   Out for Delivery, 2 days late             (Luzon Electrical Supply)
--   Out for Delivery, arrives today           (Batangas Builders Depot)
--   Incomplete, supplier has not answered     (Metro Fasteners Inc.)
--   Incomplete, supplier will deliver the rest (Southern Tagalog Paints)
--   Sent to Supplier, waiting for an answer   (Cebu Tool Co.)
-- The two Incomplete orders are received through sp_receive_purchase_order, so stock and the
-- adjustment history match.

USE hardware_db;

-- Out for Delivery, arrives in 3 days
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at, supplier_response, supplier_responded_at, supplier_ship_date)
VALUES (1, NOW() - INTERVAL 4 DAY, 'Pending', 3, 2, NOW() - INTERVAL 4 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 4 DAY, 'Accepted', NOW() - INTERVAL 3 DAY, CURDATE() + INTERVAL 3 DAY);
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 22, 40, 145.00),
(@po, 25, 100, 18.00),
(@po, 23, 60, 12.00);

-- Out for Delivery, 2 days late
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at, supplier_response, supplier_responded_at, supplier_ship_date)
VALUES (5, NOW() - INTERVAL 9 DAY, 'Pending', 3, 2, NOW() - INTERVAL 9 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 9 DAY, 'Accepted', NOW() - INTERVAL 8 DAY, CURDATE() - INTERVAL 2 DAY);
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 28, 5, 1845.26),
(@po, 30, 50, 85.63),
(@po, 31, 40, 57.10);

-- Out for Delivery, arrives today
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at, supplier_response, supplier_responded_at, supplier_ship_date)
VALUES (3, NOW() - INTERVAL 6 DAY, 'Pending', 3, 2, NOW() - INTERVAL 6 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 6 DAY, 'Accepted', NOW() - INTERVAL 5 DAY, CURDATE());
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 36, 500, 13.50),
(@po, 35, 50, 240.00),
(@po, 39, 20, 650.00);

-- Incomplete: 15 Concrete Nails short, shortage emailed, no answer yet
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at, supplier_response, supplier_responded_at, supplier_ship_date)
VALUES (6, NOW() - INTERVAL 8 DAY, 'Pending', 3, 2, NOW() - INTERVAL 8 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 8 DAY, 'Accepted', NOW() - INTERVAL 7 DAY, CURDATE() - INTERVAL 1 DAY);
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 45, 30, 59.89),
(@po, 46, 40, 70.95),
(@po, 48, 50, 43.38);
CALL sp_receive_purchase_order(@po,
    '[{"product_id":45,"quantity":30},{"product_id":46,"quantity":25},{"product_id":48,"quantity":50}]',
    NULL, 3, 0, @lines, @extras, @status_code, @message);
SELECT @po AS po_id, @status_code AS status_code, @message AS message;
UPDATE purchase_orders SET shortage_sent_at = NOW() - INTERVAL 1 DAY WHERE po_id = @po;

-- Incomplete: 4 Primer and 10 Paint Rollers short, supplier will deliver the rest
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at, supplier_response, supplier_responded_at, supplier_ship_date)
VALUES (4, NOW() - INTERVAL 12 DAY, 'Pending', 3, 2, NOW() - INTERVAL 12 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 12 DAY, 'Accepted', NOW() - INTERVAL 11 DAY, CURDATE() - INTERVAL 3 DAY);
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 42, 24, 232.80),
(@po, 43, 10, 642.76),
(@po, 44, 30, 71.45);
CALL sp_receive_purchase_order(@po,
    '[{"product_id":42,"quantity":24},{"product_id":43,"quantity":6},{"product_id":44,"quantity":20}]',
    NULL, 3, 0, @lines, @extras, @status_code, @message);
SELECT @po AS po_id, @status_code AS status_code, @message AS message;
UPDATE purchase_orders
SET shortage_sent_at = NOW() - INTERVAL 3 DAY,
    shortage_response = 'Will deliver',
    shortage_responded_at = NOW() - INTERVAL 2 DAY,
    supplier_ship_date = CURDATE() + INTERVAL 5 DAY
WHERE po_id = @po;

-- Sent to Supplier, waiting for an answer
INSERT INTO purchase_orders (supplier_id, order_date, status, raised_by_staff_id, confirmed_by_staff_id, confirmed_at,
                             supplier_code, supplier_sent_at)
VALUES (2, NOW() - INTERVAL 1 DAY, 'Pending', 3, 2, NOW() - INTERVAL 1 DAY,
        REPLACE(UUID(), '-', ''), NOW() - INTERVAL 1 DAY);
SET @po = LAST_INSERT_ID();
INSERT INTO purchase_order_items (po_id, product_id, quantity, unit_cost) VALUES
(@po, 9, 5, 2150.00),
(@po, 12, 3, 2890.00);
