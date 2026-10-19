// credit-terms.js -- the printed Credit Terms and Conditions page and the Customer Card
// Loaded by: manager.html, cashier-dashboard.html
//
// Two prints, both on A4 through the browser's own print dialogue ("Save as
// PDF" is in that dialogue):
//   printCreditTerms(customerId)  the terms page alone
//   printCustomerCard(customerId) the customer's card, then the terms page
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
    if (!stamp) return '&mdash;';
    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return '&mdash;';
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
            creditPrintRow('Address', c.address ? escapeHtml(c.address) : '&mdash;') +
            creditPrintRow('Contact number', c.phone ? escapeHtml(c.phone) : '&mdash;') +
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

// The customer's card: who they are, and where the account stands today.
function customerCardPage(data) {
    const c = data.customer;
    const owed = Number(c.current_credit) || 0;

    const standingWord = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

    return '<section class="cp-page">' +
        creditPrintHead(data) +
        '<h2>Customer Card</h2>' +

        '<h3>The customer</h3>' +
        '<table class="cp-facts">' +
            creditPrintRow('Name', escapeHtml(c.name)) +
            creditPrintRow('Address', c.address ? escapeHtml(c.address) : '&mdash;') +
            creditPrintRow('Contact number', c.phone ? escapeHtml(c.phone) : '&mdash;') +
        '</table>' +

        '<h3>The credit account today</h3>' +
        '<table class="cp-facts">' +
            creditPrintRow('Credit limit', peso(c.credit_limit), true) +
            creditPrintRow('Balance owed', peso(owed), true) +
            creditPrintRow('Available credit', peso(c.available_credit), true) +
            creditPrintRow('Credit rating', escapeHtml(standingWord[c.standing] || c.standing)) +
            creditPrintRow('Unpaid sales', String(c.open_sales) +
                (Number(c.overdue_sales) > 0 ? ' (' + c.overdue_sales + ' past due)' : ''), true) +
            creditPrintRow('Last purchase', printDay(c.last_purchase)) +
            creditPrintRow('Last payment', printDay(c.last_payment)) +
        '</table>' +

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

// the card, then the terms page after it
async function printCustomerCard(customerId) {
    if (typeof holdsFeature === 'function' && !holdsFeature('customer-card-print')) {
        notifyWarning('Printing a customer card is switched off for your role.', 'Not allowed');
        return;
    }
    const data = await readCreditPrint(apiGetCustomerCard, customerId, 'customer card');
    if (!data) return;

    printCreditSheets(customerCardPage(data) + creditTermsPage(data));
}
