// system-admin.js -- system administrator
// Loaded by: system.html

// ==========================================
// PANEL SWITCHING (System page)
// ==========================================
// what the top bar says on each screen
const ADMIN_TITLES = {
    'panel-accounts':    'Staff Directory',
    'panel-create':      'Create Account',
    'panel-archive':     'Archived Accounts',
    'panel-access':      'Who Holds Access',
    'panel-features':    'Screens by Role',
    'panel-systems':     'Connected Systems',
    'panel-logs':        'Audit Logs',
    'panel-maintenance': 'Backup & Recovery',
    'panel-store':       'Receipt Maintenance'
};

// Account and access screens are lists under folded headings; opening a
// screen unfolds its list, except the one the page opens on by itself.
const ACCOUNT_PANELS = ['panel-accounts', 'panel-create', 'panel-archive'];
const ACCESS_PANELS = ['panel-access', 'panel-features', 'panel-systems'];
let adminPageLoaded = false;

function showPanel(panelId, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    if (adminPageLoaded) {
        if (ACCOUNT_PANELS.includes(panelId)) toggleAccountsMenu(null, true);
        if (ACCESS_PANELS.includes(panelId)) toggleAccessMenu(null, true);
    }

    const heading = document.getElementById('admin-page-title');
    if (heading) heading.textContent = ADMIN_TITLES[panelId] || 'System Administration';

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// Opening a screen fetches nothing. The default view is the directory.
function showAccountsList(event) {
    showPanel('panel-accounts', event);
}

// Two ways to load the directory: Load Data, or a search. The filters only
// narrow what has arrived (on a closed table they apply to the first load).
function showAllUsers(event) {
    showPanel('panel-accounts', event);
}

// shared/helpers.js's toggleSidebarMenu does the fold; these name the lists
function toggleAccountsMenu(event, force) { toggleSidebarMenu('accounts-nav', 'accounts-dropdown', event, force); }
function toggleAccessMenu(event, force)   { toggleSidebarMenu('access-nav', 'access-dropdown', event, force); }

function showCreateAccount(event) { showPanel('panel-create', event); }
function showArchiveModule(event) { showPanel('panel-archive', event); }
function showAuditLogs(event)     { showPanel('panel-logs', event); }
// The backup card at the top loads on opening: a failing backup must not
// hide behind a button. The tables still wait to be asked.
function showMaintenance(event) {
    showPanel('panel-maintenance', event);
    loadAutoBackupState();
}
function showStoreSettings(event) { showPanel('panel-store', event); loadStoreSettingsForm(); }
function showAccessControl(event) { showPanel('panel-access', event); }

// one small request, read on opening; not re-read over unsaved changes
function showScreensByRole(event) {
    showPanel('panel-features', event);
    if (featureMatrixChanges().length === 0) loadFeatureMatrix();
}

// ==========================================
// ROLES
// ==========================================
let systemRoles = [];

async function loadRoles() {
    try {
        const response = await fetch('/api/roles', { headers: apiHeaders() });
        if (!response.ok) return;

        systemRoles = await response.json();

        const options = systemRoles
            .map((role) => `<option value="${role.role_id}">${escapeHtml(role.role_name)}</option>`)
            .join('');

        document.querySelectorAll('[data-role-select]').forEach((select) => {
            select.innerHTML = options;
        });

        document.querySelectorAll('[data-role-filter]').forEach((select) => {
            select.innerHTML = '<option value="all">Every role</option>' + options;
        });
    } catch (error) {
        console.error('Unable to load roles:', error);
    }
}

// Active/Inactive is a decision about the account; Online/Offline is whether
// the person is at a screen now. Each has its own column and filter.
let selectedUser = null;

function accountCell(user) {
    return user.is_active
        ? '<span class="badge badge-success">Active</span>'
        : '<span class="badge badge-danger">Inactive</span>';
}

function presenceCell(user) {
    // no login account means they cannot be online
    if (!user.user_id) {
        return '<span class="presence"><span class="presence-dot"></span>No login</span>';
    }

    return user.is_online
        ? '<span class="presence is-online"><span class="presence-dot"></span>Online now</span>'
        : '<span class="presence"><span class="presence-dot"></span>Offline</span>';
}

function userSearchFields(user) {
    return [
        user.full_name, user.first_name, user.middle_name, user.last_name,
        user.email, user.role_name, user.staff_id, '#' + user.staff_id
    ];
}

// the account-state filter goes back to the server; role and presence are decided here
function currentStatusFilter() {
    const select = document.getElementById('accounts-status');
    return select ? select.value : 'all';
}

async function reloadUsers() {
    syncDirectoryColumns();

    const panel = getDataPanel('admin-users');
    if (!panel) return;

    // on an open table the server filter means re-reading; a closed one reads it on load
    if (panel.state === 'ready') await panel.refresh();
}

function filterDirectory(name, value) {
    dataPanelFilter('admin-users', name, value);
    syncDirectoryColumns();
}

// While a filter is set, the column it decides is not drawn. Positions are
// 1-based to match the <th> order in system.html; tables.js re-applies them
// on every redraw.
const DIRECTORY_COLUMN = { role: 4, status: 5, presence: 6 };
const LOG_COLUMN = { type: 5 };

function selectValue(id) {
    const select = document.getElementById(id);
    return select ? select.value : 'all';
}

function syncDirectoryColumns() {
    const hidden = [];
    if (selectValue('accounts-role') !== 'all') hidden.push(DIRECTORY_COLUMN.role);
    if (selectValue('accounts-status') !== 'all') hidden.push(DIRECTORY_COLUMN.status);
    if (selectValue('accounts-presence') !== 'all') hidden.push(DIRECTORY_COLUMN.presence);

    setHiddenColumns(document.getElementById('accounts-table'), hidden);
}

// the date boxes are left out: a range still leaves a different timestamp per row
function syncLogColumns() {
    const hidden = [];
    if (selectValue('logs-type') !== 'all') hidden.push(LOG_COLUMN.type);

    setHiddenColumns(document.getElementById('logs-table'), hidden);
}

function buildUsersPanel() {
    createDataPanel({
        key: 'admin-users',
        tableId: 'accounts-table',
        columns: 6,
        pagerId: 'accounts-pager',
        countPillId: 'accounts-count',
        idField: 'staff_id',
        filters: { presence: 'all', roleId: 'all' },

        // filters set up a query rather than run one; see dataPanelFilter
        loadOnFilter: false,

        gate: {
            title: 'The directory is not loaded',
            text: 'Set the filters you want, then press Load Data to read the staff ' +
                  'directory &mdash; or type a name in the search box and press Enter to look one person up.',
            button: 'Load Data'
        },

        load: () => {
            const status = currentStatusFilter();
            const query = status === 'all' ? '' : '?status=' + encodeURIComponent(status);
            return getJson('/api/users' + query);
        },

        match: (user, query) => prefixMatch(userSearchFields(user), query),

        filter: (user, filters) => {
            if (filters.roleId !== 'all' && String(user.role_id) !== String(filters.roleId)) return false;
            if (filters.presence === 'online' && !user.is_online) return false;
            if (filters.presence === 'offline' && user.is_online) return false;
            return true;
        },

        renderRow: (user, index) => `
            <tr class="row-clickable row-reveal" style="animation-delay: ${(index % 10) * 28}ms"
                onclick="openUserModal(${user.staff_id})" title="Click to view full details">
                <td class="cell-id">#${escapeHtml(user.staff_id)}</td>
                <td class="cell-name">${escapeHtml(staffName(user))}</td>
                <td>${user.email ? escapeHtml(user.email) : '<span class="muted">No login account</span>'}</td>
                <td>${escapeHtml(user.role_name)}</td>
                <td>${accountCell(user)}</td>
                <td>${presenceCell(user)}</td>
            </tr>`
    });
}

function openUserModal(staffId) {
    const panel = getDataPanel('admin-users');
    selectedUser = panel ? panel.find(staffId, 'staff_id') : null;
    if (!selectedUser) return;

    document.getElementById('modal-user-name').textContent =
        staffName(selectedUser);
    document.getElementById('modal-user-role').textContent = selectedUser.role_name;

    const initials = (selectedUser.first_name[0] + selectedUser.last_name[0]).toUpperCase();
    document.getElementById('modal-user-avatar').textContent = initials;

    document.getElementById('modal-user-details').innerHTML =
        detailRow('Staff ID', '#' + escapeHtml(selectedUser.staff_id)) +
        detailRow('User ID', selectedUser.user_id ? '#' + escapeHtml(selectedUser.user_id) : '<span class="muted">None</span>') +
        detailRow('Full Name', escapeHtml(staffName(selectedUser))) +
        detailRow('First Name', escapeHtml(selectedUser.first_name)) +
        detailRow('Middle Name', selectedUser.middle_name
            ? escapeHtml(selectedUser.middle_name)
            : '<span class="muted">Not set</span>') +
        detailRow('Last Name', escapeHtml(selectedUser.last_name)) +
        detailRow('Email', selectedUser.email ? escapeHtml(selectedUser.email) : '<span class="muted">No login account</span>') +
        detailRow('Phone', selectedUser.phone
            ? '<span class="mono">' + escapeHtml(phoneForDisplay(selectedUser.phone)) + '</span>'
            : '<span class="muted">Not set</span>') +
        detailRow('Role', escapeHtml(selectedUser.role_name)) +
        detailRow('Account Status', `<span class="badge ${selectedUser.is_active ? 'badge-success' : 'badge-danger'}">${selectedUser.is_active ? 'Active' : 'Inactive'}</span>`) +
        detailRow('Signed In Now', selectedUser.is_online
            ? '<span class="presence is-online"><span class="presence-dot"></span>Yes</span>'
            : '<span class="presence"><span class="presence-dot"></span>No</span>') +
        detailRow('Password State', selectedUser.must_change_password ? '<span class="badge badge-warning">Temporary</span>' : '<span class="badge badge-neutral">Set by user</span>') +
        detailRow('Hired On', escapeHtml(selectedUser.staff_created_at)) +
        detailRow('Account Created', selectedUser.created_at ? escapeHtml(selectedUser.created_at) : '<span class="muted">Not available</span>') +
        detailRow('Last Login', selectedUser.last_login ? escapeHtml(selectedUser.last_login) : '<span class="muted">Never</span>');

    const form = document.getElementById('edit-user-form');
    form.elements.firstName.value = selectedUser.first_name;
    form.elements.middleName.value = selectedUser.middle_name || '';
    form.elements.lastName.value = selectedUser.last_name;
    phoneFill(form.elements.phone, selectedUser.phone);
    form.elements.email.value = selectedUser.email || '';
    form.elements.roleId.value = selectedUser.role_id;

    markFormClean(form, document.getElementById('edit-user-save-btn'));

    const statusButton = document.getElementById('modal-status-btn');
    statusButton.textContent = selectedUser.is_active ? 'Deactivate Account' : 'Activate Account';
    statusButton.className = selectedUser.is_active ? 'btn btn-danger' : 'btn btn-success';

    const hasLogin = Boolean(selectedUser.user_id);
    document.getElementById('modal-login-btn').style.display = hasLogin ? 'none' : 'inline-block';
    document.getElementById('modal-reset-btn').style.display = hasLogin ? 'inline-block' : 'none';

    // The server refuses every change to the signed-in person's own record
    // (notOwnAccount in server.js), so the buttons are taken away here too.
    const own = isOwnAccount(selectedUser);
    document.getElementById('modal-own-note').style.display = own ? 'block' : 'none';
    document.getElementById('modal-edit-tab').style.display = own ? 'none' : '';
    ['modal-login-btn', 'modal-reset-btn', 'modal-status-btn'].forEach((id) => {
        const button = document.getElementById(id);
        button.disabled = own;
        button.title = own ? 'Another administrator makes changes to your account' : '';
    });

    showUserTab('view');
    showModal('user-modal');
}

function isOwnAccount(user) {
    const me = getCurrentUser();
    return Boolean(me && user && Number(me.staff_id) === Number(user.staff_id));
}

function showUserTab(tab) {
    const isEdit = tab === 'edit';
    document.getElementById('modal-user-details').style.display = isEdit ? 'none' : 'grid';
    document.getElementById('modal-user-edit').style.display = isEdit ? 'block' : 'none';
    document.getElementById('modal-view-tab').classList.toggle('active', !isEdit);
    document.getElementById('modal-edit-tab').classList.toggle('active', isEdit);
}

// Returns the server's reply on success and false on failure. No
// successMessage means the caller does the talking.
async function sendUserRequest(url, method, data, successMessage) {
    try {
        const response = await fetch(url, {
            method: method,
            headers: apiHeaders(),
            body: JSON.stringify(data)
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return false;
        }

        if (successMessage) notifySuccess(successMessage);
        closeModal('user-modal');

        const panel = getDataPanel('admin-users');
        if (panel) await panel.refresh();

        return result || true;
    } catch (error) {
        notifyOffline();
        return false;
    }
}

async function handleUpdateUser(event) {
    event.preventDefault();
    if (!selectedUser) return;

    if (isOwnAccount(selectedUser)) {
        notifyWarning('Your own account is changed by another administrator, not from here.', 'Not allowed');
        return;
    }

    const form = event.target;

    // a save of nothing writes an "unchanged" audit entry and signs the person out
    if (!isFormDirty(form)) {
        notifyInfo('Nothing on this form has been changed, so there is nothing to save.', 'No changes');
        return;
    }

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone),
        email: form.elements.email.value.trim(),
        roleId: parseInt(form.elements.roleId.value, 10)
    };

    const name = staffName(selectedUser);

    // a role change is asked about; a spelling correction is not
    if (Number(data.roleId) !== Number(selectedUser.role_id)) {
        const role = systemRoles.find((item) => Number(item.role_id) === Number(data.roleId));

        const yes = await askConfirm(
            `${name} moves from ${selectedUser.role_name} to ${role ? role.role_name : 'another role'}.`,
            {
                title: 'Change this role?',
                eyebrow: 'Accounts Management',
                confirmLabel: 'Change the role',
                detail: [
                    'They are signed out now and must sign in again.',
                    'Their menu and their permissions become the new role at once.'
                ]
            });

        if (!yes) return;
    }

    await sendUserRequest('/api/users/' + selectedUser.staff_id, 'PUT', data, 'Account updated.');
}

async function toggleUserStatus() {
    if (!selectedUser) return;

    if (isOwnAccount(selectedUser)) {
        notifyWarning('You cannot deactivate your own account. Another administrator can.', 'Not allowed');
        return;
    }

    const makeActive = !selectedUser.is_active;
    const name = staffName(selectedUser);

    const yes = makeActive
        ? await askConfirm(`${name} will be able to sign in again straight away.`, {
            title: 'Activate this account?',
            eyebrow: 'Accounts Management',
            confirmLabel: 'Activate'
        })
        : await askDanger(`${name} loses access to the system.`, {
            title: 'Deactivate this account?',
            eyebrow: 'Accounts Management',
            confirmLabel: 'Deactivate the account',
            detail: [
                'Any session they have open is ended immediately.',
                'They cannot sign in again until an administrator restores the account.',
                'Their sales, records and history are kept and are not deleted.'
            ]
        });

    if (!yes) return;

    await sendUserRequest(
        '/api/users/' + selectedUser.staff_id + '/status',
        'PATCH',
        { isActive: makeActive },
        makeActive ? 'The account is active again.' : 'The account has been deactivated.'
    );
}

async function resetUserPassword() {
    if (!selectedUser) return;

    if (isOwnAccount(selectedUser)) {
        notifyWarning('Change your own password under My Account. This screen resets other people\'s.', 'Not allowed');
        return;
    }

    if (!selectedUser.user_id) {
        notifyWarning('This staff member has no login account yet. Use Create Login first.', 'No login to reset');
        return;
    }

    // nobody types the new password: the server makes it and sends it
    const name = staffName(selectedUser);
    const yes = await askDanger(
        `A new password is made for ${name} and sent to ${selectedUser.email}. ` +
        'The one they have now stops working the moment you confirm.',
        {
            title: 'Reset this password?',
            eyebrow: 'Accounts Management',
            confirmLabel: 'Reset and send',
            cancelLabel: 'Cancel',
            detail: [
                'Every screen they are signed in on is signed out.',
                'They sign in with the new password and are asked to choose their own.',
                'If the mail cannot go, the password is shown to you once, to hand over.'
            ]
        });

    if (!yes) return;

    const result = await sendUserRequest(
        '/api/users/' + selectedUser.staff_id + '/reset-password', 'POST', {});
    if (!result) return;

    closeModal('user-modal');
    await reportResetPassword(result, selectedUser.email, name);
}

// the same two outcomes as a first password, worded for a reset
async function reportResetPassword(result, email, name) {
    if (result.emailed) {
        notifySuccess(`A new password was emailed to ${email}. ` +
            `${name} must change it the next time they sign in.`, 'Password reset');
        return;
    }

    await askConfirm(
        `The password was reset, but the new one could not be sent. Read it out to ` +
        `${name} now: it is not shown again after this card.`,
        {
            title: 'The password was not sent',
            eyebrow: 'Accounts Management',
            mark: '!',
            confirmLabel: 'I have written it down',
            cancelLabel: 'Close',
            tone: 'danger',
            detail: [
                'Password: ' + result.password,
                'Signs in with: ' + email,
                result.reason || 'The password could not be emailed.',
                name + ' must change it the next time they sign in.'
            ]
        });
}

// Save is off until something in the form differs from what the record said.
// Spaces at the ends do not count: the server trims them.
const formBaselines = new WeakMap();

function formValues(form) {
    const values = {};
    Array.from(form.elements).forEach((field) => {
        if (!field.name || field.disabled) return;
        values[field.name] = String(field.value === undefined ? '' : field.value).trim();
    });
    return JSON.stringify(values);
}

function isFormDirty(form) {
    if (!form) return false;
    const baseline = formBaselines.get(form);
    return baseline === undefined ? true : formValues(form) !== baseline;
}

function markFormClean(form, button) {
    if (!form) return;
    formBaselines.set(form, formValues(form));
    syncSaveButton(form, button);
}

function syncSaveButton(form, button) {
    if (!form || !button) return;
    const dirty = isFormDirty(form);
    button.disabled = !dirty;
    button.title = dirty ? '' : 'Nothing has changed yet';
}

function watchFormEdits(form, button) {
    if (!form || !button) return;
    const update = () => syncSaveButton(form, button);
    form.addEventListener('input', update);
    form.addEventListener('change', update);
}

// Cancelling the create form empties it so the next person does not find a
// half-typed account waiting.
function clearCreateForm() {
    const form = document.getElementById('create-user-form');
    if (!form) return;

    form.reset();

    // reset() does not clear the box's verdict, nor the country button
    const phone = form.elements.phone;
    if (phone) phoneFill(phone, '');
}

function cancelCreateAccount(event) {
    clearCreateForm();
    showAccountsList(event);
}

// Creating an account is two steps: the server drafts the whole account
// (including the password nobody types) and it comes back to be read on a
// dialog. Confirming creates it and sends the password; cancelling creates
// nothing.
function reviewCard(review, lines) {
    const wait = review.willEmail
        ? `Confirm and the password is emailed to ${review.email}. Nothing has been created yet.`
        : `Mail is not set up on this server, so write this password down now -- ` +
          `it is not shown again and is not stored anywhere you can read it back. ` +
          `Nothing has been created yet.`;

    return askConfirm(wait, {
        title: 'Check this before it is created',
        eyebrow: 'Accounts Management',
        mark: '?',
        confirmLabel: review.willEmail ? 'Create and send' : 'Create the account',
        cancelLabel: 'Go back and edit',
        detail: lines
    });
}

// Emailed is a corner card; not emailed keeps the password on screen in a dialog.
async function reportFirstPassword(result, email, name) {
    if (result.emailed) {
        notifySuccess(`The first password was emailed to ${email}. ` +
            `${name} must change it the first time they sign in.`, 'Account created');
        return;
    }

    await askConfirm(
        `The account exists, but the password could not be sent. Read it out to ` +
        `${name} now: it is not shown again after this card.`,
        {
            title: 'The password was not sent',
            eyebrow: 'Accounts Management',
            mark: '!',
            confirmLabel: 'I have written it down',
            cancelLabel: 'Close',
            tone: 'danger',
            detail: [
                'Password: ' + result.password,
                'Signs in with: ' + email,
                result.reason || 'The password could not be emailed.',
                name + ' must change it the first time they sign in.'
            ]
        });
}

async function handleCreateUser(event) {
    event.preventDefault();
    const form = event.target;

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone),
        email: form.elements.email.value.trim(),
        roleId: parseInt(form.elements.roleId.value, 10)
    };

    const phoneProblem = phoneComplaint(form.elements.phone);
    if (phoneProblem) {
        notifyWarning(phoneProblem, 'Check the phone number');
        form.elements.phone.focus();
        return;
    }

    try {
        // ---------- step 1: work it out, create nothing ----------
        const review = await postJson('/api/users/draft', data);
        if (!review) return;

        const yes = await reviewCard(review, [
            'Name: ' + review.fullName,
            'Middle name: ' + (review.middleName || 'none'),
            'Role: ' + review.roleName,
            'Phone: ' + (review.phone ? phoneForDisplay(review.phone) : 'none'),
            'Signs in with: ' + review.email,
            'Password: ' + review.password
        ]);

        if (!yes) return;

        // ---------- step 2: create it and send the password ----------
        const result = await postJson('/api/users', { draftId: review.draftId });
        if (!result) return;

        clearCreateForm();
        showPanel('panel-accounts');

        // the directory is refreshed only if somebody already had it open
        const panel = getDataPanel('admin-users');
        if (panel && panel.state === 'ready') await panel.refresh();

        await reportFirstPassword(result, result.email, result.name);
    } catch (error) {
        notifyOffline();
    }
}

async function createLoginAccount() {
    if (!selectedUser || selectedUser.user_id) return;

    const name = staffName(selectedUser);

    const email = await askInput({
        title: 'Create a login',
        eyebrow: 'Accounts Management',
        message: `${name} has a staff record but no way to sign in yet. The email is the username, ` +
                 'so it has to be one no other account already uses, and it is where the system ' +
                 'sends the first password.',
        label: 'Email address',
        type: 'email',
        placeholder: 'name@hardware.com',
        confirmLabel: 'Review',
        check: (value) => {
            if (value.trim() === '') return 'An email address is required.';
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'That does not look like an email address.';
            return null;
        }
    });

    if (email === false || email === null) return;

    const staffId = selectedUser.staff_id;

    try {
        const review = await postJson('/api/users/' + staffId + '/account/draft',
            { email: email.trim() });
        if (!review) return;

        const yes = await reviewCard(review, [
            'Name: ' + review.fullName,
            'Role: ' + review.roleName,
            'Phone: ' + (review.phone ? phoneForDisplay(review.phone) : 'none'),
            'Signs in with: ' + review.email,
            'Password: ' + review.password
        ]);

        if (!yes) return;

        const result = await postJson('/api/users/' + staffId + '/account',
            { draftId: review.draftId });
        if (!result) return;

        closeModal('user-modal');

        const panel = getDataPanel('admin-users');
        if (panel && panel.state === 'ready') await panel.refresh();

        await reportFirstPassword(result, result.email, result.name || name);
    } catch (error) {
        notifyOffline();
    }
}

// Archived accounts: the row opens the person, and Restore is one labelled
// action on that card rather than a button on every row.
let selectedArchived = null;

function buildArchivePanel() {
    createDataPanel({
        key: 'admin-archive',
        tableId: 'archive-table',
        columns: 5,
        pagerId: 'archive-pager',
        countPillId: 'archive-count',
        idField: 'staff_id',

        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data to read the deactivated staff accounts, or type a name and press Enter.',
            button: 'Load Data'
        },

        load: () => getJson('/api/users?status=inactive'),

        match: (user, query) => prefixMatch(userSearchFields(user), query),

        renderRow: (user, index) => `
            <tr class="row-clickable row-reveal" style="animation-delay: ${(index % 10) * 28}ms"
                onclick="openRestoreCard(${user.staff_id})" title="Click to open the restoration card">
                <td class="cell-id">#${escapeHtml(user.staff_id)}</td>
                <td class="cell-name">${escapeHtml(staffName(user))}</td>
                <td>${user.email ? escapeHtml(user.email) : '<span class="muted">No login account</span>'}</td>
                <td>${escapeHtml(user.role_name)}</td>
                <td>${user.archived_at ? escapeHtml(user.archived_at) : '<span class="muted">Not recorded</span>'}</td>
            </tr>`
    });
}

function openRestoreCard(staffId) {
    const panel = getDataPanel('admin-archive');
    selectedArchived = panel ? panel.find(staffId, 'staff_id') : null;
    if (!selectedArchived) return;

    const user = selectedArchived;
    const name = staffName(user);

    document.getElementById('restore-name').textContent = name;
    document.getElementById('restore-role').textContent = user.role_name;
    document.getElementById('restore-avatar').textContent =
        (user.first_name[0] + user.last_name[0]).toUpperCase();

    document.getElementById('restore-details').innerHTML =
        detailRow('Staff ID', '#' + escapeHtml(user.staff_id)) +
        detailRow('Username', user.email
            ? escapeHtml(user.email)
            : '<span class="muted">No login account</span>') +
        detailRow('Role', escapeHtml(user.role_name)) +
        detailRow('Phone', user.phone
            ? '<span class="mono">' + escapeHtml(phoneForDisplay(user.phone)) + '</span>'
            : '<span class="muted">Not set</span>') +
        detailRow('Date Archived', user.archived_at
            ? escapeHtml(user.archived_at)
            : '<span class="muted">Not recorded</span>') +
        detailRow('Archived By', user.archived_by
            ? escapeHtml(user.archived_by)
            : '<span class="muted">Not recorded</span>') +
        detailRow('Hired On', escapeHtml(user.staff_created_at)) +
        detailRow('Last Login', user.last_login
            ? escapeHtml(user.last_login)
            : '<span class="muted">Never signed in</span>') +
        detailRow('Password State', user.must_change_password
            ? '<span class="badge badge-warning">Temporary</span>'
            : '<span class="badge badge-neutral">Set by user</span>');

    // an account with no login cannot sign in whatever its state
    const warning = document.getElementById('restore-warning');
    warning.textContent = user.email
        ? 'Restoring puts this account back on the active list. ' + name +
          ' can sign in again straight away with the password they had before.'
        : 'Restoring puts this staff record back on the active list. ' + name +
          ' still has no login account, so use Create Login afterwards.';

    showModal('restore-modal');
}

async function restoreSelectedAccount() {
    if (!selectedArchived) return;

    const user = selectedArchived;
    const name = staffName(user);

    const yes = await askConfirm(
        `${name} goes back on the active staff list as a ${user.role_name}.`,
        {
            title: 'Restore this account?',
            eyebrow: 'Archived Accounts',
            confirmLabel: 'Restore the account',
            detail: user.email
                ? ['They can sign in again immediately with their previous password.',
                   'Everything their role can reach becomes available to them again.']
                : ['The staff record becomes active again.',
                   'They still cannot sign in until a login account is created for them.']
        });

    if (!yes) return;

    try {
        const response = await fetch('/api/users/' + user.staff_id + '/status', {
            method: 'PATCH',
            headers: apiHeaders(),
            body: JSON.stringify({ isActive: true })
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(name + ' is on the active list again.', 'Account restored');
        closeModal('restore-modal');
        selectedArchived = null;

        const panel = getDataPanel('admin-archive');
        if (panel) await panel.refresh();
    } catch (error) {
        notifyOffline();
    }
}

// Access control: who holds which level on the connected systems.
//   monitor   read the system's state
//   manage    change how it is set up
//   control   run commands against it
// Manage and control carry monitor with them, here and in the server's
// procedure. Nothing is saved until Save Access reads the changes back.
let selectedAccessUser = null;
let accessSystems = [];          // every registered system, for the matrix rows

function grantSummary(user) {
    if (!user.grants || user.grants.length === 0) {
        return '<span class="muted">Nothing</span>';
    }
    return user.grants.map((grant) =>
        '<span class="access-chip' + (grant.control ? ' has-control' : '') + '" title="' +
            escapeHtml(grant.note || '') + '">' +
            escapeHtml(grant.name) + ' <span class="access-levels">' +
            escapeHtml(accessWords(grant)) + '</span></span>').join(' ');
}

function accessSearchFields(user) {
    const systems = (user.grants || []).flatMap((grant) => [grant.name, grant.key]);
    return userSearchFields(user).concat(systems);
}

function buildAccessPanel() {
    createDataPanel({
        key: 'admin-access',
        tableId: 'access-table',
        columns: 5,
        pagerId: 'access-pager',
        countPillId: 'access-count',
        idField: 'staff_id',
        filters: { holding: 'all', roleId: 'all' },

        gate: {
            title: 'Nobody has been read yet',
            text: 'Press Load Data to see who holds access to which connected system, ' +
                  'or type a name and press Enter. By default nobody below the administrator holds any.',
            button: 'Load Data'
        },

        load: async () => {
            // the systems come with the people
            const [people, systems] = await Promise.all([
                getJson('/api/access/permissions'),
                getJson('/api/systems')
            ]);
            accessSystems = Array.isArray(systems) ? systems : [];
            return people;
        },

        match: (user, query) => prefixMatch(accessSearchFields(user), query),

        filter: (user, filters) => {
            const holds = user.grants && user.grants.length > 0;
            if (filters.holding === 'some' && !holds) return false;
            if (filters.holding === 'none' && holds) return false;
            if (filters.roleId !== 'all' && String(user.role_id) !== String(filters.roleId)) return false;
            return true;
        },

        renderRow: (user, index) => {
            const latest = (user.grants || [])
                .slice().sort((a, b) => String(b.updatedAt || b.grantedAt).localeCompare(String(a.updatedAt || a.grantedAt)))[0];

            return `
            <tr class="row-clickable row-reveal${user.is_active ? '' : ' is-inactive'}"
                style="animation-delay: ${(index % 10) * 28}ms"
                onclick="openAccessCard(${user.staff_id})" title="Click to change what this person may reach">
                <td class="cell-id">#${escapeHtml(user.staff_id)}</td>
                <td class="cell-name">${escapeHtml(staffName(user))}${
                    user.is_active ? '' : ' <span class="badge badge-danger">Inactive</span>'}</td>
                <td>${escapeHtml(user.role_name)}</td>
                <td>${grantSummary(user)}</td>
                <td>${latest
                    ? escapeHtml(latest.grantedBy || 'Not recorded') +
                      ' <span class="muted">' + escapeHtml(whenText(latest.updatedAt || latest.grantedAt)) + '</span>'
                    : '<span class="muted">&mdash;</span>'}</td>
            </tr>`;
        }
    });
}

// ---------- the matrix ----------
function openAccessCard(staffId) {
    const panel = getDataPanel('admin-access');
    selectedAccessUser = panel ? panel.find(staffId, 'staff_id') : null;
    if (!selectedAccessUser) return;

    const user = selectedAccessUser;
    document.getElementById('access-name').textContent = staffName(user);
    document.getElementById('access-role-line').textContent =
        user.role_name + (user.email ? ' · ' + user.email : '');
    document.getElementById('access-avatar').textContent =
        (user.first_name[0] + user.last_name[0]).toUpperCase();

    // the server refuses a grant to somebody who cannot sign in
    const note = document.getElementById('access-inactive-note');
    if (!user.is_active) {
        note.style.display = 'block';
        note.textContent = 'This account is deactivated. Access already held can be taken away, ' +
            'but nothing new can be granted until the account is restored.';
    } else {
        note.style.display = 'none';
    }

    const held = new Map((user.grants || []).map((grant) => [grant.key, grant]));

    const tbody = document.querySelector('#access-matrix tbody');
    tbody.innerHTML = accessSystems.map((system) => {
        const grant = held.get(system.key) || { monitor: false, manage: false, control: false, note: '' };
        const box = (level) =>
            '<td class="cell-check"><input type="checkbox" class="access-box" data-system="' +
                escapeHtml(system.key) + '" data-level="' + level + '"' +
                (grant[level] ? ' checked' : '') +
                (!user.is_active && !grant[level] ? ' disabled' : '') +
                ' aria-label="' + level + ' ' + escapeHtml(system.name) + '"' +
                ' onchange="onAccessBoxChange(this)"></td>';

        return '<tr data-system-row="' + escapeHtml(system.key) + '">' +
            '<td><strong>' + escapeHtml(system.name) + '</strong>' +
                '<span class="access-system-meta">' + escapeHtml(system.kind) +
                (system.enabled ? '' : ' · switched off') + '</span></td>' +
            box('monitor') + box('manage') + box('control') +
            '<td><input type="text" class="form-control access-note" maxlength="255" ' +
                'data-system="' + escapeHtml(system.key) + '" ' +
                'value="' + escapeHtml(grant.note || '') + '" placeholder="Why this person needs it" ' +
                (!user.is_active ? 'disabled ' : '') + 'oninput="syncAccessSaveButton()"></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5" class="table-empty">No connected systems are registered.</td></tr>';

    tbody.dataset.baseline = readAccessMatrix();
    syncAccessSaveButton();
    showModal('access-modal');
}

function readAccessMatrix() {
    const rows = {};
    document.querySelectorAll('#access-matrix tbody tr[data-system-row]').forEach((row) => {
        const key = row.dataset.systemRow;
        const levels = {};
        row.querySelectorAll('.access-box').forEach((box) => { levels[box.dataset.level] = box.checked; });
        const note = row.querySelector('.access-note');
        rows[key] = { monitor: levels.monitor, manage: levels.manage, control: levels.control,
                      note: note ? note.value.trim() : '' };
    });
    return JSON.stringify(rows);
}

function onAccessBoxChange(box) {
    const row = box.closest('tr');
    const boxes = {};
    row.querySelectorAll('.access-box').forEach((item) => { boxes[item.dataset.level] = item; });

    if (box.dataset.level === 'monitor' && !box.checked) {
        boxes.manage.checked = false;
        boxes.control.checked = false;
    } else if (box.dataset.level !== 'monitor' && box.checked) {
        boxes.monitor.checked = true;
    }

    syncAccessSaveButton();
}

function accessMatrixChanges() {
    const tbody = document.querySelector('#access-matrix tbody');
    const before = JSON.parse(tbody.dataset.baseline || '{}');
    const after = JSON.parse(readAccessMatrix());

    return Object.keys(after).filter((key) => {
        const was = before[key] || {};
        const now = after[key];
        const levelsMoved = ['monitor', 'manage', 'control'].some((level) => Boolean(was[level]) !== Boolean(now[level]));
        const noteMoved = (now.monitor || was.monitor) && (was.note || '') !== (now.note || '');
        return levelsMoved || noteMoved;
    }).map((key) => ({ key: key, before: before[key] || {}, after: after[key] }));
}

function syncAccessSaveButton() {
    const button = document.getElementById('access-save-btn');
    if (!button) return;
    const changes = accessMatrixChanges();
    button.disabled = changes.length === 0;
    button.title = changes.length === 0 ? 'Nothing has changed yet' : '';
}

// Saving is read back first: one line per system that moved, crimson when
// control is being handed out.
async function saveAccessMatrix() {
    if (!selectedAccessUser) return;

    const changes = accessMatrixChanges();
    if (changes.length === 0) {
        notifyInfo('Nothing on this card has been changed, so there is nothing to save.', 'No changes');
        return;
    }

    const name = staffName(selectedAccessUser);
    const grantsControl = changes.some((change) => change.after.control && !change.before.control);

    const lines = changes.map((change) => {
        const system = accessSystems.find((item) => item.key === change.key);
        const label = system ? system.name : change.key;
        if (!change.after.monitor) return label + ': all access taken away';
        return label + ': ' + accessWords(change.after) +
            (change.after.note ? ' — ' + change.after.note : '');
    });

    const ask = grantsControl ? askDanger : askConfirm;
    const yes = await ask(
        `${name} will hold the access below. Each line is written to the audit trail in your name.`,
        {
            title: grantsControl ? 'Grant control of a system?' : 'Change this access?',
            eyebrow: 'Access Control',
            confirmLabel: 'Save access',
            detail: lines.concat(grantsControl
                ? ['Control runs commands against the system: taking a backup, pausing it, sending a message. Grant it to somebody you would let at the server.']
                : [])
        });

    if (!yes) return;

    const button = document.getElementById('access-save-btn');
    if (button) { button.disabled = true; button.textContent = 'Saving...'; }

    let saved = 0;
    let stopped = false;

    // one request per system, in order; the first refusal stops the rest
    for (const change of changes) {
        try {
            const response = await fetch('/api/access/users/' + selectedAccessUser.staff_id +
                '/systems/' + encodeURIComponent(change.key), {
                method: 'PUT', headers: apiHeaders(),
                body: JSON.stringify({
                    monitor: change.after.monitor, manage: change.after.manage,
                    control: change.after.control, note: change.after.note
                })
            });
            const body = await response.json();

            if (!response.ok) {
                if (!handleAuthFailure(response, body)) notifyError(body.error, 'Access not saved');
                stopped = true;
                break;
            }
            saved += 1;
        } catch (error) {
            notifyOffline();
            stopped = true;
            break;
        }
    }

    if (button) { button.textContent = 'Save Access'; }

    if (saved > 0) {
        notifySuccess(`${saved} ${saved === 1 ? 'change' : 'changes'} to what ${name} may reach ` +
            (stopped ? 'were saved before one was refused.' : 'saved and written to the audit trail.'),
            stopped ? 'Partly saved' : 'Access saved');
    }

    closeModal('access-modal');

    const panel = getDataPanel('admin-access');
    if (panel) await panel.refresh();
}

// Screens by role: one row per screen, one column per role, each cell a
// switch. A screen a role's page cannot draw is a dash. Same baseline and
// read-back-first flow as the access card.
let featureMatrix = null;       // what /api/features last answered

function featureCellState(cell) {
    if (!cell.available) return 'unavailable';
    if (cell.held === cell.byDefault) return 'default';
    return cell.held ? 'granted' : 'revoked';
}

// the word under a switch: on or off first, then by role or by the administrator
function featureStateWord(state, on) {
    if (state === 'unavailable') return '\u2014';
    if (state === 'default') return on ? 'on by default' : 'off by default';
    return on ? 'switched on' : 'switched off';
}

// "on" that agrees with the default is by role; otherwise a grant or a revocation
function featureStateOf(byDefault, on) {
    if (on === byDefault) return 'default';
    return on ? 'granted' : 'revoked';
}

async function loadFeatureMatrix() {
    const tbody = document.querySelector('#features-matrix tbody');
    if (!tbody) return;

    setPill('features-count', 'Loading');

    try {
        featureMatrix = await getJson('/api/features');
    } catch (error) {
        setPill('features-count', 'Not loaded');
        tbody.innerHTML = '<tr><td class="table-empty">Cannot read the screens. Is the server running?</td></tr>';
        return;
    }

    renderFeatureMatrix();
}

function renderFeatureMatrix() {
    const table = document.getElementById('features-matrix');
    if (!table || !featureMatrix) return;

    const roles = featureMatrix.roles || [];
    const features = featureMatrix.features || [];

    table.querySelector('thead').innerHTML = '<tr><th>Screen</th>' +
        roles.map((role) => '<th class="col-role">' + escapeHtml(role.role_name) + '</th>').join('') + '</tr>';

    const modules = [];
    features.forEach((feature) => { if (!modules.includes(feature.module)) modules.push(feature.module); });

    const tbody = table.querySelector('tbody');
    tbody.innerHTML = modules.map((module) =>
        '<tr class="feature-module-row"><th colspan="' + (roles.length + 1) + '">' + escapeHtml(module) + '</th></tr>' +
        features.filter((feature) => feature.module === module).map((feature) =>
            '<tr data-feature-row="' + escapeHtml(feature.key) + '">' +
                '<td class="feature-name"><strong>' + escapeHtml(feature.name) + '</strong>' +
                    '<span class="feature-desc">' + escapeHtml(feature.description || '') + '</span></td>' +
                roles.map((role) => {
                    const cell = feature.roles[role.role_name] || { available: false };
                    const state = featureCellState(cell);
                    if (!cell.available) {
                        return '<td class="feature-cell is-unavailable" title="The ' + escapeHtml(role.role_name) +
                            ' dashboard has no ' + escapeHtml(feature.name) + ' screen">' +
                            '<span class="feature-state is-unavailable">—</span></td>';
                    }
                    const who = cell.overridden && cell.grantedBy
                        ? ' title="' + escapeHtml((cell.held ? 'Granted' : 'Switched off') + ' by ' + cell.grantedBy +
                              (cell.updatedAt ? ' ' + whenText(cell.updatedAt) : '')) + '"' : '';
                    return '<td class="feature-cell"' + who + '>' +
                        '<label class="feature-toggle">' +
                            '<input type="checkbox" class="feature-box" data-feature="' + escapeHtml(feature.key) + '"' +
                                ' data-role="' + escapeHtml(String(role.role_id)) + '"' +
                                ' data-role-name="' + escapeHtml(role.role_name) + '"' +
                                ' data-default="' + (cell.byDefault ? '1' : '') + '"' +
                                (cell.held ? ' checked' : '') +
                                ' aria-label="' + escapeHtml(feature.name + ' for ' + role.role_name) + '"' +
                                ' onchange="onFeatureBoxChange(this)">' +
                            '<span class="feature-switch" aria-hidden="true"></span>' +
                            '<span class="feature-state is-' + state + '">' + featureStateWord(state, cell.held) + '</span>' +
                        '</label></td>';
                }).join('') +
            '</tr>').join('')
    ).join('');

    tbody.dataset.baseline = readFeatureMatrix();

    const overrides = features.reduce((sum, feature) =>
        sum + roles.filter((role) => (feature.roles[role.role_name] || {}).overridden).length, 0);
    setPill('features-count', features.length + ' screens' +
        (overrides > 0 ? ', ' + overrides + ' changed from the pages' : ', as the pages have them'));

    syncFeatureSaveButton();
}

function readFeatureMatrix() {
    const cells = {};
    document.querySelectorAll('#features-matrix .feature-box').forEach((box) => {
        cells[box.dataset.feature + '|' + box.dataset.role] = box.checked;
    });
    return JSON.stringify(cells);
}

function onFeatureBoxChange(box) {
    const state = featureStateOf(Boolean(box.dataset.default), box.checked);
    const word = box.parentElement.querySelector('.feature-state');
    if (word) {
        word.className = 'feature-state is-' + state;
        word.textContent = featureStateWord(state, box.checked);
    }
    syncFeatureSaveButton();
}

function featureMatrixChanges() {
    const tbody = document.querySelector('#features-matrix tbody');
    if (!tbody || !tbody.dataset.baseline) return [];

    const before = JSON.parse(tbody.dataset.baseline || '{}');
    const changes = [];

    document.querySelectorAll('#features-matrix .feature-box').forEach((box) => {
        const id = box.dataset.feature + '|' + box.dataset.role;
        if (before[id] === box.checked) return;

        const feature = (featureMatrix.features || []).find((f) => f.key === box.dataset.feature);
        changes.push({
            key: box.dataset.feature,
            name: feature ? feature.name : box.dataset.feature,
            roleId: Number(box.dataset.role),
            roleName: box.dataset.roleName,
            byDefault: Boolean(box.dataset.default),
            granted: box.checked
        });
    });

    return changes;
}

function syncFeatureSaveButton() {
    const button = document.getElementById('features-save-btn');
    if (!button) return;
    const changes = featureMatrixChanges();
    button.disabled = changes.length === 0;
    button.title = changes.length === 0 ? 'Nothing has changed yet' : '';
}

// Read back first; crimson when anything is being taken away.
async function saveFeatureMatrix() {
    const changes = featureMatrixChanges();
    if (changes.length === 0) {
        notifyInfo('Nothing on this screen has been changed, so there is nothing to save.', 'No changes');
        return;
    }

    const takesAway = changes.some((change) => !change.granted);
    const lines = changes.map((change) =>
        change.roleName + ': ' + change.name + (change.granted
            ? (change.byDefault ? ' switched back on' : ' switched on')
            : (change.byDefault ? ' switched off' : ' taken back off')));

    const ask = takesAway ? askDanger : askConfirm;
    const yes = await ask(
        'Every signed-in screen of these roles follows at once. Each line is written to the audit trail in your name.',
        {
            title: takesAway ? 'Switch screens off for a role?' : 'Change the screens by role?',
            eyebrow: 'Screens by Role',
            confirmLabel: 'Save screens',
            detail: lines.concat(takesAway
                ? ['Somebody may be on one of these screens now. Their page goes back to its first screen and says why.']
                : [])
        });

    if (!yes) return;

    const button = document.getElementById('features-save-btn');
    if (button) { button.disabled = true; button.textContent = 'Saving...'; }

    let saved = 0;
    let stopped = false;

    for (const change of changes) {
        try {
            const response = await fetch('/api/features/' + encodeURIComponent(change.key) +
                '/roles/' + change.roleId, {
                method: 'PUT', headers: apiHeaders(),
                body: JSON.stringify({ granted: change.granted })
            });
            const body = await response.json();

            if (!response.ok) {
                if (!handleAuthFailure(response, body)) notifyError(body.error, 'Screens not saved');
                stopped = true;
                break;
            }
            saved += 1;
        } catch (error) {
            notifyOffline();
            stopped = true;
            break;
        }
    }

    if (button) { button.textContent = 'Save Screens'; }

    if (saved > 0) {
        notifySuccess(saved + ' ' + (saved === 1 ? 'change' : 'changes') + ' to the screens by role ' +
            (stopped ? 'were saved before one was refused.' : 'saved and written to the audit trail.'),
            stopped ? 'Partly saved' : 'Screens saved');
    }

    await loadFeatureMatrix();
}

// The audit trail. The row carries time, person, role, machine and kind;
// the entry itself carries the before-and-after values.
const AUDIT_TONE = {
    CREATE: 'badge-success',
    UPDATE: 'badge-neutral',
    DELETE: 'badge-danger',
    VOID: 'badge-danger',
    LOGIN_FAILURE: 'badge-danger',
    RESTORE: 'badge-warning',
    BACKUP: 'badge-warning',
    SECURITY: 'badge-warning',
    PAYMENT: 'badge-success',
    ACCESS: 'badge-warning',
    CONTROL: 'badge-warning',
    LOGIN: 'badge-neutral',
    LOGOUT: 'badge-neutral',
    OTHER: 'badge-neutral'
};

const AUDIT_LABEL = {
    CREATE: 'Create',
    UPDATE: 'Update',
    DELETE: 'Delete',
    VOID: 'Void',
    RESTORE: 'Restore',
    BACKUP: 'Backup',
    LOGIN: 'Sign in',
    LOGOUT: 'Sign out',
    LOGIN_FAILURE: 'Failed sign-in',
    SECURITY: 'Security',
    PAYMENT: 'Payment',
    ACCESS: 'Access',
    CONTROL: 'System command',
    OTHER: 'Other'
};

function auditLogQuery() {
    const parts = [];

    const type = document.getElementById('logs-type');
    if (type && type.value !== 'all') parts.push('actionType=' + encodeURIComponent(type.value));

    const from = document.getElementById('logs-from');
    if (from && from.value) parts.push('from=' + encodeURIComponent(from.value));

    const to = document.getElementById('logs-to');
    if (to && to.value) parts.push('to=' + encodeURIComponent(to.value));

    return parts.length ? '?' + parts.join('&') : '';
}

// the type box and the two date boxes narrow the query itself
async function refreshAuditLogs() {
    syncLogColumns();

    const panel = getDataPanel('admin-logs');
    if (panel) await panel.open();
}

function buildLogsPanel() {
    createDataPanel({
        key: 'admin-logs',
        tableId: 'logs-table',
        columns: 6,
        pagerId: 'logs-pager',
        countPillId: 'logs-count',
        idField: 'log_id',

        gate: {
            title: 'The audit trail is not loaded',
            text: 'Pick a date range or an action type, then press Load Data. ' +
                  'Nothing is read from the trail until you ask for it.',
            button: 'Load Data'
        },

        load: () => getJson('/api/audit-logs' + auditLogQuery()),

        match: (log, query) => prefixMatch([
            log.staff_name, log.role_name, log.action, log.details, log.ip_address
        ], query),

        renderRow: (log, index) => {
            const tone = AUDIT_TONE[log.action_type] || 'badge-neutral';
            const label = AUDIT_LABEL[log.action_type] || log.action_type;

            return `
            <tr class="row-clickable row-reveal" style="animation-delay: ${(index % 10) * 28}ms"
                onclick="openLogEntry(${log.log_id})" title="Click to read the full entry">
                <td class="cell-id">${escapeHtml(log.created_at)}</td>
                <td class="cell-name">${escapeHtml(log.staff_name)}${
                    log.staff_id ? ' <span class="muted">#' + escapeHtml(log.staff_id) + '</span>' : ''}</td>
                <td>${escapeHtml(log.role_name)}</td>
                <td class="cell-id">${log.ip_address ? escapeHtml(log.ip_address) : '<span class="muted">Not recorded</span>'}</td>
                <td><span class="badge ${tone}">${escapeHtml(label)}</span></td>
                <td>${escapeHtml(log.details || log.action)}</td>
            </tr>`;
        }
    });
}

// metadata that will not parse is shown as it stands
function renderAuditMetadata(raw) {
    if (!raw) {
        return '<p class="detail-note">This entry recorded no field-level changes.</p>';
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        return '<p class="detail-note">Metadata, unreadable, shown exactly as recorded</p>' +
               '<pre class="audit-json">' + escapeHtml(raw) + '</pre>';
    }

    const changes = data && data.changes;

    if (changes && typeof changes === 'object' && !changes.unchanged) {
        const empty = '<span class="muted">empty</span>';

        const rows = Object.keys(changes).map((field) => {
            const change = changes[field] || {};
            const before = (change.before === null || change.before === undefined || change.before === '')
                ? empty : escapeHtml(change.before);
            const after = (change.after === null || change.after === undefined || change.after === '')
                ? empty : escapeHtml(change.after);
            return [prettyLabel(field), before, after];
        });

        if (rows.length > 0) {
            return '<p class="detail-note">What changed</p>' +
                   detailTable(['Field', 'Before', 'After'], rows) +
                   '<p class="detail-note">Recorded metadata</p>' +
                   '<pre class="audit-json">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
        }
    }

    return '<p class="detail-note">Recorded metadata</p>' +
           '<pre class="audit-json">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
}

function openLogEntry(logId) {
    const panel = getDataPanel('admin-logs');
    const log = panel ? panel.find(logId, 'log_id') : null;
    if (!log) return;

    const label = AUDIT_LABEL[log.action_type] || log.action_type;
    const tone = AUDIT_TONE[log.action_type] || 'badge-neutral';

    document.getElementById('log-action').textContent = prettyLabel(log.action);
    document.getElementById('log-when').textContent = whenText(log.created_at);
    document.getElementById('log-avatar').textContent = label.slice(0, 2).toUpperCase();

    document.getElementById('log-details').innerHTML =
        detailRow('Entry', '#' + escapeHtml(log.log_id)) +
        detailRow('Timestamp', escapeHtml(log.created_at)) +
        detailRow('User', escapeHtml(log.staff_name)) +
        detailRow('User ID', log.staff_id
            ? '#' + escapeHtml(log.staff_id)
            : '<span class="muted">Not a signed-in action</span>') +
        detailRow('Role', escapeHtml(log.role_name)) +
        detailRow('IP Address', log.ip_address
            ? '<span class="mono">' + escapeHtml(log.ip_address) + '</span>'
            : '<span class="muted">Not recorded</span>') +
        detailRow('Action', escapeHtml(log.action)) +
        detailRow('Action Type', '<span class="badge ' + tone + '">' + escapeHtml(label) + '</span>') +
        detailRow('Detail', escapeHtml(log.details || 'None recorded'));

    document.getElementById('log-metadata').innerHTML = renderAuditMetadata(log.metadata);

    showModal('log-modal');
}

// Backup & recovery. A backup is one .sql file of the whole system, written
// into backups/ under the date and time. Actions open in a drawer with the
// one backup they belong to.
let selectedBackup = null;

function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
}

function backupTakenAt(fileName) {
    const parts = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(fileName);
    if (!parts) return { day: fileName, time: '' };

    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    const day = date.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' });
    return { day: day, time: `${parts[4]}:${parts[5]}` };
}

// Every fact on this card comes from the server, so a dead timer cannot keep
// reading "backing up every minute". A failure is said in plain words.
function renderAutoBackupCard(auto, procedures) {
    const card = document.getElementById('auto-backup-card');
    const state = document.getElementById('auto-backup-state');
    const text = document.getElementById('auto-backup-text');
    if (!card || !state || !text) return;

    if (!auto) {
        card.className = 'card auto-backup';
        state.textContent = 'Unknown';
        text.textContent = 'This server did not say whether it backs itself up.';
        return;
    }

    // missing stored procedures outrank anything this card would say about backups
    if (procedures && procedures.loaded < procedures.expected) {
        card.className = 'card auto-backup is-bad';
        state.textContent = 'Read this';
        text.textContent = `This database has ${procedures.loaded} of ` +
            `${procedures.expected} stored procedures, so nothing can be saved — not an ` +
            `account, not a sale, not a stock change. Run ` +
            `public/database/2-RUN-SECOND-stored-procedures.sql in MySQL Workbench or the ` +
            `mysql command line, then reload this page. It touches no table and no row, and ` +
            `your data is intact. Backups are still being written every minute meanwhile, ` +
            `and nothing older is being deleted, so the backups that still have the ` +
            `procedures in them are safe.`;
        return;
    }

    if (!auto.enabled) {
        card.className = 'card auto-backup is-off';
        state.textContent = 'Off';
        text.textContent = 'Nothing is backed up on its own. Every backup on this system is one ' +
            'somebody pressed the button for. Switch it on with AUTO_BACKUP_ENABLED in server.js.';
        return;
    }

    const every = auto.everySeconds === 60
        ? 'every minute'
        : `every ${auto.everySeconds} seconds`;
    const window = Math.round((auto.keep * auto.everySeconds) / 60);

    // paused on purpose by somebody holding control: said in amber
    if (auto.paused) {
        card.className = 'card auto-backup is-paused';
        state.textContent = 'Paused';
        text.textContent = `The automatic backup is paused` +
            (auto.pausedBy ? ` by ${auto.pausedBy}` : '') +
            (auto.pausedAt ? ` since ${whenText(auto.pausedAt)}` : '') +
            `. Nothing is written until it is resumed from Connected Systems. ` +
            (auto.lastFileName ? `The last one taken was ${auto.lastFileName}.` : 'None has been taken since this server started.');
        return;
    }

    if (auto.lastError) {
        card.className = 'card auto-backup is-bad';
        state.textContent = 'Failing';
        text.textContent = `The automatic backup has failed ${auto.failures} ` +
            `time${auto.failures === 1 ? '' : 's'} in a row and the most recent reason was: ` +
            `${auto.lastError}. It is still trying ${every}. ` +
            (auto.lastFileName
                ? `The last one that worked was ${auto.lastFileName}.`
                : 'None has worked since this server started.') +
            ' Take one by hand until this is fixed.';
        return;
    }

    card.className = 'card auto-backup is-on';
    state.textContent = 'On';
    text.textContent = `The whole system is written to its own .sql file ${every}, so at most ` +
        `${auto.everySeconds === 60 ? 'a minute' : auto.everySeconds + ' seconds'} of work can be ` +
        `lost. The last ${auto.keep} are kept — about ${window} minutes — and writing a new one ` +
        `removes the oldest, which is what stops the folder growing without limit. ` +
        (auto.lastFileName
            ? `The most recent is ${auto.lastFileName}.`
            : 'The first one is on its way.');
}

// reads the state without opening the table; the folder listing comes with it
async function loadAutoBackupState() {
    try {
        const body = await getJson('/api/backups');
        renderAutoBackupCard(body.auto, body.procedures);

        const path = document.getElementById('backup-folder');
        if (path) path.textContent = body.folder;
    } catch (error) {
        renderAutoBackupCard(null);
    }
}

function buildBackupPanel() {
    createDataPanel({
        key: 'admin-backups',
        tableId: 'backup-table',
        columns: 5,
        pagerId: 'backup-pager',
        countPillId: 'backup-count',
        idField: 'fileName',

        gate: {
            title: 'The backup folder has not been read',
            text: 'Press Load Data to list every backup this system has, automatic and by hand.',
            button: 'Load Data'
        },

        load: async () => {
            const body = await getJson('/api/backups');
            const files = body.files || [];

            renderAutoBackupCard(body.auto, body.procedures);

            const path = document.getElementById('backup-folder');
            if (path) path.textContent = body.folder;

            const latest = document.getElementById('backup-latest');
            if (latest) {
                if (files.length === 0) {
                    latest.textContent = 'None yet';
                } else {
                    const when = backupTakenAt(files[0].fileName);
                    latest.textContent = `${when.day}, ${when.time}`;
                }
            }

            const total = document.getElementById('backup-total');
            if (total) {
                total.textContent = formatBytes(
                    files.reduce((sum, file) => sum + Number(file.bytes || 0), 0));
            }

            return files;
        },

        match: (file, query) => prefixMatch([file.fileName], query),

        renderRow: (file, index) => {
            const when = backupTakenAt(file.fileName);

            // an automatic backup is on a rolling hour; one taken by hand stays
            const kind = file.automatic
                ? '<span class="badge badge-neutral">Automatic</span>'
                : '<span class="badge badge-success">Kept</span>';

            // the name goes through a handler so it can never close the quote it sits in
            return '<tr class="row-clickable row-reveal" style="animation-delay:' +
                    (index % 10) * 28 + 'ms" ' +
                    'onclick="openBackupDrawer(' + index + ')" ' +
                    'title="Click to download, restore or delete this backup">' +
                '<td><span class="backup-day">' + escapeHtml(when.day) + '</span></td>' +
                '<td><span class="backup-time">' + escapeHtml(when.time) + '</span></td>' +
                '<td class="cell-id">' + escapeHtml(file.fileName) + '</td>' +
                '<td>' + kind + '</td>' +
                '<td class="cell-num">' + escapeHtml(formatBytes(file.bytes)) + '</td>' +
                '</tr>';
        }
    });
}

function openBackupDrawer(index) {
    const panel = getDataPanel('admin-backups');
    selectedBackup = panel ? panel.visible[index] : null;
    if (!selectedBackup) return;

    const when = backupTakenAt(selectedBackup.fileName);

    document.getElementById('backup-drawer-title').textContent = selectedBackup.fileName;
    document.getElementById('backup-drawer-details').innerHTML =
        detailRow('Taken On', escapeHtml(when.day)) +
        detailRow('Taken At', escapeHtml(when.time)) +
        detailRow('File Name', '<span class="mono">' + escapeHtml(selectedBackup.fileName) + '</span>') +
        detailRow('Size', escapeHtml(formatBytes(selectedBackup.bytes))) +
        detailRow('Kind', selectedBackup.automatic
            ? 'Automatic &mdash; <span class="muted">on a rolling window, so this file will be ' +
              'removed as newer ones are written. Download it if you want to keep it.</span>'
            : 'Taken by hand &mdash; <span class="muted">kept until somebody deletes it.</span>');

    document.getElementById('backup-drawer').classList.add('open');
    document.getElementById('backup-shade').classList.add('open');
}

function closeBackupDrawer() {
    const drawer = document.getElementById('backup-drawer');
    const shade = document.getElementById('backup-shade');
    if (drawer) drawer.classList.remove('open');
    if (shade) shade.classList.remove('open');
    selectedBackup = null;
}

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeBackupDrawer();
});

async function runBackup() {
    const yes = await askConfirm(
        'A new .sql file is written into the backups folder, holding the system exactly as it stands now.',
        {
            title: 'Run a backup now?',
            eyebrow: 'Backup',
            confirmLabel: 'Run the backup',
            detail: [
                'Nothing currently in the system is changed or removed.',
                'A large database takes a few seconds to write.'
            ]
        });

    if (!yes) return;

    const button = document.getElementById('run-backup-btn');
    if (button) { button.disabled = true; button.textContent = 'Saving...'; }

    notifyInfo('Writing every table, view and procedure to a new .sql file.', 'Backup running');

    try {
        const response = await fetch('/api/backups', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({})
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Backup failed');
            return;
        }

        notifySuccess(
            `${body.fileName} holds ${body.rowCount} rows across ${body.tableCount} tables, ` +
            `${body.viewCount} views and ${body.procedureCount} procedures (${formatBytes(body.bytes)}).`,
            'Backup saved');

        const panel = getDataPanel('admin-backups');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Run Backup Now'; }
    }
}

function downloadSelectedBackup() {
    if (!selectedBackup) return;

    window.location.href = '/api/backups/' + encodeURIComponent(selectedBackup.fileName);
    notifyInfo(selectedBackup.fileName + ' is being saved to your downloads folder.', 'Downloading');
}

async function restoreSelectedBackup() {
    if (!selectedBackup) return;

    const fileName = selectedBackup.fileName;
    const when = backupTakenAt(fileName);

    const yes = await askDanger(
        `Everything in the system will be replaced by the data as it stood on ${when.day} at ${when.time}.`,
        {
            title: 'Restore this backup?',
            eyebrow: 'Recovery',
            confirmLabel: 'Restore this backup',
            detail: [
                'Every sale, delivery and account recorded since then is lost.',
                'Everyone signed in now is signed out.',
                'This cannot be undone. Run a backup first if you are not certain.'
            ]
        });

    if (!yes) return;

    closeBackupDrawer();
    notifyInfo('Rebuilding the database from ' + fileName + '.', 'Restore running');

    try {
        const response = await fetch('/api/backups/' + encodeURIComponent(fileName) + '/restore', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({})
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Restore failed');
            return;
        }

        notifySuccess(body.message, 'Database restored');

        const panel = getDataPanel('admin-backups');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    }
}

async function deleteSelectedBackup() {
    if (!selectedBackup) return;

    const fileName = selectedBackup.fileName;

    const yes = await askDanger(
        fileName + ' is removed from the backup folder.',
        {
            title: 'Delete this backup?',
            eyebrow: 'Recovery',
            confirmLabel: 'Delete this backup',
            detail: [
                'The file is gone for good; it is not moved to a recycle bin.',
                'The data inside the system itself is not touched.'
            ]
        });

    if (!yes) return;

    closeBackupDrawer();

    try {
        const response = await fetch('/api/backups/' + encodeURIComponent(fileName), {
            method: 'DELETE', headers: apiHeaders()
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Nothing was deleted');
            return;
        }

        notifySuccess(body.message, 'Backup deleted');

        const panel = getDataPanel('admin-backups');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    }
}

function chooseRestoreFile() {
    const picker = document.getElementById('restore-file');
    if (picker) picker.click();
}

async function handleRestoreFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    event.target.value = '';

    if (!/\.sql$/i.test(file.name)) {
        notifyWarning('A backup is a .sql file. ' + file.name + ' is not one.', 'Wrong kind of file');
        return;
    }

    const yes = await askDanger(
        `Everything in the system will be replaced by whatever ${file.name} contains.`,
        {
            title: 'Restore from this file?',
            eyebrow: 'Recovery',
            confirmLabel: 'Restore from this file',
            detail: [
                'Anything recorded since that file was made is lost.',
                'This system cannot check what is inside the file before running it.',
                'This cannot be undone.'
            ]
        });

    if (!yes) return;

    notifyInfo('Rebuilding the database from ' + file.name + '.', 'Restore running');

    try {
        const sql = await file.text();
        const response = await fetch('/api/restore', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({ sql: sql })
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Restore failed');
            return;
        }

        notifySuccess(body.message, 'Database restored');

        const panel = getDataPanel('admin-backups');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    }
}


// Receipt maintenance: what every invoice claims about the business. Above
// the 3,000,000 threshold a shop is VAT-registered with 12% inside its
// prices; below it charges no VAT. Each sale carries the registration and
// rate it was issued under, so changing this touches no past sale.
let storeSettings = null;

// A TIN is nine digits and a branch code, 000-000-000-00000 (00000 for the
// head office; an older three-digit branch code is widened with two zeros).
// The box works like the phone box: digits only, dashes put in as typed.
// The same rule is enforced again in server.js.
const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

function tinDigits(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\D/g, '')
        .slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
}

function tinFormat(digits) {
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9)];
    return parts.filter((part) => part !== '').join('-');
}

// oninput on the TIN box; rewrites rather than blocks so paste works
function onTinInput(input) {
    if (!input) return;

    const shaped = tinFormat(tinDigits(input.value));
    if (shaped !== input.value) input.value = shaped;

    // no verdict while empty: the form says so at submit
    input.classList.toggle('is-bad', shaped !== '' && tinComplaint(shaped) !== null);
}

// the sentence said about a bad TIN, or null; returned, not shown
function tinComplaint(value) {
    const digits = tinDigits(value);

    if (digits === '') {
        return 'The shop needs a TIN. It is printed on every invoice.';
    }

    if (digits.length !== TIN_BASE_DIGITS &&
        digits.length !== TIN_BASE_DIGITS + 3 &&
        digits.length !== TIN_BASE_DIGITS + TIN_BRANCH_DIGITS) {
        return `A TIN is ${TIN_BASE_DIGITS} digits and a branch code, ` +
               `written 000-000-000-00000. That one has ${digits.length} digits.`;
    }

    if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
        return '000-000-000 is the placeholder, not a TIN. Enter the number on the ' +
               'shop\'s BIR certificate of registration.';
    }

    return null;
}

// the stored form; a value that does not pass is handed back as it was
function tinToStore(value) {
    const digits = tinDigits(value);
    if (tinComplaint(digits) !== null) return String(value || '').trim();

    const base = digits.slice(0, TIN_BASE_DIGITS);
    const branch = digits.slice(TIN_BASE_DIGITS).padStart(TIN_BRANCH_DIGITS, '0');
    return tinFormat(base + branch);
}

async function loadStoreSettingsForm() {
    const form = document.getElementById('store-form');
    if (!form) return;

    setPill('store-state', 'Loading');

    try {
        storeSettings = await getJson('/api/store-settings');
    } catch (error) {
        setPill('store-state', 'Offline');
        notifyOffline();
        return;
    }

    form.elements.storeName.value = storeSettings.store_name || '';
    form.elements.address.value = storeSettings.address || '';
    form.elements.tin.value = tinToStore(storeSettings.tin || '');
    form.elements.tin.classList.remove('is-bad');
    form.elements.registrationType.value = storeSettings.registration_type || 'VAT';
    form.elements.invoiceNote.value = storeSettings.invoice_note || '';

    // a non-VAT shop stores a zero rate; a useless value to put back in the box
    const rate = Number(storeSettings.vat_rate) || 0;
    form.elements.vatRate.value = rate > 0 ? rate : 12;

    setPill('store-state', (storeSettings.registration_type || 'VAT') === 'VAT'
        ? 'VAT ' + (rate > 0 ? rate.toFixed(0) : '12') + '%'
        : 'Non-VAT');

    onRegistrationChange(form.elements.registrationType.value);

    showStoreVerdict('');
    markFormClean(form, document.getElementById('store-save-btn'));
}

// the rate box only means anything to a VAT-registered shop
function onRegistrationChange(value) {
    const field = document.getElementById('store-rate-field');
    if (field) field.style.display = value === 'VAT' ? 'block' : 'none';
    renderStorePreview();
}

function showStoreVerdict(text) {
    const box = document.getElementById('store-verdict');
    if (!box) return;
    box.className = text ? 'store-verdict is-stop' : 'store-verdict';
    box.textContent = text || '';
}

async function handleSaveStoreSettings(event) {
    event.preventDefault();
    const form = event.target;
    const registration = form.elements.registrationType.value;

    if (!isFormDirty(form)) {
        notifyInfo('Nothing on this form has been changed, so there is nothing to save.', 'No changes');
        return;
    }

    const tinProblem = tinComplaint(form.elements.tin.value);
    if (tinProblem) {
        showStoreVerdict(tinProblem);
        form.elements.tin.classList.add('is-bad');
        form.elements.tin.focus();
        return;
    }

    // switching registration changes what every future invoice claims
    if (storeSettings && storeSettings.registration_type !== registration) {
        const yes = await askConfirm(
            'This shop is recorded as ' + storeSettings.registration_type +
            ' and you are changing it to ' + registration + '.',
            {
                title: 'Change the tax registration?',
                eyebrow: 'Receipt Maintenance',
                confirmLabel: 'Change it',
                tone: 'danger',
                detail: [
                    registration === 'VAT'
                        ? 'Invoices from now on will show a VAT breakdown and read VAT REG TIN.'
                        : 'Invoices from now on will show no VAT at all and read NON-VAT REG TIN.',
                    'Sales already rung up keep the registration they were issued under.',
                    'Get this wrong and the shop is either charging a tax it cannot remit or failing to declare one.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await fetch('/api/store-settings', {
            method: 'PUT',
            headers: apiHeaders(),
            body: JSON.stringify({
                storeName: form.elements.storeName.value.trim(),
                address: form.elements.address.value.trim(),
                tin: tinToStore(form.elements.tin.value),
                registrationType: registration,
                vatRate: registration === 'VAT' ? parseFloat(form.elements.vatRate.value) : 0,
                invoiceNote: form.elements.invoiceNote.value.trim()
            })
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) showStoreVerdict(result.error);
            return;
        }

        showStoreVerdict('');

        notifySuccess(result.message, 'Store details saved');
        await loadStoreSettingsForm();
    } catch (error) {
        notifyOffline();
    }
}

// a worked example: one thousand pesos split the way these settings would
function renderStorePreview() {
    const box = document.getElementById('store-preview');
    const form = document.getElementById('store-form');
    if (!box || !form) return;

    const registration = form.elements.registrationType.value;
    const rate = registration === 'VAT' ? (parseFloat(form.elements.vatRate.value) || 0) : 0;
    const total = 1000;

    // the same arithmetic the database does: rate extracted from the total, VAT rounded first
    const vat = rate > 0 ? Math.round(total * rate / (100 + rate) * 100) / 100 : 0;
    const vatable = rate > 0 ? total - vat : 0;

    const tax = registration === 'VAT'
        ? '<div><span>VATable Sale</span><span>' + peso(vatable) + '</span></div>' +
          '<div><span>VAT (' + rate.toFixed(0) + '%)</span><span>' + peso(vat) + '</span></div>' +
          '<div><span>VAT-Exempt Sale</span><span>' + peso(0) + '</span></div>' +
          '<div><span>Zero-Rated Sale</span><span>' + peso(0) + '</span></div>'
        : '<div><span>Sales Subject to Percentage Tax</span><span>' + peso(total) + '</span></div>' +
          '<div><span>Exempt Sales</span><span>' + peso(0) + '</span></div>';

    const note = form.elements.invoiceNote.value.trim();

    box.innerHTML =
        '<div class="rc-head">' +
        '<span class="rc-shop">' + escapeHtml(form.elements.storeName.value || 'Your Shop Name') + '</span>' +
        '<span class="rc-addr">' + escapeHtml(form.elements.address.value || 'Your business address') + '</span>' +
        '<span class="rc-addr">' + (registration === 'VAT' ? 'VAT REG TIN' : 'NON-VAT REG TIN') +
            ': ' + escapeHtml(form.elements.tin.value || '000-000-000-00000') + '</span>' +
        '<span class="rc-line">Sales Invoice</span>' +
        '<span class="rc-no">OR-000001</span>' +
        '</div>' +
        '<div class="rc-rule"></div>' +
        '<table class="rc-items"><tbody><tr><td>Sample item' +
        '<br><span class="rc-qty">1 pc x ' + peso(total) + '</span></td>' +
        '<td class="rc-amt">' + peso(total) + '</td></tr></tbody></table>' +
        '<div class="rc-rule"></div>' +
        '<div class="rc-totals">' +
        '<div><span>Subtotal</span><span>' + peso(total) + '</span></div>' +
        '<div class="rc-due"><span>Total Due</span><span>' + peso(total) + '</span></div>' +
        '</div>' +
        '<div class="rc-rule"></div>' +
        '<div class="rc-tax">' + tax + '</div>' +
        '<div class="rc-rule"></div>' +
        '<p class="rc-foot">PAID IN FULL</p>' +
        (note ? '<p class="rc-note">' + escapeHtml(note) + '</p>' : '') +
        '<p class="rc-thanks">Thank you for your purchase</p>';
}

// ==========================================
// SYSTEM PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('system.html')) {
    document.addEventListener('DOMContentLoaded', async function () {
        buildUsersPanel();
        buildArchivePanel();
        buildLogsPanel();
        buildBackupPanel();
        buildAccessPanel();

        // the administrator holds every level on all systems
        configureConnectedSystems({ showPanel: (panelId) => showPanel(panelId) });
        buildConnectedSystemsPanel();

        // a switch thrown by another administrator reaches this matrix, unless it has unsaved changes
        if (typeof onLiveChange === 'function') {
            onLiveChange(['features'], function () {
                const panel = document.getElementById('panel-features');
                if (!panel || panel.style.display === 'none') return;
                if (featureMatrixChanges().length > 0) return;
                loadFeatureMatrix();
            });
        }

        showAccountsList();
        adminPageLoaded = true;

        // the preview redraws as the boxes are typed into
        const storeForm = document.getElementById('store-form');
        if (storeForm) storeForm.addEventListener('input', renderStorePreview);

        watchFormEdits(storeForm, document.getElementById('store-save-btn'));
        watchFormEdits(document.getElementById('edit-user-form'),
                       document.getElementById('edit-user-save-btn'));

        // the browser remembers dropdowns across a reload
        syncDirectoryColumns();
        syncLogColumns();

        await loadRoles();
        loadNotifications();
    });
}
