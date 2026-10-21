const callProcedure = require("./shared-procedures").callProcedure;

function recordSale(params) {
  return callProcedure(
    "CALL sp_create_sale_transaction(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, @sale_id, @status_code, @message)",
    params,
    ["sale_id", "status_code", "message"]
  );
}

function setSaleReference(params) {
  return callProcedure(
    "CALL sp_set_sale_reference(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function createDelivery(params) {
  return callProcedure(
    "CALL sp_create_delivery(?, ?, ?, ?, ?, ?, ?, ?, ?, @delivery_id, @status_code, @message)",
    params,
    ["delivery_id", "status_code", "message"]
  );
}

function updateDeliveryStatus(params) {
  return callProcedure(
    "CALL sp_update_delivery_status(?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function recordCreditPayment(params) {
  return callProcedure(
    "CALL sp_record_credit_payment(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  recordSale: recordSale,
  setSaleReference: setSaleReference,
  createDelivery: createDelivery,
  updateDeliveryStatus: updateDeliveryStatus,
  recordCreditPayment: recordCreditPayment
};
