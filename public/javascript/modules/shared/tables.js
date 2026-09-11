// tables.js  --  TABLES
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// COLUMN ALIGNMENT
//
// A table's headings used to be left aligned while its figures were right
// aligned, in every module, so the heading never sat over its own column.
// Rather than tag hundreds of header cells by hand, each header takes its
// alignment from the row underneath it. Tables are filled in by script, so
// this runs again whenever a table body changes.
// ==========================================
function alignTableColumns(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headerCells = table.tHead.rows[0].cells;
    const bodyRows = table.tBodies[0].rows;

    // a "Loading..." or "no records" row spans the table and says nothing
    // about the columns, so it is skipped
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

// ==========================================
// A FILTERED COLUMN IS A COLUMN THAT SAYS THE SAME THING ON EVERY ROW
//
// Pick "Cashier" in the role filter and every row that is left says Cashier
// in the Role column. That column is now telling the reader what they just
// told it, and it is taking the width that a column with something to say
// could have used. So a module can name the columns its filters have made
// redundant and they are taken off the grid until the filter is cleared.
//
// The list lives on the <table> as data-hidden-columns, 1-based, and is
// applied here on every redraw, because the panels rebuild their rows on
// every page turn and a class put on a cell by hand would be gone by the
// next one. A message row -- "Loading...", "No match found" -- spans the
// table and is left alone.
// ==========================================
function setHiddenColumns(table, indexes) {
    if (!table) return;

    const list = (indexes || [])
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index > 0);

    if (list.length === 0) delete table.dataset.hiddenColumns;
    else table.dataset.hiddenColumns = list.join(',');

    hideFilteredColumns(table);
}

function hideFilteredColumns(table) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;

    const hidden = String(table.dataset.hiddenColumns || '')
        .split(',')
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index > 0);

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

// ==========================================
// COLUMN NAMES ON A PHONE
//
// A table with six columns cannot be a table on a 380px screen. Below that
// width the stylesheet turns each row into a small card, and a figure with no
// name beside it means nothing, so every body cell is stamped with its own
// column heading and the card prints it in the margin.
//
// The stamping happens here, once, for the same reason the alignment does: the
// thirty-odd functions that fill these tables should not each have to remember
// to do it, and a table that changes is re-stamped by the observer below.
// ==========================================
function labelTableCells(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headers = Array.from(table.tHead.rows[0].cells).map((cell) => cell.textContent.trim());

    for (const row of table.tBodies[0].rows) {
        // a "Loading..." or "no records" row spans the whole table and has no
        // column of its own to be named after
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
        for (const record of records) {
            const table = record.target.closest ? record.target.closest('table') : null;
            if (table && !seen.has(table)) {
                seen.add(table);
                alignTableColumns(table);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
}
