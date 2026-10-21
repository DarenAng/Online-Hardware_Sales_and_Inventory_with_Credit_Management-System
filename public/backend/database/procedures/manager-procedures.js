const callProcedure = require("./shared-procedures").callProcedure;

function setCreditLimit(params) {
  return callProcedure(
    "CALL sp_set_credit_limit(?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function setPenaltyPolicy(params) {
  return callProcedure(
    "CALL sp_set_penalty_policy(?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function requestCreditExtension(params) {
  return callProcedure(
    "CALL sp_request_credit_extension(?, ?, ?, ?, @request_id, @status_code, @message)",
    params,
    ["request_id", "status_code", "message"]
  );
}

function decideCreditRequest(params) {
  return callProcedure(
    "CALL sp_decide_credit_request(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function createCustomer(params) {
  return callProcedure(
    "CALL sp_create_customer(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, @customer_id, @status_code, @message)",
    params,
    ["customer_id", "status_code", "message"]
  );
}

function applyLatePenalties() {
  return callProcedure(
    "CALL sp_apply_late_penalties(@applied, @total)", [],
    ["applied", "total", "err_no", "err_text"]
  );
}

module.exports = {
  setCreditLimit: setCreditLimit,
  setPenaltyPolicy: setPenaltyPolicy,
  requestCreditExtension: requestCreditExtension,
  decideCreditRequest: decideCreditRequest,
  createCustomer: createCustomer,
  applyLatePenalties: applyLatePenalties
};
