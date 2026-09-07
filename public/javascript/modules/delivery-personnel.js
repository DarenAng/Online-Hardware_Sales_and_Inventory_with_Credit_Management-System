// delivery-personnel.js  --  DELIVERY PERSONNEL
// Loaded by: delivery.html
// ------------------------------------------------------------------------
// ==========================================
// DELIVERY PERSONNEL MODULE
// ==========================================
let driverDeliveries = [];

const DRIVER_STAGES = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed', 'Failed'];

function dateText(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
}

function todayText() { return dateText(new Date()); }

function monthStartText() {
    const now = new Date();
    return dateText(new Date(now.getFullYear(), now.getMonth(), 1));
}

function showDeliveryPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('del-page-title');
    if (heading) heading.textContent = title;

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// the default screen, and where the logo brings you back to
function showDeliveryHome(event) {
    showDeliveryPanel('panel-pending', 'Pending Deliveries', event);
    loadDriverDeliveries();
}
function showDeliveryActive(event) {
    showDeliveryPanel('panel-active', 'Out for Delivery', event);
    loadDriverDeliveries();
}
function showDeliveryCod(event) {
    showDeliveryPanel('panel-cod', 'Cash on Delivery', event);
    loadDriverDeliveries();
}
// The one screen here that waits to be asked: it is read rather than worked
// from, and it covers a date range somebody chooses rather than today's run.
function showDeliveryReports(event) {
    showDeliveryPanel('panel-report', 'Delivery Reports', event);
}

// ==========================================
// ONE FETCH FILLS THE DRIVER'S THREE LISTS
//
// This screen deliberately does not wait to be asked, unlike every other
// table in the system. A driver opening it at the start of a shift wants
// their run, and their run is one query scoped to them — not the whole
// delivery book. Making them press Load Data to see their own work would be
// ceremony rather than restraint.
//
// The three lists do page, because a busy day is longer than a screen. The
// reports screen, which is the heavy one and is read rather than worked
// from, is the one that waits.
// ==========================================
async function loadDriverDeliveries() {
    const user = getCurrentUser();
    if (!user || !document.getElementById('dpend-table')) return;

    tableMessage('dpend-table', 6, 'Loading deliveries...');
    tableMessage('dact-table', 6, 'Loading deliveries...');
    tableMessage('dcod-table', 6, 'Loading deliveries...');

    try {
        driverDeliveries = await getJson('/api/delivery/list?staffId=' + user.staff_id);
        renderDriverKpis();
        renderDriverLists();
        fillCodSelect();
    } catch (error) {
        setPill('dpend-count', 'Offline');
        tableMessage('dpend-table', 6, 'Cannot reach the server.');
        tableMessage('dact-table', 6, 'Cannot reach the server.');
        tableMessage('dcod-table', 6, 'Cannot reach the server.');
    }
}

function renderDriverKpis() {
    const grid = document.getElementById('del-kpis');
    if (!grid) return;

    const waiting = driverDeliveries.filter((d) => d.status === 'Pending' || d.status === 'In Transit').length;
    const onRoad = driverDeliveries.filter((d) => d.status === 'Out for Delivery').length;
    const done = driverDeliveries.filter((d) => d.status === 'Delivered').length;
    const problem = driverDeliveries.filter((d) => d.status === 'Delayed' || d.status === 'Failed').length;
    const codRows = driverDeliveries.filter((d) => Number(d.balance_due) > 0);
    const codDue = codRows.reduce((sum, d) => sum + Number(d.balance_due), 0);

    const cards = [
        ['Waiting', waiting, 'pending or in transit', waiting > 0 ? 'kpi-warn' : ''],
        ['On the Road', onRoad, 'out for delivery', ''],
        ['Delivered', done, 'closed out', ''],
        ['Problems', problem, 'delayed or failed', problem > 0 ? 'kpi-danger' : ''],
        ['COD to Collect', peso(codDue), codRows.length + ' unpaid orders', codDue > 0 ? 'kpi-warn' : '']
    ];

    grid.innerHTML = cards.map((c) =>
        '<div class="kpi-card ' + c[3] + '"><span class="kpi-label">' + c[0] + '</span>' +
        '<span class="kpi-value">' + escapeHtml(c[1]) + '</span>' +
        '<span class="kpi-note">' + escapeHtml(c[2]) + '</span></div>').join('');
}

// The driver's three lists, each a data panel over rows that are already in
// memory: one fetch fills all three, and each pages on its own.
function buildDriverPanels() {
    createDataPanel({
        key: 'driver-pending',
        tableId: 'dpend-table',
        columns: 6,
        pagerId: 'dpend-pager',
        countPillId: 'dpend-count',
        idField: 'delivery_id',
        gate: { title: 'Not loaded', text: 'Your run loads on its own.', button: 'Load' },

        load: () => driverDeliveries.filter((d) =>
            d.status === 'Pending' || d.status === 'In Transit' || d.status === 'Delayed'),

        match: (d, query) =>
            (d.customer_name + ' ' + d.delivery_address).toLowerCase().indexOf(query) !== -1,

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openDriverDetail(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-id">' + escapeHtml(d.scheduled_date || 'Not set') + '</td>' +
            '<td>' + statusBadge(d.status) + '</td>' +
            '<td class="cell-action" onclick="event.stopPropagation();">' +
            '<button type="button" class="btn btn-sm btn-accent" ' +
                'onclick="markDelivery(' + d.delivery_id + ', \'Out for Delivery\')">Out for Delivery</button>' +
            '</td></tr>'
    });

    createDataPanel({
        key: 'driver-active',
        tableId: 'dact-table',
        columns: 6,
        pagerId: 'dact-pager',
        countPillId: 'dact-count',
        idField: 'delivery_id',
        gate: { title: 'Not loaded', text: 'Your run loads on its own.', button: 'Load' },

        load: () => driverDeliveries.filter((d) => d.status === 'Out for Delivery'),

        match: (d, query) =>
            (d.customer_name + ' ' + d.delivery_address).toLowerCase().indexOf(query) !== -1,

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openDriverDetail(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-num' + (Number(d.balance_due) > 0 ? ' cell-due' : '') + '">' +
                peso(d.balance_due) + '</td>' +
            '<td>' + statusBadge(d.status) + '</td>' +
            '<td class="cell-action" onclick="event.stopPropagation();">' +
            // green, yellow, red: the three ways this delivery can end, in the
            // colours the rest of the system already uses for them
            '<button type="button" class="btn btn-sm btn-success" ' +
                'onclick="markDelivery(' + d.delivery_id + ', \'Delivered\')">Delivered</button> ' +
            '<button type="button" class="btn btn-sm btn-gold" ' +
                'onclick="markDelivery(' + d.delivery_id + ', \'Delayed\')">Delayed</button> ' +
            '<button type="button" class="btn btn-sm btn-danger" ' +
                'onclick="markDelivery(' + d.delivery_id + ', \'Failed\')">Failed</button>' +
            '</td></tr>'
    });

    createDataPanel({
        key: 'driver-cod',
        tableId: 'dcod-table',
        columns: 6,
        pagerId: 'dcod-pager',
        idField: 'delivery_id',
        gate: { title: 'Not loaded', text: 'Your run loads on its own.', button: 'Load' },

        load: () => driverDeliveries.filter((d) => Number(d.balance_due) > 0),

        match: (d, query) => d.customer_name.toLowerCase().indexOf(query) !== -1,

        onLoaded: (rows) => {
            const total = rows.reduce((sum, d) => sum + Number(d.balance_due), 0);
            setPill('dcod-count', peso(total) + ' to collect');
        },

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openDriverDetail(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.payment_method) + '</td>' +
            '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
            '<td class="cell-num cell-due">' + peso(d.balance_due) + '</td>' +
            '<td>' + statusBadge(d.status) + '</td></tr>'
    });
}

// one fetch has landed; all three lists redraw from it
function renderDriverLists() {
    for (const key of ['driver-pending', 'driver-active', 'driver-cod']) {
        const panel = getDataPanel(key);
        if (panel) panel.open();
    }
}

function fillCodSelect() {
    const select = document.getElementById('dcod-select');
    if (!select) return;

    const due = driverDeliveries.filter((d) => Number(d.balance_due) > 0);
    select.innerHTML = due.length === 0
        ? '<option value="">Nothing left to collect</option>'
        : due.map((d) => '<option value="' + d.delivery_id + '" data-balance="' + d.balance_due + '">' +
            'Delivery #' + d.delivery_id + ' &middot; ' + escapeHtml(d.customer_name) +
            ' &middot; ' + peso(d.balance_due) + '</option>').join('');

    onCodChange();
}

// picking a delivery fills in the exact balance
function onCodChange() {
    const select = document.getElementById('dcod-select');
    const form = document.getElementById('dcod-form');
    if (!select || !form) return;

    const option = select.options[select.selectedIndex];
    form.elements.amount.value = option && option.dataset.balance ? option.dataset.balance : '';
}

async function markDelivery(deliveryId, status) {
    const yes = await askConfirm(
        status === 'Delivered'
            ? 'Delivery #' + deliveryId + ' is closed out as delivered, with the time recorded now. ' +
              'A closed delivery cannot be reopened.'
            : 'Delivery #' + deliveryId + ' is marked ' + status + '.',
        {
            title: 'Mark as ' + status + '?',
            eyebrow: 'Delivery Runs',
            confirmLabel: 'Mark ' + status,
            tone: status === 'Failed' ? 'danger' : 'accent'
        });

    if (!yes) return;
    await sendDeliveryStatus(deliveryId, status, null);
}

// ---------- cash on delivery ----------
async function handleCodPayment(event) {
    event.preventDefault();
    const form = event.target;

    const deliveryId = parseInt(form.elements.deliveryId.value, 10);
    const amount = parseFloat(form.elements.amount.value);

    if (!deliveryId) {
        notifyWarning('Choose which delivery this money is for.', 'Nothing recorded');
        return;
    }
    if (!amount || amount <= 0) {
        notifyWarning('A payment has to be greater than zero.', 'Nothing recorded');
        return;
    }

    try {
        const response = await fetch('/api/delivery/' + deliveryId + '/payment', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                amount: amount,
                paymentMethod: form.elements.paymentMethod.value,
                referenceNo: form.elements.referenceNo.value.trim() || null
            })
        });
        const result = await response.json();

        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        form.elements.referenceNo.value = '';
        await loadDriverDeliveries();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- popup ----------
function openDriverDetail(deliveryId) {
    showDeliveryRecord(driverDeliveries.find((x) => x.delivery_id === deliveryId), true);
}

// ---------- reports ----------
async function loadDeliveryReport() {
    const user = getCurrentUser();
    const grid = document.getElementById('drep-kpis');
    if (!user || !grid) return;

    const fromBox = document.getElementById('drep-from');
    const toBox = document.getElementById('drep-to');

    if (fromBox && !fromBox.value) fromBox.value = monthStartText();
    if (toBox && !toBox.value) toBox.value = todayText();

    grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Loading</span><span class="kpi-value">...</span></div>';
    tableMessage('drep-table', 7, 'Loading report...');
    tableMessage('drep-pay-table', 6, 'Loading payments...');

    try {
        const data = await getJson('/api/delivery/summary?staffId=' + user.staff_id +
            '&from=' + fromBox.value + '&to=' + toBox.value);

        const rows = data.deliveries;
        const collected = data.payments.reduce((sum, p) => sum + Number(p.amount), 0);
        const delivered = rows.filter((d) => d.status === 'Delivered').length;
        const problem = rows.filter((d) => d.status === 'Delayed' || d.status === 'Failed').length;

        const cards = [
            ['Deliveries', rows.length, 'in the chosen range', ''],
            ['Delivered', delivered, 'closed out', ''],
            ['Problems', problem, 'delayed or failed', problem > 0 ? 'kpi-danger' : ''],
            ['Collected', peso(collected), data.payments.length + ' payments taken', ''],
            ['Still to Collect', peso(data.codDue), data.codCount + ' unpaid orders',
             Number(data.codDue) > 0 ? 'kpi-warn' : '']
        ];

        grid.innerHTML = cards.map((c) =>
            '<div class="kpi-card ' + c[3] + '"><span class="kpi-label">' + c[0] + '</span>' +
            '<span class="kpi-value">' + escapeHtml(c[1]) + '</span>' +
            '<span class="kpi-note">' + escapeHtml(c[2]) + '</span></div>').join('');

        const legend = document.getElementById('drep-legend');
        if (legend) {
            legend.innerHTML = DRIVER_STAGES.map((stage) => {
                const count = rows.filter((d) => d.status === stage).length;
                return '<span class="track-chip"><span class="track-count">' + count + '</span>' + stage + '</span>';
            }).join('');
        }

        setPill('drep-count', rows.length + (rows.length === 1 ? ' delivery' : ' deliveries'));
        document.querySelector('#drep-table tbody').innerHTML = rows.length === 0
            ? '<tr><td colspan="7" class="table-empty">No delivery falls inside this range.</td></tr>'
            : rows.map((d, i) =>
                '<tr class="row-reveal" style="animation-delay:' + Math.min(i, 12) * 28 + 'ms">' +
                '<td class="cell-id">#' + d.delivery_id + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(d.delivered_at || d.scheduled_date || '').slice(0, 10) || 'Not set') + '</td>' +
                '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
                '<td>' + escapeHtml(d.delivery_address) + '</td>' +
                '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
                '<td class="cell-num' + (Number(d.balance_due) > 0 ? ' cell-due' : '') + '">' + peso(d.balance_due) + '</td>' +
                '<td>' + statusBadge(d.status) + '</td></tr>').join('');

        setPill('drep-pay-count', peso(collected) + ' collected');
        document.querySelector('#drep-pay-table tbody').innerHTML = data.payments.length === 0
            ? '<tr><td colspan="6" class="table-empty">You collected nothing in this range.</td></tr>'
            : data.payments.map((p) =>
                '<tr><td class="cell-id">' + escapeHtml(String(p.payment_date).slice(0, 16)) + '</td>' +
                '<td class="cell-id">#' + p.sale_id + '</td>' +
                '<td class="cell-name">' + escapeHtml(p.customer_name) + '</td>' +
                '<td>' + escapeHtml(p.payment_method) + '</td>' +
                '<td>' + (p.reference_no ? escapeHtml(p.reference_no) : '<span class="muted">None</span>') + '</td>' +
                '<td class="cell-num">' + peso(p.amount) + '</td></tr>').join('');
    } catch (error) {
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Offline</span><span class="kpi-value">--</span><span class="kpi-note">Cannot reach the server</span></div>';
        tableMessage('drep-table', 7, 'Cannot reach the server.');
        tableMessage('drep-pay-table', 6, 'Cannot reach the server.');
    }
}

// ==========================================
// DELIVERY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('delivery.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildDriverPanels();
        showDeliveryHome();
        loadNotifications();
    });
}
