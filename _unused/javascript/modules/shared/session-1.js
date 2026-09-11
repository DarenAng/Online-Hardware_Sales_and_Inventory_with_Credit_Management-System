// session.js  --  SESSION AND SIGN IN
// Loaded by: every page
// ------------------------------------------------------------------------

// ==========================================
// WHERE A REFUSED SIGN-IN IS ANSWERED
//
// Everywhere else in the system, a problem is reported by a card in the
// corner. That is right for a problem that arrives while somebody is reading
// a table: the card is out of the way of the thing they are working on.
//
// The sign-in screen is the one place where it is wrong. There is no table.
// There are two boxes and a button, the reader's eyes are on them, and the
// problem is about something they have just typed into one of them. A card
// in the far corner of a wide monitor is a message delivered somewhere the
// reader is demonstrably not looking.
//
// So a refused sign-in is answered at the form, and it stays until the next
// attempt rather than timing out. A card is still the right answer for the
// other failure on this screen — the server not being there at all — because
// that one is not about anything on the form.
// ==========================================
function showLoginAlert(message) {
    const box = document.getElementById('login-alert');
    if (!box) return;

    box.textContent = message;
    box.hidden = false;
}

function clearLoginAlert() {
    const box = document.getElementById('login-alert');
    if (!box) return;

    box.textContent = '';
    box.hidden = true;
}

async function handleLogin(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = form.elements.email.value;
    const password = form.elements.password.value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const result = await response.json();

        if (!response.ok) {
            // WHY THE MESSAGE USED TO VANISH
            //
            // This went through handleAuthFailure, which exists for the other
            // 401 in the system: a session that has quietly run out while
            // somebody was working. Its job there is to say so and send the
            // browser back to the sign-in screen, and it does that by calling
            // location.replace.
            //
            // A wrong password is also a 401, so a mistyped password was being
            // read as an expired session and the sign-in page reloaded itself.
            // The card explaining what went wrong was destroyed by that reload
            // a fraction of a second after it appeared, which is why the
            // message could be seen leaving but never read. Raising the card's
            // life would not have helped: nothing was timing out, the page was
            // being thrown away underneath it.
            //
            // On this form a 401 never means an expired session. There is no
            // session yet. So it is answered here.
            // the server's sentence, ended properly, then what to do about it
            const reason = String(result.error || 'That sign-in did not work').trim();

            showLoginAlert(reason.replace(/[.!]?$/, '.') +
                ' Check the email address, then type the password again.');

            // Retyping the password is the next thing that happens either way,
            // so the box is emptied and the cursor is put back in it. The email
            // is left alone: it is usually right, and usually the long one.
            const passwordBox = form.elements.password;
            if (passwordBox) {
                passwordBox.value = '';
                passwordBox.focus();
            }
            return;
        }

        clearLoginAlert();

        localStorage.setItem('currentUser', JSON.stringify(result.user));

        window.location.href = result.user.must_change_password
            ? 'change-password.html'
            : getRolePage(result.user.role_name);
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
        const response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword })
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        currentUser.must_change_password = false;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        window.location.href = getRolePage(currentUser.role_name);
    } catch (error) {
        notifyError('The server is not answering. Start it with npm start in the project folder, then try again.', 'Cannot reach the server');
    }
}

function getRolePage(roleName) {
    const rolePages = {
        'System Administrator': 'system.html',
        Manager: 'manager-dashboard.html',
        'Inventory Clerk': 'inventory-dashboard.html',
        Cashier: 'cashier-dashboard.html',
        'Delivery Personnel': 'delivery.html'
    };

    // an unrecognised role gets no landing page at all, rather than a
    // generic dashboard it was never meant to see
    return rolePages[roleName] || 'Login.html';
}

function logout() {
    localStorage.removeItem('currentUser');
    // tell the server to forget the session too, otherwise the cookie
    // would still be accepted until it expires on its own
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/logout', new Blob([], { type: 'application/json' }));
    } else {
        fetch('/api/logout', { method: 'POST', headers: apiHeaders(), keepalive: true });
    }
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
        // only worth telling the server to forget a session that exists
        if (currentUser) logout();
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

    if (pageName === 'manager-dashboard.html' && currentUser.role_name !== 'Manager') {
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
    startHeartbeat();

    // one open connection per screen, so a change made on another machine
    // reaches this one without anybody restoring a database by hand
    if (typeof startLiveSync === 'function') startLiveSync();
}

// ==========================================
// THE HEARTBEAT
//
// The staff directory shows who is signed in right now, and the server works
// that out from when it last heard from each session. A page left open makes
// no requests at all, so somebody reading a report for ten minutes would drop
// off the list while sitting right in front of it. This is the one call the
// browser makes on its own: a few bytes, once a minute, saying the page is
// still open.
//
// It stops while the tab is in the background, because a tab nobody is
// looking at is not a person at a counter, and it fires once as soon as the
// tab comes back so the list catches up without waiting out the interval.
// ==========================================
const HEARTBEAT_MS = 60 * 1000;
let heartbeatTimer = null;

function sendHeartbeat() {
    if (document.hidden) return;

    // a failed heartbeat changes nothing on the screen: the next real request
    // will report the session properly if it has actually ended
    fetch('/api/heartbeat', { method: 'POST', headers: apiHeaders() })
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

// writes the signed-in person into every place the page shows them
function applyCurrentUserToPage(currentUser) {
    if (!currentUser) return;

    const fullName = currentUser.full_name ||
        `${currentUser.first_name || ''} ${currentUser.last_name || ''}`.trim() ||
        currentUser.email;

    document.querySelectorAll('[data-current-user]').forEach((element) => {
        element.textContent = currentUser.first_name || currentUser.email;
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
