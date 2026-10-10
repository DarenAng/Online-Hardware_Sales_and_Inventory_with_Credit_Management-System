// tables.js -- alignment, phone labels, hidden columns and steady heights
// Loaded by: all five dashboards

// Each header takes its alignment from the row underneath it. Runs again
// whenever a table body changes.
function alignTableColumns(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headerCells = table.tHead.rows[0].cells;
    const bodyRows = table.tBodies[0].rows;

    let sample = null;
    for (const row of bodyRows) {
        if (row.cells.length === headerCells.length) { sample = row; break; }
    }

    for (let index = 0; index < headerCells.length; index += 1) {
        const header = headerCells[index];
        header.classList.remove('col-num', 'col-id', 'col-action');

        if (!sample) continue;
        const cell = sample.cells[index];
        if (!cell) continue;

        if (cell.classList.contains('cell-num')) header.classList.add('col-num');
        else if (cell.classList.contains('cell-action')) header.classList.add('col-action');
        else if (cell.classList.contains('cell-id')) header.classList.add('col-id');
    }

    labelTableCells(table);
    hideFilteredColumns(table);
}

// A filtered column says the same thing on every row, so a module can name
// the columns its filters made redundant in data-hidden-columns (1-based).
// Applied on every redraw because panels rebuild their rows on each page.
// ['2', 'x', '5'] -> [2, 5]  (keeps only whole numbers above 0)
function columnNumbers(values) {
    const list = [];
    for (const value of values) {
        const number = Number(value);
        if (Number.isInteger(number) && number > 0) {
            list.push(number);
        }
    }
    return list;
}

function setHiddenColumns(table, indexes) {
    if (!table) return;

    const list = columnNumbers(indexes || []);

    if (list.length === 0) delete table.dataset.hiddenColumns;
    else table.dataset.hiddenColumns = list.join(',');

    hideFilteredColumns(table);
}

function hideFilteredColumns(table) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;

    const hidden = columnNumbers(String(table.dataset.hiddenColumns || '').split(','));

    const headerCells = table.tHead.rows[0].cells;
    const columns = headerCells.length;

    const mark = (cell, index) => {
        cell.classList.toggle('col-hidden', hidden.indexOf(index + 1) !== -1);
    };

    Array.from(headerCells).forEach(mark);

    for (const body of table.tBodies) {
        for (const row of body.rows) {
            if (row.cells.length !== columns) continue;
            Array.from(row.cells).forEach(mark);
        }
    }
}

// Below 380px each row becomes a card, so every body cell is stamped with
// its own column heading for the stylesheet to print.
function labelTableCells(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headers = Array.from(table.tHead.rows[0].cells).map((cell) => cell.textContent.trim());

    for (const row of table.tBodies[0].rows) {
        if (row.cells.length !== headers.length) continue;

        for (let index = 0; index < row.cells.length; index += 1) {
            row.cells[index].setAttribute('data-column', headers[index]);
        }
    }
}

function alignAllTables(root) {
    (root || document).querySelectorAll('table').forEach(alignTableColumns);
}

function watchTablesForAlignment() {
    alignAllTables();

    const observer = new MutationObserver((records) => {
        const seen = new Set();
        const note = (table) => {
            if (table && !seen.has(table)) {
                seen.add(table);
                alignTableColumns(table);
            }
        };

        for (const record of records) {
            note(record.target.closest ? record.target.closest('table') : null);

            // a table that arrived whole inside innerHTML is found among the added nodes
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'TABLE') note(node);
                else if (node.querySelectorAll) node.querySelectorAll('table').forEach(note);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

// ==========================================
// A FILTER HIDES ITS OWN COLUMN
// A toolbar dropdown marked data-filter-table="sales-table" data-hides-column="5"
// decides that column: while it holds anything but "all", every row would
// say the same thing there, so the column is not drawn. Used on every page.
// A dropdown can name values that keep its column drawn, because the column
// holds more than the filtered word: data-keeps-column-for="PO Accepted|On the way".
// ==========================================
function syncFilteredColumns(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const hidden = [];
    document.querySelectorAll('select[data-filter-table="' + tableId + '"]').forEach((select) => {
        const keeps = String(select.dataset.keepsColumnFor || '').split('|');
        if (select.value !== 'all' && keeps.indexOf(select.value) === -1) {
            hidden.push(Number(select.dataset.hidesColumn));
        }
    });
    setHiddenColumns(table, hidden);
}

document.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches && target.matches('select[data-filter-table]')) {
        syncFilteredColumns(target.dataset.filterTable);
    }
});

// the browser can bring a dropdown back with its last value after a reload
document.addEventListener('DOMContentLoaded', () => {
    const tables = new Set();
    document.querySelectorAll('select[data-filter-table]').forEach((select) => tables.add(select.dataset.filterTable));
    tables.forEach(syncFilteredColumns);
});

// ==========================================
// A TABLE KEEPS THE HEIGHT OF ITS FULLEST PAGE
// A page with fewer rows than the page size is topped up with blank filler
// rows, and a table never draws shorter than the tallest it has been on this
// screen, so the pager and everything under it stay put: a last page of
// three, a search with one match, "Reading the database..." all take the
// room a full page took. Reset when the table's width changes, since rows
// wrap differently then. Phones stack rows as cards (responsive.css), where
// the fillers are hidden and nothing is held.
// ==========================================
// a row carrying a badge, as the grid-N heights in general-ui.css count it;
// a filler is never taller, so a table of a few tall rows is not padded out
// to a page of tall rows
const FILLER_ROW_HEIGHT = 52.3;
const heldTables = new WeakMap();   // a table's parent -> what its table has held
const heldBoxes = new WeakMap();    // a box -> the tallest it has been
let heldWatch = null;

function fillerRows(count, columns) {
    let html = '';
    for (let index = 0; index < count; index += 1) {
        html += '<tr class="row-filler" aria-hidden="true"><td colspan="' + columns + '"></td></tr>';
    }
    return html;
}

function tablesStacked() {
    return window.matchMedia('(max-width: 640px)').matches;
}

function heldRecord(map, holder) {
    let held = map.get(holder);
    if (!held) {
        held = { tallest: 0, rowHeight: FILLER_ROW_HEIGHT, width: -1, table: null };
        map.set(holder, held);
        watchHeldWidth(holder);
    }
    return held;
}

// a width change (a resized window, a tab opened) starts the count again
function watchHeldWidth(holder) {
    if (typeof ResizeObserver !== 'function') return;
    if (!heldWatch) {
        heldWatch = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const target = entry.target;
                if (!target.isConnected) { heldWatch.unobserve(target); continue; }
                const width = Math.round(entry.contentRect.width);

                const box = heldBoxes.get(target);
                if (box && box.width !== width) {
                    box.width = width;
                    box.tallest = 0;
                    target.style.minHeight = '';
                }

                const held = heldTables.get(target);
                if (held && held.width !== width) {
                    held.width = width;
                    held.tallest = 0;
                    if (held.table && held.table.parentElement === target) holdTableHeight(held.table);
                }

                if (box) holdBoxHeight(target);
            }
        });
    }
    heldWatch.observe(holder);   // observing twice is harmless
}

// sets each row's height; '' hands it back to the stylesheet
function setRowHeights(rows, heightOf) {
    const heights = rows.map(heightOf);
    rows.forEach((row, index) => {
        row.style.height = heights[index] === '' ? '' : heights[index] + 'px';
    });
}

// grows the given rows until the table is the target height; checked once
// more, because a row's border counts differently per browser
function stretchRows(table, rows, target) {
    for (let pass = 0; pass < 2; pass += 1) {
        const gap = target - table.getBoundingClientRect().height;
        if (Math.abs(gap) < 0.5) return;
        const share = gap / rows.length;
        setRowHeights(rows, (row) => Math.max(0, row.getBoundingClientRect().height + share));
    }
}

// Call after the rows are drawn. Message rows ("Loading...", "No match") are
// one cell across the table and are stretched to the held height.
function holdTableHeight(table) {
    if (!table || !table.tBodies.length || !table.parentElement) return;

    const held = heldRecord(heldTables, table.parentElement);
    held.table = table;

    // the observer would align the headings after this measures, and a
    // heading's class can change the column widths and so the row heights
    alignTableColumns(table);

    const body = table.tBodies[0];
    const rows = Array.from(body.rows);
    const fillers = rows.filter((row) => row.classList.contains('row-filler'));
    const message = rows.length === 1 && rows[0].cells.length === 1 && rows[0].cells[0].colSpan > 1 &&
        !rows[0].classList.contains('row-filler') ? rows[0] : null;

    setRowHeights(fillers, () => '');
    if (message) setRowHeights([message], () => '');
    const spacer = table.nextElementSibling;
    if (spacer && spacer.classList.contains('table-spacer')) spacer.remove();

    // a closed tab has no size to read; it is held once it opens
    if (!table.getClientRects().length || tablesStacked()) return;

    const records = rows.filter((row) => !row.classList.contains('row-filler') && !message);
    if (records.length > 0) {
        let sum = 0;
        records.forEach((row) => { sum += row.getBoundingClientRect().height; });
        held.rowHeight = sum / records.length;
    }

    if (fillers.length > 0) {
        const height = Math.min(held.rowHeight, FILLER_ROW_HEIGHT);
        setRowHeights(fillers, () => height);
        const drawn = fillers[0].getBoundingClientRect().height;
        if (Math.abs(drawn - height) >= 0.5) {
            setRowHeights(fillers, () => Math.max(0, 2 * height - drawn));
        }
    }

    // a grid-N box (general-ui.css) is the least a table fills; read while
    // the stylesheet alone sets it, before holdBoxHeight below adds its own
    const holder = table.parentElement;
    if (held.floor === undefined || holder.style.minHeight === '') {
        held.floor = holder.classList.contains('table-responsive')
            ? parseFloat(getComputedStyle(holder).minHeight) || 0 : 0;
    }

    held.tallest = Math.max(held.tallest, table.getBoundingClientRect().height, held.floor);

    const gap = held.tallest - table.getBoundingClientRect().height;
    if (gap >= 0.5) {
        if (message) stretchRows(table, [message], held.tallest);
        else if (fillers.length > 0) stretchRows(table, fillers, held.tallest);
        else {
            // a full page of short rows after a page of wrapped ones; a block
            // rather than a margin, which would fold into the pager's own
            const room = document.createElement('div');
            room.className = 'table-spacer';
            room.setAttribute('aria-hidden', 'true');
            room.style.height = gap + 'px';
            table.after(room);
        }
    }

    // a table too wide for its box brings a sideways scrollbar with its rows
    // and loses it with a one-line message; the box keeps that room too
    if (holder.classList.contains('table-responsive')) holdBoxHeight(holder);
}

// The same for a box whose contents are not one table (the till's catalog,
// which swaps its table for a message): it never gets shorter.
function holdBoxHeight(box) {
    if (!box) return;
    const held = heldRecord(heldBoxes, box);

    if (!box.getClientRects().length) return;
    if (tablesStacked()) { box.style.minHeight = ''; return; }

    held.tallest = Math.max(held.tallest, box.getBoundingClientRect().height);
    box.style.minHeight = held.tallest + 'px';
}
