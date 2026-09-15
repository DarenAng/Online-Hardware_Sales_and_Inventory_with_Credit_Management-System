// delivery-schedule.js -- open deliveries grouped by the day they are due
// Loaded by: the four staff dashboards
//
// Drawn by script because the administrator can hand this screen to any role
// (Screens by Role); the page supplies only the hidden menu item.
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
                    <span class="eyebrow">Deliveries</span>
                    <h3>Delivery Schedule</h3>
                    <p class="panel-sub">What still has to go out, by the day it is due. A delivery
                        leaves this list once it is delivered or has failed.</p>
                </div>
                <div class="panel-actions no-print">
                    <span class="pill" id="schedule-count">Not loaded</span>
                    <button type="button" class="btn btn-accent" id="schedule-load-btn"
                            onclick="loadDeliverySchedule()">Load Schedule</button>
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

    if (!quiet) {
        setPill('schedule-count', 'Loading');
        if (button) button.disabled = true;
    }

    try {
        const rows = await getJson('/api/deliveries');
        scheduleRows = (Array.isArray(rows) ? rows : [])
            .filter((d) => d.status !== 'Delivered' && d.status !== 'Failed');
        renderDeliverySchedule();
        if (button) button.textContent = 'Refresh';
    } catch (error) {
        if (!quiet) {
            setPill('schedule-count', 'Not loaded');
            notifyOffline();
        }
    } finally {
        if (button) button.disabled = false;
    }
}

function renderDeliverySchedule() {
    const body = document.getElementById('schedule-body');
    if (!body || scheduleRows === null) return;

    const rows = scheduleRows.slice().sort((a, b) =>
        String(a.scheduled_date || '9999').localeCompare(String(b.scheduled_date || '9999')));

    const grouped = {};
    SCHEDULE_GROUPS.forEach((group) => { grouped[group.key] = []; });
    rows.forEach((d) => grouped[scheduleGroupOf(d)].push(d));

    const total = rows.length;
    const overdue = grouped.overdue.length;
    const pill = document.getElementById('schedule-count');
    if (pill) {
        pill.textContent = total === 0 ? 'Nothing to go out'
            : total + ' to go out' + (overdue > 0 ? ', ' + overdue + ' overdue' : '');
        pill.classList.toggle('is-fresh', true);
        window.setTimeout(() => pill.classList.remove('is-fresh'), 2300);
    }

    if (total === 0) {
        body.innerHTML = '<div class="empty-state">' +
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
