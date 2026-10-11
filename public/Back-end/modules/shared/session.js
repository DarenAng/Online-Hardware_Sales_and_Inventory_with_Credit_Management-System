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

        forgetLoadedPanels();   // a new sign-in starts with closed tables
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

    // the same rules the server checks (passwordComplaint in format.js)
    const complaint = passwordComplaint(newPassword);
    if (complaint) {
        notifyWarning(complaint, 'Password not saved');
        return;
    }

    try {
        const response = await apiSaveFirstPassword(newPassword);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        // the server kept this screen signed in on a new session, so carry on
        // straight to the dashboard
        currentUser.must_change_password = false;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        window.location.replace(landingPageFor(currentUser));
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
    forgetLoadedPanels();
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
        // every way of signing out ends here, so nobody inherits loaded tables
        forgetLoadedPanels();
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
    startIdleWatch();
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
            forgetLoadedPanels();
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
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (body) {
            // the server says how long a screen may sit unused (SESSION_IDLE_MINUTES)
            if (body && body.idleMinutes > 0) {
                IDLE_LIMIT_MS = body.idleMinutes * 60 * 1000;
                IDLE_WARNING_MS = Math.min(60 * 1000, IDLE_LIMIT_MS / 2);   // a minute before
            }
        })
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

// ==========================================
// SIGNING OUT WHEN THE SCREEN IS NOT USED
//
// The mouse, the keyboard, the wheel and touch count as using the screen. The
// time of the latest one is kept in localStorage, so every tab of the site
// shares it: working in one tab keeps the others signed in. A minute before
// the limit a card warns; at the limit the person is signed out and sent to
// the sign-in page with the reason. The server enforces the same limit
// (SESSION_IDLE_MINUTES in server.js), counting only asks sent while the
// screen was in use: apiHeaders marks the others X-Background.
// ==========================================
let IDLE_LIMIT_MS = 30 * 60 * 1000;   // unused this long and the sign-in ends (30 until the server's heartbeat answer says otherwise)
let IDLE_WARNING_MS = 60 * 1000;      // the card shows this long before that

const ACTIVITY_KEY = 'lastActivity';
const ACTIVITY_SAVE_MS = 2000;            // write to localStorage at most this often
const ACTIVE_LATELY_MS = 70 * 1000;       // a bit longer than the heartbeat gap

let lastActivityAt = Date.now();          // this tab's own copy; opening the page counts
let lastActivitySavedAt = 0;
let lastMouseSpot = '';                   // where the mouse was at its last move
let idleTimer = null;
let idleWarningShown = false;

// the time of the latest activity in any tab (this tab's own copy if localStorage is blocked)
function latestActivity() {
    let saved = 0;
    try {
        saved = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
    } catch (error) { /* blocked: this tab's own copy is all there is */ }

    return Math.max(lastActivityAt, saved);
}

function noteActivity(saveNow) {
    const now = Date.now();
    lastActivityAt = now;

    if (!saveNow && now - lastActivitySavedAt < ACTIVITY_SAVE_MS) return;
    lastActivitySavedAt = now;

    try {
        localStorage.setItem(ACTIVITY_KEY, String(now));
    } catch (error) { /* blocked */ }
}

// used by apiHeaders: has anybody touched the site (in any tab) in the last minute or so?
function userWasActiveLately() {
    return Date.now() - latestActivity() < ACTIVE_LATELY_MS;
}

function onUserActivity(event) {
    // while the warning is up only its own button counts, so the card cannot
    // be dismissed by a bump of the mouse
    if (idleWarningShown) return;

    // A mousemove at the same spot is not a person: the browser fires one when
    // the page moves under a still mouse (a table redrawn by a live update).
    if (event.type === 'mousemove') {
        const spot = event.screenX + ',' + event.screenY;
        if (spot === lastMouseSpot) return;
        lastMouseSpot = spot;
    }
    noteActivity(false);
}

function startIdleWatch() {
    if (idleTimer) return;

    noteActivity(true);

    // The scroll event is not used: the page scrolls by itself when a live
    // update changes a table's height. A wheel turn or a finger drag is a person.
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'touchmove'].forEach(function (name) {
        document.addEventListener(name, onUserActivity, { capture: true, passive: true });
    });

    idleTimer = setInterval(checkIdle, 1000);
}

function checkIdle() {
    const idleFor = Date.now() - latestActivity();

    if (idleFor >= IDLE_LIMIT_MS) {
        signOutForInactivity();
    } else if (idleFor >= IDLE_LIMIT_MS - IDLE_WARNING_MS) {
        showIdleWarning(IDLE_LIMIT_MS - idleFor);
    } else if (idleWarningShown) {
        hideIdleWarning();   // another tab was used meanwhile
    }
}

function buildIdleWarning() {
    let modal = document.getElementById('idle-modal');

    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'idle-modal';
        modal.setAttribute('data-modal-locked', '');   // Escape does not close it
        modal.innerHTML = `
            <div class="modal-box ask-box">
                <div class="modal-head">
                    <div class="modal-identity">
                        <div class="avatar">!</div>
                        <div>
                            <h3>Still there?</h3>
                            <span class="modal-role">Signing out soon</span>
                        </div>
                    </div>
                </div>
                <div class="modal-body">
                    <p class="ask-text">You will be signed out in <strong id="idle-seconds">60</strong>
                        seconds because this screen has not been used for a while.</p>
                </div>
                <div class="modal-foot">
                    <button type="button" class="btn btn-ghost" onclick="signOutForInactivity()">Sign out now</button>
                    <button type="button" class="btn btn-accent" onclick="stayAfterWarning()">Stay signed in</button>
                </div>
            </div>`;
    }

    // added last, so it sits above any other card that is open
    document.body.appendChild(modal);
    return modal;
}

function showIdleWarning(msLeft) {
    if (!idleWarningShown) {
        buildIdleWarning();
        showModal('idle-modal');
        idleWarningShown = true;
    }

    const seconds = Math.max(1, Math.ceil(msLeft / 1000));
    const number = document.getElementById('idle-seconds');
    if (number) number.textContent = seconds;
}

function hideIdleWarning() {
    idleWarningShown = false;
    closeModal('idle-modal');
}

// "Stay signed in": counts as use, and tells the server straight away
function stayAfterWarning() {
    hideIdleWarning();
    noteActivity(true);
    sendHeartbeat();
}

function signOutForInactivity() {
    clearInterval(idleTimer);
    idleTimer = null;
    hideIdleWarning();

    const minutes = Math.max(1, Math.round(IDLE_LIMIT_MS / 60000));
    localStorage.removeItem('currentUser');
    rememberSignOutReason('You were signed out after ' + minutes +
        (minutes === 1 ? ' minute' : ' minutes') + ' of inactivity. Please sign in again.');
    apiSignOut();
    window.location.replace('Login.html');
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
