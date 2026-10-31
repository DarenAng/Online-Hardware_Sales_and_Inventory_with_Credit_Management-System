const callProcedure = require("./shared-procedures").callProcedure;

function setQrPaymentResult(params) {
  return callProcedure(
    "CALL sp_set_qr_payment_result(?, ?, ?, ?, ?, @changed, @status_code, @message)",
    params,
    ["changed", "status_code", "message"]
  );
}

function createQrPayment(params) {
  return callProcedure(
    "CALL sp_create_qr_payment(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, @qr_payment_id, @status_code, @message)",
    params,
    ["qr_payment_id", "status_code", "message"]
  );
}

module.exports = {
  setQrPaymentResult: setQrPaymentResult,
  createQrPayment: createQrPayment
};
