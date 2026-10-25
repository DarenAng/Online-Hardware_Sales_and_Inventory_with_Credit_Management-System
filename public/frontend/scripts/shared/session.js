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

function likelyMailDomain(email) {
    const at = String(email).lastIndexOf('@');
    if (at < 1) return null;

    const domain = String(email).slice(at + 1).toLowerCase();
    if (COMMON_MAIL_DOMAINS.indexOf(domain) !== -1) return null;

    let best = null;
    for (let i = 0; i < COMMON_MAIL_DOMAINS.length; i++) {
        const known = COMMON_MAIL_DOMAINS[i];
        const distance = editDistance(domain, known);
        if (distance > 0 && distance <= 2 && (!best || distance < best.distance)) {
            best = { domain: known, distance: distance };
        }
    }
    return best ? best.domain : null;
}

function rememberSignOutReason(text, tone) {
    try {
        sessionStorage.setItem('signOutReason', String(text || ''));
        sessionStorage.setItem('signOutTone', String(tone || ''));
    } catch (error) {  }
}

function showRememberedSignOutReason() {
    let text = '';
    let tone = '';
    try {
        text = sessionStorage.getItem('signOutReason') || '';
        tone = sessionStorage.getItem('signOutTone') || '';
        sessionStorage.removeItem('signOutReason');
        sessionStorage.removeItem('signOutTone');
    } catch (error) {  }

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
            const reason = String(result.error || 'That sign-in did not work').trim();

            if (response.status === 423) {
                showLoginAlert(reason.replace(/[.!]?$/, '.'));
            } else {
                const meant = likelyMailDomain(email);
                let advice;
                if (meant) {
                    advice = ' The address ends in ' + email.slice(email.lastIndexOf('@') + 1) +
                          '. Did you mean ' + meant + '? Check the email address, then type the password again.';
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

        forgetLoadedPanels();
        localStorage.setItem('currentUser', JSON.stringify(result.user));

        window.location.replace(landingPageFor(result.user));
    } catch (error) {
        notifyError('The server is not answering. Start it with npm start in the project folder, then try again.',
            'Cannot reach the server');
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

        currentUser.must_change_password = false;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        window.location.replace(landingPageFor(currentUser));
    } catch (error) {
        notifyError('The server is not answering. Start it with npm start in the project folder, then try again.', 'Cannot reach the server');
    }
}

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

    const STAFF_PAGES = ['manager.html', 'inventory-dashboard.html', 'cashier-dashboard.html', 'delivery.html'];
    if (STAFF_PAGES.indexOf(pageName) !== -1) {
        const ownPage = getRolePage(currentUser.role_name).toLowerCase();
        if (STAFF_PAGES.indexOf(ownPage) === -1) {
            window.location.replace(getRolePage(currentUser.role_name));
            return;
        }
        if (ownPage !== pageName) document.documentElement.classList.add('is-visiting');
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
    if (currentUser.role_name !== 'Cashier') startIdleWatch();
    holdAgainstBack();

    if (typeof startLiveSync === 'function') startLiveSync();
}

function holdAgainstBack() {
    if (!window.history || typeof window.history.pushState !== 'function') return;

    try {
        window.history.pushState({ held: true }, '', window.location.href);
    } catch (error) { return; }

    window.addEventListener('popstate', function () {
        try { window.history.pushState({ held: true }, '', window.location.href); } catch (error) {  }
    });
}

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
            showRememberedSignOutReason();
        });
}

window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;

    const currentUser = getCurrentUser();
    const pageName = window.location.pathname.split('/').pop().toLowerCase();
    const onLoginPage = pageName === 'login.html' || pageName === '';

    if (onLoginPage && currentUser) sendSignedInPersonOn(currentUser);
    if (!onLoginPage && !currentUser) window.location.replace('Login.html');
});

const HEARTBEAT_MS = 60 * 1000;
let heartbeatTimer = null;

function sendHeartbeat() {
    if (document.hidden) return;

    apiSendHeartbeat()
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (body) {
            if (body && body.idleMinutes > 0) {
                IDLE_LIMIT_MS = body.idleMinutes * 60 * 1000;
                IDLE_WARNING_MS = Math.min(60 * 1000, IDLE_LIMIT_MS / 2);
            }
        })
        .catch(function () {  });
}

function startHeartbeat() {
    if (heartbeatTimer) return;

    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) sendHeartbeat();
    });
}

let IDLE_LIMIT_MS = 30 * 60 * 1000;
let IDLE_WARNING_MS = 60 * 1000;

const ACTIVITY_KEY = 'lastActivity';
const ACTIVITY_SAVE_MS = 2000;
const ACTIVE_LATELY_MS = 70 * 1000;

let lastActivityAt = Date.now();
let lastActivitySavedAt = 0;
let lastMouseSpot = '';
let idleTimer = null;
let idleWarningShown = false;

function latestActivity() {
    let saved = 0;
    try {
        saved = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
    } catch (error) {  }

    return Math.max(lastActivityAt, saved);
}

function noteActivity(saveNow) {
    const now = Date.now();
    lastActivityAt = now;

    if (!saveNow && now - lastActivitySavedAt < ACTIVITY_SAVE_MS) return;
    lastActivitySavedAt = now;

    try {
        localStorage.setItem(ACTIVITY_KEY, String(now));
    } catch (error) {  }
}

function userWasActiveLately() {
    return Date.now() - latestActivity() < ACTIVE_LATELY_MS;
}

function onUserActivity(event) {
    if (idleWarningShown) return;

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

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'touchmove'];
    for (let i = 0; i < activityEvents.length; i++) {
        document.addEventListener(activityEvents[i], onUserActivity, { capture: true, passive: true });
    }

    idleTimer = setInterval(checkIdle, 1000);
}

function checkIdle() {
    const idleFor = Date.now() - latestActivity();

    if (idleFor >= IDLE_LIMIT_MS) {
        signOutForInactivity();
    } else if (idleFor >= IDLE_LIMIT_MS - IDLE_WARNING_MS) {
        showIdleWarning(IDLE_LIMIT_MS - idleFor);
    } else if (idleWarningShown) {
        hideIdleWarning();
    }
}

function buildIdleWarning() {
    let modal = document.getElementById('idle-modal');

    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'idle-modal';
        modal.setAttribute('data-modal-locked', '');
        modal.innerHTML = '\n' +
            '            <div class="modal-box ask-box">\n' +
            '                <div class="modal-head">\n' +
            '                    <div class="modal-identity">\n' +
            '                        <div class="avatar">!</div>\n' +
            '                        <div>\n' +
            '                            <h3>Still there?</h3>\n' +
            '                            <span class="modal-role">Signing out soon</span>\n' +
            '                        </div>\n' +
            '                    </div>\n' +
            '                </div>\n' +
            '                <div class="modal-body">\n' +
            '                    <p class="ask-text">You will be signed out in <strong id="idle-seconds">60</strong>\n' +
            '                        seconds because this screen has not been used for a while.</p>\n' +
            '                </div>\n' +
            '                <div class="modal-foot">\n' +
            '                    <button type="button" class="btn btn-ghost" onclick="signOutForInactivity()">Sign out now</button>\n' +
            '                    <button type="button" class="btn btn-accent" onclick="stayAfterWarning()">Stay signed in</button>\n' +
            '                </div>\n' +
            '            </div>';
    }

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

function staffName(user) {
    if (!user) return '';
    if (user.full_name) return user.full_name;

    const spelled = (user.first_name || '') + ' ' + (user.last_name || '');
    return spelled.trim() || user.email || '';
}

function currentRole() {
    const user = getCurrentUser();
    return user ? String(user.role_name || '') : '';
}

function hasRole() {
    const role = currentRole().toLowerCase();
    for (let i = 0; i < arguments.length; i++) {
        if (String(arguments[i]).trim().toLowerCase() === role) return true;
    }
    return false;
}

function applyAccessMarks(currentUser) {
    const role = String((currentUser && currentUser.role_name) || '').toLowerCase();

    const marked = document.querySelectorAll('[data-access]');
    for (let i = 0; i < marked.length; i++) {
        const element = marked[i];
        if (element.closest('.sidebar-nav')) continue;

        const allowed = [];
        const parts = String(element.getAttribute('data-access') || '').split(',');
        for (let p = 0; p < parts.length; p++) {
            const name = parts[p].trim().toLowerCase();
            if (name !== '') {
                allowed.push(name);
            }
        }

        if (allowed.length > 0 && allowed.indexOf(role) === -1) element.hidden = true;
    }
}

function applyCurrentUserToPage(currentUser) {
    if (!currentUser) return;

    const fullName = staffName(currentUser) || currentUser.email;

    const userBoxes = document.querySelectorAll('[data-current-user]');
    for (let i = 0; i < userBoxes.length; i++) {
        userBoxes[i].textContent = fullName;
    }
    const fullNameBoxes = document.querySelectorAll('[data-current-fullname]');
    for (let i = 0; i < fullNameBoxes.length; i++) {
        fullNameBoxes[i].textContent = fullName;
    }
    const roleBoxes = document.querySelectorAll('[data-current-role]');
    for (let i = 0; i < roleBoxes.length; i++) {
        roleBoxes[i].textContent = currentUser.role_name || '';
    }

    const first = (currentUser.first_name || currentUser.email || '?')[0];
    const last = (currentUser.last_name || '')[0] || '';
    const initialsBoxes = document.querySelectorAll('[data-current-initials]');
    for (let i = 0; i < initialsBoxes.length; i++) {
        initialsBoxes[i].textContent = (first + last).toUpperCase();
    }
}
document.addEventListener('DOMContentLoaded', initializeSession);
