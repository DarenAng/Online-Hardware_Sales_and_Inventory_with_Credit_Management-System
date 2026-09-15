// tables.js -- alignment, phone labels, hidden and secondary columns
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
    hideSecondaryColumns(table);
}

// A filtered column says the same thing on every row, so a module can name
// the columns its filters made redundant in data-hidden-columns (1-based).
// Applied on every redraw because panels rebuild their rows on each page.
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


// A heading marked <th data-secondary> is off the grid until asked for; the
// table gets a "Show N more columns" switch, remembered per table on this
// browser. Rows without a popup of their own unfold in place to show the
// hidden columns. Exports and prints still carry every column.
function secondaryColumnIndexes(table) {
    if (!table || !table.tHead || !table.tHead.rows.length) return [];
    return Array.from(table.tHead.rows[0].cells)
        .map((cell, index) => (cell.hasAttribute('data-secondary') ? index + 1 : 0))
        .filter(Boolean);
}

function columnsChoiceKey(table) {
    return table.id ? 'columns:' + table.id : null;
}

function tableIsCondensed(table) {
    if (secondaryColumnIndexes(table).length === 0) return false;
    if (table.dataset.columns) return table.dataset.columns !== 'all';
    let stored = null;
    try { stored = localStorage.getItem(columnsChoiceKey(table)); } catch (error) { /* private mode */ }
    table.dataset.columns = stored === 'all' ? 'all' : 'few';
    return table.dataset.columns !== 'all';
}

function toggleTableColumns(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;

    table.dataset.columns = tableIsCondensed(table) ? 'all' : 'few';
    try { localStorage.setItem(columnsChoiceKey(table), table.dataset.columns); } catch (error) { /* private mode */ }

    table.querySelectorAll('tr.row-details').forEach((row) => row.remove());
    table.querySelectorAll('tr.is-expanded').forEach((row) => row.classList.remove('is-expanded'));

    hideSecondaryColumns(table);
    syncColumnsSwitch(table);
}

function hideSecondaryColumns(table) {
    const secondary = secondaryColumnIndexes(table);
    if (secondary.length === 0) return;

    const condensed = tableIsCondensed(table);
    const headerCells = table.tHead.rows[0].cells;
    const columns = headerCells.length;

    const mark = (cell, index) => {
        cell.classList.toggle('col-secondary', condensed && secondary.indexOf(index + 1) !== -1);
    };

    Array.from(headerCells).forEach(mark);
    for (const body of table.tBodies) {
        for (const row of body.rows) {
            if (row.cells.length !== columns) continue;
            Array.from(row.cells).forEach(mark);
            row.classList.toggle('row-expandable', condensed && !row.classList.contains('row-clickable'));
        }
    }

    ensureColumnsSwitch(table);
    syncColumnsSwitch(table);
    wireRowExpansion(table);
}

// ---------- the switch above the table ----------
function ensureColumnsSwitch(table) {
    if (!table.id || table.dataset.columnsSwitch) return;
    table.dataset.columnsSwitch = 'yes';

    const wrap = table.closest('.table-responsive') || table;
    const bar = document.createElement('div');
    bar.className = 'columns-bar no-print';
    bar.innerHTML = '<button type="button" class="btn btn-sm btn-ghost columns-toggle" ' +
        'onclick="toggleTableColumns(\'' + table.id + '\')"></button>';
    wrap.insertAdjacentElement('beforebegin', bar);
    syncColumnsSwitch(table);
}

function syncColumnsSwitch(table) {
    const bar = table.closest('.table-responsive')
        ? table.closest('.table-responsive').previousElementSibling : table.previousElementSibling;
    const button = bar && bar.classList.contains('columns-bar') ? bar.querySelector('.columns-toggle') : null;
    if (!button) return;

    const columns = table.tHead.rows[0].cells.length;
    const hasRows = Array.from(table.tBodies).some((body) =>
        Array.from(body.rows).some((row) => row.cells.length === columns));
    bar.hidden = !hasRows;

    const count = secondaryColumnIndexes(table).length;
    const condensed = tableIsCondensed(table);
    button.textContent = condensed
        ? 'Show ' + count + ' more column' + (count === 1 ? '' : 's')
        : 'Fewer columns';
    button.title = condensed
        ? 'The table shows its main columns. Press to see every column; press a row to see its details.'
        : 'Press to go back to the main columns only.';
    button.setAttribute('aria-pressed', String(!condensed));
}

// ---------- a row that unfolds ----------
function wireRowExpansion(table) {
    if (table.dataset.expandWired) return;
    table.dataset.expandWired = 'yes';

    table.addEventListener('click', function (event) {
        const row = event.target.closest('tr');
        if (!row || !row.classList.contains('row-expandable') || row.closest('table') !== table) return;
        if (event.target.closest('button, a, input, select, textarea, label')) return;
        toggleRowDetails(table, row);
    });

    table.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('tr');
        if (!row || !row.classList.contains('row-expandable') || event.target !== row) return;
        event.preventDefault();
        toggleRowDetails(table, row);
    });
}

function toggleRowDetails(table, row) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('row-details')) {
        next.remove();
        row.classList.remove('is-expanded');
        row.setAttribute('aria-expanded', 'false');
        return;
    }

    const headers = Array.from(table.tHead.rows[0].cells);
    const lines = [];
    Array.from(row.cells).forEach((cell, index) => {
        const header = headers[index];
        if (!header || !header.hasAttribute('data-secondary')) return;
        const name = header.textContent.trim() || 'More';
        lines.push('<div class="row-details-item"><dt>' + escapeHtml(name) + '</dt><dd>' +
            cell.innerHTML + '</dd></div>');
    });

    const details = document.createElement('tr');
    details.className = 'row-details';
    details.innerHTML = '<td colspan="' + headers.length + '"><dl class="row-details-list">' +
        (lines.join('') || '<div class="row-details-item"><dd class="muted">Nothing more to show.</dd></div>') +
        '</dl></td>';

    row.insertAdjacentElement('afterend', details);
    row.classList.add('is-expanded');
    row.setAttribute('aria-expanded', 'true');
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
