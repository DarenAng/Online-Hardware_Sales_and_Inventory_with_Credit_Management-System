const mysqlTools = require("mysql2");
const sqlName = mysqlTools.escapeId;
const db = require("../connection").db;

const PROCEDURE_FAILED_SENTENCE =
  "Something went wrong on the server and the change was not saved. Please try again; " +
  "if it keeps happening, tell the administrator.";

async function callProcedure(sql, params, outputNames) {
  const connection = await db.getConnection();
  try {
    await connection.query(sql, params);

    const parts = [];
    for (let nameIndex = 0; nameIndex < outputNames.length; nameIndex++) {
      const name = outputNames[nameIndex];
      parts.push("@" + name + " AS " + sqlName(name));
    }
    const selectList = parts.join(", ");
    const selected = await connection.query("SELECT " + selectList);
    const rows = selected[0];
    const output = rows[0];

    if (Number(output.status_code) === 500 && output.message !== undefined) {
      console.error(output.message);
      output.message = PROCEDURE_FAILED_SENTENCE;
    }
    return output;
  } finally {
    connection.release();
  }
}

function updateOwnAccount(params) {
  return callProcedure(
    "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function restoreArchive(params) {
  return callProcedure(
    "CALL sp_restore_archive(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

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
