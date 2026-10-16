// deliveries.js -- delivery records
// Loaded by: manager.html, cashier-dashboard.html, delivery.html

// A delivery goes one step at a time, so the card shows one button: the next step.
// Delayed and Failed can only happen once the delivery is Out for Delivery (the
// driver is at the customer); a Delayed delivery goes back out or fails.
// The server checks the same list again (PATCH /api/deliveries/:id/status in
// routes/cashier.js), so this only avoids offering a move that would come back refused.
const NEXT_DELIVERY_STATUS = {
    'Pending':          ['In Transit'],
    'In Transit':       ['Out for Delivery'],
    'Out for Delivery': ['Delivered', 'Delayed', 'Failed'],
    'Delayed':          ['Out for Delivery', 'Failed'],
    'Failed':           ['Pending'],
    'Delivered':        []
};

// The progress bar at the top of the card: four steps that follow the delivery's
// status. Delivered is the last step and also means paid: recording the
// customer's payment marks the delivery Delivered at the same time.
// A step is 'done' (green tick), 'now' (dark, where the delivery is) or '' (not yet).
function deliveryStepper(d) {
    const stages = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered'];
    const names = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered'];
    // plain descriptions that read fine whether the step is done, current or still ahead
    const notes = ['Sale made at the counter.', 'Loaded and on the road.', 'Driver is near the customer.',
        'Paid and handed over.'];
    let reached = stages.indexOf(d.status);
    // a delivery can only be delayed while it is Out for Delivery, so that is where it stopped
    if (d.status === 'Delayed') reached = stages.indexOf('Out for Delivery');

    // Everything before the status is done and the status itself is "now".
    // The database does not remember where a Failed delivery was, so
    // only Pending is ticked and the rest stay grey.
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

    // Is anything still owed? Only used for the words on a Delivered card
    // (a part payment still closes the delivery; the counter collects the rest).
    // The driver's list can show a negative balance when the customer overpaid, so "<= 0".
    // (a missing, null or empty balance means "not known", so the payment status decides)
    const hasBalance = d.balance_due !== undefined && d.balance_due !== null && d.balance_due !== '';
    let paid;
    if (hasBalance) {
        paid = Number(d.balance_due) <= 0;
    } else {
        paid = d.payment_status === 'Paid';
    }

    // the Delivered step shows when it happened
    if (d.status === 'Delivered' && d.delivered_at) notes[3] = escapeHtml(d.delivered_at);

    let items = '';
    for (let i = 0; i < names.length; i++) {
        items += '<li class="dstep-item ' + states[i] + '">' +
            '<span class="dstep-dot">' + (states[i] === 'done' ? '&#10003;' : (i + 1)) + '</span>' +
            '<span class="dstep-text"><span class="dstep-name">' + names[i] + '</span>' +
            '<span class="dstep-note">' + notes[i] + '</span></span>' +
        '</li>';
    }

    // the one line on the right
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
        // a status this screen does not know: say it as it is rather than leave a gap
        summary = escapeHtml(d.status || '');
    }

    // Delayed and Failed also say so under the steps, with the remarks if there are any
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

    // with a message line, a narrow or short card leaves out the summary (it says the same)
    return '<div class="dstep' + (message ? ' has-message' : '') + '">' +
        '<div class="dstep-row"><ol class="dstep-list">' + items + '</ol>' +
        '<div class="dstep-summary ' + tone + '">' + summary + '</div></div>' +
        message +
        '</div>';
}

// One delivery popup for every screen. canUpdate adds the status change with
// a note (not the cashier); canArchive adds putting a closed delivery away
// (manager only). The driver sees everything on one page; the other roles
// turn through tabs.
function showDeliveryRecord(d, canUpdate, canArchive) {
    if (!d) return;

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const isDriver = !!user && user.role_name === 'Delivery Personnel';

    // No sale number and no driver on any card. Delivered At only shows once it is Delivered.
    const routeGrid = '<div class="detail-grid">' +
        detailField('Delivery ID', '#' + d.delivery_id) +
        detailField('Status', statusBadge(d.status)) +
        detailField('Scheduled', escapeHtml(d.scheduled_date || 'Not set')) +
        (d.status === 'Delivered' && d.delivered_at ? detailField('Delivered At', escapeHtml(d.delivered_at)) : '') +
        detailField('Drop-off Address', escapeHtml(d.delivery_address)) +
        '</div>';

    // Remarks: the note the cashier wrote for this delivery (muted when there is none).
    // A Delayed or Failed reason shows under the progress steps instead.
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

    // the goods come from the sale, one request away; the tab fills in when
    // they arrive and stays put if the popup has since been closed
    const itemsPage = { label: 'Items', body: '<p class="detail-empty">Loading the items…</p>' };

    const pages = [
        { label: 'Route', body: route },
        itemsPage,
        { label: 'Payment', body: '<div class="detail-grid">' + money + '</div>' }
    ];

    let archiveBlock;
    if (!canArchive) {
        archiveBlock = '';
    } else if (d.status === 'Delivered' || d.status === 'Failed') {
        archiveBlock = '<div class="detail-actions">' +
              '<button type="button" class="btn btn-ghost" onclick="archiveDelivery(' + d.delivery_id + ')">Archive this delivery</button>' +
              '</div>';
    } else {
        archiveBlock = '<p class="detail-note">A delivery is archived once it is Delivered and paid for, or Failed. ' +
              'The sweep puts it away ninety days after that on its own.</p>';
    }

    // the status moves sit in the popup's foot, one button each, on every tab
    let footActions = '';
    let updateBody = '';
    if (canUpdate) {
        // only the driver at the door can say Delivered; the procedure refuses anyone else
        const allowed = NEXT_DELIVERY_STATUS[d.status] || [];
        const next = [];
        for (let i = 0; i < allowed.length; i++) {
            if (isDriver || allowed[i] !== 'Delivered') next.push(allowed[i]);
        }

        updateBody = next.length === 0
            ? '<p class="detail-note">This delivery is closed. Nothing further can be recorded against it.</p>' + archiveBlock
            : '<div class="form-group"><label>Remarks <span class="label-hint">optional</span></label>' +
              '<textarea class="form-control" id="drec-remarks" rows="3" ' +
              'placeholder="Gate closed, customer not around, rain on the route"></textarea></div>';

        pages.push({ label: 'Update', body: updateBody });

        for (let i = 0; i < next.length; i++) {
            const s = next[i];
            // The driver collects what is owed on their own delivery before it is closed,
            // so Delivered becomes Proceed to Payment. Nothing owed: plain Delivered.
            const mine = typeof isMine === 'function' && isMine(d);
            if (s === 'Delivered' && isDriver && mine && Number(d.balance_due) > 0) {
                footActions += '<button type="button" class="btn btn-success" ' +
                    'onclick="proceedToPayment(' + d.delivery_id + ')">Proceed to Payment</button>';
            } else {
                footActions += '<button type="button" class="btn ' + (DELIVERY_STATUS_BUTTON[s] || 'btn-accent') + '" ' +
                    'onclick="pickDeliveryStatus(' + d.delivery_id + ', \'' + s + '\')">' + s + '</button>';
            }
        }
    }

    // The driver's refund at the door: only on their own delivery, once the
    // goods have reached the customer, and while the screen is switched on.
    // openDriverRefund is in delivery-personnel.js.
    const ownDelivery = typeof isMine === 'function' && isMine(d);
    const goodsAtDoor = d.status === 'Out for Delivery' || d.status === 'Delivered';
    const refundOn = typeof holdsFeature !== 'function' || holdsFeature('delivery-refunds');
    if (isDriver && canUpdate && ownDelivery && goodsAtDoor && refundOn) {
        footActions = '<button type="button" class="btn btn-ghost" ' +
            'onclick="openDriverRefund(' + d.delivery_id + ')">Refund Items</button>' + footActions;
    }

    // The driver gets one page: the route and payment on the left,
    // the goods and the remarks on the right. The items fill their
    // box when they arrive (fillDeliveryItems).
    if (isDriver) {
        const onePage = [{ label: 'Delivery', body:
            '<div class="drec-layout">' +
                '<div class="drec-side">' +
                    '<h4 class="detail-subhead">Route</h4>' + route +
                    '<h4 class="detail-subhead">Payment</h4><div class="detail-grid">' + money + '</div>' +
                '</div>' +
                '<div class="drec-main">' +
                    '<h4 class="detail-subhead" id="drec-items-title">Items</h4>' +
                    '<div id="drec-items">' + itemsPage.body + '</div>' +
                    (updateBody ? '<h4 class="detail-subhead">Remarks</h4>' + updateBody : '') +
                '</div>' +
            '</div>' }];

        // scroll: keep the one page and scroll it, rather than split it into pages
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
        // count the pieces: a measured item (like 2.5 kg of nails) counts as 1 piece
        let pieces = 0;
        const rows = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (isMeasuredUnit(it.unit_name)) {
                pieces = pieces + 1;
            } else {
                pieces = pieces + (Number(it.quantity) || 0);
            }

            // a size also shows what it came to on the shelf: 2 sack (50 kg)
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
        if (items.length > 0) {
            body += '<p class="detail-note">' + items.length + (items.length === 1 ? ' line, ' : ' lines, ') +
                (Number.isInteger(pieces) ? pieces : pieces.toFixed(2)) + (pieces === 1 ? ' item' : ' items') +
                ' to deliver.</p>';
        }
    } catch (error) {
        body = '<p class="detail-empty">The items could not be loaded.</p>';
    }

    page.body = body;

    // only touch the screen when this same popup is still the one on it
    if (detailPages !== pages) return;

    // the driver's one-page popup has a box for the items; a tab is redrawn
    const box = document.getElementById('drec-items');
    if (box) {
        box.innerHTML = body;
        const title = document.getElementById('drec-items-title');
        if (title) title.textContent = page.label;
    } else {
        renderDetailPage();
    }
}

// A status button in the popup's foot. The note is read before the popup
// closes; it is only on screen while the Update tab (the driver: the one page) is open.
async function pickDeliveryStatus(deliveryId, status) {
    const remarks = document.getElementById('drec-remarks');
    const note = remarks && remarks.value.trim() ? remarks.value.trim() : null;

    closeModal('detail-modal');

    // Delayed needs a reason, so it has its own small popup (#delay-modal)
    if (status === 'Delayed') {
        openDelayReason(deliveryId, note);
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
            tone: status === 'Failed' ? 'danger' : 'accent'
        });
    if (!yes) return;

    await sendDeliveryStatus(deliveryId, status, note);
}

// ---------- the reason for a Delayed delivery ----------
let delayDeliveryId = null;

// The remarks already typed in the card are put in the box to start with.
function openDelayReason(deliveryId, note) {
    delayDeliveryId = deliveryId;

    document.getElementById('delay-subtitle').textContent = 'Delivery #' + deliveryId;
    document.getElementById('delay-reason').value = note || '';

    showModal('delay-modal');
}

// Mark Delayed: the reason is sent as the remarks with the new status
async function handleDelayReason(event) {
    event.preventDefault();

    const reason = document.getElementById('delay-reason').value.trim();
    if (reason.length < 5) {
        notifyWarning('Say why it is delayed, in a few words.', 'The reason is required');
        document.getElementById('delay-reason').focus();
        return;
    }

    // The button is off while this sends, so a double tap cannot send it twice.
    const button = document.querySelector('#delay-modal button[type="submit"]');
    if (button && button.disabled) return;   // already sending
    if (button) button.disabled = true;

    // The popup stays open until the change is saved, so a failure keeps the typed reason.
    const saved = await sendDeliveryStatus(delayDeliveryId, 'Delayed', reason);
    if (saved) closeModal('delay-modal');

    if (button) button.disabled = false;
}

// Proceed to Payment, in the driver's card: the card closes and the Receive
// Payment card (delivery-personnel.js) opens for the same delivery. The remarks
// typed in the card go along and are saved when the delivery is marked Delivered.
function proceedToPayment(deliveryId) {
    const remarks = document.getElementById('drec-remarks');
    const note = remarks && remarks.value.trim() ? remarks.value.trim() : null;

    closeModal('detail-modal');
    openDriverPayment(deliveryId, note);
}

// ---------- status updates ----------
// Gives back true when the server saved the change, false when it did not.
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

// After a change: read again whichever delivery list this page has
async function refreshDeliveryLists() {
    if (typeof loadDriverDeliveries === 'function' && document.getElementById('dpend-table')) {
        await loadDriverDeliveries();
    } else if (typeof loadDeliveries === 'function' && document.getElementById('deliveries-table')) {
        await loadDeliveries();
    }

    // the schedule reads the same rows, and a browser is not told about its own writes
    if (typeof loadDeliverySchedule === 'function' && typeof scheduleRows !== 'undefined' && scheduleRows !== null) {
        await loadDeliverySchedule(true);
    }
}
