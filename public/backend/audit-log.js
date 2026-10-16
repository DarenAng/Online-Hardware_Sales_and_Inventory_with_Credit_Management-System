// ============================================================
// audit-log.js -- the audit trail: who did what, from where, with the values before and after
// Loaded by: server.js (handed on to the route files) and routes/shared.js.
// Never sent to a browser.
// ============================================================

const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;

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

module.exports = { clientIp, AUDIT_TYPES, fieldChanges, writeAuditLog };
