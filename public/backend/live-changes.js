// ============================================================
// live-changes.js -- the live channel: every write is logged, browsers ask what changed
// Loaded by: server.js (handed on to the route files), access-control.js and routes/shared.js.
// Never sent to a browser.
// ============================================================

const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;
const numberSetting = require("./env-settings").numberSetting;

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
  // "delivery/" with its slash, so /api/delivery-areas is not taken for a delivery
  if (/^\/api\/(deliveries|delivery\/)/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore|store-settings|delivery-areas)/.test(pathname)) return "system";
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

module.exports = {
  LIVE_POLL_SECONDS, scopeOf, recordChange, publishChange, latestChangeVersion, changesSince
};
