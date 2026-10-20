// ============================================================
// manager.js -- the Manager dashboard
// Loaded by: manager.html
//
// What is in this file, from top to bottom:
//   - switching screens (showManagerPanel and the show... functions), and the
//     views inside Reports and Stocks, each opened from its own menu entry
//     (showPanelView)
//   - the Sales Summary: the period, the figures, the two tables
//   - saving tables as spreadsheets, and printing them (one Export menu each)
//   - reports, stocks, stock movements, the selling price and the reorder policy
//   - credit: customer limits and extension requests
//   - deliveries, records (suppliers, customers, products...), archives
//   - the Account Management screen: creating cashier, clerk and driver accounts,
//     the list of those accounts, and lifting a hold after wrong passwords (only
//     on the menu when the administrator switches it on)
//   - the popups that show one sale, delivery, customer, ... in full
//   - the page start-up code at the very bottom ("MANAGER PAGE BOOT")
// ============================================================

let recordType = 'supplier';
let incomeRange = { name: 'monthly', from: null, to: null };
let incomeData = null;

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

    const allPanels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < allPanels.length; i++) {
        const panel = allPanels[i];
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    }

    markPanelLinks(panelId);

    const heading = document.getElementById('manager-page-title');
    if (heading) heading.textContent = title;

    placePriceAlert();
    leaveScreenFurniture();
}

// A link that names a view inside a screen (an income table) is marked only
// when the screen is showing that view. A panel with data-panel-of (an
// order's document, Total Purchases) marks the screen it belongs to.
// A view with data-view-of (QR Payments) lights the entry of the view it is a tab of.
function markPanelLinks(panelId) {
    const panel = document.getElementById(panelId);
    let view = panel ? panel.dataset.view : undefined;
    const viewBox = view ? document.getElementById(view) : null;
    if (viewBox && viewBox.dataset.viewOf) view = viewBox.dataset.viewOf;
    const owner = (panel && panel.getAttribute('data-panel-of')) || panelId;

    const links = document.querySelectorAll('[data-panel-link]');
    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const wanted = link.dataset.panelView;
        link.classList.toggle('active',
            link.dataset.panelLink === owner && (!wanted || wanted === view));
    }
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

    const views = panel.querySelectorAll(':scope > .panel-view');

    // the view asked for if it is offered, else the first view offered, else the first view
    let view = null;
    for (let i = 0; i < views.length; i++) {
        if (views[i].id === viewId && viewOffered(panel, views[i].id)) {
            view = views[i];
            break;
        }
    }
    if (!view) {
        for (let i = 0; i < views.length; i++) {
            if (viewOffered(panel, views[i].id)) {
                view = views[i];
                break;
            }
        }
    }
    if (!view) view = views[0];
    if (!view) return null;

    for (let i = 0; i < views.length; i++) {
        views[i].hidden = views[i] !== view;
    }
    panel.dataset.view = view.id;

    const tabs = panel.querySelectorAll('[data-view-tab]');
    for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const current = tab.dataset.viewTab === view.id;
        tab.classList.toggle('is-current', current);
        tab.setAttribute('aria-selected', current ? 'true' : 'false');
    }

    showManagerPanel(panelId, title, event);
    return view.id;
}

// After the role's switches are applied: a group with no tabs left goes, and a
// screen showing a view that was just switched off moves to one still offered.
function syncViewNavs() {
    const tabbedPanels = document.querySelectorAll('.tabbed-panel');
    for (let p = 0; p < tabbedPanels.length; p++) {
        const panel = tabbedPanels[p];

        const groups = panel.querySelectorAll('.view-nav-group');
        for (let g = 0; g < groups.length; g++) {
            const group = groups[g];
            const tabs = group.querySelectorAll('[data-view-tab]');
            // the group goes when it has tabs and every one of them is hidden
            let allHidden = true;
            for (let t = 0; t < tabs.length; t++) {
                if (!tabs[t].hidden) allHidden = false;
            }
            group.hidden = tabs.length > 0 && allHidden;
        }

        const current = panel.dataset.view;
        if (current && !viewOffered(panel, current) && panel.style.display !== 'none') {
            if (panel.id === 'panel-reports') showReport(current);
            else if (panel.id === 'panel-stocks') showStockView(current);
        }
    }
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
function showDeliveries(event)    { showManagerPanel('panel-deliveries', 'Delivery History', event); }
function showCredit(event)         { showManagerPanel('panel-credit', 'Customer Credit', event); }
function showCreditRequests(event) { showManagerPanel('panel-credit-requests', 'Extension Requests', event); }
function showRecords(event)       { showRecordType(recordType, event); }
function showPurchasing(event)    { showPurchaseOrderHistory(event); }
function showArchives(event)      { showManagerPanel('panel-archives', 'Archives', event); }
// everything staff have filed: a screen of its own, apart from Reports
function showActivityLog(event)   { showManagerPanel('panel-activity', 'Activity Log', event); }
// Sales Transactions
function showSalesTransactions(event) { showReport('report-sales', event); }

// Policy Maintenance. Credit Maintenance: the shop's late-payment rate and the
// credit policy. Customer Data Terms and Refund Policy: their wording. Each page
// shows the back of the customer card beside it. Read again each time a page opens.
async function showCreditMaintenance(event) {
    showManagerPanel('panel-credit-maintenance', 'Credit Maintenance', event);
    const rateRead = await loadPenaltyPolicy();
    fillPenaltyForm(rateRead);
    await loadPolicies();
}

async function showDataTerms(event) {
    showManagerPanel('panel-data-terms', 'Customer Data Terms', event);
    await loadPolicies();
}

async function showRefundPolicy(event) {
    showManagerPanel('panel-refund-policy', 'Refund Policy', event);
    await loadPolicies();
}

// Account Management: the staff list is not read here; Load Data on the screen reads it
function showAccountManagement(event) {
    showManagerPanel('panel-accounts', 'Account Management', event);
}

// Sales Summary. The date picker is a Period box; Custom date shows two dates,
// From and To, beside it. A period counts back from today.
const INCOME_RANGES = [
    ['daily', 'Today', 0],
    ['weekly', 'Last 7 days', 6],
    ['monthly', 'Last 30 days', 29],
    ['quarterly', 'Last 90 days', 89],
    ['six-month', 'Last 6 months', 182],
    ['annual', 'Last 12 months', 364]
];

// The calendar day this browser is having, as the date inputs write it.
// toISOString() answers in UTC, which is yesterday for the first eight hours
// of every day here.
function localIsoDay(daysBack) {
    const now = new Date();
    now.setDate(now.getDate() - (daysBack || 0));
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Income and sales are only ever behind us: the pickers stop at today
function limitDatesToToday(ids) {
    const today = localIsoDay();
    for (let i = 0; i < ids.length; i++) {
        const input = document.getElementById(ids[i]);
        if (input) input.max = today;
    }
}

// The Period box: the named periods, then Custom date (the two dates beside it)
function renderIncomeRanges() {
    const select = document.getElementById('income-period');
    if (!select) return;

    let html = '';
    for (let i = 0; i < INCOME_RANGES.length; i++) {
        html += '<option value="' + INCOME_RANGES[i][0] + '">' + escapeHtml(INCOME_RANGES[i][1]) + '</option>';
    }
    html += '<option value="custom">Custom date...</option>';

    select.innerHTML = html;
    select.value = incomeRange.name;
    fillIncomeDates();
    showPeriodDates('income', incomeRange.name === 'custom');
}

// the two date boxes show the range in use
function fillIncomeDates() {
    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');
    if (!from || !to) return;

    if (incomeRange.name === 'custom') {
        from.value = incomeRange.from;
        to.value = incomeRange.to;
        return;
    }
    for (let i = 0; i < INCOME_RANGES.length; i++) {
        if (INCOME_RANGES[i][0] === incomeRange.name) {
            from.value = localIsoDay(INCOME_RANGES[i][2]);
            to.value = localIsoDay();
        }
    }
}

async function pickIncomeRange(name) {
    incomeRange = { name: name, from: null, to: null };
    renderIncomeRanges();
    await incomeRangeChanged();
}

// the Period box changed: a named period applies at once; Custom date shows the
// two dates and waits for them
function incomePeriodPicked(value) {
    if (value === 'custom') {
        showPeriodDates('income', true);
        const from = document.getElementById('income-from');
        if (from) from.focus();
        return;
    }
    pickIncomeRange(value);
}

// ==========================================
// THE PERIOD BOX ON EVERY DATE FILTER
// ==========================================
// Every report with dates has one Period box: All time, the named periods, and
// Custom date. Custom date shows From and To beside the box; any other choice
// hides them and fills them in itself, so whatever reads the two dates (the
// server's sales list, the QR list, a table's own filter) reads the period.
// The Sales Summary has its own box (above), without All time.
const PERIOD_CHOICES = [
    ['all', 'All time', null],
    ['daily', 'Today', 0],
    ['weekly', 'Last 7 days', 6],
    ['monthly', 'Last 30 days', 29],
    ['quarterly', 'Last 90 days', 89],
    ['six-month', 'Last 6 months', 182],
    ['annual', 'Last 12 months', 364]
];

// what each report does once its dates have changed
const PERIOD_APPLY = {
    sales: function () { reloadSales(); },
    unpaid: function () { dateFilterChanged('mgr-unpaid', 'unpaid'); },
    'stock-moves': function () { dateFilterChanged('mgr-stock-moves', 'stock-moves'); },
    all: function () { dateFilterChanged('mgr-all', 'all'); }
};

// shows or hides the From and To boxes beside a Period box
function showPeriodDates(prefix, show) {
    const ids = [prefix + '-from', prefix + '-to'];
    for (let i = 0; i < ids.length; i++) {
        const box = document.getElementById(ids[i]);
        const field = box ? box.closest('.toolbar-field') : null;
        if (field) field.hidden = !show;
    }
}

// the From and To a named period stands for ('' and '' for All time)
function periodDates(value) {
    for (let i = 0; i < PERIOD_CHOICES.length; i++) {
        if (PERIOD_CHOICES[i][0] !== value) continue;
        if (PERIOD_CHOICES[i][2] === null) return { from: '', to: '' };
        return { from: localIsoDay(PERIOD_CHOICES[i][2]), to: localIsoDay() };
    }
    return null;
}

// fills every Period box (data-period-for) with the choices, on All time
function buildPeriodBoxes() {
    const boxes = document.querySelectorAll('select[data-period-for]');
    for (let b = 0; b < boxes.length; b++) {
        let html = '';
        for (let i = 0; i < PERIOD_CHOICES.length; i++) {
            html += '<option value="' + PERIOD_CHOICES[i][0] + '">' + escapeHtml(PERIOD_CHOICES[i][1]) + '</option>';
        }
        html += '<option value="custom">Custom date...</option>';
        boxes[b].innerHTML = html;
        boxes[b].value = 'all';
    }
    syncPeriodBoxes();
}

// A Period box changed: Custom date shows the dates and waits for them; any
// other period fills them in and the report follows at once.
function periodPicked(prefix) {
    const select = document.getElementById(prefix + '-period');
    if (!select) return;

    if (select.value === 'custom') {
        showPeriodDates(prefix, true);
        const from = document.getElementById(prefix + '-from');
        if (from) from.focus();
        return;
    }

    showPeriodDates(prefix, false);
    const dates = periodDates(select.value);
    const from = document.getElementById(prefix + '-from');
    const to = document.getElementById(prefix + '-to');
    if (from) from.value = dates.from;
    if (to) to.value = dates.to;
    if (PERIOD_APPLY[prefix]) PERIOD_APPLY[prefix]();
}

// A table put back after a reload brings its dates back but not its Period
// box: dates that are not the period shown make the box read Custom date, with
// the dates beside it. Runs whenever a table changes.
function syncPeriodBoxes() {
    const boxes = document.querySelectorAll('select[data-period-for]');
    for (let b = 0; b < boxes.length; b++) {
        const prefix = boxes[b].dataset.periodFor;
        const from = document.getElementById(prefix + '-from');
        const to = document.getElementById(prefix + '-to');
        if (!from || !to) continue;

        if (boxes[b].value !== 'custom') {
            const dates = periodDates(boxes[b].value);
            if (!dates || dates.from !== from.value || dates.to !== to.value) boxes[b].value = 'custom';
        }
        showPeriodDates(prefix, boxes[b].value === 'custom');
    }
}

// a date typed or picked: once both are there and in order, the range is custom
async function incomeDatesPicked() {
    const from = document.getElementById('income-from');
    const to = document.getElementById('income-to');
    if (!from || !to || !from.value || !to.value) return;

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
    const select = document.getElementById('income-period');
    if (select) select.value = 'custom';
    await incomeRangeChanged();
}

// the period, for every cashier; the screen, the Spreadsheet and Print all use this
function incomeQuery() {
    if (incomeRange.name === 'custom') {
        return '?from=' + encodeURIComponent(incomeRange.from) + '&to=' + encodeURIComponent(incomeRange.to);
    }
    return '?range=' + encodeURIComponent(incomeRange.name);
}

// the figures are on screen (a table can be loaded without them)
let incomeSummaryShown = false;

// set when a sale or payment changed since incomeData was read
let incomeStale = false;

async function fetchIncome() {
    incomeData = await apiGetIncome(incomeQuery());
    incomeStale = false;
}

// Load Data: the figures and both tables for the chosen period
async function loadIncome() {
    await refreshIncome(true);
}

// A new period refreshes only what is already loaded. With nothing loaded
// yet it loads everything, as Load Data does.
async function incomeRangeChanged() {
    let anyOpen = incomeSummaryShown;
    for (let i = 0; i < INCOME_PANEL_KEYS.length; i++) {
        const panel = getDataPanel(INCOME_PANEL_KEYS[i]);
        if (!anyOpen && panel && panel.state !== 'closed') anyOpen = true;
    }
    await refreshIncome(!anyOpen);
}

async function refreshIncome(all) {
    const summary = all || incomeSummaryShown;

    try {
        await fetchIncome();
        if (summary) renderIncome();

        for (let i = 0; i < INCOME_PANEL_KEYS.length; i++) {
            const panel = getDataPanel(INCOME_PANEL_KEYS[i]);
            if (panel && (all || panel.state !== 'closed')) panel.open();
        }
    } catch (error) {
        notifyOffline();
    }
}

// Before Load Data the two cards are already there, so the table under them
// does not jump when the figures arrive.
function renderIncome() {
    const data = incomeData;
    const totals = data ? data.totals : null;

    if (data) {
        incomeSummaryShown = true;
        const note = document.getElementById('income-range-note');
        if (note) {
            // a custom range is already named by its dates
            const dates = data.range.from + ' to ' + data.range.to;
            note.textContent = data.range.label === dates ? dates : data.range.label + ': ' + dates;
        }
    }

    const notLoaded = 'Not loaded';
    const kpis = [
        ['Total Sales', totals ? peso(totals.billed) : notLoaded, 'total of every sale, paid or not', ''],
        ['Transactions', totals ? Number(totals.saleCount).toLocaleString('en-PH') : notLoaded, 'sales rung up', '']
    ];

    const grid = document.getElementById('income-kpis');
    if (grid) {
        let cards = '';
        for (let i = 0; i < kpis.length; i++) {
            const k = kpis[i];
            cards += '<div class="kpi-card ' + k[3] + '">' +
                '<span class="kpi-label">' + k[0] + '</span>' +
                '<span class="kpi-value">' + escapeHtml(k[1]) + '</span>' +
                '<span class="kpi-note">' + k[2] + '</span></div>';
        }
        grid.innerHTML = cards;
    }
}

// Every table can leave the page as a spreadsheet of every filtered row, or
// through the browser's print dialogue with the table unpaged. Both sit in one
// Export menu (buildExportMenus); each is dead until the table holds rows and
// follows it via 'datapanel:change'. The server lays the workbook out (spreadsheet.js), so
// every column is as wide as what it holds.
function canExportReports() {
    const user = getCurrentUser();
    return Boolean(user && user.role_name === 'Manager');
}

function applyExportPermissions() {
    if (canExportReports()) return;

    const buttons = document.querySelectorAll('[data-export]');
    for (let i = 0; i < buttons.length; i++) {
        buttons[i].remove();
    }
}

// Spreadsheet and Print / PDF go behind one Export button with a menu under it.
// The two buttons keep their own handlers and data-print-for; they only move.
function buildExportMenus() {
    const boxes = document.querySelectorAll('.panel-actions');
    for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        const buttons = box.querySelectorAll(':scope > [data-export]');
        if (buttons.length === 0) continue;

        const menu = document.createElement('div');
        menu.className = 'export-menu';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn btn-sm export-toggle';
        toggle.setAttribute('aria-haspopup', 'true');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = 'Export<span class="export-caret" aria-hidden="true">&#9660;</span>';
        toggle.disabled = true;
        toggle.addEventListener('click', function (event) {
            event.stopPropagation();
            const list = menu.querySelector('.export-menu-list');
            const open = list.hidden;
            closeExportMenus();
            list.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
        });

        const list = document.createElement('div');
        list.className = 'export-menu-list';
        list.setAttribute('role', 'menu');
        list.hidden = true;
        for (let i = 0; i < buttons.length; i++) {
            buttons[i].setAttribute('role', 'menuitem');
            buttons[i].addEventListener('click', closeExportMenus);
            list.appendChild(buttons[i]);
        }

        menu.appendChild(toggle);
        menu.appendChild(list);
        box.insertBefore(menu, box.firstChild);
    }

    document.addEventListener('click', function (event) {
        if (!event.target.closest('.export-menu')) closeExportMenus();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeExportMenus();
    });
}

function closeExportMenus() {
    const lists = document.querySelectorAll('.export-menu-list');
    for (let i = 0; i < lists.length; i++) {
        lists[i].hidden = true;
        const toggle = lists[i].parentElement.querySelector('.export-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
}

// "a, b" -> ['a', 'b']: split on commas, trim each, leave out empty ones
function printKeys(keys) {
    const parts = String(keys || '').split(',');
    const result = [];
    for (let i = 0; i < parts.length; i++) {
        const key = parts[i].trim();
        if (key) result.push(key);
    }
    return result;
}

function panelHasRows(key) {
    const panel = getDataPanel(key);
    return Boolean(panel && panel.state === 'ready' && panel.visible.length > 0);
}

// called whenever any table changes shape
function syncExportButtons() {
    const printButtons = document.querySelectorAll('[data-print-for]');
    for (let b = 0; b < printButtons.length; b++) {
        const button = printButtons[b];
        const keys = printKeys(button.dataset.printFor);
        let ready = false;
        for (let i = 0; i < keys.length; i++) {
            if (panelHasRows(keys[i])) ready = true;
        }
        button.disabled = !ready;

        if (ready) {
            if (button.dataset.printKind === 'sheet') {
                button.title = 'Save every row shown as an Excel file';
            } else {
                button.title = 'Print every row shown, or save it as a PDF';
            }
        } else {
            button.title = 'Load data first';
        }
    }

    // an Export button is live while anything in its menu is
    const menus = document.querySelectorAll('.export-menu');
    for (let m = 0; m < menus.length; m++) {
        const toggle = menus[m].querySelector('.export-toggle');
        const items = menus[m].querySelectorAll('.export-menu-list .btn');
        let any = false;
        for (let i = 0; i < items.length; i++) {
            if (!items[i].disabled) any = true;
        }
        toggle.disabled = !any;
        toggle.title = any ? 'Save as Excel, or print or save as PDF' : 'Load data first';
    }
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
    for (let h = 0; h < heads.length; h++) {
        const text = heads[h].textContent.trim();
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
    const money = [];   // the column numbers that hold money, each listed once
    const trs = scratch.querySelectorAll('tbody tr');
    for (let r = 0; r < trs.length; r++) {
        const tr = trs[r];
        const cells = [];
        for (let i = 0; i < tr.children.length; i++) {
            if (keep[i]) {
                const value = sheetCell(tr.children[i]);
                if (typeof value === 'number' && tr.children[i].textContent.includes('\u20B1')) {
                    if (money.indexOf(cells.length) === -1) money.push(cells.length);
                }
                cells.push(value);
            }
        }
        rows.push(cells);
    }

    const caption = table.closest('.tab-content, .card');
    let name = key;
    if (caption) {
        const heading = caption.querySelector('h3');
        if (heading && heading.textContent) name = heading.textContent;
    }

    return { name: String(name).trim(), headers: headers, rows: rows, money: money };
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

    const sheetKeys = printKeys(keys);
    const sheets = [];
    for (let i = 0; i < sheetKeys.length; i++) {
        const sheet = panelSheet(sheetKeys[i]);
        if (sheet) sheets.push(sheet);
    }
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
        window.setTimeout(function () {
            URL.revokeObjectURL(link.href);
        }, 2000);

        let total = 0;
        for (let i = 0; i < sheets.length; i++) total += sheets[i].rows.length;
        notifyInfo(total + (total === 1 ? ' row' : ' rows') + ' saved as ' + file + '.', 'Excel file saved');
    } catch (error) {
        notifyOffline();
    }
}

// ---------- paper ----------
// the browser's own print dialogue; the named tables are unpaged while it is open
let printRestore = null;

// The status cards over a table stay off the printout. Their figures are read
// back here as label/value rows, to go in a Totals table at the bottom of the
// report instead.

// The Deliveries printout holds only the rows the filters leave; the Totals
// table counts those rows in each of these fulfilment states, in this order.
const PRINT_DELIVERY_STATES = ['Pending Payment', 'Completed', 'Out for Delivery',
                               'In Transit', 'Pending', 'Delayed', 'Failed'];

function printTotalRows(container, panel) {
    const rows = [];

    const cards = container.querySelectorAll('.kpi-card');
    for (let i = 0; i < cards.length; i++) {
        const label = cards[i].querySelector('.kpi-label');
        const value = cards[i].querySelector('.kpi-value');
        if (label && value) {
            rows.push([label.textContent.trim(), value.textContent.trim()]);
        }
    }

    // the Deliveries printout counts the printed rows in each fulfilment state
    if (panel && panel.key === 'mgr-deliveries' && panel.state === 'ready') {
        let total = 0;
        for (let s = 0; s < PRINT_DELIVERY_STATES.length; s++) {
            let count = 0;
            for (let i = 0; i < panel.visible.length; i++) {
                if (panel.visible[i].fulfilment_state === PRINT_DELIVERY_STATES[s]) count++;
            }
            if (count === 0) continue;   // nothing of this kind is printed
            total += count;
            rows.push([PRINT_DELIVERY_STATES[s], String(count)]);
        }
        if (total > 0) {
            rows.push(['Total', String(total)]);
        }
    }

    return rows;
}

// puts the Totals table at the bottom of the report; its CSS shows it on paper only
function addPrintTotals(container, panel) {
    const rows = printTotalRows(container, panel);
    if (rows.length === 0) return null;

    const block = document.createElement('div');
    block.className = 'print-totals';
    let rowsHtml = '';
    for (let i = 0; i < rows.length; i++) {
        rowsHtml += '<tr><td>' + escapeHtml(rows[i][0]) + '</td>' +
            '<td class="cell-num">' + escapeHtml(rows[i][1]) + '</td></tr>';
    }
    block.innerHTML = '<h3>Totals</h3><table><tbody>' + rowsHtml + '</tbody></table>';
    container.appendChild(block);
    return block;
}

function printReport(keys) {
    // a credit page still on the paper is put back first
    if (typeof finishCreditPrint === 'function') finishCreditPrint();
    // a print still waiting to be put back (a second press) is finished first,
    // or its Totals table would be added twice
    if (printRestore) printRestore();

    if (!canExportReports()) {
        notifyWarning('Printing a report is a manager action.', 'Not allowed');
        return;
    }

    const panelKeys = printKeys(keys);
    const panels = [];
    for (let i = 0; i < panelKeys.length; i++) {
        const found = getDataPanel(panelKeys[i]);
        if (found) panels.push(found);
    }

    let anyReady = false;
    for (let i = 0; i < panels.length; i++) {
        if (panels[i].state === 'ready' && panels[i].visible.length > 0) anyReady = true;
    }
    if (panels.length > 0 && !anyReady) {
        notifyWarning('Load the table first. There is nothing on this screen to print yet.',
            'Nothing to print');
        return;
    }

    // remember each table's page size and page, to put them back after printing
    const saved = [];
    for (let i = 0; i < panels.length; i++) {
        saved.push({ panel: panels[i], pageSize: panels[i].pageSize, page: panels[i].page });
    }
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        if (panel.state !== 'ready') continue;
        panel.pageSize = Math.max(1, panel.visible.length);
        panel.page = 1;
        panel.render();
    }

    // the views of a tabbed screen share it; the one asked for is the one printed
    const targets = [];
    for (let i = 0; i < panels.length; i++) {
        const table = document.getElementById(panels[i].config.tableId);
        const card = table ? table.closest('.panel-view') : null;
        if (card) targets.push(card);
    }
    for (let i = 0; i < targets.length; i++) {
        targets[i].classList.add('is-print-target');
    }

    // the whole report each table belongs to (two tables of one report share it);
    // its status cards are hidden by the print CSS and listed as Totals at its foot
    const reports = [];
    const reportPanels = [];   // the first panel of each report, for its chip counts
    for (let i = 0; i < panels.length; i++) {
        const table = document.getElementById(panels[i].config.tableId);
        const report = table ? table.closest('.panel-view, [data-panel]') : null;
        if (report && reports.indexOf(report) === -1) {
            reports.push(report);
            reportPanels.push(panels[i]);
        }
    }
    const totalBlocks = [];
    for (let i = 0; i < reports.length; i++) {
        const block = addPrintTotals(reports[i], reportPanels[i]);
        if (block) totalBlocks.push(block);
    }

    document.body.classList.add('is-printing');

    // afterprint is the reliable signal; the timer covers a browser that never sends it
    printRestore = function () {
        if (!printRestore) return;
        printRestore = null;
        document.body.classList.remove('is-printing');
        for (let i = 0; i < targets.length; i++) {
            targets[i].classList.remove('is-print-target');
        }
        for (let i = 0; i < totalBlocks.length; i++) {
            totalBlocks[i].remove();
        }
        for (let i = 0; i < saved.length; i++) {
            const entry = saved[i];
            entry.panel.pageSize = entry.pageSize;
            if (entry.panel.state === 'ready') {
                entry.panel.page = entry.page;
                entry.panel.render();
            }
        }
    };

    window.addEventListener('afterprint', function once() {
        window.removeEventListener('afterprint', once);
        if (printRestore) printRestore();
    });

    window.print();
    window.setTimeout(function () {
        if (printRestore) printRestore();
    }, 1500);
}

// The Sales Summary's table, read from the one period
const INCOME_PANEL_KEYS = ['mgr-income-methods'];

// The one Load Data above fills the figures and the table for the period.
async function incomeRows(field) {
    if (!incomeData || incomeStale) await fetchIncome();
    return incomeData[field];
}

const INCOME_GATE = {
    title: 'Not loaded',
    text: 'Pick the dates above and press Load Data.',
    button: false
};

function buildIncomePanels() {
    renderIncome();

    // A payment taken at the counter or by a driver at the door changes what was
    // collected. The table below reads again through the usual live path
    // (PANEL_SCOPES in shared/live-sync.js: quietly when nobody is reading or
    // typing, otherwise a Refresh note); this only says the held figures are old.
    if (typeof onLiveChange === 'function') {
        onLiveChange(['sales', 'credit'], function () {
            incomeStale = true;
        });
    }

    createDataPanel({
        key: 'mgr-income-methods',
        remember: false,   // the period and cashier above are not kept, so it opens closed
        tableId: 'income-methods-table',
        columns: 5,
        pageSize: 5,
        sortKeys: ['payment_method', 'sale_count', 'billed', 'collected', 'outstanding'],
        pagerId: 'income-methods-pager',
        gate: INCOME_GATE,
        load: function () {
            return incomeRows('methods');
        },
        // the two figures above follow the table when it is read again
        onLoaded: function () {
            if (incomeSummaryShown) renderIncome();
        },
        renderRow: function (m) {
            return '<tr><td class="cell-name">' + escapeHtml(m.payment_method) + '</td>' +
                '<td class="cell-num">' + m.sale_count + '</td>' +
                '<td class="cell-num">' + peso(m.billed) + '</td>' +
                '<td class="cell-num">' + peso(m.collected) + '</td>' +
                '<td class="cell-num' + (Number(m.outstanding) > 0 ? ' cell-due' : '') + '">' +
                    peso(m.outstanding) + '</td></tr>';
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
    MISSING: 'Missing from delivery',
    REFUND: 'Refund report',
    RETURN: 'Return report',
    STOCK_ADJUST: 'Stock adjustment',
    DELIVERY: 'Delivery',
    PURCHASE_ORDER: 'Purchase order',
    PO_CONFIRMED: 'Order confirmed',
    PO_DECLINED: 'Order declined',
    PO_RECEIVED: 'Order received',
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
        filters: { kind: 'all', role: 'all', from: '', to: '' },
        sortKeys: ['happened_at', 'staff_name', 'role_name', function (row) { return activityKind(row.kind); }, 'details'],
        load: function () {
            return apiGetActivityReport();
        },
        match: function (row, query) {
            return prefixMatch([
                row.staff_name, row.role_name, activityKind(row.kind), row.details
            ], query);
        },
        filter: function (row, filters) {
            return (filters.kind === 'all' || activityKind(row.kind) === filters.kind) &&
                (filters.role === 'all' || row.role_name === filters.role) &&
                dateInRange(row.happened_at, filters.from, filters.to);
        },
        onLoaded: function (rows) {
            const kinds = [];
            const roles = [];
            for (let i = 0; i < rows.length; i++) {
                kinds.push(activityKind(rows[i].kind));
                roles.push(rows[i].role_name);
            }
            fillFilterOptions('all-kind', kinds, 'Every report');
            fillFilterOptions('all-role', roles, 'Every role');
        },
        renderRow: function (row, index) {
            return '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
                '<td class="cell-id">' + escapeHtml(activityWhen(row.happened_at)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.staff_name || 'Not recorded') + '</td>' +
                '<td>' + escapeHtml(row.role_name || '') + '</td>' +
                '<td>' + escapeHtml(activityKind(row.kind)) + '</td>' +
                '<td>' + escapeHtml(row.details || '') + '</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-unpaid',
        tableId: 'unpaid-table',
        columns: 6,
        pageSize: REPORT_ROWS_PER_PAGE,
        pagerId: 'unpaid-pager',
        idField: 'sale_id',
        filters: { status: 'all', method: 'all', from: '', to: '' },
        sortKeys: ['sale_id', 'customer_name', 'payment_method', 'payment_status', function (row) { return Number(row.balance_due); }, 'sale_date'],
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for every sale with money still owed on it.',
            button: 'Load Data'
        },
        load: async function () {
            const overview = await reportsOverview(true);
            return overview.unpaid;
        },
        match: function (row, query) {
            return prefixMatch([
                row.customer_name, row.payment_method, row.sale_id, '#' + row.sale_id
            ], query);
        },
        filter: function (row, filters) {
            return (filters.status === 'all' || row.payment_status === filters.status) &&
                (filters.method === 'all' || row.payment_method === filters.method) &&
                dateInRange(row.sale_date, filters.from, filters.to);
        },
        // the methods are a fixed list (every way a sale can be paid); the
        // statuses are the ones the loaded sales have
        onLoaded: function (rows) {
            const statuses = [];
            for (let i = 0; i < rows.length; i++) {
                statuses.push(rows[i].payment_status);
            }
            fillFilterOptions('unpaid-status', statuses, 'Every status');
            showUnpaidMethodField(document.getElementById('unpaid-status').value);
        },
        renderRow: function (u, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openSaleDetail(' + u.sale_id + ')">' +
                '<td class="cell-id">#' + u.sale_id + '</td>' +
                '<td class="cell-name">' + escapeHtml(u.customer_name) + '</td>' +
                '<td>' + escapeHtml(u.payment_method) + '</td>' +
                '<td>' + statusBadge(u.payment_status) + '</td>' +
                '<td class="cell-num cell-due">' + peso(u.balance_due) + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(u.sale_date).slice(0, 10)) + '</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-loyal',
        tableId: 'loyal-table',
        columns: 5,
        pageSize: REPORT_ROWS_PER_PAGE,
        pagerId: 'loyal-pager',
        idField: 'customer_id',
        filters: { balance: 'all' },
        sortKeys: ['customer_name', 'purchase_count', function (row) { return Number(row.total_spent); },
                   function (row) { return Number(row.balance_due); }, 'last_purchase'],
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for customers who have bought more than once.',
            button: 'Load Data'
        },
        load: async function () {
            const overview = await reportsOverview();
            return overview.loyal;
        },
        match: function (row, query) {
            return prefixMatch([row.customer_name], query);
        },
        filter: function (row, filters) {
            return repeatCustomerMatches(row, filters);
        },
        renderRow: function (c, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openCustomerDetail(' + c.customer_id + ')">' +
                '<td class="cell-name">' + escapeHtml(c.customer_name) + '</td>' +
                '<td class="cell-num">' + c.purchase_count + '</td>' +
                '<td class="cell-num">' + peso(c.total_spent) + '</td>' +
                '<td class="cell-num' + (Number(c.balance_due) > 0 ? ' cell-due' : '') + '">' +
                    peso(c.balance_due) + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(c.last_purchase).slice(0, 10)) + '</td></tr>';
        }
    });

}

// ---------- From and To on a report ----------
// The day part of a stamp ("2026-09-04 16:45:00" -> "2026-09-04") falls inside
// the two dates; an empty date leaves that end open.
function dateInRange(stamp, from, to) {
    const day = String(stamp || '').slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
}

// A From or To box changed on a report: the table keeps only those days.
// prefix names the boxes (prefix-from, prefix-to).
function dateFilterChanged(key, prefix) {
    const fromBox = document.getElementById(prefix + '-from');
    const toBox = document.getElementById(prefix + '-to');
    const from = fromBox ? fromBox.value : '';
    const to = toBox ? toBox.value : '';

    if (from && to && from > to) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    const panel = getDataPanel(key);
    if (!panel) return;
    panel.filters.from = from;
    panel.filters.to = to;
    if (panel.state === 'ready') {
        panel.page = 1;
        panel.apply();
    } else {
        panel.open();
    }
}

// Repeat Customers: with a balance, or without one
function repeatCustomerMatches(row, filters) {
    const owes = (Number(row.balance_due) || 0) > 0;
    if (filters.balance === 'owing' && !owes) return false;
    if (filters.balance === 'clear' && owes) return false;
    return true;
}

// A dropdown filled from the loaded rows: one option per value they hold,
// sorted, keeping the one already picked when it is still there.
// Receivables: the payment method is asked only with Every status or Partial.
// An Unpaid sale has had nothing paid on it, so the method box goes, and its
// choice goes back to Every method.
function showUnpaidMethodField(status) {
    const offered = status === 'all' || status === 'Partial';
    const field = document.getElementById('unpaid-method-field');
    if (field) field.hidden = !offered;
    return offered;
}

function unpaidStatusPicked(status) {
    const method = document.getElementById('unpaid-method');
    const offered = showUnpaidMethodField(status);
    if (!offered && method && method.value !== 'all') {
        method.value = 'all';
        dataPanelFilter('mgr-unpaid', 'method', 'all');
        syncFilteredColumns('unpaid-table');
    }
    dataPanelFilter('mgr-unpaid', 'status', status);
}

function fillFilterOptions(id, values, allLabel) {
    const select = document.getElementById(id);
    if (!select) return;
    const picked = select.value;

    // each value once (in the order first seen), as text, then sorted
    const unique = [];
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null || value === undefined || value === '') continue;
        if (!unique.includes(value)) unique.push(value);
    }
    for (let i = 0; i < unique.length; i++) {
        unique[i] = String(unique[i]);
    }
    unique.sort(function (a, b) {
        return a.localeCompare(b);
    });

    let html = '<option value="all">' + escapeHtml(allLabel) + '</option>';
    for (let i = 0; i < unique.length; i++) {
        html += '<option value="' + escapeHtml(unique[i]) + '">' + escapeHtml(unique[i]) + '</option>';
    }
    select.innerHTML = html;
    select.value = unique.indexOf(picked) !== -1 ? picked : 'all';
    if (select.dataset.filterTable) syncFilteredColumns(select.dataset.filterTable);
}

// the same, with how many rows hold each value: "Staff (3)"
function fillCountedOptions(id, values, allLabel) {
    const select = document.getElementById(id);
    if (!select) return;
    const picked = select.value;

    // each value (as text) once, with how many rows hold it: { value, count }
    const options = [];
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null || value === undefined || value === '') continue;
        const text = String(value);
        let option = null;
        for (let j = 0; j < options.length; j++) {
            if (options[j].value === text) {
                option = options[j];
                break;
            }
        }
        if (option === null) {
            options.push({ value: text, count: 1 });
        } else {
            option.count += 1;
        }
    }
    options.sort(function (a, b) {
        return a.value.localeCompare(b.value);
    });

    let html = '<option value="all">' + escapeHtml(allLabel) + ' (' + values.length + ')</option>';
    let pickedStillListed = false;
    for (let i = 0; i < options.length; i++) {
        html += '<option value="' + escapeHtml(options[i].value) + '">' + escapeHtml(options[i].value) +
            ' (' + options[i].count + ')</option>';
        if (options[i].value === picked) pickedStillListed = true;
    }
    select.innerHTML = html;
    select.value = pickedStillListed ? picked : 'all';
    if (select.dataset.filterTable) syncFilteredColumns(select.dataset.filterTable);
}

// Sales. Both filters go back to the server, where the figures are computed.
const SALE_STATUS_TONE = {
    'Paid': 'badge-success',
    'Partially Paid': 'badge-warning',
    'Unpaid': 'badge-danger',
    'Voided': 'badge-neutral'
};

// A sales date after today is a typo, not a filter: it is emptied with a
// warning and the list loads without it. True when something was dropped.
function dropFutureSalesDates() {
    const today = localIsoDay();
    let dropped = false;

    const ids = ['sales-from', 'sales-to'];
    for (let i = 0; i < ids.length; i++) {
        const input = document.getElementById(ids[i]);
        if (input && input.value && input.value > today) {
            input.value = '';
            dropped = true;
        }
    }

    if (dropped) {
        notifyWarning('Sales only go up to today. Pick dates on or before ' + today + '.',
            'That date has not happened yet');
    }
    return dropped;
}

// adds "key=value" to the list when the box has a real choice in it
function addSalesFilter(parts, id, key) {
    const field = document.getElementById(id);
    if (field && field.value && field.value !== 'all') {
        parts.push(key + '=' + encodeURIComponent(field.value));
    }
}

function salesQuery() {
    dropFutureSalesDates();

    const parts = [];

    addSalesFilter(parts, 'sales-method', 'method');
    addSalesFilter(parts, 'sales-status', 'status');
    addSalesFilter(parts, 'sales-from', 'from');
    addSalesFilter(parts, 'sales-to', 'to');

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
        // the boxes that load() reads, put back with the table after a reload
        inputs: ['sales-method', 'sales-status', 'sales-period', 'sales-from', 'sales-to'],
        sortKeys: ['sale_id', 'sale_date', 'customer_name', 'payment_group', 'transaction_status',
                   function (row) { return Number(row.final_amount); }],
        gate: {
            title: 'No sales loaded',
            text: 'Pick a payment method, a status or a date range above, then press Load Data.',
            button: 'Load Data'
        },
        load: function () {
            return apiGetSales(salesQuery());
        },
        match: function (s, query) {
            return prefixMatch([
                s.customer_name, s.cashier_name, s.payment_method, s.sale_id, '#' + s.sale_id
            ], query);
        },
        renderRow: function (s, index) {
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

function buildStockPanels() {
    createDataPanel({
        key: 'mgr-reorder',
        tableId: 'reorder-table',
        columns: 6,
        pagerId: 'reorder-pager',
        idField: 'product_id',
        filters: { status: 'all' },
        sortKeys: ['product_name', function (p) { return Number(p.quantity_in_stock); },
                   function (p) { return Number(p.effective_rop); },
                   function (p) { return Number(p.suggested_order); }, 'supplier_name', 'stock_status'],
        gate: {
            title: 'Reorder alerts not loaded',
            text: 'Press Load Data for every product at or below its reorder point.',
            button: 'Load Data'
        },
        load: async function () {
            const all = await stockRows();
            const low = [];
            for (let i = 0; i < all.length; i++) {
                if (all[i].stock_status !== 'In Stock') low.push(all[i]);
            }
            return low;
        },
        match: function (p, query) {
            return prefixMatch([p.product_name, p.supplier_name], query);
        },
        filter: function (p, filters) {
            return filters.status === 'all' || p.stock_status === filters.status;
        },
        renderRow: function (p, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openStockDetail(' + p.product_id + ')">' +
                '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
                '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
                '<td class="cell-num">' + p.effective_rop + '</td>' +
                '<td class="cell-num cell-due">' + p.suggested_order + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
                '<td>' + escapeHtml(p.supplier_name || 'No supplier') + '</td>' +
                '<td>' + statusBadge(p.stock_status) + '</td></tr>';
        }
    });

    createDataPanel({
        key: 'mgr-stocks',
        tableId: 'stocks-table',
        columns: 4,
        pagerId: 'stocks-pager',
        idField: 'product_id',
        filters: { status: 'all' },
        sortKeys: ['product_name', 'category_name', function (p) { return Number(p.quantity_in_stock); }, 'stock_status'],
        gate: {
            title: 'The stock report is not loaded',
            text: 'Search for a product, pick a status or a quantity, or press Load Data for the whole inventory.',
            button: 'Load Data'
        },
        load: function () {
            return stockRows();
        },
        match: function (p, query) {
            return prefixMatch([p.product_name, p.category_name, p.supplier_name], query);
        },
        filter: function (p, filters) {
            return filters.status === 'all' || p.stock_status === filters.status;
        },
        renderRow: function (p, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openStockDetail(' + p.product_id + ')">' +
                '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
                '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
                '<td class="cell-num">' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
                '<td>' + statusBadge(p.stock_status) + '</td></tr>';
        }
    });
}

// Stock Movements: the stock side of the activity log -- what staff filed that
// moved or will move goods on the shelf
const STOCK_MOVE_KINDS = ['STOCK_ADJUST', 'DAMAGE', 'MISSING', 'RETURN', 'PURCHASE_ORDER', 'PO_CONFIRMED', 'PO_DECLINED', 'PO_RECEIVED'];

function buildStockMovesPanel() {
    createDataPanel({
        key: 'mgr-stock-moves',
        tableId: 'stock-moves-table',
        columns: 5,
        pagerId: 'stock-moves-pager',
        filters: { kind: 'all', from: '', to: '' },
        sortKeys: ['happened_at', function (row) { return activityKind(row.kind); }, 'details', 'staff_name', 'role_name'],
        gate: {
            title: 'Not loaded',
            text: 'Press Load Data for the damage and return reports, stock adjustments and purchase orders staff have filed.',
            button: 'Load Data'
        },
        load: async function () {
            const all = await apiGetActivityReport();
            const moves = [];
            for (let i = 0; i < all.length; i++) {
                if (STOCK_MOVE_KINDS.includes(all[i].kind)) moves.push(all[i]);
            }
            return moves;
        },
        match: function (row, query) {
            return prefixMatch([row.staff_name, activityKind(row.kind), row.details], query);
        },
        filter: function (row, filters) {
            return (filters.kind === 'all' || row.kind === filters.kind) &&
                dateInRange(row.happened_at, filters.from, filters.to);
        },
        renderRow: function (row, index) {
            return '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
                '<td class="cell-id">' + escapeHtml(activityWhen(row.happened_at)) + '</td>' +
                '<td>' + escapeHtml(activityKind(row.kind)) + '</td>' +
                '<td>' + escapeHtml(row.details || '') + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.staff_name || 'Not recorded') + '</td>' +
                '<td>' + escapeHtml(row.role_name || '') + '</td></tr>';
        }
    });
}

// ==========================================
// THE PRICE -- asked for in a card, read back, then saved
// ==========================================
// finds the product with this id in the stocks kept from the last load, or undefined
function findCachedStock(productId) {
    const list = stocksCache || [];
    for (let i = 0; i < list.length; i++) {
        if (list[i].product_id === productId) return list[i];
    }
    return undefined;
}

// ==========================================
// THE NO-PRICE ALERT -- "3 products have no price set", on the screens it is about
// ==========================================
// A product the clerk adds has price 0. The strip says how many, and its button
// opens Records > Products with those products on the top rows. It shows on the
// Stocks screens and on Records > Products only (placePriceAlert), not across
// every screen. It reads the
// count again whenever the inventory moves (the live channel), after a price is
// saved here, and when the screens the administrator switched on are applied.
async function loadPriceBanner() {
    const box = document.getElementById('price-banner');
    if (!box) return;

    // the switches are not known yet, or this one is off: no strip, and no request that would be refused
    if (heldFeatureKeys === null || !holdsFeature('price-alert')) {
        box.innerHTML = '';
        return;
    }

    let count = 0;
    try {
        const result = await apiGetUnpricedCount();
        count = Number(result.unpriced) || 0;
    } catch (error) {
        return;   // the strip stays as it was; the next change reads it again
    }

    if (count === 0) {
        box.innerHTML = '';
        return;
    }

    const words = count === 1 ? '1 product has no price set' : count + ' products have no price set';
    let button = '';
    // Records > Products is where the price is set
    if (holdsFeature('records')) {
        button = '<button type="button" class="btn btn-sm" onclick="openUnpricedProducts()">Set prices</button>';
    }
    box.innerHTML = '<div class="banner banner-warn">' +
        '<span class="banner-text"><strong>Prices needed.</strong> ' + words +
        '. The till cannot sell ' + (count === 1 ? 'it' : 'them') + ' until ' + (count === 1 ? 'it has' : 'they have') +
        ' a price.</span>' + button + '</div>';
}

// Records > Products, read afresh with nothing in the search; products without a
// price come first on their own (see the records table's sort).
function openUnpricedProducts() {
    showRecordType('product');

    const panel = getDataPanel('mgr-records');
    if (!panel) return;

    const box = document.getElementById('records-search');
    if (box) box.value = '';
    panel.query = '';
    panel.resetHeaderSort();
    panel.open();
}

// The strip belongs to the screens about stock and products: it moves to the top
// of the Stocks screen or of Records when Products is showing, and hides elsewhere.
function placePriceAlert() {
    const alert = document.getElementById('price-alert');
    if (!alert) return;

    let home = null;
    const stocks = document.getElementById('panel-stocks');
    const records = document.getElementById('panel-records');
    if (stocks && stocks.style.display !== 'none') home = stocks;
    else if (records && records.style.display !== 'none' && recordType === 'product') home = records;

    // switched off for the role stays hidden (features.js would otherwise show it again)
    const switchedOff = heldFeatureKeys !== null && !holdsFeature('price-alert');
    if (!home || switchedOff) {
        alert.hidden = true;
        return;
    }
    if (alert.parentElement !== home) home.insertBefore(alert, home.firstChild);
    alert.hidden = false;
}

// reloads the stock tables and the product records that are showing, after a save
async function refreshStockPanels() {
    const keys = ['mgr-reorder', 'mgr-stocks', 'mgr-records'];
    for (let i = 0; i < keys.length; i++) {
        const panel = getDataPanel(keys[i]);
        if (panel && panel.state === 'ready') await panel.refresh();
    }
}

// The price is set on the product, in Records > Products. index is the row
// in that table; the row carries id, name, price, unit_name and quantity_in_stock.
async function changeProductPrice(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    if (!row) return;
    await changePrice({
        product_id: row.id, product_name: row.name, price: row.price,
        unit_name: row.unit_name, quantity_in_stock: row.quantity_in_stock
    });
}

async function changePrice(product) {
    if (!product) return;
    const productId = product.product_id;

    const current = Number(product.price) || 0;
    const unit = product.unit_name ? ' per ' + product.unit_name : '';
    const noPrice = isUnpriced(product);

    let askMessage = product.product_name + ' sells at ' + peso(current) + unit + '. What should it sell at now? ' +
                     'The till uses the new figure from the next sale on; nothing already sold changes.';
    if (noPrice) {
        askMessage = product.product_name + ' has no price yet, so the till cannot sell it. What should it sell at' +
                     unit + '? The till uses the figure from the next sale on.';
    }

    const asked = await askInput({
        title: noPrice ? 'Set the price' : 'Change the price',
        eyebrow: 'Products',
        message: askMessage,
        label: 'New price' + unit,
        type: 'number',
        value: noPrice ? '' : current.toFixed(2),
        placeholder: '0.00',
        confirmLabel: 'Next',
        check: function (value) {
            const typed = String(value).replace(/,/g, '').trim();
            const number = Number(typed);
            if (typed === '' || !Number.isFinite(number)) return 'Type the price as a figure, like 450 or 78.50.';
            if (number < 0) return 'A price cannot be below zero.';
            // the typed text is checked, not the float: 19.99 * 100 is 1998.9999999999998
            // (matches digits, then optionally a dot and one or two more digits)
            if (!/^\d+(\.\d{1,2})?$/.test(typed)) return 'Two decimal places at most.';
            if (noPrice && number === 0) return 'Type the figure it should sell at; zero means no price.';
            if (number === current) return 'That is the price it already sells at.';
            return null;
        }
    });

    if (asked === false || asked === null) return;

    const next = Math.round(Number(String(asked).replace(/,/g, '').trim()) * 100) / 100;
    const up = next > current;
    const share = current > 0 ? Math.abs(next - current) / current : null;
    const onHand = Number(product.quantity_in_stock) || 0;

    // " (up 12%)" or " (down 12%)", left out when the old price was zero
    let change = '';
    if (share !== null) {
        change = ' (' + (up ? 'up' : 'down') + ' ' + Math.round(share * 100) + '%)';
    }

    const yes = await askConfirm(
        noPrice
            ? product.product_name + ' will sell at ' + peso(next) + unit + '.'
            : product.product_name + ': ' + peso(current) + ' to ' + peso(next) + unit + change + '.',
        {
            title: noPrice ? 'Set the price?' : (up ? 'Raise the price?' : 'Lower the price?'),
            eyebrow: 'Products',
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
        await refreshStockPanels();
        loadPriceBanner();
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// THE REORDER POINT -- one figure, typed for each product
// ==========================================
async function changeReorderPoint(productId) {
    const product = findCachedStock(productId);
    if (!product) return;
    const unit = product.unit_name || 'units';

    const typed = await askInput({
        title: 'Change the reorder point',
        eyebrow: 'Reorder Alerts',
        message: product.product_name + ' reorders at ' + product.reorder_point + ' ' + unit +
            '. It shows on Reorder Alerts once the stock is at or below this figure.',
        label: 'Reorder point (' + unit + ')',
        type: 'number',
        value: String(product.reorder_point),
        confirmLabel: 'Save',
        check: function (value) {
            const text = String(value).trim();
            if (!/^\d+$/.test(text)) return 'Type a whole number, zero or more.';
            if (Number(text) === Number(product.reorder_point)) return 'That is the reorder point it already has.';
            return null;
        }
    });
    if (typed === false || typed === null || typed === undefined) return;

    try {
        const response = await apiSaveReorderPolicy(productId, { reorderPoint: parseInt(typed, 10) });
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }
        notifySuccess(result.message, 'Reorder point saved');
        closeModal('detail-modal');
        stocksCache = null;
        await refreshStockPanels();
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
        showLines: false,          // the manager's table has no Lines column
        showPanel: function (panelId, title) {
            showManagerPanel(panelId, title);
        },
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
// again after every save; what the strip above the credit records shows
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
        sortKeys: ['customer_name', function (r) { return Number(r.credit_limit); }, function (r) { return Number(r.current_credit); },
                   function (r) { return Number(r.available_credit); }, function (r) { return Number(r.open_sales); },
                   function (r) { return r.oldest_debt_days === null ? '' : Number(r.oldest_debt_days); }],
        pagerId: 'credit-pager',
        idField: 'customer_id',
        filters: { owing: 'all' },

        gate: {
            title: 'The credit records are not loaded',
            text: 'Search for a customer, filter by balance, or press Load Data for every account.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetCreditCustomers();
        },

        match: function (row, query) {
            return prefixMatch([row.customer_name, row.phone], query);
        },

        filter: function (row, filters) {
            const owed = Number(row.current_credit) || 0;
            const limit = Number(row.credit_limit) || 0;

            if (filters.owing === 'owing' && owed <= 0) return false;
            if (filters.owing === 'clear' && owed > 0) return false;
            if (filters.owing === 'over' && owed <= limit) return false;

            return true;
        },

        renderRow: function (row, index) {
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
        sortKeys: ['created_at', 'customer_name', function (r) { return Number(r.current_credit); },
                   function (r) { return Number(r.previous_limit); }, function (r) { return Number(r.requested_limit); },
                   'requested_by', 'status'],
        pagerId: 'requests-pager',
        idField: 'request_id',

        gate: {
            title: 'No requests loaded',
            text: 'Press Load Data for extension requests raised at the counter.',
            button: 'Load Data'
        },

        inputs: ['requests-status'],

        load: function () {
            const status = document.getElementById('requests-status');
            const value = status ? status.value : 'Pending';
            return apiGetCreditRequests(value);
        },

        match: function (row, query) {
            return prefixMatch([row.customer_name, row.requested_by], query);
        },

        renderRow: function (row, index) {
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
    if (typeof onLiveChange === 'function') {
        onLiveChange(['credit'], function () {
            loadPenaltyPolicy();
        });
    }
}

// ---------- the late-payment policy ----------
// 1 to 3 percent a month of the goods still unpaid, for every month a credit
// sale is past its 30-day due date; the default is 3. The manager may set
// another rate for the shop on the Credit Maintenance screen; an account can
// be given its own rate on its credit terms.
// answers true when the rate was read, false when it could not be
async function loadPenaltyPolicy() {
    try {
        penaltyPolicy = await apiGetPenaltyPolicy();
    } catch (error) {
        return false;   // the screen keeps whatever it last showed
    }
    return true;
}

// Puts the saved rate in the box, with its worked example. When the rate could not be
// read (rateRead is false) the box stays empty and Save is off: saving a guessed 3 would
// replace the real rate.
function fillPenaltyForm(rateRead) {
    const form = document.getElementById('penalty-form');
    if (!form) return;

    const note = document.getElementById('penalty-read-note');
    const saveButton = document.getElementById('penalty-save-btn');
    if (note) note.hidden = rateRead;
    if (saveButton) saveButton.disabled = !rateRead;
    form.elements.penaltyRate.disabled = !rateRead;

    if (!rateRead) {
        form.elements.penaltyRate.value = '';
        document.getElementById('penalty-preview').hidden = true;
        return;
    }

    const pct = Number(penaltyPolicy.penalty_rate);
    form.elements.penaltyRate.value = Number.isFinite(pct) ? pct.toFixed(2) : '';
    document.getElementById('penalty-preview').hidden = false;
    previewPenaltyPolicy();
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
        const rateRead = await loadPenaltyPolicy();
        fillPenaltyForm(rateRead);
    } catch (error) {
        notifyOffline();
    }
}

// ---------- the policies and the back of the customer card ----------
// Three texts, one line to a term: the credit policy, the customer data terms
// and the refund policy. All three print on the back of the customer card;
// the credit policy also prints on the credit terms page.
const POLICY_KINDS = ['credit', 'data-terms', 'refund'];
let policyData = null;      // what /api/policies answered: { policies, store }

async function loadPolicies() {
    try {
        policyData = await apiGetPolicies();
    } catch (error) {
        explainReadFailure(error, 'The policies could not be read.', 'Nothing to show');
        return;
    }
    for (let i = 0; i < POLICY_KINDS.length; i++) {
        const form = document.getElementById('policy-form-' + POLICY_KINDS[i]);
        const policy = policyData.policies[POLICY_KINDS[i]];
        if (form && policy) form.elements.text.value = policy.text;
    }
    previewCardBack();
}

// the text of a policy as it stands: what is typed in its box, else what was read
function policyTextNow(kind) {
    const form = document.getElementById('policy-form-' + kind);
    if (form) return form.elements.text.value;
    return policyData && policyData.policies[kind] ? policyData.policies[kind].text : '';
}

// Draws the back of the card beside each policy page, with what is typed now,
// scaled to the width of its column, and says when the text has to shrink too
// far to be read on a card that size.
function previewCardBack() {
    if (!policyData) return;
    const policies = {};
    for (let i = 0; i < POLICY_KINDS.length; i++) {
        policies[POLICY_KINDS[i]] = cardPolicyLines(policyTextNow(POLICY_KINDS[i]));
    }

    const boxes = document.querySelectorAll('[data-card-preview]');
    for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const kind = box.dataset.cardPreview;
        box.innerHTML = customerCardBackHtml(policyData.store, policies, kind);
        const card = box.querySelector('.cc-card');

        // a page out of sight has no width to measure; it is drawn again when opened
        if (box.clientWidth === 0) continue;
        const size = fitCustomerCard(card);
        const scale = box.clientWidth / card.offsetWidth;
        card.style.transform = 'scale(' + scale + ')';
        box.style.height = (card.offsetHeight * scale) + 'px';

        const fit = document.querySelector('[data-card-fit="' + kind + '"]');
        if (fit && size !== null) {
            const tooSmall = size < CARD_SMALLEST_READABLE_PT;
            fit.hidden = false;
            fit.classList.toggle('is-warn', tooSmall);
            fit.textContent = tooSmall
                ? 'The policies print at ' + size + ' pt on the card, too small to read. Shorten them.'
                : 'The policies print at ' + size + ' pt on the card. The dashed box is the one on this page.';
        }
    }
}

window.addEventListener('resize', function () { previewCardBack(); });

function useDefaultPolicy(kind) {
    const form = document.getElementById('policy-form-' + kind);
    if (!form || !policyData || !policyData.policies[kind]) return;
    form.elements.text.value = policyData.policies[kind].defaultText;
    previewCardBack();
}

async function savePolicyText(event, kind) {
    event.preventDefault();
    const form = event.target;

    const lines = cardPolicyLines(form.elements.text.value);
    if (lines.length > 20) {
        notifyWarning('At most 20 lines can be saved. Put each term on its own line.', 'Not saved');
        return;
    }

    try {
        const response = await apiSavePolicy(kind, form.elements.text.value);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Not saved');
            return;
        }

        notifySuccess(result.message, CARD_POLICY_TITLES[kind] + ' saved');
        await loadPolicies();   // an emptied box comes back as the default wording
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

        showCreditTab('account');

        showModal('credit-modal');

        creditHistory = null;
    } catch (error) {
        explainReadFailure(error, 'That credit account could not be opened.', 'Nothing to show');
    }
}

// 'account', or one table of the history: 'purchases', 'payments' or 'requests'
let creditTab = 'account';

function showCreditTab(tab) {
    creditTab = tab;
    const history = tab !== 'account';
    document.getElementById('credit-account-tab').style.display = history ? 'none' : 'block';
    document.getElementById('credit-history-tab').style.display = history ? 'block' : 'none';
    const tabs = ['account', 'purchases', 'payments', 'requests'];
    for (let i = 0; i < tabs.length; i++) {
        const button = document.getElementById('credit-tab-' + tabs[i]);
        if (button) button.classList.toggle('active', tabs[i] === tab);
    }

    if (history) loadCreditHistory();
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

// one table to a tab (Purchases, Payments, Extension Requests), each paged with
// Previous and Next rather than scrolled
function renderCreditHistory(data) {
    const box = document.getElementById('credit-history');
    if (!box) return;

    const purchaseRows = [];
    for (let i = 0; i < data.purchases.length; i++) {
        const p = data.purchases[i];
        purchaseRows.push([
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
        ]);
    }
    const purchases = pagedTable('mgr-purchases', ['Date', 'Sale', 'Amount', 'Balance'],
        purchaseRows, [2, 3], { empty: 'Nothing bought yet.' });

    const paymentRows = [];
    for (let i = 0; i < data.payments.length; i++) {
        const p = data.payments[i];
        paymentRows.push([
            escapeHtml(String(p.payment_date).slice(0, 10)),
            peso(p.amount),
            escapeHtml(p.payment_method),
            p.sale_id ? '#' + p.sale_id : '<span class="muted">On account</span>'
        ]);
    }
    const payments = pagedTable('mgr-payments', ['Date', 'Amount', 'Method', 'Receipt'],
        paymentRows, [1], { empty: 'No payments recorded.' });

    const requestRows = [];
    for (let i = 0; i < data.requests.length; i++) {
        const r = data.requests[i];
        requestRows.push([
            escapeHtml(String(r.created_at).slice(0, 10)),
            peso(r.previous_limit),
            peso(r.requested_limit),
            escapeHtml(r.status) + (r.decided_by ? ' <span class="muted">' +
                escapeHtml(r.decided_by) + '</span>' : '')
        ]);
    }
    const requests = pagedTable('mgr-credit-requests', ['Date Requested', 'From', 'To', 'Outcome'],
        requestRows, [1, 2], { empty: 'No requests yet.' });

    if (creditTab === 'purchases') {
        box.innerHTML = '<h4 class="history-head">Purchase History' +
            '<span class="history-total">' + peso(data.credit.total_purchase) + '</span></h4>' + purchases;
    } else if (creditTab === 'payments') {
        box.innerHTML = '<h4 class="history-head">Credit Payments' +
            '<span class="history-total">' +
                (Number(data.credit.current_credit) > 0
                    ? '<span class="cell-due">' + peso(data.credit.current_credit) + ' balance</span>'
                    : 'No balance') +
            '</span></h4>' + payments;
    } else {
        box.innerHTML = '<h4 class="history-head">Extension Requests</h4>' + requests;
    }
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
        : 'Pending';
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

        const keys = ['mgr-requests', 'mgr-credit'];
        for (let i = 0; i < keys.length; i++) {
            const panel = getDataPanel(keys[i]);
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
    'Pending Payment': 'badge-warning',
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
        filters: { state: 'all', driver: 'all' },
        sortKeys: ['delivery_id', 'customer_name', 'delivery_address', 'driver_name', 'scheduled_date',
                   function (d) { return Number(d.balance_due); }, 'fulfilment_state'],
        gate: {
            title: 'Delivery history not loaded',
            text: 'Press Load Data for every delivery on record, or filter by fulfilment first.',
            button: 'Load Data'
        },
        load: function () {
            return apiGetDeliveries();
        },
        match: function (d, query) {
            return prefixMatch([d.customer_name, d.driver_name, d.delivery_address], query);
        },
        filter: function (d, filters) {
            return (filters.state === 'all' || d.fulfilment_state === filters.state) &&
                (filters.driver === 'all' || d.driver_name === filters.driver);
        },
        onLoaded: function (rows) {
            renderDriverOptions(rows);
        },
        renderRow: function (d, index) {
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

// The Driver box: "All drivers", "Unassigned", then each driver found in the
// deliveries. The names come from the loaded rows, so it fills when they arrive.
function renderDriverOptions(rows) {
    const select = document.getElementById('deliveries-driver');
    if (!select) return;

    const names = [];
    for (let i = 0; i < rows.length; i++) {
        const d = rows[i];
        if (d.driver_name !== 'Unassigned' && names.indexOf(d.driver_name) === -1) {
            names.push(d.driver_name);
        }
    }

    // rebuilding the options must not lose the driver already chosen, even if
    // none of the loaded deliveries is theirs any more: the box has to show
    // the filter that is applied
    const panel = getDataPanel('mgr-deliveries');
    const chosen = panel ? panel.filters.driver : 'all';
    if (chosen !== 'all' && chosen !== 'Unassigned' && names.indexOf(chosen) === -1) {
        names.push(chosen);
    }
    names.sort(function (a, b) {
        return a.localeCompare(b);
    });

    let html = '<option value="all">All drivers</option><option value="Unassigned">Unassigned</option>';
    for (let i = 0; i < names.length; i++) {
        html += '<option value="' + escapeHtml(names[i]) + '">' + escapeHtml(names[i]) + '</option>';
    }
    select.innerHTML = html;
    select.value = chosen;
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

// the module name the archive routes know each kind of record by
const RECORD_ARCHIVE_MODULE = {
    supplier: 'Supplier', customer: 'Customer', product: 'Inventory',
    category: 'Category', unit: 'Unit'
};

// the kinds of record the manager edits here (categories and units are the clerk's)
// a product is edited by the inventory clerk only; the manager sets its price and archives it
const RECORD_EDITABLE = ['supplier', 'customer'];

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

    // the search box names what it searches
    const search = document.getElementById('records-search');
    if (search) search.placeholder = 'Search ' + RECORD_TITLES[type];
    placePriceAlert();

    const panel = getDataPanel('mgr-records');
    if (!panel || !changed) return;
    panel.resetHeaderSort();

    // a table already open loads the new kind at once; a closed one stays closed
    if (panel.state === 'ready') panel.open();
    else panel.reset();
}

function writeRecordHeaders() {
    const table = document.getElementById('records-table');
    if (!table) return;

    const columns = RECORD_COLUMNS[recordType];
    let headers = '';
    for (let i = 0; i < columns.length; i++) {
        headers += '<th>' + columns[i][1] + '</th>';
    }
    table.querySelector('thead tr').innerHTML = headers;

    const panel = getDataPanel('mgr-records');
    if (panel) {
        panel.config.columns = columns.length;
        const keys = [];
        for (let i = 0; i < columns.length; i++) {
            const field = columns[i][0];
            keys.push(RECORD_NUMERIC.indexOf(field) !== -1
                ? function (row) { return Number(row[field]); }
                : field);
        }
        panel.config.sortKeys = keys;
        panel.resetHeaderSort();
    }
}

function buildRecordsPanel() {
    createDataPanel({
        key: 'mgr-records',
        remember: false,   // which kind of record it holds is not kept, so it opens closed
        tableId: 'records-table',
        columns: 5,
        pagerId: 'records-pager',
        gate: {
            title: 'No records loaded',
            text: 'Pick a kind of record above, then press Load Data.',
            button: 'Load Data'
        },
        sortKeys: [],      // filled for the kind of record (writeRecordHeaders)
        load: function () {
            return apiGetRecords(recordType);
        },
        match: function (row, query) {
            // every value in the row
            const values = [];
            for (const field in row) {
                values.push(row[field]);
            }
            return prefixMatch(values, query);
        },
        sort: function (rows) {
            // a product with no price yet is always on the top row, whatever the header sort
            if (recordType === 'product') return unpricedFirst(rows);
            return rows;
        },
        renderRow: function (row, index) {
            const columns = RECORD_COLUMNS[recordType];

            let cells = '';
            for (let position = 0; position < columns.length; position++) {
                const column = columns[position];
                const value = row[column[0]];
                const money = MONEY_FIELDS.indexOf(column[0]) !== -1;
                let shown;
                if (money && recordType === 'product' && column[0] === 'price') {
                    shown = priceOrBadge(row);
                } else if (money) {
                    shown = peso(value);
                } else if (value === null || value === undefined || value === '') {
                    shown = '<span class="muted">Not set</span>';
                } else {
                    shown = escapeHtml(value);
                }

                let style;
                if (position === 0) {
                    style = 'cell-name';
                } else if (RECORD_NUMERIC.indexOf(column[0]) !== -1) {
                    // a figure (count, quantity or money) sits on the right
                    style = 'cell-num';
                } else {
                    style = '';
                }

                cells += '<td class="' + style + '">' + shown + '</td>';
            }

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openRecordDetail(' + index + ')">' + cells + '</tr>';
        }
    });
}

// the columns that hold a figure, and so can be sorted by size
const RECORD_NUMERIC = ['product_count', 'purchase_count', 'credit_limit', 'current_credit',
                        'price', 'quantity_in_stock', 'total_stock'];

// ---------- adding a supplier (the manager's alone) ----------
// Categories and units are added by the inventory clerk, from the clerk's Records.
const RECORD_ADDABLE = {
    supplier: { title: 'Add Supplier', label: 'Company name', max: 100 }
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
    setTimeout(function () {
        document.getElementById('record-add-name').focus();
    }, 60);
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
// ARCHIVES -- customers, products, units, categories, suppliers and users
// (staff accounts). Sales, deliveries and credit are never archived.
// ==========================================
// the kind of data each archived record is, in plain words
const ARCHIVE_TYPE_NAMES = {
    Customer: 'Customer', Inventory: 'Product', Unit: 'Unit',
    Category: 'Category', Supplier: 'Supplier', Staff: 'User'
};

function archiveTypeName(module) {
    return ARCHIVE_TYPE_NAMES[module] || module;
}

function buildArchivePanel() {
    createDataPanel({
        key: 'mgr-archives',
        tableId: 'archives-table',
        columns: 5,
        sortKeys: [function (a) { return archiveTypeName(a.module); }, 'record_name', 'detail', 'archived_at', 'archived_by'],
        pagerId: 'archives-pager',
        filters: { type: 'all' },
        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for every archived customer, product, unit, category, supplier and user.',
            button: 'Load Data'
        },
        load: function () {
            return apiGetArchives();
        },
        match: function (a, query) {
            return prefixMatch([a.record_name, a.detail, archiveTypeName(a.module), a.archived_by], query);
        },
        filter: function (a, filters) {
            return filters.type === 'all' || archiveTypeName(a.module) === filters.type;
        },
        onLoaded: function (rows) {
            const types = [];
            for (let i = 0; i < rows.length; i++) {
                types.push(archiveTypeName(rows[i].module));
            }
            fillCountedOptions('archives-type', types, 'Every type');
        },
        renderRow: function (a, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openArchiveEntry(' + index + ')">' +
                '<td>' + statusBadge(archiveTypeName(a.module)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(a.record_name) + '</td>' +
                '<td>' + escapeHtml(a.detail || '') + '</td>' +
                '<td class="cell-id">' + escapeHtml(a.archived_at || 'Unknown') + '</td>' +
                '<td>' + escapeHtml(a.archived_by || 'Not recorded') + '</td></tr>';
        }
    });
}

// restoring puts a record back into circulation, so the row opens it first
function openArchiveEntry(index) {
    const panel = getDataPanel('mgr-archives');
    const entry = panel ? panel.visible[index] : null;
    if (!entry) return;

    const type = archiveTypeName(entry.module);
    const body = '<div class="detail-grid">' +
        detailField('Type', statusBadge(type)) +
        detailField('Record', escapeHtml(entry.record_name)) +
        detailField('Detail', escapeHtml(entry.detail || 'None recorded')) +
        detailField('Archived On', escapeHtml(entry.archived_at || 'Not recorded')) +
        detailField('Archived By', escapeHtml(entry.archived_by || 'Not recorded')) +
        '</div>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-success" onclick="restoreArchive(\'' +
            entry.module + '\', ' + entry.record_id + ')">Restore This Record</button>' +
        '</div>';

    openDetailModal(entry.record_name, type + ' · archived',
        initialsOf(entry.record_name), [{ label: 'Archived Record', body: body }]);
}

async function restoreArchive(module, recordId) {
    const yes = await askConfirm(
        'This ' + archiveTypeName(module).toLowerCase() + ' record goes back into circulation and appears on the ' +
        'normal lists again.',
        {
            title: 'Restore this record?',
            eyebrow: 'Archives',
            confirmLabel: 'Restore the record',
            detail: [
                'It reappears on every list that shows its type of record.',
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

        // every list the record comes back to reads it again, not only the archive
        let keys = ['mgr-archives'];
        if (module === 'Inventory') {
            keys = keys.concat(['mgr-stocks', 'mgr-reorder', 'mgr-stock-moves', 'mgr-records', 'mgr-po']);
        } else if (module === 'Staff') {
            keys = keys.concat(['mgr-staff']);
        } else {
            keys = keys.concat(['mgr-records', 'mgr-credit']);
        }
        for (let i = 0; i < keys.length; i++) {
            const panel = getDataPanel(keys[i]);
            if (panel && panel.state === 'ready') await panel.refresh();
        }
        // a restored product with no price counts again
        if (module === 'Inventory') loadPriceBanner();
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// POPUP BUILDERS, ONE PER MODULE
// ==========================================
// how a QR payment reads in a sale's Payments: "GCash", "Maya", or
// "Bank Transfer · BPI" when the customer paid through their bank
const SALE_QR_WALLETS = { GCash: 'GCash', PayMaya: 'Maya', 'Bank Transfer': 'Bank Transfer' };

function saleQrWallet(q) {
    const way = SALE_QR_WALLETS[q.wallet] || q.wallet || 'QR';
    if (q.wallet === 'Bank Transfer' && q.bank_name) return way + ' \u00b7 ' + q.bank_name;
    return way;
}

// A sale opened from a report (Sales Transactions, Receivables) is only read:
// reports do not change data, so there is no Void button.
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
            detailField('Reference No', paymentReference(s.payment_method, s.reference_no)
                ? escapeHtml(paymentReference(s.payment_method, s.reference_no)) : '<span class="muted">None</span>') +
            '</div>';

        const balance = saleAmountDue(s) - Number(s.amount_paid);
        const units = pieceCount(data.items);
        let lineNote = '';
        if (data.items.length !== units) {
            lineNote = ' (' + data.items.length + (data.items.length === 1 ? ' line)' : ' lines)');
        }
        const totals = '<div class="detail-grid">' +
            detailField('Items Purchased', units + lineNote) +
            detailField('Gross Total', peso(s.total_amount)) +
            detailField('Discount', peso(s.discount)) +
            (Number(s.penalty_amount) > 0
                ? detailField('Late Penalty', '<span class="cell-due">' + peso(s.penalty_amount) + '</span> ' +
                    '<span class="muted">' + penaltyRateWord(s.penalty_rate) + ' a month for ' + s.penalty_months +
                    (Number(s.penalty_months) === 1 ? ' month' : ' months') + ' overdue, last charged ' +
                    escapeHtml(String(s.penalty_applied_at || '').slice(0, 10)) + '</span>')
                : '') +
            (Number(s.returned_total) > 0
                ? detailField('Refunded', peso(s.returned_total))
                : '') +
            (Number(s.refunded_amount) > 0
                ? detailField('Taken Off the Balance', peso(s.refunded_amount) + ' <span class="muted">of the refund came off what the customer owed</span>')
                : '') +
            detailField('Amount Due', peso(saleAmountDue(s))) +
            detailField('Amount Paid', peso(s.amount_paid)) +
            detailField('Change Given', peso(s.change_given)) +
            detailField('Balance Due', '<span class="' + (balance > 0 ? 'cell-due' : '') + '">' + peso(balance) + '</span>') +
            '</div>';

        const itemRows = [];
        for (let i = 0; i < data.items.length; i++) {
            const it = data.items[i];
            itemRows.push([
                escapeHtml(it.product_name),
                escapeHtml(qtyText(it.quantity, it.unit_name)),
                peso(it.unit_price),
                peso(it.subtotal)
            ]);
        }
        const items = detailTable(['Product', 'Qty', 'Unit Price', 'Subtotal'], itemRows, [1, 2, 3]);

        // Every sale is paid somehow, so every sale lists its payments:
        //  - the payments recorded against it (a credit sale's down payment and
        //    every payment after, one row each);
        //  - the GCash, Maya or bank-transfer codes paid by QR, once each (a QR
        //    payment already on the list by its reference is not repeated; one
        //    that paid a down payment gives that row its reference);
        //  - what the till took when the sale was rung up and paid there (a cash
        //    sale, a cheque), which is kept on the sale itself: whatever was kept
        //    (handed over less the change) that the rows above do not account for.
        const paidList = [];
        const references = {};
        let listed = 0;
        for (let i = 0; i < data.payments.length; i++) {
            const p = data.payments[i];
            if (p.reference_no) references[p.reference_no] = true;
            listed += Number(p.amount) || 0;
            paidList.push({ when: String(p.payment_date || ''), amount: p.amount, method: p.payment_method,
                            reference: paymentReference(p.payment_method, p.reference_no), by: p.received_by,
                            downPayment: p.reference_no === DOWN_PAYMENT_NOTE });
        }

        const kept = Math.max((Number(s.amount_paid) || 0) - (Number(s.change_given) || 0), 0);
        let unlisted = kept - listed;

        const qrPaid = data.qrPayments || [];
        for (let i = 0; i < qrPaid.length; i++) {
            const q = qrPaid[i];
            if (q.status !== 'paid' || (q.provider_payment_id && references[q.provider_payment_id])) continue;
            const amount = Number(q.amount) || 0;
            // a QR payment that was the down payment: that row carries its reference
            let downRow = null;
            for (let r = 0; r < paidList.length; r++) {
                if (paidList[r].downPayment && !paidList[r].reference &&
                    Math.abs(Number(paidList[r].amount) - amount) < 0.005) {
                    downRow = paidList[r];
                    break;
                }
            }
            if (downRow) {
                downRow.reference = q.provider_payment_id || '';
                continue;
            }
            paidList.push({ when: String(q.paid_at || q.created_at || ''), amount: amount,
                            method: saleQrWallet(q), reference: q.provider_payment_id, by: q.received_by });
            unlisted -= amount;
        }

        // paid at the till when it was rung up, and not on the list yet
        if (unlisted > 0.005 && s.payment_method !== 'Credit') {
            paidList.push({ when: String(s.sale_date || ''), amount: unlisted, method: s.payment_method,
                            reference: paymentReference(s.payment_method, s.reference_no),
                            by: s.cashier_name });
        }
        paidList.sort(function (a, b) { return a.when.localeCompare(b.when); });

        const paymentRows = [];
        for (let i = 0; i < paidList.length; i++) {
            const p = paidList[i];
            paymentRows.push([
                escapeHtml(p.when.replace('T', ' ').slice(0, 16)),
                peso(p.amount),
                escapeHtml(p.method || ''),
                p.reference ? escapeHtml(p.reference) : '<span class="muted">None</span>',
                escapeHtml(p.by || 'Unknown')
            ]);
        }
        const payments = detailTable(['Date', 'Amount', 'Method', 'Reference', 'Received By'],
            paymentRows, [1]);

        const pages = [
            { label: 'Summary', body: summary },
            { label: 'Totals', body: totals },
            { label: 'Items (' + data.items.length + ')', body: items },
            { label: 'Payments (' + paidList.length + ')', body: payments }
        ];

        // a cheque's or a bank transfer's bank and account
        const detailItems = paymentDetailItems(data);
        if (detailItems.length > 0) {
            let detailsBody = '';
            for (let i = 0; i < detailItems.length; i++) {
                detailsBody += '<p class="detail-note">' +
                    escapeHtml(paymentDetailsSummary(detailItems[i].detail, detailItems[i].reference)) + '</p>';
            }
            pages.push({ label: 'Payment Details', body: detailsBody });
        }

        if (data.delivery) {
            const d = data.delivery;
            const owed = saleAmountDue(s) - Number(s.amount_paid);
            let state;
            if (d.status !== 'Delivered') {
                state = d.status;
            } else if (owed > 0) {
                state = 'Pending Payment';
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

function openStockDetail(productId) {
    const p = findCachedStock(productId);
    if (!p) return;

    const stock = '<div class="detail-grid">' +
        detailField('Product ID', '#' + p.product_id) +
        detailField('Product', escapeHtml(p.product_name)) +
        detailField('On Hand', p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '')) +
        detailField('Reorder Point', String(p.reorder_point)) +
        detailField('Stock Status', statusBadge(p.stock_status)) +
        detailField('Suggested Order', p.suggested_order + ' ' + escapeHtml(p.unit_name || '')) +
        '</div>';

    // the reorder point is typed; what sold recently is shown beside it
    const reorder = '<div class="detail-grid">' +
        detailField('Reorder Point', p.reorder_point + ' ' + escapeHtml(p.unit_name || '')) +
        detailField('On Hand', p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '')) +
        detailField('Sold Recently', p.units_sold_window + ' ' + escapeHtml(p.unit_name || '') +
            ' over ' + p.window_days + ' days') +
        '</div>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-accent" onclick="changeReorderPoint(' + p.product_id + ')">' +
        'Change Reorder Point</button></div>';

    // the price is not set here: it belongs to the product, in Records > Products
    const product = '<div class="detail-grid">' +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('Brand', escapeHtml(p.brand_name || 'No brand')) +
        detailField('Product Status', statusBadge(p.status)) +
        detailField('Last Updated', escapeHtml(p.last_updated || 'Never')) +
        '</div>' +
        '<p class="detail-note">The selling price is set on the product, in Records, Products.</p>';

    const supplier = '<div class="detail-grid">' +
        detailField('Supplier', escapeHtml(p.supplier_name || 'No supplier')) +
        detailField('Contact Person', escapeHtml(p.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(p.contact_number || 'Not set')) +
        '</div>';

    const pages = [
        { label: 'Stock', body: stock },
        { label: 'Reorder Point', body: reorder },
        { label: 'Product', body: product },
        { label: 'Supplier', body: supplier }
    ];

    openDetailModal(p.product_name, (p.category_name || 'Uncategorised') + ' · ' + p.stock_status,
        initialsOf(p.product_name), pages);
}

function openDeliveryDetail(deliveryId) {
    const panel = getDataPanel('mgr-deliveries');
    // the manager reads a delivery; the driver moves it along
    showDeliveryRecord(panel ? panel.find(deliveryId, 'delivery_id') : null, false);
}

async function openRecordDetail(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    if (!row) return;

    const type = recordType;
    let fields = '';
    for (const key in row) {
        // the ids behind the names are for the edit form, not for reading
        if (key === 'id' || key === 'name' || /_id$/.test(key)) continue;
        fields += detailField(prettyLabel(key), fieldValue(key, row[key]));
    }
    const body = '<div class="detail-grid detail-grid-3">' +
        detailField('Record ID', '#' + row.id) +
        detailField('Name', escapeHtml(row.name)) +
        fields +
        '</div>' +
        (type === 'product'
            ? (isUnpriced(row)
                ? '<p class="detail-note detail-warn">This product has no price yet, so the till cannot sell it.</p>'
                : '<p class="detail-note">A new price reaches the till from the next sale on. Sales already ' +
                  'rung up keep the price they were sold at.</p>')
            : '');
    const pages = [{ label: 'Details', body: body }];

    // a category lists the products filed under it, and a unit the products
    // counted in it, on a page of their own
    if (type === 'category' || type === 'unit') {
        const field = type === 'category' ? 'category_name' : 'unit_name';
        let productsBody;
        try {
            const allProducts = await apiGetRecords('product');
            const productRows = [];
            for (let i = 0; i < allProducts.length; i++) {
                const p = allProducts[i];
                if (p[field] !== row.name) continue;
                productRows.push([
                    escapeHtml(p.name),
                    p.brand_name ? escapeHtml(p.brand_name) : '<span class="muted">Not set</span>',
                    p.supplier_name ? escapeHtml(p.supplier_name) : '<span class="muted">Not set</span>',
                    peso(p.price),
                    escapeHtml(qtyText(p.quantity_in_stock, p.unit_name))
                ]);
            }
            productsBody = detailTable(['Product', 'Brand', 'Supplier', 'Price', 'On Hand'], productRows, [3, 4]);
            pages.push({ label: 'Products (' + productRows.length + ')', body: productsBody });
        } catch (error) {
            pages.push({ label: 'Products', body:
                '<p class="detail-note detail-warn">The products ' + (type === 'category' ? 'in this category' : 'using this unit') +
                ' could not be loaded.</p>' });
        }
    }

    // the buttons: edit (suppliers, customers), the price (products), archive (all)
    let foot = '';
    if (RECORD_ARCHIVE_MODULE[type]) {
        foot += '<button type="button" class="btn btn-danger" onclick="archiveRecord(' + index + ')">Archive</button>';
    }
    if (type === 'product') {
        foot += '<button type="button" class="btn btn-accent" onclick="changeProductPrice(' + index + ')">' +
            (isUnpriced(row) ? 'Set Price' : 'Change Price') + '</button>';
    }
    if (RECORD_EDITABLE.indexOf(type) !== -1) {
        foot += '<button type="button" class="btn btn-success" onclick="openEditRecord(' + index + ')">Edit</button>';
    }

    openDetailModal(row.name, prettyLabel(type) + ' record', initialsOf(row.name),
        pages, foot || null, { wide: true });
}

// ---------- archiving a record ----------
async function archiveRecord(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    const module = RECORD_ARCHIVE_MODULE[recordType];
    if (!row || !module) return;

    const kind = prettyLabel(recordType).toLowerCase();
    const yes = await askArchive(row.name + ' (' + kind + ')', {
        title: 'Archive this ' + kind + '?',
        eyebrow: 'Records',
        detail: [
            'It leaves the ' + RECORD_TITLES[recordType] + ' list and moves to the Archives screen.',
            'It can be restored from Archives.',
            'The archive log keeps who archived it and when.'
        ]
    });
    if (!yes) return;

    const result = await apiArchiveRecord(module, row.id);
    if (!result) return;   // refused: the reason is on the screen

    closeModal('detail-modal');
    notifySuccess(row.name + ' is archived. It can be restored from Archives.', 'Record archived');

    const keys = ['mgr-records', 'mgr-archives'];
    if (module === 'Inventory') keys.push('mgr-stocks', 'mgr-reorder');
    if (module === 'Customer') keys.push('mgr-credit', 'mgr-loyal');
    for (let i = 0; i < keys.length; i++) {
        const other = getDataPanel(keys[i]);
        if (other && other.state === 'ready') await other.refresh();
    }
    if (module === 'Inventory') loadPriceBanner();
}

// ---------- editing a supplier, a customer or a product ----------
let editRecord = null;   // { type, row }

// one box: [field name, label, value, options]; options.kind is 'text',
// 'phone', 'email' or 'select' (with options.choices [[id, name], ...])
function editFieldHtml(name, label, value, options) {
    const settings = options || {};
    const id = 'edit-' + name;
    const required = settings.required ? ' <span class="req">*</span>' : '';
    let box;
    if (settings.kind === 'select') {
        let html = '<option value="">None</option>';
        const choices = settings.choices || [];
        for (let i = 0; i < choices.length; i++) {
            const picked = String(choices[i][0]) === String(value) ? ' selected' : '';
            html += '<option value="' + escapeHtml(choices[i][0]) + '"' + picked + '>' + escapeHtml(choices[i][1]) + '</option>';
        }
        box = '<select id="' + id + '" name="' + name + '" class="form-control">' + html + '</select>';
    } else if (settings.kind === 'phone') {
        box = '<div class="phone-field"><span class="phone-prefix">+63</span>' +
            '<input type="text" id="' + id + '" name="' + name + '" class="form-control" inputmode="numeric" ' +
            'autocomplete="off" maxlength="20" oninput="onPhoneInput(this)"></div>';
    } else {
        box = '<input type="' + (settings.kind === 'email' ? 'email' : 'text') + '" id="' + id + '" name="' + name + '" ' +
            'class="form-control" autocomplete="off" maxlength="' + (settings.max || 100) + '" value="' +
            escapeHtml(value === null || value === undefined ? '' : value) + '">';
    }
    return '<div class="form-group"><label for="' + id + '">' + escapeHtml(label) + required + '</label>' + box + '</div>';
}

// [[id, name], ...] from a records list
function recordChoices(rows) {
    const choices = [];
    for (let i = 0; i < rows.length; i++) choices.push([rows[i].id, rows[i].name]);
    return choices;
}

async function openEditRecord(index) {
    const panel = getDataPanel('mgr-records');
    const row = panel ? panel.visible[index] : null;
    const type = recordType;
    if (!row || RECORD_EDITABLE.indexOf(type) === -1) return;

    let html = '';
    if (type === 'supplier') {
        html = editFieldHtml('name', 'Company name', row.name, { required: true, max: 100 }) +
            editFieldHtml('contactPerson', 'Contact person', row.contact_person) +
            editFieldHtml('contactNumber', 'Contact number', '', { kind: 'phone' }) +
            editFieldHtml('email', 'Email', row.email, { kind: 'email' }) +
            editFieldHtml('address', 'Address', row.address, { max: 255 });
    } else if (type === 'customer') {
        html = editFieldHtml('firstName', 'First name', row.first_name, { required: true }) +
            editFieldHtml('middleName', 'Middle name', row.middle_name) +
            editFieldHtml('lastName', 'Last name', row.last_name, { required: true }) +
            editFieldHtml('phone', 'Phone', '', { kind: 'phone', required: true }) +
            editFieldHtml('street', 'House and street', row.address_street, { required: true, max: 150 }) +
            editFieldHtml('barangay', 'Barangay', row.address_barangay, { required: true }) +
            editFieldHtml('city', 'Town or city', row.address_city, { required: true }) +
            editFieldHtml('province', 'Province', row.address_province, { required: true }) +
            editFieldHtml('landmark', 'Landmark', row.address_landmark, { max: 150 });
    }

    editRecord = { type: type, row: row };
    document.getElementById('record-edit-fields').innerHTML = html;
    document.getElementById('record-edit-title').textContent = 'Edit ' + prettyLabel(type);
    document.getElementById('record-edit-avatar').textContent = initialsOf(row.name);

    // the phone boxes take the stored number through their own filler
    const form = document.getElementById('record-edit-form');
    if (type === 'supplier') phoneFill(form.elements.contactNumber, row.contact_number || '');
    if (type === 'customer') phoneFill(form.elements.phone, row.phone || '');

    closeModal('detail-modal');
    showModal('record-edit-modal');
}

async function saveEditRecord(event) {
    event.preventDefault();
    if (!editRecord) return;
    const form = event.target;
    const type = editRecord.type;
    const value = function (name) { return String(form.elements[name].value || '').trim(); };

    let data;
    if (type === 'supplier') {
        if (value('name') === '') { notifyWarning('Company name is required.', 'Fill in the form'); return; }
        if (value('contactNumber') !== '') {
            const problem = phoneComplaint(form.elements.contactNumber);
            if (problem) { notifyWarning(problem, 'Check the phone number'); return; }
        }
        data = { name: value('name'), contactPerson: value('contactPerson'),
                 contactNumber: phoneToStore(form.elements.contactNumber),
                 email: value('email'), address: value('address') };
    } else if (type === 'customer') {
        if (value('firstName') === '' || value('lastName') === '') {
            notifyWarning('First and last name are required.', 'Fill in the form');
            return;
        }
        const problem = phoneComplaint(form.elements.phone);
        if (problem) { notifyWarning(problem, 'Check the phone number'); return; }
        if (value('street').length < 2 || value('barangay') === '' || value('city').length < 2 || value('province').length < 2) {
            notifyWarning('Fill in the house number and street, barangay, town or city and province.', 'Fill in the form');
            return;
        }
        data = { firstName: value('firstName'), middleName: value('middleName'), lastName: value('lastName'),
                 phone: phoneToStore(form.elements.phone), street: value('street'), barangay: value('barangay'),
                 city: value('city'), province: value('province'), landmark: value('landmark') };
    }

    const button = document.getElementById('record-edit-save');
    button.disabled = true;
    try {
        const result = await apiEditRecord(type, editRecord.row.id, data);
        if (!result) return;   // refused: the reason is on the screen
        notifySuccess(result.message, 'Saved');
        closeModal('record-edit-modal');
        editRecord = null;
        await refreshStockPanels();
    } catch (error) {
        notifyOffline();
    } finally {
        button.disabled = false;
    }
}

// reached from the Repeat Customers report, which only knows a customer id
async function openCustomerDetail(customerId) {
    try {
        const rows = await apiGetRecords('customer');
        let index = -1;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].id === customerId) {
                index = i;
                break;
            }
        }
        if (index === -1) return;

        const customer = rows[index];
        let fields = '';
        for (const key in customer) {
            if (key !== 'id' && key !== 'name') {
                fields += detailField(prettyLabel(key), fieldValue(key, customer[key]));
            }
        }

        openDetailModal(customer.name, 'Customer record', initialsOf(customer.name), [{
            label: 'Customer',
            body: '<div class="detail-grid">' +
                detailField('Record ID', '#' + customer.id) +
                detailField('Name', escapeHtml(customer.name)) +
                fields +
                '</div>'
        }]);
    } catch (error) {
        notifyError('That customer record could not be opened.', 'Nothing to show');
    }
}

// ==========================================
// ACCOUNT MANAGEMENT -- creating a cashier, clerk or driver account
// ==========================================
// Three steps, the same two the administrator's Create Account has: the form,
// then the review (the server makes the first password and keeps a draft),
// then Confirm. The server only offers, and only creates, cashier, clerk and
// driver accounts, so nothing here decides which roles a manager may create.
let accountReview = null;     // the server's review: draft id, password and the details
let accountBusy = false;      // a request is running; buttons ignore a second press

// matches words made only of letters and accent marks, with single spaces between the words
const ACCOUNT_NAME_LETTERS = /^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u;
// matches name@domain.tld
const ACCOUNT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// the boxes that cannot be left empty, and what to call them
const ACCOUNT_REQUIRED = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['phone', 'Phone'],
    ['roleId', 'Role'],
    ['email', 'Email']
];

function openCreateAccount() {
    const form = document.getElementById('newacct-form');
    if (!form) return;

    clearAccountForm();
    showAccountStep('form');
    showModal('newacct-modal');
    loadAccountRoles();
    setTimeout(function () {
        document.getElementById('newacct-first').focus();
    }, 60);
}

// the form emptied, so the next person does not find a half-typed account
function clearAccountForm() {
    const form = document.getElementById('newacct-form');
    form.reset();
    accountReview = null;

    // reset() does not clear the phone box's own state, nor the red lines under the boxes
    phoneFill(form.elements.phone, '');
    const names = ['firstName', 'middleName', 'lastName', 'phone', 'email'];
    for (let i = 0; i < names.length; i++) {
        setAccountError(form.elements[names[i]], '');
    }
}

// the roles the server allows this manager to create, as the Role box's choices
async function loadAccountRoles() {
    const select = document.getElementById('newacct-role');
    select.innerHTML = '<option value="">Loading...</option>';

    try {
        const response = await apiGetRoles();
        const roles = await response.json();
        if (!response.ok) {
            select.innerHTML = '<option value="">No roles</option>';
            if (!handleAuthFailure(response, roles)) notifyError(roles.error, 'Roles not loaded');
            return;
        }

        let options = '<option value="">Choose a role</option>';
        for (let i = 0; i < roles.length; i++) {
            options += '<option value="' + roles[i].role_id + '">' + escapeHtml(roles[i].role_name) + '</option>';
        }
        select.innerHTML = options;
    } catch (error) {
        select.innerHTML = '<option value="">No roles</option>';
        notifyOffline();
    }
}

// which half of the card shows: 'form' or 'review'
function showAccountStep(step) {
    const reviewing = step === 'review';
    document.getElementById('newacct-form').hidden = reviewing;
    document.getElementById('newacct-review').hidden = !reviewing;
    document.getElementById('newacct-review-btn').hidden = reviewing;
    document.getElementById('newacct-confirm-btn').hidden = !reviewing;
    document.getElementById('newacct-back').hidden = !reviewing;
    document.getElementById('newacct-subtitle').textContent =
        reviewing ? 'Review before creating' : 'Account Management';
}

function closeAccountModal() {
    if (accountBusy) return;
    clearAccountForm();
    closeModal('newacct-modal');
}

function backToAccountForm() {
    if (accountBusy) return;
    accountReview = null;
    showAccountStep('form');
}

// ---------- the boxes ----------

// the line under a box, and its red edge; an empty text puts both away
function setAccountError(input, text) {
    if (!input) return;
    const box = document.getElementById(input.id + '-error');

    // a badly written phone number keeps its red edge (format.js put it there);
    // only a well written one that is taken gets it from here
    const badlyWritten = input.name === 'phone' && input.value !== '' && phoneComplaint(input) !== null;
    input.classList.toggle('is-bad', Boolean(text) || badlyWritten);
    if (box) {
        box.textContent = text || '';
        box.hidden = !text;
    }
}

// names are letters only: numbers and symbols are taken out as they are typed or pasted
function onAccountNameInput(input) {
    const typed = input.value;
    const cleaned = typed.replace(/[^\p{L}\p{M} ]/gu, '');   // keep letters, accents and spaces

    if (cleaned === typed) {
        setAccountError(input, '');
        return;
    }

    // keep the cursor where it was, less the characters taken out
    const cursor = Math.max(0, input.selectionStart - (typed.length - cleaned.length));
    input.value = cleaned;
    input.setSelectionRange(cursor, cursor);
    setAccountError(input, 'Letters only. Numbers and symbols cannot be typed here.');
}

// spaces cannot be part of an address, so they never get into the box
function onAccountEmailInput(input) {
    const cleaned = input.value.replace(/\s+/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    setAccountError(input, '');
}

function accountEmailComplaint(value) {
    const email = String(value || '').trim();
    if (email === '') return 'An email address is required.';
    if (!ACCOUNT_EMAIL_PATTERN.test(email)) return 'Enter an email address, for example name@example.com.';
    return null;
}

// Asked when the box is left: does another account already sign in with this
// address? Every role counts. The server asks again, so this is only for
// saying it early. Gives back true when the address may be used.
async function checkAccountEmailFree(input) {
    const email = input.value.trim();
    if (email === '') {
        setAccountError(input, '');
        return true;
    }

    const problem = accountEmailComplaint(email);
    if (problem) {
        setAccountError(input, problem);
        return false;
    }

    try {
        const answer = await apiCheckEmail(email);

        // typed something else while the answer was coming: that address gets its own check
        if (input.value.trim() !== email) return true;

        if (answer && answer.taken) {
            setAccountError(input, 'This email is already used by another account (' + answer.roleName + ').');
            return false;
        }
    } catch (error) {
        // offline: the server says so on Review
    }
    setAccountError(input, '');
    return true;
}

// Asked when the box is left: does another staff member already have this
// number? Gives back true when the number may be used.
async function checkAccountPhoneFree(input) {
    const phone = phoneToStore(input);   // like +639171234567, the way it is stored

    // an empty or badly written number is not a clash; Review says what is wrong with it
    if (phone === '' || phoneComplaint(input) !== null) {
        setAccountError(input, '');
        return true;
    }

    try {
        const answer = await apiCheckPhone(phone);

        // typed something else while the answer was coming: that number gets its own check
        if (phoneToStore(input) !== phone) return true;

        if (answer && answer.taken) {
            setAccountError(input, 'This number is already used by another staff member (' + answer.roleName + ').');
            return false;
        }
    } catch (error) {
        // offline: the server says so on Review
    }
    setAccountError(input, '');
    return true;
}

// ---------- step 1 to 2: Review ----------
async function reviewNewAccount(event) {
    event.preventDefault();
    if (accountBusy) return;
    const form = event.target;

    for (let i = 0; i < ACCOUNT_REQUIRED.length; i++) {
        const input = form.elements[ACCOUNT_REQUIRED[i][0]];
        if (input.value.trim() === '') {
            notifyWarning(ACCOUNT_REQUIRED[i][1] + ' is required.', 'Fill in the form');
            input.focus();
            return;
        }
    }

    const nameBoxes = [['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name']];
    for (let i = 0; i < nameBoxes.length; i++) {
        const input = form.elements[nameBoxes[i][0]];
        const value = input.value.trim().replace(/\s+/g, ' ');
        if (value !== '' && !ACCOUNT_NAME_LETTERS.test(value)) {
            notifyWarning(nameBoxes[i][1] + ' can only have letters. Take out any numbers or symbols.', 'Check the name');
            input.focus();
            return;
        }
    }

    const phoneProblem = phoneComplaint(form.elements.phone);
    if (phoneProblem) {
        notifyWarning(phoneProblem, 'Check the phone number');
        form.elements.phone.focus();
        return;
    }

    const emailProblem = accountEmailComplaint(form.elements.email.value);
    if (emailProblem) {
        setAccountError(form.elements.email, emailProblem);
        form.elements.email.focus();
        return;
    }

    // switched off while the requests run, so a double click sends one request
    const button = document.getElementById('newacct-review-btn');
    accountBusy = true;
    button.disabled = true;
    button.textContent = 'Checking...';

    try {
        if (!(await checkAccountPhoneFree(form.elements.phone))) {
            form.elements.phone.focus();
            return;
        }
        if (!(await checkAccountEmailFree(form.elements.email))) {
            form.elements.email.focus();
            return;
        }

        const review = await apiReviewNewAccount({
            firstName: form.elements.firstName.value.trim(),
            middleName: form.elements.middleName.value.trim(),
            lastName: form.elements.lastName.value.trim(),
            phone: phoneToStore(form.elements.phone),
            email: form.elements.email.value.trim().toLowerCase(),
            roleId: parseInt(form.elements.roleId.value, 10)
        });
        if (!review) return;   // refused: the server's reason is already on the screen

        accountReview = review;
        showAccountReview(review);
        showAccountStep('review');
    } catch (error) {
        notifyOffline();
    } finally {
        accountBusy = false;
        button.disabled = false;
        button.textContent = 'Review';
    }
}

// the details the server will create, and how the first password reaches them
// (the password itself is not shown until the account exists and the mail failed)
function showAccountReview(review) {
    let sentText = 'Mail is not set up, so the password will be shown after you confirm';
    if (review.willEmail) {
        sentText = 'Will be emailed to ' + escapeHtml(review.email);
    }

    const minutes = Math.max(1, Math.round(review.expiresInSeconds / 60));

    document.getElementById('newacct-review').innerHTML =
        '<div class="detail-grid">' +
        detailField('Name', escapeHtml(review.fullName)) +
        detailField('Role', escapeHtml(review.roleName)) +
        detailField('Email', escapeHtml(review.email)) +
        detailField('Phone', '<span class="mono">' + escapeHtml(phoneForDisplay(review.phone)) + '</span>') +
        detailField('First Password', sentText) +
        '</div>' +
        '<p class="detail-note">Nothing is saved until you press Confirm. ' + escapeHtml(review.firstName) +
        ' must change the password the first time they sign in, and the new account is written to the ' +
        'audit trail in your name. This review is held for ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.') + '</p>';
}

// ---------- step 2 to done: Confirm ----------
async function confirmNewAccount() {
    if (!accountReview || accountBusy) return;
    const review = accountReview;

    // switched off while the request runs, so a double click sends one request
    const button = document.getElementById('newacct-confirm-btn');
    const back = document.getElementById('newacct-back');
    accountBusy = true;
    button.disabled = true;
    back.disabled = true;
    button.textContent = 'Creating...';

    try {
        const result = await apiCreateAccount(review.draftId);

        if (!result) {
            // refused: the server's reason is on the screen and the draft is used up, so start the form again
            accountReview = null;
            showAccountStep('form');
            return;
        }

        accountReview = null;
        clearAccountForm();
        closeModal('newacct-modal');

        // a list that is already loaded shows the new account (one not loaded stays closed)
        const staffPanel = getDataPanel('mgr-staff');
        if (staffPanel && staffPanel.state === 'ready') staffPanel.refresh();

        await reportFirstPassword(result);
    } catch (error) {
        notifyOffline();
    } finally {
        accountBusy = false;
        button.disabled = false;
        back.disabled = false;
        button.textContent = 'Confirm';
    }
}

// Emailed is a corner card; not emailed keeps the password on screen in a dialog.
async function reportFirstPassword(result) {
    if (result.emailed) {
        notifySuccess('The first password was emailed to ' + result.email + '. ' +
            result.name + ' must change it the first time they sign in.', 'Account created');
        return;
    }

    await askConfirm(
        'The account exists, but the password could not be sent. Read it out to ' +
        result.name + ' now: it is not shown again after this card.',
        {
            title: 'The password was not sent',
            eyebrow: 'Account Management',
            mark: '!',
            confirmLabel: 'I have written it down',
            cancelLabel: 'Close',
            tone: 'danger',
            detail: [
                'Password: ' + result.password,
                'Signs in with: ' + result.email,
                result.reason || 'The password could not be emailed.',
                result.name + ' must change it the first time they sign in.'
            ]
        });
}

// ---------- staff accounts ----------
// The server lists only cashier, clerk and driver accounts, and refuses a
// lift on anyone else, so nothing here decides who may be seen or released.
// The table is read only when Load Data is pressed.
function buildStaffAccountsPanel() {
    createDataPanel({
        key: 'mgr-staff',
        tableId: 'staff-table',
        columns: 6,
        sortKeys: ['full_name', 'role_name', 'email', 'phone', function (row) { return staffAccountState(row); }, 'last_login'],
        pagerId: 'staff-pager',
        idField: 'staff_id',
        filters: { status: 'all' },
        remember: false,       // a reload of the page closes it again
        loadOnFilter: false,   // picking a status before Load Data reads nothing
        loadOnSearch: false,   // nor does typing in the search box
        gate: {
            title: 'The staff accounts are not loaded',
            text: 'Press Load Data to list the cashier, inventory clerk and driver accounts.',
            button: 'Load Data'
        },
        empty: {
            title: 'No staff accounts yet',
            text: 'Use Create Account to add the first one.'
        },
        load: function () {
            return apiGetManagedStaff();
        },
        match: function (row, query) {
            return prefixMatch([row.full_name, row.role_name, row.email], query);
        },
        filter: function (row, filters) {
            const state = staffAccountState(row);
            if (filters.status === 'hold') return state === 'hold';
            if (filters.status === 'inactive') return state === 'inactive';
            if (filters.status === 'active') return state === 'active' || state === 'newpass' || state === 'nologin';
            return true;
        },
        onLoaded: function () {
            // Refresh is for a list that is already showing
            document.getElementById('staff-refresh').style.display = '';
        },
        renderRow: function (row, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                    'onclick="openStaffAccount(' + row.staff_id + ')">' +
                '<td class="cell-name">' + escapeHtml(row.full_name) + '</td>' +
                '<td>' + escapeHtml(row.role_name) + '</td>' +
                '<td>' + (row.email ? escapeHtml(row.email) : '<span class="muted">No login</span>') + '</td>' +
                '<td>' + (row.phone ? '<span class="mono">' + escapeHtml(phoneForDisplay(row.phone)) + '</span>' : '<span class="muted">Not set</span>') + '</td>' +
                '<td>' + staffStatusBadge(row) + '</td>' +
                '<td>' + (row.last_login ? escapeHtml(whenText(row.last_login)) : '<span class="muted">Never</span>') + '</td></tr>';
        }
    });
}

function minutesText(minutes) {
    return minutes + (minutes === 1 ? ' minute' : ' minutes');
}

// what to say about an account: 'inactive', 'nologin' (no way to sign in yet),
// 'hold' (locked out after wrong passwords), 'newpass' (still on the password
// it was given) or 'active'
function staffAccountState(account) {
    if (!account.is_active) return 'inactive';
    if (!account.has_login) return 'nologin';
    if (account.minutes_left !== null) return 'hold';
    if (account.must_change_password) return 'newpass';
    return 'active';
}

function staffStatusBadge(account) {
    const state = staffAccountState(account);

    let tone = 'badge-success';
    let text = 'Active';
    if (state === 'inactive') {
        tone = 'badge-danger';
        text = 'Inactive';
    } else if (state === 'nologin') {
        tone = 'badge-neutral';
        text = 'No login';
    } else if (state === 'hold') {
        tone = 'badge-warning';
        text = 'On hold · ' + minutesText(account.minutes_left);
    } else if (state === 'newpass') {
        tone = 'badge-info';
        text = 'Must set password';
    }

    return '<span class="badge ' + tone + '">' + escapeHtml(text) + '</span>';
}

// A row opens a card with the account. One on a hold also gets the button
// that lifts it; pressing "Lift hold" is the confirmation, so there is no second question.
function openStaffAccount(staffId) {
    const panel = getDataPanel('mgr-staff');
    const account = panel ? panel.find(staffId) : null;
    if (!account) return;

    const onHold = staffAccountState(account) === 'hold';

    let body = '<div class="detail-grid">' +
        detailField('Name', escapeHtml(account.full_name)) +
        detailField('Role', escapeHtml(account.role_name)) +
        detailField('Email', account.email ? escapeHtml(account.email) : '<span class="muted">No login</span>') +
        detailField('Phone', account.phone
            ? '<span class="mono">' + escapeHtml(phoneForDisplay(account.phone)) + '</span>'
            : '<span class="muted">Not set</span>') +
        detailField('Status', staffStatusBadge(account)) +
        detailField('Last Sign-in', account.last_login ? escapeHtml(whenText(account.last_login)) : '<span class="muted">Never</span>');
    body += '</div>';

    let foot = '';
    if (account.is_active) {
        foot += '<button type="button" class="btn btn-danger" onclick="archiveStaffAccount(' + account.staff_id + ')">' +
            'Archive Account</button>';
    }
    if (onHold) {
        body += '<p class="detail-note">Lifting the hold lets them sign in again straight away with the ' +
            'password they already have. Their password is not changed, they get a full set of tries ' +
            'again, and the change is written to the audit trail in your name.</p>';

        foot += '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\')">Cancel</button>' +
            '<button type="button" class="btn btn-accent" id="lift-hold-button" ' +
            'onclick="liftHeldAccount(' + account.staff_id + ')">Lift hold</button>';
    }

    openDetailModal(account.full_name, account.role_name,
        initialsOf(account.full_name), [{ label: 'Account', body: body }], foot || null);
}

// A cashier, clerk or driver account goes to Archives: they can no longer sign
// in, and any screen they have open is signed out. Restored from Archives.
async function archiveStaffAccount(staffId) {
    const panel = getDataPanel('mgr-staff');
    const account = panel ? panel.find(staffId) : null;
    if (!account) return;

    const yes = await askArchive(account.full_name + ' (' + account.role_name + ')', {
        title: 'Archive this account?',
        eyebrow: 'Account Management',
        confirmLabel: 'Archive the account',
        detail: [
            'They can no longer sign in, and any screen they have open is signed out.',
            'Their sales, reports and history stay on record.',
            'The account can be restored from Archives.'
        ]
    });
    if (!yes) return;

    const result = await apiArchiveRecord('Staff', staffId);
    if (!result) return;

    closeModal('detail-modal');
    notifySuccess(account.full_name + '\'s account is archived.', 'Account archived');
    await panel.refresh();
    const archives = getDataPanel('mgr-archives');
    if (archives && archives.state === 'ready') await archives.refresh();
}

async function liftHeldAccount(staffId) {
    // switched off while the request runs, so a double click sends one request
    const button = document.getElementById('lift-hold-button');
    if (button) button.disabled = true;

    try {
        const response = await apiReleaseHeldAccount(staffId);
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Hold not lifted');
        } else {
            notifySuccess(result.message, 'Hold lifted');
        }

        // the card closes and the list is read again either way:
        // the hold may have ended or been lifted already
        closeModal('detail-modal');
        const panel = getDataPanel('mgr-staff');
        if (panel) await panel.refresh();
    } catch (error) {
        if (button) button.disabled = false;
        notifyOffline();
    }
}

// ==========================================
// NO AUTOFILL -- the browser's own suggestions do not drop into the boxes
// ==========================================
// Every box on the page, and every one a popup draws later, has autocomplete
// off. Password boxes keep theirs, so a password manager still works.
function stopAutofill(root) {
    const boxes = root.querySelectorAll ? root.querySelectorAll('input:not([type="password"]), textarea, form') : [];
    for (let i = 0; i < boxes.length; i++) {
        boxes[i].setAttribute('autocomplete', 'off');
    }
}

if (typeof MutationObserver === 'function') {
    new MutationObserver(function (changes) {
        for (let i = 0; i < changes.length; i++) {
            const added = changes[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (node.nodeType !== 1) continue;
                if (node.matches('input:not([type="password"]), textarea, form')) node.setAttribute('autocomplete', 'off');
                stopAutofill(node);
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
}

// ==========================================
// MANAGER PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('manager.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildIncomePanels();
        buildReportPanels();
        buildSalesPanel();
        buildStockPanels();
        buildStockMovesPanel();
        buildDeliveryPanel();
        buildManagerPurchaseOrderPanel();
        buildCreditPanels();
        buildRecordsPanel();
        buildArchivePanel();
        buildStaffAccountsPanel();

        // the schedule follows what the administrator switched on for managers
        configureDeliverySchedule({
            showPanel: function (panelId, title) {
                showManagerPanel(panelId, title);
            }
        });
        buildDeliverySchedulePanel();
        configureFeatures({
            home: function () {
                showReports();
            },
            onApply: function () {
                syncViewNavs();
                loadPriceBanner();
                placePriceAlert();
            }
        });

        // Go to, on an opened alert: the screen that alert is about
        const stockAlert = {
            label: 'Reorder Alerts', panelId: 'panel-stocks',
            open: function () {
                showReorderAlerts();
            },
            key: 'mgr-reorder', searchId: 'reorder-search'
        };
        const returnsAlert = {
            label: 'Activity Log', panelId: 'panel-activity',
            open: function () {
                showActivityLog();
            },
            key: 'mgr-all'
        };
        configureNotificationTargets({
            'Low Stock':        stockAlert,
            'Out of Stock':     stockAlert,
            'Purchase Order':   {
                label: 'Purchase Orders', panelId: 'panel-po-history',
                open: function () {
                    showPurchasing();
                },
                key: 'mgr-po'
            },
            'Damage Report':    returnsAlert,
            'Refund Report':    returnsAlert,
            'Stock Adjustment': {
                label: 'Stock Movements', panelId: 'panel-stocks',
                open: function () {
                    showStockView('stock-moves');
                },
                key: 'mgr-stock-moves'
            },
            // a product the clerk added: Records > Products, read afresh with the search cleared
            // (openUnpricedProducts), where products with no price are on the top rows
            'New Product':      {
                label: 'Products', panelId: 'panel-records',
                open: function () {
                    openUnpricedProducts();
                }
            },
            'Delivery':         {
                label: 'Delivery History', panelId: 'panel-deliveries',
                open: function () {
                    showDeliveries();
                },
                key: 'mgr-deliveries'
            },
            'Credit Request':   {
                label: 'Extension Requests', panelId: 'panel-credit-requests',
                open: function () {
                    showCreditRequests();
                },
                key: 'mgr-requests'
            },
            'Late Penalty':     {
                label: 'Receivables', panelId: 'panel-reports',
                open: function () {
                    showReport('report-unpaid');
                },
                key: 'mgr-unpaid'
            }
        });

        writeRecordHeaders();
        syncRecordAddButton();
        limitDatesToToday(['income-from', 'income-to', 'sales-from', 'sales-to', 'all-from', 'all-to',
                           'unpaid-from', 'unpaid-to', 'stock-moves-from', 'stock-moves-to']);
        renderIncomeRanges();
        buildPeriodBoxes();
        applyExportPermissions();
        buildExportMenus();
        stopAutofill(document);

        document.addEventListener('datapanel:change', syncExportButtons);
        document.addEventListener('datapanel:change', syncPeriodBoxes);
        syncExportButtons();

        // the no-price strip follows products added, priced or put away by anybody (live-sync.js)
        onLiveChange(['inventory', 'archives'], loadPriceBanner);
        loadPriceBanner();

        showReports();
        unfoldSidebarAtOpenScreen();
        loadNotifications();
    });
}
