// ============================================================
// shared-procedures.js -- callProcedure, and the stored procedures the shared routes call
// Loaded by: every other procedures file (for callProcedure) and routes/shared.js.
// Never sent to a browser.
//
// callProcedure runs one stored procedure and reads its OUT values back on the
// same connection. The other files in this folder have one function per procedure
// for one role's screens; this file has the ones the shared routes call.
// ============================================================

const mysqlTools = require("mysql2");
const sqlName = mysqlTools.escapeId;
const db = require("../connection").db;

// What the browser is told when a stored procedure fails inside the database
const PROCEDURE_FAILED_SENTENCE =
  "Something went wrong on the server and the change was not saved. Please try again; " +
  "if it keeps happening, tell the administrator.";

// runs a stored procedure and reads its OUT values on the same connection
async function callProcedure(sql, params, outputNames) {
  const connection = await db.getConnection();
  try {
    await connection.query(sql, params);

    // Build "SELECT @a AS `a`, @b AS `b`" to read the OUT values back.
    // The name is quoted because some are reserved words (like "lines").
    const parts = [];
    for (let nameIndex = 0; nameIndex < outputNames.length; nameIndex++) {
      const name = outputNames[nameIndex];
      parts.push("@" + name + " AS " + sqlName(name));
    }
    const selectList = parts.join(", ");
    const selected = await connection.query("SELECT " + selectList);
    const rows = selected[0];
    const output = rows[0];

    // A 500 from a procedure is its EXIT HANDLER speaking: the message holds the
    // real MySQL error number and text. That belongs in the server log, not on
    // the screen, so the browser gets one plain sentence instead.
    if (Number(output.status_code) === 500 && output.message !== undefined) {
      console.error(output.message);
      output.message = PROCEDURE_FAILED_SENTENCE;
    }
    return output;
  } finally {
    connection.release();
  }
}

// sp_update_staff_account: Changes the signed-in person's own name and phone (My Account).
function updateOwnAccount(params) {
  return callProcedure(
    "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_restore_archive: Brings an archived record back.
function restoreArchive(params) {
  return callProcedure(
    "CALL sp_restore_archive(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_archive_record: Puts a record away in the archives.
function archiveRecord(params) {
  return callProcedure(
    "CALL sp_archive_record(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  callProcedure: callProcedure,
  updateOwnAccount: updateOwnAccount,
  restoreArchive: restoreArchive,
  archiveRecord: archiveRecord
};
