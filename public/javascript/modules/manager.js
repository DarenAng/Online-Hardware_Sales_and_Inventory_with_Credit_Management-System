// manager.js -- manager
// Loaded by: manager-dashboard.html

let recordType = 'supplier';
let archiveFilter = 'All';
let incomeRange = { name: 'monthly', from: null, to: null };
let incomeData = null;
let policyProduct = null;

// ==========================================
// PANEL SWITCHING
// ==========================================
function showManagerPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });

    markPanelLinks(panelId);
    unfoldMenuFor(panelId);

    const heading = document.getElementById('manager-page-title');
    if (heading) heading.textContent = title;

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');

    window.scrollTo(0, 0);
}

// Every folding heading starts folded and opens when its heading is pressed
// or a screen listed in it opens. The list is found from the menu itself.
function unfoldMenuFor(panelId) {
    const link = document.querySelector(
        '.sidebar-nav li[data-sidebar-dropdown] > .nav-sub a[data-panel-link="' + panelId + '"]');
    if (!link) return;

    const item = link.closest('li[data-sidebar-dropdown]');
    const heading = item.querySelector(':scope > .nav-parent');
    const list = item.querySelector(':scope > .nav-sub');
    if (heading && list) toggleSidebarMenu(heading.id, list.id, null, true);
}

// A link that names a view inside a screen (an income table) is marked only
// when the screen is showing that view.
function markPanelLinks(panelId) {
    const panel = document.getElementById(panelId);
    const view = panel ? panel.dataset.view : undefined;

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        const wanted = link.dataset.panelView;
        link.classList.toggle('active',
            link.dataset.panelLink === panelId && (!wanted || wanted === view));
    });
}

function showManagerHome(event) {
    showManagerPanel('panel-home', 'Manager Dashboard', event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));
    loadManagerSummary();
}

// the dashboard is the one screen that fetches on arrival: five figures, one query
function showIncome(event)        { showIncomeTable(incomeTable, event); }
function showReports(event)       { showReport(reportView, event); }
function showSales(event)         { showManagerPanel('panel-sales', 'Sales', event); }
function showReorderAlerts(event) { showManagerPanel('panel-reorder', 'Reorder Alerts', event); }
function showStockReport(event)   { showManagerPanel('panel-stock-report', 'Stock Report', event); }
function showDeliveries(event)    { showManagerPanel('panel-deliveries', 'Delivery Tracking', event); }
function showCredit(event)         { showManagerPanel('panel-credit', 'Customer Credit', event); }
function showCreditRequests(event) { showManagerPanel('panel-credit-requests', 'Extension Requests', event); }
function showRecords(event)       { showRecordType(recordType, event); }
function showArchives(event)      { showManagerPanel('panel-archives', 'Archives', event); }

function showStocks(event) { showReorderAlerts(event); }

// The dashboard. Every card leads to the screen that explains it. quiet is
// set when live-sync asks: the figures stay on screen instead of "Loading".
let kpiRefreshTimer = null;

async function loadManagerSummary(quiet) {
    const grid = document.getElementById('kpi-grid');
    if (!grid) return;

    if (!quiet) {
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Loading</span>' +
                         '<span class="kpi-value">&hellip;</span></div>';
    }

    try {
        const s = await getJson('/api/manager/summary');

        // gross - collected is the balance owed, so the outstanding card carries the
        // billed figure as context
        const billed = Number(s.grossSales) || 0;
        const collected = Number(s.totalIncome) || 0;
        const owed = Number(s.pendingCredits) || 0;
        const txCount = Number(s.saleCount) || 0;
        const basket = txCount ? billed / txCount : 0;
        const accounts = Number(s.pendingCreditCount) || 0;

        const cards = [
            {
                label: 'Collected',
                value: peso(collected),
                note: peso(s.incomeToday) + ' of it today',
                tone: '',
                open: 'openIncomeFromCard()'
            },
            {
                label: 'Outstanding',
                value: peso(owed),
                note: 'of ' + peso(billed) + ' billed, across ' + accounts +
                      ' account' + (accounts === 1 ? '' : 's'),
                tone: owed > 0 ? 'kpi-warn' : '',
                open: 'openCreditAccounts()'
            },
            {
                label: 'Transactions',
                value: txCount.toLocaleString('en-PH'),
                note: peso(basket) + ' average sale',
                tone: '',
                open: 'showSales(event)'
            },
            {
                label: 'Reorder Alerts',
                value: String(s.reorderAlerts),
                note: 'of ' + s.productCount + ' products',
                tone: Number(s.reorderAlerts) > 0 ? 'kpi-danger' : '',
                open: 'showReorderAlerts(event)'
            },
            {
                label: 'Deliveries Moving',
                value: String(s.deliveriesInProgress),
                note: s.deliveryProblems + ' delayed or failed',
                tone: Number(s.deliveryProblems) > 0 ? 'kpi-danger' : '',
                open: 'showDeliveries(event)'
            }
        ];

        grid.innerHTML = cards.map((card) =>
            '<button type="button" class="kpi-card kpi-open ' + card.tone + '" onclick="' + card.open + '">' +
            '<span class="kpi-label">' + escapeHtml(card.label) + '</span>' +
            '<span class="kpi-value">' + escapeHtml(card.value) + '</span>' +
            '<span class="kpi-note">' + escapeHtml(card.note) + '</span>' +
            '<span class="kpi-go">Open</span>' +
            '</button>'
        ).join('');
    } catch (error) {
        // a quiet refresh that fails leaves the last good figures where they are
        if (quiet) return;

        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Offline</span>' +
                         '<span class="kpi-value">--</span>' +
                         '<span class="kpi-note">Cannot reach the server</span></div>';
    }
}

async function openIncomeFromCard() {
    showIncome();
    await loadIncome();
}

// the Outstanding card counts accounts, so it opens the credit book filtered to who owes
async function openCreditAccounts() {
    showCredit();

    const owing = document.getElementById('credit-owing');
    if (owing) owing.value = 'owing';

    dataPanelFilter('mgr-credit', 'owing', 'owing');

    const panel = getDataPanel('mgr-credit');
    if (panel && panel.state === 'closed') await panel.open();
}

// Income breakdown. Named periods count back from today rather than snapping
// to a calendar month.
const INCOME_RANGES = [
    ['daily', 'Today'],
    ['weekly', '7 days'],
    ['monthly', '30 days'],
    ['quarterly', '90 days'],
    ['six-month', '6 months'],
    ['annual', '12 months'],
    ['all', 'All time']
];

function renderIncomeRanges() {
    const box = document.getElementById('income-ranges');
    if (!box) return;

    box.innerHTML = INCOME_RANGES.map(([name, label]) =>
        '<button type="button" class="filter-chip' + (incomeRange.name === name ? ' active' : '') +
        '" onclick="pickIncomeRange(\'' + name + '\')">' + escapeHtml(label) + '</button>'
    ).join('');
}

async function pickIncomeRange(name) {
    incomeRange = { name: name, from: null, to: null };

    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');
    if (from) from.value = '';
    if (to) to.value = '';

    renderIncomeRanges();
    await loadIncome();
}

async function applyCustomIncomeRange() {
    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');

    if (!from || !to || !from.value || !to.value) {
        notifyWarning('Pick both a start date and an end date, or choose a period above.',
            'Two dates needed');
        return;
    }

    if (from.value > to.value) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    incomeRange = { name: 'custom', from: from.value, to: to.value };
    renderIncomeRanges();
    await loadIncome();
}

function incomeQuery() {
    return incomeRange.name === 'custom'
        ? '?from=' + encodeURIComponent(incomeRange.from) + '&to=' + encodeURIComponent(incomeRange.to)
        : '?range=' + encodeURIComponent(incomeRange.name);
}

async function loadIncome() {
    const pill = document.getElementById('income-pill');
    if (pill) pill.textContent = 'Loading';

    try {
        incomeData = await getJson('/api/reports/income' + incomeQuery());
        renderIncome();

        ['mgr-income-methods', 'mgr-income-products', 'mgr-income-staff']
            .forEach((key) => {
                const panel = getDataPanel(key);
                if (panel) panel.open();
            });
    } catch (error) {
        if (pill) pill.textContent = 'Offline';
        notifyOffline();
    }
}

function renderIncome() {
    const data = incomeData;
    if (!data) return;

    const note = document.getElementById('income-range-note');
    if (note) {
        note.textContent = data.range.label + ' — ' + data.range.from + ' to ' + data.range.to;
    }

    setPill('income-pill', data.totals.saleCount +
        (Number(data.totals.saleCount) === 1 ? ' transaction' : ' transactions'));

    const kpis = [
        ['Collected', peso(data.totals.collected), 'money in hand', ''],
        ['Billed', peso(data.totals.billed), 'rung up, paid or not', ''],
        ['Outstanding', peso(data.totals.outstanding), 'still owed on these sales',
            Number(data.totals.outstanding) > 0 ? 'kpi-warn' : ''],
        ['Discounts', peso(data.totals.discounts), 'given away to win the sale', ''],
        ['Units Sold', Number(data.totals.unitsSold).toLocaleString('en-PH'), 'items across the counter', ''],
        ['Average Sale', peso(data.totals.averageSale), 'per transaction', '']
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

    renderIncomeChart(data);
}

// The chart is two divs and a height: billed sets the outline, collected
// fills it, and the gap is the money that has not arrived.
function renderIncomeChart(data) {
    const block = document.getElementById('income-chart-block');
    const chart = document.getElementById('income-chart');
    if (!block || !chart) return;

    if (!data.series || data.series.length === 0) {
        block.style.display = 'none';
        return;
    }

    block.style.display = 'block';

    const title = document.getElementById('income-chart-title');
    if (title) {
        const per = { day: 'day', week: 'week', month: 'month' }[data.range.bucket] || 'period';
        title.textContent = 'Billed and collected, by ' + per;
    }

    const peak = Math.max(...data.series.map((point) => Number(point.billed) || 0), 1);

    // about a dozen labels; the last one always prints
    const step = Math.max(1, Math.ceil(data.series.length / 12));
    const last = data.series.length - 1;

    chart.innerHTML = data.series.map((point, index) => {
        const billed = Number(point.billed) || 0;
        const collected = Number(point.collected) || 0;

        const label = chartLabel(point.bucket, data.range.bucket);
        const shown = (index % step === 0 || index === last) ? label : '';
        const title = label + ': ' + peso(collected) + ' collected of ' + peso(billed) + ' billed';

        return '<div class="chart-col" title="' + escapeHtml(title) + '">' +
            '<div class="chart-stack">' +
                '<div class="chart-bar chart-bar-billed" style="height:' +
                    ((billed / peak) * 100).toFixed(1) + '%"></div>' +
                '<div class="chart-bar chart-bar-collected" style="height:' +
                    ((collected / peak) * 100).toFixed(1) + '%"></div>' +
            '</div>' +
            '<span class="chart-label">' + escapeHtml(shown) + '</span>' +
        '</div>';
    }).join('');
}

function chartLabel(value, bucket) {
    const date = new Date(String(value).slice(0, 10) + 'T00:00:00');
    if (isNaN(date.getTime())) return String(value).slice(0, 10);

    if (bucket === 'month') {
        return date.toLocaleDateString('en-PH', { month: 'short', year: '2-digit' });
    }
    return date.toLocaleDateString('en-PH', { day: 'numeric', month: 'short' });
}

// Every table can leave the page as a CSV of every filtered row, or through
// the browser's print dialogue with the table unpaged. Both buttons are dead
// until the table holds rows and follow it via 'datapanel:change'. The
// income breakdown is exported by the server (audited, manager only).
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

// called whenever any table changes shape, and after a Reports tab switch
function syncExportButtons() {
    document.querySelectorAll('[data-print-for]').forEach((button) => {
        const ready = printKeys(button.dataset.printFor).some(panelHasRows);
        button.disabled = !ready;
        button.title = ready
            ? (button.dataset.printKind === 'sheet'
                ? 'Save every row shown as a spreadsheet'
                : 'Print every row shown, or save it as a PDF')
            : 'Load data first';
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

    window.location.href = '/api/reports/export?report=income-breakdown&' + incomeQuery().slice(1);

    notifyInfo('The file is being saved to your downloads folder. It opens in Excel, ' +
        'LibreOffice or Google Sheets.', 'Exporting the income breakdown');
}

// ---------- a spreadsheet of what the table shows ----------
// rows are read back as drawn, so the file and the page cannot disagree
function panelSheet(key) {
    const panel = getDataPanel(key);
    if (!panel || panel.state !== 'ready' || panel.visible.length === 0) return null;

    const table = document.getElementById(panel.config.tableId);
    if (!table) return null;

    const heads = [...table.querySelectorAll('thead th')];
    const keep = heads.map((th) => th.textContent.trim() !== '');   // an unnamed column is buttons
    const headers = heads.filter((th, i) => keep[i]).map((th) => th.textContent.trim());

    const scratch = document.createElement('table');
    scratch.innerHTML = '<tbody>' +
        panel.visible.map((row, index) => panel.config.renderRow(row, index)).join('') +
        '</tbody>';

    const rows = [...scratch.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.children].filter((td, i) => keep[i]).map((td) => sheetCell(td)));

    const caption = table.closest('.income-table, .tab-content, .card');
    const name = caption
        ? (caption.querySelector('.income-table-caption, h3') || {}).textContent || key
        : key;

    return { name: String(name).trim(), headers: headers, rows: rows };
}

// money and count cells go in as numbers; anything with words as it reads
function sheetCell(td) {
    const text = td.textContent.replace(/\s+/g, ' ').trim();
    if (td.classList.contains('cell-num') || td.classList.contains('cell-id')) {
        const bare = text.replace(/^#/, '').replace(/^-?\u20B1/, (sign) => sign.replace('\u20B1', '')).replace(/,/g, '');
        if (/^-?\d+(\.\d+)?$/.test(bare)) return bare;
    }
    return text;
}

function csvLine(cells) {
    return cells.map((value) => {
        const text = String(value === null || value === undefined ? '' : value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',');
}

function exportPanelSpreadsheet(keys, title) {
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

    const stamp = new Date().toISOString().slice(0, 10);
    const lines = [];

    sheets.forEach((sheet, index) => {
        if (index > 0) lines.push('');
        if (sheets.length > 1) lines.push(csvLine([sheet.name]));
        lines.push(csvLine(sheet.headers));
        sheet.rows.forEach((row) => lines.push(csvLine(row)));
    });

    // BOM so Excel on Windows reads UTF-8
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    const file = (title || sheets[0].name || 'report').replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') +
        '_' + stamp + '.csv';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);

    const total = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
    notifyInfo(total + (total === 1 ? ' row' : ' rows') + ' saved as ' + file +
        '. It opens in Excel, LibreOffice or Google Sheets.', 'Spreadsheet saved');
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

    document.body.classList.add('is-printing');

    // afterprint is the reliable signal; the timer covers a browser that never sends it
    printRestore = () => {
        if (!printRestore) return;
        printRestore = null;
        document.body.classList.remove('is-printing');
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

// the one pair of buttons over four reports follows whichever is open
const REPORT_TAB_PANELS = {
    'report-methods': ['mgr-methods', 'Payment Methods'],
    'report-unpaid':  ['mgr-unpaid', 'Receivables'],
    'report-loyal':   ['mgr-loyal', 'Repeat Customers'],
    'report-staff':   ['mgr-staff', 'Staff Performance']
};

function activeReport() {
    return REPORT_TAB_PANELS[reportView] || REPORT_TAB_PANELS['report-methods'];
}

function exportActiveReport() {
    const report = activeReport();
    exportPanelSpreadsheet(report[0], report[1]);
}

function printActiveReport() {
    printReport(activeReport()[0]);
}

// Three income tables in one card, chosen from the Income entry in the menu.
const INCOME_TABLES = [
    { name: 'methods',  label: 'Payment Method',
      note: 'Where the money came from, and what is still owed on each method.' },
    { name: 'products', label: 'Best Sellers',
      note: 'The ten products that brought in the most over this period.' },
    { name: 'staff',    label: 'Who Sold It',
      note: 'Sales handled by each member of staff over this period.' }
];

let incomeTable = 'methods';

// Income folds its list rather than opening a screen; fold is toggleSidebarMenu
function toggleIncomeMenu(event, force)  { toggleSidebarMenu('income-nav', 'income-dropdown', event, force); }
function toggleReportsMenu(event, force) { toggleSidebarMenu('reports-nav', 'reports-dropdown', event, force); }
function toggleRecordsMenu(event, force) { toggleSidebarMenu('records-nav', 'records-dropdown', event, force); }
function toggleStocksMenu(event, force)  { toggleSidebarMenu('stocks-nav', 'stocks-dropdown', event, force); }
function togglePurchasingMenu(event, force) { toggleSidebarMenu('po-nav', 'po-dropdown', event, force); }
function toggleCreditMenu(event, force)  { toggleSidebarMenu('credit-nav', 'credit-dropdown', event, force); }
function toggleDeliveriesMenu(event, force) { toggleSidebarMenu('deliveries-nav', 'deliveries-dropdown', event, force); }

function showIncomeTable(name, event) {
    showManagerPanel('panel-income', 'Income', event);
    pickIncomeTable(name);
    toggleIncomeMenu(null, true);
}

function pickIncomeTable(name) {
    const table = INCOME_TABLES.find((entry) => entry.name === name);
    if (!table) return;

    incomeTable = name;

    document.querySelectorAll('#income-tables .income-table').forEach((wrap) => {
        wrap.hidden = wrap.dataset.incomeTable !== name;
    });

    const title = document.getElementById('income-table-title');
    if (title) title.textContent = table.label;


    const panel = document.getElementById('panel-income');
    if (panel) panel.dataset.view = name;

    markPanelLinks('panel-income');
}

function buildIncomePanels() {
    createDataPanel({
        key: 'mgr-income-methods',
        tableId: 'income-methods-table',
        columns: 5,
        pageSize: 5,
        pagerId: 'income-methods-pager',
        gate: { title: 'Not loaded', text: 'Pick a period above and press Load Data.', button: 'Load Data' },
        load: () => (incomeData ? incomeData.methods : []),
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
        gate: { title: 'Not loaded', text: 'Pick a period above and press Load Data.', button: 'Load Data' },
        load: () => (incomeData ? incomeData.products : []),
        renderRow: (p) => {
            const total = incomeData
                ? incomeData.products.reduce((sum, item) => sum + Number(item.revenue || 0), 0)
                : 0;
            const share = total === 0 ? 0 : (Number(p.revenue) / total) * 100;

            return '<tr><td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
                '<td class="cell-num">' + p.units_sold + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
                '<td class="cell-num">' + peso(p.revenue) + '</td>' +
                '<td class="cell-num">' + share.toFixed(1) + '%</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-income-staff',
        tableId: 'income-staff-table',
        columns: 4,
        pageSize: 5,
        pagerId: 'income-staff-pager',
        gate: { title: 'Not loaded', text: 'Pick a period above and press Load Data.', button: 'Load Data' },
        load: () => (incomeData ? incomeData.cashiers : []),
        renderRow: (c) =>
            '<tr><td class="cell-name">' + escapeHtml(c.staff_name) + '</td>' +
            '<td class="cell-num">' + c.sale_count + '</td>' +
            '<td class="cell-num">' + peso(c.billed) + '</td>' +
            '<td class="cell-num">' + peso(c.collected) + '</td></tr>'
    });
}

// Four reports share one panel; data-view says which is showing.
let reportView = 'report-methods';

// the menu's way in
function showReport(tabId, event) {
    showManagerPanel('panel-reports', 'Reports', event);
    showReportTab(tabId);
    toggleReportsMenu(null, true);
}

function showReportTab(tabId) {
    if (!REPORT_TAB_PANELS[tabId]) tabId = 'report-methods';
    reportView = tabId;

    document.querySelectorAll('#panel-reports .tab-content')
        .forEach((tab) => tab.classList.toggle('active', tab.id === tabId));

    const report = REPORT_TAB_PANELS[tabId];

    const title = document.getElementById('reports-title');
    if (title) title.textContent = report[1];

    document.querySelectorAll('#panel-reports [data-print-for]').forEach((button) => {
        button.dataset.printFor = report[0];
    });

    const panel = document.getElementById('panel-reports');
    if (panel) panel.dataset.view = tabId;
    markPanelLinks('panel-reports');

    syncExportButtons();
}

// the four reports come from one route, fetched once and shared
let reportsCache = null;

async function reportsOverview(force) {
    if (reportsCache && !force) return reportsCache;
    reportsCache = await getJson('/api/reports/overview');
    return reportsCache;
}

function buildReportPanels() {
    createDataPanel({
        key: 'mgr-methods',
        tableId: 'methods-table',
        columns: 5,
        pagerId: 'methods-pager',
        countPillId: 'methods-count',
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data to read how customers are paying.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview(true)).methods,
        renderRow: (m) =>
            '<tr><td class="cell-name">' + escapeHtml(m.payment_method) + '</td>' +
            '<td class="cell-num">' + m.sale_count + '</td>' +
            '<td class="cell-num">' + peso(m.total_amount) + '</td>' +
            '<td class="cell-num">' + peso(m.paid_amount) + '</td>' +
            '<td class="cell-num' + (Number(m.balance_due) > 0 ? ' cell-due' : '') + '">' +
                peso(m.balance_due) + '</td></tr>'
    });

    createDataPanel({
        key: 'mgr-unpaid',
        tableId: 'unpaid-table',
        columns: 6,
        pagerId: 'unpaid-pager',
        countPillId: 'unpaid-count',
        idField: 'sale_id',
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for every sale with money still owed on it.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview()).unpaid,
        match: (row, query) => prefixMatch([
            row.customer_name, row.payment_method, row.sale_id, '#' + row.sale_id
        ], query),
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
        pagerId: 'loyal-pager',
        countPillId: 'loyal-count',
        idField: 'customer_id',
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for customers who have bought more than once.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview()).loyal,
        match: (row, query) => prefixMatch([row.customer_name], query),
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

    createDataPanel({
        key: 'mgr-staff',
        tableId: 'staff-table',
        columns: 4,
        pagerId: 'staff-pager',
        countPillId: 'staff-count',
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for sales handled by each member of staff.',
            button: 'Load Data'
        },
        load: async () => (await reportsOverview()).staffPerf,
        // a leaver keeps their sales history, marked
        renderRow: (s) =>
            '<tr><td class="cell-name">' + escapeHtml(s.staff_name) +
                (s.is_active ? '' : ' <span class="badge badge-neutral">No longer active</span>') + '</td>' +
            '<td>' + escapeHtml(s.role_name) + '</td>' +
            '<td class="cell-num">' + s.sale_count + '</td>' +
            '<td class="cell-num">' + peso(s.total_sales) + '</td></tr>'
    });
}

// Sales. Both filters go back to the server, where the figures are computed.
const SALE_STATUS_TONE = {
    'Completed': 'badge-success',
    'Pending Delivery': 'badge-warning',
    'Partial Credit': 'badge-warning',
    'Voided': 'badge-danger'
};

function salesQuery() {
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
    const panel = getDataPanel('mgr-sales');
    if (panel) await panel.open();
}

function buildSalesPanel() {
    createDataPanel({
        key: 'mgr-sales',
        tableId: 'sales-table',
        columns: 6,
        pagerId: 'sales-pager',
        countPillId: 'sales-count',
        idField: 'sale_id',
        gate: {
            title: 'No sales loaded',
            text: 'Pick a payment method, a status or a date range above, then press Load Data.',
            button: 'Load Data'
        },
        load: () => getJson('/api/sales' + salesQuery()),
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

// Stocks: one fetch behind Reorder Alerts and the Stock Report.
let stocksCache = null;

async function stockRows(force) {
    if (stocksCache && !force) return stocksCache;
    stocksCache = await getJson('/api/stocks');
    return stocksCache;
}

function modeBadge(row) {
    return row.reorder_mode === 'Dynamic'
        ? '<span class="badge badge-success">Dynamic</span>'
        : '<span class="badge badge-neutral">Manual</span>';
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
        countPillId: 'reorder-count',
        idField: 'product_id',
        filters: { mode: 'all' },
        gate: {
            title: 'Reorder alerts not loaded',
            text: 'Press Load Data for every product at or below its reorder point.',
            button: 'Load Data'
        },
        load: async () => (await stockRows(true)).filter((p) => p.stock_status !== 'In Stock'),
        match: (p, query) => prefixMatch([p.product_name, p.supplier_name], query),
        filter: (p, filters) => filters.mode === 'all' || p.reorder_mode === filters.mode,
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
        load: () => stockRows(true),
        match: (p, query) => prefixMatch([p.product_name, p.category_name, p.supplier_name], query),
        filter: (p, filters) =>
            (filters.status === 'all' || p.stock_status === filters.status) &&
            stockLevelMatches(p, filters.level),
        sort: (rows, filters) => sortStockRows(rows, filters.sort),
        onLoaded: (rows) => {
            const total = rows.reduce((sum, p) => sum + Number(p.stock_value || 0), 0);
            setPill('stock-value', peso(total) + ' total value');
        },
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
        const response = await fetch('/api/stocks/' + policyProduct.product_id + '/reorder-policy', {
            method: 'PUT',
            headers: apiHeaders(),
            body: JSON.stringify(body)
        });
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


// Purchase orders: the form, history, print and count-in sheets all come from
// shared/purchase-orders.js. This is the page with the form.
function buildManagerPurchaseOrderPanel() {
    configurePurchaseOrders({
        key: 'mgr-po',
        canCreate: true,
        canReceive: true,
        showPanel: (panelId, title) => showManagerPanel(panelId, title),
        historyPanelId: 'panel-po-history',
        historyTitle: 'Order History',
        gateText: 'Press Load Data for every order raised, or filter to the ones still pending.',
        // a delivery counted in moves stock
        afterChange: async () => {
            stocksCache = null;
            for (const key of ['mgr-reorder', 'mgr-stocks']) {
                const panel = getDataPanel(key);
                if (panel && panel.state === 'ready') await panel.refresh();
            }
            loadManagerSummary(true);
        }
    });
    buildPurchaseOrderPanel();
}

// Credit management: a limit and a standing are edited together, with what
// the customer owes printed above them.
const STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };
const STANDING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

let creditCustomer = null;
let creditRequest = null;

// reason is the view's standing_reason: the first rule that fired
function standingBadge(standing, reason) {
    return '<span class="badge ' + (STANDING_TONE[standing] || 'badge-neutral') + '"' +
           (reason ? ' title="' + escapeHtml(reason) + '"' : '') + '>' +
           escapeHtml(STANDING_WORD[standing] || standing) + '</span>';
}

function debtAge(days) {
    if (days === null || days === undefined) return '<span class="muted">Nothing owed</span>';

    const count = Number(days);
    const text = count === 0 ? 'Today' : count === 1 ? '1 day' : count + ' days';

    if (count > 60) return '<span class="cell-due">' + text + '</span>';
    if (count > 30) return '<span class="text-warn">' + text + '</span>';
    return text;
}

function buildCreditPanels() {
    createDataPanel({
        key: 'mgr-credit',
        tableId: 'credit-table',
        columns: 7,
        pagerId: 'credit-pager',
        countPillId: 'credit-count',
        idField: 'customer_id',
        filters: { standing: 'all', owing: 'all' },

        gate: {
            title: 'The credit book is not loaded',
            text: 'Search for a customer, filter by standing, or press Load Data for every account.',
            button: 'Load Data'
        },

        load: () => getJson('/api/credit/customers'),

        match: (row, query) => prefixMatch([row.customer_name, row.phone], query),

        filter: (row, filters) => {
            if (filters.standing !== 'all' && row.standing !== filters.standing) return false;

            const owed = Number(row.current_credit) || 0;
            const limit = Number(row.credit_limit) || 0;

            if (filters.owing === 'owing' && owed <= 0) return false;
            if (filters.owing === 'clear' && owed > 0) return false;
            if (filters.owing === 'over' && owed <= limit) return false;

            return true;
        },

        onLoaded: (rows) => {
            const waiting = rows.reduce((sum, row) => sum + Number(row.pending_requests || 0), 0);
            markPendingRequests(waiting);
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
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) + '</td>' +
                '<td class="cell-num">' + (over
                    ? '<span class="cell-due">Over by ' + peso(owed - limit) + '</span>'
                    : peso(row.available_credit)) + '</td>' +
                '<td class="cell-num">' + row.open_sales + '</td>' +
                '<td class="cell-num">' + debtAge(row.oldest_debt_days) + '</td>' +
                '<td>' + standingBadge(row.standing, row.standing_reason) + '</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-requests',
        tableId: 'requests-table',
        columns: 7,
        pagerId: 'requests-pager',
        countPillId: 'requests-count',
        idField: 'request_id',

        gate: {
            title: 'No requests loaded',
            text: 'Press Load Data for extension requests raised at the counter.',
            button: 'Load Data'
        },

        load: () => {
            const status = document.getElementById('requests-status');
            const value = status ? status.value : 'Pending';
            return getJson('/api/credit/requests' + (value === 'all' ? '' : '?status=' + value));
        },

        match: (row, query) => prefixMatch([row.customer_name, row.requested_by], query),

        onLoaded: (rows) => {
            markPendingRequests(rows.filter((row) => row.status === 'Pending').length);
        },

        renderRow: (row, index) => {
            const tone = row.status === 'Pending' ? 'badge-warning'
                : row.status === 'Approved' ? 'badge-success' : 'badge-danger';

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
}

function markPendingRequests(count) {
    const badge = document.getElementById('credit-request-count');
    if (!badge) return;

    badge.textContent = count > 0 ? String(count) : '';
    badge.classList.toggle('is-waiting', count > 0);
}

async function reloadCreditRequests() {
    const panel = getDataPanel('mgr-requests');
    if (panel) await panel.open();
}

// ---------- one account ----------
async function openCreditAccount(customerId) {
    try {
        const data = await getJson('/api/credit/customers/' + customerId);
        creditCustomer = data.credit;

        const c = creditCustomer;
        const owed = Number(c.current_credit) || 0;
        const limit = Number(c.credit_limit) || 0;

        document.getElementById('credit-name').textContent = c.customer_name;
        document.getElementById('credit-sub').textContent =
            (c.phone || 'No phone on file') + ' · ' + (STANDING_WORD[c.standing] || c.standing);
        document.getElementById('credit-avatar').textContent = initialsOf(c.customer_name);

        document.getElementById('credit-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Currently Owed', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Still Available', owed > limit
                ? '<span class="cell-due">Over by ' + peso(owed - limit) + '</span>'
                : peso(c.available_credit)) +
            detailField('Open Sales', String(c.open_sales)) +
            detailField('Oldest Debt', debtAge(c.oldest_debt_days)) +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            detailField('Last Purchase', c.last_purchase
                ? escapeHtml(String(c.last_purchase).slice(0, 16))
                : '<span class="muted">Never</span>') +
            detailField('Last Payment', c.last_payment
                ? escapeHtml(String(c.last_payment).slice(0, 16))
                : '<span class="muted">None recorded</span>') +
            detailField('Standing', standingBadge(c.standing, c.standing_reason)) +
            detailField('Why', escapeHtml(c.standing_reason || '')) +
            detailField('Manager\'s Word', c.manual_standing === 'Good'
                ? '<span class="muted">None &mdash; the figures decide</span>'
                : escapeHtml(STANDING_WORD[c.manual_standing] || c.manual_standing)) +
            detailField('Last Changed', c.credit_updated_at
                ? escapeHtml(String(c.credit_updated_at).slice(0, 16))
                : '<span class="muted">Never</span>');

        const form = document.getElementById('credit-form');
        form.elements.creditLimit.value = Number(c.credit_limit).toFixed(2);
        form.elements.standing.value = c.manual_standing || 'Good';
        form.elements.notes.value = c.credit_notes || '';

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
        verdict = name + ' can take another <strong>' + peso(room) + '</strong> on account today, ' +
            'and the account reads <strong>Watch</strong>: ' +
            (standing === 'Watch' ? 'you have flagged it.'
                : days > 30 ? 'the oldest unpaid sale is ' + days + ' days old.'
                : 'they owe ' + Math.round(owed / limit * 100) + '% of this limit.');
    } else {
        verdict = name + ' can take another <strong>' + peso(room) + '</strong> on account today, ' +
            'in good standing.';
    }

    preview.innerHTML =
        '<span class="formula-line">' + peso(limit) + ' limit &minus; ' + peso(owed) +
        ' owed = <strong>' + (room >= 0 ? peso(room) + ' available' : peso(-room) + ' over') +
        '</strong></span>' +
        '<span class="formula-verdict">' + verdict + '</span>';

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
        const response = await fetch('/api/credit/customers/' + creditCustomer.customer_id + '/limit', {
            method: 'PUT',
            headers: apiHeaders(),
            body: JSON.stringify({
                creditLimit: limit,
                standing: standing,
                notes: form.elements.notes.value.trim()
            })
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
        creditHistory = await getJson('/api/customers/' + creditCustomer.customer_id + '/history');
        renderCreditHistory(creditHistory);
    } catch (error) {
        box.innerHTML = '<p class="detail-note detail-warn">That history could not be read.</p>';
    }
}

// purchases beside payments, so both get read before extending anything
function renderCreditHistory(data) {
    const box = document.getElementById('credit-history');
    if (!box) return;

    const purchases = data.purchases.length === 0
        ? '<p class="detail-empty">Nothing bought yet.</p>'
        : detailTable(['Date', 'Sale', 'Amount', 'Owed'],
            data.purchases.map((p) => [
                escapeHtml(String(p.sale_date).slice(0, 10)),
                '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
                peso(p.final_amount),
                Number(p.balance_due) > 0
                    ? '<span class="cell-due">' + peso(p.balance_due) + '</span>'
                    : '<span class="muted">Paid</span>'
            ]), [2, 3]);

    const payments = data.payments.length === 0
        ? '<p class="detail-empty">No payments recorded.</p>'
        : detailTable(['Date', 'Amount', 'How', 'Against'],
            data.payments.map((p) => [
                escapeHtml(String(p.payment_date).slice(0, 10)),
                peso(p.amount),
                escapeHtml(p.payment_method),
                p.sale_id ? '#' + p.sale_id : '<span class="muted">On account</span>'
            ]), [1]);

    const requests = data.requests.length === 0
        ? ''
        : '<div class="history-column history-full">' +
          '<h4 class="history-head">Extension Requests</h4>' +
          detailTable(['Asked', 'From', 'To', 'Outcome'],
            data.requests.map((r) => [
                escapeHtml(String(r.created_at).slice(0, 10)),
                peso(r.previous_limit),
                peso(r.requested_limit),
                escapeHtml(r.status) + (r.decided_by ? ' <span class="muted">' +
                    escapeHtml(r.decided_by) + '</span>' : '')
            ]), [1, 2]) + '</div>';

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
                    ? '<span class="cell-due">' + peso(data.credit.current_credit) + ' owed</span>'
                    : 'Nothing owed') +
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
        detailField('Asked On', escapeHtml(String(r.created_at).slice(0, 16))) +
        detailField('Raised By', escapeHtml(r.requested_by || 'Unknown')) +
        detailField('Current Limit', peso(r.previous_limit)) +
        detailField('Asked For', '<strong>' + peso(r.requested_limit) + '</strong>') +
        detailField('Currently Owed', '<span class="' +
            (Number(r.current_credit) > 0 ? 'cell-due' : '') + '">' + peso(r.current_credit) + '</span>') +
        detailField('Standing', standingBadge(r.standing || 'Good', r.standing_reason)) +
        detailField('Status', escapeHtml(r.status)) +
        detailField('Decided', r.decided_at
            ? escapeHtml(String(r.decided_at).slice(0, 16))
            : '<span class="muted">Not yet</span>');

    const reason = document.getElementById('decide-reason');
    reason.textContent = r.reason
        ? 'Reason given: ' + r.reason
        : 'No reason was given with this request.';

    const note = document.getElementById('decide-note');
    note.value = r.decision_note || '';
    note.disabled = decided;

    // a decision already made stands; the reason is what an audit keeps
    document.getElementById('decide-actions').innerHTML = decided
        ? '<button type="button" class="btn btn-ghost" onclick="closeModal(\'decide-modal\')">Close</button>'
        : '<button type="button" class="btn btn-ghost" onclick="closeModal(\'decide-modal\')">Cancel</button>' +
          '<button type="button" class="btn btn-danger" onclick="decideCreditRequest(false)">Decline</button>' +
          '<button type="button" class="btn btn-success" onclick="decideCreditRequest(true)">' +
          'Approve &amp; Raise Limit</button>';

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

    const yes = approve
        ? await askConfirm(
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
            })
        : await askConfirm(
            'The request for ' + r.customer_name + ' will be refused and their limit stays at ' +
            peso(r.previous_limit) + '.',
            {
                title: 'Decline this request?',
                eyebrow: 'Credit Management',
                confirmLabel: 'Decline it',
                tone: 'danger'
            });

    if (!yes) return;

    try {
        const response = await fetch('/api/credit/requests/' + r.request_id + '/decide', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ approve: approve, note: note })
        });
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
        countPillId: 'deliveries-count',
        idField: 'delivery_id',
        filters: { state: 'all' },
        gate: {
            title: 'Deliveries not loaded',
            text: 'Press Load Data for every delivery on record, or filter by fulfilment first.',
            button: 'Load Data'
        },
        load: () => getJson('/api/deliveries'),
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
    customer: [['name', 'Customer'], ['phone', 'Phone'], ['purchase_count', 'Purchases'], ['credit_limit', 'Credit Limit'], ['current_credit', 'Owes']],
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
    toggleRecordsMenu(null, true);

    const title = document.getElementById('records-title');
    if (title) title.textContent = RECORD_TITLES[type];


    const card = document.getElementById('panel-records');
    if (card) card.dataset.view = type;
    markPanelLinks('panel-records');

    writeRecordHeaders();

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
        countPillId: 'records-count',
        gate: {
            title: 'No records loaded',
            text: 'Pick a kind of record above, then press Load Data.',
            button: 'Load Data'
        },
        load: () => getJson('/api/records/' + recordType),
        match: (row, query) => prefixMatch(Object.values(row), query),
        renderRow: (row, index) => {
            const columns = RECORD_COLUMNS[recordType];

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openRecordDetail(' + index + ')">' +
                columns.map((column, position) => {
                    const value = row[column[0]];
                    const money = MONEY_FIELDS.indexOf(column[0]) !== -1;
                    const shown = money ? peso(value)
                        : (value === null || value === undefined || value === ''
                            ? '<span class="muted">Not set</span>' : escapeHtml(value));
                    const style = position === 0 ? 'cell-name'
                        : ((typeof value === 'number' || money) ? 'cell-num' : '');
                    return '<td class="' + style + '">' + shown + '</td>';
                }).join('') + '</tr>';
        }
    });
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
        countPillId: 'archives-count',
        filters: { module: 'All' },
        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for everything archived across all modules.',
            button: 'Load Data'
        },
        load: () => getJson('/api/archives'),
        match: (a, query) => prefixMatch([a.record_name, a.detail, a.module], query),
        filter: (a, filters) => filters.module === 'All' || a.module === filters.module,
        onLoaded: (rows) => renderArchiveFilters(rows),
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

function renderArchiveFilters(rows) {
    const box = document.getElementById('archive-filters');
    if (!box) return;

    const modules = ['All', 'Staff', 'Inventory', 'Sales', 'Delivery'];

    box.innerHTML = modules.map((module) => {
        const count = module === 'All'
            ? rows.length
            : rows.filter((a) => a.module === module).length;

        return '<button type="button" class="filter-chip' + (archiveFilter === module ? ' active' : '') +
            '" onclick="setArchiveFilter(\'' + module + '\')">' + module +
            ' <span class="chip-count">' + count + '</span></button>';
    }).join('');
}

function setArchiveFilter(module) {
    archiveFilter = module;

    const panel = getDataPanel('mgr-archives');
    if (panel) renderArchiveFilters(panel.rows);

    dataPanelFilter('mgr-archives', 'module', module);
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
        const response = await fetch('/api/archives/restore', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ module: module, recordId: recordId })
        });
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
        const data = await getJson('/api/sales/' + saleId);
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

        const balance = Number(s.final_amount) - Number(s.amount_paid);
        const units = data.items.reduce((sum, it) =>
            sum + (isMeasuredUnit(it.unit_name) ? 1 : (Number(it.quantity) || 0)), 0);
        const totals = '<div class="detail-grid">' +
            detailField('Items Purchased', units + (data.items.length !== units
                ? ' (' + data.items.length + (data.items.length === 1 ? ' line)' : ' lines)') : '')) +
            detailField('Gross Total', peso(s.total_amount)) +
            detailField('Discount', peso(s.discount)) +
            detailField('Amount Due', peso(s.final_amount)) +
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
        const voidBlock = s.is_archived
            ? '<p class="detail-note detail-warn">This sale was voided' +
              (s.archived_at ? ' on ' + escapeHtml(String(s.archived_at).slice(0, 16)) : '') +
              '. It counts for nothing, and its stock went back on the shelf.</p>'
            : saleDay === today
            ? '<div class="detail-actions">' +
              '<button type="button" class="btn btn-danger" onclick="voidSale(' + s.sale_id + ')">Void this sale</button>' +
              '</div>'
            : '<p class="detail-note">A sale can only be voided on the day it was made. ' +
              'Correct this one with a return or a refund.</p>';

        const pages = [
            { label: 'Summary', body: summary + voidBlock },
            { label: 'Totals', body: totals },
            { label: 'Items (' + data.items.length + ')', body: items },
            { label: 'Payments (' + data.payments.length + ')', body: payments }
        ];

        if (data.delivery) {
            const d = data.delivery;
            const owed = Number(s.final_amount) - Number(s.amount_paid);
            const state = d.status !== 'Delivered' ? d.status
                : (owed > 0 ? 'Pending Cash Collection' : 'Completed');

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

    const result = await postJson('/api/archives/archive', { module: 'Sales', recordId: saleId });
    if (!result) return;

    closeModal('detail-modal');
    notifySuccess('Sale #' + saleId + ' is voided and its stock is back on the shelf.', 'Sale voided');

    for (const key of ['mgr-sales', 'mgr-archives', 'mgr-deliveries']) {
        const panel = getDataPanel(key);
        if (panel && panel.state === 'ready') await panel.refresh();
    }
    loadManagerSummary(true);
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

    const result = await postJson('/api/archives/archive', { module: 'Delivery', recordId: deliveryId });
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
        detailField('Unit Price', peso(p.price)) +
        detailField('Stock Value', peso(p.stock_value)) +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('Brand', escapeHtml(p.brand_name || 'No brand')) +
        detailField('Product Status', statusBadge(p.status)) +
        detailField('Last Updated', escapeHtml(p.last_updated || 'Never')) +
        '</div>';

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

function openRecordDetail(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    if (!row) return;

    const keys = Object.keys(row).filter((key) => key !== 'id' && key !== 'name');
    const pages = [{
        label: 'Overview',
        body: '<div class="detail-grid">' +
            detailField('Record ID', '#' + row.id) +
            detailField('Name', escapeHtml(row.name)) +
            keys.slice(0, 4).map((key) => detailField(prettyLabel(key), fieldValue(key, row[key]))).join('') +
            '</div>'
    }];

    for (let i = 4; i < keys.length; i += 6) {
        pages.push({
            label: 'More ' + pages.length,
            body: '<div class="detail-grid">' +
                keys.slice(i, i + 6).map((key) => detailField(prettyLabel(key), fieldValue(key, row[key]))).join('') +
                '</div>'
        });
    }

    openDetailModal(row.name, prettyLabel(recordType) + ' record', initialsOf(row.name), pages);
}

// reached from the Repeat Customers report, which only knows a customer id
async function openCustomerDetail(customerId) {
    try {
        const rows = await getJson('/api/records/customer');
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
if (window.location.pathname.toLowerCase().endsWith('manager-dashboard.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildIncomePanels();
        buildReportPanels();
        buildSalesPanel();
        buildStockPanels();
        buildDeliveryPanel();
        buildManagerPurchaseOrderPanel();
        buildCreditPanels();
        buildRecordsPanel();
        buildArchivePanel();

        // for a manager the administrator has handed a key to a connected system
        configureConnectedSystems({ showPanel: (panelId, title) => showManagerPanel(panelId, title) });
        buildConnectedSystemsPanel();

        // the schedule follows what the administrator switched on for managers
        configureDeliverySchedule({ showPanel: (panelId, title) => showManagerPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showManagerHome() });

        writeRecordHeaders();
        renderIncomeRanges();
        pickIncomeTable(incomeTable);
        showReportTab(reportView);
        applyExportPermissions();

        document.addEventListener('datapanel:change', syncExportButtons);
        syncExportButtons();

        showManagerHome();
        loadNotifications();

        // the KPI tiles follow the Live badge; one sale fires several scopes, hence the debounce
        onLiveChange(['sales', 'credit', 'inventory', 'deliveries', 'returns'], function () {
            clearTimeout(kpiRefreshTimer);
            kpiRefreshTimer = setTimeout(function () {
                const home = document.getElementById('panel-home');
                if (!home || home.style.display === 'none') return;
                if (document.querySelector('.modal.open, .drawer.open')) return;

                const active = document.activeElement;
                if (active && active.closest && active.closest('.kpi-card')) return;

                loadManagerSummary(true);
            }, 400);
        });
    });
}
