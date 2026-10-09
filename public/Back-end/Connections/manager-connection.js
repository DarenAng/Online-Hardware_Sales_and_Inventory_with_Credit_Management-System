// ============================================================
// manager-connection.js -- talking to the server (Manager only)
// Loaded by: manager.html
//
// "get" functions give back the data; "send" functions give back the
// server's Response (see shared-connection.js for how to use them).
// ============================================================

// ---------- reports ----------

// GET /api/reports/income -- query is like '?range=monthly' or '?from=...&to=...'
function apiGetIncome(query) {
    return getJson('/api/reports/income' + query);
}

// Downloads the income breakdown as a CSV file (opens in Excel).
// query starts with '?', which is replaced by '&' here.
function apiDownloadIncomeBreakdown(query) {
    window.location.href = '/api/reports/export?report=income-breakdown&' + query.slice(1);
}

// GET /api/reports/overview
function apiGetReportsOverview() {
    return getJson('/api/reports/overview');
}

// GET /api/reports/activity -- everything staff have filed
function apiGetActivityReport() {
    return getJson('/api/reports/activity');
}

// ---------- stocks ----------

// GET /api/stocks
function apiGetStocks() {
    return getJson('/api/stocks');
}

// PUT /api/stocks/:id/price -- the selling price
function apiSavePrice(productId, price) {
    return sendJson('/api/stocks/' + productId + '/price', 'PUT', { price: price });
}

// PUT /api/stocks/:id/reorder-policy
function apiSaveReorderPolicy(productId, policy) {
    return sendJson('/api/stocks/' + productId + '/reorder-policy', 'PUT', policy);
}

// ---------- credit ----------

// GET /api/credit/requests -- status is 'all', 'Pending', 'Approved' or 'Declined'
function apiGetCreditRequests(status) {
    let url = '/api/credit/requests';
    if (status !== 'all') {
        url = url + '?status=' + status;
    }
    return getJson(url);
}

// POST /api/credit/requests/:id/decide
function apiDecideCreditRequest(requestId, approve, note) {
    return sendJson('/api/credit/requests/' + requestId + '/decide', 'POST', {
        approve: approve,
        note: note
    });
}

// GET /api/credit/policy -- the late-payment rate
function apiGetPenaltyPolicy() {
    return getJson('/api/credit/policy');
}

// PUT /api/credit/policy
function apiSavePenaltyPolicy(penaltyRate) {
    return sendJson('/api/credit/policy', 'PUT', { penaltyRate: penaltyRate });
}

// PUT /api/credit/customers/:id/limit
function apiSaveCreditLimit(customerId, limit) {
    return sendJson('/api/credit/customers/' + customerId + '/limit', 'PUT', limit);
}

// ---------- archives ----------

// GET /api/archives
function apiGetArchives() {
    return getJson('/api/archives');
}

// POST /api/archives/restore -- gives back the Response
function apiRestoreArchive(module, recordId) {
    return sendJson('/api/archives/restore', 'POST', { module: module, recordId: recordId });
}

// POST /api/archives/archive -- gives back the answer, or null if refused
function apiArchiveSale(saleId) {
    return postJson('/api/archives/archive', { module: 'Sales', recordId: saleId });
}

// POST /api/archives/archive -- gives back the answer, or null if refused
function apiArchiveDelivery(deliveryId) {
    return postJson('/api/archives/archive', { module: 'Delivery', recordId: deliveryId });
}

// ---------- staff passwords ----------

// GET /api/staff/passwords -- the staff whose password the manager may reset
function apiGetStaffPasswords() {
    return getJson('/api/staff/passwords');
}

// POST /api/staff/:id/reset-password
function apiResetStaffPassword(staffId) {
    return sendJson('/api/staff/' + staffId + '/reset-password', 'POST', {});
}

// POST /api/reports/spreadsheet -- the tables on a screen as an Excel workbook;
// gives back the Response, whose body is the file
function apiSaveSpreadsheet(title, sheets) {
    return sendJson('/api/reports/spreadsheet', 'POST', { title: title, sheets: sheets });
}

// POST /api/suppliers, /api/categories or /api/units -- the manager adds one
function apiAddRecord(kind, data) {
    const path = { supplier: '/api/suppliers', category: '/api/categories', unit: '/api/units' }[kind];
    return sendJson(path, 'POST', data);
}
