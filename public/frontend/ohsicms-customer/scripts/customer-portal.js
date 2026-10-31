// The customer portal page. Everything on it is read only, except paying a balance by QR
// and changing the password.
const PAGE_SIZE = 10;
const LOGIN_PAGE = '/Login.html';

let creditRows = [];
let paymentRows = [];
const pageOf = { credits: 1, payments: 1 };

const STANDING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };
const STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };
const CREDIT_TONE = { Paid: 'badge-success', Partial: 'badge-warning', Unpaid: 'badge-neutral', Overdue: 'badge-danger' };

// ---- Start, sign out ----

function portalSignedOut(message) {
    try {
        sessionStorage.setItem('customerSignOutReason', message || '');
    } catch (error) {  }
    window.location.replace(LOGIN_PAGE);
}

async function startPortal() {
    let me;
    try {
        me = await apiPortalMe();
    } catch (error) {
        window.location.replace(LOGIN_PAGE);
        return;
    }
    if (!me.ok) {
        window.location.replace(LOGIN_PAGE);
        return;
    }

    document.getElementById('cp-name').textContent = me.body.name;
    document.body.hidden = false;
    // Right-align number columns and give each cell its column name on a phone, as the staff pages do.
    watchTablesForAlignment();
    showTab('credits');
}

async function handleLogout() {
    try {
        await apiPortalLogout();
    } catch (error) {  }
    window.location.replace(LOGIN_PAGE);
}

function toggleAccountMenu(event) {
    event.stopPropagation();
    const menu = document.getElementById('cp-menu');
    menu.hidden = !menu.hidden;
    document.getElementById('cp-account-btn').setAttribute('aria-expanded', String(!menu.hidden));
}

document.addEventListener('click', function () {
    const menu = document.getElementById('cp-menu');
    if (menu) menu.hidden = true;
});

// "Account" in the name menu at the top right opens the account summary.
function openAccount() {
    toggleSidebar(false);
    showTab('account');
}

// ---- Small helpers ----

function dayText(stamp) {
    return escapeHtml(String(stamp || '').slice(0, 10));
}

function emptyRow(tableId, columns, text) {
    const body = document.querySelector('#' + tableId + ' tbody');
    body.innerHTML = '<tr><td colspan="' + columns + '" class="table-empty">' + escapeHtml(text) + '</td></tr>';
}

function creditBadge(status) {
    return '<span class="badge ' + (CREDIT_TONE[status] || 'badge-neutral') + '">' + escapeHtml(status) + '</span>';
}

// Draws one page (10 rows) of a table and its Previous / Next controls.
function drawTable(name, rows, columns, rowHtml, emptyText) {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (pageOf[name] > pages) pageOf[name] = pages;
    const page = pageOf[name];

    const pager = document.getElementById(name + '-pager');
    if (rows.length === 0) {
        emptyRow(name + '-table', columns, emptyText);
        pager.innerHTML = '';
        pager.classList.add('is-single');
        return;
    }

    let html = '';
    const first = (page - 1) * PAGE_SIZE;
    const last = Math.min(first + PAGE_SIZE, rows.length);
    for (let i = first; i < last; i++) {
        html += rowHtml(rows[i]);
    }
    document.querySelector('#' + name + '-table tbody').innerHTML = html;

    if (pages === 1) {
        pager.innerHTML = '';
        pager.classList.add('is-single');
        return;
    }
    pager.classList.remove('is-single');
    pager.innerHTML =
        '<div class="pager-controls">' +
            '<button type="button" class="btn btn-sm" onclick="turnPage(\'' + name + '\', -1)"' +
                (page === 1 ? ' disabled' : '') + '>Previous</button>' +
            '<span class="pager-page">Page ' + page + ' of ' + pages + '</span>' +
            '<button type="button" class="btn btn-sm" onclick="turnPage(\'' + name + '\', 1)"' +
                (page === pages ? ' disabled' : '') + '>Next</button>' +
        '</div>';
}

function turnPage(name, step) {
    pageOf[name] += step;
    if (name === 'credits') renderCredits();
    if (name === 'payments') renderPayments();
}

// ---- Tabs ----

const TABS = ['account', 'credits', 'payments', 'loyalty'];
const TAB_TITLES = { account: 'Account', credits: 'Credits', payments: 'Payment History', loyalty: 'Loyalty Discount' };

// A sidebar link was clicked: open that section and close the sidebar on a phone.
function pickSection(event, name) {
    if (event) event.preventDefault();
    toggleSidebar(false);
    showTab(name);
}

async function showTab(name) {
    for (let i = 0; i < TABS.length; i++) {
        document.getElementById('panel-' + TABS[i]).hidden = TABS[i] !== name;
        // Account has no sidebar link (it is in the name menu), so only the others get highlighted.
        const link = document.getElementById('tab-' + TABS[i]);
        if (link) link.classList.toggle('active', TABS[i] === name);
    }
    document.getElementById('cp-title').textContent = TAB_TITLES[name];

    try {
        if (name === 'account') await loadAccount();
        if (name === 'credits') await loadCredits();
        if (name === 'payments') await loadPayments();
        if (name === 'loyalty') await loadLoyalty();
    } catch (error) {
        notifyOffline();
    }
}

// ---- Account ----

async function loadAccount() {
    const result = await apiPortalAccount();
    if (!result.ok) {
        notifyError(result.body.error || 'Your account could not be read.', 'Nothing to show');
        return;
    }

    const a = result.body;
    document.getElementById('cp-name').textContent = a.name;
    document.getElementById('account-facts').innerHTML =
        detailField('Name', escapeHtml(a.name)) +
        detailField('User ID', customerCode(a.customerId)) +
        detailField('Credit Limit', peso(a.creditLimit)) +
        detailField('Current Balance', '<span class="' + (a.balance > 0 ? 'cell-due' : '') + '">' + peso(a.balance) + '</span>') +
        detailField('Available Credit', peso(a.available)) +
        detailField('Credit Status', '<span class="badge ' + (STANDING_TONE[a.standing] || 'badge-neutral') + '">' +
            escapeHtml(STANDING_WORD[a.standing] || a.standing) + '</span>');
}

// ---- Credits ----

async function loadCredits() {
    const result = await apiPortalCredits();
    if (!result.ok) {
        notifyError(result.body.error || 'Your credits could not be read.', 'Nothing to show');
        return;
    }
    creditRows = result.body;
    renderCredits();
}

function renderCredits() {
    drawTable('credits', creditRows, 7, function (row) {
        const balance = Number(row.balance_due);
        return '<tr class="row-clickable" onclick="openCredit(' + row.sale_id + ')">' +
            '<td class="cell-id">' + orNumber(row.sale_id) + '</td>' +
            '<td>' + dayText(row.sale_date) + '</td>' +
            '<td class="cell-num">' + peso(row.amount_due) + '</td>' +
            '<td class="cell-num">' + peso(row.amount_paid) + '</td>' +
            '<td class="cell-num' + (balance > 0 ? ' cell-due' : '') + '">' + peso(balance) + '</td>' +
            '<td>' + dayText(row.due_date) + '</td>' +
            '<td>' + creditBadge(row.status) + '</td></tr>';
    }, 'There are no credit sales.');
}

function findCredit(saleId) {
    for (let i = 0; i < creditRows.length; i++) {
        if (Number(creditRows[i].sale_id) === Number(saleId)) return creditRows[i];
    }
    return null;
}

async function openCredit(saleId) {
    const sale = findCredit(saleId);
    if (!sale) return;

    // The payments made on this sale come from the payment history.
    try {
        const result = await apiPortalPayments();
        if (result.ok) paymentRows = result.body;
    } catch (error) {
        notifyOffline();
        return;
    }

    const mine = [];
    for (let i = 0; i < paymentRows.length; i++) {
        if (Number(paymentRows[i].sale_id) === Number(saleId)) {
            mine.push([dayText(paymentRows[i].payment_date), escapeHtml(paymentRows[i].payment_method),
                       escapeHtml(paymentReference(paymentRows[i].payment_method, paymentRows[i].reference_no)),
                       peso(paymentRows[i].amount)]);
        }
    }

    const balance = Number(sale.balance_due);
    let body = '<div class="detail-grid">' +
        detailField('OR Number', orNumber(sale.sale_id)) +
        detailField('Date', dayText(sale.sale_date)) +
        detailField('Sale Type', escapeHtml(sale.payment_method)) +
        detailField('Sale Amount', peso(sale.final_amount));
    if (Number(sale.penalty_amount) > 0) body += detailField('Late Penalty', peso(sale.penalty_amount));
    if (Number(sale.refunded_amount) > 0) body += detailField('Refunded', peso(sale.refunded_amount));
    body += detailField('Total Due', peso(sale.amount_due)) +
        detailField('Paid', peso(sale.amount_paid)) +
        detailField('Balance', '<span class="' + (balance > 0 ? 'cell-due' : '') + '">' + peso(balance) + '</span>') +
        detailField('Due Date', dayText(sale.due_date)) +
        detailField('Status', creditBadge(sale.status)) +
        '</div>';
    // The payments made on this sale, only when there are some.
    if (mine.length > 0) {
        body += '<h4 class="detail-subhead">Payments</h4>' +
            detailTable(['Date', 'Method', 'Reference', 'Amount'], mine, [3]);
    }

    let foot = '';
    if (balance > 0) {
        foot = '<button type="button" class="btn btn-accent" onclick="openPayByQr(' + sale.sale_id + ')">Pay by QR</button>';
    }
    openDetailModal(orNumber(sale.sale_id), 'Credit sale', 'OR', [{ label: 'Details', body: body }], foot, { wide: true });
}

// ---- Payment History ----

async function loadPayments() {
    const result = await apiPortalPayments();
    if (!result.ok) {
        notifyError(result.body.error || 'Your payments could not be read.', 'Nothing to show');
        return;
    }
    paymentRows = result.body;
    renderPayments();
}

function renderPayments() {
    drawTable('payments', paymentRows, 5, function (row) {
        return '<tr class="row-clickable" onclick="openPayment(' + row.payment_id + ')">' +
            '<td class="cell-id">' + (row.sale_id ? orNumber(row.sale_id) : '') + '</td>' +
            '<td>' + dayText(row.payment_date) + '</td>' +
            '<td>' + escapeHtml(row.payment_method) + '</td>' +
            '<td>' + escapeHtml(paymentReference(row.payment_method, row.reference_no)) + '</td>' +
            '<td class="cell-num">' + peso(row.amount) + '</td></tr>';
    }, 'There are no payments.');
}

function openPayment(paymentId) {
    let row = null;
    for (let i = 0; i < paymentRows.length; i++) {
        if (Number(paymentRows[i].payment_id) === Number(paymentId)) row = paymentRows[i];
    }
    if (!row) return;

    const reference = paymentReference(row.payment_method, row.reference_no);
    const body = '<div class="detail-grid">' +
        detailField('Date', escapeHtml(String(row.payment_date || '').slice(0, 16))) +
        detailField('OR Number', row.sale_id ? orNumber(row.sale_id) : '') +
        detailField('Method', escapeHtml(row.payment_method)) +
        detailField('Reference', escapeHtml(reference)) +
        detailField('Amount', peso(row.amount)) +
        '</div>';
    openDetailModal('Payment', row.sale_id ? orNumber(row.sale_id) : '', 'PY', [{ label: 'Details', body: body }], '');
}

// ---- Loyalty Discount ----

async function loadLoyalty() {
    const result = await apiPortalLoyalty();
    if (!result.ok) {
        notifyError(result.body.error || 'Your loyalty discount could not be read.', 'Nothing to show');
        return;
    }

    const l = result.body;
    let discount;
    if (!(l.rate > 0)) {
        discount = 'Switched off';
    } else if (l.qualifies) {
        discount = loyaltyRateText(l.rate) + ' off sales paid in full this month';
    } else {
        discount = 'None this month';
    }

    document.getElementById('loyalty-facts').innerHTML =
        detailField('Discount', escapeHtml(discount)) +
        detailField('Rate', l.rate > 0 ? loyaltyRateText(l.rate) : '0%') +
        detailField('Paid Last Month', peso(l.lastMonthPaid)) +
        detailField('Needed Last Month', peso(l.threshold)) +
        detailField('Paid So Far This Month', peso(l.thisMonthPaid));
}

// ---- Pay by QR ----

let paySale = null;
let qrState = null;
const QR_CHECK_MS = 3000;

function openPayByQr(saleId) {
    const sale = findCredit(saleId);
    if (!sale || !(Number(sale.balance_due) > 0)) return;
    paySale = sale;

    closeModal('detail-modal');
    document.getElementById('pay-sub').textContent = orNumber(sale.sale_id);
    document.getElementById('pay-wallet').value = 'GCash';
    const amount = document.getElementById('pay-amount');
    amount.max = Number(sale.balance_due);
    amount.value = Number(sale.balance_due).toFixed(2);
    showPayError('');
    document.getElementById('pay-make-btn').disabled = false;
    showModal('pay-modal');
}

function showPayError(text) {
    const box = document.getElementById('pay-error');
    box.textContent = text;
    box.hidden = text === '';
}

async function makeQrCode() {
    const wallet = document.getElementById('pay-wallet').value;
    const amount = Math.round(Number(document.getElementById('pay-amount').value) * 100) / 100;
    const balance = Number(paySale.balance_due);

    if (!(amount > 0)) {
        showPayError('Type the amount to pay.');
        return;
    }
    if (amount > balance) {
        showPayError('Only ' + peso(balance) + ' is owed on ' + orNumber(paySale.sale_id) + '.');
        return;
    }

    const button = document.getElementById('pay-make-btn');
    button.disabled = true;
    showPayError('');

    let result;
    try {
        result = await apiPortalCreateQr({ saleId: paySale.sale_id, wallet: wallet, amount: amount });
    } catch (error) {
        button.disabled = false;
        notifyOffline();
        return;
    }
    button.disabled = false;

    if (!result.ok) {
        showPayError(result.body.error || 'The QR code could not be made.');
        return;
    }

    closeModal('pay-modal');
    startQrModal(result.body);
}

function startQrModal(made) {
    qrState = {
        id: made.id, over: false, busy: false, closing: false,
        endsAt: Date.now() + (Number(made.secondsLeft) || 600) * 1000,
        ticker: null, poller: null
    };

    const words = made.wallet === 'PayMaya' ? 'PayMaya' : 'GCash';
    document.getElementById('qr-title').textContent = 'Pay by QR · ' + words;
    document.getElementById('qr-sub').textContent = orNumber(paySale.sale_id);
    document.getElementById('qr-amount').textContent = peso(made.amount);
    document.getElementById('qr-image').src = made.qrImage;

    // On a phone the customer can open the wallet app directly instead of scanning.
    const open = document.getElementById('qr-open-btn');
    open.textContent = made.wallet === 'PayMaya' ? 'Open Maya' : 'Open GCash';
    open.href = made.payUrl || '#';
    document.querySelector('#qr-modal .qr-box').classList.remove('is-over');
    document.getElementById('qr-clock').hidden = false;
    setQrStatus('Waiting for your payment...', '');
    setQrButtons('waiting');
    showModal('qr-modal');

    tickQr();
    qrState.ticker = setInterval(tickQr, 1000);
    qrState.poller = setInterval(pollQr, QR_CHECK_MS);
}

function setQrStatus(text, tone) {
    const box = document.getElementById('qr-status');
    box.textContent = text;
    box.className = 'qr-status' + (tone ? ' ' + tone : '');
}

function setQrButtons(state) {
    document.getElementById('qr-cancel-btn').hidden = state !== 'waiting';
    document.getElementById('qr-open-btn').hidden = state !== 'waiting';
    document.getElementById('qr-close-btn').hidden = state !== 'over';
    document.getElementById('qr-new-btn').hidden = state !== 'retry';
}

function stopQrTimers() {
    if (!qrState) return;
    clearInterval(qrState.ticker);
    clearInterval(qrState.poller);
    qrState.ticker = null;
    qrState.poller = null;
}

function tickQr() {
    if (!qrState || qrState.over) return;
    const left = Math.max(0, Math.ceil((qrState.endsAt - Date.now()) / 1000));
    const clock = document.getElementById('qr-countdown');
    clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    clock.parentElement.classList.toggle('is-ending', left <= 60);
    if (left === 0) pollQr();
}

// The code is finished without a payment; offer a new one.
function qrFinished(text) {
    stopQrTimers();
    qrState.over = true;
    document.querySelector('#qr-modal .qr-box').classList.add('is-over');
    document.getElementById('qr-clock').hidden = true;
    setQrStatus(text + ' Nothing was recorded.', 'is-stop');
    setQrButtons('retry');
    document.getElementById('qr-close-btn').hidden = false;
}

async function pollQr() {
    const state = qrState;
    if (!state || state.over || state.busy) return;
    state.busy = true;

    let result;
    try {
        result = await apiPortalQrStatus(state.id);
    } catch (error) {
        state.busy = false;
        setQrStatus('The server cannot be reached just now. Still trying...', 'is-stop');
        return;
    }
    state.busy = false;
    if (qrState !== state || state.over || !result.ok) return;

    const s = result.body;
    if (s.status === 'paid') {
        if (s.recorded) {
            qrPaidAndRecorded();
        } else if (s.problem) {
            stopQrTimers();
            state.over = true;
            document.getElementById('qr-clock').hidden = true;
            setQrStatus(s.problem, 'is-stop');
            setQrButtons('over');
        } else {
            setQrStatus('Payment received. Recording it...', 'is-good');
            setQrButtons('none');
        }
    } else if (s.status === 'failed') {
        qrFinished('The payment failed' + (s.errorMessage ? ': ' + s.errorMessage : '.'));
    } else if (s.status === 'expired') {
        qrFinished('The QR code expired before it was paid.');
    } else if (s.status === 'cancelled') {
        closeQrModal();
    } else {
        state.endsAt = Date.now() + (Number(s.secondsLeft) || 0) * 1000;
        if (s.checkError) {
            setQrStatus('The payment provider cannot be reached just now. Still trying...', 'is-stop');
        }
    }
}

function qrPaidAndRecorded() {
    stopQrTimers();
    qrState.over = true;
    setQrStatus('Payment received', 'is-good');
    setQrButtons('none');
    setTimeout(function () {
        closeQrModal();
        notifySuccess('Your payment was recorded.', 'Payment received');
        refreshAfterPayment();
    }, 900);
}

async function refreshAfterPayment() {
    try {
        await loadCredits();
        await loadAccount();
    } catch (error) {
        notifyOffline();
    }
}

function closeQrModal() {
    stopQrTimers();
    qrState = null;
    closeModal('qr-modal');
    document.getElementById('qr-image').removeAttribute('src');
    refreshAfterPayment();
}

function newQrCode() {
    closeQrModal();
    if (paySale) openPayByQr(paySale.sale_id);
}

async function askCancelQr() {
    const state = qrState;
    if (!state || state.over) return;

    const yes = await askConfirm('You have not paid yet. Cancel this QR code?', {
        title: 'Cancel this QR payment?',
        eyebrow: 'QR payment',
        mark: '!',
        tone: 'danger',
        confirmLabel: 'Cancel the QR',
        cancelLabel: 'Keep waiting'
    });
    if (!yes || qrState !== state || state.over) return;

    stopQrTimers();
    setQrStatus('Making sure nothing was paid...', '');
    setQrButtons('none');

    let result = null;
    try {
        result = await apiPortalCancelQr(state.id);
    } catch (error) {
        result = null;
    }

    if (result && result.ok && result.body.status === 'paid') {
        notifyInfo('You had already paid, so the payment is being recorded.', 'Already paid');
        state.over = false;
        state.poller = setInterval(pollQr, QR_CHECK_MS);
        pollQr();
        return;
    }
    if (!result || !result.ok) {
        notifyWarning('The server could not be reached to cancel the QR code. It closes by itself when its time runs out.',
            'Not cancelled');
    } else {
        notifyInfo('The QR payment was cancelled, so nothing was recorded.', 'QR payment cancelled');
    }
    closeQrModal();
}

// ---- Change password ----

function openChangePassword() {
    const form = document.getElementById('password-form');
    form.reset();
    document.getElementById('password-alert').hidden = true;
    document.getElementById('password-save-btn').disabled = false;
    showPasswordRules();
    showModal('password-modal');
    document.getElementById('pw-current').focus();
}

async function handleChangePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const alertBox = document.getElementById('password-alert');
    const button = document.getElementById('password-save-btn');

    const newPassword = form.elements.newPassword.value;
    const complaint = passwordComplaint(newPassword);
    let problem = '';
    if (complaint) {
        problem = complaint;
    } else if (newPassword !== form.elements.confirmPassword.value) {
        problem = 'The two new passwords are not the same.';
    }
    if (problem) {
        alertBox.textContent = problem;
        alertBox.hidden = false;
        return;
    }

    button.disabled = true;
    alertBox.hidden = true;
    try {
        const result = await apiPortalChangePassword({
            currentPassword: form.elements.currentPassword.value,
            newPassword: newPassword,
            confirmPassword: form.elements.confirmPassword.value
        });
        if (!result.ok) {
            alertBox.textContent = result.body.error || 'The password was not changed.';
            alertBox.hidden = false;
            button.disabled = false;
            return;
        }
        closeModal('password-modal');
        notifySuccess('Your password was changed.', 'Password changed');
    } catch (error) {
        button.disabled = false;
        notifyOffline();
    }
}

document.addEventListener('DOMContentLoaded', startPortal);
