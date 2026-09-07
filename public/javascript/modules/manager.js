// manager.js  --  MANAGER
// Loaded by: manager-dashboard.html
// ------------------------------------------------------------------------
// Nine screens. Every table on them is a data panel: closed until it is
// asked for, ten rows to a page. What is particular to this module is the
// reading: what a figure on the dashboard leads to, how a reorder point is
// worked out, and the difference between a delivery that has arrived and one
// that has been paid for.
// ==========================================

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

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('manager-page-title');
    if (heading) heading.textContent = title;

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');

    window.scrollTo(0, 0);
}

function showManagerHome(event) {
    showManagerPanel('panel-home', 'Manager Dashboard', event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));
    loadManagerSummary();
}

// The dashboard is the one screen that still fetches on arrival, and it
// should: six figures is one query, it is the reason the page was opened, and
// there is nothing on it to filter first.
function showIncome(event)        { showManagerPanel('panel-income', 'Income', event); }
function showReports(event)       { showManagerPanel('panel-reports', 'Reports', event); }
function showSales(event)         { showManagerPanel('panel-sales', 'Sales', event); }
function showReorderAlerts(event) { showManagerPanel('panel-reorder', 'Reorder Alerts', event); }
function showStockReport(event)   { showManagerPanel('panel-stock-report', 'Stock Report', event); }
function showDeliveries(event)    { showManagerPanel('panel-deliveries', 'Deliveries', event); }
function showCredit(event)         { showManagerPanel('panel-credit', 'Customer Credit', event); }
function showCreditRequests(event) { showManagerPanel('panel-credit-requests', 'Extension Requests', event); }
function showRecords(event)       { showManagerPanel('panel-records', 'Records', event); }
function showArchives(event)      { showManagerPanel('panel-archives', 'Archives', event); }

// kept so an old link, a bookmark or the screenshot tour still lands somewhere
function showStocks(event) { showReorderAlerts(event); }

// ==========================================
// THE DASHBOARD
//
// A number on a dashboard that cannot be opened is a number you then have to
// go and look up somewhere else, so every card here leads to the screen that
// explains it. The four the brief names lead the grid; the rest follow as
// context.
// ==========================================
async function loadManagerSummary() {
    const grid = document.getElementById('kpi-grid');
    if (!grid) return;

    grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Loading</span>' +
                     '<span class="kpi-value">&hellip;</span></div>';

    try {
        const s = await getJson('/api/manager/summary');

        const cards = [
            {
                label: 'Total Income',
                value: peso(s.totalIncome),
                note: peso(s.incomeToday) + ' collected today',
                tone: '',
                open: 'openIncomeFromCard()'
            },
            {
                label: 'Sales Volume',
                value: Number(s.unitsSold).toLocaleString('en-PH'),
                note: 'units across ' + s.saleCount + ' transactions',
                tone: '',
                open: "showSales(event)"
            },
            {
                label: 'Pending Credits',
                value: peso(s.pendingCredits),
                note: s.pendingCreditCount + ' account' + (Number(s.pendingCreditCount) === 1 ? '' : 's') + ' owing',
                tone: Number(s.pendingCredits) > 0 ? 'kpi-warn' : '',
                open: "openReceivables()"
            },
            {
                label: 'Reorder Alerts',
                value: String(s.reorderAlerts),
                note: 'of ' + s.productCount + ' products',
                tone: Number(s.reorderAlerts) > 0 ? 'kpi-danger' : '',
                open: "showReorderAlerts(event)"
            },
            {
                label: 'Gross Sales',
                value: peso(s.grossSales),
                note: 'billed, paid or not',
                tone: '',
                open: "showSales(event)"
            },
            {
                label: 'Deliveries Moving',
                value: String(s.deliveriesInProgress),
                note: s.deliveryProblems + ' delayed or failed',
                tone: Number(s.deliveryProblems) > 0 ? 'kpi-danger' : '',
                open: "showDeliveries(event)"
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
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Offline</span>' +
                         '<span class="kpi-value">--</span>' +
                         '<span class="kpi-note">Cannot reach the server</span></div>';
    }
}

// the Income card opens the breakdown and fills it, because a card that opens
// an empty screen has not answered the question it was clicked for
async function openIncomeFromCard() {
    showIncome();
    await loadIncome();
}

// the Pending Credits card opens the receivables tab, already loaded
async function openReceivables() {
    showReports();
    showReportTab('report-unpaid');

    const panel = getDataPanel('mgr-unpaid');
    if (panel && panel.state === 'closed') await panel.open();
}

// ==========================================
// THE INCOME BREAKDOWN
//
// Seven named periods and a custom pair. The named ones count back from
// today rather than snapping to a calendar month, because "this month" on the
// third of the month is four days of trading and reads as a collapse.
// ==========================================
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

    // picking a named period clears the two date boxes, so the screen never
    // shows a range it is not actually reporting on
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

        // the three tables under the chart read from what has already arrived,
        // so opening them costs nothing further
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
        note.textContent = data.range.label + ' — ' + data.range.from + ' to ' + data.range.to +
            '. Collected is money actually in hand; billed is what was rung up, paid or not.';
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

// ==========================================
// THE CHART
//
// Drawn with two divs and a height, not a charting library. There is no
// internet on the machine this runs on, the shape of the question is "is this
// week bigger than last week", and a library would be 300KB to answer it.
//
// Two bars to a period, one behind the other: billed sets the outline and
// collected fills it, so the gap between them is the money that has not
// arrived, which is the whole point of looking.
// ==========================================
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

    // Ninety days of dates printed under ninety bars run into each other and
    // stop being dates. Every column keeps its hover text; only about a dozen
    // of them print a label, and the last one always does, because the end of
    // the range is the date somebody is actually looking for.
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

// ==========================================
// TAKING A REPORT AWAY
//
// Export is a plain navigation, so the browser saves what the server sends.
// The server refuses anybody but a manager, which is what actually enforces
// the rule; hiding the button only keeps a screen honest about what it offers.
// ==========================================
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

function exportReport(name) {
    if (!canExportReports()) {
        notifyWarning('Only a manager can take a report off this screen. ' +
            'Your daily tally is on the screen and can be read from here.', 'Not allowed');
        return;
    }

    if (!incomeData) {
        notifyWarning('Load the income breakdown first, so the file matches what you are looking at.',
            'Nothing to export yet');
        return;
    }

    window.location.href = '/api/reports/export?report=' + encodeURIComponent(name) +
        '&' + incomeQuery().slice(1);

    notifyInfo('The file is being saved to your downloads folder. It opens in Excel, ' +
        'LibreOffice or Google Sheets.', 'Exporting ' + name);
}

// The browser's own print dialogue over the print stylesheet. What a manager
// wants on paper is the page they are already looking at, not a second
// rendering of it that drifts from the screen.
function printReport() {
    if (!canExportReports()) {
        notifyWarning('Printing a report is a manager action.', 'Not allowed');
        return;
    }
    window.print();
}

// ==========================================
// INCOME TABLES
// ==========================================
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

// ==========================================
// REPORTS, ONE AT A TIME
//
// These four were stacked down one page, so the fourth sat three screens
// below the first and the third pushed it further every time it loaded. Each
// is now behind a tab, loads on request, and pages on its own.
// ==========================================
function showReportTab(tabId, event) {
    document.querySelectorAll('#panel-reports .tab-content')
        .forEach((tab) => tab.classList.toggle('active', tab.id === tabId));

    document.querySelectorAll('#panel-reports .tab-btn')
        .forEach((button) => button.classList.remove('active'));

    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    } else {
        const button = document.getElementById('tab-btn-' + tabId.replace('report-', ''));
        if (button) button.classList.add('active');
    }
}

// The four reports come from one route, so the first tab opened pays for all
// four and the other three are free. It is fetched once and shared.
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
        match: (row, query) =>
            (row.customer_name + ' ' + row.payment_method + ' #' + row.sale_id)
                .toLowerCase().indexOf(query) !== -1,
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
        match: (row, query) => row.customer_name.toLowerCase().indexOf(query) !== -1,
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
        // a leaver keeps their sales history, marked so the row is not mistaken
        // for somebody still on the floor
        renderRow: (s) =>
            '<tr><td class="cell-name">' + escapeHtml(s.staff_name) +
                (s.is_active ? '' : ' <span class="badge badge-neutral">No longer active</span>') + '</td>' +
            '<td>' + escapeHtml(s.role_name) + '</td>' +
            '<td class="cell-num">' + s.sale_count + '</td>' +
            '<td class="cell-num">' + peso(s.total_sales) + '</td></tr>'
    });
}

// ==========================================
// SALES
//
// The two filters go back to the server, because both are computed there and
// a copy of that arithmetic in the browser is a copy that goes wrong.
// ==========================================
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
        match: (s, query) =>
            (s.customer_name + ' ' + s.cashier_name + ' ' + s.payment_method + ' #' + s.sale_id)
                .toLowerCase().indexOf(query) !== -1,
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

// ==========================================
// STOCKS
//
// One fetch behind two screens. Reorder Alerts is the subset that needs
// acting on; the Stock Report is all of it. Fetching twice would let the two
// screens disagree about the same product.
// ==========================================
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
        match: (p, query) =>
            (p.product_name + ' ' + (p.supplier_name || '')).toLowerCase().indexOf(query) !== -1,
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
        filters: { status: 'all' },
        gate: {
            title: 'The stock report is not loaded',
            text: 'Search for a product, pick a status, or press Load Data for the whole inventory.',
            button: 'Load Data'
        },
        load: () => stockRows(true),
        match: (p, query) =>
            (p.product_name + ' ' + (p.category_name || '') + ' ' + (p.supplier_name || ''))
                .toLowerCase().indexOf(query) !== -1,
        filter: (p, filters) => filters.status === 'all' || p.stock_status === filters.status,
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

// The arithmetic, shown as it is typed. A formula somebody cannot see the
// result of before saving is a formula they will not switch on.
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

    // switching a product to Dynamic changes when it gets ordered, which is a
    // change worth reading before it is made
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

        // both stock screens read one cache, so both are refreshed at once
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
// CREDIT MANAGEMENT
//
// A credit limit on its own is not a policy. A customer who always pays and
// one who has owed for four months both fit under the same limit, and only
// one of them should be sold to on account. So a limit and a standing are
// edited together, on one card, with what the customer actually owes printed
// above them.
// ==========================================
const STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };
const STANDING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

let creditCustomer = null;
let creditRequest = null;

function standingBadge(standing) {
    return '<span class="badge ' + (STANDING_TONE[standing] || 'badge-neutral') + '">' +
           escapeHtml(STANDING_WORD[standing] || standing) + '</span>';
}

// how long money has been owed, in words rather than a raw day count
function debtAge(days) {
    if (days === null || days === undefined) return '<span class="muted">Nothing owed</span>';

    const count = Number(days);
    const text = count === 0 ? 'Today' : count === 1 ? '1 day' : count + ' days';

    // thirty days is where a slow payer starts becoming a bad one
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

        match: (row, query) =>
            (row.customer_name + ' ' + (row.phone || '')).toLowerCase().indexOf(query) !== -1,

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
                '<td>' + standingBadge(row.standing) + '</td></tr>';
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

        match: (row, query) =>
            (row.customer_name + ' ' + (row.requested_by || '')).toLowerCase().indexOf(query) !== -1,

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

// The menu carries the count, because a request nobody sees is a queue at the
// till nobody knows about.
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
            detailField('Standing', standingBadge(c.standing)) +
            detailField('Set By', c.credit_updated_at
                ? escapeHtml(String(c.credit_updated_at).slice(0, 16))
                : '<span class="muted">Never changed</span>');

        const form = document.getElementById('credit-form');
        form.elements.creditLimit.value = Number(c.credit_limit).toFixed(2);
        form.elements.standing.value = c.standing || 'Good';
        form.elements.notes.value = c.credit_notes || '';

        previewCreditLimit();
        showCreditTab('account');
        showModal('credit-modal');

        // the history half is fetched only when it is opened
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

// The consequence of the figure being typed, in words, before it is saved.
// "50000" means nothing on its own; "they can take another 12,400 today"
// is the sentence somebody is actually deciding.
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

    let verdict;
    if (standing === 'Hold') {
        verdict = name + ' can take no new credit at all until the hold is lifted, ' +
            'whatever the limit says.';
    } else if (room > 0) {
        verdict = name + ' can take another <strong>' + peso(room) + '</strong> on account today.';
    } else if (room === 0) {
        verdict = name + ' is exactly at the limit and can take no more until something is paid.';
    } else {
        verdict = name + ' already owes <strong>' + peso(-room) + '</strong> more than this limit, ' +
            'so no further credit can be taken until it is paid down. The existing debt stands.';
    }

    preview.innerHTML =
        '<span class="formula-line">' + peso(limit) + ' limit &minus; ' + peso(owed) +
        ' owed = <strong>' + (room >= 0 ? peso(room) + ' available' : peso(-room) + ' over') +
        '</strong></span>' +
        '<span class="formula-verdict">' + verdict + '</span>';

    preview.classList.toggle('is-dynamic', standing !== 'Hold' && room > 0);
    preview.classList.toggle('is-stop', standing === 'Hold' || room < 0);
}

async function saveCreditLimit(event) {
    event.preventDefault();
    if (!creditCustomer) return;

    const form = event.target;
    const limit = Number(form.elements.creditLimit.value);
    const standing = form.elements.standing.value;
    const owed = Number(creditCustomer.current_credit) || 0;
    const name = creditCustomer.customer_name;

    // Two changes are worth stopping for: putting a stop on an account, and
    // setting a limit under what is already owed. Both are legitimate; both
    // are things somebody should mean to do.
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

// Two columns, side by side, on purpose. A purchase history says how good a
// customer somebody is and a payment history says how good a payer, and the
// shop needs to read both before extending anything. Stacked, the second one
// is below the fold and never gets read.
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
        detailField('Standing', standingBadge(r.standing || 'Good')) +
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

    // A decision already made stands. Reopening it would rewrite the reason an
    // extension was granted, which is the one thing an audit needs to keep.
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

    // A refusal with no reason is a question the cashier has to ask again
    // tomorrow, so declining says why or it does not happen.
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
        match: (d, query) =>
            (d.customer_name + ' ' + d.driver_name + ' ' + d.delivery_address)
                .toLowerCase().indexOf(query) !== -1,
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

// The stage counts above the table: a legend and a summary at once. Cash
// collection leads, because it is the one state that costs money to ignore.
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

function showRecordType(type, event) {
    if (event) event.preventDefault();
    recordType = type;

    document.querySelectorAll('[data-record-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.recordTab === type);
    });

    writeRecordHeaders();

    const panel = getDataPanel('mgr-records');
    if (!panel) return;

    // changing tab on a table already open loads the new kind straight away;
    // on a closed one it stays closed, because the tab was not a request for
    // data, it was a request to change what Load Data would fetch
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
        match: (row, query) =>
            Object.values(row).join(' ').toLowerCase().indexOf(query) !== -1,
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
        match: (a, query) =>
            (a.record_name + ' ' + (a.detail || '') + ' ' + a.module).toLowerCase().indexOf(query) !== -1,
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

// Restoring puts a record back into circulation, so the row opens it first.
// It used to be a button on every row of a table where every row looks alike.
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
        const totals = '<div class="detail-grid">' +
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
                it.quantity + ' ' + escapeHtml(it.unit_name || ''),
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

        const pages = [
            { label: 'Summary', body: summary },
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

    // the formula written out for this one product, so the number in the
    // Reorder At column can be checked rather than taken on trust
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
    showDeliveryRecord(panel ? panel.find(deliveryId, 'delivery_id') : null, true);
}

// the records popup pages its fields six at a time, so nothing has to scroll
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

// reached from the Repeat Customers report, which knows a customer id and
// nothing else about them
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
        buildCreditPanels();
        buildRecordsPanel();
        buildArchivePanel();

        writeRecordHeaders();
        renderIncomeRanges();
        applyExportPermissions();

        showManagerHome();
        loadNotifications();
    });
}
