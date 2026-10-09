// ui-kit.js -- cards, dialogs and prompts that replace alert/confirm/prompt
// Loaded by: every page
// Bootstrap supplies the toast base; if it has not loaded the cards still
// appear and close themselves.

const TOAST_LOOK = {
    success: { mark: '✓', title: 'Done' },
    danger:  { mark: '!', title: 'That did not work' },
    warning: { mark: '▲', title: 'Check this' },
    info:    { mark: '●', title: 'Notice' }
};

// How long a card stays, by tone: a problem stays long enough to be read
// twice, a confirmation leaves sooner. Past ~7s a card reads as stuck; a card
// that must not leave on its own is passed stay: true.
const TOAST_LIFE = {
    danger:  7000,   // something failed, and the reason has to be read
    warning: 5500,   // something needs attention before it fails
    info:    5000,   // a notice, worth a moment
    success: 4000    // it worked, and the screen already shows that it did
};

// the sign-in screen's reader is looking at the keyboard, so its card lasts longer
const SIGN_IN_MESSAGE_LIFE = 15000;

// shared furniture built once rather than repeated in five HTML files
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

    // the wait between a confirm and its result; no buttons, cannot be closed
    const work = document.createElement('div');
    work.className = 'modal';
    work.id = 'work-modal';
    work.setAttribute('data-modal-locked', '');
    work.innerHTML = `
        <div class="modal-box ask-box work-box" role="status" aria-live="assertive" aria-busy="true">
            <div class="modal-head">
                <div class="modal-identity">
                    <div class="avatar work-spinner" aria-hidden="true"></div>
                    <div>
                        <h3 id="work-title">One moment</h3>
                        <span class="modal-role" id="work-eyebrow">Working</span>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <p class="ask-text" id="work-text"></p>
                <ol class="work-steps" id="work-steps"></ol>
                <div class="work-bar" aria-hidden="true"><span></span></div>
            </div>
        </div>`;
    document.body.appendChild(work);

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

    const cards = deck.querySelectorAll('.toast-card');
    if (cards.length > 3) cards[0].remove();

    return card;
}

function clearCards() {
    const deck = document.getElementById('toast-deck');
    if (!deck) return;
    deck.querySelectorAll('.toast-card').forEach((card) => card.remove());
}

// the fourth argument overrides the life for callers whose reader is looking away
// Object.assign copies every field of "options" onto the card settings
function notifySuccess(message, title, options) {
    return showCard(Object.assign({ tone: 'success', title: title, message: message }, options));
}
function notifyError(message, title, options) {
    return showCard(Object.assign({ tone: 'danger', title: title, message: message }, options));
}
function notifyWarning(message, title, options) {
    return showCard(Object.assign({ tone: 'warning', title: title, message: message }, options));
}
function notifyInfo(message, title, options) {
    return showCard(Object.assign({ tone: 'info', title: title, message: message }, options));
}

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

    // One consequence per line. A line written "Label: value" is set as two
    // columns in the figure face (for checking an email, phone or password).
    const detail = document.getElementById('ask-detail');
    if (Array.isArray(options.detail) && options.detail.length > 0) {
        detail.innerHTML = options.detail.map((line) => {
            const text = String(line);
            const split = text.indexOf(': ');

            if (split > 0 && split <= 22) {
                return '<li class="ask-pair">' +
                    '<span class="ask-pair-label">' + escapeHtml(text.slice(0, split)) + '</span>' +
                    '<span class="ask-pair-value">' + escapeHtml(text.slice(split + 2)) + '</span>' +
                    '</li>';
            }
            return '<li>' + escapeHtml(text) + '</li>';
        }).join('');
        detail.style.display = 'block';
    } else {
        detail.innerHTML = '';
        detail.style.display = 'none';
    }

    // crimson only on a card that destroys something; grey otherwise
    detail.classList.toggle('is-plain', options.tone !== 'danger');

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

    const complaint = askOptions.check ? askOptions.check(value) : null;
    if (complaint) {
        error.textContent = complaint;
        error.classList.add('show');
        input.focus();
        return;
    }

    closeAsk(value);
}

// ---------- the wait between a confirm and its result ----------
// Shown while the server does something long enough to notice: creating an
// account and mailing its password can take twenty seconds, and a screen that
// shows nothing in that time reads as a click that did not take. The card has
// no buttons and does not close on Escape: nothing the reader could do here
// is safe to do twice.
//
// The server does the work in one request, so the card cannot know which
// part it is on; it walks its steps on a clock instead, one every STEP_MS,
// and holds the last until the answer comes. On success finishWorking ticks
// every step, turns the head green and leaves after a beat; on failure
// hideWorking leaves at once and the error card says why. The card is never
// up for less than WORK_MIN_MS, so a quick server does not make it flash.
const WORK_STEP_MS = 1100;
const WORK_MIN_MS = 900;
const WORK_DONE_MS = 700;

let workState = null;     // { openedAt, timer, steps }

function renderWorkSteps(current, done) {
    const list = document.getElementById('work-steps');
    const items = list.querySelectorAll('li');

    items.forEach((item, index) => {
        item.classList.toggle('is-done', done || index < current);
        item.classList.toggle('is-active', !done && index === current);
    });
}

function showWorking(options) {
    ensureUiFurniture();
    const settings = options || {};
    const steps = Array.isArray(settings.steps) ? settings.steps : [];

    if (workState && workState.timer) clearInterval(workState.timer);

    const box = document.querySelector('#work-modal .work-box');
    box.classList.remove('is-done');

    document.getElementById('work-title').textContent = settings.title || 'One moment';
    document.getElementById('work-eyebrow').textContent = settings.eyebrow || 'Working';
    document.getElementById('work-text').textContent = settings.message || '';

    const list = document.getElementById('work-steps');
    list.innerHTML = steps.map((step) =>
        '<li><span class="work-step-mark" aria-hidden="true"></span>' +
        '<span class="work-step-text">' + escapeHtml(step) + '</span></li>').join('');
    list.style.display = steps.length > 0 ? 'block' : 'none';

    workState = { openedAt: Date.now(), timer: null, steps: steps.length, current: 0 };
    renderWorkSteps(0, false);

    if (steps.length > 1) {
        workState.timer = setInterval(() => {
            if (!workState || workState.current >= workState.steps - 1) return;
            workState.current += 1;
            renderWorkSteps(workState.current, false);
        }, WORK_STEP_MS);
    }

    showModal('work-modal');
}

function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// the answer arrived and it was good: every step ticks, then the card leaves
async function finishWorking(title) {
    if (!workState) return;
    const state = workState;
    if (state.timer) clearInterval(state.timer);

    const shownFor = Date.now() - state.openedAt;
    if (shownFor < WORK_MIN_MS) await pause(WORK_MIN_MS - shownFor);

    renderWorkSteps(state.steps, true);
    document.querySelector('#work-modal .work-box').classList.add('is-done');
    document.getElementById('work-title').textContent = title || 'Done';

    await pause(WORK_DONE_MS);
    hideWorking();
}

// the answer was bad, or never came: the card leaves and the error card speaks
function hideWorking() {
    if (workState && workState.timer) clearInterval(workState.timer);
    workState = null;
    closeModal('work-modal');
}

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

// For actions that cannot be taken back: the tone, the mark and the wording of
// the buttons are decided here so the dangerous dialog looks different.
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

function askInput(options) {
    return openAsk(Object.assign({ ask: true, mark: '✎', eyebrow: 'Input needed' }, options));
}
