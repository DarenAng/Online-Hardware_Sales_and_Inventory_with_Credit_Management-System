// ============================================================
// manager.js -- the Manager dashboard
// Loaded by: manager.html
//
// What is in this file, from top to bottom:
//   - switching screens (showManagerPanel and the show... functions), and the
//     views inside Reports and Stocks, each opened from its own menu entry
//     (showPanelView)
//   - the Sales Summary: the period, the figures, the two tables
//   - saving tables as Excel workbooks, and printing them
//   - reports, stocks, stock movements, the selling price and the reorder policy
//   - credit: customer limits and extension requests
//   - deliveries, records (suppliers, customers, products...), archives
//   - the popups that show one sale, delivery, customer, ... in full
//   - the page start-up code at the very bottom ("MANAGER PAGE BOOT")
// ============================================================

let recordType = 'supplier';
let incomeRange = { name: 'monthly', from: null, to: null };
let incomeData = null;
let policyProduct = null;

// the view showing on each tabbed screen; opening the screen again goes back to it
let reportView = 'report-summary';
let stockView = 'stock-overview';

// eight rows keeps a report card above the fold on a 1366x768 laptop, so the
// Reports screen never scrolls; the pager turns the rest
const REPORT_ROWS_PER_PAGE = 8;

// ==========================================
// PANEL SWITCHING
// ==========================================
// Opening a screen never unfolds a list in the menu: only pressing its
// heading does (shared/helpers.js sidebarHeading). The heading over a folded
// list lights up on its own when a screen beneath it is the open one.
function showManagerPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });

    markPanelLinks(panelId);

    const heading = document.getElementById('manager-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// A link that names a view inside a screen (an income table) is marked only
// when the screen is showing that view. A panel with data-panel-of (an
// order's document, Total Purchases) marks the screen it belongs to.
function markPanelLinks(panelId) {
    const panel = document.getElementById(panelId);
    const view = panel ? panel.dataset.view : undefined;
    const owner = (panel && panel.getAttribute('data-panel-of')) || panelId;

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        const wanted = link.dataset.panelView;
        link.classList.toggle('active',
            link.dataset.panelLink === owner && (!wanted || wanted === view));
    });
}

// ==========================================
// TABBED SCREENS -- Reports and Stocks
// ==========================================
// Each view (.panel-view) of these screens has its own entry in the menu.
// The screen keeps a tab bar that is never drawn: its tabs carry the
// data-feature marks shared/features.js hides, and a view whose tab is
// hidden is never shown.
function viewOffered(panel, viewId) {
    const tab = panel.querySelector('[data-view-tab="' + viewId + '"]');
    return Boolean(tab) && !tab.hidden;
}

// shows viewId, or the first view still offered; returns the one shown
function showPanelView(panelId, viewId, title, event) {
    const panel = document.getElementById(panelId);
    if (!panel) return null;

    const views = Array.from(panel.querySelectorAll(':scope > .panel-view'));
    const view = views.find((each) => each.id === viewId && viewOffered(panel, each.id)) ||
                 views.find((each) => viewOffered(panel, each.id)) ||
                 views[0];
    if (!view) return null;

    views.forEach((each) => { each.hidden = each !== view; });
    panel.dataset.view = view.id;

    panel.querySelectorAll('[data-view-tab]').forEach((tab) => {
        const current = tab.dataset.viewTab === view.id;
        tab.classList.toggle('is-current', current);
        tab.setAttribute('aria-selected', current ? 'true' : 'false');
    });

    showManagerPanel(panelId, title, event);
    return view.id;
}

// After the role's switches are applied: a group with no tabs left goes, and a
// screen showing a view that was just switched off moves to one still offered.
function syncViewNavs() {
    document.querySelectorAll('.tabbed-panel').forEach((panel) => {
        panel.querySelectorAll('.view-nav-group').forEach((group) => {
            const tabs = Array.from(group.querySelectorAll('[data-view-tab]'));
            group.hidden = tabs.length > 0 && tabs.every((tab) => tab.hidden);
        });

        const current = panel.dataset.view;
        if (current && !viewOffered(panel, current) && panel.style.display !== 'none') {
            if (panel.id === 'panel-reports') showReport(current);
            else if (panel.id === 'panel-stocks') showStockView(current);
        }
    });
}

// Reports is the first screen. The page opens on the Sales Summary; the menu
// entry and the brand corner go back to whichever report was last open.
function showReports(event) { showReport(reportView, event); }

function showReport(reportId, event) {
    const shown = showPanelView('panel-reports', reportId, 'Reports', event);
    if (shown) reportView = shown;
}

// Stocks: the whole inventory, the reorder alerts and the stock movements
function showStocks(event) { showStockView(stockView, event); }

function showStockView(viewId, event) {
    const shown = showPanelView('panel-stocks', viewId, 'Stocks', event);
    if (shown) stockView = shown;
}

function showIncome(event)        { showReport('report-summary', event); }
function showSales(event)         { showReport('report-sales', event); }
function showReorderAlerts(event) { showStockView('stock-reorder', event); }
function showStockReport(event)   { showStockView('stock-overview', event); }
function showDeliveries(event)    { showManagerPanel('panel-deliveries', 'Deliveries', event); }
function showCredit(event)         { showManagerPanel('panel-credit', 'Customer Credit', event); }
function showCreditRequests(event) { showManagerPanel('panel-credit-requests', 'Extension Requests', event); }
function showRecords(event)       { showRecordType(recordType, event); }
function showPurchasing(event)    { showPurchaseOrderHistory(event); }
function showArchives(event)      { showManagerPanel('panel-archives', 'Archives', event); }
function showQrPayments(event)    { showManagerPanel('panel-qr-payments', 'QR Payments', event); }

// Sales Summary. Named periods count back from today rather than snapping
// to a calendar month; Custom date opens a popup for two dates.
const INCOME_RANGES = [
    ['daily', 'Today'],
    ['weekly', 'Last 7 days'],
    ['monthly', 'Last 30 days'],
    ['quarterly', 'Last 90 days'],
    ['six-month', 'Last 6 months'],
    ['annual', 'Last 12 months']
];

// The calendar day this browser is having, as the date inputs write it.
// toISOString() answers in UTC, which is yesterday for the first eight hours
// of every day here.
function localIsoDay() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Income and sales are only ever behind us: the pickers stop at today
function limitDatesToToday(ids) {
    const today = localIsoDay();
    ids.forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.max = today;
    });
}

// The Period box: the named periods, then Custom date. Once a custom range
// is in use its own option says which dates it covers.
function renderIncomeRanges() {
    const select = document.getElementById('income-period');
    if (!select) return;

    let html = '';
    for (const range of INCOME_RANGES) {
        html += '<option value="' + range[0] + '">' + escapeHtml(range[1]) + '</option>';
    }
    const customLabel = incomeRange.name === 'custom'
        ? 'Custom: ' + incomeRange.from + ' to ' + incomeRange.to
        : 'Custom date...';
    html += '<option value="custom">' + escapeHtml(customLabel) + '</option>';

    select.innerHTML = html;
    select.value = incomeRange.name;
}

async function pickIncomeRange(name) {
    incomeRange = { name: name, from: null, to: null };
    renderIncomeRanges();
    await incomeRangeChanged();
}

// the Period box changed: a named period applies at once, Custom date asks first
function incomePeriodPicked(value) {
    if (value === 'custom') {
        openCustomIncomeRange();
        return;
    }
    pickIncomeRange(value);
}

function openCustomIncomeRange() {
    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');
    limitDatesToToday(['income-from', 'income-to']);
    if (from) from.value = incomeRange.name === 'custom' ? incomeRange.from : '';
    if (to) to.value = incomeRange.name === 'custom' ? incomeRange.to : localIsoDay();
    showModal('income-custom-modal');
    if (from) setTimeout(() => from.focus(), 60);
}

// closing the popup without applying leaves the period as it was
function cancelCustomIncomeRange() {
    closeModal('income-custom-modal');
    renderIncomeRanges();
}

async function applyCustomIncomeRange(event) {
    if (event) event.preventDefault();
    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');

    if (!from || !to || !from.value || !to.value) {
        notifyWarning('Pick both a start date and an end date.', 'Two dates needed');
        return;
    }

    if (from.value > to.value) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    // no sales have happened tomorrow; a future date is a typo, not a request
    const today = localIsoDay();
    if (from.value > today || to.value > today) {
        notifyWarning('The summary only covers days up to today. Pick dates on or before ' +
            today + '.', 'That date has not happened yet');
        return;
    }

    incomeRange = { name: 'custom', from: from.value, to: to.value };
    closeModal('income-custom-modal');
    renderIncomeRanges();
    await incomeRangeChanged();
}

function incomeQuery() {
    if (incomeRange.name === 'custom') {
        return '?from=' + encodeURIComponent(incomeRange.from) + '&to=' + encodeURIComponent(incomeRange.to);
    } else {
        return '?range=' + encodeURIComponent(incomeRange.name);
    }
}

// the figures are on screen (a table can be loaded without them)
let incomeSummaryShown = false;

async function fetchIncome() {
    incomeData = await apiGetIncome(incomeQuery());
}

// Load Data: the figures and both tables for the chosen period
async function loadIncome() {
    await refreshIncome(true);
}

// A new period refreshes only what is already loaded. With nothing loaded
// yet it loads everything, as Load Data does.
async function incomeRangeChanged() {
    const anyOpen = incomeSummaryShown || INCOME_PANEL_KEYS.some((key) => {
        const panel = getDataPanel(key);
        return panel && panel.state !== 'closed';
    });
    await refreshIncome(!anyOpen);
}

async function refreshIncome(all) {
    const summary = all || incomeSummaryShown;

    try {
        await fetchIncome();
        if (summary) renderIncome();

        INCOME_PANEL_KEYS.forEach((key) => {
            const panel = getDataPanel(key);
            if (panel && (all || panel.state !== 'closed')) panel.open();
        });
    } catch (error) {
        notifyOffline();
    }
}

// Before Load Data the four cards are already there with a dash, so the
// tables under them do not jump when the figures arrive.
function renderIncome() {
    const data = incomeData;
    const totals = data ? data.totals : null;

    if (data) {
        incomeSummaryShown = true;
        const note = document.getElementById('income-range-note');
        if (note) {
            note.textContent = data.range.label + ' — ' + data.range.from + ' to ' + data.range.to;
        }
    }

    const dash = '—';
    const kpis = [
        ['Total Sales', totals ? peso(totals.billed) : dash, 'total of every sale, paid or not', ''],
        ['Transactions', totals ? Number(totals.saleCount).toLocaleString('en-PH') : dash, 'sales rung up', ''],
        ['Units Sold', totals ? Number(totals.unitsSold).toLocaleString('en-PH') : dash, 'items across the counter', ''],
        ['Average Sale', totals ? peso(totals.averageSale) : dash, 'per transaction', '']
    ];

    const grid = document.getElementById('income-kpis');
    if (grid) {
        grid.innerHTML = kpis.map((k) =>
            '<div class="kpi-card ' + k[3] + '">' +
            '<span class="kpi-label">' + k[0] + '</span>' +
            '<span class="kpi-value">' + escapeHtml(k[1]) + '</span>' +
            '<span class="kpi-note">' + k[2] + '</span></div>'
        ).join('');
    }
}

// Every table can leave the page as an Excel workbook of every filtered row,
// or through the browser's print dialogue with the table unpaged. Both
// buttons are dead until the table holds rows and follow it via
// 'datapanel:change'. The server lays the workbook out (spreadsheet.js), so
// every column is as wide as what it holds.
function canExportReports() {
    const user = getCurrentUser();
    return Boolean(user && user.role_name === 'Manager');
}

function applyExportPermissions() {
    if (canExportReports()) return;

    document.querySelectorAll('[data-export]').forEach((button) => {
        button.remove();
    });
}

function printKeys(keys) {
    return String(keys || '').split(',').map((key) => key.trim()).filter(Boolean);
}

function panelHasRows(key) {
    const panel = getDataPanel(key);
    return Boolean(panel && panel.state === 'ready' && panel.visible.length > 0);
}

// called whenever any table changes shape
function syncExportButtons() {
    document.querySelectorAll('[data-print-for]').forEach((button) => {
        const ready = printKeys(button.dataset.printFor).some(panelHasRows);
        button.disabled = !ready;

        if (ready) {
            if (button.dataset.printKind === 'sheet') {
                button.title = 'Save every row shown as a spreadsheet';
            } else {
                button.title = 'Print every row shown, or save it as a PDF';
            }
        } else {
            button.title = 'Load data first';
        }
    });
}

// the income breakdown as one file, for the period on the screen
function exportIncomeSpreadsheet() {
    if (!canExportReports()) {
        notifyWarning('Only a manager can take a report off this screen.', 'Not allowed');
        return;
    }

    if (!incomeData) {
        notifyWarning('Load the income breakdown first, so the file matches what you are looking at.',
            'Nothing to export yet');
        return;
    }

    apiDownloadIncomeBreakdown(incomeQuery());

    notifyInfo('The Excel file is being saved to your downloads folder.', 'Exporting the Sales Summary');
}

// ---------- a spreadsheet of what the table shows ----------
// rows are read back as drawn, so the file and the page cannot disagree
function panelSheet(key) {
    const panel = getDataPanel(key);
    if (!panel || panel.state !== 'ready' || panel.visible.length === 0) return null;

    const table = document.getElementById(panel.config.tableId);
    if (!table) return null;

    // keep[i] says whether column i is saved; a column with no name holds buttons
    const heads = table.querySelectorAll('thead th');
    const keep = [];
    const headers = [];
    for (const th of heads) {
        const text = th.textContent.trim();
        keep.push(text !== '');
        if (text !== '') {
            headers.push(text);
        }
    }

    // draw every row (not just this page) into a hidden table, then read the cells back;
    // a column whose cells read as pesos is saved as money
    let rowsHtml = '';
    for (let index = 0; index < panel.visible.length; index++) {
        rowsHtml += panel.config.renderRow(panel.visible[index], index);
    }
    const scratch = document.createElement('table');
    scratch.innerHTML = '<tbody>' + rowsHtml + '</tbody>';

    const rows = [];
    const money = new Set();
    for (const tr of scratch.querySelectorAll('tbody tr')) {
        const cells = [];
        for (let i = 0; i < tr.children.length; i++) {
            if (keep[i]) {
                const value = sheetCell(tr.children[i]);
                if (typeof value === 'number' && tr.children[i].textContent.includes('\u20B1')) {
                    money.add(cells.length);
                }
                cells.push(value);
            }
        }
        rows.push(cells);
    }

    const caption = table.closest('.tab-content, .card');
    let name;
    if (caption) {
        name = (caption.querySelector('h3') || {}).textContent || key;
    } else {
        name = key;
    }

    return { name: String(name).trim(), headers: headers, rows: rows, money: Array.from(money) };
}

// money and count cells go in as numbers; anything with words as it reads
function sheetCell(td) {
    const text = td.textContent.replace(/\s+/g, ' ').trim();
    if (td.classList.contains('cell-num') || td.classList.contains('cell-id')) {
        // "#12" -> "12",  "-₱1,234.50" -> "-1234.50"
        let bare = text.replace(/^#/, '');       // remove a leading #
        bare = bare.replace(/^(-?)\u20B1/, '$1'); // remove the peso sign, keep a minus sign
        bare = bare.replace(/,/g, '');          // remove the commas
        if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);   // it is a plain number
    }
    return text;
}

async function exportPanelSpreadsheet(keys, title) {
    if (!canExportReports()) {
        notifyWarning('Only a manager can take a report off this screen.', 'Not allowed');
        return;
    }

    const sheets = printKeys(keys).map(panelSheet).filter(Boolean);
    if (sheets.length === 0) {
        notifyWarning('Load the table first, so the file matches what you are looking at.',
            'Nothing to export yet');
        return;
    }

    const name = title || sheets[0].name || 'Report';
    try {
        const response = await apiSaveSpreadsheet(name, sheets);
        if (!response.ok) {
            let body = null;
            try { body = await response.json(); } catch (error) { body = null; }
            if (!handleAuthFailure(response, body)) notifyError((body && body.error) || 'The spreadsheet could not be made.');
            return;
        }

        const blob = await response.blob();
        const file = name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') + '_' +
            new Date().toISOString().slice(0, 10) + '.xlsx';
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = file;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);

        let total = 0;
        for (const sheet of sheets) total += sheet.rows.length;
        notifyInfo(total + (total === 1 ? ' row' : ' rows') + ' saved as ' + file + '.', 'Spreadsheet saved');
    } catch (error) {
        notifyOffline();
    }
}

// ---------- paper ----------
// the browser's own print dialogue; the named tables are unpaged while it is open
let printRestore = null;

function printReport(keys) {
    if (!canExportReports()) {
        notifyWarning('Printing a report is a manager action.', 'Not allowed');
        return;
    }

    const panels = printKeys(keys).map(getDataPanel).filter(Boolean);
    if (panels.length > 0 && !panels.some((p) => p.state === 'ready' && p.visible.length > 0)) {
        notifyWarning('Load the table first. There is nothing on this screen to print yet.',
            'Nothing to print');
        return;
    }

    const saved = panels.map((panel) => ({ panel: panel, pageSize: panel.pageSize, page: panel.page }));
    panels.forEach((panel) => {
        if (panel.state !== 'ready') return;
        panel.pageSize = Math.max(1, panel.visible.length);
        panel.page = 1;
        panel.render();
    });

    // the views of a tabbed screen share it; the one asked for is the one printed
    const targets = panels.map((panel) => {
        const table = document.getElementById(panel.config.tableId);
        return table ? table.closest('.panel-view') : null;
    }).filter(Boolean);
    targets.forEach((card) => card.classList.add('is-print-target'));

    document.body.classList.add('is-printing');

    // afterprint is the reliable signal; the timer covers a browser that never sends it
    printRestore = () => {
        if (!printRestore) return;
        printRestore = null;
        document.body.classList.remove('is-printing');
        targets.forEach((card) => card.classList.remove('is-print-target'));
        saved.forEach((entry) => {
            entry.panel.pageSize = entry.pageSize;
            if (entry.panel.state === 'ready') {
                entry.panel.page = entry.page;
                entry.panel.render();
            }
        });
    };

    window.addEventListener('afterprint', function once() {
        window.removeEventListener('afterprint', once);
        if (printRestore) printRestore();
    });

    window.print();
    window.setTimeout(() => { if (printRestore) printRestore(); }, 1500);
}

// The Sales Summary's two tables, side by side, both read from the one period.
const INCOME_PANEL_KEYS = ['mgr-income-methods', 'mgr-income-products'];

// The one Load Data above fills the figures and both tables for the period.
async function incomeRows(field) {
    if (!incomeData) await fetchIncome();
    return incomeData[field];
}

const INCOME_GATE = {
    title: 'Not loaded',
    text: 'Pick a period above and press Load Data.',
    button: false
};

function buildIncomePanels() {
    renderIncome();

    createDataPanel({
        key: 'mgr-income-methods',
        tableId: 'income-methods-table',
        columns: 5,
        pageSize: 5,
        pagerId: 'income-methods-pager',
        gate: INCOME_GATE,
        load: () => incomeRows('methods'),
        renderRow: (m) =>
            '<tr><td class="cell-name">' + escapeHtml(m.payment_method) + '</td>' +
            '<td class="cell-num">' + m.sale_count + '</td>' +
            '<td class="cell-num">' + peso(m.billed) + '</td>' +
            '<td class="cell-num">' + peso(m.collected) + '</td>' +
            '<td class="cell-num' + (Number(m.outstanding) > 0 ? ' cell-due' : '') + '">' +
                peso(m.outstanding) + '</td></tr>'
    });

    createDataPanel({
        key: 'mgr-income-products',
        tableId: 'income-products-table',
        columns: 4,
        pageSize: 5,
        pagerId: 'income-products-pager',
        gate: INCOME_GATE,
        load: () => incomeRows('products'),
        renderRow: (p) => {
            let total;
            if (incomeData) {
                total = sumOf(incomeData.products, 'revenue');
            } else {
                total = 0;
            }

            const share = total === 0 ? 0 : (Number(p.revenue) / total) * 100;

            return '<tr><td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
                '<td class="cell-num">' + p.units_sold + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
                '<td class="cell-num">' + peso(p.revenue) + '</td>' +
                '<td class="cell-num">' + share.toFixed(1) + '%</td></tr>';
        }
    });

}

// Receivables and Repeat Customers come from one route, fetched once and shared
let reportsCache = null;

async function reportsOverview(force) {
    if (reportsCache && !force) return reportsCache;
    reportsCache = await apiGetReportsOverview();
    return reportsCache;
}

// The general report: everything staff have filed, newest first, with who
// filed it. The server names each kind by a short code; this says it the way
// the shop does, and a code it does not know is shown spaced out, not dropped.
const ACTIVITY_KINDS = {
    SALE: 'Sale',
    PAYMENT: 'Credit payment',
    DAMAGE: 'Damage report',
    REFUND: 'Refund report',
    RETURN: 'Return report',
    STOCK_ADJUST: 'Stock adjustment',
    DELIVERY: 'Delivery',
    PURCHASE_ORDER: 'Purchase order',
    PO_CONFIRMED: 'Order confirmed',
    PO_DECLINED: 'Order declined',
    CREDIT_REQUEST: 'Credit request',
    CREDIT_APPROVED: 'Credit approved',
    CREDIT_DECLINED: 'Credit declined',
    CREDIT_LIMIT: 'Credit limit set'
};

function activityKind(code) {
    if (ACTIVITY_KINDS[code]) return ACTIVITY_KINDS[code];
    const words = String(code || '').toLowerCase().replace(/_/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Entry';
}

// a compact stamp for a row: "4 Sep, 16:45"
function activityWhen(stamp) {
    const when = new Date(String(stamp || '').replace(' ', 'T'));
    if (isNaN(when.getTime())) return String(stamp || '').slice(0, 16);
    return when.toLocaleString('en-PH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function buildReportPanels() {
    createDataPanel({
        key: 'mgr-all',
        tableId: 'all-table',
        columns: 5,
        pageSize: REPORT_ROWS_PER_PAGE,
        pagerId: 'all-pager',
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for everything staff have filed: sales, payments, damage and refund ' +
                  'reports, stock adjustments, deliveries, purchase orders and credit decisions.',
            button: 'Load Data'
        },
        filters: { kind: 'all', role: 'all' },
        load: () => apiGetActivityReport(),
        match: (row, query) => prefixMatch([
            row.staff_name, row.role_name, activityKind(row.kind), row.details
        ], query),
        filter: (row, filters) =>
            (filters.kind === 'all' || activityKind(row.kind) === filters.kind) &&
            (filters.role === 'all' || row.role_name === filters.role),
        onLoaded: (rows) => {
            fillFilterOptions('all-kind', rows.map((row) => activityKind(row.kind)), 'Every report');
            fillFilterOptions('all-role', rows.map((row) => row.role_name), 'Every role');
        },
        renderRow: (row, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">' + escapeHtml(activityWhen(row.happened_at)) + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.staff_name || 'Not recorded') + '</td>' +
            '<td>' + escapeHtml(row.role_name || '') + '</td>' +
            '<td>' + escapeHtml(activityKind(row.kind)) + '</td>' +
            '<td>' + escapeHtml(row.details || '') + '</td></tr>'
    });

    createDataPanel({
        key: 'mgr-unpaid',
        tableId: 'unpaid-table',
        columns: 6,
        pageSize: REPORT_ROWS_PER_PAGE,
        pagerId: 'unpaid-pager',
        idField: 'sale_id',
        filters: { status: 'all', method: 'all', age: 'all' },
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for every sale with money still owed on it.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview(true)).unpaid,
        match: (row, query) => prefixMatch([
            row.customer_name, row.payment_method, row.sale_id, '#' + row.sale_id
        ], query),
        filter: (row, filters) =>
            (filters.status === 'all' || row.payment_status === filters.status) &&
            (filters.method === 'all' || row.payment_method === filters.method) &&
            receivableAgeMatches(row, filters.age),
        onLoaded: (rows) => {
            fillFilterOptions('unpaid-status', rows.map((row) => row.payment_status), 'Every status');
            fillFilterOptions('unpaid-method', rows.map((row) => row.payment_method), 'Every method');
        },
        renderRow: (u, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openSaleDetail(' + u.sale_id + ')">' +
            '<td class="cell-id">#' + u.sale_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(u.customer_name) + '</td>' +
            '<td>' + escapeHtml(u.payment_method) + '</td>' +
            '<td>' + statusBadge(u.payment_status) + '</td>' +
            '<td class="cell-num cell-due">' + peso(u.balance_due) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(u.sale_date).slice(0, 10)) + '</td></tr>'
    });

    createDataPanel({
        key: 'mgr-loyal',
        tableId: 'loyal-table',
        columns: 5,
        pageSize: REPORT_ROWS_PER_PAGE,
        pagerId: 'loyal-pager',
        idField: 'customer_id',
        filters: { purchases: 'all', balance: 'all', last: 'all' },
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for customers who have bought more than once.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview()).loyal,
        match: (row, query) => prefixMatch([row.customer_name], query),
        filter: (row, filters) => repeatCustomerMatches(row, filters),
        renderRow: (c, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openCustomerDetail(' + c.customer_id + ')">' +
            '<td class="cell-name">' + escapeHtml(c.customer_name) + '</td>' +
            '<td class="cell-num">' + c.purchase_count + '</td>' +
            '<td class="cell-num">' + peso(c.total_spent) + '</td>' +
            '<td class="cell-num' + (Number(c.balance_due) > 0 ? ' cell-due' : '') + '">' +
                peso(c.balance_due) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(c.last_purchase).slice(0, 10)) + '</td></tr>'
    });

}

// Repeat Customers: how many purchases, whether they owe, and how long ago
// they last bought
function repeatCustomerMatches(row, filters) {
    const count = Number(row.purchase_count) || 0;
    if (filters.purchases === '2-4' && (count < 2 || count > 4)) return false;
    if (filters.purchases === '5-9' && (count < 5 || count > 9)) return false;
    if (filters.purchases === '10+' && count < 10) return false;

    const owes = (Number(row.balance_due) || 0) > 0;
    if (filters.balance === 'owing' && !owes) return false;
    if (filters.balance === 'clear' && owes) return false;

    if (filters.last !== 'all') {
        const last = new Date(String(row.last_purchase || '').slice(0, 10) + 'T00:00:00');
        if (isNaN(last.getTime())) return filters.last === 'older';
        const days = Math.floor((Date.now() - last.getTime()) / 86400000);
        if (filters.last === '30' && days > 30) return false;
        if (filters.last === '90' && days > 90) return false;
        if (filters.last === 'older' && days <= 90) return false;
    }
    return true;
}

// how old a receivable is, in whole days since the sale
function receivableAgeMatches(row, age) {
    if (!age || age === 'all') return true;
    const sold = new Date(String(row.sale_date || '').slice(0, 10) + 'T00:00:00');
    if (isNaN(sold.getTime())) return true;
    const days = Math.floor((Date.now() - sold.getTime()) / 86400000);
    if (age === '0-30') return days <= 30;
    if (age === '31-60') return days > 30 && days <= 60;
    if (age === '61-90') return days > 60 && days <= 90;
    if (age === '90+') return days > 90;
    return true;
}

// A dropdown filled from the loaded rows: one option per value they hold,
// sorted, keeping the one already picked when it is still there.
function fillFilterOptions(id, values, allLabel) {
    const select = document.getElementById(id);
    if (!select) return;
    const picked = select.value;
    const unique = Array.from(new Set(values.filter((value) => value !== null && value !== undefined && value !== '')))
        .map(String).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">' + escapeHtml(allLabel) + '</option>' +
        unique.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join('');
    select.value = unique.indexOf(picked) !== -1 ? picked : 'all';
    if (select.dataset.filterTable) syncFilteredColumns(select.dataset.filterTable);
}

// the same, with how many rows hold each value: "Staff (3)"
function fillCountedOptions(id, values, allLabel) {
    const select = document.getElementById(id);
    if (!select) return;
    const picked = select.value;
    const counts = new Map();
    values.forEach((value) => {
        if (value === null || value === undefined || value === '') return;
        counts.set(String(value), (counts.get(String(value)) || 0) + 1);
    });
    const unique = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">' + escapeHtml(allLabel) + ' (' + values.length + ')</option>' +
        unique.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) +
            ' (' + counts.get(value) + ')</option>').join('');
    select.value = unique.indexOf(picked) !== -1 ? picked : 'all';
    if (select.dataset.filterTable) syncFilteredColumns(select.dataset.filterTable);
}

// Sales. Both filters go back to the server, where the figures are computed.
const SALE_STATUS_TONE = {
    'Completed': 'badge-success',
    'Pending Delivery': 'badge-warning',
    'Partial Credit': 'badge-warning',
    'Voided': 'badge-danger'
};

// A sales date after today is a typo, not a filter: it is emptied with a
// warning and the list loads without it. True when something was dropped.
function dropFutureSalesDates() {
    const today = localIsoDay();
    let dropped = false;

    ['sales-from', 'sales-to'].forEach((id) => {
        const input = document.getElementById(id);
        if (input && input.value && input.value > today) {
            input.value = '';
            dropped = true;
        }
    });

    if (dropped) {
        notifyWarning('Sales only go up to today. Pick dates on or before ' + today + '.',
            'That date has not happened yet');
    }
    return dropped;
}

function salesQuery() {
    dropFutureSalesDates();

    const parts = [];
    const add = (id, key) => {
        const field = document.getElementById(id);
        if (field && field.value && field.value !== 'all') {
            parts.push(key + '=' + encodeURIComponent(field.value));
        }
    };

    add('sales-method', 'method');
    add('sales-status', 'status');
    add('sales-from', 'from');
    add('sales-to', 'to');

    return parts.length ? '?' + parts.join('&') : '';
}

async function reloadSales() {
    if (dropFutureSalesDates()) return;

    const panel = getDataPanel('mgr-sales');
    if (panel) await panel.open();
}

function buildSalesPanel() {
    createDataPanel({
        key: 'mgr-sales',
        tableId: 'sales-table',
        columns: 6,
        pagerId: 'sales-pager',
        idField: 'sale_id',
        gate: {
            title: 'No sales loaded',
            text: 'Pick a payment method, a status or a date range above, then press Load Data.',
            button: 'Load Data'
        },
        load: () => apiGetSales(salesQuery()),
        match: (s, query) => prefixMatch([
            s.customer_name, s.cashier_name, s.payment_method, s.sale_id, '#' + s.sale_id
        ], query),
        renderRow: (s, index) => {
            const tone = SALE_STATUS_TONE[s.transaction_status] || 'badge-neutral';
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openSaleDetail(' + s.sale_id + ')">' +
                '<td class="cell-id">#' + s.sale_id + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(s.sale_date).slice(0, 10)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(s.customer_name) + '</td>' +
                '<td>' + escapeHtml(s.payment_group) +
                    (s.payment_group !== s.payment_method
                        ? ' <span class="muted">' + escapeHtml(s.payment_method) + '</span>' : '') + '</td>' +
                '<td><span class="badge ' + tone + '">' + escapeHtml(s.transaction_status) + '</span></td>' +
                '<td class="cell-num">' + peso(s.final_amount) + '</td></tr>';
        }
    });
}

// Stocks: one fetch behind Reorder Alerts and the Stocks Overview.
let stocksCache = null;

// Load Data on either stock screen reads /api/stocks afresh: a button that
// says Load Data fetches. The copy kept here is for the price and reorder
// dialogs, which look a product up by id; it is dropped after every save.
async function stockRows() {
    stocksCache = await apiGetStocks();
    return stocksCache;
}

function modeBadge(row) {
    if (row.reorder_mode === 'Dynamic') {
        return '<span class="badge badge-success">Dynamic</span>';
    } else {
        return '<span class="badge badge-neutral">Manual</span>';
    }
}

// Quantity gets a filter of its own; stock status only says whether a product
// is under its reorder point. The bands are round numbers on purpose.
function stockLevelMatches(p, level) {
    const onHand = Number(p.quantity_in_stock) || 0;
    const rop = Number(p.effective_rop) || 0;

    switch (level) {
        case 'all':       return true;
        case 'none':      return onHand <= 0;
        case 'under-rop': return onHand < rop;
        case 'near-rop':  return onHand >= rop && onHand <= rop * 1.25;
        case '1-10':      return onHand >= 1 && onHand <= 10;
        case '11-50':     return onHand >= 11 && onHand <= 50;
        case '51-200':    return onHand >= 51 && onHand <= 200;
        case '200+':      return onHand > 200;
        default:          return true;
    }
}

// a product nobody sells has no days of cover, so it sorts last
function sortStockRows(rows, order) {
    const num = (value) => Number(value) || 0;
    const byName = (a, b) => String(a.product_name).localeCompare(String(b.product_name));

    const compare = {
        'name':       byName,
        'stock-asc':  (a, b) => num(a.quantity_in_stock) - num(b.quantity_in_stock) || byName(a, b),
        'stock-desc': (a, b) => num(b.quantity_in_stock) - num(a.quantity_in_stock) || byName(a, b),
        'gap':        (a, b) => (num(a.quantity_in_stock) - num(a.effective_rop)) -
                                (num(b.quantity_in_stock) - num(b.effective_rop)) || byName(a, b),
        'value-desc': (a, b) => num(b.stock_value) - num(a.stock_value) || byName(a, b),
        'value-asc':  (a, b) => num(a.stock_value) - num(b.stock_value) || byName(a, b),
        'cover':      (a, b) => {
            const left = a.days_of_cover === null || a.days_of_cover === undefined ? Infinity : num(a.days_of_cover);
            const right = b.days_of_cover === null || b.days_of_cover === undefined ? Infinity : num(b.days_of_cover);
            return (left - right) || byName(a, b);
        }
    }[order] || byName;

    return rows.sort(compare);
}

function buildStockPanels() {
    createDataPanel({
        key: 'mgr-reorder',
        tableId: 'reorder-table',
        columns: 8,
        pagerId: 'reorder-pager',
        idField: 'product_id',
        filters: { mode: 'all', status: 'all' },
        gate: {
            title: 'Reorder alerts not loaded',
            text: 'Press Load Data for every product at or below its reorder point.',
            button: 'Load Data'
        },
        load: async () => (await stockRows()).filter((p) => p.stock_status !== 'In Stock'),
        match: (p, query) => prefixMatch([p.product_name, p.supplier_name], query),
        filter: (p, filters) =>
            (filters.mode === 'all' || p.reorder_mode === filters.mode) &&
            (filters.status === 'all' || p.stock_status === filters.status),
        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openStockDetail(' + p.product_id + ')">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
            '<td class="cell-num">' + p.effective_rop + ' ' + modeBadge(p) + '</td>' +
            '<td class="cell-num">' + Number(p.avg_daily_sales).toFixed(2) + '</td>' +
            '<td class="cell-num">' + (p.days_of_cover === null
                ? '<span class="muted">no sales</span>'
                : Number(p.days_of_cover).toFixed(0) + ' days') + '</td>' +
            '<td class="cell-num cell-due">' + p.suggested_order + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td>' + escapeHtml(p.supplier_name || 'No supplier') + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>'
    });

    createDataPanel({
        key: 'mgr-stocks',
        tableId: 'stocks-table',
        columns: 7,
        pagerId: 'stocks-pager',
        idField: 'product_id',
        filters: { status: 'all', level: 'all', sort: 'name' },
        gate: {
            title: 'The stock report is not loaded',
            text: 'Search for a product, pick a status or a quantity, or press Load Data for the whole inventory.',
            button: 'Load Data'
        },
        load: () => stockRows(),
        match: (p, query) => prefixMatch([p.product_name, p.category_name, p.supplier_name], query),
        filter: (p, filters) =>
            (filters.status === 'all' || p.stock_status === filters.status) &&
            stockLevelMatches(p, filters.level),
        sort: (rows, filters) => sortStockRows(rows, filters.sort),
        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openStockDetail(' + p.product_id + ')">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td class="cell-num">' + p.effective_rop + ' ' + modeBadge(p) + '</td>' +
            '<td class="cell-num">' + peso(p.price) + '</td>' +
            '<td class="cell-num">' + peso(p.stock_value) + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>'
    });
}

// Stock Movements: the stock side of the activity log -- what staff filed that
// moved or will move goods on the shelf
const STOCK_MOVE_KINDS = ['STOCK_ADJUST', 'DAMAGE', 'RETURN', 'PURCHASE_ORDER', 'PO_CONFIRMED', 'PO_DECLINED'];

function buildStockMovesPanel() {
    createDataPanel({
        key: 'mgr-stock-moves',
        tableId: 'stock-moves-table',
        columns: 5,
        pagerId: 'stock-moves-pager',
        filters: { kind: 'all', role: 'all' },
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for the damage and return reports, stock adjustments and purchase orders staff have filed.',
            button: 'Load Data'
        },
        load: async () => (await apiGetActivityReport()).filter((row) => STOCK_MOVE_KINDS.includes(row.kind)),
        match: (row, query) => prefixMatch([row.staff_name, activityKind(row.kind), row.details], query),
        filter: (row, filters) =>
            (filters.kind === 'all' || row.kind === filters.kind) &&
            (filters.role === 'all' || row.role_name === filters.role),
        onLoaded: (rows) => fillFilterOptions('stock-moves-role', rows.map((row) => row.role_name), 'Every role'),
        renderRow: (row, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">' + escapeHtml(activityWhen(row.happened_at)) + '</td>' +
            '<td>' + escapeHtml(activityKind(row.kind)) + '</td>' +
            '<td>' + escapeHtml(row.details || '') + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.staff_name || 'Not recorded') + '</td>' +
            '<td>' + escapeHtml(row.role_name || '') + '</td></tr>'
    });
}

// ==========================================
// THE PRICE -- asked for in a card, read back, then saved
// ==========================================
async function changePrice(productId) {
    const product = (stocksCache || []).find((p) => p.product_id === productId);
    if (!product) return;

    const current = Number(product.price) || 0;
    const unit = product.unit_name ? ' per ' + product.unit_name : '';

    const asked = await askInput({
        title: 'Change the price',
        eyebrow: 'Stocks Overview',
        message: product.product_name + ' sells at ' + peso(current) + unit + '. What should it sell at now? ' +
                 'The till uses the new figure from the next sale on; nothing already sold changes.',
        label: 'New price' + unit,
        type: 'number',
        value: current.toFixed(2),
        placeholder: '0.00',
        confirmLabel: 'Next',
        check: (value) => {
            const typed = String(value).replace(/,/g, '').trim();
            const number = Number(typed);
            if (typed === '' || !Number.isFinite(number)) return 'Type the price as a figure, like 450 or 78.50.';
            if (number < 0) return 'A price cannot be below zero.';
            // the typed text is checked, not the float: 19.99 * 100 is 1998.9999999999998
            if (!/^\d+(\.\d{1,2})?$/.test(typed)) return 'Two decimal places at most.';
            if (number === current) return 'That is the price it already sells at.';
            return null;
        }
    });

    if (asked === false || asked === null) return;

    const next = Math.round(Number(String(asked).replace(/,/g, '').trim()) * 100) / 100;
    const up = next > current;
    const share = current > 0 ? Math.abs(next - current) / current : null;
    const onHand = Number(product.quantity_in_stock) || 0;

    const yes = await askConfirm(
        product.product_name + ': ' + peso(current) + ' to ' + peso(next) + unit +
        (share !== null ? ' (' + (up ? 'up' : 'down') + ' ' + Math.round(share * 100) + '%)' : '') + '.',
        {
            title: up ? 'Raise the price?' : 'Lower the price?',
            eyebrow: 'Stocks Overview',
            confirmLabel: 'Set the price',
            // a big jump is more often a slipped decimal than a decision
            tone: share !== null && share >= 0.5 ? 'danger' : undefined,
            detail: [
                'The till sells at ' + peso(next) + ' from the next sale on.',
                'Stock value moves from ' + peso(current * onHand) + ' to ' + peso(next * onHand) + '.',
                'The change is written to the audit trail in your name.'
            ]
        });

    if (!yes) return;

    try {
        const response = await apiSavePrice(productId, next);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Price not changed');
            return;
        }

        notifySuccess(result.message, 'Price changed');
        closeModal('detail-modal');

        stocksCache = null;
        for (const key of ['mgr-reorder', 'mgr-stocks']) {
            const panel = getDataPanel(key);
            if (panel && panel.state === 'ready') await panel.refresh();
        }
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// THE REORDER POLICY
// ==========================================
function openReorderPolicy(productId) {
    const product = (stocksCache || []).find((p) => p.product_id === productId);
    if (!product) return;

    policyProduct = product;
    closeModal('detail-modal');

    document.getElementById('policy-product').textContent = product.product_name;
    document.getElementById('policy-sub').textContent =
        (product.category_name || 'Uncategorised') + ' · ' + (product.supplier_name || 'No supplier');
    document.getElementById('policy-avatar').textContent = initialsOf(product.product_name);

    document.getElementById('policy-facts').innerHTML =
        detailField('Sold Recently', product.units_sold_window + ' ' + escapeHtml(product.unit_name || '') +
            ' over ' + product.window_days + ' days') +
        detailField('Average Daily Sales', Number(product.avg_daily_sales).toFixed(3) + ' ' +
            escapeHtml(product.unit_name || '')) +
        detailField('On Hand Now', product.quantity_in_stock + ' ' + escapeHtml(product.unit_name || '')) +
        detailField('Reorder Point In Use', String(product.effective_rop));

    const form = document.getElementById('policy-form');
    form.elements.leadTimeDays.value = product.lead_time_days;
    form.elements.safetyStock.value = product.safety_stock;
    form.elements.reorderMode.value = product.reorder_mode;
    form.elements.reorderPoint.value = product.reorder_point;

    previewReorderPoint();
    showModal('policy-modal');
}

// the arithmetic, shown as it is typed
function previewReorderPoint() {
    if (!policyProduct) return;

    const form = document.getElementById('policy-form');
    const preview = document.getElementById('policy-preview');
    if (!form || !preview) return;

    const lead = Number(form.elements.leadTimeDays.value) || 0;
    const safety = Number(form.elements.safetyStock.value) || 0;
    const manual = Number(form.elements.reorderPoint.value) || 0;
    const daily = Number(policyProduct.avg_daily_sales) || 0;

    const calculated = Math.ceil(daily * lead) + safety;
    const dynamic = form.elements.reorderMode.value === 'Dynamic';
    const unit = policyProduct.unit_name || 'units';

    preview.innerHTML =
        '<span class="formula-line">(' + daily.toFixed(3) + ' a day &times; ' + lead + ' days) + ' +
        safety + ' safety = <strong>' + calculated + ' ' + escapeHtml(unit) + '</strong></span>' +
        '<span class="formula-verdict">' +
        (dynamic
            ? 'This product will reorder at <strong>' + calculated + '</strong>, recalculated as sales change.'
            : 'This product will reorder at <strong>' + manual + '</strong>, the manual figure. ' +
              'The calculated one is shown above for comparison.') +
        '</span>';

    preview.classList.toggle('is-dynamic', dynamic);
}

async function saveReorderPolicy(event) {
    event.preventDefault();
    if (!policyProduct) return;

    const form = event.target;
    const body = {
        leadTimeDays: parseInt(form.elements.leadTimeDays.value, 10),
        safetyStock: parseInt(form.elements.safetyStock.value, 10),
        reorderMode: form.elements.reorderMode.value,
        reorderPoint: parseInt(form.elements.reorderPoint.value, 10)
    };

    if (body.reorderMode === 'Dynamic' && policyProduct.reorder_mode !== 'Dynamic') {
        const calculated = Math.ceil((Number(policyProduct.avg_daily_sales) || 0) * body.leadTimeDays) +
            body.safetyStock;

        const yes = await askConfirm(
            policyProduct.product_name + ' will reorder at ' + calculated + ' instead of ' +
            policyProduct.reorder_point + '.',
            {
                title: 'Let the system set this reorder point?',
                eyebrow: 'Reorder Policy',
                confirmLabel: 'Use the formula',
                detail: [
                    'The figure moves on its own as the product sells faster or slower.',
                    'A product that stops selling will fall to its safety stock alone.',
                    'You can switch it back to Manual at any time.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await apiSaveReorderPolicy(policyProduct.product_id, body);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message, 'Reorder policy saved');
        closeModal('policy-modal');

        stocksCache = null;
        for (const key of ['mgr-reorder', 'mgr-stocks']) {
            const panel = getDataPanel(key);
            if (panel && panel.state === 'ready') await panel.refresh();
        }
    } catch (error) {
        notifyOffline();
    }
}


// Purchase orders: the history, the printed order and the confirm / decline
// card come from shared/purchase-orders.js. The manager checks and decides;
// the clerk raises the order and counts the delivery in.
function buildManagerPurchaseOrderPanel() {
    configurePurchaseOrders({
        key: 'mgr-po',
        canCreate: false,          // the clerk raises an order
        canDecide: true,           // the manager confirms or declines it
        canReceive: false,         // the clerk counts the delivery in
        showPanel: (panelId, title) => showManagerPanel(panelId, title),
        historyPanelId: 'panel-po-history',
        historyTitle: 'Purchase Orders',
        gateText: 'Press Load Data for every order raised, or filter to the ones waiting for your confirmation.'
    });
    buildPurchaseOrderPanel();
    buildPurchaseTotalsPanel();
}

// Credit management: a limit and a standing are edited together, with what
// the customer owes printed above them.
const STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };
const STANDING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

// the shop's late-payment policy, read once the credit screen is built and
// again after every save; what the strip above the credit book shows
let penaltyPolicy = null;

let creditCustomer = null;
let creditRequest = null;

// reason is the view's standing_reason: the first rule that fired
function standingBadge(standing, reason) {
    return '<span class="badge ' + (STANDING_TONE[standing] || 'badge-neutral') + '"' +
           (reason ? ' title="' + escapeHtml(reason) + '"' : '') + '>' +
           escapeHtml(STANDING_WORD[standing] || standing) + '</span>';
}

function debtAge(days) {
    if (days === null || days === undefined) return '<span class="muted">No balance</span>';

    const count = Number(days);
    let text;
    if (count === 0) {
        text = 'Today';
    } else if (count === 1) {
        text = '1 day';
    } else {
        text = count + ' days';
    }

    if (count > 60) return '<span class="cell-due">' + text + '</span>';
    if (count > 30) return '<span class="text-warn">' + text + '</span>';
    return text;
}

function buildCreditPanels() {
    createDataPanel({
        key: 'mgr-credit',
        tableId: 'credit-table',
        columns: 6,
        pagerId: 'credit-pager',
        idField: 'customer_id',
        filters: { owing: 'all' },

        gate: {
            title: 'The credit book is not loaded',
            text: 'Search for a customer, filter by balance, or press Load Data for every account.',
            button: 'Load Data'
        },

        load: () => apiGetCreditCustomers(),

        match: (row, query) => prefixMatch([row.customer_name, row.phone], query),

        filter: (row, filters) => {
            const owed = Number(row.current_credit) || 0;
            const limit = Number(row.credit_limit) || 0;

            if (filters.owing === 'owing' && owed <= 0) return false;
            if (filters.owing === 'clear' && owed > 0) return false;
            if (filters.owing === 'over' && owed <= limit) return false;

            return true;
        },

        renderRow: (row, index) => {
            const owed = Number(row.current_credit) || 0;
            const limit = Number(row.credit_limit) || 0;
            const over = owed > limit;

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openCreditAccount(' + row.customer_id + ')">' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) +
                    (Number(row.pending_requests) > 0
                        ? ' <span class="badge badge-warning">Request waiting</span>' : '') + '</td>' +
                '<td class="cell-num">' + peso(row.credit_limit) + '</td>' +
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) +
                    (Number(row.penalties_owed) > 0
                        ? '<span class="cell-sub">incl. ' + peso(row.penalties_owed) + ' penalty</span>' : '') + '</td>' +
                '<td class="cell-num">' + (over
                    ? '<span class="cell-due">Over by ' + peso(owed - limit) + '</span>'
                    : peso(row.available_credit)) + '</td>' +
                '<td class="cell-num">' + row.open_sales + '</td>' +
                '<td class="cell-num">' + debtAge(row.oldest_debt_days) + '</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-requests',
        tableId: 'requests-table',
        columns: 7,
        pagerId: 'requests-pager',
        idField: 'request_id',

        gate: {
            title: 'No requests loaded',
            text: 'Press Load Data for extension requests raised at the counter.',
            button: 'Load Data'
        },

        load: () => {
            const status = document.getElementById('requests-status');
            const value = status ? status.value : 'Pending';
            return apiGetCreditRequests(value);
        },

        match: (row, query) => prefixMatch([row.customer_name, row.requested_by], query),

        renderRow: (row, index) => {
            let tone;
            if (row.status === 'Pending') {
                tone = 'badge-warning';
            } else if (row.status === 'Approved') {
                tone = 'badge-success';
            } else {
                tone = 'badge-danger';
            }

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openCreditRequest(' + row.request_id + ')">' +
                '<td class="cell-id">' + escapeHtml(String(row.created_at).slice(0, 16)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td class="cell-num' + (Number(row.current_credit) > 0 ? ' cell-due' : '') + '">' +
                    peso(row.current_credit) + '</td>' +
                '<td class="cell-num">' + peso(row.previous_limit) + '</td>' +
                '<td class="cell-num">' + peso(row.requested_limit) + '</td>' +
                '<td>' + escapeHtml(row.requested_by || 'Unknown') + '</td>' +
                '<td><span class="badge ' + tone + '">' + escapeHtml(row.status) + '</span></td></tr>';
        }
    });

    loadPenaltyPolicy();
    // another manager's change, or the hourly sweep charging something
    if (typeof onLiveChange === 'function') onLiveChange(['credit'], () => loadPenaltyPolicy());
}

// ---------- the late-payment policy ----------
// 1 to 3 percent a month of the goods still unpaid, for every month a credit
// sale is past its 30-day due date; the default is 3. The manager may set
// another rate for the shop here; an account can be given its own rate on
// its credit terms.
async function loadPenaltyPolicy() {
    try {
        penaltyPolicy = await apiGetPenaltyPolicy();
    } catch (error) {
        return;   // the strip keeps whatever it last showed
    }
    renderPenaltyPolicy();
}

function renderPenaltyPolicy() {
    const rate = document.getElementById('penalty-policy-rate');
    const words = document.getElementById('penalty-policy-words');
    if (!rate || !words || !penaltyPolicy) return;

    const pct = Number(penaltyPolicy.penalty_rate) || 0;
    const own = Number(penaltyPolicy.own_rate_accounts) || 0;
    const charged = Number(penaltyPolicy.penalised_sales) || 0;
    const owed = Number(penaltyPolicy.penalties_owed) || 0;

    rate.textContent = penaltyRateWord(pct) + ' a month';

    words.innerHTML =
        'late-payment penalty on the goods still unpaid, for every month a credit sale is past its 30-day due date. ' +
        (charged > 0
            ? '<span class="muted">' + peso(owed) + ' in penalties is owed on ' + charged +
              (charged === 1 ? ' sale' : ' sales') + '.</span> '
            : '') +
        (own > 0
            ? '<span class="muted">' + own + (own === 1 ? ' account has' : ' accounts have') +
              ' a rate of ' + (own === 1 ? 'its' : 'their') + ' own.</span>'
            : '');
}

function openPenaltyPolicy() {
    const form = document.getElementById('penalty-form');
    if (!form) return;

    const pct = penaltyPolicy ? Number(penaltyPolicy.penalty_rate) : 3;
    form.elements.penaltyRate.value = Number.isFinite(pct) ? pct.toFixed(2) : '3.00';

    document.getElementById('penalty-facts').innerHTML =
        detailField('Rate Now', penaltyRateWord(pct) + ' a month' + (pct === 3 ? ' <span class="muted">the default</span>' : '')) +
        detailField('Last Changed', penaltyPolicy && penaltyPolicy.updated_at
            ? escapeHtml(String(penaltyPolicy.updated_at).slice(0, 16)) +
              (penaltyPolicy.updated_by ? ' <span class="muted">by ' + escapeHtml(penaltyPolicy.updated_by) + '</span>' : '')
            : '<span class="muted">Never</span>') +
        detailField('Charged So Far', penaltyPolicy && Number(penaltyPolicy.penalised_sales) > 0
            ? peso(penaltyPolicy.penalties_owed) + ' <span class="muted">on ' + penaltyPolicy.penalised_sales +
              (Number(penaltyPolicy.penalised_sales) === 1 ? ' open sale' : ' open sales') + '</span>'
            : '<span class="muted">Nothing outstanding</span>') +
        detailField('Own-Rate Accounts', String((penaltyPolicy && penaltyPolicy.own_rate_accounts) || 0));

    previewPenaltyPolicy();
    showModal('penalty-modal');
    setTimeout(() => { form.elements.penaltyRate.focus(); form.elements.penaltyRate.select(); }, 60);
}

// the rate as a worked example, so 3 reads as pesos a month before it is saved
function previewPenaltyPolicy() {
    const form = document.getElementById('penalty-form');
    const preview = document.getElementById('penalty-preview');
    if (!form || !preview) return;

    const pct = Number(form.elements.penaltyRate.value);
    if (!Number.isFinite(pct) || pct < 1 || pct > 3) {
        preview.className = 'formula-preview is-stop';
        preview.innerHTML = '<span class="formula-verdict">The rate is from 1 to 3 percent a month.</span>';
        return;
    }

    const example = 10000;
    const month = example * pct / 100;
    preview.className = 'formula-preview is-dynamic';
    preview.innerHTML =
        '<span class="formula-line">' + peso(example) + ' unpaid &times; ' + penaltyRateWord(pct) +
            ' = <strong>' + peso(month) + ' a month</strong></span>' +
        '<span class="formula-verdict">A sale with ' + peso(example) + ' of goods unpaid is charged ' +
            peso(month) + ' the day after its due date, and ' + peso(month) + ' more every thirty days ' +
            'after that: three months overdue, it owes ' + peso(example + month * 3) + '.</span>';
}

async function savePenaltyPolicy(event) {
    event.preventDefault();
    const form = event.target;
    const pct = Number(form.elements.penaltyRate.value);

    if (!Number.isFinite(pct) || pct < 1 || pct > 3) {
        notifyWarning('The late-payment rate is 1 to 3 percent a month.', 'Not saved');
        return;
    }

    try {
        const response = await apiSavePenaltyPolicy(pct);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Not saved');
            return;
        }

        notifySuccess(result.message, 'Late-payment rate saved');
        closeModal('penalty-modal');
        await loadPenaltyPolicy();
    } catch (error) {
        notifyOffline();
    }
}

async function reloadCreditRequests() {
    const panel = getDataPanel('mgr-requests');
    if (panel) await panel.open();
}

// ---------- one account ----------
async function openCreditAccount(customerId) {
    try {
        const data = await apiGetCreditCustomer(customerId);
        creditCustomer = data.credit;

        const c = creditCustomer;
        const owed = Number(c.current_credit) || 0;
        const limit = Number(c.credit_limit) || 0;

        document.getElementById('credit-name').textContent = c.customer_name;
        document.getElementById('credit-sub').textContent =
            (c.phone || 'No phone on file');
        document.getElementById('credit-avatar').textContent = initialsOf(c.customer_name);

        document.getElementById('credit-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Balance', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Available Balance', owed > limit
                ? '<span class="cell-due">Over by ' + peso(owed - limit) + '</span>'
                : peso(c.available_credit)) +
            detailField('Open Sales', String(c.open_sales) +
                (Number(c.overdue_sales) > 0
                    ? ' <span class="cell-due">' + c.overdue_sales + ' overdue</span>' : '')) +
            detailField('Oldest Debt', debtAge(c.oldest_debt_days)) +
            detailField('Late Penalties', Number(c.penalties_owed) > 0
                ? '<span class="cell-due">' + peso(c.penalties_owed) + '</span> <span class="muted">of the amount owed</span>'
                : '<span class="muted">None charged</span>') +
            detailField('Late-Payment Rate', penaltyRateWord(c.penalty_rate) + ' a month' +
                (c.penalty_rate_override === null || c.penalty_rate_override === undefined
                    ? ' <span class="muted">the shop\'s rate</span>'
                    : ' <span class="muted">this account\'s own</span>')) +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            detailField('Last Purchase', c.last_purchase
                ? escapeHtml(String(c.last_purchase).slice(0, 16))
                : '<span class="muted">Never</span>') +
            detailField('Last Payment', c.last_payment
                ? escapeHtml(String(c.last_payment).slice(0, 16))
                : '<span class="muted">None recorded</span>') +
            detailField('Last Changed', c.credit_updated_at
                ? escapeHtml(String(c.credit_updated_at).slice(0, 16))
                : '<span class="muted">Never</span>');

        const form = document.getElementById('credit-form');
        form.elements.creditLimit.value = Number(c.credit_limit).toFixed(2);
        form.elements.standing.value = c.manual_standing || 'Good';

        if (c.penalty_rate_override === null || c.penalty_rate_override === undefined) {
            form.elements.penaltyRate.value = '';
        } else {
            form.elements.penaltyRate.value = Number(c.penalty_rate_override).toFixed(2);
        }

        form.elements.notes.value = c.credit_notes || '';

        const hint = document.getElementById('credit-penalty-hint');
        if (hint) {
            const shop = penaltyPolicy ? Number(penaltyPolicy.penalty_rate) : null;
            hint.textContent = '1 to 3; blank means the shop\'s rate' +
                (Number.isFinite(shop) ? ', ' + penaltyRateWord(shop) : '');
        }

        previewCreditLimit();
        showCreditTab('account');
        showModal('credit-modal');

        creditHistory = null;
    } catch (error) {
        notifyError('That credit account could not be opened.', 'Nothing to show');
    }
}

function showCreditTab(tab) {
    const history = tab === 'history';
    document.getElementById('credit-account-tab').style.display = history ? 'none' : 'block';
    document.getElementById('credit-history-tab').style.display = history ? 'block' : 'none';
    document.getElementById('credit-tab-account').classList.toggle('active', !history);
    document.getElementById('credit-tab-history').classList.toggle('active', history);

    // Save belongs to the Account tab; the history has nothing to save
    const save = document.querySelector('#credit-foot [form="credit-form"]');
    if (save) save.hidden = history;

    if (history) loadCreditHistory();
}

// the consequence of the typed figure, in words, before it is saved
function previewCreditLimit() {
    if (!creditCustomer) return;

    const form = document.getElementById('credit-form');
    const preview = document.getElementById('credit-preview');
    if (!form || !preview) return;

    const limit = Number(form.elements.creditLimit.value) || 0;
    const standing = form.elements.standing.value;
    const owed = Number(creditCustomer.current_credit) || 0;
    const room = limit - owed;
    const name = creditCustomer.customer_name;

    const days = Number(creditCustomer.oldest_debt_days) || 0;
    const overLimit = limit > 0 && owed > limit;
    const nearLimit = limit > 0 && owed >= limit * 0.75;

    let verdict;
    if (standing === 'Hold') {
        verdict = name + ' can take no new credit at all until the hold is lifted, ' +
            'whatever the limit says.';
    } else if (overLimit) {
        verdict = name + ' already owes <strong>' + peso(-room) + '</strong> more than this limit, ' +
            'so the account reads <strong>Hold</strong> and no further credit can be taken until ' +
            'it is paid down. The existing debt stands.';
    } else if (days > 90) {
        verdict = name + '\'s oldest unpaid sale is ' + days + ' days old, so the account reads ' +
            '<strong>Hold</strong> whatever the limit is set to. Chase the payment first.';
    } else if (room === 0) {
        verdict = name + ' is exactly at the limit and can take no more until something is paid.';
    } else if (standing === 'Watch' || days > 30 || nearLimit) {
        let why;
        if (standing === 'Watch') {
            why = 'you have flagged it.';
        } else if (days > 30) {
            why = 'the oldest unpaid sale is ' + days + ' days old.';
        } else {
            why = 'they owe ' + Math.round(owed / limit * 100) + '% of this limit.';
        }
        verdict = name + ' can take another <strong>' + peso(room) + '</strong> on account today, ' +
            'and the account reads <strong>Watch</strong>: ' + why;
    } else {
        verdict = name + ' can take another <strong>' + peso(room) + '</strong> on account today, ' +
            'in good standing.';
    }

    // the account's own late-payment rate, if one is typed
    const ownRaw = String(form.elements.penaltyRate.value).trim();
    const ownRate = ownRaw === '' ? null : Number(ownRaw);
    const shopRate = penaltyPolicy ? Number(penaltyPolicy.penalty_rate) : null;
    let penaltyWords = '';
    if (ownRate !== null && (!Number.isFinite(ownRate) || ownRate < 1 || ownRate > 3)) {
        penaltyWords = ' The late-payment rate must be from 1 to 3 percent a month.';
    } else if (ownRate !== null && (shopRate === null || ownRate !== shopRate)) {
        penaltyWords = ' A sale of theirs that falls overdue is charged <strong>' + penaltyRateWord(ownRate) +
            ' a month</strong>' + (shopRate !== null ? ' instead of the shop\'s ' + penaltyRateWord(shopRate) : '') + '.';
    }

    preview.innerHTML =
        '<span class="formula-line">' + peso(limit) + ' limit &minus; ' + peso(owed) +
        ' owed = <strong>' + (room >= 0 ? peso(room) + ' available' : peso(-room) + ' over') +
        '</strong></span>' +
        '<span class="formula-verdict">' + verdict + penaltyWords + '</span>';

    preview.classList.toggle('is-dynamic', standing !== 'Hold' && room > 0 && days <= 90);
    preview.classList.toggle('is-stop', standing === 'Hold' || overLimit || days > 90);
}

async function saveCreditLimit(event) {
    event.preventDefault();
    if (!creditCustomer) return;

    const form = event.target;
    const limit = Number(form.elements.creditLimit.value);
    const standing = form.elements.standing.value;
    const owed = Number(creditCustomer.current_credit) || 0;
    const name = creditCustomer.customer_name;

    const ownRaw = String(form.elements.penaltyRate.value).trim();
    const ownRate = ownRaw === '' ? null : Number(ownRaw);
    if (ownRate !== null && (!Number.isFinite(ownRate) || ownRate < 1 || ownRate > 3)) {
        notifyWarning('A late-payment rate is 1 to 3 percent a month. Leave it blank for the shop\'s rate.',
            'Not saved');
        form.elements.penaltyRate.focus();
        return;
    }

    // two changes worth stopping for: a Hold, and a limit under what is owed
    if (standing === 'Hold' && creditCustomer.standing !== 'Hold') {
        const yes = await askDanger(name + ' will not be able to take anything on account.', {
            title: 'Put this account on hold?',
            eyebrow: 'Credit Management',
            confirmLabel: 'Put the account on hold',
            detail: [
                'The till will refuse any new credit sale to them, whatever their limit is.',
                'The ' + peso(owed) + ' already owed is unaffected and still has to be collected.',
                'Any manager can lift the hold again.'
            ]
        });
        if (!yes) return;
    } else if (limit < owed) {
        const yes = await askConfirm(
            name + ' already owes ' + peso(owed) + ', which is more than this limit.', {
                title: 'Set the limit below what is owed?',
                eyebrow: 'Credit Management',
                confirmLabel: 'Set it anyway',
                detail: [
                    'This is how an account is stopped from growing without writing off the debt.',
                    'They can take nothing further until the balance falls under the new limit.'
                ]
            });
        if (!yes) return;
    }

    try {
        const response = await apiSaveCreditLimit(creditCustomer.customer_id, {
                creditLimit: limit,
                standing: standing,
                penaltyRate: ownRate,
                notes: form.elements.notes.value.trim()
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message, 'Credit terms saved');
        closeModal('credit-modal');

        const panel = getDataPanel('mgr-credit');
        if (panel && panel.state === 'ready') await panel.refresh();
        loadPenaltyPolicy();   // the own-rate count on the strip
    } catch (error) {
        notifyOffline();
    }
}

// ---------- what they bought, beside what they paid ----------
let creditHistory = null;

async function loadCreditHistory() {
    const box = document.getElementById('credit-history');
    if (!box || !creditCustomer) return;

    if (creditHistory) { renderCreditHistory(creditHistory); return; }

    box.innerHTML = '<p class="detail-note">Reading this customer\'s history...</p>';

    try {
        creditHistory = await apiGetCustomerHistory(creditCustomer.customer_id);
        renderCreditHistory(creditHistory);
    } catch (error) {
        box.innerHTML = '<p class="detail-note detail-warn">That history could not be read.</p>';
    }
}

// purchases beside payments, so both get read before extending anything;
// each is paged with Previous and Next rather than scrolled
function renderCreditHistory(data) {
    const box = document.getElementById('credit-history');
    if (!box) return;

    const purchases = pagedTable('mgr-purchases', ['Date', 'Sale', 'Amount', 'Balance'],
        data.purchases.map((p) => [
            escapeHtml(String(p.sale_date).slice(0, 10)),
            '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
            peso(p.final_amount) +
                (Number(p.penalty_amount) > 0
                    ? '<span class="cell-sub">+ ' + peso(p.penalty_amount) + ' penalty (' +
                      penaltyRateWord(p.penalty_rate) + ' &times; ' + p.penalty_months +
                      (Number(p.penalty_months) === 1 ? ' month' : ' months') + ')</span>' : ''),
            Number(p.balance_due) > 0
                ? '<span class="cell-due">' + peso(p.balance_due) + '</span>'
                : '<span class="muted">Paid</span>'
        ]), [2, 3], { empty: 'Nothing bought yet.', noun: 'sale' });

    const payments = pagedTable('mgr-payments', ['Date', 'Amount', 'How', 'Against'],
        data.payments.map((p) => [
            escapeHtml(String(p.payment_date).slice(0, 10)),
            peso(p.amount),
            escapeHtml(p.payment_method),
            p.sale_id ? '#' + p.sale_id : '<span class="muted">On account</span>'
        ]), [1], { empty: 'No payments recorded.', noun: 'payment' });

    let requests;
    if (data.requests.length === 0) {
        requests = '';
    } else {
        requests = '<div class="history-column history-full">' +
              '<h4 class="history-head">Extension Requests</h4>' +
              pagedTable('mgr-requests', ['Date Requested', 'From', 'To', 'Outcome'],
                data.requests.map((r) => [
                    escapeHtml(String(r.created_at).slice(0, 10)),
                    peso(r.previous_limit),
                    peso(r.requested_limit),
                    escapeHtml(r.status) + (r.decided_by ? ' <span class="muted">' +
                        escapeHtml(r.decided_by) + '</span>' : '')
                ]), [1, 2], { empty: 'No requests yet.', noun: 'request' }) + '</div>';
    }

    box.innerHTML =
        '<div class="history-column">' +
            '<h4 class="history-head">Purchase History' +
            '<span class="history-total">' + peso(data.credit.total_purchase) + '</span></h4>' +
            purchases +
        '</div>' +
        '<div class="history-column">' +
            '<h4 class="history-head">Credit &amp; Payments' +
            '<span class="history-total">' +
                (Number(data.credit.current_credit) > 0
                    ? '<span class="cell-due">' + peso(data.credit.current_credit) + ' balance</span>'
                    : 'No balance') +
            '</span></h4>' +
            payments +
        '</div>' +
        requests;
}

// ---------- deciding an extension ----------
function openCreditRequest(requestId) {
    const panel = getDataPanel('mgr-requests');
    creditRequest = panel ? panel.find(requestId, 'request_id') : null;
    if (!creditRequest) return;

    const r = creditRequest;
    const decided = r.status !== 'Pending';

    document.getElementById('decide-name').textContent = r.customer_name;
    document.getElementById('decide-sub').textContent = decided
        ? r.status + (r.decided_by ? ' by ' + r.decided_by : '')
        : 'Waiting for a decision';
    document.getElementById('decide-avatar').textContent = initialsOf(r.customer_name);

    document.getElementById('decide-facts').innerHTML =
        detailField('Date Requested', escapeHtml(String(r.created_at).slice(0, 16))) +
        detailField('Raised By', escapeHtml(r.requested_by || 'Unknown')) +
        detailField('Current Credit Limit', peso(r.previous_limit)) +
        detailField('Requested Limit', '<strong>' + peso(r.requested_limit) + '</strong>') +
        detailField('Balance', '<span class="' +
            (Number(r.current_credit) > 0 ? 'cell-due' : '') + '">' + peso(r.current_credit) + '</span>') +
        detailField('Standing', standingBadge(r.standing || 'Good', r.standing_reason)) +
        detailField('Status', escapeHtml(r.status)) +
        detailField('Decided', r.decided_at
            ? escapeHtml(String(r.decided_at).slice(0, 16))
            : '<span class="muted">Not yet</span>');

    const reason = document.getElementById('decide-reason');

    if (r.reason) {
        reason.textContent = 'Reason given: ' + r.reason;
    } else {
        reason.textContent = 'No reason was given with this request.';
    }

    const note = document.getElementById('decide-note');
    note.value = r.decision_note || '';
    note.disabled = decided;

    // a decision already made stands; the reason is what an audit keeps
    // a decided request has nothing left to press: the x closes it
    const actions = document.getElementById('decide-actions');
    actions.hidden = decided;
    actions.innerHTML = decided ? ''
        : '<button type="button" class="btn btn-ghost" onclick="closeModal(\'decide-modal\')">Cancel</button>' +
          '<button type="button" class="btn btn-danger" onclick="decideCreditRequest(false)">Decline</button>' +
          '<button type="button" class="btn btn-success" onclick="decideCreditRequest(true)">Approve</button>';

    showModal('decide-modal');
}

async function decideCreditRequest(approve) {
    if (!creditRequest) return;

    const r = creditRequest;
    const note = document.getElementById('decide-note').value.trim();

    // declining says why or it does not happen
    if (!approve && note === '') {
        notifyWarning('Say why, so whoever raised it knows what to tell the customer.',
            'A declined request needs a reason');
        document.getElementById('decide-note').focus();
        return;
    }

    let yes;
    if (approve) {
        yes = await askConfirm(
                r.customer_name + ' may owe up to ' + peso(r.requested_limit) +
                ', up from ' + peso(r.previous_limit) + '.',
                {
                    title: 'Approve this extension?',
                    eyebrow: 'Credit Management',
                    confirmLabel: 'Approve and raise the limit',
                    detail: [
                        'The limit rises immediately and the till will accept the sale.',
                        'They currently owe ' + peso(r.current_credit) + '.',
                        'Lowering it again later is a separate decision on the account.'
                    ]
                });
    } else {
        yes = await askConfirm(
                'The request for ' + r.customer_name + ' will be refused and their limit stays at ' +
                peso(r.previous_limit) + '.',
                {
                    title: 'Decline this request?',
                    eyebrow: 'Credit Management',
                    confirmLabel: 'Decline it',
                    tone: 'danger'
                });
    }

    if (!yes) return;

    try {
        const response = await apiDecideCreditRequest(r.request_id, approve, note);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message, approve ? 'Extension approved' : 'Request declined');
        closeModal('decide-modal');

        for (const key of ['mgr-requests', 'mgr-credit']) {
            const panel = getDataPanel(key);
            if (panel && panel.state === 'ready') await panel.refresh();
        }
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// DELIVERIES
// ==========================================
const FULFILMENT_TONE = {
    'Completed': 'badge-success',
    'Pending Cash Collection': 'badge-warning',
    'Out for Delivery': 'badge-warning',
    'In Transit': 'badge-warning',
    'Pending': 'badge-warning',
    'Delayed': 'badge-warning',
    'Failed': 'badge-danger'
};

function buildDeliveryPanel() {
    createDataPanel({
        key: 'mgr-deliveries',
        tableId: 'deliveries-table',
        columns: 7,
        pagerId: 'deliveries-pager',
        idField: 'delivery_id',
        filters: { state: 'all' },
        gate: {
            title: 'Deliveries not loaded',
            text: 'Press Load Data for every delivery on record, or filter by fulfilment first.',
            button: 'Load Data'
        },
        load: () => apiGetDeliveries(),
        match: (d, query) => prefixMatch([d.customer_name, d.driver_name, d.delivery_address], query),
        filter: (d, filters) => filters.state === 'all' || d.fulfilment_state === filters.state,
        onLoaded: (rows) => renderTrackLegend(rows),
        renderRow: (d, index) => {
            const tone = FULFILMENT_TONE[d.fulfilment_state] || 'badge-neutral';
            const owed = Number(d.balance_due) || 0;

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openDeliveryDetail(' + d.delivery_id + ')">' +
                '<td class="cell-id">#' + d.delivery_id + '</td>' +
                '<td class="cell-name">' + escapeHtml(d.customer_name) + '</td>' +
                '<td>' + escapeHtml(d.delivery_address) + '</td>' +
                '<td>' + escapeHtml(d.driver_name) + '</td>' +
                '<td class="cell-id">' + escapeHtml(d.scheduled_date || 'Not set') + '</td>' +
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) + '</td>' +
                '<td><span class="badge ' + tone + '">' + escapeHtml(d.fulfilment_state) + '</span></td></tr>';
        }
    });
}

// stage counts above the table; cash collection leads
function renderTrackLegend(rows) {
    const legend = document.getElementById('track-legend');
    if (!legend) return;

    const states = ['Pending Cash Collection', 'Completed', 'Out for Delivery',
                    'In Transit', 'Pending', 'Delayed', 'Failed'];

    legend.innerHTML = states.map((state) => {
        const count = rows.filter((d) => d.fulfilment_state === state).length;
        if (count === 0) return '';

        const alert = state === 'Pending Cash Collection' ? ' track-chip-alert' : '';
        return '<button type="button" class="track-chip' + alert + '" ' +
            'onclick="filterDeliveriesBy(\'' + state + '\')">' +
            '<span class="track-count">' + count + '</span>' + escapeHtml(state) + '</button>';
    }).join('');
}

function filterDeliveriesBy(state) {
    const select = document.getElementById('deliveries-state');
    if (select) select.value = state;
    dataPanelFilter('mgr-deliveries', 'state', state);
}

// ==========================================
// RECORDS
// ==========================================
const RECORD_COLUMNS = {
    supplier: [['name', 'Supplier'], ['contact_person', 'Contact'], ['contact_number', 'Number'], ['email', 'Email'], ['product_count', 'Products']],
    customer: [['name', 'Customer'], ['phone', 'Phone'], ['purchase_count', 'Purchases'], ['credit_limit', 'Credit Limit'], ['current_credit', 'Balance']],
    product:  [['name', 'Product'], ['category_name', 'Category'], ['brand_name', 'Brand'], ['price', 'Price'], ['quantity_in_stock', 'On Hand']],
    category: [['name', 'Category'], ['product_count', 'Products'], ['total_stock', 'Total Stock']],
    unit:     [['name', 'Unit'], ['product_count', 'Products']]
};
const MONEY_FIELDS = ['price', 'credit_limit', 'current_credit', 'total_purchase', 'stock_value'];

const RECORD_TITLES = {
    supplier: 'Suppliers', customer: 'Customers', product: 'Products',
    category: 'Categories', unit: 'Units'
};

// the kind of record is a screen in the strip
function showRecordType(type, event) {
    if (!RECORD_COLUMNS[type]) type = 'supplier';
    const changed = type !== recordType;
    recordType = type;

    showManagerPanel('panel-records', 'Records', event);

    const title = document.getElementById('records-title');
    if (title) title.textContent = RECORD_TITLES[type];


    const card = document.getElementById('panel-records');
    if (card) card.dataset.view = type;
    markPanelLinks('panel-records');

    writeRecordHeaders();
    syncRecordAddButton();
    if (changed) fillRecordSort();

    const panel = getDataPanel('mgr-records');
    if (!panel || !changed) return;

    // a table already open loads the new kind at once; a closed one stays closed
    if (panel.state === 'ready') panel.open();
    else panel.reset();
}

function writeRecordHeaders() {
    const table = document.getElementById('records-table');
    if (!table) return;

    const columns = RECORD_COLUMNS[recordType];
    table.querySelector('thead tr').innerHTML =
        columns.map((column) => '<th>' + column[1] + '</th>').join('');

    const panel = getDataPanel('mgr-records');
    if (panel) panel.config.columns = columns.length;
}

function buildRecordsPanel() {
    createDataPanel({
        key: 'mgr-records',
        tableId: 'records-table',
        columns: 5,
        pagerId: 'records-pager',
        gate: {
            title: 'No records loaded',
            text: 'Pick a kind of record above, then press Load Data.',
            button: 'Load Data'
        },
        filters: { sort: 'name-asc' },
        load: () => apiGetRecords(recordType),
        match: (row, query) => prefixMatch(Object.values(row), query),
        sort: (rows, filters) => sortRecordRows(rows, filters.sort),
        renderRow: (row, index) => {
            const columns = RECORD_COLUMNS[recordType];

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openRecordDetail(' + index + ')">' +
                columns.map((column, position) => {
                    const value = row[column[0]];
                    const money = MONEY_FIELDS.indexOf(column[0]) !== -1;
                    let shown;
                    if (money) {
                        shown = peso(value);
                    } else if (value === null || value === undefined || value === '') {
                        shown = '<span class="muted">Not set</span>';
                    } else {
                        shown = escapeHtml(value);
                    }

                    let style;
                    if (position === 0) {
                        style = 'cell-name';
                    } else if (typeof value === 'number' || money) {
                        style = 'cell-num';
                    } else {
                        style = '';
                    }

                    return '<td class="' + style + '">' + shown + '</td>';
                }).join('') + '</tr>';
        }
    });
}

// The Sort box follows the kind of record: by name either way, then by each
// figure the table shows (most first).
function fillRecordSort() {
    const select = document.getElementById('records-sort');
    if (!select) return;

    const options = [['name-asc', 'Name, A to Z'], ['name-desc', 'Name, Z to A']];
    RECORD_COLUMNS[recordType].slice(1).forEach((column) => {
        if (RECORD_NUMERIC.indexOf(column[0]) !== -1) {
            options.push([column[0] + '-desc', column[1] + ', highest first']);
            options.push([column[0] + '-asc', column[1] + ', lowest first']);
        }
    });

    select.innerHTML = options.map((option) =>
        '<option value="' + option[0] + '">' + escapeHtml(option[1]) + '</option>').join('');
    select.value = 'name-asc';
    // set without loading: a closed table stays closed
    const panel = getDataPanel('mgr-records');
    if (panel) panel.setFilter('sort', 'name-asc');
}

// the columns that hold a figure, and so can be sorted by size
const RECORD_NUMERIC = ['product_count', 'purchase_count', 'credit_limit', 'current_credit',
                        'price', 'quantity_in_stock', 'total_stock'];

function sortRecordRows(rows, order) {
    const value = String(order || 'name-asc');
    const descending = value.endsWith('-desc');
    const field = value.replace(/-(asc|desc)$/, '');
    const key = field === 'name' ? 'name' : field;

    return rows.sort((a, b) => {
        let result;
        if (key === 'name') {
            result = String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
        } else {
            result = (Number(a[key]) || 0) - (Number(b[key]) || 0) ||
                     String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
        }
        return descending ? -result : result;
    });
}

// ---------- adding a supplier, a category or a unit (the manager's alone) ----------
const RECORD_ADDABLE = {
    supplier: { title: 'Add Supplier', label: 'Company name', max: 100 },
    category: { title: 'Add Category', label: 'Category name', max: 50 },
    unit:     { title: 'Add Unit', label: 'Unit name', max: 20 }
};

// the Add button names the kind on screen, and goes for the kinds kept elsewhere
function syncRecordAddButton() {
    const button = document.getElementById('records-add-btn');
    if (!button) return;
    const kind = RECORD_ADDABLE[recordType];
    button.hidden = !kind;
    if (kind) button.textContent = kind.title;
}

function openAddRecord() {
    const kind = RECORD_ADDABLE[recordType];
    const form = document.getElementById('record-add-form');
    if (!kind || !form) return;

    form.reset();
    const phone = document.getElementById('record-add-number');
    if (phone) phoneFill(phone, '');

    document.getElementById('record-add-title').textContent = kind.title;
    document.getElementById('record-add-name-label').innerHTML =
        escapeHtml(kind.label) + ' <span class="req">*</span>';
    document.getElementById('record-add-name').maxLength = kind.max;
    document.getElementById('record-add-supplier').hidden = recordType !== 'supplier';

    showModal('record-add-modal');
    setTimeout(() => document.getElementById('record-add-name').focus(), 60);
}

async function saveAddRecord(event) {
    event.preventDefault();
    const kind = RECORD_ADDABLE[recordType];
    const form = event.target;
    if (!kind) return;

    const name = form.elements.name.value.trim();
    if (name === '') {
        notifyWarning(kind.label + ' is required.', 'Fill in the form');
        form.elements.name.focus();
        return;
    }

    let data = { name: name };
    if (recordType === 'supplier') {
        const phoneProblem = form.elements.contactNumber.value.trim() === ''
            ? null : phoneComplaint(form.elements.contactNumber);
        if (phoneProblem) {
            notifyWarning(phoneProblem, 'Check the phone number');
            form.elements.contactNumber.focus();
            return;
        }
        data = {
            name: name,
            contactPerson: form.elements.contactPerson.value.trim(),
            contactNumber: phoneToStore(form.elements.contactNumber),
            email: form.elements.email.value.trim(),
            address: form.elements.address.value.trim()
        };
    }

    const button = document.getElementById('record-add-save');
    if (button) button.disabled = true;
    try {
        const response = await apiAddRecord(recordType, data);
        const body = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Not added');
            return;
        }

        notifySuccess(body.message, kind.title.replace('Add ', '') + ' added');
        closeModal('record-add-modal');

        const panel = getDataPanel('mgr-records');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    } finally {
        if (button) button.disabled = false;
    }
}

// ==========================================
// ARCHIVES
// ==========================================
function buildArchivePanel() {
    createDataPanel({
        key: 'mgr-archives',
        tableId: 'archives-table',
        columns: 5,
        pagerId: 'archives-pager',
        filters: { module: 'all' },
        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for everything archived across all modules.',
            button: 'Load Data'
        },
        load: () => apiGetArchives(),
        match: (a, query) => prefixMatch([a.record_name, a.detail, a.module], query),
        filter: (a, filters) => filters.module === 'all' || a.module === filters.module,
        onLoaded: (rows) => fillCountedOptions('archives-module', rows.map((a) => a.module), 'Every module'),
        renderRow: (a, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openArchiveEntry(' + index + ')">' +
            '<td>' + statusBadge(a.module) + '</td>' +
            '<td class="cell-name">' + escapeHtml(a.record_name) + '</td>' +
            '<td>' + escapeHtml(a.detail || '') + '</td>' +
            '<td class="cell-id">' + escapeHtml(a.archived_at || 'Unknown') + '</td>' +
            '<td>' + escapeHtml(a.archived_by || 'Not recorded') + '</td></tr>'
    });
}

// restoring puts a record back into circulation, so the row opens it first
function openArchiveEntry(index) {
    const panel = getDataPanel('mgr-archives');
    const entry = panel ? panel.visible[index] : null;
    if (!entry) return;

    const body = '<div class="detail-grid">' +
        detailField('Module', statusBadge(entry.module)) +
        detailField('Record', escapeHtml(entry.record_name)) +
        detailField('Detail', escapeHtml(entry.detail || 'None recorded')) +
        detailField('Archived On', escapeHtml(entry.archived_at || 'Not recorded')) +
        detailField('Archived By', escapeHtml(entry.archived_by || 'Not recorded')) +
        '</div>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-success" onclick="restoreArchive(\'' +
            entry.module + '\', ' + entry.record_id + ')">Restore This Record</button>' +
        '</div>';

    openDetailModal(entry.record_name, entry.module + ' · archived',
        initialsOf(entry.record_name), [{ label: 'Archived Record', body: body }]);
}

async function restoreArchive(module, recordId) {
    const yes = await askConfirm(
        'This ' + module.toLowerCase() + ' record goes back into circulation and appears on the ' +
        'normal lists again.',
        {
            title: 'Restore this record?',
            eyebrow: 'Archives',
            confirmLabel: 'Restore the record',
            detail: [
                'It reappears everywhere its module lists records.',
                'Anything that was hidden because it was archived becomes visible again.'
            ]
        });

    if (!yes) return;

    try {
        const response = await apiRestoreArchive(module, recordId);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess('The record is back in circulation.', 'Record restored');
        closeModal('detail-modal');

        const panel = getDataPanel('mgr-archives');
        if (panel) await panel.refresh();
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// POPUP BUILDERS, ONE PER MODULE
// ==========================================
async function openSaleDetail(saleId) {
    try {
        const data = await apiGetSale(saleId);
        const s = data.sale;

        const summary = '<div class="detail-grid">' +
            detailField('Sale ID', '#' + s.sale_id) +
            detailField('Date', escapeHtml(s.sale_date)) +
            detailField('Customer', escapeHtml(s.customer_name)) +
            detailField('Phone', s.customer_phone ? escapeHtml(s.customer_phone) : '<span class="muted">Not set</span>') +
            detailField('Cashier', escapeHtml(s.cashier_name)) +
            detailField('Payment Method', escapeHtml(s.payment_method)) +
            detailField('Payment Status', statusBadge(s.payment_status)) +
            detailField('Reference No', s.reference_no ? escapeHtml(s.reference_no) : '<span class="muted">None</span>') +
            '</div>';

        const balance = saleAmountDue(s) - Number(s.amount_paid);
        const units = pieceCount(data.items);
        const totals = '<div class="detail-grid">' +
            detailField('Items Purchased', units + (data.items.length !== units
                ? ' (' + data.items.length + (data.items.length === 1 ? ' line)' : ' lines)') : '')) +
            detailField('Gross Total', peso(s.total_amount)) +
            detailField('Discount', peso(s.discount)) +
            (Number(s.penalty_amount) > 0
                ? detailField('Late Penalty', '<span class="cell-due">' + peso(s.penalty_amount) + '</span> ' +
                    '<span class="muted">' + penaltyRateWord(s.penalty_rate) + ' a month for ' + s.penalty_months +
                    (Number(s.penalty_months) === 1 ? ' month' : ' months') + ' overdue, last charged ' +
                    escapeHtml(String(s.penalty_applied_at || '').slice(0, 10)) + '</span>')
                : '') +
            detailField('Amount Due', peso(saleAmountDue(s))) +
            detailField('Amount Paid', peso(s.amount_paid)) +
            detailField('Change Given', peso(s.change_given)) +
            detailField('Balance Due', '<span class="' + (balance > 0 ? 'cell-due' : '') + '">' + peso(balance) + '</span>') +
            '</div>';

        const items = detailTable(['Product', 'Qty', 'Unit Price', 'Subtotal'],
            data.items.map((it) => [
                escapeHtml(it.product_name),
                escapeHtml(qtyText(it.quantity, it.unit_name)),
                peso(it.unit_price),
                peso(it.subtotal)
            ]), [1, 2, 3]);

        const payments = detailTable(['Date', 'Amount', 'Method', 'Reference', 'Received By'],
            data.payments.map((p) => [
                escapeHtml(String(p.payment_date).slice(0, 16)),
                peso(p.amount),
                escapeHtml(p.payment_method),
                p.reference_no ? escapeHtml(p.reference_no) : '<span class="muted">None</span>',
                escapeHtml(p.received_by || 'Unknown')
            ]), [1]);

        // a sale can be voided on the day it was made; the machine's own calendar, not UTC
        const now = new Date();
        const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') +
            '-' + String(now.getDate()).padStart(2, '0');
        const saleDay = String(s.sale_date).slice(0, 10);
        let voidBlock;
        if (s.is_archived) {
            voidBlock = '<p class="detail-note detail-warn">This sale was voided' +
                  (s.archived_at ? ' on ' + escapeHtml(String(s.archived_at).slice(0, 16)) : '') +
                  '. It counts for nothing, and its stock went back on the shelf.</p>';
        } else if (saleDay === today) {
            voidBlock = '<div class="detail-actions">' +
                  '<button type="button" class="btn btn-danger" onclick="voidSale(' + s.sale_id + ')">Void this sale</button>' +
                  '</div>';
        } else {
            voidBlock = '<p class="detail-note">A sale can only be voided on the day it was made. ' +
                  'Correct this one with a return or a refund.</p>';
        }

        const pages = [
            { label: 'Summary', body: summary + voidBlock },
            { label: 'Totals', body: totals },
            { label: 'Items (' + data.items.length + ')', body: items },
            { label: 'Payments (' + data.payments.length + ')', body: payments }
        ];

        // paid by QR code: each code's status and PayMongo's reference
        const qrPaid = data.qrPayments || [];
        if (qrPaid.length > 0) {
            pages.push({ label: 'QR Payment' + (qrPaid.length === 1 ? '' : 's (' + qrPaid.length + ')'),
                         body: qrPaymentsOfSaleHtml(qrPaid) });
        }

        if (data.delivery) {
            const d = data.delivery;
            const owed = saleAmountDue(s) - Number(s.amount_paid);
            let state;
            if (d.status !== 'Delivered') {
                state = d.status;
            } else if (owed > 0) {
                state = 'Pending Cash Collection';
            } else {
                state = 'Completed';
            }

            pages.push({ label: 'Delivery', body: '<div class="detail-grid">' +
                detailField('Delivery ID', '#' + d.delivery_id) +
                detailField('Delivery Status', statusBadge(d.status)) +
                detailField('Fulfilment', '<span class="badge ' +
                    (FULFILMENT_TONE[state] || 'badge-neutral') + '">' + escapeHtml(state) + '</span>') +
                detailField('Driver', escapeHtml(d.driver_name || 'Unassigned')) +
                detailField('Scheduled', escapeHtml(d.scheduled_date || 'Not set')) +
                detailField('Delivered At', d.delivered_at ? escapeHtml(d.delivered_at) : '<span class="muted">Not yet</span>') +
                detailField('Address', escapeHtml(d.delivery_address)) +
                '</div>' +
                (owed > 0 && d.status === 'Delivered'
                    ? '<p class="detail-note detail-warn">The goods have arrived and ' + peso(owed) +
                      ' is still owed. This delivery becomes Completed as soon as the payment is recorded.</p>'
                    : '') +
                (d.remarks ? '<p class="detail-note">' + escapeHtml(d.remarks) + '</p>' : '') });
        }

        openDetailModal('Sale #' + s.sale_id, s.customer_name + ' · ' + s.payment_method,
            'S' + s.sale_id, pages);
    } catch (error) {
        notifyError('That sale could not be opened.', 'Nothing to show');
    }
}

// Voiding a sale archives it; the database holds the rules (same day, goods
// not out for delivery, stock returned).
async function voidSale(saleId) {
    const yes = await askDanger(
        'Sale #' + saleId + ' is struck off as if it had not happened.',
        {
            title: 'Void this sale?',
            eyebrow: 'Sales',
            confirmLabel: 'Void the sale',
            detail: [
                'It reads Voided everywhere and counts for nothing.',
                'Every item on it goes back on the shelf, with a line in the stock log.',
                'A delivery booked for it and not yet on the road is cancelled with it.',
                'Money already taken is not refunded by this; hand it back at the counter.'
            ]
        });

    if (!yes) return;

    const result = await apiArchiveSale(saleId);
    if (!result) return;

    closeModal('detail-modal');
    notifySuccess('Sale #' + saleId + ' is voided and its stock is back on the shelf.', 'Sale voided');

    for (const key of ['mgr-sales', 'mgr-archives', 'mgr-deliveries']) {
        const panel = getDataPanel(key);
        if (panel && panel.state === 'ready') await panel.refresh();
    }
}

// A closed delivery can be put away before the ninety-day sweep; the
// database refuses a live one.
async function archiveDelivery(deliveryId) {
    const yes = await askConfirm(
        'Delivery #' + deliveryId + ' leaves the tracking list and goes to the Archives screen.',
        {
            title: 'Archive this delivery?',
            eyebrow: 'Deliveries',
            confirmLabel: 'Archive it',
            detail: [
                'It can be restored from Archives.',
                'The sale it belongs to is not touched.',
                'The sweep would archive it on its own ninety days after it closed.'
            ]
        });

    if (!yes) return;

    const result = await apiArchiveDelivery(deliveryId);
    if (!result) return;

    closeModal('detail-modal');
    notifySuccess('Delivery #' + deliveryId + ' is archived.', 'Delivery archived');

    for (const key of ['mgr-deliveries', 'mgr-archives']) {
        const panel = getDataPanel(key);
        if (panel && panel.state === 'ready') await panel.refresh();
    }
}

function openStockDetail(productId) {
    const p = (stocksCache || []).find((item) => item.product_id === productId);
    if (!p) return;

    const stock = '<div class="detail-grid">' +
        detailField('Product ID', '#' + p.product_id) +
        detailField('Product', escapeHtml(p.product_name)) +
        detailField('On Hand', p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '')) +
        detailField('Reorder Point', p.effective_rop + ' ' + modeBadge(p)) +
        detailField('Stock Status', statusBadge(p.stock_status)) +
        detailField('Suggested Order', p.suggested_order + ' ' + escapeHtml(p.unit_name || '')) +
        '</div>';

    // the formula written out for this product
    const daily = Number(p.avg_daily_sales) || 0;
    const reorder = '<div class="detail-grid">' +
        detailField('Sold Recently', p.units_sold_window + ' ' + escapeHtml(p.unit_name || '') +
            ' over ' + p.window_days + ' days') +
        detailField('Average Daily Sales', daily.toFixed(3)) +
        detailField('Lead Time', p.lead_time_days + ' days') +
        detailField('Safety Stock', String(p.safety_stock)) +
        detailField('Calculated Point', String(p.calculated_rop)) +
        detailField('Manual Point', String(p.reorder_point)) +
        detailField('In Use', p.effective_rop + ' ' + modeBadge(p)) +
        detailField('Days of Cover', p.days_of_cover === null
            ? '<span class="muted">Nothing sold in the window</span>'
            : Number(p.days_of_cover).toFixed(1) + ' days') +
        '</div>' +
        '<p class="detail-note">(' + daily.toFixed(3) + ' a day &times; ' + p.lead_time_days +
        ' days) + ' + p.safety_stock + ' safety = ' + p.calculated_rop + '</p>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-accent" onclick="openReorderPolicy(' + p.product_id + ')">' +
        'Change Reorder Policy</button></div>';

    const pricing = '<div class="detail-grid">' +
        detailField('Unit Price', peso(p.price) +
            (p.unit_name ? ' <span class="muted">per ' + escapeHtml(p.unit_name) + '</span>' : '')) +
        detailField('Stock Value', peso(p.stock_value)) +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('Brand', escapeHtml(p.brand_name || 'No brand')) +
        detailField('Product Status', statusBadge(p.status)) +
        detailField('Last Updated', escapeHtml(p.last_updated || 'Never')) +
        '</div>' +
        '<p class="detail-note">A new price reaches the till from the next sale on. Sales already ' +
        'rung up keep the price they were sold at.</p>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-accent" onclick="changePrice(' + p.product_id + ')">' +
        'Change Price</button></div>';

    const supplier = '<div class="detail-grid">' +
        detailField('Supplier', escapeHtml(p.supplier_name || 'No supplier')) +
        detailField('Contact Person', escapeHtml(p.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(p.contact_number || 'Not set')) +
        '</div>';

    openDetailModal(p.product_name, (p.category_name || 'Uncategorised') + ' · ' + p.stock_status,
        initialsOf(p.product_name), [
            { label: 'Stock', body: stock },
            { label: 'Reorder Point', body: reorder },
            { label: 'Pricing', body: pricing },
            { label: 'Supplier', body: supplier }
        ]);
}

function openDeliveryDetail(deliveryId) {
    const panel = getDataPanel('mgr-deliveries');
    showDeliveryRecord(panel ? panel.find(deliveryId, 'delivery_id') : null, true, true);
}

async function openRecordDetail(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    if (!row) return;

    const type = recordType;
    const keys = Object.keys(row).filter((key) => key !== 'id' && key !== 'name');
    let body = '<div class="detail-grid detail-grid-3">' +
        detailField('Record ID', '#' + row.id) +
        detailField('Name', escapeHtml(row.name)) +
        keys.map((key) => detailField(prettyLabel(key), fieldValue(key, row[key]))).join('') +
        '</div>';

    // a category lists the products filed under it (names are unique)
    if (type === 'category') {
        try {
            const products = (await apiGetRecords('product'))
                .filter((p) => p.category_name === row.name);
            body += '<h4 class="detail-subhead">Products in this category (' + products.length + ')</h4>' +
                detailTable(['Product', 'Brand', 'Supplier', 'Price', 'On Hand'],
                    products.map((p) => [
                        escapeHtml(p.name),
                        p.brand_name ? escapeHtml(p.brand_name) : '<span class="muted">Not set</span>',
                        p.supplier_name ? escapeHtml(p.supplier_name) : '<span class="muted">Not set</span>',
                        peso(p.price),
                        escapeHtml(qtyText(p.quantity_in_stock, p.unit_name))
                    ]), [3, 4]);
        } catch (error) {
            body += '<p class="detail-note detail-warn">The products in this category could not be loaded.</p>';
        }
    }

    openDetailModal(row.name, prettyLabel(type) + ' record', initialsOf(row.name),
        [{ label: 'Details', body: body }], null, { wide: true });
}

// reached from the Repeat Customers report, which only knows a customer id
async function openCustomerDetail(customerId) {
    try {
        const rows = await apiGetRecords('customer');
        const index = rows.findIndex((row) => row.id === customerId);
        if (index === -1) return;

        const customer = rows[index];
        const keys = Object.keys(customer).filter((key) => key !== 'id' && key !== 'name');

        openDetailModal(customer.name, 'Customer record', initialsOf(customer.name), [{
            label: 'Customer',
            body: '<div class="detail-grid">' +
                detailField('Record ID', '#' + customer.id) +
                detailField('Name', escapeHtml(customer.name)) +
                keys.map((key) => detailField(prettyLabel(key), fieldValue(key, customer[key]))).join('') +
                '</div>'
        }]);
    } catch (error) {
        notifyError('That customer record could not be opened.', 'Nothing to show');
    }
}

// ==========================================
// MANAGER PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('manager.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildIncomePanels();
        buildReportPanels();
        buildSalesPanel();
        buildQrPaymentsPanel({ key: 'mqr', prefix: 'mqr', openSale: openSaleDetail, byStaff: true });
        buildStockPanels();
        buildStockMovesPanel();
        buildDeliveryPanel();
        buildManagerPurchaseOrderPanel();
        buildCreditPanels();
        buildRecordsPanel();
        buildArchivePanel();

        // the schedule follows what the administrator switched on for managers
        configureDeliverySchedule({ showPanel: (panelId, title) => showManagerPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showReports(), onApply: syncViewNavs });

        // Go to, on an opened alert: the screen that alert is about
        const stockAlert = { label: 'Reorder Alerts', panelId: 'panel-stocks',
                             open: () => showReorderAlerts(), key: 'mgr-reorder', searchId: 'reorder-search' };
        const returnsAlert = { label: 'Activity Log', panelId: 'panel-reports',
                               open: () => showReport('report-all'), key: 'mgr-all' };
        configureNotificationTargets({
            'Low Stock':        stockAlert,
            'Out of Stock':     stockAlert,
            'Purchase Order':   { label: 'Purchase Orders', panelId: 'panel-po-history',
                                  open: () => showPurchasing(), key: 'mgr-po' },
            'Damage Report':    returnsAlert,
            'Refund Report':    returnsAlert,
            'Stock Adjustment': { label: 'Stock Movements', panelId: 'panel-stocks',
                                  open: () => showStockView('stock-moves'), key: 'mgr-stock-moves' },
            'Delivery':         { label: 'Deliveries', panelId: 'panel-deliveries',
                                  open: () => showDeliveries(), key: 'mgr-deliveries' },
            'Credit Request':   { label: 'Extension Requests', panelId: 'panel-credit-requests',
                                  open: () => showCreditRequests(), key: 'mgr-requests' },
            'Late Penalty':     { label: 'Receivables', panelId: 'panel-reports',
                                  open: () => showReport('report-unpaid'), key: 'mgr-unpaid' }
        });

        writeRecordHeaders();
        syncRecordAddButton();
        fillRecordSort();
        limitDatesToToday(['income-from', 'income-to', 'sales-from', 'sales-to']);
        renderIncomeRanges();
        applyExportPermissions();

        document.addEventListener('datapanel:change', syncExportButtons);
        syncExportButtons();

        showReports();
        loadNotifications();
    });
}
