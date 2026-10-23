const QR_METHODS = ['GCash', 'PayMaya', 'Bank Transfer'];
const QR_CHECK_MS = 3000;

let qrSession = null;

let qrPaidUnused = null;

const QR_APP_WORDS = { 'GCash': 'GCash', 'PayMaya': 'Maya', 'Bank Transfer': 'Bank Transfer' };

if (typeof onLiveChange === 'function') {
    onLiveChange(['qr-payments'], function () { if (qrSession && !qrSession.over) checkQr(qrSession); });
}

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
    '            <button type="button" class="btn btn-ghost" id="qr-cancel-btn" onclick="askCancelQrPayment()">Cancel</button>\n' +
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

async function collectQrPayment(amount, what, method, purpose, saleId, bank) {
    amount = Math.round(amount * 100) / 100;

    if (qrPaidUnused) {
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

function endQr(session, result) {
    if (session.done) return;
    closeQrQuestion();
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

function qrOver(session, text) {
    closeQrQuestion();
    stopQrTimers(session);
    session.over = true;
    document.querySelector('#qr-modal .qr-box').classList.add('is-over');
    document.getElementById('qr-clock').hidden = true;
    const linkRow = document.getElementById('qr-link-row');
    if (linkRow) linkRow.hidden = true;
    setQrStatus(text + ' Nothing was recorded.', 'is-stop');
    setQrButtons('over');
}

function qrPaid(session, state) {
    stopQrTimers(session);
    session.over = true;
    setQrButtons('busy');
    setQrStatus('Payment received', 'is-good');
    setTimeout(function () {
        endQr(session, {
            id: session.id, reference: state.reference, amount: session.amount, wallet: session.method,
            bank: session.bank
        });
    }, 700);
}

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

let qrAsking = false;

function closeQrQuestion() {
    if (!qrAsking) return;
    qrAsking = false;
    closeAsk(false);
}

async function askCancelQrPayment() {
    const session = qrSession;
    if (!session || session.over || session.closing || session.done) return;

    qrAsking = true;
    const yes = await askConfirm('The customer has not paid yet. Cancel this QR code?', {
        title: 'Cancel this QR payment?',
        eyebrow: 'QR payment',
        mark: '!',
        tone: 'danger',
        confirmLabel: 'Cancel the QR',
        cancelLabel: 'Keep waiting'
    });
    qrAsking = false;

    if (!yes) return;
    if (qrSession !== session || session.over || session.closing || session.done) return;
    cancelQrPayment();
}

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
        notifyWarning('The server could not be reached to cancel the QR code. It closes by itself when ' +
            'its time runs out; ask the customer whether it went through before taking the money another way.', 'Not cancelled');
    } else {
        notifyInfo(reason || 'The QR payment was cancelled, so nothing was recorded.', 'QR payment cancelled');
    }
    endQr(session, null);
}

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

function qrAmountChanged(purpose, amountNow) {
    const session = qrSession;
    if (!session || session.purpose !== purpose || session.done || session.over || session.closing) return;
    if (Math.abs(Math.round(amountNow * 100) / 100 - session.amount) < 0.005) return;
    cancelQrPayment('The amount changed while the QR code was open, so the code was cancelled. ' +
        'Press Pay by QR again for the new amount.');
}

window.addEventListener('beforeunload', function (event) {
    if (!localStorage.getItem('currentUser')) return;
    if (!qrSession) return;
    event.preventDefault();
    event.returnValue = '';
});
window.addEventListener('pagehide', function () {
    if (qrSession) stopQrTimers(qrSession);
});

function keepUnusedQr(qr, result) {
    const code = result && result.code;
    if (code === 'QR_USED' || code === 'QR_AMOUNT' || code === 'QR_NOT_PAID' ||
        code === 'QR_UNKNOWN' || code === 'QR_WALLET') return '';
    qrPaidUnused = qr;
    return ' The customer\'s QR payment of ' + peso(qr.amount) + ' (' + qr.reference + ') is kept: ' +
        'put things right and press Pay by QR again, and it is used without a new code. ' +
        'Until then the manager\'s QR Payments list shows it as needing a refund.';
}

