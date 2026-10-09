// session.js -- session and sign in
// Loaded by: every page

// A refused sign-in is answered at the form, not by a corner card, and stays
// until the next attempt.
// The alert is crimson for a refusal; 'good' turns it green for the one kind
// of news that lands here without anything having gone wrong -- a password
// just changed, so the person is back at sign-in on purpose.
function showLoginAlert(message, tone) {
    const box = document.getElementById('login-alert');
    if (!box) return;

    box.textContent = message;
    box.classList.toggle('is-good', tone === 'good');
    box.hidden = false;
}

function clearLoginAlert() {
    const box = document.getElementById('login-alert');
    if (!box) return;

    box.textContent = '';
    box.classList.remove('is-good');
    box.hidden = true;
}

// The server answers a wrong address and a wrong password with the same
// sentence, so a domain one letter off a common one is pointed out here first.
const COMMON_MAIL_DOMAINS = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
    'icloud.com', 'live.com', 'protonmail.com', 'yahoo.com.ph'
];

function editDistance(a, b) {
    const rows = [];
    for (let i = 0; i <= a.length; i += 1) {
        rows[i] = [i];
        for (let j = 1; j <= b.length; j += 1) {
            if (i === 0) {
                rows[i][j] = j;
            } else {
                rows[i][j] = Math.min(
                    rows[i - 1][j] + 1,
                    rows[i][j - 1] + 1,
                    rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
        }
    }
    return rows[a.length][b.length];
}

// the domain this address probably meant, or null
function likelyMailDomain(email) {
    const at = String(email).lastIndexOf('@');
    if (at < 1) return null;

    const domain = String(email).slice(at + 1).toLowerCase();
    if (COMMON_MAIL_DOMAINS.indexOf(domain) !== -1) return null;

    let best = null;
    for (const known of COMMON_MAIL_DOMAINS) {
        const distance = editDistance(domain, known);
        if (distance > 0 && distance <= 2 && (!best || distance < best.distance)) {
            best = { domain: known, distance: distance };
        }
    }
    return best ? best.domain : null;
}

// A screen that sends the browser to sign in has a sentence to say; a card
// would be destroyed by the navigation, so it is parked in sessionStorage.
function rememberSignOutReason(text, tone) {
    try {
        sessionStorage.setItem('signOutReason', String(text || ''));
        sessionStorage.setItem('signOutTone', String(tone || ''));
    } catch (error) { /* private mode */ }
}

function showRememberedSignOutReason() {
    let text = '';
    let tone = '';
    try {
        text = sessionStorage.getItem('signOutReason') || '';
        tone = sessionStorage.getItem('signOutTone') || '';
        sessionStorage.removeItem('signOutReason');
        sessionStorage.removeItem('signOutTone');
    } catch (error) { /* nothing stored */ }

    if (text) showLoginAlert(text, tone);
}

async function handleLogin(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;

    try {
        const response = await apiSignIn(email, password);

        const result = await response.json();

        if (!response.ok) {
            // A wrong password is also a 401, but on this form it never means an
            // expired session, so it is answered here instead of via handleAuthFailure.
            const reason = String(result.error || 'That sign-in did not work').trim();

            // a held account (423) says all it needs to; a wrong password gets
            // the usual advice, plus the warning when the next one holds it
            if (response.status === 423) {
                showLoginAlert(reason.replace(/[.!]?$/, '.'));
            } else {
                const meant = likelyMailDomain(email);
                let advice;
                if (meant) {
                    advice = ' The address ends in ' + email.slice(email.lastIndexOf('@') + 1) +
                          ' \u2014 did you mean ' + meant + '? Check the email address, then type the password again.';
                } else {
                    advice = ' Check the email address, then type the password again.';
                }

                const warning = result.warning ? ' ' + String(result.warning) : '';

                showLoginAlert(reason.replace(/[.!]?$/, '.') + advice + warning);
            }

            const passwordBox = form.elements.password;
            if (passwordBox) {
                passwordBox.value = '';
                passwordBox.focus();
            }
            return;
        }

        clearLoginAlert();

        localStorage.setItem('currentUser', JSON.stringify(result.user));

        // replace, not assign: the sign-in page leaves the history, so the
        // browser's Back button cannot return to it once signed in
        window.location.replace(landingPageFor(result.user));
    } catch (error) {
        notifyError('The server is not answering. Start it with npm start in the project folder, then try again.',
            'Cannot reach the server', { life: SIGN_IN_MESSAGE_LIFE });
    }
}

async function handlePasswordChange(event) {
    event.preventDefault();

    const currentUser = getCurrentUser();
    const form = event.currentTarget;
    const newPassword = form.elements.newPassword.value;
    const confirmPassword = form.elements.confirmPassword.value;

    if (!currentUser || !currentUser.must_change_password) {
        window.location.replace('Login.html');
        return;
    }

    if (newPassword !== confirmPassword) {
        notifyWarning('The two passwords do not match. Type the same one in both boxes.', 'Password not saved');
        return;
    }

    if (newPassword.length < 8) {
        notifyWarning('A password needs at least 8 characters.', 'Password not saved');
        return;
    }

    try {
        const response = await apiSaveFirstPassword(newPassword);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        signOutWithReason(result.message
            ? result.message.replace(/[.!]?$/, '.') + ' Sign in again with the new one.'
            : 'Your password was changed. Sign in again with the new one.', 'good');
    } catch (error) {
        notifyError('The server is not answering. Start it with npm start in the project folder, then try again.', 'Cannot reach the server');
    }
}

// where a signed-in person belongs: their dashboard, or the password screen first
function landingPageFor(user) {
    return user.must_change_password ? 'change-password.html' : getRolePage(user.role_name);
}

function getRolePage(roleName) {
    const rolePages = {
        'System Administrator': 'system.html',
        Manager: 'manager.html',
        'Inventory Clerk': 'inventory-dashboard.html',
        Cashier: 'cashier-dashboard.html',
        'Delivery Personnel': 'delivery.html'
    };

    return rolePages[roleName] || 'Login.html';
}

// The way out after the server has already closed the session.
function signOutWithReason(reason, tone) {
    localStorage.removeItem('currentUser');
    rememberSignOutReason(reason, tone);
    window.location.replace('Login.html');
}

function logout() {
    localStorage.removeItem('currentUser');
    apiSignOut();
}

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem('currentUser') || 'null');
    } catch (error) {
        logout();
        return null;
    }
}

function initializeSession() {
    const currentUser = getCurrentUser();
    const pageName = window.location.pathname.split('/').pop().toLowerCase();

    if (pageName === 'login.html' || pageName === '') {
        if (currentUser) {
            sendSignedInPersonOn(currentUser);
            return;
        }
        showRememberedSignOutReason();
        return;
    }

    if (!currentUser) {
        window.location.replace('Login.html');
        return;
    }

    if (pageName === 'system.html' && currentUser.role_name !== 'System Administrator') {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    if (pageName === 'manager.html' && currentUser.role_name !== 'Manager') {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    if (pageName === 'inventory-dashboard.html' && currentUser.role_name !== 'Inventory Clerk') {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    if (pageName === 'cashier-dashboard.html' && currentUser.role_name !== 'Cashier') {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    if (pageName === 'delivery.html' && currentUser.role_name !== 'Delivery Personnel') {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    if (currentUser.must_change_password && pageName !== 'change-password.html') {
        window.location.replace('change-password.html');
        return;
    }

    if (pageName === 'change-password.html' && !currentUser.must_change_password) {
        window.location.replace(getRolePage(currentUser.role_name));
        return;
    }

    ensureUiFurniture();
    buildTopbarCorner();
    watchTablesForAlignment();
    applyCurrentUserToPage(currentUser);
    applyAccessMarks(currentUser);
    startHeartbeat();
    holdAgainstBack();

    if (typeof startLiveSync === 'function') startLiveSync();
}

// ==========================================
// THE BACK BUTTON, ONCE SIGNED IN
//
// Three layers, because browsers differ:
//   1. signing in replaces the sign-in page in the history (handleLogin), so
//      there is nothing behind the dashboard to go back to;
//   2. a signed-in page pins itself: a Back press or swipe pops the pinned
//      entry and the page pins itself again, staying put;
//   3. the sign-in page itself sends anybody still signed in straight on,
//      including a copy restored from the back-forward cache on a phone.
// ==========================================
function holdAgainstBack() {
    if (!window.history || typeof window.history.pushState !== 'function') return;

    try {
        window.history.pushState({ held: true }, '', window.location.href);
    } catch (error) { return; }   // a file:// page, or a browser that refuses

    window.addEventListener('popstate', function () {
        try { window.history.pushState({ held: true }, '', window.location.href); } catch (error) { /* stay */ }
    });
}

// A person on the sign-in page who is still signed in belongs on their own
// screen. The server is asked first, so a session that has already ended
// leaves them here to sign in again rather than bouncing them twice.
function sendSignedInPersonOn(currentUser) {
    apiGetMyAccount()
        .then(function (response) {
            if (response.ok) {
                window.location.replace(landingPageFor(currentUser));
                return;
            }
            localStorage.removeItem('currentUser');
            showRememberedSignOutReason();
        })
        .catch(function () {
            // the server is not there; the form is the right place to be
            showRememberedSignOutReason();
        });
}

// A page brought back from the back-forward cache (a phone's swipe-back does
// this) runs no scripts on the way in, so the session is checked again.
window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;

    const currentUser = getCurrentUser();
    const pageName = window.location.pathname.split('/').pop().toLowerCase();
    const onLoginPage = pageName === 'login.html' || pageName === '';

    if (onLoginPage && currentUser) sendSignedInPersonOn(currentUser);
    if (!onLoginPage && !currentUser) window.location.replace('Login.html');
});

// The staff directory shows who is signed in from when the server last heard
// from each session; a page left open makes no requests, so this pings once
// a minute while the tab is visible.
const HEARTBEAT_MS = 60 * 1000;
let heartbeatTimer = null;

function sendHeartbeat() {
    if (document.hidden) return;

    apiSendHeartbeat()
        .catch(function () { /* the server is not there; nothing to say about it */ });
}

function startHeartbeat() {
    if (heartbeatTimer) return;

    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) sendHeartbeat();
    });
}

// Fallback spelling of a name before /api/me answers: first, middle initial,
// last -- the same as staff.full_name.
function staffName(user) {
    if (!user) return '';
    if (user.full_name) return user.full_name;

    const middle = (user.middle_name || '').trim();
    const initial = middle === '' ? '' : ' ' + middle[0].toUpperCase() + '.';

    return `${user.first_name || ''}${initial} ${user.last_name || ''}`.trim() ||
        user.email || '';
}

// Page-side half of access control: any element marked
//   data-access="Manager,System Administrator"
// is removed for other roles. It hides and never grants.
function currentRole() {
    const user = getCurrentUser();
    return user ? String(user.role_name || '') : '';
}

function hasRole() {
    const role = currentRole().toLowerCase();
    return Array.prototype.some.call(arguments,
        (name) => String(name).trim().toLowerCase() === role);
}

function applyAccessMarks(currentUser) {
    const role = String((currentUser && currentUser.role_name) || '').toLowerCase();

    document.querySelectorAll('[data-access]').forEach((element) => {
        if (element.closest('.sidebar-nav')) return;

        // data-access="Manager, Cashier" -> ['manager', 'cashier']
        const allowed = [];
        for (const part of String(element.getAttribute('data-access') || '').split(',')) {
            const name = part.trim().toLowerCase();
            if (name !== '') {
                allowed.push(name);
            }
        }

        if (allowed.length > 0 && allowed.indexOf(role) === -1) element.hidden = true;
    });
}

function applyCurrentUserToPage(currentUser) {
    if (!currentUser) return;

    const fullName = staffName(currentUser) || currentUser.email;

    document.querySelectorAll('[data-current-user]').forEach((element) => {
        element.textContent = fullName;
    });
    document.querySelectorAll('[data-current-fullname]').forEach((element) => {
        element.textContent = fullName;
    });
    document.querySelectorAll('[data-current-role]').forEach((element) => {
        element.textContent = currentUser.role_name || '';
    });
    document.querySelectorAll('[data-current-email]').forEach((element) => {
        element.textContent = currentUser.email || 'No email on file';
    });

    const first = (currentUser.first_name || currentUser.email || '?')[0];
    const last = (currentUser.last_name || '')[0] || '';
    document.querySelectorAll('[data-current-initials]').forEach((element) => {
        element.textContent = (first + last).toUpperCase();
    });
}
document.addEventListener('DOMContentLoaded', initializeSession);
