// helpers.js -- shared helpers
// Loaded by: every page

// Where data-panel.js writes down which tables are loaded, so they load again
// after a reload, and where notifications.js writes down which alerts have
// already had their popup card. Signing in or out empties both, so the next
// person starts with closed tables and sees their alerts pop up.
const LOADED_PANELS_KEY = 'loadedPanels';
const POPPED_ALERTS_KEY = 'poppedAlerts';

function forgetLoadedPanels() {
    try {
        sessionStorage.removeItem(LOADED_PANELS_KEY);
        sessionStorage.removeItem(POPPED_ALERTS_KEY);
    } catch (error) { /* storage is blocked: nothing was kept */ }
}

// On a phone the menu slides over the page: the shade, Escape and choosing an
// item all close it, and the page is held still while it is open.
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

// Every page's showXPanel calls this on the way to a new screen: whatever
// was open over the old one -- the menu on a phone, the alert list, the
// account menu -- closes, and the new screen starts at
// the top.
function leaveScreenFurniture() {
    closeSidebar();
    if (typeof closeNotifications === 'function') closeNotifications();
    if (typeof closeAccountMenu === 'function') closeAccountMenu();
    window.scrollTo(0, 0);
}

document.addEventListener('click', function (event) {
    if (event.target.closest('#sidebar-shade')) { closeSidebar(); return; }
    // a parent item only unfolds its own sub-menu
    const link = event.target.closest('.sidebar-nav a');
    if (link && !link.classList.contains('nav-parent')) closeSidebar();
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSidebar();
});

// Show/Hide password buttons:
//   <div class="password-field"><input type="password"...>
//       <button type="button" class="password-toggle" aria-pressed="false">Show</button></div>
// or one button naming several boxes:
//   <button class="password-toggle" data-password-for="new-password,confirm-password">
document.addEventListener('click', function (event) {
    const toggle = event.target.closest('.password-toggle');
    if (!toggle) return;

    const named = toggle.getAttribute('data-password-for');
    const field = toggle.closest('.password-field');
    // the password boxes this button shows or hides
    const inputs = [];
    if (named) {
        for (const id of named.split(',')) {
            const input = document.getElementById(id.trim());
            if (input) inputs.push(input);
        }
    } else if (field) {
        const input = field.querySelector('input');
        if (input) inputs.push(input);
    }

    if (inputs.length === 0) return;

    const showing = inputs[0].type === 'text';
    inputs.forEach((input) => { input.type = showing ? 'password' : 'text'; });

    const word = showing ? 'Show' : 'Hide';
    const noun = inputs.length > 1 ? 'passwords' : 'password';
    toggle.textContent = named ? word + ' ' + noun : word;
    toggle.setAttribute('aria-pressed', String(!showing));
    toggle.setAttribute('aria-label', word + ' ' + noun);

    const back = inputs.find((input) => input.value === '') || inputs[inputs.length - 1];
    back.focus();
    const end = back.value.length;
    try { back.setSelectionRange(end, end); } catch (error) { /* not every type allows it */ }
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


// One place to notice a lapsed session; the server's message wins when given.
function handleAuthFailure(response, result) {
    if (response.status === 401) {
        localStorage.removeItem('currentUser');
        if (typeof rememberSignOutReason === 'function') {
            rememberSignOutReason((result && result.error) || 'Your session has ended. Please sign in again.');
        }
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

// A module heading marked data-sidebar-dropdown folds its list; only one
// list is open at a time. Each page's toggleXMenu hands its ids here.
function toggleSidebarMenu(navId, listId, event, force) {
    if (event) event.preventDefault();

    const heading = document.getElementById(navId);
    const list = document.getElementById(listId);
    if (!heading || !list) return;

    const open = force === undefined ? list.style.display !== 'block' : force;

    if (open) {
        document.querySelectorAll('.sidebar-nav li[data-sidebar-dropdown]').forEach((item) => {
            const otherList = item.querySelector(':scope > .nav-sub');
            const otherHeading = item.querySelector(':scope > .nav-parent');
            if (!otherList || otherList === list) return;
            otherList.style.display = 'none';
            if (otherHeading) {
                otherHeading.classList.remove('is-open');
                otherHeading.setAttribute('aria-expanded', 'false');
            }
        });
    }

    list.style.display = open ? 'block' : 'none';
    heading.classList.toggle('is-open', open);
    heading.setAttribute('aria-expanded', String(open));
}

// A folding heading is one control: pressing anywhere on it, the words or the
// caret, folds or unfolds the list beneath. Unfolding it also opens the first
// screen in the list (one the role still has), so a press always lands
// somewhere; folding it leaves the open screen as it is.
function sidebarHeading(event, navId, listId, openScreen) {
    toggleSidebarMenu(navId, listId, event);

    const list = document.getElementById(listId);
    if (!list || list.style.display !== 'block') return;

    const first = list.querySelector(':scope > li:not([hidden]) > a');
    if (first) first.click();
    else if (typeof openScreen === 'function') openScreen();
}

// ==========================================
// DATE FILTERS -- a filter asks about what has happened, so no box in a
// toolbar can pick a day after today. The limit is read again whenever a box
// is used, so a page left open overnight moves with the calendar.
// ==========================================
function todayDateValue() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
}

function limitDateFilter(input) {
    if (!input) return;
    const today = todayDateValue();
    input.max = today;
    // a date typed by hand past today is brought back to today
    if (input.value && input.value > today) {
        input.value = today;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function limitDateFilters() {
    document.querySelectorAll('.toolbar-field input[type="date"]').forEach(limitDateFilter);
}

document.addEventListener('DOMContentLoaded', limitDateFilters);
['focusin', 'input', 'change'].forEach((name) => {
    document.addEventListener(name, (event) => {
        const target = event.target;
        if (target && target.matches && target.matches('.toolbar-field input[type="date"]')) {
            limitDateFilter(target);
        }
    }, true);
});
