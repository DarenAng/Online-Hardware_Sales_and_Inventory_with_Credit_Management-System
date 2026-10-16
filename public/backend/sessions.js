// ============================================================
// sessions.js -- signed-in sessions: the cookie, the user_sessions table, who is present
// Loaded by: server.js (handed on to the route files), access-control.js and routes/shared.js.
// Never sent to a browser.
// ============================================================

const crypto = require("crypto");
const db = require("./database/connection").db;
const numberSetting = require("./env-settings").numberSetting;
const CASHIER = require("./roles").CASHIER;

// ==========================================
// SESSIONS -- an opaque cookie; the server looks the staff id up itself
// ==========================================
// how long a sign-in lasts without signing out; SESSION_HOURS in .env
const SESSION_HOURS = numberSetting(process.env.SESSION_HOURS, 8);

// how long a sign-in may sit unused before it ends; SESSION_IDLE_MINUTES in .env.
// SESSION_HOURS above stays the longest any one sign-in can last.
const SESSION_IDLE_MINUTES = numberSetting(process.env.SESSION_IDLE_MINUTES, 30);

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
const SESSION_IDLE_MS = SESSION_IDLE_MINUTES * 60 * 1000;

// what a screen is told when its sign-in ran out of idle time
const IDLE_ENDED_REASON =
  `You were signed out after ${SESSION_IDLE_MINUTES} ${SESSION_IDLE_MINUTES === 1 ? "minute" : "minutes"} ` +
  "of inactivity. Please sign in again.";

// When a sign-in that was used at "now" runs out: the idle time later, but
// never past SESSION_HOURS after it started. expires_at holds this.
// A Cashier is never signed out for being idle: the counter screen waits
// between customers, so only SESSION_HOURS applies.
function sessionExpiry(startedAt, now, roleName) {
  if (roleName === CASHIER) return startedAt + SESSION_MS;
  return Math.min(now + SESSION_IDLE_MS, startedAt + SESSION_MS);
}

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
     now, now, sessionExpiry(now, now, user.role_name)]);
  return token;
}

// Over https (Vercel) the cookie is marked Secure so it never travels in the
// clear; a PC in the shop serves plain http, where a Secure cookie would not
// be sent back at all. COOKIE_SECURE=1 forces it behind your own https proxy.
const SECURE_COOKIE = Boolean(process.env.VERCEL) || process.env.COOKIE_SECURE === "1";

function setSessionCookie(response, token) {
  response.cookie("sid", token, {
    httpOnly: true,          // JavaScript on the page cannot read it
    sameSite: "strict",      // not sent from another site
    secure: SECURE_COOKIE,   // only over https (on Vercel)
    maxAge: SESSION_MS,
    path: "/"
  });
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const split = part.indexOf("=");
    if (split === -1) continue;
    if (part.slice(0, split).trim() === name) {
      // a broken %-escape (sid=%E0%A4%A) makes decodeURIComponent throw, which
      // would turn into a 500; a cookie nobody could have been given is no cookie
      try {
        return decodeURIComponent(part.slice(split + 1).trim());
      } catch (error) {
        return null;
      }
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
  const startedAt = Number(row.started_at);

  if (Number(row.expires_at) < now) {
    // past the longest a sign-in may last: simply gone
    if (now >= startedAt + SESSION_MS) {
      await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [hash]);
      return {};
    }

    // otherwise it sat unused too long: ended with the reason, so the screen can say why
    await db.query(
      "UPDATE user_sessions SET ended_reason = ?, ended_at = ? WHERE token_hash = ? AND ended_reason IS NULL",
      [IDLE_ENDED_REASON, now, hash]);
    return { endedReason: IDLE_ENDED_REASON };
  }

  // The pages ask in the background too (live updates, the heartbeat) and mark
  // those asks with X-Background: 1 when nobody has touched the page lately.
  // Such an ask still shows the person is at a screen (last_seen), but it
  // does not keep the sign-in alive (expires_at); only real use does.
  // A Cashier's expiry does not depend on use, so any ask may write it.
  const background = request.headers["x-background"] === "1" && row.role_name !== CASHIER;

  let lastSeen = Number(row.last_seen);
  let expiresAt = Number(row.expires_at);
  const newExpiry = sessionExpiry(startedAt, now, row.role_name);

  // both are written at most twice a minute
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
// An ended row is judged by when it ended, not by expires_at (which is only
// about 30 minutes after the last use), so its screen can still read the reason.
// Run by the local timer below, and by the daily job on Vercel.
async function removeExpiredSessions() {
  const now = Date.now();
  await db.query(
    "DELETE FROM user_sessions WHERE (ended_reason IS NULL AND expires_at < ?) OR (ended_reason IS NOT NULL AND ended_at < ?)",
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

// A changed password ends every OTHER session on the old one, since the old
// password may be known to somebody else. The session making the change is
// kept, so a request this screen already has on its way is not refused.
// (response is not needed any more; the callers still pass it.)
const PASSWORD_CHANGED =
  "Your password was changed. Sign in again with the new one.";

async function renewSessionAfterPasswordChange(request, response) {
  const actor = request.actor;
  await endSessionsForStaff(actor.staffId, actor.token, PASSWORD_CHANGED);
}

module.exports = {
  LOGIN_MAX_ATTEMPTS, LOGIN_HOLD_MINUTES, SESSION_IDLE_MINUTES, SESSION_SWEEP_MS, PRESENCE_WINDOW_MS,
  startSession, setSessionCookie, sessionState, currentSession, withPresence, endSession,
  removeExpiredSessions, endSessionsForStaff, getActorId, renewSessionAfterPasswordChange
};
