// format.js  --  FORMATTING AND FETCHING
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
function peso(value) {
    const number = Number(value || 0);
    return number.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusBadge(text) {
    const good = ['Paid', 'Delivered', 'In Stock', 'Active', 'Received'];
    const bad = ['Unpaid', 'Failed', 'Out of Stock', 'Inactive', 'Cancelled'];
    const warn = ['Partial', 'Low Stock', 'Delayed', 'Pending', 'In Transit', 'Out for Delivery'];

    let tone = 'badge-neutral';
    if (good.indexOf(text) !== -1) tone = 'badge-success';
    else if (bad.indexOf(text) !== -1) tone = 'badge-danger';
    else if (warn.indexOf(text) !== -1) tone = 'badge-warning';

    return '<span class="badge ' + tone + '">' + escapeHtml(text) + '</span>';
}

function tableMessage(tableId, columns, text) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + columns + '" class="table-empty">' + text + '</td></tr>';
}

function setPill(id, text) {
    const pill = document.getElementById(id);
    if (pill) pill.textContent = text;
}

async function getJson(url) {
    const response = await fetch(url, { headers: apiHeaders() });
    if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch (error) { body = null; }
        handleAuthFailure(response, body);
        throw new Error('request failed');
    }
    return response.json();
}

// The bell needs this and so does a popup card, and a popup card can appear
// on the sign-in screen where the bell does not exist, so it lives here with
// the rest of the formatting rather than with the alerts.
// "4 Sep 2026, 16:45" plus how long ago that was, because a date alone does
// not tell you whether this is today's problem or last month's
function whenText(stamp) {
    if (!stamp) return 'Time not recorded';

    const when = new Date(String(stamp).replace(' ', 'T'));
    if (isNaN(when.getTime())) return String(stamp).slice(0, 16);

    const shown = when.toLocaleString('en-PH', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    });

    const minutes = Math.round((Date.now() - when.getTime()) / 60000);
    if (minutes < 1) return shown + ' · just now';
    if (minutes < 60) return shown + ' · ' + minutes + ' min ago';

    const hours = Math.round(minutes / 60);
    if (hours < 24) return shown + ' · ' + hours + (hours === 1 ? ' hour ago' : ' hours ago');

    const days = Math.round(hours / 24);
    if (days < 31) return shown + ' · ' + days + (days === 1 ? ' day ago' : ' days ago');

    return shown;
}
