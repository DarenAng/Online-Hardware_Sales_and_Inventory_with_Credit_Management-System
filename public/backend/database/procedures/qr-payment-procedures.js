// ============================================================
// qr-payment-procedures.js -- the stored procedures called for the QR payments (GCash and Maya)
// Loaded by: routes/qr-payments.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_set_qr_payment_result: Records how a QR payment ended (paid, failed, expired, cancelled).
function setQrPaymentResult(params) {
  return callProcedure(
    "CALL sp_set_qr_payment_result(?, ?, ?, ?, ?, @changed, @status_code, @message)",
    params,
    ["changed", "status_code", "message"]
  );
}

// sp_create_qr_payment: Records a new QR payment attempt.
function createQrPayment(params) {
  return callProcedure(
    "CALL sp_create_qr_payment(?, ?, ?, ?, ?, ?, ?, ?, ?, @qr_payment_id, @status_code, @message)",
    params,
    ["qr_payment_id", "status_code", "message"]
  );
}

module.exports = {
  setQrPaymentResult: setQrPaymentResult,
  createQrPayment: createQrPayment
};
