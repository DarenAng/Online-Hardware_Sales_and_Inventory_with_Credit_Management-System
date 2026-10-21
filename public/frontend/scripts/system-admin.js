const ADMIN_TITLES = {
    'panel-accounts':    'Staff Directory',
    'panel-archive':     'Archived Accounts',
    'panel-features':    'Access Control',
    'panel-logs':        'Audit Logs',
    'panel-maintenance': 'Backup & Recovery',
    'panel-store':       'Receipt Maintenance'
};

function showPanel(panelId, event) {
    if (event) event.preventDefault();

    const allPanels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < allPanels.length; i++) {
        const panel = allPanels[i];
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    }

    const opened = document.getElementById(panelId);
    const linkedTo = (opened && opened.getAttribute('data-panel-of')) || panelId;
    const links = document.querySelectorAll('[data-panel-link]');
    for (let i = 0; i < links.length; i++) {
        links[i].classList.toggle('active', links[i].dataset.panelLink === linkedTo);
    }

    const heading = document.getElementById('admin-page-title');
    if (heading) heading.textContent = ADMIN_TITLES[panelId] || 'System Administration';

    leaveScreenFurniture();
}

function showAccountsList(event) {
    showPanel('panel-accounts', event);
}

function showAllUsers(event) {
    showPanel('panel-accounts', event);
}

function showCreateAccount(event) {
    if (event) event.preventDefault();
    clearCreateForm();
    showModal('create-modal');
    const first = document.getElementById('create-first');
    if (first) first.focus();
}
function showArchiveModule(event) { showPanel('panel-archive', event); }
function showAuditLogs(event)     { showPanel('panel-logs', event); }
function showMaintenance(event) {
    showPanel('panel-maintenance', event);
    const panel = getDataPanel('admin-backups');
    if (panel) panel.open(); else loadAutoBackupState();
}
function showStoreSettings(event) { showPanel('panel-store', event); loadStoreSettingsForm(); }

function showAccessControl(event) {
    showPanel('panel-features', event);
    if (!featureSaving && featureMatrixChanges().length === 0) loadFeatureMatrix();
}

let systemRoles = [];

async function loadRoles() {
    try {
        const response = await apiGetRoles();
        if (!response.ok) return;

        systemRoles = await response.json();

        let options = '';
        for (let i = 0; i < systemRoles.length; i++) {
            const role = systemRoles[i];
            options += '<option value="' + role.role_id + '">' + escapeHtml(role.role_name) + '</option>';
        }

        const roleSelects = document.querySelectorAll('[data-role-select]');
        for (let i = 0; i < roleSelects.length; i++) {
            roleSelects[i].innerHTML = options;
        }

        const roleFilters = document.querySelectorAll('[data-role-filter]');
        for (let i = 0; i < roleFilters.length; i++) {
            const select = roleFilters[i];
            select.innerHTML = '<option value="all">Every role</option>' + options;

            const users = getDataPanel('admin-users');
            if (users) setBoxValue(select, users.filters.roleId);
        }

        let nameOptions = '';
        for (let i = 0; i < systemRoles.length; i++) {
            const roleName = escapeHtml(systemRoles[i].role_name);
            nameOptions += '<option value="' + roleName + '">' + roleName + '</option>';
        }
        const logFilters = document.querySelectorAll('[data-log-role-filter]');
        for (let i = 0; i < logFilters.length; i++) {
            const select = logFilters[i];
            const chosen = select.value;
            select.innerHTML = '<option value="all">Every role</option>' + nameOptions;
            setBoxValue(select, chosen);
        }
    } catch (error) {
        console.error('Unable to load roles:', error);
    }
}

let selectedUser = null;

function accountCell(user) {
    if (!user.is_active) return '<span class="badge badge-danger">Deactivated</span>';
    if (user.held_until) return '<span class="badge badge-warning" title="Held until ' + escapeHtml(whenText(user.held_until)) + ' after too many wrong passwords">Held</span>';
    return '<span class="badge badge-success">Active</span>';
}

function userSearchFields(user) {
    return [
        user.full_name, user.first_name, user.middle_name, user.last_name,
        user.email, user.role_name, user.staff_id, '#' + user.staff_id
    ];
}

function currentStatusFilter() {
    const select = document.getElementById('accounts-status');
    return select ? select.value : 'all';
}

async function reloadUsers() {
    syncDirectoryColumns();

    const panel = getDataPanel('admin-users');
    if (!panel) return;

    if (panel.state === 'ready') await panel.refresh();
}

function filterDirectory(name, value) {
    dataPanelFilter('admin-users', name, value);
    syncDirectoryColumns();
}

const DIRECTORY_COLUMN = { role: 4, status: 5 };
const LOG_COLUMN = { role: 3 };

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

function syncLogColumns() {
    const hidden = [];
    if (selectValue('logs-role') !== 'all') hidden.push(LOG_COLUMN.role);

    setHiddenColumns(document.getElementById('logs-table'), hidden);
}

function buildUsersPanel() {
    createDataPanel({
        key: 'admin-users',
        inputs: ['accounts-status', 'accounts-role'],
        tableId: 'accounts-table',
        columns: 5,
        pagerId: 'accounts-pager',
        idField: 'staff_id',
        filters: { roleId: 'all' },

        loadOnFilter: false,

        gate: {
            title: 'The directory is not loaded',
            text: 'Set the filters you want, then press Load Data to read the staff ' +
                  'directory, or type a name in the search box to look one person up.',
            button: 'Load Data'
        },

        load: function () {
            const status = currentStatusFilter();
            const query = status === 'all' ? '' : '?status=' + encodeURIComponent(status);
            return apiGetStaff(query);
        },

        match: function (user, query) {
            return prefixMatch(userSearchFields(user), query);
        },

        filter: function (user, filters) {
            if (filters.roleId !== 'all' && String(user.role_id) !== String(filters.roleId)) return false;
            return true;
        },

        renderRow: function (user, index) {
            return '\n' +
                '            <tr class="row-clickable row-reveal" style="animation-delay: ' + ((index % 10) * 28) + 'ms"\n' +
                '                onclick="openUserModal(' + user.staff_id + ')" title="Click to view full details">\n' +
                '                <td class="cell-id">#' + escapeHtml(user.staff_id) + '</td>\n' +
                '                <td class="cell-name">' + escapeHtml(staffName(user)) + '</td>\n' +
                '                <td>' + (user.email ? escapeHtml(user.email) : '<span class="muted">No login account</span>') + '</td>\n' +
                '                <td>' + escapeHtml(user.role_name) + '</td>\n' +
                '                <td>' + accountCell(user) + '</td>\n' +
                '            </tr>';
        }
    });
}

async function openUserModal(staffId) {
    if (editUserDirty() && !(await confirmCloseEditUser())) return;

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
                  '. Lift Hold lets them sign in again now</span>'
                : '')) +
        detailRow('Password State', selectedUser.must_change_password ? '<span class="badge badge-warning">Temporary</span>' : '<span class="badge badge-neutral">Set by user</span>') +
        detailRow('Hired On', escapeHtml(selectedUser.staff_created_at)) +
        detailRow('Account Created', selectedUser.created_at ? escapeHtml(selectedUser.created_at) : '<span class="muted">Not available</span>') +
        detailRow('Last Login', selectedUser.last_login ? escapeHtml(selectedUser.last_login) : '<span class="muted">Never</span>');

    const form = document.getElementById('edit-user-form');
    form.elements.firstName.value = selectedUser.first_name;
    form.elements.middleName.value = selectedUser.middle_name || '';
    form.elements.lastName.value = selectedUser.last_name;
    hideNameErrors(form);
    phoneFill(form.elements.phone, selectedUser.phone);
    setPhoneError(form.elements.phone, '');
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
    document.getElementById('modal-reset-btn').style.display = hasLogin && selectedUser.is_active ? 'inline-block' : 'none';
    document.getElementById('modal-archive-btn').style.display = selectedUser.is_active ? 'none' : 'inline-block';
    document.getElementById('modal-hold-btn').style.display =
        hasLogin && selectedUser.held_until ? 'inline-block' : 'none';

    const own = isOwnAccount(selectedUser);
    document.getElementById('modal-own-note').style.display = own ? 'block' : 'none';
    document.getElementById('modal-edit-tab').style.display = own ? 'none' : '';
    const buttonIds = ['modal-login-btn', 'modal-hold-btn', 'modal-reset-btn', 'modal-status-btn', 'modal-archive-btn'];
    for (let i = 0; i < buttonIds.length; i++) {
        const button = document.getElementById(buttonIds[i]);
        button.disabled = own;
        button.title = own ? 'Another administrator makes changes to your account' : '';
    }

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

async function sendUserRequest(request, successMessage) {
    try {
        const response = await request;
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

    const badName = firstBadName(form);
    if (badName) {
        notifyWarning(nameBoxLabel(form, badName) + ' can only have letters. Take out any numbers or symbols.',
            'Check the name');
        badName.focus();
        return;
    }

    if (!(await checkPhoneFree(form.elements.phone))) {
        form.elements.phone.focus();
        return;
    }

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

    const roleChanged = Number(data.roleId) !== Number(selectedUser.role_id);
    const emailChanged = data.email !== String(selectedUser.email || '').trim().toLowerCase();
    const signsOut = Boolean(selectedUser.user_id) && (roleChanged || emailChanged);

    let consequence = name + ' stays signed in.';
    if (signsOut) {
        consequence = name + ' is signed out now and must sign in again.';
        if (roleChanged) consequence += ' Their menu and permissions become the new role at once.';
        if (emailChanged) consequence += ' They sign in with the new email address.';
    }

    const yes = await askConfirm(consequence, {
        title: 'Save these changes?',
        eyebrow: 'Accounts Management',
        confirmLabel: signsOut ? 'Save and sign them out' : 'Save changes',
        tone: signsOut ? 'danger' : undefined,
        detail: changeListFor(formChangeLines(form))
    });

    if (!yes) return;

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
        yes = await askConfirm(name + ' will be able to sign in again straight away.', {
                title: 'Activate this account?',
                eyebrow: 'Accounts Management',
                confirmLabel: 'Activate'
            });
    } else {
        yes = await askDanger(name + ' loses access to the system.', {
                title: 'Deactivate this account?',
                eyebrow: 'Accounts Management',
                confirmLabel: 'Deactivate the account',
                detail: [
                    'Any session they have open is ended immediately.',
                    'They cannot sign in again until an administrator activates the account.',
                    'It stays in the Staff Directory as Deactivated, and is archived after 30 days.',
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

async function archiveUserAccount() {
    if (!selectedUser) return;

    if (isOwnAccount(selectedUser)) {
        notifyWarning('You cannot archive your own account. Another administrator can.', 'Not allowed');
        return;
    }
    if (selectedUser.is_active) {
        notifyWarning('Only a deactivated account can be archived. Deactivate it first.', 'Account is active');
        return;
    }

    const name = staffName(selectedUser);
    const yes = await askArchive(name + ' (' + selectedUser.role_name + ')', {
        title: 'Archive this account?',
        eyebrow: 'Accounts Management',
        confirmLabel: 'Archive the account',
        detail: [
            'It leaves the Staff Directory and is listed under Archived Accounts.',
            'Their sales, records and history stay on record.',
            'The account can be restored from Archived Accounts.'
        ]
    });
    if (!yes) return;

    const result = await sendUserRequest(apiArchiveStaff(selectedUser.staff_id));
    if (!result) return;

    notifySuccess(name + '\'s account is archived.', 'Account archived');
    const archive = getDataPanel('admin-archive');
    if (archive && archive.state === 'ready') await archive.refresh();
}

async function liftUserHold() {
    if (!selectedUser) return;

    const name = staffName(selectedUser);
    const yes = await askConfirm(
        name + ' can sign in again straight away with the password they already have.',
        {
            title: 'Lift the hold on this account?',
            eyebrow: 'Accounts Management',
            confirmLabel: 'Lift Hold',
            detail: [
                'Their password is not changed.',
                'They get a full set of tries again before another hold.'
            ]
        });
    if (!yes) return;

    const result = await sendUserRequest(apiReleaseHold(selectedUser.staff_id));
    if (result && result.message) notifySuccess(result.message, 'Hold lifted');
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

    if (!selectedUser.is_active) {
        notifyWarning('This account is deactivated. Activate it before resetting its password.', 'Account deactivated');
        return;
    }

    const name = staffName(selectedUser);
    const yes = await askDanger(
        'A new password is made for ' + name + ' and sent to ' + selectedUser.email + '.',
        {
            title: 'Reset this password?',
            eyebrow: 'Accounts Management',
            confirmLabel: 'Reset and send',
            cancelLabel: 'Cancel',
            detail: [
                'Every screen they are signed in on is signed out.',
                'They sign in with the new password and are asked to choose their own.'
            ]
        });

    if (!yes) return;

    const result = await sendUserRequest(apiResetUserPassword(selectedUser.staff_id));
    if (!result) return;

    closeModal('user-modal');
    await reportResetPassword(result, selectedUser.email, name);
}

async function reportResetPassword(result, email, name) {
    if (result.emailed) {
        notifySuccess('A new password was emailed to ' + email + '. ' +
            name + ' must change it the next time they sign in.', 'Password reset');
        return;
    }

    await askConfirm(
        'The password was reset, but the new one could not be sent. Read it out to ' +
        name + ' now: it is not shown again after this card.',
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

const formBaselines = new WeakMap();

function formValues(form) {
    const values = {};
    const fields = form.elements;
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field.name || field.disabled) continue;
        if (field.hasAttribute('data-untracked')) continue;
        if (field.type === 'checkbox') {
            values[field.name] = field.checked;
            continue;
        }
        values[field.name] = String(field.value === undefined ? '' : field.value).trim();
    }

    if (form.id === 'store-form') {
        values.headerLines = readReceiptLines('header');
        values.footerLines = readReceiptLines('footer');
    }
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
    const update = function () {
        syncSaveButton(form, button);
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
}

const CHANGE_VALUE_MAX = 40;
const CHANGE_LINES_MAX = 8;

function clipValue(text) {
    const value = String(text);
    return value.length > CHANGE_VALUE_MAX ? value.slice(0, CHANGE_VALUE_MAX - 1) + '\u2026' : value;
}

function fieldLabelText(form, field) {
    if (field.type === 'checkbox') {
        const wrap = field.closest('label');
        return 'Show ' + (wrap ? wrap.textContent.trim().toLowerCase() : field.name);
    }
    const label = field.id ? form.querySelector('label[for="' + field.id + '"]') : null;
    return label ? label.childNodes[0].textContent.trim() : field.name;
}

function fieldValueText(field, value) {
    if (field.type === 'checkbox') return value ? 'Yes' : 'No';
    if (field.type === 'email') value = String(value).toLowerCase();
    if (field.tagName === 'SELECT') {
        for (let i = 0; i < field.options.length; i++) {
            if (field.options[i].value === String(value)) {
                return clipValue(field.options[i].textContent.trim());
            }
        }
    }
    return value === '' ? '(empty)' : clipValue(value);
}

function formChangeLines(form, skip) {
    const before = JSON.parse(formBaselines.get(form) || '{}');
    const after = JSON.parse(formValues(form));
    const lines = [];

    for (const name in after) {
        if (before[name] === after[name] || (skip && skip(name))) continue;
        const field = form.elements[name];
        if (!field) continue;
        const was = fieldValueText(field, before[name] === undefined ? '' : before[name]);
        const now = fieldValueText(field, after[name]);
        if (was !== now) lines.push(fieldLabelText(form, field) + ': ' + was + ' \u2192 ' + now);
    }
    return lines;
}

function changeListFor(lines) {
    if (lines.length <= CHANGE_LINES_MAX) return lines;
    const more = lines.length - (CHANGE_LINES_MAX - 1);
    return lines.slice(0, CHANGE_LINES_MAX - 1).concat('and ' + more + ' more changes');
}

function askDiscardChanges(message, eyebrow) {
    return askDanger(message, {
        title: 'Discard your changes?',
        eyebrow: eyebrow,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing'
    });
}

function editUserDirty() {
    const form = document.getElementById('edit-user-form');
    const modal = document.getElementById('user-modal');
    return Boolean(form && modal && modal.classList.contains('open') &&
                   formBaselines.has(form) && isFormDirty(form));
}

function storeFormDirty() {
    const form = document.getElementById('store-form');
    const panel = document.getElementById('panel-store');
    return Boolean(form && panel && panel.style.display !== 'none' &&
                   formBaselines.has(form) && isFormDirty(form));
}

async function confirmCloseEditUser() {
    if (!editUserDirty()) return true;
    return askDiscardChanges('The changes made to this account have not been saved. ' +
                             'Closing it now throws them away.', 'Accounts Management');
}

setModalCloseGuard('user-modal', confirmCloseEditUser);

let sidebarLeaveAllowed = false;

document.addEventListener('click', async function (event) {
    const link = event.target.closest && event.target.closest('a[data-panel-link], a.sidebar-brand');
    if (!link) return;
    if (sidebarLeaveAllowed) { sidebarLeaveAllowed = false; return; }
    if (!storeFormDirty() && !editUserDirty()) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const storeOpen = storeFormDirty();
    const yes = await askDiscardChanges(storeOpen
        ? 'The receipt details have not been saved. Leaving this screen throws the changes away.'
        : 'The changes made to this account have not been saved. Leaving this screen throws them away.',
        storeOpen ? 'Receipt Maintenance' : 'Accounts Management');
    if (!yes) return;

    if (!storeOpen) closeModal('user-modal');
    sidebarLeaveAllowed = true;
    link.click();
}, true);

window.addEventListener('beforeunload', function (event) {
    if (!localStorage.getItem('currentUser')) return;
    if (!storeFormDirty() && !editUserDirty()) return;
    event.preventDefault();
    event.returnValue = '';
});

function clearCreateForm() {
    const form = document.getElementById('create-user-form');
    if (!form) return;

    form.reset();

    const phone = form.elements.phone;
    if (phone) phoneFill(phone, '');

    setPhoneError(form.elements.phone, '');
    setEmailError(form.elements.email, '');
    hideNameErrors(form);
}

function hideNameErrors(form) {
    const boxes = form.querySelectorAll('.name-error');
    for (let i = 0; i < boxes.length; i++) {
        boxes[i].hidden = true;
    }
}

function cancelCreateAccount() {
    clearCreateForm();
    closeModal('create-modal');
}

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

function onEmailInput(input) {
    const cleaned = input.value.replace(/\s+/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    setEmailError(input, '');
}

async function checkEmailFree(input) {
    if (!input) return true;
    const email = input.value.trim();

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

        if (input.value.trim() !== email) return true;

        if (answer && answer.taken) {
            setEmailError(input, 'This email is already used by another account (' + answer.roleName + ').');
            return false;
        }
    } catch (error) {
    }
    setEmailError(input, '');
    return true;
}

function setPhoneError(input, text) {
    if (!input) return;
    const box = document.getElementById(input.id + '-error');
    const badlyWritten = input.value !== '' && phoneComplaint(input) !== null;
    input.classList.toggle('is-bad', Boolean(text) || badlyWritten);
    if (box) {
        box.textContent = text || '';
        box.hidden = !text;
    }
}

async function checkPhoneFree(input) {
    if (!input) return true;
    const phone = phoneToStore(input);

    if (phone === '' || phoneComplaint(input) !== null) {
        setPhoneError(input, '');
        return true;
    }

    const own = input.id === 'edit-phone' && selectedUser &&
        phoneToStore(selectedUser.phone) === phone;
    if (own) {
        setPhoneError(input, '');
        return true;
    }

    try {
        const answer = await apiCheckPhone(phone, input.id === 'edit-phone' && selectedUser ? selectedUser.staff_id : null);

        if (phoneToStore(input) !== phone) return true;

        if (answer && answer.taken) {
            setPhoneError(input, 'This number is already used by ' + answer.name + ' (' + answer.roleName + ').');
            return false;
        }
    } catch (error) {
    }
    setPhoneError(input, '');
    return true;
}

function firstEmptyRequired(form) {
    const fields = form.querySelectorAll('[required]');
    for (let i = 0; i < fields.length; i++) {
        if (String(fields[i].value || '').trim() === '') return fields[i];
    }
    return undefined;
}

async function reportFirstPassword(result, email, name) {
    if (result.emailed) {
        notifySuccess('The first password was emailed to ' + email + '. ' +
            name + ' must change it the first time they sign in.', 'Account created');
        return;
    }

    await askConfirm(
        'The account exists, but the password could not be sent. Read it out to ' +
        name + ' now: it is not shown again after this card.',
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

function creatingCard(review) {
    return {
        title: 'Creating the account',
        eyebrow: 'Accounts Management',
        message: review.willEmail
            ? 'This can take a few seconds while the mail goes out.'
            : 'Mail is not set up, so the password comes back to this screen.',
        steps: review.willEmail
            ? ['Saving ' + review.fullName + '\'s account',
               'Emailing the first password to ' + review.email,
               'Writing it in the audit trail']
            : ['Saving ' + review.fullName + '\'s account',
               'Writing it in the audit trail']
    };
}

const NAME_LETTERS = /^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u;

function onNameInput(input) {
    const typed = input.value;
    const cleaned = typed.replace(/[^\p{L}\p{M} ]/gu, '');
    const box = document.getElementById(input.id + '-error');

    if (cleaned !== typed) {
        const cursor = Math.max(0, input.selectionStart - (typed.length - cleaned.length));
        input.value = cleaned;
        input.setSelectionRange(cursor, cursor);
        if (box) {
            box.textContent = 'Letters only. Numbers and symbols cannot be typed here.';
            box.hidden = false;
        }
    } else if (box) {
        box.hidden = true;
    }
}

function firstBadName(form) {
    const fields = ['firstName', 'middleName', 'lastName'];
    for (let i = 0; i < fields.length; i++) {
        const input = form.elements[fields[i]];
        const value = input.value.trim().replace(/\s+/g, ' ');
        if (value !== '' && !NAME_LETTERS.test(value)) return input;
    }
    return null;
}

function nameBoxLabel(form, input) {
    const label = form.querySelector('label[for="' + input.id + '"]');
    return label ? label.childNodes[0].textContent.trim() : 'This name';
}

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

    const badName = firstBadName(form);
    if (badName) {
        notifyWarning(nameBoxLabel(form, badName) + ' can only have letters. Take out any numbers or symbols.',
            'Check the name');
        badName.focus();
        return;
    }

    const phoneProblem = phoneComplaint(form.elements.phone);
    if (phoneProblem) {
        notifyWarning(phoneProblem, 'Check the phone number');
        form.elements.phone.focus();
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'Checking...'; }
    const phoneFree = await checkPhoneFree(form.elements.phone);
    if (!phoneFree) {
        if (button) { button.disabled = false; button.textContent = 'Create'; }
        form.elements.phone.focus();
        return;
    }

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

        const panel = getDataPanel('admin-users');
        if (panel) {
            if (panel.state === 'ready') await panel.refresh(); else await panel.open();
        }

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
        message: name + ' has a staff record but no way to sign in yet. The first password is sent to this address.',
        label: 'Email address',
        type: 'email',
        placeholder: 'name@example.com',
        confirmLabel: 'Create Login',
        check: function (value) {
            return emailComplaint(value);
        }
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
            text: 'Press Load Data to read the archived staff accounts, or type a name.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetStaff('?status=archived');
        },

        match: function (user, query) {
            return prefixMatch(userSearchFields(user), query);
        },

        renderRow: function (user, index) {
            return '\n' +
                '            <tr class="row-clickable row-reveal" style="animation-delay: ' + ((index % 10) * 28) + 'ms"\n' +
                '                onclick="openRestoreCard(' + user.staff_id + ')" title="Click to open the restoration card">\n' +
                '                <td class="cell-id">#' + escapeHtml(user.staff_id) + '</td>\n' +
                '                <td class="cell-name">' + escapeHtml(staffName(user)) + '</td>\n' +
                '                <td>' + (user.email ? escapeHtml(user.email) : '<span class="muted">No login account</span>') + '</td>\n' +
                '                <td>' + escapeHtml(user.role_name) + '</td>\n' +
                '                <td>' + (user.archived_at ? escapeHtml(user.archived_at) : '<span class="muted">Not recorded</span>') + '</td>\n' +
                '            </tr>';
        }
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
        name + ' goes back on the active staff list as a ' + user.role_name + '.',
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

let featureMatrix = null;
let featureRoleId = null;
let featureSaving = false;

function featureCellState(cell) {
    if (!cell.available) return 'unavailable';
    if (cell.held === cell.byDefault) return 'default';
    if (cell.held) return 'granted';
    return 'revoked';
}

function featureStateWord(state, on) {
    if (state === 'unavailable' || state === 'default') return '';
    if (on) return 'switched on';
    return 'switched off';
}

function featureStateOf(byDefault, on) {
    if (on === byDefault) return 'default';
    if (on) return 'granted';
    return 'revoked';
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

function renderFeatureRoleList(roles) {
    const select = document.getElementById('features-role');
    if (!select) return;

    let found = false;
    for (let i = 0; i < roles.length; i++) {
        if (roles[i].role_id === featureRoleId) found = true;
    }
    if (!found) {
        featureRoleId = roles.length > 0 ? roles[0].role_id : null;
    }

    let html = '';
    for (let i = 0; i < roles.length; i++) {
        html += '<option value="' + escapeHtml(String(roles[i].role_id)) + '"' +
            ' data-name="' + escapeHtml(roles[i].role_name) + '">' + escapeHtml(roles[i].role_name) + '</option>';
    }
    select.innerHTML = html;
    if (featureRoleId !== null) select.value = String(featureRoleId);
}

function selectFeatureRole(value) {
    featureRoleId = Number(value);
    showFeatureRole();
}

function showFeatureRole() {
    const strips = document.querySelectorAll('#features-matrix .feature-strip');
    for (let i = 0; i < strips.length; i++) {
        strips[i].hidden = Number(strips[i].dataset.role) !== featureRoleId;
    }

    const select = document.getElementById('features-role');
    if (select && featureRoleId !== null && select.value !== String(featureRoleId)) {
        select.value = String(featureRoleId);
    }

    syncFeatureRoleNote();
    filterFeatureScreens();
}

function featureBaseline() {
    const mount = document.getElementById('features-matrix');
    if (mount && mount.dataset.baseline) return JSON.parse(mount.dataset.baseline);
    return {};
}

function syncFeatureRoleNote() {
    const before = featureBaseline();

    const strips = document.querySelectorAll('#features-matrix .feature-strip');
    for (let i = 0; i < strips.length; i++) {
        const strip = strips[i];
        const boxes = strip.querySelectorAll('.feature-box');
        let unsaved = false;
        for (let b = 0; b < boxes.length; b++) {
            if (before[boxes[b].dataset.feature + '|' + boxes[b].dataset.role] !== boxes[b].checked) unsaved = true;
        }

        const option = document.querySelector('#features-role option[value="' + strip.dataset.role + '"]');
        if (option) {
            const text = option.dataset.name + (unsaved ? ' (changed)' : '');
            if (option.textContent !== text) option.textContent = text;
        }
    }
}

function featureRowHtml(feature, role) {
    const cell = feature.roles[role.role_name];
    const state = featureCellState(cell);
    const word = featureStateWord(state, cell.held);

    let who = '';
    if (cell.overridden && cell.grantedBy) {
        who = (cell.held ? 'Granted' : 'Switched off') + ' by ' + cell.grantedBy +
              (cell.updatedAt ? ' ' + whenText(cell.updatedAt) : '') + '.';
    }

    return '<label class="feature-row"' + (who ? ' title="' + escapeHtml(who) + '"' : '') +
            ' data-search="' + escapeHtml((feature.name + ' ' + feature.module + ' ' + (feature.description || '')).toLowerCase()) + '">' +
            '<span class="feature-row-text">' +
                '<span class="feature-row-name">' + escapeHtml(feature.name) + '</span>' +
                '<span class="feature-desc">' + escapeHtml(feature.description || '') + '</span>' +
            '</span>' +
            '<span class="feature-state is-' + state + '"' + (word ? '' : ' hidden') + '>' + word + '</span>' +
            '<input type="checkbox" class="feature-box" data-feature="' + escapeHtml(feature.key) + '"' +
                ' data-role="' + escapeHtml(String(role.role_id)) + '"' +
                ' data-role-name="' + escapeHtml(role.role_name) + '"' +
                ' data-default="' + (cell.byDefault ? '1' : '') + '"' +
                (cell.held ? ' checked' : '') +
                ' aria-label="' + escapeHtml(feature.name + ' for ' + role.role_name) + '"' +
                ' onchange="onFeatureBoxChange(this)">' +
            '<span class="feature-default' + (cell.byDefault ? '' : ' is-empty') + '"' +
                (cell.byDefault ? ' title="' + escapeHtml(role.role_name) + ' accounts have this screen by default"' : ' aria-hidden="true"') + '>' +
                'Default</span>' +
        '</label>';
}

function renderFeatureMatrix() {
    const mount = document.getElementById('features-matrix');
    if (!mount || !featureMatrix) return;

    const roles = featureMatrix.roles || [];
    const features = featureMatrix.features || [];

    renderFeatureRoleList(roles);

    const modules = [];
    for (let i = 0; i < features.length; i++) {
        if (!modules.includes(features[i].module)) modules.push(features[i].module);
    }

    let html = '';
    for (let r = 0; r < roles.length; r++) {
        const role = roles[r];
        let line = '';
        for (let m = 0; m < modules.length; m++) {
            let rows = '';
            for (let f = 0; f < features.length; f++) {
                const feature = features[f];
                const cell = feature.roles[role.role_name];
                if (feature.module === modules[m] && cell) {
                    rows += featureRowHtml(feature, role);
                }
            }
            if (rows !== '') {
                line += '<div class="feature-group">' +
                    '<span class="feature-module">' + escapeHtml(modules[m]) + '</span>' +
                    rows + '</div>';
            }
        }

        html += '<div class="feature-strip" data-role="' + escapeHtml(String(role.role_id)) + '"' +
                (role.role_id === featureRoleId ? '' : ' hidden') + '>' +
                '<div class="feature-line">' +
                    (line || '<span class="muted">This role\'s dashboard has no screens to switch.</span>') +
                '</div>' +
            '</div>';
    }
    mount.innerHTML = html;

    mount.dataset.baseline = readFeatureMatrix();

    showFeatureRole();
    syncFeatureSaveButton();
}

function filterFeatureScreens(query) {
    let wanted = query;
    if (wanted === undefined) {
        const input = document.getElementById('features-search');
        wanted = input ? input.value : '';
    }
    wanted = String(wanted).trim().toLowerCase();

    const groups = document.querySelectorAll('#features-matrix .feature-group');
    for (let g = 0; g < groups.length; g++) {
        const rows = groups[g].querySelectorAll('.feature-row');
        let shown = 0;
        for (let r = 0; r < rows.length; r++) {
            const match = wanted === '' || startsAWord(rows[r].dataset.search || '', wanted);
            rows[r].hidden = !match;
            if (match) shown += 1;
        }
        groups[g].hidden = shown === 0;
    }

    const strip = document.querySelector('#features-matrix .feature-strip:not([hidden])');
    const none = document.getElementById('features-no-match');
    if (none) {
        none.hidden = !strip || wanted === '' ||
            strip.querySelector('.feature-group:not([hidden])') !== null;
    }
}

function readFeatureMatrix() {
    const cells = {};
    const boxes = document.querySelectorAll('#features-matrix .feature-box');
    for (let i = 0; i < boxes.length; i++) {
        cells[boxes[i].dataset.feature + '|' + boxes[i].dataset.role] = boxes[i].checked;
    }
    return JSON.stringify(cells);
}

function onFeatureBoxChange(box) {
    const state = featureStateOf(box.dataset.default === '1', box.checked);
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
    if (!mount || !mount.dataset.baseline || !featureMatrix) return [];

    const before = featureBaseline();
    const features = featureMatrix.features || [];
    const changes = [];

    const boxes = document.querySelectorAll('#features-matrix .feature-box');
    for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (before[box.dataset.feature + '|' + box.dataset.role] === box.checked) continue;

        let name = box.dataset.feature;
        for (let f = 0; f < features.length; f++) {
            if (features[f].key === box.dataset.feature) name = features[f].name;
        }
        changes.push({
            key: box.dataset.feature,
            name: name,
            roleId: Number(box.dataset.role),
            roleName: box.dataset.roleName,
            byDefault: box.dataset.default === '1',
            granted: box.checked
        });
    }

    return changes;
}

function syncFeatureSaveButton() {
    const button = document.getElementById('features-save-btn');
    if (!button) return;
    const changes = featureMatrixChanges();
    button.disabled = changes.length === 0 || featureSaving;
    button.title = changes.length === 0 ? 'Nothing has changed yet' : '';

    const discard = document.getElementById('features-discard-btn');
    if (discard) discard.disabled = changes.length === 0 || featureSaving;

    const note = document.getElementById('features-change-note');
    if (note) {
        note.textContent = changes.length === 0
            ? 'No changes yet'
            : changes.length + (changes.length === 1 ? ' change' : ' changes') + ' not confirmed yet';
        note.classList.toggle('has-changes', changes.length > 0);
    }
}

function discardFeatureChanges() {
    if (featureSaving) return;
    renderFeatureMatrix();
}

function featureScreenOpen() {
    const panel = document.getElementById('panel-features');
    return Boolean(panel) && panel.style.display !== 'none';
}

document.addEventListener('click', async function (event) {
    const link = event.target.closest ? event.target.closest('.sidebar-nav a, .sidebar-brand') : null;
    if (!link || link.dataset.leaveChecked === '1') return;
    if (!featureScreenOpen() || featureSaving || featureMatrixChanges().length === 0) return;
    if (link.dataset.panelLink === 'panel-features') return;
    if (event.target.closest('.nav-caret')) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const count = featureMatrixChanges().length;
    const leave = await askConfirm(
        'You have ' + count + (count === 1 ? ' change' : ' changes') + ' to Access Control that ' +
        (count === 1 ? 'is' : 'are') + ' not confirmed yet.',
        {
            title: 'Discard your changes?',
            eyebrow: 'Access Control',
            mark: '!',
            confirmLabel: 'Discard Changes',
            cancelLabel: 'Keep Editing',
            tone: 'danger'
        });
    if (!leave) return;

    discardFeatureChanges();
    link.dataset.leaveChecked = '1';
    try {
        link.click();
    } finally {
        delete link.dataset.leaveChecked;
    }
}, true);

window.addEventListener('beforeunload', function (event) {
    if (featureScreenOpen() && !featureSaving && featureMatrixChanges().length > 0) {
        event.preventDefault();
        event.returnValue = '';
    }
});

async function saveFeatureMatrix() {
    const changes = featureMatrixChanges();
    if (changes.length === 0) {
        notifyInfo('Nothing on this screen has been changed, so there is nothing to confirm.', 'No changes');
        return;
    }

    const byRole = [];
    for (let i = 0; i < changes.length; i++) {
        let group = null;
        for (let g = 0; g < byRole.length; g++) {
            if (byRole[g].roleName === changes[i].roleName) group = byRole[g];
        }
        if (!group) {
            group = { roleName: changes[i].roleName, lines: [] };
            byRole.push(group);
        }
        group.lines.push(changes[i]);
    }

    let html = '<div class="ask-config">';
    for (let g = 0; g < byRole.length; g++) {
        html += '<div class="ask-config-role">' +
            '<span class="ask-config-line">Role: <strong>' + escapeHtml(byRole[g].roleName) + '</strong></span>' +
            '<span class="ask-config-line">Access:</span><ul>';
        for (let l = 0; l < byRole[g].lines.length; l++) {
            const change = byRole[g].lines[l];
            html += '<li>' + escapeHtml(change.name) + ' - ' +
                (change.granted ? '<span class="is-on">turned on</span>' : '<span class="is-off">turned off</span>') + '</li>';
        }
        html += '</ul></div>';
    }
    html += '</div>';

    const yes = await askConfirm('', {
        title: 'Confirm access control configuration',
        eyebrow: 'Access Control',
        messageHtml: html,
        confirmLabel: 'Confirm Configuration',
        cancelLabel: 'Cancel'
    });
    if (!yes) return;

    const button = document.getElementById('features-save-btn');
    if (button) { button.disabled = true; button.textContent = 'Saving...'; }
    featureSaving = true;

    let saved = 0;
    let stopped = false;

    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        try {
            const response = await apiSetScreenSwitch(change.key, change.roleId, change.granted);
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

    featureSaving = false;
    if (button) { button.textContent = 'Confirm Configuration'; }

    if (saved > 0) {
        let text = saved + ' ' + (saved === 1 ? 'change' : 'changes') + ' to the screens by role ';
        if (stopped) {
            text += 'were saved before one was refused.';
        } else {
            text += 'saved and written to the audit trail.';
        }
        notifySuccess(text, stopped ? 'Partly saved' : 'Configuration saved');
    }

    await loadFeatureMatrix();
}

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

    const role = document.getElementById('logs-role');
    if (role && role.value !== 'all') parts.push('role=' + encodeURIComponent(role.value));

    const from = document.getElementById('logs-from');
    if (from && from.value) parts.push('from=' + encodeURIComponent(from.value));

    const to = document.getElementById('logs-to');
    if (to && to.value) parts.push('to=' + encodeURIComponent(to.value));

    return parts.length ? '?' + parts.join('&') : '';
}

function keepSavedLogRole() {
    const select = document.getElementById('logs-role');
    const saved = (readLoadedPanels()[thisPageName()] || {})['admin-logs'];
    const role = saved && saved.inputs ? saved.inputs['logs-role'] : '';

    if (!select || !role || role === 'all') return;
    select.add(new Option(role, role));
    select.value = role;
}

const LOG_PERIODS = [
    ['all', 'All time', null],
    ['today', 'Today', 0],
    ['7d', 'Last 7 days', 6],
    ['30d', 'Last 30 days', 29],
    ['90d', 'Last 90 days', 89],
    ['6m', 'Last 6 months', 182],
    ['12m', 'Last 12 months', 364]
];

function isoDayBefore(days) {
    const day = new Date();
    day.setDate(day.getDate() - days);
    return day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' +
        String(day.getDate()).padStart(2, '0');
}

function logPeriodDates(value) {
    for (let i = 0; i < LOG_PERIODS.length; i++) {
        if (LOG_PERIODS[i][0] !== value) continue;
        if (LOG_PERIODS[i][2] === null) return { from: '', to: '' };
        return { from: isoDayBefore(LOG_PERIODS[i][2]), to: isoDayBefore(0) };
    }
    return null;
}

function showLogDates(show) {
    const ids = ['logs-from', 'logs-to'];
    for (let i = 0; i < ids.length; i++) {
        const box = document.getElementById(ids[i]);
        const field = box ? box.closest('.toolbar-field') : null;
        if (field) field.hidden = !show;
    }
}

function buildLogPeriodBox() {
    const select = document.getElementById('logs-period');
    if (!select) return;
    let html = '';
    for (let i = 0; i < LOG_PERIODS.length; i++) {
        html += '<option value="' + LOG_PERIODS[i][0] + '">' + escapeHtml(LOG_PERIODS[i][1]) + '</option>';
    }
    html += '<option value="custom">Custom date...</option>';
    select.innerHTML = html;
    select.value = 'all';
    syncLogPeriodBox();
}

function logPeriodPicked() {
    const select = document.getElementById('logs-period');
    if (!select) return;
    if (select.value === 'custom') {
        showLogDates(true);
        const from = document.getElementById('logs-from');
        if (from) from.focus();
        return;
    }
    showLogDates(false);
    const dates = logPeriodDates(select.value);
    document.getElementById('logs-from').value = dates.from;
    document.getElementById('logs-to').value = dates.to;
    refreshAuditLogs();
}

function logDatesPicked() {
    const from = document.getElementById('logs-from').value;
    const to = document.getElementById('logs-to').value;
    if (!from || !to) return;
    if (from > to) {
        notifyWarning('The start date is after the end date. Swap them and try again.', 'That range runs backwards');
        return;
    }
    refreshAuditLogs();
}

function syncLogPeriodBox() {
    const select = document.getElementById('logs-period');
    const from = document.getElementById('logs-from');
    const to = document.getElementById('logs-to');
    if (!select || !from || !to) return;
    if (select.value !== 'custom') {
        const dates = logPeriodDates(select.value);
        if (!dates || dates.from !== from.value || dates.to !== to.value) select.value = 'custom';
    }
    showLogDates(select.value === 'custom');
}

function toggleLogExportMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('logs-export-menu');
    if (!menu) return;
    const list = menu.querySelector('.export-menu-list');
    const toggle = menu.querySelector('.export-toggle');
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
}

function closeLogExportMenu() {
    const menu = document.getElementById('logs-export-menu');
    if (!menu) return;
    menu.querySelector('.export-menu-list').hidden = true;
    menu.querySelector('.export-toggle').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function (event) {
    if (!event.target.closest || !event.target.closest('.export-menu-list .btn')) {
        if (event.target.closest && event.target.closest('#logs-export-menu')) return;
    }
    closeLogExportMenu();
});
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeLogExportMenu();
});

async function refreshAuditLogs() {
    syncLogColumns();

    const panel = getDataPanel('admin-logs');
    if (panel) await panel.open();
}

function buildLogsPanel() {
    createDataPanel({
        key: 'admin-logs',
        inputs: ['logs-role', 'logs-period', 'logs-from', 'logs-to'],
        tableId: 'logs-table',
        columns: 6,
        pagerId: 'logs-pager',
        idField: 'log_id',

        gate: {
            title: 'The audit trail is not loaded',
            text: 'Pick a period or a role, then press Load Data. ' +
                  'Nothing is read from the trail until you ask for it.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetAuditLogs(auditLogQuery());
        },

        match: function (log, query) {
            return prefixMatch([
                log.staff_name, log.role_name, log.action, log.details, log.ip_address
            ], query);
        },

        renderRow: function (log, index) {
            const tone = AUDIT_TONE[log.action_type] || 'badge-neutral';
            const label = AUDIT_LABEL[log.action_type] || log.action_type;

            return '\n' +
                '            <tr class="row-clickable row-reveal" style="animation-delay: ' + ((index % 10) * 28) + 'ms"\n' +
                '                onclick="openLogEntry(' + log.log_id + ')" title="Click to read the full entry">\n' +
                '                <td class="cell-id">' + escapeHtml(log.created_at) + '</td>\n' +
                '                <td class="cell-name">' + escapeHtml(log.staff_name) +
                    (log.staff_id ? ' <span class="muted">#' + escapeHtml(log.staff_id) + '</span>' : '') + '</td>\n' +
                '                <td>' + escapeHtml(log.role_name) + '</td>\n' +
                '                <td class="cell-id">' + (log.ip_address ? escapeHtml(log.ip_address) : '<span class="muted">Not recorded</span>') + '</td>\n' +
                '                <td><span class="badge ' + tone + '">' + escapeHtml(label) + '</span></td>\n' +
                '                <td>' + escapeHtml(log.details || log.action) + '</td>\n' +
                '            </tr>';
        }
    });
}

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
    return { day: day, time: parts[4] + ':' + parts[5] };
}

function hourText(hour) {
    return String(Number(hour) || 0).padStart(2, '0') + ':00';
}

function renderAutoBackupCard(auto, procedures) {
    const card = document.getElementById('auto-backup-card');
    const state = document.getElementById('auto-backup-state');
    const text = document.getElementById('auto-backup-text');
    if (!card || !state || !text) return;

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

    if (procedures && typeof procedures.loaded === 'number' && procedures.loaded < procedures.expected) {
        card.className = 'card auto-backup is-bad';
        state.textContent = 'Read this';
        text.textContent = 'Only ' + procedures.loaded + ' of ' + procedures.expected + ' stored procedures are loaded, ' +
            'so backups cannot run. Run 2-RUN-SECOND-stored-procedures.sql, then reload.';
        return;
    }

    if (!auto.enabled) {
        card.className = 'card auto-backup is-off';
        state.textContent = 'Off';
        text.textContent = 'Daily backup is off. Only Run Backup Now saves a backup.';
        return;
    }

    if (auto.lastError) {
        card.className = 'card auto-backup is-bad';
        state.textContent = 'Failing';
        text.textContent = 'Last daily backup failed: ' + auto.lastError + '. ' +
            'Take one by hand until it is fixed.';
        return;
    }

    card.className = 'card auto-backup is-on';
    state.textContent = 'On';
    text.textContent = 'Backs up daily at ' + hourText(auto.hour) + ' and deletes backups older than ' + auto.keep + ' days.' +
        (auto.lastFileName ? ' Latest: ' + auto.lastFileName + '.' : '');
}

function renderBackupLimits(limits) {
    const note = document.getElementById('backup-limit-note');
    if (!note || !limits) return;
    note.textContent = limits.manualCount + ' of ' + limits.manual + ' manual backups used. ' +
        'Backups older than ' + limits.keepDays + ' days are deleted automatically.';
}

async function loadAutoBackupState() {
    try {
        const body = await apiGetBackups();
        renderAutoBackupCard(body.auto, body.procedures);
        renderBackupLimits(body.limits);
    } catch (error) {
        renderAutoBackupCard(null);
    }
}

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
        await loadAutoBackupState();
    }
}

function buildBackupPanel() {
    createDataPanel({
        key: 'admin-backups',
        remember: false,
        tableId: 'backup-table',
        columns: 6,
        pagerId: 'backup-pager',
        idField: 'fileName',

        gate: {
            title: 'Reading the backup folder',
            text: 'The saved backups load as soon as this screen opens.',
            button: 'Load Data'
        },

        load: async function () {
            const body = await apiGetBackups();
            renderAutoBackupCard(body.auto, body.procedures);
            renderBackupLimits(body.limits);
            return body.files || [];
        },

        match: function (file, query) {
            return prefixMatch([file.fileName], query);
        },

        filters: { folder: 'all' },
        filter: function (file, filters) {
            if (filters.folder === 'manual') return !file.automatic;
            if (filters.folder === 'automatic') return file.automatic;
            return true;
        },

        renderRow: function (file, index) {
            const when = backupTakenAt(file.fileName);

            let kind;
            if (file.automatic) {
                kind = '<span class="badge badge-neutral">Automatic</span>';
            } else {
                kind = '<span class="badge badge-success">Manual</span>';
            }

            return '<tr class="row-clickable row-reveal" style="animation-delay:' +
                    (index % 10) * 28 + 'ms" ' +
                    'onclick="openBackupDrawer(' + index + ')" ' +
                    'title="Click to download, restore or delete this backup">' +
                '<td><span class="backup-day">' + escapeHtml(when.day) + '</span></td>' +
                '<td><span class="backup-time">' + escapeHtml(when.time) + '</span></td>' +
                '<td class="cell-id">' + escapeHtml(file.fileName) + '</td>' +
                '<td>' + kind + '</td>' +
                '<td>' + backupMadeBy(file) + '</td>' +
                '<td class="cell-num">' + escapeHtml(formatBytes(file.bytes)) + '</td>' +
                '</tr>';
        }
    });
}

function backupMadeBy(file) {
    if (file.madeBy) return escapeHtml(file.madeBy);
    return '<span class="muted">Not recorded</span>';
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
        detailRow('Kind', selectedBackup.automatic ? 'Automatic' : 'Manual') +
        detailRow('Made By', backupMadeBy(selectedBackup));

    const deleteButton = document.getElementById('backup-delete-btn');
    if (deleteButton) deleteButton.hidden = Boolean(selectedBackup.automatic);
    const autoNote = document.getElementById('backup-auto-note');
    if (autoNote) autoNote.hidden = !selectedBackup.automatic;

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
    if (button) button.disabled = true;

    showWorking({
        title: 'Backing up data',
        eyebrow: 'Backup',
        message: 'Please wait while the system saves a copy of everything. Do not close this page.',
        steps: ['Reading every table, view and procedure', 'Writing the backup file', 'Writing it in the audit trail']
    });

    let body = null;
    try {
        const response = await apiMakeBackup();
        body = await response.json();

        if (!response.ok) {
            hideWorking();
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Backup failed');
            return;
        }

        await finishWorking('Backup saved');
        notifySuccess(
            body.fileName + ' holds ' + body.rowCount + ' rows across ' + body.tableCount + ' tables, ' +
            body.viewCount + ' views and ' + body.procedureCount + ' procedures (' + formatBytes(body.bytes) + ').',
            'Backup saved');

        const panel = getDataPanel('admin-backups');
        if (panel) await panel.open();
    } catch (error) {
        hideWorking();
        notifyOffline();
    } finally {
        if (button) button.disabled = false;
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
        'Everything in the system will be replaced by the data as it stood on ' + when.day + ' at ' + when.time + '.',
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
    if (!selectedBackup || selectedBackup.automatic) return;

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
        'Everything in the system will be replaced by whatever ' + file.name + ' contains.',
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

let storeSettings = null;

const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

function tinDigits(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\D/g, '')
        .slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
}

function tinFormat(digits) {
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9)];
    const used = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] !== '') used.push(parts[i]);
    }
    return used.join('-');
}

function onTinInput(input) {
    if (!input) return;

    const shaped = tinFormat(tinDigits(input.value));
    if (shaped !== input.value) input.value = shaped;

    input.classList.toggle('is-bad', shaped !== '' && tinComplaint(shaped) !== null);
}

function tinComplaint(value) {
    const digits = tinDigits(value);

    if (digits === '') {
        return 'The shop needs a TIN. It is printed on every invoice.';
    }

    if (digits.length !== TIN_BASE_DIGITS &&
        digits.length !== TIN_BASE_DIGITS + 3 &&
        digits.length !== TIN_BASE_DIGITS + TIN_BRANCH_DIGITS) {
        return 'A TIN is ' + TIN_BASE_DIGITS + ' digits and a branch code, ' +
               'written 000-000-000-00000. That one has ' + digits.length + ' digits.';
    }

    if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
        return '000-000-000 is the placeholder, not a TIN. Enter the number on the ' +
               'shop\'s BIR certificate of registration.';
    }

    return null;
}

function tinToStore(value) {
    const digits = tinDigits(value);
    if (tinComplaint(digits) !== null) return String(value || '').trim();

    const base = digits.slice(0, TIN_BASE_DIGITS);
    const branch = digits.slice(TIN_BASE_DIGITS).padStart(TIN_BRANCH_DIGITS, '0');
    return tinFormat(base + branch);
}

const RECEIPT_SWITCHES = ['proprietor', 'cashier', 'customer', 'payment', 'reference',
                          'item_count', 'tax', 'bank', 'note'];
const RECEIPT_LINE_MAX = 10;
const RECEIPT_LINE_LENGTH = 80;

async function resetStoreForm() {
    if (storeFormDirty() &&
        !(await askDiscardChanges('Reset puts back the details as last saved. ' +
                                  'The changes made since then are thrown away.', 'Receipt Maintenance'))) {
        return;
    }
    await loadStoreSettingsForm();
}

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

    const rate = Number(storeSettings.vat_rate) || 0;
    form.elements.vatRate.value = rate > 0 ? rate : 12;

    const layout = receiptLayoutOf(storeSettings);
    form.elements.paperWidth.value = String(layout.paperWidth);
    form.elements.fontSize.value = String(layout.fontSize);
    form.elements.title.value = layout.title;
    for (let i = 0; i < RECEIPT_SWITCHES.length; i++) {
        const name = RECEIPT_SWITCHES[i];
        const box = form.elements['show_' + name];
        if (box) box.checked = receiptShows(layout, name);
    }
    renderReceiptLines('header', layout.headerLines);
    renderReceiptLines('footer', layout.footerLines);

    onBankInput();
    onRegistrationChange(form.elements.registrationType.value);

    showStoreVerdict('');
    markFormClean(form, document.getElementById('store-save-btn'));
}

function receiptLineList(kind) {
    return document.getElementById('store-' + kind + '-lines');
}

function readReceiptLines(kind) {
    const list = receiptLineList(kind);
    if (!list) return [];
    const inputs = list.querySelectorAll('input');
    const lines = [];
    for (let i = 0; i < inputs.length; i++) {
        const value = inputs[i].value.trim();
        if (value !== '') lines.push(value);
    }
    return lines;
}

function renderReceiptLines(kind, lines) {
    const list = receiptLineList(kind);
    if (!list) return;

    const values = Array.isArray(lines) ? lines : [];
    let html = '';
    for (let index = 0; index < values.length; index++) {
        const line = values[index];

        let arrows = '';
        if (kind === 'header') {
            arrows =
                '<button type="button" class="btn btn-ghost btn-sm" title="Move up" aria-label="Move up"' +
                    (index === 0 ? ' disabled' : '') + ' onclick="moveReceiptLine(\'' + kind + '\', ' + index + ', -1)">&uarr;</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" title="Move down" aria-label="Move down"' +
                    (index === values.length - 1 ? ' disabled' : '') + ' onclick="moveReceiptLine(\'' + kind + '\', ' + index + ', 1)">&darr;</button>';
        }

        html += '<div class="line-row">' +
            '<input type="text" class="form-control" name="' + kind + 'Line_' + index + '" data-untracked' +
                ' maxlength="' + RECEIPT_LINE_LENGTH + '" value="' + escapeHtml(line) + '"' +
                ' aria-label="' + (kind === 'header' ? 'Header' : 'Footer') + ' line ' + (index + 1) + '">' +
            arrows +
            '<button type="button" class="btn btn-ghost btn-sm line-remove" title="Remove" aria-label="Remove"' +
                ' onclick="removeReceiptLine(\'' + kind + '\', ' + index + ')">&times;</button>' +
        '</div>';
    }
    list.innerHTML = html;
}

function typedReceiptLines(kind) {
    const list = receiptLineList(kind);
    const lines = [];
    if (list) {
        const inputs = list.querySelectorAll('input');
        for (let i = 0; i < inputs.length; i++) {
            lines.push(inputs[i].value);
        }
    }
    return lines;
}

function receiptLinesChanged(kind, lines, focusIndex) {
    renderReceiptLines(kind, lines);
    const form = document.getElementById('store-form');
    if (form) form.dispatchEvent(new Event('input', { bubbles: true }));
    queuePreviewFollow(kind + 'Line_' + (focusIndex === undefined ? -1 : focusIndex), true);
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

function readReceiptLayout(form) {
    const show = {};
    for (let i = 0; i < RECEIPT_SWITCHES.length; i++) {
        const name = RECEIPT_SWITCHES[i];
        const box = form.elements['show_' + name];
        show[name] = box ? box.checked : true;
    }
    return {
        paperWidth: Number(form.elements.paperWidth.value),
        fontSize: Number(form.elements.fontSize.value),
        title: form.elements.title.value.trim(),
        paidLabel: receiptLayoutOf(storeSettings).paidLabel,
        headerLines: readReceiptLines('header'),
        footerLines: readReceiptLines('footer'),
        show: show
    };
}

function onRegistrationChange(value) {
    const field = document.getElementById('store-rate-field');
    if (field) field.style.display = value === 'VAT' ? 'block' : 'none';
    renderStorePreview();
}

const BANK_FIELDS = ['bankName', 'bankAccountName', 'bankAccountNumber'];

const BANK_DIGITS_MIN = 10;
const BANK_DIGITS_MAX = 16;

function bankNumberComplaint(number) {
    const digitCount = number.replace(/\D/g, '').length;
    if (!/^[0-9]+([ -][0-9]+)*$/.test(number) ||
        digitCount < BANK_DIGITS_MIN || digitCount > BANK_DIGITS_MAX) {
        return 'An account number is ' + BANK_DIGITS_MIN + ' to ' + BANK_DIGITS_MAX +
               ' digits, with one space or dash where the bank prints one.';
    }
    return null;
}

function bankComplaint(form) {
    const values = [];
    for (let i = 0; i < BANK_FIELDS.length; i++) {
        values.push(form.elements[BANK_FIELDS[i]].value.trim());
    }
    let filled = 0;
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== '') filled += 1;
    }
    if (filled === 0) return null;
    if (filled < values.length) {
        return 'The bank, the account name and the account number are all required.';
    }
    return bankNumberComplaint(values[2]);
}

function onBankNumberInput(input) {
    const typed = input.value;
    const cleaned = typed.replace(/[^0-9 -]/g, '');
    if (cleaned !== typed) {
        const cursor = Math.max(0, input.selectionStart - (typed.length - cleaned.length));
        input.value = cleaned;
        input.setSelectionRange(cursor, cursor);
    }
    onBankInput();

    const note = document.getElementById('store-bank-note');
    if (cleaned !== typed && note) {
        note.className = 'store-bank-note is-stop';
        note.textContent = 'Digits only. Letters and symbols cannot be typed here.';
    }
}

function onBankInput() {
    const form = document.getElementById('store-form');
    const note = document.getElementById('store-bank-note');
    if (!form || !note || !form.elements.bankName) return;

    const number = form.elements.bankAccountNumber.value.trim();
    let problem = null;
    if (number !== '') problem = bankNumberComplaint(number);

    form.elements.bankAccountNumber.classList.toggle('is-bad', problem !== null);
    note.className = problem ? 'store-bank-note is-stop' : 'store-bank-note';
    note.textContent = problem || '';
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

    const registrationChanged = Boolean(storeSettings) && storeSettings.registration_type !== registration;

    let consequence = 'Invoices printed from now on use these details. Sales already rung up keep the ones they were issued with.';
    if (registrationChanged) {
        consequence = 'This shop is recorded as ' + storeSettings.registration_type +
            ' and you are changing it to ' + registration + '. ' +
            (registration === 'VAT'
                ? 'Invoices from now on will show a VAT breakdown and read VAT REG TIN.'
                : 'Invoices from now on will show no VAT at all and read NON-VAT REG TIN.') +
            ' Sales already rung up keep the registration they were issued under.';
    }

    const becomesVat = registrationChanged && registration === 'VAT';
    const changes = formChangeLines(form, function (name) {
        return name === 'vatRate' && (registration !== 'VAT' || becomesVat);
    });
    if (becomesVat) changes.push('VAT rate: none \u2192 ' + (parseFloat(form.elements.vatRate.value) || 0) + '%');

    const saved = JSON.parse(formBaselines.get(form) || '{}');
    const lineKinds = [['header', 'Header lines'], ['footer', 'Footer lines']];
    for (let i = 0; i < lineKinds.length; i++) {
        const entry = lineKinds[i];
        const now = readReceiptLines(entry[0]);
        const was = saved[entry[0] + 'Lines'] || [];
        if (JSON.stringify(now) === JSON.stringify(was)) continue;
        changes.push(entry[1] + ': ' + (was.length ? clipValue(was.join(' | ')) : '(none)') +
            ' \u2192 ' + (now.length ? clipValue(now.join(' | ')) : '(none)'));
    }

    const yes = await askConfirm(consequence, {
        title: 'Save these changes?',
        eyebrow: 'Receipt Maintenance',
        confirmLabel: registrationChanged ? 'Change it and save' : 'Save details',
        tone: registrationChanged ? 'danger' : undefined,
        detail: changeListFor(changes)
    });

    if (!yes) return;

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

        markFormClean(form, document.getElementById('store-save-btn'));

        notifySuccess(result.message, 'Receipt saved');
        await loadStoreSettingsForm();
    } catch (error) {
        notifyOffline();
    }
}

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

function renderStorePreview() {
    const box = document.getElementById('store-preview');
    const form = document.getElementById('store-form');
    if (!box || !form || !form.elements.paperWidth) return;

    const shop = storeFromForm(form);
    const registration = form.elements.registrationType.value;
    const rate = registration === 'VAT' ? (parseFloat(form.elements.vatRate.value) || 0) : 0;
    const total = 1000;

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

    const now = new Date();
    applyReceiptPaper(box, shop);
    box.innerHTML = receiptHtml(shop, {
        registration: registration,
        receiptNo: 'OR-000001',
        meta: [
            { key: 'date', label: 'Date', value: now.toLocaleString('en-PH') },
            { key: 'cashier', label: 'Cashier', value: getCurrentUser() ? staffName(getCurrentUser()) : 'Cashier' },
            { key: 'customer', label: 'Customer', value: '', keepBlank: true },
            { key: 'payment', label: 'Payment', value: 'Bank Transfer' },
            { key: 'reference', label: 'Reference', value: 'REF-12345' }
        ],
        itemsHtml: '<tr><td>Sample item<br><span class="rc-qty">1 pc x ' + peso(total) + '</span></td>' +
                   '<td class="rc-amt">' + peso(total) + '</td></tr>',
        itemCount: '1',
        totals: [
            { label: 'Subtotal', value: peso(total) },
            { label: 'Total Due', value: peso(total), due: true },
            { label: 'Received Amount', value: peso(total) },
            { label: 'Change', value: peso(0) }
        ],
        taxHtml: tax,
        paid: true
    });
}

const PREVIEW_FOLLOW_DELAY = 200;
const PREVIEW_FLASH_MS = 1100;

let previewFollowTimer = null;
let previewFlashTimer = null;

function previewPartsFor(box, form, name) {
    function all(selector) {
        const found = box.querySelectorAll(selector);
        const list = [];
        for (let i = 0; i < found.length; i++) {
            list.push(found[i]);
        }
        return list;
    }

    function firstFound() {
        for (let i = 0; i < arguments.length; i++) {
            if (arguments[i].length > 0) return arguments[i];
        }
        return [];
    }

    const headLines = all('.rc-head .rc-addr');
    const lead = form.elements.address.value.trim() ? 1 : 0;

    function metaRow(label) {
        const cells = all('.rc-meta > span');
        let at = -1;
        for (let index = 0; index < cells.length; index++) {
            if (index % 2 === 0 && cells[index].textContent === label) {
                at = index;
                break;
            }
        }
        return at < 0 ? [] : [cells[at], cells[at + 1]];
    }

    function lineRank(kind, index) {
        const typed = typedReceiptLines(kind);
        if (index < 0 || !typed[index] || typed[index].trim() === '') return -1;
        let rank = 0;
        for (let i = 0; i < index; i++) {
            if (typed[i].trim() !== '') rank++;
        }
        return rank;
    }

    const metaOf = { show_cashier: 'Cashier', show_customer: 'Customer', show_payment: 'Payment', show_reference: 'Reference' };
    const line = /^(header|footer)Line_(-?\d+)$/.exec(name);

    if (line) {
        const rank = lineRank(line[1], parseInt(line[2], 10));
        if (line[1] === 'header') {
            let ownLine = [];
            if (rank >= 0 && headLines[lead + 1 + rank]) ownLine = [headLines[lead + 1 + rank]];
            return { parts: firstFound(ownLine, all('.rc-head')) };
        }
        const thanks = all('.rc-thanks');
        let ownThanks = [];
        if (rank >= 0 && thanks[rank]) ownThanks = [thanks[rank]];
        return { parts: firstFound(ownThanks, thanks.slice(-1), all('.rc-foot')) };
    }

    if (metaOf[name]) return { parts: firstFound(metaRow(metaOf[name]), all('.rc-meta'), all('.rc-head')) };

    switch (name) {
        case 'storeName':         return { parts: all('.rc-shop') };
        case 'proprietor':
        case 'show_proprietor':   return { parts: firstFound(all('.rc-prop'), all('.rc-shop')) };
        case 'address':           return { parts: firstFound(lead ? headLines.slice(0, 1) : [], all('.rc-shop')) };
        case 'tin':               return { parts: headLines.slice(lead, lead + 1) };
        case 'registrationType':
        case 'vatRate':
        case 'show_tax':          return { parts: firstFound(all('.rc-tax'), all('.rc-totals')) };
        case 'bankName':
        case 'bankAccountName':
        case 'bankAccountNumber': return { parts: all('.rc-foot') };
        case 'title':             return { parts: firstFound(all('.rc-line'), all('.rc-no')) };
        case 'show_item_count':   return { parts: all('.rc-due') };
        case 'invoiceNote':
        case 'show_note':         return { parts: firstFound(all('.rc-note'), all('.rc-foot')) };
        case 'paperWidth':
        case 'fontSize':          return { whole: true };
        default:                  return { parts: [] };
    }
}

function clearPreviewFlash() {
    clearTimeout(previewFlashTimer);
    const flashing = document.querySelectorAll('#store-preview.rc-flash, #store-preview .rc-flash');
    for (let i = 0; i < flashing.length; i++) {
        flashing[i].classList.remove('rc-flash');
    }
}

function scrollPreviewTo(element) {
    const stage = element.closest('.store-preview-stage');
    if (!stage || stage.scrollHeight <= stage.clientHeight + 1) return;

    const area = stage.getBoundingClientRect();
    const part = element.getBoundingClientRect();
    const margin = 12;
    if (part.top >= area.top + margin && part.bottom <= area.bottom - margin) return;

    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    stage.scrollTo({
        top: Math.max(0, stage.scrollTop + part.top - area.top - (stage.clientHeight - part.height) / 2),
        behavior: calm ? 'auto' : 'smooth'
    });
}

function followPreview(name) {
    const box = document.getElementById('store-preview');
    const form = document.getElementById('store-form');
    if (!box || !form || !form.elements.address) return;

    const found = previewPartsFor(box, form, name);
    const parts = found.whole ? [box] : found.parts;
    if (parts.length === 0) return;

    clearPreviewFlash();
    void box.offsetWidth;
    if (!found.whole) scrollPreviewTo(parts[0]);

    for (let i = 0; i < parts.length; i++) {
        parts[i].classList.add('rc-flash');
    }
    previewFlashTimer = setTimeout(clearPreviewFlash, PREVIEW_FLASH_MS);
}

function queuePreviewFollow(name, atOnce) {
    clearTimeout(previewFollowTimer);
    previewFollowTimer = setTimeout(function () {
        followPreview(name);
    }, atOnce ? 0 : PREVIEW_FOLLOW_DELAY);
}

function followFormEvent(event) {
    const field = event.target;
    if (!field || !field.name) return;

    const discrete = field.type === 'checkbox' || field.tagName === 'SELECT';
    if (event.type === 'change' && !discrete) return;
    queuePreviewFollow(field.name, discrete);
}

function printStorePreview() {
    const form = document.getElementById('store-form');
    if (!form) return;
    clearTimeout(previewFollowTimer);
    clearPreviewFlash();
    renderStorePreview();
    setReceiptPageSize(storeFromForm(form));
    document.body.classList.add('printing-receipt');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-receipt'); }, 400);
}

function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
}

if (window.location.pathname.toLowerCase().endsWith('system.html')) {
    document.addEventListener('DOMContentLoaded', async function () {
        buildUsersPanel();
        buildArchivePanel();
        buildLogPeriodBox();
        buildLogsPanel();
        keepSavedLogRole();

        document.addEventListener('datapanel:change', function (event) {
            if (!event.detail || event.detail.key === 'admin-logs') syncLogPeriodBox();
        });
        buildBackupPanel();

        if (typeof onLiveChange === 'function') {
            onLiveChange(['features'], function () {
                const panel = document.getElementById('panel-features');
                if (!panel || panel.style.display === 'none') return;
                if (featureSaving || featureMatrixChanges().length > 0) return;
                loadFeatureMatrix();
            });
        }

        showAccountsList();
        unfoldSidebarAtOpenScreen();

        syncTopbarHeight();
        window.addEventListener('resize', syncTopbarHeight);

        const storeForm = document.getElementById('store-form');
        if (storeForm) {
            storeForm.addEventListener('input', function (event) {
                if (event.target && event.target.classList && event.target.id !== 'store-tin') {
                    event.target.classList.remove('is-bad');
                }
                renderStorePreview();
                followFormEvent(event);
            });
            storeForm.addEventListener('change', function (event) {
                renderStorePreview();
                followFormEvent(event);
            });
        }

        watchFormEdits(storeForm, document.getElementById('store-save-btn'));
        watchFormEdits(document.getElementById('edit-user-form'),
                       document.getElementById('edit-user-save-btn'));

        syncDirectoryColumns();
        syncLogColumns();

        await loadRoles();
        loadNotifications();
    });
}
