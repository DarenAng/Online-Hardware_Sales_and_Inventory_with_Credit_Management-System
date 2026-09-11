// topbar.js  --  THE TOP RIGHT CORNER
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// THE TOP RIGHT CORNER
//
// Every module gets the same corner: the alert bell, and the account chip that
// opens on a click. Building it here rather than in five HTML files is what
// keeps it identical everywhere, and it is why the administrator and cashier
// screens now have the bell the other three already had.
// ==========================================
function buildTopbarCorner() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || topbar.querySelector('.account-menu')) return;

    let corner = topbar.querySelector('.topbar-right');
    if (!corner) {
        corner = document.createElement('div');
        corner.className = 'topbar-right';
        topbar.appendChild(corner);
    }

    // an old plain user chip is replaced by the menu version
    const plainUser = corner.querySelector('.topbar-user') || topbar.querySelector('.topbar-user');
    if (plainUser) plainUser.remove();

    if (!corner.querySelector('.bell')) {
        const bell = document.createElement('button');
        bell.type = 'button';
        bell.className = 'bell';
        bell.setAttribute('aria-label', 'Notifications');
        bell.setAttribute('onclick', 'toggleNotifications(event)');
        // A drawn bell rather than a character. The circled dot that stood
        // here reads as a record button, and this is the one control on the
        // page that has to be recognised without being read.
        bell.innerHTML = '<span class="bell-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5"/>' +
            '<path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg></span>' +
            '<span class="bell-badge" id="bell-badge" style="display: none;">0</span>';
        corner.appendChild(bell);
    }

    const menu = document.createElement('div');
    menu.className = 'account-menu';
    menu.innerHTML = `
        <button type="button" class="account-chip" id="account-chip" aria-expanded="false"
                aria-haspopup="true" onclick="toggleAccountMenu(event)">
            <span class="avatar" data-current-initials>--</span>
            <span class="account-chip-name" data-current-user>User</span>
            <span class="account-caret">&#9660;</span>
        </button>
        <div class="account-drop" id="account-drop">
            <div class="account-drop-head">
                <div class="avatar" data-current-initials>--</div>
                <div>
                    <span class="account-drop-name" data-current-fullname>User</span>
                    <span class="account-drop-role" data-current-role>Role</span>
                    <span class="account-drop-mail" data-current-email>No email</span>
                </div>
            </div>
            <!-- ONE DOOR, NOT THREE
                 Edit my credentials and Change my password used to stand here
                 as menu items of their own. All three opened the same popup:
                 the popup has Credentials, Edit Details and Password as tabs
                 across the top of it, so the menu was offering three ways in
                 to one place and then showing the tabs anyway. Now the menu
                 opens the popup and the popup's own tabs do the choosing. -->
            <button type="button" class="account-action" onclick="openMyAccount('view')">
                <span class="account-action-mark">&#9776;</span>View my credentials
            </button>
            <button type="button" class="account-action is-logout" onclick="confirmLogout()">
                <span class="account-action-mark">&#9099;</span>Log out
            </button>
        </div>`;
    corner.appendChild(menu);

    // the alert panel lives on every module too, not only on three of them
    const main = topbar.closest('.main-content') || document.body;
    if (!document.getElementById('notif-drop')) {
        const drop = document.createElement('div');
        drop.className = 'notif-drop';
        drop.id = 'notif-drop';
        drop.style.display = 'none';
        drop.innerHTML = `
            <div class="notif-head">
                <span class="eyebrow">Alerts</span>
                <button type="button" class="btn btn-sm btn-ghost"
                        onclick="markAllNotificationsRead()">Mark all read</button>
            </div>
            <div class="notif-list" id="notif-list"></div>
            <div class="notif-foot" id="notif-foot">Loading</div>`;
        topbar.insertAdjacentElement('afterend', drop);
        if (!main.contains(drop)) main.appendChild(drop);
    }
}

function toggleAccountMenu(event) {
    if (event) event.stopPropagation();

    const drop = document.getElementById('account-drop');
    const chip = document.getElementById('account-chip');
    if (!drop) return;

    const open = !drop.classList.contains('open');
    drop.classList.toggle('open', open);
    if (chip) chip.setAttribute('aria-expanded', String(open));

    // only one thing hangs off the top bar at a time
    if (open) closeNotifications();
}

function closeAccountMenu() {
    const drop = document.getElementById('account-drop');
    const chip = document.getElementById('account-chip');
    if (drop) drop.classList.remove('open');
    if (chip) chip.setAttribute('aria-expanded', 'false');
}

// clicking anywhere else puts both panels away
document.addEventListener('click', function (event) {
    if (!event.target.closest('.account-menu')) closeAccountMenu();

    const notifications = document.getElementById('notif-drop');
    if (notifications && notifications.style.display === 'block' &&
        !event.target.closest('#notif-drop') && !event.target.closest('.bell')) {
        notifications.style.display = 'none';
    }
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAccountMenu();
});
