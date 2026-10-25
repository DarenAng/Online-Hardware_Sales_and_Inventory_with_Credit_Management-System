const scheduleSetup = {
    showPanel: null,
    panelId: 'panel-delivery-schedule',
    title: 'Delivery Schedule'
};

let scheduleRows = null;
let schedulePage = 1;
const SCHEDULE_ROWS_PER_PAGE = 10;

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
    panel.innerHTML = '\n' +
        '        <div class="card">\n' +
        '            <div class="panel-head">\n' +
        '                <div>\n' +
        '                    <h3>Delivery Schedule</h3>\n' +
        '                    <p class="panel-sub">What still has to go out, by the day it is due. A delivery\n' +
        '                        leaves this list once it is delivered or has failed.</p>\n' +
        '                </div>\n' +
        '                <div class="panel-actions no-print">\n' +
        '                    <button type="button" class="btn btn-accent" id="schedule-load-btn"\n' +
        '                            onclick="loadDeliverySchedule()">Load Schedule</button>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '\n' +
        '            <div class="panel-toolbar no-print">\n' +
        '                <div class="search-wrap">\n' +
        '                    <input type="search" id="schedule-search" class="form-control search-input"\n' +
        '                           placeholder="Search Deliveries" autocomplete="off"\n' +
        '                           oninput="onScheduleSearch(this.value)">\n' +
        '                </div>\n' +
        '                <div class="toolbar-field">\n' +
        '                    <label for="schedule-status">Status</label>\n' +
        '                    <select id="schedule-status" onchange="scheduleFilterChanged()">\n' +
        '                        <option value="all">Every status</option>\n' +
        '                    </select>\n' +
        '                </div>\n' +
        '                <div class="toolbar-field">\n' +
        '                    <label for="schedule-driver">Driver</label>\n' +
        '                    <select id="schedule-driver" onchange="scheduleFilterChanged()">\n' +
        '                        <option value="all">Every driver</option>\n' +
        '                    </select>\n' +
        '                </div>\n' +
        '            </div>\n' +
        '\n' +
        '            <div id="schedule-body">\n' +
        '                <p class="table-empty">Reading the database...</p>\n' +
        '            </div>\n' +
        '        </div>';

    area.appendChild(panel);

    if (typeof onLiveChange === 'function') {
        onLiveChange(['deliveries', 'sales'], function () {
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
        const panels = document.querySelectorAll('[data-panel]');
        for (let i = 0; i < panels.length; i++) {
            panels[i].style.display = panels[i].id === scheduleSetup.panelId ? 'block' : 'none';
        }
        const links = document.querySelectorAll('[data-panel-link]');
        for (let i = 0; i < links.length; i++) {
            links[i].classList.toggle('active', links[i].dataset.panelLink === scheduleSetup.panelId);
        }
    }

    if (scheduleRows === null) loadDeliverySchedule();
}

function scheduleFilterChanged() {
    schedulePage = 1;
    renderDeliverySchedule();
}

function scheduleGoTo(page) {
    schedulePage = page;
    renderDeliverySchedule();
}

const SCHEDULE_GROUPS = {
    overdue:  { label: 'Overdue',     badge: 'badge-danger' },
    today:    { label: 'Today',       badge: 'badge-warning' },
    tomorrow: { label: 'Tomorrow',    badge: 'badge-info' },
    later:    { label: 'Later',       badge: 'badge-neutral' },
    unset:    { label: 'No date yet', badge: 'badge-neutral' }
};

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
        scheduleRows = [];
        if (Array.isArray(rows)) {
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].status !== 'Delivered' && rows[i].status !== 'Failed') {
                    scheduleRows.push(rows[i]);
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

function scheduleValue(id) {
    const field = document.getElementById(id);
    return field ? field.value : 'all';
}

function fillScheduleOptions() {
    function fill(id, values, allLabel) {
        const select = document.getElementById(id);
        if (!select) return;
        const picked = select.value;

        const unique = [];
        for (let i = 0; i < values.length; i++) {
            if (values[i] && unique.indexOf(values[i]) === -1) {
                unique.push(values[i]);
            }
        }
        unique.sort(function (a, b) {
            return a.localeCompare(b);
        });

        let optionsHtml = '<option value="all">' + escapeHtml(allLabel) + '</option>';
        for (let i = 0; i < unique.length; i++) {
            optionsHtml += '<option value="' + escapeHtml(unique[i]) + '">' + escapeHtml(unique[i]) + '</option>';
        }
        select.innerHTML = optionsHtml;
        select.value = unique.indexOf(picked) !== -1 ? picked : 'all';
    }

    const statuses = [];
    const drivers = [];
    for (let i = 0; i < scheduleRows.length; i++) {
        statuses.push(scheduleRows[i].status);
        drivers.push(scheduleRows[i].driver_name || 'Unassigned');
    }
    fill('schedule-status', statuses, 'Every status');
    fill('schedule-driver', drivers, 'Every driver');
}

function onScheduleSearch(text) {
    if (scheduleRows === null) {
        if (searchText(text) !== '') loadDeliverySchedule();
        return;
    }
    scheduleFilterChanged();
}

function scheduleMatches(d) {
    const query = searchText((document.getElementById('schedule-search') || {}).value);
    if (query !== '') {
        if (!prefixMatch([d.customer_name || 'Walk-in', d.delivery_address || '', d.driver_name || 'Unassigned',
                          d.delivery_id], query)) return false;
    }
    const status = scheduleValue('schedule-status');
    if (status !== 'all' && d.status !== status) return false;
    const driver = scheduleValue('schedule-driver');
    if (driver !== 'all' && (d.driver_name || 'Unassigned') !== driver) return false;
    return true;
}

function renderDeliverySchedule() {
    const body = document.getElementById('schedule-body');
    if (!body || scheduleRows === null) return;

    const rows = [];
    for (let i = 0; i < scheduleRows.length; i++) {
        if (scheduleMatches(scheduleRows[i])) rows.push(scheduleRows[i]);
    }
    rows.sort(function (a, b) {
        return String(a.scheduled_date || '9999').localeCompare(String(b.scheduled_date || '9999'));
    });

    if (scheduleSort) {
        const key = SCHEDULE_SORT_KEYS[scheduleSort.column];
        const descending = scheduleSort.descending;
        const indexed = rows.map(function (row, at) { return { row: row, value: key(row), at: at }; });
        indexed.sort(function (x, y) {
            const xEmpty = x.value === null || x.value === undefined || x.value === '';
            const yEmpty = y.value === null || y.value === undefined || y.value === '';
            if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
            const result = compareSortValues(x.value, y.value);
            return (descending ? -result : result) || x.at - y.at;
        });
        rows.length = 0;
        for (let i = 0; i < indexed.length; i++) rows.push(indexed[i].row);
    }

    if (rows.length === 0) {
        body.innerHTML = scheduleRows.length > 0
            ? '<div class="empty-state"><h4>No delivery matches</h4>' +
              '<p>Nothing on the schedule fits the search and filters above.</p></div>'
            : '<div class="empty-state">' +
              '<h4>Nothing is waiting to go out</h4>' +
              '<p>Every delivery has been delivered, or has failed and been closed.</p></div>';
        return;
    }

    const canOpen = typeof showDeliveryRecord === 'function';
    const canUpdate = typeof hasRole === 'function' && hasRole('Delivery Personnel');

    const hidden = [];
    if (scheduleValue('schedule-driver') !== 'all') hidden.push(5);
    if (scheduleValue('schedule-status') !== 'all') hidden.push(6);

    const pages = Math.max(1, Math.ceil(rows.length / SCHEDULE_ROWS_PER_PAGE));
    schedulePage = Math.min(Math.max(1, schedulePage), pages);
    const start = (schedulePage - 1) * SCHEDULE_ROWS_PER_PAGE;
    const pageRows = rows.slice(start, start + SCHEDULE_ROWS_PER_PAGE);

    let rowsHtml = '';
    for (let i = 0; i < pageRows.length; i++) {
        const d = pageRows[i];
        const group = SCHEDULE_GROUPS[scheduleGroupOf(d)];
        const day = scheduleDateOf(d.scheduled_date);
        const due = day ? (day + ' ' + scheduleTimeOf(d.scheduled_date)).trim() : 'Not set';

        rowsHtml += '<tr class="' + (canOpen ? 'row-clickable ' : '') + 'row-reveal" ' +
            'style="animation-delay:' + (i % 10) * 28 + 'ms"' +
            (canOpen ? ' onclick="openScheduledDelivery(' + Number(d.delivery_id) + ')"' : '') + '>' +
            '<td class="cell-id">' + escapeHtml(due) + '</td>' +
            '<td><span class="badge ' + group.badge + '">' + group.label + '</span></td>' +
            '<td class="cell-name">' + escapeHtml(d.customer_name || 'Walk-in') + '</td>' +
            '<td>' + escapeHtml(d.delivery_address || '') + '</td>' +
            '<td>' + escapeHtml(d.driver_name || 'Unassigned') + '</td>' +
            '<td>' + statusBadge(d.status) + '</td></tr>';
    }

    if (pages > 1) rowsHtml += fillerRows(SCHEDULE_ROWS_PER_PAGE - pageRows.length, SCHEDULE_HEADERS.length);

    let pagerHtml = '';
    if (pages > 1) {
        pagerHtml = '<div class="pager"><div class="pager-controls">' +
            '<button type="button" class="btn btn-sm" onclick="scheduleGoTo(' + (schedulePage - 1) + ')"' +
                (schedulePage === 1 ? ' disabled' : '') + '>Previous</button>' +
            '<span class="pager-page">Page ' + schedulePage + ' of ' + pages + '</span>' +
            '<button type="button" class="btn btn-sm" onclick="scheduleGoTo(' + (schedulePage + 1) + ')"' +
                (schedulePage === pages ? ' disabled' : '') + '>Next</button>' +
        '</div></div>';
    }

    body.innerHTML = '<div class="table-responsive">' +
        '<table id="schedule-table" data-hidden-columns="' + hidden.join(',') + '">' +
        '<thead><tr>' + scheduleHeaders() + '</tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody></table></div>' + pagerHtml;

    body.dataset.canUpdate = canUpdate ? '1' : '';
}

const SCHEDULE_HEADERS = ['Due', 'When', 'Customer', 'Destination', 'Driver', 'Status'];
const SCHEDULE_GROUP_ORDER = ['overdue', 'today', 'tomorrow', 'later', 'unset'];
const SCHEDULE_SORT_KEYS = [
    function (d) { return d.scheduled_date ? String(d.scheduled_date) : ''; },
    function (d) { return SCHEDULE_GROUP_ORDER.indexOf(scheduleGroupOf(d)); },
    function (d) { return d.customer_name || 'Walk-in'; },
    function (d) { return d.delivery_address || ''; },
    function (d) { return d.driver_name || 'Unassigned'; },
    function (d) { return d.status || ''; }
];
let scheduleSort = null;

function scheduleHeaders() {
    let html = '';
    for (let i = 0; i < SCHEDULE_HEADERS.length; i++) {
        let state = 'none';
        if (scheduleSort && scheduleSort.column === i) state = scheduleSort.descending ? 'descending' : 'ascending';
        html += '<th class="th-sortable" tabindex="0" aria-sort="' + state + '" title="Sort by ' + SCHEDULE_HEADERS[i] + '" ' +
            'onclick="sortDeliverySchedule(' + i + ')" ' +
            'onkeydown="if (event.key === \'Enter\' || event.key === \' \') { event.preventDefault(); sortDeliverySchedule(' + i + '); }">' +
            SCHEDULE_HEADERS[i] + '</th>';
    }
    return html;
}

function sortDeliverySchedule(column) {
    if (scheduleSort && scheduleSort.column === column) scheduleSort.descending = !scheduleSort.descending;
    else scheduleSort = { column: column, descending: false };
    scheduleFilterChanged();
}

function openScheduledDelivery(deliveryId) {
    if (typeof showDeliveryRecord !== 'function' || scheduleRows === null) return;
    let delivery;
    for (let i = 0; i < scheduleRows.length; i++) {
        if (Number(scheduleRows[i].delivery_id) === Number(deliveryId)) {
            delivery = scheduleRows[i];
            break;
        }
    }
    if (!delivery) return;

    const body = document.getElementById('schedule-body');
    let canUpdate = Boolean(body && body.dataset.canUpdate);

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    if (canUpdate && user && user.role_name === 'Delivery Personnel') {
        if (delivery.delivery_staff_id == null || Number(delivery.delivery_staff_id) !== Number(user.staff_id)) {
            canUpdate = false;
        }
    }

    showDeliveryRecord(delivery, canUpdate);
}
