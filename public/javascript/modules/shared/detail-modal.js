// detail-modal.js  --  PAGED DETAIL POPUP
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// PAGED DETAIL POPUP
// nothing scrolls, Next and Back move between pages
// ==========================================
let detailPages = [];
let detailIndex = 0;

function detailField(label, value) {
    return '<div class="detail-item"><span class="detail-label">' + label +
           '</span><span class="detail-value">' + value + '</span></div>';
}

// The staff directory and the my-credentials page were each building the same
// row with their own copy of this function under a second name. One of them
// has gone; the name stays, because both screens ask for it by it.
const detailRow = detailField;

// numeric is the list of column positions holding figures. They are right
// aligned, heading and all; everything else reads left, the same rule the
// tables on the pages follow.
function detailTable(headers, rows, numeric) {
    if (rows.length === 0) return '<p class="detail-empty">Nothing to show here.</p>';

    const isNumber = (index) => Array.isArray(numeric) && numeric.indexOf(index) !== -1;

    return '<div class="table-responsive"><table class="mini-table"><thead><tr>' +
        headers.map((h, i) => '<th class="' + (isNumber(i) ? 'col-num' : '') + '">' + h + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' +
            r.map((c, i) => '<td class="' + (isNumber(i) ? 'cell-num' : '') + '">' + c + '</td>').join('') +
            '</tr>').join('') +
        '</tbody></table></div>';
}

function openDetailModal(title, subtitle, initials, pages) {
    detailPages = pages;
    detailIndex = 0;

    document.getElementById('detail-title').textContent = title;
    document.getElementById('detail-subtitle').textContent = subtitle;
    document.getElementById('detail-avatar').textContent = initials;

    renderDetailPage();
    showModal('detail-modal');
}

function renderDetailPage() {
    const page = detailPages[detailIndex];
    document.getElementById('detail-page').innerHTML = page.body;

    document.getElementById('detail-steps').innerHTML = detailPages.map((p, i) =>
        '<button type="button" class="modal-tab' + (i === detailIndex ? ' active' : '') +
        '" onclick="detailGoTo(' + i + ')">' + escapeHtml(p.label) + '</button>'
    ).join('');

    document.getElementById('detail-counter').textContent =
        'Page ' + (detailIndex + 1) + ' of ' + detailPages.length;

    document.getElementById('detail-back').disabled = detailIndex === 0;
    document.getElementById('detail-next').disabled = detailIndex === detailPages.length - 1;
}

function detailGoTo(index) {
    if (index < 0 || index >= detailPages.length) return;
    detailIndex = index;
    renderDetailPage();
}

function detailNext() { detailGoTo(detailIndex + 1); }
function detailBack() { detailGoTo(detailIndex - 1); }

document.addEventListener('keydown', function (event) {
    const modal = document.getElementById('detail-modal');
    if (!modal || !modal.classList.contains('open')) return;
    if (event.key === 'ArrowRight') detailNext();
    if (event.key === 'ArrowLeft') detailBack();
});

function prettyLabel(key) {
    return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fieldValue(key, value) {
    if (value === null || value === undefined || value === '') return '<span class="muted">Not set</span>';
    if (MONEY_FIELDS.indexOf(key) !== -1) return peso(value);
    if (key === 'status' || key === 'stock_status') return statusBadge(String(value));
    return escapeHtml(value);
}

function initialsOf(text) {
    return String(text).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
