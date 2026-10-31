// Customer portal sessions. They are kept apart from the staff sessions: a different table
// (customer_sessions) and a different cookie ("csid"), so a staff token never works on
// /api/portal and a customer token never works on a staff route.
const crypto = require("crypto");
const db = require("./database/connection").db;
const sessions = require("./sessions");
const tokenHash = sessions.tokenHash;
const readCookie = sessions.readCookie;

const COOKIE_NAME = "csid";

// A customer is signed out after this many idle minutes (the same 30 as staff).
const IDLE_MINUTES = sessions.SESSION_IDLE_MINUTES;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

// However busy, a portal session ends after this many hours.
const MAX_MS = 8 * 60 * 60 * 1000;

const TOUCH_MS = 30 * 1000;
const ENDED_REASON_MS = 24 * 60 * 60 * 1000;

let minutesWord = "minutes";
if (IDLE_MINUTES === 1) {
  minutesWord = "minute";
}
const IDLE_ENDED_REASON =
  "You were signed out after " + IDLE_MINUTES + " " + minutesWord + " of inactivity. Please sign in again.";

async function startCustomerSession(customerId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await db.query(
    "INSERT INTO customer_sessions (token_hash, customer_id, started_at, last_seen, expires_at) " +
    "VALUES (?, ?, ?, ?, ?)",
    [tokenHash(token), customerId, now, now, now + IDLE_MS]);
  return token;
}

function setCustomerCookie(response, token) {
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: sessions.SECURE_COOKIE,
    path: "/"
  });
}

function clearCustomerCookie(response) {
  response.clearCookie(COOKIE_NAME, { path: "/" });
}

// Finds the customer for this request. Returns { session }, { endedReason } or {}.
async function customerSessionState(request) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return {};

  const hash = tokenHash(token);
  const rowsResult = await db.query(
    "SELECT customer_id, started_at, last_seen, expires_at, ended_reason " +
    "FROM customer_sessions WHERE token_hash = ?",
    [hash]);
  const row = rowsResult[0][0];
  if (!row) return {};

  if (row.ended_reason) return { endedReason: row.ended_reason };

  const now = Date.now();
  const startedAt = Number(row.started_at);

  if (now >= startedAt + MAX_MS) {
    await db.query("DELETE FROM customer_sessions WHERE token_hash = ?", [hash]);
    return {};
  }

  if (Number(row.expires_at) < now) {
    await db.query(
      "UPDATE customer_sessions SET ended_reason = ?, ended_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [IDLE_ENDED_REASON, now, hash]);
    return { endedReason: IDLE_ENDED_REASON };
  }

  // Moving the idle limit on is one write, so do it at most every half minute.
  if (now - Number(row.last_seen) > TOUCH_MS) {
    const newExpiry = Math.min(now + IDLE_MS, startedAt + MAX_MS);
    await db.query(
      "UPDATE customer_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [now, newExpiry, hash]);
  }

  return { session: { token: token, customerId: row.customer_id } };
}

async function endCustomerSession(request) {
  const token = readCookie(request, COOKIE_NAME);
  if (token) {
    await db.query("DELETE FROM customer_sessions WHERE token_hash = ?", [tokenHash(token)]);
  }
}

// Ends every open portal session of one customer, except the one named by keepToken.
async function endSessionsForCustomer(customerId, keepToken, reason) {
  const params = [String(reason || "Your session was ended."), Date.now(), Number(customerId), Date.now()];
  let keep = "";
  if (keepToken) {
    keep = " AND token_hash <> ?";
    params.push(tokenHash(keepToken));
  }

  await db.query(
    "UPDATE customer_sessions SET ended_reason = ?, ended_at = ? " +
    "WHERE customer_id = ? AND ended_reason IS NULL AND expires_at > ?" + keep,
    params);
}

async function removeExpiredCustomerSessions() {
  const now = Date.now();
  await db.query(
    "DELETE FROM customer_sessions WHERE (ended_reason IS NULL AND expires_at < ?) " +
    "OR (ended_reason IS NOT NULL AND ended_at < ?)",
    [now, now - ENDED_REASON_MS]);
}

module.exports = {
  startCustomerSession: startCustomerSession,
  setCustomerCookie: setCustomerCookie,
  clearCustomerCookie: clearCustomerCookie,
  customerSessionState: customerSessionState,
  endCustomerSession: endCustomerSession,
  endSessionsForCustomer: endSessionsForCustomer,
  removeExpiredCustomerSessions: removeExpiredCustomerSessions
};
