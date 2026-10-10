// format.js -- formatting
// Loaded by: all five dashboards
//
// Small helpers used on every page:
//   peso(1234.5)          -> "₱1,234.50"
//   qtyText(2.5, 'kg')    -> "2.5 kg"
//   statusBadge('Paid')   -> a green badge
//   whenText(stamp)       -> "4 Sep 2026, 16:45 · 5 min ago"
//   phone helpers         -> check and format +63 mobile numbers
//
// Money is always printed with the peso sign as a text prefix; sheetCell in
// manager.js strips it again for the spreadsheet export.
const CURRENCY_SIGN = '\u20B1';       // the peso sign

function peso(value) {
    const number = Number(value || 0);
    const text = Math.abs(number).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (number < 0) {
        return '-' + CURRENCY_SIGN + text;
    }
    return CURRENCY_SIGN + text;
}

// Measured units (kg, m) accept decimals and step by a half; anything not
// listed here is counted and steps by one.
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
        // at most 3 decimals, and no zeros at the end: 2.500 -> "2.5"
        figure = String(Number(number.toFixed(3))).replace(/\.?0+$/, '');
    }

    let name = String(unit || '').trim();
    if (measure) {
        name = measure.short;   // "kilogram" -> "kg"
    }

    if (name) {
        return figure + ' ' + name;
    }
    return figure;
}

// label: what to print instead of the stored value (a purchase order says
// "Waiting for delivery" where the database says Pending)
function statusBadge(text, label) {
    const good = ['Paid', 'Delivered', 'In Stock', 'Active', 'Received'];
    const bad = ['Unpaid', 'Failed', 'Out of Stock', 'Inactive', 'Cancelled'];
    const warn = ['Partial', 'Low Stock', 'Delayed', 'Pending', 'For Approval', 'In Transit', 'Out for Delivery'];
    // a purchase order the supplier has taken on: in hand, not yet at the store
    const info = ['PO Accepted', 'On the way'];

    let tone = 'badge-neutral';
    if (good.indexOf(text) !== -1) tone = 'badge-success';
    else if (bad.indexOf(text) !== -1) tone = 'badge-danger';
    else if (warn.indexOf(text) !== -1) tone = 'badge-warning';
    else if (info.indexOf(text) !== -1) tone = 'badge-info';

    return '<span class="badge ' + tone + '">' + escapeHtml(label || statusWord(text)) + '</span>';
}

// how a stored status is said on screen; the stored value is unchanged
const STATUS_WORDS = { 'For Approval': 'Waiting for confirmation' };

function statusWord(text) {
    return STATUS_WORDS[text] || text;
}

function tableMessage(tableId, columns, text) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + columns + '" class="table-empty">' + text + '</td></tr>';
}

function setPill(id, text) {
    const pill = document.getElementById(id);
    if (pill) pill.textContent = text;
}

// "4 Sep 2026, 16:45" plus how long ago that was
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

// Adds up one field of every row.
// Example: sumOf([{ amount: 5 }, { amount: 7 }], 'amount') -> 12
function sumOf(rows, field) {
    let total = 0;
    for (const row of rows) {
        total = total + (Number(row[field]) || 0);
    }
    return total;
}

// Counts the pieces in a list of sold items. A measured item (like 2.5 kg of
// nails) counts as 1 piece; anything else counts its quantity.
function pieceCount(items) {
    let pieces = 0;
    for (const item of items) {
        if (isMeasuredUnit(item.unit_name)) {
            pieces = pieces + 1;
        } else {
            pieces = pieces + (Number(item.quantity) || 0);
        }
    }
    return pieces;
}

// Phone numbers are stored as + country code + digits (+639171234567). The
// box is a fixed +63 beside a digits-only field holding the ten national
// digits (9XX XXX XXXX); a number pasted whole (09XX..., +63 9XX...) is
// reduced to those ten. The same rule is enforced again in server.js.

// E.164 limits
const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;

const PH_CODE = '63';
const PH_NATIONAL_DIGITS = 10;

// Keeps only the digits of a phone number, and turns a leading 0 into 63.
// Example: "0917 123 4567" -> "639171234567"
function phoneDigitsAll(value) {
    let text = '';
    if (value !== null && value !== undefined) {
        text = String(value);
    }
    text = text.replace(/\D/g, '');                                  // remove everything that is not a digit
    text = text.replace(/^0+/, PH_CODE);                             // 0917... -> 63917...
    text = text.replace(new RegExp('^' + PH_CODE + '0+'), PH_CODE);  // 630917... -> 63917...
    return text;
}

function phoneDigits(value) {
    return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

// Takes a phone box or a string; returns every digit with the code in front,
// and the code on its own.
function phoneParts(boxOrValue) {
    // nodeType 1 means it is an HTML element (the input box itself)
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

// the digits inside +63: no trunk 0
function phoneNationalDigits(value) {
    let text = '';
    if (value !== null && value !== undefined) {
        text = String(value);
    }
    text = text.replace(/\D/g, '');    // only digits
    text = text.replace(/^0+/, '');    // no 0 at the start
    return text;
}

// every phone box is a +63 box; phoneParts reads the code from here
function setupPhoneField(input) {
    if (!input || input.dataset.dialCode === PH_CODE) return;
    input.dataset.dialCode = PH_CODE;
    input.dataset.country = 'PH';
}

// oninput on every phone box; rewrites rather than blocks so paste works too.
// Whatever was typed or pasted ends up as at most ten national digits: the
// +63 or 0063 in front of a whole number goes, then a trunk 0, then anything
// past the tenth digit. A number pasted under another code is kept as typed
// and marked, so the complaint below can say why it is refused.
function onPhoneInput(input) {
    if (!input) return;
    setupPhoneField(input);

    const raw = String(input.value);
    // does it start with a country code, written "+..." or "00..."?
    const withCode = /^\s*(\+|00)\s*\d/.test(raw);
    let digits = raw.replace(/\D/g, '');

    if (withCode) {
        digits = raw.replace(/^\s*(\+|00)/, '').replace(/\D/g, '');
        const philippine = digits.indexOf(PH_CODE) === 0;
        if (philippine) {
            digits = digits.slice(PH_CODE.length);   // remove the 63
            input.dataset.foreign = '';
        } else {
            input.dataset.foreign = '1';             // another country: marked as foreign
        }
    } else {
        // 639171234567 pasted without its +: the 63 is the code, not the number
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

// The sentence said about a bad number, or null. Returned, not shown.
function phoneComplaint(boxOrValue) {
    if (boxOrValue && boxOrValue.nodeType === 1 && boxOrValue.dataset.foreign === '1' &&
        String(boxOrValue.value).trim() !== '') {
        return 'Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.';
    }

    const parts = phoneParts(boxOrValue);
    const code = parts.code;
    const digits = parts.digits;

    if (digits === '') return null;                 // optional, and left empty

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

// what goes to the server: +639171234567, or nothing
function phoneToStore(boxOrValue) {
    const digits = phoneParts(boxOrValue).digits.slice(0, PHONE_MAX_DIGITS);
    if (digits === '') {
        return '';
    }
    return '+' + digits;
}

// a stored number put back into a box: +639171234567 shows as 9171234567
function phoneFill(input, stored) {
    if (!input) return;
    setupPhoneField(input);

    const digits = phoneDigits(stored);
    if (digits.indexOf(PH_CODE) === 0) {
        input.value = digits.slice(PH_CODE.length);   // the box already shows +63
    } else {
        input.value = digits;
    }
    input.dataset.foreign = '';
    input.classList.remove('is-bad');
}

function phoneToInput(stored) {
    return phoneDigits(stored);
}

// +63 917 123 4567 for Philippine mobiles; any other number as stored
function phoneForDisplay(stored) {
    const digits = phoneDigits(stored);
    if (digits === '') return '';

    const national = digits.slice(PH_CODE.length);
    if (digits.indexOf(PH_CODE) === 0 && national.length === PH_NATIONAL_DIGITS) {
        return '+63 ' + national.slice(0, 3) + ' ' + national.slice(3, 6) + ' ' + national.slice(6);
    }
    return '+' + digits;
}

// What a sale is owed against: the bill plus any late-payment penalty charged
// on it (sales.amount_due). A row from before the penalty columns existed
// carries only final_amount, and reads the same as it always did.
function saleAmountDue(sale) {
    if (!sale) return 0;
    let due = sale.final_amount;
    if (sale.amount_due !== undefined && sale.amount_due !== null) {
        due = sale.amount_due;
    }
    return Number(due) || 0;
}

// "3%" or "2.5%": a penalty rate as it is spoken (per month)
function penaltyRateWord(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n)) return '3%';
    if (Number.isInteger(n)) {
        return String(n) + '%';
    }
    // 2.50 -> "2.5": remove zeros at the end, then a "." left at the end
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + '%';
}


// ==========================================
// THE SALES INVOICE
// One builder for the till's invoice and Receipt Maintenance's preview, so
// the two cannot drift apart. Every word and switch on it comes from the
// settings row (store_settings.receipt_layout), which the server fills with
// its defaults: nothing about the layout is decided here.
// ==========================================
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

// a switch that was never saved counts as on
function receiptShows(layout, name) {
    return layout.show[name] !== false;
}

// the paper: a fixed width in millimetres, on screen and on the printer
function applyReceiptPaper(element, shop) {
    if (!element) return;
    const layout = receiptLayoutOf(shop);
    element.style.width = layout.paperWidth + 'mm';
    element.style.fontSize = layout.fontSize + 'px';
    element.dataset.paperWidth = String(layout.paperWidth);
}

// the printer is told the roll's width, so nothing is scaled or cut
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

// The head: the registered name, the proprietor, the address, the TIN with
// its registration, any lines the shop added, the title and the number.
function receiptHeadHtml(shop, taxRegistration, receiptNo) {
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
    layout.headerLines.forEach((line) => {
        html += '<span class="rc-addr">' + escapeHtml(line) + '</span>';
    });
    if (layout.title) html += '<span class="rc-line">' + escapeHtml(layout.title) + '</span>';
    html += '<span class="rc-no">' + escapeHtml(receiptNo) + '</span>';
    html += '</div>';
    return html;
}

// The whole invoice. "parts" is what the sale says:
//   { registration, receiptNo,
//     meta: [{ key: 'date'|'cashier'|'customer'|'payment'|'reference', label, value }],
//     itemsHtml, itemCount, totals: [{ label, value, due }], taxHtml,
//     paid: true/false, balanceText, bankHtml }
function receiptHtml(shop, parts) {
    const store = shop || {};
    const layout = receiptLayoutOf(store);
    const metaSwitch = { cashier: 'cashier', customer: 'customer', payment: 'payment', reference: 'reference' };

    const meta = (parts.meta || []).filter((row) =>
        row.value !== null && row.value !== undefined && row.value !== '' &&
        (!metaSwitch[row.key] || receiptShows(layout, metaSwitch[row.key])));

    let html = receiptHeadHtml(store, parts.registration, parts.receiptNo);

    if (meta.length > 0) {
        html += '<div class="rc-meta">' + meta.map((row) =>
            '<span>' + escapeHtml(row.label) + '</span><span>' + escapeHtml(row.value) + '</span>').join('') + '</div>';
    }

    html += '<div class="rc-rule"></div>' +
        '<table class="rc-items"><tbody>' + (parts.itemsHtml || '') + '</tbody></table>' +
        '<div class="rc-rule"></div>' +
        '<div class="rc-totals">' + (parts.totals || []).map((row) => {
            let label = escapeHtml(row.label);
            if (row.due && receiptShows(layout, 'item_count') && parts.itemCount) {
                label += ' (' + escapeHtml(parts.itemCount) + ')';
            }
            return '<div' + (row.due ? ' class="rc-due"' : '') + '><span>' + label + '</span><span>' +
                row.value + '</span></div>';
        }).join('') + '</div>';

    if (parts.taxHtml && receiptShows(layout, 'tax')) {
        html += '<div class="rc-rule"></div>' + parts.taxHtml;
    }

    html += '<div class="rc-rule"></div>' +
        '<p class="rc-foot">' + escapeHtml(parts.paid ? layout.paidLabel : (parts.balanceText || '')) + '</p>';

    if (parts.bankHtml && receiptShows(layout, 'bank')) html += parts.bankHtml;

    if (store.invoice_note && receiptShows(layout, 'note')) {
        html += '<p class="rc-note">' + escapeHtml(store.invoice_note) + '</p>';
    }
    layout.footerLines.forEach((line) => {
        html += '<p class="rc-thanks">' + escapeHtml(line) + '</p>';
    });
    return html;
}

// ==========================================
// PASSWORD RULES
// The same list as PASSWORD_RULES in server.js, which has the last word.
// Every box that sets a password has a checklist under it:
//   <ul class="password-rules" data-rules-for="the-box-id"></ul>
// ==========================================
const PASSWORD_RULES = [
    { need: 'at least 8 characters', ok: (password) => password.length >= 8 },
    { need: 'an uppercase letter', ok: (password) => /[A-Z]/.test(password) },
    { need: 'a lowercase letter', ok: (password) => /[a-z]/.test(password) },
    { need: 'a number', ok: (password) => /[0-9]/.test(password) },
    { need: 'a symbol such as ! ? - + . $ %', ok: (password) => /[^A-Za-z0-9\s]/.test(password) },
    { need: 'no spaces', ok: (password) => !/\s/.test(password) }
];

// null when the password follows every rule, otherwise the one sentence to show
function passwordComplaint(password) {
    const text = String(password || '');
    if (text === '') return 'Type a password.';

    const missing = [];
    for (const rule of PASSWORD_RULES) {
        if (!rule.ok(text)) {
            missing.push(rule.need);
        }
    }

    if (missing.length === 0) return null;
    return 'A password needs ' + missing.join(', ') + '.';
}

// draws every checklist on the page; a rule that is met gets a tick and turns green
function showPasswordRules() {
    document.querySelectorAll('ul[data-rules-for]').forEach((list) => {
        const box = document.getElementById(list.getAttribute('data-rules-for'));
        const typed = box ? box.value : '';

        list.innerHTML = PASSWORD_RULES.map((rule) => {
            const met = typed !== '' && rule.ok(typed);
            const words = rule.need.charAt(0).toUpperCase() + rule.need.slice(1);
            return '<li class="' + (met ? 'is-met' : '') + '">' + escapeHtml(words) + '</li>';
        }).join('');
    });
}

// the checklist follows the box as it is typed in
document.addEventListener('input', function (event) {
    if (event.target && event.target.id &&
        document.querySelector('ul[data-rules-for="' + event.target.id + '"]')) {
        showPasswordRules();
    }
});

document.addEventListener('DOMContentLoaded', showPasswordRules);
