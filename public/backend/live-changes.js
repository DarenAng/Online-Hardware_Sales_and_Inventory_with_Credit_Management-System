const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;
const numberSetting = require("./env-settings").numberSetting;

const CHANGE_LOG_SIZE = 500;

const LIVE_POLL_SECONDS = numberSetting(process.env.LIVE_POLL_SECONDS, IS_VERCEL ? 8 : 3);

function scopeOf(pathname) {
  if (/^\/api\/(users|roles|staff)/.test(pathname)) return "staff";
  if (/^\/api\/(inventory|purchase-orders|stocks|units|materials|suppliers|categories)/.test(pathname)) return "inventory";
  if (/^\/api\/(returns|refunds)/.test(pathname)) return "returns";
  if (/^\/api\/(deliveries|delivery\/)/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore|store-settings)/.test(pathname)) return "system";
  if (/^\/api\/archives/.test(pathname)) return "archives";
  if (/^\/api\/notifications/.test(pathname)) return "notifications";
  if (/^\/api\/features/.test(pathname)) return "features";
  return null;
}

let changesWritten = 0;

async function recordChange(scope, detail, origin) {
  try {
    const insertResult = await db.query(
      "INSERT INTO live_changes (scope, detail, origin, created_at) VALUES (?, ?, ?, ?)",
      [scope, detail ? String(detail).slice(0, 255) : null,
       origin ? String(origin).slice(0, 64) : null, Date.now()]);

    const result = insertResult[0];
    changesWritten += 1;
    if (changesWritten % 50 === 0) {
      await db.query("DELETE FROM live_changes WHERE change_id <= ?", [result.insertId - CHANGE_LOG_SIZE]);
    }
  } catch (error) {
    console.error("Recording a live change failed:", error.message);
  }
}

function publishChange(scope, detail, origin) {
  if (!scope) return;
  keepAlive(recordChange(scope, detail, origin));
}

function keepAlive(promise) {
  if (IS_VERCEL) {
    try {
      require("@vercel/functions").waitUntil(promise);
    } catch (error) {
    }
  }
  return promise;
}

async function latestChangeVersion() {
  const versionResult = await db.query("SELECT COALESCE(MAX(change_id), 0) AS version FROM live_changes");
  const rows = versionResult[0];
  return Number(rows[0].version);
}

async function changesSince(version) {
  const latest = await latestChangeVersion();
  if (!Number.isInteger(version) || version <= 0 || version >= latest) {
    return { version: latest, changes: [], gap: false };
  }

  const changeResult = await db.query(
    "SELECT change_id, scope, detail, origin, created_at FROM live_changes " +
    "WHERE change_id > ? ORDER BY change_id LIMIT ?",
    [version, CHANGE_LOG_SIZE]);
  const rows = changeResult[0];

  if (rows.length === 0 || Number(rows[0].change_id) > version + 1) {
    const oldestResult = await db.query("SELECT MIN(change_id) AS first FROM live_changes");
    const oldest = oldestResult[0];
    if (oldest[0].first === null || Number(oldest[0].first) > version + 1) {
      return { version: latest, changes: [], gap: true };
    }
  }

  const changes = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    changes.push({
      version: Number(row.change_id),
      scope: row.scope,
      detail: row.detail,
      origin: row.origin,
      at: new Date(Number(row.created_at)).toISOString()
    });
  }
  return { version: latest, changes: changes, gap: false };
}

module.exports = {
  LIVE_POLL_SECONDS: LIVE_POLL_SECONDS,
  scopeOf: scopeOf,
  recordChange: recordChange,
  publishChange: publishChange,
  keepAlive: keepAlive,
  latestChangeVersion: latestChangeVersion,
  changesSince: changesSince
};
