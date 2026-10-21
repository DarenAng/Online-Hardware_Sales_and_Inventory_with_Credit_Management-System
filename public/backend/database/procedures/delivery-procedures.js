const callProcedure = require("./shared-procedures").callProcedure;

function recordCreditPayment(params) {
  return callProcedure(
    "CALL sp_record_credit_payment(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  recordCreditPayment: recordCreditPayment
};
