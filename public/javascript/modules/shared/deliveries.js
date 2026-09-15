// deliveries.js -- delivery records
// Loaded by: manager-dashboard.html, cashier-dashboard.html, delivery.html

// Mirrors sp_update_delivery_status; the database enforces it, this only
// avoids offering a move that would come back refused.
const NEXT_DELIVERY_STATUS = {
    'Pending':          ['In Transit', 'Out for Delivery', 'Delayed', 'Failed'],
    'In Transit':       ['Out for Delivery', 'Delayed', 'Failed'],
    'Out for Delivery': ['Delivered', 'Delayed', 'Failed'],
    'Delayed':          ['In Transit', 'Out for Delivery', 'Failed'],
    'Failed':           ['Pending', 'In Transit', 'Out for Delivery'],
    'Delivered':        []
};

// One delivery popup for every screen. canUpdate adds the status change with
// a note (not the cashier); canArchive adds putting a closed delivery away
// (manager only).
function showDeliveryRecord(d, canUpdate, canArchive) {
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

    const archiveBlock = !canArchive ? ''
        : (d.status === 'Delivered' || d.status === 'Failed')
        ? '<div class="detail-actions">' +
          '<button type="button" class="btn btn-ghost" onclick="archiveDelivery(' + d.delivery_id + ')">Archive this delivery</button>' +
          '</div>'
        : '<p class="detail-note">A delivery is archived once it is Delivered and paid for, or Failed. ' +
          'The sweep puts it away ninety days after that on its own.</p>';

    if (canUpdate) {
        const next = NEXT_DELIVERY_STATUS[d.status] || [];
        pages.push({
            label: 'Update',
            body: next.length === 0
                ? '<p class="detail-note">This delivery is closed. Nothing further can be recorded against it.</p>' + archiveBlock
                : '<div class="form-group"><label>New status</label>' +
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
