const path = require("path");
const fs = require("fs");
const database = require("./connection");
const db = database.db;
const DB_NAME = database.DB_NAME;
const passwords = require("../services/passwords");
const hashPassword = passwords.hashPassword;
const isHashed = passwords.isHashed;
const verifyPassword = passwords.verifyPassword;
const validation = require("../validation");
const cleanPhone = validation.cleanPhone;
const phoneComplaint = validation.phoneComplaint;
const DEFAULT_RECEIPT_LAYOUT = require("../store-settings").DEFAULT_RECEIPT_LAYOUT;

function columnNamesOf(columns) {
  const names = [];
  for (let i = 0; i < columns.length; i++) {
    names.push(columns[i].COLUMN_NAME);
  }
  return names;
}

function findColumn(columns, name) {
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].COLUMN_NAME === name) {
      return columns[i];
    }
  }
  return undefined;
}

async function hashLegacyPasswords() {
  const rowsResult = await db.query("SELECT user_id, password FROM users");
  const rows = rowsResult[0];
  const plain = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!isHashed(row.password)) {
      plain.push(row);
    }
  }

  if (plain.length === 0) return;

  for (let rowIndex = 0; rowIndex < plain.length; rowIndex++) {
    const row = plain[rowIndex];
    await db.query("UPDATE users SET password = ? WHERE user_id = ?",
      [await hashPassword(row.password), row.user_id]);
  }
  console.log("Hashed " + plain.length + " password(s) that were stored as readable text.");
}

async function warnIfAdminPasswordIsDefault() {
  try {
    const rowsResult = await db.query(
      "SELECT password FROM users WHERE email = 'admin@hardware.com'");
    const rows = rowsResult[0];
    if (rows.length === 0) return;
    if (await verifyPassword("admin123", rows[0].password)) {
      console.warn("WARNING: admin@hardware.com still uses the password from the seed file " +
        "(admin123). Sign in and change it now: anyone who has read the project files can sign in as the administrator.");
    }
  } catch (error) {
    console.warn("Could not check the administrator's password:", error.message);
  }
}

async function migrateSignInHold() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'\n" +
      "       AND COLUMN_NAME IN ('failed_attempts', 'held_until')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  if (columns.length === 2) return;

  const names = columnNamesOf(columns);
  if (names.indexOf("failed_attempts") === -1) {
    await db.query(
      "ALTER TABLE users ADD COLUMN failed_attempts INT NOT NULL DEFAULT 0 AFTER must_change_password");
  }
  if (names.indexOf("held_until") === -1) {
    await db.query(
      "ALTER TABLE users ADD COLUMN held_until TIMESTAMP NULL AFTER failed_attempts");
  }
  console.log("Added users.failed_attempts and users.held_until for the sign-in hold.");
}

async function migrateMiddleNameColumn() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'staff'\n" +
      "       AND COLUMN_NAME IN ('middle_initial', 'middle_name')",
    [DB_NAME]
  );
  const columns = columnsResult[0];

  const names = columnNamesOf(columns);
  if (names.indexOf("middle_initial") === -1) return;

  await db.query("ALTER TABLE staff DROP COLUMN full_name");
  await db.query(
    "ALTER TABLE staff CHANGE COLUMN middle_initial middle_name VARCHAR(100) NULL"
  );
  await db.query(
    "ALTER TABLE staff ADD COLUMN full_name VARCHAR(220) AS (\n" +
      "       CONCAT(first_name,\n" +
      "              IF(middle_name IS NULL OR middle_name = '', '',\n" +
      "                 CONCAT(' ', UPPER(LEFT(middle_name, 1)), '.')),\n" +
      "              ' ', last_name)\n" +
      "     ) VIRTUAL AFTER created_at"
  );

  console.log("Upgraded staff.middle_initial to staff.middle_name. " +
    "Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migratePhoneNumbers() {
  const rowsResult = await db.query(
    "SELECT staff_id, phone FROM staff WHERE phone IS NOT NULL AND phone <> ''");
  const rows = rowsResult[0];

  const wrong = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.phone !== cleanPhone(row.phone)) {
      wrong.push(row);
    }
  }
  if (wrong.length === 0) return;

  let emptied = 0;

  for (let rowIndex = 0; rowIndex < wrong.length; rowIndex++) {
    const row = wrong[rowIndex];
    let fixed = null;
    if (phoneComplaint(row.phone) === null) {
      fixed = cleanPhone(row.phone);
    } else {
      emptied += 1;
    }

    await db.query("UPDATE staff SET phone = ? WHERE staff_id = ?", [fixed, row.staff_id]);
  }

  let message = "Rewrote " + wrong.length + " staff phone number(s) to +63 form.";
  if (emptied > 0) {
    message += " " + emptied + " of them was not a usable number and was cleared; re-enter it on the staff record.";
  }
  console.log(message);
}

async function migrateMeasuredQuantities() {
  const columns = [
    ["inventory", "quantity_in_stock", "NOT NULL DEFAULT 0"],
    ["stock_adjustments", "quantity_before", "NOT NULL"],
    ["stock_adjustments", "quantity_change", "NOT NULL"],
    ["stock_adjustments", "quantity_after", "NOT NULL"],
    ["sale_items", "quantity", "NOT NULL"],
    ["returned_items", "quantity", "NOT NULL"]
  ];

  let widened = 0;
  for (let itemIndex = 0; itemIndex < columns.length; itemIndex++) {
    const item = columns[itemIndex];
    const table = item[0];
    const column = item[1];
    const rest = item[2];
    const rowsResult = await db.query(
      "SELECT DATA_TYPE FROM information_schema.COLUMNS\n" +
        "       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [DB_NAME, table, column]);
    const rows = rowsResult[0];
    if (!rows[0] || String(rows[0].DATA_TYPE).toLowerCase() !== "int") continue;

    if (table === "sale_items") {
      await db.query("ALTER TABLE sale_items DROP COLUMN subtotal");
      await db.query("ALTER TABLE sale_items MODIFY quantity DECIMAL(12,3) " + rest);
      await db.query("ALTER TABLE sale_items ADD COLUMN subtotal DECIMAL(12,2) AS (quantity * unit_price) STORED");
    } else {
      await db.query("ALTER TABLE " + table + " MODIFY " + column + " DECIMAL(12,3) " + rest);
    }
    widened += 1;
  }

  if (widened > 0) {
    console.log("Widened " + widened + " quantity column(s) to take fractions (kilos, metres). " +
      "Re-run public/database/2-stored-procedures.sql so the procedures take them too.");
  }
}

async function migrateAccessControlTables() {
  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'role_feature_permissions'",
    [DB_NAME]
  );
  const tables = tablesResult[0];
  const have = [];
  for (let rowIndex = 0; rowIndex < tables.length; rowIndex++) {
    const row = tables[rowIndex];
    have.push(row.TABLE_NAME);
  }
  let created = 0;

  if (!have.includes("role_feature_permissions")) {
    await db.query(
      "CREATE TABLE role_feature_permissions (\n" +
        "         permission_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
        "         role_id INT NOT NULL,\n" +
        "         feature_key VARCHAR(40) NOT NULL,\n" +
        "         is_granted BOOLEAN NOT NULL DEFAULT TRUE,\n" +
        "         note VARCHAR(255) NULL,\n" +
        "         granted_by_staff_id INT NULL,\n" +
        "         granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
        "         updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
        "         UNIQUE KEY uq_role_feature (role_id, feature_key),\n" +
        "         FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE ON UPDATE CASCADE,\n" +
        "         FOREIGN KEY (granted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE\n" +
        "       )");
    created += 1;
  }

  const typeColumnResult = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'action_type'",
    [DB_NAME]
  );
  const typeColumn = typeColumnResult[0];
  let widened = false;
  if (typeColumn[0] && !/'ACCESS'/i.test(typeColumn[0].COLUMN_TYPE)) {
    await db.query(
      "ALTER TABLE audit_logs MODIFY action_type\n" +
        "         ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP',\n" +
        "              'LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT',\n" +
        "              'ACCESS','OTHER') NOT NULL DEFAULT 'OTHER'");
    widened = true;
  }

  if (widened) {
    console.log("Added the access control table and widened the audit types.");
  } else if (created > 0) {
    console.log("Added the access control table.");
  }
}

async function migrateSellingUnits() {
  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_units'",
    [DB_NAME]
  );
  const tables = tablesResult[0];
  let created = false;

  if (tables.length === 0) {
    await db.query(
      "CREATE TABLE product_units (\n" +
        "         product_unit_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
        "         product_id INT NOT NULL,\n" +
        "         unit_name VARCHAR(20) NOT NULL,\n" +
        "         units_per DECIMAL(12,3) NOT NULL,\n" +
        "         price DECIMAL(10,2) NULL,\n" +
        "         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
        "         UNIQUE KEY uq_product_unit (product_id, unit_name),\n" +
        "         FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE\n" +
        "       )");
    created = true;
  }

  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sale_items' AND COLUMN_NAME = 'sold_unit'",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  let widened = false;

  if (columns.length === 0) {
    await db.query("ALTER TABLE sale_items ADD COLUMN sold_unit VARCHAR(20) NULL AFTER quantity");
    await db.query("ALTER TABLE sale_items ADD COLUMN sold_quantity DECIMAL(12,3) NULL AFTER sold_unit");
    await db.query("ALTER TABLE sale_items DROP COLUMN subtotal");
    await db.query(
      "ALTER TABLE sale_items ADD COLUMN subtotal DECIMAL(12,2)\n" +
        "         AS (ROUND(COALESCE(sold_quantity, quantity) * unit_price, 2)) STORED");
    widened = true;
  }

  if (created || widened) {
    console.log("Added selling units (product_units, sale_items.sold_unit). " +
      "Re-run public/database/2-stored-procedures.sql so the sale procedure takes them.");
  }
}

async function migratePurchaseOrderApproval() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders'\n" +
      "       AND COLUMN_NAME IN ('raised_by_staff_id', 'confirmed_by_staff_id',\n" +
      "                           'confirmed_at', 'decision_note', 'discount')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const statusResult = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'status'",
    [DB_NAME]
  );
  const status = statusResult[0];
  const hasApproval = status.length > 0 && status[0].COLUMN_TYPE.indexOf("For Approval") !== -1;
  if (columns.length === 5 && hasApproval) return;

  const names = columnNamesOf(columns);
  if (!hasApproval) {
    await db.query(
      "ALTER TABLE purchase_orders MODIFY COLUMN status\n" +
        "         ENUM('For Approval', 'Pending', 'Received', 'Cancelled') NOT NULL DEFAULT 'For Approval'");
  }
  if (names.indexOf("raised_by_staff_id") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN raised_by_staff_id INT NULL AFTER status,\n" +
        "         ADD FOREIGN KEY (raised_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE");
  }
  if (names.indexOf("confirmed_by_staff_id") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN confirmed_by_staff_id INT NULL AFTER raised_by_staff_id,\n" +
        "         ADD FOREIGN KEY (confirmed_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE");
  }
  if (names.indexOf("confirmed_at") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN confirmed_at TIMESTAMP NULL AFTER confirmed_by_staff_id");
  }
  if (names.indexOf("decision_note") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN decision_note VARCHAR(255) NULL AFTER confirmed_at");
  }
  if (names.indexOf("discount") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN discount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER decision_note");
  }
  console.log("Added the purchase-order approval columns (purchase_orders.raised_by_staff_id, " +
    "confirmed_by_staff_id, confirmed_at, decision_note, discount). " +
    "Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migratePackSizes() {
  const wanted = [
    ["products", "pack_name", "VARCHAR(20) NULL"],
    ["products", "pack_size", "DECIMAL(12,3) NULL"],
    ["purchase_order_items", "pack_name", "VARCHAR(20) NULL"],
    ["purchase_order_items", "pack_size", "DECIMAL(12,3) NULL"],
    ["purchase_order_items", "pack_count", "DECIMAL(12,3) NULL"]
  ];
  const columnsResult = await db.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('products', 'purchase_order_items')\n" +
      "       AND COLUMN_NAME IN ('pack_name', 'pack_size', 'pack_count')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const have = [];
  for (let rowIndex = 0; rowIndex < columns.length; rowIndex++) {
    const row = columns[rowIndex];
    have.push(row.TABLE_NAME + "." + row.COLUMN_NAME);
  }

  const missing = [];
  for (let itemIndex = 0; itemIndex < wanted.length; itemIndex++) {
    const item = wanted[itemIndex];
    if (have.indexOf(item[0] + "." + item[1]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0) return;

  for (let itemIndex = 0; itemIndex < missing.length; itemIndex++) {
    const item = missing[itemIndex];
    await db.query("ALTER TABLE " + item[0] + " ADD COLUMN " + item[1] + " " + item[2]);
  }
  console.log("Added " + missing.length + " pack column(s) to products and purchase_order_items. " +
    "Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migrateLatePenalties() {
  const wanted = [
    ["store_settings", "penalty_rate", "DECIMAL(5,2) NOT NULL DEFAULT 3.00 AFTER invoice_note"],
    ["customer_credits", "penalty_rate", "DECIMAL(5,2) NULL AFTER standing"],
    ["sales", "penalty_rate", "DECIMAL(5,2) NULL AFTER change_given"],
    ["sales", "penalty_months", "INT NOT NULL DEFAULT 0 AFTER penalty_rate"],
    ["sales", "penalty_amount", "DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER penalty_months"],
    ["sales", "penalty_applied_at", "TIMESTAMP NULL AFTER penalty_amount"],
    ["sales", "amount_due", "DECIMAL(12,2) AS (total_amount - discount + penalty_amount) STORED AFTER penalty_applied_at"]
  ];
  const columnsResult = await db.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('store_settings', 'customer_credits', 'sales')\n" +
      "       AND COLUMN_NAME IN ('penalty_rate', 'penalty_months', 'penalty_amount', 'penalty_applied_at', 'amount_due')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const notifResult = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'notif_type'",
    [DB_NAME]
  );
  const notif = notifResult[0];
  const hasAlert = notif.length > 0 && notif[0].COLUMN_TYPE.indexOf("Late Penalty") !== -1;

  const have = [];
  for (let rowIndex = 0; rowIndex < columns.length; rowIndex++) {
    const row = columns[rowIndex];
    have.push(row.TABLE_NAME + "." + row.COLUMN_NAME);
  }

  const missing = [];
  for (let itemIndex = 0; itemIndex < wanted.length; itemIndex++) {
    const item = wanted[itemIndex];
    if (have.indexOf(item[0] + "." + item[1]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0 && hasAlert) return;

  for (let itemIndex = 0; itemIndex < missing.length; itemIndex++) {
    const item = missing[itemIndex];
    await db.query("ALTER TABLE " + item[0] + " ADD COLUMN " + item[1] + " " + item[2]);
  }
  if (!hasAlert) {
    await db.query(
      "ALTER TABLE notifications MODIFY COLUMN notif_type\n" +
        "         ENUM('Low Stock', 'Out of Stock', 'Damage Report', 'Refund Report', 'Purchase Order',\n" +
        "              'Stock Adjustment', 'Delivery', 'Credit Request', 'Late Penalty') NOT NULL");
  }
  console.log("Added the late-payment penalty columns (store_settings.penalty_rate, " +
    "customer_credits.penalty_rate, sales.penalty_rate, penalty_months, penalty_amount, penalty_applied_at, amount_due). " +
    "Re-run public/database/2-stored-procedures.sql so the views and procedures match.");
}

async function migrateRefundedAmount() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME, GENERATION_EXPRESSION FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sales'\n" +
      "       AND COLUMN_NAME IN ('refunded_amount', 'amount_due')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const hasRefunded = findColumn(columns, "refunded_amount") !== undefined;
  const due = findColumn(columns, "amount_due");
  const dueUsesIt = due && String(due.GENERATION_EXPRESSION).indexOf("refunded_amount") !== -1;
  if (hasRefunded && dueUsesIt) return;
  if (!due) return;

  if (!hasRefunded) {
    await db.query(
      "ALTER TABLE sales ADD COLUMN refunded_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER penalty_applied_at");
  }
  await db.query(
    "ALTER TABLE sales MODIFY COLUMN amount_due DECIMAL(12,2)\n" +
      "       AS (total_amount - discount + penalty_amount - refunded_amount) STORED");
  console.log("Added sales.refunded_amount: a refund now comes off what the customer owes " +
    "(amount_due is worked out from it).");
}

async function migrateCashierRemarks() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'deliveries'\n" +
      "       AND COLUMN_NAME IN ('delivery_id', 'cashier_remarks', 'booking_remarks')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const names = columnNamesOf(columns);
  if (names.indexOf("delivery_id") === -1) return;
  if (names.indexOf("cashier_remarks") !== -1) return;

  if (names.indexOf("booking_remarks") !== -1) {
    await db.query("ALTER TABLE deliveries RENAME COLUMN booking_remarks TO cashier_remarks");
    console.log("Renamed deliveries.booking_remarks to cashier_remarks.");
    return;
  }

  await db.query("ALTER TABLE deliveries ADD COLUMN cashier_remarks TEXT NULL AFTER remarks");
  await db.query("UPDATE deliveries SET cashier_remarks = remarks WHERE status = 'Pending'");
  console.log("Added deliveries.cashier_remarks to keep the cashier's note apart from status notes.");
}

async function migrateDeliveryCreatedDate() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'deliveries'\n" +
      "       AND COLUMN_NAME IN ('created_date', 'booked_date')",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.indexOf("booked_date") !== -1 && names.indexOf("created_date") === -1) {
    await db.query("ALTER TABLE deliveries RENAME COLUMN booked_date TO created_date");
    console.log("Renamed deliveries.booked_date to created_date.");
  }

  const auditResult = await db.query(
    "UPDATE audit_logs SET action = 'DELIVERY_CREATED' WHERE action = 'DELIVERY_BOOKED'");
  const changed = auditResult[0].affectedRows;
  if (changed > 0) {
    console.log("Renamed " + changed + " audit trail entries from DELIVERY_BOOKED to DELIVERY_CREATED.");
  }
}

async function migrateDeliveryAddressParts() {
  const wanted = [
    ["address_street", "VARCHAR(150) NULL"],
    ["address_barangay", "VARCHAR(100) NULL"],
    ["address_city", "VARCHAR(100) NULL"],
    ["address_province", "VARCHAR(100) NULL"],
    ["address_landmark", "VARCHAR(150) NULL"]
  ];
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'deliveries'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.indexOf("delivery_id") === -1) return;

  let added = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (names.indexOf(wanted[i][0]) === -1) {
      await db.query("ALTER TABLE deliveries ADD COLUMN " + wanted[i][0] + " " + wanted[i][1]);
      added += 1;
    }
  }
  if (added > 0) {
    console.log("Added the delivery address parts (deliveries.address_street, address_barangay, " +
      "address_city, address_province, address_landmark).");
  }
}

async function migrateCustomerNameAndAddress() {
  const wanted = [
    ["middle_name", "VARCHAR(100) NULL"],
    ["address_street", "VARCHAR(150) NULL"],
    ["address_barangay", "VARCHAR(100) NULL"],
    ["address_city", "VARCHAR(100) NULL"],
    ["address_province", "VARCHAR(100) NULL"],
    ["address_landmark", "VARCHAR(150) NULL"]
  ];
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'customers'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.indexOf("customer_id") === -1) return;

  let added = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (names.indexOf(wanted[i][0]) === -1) {
      await db.query("ALTER TABLE customers ADD COLUMN " + wanted[i][0] + " " + wanted[i][1]);
      added += 1;
    }
  }

  if (names.indexOf("full_name") === -1) {
    await db.query(
      "ALTER TABLE customers ADD COLUMN full_name VARCHAR(220) AS (\n" +
        "       TRIM(CONCAT(first_name,\n" +
        "                   IF(middle_name IS NULL OR middle_name = '', '',\n" +
        "                      CONCAT(' ', UPPER(LEFT(middle_name, 1)), '.')),\n" +
        "                   ' ', last_name))\n" +
        "     ) VIRTUAL"
    );
    added += 1;
  }

  if (added > 0) {
    console.log("Added the customer middle name, address parts and full name " +
      "(customers.middle_name, address_street, address_barangay, address_city, " +
      "address_province, address_landmark, full_name).");
  }
}

async function migrateCreditTerms() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.length === 0) return;
  if (names.indexOf("credit_terms") !== -1) return;

  await db.query("ALTER TABLE store_settings ADD COLUMN credit_terms TEXT NULL");
  console.log("Added store_settings.credit_terms for the printed credit terms and conditions.");
}

async function restoreArchivedDeliveries() {
  const tablesResult = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'deliveries'",
    [DB_NAME]);
  if (Number(tablesResult[0][0].n) === 0) return;

  const result = await db.query(
    "UPDATE deliveries d JOIN sales s ON s.sale_id = d.sale_id\n" +
    "   SET d.is_archived = FALSE, d.archived_at = NULL, d.archived_by_staff_id = NULL\n" +
    " WHERE d.is_archived = TRUE AND s.is_archived = FALSE");
  const brought = result[0].affectedRows || 0;
  if (brought > 0) {
    console.log("Brought back " + brought + " archived " + (brought === 1 ? "delivery" : "deliveries") +
      " into Delivery History: deliveries are no longer archived.");
  }
}

async function migratePolicyTexts() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.length === 0) return;

  if (names.indexOf("data_terms") === -1) {
    await db.query("ALTER TABLE store_settings ADD COLUMN data_terms TEXT NULL");
    console.log("Added store_settings.data_terms for the customer data terms and conditions.");
  }
  if (names.indexOf("refund_policy") === -1) {
    await db.query("ALTER TABLE store_settings ADD COLUMN refund_policy TEXT NULL");
    console.log("Added store_settings.refund_policy for the refund policy.");
  }
}

async function migrateNewProductAlert() {
  const typeResult = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'notif_type'",
    [DB_NAME]
  );
  const found = typeResult[0];
  if (found.length === 0) return;
  const current = String(found[0].COLUMN_TYPE);
  if (current.indexOf("New Product") !== -1) return;

  const wider = current.replace(/\)$/, ",'New Product')");
  await db.query("ALTER TABLE notifications MODIFY COLUMN notif_type " + wider + " NOT NULL");
  console.log("Added the New Product kind of alert (notifications.notif_type).");
}

async function migrateAccountManagementKey() {
  const oldRowsResult = await db.query(
    "SELECT role_id FROM role_feature_permissions WHERE feature_key = 'release-holds'");
  const oldRows = oldRowsResult[0];
  if (oldRows.length === 0) return;

  await db.query(
    "UPDATE IGNORE role_feature_permissions SET feature_key = 'account-management' WHERE feature_key = 'release-holds'");
  await db.query("DELETE FROM role_feature_permissions WHERE feature_key = 'release-holds'");
  console.log("Renamed the release-holds screen switch to account-management for " + oldRows.length + " role(s).");
}

async function migrateProprietorName() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings' AND COLUMN_NAME = 'proprietor'",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  if (columns.length > 0) return;

  await db.query("ALTER TABLE store_settings ADD COLUMN proprietor VARCHAR(150) NULL AFTER store_name");
  console.log("Added store_settings.proprietor for the invoice head. " +
    "Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migrateReturnInspection() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'returned_items'\n" +
      "       AND COLUMN_NAME IN ('disposition', 'inspected_by_staff_id', 'inspected_at', 'inspection_note')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const have = columnNamesOf(columns);
  const disposition = findColumn(columns, "disposition");
  const nullable = disposition && disposition.IS_NULLABLE === "YES";
  if (nullable && have.length === 4) return;

  if (!nullable) {
    await db.query(
      "ALTER TABLE returned_items MODIFY COLUMN disposition ENUM('Return to Stock', 'Write-Off') NULL");
  }
  if (have.indexOf("inspected_by_staff_id") === -1) {
    await db.query(
      "ALTER TABLE returned_items ADD COLUMN inspected_by_staff_id INT NULL AFTER reported_by_staff_id,\n" +
        "         ADD FOREIGN KEY (inspected_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE");
  }
  if (have.indexOf("inspected_at") === -1) {
    await db.query("ALTER TABLE returned_items ADD COLUMN inspected_at TIMESTAMP NULL AFTER inspected_by_staff_id");
  }
  if (have.indexOf("inspection_note") === -1) {
    await db.query("ALTER TABLE returned_items ADD COLUMN inspection_note VARCHAR(255) NULL AFTER inspected_at");
  }
  console.log("Added the return-inspection columns (returned_items.inspected_by_staff_id, inspected_at, " +
    "inspection_note; disposition may now be empty until the clerk inspects). " +
    "Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migrateMissingReports() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'returned_items'\n" +
      "       AND COLUMN_NAME IN ('report_type', 'po_id')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const type = findColumn(columns, "report_type");
  if (!type) return;
  const hasPo = findColumn(columns, "po_id") !== undefined;
  const hasMissing = String(type.COLUMN_TYPE).indexOf("'Missing'") !== -1;
  if (hasMissing && hasPo) return;

  if (!hasMissing) {
    await db.query(
      "ALTER TABLE returned_items MODIFY COLUMN report_type ENUM('Return', 'Damaged', 'Refunded', 'Missing') NOT NULL DEFAULT 'Return'");
  }
  if (!hasPo) {
    await db.query(
      "ALTER TABLE returned_items ADD COLUMN po_id INT NULL AFTER sale_id,\n" +
        "         ADD FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE RESTRICT ON UPDATE CASCADE");
  }
  console.log("Added the Missing report type and returned_items.po_id: the clerk can now report goods " +
    "missing from a delivery. Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migrateBankDetails() {
  const wanted = [
    ["bank_name", "VARCHAR(100) NULL AFTER penalty_rate"],
    ["bank_account_name", "VARCHAR(150) NULL AFTER bank_name"],
    ["bank_account_number", "VARCHAR(50) NULL AFTER bank_account_name"]
  ];
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'\n" +
      "       AND COLUMN_NAME IN ('bank_name', 'bank_account_name', 'bank_account_number')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const have = [];
  for (let rowIndex = 0; rowIndex < columns.length; rowIndex++) {
    const row = columns[rowIndex];
    have.push(row.COLUMN_NAME);
  }

  const missing = [];
  for (let itemIndex = 0; itemIndex < wanted.length; itemIndex++) {
    const item = wanted[itemIndex];
    if (have.indexOf(item[0]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0) return;

  for (let itemIndex = 0; itemIndex < missing.length; itemIndex++) {
    const item = missing[itemIndex];
    await db.query("ALTER TABLE store_settings ADD COLUMN " + item[0] + " " + item[1]);
  }
  console.log("Added the bank transfer details (store_settings.bank_name, bank_account_name, " +
    "bank_account_number). Re-run public/database/2-stored-procedures.sql so the procedures match.");
}

async function migrateReceiptLayout() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings' AND COLUMN_NAME = 'receipt_layout'",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  if (columns.length === 0) {
    await db.query("ALTER TABLE store_settings ADD COLUMN receipt_layout TEXT NULL AFTER bank_account_number");
    console.log("Added store_settings.receipt_layout for the receipt's layout.");
  }
  await db.query(
    "UPDATE store_settings SET receipt_layout = ? WHERE setting_id = 1 AND receipt_layout IS NULL",
    [JSON.stringify(DEFAULT_RECEIPT_LAYOUT)]);
}

async function migrateRemoveDeliveryAreas() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings' AND COLUMN_NAME = 'delivery_areas'",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  if (columns.length > 0) {
    await db.query("ALTER TABLE store_settings DROP COLUMN delivery_areas");
    console.log("Dropped store_settings.delivery_areas: delivery addresses are typed in full now.");
  }
}

async function migratePasswordResets() {
  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'password_resets'",
    [DB_NAME]
  );
  const tables = tablesResult[0];
  if (tables.length > 0) return;

  await db.query(
    "CREATE TABLE password_resets (\n" +
      "       reset_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       user_id INT NOT NULL,\n" +
      "       code_hash VARCHAR(255) NOT NULL,\n" +
      "       expires_at TIMESTAMP NOT NULL,\n" +
      "       attempts INT NOT NULL DEFAULT 0,\n" +
      "       used_at TIMESTAMP NULL,\n" +
      "       requested_ip VARCHAR(45) NULL,\n" +
      "       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
      "       INDEX idx_password_resets_user (user_id, created_at),\n" +
      "       FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE\n" +
      "     )");
  console.log("Added the password_resets table for signing in again with a code sent by email.");
}

async function migrateDeliveryRemarks() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'delivery_remarks'",
    [DB_NAME]
  );
  if (columnsResult[0].length > 0) return;
  await db.query("ALTER TABLE purchase_orders ADD COLUMN delivery_remarks VARCHAR(255) NULL AFTER received_at");
  console.log("Added purchase_orders.delivery_remarks, the clerk's remarks on a delivery.");
}

async function migrateOrderReference() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'received_at'",
    [DB_NAME]
  );
  if (columnsResult[0].length === 0) {
    await db.query("ALTER TABLE purchase_orders ADD COLUMN received_at TIMESTAMP NULL AFTER decision_note");
    await db.query(
      "UPDATE purchase_orders po SET po.received_at = (\n" +
        "       SELECT MAX(a.created_at) FROM audit_logs a\n" +
        "        WHERE a.action = 'PO_RECEIVED' AND a.details LIKE CONCAT('PO #', po.po_id, ' received%'))\n" +
        "     WHERE po.status = 'Received'");
    console.log("Added purchase_orders.received_at, the day a delivery was counted in.");
  }

  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_order_ordered_items'",
    [DB_NAME]
  );
  const tables = tablesResult[0];
  if (tables.length > 0) return;

  await db.query(
    "CREATE TABLE purchase_order_ordered_items (\n" +
      "       ordered_item_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       po_id INT NOT NULL,\n" +
      "       product_id INT NOT NULL,\n" +
      "       quantity INT NOT NULL,\n" +
      "       pack_name VARCHAR(20) NULL,\n" +
      "       pack_size DECIMAL(12,3) NULL,\n" +
      "       pack_count DECIMAL(12,3) NULL,\n" +
      "       FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT ON UPDATE CASCADE\n" +
      "     )");
  console.log("Added the purchase_order_ordered_items table: a received order keeps what was ordered " +
    "beside what arrived.");
}

async function migrateSupplierResponse() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders'\n" +
      "       AND COLUMN_NAME IN ('supplier_code', 'supplier_sent_at', 'supplier_response',\n" +
      "                           'supplier_responded_at', 'supplier_note', 'supplier_token_hash')",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const names = columnNamesOf(columns);
  const wanted = ["supplier_code", "supplier_sent_at", "supplier_response", "supplier_responded_at", "supplier_note"];
  let hasAllWanted = true;
  for (let i = 0; i < wanted.length; i++) {
    if (names.indexOf(wanted[i]) === -1) {
      hasAllWanted = false;
    }
  }
  if (hasAllWanted && names.indexOf("supplier_token_hash") === -1) return;

  if (names.indexOf("supplier_code") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN supplier_code VARCHAR(64) NULL,\n" +
        "         ADD UNIQUE INDEX idx_purchase_orders_supplier_code (supplier_code)");
  }
  if (names.indexOf("supplier_sent_at") === -1) {
    await db.query("ALTER TABLE purchase_orders ADD COLUMN supplier_sent_at TIMESTAMP NULL");
  }
  if (names.indexOf("supplier_response") === -1) {
    await db.query(
      "ALTER TABLE purchase_orders ADD COLUMN supplier_response ENUM('Accepted', 'Declined') NULL");
  }
  if (names.indexOf("supplier_responded_at") === -1) {
    await db.query("ALTER TABLE purchase_orders ADD COLUMN supplier_responded_at TIMESTAMP NULL");
  }
  if (names.indexOf("supplier_note") === -1) {
    await db.query("ALTER TABLE purchase_orders ADD COLUMN supplier_note VARCHAR(255) NULL");
  }
  if (names.indexOf("supplier_token_hash") !== -1) {
    await db.query("ALTER TABLE purchase_orders DROP COLUMN supplier_token_hash");
  }
  console.log("Added the supplier-response columns (purchase_orders.supplier_code, supplier_sent_at, " +
    "supplier_response, supplier_responded_at, supplier_note).");
}

async function migrateSupplierQuote() {
  const columnsResult = await db.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ?\n" +
      "       AND ((TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'supplier_ship_date')\n" +
      "         OR (TABLE_NAME = 'purchase_order_items' AND COLUMN_NAME = 'original_unit_cost'))",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const names = columnNamesOf(columns);
  if (names.length === 2) return;

  if (names.indexOf("supplier_ship_date") === -1) {
    await db.query("ALTER TABLE purchase_orders ADD COLUMN supplier_ship_date DATE NULL");
  }
  if (names.indexOf("original_unit_cost") === -1) {
    await db.query("ALTER TABLE purchase_order_items ADD COLUMN original_unit_cost DECIMAL(10,2) NULL");
  }
  console.log("Added the supplier-quote columns (purchase_orders.supplier_ship_date, " +
    "purchase_order_items.original_unit_cost).");
}

async function migrateQrPayments() {
  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'qr_payments'",
    [DB_NAME]
  );
  const tables = tablesResult[0];
  if (tables.length > 0) {
    await addBankColumnsToQrPayments();
    return;
  }

  await db.query(
    "CREATE TABLE qr_payments (\n" +
      "       qr_payment_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       provider ENUM('paymongo','sim') NOT NULL,\n" +
      "       mode ENUM('test','live') NOT NULL,\n" +
      "       provider_intent_id VARCHAR(80) NOT NULL,\n" +
      "       provider_payment_id VARCHAR(80) NULL,\n" +
      "       amount DECIMAL(12,2) NOT NULL,\n" +
      "       wallet ENUM('GCash','PayMaya','Bank Transfer') NOT NULL,\n" +
      "       bank_code VARCHAR(20) NULL,\n" +
      "       bank_name VARCHAR(80) NULL,\n" +
      "       account_name VARCHAR(100) NULL,\n" +
      "       account_number VARCHAR(30) NULL,\n" +
      "       purpose ENUM('sale','credit_payment') NOT NULL,\n" +
      "       status ENUM('pending','paid','failed','expired','cancelled') NOT NULL DEFAULT 'pending',\n" +
      "       error_message VARCHAR(255) NULL,\n" +
      "       sale_id INT NULL,\n" +
      "       created_by_staff_id INT NULL,\n" +
      "       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
      "       expires_at TIMESTAMP NULL,\n" +
      "       paid_at TIMESTAMP NULL,\n" +
      "       closed_at TIMESTAMP NULL,\n" +
      "       UNIQUE KEY uq_qr_payments_intent (provider_intent_id),\n" +
      "       INDEX idx_qr_payments_created (created_at),\n" +
      "       INDEX idx_qr_payments_status (status),\n" +
      "       FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE\n" +
      "     )");
  console.log("Added the qr_payments table for GCash, Maya and bank-transfer payments by QR code.");
}

async function addBankColumnsToQrPayments() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'qr_payments'",
    [DB_NAME]
  );
  const columns = columnsResult[0];
  const wallet = findColumn(columns, "wallet");
  if (wallet && String(wallet.COLUMN_TYPE).indexOf("Bank Transfer") === -1) {
    await db.query(
      "ALTER TABLE qr_payments MODIFY COLUMN wallet ENUM('GCash','PayMaya','Bank Transfer') NOT NULL");
    console.log("qr_payments.wallet now accepts Bank Transfer.");
  }

  const wanted = [
    ["bank_code", "VARCHAR(20)"],
    ["bank_name", "VARCHAR(80)"],
    ["account_name", "VARCHAR(100)"],
    ["account_number", "VARCHAR(30)"]
  ];
  for (let i = 0; i < wanted.length; i++) {
    if (findColumn(columns, wanted[i][0]) === undefined) {
      await db.query("ALTER TABLE qr_payments ADD COLUMN " + wanted[i][0] + " " + wanted[i][1] + " NULL AFTER wallet");
      console.log("Added qr_payments." + wanted[i][0] + " for bank transfers.");
    }
  }
}

async function migratePaymentDetails() {
  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'payment_details'",
    [DB_NAME]
  );
  if (tablesResult[0].length > 0) return;

  await db.query(
    "CREATE TABLE payment_details (\n" +
      "       detail_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       sale_id INT NOT NULL,\n" +
      "       payment_id INT NULL,\n" +
      "       method ENUM('Cheque','Bank Transfer') NOT NULL,\n" +
      "       account_name VARCHAR(100) NOT NULL,\n" +
      "       account_number VARCHAR(30) NOT NULL,\n" +
      "       bank_name VARCHAR(80) NOT NULL,\n" +
      "       branch VARCHAR(80) NULL,\n" +
      "       cheque_date DATE NULL,\n" +
      "       qr_payment_id INT NULL,\n" +
      "       created_by_staff_id INT NULL,\n" +
      "       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
      "       INDEX idx_payment_details_sale (sale_id),\n" +
      "       FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (payment_id) REFERENCES credit_payments(payment_id) ON DELETE CASCADE ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (qr_payment_id) REFERENCES qr_payments(qr_payment_id) ON DELETE SET NULL ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE\n" +
      "     )");
  console.log("Added the payment_details table: the bank and account behind a cheque or a bank transfer.");
}

async function migrateLoyaltySettings() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.length === 0) return;

  const wanted = [
    ["loyalty_rate", "DECIMAL(5,2) NOT NULL DEFAULT 2.00 AFTER penalty_rate"],
    ["loyalty_threshold", "DECIMAL(12,2) NOT NULL DEFAULT 5000.00 AFTER loyalty_rate"]
  ];
  let added = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (names.indexOf(wanted[i][0]) !== -1) continue;
    await db.query("ALTER TABLE store_settings ADD COLUMN " + wanted[i][0] + " " + wanted[i][1]);
    added++;
  }
  if (added > 0) {
    console.log("Added the monthly loyalty discount settings (store_settings.loyalty_rate, loyalty_threshold).");
  }
}

async function migrateDiscountPolicy() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'",
    [DB_NAME]
  );
  const names = columnNamesOf(columnsResult[0]);
  if (names.length === 0) return;
  if (names.indexOf("discount_policy") !== -1) return;

  await db.query("ALTER TABLE store_settings ADD COLUMN discount_policy TEXT NULL");
  console.log("Added store_settings.discount_policy for the discount policy printed on the customer card.");
}

const CHECK_RULES = [
  ["inventory", "chk_inventory_stock_not_negative", "quantity_in_stock >= 0"],
  ["sales", "chk_sales_discount_not_negative", "discount >= 0"],
  ["sales", "chk_sales_amount_paid_not_negative", "amount_paid >= 0"],
  ["returned_items", "chk_returned_items_refund_not_negative", "refund_amount >= 0"],
  ["store_settings", "chk_store_settings_loyalty",
   "loyalty_rate >= 0 AND loyalty_rate <= 20 AND loyalty_threshold > 0"]
];

async function migrateCheckConstraints() {
  for (let ruleIndex = 0; ruleIndex < CHECK_RULES.length; ruleIndex++) {
    const table = CHECK_RULES[ruleIndex][0];
    const name = CHECK_RULES[ruleIndex][1];
    const rule = CHECK_RULES[ruleIndex][2];
    const foundResult = await db.query(
      "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS\n" +
        "       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?\n" +
        "         AND CONSTRAINT_TYPE = 'CHECK'",
      [DB_NAME, table, name]
    );
    const found = foundResult[0];
    if (found.length > 0) continue;

    try {
      await db.query("ALTER TABLE " + table + " ADD CONSTRAINT " + name + " CHECK (" + rule + ")");
      console.log("Added the rule \"" + rule + "\" to the " + table + " table.");
    } catch (error) {
      console.warn("Could not add the rule \"" + rule + "\" to the " + table + " table (" + error.message + "). " +
        "Fix the rows that break it, then restart the server.");
    }
  }
}

const SERVER_TABLES = ["user_sessions", "live_changes", "account_drafts",
                       "backup_files", "app_flags", "qr_sim_intents"];

async function migrateServerTables() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS user_sessions (\n" +
      "       token_hash CHAR(64) PRIMARY KEY,\n" +
      "       staff_id INT NOT NULL,\n" +
      "       user_id INT NOT NULL,\n" +
      "       role_id INT NOT NULL,\n" +
      "       role_name VARCHAR(50) NOT NULL,\n" +
      "       email VARCHAR(100) NOT NULL,\n" +
      "       started_at BIGINT NOT NULL,\n" +
      "       last_seen BIGINT NOT NULL,\n" +
      "       expires_at BIGINT NOT NULL,\n" +
      "       ended_reason VARCHAR(255) NULL,\n" +
      "       ended_at BIGINT NULL,\n" +
      "       INDEX idx_user_sessions_staff (staff_id),\n" +
      "       INDEX idx_user_sessions_expires (expires_at)\n" +
      "     )");
  await db.query(
    "CREATE TABLE IF NOT EXISTS live_changes (\n" +
      "       change_id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       scope VARCHAR(30) NOT NULL,\n" +
      "       detail VARCHAR(255) NULL,\n" +
      "       origin VARCHAR(64) NULL,\n" +
      "       created_at BIGINT NOT NULL\n" +
      "     )");
  await db.query(
    "CREATE TABLE IF NOT EXISTS account_drafts (\n" +
      "       draft_hash CHAR(64) PRIMARY KEY,\n" +
      "       staff_id INT NOT NULL,\n" +
      "       kind VARCHAR(10) NOT NULL,\n" +
      "       payload TEXT NOT NULL,\n" +
      "       expires_at BIGINT NOT NULL\n" +
      "     )");
  await db.query(
    "CREATE TABLE IF NOT EXISTS backup_files (\n" +
      "       file_name VARCHAR(100) PRIMARY KEY,\n" +
      "       bytes INT NOT NULL,\n" +
      "       created_at BIGINT NOT NULL,\n" +
      "       content LONGBLOB NOT NULL\n" +
      "     )");
  await db.query(
    "CREATE TABLE IF NOT EXISTS app_flags (\n" +
      "       flag_key VARCHAR(50) PRIMARY KEY,\n" +
      "       flag_value VARCHAR(255) NULL,\n" +
      "       updated_at BIGINT NOT NULL\n" +
      "     )");
  await db.query(
    "CREATE TABLE IF NOT EXISTS qr_sim_intents (\n" +
      "       intent_id VARCHAR(40) PRIMARY KEY,\n" +
      "       token VARCHAR(40) NOT NULL UNIQUE,\n" +
      "       amount DECIMAL(12,2) NOT NULL,\n" +
      "       wallet VARCHAR(20) NOT NULL,\n" +
      "       bank_name VARCHAR(80) NULL,\n" +
      "       description VARCHAR(255) NULL,\n" +
      "       return_url VARCHAR(500) NOT NULL,\n" +
      "       status VARCHAR(10) NOT NULL,\n" +
      "       payment_id VARCHAR(40) NULL,\n" +
      "       error_message VARCHAR(255) NULL,\n" +
      "       created_at BIGINT NOT NULL\n" +
      "     )");

  const simColumnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'qr_sim_intents'",
    [DB_NAME]
  );
  if (columnNamesOf(simColumnsResult[0]).indexOf("bank_name") === -1) {
    await db.query("ALTER TABLE qr_sim_intents ADD COLUMN bank_name VARCHAR(80) NULL AFTER wallet");
  }
}

const EXPECTED_PROCEDURES = 37;

let proceduresLoaded = null;
let procedureCheckAt = 0;
const PROCEDURE_RECHECK_MS = 5000;

async function countProcedures() {
  const rowsResult = await db.query(
    "SELECT COUNT(*) AS total FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
    [DB_NAME]
  );
  const rows = rowsResult[0];
  proceduresLoaded = rows[0].total;
  procedureCheckAt = Date.now();
  return proceduresLoaded;
}

async function proceduresAreMissing() {
  if (proceduresLoaded !== null && proceduresLoaded >= EXPECTED_PROCEDURES) return false;
  if (Date.now() - procedureCheckAt < PROCEDURE_RECHECK_MS) return true;

  try {
    return (await countProcedures()) < EXPECTED_PROCEDURES;
  } catch (error) {
    return false;
  }
}

function proceduresLoadedCount() {
  return proceduresLoaded;
}

function forgetProcedureCount() {
  proceduresLoaded = null;
  procedureCheckAt = 0;
}

const PROCEDURES_FILE = path.join(__dirname, "..", "..", "database", "2-stored-procedures.sql");

async function routinesAreOld() {
  const newestWords = [
    ["sp_file_return_report", "v_refunded_before"],
    ["sp_file_return_report", "nothing to refund"],
    ["sp_file_return_report", "p_inside_batch"],
    ["sp_file_return_report", "is already received, so its delivery"],
    ["sp_file_return_report", "A reason is required for every report"],
    ["sp_apply_late_penalties", "refunded_amount"],
    ["sp_record_credit_payment", "already paid in full"],
    ["sp_record_credit_payment", "p_qr_payment_id"],
    ["sp_record_credit_payment", "kept for the down payment"],
    ["sp_create_sale_transaction", "p_qr_payment_id"],
    ["sp_create_sale_transaction", "p_pay_details"],
    ["sp_record_credit_payment", "p_pay_details"],
    ["sp_create_qr_payment", "p_bank_code"],
    ["sp_create_sale_transaction", "p_expected_discount"],
    ["sp_create_sale_transaction", "has no price yet"],
    ["sp_adjust_stock", "Add and Remove need a quantity"],
    ["sp_resolve_return_report", "AND status = 'Open'"],
    ["sp_resolve_return_report", "v_type = 'Missing'"],
    ["sp_archive_record", "refund instead"],
    ["sp_restore_archive", "FOR UPDATE"],
    ["sp_create_delivery", "p_driver_staff_id"],
    ["sp_create_delivery", "DELIVERY_CREATED"],
    ["sp_update_delivery_status", "FOR UPDATE"],
    ["sp_receive_purchase_order", "purchase_order_ordered_items"],
    ["sp_receive_purchase_order", "received_at = NOW()"],
    ["sp_create_customer", "p_address_barangay"],
    ["sp_sweep_archives", "deliveries are never archived"],
    ["sp_sweep_archives", "deactivated for 30 days"],
    ["sp_archive_record", "Only a deactivated account can be archived"],
    ["sp_restore_archive", "deactivated_at = NULL"],
    ["sp_set_staff_status", "deactivated_at"]
  ];

  const routinesResult = await db.query(
    "SELECT ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES\n" +
      "     WHERE ROUTINE_SCHEMA = ?\n" +
      "       AND ROUTINE_NAME IN ('sp_file_return_report', 'sp_apply_late_penalties', 'sp_record_credit_payment',\n" +
      "                            'sp_create_sale_transaction', 'sp_resolve_return_report', 'sp_archive_record',\n" +
      "                            'sp_restore_archive', 'sp_create_delivery', 'sp_update_delivery_status',\n" +
      "                            'sp_adjust_stock', 'sp_receive_purchase_order', 'sp_create_customer',\n" +
      "                            'sp_create_qr_payment', 'sp_sweep_archives', 'sp_set_staff_status')",
    [DB_NAME]
  );
  const routines = routinesResult[0];
  for (let rowIndex = 0; rowIndex < routines.length; rowIndex++) {
    const row = routines[rowIndex];
    const text = String(row.ROUTINE_DEFINITION || "");
    if (text === "") continue;
    for (let wordIndex = 0; wordIndex < newestWords.length; wordIndex++) {
      const name = newestWords[wordIndex][0];
      const word = newestWords[wordIndex][1];
      if (row.ROUTINE_NAME === name && text.indexOf(word) === -1) return true;
    }
  }

  let ownNames = [];
  try {
    const fileText = fs.readFileSync(PROCEDURES_FILE, "utf8");
    const namePattern = /^CREATE PROCEDURE (w+)/gm;
    let nameMatch = namePattern.exec(fileText);
    while (nameMatch !== null) {
      ownNames.push(nameMatch[1]);
      nameMatch = namePattern.exec(fileText);
    }
  } catch (error) {
  }
  if (ownNames.length > 0) {
    const oldHandlersResult = await db.query(
      "SELECT COUNT(*) AS n FROM information_schema.ROUTINES\n" +
        "       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' AND ROUTINE_NAME IN (?)\n" +
        "         AND ROUTINE_DEFINITION LIKE '%EXIT HANDLER%'\n" +
        "         AND ROUTINE_DEFINITION NOT LIKE '%GET DIAGNOSTICS%'",
      [DB_NAME, ownNames]
    );
    const oldHandlers = oldHandlersResult[0];
    if (oldHandlers[0].n > 0) return true;
  }

  const loyaltyViewResult = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.VIEWS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vw_customer_loyalty'",
    [DB_NAME]
  );
  if (Number(loyaltyViewResult[0][0].n) === 0) return true;

  const viewsResult = await db.query(
    "SELECT VIEW_DEFINITION FROM information_schema.VIEWS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vw_customer_credit_facts'",
    [DB_NAME]
  );
  const views = viewsResult[0];
  let viewText = "";
  if (views.length > 0) {
    viewText = String(views[0].VIEW_DEFINITION || "").toLowerCase();
  }
  if (viewText !== "" && viewText.indexOf("least(") === -1) return true;

  return false;
}

async function loadProceduresIfMissing(runSqlScript) {
  const before = await countProcedures();
  const older = before >= EXPECTED_PROCEDURES && await routinesAreOld();
  if (before >= EXPECTED_PROCEDURES && !older) return;

  let sql;
  try {
    sql = fs.readFileSync(PROCEDURES_FILE, "utf8");
  } catch (error) {
    console.warn("Cannot read " + PROCEDURES_FILE + ": " + error.message + ". Run it by hand.");
    return;
  }

  if (before >= EXPECTED_PROCEDURES) {
    console.log("Some stored procedures in this database are an older version; loading " +
      "public/database/2-stored-procedures.sql again (views and procedures only, no rows).");
  } else {
    console.log(before + " of " + EXPECTED_PROCEDURES + " stored procedures are loaded; " +
      "loading public/database/2-stored-procedures.sql now (views and procedures only, no rows).");
  }
  try {
    await runSqlScript(sql);
    forgetProcedureCount();
    const after = await countProcedures();
    if (after >= EXPECTED_PROCEDURES) {
      console.log("All " + EXPECTED_PROCEDURES + " stored procedures are loaded.");
    } else {
      console.warn("Still " + after + " of " + EXPECTED_PROCEDURES + " after loading the file; " +
        "the file on disk may be older than the code. Nothing can be saved until they match.");
    }
  } catch (error) {
    console.error("Loading the stored procedures failed:", error.message);
    console.error("Run public/database/2-stored-procedures.sql by hand; it touches no row.");
  }
}

function procedureAdvice() {
  return "This database has " + proceduresLoaded + " of " + EXPECTED_PROCEDURES + " stored " +
    "procedures, so nothing can be saved. Restart the server: it loads " +
    "public/database/2-stored-procedures.sql itself on start-up. " +
    "That file touches no table and no row. Nothing else is wrong: your data is intact.";
}

async function migrateRecordArchives() {
  const tables = ["suppliers", "customers", "categories", "units"];
  const columnsResult = await db.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('suppliers', 'customers', 'categories', 'units')\n" +
      "       AND COLUMN_NAME IN ('is_archived', 'archived_at', 'archived_by_staff_id')",
    [DB_NAME]
  );
  const have = [];
  for (let i = 0; i < columnsResult[0].length; i++) {
    const row = columnsResult[0][i];
    have.push(row.TABLE_NAME + "." + row.COLUMN_NAME);
  }

  const wanted = [
    ["is_archived", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["archived_at", "TIMESTAMP NULL"],
    ["archived_by_staff_id", "INT NULL"]
  ];
  let added = 0;
  for (let t = 0; t < tables.length; t++) {
    for (let c = 0; c < wanted.length; c++) {
      if (have.indexOf(tables[t] + "." + wanted[c][0]) !== -1) continue;
      await db.query("ALTER TABLE " + tables[t] + " ADD COLUMN " + wanted[c][0] + " " + wanted[c][1]);
      added++;
    }
  }
  if (added > 0) {
    console.log("Added " + added + " archive column(s) to suppliers, customers, categories and units.");
  }
}

async function migrateVoidRequests() {
  const typeResult = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'notif_type'",
    [DB_NAME]
  );
  const found = typeResult[0];
  if (found.length > 0 && String(found[0].COLUMN_TYPE).indexOf("Void Request") === -1) {
    const wider = String(found[0].COLUMN_TYPE).replace(/\)$/, ",'Void Request')");
    await db.query("ALTER TABLE notifications MODIFY COLUMN notif_type " + wider + " NOT NULL");
    console.log("Added the Void Request kind of alert (notifications.notif_type).");
  }

  const tablesResult = await db.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'void_requests'",
    [DB_NAME]
  );
  if (tablesResult[0].length > 0) return;

  await db.query(
    "CREATE TABLE void_requests (\n" +
      "       request_id INT AUTO_INCREMENT PRIMARY KEY,\n" +
      "       sale_id INT NOT NULL,\n" +
      "       reason VARCHAR(255) NOT NULL,\n" +
      "       status ENUM('Pending','Approved','Declined') NOT NULL DEFAULT 'Pending',\n" +
      "       requested_by_staff_id INT NULL,\n" +
      "       requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
      "       decided_by_staff_id INT NULL,\n" +
      "       decided_at TIMESTAMP NULL,\n" +
      "       decision_note VARCHAR(255) NULL,\n" +
      "       INDEX idx_void_requests_sale (sale_id, status),\n" +
      "       INDEX idx_void_requests_status (status),\n" +
      "       FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (requested_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,\n" +
      "       FOREIGN KEY (decided_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE\n" +
      "     )");
  console.log("Added the void_requests table: a cashier's request to void a sale, for a manager to decide.");
}

async function migrateStaffDeactivatedAt() {
  const columnsResult = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS\n" +
      "     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'staff' AND COLUMN_NAME = 'deactivated_at'",
    [DB_NAME]
  );
  if (columnsResult[0].length > 0) return;

  await db.query("ALTER TABLE staff ADD COLUMN deactivated_at TIMESTAMP NULL AFTER is_active");
  await db.query(
    "UPDATE staff SET deactivated_at = COALESCE(archived_at, NOW()) WHERE is_active = FALSE");
  const back = await db.query(
    "UPDATE staff SET archived_at = NULL, archived_by_staff_id = NULL\n" +
      "     WHERE is_active = FALSE AND archived_at IS NOT NULL\n" +
      "       AND archived_at > DATE_SUB(NOW(), INTERVAL 30 DAY)");
  const moved = back[0] && back[0].affectedRows ? back[0].affectedRows : 0;
  console.log("Added staff.deactivated_at: a deactivated account is archived after 30 days" +
    (moved > 0 ? " (" + moved + " recently deactivated account(s) are back in the Staff Directory)." : "."));
}

async function migrateManualReorderPoints() {
  const result = await db.query("UPDATE products SET reorder_mode = 'Manual' WHERE reorder_mode = 'Dynamic'");
  const changed = result[0] && result[0].affectedRows ? result[0].affectedRows : 0;
  if (changed > 0) {
    console.log("Set " + changed + " product(s) from a calculated to a typed reorder point " +
      "(the calculated reorder point is no longer used).");
  }
}

async function migrateDatabase(runSqlScript) {
  await migrateServerTables();

  const total = await countProcedures();
  if (total >= EXPECTED_PROCEDURES) {
    console.log("All " + EXPECTED_PROCEDURES + " stored procedures are loaded.");
  }

  await migrateSignInHold();
  await migrateMiddleNameColumn();
  await migratePhoneNumbers();
  await migrateAccessControlTables();
  await migrateMeasuredQuantities();
  await migrateSellingUnits();
  await migratePurchaseOrderApproval();
  await migratePackSizes();
  await migrateLatePenalties();
  await migrateRefundedAmount();
  await migrateCashierRemarks();
  await migrateDeliveryAddressParts();
  await migrateCustomerNameAndAddress();
  await migrateDeliveryCreatedDate();
  await migrateAccountManagementKey();
  await migrateProprietorName();
  await migrateReturnInspection();
  await migrateMissingReports();
  await migrateBankDetails();
  await migrateReceiptLayout();
  await migrateCreditTerms();
  await migratePolicyTexts();
  await restoreArchivedDeliveries();
  await migrateNewProductAlert();
  await migrateRemoveDeliveryAreas();
  await migratePasswordResets();
  await migrateOrderReference();
  await migrateDeliveryRemarks();
  await migrateSupplierResponse();
  await migrateSupplierQuote();
  await migrateQrPayments();
  await migratePaymentDetails();
  await migrateLoyaltySettings();
  await migrateDiscountPolicy();
  await migrateCheckConstraints();
  await migrateRecordArchives();
  await migrateManualReorderPoints();
  await migrateVoidRequests();
  await migrateStaffDeactivatedAt();
  await loadProceduresIfMissing(runSqlScript);
  await hashLegacyPasswords();
  await warnIfAdminPasswordIsDefault();
}

async function migrateOneAtATime(runSqlScript) {
  const lockName = DB_NAME + ".startup";
  const connection = await db.getConnection();
  try {
    const lockedResult = await connection.query("SELECT GET_LOCK(?, 120) AS got", [lockName]);
    const locked = lockedResult[0];
    if (Number(locked[0].got) !== 1) throw new Error("another copy of the server held the start-up lock too long");
    try {
      await migrateDatabase(runSqlScript);
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
  } finally {
    connection.release();
  }
}

module.exports = {
  EXPECTED_PROCEDURES: EXPECTED_PROCEDURES,
  SERVER_TABLES: SERVER_TABLES,
  migrateOneAtATime: migrateOneAtATime,
  migrateAccountManagementKey: migrateAccountManagementKey,
  countProcedures: countProcedures,
  proceduresAreMissing: proceduresAreMissing,
  proceduresLoadedCount: proceduresLoadedCount,
  forgetProcedureCount: forgetProcedureCount,
  loadProceduresIfMissing: loadProceduresIfMissing,
  procedureAdvice: procedureAdvice
};
