// ============================================================
// admin-procedures.js -- the stored procedures called for the System Administrator's screens
// Loaded by: routes/admin.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_create_staff_account: Creates a staff record and its sign-in.
function createStaffAccount(params) {
  return callProcedure(
    "CALL sp_create_staff_account(?, ?, ?, ?, ?, ?, ?, @staff_id, @status_code, @message)",
    params,
    ["staff_id", "status_code", "message"]
  );
}

// sp_update_staff_account: Changes a staff member's name, phone, role and email.
function updateStaffAccount(params) {
  return callProcedure(
    "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_set_staff_status: Activates or deactivates a staff account.
function setStaffStatus(params) {
  return callProcedure(
    "CALL sp_set_staff_status(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_create_login_for_staff: Gives a staff member without a login an email and a first password.
function createLoginForStaff(params) {
  return callProcedure(
    "CALL sp_create_login_for_staff(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_reset_user_password: Sets a new (temporary) password hash for a staff member.
function resetUserPassword(params) {
  return callProcedure(
    "CALL sp_reset_user_password(?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_sweep_archives: Puts away closed deliveries and idle materials. Takes no values.
function sweepArchives() {
  return callProcedure(
    "CALL sp_sweep_archives(@deliveries, @materials)", [],
    ["deliveries", "materials", "err_no", "err_text"]
  );
}

// sp_update_store_settings: Saves the shop's name, address, TIN and VAT settings.
function updateStoreSettings(params) {
  return callProcedure(
    "CALL sp_update_store_settings(?, ?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_update_store_bank_details: Saves the bank account customers transfer to.
function updateStoreBankDetails(params) {
  return callProcedure(
    "CALL sp_update_store_bank_details(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  createStaffAccount,
  updateStaffAccount,
  setStaffStatus,
  createLoginForStaff,
  resetUserPassword,
  sweepArchives,
  updateStoreSettings,
  updateStoreBankDetails
};
