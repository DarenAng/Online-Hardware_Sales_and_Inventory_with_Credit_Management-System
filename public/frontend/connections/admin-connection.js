function apiGetRoles() {
    return fetch('/api/roles', { headers: apiHeaders() });
}

function apiGetStaff(query) {
    return getJson('/api/users' + query);
}

function apiUpdateStaff(staffId, data) {
    return sendJson('/api/users/' + staffId, 'PUT', data);
}

function apiSetStaffActive(staffId, isActive) {
    return sendJson('/api/users/' + staffId + '/status', 'PATCH', { isActive: isActive });
}

function apiArchiveStaff(staffId) {
    return sendJson('/api/archives/archive', 'POST', { module: 'Staff', recordId: staffId });
}

function apiResetUserPassword(staffId) {
    return sendJson('/api/users/' + staffId + '/reset-password', 'POST', {});
}

function apiReleaseHold(staffId) {
    return sendJson('/api/users/' + staffId + '/release-hold', 'POST', {});
}

function apiCheckEmail(email, staffId) {
    let url = '/api/users/email-check?email=' + encodeURIComponent(email);
    if (staffId) url += '&staffId=' + encodeURIComponent(staffId);
    return getJson(url);
}

function apiCheckPhone(phone, staffId) {
    let url = '/api/users/phone-check?phone=' + encodeURIComponent(phone);
    if (staffId) url += '&staffId=' + encodeURIComponent(staffId);
    return getJson(url);
}

function apiReviewNewAccount(data) {
    return postJson('/api/users/draft', data);
}

function apiCreateAccount(draftId) {
    return postJson('/api/users', { draftId: draftId });
}

function apiReviewLogin(staffId, email) {
    return postJson('/api/users/' + staffId + '/account/draft', { email: email });
}

function apiCreateLogin(staffId, draftId) {
    return postJson('/api/users/' + staffId + '/account', { draftId: draftId });
}

function apiGetScreenSwitches() {
    return getJson('/api/features');
}

function apiSetScreenSwitch(featureKey, roleId, granted) {
    return sendJson('/api/features/' + encodeURIComponent(featureKey) + '/roles/' + roleId, 'PUT', {
        granted: granted
    });
}

function apiGetAuditLogs(query) {
    return getJson('/api/audit-logs' + query);
}

function apiGetBackups() {
    return getJson('/api/backups');
}

function apiSetAutoBackup(enabled) {
    return postJson('/api/backups/auto', { enabled: enabled }, 'PUT');
}

function apiMakeBackup() {
    return sendJson('/api/backups', 'POST', {});
}

function apiDownloadBackup(fileName) {
    window.location.href = '/api/backups/' + encodeURIComponent(fileName);
}

function apiRestoreBackup(fileName) {
    return sendJson('/api/backups/' + encodeURIComponent(fileName) + '/restore', 'POST', {});
}

function apiDeleteBackup(fileName) {
    return fetch('/api/backups/' + encodeURIComponent(fileName), {
        method: 'DELETE',
        headers: apiHeaders()
    });
}

function apiRestoreFromFile(sql) {
    return sendJson('/api/restore', 'POST', { sql: sql });
}

function apiSaveStoreSettings(settings) {
    return sendJson('/api/store-settings', 'PUT', settings);
}
