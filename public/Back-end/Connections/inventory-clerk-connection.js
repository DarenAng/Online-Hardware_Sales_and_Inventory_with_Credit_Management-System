// ============================================================
// inventory-clerk-connection.js -- talking to the server (Inventory Clerk only)
// Loaded by: inventory-dashboard.html
//
// "get" functions give back the data; "send" functions give back the
// server's Response (see shared-connection.js for how to use them).
// ============================================================

// GET /api/inventory/summary -- the numbers at the top of the dashboard
function apiGetInventorySummary() {
    return getJson('/api/inventory/summary');
}

// GET /api/inventory/products?archived=true -- the material archive
function apiGetArchivedProducts() {
    return getJson('/api/inventory/products?archived=true');
}

// GET /api/inventory/adjustments -- the adjustment history
function apiGetStockAdjustments() {
    return getJson('/api/inventory/adjustments');
}

// POST /api/inventory/adjust -- correct a stock figure
function apiAdjustStock(data) {
    return sendJson('/api/inventory/adjust', 'POST', data);
}

// PUT /api/inventory/reorder/:id -- the reorder point of one material
function apiSaveReorderPoint(productId, reorderPoint) {
    return sendJson('/api/inventory/reorder/' + productId, 'PUT', { reorderPoint: reorderPoint });
}

// POST /api/returns/:id/resolve -- after inspecting: back to stock, or write off
function apiResolveReturn(reportId, disposition, note) {
    return sendJson('/api/returns/' + reportId + '/resolve', 'POST', {
        disposition: disposition,
        note: note || null
    });
}

// POST /api/archives/archive -- put a material away
function apiArchiveMaterial(productId) {
    return sendJson('/api/archives/archive', 'POST', { module: 'Inventory', recordId: productId });
}

// POST /api/archives/restore -- bring a material back
function apiRestoreMaterial(productId) {
    return sendJson('/api/archives/restore', 'POST', { module: 'Inventory', recordId: productId });
}

// PUT /api/inventory/products/:id/pack -- how a material is delivered (e.g. a box of 20)
function apiSaveDeliveryPack(productId, packName, packSize) {
    return sendJson('/api/inventory/products/' + productId + '/pack', 'PUT', {
        packName: packName,
        packSize: packSize
    });
}

// POST /api/inventory/products/:id/units -- a size it also sells in (e.g. a sack)
function apiAddSellingUnit(productId, unitName, unitsPer, price) {
    // an empty price box means "work the price out from the unit price"
    let priceValue = null;
    if (price !== '') {
        priceValue = Number(price);
    }
    return sendJson('/api/inventory/products/' + productId + '/units', 'POST', {
        unitName: unitName,
        unitsPer: unitsPer,
        price: priceValue
    });
}

// DELETE /api/inventory/products/:id/units/:unitId
function apiRemoveSellingUnit(productId, unitId) {
    return fetch('/api/inventory/products/' + productId + '/units/' + unitId, {
        method: 'DELETE',
        headers: apiHeaders()
    });
}
