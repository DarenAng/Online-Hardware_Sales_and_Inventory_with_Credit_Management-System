// helpers.js  --  SHARED HELPERS
// Loaded by: every page
// ------------------------------------------------------------------------
// ==========================================
// THE MENU ON A SMALL SCREEN
//
// On a desktop the menu is simply always there. On a phone it slides in over
// the page, and anything that slides over the page has to be dismissable
// without hunting for the button that opened it: the shade behind it closes
// it, Escape closes it, and choosing something from it closes it, because on
// a phone the screen you asked for is behind the menu you are still looking
// at. The page underneath is held still while the menu is open so a thumb
// scrolls the menu rather than the page behind it.
// ==========================================
function toggleSidebar(force) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const open = force === undefined ? !sidebar.classList.contains('active') : force;
    sidebar.classList.toggle('active', open);
    document.body.classList.toggle('sidebar-open', open);

    const shade = document.getElementById('sidebar-shade');
    if (shade) shade.classList.toggle('visible', open);

    const button = document.querySelector('.menu-toggle');
    if (button) button.setAttribute('aria-expanded', String(open));
}

function closeSidebar() { toggleSidebar(false); }

document.addEventListener('click', function (event) {
    if (event.target.closest('#sidebar-shade')) { closeSidebar(); return; }
    // a parent item only unfolds its own sub-menu; the page has not changed,
    // so the menu stays open
    const link = event.target.closest('.sidebar-nav a');
    if (link && !link.classList.contains('nav-parent')) closeSidebar();
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSidebar();
});

function switchTab(tabId, event) {
    const tabContents = document.querySelectorAll('.tab-content');
    const tabBtns = document.querySelectorAll('.tab-btn');

    tabContents.forEach(content => content.classList.remove('active'));
    tabBtns.forEach(btn => btn.classList.remove('active'));

    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');

    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }
}

// ==========================================
// SHARED HELPERS
// ==========================================
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Identity travels in the httpOnly session cookie the browser attaches on its
// own. There is deliberately no staff id here: the server decides who we are.
//
// X-Client-ID is not identity and is not trusted for anything. It is a label
// for this browser tab, so that when the server announces a change to every
// other screen, the screen that caused it can recognise its own work and not
// refresh twice.
function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof CLIENT_ID === 'string') headers['X-Client-ID'] = CLIENT_ID;
    return headers;
}

// One place to notice that the session has lapsed, so every screen reacts the
// same way instead of showing an empty table and no explanation. The server
// explains a refusal better than a generic line can, so pass the parsed body
// when there is one and its message wins.
function handleAuthFailure(response, result) {
    if (response.status === 401) {
        localStorage.removeItem('currentUser');
        notifyWarning('Your session has ended. Please sign in again.', 'Signed out');
        window.location.replace('Login.html');
        return true;
    }
    if (response.status === 403) {
        notifyError((result && result.error) || 'Your role does not have access to that.', 'Not allowed');
        return true;
    }
    return false;
}

function toggleDropdown(id, event) {
    if (event) event.preventDefault();
    const element = document.getElementById(id);
    if (!element) return;
    element.style.display = element.style.display === 'block' ? 'none' : 'block';
}
