// ============================================================
// delivery-personnel.js -- the Delivery Personnel (driver) dashboard
// Loaded by: delivery.html
//
// What is in this file, from top to bottom:
//   - small date helpers (today, first day of the month)
//   - switching screens (showDeliveryPanel and the show... functions)
//   - the driver's deliveries: the numbers at the top and the lists
//   - taking a delivery (the status buttons live in the popup, shared/deliveries.js)
//   - collecting cash on delivery (COD)
//   - the driver's report for a date range
//   - the page start-up code at the very bottom ("DELIVERY PAGE BOOT")
// ============================================================
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

    leaveScreenFurniture();
}

// the default screen; Load Data on either list fills both.
// Neither unfolds the Delivery Runs list: only the heading's caret does
// (shared/helpers.js sidebarHeading).
function showDeliveryHome(event)   { showDeliveryPanel('panel-pending', 'Pending Deliveries', event); }
function showDeliveryCod(event)    { showDeliveryPanel('panel-cod', 'Cash on Delivery', event); }
function showDeliveryReports(event) {
    showDeliveryPanel('panel-report', 'Delivery Reports', event);
}

// the tab bar on Reports: one table at a time, both filled by the same load
function showDriverReportView(viewId) {
    const panel = document.getElementById('panel-report');
    if (!panel) return;

    panel.querySelectorAll(':scope > .panel-view').forEach((view) => {
        view.hidden = view.id !== viewId;
    });
    panel.querySelectorAll('[data-view-tab]').forEach((tab) => {
        const current = tab.dataset.viewTab === viewId;
        tab.classList.toggle('is-current', current);
        tab.setAttribute('aria-selected', current ? 'true' : 'false');
    });
}

// One query scoped to the driver; the three lists are three views of it,
// read when the driver asks and re-read after a change.
async function fetchDriverDeliveries() {
    const user = getCurrentUser();
    if (!user) throw new Error('not signed in');

    driverDeliveries = await apiGetMyDeliveries(user.staff_id);
    releaseStaleFocus();
    fillCodSelect();
    return driverDeliveries;
}

// one panel's load() fetches; sibling panels redraw from the same rows
const DRIVER_LISTS = ['driver-pending', 'driver-cod'];

// Load Data on either list reads the run once and fills both, so a delivery
// the driver has taken is already waiting under Cash on Delivery.
async function driverRows(key, pick) {
    const panel = getDataPanel(key);

    if (panel && panel.fromRun) {
        panel.fromRun = false;
    } else {
        await fetchDriverDeliveries();

        for (const other of DRIVER_LISTS) {
            const sibling = getDataPanel(other);
            if (!sibling || other === key) continue;
            sibling.fromRun = true;
            sibling.open();
        }
    }

    return driverDeliveries.filter(pick);
}

// Re-reads the run after a change (taking a delivery, moving it, a payment)
// and redraws all three lists from it.
async function loadDriverDeliveries() {
    if (!document.getElementById('dpend-table')) return;

    try {
        await fetchDriverDeliveries();
        for (const key of DRIVER_LISTS) {
            const panel = getDataPanel(key);
            if (!panel) continue;

            panel.fromRun = true;
            if (panel.state === 'ready') {
                await panel.refresh();
            } else {
                await panel.open();
            }
        }
    } catch (error) {
        setPill('dpend-count', 'Offline');
        notifyOffline();
    }
}

function isMine(d) {
    const user = getCurrentUser();
    return !!user && d.delivery_staff_id != null && Number(d.delivery_staff_id) === Number(user.staff_id);
}

function isWaiting(d) {
    return d.status === 'Pending' || d.status === 'In Transit' || d.status === 'Delayed';
}

// The delivery the driver clicked into; while set, the Pending list shows it
// alone. Kept for the tab so a reload stays on the same job.
const FOCUS_KEY = 'driver-focus-delivery';
let focusedDeliveryId = null;
try { focusedDeliveryId = Number(sessionStorage.getItem(FOCUS_KEY)) || null; } catch (error) { /* no storage */ }

function setDeliveryFocus(deliveryId) {
    focusedDeliveryId = deliveryId;
    try {
        if (deliveryId) sessionStorage.setItem(FOCUS_KEY, String(deliveryId));
        else sessionStorage.removeItem(FOCUS_KEY);
    } catch (error) { /* no storage */ }
}

// the focus lets go once the delivery leaves the Pending list (sent out, closed, archived)
function releaseStaleFocus() {
    if (!focusedDeliveryId) return;
    const d = driverDeliveries.find((x) => x.delivery_id === focusedDeliveryId);
    if (!d || !isMine(d) || !isWaiting(d)) setDeliveryFocus(null);
}

async function clearDeliveryFocus() {
    setDeliveryFocus(null);
    const panel = getDataPanel('driver-pending');
    if (panel && panel.state === 'ready') {
        panel.fromRun = true;
        await panel.refresh();
    }
}

// Every waiting delivery that is the driver's own or nobody's yet, so a new
// booking shows up at once; narrowed to one while the driver is on it.
function pendingForDriver(d) {
    if (!isWaiting(d)) return false;
    if (focusedDeliveryId) return d.delivery_id === focusedDeliveryId;
    return isMine(d) || d.delivery_staff_id == null;
}

// The Pending list mixes the driver's own deliveries with ones nobody has
// taken yet; this says which is which on the row itself.
function ownerTag(d) {
    if (isMine(d)) return '<span class="badge badge-neutral owner-tag is-mine">Yours</span>';
    return '<span class="badge badge-neutral owner-tag">Unassigned</span>';
}

// Clicking a delivery nobody has taken claims it for this driver first.
async function openPendingDelivery(deliveryId) {
    const d = driverDeliveries.find((x) => x.delivery_id === deliveryId);
    if (!d) return;

    if (!isMine(d)) {
        const yes = await askConfirm(
            'Delivery #' + deliveryId + ' to ' + d.customer_name + ' will be assigned to you, ' +
            'and your list shows this delivery only until you send it out.',
            { title: 'Take this delivery?', eyebrow: 'Delivery Runs', confirmLabel: 'Take Delivery', tone: 'accent' });
        if (!yes) return;

        try {
            const response = await apiClaimDelivery(deliveryId);
            const result = await response.json();

            if (!response.ok) {
                if (!handleAuthFailure(response, result)) notifyError(result.error);
                await loadDriverDeliveries();
                return;
            }

            notifySuccess(result.message);
        } catch (error) {
            notifyOffline();
            return;
        }
    }

    setDeliveryFocus(deliveryId);
    await loadDriverDeliveries();
    openDriverDetail(deliveryId);
}

function buildDriverPanels() {
    createDataPanel({
        key: 'driver-pending',
        tableId: 'dpend-table',
        columns: 5,
        pagerId: 'dpend-pager',
        idField: 'delivery_id',
        gate: { title: 'Your run is not loaded',
                text: 'Press Load Data to read the deliveries waiting on you, or type a customer.',
                button: 'Load Data' },

        load: () => driverRows('driver-pending', pendingForDriver),

        match: (d, query) => prefixMatch([d.customer_name, d.delivery_address, '#' + d.delivery_id], query),

        onLoaded: () => {
            const heading = document.getElementById('dpend-heading');
            if (heading) heading.textContent = focusedDeliveryId ? 'Your Delivery' : 'Waiting to Go Out';
            const showAll = document.getElementById('dpend-show-all');
            if (showAll) showAll.hidden = !focusedDeliveryId;
        },

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openPendingDelivery(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.delivery_address) + '</td>' +
            '<td class="cell-id">' + escapeHtml(d.scheduled_date || 'Not set') + '</td>' +
            '<td>' + statusBadge(d.status) + ' ' + ownerTag(d) + '</td></tr>'
    });

    // Everything the driver has taken: what is still on the road, whatever its
    // status, and anything delivered that still has money owed at the door.
    createDataPanel({
        key: 'driver-cod',
        tableId: 'dcod-table',
        columns: 6,
        pagerId: 'dcod-pager',
        idField: 'delivery_id',
        gate: { title: 'Your run is not loaded',
                text: 'Press Load Data to read the deliveries you have taken, or type a customer.',
                button: 'Load Data' },

        load: () => driverRows('driver-cod', (d) =>
            isMine(d) && ((d.status !== 'Delivered' && d.status !== 'Failed') || Number(d.balance_due) > 0)),

        match: (d, query) => prefixMatch([d.customer_name, '#' + d.delivery_id], query),

        // the pill carries the money rather than the row count
        onLoaded: (rows) => {
            const total = sumOf(rows.filter((d) => Number(d.balance_due) > 0), 'balance_due');
            setPill('dcod-count', peso(total) + ' to collect');
        },

        renderRow: (d, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openDriverDetail(' + d.delivery_id + ')">' +
            '<td class="cell-id">#' + d.delivery_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
            '<td>' + escapeHtml(d.payment_method) + '</td>' +
            '<td class="cell-num">' + peso(d.final_amount) + '</td>' +
            '<td class="cell-num' + (Number(d.balance_due) > 0 ? ' cell-due' : '') + '">' +
                peso(Math.max(Number(d.balance_due) || 0, 0)) + '</td>' +
            '<td>' + statusBadge(d.status) + '</td></tr>'
    });
}

function fillCodSelect() {
    const select = document.getElementById('dcod-select');
    if (!select) return;

    const due = driverDeliveries.filter((d) => isMine(d) && Number(d.balance_due) > 0);

    if (due.length === 0) {
        select.innerHTML = '<option value="">Nothing left to collect</option>';
    } else {
        select.innerHTML = due.map((d) => '<option value="' + d.delivery_id + '" data-balance="' + d.balance_due + '">' +
                'Delivery #' + d.delivery_id + ' &middot; ' + escapeHtml(d.customer_name) +
                ' &middot; ' + peso(d.balance_due) + '</option>').join('');
    }

    onCodChange();
}

function onCodChange() {
    const select = document.getElementById('dcod-select');
    const form = document.getElementById('dcod-form');
    if (!select || !form) return;

    const option = select.options[select.selectedIndex];
    form.elements.amount.value = option && option.dataset.balance ? option.dataset.balance : '';
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
        const response = await apiCollectPayment(deliveryId, {
                amount: amount,
                paymentMethod: form.elements.paymentMethod.value,
                referenceNo: form.elements.referenceNo.value.trim() || null
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

function renderReportLegend(data) {
    const legend = document.getElementById('drep-legend');
    if (!legend) return;

    if (!data) {
        legend.innerHTML = '';
        return;
    }

    legend.innerHTML = DRIVER_STAGES.map((stage) => {
        const count = data.deliveries.filter((d) => d.status === stage).length;
        return '<span class="track-chip"><span class="track-count">' + count + '</span>' + stage + '</span>';
    }).join('');
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

    try {
        driverReport = await apiGetDeliveryReport(user.staff_id, range.from, range.to);
    } catch (error) {
        driverReport = null;
        renderReportLegend(null);
        throw error;
    }

    renderReportLegend(driverReport);
    return driverReport;
}

function buildReportPanels() {
    createDataPanel({
        key: 'driver-report',
        tableId: 'drep-table',
        columns: 7,
        pagerId: 'drep-pager',
        idField: 'delivery_id',
        gate: { title: 'The report is not loaded',
                text: 'Pick the dates above, or press Load Data for this month so far.',
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
                text: 'Pick the dates above, or press Load Data for this month so far.',
                button: 'Load Data' },

        load: () => reportRows('driver-report-pay', (data) => data.payments),

        onLoaded: (rows) => {
            const collected = sumOf(rows, 'amount');
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

// the report reloads once both dates are in; one alone waits for the other
function deliveryDatesPicked() {
    const from = document.getElementById('drep-from');
    const to = document.getElementById('drep-to');
    if (!from || !to || !from.value || !to.value) return;

    if (from.value > to.value) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    loadDeliveryReport();
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

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showDeliveryPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showDeliveryHome() });

        // Go to, on an opened alert: a new delivery is on the pending list
        configureNotificationTargets({
            'Delivery': { label: 'Pending Deliveries', panelId: 'panel-pending',
                          open: () => showDeliveryHome(), key: 'driver-pending' }
        });

        showDeliveryHome();
        loadNotifications();
    });
}
