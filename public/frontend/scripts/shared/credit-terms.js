// credit-terms.js -- the printed Credit Terms and Conditions page and the Customer Card
// Loaded by: manager.html, cashier-dashboard.html
//
// Two prints, both on A4 through the browser's own print dialogue ("Save as
// PDF" is in that dialogue):
//   printCreditTerms(customerId)  the terms page alone
//   printCustomerCard(customerId) the physical customer card (front and back,
//                                 true size, to cut out), on one page
//
// The back of the card carries the three policies the manager keeps in Policy
// Maintenance (credit policy, customer data terms, refund policy).
// customerCardBackHtml draws it for the print and for the preview beside those
// pages; fitCustomerCard shrinks its text until it fits the card.
//
// The page is built here from what the server reads out of the account
// (GET /api/credit/terms/:id and /api/credit/card/:id): the store's details,
// the customer, the credit limit, the days to pay and the late-payment rate.
// Nothing on the page is typed in by hand but the wording of the terms, which
// the manager writes (Credit Terms Wording). It is put on the page for the
// moment of printing and taken off again afterwards.

// the style tag that sets the paper size while a page is printing
const CREDIT_PRINT_PAGE_STYLE_ID = 'credit-print-page-style';

let creditPrintRestore = null;      // set while a page is on the paper; calling it puts the screen back

function printDate(stamp) {
    const when = new Date(stamp);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' });
}

// "2026-10-01 10:00:00" -> "1 October 2026", or a dash when there is none
function printDay(stamp) {
    if (!stamp) return 'Not set';
    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return 'Not set';
    return escapeHtml(when.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' }));
}

// the store at the head of each page: name, owner, address, TIN, and the
// contact lines the administrator put in the receipt's header
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

// one row of a two-column list of facts
function creditPrintRow(label, valueHtml, isNumber) {
    return '<tr><th>' + escapeHtml(label) + '</th><td' + (isNumber ? ' class="cell-num"' : '') + '>' +
        valueHtml + '</td></tr>';
}

function creditPrintFoot(data) {
    let text = 'Printed ' + printDate(data.printed_at);
    if (data.prepared_by) text += ' by ' + data.prepared_by;
    return '<p class="cp-foot">' + escapeHtml(text) + '</p>';
}

// The terms page: the store, the customer, the account's figures, the terms
// and the signature lines.
function creditTermsPage(data) {
    const c = data.customer;
    const t = data.terms;

    // the rate says whose it is when the manager gave this account its own
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

// ---------- the physical customer card ----------
// ID-1 size, the size of a bank card: 85.6 x 54 mm. Drawn in mm, so the print is
// true size; the preview scales it up.
const CARD_POLICY_TITLES = {
    credit: 'Credit Policy',
    'data-terms': 'Customer Data Terms',
    refund: 'Refund Policy'
};

// the filled-in lines of a policy's text
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

// the store's address and contact lines, as one line for the small print
function cardStoreContact(store) {
    const parts = [];
    if (store.address) parts.push(store.address);
    const lines = store.contact_lines || [];
    for (let i = 0; i < lines.length; i++) parts.push(lines[i]);
    return parts.join(' \u00b7 ');
}

// The back: the three policies, the cardholder's signature and where to return
// a lost card. policies is { credit: [lines], 'data-terms': [lines], refund: [lines] };
// editing names the policy being written, which the preview marks.
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

// The front: the store, the cardholder and the account's limit
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

// Shrinks the back's text until it fits the card, from 6.5pt down to 3pt.
// Answers the size used (in pt). The card must be laid out (on screen) to measure.
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

// below this the back is too small to read on a card that size
const CARD_SMALLEST_READABLE_PT = 4.5;

// The sheet with the card on it: front and back side by side at true size,
// fitted on screen out of sight first (a print-only element cannot be measured)
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
        creditPrintHead(data) +
        '<h2>Customer Card</h2>' +
        '<p class="cc-instructions">Cut along the dotted line, fold at the middle so the printed sides face out, ' +
            'and laminate. The cardholder signs the back.</p>' +
        '<div class="cc-pair">' + customerCardFrontHtml(data) + back + '</div>' +
        creditPrintFoot(data) +
        '</section>';
}

// Puts the pages on the paper: the rest of the screen is hidden while the
// print dialogue is open (css/shared/general-ui.css, body.printing-credit).
// Any other print on a page that has these (the invoice, a report, a purchase
// order) calls this first, so a credit page left on the paper cannot hide it.
function finishCreditPrint() {
    if (creditPrintRestore) creditPrintRestore();
}

function printCreditSheets(html) {
    // a print still waiting to be put back (a second press) is finished first
    finishCreditPrint();

    const sheet = document.createElement('div');
    sheet.id = 'credit-print';
    sheet.className = 'credit-print';
    sheet.innerHTML = html;
    document.body.appendChild(sheet);

    // A4 with an even margin; added now and removed after, like the receipt's paper size
    const style = document.createElement('style');
    style.id = CREDIT_PRINT_PAGE_STYLE_ID;
    style.textContent = '@media print { @page { size: A4; margin: 16mm; } }';
    document.head.appendChild(style);

    document.body.classList.add('printing-credit');

    creditPrintRestore = function () {
        if (!creditPrintRestore) return;
        creditPrintRestore = null;
        document.body.classList.remove('printing-credit');
        sheet.remove();
        style.remove();
    };

    // afterprint puts the screen back; the timer covers a browser that never sends it
    window.addEventListener('afterprint', function once() {
        window.removeEventListener('afterprint', once);
        if (creditPrintRestore) creditPrintRestore();
    });

    window.print();
    window.setTimeout(function () {
        if (creditPrintRestore) creditPrintRestore();
    }, 1500);
}

// Says why a read failed, once. A 401 or 403 has already been explained by
// handleAuthFailure (the sign-in page, or a "Not allowed" message), so nothing
// more is said; any other answer from the server is an error; no answer at all
// is the connection.
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

// the card alone, on one page
async function printCustomerCard(customerId) {
    if (typeof holdsFeature === 'function' && !holdsFeature('customer-card-print')) {
        notifyWarning('Printing a customer card is switched off for your role.', 'Not allowed');
        return;
    }
    const data = await readCreditPrint(apiGetCustomerCard, customerId, 'customer card');
    if (!data) return;

    printCreditSheets(customerCardSheet(data));
}
