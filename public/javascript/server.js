const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { escape: sqlValue, escapeId: sqlName } = require("mysql2");
const { isMailConfigured, sendMail, firstPasswordMessage } = require("./mailer");

const app = express();

// ==========================================
// SETUP - edit these five lines on a new computer
// DB_PASSWORD must match the MySQL root password on THIS machine.
// ==========================================
const DB_HOST = "localhost";
const DB_USER = "root";
const DB_PASSWORD = "Password";
const DB_NAME = "hardware_db";
// the tests start a second copy beside a running one (HARDWARE_PORT=3005 npm start)
const port = Number(process.env.HARDWARE_PORT) || 3000;

const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // DECIMAL columns arrive as numbers: 37.500 kg reads as 37.5
  decimalNumbers: true
});

// ==========================================
// PASSWORDS -- stored as scrypt hashes, format scrypt$<salt>$<hash>
// ==========================================
const scrypt = require("util").promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(plainText) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

// The first password is made by the server and mailed, never typed by an
// administrator. The alphabet leaves out characters that depend on the font
// (O/0, I/l/1, B/8, S/5, Z/2) and punctuation that moves between keyboard
// layouts. 55 characters over 14 places is about 81 bits.
const PASSWORD_ALPHABET =
  "ACDEFGHJKLMNPQRTUVWXY" +     // no B, I, O, S, Z
  "acdefghjkmnpqrtuvwxy" +      // no b, i, l, o, s, z
  "34679" +                     // no 0, 1, 2, 5, 8
  "!?-+.$%";
const PASSWORD_LENGTH = 14;

function generatePassword() {
  // randomInt is uniform; a modulo over a random byte is not
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }

  // every rule this system checks a password against, met by construction
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password)) {
    return generatePassword();
  }
  return password;
}

async function verifyPassword(plainText, stored) {
  // a row that was never hashed holds the password itself; the caller hashes it
  if (!isHashed(stored)) {
    return typeof stored === "string" && stored.length > 0 && stored === plainText;
  }

  const [, salt, expected] = stored.split("$");
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const expectedBytes = Buffer.from(expected, "hex");

  if (expectedBytes.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBytes);   // constant time
}

// One-time upgrade for a database created before hashing existed. Runs on
// every start and does nothing once every row is hashed.
async function hashLegacyPasswords() {
  const [rows] = await db.query("SELECT user_id, password FROM users");
  const plain = rows.filter((row) => !isHashed(row.password));

  if (plain.length === 0) return;

  for (const row of plain) {
    await db.query("UPDATE users SET password = ? WHERE user_id = ?",
      [await hashPassword(row.password), row.user_id]);
  }
  console.log(`Hashed ${plain.length} password(s) that were stored as readable text.`);
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

// One-time upgrade: every staff phone rewritten to +63 and ten digits.
// Anything that does not reduce to a usable number is emptied.
async function migratePhoneNumbers() {
  const [rows] = await db.query(
    "SELECT staff_id, phone FROM staff WHERE phone IS NOT NULL AND phone <> ''");

  const wrong = rows.filter((row) => row.phone !== cleanPhone(row.phone));
  if (wrong.length === 0) return;

  let emptied = 0;

  for (const row of wrong) {
    const fixed = phoneComplaint(row.phone) === null ? cleanPhone(row.phone) : null;
    if (fixed === null) emptied += 1;

    await db.query("UPDATE staff SET phone = ? WHERE staff_id = ?", [fixed, row.staff_id]);
  }

  console.log(`Rewrote ${wrong.length} staff phone number(s) to +63 form.` +
    (emptied > 0
      ? ` ${emptied} of them was not a usable number and was cleared; re-enter it on the staff record.`
      : ""));
}

// ==========================================
// One-time upgrades, each a no-op on a database that already has it:
//   - the access control tables (register of connected systems, who may
//     reach them, ACCESS and CONTROL audit types, seeded internal systems)
//   - quantity columns widened to take a fraction (nails by the kilo);
//     sale_items.subtotal is generated from quantity so it is dropped,
//     widened and put back
// The procedures they need come from file 2, which the console says to
// re-run when they are missing.
// ==========================================
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
  for (const [table, column, rest] of columns) {
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
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('connected_systems', 'system_permissions', 'role_feature_permissions')`,
    [DB_NAME]
  );
  const have = tables.map((row) => row.TABLE_NAME);
  let created = 0;

  if (!have.includes("connected_systems")) {
    await db.query(
      `CREATE TABLE connected_systems (
         system_id INT AUTO_INCREMENT PRIMARY KEY,
         system_key VARCHAR(40) NOT NULL UNIQUE,
         system_name VARCHAR(100) NOT NULL,
         system_kind ENUM('Internal','External') NOT NULL DEFAULT 'External',
         description VARCHAR(255) NULL,
         endpoint_url VARCHAR(255) NULL,
         is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
         created_by_staff_id INT NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         FOREIGN KEY (created_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE
       )`);
    created += 1;
  }

  if (!have.includes("system_permissions")) {
    await db.query(
      `CREATE TABLE system_permissions (
         permission_id INT AUTO_INCREMENT PRIMARY KEY,
         staff_id INT NOT NULL,
         system_id INT NOT NULL,
         can_monitor BOOLEAN NOT NULL DEFAULT FALSE,
         can_manage BOOLEAN NOT NULL DEFAULT FALSE,
         can_control BOOLEAN NOT NULL DEFAULT FALSE,
         note VARCHAR(255) NULL,
         granted_by_staff_id INT NULL,
         granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_system_permission (staff_id, system_id),
         FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE CASCADE ON UPDATE CASCADE,
         FOREIGN KEY (system_id) REFERENCES connected_systems(system_id) ON DELETE CASCADE ON UPDATE CASCADE,
         FOREIGN KEY (granted_by_staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL ON UPDATE CASCADE,
         CONSTRAINT chk_permission_grants_something CHECK (can_monitor OR can_manage OR can_control)
       )`);
    created += 1;
  }

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
  if (typeColumn[0] && !/'CONTROL'/i.test(typeColumn[0].COLUMN_TYPE)) {
    await db.query(
      `ALTER TABLE audit_logs MODIFY action_type
         ENUM('CREATE','UPDATE','DELETE','VOID','RESTORE','BACKUP',
              'LOGIN','LOGOUT','LOGIN_FAILURE','SECURITY','PAYMENT',
              'ACCESS','CONTROL','OTHER') NOT NULL DEFAULT 'OTHER'`);
    widened = true;
  }

  // internal systems added if missing; renamed or switched-off rows are left alone
  let seeded = 0;
  for (const [key, system] of Object.entries(INTERNAL_SYSTEMS)) {
    const [result] = await db.query(
      `INSERT IGNORE INTO connected_systems (system_key, system_name, system_kind, description)
       VALUES (?, ?, 'Internal', ?)`,
      [key, system.name, system.description]);
    seeded += result.affectedRows;
  }

  if (created > 0 || widened || seeded > 0) {
    console.log(`Added the access control tables (${created} created, ${seeded} internal ` +
      `system(s) registered${widened ? ", audit types widened" : ""}).` +
      (proceduresLoaded !== null && proceduresLoaded < EXPECTED_PROCEDURES
        ? " Re-run public/database/2-RUN-SECOND-stored-procedures.sql so the two procedures they need exist."
        : ""));
  }
}

// a named figure so adding a procedure changes one number, not two
const EXPECTED_PROCEDURES = 30;

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

function procedureAdvice() {
  return `This database has ${proceduresLoaded} of ${EXPECTED_PROCEDURES} stored ` +
    "procedures, so nothing can be saved. Run " +
    "public/database/2-RUN-SECOND-stored-procedures.sql in MySQL Workbench or " +
    "the mysql command line. It touches no table and no row, and can be re-run " +
    "at any time. Nothing else is wrong: your data is intact.";
}

db.getConnection()
  .then(async (connection) => {
    connection.release();
    console.log(`Connected to MySQL database "${DB_NAME}" on ${DB_HOST}.`);

    const total = await countProcedures();

    if (total < EXPECTED_PROCEDURES) {
      // loud on purpose: a one-line warning scrolled away unread
      console.warn("");
      console.warn("  ###############################################################");
      console.warn(`  #  ONLY ${String(total).padEnd(2)} OF ${EXPECTED_PROCEDURES} STORED PROCEDURES ARE LOADED.`.padEnd(63) + "#");
      console.warn("  #  NOTHING CAN BE SAVED UNTIL THEY ARE.".padEnd(63) + "#");
      console.warn("  #".padEnd(63) + "#");
      console.warn("  #  Run this, then reload the page -- no restart needed:".padEnd(63) + "#");
      console.warn("  #    public/database/2-RUN-SECOND-stored-procedures.sql".padEnd(63) + "#");
      console.warn("  #".padEnd(63) + "#");
      console.warn("  #  It touches no table and no row. Your data is intact.".padEnd(63) + "#");
      console.warn("  ###############################################################");
      console.warn("");
    } else {
      console.log(`All ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
    }

    await migrateMiddleNameColumn();
    await migratePhoneNumbers();
    await migrateAccessControlTables();
    await migrateMeasuredQuantities();
    await hashLegacyPasswords();

    // last, so the first backup is not taken of a schema about to change
    startAutoBackup();
    startArchiveSweep();
  })
  .catch((error) => {
    console.error("DATABASE CONNECTION FAILED:", error.message);
    console.error("Check DB_USER and DB_PASSWORD at the top of server.js,");
    console.error("and make sure you ran the two files in public/database/, in the order their names give.");
  });

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

// Everything under public/ is served except the server's own source and the
// SQL files, which carry the database password and the schema. mailer.js
// names the mail account and mail-password.txt holds its password.
const PRIVATE_FILES = [
  /^\/javascript\/(server|mailer)\.js$/i,
  /^\/javascript\/mail-password\.txt$/i,
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
  pathname = pathname.replace(/\\/g, "/").replace(/\/{2,}/g, "/");

  pathname = path.posix.normalize(pathname);
  return pathname.startsWith("/") ? pathname : "/" + pathname;
}

app.use((request, response, next) => {
  const pathname = resolvedPath(request.path);

  if (pathname === null) {
    return response.status(400).send("Bad request");
  }

  if (PRIVATE_FILES.some((pattern) => pattern.test(pathname))) {
    return response.status(404).send("Not found");
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
  "/manager-dashboard.html":   [MANAGER],
  "/inventory-dashboard.html": [CLERK],
  "/cashier-dashboard.html":   [CASHIER],
  "/delivery.html":            [DRIVER]
};

const ROLE_PAGES = {
  [ADMIN]:   "/system.html",
  [MANAGER]: "/manager-dashboard.html",
  [CLERK]:   "/inventory-dashboard.html",
  [CASHIER]: "/cashier-dashboard.html",
  [DRIVER]:  "/delivery.html"
};

app.use((request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const pathname = resolvedPath(request.path);
  if (pathname === null) return next();

  // matched regardless of case, as the file server on Windows will
  const page = Object.keys(PAGE_ROLES).find((name) => name.toLowerCase() === pathname.toLowerCase());
  const changePassword = pathname.toLowerCase() === "/change-password.html";
  if (!page && !changePassword) return next();

  const session = currentSession(request);
  if (!session) return response.redirect("/Login.html");

  if (changePassword) return next();

  if (!PAGE_ROLES[page].includes(session.roleName)) {
    return response.redirect(ROLE_PAGES[session.roleName] || "/Login.html");
  }

  next();
});

app.use(express.static(path.join(__dirname, "..")));

// ==========================================
// HELPERS
// ==========================================

// runs a stored procedure and reads its OUT values on the same connection
async function callProcedure(sql, params, outputNames) {
  const connection = await db.getConnection();
  try {
    await connection.query(sql, params);

    // the alias is quoted because some OUT parameters are named after reserved
    // words ("lines")
    const selectList = outputNames.map((name) => `@${name} AS ${sqlName(name)}`).join(", ");
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

function phoneDigitsAll(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\D/g, "")
    .replace(/^0+/, PH_CODE)
    .replace(new RegExp("^" + PH_CODE + "0+"), PH_CODE);
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

function cleanPhone(value) {
  const digits = phoneDigits(value);
  return digits === "" ? null : "+" + digits;
}

// The whole middle name is stored; the initial is worked out where it is
// shown. Inner runs of spaces are collapsed, and an empty box stays empty.
function cleanMiddleName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : trimmed.slice(0, 100);
}

// A search matches the start of a field (LIKE 'text%'), the same rule as
// prefixMatch in shared/data-panel.js. % and _ are escaped.
function searchPrefix(text) {
  return String(text).replace(/[\\%_]/g, "\\$&") + "%";
}

// A TIN is nine digits and a branch code, 000-000-000-00000. An older
// three-digit branch code is widened with two zeros; nine digits alone mean
// the head office. All zeros is refused: that is the fresh-install placeholder.
const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

function tinDigitsOf(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\D/g, "")
    .slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
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
  if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
    return "000-000-000 is the placeholder, not a TIN. Enter the number on the " +
           "shop's BIR certificate of registration.";
  }
  return null;
}

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

// Set to true only behind a reverse proxy you control; otherwise any browser
// can put whatever it likes in X-Forwarded-For.
const TRUST_PROXY_HEADERS = false;

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
  "ACCESS", "CONTROL", "OTHER"
];

function actionTypeOf(action) {
  const name = String(action || "").toUpperCase();

  if (AUDIT_TYPES.includes(name)) return name;
  // the connected systems: keys handed out or taken back, and commands run with them
  if (name.startsWith("GRANT_") || name.startsWith("REVOKE_") ||
      name.startsWith("SYSTEM_ACCESS")) return "ACCESS";
  if (name.startsWith("SYSTEM_")) return "CONTROL";
  if (name.includes("VOID")) return "VOID";
  if (name.includes("PASSWORD")) return "SECURITY";
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
  if (context && typeof context === "object" && context.headers) {
    const actor = context.actor || null;
    return {
      staffId: actor ? actor.staffId : null,
      roleName: actor ? actor.roleName : null,
      ip: clientIp(context)
    };
  }

  if (context && typeof context === "object") {
    return {
      staffId: context.staffId === undefined ? null : context.staffId,
      roleName: context.roleName === undefined ? null : context.roleName,
      ip: context.request ? clientIp(context.request) : null
    };
  }

  return { staffId: context || null, roleName: null, ip: null };
}

// stored as text so it survives any backup, and capped
function auditMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;

  try {
    const text = JSON.stringify(metadata);
    if (!text) return null;
    return text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  } catch (error) {
    return null;
  }
}

// only the fields that actually moved
function fieldChanges(before, after) {
  if (!before) return after;

  const changes = {};

  for (const field of Object.keys(after)) {
    const was = before[field] === undefined ? null : before[field];
    const now = after[field] === undefined ? null : after[field];

    // loose on purpose: a number from the database and the same number from a form are equal
    if (String(was === null ? "" : was) !== String(now === null ? "" : now)) {
      changes[field] = { before: was, after: now };
    }
  }

  return Object.keys(changes).length === 0 ? { unchanged: true } : changes;
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
const SESSION_HOURS = 8;
const sessions = new Map();   // token -> { staffId, userId, roleId, roleName, email, expiresAt }

function startSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    staffId: user.staff_id,
    userId: user.user_id,
    roleId: user.role_id,
    roleName: user.role_name,
    email: user.email,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    expiresAt: Date.now() + SESSION_HOURS * 60 * 60 * 1000
  });
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

function currentSession(request) {
  const token = readCookie(request, "sid");
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;   // sliding window
  session.lastSeen = Date.now();
  return session;
}

// Presence (at a screen right now) is answered from the session store:
// every request and the heartbeat refresh it, and anything quiet longer
// than the window is gone. Memory only on purpose.
const PRESENCE_WINDOW_MS = 2 * 60 * 1000;

function presenceByStaff() {
  const now = Date.now();
  const seen = new Map();   // staffId -> most recent lastSeen

  for (const session of sessions.values()) {
    if (session.expiresAt < now) continue;

    const previous = seen.get(session.staffId);
    if (previous === undefined || session.lastSeen > previous) {
      seen.set(session.staffId, session.lastSeen);
    }
  }

  // a browser holding the live channel open is a page somebody has in front of them
  for (const client of liveClients) {
    seen.set(client.staffId, now);
  }

  return seen;
}

function withPresence(rows) {
  const seen = presenceByStaff();
  const now = Date.now();

  return rows.map((row) => {
    const lastSeen = seen.get(row.staff_id);
    return Object.assign({}, row, {
      is_online: lastSeen !== undefined && now - lastSeen < PRESENCE_WINDOW_MS,
      seconds_idle: lastSeen === undefined ? null : Math.round((now - lastSeen) / 1000)
    });
  });
}

function endSession(request) {
  const token = readCookie(request, "sid");
  if (token) sessions.delete(token);
}

// Expired sessions were only dropped when their own browser came back, so
// they are swept on a timer. unref() so the timer does not keep the process alive.
const SESSION_SWEEP_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}, SESSION_SWEEP_MS).unref();

// One person, one session: a sign-in ends every other session the same
// person holds, and the screen left behind is told over the live channel.
function endSessionsForStaff(staffId, keepToken, reason) {
  const id = Number(staffId);

  for (const [token, session] of sessions) {
    if (session.staffId !== id) continue;
    if (keepToken && token === keepToken) continue;
    sessions.delete(token);
  }

  for (const client of [...liveClients]) {
    if (client.staffId !== id) continue;
    if (keepToken && client.token === keepToken) continue;

    try {
      client.response.write(`event: evicted\ndata: ${JSON.stringify({
        reason: reason || "Your session was ended."
      })}\n\n`);
      client.response.end();
    } catch (error) {
    }
    liveClients.delete(client);
  }
}

// the signed-in staff id, from the session and never from the request body
function getActorId(request) {
  return request.actor ? request.actor.staffId : null;
}

// ==========================================
// LIVE SYNC ACROSS DESKTOPS
//
// A running version number and a short log of what changed; every signed-in
// browser holds one SSE connection to hear about it. What travels is only
// "inventory moved, version 412"; the browser re-reads through the normal
// routes with the normal access checks.
// ==========================================
let changeVersion = 0;
const changeLog = [];          // the last few changes, for a client that reconnects
const CHANGE_LOG_SIZE = 200;
const liveClients = new Set(); // { id, staffId, roleName, response }

// which part of the system a route belongs to; browsers subscribe by scope
function scopeOf(pathname) {
  if (/^\/api\/(users|roles)/.test(pathname)) return "staff";
  if (/^\/api\/(inventory|purchase-orders|stocks|units|materials)/.test(pathname)) return "inventory";
  if (/^\/api\/returns/.test(pathname)) return "returns";
  if (/^\/api\/deliveries|^\/api\/delivery/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore|store-settings)/.test(pathname)) return "system";
  if (/^\/api\/archives/.test(pathname)) return "archives";
  if (/^\/api\/notifications/.test(pathname)) return "notifications";
  // a grant changes what somebody's menu offers
  if (/^\/api\/access/.test(pathname)) return "access";
  // a screen switched on or off for a role changes every menu that role has open
  if (/^\/api\/features/.test(pathname)) return "features";
  if (/^\/api\/systems/.test(pathname)) return "systems";
  return null;
}

function publishChange(scope, detail, origin) {
  if (!scope) return;

  changeVersion += 1;

  const change = {
    version: changeVersion,
    scope: scope,
    detail: detail || null,
    origin: origin || null,          // so a browser can ignore its own writes
    at: new Date().toISOString()
  };

  changeLog.push(change);
  if (changeLog.length > CHANGE_LOG_SIZE) changeLog.shift();

  const frame = `id: ${change.version}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;

  for (const client of liveClients) {
    try {
      client.response.write(frame);
    } catch (error) {
      // a browser that has gone away is removed by its own close handler
    }
  }
}

// everything since a version; a gap wider than the log means reload
function changesSince(version) {
  if (!Number.isInteger(version) || version <= 0) return { changes: [], gap: false };
  if (changeLog.length === 0) return { changes: [], gap: false };
  if (version < changeLog[0].version - 1) return { changes: [], gap: true };
  return { changes: changeLog.filter((c) => c.version > version), gap: false };
}

// ==========================================
// ACCESS CONTROL -- the whole policy in one table. Rules are matched in
// order, first match wins, and anything under /api with no rule is refused.
// ==========================================

const PUBLIC = "public";              // no session needed
const SIGNED_IN = "signed-in";        // any role, just not a stranger

const ACCESS_RULES = [
  // --- authentication ---
  ["POST",  /^\/api\/login$/,                          PUBLIC],
  ["POST",  /^\/api\/logout$/,                         SIGNED_IN],
  ["POST",  /^\/api\/change-password$/,                SIGNED_IN],
  ["POST",  /^\/api\/heartbeat$/,                      SIGNED_IN],
  ["GET",   /^\/api\/events$/,                         SIGNED_IN],
  ["GET",   /^\/api\/events\/status$/,                  SIGNED_IN],

  // --- your own account, any role ---
  ["GET",   /^\/api\/me$/,                             SIGNED_IN],
  ["GET",   /^\/api\/me\/access$/,                      SIGNED_IN],
  ["PUT",   /^\/api\/me$/,                             SIGNED_IN],
  ["POST",  /^\/api\/me\/password$/,                   SIGNED_IN],

  // --- staff accounts, administrator only ---
  ["GET",   /^\/api\/roles$/,                          [ADMIN]],
  ["GET",   /^\/api\/users$/,                          [ADMIN]],
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

  // --- who may reach the connected systems: administrator only ---
  ["GET",   /^\/api\/access\/permissions$/,            [ADMIN]],
  ["GET",   /^\/api\/access\/users\/\d+$/,             [ADMIN]],
  ["PUT",   /^\/api\/access\/users\/\d+\/systems\/[a-z0-9-]+$/, [ADMIN]],

  // --- which screens each role holds ---
  ["GET",   /^\/api\/me\/features$/,                    SIGNED_IN],
  ["GET",   /^\/api\/me\/counts$/,                      SIGNED_IN],
  ["GET",   /^\/api\/features$/,                        [ADMIN]],
  ["PUT",   /^\/api\/features\/[a-z0-9-]+\/roles\/\d+$/, [ADMIN]],

  // --- the connected systems themselves: a permission, not a role ---
  // each route below carries requireSystemAccess with the level it needs
  ["GET",   /^\/api\/systems$/,                        SIGNED_IN],
  ["POST",  /^\/api\/systems$/,                        [ADMIN]],
  ["GET",   /^\/api\/systems\/[a-z0-9-]+\/status$/,    SIGNED_IN],
  ["PUT",   /^\/api\/systems\/[a-z0-9-]+$/,            SIGNED_IN],
  ["POST",  /^\/api\/systems\/[a-z0-9-]+\/actions\/[a-z0-9-]+$/, SIGNED_IN],

  // --- backup and recovery, administrator only ---
  ["GET",    /^\/api\/backups$/,                       [ADMIN]],
  ["POST",   /^\/api\/backups$/,                       [ADMIN]],
  ["GET",    /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["DELETE", /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["POST",   /^\/api\/backups\/[^/]+\/restore$/,       [ADMIN]],
  ["POST",   /^\/api\/restore$/,                       [ADMIN]],

  // --- manager reporting ---
  ["GET",   /^\/api\/manager\/summary$/,               [MANAGER]],
  ["GET",   /^\/api\/reports\/overview$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/income$/,                [MANAGER]],
  ["GET",   /^\/api\/stocks$/,                         [MANAGER]],
  ["PUT",   /^\/api\/stocks\/\d+\/reorder-policy$/,    [MANAGER]],

  // exporting is the line between the reporting roles; a hidden button is still a URL
  ["GET",   /^\/api\/reports\/export$/,                [MANAGER]],
  ["GET",   /^\/api\/reports\/daily-tally$/,           [MANAGER, ...STAFF]],

  // --- selling ---
  ["POST",  /^\/api\/sales$/,                          [CASHIER]],
  ["GET",   /^\/api\/sales\/undelivered$/,             [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales$/,                          [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales\/\d+$/,                     [CASHIER, MANAGER]],
  ["POST",  /^\/api\/sales\/\d+\/payment$/,            [CASHIER, MANAGER]],
  ["GET",   /^\/api\/cashier\/summary$/,               [CASHIER]],

  // --- deliveries ---
  ["POST",  /^\/api\/deliveries$/,                     [CASHIER, MANAGER]],
  ["GET",   /^\/api\/deliveries$/,                     [CASHIER, MANAGER, DRIVER]],
  ["PATCH", /^\/api\/deliveries\/\d+\/status$/,        [DRIVER, MANAGER]],
  ["GET",   /^\/api\/delivery\/list$/,                 [DRIVER]],
  ["GET",   /^\/api\/delivery\/summary$/,              [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/payment$/,         [DRIVER]],

  // --- inventory ---
  ["GET",   /^\/api\/inventory\/summary$/,             [CLERK, MANAGER]],
  ["GET",   /^\/api\/inventory\/products$/,            [CLERK, CASHIER, MANAGER]],
  ["GET",   /^\/api\/inventory\/adjustments$/,         [CLERK]],
  ["POST",  /^\/api\/inventory\/adjust$/,              [CLERK]],
  ["PUT",   /^\/api\/inventory\/reorder\/\d+$/,        [CLERK]],

  // the clerk who can create a unit by typing it can correct it
  ["PUT",   /^\/api\/units\/\d+$/,                     [CLERK, MANAGER]],

  // purchase orders belong to the manager; the clerk reads them
  ["GET",   /^\/api\/purchase-orders$/,                [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/items$/,    [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/document$/, [CLERK, MANAGER]],
  ["POST",  /^\/api\/purchase-orders$/,                [MANAGER]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/receive$/,  [MANAGER]],

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
  ["PUT",   /^\/api\/credit\/customers\/\d+\/limit$/,  [MANAGER]],
  ["GET",   /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests\/\d+\/decide$/,  [MANAGER]],
  ["GET",   /^\/api\/customers\/\d+\/history$/,        [MANAGER, CASHIER]],

  // opening an account is a counter action; giving it a limit is not
  ["POST",  /^\/api\/customers$/,                      [MANAGER, CASHIER]],

  // --- shared lookups and archives ---
  ["GET",   /^\/api\/records\/\w+$/,                   [MANAGER, CASHIER, CLERK]],
  ["GET",   /^\/api\/archives$/,                       MANAGEMENT],
  ["POST",  /^\/api\/archives\/archive$/,              [CLERK, ...MANAGEMENT]],
  ["POST",  /^\/api\/archives\/restore$/,              [CLERK, ...MANAGEMENT]],

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
function requireRole(...roles) {
  const allowed = roles.flat();
  return (request, response, next) => {
    if (!request.actor || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({
        error: `A ${request.actor ? request.actor.roleName : "visitor"} cannot use this feature.`
      });
    }
    next();
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

// The connected systems are decided by a grant, not a role: three levels,
// read from the database on every request so a revocation bites at once. A
// refusal is written to the trail.
const ACCESS_LEVELS = ["monitor", "manage", "control"];

const NO_ACCESS = Object.freeze({ monitor: false, manage: false, control: false });
const ALL_ACCESS = Object.freeze({ monitor: true, manage: true, control: true });

const SYSTEM_SELECT = `
  SELECT cs.system_id, cs.system_key, cs.system_name, cs.system_kind,
         cs.description, cs.endpoint_url, cs.is_enabled,
         cs.created_at, cs.updated_at, cb.full_name AS created_by
  FROM connected_systems cs
  LEFT JOIN staff cb ON cb.staff_id = cs.created_by_staff_id
`;

async function findSystem(systemKey) {
  const [rows] = await db.query(`${SYSTEM_SELECT} WHERE cs.system_key = ?`,
    [String(systemKey || "").toLowerCase()]);
  return rows[0] || null;
}

// what one person holds, keyed by system; empty for somebody never granted a thing
async function permissionsOf(staffId) {
  const [rows] = await db.query(
    `SELECT cs.system_key, p.can_monitor, p.can_manage, p.can_control,
            p.note, p.granted_at, p.updated_at, gb.full_name AS granted_by
     FROM system_permissions p
     JOIN connected_systems cs ON cs.system_id = p.system_id
     LEFT JOIN staff gb ON gb.staff_id = p.granted_by_staff_id
     WHERE p.staff_id = ?`,
    [staffId]);

  const held = new Map();
  for (const row of rows) {
    held.set(row.system_key, {
      monitor: Boolean(row.can_monitor),
      manage: Boolean(row.can_manage),
      control: Boolean(row.can_control),
      note: row.note,
      grantedAt: row.granted_at,
      updatedAt: row.updated_at,
      grantedBy: row.granted_by
    });
  }
  return held;
}

async function accessOf(actor, systemKey) {
  if (!actor) return NO_ACCESS;
  if (actor.roleName === ADMIN) return ALL_ACCESS;

  const held = (await permissionsOf(actor.staffId)).get(systemKey);
  return held
    ? { monitor: held.monitor, manage: held.manage, control: held.control }
    : NO_ACCESS;
}

function requireSystemAccess(level) {
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`Unknown access level: ${level}`);

  return async (request, response, next) => {
    try {
      const system = await findSystem(request.params.systemKey);
      if (!system) {
        return response.status(404).json({ error: "No connected system is registered under that name." });
      }

      const access = await accessOf(request.actor, system.system_key);

      if (!access[level]) {
        await writeAuditLog(request, "SYSTEM_ACCESS_DENIED",
          `${request.actor.email} tried to ${level} ${system.system_name} without permission`,
          { system_key: system.system_key, level_needed: level, held: access,
            attempted: `${request.method} ${request.path}` });

        return response.status(403).json({
          error: `You do not have ${level} access to ${system.system_name}. ` +
                 "The System Administrator grants it from Access Control."
        });
      }

      request.system = system;
      request.systemAccess = access;
      next();
    } catch (error) {
      console.error("Access check failed:", error.message);
      response.status(500).json({ error: "Unable to check your access to that system." });
    }
  };
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
    routes: [["POST", /^\/api\/sales$/], ["POST", /^\/api\/deliveries$/], ["POST", /^\/api\/customers$/]] },
  { key: "refunds", name: "Refunds", module: "Point of Sale",
    description: "Take a sold item back and refund it at the counter.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/]] },
  { key: "sales-report", name: "Sales Report", module: "Point of Sale",
    description: "The cashier's own sales, by day and by method.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["GET", /^\/api\/reports\/daily-tally$/]] },
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
             ["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests$/]] },
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
    description: "Payment methods, receivables, repeat customers, staff performance.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/reports\/overview$/]] },
  { key: "sales", name: "Sales", module: "Reports",
    description: "Every sale rung up, with its lines and its payments.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["POST", /^\/api\/sales\/\d+\/payment$/]] },

  // --- stock ---
  { key: "material-list", name: "Material List", module: "Inventory",
    description: "Everything on the shelf, with what is in stock.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/summary$/]] },
  { key: "stock-adjustment", name: "Stock Adjustment", module: "Inventory",
    description: "Correct a stock figure by hand, and open a record for a material the shop has never stocked.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/inventory\/adjust$/], ["POST", /^\/api\/materials$/]] },
  { key: "adjustment-history", name: "Adjustment History", module: "Inventory",
    description: "Every correction made, by whom and why.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/adjustments$/]] },
  { key: "reorder-points", name: "Reorder Points", module: "Inventory",
    description: "Where each material's reorder point sits, and the formula behind it.",
    available: [CLERK], defaults: [CLERK],
    routes: [["PUT", /^\/api\/inventory\/reorder\/\d+$/]] },
  { key: "reorder-alerts", name: "Reorder Alerts", module: "Inventory",
    description: "The materials at or under their reorder point today.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/reorder-policy$/]] },
  { key: "stock-reports", name: "Stock Reports", module: "Inventory",
    description: "The whole inventory to read, sort and print.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/]] },
  { key: "returns", name: "Returned Items", module: "Inventory",
    description: "Returns and damage reports, and putting them back on the shelf or writing them off.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/], ["POST", /^\/api\/returns\/\d+\/resolve$/]] },
  { key: "damage-report", name: "Make a Report", module: "Inventory",
    description: "Report damaged goods and take them off the shelf.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/returns$/]] },
  { key: "purchase-orders", name: "Purchase Orders", module: "Inventory",
    description: "Orders to suppliers: the manager raises and receives them, the clerk reads them.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/],
             ["GET", /^\/api\/purchase-orders\/\d+\/document$/], ["POST", /^\/api\/purchase-orders$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/receive$/]] },

  // --- deliveries ---
  { key: "deliveries", name: "Delivery Tracking", module: "Deliveries",
    description: "Every delivery booked and where it has got to; the manager's copy can move one along.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/deliveries$/], ["PATCH", /^\/api\/deliveries\/\d+\/status$/]] },
  { key: "delivery-runs", name: "Delivery Runs", module: "Deliveries",
    description: "The driver's own round: pending, out for delivery, and cash to collect.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/list$/], ["PATCH", /^\/api\/deliveries\/\d+\/status$/],
             ["POST", /^\/api\/delivery\/\d+\/payment$/]] },
  { key: "delivery-reports", name: "Delivery Reports", module: "Deliveries",
    description: "The driver's deliveries and collections over a period.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/summary$/]] },
  // drawn by script (shared/delivery-schedule.js), so every page can draw it
  { key: "delivery-schedule", name: "Delivery Schedule", module: "Deliveries",
    description: "Deliveries still to go out, by the day they are due: overdue, today, tomorrow, later.",
    available: [MANAGER, CASHIER, CLERK, DRIVER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/deliveries$/]] },

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

function findFeature(key) {
  return FEATURES.find((feature) => feature.key === String(key || "").toLowerCase()) || null;
}

function featuresCovering(method, pathname) {
  return FEATURES.filter((feature) =>
    feature.routes.some(([ruleMethod, pattern]) => ruleMethod === method && pattern.test(pathname)));
}

// the overrides, cached between writes:
// role name -> Map(feature key -> { granted, note, grantedBy, grantedAt, updatedAt })
let featureOverrides = null;

async function loadFeatureOverrides() {
  if (featureOverrides) return featureOverrides;

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
  }

  featureOverrides = byRole;
  return byRole;
}

function forgetFeatureOverrides() {
  featureOverrides = null;
}

// what one role holds: the defaults with the overrides applied
async function featuresOf(roleName) {
  const overrides = (await loadFeatureOverrides()).get(roleName) || new Map();

  return FEATURES
    .filter((feature) => feature.available.includes(roleName) || roleName === ADMIN)
    .map((feature) => {
      const byDefault = roleName === ADMIN || feature.defaults.includes(roleName);
      const override = overrides.get(feature.key) || null;
      const held = override ? override.granted : byDefault;
      return {
        key: feature.key,
        name: feature.name,
        module: feature.module,
        held: held,
        byDefault: byDefault,
        overridden: Boolean(override) && override.granted !== byDefault,
        note: override ? override.note : null,
        grantedBy: override ? override.grantedBy : null,
        updatedAt: override ? (override.updatedAt || override.grantedAt) : null
      };
    });
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

// ==========================================
// THE COUNT ON A MENU ITEM
//
// Each count is the screen's own rule so the two agree. The clerk's Reorder
// Points reads the typed reorder point; the manager's Reorder Alerts reads
// the EFFECTIVE one (calculated for a product on Dynamic).
// ==========================================
const LOW_STOCK_TYPED_SQL = `
  SELECT COUNT(*) AS n FROM products p
  LEFT JOIN inventory i ON i.product_id = p.product_id
  WHERE p.is_archived = FALSE
    AND COALESCE(i.quantity_in_stock, 0) <= p.reorder_point`;

// the same formula as /api/stocks; the three ? are SALES_WINDOW_DAYS
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

const FEATURE_COUNTS = {
  "credit-requests": {
    roles: [MANAGER],
    sql: `SELECT COUNT(*) AS n FROM credit_requests WHERE status = 'Pending'`
  },
  "reorder-alerts": {
    roles: [MANAGER],
    sql: LOW_STOCK_EFFECTIVE_SQL,
    params: () => [SALES_WINDOW_DAYS, SALES_WINDOW_DAYS, SALES_WINDOW_DAYS]
  },
  "reorder-points": { roles: [CLERK], sql: LOW_STOCK_TYPED_SQL },
  "returns": {
    roles: [CLERK],
    sql: `SELECT COUNT(*) AS n FROM returned_items WHERE status = 'Open'`
  },
  "deliveries": {
    roles: [MANAGER],
    sql: `SELECT COUNT(*) AS n FROM deliveries WHERE is_archived = FALSE AND status = 'Pending'`
  },
  "delivery-runs": {
    roles: [DRIVER],
    sql: `SELECT COUNT(*) AS n FROM deliveries
          WHERE is_archived = FALSE AND status = 'Pending'
            AND (delivery_staff_id = ? OR delivery_staff_id IS NULL)`,
    params: (actor) => [actor.staffId]
  },
  "delivery-schedule": {
    roles: FEATURE_ROLES,
    sql: `SELECT COUNT(*) AS n FROM deliveries
          WHERE is_archived = FALSE AND status NOT IN ('Delivered', 'Failed')
            AND scheduled_date IS NOT NULL AND DATE(scheduled_date) <= CURDATE()`
  }
};

async function featureCountsFor(actor) {
  const counts = {};
  if (!actor || actor.roleName === ADMIN) return counts;

  const { held } = await heldFeatures(actor.roleName);

  for (const [key, counter] of Object.entries(FEATURE_COUNTS)) {
    if (!held.has(key) || !counter.roles.includes(actor.roleName)) continue;
    try {
      const [[row]] = await db.query(counter.sql, counter.params ? counter.params(actor) : []);
      counts[key] = Number(row.n) || 0;
    } catch (error) {
    }
  }
  return counts;
}

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

function findRule(method, pathname) {
  for (const [ruleMethod, pattern, allowed] of ACCESS_RULES) {
    if (ruleMethod === method && pattern.test(pathname)) return allowed;
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
  if (request.method !== "GET" && request.method !== "HEAD" &&
      request.path !== "/api/login" && request.path !== "/api/logout" &&
      request.path !== "/api/heartbeat" &&
      await proceduresAreMissing()) {
    console.error(`Refused ${request.method} ${request.path}: ` +
      `${proceduresLoaded} of ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
    return response.status(503).json({ error: procedureAdvice() });
  }

  if (allowed === PUBLIC) return next();

  const session = currentSession(request);
  if (!session) {
    return response.status(401).json({ error: "Your session has ended. Please sign in again." });
  }

  const byRole = allowed === SIGNED_IN || allowed.includes(session.roleName);

  // Screens by role: a route is refused once every screen using it is off for
  // this role, and allowed past the role table when held by grant. The
  // administrator is never narrowed.
  const covering = session.roleName === ADMIN ? [] : featuresCovering(request.method, request.path);
  if (covering.length > 0) {
    let held;
    try {
      held = await heldFeatures(session.roleName);
    } catch (error) {
      held = { held: new Set(), granted: new Set() };
    }

    const stillHeld = covering.filter((feature) => held.held.has(feature.key));
    if (stillHeld.length === 0) {
      return response.status(403).json({
        error: `${covering[0].name} has been switched off for ${session.roleName} accounts. ` +
               "The System Administrator turns screens on and off under Screens by Role."
      });
    }

    if (!byRole && !stillHeld.some((feature) => held.granted.has(feature.key))) {
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
  // from, after the response finished and only when it succeeded.
  if (request.method !== "GET" && request.method !== "HEAD" &&
      !CHANGES_NOTHING.some((pattern) => pattern.test(request.path))) {
    response.on("finish", () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        publishChange(
          scopeOf(request.path),
          `${request.method} ${request.path}`,
          request.headers["x-client-id"] || null
        );
      }
    });
  }

  next();
});

// archived_at and archived_by because the restore card says when and by whom
const USER_SELECT = `
  SELECT s.staff_id, s.first_name, s.middle_name, s.last_name, s.full_name,
         s.phone, s.is_active,
         s.created_at AS staff_created_at,
         s.archived_at, ab.full_name AS archived_by,
         r.role_id, r.role_name,
         u.user_id, u.email, u.must_change_password, u.last_login, u.created_at
  FROM staff s
  JOIN roles r ON r.role_id = s.role_id
  LEFT JOIN users u ON u.staff_id = s.staff_id
  LEFT JOIN staff ab ON ab.staff_id = s.archived_by_staff_id
`;

// ==========================================
// AUTH
//
// The address is always trimmed. A password is tried again with its edges
// trimmed while the account is still on the system-made password (which never
// contains a space); one a person chose is checked exactly as typed. Gmail
// ignores dots, so an address that matches nothing is tried once more with
// the dots removed, for the Google domains only.
// ==========================================
const LOGIN_SELECT =
  `SELECT u.user_id, u.staff_id, u.email, u.password, u.must_change_password,
          s.first_name, s.middle_name, s.last_name, s.full_name, s.is_active,
          r.role_id, r.role_name
   FROM users u
   JOIN staff s ON s.staff_id = u.staff_id
   JOIN roles r ON r.role_id = s.role_id`;

async function findLoginByEmail(email) {
  const address = String(email).trim();

  let [rows] = await db.query(`${LOGIN_SELECT} WHERE u.email = ? LIMIT 1`, [address]);
  if (rows.length > 0) return rows[0];

  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).toLowerCase();
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;

  const local = address.slice(0, at).replace(/\./g, "");
  [rows] = await db.query(
    `${LOGIN_SELECT}
     WHERE LOWER(SUBSTRING_INDEX(u.email, '@', -1)) IN ('gmail.com', 'googlemail.com')
       AND REPLACE(SUBSTRING_INDEX(u.email, '@', 1), '.', '') = ?
     LIMIT 1`,
    [local]);
  return rows[0] || null;
}

app.post("/api/login", async (request, response) => {
  const email = String(request.body.email || "").trim();
  const password = request.body.password;

  if (!email || !password) {
    return response.status(400).json({ error: "Email and password are required" });
  }

  try {
    // checked here, not in the query: the column holds a hash
    const found = await findLoginByEmail(email);
    const rows = found ? [found] : [];

    // both failures are logged; the reply stays identical so nobody can tell which addresses exist
    if (rows.length === 0) {
      await writeAuditLog(
        { staffId: null, request: request },
        "LOGIN_FAILURE",
        `Sign-in refused for ${email}: no account with that email`,
        { email: String(email), reason: "unknown_email" }
      );
      return response.status(401).json({ error: "Invalid email or password" });
    }

    const user = rows[0];

    const trimmed = String(password).trim();
    const accepted = await verifyPassword(password, user.password) ||
      (user.must_change_password && trimmed !== password &&
       await verifyPassword(trimmed, user.password));

    if (!accepted) {
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN_FAILURE",
        `Sign-in refused for ${email}: wrong password`,
        { email: String(email), reason: "wrong_password" }
      );
      return response.status(401).json({ error: "Invalid email or password" });
    }

    // a database restored from an older backup can bring back readable passwords;
    // upgrade the row on the sign-in that proves it
    if (!isHashed(user.password)) {
      await db.query("UPDATE users SET password = ? WHERE user_id = ?",
        [await hashPassword(user.password), user.user_id]);
    }

    delete user.password;   // never let the hash leave the server

    if (!user.is_active) {
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN_FAILURE",
        `Sign-in refused for ${email}: the account is deactivated`,
        { email: String(email), reason: "deactivated" }
      );
      return response.status(403).json({ error: "This account is deactivated" });
    }

    await db.query("UPDATE users SET last_login = NOW() WHERE user_id = ?", [user.user_id]);
    await writeAuditLog(
      { staffId: user.staff_id, roleName: user.role_name, request: request },
      "LOGIN",
      `${user.email} signed in`
    );

    const token = startSession(user);

    const previous = [...sessions.values()]
      .filter((session) => session.staffId === user.staff_id).length - 1;
    endSessionsForStaff(user.staff_id, token,
      "This account signed in on another device, so this screen was signed out.");
    if (previous > 0) {
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "SESSION_REPLACED",
        `${user.email} signed in again; ${previous} earlier session${previous === 1 ? "" : "s"} ended`,
        { sessions_ended: previous }
      );
    }

    response.cookie("sid", token, {
      httpOnly: true,                              // JavaScript on the page cannot read it
      sameSite: "strict",                          // not sent from another site
      maxAge: SESSION_HOURS * 60 * 60 * 1000,
      path: "/"
    });

    // the profile is only for drawing the screen; nothing sent back is trusted
    response.json({ message: "Login successful", user });
  } catch (error) {
    console.error("Login failed:", error.message);
    response.status(500).json({ error: "Unable to log in" });
  }
});

app.post("/api/logout", async (request, response) => {
  await writeAuditLog(request, "LOGOUT", `${request.actor.email} signed out`);

  endSession(request);
  response.clearCookie("sid", { path: "/" });
  response.json({ message: "Signed out" });
});

// Heartbeat: a page left open makes no requests, so the browser sends this
// once a minute to stay present. The access check ahead of it refreshes the session.
app.post("/api/heartbeat", (request, response) => {
  response.json({
    ok: true,
    staffId: request.actor.staffId,
    serverTime: new Date().toISOString()
  });
});

// ==========================================
// THE LIVE CHANNEL
//
// One open GET per signed-in browser. A comment every twenty-five seconds
// keeps a proxy from timing it out, X-Accel-Buffering off keeps nginx from
// holding frames, and Last-Event-ID lets a reconnecting browser catch up.
// ==========================================
const LIVE_PING_MS = 25000;

app.get("/api/events", (request, response) => {
  const actor = request.actor;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  response.write("retry: 3000\n\n");

  const client = {
    id: crypto.randomBytes(8).toString("hex"),
    staffId: actor.staffId,
    roleName: actor.roleName,
    token: readCookie(request, "sid"),
    response: response
  };
  liveClients.add(client);

  // what was missed while away; a gap wider than the log says so plainly
  const lastSeen = parseInt(request.headers["last-event-id"], 10);
  const missed = changesSince(lastSeen);

  response.write(`event: hello\ndata: ${JSON.stringify({
    clientId: client.id,
    version: changeVersion,
    caughtUp: !missed.gap,
    scopes: [...new Set(missed.changes.map((c) => c.scope))]
  })}\n\n`);

  if (missed.gap) {
    response.write(`event: resync\ndata: ${JSON.stringify({ version: changeVersion })}\n\n`);
  } else {
    for (const change of missed.changes) {
      response.write(`id: ${change.version}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);
    }
  }

  // the ping also keeps the session alive and marks the person present
  const ping = setInterval(() => {
    const session = client.token ? sessions.get(client.token) : null;

    if (!session || session.expiresAt < Date.now()) {
      clearInterval(ping);
      liveClients.delete(client);
      try { response.end(); } catch (error) { /* already gone */ }
      return;
    }

    session.lastSeen = Date.now();

    try {
      response.write(": ping\n\n");
    } catch (error) {
      clearInterval(ping);
      liveClients.delete(client);
    }
  }, LIVE_PING_MS);

  const close = () => {
    clearInterval(ping);
    liveClients.delete(client);
  };

  request.on("close", close);
  request.on("aborted", close);
});

app.get("/api/events/status", (request, response) => {
  response.json({
    version: changeVersion,
    connections: liveClients.size,
    people: [...new Set([...liveClients].map((c) => c.staffId))].length,
    logged: changeLog.length
  });
});

app.post("/api/change-password", async (request, response) => {
  const { newPassword } = request.body;

  // always the signed-in account, never one named in the body
  const userId = request.actor.userId;

  if (!userId || typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  try {
    // choosing the temporary password again keeps it; checked here against the
    // stored hash because the screen never sees it
    const [current] = await db.query(
      "SELECT password FROM users WHERE user_id = ? AND must_change_password = TRUE",
      [userId]
    );
    const sameAsGiven = current.length > 0 && (
      await verifyPassword(newPassword, current[0].password) ||
      (newPassword.trim() !== newPassword &&
       await verifyPassword(newPassword.trim(), current[0].password)));
    if (sameAsGiven) {
      return response.status(400).json({
        error: "Choose a password that is different from the temporary one you were given"
      });
    }

    const [result] = await db.query(
      "UPDATE users SET password = ?, must_change_password = FALSE WHERE user_id = ? AND must_change_password = TRUE",
      [await hashPassword(newPassword), userId]
    );

    if (result.affectedRows === 0) {
      return response.status(403).json({ error: "Password change is not allowed" });
    }

    await writeAuditLog(request, "CHANGE_OWN_PASSWORD",
      `${request.actor.email} chose their own password on first sign-in`);

    signOutAfterPasswordChange(request, response);
    response.json({ message: "Password changed successfully", signedOut: true });
  } catch (error) {
    console.error("Password update failed:", error.message);
    response.status(500).json({ error: "Unable to change password" });
  }
});

// A changed password ends every session, this one included: the old password
// may be known to somebody else, and signing in with the new one straight
// away is what proves it was typed right.
const PASSWORD_CHANGED =
  "Your password was changed. Sign in again with the new one.";

function signOutAfterPasswordChange(request, response) {
  endSessionsForStaff(request.actor.staffId, null, PASSWORD_CHANGED);
  response.clearCookie("sid", { path: "/" });
}

// ==========================================
// YOUR OWN ACCOUNT -- always the signed-in account; the role is not editable here
// ==========================================
// What the signed-in person is, for the screens to shape themselves around.
// A convenience for the page and never a permission.
app.get("/api/me/access", async (request, response) => {
  const actor = request.actor;

  // the connected systems this person may reach; still a convenience, not a permission
  let systems = [];
  try {
    if (actor.roleName === ADMIN) {
      const [rows] = await db.query(`${SYSTEM_SELECT} ORDER BY cs.system_kind, cs.system_name`);
      systems = rows.map((row) => ({ key: row.system_key, name: row.system_name, ...ALL_ACCESS }));
    } else {
      const held = await permissionsOf(actor.staffId);
      systems = [...held.entries()].map(([key, access]) => ({
        key, monitor: access.monitor, manage: access.manage, control: access.control
      }));
    }
  } catch (error) {
    systems = [];
  }

  response.json({
    staffId: actor.staffId,
    roleName: actor.roleName,
    page: ROLE_PAGES[actor.roleName] || "/Login.html",
    isAdmin: actor.roleName === ADMIN,
    isManagement: MANAGEMENT.includes(actor.roleName),
    canEditOwnDetails: actor.roleName !== ADMIN,
    canChangeOwnPassword: actor.roleName === ADMIN,
    canEditOwnEmail: false,
    canReachSystems: systems.length > 0,
    systems: systems
  });
});

// What this person's menu holds, and what is waiting on it. A convenience
// for the page; the access hook reads the same table for itself.
app.get("/api/me/features", async (request, response) => {
  try {
    const features = await featuresOf(request.actor.roleName);
    response.json({
      roleName: request.actor.roleName,
      features: features,
      held: features.filter((feature) => feature.held).map((feature) => feature.key)
    });
  } catch (error) {
    console.error("Reading a role's screens failed:", error.message);
    response.status(500).json({ error: "Unable to read which screens you hold" });
  }
});

app.get("/api/me/counts", async (request, response) => {
  try {
    response.json(await featureCountsFor(request.actor));
  } catch (error) {
    console.error("Counting what is waiting failed:", error.message);
    response.status(500).json({ error: "Unable to count what is waiting" });
  }
});


// A credential (the sign-in email, the password, the role) is not changed by
// its own holder: a standard user edits name and phone only, and a new
// password comes from the administrator's Reset Password. The administrator
// keeps the right to change their own password.
function notOwnCredentials(request, response, next) {
  if (request.actor && request.actor.roleName !== ADMIN) {
    return response.status(403).json({
      error: "Your password is reset by the System Administrator, who sends a new " +
             "one to your email. You choose your own on the next sign-in."
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

    signOutAfterPasswordChange(request, response);
    response.json({ message: "Your password was changed.", signedOut: true });
  } catch (error) {
    console.error("Own password change failed:", error.message);
    response.status(500).json({ error: "Unable to change your password" });
  }
});

// ==========================================
// LOOKUPS
// ==========================================
app.get("/api/roles", async (request, response) => {
  try {
    const [rows] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");
    response.json(rows);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// (GET /api/products was removed; GET /api/inventory/products replaces it)

// ==========================================
// STAFF ACCOUNTS
// ==========================================

// Handing over a new password: by mail when it works, otherwise back to the
// administrator's screen to be read out, with the reason. A password is
// NEVER written to the audit trail on either path.
async function deliverFirstPassword({ email, name, roleName, password }) {
  if (!isMailConfigured()) {
    return {
      emailed: false,
      password: password,
      reason: "Mail is not set up on this server, so the password could not be sent."
    };
  }

  try {
    const [rows] = await db.query(
      "SELECT store_name FROM store_settings WHERE setting_id = 1");
    const storeName = (rows[0] && rows[0].store_name) || DEFAULT_STORE_SETTINGS.store_name;

    await sendMail(firstPasswordMessage({
      name: name,
      email: email,
      roleName: roleName,
      password: password,
      storeName: storeName
    }));

    return { emailed: true };
  } catch (error) {
    // the reason is passed on: "Username and Password not accepted" is the diagnosis
    console.error("Sending the first password failed:", error.message);
    return {
      emailed: false,
      password: password,
      reason: `The mail server refused the message: ${error.message}`
    };
  }
}

async function roleNameById(roleId) {
  const [rows] = await db.query(
    "SELECT role_name FROM roles WHERE role_id = ?", [roleId]);
  return (rows[0] && rows[0].role_name) || "staff";
}

// Drafts: creating an account is two requests with a person reading the
// details in between. The draft lives here, in memory, keyed by id and held
// to one administrator, so what was confirmed on screen is what is written.
// Drafts expire on their own.
const accountDrafts = new Map();      // draftId -> { by, kind, details, password, expires }
const DRAFT_LIFE_MS = 10 * 60 * 1000; // long enough to read a card, short enough to forget
const DRAFT_MAX = 200;                // one runaway client cannot grow this without limit

function newAccountDraft(staffId, kind, details, password) {
  // swept here rather than on a timer: the map only grows when it is being used
  const now = Date.now();
  for (const [id, draft] of accountDrafts) {
    if (draft.expires <= now) accountDrafts.delete(id);
  }
  if (accountDrafts.size >= DRAFT_MAX) {
    const oldest = [...accountDrafts.entries()]
      .sort((left, right) => left[1].expires - right[1].expires)[0];
    if (oldest) accountDrafts.delete(oldest[0]);
  }

  const draftId = crypto.randomBytes(18).toString("base64url");
  accountDrafts.set(draftId, {
    by: staffId,
    kind: kind,
    details: details,
    password: password,
    expires: now + DRAFT_LIFE_MS
  });

  return { draftId, expiresInSeconds: Math.round(DRAFT_LIFE_MS / 1000) };
}

// Reads a draft and removes it: a draft is good for one confirmation, so a
// double-clicked button is not a second account.
function takeAccountDraft(draftId, staffId, kind) {
  const draft = accountDrafts.get(String(draftId || ""));

  if (!draft) return { error: "That review has expired. Fill the form in again." };
  accountDrafts.delete(String(draftId));

  if (draft.expires <= Date.now()) {
    return { error: "That review has expired. Fill the form in again." };
  }
  if (draft.by !== staffId) {
    return { error: "That review belongs to another administrator's session." };
  }
  if (draft.kind !== kind) {
    return { error: "That review was for a different kind of account." };
  }

  return { draft };
}

// Every staff member, including anyone with no login, with presence. The
// filters are applied here so a large directory need not travel in full.
app.get("/api/users", async (request, response) => {
  const status = String(request.query.status || "all").toLowerCase();
  const search = String(request.query.search || "").trim();

  const where = [];
  const params = [];

  if (status === "active") where.push("s.is_active = TRUE");
  else if (status === "inactive") where.push("s.is_active = FALSE");

  // starts-with, not contains; see searchPrefix
  if (search !== "") {
    where.push("(s.full_name LIKE ? OR u.email LIKE ? OR r.role_name LIKE ?)");
    const like = searchPrefix(search);
    params.push(like, like, like);
  }

  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await db.query(`${USER_SELECT}${filter} ORDER BY s.staff_id`, params);
    response.json(withPresence(rows));
  } catch (error) {
    console.error("Loading users failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/users/:staffId", async (request, response) => {
  try {
    const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [request.params.staffId]);

    if (rows.length === 0) {
      return response.status(404).json({ error: "Staff record not found" });
    }

    response.json(rows[0]);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// Step 1 of 2: check everything, make the password, hand the account back to
// be read. Nothing is in the database when this returns.
app.post("/api/users/draft", async (request, response) => {
  const { firstName, middleName, lastName, phone, roleId, email } = request.body;

  if (!firstName || !lastName || !roleId || !email) {
    return response.status(400).json({ error: "Name, role and email are required" });
  }

  // the email is where the password goes, so an address that cannot receive one is refused
  const address = String(email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return response.status(400).json({ error: "That email address does not look right" });
  }

  const phoneProblem = phoneComplaint(phone);
  if (phoneProblem) return response.status(400).json({ error: phoneProblem });

  try {
    const [roles] = await db.query(
      "SELECT role_name FROM roles WHERE role_id = ?", [roleId]);
    if (roles.length === 0) {
      return response.status(400).json({ error: "The selected role does not exist." });
    }

    // the procedure checks this too; checking here keeps the answer in front of the form
    const [taken] = await db.query("SELECT user_id FROM users WHERE email = ?", [address]);
    if (taken.length > 0) {
      return response.status(409).json({
        error: `The email ${address} already signs in to another account. ` +
               "Two people may share a name, but not an email address."
      });
    }

    const details = {
      firstName: String(firstName).trim(),
      middleName: cleanMiddleName(middleName),
      lastName: String(lastName).trim(),
      phone: cleanPhone(phone),
      roleId: Number(roleId),
      roleName: roles[0].role_name,
      email: address
    };

    const password = generatePassword();
    const { draftId, expiresInSeconds } =
      newAccountDraft(request.actor.staffId, "staff", details, password);

    // the one place a readable password crosses the wire on purpose
    response.json({
      draftId: draftId,
      expiresInSeconds: expiresInSeconds,
      password: password,
      willEmail: isMailConfigured(),
      ...details,
      // the name as the directory will spell it (same as staff.full_name)
      fullName: details.firstName +
        (details.middleName ? ` ${details.middleName[0].toUpperCase()}.` : "") +
        ` ${details.lastName}`
    });
  } catch (error) {
    console.error("Account review failed:", error.message);
    response.status(500).json({ error: "Unable to prepare the account" });
  }
});

// Step 2 of 2: create it from the draft and send the password.
app.post("/api/users", async (request, response) => {
  const { draft, error } = takeAccountDraft(
    request.body.draftId, request.actor.staffId, "staff");

  if (error) return response.status(410).json({ error });

  const details = draft.details;

  try {
    const output = await callProcedure(
      "CALL sp_create_staff_account(?, ?, ?, ?, ?, ?, ?, @staff_id, @status_code, @message)",
      [details.firstName, details.middleName, details.lastName, details.phone,
       details.roleId, details.email, await hashPassword(draft.password)],
      ["staff_id", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    // read back so the mail greets the person by the name the directory shows
    const [created] = await db.query(
      "SELECT full_name FROM staff WHERE staff_id = ?", [output.staff_id]);
    const name = (created[0] && created[0].full_name) || details.firstName;

    const delivery = await deliverFirstPassword({
      email: details.email,
      name: name,
      roleName: details.roleName,
      password: draft.password
    });

    // whether the mail went is in the trail; the password never is
    await writeAuditLog(
      request,
      "CREATE_ACCOUNT",
      `Created account for ${details.email}` +
        (delivery.emailed ? " and emailed the first password" : " (password not emailed)"),
      { staff_id: output.staff_id, email: details.email, role_id: details.roleId,
        name: name, password_emailed: delivery.emailed }
    );

    response.json({
      message: output.message,
      staffId: output.staff_id,
      name: name,
      email: details.email,
      emailed: delivery.emailed,
      password: delivery.password,   // absent when the mail went; see above
      reason: delivery.reason
    });
  } catch (error) {
    console.error("Create account failed:", error.message);
    response.status(500).json({ error: "Unable to create the account" });
  }
});

app.put("/api/users/:staffId", notOwnAccount, async (request, response) => {
  const { firstName, middleName, lastName, phone, roleId, email } = request.body;

  if (!firstName || !lastName || !roleId) {
    return response.status(400).json({ error: "Name and role are required" });
  }

  const phoneProblem = phoneComplaint(phone);
  if (phoneProblem) return response.status(400).json({ error: phoneProblem });

  try {
    // read before writing, so the audit entry can say what changed
    const [existing] = await db.query(
      `SELECT s.first_name, s.middle_name, s.last_name, s.phone,
              s.role_id, u.email
       FROM staff s LEFT JOIN users u ON u.staff_id = s.staff_id
       WHERE s.staff_id = ?`,
      [request.params.staffId]
    );
    const before = existing[0] || null;

    const output = await callProcedure(
      "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [request.params.staffId, firstName, cleanMiddleName(middleName), lastName,
       cleanPhone(phone), roleId, email || null],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    endSessionsForStaff(request.params.staffId);

    const after = {
      first_name: firstName,
      middle_name: cleanMiddleName(middleName),
      last_name: lastName,
      phone: cleanPhone(phone),
      role_id: Number(roleId),
      email: email || null
    };

    await writeAuditLog(
      request,
      "UPDATE_ACCOUNT",
      `Updated staff #${request.params.staffId}`,
      { staff_id: Number(request.params.staffId), changes: fieldChanges(before, after) }
    );
    response.json({ message: output.message });
  } catch (error) {
    console.error("Update account failed:", error.message);
    response.status(500).json({ error: "Unable to update the account" });
  }
});

app.patch("/api/users/:staffId/status", notOwnAccount, async (request, response) => {
  const isActive = request.body.isActive === true;

  try {
    const output = await callProcedure(
      "CALL sp_set_staff_status(?, ?, @status_code, @message)",
      [request.params.staffId, isActive],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    if (!isActive) endSessionsForStaff(request.params.staffId);

    await writeAuditLog(
      request,
      isActive ? "ACTIVATE_ACCOUNT" : "DEACTIVATE_ACCOUNT",
      `Staff #${request.params.staffId} was ${isActive ? "restored to" : "removed from"} the active list`,
      { staff_id: Number(request.params.staffId),
        is_active: { before: !isActive, after: isActive } }
    );
    response.json({ message: output.message });
  } catch (error) {
    console.error("Status change failed:", error.message);
    response.status(500).json({ error: "Unable to change the account status" });
  }
});

// A login for somebody who already has a staff record: the same two steps
// and the same review card; only the address is asked for.
app.post("/api/users/:staffId/account/draft", notOwnAccount, async (request, response) => {
  const { email } = request.body;
  const staffId = Number(request.params.staffId);

  if (!email) {
    return response.status(400).json({ error: "An email address is required" });
  }

  const address = String(email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return response.status(400).json({ error: "That email address does not look right" });
  }

  try {
    const [staff] = await db.query(
      `SELECT s.staff_id, s.full_name, s.phone, s.middle_name, r.role_name, u.user_id
       FROM staff s
       JOIN roles r ON r.role_id = s.role_id
       LEFT JOIN users u ON u.staff_id = s.staff_id
       WHERE s.staff_id = ?`,
      [staffId]
    );

    if (staff.length === 0) {
      return response.status(404).json({ error: "Staff record not found" });
    }
    if (staff[0].user_id) {
      return response.status(409).json({ error: "That person already has a login account." });
    }

    const [taken] = await db.query("SELECT user_id FROM users WHERE email = ?", [address]);
    if (taken.length > 0) {
      return response.status(409).json({
        error: `The email ${address} already signs in to another account. ` +
               "Give this account its own email."
      });
    }

    const details = {
      staffId: staffId,
      fullName: staff[0].full_name,
      middleName: staff[0].middle_name,
      phone: staff[0].phone,
      roleName: staff[0].role_name,
      email: address
    };

    const password = generatePassword();
    const { draftId, expiresInSeconds } =
      newAccountDraft(request.actor.staffId, "login", details, password);

    response.json({
      draftId: draftId,
      expiresInSeconds: expiresInSeconds,
      password: password,
      willEmail: isMailConfigured(),
      ...details
    });
  } catch (error) {
    console.error("Login review failed:", error.message);
    response.status(500).json({ error: "Unable to prepare the login account" });
  }
});

app.post("/api/users/:staffId/account", notOwnAccount, async (request, response) => {
  const { draft, error } = takeAccountDraft(
    request.body.draftId, request.actor.staffId, "login");

  if (error) return response.status(410).json({ error });

  const details = draft.details;

  // a draft cannot be confirmed against a different person by changing the URL
  if (details.staffId !== Number(request.params.staffId)) {
    return response.status(409).json({
      error: "That review was prepared for a different staff record."
    });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_login_for_staff(?, ?, ?, @status_code, @message)",
      [details.staffId, details.email, await hashPassword(draft.password)],
      ["status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    const delivery = await deliverFirstPassword({
      email: details.email,
      name: details.fullName || "there",
      roleName: details.roleName || "staff",
      password: draft.password
    });

    await writeAuditLog(
      request,
      "CREATE_LOGIN",
      `Login created for staff #${details.staffId}` +
        (delivery.emailed ? " and the first password was emailed" : " (password not emailed)"),
      { staff_id: details.staffId, email: details.email,
        password_emailed: delivery.emailed }
    );

    response.json({
      message: output.message,
      name: details.fullName,
      email: details.email,
      emailed: delivery.emailed,
      password: delivery.password,
      reason: delivery.reason
    });
  } catch (error) {
    console.error("Create login failed:", error.message);
    response.status(500).json({ error: "Unable to create the login account" });
  }
});

// Resetting a password is the same machinery as the first one: the server
// makes it, mails it, and every session the person holds is ended.
app.post("/api/users/:staffId/reset-password", notOwnAccount, async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT s.full_name, u.email, r.role_name
       FROM staff s JOIN roles r ON r.role_id = s.role_id
       LEFT JOIN users u ON u.staff_id = s.staff_id
       WHERE s.staff_id = ?`,
      [request.params.staffId]);

    if (rows.length === 0) return response.status(404).json({ error: "Staff record not found" });
    if (!rows[0].email) {
      return response.status(404).json({ error: "This staff member has no login account." });
    }

    const password = generatePassword();
    const output = await callProcedure(
      "CALL sp_reset_user_password(?, ?, @status_code, @message)",
      [request.params.staffId, await hashPassword(password)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    endSessionsForStaff(Number(request.params.staffId), null,
      "Your password was reset by the administrator. Sign in with the one that was sent to you.");

    const delivery = await deliverFirstPassword({
      email: rows[0].email,
      name: rows[0].full_name,
      roleName: rows[0].role_name,
      password: password
    });

    await writeAuditLog(request, "RESET_PASSWORD",
      `Password reset for ${rows[0].email}` +
        (delivery.emailed ? " and the new one was emailed" : " (password not emailed)"),
      { staff_id: Number(request.params.staffId), email: rows[0].email,
        password_emailed: delivery.emailed });

    response.json({
      message: "Password reset. The new one has to be changed on the next sign-in.",
      name: rows[0].full_name,
      email: rows[0].email,
      emailed: delivery.emailed,
      password: delivery.password,
      reason: delivery.reason
    });
  } catch (error) {
    console.error("Password reset failed:", error.message);
    response.status(500).json({ error: "Unable to reset the password" });
  }
});

// ==========================================
// AUDIT LOGS -- newest first, filtered by kind, date range and free text
// ==========================================
app.get("/api/audit-logs", async (request, response) => {
  const actionType = String(request.query.actionType || "all").toUpperCase();
  const search = String(request.query.search || "").trim();
  const from = String(request.query.from || "").trim();
  const to = String(request.query.to || "").trim();

  const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 500, 1), 2000);

  const where = [];
  const params = [];

  if (actionType !== "ALL" && AUDIT_TYPES.includes(actionType)) {
    where.push("l.action_type = ?");
    params.push(actionType);
  }

  // a date is inclusive of the whole day
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push("l.created_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push("l.created_at <= ?");
    params.push(`${to} 23:59:59`);
  }

  if (search !== "") {
    where.push("(s.full_name LIKE ? OR l.action LIKE ? OR l.details LIKE ? OR l.ip_address LIKE ?)");
    const like = searchPrefix(search);
    params.push(like, like, like, like);
  }

  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  try {
    const [rows] = await db.query(
      `SELECT l.log_id, l.staff_id, l.action, l.action_type,
              l.details, l.metadata, l.ip_address, l.created_at,
              COALESCE(s.full_name, 'System') AS staff_name,
              COALESCE(l.role_name, r.role_name, 'System') AS role_name
       FROM audit_logs l
       LEFT JOIN staff s ON s.staff_id = l.staff_id
       LEFT JOIN roles r ON r.role_id = s.role_id
       ${filter}
       ORDER BY l.log_id DESC
       LIMIT ?`,
      params
    );
    response.json(rows);
  } catch (error) {
    console.error("Loading audit logs failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/audit-logs/types", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT action_type, COUNT(*) AS entries
       FROM audit_logs
       GROUP BY action_type
       ORDER BY entries DESC`
    );
    response.json(rows);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// ==========================================
// BACKUP & RECOVERY
//
// A backup is a complete .sql file (schema, rows, views, procedures) written
// into backups/ and named after the moment it was taken. It opens and runs in
// MySQL Workbench.
// ==========================================
const BACKUP_DIR = path.join(__dirname, "..", "..", "backups");
const BACKUP_PREFIX = "hardware_db_backup_";

// Two kinds, told apart by name: one somebody pressed the button for is kept
// until deleted; an automatic one carries its own prefix and is the only kind
// the rotation may delete.
const AUTO_PREFIX = "hardware_db_auto_";

const BACKUP_NAME =
  /^hardware_db_(backup|auto)_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;
const AUTO_NAME = /^hardware_db_auto_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;

async function ensureBackupFolder() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

function backupFileName(when, prefix) {
  const pad = (number) => String(number).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
                `_${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `${prefix || BACKUP_PREFIX}${stamp}.sql`;
}

async function freeBackupPath(when, prefix) {
  await ensureBackupFolder();
  const base = backupFileName(when, prefix);
  let name = base;
  let counter = 2;

  while (fs.existsSync(path.join(BACKUP_DIR, name))) {
    name = base.replace(/\.sql$/, `-${counter}.sql`);
    counter += 1;
  }
  return { name, fullPath: path.join(BACKUP_DIR, name) };
}

// generated columns cannot be written back; read from the catalogue so a new one never breaks a restore
async function generatedColumnsOf(table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA LIKE '%GENERATED%'`,
    [DB_NAME, table]
  );
  return rows.map((row) => row.COLUMN_NAME);
}

async function listBaseTables() {
  const [rows] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [DB_NAME]
  );
  return rows.map((row) => row.TABLE_NAME);
}

// in the order they can be created: a view that names another view goes after it
async function listViews() {
  const [rows] = await db.query(
    `SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [DB_NAME]
  );

  const pending = rows.map((row) => ({
    name: row.TABLE_NAME,
    definition: String(row.VIEW_DEFINITION || "").toLowerCase()
  }));
  const ordered = [];

  while (pending.length > 0) {
    const index = pending.findIndex((view) =>
      !pending.some((other) => other !== view &&
        view.definition.includes(`\`${other.name.toLowerCase()}\``)));
    const next = pending.splice(index === -1 ? 0 : index, 1)[0];
    ordered.push(next.name);
  }

  return ordered;
}

async function listProcedures() {
  const [rows] = await db.query(
    `SELECT ROUTINE_NAME FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
     ORDER BY ROUTINE_NAME`,
    [DB_NAME]
  );
  return rows.map((row) => row.ROUTINE_NAME);
}

// a DEFINER names an account that may not exist on another machine
function stripDefiner(sql) {
  return String(sql).replace(/DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*/gi, "");
}

// Writes the whole database to one .sql file. Pass AUTO_PREFIX for a rotating one.
async function writeBackupFile(prefix) {
  const now = new Date();
  const { name, fullPath } = await freeBackupPath(now, prefix);

  const tables = await listBaseTables();
  const views = await listViews();
  const procedures = await listProcedures();

  const out = fs.createWriteStream(fullPath, { encoding: "utf8" });
  const write = (text) => new Promise((resolve, reject) => {
    out.write(text, (error) => (error ? reject(error) : resolve()));
  });

  let rowTotal = 0;

  try {
    await write(
      `-- Hardware Sales and Inventory System - full database backup\n` +
      `-- Database : ${DB_NAME}\n` +
      `-- Taken on : ${now.toISOString()}\n` +
      `-- Contains : ${tables.length} tables, ${views.length} views, ${procedures.length} procedures\n` +
      `--\n` +
      `-- Restore from the Backup & Recovery screen, or run this file in\n` +
      `-- MySQL Workbench. It rebuilds every table and reloads every row.\n\n` +
      `SET FOREIGN_KEY_CHECKS = 0;\n` +
      `SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n`
    );

    for (const view of views) {
      await write(`DROP VIEW IF EXISTS ${sqlName(view)};\n`);
    }
    await write("\n");

    for (const table of tables) {
      const [[created]] = await db.query(`SHOW CREATE TABLE ${sqlName(table)}`);
      await write(`-- ----------------------------------------\n`);
      await write(`-- Table: ${table}\n`);
      await write(`-- ----------------------------------------\n`);
      await write(`DROP TABLE IF EXISTS ${sqlName(table)};\n`);
      await write(`${stripDefiner(created["Create Table"])};\n\n`);

      const skip = await generatedColumnsOf(table);
      const [rows] = await db.query(`SELECT * FROM ${sqlName(table)}`);

      if (rows.length === 0) {
        await write(`-- no rows\n\n`);
        continue;
      }

      const columns = Object.keys(rows[0]).filter((column) => !skip.includes(column));
      const columnList = columns.map((column) => sqlName(column)).join(", ");

      for (let start = 0; start < rows.length; start += 100) {
        const batch = rows.slice(start, start + 100).map((row) =>
          "  (" + columns.map((column) => sqlValue(row[column])).join(", ") + ")"
        );
        await write(`INSERT INTO ${sqlName(table)} (${columnList}) VALUES\n`);
        await write(batch.join(",\n") + ";\n");
      }

      rowTotal += rows.length;
      await write(`-- ${rows.length} row(s)\n\n`);
    }

    for (const view of views) {
      const [[created]] = await db.query(`SHOW CREATE VIEW ${sqlName(view)}`);
      await write(`-- View: ${view}\n`);
      await write(`${stripDefiner(created["Create View"])};\n\n`);
    }

    if (procedures.length > 0) {
      await write(`-- ----------------------------------------\n`);
      await write(`-- Stored procedures\n`);
      await write(`-- ----------------------------------------\n`);
      await write(`DELIMITER //\n`);

      for (const procedure of procedures) {
        const [[created]] = await db.query(`SHOW CREATE PROCEDURE ${sqlName(procedure)}`);
        await write(`DROP PROCEDURE IF EXISTS ${sqlName(procedure)} //\n`);
        await write(`${stripDefiner(created["Create Procedure"])} //\n\n`);
      }

      await write(`DELIMITER ;\n\n`);
    }

    await write(`SET FOREIGN_KEY_CHECKS = 1;\n`);
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  const stats = await fsp.stat(fullPath);

  return {
    fileName: name,
    createdAt: now.toISOString(),
    bytes: stats.size,
    tableCount: tables.length,
    viewCount: views.length,
    procedureCount: procedures.length,
    rowCount: rowTotal
  };
}

// Splits a .sql file into statements the way a client does: quotes, comments
// and DELIMITER are respected.
function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ";";
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const rest = sql.slice(index);

    if (current.trim() === "" && /^delimiter[ \t]+/i.test(rest)) {
      const line = rest.slice(0, rest.indexOf("\n") === -1 ? rest.length : rest.indexOf("\n"));
      delimiter = line.replace(/^delimiter[ \t]+/i, "").trim() || ";";
      index += line.length;
      current = "";
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      current += character;
      index += 1;

      while (index < sql.length) {
        if (sql[index] === "\\" && quote !== "`") {
          current += sql.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            current += quote + quote;
            index += 2;
            continue;
          }
          current += quote;
          index += 1;
          break;
        }
        current += sql[index];
        index += 1;
      }
      continue;
    }

    if (rest.startsWith("--") && (rest[2] === " " || rest[2] === "\t" || rest[2] === "\n")) {
      const stop = sql.indexOf("\n", index);
      index = stop === -1 ? sql.length : stop + 1;
      continue;
    }

    if (character === "#") {
      const stop = sql.indexOf("\n", index);
      index = stop === -1 ? sql.length : stop + 1;
      continue;
    }

    if (rest.startsWith("/*")) {
      const stop = sql.indexOf("*/", index + 2);
      index = stop === -1 ? sql.length : stop + 2;
      continue;
    }

    if (rest.startsWith(delimiter)) {
      if (current.trim() !== "") statements.push(current.trim());
      current = "";
      index += delimiter.length;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim() !== "") statements.push(current.trim());
  return statements;
}

// Runs a backup file back into the database on one connection, so the whole
// restore either lands or leaves the database as it was. A restore raises
// restoreInProgress and the backup timer stands down while it is up, so a
// half-restored database is never dumped.
let restoreInProgress = false;

async function runSqlScript(sql) {
  const statements = splitSqlStatements(sql);

  if (statements.length === 0) {
    throw new Error("That file contains no SQL statements.");
  }

  const connection = await db.getConnection();
  restoreInProgress = true;

  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    for (const statement of statements) {
      if (/^use[\s`]/i.test(statement)) continue;
      await connection.query(statement);
    }

    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    return statements.length;
  } finally {
    restoreInProgress = false;
    connection.release();
  }
}

// ==========================================
// THE AUTOMATIC BACKUP
//
// A full backup every sixty seconds. AUTO_KEEP of them exist at a time and
// the newest deletes the oldest: the last hour, minute by minute, at a fixed
// folder size. Sixty files rather than one rewritten in place, so a crash
// mid-write leaves fifty-nine good ones. Successes are not written to the
// audit trail (1,440 a day would bury it); failures are, once.
// ==========================================
const AUTO_BACKUP_ENABLED = true;
const AUTO_BACKUP_MS = 60 * 1000;   // every sixty seconds
const AUTO_KEEP = 60;               // the last hour, minute by minute

// removes the oldest automatic backups until AUTO_KEEP remain; never touches a manual one
async function rotateAutoBackups() {
  const names = (await fsp.readdir(BACKUP_DIR)).filter((name) => AUTO_NAME.test(name));
  if (names.length <= AUTO_KEEP) return 0;

  // the stamp is year-first, so the names sort chronologically
  names.sort();

  const doomed = names.slice(0, names.length - AUTO_KEEP);
  for (const name of doomed) {
    try {
      await fsp.unlink(path.join(BACKUP_DIR, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;   // already gone is fine
    }
  }
  return doomed.length;
}

// A rolling window is only safe if what it rolls over is known good. If the
// database is missing procedures the backup is still WRITTEN and nothing is
// DELETED, so the last good file is never rotated away.
async function safeToRotate() {
  if (await proceduresAreMissing()) {
    return {
      ok: false,
      why: `the database has only ${proceduresLoaded} of ${EXPECTED_PROCEDURES} ` +
           "stored procedures, so older backups that still have them are being kept"
    };
  }
  return { ok: true };
}

// the state the Backup & Recovery screen reads, from the server not a constant
const autoBackup = {
  running: false,        // a dump is in flight right now
  lastFileName: null,
  lastAt: null,
  lastBytes: null,
  lastError: null,
  failures: 0,
  // set while the rotation is standing down, and shown on the screen
  rotationHeld: null,
  // paused by somebody holding control; memory only, so a restart always backs up
  paused: false,
  pausedBy: null,
  pausedAt: null,
  ticksSkipped: 0
};

async function runAutoBackup() {
  // a dump can take longer than sixty seconds; a tick that arrives mid-run is skipped
  if (autoBackup.running) return;

  if (autoBackup.paused) {
    autoBackup.ticksSkipped += 1;
    return;
  }

  // a dump taken halfway through a restore is a dump of neither database
  if (restoreInProgress) return;

  autoBackup.running = true;

  try {
    const summary = await writeBackupFile(AUTO_PREFIX);

    // always written; whether anything is deleted is a separate question (safeToRotate)
    const rotate = await safeToRotate();
    if (rotate.ok) {
      await rotateAutoBackups();
      if (autoBackup.rotationHeld) {
        console.log("Automatic backup rotation has resumed; the folder will settle " +
          `back to ${AUTO_KEEP} ${AUTO_KEEP === 1 ? "file" : "files"}.`);
      }
      autoBackup.rotationHeld = null;
    } else if (autoBackup.rotationHeld !== rotate.why) {
      console.warn(`Automatic backup is still running, but nothing is being ` +
        `rotated away: ${rotate.why}.`);
      autoBackup.rotationHeld = rotate.why;
    }

    autoBackup.lastFileName = summary.fileName;
    autoBackup.lastAt = summary.createdAt;
    autoBackup.lastBytes = summary.bytes;

    // a run that works after a failure is worth one line
    if (autoBackup.lastError) {
      console.log(`Automatic backup is working again (${summary.fileName}).`);
    }
    autoBackup.lastError = null;
    autoBackup.failures = 0;
  } catch (error) {
    autoBackup.failures += 1;
    autoBackup.lastError = error.message;

    // said once when it starts failing, not once a minute
    if (autoBackup.failures === 1) {
      console.error("Automatic backup failed:", error.message);
      console.error("It will keep trying every minute. The Backup & Recovery screen shows this.");
    }

    // one trail entry, not one a minute
    if (autoBackup.failures === 1) {
      try {
        await writeAuditLog(
          { staffId: null, request: null },
          "BACKUP_FAILED",
          `The automatic backup failed: ${error.message}`
        );
      } catch (ignored) { /* the database is the thing that is broken */ }
    }
  } finally {
    autoBackup.running = false;
  }
}

function startAutoBackup() {
  if (!AUTO_BACKUP_ENABLED) {
    console.log("Automatic backup is switched off (AUTO_BACKUP_ENABLED in server.js).");
    return;
  }

  const minutes = Math.round((AUTO_KEEP * AUTO_BACKUP_MS) / 60000);
  console.log(`Automatic backup every ${AUTO_BACKUP_MS / 1000}s, keeping the last ` +
    `${AUTO_KEEP} (about ${minutes} ${minutes === 1 ? "minute" : "minutes"}). ` +
    "Backups taken by hand are never rotated.");

  // the first one is immediate: a just-started server may have just been restarted after a fault
  runAutoBackup();

  const timer = setInterval(runAutoBackup, AUTO_BACKUP_MS);

  // a backup timer is not a reason to keep the process alive
  if (typeof timer.unref === "function") timer.unref();
}

// The archive sweep: once at startup and once a day. The rules are in
// sp_sweep_archives beside the manual ones in sp_archive_record; here it is
// only announced on the live channel.
const ARCHIVE_SWEEP_MS = 24 * 60 * 60 * 1000;

async function runArchiveSweep() {
  if (await proceduresAreMissing()) return;   // nothing can be written anyway

  try {
    const output = await callProcedure(
      "CALL sp_sweep_archives(@deliveries, @materials)", [],
      ["deliveries", "materials"]);

    const deliveries = Number(output.deliveries) || 0;
    const materials = Number(output.materials) || 0;
    if (deliveries < 0) {
      console.error("Archive sweep failed inside the database; see the MySQL log.");
      return;
    }
    if (deliveries > 0 || materials > 0) {
      console.log(`Archive sweep: put away ${deliveries} closed ` +
        `${deliveries === 1 ? "delivery" : "deliveries"} and ${materials} idle ` +
        `${materials === 1 ? "material" : "materials"}.`);
      publishChange("archives", "sweep", null);
      if (deliveries > 0) publishChange("deliveries", "sweep", null);
      if (materials > 0) publishChange("inventory", "sweep", null);
    }
  } catch (error) {
    console.error("Archive sweep failed:", error.message);
  }
}

function startArchiveSweep() {
  runArchiveSweep();
  const timer = setInterval(runArchiveSweep, ARCHIVE_SWEEP_MS);
  if (typeof timer.unref === "function") timer.unref();
}

// ==========================================
// THE CONNECTED SYSTEMS
//
// The database, the backup, the sweep, the live channel, the mail relay, and
// any external system registered by the administrator (reached over HTTP with
// a short patience). Each answers by key with:
//   status  { state: 'ok' | 'warn' | 'bad' | 'off' | 'unknown',
//             summary: 'one sentence a person can act on',
//             facts:   { 'Label': 'value', ... } }
//   actions returning { ok, message, ... } or throwing
// Every command is written to the trail.
// ==========================================
const REMOTE_TIMEOUT_MS = 5000;

// http or https, no credentials, and never a scheme that opens a local file
function remoteUrlComplaint(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch (error) {
    return "The address is not a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The address must start http:// or https://.";
  }
  if (parsed.username || parsed.password) {
    return "The address must not carry a username or password.";
  }
  return null;
}

async function reachRemote(url, options) {
  const complaint = remoteUrlComplaint(url);
  if (complaint) throw new Error(complaint);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(url, Object.assign({ signal: controller.signal }, options || {}));
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      ms: Date.now() - started,
      body: text.slice(0, 300)
    };
  } catch (error) {
    const reason = error.name === "AbortError"
      ? `no answer within ${REMOTE_TIMEOUT_MS / 1000} seconds`
      : (error.cause && error.cause.code) || error.message;
    throw new Error(`Could not reach ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

const INTERNAL_SYSTEMS = {
  database: {
    name: "MySQL Database",
    description: "The hardware_db schema every screen reads and every procedure writes.",
    status: async () => {
      const started = Date.now();
      const [[ping]] = await db.query("SELECT VERSION() AS version, DATABASE() AS name");
      const ms = Date.now() - started;
      const total = await countProcedures();
      const [[sizes]] = await db.query(
        `SELECT COUNT(*) AS tables, ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 1) AS mb
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
        [DB_NAME]);

      const short = total < EXPECTED_PROCEDURES;
      return {
        state: short ? "bad" : "ok",
        summary: short
          ? `Answering, but only ${total} of ${EXPECTED_PROCEDURES} stored procedures are loaded, so nothing can be saved.`
          : `Answering in ${ms} ms with all ${EXPECTED_PROCEDURES} stored procedures loaded.`,
        facts: {
          "Server": `MySQL ${ping.version} on ${DB_HOST}`,
          "Schema": ping.name,
          "Tables": String(sizes.tables),
          "Size on disk": `${sizes.mb} MB`,
          "Stored procedures": `${total} of ${EXPECTED_PROCEDURES}`,
          "Round trip": `${ms} ms`
        }
      };
    },
    actions: {
      "recount-procedures": {
        label: "Re-count the stored procedures",
        hint: "Checks whether 2-RUN-SECOND-stored-procedures.sql has been loaded, without waiting for the next request to notice.",
        run: async () => {
          proceduresLoaded = null;
          procedureCheckAt = 0;
          const total = await countProcedures();
          return {
            ok: total >= EXPECTED_PROCEDURES,
            message: total >= EXPECTED_PROCEDURES
              ? `All ${EXPECTED_PROCEDURES} stored procedures are loaded.`
              : `${total} of ${EXPECTED_PROCEDURES} stored procedures are loaded. Run file 2.`,
            procedures: total
          };
        }
      }
    }
  },

  backup: {
    name: "Automatic Backup",
    description: "The rolling backup the server takes on its own and the folder it writes to.",
    status: async () => {
      await ensureBackupFolder();
      const names = (await fsp.readdir(BACKUP_DIR)).filter((name) => BACKUP_NAME.test(name));
      const automatic = names.filter((name) => AUTO_NAME.test(name)).length;

      let state = "ok";
      let summary = `Running every ${AUTO_BACKUP_MS / 1000} seconds; the last ${AUTO_KEEP} are kept.`;
      if (!AUTO_BACKUP_ENABLED) {
        state = "off";
        summary = "Switched off in server.js (AUTO_BACKUP_ENABLED). Only backups taken by hand exist.";
      } else if (autoBackup.paused) {
        state = "warn";
        summary = `Paused by ${autoBackup.pausedBy || "somebody with control"}; ` +
          `${autoBackup.ticksSkipped} tick${autoBackup.ticksSkipped === 1 ? "" : "s"} skipped so far. Resume it when the work is done.`;
      } else if (autoBackup.lastError) {
        state = "bad";
        summary = `Failing: ${autoBackup.lastError} (${autoBackup.failures} in a row).`;
      } else if (autoBackup.rotationHeld) {
        state = "warn";
        summary = `Writing, but not rotating: ${autoBackup.rotationHeld}.`;
      }

      return {
        state, summary,
        facts: {
          "Last automatic backup": autoBackup.lastAt
            ? `${autoBackup.lastFileName} (${Math.round((autoBackup.lastBytes || 0) / 1024)} KB)`
            : "None since this server started",
          "Automatic files in the folder": `${automatic} of ${AUTO_KEEP}`,
          "Backups taken by hand": String(names.length - automatic),
          "Folder": BACKUP_DIR,
          "Paused": autoBackup.paused ? `Yes, since ${autoBackup.pausedAt}` : "No"
        }
      };
    },
    actions: {
      "run-now": {
        label: "Run a backup now",
        hint: "Writes a backup that is kept until somebody deletes it, the same as Run Backup Now on the Backup & Recovery screen.",
        run: async () => {
          const summary = await writeBackupFile();
          return {
            ok: true,
            message: `Backup saved as ${summary.fileName} (${summary.rowCount} rows across ${summary.tableCount} tables).`,
            fileName: summary.fileName
          };
        }
      },
      "pause": {
        label: "Pause the automatic backup",
        hint: "The timer keeps ticking and skips. Use it while a disk is being swapped or a restore is being prepared outside the system.",
        danger: true,
        run: async (context) => {
          if (autoBackup.paused) return { ok: true, message: "The automatic backup was already paused." };
          autoBackup.paused = true;
          autoBackup.pausedBy = context.actor.email;
          autoBackup.pausedAt = new Date().toISOString();
          autoBackup.ticksSkipped = 0;
          console.warn(`Automatic backup paused by ${context.actor.email}.`);
          return { ok: true, message: "The automatic backup is paused. Nothing is written until it is resumed." };
        }
      },
      "resume": {
        label: "Resume the automatic backup",
        hint: "Takes a backup straight away, then carries on every minute.",
        run: async () => {
          if (!autoBackup.paused) return { ok: true, message: "The automatic backup was not paused." };
          autoBackup.paused = false;
          autoBackup.pausedBy = null;
          autoBackup.pausedAt = null;
          console.log("Automatic backup resumed.");
          await runAutoBackup();
          return {
            ok: !autoBackup.lastError,
            message: autoBackup.lastError
              ? `Resumed, but the first backup failed: ${autoBackup.lastError}`
              : `Resumed. ${autoBackup.lastFileName} was written straight away.`
          };
        }
      }
    }
  },

  "archive-sweep": {
    name: "Archive Sweep",
    description: "The nightly pass that puts away closed deliveries and dead stock.",
    status: async () => {
      const [[last]] = await db.query(
        `SELECT details, created_at FROM audit_logs
         WHERE action = 'ARCHIVE_SWEEP' ORDER BY log_id DESC LIMIT 1`);
      const [[due]] = await db.query(
        `SELECT
           (SELECT COUNT(*) FROM deliveries d JOIN sales s ON s.sale_id = d.sale_id
            WHERE d.is_archived = FALSE
              AND ((d.status = 'Delivered' AND s.payment_status = 'Paid') OR d.status = 'Failed')
              AND COALESCE(d.delivered_at, d.updated_at) < DATE_SUB(NOW(), INTERVAL 90 DAY)) AS deliveries,
           (SELECT COUNT(*) FROM products p JOIN inventory i ON i.product_id = p.product_id
            WHERE p.is_archived = FALSE AND i.quantity_in_stock = 0
              AND p.created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)) AS materials`);

      return {
        state: "ok",
        summary: `Runs at startup and once a day. ${due.deliveries} closed ` +
          `${due.deliveries === 1 ? "delivery" : "deliveries"} and up to ${due.materials} ` +
          `${due.materials === 1 ? "material" : "materials"} look due on the next pass.`,
        facts: {
          "Last pass that put something away": last ? `${last.created_at} — ${last.details}` : "Nothing yet",
          "Interval": `every ${ARCHIVE_SWEEP_MS / 3600000} hours`,
          "Deliveries past 90 days": String(due.deliveries),
          "Materials idle 180 days (upper bound)": String(due.materials)
        }
      };
    },
    actions: {
      "run-now": {
        label: "Run the sweep now",
        hint: "Applies the same two rules the nightly pass applies. Anything it puts away can be restored from Archives.",
        run: async () => {
          const before = changeVersion;
          await runArchiveSweep();
          return {
            ok: true,
            message: changeVersion > before
              ? "The sweep ran and put something away; the Archives screen has it."
              : "The sweep ran and found nothing due."
          };
        }
      }
    }
  },

  "live-sync": {
    name: "Live Sync Channel",
    description: "The open connection every signed-in browser holds, and what has been announced over it.",
    status: async () => {
      const people = new Set([...liveClients].map((client) => client.staffId)).size;
      const latest = changeLog[changeLog.length - 1];
      return {
        state: "ok",
        summary: `${liveClients.size} open ${liveClients.size === 1 ? "connection" : "connections"} ` +
          `from ${people} ${people === 1 ? "person" : "people"}; ${changeVersion} changes announced since this server started.`,
        facts: {
          "Open connections": String(liveClients.size),
          "People connected": String(people),
          "Changes announced": String(changeVersion),
          "Held for reconnection": `${changeLog.length} of ${CHANGE_LOG_SIZE}`,
          "Most recent": latest ? `${latest.scope}: ${latest.detail} at ${latest.at}` : "None yet"
        }
      };
    },
    actions: {
      "resync-all": {
        label: "Tell every screen to reload",
        hint: "Every open dashboard is told it has fallen behind and offered a reload. Use it after a restore or a change every desk must see.",
        danger: true,
        run: async () => {
          let told = 0;
          for (const client of liveClients) {
            try {
              client.response.write(`event: resync\ndata: ${JSON.stringify({ version: changeVersion })}\n\n`);
              told += 1;
            } catch (error) { /* a browser that has gone is removed by its own close handler */ }
          }
          return { ok: true, message: `${told} open ${told === 1 ? "screen was" : "screens were"} told to reload.`, told };
        }
      }
    }
  },

  mail: {
    name: "Mail Relay",
    description: "The SMTP account first passwords are sent from.",
    status: async () => {
      const configured = isMailConfigured();
      return {
        state: configured ? "ok" : "off",
        summary: configured
          ? "Set up. New and reset passwords are emailed; the fallback shows them on screen only when a send fails."
          : "Not set up on this server, so new and reset passwords are shown once on the administrator's screen instead.",
        facts: {
          "Configured": configured ? "Yes" : "No",
          "Where it is set": "public/javascript/mailer.js and mail-password.txt beside it",
          "Off for tests": process.env.HARDWARE_MAIL_OFF === "1" ? "Yes (HARDWARE_MAIL_OFF=1)" : "No"
        }
      };
    },
    actions: {
      "send-test": {
        label: "Send a test message to my own address",
        hint: "Proves the relay accepts the account's password and delivers. It goes to the address you sign in with and to nobody else.",
        run: async (context) => {
          if (!isMailConfigured()) {
            throw new Error("Mail is not set up on this server, so there is nothing to test. " +
              "Fill in the SETUP block at the top of public/javascript/mailer.js.");
          }
          if (!context.actor.email) throw new Error("Your account has no email address to send to.");

          await sendMail({
            to: context.actor.email,
            subject: "Test message from the hardware system",
            body: `Hello,\n\nThis is a test message sent from the Connected Systems screen by ` +
              `${context.actor.email} at ${new Date().toLocaleString("en-PH")}.\n\n` +
              `If you are reading it, the mail relay is working. Nothing else has to be done.\n`
          });
          return { ok: true, message: `A test message was sent to ${context.actor.email}.` };
        }
      }
    }
  }
};

const EXTERNAL_ACTIONS = {
  ping: {
    label: "Ping it",
    hint: "One request to its address, timed. The same check as the status card, written to the trail as a command.",
    run: async (context) => {
      const reply = await reachRemote(context.system.endpoint_url);
      return {
        ok: reply.ok,
        message: reply.ok
          ? `${context.system.system_name} answered HTTP ${reply.status} in ${reply.ms} ms.`
          : `${context.system.system_name} answered HTTP ${reply.status} in ${reply.ms} ms, which is not a healthy reply.`,
        httpStatus: reply.status,
        ms: reply.ms
      };
    }
  },
  send: {
    label: "Send it a message",
    hint: "Posts a short JSON message to its address, signed with who sent it and when.",
    danger: true,
    run: async (context) => {
      const message = String((context.body && context.body.message) || "").trim().slice(0, 500);
      if (message === "") throw new Error("Type the message to send first.");

      const reply = await reachRemote(context.system.endpoint_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message,
          from: context.actor.email,
          system: context.system.system_key,
          sent_at: new Date().toISOString()
        })
      });
      return {
        ok: reply.ok,
        message: reply.ok
          ? `${context.system.system_name} accepted the message (HTTP ${reply.status}).`
          : `${context.system.system_name} refused the message with HTTP ${reply.status}.`,
        httpStatus: reply.status,
        sent: message
      };
    }
  }
};

async function externalStatus(system) {
  if (!system.endpoint_url) {
    return { state: "unknown", summary: "No address is registered for this system.", facts: {} };
  }
  try {
    const reply = await reachRemote(system.endpoint_url);
    return {
      state: reply.ok ? "ok" : "bad",
      summary: reply.ok
        ? `Answering HTTP ${reply.status} in ${reply.ms} ms.`
        : `Reachable, but answering HTTP ${reply.status}.`,
      facts: { "Address": system.endpoint_url, "HTTP status": String(reply.status), "Round trip": `${reply.ms} ms` }
    };
  } catch (error) {
    return {
      state: "bad",
      summary: error.message,
      facts: { "Address": system.endpoint_url }
    };
  }
}

function actionsOf(system) {
  if (system.system_kind === "Internal") {
    const known = INTERNAL_SYSTEMS[system.system_key];
    return known ? known.actions : {};
  }
  return EXTERNAL_ACTIONS;
}

// a status that cannot be read is still a status
async function statusOf(system) {
  try {
    if (system.system_kind === "Internal") {
      const known = INTERNAL_SYSTEMS[system.system_key];
      if (!known) {
        return { state: "unknown", summary: "This server does not know how to answer for this system.", facts: {} };
      }
      return await known.status();
    }
    return await externalStatus(system);
  } catch (error) {
    return { state: "bad", summary: `Could not read its status: ${error.message}`, facts: {} };
  }
}

// the shape every screen draws
async function describeSystem(system, access) {
  const actions = access.control
    ? Object.entries(actionsOf(system)).map(([key, action]) => ({
        key: key, label: action.label, hint: action.hint || "", danger: Boolean(action.danger),
        needsMessage: key === "send"
      }))
    : [];

  return {
    key: system.system_key,
    name: system.system_name,
    kind: system.system_kind,
    description: system.description,
    endpointUrl: system.endpoint_url,
    enabled: Boolean(system.is_enabled),
    createdBy: system.created_by,
    createdAt: system.created_at,
    updatedAt: system.updated_at,
    access: access,
    status: access.monitor ? await statusOf(system) : null,
    actions: actions
  };
}

// ---------- the systems, as the caller may see them ----------
app.get("/api/systems", async (request, response) => {
  try {
    const [rows] = await db.query(`${SYSTEM_SELECT} ORDER BY cs.system_kind, cs.system_name`);

    let visible;
    if (request.actor.roleName === ADMIN) {
      visible = rows.map((row) => [row, ALL_ACCESS]);
    } else {
      const held = await permissionsOf(request.actor.staffId);
      visible = rows
        .filter((row) => held.has(row.system_key))
        .map((row) => [row, held.get(row.system_key)]);
    }

    // read side by side, so a slow external address costs its own five seconds only
    const systems = await Promise.all(visible.map(([row, access]) =>
      describeSystem(row, { monitor: access.monitor, manage: access.manage, control: access.control })));

    response.json(systems);
  } catch (error) {
    console.error("Listing systems failed:", error.message);
    response.status(500).json({ error: "Unable to list the connected systems" });
  }
});

app.get("/api/systems/:systemKey/status", requireSystemAccess("monitor"), async (request, response) => {
  try {
    response.json(await describeSystem(request.system, request.systemAccess));
  } catch (error) {
    console.error("System status failed:", error.message);
    response.status(500).json({ error: "Unable to read that system's status" });
  }
});

// ---------- registering an external system: administrator only ----------
app.post("/api/systems", requireRole(ADMIN), async (request, response) => {
  const { key, name, description, endpointUrl } = request.body || {};
  const systemKey = String(key || "").trim().toLowerCase();

  try {
    if (await findSystem(systemKey)) {
      return response.status(409).json({ error: `A system is already registered as "${systemKey}". Edit that one, or pick another key.` });
    }

    const urlProblem = remoteUrlComplaint(endpointUrl);
    if (urlProblem) return response.status(400).json({ error: urlProblem });

    const output = await callProcedure(
      "CALL sp_save_connected_system(?, ?, ?, ?, TRUE, ?, @status_code, @message, @system_id, @created)",
      [systemKey, String(name || "").trim().slice(0, 100),
       String(description || "").trim().slice(0, 255),
       String(endpointUrl || "").trim().slice(0, 255), request.actor.staffId],
      ["status_code", "message", "system_id", "created"]);

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(request, "CREATE_CONNECTED_SYSTEM",
      `Registered the external system ${name} (${systemKey}) at ${endpointUrl}`,
      { system_key: systemKey, system_name: name, endpoint_url: endpointUrl });

    response.json({ message: output.message, system: await describeSystem(await findSystem(systemKey), ALL_ACCESS) });
  } catch (error) {
    console.error("Registering a system failed:", error.message);
    response.status(500).json({ error: "Unable to register the system" });
  }
});

// ---------- changing how a system is set up: MANAGE ----------
app.put("/api/systems/:systemKey", requireSystemAccess("manage"), async (request, response) => {
  const system = request.system;
  const { name, description, endpointUrl, enabled } = request.body || {};

  const after = {
    system_name: name === undefined ? system.system_name : String(name || "").trim().slice(0, 100),
    description: description === undefined ? system.description : (String(description || "").trim().slice(0, 255) || null),
    endpoint_url: system.system_kind === "Internal"
      ? null
      : (endpointUrl === undefined ? system.endpoint_url : String(endpointUrl || "").trim().slice(0, 255)),
    is_enabled: enabled === undefined ? Boolean(system.is_enabled) : enabled === true
  };

  if (system.system_kind === "External") {
    const urlProblem = remoteUrlComplaint(after.endpoint_url);
    if (urlProblem) return response.status(400).json({ error: urlProblem });
  }

  try {
    const output = await callProcedure(
      "CALL sp_save_connected_system(?, ?, ?, ?, ?, ?, @status_code, @message, @system_id, @created)",
      [system.system_key, after.system_name, after.description, after.endpoint_url,
       after.is_enabled, request.actor.staffId],
      ["status_code", "message", "system_id", "created"]);

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    const before = {
      system_name: system.system_name, description: system.description,
      endpoint_url: system.endpoint_url, is_enabled: Boolean(system.is_enabled)
    };

    await writeAuditLog(request, "UPDATE_CONNECTED_SYSTEM",
      `${system.system_name} (${system.system_key}) settings changed` +
        (before.is_enabled !== after.is_enabled ? (after.is_enabled ? ": switched on" : ": switched off") : ""),
      { system_key: system.system_key, changes: fieldChanges(before, after) });

    response.json({
      message: output.message,
      system: await describeSystem(await findSystem(system.system_key), request.systemAccess)
    });
  } catch (error) {
    console.error("Updating a system failed:", error.message);
    response.status(500).json({ error: "Unable to save the system" });
  }
});

// ---------- running a command against a system: CONTROL ----------
app.post("/api/systems/:systemKey/actions/:action", requireSystemAccess("control"), async (request, response) => {
  const system = request.system;
  const actionKey = String(request.params.action || "").toLowerCase();
  const action = actionsOf(system)[actionKey];

  if (!action) {
    return response.status(404).json({ error: `${system.system_name} has no command called "${actionKey}".` });
  }

  // a system switched off takes no commands; switching it on is a MANAGE change
  if (!system.is_enabled) {
    return response.status(409).json({
      error: `${system.system_name} is switched off. Switch it on under its settings before running commands against it.`
    });
  }

  const context = { actor: request.actor, system: system, body: request.body || {} };

  try {
    const result = await action.run(context);

    // the command and its outcome, in one entry, whoever ran it
    await writeAuditLog(request, "SYSTEM_ACTION",
      `Ran "${action.label}" on ${system.system_name}: ${result.message}`,
      { system_key: system.system_key, action: actionKey, ok: Boolean(result.ok),
        result: Object.assign({}, result, { message: undefined }) });

    response.json(Object.assign({ system: system.system_key, action: actionKey }, result));
  } catch (error) {
    await writeAuditLog(request, "SYSTEM_ACTION",
      `Ran "${action.label}" on ${system.system_name} and it failed: ${error.message}`,
      { system_key: system.system_key, action: actionKey, ok: false, error: error.message });

    response.status(502).json({ error: error.message });
  }
});

// Who holds what: every person with a login who is not an administrator,
// including those who hold nothing.
const GRANT_SELECT = `
  SELECT p.staff_id, cs.system_key, cs.system_name, cs.system_kind, cs.is_enabled,
         p.can_monitor, p.can_manage, p.can_control, p.note,
         p.granted_at, p.updated_at, gb.full_name AS granted_by
  FROM system_permissions p
  JOIN connected_systems cs ON cs.system_id = p.system_id
  LEFT JOIN staff gb ON gb.staff_id = p.granted_by_staff_id
`;

function grantShape(row) {
  return {
    key: row.system_key,
    name: row.system_name,
    kind: row.system_kind,
    enabled: Boolean(row.is_enabled),
    monitor: Boolean(row.can_monitor),
    manage: Boolean(row.can_manage),
    control: Boolean(row.can_control),
    note: row.note,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    updatedAt: row.updated_at
  };
}

app.get("/api/access/permissions", async (request, response) => {
  try {
    const [people] = await db.query(
      `${USER_SELECT} WHERE u.user_id IS NOT NULL AND r.role_name <> ? ORDER BY s.full_name`, [ADMIN]);
    const [grants] = await db.query(`${GRANT_SELECT} ORDER BY cs.system_kind, cs.system_name`);

    const byStaff = new Map();
    for (const row of grants) {
      if (!byStaff.has(row.staff_id)) byStaff.set(row.staff_id, []);
      byStaff.get(row.staff_id).push(grantShape(row));
    }

    response.json(withPresence(people).map((person) => Object.assign({}, person, {
      grants: byStaff.get(person.staff_id) || []
    })));
  } catch (error) {
    console.error("Listing permissions failed:", error.message);
    response.status(500).json({ error: "Unable to list who holds access" });
  }
});

app.get("/api/access/users/:staffId", async (request, response) => {
  try {
    const [people] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [request.params.staffId]);
    if (people.length === 0) return response.status(404).json({ error: "Staff record not found" });

    const [grants] = await db.query(`${GRANT_SELECT} WHERE p.staff_id = ? ORDER BY cs.system_kind, cs.system_name`,
      [request.params.staffId]);

    response.json(Object.assign({}, withPresence(people)[0], { grants: grants.map(grantShape) }));
  } catch (error) {
    response.status(500).json({ error: "Unable to read that person's access" });
  }
});

// One request sets everything one person holds on one system; all three
// levels false is a revocation. notOwnAccount: an administrator grants to others.
app.put("/api/access/users/:staffId/systems/:systemKey", notOwnAccount, async (request, response) => {
  const staffId = Number(request.params.staffId);
  const systemKey = String(request.params.systemKey || "").toLowerCase();
  const body = request.body || {};

  const wanted = {
    monitor: body.monitor === true || body.manage === true || body.control === true,
    manage: body.manage === true,
    control: body.control === true
  };
  const note = String(body.note || "").trim().slice(0, 255);

  try {
    const [people] = await db.query(
      `SELECT s.full_name, r.role_name, u.email FROM staff s
       JOIN roles r ON r.role_id = s.role_id
       LEFT JOIN users u ON u.staff_id = s.staff_id WHERE s.staff_id = ?`, [staffId]);
    if (people.length === 0) return response.status(404).json({ error: "Staff record not found" });

    const system = await findSystem(systemKey);
    if (!system) return response.status(404).json({ error: "No connected system is registered under that name." });

    const output = await callProcedure(
      "CALL sp_set_system_permission(?, ?, ?, ?, ?, ?, ?, @status_code, @message, " +
      "@was_monitor, @was_manage, @was_control, @changed)",
      [staffId, systemKey, wanted.monitor, wanted.manage, wanted.control, note || null,
       request.actor.staffId],
      ["status_code", "message", "was_monitor", "was_manage", "was_control", "changed"]);

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    const before = {
      can_monitor: Boolean(output.was_monitor),
      can_manage: Boolean(output.was_manage),
      can_control: Boolean(output.was_control)
    };
    const after = {
      can_monitor: wanted.monitor,
      can_manage: wanted.manage,
      can_control: wanted.control
    };
    const changed = Boolean(output.changed);

    if (changed) {
      const revoked = !wanted.monitor;
      await writeAuditLog(request,
        revoked ? "REVOKE_SYSTEM_ACCESS" : "GRANT_SYSTEM_ACCESS",
        revoked
          ? `${people[0].full_name} no longer has any access to ${system.system_name}`
          : output.message.replace(/\.$/, ""),
        { staff_id: staffId, staff_name: people[0].full_name, role_name: people[0].role_name,
          system_key: systemKey, system_name: system.system_name,
          changes: fieldChanges(before, after), note: note || null });
    }

    const [grants] = await db.query(`${GRANT_SELECT} WHERE p.staff_id = ? AND cs.system_key = ?`,
      [staffId, systemKey]);

    response.json({
      message: changed ? output.message : "Nothing changed: those are the levels already held.",
      changed: changed,
      grant: grants[0] ? grantShape(grants[0]) : null
    });
  } catch (error) {
    console.error("Setting a permission failed:", error.message);
    response.status(500).json({ error: "Unable to change that permission" });
  }
});

// Screens by role: read as a whole, written one cell at a time.
app.get("/api/features", async (request, response) => {
  try {
    const [roleRows] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");
    const roles = roleRows.filter((row) => FEATURE_ROLES.includes(row.role_name));

    const perRole = new Map();
    for (const role of roles) {
      perRole.set(role.role_name, new Map((await featuresOf(role.role_name)).map((f) => [f.key, f])));
    }

    response.json({
      roles: roles,
      features: FEATURES.map((feature) => {
        const cells = {};
        for (const role of roles) {
          const held = perRole.get(role.role_name).get(feature.key) || null;
          cells[role.role_name] = held
            ? { available: true, byDefault: held.byDefault, held: held.held, overridden: held.overridden,
                note: held.note, grantedBy: held.grantedBy, updatedAt: held.updatedAt }
            : { available: false, byDefault: false, held: false, overridden: false };
        }
        return {
          key: feature.key,
          name: feature.name,
          module: feature.module,
          description: feature.description,
          roles: cells
        };
      })
    });
  } catch (error) {
    console.error("Listing screens by role failed:", error.message);
    response.status(500).json({ error: "Unable to list the screens by role" });
  }
});

// Setting a cell back to the role's default removes the override row rather
// than writing one that agrees with the page.
app.put("/api/features/:featureKey/roles/:roleId", async (request, response) => {
  const feature = findFeature(request.params.featureKey);
  const roleId = Number(request.params.roleId);
  const body = request.body || {};
  const wanted = body.granted === true;
  const note = String(body.note || "").trim().slice(0, 255);

  if (!feature) return response.status(404).json({ error: "No screen is listed under that name." });
  if (typeof body.granted !== "boolean") {
    return response.status(400).json({ error: "Say whether the screen is granted: true or false." });
  }

  try {
    const [roles] = await db.query("SELECT role_id, role_name FROM roles WHERE role_id = ?", [roleId]);
    if (roles.length === 0) return response.status(404).json({ error: "No such role." });
    const role = roles[0];

    if (role.role_name === ADMIN) {
      return response.status(403).json({ error: "The System Administrator holds every screen by role. Nothing here is granted or taken away." });
    }
    if (!feature.available.includes(role.role_name)) {
      return response.status(400).json({
        error: `The ${role.role_name} dashboard has no ${feature.name} screen to show, so it cannot be granted there.`
      });
    }

    const before = (await featuresOf(role.role_name)).find((f) => f.key === feature.key);
    const byDefault = feature.defaults.includes(role.role_name);

    if (before.held === wanted && (wanted === byDefault || (before.note || "") === note)) {
      return response.json({
        message: `Nothing changed: ${role.role_name} accounts already ${wanted ? "hold" : "do not hold"} ${feature.name}.`,
        changed: false
      });
    }

    if (wanted === byDefault) {
      await db.query("DELETE FROM role_feature_permissions WHERE role_id = ? AND feature_key = ?",
        [roleId, feature.key]);
    } else {
      await db.query(
        `INSERT INTO role_feature_permissions (role_id, feature_key, is_granted, note, granted_by_staff_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_granted = VALUES(is_granted), note = VALUES(note),
                                 granted_by_staff_id = VALUES(granted_by_staff_id)`,
        [roleId, feature.key, wanted, note || null, request.actor.staffId]);
    }
    forgetFeatureOverrides();

    const message = wanted
      ? `${feature.name} is now on the ${role.role_name} menu${byDefault ? " again" : ""}.`
      : `${feature.name} is off the ${role.role_name} menu${byDefault ? "" : " again"}.`;

    if (before.held !== wanted) {
      await writeAuditLog(request, wanted ? "GRANT_SCREEN" : "REVOKE_SCREEN",
        `${feature.name} switched ${wanted ? "on" : "off"} for ${role.role_name} accounts`,
        { role_id: roleId, role_name: role.role_name, feature_key: feature.key, feature_name: feature.name,
          by_default: byDefault,
          changes: fieldChanges({ held: before.held }, { held: wanted }), note: note || null });
    }

    const after = (await featuresOf(role.role_name)).find((f) => f.key === feature.key);
    response.json({ message: message, changed: true, cell: after });
  } catch (error) {
    console.error("Switching a screen failed:", error.message);
    response.status(500).json({ error: "Unable to change that screen" });
  }
});

app.get("/api/backups", async (request, response) => {
  try {
    await ensureBackupFolder();
    const names = (await fsp.readdir(BACKUP_DIR)).filter((name) => BACKUP_NAME.test(name));

    const files = await Promise.all(names.map(async (name) => {
      const stats = await fsp.stat(path.join(BACKUP_DIR, name));
      return {
        fileName: name,
        bytes: stats.size,
        createdAt: stats.mtime.toISOString(),
        // so a row can say which kind it is
        automatic: AUTO_NAME.test(name)
      };
    }));

    files.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    response.json({
      folder: BACKUP_DIR,
      files: files,
      auto: {
        enabled: AUTO_BACKUP_ENABLED,
        everySeconds: AUTO_BACKUP_MS / 1000,
        keep: AUTO_KEEP,
        lastFileName: autoBackup.lastFileName,
        lastAt: autoBackup.lastAt,
        lastError: autoBackup.lastError,
        failures: autoBackup.failures,
        rotationHeld: autoBackup.rotationHeld,
        paused: autoBackup.paused,
        pausedBy: autoBackup.pausedBy,
        pausedAt: autoBackup.pausedAt
      },
      // so the screen can say the one thing that stops every write
      procedures: {
        loaded: proceduresLoaded,
        expected: EXPECTED_PROCEDURES
      }
    });
  } catch (error) {
    console.error("Backup list failed:", error.message);
    response.status(500).json({ error: "Unable to read the backup folder" });
  }
});

app.post("/api/backups", requireRole(ADMIN), async (request, response) => {
  try {
    const summary = await writeBackupFile();

    await writeAuditLog(request, "BACKUP",
      `${summary.fileName} (${summary.tableCount} tables, ${summary.rowCount} rows)`);

    response.json({
      message: `Backup saved as ${summary.fileName}.`,
      ...summary
    });
  } catch (error) {
    console.error("Backup failed:", error.message);
    response.status(500).json({ error: "Unable to create the backup: " + error.message });
  }
});

app.get("/api/backups/:fileName", async (request, response) => {
  const name = request.params.fileName;

  if (!BACKUP_NAME.test(name)) {
    return response.status(400).json({ error: "That is not a backup file name." });
  }

  const fullPath = path.join(BACKUP_DIR, name);

  if (!fs.existsSync(fullPath)) {
    return response.status(404).json({ error: "That backup is no longer in the folder." });
  }

  response.download(fullPath, name);
});

app.delete("/api/backups/:fileName", requireRole(ADMIN), async (request, response) => {
  const name = request.params.fileName;

  if (!BACKUP_NAME.test(name)) {
    return response.status(400).json({ error: "That is not a backup file name." });
  }

  try {
    await fsp.unlink(path.join(BACKUP_DIR, name));
    await writeAuditLog(request, "BACKUP_DELETE", name);
    response.json({ message: `${name} deleted.` });
  } catch (error) {
    if (error.code === "ENOENT") {
      return response.status(404).json({ error: "That backup is no longer in the folder." });
    }
    console.error("Backup delete failed:", error.message);
    response.status(500).json({ error: "Unable to delete that backup" });
  }
});

// A backup taken without procedures restores without error and leaves the
// system unable to save, so the count is taken AFTER the restore and reported
// with the success. Returns "" when all is well.
async function restoreShortfall() {
  try {
    proceduresLoaded = null;                 // force a fresh count
    procedureCheckAt = 0;
    const total = await countProcedures();
    if (total >= EXPECTED_PROCEDURES) return "";

    return ` WARNING: that backup did not carry the stored procedures -- this ` +
      `database now has ${total} of ${EXPECTED_PROCEDURES} and nothing can be ` +
      `saved until they are put back. Run ` +
      `public/database/2-RUN-SECOND-stored-procedures.sql. Your data is intact.`;
  } catch (error) {
    return "";
  }
}

app.post("/api/backups/:fileName/restore", requireRole(ADMIN), async (request, response) => {
  const name = request.params.fileName;

  if (!BACKUP_NAME.test(name)) {
    return response.status(400).json({ error: "That is not a backup file name." });
  }

  const fullPath = path.join(BACKUP_DIR, name);

  if (!fs.existsSync(fullPath)) {
    return response.status(404).json({ error: "That backup is no longer in the folder." });
  }

  try {
    const count = await runSqlScript(await fsp.readFile(fullPath, "utf8"));
    await writeAuditLog(request, "RESTORE", `Restored from ${name}`);
    response.json({
      message: `Database restored from ${name}. ${count} statements ran.` +
        await restoreShortfall()
    });
  } catch (error) {
    console.error("Restore failed:", error.message);
    response.status(500).json({ error: "Restore failed: " + error.message });
  }
});

app.post("/api/restore", requireRole(ADMIN), async (request, response) => {
  const sql = request.body && request.body.sql;

  if (typeof sql !== "string" || sql.trim() === "") {
    return response.status(400).json({ error: "The file is empty or is not a .sql backup." });
  }

  try {
    const count = await runSqlScript(sql);
    await writeAuditLog(request, "RESTORE", "Restored from an uploaded .sql file");
    response.json({
      message: `Database restored. ${count} statements ran.` + await restoreShortfall()
    });
  } catch (error) {
    console.error("Restore failed:", error.message);
    response.status(500).json({ error: "Restore failed: " + error.message });
  }
});

// ==========================================
// MANAGER MODULE
// ==========================================

// Date ranges are counted back from today rather than snapped to calendar
// boundaries: "this month" on the third would read as a collapse.
const REPORT_RANGES = {
  daily:     { days: 1,   label: "Today" },
  weekly:    { days: 7,   label: "Last 7 days" },
  monthly:   { days: 30,  label: "Last 30 days" },
  quarterly: { days: 90,  label: "Last 90 days" },
  "six-month": { days: 182, label: "Last 6 months" },
  annual:    { days: 365, label: "Last 12 months" },
  all:       { days: null, label: "All time" }
};

function isDateText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

// The calendar day this machine is having: toISOString() answers in UTC,
// which disagreed with CURDATE() for the first eight hours of every day.
function isoDay(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// { from, to, label, bucket }; a custom pair always wins over a named range
function resolveRange(query) {
  const from = String(query.from || "");
  const to = String(query.to || "");

  if (isDateText(from) && isDateText(to)) {
    const start = from <= to ? from : to;
    const end = from <= to ? to : from;
    return { from: start, to: end, label: `${start} to ${end}`, bucket: bucketFor(start, end) };
  }

  const name = String(query.range || "monthly").toLowerCase();
  const range = REPORT_RANGES[name] || REPORT_RANGES.monthly;
  const today = new Date();
  const end = isoDay(today);

  if (range.days === null) {
    return { from: "2000-01-01", to: end, label: range.label, bucket: "month" };
  }

  const start = new Date(today);
  start.setDate(start.getDate() - (range.days - 1));

  return {
    from: isoDay(start),
    to: end,
    label: range.label,
    bucket: bucketFor(isoDay(start), end)
  };
}

// the bucket follows the span: 365 columns is a smear, 2 is nothing
function bucketFor(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days <= 62) return "day";
  if (days <= 200) return "week";
  return "month";
}

const BUCKET_SQL = {
  day: "DATE(s.sale_date)",
  week: "DATE(DATE_SUB(s.sale_date, INTERVAL WEEKDAY(s.sale_date) DAY))",
  month: "DATE_FORMAT(s.sale_date, '%Y-%m-01')"
};

// The income breakdown: billed, collected (the headline), outstanding and
// discounts. One function behind both the screen and the export.
async function incomeReport(range) {
  const bucket = BUCKET_SQL[range.bucket] || BUCKET_SQL.day;
  const window = [`${range.from} 00:00:00`, `${range.to} 23:59:59`];

  {
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(s.total_amount), 0) AS gross,
              COALESCE(SUM(s.discount), 0) AS discounts,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(GREATEST(s.final_amount - s.amount_paid, 0)), 0) AS outstanding
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?`,
      window
    );

    const [[units]] = await db.query(
      `SELECT COALESCE(SUM(si.quantity), 0) AS units_sold
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?`,
      window
    );

    const [series] = await db.query(
      `SELECT ${bucket} AS bucket,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?
       GROUP BY bucket
       ORDER BY bucket`,
      window
    );

    const [methods] = await db.query(
      `SELECT s.payment_method,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(GREATEST(s.final_amount - s.amount_paid, 0)), 0) AS outstanding
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?
       GROUP BY s.payment_method
       ORDER BY billed DESC`,
      window
    );

    const [products] = await db.query(
      `SELECT p.product_id, p.product_name, u.unit_name,
              COALESCE(SUM(si.quantity), 0) AS units_sold,
              COALESCE(SUM(si.subtotal), 0) AS revenue
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?
       GROUP BY p.product_id, p.product_name, u.unit_name
       ORDER BY revenue DESC
       LIMIT 10`,
      window
    );

    const [cashiers] = await db.query(
      `SELECT st.staff_id, st.full_name AS staff_name,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?
       GROUP BY st.staff_id, st.full_name
       ORDER BY billed DESC`,
      window
    );

    const saleCount = Number(totals.sale_count) || 0;

    return {
      range: {
        from: range.from,
        to: range.to,
        label: range.label,
        bucket: range.bucket
      },
      totals: {
        saleCount: saleCount,
        unitsSold: Number(units.units_sold) || 0,
        gross: totals.gross,
        discounts: totals.discounts,
        billed: totals.billed,
        collected: totals.collected,
        outstanding: totals.outstanding,
        averageSale: saleCount === 0 ? 0 : Number(totals.billed) / saleCount
      },
      series,
      methods,
      products,
      cashiers
    };
  }
}

app.get("/api/reports/income", async (request, response) => {
  try {
    const report = await incomeReport(resolveRange(request.query));
    report.range.name = String(request.query.range || "custom");
    response.json(report);
  } catch (error) {
    console.error("Income report failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Exports are CSV: every spreadsheet opens one and nothing here wants a
// formula. The access table is what stops a cashier exporting.
function csvCell(value) {
  if (value === null || value === undefined) return "";

  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDocument(headers, rows) {
  // BOM so Excel on Windows reads UTF-8; an empty header list means the
  // report writes its own section headers among the rows
  const lines = rows.map((row) => row.map(csvCell).join(","));
  if (headers.length > 0) lines.unshift(headers.map(csvCell).join(","));

  return "﻿" + lines.join("\r\n") + "\r\n";
}

function sendCsv(response, fileName, headers, rows) {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  response.send(csvDocument(headers, rows));
}

const EXPORTS = {
  "payment-methods": {
    title: "payment-methods",
    headers: ["Method", "Sales", "Billed", "Collected", "Outstanding"],
    rows: (data) => data.methods.map((m) =>
      [m.payment_method, m.sale_count, m.billed, m.collected, m.outstanding])
  },
  "top-products": {
    title: "top-products",
    headers: ["Product", "Unit", "Units Sold", "Revenue"],
    rows: (data) => data.products.map((p) =>
      [p.product_name, p.unit_name || "", p.units_sold, p.revenue])
  },
  "staff-sales": {
    title: "staff-sales",
    headers: ["Staff", "Sales", "Billed", "Collected"],
    rows: (data) => data.cashiers.map((c) =>
      [c.staff_name, c.sale_count, c.billed, c.collected])
  },
  "income-series": {
    title: "income-over-time",
    headers: ["Period", "Sales", "Billed", "Collected"],
    rows: (data) => data.series.map((s) =>
      [String(s.bucket).slice(0, 10), s.sale_count, s.billed, s.collected])
  },
  "income-summary": {
    title: "income-summary",
    headers: ["Figure", "Value"],
    rows: (data) => [
      ["Range", data.range.label],
      ["From", data.range.from],
      ["To", data.range.to],
      ["Transactions", data.totals.saleCount],
      ["Units sold", data.totals.unitsSold],
      ["Gross", data.totals.gross],
      ["Discounts", data.totals.discounts],
      ["Billed", data.totals.billed],
      ["Collected", data.totals.collected],
      ["Outstanding", data.totals.outstanding],
      ["Average sale", data.totals.averageSale]
    ]
  },

  // the whole income screen in one file
  "income-breakdown": {
    title: "income-breakdown",
    headers: [],
    rows: (data) => {
      const section = (name, headers, body) =>
        [[], [name], headers, ...body];

      return [
        ["Income breakdown", data.range.label, `${data.range.from} to ${data.range.to}`],
        ...section("Summary", ["Figure", "Value"], EXPORTS["income-summary"].rows(data).slice(3)),
        ...section("Over time", EXPORTS["income-series"].headers, EXPORTS["income-series"].rows(data)),
        ...section("By payment method", EXPORTS["payment-methods"].headers, EXPORTS["payment-methods"].rows(data)),
        ...section("Best sellers", EXPORTS["top-products"].headers, EXPORTS["top-products"].rows(data)),
        ...section("Who sold it", EXPORTS["staff-sales"].headers, EXPORTS["staff-sales"].rows(data))
      ];
    }
  }
};

app.get("/api/reports/export", async (request, response) => {
  const name = String(request.query.report || "");
  const plan = EXPORTS[name];

  if (!plan) {
    return response.status(400).json({
      error: `There is no report called "${name}". Try one of: ${Object.keys(EXPORTS).join(", ")}.`
    });
  }

  const range = resolveRange(request.query);

  try {
    const data = await incomeReport(range);
    const rows = plan.rows(data);

    await writeAuditLog(request, "EXPORT_REPORT",
      `${plan.title} exported for ${range.label}`,
      { report: name, from: range.from, to: range.to, rows: rows.length });

    sendCsv(response, `${plan.title}_${range.from}_to_${range.to}.csv`, plan.headers, rows);
  } catch (error) {
    console.error("Report export failed:", error.message);
    response.status(500).json({ error: "Unable to build that export" });
  }
});

// The daily tally for a cashier or clerk: one day on the screen. A manager
// sees the whole shop's day. canExport is a convenience, not the control.
app.get("/api/reports/daily-tally", async (request, response) => {
  const day = isDateText(request.query.date) ? request.query.date : null;
  const actor = request.actor;
  const wholeShop = actor.roleName === MANAGER;

  const scope = wholeShop ? "" : "AND s.cashier_staff_id = ?";
  const params = wholeShop ? [day] : [day, actor.staffId];

  try {
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(s.discount), 0) AS discounts,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(s.change_given), 0) AS change_given,
              COALESCE(SUM(CASE WHEN s.payment_method = 'Cash'
                                THEN s.amount_paid - s.change_given ELSE 0 END), 0) AS cash_drawer
       FROM sales s
       WHERE s.is_archived = FALSE AND DATE(s.sale_date) = COALESCE(?, CURDATE()) ${scope}`,
      params
    );

    const [methods] = await db.query(
      `SELECT s.payment_method, COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       WHERE s.is_archived = FALSE AND DATE(s.sale_date) = COALESCE(?, CURDATE()) ${scope}
       GROUP BY s.payment_method
       ORDER BY billed DESC`,
      params
    );

    response.json({
      date: day,
      scope: wholeShop ? "Whole shop" : "Your own sales",
      canExport: wholeShop,
      totals,
      methods
    });
  } catch (error) {
    console.error("Daily tally failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Dashboard headline numbers. Gross sales is what was billed and total income
// what was collected; the difference is the outstanding balance.
app.get("/api/manager/summary", async (request, response) => {
  try {
    const [[sales]] = await db.query(
      `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS gross_sales
       FROM sales WHERE is_archived = FALSE`
    );
    // the tile opens Reorder Alerts, so it counts what that screen lists
    const [[stock]] = await db.query(
      `SELECT COUNT(*) AS product_count FROM products p WHERE p.is_archived = FALSE`
    );
    const [[lowStock]] = await db.query(LOW_STOCK_EFFECTIVE_SQL,
      [SALES_WINDOW_DAYS, SALES_WINDOW_DAYS, SALES_WINDOW_DAYS]);
    stock.low_stock = lowStock.n;
    const [[delivery]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('Pending','In Transit','Out for Delivery') THEN 1 ELSE 0 END), 0) AS in_progress,
              COALESCE(SUM(CASE WHEN status IN ('Delayed','Failed') THEN 1 ELSE 0 END), 0) AS problem
       FROM deliveries WHERE is_archived = FALSE`
    );

    const [[income]] = await db.query(
      `SELECT COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected,
              COALESCE(SUM(CASE WHEN DATE(sale_date) = CURDATE()
                                THEN LEAST(amount_paid, final_amount) ELSE 0 END), 0) AS collected_today
       FROM sales WHERE is_archived = FALSE`
    );

    const [[credits]] = await db.query(
      `SELECT COUNT(*) AS open_accounts,
              COALESCE(SUM(GREATEST(final_amount - amount_paid, 0)), 0) AS owed
       FROM sales
       WHERE is_archived = FALSE AND payment_status <> 'Paid'`
    );

    response.json({
      saleCount: sales.sale_count,
      grossSales: sales.gross_sales,
      totalIncome: income.collected,
      incomeToday: income.collected_today,
      pendingCredits: credits.owed,
      pendingCreditCount: credits.open_accounts,
      productCount: stock.product_count,
      reorderAlerts: stock.low_stock,
      deliveriesInProgress: delivery.in_progress,
      deliveryProblems: delivery.problem
    });
  } catch (error) {
    console.error("Manager summary failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// REPORTS: payment method mix, receivables, loyal customers
app.get("/api/reports/overview", async (request, response) => {
  try {
    const [methods] = await db.query(
      `SELECT payment_method,
              COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS total_amount,
              COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN final_amount ELSE 0 END), 0) AS paid_amount,
              COALESCE(SUM(CASE WHEN payment_status <> 'Paid' THEN final_amount - amount_paid ELSE 0 END), 0) AS balance_due
       FROM sales WHERE is_archived = FALSE
       GROUP BY payment_method
       ORDER BY total_amount DESC`
    );

    const [unpaid] = await db.query(
      `SELECT s.sale_id, s.payment_method, s.payment_status, s.sale_date,
              s.final_amount, s.amount_paid,
              (s.final_amount - s.amount_paid) AS balance_due,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              st.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.is_archived = FALSE AND s.payment_status <> 'Paid'
       ORDER BY s.sale_date DESC`
    );

    const [loyal] = await db.query(
      `SELECT c.customer_id,
              TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
              c.phone,
              COUNT(s.sale_id) AS purchase_count,
              COALESCE(SUM(s.final_amount), 0) AS total_spent,
              COALESCE(SUM(CASE WHEN s.payment_status <> 'Paid' THEN s.final_amount - s.amount_paid ELSE 0 END), 0) AS balance_due,
              MAX(s.sale_date) AS last_purchase
       FROM customers c
       JOIN sales s ON s.customer_id = c.customer_id AND s.is_archived = FALSE
       GROUP BY c.customer_id, c.first_name, c.last_name, c.phone
       HAVING COUNT(s.sale_id) >= 2
       ORDER BY purchase_count DESC, total_spent DESC`
    );

    // Sales belong to the transaction, not to whether the person still works
    // here; cashiers on duty with no sales still show as zero. is_active labels a leaver.
    const [staffPerf] = await db.query(
      `SELECT st.staff_id, st.full_name AS staff_name,
              r.role_name, st.is_active,
              COUNT(s.sale_id) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS total_sales
       FROM staff st
       JOIN roles r ON r.role_id = st.role_id
       LEFT JOIN sales s ON s.cashier_staff_id = st.staff_id AND s.is_archived = FALSE
       GROUP BY st.staff_id, st.full_name, r.role_name, st.is_active
       HAVING COUNT(s.sale_id) > 0
           OR (st.is_active = TRUE AND r.role_name = 'Cashier')
       ORDER BY total_sales DESC`
    );

    response.json({ methods, unpaid, loyal, staffPerf });
  } catch (error) {
    console.error("Reports overview failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// ==========================================
// THE SALES LIST
//
// Two derived filters: PAYMENT GROUP (the four electronic methods answer as
// one) and TRANSACTION STATUS, which is not payment_status:
//   Voided           archived; it did not happen
//   Pending Delivery goods booked out and not yet arrived
//   Partial Credit   money still owed
//   Completed        paid, and collected or delivered
// ==========================================
const SALE_STATUS_SQL = `
  CASE
    WHEN s.is_archived = TRUE THEN 'Voided'
    WHEN d.delivery_id IS NOT NULL AND d.status <> 'Delivered' THEN 'Pending Delivery'
    WHEN s.payment_status <> 'Paid' THEN 'Partial Credit'
    ELSE 'Completed'
  END`;

const PAYMENT_GROUP_SQL = `
  CASE
    WHEN s.payment_method IN ('GCash','PayMaya','PayPal','Bank Transfer') THEN 'Online Payment'
    ELSE s.payment_method
  END`;

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

app.get("/api/sales", async (request, response) => {
  const method = String(request.query.method || "all");
  const status = String(request.query.status || "all");
  const from = String(request.query.from || "");
  const to = String(request.query.to || "");

  // a voided sale is archived, so it is outside the default list
  const where = [status === "Voided" ? "s.is_archived = TRUE" : "s.is_archived = FALSE"];
  const params = [];

  if (method !== "all") {
    where.push(`${PAYMENT_GROUP_SQL} = ?`);
    params.push(method);
  }

  if (status !== "all" && status !== "Voided") {
    where.push(`${SALE_STATUS_SQL} = ?`);
    params.push(status);
  }

  if (isDateText(from)) { where.push("s.sale_date >= ?"); params.push(`${from} 00:00:00`); }
  if (isDateText(to))   { where.push("s.sale_date <= ?"); params.push(`${to} 23:59:59`); }

  try {
    const [rows] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, s.discount, s.final_amount,
              s.amount_paid, s.change_given, s.payment_method, s.payment_status, s.reference_no,
              s.cashier_staff_id, s.is_archived,
              GREATEST(s.final_amount - s.amount_paid, 0) AS balance_due,
              ${PAYMENT_GROUP_SQL} AS payment_group,
              ${SALE_STATUS_SQL} AS transaction_status,
              d.delivery_id, d.status AS delivery_status,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              st.full_name AS cashier_name,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE ${where.join(" AND ")}
       ORDER BY s.sale_date DESC`,
      params
    );
    response.json(rows);
  } catch (error) {
    console.error("Sales list failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// ==========================================
// CREDIT MANAGEMENT
//
// Every balance is derived in vw_customer_credit from the sales themselves;
// nothing about a balance is stored, so nothing can go stale.
// ==========================================

app.get("/api/credit/customers", async (request, response) => {
  const standing = String(request.query.standing || "all");
  const search = String(request.query.search || "").trim();

  const where = [];
  const params = [];

  if (["Good", "Watch", "Hold"].includes(standing)) {
    where.push("v.standing = ?");
    params.push(standing);
  }

  if (request.query.owing === "true") where.push("v.current_credit > 0");

  if (request.query.overLimit === "true") where.push("v.current_credit > v.credit_limit");

  if (search !== "") {
    where.push("(v.customer_name LIKE ? OR v.phone LIKE ?)");
    params.push(searchPrefix(search), searchPrefix(search));
  }

  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await db.query(
      `SELECT v.*,
              (SELECT COUNT(*) FROM credit_requests r
               WHERE r.customer_id = v.customer_id AND r.status = 'Pending') AS pending_requests
       FROM vw_customer_credit v
       ${filter}
       ORDER BY v.current_credit DESC, v.customer_name`,
      params
    );
    response.json(rows);
  } catch (error) {
    console.error("Credit list failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/credit/customers/:customerId", async (request, response) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM vw_customer_credit WHERE customer_id = ?",
      [request.params.customerId]
    );

    if (rows.length === 0) {
      return response.status(404).json({ error: "That customer was not found." });
    }

    const [requests] = await db.query(
      `SELECT r.*, rb.full_name AS requested_by, db.full_name AS decided_by
       FROM credit_requests r
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       WHERE r.customer_id = ?
       ORDER BY r.request_id DESC
       LIMIT 20`,
      [request.params.customerId]
    );

    response.json({ credit: rows[0], requests });
  } catch (error) {
    console.error("Credit read failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.put("/api/credit/customers/:customerId/limit", requireRole(MANAGER), async (request, response) => {
  const { creditLimit, standing, notes } = request.body;

  const limit = Number(creditLimit);
  if (!Number.isFinite(limit) || limit < 0) {
    return response.status(400).json({
      error: "A credit limit cannot be negative. Use zero for a cash-only customer."
    });
  }

  try {
    const [before] = await db.query(
      "SELECT customer_name, credit_limit, manual_standing AS standing FROM vw_customer_credit WHERE customer_id = ?",
      [request.params.customerId]
    );

    const output = await callProcedure(
      "CALL sp_set_credit_limit(?, ?, ?, ?, ?, @status_code, @message)",
      [request.params.customerId, limit, standing || "Good",
       notes || null, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(
      request,
      "UPDATE_CREDIT_LIMIT",
      `${before[0] ? before[0].customer_name : "Customer"} set to ${limit} (${standing || "Good"})`,
      {
        customer_id: Number(request.params.customerId),
        changes: fieldChanges(
          before[0] ? { credit_limit: before[0].credit_limit, standing: before[0].standing } : null,
          { credit_limit: limit, standing: standing || "Good" })
      }
    );

    response.json({ message: output.message });
  } catch (error) {
    console.error("Credit limit failed:", error.message);
    response.status(500).json({ error: "Unable to save the credit limit" });
  }
});

app.get("/api/credit/requests", async (request, response) => {
  const status = String(request.query.status || "all");

  const where = [];
  const params = [];

  if (["Pending", "Approved", "Declined"].includes(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  try {
    const [rows] = await db.query(
      `SELECT r.*,
              TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
              c.phone,
              rb.full_name AS requested_by,
              db.full_name AS decided_by,
              v.current_credit, v.standing
       FROM credit_requests r
       JOIN customers c ON c.customer_id = r.customer_id
       LEFT JOIN vw_customer_credit v ON v.customer_id = r.customer_id
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY FIELD(r.status, 'Pending', 'Approved', 'Declined'), r.request_id DESC
       LIMIT 200`,
      params
    );
    response.json(rows);
  } catch (error) {
    console.error("Credit requests failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/credit/requests", async (request, response) => {
  const { customerId, requestedLimit, reason } = request.body;

  const limit = Number(requestedLimit);
  if (!customerId || !Number.isFinite(limit) || limit <= 0) {
    return response.status(400).json({ error: "A customer and a requested limit are required" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_request_credit_extension(?, ?, ?, ?, @request_id, @status_code, @message)",
      [customerId, limit, reason || null, getActorId(request)],
      ["request_id", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(request, "CREDIT_REQUEST",
      `Extension to ${limit} asked for on customer #${customerId}`,
      { customer_id: Number(customerId), requested_limit: limit, reason: reason || null });

    response.json({ message: output.message, requestId: output.request_id });
  } catch (error) {
    console.error("Credit request failed:", error.message);
    response.status(500).json({ error: "Unable to raise the request" });
  }
});

app.post("/api/credit/requests/:requestId/decide", requireRole(MANAGER), async (request, response) => {
  const approve = request.body.approve === true;
  const note = request.body.note;

  // declining says why or it does not happen
  if (!approve && (typeof note !== "string" || note.trim() === "")) {
    return response.status(400).json({
      error: "Say why the request was declined, so whoever asked knows what to tell the customer."
    });
  }

  try {
    const output = await callProcedure(
      "CALL sp_decide_credit_request(?, ?, ?, ?, @status_code, @message)",
      [request.params.requestId, approve, note || null, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(
      request,
      approve ? "CREDIT_APPROVED" : "CREDIT_DECLINED",
      `Request #${request.params.requestId} ${approve ? "approved" : "declined"}`,
      { request_id: Number(request.params.requestId), approved: approve, note: note || null }
    );

    response.json({ message: output.message });
  } catch (error) {
    console.error("Credit decision failed:", error.message);
    response.status(500).json({ error: "Unable to record the decision" });
  }
});

// One customer in full: what they bought beside what they have paid.
app.get("/api/customers/:customerId/history", async (request, response) => {
  const customerId = request.params.customerId;

  try {
    const [credit] = await db.query(
      "SELECT * FROM vw_customer_credit WHERE customer_id = ?", [customerId]);

    if (credit.length === 0) {
      return response.status(404).json({ error: "That customer was not found." });
    }

    const [purchases] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, s.discount, s.final_amount,
              s.amount_paid, s.payment_method, s.payment_status, s.reference_no,
              s.is_archived,
              GREATEST(s.final_amount - s.amount_paid, 0) AS balance_due,
              st.full_name AS cashier_name,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count,
              d.delivery_id, d.status AS delivery_status
       FROM sales s
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE s.customer_id = ?
       ORDER BY s.sale_date DESC`,
      [customerId]
    );

    const [payments] = await db.query(
      `SELECT p.payment_id, p.sale_id, p.amount, p.payment_method,
              p.reference_no, p.payment_date,
              COALESCE(st.full_name, 'Unknown') AS received_by
       FROM credit_payments p
       LEFT JOIN staff st ON st.staff_id = p.received_by_staff_id
       WHERE p.customer_id = ?
       ORDER BY p.payment_date DESC`,
      [customerId]
    );

    const [requests] = await db.query(
      `SELECT r.*, rb.full_name AS requested_by, db.full_name AS decided_by
       FROM credit_requests r
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       WHERE r.customer_id = ?
       ORDER BY r.request_id DESC`,
      [customerId]
    );

    const [products] = await db.query(
      `SELECT p.product_name, u.unit_name,
              SUM(si.quantity) AS units, SUM(si.subtotal) AS spent,
              MAX(s.sale_date) AS last_bought
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE s.customer_id = ? AND s.is_archived = FALSE
       GROUP BY p.product_id, p.product_name, u.unit_name
       ORDER BY spent DESC
       LIMIT 10`,
      [customerId]
    );

    response.json({ credit: credit[0], purchases, payments, requests, products });
  } catch (error) {
    console.error("Customer history failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Open an account from the counter. The procedure sets the limit to zero and
// the standing to Good; moving the limit is manager-only.
app.post("/api/customers", async (request, response) => {
  const { firstName, lastName, phone, address } = request.body;

  if (!firstName || String(firstName).trim() === "") {
    return response.status(400).json({ error: "A customer needs at least a first name" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_customer(?, ?, ?, ?, ?, @customer_id, @status_code, @message)",
      [String(firstName).trim().slice(0, 100),
       String(lastName || "").trim().slice(0, 100),
       String(phone || "").trim().slice(0, 20),
       String(address || "").trim(),
       getActorId(request)],
      ["customer_id", "status_code", "message"]
    );

    // 200: the account already existed and was handed back; 201: a new one
    if (output.status_code !== 201 && output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.status(output.status_code === 201 ? 201 : 200).json({
      message: output.message,
      customerId: output.customer_id,
      created: output.status_code === 201
    });
  } catch (error) {
    console.error("Create customer failed:", error.message);
    response.status(500).json({ error: "Unable to create the customer" });
  }
});

// Who the shop is and how it is registered. Above the 3,000,000 threshold a
// shop is VAT-registered with 12% inside its prices; below it charges no VAT.
const DEFAULT_STORE_SETTINGS = {
  store_name: "Hardware Sales & Inventory",
  address: "Set your address in System Administration",
  tin: "000-000-000-00000",
  registration_type: "VAT",
  vat_rate: "12.00",
  invoice_note: null
};

app.get("/api/store-settings", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT setting_id, store_name, address, tin, registration_type,
              vat_rate, invoice_note, updated_at,
              st.full_name AS updated_by
       FROM store_settings cfg
       LEFT JOIN staff st ON st.staff_id = cfg.updated_by_staff_id
       WHERE cfg.setting_id = 1`
    );

    // a database mid-install has no row yet; the defaults keep the till printing
    response.json(rows[0] || DEFAULT_STORE_SETTINGS);
  } catch (error) {
    console.error("Store settings failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.put("/api/store-settings", requireRole(ADMIN), async (request, response) => {
  const { storeName, address, tin, registrationType, vatRate, invoiceNote } = request.body;

  // refused with the reason: this is printed at the head of every invoice
  const tinProblem = tinComplaint(tin);
  if (tinProblem) return response.status(400).json({ error: tinProblem });

  const storedTin = cleanTin(tin);

  try {
    // read first, so the trail can say what stood before
    const [existing] = await db.query(
      `SELECT store_name, address, tin, registration_type, vat_rate, invoice_note
       FROM store_settings WHERE setting_id = 1`
    );

    const output = await callProcedure(
      "CALL sp_update_store_settings(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [String(storeName || "").trim().slice(0, 150),
       String(address || "").trim().slice(0, 255),
       storedTin,
       String(registrationType || "").trim().toUpperCase(),
       Number(vatRate) || 0,
       String(invoiceNote || "").trim().slice(0, 255),
       getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(
      request,
      "UPDATE_STORE_SETTINGS",
      `Store details and tax registration updated`,
      {
        changes: fieldChanges(existing[0] || null, {
          store_name: String(storeName || "").trim().slice(0, 150),
          address: String(address || "").trim().slice(0, 255),
          tin: storedTin,
          registration_type: String(registrationType || "").trim().toUpperCase(),
          vat_rate: Number(vatRate) || 0,
          invoice_note: String(invoiceNote || "").trim().slice(0, 255)
        })
      }
    );

    response.json({ message: output.message });
  } catch (error) {
    console.error("Save store settings failed:", error.message);
    response.status(500).json({ error: "Unable to save the store settings" });
  }
});

// ==========================================
// CASHIER MODULE
// ==========================================

// Ring up a sale. The procedure deducts stock, checks the limit and standing,
// and decides paid, part paid or on the book. downPaymentMethod is how the
// money on a Credit sale actually arrived.
app.post("/api/sales", async (request, response) => {
  const { customerId, walkInName, discount, amountPaid, paymentMethod, items, downPaymentMethod } = request.body;

  if (!paymentMethod || !Array.isArray(items) || items.length === 0) {
    return response.status(400).json({ error: "A payment method and at least one item are required" });
  }

  const TENDER_METHODS = ["Cash", "Cheque", "GCash", "PayMaya", "PayPal", "Bank Transfer"];
  const downMethod = TENDER_METHODS.includes(downPaymentMethod) ? downPaymentMethod : "Cash";

  // trimmed and capped to the column (150) rather than failing the sale
  const typedName = typeof walkInName === "string"
    ? walkInName.trim().slice(0, 150)
    : "";

  try {
    const output = await callProcedure(
      "CALL sp_create_sale_transaction(?, ?, ?, ?, ?, ?, ?, ?, @sale_id, @status_code, @message)",
      [customerId || null, typedName || null, getActorId(request), discount || 0, amountPaid || 0,
       paymentMethod, JSON.stringify(items), downMethod],
      ["sale_id", "status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message, saleId: output.sale_id });
  } catch (error) {
    console.error("Create sale failed:", error.message);
    response.status(500).json({ error: "Unable to complete the sale" });
  }
});

// "2026-09-05T14:30" from datetime-local becomes "2026-09-05 14:30"; any other
// shape is dropped so nothing reaches a DATETIME column unparsed
function toMysqlDateTime(value) {
  const text = String(value || "").trim();
  if (text === "") return null;

  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(text);
  if (match) return `${match[1]} ${match[2]}${match[3] || ":00"}`;

  if (isDateText(text)) return `${text} 00:00:00`;

  return null;
}

app.post("/api/deliveries", async (request, response) => {
  const { saleId, address, scheduledDate, remarks, contactName, contactPhone, bookedDate } = request.body;

  if (!saleId || !address) {
    return response.status(400).json({ error: "A sale and a delivery address are required" });
  }

  const scheduled = toMysqlDateTime(scheduledDate);
  const booked = isDateText(bookedDate) ? bookedDate : null;

  // a schedule typed but not understood must not become "unscheduled" silently
  if (scheduledDate && !scheduled) {
    return response.status(400).json({
      error: "The scheduled date and time could not be read. Use the picker rather than typing it."
    });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_delivery(?, ?, ?, ?, ?, ?, ?, ?, @delivery_id, @status_code, @message)",
      [saleId, address, scheduled, remarks || null,
       (contactName || "").trim().slice(0, 150) || null,
       (contactPhone || "").trim().slice(0, 30) || null,
       booked, getActorId(request)],
      ["delivery_id", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message, deliveryId: output.delivery_id });
  } catch (error) {
    console.error("Book delivery failed:", error.message);
    response.status(500).json({ error: "Unable to book the delivery" });
  }
});

// The one route that moves a delivery; the procedure decides what each role may do.
app.patch("/api/deliveries/:deliveryId/status", async (request, response) => {
  const { status, remarks } = request.body;
  const actor = request.actor;

  if (!status) {
    return response.status(400).json({ error: "A status is required" });
  }

  try {
    if (actor.roleName === DRIVER) {
      await db.query(
        `UPDATE deliveries SET delivery_staff_id = ?
         WHERE delivery_id = ? AND delivery_staff_id IS NULL`,
        [actor.staffId, request.params.deliveryId]
      );
    }

    const output = await callProcedure(
      "CALL sp_update_delivery_status(?, ?, ?, ?, ?, @status_code, @message)",
      [request.params.deliveryId, status, remarks || null, actor.staffId, actor.roleId],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Delivery status failed:", error.message);
    response.status(500).json({ error: "Unable to update the delivery" });
  }
});

app.get("/api/sales/undelivered", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT s.sale_id, s.final_amount, s.sale_date, s.payment_method,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              COALESCE(c.address, '') AS customer_address
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE s.is_archived = FALSE AND d.delivery_id IS NULL
       ORDER BY s.sale_id DESC
       LIMIT 60`
    );
    response.json(rows);
  } catch (error) {
    console.error("Undelivered sales failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// End of shift: one cashier, one day (today by default), every figure bounded
// by DATE(sale_date). Refunds come back line by line.
app.get("/api/cashier/summary", async (request, response) => {
  // the session's shift, always; a staff id in the URL is ignored
  const staffId = request.actor.staffId;

  // an unreadable date means today
  const day = isDateText(request.query.date) ? request.query.date : null;

  try {
    const [[totals]] = await db.query(
      // collected is what stayed in the drawer, not amount_paid (which includes the note they broke)
      `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS gross,
              COALESCE(SUM(discount), 0) AS discounts,
              COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected
       FROM sales
       WHERE cashier_staff_id = ? AND is_archived = FALSE
         AND DATE(sale_date) = COALESCE(?, CURDATE())`,
      [staffId, day]
    );

    const [methods] = await db.query(
      `SELECT payment_method, COUNT(*) AS sale_count, COALESCE(SUM(final_amount), 0) AS total_amount
       FROM sales
       WHERE cashier_staff_id = ? AND is_archived = FALSE
         AND DATE(sale_date) = COALESCE(?, CURDATE())
       GROUP BY payment_method
       ORDER BY total_amount DESC`,
      [staffId, day]
    );

    const [[refunds]] = await db.query(
      `SELECT COUNT(*) AS refund_count, COALESCE(SUM(refund_amount), 0) AS refund_total,
              COALESCE(SUM(quantity), 0) AS refund_items
       FROM returned_items
       WHERE reported_by_staff_id = ? AND report_type = 'Refunded'
         AND DATE(return_date) = COALESCE(?, CURDATE())`,
      [staffId, day]
    );

    // what actually went back, capped
    const [refundLines] = await db.query(
      `SELECT r.return_id, r.quantity, r.refund_amount, r.reason, r.disposition,
              r.return_date, r.sale_id,
              p.product_name, u.unit_name,
              CASE WHEN r.quantity > 0 THEN r.refund_amount / r.quantity ELSE r.refund_amount END
                AS unit_refund
       FROM returned_items r
       JOIN products p ON p.product_id = r.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE r.reported_by_staff_id = ? AND r.report_type = 'Refunded'
         AND DATE(r.return_date) = COALESCE(?, CURDATE())
       ORDER BY r.return_date DESC
       LIMIT 100`,
      [staffId, day]
    );

    const [[stamp]] = await db.query(
      "SELECT COALESCE(?, CURDATE()) AS day", [day]
    );

    response.json({
      // the day the figures are for, resolved server side
      date: stamp.day,
      saleCount: totals.sale_count,
      gross: totals.gross,
      discounts: totals.discounts,
      collected: totals.collected,
      refundCount: refunds.refund_count,
      refundItems: refunds.refund_items,
      refundTotal: refunds.refund_total,
      refunds: refundLines,
      methods: methods
    });
  } catch (error) {
    console.error("Cashier summary failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/sales/:saleId", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, ${SALE_CUSTOMER_SQL} AS customer_name,
              c.phone AS customer_phone, c.address AS customer_address,
              st.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.sale_id = ?`,
      [request.params.saleId]
    );

    if (rows.length === 0) {
      return response.status(404).json({ error: "Sale not found" });
    }

    const [items] = await db.query(
      `SELECT si.quantity, si.unit_price, si.subtotal, p.product_name, u.unit_name
       FROM sale_items si
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE si.sale_id = ?`,
      [request.params.saleId]
    );

    const [payments] = await db.query(
      `SELECT cp.amount, cp.payment_method, cp.reference_no, cp.payment_date,
              st.full_name AS received_by
       FROM credit_payments cp
       LEFT JOIN staff st ON st.staff_id = cp.received_by_staff_id
       WHERE cp.sale_id = ?
       ORDER BY cp.payment_date`,
      [request.params.saleId]
    );

    const [delivery] = await db.query(
      `SELECT d.delivery_id, d.status, d.delivery_address, d.scheduled_date, d.delivered_at, d.remarks,
              st.full_name AS driver_name
       FROM deliveries d
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE d.sale_id = ?`,
      [request.params.saleId]
    );

    response.json({ sale: rows[0], items, payments, delivery: delivery[0] || null });
  } catch (error) {
    console.error("Sale detail failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// ==========================================
// STOCKS, AND THE REORDER POINT THE SYSTEM WORKS OUT FOR ITSELF
//
//     ROP = (average daily sales x lead time) + safety stock
//
// Average daily sales is over a window of real trading (90 days), divided by
// the days the shop has actually recorded sales. The effective reorder point
// is the calculated one only when the product is set to Dynamic; otherwise
// the typed figure, with the calculated one shown beside it.
// ==========================================
const SALES_WINDOW_DAYS = 90;

app.get("/api/stocks", async (request, response) => {
  try {
    const [rows] = await db.query(
      `WITH window_days AS (
         SELECT GREATEST(
                  LEAST(?, COALESCE(DATEDIFF(CURDATE(), DATE(MIN(sale_date))) + 1, ?)),
                  1) AS days
         FROM sales
         WHERE is_archived = FALSE
       ),
       recent AS (
         SELECT si.product_id, COALESCE(SUM(si.quantity), 0) AS units
         FROM sale_items si
         JOIN sales s ON s.sale_id = si.sale_id
         WHERE s.is_archived = FALSE
           AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY si.product_id
       )
       SELECT p.product_id, p.product_name, p.price, p.reorder_point, p.status,
              p.lead_time_days, p.safety_stock, p.reorder_mode,
              COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock,
              i.last_updated,
              c.category_name, b.brand_name, u.unit_name,
              sup.supplier_name, sup.contact_person, sup.contact_number,
              (COALESCE(i.quantity_in_stock, 0) * p.price) AS stock_value,

              w.days AS window_days,
              COALESCE(rc.units, 0) AS units_sold_window,
              ROUND(COALESCE(rc.units, 0) / w.days, 3) AS avg_daily_sales,

              -- the formula, rounded up: half a bag of cement short is short
              CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                AS calculated_rop,

              CASE WHEN p.reorder_mode = 'Dynamic'
                   THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                   ELSE p.reorder_point
              END AS effective_rop,

              CASE
                WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 'Out of Stock'
                WHEN COALESCE(i.quantity_in_stock, 0) <=
                     CASE WHEN p.reorder_mode = 'Dynamic'
                          THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                          ELSE p.reorder_point END
                THEN 'Low Stock'
                ELSE 'In Stock'
              END AS stock_status,

              -- order back up to twice the reorder point, so the next order is
              -- not due the week after this one arrives
              GREATEST(
                (CASE WHEN p.reorder_mode = 'Dynamic'
                      THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                      ELSE p.reorder_point END) * 2
                - COALESCE(i.quantity_in_stock, 0), 0) AS suggested_order,

              -- roughly how long what is on the shelf will last at the
              -- current rate. NULL when nothing is moving, because "forever"
              -- is not a number worth printing.
              CASE WHEN COALESCE(rc.units, 0) = 0 THEN NULL
                   ELSE ROUND(COALESCE(i.quantity_in_stock, 0) / (rc.units / w.days), 1)
              END AS days_of_cover

       FROM products p
       CROSS JOIN window_days w
       LEFT JOIN recent rc ON rc.product_id = p.product_id
       LEFT JOIN inventory i ON i.product_id = p.product_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
       WHERE p.is_archived = FALSE
       ORDER BY (COALESCE(i.quantity_in_stock, 0) <=
                 CASE WHEN p.reorder_mode = 'Dynamic'
                      THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                      ELSE p.reorder_point END) DESC,
                p.product_name`,
      [SALES_WINDOW_DAYS, SALES_WINDOW_DAYS, SALES_WINDOW_DAYS]
    );
    response.json(rows);
  } catch (error) {
    console.error("Stocks failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// the manager sets the policy; the clerk sets a manual reorder point
app.put("/api/stocks/:productId/reorder-policy", async (request, response) => {
  const { leadTimeDays, safetyStock, reorderMode, reorderPoint } = request.body;

  const lead = parseInt(leadTimeDays, 10);
  const safety = parseInt(safetyStock, 10);
  const mode = String(reorderMode || "Manual");

  if (!Number.isInteger(lead) || lead < 1 || lead > 365) {
    return response.status(400).json({ error: "Lead time must be between 1 and 365 days" });
  }
  if (!Number.isInteger(safety) || safety < 0 || safety > 1000000) {
    return response.status(400).json({ error: "Safety stock cannot be negative" });
  }
  if (mode !== "Manual" && mode !== "Dynamic") {
    return response.status(400).json({ error: "Reorder mode must be Manual or Dynamic" });
  }

  // a manual reorder point left out means "do not touch what is there"
  const manual = reorderPoint === undefined || reorderPoint === null || reorderPoint === ""
    ? null : parseInt(reorderPoint, 10);

  if (manual !== null && (!Number.isInteger(manual) || manual < 0)) {
    return response.status(400).json({ error: "The reorder point cannot be negative" });
  }

  try {
    const [existing] = await db.query(
      `SELECT product_name, reorder_point, lead_time_days, safety_stock, reorder_mode
       FROM products WHERE product_id = ? AND is_archived = FALSE`,
      [request.params.productId]
    );

    if (existing.length === 0) {
      return response.status(404).json({ error: "That product was not found." });
    }

    const before = existing[0];

    await db.query(
      `UPDATE products
       SET lead_time_days = ?, safety_stock = ?, reorder_mode = ?,
           reorder_point = COALESCE(?, reorder_point)
       WHERE product_id = ?`,
      [lead, safety, mode, manual, request.params.productId]
    );

    await writeAuditLog(
      request,
      "UPDATE_REORDER_POLICY",
      `${before.product_name}: ${mode.toLowerCase()} reorder point, ${lead} day lead time`,
      {
        product_id: Number(request.params.productId),
        changes: fieldChanges(
          {
            lead_time_days: before.lead_time_days,
            safety_stock: before.safety_stock,
            reorder_mode: before.reorder_mode,
            reorder_point: before.reorder_point
          },
          {
            lead_time_days: lead,
            safety_stock: safety,
            reorder_mode: mode,
            reorder_point: manual === null ? before.reorder_point : manual
          })
      }
    );

    response.json({ message: `Reorder policy updated for ${before.product_name}.` });
  } catch (error) {
    console.error("Reorder policy failed:", error.message);
    response.status(500).json({ error: "Unable to save the reorder policy" });
  }
});

// Delivered and finished are different: a delivered order with money owed
// sits at Pending Cash Collection until the balance is cleared. Derived from
// the sale's own figures, so there is no second flag to forget.
const FULFILMENT_SQL = `
  CASE
    WHEN d.status <> 'Delivered' THEN d.status
    WHEN GREATEST(s.final_amount - s.amount_paid, 0) > 0 THEN 'Pending Cash Collection'
    ELSE 'Completed'
  END`;

app.get("/api/deliveries", async (request, response) => {
  const state = String(request.query.state || "all");

  const where = ["d.is_archived = FALSE"];
  const params = [];

  if (state !== "all") {
    where.push(`${FULFILMENT_SQL} = ?`);
    params.push(state);
  }

  try {
    const [rows] = await db.query(
      `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at, d.updated_at,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              ${DELIVERY_PHONE_SQL} AS customer_phone,
              COALESCE(st.full_name, 'Unassigned') AS driver_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              GREATEST(s.final_amount - s.amount_paid, 0) AS balance_due,
              ${FULFILMENT_SQL} AS fulfilment_state
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE ${where.join(" AND ")}
       ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'),
                d.scheduled_date`,
      params
    );
    response.json(rows);
  } catch (error) {
    console.error("Deliveries failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// ==========================================
// DELIVERY PERSONNEL MODULE
// ==========================================

// deliveries assigned to this driver, plus any nobody claimed yet
app.get("/api/delivery/list", async (request, response) => {
  // from the session, so one driver cannot pull up another's round
  const staffId = request.actor.staffId;

  try {
    const [rows] = await db.query(
      `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at, d.updated_at, d.delivery_staff_id,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              ${DELIVERY_PHONE_SQL} AS customer_phone,
              COALESCE(st.full_name, 'Unassigned') AS driver_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              (s.final_amount - s.amount_paid) AS balance_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE d.is_archived = FALSE
         AND (d.delivery_staff_id = ? OR d.delivery_staff_id IS NULL)
       ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'),
                d.scheduled_date`,
      [staffId]
    );
    response.json(rows);
  } catch (error) {
    console.error("Delivery list failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// cash on delivery collected at the door
app.post("/api/delivery/:deliveryId/payment", async (request, response) => {
  const { amount, paymentMethod, referenceNo } = request.body;

  if (!amount || !paymentMethod) {
    return response.status(400).json({ error: "Amount and payment method are required" });
  }

  try {
    const [rows] = await db.query(
      "SELECT sale_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
      [request.params.deliveryId]
    );

    if (rows.length === 0) {
      return response.status(404).json({ error: "Delivery not found" });
    }

    const output = await callProcedure(
      "CALL sp_record_credit_payment(?, ?, ?, ?, ?, @status_code, @message)",
      [rows[0].sale_id, amount, paymentMethod, referenceNo || null, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Delivery payment failed:", error.message);
    response.status(500).json({ error: "Unable to record the payment" });
  }
});

app.get("/api/delivery/summary", async (request, response) => {
  const staffId = request.actor.staffId;   // this driver's own round, never another's

  // an unreadable date is dropped rather than handed to MySQL to guess at
  const from = isDateText(request.query.from) ? request.query.from : "2000-01-01";
  const to = isDateText(request.query.to) ? request.query.to : "2100-12-31";

  try {
    const [deliveries] = await db.query(
      `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              (s.final_amount - s.amount_paid) AS balance_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       WHERE d.is_archived = FALSE
         AND d.delivery_staff_id = ?
         AND DATE(COALESCE(d.delivered_at, d.scheduled_date, d.updated_at)) BETWEEN ? AND ?
       ORDER BY COALESCE(d.delivered_at, d.scheduled_date) DESC`,
      [staffId, from, to]
    );

    const [payments] = await db.query(
      `SELECT cp.payment_id, cp.sale_id, cp.amount, cp.payment_method,
              cp.reference_no, cp.payment_date,
              COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), 'Walk-in') AS customer_name
       FROM credit_payments cp
       LEFT JOIN customers c ON c.customer_id = cp.customer_id
       WHERE cp.received_by_staff_id = ?
         AND DATE(cp.payment_date) BETWEEN ? AND ?
       ORDER BY cp.payment_date DESC`,
      [staffId, from, to]
    );

    // money owed is counted only against the driver actually carrying the order
    const [[open]] = await db.query(
      `SELECT COUNT(*) AS cod_count,
              COALESCE(SUM(s.final_amount - s.amount_paid), 0) AS cod_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       WHERE d.is_archived = FALSE
         AND d.delivery_staff_id = ?
         AND s.payment_status <> 'Paid'`,
      [staffId]
    );

    response.json({
      from: from,
      to: to,
      deliveries: deliveries,
      payments: payments,
      codCount: open.cod_count,
      codDue: open.cod_due
    });
  } catch (error) {
    console.error("Delivery summary failed:", error.message);
    response.status(500).json({ error: error.message });
  }
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
  const allowed = {
    Inventory: [CLERK, ...MANAGEMENT],
    Sales: MANAGEMENT,
    Delivery: MANAGEMENT,
    Staff: [ADMIN]
  }[module];
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

app.post("/api/sales/:saleId/payment", async (request, response) => {
  const { amount, paymentMethod, referenceNo } = request.body;

  if (!amount || !paymentMethod) {
    return response.status(400).json({ error: "Amount and payment method are required" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_record_credit_payment(?, ?, ?, ?, ?, @status_code, @message)",
      [request.params.saleId, amount, paymentMethod, referenceNo || null, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Payment failed:", error.message);
    response.status(500).json({ error: "Unable to record the payment" });
  }
});

// ==========================================
// INVENTORY MODULE
// ==========================================

// headline numbers for the clerk dashboard
app.get("/api/inventory/summary", async (request, response) => {
  try {
    const [[stock]] = await db.query(
      `SELECT COUNT(*) AS product_count,
              COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
              COALESCE(SUM(CASE WHEN COALESCE(i.quantity_in_stock, 0) > 0
                                 AND COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 1 ELSE 0 END), 0) AS low_stock,
              COALESCE(SUM(COALESCE(i.quantity_in_stock, 0) * p.price), 0) AS stock_value
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       WHERE p.is_archived = FALSE`
    );
    const [[po]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending_po,
              COUNT(*) AS total_po
       FROM purchase_orders`
    );
    const [[rep]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) AS open_reports,
              COALESCE(SUM(CASE WHEN report_type = 'Damaged' THEN quantity ELSE 0 END), 0) AS damaged_units,
              COALESCE(SUM(refund_amount), 0) AS refunded_total
       FROM returned_items`
    );
    const [[arch]] = await db.query(
      "SELECT COUNT(*) AS archived FROM products WHERE is_archived = TRUE"
    );

    response.json({
      productCount: stock.product_count,
      lowStock: stock.low_stock,
      outOfStock: stock.out_of_stock,
      stockValue: stock.stock_value,
      pendingPo: po.pending_po,
      totalPo: po.total_po,
      openReports: rep.open_reports,
      damagedUnits: rep.damaged_units,
      refundedTotal: rep.refunded_total,
      archived: arch.archived
    });
  } catch (error) {
    console.error("Inventory summary failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/inventory/products", async (request, response) => {
  const archived = request.query.archived === "true";

  try {
    const [rows] = await db.query(
      `SELECT p.product_id, p.product_name, p.price, p.reorder_point, p.status,
              p.is_archived, p.archived_at, p.created_at,
              COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock,
              i.last_updated,
              c.category_name, b.brand_name, u.unit_name,
              sup.supplier_id, sup.supplier_name, sup.contact_person, sup.contact_number,
              (COALESCE(i.quantity_in_stock, 0) * p.price) AS stock_value,
              CASE
                WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 'Out of Stock'
                WHEN COALESCE(i.quantity_in_stock, 0) <= p.reorder_point THEN 'Low Stock'
                ELSE 'In Stock'
              END AS stock_status,
              GREATEST((p.reorder_point * 2) - COALESCE(i.quantity_in_stock, 0), 0) AS suggested_order,
              COALESCE(ar.full_name, '') AS archived_by
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
       LEFT JOIN staff ar ON ar.staff_id = p.archived_by_staff_id
       WHERE p.is_archived = ?
       ORDER BY (COALESCE(i.quantity_in_stock, 0) <= p.reorder_point) DESC, p.product_name`,
      [archived]
    );
    response.json(rows);
  } catch (error) {
    console.error("Inventory products failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Adding a material from the shop floor: unit, category and brand are
// created alongside it if new. An existing name returns the existing material.
app.post("/api/materials", async (request, response) => {
  const { name, brandName, categoryName, unitName, price, supplierId } = request.body;

  if (!name || String(name).trim() === "") {
    return response.status(400).json({ error: "A material needs a name" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_material(?, ?, ?, ?, ?, ?, ?, @product_id, @status_code, @message)",
      [String(name).trim().slice(0, 150),
       String(brandName || "").trim().slice(0, 100),
       String(categoryName || "").trim().slice(0, 50),
       String(unitName || "").trim().slice(0, 20),
       Number(price) || 0,
       Number(supplierId) || null,
       getActorId(request)],
      ["product_id", "status_code", "message"]
    );

    if (output.status_code !== 201 && output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({
      message: output.message,
      productId: output.product_id,
      created: output.status_code === 201
    });
  } catch (error) {
    console.error("Create material failed:", error.message);
    response.status(500).json({ error: "Unable to add the material" });
  }
});

// STOCK ADJUSTMENT
// Units: a unit typed on an adjustment is added; the same clerk can rename
// one, and renaming onto an existing name merges.
app.put("/api/units/:unitId", async (request, response) => {
  const { unitName } = request.body;

  if (!unitName || String(unitName).trim() === "") {
    return response.status(400).json({ error: "A unit needs a name" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_rename_unit(?, ?, ?, @merged, @status_code, @message)",
      [request.params.unitId, String(unitName).trim().slice(0, 20), getActorId(request)],
      ["merged", "status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message, merged: output.merged === 1 });
  } catch (error) {
    console.error("Rename unit failed:", error.message);
    response.status(500).json({ error: "Unable to rename the unit" });
  }
});

app.get("/api/inventory/adjustments", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT a.adjustment_id, a.adjustment_type, a.quantity_before, a.quantity_change,
              a.quantity_after, a.reason, a.created_at,
              p.product_name,
              -- What the entry itself says it counted, falling back to the
              -- material's unit today only for entries filed before the log
              -- recorded one. The entry's own answer always wins: renaming a
              -- unit must not rewrite what last year's rows say they counted.
              COALESCE(NULLIF(TRIM(a.unit_name), ''), u.unit_name) AS unit_name,
              u.unit_name AS current_unit,
              COALESCE(s.full_name, 'System') AS adjusted_by
       FROM stock_adjustments a
       JOIN products p ON p.product_id = a.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN staff s ON s.staff_id = a.adjusted_by_staff_id
       ORDER BY a.adjustment_id DESC
       LIMIT 200`
    );
    response.json(rows);
  } catch (error) {
    console.error("Adjustments failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/inventory/adjust", async (request, response) => {
  const { productId, adjustmentType, quantity, reason, unitName } = request.body;

  if (!productId || !adjustmentType || quantity === undefined || !reason) {
    return response.status(400).json({ error: "Product, type, quantity and reason are all required" });
  }

  // capped at the column width; empty means "keep what this material is counted in"
  const unit = typeof unitName === "string" ? unitName.trim().slice(0, 20) : "";

  try {
    const output = await callProcedure(
      "CALL sp_adjust_stock(?, ?, ?, ?, ?, ?, @status_code, @message)",
      [productId, adjustmentType, quantity, unit || null, reason, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Stock adjust failed:", error.message);
    response.status(500).json({ error: "Unable to adjust the stock" });
  }
});

// REORDER POINT SETTINGS
app.put("/api/inventory/reorder/:productId", async (request, response) => {
  const { reorderPoint } = request.body;

  if (reorderPoint === undefined || reorderPoint === null) {
    return response.status(400).json({ error: "A reorder point is required" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_set_reorder_point(?, ?, ?, @status_code, @message)",
      [request.params.productId, reorderPoint, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Reorder point failed:", error.message);
    response.status(500).json({ error: "Unable to save the reorder point" });
  }
});

// PURCHASE ORDERS
app.get("/api/purchase-orders", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT po.po_id, po.status, po.order_date,
              s.supplier_id, s.supplier_name, s.contact_person, s.contact_number,
              COUNT(i.po_item_id) AS line_count,
              COALESCE(SUM(i.quantity), 0) AS total_units,
              COALESCE(SUM(i.line_cost), 0) AS total_cost
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN purchase_order_items i ON i.po_id = po.po_id
       GROUP BY po.po_id, po.status, po.order_date,
                s.supplier_id, s.supplier_name, s.contact_person, s.contact_number
       ORDER BY FIELD(po.status, 'Pending', 'Received', 'Cancelled'), po.po_id DESC`
    );
    response.json(rows);
  } catch (error) {
    console.error("Purchase orders failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/purchase-orders/:poId/items", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT i.product_id, i.quantity, i.unit_cost, i.line_cost,
              p.product_name, u.unit_name, c.category_name, b.brand_name,
              COALESCE(inv.quantity_in_stock, 0) AS quantity_in_stock
       FROM purchase_order_items i
       JOIN products p ON p.product_id = i.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN inventory inv ON inv.product_id = i.product_id
       WHERE i.po_id = ?
       ORDER BY i.po_item_id`,
      [request.params.poId]
    );
    response.json(rows);
  } catch (error) {
    console.error("PO items failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// The order as a printable document, assembled in one request.
app.get("/api/purchase-orders/:poId/document", async (request, response) => {
  try {
    const [orders] = await db.query(
      `SELECT po.po_id, po.status, po.order_date,
              s.supplier_id, s.supplier_name, s.contact_person, s.contact_number,
              s.email AS supplier_email, s.address AS supplier_address,
              st.full_name AS raised_by
       FROM purchase_orders po
       JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN audit_logs a ON a.action = 'PURCHASE_ORDER'
                             AND a.details LIKE CONCAT('PO #', po.po_id, ' %')
       LEFT JOIN staff st ON st.staff_id = a.staff_id
       WHERE po.po_id = ?
       LIMIT 1`,
      [request.params.poId]
    );

    if (orders.length === 0) {
      return response.status(404).json({ error: "That purchase order does not exist" });
    }

    const [items] = await db.query(
      `SELECT i.product_id, i.quantity, i.unit_cost, i.line_cost,
              p.product_name, u.unit_name, c.category_name, b.brand_name
       FROM purchase_order_items i
       JOIN products p ON p.product_id = i.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       WHERE i.po_id = ?
       ORDER BY i.po_item_id`,
      [request.params.poId]
    );

    const [settings] = await db.query(
      `SELECT store_name, address, tin, registration_type, invoice_note
       FROM store_settings WHERE setting_id = 1`
    );

    response.json({
      order: orders[0],
      items: items,
      shop: settings[0] || DEFAULT_STORE_SETTINGS
    });
  } catch (error) {
    console.error("PO document failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Raising an order: the supplier arrives as a name and a line may name a new
// material. The procedure creates whatever is new inside the order's transaction.
app.post("/api/purchase-orders", async (request, response) => {
  const {
    supplierId, supplierName, contactPerson, contactNumber,
    supplierEmail, supplierAddress, items
  } = request.body;

  const company = String(supplierName || "").trim();

  if ((!supplierId && company === "") || !Array.isArray(items) || items.length === 0) {
    return response.status(400).json({
      error: "A supplier company name and at least one item are required"
    });
  }

  // only the fields the procedure reads, trimmed to their column widths
  const lines = items.map((item) => ({
    product_id: Number(item.productId || item.product_id) || null,
    quantity: Number(item.quantity) || 0,
    unit_cost: Number(item.unitCost != null ? item.unitCost : item.unit_cost) || 0,
    new_name: String(item.newName || item.new_name || "").trim().slice(0, 150) || null,
    brand_name: String(item.brandName || item.brand_name || "").trim().slice(0, 100) || null,
    category_name: String(item.categoryName || item.category_name || "").trim().slice(0, 50) || null,
    unit_name: String(item.unitName || item.unit_name || "").trim().slice(0, 20) || null,
    price: Number(item.price) || 0
  }));

  try {
    const output = await callProcedure(
      "CALL sp_create_purchase_order(?, ?, ?, ?, ?, ?, ?, ?, @po_id, @supplier_id_out, @new_materials, @status_code, @message)",
      [Number(supplierId) || null,
       company.slice(0, 100),
       String(contactPerson || "").trim().slice(0, 100),
       String(contactNumber || "").trim().slice(0, 20),
       String(supplierEmail || "").trim().slice(0, 100),
       String(supplierAddress || "").trim(),
       JSON.stringify(lines),
       getActorId(request)],
      ["po_id", "supplier_id_out", "new_materials", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({
      message: output.message,
      poId: output.po_id,
      supplierId: output.supplier_id_out,
      newMaterials: output.new_materials
    });
  } catch (error) {
    console.error("Create PO failed:", error.message);
    response.status(500).json({ error: "Unable to create the purchase order" });
  }
});

// Receiving: the body carries the count sheet, including anything never
// ordered. An empty body receives the order exactly as written.
app.post("/api/purchase-orders/:poId/receive", async (request, response) => {
  const received = Array.isArray(request.body && request.body.received)
    ? request.body.received : [];

  const sheet = received.map((line) => ({
    product_id: Number(line.productId || line.product_id) || null,
    quantity: Math.max(0, Number(line.quantity) || 0),
    unit_cost: Number(line.unitCost != null ? line.unitCost : line.unit_cost) || 0,
    new_name: String(line.newName || line.new_name || "").trim().slice(0, 150) || null,
    brand_name: String(line.brandName || line.brand_name || "").trim().slice(0, 100) || null,
    category_name: String(line.categoryName || line.category_name || "").trim().slice(0, 50) || null,
    unit_name: String(line.unitName || line.unit_name || "").trim().slice(0, 20) || null
  }));

  try {
    const output = await callProcedure(
      "CALL sp_receive_purchase_order(?, ?, ?, @lines, @extras, @status_code, @message)",
      [request.params.poId, JSON.stringify(sheet), getActorId(request)],
      ["lines", "extras", "status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message, lines: output.lines, extras: output.extras });
  } catch (error) {
    console.error("Receive PO failed:", error.message);
    response.status(500).json({ error: "Unable to receive the purchase order" });
  }
});

// RETURNS, DAMAGE AND REFUND REPORTS
app.get("/api/returns", async (request, response) => {
  try {
    const [rows] = await db.query(
      `SELECT r.return_id, r.report_type, r.quantity, r.reason, r.refund_amount,
              r.restocked, r.disposition, r.status, r.return_date, r.sale_id,
              p.product_id, p.product_name, u.unit_name,
              COALESCE(s.full_name, 'Unknown') AS reported_by
       FROM returned_items r
       JOIN products p ON p.product_id = r.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN staff s ON s.staff_id = r.reported_by_staff_id
       ORDER BY FIELD(r.status, 'Open', 'Resolved'), r.return_id DESC`
    );
    response.json(rows);
  } catch (error) {
    console.error("Returns failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

// Filing a return: a reason (a sentence) and a disposition are compulsory.
// restock is still accepted from older callers and mapped across.
const RETURN_DISPOSITIONS = ["Return to Stock", "Write-Off"];
const MINIMUM_RETURN_REASON = 10;

app.post("/api/returns", async (request, response) => {
  const { productId, saleId, reportType, quantity, reason, refundAmount,
          disposition, restock } = request.body;

  if (!productId || !reportType || !quantity) {
    return response.status(400).json({ error: "Product, type and quantity are all required" });
  }

  const explanation = typeof reason === "string" ? reason.trim() : "";
  if (explanation.length < MINIMUM_RETURN_REASON) {
    return response.status(400).json({
      error: "Say what happened, in a sentence. A write-off queried three months " +
             "from now has to be explainable from this line alone."
    });
  }

  const where = RETURN_DISPOSITIONS.includes(disposition)
    ? disposition
    : (restock === true ? "Return to Stock" : null);

  if (!where) {
    return response.status(400).json({
      error: "Say where the goods go: Return to Stock, or Write-Off."
    });
  }

  try {
    const output = await callProcedure(
      "CALL sp_file_return_report(?, ?, ?, ?, ?, ?, ?, ?, @report_id, @status_code, @message)",
      [productId, saleId || null, reportType, quantity, explanation,
       refundAmount || 0, where, getActorId(request)],
      ["report_id", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(
      request,
      reportType === "Refunded" ? "REFUND" : "RETURN",
      `${reportType} #${output.report_id}: ${quantity} unit(s), ${where}`,
      {
        report_id: output.report_id,
        product_id: Number(productId),
        sale_id: saleId || null,
        quantity: Number(quantity),
        disposition: where,
        refund_amount: Number(refundAmount || 0),
        reason: explanation
      }
    );

    response.json({ message: output.message, reportId: output.report_id, disposition: where });
  } catch (error) {
    console.error("File report failed:", error.message);
    response.status(500).json({ error: "Unable to file the report" });
  }
});

app.post("/api/returns/:reportId/resolve", async (request, response) => {
  try {
    const output = await callProcedure(
      "CALL sp_resolve_return_report(?, ?, @status_code, @message)",
      [request.params.reportId, getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    response.json({ message: output.message });
  } catch (error) {
    console.error("Resolve report failed:", error.message);
    response.status(500).json({ error: "Unable to resolve the report" });
  }
});

// NOTIFICATIONS -- which alerts you see is decided by the role on your session
app.get("/api/notifications", async (request, response) => {
  const roleId = request.actor.roleId;

  try {
    const [rows] = await db.query(
      `SELECT n.notification_id, n.notif_type, n.title, n.message, n.is_read, n.created_at,
              n.product_id, p.product_name,
              COALESCE(s.full_name, 'System') AS from_name,
              COALESCE(r.role_name, 'Automatic') AS from_role
       FROM notifications n
       LEFT JOIN products p ON p.product_id = n.product_id
       LEFT JOIN staff s ON s.staff_id = n.created_by_staff_id
       LEFT JOIN roles r ON r.role_id = s.role_id
       WHERE n.target_role_id IS NULL OR n.target_role_id = ?
       ORDER BY n.is_read, n.notification_id DESC
       LIMIT 60`,
      [roleId]
    );
    response.json(rows);
  } catch (error) {
    console.error("Notifications failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/notifications/:notificationId/read", async (request, response) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE notification_id = ? AND (target_role_id IS NULL OR target_role_id = ?)`,
      [request.params.notificationId, request.actor.roleId]
    );
    response.json({ message: "Marked as read" });
  } catch (error) {
    console.error("Mark read failed:", error.message);
    response.status(500).json({ error: "Unable to mark it read" });
  }
});

app.post("/api/notifications/read-all", async (request, response) => {
  const roleId = request.actor.roleId;

  try {
    await db.query(
      "UPDATE notifications SET is_read = TRUE WHERE target_role_id IS NULL OR target_role_id = ?",
      [roleId]
    );
    response.json({ message: "All notifications marked as read" });
  } catch (error) {
    console.error("Mark all read failed:", error.message);
    response.status(500).json({ error: "Unable to mark them read" });
  }
});

// ==========================================
// START
// ==========================================
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});