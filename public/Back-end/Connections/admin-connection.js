// ============================================================
// admin-connection.js -- talking to the server (System Administrator only)
// Loaded by: system.html
//
// "get" functions give back the data; "send" functions give back the
// server's Response (see shared-connection.js for how to use them).
// ============================================================

// ---------- staff accounts ----------

// GET /api/roles -- gives back the Response
function apiGetRoles() {
    return fetch('/api/roles', { headers: apiHeaders() });
}

// GET /api/users -- query is '' or like '?status=inactive'
function apiGetStaff(query) {
    return getJson('/api/users' + query);
}

// PUT /api/users/:id -- change a staff member's details
function apiUpdateStaff(staffId, data) {
    return sendJson('/api/users/' + staffId, 'PUT', data);
}

// PATCH /api/users/:id/status -- activate (true) or deactivate (false)
function apiSetStaffActive(staffId, isActive) {
    return sendJson('/api/users/' + staffId + '/status', 'PATCH', { isActive: isActive });
}

// POST /api/users/:id/reset-password
function apiResetUserPassword(staffId) {
    return sendJson('/api/users/' + staffId + '/reset-password', 'POST', {});
}

// GET /api/users/email-check -- { taken, roleName } for an address; staffId is
// the account being edited, whose own address does not count against it
function apiCheckEmail(email, staffId) {
    let url = '/api/users/email-check?email=' + encodeURIComponent(email);
    if (staffId) url += '&staffId=' + encodeURIComponent(staffId);
    return getJson(url);
}

// Creating an account is two steps: review (the server makes a password
// and keeps a "draft"), then confirm the draft.
// These give back the answer, or null if refused.

// POST /api/users/draft -- step 1 for a new staff member
function apiReviewNewAccount(data) {
    return postJson('/api/users/draft', data);
}

// POST /api/users -- step 2 for a new staff member
function apiCreateAccount(draftId) {
    return postJson('/api/users', { draftId: draftId });
}

// POST /api/users/:id/account/draft -- step 1 for a login to an existing staff record
function apiReviewLogin(staffId, email) {
    return postJson('/api/users/' + staffId + '/account/draft', { email: email });
}

// POST /api/users/:id/account -- step 2 for a login to an existing staff record
function apiCreateLogin(staffId, draftId) {
    return postJson('/api/users/' + staffId + '/account', { draftId: draftId });
}

// ---------- access control ----------

// GET /api/features -- every screen, and which roles have it
function apiGetScreenSwitches() {
    return getJson('/api/features');
}

// PUT /api/features/:key/roles/:roleId -- switch one screen on or off for one role
function apiSetScreenSwitch(featureKey, roleId, granted) {
    return sendJson('/api/features/' + encodeURIComponent(featureKey) + '/roles/' + roleId, 'PUT', {
        granted: granted
    });
}

// ---------- audit logs ----------

// GET /api/audit-logs -- query is like '?type=LOGIN&limit=200'
function apiGetAuditLogs(query) {
    return getJson('/api/audit-logs' + query);
}

// ---------- backup and recovery ----------

// GET /api/backups
function apiGetBackups() {
    return getJson('/api/backups');
}

// PUT /api/backups/auto -- switch the automatic backup on or off
function apiSetAutoBackup(enabled) {
    return postJson('/api/backups/auto', { enabled: enabled }, 'PUT');
}

// POST /api/backups -- make a backup now
function apiMakeBackup() {
    return sendJson('/api/backups', 'POST', {});
}

// Downloads one backup file
function apiDownloadBackup(fileName) {
    window.location.href = '/api/backups/' + encodeURIComponent(fileName);
}

// POST /api/backups/:file/restore
function apiRestoreBackup(fileName) {
    return sendJson('/api/backups/' + encodeURIComponent(fileName) + '/restore', 'POST', {});
}

// DELETE /api/backups/:file
function apiDeleteBackup(fileName) {
    return fetch('/api/backups/' + encodeURIComponent(fileName), {
        method: 'DELETE',
        headers: apiHeaders()
    });
}

// POST /api/restore -- restore from a .sql file the administrator picked
function apiRestoreFromFile(sql) {
    return sendJson('/api/restore', 'POST', { sql: sql });
}

// ---------- store settings ----------

// PUT /api/store-settings
function apiSaveStoreSettings(settings) {
    return sendJson('/api/store-settings', 'PUT', settings);
}
