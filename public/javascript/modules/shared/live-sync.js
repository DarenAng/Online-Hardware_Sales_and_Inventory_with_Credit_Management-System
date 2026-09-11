// live-sync.js  --  LIVE SYNC ACROSS DESKTOPS
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// WHY THIS FILE EXISTS
//
// The shop runs on more than one machine. A clerk adjusts stock on the
// stockroom PC and the cashier at the till is still looking at the figure
// from before the adjustment, which is how two people sell the same last bag
// of cement. Until now the only fix was restoring the database by hand, which
// is not a fix.
//
// So every signed-in browser holds one open connection to the server and is
// told when something moves. What arrives is deliberately not the data: a
// change says "inventory moved, version 412" and nothing else. This file
// works out whether anything on the screen is affected and re-reads it
// through the normal routes, with the normal access checks.
//
// WHAT IT WILL NOT DO
//
// It will not redraw a table somebody is reading. Rows moving under a
// pointer is worse than a figure being a few seconds old: it loses the row
// that was about to be clicked. So a panel is only refreshed silently when
// nothing is in the way — no popup open, nothing focused inside it, and the
// reader on the first page. Otherwise it says so and waits to be asked.
//
// It also ignores changes this browser caused. Every write carries a client
// id, and a change stamped with our own id has already been dealt with by
// whichever screen made it.
// ==========================================

// This browser, for this page. Regenerated on every load on purpose: two tabs
// on one machine are two screens and should hear about each other.
const CLIENT_ID = (function () {
    try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (error) { /* fall through */ }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
})();

// ==========================================
// WHICH PANELS CARE ABOUT WHAT
//
// Kept in one table rather than scattered across five modules, so the whole
// answer to "what refreshes when a sale is rung up" is readable in one place.
// A panel can still override it with a scopes option of its own.
//
// The audit trail is deliberately absent. It is history that only ever grows:
// a new entry appearing at the top while somebody reads the third page is
// noise, and nothing in it goes stale in a way that matters.
//
// The adjustment log used to be listed here for the same reason, and that was
// wrong. It is not only history: it is the screen a clerk checks straight
// after filing something, so it is refreshed on an inventory change, and
// safeToRefresh below still keeps it still while anybody is reading.
// ==========================================
const PANEL_SCOPES = {
    // system administrator
    'admin-users':        ['staff'],
    'admin-archive':      ['staff'],
    'admin-backups':      ['system'],

    // manager
    'mgr-sales':          ['sales', 'deliveries'],
    'mgr-reorder':        ['inventory', 'sales', 'returns'],
    'mgr-stocks':         ['inventory', 'sales', 'returns'],
    'mgr-deliveries':     ['deliveries', 'sales'],
    'mgr-credit':         ['credit', 'sales'],
    'mgr-requests':       ['credit'],
    'mgr-archives':       ['archives', 'staff', 'inventory', 'sales', 'deliveries'],
    'mgr-records':        ['inventory', 'credit'],
    'mgr-unpaid':         ['sales', 'credit'],
    'mgr-methods':        ['sales'],
    'mgr-loyal':          ['sales', 'credit'],

    // inventory clerk
    'clerk-materials':    ['inventory', 'sales', 'returns'],
    'clerk-reorder':      ['inventory', 'sales', 'returns'],
    'clerk-adjustments':  ['inventory'],
    'clerk-po':           ['inventory'],
    'clerk-returns':      ['returns'],
    'clerk-archive':      ['inventory'],

    // cashier
    'cash-credit':        ['credit', 'sales'],
    'cash-deliveries':    ['deliveries', 'sales'],
    'cash-sales':         ['sales', 'deliveries'],
    'cash-refunds':       ['returns'],
    'cash-summary':       ['sales', 'returns'],

    // delivery personnel
    'driver-pending':     ['deliveries'],
    'driver-active':      ['deliveries'],
    'driver-cod':         ['deliveries', 'sales']
};

let liveSource = null;
let liveVersion = 0;
let liveConnected = false;

// ==========================================
// THE CONNECTION
// ==========================================
function startLiveSync() {
    if (liveSource || typeof window.EventSource !== 'function') return;

    buildLiveIndicator();
    openLiveStream();

    // A tab that has been in the background for a long time may have been
    // disconnected without noticing. Coming back is a good moment to check.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !liveConnected) openLiveStream();
    });
}

function openLiveStream() {
    if (liveSource) {
        try { liveSource.close(); } catch (error) { /* already closed */ }
    }

    liveSource = new EventSource('/api/events');

    liveSource.addEventListener('open', function () {
        liveConnected = true;
        setLiveIndicator('live', 'Live');
    });

    liveSource.addEventListener('hello', function (event) {
        const data = readLiveEvent(event);
        if (!data) return;

        liveVersion = data.version || 0;
        liveConnected = true;
        setLiveIndicator('live', 'Live');

        // anything that moved while this browser was away
        if (Array.isArray(data.scopes) && data.scopes.length > 0) {
            data.scopes.forEach((scope) => noticeChange(scope, null));
        }
    });

    liveSource.addEventListener('change', function (event) {
        const data = readLiveEvent(event);
        if (!data) return;

        liveVersion = Math.max(liveVersion, data.version || 0);

        // our own writes have already been dealt with by whichever screen
        // made them; hearing about them again would refresh twice
        if (data.origin && data.origin === CLIENT_ID) return;

        noticeChange(data.scope, data);
    });

    // The server lost track of how far behind this browser is, which happens
    // only after a long disconnection. Guessing would show a half-updated
    // screen, so it says so and offers the one thing that is certainly right.
    liveSource.addEventListener('resync', function () {
        notifyWarning('This screen was disconnected long enough to fall behind. ' +
            'Reload the page to be sure of what you are looking at.',
            'Out of step with the server');
        setLiveIndicator('stale', 'Behind');
    });

    liveSource.addEventListener('error', function () {
        liveConnected = false;
        setLiveIndicator('down', 'Offline');
        // EventSource reconnects on its own; the retry interval comes from
        // the server, so there is nothing to schedule here
    });
}

function readLiveEvent(event) {
    try {
        return JSON.parse(event.data);
    } catch (error) {
        return null;
    }
}

// ==========================================
// WHAT TO DO ABOUT A CHANGE
// ==========================================

// ==========================================
// SUBSCRIBERS THAT ARE NOT TABLES
//
// A data panel refreshes itself because live-sync knows its key. Dashboard KPI
// tiles are not a table and have no key, but they read the same rows -- and a
// "Live" badge sitting above figures that only ever load once is making a
// claim the page does not honour. This is how anything that is not a table
// asks to hear about the same scopes.
// ==========================================
const liveListeners = [];

function onLiveChange(scopes, handler) {
    if (typeof handler !== 'function') return;
    liveListeners.push({ scopes: [].concat(scopes || []), handler: handler });
}

function runLiveListeners(scope) {
    liveListeners.forEach((entry) => {
        if (entry.scopes.indexOf(scope) === -1) return;
        // one widget throwing must not stop the rest of the page updating
        try { entry.handler(scope); } catch (error) { console.error(error); }
    });
}

function noticeChange(scope, change) {
    if (!scope) return;

    runLiveListeners(scope);

    // the bell is cheap and nobody is reading it as a table
    if (scope === 'notifications') {
        if (typeof loadNotifications === 'function') loadNotifications();
        return;
    }

    let touched = 0;

    dataPanels.forEach((panel) => {
        if (panel.state !== 'ready') return;

        const scopes = panel.config.scopes || PANEL_SCOPES[panel.key] || [];
        if (scopes.indexOf(scope) === -1) return;

        touched += 1;

        if (safeToRefresh(panel)) refreshQuietly(panel);
        else markPanelStale(panel, scope);
    });

    // the bell should also catch up when the thing that changed was one of
    // the things it reports on
    if (touched > 0 && typeof loadNotifications === 'function' &&
        (scope === 'inventory' || scope === 'returns' || scope === 'deliveries')) {
        loadNotifications();
    }
}

// Rows moving under a pointer lose the row that was about to be clicked, so
// three things have to be true before a table redraws itself.
function safeToRefresh(panel) {
    // a popup over the page is a person mid-task
    if (document.querySelector('.modal.open, .drawer.open')) return false;

    // somebody typing into this panel's own search or filters
    const active = document.activeElement;
    if (active && active !== document.body) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            const card = active.closest('.card, [data-panel]');
            const table = document.getElementById(panel.config.tableId);
            if (card && table && card.contains(table)) return false;
        }
    }

    // Past page one, a refresh can renumber everything under a reader. On
    // page one the newest rows are what they are looking at anyway.
    if (panel.page !== 1) return false;

    return true;
}

async function refreshQuietly(panel) {
    await panel.refresh();
    flashPanel(panel, 'Updated just now');
}

// A quiet mark beside the count, not a popup card. A popup for every change
// on a busy afternoon is a screen nobody can work on.
function flashPanel(panel, text) {
    if (!panel.config.countPillId) return;

    const pill = document.getElementById(panel.config.countPillId);
    if (!pill) return;

    pill.classList.add('is-fresh');
    pill.title = text;
    setTimeout(() => pill.classList.remove('is-fresh'), 2200);
}

// The reader is busy, so the table says what happened and waits.
function markPanelStale(panel, scope) {
    const mount = panel.pager();
    if (!mount) return;

    if (mount.querySelector('.stale-note')) return;

    const note = document.createElement('div');
    note.className = 'stale-note';
    note.innerHTML =
        '<span class="stale-dot"></span>' +
        '<span>Somebody else changed the ' + escapeHtml(scope) + ' records.</span>' +
        '<button type="button" class="btn btn-sm btn-accent" ' +
                'onclick="refreshStalePanel(\'' + panel.key + '\')">Refresh</button>';

    mount.appendChild(note);
    mount.classList.remove('is-single');
}

async function refreshStalePanel(key) {
    const panel = getDataPanel(key);
    if (!panel) return;

    await panel.refresh();      // redrawing the pager takes the note with it
    flashPanel(panel, 'Updated just now');
}

// ==========================================
// THERE IS NO INDICATOR ANY MORE
//
// There was a dot in the top bar, beside the page title, and it reported the
// browser's connection to this server: green while changes were arriving,
// crimson while they were not, amber when the screen had fallen behind. It
// went in stages -- first it lost the word beside it, then the dot itself --
// and both stages were the same decision.
//
// It described the plumbing. A shop cannot act on "the change channel is
// reconnecting": there is no button for it, no procedure, and nothing the
// person at the counter is expected to do differently. What the shop can act
// on is what the screen in front of them says, and that is still handled --
// and handled better -- by the two things that survive:
//
//   - A table that has quietly gone out of date says so, in its own footer,
//     in words, and waits to be asked. That is a message about the rows
//     somebody is reading rather than about a socket.
//   - A screen that has fallen far enough behind to be untrustworthy is told
//     to reload, as a card. That one is worth interrupting for.
//
// So the state is still tracked, still drives both of those, and is no longer
// drawn. These two functions are kept as no-ops rather than deleted, because
// they are called from four places in the reconnection logic below and a
// silent indicator is a smaller change than four conditionals.
//
// To put it back: build the element here and write the state onto it. The
// state names have not changed -- live, down, stale.
// ==========================================
function buildLiveIndicator() { /* deliberately nothing; see above */ }

// Nothing is drawn, but the state is still recorded. A connection state that
// is not written down anywhere cannot be read by anything -- not by a check
// driving two browsers against each other, not by somebody typing liveState
// into a console to find out why a screen has gone quiet. The dot was the
// only place it was written down, so with the dot gone it is written here.
let liveState = 'connecting';

function setLiveIndicator(state, word) {
    liveState = state;
}
