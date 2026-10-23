function apiGetIncome(query) {
    return getJson('/api/reports/income' + query);
}

function apiDownloadIncomeBreakdown(query) {
    window.location.href = '/api/reports/export?report=income-breakdown&' + query.slice(1);
}

function apiGetReportsOverview() {
    return getJson('/api/reports/overview');
}

function apiGetActivityReport() {
    return getJson('/api/reports/activity');
}

function apiGetStocks() {
    return getJson('/api/stocks');
}

function apiGetUnpricedCount() {
    return getJson('/api/stocks/unpriced');
}

function apiSavePrice(productId, price) {
    return sendJson('/api/stocks/' + productId + '/price', 'PUT', { price: price });
}

function apiSaveReorderPolicy(productId, policy) {
    return sendJson('/api/stocks/' + productId + '/reorder-policy', 'PUT', policy);
}

function apiGetCreditRequests(status) {
    let url = '/api/credit/requests';
    if (status !== 'all') {
        url = url + '?status=' + status;
    }
    return getJson(url);
}

function apiDecideCreditRequest(requestId, approve, note) {
    return sendJson('/api/credit/requests/' + requestId + '/decide', 'POST', {
        approve: approve,
        note: note
    });
}

function apiGetPenaltyPolicy() {
    return getJson('/api/credit/policy');
}

function apiSavePenaltyPolicy(penaltyRate) {
    return sendJson('/api/credit/policy', 'PUT', { penaltyRate: penaltyRate });
}

function apiGetLoyaltyPolicy() {
    return getJson('/api/loyalty/policy');
}

function apiSaveLoyaltyPolicy(rate, threshold) {
    return sendJson('/api/loyalty/policy', 'PUT', { rate: rate, threshold: threshold });
}

function apiSaveCreditLimit(customerId, limit) {
    return sendJson('/api/credit/customers/' + customerId + '/limit', 'PUT', limit);
}

function apiGetArchives() {
    return getJson('/api/archives');
}

function apiRestoreArchive(module, recordId) {
    return sendJson('/api/archives/restore', 'POST', { module: module, recordId: recordId });
}

function apiGetRoles() {
    return fetch('/api/roles', { headers: apiHeaders() });
}

function apiCheckEmail(email) {
    return getJson('/api/users/email-check?email=' + encodeURIComponent(email));
}

function apiCheckPhone(phone) {
    return getJson('/api/users/phone-check?phone=' + encodeURIComponent(phone));
}

function apiReviewNewAccount(data) {
    return postJson('/api/users/draft', data);
}

function apiCreateAccount(draftId) {
    return postJson('/api/users', { draftId: draftId });
}

function apiGetManagedStaff() {
    return getJson('/api/users');
}

function apiReleaseHeldAccount(staffId) {
    return sendJson('/api/users/' + staffId + '/release-hold', 'POST', {});
}

function apiGetStaffPasswords() {
    return getJson('/api/staff/passwords');
}

function apiResetStaffPassword(staffId) {
    return sendJson('/api/staff/' + staffId + '/reset-password', 'POST', {});
}

function apiSaveSpreadsheet(title, sheets) {
    return sendJson('/api/reports/spreadsheet', 'POST', { title: title, sheets: sheets });
}

function apiAddRecord(kind, data) {
    const path = { supplier: '/api/suppliers', category: '/api/categories', unit: '/api/units' }[kind];
    return sendJson(path, 'POST', data);
}

function apiArchiveRecord(module, recordId) {
    return postJson('/api/archives/archive', { module: module, recordId: recordId });
}

function apiEditRecord(kind, id, data) {
    const path = {
        supplier: '/api/suppliers/' + id
    }[kind];
    return postJson(path, data, 'PUT');
}

function apiGetVoidRequests() {
    return getJson('/api/void-requests');
}

function apiDecideVoidRequest(requestId, approve, note) {
    return sendJson('/api/void-requests/' + encodeURIComponent(requestId) + (approve ? '/approve' : '/decline'),
        'POST', { note: note || '' });
}
