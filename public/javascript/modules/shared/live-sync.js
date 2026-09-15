// live-sync.js -- one open server connection per browser; a change event names a
// scope ("inventory moved"), and any panel reading that scope re-reads through
// its normal route. Tables are never redrawn while somebody is reading them.
// Loaded by: all five dashboards

// regenerated on every load: two tabs on one machine are two screens
const CLIENT_ID = (function () {
    try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (error) { /* fall through */ }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
})();

// Which panels refresh on which scope. A panel can override with its own
// scopes option. The audit trail is absent on purpose: it only ever grows.
const PANEL_SCOPES = {
    // system administrator
    'admin-users':        ['staff'],
    'admin-archive':      ['staff'],
    'admin-backups':      ['system'],
    'admin-access':       ['access', 'staff', 'systems'],

    // manager
    'mgr-sales':          ['sales', 'deliveries'],
    'mgr-reorder':        ['inventory', 'sales', 'returns'],
    'mgr-stocks':         ['inventory', 'sales', 'returns'],
    'mgr-deliveries':     ['deliveries', 'sales'],
    'mgr-credit':         ['credit', 'sales'],
    'mgr-requests':       ['credit'],
    'mgr-archives':       ['archives', 'staff', 'inventory', 'sales', 'deliveries'],
    'mgr-records':        ['inventory', 'credit'],
    'mgr-po':             ['inventory'],
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

        if (Array.isArray(data.scopes) && data.scopes.length > 0) {
            data.scopes.forEach((scope) => noticeChange(scope, null));
        }
    });

    liveSource.addEventListener('change', function (event) {
        const data = readLiveEvent(event);
        if (!data) return;

        liveVersion = Math.max(liveVersion, data.version || 0);

        // our own writes have already been handled by the screen that made them
        if (data.origin && data.origin === CLIENT_ID) return;

        noticeChange(data.scope, data);
    });

    // server lost track of how far behind this browser is (long disconnection)
    liveSource.addEventListener('resync', function () {
        notifyWarning('This screen was disconnected long enough to fall behind. ' +
            'Reload the page to be sure of what you are looking at.',
            'Out of step with the server');
        setLiveIndicator('stale', 'Behind');
    });

    // One person holds one session; signed in elsewhere means this one ends.
    // Close by hand first or EventSource keeps reconnecting and being refused.
    liveSource.addEventListener('evicted', function (event) {
        const data = readLiveEvent(event) || {};

        try { liveSource.close(); } catch (error) { /* already closed */ }
        liveSource = null;
        liveConnected = false;

        localStorage.removeItem('currentUser');

        rememberSignOutReason(data.reason || 'This screen was signed out.');
        window.location.replace('Login.html');
    });

    liveSource.addEventListener('error', function () {
        liveConnected = false;
        setLiveIndicator('down', 'Offline');
    });
}

function readLiveEvent(event) {
    try {
        return JSON.parse(event.data);
    } catch (error) {
        return null;
    }
}

// Widgets that are not tables (KPI tiles) subscribe to scopes here.
const liveListeners = [];

function onLiveChange(scopes, handler) {
    if (typeof handler !== 'function') return;
    liveListeners.push({ scopes: [].concat(scopes || []), handler: handler });
}

function runLiveListeners(scope) {
    liveListeners.forEach((entry) => {
        if (entry.scopes.indexOf(scope) === -1) return;
        try { entry.handler(scope); } catch (error) { console.error(error); }
    });
}

function noticeChange(scope, change) {
    if (!scope) return;

    runLiveListeners(scope);

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

    if (touched > 0 && typeof loadNotifications === 'function' &&
        (scope === 'inventory' || scope === 'returns' || scope === 'deliveries')) {
        loadNotifications();
    }
}

// Rows moving under a pointer lose the row about to be clicked.
function safeToRefresh(panel) {
    if (document.querySelector('.modal.open, .drawer.open')) return false;

    const active = document.activeElement;
    if (active && active !== document.body) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            const card = active.closest('.card, [data-panel]');
            const table = document.getElementById(panel.config.tableId);
            if (card && table && card.contains(table)) return false;
        }
    }

    if (panel.page !== 1) return false;

    return true;
}

async function refreshQuietly(panel) {
    await panel.refresh();
    flashPanel(panel, 'Updated just now');
}

// A quiet mark beside the count, not a popup card.
function flashPanel(panel, text) {
    if (!panel.config.countPillId) return;

    const pill = document.getElementById(panel.config.countPillId);
    if (!pill) return;

    pill.classList.add('is-fresh');
    pill.title = text;
    setTimeout(() => pill.classList.remove('is-fresh'), 2200);
}

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

// The connection indicator dot was removed; the state is still tracked (it
// drives the stale footer and the reload card) and these stay as no-ops.
function buildLiveIndicator() {}

let liveState = 'connecting';

function setLiveIndicator(state, word) {
    liveState = state;
}
