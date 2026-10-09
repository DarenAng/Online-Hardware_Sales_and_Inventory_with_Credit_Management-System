// ============================================================
// system-admin.js -- the System Administrator dashboard
// Loaded by: system.html
//
// What is in this file, from top to bottom:
//   - switching screens (showPanel and the show... functions)
//   - the staff directory: list, create (review then confirm), edit,
//     activate / deactivate, reset password, archived accounts
//   - Access Control: which screens each role can open
//   - the audit logs
//   - Backup & Recovery: make, download, restore and delete backups
//   - Receipt Maintenance: the store name, TIN, VAT and bank details
//   - the page start-up code at the very bottom ("SYSTEM PAGE BOOT")
// ============================================================

// ==========================================
// PANEL SWITCHING (System page)
// ==========================================
// what the top bar says on each screen
const ADMIN_TITLES = {
    'panel-accounts':    'Staff Directory',
    'panel-archive':     'Archived Accounts',
    'panel-features':    'Access Control',
    'panel-logs':        'Audit Logs',
    'panel-maintenance': 'Backup & Recovery',
    'panel-store':       'Receipt Maintenance'
};

// Account screens are a list under a folded heading; opening one unfolds
// the list, except the one the page opens on by itself.

function showPanel(panelId, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });

    const opened = document.getElementById(panelId);
    const linkedTo = (opened && opened.getAttribute('data-panel-of')) || panelId;
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === linkedTo);
    });

    const heading = document.getElementById('admin-page-title');
    if (heading) heading.textContent = ADMIN_TITLES[panelId] || 'System Administration';

    leaveScreenFurniture();
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

// Opening a screen never unfolds the Accounts Management list: only the
// heading's caret does (shared/helpers.js sidebarHeading); the heading lights
// up on its own while a screen beneath it is the open one.

function showCreateAccount(event) {
    if (event) event.preventDefault();
    clearCreateForm();
    showModal('create-modal');
    const first = document.getElementById('create-first');
    if (first) first.focus();
}
function showArchiveModule(event) { showPanel('panel-archive', event); }
function showAuditLogs(event)     { showPanel('panel-logs', event); }
// Backup & Recovery loads everything on opening: the daily backup's state
// and every saved backup.
function showMaintenance(event) {
    showPanel('panel-maintenance', event);
    const panel = getDataPanel('admin-backups');
    if (panel) panel.open(); else loadAutoBackupState();
}
function showStoreSettings(event) { showPanel('panel-store', event); loadStoreSettingsForm(); }

// one small request, read on opening; not re-read over unsaved changes
function showAccessControl(event) {
    showPanel('panel-features', event);
    if (featureMatrixChanges().length === 0) loadFeatureMatrix();
}

// ==========================================
// ROLES
// ==========================================
let systemRoles = [];

async function loadRoles() {
    try {
        const response = await apiGetRoles();
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

// Active/Inactive is a decision about the account. Whether somebody is at a
// screen right now is not the directory's business; Last Login is on the card.
let selectedUser = null;

function accountCell(user) {
    if (!user.is_active) return '<span class="badge badge-danger">Inactive</span>';
    // held after too many wrong passwords; a password reset releases it
    if (user.held_until) return '<span class="badge badge-warning" title="Held until ' + escapeHtml(whenText(user.held_until)) + ' after too many wrong passwords">Held</span>';
    return '<span class="badge badge-success">Active</span>';
}

function userSearchFields(user) {
    return [
        user.full_name, user.first_name, user.middle_name, user.last_name,
        user.email, user.role_name, user.staff_id, '#' + user.staff_id
    ];
}

// the account-state filter goes back to the server; the role is decided here
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
const DIRECTORY_COLUMN = { role: 4, status: 5 };
const LOG_COLUMN = { type: 5 };

function selectValue(id) {
    const select = document.getElementById(id);
    return select ? select.value : 'all';
}

function syncDirectoryColumns() {
    const hidden = [];
    if (selectValue('accounts-role') !== 'all') hidden.push(DIRECTORY_COLUMN.role);
    if (selectValue('accounts-status') !== 'all') hidden.push(DIRECTORY_COLUMN.status);

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
        columns: 5,
        pagerId: 'accounts-pager',
        idField: 'staff_id',
        filters: { roleId: 'all' },

        // filters set up a query rather than run one; see dataPanelFilter
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
            return apiGetStaff(query);
        },

        match: (user, query) => prefixMatch(userSearchFields(user), query),

        filter: (user, filters) => {
            if (filters.roleId !== 'all' && String(user.role_id) !== String(filters.roleId)) return false;
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
        detailRow('Account Status', accountCell(selectedUser) +
            (selectedUser.held_until
                ? ' <span class="muted">until ' + escapeHtml(whenText(selectedUser.held_until)) +
                  ' \u2014 resetting the password releases it now</span>'
                : '')) +
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
    form.elements.email.required = Boolean(selectedUser.user_id);
    document.getElementById('edit-email-req').hidden = !selectedUser.user_id;
    setEmailError(form.elements.email, '');
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

// "request" is a call that was already sent to the server, for example
// apiUpdateStaff(5, data) (see connections/admin-connection.js).
// Returns the server's reply on success and false on failure. No
// successMessage means the caller does the talking.
async function sendUserRequest(request, successMessage) {
    try {
        const response = await request;   // wait for the server's answer
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

    const empty = firstEmptyRequired(form);
    if (empty) {
        notifyWarning('Fill in every field marked with *.', 'Fill in the form');
        empty.focus();
        return;
    }

    // a login's address cannot be emptied, and it has to be free
    if (selectedUser.user_id && form.elements.email.value.trim() === '') {
        setEmailError(form.elements.email, 'An email address is required.');
        form.elements.email.focus();
        return;
    }
    if (!(await checkEmailFree(form.elements.email))) {
        form.elements.email.focus();
        return;
    }

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone),
        email: form.elements.email.value.trim().toLowerCase(),
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

    await sendUserRequest(apiUpdateStaff(selectedUser.staff_id, data), 'Account updated.');
}

async function toggleUserStatus() {
    if (!selectedUser) return;

    if (isOwnAccount(selectedUser)) {
        notifyWarning('You cannot deactivate your own account. Another administrator can.', 'Not allowed');
        return;
    }

    const makeActive = !selectedUser.is_active;
    const name = staffName(selectedUser);

    let yes;
    if (makeActive) {
        yes = await askConfirm(`${name} will be able to sign in again straight away.`, {
                title: 'Activate this account?',
                eyebrow: 'Accounts Management',
                confirmLabel: 'Activate'
            });
    } else {
        yes = await askDanger(`${name} loses access to the system.`, {
                title: 'Deactivate this account?',
                eyebrow: 'Accounts Management',
                confirmLabel: 'Deactivate the account',
                detail: [
                    'Any session they have open is ended immediately.',
                    'They cannot sign in again until an administrator restores the account.',
                    'Their sales, records and history are kept and are not deleted.'
                ]
            });
    }

    if (!yes) return;

    let doneMessage = 'The account has been deactivated.';
    if (makeActive) {
        doneMessage = 'The account is active again.';
    }
    await sendUserRequest(apiSetStaffActive(selectedUser.staff_id, makeActive), doneMessage);
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

    const result = await sendUserRequest(apiResetUserPassword(selectedUser.staff_id));
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
        if (field.type === 'checkbox') {
            values[field.name] = field.checked;
            return;
        }
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

    setEmailError(form.elements.email, '');
}

function cancelCreateAccount() {
    clearCreateForm();
    closeModal('create-modal');
}

// ==========================================
// THE EMAIL BOX -- an address and nothing else, and one no other account uses
// ==========================================
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function emailComplaint(value) {
    const email = String(value || '').trim();
    if (email === '') return 'An email address is required.';
    if (!EMAIL_PATTERN.test(email)) return 'Enter an email address, for example name@example.com.';
    return null;
}

function setEmailError(input, text) {
    if (!input) return;
    const box = document.getElementById(input.id + '-error');
    input.classList.toggle('is-bad', Boolean(text));
    if (box) {
        box.textContent = text || '';
        box.hidden = !text;
    }
}

// spaces cannot be part of an address, so they never get into the box
function onEmailInput(input) {
    const cleaned = input.value.replace(/\s+/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    setEmailError(input, '');
}

// Asked when the box is left: is this address already signing in to an
// account? Every role counts, active or archived. The server asks again on
// save, so this is only for saying it early.
async function checkEmailFree(input) {
    if (!input) return true;
    const email = input.value.trim();

    // the edit form may leave the address as it was
    const own = input.id === 'edit-email' && selectedUser &&
        String(selectedUser.email || '').toLowerCase() === email.toLowerCase();
    if (own || (email === '' && input.id === 'edit-email')) {
        setEmailError(input, '');
        return true;
    }

    const problem = emailComplaint(email);
    if (problem) {
        setEmailError(input, problem);
        return false;
    }

    try {
        const answer = await apiCheckEmail(email, input.id === 'edit-email' && selectedUser ? selectedUser.staff_id : null);
        if (answer && answer.taken) {
            setEmailError(input, 'This email is already used by another account (' + answer.roleName + ').');
            return false;
        }
    } catch (error) {
        // offline: the server says so on save
    }
    setEmailError(input, '');
    return true;
}

// what a required box says when it was left empty
function firstEmptyRequired(form) {
    return Array.from(form.querySelectorAll('[required]'))
        .find((field) => String(field.value || '').trim() === '');
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

// what the working card says while the account is being made; the steps
// are what the server does, in order, and the card ticks through them
function creatingCard(review) {
    return {
        title: 'Creating the account',
        eyebrow: 'Accounts Management',
        message: review.willEmail
            ? `This can take a few seconds while the mail goes out.`
            : `Mail is not set up, so the password comes back to this screen.`,
        steps: review.willEmail
            ? [`Saving ${review.fullName}'s account`,
               `Emailing the first password to ${review.email}`,
               'Writing it in the audit trail']
            : [`Saving ${review.fullName}'s account`,
               'Writing it in the audit trail']
    };
}

// One press of Create: the form is checked here, the server checks it again
// and makes the password, and the account is created straight away.
async function handleCreateUser(event) {
    event.preventDefault();
    const form = event.target;
    const button = document.getElementById('create-user-btn');

    const empty = firstEmptyRequired(form);
    if (empty) {
        const label = form.querySelector('label[for="' + empty.id + '"]');
        const name = label ? label.childNodes[0].textContent.trim() : 'This field';
        notifyWarning(name + ' is required.', 'Fill in the form');
        empty.focus();
        return;
    }

    const phoneProblem = phoneComplaint(form.elements.phone);
    if (phoneProblem) {
        notifyWarning(phoneProblem, 'Check the phone number');
        form.elements.phone.focus();
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'Checking...'; }
    const emailFree = await checkEmailFree(form.elements.email);
    if (!emailFree) {
        if (button) { button.disabled = false; button.textContent = 'Create'; }
        form.elements.email.focus();
        return;
    }

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone),
        email: form.elements.email.value.trim().toLowerCase(),
        roleId: parseInt(form.elements.roleId.value, 10)
    };

    try {
        const review = await apiReviewNewAccount(data);
        if (button) { button.disabled = false; button.textContent = 'Create'; }
        if (!review) return;

        closeModal('create-modal');
        showWorking(creatingCard(review));
        let result;
        try {
            result = await apiCreateAccount(review.draftId);
        } finally {
            if (result) await finishWorking('Account created'); else hideWorking();
        }
        if (!result) {
            showModal('create-modal');
            return;
        }

        clearCreateForm();
        showPanel('panel-accounts');

        // the directory is refreshed only if somebody already had it open
        const panel = getDataPanel('admin-users');
        if (panel && panel.state === 'ready') await panel.refresh();

        await reportFirstPassword(result, result.email, result.name);
    } catch (error) {
        notifyOffline();
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Create'; }
    }
}

async function createLoginAccount() {
    if (!selectedUser || selectedUser.user_id) return;

    const name = staffName(selectedUser);

    const email = await askInput({
        title: 'Create a login',
        eyebrow: 'Accounts Management',
        message: `${name} has a staff record but no way to sign in yet. The first password is sent to this address.`,
        label: 'Email address',
        type: 'email',
        placeholder: 'name@example.com',
        confirmLabel: 'Create Login',
        check: (value) => emailComplaint(value)
    });

    if (email === false || email === null) return;

    const staffId = selectedUser.staff_id;

    try {
        const review = await apiReviewLogin(staffId, email.trim().toLowerCase());
        if (!review) return;

        showWorking(creatingCard(review));
        let result;
        try {
            result = await apiCreateLogin(staffId, review.draftId);
        } finally {
            if (result) await finishWorking('Login created'); else hideWorking();
        }
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
        idField: 'staff_id',

        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data to read the deactivated staff accounts, or type a name.',
            button: 'Load Data'
        },

        load: () => apiGetStaff('?status=inactive'),

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
        detailRow('Email', user.email
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

    if (user.email) {
        warning.textContent = 'Restoring puts this account back on the active list. ' + name +
              ' can sign in again straight away with the password they had before.';
    } else {
        warning.textContent = 'Restoring puts this staff record back on the active list. ' + name +
              ' still has no login account, so use Create Login afterwards.';
    }

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
        const response = await apiSetStaffActive(user.staff_id, true);
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

// Access control: a role is picked at the top and its screens are one line
// of switches. Every role's line is drawn and all but the picked one hidden,
// so a change made under one role survives looking at another. Same
// baseline and read-back-first flow: nothing is saved until Save reads the
// changes back.
let featureMatrix = null;       // what /api/features last answered
let featureRoleId = null;       // the role whose line is showing

function featureCellState(cell) {
    if (!cell.available) return 'unavailable';
    if (cell.held === cell.byDefault) return 'default';
    return cell.held ? 'granted' : 'revoked';
}

// the word beside a switch only when it differs from the role's default
function featureStateWord(state, on) {
    if (state === 'unavailable' || state === 'default') return '';
    return on ? 'switched on' : 'switched off';
}

// "on" that agrees with the default is by role; otherwise a grant or a revocation
function featureStateOf(byDefault, on) {
    if (on === byDefault) return 'default';
    return on ? 'granted' : 'revoked';
}

async function loadFeatureMatrix() {
    const mount = document.getElementById('features-matrix');
    if (!mount) return;

    try {
        featureMatrix = await apiGetScreenSwitches();
    } catch (error) {
        mount.innerHTML = '<p class="table-empty">Cannot read the screens. Is the server running?</p>';
        return;
    }

    renderFeatureMatrix();
}

// The roles down the right-hand column, one button each; the first is
// picked until somebody chooses. Each carries how many of its screens are
// on, and a mark once something on it has been changed and not yet saved.
function renderFeatureRoleList(roles) {
    const list = document.getElementById('features-role');
    if (!list) return;

    if (!roles.some((role) => role.role_id === featureRoleId)) {
        featureRoleId = roles.length > 0 ? roles[0].role_id : null;
    }

    list.innerHTML = roles.map((role) =>
        '<button type="button" class="role-pick' + (role.role_id === featureRoleId ? ' active' : '') + '"' +
            ' role="tab" aria-selected="' + (role.role_id === featureRoleId ? 'true' : 'false') + '"' +
            ' data-role="' + escapeHtml(String(role.role_id)) + '"' +
            ' onclick="selectFeatureRole(' + Number(role.role_id) + ')">' +
            '<span class="role-pick-name">' + escapeHtml(role.role_name) + '</span>' +
            '<span class="role-pick-mark" title="Changed, not yet saved" hidden>&bull;</span>' +
        '</button>').join('');
}

function selectFeatureRole(value) {
    featureRoleId = Number(value);
    showFeatureRole();
}

// all but the picked role's line are hidden, not removed: their switches keep their changes
function showFeatureRole() {
    document.querySelectorAll('#features-matrix .feature-strip').forEach((strip) => {
        strip.hidden = Number(strip.dataset.role) !== featureRoleId;
    });
    document.querySelectorAll('#features-role .role-pick').forEach((button) => {
        const picked = Number(button.dataset.role) === featureRoleId;
        button.classList.toggle('active', picked);
        button.setAttribute('aria-selected', picked ? 'true' : 'false');
    });
    syncFeatureRoleNote();
    filterFeatureScreens();
}

// whether each role carries unsaved changes
function syncFeatureRoleNote() {
    const mount = document.getElementById('features-matrix');
    // the switches as they were when the screen was drawn
    let before = {};
    if (mount && mount.dataset.baseline) {
        before = JSON.parse(mount.dataset.baseline);
    }

    document.querySelectorAll('#features-matrix .feature-strip').forEach((strip) => {
        const boxes = strip.querySelectorAll('.feature-box');
        let unsaved = false;    // has any switch been flipped since the screen was drawn?
        for (const box of boxes) {
            if (before[box.dataset.feature + '|' + box.dataset.role] !== box.checked) unsaved = true;
        }

        const pick = document.querySelector('#features-role .role-pick[data-role="' + strip.dataset.role + '"]');
        if (pick) {
            const mark = pick.querySelector('.role-pick-mark');
            if (mark) mark.hidden = !unsaved;
        }
    });
}

function renderFeatureMatrix() {
    const mount = document.getElementById('features-matrix');
    if (!mount || !featureMatrix) return;

    const roles = featureMatrix.roles || [];
    const features = featureMatrix.features || [];

    renderFeatureRoleList(roles);

    const modules = [];
    features.forEach((feature) => { if (!modules.includes(feature.module)) modules.push(feature.module); });

    // one line per role: the screens its dashboard can draw, grouped under the module name
    mount.innerHTML = roles.map((role) => {
        const line = modules.map((module) => {
            const chips = features
                .filter((feature) => feature.module === module &&
                    (feature.roles[role.role_name] || { available: false }).available)
                .map((feature) => {
                const cell = feature.roles[role.role_name];
                const state = featureCellState(cell);
                let who;
                if (cell.overridden && cell.grantedBy) {
                    who = (cell.held ? 'Granted' : 'Switched off') + ' by ' + cell.grantedBy +
                          (cell.updatedAt ? ' ' + whenText(cell.updatedAt) : '') + '. ';
                } else {
                    who = '';
                }

                // one row: the screen and what it does, then the state it is in
                // and the checkbox; every row shares the same three columns, so the
                // checkboxes line up down the right-hand edge.
                return '<label class="feature-row"' + (who ? ' title="' + escapeHtml(who.trim()) + '"' : '') +
                    ' data-search="' + escapeHtml((feature.name + ' ' + feature.module + ' ' + (feature.description || '')).toLowerCase()) + '">' +
                    '<span class="feature-row-text">' +
                        '<span class="feature-row-name">' + escapeHtml(feature.name) + '</span>' +
                        '<span class="feature-desc">' + escapeHtml(feature.description || '') + '</span>' +
                    '</span>' +
                    '<span class="feature-state is-' + state + '"' + (featureStateWord(state, cell.held) ? '' : ' hidden') + '>' +
                        featureStateWord(state, cell.held) + '</span>' +
                    '<input type="checkbox" class="feature-box" data-feature="' + escapeHtml(feature.key) + '"' +
                        ' data-role="' + escapeHtml(String(role.role_id)) + '"' +
                        ' data-role-name="' + escapeHtml(role.role_name) + '"' +
                        ' data-default="' + (cell.byDefault ? '1' : '') + '"' +
                        (cell.held ? ' checked' : '') +
                        ' aria-label="' + escapeHtml(feature.name + ' for ' + role.role_name) + '"' +
                        ' onchange="onFeatureBoxChange(this)">' +
                '</label>';
            });
            if (chips.length === 0) return '';
            return '<div class="feature-group">' +
                '<span class="feature-module">' + escapeHtml(module) + '</span>' +
                chips.join('') + '</div>';
        }).join('');

        return '<div class="feature-strip" data-role="' + escapeHtml(String(role.role_id)) + '"' +
            (role.role_id === featureRoleId ? '' : ' hidden') + '>' +
            '<div class="feature-line">' +
                (line || '<span class="muted">This role\'s dashboard has no screens to switch.</span>') +
            '</div>' +
        '</div>';
    }).join('');

    mount.dataset.baseline = readFeatureMatrix();

    showFeatureRole();
    syncFeatureSaveButton();
}

// The search box narrows the role's list to the screens whose name, module
// or description holds what was typed; a module left with nothing goes too.
function filterFeatureScreens(query) {
    const input = document.getElementById('features-search');
    const wanted = String(query === undefined ? (input ? input.value : '') : query).trim().toLowerCase();

    document.querySelectorAll('#features-matrix .feature-group').forEach((group) => {
        let shown = 0;
        group.querySelectorAll('.feature-row').forEach((row) => {
            const match = wanted === '' || (row.dataset.search || '').includes(wanted);
            row.hidden = !match;
            if (match) shown += 1;
        });
        group.hidden = shown === 0;
    });

    // "no match" only for the role on screen
    const strip = document.querySelector('#features-matrix .feature-strip:not([hidden])');
    const none = document.getElementById('features-no-match');
    if (none) {
        none.hidden = !strip || wanted === '' ||
            strip.querySelector('.feature-group:not([hidden])') !== null;
    }
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
        word.hidden = word.textContent === '';
    }
    syncFeatureRoleNote();
    syncFeatureSaveButton();
}

function featureMatrixChanges() {
    const mount = document.getElementById('features-matrix');
    if (!mount || !mount.dataset.baseline) return [];

    const before = JSON.parse(mount.dataset.baseline || '{}');
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

    // one line per change, e.g. "Cashier: Income switched on"
    let takesAway = false;
    const lines = [];
    for (const change of changes) {
        let what;
        if (change.granted && change.byDefault) {
            what = ' switched back on';
        } else if (change.granted) {
            what = ' switched on';
        } else if (change.byDefault) {
            what = ' switched off';
            takesAway = true;
        } else {
            what = ' taken back off';
            takesAway = true;
        }
        lines.push(change.roleName + ': ' + change.name + what);
    }

    const ask = takesAway ? askDanger : askConfirm;
    const yes = await ask(
        'Every signed-in screen of these roles follows at once. Each line is written to the audit trail in your name.',
        {
            title: takesAway ? 'Switch screens off for a role?' : 'Change the screens by role?',
            eyebrow: 'Access Control',
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
            const response = await apiSetScreenSwitch(change.key, change.roleId, change.granted);
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
        idField: 'log_id',

        gate: {
            title: 'The audit trail is not loaded',
            text: 'Pick a date range or an action type, then press Load Data. ' +
                  'Nothing is read from the trail until you ask for it.',
            button: 'Load Data'
        },

        load: () => apiGetAuditLogs(auditLogQuery()),

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

// Export: the same filters as the table (type, dates, and the search box),
// written by the server as an Excel workbook or a PDF and downloaded.
function exportAuditLogs(format) {
    const query = auditLogQuery();
    const search = document.getElementById('logs-search');
    const text = search ? search.value.trim() : '';

    let url = '/api/audit-logs/export/' + encodeURIComponent(format) + query;
    if (text !== '') url += (query ? '&' : '?') + 'search=' + encodeURIComponent(text);

    notifyInfo('The audit trail is being written to a ' + (format === 'pdf' ? 'PDF' : 'Excel') +
        ' file and saved to your downloads folder.', 'Exporting');
    window.location.href = url;
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

// "02:00" for an hour of the day
function hourText(hour) {
    return String(Number(hour) || 0).padStart(2, '0') + ':00';
}

// Every fact on this card comes from the server, so a dead timer cannot keep
// reading "backing up every day". A failure is said in plain words.
function renderAutoBackupCard(auto, procedures) {
    const card = document.getElementById('auto-backup-card');
    const state = document.getElementById('auto-backup-state');
    const text = document.getElementById('auto-backup-text');
    if (!card || !state || !text) return;

    // the switch says what pressing it will do, and only shows once the server has answered
    const toggle = document.getElementById('auto-backup-toggle');
    if (toggle) {
        toggle.style.display = auto ? '' : 'none';
        toggle.disabled = false;
        if (auto) {
            toggle.textContent = auto.enabled ? 'Turn Off' : 'Turn On';
            toggle.className = auto.enabled ? 'btn btn-ghost auto-backup-toggle' : 'btn btn-accent auto-backup-toggle';
            toggle.title = auto.enabled
                ? 'Stop the daily backup. The files already saved stay.'
                : 'Start the daily backup again.';
        }
    }

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
        text.textContent = `This database has ${procedures.loaded} of ${procedures.expected} ` +
            `stored procedures, so nothing can be saved. Run ` +
            `public/database/2-RUN-SECOND-stored-procedures.sql, then reload this page. ` +
            `Older backups are not being deleted meanwhile.`;
        return;
    }

    if (!auto.enabled) {
        card.className = 'card auto-backup is-off';
        state.textContent = 'Off';
        text.textContent = 'The daily backup is off. Only backups taken with Run Backup Now are being saved.';
        return;
    }

    if (auto.lastError) {
        card.className = 'card auto-backup is-bad';
        state.textContent = 'Failing';
        text.textContent = `The last daily backup failed: ${auto.lastError}. ` +
            `It tries again at the next scheduled time. Take one by hand until this is fixed.`;
        return;
    }

    card.className = 'card auto-backup is-on';
    state.textContent = 'On';
    text.textContent = `One backup of the whole system is saved every day at ${hourText(auto.hour)}, ` +
        `and the newest ${auto.keep} automatic backups are kept.` +
        (auto.lastFileName ? ` The most recent is ${auto.lastFileName}.` : '');
}

// the limits under Saved Backups, from the server
function renderBackupLimits(limits) {
    const note = document.getElementById('backup-limit-note');
    if (!note || !limits) return;
    note.textContent = `${limits.manualCount} of ${limits.manual} manual backups used. ` +
        `The newest ${limits.automatic} automatic backups are kept.`;
}

// reads the state without opening the table
async function loadAutoBackupState() {
    try {
        const body = await apiGetBackups();
        renderAutoBackupCard(body.auto, body.procedures);
        renderBackupLimits(body.limits);
    } catch (error) {
        renderAutoBackupCard(null);
    }
}

// The switch on the card. Off stops the daily backup; the files already
// there stay until they are deleted by hand.
async function toggleAutoBackup() {
    const toggle = document.getElementById('auto-backup-toggle');
    const turningOff = toggle && toggle.textContent.trim() === 'Turn Off';

    const yes = await askConfirm(
        turningOff
            ? 'The system stops saving a backup every day. The backups already saved stay, and Run Backup Now still works.'
            : 'The system saves one backup every day again.',
        {
            title: turningOff ? 'Turn the daily backup off?' : 'Turn the daily backup on?',
            eyebrow: 'Automatic backup',
            confirmLabel: turningOff ? 'Turn it off' : 'Turn it on'
        });

    if (!yes) return;

    if (toggle) { toggle.disabled = true; toggle.textContent = turningOff ? 'Turning off...' : 'Turning on...'; }

    try {
        const body = await apiSetAutoBackup(!turningOff);
        if (!body) return;

        notifySuccess(body.message, turningOff ? 'Daily backup off' : 'Daily backup on');
    } catch (error) {
        notifyOffline();
    } finally {
        // the card re-reads the server rather than trusting what was just pressed
        await loadAutoBackupState();
    }
}

function buildBackupPanel() {
    createDataPanel({
        key: 'admin-backups',
        tableId: 'backup-table',
        columns: 5,
        pagerId: 'backup-pager',
        idField: 'fileName',

        gate: {
            title: 'Reading the backup folder',
            text: 'The saved backups load as soon as this screen opens.',
            button: 'Load Data'
        },

        load: async () => {
            const body = await apiGetBackups();
            renderAutoBackupCard(body.auto, body.procedures);
            renderBackupLimits(body.limits);
            return body.files || [];
        },

        match: (file, query) => prefixMatch([file.fileName], query),

        renderRow: (file, index) => {
            const when = backupTakenAt(file.fileName);

            let kind;
            if (file.automatic) {
                kind = '<span class="badge badge-neutral">Automatic</span>';
            } else {
                kind = '<span class="badge badge-success">Manual</span>';
            }

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
        detailRow('Kind', selectedBackup.automatic ? 'Automatic' : 'Manual');

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
        'A new backup file is saved, holding the system exactly as it stands now.',
        {
            title: 'Run a backup now?',
            eyebrow: 'Backup',
            confirmLabel: 'Run the backup',
            detail: [
                'Nothing currently in the system is changed or removed.'
            ]
        });

    if (!yes) return;

    const button = document.getElementById('run-backup-btn');
    if (button) { button.disabled = true; button.textContent = 'Saving...'; }

    notifyInfo('Writing every table, view and procedure to a new .sql file.', 'Backup running');

    try {
        const response = await apiMakeBackup();
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

    apiDownloadBackup(selectedBackup.fileName);
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
        const response = await apiRestoreBackup(fileName);
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
        const response = await apiDeleteBackup(fileName);
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
        const response = await apiRestoreFromFile(sql);
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

// the receipt's switches, by the name of their checkbox (show_<name>)
const RECEIPT_SWITCHES = ['proprietor', 'cashier', 'customer', 'payment', 'reference',
                          'item_count', 'tax', 'bank', 'note'];
const RECEIPT_LINE_MAX = 10;        // lines in the header, and in the footer
const RECEIPT_LINE_LENGTH = 80;     // characters in one line

async function loadStoreSettingsForm() {
    const form = document.getElementById('store-form');
    if (!form) return;

    try {
        storeSettings = await apiGetStoreSettings();
    } catch (error) {
        notifyOffline();
        return;
    }

    form.elements.storeName.value = storeSettings.store_name || '';
    form.elements.proprietor.value = storeSettings.proprietor || '';
    form.elements.address.value = storeSettings.address || '';
    form.elements.tin.value = tinToStore(storeSettings.tin || '');
    form.elements.tin.classList.remove('is-bad');
    form.elements.registrationType.value = storeSettings.registration_type || 'VAT';
    form.elements.invoiceNote.value = storeSettings.invoice_note || '';
    form.elements.bankName.value = storeSettings.bank_name || '';
    form.elements.bankAccountName.value = storeSettings.bank_account_name || '';
    form.elements.bankAccountNumber.value = storeSettings.bank_account_number || '';

    // a non-VAT shop stores a zero rate; a useless value to put back in the box
    const rate = Number(storeSettings.vat_rate) || 0;
    form.elements.vatRate.value = rate > 0 ? rate : 12;

    // the layout, as the database holds it
    const layout = receiptLayoutOf(storeSettings);
    form.elements.paperWidth.value = String(layout.paperWidth);
    form.elements.fontSize.value = String(layout.fontSize);
    form.elements.title.value = layout.title;
    form.elements.paidLabel.value = layout.paidLabel;
    RECEIPT_SWITCHES.forEach((name) => {
        const box = form.elements['show_' + name];
        if (box) box.checked = receiptShows(layout, name);
    });
    renderReceiptLines('header', layout.headerLines);
    renderReceiptLines('footer', layout.footerLines);

    onBankInput();
    onRegistrationChange(form.elements.registrationType.value);

    showStoreVerdict('');
    markFormClean(form, document.getElementById('store-save-btn'));
}

// ---------- the header and footer lines: added, moved and removed here ----------
function receiptLineList(kind) {
    return document.getElementById('store-' + kind + '-lines');
}

function readReceiptLines(kind) {
    const list = receiptLineList(kind);
    if (!list) return [];
    return Array.from(list.querySelectorAll('input'))
        .map((input) => input.value.trim())
        .filter((value) => value !== '');
}

function renderReceiptLines(kind, lines) {
    const list = receiptLineList(kind);
    if (!list) return;

    const values = Array.isArray(lines) ? lines : [];
    list.innerHTML = values.map((line, index) =>
        '<div class="line-row">' +
            '<input type="text" class="form-control" name="' + kind + 'Line_' + index + '"' +
                ' maxlength="' + RECEIPT_LINE_LENGTH + '" value="' + escapeHtml(line) + '"' +
                ' aria-label="' + (kind === 'header' ? 'Header' : 'Footer') + ' line ' + (index + 1) + '">' +
            '<button type="button" class="btn btn-ghost btn-sm" title="Move up" aria-label="Move up"' +
                (index === 0 ? ' disabled' : '') + ' onclick="moveReceiptLine(\'' + kind + '\', ' + index + ', -1)">&uarr;</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" title="Move down" aria-label="Move down"' +
                (index === values.length - 1 ? ' disabled' : '') + ' onclick="moveReceiptLine(\'' + kind + '\', ' + index + ', 1)">&darr;</button>' +
            '<button type="button" class="btn btn-ghost btn-sm line-remove" title="Remove" aria-label="Remove"' +
                ' onclick="removeReceiptLine(\'' + kind + '\', ' + index + ')">&times;</button>' +
        '</div>').join('');
}

// the lines as typed, empty ones kept, so a box just added stays on screen
function typedReceiptLines(kind) {
    const list = receiptLineList(kind);
    return list ? Array.from(list.querySelectorAll('input')).map((input) => input.value) : [];
}

function receiptLinesChanged(kind, lines, focusIndex) {
    renderReceiptLines(kind, lines);
    const form = document.getElementById('store-form');
    if (form) form.dispatchEvent(new Event('input', { bubbles: true }));
    if (focusIndex !== undefined) {
        const boxes = receiptLineList(kind).querySelectorAll('input');
        if (boxes[focusIndex]) boxes[focusIndex].focus();
    }
}

function addReceiptLine(kind) {
    const lines = typedReceiptLines(kind);
    if (lines.length >= RECEIPT_LINE_MAX) {
        notifyWarning('A receipt holds up to ' + RECEIPT_LINE_MAX + ' lines here.', 'Too many lines');
        return;
    }
    lines.push('');
    receiptLinesChanged(kind, lines, lines.length - 1);
}

function moveReceiptLine(kind, index, step) {
    const lines = typedReceiptLines(kind);
    const target = index + step;
    if (target < 0 || target >= lines.length) return;
    const moved = lines.splice(index, 1)[0];
    lines.splice(target, 0, moved);
    receiptLinesChanged(kind, lines, target);
}

function removeReceiptLine(kind, index) {
    const lines = typedReceiptLines(kind);
    lines.splice(index, 1);
    receiptLinesChanged(kind, lines);
}

// everything about the layout, as it is sent to the server
function readReceiptLayout(form) {
    const show = {};
    RECEIPT_SWITCHES.forEach((name) => {
        const box = form.elements['show_' + name];
        show[name] = box ? box.checked : true;
    });
    return {
        paperWidth: Number(form.elements.paperWidth.value),
        fontSize: Number(form.elements.fontSize.value),
        title: form.elements.title.value.trim(),
        paidLabel: form.elements.paidLabel.value.trim(),
        headerLines: readReceiptLines('header'),
        footerLines: readReceiptLines('footer'),
        show: show
    };
}

// the rate box only means anything to a VAT-registered shop
function onRegistrationChange(value) {
    const field = document.getElementById('store-rate-field');
    if (field) field.style.display = value === 'VAT' ? 'block' : 'none';
    renderStorePreview();
}

// The bank account is required: the till shows it whenever Bank Transfer is
// chosen. The same rule as the server's (admin.js bankDetailsFrom).
const BANK_FIELDS = ['bankName', 'bankAccountName', 'bankAccountNumber'];

function bankComplaint(form) {
    const values = BANK_FIELDS.map((name) => form.elements[name].value.trim());
    if (values.some((value) => value === '')) {
        return 'The bank, the account name and the account number are all required.';
    }
    const number = values[2];
    if (!/^[0-9][0-9 -]*[0-9]$/.test(number) || number.replace(/\D/g, '').length < 6) {
        return 'An account number is digits, with spaces or dashes where the bank prints them.';
    }
    return null;
}

// marks the box that is wrong, as it is typed
function onBankInput() {
    const form = document.getElementById('store-form');
    const note = document.getElementById('store-bank-note');
    if (!form || !note || !form.elements.bankName) return;

    const values = BANK_FIELDS.map((name) => form.elements[name].value.trim());
    const numberBad = values[2] !== '' && bankComplaint(form) !== null && values.every((v) => v !== '');
    form.elements.bankAccountNumber.classList.toggle('is-bad', numberBad);

    note.className = numberBad ? 'store-bank-note is-stop' : 'store-bank-note';
    note.textContent = numberBad ? bankComplaint(form) : '';
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

    // every box marked * first, with the bank boxes marked as well
    const empty = firstEmptyRequired(form);
    if (empty) {
        const label = form.querySelector('label[for="' + empty.id + '"]');
        const name = label ? label.childNodes[0].textContent.trim() : 'This field';
        showStoreVerdict(name + ' is required.');
        empty.classList.add('is-bad');
        empty.focus();
        return;
    }

    const tinProblem = tinComplaint(form.elements.tin.value);
    if (tinProblem) {
        showStoreVerdict(tinProblem);
        form.elements.tin.classList.add('is-bad');
        form.elements.tin.focus();
        return;
    }

    const bankProblem = bankComplaint(form);
    if (bankProblem) {
        showStoreVerdict(bankProblem);
        onBankInput();
        form.elements.bankAccountNumber.focus();
        return;
    }

    if (registration === 'VAT') {
        const rate = parseFloat(form.elements.vatRate.value);
        if (!(rate > 0 && rate <= 100)) {
            showStoreVerdict('The VAT rate is a number above 0 and up to 100.');
            form.elements.vatRate.focus();
            return;
        }
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
                    'Sales already rung up keep the registration they were issued under.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await apiSaveStoreSettings({
                storeName: form.elements.storeName.value.trim(),
                proprietor: form.elements.proprietor.value.trim(),
                address: form.elements.address.value.trim(),
                tin: tinToStore(form.elements.tin.value),
                registrationType: registration,
                vatRate: registration === 'VAT' ? parseFloat(form.elements.vatRate.value) : 0,
                invoiceNote: form.elements.invoiceNote.value.trim(),
                bankName: form.elements.bankName.value.trim(),
                bankAccountName: form.elements.bankAccountName.value.trim(),
                bankAccountNumber: form.elements.bankAccountNumber.value.trim(),
                receiptLayout: readReceiptLayout(form)
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) showStoreVerdict(result.error);
            return;
        }

        showStoreVerdict('');

        notifySuccess(result.message, 'Receipt saved');
        await loadStoreSettingsForm();
    } catch (error) {
        notifyOffline();
    }
}

// the settings as the form has them now, in the shape the till reads
function storeFromForm(form) {
    return {
        store_name: form.elements.storeName.value.trim(),
        proprietor: form.elements.proprietor.value.trim(),
        address: form.elements.address.value.trim(),
        tin: form.elements.tin.value.trim(),
        invoice_note: form.elements.invoiceNote.value.trim(),
        bank_name: form.elements.bankName.value.trim(),
        bank_account_name: form.elements.bankAccountName.value.trim(),
        bank_account_number: form.elements.bankAccountNumber.value.trim(),
        receipt_layout: readReceiptLayout(form)
    };
}

// A worked example: one sale of one thousand pesos, drawn by the same
// builder as the till's invoice from what is in the boxes now.
function renderStorePreview() {
    const box = document.getElementById('store-preview');
    const form = document.getElementById('store-form');
    if (!box || !form || !form.elements.paperWidth) return;

    const shop = storeFromForm(form);
    const registration = form.elements.registrationType.value;
    const rate = registration === 'VAT' ? (parseFloat(form.elements.vatRate.value) || 0) : 0;
    const total = 1000;

    // the same arithmetic the database does: rate extracted from the total, VAT rounded first
    const vat = rate > 0 ? Math.round(total * rate / (100 + rate) * 100) / 100 : 0;
    const vatable = rate > 0 ? total - vat : 0;

    let tax;
    if (registration === 'VAT') {
        tax = '<div class="rc-tax">' +
              '<div><span>VATable Sale</span><span>' + peso(vatable) + '</span></div>' +
              '<div><span>VAT (' + rate.toFixed(0) + '%)</span><span>' + peso(vat) + '</span></div>' +
              '<div><span>VAT-Exempt Sale</span><span>' + peso(0) + '</span></div>' +
              '<div><span>Zero-Rated Sale</span><span>' + peso(0) + '</span></div></div>';
    } else {
        tax = '<div class="rc-tax">' +
              '<div><span>Sales Subject to Percentage Tax</span><span>' + peso(total) + '</span></div>' +
              '<div><span>Exempt Sales</span><span>' + peso(0) + '</span></div></div>';
    }

    let bank = '';
    if (shop.bank_account_number) {
        bank = '<div class="rc-rule"></div><div class="rc-bank">' +
            '<p class="rc-bank-head">Paid by bank transfer</p>' +
            '<div><span>Bank</span><span>' + escapeHtml(shop.bank_name) + '</span></div>' +
            '<div><span>Account name</span><span>' + escapeHtml(shop.bank_account_name) + '</span></div>' +
            '<div><span>Account no.</span><span>' + escapeHtml(shop.bank_account_number) + '</span></div></div>';
    }

    const now = new Date();
    applyReceiptPaper(box, shop);
    box.innerHTML = receiptHtml(shop, {
        registration: registration,
        receiptNo: 'OR-000001',
        meta: [
            { key: 'date', label: 'Date', value: now.toLocaleString('en-PH') },
            { key: 'cashier', label: 'Cashier', value: getCurrentUser() ? staffName(getCurrentUser()) : 'Cashier' },
            { key: 'customer', label: 'Customer', value: 'Walk-in' },
            { key: 'payment', label: 'Payment', value: 'Bank Transfer' },
            { key: 'reference', label: 'Reference', value: 'REF-12345' }
        ],
        itemsHtml: '<tr><td>Sample item<br><span class="rc-qty">1 pc x ' + peso(total) + '</span></td>' +
                   '<td class="rc-amt">' + peso(total) + '</td></tr>',
        itemCount: '1',
        totals: [
            { label: 'Subtotal', value: peso(total) },
            { label: 'Total Due', value: peso(total), due: true },
            { label: 'Tendered', value: peso(total) },
            { label: 'Change', value: peso(0) }
        ],
        taxHtml: tax,
        paid: true,
        bankHtml: bank
    });
}

// prints the preview alone, at the roll's width, to try the printer
function printStorePreview() {
    const form = document.getElementById('store-form');
    if (!form) return;
    renderStorePreview();
    setReceiptPageSize(storeFromForm(form));
    document.body.classList.add('printing-receipt');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-receipt'); }, 400);
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

        // the preview redraws as the boxes are typed into
        const storeForm = document.getElementById('store-form');
        if (storeForm) {
            storeForm.addEventListener('input', (event) => {
                if (event.target && event.target.classList && event.target.id !== 'store-tin') {
                    event.target.classList.remove('is-bad');
                }
                renderStorePreview();
            });
            storeForm.addEventListener('change', renderStorePreview);
        }

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
