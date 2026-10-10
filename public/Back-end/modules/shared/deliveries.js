// deliveries.js -- delivery records
// Loaded by: manager.html, cashier-dashboard.html, delivery.html

// A delivery goes one step at a time: the next step, plus Delayed and Failed,
// which can happen at any point on the way. The server checks the same list again (PATCH
// /api/deliveries/:id/status in Connections/cashier.js), so this only avoids
// offering a move that would come back refused.
const NEXT_DELIVERY_STATUS = {
    'Pending':          ['In Transit', 'Delayed', 'Failed'],
    'In Transit':       ['Out for Delivery', 'Delayed', 'Failed'],
    'Out for Delivery': ['Delivered', 'Delayed', 'Failed'],
    'Delayed':          ['In Transit', 'Out for Delivery', 'Failed'],
    'Failed':           ['Pending', 'In Transit', 'Out for Delivery'],
    'Delivered':        []
};

// said in the popup and again if the refund form is somehow opened anyway
function refundOwesMessage(balance) {
    return 'This order still owes ' + peso(balance) + '. A refund at the door is only for orders already ' +
        'paid in full. Write the refused item in the remarks and the manager or cashier will ' +
        'settle it at the counter.';
}

// One delivery popup for every screen. canUpdate adds the status change with
// a note (not the cashier); canArchive adds putting a closed delivery away
// (manager only). The driver sees everything on one page; the other roles
// turn through tabs.
function showDeliveryRecord(d, canUpdate, canArchive) {
    if (!d) return;

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const isDriver = !!user && user.role_name === 'Delivery Personnel';

    const route = '<div class="detail-grid">' +
        detailField('Delivery ID', '#' + d.delivery_id) +
        detailField('Sale', '#' + d.sale_id) +
        detailField('Status', statusBadge(d.status)) +
        detailField('Driver', escapeHtml(d.driver_name || 'Unassigned')) +
        detailField('Scheduled', escapeHtml(d.scheduled_date || 'Not set')) +
        detailField('Delivered At', d.delivered_at ? escapeHtml(d.delivered_at) : '<span class="muted">Not yet</span>') +
        '</div><p class="detail-note">' + escapeHtml(d.delivery_address) + '</p>';

    const stages = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered'];
    const reached = stages.indexOf(d.status);
    const timeline = '<ol class="timeline">' + stages.map((stage, i) =>
        '<li class="' + (i <= reached ? 'done' : '') + '"><span class="timeline-dot"></span>' + stage + '</li>'
    ).join('') + '</ol>' +
        (d.status === 'Delayed' || d.status === 'Failed'
            ? '<p class="detail-note detail-warn">This delivery is marked ' + escapeHtml(d.status) + '.</p>' : '') +
        (d.remarks ? '<p class="detail-note">' + escapeHtml(d.remarks) + '</p>' : '');

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
        { label: 'Progress', body: timeline },
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
        const next = (NEXT_DELIVERY_STATUS[d.status] || []).filter((s) => isDriver || s !== 'Delivered');

        updateBody = next.length === 0
            ? '<p class="detail-note">This delivery is closed. Nothing further can be recorded against it.</p>' + archiveBlock
            : '<div class="form-group"><label>Remarks <span class="label-hint">optional</span></label>' +
              '<textarea class="form-control" id="drec-remarks" rows="3" ' +
              'placeholder="Gate closed, customer not around, rain on the route"></textarea></div>' +
              '<p class="detail-note">Type a note here if there is one, then pick the new status below.</p>';

        pages.push({ label: 'Update', body: updateBody });

        footActions = next.map((s) =>
            '<button type="button" class="btn ' + (DELIVERY_STATUS_BUTTON[s] || 'btn-accent') + '" ' +
                'onclick="pickDeliveryStatus(' + d.delivery_id + ', \'' + s + '\')">' + s + '</button>'
        ).join('');
    }

    // The driver's refund at the door: only on their own delivery, once the
    // goods have reached the customer, and while the screen is switched on.
    // openDriverRefund is in delivery-personnel.js.
    const ownDelivery = typeof isMine === 'function' && isMine(d);
    const goodsAtDoor = d.status === 'Out for Delivery' || d.status === 'Delivered';
    const refundOn = typeof holdsFeature !== 'function' || holdsFeature('delivery-refunds');
    // A refund does not lower the bill, so it is only for an order paid in full
    const owes = Number(d.balance_due) > 0;
    if (isDriver && canUpdate && ownDelivery && goodsAtDoor && refundOn && !owes) {
        footActions = '<button type="button" class="btn btn-ghost" ' +
            'onclick="openDriverRefund(' + d.delivery_id + ')">Refund Items</button>' + footActions;
    }

    // The driver gets one page: the route, payment and progress on the left,
    // the goods and the remarks on the right. The items fill their
    // box when they arrive (fillDeliveryItems).
    if (isDriver) {
        const onePage = [{ label: 'Delivery', body:
            '<div class="drec-layout">' +
                '<div class="drec-side">' +
                    '<h4 class="detail-subhead">Route</h4>' + route +
                    '<h4 class="detail-subhead">Payment</h4><div class="detail-grid">' + money + '</div>' +
                    (owes && goodsAtDoor ? '<p class="detail-note detail-warn">' + refundOwesMessage(d.balance_due) + '</p>' : '') +
                    '<h4 class="detail-subhead">Progress</h4>' + timeline +
                '</div>' +
                '<div class="drec-main">' +
                    '<h4 class="detail-subhead" id="drec-items-title">Items</h4>' +
                    '<div id="drec-items">' + itemsPage.body + '</div>' +
                    (updateBody ? '<h4 class="detail-subhead">Remarks</h4>' + updateBody : '') +
                '</div>' +
            '</div>' }];

        // scroll: keep the one page and scroll it, rather than split it into pages
        openDetailModal('Delivery #' + d.delivery_id, d.customer_name + ' · ' + d.status, 'D' + d.delivery_id,
            onePage, footActions, { wide: 'xl', scroll: true });
        fillDeliveryItems(d.delivery_id, itemsPage, onePage);
        return;
    }

    openDetailModal('Delivery #' + d.delivery_id, d.customer_name + ' · ' + d.status, 'D' + d.delivery_id,
        pages, footActions);
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
        for (const it of items) {
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

// ---------- status updates ----------
async function sendDeliveryStatus(deliveryId, status, remarks) {
    try {
        const response = await apiUpdateDeliveryStatus(deliveryId, status, remarks);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message);

        // refresh whichever delivery list this page has
        if (typeof loadDriverDeliveries === 'function' && document.getElementById('dpend-table')) {
            await loadDriverDeliveries();
        } else if (typeof loadDeliveries === 'function' && document.getElementById('deliveries-table')) {
            await loadDeliveries();
        }

        // the schedule reads the same rows, and a browser is not told about its own writes
        if (typeof loadDeliverySchedule === 'function' && typeof scheduleRows !== 'undefined' && scheduleRows !== null) {
            await loadDeliverySchedule(true);
        }
    } catch (error) {
        notifyOffline();
    }
}
