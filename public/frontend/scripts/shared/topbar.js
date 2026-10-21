function buildTopbarCorner() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || topbar.querySelector('.account-menu')) return;

    let corner = topbar.querySelector('.topbar-right');
    if (!corner) {
        corner = document.createElement('div');
        corner.className = 'topbar-right';
        topbar.appendChild(corner);
    }

    const plainUser = corner.querySelector('.topbar-user') || topbar.querySelector('.topbar-user');
    if (plainUser) plainUser.remove();

    if (!corner.querySelector('.bell')) {
        const bell = document.createElement('button');
        bell.type = 'button';
        bell.className = 'bell';
        bell.setAttribute('aria-label', 'Notifications');
        bell.setAttribute('onclick', 'toggleNotifications(event)');
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
    menu.innerHTML = '\n' +
        '        <button type="button" class="account-chip" id="account-chip" aria-expanded="false"\n' +
        '                aria-haspopup="true" onclick="toggleAccountMenu(event)">\n' +
        '            <span class="avatar" data-current-initials>--</span>\n' +
        '            <span class="account-chip-name" data-current-user>User</span>\n' +
        '            <span class="account-caret">&#9660;</span>\n' +
        '        </button>\n' +
        '        <div class="account-drop" id="account-drop">\n' +
        '            <div class="account-drop-head">\n' +
        '                <div class="avatar" data-current-initials>--</div>\n' +
        '                <div>\n' +
        '                    <span class="account-drop-name" data-current-fullname>User</span>\n' +
        '                    <span class="account-drop-role" data-current-role>Role</span>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '            <!-- ONE DOOR, NOT THREE\n' +
        '                 Edit my credentials and Change my password used to stand here\n' +
        '                 as menu items of their own. All three opened the same popup:\n' +
        '                 the popup has Credentials, Edit Details and Password as tabs\n' +
        '                 across the top of it, so the menu was offering three ways in\n' +
        '                 to one place and then showing the tabs anyway. Now the menu\n' +
        '                 opens the popup and the popup\'s own tabs do the choosing. -->\n' +
        '            <button type="button" class="account-action" onclick="openMyAccount(\'view\')">\n' +
        '                <span class="account-action-mark">&#9776;</span>View my credentials\n' +
        '            </button>\n' +
        '            <button type="button" class="account-action is-logout" onclick="confirmLogout()">\n' +
        '                <span class="account-action-mark">&#9099;</span>Log out\n' +
        '            </button>\n' +
        '        </div>';
    corner.appendChild(menu);

    const main = topbar.closest('.main-content') || document.body;
    if (!document.getElementById('notif-drop')) {
        const drop = document.createElement('div');
        drop.className = 'notif-drop';
        drop.id = 'notif-drop';
        drop.style.display = 'none';
        drop.innerHTML = '\n' +
            '            <div class="notif-head">\n' +
            '                <span class="eyebrow">Alerts</span>\n' +
            '                <button type="button" class="btn btn-sm btn-ghost"\n' +
            '                        onclick="markAllNotificationsRead()">Mark all read</button>\n' +
            '            </div>\n' +
            '            <div class="notif-list" id="notif-list"></div>\n' +
            '            <div class="notif-foot" id="notif-foot">Loading</div>';
        topbar.insertAdjacentElement('afterend', drop);
        if (!main.contains(drop)) main.appendChild(drop);
    }

    if (!document.getElementById('notif-modal')) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'notif-modal';
        modal.setAttribute('onclick', "closeModalOnBackdrop(event, 'notif-modal')");
        modal.innerHTML = '\n' +
            '            <div class="modal-box notif-modal-box">\n' +
            '                <div class="modal-head">\n' +
            '                    <div class="modal-identity">\n' +
            '                        <div class="avatar" id="notif-modal-avatar">!</div>\n' +
            '                        <div>\n' +
            '                            <span class="notif-modal-kind" id="notif-modal-kind">Alert</span>\n' +
            '                            <h3 id="notif-modal-title">Alert</h3>\n' +
            '                            <span class="modal-role" id="notif-modal-sub">Alert</span>\n' +
            '                        </div>\n' +
            '                    </div>\n' +
            '                    <button type="button" class="modal-close" onclick="closeModal(\'notif-modal\')"\n' +
            '                            aria-label="Close">&times;</button>\n' +
            '                </div>\n' +
            '                <div class="modal-body" id="notif-modal-body"></div>\n' +
            '                <div class="modal-foot" id="notif-modal-foot"></div>\n' +
            '            </div>';
        document.body.appendChild(modal);
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

    if (open) closeNotifications();
}

function closeAccountMenu() {
    const drop = document.getElementById('account-drop');
    const chip = document.getElementById('account-chip');
    if (drop) drop.classList.remove('open');
    if (chip) chip.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function (event) {
    if (!event.target.closest('.account-menu')) closeAccountMenu();

    const notifications = document.getElementById('notif-drop');
    if (notifications && notifications.style.display === 'flex' &&
        !event.target.closest('#notif-drop') && !event.target.closest('.bell')) {
        notifications.style.display = 'none';
    }
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAccountMenu();
});
