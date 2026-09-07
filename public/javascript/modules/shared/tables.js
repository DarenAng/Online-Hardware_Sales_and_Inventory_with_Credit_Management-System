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
