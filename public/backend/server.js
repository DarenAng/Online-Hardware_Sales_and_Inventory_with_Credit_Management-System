const dotenv = require("dotenv");
dotenv.config({ path: require("path").join(__dirname, "..", "..", ".env"), quiet: true });

const express = require("express");
const path = require("path");
const mysqlTools = require("mysql2");
const sqlValue = mysqlTools.escape;
const sqlName = mysqlTools.escapeId;

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

app.set("case sensitive routing", true);

const port = Number(process.env.HARDWARE_PORT) || 3000;

const database = require("./database/connection");
const db = database.db;
const DB_NAME = database.DB_NAME;
const DB_HOST = database.DB_HOST;
const DB_PORT = database.DB_PORT;
const IS_VERCEL = database.IS_VERCEL;

if (IS_VERCEL) app.set("trust proxy", true);

const passwords = require("./services/passwords");
const hashPassword = passwords.hashPassword;
const isHashed = passwords.isHashed;
const generatePassword = passwords.generatePassword;
const verifyPassword = passwords.verifyPassword;

const roles = require("./roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const DRIVER = roles.DRIVER;
const PAGE_ROLES = roles.PAGE_ROLES;
const ROLE_PAGES = roles.ROLE_PAGES;

const migrations = require("./database/migrations");
const EXPECTED_PROCEDURES = migrations.EXPECTED_PROCEDURES;
const SERVER_TABLES = migrations.SERVER_TABLES;
const countProcedures = migrations.countProcedures;
const proceduresAreMissing = migrations.proceduresAreMissing;
const proceduresLoadedCount = migrations.proceduresLoadedCount;
const forgetProcedureCount = migrations.forgetProcedureCount;

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

const startup = db.getConnection()
  .then(async function (connection) {
    connection.release();
    console.log("Connected to MySQL database \"" + DB_NAME + "\" on " + DB_HOST + ":" + DB_PORT + ".");

    await migrations.migrateOneAtATime(adminModule.runSqlScript);

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

app.use("/api/paymongo/webhook", express.raw({ type: "*/*", limit: "1mb" }));

const smallJson = express.json();
app.use(function (request, response, next) {
  if (request.method === "POST" && request.path === "/api/restore") return next();
  smallJson(request, response, next);
});

app.get("/", function (request, response) {
  response.redirect("/Login.html");
});

const FAVICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
  "<rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#1d4ed8\"/>" +
  "<path d=\"M9 8h3v7h8V8h3v16h-3v-7h-8v7H9z\" fill=\"#fff\"/></svg>";

app.get(["/favicon.ico", "/favicon.svg"], function (request, response) {
  response.type("image/svg+xml");
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.send(FAVICON);
});

const PRIVATE_FILES = [
  /^\/back-?end(\/|$)/i,
  /^\/database(\/|$)/i,
  /^\/deployment(\/|$)/i
];

function resolvedPath(rawPath) {
  let pathname;

  try {
    pathname = decodeURIComponent(rawPath);
  } catch (error) {
    return null;
  }

  if (pathname.indexOf("\0") !== -1) return null;
  pathname = pathname.replace(/\\/g, "/");
  pathname = pathname.replace(/\/{2,}/g, "/");

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

  for (let patternIndex = 0; patternIndex < PRIVATE_FILES.length; patternIndex++) {
    const pattern = PRIVATE_FILES[patternIndex];
    if (pattern.test(pathname)) {
      return response.status(404).send("Not found");
    }
  }

  next();
});

app.use(async function (request, response, next) {
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const pathname = resolvedPath(request.path);
  if (pathname === null) return next();

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

  if (!PAGE_ROLES[page].includes(session.roleName) && !(await mayVisitPage(session.roleName, page))) {
    return response.redirect(ROLE_PAGES[session.roleName] || "/Login.html");
  }

  next();
});

async function mayVisitPage(roleName, page) {
  if (roleName === ADMIN || PAGE_ROLES[page].includes(ADMIN)) return false;
  try {
    const list = await featuresOf(roleName);
    for (let i = 0; i < list.length; i++) {
      const feature = list[i];
      if (!feature.held) continue;
      const hosts = feature.hosts || [];
      for (let h = 0; h < hosts.length; h++) {
        if (PAGE_ROLES[page].includes(hosts[h])) return true;
      }
    }
  } catch (error) {
    console.error("Checking a visited page failed:", error.message);
  }
  return false;
}

const PUBLIC_DIR = path.join(__dirname, "..");
app.use(express.static(path.join(PUBLIC_DIR, "frontend")));

app.use(accessControl.accessHook);

registerLoginRoutes(app, {
  db: db, writeAuditLog: writeAuditLog, hashPassword: hashPassword, isHashed: isHashed,
  verifyPassword: verifyPassword, startSession: startSession, setSessionCookie: setSessionCookie,
  endSession: endSession, endSessionsForStaff: endSessionsForStaff,
  renewSessionAfterPasswordChange: renewSessionAfterPasswordChange, clientIp: clientIp,
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS, LOGIN_MAX_ATTEMPTS: LOGIN_MAX_ATTEMPTS,
  LOGIN_HOLD_MINUTES: LOGIN_HOLD_MINUTES, SESSION_IDLE_MINUTES: SESSION_IDLE_MINUTES,
  passwordComplaint: passwordComplaint
});

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

const managerModule = registerManagerRoutes(app, {
  db: db, getActorId: getActorId, writeAuditLog: writeAuditLog, fieldChanges: fieldChanges,
  wordStartSearch: wordStartSearch, requireRole: requireRole, MANAGER: MANAGER,
  LOW_STOCK_EFFECTIVE_SQL: LOW_STOCK_EFFECTIVE_SQL, isDateText: isDateText,
  SALE_CUSTOMER_SQL: SALE_CUSTOMER_SQL, proceduresAreMissing: proceduresAreMissing,
  publishChange: publishChange, CLERK: CLERK, CASHIER: CASHIER, DRIVER: DRIVER,
  cleanPhone: cleanPhone, phoneComplaint: phoneComplaint
});

const qrPayments = registerQrPaymentRoutes(app, {
  db: db, getActorId: getActorId, publishChange: publishChange, isDateText: isDateText,
  CASHIER: CASHIER, DRIVER: DRIVER, port: port
});

registerVoidRequestRoutes(app, {
  db: db, getActorId: getActorId, publishChange: publishChange, CASHIER: CASHIER
});

registerCashierRoutes(app, {
  db: db, getActorId: getActorId, DRIVER: DRIVER, CASHIER: CASHIER, isDateText: isDateText,
  SALE_CUSTOMER_SQL: SALE_CUSTOMER_SQL, phoneComplaint: phoneComplaint, cleanPhone: cleanPhone,
  qrPayments: qrPayments
});

registerDeliveryRoutes(app, {
  db: db, getActorId: getActorId, isDateText: isDateText, publishChange: publishChange,
  DELIVERY_CONTACT_SQL: DELIVERY_CONTACT_SQL, DELIVERY_PHONE_SQL: DELIVERY_PHONE_SQL,
  qrPayments: qrPayments
});

registerInventoryRoutes(app, {
  db: db, getActorId: getActorId, writeAuditLog: writeAuditLog, fieldChanges: fieldChanges,
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS, CASHIER: CASHIER, DRIVER: DRIVER,
  phoneComplaint: phoneComplaint, cleanPhone: cleanPhone, publishChange: publishChange
});

registerSharedRoutes(app, { adminModule: adminModule, managerModule: managerModule });

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
