// qr-payments.js -- the QR Payments screen: every GCash and Maya payment
// tried by QR code, how it ended, and how many went through
// Loaded by: cashier-dashboard.html (the cashier's own) and manager.html (everyone's)
//
// The server decides whose rows come back (a cashier only ever gets their
// own), and counts them: the tiles show its figures for the period picked.
// The status filter narrows the table only. A row that paid for a sale opens
// that sale; any other row opens the attempt itself.
//
//   buildQrPaymentsPanel({ key, prefix, openSale, byStaff })
//     prefix   the ids in the page: <prefix>-table, -pager, -kpis, -search,
//              -status, -from, -to and (with byStaff) -staff
//     openSale the page's own way of opening a sale (an invoice, a detail card)

const QR_STATUS_WORDS = {
    pending: 'Waiting', paid: 'Paid', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled'
};
const QR_STATUS_TONE = {
    pending: 'badge-warning', paid: 'badge-success', failed: 'badge-danger',
    expired: 'badge-neutral', cancelled: 'badge-neutral'
};
const QR_WALLET_WORDS = { GCash: 'GCash', PayMaya: 'Maya' };

function qrStatusBadge(status) {
    return '<span class="badge ' + (QR_STATUS_TONE[status] || 'badge-neutral') + '">' +
        escapeHtml(QR_STATUS_WORDS[status] || status) + '</span>';
}

// test money, a simulation, or real money: said on every row
function qrModeBadge(row) {
    if (row.provider === 'sim') return '<span class="badge badge-warning">Simulation</span>';
    if (row.mode === 'test') return '<span class="badge badge-warning">Test</span>';
    return '<span class="badge badge-success">Live</span>';
}

function qrSaleNumber(saleId) {
    return 'OR-' + String(saleId).padStart(6, '0');
}

// the screens built on this page, by key, with what each was given
const qrPanels = new Map();

function buildQrPaymentsPanel(options) {
    const p = options.prefix;
    const state = { options: options, summary: null, badge: null, staff: new Map() };
    qrPanels.set(options.key, state);

    createDataPanel({
        key: options.key,
        tableId: p + '-table',
        columns: 9,
        pagerId: p + '-pager',
        idField: 'id',
        filters: { status: 'all' },
        // a code paid or closed anywhere, or a sale it was recorded on
        scopes: ['qr-payments', 'sales'],

        gate: {
            title: 'No QR payments loaded',
            text: 'Pick a period above, or press Load Data to read every GCash and Maya payment tried by QR code.',
            button: 'Load Data'
        },
        empty: {
            title: 'No QR payments',
            text: 'Nothing was paid by QR code in this period.'
        },

        load: async () => {
            const answer = await apiGetQrPayments(qrPaymentsQuery(state));
            state.summary = answer.summary;
            state.badge = answer.badge;
            answer.rows.forEach((row) => {
                if (row.cashierName) state.staff.set(String(row.staffId), row.cashierName);
            });
            return answer.rows;
        },

        onLoaded: () => { renderQrPaymentTiles(state); fillQrStaffPicker(state); },

        match: (row, query) => prefixMatch([
            row.reference, row.wallet, QR_WALLET_WORDS[row.wallet], row.cashierName, row.errorMessage,
            QR_STATUS_WORDS[row.status], row.saleId ? qrSaleNumber(row.saleId) : '', '#' + row.id
        ], query),

        filter: (row, filters) => filters.status === 'all' || row.status === filters.status,

        renderRow: (row, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
            'onclick="openQrPaymentRow(\'' + options.key + '\', ' + row.id + ')">' +
            '<td class="cell-id">' + escapeHtml(String(row.createdAt || '').slice(0, 16)) + '</td>' +
            '<td class="cell-num">' + peso(row.amount) + '</td>' +
            '<td>' + escapeHtml(QR_WALLET_WORDS[row.wallet] || row.wallet) + '</td>' +
            '<td>' + qrStatusBadge(row.status) + '</td>' +
            '<td class="cell-id">' + (row.reference ? escapeHtml(row.reference) : '<span class="muted">None</span>') + '</td>' +
            '<td class="cell-id">' + (row.saleId ? qrSaleNumber(row.saleId) : '<span class="muted">None</span>') + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.cashierName || 'Unknown') + '</td>' +
            '<td>' + (row.errorMessage ? escapeHtml(row.errorMessage) : '') + '</td>' +
            '<td>' + qrModeBadge(row) + '</td></tr>'
    });

    renderQrPaymentTiles(state);
}

// the period and the person, for the server; the status stays on the screen
function qrPaymentsQuery(state) {
    const p = state.options.prefix;
    const parts = [];
    const add = (id, name) => {
        const box = document.getElementById(id);
        if (box && box.value && box.value !== 'all') parts.push(name + '=' + encodeURIComponent(box.value));
    };
    add(p + '-from', 'from');
    add(p + '-to', 'to');
    if (state.options.byStaff) add(p + '-staff', 'staff');
    return parts.length ? '?' + parts.join('&') : '';
}

// a new period or person is a new question for the server
function reloadQrPayments(key) {
    const panel = getDataPanel(key);
    if (panel) panel.open();
}

function renderQrPaymentTiles(state) {
    const grid = document.getElementById(state.options.prefix + '-kpis');
    if (!grid) return;
    const s = state.summary;
    const value = (n) => (s ? escapeHtml(String(n)) : '—');

    const tile = (label, figure, note) =>
        '<div class="kpi-card"><span class="kpi-label">' + label + '</span>' +
        '<span class="kpi-value">' + figure + '</span><span class="kpi-note">' + note + '</span></div>';

    const rate = s && s.successRate !== null ? s.successRate + '%' : '—';
    grid.innerHTML =
        tile('Attempts', value(s && s.attempts), s && s.pending ? s.pending + ' still waiting' : 'QR codes made') +
        tile('Paid', value(s && s.paid), 'Money received') +
        tile('Failed', value(s && s.failed), 'Declined in the app') +
        tile('Expired', value(s && s.expired), 'Not paid in time') +
        tile('Cancelled', value(s && s.cancelled), 'Closed by the cashier') +
        tile('Success Rate', s ? escapeHtml(rate) : '—', 'Paid, of finished attempts');

    // the whole list is test money while the badge is up
    const badge = document.getElementById(state.options.prefix + '-badge');
    if (badge) {
        badge.hidden = !state.badge;
        badge.textContent = state.badge || '';
    }
}

// the manager's "Cashier" picker: everyone seen so far, kept across periods
function fillQrStaffPicker(state) {
    if (!state.options.byStaff) return;
    const select = document.getElementById(state.options.prefix + '-staff');
    if (!select) return;
    const current = select.value;
    const people = Array.from(state.staff.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    select.innerHTML = '<option value="all">Everyone</option>' + people.map(([id, name]) =>
        '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>').join('');
    select.value = people.some(([id]) => id === current) ? current : 'all';
}

// A row that paid for a sale opens the sale; any other opens the attempt.
function openQrPaymentRow(key, id) {
    const state = qrPanels.get(key);
    const panel = getDataPanel(key);
    const row = panel ? panel.find(id) : null;
    if (!state || !row) return;

    if (row.saleId) {
        state.options.openSale(row.saleId);
        return;
    }

    const body = '<div class="detail-grid">' +
        detailField('Attempt', '#' + row.id) +
        detailField('Status', qrStatusBadge(row.status)) +
        detailField('Amount', peso(row.amount)) +
        detailField('Wallet', escapeHtml(QR_WALLET_WORDS[row.wallet] || row.wallet)) +
        detailField('For', row.purpose === 'credit_payment' ? 'A payment on a balance' : 'A sale') +
        detailField('Cashier', escapeHtml(row.cashierName || 'Unknown')) +
        detailField('Made', escapeHtml(String(row.createdAt || ''))) +
        detailField('Closed', row.closedAt ? escapeHtml(String(row.closedAt)) : '<span class="muted">Still open</span>') +
        detailField('Reference', row.reference ? escapeHtml(row.reference) : '<span class="muted">None</span>') +
        detailField('Money', qrModeBadge(row)) +
        '</div>' +
        (row.errorMessage ? '<p class="detail-note' + (row.status === 'paid' ? ' detail-warn' : '') + '">' +
            escapeHtml(row.errorMessage) + '</p>' : '') +
        (row.status === 'paid' && !row.saleId
            ? '<p class="detail-note detail-warn">The customer paid and no sale or payment was recorded with it. ' +
              'Refund the customer, or ring the sale up again and pay by QR for the same amount.</p>' : '');

    openDetailModal('QR Payment #' + row.id, peso(row.amount) + ' · ' + (QR_STATUS_WORDS[row.status] || row.status),
        'Q' + row.id, [{ label: 'Attempt', body: body }]);
}

// A sale's QR payments, for its detail card or invoice: the status and the
// reference of each code paid towards it. Empty when there were none.
function qrPaymentsOfSaleHtml(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return detailTable(['QR Payment', 'Wallet', 'Amount', 'Status', 'Reference', 'Money'],
        list.map((q) => [
            '#' + q.qr_payment_id,
            escapeHtml(QR_WALLET_WORDS[q.wallet] || q.wallet),
            peso(q.amount),
            qrStatusBadge(q.status),
            q.provider_payment_id ? escapeHtml(q.provider_payment_id) : '<span class="muted">None</span>',
            qrModeBadge({ provider: q.provider, mode: q.mode })
        ]), [2]);
}
