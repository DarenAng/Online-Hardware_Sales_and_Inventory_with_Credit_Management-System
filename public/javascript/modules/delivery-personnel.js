// delivery-personnel.js -- delivery personnel
// Loaded by: delivery.html
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

// the default screen; Load Data on any of the three lists fills all three
function showDeliveryHome(event) {
    showDeliveryPanel('panel-pending', 'Pending Deliveries', event);
    if (event) toggleRunsMenu(null, true);
}
function showDeliveryActive(event) {
    showDeliveryPanel('panel-active', 'Out for Delivery', event);
    if (event) toggleRunsMenu(null, true);
}
function showDeliveryCod(event) {
    showDeliveryPanel('panel-cod', 'Cash on Delivery', event);
    if (event) toggleRunsMenu(null, true);
}

// Delivery Runs folds under its heading via shared/helpers.js's toggleSidebarMenu
function toggleRunsMenu(event, force) { toggleSidebarMenu('runs-nav', 'run-dropdown', event, force); }
function showDeliveryReports(event) {
    showDeliveryPanel('panel-report', 'Delivery Reports', event);
}

// One query scoped to the driver; the three lists are three views of it,
// read when the driver asks and re-read after a change.
async function fetchDriverDeliveries() {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    driverDeliveries = await getJson('/api/delivery/list?staffId=' + user.staff_id);
    renderDriverKpis();
    fillCodSelect();
    return driverDeliveries;
}

// one panel's load() fetches; sibling panels redraw from the same rows
const DRIVER_LISTS = ['driver-pending', 'driver-active', 'driver-cod'];

async function driverRows(key, pick) {
    const panel = getDataPanel(key);

    if (panel && panel.fromRun) {
        panel.fromRun = false;
    } else {
        await fetchDriverDeliveries();

        for (const other of DRIVER_LISTS) {
            const sibling = getDataPanel(other);
            if (!sibling || other === key || sibling.state !== 'ready') continue;
            sibling.fromRun = true;
            sibling.open();
        }
    }

    return driverDeliveries.filter(pick);
}

// Re-reads the run for whichever lists are open.
async function loadDriverDeliveries() {
    if (!document.getElementById('dpend-table')) return;

    try {
        await fetchDriverDeliveries();
        for (const key of DRIVER_LISTS) {
            const panel = getDataPanel(key);
            if (!panel) continue;

            const table = document.getElementById(panel.config.tableId);
            const screen = table ? table.closest('[data-panel]') : null;
            const onScreen = screen && screen.style.display !== 'none';

            if (panel.state === 'ready') {
                panel.fromRun = true;
                await panel.refresh();
            } else if (onScreen) {
                panel.fromRun = true;
                await panel.open();
            }
        }
    } catch (error) {
        setPill('dpend-count', 'Offline');
        notifyOffline();
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

function buildDriverPanels() {
    createDataPanel({
        key: 'driver-pending',
        tableId: 'dpend-table',
        columns: 6,
        pagerId: 'dpend-pager',
        countPillId: 'dpend-count',
        idField: 'delivery_id',
        gate: { title: 'Your run is not loaded',
                text: 'Press Load Data to read the deliveries waiting on you, or type a customer and press Enter.',
                button: 'Load Data' },

        load: () => driverRows('driver-pending', (d) =>
            d.status === 'Pending' || d.status === 'In Transit' || d.status === 'Delayed'),

        match: (d, query) => prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query),

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
        gate: { title: 'Your run is not loaded',
                text: 'Press Load Data to read what is out on the road with you, or type a customer and press Enter.',
                button: 'Load Data' },

        load: () => driverRows('driver-active', (d) => d.status === 'Out for Delivery'),

        match: (d, query) => prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query),

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
        gate: { title: 'Your run is not loaded',
                text: 'Press Load Data to read the orders you still have to collect on, or type a customer and press Enter.',
                button: 'Load Data' },

        load: () => driverRows('driver-cod', (d) => Number(d.balance_due) > 0),

        match: (d, query) => prefixMatch([d.customer_name, '#' + d.delivery_id], query),

        // the pill carries the money rather than the row count
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

// The report: one fetch for the range, two data panels reading from it.
let driverReport = null;
const DRIVER_REPORT_PANELS = ['driver-report', 'driver-report-pay'];

function reportRange() {
    const fromBox = document.getElementById('drep-from');
    const toBox = document.getElementById('drep-to');

    if (fromBox && !fromBox.value) fromBox.value = monthStartText();
    if (toBox && !toBox.value) toBox.value = todayText();

    return { from: fromBox ? fromBox.value : '', to: toBox ? toBox.value : '' };
}

function renderReportFigures(data) {
    const grid = document.getElementById('drep-kpis');
    if (!grid) return;

    if (!data) {
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Offline</span>' +
            '<span class="kpi-value">--</span><span class="kpi-note">Cannot reach the server</span></div>';
        return;
    }

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
}

// one panel's load() fetches the report; the other reads what arrived
async function reportRows(key, pick) {
    const panel = getDataPanel(key);

    if (panel && panel.fromReport) {
        panel.fromReport = false;
    } else {
        await fetchDeliveryReport();

        for (const other of DRIVER_REPORT_PANELS) {
            const sibling = getDataPanel(other);
            if (!sibling || other === key || sibling.state !== 'ready') continue;
            sibling.fromReport = true;
            sibling.open();
        }
    }

    return pick(driverReport);
}

async function fetchDeliveryReport() {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    const range = reportRange();
    const grid = document.getElementById('drep-kpis');
    if (grid) {
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Loading</span>' +
            '<span class="kpi-value">&hellip;</span></div>';
    }

    try {
        driverReport = await getJson('/api/delivery/summary?staffId=' + user.staff_id +
            '&from=' + range.from + '&to=' + range.to);
    } catch (error) {
        driverReport = null;
        renderReportFigures(null);
        throw error;
    }

    renderReportFigures(driverReport);
    return driverReport;
}

function buildReportPanels() {
    createDataPanel({
        key: 'driver-report',
        tableId: 'drep-table',
        columns: 7,
        pagerId: 'drep-pager',
        countPillId: 'drep-count',
        idField: 'delivery_id',
        gate: { title: 'The report is not loaded',
                text: 'Pick the dates above and press Load Report. Nothing is read until you do.',
                button: 'Load Data' },

        load: () => reportRows('driver-report', (data) => data.deliveries),

        renderRow: (d, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(d.delivered_at || d.scheduled_date || '').slice(0, 10) || 'Not set') + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
            '<td class="cell-num' + (Number(d.balance_due) > 0 ? ' cell-due' : '') + '">' + peso(d.balance_due) + '</td>' +
            '<td>' + statusBadge(d.status) + '</td></tr>'
    });

    createDataPanel({
        key: 'driver-report-pay',
        tableId: 'drep-pay-table',
        columns: 6,
        pagerId: 'drep-pay-pager',
        idField: 'payment_id',
        gate: { title: 'The report is not loaded',
                text: 'Pick the dates above and press Load Report. Nothing is read until you do.',
                button: 'Load Data' },

        load: () => reportRows('driver-report-pay', (data) => data.payments),

        onLoaded: (rows) => {
            const collected = rows.reduce((sum, p) => sum + Number(p.amount), 0);
            setPill('drep-pay-count', peso(collected) + ' collected');
        },

        renderRow: (p, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">' + escapeHtml(String(p.payment_date).slice(0, 16)) + '</td>' +
            '<td class="cell-id">#' + p.sale_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.customer_name) + '</td>' +
            '<td>' + escapeHtml(p.payment_method) + '</td>' +
            '<td>' + (p.reference_no ? escapeHtml(p.reference_no) : '<span class="muted">None</span>') + '</td>' +
            '<td class="cell-num">' + peso(p.amount) + '</td></tr>'
    });
}

async function loadDeliveryReport() {
    const first = getDataPanel('driver-report');
    if (!first) return;

    // a fresh read: the dates may have changed
    await first.open();

    const second = getDataPanel('driver-report-pay');
    if (second && driverReport) {
        second.fromReport = true;
        await second.open();
    }
}

// ==========================================
// DELIVERY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('delivery.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildDriverPanels();
        buildReportPanels();

        // offered only to a driver holding a key to a connected system
        configureConnectedSystems({ showPanel: (panelId, title) => showDeliveryPanel(panelId, title) });
        buildConnectedSystemsPanel();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showDeliveryPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showDeliveryHome() });

        showDeliveryHome();
        loadNotifications();
    });
}
