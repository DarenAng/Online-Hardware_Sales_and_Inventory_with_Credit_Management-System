// payment-details.js -- the bank and account behind a cheque or a bank transfer
// Loaded by: cashier-dashboard.html (the Payment card and the Credit Settlement card), delivery.html (Receive Payment)
//
// A cheque is taken with the account name and account number printed on it,
// the bank and the date written on it. A bank transfer is taken with the
// customer's bank, account name and account number. Each box keeps out what
// cannot belong in it as it is typed (letters in an account number) and says
// what is wrong under itself.
//
//   buildPaymentDetailsBox(boxId, prefix, transferByList)  puts the boxes in the page, once
//   showPaymentDetails(prefix, method)     shows the boxes the method needs
//   readChequeDetails(prefix)              what was typed for a cheque, checked
//   readTransferDetails(prefix)            what was typed for a bank transfer, checked
//   clearPaymentDetails(prefix)            empties every box
//   paymentDetailsReceiptHtml(rows)        the block printed on a receipt
//
// The same rules as payment-details.js in the backend, which checks them again.

// The banks a customer can pay from through PayMongo's online banking, and the
// smallest payment each takes. The server has the same list (PAYMONGO_BANKS).
const PAYMONGO_BANKS = [
    { code: 'bpi',       name: 'BPI',       minimum: 1 },
    { code: 'ubp',       name: 'UnionBank', minimum: 1 },
    { code: 'bdo',       name: 'BDO',       minimum: 100 },
    { code: 'landbank',  name: 'Landbank',  minimum: 1 },
    { code: 'metrobank', name: 'Metrobank', minimum: 1 }
];

function paymongoBank(code) {
    for (let i = 0; i < PAYMONGO_BANKS.length; i++) {
        if (PAYMONGO_BANKS[i].code === code) return PAYMONGO_BANKS[i];
    }
    return null;
}

// "2026-10-20" for a day, in this computer's own time zone
function pdDayText(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
}

// the earliest and latest date a cheque may carry: no earlier than today,
// and more than a year ahead is a typing mistake
function pdChequeLimits() {
    const now = new Date();
    return {
        earliest: pdDayText(now),
        latest: pdDayText(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()))
    };
}

// true when the text is a real calendar day ("2026-02-30" is not)
function pdIsRealDay(text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(5, 7));
    const day = Number(text.slice(8, 10));
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function pdChequeDateProblem(text) {
    if (text === '') return 'Enter the date written on the cheque.';
    if (!pdIsRealDay(text)) return 'The cheque date is not a real date. Use the date picker.';

    const limits = pdChequeLimits();
    if (text < limits.earliest) return 'A cheque cannot be dated before today. Pick today or a later date.';
    if (text > limits.latest) return 'That cheque is dated more than a year ahead. Check the date written on it.';
    return null;
}

// ---------- the boxes ----------
// a box with its label and, under it, the line that says what is wrong with it
function pdField(id, label, extra) {
    return '<div class="form-group"><label for="' + id + '">' + label + '</label>' + extra +
        '<span class="field-error" id="' + id + '-error" hidden></span></div>';
}

// kind: 'name' (letters, spaces and . , ' -), 'digits' (an account number) or
// 'bank' (letters, digits, spaces and . & -); what does not belong is kept out
// as it is typed
function pdInput(id, maxLength, placeholder, kind) {
    return '<input type="text" id="' + id + '" class="form-control" maxlength="' + maxLength + '" ' +
        'autocomplete="off" placeholder="' + placeholder + '"' +
        (kind === 'digits' ? ' inputmode="numeric"' : '') +
        ' oninput="pdLiveCheck(this, \'' + kind + '\')" onblur="pdLiveCheck(this, \'' + kind + '\', true)">';
}

const PD_KEEP = {
    name: { strip: /[^A-Za-z\u00C0-\u024F\u00D1\u00F1 .,'-]/g, words: 'Letters only.' },
    digits: { strip: /[^0-9]/g, words: 'Digits only.' },
    bank: { strip: /[^A-Za-z0-9\u00C0-\u024F .&-]/g, words: 'Letters and digits only.' }
};

// As a box is typed in: what does not belong is taken out, and the box says so.
// On leaving it (done): a figure too short is said too.
function pdLiveCheck(box, kind, done) {
    const rule = PD_KEEP[kind];
    if (!box || !rule) return;
    const before = box.value;
    const kept = before.replace(rule.strip, '');
    if (kept !== before) {
        const at = box.selectionStart - (before.length - kept.length);
        box.value = kept;
        if (at >= 0 && box.setSelectionRange) box.setSelectionRange(at, at);
        pdMark(box.id, rule.words);
        return;
    }
    let problem = null;
    if (done && kept.trim() !== '') {
        if (kind === 'digits' && pdAccountDigits(kept) === null) problem = 'An account number is 6 to 20 digits.';
        else if (kind !== 'digits' && kept.trim().length < 2) problem = 'Too short.';
    }
    pdMark(box.id, problem);
}

// shows (or, with no text, clears) the line under a box and its red edge
function pdMark(id, text) {
    const box = document.getElementById(id);
    const line = document.getElementById(id + '-error');
    if (box) box.classList.toggle('is-bad', Boolean(text));
    if (line) {
        line.textContent = text || '';
        line.hidden = !text;
    }
}

// the answer of a check, with the box it is about marked
function pdProblem(text, id) {
    pdMark(id, text);
    return { problem: text, field: id };
}

// Puts the cheque boxes and the bank-transfer boxes into the element boxId. Both
// are hidden until showPaymentDetails() asks for one. transferByList is true where
// the customer's bank is picked from the banks PayMongo supports (the till), and
// false where it is typed (the driver, who only writes down what the customer shows).
function buildPaymentDetailsBox(boxId, prefix, transferByList) {
    const box = document.getElementById(boxId);
    if (!box) return;

    let bankBox;
    let transferNote;
    if (transferByList) {
        let options = '<option value="">Pick the bank</option>';
        for (let i = 0; i < PAYMONGO_BANKS.length; i++) {
            options += '<option value="' + PAYMONGO_BANKS[i].code + '">' + escapeHtml(PAYMONGO_BANKS[i].name) + '</option>';
        }
        bankBox = pdField(prefix + '-transfer-bank', 'Bank',
            '<select id="' + prefix + '-transfer-bank" class="form-control" ' +
                'onchange="pdMark(this.id, null)">' + options + '</select>');
        transferNote = '';
    } else {
        bankBox = pdField(prefix + '-transfer-bank', 'Bank',
            pdInput(prefix + '-transfer-bank', 80, 'e.g. BDO', 'bank'));
        transferNote = 'Written down as the customer shows it. This transfer is not checked with PayMongo, ' +
            'so put the bank\'s own reference in the Reference box.';
    }

    box.innerHTML =
        '<div class="pay-details" id="' + prefix + '-cheque" hidden>' +
            '<p class="pay-details-title">Cheque details</p>' +
            '<div class="grid-2">' +
                pdField(prefix + '-cheque-name', 'Account name',
                    pdInput(prefix + '-cheque-name', 100, 'e.g. Juan Dela Cruz', 'name')) +
                pdField(prefix + '-cheque-number', 'Account number',
                    pdInput(prefix + '-cheque-number', 20, 'e.g. 0123456789', 'digits')) +
            '</div>' +
            '<div class="grid-2">' +
                pdField(prefix + '-cheque-bank', 'Bank',
                    pdInput(prefix + '-cheque-bank', 80, 'e.g. BDO', 'bank')) +
                pdField(prefix + '-cheque-date', 'Cheque date',
                    '<input type="date" id="' + prefix + '-cheque-date" class="form-control" ' +
                        'onchange="pdMark(this.id, pdChequeDateProblem(this.value))">') +
            '</div>' +
        '</div>' +
        '<div class="pay-details" id="' + prefix + '-transfer" hidden>' +
            '<p class="pay-details-title">Bank transfer</p>' +
            bankBox +
            '<div class="grid-2">' +
                pdField(prefix + '-transfer-name', 'Account name',
                    pdInput(prefix + '-transfer-name', 100, 'e.g. Juan Dela Cruz', 'name')) +
                pdField(prefix + '-transfer-number', 'Account number',
                    pdInput(prefix + '-transfer-number', 20, 'e.g. 0123456789', 'digits')) +
            '</div>' +
            (transferNote ? '<p class="pay-details-note">' + transferNote + '</p>' : '') +
        '</div>';

    // a cheque date outside what a bank takes cannot be picked
    const limits = pdChequeLimits();
    const dateBox = document.getElementById(prefix + '-cheque-date');
    dateBox.min = limits.earliest;
    dateBox.max = limits.latest;
}

// Shows the boxes the method needs and hides the others. Whatever was typed in
// a box that goes away is emptied, so a cheque's account is never sent with a
// payment that was changed to something else.
function showPaymentDetails(prefix, method) {
    const cheque = document.getElementById(prefix + '-cheque');
    const transfer = document.getElementById(prefix + '-transfer');
    if (cheque) {
        const wasShown = !cheque.hidden;
        cheque.hidden = method !== 'Cheque';
        if (wasShown && cheque.hidden) clearPaymentDetails(prefix, 'cheque');
    }
    if (transfer) {
        const wasShown = !transfer.hidden;
        transfer.hidden = method !== 'Bank Transfer';
        if (wasShown && transfer.hidden) clearPaymentDetails(prefix, 'transfer');
    }
}

function pdValue(id) {
    const box = document.getElementById(id);
    return box ? box.value : '';
}

function pdTidy(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

// the account number as digits only, or null when it is not a believable one
function pdAccountDigits(text) {
    const digits = String(text || '').replace(/[\s-]/g, '');
    if (!/^\d{6,20}$/.test(digits)) return null;
    return digits;
}

// null when the account name is fine, otherwise the sentence to show
function pdAccountNameProblem(name, whose) {
    if (name === '') return 'Enter the account name' + whose + '.';
    if (name.length < 2) return 'The account name is too short.';
    if (!/[A-Za-z]/.test(name)) return 'The account name needs letters in it.';
    return null;
}

// Gives back { problem, field, details }. problem is null when all is well;
// otherwise field is the id of the box to put the cursor in.
function readChequeDetails(prefix) {
    const name = pdTidy(pdValue(prefix + '-cheque-name'));
    const nameProblem = pdAccountNameProblem(name, ' on the cheque');
    if (nameProblem) return pdProblem(nameProblem, prefix + '-cheque-name');
    pdMark(prefix + '-cheque-name', null);

    const number = pdAccountDigits(pdValue(prefix + '-cheque-number'));
    if (number === null) {
        return pdProblem('Enter the account number on the cheque: 6 to 20 digits, no letters.', prefix + '-cheque-number');
    }
    pdMark(prefix + '-cheque-number', null);

    const bank = pdTidy(pdValue(prefix + '-cheque-bank'));
    if (bank.length < 2) return pdProblem('Enter the bank the cheque is drawn on.', prefix + '-cheque-bank');
    pdMark(prefix + '-cheque-bank', null);

    const date = pdValue(prefix + '-cheque-date');
    const dateProblem = pdChequeDateProblem(date);
    if (dateProblem) return pdProblem(dateProblem, prefix + '-cheque-date');
    pdMark(prefix + '-cheque-date', null);

    return {
        problem: null,
        field: null,
        details: { bank: bank, accountName: name, accountNumber: number, chequeDate: date }
    };
}

// For a bank transfer. At the till the bank is picked from PayMongo's list, so
// the answer carries bankCode too; for the driver the bank is typed.
function readTransferDetails(prefix) {
    const bankBox = document.getElementById(prefix + '-transfer-bank');
    let bank = '';
    let bankCode = null;
    if (bankBox && bankBox.tagName === 'SELECT') {
        const picked = paymongoBank(bankBox.value);
        if (!picked) return pdProblem('Pick the customer\'s bank from the list.', prefix + '-transfer-bank');
        bank = picked.name;
        bankCode = picked.code;
    } else {
        bank = pdTidy(pdValue(prefix + '-transfer-bank'));
        if (bank.length < 2) return pdProblem('Enter the customer\'s bank.', prefix + '-transfer-bank');
    }
    pdMark(prefix + '-transfer-bank', null);

    const name = pdTidy(pdValue(prefix + '-transfer-name'));
    const nameProblem = pdAccountNameProblem(name, '');
    if (nameProblem) return pdProblem(nameProblem, prefix + '-transfer-name');
    pdMark(prefix + '-transfer-name', null);

    const number = pdAccountDigits(pdValue(prefix + '-transfer-number'));
    if (number === null) {
        return pdProblem('Enter the account number: 6 to 20 digits, no letters.', prefix + '-transfer-number');
    }
    pdMark(prefix + '-transfer-number', null);

    return {
        problem: null,
        field: null,
        details: { bank: bank, bankCode: bankCode, accountName: name, accountNumber: number }
    };
}

// Empties the boxes; kind is 'cheque' or 'transfer' for one set, nothing for both.
function clearPaymentDetails(prefix, kind) {
    const ids = ['-cheque-name', '-cheque-number', '-cheque-bank', '-cheque-date',
                 '-transfer-bank', '-transfer-name', '-transfer-number'];
    for (let i = 0; i < ids.length; i++) {
        if (kind && ids[i].indexOf('-' + kind + '-') !== 0) continue;
        const box = document.getElementById(prefix + ids[i]);
        if (box) box.value = '';
        pdMark(prefix + ids[i], null);
    }
}

// ---------- showing what was recorded ----------
// A saved detail row, as the server sends it: { method, account_name,
// account_number, bank_name, branch, cheque_date }.

// "Cheque 001234 · BDO, Nasugbu · dated 2026-10-20 · Juan Dela Cruz, account 0123456789"
function paymentDetailsSummary(detail, reference) {
    const parts = [];
    if (detail.method === 'Cheque') {
        parts.push('Cheque' + (reference ? ' ' + reference : ''));
        parts.push(detail.bank_name + (detail.branch ? ', ' + detail.branch : ''));
        if (detail.cheque_date) parts.push('dated ' + detail.cheque_date);
    } else {
        parts.push('Bank transfer' + (reference ? ' ' + reference : ''));
        parts.push(detail.bank_name);
    }
    parts.push(detail.account_name + ', account ' + detail.account_number);
    return parts.join(' · ');
}

// "****6789": only the last four digits, for what is printed on paper
function maskedAccountNumber(number) {
    const text = String(number || '');
    return '****' + text.slice(-4);
}

// the lines of one detail as [label, value] pairs, for a receipt or a card.
// masked is true on a printed receipt: the account number shows its last four digits only.
function paymentDetailsRows(detail, reference, masked) {
    const number = masked ? maskedAccountNumber(detail.account_number) : detail.account_number;
    const rows = [];
    if (detail.method === 'Cheque') {
        if (reference) rows.push(['Cheque no.', reference]);
        rows.push(['Bank', detail.bank_name]);
        if (detail.branch) rows.push(['Branch', detail.branch]);
        if (detail.cheque_date) rows.push(['Cheque date', detail.cheque_date]);
        rows.push(['Account name', detail.account_name]);
        rows.push(['Account no.', number]);
    } else {
        rows.push(['Bank', detail.bank_name]);
        rows.push(['Account name', detail.account_name]);
        rows.push(['Account no.', number]);
        if (reference) rows.push(['Reference', reference]);
    }
    return rows;
}

// The details saved on a sale (GET /api/sales/:id), each with the reference it
// was taken under and a heading, ready for a receipt or a card. data has
// sale, payments and paymentDetails. A detail with a payment_id belongs to that
// payment on the account; one without it to the sale's own payment. The
// reference of a down payment at the counter is the one kept on the sale.
function paymentDetailItems(data) {
    const items = [];
    const list = data.paymentDetails || [];
    for (let i = 0; i < list.length; i++) {
        const detail = list[i];
        let reference = data.sale.reference_no;
        let label = detail.method + ' details';

        if (detail.payment_id) {
            const payments = data.payments || [];
            for (let p = 0; p < payments.length; p++) {
                if (payments[p].payment_id !== detail.payment_id) continue;
                label = detail.method + ' details \u00b7 payment of ' + peso(payments[p].amount);
                if (payments[p].reference_no && payments[p].reference_no !== DOWN_PAYMENT_NOTE) {
                    reference = payments[p].reference_no;
                }
            }
        }
        items.push({ detail: detail, reference: reference, label: label });
    }
    return items;
}

// the details of a sale as lines on a card; empty when it had none
function paymentDetailsCardHtml(data) {
    const items = paymentDetailItems(data);
    if (items.length === 0) return '';

    let html = '<h4 class="detail-subhead">Payment details</h4>';
    for (let i = 0; i < items.length; i++) {
        html += '<p class="detail-note">' + escapeHtml(paymentDetailsSummary(items[i].detail, items[i].reference)) + '</p>';
    }
    return html;
}

// One block on a receipt for each detail. items is a list of
// { detail, reference, label } (label is the heading, such as "Cheque" or "Cheque payment of 2,000.00").
// masked is true for a printed receipt (the account number is cut to its last four digits).
function paymentDetailsReceiptHtml(items, masked) {
    if (!items || items.length === 0) return '';

    let html = '';
    for (let i = 0; i < items.length; i++) {
        const rows = paymentDetailsRows(items[i].detail, items[i].reference, masked);
        let rowsHtml = '';
        for (let r = 0; r < rows.length; r++) {
            rowsHtml += '<div><span>' + escapeHtml(rows[r][0]) + '</span><span>' + escapeHtml(rows[r][1]) + '</span></div>';
        }
        html += '<div class="rc-rule"></div><div class="rc-bank">' +
            '<p class="rc-bank-head">' + escapeHtml(items[i].label) + '</p>' + rowsHtml + '</div>';
    }
    return html;
}
