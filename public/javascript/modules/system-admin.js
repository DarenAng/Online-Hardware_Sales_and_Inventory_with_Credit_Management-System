// system-admin.js  --  SYSTEM ADMINISTRATOR
// Loaded by: system.html
// ------------------------------------------------------------------------
// Four screens, four tables, and one rule shared by all of them: a table is
// empty until somebody asks for it, and it never shows more than ten rows at
// a time. The asking and the paging belong to createDataPanel() in
// shared/data-panel.js, so what is left in this file is what is particular to
// administration: what a staff row looks like, what an audit entry means, and
// which of these actions are dangerous enough to ask about first.
// ==========================================

// ==========================================
// PANEL SWITCHING (System page)
// ==========================================
function showPanel(panelId, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    // on phones the sidebar overlays the page, so close it after choosing
    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// Opening a screen no longer fetches anything, which was the point of the
// change: five tables used to query the database the moment this page loaded,
// and four of them belonged to screens nobody had opened.
function showAccountsList(event) {
    showPanel('panel-accounts', event);

    // the default view is not a menu choice, so drop the sidebar highlight
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.remove('active');
    });
}

// ==========================================
// OPENING THE DIRECTORY IS NOT ASKING FOR IT
//
// "List Users" used to open this panel and read the whole staff directory in
// the same move, and so did every one of the three filters above it. That
// left four ways to start a query and only one of them -- the button that
// says Load Data -- was somebody actually asking for one. Opening a screen to
// get to the Create tab, or setting a filter before choosing what to filter,
// both fetched the directory.
//
// Now there are exactly two ways in, and both are a request:
//
//   Load Data   the button, which says what it does
//   the search  typing a name is asking for that name
//
// The filters narrow what has already arrived and no longer fetch anything;
// on a closed table they are remembered and applied to the first load. A
// table that is already open still re-reads when a filter needs the server,
// because that is a filter applied to rows somebody is looking at.
// ==========================================
function showAllUsers(event) {
    showPanel('panel-accounts', event);
}

function showCreateAccount(event) { showPanel('panel-create', event); }
function showArchiveModule(event) { showPanel('panel-archive', event); }
function showAuditLogs(event)     { showPanel('panel-logs', event); }
// The tables on this screen still wait to be asked. The card at the top of it
// does not, because it answers "is this system backing itself up?" and a
// question like that is worthless behind a button: the administrator who has
// to press something to find out the backups have been failing for a week is
// the administrator who finds out in a week's time.
function showMaintenance(event) {
    showPanel('panel-maintenance', event);
    loadAutoBackupState();
}
function showStoreSettings(event) { showPanel('panel-store', event); loadStoreSettingsForm(); }

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

        // the filter keeps its "every role" entry at the top; the forms do not
        document.querySelectorAll('[data-role-filter]').forEach((select) => {
            select.innerHTML = '<option value="all">Every role</option>' + options;
        });
    } catch (error) {
        console.error('Unable to load roles:', error);
    }
}

// ==========================================
// THE STAFF DIRECTORY
//
// Two facts, and they are not the same fact. Active or Inactive is a
// decision an administrator made about the account. Online or Offline is
// whether the person is at a screen right now, which the server answers from
// its own session store. Showing only the first has had people ring a
// colleague who was signed in two desks away; showing only the second would
// hide a deactivated account that happens to be quiet.
//
// They used to share one column. They have one each now, because each has a
// filter of its own above the grid, and a filter takes its column off the
// grid when it is set (see syncDirectoryColumns below): "Active only" should
// remove the word Active from every row without also removing who is online.
// ==========================================
let selectedUser = null;

function accountCell(user) {
    return user.is_active
        ? '<span class="badge badge-success">Active</span>'
        : '<span class="badge badge-danger">Inactive</span>';
}

function presenceCell(user) {
    // somebody with no login account cannot be online, and calling them
    // "Offline" would suggest they could be
    if (!user.user_id) {
        return '<span class="presence"><span class="presence-dot"></span>No login</span>';
    }

    return user.is_online
        ? '<span class="presence is-online"><span class="presence-dot"></span>Online now</span>'
        : '<span class="presence"><span class="presence-dot"></span>Offline</span>';
}

function userHaystack(user) {
    return [
        user.full_name, user.first_name, user.middle_name, user.last_name,
        user.email, user.role_name, '#' + user.staff_id
    ].join(' ').toLowerCase();
}

// The account-state filter is the one that goes back to the server, because
// it is the one that can genuinely halve what has to travel. Role and
// presence are decided here, on rows that have already arrived.
function currentStatusFilter() {
    const select = document.getElementById('accounts-status');
    return select ? select.value : 'all';
}

async function reloadUsers() {
    syncDirectoryColumns();

    const panel = getDataPanel('admin-users');
    if (!panel) return;

    // Account state is the one filter the server applies, so changing it on a
    // table that is already open means re-reading. On a closed table it means
    // nothing at all: the value is sitting in the dropdown and load() reads it
    // from there when somebody does ask.
    if (panel.state === 'ready') await panel.refresh();
}

// the role and presence dropdowns: narrow the rows, then drop the column
function filterDirectory(name, value) {
    dataPanelFilter('admin-users', name, value);
    syncDirectoryColumns();
}

// ==========================================
// A FILTER TAKES ITS COLUMN OFF THE GRID
//
// Set the role filter to Cashier and every row left says Cashier in the Role
// column. The column is repeating the dropdown back to the reader and using
// the width to do it, so while a filter is set, the column it decides is not
// drawn. Clear the filter and the column comes back.
//
// The columns are named by position, 1-based, to match the <th> order in
// system.html: ID, Name, Email, Role, Status, Signed In. The list is kept on
// the table itself and re-applied by tables.js on every redraw, so paging
// and refreshing do not bring a hidden column back.
// ==========================================
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

// The date boxes are left out on purpose: a range still leaves a different
// timestamp on every row, so that column is still saying something.
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

        // the filters here set up a query rather than run one; see
        // dataPanelFilter in shared/data-panel.js
        loadOnFilter: false,

        gate: {
            title: 'The directory is not loaded',
            text: 'Set the filters you want, then press Load Data to read the staff ' +
                  'directory &mdash; or type a name in the search box to look one person up.',
            button: 'Load Data'
        },

        load: () => {
            const status = currentStatusFilter();
            const query = status === 'all' ? '' : '?status=' + encodeURIComponent(status);
            return getJson('/api/users' + query);
        },

        match: (user, query) => userHaystack(user).indexOf(query) !== -1,

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
    form.elements.phone.value = phoneToInput(selectedUser.phone);
    form.elements.email.value = selectedUser.email || '';
    form.elements.roleId.value = selectedUser.role_id;

    // what is in the boxes is what is on the record, so there is nothing to
    // save until one of them is changed
    markFormClean(form, document.getElementById('edit-user-save-btn'));

    const statusButton = document.getElementById('modal-status-btn');
    statusButton.textContent = selectedUser.is_active ? 'Deactivate Account' : 'Activate Account';
    statusButton.className = selectedUser.is_active ? 'btn btn-danger' : 'btn btn-success';

    // staff with no login account get a Create Login button instead of Reset Password
    const hasLogin = Boolean(selectedUser.user_id);
    document.getElementById('modal-login-btn').style.display = hasLogin ? 'none' : 'inline-block';
    document.getElementById('modal-reset-btn').style.display = hasLogin ? 'inline-block' : 'none';

    showUserTab('view');
    showModal('user-modal');
}

function showUserTab(tab) {
    const isEdit = tab === 'edit';
    document.getElementById('modal-user-details').style.display = isEdit ? 'none' : 'grid';
    document.getElementById('modal-user-edit').style.display = isEdit ? 'block' : 'none';
    document.getElementById('modal-view-tab').classList.toggle('active', !isEdit);
    document.getElementById('modal-edit-tab').classList.toggle('active', isEdit);
}

// Returns the server's reply on success and false on any failure, so a
// caller with something more to say than "it worked" -- the first-password
// dialog is the one -- can read what came back. Passing no successMessage
// says that caller will do the talking, and stops the corner card that would
// otherwise appear behind its dialog.
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

        // re-read, but keep whichever page and filters were being looked at
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

    const form = event.target;

    // The button is off until something changes, but a form can still be
    // sent by other routes, and a save of nothing writes an audit entry that
    // says "unchanged" and signs the person out for a role change that did
    // not happen.
    if (!isFormDirty(form)) {
        notifyInfo('Nothing on this form has been changed, so there is nothing to save.', 'No changes');
        return;
    }

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone.value),
        email: form.elements.email.value.trim(),
        roleId: parseInt(form.elements.roleId.value, 10)
    };

    const name = staffName(selectedUser);

    // Changing somebody's role changes what they can see, so it is asked
    // about. Correcting a spelling is not: a dialog on every save is what
    // teaches people to click through dialogs without reading them.
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

    if (!selectedUser.user_id) {
        notifyWarning('This staff member has no login account yet. Use Create Login first.', 'No login to reset');
        return;
    }

    const newPassword = await askInput({
        title: 'Reset this password',
        eyebrow: 'Accounts Management',
        message: `Give ${staffName(selectedUser)} a temporary password. ` +
                 'They will have to choose their own the next time they sign in.',
        label: 'Temporary password',
        type: 'password',
        placeholder: 'At least 8 characters',
        confirmLabel: 'Reset password',
        check: (value) => value.length < 8 ? 'A password needs at least 8 characters.' : null
    });

    if (newPassword === false || newPassword === null) return;

    await sendUserRequest(
        '/api/users/' + selectedUser.staff_id + '/reset-password',
        'POST',
        { newPassword: newPassword },
        'Password reset. The user must change it on next login.'
    );
}

// ==========================================
// SAVE IS OFF UNTIL SOMETHING HAS CHANGED
//
// Both edit forms on this page used to save whatever was in the boxes the
// moment the button was pressed, whether anything had been typed or not. A
// save of nothing is not harmless: the account one writes an audit entry
// reading "unchanged" and signs the person out, because the server cannot
// tell a role that was re-chosen from a role that was changed; the store one
// re-stamps who last touched the shop's registration.
//
// So when a form is filled from the record, what is in it is written down,
// and the Save button stays off until the boxes say something different from
// that. Typing a letter and deleting it again puts the button back off,
// because the form is back to what the record says. Spaces at the ends do
// not count: the server trims them, so they would be a save of nothing too.
// ==========================================
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

// call this after the boxes have been filled from the record
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

// every keystroke and every dropdown change re-decides the button
function watchFormEdits(form, button) {
    if (!form || !button) return;
    const update = () => syncSaveButton(form, button);
    form.addEventListener('input', update);
    form.addEventListener('change', update);
}

// ==========================================
// CANCELLING THE CREATE FORM EMPTIES IT
//
// Cancel used to go back to the directory and leave the half-typed account
// in the boxes, so the next person to open Create found somebody else's
// name, phone number and email waiting to be submitted under a new role.
// Cancelling means "not this account", so the account goes.
// ==========================================
function clearCreateForm() {
    const form = document.getElementById('create-user-form');
    if (!form) return;

    form.reset();

    // reset() puts the values back but not the box's own verdict on them
    const phone = form.elements.phone;
    if (phone) phone.classList.remove('is-bad');
}

function cancelCreateAccount(event) {
    clearCreateForm();
    showAccountsList(event);
}

// ==========================================
// CREATING AN ACCOUNT IS TWO STEPS, AND A PERSON READS THE MIDDLE ONE
//
// The form is filled in and submitted, and nothing is created. The server
// works out the whole account -- including the password, which nobody types
// -- and it comes back to be read: the name as the directory will spell it,
// the role, the number, the address the password is about to be sent to, and
// the password itself. That card is where a typo in an email address gets
// caught, which is the one typo on this form that cannot be corrected
// afterwards, because by then the password has already been sent to it.
//
// Confirming creates the account and sends the password. Cancelling creates
// nothing: there is no half-made account to tidy up, because the first
// request wrote nothing.
//
// The card is a dialog rather than a card in the corner. A corner card is
// for something that has happened; this is a question, it is the last chance
// to stop, and it holds a secret that has to be read before it is dismissed.
// ==========================================
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

// What the administrator is told afterwards. Emailed is a corner card,
// because there is nothing left to do. Not emailed keeps the password on
// screen in a dialog that waits, because it still has to be handed over.
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

    // No password is sent up. The server makes it, shows it for checking, and
    // sends it on confirmation.
    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone.value),
        email: form.elements.email.value.trim(),
        roleId: parseInt(form.elements.roleId.value, 10)
    };

    // said at the form rather than after the review card, because it is the
    // form that has to be corrected
    const phoneProblem = phoneComplaint(form.elements.phone.value);
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

        // the directory is not fetched to show one new row; it is refreshed
        // only if somebody already had it open
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

// ==========================================
// ARCHIVED ACCOUNTS
//
// Restore used to sit on the end of every row. Restoring an account lets a
// person back into the system, and a button that does that from a list where
// every row looks alike is a button that gets pressed on the wrong row. So
// the row opens the person instead, and Restore is one clearly labelled
// action on a card that first says who they are, when they were archived,
// and who archived them.
// ==========================================
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
            text: 'Press Load Data to read the deactivated staff accounts, or search for one by name.',
            button: 'Load Data'
        },

        load: () => getJson('/api/users?status=inactive'),

        match: (user, query) => userHaystack(user).indexOf(query) !== -1,

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

    // an account with no login cannot sign in whatever its state, and the
    // card should say so rather than promise access it cannot give
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

// ==========================================
// THE AUDIT TRAIL
//
// Six columns rather than four, because the four it had could not answer the
// questions an audit is opened for. A row now carries the time, the person,
// the role they held at the time, the machine it came from and the kind of
// action; the entry itself carries the before-and-after values, which is too
// much for a row and exactly right for a card.
// ==========================================
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

// The type box and the two date boxes narrow the query itself, so changing
// one of them means going back to the server rather than hiding rows that are
// already on the screen.
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

        match: (log, query) => [
            log.staff_name, log.role_name, log.action, log.details, log.ip_address
        ].join(' ').toLowerCase().indexOf(query) !== -1,

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

// metadata arrives as a JSON string. One that will not parse is shown as it
// stands rather than an audit entry being thrown away over its own detail.
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

    // the shape an update writes: { changes: { field: { before, after } } }
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

// ==========================================
// BACKUP & RECOVERY
//
// A backup is one complete .sql file holding the whole system: every table,
// every row, both views and all eighteen procedures. The server writes it
// into the project's backups/ folder under the date and time it was taken.
//
// Download, Restore and Delete used to sit on every row, so a list of twenty
// backups carried sixty buttons and two of the three destroy data. They open
// in a drawer now, with the one backup they belong to, which is also the only
// place that names the file about to be acted on.
// ==========================================
let selectedBackup = null;

function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
}

// hardware_db_backup_2026-09-04_1407.sql -> 4 September 2026 / 14:07
function backupTakenAt(fileName) {
    const parts = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(fileName);
    if (!parts) return { day: fileName, time: '' };

    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    const day = date.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' });
    return { day: day, time: `${parts[4]}:${parts[5]}` };
}

// ==========================================
// WHETHER THE SYSTEM IS BACKING ITSELF UP
//
// Every fact on this card comes from the server. Whether the timer is running
// is a fact about the server, and a screen that says "backing up every minute"
// because that sentence is in its own HTML is a screen that will keep saying
// it after the timer has died.
//
// The failure state is the one worth having. A backup that has quietly stopped
// working looks exactly like a backup that is working, right up until the
// afternoon somebody needs it, so a failure is said here in plain words with
// what the server actually reported.
// ==========================================
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

    // ==========================================
    // THE HALF-INSTALLED DATABASE COMES FIRST
    //
    // If the stored procedures are missing, nothing in the system can be
    // saved, and that outranks anything this card would otherwise say about
    // backups. It is reported here because this is the screen somebody is
    // already on when they come looking for what went wrong -- and because
    // it is also the reason the backup folder has stopped rotating.
    // ==========================================
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

// Reads the state without opening the table, for the moment the screen is
// opened. The folder listing comes back with it either way, so the two
// figures at the top of the card below are filled in from the same request
// rather than from a second one.
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

        match: (file, query) => file.fileName.toLowerCase().indexOf(query) !== -1,

        renderRow: (file, index) => {
            const when = backupTakenAt(file.fileName);

            // Which kind it is, on the row, because it decides how long the
            // file will be there: an automatic one is on a rolling hour and
            // will be gone, and one taken by hand stays until somebody
            // deletes it. Restoring from either works the same way.
            const kind = file.automatic
                ? '<span class="badge badge-neutral">Automatic</span>'
                : '<span class="badge badge-success">Kept</span>';

            // the name goes through a handler rather than into the attribute,
            // so a file name is never able to close the quote it sits in
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

    // a plain navigation, so the browser saves the file the server sends
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

// restoring from a .sql file the administrator kept somewhere else
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


// ==========================================
// STORE & TAX
//
// What every invoice claims about the business. It used to be a shop name
// written into a JavaScript file, no TIN and no tax breakdown, which meant
// every installation of this system printed the same shop and none of them
// printed a document the BIR would accept.
//
// Registration is a setting rather than a constant because both kinds of
// hardware shop exist. Above the 3,000,000 annual threshold a shop is
// VAT-registered and the 12% sits inside its posted prices; below it the shop
// is non-VAT, charges no VAT at all, and pays percentage tax on its own
// sales instead. Printing a VAT block on a non-VAT shop's invoice would be
// claiming to have collected a tax that was never collected.
//
// Changing any of this touches no sale already rung up. Each sale carries the
// registration and rate it was issued under, which is the point: an invoice
// reprinted next year has to say what was charged on the day.
// ==========================================
let storeSettings = null;

// ==========================================
// THE TIN
//
// A BIR Tax Identification Number is nine digits and a branch code, written
// 000-000-000-00000. The branch code is 00000 for the head office and was
// three digits long until the BIR widened it, so a TIN copied off an older
// certificate of registration reads 000-000-000-000.
//
// The box used to take anything up to thirty characters, and "anything" is
// what it got: a TIN with spaces in it, one with the dashes in the wrong
// places, one that was somebody's phone number. Every one of those was then
// printed at the head of every invoice the shop issued.
//
// So the box now works the way the phone box does. Digits only, the dashes
// put in as the digits arrive, and one sentence about what is wrong if the
// count is not one of the three the BIR issues. Nine digits on their own are
// taken as the head office; a three-digit branch code is widened to five the
// way the BIR did it, with two zeros in front. The stored form is always the
// full 000-000-000-00000, and the same rule is enforced again in server.js,
// because a check that lives only in a browser is a check anybody can skip.
// ==========================================
const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

function tinDigits(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\D/g, '')
        .slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
}

// 000-000-000-00000 from however many digits there are so far
function tinFormat(digits) {
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9)];
    return parts.filter((part) => part !== '').join('-');
}

// Wired to oninput on the TIN box. It rewrites the box rather than blocking
// the key, so a TIN pasted with spaces or without dashes lands in shape.
function onTinInput(input) {
    if (!input) return;

    const shaped = tinFormat(tinDigits(input.value));
    if (shaped !== input.value) input.value = shaped;

    // a verdict while it is being typed, and none while it is empty: the box
    // is required, and the form says so at submit rather than on every key
    input.classList.toggle('is-bad', shaped !== '' && tinComplaint(shaped) !== null);
}

// The one sentence said about a bad TIN, or null when there is nothing to
// say. Returned rather than shown, so the caller decides where it goes.
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

// the stored form: 000-000-000-00000, with a missing or three-digit branch
// code brought up to five the way the BIR did it. A value that does not
// pass is handed back as it was, so a bad TIN already on file is shown as
// it stands rather than as a corrected version of itself.
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

    // A non-VAT shop stores a zero rate, which is the honest record but a
    // useless thing to put back in the box if somebody switches to VAT.
    const rate = Number(storeSettings.vat_rate) || 0;
    form.elements.vatRate.value = rate > 0 ? rate : 12;

    setPill('store-state', (storeSettings.registration_type || 'VAT') === 'VAT'
        ? 'VAT ' + (rate > 0 ? rate.toFixed(0) : '12') + '%'
        : 'Non-VAT');

    onRegistrationChange(form.elements.registrationType.value);

    // the boxes now say what the record says: nothing to save yet
    showStoreVerdict('');
    markFormClean(form, document.getElementById('store-save-btn'));
}

// The rate box only means anything to a VAT-registered shop. Leaving it on
// screen for a non-VAT one invites somebody to type 12 into it and believe
// the shop is now charging VAT.
function onRegistrationChange(value) {
    const field = document.getElementById('store-rate-field');
    if (field) field.style.display = value === 'VAT' ? 'block' : 'none';
    renderStorePreview();
}

// what the server refused, or what this screen refused, next to the boxes
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

    // said at the form, because it is the form that has to be corrected
    const tinProblem = tinComplaint(form.elements.tin.value);
    if (tinProblem) {
        showStoreVerdict(tinProblem);
        form.elements.tin.classList.add('is-bad');
        form.elements.tin.focus();
        return;
    }

    // Switching registration changes what every future invoice claims about
    // the business, which is not a thing to do by brushing past a form.
    if (storeSettings && storeSettings.registration_type !== registration) {
        const yes = await askConfirm(
            'This shop is recorded as ' + storeSettings.registration_type +
            ' and you are changing it to ' + registration + '.',
            {
                title: 'Change the tax registration?',
                eyebrow: 'Store & Tax',
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

// A worked example rather than a description. One thousand pesos, split the
// way the settings on this screen would split it, so the person setting them
// can see what a customer is going to be handed before a customer is handed
// one.
function renderStorePreview() {
    const box = document.getElementById('store-preview');
    const form = document.getElementById('store-form');
    if (!box || !form) return;

    const registration = form.elements.registrationType.value;
    const rate = registration === 'VAT' ? (parseFloat(form.elements.vatRate.value) || 0) : 0;
    const total = 1000;

    // The same arithmetic the database does: the rate is extracted from the
    // total, not added to it, and the VAT is rounded first so the two lines
    // always add back to the total exactly.
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
//
// The four panels are built, which draws their closed state and nothing more.
// Not one of them touches the database until somebody asks it to.
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('system.html')) {
    document.addEventListener('DOMContentLoaded', async function () {
        buildUsersPanel();
        buildArchivePanel();
        buildLogsPanel();
        buildBackupPanel();

        showAccountsList();

        // The preview redraws as the boxes are typed into, so the person
        // setting the TIN sees the invoice change under their hands rather
        // than after saving it.
        const storeForm = document.getElementById('store-form');
        if (storeForm) storeForm.addEventListener('input', renderStorePreview);

        // the two edit forms: Save is off until something in them changes
        watchFormEdits(storeForm, document.getElementById('store-save-btn'));
        watchFormEdits(document.getElementById('edit-user-form'),
                       document.getElementById('edit-user-save-btn'));

        // a filter left set from before -- the browser remembers dropdowns
        // across a reload -- takes its column off the grid from the start
        syncDirectoryColumns();
        syncLogColumns();

        await loadRoles();
        loadNotifications();
    });
}
