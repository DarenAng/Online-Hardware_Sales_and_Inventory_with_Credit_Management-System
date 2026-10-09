// my-account.js -- my credentials: details, edit form, password form
// Loaded by: all five dashboards
// The server only ever applies these to the signed-in account.
let myAccount = null;

function buildAccountModal() {
    if (document.getElementById('account-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'account-modal';
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-head">
                <div class="modal-identity">
                    <div class="avatar" id="account-avatar">--</div>
                    <div>
                        <h3 id="account-name">My Account</h3>
                        <span class="modal-role" id="account-role">Role</span>
                    </div>
                </div>
                <button type="button" class="modal-close" onclick="closeModal('account-modal')" aria-label="Close">&times;</button>
            </div>

            <div class="modal-tabs">
                <button type="button" class="modal-tab active" id="account-tab-view"
                        onclick="showAccountTab('view')">Credentials</button>
                <button type="button" class="modal-tab" id="account-tab-edit"
                        onclick="showAccountTab('edit')">Edit Details</button>
                <button type="button" class="modal-tab" id="account-tab-password"
                        onclick="showAccountTab('password')">Password</button>
            </div>

            <div class="modal-body">
                <p class="cred-note" id="account-admin-note" style="display: none;">As the System
                    Administrator, your name, phone and email are changed by another administrator
                    from the staff directory, not from here. Your password is still yours to change.</p>
                <!-- WHAT A STANDARD USER MAY NOT CHANGE
                     The sign-in email, the password and the role are credentials,
                     and none of them is changed by its own holder from here. A
                     screen left signed in at a counter is otherwise a screen on
                     which anybody can set a new password and own the account.
                     A new password comes from "Forgot your password?" on the
                     sign-in page (a code sent to the address on file), from a
                     manager for counter, stockroom and delivery staff, or from
                     the administrator. -->
                <p class="cred-note" id="account-staff-note" style="display: none;">Your sign-in
                    email and your role are set by the System Administrator, and your password is
                    not changed from here. To set a new one, sign out and choose "Forgot your
                    password?" on the sign-in page: a code is sent to your email. If mail is not
                    working, a manager (for cashiers, clerks and drivers) or the System
                    Administrator can reset it, and a new one is sent to you. Your name and phone
                    number are yours to change under Edit Details.</p>
                <div class="detail-grid" id="account-view"></div>

                <div id="account-edit" style="display: none;">
                    <p class="cred-note">Your name and phone number. Your role and your sign-in
                        email are set by the system administrator and are shown here for checking.</p>
                    <form id="account-form" onsubmit="handleSaveMyProfile(event)">
                        <div class="grid-2">
                            <div class="form-group">
                                <label for="me-first">First name</label>
                                <input type="text" id="me-first" name="firstName" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label for="me-middle">Middle name <span class="label-hint">optional</span></label>
                                <input type="text" id="me-middle" name="middleName"
                                       class="form-control" maxlength="100" placeholder="Dela Cruz">
                            </div>
                            <div class="form-group">
                                <label for="me-last">Last name</label>
                                <input type="text" id="me-last" name="lastName" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label for="me-phone">Phone <span class="label-hint">optional</span></label>
                                <div class="phone-field">
                                    <span class="phone-prefix">+63</span>
                                    <input type="text" id="me-phone" name="phone" class="form-control"
                                           inputmode="numeric" autocomplete="tel"
                                           maxlength="20" placeholder="9XXXXXXXXX"
                                           oninput="onPhoneInput(this)">
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="me-email">Email <span class="label-hint">your username, changed by the administrator</span></label>
                            <input type="email" id="me-email" name="email" class="form-control" readonly
                                   title="Your sign-in email is changed by the System Administrator">
                        </div>
                        <!-- Save Changes sits in the foot below, so it is never paged away -->
                    </form>
                </div>

                <div id="account-password" style="display: none;">
                    <form id="account-password-form" onsubmit="handleChangeMyPassword(event)">
                        <div class="form-group">
                            <label for="me-current">Current password</label>
                            <div class="password-field">
                                <input type="password" id="me-current" name="currentPassword"
                                       class="form-control" required autocomplete="current-password">
                                <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>
                            </div>
                        </div>
                        <div class="grid-2">
                            <div class="form-group">
                                <label for="me-new">New password <span class="label-hint">at least 8 characters, not the current one</span></label>
                                <div class="password-field">
                                    <input type="password" id="me-new" name="newPassword" class="form-control"
                                           minlength="8" required autocomplete="new-password">
                                    <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>
                                </div>
                            </div>
                            <div class="form-group">
                                <label for="me-confirm">Confirm new password</label>
                                <div class="password-field">
                                    <input type="password" id="me-confirm" name="confirmPassword"
                                           class="form-control" minlength="8" required autocomplete="new-password">
                                    <button type="button" class="password-toggle" aria-pressed="false" aria-label="Show password">Show</button>
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
            </div>

            <!-- the form buttons live in the foot, outside the paged body, so a
                 long form never pushes them onto a second page -->
            <div class="modal-foot" id="account-foot">
                <div class="detail-foot-actions" data-account-foot="edit" hidden>
                    <button type="button" class="btn btn-ghost" onclick="showAccountTab('view')">Cancel</button>
                    <button type="submit" form="account-form" class="btn btn-success">Save Changes</button>
                </div>
                <div class="detail-foot-actions" data-account-foot="password" hidden>
                    <button type="button" class="btn btn-ghost" onclick="showAccountTab('view')">Cancel</button>
                    <button type="submit" form="account-password-form" class="btn btn-success">Change Password</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

// The server refuses PUT /api/me for System Administrator (notOwnDetailsIfAdmin
// in server.js), so the Edit Details tab is not offered to that role.
function canEditOwnDetails() {
    const me = getCurrentUser();
    return !me || me.role_name !== 'System Administrator';
}

// A standard user does not change their own password (notOwnCredentials in
// server.js); the administrator keeps it.
function canChangeOwnPassword() {
    const me = getCurrentUser();
    return !!me && me.role_name === 'System Administrator';
}

function showAccountTab(tab) {
    if (tab === 'edit' && !canEditOwnDetails()) tab = 'view';
    if (tab === 'password' && !canChangeOwnPassword()) tab = 'view';

    const editTab = document.getElementById('account-tab-edit');
    if (editTab) editTab.style.display = canEditOwnDetails() ? '' : 'none';

    const passwordTab = document.getElementById('account-tab-password');
    if (passwordTab) passwordTab.style.display = canChangeOwnPassword() ? '' : 'none';

    // the administrator's note is about the details, so it sits on the Credentials tab only
    const note = document.getElementById('account-admin-note');
    if (note) note.style.display = (tab === 'view' && !canEditOwnDetails()) ? 'block' : 'none';

    // the note is about credentials, so it sits on the Credentials tab only
    const staffNote = document.getElementById('account-staff-note');
    if (staffNote) staffNote.style.display = (tab === 'view' && !canChangeOwnPassword()) ? 'block' : 'none';

    // Save Changes / Change Password in the foot follow the open tab
    document.querySelectorAll('[data-account-foot]').forEach((group) => {
        group.hidden = group.dataset.accountFoot !== tab;
    });

    ['view', 'edit', 'password'].forEach((name) => {
        const panel = document.getElementById('account-' + name);
        const button = document.getElementById('account-tab-' + name);
        if (panel) {
            if (name !== tab) {
                panel.style.display = 'none';        // not the chosen tab: hide it
            } else if (name === 'view') {
                panel.style.display = 'grid';
            } else {
                panel.style.display = 'block';
            }
        }
        if (button) button.classList.toggle('active', name === tab);
    });
}

async function openMyAccount(tab) {
    closeAccountMenu();
    ensureUiFurniture();

    document.getElementById('account-view').innerHTML =
        '<p class="table-empty">Loading your details...</p>';
    showAccountTab(tab || 'view');
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

    document.getElementById('account-view').innerHTML =
        detailRow('Staff ID', '#' + escapeHtml(me.staff_id)) +
        detailRow('Full Name', escapeHtml(name)) +
        detailRow('First Name', escapeHtml(me.first_name)) +
        detailRow('Middle Name', me.middle_name
            ? escapeHtml(me.middle_name)
            : '<span class="muted">Not set</span>') +
        detailRow('Last Name', escapeHtml(me.last_name)) +
        detailRow('Username / Email', me.email
            ? escapeHtml(me.email)
            : '<span class="muted">No login account</span>') +
        detailRow('Phone', me.phone
            ? '<span class="mono">' + escapeHtml(phoneForDisplay(me.phone)) + '</span>'
            : '<span class="muted">Not set</span>') +
        detailRow('Role', escapeHtml(me.role_name)) +
        detailRow('Account Status', `<span class="badge ${me.is_active ? 'badge-success' : 'badge-danger'}">${me.is_active ? 'Active' : 'Inactive'}</span>`) +
        detailRow('Hired On', escapeHtml(me.staff_created_at)) +
        detailRow('Account Created', me.created_at
            ? escapeHtml(me.created_at) : '<span class="muted">Not available</span>') +
        detailRow('Last Login', me.last_login
            ? escapeHtml(me.last_login) : '<span class="muted">Never</span>');

    const form = document.getElementById('account-form');
    form.elements.firstName.value = me.first_name || '';
    form.elements.middleName.value = me.middle_name || '';
    form.elements.lastName.value = me.last_name || '';
    phoneFill(form.elements.phone, me.phone);
    form.elements.email.value = me.email || '';
}

async function handleSaveMyProfile(event) {
    event.preventDefault();
    const form = event.target;

    if (!canEditOwnDetails()) {
        notifyWarning('An administrator\'s details are changed by another administrator.', 'Not allowed');
        return;
    }

    // the email is shown for checking and never sent
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
    if (newPassword.length < 8) {
        notifyWarning('A password needs at least 8 characters.', 'Password not changed');
        return;
    }
    // the server refuses this too; this saves the round trip
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
        closeModal('account-modal');

        // every session on the old password is over, this one included
        signOutWithReason('Your password was changed. Sign in again with the new one.', 'good');
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
