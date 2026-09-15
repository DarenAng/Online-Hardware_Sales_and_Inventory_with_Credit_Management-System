// helpers.js -- shared helpers
// Loaded by: every page

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
    const inputs = named
        ? named.split(',').map((id) => document.getElementById(id.trim())).filter(Boolean)
        : (field ? [field.querySelector('input')].filter(Boolean) : []);
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

// Identity travels in the httpOnly session cookie. X-Client-ID is only a
// label for this tab so it can recognise its own writes on the live channel.
function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof CLIENT_ID === 'string') headers['X-Client-ID'] = CLIENT_ID;
    return headers;
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
