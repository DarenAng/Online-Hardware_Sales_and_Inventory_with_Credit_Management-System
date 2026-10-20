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

// GET /api/stocks/unpriced -- { unpriced: how many products have no price set }
function apiGetUnpricedCount() {
    return getJson('/api/stocks/unpriced');
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

// ---------- account management (creating accounts, sign-in holds) ----------

// GET /api/roles -- gives back the Response; for a manager only the roles a
// manager may create (Cashier, Inventory Clerk, Delivery Personnel)
function apiGetRoles() {
    return fetch('/api/roles', { headers: apiHeaders() });
}

// GET /api/users/email-check -- { taken, roleName } for an address
function apiCheckEmail(email) {
    return getJson('/api/users/email-check?email=' + encodeURIComponent(email));
}

// GET /api/users/phone-check -- { taken, roleName, name } for a stored-style
// number (+639171234567)
function apiCheckPhone(phone) {
    return getJson('/api/users/phone-check?phone=' + encodeURIComponent(phone));
}

// Creating an account is two steps: review (the server makes a password
// and keeps a "draft"), then confirm the draft.
// These give back the answer, or null if refused.

// POST /api/users/draft -- step 1
function apiReviewNewAccount(data) {
    return postJson('/api/users/draft', data);
}

// POST /api/users -- step 2
function apiCreateAccount(draftId) {
    return postJson('/api/users', { draftId: draftId });
}

// GET /api/users -- the cashier, clerk and driver accounts (a manager is sent no other role)
function apiGetManagedStaff() {
    return getJson('/api/users');
}

// POST /api/users/:id/release-hold -- lift the hold, keep the password
function apiReleaseHeldAccount(staffId) {
    return sendJson('/api/users/' + staffId + '/release-hold', 'POST', {});
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

// POST /api/archives/archive -- any module the manager may archive (Supplier,
// Customer, Inventory, Category, Unit, Staff); the answer, or null if refused
function apiArchiveRecord(module, recordId) {
    return postJson('/api/archives/archive', { module: module, recordId: recordId });
}

// PUT /api/suppliers/:id, /api/customers/:id -- the manager corrects a
// record; the answer, or null if refused (a product is the clerk's to edit)
function apiEditRecord(kind, id, data) {
    const path = {
        supplier: '/api/suppliers/' + id,
        customer: '/api/customers/' + id
    }[kind];
    return postJson(path, data, 'PUT');
}
