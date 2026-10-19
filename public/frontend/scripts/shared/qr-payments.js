// qr-payments.js -- the QR Payments screen: every GCash, Maya and bank-transfer
// payment tried by QR code, how it ended, and how many went through
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
const QR_WALLET_WORDS = { GCash: 'GCash', PayMaya: 'Maya', 'Bank Transfer': 'Bank Transfer' };

// "Maya", or "Bank Transfer · BPI" when the customer paid through their bank
function qrWayWords(row) {
    const way = QR_WALLET_WORDS[row.wallet] || row.wallet;
    const bank = row.bankName || row.bank_name;
    if (row.wallet === 'Bank Transfer' && bank) return way + ' \u00b7 ' + bank;
    return way;
}

function qrStatusBadge(status) {
    return '<span class="badge ' + (QR_STATUS_TONE[status] || 'badge-neutral') + '">' +
        escapeHtml(QR_STATUS_WORDS[status] || status) + '</span>';
}

function qrSaleNumber(saleId) {
    return 'OR-' + String(saleId).padStart(6, '0');
}

// the screens built on this page: key -> what that screen was given
const qrPanels = {};

// Remembers a cashier for the "Cashier" picker. A cashier seen again keeps the
// place they had and gets the newest name. staff holds { id, name } in the
// order first seen.
function rememberQrStaff(state, id, name) {
    for (let i = 0; i < state.staff.length; i++) {
        if (state.staff[i].id === id) {
            state.staff[i].name = name;
            return;
        }
    }
    state.staff.push({ id: id, name: name });
}

function buildQrPaymentsPanel(options) {
    const p = options.prefix;
    const state = { options: options, summary: null, staff: [] };
    qrPanels[options.key] = state;

    createDataPanel({
        key: options.key,
        tableId: p + '-table',
        columns: 8,
        pagerId: p + '-pager',
        idField: 'id',
        filters: { status: 'all' },
        inputs: [p + '-from', p + '-to'],
        // a code paid or closed anywhere, or a sale it was recorded on
        scopes: ['qr-payments', 'sales'],

        gate: {
            title: 'No QR payments loaded',
            text: 'Pick a period above, or press Load Data to read every GCash, Maya and bank-transfer payment tried by QR code.',
            button: 'Load Data'
        },
        empty: {
            title: 'No QR payments',
            text: 'Nothing was paid by QR code in this period.'
        },

        load: async function () {
            const answer = await apiGetQrPayments(qrPaymentsQuery(state));
            state.summary = answer.summary;
            for (let i = 0; i < answer.rows.length; i++) {
                const row = answer.rows[i];
                if (row.cashierName) rememberQrStaff(state, String(row.staffId), row.cashierName);
            }
            return answer.rows;
        },

        onLoaded: function () {
            renderQrPaymentTiles(state);
            fillQrStaffPicker(state);
        },

        match: function (row, query) {
            return prefixMatch([
                row.reference, row.wallet, QR_WALLET_WORDS[row.wallet], row.bankName, row.cashierName, row.errorMessage,
                QR_STATUS_WORDS[row.status], row.saleId ? qrSaleNumber(row.saleId) : '', '#' + row.id
            ], query);
        },

        filter: function (row, filters) {
            return filters.status === 'all' || row.status === filters.status;
        },

        renderRow: function (row, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + ((index % 10) * 28) + 'ms" ' +
                'onclick="openQrPaymentRow(\'' + options.key + '\', ' + row.id + ')">' +
                '<td class="cell-id">' + escapeHtml(String(row.createdAt || '').slice(0, 16)) + '</td>' +
                '<td class="cell-num">' + peso(row.amount) + '</td>' +
                '<td>' + escapeHtml(qrWayWords(row)) + '</td>' +
                '<td>' + qrStatusBadge(row.status) + '</td>' +
                '<td class="cell-id">' + (row.reference ? escapeHtml(row.reference) : '<span class="muted">None</span>') + '</td>' +
                '<td class="cell-id">' + (row.saleId ? qrSaleNumber(row.saleId) : '<span class="muted">None</span>') + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.cashierName || 'Unknown') + '</td>' +
                '<td>' + (row.errorMessage ? escapeHtml(row.errorMessage) : '') + '</td></tr>';
        }
    });

    renderQrPaymentTiles(state);
}

// the period and the person, for the server; the status stays on the screen
function qrPaymentsQuery(state) {
    const p = state.options.prefix;
    const parts = [];
    function add(id, name) {
        const box = document.getElementById(id);
        if (box && box.value && box.value !== 'all') parts.push(name + '=' + encodeURIComponent(box.value));
    }
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
    function value(n) {
        return s ? escapeHtml(String(n)) : '—';
    }

    function tile(label, figure, note) {
        return '<div class="kpi-card"><span class="kpi-label">' + label + '</span>' +
            '<span class="kpi-value">' + figure + '</span><span class="kpi-note">' + note + '</span></div>';
    }

    const rate = s && s.successRate !== null ? s.successRate + '%' : '—';
    grid.innerHTML =
        tile('Attempts', value(s && s.attempts), s && s.pending ? s.pending + ' still waiting' : 'QR codes made') +
        tile('Paid', value(s && s.paid), 'Money received') +
        tile('Failed', value(s && s.failed), 'Declined in the app') +
        tile('Expired', value(s && s.expired), 'Not paid in time') +
        tile('Cancelled', value(s && s.cancelled), 'Closed by the cashier') +
        tile('Success Rate', s ? escapeHtml(rate) : '—', 'Paid, of finished attempts');
}

// the manager's "Cashier" picker: everyone seen so far, kept across periods
function fillQrStaffPicker(state) {
    if (!state.options.byStaff) return;
    const select = document.getElementById(state.options.prefix + '-staff');
    if (!select) return;
    const current = select.value;
    const people = state.staff.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name);
    });
    let optionsHtml = '<option value="all">Everyone</option>';
    let currentIsListed = false;
    for (let i = 0; i < people.length; i++) {
        optionsHtml += '<option value="' + escapeHtml(people[i].id) + '">' + escapeHtml(people[i].name) + '</option>';
        if (people[i].id === current) currentIsListed = true;
    }
    select.innerHTML = optionsHtml;
    select.value = currentIsListed ? current : 'all';
}

// A row that paid for a sale opens the sale; any other opens the attempt.
function openQrPaymentRow(key, id) {
    const state = qrPanels[key];
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
        detailField(row.wallet === 'Bank Transfer' ? 'Paid By' : 'Wallet', escapeHtml(qrWayWords(row))) +
        (row.wallet === 'Bank Transfer'
            ? detailField('Account', escapeHtml((row.accountName || '') + ', ' + (row.accountNumber || ''))) : '') +
        detailField('For', row.purpose === 'credit_payment' ? 'A payment on a balance' : 'A sale') +
        detailField('Cashier', escapeHtml(row.cashierName || 'Unknown')) +
        detailField('Made', escapeHtml(String(row.createdAt || ''))) +
        detailField('Closed', row.closedAt ? escapeHtml(String(row.closedAt)) : '<span class="muted">Still open</span>') +
        detailField('Reference', row.reference ? escapeHtml(row.reference) : '<span class="muted">None</span>') +
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
    const rows = [];
    for (let i = 0; i < list.length; i++) {
        const q = list[i];
        rows.push([
            '#' + q.qr_payment_id,
            escapeHtml(qrWayWords(q)),
            peso(q.amount),
            qrStatusBadge(q.status),
            q.provider_payment_id ? escapeHtml(q.provider_payment_id) : '<span class="muted">None</span>'
        ]);
    }
    return detailTable(['QR Payment', 'Wallet', 'Amount', 'Status', 'Reference'], rows, [2]);
}
