// ============================================================
// server.js -- the main file of the back end (start it with: npm start)
//
// What this file does, from top to bottom:
//   1. Reads the settings from the .env file and connects to MySQL
//      (the connection itself is in Connections/database.js).
//   2. Runs small "migrations": if an older database is missing a column
//      or table, it is added here so the app still works.
//   3. Sets up Express: serves the pages and css in public/Front-end/, the
//      browser scripts (Back-end/modules/ and the *-connection.js files in
//      Back-end/Connections/) and Bootstrap in public/vendor/. Nothing else
//      (server code, SQL files) is served.
//   4. Checks who is signed in and what each role may open.
//   5. Loads the route files from the Connections folder (login.js,
//      admin.js, manager.js, cashier.js, inventory-clerk.js, delivery.js)
//      and starts listening on the port.
//
// Two short forms you will see a lot:
//   const [rows] = await db.query(...);
//     db.query() gives back a list of two things: [rows, fields].
//     We only need the rows, so we take the first item with [rows].
//   const { email, password } = request.body;
//     is short for:  const email = request.body.email;
//                    const password = request.body.password;
// ============================================================

// Load the settings (database password etc.) from the .env file in the project folder
const dotenv = require("dotenv");
dotenv.config({ path: require("path").join(__dirname, "..", "..", ".env"), quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
// sqlValue("it's") makes a value safe to put inside SQL text,
// sqlName("users") does the same for a table or column name
const mysqlTools = require("mysql2");
const sqlValue = mysqlTools.escape;
const sqlName = mysqlTools.escapeId;
// The routes of each kind of user are in the connections folder:
//   Connections/login.js            signing in and out (every user)
//   Connections/admin.js            System Administrator
//   Connections/manager.js          Manager
//   Connections/cashier.js          Cashier
//   Connections/inventory-clerk.js  Inventory Clerk
//   Connections/delivery.js         Delivery Personnel
//   Connections/qr-payments.js      GCash and Maya paid by QR code (PayMongo)
const registerLoginRoutes = require("./Connections/login").registerLoginRoutes;
const registerAdminRoutes = require("./Connections/admin").registerAdminRoutes;
const registerManagerRoutes = require("./Connections/manager").registerManagerRoutes;
const registerCashierRoutes = require("./Connections/cashier").registerCashierRoutes;
const registerDeliveryRoutes = require("./Connections/delivery").registerDeliveryRoutes;
const registerInventoryRoutes = require("./Connections/inventory-clerk").registerInventoryRoutes;
const registerQrPaymentRoutes = require("./Connections/qr-payments").registerQrPaymentRoutes;

const app = express();

// the port the website runs on (http://localhost:3000)
const port = Number(process.env.HARDWARE_PORT) || 3000;

// the MySQL connection lives in Connections/database.js
const database = require("./Connections/database");
const db = database.db;
const DB_NAME = database.DB_NAME;
const DB_HOST = database.DB_HOST;
const DB_PORT = database.DB_PORT;
// true when running as a Vercel Function: no timers, no files, many copies
const IS_VERCEL = database.IS_VERCEL;

// Behind Vercel's proxy, request.protocol reads "https" from X-Forwarded-Proto,
// so links built from the request (the supplier's order link) are https too.
if (IS_VERCEL) app.set("trust proxy", true);

// hashing and generating passwords, shared with the recovery script
const passwords = require("./passwords");
const hashPassword = passwords.hashPassword;
const isHashed = passwords.isHashed;
const generatePassword = passwords.generatePassword;
const verifyPassword = passwords.verifyPassword;

async function hashLegacyPasswords() {
  const [rows] = await db.query("SELECT user_id, password FROM users");
  // find the passwords that are still plain text (not hashed yet)
  const plain = [];
  for (const row of rows) {
    if (!isHashed(row.password)) {
      plain.push(row);
    }
  }

  if (plain.length === 0) return;

  for (const row of plain) {
    await db.query("UPDATE users SET password = ? WHERE user_id = ?",
      [await hashPassword(row.password), row.user_id]);
  }
  console.log(`Hashed ${plain.length} password(s) that were stored as readable text.`);
}

async function migrateSignInHold() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'
       AND COLUMN_NAME IN ('failed_attempts', 'held_until')`,
    [DB_NAME]
  );
  if (columns.length === 2) return;

  const names = columns.map((row) => row.COLUMN_NAME);
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

// One-time upgrade: staff.middle_initial -> staff.middle_name. full_name is
// a generated column reading it, so it is dropped and rebuilt in the same
// statement. Does nothing once the column is already middle_name.
async function migrateMiddleNameColumn() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'staff'
       AND COLUMN_NAME IN ('middle_initial', 'middle_name')`,
    [DB_NAME]
  );

  const names = columns.map((row) => row.COLUMN_NAME);
  if (names.indexOf("middle_initial") === -1) return;   // already migrated, or no staff table

  await db.query("ALTER TABLE staff DROP COLUMN full_name");
  await db.query(
    "ALTER TABLE staff CHANGE COLUMN middle_initial middle_name VARCHAR(100) NULL"
  );
  await db.query(
    `ALTER TABLE staff ADD COLUMN full_name VARCHAR(220) AS (
       CONCAT(first_name,
              IF(middle_name IS NULL OR middle_name = '', '',
                 CONCAT(' ', UPPER(LEFT(middle_name, 1)), '.')),
              ' ', last_name)
     ) VIRTUAL AFTER created_at`
  );

  console.log("Upgraded staff.middle_initial to staff.middle_name. " +
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

async function migratePhoneNumbers() {
  const [rows] = await db.query(
    "SELECT staff_id, phone FROM staff WHERE phone IS NOT NULL AND phone <> ''");

  // find the phone numbers that are not written in the +63 form yet
  const wrong = [];
  for (const row of rows) {
    if (row.phone !== cleanPhone(row.phone)) {
      wrong.push(row);
    }
  }
  if (wrong.length === 0) return;

  let emptied = 0;

  for (const row of wrong) {
    // a number we can fix is rewritten; a number that makes no sense is cleared
    let fixed = null;
    if (phoneComplaint(row.phone) === null) {
      fixed = cleanPhone(row.phone);
    } else {
      emptied += 1;
    }

    await db.query("UPDATE staff SET phone = ? WHERE staff_id = ?", [fixed, row.staff_id]);
  }

  let message = `Rewrote ${wrong.length} staff phone number(s) to +63 form.`;
  if (emptied > 0) {
    message += ` ${emptied} of them was not a usable number and was cleared; re-enter it on the staff record.`;
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
  for (const item of columns) {
    const table = item[0];
    const column = item[1];
    const rest = item[2];
    const [rows] = await db.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_NAME, table, column]);
    if (!rows[0] || String(rows[0].DATA_TYPE).toLowerCase() !== "int") continue;

    if (table === "sale_items") {
      await db.query("ALTER TABLE sale_items DROP COLUMN subtotal");
      await db.query(`ALTER TABLE sale_items MODIFY quantity DECIMAL(12,3) ${rest}`);
      await db.query("ALTER TABLE sale_items ADD COLUMN subtotal DECIMAL(12,2) AS (quantity * unit_price) STORED");
    } else {
      await db.query(`ALTER TABLE ${table} MODIFY ${column} DECIMAL(12,3) ${rest}`);
    }
    widened += 1;
  }

  if (widened > 0) {
    console.log(`Widened ${widened} quantity column(s) to take fractions (kilos, metres). ` +
      "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures take them too.");
  }
}

async function migrateAccessControlTables() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'role_feature_permissions'`,
    [DB_NAME]
  );
  const have = [];
  for (const row of tables) {
    have.push(row.TABLE_NAME);
  }
  let created = 0;

  // the switches for which screens each role's menu holds; one row per override
  if (!have.includes("role_feature_permissions")) {
    await db.query(
      `CREATE TABLE role_feature_permissions (
         permission_id INT AUTO_INCREMENT PRIMARY KEY,
         role_id INT NOT NULL,
         feature_key VARCHAR(40) NOT NULL,
         is_granted BOOLEAN NOT NULL DEFAULT TRUE,
         note VARCHAR(255) NULL,
         granted_by_staff_id INT NULL,
         granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_role_feature (role_id, feature_key),
         FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE ON UPDATE CASCADE,
         FOREIGN KEY (granted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
       )`);
    created += 1;
  }

  const [typeColumn] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'action_type'`,
    [DB_NAME]
  );
  let widened = false;
  if (typeColumn[0] && !/'ACCESS'/i.test(typeColumn[0].COLUMN_TYPE)) {
    await db.query(
      `ALTER TABLE audit_logs MODIFY action_type
         ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP',
              'LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT',
              'ACCESS','OTHER') NOT NULL DEFAULT 'OTHER'`);
    widened = true;
  }

  if (widened) {
    console.log("Added the access control table and widened the audit types.");
  } else if (created > 0) {
    console.log("Added the access control table.");
  }
}

// One-time upgrade: the sizes a product also sells in (nails kept by the
// kilo, sold by the sack). product_units holds them, and a sale line says
// which one it was charged in: quantity stays in the product's own unit so
// stock comes off it directly, sold_unit and sold_quantity carry the size,
// and subtotal is rebuilt to multiply the sold figure by the price of one.
async function migrateSellingUnits() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'product_units'`,
    [DB_NAME]
  );
  let created = false;

  if (tables.length === 0) {
    await db.query(
      `CREATE TABLE product_units (
         product_unit_id INT AUTO_INCREMENT PRIMARY KEY,
         product_id INT NOT NULL,
         unit_name VARCHAR(20) NOT NULL,
         units_per DECIMAL(12,3) NOT NULL,
         price DECIMAL(10,2) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_product_unit (product_id, unit_name),
         FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
       )`);
    created = true;
  }

  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sale_items' AND COLUMN_NAME = 'sold_unit'`,
    [DB_NAME]
  );
  let widened = false;

  if (columns.length === 0) {
    await db.query("ALTER TABLE sale_items ADD COLUMN sold_unit VARCHAR(20) NULL AFTER quantity");
    await db.query("ALTER TABLE sale_items ADD COLUMN sold_quantity DECIMAL(12,3) NULL AFTER sold_unit");
    // subtotal is generated, so it is dropped and put back reading the sold figure
    await db.query("ALTER TABLE sale_items DROP COLUMN subtotal");
    await db.query(
      `ALTER TABLE sale_items ADD COLUMN subtotal DECIMAL(12,2)
         AS (ROUND(COALESCE(sold_quantity, quantity) * unit_price, 2)) STORED`);
    widened = true;
  }

  if (created || widened) {
    console.log("Added selling units (product_units, sale_items.sold_unit). " +
      "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the sale procedure takes them.");
  }
}

// The clerk raises an order For Approval and the manager decides it; a
// database made before that has neither the status nor the columns the
// decision is written to, and sp_decide_purchase_order fails on it.
async function migratePurchaseOrderApproval() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders'
       AND COLUMN_NAME IN ('raised_by_staff_id', 'confirmed_by_staff_id',
                           'confirmed_at', 'decision_note', 'discount')`,
    [DB_NAME]
  );
  const [status] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'status'`,
    [DB_NAME]
  );
  const hasApproval = status.length > 0 && status[0].COLUMN_TYPE.indexOf("For Approval") !== -1;
  if (columns.length === 5 && hasApproval) return;

  const names = columns.map((row) => row.COLUMN_NAME);
  if (!hasApproval) {
    // existing rows keep their status; only new orders start For Approval
    await db.query(
      `ALTER TABLE purchase_orders MODIFY COLUMN status
         ENUM('For Approval', 'Pending', 'Received', 'Cancelled') NOT NULL DEFAULT 'For Approval'`);
  }
  if (names.indexOf("raised_by_staff_id") === -1) {
    await db.query(
      `ALTER TABLE purchase_orders ADD COLUMN raised_by_staff_id INT NULL AFTER status,
         ADD FOREIGN KEY (raised_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE`);
  }
  if (names.indexOf("confirmed_by_staff_id") === -1) {
    await db.query(
      `ALTER TABLE purchase_orders ADD COLUMN confirmed_by_staff_id INT NULL AFTER raised_by_staff_id,
         ADD FOREIGN KEY (confirmed_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE`);
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
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

// Orders and deliveries are counted in packs (a box of 20); a database made
// before that has nowhere to keep the pack, and the order procedures fail.
async function migratePackSizes() {
  const wanted = [
    ["products", "pack_name", "VARCHAR(20) NULL"],
    ["products", "pack_size", "DECIMAL(12,3) NULL"],
    ["purchase_order_items", "pack_name", "VARCHAR(20) NULL"],
    ["purchase_order_items", "pack_size", "DECIMAL(12,3) NULL"],
    ["purchase_order_items", "pack_count", "DECIMAL(12,3) NULL"]
  ];
  const [columns] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('products', 'purchase_order_items')
       AND COLUMN_NAME IN ('pack_name', 'pack_size', 'pack_count')`,
    [DB_NAME]
  );
  // "have" = the columns the database already has, written as "table.column"
  const have = [];
  for (const row of columns) {
    have.push(row.TABLE_NAME + "." + row.COLUMN_NAME);
  }

  // "missing" = the wanted columns that are not in "have"
  const missing = [];
  for (const item of wanted) {
    if (have.indexOf(item[0] + "." + item[1]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0) return;

  // item[0] = table, item[1] = column, item[2] = column type
  for (const item of missing) {
    await db.query(`ALTER TABLE ${item[0]} ADD COLUMN ${item[1]} ${item[2]}`);
  }
  console.log(`Added ${missing.length} pack column(s) to products and purchase_order_items. ` +
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

// The late-payment penalty: the shop's rate, an account's own rate, and the
// charge stamped on a sale the day it falls overdue. amount_due is the bill
// with the penalty on it, and every balance reads it. A database made before
// this has none of them, and the credit views and procedures fail.
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
  const [columns] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('store_settings', 'customer_credits', 'sales')
       AND COLUMN_NAME IN ('penalty_rate', 'penalty_months', 'penalty_amount', 'penalty_applied_at', 'amount_due')`,
    [DB_NAME]
  );
  const [notif] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'notif_type'`,
    [DB_NAME]
  );
  const hasAlert = notif.length > 0 && notif[0].COLUMN_TYPE.indexOf("Late Penalty") !== -1;

  // "have" = the columns the database already has, written as "table.column"
  const have = [];
  for (const row of columns) {
    have.push(row.TABLE_NAME + "." + row.COLUMN_NAME);
  }

  // "missing" = the wanted columns that are not in "have"
  const missing = [];
  for (const item of wanted) {
    if (have.indexOf(item[0] + "." + item[1]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0 && hasAlert) return;

  // Added in the order listed: amount_due uses penalty_amount, so it comes last.
  // item[0] = table, item[1] = column, item[2] = column type
  for (const item of missing) {
    await db.query(`ALTER TABLE ${item[0]} ADD COLUMN ${item[1]} ${item[2]}`);
  }
  if (!hasAlert) {
    await db.query(
      `ALTER TABLE notifications MODIFY COLUMN notif_type
         ENUM('Low Stock', 'Out of Stock', 'Damage Report', 'Refund Report', 'Purchase Order',
              'Stock Adjustment', 'Delivery', 'Credit Request', 'Late Penalty') NOT NULL`);
  }
  console.log("Added the late-payment penalty columns (store_settings.penalty_rate, " +
    "customer_credits.penalty_rate, sales.penalty_rate, penalty_months, penalty_amount, penalty_applied_at, amount_due). " +
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the views and procedures match.");
}

// The proprietor's name on the invoice head. A database made before it
// has no column, and sp_update_store_settings fails.
async function migrateProprietorName() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings' AND COLUMN_NAME = 'proprietor'`,
    [DB_NAME]
  );
  if (columns.length > 0) return;

  await db.query("ALTER TABLE store_settings ADD COLUMN proprietor VARCHAR(150) NULL AFTER store_name");
  console.log("Added store_settings.proprietor for the invoice head. " +
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

// A refund the cashier takes back now waits for the clerk to inspect it:
// disposition is empty until then, and the inspection is recorded on the
// report. A database made before this has the column NOT NULL and none of
// the inspection columns, and filing a refund fails.
async function migrateReturnInspection() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'returned_items'
       AND COLUMN_NAME IN ('disposition', 'inspected_by_staff_id', 'inspected_at', 'inspection_note')`,
    [DB_NAME]
  );
  const have = columns.map((row) => row.COLUMN_NAME);
  const disposition = columns.find((row) => row.COLUMN_NAME === "disposition");
  const nullable = disposition && disposition.IS_NULLABLE === "YES";
  if (nullable && have.length === 4) return;

  if (!nullable) {
    await db.query(
      "ALTER TABLE returned_items MODIFY COLUMN disposition ENUM('Return to Stock', 'Write-Off') NULL");
  }
  if (have.indexOf("inspected_by_staff_id") === -1) {
    await db.query(
      `ALTER TABLE returned_items ADD COLUMN inspected_by_staff_id INT NULL AFTER reported_by_staff_id,
         ADD FOREIGN KEY (inspected_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE`);
  }
  if (have.indexOf("inspected_at") === -1) {
    await db.query("ALTER TABLE returned_items ADD COLUMN inspected_at TIMESTAMP NULL AFTER inspected_by_staff_id");
  }
  if (have.indexOf("inspection_note") === -1) {
    await db.query("ALTER TABLE returned_items ADD COLUMN inspection_note VARCHAR(255) NULL AFTER inspected_at");
  }
  console.log("Added the return-inspection columns (returned_items.inspected_by_staff_id, inspected_at, " +
    "inspection_note; disposition may now be empty until the clerk inspects). " +
    "Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

// The account a customer sends a bank transfer to: shown at the till and
// printed on the invoice. A database made before it has none of the columns,
// and the store settings read and sp_update_store_bank_details fail.
async function migrateBankDetails() {
  const wanted = [
    ["bank_name", "VARCHAR(100) NULL AFTER penalty_rate"],
    ["bank_account_name", "VARCHAR(150) NULL AFTER bank_name"],
    ["bank_account_number", "VARCHAR(50) NULL AFTER bank_account_name"]
  ];
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings'
       AND COLUMN_NAME IN ('bank_name', 'bank_account_name', 'bank_account_number')`,
    [DB_NAME]
  );
  const have = [];
  for (const row of columns) {
    have.push(row.COLUMN_NAME);
  }

  const missing = [];
  for (const item of wanted) {
    if (have.indexOf(item[0]) === -1) {
      missing.push(item);
    }
  }
  if (missing.length === 0) return;

  // Added in the order listed, because each one is placed after the one before it.
  // item[0] = column, item[1] = column type
  for (const item of missing) {
    await db.query(`ALTER TABLE store_settings ADD COLUMN ${item[0]} ${item[1]}`);
  }
  console.log("Added the bank transfer details (store_settings.bank_name, bank_account_name, " +
    "bank_account_number). Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the procedures match.");
}

// The receipt's layout (paper width, title, the shop's own header and footer
// lines, what is shown) lives in store_settings.receipt_layout as JSON. A
// database made before it gets the column, filled with the defaults.
async function migrateReceiptLayout() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'store_settings' AND COLUMN_NAME = 'receipt_layout'`,
    [DB_NAME]
  );
  if (columns.length === 0) {
    await db.query("ALTER TABLE store_settings ADD COLUMN receipt_layout TEXT NULL AFTER bank_account_number");
    console.log("Added store_settings.receipt_layout for the receipt's layout.");
  }
  await db.query(
    "UPDATE store_settings SET receipt_layout = ? WHERE setting_id = 1 AND receipt_layout IS NULL",
    [JSON.stringify(DEFAULT_RECEIPT_LAYOUT)]);
}

// The codes behind "Forgot your password?". Only the scrypt hash of a code is
// kept, never the code. A database made before it has no table, and asking
// for a code fails.
async function migratePasswordResets() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'password_resets'`,
    [DB_NAME]
  );
  if (tables.length > 0) return;

  await db.query(
    `CREATE TABLE password_resets (
       reset_id INT AUTO_INCREMENT PRIMARY KEY,
       user_id INT NOT NULL,
       code_hash VARCHAR(255) NOT NULL,
       expires_at TIMESTAMP NOT NULL,
       attempts INT NOT NULL DEFAULT 0,
       used_at TIMESTAMP NULL,
       requested_ip VARCHAR(45) NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_password_resets_user (user_id, created_at),
       FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
     )`);
  console.log("Added the password_resets table for signing in again with a code sent by email.");
}

// The supplier's answer to an approved order. The printed order (and the
// mail, when the clerk emails it) carries a link with the order's code and a
// QR code of it; the supplier's Accept or Decline lands in the columns after
// it. The code is kept as it is, not hashed, so every reprint carries the same
// working link; it lets its holder answer that one order and nothing else.
// An early version kept only a hash (supplier_token_hash); that is dropped.
async function migrateSupplierResponse() {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders'
       AND COLUMN_NAME IN ('supplier_code', 'supplier_sent_at', 'supplier_response',
                           'supplier_responded_at', 'supplier_note', 'supplier_token_hash')`,
    [DB_NAME]
  );
  const names = columns.map((row) => row.COLUMN_NAME);
  const wanted = ["supplier_code", "supplier_sent_at", "supplier_response", "supplier_responded_at", "supplier_note"];
  if (wanted.every((name) => names.indexOf(name) !== -1) && names.indexOf("supplier_token_hash") === -1) return;

  if (names.indexOf("supplier_code") === -1) {
    await db.query(
      `ALTER TABLE purchase_orders ADD COLUMN supplier_code VARCHAR(64) NULL,
         ADD UNIQUE INDEX idx_purchase_orders_supplier_code (supplier_code)`);
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

// The supplier, accepting from the link, says when the order ships and may
// correct a price that does not match what they sell. The corrected price
// goes on the line; the shop's own price is kept beside it (original_unit_cost)
// so the change is never lost.
async function migrateSupplierQuote() {
  const [columns] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND ((TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'supplier_ship_date')
         OR (TABLE_NAME = 'purchase_order_items' AND COLUMN_NAME = 'original_unit_cost'))`,
    [DB_NAME]
  );
  const names = columns.map((row) => row.COLUMN_NAME);
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

// Every GCash or Maya payment tried by QR code. The same table as
// public/database/3-ADD-qr-payments.sql, which does this by hand.
async function migrateQrPayments() {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'qr_payments'`,
    [DB_NAME]
  );
  if (tables.length > 0) return;

  await db.query(
    `CREATE TABLE qr_payments (
       qr_payment_id INT AUTO_INCREMENT PRIMARY KEY,
       provider ENUM('paymongo','sim') NOT NULL,
       mode ENUM('test','live') NOT NULL,
       provider_intent_id VARCHAR(80) NOT NULL,
       provider_payment_id VARCHAR(80) NULL,
       amount DECIMAL(12,2) NOT NULL,
       wallet ENUM('GCash','PayMaya') NOT NULL,
       purpose ENUM('sale','credit_payment') NOT NULL,
       status ENUM('pending','paid','failed','expired','cancelled') NOT NULL DEFAULT 'pending',
       error_message VARCHAR(255) NULL,
       sale_id INT NULL,
       created_by_staff_id INT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       expires_at TIMESTAMP NULL,
       paid_at TIMESTAMP NULL,
       closed_at TIMESTAMP NULL,
       UNIQUE KEY uq_qr_payments_intent (provider_intent_id),
       INDEX idx_qr_payments_created (created_at),
       INDEX idx_qr_payments_status (status),
       FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE SET NULL ON UPDATE CASCADE,
       FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
     )`);
  console.log("Added the qr_payments table for GCash and Maya payments by QR code.");
}

// The tables the server keeps for itself, so that any copy of it can answer
// any request (Vercel runs many): who is signed in, the live-update log,
// account drafts waiting for a second look, backups when there is no disk to
// keep them on, a few switches, and the offline payment simulator. They are
// not shop data, so a backup leaves them out and a restore leaves them be.
// Times are milliseconds since 1970 (Date.now()), free of any time zone.
const SERVER_TABLES = ["user_sessions", "live_changes", "account_drafts",
                       "backup_files", "app_flags", "qr_sim_intents"];

async function migrateServerTables() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS user_sessions (
       token_hash CHAR(64) PRIMARY KEY,
       staff_id INT NOT NULL,
       user_id INT NOT NULL,
       role_id INT NOT NULL,
       role_name VARCHAR(50) NOT NULL,
       email VARCHAR(100) NOT NULL,
       started_at BIGINT NOT NULL,
       last_seen BIGINT NOT NULL,
       expires_at BIGINT NOT NULL,
       ended_reason VARCHAR(255) NULL,
       ended_at BIGINT NULL,
       INDEX idx_user_sessions_staff (staff_id),
       INDEX idx_user_sessions_expires (expires_at)
     )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS live_changes (
       change_id BIGINT AUTO_INCREMENT PRIMARY KEY,
       scope VARCHAR(30) NOT NULL,
       detail VARCHAR(255) NULL,
       origin VARCHAR(64) NULL,
       created_at BIGINT NOT NULL
     )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS account_drafts (
       draft_hash CHAR(64) PRIMARY KEY,
       staff_id INT NOT NULL,
       kind VARCHAR(10) NOT NULL,
       payload TEXT NOT NULL,
       expires_at BIGINT NOT NULL
     )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS backup_files (
       file_name VARCHAR(100) PRIMARY KEY,
       bytes INT NOT NULL,
       created_at BIGINT NOT NULL,
       content LONGBLOB NOT NULL
     )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_flags (
       flag_key VARCHAR(50) PRIMARY KEY,
       flag_value VARCHAR(255) NULL,
       updated_at BIGINT NOT NULL
     )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS qr_sim_intents (
       intent_id VARCHAR(40) PRIMARY KEY,
       token VARCHAR(40) NOT NULL UNIQUE,
       amount DECIMAL(12,2) NOT NULL,
       wallet VARCHAR(20) NOT NULL,
       description VARCHAR(255) NULL,
       return_url VARCHAR(500) NOT NULL,
       status VARCHAR(10) NOT NULL,
       payment_id VARCHAR(40) NULL,
       error_message VARCHAR(255) NULL,
       created_at BIGINT NOT NULL
     )`);
}

// a named figure so adding a procedure changes one number, not two
const EXPECTED_PROCEDURES = 36;

// Nearly every write goes through a stored procedure, so a database with the
// tables but not the procedures (file 1 run, file 2 not) reads fine and
// cannot be written to. The count is remembered and the guard below turns
// those writes into one sentence naming the fix. Re-checked whenever it is
// bad, so loading file 2 is picked up without a restart.
let proceduresLoaded = null;      // null until the first count
let procedureCheckAt = 0;
const PROCEDURE_RECHECK_MS = 5000;

async function countProcedures() {
  const [rows] = await db.query(
    "SELECT COUNT(*) AS total FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
    [DB_NAME]
  );
  proceduresLoaded = rows[0].total;
  procedureCheckAt = Date.now();
  return proceduresLoaded;
}

// once the full set has been seen it is believed
async function proceduresAreMissing() {
  if (proceduresLoaded !== null && proceduresLoaded >= EXPECTED_PROCEDURES) return false;
  if (Date.now() - procedureCheckAt < PROCEDURE_RECHECK_MS) return true;

  try {
    return (await countProcedures()) < EXPECTED_PROCEDURES;
  } catch (error) {
    return false;   // the database is unreachable; that is a different message
  }
}

// admin.js reads the count through these rather than the variable itself,
// so forgetting it after a restore reaches the copy that matters
function proceduresLoadedCount() {
  return proceduresLoaded;
}

function forgetProcedureCount() {
  proceduresLoaded = null;
  procedureCheckAt = 0;
}

// The views and procedures live in one file. When the database has fewer
// than the code was built for (file 1 run without file 2, or an old copy of
// file 2 run from a stale editor tab), the server loads that file itself,
// after the column migrations so the views find every column they read.
// The file drops and recreates views and procedures only; no row is touched.
const PROCEDURES_FILE = path.join(__dirname, "..", "database", "2-RUN-SECOND-stored-procedures.sql");

async function loadProceduresIfMissing() {
  const before = await countProcedures();
  if (before >= EXPECTED_PROCEDURES) return;

  let sql;
  try {
    sql = fs.readFileSync(PROCEDURES_FILE, "utf8");
  } catch (error) {
    console.warn(`Cannot read ${PROCEDURES_FILE}: ${error.message}. Run it by hand.`);
    return;
  }

  console.log(`${before} of ${EXPECTED_PROCEDURES} stored procedures are loaded; ` +
    "loading public/database/2-RUN-SECOND-stored-procedures.sql now (views and procedures only, no rows).");
  try {
    await adminModule.runSqlScript(sql);
    forgetProcedureCount();
    const after = await countProcedures();
    if (after >= EXPECTED_PROCEDURES) {
      console.log(`All ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
    } else {
      console.warn(`Still ${after} of ${EXPECTED_PROCEDURES} after loading the file; ` +
        "the file on disk may be older than the code. Nothing can be saved until they match.");
    }
  } catch (error) {
    console.error("Loading the stored procedures failed:", error.message);
    console.error("Run public/database/2-RUN-SECOND-stored-procedures.sql by hand; it touches no row.");
  }
}

function procedureAdvice() {
  return `This database has ${proceduresLoaded} of ${EXPECTED_PROCEDURES} stored ` +
    "procedures, so nothing can be saved. Restart the server: it loads " +
    "public/database/2-RUN-SECOND-stored-procedures.sql itself on start-up. " +
    "That file touches no table and no row. Nothing else is wrong: your data is intact.";
}

// The start-up work below runs once per copy of the server. On a PC that is
// once; on Vercel it is every time a new copy wakes up, and the first request
// waits for it (see the hook after this) so it never meets a missing table.
async function migrateDatabase() {
  // first: sign-in reads user_sessions on every request
  await migrateServerTables();

  const total = await countProcedures();
  if (total >= EXPECTED_PROCEDURES) {
    console.log(`All ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
  }
  // otherwise they are loaded from the file below, once the columns they read exist

  await migrateSignInHold();
  await migrateMiddleNameColumn();
  await migratePhoneNumbers();
  await migrateAccessControlTables();
  await migrateMeasuredQuantities();
  await migrateSellingUnits();
  await migratePurchaseOrderApproval();
  await migratePackSizes();
  await migrateLatePenalties();
  await migrateProprietorName();
  await migrateReturnInspection();
  await migrateBankDetails();
  await migrateReceiptLayout();
  await migratePasswordResets();
  await migrateSupplierResponse();
  await migrateSupplierQuote();
  await migrateQrPayments();
  await loadProceduresIfMissing();
  await hashLegacyPasswords();
}

// Two copies starting together (Vercel waking several at once) would both
// see a column missing and both add it, and one fails. A MySQL lock, held on
// its own connection, makes them take turns; the second finds nothing to do.
async function migrateOneAtATime() {
  const lockName = `${DB_NAME}.startup`;
  const connection = await db.getConnection();
  try {
    const [locked] = await connection.query("SELECT GET_LOCK(?, 120) AS got", [lockName]);
    if (Number(locked[0].got) !== 1) throw new Error("another copy of the server held the start-up lock too long");
    try {
      await migrateDatabase();
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
  } finally {
    connection.release();
  }
}

const startup = db.getConnection()
  .then(async (connection) => {
    connection.release();
    console.log(`Connected to MySQL database "${DB_NAME}" on ${DB_HOST}:${DB_PORT}.`);

    await migrateOneAtATime();

    // last, so the first backup is not taken of a schema about to change.
    // On Vercel nothing runs between requests, so the daily job at
    // /api/cron/daily (vercel.json) does this work instead of timers.
    if (!IS_VERCEL) {
      adminModule.startAutoBackup();
      adminModule.startArchiveSweep();
      managerModule.startPenaltySweep();
      const sessionTimer = setInterval(() => {
        removeExpiredSessions().catch((error) => console.error("Session sweep failed:", error.message));
      }, SESSION_SWEEP_MS);
      sessionTimer.unref();
    }
  })
  .catch((error) => {
    console.error("DATABASE CONNECTION FAILED:", error.message);
    console.error("Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env at the project root (see .env.example),");
    console.error("and make sure you ran the two files in public/database/, in the order their names give.");
  });

app.use(async (request, response, next) => {
  await startup;
  next();
});

// PayMongo signs the exact bytes it sends, so its webhook is read raw: this
// comes before express.json(), which would parse the body and lose them.
app.use("/api/paymongo/webhook", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (request, response) => {
  response.redirect("/Login.html");
});

// every browser asks for this; a 404 in the console hides real errors
const FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="6" fill="#1d4ed8"/>` +
  `<path d="M9 8h3v7h8V8h3v16h-3v-7h-8v7H9z" fill="#fff"/></svg>`;

app.get(["/favicon.ico", "/favicon.svg"], (request, response) => {
  response.type("image/svg+xml");
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.send(FAVICON);
});

// Only these are handed to a browser (see express.static below):
//   public/Front-end/                           the pages and css       at /
//   public/Back-end/modules/                    the page scripts        at /modules/
//   public/Back-end/Connections/*-connection.js the browser's API calls at /connections/
//   public/vendor/                              Bootstrap               at /vendor/
// Everything else stays private: the server code in public/Back-end/
// (mailer.js names the mail account, mail-password.txt holds its password,
// Connections/login.js holds the sign-in rules) and the SQL files in
// public/database/. The guard below refuses those addresses outright as well,
// in case a folder is ever served from higher up again.
const PRIVATE_FILES = [
  /^\/back-?end(\/|$)/i,
  /^\/database(\/|$)/i
];

// express.static percent-decodes and normalises the path before choosing a
// file, so the guard has to resolve it the same way or a spelling it did not
// think of walks past it.
function resolvedPath(rawPath) {
  let pathname;

  try {
    pathname = decodeURIComponent(rawPath);
  } catch (error) {
    return null;   // a malformed %-escape; nothing legitimate is spelled this way
  }

  // a null byte truncates a filename; a backslash is a separator on Windows
  if (pathname.indexOf("\0") !== -1) return null;
  pathname = pathname.replace(/\\/g, "/");     // turn every \ into /
  pathname = pathname.replace(/\/{2,}/g, "/");  // turn // (or ///) into a single /

  // clean up things like "/a/../b" into "/b"
  pathname = path.posix.normalize(pathname);
  if (!pathname.startsWith("/")) {
    pathname = "/" + pathname;
  }
  return pathname;
}

app.use((request, response, next) => {
  const pathname = resolvedPath(request.path);

  if (pathname === null) {
    return response.status(400).send("Bad request");
  }

  // pretend private files do not exist
  for (const pattern of PRIVATE_FILES) {
    if (pattern.test(pathname)) {
      return response.status(404).send("Not found");
    }
  }

  next();
});

// the five roles, spelled exactly as the roles table spells them
const ADMIN = "System Administrator";
const MANAGER = "Manager";
const CLERK = "Inventory Clerk";
const CASHIER = "Cashier";
const DRIVER = "Delivery Personnel";

// the two halves of the shop: the office decides, the floor does
const MANAGEMENT = [ADMIN, MANAGER];
const STAFF = [CLERK, CASHIER, DRIVER];

// A dashboard page is served to its role only, checked here from the session
// cookie before the file server sees the request. No session goes to sign-in;
// the wrong role goes to its own dashboard.
const PAGE_ROLES = {
  "/system.html":              [ADMIN],
  "/manager.html":             [MANAGER],
  "/inventory-dashboard.html": [CLERK],
  "/cashier-dashboard.html":   [CASHIER],
  "/delivery.html":            [DRIVER]
};

// the home page of each role (the reverse of PAGE_ROLES)
const ROLE_PAGES = {};
ROLE_PAGES[ADMIN] = "/system.html";
ROLE_PAGES[MANAGER] = "/manager.html";
ROLE_PAGES[CLERK] = "/inventory-dashboard.html";
ROLE_PAGES[CASHIER] = "/cashier-dashboard.html";
ROLE_PAGES[DRIVER] = "/delivery.html";

app.use(async (request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const pathname = resolvedPath(request.path);
  if (pathname === null) return next();

  // Is this one of the dashboard pages? Compared without caring about
  // upper/lower case, because Windows file names do not care either.
  let page = null;
  for (const name of Object.keys(PAGE_ROLES)) {
    if (name.toLowerCase() === pathname.toLowerCase()) {
      page = name;
    }
  }
  const changePassword = pathname.toLowerCase() === "/change-password.html";
  if (!page && !changePassword) return next();

  const session = await currentSession(request);
  if (!session) return response.redirect("/Login.html");

  if (changePassword) return next();

  if (!PAGE_ROLES[page].includes(session.roleName)) {
    return response.redirect(ROLE_PAGES[session.roleName] || "/Login.html");
  }

  next();
});

// the folders a browser may read from (everything else stays private)
const PUBLIC_DIR = path.join(__dirname, "..");                // public/
app.use(express.static(path.join(PUBLIC_DIR, "Front-end")));  // /Login.html, /css/...
app.use("/modules", express.static(path.join(__dirname, "modules")));        // /modules/...

// Connections/ holds both halves of every connection: the server's routes
// (admin.js, login.js, database.js ...) and the browser's calls
// (admin-connection.js ...). Only a plain "<name>-connection.js" is handed out;
// letters and hyphens only, so no dot, slash or %-escape can reach a route file.
const BROWSER_CONNECTION = /^\/[a-z]+(-[a-z]+)*-connection\.js$/i;
app.use("/connections", (request, response, next) => {
  if (!BROWSER_CONNECTION.test(request.path)) {
    return response.status(404).send("Not found");
  }
  next();
}, express.static(path.join(__dirname, "Connections")));
app.use("/vendor", express.static(path.join(PUBLIC_DIR, "vendor")));         // /vendor/bootstrap/...

// ==========================================
// HELPERS
// ==========================================

// runs a stored procedure and reads its OUT values on the same connection
async function callProcedure(sql, params, outputNames) {
  const connection = await db.getConnection();
  try {
    await connection.query(sql, params);

    // Build "SELECT @a AS `a`, @b AS `b`" to read the OUT values back.
    // The name is quoted because some are reserved words (like "lines").
    const parts = [];
    for (const name of outputNames) {
      parts.push(`@${name} AS ${sqlName(name)}`);
    }
    const selectList = parts.join(", ");
    const [rows] = await connection.query(`SELECT ${selectList}`);
    return rows[0];
  } finally {
    connection.release();
  }
}

// A staff phone number is stored as + country code and digits, +639171234567.
// The browser enforces the same rule as it is typed; it is enforced again here
// because this route is not the only way a row gets written. Any Philippine
// spelling (09171234567, 0917 123 4567, 639171234567) lands as +63...; under
// +63 a number must be ten digits starting 9. Blank stays blank.
const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;
const PH_CODE = "63";
const PH_NATIONAL_DIGITS = 10;

// Keeps only the digits of a phone number, and turns a leading 0 into 63.
// Example: "0917 123 4567" -> "639171234567"
function phoneDigitsAll(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");                              // remove everything that is not a digit
  text = text.replace(/^0+/, PH_CODE);                         // 0917... -> 63917...
  text = text.replace(new RegExp("^" + PH_CODE + "0+"), PH_CODE); // 630917... -> 63917...
  return text;
}

function phoneDigits(value) {
  return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

// null when there is nothing to complain about, otherwise the one sentence
// the screen shows
function phoneComplaint(value) {
  const digits = phoneDigitsAll(value);

  if (digits === "") return null;               // optional, and left empty

  // only Philippine numbers are taken; any other code is refused with a reason
  if (digits.indexOf(PH_CODE) !== 0) {
    return "Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.";
  }

  const national = digits.slice(PH_CODE.length);
  if (national.length !== PH_NATIONAL_DIGITS) {
    return `A Philippine mobile number is ${PH_NATIONAL_DIGITS} digits after +63 ` +
           `(09XX XXX XXXX). That one has ${national.length}.`;
  }
  if (national[0] !== "9") {
    return "A Philippine mobile number starts with 09 (or +63 9).";
  }
  return null;
}

// "0917 123 4567" -> "+639171234567" (an empty box stays empty: null)
function cleanPhone(value) {
  const digits = phoneDigits(value);
  if (digits === "") {
    return null;
  }
  return "+" + digits;
}

// The whole middle name is stored; the initial is worked out where it is
// shown. Inner runs of spaces are collapsed, and an empty box stays empty.
function cleanMiddleName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");   // "Dela   Cruz" -> "Dela Cruz"
  if (trimmed === "") {
    return null;
  }
  return trimmed.slice(0, 100);
}

// A search matches the start of a field (LIKE 'text%'), the same rule as
// prefixMatch in shared/data-panel.js. % and _ are escaped.
// Example: searchPrefix("50%") -> "50\\%%"  (the user's % is not a wildcard)
function searchPrefix(text) {
  // put a backslash in front of every \ % and _ the user typed
  return String(text).replace(/[\\%_]/g, "\\$&") + "%";
}

// A TIN is nine digits and a branch code, 000-000-000-00000. An older
// three-digit branch code is widened with two zeros; nine digits alone mean
// the head office. All zeros is refused: that is the fresh-install placeholder.
const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

// keeps only the digits of a TIN (at most 14 of them)
function tinDigitsOf(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");   // remove everything that is not a digit
  return text.slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
}

function tinComplaint(value) {
  const digits = tinDigitsOf(value);

  if (digits === "") {
    return "The shop needs a TIN. It is printed on every invoice.";
  }
  if (digits.length !== TIN_BASE_DIGITS &&
      digits.length !== TIN_BASE_DIGITS + 3 &&
      digits.length !== TIN_BASE_DIGITS + TIN_BRANCH_DIGITS) {
    return `A TIN is ${TIN_BASE_DIGITS} digits and a branch code, written ` +
           `000-000-000-00000. That one has ${digits.length} digits.`;
  }
  // the first nine digits are all zeros
  if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
    return "000-000-000 is the placeholder, not a TIN. Enter the number on the " +
           "shop's BIR certificate of registration.";
  }
  return null;
}

// "123456789" -> "123-456-789-00000"
function cleanTin(value) {
  const digits = tinDigitsOf(value);
  const base = digits.slice(0, TIN_BASE_DIGITS);
  const branch = digits.slice(TIN_BASE_DIGITS).padStart(TIN_BRANCH_DIGITS, "0");
  const whole = base + branch;
  return `${whole.slice(0, 3)}-${whole.slice(3, 6)}-${whole.slice(6, 9)}-${whole.slice(9)}`;
}

// ==========================================
// THE AUDIT TRAIL
//
// An entry carries the role the person held at the time (written, not joined,
// so a promotion does not rewrite history), the machine it came from, the kind
// of action, and the values before and after.
// ==========================================

// TRUST_PROXY=1 in .env only behind a reverse proxy you control; otherwise
// any browser can put whatever it likes in X-Forwarded-For. Vercel is such a
// proxy: it replaces the header with the real address, so it is trusted there.
const trustProxySetting = String(process.env.TRUST_PROXY || "").toLowerCase();
const TRUST_PROXY_HEADERS = IS_VERCEL || ["1", "true", "yes", "on"].includes(trustProxySetting);

function clientIp(request) {
  let address = "";

  if (TRUST_PROXY_HEADERS && request.headers["x-forwarded-for"]) {
    address = String(request.headers["x-forwarded-for"]).split(",")[0].trim();
  } else if (request.socket && request.socket.remoteAddress) {
    address = request.socket.remoteAddress;
  }

  // an IPv4 address over an IPv6 socket comes wrapped
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") address = "127.0.0.1";

  return address || null;
}

// the category the audit screen filters on
const AUDIT_TYPES = [
  "CREATE", "UPDATE", "DELETE", "VOID", "RESTORE", "BACKUP",
  "LOGIN", "LOGOUT", "LOGIN_FAILURE", "SECURITY", "PAYMENT",
  "ACCESS", "OTHER"
];

function actionTypeOf(action) {
  const name = String(action || "").toUpperCase();

  if (AUDIT_TYPES.includes(name)) return name;
  // a screen switched on or off for a role
  if (name.startsWith("GRANT_") || name.startsWith("REVOKE_")) return "ACCESS";
  if (name.includes("VOID")) return "VOID";
  if (name.includes("PASSWORD") || name.includes("HELD") || name.includes("RELEASE")) return "SECURITY";
  if (name.includes("RESTORE")) return "RESTORE";
  if (name.includes("BACKUP")) return "BACKUP";
  if (name.includes("PAYMENT") || name.includes("REFUND")) return "PAYMENT";
  if (name.startsWith("CREATE")) return "CREATE";
  if (name.startsWith("UPDATE") || name.startsWith("EDIT") ||
      name.startsWith("ACTIVATE") || name.startsWith("DEACTIVATE") ||
      name.startsWith("RECEIVE") || name.startsWith("RESOLVE")) return "UPDATE";
  if (name.startsWith("DELETE") || name.startsWith("ARCHIVE") ||
      name.startsWith("REMOVE")) return "DELETE";

  return "OTHER";
}

// Takes the request itself, or a plain staff id from the few places that
// write an entry before a session exists.
function auditContext(context) {
  // 1) it is the request itself (it has headers)
  if (context && typeof context === "object" && context.headers) {
    const who = { staffId: null, roleName: null, ip: clientIp(context) };
    if (context.actor) {
      who.staffId = context.actor.staffId;
      who.roleName = context.actor.roleName;
    }
    return who;
  }

  // 2) it is a small object like { staffId, roleName, request }
  if (context && typeof context === "object") {
    const who = { staffId: null, roleName: null, ip: null };
    if (context.staffId !== undefined) who.staffId = context.staffId;
    if (context.roleName !== undefined) who.roleName = context.roleName;
    if (context.request) who.ip = clientIp(context.request);
    return who;
  }

  // 3) it is just a staff id number

  return { staffId: context || null, roleName: null, ip: null };
}

// stored as text so it survives any backup, and capped
function auditMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;

  try {
    const text = JSON.stringify(metadata);
    if (!text) return null;
    if (text.length > 4000) {
      return text.slice(0, 3997) + "...";   // cut very long text short
    }
    return text;
  } catch (error) {
    return null;
  }
}

// only the fields that actually moved
function fieldChanges(before, after) {
  if (!before) return after;

  const changes = {};

  for (const field of Object.keys(after)) {
    let was = before[field];
    let now = after[field];
    if (was === undefined) was = null;
    if (now === undefined) now = null;

    // Compared as text on purpose: the number 5 from the database and
    // the text "5" from a form count as the same value.
    let wasText = "";
    let nowText = "";
    if (was !== null) wasText = String(was);
    if (now !== null) nowText = String(now);

    if (wasText !== nowText) {
      changes[field] = { before: was, after: now };
    }
  }

  if (Object.keys(changes).length === 0) {
    return { unchanged: true };
  }
  return changes;
}

async function writeAuditLog(context, action, details, metadata) {
  const who = auditContext(context);

  try {
    await db.query(
      `INSERT INTO audit_logs
         (staff_id, role_name, ip_address, action, action_type, details, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [who.staffId, who.roleName, who.ip, action, actionTypeOf(action),
       details || null, auditMetadata(metadata)]
    );
  } catch (error) {
    console.error("Audit log failed:", error.message);
  }
}

// ==========================================
// SESSIONS -- an opaque cookie; the server looks the staff id up itself
// ==========================================
// how long a sign-in lasts without signing out; SESSION_HOURS in .env
// reads a positive number from .env, or uses the default when it is missing
function numberSetting(value, defaultValue) {
  if (Number(value) > 0) {
    return Number(value);
  }
  return defaultValue;
}

const SESSION_HOURS = numberSetting(process.env.SESSION_HOURS, 8);

// Wrong passwords in a row before an account is held, and for how long. An
// administrator resetting the password releases it sooner. Both in .env.
const LOGIN_MAX_ATTEMPTS = numberSetting(process.env.LOGIN_MAX_ATTEMPTS, 3);
const LOGIN_HOLD_MINUTES = numberSetting(process.env.LOGIN_HOLD_MINUTES, 15);

// All signed-in users, kept in the user_sessions table rather than in memory:
// on Vercel every request may reach a different copy of this server, and a
// restart no longer signs everybody out. The cookie holds a random token; the
// table holds only its SHA-256, so a copy of the table cannot sign anybody in.
// Times are milliseconds since 1970 (Date.now()), so no time zone touches them.
// A session ended by somebody else (signed in elsewhere, held, deactivated)
// keeps its row for a while with the reason, so the screen left behind is
// told why when it next asks.
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;

// how stale last_seen may get before a request writes it again: one write a
// minute per screen instead of one per request
const SESSION_TOUCH_MS = 30 * 1000;

// how long an ended session's reason is kept for its screen to read
const ENDED_REASON_MS = 24 * 60 * 60 * 1000;

// how often a PC server clears out expired sessions (Vercel: the daily job)
const SESSION_SWEEP_MS = 15 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function startSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await db.query(
    `INSERT INTO user_sessions
       (token_hash, staff_id, user_id, role_id, role_name, email, started_at, last_seen, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tokenHash(token), user.staff_id, user.user_id, user.role_id, user.role_name, user.email,
     now, now, now + SESSION_MS]);
  return token;
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const split = part.indexOf("=");
    if (split === -1) continue;
    if (part.slice(0, split).trim() === name) {
      return decodeURIComponent(part.slice(split + 1).trim());
    }
  }
  return null;
}

// { session } for a live sign-in, { endedReason } for one somebody else
// ended, or {} for no sign-in at all
async function sessionState(request) {
  const token = readCookie(request, "sid");
  if (!token) return {};

  const hash = tokenHash(token);
  const [rows] = await db.query(
    `SELECT staff_id, user_id, role_id, role_name, email, started_at, last_seen,
            expires_at, ended_reason
     FROM user_sessions WHERE token_hash = ?`,
    [hash]);
  const row = rows[0];
  if (!row) return {};

  if (row.ended_reason) return { endedReason: row.ended_reason };

  const now = Date.now();
  if (Number(row.expires_at) < now) {
    await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [hash]);
    return {};
  }

  // sliding window, written at most twice a minute
  let lastSeen = Number(row.last_seen);
  if (now - lastSeen > SESSION_TOUCH_MS) {
    lastSeen = now;
    await db.query(
      "UPDATE user_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [now, now + SESSION_MS, hash]);
  }

  return {
    session: {
      token: token,
      staffId: row.staff_id,
      userId: row.user_id,
      roleId: row.role_id,
      roleName: row.role_name,
      email: row.email,
      startedAt: Number(row.started_at),
      lastSeen: lastSeen,
      expiresAt: Number(row.expires_at)
    }
  };
}

async function currentSession(request) {
  return (await sessionState(request)).session || null;
}

// Presence (at a screen right now) is answered from the session table:
// every request and the live-update check refresh it, and anything quiet
// longer than the window is gone.
const PRESENCE_WINDOW_MS = 2 * 60 * 1000;

async function presenceByStaff() {
  const [rows] = await db.query(
    `SELECT staff_id, MAX(last_seen) AS last_seen FROM user_sessions
     WHERE ended_reason IS NULL AND expires_at > ?
     GROUP BY staff_id`,
    [Date.now()]);

  const seen = new Map();   // staffId -> most recent lastSeen
  for (const row of rows) {
    seen.set(row.staff_id, Number(row.last_seen));
  }
  return seen;
}

async function withPresence(rows) {
  const seen = await presenceByStaff();
  const now = Date.now();

  // copy every row and add two fields: is_online and seconds_idle
  const result = [];
  for (const row of rows) {
    const lastSeen = seen.get(row.staff_id);
    const copy = Object.assign({}, row);

    if (lastSeen === undefined) {
      copy.is_online = false;
      copy.seconds_idle = null;
    } else {
      copy.is_online = now - lastSeen < PRESENCE_WINDOW_MS;
      copy.seconds_idle = Math.max(0, Math.round((now - lastSeen) / 1000));
    }
    result.push(copy);
  }
  return result;
}

async function endSession(request) {
  const token = readCookie(request, "sid");
  if (token) await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash(token)]);
}

// Expired sessions, and ended ones whose reason has been kept long enough.
// Run by the local timer below, and by the daily job on Vercel.
async function removeExpiredSessions() {
  const now = Date.now();
  await db.query(
    "DELETE FROM user_sessions WHERE expires_at < ? OR (ended_reason IS NOT NULL AND ended_at < ?)",
    [now, now - ENDED_REASON_MS]);
}

// One person, one session: a sign-in ends every other session the same
// person holds. The row stays with the reason, and the screen left behind
// reads it on its next request (the live-update check asks every few seconds).
// How many sessions it ended is given back.
async function endSessionsForStaff(staffId, keepToken, reason) {
  const params = [String(reason || "Your session was ended."), Date.now(), Number(staffId), Date.now()];
  let keep = "";
  if (keepToken) {
    keep = " AND token_hash <> ?";
    params.push(tokenHash(keepToken));
  }

  const [result] = await db.query(
    `UPDATE user_sessions SET ended_reason = ?, ended_at = ?
     WHERE staff_id = ? AND ended_reason IS NULL AND expires_at > ?${keep}`,
    params);
  return result.affectedRows;
}

// the signed-in staff id, from the session and never from the request body
function getActorId(request) {
  if (request.actor) {
    return request.actor.staffId;
  }
  return null;
}

// ==========================================
// LIVE SYNC ACROSS DESKTOPS
//
// Every write adds a row to live_changes: its id is the running version
// number, and the row says only "inventory moved". Every signed-in browser
// asks GET /api/events/poll?since=<version> every few seconds and re-reads
// what moved through the normal routes with the normal access checks. Kept
// in the database, not in memory, so it works when every request may reach a
// different copy of this server (Vercel).
// ==========================================
const CHANGE_LOG_SIZE = 500;     // rows kept; a browser further behind reloads

// How often a browser asks, in seconds. Each ask is one request, so on
// Vercel (where requests are counted) it is less often. LIVE_POLL_SECONDS
// in .env overrides both.
const LIVE_POLL_SECONDS = numberSetting(process.env.LIVE_POLL_SECONDS, IS_VERCEL ? 8 : 3);

// Which part of the system a route belongs to; browsers subscribe by scope.
// Example: /^\/api\/(users|roles|staff)/ matches any address that starts
// with /api/users, /api/roles or /api/staff.
function scopeOf(pathname) {
  if (/^\/api\/(users|roles|staff)/.test(pathname)) return "staff";
  if (/^\/api\/(inventory|purchase-orders|stocks|units|materials|suppliers|categories)/.test(pathname)) return "inventory";
  if (/^\/api\/returns/.test(pathname)) return "returns";
  if (/^\/api\/deliveries|^\/api\/delivery/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore|store-settings)/.test(pathname)) return "system";
  if (/^\/api\/archives/.test(pathname)) return "archives";
  if (/^\/api\/notifications/.test(pathname)) return "notifications";
  // a screen switched on or off for a role changes every menu that role has open
  if (/^\/api\/features/.test(pathname)) return "features";
  return null;
}

let changesWritten = 0;

async function recordChange(scope, detail, origin) {
  try {
    const [result] = await db.query(
      "INSERT INTO live_changes (scope, detail, origin, created_at) VALUES (?, ?, ?, ?)",
      [scope, detail ? String(detail).slice(0, 255) : null,
       origin ? String(origin).slice(0, 64) : null, Date.now()]);

    // trimmed now and then rather than on every write
    changesWritten += 1;
    if (changesWritten % 50 === 0) {
      await db.query("DELETE FROM live_changes WHERE change_id <= ?", [result.insertId - CHANGE_LOG_SIZE]);
    }
  } catch (error) {
    console.error("Recording a live change failed:", error.message);
  }
}

// Fire and forget for the caller. On Vercel the instance may be frozen once
// the response is sent, so waitUntil keeps it running until the row is written.
function publishChange(scope, detail, origin) {
  if (!scope) return;
  keepAlive(recordChange(scope, detail, origin));
}

function keepAlive(promise) {
  if (IS_VERCEL) {
    try {
      require("@vercel/functions").waitUntil(promise);
    } catch (error) {
      // the package is missing; the promise still runs, it just may be cut short
    }
  }
  return promise;
}

async function latestChangeVersion() {
  const [rows] = await db.query("SELECT COALESCE(MAX(change_id), 0) AS version FROM live_changes");
  return Number(rows[0].version);
}

// everything since a version; a gap wider than the log means reload
async function changesSince(version) {
  const latest = await latestChangeVersion();
  if (!Number.isInteger(version) || version <= 0 || version >= latest) {
    return { version: latest, changes: [], gap: false };
  }

  const [rows] = await db.query(
    `SELECT change_id, scope, detail, origin, created_at FROM live_changes
     WHERE change_id > ? ORDER BY change_id LIMIT ?`,
    [version, CHANGE_LOG_SIZE]);

  // the oldest row still kept is newer than the one after "version": some were trimmed
  if (rows.length === 0 || Number(rows[0].change_id) > version + 1) {
    const [oldest] = await db.query("SELECT MIN(change_id) AS first FROM live_changes");
    if (oldest[0].first === null || Number(oldest[0].first) > version + 1) {
      return { version: latest, changes: [], gap: true };
    }
  }

  const changes = rows.map((row) => ({
    version: Number(row.change_id),
    scope: row.scope,
    detail: row.detail,
    origin: row.origin,          // so a browser can ignore its own writes
    at: new Date(Number(row.created_at)).toISOString()
  }));
  return { version: latest, changes: changes, gap: false };
}

// ==========================================
// ACCESS CONTROL -- the whole policy in one table. Rules are matched in
// order, first match wins, and anything under /api with no rule is refused.
// ==========================================

const PUBLIC = "public";              // no session needed
const SIGNED_IN = "signed-in";        // any role, just not a stranger

// Each rule is: [ HTTP method, address pattern, who may use it ].
// How to read an address pattern (a "regular expression"):
//   ^  = the start of the address      $  = the end of the address
//   \/ = a "/" character               \d+ = one or more digits (an id)
//   [^/]+ = any text without a "/"     [a-z0-9-]+ = lowercase letters, digits or "-"
// So /^\/api\/users\/\d+$/ means exactly "/api/users/<some number>".
const ACCESS_RULES = [
  // --- authentication ---
  ["POST",  /^\/api\/login$/,                          PUBLIC],
  // the daily job (Vercel Cron); the route checks CRON_SECRET itself
  ["GET",   /^\/api\/cron\/daily$/,                    PUBLIC],
  // "Forgot your password?": a code by email, then the code and a new password.
  // Nobody is signed in yet, so both are open; the routes ration the codes.
  ["POST",  /^\/api\/password-reset\/request$/,         PUBLIC],
  ["POST",  /^\/api\/password-reset\/confirm$/,         PUBLIC],
  ["POST",  /^\/api\/logout$/,                         SIGNED_IN],
  ["POST",  /^\/api\/change-password$/,                SIGNED_IN],
  ["POST",  /^\/api\/heartbeat$/,                      SIGNED_IN],
  ["GET",   /^\/api\/events\/poll$/,                    SIGNED_IN],
  ["GET",   /^\/api\/events\/status$/,                  SIGNED_IN],

  // --- your own account, any role ---
  ["GET",   /^\/api\/me$/,                             SIGNED_IN],
  ["GET",   /^\/api\/me\/access$/,                      SIGNED_IN],
  ["PUT",   /^\/api\/me$/,                             SIGNED_IN],
  ["POST",  /^\/api\/me\/password$/,                   SIGNED_IN],

  // --- staff accounts, administrator only ---
  ["GET",   /^\/api\/roles$/,                          [ADMIN]],
  ["GET",   /^\/api\/users$/,                          [ADMIN]],
  ["GET",   /^\/api\/users\/email-check$/,              [ADMIN]],
  ["GET",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  // the review step creates nothing but does make a readable password
  ["POST",  /^\/api\/users\/draft$/,                    [ADMIN]],
  ["POST",  /^\/api\/users$/,                          [ADMIN]],
  ["PUT",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["PATCH", /^\/api\/users\/\d+\/status$/,             [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account\/draft$/,      [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account$/,            [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/reset-password$/,     [ADMIN]],

  ["GET",   /^\/api\/audit-logs$/,                     [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/types$/,              [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/export\/(xlsx|pdf)$/,  [ADMIN]],

  // --- which screens each role holds ---
  ["GET",   /^\/api\/me\/features$/,                    SIGNED_IN],
  ["GET",   /^\/api\/features$/,                        [ADMIN]],
  ["PUT",   /^\/api\/features\/[a-z0-9-]+\/roles\/\d+$/, [ADMIN]],

  // --- backup and recovery, administrator only ---
  ["GET",    /^\/api\/backups$/,                       [ADMIN]],
  ["POST",   /^\/api\/backups$/,                       [ADMIN]],
  ["PUT",    /^\/api\/backups\/auto$/,                 [ADMIN]],
  ["GET",    /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["DELETE", /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["POST",   /^\/api\/backups\/[^/]+\/restore$/,       [ADMIN]],
  ["POST",   /^\/api\/restore$/,                       [ADMIN]],

  // --- manager reporting ---
  ["GET",   /^\/api\/manager\/summary$/,               [MANAGER]],
  ["GET",   /^\/api\/reports\/overview$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/activity$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/income$/,                [MANAGER]],
  ["GET",   /^\/api\/stocks$/,                         [MANAGER]],
  ["PUT",   /^\/api\/stocks\/\d+\/reorder-policy$/,    [MANAGER]],
  // the selling price is the manager's to set; the clerk counts, the manager prices
  ["PUT",   /^\/api\/stocks\/\d+\/price$/,             [MANAGER]],

  // exporting is the line between the reporting roles; a hidden button is still a URL
  ["POST",  /^\/api\/reports\/spreadsheet$/,          [MANAGER]],
  ["GET",   /^\/api\/reports\/export$/,                [MANAGER]],
  ["GET",   /^\/api\/reports\/daily-tally$/,           [MANAGER, CLERK, CASHIER, DRIVER]],

  // --- selling ---
  ["POST",  /^\/api\/sales$/,                          [CASHIER]],
  ["GET",   /^\/api\/sales\/undelivered$/,             [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales$/,                          [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales\/\d+$/,                     [CASHIER, MANAGER]],
  ["POST",  /^\/api\/sales\/\d+\/payment$/,            [CASHIER, MANAGER]],
  ["GET",   /^\/api\/cashier\/summary$/,               [CASHIER]],

  // --- GCash or Maya paid by QR code (Connections/qr-payments.js): wherever
  // money is taken, a sale or a balance. A cashier's list is their own. ---
  ["POST",  /^\/api\/qr-payments$/,                    [CASHIER, MANAGER]],
  ["GET",   /^\/api\/qr-payments$/,                    [CASHIER, MANAGER]],
  ["GET",   /^\/api\/qr-payments\/\d+$/,               [CASHIER, MANAGER]],
  ["POST",  /^\/api\/qr-payments\/\d+\/cancel$/,       [CASHIER, MANAGER]],
  // PayMongo itself, with no session; its signature is the permission
  ["POST",  /^\/api\/paymongo\/webhook$/,              PUBLIC],

  // --- deliveries ---
  ["POST",  /^\/api\/deliveries$/,                     [CASHIER, MANAGER]],
  ["GET",   /^\/api\/deliveries$/,                     [CASHIER, MANAGER, DRIVER]],
  ["GET",   /^\/api\/deliveries\/drivers$/,            [CASHIER, MANAGER]],
  ["GET",   /^\/api\/deliveries\/\d+\/items$/,         [CASHIER, MANAGER, DRIVER, CLERK]],
  ["PATCH", /^\/api\/deliveries\/\d+\/status$/,        [DRIVER, MANAGER]],
  ["GET",   /^\/api\/delivery\/list$/,                 [DRIVER]],
  ["GET",   /^\/api\/delivery\/summary$/,              [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/claim$/,           [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/payment$/,         [DRIVER]],

  // --- inventory ---
  ["GET",   /^\/api\/inventory\/summary$/,             [CLERK, MANAGER]],
  ["GET",   /^\/api\/inventory\/products$/,            [CLERK, CASHIER, MANAGER]],
  // the sizes a material also sells in: the clerk keeps them, the till reads them
  ["GET",   /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK, CASHIER, MANAGER]],
  ["POST",  /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK]],
  ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/, [CLERK]],
  // how a material is delivered (a box of 20 kilogram); the clerk keeps it
  ["PUT",   /^\/api\/inventory\/products\/\d+\/pack$/,        [CLERK]],
  ["GET",   /^\/api\/inventory\/adjustments$/,         [CLERK]],
  ["POST",  /^\/api\/inventory\/adjust$/,              [CLERK]],
  ["PUT",   /^\/api\/inventory\/reorder\/\d+$/,        [CLERK]],

  // suppliers, categories and units are the manager's to add and correct
  ["POST",  /^\/api\/suppliers$/,                     [MANAGER]],
  ["POST",  /^\/api\/categories$/,                    [MANAGER]],
  ["POST",  /^\/api\/units$/,                         [MANAGER]],
  ["PUT",   /^\/api\/units\/\d+$/,                     [MANAGER]],

  // purchase orders: the clerk raises one and, once the manager has confirmed
  // it, counts the delivery in; the manager only confirms or declines
  ["GET",   /^\/api\/purchase-orders$/,                [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/items$/,    [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/document$/, [CLERK, MANAGER]],
  ["POST",  /^\/api\/purchase-orders$/,                [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/decide$/,   [MANAGER]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/receive$/,  [CLERK]],
  // once approved, the clerk prints the order and may email it to the supplier
  ["POST",  /^\/api\/purchase-orders\/\d+\/send$/,     [CLERK]],
  // the supplier, who has no account, opens the order from the link or QR code
  // on the printed order; the code (43 url-safe characters) is the whole of the permission
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}$/,          PUBLIC],
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/pdf$/,     PUBLIC],
  ["POST",  /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/respond$/, PUBLIC],

  // opening a record for a material the shop has never stocked
  ["POST",  /^\/api\/materials$/,                      [CLERK]],

  // --- returns, damage and refunds ---
  ["GET",   /^\/api\/returns$/,                        [CLERK, CASHIER]],
  ["POST",  /^\/api\/returns$/,                        [CLERK, CASHIER]],
  ["POST",  /^\/api\/returns\/\d+\/resolve$/,          [CLERK]],

  // --- credit management ---
  // reading is a counter action; changing a limit is a manager action
  ["GET",   /^\/api\/credit\/customers$/,              [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/customers\/\d+$/,         [MANAGER, CASHIER]],
  // every sale still carrying a balance, for taking payments at the counter
  ["GET",   /^\/api\/credit\/open-sales$/,             [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/customers\/\d+\/limit$/,  [MANAGER]],
  // the late-payment policy: everyone on the credit book reads it, the manager sets it
  ["GET",   /^\/api\/credit\/policy$/,                 [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/policy$/,                 [MANAGER]],
  ["GET",   /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests\/\d+\/decide$/,  [MANAGER]],
  ["GET",   /^\/api\/customers\/\d+\/history$/,        [MANAGER, CASHIER]],

  // opening an account is a counter action; giving it a limit is not
  ["POST",  /^\/api\/customers$/,                      [MANAGER, CASHIER]],

  // --- shared lookups and archives ---
  ["GET",   /^\/api\/records\/\w+$/,                   [MANAGER, CASHIER, CLERK]],
  ["GET",   /^\/api\/archives$/,                       MANAGEMENT],
  ["POST",  /^\/api\/archives\/archive$/,              [CLERK, ADMIN, MANAGER]],
  ["POST",  /^\/api\/archives\/restore$/,              [CLERK, ADMIN, MANAGER]],

  // --- who the shop is, and how it is registered ---
  // every dashboard prints an invoice, so reading is open; changing is the administrator's
  ["GET",   /^\/api\/store-settings$/,                 SIGNED_IN],
  ["PUT",   /^\/api\/store-settings$/,                 [ADMIN]],

  // --- notifications ---
  ["GET",   /^\/api\/notifications$/,                  SIGNED_IN],
  ["POST",  /^\/api\/notifications\/\d+\/read$/,       SIGNED_IN],
  ["POST",  /^\/api\/notifications\/read-all$/,        SIGNED_IN]
];

// POSTs that touch no table, so the write hook below does not announce them.
const CHANGES_NOTHING = [
  /^\/api\/users\/draft$/,
  /^\/api\/users\/\d+\/account\/draft$/
];

// Every /api request is checked against the table above. Routes that destroy
// or replace data carry requireRole as well, so a loosened rule in the table
// still meets a no in the route.
//
// Use it like this:  app.delete("/api/x", requireRole(ADMIN), handler)
// or with a list:    requireRole([ADMIN, MANAGER])
// It gives back a small "middleware" function that Express runs first.
function requireRole(roles) {
  // accept one role name or a list of role names
  let allowed = roles;
  if (!Array.isArray(roles)) {
    allowed = [roles];
  }

  return function (request, response, next) {
    if (!request.actor || !allowed.includes(request.actor.roleName)) {
      let who = "visitor";
      if (request.actor) {
        who = request.actor.roleName;
      }
      return response.status(403).json({ error: `A ${who} cannot use this feature.` });
    }
    next();   // allowed: go on to the real route
  };
}

// An administrator does not edit their own record: rename, re-role,
// deactivate and reset are refused for the signed-in person. A second
// administrator makes those changes and is on the trail for them. The
// password stays in their own hands through My Account.
function notOwnAccount(request, response, next) {
  if (request.actor && Number(request.params.staffId) === Number(request.actor.staffId)) {
    return response.status(403).json({
      error: "You cannot change your own account from here. " +
             "Ask another administrator to make this change."
    });
  }
  next();
}

// ==========================================
// SCREENS BY ROLE
//
// Every entry is one screen: the roles whose page can draw it, the roles that
// hold it by role, and the routes it is made of. The administrator grants or
// revokes a screen per role; an override is one row in role_feature_permissions.
//
// Enforcement in the access hook:
//   revoked  a route is refused when every screen using it is off for the role
//   granted  a route the role table would refuse is allowed when the role
//            holds a screen needing it BY GRANT (not by default)
// Read from the database and cached in memory between writes.
// ==========================================
const FEATURES = [
  // --- selling and the counter ---
  { key: "pos", name: "New Transaction", module: "Point of Sale",
    description: "The register: ring a sale up, take the payment, book the delivery.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["POST", /^\/api\/sales$/], ["POST", /^\/api\/deliveries$/], ["POST", /^\/api\/customers$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "refunds", name: "Refunds", module: "Point of Sale",
    description: "Take a sold item back and refund it at the counter; the stockroom inspects it before it can be sold again.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/]] },
  { key: "sales-report", name: "Sales Report", module: "Point of Sale",
    description: "The cashier's own sales, by day and by method.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "qr-payments", name: "QR Payments", module: "Point of Sale",
    description: "Every GCash and Maya payment tried by QR code and how it ended; the cashier sees their own, the manager everyone's.",
    available: [CASHIER, MANAGER], defaults: [CASHIER, MANAGER],
    routes: [["GET", /^\/api\/qr-payments$/]] },
  { key: "daily-summary", name: "Daily Summary", module: "Point of Sale",
    description: "What the till took today.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/cashier\/summary$/]] },

  // --- credit ---
  { key: "credit", name: "Customer Credit", module: "Credit",
    description: "Every credit account and its standing; the cashier's copy files extension requests, the manager's decides limits.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/customers$/], ["GET", /^\/api\/credit\/customers\/\d+$/],
             ["PUT", /^\/api\/credit\/customers\/\d+\/limit$/], ["GET", /^\/api\/customers\/\d+\/history$/],
             ["GET", /^\/api\/credit\/policy$/], ["PUT", /^\/api\/credit\/policy$/],
             ["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests$/]] },
  { key: "debt-payments", name: "Debt Payments", module: "Credit",
    description: "Take a payment against what a customer still owes, sale by sale, from the customer's card.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/credit\/open-sales$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "credit-requests", name: "Extension Requests", module: "Credit",
    description: "The queue of credit-limit requests waiting for a decision.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests\/\d+\/decide$/]] },

  // --- the manager's reporting ---
  { key: "income", name: "Income", module: "Reports",
    description: "Collected, billed, outstanding and discounts over any period.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/reports\/income$/]] },
  { key: "reports", name: "Reports", module: "Reports",
    description: "Everything staff have filed, plus payment methods, receivables, repeat customers and staff performance.",
    available: [MANAGER], defaults: [MANAGER],
    // the day's tally is the manager's side of the cashier's end-of-shift card
    routes: [["GET", /^\/api\/reports\/activity$/], ["GET", /^\/api\/reports\/overview$/],
             ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "sales", name: "Sales", module: "Reports",
    description: "Every sale rung up, with its lines and its payments.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },

  // --- stock ---
  { key: "material-list", name: "Material List", module: "Inventory",
    description: "Everything on the shelf, with what is in stock, the sizes each material sells in, and the pack it is delivered in.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/summary$/],
             ["POST", /^\/api\/inventory\/products\/\d+\/units$/],
             ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/],
             ["PUT", /^\/api\/inventory\/products\/\d+\/pack$/]] },
  { key: "stock-adjustment", name: "Stock Adjustment", module: "Inventory",
    description: "Correct a stock figure by hand, and open a record for a material the shop has never stocked.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/inventory\/adjust$/], ["POST", /^\/api\/materials$/]] },
  { key: "adjustment-history", name: "Adjustment History", module: "Inventory",
    description: "Every correction made, by whom and why.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/adjustments$/]] },
  { key: "reorder-points", name: "Reorder Point", module: "Inventory",
    description: "Where each material's reorder point sits, and the formula behind it.",
    available: [CLERK], defaults: [CLERK],
    routes: [["PUT", /^\/api\/inventory\/reorder\/\d+$/]] },
  { key: "reorder-alerts", name: "Reorder Alerts", module: "Inventory",
    description: "The materials at or under their reorder point today.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/reorder-policy$/]] },
  { key: "stock-reports", name: "Stocks Overview", module: "Inventory",
    description: "The whole inventory to read, sort and print, and where a product's selling price is set.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/price$/]] },
  { key: "returns", name: "Returned Items", module: "Inventory",
    description: "Returns and damage reports: inspecting what the counter took back, and putting it back on the shelf or writing it off.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/], ["POST", /^\/api\/returns\/\d+\/resolve$/]] },
  { key: "damage-report", name: "Make a Report", module: "Inventory",
    description: "Report damaged goods and take them off the shelf.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/returns$/]] },
  { key: "purchase-orders", name: "Purchase Orders", module: "Inventory",
    description: "Orders to suppliers: the clerk raises one, the manager confirms it and counts the delivery in.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/],
             ["GET", /^\/api\/purchase-orders\/\d+\/document$/], ["POST", /^\/api\/purchase-orders$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/decide$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/receive$/]] },

  // --- deliveries ---
  { key: "deliveries", name: "Delivery Tracking", module: "Deliveries",
    description: "Every delivery booked and where it has got to; the manager's copy can move one along.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/]] },
  { key: "delivery-runs", name: "Delivery Runs", module: "Deliveries",
    description: "The driver's own round: pending, out for delivery, and cash to collect.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/list$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/],
             ["POST", /^\/api\/delivery\/\d+\/claim$/],
             ["POST", /^\/api\/delivery\/\d+\/payment$/]] },
  { key: "delivery-reports", name: "Delivery Reports", module: "Deliveries",
    description: "The driver's deliveries and collections over a period.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/summary$/]] },
  // drawn by script (shared/delivery-schedule.js), so every page can draw it
  { key: "delivery-schedule", name: "Delivery Schedule", module: "Deliveries",
    description: "Deliveries still to go out, by the day they are due: overdue, today, tomorrow, later.",
    available: [MANAGER, CASHIER, CLERK, DRIVER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/]] },

  // --- records ---
  { key: "records", name: "Records", module: "Records",
    description: "Suppliers, customers, products, categories and units.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [] },
  { key: "archives", name: "Archives", module: "Records",
    description: "What has been put away, and restoring it.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/archives$/], ["POST", /^\/api\/archives\/archive$/], ["POST", /^\/api\/archives\/restore$/]] }
];

const FEATURE_ROLES = [MANAGER, CLERK, CASHIER, DRIVER];   // the matrix's columns

// "available" is the list of dashboards that have a menu entry for the screen.
// Access Control only offers a switch where flipping it shows or hides
// something: a screen granted to a role whose page cannot draw it would save
// and then appear nowhere.

// finds a screen by its key, e.g. findFeature("pos"); null when there is none
function findFeature(key) {
  const wanted = String(key || "").toLowerCase();
  for (const feature of FEATURES) {
    if (feature.key === wanted) {
      return feature;
    }
  }
  return null;
}

// every screen that uses this route (method + address)
function featuresCovering(method, pathname) {
  const found = [];
  for (const feature of FEATURES) {
    for (const route of feature.routes) {
      const routeMethod = route[0];
      const routePattern = route[1];
      if (routeMethod === method && routePattern.test(pathname)) {
        found.push(feature);
        break;   // this feature is counted once; go to the next feature
      }
    }
  }
  return found;
}

// the overrides, cached between writes:
// role name -> Map(feature key -> { granted, note, grantedBy, grantedAt, updatedAt })
// On Vercel a write on one copy of the server cannot clear another copy's
// cache, so there it is only trusted for a few seconds.
let featureOverrides = null;
let featureOverridesAt = 0;
const FEATURE_CACHE_MS = IS_VERCEL ? 10 * 1000 : Infinity;

async function loadFeatureOverrides() {
  if (featureOverrides && Date.now() - featureOverridesAt < FEATURE_CACHE_MS) return featureOverrides;

  const byRole = new Map();
  try {
    const [rows] = await db.query(
      `SELECT r.role_name, p.feature_key, p.is_granted, p.note,
              p.granted_at, p.updated_at, gb.full_name AS granted_by
       FROM role_feature_permissions p
       JOIN roles r ON r.role_id = p.role_id
       LEFT JOIN staff gb ON gb.staff_id = p.granted_by_staff_id`);

    for (const row of rows) {
      if (!byRole.has(row.role_name)) byRole.set(row.role_name, new Map());
      byRole.get(row.role_name).set(row.feature_key, {
        granted: Boolean(row.is_granted),
        note: row.note,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        updatedAt: row.updated_at
      });
    }
  } catch (error) {
    // the table may not exist yet; then there are simply no overrides
  }

  featureOverrides = byRole;
  featureOverridesAt = Date.now();
  return byRole;
}

function forgetFeatureOverrides() {
  featureOverrides = null;
}

// what one role holds: the defaults with the overrides applied
async function featuresOf(roleName) {
  const allOverrides = await loadFeatureOverrides();
  const overrides = allOverrides.get(roleName) || new Map();

  const result = [];
  for (const feature of FEATURES) {
    if (!feature.available.includes(roleName) && roleName !== ADMIN) {
      continue;   // this role can never have this screen
    }

    // does the role have this screen when nobody has changed anything?
    const byDefault = roleName === ADMIN || feature.defaults.includes(roleName);

    // has the administrator switched it on or off for this role?
    const override = overrides.get(feature.key) || null;

    const item = {
      key: feature.key,
      name: feature.name,
      module: feature.module,
      held: byDefault,
      byDefault: byDefault,
      overridden: false,
      note: null,
      grantedBy: null,
      updatedAt: null
    };

    if (override) {
      item.held = override.granted;
      item.overridden = override.granted !== byDefault;
      item.note = override.note;
      item.grantedBy = override.grantedBy;
      item.updatedAt = override.updatedAt || override.grantedAt;
    }

    result.push(item);
  }
  return result;
}

// everything held, and the part held by grant rather than by role
async function heldFeatures(roleName) {
  const held = new Set();
  const granted = new Set();
  for (const feature of await featuresOf(roleName)) {
    if (!feature.held) continue;
    held.add(feature.key);
    if (!feature.byDefault) granted.add(feature.key);
  }
  return { held, granted };
}

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

// the same rule, for the administrator's own profile screen
function notOwnDetailsIfAdmin(request, response, next) {
  if (request.actor && request.actor.roleName === ADMIN) {
    return response.status(403).json({
      error: "A System Administrator's details are changed by another administrator, " +
             "not from this screen. Your password is still yours to change."
    });
  }
  next();
}

// finds who may use a route; null means no rule (so it is refused)
function findRule(method, pathname) {
  for (const rule of ACCESS_RULES) {
    const ruleMethod = rule[0];
    const pattern = rule[1];
    const allowed = rule[2];
    if (ruleMethod === method && pattern.test(pathname)) {
      return allowed;
    }
  }
  return null;
}

app.use(async (request, response, next) => {
  if (!request.path.startsWith("/api/")) return next();

  const allowed = findRule(request.method, request.path);

  if (allowed === null) {
    return response.status(403).json({ error: "This feature is not available." });
  }

  // With no procedures, reads still work and writes cannot: writes are stopped
  // here with the sentence that names the fix. Sign-in is exempt.
  const isWrite = request.method !== "GET" && request.method !== "HEAD";
  const isSignIn = request.path === "/api/login" || request.path === "/api/logout" ||
                   request.path === "/api/heartbeat" ||
                   request.path.startsWith("/api/password-reset/");

  if (isWrite && !isSignIn && (await proceduresAreMissing())) {
    console.error(`Refused ${request.method} ${request.path}: ` +
      `${proceduresLoaded} of ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
    return response.status(503).json({ error: procedureAdvice() });
  }

  if (allowed === PUBLIC) return next();

  const state = await sessionState(request);
  const session = state.session;
  if (!session) {
    // signedOut tells the screen to go back to sign-in, with the reason when
    // somebody else ended this session (signed in elsewhere, held, deactivated)
    return response.status(401).json({
      error: state.endedReason || "Your session has ended. Please sign in again.",
      signedOut: true,
      ended: Boolean(state.endedReason)
    });
  }

  const byRole = allowed === SIGNED_IN || allowed.includes(session.roleName);

  // Screens by role: a route is refused once every screen using it is off for
  // this role, and allowed past the role table when held by grant. The
  // administrator is never narrowed.
  let covering = [];
  if (session.roleName !== ADMIN) {
    covering = featuresCovering(request.method, request.path);
  }
  if (covering.length > 0) {
    let held;
    try {
      held = await heldFeatures(session.roleName);
    } catch (error) {
      held = { held: new Set(), granted: new Set() };
    }

    // the screens using this route that the role still has switched on
    const stillHeld = [];
    for (const feature of covering) {
      if (held.held.has(feature.key)) {
        stillHeld.push(feature);
      }
    }
    if (stillHeld.length === 0) {
      return response.status(403).json({
        error: `${covering[0].name} has been switched off for ${session.roleName} accounts. ` +
               "The System Administrator turns screens on and off under Access Control."
      });
    }

    // was one of those screens given to the role by the administrator?
    let givenByGrant = false;
    for (const feature of stillHeld) {
      if (held.granted.has(feature.key)) {
        givenByGrant = true;
      }
    }

    if (!byRole && !givenByGrant) {
      return response.status(403).json({
        error: `A ${session.roleName} cannot use this feature.`
      });
    }
  } else if (!byRole) {
    return response.status(403).json({
      error: `A ${session.roleName} cannot use this feature.`
    });
  }

  request.actor = session;

  // Every write passes through here, so this is where a change is announced
  // from, only when it succeeded. The change is written just before the
  // answer goes out, so it is safe in the database even if the server is
  // frozen the moment the answer is sent (Vercel), and the screen that made
  // the write never sees an older version than its own change.
  let changesNothing = false;
  for (const pattern of CHANGES_NOTHING) {
    if (pattern.test(request.path)) {
      changesNothing = true;
    }
  }

  const scope = scopeOf(request.path);
  if (request.method !== "GET" && request.method !== "HEAD" && !changesNothing && scope) {
    const sendAnswer = response.end;
    response.end = function (...args) {
      response.end = sendAnswer;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendAnswer.apply(response, args);
      }
      recordChange(scope, `${request.method} ${request.path}`, request.headers["x-client-id"] || null)
        .finally(() => sendAnswer.apply(response, args));
      return response;
    };
  }

  next();
});

// Who the shop is and how it is registered. Above the 3,000,000 threshold a
// shop is VAT-registered with 12% inside its prices; below it charges no VAT.
const DEFAULT_STORE_SETTINGS = {
  store_name: "Lucelyn Hardware",
  proprietor: null,
  address: "Set your address in System Administration",
  tin: "000-000-000-00000",
  registration_type: "VAT",
  vat_rate: "12.00",
  invoice_note: null,
  penalty_rate: "3.00",
  bank_name: null,
  bank_account_name: null,
  bank_account_number: null,
  receipt_layout: null
};

// What the receipt looks like until the administrator changes it in Receipt
// Maintenance. Written into store_settings.receipt_layout by the migration,
// so the till and the preview read it from the database like everything else.
const DEFAULT_RECEIPT_LAYOUT = {
  paperWidth: 80,
  fontSize: 12,
  title: "Sales Invoice",
  paidLabel: "PAID IN FULL",
  headerLines: [],
  footerLines: ["Thank you for your purchase"],
  show: {
    proprietor: true, cashier: true, customer: true, payment: true, reference: true,
    item_count: true, tax: true, bank: true, note: true
  }
};

// The stored layout, checked and filled in from the defaults. Text that is not
// a layout (or a database from before the column) gives the defaults back.
function receiptLayoutFrom(raw) {
  let stored = raw;
  if (typeof raw === "string") {
    try {
      stored = JSON.parse(raw);
    } catch (error) {
      stored = null;
    }
  }
  if (!stored || typeof stored !== "object") stored = {};

  const lines = (value, fallback) => {
    if (!Array.isArray(value)) return fallback.slice();
    return value
      .map((line) => String(line === null || line === undefined ? "" : line).trim().replace(/\s+/g, " ").slice(0, 80))
      .filter((line) => line !== "")
      .slice(0, 10);
  };
  const text = (value, fallback, max) => {
    const cleaned = String(value === null || value === undefined ? "" : value).trim().replace(/\s+/g, " ").slice(0, max);
    return cleaned === "" ? fallback : cleaned;
  };

  const show = {};
  for (const key of Object.keys(DEFAULT_RECEIPT_LAYOUT.show)) {
    const wanted = stored.show && stored.show[key];
    show[key] = typeof wanted === "boolean" ? wanted : DEFAULT_RECEIPT_LAYOUT.show[key];
  }

  return {
    paperWidth: [58, 80].includes(Number(stored.paperWidth)) ? Number(stored.paperWidth) : DEFAULT_RECEIPT_LAYOUT.paperWidth,
    fontSize: [11, 12, 13].includes(Number(stored.fontSize)) ? Number(stored.fontSize) : DEFAULT_RECEIPT_LAYOUT.fontSize,
    title: text(stored.title, DEFAULT_RECEIPT_LAYOUT.title, 40),
    paidLabel: text(stored.paidLabel, DEFAULT_RECEIPT_LAYOUT.paidLabel, 40),
    headerLines: lines(stored.headerLines, DEFAULT_RECEIPT_LAYOUT.headerLines),
    footerLines: lines(stored.footerLines, DEFAULT_RECEIPT_LAYOUT.footerLines),
    show: show
  };
}

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
// AUTH -- in Connections/login.js: sign in, sign out, heartbeat, first-sign-in password
// ==========================================
registerLoginRoutes(app, {
  db, writeAuditLog,
  hashPassword, isHashed, verifyPassword,
  SESSION_HOURS, startSession, endSession, endSessionsForStaff,
  signOutAfterPasswordChange, clientIp, DEFAULT_STORE_SETTINGS,
  LOGIN_MAX_ATTEMPTS, LOGIN_HOLD_MINUTES
});

// ==========================================
// THE LIVE CHANNEL
//
// Every signed-in browser asks here every few seconds what changed since the
// version it last saw. The first ask (no "since") only learns the version.
// The access check ahead of it has already refreshed the session, so asking
// also marks the person present. A browser further behind than the log is
// told so (gap) and offered a reload.
// ==========================================
app.get("/api/events/poll", async (request, response) => {
  const since = parseInt(request.query.since, 10);

  try {
    const result = await changesSince(since);
    response.set("Cache-Control", "no-store");
    response.json({
      version: result.version,
      changes: result.changes,
      gap: result.gap,
      pollMs: LIVE_POLL_SECONDS * 1000
    });
  } catch (error) {
    console.error("Reading live changes failed:", error.message);
    response.status(500).json({ error: "Unable to read what changed" });
  }
});

app.get("/api/events/status", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS connections, COUNT(DISTINCT staff_id) AS people
       FROM user_sessions
       WHERE ended_reason IS NULL AND expires_at > ? AND last_seen > ?`,
      [Date.now(), Date.now() - PRESENCE_WINDOW_MS]);
    const [logged] = await db.query("SELECT COUNT(*) AS total FROM live_changes");

    response.json({
      version: await latestChangeVersion(),
      // screens that asked within the presence window
      connections: Number(rows[0].connections),
      people: Number(rows[0].people),
      logged: Number(logged[0].total),
      pollSeconds: LIVE_POLL_SECONDS
    });
  } catch (error) {
    console.error("Reading the live status failed:", error.message);
    response.status(500).json({ error: "Unable to read the live status" });
  }
});


// A changed password ends every session, this one included: the old password
// may be known to somebody else, and signing in with the new one straight
// away is what proves it was typed right.
const PASSWORD_CHANGED =
  "Your password was changed. Sign in again with the new one.";

async function signOutAfterPasswordChange(request, response) {
  await endSessionsForStaff(request.actor.staffId, null, PASSWORD_CHANGED);
  response.clearCookie("sid", { path: "/" });
}

// ==========================================
// YOUR OWN ACCOUNT -- always the signed-in account; the role is not editable here
// ==========================================
// What the signed-in person is, for the screens to shape themselves around.
// A convenience for the page and never a permission.
app.get("/api/me/access", (request, response) => {
  const actor = request.actor;

  response.json({
    staffId: actor.staffId,
    roleName: actor.roleName,
    page: ROLE_PAGES[actor.roleName] || "/Login.html",
    isAdmin: actor.roleName === ADMIN,
    isManagement: MANAGEMENT.includes(actor.roleName),
    canEditOwnDetails: actor.roleName !== ADMIN,
    canChangeOwnPassword: actor.roleName === ADMIN,
    canEditOwnEmail: false
  });
});

// What this person's menu holds. A convenience
// for the page; the access hook reads the same table for itself.
app.get("/api/me/features", async (request, response) => {
  try {
    const features = await featuresOf(request.actor.roleName);

    // the keys of the screens this person has switched on
    const heldKeys = [];
    for (const feature of features) {
      if (feature.held) {
        heldKeys.push(feature.key);
      }
    }

    response.json({
      roleName: request.actor.roleName,
      features: features,
      held: heldKeys
    });
  } catch (error) {
    console.error("Reading a role's screens failed:", error.message);
    response.status(500).json({ error: "Unable to read which screens you hold" });
  }
});

// A credential (the sign-in email, the password, the role) is not changed by
// its own holder from here: a standard user edits name and phone only. A new
// password comes from "Forgot your password?" on the sign-in page, from a
// manager (counter, stockroom and delivery staff), or from the administrator.
// The administrator keeps the right to change their own password.
function notOwnCredentials(request, response, next) {
  if (request.actor && request.actor.roleName !== ADMIN) {
    return response.status(403).json({
      error: "Your password is not changed from this screen. Sign out and use " +
             "\"Forgot your password?\" on the sign-in page for a code sent to your " +
             "email, or ask a manager or the System Administrator to reset it."
    });
  }
  next();
}

app.get("/api/me", async (request, response) => {
  try {
    const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [request.actor.staffId]);

    if (rows.length === 0) {
      return response.status(404).json({ error: "Your staff record was not found." });
    }

    response.json(rows[0]);
  } catch (error) {
    console.error("Profile read failed:", error.message);
    response.status(500).json({ error: "Unable to load your account details" });
  }
});

app.put("/api/me", notOwnDetailsIfAdmin, async (request, response) => {
  const { firstName, middleName, lastName, phone, email } = request.body;
  const actor = request.actor;

  if (!firstName || !lastName) {
    return response.status(400).json({ error: "First name and last name are required" });
  }

  // the email is a credential (see notOwnCredentials); refused rather than dropped
  if (email !== undefined && email !== null && String(email).trim() !== "" &&
      String(email).trim().toLowerCase() !== String(actor.email || "").toLowerCase()) {
    return response.status(403).json({
      error: "Your sign-in email is changed by the System Administrator from the staff directory."
    });
  }

  const phoneProblem = phoneComplaint(phone);
  if (phoneProblem) return response.status(400).json({ error: phoneProblem });

  try {
    // the role and the email are the ones on file, never from the browser
    const output = await callProcedure(
      "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [actor.staffId, String(firstName).trim(), cleanMiddleName(middleName),
       String(lastName).trim(), cleanPhone(phone),
       actor.roleId, actor.email || null],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(request, "UPDATE_OWN_PROFILE", `${actor.email} updated their own details`);

    const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [actor.staffId]);
    response.json({ message: "Your details were saved.", user: rows[0] });
  } catch (error) {
    console.error("Profile update failed:", error.message);
    response.status(500).json({ error: "Unable to save your details" });
  }
});

app.post("/api/me/password", notOwnCredentials, async (request, response) => {
  const { currentPassword, newPassword } = request.body;
  const actor = request.actor;

  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "The new password must contain at least 8 characters" });
  }

  if (typeof currentPassword !== "string" || currentPassword === "") {
    return response.status(400).json({ error: "Enter your current password" });
  }

  // the old password typed in the new box from habit is refused before the
  // database is asked
  if (newPassword === currentPassword) {
    return response.status(400).json({ error: "The new password must be different from your current password" });
  }

  try {
    const [rows] = await db.query("SELECT password FROM users WHERE staff_id = ?", [actor.staffId]);

    if (rows.length === 0) {
      return response.status(404).json({ error: "This account has no login yet." });
    }

    if (!(await verifyPassword(currentPassword, rows[0].password))) {
      return response.status(403).json({ error: "That is not your current password" });
    }

    await db.query(
      "UPDATE users SET password = ?, must_change_password = FALSE WHERE staff_id = ?",
      [await hashPassword(newPassword), actor.staffId]
    );

    await writeAuditLog(request, "CHANGE_OWN_PASSWORD",
      `${actor.email} changed their own password; every session on the old one was ended`);

    await signOutAfterPasswordChange(request, response);
    response.json({ message: "Your password was changed.", signedOut: true });
  } catch (error) {
    console.error("Own password change failed:", error.message);
    response.status(500).json({ error: "Unable to change your password" });
  }
});

// ==========================================
// SYSTEM ADMINISTRATION -- in Connections/admin.js: staff accounts, the audit trail,
// backup and recovery, screens by role, store settings
// ==========================================
// Each route file gets "app" plus an object with the helpers it needs.
// { db, callProcedure } is short for { db: db, callProcedure: callProcedure }.
const adminModule = registerAdminRoutes(app, {
  db, callProcedure, getActorId, writeAuditLog, fieldChanges, searchPrefix,
  requireRole, publishChange, ADMIN, USER_SELECT, withPresence, notOwnAccount,
  endSessionsForStaff, hashPassword, generatePassword, phoneComplaint, cleanPhone, cleanMiddleName,
  tinComplaint, cleanTin, DEFAULT_STORE_SETTINGS, AUDIT_TYPES, DB_NAME, sqlValue,
  sqlName, EXPECTED_PROCEDURES, countProcedures, SERVER_TABLES, IS_VERCEL, proceduresAreMissing, proceduresLoadedCount, forgetProcedureCount,
  FEATURES, FEATURE_ROLES, findFeature, featuresOf, forgetFeatureOverrides, receiptLayoutFrom
});

// true for a date written like "2026-09-24" (4 digits - 2 digits - 2 digits)
function isDateText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

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

// ==========================================
// MANAGER MODULE -- in Connections/manager.js: the reports, the dashboard summary, credit
// management, and stocks with the reorder point and the selling price.
// Registered here, after SALE_CUSTOMER_SQL, because the deps are read eagerly.
// ==========================================
const managerModule = registerManagerRoutes(app, {
  db, callProcedure, getActorId, writeAuditLog, fieldChanges, searchPrefix,
  requireRole, MANAGER, LOW_STOCK_EFFECTIVE_SQL, isDateText, SALE_CUSTOMER_SQL,
  proceduresAreMissing, publishChange,
  CLERK, CASHIER, DRIVER, cleanPhone, phoneComplaint
});

// ==========================================
// QR PAYMENTS -- in Connections/qr-payments.js: the QR code for a GCash or
// Maya payment, through PayMongo or the offline simulation (PAYMENT_PROVIDER
// in .env), and the record of every attempt. Registered before the cashier,
// who asks it again before a sale or a payment is recorded against one.
// ==========================================
const qrPayments = registerQrPaymentRoutes(app, {
  db, callProcedure, getActorId, publishChange, isDateText, CASHIER, port
});

// ==========================================
// CASHIER MODULE -- in Connections/cashier.js: the sales list, ringing up a sale, booking
// and moving a delivery, the end-of-shift summary, payments on a sale
// ==========================================
registerCashierRoutes(app, {
  db, callProcedure, getActorId, DRIVER, isDateText, SALE_CUSTOMER_SQL,
  phoneComplaint, cleanPhone, qrPayments
});

// ==========================================
// DELIVERY PERSONNEL MODULE -- in Connections/delivery.js: the deliveries list, a driver's
// runs, cash collected at the door, the driver's summary
// ==========================================
registerDeliveryRoutes(app, {
  db, callProcedure, getActorId, isDateText, DELIVERY_CONTACT_SQL, DELIVERY_PHONE_SQL
});

// ==========================================
// INVENTORY MODULE -- in Connections/inventory-clerk.js: the clerk's summary and material list,
// selling units, stock adjustments, reorder points, purchase orders, returns
// and damage reports, and the notifications every role reads
// ==========================================
registerInventoryRoutes(app, {
  db, callProcedure, getActorId, writeAuditLog, fieldChanges, DEFAULT_STORE_SETTINGS, CASHIER,
  phoneComplaint, cleanPhone, publishChange
});

// RECORDS: one route, five record types
const RECORD_QUERIES = {
  supplier: `SELECT sup.supplier_id AS id, sup.supplier_name AS name, sup.contact_person,
                    sup.contact_number, sup.email, sup.address,
                    COUNT(p.product_id) AS product_count
             FROM suppliers sup
             LEFT JOIN products p ON p.supplier_id = sup.supplier_id AND p.is_archived = FALSE
             GROUP BY sup.supplier_id, sup.supplier_name, sup.contact_person,
                      sup.contact_number, sup.email, sup.address
             ORDER BY sup.supplier_name`,
  customer: `SELECT c.customer_id AS id, TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS name,
                    c.first_name, c.last_name, c.phone, c.address, c.created_at,
                    COALESCE(v.credit_limit, 0) AS credit_limit,
                    COALESCE(v.total_purchase, 0) AS total_purchase,
                    COALESCE(v.current_credit, 0) AS current_credit,
                    COUNT(s.sale_id) AS purchase_count
             FROM customers c
             LEFT JOIN vw_customer_credit v ON v.customer_id = c.customer_id
             LEFT JOIN sales s ON s.customer_id = c.customer_id AND s.is_archived = FALSE
             GROUP BY c.customer_id, c.first_name, c.last_name, c.phone, c.address, c.created_at,
                      v.credit_limit, v.total_purchase, v.current_credit
             ORDER BY c.first_name`,
  product: `SELECT p.product_id AS id, p.product_name AS name, p.price, p.reorder_point, p.status,
                   b.brand_name, c.category_name, u.unit_name, sup.supplier_name,
                   COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock, p.created_at
            FROM products p
            LEFT JOIN brands b ON b.brand_id = p.brand_id
            LEFT JOIN categories c ON c.category_id = p.category_id
            LEFT JOIN units u ON u.unit_id = p.unit_id
            LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
            LEFT JOIN inventory i ON i.product_id = p.product_id
            WHERE p.is_archived = FALSE ORDER BY p.product_name`,
  category: `SELECT c.category_id AS id, c.category_name AS name,
                    COUNT(p.product_id) AS product_count,
                    COALESCE(SUM(i.quantity_in_stock), 0) AS total_stock
             FROM categories c
             LEFT JOIN products p ON p.category_id = c.category_id AND p.is_archived = FALSE
             LEFT JOIN inventory i ON i.product_id = p.product_id
             GROUP BY c.category_id, c.category_name ORDER BY c.category_name`,
  brand: `SELECT b.brand_id AS id, b.brand_name AS name,
                 COUNT(p.product_id) AS product_count
          FROM brands b
          LEFT JOIN products p ON p.brand_id = b.brand_id AND p.is_archived = FALSE
          GROUP BY b.brand_id, b.brand_name ORDER BY b.brand_name`,
  unit: `SELECT u.unit_id AS id, u.unit_name AS name,
                COUNT(p.product_id) AS product_count
         FROM units u
         LEFT JOIN products p ON p.unit_id = u.unit_id AND p.is_archived = FALSE
         GROUP BY u.unit_id, u.unit_name ORDER BY u.unit_name`
};

app.get("/api/records/:type", async (request, response) => {
  const sql = RECORD_QUERIES[request.params.type];

  if (!sql) {
    return response.status(400).json({ error: "Unknown record type" });
  }

  try {
    const [rows] = await db.query(sql);
    response.json(rows);
  } catch (error) {
    console.error("Records failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// ARCHIVES
app.get("/api/archives", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT module, record_id, record_name, detail, archived_at,
              COALESCE(archived_by, 'System') AS archived_by
       FROM vw_archives
       ORDER BY archived_at DESC, module`
    );
    response.json(rows);
  } catch (error) {
    console.error("Archives failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/archives/restore", async (request, response) => {
  const { module, recordId } = request.body;

  if (!module || !recordId) {
    return response.status(400).json({ error: "Module and record id are required" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_restore_archive(?, ?, ?, @status_code, @message)",
      [module, recordId, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Restore failed:", error.message);
    response.status(500).json({ error: "Unable to restore the record" });
  }
});

app.post("/api/archives/archive", async (request, response) => {
  const { module, recordId } = request.body;

  if (!module || !recordId) {
    return response.status(400).json({ error: "Module and record id are required" });
  }

  // who may ask; the procedure holds the rules for each kind
  const whoMayArchive = {
    Inventory: [CLERK, ADMIN, MANAGER],
    Sales: MANAGEMENT,
    Delivery: MANAGEMENT,
    Staff: [ADMIN]
  };
  const allowed = whoMayArchive[module];
  if (!allowed || !allowed.includes(request.actor.roleName)) {
    return response.status(403).json({ error: `Your role cannot archive ${module} records.` });
  }

  try {
    const output = await callProcedure(
      "CALL sp_archive_record(?, ?, ?, @status_code, @message)",
      [module, recordId, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Archive failed:", error.message);
    response.status(500).json({ error: "Unable to archive the record" });
  }
});

// ==========================================
// START
// ==========================================
// ==========================================
// THE DAILY JOB -- on Vercel, where no timer runs between requests.
// vercel.json calls it once a day; Vercel sends "Authorization: Bearer
// <CRON_SECRET>", and without that secret nobody else can start it. On a PC
// the same work runs on the timers started above.
// ==========================================
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

app.get("/api/cron/daily", async (request, response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return response.status(503).json({ error: "CRON_SECRET is not set, so the daily job is switched off." });
  }
  if (!sameSecret(request.headers.authorization || "", `Bearer ${secret}`)) {
    return response.status(401).json({ error: "Not allowed" });
  }

  // each step on its own, so one failing does not stop the rest
  const steps = {
    penalties: () => managerModule.runPenaltySweep(),
    archives: () => adminModule.runArchiveSweep(),
    backup: () => adminModule.runDailyBackup(),
    sessions: () => removeExpiredSessions(),
    housekeeping: () => adminModule.removeExpiredDrafts()
  };
  const report = {};
  for (const name of Object.keys(steps)) {
    try {
      await steps[name]();
      report[name] = "ok";
    } catch (error) {
      console.error(`Daily job, ${name}:`, error.message);
      report[name] = "failed: " + error.message;
    }
  }
  console.log("Daily job:", JSON.stringify(report));
  response.json(report);
});

// npm start runs this file and it listens on the port; on Vercel,
// api/index.js loads it and Vercel hands it the requests.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    for (const line of qrPayments.describe()) console.log(line);
  });
} else if (IS_VERCEL) {
  for (const line of qrPayments.describe()) console.log(line);
}

module.exports = app;