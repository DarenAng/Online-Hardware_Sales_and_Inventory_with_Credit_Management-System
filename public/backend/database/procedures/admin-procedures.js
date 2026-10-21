const callProcedure = require("./shared-procedures").callProcedure;

function createStaffAccount(params) {
  return callProcedure(
    "CALL sp_create_staff_account(?, ?, ?, ?, ?, ?, ?, @staff_id, @status_code, @message)",
    params,
    ["staff_id", "status_code", "message"]
  );
}

function updateStaffAccount(params) {
  return callProcedure(
    "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function setStaffStatus(params) {
  return callProcedure(
    "CALL sp_set_staff_status(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function createLoginForStaff(params) {
  return callProcedure(
    "CALL sp_create_login_for_staff(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function resetUserPassword(params) {
  return callProcedure(
    "CALL sp_reset_user_password(?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function sweepArchives() {
  return callProcedure(
    "CALL sp_sweep_archives(@deliveries, @materials)", [],
    ["deliveries", "materials", "err_no", "err_text"]
  );
}

function updateStoreSettings(params) {
  return callProcedure(
    "CALL sp_update_store_settings(?, ?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function updateStoreBankDetails(params) {
  return callProcedure(
    "CALL sp_update_store_bank_details(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  createStaffAccount: createStaffAccount,
  updateStaffAccount: updateStaffAccount,
  setStaffStatus: setStaffStatus,
  createLoginForStaff: createLoginForStaff,
  resetUserPassword: resetUserPassword,
  sweepArchives: sweepArchives,
  updateStoreSettings: updateStoreSettings,
  updateStoreBankDetails: updateStoreBankDetails
};
