// ============================================================
// cashier-procedures.js -- the stored procedures called for the Cashier's screens (sales, deliveries, payments on a balance)
// Loaded by: routes/cashier.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_create_sale_transaction: Rings up a sale: its lines, stock, payment and (when paid by QR) the QR payment.
function recordSale(params) {
  return callProcedure(
    "CALL sp_create_sale_transaction(?, ?, ?, ?, ?, ?, ?, ?, ?, @sale_id, @status_code, @message)",
    params,
    ["sale_id", "status_code", "message"]
  );
}

// sp_set_sale_reference: Writes the reference number (bank transfer, cheque ...) on a sale.
function setSaleReference(params) {
  return callProcedure(
    "CALL sp_set_sale_reference(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_create_delivery: Books a delivery for a sale.
function createDelivery(params) {
  return callProcedure(
    "CALL sp_create_delivery(?, ?, ?, ?, ?, ?, ?, ?, ?, @delivery_id, @status_code, @message)",
    params,
    ["delivery_id", "status_code", "message"]
  );
}

// sp_update_delivery_status: Moves a delivery along (in transit, delivered, cancelled ...).
function updateDeliveryStatus(params) {
  return callProcedure(
    "CALL sp_update_delivery_status(?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_record_credit_payment: Takes a payment against what a sale still owes.
function recordCreditPayment(params) {
  return callProcedure(
    "CALL sp_record_credit_payment(?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  recordSale,
  setSaleReference,
  createDelivery,
  updateDeliveryStatus,
  recordCreditPayment
};
