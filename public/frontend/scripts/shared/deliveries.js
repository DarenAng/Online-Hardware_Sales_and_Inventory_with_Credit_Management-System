const NEXT_DELIVERY_STATUS = {
    'Pending':          ['In Transit'],
    'In Transit':       ['Out for Delivery'],
    'Out for Delivery': ['Delivered', 'Delayed', 'Failed'],
    'Delayed':          ['Out for Delivery', 'Failed'],
    'Failed':           ['Pending'],
    'Delivered':        []
};

function deliveryStepper(d) {
    const stages = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered'];
    const names = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered'];
    const notes = ['Sale made at the counter.', 'Loaded and on the road.', 'Driver is near the customer.',
        'Paid and handed over.'];
    let reached = stages.indexOf(d.status);
    if (d.status === 'Delayed') reached = stages.indexOf('Out for Delivery');

    const states = [];
    for (let i = 0; i < 4; i++) {
        if (reached === -1) {
            states.push(i === 0 ? 'done' : '');
        } else if (i < reached || d.status === 'Delivered') {
            states.push('done');
        } else if (i === reached) {
            states.push('now');
        } else {
            states.push('');
        }
    }

    const hasBalance = d.balance_due !== undefined && d.balance_due !== null && d.balance_due !== '';
    let paid;
    if (hasBalance) {
        paid = Number(d.balance_due) <= 0;
    } else {
        paid = d.payment_status === 'Paid';
    }

    if (d.status === 'Delivered' && d.delivered_at) notes[3] = escapeHtml(d.delivered_at);

    let items = '';
    for (let i = 0; i < names.length; i++) {
        items += '<li class="dstep-item ' + states[i] + '">' +
            '<span class="dstep-dot">' + (states[i] === 'done' ? '&#10003;' : (i + 1)) + '</span>' +
            '<span class="dstep-text"><span class="dstep-name">' + names[i] + '</span>' +
            '<span class="dstep-note">' + notes[i] + '</span></span>' +
        '</li>';
    }

    let summary;
    let tone = '';
    if (d.status === 'Pending') {
        summary = 'Waiting to go out.';
    } else if (d.status === 'In Transit' || d.status === 'Out for Delivery') {
        summary = 'On the way.';
    } else if (d.status === 'Delivered') {
        summary = paid ? 'This delivery is finished.' : 'Delivered. Balance still owed.';
        tone = paid ? 'is-ok' : 'is-warn';
    } else if (d.status === 'Delayed') {
        summary = 'Delayed.';
        tone = 'is-warn';
    } else if (d.status === 'Failed') {
        summary = 'Failed.';
        tone = 'is-fail';
    } else {
        summary = escapeHtml(d.status || '');
    }

    let message = '';
    if (d.status === 'Delayed' || d.status === 'Failed') {
        const late = d.status === 'Delayed';
        let words;
        if (d.remarks) {
            words = d.status + ': ' + escapeHtml(d.remarks);
        } else if (late) {
            words = 'This delivery is delayed.';
        } else {
            words = 'This delivery is marked failed.';
        }
        message = '<p class="dstep-message ' + (late ? 'is-warn' : 'is-fail') + '">' + words + '</p>';
    }

    return '<div class="dstep' + (message ? ' has-message' : '') + '">' +
        '<div class="dstep-row"><ol class="dstep-list">' + items + '</ol>' +
        '<div class="dstep-summary ' + tone + '">' + summary + '</div></div>' +
        message +
        '</div>';
}

function collectBanner(d) {
    if (d.balance_due === undefined || d.balance_due === null) return '';

    if (Number(d.balance_due) > 0) {
        let total = d.final_amount;
        if (d.amount_due !== undefined && d.amount_due !== null) total = d.amount_due;
        let note = 'Of ' + peso(total) + ', ' + peso(d.amount_paid) + ' is paid already.';
        if (d.status === 'Delivered') note = 'Delivered, but ' + peso(d.balance_due) + ' is still to be collected. ' + note;
        return '<div class="collect-banner is-owed"><span class="collect-label">To collect</span>' +
            '<strong class="collect-figure">' + peso(d.balance_due) + '</strong>' +
            '<span class="collect-note">' + escapeHtml(note) + '</span></div>';
    }
    return '<div class="collect-banner is-paid"><span class="collect-label">Payment</span>' +
        '<strong class="collect-figure">Paid in full</strong>' +
        '<span class="collect-note">Nothing to collect on this delivery.</span></div>';
}

function showDeliveryRecord(d, canUpdate) {
    if (!d) return;

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const isDriver = Boolean(user) && user.role_name === 'Delivery Personnel';

    const routeGrid = '<div class="detail-grid">' +
        detailField('Delivery ID', '#' + d.delivery_id) +
        detailField('Status', statusBadge(d.status)) +
        detailField('Scheduled', escapeHtml(d.scheduled_date || 'Not set')) +
        (d.status === 'Delivered' && d.delivered_at ? detailField('Delivered At', escapeHtml(d.delivered_at)) : '') +
        detailField('Drop-off Address', escapeHtml(d.delivery_address)) +
        '</div>';

    const cashierRemarks = d.cashier_remarks ? String(d.cashier_remarks).trim() : '';
    const routeNotes = cashierRemarks
        ? '<p class="detail-note">Remarks: ' + escapeHtml(cashierRemarks) + '</p>'
        : '<p class="detail-note"><span class="muted">No remarks.</span></p>';
    const route = routeGrid + routeNotes;

    let money = detailField('Customer', escapeHtml(d.customer_name)) +
        detailField('Phone', d.customer_phone ? escapeHtml(d.customer_phone) : '<span class="muted">Not set</span>') +
        detailField('Order Amount', peso(d.final_amount));

    if (d.balance_due !== undefined) {
        money += detailField('Amount Paid', peso(d.amount_paid)) +
            detailField('Balance Due', '<span class="' + (Number(d.balance_due) > 0 ? 'cell-due' : '') + '">' +
                peso(d.balance_due) + '</span>');
    } else {
        money += detailField('Payment Method', escapeHtml(d.payment_method));
    }

    money += detailField('Payment Status', statusBadge(d.payment_status));

    const itemsPage = { label: 'Items', body: '<p class="detail-empty">Loading the items…</p>' };

    const pages = [
        { label: 'Route', body: route },
        itemsPage,
        { label: 'Payment', body: collectBanner(d) + '<div class="detail-grid">' + money + '</div>' }
    ];

    let footActions = '';
    let updateBody = '';
    if (canUpdate) {
        const allowed = NEXT_DELIVERY_STATUS[d.status] || [];
        const next = [];
        for (let i = 0; i < allowed.length; i++) {
            if (isDriver || allowed[i] !== 'Delivered') next.push(allowed[i]);
        }

        if (next.length === 0) {
            updateBody = '<p class="detail-note">This delivery is closed. Nothing further can be recorded against it.</p>';
            pages.push({ label: 'Update', body: updateBody });
        }

        for (let i = 0; i < next.length; i++) {
            const s = next[i];
            const mine = typeof isMine === 'function' && isMine(d);
            const collectOn = typeof holdsFeature !== 'function' || holdsFeature('delivery-collect');
            if (s === 'Delivered' && isDriver && mine && collectOn && Number(d.balance_due) > 0) {
                footActions += '<button type="button" class="btn btn-success" ' +
                    'onclick="proceedToPayment(' + d.delivery_id + ')">Proceed Payment</button>';
            } else if (s === 'Delivered' && isDriver) {
                footActions += '<button type="button" class="btn btn-success" ' +
                    'onclick="pickDeliveryStatus(' + d.delivery_id + ', \'Delivered\')">Mark As Delivered</button>';
            } else {
                footActions += '<button type="button" class="btn ' + (DELIVERY_STATUS_BUTTON[s] || 'btn-accent') + '" ' +
                    'onclick="pickDeliveryStatus(' + d.delivery_id + ', \'' + s + '\')">' + s + '</button>';
            }
        }
    }

    const ownDelivery = typeof isMine === 'function' && isMine(d);
    const goodsAtDoor = d.status === 'Out for Delivery' || d.status === 'Delivered';
    const refundOn = typeof holdsFeature !== 'function' || holdsFeature('delivery-refunds');
    if (isDriver && canUpdate && ownDelivery && goodsAtDoor && refundOn) {
        footActions = '<button type="button" class="btn btn-ghost" ' +
            'onclick="openDriverRefund(' + d.delivery_id + ')">Refund Items</button>' + footActions;
    }

    if (isDriver) {
        const onePage = [{ label: 'Delivery', body:
            '<div class="drec-layout">' +
                '<div class="drec-side">' +
                    '<h4 class="detail-subhead">Route</h4>' + route +
                    '<h4 class="detail-subhead">Payment</h4>' + collectBanner(d) + '<div class="detail-grid">' + money + '</div>' +
                '</div>' +
                '<div class="drec-main">' +
                    '<h4 class="detail-subhead" id="drec-items-title">Items</h4>' +
                    '<div id="drec-items">' + itemsPage.body + '</div>' +
                    updateBody +
                '</div>' +
            '</div>' }];

        openDetailModal('Delivery #' + d.delivery_id, d.customer_name + ' · ' + d.status, 'D' + d.delivery_id,
            onePage, footActions, { wide: 'xl', scroll: true, top: deliveryStepper(d) });
        fillDeliveryItems(d.delivery_id, itemsPage, onePage);
        return;
    }

    openDetailModal('Delivery #' + d.delivery_id, d.customer_name + ' · ' + d.status, 'D' + d.delivery_id,
        pages, footActions, { top: deliveryStepper(d) });
    fillDeliveryItems(d.delivery_id, itemsPage, pages);
}

const DELIVERY_STATUS_BUTTON = {
    'Delivered': 'btn-success',
    'Delayed':   'btn-gold',
    'Failed':    'btn-danger'
};

async function fillDeliveryItems(deliveryId, page, pages) {
    let body;
    try {
        const items = await apiGetDeliveryItems(deliveryId);
        const rows = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];

            let quantity = escapeHtml(qtyText(it.quantity, it.unit_name));
            if (it.base_unit && it.unit_name && it.base_unit !== it.unit_name) {
                quantity += ' <span class="muted">(' + escapeHtml(qtyText(it.base_quantity, it.base_unit)) + ')</span>';
            }

            rows.push([
                escapeHtml(it.product_name),
                quantity,
                peso(it.unit_price),
                peso(it.subtotal)
            ]);
        }

        body = detailTable(['Product', 'Qty', 'Unit Price', 'Subtotal'], rows, [1, 2, 3]);
        page.label = 'Items (' + items.length + ')';
    } catch (error) {
        body = '<p class="detail-empty">The items could not be loaded.</p>';
    }

    page.body = body;

    if (detailPages !== pages) return;

    const box = document.getElementById('drec-items');
    if (box) {
        box.innerHTML = body;
        const title = document.getElementById('drec-items-title');
        if (title) title.textContent = page.label;
    } else {
        renderDetailPage();
    }
}

async function pickDeliveryStatus(deliveryId, status) {
    closeModal('detail-modal');

    if (status === 'Delayed' || status === 'Failed') {
        openDelayReason(deliveryId, status);
        return;
    }

    const yes = await askConfirm(
        status === 'Delivered'
            ? 'Delivery #' + deliveryId + ' is closed out as delivered, with the time recorded now. ' +
              'A closed delivery cannot be reopened.'
            : 'Delivery #' + deliveryId + ' is marked ' + status + '.',
        {
            title: 'Mark as ' + status + '?',
            eyebrow: 'Delivery',
            confirmLabel: 'Mark ' + status,
            tone: 'accent'
        });
    if (!yes) return;

    await sendDeliveryStatus(deliveryId, status, null);
}

let delayDeliveryId = null;
let delayStatus = 'Delayed';

function openDelayReason(deliveryId, status) {
    delayDeliveryId = deliveryId;
    delayStatus = status;
    const failed = status === 'Failed';

    document.getElementById('delay-subtitle').textContent = 'Delivery #' + deliveryId;
    document.getElementById('delay-title').textContent = failed ? 'Mark Failed' : 'Mark Delayed';
    document.getElementById('delay-label').textContent = failed ? 'Reason' : 'Reason for the delay';
    document.getElementById('delay-reason').value = '';

    const button = document.getElementById('delay-save');
    button.textContent = failed ? 'Mark Failed' : 'Mark Delayed';
    button.className = failed ? 'btn btn-danger' : 'btn btn-gold';

    showModal('delay-modal');
    guardModal('delay-modal', failed ? 'the reason for the failed delivery' : 'the reason for the delay');
}

async function handleDelayReason(event) {
    event.preventDefault();

    const reason = document.getElementById('delay-reason').value.trim();
    if (reason.length < 5) {
        const ask = delayStatus === 'Failed' ? 'Say why it failed, in a few words.' : 'Say why it is delayed, in a few words.';
        notifyWarning(ask, 'The reason is required');
        document.getElementById('delay-reason').focus();
        return;
    }

    const button = document.querySelector('#delay-modal button[type="submit"]');
    if (button && button.disabled) return;
    if (button) button.disabled = true;

    const saved = await sendDeliveryStatus(delayDeliveryId, delayStatus, reason);
    if (saved) closeModal('delay-modal');

    if (button) button.disabled = false;
}

function proceedToPayment(deliveryId) {
    closeModal('detail-modal');
    openDriverPayment(deliveryId, null);
}

async function sendDeliveryStatus(deliveryId, status, remarks) {
    let saved = false;
    try {
        const response = await apiUpdateDeliveryStatus(deliveryId, status, remarks);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return false;
        }

        saved = true;
        notifySuccess(result.message);

        await refreshDeliveryLists();
    } catch (error) {
        notifyOffline();
    }
    return saved;
}

async function refreshDeliveryLists() {
    if (typeof loadDriverDeliveries === 'function' && document.getElementById('dpend-table')) {
        await loadDriverDeliveries();
    } else if (typeof loadDeliveries === 'function' && document.getElementById('deliveries-table')) {
        await loadDeliveries();
    }

    if (typeof loadDeliverySchedule === 'function' && typeof scheduleRows !== 'undefined' && scheduleRows !== null) {
        await loadDeliverySchedule(true);
    }
}
