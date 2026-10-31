let invNotifications = [];
const poppedNotifications = readPoppedAlerts();

const POP_CARDS_AT_ONCE = 3;
const POP_MOST_QUEUED = 6;
const POP_RECHECK_MS = 700;
let popQueue = [];
let popTimer = null;

const NOTIF_TONE = {
    'Out of Stock':     'danger',
    'Low Stock':        'warning',
    'Damage Report':    'warning',
    'Refund Report':    'warning',
    'Purchase Order':   'info',
    'Stock Adjustment': 'info',
    'Delivery':         'warning',
    'Credit Request':   'info',
    'Late Penalty':     'danger',
    'New Product':      'warning',
    'Void Request':     'danger',
    'Customer Payment': 'success'
};

const NOTIF_ABOUT = {
    'Out of Stock':     ['Stock alert',       'A material has run out and cannot be sold until it is restocked.'],
    'Low Stock':        ['Stock alert',       'A material has fallen to its reorder point.'],
    'Damage Report':    ['Returns report',    'Damaged goods were reported and taken off the shelf.'],
    'Refund Report':    ['Returns report',    'A refund was filed at the counter.'],
    'Purchase Order':   ['Purchase order',    'An order to a supplier was raised, confirmed or declined, or its delivery came up short.'],
    'Stock Adjustment': ['Stock adjustment',  'A stock figure was corrected by hand.'],
    'Delivery':         ['Delivery',          'A delivery was created and needs a driver.'],
    'Credit Request':   ['Credit request',    'A cashier asked for a higher credit limit for a customer, and a manager has to decide it.'],
    'Late Penalty':     ['Late payment',      'A credit sale is another month past its due date still unpaid, and the month\'s late-payment penalty was added to it.'],
    'New Product':      ['New product',       'The inventory clerk added a product. It has no price yet, so the till cannot sell it until you set one.'],
    'Void Request':     ['Void request',      'A cashier asked for a sale of today to be voided, or a manager decided such a request.'],
    'Customer Payment': ['Customer payment',  'A customer paid a credit balance by QR code from the customer portal, and it was recorded on the sale.']
};

let notifTargets = {};

function configureNotificationTargets(map) {
    notifTargets = map || {};
}

function notifTargetFor(n) {
    const target = n ? notifTargets[n.notif_type] : null;
    if (!target) return null;

    if (target.panelId) {
        const link = document.querySelector('.sidebar-nav a[data-panel-link="' + target.panelId + '"]');
        if (!link) return null;
        const item = link.closest('li');
        if (item && item.hidden) return null;
        const module = item && item.parentElement ? item.parentElement.closest('li') : null;
        if (module && module.hidden) return null;
    }
    return target;
}

function findNotificationById(id) {
    for (let i = 0; i < invNotifications.length; i++) {
        if (String(invNotifications[i].notification_id) === String(id)) {
            return invNotifications[i];
        }
    }
    return undefined;
}

function goToNotification(id) {
    const n = findNotificationById(id);
    const target = notifTargetFor(n);
    if (!target) return;

    closeModal('notif-modal');
    target.open(n);

    if (!target.key) return;
    const product = target.searchId && n.product_name ? String(n.product_name) : '';
    if (product) {
        const box = document.getElementById(target.searchId);
        if (box) box.value = product;
        dataPanelSearch(target.key, product);
    } else {
        dataPanelOpen(target.key);
    }
}

function openNotifications() {
    const drop = document.getElementById('notif-drop');
    if (!drop) return;

    clearCards();
    popQueue = [];

    drop.style.display = 'flex';
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

    if (drop.style.display === 'flex') closeNotifications();
    else openNotifications();
}

async function loadNotifications() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    try {
        invNotifications = await apiGetNotifications();
    } catch (error) {
        list.innerHTML = '<p class="notif-empty">Cannot reach the server.</p>';
        return;
    }

    const unread = [];
    for (let i = 0; i < invNotifications.length; i++) {
        if (!invNotifications[i].is_read) unread.push(invNotifications[i]);
    }

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
        let itemsHtml = '';
        for (let i = 0; i < invNotifications.length; i++) {
            const n = invNotifications[i];
            itemsHtml += '<button type="button" class="notif-item' + (n.is_read ? '' : ' unread') +
                '" onclick="openNotification(' + n.notification_id + ')">' +
                '<span class="notif-type">' + escapeHtml(n.notif_type) + '</span>' +
                '<span class="notif-title">' + escapeHtml(idsInText(n.title)) + '</span>' +
                '<span class="notif-msg">' + escapeHtml(idsInText(n.message)) + '</span>' +
                '<span class="notif-meta">' +
                (n.is_read ? '' : '<span class="notif-new">New</span>') +
                '<span class="notif-from">From <strong>' + escapeHtml(n.from_name || 'System') + '</strong>' +
                (n.from_role ? ' (' + escapeHtml(n.from_role) + ')' : '') + '</span>' +
                '<span class="notif-when">' + escapeHtml(whenText(n.created_at)) + '</span>' +
                '</span></button>';
        }
        list.innerHTML = itemsHtml;
    }

    const foot = document.getElementById('notif-foot');
    if (foot) {
        if (invNotifications.length === 0) {
            foot.textContent = 'Nothing waiting';
        } else {
            foot.textContent = unread.length + ' unread of ' + invNotifications.length + ' shown';
        }
    }

    popNewNotifications(unread);
}

function readPoppedAlerts() {
    try {
        const ids = JSON.parse(sessionStorage.getItem(POPPED_ALERTS_KEY) || '[]');
        if (Array.isArray(ids)) {
            const once = [];
            for (let i = 0; i < ids.length; i++) {
                if (once.indexOf(ids[i]) === -1) once.push(ids[i]);
            }
            return once;
        }
    } catch (error) {  }
    return [];
}

function writePoppedAlerts() {
    try {
        sessionStorage.setItem(POPPED_ALERTS_KEY, JSON.stringify(poppedNotifications));
    } catch (error) {  }
}

function popNewNotifications(unread) {
    const fresh = [];
    for (let i = 0; i < unread.length; i++) {
        if (poppedNotifications.indexOf(unread[i].notification_id) === -1) fresh.push(unread[i]);
    }
    if (fresh.length === 0) return;

    for (let i = 0; i < fresh.length; i++) {
        if (poppedNotifications.indexOf(fresh[i].notification_id) === -1) {
            poppedNotifications.push(fresh[i].notification_id);
        }
    }
    writePoppedAlerts();

    if (fresh.length > POP_MOST_QUEUED) {
        popQueue = popQueue.concat(fresh.slice(0, POP_CARDS_AT_ONCE));
        popQueue.push({ more: fresh.length - POP_CARDS_AT_ONCE });
    } else {
        popQueue = popQueue.concat(fresh);
    }
    showQueuedCards();
}

function showQueuedCards() {
    clearTimeout(popTimer);
    popTimer = null;

    while (popQueue.length > 0) {
        const deck = document.getElementById('toast-deck');
        const onScreen = deck ? deck.querySelectorAll('.toast-card:not(.is-leaving)').length : 0;
        if (onScreen >= POP_CARDS_AT_ONCE) break;

        const queued = popQueue.shift();

        if (queued.more) {
            showCard({
                tone: 'warning',
                title: queued.more + ' more alerts',
                message: 'Open the bell in the top right corner to read them.',
                onOpen: function () {
                    openNotifications();
                }
            });
            continue;
        }

        let n;
        for (let i = 0; i < invNotifications.length; i++) {
            if (invNotifications[i].notification_id === queued.notification_id) {
                n = invNotifications[i];
                break;
            }
        }
        if (!n || n.is_read) continue;

        showCard({
            tone: NOTIF_TONE[n.notif_type] || 'info',
            title: idsInText(n.title),
            message: idsInText(n.message),
            from: n.from_name || 'System',
            when: n.created_at,
            onOpen: function () {
                openNotification(n.notification_id);
            }
        });
    }

    if (popQueue.length > 0) popTimer = setTimeout(showQueuedCards, POP_RECHECK_MS);
}

function openNotification(id) {
    const n = findNotificationById(id);
    if (!n) return;

    const tone = NOTIF_TONE[n.notif_type] || 'info';
    let badge;
    if (tone === 'danger') {
        badge = 'badge-danger';
    } else if (tone === 'warning') {
        badge = 'badge-warning';
    } else {
        badge = 'badge-neutral';
    }

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
    title.textContent = idsInText(n.title);
    sub.textContent = about[1] || n.notif_type;
    if (typeof initialsOf === 'function') {
        avatar.textContent = initialsOf(sender);
    } else {
        avatar.textContent = sender.slice(0, 2).toUpperCase();
    }
    avatar.className = 'avatar avatar-' + tone;

    const text = idsInText(n.message).trim() || 'No further detail was given.';
    const lines = text.split(/\n{2,}|\r?\n/);
    let paragraphs = '';
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== '') {
            paragraphs += '<p>' + escapeHtml(lines[i]) + '</p>';
        }
    }

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

    const target = notifTargetFor(n);
    foot.innerHTML = target
        ? '<button type="button" class="btn btn-accent" onclick="goToNotification(' +
          Number(n.notification_id) + ')">Go to ' + escapeHtml(target.label) + ' &rarr;</button>'
        : '';
    foot.hidden = !target;

    closeNotifications();
    showModal('notif-modal');

    if (!n.is_read) readNotification(n.notification_id);
}

async function readNotification(id) {
    try {
        await apiMarkNotificationRead(id);
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

async function markAllNotificationsRead() {
    try {
        const response = await apiMarkAllNotificationsRead();

        if (!response.ok) {
            const body = await response.json();
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Nothing was marked');
            return;
        }

        // The emptied list is the confirmation; no pop-up message.
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}
