function makeClientId() {
    try {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (error) {
    }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
const CLIENT_ID = makeClientId();

const PANEL_SCOPES = {
    'admin-users':        ['staff'],
    'admin-archive':      ['staff'],
    'admin-backups':      ['system'],

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
    'mgr-stock-moves':    ['inventory', 'returns'],
    'mgr-loyal':          ['sales', 'credit'],
    'mgr-income-methods':  ['sales', 'credit'],
    'mgr-income-products': ['sales'],
    'mgr-staff':          ['staff'],

    'clerk-materials':    ['inventory', 'sales', 'returns'],
    'clerk-reorder':      ['inventory', 'sales', 'returns'],
    'clerk-adjustments':  ['inventory'],
    'clerk-po':           ['inventory'],
    'clerk-returns':      ['returns'],
    'clerk-archive':      ['inventory'],

    'cash-credit':        ['credit', 'sales'],
    'cash-deliveries':    ['deliveries', 'sales'],
    'cash-sales':         ['sales', 'deliveries'],
    'cash-recent-sales':  ['sales', 'returns'],
    'cash-summary':       ['sales', 'returns'],

    'driver-pending':     ['deliveries', 'sales'],
    'driver-report':      ['deliveries', 'sales'],
    'driver-report-pay':  ['sales', 'deliveries']
};

let liveSource = null;
let liveVersion = 0;
let liveConnected = false;

function startLiveSync() {
    if (liveSource) return;

    buildLiveIndicator();
    openLiveStream();

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !liveConnected) openLiveStream();
    });
}

function openLiveStream() {
    if (liveSource) {
        try { liveSource.close(); } catch (error) {  }
    }

    liveSource = apiOpenLiveUpdates();

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
            for (let i = 0; i < data.scopes.length; i++) {
                noticeChange(data.scopes[i], null);
            }
        }
    });

    liveSource.addEventListener('change', function (event) {
        const data = readLiveEvent(event);
        if (!data) return;

        liveVersion = Math.max(liveVersion, data.version || 0);

        if (data.origin && data.origin === CLIENT_ID) return;

        noticeChange(data.scope, data);
    });

    liveSource.addEventListener('resync', function () {
        notifyWarning('This screen was disconnected long enough to fall behind. ' +
            'Reload the page to be sure of what you are looking at.',
            'Out of step with the server');
        setLiveIndicator('stale', 'Behind');
    });

    liveSource.addEventListener('evicted', function (event) {
        const data = readLiveEvent(event) || {};

        try { liveSource.close(); } catch (error) {  }
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

const liveListeners = [];

function onLiveChange(scopes, handler) {
    if (typeof handler !== 'function') return;
    let list = [];
    if (Array.isArray(scopes)) {
        list = scopes;
    } else if (scopes) {
        list = [scopes];
    }
    liveListeners.push({ scopes: list, handler: handler });
}

function runLiveListeners(scope) {
    for (let i = 0; i < liveListeners.length; i++) {
        const entry = liveListeners[i];
        if (entry.scopes.indexOf(scope) === -1) continue;
        try {
            entry.handler(scope);
        } catch (error) {
            console.error(error);
        }
    }
}

function noticeChange(scope, change) {
    if (!scope) return;

    runLiveListeners(scope);

    if (scope === 'notifications') {
        if (typeof loadNotifications === 'function') loadNotifications();
        return;
    }

    let touched = 0;

    for (const key in dataPanels) {
        const panel = dataPanels[key];

        const scopes = panel.config.scopes || PANEL_SCOPES[panel.key] || [];
        if (scopes.indexOf(scope) === -1) continue;

        if (panel.state === 'loading') {
            panel.reloadWanted = true;
            continue;
        }
        if (panel.state !== 'ready') continue;

        touched += 1;

        if (safeToRefresh(panel)) refreshQuietly(panel);
        else markPanelStale(panel, scope);
    }

    if (touched > 0 && typeof loadNotifications === 'function' &&
        (scope === 'inventory' || scope === 'returns' || scope === 'deliveries')) {
        loadNotifications();
    }
}

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

function flashPanel(panel, text) {
    if (!panel.config.countPillId) return;

    const pill = document.getElementById(panel.config.countPillId);
    if (!pill) return;

    pill.classList.add('is-fresh');
    pill.title = text;
    setTimeout(function () {
        pill.classList.remove('is-fresh');
    }, 2200);
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
    watchStalePanels();
}

let staleWatch = null;

function watchStalePanels() {
    if (staleWatch) return;
    staleWatch = setInterval(function () {
        let waiting = 0;
        for (const key in dataPanels) {
            const panel = dataPanels[key];
            const mount = panel.pager ? panel.pager() : null;
            if (!mount || !mount.querySelector('.stale-note')) continue;
            if (panel.state !== 'ready') continue;
            waiting += 1;
            if (safeToRefresh(panel)) refreshQuietly(panel);
        }
        if (waiting === 0) { clearInterval(staleWatch); staleWatch = null; }
    }, 1000);
}

async function refreshStalePanel(key) {
    const panel = getDataPanel(key);
    if (!panel) return;

    await panel.refresh();
    flashPanel(panel, 'Updated just now');
}

function buildLiveIndicator() {}

let liveState = 'connecting';

function setLiveIndicator(state, word) {
    liveState = state;
}
