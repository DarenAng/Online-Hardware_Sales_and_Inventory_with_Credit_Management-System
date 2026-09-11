// ui-kit.js  --  UI KIT
// Loaded by: every page
// ------------------------------------------------------------------------
// ==========================================
// UI KIT
//
// Everything the system says to the person using it comes through here.
// Browser alert, confirm and prompt boxes were doing that job before: they
// freeze the page, they cannot be styled, and they look like the browser
// rather than like this system. They are replaced by cards.
//
// Bootstrap supplies the toast component and the base layer; the look is this
// project's own. If Bootstrap has not loaded for any reason the cards still
// appear and still close themselves, so a message is never lost.
// ==========================================

const TOAST_LOOK = {
    success: { mark: '✓', title: 'Done' },
    danger:  { mark: '!', title: 'That did not work' },
    warning: { mark: '▲', title: 'Check this' },
    info:    { mark: '●', title: 'Notice' }
};

// ==========================================
// HOW LONG A CARD STAYS
//
// This was one line of arithmetic buried inside showCard, and it is the
// difference between a message being read and a message being seen leaving.
// A card saying "Invalid password" has to survive the moment somebody spends
// looking back at the field they just typed into, which is most of a second
// before they look up at all.
//
// So a card reporting a problem stays long enough to be read twice, and a
// card only confirming that something worked leaves sooner, because nobody
// reads "Saved" carefully.
//
// Most cards here run to about seven seconds: past that a card stops reading
// as a message and starts reading as something stuck on the screen. A card
// that must not leave on its own is passed stay: true instead.
//
// THE SIGN-IN SCREEN IS THE EXCEPTION
//
// Seven seconds is the right length for a message somebody is expecting,
// beside a screen they already understand. It is the wrong length for the
// one message in the system that arrives while the reader is looking
// somewhere else entirely.
//
// Somebody who has just mistyped a password is looking at the keyboard, or
// at a note with the password on it, or at nothing at all. By the time they
// look up, the card explaining what went wrong has often already gone, and
// what they are left with is a form that simply did not do anything. So the
// sign-in screen passes its own longer life, set below, and the card stays
// up long enough to still be there when the reader gets back to the screen.
// ==========================================
const TOAST_LIFE = {
    danger:  7000,   // something failed, and the reason has to be read
    warning: 5500,   // something needs attention before it fails
    info:    5000,   // a notice, worth a moment
    success: 4000    // it worked, and the screen already shows that it did
};

// long enough to read twice and still be there on the way back from the
// keyboard; short enough that an unattended till clears itself
const SIGN_IN_MESSAGE_LIFE = 15000;

// The furniture every page needs is built here rather than repeated in five
// HTML files, so every module gets exactly the same cards and dialogs.
function ensureUiFurniture() {
    if (!document.body || document.getElementById('toast-deck')) return;

    const deck = document.createElement('div');
    deck.className = 'toast-deck';
    deck.id = 'toast-deck';
    deck.setAttribute('aria-live', 'polite');
    deck.setAttribute('aria-atomic', 'true');
    document.body.appendChild(deck);

    const ask = document.createElement('div');
    ask.className = 'modal';
    ask.id = 'ask-modal';
    ask.innerHTML = `
        <div class="modal-box ask-box">
            <div class="modal-head">
                <div class="modal-identity">
                    <div class="avatar" id="ask-mark">?</div>
                    <div>
                        <h3 id="ask-title">Please confirm</h3>
                        <span class="modal-role" id="ask-eyebrow">Confirmation</span>
                    </div>
                </div>
                <button type="button" class="modal-close" onclick="closeAsk(false)" aria-label="Close">&times;</button>
            </div>
            <div class="modal-body">
                <p class="ask-text" id="ask-text"></p>
                <ul class="ask-detail" id="ask-detail" style="display: none;"></ul>
                <div class="form-group ask-field" id="ask-field" style="display: none;">
                    <label id="ask-label" for="ask-input">Value</label>
                    <input type="text" id="ask-input" class="form-control" autocomplete="off">
                    <p class="ask-error" id="ask-error"></p>
                </div>
            </div>
            <div class="modal-foot">
                <button type="button" class="btn btn-ghost" onclick="closeAsk(false)" id="ask-cancel">Cancel</button>
                <button type="button" class="btn btn-accent" onclick="submitAsk()" id="ask-ok">Confirm</button>
            </div>
        </div>`;
    document.body.appendChild(ask);

    ask.addEventListener('click', function (event) {
        if (event.target === ask) closeAsk(false);
    });

    document.getElementById('ask-input').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitAsk();
        }
    });

    buildAccountModal();
}

// ---------- popup notification cards ----------
function showCard(options) {
    ensureUiFurniture();

    const deck = document.getElementById('toast-deck');
    if (!deck) return null;

    const tone = TOAST_LOOK[options.tone] ? options.tone : 'info';
    const look = TOAST_LOOK[tone];

    // An alert that names who raised it and when reads very differently from
    // one that just appears. The same two facts show behind the bell.
    const meta = [];
    if (options.from) meta.push('From ' + options.from);
    if (options.when) meta.push(whenText(options.when));

    const card = document.createElement('div');
    card.className = `toast toast-card toast-${tone}` + (options.onOpen ? ' is-clickable' : '');
    card.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    card.innerHTML =
        '<span class="toast-stripe"></span>' +
        '<span class="toast-mark">' + look.mark + '</span>' +
        '<div class="toast-body"><span class="toast-title">' + escapeHtml(options.title || look.title) + '</span>' +
        (options.message ? '<p class="toast-text">' + escapeHtml(options.message) + '</p>' : '') +
        (meta.length
            ? '<span class="toast-meta">' +
              meta.map((line) => '<span>' + escapeHtml(line) + '</span>').join('') +
              '</span>'
            : '') +
        '</div>' +
        '<button type="button" class="toast-close" aria-label="Dismiss">&times;</button>';

    deck.appendChild(card);

    // a card passed stay: true waits for a person; the rest leave on the
    // clock their tone sets
    const life = options.stay ? 0 : (options.life || TOAST_LIFE[tone] || TOAST_LIFE.info);

    const remove = () => {
        if (!card.isConnected) return;
        card.classList.add('is-leaving');
        setTimeout(() => card.remove(), 200);
    };

    card.querySelector('.toast-close').addEventListener('click', (event) => {
        event.stopPropagation();
        remove();
    });

    if (options.onOpen) {
        card.addEventListener('click', () => {
            options.onOpen();
            remove();
        });
        card.title = 'Open the alert list';
    }

    if (window.bootstrap && window.bootstrap.Toast) {
        const toast = new window.bootstrap.Toast(card, {
            autohide: life > 0,
            delay: life || 5000
        });
        card.addEventListener('hidden.bs.toast', () => card.remove());
        toast.show();
    } else {
        card.classList.add('show');
        if (life > 0) setTimeout(remove, life);
    }

    // never let the corner fill up with cards nobody has read
    const cards = deck.querySelectorAll('.toast-card');
    if (cards.length > 3) cards[0].remove();

    return card;
}

// takes every popup card off the screen at once
function clearCards() {
    const deck = document.getElementById('toast-deck');
    if (!deck) return;
    deck.querySelectorAll('.toast-card').forEach((card) => card.remove());
}

// The fourth argument is for the few callers that know something showCard
// cannot: how long their own reader will be looking away. Everything else
// leaves it out and takes the life its tone sets.
function notifySuccess(message, title, options) { return showCard({ tone: 'success', title: title, message: message, ...options }); }
function notifyError(message, title, options)   { return showCard({ tone: 'danger',  title: title, message: message, ...options }); }
function notifyWarning(message, title, options) { return showCard({ tone: 'warning', title: title, message: message, ...options }); }
function notifyInfo(message, title, options)    { return showCard({ tone: 'info',    title: title, message: message, ...options }); }

// the one line every screen uses when the server cannot be reached
function notifyOffline() {
    notifyError('The server did not answer. Check that it is still running, then try again.',
        'Cannot reach the server');
}

// ---------- confirm and prompt, as cards ----------
let askResolve = null;
let askOptions = {};

function openAsk(options) {
    ensureUiFurniture();
    askOptions = options;

    document.getElementById('ask-title').textContent = options.title || 'Please confirm';
    document.getElementById('ask-eyebrow').textContent = options.eyebrow || 'Confirmation';
    document.getElementById('ask-mark').textContent = options.mark || '?';
    document.getElementById('ask-text').innerHTML = escapeHtml(options.message || '');
    document.getElementById('ask-cancel').textContent = options.cancelLabel || 'Cancel';

    const okButton = document.getElementById('ask-ok');
    okButton.textContent = options.confirmLabel || 'Confirm';
    okButton.className = 'btn ' + (options.tone === 'danger' ? 'btn-danger' : 'btn-accent');

    // Exactly what is about to happen, one consequence per line. Prose runs
    // together and gets skimmed; a list of three short lines gets counted.
    const detail = document.getElementById('ask-detail');
    if (Array.isArray(options.detail) && options.detail.length > 0) {
        detail.innerHTML = options.detail
            .map((line) => '<li>' + escapeHtml(line) + '</li>').join('');
        detail.style.display = 'block';
    } else {
        detail.innerHTML = '';
        detail.style.display = 'none';
    }

    const field = document.getElementById('ask-field');
    const input = document.getElementById('ask-input');
    const error = document.getElementById('ask-error');
    error.classList.remove('show');

    if (options.ask) {
        field.style.display = 'block';
        document.getElementById('ask-label').textContent = options.label || 'Value';
        input.type = options.type || 'text';
        input.value = options.value || '';
        input.placeholder = options.placeholder || '';
    } else {
        field.style.display = 'none';
        input.value = '';
    }

    showModal('ask-modal');
    if (options.ask) setTimeout(() => input.focus(), 60);

    return new Promise((resolve) => { askResolve = resolve; });
}

function closeAsk(answer) {
    closeModal('ask-modal');
    const resolve = askResolve;
    askResolve = null;
    if (resolve) resolve(answer);
}

function submitAsk() {
    if (!askOptions.ask) {
        closeAsk(true);
        return;
    }

    const input = document.getElementById('ask-input');
    const error = document.getElementById('ask-error');
    const value = input.value;

    // the question stays open until the answer is usable, rather than
    // closing and then complaining
    const complaint = askOptions.check ? askOptions.check(value) : null;
    if (complaint) {
        error.textContent = complaint;
        error.classList.add('show');
        input.focus();
        return;
    }

    closeAsk(value);
}

// confirm(), as a card. Resolves true or false, and never blocks the page.
function askConfirm(message, options) {
    const settings = options || {};
    return openAsk({
        title: settings.title || 'Please confirm',
        eyebrow: settings.eyebrow || 'Confirmation',
        mark: settings.mark || '?',
        message: message,
        detail: settings.detail,
        confirmLabel: settings.confirmLabel || 'Yes, continue',
        cancelLabel: settings.cancelLabel || 'Cancel',
        tone: settings.tone
    });
}

// The same card, for the actions that cannot be taken back: voiding a sale,
// restoring over a live database, deleting an account, approving credit.
//
// It exists as its own function so the tone, the mark and the wording of the
// cancel button are decided once. A dialog that asks "are you sure?" in the
// same voice for a saved filter and for a wiped database has taught everybody
// to press Confirm without reading it, so the dangerous one looks different
// and its confirm button says what it is about to do rather than "Yes".
function askDanger(message, options) {
    const settings = options || {};

    return openAsk({
        title: settings.title || 'This cannot be undone',
        eyebrow: settings.eyebrow || 'Confirm',
        mark: settings.mark || '!',
        message: message,
        detail: settings.detail,
        confirmLabel: settings.confirmLabel || 'Yes, do it',
        cancelLabel: settings.cancelLabel || 'No, go back',
        tone: 'danger'
    });
}

// prompt(), as a card. Resolves the typed value, or null when it is cancelled.
function askInput(options) {
    return openAsk(Object.assign({ ask: true, mark: '✎', eyebrow: 'Input needed' }, options));
}
