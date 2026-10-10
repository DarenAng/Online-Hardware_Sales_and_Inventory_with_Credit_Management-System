// detail-modal.js -- paged detail popup; tabs and arrow keys move between pages
// Loaded by: all five dashboards
let detailPages = [];
let detailIndex = 0;

function detailField(label, value) {
    return '<div class="detail-item"><span class="detail-label">' + label +
           '</span><span class="detail-value">' + value + '</span></div>';
}

// second name kept because both the directory and my-credentials ask for it
const detailRow = detailField;

// numeric: column positions holding figures, right aligned heading and all
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

// footActions: optional HTML for buttons in the popup's foot, so what can be
// done with the record stays in view whichever page is open. The foot is
// hidden when there are none: the x in the corner closes the card.
// options.wide: a wide card, for a record shown on one page;
// wide: 'xl' is wider still, for a record with a table beside its facts
function openDetailModal(title, subtitle, initials, pages, footActions, options) {
    detailPages = pages;
    detailIndex = 0;

    const settings = options || {};
    const modal = document.getElementById('detail-modal');
    // scroll: the record stays on one page and scrolls rather than turn pages
    if (modal) modal.toggleAttribute('data-modal-scroll', Boolean(settings.scroll));
    const box = modal ? modal.querySelector('.modal-box') : null;
    if (box) {
        box.classList.toggle('modal-wide', Boolean(settings.wide));
        box.classList.toggle('modal-xl', settings.wide === 'xl');
    }
    const steps = document.getElementById('detail-steps');
    if (steps) steps.hidden = pages.length < 2;

    document.getElementById('detail-title').textContent = title;
    document.getElementById('detail-subtitle').textContent = subtitle;
    document.getElementById('detail-avatar').textContent = initials;

    const foot = document.querySelector('#detail-modal .modal-foot');
    if (foot) {
        foot.querySelectorAll('[data-detail-foot]').forEach((node) => node.remove());
        if (footActions) {
            const box = document.createElement('div');
            box.className = 'detail-foot-actions';
            box.setAttribute('data-detail-foot', '');
            box.innerHTML = footActions;
            foot.insertAdjacentElement('beforeend', box);
        }
        foot.hidden = !footActions;
    }

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

// "Juan Dela Cruz" -> "JD" (the first letter of the first two words)
function initialsOf(text) {
    const words = String(text).trim().split(/\s+/);
    let initials = '';
    for (const word of words.slice(0, 2)) {
        if (word !== '') {
            initials += word[0];
        }
    }
    return initials.toUpperCase();
}

// A table inside a popup, paged with Previous and Next rather than scrolled.
// The rows are kept under a name so the buttons can redraw the same box;
// six rows is what a popup shows without growing past the screen.
const PAGED_TABLE_ROWS = 6;
const pagedTables = {};

function pagedTable(id, headers, rows, numeric, options) {
    const settings = options || {};
    pagedTables[id] = {
        headers: headers,
        rows: rows,
        numeric: Array.isArray(numeric) ? numeric : [],
        page: 1,
        pageSize: settings.pageSize || PAGED_TABLE_ROWS,
        empty: settings.empty || 'Nothing to show here.',
        noun: settings.noun || 'record',
        // false leaves out the "1-6 of 12 sales" caption beside Previous and Next
        info: settings.info !== false,
        // optional: (index) => attributes for that row's <tr>, e.g. a click handler
        rowAttrs: typeof settings.rowAttrs === 'function' ? settings.rowAttrs : null
    };
    return '<div class="paged-table" id="paged-' + id + '">' + pagedTableBody(id) + '</div>';
}

function pagedTableBody(id) {
    const t = pagedTables[id];
    if (!t) return '';

    if (t.rows.length === 0) return '<p class="detail-empty">' + t.empty + '</p>';

    const pages = Math.max(1, Math.ceil(t.rows.length / t.pageSize));
    t.page = Math.min(Math.max(1, t.page), pages);

    const start = (t.page - 1) * t.pageSize;
    const slice = t.rows.slice(start, start + t.pageSize);
    const isNumber = (index) => t.numeric.indexOf(index) !== -1;

    const table = '<table class="mini-table"><thead><tr>' +
        t.headers.map((h, i) => '<th class="' + (isNumber(i) ? 'col-num' : '') + '">' + h + '</th>').join('') +
        '</tr></thead><tbody>' +
        slice.map((r, i) => '<tr' + (t.rowAttrs ? ' ' + t.rowAttrs(start + i) : '') + '>' +
            r.map((c, i) => '<td class="' + (isNumber(i) ? 'cell-num' : '') + '">' + c + '</td>').join('') +
            '</tr>').join('') +
        // the last page is topped up so Previous and Next stay put (tables.js)
        (pages > 1 ? fillerRows(t.pageSize - slice.length, t.headers.length) : '') +
        '</tbody></table>';

    if (pages === 1) return table;

    const total = t.rows.length;
    const plural = t.noun + (total === 1 ? '' : 's');

    return table +
        '<div class="pager paged-pager">' +
            '<span class="pager-info">' + (t.info
                ? (start + 1) + '&ndash;' + (start + slice.length) + ' of ' + total + ' ' + plural
                : '') + '</span>' +
            '<div class="pager-controls">' +
                '<button type="button" class="btn btn-sm" onclick="pagedTableGo(\'' + id + '\', -1)"' +
                    (t.page === 1 ? ' disabled' : '') + ' aria-label="Previous page">Previous</button>' +
                '<span class="pager-page">Page ' + t.page + ' of ' + pages + '</span>' +
                '<button type="button" class="btn btn-sm" onclick="pagedTableGo(\'' + id + '\', 1)"' +
                    (t.page === pages ? ' disabled' : '') + ' aria-label="Next page">Next</button>' +
            '</div>' +
        '</div>';
}

function pagedTableGo(id, delta) {
    const t = pagedTables[id];
    const mount = document.getElementById('paged-' + id);
    if (!t || !mount) return;

    // the page being left is measured first, so the next is held to it
    holdTableHeight(mount.querySelector('table'));
    t.page += delta;
    mount.innerHTML = pagedTableBody(id);
    holdTableHeight(mount.querySelector('table'));
}
