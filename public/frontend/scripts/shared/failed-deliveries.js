// Failed Deliveries: shared by the manager and inventory clerk pages.
// A failed delivery is given a new date and driver here, and goes back to Pending.

const failedSetup = {
    panelId: 'panel-failed-deliveries',
    title: 'Failed Deliveries'
};

function showFailedDeliveries(event) {
    if (event) event.preventDefault();

    // Each page has its own function that shows a panel and lights up the sidebar link
    if (typeof showManagerPanel === 'function') {
        showManagerPanel(failedSetup.panelId, failedSetup.title, event);
    } else if (typeof showInventoryPanel === 'function') {
        showInventoryPanel(failedSetup.panelId, failedSetup.title, event);
    }
}

function buildFailedDeliveriesPanel() {
    const area = document.querySelector('.content-area');
    if (!area || document.getElementById(failedSetup.panelId)) return;

    const panel = document.createElement('div');
    panel.id = failedSetup.panelId;
    panel.setAttribute('data-panel', '');
    panel.style.display = 'none';
    panel.innerHTML =
        '<div class="card">' +
            '<div class="panel-head"><div><h3>Failed Deliveries</h3></div></div>' +
            '<div class="panel-toolbar">' +
                '<div class="search-wrap">' +
                    '<input type="search" class="form-control search-input" id="failed-search" ' +
                        'placeholder="Search by customer or destination" ' +
                        'oninput="dataPanelSearchInput(\'failed-deliveries\', event)" ' +
                        'onkeydown="dataPanelSearchKey(\'failed-deliveries\', event)">' +
                '</div>' +
            '</div>' +
            '<div class="table-responsive grid-10">' +
                '<table id="failed-table">' +
                    '<thead><tr><th>ID</th><th>Customer</th><th>Destination</th><th>Failed On</th>' +
                    '<th>Reason</th><th class="col-num">Attempts</th></tr></thead>' +
                    '<tbody></tbody>' +
                '</table>' +
            '</div>' +
            '<div class="pager is-single" id="failed-pager"></div>' +
        '</div>';
    area.appendChild(panel);

    createDataPanel({
        key: 'failed-deliveries',
        tableId: 'failed-table',
        columns: 6,
        pagerId: 'failed-pager',
        idField: 'delivery_id',
        gate: { title: 'Failed deliveries are not loaded', text: 'Press Load Data to read them.', button: 'Load Data' },
        empty: { title: 'No failed deliveries' },

        load: function () {
            return apiGetFailedDeliveries();
        },

        match: function (d, query) {
            return prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id, deliveryCode(d.delivery_id)], query);
        },

        renderRow: function (d, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openFailedDelivery(' + d.delivery_id + ')">' +
                '<td class="cell-id">' + deliveryCode(d.delivery_id) + '</td>' +
                '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
                '<td>' + escapeHtml(d.delivery_address) + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(d.failed_on || '').slice(0, 16)) + '</td>' +
                '<td>' + escapeHtml(d.remarks || '') + '</td>' +
                '<td class="cell-num">' + Number(d.attempt_count) + '</td></tr>';
        }
    });

    buildRescheduleModal();
}

function findFailedDelivery(deliveryId) {
    const panel = getDataPanel('failed-deliveries');
    if (!panel) return undefined;
    return panel.find(deliveryId, 'delivery_id');
}

async function openFailedDelivery(deliveryId) {
    const d = findFailedDelivery(deliveryId);
    if (!d) return;

    let attempts;
    try {
        attempts = await apiGetDeliveryAttempts(deliveryId);
    } catch (error) {
        if (error.handled) notifyError(error.message);
        else notifyOffline();
        return;
    }

    const grid = '<div class="detail-grid">' +
        detailField('Delivery ID', deliveryCode(d.delivery_id)) +
        detailField('Customer', escapeHtml(d.customer_name)) +
        detailField('Phone', d.customer_phone ? escapeHtml(d.customer_phone) : '<span class="muted">Not set</span>') +
        detailField('Destination', escapeHtml(d.delivery_address)) +
        detailField('Failed On', escapeHtml(String(d.failed_on || '').slice(0, 16))) +
        detailField('Reason', escapeHtml(d.remarks || '')) +
        detailField('Attempts', String(Number(d.attempt_count))) +
        detailField('Driver', escapeHtml(d.driver_name)) +
        '</div>';

    const rows = [];
    for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        rows.push([
            String(a.attempt_no),
            escapeHtml(String(a.attempted_at).slice(0, 16)),
            escapeHtml(a.driver_name),
            escapeHtml(a.outcome),
            a.reason ? escapeHtml(a.reason) : '<span class="muted">None</span>'
        ]);
    }

    const pages = [
        { label: 'Delivery', body: grid },
        { label: 'Attempts', body: detailTable(['Attempt', 'Date', 'Driver', 'Outcome', 'Reason'], rows, [0]) }
    ];

    const footActions = '<button type="button" class="btn btn-accent" ' +
        'onclick="openRescheduleForm(' + d.delivery_id + ')">Reschedule</button>';

    openDetailModal('Delivery ' + deliveryCode(d.delivery_id), d.customer_name + ' · Failed', deliveryCode(d.delivery_id),
        pages, footActions);
}

function buildRescheduleModal() {
    if (document.getElementById('reschedule-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'reschedule-modal';
    modal.setAttribute('data-modal-locked', '');
    modal.setAttribute('data-modal-scroll', '');
    modal.innerHTML =
        '<div class="modal-box">' +
            '<div class="modal-head">' +
                '<div class="modal-identity">' +
                    '<div class="avatar">RS</div>' +
                    '<div>' +
                        '<h3>Reschedule</h3>' +
                        '<span class="modal-role" id="reschedule-subtitle">Delivery</span>' +
                    '</div>' +
                '</div>' +
                '<button type="button" class="modal-close" onclick="requestCloseModal(\'reschedule-modal\')" ' +
                    'aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
                '<form id="reschedule-form" onsubmit="handleReschedule(event)" autocomplete="off">' +
                    '<div class="form-group">' +
                        '<label for="reschedule-date">New date</label>' +
                        '<input type="datetime-local" id="reschedule-date" class="form-control" required>' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="reschedule-driver">Driver</label>' +
                        '<select id="reschedule-driver" class="form-control"></select>' +
                    '</div>' +
                '</form>' +
            '</div>' +
            '<div class="modal-foot">' +
                '<button type="button" class="btn btn-ghost" onclick="requestCloseModal(\'reschedule-modal\')">Cancel</button>' +
                '<button type="submit" class="btn btn-accent" id="reschedule-save" form="reschedule-form">Reschedule</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(modal);
}

// Now, as the text a datetime-local box uses: 2026-10-28T09:30
function nowForDateBox() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day + 'T' + hour + ':' + minute;
}

let rescheduleDeliveryId = null;

async function openRescheduleForm(deliveryId) {
    const d = findFailedDelivery(deliveryId);
    if (!d) return;

    let drivers;
    try {
        drivers = await apiGetDeliveryDrivers();
    } catch (error) {
        notifyOffline();
        return;
    }

    rescheduleDeliveryId = deliveryId;
    closeModal('detail-modal');

    document.getElementById('reschedule-subtitle').textContent = 'Delivery ' + deliveryCode(deliveryId) + ' · ' + d.customer_name;

    const dateBox = document.getElementById('reschedule-date');
    dateBox.min = nowForDateBox();
    dateBox.value = '';

    // The previous driver is picked first; Unassigned if there was none
    let optionsHtml = '<option value="">Unassigned</option>';
    for (let i = 0; i < drivers.length; i++) {
        optionsHtml += '<option value="' + drivers[i].staff_id + '">' + escapeHtml(drivers[i].full_name) + '</option>';
    }
    const driverBox = document.getElementById('reschedule-driver');
    driverBox.innerHTML = optionsHtml;
    driverBox.value = d.delivery_staff_id ? String(d.delivery_staff_id) : '';

    showModal('reschedule-modal');
    guardModal('reschedule-modal', 'this new date');
}

async function handleReschedule(event) {
    event.preventDefault();

    const date = document.getElementById('reschedule-date').value;
    if (!date) {
        notifyWarning('Pick the new date and time of the delivery.', 'The new date is required');
        return;
    }
    if (date < nowForDateBox()) {
        notifyWarning('The new date cannot be in the past.', 'Check the date');
        return;
    }

    const driverId = document.getElementById('reschedule-driver').value;

    const button = document.getElementById('reschedule-save');
    if (button && button.disabled) return;
    if (button) button.disabled = true;

    try {
        const response = await apiRescheduleDelivery(rescheduleDeliveryId, date, driverId ? Number(driverId) : null);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        closeModal('reschedule-modal');
        notifySuccess(result.message);

        const panel = getDataPanel('failed-deliveries');
        if (panel) await panel.refresh();
        if (typeof refreshDeliveryLists === 'function') await refreshDeliveryLists();
    } catch (error) {
        notifyOffline();
    } finally {
        if (button) button.disabled = false;
    }
}

// Build the panel on any page whose sidebar has the Failed Deliveries link
document.addEventListener('DOMContentLoaded', function () {
    if (document.querySelector('[data-panel-link="panel-failed-deliveries"]')) {
        buildFailedDeliveriesPanel();
    }
});
