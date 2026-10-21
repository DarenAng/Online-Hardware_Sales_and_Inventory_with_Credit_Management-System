const CURRENCY_SIGN = '\u20B1';

function peso(value) {
    const number = Number(value || 0);
    const text = Math.abs(number).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (number < 0) {
        return '-' + CURRENCY_SIGN + text;
    }
    return CURRENCY_SIGN + text;
}

function isUnpriced(product) {
    return !(Number(product.price) > 0);
}

function priceOrBadge(product) {
    if (isUnpriced(product)) return '<span class="badge badge-warning">No price</span>';
    return peso(product.price);
}

function unpricedFirst(rows) {
    const without = [];
    const priced = [];
    for (let i = 0; i < rows.length; i++) {
        if (isUnpriced(rows[i])) without.push(rows[i]);
        else priced.push(rows[i]);
    }
    return without.concat(priced);
}

const MEASURED_UNITS = {
    kilogram: { short: 'kg', step: 0.5 },
    kg:       { short: 'kg', step: 0.5 },
    gram:     { short: 'g',  step: 50 },
    meter:    { short: 'm',  step: 0.5 },
    metre:    { short: 'm',  step: 0.5 },
    liter:    { short: 'L',  step: 0.5 },
    litre:    { short: 'L',  step: 0.5 },
    foot:     { short: 'ft', step: 0.5 },
    gallon:   { short: 'gal', step: 0.5 }
};

function measuredUnit(unit) {
    return MEASURED_UNITS[String(unit || '').trim().toLowerCase()] || null;
}

function isMeasuredUnit(unit) {
    return measuredUnit(unit) !== null;
}

function qtyText(value, unit) {
    const number = Number(value) || 0;
    const measure = measuredUnit(unit);
    let figure;
    if (Number.isInteger(number)) {
        figure = String(number);
    } else {
        figure = String(Number(number.toFixed(3))).replace(/\.?0+$/, '');
    }

    let name = String(unit || '').trim();
    if (measure) {
        name = measure.short;
    }

    if (name) {
        return figure + ' ' + name;
    }
    return figure;
}

function statusBadge(text, label) {
    const good = ['Paid', 'Delivered', 'In Stock', 'Active', 'Received'];
    const bad = ['Unpaid', 'Failed', 'Out of Stock', 'Inactive', 'Cancelled'];
    const warn = ['Partial', 'Low Stock', 'Delayed', 'Pending', 'For Approval', 'In Transit', 'Out for Delivery', 'Missing'];

    let tone = 'badge-neutral';
    if (good.indexOf(text) !== -1) tone = 'badge-success';
    else if (bad.indexOf(text) !== -1) tone = 'badge-danger';
    else if (warn.indexOf(text) !== -1) tone = 'badge-warning';

    return '<span class="badge ' + tone + '">' + escapeHtml(label || statusWord(text)) + '</span>';
}

const STATUS_WORDS = { 'For Approval': 'Pending Manager Approval', 'Missing': 'Missing from delivery' };

function statusWord(text) {
    return STATUS_WORDS[text] || text;
}

const DOWN_PAYMENT_NOTE = 'Down payment at counter';

function paymentReference(method, reference) {
    if (String(method || '').toLowerCase() === 'cash') return '';
    if (!reference || reference === DOWN_PAYMENT_NOTE) return '';
    return String(reference);
}

function tableMessage(tableId, columns, text) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + columns + '" class="table-empty">' + text + '</td></tr>';
}

function setPill(id, text) {
    const pill = document.getElementById(id);
    if (pill) pill.textContent = text;
}

function whenText(stamp) {
    if (!stamp) return 'Time not recorded';

    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return String(stamp).slice(0, 16);

    const shown = when.toLocaleString('en-PH', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    });

    const minutes = Math.round((Date.now() - when.getTime()) / 60000);
    if (minutes < 1) return shown + ' · just now';
    if (minutes < 60) return shown + ' · ' + minutes + ' min ago';

    const hours = Math.round(minutes / 60);
    if (hours === 1) return shown + ' · 1 hour ago';
    if (hours < 24) return shown + ' · ' + hours + ' hours ago';

    const days = Math.round(hours / 24);
    if (days === 1) return shown + ' · 1 day ago';
    if (days < 31) return shown + ' · ' + days + ' days ago';

    return shown;
}

function sumOf(rows, field) {
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
        total = total + (Number(rows[i][field]) || 0);
    }
    return total;
}

function pieceCount(items) {
    let pieces = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isMeasuredUnit(item.unit_name)) {
            pieces = pieces + 1;
        } else {
            pieces = pieces + (Number(item.quantity) || 0);
        }
    }
    return pieces;
}

const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;

const PH_CODE = '63';
const PH_NATIONAL_DIGITS = 10;

function phoneDigitsAll(value) {
    let text = '';
    if (value !== null && value !== undefined) {
        text = String(value);
    }
    text = text.replace(/\D/g, '');
    text = text.replace(/^0+/, PH_CODE);
    text = text.replace(new RegExp('^' + PH_CODE + '0+'), PH_CODE);
    return text;
}

function phoneDigits(value) {
    return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

function phoneParts(boxOrValue) {
    const isBox = Boolean(boxOrValue && boxOrValue.nodeType === 1);
    if (isBox) {
        setupPhoneField(boxOrValue);
        const national = phoneNationalDigits(boxOrValue.value);
        if (national === '') {
            return { code: PH_CODE, digits: '' };
        }
        return { code: PH_CODE, digits: PH_CODE + national };
    }

    const digits = phoneDigitsAll(boxOrValue);
    if (digits.indexOf(PH_CODE) === 0) {
        return { code: PH_CODE, digits: digits };
    }
    return { code: '', digits: digits };
}

function phoneNationalDigits(value) {
    let text = '';
    if (value !== null && value !== undefined) {
        text = String(value);
    }
    text = text.replace(/\D/g, '');
    text = text.replace(/^0+/, '');
    return text;
}

function setupPhoneField(input) {
    if (!input || input.dataset.dialCode === PH_CODE) return;
    input.dataset.dialCode = PH_CODE;
    input.dataset.country = 'PH';
}

function onPhoneInput(input) {
    if (!input) return;
    setupPhoneField(input);

    const raw = String(input.value);
    const withCode = /^\s*(\+|00)\s*\d/.test(raw);
    let digits = raw.replace(/\D/g, '');

    if (withCode) {
        digits = raw.replace(/^\s*(\+|00)/, '').replace(/\D/g, '');
        const philippine = digits.indexOf(PH_CODE) === 0;
        if (philippine) {
            digits = digits.slice(PH_CODE.length);
            input.dataset.foreign = '';
        } else {
            input.dataset.foreign = '1';
        }
    } else {
        if (digits.length > PH_NATIONAL_DIGITS && digits.indexOf(PH_CODE) === 0) {
            digits = digits.slice(PH_CODE.length);
        }
        input.dataset.foreign = '';
    }

    let cleaned;
    if (input.dataset.foreign === '1') {
        cleaned = digits.slice(0, PHONE_MAX_DIGITS);
    } else {
        cleaned = phoneNationalDigits(digits).slice(0, PH_NATIONAL_DIGITS);
    }

    if (cleaned !== input.value) {
        input.value = cleaned;
    }

    input.classList.toggle('is-bad',
        cleaned !== '' && phoneComplaint(input) !== null);
}

function phoneComplaint(boxOrValue) {
    if (boxOrValue && boxOrValue.nodeType === 1 && boxOrValue.dataset.foreign === '1' &&
        String(boxOrValue.value).trim() !== '') {
        return 'Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.';
    }

    const parts = phoneParts(boxOrValue);
    const code = parts.code;
    const digits = parts.digits;

    if (digits === '') return null;

    if (code !== PH_CODE) {
        return 'Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.';
    }

    const national = digits.slice(PH_CODE.length);
    if (national.length !== PH_NATIONAL_DIGITS) {
        return 'A Philippine mobile number is ' + PH_NATIONAL_DIGITS + ' digits after +63 ' +
               '(09XX XXX XXXX). That one has ' + national.length + '.';
    }
    if (national[0] !== '9') {
        return 'A Philippine mobile number starts with 09 (or +63 9).';
    }
    return null;
}

function phoneToStore(boxOrValue) {
    const digits = phoneParts(boxOrValue).digits.slice(0, PHONE_MAX_DIGITS);
    if (digits === '') {
        return '';
    }
    return '+' + digits;
}

function phoneFill(input, stored) {
    if (!input) return;
    setupPhoneField(input);

    const digits = phoneDigits(stored);
    if (digits.indexOf(PH_CODE) === 0) {
        input.value = digits.slice(PH_CODE.length);
    } else {
        input.value = digits;
    }
    input.dataset.foreign = '';
    input.classList.remove('is-bad');
}

function phoneToInput(stored) {
    return phoneDigits(stored);
}

function phoneForDisplay(stored) {
    const digits = phoneDigits(stored);
    if (digits === '') return '';

    const national = digits.slice(PH_CODE.length);
    if (digits.indexOf(PH_CODE) === 0 && national.length === PH_NATIONAL_DIGITS) {
        return '+63 ' + national.slice(0, 3) + ' ' + national.slice(3, 6) + ' ' + national.slice(6);
    }
    return '+' + digits;
}

function saleAmountDue(sale) {
    if (!sale) return 0;
    let due = sale.final_amount;
    if (sale.amount_due !== undefined && sale.amount_due !== null) {
        due = sale.amount_due;
    }
    return Number(due) || 0;
}

function penaltyInBalance(sale) {
    const penalty = Number(sale.penalty_amount) || 0;
    const balance = Math.max(Number(sale.balance_due) || 0, 0);
    return Math.min(penalty, balance);
}

function penaltyRateWord(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n)) return '3%';
    if (Number.isInteger(n)) {
        return String(n) + '%';
    }
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '%';
}

function receiptLayoutOf(shop) {
    const layout = (shop && shop.receipt_layout) || {};
    return {
        paperWidth: Number(layout.paperWidth) || 80,
        fontSize: Number(layout.fontSize) || 12,
        title: layout.title || '',
        paidLabel: layout.paidLabel || '',
        headerLines: Array.isArray(layout.headerLines) ? layout.headerLines : [],
        footerLines: Array.isArray(layout.footerLines) ? layout.footerLines : [],
        show: layout.show || {}
    };
}

function receiptShows(layout, name) {
    return layout.show[name] !== false;
}

function applyReceiptPaper(element, shop) {
    if (!element) return;
    const layout = receiptLayoutOf(shop);
    element.style.width = layout.paperWidth + 'mm';
    element.style.fontSize = layout.fontSize + 'px';
    element.dataset.paperWidth = String(layout.paperWidth);
}

function setReceiptPageSize(shop) {
    const layout = receiptLayoutOf(shop);
    let style = document.getElementById('receipt-page-size');
    if (!style) {
        style = document.createElement('style');
        style.id = 'receipt-page-size';
        document.head.appendChild(style);
    }
    style.textContent = '@media print { @page { size: ' + layout.paperWidth + 'mm auto; margin: 3mm; } }';
}

function receiptHeadHtml(shop, taxRegistration, receiptNo, title) {
    const store = shop || {};
    const layout = receiptLayoutOf(store);

    let tinLabel = 'NON-VAT REG TIN';
    if ((taxRegistration || 'VAT') === 'VAT') {
        tinLabel = 'VAT REG TIN';
    }

    let html = '<div class="rc-head">';
    html += '<span class="rc-shop">' + escapeHtml(store.store_name || '') + '</span>';
    if (store.proprietor && receiptShows(layout, 'proprietor')) {
        html += '<span class="rc-prop">Prop. ' + escapeHtml(store.proprietor) + '</span>';
    }
    if (store.address) {
        html += '<span class="rc-addr">' + escapeHtml(store.address) + '</span>';
    }
    html += '<span class="rc-addr">' + tinLabel + ': ' + escapeHtml(store.tin || '') + '</span>';
    for (let i = 0; i < layout.headerLines.length; i++) {
        html += '<span class="rc-addr">' + escapeHtml(layout.headerLines[i]) + '</span>';
    }
    const headTitle = title || layout.title;
    if (headTitle) html += '<span class="rc-line">' + escapeHtml(headTitle) + '</span>';
    html += '<span class="rc-no">' + escapeHtml(receiptNo) + '</span>';
    html += '</div>';
    return html;
}

function receiptHtml(shop, parts) {
    const store = shop || {};
    const layout = receiptLayoutOf(store);
    const metaSwitch = { cashier: 'cashier', customer: 'customer', payment: 'payment', reference: 'reference' };

    const allMeta = parts.meta || [];
    const meta = [];
    for (let i = 0; i < allMeta.length; i++) {
        const row = allMeta[i];
        const hasValue = row.value !== null && row.value !== undefined && row.value !== '';
        if ((hasValue || row.keepBlank) &&
            (!metaSwitch[row.key] || receiptShows(layout, metaSwitch[row.key]))) {
            meta.push(row);
        }
    }

    let html = receiptHeadHtml(store, parts.registration, parts.receiptNo, parts.title);

    if (meta.length > 0) {
        let metaHtml = '';
        for (let i = 0; i < meta.length; i++) {
            metaHtml += '<span>' + escapeHtml(meta[i].label) + '</span><span>' + escapeHtml(meta[i].value) + '</span>';
        }
        html += '<div class="rc-meta">' + metaHtml + '</div>';
    }

    const totals = parts.totals || [];
    let totalsHtml = '';
    for (let i = 0; i < totals.length; i++) {
        const row = totals[i];
        let label = escapeHtml(row.label);
        if (row.due && receiptShows(layout, 'item_count') && parts.itemCount) {
            label += ' (' + escapeHtml(parts.itemCount) + ')';
        }
        totalsHtml += '<div' + (row.due ? ' class="rc-due"' : '') + '><span>' + label + '</span><span>' +
            row.value + '</span></div>';
    }

    html += '<div class="rc-rule"></div>';
    if (parts.itemsHtml) {
        html += '<table class="rc-items"><tbody>' + parts.itemsHtml + '</tbody></table>' +
            '<div class="rc-rule"></div>';
    }
    html += '<div class="rc-totals">' + totalsHtml + '</div>';

    if (parts.taxHtml && receiptShows(layout, 'tax')) {
        html += '<div class="rc-rule"></div>' + parts.taxHtml;
    }

    html += '<div class="rc-rule"></div>' +
        '<p class="rc-foot">' + escapeHtml(parts.paid ? layout.paidLabel : (parts.balanceText || '')) + '</p>';

    if (parts.detailsHtml) html += parts.detailsHtml;

    if (store.invoice_note && receiptShows(layout, 'note') && !parts.noInvoiceNote) {
        html += '<p class="rc-note">' + escapeHtml(store.invoice_note) + '</p>';
    }
    const footerLines = parts.footerLines || layout.footerLines;
    for (let i = 0; i < footerLines.length; i++) {
        html += '<p class="rc-thanks">' + escapeHtml(footerLines[i]) + '</p>';
    }
    return html;
}

const PASSWORD_RULES = [
    { need: 'at least 8 characters', ok: function (password) { return password.length >= 8; } },
    { need: 'an uppercase letter', ok: function (password) { return /[A-Z]/.test(password); } },
    { need: 'a lowercase letter', ok: function (password) { return /[a-z]/.test(password); } },
    { need: 'a number', ok: function (password) { return /[0-9]/.test(password); } },
    { need: 'a symbol such as ! ? - + . $ %', ok: function (password) { return /[^A-Za-z0-9\s]/.test(password); } },
    { need: 'no spaces', ok: function (password) { return !/\s/.test(password); } }
];

function passwordComplaint(password) {
    const text = String(password || '');
    if (text === '') return 'Type a password.';

    const missing = [];
    for (let i = 0; i < PASSWORD_RULES.length; i++) {
        if (!PASSWORD_RULES[i].ok(text)) {
            missing.push(PASSWORD_RULES[i].need);
        }
    }

    if (missing.length === 0) return null;
    return 'A password needs ' + missing.join(', ') + '.';
}

function showPasswordRules() {
    const lists = document.querySelectorAll('ul[data-rules-for]');
    for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        const box = document.getElementById(list.getAttribute('data-rules-for'));
        const typed = box ? box.value : '';

        let rulesHtml = '';
        for (let r = 0; r < PASSWORD_RULES.length; r++) {
            const rule = PASSWORD_RULES[r];
            const met = typed !== '' && rule.ok(typed);
            const words = rule.need.charAt(0).toUpperCase() + rule.need.slice(1);
            rulesHtml += '<li class="' + (met ? 'is-met' : '') + '">' + escapeHtml(words) + '</li>';
        }
        list.innerHTML = rulesHtml;
    }
}

document.addEventListener('input', function (event) {
    if (event.target && event.target.id &&
        document.querySelector('ul[data-rules-for="' + event.target.id + '"]')) {
        showPasswordRules();
    }
});

document.addEventListener('DOMContentLoaded', showPasswordRules);
