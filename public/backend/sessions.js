const crypto = require("crypto");
const db = require("./database/connection").db;
const numberSetting = require("./env-settings").numberSetting;
const CASHIER = require("./roles").CASHIER;

const SESSION_HOURS = numberSetting(process.env.SESSION_HOURS, 8);

const SESSION_IDLE_MINUTES = numberSetting(process.env.SESSION_IDLE_MINUTES, 30);

const LOGIN_MAX_ATTEMPTS = numberSetting(process.env.LOGIN_MAX_ATTEMPTS, 3);
const LOGIN_HOLD_MINUTES = numberSetting(process.env.LOGIN_HOLD_MINUTES, 15);

const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;
const SESSION_IDLE_MS = SESSION_IDLE_MINUTES * 60 * 1000;

let minutesWord = "minutes";
if (SESSION_IDLE_MINUTES === 1) {
  minutesWord = "minute";
}
const IDLE_ENDED_REASON =
  "You were signed out after " + SESSION_IDLE_MINUTES + " " + minutesWord + " " +
  "of inactivity. Please sign in again.";

function sessionExpiry(startedAt, now, roleName) {
  if (roleName === CASHIER) return startedAt + SESSION_MS;
  return Math.min(now + SESSION_IDLE_MS, startedAt + SESSION_MS);
}

const SESSION_TOUCH_MS = 30 * 1000;

const ENDED_REASON_MS = 24 * 60 * 60 * 1000;

const SESSION_SWEEP_MS = 15 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function startSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await db.query(
    "INSERT INTO user_sessions " +
    "(token_hash, staff_id, user_id, role_id, role_name, email, started_at, last_seen, expires_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [tokenHash(token), user.staff_id, user.user_id, user.role_id, user.role_name, user.email,
     now, now, sessionExpiry(now, now, user.role_name)]);
  return token;
}

const SECURE_COOKIE = Boolean(process.env.VERCEL) || process.env.COOKIE_SECURE === "1";

function setSessionCookie(response, token) {
  response.cookie("sid", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: SECURE_COOKIE,
    maxAge: SESSION_MS,
    path: "/"
  });
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;

  const parts = header.split(";");
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    const split = part.indexOf("=");
    if (split === -1) continue;
    if (part.slice(0, split).trim() === name) {
      try {
        return decodeURIComponent(part.slice(split + 1).trim());
      } catch (error) {
        return null;
      }
    }
  }
  return null;
}

async function sessionState(request) {
  const token = readCookie(request, "sid");
  if (!token) return {};

  const hash = tokenHash(token);
  const sessionResult = await db.query(
    "SELECT staff_id, user_id, role_id, role_name, email, started_at, last_seen, " +
    "expires_at, ended_reason " +
    "FROM user_sessions WHERE token_hash = ?",
    [hash]);
  const rows = sessionResult[0];
  const row = rows[0];
  if (!row) return {};

  if (row.ended_reason) return { endedReason: row.ended_reason };

  const now = Date.now();
  const startedAt = Number(row.started_at);

  if (Number(row.expires_at) < now) {
    if (now >= startedAt + SESSION_MS) {
      await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [hash]);
      return {};
    }

    await db.query(
      "UPDATE user_sessions SET ended_reason = ?, ended_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [IDLE_ENDED_REASON, now, hash]);
    return { endedReason: IDLE_ENDED_REASON };
  }

  const background = request.headers["x-background"] === "1" && row.role_name !== CASHIER;

  let lastSeen = Number(row.last_seen);
  let expiresAt = Number(row.expires_at);
  const newExpiry = sessionExpiry(startedAt, now, row.role_name);

  const seenIsOld = now - lastSeen > SESSION_TOUCH_MS;
  const expiryIsOld = !background && newExpiry - expiresAt > SESSION_TOUCH_MS;

  if (seenIsOld || expiryIsOld) {
    if (seenIsOld) lastSeen = now;
    if (expiryIsOld) expiresAt = newExpiry;
    await db.query(
      "UPDATE user_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [lastSeen, expiresAt, hash]);
  }

  return {
    session: {
      token: token,
      staffId: row.staff_id,
      userId: row.user_id,
      roleId: row.role_id,
      roleName: row.role_name,
      email: row.email,
      startedAt: startedAt,
      lastSeen: lastSeen,
      expiresAt: expiresAt
    }
  };
}

async function currentSession(request) {
  return (await sessionState(request)).session || null;
}

const PRESENCE_WINDOW_MS = 2 * 60 * 1000;

async function presenceByStaff() {
  const presenceResult = await db.query(
    "SELECT staff_id, MAX(last_seen) AS last_seen FROM user_sessions " +
    "WHERE ended_reason IS NULL AND expires_at > ? " +
    "GROUP BY staff_id",
    [Date.now()]);
  const rows = presenceResult[0];

  const seen = {};
  for (let i = 0; i < rows.length; i++) {
    seen[rows[i].staff_id] = Number(rows[i].last_seen);
  }
  return seen;
}

async function withPresence(rows) {
  const seen = await presenceByStaff();
  const now = Date.now();

  const result = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lastSeen = seen[row.staff_id];
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

async function removeExpiredSessions() {
  const now = Date.now();
  await db.query(
    "DELETE FROM user_sessions WHERE (ended_reason IS NULL AND expires_at < ?) OR (ended_reason IS NOT NULL AND ended_at < ?)",
    [now, now - ENDED_REASON_MS]);
}

async function endSessionsForStaff(staffId, keepToken, reason) {
  const params = [String(reason || "Your session was ended."), Date.now(), Number(staffId), Date.now()];
  let keep = "";
  if (keepToken) {
    keep = " AND token_hash <> ?";
    params.push(tokenHash(keepToken));
  }

  const updateResult = await db.query(
    "UPDATE user_sessions SET ended_reason = ?, ended_at = ? " +
    "WHERE staff_id = ? AND ended_reason IS NULL AND expires_at > ?" + keep,
    params);
  return updateResult[0].affectedRows;
}

function getActorId(request) {
  if (request.actor) {
    return request.actor.staffId;
  }
  return null;
}

const PASSWORD_CHANGED =
  "Your password was changed. Sign in again with the new one.";

async function renewSessionAfterPasswordChange(request, response) {
  const actor = request.actor;
  await endSessionsForStaff(actor.staffId, actor.token, PASSWORD_CHANGED);
}

module.exports = {
  LOGIN_MAX_ATTEMPTS: LOGIN_MAX_ATTEMPTS,
  LOGIN_HOLD_MINUTES: LOGIN_HOLD_MINUTES,
  SESSION_IDLE_MINUTES: SESSION_IDLE_MINUTES,
  SESSION_SWEEP_MS: SESSION_SWEEP_MS,
  PRESENCE_WINDOW_MS: PRESENCE_WINDOW_MS,
  startSession: startSession,
  setSessionCookie: setSessionCookie,
  sessionState: sessionState,
  currentSession: currentSession,
  withPresence: withPresence,
  endSession: endSession,
  removeExpiredSessions: removeExpiredSessions,
  endSessionsForStaff: endSessionsForStaff,
  getActorId: getActorId,
  renewSessionAfterPasswordChange: renewSessionAfterPasswordChange,
  tokenHash: tokenHash,
  readCookie: readCookie,
  SECURE_COOKIE: SECURE_COOKIE
};
