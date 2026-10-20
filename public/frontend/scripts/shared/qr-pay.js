// qr-pay.js -- GCash, PayMaya or a bank transfer paid by QR code
// Loaded by: the cashier's page and the driver's page, after payment-details.js
//
// The Pay by QR card, and the waiting for the customer to pay it. Used for a
// sale and a payment on a balance at the counter, and for a COD delivery paid at
// the door. The card's markup is put on the page here, so both pages share one.
//
// The customer scans a code instead of typing a reference. The
// code is made on the server (routes/qr-payments.js) through PayMongo or
// its offline simulation, and holds the address of the page the customer pays
// on (for a bank transfer, their bank's own online-banking page, with the bank
// and account the cashier typed kept on the QR payment). The server is asked every three seconds, and at once when the live
// channel says a QR payment changed, whether it has been paid; only then is
// the sale or the payment sent, carrying the QR payment's id, and the server
// checks it again before recording anything.
const QR_METHODS = ['GCash', 'PayMaya', 'Bank Transfer'];
const QR_CHECK_MS = 3000;

// the code on screen, or null; one at a time
let qrSession = null;

// A QR payment the customer made that no sale took (the server refused the
// sale after the money was in: an item ran out). The next QR payment for the
// same amount uses it rather than charging the customer twice.
let qrPaidUnused = null;

const QR_APP_WORDS = { 'GCash': 'GCash', 'PayMaya': 'Maya', 'Bank Transfer': 'Bank Transfer' };

// a change to any QR payment: the code on screen is asked about straight away
if (typeof onLiveChange === 'function') {
    onLiveChange(['qr-payments'], function () { if (qrSession && !qrSession.over) checkQr(qrSession); });
}


// ---------- the card ----------
// Locked: it closes only through its own buttons, so the checking always stops.
// data-modal-scroll: the card stays 440 wide on one page, so the code is never
// moved off the screen onto a second page (modals.js).
const QR_MODAL_HTML =
    '<div class="modal" id="qr-modal" data-modal-locked data-modal-scroll>\n' +
    '    <div class="modal-box qr-box">\n' +
    '        <div class="modal-head">\n' +
    '            <div class="modal-identity">\n' +
    '                <div class="avatar"><i class="bi bi-qr-code" aria-hidden="true"></i></div>\n' +
    '                <div>\n' +
    '                    <h3 id="qr-title">Pay by QR</h3>\n' +
    '                    <span class="modal-role" id="qr-sub"></span>\n' +
    '                </div>\n' +
    '            </div>\n' +
    '        </div>\n' +
    '        <div class="modal-body">\n' +
    '            <p class="qr-amount" id="qr-amount"></p>\n' +
    '            <!-- above the code, so it is never pushed onto a second page on a short screen -->\n' +
    '            <p class="qr-status" id="qr-status" role="status" aria-live="polite"></p>\n' +
    '            <p class="qr-clock" id="qr-clock">The code expires in <strong id="qr-countdown">10:00</strong></p>\n' +
    '            <div class="qr-frame">\n' +
    '                <img id="qr-image" alt="QR code for the customer to scan" width="240" height="240">\n' +
    '            </div>\n' +
    '            <p class="qr-ask" id="qr-ask">Ask the customer to scan the code with their phone\'s camera.</p>\n' +
    '            <!-- a bank transfer only: the same page the code opens, for testing in PayMongo test mode or a customer who is\n' +
    '                 at this computer rather than scanning -->\n' +
    '            <p class="qr-link" id="qr-link-row" hidden>\n' +
    '                <a id="qr-link" href="#" target="_blank" rel="noopener">Open the bank\'s page on this computer</a>\n' +
    '            </p>\n' +
    '        </div>\n' +
    '        <div class="modal-foot qr-foot">\n' +
    '            <button type="button" class="btn btn-ghost" id="qr-cancel-btn" onclick="cancelQrPayment()">Cancel</button>\n' +
    '            <!-- after a failed or expired code -->\n' +
    '            <button type="button" class="btn btn-ghost" id="qr-other-btn" onclick="chooseAnotherMethod()" hidden>Choose another method</button>\n' +
    '            <button type="button" class="btn btn-success" id="qr-new-btn" onclick="newQrCode()" hidden>New QR</button>\n' +
    '        </div>\n' +
    '    </div>\n' +
    '</div>\n';

(function addQrModal() {
    if (document.getElementById('qr-modal')) return;
    const holder = document.createElement('div');
    holder.innerHTML = QR_MODAL_HTML;
    document.body.appendChild(holder.firstElementChild);
})();

// Shows a code for amount and waits. purpose is 'sale' or 'credit_payment'
// (then saleId is the sale being paid). bank is { bankCode, bank, accountName,
// accountNumber } for a Bank Transfer (readTransferDetails), otherwise null.
// Resolves to { id, reference, amount } once paid, or null when the cashier
// cancelled or chose another method (the reason already said on screen).
async function collectQrPayment(amount, what, method, purpose, saleId, bank) {
    amount = Math.round(amount * 100) / 100;

    if (qrPaidUnused) {
        // a transfer is only reused for the same bank and account; the details copied
        // when the money is recorded are the ones on that payment
        let sameAccount = true;
        if (method === 'Bank Transfer') {
            sameAccount = Boolean(qrPaidUnused.bank && bank &&
                qrPaidUnused.bank.bankCode === bank.bankCode &&
                qrPaidUnused.bank.accountNumber === bank.accountNumber);
        }
        if (Math.abs(qrPaidUnused.amount - amount) < 0.005 && qrPaidUnused.wallet === method && sameAccount) {
            notifyInfo('The customer already paid ' + peso(amount) + ' by QR (' + qrPaidUnused.reference +
                '), so that payment is used. No new code is needed.', 'Using the earlier QR payment');
            return qrPaidUnused;
        }
        notifyWarning('A QR payment of ' + peso(qrPaidUnused.amount) + ' (' + qrPaidUnused.reference +
            ') was taken but never recorded. The manager\'s QR Payments list shows it as needing a refund.',
            'An earlier QR payment is unused');
    }

    return new Promise(function (resolve) {
        const session = {
            amount: amount, what: what, method: method, bank: bank || null,
            purpose: purpose || 'sale', saleId: saleId || null,
            id: null, resolve: resolve, ticker: null, poller: null, inflight: null,
            endsAt: 0, closing: false, over: false, done: false
        };
        qrSession = session;
        startQrCode(session);
    });
}

// Makes a code for the session (again, after New QR) and puts it on screen.
async function startQrCode(session) {
    session.id = null;
    session.over = false;
    session.closing = false;
    showQrCard(session, null);
    setQrStatus('Making the QR code...', '');
    if (!isModalOpen('qr-modal')) showModal('qr-modal');

    let made;
    try {
        const request = {
            amount: session.amount, wallet: session.method,
            purpose: session.purpose, saleId: session.saleId
        };
        if (session.bank) {
            request.bankCode = session.bank.bankCode;
            request.accountName = session.bank.accountName;
            request.accountNumber = session.bank.accountNumber;
        }
        const response = await apiCreateQrPayment(request);
        made = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, made)) {
                endQr(session, null);
                notifyError(made.error, 'No QR code');
            }
            return;
        }
    } catch (error) {
        endQr(session, null);
        notifyOffline();
        return;
    }
    if (session.done) return;

    session.id = made.id;
    session.endsAt = Date.now() + (Number(made.secondsLeft) || 600) * 1000;
    showQrCard(session, made);
    setQrStatus('Waiting for the customer to pay...', '');

    tickQr();
    session.ticker = setInterval(tickQr, 1000);
    session.poller = setInterval(function () { if (qrSession === session) checkQr(session); }, QR_CHECK_MS);
}

function isModalOpen(id) {
    const modal = document.getElementById(id);
    return Boolean(modal && modal.classList.contains('open'));
}

// the card's words, the code and the buttons; made is null while the code is
// being made. The page address the code holds is kept on the image
// (data-pay-url) for the tests, and is not shown.
function showQrCard(session, made) {
    const isBank = session.method === 'Bank Transfer' && session.bank;
    if (isBank) {
        document.getElementById('qr-title').textContent = 'Pay by Bank Transfer · ' + session.bank.bank;
        document.getElementById('qr-ask').textContent =
            'Ask the customer to scan the code with their phone\'s camera.';
    } else {
        document.getElementById('qr-title').textContent = 'Pay by QR · ' + (QR_APP_WORDS[session.method] || session.method);
        document.getElementById('qr-ask').textContent =
            'Ask the customer to scan the code with their phone\'s camera and pay with ' +
            (QR_APP_WORDS[session.method] || session.method) + '.';
    }
    document.getElementById('qr-sub').textContent = session.what;
    document.getElementById('qr-amount').textContent = peso(session.amount);

    const image = document.getElementById('qr-image');
    const linkRow = document.getElementById('qr-link-row');
    const link = document.getElementById('qr-link');
    if (made) {
        image.src = made.qrImage;
        image.setAttribute('data-pay-url', made.payUrl || '');
        // no link to the bank's page on this computer: the bank's page is good
        // for one opening, and the customer's phone is the one that needs it
        if (linkRow) linkRow.hidden = true;
    } else {
        image.removeAttribute('src');
        image.removeAttribute('data-pay-url');
        if (linkRow) linkRow.hidden = true;
        if (link) link.removeAttribute('href');
    }

    document.getElementById('qr-clock').hidden = !made;
    document.querySelector('#qr-modal .qr-box').classList.remove('is-over');
    setQrButtons('waiting');
}

function setQrStatus(text, tone) {
    const box = document.getElementById('qr-status');
    if (!box) return;
    box.textContent = text;
    box.className = 'qr-status' + (tone ? ' ' + tone : '');
}

// waiting: Cancel. over (failed or ran out): Choose another method, New QR.
// busy: nothing can be pressed.
function setQrButtons(state) {
    function show(id, visible, enabled) {
        const button = document.getElementById(id);
        if (!button) return;
        button.hidden = !visible;
        button.disabled = !enabled;
    }
    show('qr-cancel-btn', state !== 'over', state === 'waiting');
    show('qr-other-btn', state === 'over', true);
    show('qr-new-btn', state === 'over', true);
}

function stopQrTimers(session) {
    clearInterval(session.ticker);
    clearInterval(session.poller);
    session.ticker = null;
    session.poller = null;
}

// The card closes and the checking stops, whatever closed it; whoever is
// waiting on collectQrPayment hears the outcome.
function endQr(session, result) {
    if (session.done) return;
    session.done = true;
    stopQrTimers(session);
    if (qrSession === session) qrSession = null;
    closeModal('qr-modal');
    const image = document.getElementById('qr-image');
    image.removeAttribute('src');
    image.removeAttribute('data-pay-url');
    const linkRow = document.getElementById('qr-link-row');
    if (linkRow) linkRow.hidden = true;
    session.resolve(result);
}

// Failed or ran out: the card stays, says why, and offers a new code or
// another way to pay. Nothing was recorded.
function qrOver(session, text) {
    stopQrTimers(session);
    session.over = true;
    document.querySelector('#qr-modal .qr-box').classList.add('is-over');
    document.getElementById('qr-clock').hidden = true;
    const linkRow = document.getElementById('qr-link-row');
    if (linkRow) linkRow.hidden = true;
    setQrStatus(text + ' Nothing was recorded.', 'is-stop');
    setQrButtons('over');
}

// paid: said on the card, which closes, and the sale or the payment goes on
function qrPaid(session, state) {
    stopQrTimers(session);
    session.over = true;
    setQrButtons('busy');
    setQrStatus('Payment received', 'is-good');
    // long enough to read before the card closes
    setTimeout(function () {
        endQr(session, {
            id: session.id, reference: state.reference, amount: session.amount, wallet: session.method,
            bank: session.bank
        });
    }, 700);
}

// One question to the server, acted on: paid, failed, ran out, or still
// waiting. A question already on its way is shared rather than sent twice.
// Gives back the status, or 'offline'.
function checkQr(session) {
    if (!session.id || session.done) return Promise.resolve('done');
    if (session.inflight) return session.inflight;

    session.inflight = apiGetQrPayment(session.id)
        .then(function (state) {
            if (session.done || session.over) return state.status;

            if (state.status === 'paid') {
                qrPaid(session, state);
            } else if (state.status === 'failed') {
                qrOver(session, 'The payment failed' + (state.errorMessage ? ': ' + state.errorMessage : '.'));
            } else if (state.status === 'expired') {
                qrOver(session, 'The QR code expired before it was paid.');
            } else if (state.status === 'cancelled') {
                endQr(session, null);
            } else {
                // the server's clock decides; the countdown follows it
                session.endsAt = Date.now() + (Number(state.secondsLeft) || 0) * 1000;
                if (!session.closing) {
                    if (state.checkError) {
                        setQrStatus('The payment provider cannot be reached just now. Still trying...', 'is-stop');
                    } else {
                        setQrStatus('Waiting for the customer to pay...', '');
                    }
                }
            }
            return state.status;
        })
        .catch(function () {
            if (!session.done && !session.closing && !session.over) {
                setQrStatus('The server cannot be reached just now. Still trying...', 'is-stop');
            }
            return 'offline';
        })
        .finally(function () { session.inflight = null; });
    return session.inflight;
}

// The countdown is only the screen's: the server decides when the code has
// run out, so at zero it is asked at once.
function tickQr() {
    const session = qrSession;
    if (!session || session.closing || session.over) return;

    const left = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
    const clock = document.getElementById('qr-countdown');
    if (clock) {
        clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
        clock.parentElement.classList.toggle('is-ending', left <= 60);
    }
    if (left === 0) checkQr(session);
}

// Cancel asks the server to close the code, which looks once more first: a
// payment that already went through is recorded rather than abandoned.
async function cancelQrPayment(reason) {
    const session = qrSession;
    if (!session || session.closing || session.done) return;
    session.closing = true;
    stopQrTimers(session);
    setQrButtons('busy');
    setQrStatus('Making sure nothing was paid...', '');

    if (!session.id) { endQr(session, null); return; }
    if (session.inflight) await session.inflight;
    if (session.done) return;

    let ended = null;
    try {
        const response = await apiCancelQrPayment(session.id);
        ended = await response.json();
        if (!response.ok) {
            handleAuthFailure(response, ended);
            ended = null;
        }
    } catch (error) {
        ended = null;
    }

    if (ended && ended.status === 'paid') {
        notifyInfo('The customer had already paid, so the payment is being recorded.', 'Already paid');
        session.closing = false;
        qrPaid(session, ended);
        return;
    }
    if (!ended) {
        // the server did not answer; the code is left to run out on its own
        notifyWarning('The server could not be reached to cancel the QR code. It closes by itself when ' +
            'its time runs out; ask the customer whether it went through before taking the money another way.', 'Not cancelled');
    } else {
        notifyInfo(reason || 'The QR payment was cancelled, so nothing was recorded.', 'QR payment cancelled');
    }
    endQr(session, null);
}

// after a failed or expired code
function newQrCode() {
    const session = qrSession;
    if (!session || !session.over) return;
    startQrCode(session);
}

function chooseAnotherMethod() {
    const session = qrSession;
    if (!session) return;
    endQr(session, null);
    notifyInfo('Pick another payment method, or press Pay by QR to try again.', 'Nothing was recorded');
}

// The code is for one amount. If what is owed changes while it is on screen
// (the order or the payment typed), it is cancelled rather than paid wrong.
function qrAmountChanged(purpose, amountNow) {
    const session = qrSession;
    if (!session || session.purpose !== purpose || session.done || session.over || session.closing) return;
    if (Math.abs(Math.round(amountNow * 100) / 100 - session.amount) < 0.005) return;
    cancelQrPayment('The amount changed while the QR code was open, so the code was cancelled. ' +
        'Press Pay by QR again for the new amount.');
}

// Leaving the page with a code on screen: the browser asks first, and if the
// cashier goes anyway the checking stops with the page.
window.addEventListener('beforeunload', function (event) {
    if (!qrSession) return;
    event.preventDefault();
    event.returnValue = '';
});
window.addEventListener('pagehide', function () {
    if (qrSession) stopQrTimers(qrSession);
});

// After the customer has paid, a refusal from the server leaves the money in
// and nothing recorded. Unless the refusal was about the payment itself, it is
// kept for the next try and the cashier is told so.
function keepUnusedQr(qr, result) {
    const code = result && result.code;
    if (code === 'QR_USED' || code === 'QR_AMOUNT' || code === 'QR_NOT_PAID' ||
        code === 'QR_UNKNOWN' || code === 'QR_WALLET') return '';
    qrPaidUnused = qr;
    return ' The customer\'s QR payment of ' + peso(qr.amount) + ' (' + qr.reference + ') is kept: ' +
        'put things right and press Pay by QR again, and it is used without a new code. ' +
        'Until then the manager\'s QR Payments list shows it as needing a refund.';
}

