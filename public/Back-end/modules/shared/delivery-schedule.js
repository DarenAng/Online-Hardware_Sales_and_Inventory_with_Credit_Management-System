// delivery-schedule.js -- open deliveries grouped by the day they are due
// Loaded by: the four staff dashboards
//
// Drawn by script because the administrator can hand this screen to any role
// (Access Control); the page supplies only the hidden menu item.
//
//   configureDeliverySchedule({ showPanel: showManagerPanel });
//   buildDeliverySchedulePanel();       // draws the panel into .content-area

const scheduleSetup = {
    showPanel: null,
    panelId: 'panel-delivery-schedule',
    title: 'Delivery Schedule'
};

let scheduleRows = null;            // what /api/deliveries last answered, null until asked

function configureDeliverySchedule(options) {
    Object.assign(scheduleSetup, options || {});
}

function buildDeliverySchedulePanel() {
    const area = document.querySelector('.content-area');
    if (!area || document.getElementById(scheduleSetup.panelId)) return;

    const panel = document.createElement('div');
    panel.id = scheduleSetup.panelId;
    panel.setAttribute('data-panel', '');
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="card">
            <div class="panel-head">
                <div>
                    <h3>Delivery Schedule</h3>
                    <p class="panel-sub">What still has to go out, by the day it is due. A delivery
                        leaves this list once it is delivered or has failed.</p>
                </div>
                <div class="panel-actions no-print">
                    <button type="button" class="btn btn-accent" id="schedule-load-btn"
                            onclick="loadDeliverySchedule()">Load Schedule</button>
                </div>
            </div>

            <div class="panel-toolbar no-print">
                <div class="search-wrap">
                    <input type="search" id="schedule-search" class="form-control search-input"
                           placeholder="Search by customer, destination or driver"
                           oninput="onScheduleSearch(this.value)">
                </div>
                <div class="toolbar-field">
                    <label for="schedule-due">Due</label>
                    <select id="schedule-due" onchange="renderDeliverySchedule()">
                        <option value="all">Any day</option>
                        <option value="overdue">Overdue</option>
                        <option value="today">Today</option>
                        <option value="tomorrow">Tomorrow</option>
                        <option value="later">Later</option>
                        <option value="unset">No date yet</option>
                    </select>
                </div>
                <div class="toolbar-field">
                    <label for="schedule-status">Status</label>
                    <select id="schedule-status" onchange="renderDeliverySchedule()">
                        <option value="all">Every status</option>
                    </select>
                </div>
                <div class="toolbar-field">
                    <label for="schedule-driver">Driver</label>
                    <select id="schedule-driver" onchange="renderDeliverySchedule()">
                        <option value="all">Every driver</option>
                    </select>
                </div>
            </div>

            <div id="schedule-body">
                <div class="empty-state">
                    <div class="empty-mark">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"
                             stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="5" width="18" height="16" rx="2"></rect>
                            <path d="M3 10h18M8 3v4M16 3v4"></path>
                        </svg>
                    </div>
                    <h4>Nothing has been asked yet</h4>
                    <p>Press Load Schedule to read the deliveries still to go out.</p>
                </div>
            </div>
        </div>`;

    area.appendChild(panel);

    // deliveries moved on another machine reach this list live
    if (typeof onLiveChange === 'function') {
        onLiveChange(['deliveries', 'sales'], () => {
            if (scheduleRows === null || document.querySelector('.modal.open')) return;
            const open = window.getComputedStyle(panel).display !== 'none';
            if (open) loadDeliverySchedule(true);
        });
    }
}

function showDeliverySchedule(event) {
    if (event) event.preventDefault();

    if (typeof scheduleSetup.showPanel === 'function') {
        scheduleSetup.showPanel(scheduleSetup.panelId, scheduleSetup.title, event);
    } else {
        document.querySelectorAll('[data-panel]').forEach((panel) => {
            panel.style.display = panel.id === scheduleSetup.panelId ? 'block' : 'none';
        });
        document.querySelectorAll('[data-panel-link]').forEach((link) => {
            link.classList.toggle('active', link.dataset.panelLink === scheduleSetup.panelId);
        });
    }
}

// Grouped by scheduled date against the browser's today. A delivery with no
// date is listed last under its own heading.
const SCHEDULE_GROUPS = [
    { key: 'overdue',  label: 'Overdue',     tone: 'is-overdue',  note: 'Due before today and not yet delivered.' },
    { key: 'today',    label: 'Today',       tone: 'is-today',    note: 'Due today.' },
    { key: 'tomorrow', label: 'Tomorrow',    tone: '',            note: 'Due tomorrow.' },
    { key: 'later',    label: 'Later',       tone: '',            note: 'Due after tomorrow.' },
    { key: 'unset',    label: 'No date yet', tone: '',            note: 'Booked without a day to go out on.' }
];

function scheduleDayOf(stamp) {
    if (!stamp) return null;
    const text = String(stamp);
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function scheduleGroupOf(delivery) {
    const day = scheduleDayOf(delivery.scheduled_date);
    if (!day) return 'unset';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const gap = Math.round((day - today) / 86400000);

    if (gap < 0) return 'overdue';
    if (gap === 0) return 'today';
    if (gap === 1) return 'tomorrow';
    return 'later';
}

function scheduleTimeOf(stamp) {
    const text = String(stamp || '');
    const match = /(\d{2}):(\d{2})/.exec(text.slice(10));
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = match[2];
    const suffix = hour >= 12 ? 'pm' : 'am';
    return ((hour % 12) || 12) + ':' + minute + ' ' + suffix;
}

function scheduleDateOf(stamp) {
    const day = scheduleDayOf(stamp);
    if (!day) return '';
    return day.toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function loadDeliverySchedule(quiet) {
    const body = document.getElementById('schedule-body');
    const button = document.getElementById('schedule-load-btn');
    if (!body) return;

    if (!quiet && button) button.disabled = true;

    try {
        const rows = await apiGetDeliveries();
        // keep only the deliveries that still have to go out
        scheduleRows = [];
        if (Array.isArray(rows)) {
            for (const d of rows) {
                if (d.status !== 'Delivered' && d.status !== 'Failed') {
                    scheduleRows.push(d);
                }
            }
        }
        fillScheduleOptions();
        renderDeliverySchedule();
    } catch (error) {
        if (!quiet) notifyOffline();
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- searching and filtering the schedule ----------
function scheduleValue(id) {
    const field = document.getElementById(id);
    return field ? field.value : 'all';
}

// the Status and Driver boxes offer what the loaded deliveries hold
function fillScheduleOptions() {
    const fill = (id, values, allLabel) => {
        const select = document.getElementById(id);
        if (!select) return;
        const picked = select.value;
        const unique = Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
        select.innerHTML = '<option value="all">' + escapeHtml(allLabel) + '</option>' +
            unique.map((value) => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join('');
        select.value = unique.indexOf(picked) !== -1 ? picked : 'all';
    };
    fill('schedule-status', scheduleRows.map((d) => d.status), 'Every status');
    fill('schedule-driver', scheduleRows.map((d) => d.driver_name || 'Unassigned'), 'Every driver');
}

// typing on a list not loaded yet loads it, as the tables do
function onScheduleSearch(text) {
    if (scheduleRows === null) {
        if (searchText(text) !== '') loadDeliverySchedule();
        return;
    }
    renderDeliverySchedule();
}

function scheduleMatches(d) {
    const query = searchText((document.getElementById('schedule-search') || {}).value);
    if (query !== '') {
        if (!prefixMatch([d.customer_name || 'Walk-in', d.delivery_address || '', d.driver_name || 'Unassigned',
                          d.delivery_id], query)) return false;
    }
    const due = scheduleValue('schedule-due');
    if (due !== 'all' && scheduleGroupOf(d) !== due) return false;
    const status = scheduleValue('schedule-status');
    if (status !== 'all' && d.status !== status) return false;
    const driver = scheduleValue('schedule-driver');
    if (driver !== 'all' && (d.driver_name || 'Unassigned') !== driver) return false;
    return true;
}

function renderDeliverySchedule() {
    const body = document.getElementById('schedule-body');
    if (!body || scheduleRows === null) return;

    // a filter on status or driver means every row says the same there, so it is not drawn
    body.classList.toggle('hide-status', scheduleValue('schedule-status') !== 'all');
    body.classList.toggle('hide-driver', scheduleValue('schedule-driver') !== 'all');

    const rows = scheduleRows.filter(scheduleMatches).sort((a, b) =>
        String(a.scheduled_date || '9999').localeCompare(String(b.scheduled_date || '9999')));

    const grouped = {};
    SCHEDULE_GROUPS.forEach((group) => { grouped[group.key] = []; });
    rows.forEach((d) => grouped[scheduleGroupOf(d)].push(d));

    const total = rows.length;

    if (total === 0) {
        body.innerHTML = scheduleRows.length > 0
            ? '<div class="empty-state"><h4>No delivery matches</h4>' +
              '<p>Nothing on the schedule fits the search and filters above.</p></div>'
            : '<div class="empty-state">' +
              '<h4>Nothing is waiting to go out</h4>' +
              '<p>Every delivery booked has been delivered, or has failed and been closed.</p></div>';
        return;
    }

    // a delivery opens from here only on a page that loaded the delivery popup
    const canOpen = typeof showDeliveryRecord === 'function';
    const canUpdate = typeof hasRole === 'function' && hasRole('Manager', 'Delivery Personnel');
    const canArchive = typeof hasRole === 'function' && hasRole('Manager');

    body.innerHTML = SCHEDULE_GROUPS.map((group) => {
        const list = grouped[group.key];
        if (list.length === 0) return '';

        return '<section class="schedule-group ' + group.tone + '">' +
            '<header class="schedule-group-head">' +
                '<h4>' + group.label + ' <span class="schedule-group-count">' + list.length + '</span></h4>' +
                '<span class="schedule-group-note">' + group.note + '</span>' +
            '</header>' +
            '<ol class="schedule-list">' + list.map((d) =>
                '<li class="schedule-row' + (canOpen ? ' row-clickable' : '') + '"' +
                    (canOpen ? ' onclick="openScheduledDelivery(' + Number(d.delivery_id) + ')"' : '') + '>' +
                    '<span class="schedule-when">' +
                        '<span class="schedule-day">' + escapeHtml(scheduleDateOf(d.scheduled_date) || '—') + '</span>' +
                        '<span class="schedule-time">' + escapeHtml(scheduleTimeOf(d.scheduled_date)) + '</span>' +
                    '</span>' +
                    '<span class="schedule-who">' +
                        '<strong>' + escapeHtml(d.customer_name || 'Walk-in') + '</strong>' +
                        '<span class="schedule-where">' + escapeHtml(d.delivery_address || '') + '</span>' +
                    '</span>' +
                    '<span class="schedule-driver">' + escapeHtml(d.driver_name || 'Unassigned') + '</span>' +
                    '<span class="schedule-status">' + statusBadge(d.status) + '</span>' +
                '</li>').join('') +
            '</ol>' +
        '</section>';
    }).join('');

    body.dataset.canUpdate = canUpdate ? '1' : '';
    body.dataset.canArchive = canArchive ? '1' : '';
}

function openScheduledDelivery(deliveryId) {
    if (typeof showDeliveryRecord !== 'function' || scheduleRows === null) return;
    const delivery = scheduleRows.find((d) => Number(d.delivery_id) === Number(deliveryId));
    const body = document.getElementById('schedule-body');
    showDeliveryRecord(delivery, Boolean(body && body.dataset.canUpdate), Boolean(body && body.dataset.canArchive));
}
