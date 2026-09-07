// my-account.js  --  MY CREDENTIALS
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// MY CREDENTIALS
//
// The same three pages for every role: what the system holds about you, the
// form that changes it, and the password form. The server only ever applies
// these to the signed-in account, so no role can reach another person's
// details from here.
// ==========================================
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
                <div class="detail-grid" id="account-view"></div>

                <div id="account-edit" style="display: none;">
                    <p class="cred-note">Your role is set by the system administrator, so it is not
                        editable here. Everything else on this page is yours to change.</p>
                    <form id="account-form" onsubmit="handleSaveMyProfile(event)">
                        <div class="grid-2">
                            <div class="form-group">
                                <label for="me-first">First Name</label>
                                <input type="text" id="me-first" name="firstName" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label for="me-initial">Middle Initial <span class="label-hint">optional</span></label>
                                <input type="text" id="me-initial" name="middleInitial"
                                       class="form-control initial-input" maxlength="1" placeholder="M">
                            </div>
                            <div class="form-group">
                                <label for="me-last">Last Name</label>
                                <input type="text" id="me-last" name="lastName" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label for="me-phone">Phone</label>
                                <input type="text" id="me-phone" name="phone" class="form-control" placeholder="09XXXXXXXXX">
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="me-email">Email <span class="label-hint">this is your username</span></label>
                            <input type="email" id="me-email" name="email" class="form-control">
                        </div>
                        <div class="form-footer">
                            <button type="submit" class="btn btn-success">Save Changes</button>
                            <button type="button" class="btn btn-ghost" onclick="showAccountTab('view')">Cancel</button>
                        </div>
                    </form>
                </div>

                <div id="account-password" style="display: none;">
                    <p class="cred-note">Your current password is asked for so that an unattended
                        screen cannot be used to lock you out of your own account.</p>
                    <form id="account-password-form" onsubmit="handleChangeMyPassword(event)">
                        <div class="form-group">
                            <label for="me-current">Current Password</label>
                            <input type="password" id="me-current" name="currentPassword"
                                   class="form-control" required autocomplete="current-password">
                        </div>
                        <div class="grid-2">
                            <div class="form-group">
                                <label for="me-new">New Password</label>
                                <input type="password" id="me-new" name="newPassword" class="form-control"
                                       minlength="8" required autocomplete="new-password">
                            </div>
                            <div class="form-group">
                                <label for="me-confirm">Confirm New Password</label>
                                <input type="password" id="me-confirm" name="confirmPassword"
                                       class="form-control" minlength="8" required autocomplete="new-password">
                            </div>
                        </div>
                        <div class="form-footer">
                            <button type="submit" class="btn btn-success">Change Password</button>
                            <button type="button" class="btn btn-ghost" onclick="showAccountTab('view')">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', function (event) {
        if (event.target === modal) closeModal('account-modal');
    });
}

function showAccountTab(tab) {
    ['view', 'edit', 'password'].forEach((name) => {
        const panel = document.getElementById('account-' + name);
        const button = document.getElementById('account-tab-' + name);
        if (panel) panel.style.display = name === tab ? (name === 'view' ? 'grid' : 'block') : 'none';
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
        const response = await fetch('/api/me', { headers: apiHeaders() });
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

    const name = me.full_name || `${me.first_name} ${me.last_name}`;
    document.getElementById('account-name').textContent = name;
    document.getElementById('account-role').textContent = me.role_name;
    document.getElementById('account-avatar').textContent =
        ((me.first_name || '?')[0] + (me.last_name || '')[0] || '').toUpperCase();

    document.getElementById('account-view').innerHTML =
        detailRow('Staff ID', '#' + escapeHtml(me.staff_id)) +
        detailRow('Full Name', escapeHtml(name)) +
        detailRow('First Name', escapeHtml(me.first_name)) +
        detailRow('Middle Initial', me.middle_initial
            ? escapeHtml(me.middle_initial) + '.'
            : '<span class="muted">Not set</span>') +
        detailRow('Last Name', escapeHtml(me.last_name)) +
        detailRow('Username / Email', me.email
            ? escapeHtml(me.email)
            : '<span class="muted">No login account</span>') +
        detailRow('Phone', me.phone ? escapeHtml(me.phone) : '<span class="muted">Not set</span>') +
        detailRow('Role', escapeHtml(me.role_name)) +
        detailRow('Account Status', `<span class="badge ${me.is_active ? 'badge-success' : 'badge-danger'}">${me.is_active ? 'Active' : 'Inactive'}</span>`) +
        detailRow('Hired On', escapeHtml(me.staff_created_at)) +
        detailRow('Account Created', me.created_at
            ? escapeHtml(me.created_at) : '<span class="muted">Not available</span>') +
        detailRow('Last Login', me.last_login
            ? escapeHtml(me.last_login) : '<span class="muted">Never</span>');

    const form = document.getElementById('account-form');
    form.elements.firstName.value = me.first_name || '';
    form.elements.middleInitial.value = me.middle_initial || '';
    form.elements.lastName.value = me.last_name || '';
    form.elements.phone.value = me.phone || '';
    form.elements.email.value = me.email || '';
}

async function handleSaveMyProfile(event) {
    event.preventDefault();
    const form = event.target;

    const data = {
        firstName: form.elements.firstName.value.trim(),
        middleInitial: form.elements.middleInitial.value.trim(),
        lastName: form.elements.lastName.value.trim(),
        phone: form.elements.phone.value.trim(),
        email: form.elements.email.value.trim()
    };

    if (data.firstName === '' || data.lastName === '') {
        notifyWarning('A first name and a last name are both required.', 'Nothing was saved');
        return;
    }

    try {
        const response = await fetch('/api/me', {
            method: 'PUT', headers: apiHeaders(), body: JSON.stringify(data)
        });
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

    try {
        const response = await fetch('/api/me/password', {
            method: 'POST', headers: apiHeaders(),
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Password not changed');
            return;
        }

        form.reset();
        showAccountTab('view');
        notifySuccess('Your password was changed. Use it the next time you sign in.', 'Password changed');
    } catch (error) {
        notifyOffline();
    }
}

// keeps the copy the screens draw from in step with what was just saved
function rememberCurrentUser(user) {
    const current = getCurrentUser();
    if (!current || !user) return;

    current.first_name = user.first_name;
    current.middle_initial = user.middle_initial;
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
    window.location.href = 'Login.html';
}
