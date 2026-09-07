// deliveries.js  --  DELIVERY RECORDS
// Loaded by: manager-dashboard.html, cashier-dashboard.html, delivery.html
// ------------------------------------------------------------------------
// Which moves the system will accept from each stage. This mirrors the rule
// in sp_update_delivery_status; the database is what actually enforces it,
// this copy just avoids offering a choice that would only come back refused.
const NEXT_DELIVERY_STATUS = {
    'Pending':          ['In Transit', 'Out for Delivery', 'Delayed', 'Failed'],
    'In Transit':       ['Out for Delivery', 'Delayed', 'Failed'],
    'Out for Delivery': ['Delivered', 'Delayed', 'Failed'],
    'Delayed':          ['In Transit', 'Out for Delivery', 'Failed'],
    'Failed':           ['Pending', 'In Transit', 'Out for Delivery'],
    'Delivered':        []
};

// One delivery popup for every screen that shows deliveries. The manager,
// cashier and driver lists carry slightly different columns, so the money
// page shows the balance fields only when the caller supplied them.
// canUpdate adds the step where a note can be attached to a status change;
// the cashier does not get it, because booking a delivery is where their
// part ends.
function showDeliveryRecord(d, canUpdate) {
    if (!d) return;

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

    const pages = [
        { label: 'Route', body: route },
        { label: 'Progress', body: timeline },
        { label: 'Payment', body: '<div class="detail-grid">' + money + '</div>' }
    ];

    if (canUpdate) {
        const next = NEXT_DELIVERY_STATUS[d.status] || [];
        pages.push({
            label: 'Update',
            body: next.length === 0
                ? '<p class="detail-note">This delivery is closed. Nothing further can be recorded against it.</p>'
                : '<div class="form-group"><label>New Status</label>' +
                  '<select class="form-control" id="drec-status">' +
                  next.map((s) => '<option value="' + s + '">' + s + '</option>').join('') +
                  '</select></div>' +
                  '<div class="form-group"><label>Remarks <span class="label-hint">optional</span></label>' +
                  '<textarea class="form-control" id="drec-remarks" rows="3" ' +
                  'placeholder="Gate closed, customer not around, rain on the route"></textarea></div>' +
                  '<div class="detail-actions">' +
                  '<button type="button" class="btn btn-accent" onclick="submitDeliveryRecordUpdate(' + d.delivery_id + ')">Update Tracker</button>' +
                  '</div>'
        });
    }

    openDetailModal('Delivery #' + d.delivery_id, d.customer_name + ' · ' + d.status, 'D' + d.delivery_id, pages);
}

// the note-carrying path, for the times a plain button is not enough
async function submitDeliveryRecordUpdate(deliveryId) {
    const status = document.getElementById('drec-status');
    if (!status) return;

    const remarks = document.getElementById('drec-remarks');
    const note = remarks && remarks.value.trim() ? remarks.value.trim() : null;

    closeModal('detail-modal');
    await sendDeliveryStatus(deliveryId, status.value, note);
}

// ---------- status updates ----------
async function sendDeliveryStatus(deliveryId, status, remarks) {
    try {
        const response = await fetch('/api/deliveries/' + deliveryId + '/status', {
            method: 'PATCH',
            headers: apiHeaders(),
            body: JSON.stringify({ status: status, remarks: remarks })
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message);

        // Refresh whichever delivery list the caller is looking at. The
        // driver's page and the manager's page each show one of these lists
        // and neither loads the other's module, so the function that fills
        // the list is checked alongside the list itself.
        if (typeof loadDriverDeliveries === 'function' && document.getElementById('dpend-table')) {
            await loadDriverDeliveries();
        } else if (typeof loadDeliveries === 'function' && document.getElementById('deliveries-table')) {
            await loadDeliveries();
        }
    } catch (error) {
        notifyOffline();
    }
}
