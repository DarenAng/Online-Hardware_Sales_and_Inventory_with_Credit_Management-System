const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { escape: sqlValue, escapeId: sqlName } = require("mysql2");

const app = express();

// ==========================================
// SETUP - edit these five lines on a new computer
// DB_PASSWORD must match the MySQL root password on THIS machine.
// ==========================================
const DB_HOST = "localhost";
const DB_USER = "root";
const DB_PASSWORD = "Password";
const DB_NAME = "hardware_db";
const port = 3000;

const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

// ==========================================
// PASSWORDS
//
// Stored as scrypt hashes, never as readable text. scrypt ships inside
// Node itself, so this needs no extra package installed on a new computer.
// Format: scrypt$<salt>$<hash>
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

async function verifyPassword(plainText, stored) {
  // a row that was never hashed holds the password itself; it is accepted once
  // and hashed on the spot by the caller, never left readable
  if (!isHashed(stored)) {
    return typeof stored === "string" && stored.length > 0 && stored === plainText;
  }

  const [, salt, expected] = stored.split("$");
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const expectedBytes = Buffer.from(expected, "hex");

  if (expectedBytes.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBytes);   // constant time
}

// One-time upgrade for a database created before hashing existed. The stored
// value IS the password on those rows, so it can be hashed in place. Runs on
// every start and does nothing once every row is already hashed.
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

// tells you at startup whether the database connection works,
// instead of failing later on the first request
// Kept as a named figure rather than a number typed twice: adding a procedure
// and forgetting to change one of the two copies is how a warning starts
// lying about a database that is actually fine.
const EXPECTED_PROCEDURES = 27;

db.getConnection()
  .then(async (connection) => {
    connection.release();
    console.log(`Connected to MySQL database "${DB_NAME}" on ${DB_HOST}.`);

    // warns you when 2-RUN-SECOND-stored-procedures.sql was never loaded on this machine
    const [rows] = await db.query(
      "SELECT COUNT(*) AS total FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
      [DB_NAME]
    );
    if (rows[0].total < EXPECTED_PROCEDURES) {
      console.warn(`WARNING: only ${rows[0].total} of ${EXPECTED_PROCEDURES} stored procedures found.`);
      console.warn("Run public/database/2-RUN-SECOND-stored-procedures.sql in MySQL Workbench or the mysql CLI.");
    } else {
      console.log(`All ${EXPECTED_PROCEDURES} stored procedures are loaded.`);
    }

    await hashLegacyPasswords();
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

// Every browser asks for this without being told to, and every page in the
// system was answering it with a 404 in the console. A console with a standing
// error in it is a console nobody reads, which is where a real error goes to
// hide. One small mark, drawn rather than shipped as a file.
const FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="6" fill="#1d4ed8"/>` +
  `<path d="M9 8h3v7h8V8h3v16h-3v-7h-8v7H9z" fill="#fff"/></svg>`;

app.get(["/favicon.ico", "/favicon.svg"], (request, response) => {
  response.type("image/svg+xml");
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.send(FAVICON);
});

// The pages, the stylesheet and app.js live under public/ and are meant to be
// downloaded. The server's own source and the SQL files sit in that same folder
// and are not: they carry the database password and the whole schema. Blocking
// them here keeps the folder layout the project already has.
const PRIVATE_FILES = [/^\/javascript\/server\.js$/i, /^\/database(\/|$)/i];

// THE SAME PATH THE FILE SERVER WILL SEE
//
// request.path is the raw text out of the address bar. express.static does not
// use it raw: it percent-decodes it and collapses the result down to one real
// filesystem path, so "//javascript/server.js" and "/javascript/%73erver.js"
// both end up at the same file that "/javascript/server.js" does.
//
// A guard that tests the raw text is therefore testing a different string from
// the one that decides which file is sent, and every spelling the guard has not
// thought of walks straight past it. This resolves the path the same way first,
// so the guard and the file server are always arguing about the same thing.
function resolvedPath(rawPath) {
  let pathname;

  try {
    pathname = decodeURIComponent(rawPath);
  } catch (error) {
    return null;   // a malformed %-escape; nothing legitimate is spelled this way
  }

  // a null byte truncates a filename inside the operating system, and a
  // backslash is a separator on the Windows machines this runs on
  if (pathname.indexOf("\0") !== -1) return null;
  pathname = pathname.replace(/\\/g, "/").replace(/\/{2,}/g, "/");

  // resolves . and .. so a private folder cannot be reached by walking out of
  // a public one and back in
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

app.use(express.static(path.join(__dirname, "..")));

// ==========================================
// HELPERS
// ==========================================

// runs a stored procedure and reads its OUT values on the same connection
async function callProcedure(sql, params, outputNames) {
  const connection = await db.getConnection();
  try {
    await connection.query(sql, params);
    const selectList = outputNames.map((name) => `@${name} AS ${name}`).join(", ");
    const [rows] = await connection.query(`SELECT ${selectList}`);
    return rows[0];
  } finally {
    connection.release();
  }
}

// A middle initial is one letter. Anything longer is a typing slip, so only the
// first letter is kept, and an empty box stays empty rather than becoming "".
function cleanInitial(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed[0].toUpperCase();
}

// ==========================================
// THE AUDIT TRAIL
//
// An entry used to be a staff id, an action name and a line of prose. That
// records that something happened without answering what an audit is for:
// which role the person held at the time, which machine it came from, what
// kind of action it was, and what the values were before and after.
//
// The role is written down rather than joined, because a person moves between
// roles and a join would rewrite last month's history the day they are
// promoted. The address is read off the socket, never off a header the
// browser controls, unless this server is knowingly behind a proxy.
// ==========================================

// Set to true only when this server sits behind a reverse proxy you control.
// Left false, X-Forwarded-For is ignored, because on a directly reachable
// server any browser can put whatever it likes in that header.
const TRUST_PROXY_HEADERS = false;

function clientIp(request) {
  let address = "";

  if (TRUST_PROXY_HEADERS && request.headers["x-forwarded-for"]) {
    address = String(request.headers["x-forwarded-for"]).split(",")[0].trim();
  } else if (request.socket && request.socket.remoteAddress) {
    address = request.socket.remoteAddress;
  }

  // an IPv4 address arriving over an IPv6 socket comes wrapped, and the two
  // spellings of one machine should not read as two machines
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") address = "127.0.0.1";

  return address || null;
}

// The category the audit screen filters on. The action name still says
// exactly what happened; this says what kind of thing it was.
const AUDIT_TYPES = [
  "CREATE", "UPDATE", "DELETE", "VOID", "RESTORE", "BACKUP",
  "LOGIN", "LOGOUT", "LOGIN_FAILURE", "SECURITY", "PAYMENT", "OTHER"
];

function actionTypeOf(action) {
  const name = String(action || "").toUpperCase();

  if (AUDIT_TYPES.includes(name)) return name;
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

// Accepts the request itself (the usual case, and the only one that can know
// the role and the address), or a plain staff id from the few places that
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

// metadata is the before and after of whatever changed. It is stored as text
// so it survives any backup, and capped so one runaway object cannot fill the
// column; an entry is never worth losing over its own detail.
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

// Only the fields that actually moved. An entry listing every column of a
// record, most of them unchanged, buries the one edit that mattered.
function fieldChanges(before, after) {
  if (!before) return after;

  const changes = {};

  for (const field of Object.keys(after)) {
    const was = before[field] === undefined ? null : before[field];
    const now = after[field] === undefined ? null : after[field];

    // loose on purpose: a number out of the database and the same number out
    // of a form field are the same value, not a change
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
// SESSIONS
//
// The browser never tells us who it is. It sends an opaque session
// cookie, and the server looks the staff id up from its own store.
// Nothing the browser can edit decides what it is allowed to do.
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

// returns the live session, or null when it is missing or expired
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

// ==========================================
// PRESENCE
//
// Two different facts get confused whenever a staff list shows only one of
// them. An account being Active says the administrator has not deactivated
// it. It says nothing at all about whether the person is sitting in front of
// a screen right now, which is what somebody scanning the directory during a
// shift actually wants to know.
//
// So presence is answered from the session store, which already knows: a
// session is refreshed by every request its owner makes, and the browser
// sends a heartbeat while a page is open but idle. Anything quiet for longer
// than the window below is counted as gone.
//
// It is deliberately memory only. A restarted server has no sessions, and
// nobody is signed in to a server that just restarted, so the answer is
// right rather than merely persistent.
// ==========================================
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

  // A browser holding the live channel open is a page somebody has in front of
  // them, whether or not it has asked the server for anything lately.
  for (const client of liveClients) {
    seen.set(client.staffId, now);
  }

  return seen;
}

// decorates staff rows with whether their owner is here right now
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

// SWEEPING UP AFTER THE ONES NOBODY COMES BACK FOR
//
// An expired session was only ever dropped when its own browser presented the
// cookie again, and the browser of somebody who closed their laptop on Friday
// never does. Every sign-in of every shift therefore left an entry behind for
// good, in a process that is meant to run for months at a time.
//
// unref() so this timer is not itself a reason for the process to stay alive.
const SESSION_SWEEP_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}, SESSION_SWEEP_MS).unref();

// drops every session belonging to one staff member, so deactivating
// or demoting somebody takes effect immediately instead of in 8 hours
function endSessionsForStaff(staffId) {
  for (const [token, session] of sessions) {
    if (session.staffId === Number(staffId)) sessions.delete(token);
  }
}

// the signed-in staff id, taken from the session and never from the request body
function getActorId(request) {
  return request.actor ? request.actor.staffId : null;
}

// ==========================================
// LIVE SYNC ACROSS DESKTOPS
//
// The shop runs on more than one machine. A clerk adjusts stock on the
// stockroom PC and the cashier at the till is looking at the figure from
// before the adjustment, which is how two people sell the same last bag of
// cement. The answer used to be to restore the database by hand, which is not
// an answer.
//
// So the server keeps a running version number and a short log of what
// changed, and every signed-in browser holds one open connection to hear
// about it. Server-Sent Events rather than WebSockets: this is one-way
// traffic — the server telling browsers something moved — and SSE is a plain
// GET over the HTTP server that is already running, reconnects by itself, and
// needs no new dependency and no second port to open on a shop network.
//
// What travels is deliberately not the data. A change says "inventory moved,
// version 412" and nothing else; the browser decides whether it is looking at
// anything affected and asks for it through the normal route, with the normal
// access check. Pushing rows down this channel would mean a second copy of
// every permission rule.
// ==========================================
let changeVersion = 0;
const changeLog = [];          // the last few changes, for a client that reconnects
const CHANGE_LOG_SIZE = 200;
const liveClients = new Set(); // { id, staffId, roleName, response }

// Which part of the system a route belongs to. A browser subscribes to the
// scopes its open tables read, so a purchase order does not wake up a screen
// showing the staff directory.
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
      // a browser that has gone away is removed by its own close handler;
      // one failed write is not worth tearing anything down over
    }
  }
}

// Everything that changed since a version a reconnecting browser last saw. A
// gap wider than the log means it has been away too long to catch up, and it
// is told to reload rather than shown a partial history.
function changesSince(version) {
  if (!Number.isInteger(version) || version <= 0) return { changes: [], gap: false };
  if (changeLog.length === 0) return { changes: [], gap: false };
  if (version < changeLog[0].version - 1) return { changes: [], gap: true };
  return { changes: changeLog.filter((c) => c.version > version), gap: false };
}

// ==========================================
// ACCESS CONTROL
//
// The whole policy lives in this one table so it can be read, reviewed
// and defended in one place. Rules are matched in order, first match wins,
// and anything under /api with no rule at all is refused.
// ==========================================
const ADMIN = "System Administrator";
const MANAGER = "Manager";
const CLERK = "Inventory Clerk";
const CASHIER = "Cashier";
const DRIVER = "Delivery Personnel";

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
  ["PUT",   /^\/api\/me$/,                             SIGNED_IN],
  ["POST",  /^\/api\/me\/password$/,                   SIGNED_IN],

  // --- staff accounts, administrator only ---
  ["GET",   /^\/api\/roles$/,                          [ADMIN]],
  ["GET",   /^\/api\/users$/,                          [ADMIN]],
  ["GET",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["POST",  /^\/api\/users$/,                          [ADMIN]],
  ["PUT",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["PATCH", /^\/api\/users\/\d+\/status$/,             [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account$/,            [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/reset-password$/,     [ADMIN]],
  ["GET",   /^\/api\/audit-logs$/,                     [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/types$/,              [ADMIN]],

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

  // Exporting is the line between the two reporting roles. A manager can take
  // a report off the premises; a cashier or clerk reads their daily tally on
  // the screen and nothing leaves the building with them. That rule is
  // enforced here rather than by hiding a button, because a hidden button is
  // still a URL anybody can type.
  ["GET",   /^\/api\/reports\/export$/,                [MANAGER]],
  ["GET",   /^\/api\/reports\/daily-tally$/,           [MANAGER, CASHIER, CLERK]],

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

  // The clerk who can create a unit by typing it is the clerk who has to be
  // able to correct it. A manager keeps the same reach for the same reason.
  ["PUT",   /^\/api\/units\/\d+$/,                     [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders$/,                [CLERK]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/items$/,    [CLERK]],
  // The printed order is the one thing here a manager also needs to be able
  // to pull up: they are the ones asked about it when a supplier telephones.
  ["GET",   /^\/api\/purchase-orders\/\d+\/document$/, [CLERK, MANAGER]],
  ["POST",  /^\/api\/purchase-orders$/,                [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/receive$/,  [CLERK]],

  // Opening a record for a material the shop has never stocked. The clerk is
  // the person standing in front of the delivery, so the clerk is the person
  // who can do it.
  ["POST",  /^\/api\/materials$/,                      [CLERK]],

  // --- returns, damage and refunds ---
  ["GET",   /^\/api\/returns$/,                        [CLERK, CASHIER]],
  ["POST",  /^\/api\/returns$/,                        [CLERK, CASHIER]],
  ["POST",  /^\/api\/returns\/\d+\/resolve$/,          [CLERK]],

  // --- credit management ---
  // Reading a customer's credit is a counter action: the cashier has to know
  // before ringing a sale up. Changing a limit or deciding an extension is a
  // manager action, and no amount of standing at the counter makes it one.
  ["GET",   /^\/api\/credit\/customers$/,              [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/customers\/\d+$/,         [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/customers\/\d+\/limit$/,  [MANAGER]],
  ["GET",   /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests\/\d+\/decide$/,  [MANAGER]],
  ["GET",   /^\/api\/customers\/\d+\/history$/,        [MANAGER, CASHIER]],

  // Opening an account is a counter action; giving it a credit limit is not,
  // and the route that sets a limit stays manager-only above. A cashier can
  // therefore name a regular customer without being able to lend to them.
  ["POST",  /^\/api\/customers$/,                      [MANAGER, CASHIER]],

  // --- shared lookups and archives ---
  ["GET",   /^\/api\/records\/\w+$/,                   [MANAGER, CASHIER, CLERK]],
  ["GET",   /^\/api\/archives$/,                       [MANAGER, ADMIN]],
  ["POST",  /^\/api\/archives\/archive$/,              [CLERK, MANAGER, ADMIN]],
  ["POST",  /^\/api\/archives\/restore$/,              [CLERK, MANAGER, ADMIN]],

  // --- who the shop is, and how it is registered ---
  // Every dashboard that prints or previews an invoice needs to read this,
  // so reading is open to anyone signed in. Changing a TIN or flipping the
  // shop between VAT and non-VAT changes what every future invoice claims
  // about the business, which is an administrator's decision and nobody
  // else's.
  ["GET",   /^\/api\/store-settings$/,                 SIGNED_IN],
  ["PUT",   /^\/api\/store-settings$/,                 [ADMIN]],

  // --- notifications ---
  ["GET",   /^\/api\/notifications$/,                  SIGNED_IN],
  ["POST",  /^\/api\/notifications\/\d+\/read$/,       SIGNED_IN],
  ["POST",  /^\/api\/notifications\/read-all$/,        SIGNED_IN]
];

function findRule(method, pathname) {
  for (const [ruleMethod, pattern, allowed] of ACCESS_RULES) {
    if (ruleMethod === method && pattern.test(pathname)) return allowed;
  }
  return null;
}

app.use((request, response, next) => {
  if (!request.path.startsWith("/api/")) return next();

  const allowed = findRule(request.method, request.path);

  // an endpoint nobody granted is an endpoint nobody may call
  if (allowed === null) {
    return response.status(403).json({ error: "This feature is not available." });
  }

  if (allowed === PUBLIC) return next();

  const session = currentSession(request);
  if (!session) {
    return response.status(401).json({ error: "Your session has ended. Please sign in again." });
  }

  if (allowed !== SIGNED_IN && !allowed.includes(session.roleName)) {
    return response.status(403).json({
      error: `A ${session.roleName} cannot use this feature.`
    });
  }

  request.actor = session;

  // ONE HOOK, NOT FIFTY
  //
  // Every write in the system already passes through here, so this is where a
  // change is announced from. Doing it per route would mean remembering to add
  // a line to every new one, and the line that gets forgotten is the screen
  // that silently stops updating.
  //
  // It fires after the response is actually finished and only for a write that
  // succeeded: an announcement for a request that was refused would send every
  // other desktop off to re-read data that did not move.
  if (request.method !== "GET" && request.method !== "HEAD") {
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

// archived_at and archived_by come along because the archive screen shows a
// record on its own now rather than a row with a button on the end, and a
// restoration card that cannot say when or by whom is not a card worth
// opening.
const USER_SELECT = `
  SELECT s.staff_id, s.first_name, s.middle_initial, s.last_name, s.full_name,
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
// ==========================================
app.post("/api/login", async (request, response) => {
  const { email, password } = request.body;

  if (!email || !password) {
    return response.status(400).json({ error: "Email and password are required" });
  }

  try {
    // the password is checked here, not in the query, because the column
    // holds a hash that no plain value will ever equal
    const [rows] = await db.query(
      `SELECT u.user_id, u.staff_id, u.email, u.password, u.must_change_password,
              s.first_name, s.middle_initial, s.last_name, s.full_name, s.is_active,
              r.role_id, r.role_name
       FROM users u
       JOIN staff s ON s.staff_id = u.staff_id
       JOIN roles r ON r.role_id = s.role_id
       WHERE u.email = ?
       LIMIT 1`,
      [email]
    );

    // A failed sign-in is the one event an audit trail is most often opened
    // for, and it was the one event this system did not record. Both failures
    // are logged; the reply stays identical either way, so nobody can use the
    // difference to find out which addresses exist.
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

    if (!(await verifyPassword(password, user.password))) {
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN_FAILURE",
        `Sign-in refused for ${email}: wrong password`,
        { email: String(email), reason: "wrong_password" }
      );
      return response.status(401).json({ error: "Invalid email or password" });
    }

    // A database restored from an older backup can bring back rows whose
    // password column still holds readable text. Upgrading that row here, on
    // the sign-in that proves the password, means a restore does not lock
    // people out until somebody restarts the server.
    if (!isHashed(user.password)) {
      await db.query("UPDATE users SET password = ? WHERE user_id = ?",
        [await hashPassword(password), user.user_id]);
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
    response.cookie("sid", token, {
      httpOnly: true,                              // JavaScript on the page cannot read it
      sameSite: "strict",                          // not sent from another site
      maxAge: SESSION_HOURS * 60 * 60 * 1000,
      path: "/"
    });

    // the browser still gets the profile, but only to draw the screen with.
    // Nothing it sends back is trusted for permission decisions.
    response.json({ message: "Login successful", user });
  } catch (error) {
    console.error("Login failed:", error.message);
    response.status(500).json({ error: "Unable to log in" });
  }
});

app.post("/api/logout", async (request, response) => {
  // written before the session is torn down, while it still knows the role
  await writeAuditLog(request, "LOGOUT", `${request.actor.email} signed out`);

  endSession(request);
  response.clearCookie("sid", { path: "/" });
  response.json({ message: "Signed out" });
});

// ==========================================
// HEARTBEAT
//
// A page left open makes no requests, and a person reading a report for ten
// minutes is not gone. This is the one call the browser makes on its own, so
// the staff directory can tell somebody who is here from somebody who closed
// their laptop. It touches nothing: the access check ahead of it has already
// refreshed the session's clock.
// ==========================================
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
// One open GET per signed-in browser. Nothing is sent down it but "something
// in this area moved, at this version"; the browser decides whether it cares
// and then asks through the normal routes, with the normal access checks.
//
// Three things make it survive a shop network rather than only a laptop:
// a comment every twenty-five seconds so a proxy does not time the connection
// out as idle, X-Accel-Buffering off so nginx does not hold the frames back
// waiting for a buffer to fill, and Last-Event-ID honoured on reconnect so a
// browser that dropped for a minute catches up instead of guessing.
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

  // browsers wait this long before reconnecting after a drop
  response.write("retry: 3000\n\n");

  const client = {
    id: crypto.randomBytes(8).toString("hex"),
    staffId: actor.staffId,
    roleName: actor.roleName,
    token: readCookie(request, "sid"),
    response: response
  };
  liveClients.add(client);

  // What was missed while the browser was away. A gap wider than the log is
  // said so plainly rather than papered over with a partial history.
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

  // A page held open on this stream is a person at a screen, so the ping is
  // also what keeps their session alive and marks them present. Without this
  // a reader would be signed out mid-report by their own stillness.
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

// what the live channel currently looks like, for the administrator's screen
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

  // the account being changed is always the one that is signed in,
  // never one named in the request body
  const userId = request.actor.userId;

  if (!userId || typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  try {
    const [result] = await db.query(
      "UPDATE users SET password = ?, must_change_password = FALSE WHERE user_id = ? AND must_change_password = TRUE",
      [await hashPassword(newPassword), userId]
    );

    if (result.affectedRows === 0) {
      return response.status(403).json({ error: "Password change is not allowed" });
    }

    response.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Password update failed:", error.message);
    response.status(500).json({ error: "Unable to change password" });
  }
});

// ==========================================
// YOUR OWN ACCOUNT
//
// Every role reaches these three routes from the account menu in the top right
// corner. They always act on the signed-in account: the staff id comes from the
// session, so nobody can edit somebody else's details by changing a request.
// A role is deliberately not editable here; only an administrator moves people
// between roles.
// ==========================================
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

app.put("/api/me", async (request, response) => {
  const { firstName, middleInitial, lastName, phone, email } = request.body;
  const actor = request.actor;

  if (!firstName || !lastName) {
    return response.status(400).json({ error: "First name and last name are required" });
  }

  if (email !== undefined && email !== null && String(email).trim() !== "" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return response.status(400).json({ error: "That email address does not look right" });
  }

  try {
    // the role passed in is the one already on file, never one from the browser
    const output = await callProcedure(
      "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [actor.staffId, String(firstName).trim(), cleanInitial(middleInitial),
       String(lastName).trim(), phone ? String(phone).trim() : null,
       actor.roleId, email ? String(email).trim() : null],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    // the session caches the email for the audit trail, so keep it current
    if (email && String(email).trim() !== "") actor.email = String(email).trim();

    // the request, not the bare staff id: an entry that cannot say which role
    // the person held or which machine it came from is half an audit entry
    await writeAuditLog(request, "UPDATE_OWN_PROFILE", `${actor.email} updated their own details`);

    const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [actor.staffId]);
    response.json({ message: "Your details were saved.", user: rows[0] });
  } catch (error) {
    console.error("Profile update failed:", error.message);
    response.status(500).json({ error: "Unable to save your details" });
  }
});

app.post("/api/me/password", async (request, response) => {
  const { currentPassword, newPassword } = request.body;
  const actor = request.actor;

  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "The new password must contain at least 8 characters" });
  }

  if (typeof currentPassword !== "string" || currentPassword === "") {
    return response.status(400).json({ error: "Enter your current password" });
  }

  if (currentPassword === newPassword) {
    return response.status(400).json({ error: "The new password must be different from the current one" });
  }

  try {
    const [rows] = await db.query("SELECT password FROM users WHERE staff_id = ?", [actor.staffId]);

    if (rows.length === 0) {
      return response.status(404).json({ error: "This account has no login yet." });
    }

    // knowing the current password is what proves an unattended screen
    // is not being used by somebody else
    if (!(await verifyPassword(currentPassword, rows[0].password))) {
      return response.status(403).json({ error: "That is not your current password" });
    }

    await db.query(
      "UPDATE users SET password = ?, must_change_password = FALSE WHERE staff_id = ?",
      [await hashPassword(newPassword), actor.staffId]
    );

    await writeAuditLog(request, "CHANGE_OWN_PASSWORD", `${actor.email} changed their own password`);
    response.json({ message: "Your password was changed." });
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

// (GET /api/products was removed: nothing called it, and
//  GET /api/inventory/products already returns a better shaped list)

// ==========================================
// STAFF ACCOUNTS
// ==========================================

// Every staff member, including anyone with no login account yet, each row
// carrying whether its owner is signed in at this moment.
//
// The two optional filters are applied here rather than in the browser so a
// directory that grows past a few hundred people does not have to travel
// across the wire in full to answer "show me the inactive ones". The reply is
// still a plain array either way, because every screen that already reads
// this route expects one.
app.get("/api/users", async (request, response) => {
  const status = String(request.query.status || "all").toLowerCase();
  const search = String(request.query.search || "").trim();

  const where = [];
  const params = [];

  if (status === "active") where.push("s.is_active = TRUE");
  else if (status === "inactive") where.push("s.is_active = FALSE");

  if (search !== "") {
    where.push("(s.full_name LIKE ? OR u.email LIKE ? OR r.role_name LIKE ?)");
    const like = `%${search}%`;
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

app.post("/api/users", async (request, response) => {
  const { firstName, middleInitial, lastName, phone, roleId, email, password } = request.body;

  if (!firstName || !lastName || !roleId || !email || !password) {
    return response.status(400).json({ error: "Name, role, email and password are required" });
  }

  if (password.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_staff_account(?, ?, ?, ?, ?, ?, ?, @staff_id, @status_code, @message)",
      [firstName, cleanInitial(middleInitial), lastName, phone || null, roleId,
       email, await hashPassword(password)],
      ["staff_id", "status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(
      request,
      "CREATE_ACCOUNT",
      `Created account for ${email}`,
      { staff_id: output.staff_id, email: email, role_id: Number(roleId),
        name: `${firstName} ${lastName}`.trim() }
    );
    response.json({ message: output.message, staffId: output.staff_id });
  } catch (error) {
    console.error("Create account failed:", error.message);
    response.status(500).json({ error: "Unable to create the account" });
  }
});

app.put("/api/users/:staffId", async (request, response) => {
  const { firstName, middleInitial, lastName, phone, roleId, email } = request.body;

  if (!firstName || !lastName || !roleId) {
    return response.status(400).json({ error: "Name and role are required" });
  }

  try {
    // read before writing, so the audit entry can say what actually changed
    // rather than only that something did
    const [existing] = await db.query(
      `SELECT s.first_name, s.middle_initial, s.last_name, s.phone,
              s.role_id, u.email
       FROM staff s LEFT JOIN users u ON u.staff_id = s.staff_id
       WHERE s.staff_id = ?`,
      [request.params.staffId]
    );
    const before = existing[0] || null;

    const output = await callProcedure(
      "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [request.params.staffId, firstName, cleanInitial(middleInitial), lastName,
       phone || null, roleId, email || null],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    // the role may have changed, so the old session's cached role is no longer safe
    endSessionsForStaff(request.params.staffId);

    const after = {
      first_name: firstName,
      middle_initial: cleanInitial(middleInitial),
      last_name: lastName,
      phone: phone || null,
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

app.patch("/api/users/:staffId/status", async (request, response) => {
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

    // a deactivated account must lose access now, not when its session lapses
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

// gives a login account to a staff member who has none yet
app.post("/api/users/:staffId/account", async (request, response) => {
  const { email, password } = request.body;

  if (!email || !password) {
    return response.status(400).json({ error: "Email and password are required" });
  }

  if (password.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_create_login_for_staff(?, ?, ?, @status_code, @message)",
      [request.params.staffId, email, await hashPassword(password)],
      ["status_code", "message"]
    );

    if (output.status_code !== 201) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(request, "CREATE_LOGIN", `Login created for staff #${request.params.staffId}`);
    response.json({ message: output.message });
  } catch (error) {
    console.error("Create login failed:", error.message);
    response.status(500).json({ error: "Unable to create the login account" });
  }
});

app.post("/api/users/:staffId/reset-password", async (request, response) => {
  const { newPassword } = request.body;

  // the length rule now has to live here: the procedure only ever sees a hash
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  try {
    const output = await callProcedure(
      "CALL sp_reset_user_password(?, ?, @status_code, @message)",
      [request.params.staffId, await hashPassword(newPassword)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    await writeAuditLog(request, "RESET_PASSWORD", `Staff #${request.params.staffId}`);
    response.json({ message: output.message });
  } catch (error) {
    console.error("Password reset failed:", error.message);
    response.status(500).json({ error: "Unable to reset the password" });
  }
});

// ==========================================
// AUDIT LOGS
// ==========================================
// The trail, newest first, with the four filters the screen offers: the kind
// of action, a date range, and free text across the person, the action and
// the detail. An entry keeps the role it was written under; only entries from
// before that column existed fall back to the role the person holds now.
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

  // a date is inclusive of the whole day, which is what somebody typing one
  // into a box means by it
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
    const like = `%${search}%`;
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

// the list of action types, so the filter offers exactly what the trail holds
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
// A backup is a complete .sql file: the schema, every row of every table,
// the two views and the stored procedures. It is written into the project's
// backups/ folder and named after the moment it was taken, so the folder
// becomes a history rather than one file that keeps being overwritten.
//
// The same file opens in MySQL Workbench and runs there, which is what makes
// it a real backup instead of an export only this application understands.
// ==========================================
const BACKUP_DIR = path.join(__dirname, "..", "..", "backups");
const BACKUP_PREFIX = "hardware_db_backup_";

// only files this system wrote itself, never a path typed by the browser
const BACKUP_NAME = /^hardware_db_backup_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;

async function ensureBackupFolder() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
}

// 2026-09-04 14:07 local time -> hardware_db_backup_2026-09-04_1407.sql
function backupFileName(when) {
  const pad = (number) => String(number).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
                `_${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `${BACKUP_PREFIX}${stamp}.sql`;
}

// two backups inside the same minute must not overwrite each other
async function freeBackupPath(when) {
  await ensureBackupFolder();
  const base = backupFileName(when);
  let name = base;
  let counter = 2;

  while (fs.existsSync(path.join(BACKUP_DIR, name))) {
    name = base.replace(/\.sql$/, `-${counter}.sql`);
    counter += 1;
  }
  return { name, fullPath: path.join(BACKUP_DIR, name) };
}

// Generated columns are computed by MySQL from the other columns, so writing
// them back is refused. They are read from the catalogue rather than listed by
// hand, so a new generated column never silently breaks a restore.
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

async function listViews() {
  const [rows] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [DB_NAME]
  );
  return rows.map((row) => row.TABLE_NAME);
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

// A DEFINER clause names the MySQL account that created the object. Restoring
// on another computer, where that account does not exist, fails on it. Dropping
// it is what lets one machine's backup open on another machine.
function stripDefiner(sql) {
  return String(sql).replace(/DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*/gi, "");
}

// Writes the whole database to one .sql file and returns what it contains.
async function writeBackupFile() {
  const now = new Date();
  const { name, fullPath } = await freeBackupPath(now);

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

    // views first, because a view that reads a table being rebuilt is invalid
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

      // batched so a large table does not become one unreadable line
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
// and DELIMITER are all respected, so a semicolon inside a procedure body or
// inside a piece of text does not cut a statement in half.
function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ";";
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const rest = sql.slice(index);

    // a DELIMITER line only counts at the start of a statement
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
          // '' inside a quoted string is an escaped quote, not the end of it
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
// restore either lands or leaves the database exactly as it was.
async function runSqlScript(sql) {
  const statements = splitSqlStatements(sql);

  if (statements.length === 0) {
    throw new Error("That file contains no SQL statements.");
  }

  const connection = await db.getConnection();

  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    for (const statement of statements) {
      // USE and the connection's own settings are decided here, not by the file
      if (/^use[\s`]/i.test(statement)) continue;
      await connection.query(statement);
    }

    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    return statements.length;
  } finally {
    connection.release();
  }
}

// the dated history the Backup & Recovery screen lists, newest first
app.get("/api/backups", async (request, response) => {
  try {
    await ensureBackupFolder();
    const names = (await fsp.readdir(BACKUP_DIR)).filter((name) => BACKUP_NAME.test(name));

    const files = await Promise.all(names.map(async (name) => {
      const stats = await fsp.stat(path.join(BACKUP_DIR, name));
      return { fileName: name, bytes: stats.size, createdAt: stats.mtime.toISOString() };
    }));

    files.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    response.json({ folder: BACKUP_DIR, files });
  } catch (error) {
    console.error("Backup list failed:", error.message);
    response.status(500).json({ error: "Unable to read the backup folder" });
  }
});

app.post("/api/backups", async (request, response) => {
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

app.delete("/api/backups/:fileName", async (request, response) => {
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

// restore from a file already sitting in the backups folder
app.post("/api/backups/:fileName/restore", async (request, response) => {
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
    response.json({ message: `Database restored from ${name}. ${count} statements ran.` });
  } catch (error) {
    console.error("Restore failed:", error.message);
    response.status(500).json({ error: "Restore failed: " + error.message });
  }
});

// restore from a .sql file the administrator picked off their own computer
app.post("/api/restore", async (request, response) => {
  const sql = request.body && request.body.sql;

  if (typeof sql !== "string" || sql.trim() === "") {
    return response.status(400).json({ error: "The file is empty or is not a .sql backup." });
  }

  try {
    const count = await runSqlScript(sql);
    await writeAuditLog(request, "RESTORE", "Restored from an uploaded .sql file");
    response.json({ message: `Database restored. ${count} statements ran.` });
  } catch (error) {
    console.error("Restore failed:", error.message);
    response.status(500).json({ error: "Restore failed: " + error.message });
  }
});

// ==========================================
// MANAGER MODULE
// ==========================================

// ==========================================
// DATE RANGES
//
// Every report on the manager's screen is asked the same question in one of
// seven ways, so the seven are resolved in one place and everything
// downstream deals in a plain from-and-to pair.
//
// The ranges are counted back from today rather than snapped to calendar
// boundaries, because "this month" on the third of the month is four days of
// trading and reads as a collapse in sales. A manager asking for the month
// wants the last thirty days.
// ==========================================
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

// The calendar day this machine is having, not the one Greenwich is having.
//
// toISOString() always answers in UTC. Every date comparison downstream of
// this ends up beside CURDATE() or DATE(sale_date) in SQL, which MySQL answers
// in the server's own timezone, so a UTC answer here quietly disagreed with the
// database for the first eight hours of every Philippine day: a manager opening
// Today's income at seven in the morning was shown yesterday's trading, while
// the cashier's end-of-shift card on the next desk correctly said today.
function isoDay(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Resolves whatever the screen asked for into { from, to, label, bucket }.
// A custom pair always wins over a named range, so a manager who has typed
// two dates is never quietly given something else.
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

// A chart with 365 columns is a smear and a chart with 2 is a nothing, so the
// bucket follows the span rather than the name of the range.
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

// ==========================================
// THE INCOME BREAKDOWN
//
// The Total Income card on the dashboard opens this. It answers one question
// four ways, because "how much did we make" means four different figures to
// four different people, and a screen that shows only one of them gets
// argued with:
//
//   billed     what was rung up, whether or not the money arrived
//   collected  what is actually in hand, which is what pays the suppliers
//   outstanding what is still owed on it
//   discounts  what was given away to get the sale
//
// Collected is the headline, because this is a shop with a credit book and
// billed income that never arrives is not income.
// ==========================================
// One function behind both the screen and the export, so a downloaded file
// and the page it came from can never disagree about a figure.
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

// ==========================================
// TAKING A REPORT AWAY
//
// CSV rather than a real .xlsx, and deliberately: Excel, LibreOffice and
// Google Sheets all open a CSV without being asked twice, it needs no library
// on the server, and there is nothing in a sales report that wants a formula.
// A PDF is the browser's own print dialogue over a print stylesheet, for the
// same reason: what a manager wants is the page they are already looking at,
// on paper, not a second rendering of it that drifts from the screen.
//
// The access rule above is what actually stops a cashier exporting. This
// function only decides what the file says.
// ==========================================
function csvCell(value) {
  if (value === null || value === undefined) return "";

  const text = String(value);
  // a comma, a quote or a line break turns the field into a quoted one, and a
  // quote inside a quoted field is doubled. That is the whole format.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDocument(headers, rows) {
  // A BOM, so Excel on Windows reads it as UTF-8 rather than as the local
  // code page and turns a peso sign into mojibake. Every other reader
  // ignores it.
  return "﻿" +
    [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))]
      .join("\r\n") + "\r\n";
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
    // the export reads exactly what the screen reads, through the same route,
    // so a downloaded file and the page it came from can never disagree
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

// ==========================================
// THE DAILY TALLY
//
// What a cashier or a clerk gets instead of the reporting suite: one day, on
// the screen, for balancing a drawer at the end of a shift. A manager asking
// for it sees the whole shop's day rather than their own, because a manager
// has no drawer of their own to balance.
//
// canExport travels with it so the screen knows whether to draw the export
// buttons. It is a convenience, not the control: the export route refuses a
// cashier whatever this says.
// ==========================================
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

// dashboard headline numbers
app.get("/api/manager/summary", async (request, response) => {
  try {
    const [[sales]] = await db.query(
      `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS gross_sales,
              COALESCE(SUM(CASE WHEN payment_status <> 'Paid' THEN final_amount - amount_paid ELSE 0 END), 0) AS receivables
       FROM sales WHERE is_archived = FALSE`
    );
    const [[stock]] = await db.query(
      `SELECT COUNT(*) AS product_count,
              COALESCE(SUM(CASE WHEN i.quantity_in_stock <= p.reorder_point THEN 1 ELSE 0 END), 0) AS low_stock
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       WHERE p.is_archived = FALSE`
    );
    const [[delivery]] = await db.query(
      `SELECT COUNT(*) AS delivery_count,
              COALESCE(SUM(CASE WHEN status IN ('Pending','In Transit','Out for Delivery') THEN 1 ELSE 0 END), 0) AS in_progress,
              COALESCE(SUM(CASE WHEN status IN ('Delayed','Failed') THEN 1 ELSE 0 END), 0) AS problem
       FROM deliveries WHERE is_archived = FALSE`
    );
    const [[archive]] = await db.query("SELECT COUNT(*) AS archive_count FROM vw_archives");

    // The four figures the clickable cards are built on. Gross sales is what
    // was billed; total income is what was actually collected, and on a
    // dashboard with a credit book beside it those are not the same number
    // and should never share one card.
    const [[income]] = await db.query(
      `SELECT COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected,
              COALESCE(SUM(CASE WHEN DATE(sale_date) = CURDATE()
                                THEN LEAST(amount_paid, final_amount) ELSE 0 END), 0) AS collected_today
       FROM sales WHERE is_archived = FALSE`
    );

    const [[volume]] = await db.query(
      `SELECT COALESCE(SUM(si.quantity), 0) AS units_sold,
              COUNT(DISTINCT si.sale_id) AS sales_with_items
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.is_archived = FALSE`
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
      receivables: sales.receivables,
      productCount: stock.product_count,
      lowStock: stock.low_stock,
      deliveryCount: delivery.delivery_count,
      deliveriesInProgress: delivery.in_progress,
      deliveryProblems: delivery.problem,
      archiveCount: archive.archive_count,

      totalIncome: income.collected,
      incomeToday: income.collected_today,
      unitsSold: volume.units_sold,
      pendingCredits: credits.owed,
      pendingCreditCount: credits.open_accounts,
      reorderAlerts: stock.low_stock
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
    // here. Filtering on is_active used to hide a leaver's history and make
    // this table disagree with the Gross Sales figure on the dashboard.
    // Everyone who sold anything is listed, plus cashiers on duty who have
    // not sold yet, so a quiet shift still shows up as a zero rather than
    // vanishing. is_active comes along so the screen can label a leaver.
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
// Two things are filtered here that the sales table does not hold as columns,
// and both are derived rather than stored, so there is one definition of each
// and no second copy to fall out of step.
//
// PAYMENT GROUP. The payment_method column names eight ways of paying. A
// manager asking "how much came in online" does not mean GCash specifically,
// so the four electronic methods answer as one group while Cash, Cheque, COD
// and Credit stay themselves.
//
// TRANSACTION STATUS. This is not payment_status. A sale can be paid in full
// and still be sitting on a truck, and a voided sale is not "unpaid", it is
// cancelled. So:
//
//   Voided           the sale was archived; it did not happen
//   Pending Delivery goods are booked out and have not arrived yet
//   Partial Credit   money is still owed on it
//   Completed        paid, and either collected in store or delivered
//
// Deriving it means it can never disagree with the delivery record, which is
// what a stored copy of it would eventually do.
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

// WHO THE SALE WAS FOR
//
// In the order the record actually knows it: the account it was booked
// against, then the name the cashier took at the till, and only then the
// admission that nobody asked. "Walk-in" used to be the answer to all three,
// which made a receipt reprinted a week later unreadable.
const SALE_CUSTOMER_SQL = `
  COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
           NULLIF(TRIM(s.walk_in_name), ''),
           'Walk-in')`;

// The same question for a delivery, where what was written on the booking
// outranks the customer record: the person who took the order is closer to
// the truth than a customer row from six months ago, and a driver holding
// the manifest needs the name the customer will answer to at the gate.
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

  // A voided sale is archived, so it is outside the default list by
  // definition. Asking for it explicitly is the one way to see it.
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
// The shop's credit book, which is the part of this system the business
// actually runs on. Three screens read from here:
//
//   The manager sets limits and standings and decides extensions.
//   The cashier checks an account before ringing a sale up, and raises a
//   request when a regular customer will not fit under their limit.
//   The customer page shows what they bought and what they have paid, side
//   by side, because neither half means much without the other.
//
// Every balance on these routes is derived in vw_customer_credit from the
// sales themselves. Nothing about a balance is stored, so nothing about a
// balance can go stale.
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

  // "who owes us money" is the commonest question this list is opened for
  if (request.query.owing === "true") where.push("v.current_credit > 0");

  // and "who is over their limit" is the one that needs acting on today
  if (request.query.overLimit === "true") where.push("v.current_credit > v.credit_limit");

  if (search !== "") {
    where.push("(v.customer_name LIKE ? OR v.phone LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
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

app.put("/api/credit/customers/:customerId/limit", async (request, response) => {
  const { creditLimit, standing, notes } = request.body;

  const limit = Number(creditLimit);
  if (!Number.isFinite(limit) || limit < 0) {
    return response.status(400).json({
      error: "A credit limit cannot be negative. Use zero for a cash-only customer."
    });
  }

  try {
    const [before] = await db.query(
      "SELECT customer_name, credit_limit, standing FROM vw_customer_credit WHERE customer_id = ?",
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

app.post("/api/credit/requests/:requestId/decide", async (request, response) => {
  const approve = request.body.approve === true;
  const note = request.body.note;

  // A refusal with no reason is a question the cashier has to ask again
  // tomorrow, so declining says why or it does not happen.
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

// ==========================================
// ONE CUSTOMER, IN FULL
//
// What they bought beside what they have paid. They are two halves of the
// same account and neither means much alone: a purchase history says how
// good a customer somebody is, a payment history says how good a payer, and
// the shop needs both before extending anything.
// ==========================================
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

    // What they buy, which is the part of a customer record that tells you
    // what to stock rather than what to chase.
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

// Open an account from the counter.
//
// The regular who has been buying for months and was never typed in has no
// purchase history and no credit book entry, and the cashier retypes their
// name on every sale. The counter is where that person is standing, so the
// counter is where the account is opened.
//
// A cashier can create the record and nothing else: the procedure sets the
// limit to zero and the standing to Good, which together mean "known
// customer, sells for cash". Moving that limit is a manager's decision and
// the route that does it is manager-only, so opening an account here is not
// a way to grant credit to yourself.
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

    // 200 means the account already existed and was handed back; 201 means a
    // new one. Both are a success from the counter's point of view, because
    // either way this sale now has the right customer attached to it.
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

// ==========================================
// WHO THE SHOP IS, AND HOW IT IS REGISTERED
//
// The invoice used to print a shop name hard-coded into a JavaScript file, no
// TIN and no tax breakdown, which is not a document a Philippine shop can
// hand a customer. This is where the real ones live.
//
// Registration is a setting rather than a constant because both kinds of
// hardware shop exist: above the 3,000,000 annual threshold a shop is
// VAT-registered and its prices carry 12% inside them, below it the shop is
// non-VAT, charges no VAT at all, and pays percentage tax instead. A VAT
// block printed on a non-VAT shop's invoice would be a fiction.
// ==========================================
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

    // A database mid-install has no row yet. Handing back the defaults lets
    // the till keep printing something rather than failing on a sale, and the
    // placeholder TIN is obvious enough that nobody mistakes it for real.
    response.json(rows[0] || DEFAULT_STORE_SETTINGS);
  } catch (error) {
    console.error("Store settings failed:", error.message);
    response.status(500).json({ error: error.message });
  }
});

app.put("/api/store-settings", async (request, response) => {
  const { storeName, address, tin, registrationType, vatRate, invoiceNote } = request.body;

  try {
    // read first, so the trail can say what the TIN and the registration were
    // before somebody changed what every future invoice claims about the shop
    const [existing] = await db.query(
      `SELECT store_name, address, tin, registration_type, vat_rate, invoice_note
       FROM store_settings WHERE setting_id = 1`
    );

    const output = await callProcedure(
      "CALL sp_update_store_settings(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
      [String(storeName || "").trim().slice(0, 150),
       String(address || "").trim().slice(0, 255),
       String(tin || "").trim().slice(0, 30),
       String(registrationType || "").trim().toUpperCase(),
       Number(vatRate) || 0,
       String(invoiceNote || "").trim().slice(0, 255),
       getActorId(request)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return response.status(output.status_code).json({ error: output.message });
    }

    // Every other administrative change writes an entry and this one did not,
    // which left the single most consequential setting in the system — whether
    // the shop charges VAT, and under which TIN — the one change nobody could
    // trace afterwards.
    await writeAuditLog(
      request,
      "UPDATE_STORE_SETTINGS",
      `Store details and tax registration updated`,
      {
        changes: fieldChanges(existing[0] || null, {
          store_name: String(storeName || "").trim().slice(0, 150),
          address: String(address || "").trim().slice(0, 255),
          tin: String(tin || "").trim().slice(0, 30),
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

// Ring up a sale. The procedure deducts stock, checks the credit limit and
// the account's standing, and works out whether the sale is paid, part paid
// or wholly on the book.
//
// downPaymentMethod is how the money handed over on a Credit sale actually
// arrived. The sale itself says Credit, which is not a way of handing over
// money, so the part that was handed over needs its own name or the payment
// history cannot say how it got there.
app.post("/api/sales", async (request, response) => {
  const { customerId, walkInName, discount, amountPaid, paymentMethod, items, downPaymentMethod } = request.body;

  if (!paymentMethod || !Array.isArray(items) || items.length === 0) {
    return response.status(400).json({ error: "A payment method and at least one item are required" });
  }

  const TENDER_METHODS = ["Cash", "Cheque", "GCash", "PayMaya", "PayPal", "Bank Transfer"];
  const downMethod = TENDER_METHODS.includes(downPaymentMethod) ? downPaymentMethod : "Cash";

  // The name typed at the till for somebody with no account. Trimmed and
  // capped here rather than trusted at its typed length, because the column
  // is 150 and a paste of a whole address into the name box should shorten
  // the name, not fail the sale.
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

// A browser's datetime-local field sends "2026-09-05T14:30". MySQL wants a
// space where the T is and will take the seconds or leave them. Anything that
// is not one of those two shapes is dropped rather than passed through, so a
// hand-edited request cannot smuggle an expression into a DATETIME column.
function toMysqlDateTime(value) {
  const text = String(value || "").trim();
  if (text === "") return null;

  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(text);
  if (match) return `${match[1]} ${match[2]}${match[3] || ":00"}`;

  // a plain date is a legitimate answer: it means midnight on that day
  if (isDateText(text)) return `${text} 00:00:00`;

  return null;
}

// book a delivery against a sale
app.post("/api/deliveries", async (request, response) => {
  const { saleId, address, scheduledDate, remarks, contactName, contactPhone, bookedDate } = request.body;

  if (!saleId || !address) {
    return response.status(400).json({ error: "A sale and a delivery address are required" });
  }

  const scheduled = toMysqlDateTime(scheduledDate);
  const booked = isDateText(bookedDate) ? bookedDate : null;

  // A schedule that was typed but not understood is worse than no schedule:
  // the delivery would be saved as unscheduled and nobody would be told.
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

// The one route that moves a delivery. Both the driver screen and the manager
// screen call this; the procedure decides what each role is allowed to do,
// so the answer cannot depend on which URL the browser happened to use.
app.patch("/api/deliveries/:deliveryId/status", async (request, response) => {
  const { status, remarks } = request.body;
  const actor = request.actor;

  if (!status) {
    return response.status(400).json({ error: "A status is required" });
  }

  try {
    // a driver who picks up an unclaimed delivery becomes its driver
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

// sales that still have no delivery booked, for the delivery form
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

// ==========================================
// END OF SHIFT
//
// One cashier, one day, and by default that day is today. The screen that
// reads this shows the shift the cashier is standing in, so the date is a
// fact about now rather than a question to be answered before the figures
// appear; a date can still be passed for a manager reading back over a
// closed day.
//
// Every figure is bounded by DATE(sale_date) = that day. Nothing here is a
// running or year-to-date total, because a cashier counting a drawer at six
// o'clock is answering "what happened on my shift", and a figure that quietly
// includes January is the wrong answer to that question.
//
// The refund list comes back line by line rather than as a total alone. A
// refund total says money left the till; it does not say which item went
// back, and the item is the part the cashier has to account for.
// ==========================================
app.get("/api/cashier/summary", async (request, response) => {
  // WHOSE SHIFT THIS IS
  //
  // The session's, always. A staff id in the address bar used to decide it,
  // which meant one cashier could read another's takings and refund lines by
  // editing a number in the URL. The screen still sends it and it is still
  // ignored, the same way the notification routes ignore one.
  const staffId = request.actor.staffId;

  // An unreadable date is treated as no date, which means today. Passing a
  // fragment straight through would let it reach DATE() as something MySQL
  // has to guess at.
  const day = isDateText(request.query.date) ? request.query.date : null;

  try {
    const [[totals]] = await db.query(
      // COLLECTED IS WHAT STAYED IN THE DRAWER
      //
      // amount_paid is what the customer handed over, which on a cash sale
      // includes the note they broke: 100,000 tendered against a 120 bill is
      // 120 collected and 99,880 handed straight back. Summing amount_paid
      // made this card disagree with the manager's daily tally for the same
      // cashier on the same day, and the card a drawer is balanced against was
      // the one that was wrong.
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

    // What actually went back, so the popup can show the item rather than
    // only the money. Capped, because a day with two hundred refunds is a
    // day for the manager's report and not for a card at the counter.
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
      // The day the figures are actually for, resolved server side. A screen
      // that says "today" and a database that decided which day that was
      // should not be two opinions.
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

// SALES detail for the popup
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
// Average daily sales is counted over a window of real trading, not over all
// history: a product that sold well two years ago and not since should not
// still be ordered as though it does. The window is 90 days by default, and
// the divisor is the number of days the shop has actually been recording
// sales rather than a flat 90, so a database three weeks old does not report
// every product as barely moving.
//
// Two guards matter more than the arithmetic:
//
//   A product with no sales in the window gets a calculated ROP of its safety
//   stock alone, which for most items is small and for a genuinely dead item
//   is zero. Ordering to zero is right for a dead item and wrong for a slow
//   one, which is why Dynamic is a per-product choice and not the default.
//
//   The effective reorder point is the calculated one only when the product
//   is set to Dynamic. Everything else keeps the number a person typed, and
//   the calculated figure is still shown beside it as a suggestion, so the
//   formula can be judged before it is trusted.
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

// The manager sets the policy; the clerk still sets a manual reorder point
// through the inventory screen. Two different decisions, two different roles.
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

  // a manual reorder point is optional here; the clerk's screen owns it, and
  // leaving it out means "do not touch what is already there"
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

// ==========================================
// DELIVERIES, AND WHEN ONE IS ACTUALLY FINISHED
//
// Delivered and finished are two different things. A driver hands over eight
// bags of cement on a COD order and marks it Delivered; the goods have
// arrived and the shop has not been paid. Treating that as done is how a
// day's takings go missing, so a delivered order with money still owed on it
// sits at Pending Cash Collection and does not become Completed until the
// balance is cleared.
//
// It is derived from the sale's own figures rather than stored on the
// delivery, which means the transition happens by itself: the moment a
// cashier or a driver records the payment, the row is Completed. There is no
// second flag to be set, and therefore no second flag to be forgotten.
// ==========================================
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
  // the driver reading the screen, taken from the session rather than from a
  // number in the address bar, so one driver cannot pull up another's round
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

// (the driver's status route used to live here as a second copy of the same
//  logic; it is now the single PATCH /api/deliveries/:id/status above)

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

// report data for one driver over a date range
app.get("/api/delivery/summary", async (request, response) => {
  const staffId = request.actor.staffId;   // this driver's own round, never another's

  // A date that cannot be read is dropped rather than handed to MySQL to guess
  // at, the same rule the rest of the reporting routes follow.
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

    // Money owed is counted only against the driver actually carrying the
    // order. Including the unclaimed pool here showed the same pesos as
    // outstanding on every driver's report at once.
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

// record a payment against a credit or COD sale
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

// the product list the clerk works from
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

// ==========================================
// ADDING A MATERIAL FROM THE SHOP FLOOR
//
// Every picker in the system suggests materials that are already on the
// books, which is right up until the moment the shop takes delivery of
// something it has never stocked. Until now that moment stopped the clerk
// dead: nothing on any of their screens could open a new record, so a pallet
// sat in the yard until somebody with a different login typed the name in.
//
// This is that name being typed in, by the person holding the pallet. The
// unit, category and brand are created alongside it if they are new too, so
// the first bag of a material the shop has never sold does not need three
// other screens visited first. A name that already exists returns the
// existing material rather than a duplicate: two rows called Portland Cement
// is a worse outcome than a clerk being told they already had one.
// ==========================================
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
// ==========================================
// UNITS
//
// The list grows on its own: a unit typed on a stock adjustment that is not
// here yet gets added, because a list only a DBA can extend is a list that
// stays wrong while a clerk stands there holding a sack of nails.
//
// The cost of that is typos, and a typo here is not cosmetic: "kilogrms"
// alongside "kilogram" splits a shop's nails across two units that mean the
// same thing. So the same clerk who can create one can correct one, and
// renaming onto a name that already exists merges rather than fails, because
// looking at the two side by side and wanting one gone is exactly why anybody
// opens this screen.
// ==========================================
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

  // Capped at the column's own width rather than trusted at its typed length.
  // Empty means "keep whatever this material is already counted in", which is
  // what an older client that does not send a unit at all will produce.
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

// ==========================================
// THE ORDER AS A DOCUMENT
//
// The supplier has no login and never will, so what reaches them is a printed
// sheet. Everything that sheet needs comes back in one request rather than
// three: who the shop is, who the supplier is, and what is being bought. It
// is assembled here because a document assembled in the browser from three
// separate calls is a document that can print half-finished.
// ==========================================
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

// ==========================================
// RAISING AN ORDER
//
// The supplier arrives as a company name rather than an id, and a line may
// name a material that is not on the books yet. Both are the normal case: a
// purchase order is how a shop buys something it does not have, often from
// somebody it has not bought from before. The procedure creates whatever is
// new inside the order's own transaction, so a failure leaves neither a
// half-written order nor an orphan material.
// ==========================================
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

  // Only the fields the procedure reads are passed on, trimmed to their column
  // widths here rather than being truncated by MySQL without anybody saying so.
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

// ==========================================
// RECEIVING WHAT ARRIVED
//
// The body carries the count sheet: what actually came off the lorry, line by
// line, including anything that was never ordered. An empty body receives the
// order exactly as written, which is what the old button did, so nothing that
// called this before is broken by the change.
// ==========================================
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

// ==========================================
// FILING A RETURN
//
// Two things are compulsory here and neither was before.
//
// A REASON. Not a word: a sentence. "Damaged" explains nothing three months
// later when somebody queries a write-off, and a stock count that disagrees
// with the system by two bags of cement is settled by reading these lines.
//
// A DISPOSITION. Where the goods actually go, said in words rather than left
// to a checkbox called "restock" that nobody read. A return filed with that
// box unticked used to leave the goods unaccounted for: not on the shelf, not
// written off, still in a box behind the counter.
//
// restock is still accepted from older callers and mapped across, so nothing
// that already works stops working.
// ==========================================
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

  // the words win; the old flag is the fallback for anything still sending it
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

// NOTIFICATIONS
// Which alerts you see is decided by the role on your session, not by a number
// in the address bar. Asking for another role's alerts used to be a matter of
// editing the URL.
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
// (the connection is already opened and checked at the top of this file)
// ==========================================
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});