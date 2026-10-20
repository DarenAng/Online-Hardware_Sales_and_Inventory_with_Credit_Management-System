// ============================================================
// server.js -- the main file of the back end (start it with: npm start)
//
// What this file does, from top to bottom:
//   1. Reads the settings from the .env file and connects to MySQL
//      (the connection itself is in database/connection.js).
//   2. Starts the database work that has to be done before the first request
//      (database/migrations.js): add what an older database is missing and
//      load the stored procedures.
//   3. Sets up Express: serves the pages, css, page scripts and connections
//      files in public/frontend/ and Bootstrap in public/vendor/. Nothing else
//      (server code, SQL files) is served.
//   4. Checks who is signed in and what each role may open.
//   5. Loads the route files from the routes folder and starts listening on
//      the port.
//
// The rest of the back end, one job per file:
//   routes/            what each role's screens ask the server for
//     login.js           signing in and out (every user)
//     admin.js           System Administrator
//     manager.js         Manager
//     cashier.js         Cashier
//     inventory-clerk.js Inventory Clerk
//     delivery.js        Delivery Personnel
//     qr-payments.js     GCash, Maya and bank transfers paid by QR code (PayMongo)
//     shared.js          routes every signed-in role uses (My Account, the live channel, archives ...)
//   database/          connection.js (the MySQL pool), migrations.js (start-up work),
//                      procedures/ (every stored-procedure CALL, one file per role)
//   services/          mailer, passwords, purchase-order PDF, spreadsheets, SQL scripts, QR providers
//   tools/             recover-password.js (run by hand on the server's PC)
//   roles.js           the five role names and each role's page
//   sessions.js        signed-in sessions, the cookie, who is present
//   access-control.js  who may call which /api route
//   features.js        screens by role (what the administrator switches on and off)
//   audit-log.js       the audit trail
//   live-changes.js    the live channel (what changed since a version)
//   validation.js      phone, password, name and TIN rules
//   helpers.js         word-start search, date text
//   shared-sql.js      SQL text several routes use
//   store-settings.js  the shop's default settings and receipt layout
//   env-settings.js    reading a number from .env
//
// Two things you will see a lot:
//   const result = await db.query(...);   const rows = result[0];
//     db.query() gives back a list of two things: [rows, fields].
//     We only need the rows, so we take the first item, result[0].
//   const email = request.body.email;
//     reads one field the browser sent, from request.body.
// ============================================================

// Load the settings (database password etc.) from the .env file in the project folder
const dotenv = require("dotenv");
dotenv.config({ path: require("path").join(__dirname, "..", "..", ".env"), quiet: true });

const express = require("express");
const path = require("path");
// sqlValue("it's") makes a value safe to put inside SQL text,
// sqlName("users") does the same for a table or column name
const mysqlTools = require("mysql2");
const sqlValue = mysqlTools.escape;
const sqlName = mysqlTools.escapeId;

// The routes of each kind of user are in the routes folder (see the list above).
const registerLoginRoutes = require("./routes/login").registerLoginRoutes;
const registerAdminRoutes = require("./routes/admin").registerAdminRoutes;
const registerManagerRoutes = require("./routes/manager").registerManagerRoutes;
const registerCashierRoutes = require("./routes/cashier").registerCashierRoutes;
const registerDeliveryRoutes = require("./routes/delivery").registerDeliveryRoutes;
const registerInventoryRoutes = require("./routes/inventory-clerk").registerInventoryRoutes;
const registerQrPaymentRoutes = require("./routes/qr-payments").registerQrPaymentRoutes;
const registerVoidRequestRoutes = require("./routes/void-requests").registerVoidRequestRoutes;
const registerSharedRoutes = require("./routes/shared").registerSharedRoutes;

const app = express();

// Express matches routes without caring about letter case by default, so
// /API/backups would reach the same route as /api/backups. Turning this on
// makes "/API/..." match no route at all.
app.set("case sensitive routing", true);

// the port the website runs on (http://localhost:3000)
const port = Number(process.env.HARDWARE_PORT) || 3000;

// the MySQL connection lives in database/connection.js
const database = require("./database/connection");
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
const passwords = require("./services/passwords");
const hashPassword = passwords.hashPassword;
const isHashed = passwords.isHashed;
const generatePassword = passwords.generatePassword;
const verifyPassword = passwords.verifyPassword;

// the five roles, spelled exactly as the roles table spells them
const roles = require("./roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const DRIVER = roles.DRIVER;
const PAGE_ROLES = roles.PAGE_ROLES;
const ROLE_PAGES = roles.ROLE_PAGES;

// the start-up database work, and the stored procedures' count
const migrations = require("./database/migrations");
const EXPECTED_PROCEDURES = migrations.EXPECTED_PROCEDURES;
const SERVER_TABLES = migrations.SERVER_TABLES;
const countProcedures = migrations.countProcedures;
const proceduresAreMissing = migrations.proceduresAreMissing;
const proceduresLoadedCount = migrations.proceduresLoadedCount;
const forgetProcedureCount = migrations.forgetProcedureCount;

// the helpers the route files are handed (below, in the deps of each route file)
const validation = require("./validation");
const phoneComplaint = validation.phoneComplaint;
const passwordComplaint = validation.passwordComplaint;
const cleanPhone = validation.cleanPhone;
const findPhoneOwner = validation.findPhoneOwner;
const phoneTakenMessage = validation.phoneTakenMessage;
const cleanMiddleName = validation.cleanMiddleName;
const nameComplaint = validation.nameComplaint;
const tinComplaint = validation.tinComplaint;
const cleanTin = validation.cleanTin;

const helpers = require("./helpers");
const wordStartSearch = helpers.wordStartSearch;
const isDateText = helpers.isDateText;

const auditLog = require("./audit-log");
const clientIp = auditLog.clientIp;
const AUDIT_TYPES = auditLog.AUDIT_TYPES;
const fieldChanges = auditLog.fieldChanges;
const writeAuditLog = auditLog.writeAuditLog;

const sessions = require("./sessions");
const LOGIN_MAX_ATTEMPTS = sessions.LOGIN_MAX_ATTEMPTS;
const LOGIN_HOLD_MINUTES = sessions.LOGIN_HOLD_MINUTES;
const SESSION_IDLE_MINUTES = sessions.SESSION_IDLE_MINUTES;
const SESSION_SWEEP_MS = sessions.SESSION_SWEEP_MS;
const startSession = sessions.startSession;
const setSessionCookie = sessions.setSessionCookie;
const currentSession = sessions.currentSession;
const withPresence = sessions.withPresence;
const endSession = sessions.endSession;
const removeExpiredSessions = sessions.removeExpiredSessions;
const endSessionsForStaff = sessions.endSessionsForStaff;
const getActorId = sessions.getActorId;
const renewSessionAfterPasswordChange = sessions.renewSessionAfterPasswordChange;

const publishChange = require("./live-changes").publishChange;

const features = require("./features");
const FEATURES = features.FEATURES;
const FEATURE_ROLES = features.FEATURE_ROLES;
const ROLES_MANAGED_BY_MANAGER = features.ROLES_MANAGED_BY_MANAGER;
const findFeature = features.findFeature;
const featuresOf = features.featuresOf;
const forgetFeatureOverrides = features.forgetFeatureOverrides;

const accessControl = require("./access-control");
const requireRole = accessControl.requireRole;
const notOwnAccount = accessControl.notOwnAccount;

const storeSettings = require("./store-settings");
const DEFAULT_STORE_SETTINGS = storeSettings.DEFAULT_STORE_SETTINGS;
const receiptLayoutFrom = storeSettings.receiptLayoutFrom;

const sharedSql = require("./shared-sql");
const USER_SELECT = sharedSql.USER_SELECT;
const LOW_STOCK_EFFECTIVE_SQL = sharedSql.LOW_STOCK_EFFECTIVE_SQL;
const SALE_CUSTOMER_SQL = sharedSql.SALE_CUSTOMER_SQL;
const DELIVERY_CONTACT_SQL = sharedSql.DELIVERY_CONTACT_SQL;
const DELIVERY_PHONE_SQL = sharedSql.DELIVERY_PHONE_SQL;

// The start-up work below runs once per copy of the server. On a PC that is
// once; on Vercel it is every time a new copy wakes up, and the first request
// waits for it (see the hook after this) so it never meets a missing table.
// (adminModule is made further down; this runs after that is done.)
const startup = db.getConnection()
  .then(async function (connection) {
    connection.release();
    console.log("Connected to MySQL database \"" + DB_NAME + "\" on " + DB_HOST + ":" + DB_PORT + ".");

    await migrations.migrateOneAtATime(adminModule.runSqlScript);

    // last, so the first backup is not taken of a schema about to change.
    // On Vercel nothing runs between requests, so the daily job at
    // /api/cron/daily (vercel.json) does this work instead of timers.
    if (!IS_VERCEL) {
      adminModule.startAutoBackup();
      adminModule.startArchiveSweep();
      managerModule.startPenaltySweep();
      const sessionTimer = setInterval(function () {
        removeExpiredSessions().catch(function (error) {
          console.error("Session sweep failed:", error.message);
        });
      }, SESSION_SWEEP_MS);
      sessionTimer.unref();
    }
  })
  .catch(function (error) {
    console.error("DATABASE CONNECTION FAILED:", error.message);
    console.error("Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env at the project root (see .env.example),");
    console.error("and make sure you ran the two files in public/database/, in the order their names give.");
  });

app.use(async function (request, response, next) {
  await startup;
  next();
});

// PayMongo signs the exact bytes it sends, so its webhook is read raw: this
// comes before express.json(), which would parse the body and lose them.
app.use("/api/paymongo/webhook", express.raw({ type: "*/*", limit: "1mb" }));

// Every route reads JSON with the default limit (100 kb), far more than any form
// sends, so one huge body cannot be pushed at a route to use up memory. The one
// exception is the restore upload, a whole .sql file: it is skipped here and
// read by its own route in routes/admin.js, which has a 50 MB limit and
// only after the administrator check has passed.
const smallJson = express.json();
app.use(function (request, response, next) {
  if (request.method === "POST" && request.path === "/api/restore") return next();
  smallJson(request, response, next);
});

app.get("/", function (request, response) {
  response.redirect("/Login.html");
});

// every browser asks for this; a 404 in the console hides real errors
const FAVICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
  "<rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#1d4ed8\"/>" +
  "<path d=\"M9 8h3v7h8V8h3v16h-3v-7h-8v7H9z\" fill=\"#fff\"/></svg>";

app.get(["/favicon.ico", "/favicon.svg"], function (request, response) {
  response.type("image/svg+xml");
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.send(FAVICON);
});

// Only these are handed to a browser (see express.static below):
//   public/frontend/               the pages and css            at /
//   public/frontend/scripts/       the page scripts             at /scripts/
//   public/frontend/connections/   the browser's API calls     at /connections/
//   public/vendor/                 Bootstrap                    at /vendor/
// Everything else stays private: the server code in public/backend/
// (services/mailer.js names the mail account, services/mail-password.txt holds its
// password, routes/login.js holds the sign-in rules), the SQL files in
// public/database/ and the deployment tools in public/deployment/. The server
// code no longer sits next to the browser files, so nothing there can be reached
// by a spelling of an address. The guard below refuses those addresses outright as
// well, in case a folder is ever served from higher up again (public/ itself, say).
const PRIVATE_FILES = [
  /^\/back-?end(\/|$)/i,
  /^\/database(\/|$)/i,
  /^\/deployment(\/|$)/i
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

app.use(function (request, response, next) {
  const pathname = resolvedPath(request.path);

  if (pathname === null) {
    return response.status(400).send("Bad request");
  }

  // pretend private files do not exist
  for (let patternIndex = 0; patternIndex < PRIVATE_FILES.length; patternIndex++) {
    const pattern = PRIVATE_FILES[patternIndex];
    if (pattern.test(pathname)) {
      return response.status(404).send("Not found");
    }
  }

  next();
});

// A dashboard page is served to its role only (PAGE_ROLES in roles.js), checked
// here from the session cookie before the file server sees the request.
app.use(async function (request, response, next) {
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const pathname = resolvedPath(request.path);
  if (pathname === null) return next();

  // Is this one of the dashboard pages? Compared without caring about
  // upper/lower case, because Windows file names do not care either.
  let page = null;
  const pageNames = Object.keys(PAGE_ROLES);
  for (let nameIndex = 0; nameIndex < pageNames.length; nameIndex++) {
    const name = pageNames[nameIndex];
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
app.use(express.static(path.join(PUBLIC_DIR, "frontend")));   // /Login.html, /css/..., /scripts/..., /connections/...
app.use("/vendor", express.static(path.join(PUBLIC_DIR, "vendor")));         // /vendor/bootstrap/...

// every /api request is checked against the access rules (access-control.js)
app.use(accessControl.accessHook);

// ==========================================
// THE ROUTES -- each route file gets "app" plus an object with the helpers it needs
// ==========================================

// ==========================================
// AUTH -- in routes/login.js: sign in, sign out, heartbeat, first-sign-in password
// ==========================================
registerLoginRoutes(app, {
  db: db, writeAuditLog: writeAuditLog, hashPassword: hashPassword, isHashed: isHashed,
  verifyPassword: verifyPassword, startSession: startSession, setSessionCookie: setSessionCookie,
  endSession: endSession, endSessionsForStaff: endSessionsForStaff,
  renewSessionAfterPasswordChange: renewSessionAfterPasswordChange, clientIp: clientIp,
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS, LOGIN_MAX_ATTEMPTS: LOGIN_MAX_ATTEMPTS,
  LOGIN_HOLD_MINUTES: LOGIN_HOLD_MINUTES, SESSION_IDLE_MINUTES: SESSION_IDLE_MINUTES,
  passwordComplaint: passwordComplaint
});

// ==========================================
// SYSTEM ADMINISTRATION -- in routes/admin.js: staff accounts, the audit trail,
// backup and recovery, screens by role, store settings
// ==========================================
// Each route file is handed an object such as { db: db, getActorId: getActorId }.

// routes/admin.js calls this after a restore. Loading the procedures needs a way
// to run a whole SQL file, and that is routes/admin.js's own (runSqlScript).
function loadProceduresIfMissing() {
  return migrations.loadProceduresIfMissing(adminModule.runSqlScript);
}

const adminModule = registerAdminRoutes(app, {
  db: db, getActorId: getActorId, writeAuditLog: writeAuditLog, fieldChanges: fieldChanges,
  wordStartSearch: wordStartSearch, requireRole: requireRole, publishChange: publishChange,
  ADMIN: ADMIN, USER_SELECT: USER_SELECT, withPresence: withPresence, notOwnAccount: notOwnAccount,
  endSessionsForStaff: endSessionsForStaff, hashPassword: hashPassword,
  generatePassword: generatePassword, phoneComplaint: phoneComplaint, cleanPhone: cleanPhone,
  cleanMiddleName: cleanMiddleName, findPhoneOwner: findPhoneOwner,
  phoneTakenMessage: phoneTakenMessage, nameComplaint: nameComplaint, tinComplaint: tinComplaint,
  cleanTin: cleanTin, DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS, AUDIT_TYPES: AUDIT_TYPES,
  DB_NAME: DB_NAME, sqlValue: sqlValue, sqlName: sqlName, EXPECTED_PROCEDURES: EXPECTED_PROCEDURES,
  countProcedures: countProcedures, SERVER_TABLES: SERVER_TABLES, IS_VERCEL: IS_VERCEL,
  proceduresAreMissing: proceduresAreMissing, proceduresLoadedCount: proceduresLoadedCount,
  forgetProcedureCount: forgetProcedureCount, loadProceduresIfMissing: loadProceduresIfMissing,
  FEATURES: FEATURES, FEATURE_ROLES: FEATURE_ROLES, findFeature: findFeature,
  featuresOf: featuresOf, forgetFeatureOverrides: forgetFeatureOverrides,
  receiptLayoutFrom: receiptLayoutFrom, ROLES_MANAGED_BY_MANAGER: ROLES_MANAGED_BY_MANAGER
});

// ==========================================
// MANAGER MODULE -- in routes/manager.js: the reports, the dashboard summary, credit
// management, and stocks with the reorder point and the selling price.
// ==========================================
const managerModule = registerManagerRoutes(app, {
  db: db, getActorId: getActorId, writeAuditLog: writeAuditLog, fieldChanges: fieldChanges,
  wordStartSearch: wordStartSearch, requireRole: requireRole, MANAGER: MANAGER,
  LOW_STOCK_EFFECTIVE_SQL: LOW_STOCK_EFFECTIVE_SQL, isDateText: isDateText,
  SALE_CUSTOMER_SQL: SALE_CUSTOMER_SQL, proceduresAreMissing: proceduresAreMissing,
  publishChange: publishChange, CLERK: CLERK, CASHIER: CASHIER, DRIVER: DRIVER,
  cleanPhone: cleanPhone, phoneComplaint: phoneComplaint
});

// ==========================================
// QR PAYMENTS -- in routes/qr-payments.js: the QR code for a GCash or
// Maya payment, through PayMongo or the offline simulation (PAYMENT_PROVIDER
// in .env), and the record of every attempt. Registered before the cashier,
// who asks it again before a sale or a payment is recorded against one.
// ==========================================
const qrPayments = registerQrPaymentRoutes(app, {
  db: db, getActorId: getActorId, publishChange: publishChange, isDateText: isDateText,
  CASHIER: CASHIER, DRIVER: DRIVER, port: port
});

// ==========================================
// CASHIER MODULE -- in routes/cashier.js: the sales list, ringing up a sale, creating
// and moving a delivery, the end-of-shift summary, payments on a sale
// ==========================================
// ==========================================
// VOID REQUESTS -- in routes/void-requests.js: a cashier asks for a sale of the
// same day to be voided, and a manager approves or declines it
// ==========================================
registerVoidRequestRoutes(app, {
  db: db, getActorId: getActorId, publishChange: publishChange, CASHIER: CASHIER
});

registerCashierRoutes(app, {
  db: db, getActorId: getActorId, DRIVER: DRIVER, CASHIER: CASHIER, isDateText: isDateText,
  SALE_CUSTOMER_SQL: SALE_CUSTOMER_SQL, phoneComplaint: phoneComplaint, cleanPhone: cleanPhone,
  qrPayments: qrPayments
});

// ==========================================
// DELIVERY PERSONNEL MODULE -- in routes/delivery.js: the deliveries list, a driver's
// runs, cash collected at the door, the driver's summary
// ==========================================
registerDeliveryRoutes(app, {
  db: db, getActorId: getActorId, isDateText: isDateText, publishChange: publishChange,
  DELIVERY_CONTACT_SQL: DELIVERY_CONTACT_SQL, DELIVERY_PHONE_SQL: DELIVERY_PHONE_SQL,
  qrPayments: qrPayments
});

// ==========================================
// INVENTORY MODULE -- in routes/inventory-clerk.js: the clerk's summary and material list,
// selling units, stock adjustments, reorder points, purchase orders, returns
// and damage reports, and the notifications every role reads
// ==========================================
registerInventoryRoutes(app, {
  db: db, getActorId: getActorId, writeAuditLog: writeAuditLog, fieldChanges: fieldChanges,
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS, CASHIER: CASHIER, DRIVER: DRIVER,
  phoneComplaint: phoneComplaint, cleanPhone: cleanPhone, publishChange: publishChange
});

// ==========================================
// SHARED ROUTES -- in routes/shared.js: the live channel, My Account, records,
// archives and the daily job. Last, because the daily job runs the sweeps of
// the admin and manager route files.
// ==========================================
registerSharedRoutes(app, { adminModule: adminModule, managerModule: managerModule });

// npm start runs this file and it listens on the port; on Vercel,
// api/index.js loads it and Vercel hands it the requests.
if (require.main === module) {
  app.listen(port, function () {
    console.log("Server running at http://localhost:" + port);
    const lines = qrPayments.describe();
    for (let i = 0; i < lines.length; i++) {
      console.log(lines[i]);
    }
  });
} else if (IS_VERCEL) {
  const lines = qrPayments.describe();
  for (let i = 0; i < lines.length; i++) {
    console.log(lines[i]);
  }
}

module.exports = app;
