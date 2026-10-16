// ============================================================
// shared-sql.js -- SQL text that more than one route file uses
// Loaded by: server.js (handed on to the route files) and routes/shared.js.
// Never sent to a browser.
// ============================================================

// How many materials sit at or under their EFFECTIVE reorder point
// (calculated for a product on Dynamic): the same formula as /api/stocks;
// the three ? are SALES_WINDOW_DAYS.
const LOW_STOCK_EFFECTIVE_SQL = `
  WITH window_days AS (
    SELECT GREATEST(LEAST(?, COALESCE(DATEDIFF(CURDATE(), DATE(MIN(sale_date))) + 1, ?)), 1) AS days
    FROM sales WHERE is_archived = FALSE
  ),
  recent AS (
    SELECT si.product_id, COALESCE(SUM(si.quantity), 0) AS units
    FROM sale_items si
    JOIN sales s ON s.sale_id = si.sale_id
    WHERE s.is_archived = FALSE AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    GROUP BY si.product_id
  )
  SELECT COUNT(*) AS n
  FROM products p
  CROSS JOIN window_days w
  LEFT JOIN recent rc ON rc.product_id = p.product_id
  LEFT JOIN inventory i ON i.product_id = p.product_id
  WHERE p.is_archived = FALSE
    AND COALESCE(i.quantity_in_stock, 0) <=
        CASE WHEN p.reorder_mode = 'Dynamic'
             THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
             ELSE p.reorder_point END`;

// archived_at and archived_by because the restore card says when and by whom
const USER_SELECT = `
  SELECT s.staff_id, s.first_name, s.middle_name, s.last_name, s.full_name,
         s.phone, s.is_active,
         s.created_at AS staff_created_at,
         s.archived_at, ab.full_name AS archived_by,
         r.role_id, r.role_name,
         u.user_id, u.email, u.must_change_password, u.last_login, u.created_at,
         u.failed_attempts,
         IF(u.held_until IS NOT NULL AND u.held_until > NOW(), u.held_until, NULL) AS held_until
  FROM staff s
  JOIN roles r ON r.role_id = s.role_id
  LEFT JOIN users u ON u.staff_id = s.staff_id
  LEFT JOIN staff ab ON ab.staff_id = s.archived_by_staff_id
`;

// ==========================================
// NAMES SHARED BY THE MODULES -- how a sale or a delivery says who it is for
// ==========================================
// who the sale was for: the account, then the name taken at the till, then walk-in
const SALE_CUSTOMER_SQL = `
  COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
           NULLIF(TRIM(s.walk_in_name), ''),
           'Walk-in')`;

// for a delivery the name on the booking outranks the customer record
const DELIVERY_CONTACT_SQL = `
  COALESCE(NULLIF(TRIM(d.contact_name), ''),
           NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
           NULLIF(TRIM(s.walk_in_name), ''),
           'Walk-in')`;

const DELIVERY_PHONE_SQL = `
  COALESCE(NULLIF(TRIM(d.contact_phone), ''), NULLIF(TRIM(c.phone), ''))`;

module.exports = {
  LOW_STOCK_EFFECTIVE_SQL, USER_SELECT, SALE_CUSTOMER_SQL, DELIVERY_CONTACT_SQL, DELIVERY_PHONE_SQL
};
