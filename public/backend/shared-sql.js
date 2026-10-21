const LOW_STOCK_EFFECTIVE_SQL = "\n  SELECT COUNT(*) AS n\n" +
  "  FROM products p\n" +
  "  LEFT JOIN inventory i ON i.product_id = p.product_id\n" +
  "  WHERE p.is_archived = FALSE\n" +
  "    AND COALESCE(i.quantity_in_stock, 0) <= p.reorder_point";

const USER_SELECT = "\n  SELECT s.staff_id, s.first_name, s.middle_name, s.last_name, s.full_name,\n" +
  "         s.phone, s.is_active,\n" +
  "         s.created_at AS staff_created_at,\n" +
  "         s.archived_at, ab.full_name AS archived_by,\n" +
  "         r.role_id, r.role_name,\n" +
  "         u.user_id, u.email, u.must_change_password, u.last_login, u.created_at,\n" +
  "         u.failed_attempts,\n" +
  "         IF(u.held_until IS NOT NULL AND u.held_until > NOW(), u.held_until, NULL) AS held_until\n" +
  "  FROM staff s\n" +
  "  JOIN roles r ON r.role_id = s.role_id\n" +
  "  LEFT JOIN users u ON u.staff_id = s.staff_id\n" +
  "  LEFT JOIN staff ab ON ab.staff_id = s.archived_by_staff_id\n";

const SALE_CUSTOMER_SQL = "\n  COALESCE(NULLIF(c.full_name, ''),\n" +
  "           NULLIF(TRIM(s.walk_in_name), ''),\n" +
  "           'Walk-in')";

const DELIVERY_CONTACT_SQL = "\n  COALESCE(NULLIF(TRIM(d.contact_name), ''),\n" +
  "           NULLIF(c.full_name, ''),\n" +
  "           NULLIF(TRIM(s.walk_in_name), ''),\n" +
  "           'Walk-in')";

const DELIVERY_PHONE_SQL = "\n  COALESCE(NULLIF(TRIM(d.contact_phone), ''), NULLIF(TRIM(c.phone), ''))";

module.exports = {
  LOW_STOCK_EFFECTIVE_SQL: LOW_STOCK_EFFECTIVE_SQL,
  USER_SELECT: USER_SELECT,
  SALE_CUSTOMER_SQL: SALE_CUSTOMER_SQL,
  DELIVERY_CONTACT_SQL: DELIVERY_CONTACT_SQL,
  DELIVERY_PHONE_SQL: DELIVERY_PHONE_SQL
};
