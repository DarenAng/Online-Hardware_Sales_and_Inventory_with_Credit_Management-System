const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;

const trustProxySetting = String(process.env.TRUST_PROXY || "").toLowerCase();
const TRUST_PROXY_HEADERS = IS_VERCEL || ["1", "true", "yes", "on"].includes(trustProxySetting);

function clientIp(request) {
  let address = "";

  if (TRUST_PROXY_HEADERS && request.headers["x-forwarded-for"]) {
    address = String(request.headers["x-forwarded-for"]).split(",")[0].trim();
  } else if (request.socket && request.socket.remoteAddress) {
    address = request.socket.remoteAddress;
  }

  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1") address = "127.0.0.1";

  return address || null;
}

const AUDIT_TYPES = [
  "CREATE", "UPDATE", "DELETE", "VOID", "RESTORE", "BACKUP",
  "LOGIN", "LOGOUT", "LOGIN_FAILURE", "SECURITY", "PAYMENT",
  "ACCESS", "OTHER"
];

function actionTypeOf(action) {
  const name = String(action || "").toUpperCase();

  if (AUDIT_TYPES.includes(name)) return name;
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

function auditContext(context) {
  if (context && typeof context === "object" && context.headers) {
    const who = { staffId: null, roleName: null, ip: clientIp(context) };
    if (context.actor) {
      who.staffId = context.actor.staffId;
      who.roleName = context.actor.roleName;
    }
    return who;
  }

  if (context && typeof context === "object") {
    const who = { staffId: null, roleName: null, ip: null };
    if (context.staffId !== undefined) who.staffId = context.staffId;
    if (context.roleName !== undefined) who.roleName = context.roleName;
    if (context.request) who.ip = clientIp(context.request);
    return who;
  }

  return { staffId: context || null, roleName: null, ip: null };
}

function auditMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;

  try {
    const text = JSON.stringify(metadata);
    if (!text) return null;
    if (text.length > 4000) {
      return text.slice(0, 3997) + "...";
    }
    return text;
  } catch (error) {
    return null;
  }
}

function fieldChanges(before, after) {
  if (!before) return after;

  const changes = {};

  const fields = Object.keys(after);
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
    const field = fields[fieldIndex];
    let was = before[field];
    let now = after[field];
    if (was === undefined) was = null;
    if (now === undefined) now = null;

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
      "INSERT INTO audit_logs " +
      "(staff_id, role_name, ip_address, action, action_type, details, metadata) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [who.staffId, who.roleName, who.ip, action, actionTypeOf(action),
       details || null, auditMetadata(metadata)]
    );
  } catch (error) {
    console.error("Audit log failed:", error.message);
  }
}

module.exports = {
  clientIp: clientIp,
  AUDIT_TYPES: AUDIT_TYPES,
  fieldChanges: fieldChanges,
  writeAuditLog: writeAuditLog
};
