// ============================================================
// inventory-clerk-procedures.js -- the stored procedures called for the Inventory Clerk's screens (materials, stock, purchase orders, returns)
// Loaded by: routes/inventory-clerk.js only. Never sent to a browser.
//
// One function per procedure. Each takes the list of values for the ? marks
// and gives back the OUT values callProcedure reads (status_code and message
// among them; see shared-procedures.js). The procedures themselves are in
// public/database/2-RUN-SECOND-stored-procedures.sql.
// ============================================================

const callProcedure = require("./shared-procedures").callProcedure;

// sp_create_material: Opens a record for a material the shop has never stocked.
function createMaterial(params) {
  return callProcedure(
    "CALL sp_create_material(?, ?, ?, ?, ?, ?, ?, @product_id, @status_code, @message)",
    params,
    ["product_id", "status_code", "message"]
  );
}

// sp_rename_unit: Renames a unit of measure (merging it into one that already exists).
function renameUnit(params) {
  return callProcedure(
    "CALL sp_rename_unit(?, ?, ?, @merged, @status_code, @message)",
    params,
    ["merged", "status_code", "message"]
  );
}

// sp_adjust_stock: Corrects a stock figure by hand.
function adjustStock(params) {
  return callProcedure(
    "CALL sp_adjust_stock(?, ?, ?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_set_reorder_point: Sets where a material's reorder point sits.
function setReorderPoint(params) {
  return callProcedure(
    "CALL sp_set_reorder_point(?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_create_purchase_order: Raises a purchase order For Approval.
function createPurchaseOrder(params) {
  return callProcedure(
    "CALL sp_create_purchase_order(?, ?, ?, ?, ?, ?, ?, ?, @po_id, @supplier_id_out, @new_materials, @status_code, @message)",
    params,
    ["po_id", "supplier_id_out", "new_materials", "status_code", "message"]
  );
}

// sp_decide_purchase_order: Confirms or declines a purchase order.
function decidePurchaseOrder(params) {
  return callProcedure(
    "CALL sp_decide_purchase_order(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

// sp_receive_purchase_order: Counts a delivery in against its purchase order and adds it to stock.
function receivePurchaseOrder(params) {
  return callProcedure(
    "CALL sp_receive_purchase_order(?, ?, ?, ?, @lines, @extras, @status_code, @message)",
    params,
    ["lines", "extras", "status_code", "message"]
  );
}

// sp_file_return_report: Files one return, damage, refund or missing-goods report.
function fileReturnReport(params) {
  return callProcedure(
    "CALL sp_file_return_report(?, ?, ?, ?, ?, ?, ?, NULL, FALSE, ?, @report_id, @off_balance, @status_code, @message)",
    params,
    ["report_id", "off_balance", "status_code", "message"]
  );
}

// sp_file_return_reports: Files a report of several items at once.
function fileReturnReports(params) {
  return callProcedure(
    "CALL sp_file_return_reports(?, ?, ?, ?, ?, ?, ?, @report_ids, @off_balance, @status_code, @message)",
    params,
    ["report_ids", "off_balance", "status_code", "message"]
  );
}

// sp_resolve_return_report: Inspects a report: back to the shelf or written off.
function resolveReturnReport(params) {
  return callProcedure(
    "CALL sp_resolve_return_report(?, ?, ?, ?, @status_code, @message)",
    params,
    ["status_code", "message"]
  );
}

module.exports = {
  createMaterial,
  renameUnit,
  adjustStock,
  setReorderPoint,
  createPurchaseOrder,
  decidePurchaseOrder,
  receivePurchaseOrder,
  fileReturnReport,
  fileReturnReports,
  resolveReturnReport
};
