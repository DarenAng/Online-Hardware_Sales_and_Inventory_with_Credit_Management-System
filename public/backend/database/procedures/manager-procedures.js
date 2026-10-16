// ============================================================
// manager-procedures.js -- the stored procedures called for the Manager's screens (credit, customers, late penalties)
// Loaded by: routes/manager.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_set_credit_limit: Sets a customer's credit limit, standing and own penalty rate.
function setCreditLimit(params) {
  return callProcedure(
    "CALL sp_set_credit_limit(?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_set_penalty_policy: Sets the shop's late-payment penalty rate.
function setPenaltyPolicy(params) {
  return callProcedure(
    "CALL sp_set_penalty_policy(?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_request_credit_extension: Files a request to raise a customer's credit limit.
function requestCreditExtension(params) {
  return callProcedure(
    "CALL sp_request_credit_extension(?, ?, ?, ?, @request_id, @status_code, @message)",
    params,
    ["request_id", "status_code", "message"]
  );
}

// sp_decide_credit_request: Approves or declines a credit-limit request.
function decideCreditRequest(params) {
  return callProcedure(
    "CALL sp_decide_credit_request(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_create_customer: Opens a customer account.
function createCustomer(params) {
  return callProcedure(
    "CALL sp_create_customer(?, ?, ?, ?, ?, @customer_id, @status_code, @message)",
    params,
    ["customer_id", "status_code", "message"]
  );
}

// sp_apply_late_penalties: Charges a month's penalty on every overdue sale. Takes no values.
function applyLatePenalties() {
  return callProcedure(
    "CALL sp_apply_late_penalties(@applied, @total)", [],
    ["applied", "total", "err_no", "err_text"]
  );
}

module.exports = {
  setCreditLimit,
  setPenaltyPolicy,
  requestCreditExtension,
  decideCreditRequest,
  createCustomer,
  applyLatePenalties
};
