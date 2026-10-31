function apiGetInventorySummary() {
    return getJson('/api/inventory/summary');
}

function apiGetArchivedProducts() {
    return getJson('/api/inventory/products?archived=true');
}

function apiGetStockAdjustments() {
    return getJson('/api/inventory/adjustments');
}

function apiAddProduct(data) {
    return sendJson('/api/materials', 'POST', data);
}

function apiAdjustStock(data) {
    return sendJson('/api/inventory/adjust', 'POST', data);
}

function apiGetPurchaseOrderReference(poId) {
    return getJson('/api/purchase-orders/' + poId + '/reference');
}

function apiFileReportItems(data) {
    return sendJson('/api/returns/batch', 'POST', data);
}

function apiResolveReturn(reportId, disposition, note) {
    return sendJson('/api/returns/' + reportId + '/resolve', 'POST', {
        disposition: disposition,
        note: note || null
    });
}

function apiArchiveMaterial(productId) {
    return sendJson('/api/archives/archive', 'POST', { module: 'Inventory', recordId: productId });
}

function apiRestoreMaterial(productId) {
    return sendJson('/api/archives/restore', 'POST', { module: 'Inventory', recordId: productId });
}

function apiSaveDeliveryPack(productId, packName, packSize) {
    return sendJson('/api/inventory/products/' + productId + '/pack', 'PUT', {
        packName: packName,
        packSize: packSize
    });
}

function apiSaveDescription(productId, description) {
    return sendJson('/api/inventory/products/' + productId + '/description', 'PUT', {
        description: description
    });
}

function apiAddSellingUnit(productId, unitName, unitsPer, price) {
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

function apiRemoveSellingUnit(productId, unitId) {
    return fetch('/api/inventory/products/' + productId + '/units/' + unitId, {
        method: 'DELETE',
        headers: apiHeaders()
    });
}

function apiAddCategoryOrUnit(kind, name) {
    const path = { category: '/api/categories', unit: '/api/units' }[kind];
    return sendJson(path, 'POST', { name: name });
}
