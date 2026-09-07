// notifications.js  --  NOTIFICATIONS
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// NOTIFICATIONS
//
// The bell keeps the full list for this role. Anything that has not been seen
// yet also pops up as a card in the corner, because an alert nobody notices is
// not an alert. Each alert pops once per session: the ones already shown are
// remembered, so a refresh does not repeat itself.
// ==========================================
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

function openNotifications() {
    const drop = document.getElementById('notif-drop');
    if (!drop) return;

    // The popup cards are a preview of this same list, so they step aside
    // rather than sitting on top of the thing they were previewing.
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
            '" onclick="readNotification(' + n.notification_id + ')">' +
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

// the newest three unseen alerts come forward as cards; the rest stay
// behind the bell so the corner never becomes a wall
function popNewNotifications(unread) {
    const fresh = unread.filter((n) => !poppedNotifications.has(n.notification_id));
    fresh.forEach((n) => poppedNotifications.add(n.notification_id));

    if (!notificationsEverLoaded) {
        notificationsEverLoaded = true;
        if (fresh.length === 0) return;

        // On arrival, one card saying how many are waiting reads better than a
        // stack of them covering the screen the person came here to use.
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
            onOpen: () => openNotifications(),
            life: 9000
        });
    });
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
