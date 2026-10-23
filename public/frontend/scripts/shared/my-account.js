let myAccount = null;

function buildAccountModal() {
    if (document.getElementById('account-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'account-modal';
    modal.innerHTML = '\n' +
        '        <div class="modal-box">\n' +
        '            <div class="modal-head">\n' +
        '                <div class="modal-identity">\n' +
        '                    <div class="avatar" id="account-avatar">--</div>\n' +
        '                    <div>\n' +
        '                        <h3 id="account-name">My Account</h3>\n' +
        '                        <span class="modal-role" id="account-role">Role</span>\n' +
        '                    </div>\n' +
        '                </div>\n' +
        '                <button type="button" class="modal-close" onclick="requestCloseModal(\'account-modal\')" aria-label="Close">&times;</button>\n' +
        '            </div>\n' +
        '\n' +
        '            <div class="modal-tabs">\n' +
        '                <button type="button" class="modal-tab active" id="account-tab-view"\n' +
        '                        onclick="showAccountTab(\'view\')">Credentials</button>\n' +
        '                <button type="button" class="modal-tab" id="account-tab-edit"\n' +
        '                        onclick="showAccountTab(\'edit\')">Edit Details</button>\n' +
        '                <button type="button" class="modal-tab" id="account-tab-password"\n' +
        '                        onclick="showAccountTab(\'password\')">Password</button>\n' +
        '            </div>\n' +
        '\n' +
        '            <div class="modal-body">\n' +
        '                <!-- WHAT A STANDARD USER MAY NOT CHANGE\n' +
        '                     The sign-in email, the password and the role are credentials,\n' +
        '                     and none of them is changed by its own holder from here. A\n' +
        '                     screen left signed in at a counter is otherwise a screen on\n' +
        '                     which anybody can set a new password and own the account.\n' +
        '                     A new password comes from "Forgot your password?" on the\n' +
        '                     sign-in page (a code sent to the address on file), from a\n' +
        '                     manager for counter, stockroom and delivery staff, or from\n' +
        '                     the administrator. -->\n' +
        '                <div class="detail-grid" id="account-view"></div>\n' +
        '\n' +
        '                <div id="account-edit" style="display: none;">\n' +
        '                    <form id="account-form" onsubmit="handleSaveMyProfile(event)">\n' +
        '                        <div class="grid-2">\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-first">First name</label>\n' +
        '                                <input type="text" id="me-first" name="firstName" class="form-control" required>\n' +
        '                            </div>\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-middle">Middle name <span class="label-hint">optional</span></label>\n' +
        '                                <input type="text" id="me-middle" name="middleName"\n' +
        '                                       class="form-control" maxlength="100" placeholder="Dela Cruz">\n' +
        '                            </div>\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-last">Last name</label>\n' +
        '                                <input type="text" id="me-last" name="lastName" class="form-control" required>\n' +
        '                            </div>\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-phone">Phone</label>\n' +
        '                                <div class="phone-field">\n' +
        '                                    <span class="phone-prefix">+63</span>\n' +
        '                                    <input type="text" id="me-phone" name="phone" class="form-control"\n' +
        '                                           inputmode="numeric" autocomplete="tel"\n' +
        '                                           maxlength="20" placeholder="9XXXXXXXXX" required\n' +
        '                                           oninput="onPhoneInput(this)">\n' +
        '                                </div>\n' +
        '                            </div>\n' +
        '                        </div>\n' +
        '                        <div class="form-group">\n' +
        '                            <label for="me-email">Email</label>\n' +
        '                            <input type="email" id="me-email" name="email" class="form-control" readonly\n' +
        '                                   title="Your sign-in email is changed by the System Administrator">\n' +
        '                        </div>\n' +
        '                        <!-- Save Changes sits in the foot below, so it is never paged away -->\n' +
        '                    </form>\n' +
        '                </div>\n' +
        '\n' +
        '                <div id="account-password" style="display: none;">\n' +
        '                    <form id="account-password-form" onsubmit="handleChangeMyPassword(event)">\n' +
        '                        <div class="form-group">\n' +
        '                            <label for="me-current">Current password</label>\n' +
        '                            <div class="password-field">\n' +
        '                                <input type="password" id="me-current" name="currentPassword"\n' +
        '                                       class="form-control" required autocomplete="current-password">\n' +
        '                                <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>\n' +
        '                            </div>\n' +
        '                        </div>\n' +
        '                        <div class="grid-2">\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-new">New password <span class="label-hint">not the current one</span></label>\n' +
        '                                <div class="password-field">\n' +
        '                                    <input type="password" id="me-new" name="newPassword" class="form-control"\n' +
        '                                           minlength="8" required autocomplete="new-password">\n' +
        '                                    <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>\n' +
        '                                </div>\n' +
        '                                <ul class="password-rules" data-rules-for="me-new"></ul>\n' +
        '                            </div>\n' +
        '                            <div class="form-group">\n' +
        '                                <label for="me-confirm">Confirm new password</label>\n' +
        '                                <div class="password-field">\n' +
        '                                    <input type="password" id="me-confirm" name="confirmPassword"\n' +
        '                                           class="form-control" minlength="8" required autocomplete="new-password">\n' +
        '                                    <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>\n' +
        '                                </div>\n' +
        '                            </div>\n' +
        '                        </div>\n' +
        '                    </form>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '\n' +
        '            <!-- the form buttons live in the foot, outside the paged body, so a\n' +
        '                 long form never pushes them onto a second page -->\n' +
        '            <div class="modal-foot" id="account-foot">\n' +
        '                <div class="detail-foot-actions" data-account-foot="edit" hidden>\n' +
        '                    <button type="button" class="btn btn-ghost" onclick="cancelAccountForm(\'edit\')">Cancel</button>\n' +
        '                    <button type="submit" form="account-form" class="btn btn-success">Save Changes</button>\n' +
        '                </div>\n' +
        '                <div class="detail-foot-actions" data-account-foot="password" hidden>\n' +
        '                    <button type="button" class="btn btn-ghost" onclick="cancelAccountForm(\'password\')">Cancel</button>\n' +
        '                    <button type="submit" form="account-password-form" class="btn btn-success">Change Password</button>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '        </div>';
    document.body.appendChild(modal);
    showPasswordRules();

    setModalCloseGuard('account-modal', function () {
        const editForm = document.getElementById('account-form');
        const passwordForm = document.getElementById('account-password-form');
        if (formChanged('account-edit', editForm)) return askDiscard('your changes to your details');
        if (formChanged('account-password', passwordForm)) return askDiscard('your new password');
        return true;
    });
}

async function cancelAccountForm(tab) {
    const form = document.getElementById(tab === 'edit' ? 'account-form' : 'account-password-form');
    if (formChanged('account-' + tab, form)) {
        const what = tab === 'edit' ? 'your changes to your details' : 'your new password';
        if (!(await askDiscard(what))) return;
    }

    if (tab === 'edit') {
        renderMyAccount();
    } else {
        form.reset();
        showPasswordRules();
        rememberForm('account-password', form);
    }
    showAccountTab('view');
}

function canEditOwnDetails() {
    const me = getCurrentUser();
    return !me || me.role_name !== 'System Administrator';
}

function canChangeOwnPassword() {
    const me = getCurrentUser();
    return Boolean(me) && me.role_name === 'System Administrator';
}

function showAccountTab(tab) {
    if (tab === 'edit' && !canEditOwnDetails()) tab = 'view';
    if (tab === 'password' && !canChangeOwnPassword()) tab = 'view';

    const editTab = document.getElementById('account-tab-edit');
    if (editTab) editTab.style.display = canEditOwnDetails() ? '' : 'none';

    const passwordTab = document.getElementById('account-tab-password');
    if (passwordTab) passwordTab.style.display = canChangeOwnPassword() ? '' : 'none';

    const footGroups = document.querySelectorAll('[data-account-foot]');
    for (let i = 0; i < footGroups.length; i++) {
        footGroups[i].hidden = footGroups[i].dataset.accountFoot !== tab;
    }

    const tabNames = ['view', 'edit', 'password'];
    for (let i = 0; i < tabNames.length; i++) {
        const name = tabNames[i];
        const panel = document.getElementById('account-' + name);
        const button = document.getElementById('account-tab-' + name);
        if (panel) {
            if (name !== tab) {
                panel.style.display = 'none';
            } else if (name === 'view') {
                panel.style.display = 'grid';
            } else {
                panel.style.display = 'block';
            }
        }
        if (button) button.classList.toggle('active', name === tab);
    }
}

async function openMyAccount(tab) {
    closeAccountMenu();
    ensureUiFurniture();

    document.getElementById('account-view').innerHTML =
        '<p class="table-empty">Loading your details...</p>';
    showAccountTab(tab || 'view');
    const passwordForm = document.getElementById('account-password-form');
    passwordForm.reset();
    showPasswordRules();
    rememberForm('account-password', passwordForm);
    delete formStarts['account-edit'];
    showModal('account-modal');

    try {
        const response = await apiGetMyAccount();
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Cannot load your account');
            closeModal('account-modal');
            return;
        }

        myAccount = body;
        renderMyAccount();
    } catch (error) {
        closeModal('account-modal');
        notifyOffline();
    }
}

function renderMyAccount() {
    const me = myAccount;
    if (!me) return;

    const name = staffName(me);
    document.getElementById('account-name').textContent = name;
    document.getElementById('account-role').textContent = me.role_name;
    document.getElementById('account-avatar').textContent =
        ((me.first_name || '?')[0] + (me.last_name || '')[0] || '').toUpperCase();

    const locked = true;
    const editableRowsLocked = !canEditOwnDetails();

    document.getElementById('account-view').innerHTML =
        detailRow('Staff ID', '#' + escapeHtml(me.staff_id), locked) +
        detailRow('Full Name', escapeHtml(name), locked) +
        detailRow('First Name', escapeHtml(me.first_name), editableRowsLocked) +
        detailRow('Middle Name', me.middle_name
            ? escapeHtml(me.middle_name)
            : '<span class="muted">Not set</span>', editableRowsLocked) +
        detailRow('Last Name', escapeHtml(me.last_name), editableRowsLocked) +
        detailRow('Username / Email', me.email
            ? escapeHtml(me.email)
            : '<span class="muted">No login account</span>', locked) +
        detailRow('Phone', me.phone
            ? '<span class="mono">' + escapeHtml(phoneForDisplay(me.phone)) + '</span>'
            : '<span class="muted">Not set</span>', editableRowsLocked) +
        detailRow('Role', escapeHtml(me.role_name), locked) +
        detailRow('Account Status', '<span class="badge ' + (me.is_active ? 'badge-success' : 'badge-danger') + '">' +
            (me.is_active ? 'Active' : 'Inactive') + '</span>', locked);

    const form = document.getElementById('account-form');
    form.elements.firstName.value = me.first_name || '';
    form.elements.middleName.value = me.middle_name || '';
    form.elements.lastName.value = me.last_name || '';
    phoneFill(form.elements.phone, me.phone);
    form.elements.email.value = me.email || '';
    rememberForm('account-edit', form);
}

async function handleSaveMyProfile(event) {
    event.preventDefault();
    const form = event.target;

    if (!canEditOwnDetails()) {
        notifyWarning('An administrator\'s details are changed by another administrator.', 'Not allowed');
        return;
    }

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleName: form.elements.middleName.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: phoneToStore(form.elements.phone)
    };

    if (data.firstName === '' || data.lastName === '') {
        notifyWarning('A first name and a last name are both required.', 'Nothing was saved');
        return;
    }

    if (data.phone === '') {
        notifyWarning('A phone number is required.', 'Nothing was saved');
        return;
    }
    const phoneProblem = phoneComplaint(form.elements.phone);
    if (phoneProblem) {
        notifyWarning(phoneProblem, 'Nothing was saved');
        return;
    }

    try {
        const response = await apiSaveMyDetails(data);
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Nothing was saved');
            return;
        }

        myAccount = body.user;
        rememberCurrentUser(body.user);
        renderMyAccount();
        showAccountTab('view');
        notifySuccess('Your credentials were updated.', 'Saved');
    } catch (error) {
        notifyOffline();
    }
}

async function handleChangeMyPassword(event) {
    event.preventDefault();
    const form = event.target;

    const currentPassword = form.elements.currentPassword.value;
    const newPassword = form.elements.newPassword.value;
    const confirmPassword = form.elements.confirmPassword.value;

    if (newPassword !== confirmPassword) {
        notifyWarning('The two new passwords do not match.', 'Password not changed');
        return;
    }
    const complaint = passwordComplaint(newPassword);
    if (complaint) {
        notifyWarning(complaint, 'Password not changed');
        return;
    }
    if (newPassword === currentPassword) {
        notifyWarning('The new password must be different from your current password.', 'Password not changed');
        return;
    }

    try {
        const response = await apiChangeMyPassword(currentPassword, newPassword);
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Password not changed');
            return;
        }

        form.reset();
        showPasswordRules();
        closeModal('account-modal');

        notifySuccess('Your password was changed. Any other device signed in with the old one was signed out.',
            'Password changed');
    } catch (error) {
        notifyOffline();
    }
}

function rememberCurrentUser(user) {
    const current = getCurrentUser();
    if (!current || !user) return;

    current.first_name = user.first_name;
    current.middle_name = user.middle_name;
    current.last_name = user.last_name;
    current.full_name = user.full_name;
    if (user.email) current.email = user.email;

    localStorage.setItem('currentUser', JSON.stringify(current));
    applyCurrentUserToPage(current);
}

async function confirmLogout() {
    closeAccountMenu();

    const yes = await askConfirm('You will be signed out and returned to the login screen.', {
        title: 'Log out?',
        eyebrow: 'Session',
        mark: '⏻',
        confirmLabel: 'Log out',
        tone: 'danger'
    });

    if (!yes) return;

    logout();
    window.location.replace('Login.html');
}
