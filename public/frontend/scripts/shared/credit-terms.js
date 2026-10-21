const CREDIT_PRINT_PAGE_STYLE_ID = 'credit-print-page-style';

let creditPrintRestore = null;

function printDate(stamp) {
    const when = new Date(stamp);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' });
}

function printDay(stamp) {
    if (!stamp) return 'Not set';
    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return 'Not set';
    return escapeHtml(when.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' }));
}

function creditPrintHead(data) {
    const store = data.store;
    let lines = '';
    if (store.proprietor) lines += '<p>Prop. ' + escapeHtml(store.proprietor) + '</p>';
    if (store.address) lines += '<p>' + escapeHtml(store.address) + '</p>';
    for (let i = 0; i < store.contact_lines.length; i++) {
        lines += '<p>' + escapeHtml(store.contact_lines[i]) + '</p>';
    }
    if (store.tin) lines += '<p>TIN ' + escapeHtml(store.tin) + '</p>';

    return '<div class="cp-head"><h1>' + escapeHtml(store.name) + '</h1>' + lines + '</div>';
}

function creditPrintRow(label, valueHtml, isNumber) {
    return '<tr><th>' + escapeHtml(label) + '</th><td' + (isNumber ? ' class="cell-num"' : '') + '>' +
        valueHtml + '</td></tr>';
}

function creditPrintFoot(data) {
    let text = 'Printed ' + printDate(data.printed_at);
    if (data.prepared_by) text += ' by ' + data.prepared_by;
    return '<p class="cp-foot">' + escapeHtml(text) + '</p>';
}

function creditTermsPage(data) {
    const c = data.customer;
    const t = data.terms;

    let rateText = penaltyRateWord(t.penalty_rate) + ' a month of the unpaid balance, for every month or part of a month a purchase stays unpaid after its due date';
    if (t.penalty_rate_is_own) rateText += ' (the rate set for this account)';

    let termsHtml = '';
    for (let i = 0; i < t.lines.length; i++) {
        termsHtml += '<li>' + escapeHtml(t.lines[i]) + '</li>';
    }

    return '<section class="cp-page">' +
        creditPrintHead(data) +
        '<h2>Credit Terms and Conditions</h2>' +

        '<h3>The customer</h3>' +
        '<table class="cp-facts">' +
            creditPrintRow('Name', escapeHtml(c.name)) +
            creditPrintRow('Address', c.address ? escapeHtml(c.address) : 'Not set') +
            creditPrintRow('Contact number', c.phone ? escapeHtml(c.phone) : 'Not set') +
        '</table>' +

        '<h3>The credit account</h3>' +
        '<table class="cp-facts">' +
            creditPrintRow('Credit limit', peso(c.credit_limit), true) +
            creditPrintRow('Payment due', t.due_days + ' days after the date of each credit purchase') +
            creditPrintRow('Late-payment penalty', escapeHtml(rateText)) +
            creditPrintRow('Interest', 'None is charged') +
        '</table>' +

        '<h3>Terms</h3>' +
        '<ol class="cp-terms">' + termsHtml + '</ol>' +

        '<div class="cp-sign">' +
            '<div class="cp-sign-box"><div class="cp-sign-line"></div>' +
                '<p class="cp-sign-label">Customer (signature over printed name)</p>' +
                '<p class="cp-sign-name">' + escapeHtml(c.name) + '</p>' +
                '<div class="cp-sign-line cp-date-line"></div><p>Date</p></div>' +
            '<div class="cp-sign-box"><div class="cp-sign-line"></div>' +
                '<p class="cp-sign-label">For ' + escapeHtml(data.store.name) + ' (authorized signature)</p>' +
                '<p class="cp-sign-name">&nbsp;</p>' +
                '<div class="cp-sign-line cp-date-line"></div><p>Date</p></div>' +
        '</div>' +

        creditPrintFoot(data) +
        '</section>';
}

const CARD_POLICY_TITLES = {
    credit: 'Credit Policy',
    'data-terms': 'Customer Data Terms',
    refund: 'Refund Policy'
};

function cardPolicyLines(text) {
    const kept = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '') kept.push(lines[i].trim());
    }
    return kept;
}

function cardInitials(name) {
    const words = String(name || '').trim().split(/\s+/);
    let initials = '';
    for (let i = 0; i < words.length && initials.length < 2; i++) {
        if (words[i]) initials += words[i][0].toUpperCase();
    }
    return initials || 'LH';
}

function cardStoreContact(store) {
    const parts = [];
    if (store.address) parts.push(store.address);
    const lines = store.contact_lines || [];
    for (let i = 0; i < lines.length; i++) parts.push(lines[i]);
    return parts.join(' \u00b7 ');
}

function customerCardBackHtml(store, policies, editing) {
    let body = '';
    const kinds = ['credit', 'data-terms', 'refund'];
    for (let k = 0; k < kinds.length; k++) {
        const lines = policies[kinds[k]] || [];
        let items = '';
        for (let i = 0; i < lines.length; i++) items += '<li>' + escapeHtml(lines[i]) + '</li>';
        body += '<section class="cc-policy' + (editing === kinds[k] ? ' is-editing' : '') + '">' +
            '<h4>' + CARD_POLICY_TITLES[kinds[k]] + '</h4>' +
            (items ? '<ol>' + items + '</ol>' : '<p class="cc-empty">Nothing written yet.</p>') +
            '</section>';
    }
    const contact = cardStoreContact(store);

    return '<div class="cc-card cc-back">' +
        '<div class="cc-back-head"><span>' + escapeHtml(store.name) + '</span><span>Terms and Policies</span></div>' +
        '<div class="cc-back-body">' + body + '</div>' +
        '<div class="cc-back-foot">' +
            '<div class="cc-sign"><span class="cc-sign-line"></span><span>Cardholder\'s signature</span></div>' +
            '<div class="cc-return">This card belongs to ' + escapeHtml(store.name) + '. If found, please return it' +
                (contact ? ': ' + escapeHtml(contact) : '.') + '</div>' +
        '</div>' +
    '</div>';
}

function customerCardFrontHtml(data) {
    const store = data.store;
    const c = data.customer;
    const contact = cardStoreContact(store);
    return '<div class="cc-card cc-front">' +
        '<div class="cc-front-band">' +
            '<div class="cc-logo">' + escapeHtml(cardInitials(store.name)) + '</div>' +
            '<div class="cc-front-store"><strong>' + escapeHtml(store.name) + '</strong>' +
                (contact ? '<span>' + escapeHtml(contact) + '</span>' : '') + '</div>' +
        '</div>' +
        '<div class="cc-front-main">' +
            '<span class="cc-front-kind">Customer Card</span>' +
            '<span class="cc-front-name">' + escapeHtml(c.name) + '</span>' +
            '<div class="cc-front-facts">' +
                '<div><span>Customer No.</span><strong>' + String(c.customer_id).padStart(6, '0') + '</strong></div>' +
                '<div><span>Contact</span><strong>' + (c.phone ? escapeHtml(c.phone) : 'Not set') + '</strong></div>' +
                '<div><span>Credit Limit</span><strong>' + peso(c.credit_limit) + '</strong></div>' +
            '</div>' +
        '</div>' +
        '<div class="cc-front-foot">Present this card with every credit purchase and payment.</div>' +
    '</div>';
}

function fitCustomerCard(card) {
    const body = card ? card.querySelector('.cc-back-body') : null;
    if (!body) return null;
    let size = 6.5;
    for (; size > 3; size -= 0.25) {
        body.style.fontSize = size + 'pt';
        if (body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1) break;
    }
    body.style.fontSize = size + 'pt';
    return size;
}

const CARD_SMALLEST_READABLE_PT = 4.5;

function customerCardSheet(data) {
    const policies = {
        credit: data.terms.lines,
        'data-terms': data.policies ? data.policies.data_terms : [],
        refund: data.policies ? data.policies.refund_policy : []
    };
    const measure = document.createElement('div');
    measure.className = 'cc-measure';
    measure.innerHTML = customerCardBackHtml(data.store, policies, null);
    document.body.appendChild(measure);
    fitCustomerCard(measure.querySelector('.cc-card'));
    const back = measure.innerHTML;
    measure.remove();

    return '<section class="cp-page cc-sheet">' +
        '<div class="cc-pair">' + customerCardFrontHtml(data) + back + '</div>' +
        '</section>';
}

function finishCreditPrint() {
    if (creditPrintRestore) creditPrintRestore();
}

function printCreditSheets(html, pageMargin) {
    finishCreditPrint();

    const sheet = document.createElement('div');
    sheet.id = 'credit-print';
    sheet.className = 'credit-print';
    sheet.innerHTML = html;
    document.body.appendChild(sheet);

    const style = document.createElement('style');
    style.id = CREDIT_PRINT_PAGE_STYLE_ID;
    style.textContent = '@media print { @page { size: A4; margin: ' + (pageMargin || '16mm') + '; } }';
    document.head.appendChild(style);

    document.body.classList.add('printing-credit');

    creditPrintRestore = function () {
        if (!creditPrintRestore) return;
        creditPrintRestore = null;
        document.body.classList.remove('printing-credit');
        sheet.remove();
        style.remove();
    };

    window.addEventListener('afterprint', function once() {
        window.removeEventListener('afterprint', once);
        if (creditPrintRestore) creditPrintRestore();
    });

    window.print();
    window.setTimeout(function () {
        if (creditPrintRestore) creditPrintRestore();
    }, 1500);
}

function explainReadFailure(error, message, title) {
    if (error && (error.status === 401 || error.status === 403)) return;
    if (error && error.status) {
        notifyError(message, title);
    } else {
        notifyOffline();
    }
}

async function readCreditPrint(reader, customerId, what) {
    try {
        return await reader(customerId);
    } catch (error) {
        explainReadFailure(error, 'The ' + what + ' could not be prepared.', 'Nothing to print');
        return null;
    }
}

async function printCreditTerms(customerId) {
    if (typeof holdsFeature === 'function' && !holdsFeature('credit-terms-print')) {
        notifyWarning('Printing the credit terms is switched off for your role.', 'Not allowed');
        return;
    }
    const data = await readCreditPrint(apiGetCreditTerms, customerId, 'credit terms');
    if (!data) return;

    printCreditSheets(creditTermsPage(data));
}

async function printCustomerCard(customerId) {
    if (typeof holdsFeature === 'function' && !holdsFeature('customer-card-print')) {
        notifyWarning('Printing a customer card is switched off for your role.', 'Not allowed');
        return;
    }
    const data = await readCreditPrint(apiGetCustomerCard, customerId, 'customer card');
    if (!data) return;

    printCreditSheets(customerCardSheet(data), '0');
}
