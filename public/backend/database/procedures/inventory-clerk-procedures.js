const callProcedure = require("./shared-procedures").callProcedure;

function createMaterial(params) {
  return callProcedure(
    "CALL sp_create_material(?, ?, ?, ?, ?, ?, ?, @product_id, @status_code, @message)",
    params,
    ["product_id", "status_code", "message"]
  );
}

function renameUnit(params) {
  return callProcedure(
    "CALL sp_rename_unit(?, ?, ?, @merged, @status_code, @message)",
    params,
    ["merged", "status_code", "message"]
  );
}

function adjustStock(params) {
  return callProcedure(
    "CALL sp_adjust_stock(?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function setReorderPoint(params) {
  return callProcedure(
    "CALL sp_set_reorder_point(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function createPurchaseOrder(params) {
  return callProcedure(
    "CALL sp_create_purchase_order(?, ?, ?, ?, ?, ?, ?, ?, @po_id, @supplier_id_out, @new_materials, @status_code, @message)",
    params,
    ["po_id", "supplier_id_out", "new_materials", "status_code", "message"]
  );
}

function decidePurchaseOrder(params) {
  return callProcedure(
    "CALL sp_decide_purchase_order(?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

function receivePurchaseOrder(params) {
  return callProcedure(
    "CALL sp_receive_purchase_order(?, ?, ?, ?, @lines, @extras, @status_code, @message)",
    params,
    ["lines", "extras", "status_code", "message"]
  );
}

function fileReturnReport(params) {
  return callProcedure(
    "CALL sp_file_return_report(?, ?, ?, ?, ?, ?, ?, NULL, FALSE, ?, @report_id, @off_balance, @status_code, @message)",
    params,
    ["report_id", "off_balance", "status_code", "message"]
  );
}

function fileReturnReports(params) {
  return callProcedure(
    "CALL sp_file_return_reports(?, ?, ?, ?, ?, ?, ?, @report_ids, @off_balance, @status_code, @message)",
    params,
    ["report_ids", "off_balance", "status_code", "message"]
  );
}

function resolveReturnReport(params) {
  return callProcedure(
    "CALL sp_resolve_return_report(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  createMaterial: createMaterial,
  renameUnit: renameUnit,
  adjustStock: adjustStock,
  setReorderPoint: setReorderPoint,
  createPurchaseOrder: createPurchaseOrder,
  decidePurchaseOrder: decidePurchaseOrder,
  receivePurchaseOrder: receivePurchaseOrder,
  fileReturnReport: fileReturnReport,
  fileReturnReports: fileReturnReports,
  resolveReturnReport: resolveReturnReport
};
