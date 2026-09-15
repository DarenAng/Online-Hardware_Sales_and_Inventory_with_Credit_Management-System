// notifications.js -- the bell and its popup cards
// Loaded by: all five dashboards
// Unseen alerts pop once per session as cards; opening one marks it read.
let invNotifications = [];
const poppedNotifications = new Set();
let notificationsEverLoaded = false;

const NOTIF_TONE = {
    'Out of Stock':     'danger',
    'Low Stock':        'warning',
    'Damage Report':    'warning',
    'Refund Report':    'warning',
    'Purchase Order':   'info',
    'Stock Adjustment': 'info',
    'Delivery':         'warning'
};

// heading shown over the subject line when an alert is opened
const NOTIF_ABOUT = {
    'Out of Stock':     ['Stock alert',       'A material has run out and cannot be sold until it is restocked.'],
    'Low Stock':        ['Stock alert',       'A material has fallen to its reorder point.'],
    'Damage Report':    ['Returns report',    'Damaged goods were reported and taken off the shelf.'],
    'Refund Report':    ['Returns report',    'A refund was filed at the counter.'],
    'Purchase Order':   ['Purchase order',    'An order to a supplier was raised, and a delivery is expected.'],
    'Stock Adjustment': ['Stock adjustment',  'A stock figure was corrected by hand.'],
    'Delivery':         ['Delivery',          'A delivery was booked and needs a driver.']
};

function openNotifications() {
    const drop = document.getElementById('notif-drop');
    if (!drop) return;

    clearCards();

    drop.style.display = 'block';
    closeAccountMenu();
    loadNotifications();
}

function closeNotifications() {
    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';
}

function toggleNotifications(event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }

    const drop = document.getElementById('notif-drop');
    if (!drop) return;

    if (drop.style.display === 'block') closeNotifications();
    else openNotifications();
}

async function loadNotifications() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    try {
        invNotifications = await getJson('/api/notifications');
    } catch (error) {
        list.innerHTML = '<p class="notif-empty">Cannot reach the server.</p>';
        return;
    }

    const unread = invNotifications.filter((n) => !n.is_read);

    const badge = document.getElementById('bell-badge');
    if (badge) {
        badge.textContent = unread.length;
        badge.style.display = unread.length > 0 ? 'inline-flex' : 'none';
    }

    const bell = document.querySelector('.bell');
    if (bell) bell.classList.toggle('has-unread', unread.length > 0);

    if (invNotifications.length === 0) {
        list.innerHTML =
            '<p class="notif-empty">No alerts for the ' +
            escapeHtml((getCurrentUser() || {}).role_name || 'this') +
            ' role yet. Low stock, damage reports, purchase orders and new ' +
            'deliveries all arrive here.</p>';
    } else {
        list.innerHTML = invNotifications.map((n) =>
            '<button type="button" class="notif-item' + (n.is_read ? '' : ' unread') +
            '" onclick="openNotification(' + n.notification_id + ')">' +
            '<span class="notif-type">' + escapeHtml(n.notif_type) + '</span>' +
            '<span class="notif-title">' + escapeHtml(n.title) + '</span>' +
            '<span class="notif-msg">' + escapeHtml(n.message || '') + '</span>' +
            '<span class="notif-meta">' +
            (n.is_read ? '' : '<span class="notif-new">New</span>') +
            '<span class="notif-from">From <strong>' + escapeHtml(n.from_name || 'System') + '</strong>' +
            (n.from_role ? ' (' + escapeHtml(n.from_role) + ')' : '') + '</span>' +
            '<span class="notif-when">' + escapeHtml(whenText(n.created_at)) + '</span>' +
            '</span></button>'
        ).join('');
    }

    const foot = document.getElementById('notif-foot');
    if (foot) {
        foot.textContent = invNotifications.length === 0
            ? 'Nothing waiting'
            : `${unread.length} unread of ${invNotifications.length} shown`;
    }

    popNewNotifications(unread);
}

// the newest three unseen alerts come forward; the rest stay behind the bell
function popNewNotifications(unread) {
    const fresh = unread.filter((n) => !poppedNotifications.has(n.notification_id));
    fresh.forEach((n) => poppedNotifications.add(n.notification_id));

    if (!notificationsEverLoaded) {
        notificationsEverLoaded = true;
        if (fresh.length === 0) return;

        if (fresh.length > 2) {
            showCard({
                tone: 'warning',
                title: fresh.length + ' alerts are waiting',
                message: 'Open the bell in the top right corner to read them.',
                onOpen: () => openNotifications(),
                life: 7000
            });
            return;
        }
    }

    fresh.slice(0, 2).forEach((n) => {
        showCard({
            tone: NOTIF_TONE[n.notif_type] || 'info',
            title: n.title,
            message: n.message || '',
            from: n.from_name || 'System',
            when: n.created_at,
            onOpen: () => openNotification(n.notification_id),
            life: 9000
        });
    });
}

// One alert, laid out like a mail: subject, sender and time, then the message.
function openNotification(id) {
    const n = invNotifications.find((item) => String(item.notification_id) === String(id));
    if (!n) return;

    const tone = NOTIF_TONE[n.notif_type] || 'info';
    const badge = tone === 'danger' ? 'badge-danger' : tone === 'warning' ? 'badge-warning' : 'badge-neutral';
    const sender = n.from_name || 'System';

    const title = document.getElementById('notif-modal-title');
    const sub = document.getElementById('notif-modal-sub');
    const avatar = document.getElementById('notif-modal-avatar');
    const body = document.getElementById('notif-modal-body');
    const foot = document.getElementById('notif-modal-foot');
    if (!title || !body || !foot) return;

    const about = NOTIF_ABOUT[n.notif_type] || [n.notif_type + ' alert', ''];
    const kind = document.getElementById('notif-modal-kind');
    if (kind) {
        kind.textContent = about[0];
        kind.className = 'notif-modal-kind is-' + tone;
    }
    title.textContent = n.title;
    sub.textContent = about[1] || n.notif_type;
    avatar.textContent = typeof initialsOf === 'function' ? initialsOf(sender) : sender.slice(0, 2).toUpperCase();
    avatar.className = 'avatar avatar-' + tone;

    const text = String(n.message || '').trim() || 'No further detail was given.';
    const paragraphs = text.split(/\n{2,}|\r?\n/).filter(Boolean)
        .map((line) => '<p>' + escapeHtml(line) + '</p>').join('');

    body.innerHTML =
        '<div class="mail-head">' +
            '<div class="mail-from">' +
                '<span class="mail-from-name">' + escapeHtml(sender) + '</span>' +
                (n.from_role ? '<span class="mail-from-role">' + escapeHtml(n.from_role) + '</span>' : '') +
                '<span class="badge ' + badge + '">' + escapeHtml(n.notif_type) + '</span>' +
            '</div>' +
            '<div class="mail-when">' + escapeHtml(whenText(n.created_at)) +
                '<span class="mail-when-exact">' + escapeHtml(String(n.created_at || '').slice(0, 16)) + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="mail-body">' + paragraphs + '</div>' +
        (n.product_name
            ? '<div class="mail-about">About <strong>' + escapeHtml(n.product_name) + '</strong></div>'
            : '');

    foot.innerHTML =
        '<button type="button" class="btn btn-ghost" onclick="closeModal(\'notif-modal\')">Close</button>';

    closeNotifications();
    showModal('notif-modal');

    if (!n.is_read) readNotification(n.notification_id);
}

async function readNotification(id) {
    try {
        await fetch('/api/notifications/' + id + '/read',
            { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) });
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

async function markAllNotificationsRead() {
    try {
        const response = await fetch('/api/notifications/read-all', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({})
        });

        if (!response.ok) {
            const body = await response.json();
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Nothing was marked');
            return;
        }

        await loadNotifications();
        notifySuccess('Every alert for your role is marked as read.', 'Alerts cleared');
    } catch (error) {
        notifyOffline();
    }
}
