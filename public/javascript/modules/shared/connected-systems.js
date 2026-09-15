// connected-systems.js -- the connected systems screen
// Loaded by: all five dashboards
//
// Reaching a system is a per-person permission handed out by the System
// Administrator (Access Control), so the menu item is hidden in the markup
// and shown only once /api/me/access says the person holds a key. This file
// shows and hides, never grants. Every command asks first and is audited.
//
//   configureConnectedSystems({
//       showPanel: showManagerPanel,    // (panelId, title) -- the page's own
//       navId: 'nav-systems'            // the <li> in the menu to reveal
//   });
//   buildConnectedSystemsPanel();       // draws the panel into .content-area

const systemsSetup = {
    showPanel: null,
    navId: 'nav-systems',
    panelId: 'panel-systems',
    title: 'Connected Systems'
};

let connectedSystems = [];      // what /api/systems last answered
let systemsAccess = null;       // what /api/me/access last answered

function configureConnectedSystems(options) {
    Object.assign(systemsSetup, options || {});
}

// Drawn by script so the markup cannot drift five ways; the page supplies
// only the menu item.
function buildConnectedSystemsPanel() {
    const area = document.querySelector('.content-area');
    if (!area || document.getElementById(systemsSetup.panelId)) return;

    const panel = document.createElement('div');
    panel.id = systemsSetup.panelId;
    panel.setAttribute('data-panel', '');
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="card">
            <div class="panel-head">
                <div>
                    <span class="eyebrow">Beyond the shop</span>
                    <h3>Connected Systems</h3>
                    <p class="panel-sub" id="systems-intro">The systems around this one, as far as your
                        access reaches. Every command run from here is written to the audit trail.</p>
                </div>
                <div class="panel-actions">
                    <span class="pill" id="systems-count">Not loaded</span>
                    <button type="button" class="btn btn-accent" id="systems-load-btn"
                            onclick="loadConnectedSystems()">Load Status</button>
                </div>
            </div>

            <div class="systems-grid" id="systems-grid">
                <div class="empty-state systems-empty">
                    <div class="empty-mark">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"
                             stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="4" width="18" height="6" rx="1.5"></rect>
                            <rect x="3" y="14" width="18" height="6" rx="1.5"></rect>
                            <path d="M7 7h.01M7 17h.01"></path>
                        </svg>
                    </div>
                    <h4>Nothing has been asked yet</h4>
                    <p>Press Load Status to read each system you may reach. Nothing is
                        contacted until you do.</p>
                </div>
            </div>
        </div>

        <!-- registering an outside service is the administrator's alone -->
        <div class="card" id="systems-register-card" data-access="System Administrator">
            <div class="panel-head">
                <div>
                    <span class="eyebrow">Register</span>
                    <h3>Add an External System</h3>
                    <p class="panel-sub">A courier's tracking API, a supplier portal, a second branch:
                        anything that answers at an address. Nobody can reach it until you grant access
                        under Access Control.</p>
                </div>
            </div>
            <form id="systems-register-form" onsubmit="handleRegisterSystem(event)">
                <div class="grid-2">
                    <div class="form-group">
                        <label for="sys-key">Key <span class="label-hint">lower case, letters, digits and hyphens; never changes</span></label>
                        <input type="text" id="sys-key" name="key" class="form-control mono" required
                               maxlength="40" pattern="[a-z0-9][a-z0-9\\-]{1,39}" placeholder="courier-tracking"
                               oninput="this.value = this.value.toLowerCase().replace(/[^a-z0-9-]/g, '')">
                    </div>
                    <div class="form-group">
                        <label for="sys-name">Name</label>
                        <input type="text" id="sys-name" name="name" class="form-control" required
                               maxlength="100" placeholder="Courier Tracking">
                    </div>
                </div>
                <div class="form-group">
                    <label for="sys-url">Address <span class="label-hint">where it answers; http:// or https://</span></label>
                    <input type="url" id="sys-url" name="endpointUrl" class="form-control mono" required
                           maxlength="255" placeholder="https://tracking.example.com/health">
                </div>
                <div class="form-group">
                    <label for="sys-desc">What it is <span class="label-hint">optional</span></label>
                    <input type="text" id="sys-desc" name="description" class="form-control"
                           maxlength="255" placeholder="The courier's tracking API for deliveries beyond Nasugbu">
                </div>
                <div class="form-footer">
                    <button type="submit" class="btn btn-success">Register</button>
                    <button type="button" class="btn btn-ghost" onclick="document.getElementById('systems-register-form').reset()">Clear</button>
                </div>
            </form>
        </div>`;

    area.appendChild(panel);

    // applyAccessMarks has already run by the time this panel exists
    const registerCard = document.getElementById('systems-register-card');
    if (registerCard && typeof hasRole === 'function' && !hasRole('System Administrator')) {
        registerCard.hidden = true;
    }

    // keys and systems changing on another machine reach this page live
    if (typeof onLiveChange === 'function') {
        onLiveChange(['access', 'staff'], () => refreshSystemsAccess());
        onLiveChange(['systems'], () => {
            if (connectedSystems.length > 0 && !document.querySelector('.modal.open')) loadConnectedSystems(true);
        });
    }

    refreshSystemsAccess();
}

// Asked of the server, not the role. If the screen is open when the last key
// is taken back, it says so in place.
async function refreshSystemsAccess() {
    try {
        systemsAccess = await getJson('/api/me/access');
    } catch (error) {
        return;     // the session has ended, or the server is away; handled elsewhere
    }

    const item = document.getElementById(systemsSetup.navId);
    const may = Boolean(systemsAccess && systemsAccess.canReachSystems);
    if (item) item.hidden = !may;

    const panel = document.getElementById(systemsSetup.panelId);
    const open = panel && window.getComputedStyle(panel).display !== 'none';

    if (open) {
        if (!may) {
            connectedSystems = [];
            renderSystemsGrid([], 'Your access to the connected systems has been withdrawn. ' +
                'Nothing here can be read or run any more.');
            setPill('systems-count', 'No access');
        } else if (connectedSystems.length > 0) {
            loadConnectedSystems(true);
        }
    }
}

function showConnectedSystems(event) {
    if (event) event.preventDefault();

    if (typeof systemsSetup.showPanel === 'function') {
        systemsSetup.showPanel(systemsSetup.panelId, systemsSetup.title, event);
    } else {
        document.querySelectorAll('[data-panel]').forEach((panel) => {
            panel.style.display = panel.id === systemsSetup.panelId ? 'block' : 'none';
        });
    }

    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === systemsSetup.panelId);
    });
}

// Not loaded on the way in: an external system is a real request with a five
// second patience. Load Status asks; the live channel refreshes quietly after.
async function loadConnectedSystems(quiet) {
    const button = document.getElementById('systems-load-btn');
    if (!quiet) {
        setPill('systems-count', 'Reading');
        if (button) { button.disabled = true; button.textContent = 'Reading...'; }
    }

    try {
        connectedSystems = await getJson('/api/systems');
    } catch (error) {
        setPill('systems-count', 'Offline');
        if (!quiet) notifyOffline();
        if (button) { button.disabled = false; button.textContent = 'Load Status'; }
        return;
    }

    renderSystemsGrid(connectedSystems);
    setPill('systems-count', connectedSystems.length +
        (connectedSystems.length === 1 ? ' system' : ' systems'));

    if (button) { button.disabled = false; button.textContent = 'Refresh Status'; }

    const pill = document.getElementById('systems-count');
    if (quiet && pill) {
        pill.classList.add('is-fresh');
        setTimeout(() => pill.classList.remove('is-fresh'), 2200);
    }
}

// green: nothing to do, amber: look at this, crimson: broken, grey: off/unknown
const SYSTEM_STATE = {
    ok:      { word: 'Healthy',   tone: 'is-ok' },
    warn:    { word: 'Attention', tone: 'is-warn' },
    bad:     { word: 'Problem',   tone: 'is-bad' },
    off:     { word: 'Off',       tone: 'is-off' },
    unknown: { word: 'Unknown',   tone: 'is-off' }
};

function accessWords(access) {
    const held = [];
    if (access.monitor) held.push('monitor');
    if (access.manage) held.push('manage');
    if (access.control) held.push('control');
    return held.length ? held.join(' · ') : 'no access';
}

function renderSystemsGrid(systems, emptyText) {
    const grid = document.getElementById('systems-grid');
    if (!grid) return;

    if (!systems || systems.length === 0) {
        grid.innerHTML =
            '<div class="empty-state systems-empty">' +
                '<h4>Nothing to show</h4>' +
                '<p>' + escapeHtml(emptyText || 'You hold no access to any connected system. ' +
                    'The System Administrator grants it from Access Control.') + '</p>' +
            '</div>';
        return;
    }

    grid.innerHTML = systems.map((system, index) => renderSystemCard(system, index)).join('');
}

function renderSystemCard(system, index) {
    const state = SYSTEM_STATE[system.status ? system.status.state : 'unknown'] || SYSTEM_STATE.unknown;
    const disabled = !system.enabled;

    const facts = system.status && system.status.facts
        // a long value drops under its label
        ? Object.entries(system.status.facts).map(([label, value]) =>
            '<div class="system-fact' + (String(value).length > 36 ? ' is-long' : '') + '"><span class="system-fact-label">' + escapeHtml(label) +
            '</span><span class="system-fact-value">' + escapeHtml(value) + '</span></div>').join('')
        : '';

    const actions = (system.actions || []).map((action) =>
        '<button type="button" class="btn btn-sm ' + (action.danger ? 'btn-danger' : 'btn-ghost') + '" ' +
            'onclick="runSystemAction(' + index + ', \'' + escapeHtml(action.key) + '\')" ' +
            (disabled ? 'disabled title="Switched off"' : 'title="' + escapeHtml(action.hint) + '"') + '>' +
            escapeHtml(action.label) + '</button>').join('');

    const manage = system.access && system.access.manage
        ? '<button type="button" class="btn btn-sm" onclick="openSystemSettings(' + index + ')">Settings</button>'
        : '';

    return '<article class="system-card ' + state.tone + (disabled ? ' is-disabled' : '') + '">' +
        '<div class="system-head">' +
            '<div class="system-title">' +
                '<span class="system-kind">' + escapeHtml(system.kind) + (disabled ? ' · switched off' : '') + '</span>' +
                '<h4>' + escapeHtml(system.name) + '</h4>' +
                '<span class="system-key mono">' + escapeHtml(system.key) + '</span>' +
            '</div>' +
            '<span class="system-state">' + escapeHtml(disabled ? 'Off' : state.word) + '</span>' +
        '</div>' +
        (system.description ? '<p class="system-desc">' + escapeHtml(system.description) + '</p>' : '') +
        '<p class="system-summary">' + escapeHtml(system.status ? system.status.summary :
            'You may not read this system\'s status.') + '</p>' +
        (facts ? '<div class="system-facts">' + facts + '</div>' : '') +
        '<div class="system-foot">' +
            '<span class="system-access" title="What you hold on this system">Your access: ' +
                escapeHtml(accessWords(system.access || {})) + '</span>' +
            '<div class="system-actions">' + manage + actions + '</div>' +
        '</div>' +
    '</article>';
}

// ==========================================
// RUNNING A COMMAND
//
// Every one asks first, and the card says what will be written down: the
// command, the system, and the name of whoever confirmed it. A command that
// destroys nothing still asks, because the entry it leaves in the trail is
// permanent and made in the person's name.
// ==========================================
async function runSystemAction(index, actionKey) {
    const system = connectedSystems[index];
    if (!system) return;

    const action = (system.actions || []).find((item) => item.key === actionKey);
    if (!action) return;

    const me = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const detail = [
        'System: ' + system.name,
        'Command: ' + action.label,
        'Recorded as: ' + (me ? staffName(me) : 'you') + ', with the time and this machine\'s address'
    ];
    if (action.hint) detail.push(action.hint);

    let payload = {};

    if (action.needsMessage) {
        const message = await askInput({
            title: 'Send ' + system.name + ' a message',
            eyebrow: 'Connected Systems',
            message: 'The message is posted to ' + (system.endpointUrl || 'its address') +
                ' as JSON, signed with your email and the time. It is written to the audit trail too.',
            label: 'Message',
            placeholder: 'Delivery run for tomorrow is confirmed.',
            confirmLabel: 'Send it',
            check: (value) => value.trim() === '' ? 'Type the message first.' : null
        });
        if (message === false || message === null) return;
        payload = { message: message.trim() };
    } else {
        const yes = action.danger
            ? await askDanger('This runs against ' + system.name + ' now and is written to the audit trail in your name.', {
                title: action.label + '?',
                eyebrow: 'Connected Systems',
                confirmLabel: action.label,
                detail: detail
            })
            : await askConfirm('This runs against ' + system.name + ' now and is written to the audit trail in your name.', {
                title: action.label + '?',
                eyebrow: 'Connected Systems',
                confirmLabel: action.label,
                detail: detail
            });
        if (!yes) return;
    }

    notifyInfo('Running "' + action.label + '" on ' + system.name + '.', 'Command sent');

    try {
        const response = await fetch('/api/systems/' + encodeURIComponent(system.key) +
            '/actions/' + encodeURIComponent(action.key), {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(payload)
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'The command failed');
        } else if (body.ok === false) {
            notifyWarning(body.message, 'The command ran, but');
        } else {
            notifySuccess(body.message, 'Done on ' + system.name);
        }

        if (typeof refreshSystemsAccess === 'function') await refreshSystemsAccess();
        await loadConnectedSystems(true);
    } catch (error) {
        notifyOffline();
    }
}

// Manage: on/off, name, description, and the address of an outside service.
// The key is not editable; the URLs and the trail call the system by it.
let selectedSystem = null;

function buildSystemSettingsModal() {
    if (document.getElementById('system-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'system-modal';
    modal.setAttribute('onclick', "closeModalOnBackdrop(event, 'system-modal')");
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-head">
                <div class="modal-identity">
                    <div class="avatar" id="system-modal-avatar">--</div>
                    <div>
                        <h3 id="system-modal-name">System</h3>
                        <span class="modal-role" id="system-modal-key">key</span>
                    </div>
                </div>
                <button type="button" class="modal-close" onclick="closeModal('system-modal')" aria-label="Close">&times;</button>
            </div>
            <div class="modal-body">
                <form id="system-form" onsubmit="handleSaveSystem(event)">
                    <div class="form-group">
                        <label for="system-form-name">Name</label>
                        <input type="text" id="system-form-name" name="name" class="form-control" required maxlength="100">
                    </div>
                    <div class="form-group">
                        <label for="system-form-desc">What it is <span class="label-hint">optional</span></label>
                        <input type="text" id="system-form-desc" name="description" class="form-control" maxlength="255">
                    </div>
                    <div class="form-group" id="system-form-url-group">
                        <label for="system-form-url">Address</label>
                        <input type="url" id="system-form-url" name="endpointUrl" class="form-control mono" maxlength="255">
                    </div>
                    <div class="form-group">
                        <label for="system-form-enabled">State</label>
                        <select id="system-form-enabled" name="enabled" class="form-control">
                            <option value="true">Switched on</option>
                            <option value="false">Switched off &mdash; no commands may be run against it</option>
                        </select>
                    </div>
                    <div class="form-footer">
                        <button type="submit" class="btn btn-success">Save Settings</button>
                        <button type="button" class="btn btn-ghost" onclick="closeModal('system-modal')">Cancel</button>
                    </div>
                </form>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

function openSystemSettings(index) {
    selectedSystem = connectedSystems[index] || null;
    if (!selectedSystem) return;

    buildSystemSettingsModal();

    document.getElementById('system-modal-name').textContent = selectedSystem.name;
    document.getElementById('system-modal-key').textContent = selectedSystem.kind + ' · ' + selectedSystem.key;
    document.getElementById('system-modal-avatar').textContent = selectedSystem.name.slice(0, 2).toUpperCase();

    const form = document.getElementById('system-form');
    form.elements.name.value = selectedSystem.name;
    form.elements.description.value = selectedSystem.description || '';
    form.elements.endpointUrl.value = selectedSystem.endpointUrl || '';
    form.elements.enabled.value = selectedSystem.enabled ? 'true' : 'false';

    const urlGroup = document.getElementById('system-form-url-group');
    urlGroup.style.display = selectedSystem.kind === 'External' ? 'block' : 'none';
    form.elements.endpointUrl.required = selectedSystem.kind === 'External';

    showModal('system-modal');
}

async function handleSaveSystem(event) {
    event.preventDefault();
    if (!selectedSystem) return;

    const form = event.target;
    const enabled = form.elements.enabled.value === 'true';

    if (selectedSystem.enabled && !enabled) {
        const yes = await askDanger(selectedSystem.name + ' is switched off for everybody until it is switched back on.', {
            title: 'Switch this system off?',
            eyebrow: 'Connected Systems',
            confirmLabel: 'Switch it off',
            detail: [
                'No command can be run against it while it is off.',
                'Its status can still be read, and access already granted is kept.',
                'The change is written to the audit trail in your name.'
            ]
        });
        if (!yes) return;
    }

    const data = {
        name: form.elements.name.value.trim(),
        description: form.elements.description.value.trim(),
        enabled: enabled
    };
    if (selectedSystem.kind === 'External') data.endpointUrl = form.elements.endpointUrl.value.trim();

    try {
        const response = await fetch('/api/systems/' + encodeURIComponent(selectedSystem.key), {
            method: 'PUT', headers: apiHeaders(), body: JSON.stringify(data)
        });
        const body = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Nothing was saved');
            return;
        }

        closeModal('system-modal');
        notifySuccess(body.message, 'Settings saved');
        await loadConnectedSystems(true);
    } catch (error) {
        notifyOffline();
    }
}

// ---------- registering an outside service (administrator) ----------
async function handleRegisterSystem(event) {
    event.preventDefault();
    const form = event.target;

    const data = {
        key: form.elements.key.value.trim().toLowerCase(),
        name: form.elements.name.value.trim(),
        endpointUrl: form.elements.endpointUrl.value.trim(),
        description: form.elements.description.value.trim()
    };

    const yes = await askConfirm('The system is added to the register and its address is contacted the first time its status is read.', {
        title: 'Register this system?',
        eyebrow: 'Connected Systems',
        confirmLabel: 'Register',
        detail: [
            'Key: ' + data.key,
            'Name: ' + data.name,
            'Address: ' + data.endpointUrl,
            'Nobody but you can reach it until access is granted under Access Control.'
        ]
    });
    if (!yes) return;

    const result = await postJson('/api/systems', data);
    if (!result) return;

    form.reset();
    notifySuccess(result.message, 'System registered');
    await loadConnectedSystems(true);
}
