// ============================================================
// delivery-procedures.js -- the stored procedures called for the Delivery Personnel's screens
// Loaded by: routes/delivery.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_record_credit_payment: Takes the cash a driver collects at the door as a payment on the sale.
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
