function alignTableColumns(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headerCells = table.tHead.rows[0].cells;
    const bodyRows = table.tBodies[0].rows;

    let sample = null;
    for (let i = 0; i < bodyRows.length; i++) {
        if (bodyRows[i].cells.length === headerCells.length) {
            sample = bodyRows[i];
            break;
        }
    }

    for (let index = 0; index < headerCells.length; index += 1) {
        const header = headerCells[index];
        header.classList.remove('col-num', 'col-id');

        if (!sample) continue;
        const cell = sample.cells[index];
        if (!cell) continue;

        if (cell.classList.contains('cell-num')) header.classList.add('col-num');
        else if (cell.classList.contains('cell-id')) header.classList.add('col-id');
    }

    labelTableCells(table);
    hideFilteredColumns(table);
}

function columnNumbers(values) {
    const list = [];
    for (let i = 0; i < values.length; i++) {
        const number = Number(values[i]);
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

    function mark(cell, index) {
        cell.classList.toggle('col-hidden', hidden.indexOf(index + 1) !== -1);
    }

    for (let i = 0; i < headerCells.length; i++) {
        mark(headerCells[i], i);
    }

    for (let b = 0; b < table.tBodies.length; b++) {
        const bodyRows = table.tBodies[b].rows;
        for (let r = 0; r < bodyRows.length; r++) {
            const row = bodyRows[r];
            if (row.cells.length !== columns) continue;
            for (let c = 0; c < row.cells.length; c++) {
                mark(row.cells[c], c);
            }
        }
    }
}

function labelTableCells(table) {
    if (!table || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;

    const headerCells = table.tHead.rows[0].cells;
    const headers = [];
    for (let i = 0; i < headerCells.length; i++) {
        headers.push(headerCells[i].textContent.trim());
    }

    const bodyRows = table.tBodies[0].rows;
    for (let r = 0; r < bodyRows.length; r++) {
        const row = bodyRows[r];
        if (row.cells.length !== headers.length) continue;

        for (let index = 0; index < row.cells.length; index += 1) {
            row.cells[index].setAttribute('data-column', headers[index]);
        }
    }
}

function alignAllTables(root) {
    const tables = (root || document).querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) {
        alignTableColumns(tables[i]);
    }
}

function watchTablesForAlignment() {
    alignAllTables();

    const observer = new MutationObserver(function (records) {
        const seen = [];

        function note(table) {
            if (table && seen.indexOf(table) === -1) {
                seen.push(table);
                alignTableColumns(table);
            }
        }

        for (let r = 0; r < records.length; r++) {
            const record = records[r];
            note(record.target.closest ? record.target.closest('table') : null);

            for (let n = 0; n < record.addedNodes.length; n++) {
                const node = record.addedNodes[n];
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'TABLE') {
                    note(node);
                } else if (node.querySelectorAll) {
                    const inside = node.querySelectorAll('table');
                    for (let t = 0; t < inside.length; t++) {
                        note(inside[t]);
                    }
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

function syncFilteredColumns(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const hidden = [];
    const selects = document.querySelectorAll('select[data-filter-table="' + tableId + '"]');
    for (let i = 0; i < selects.length; i++) {
        const select = selects[i];
        const keeps = String(select.dataset.keepsColumnFor || '').split('|');
        if (select.value !== 'all' && keeps.indexOf(select.value) === -1) {
            hidden.push(Number(select.dataset.hidesColumn));
        }
        const also = String(select.dataset.alsoHides || '').split('|');
        for (let a = 0; a < also.length; a++) {
            const parts = also[a].split(':');
            if (parts.length !== 2 || parts[0] !== select.value) continue;
            const columns = parts[1].split(',');
            for (let c = 0; c < columns.length; c++) hidden.push(Number(columns[c]));
        }
    }
    setHiddenColumns(table, hidden);
}

document.addEventListener('change', function (event) {
    const target = event.target;
    if (target && target.matches && target.matches('select[data-filter-table]')) {
        syncFilteredColumns(target.dataset.filterTable);
    }
});

document.addEventListener('DOMContentLoaded', function () {
    const tables = [];
    const selects = document.querySelectorAll('select[data-filter-table]');
    for (let i = 0; i < selects.length; i++) {
        if (tables.indexOf(selects[i].dataset.filterTable) === -1) {
            tables.push(selects[i].dataset.filterTable);
        }
    }
    for (let i = 0; i < tables.length; i++) {
        syncFilteredColumns(tables[i]);
    }
});

const FILLER_ROW_HEIGHT = 52.3;
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

function heldRecord(holder, property) {
    let held = holder[property];
    if (!held) {
        held = { tallest: 0, rowHeight: FILLER_ROW_HEIGHT, width: -1, table: null };
        holder[property] = held;
        watchHeldWidth(holder);
    }
    return held;
}

function watchHeldWidth(holder) {
    if (typeof ResizeObserver !== 'function') return;
    if (!heldWatch) {
        heldWatch = new ResizeObserver(function (entries) {
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const target = entry.target;
                if (!target.isConnected) { heldWatch.unobserve(target); continue; }
                const width = Math.round(entry.contentRect.width);

                const box = target._heldBox;
                if (box && box.width !== width) {
                    box.width = width;
                    box.tallest = 0;
                    target.style.minHeight = '';
                }

                const held = target._heldTable;
                if (held && held.width !== width) {
                    held.width = width;
                    held.tallest = 0;
                    if (held.table && held.table.parentElement === target) holdTableHeight(held.table);
                }

                if (box) holdBoxHeight(target);
            }
        });
    }
    heldWatch.observe(holder);
}

function setRowHeights(rows, heightOf) {
    const heights = [];
    for (let i = 0; i < rows.length; i++) {
        heights.push(heightOf(rows[i]));
    }
    for (let i = 0; i < rows.length; i++) {
        rows[i].style.height = heights[i] === '' ? '' : heights[i] + 'px';
    }
}

function stretchRows(table, rows, target) {
    for (let pass = 0; pass < 2; pass += 1) {
        const gap = target - table.getBoundingClientRect().height;
        if (Math.abs(gap) < 0.5) return;
        const share = gap / rows.length;
        setRowHeights(rows, function (row) {
            return Math.max(0, row.getBoundingClientRect().height + share);
        });
    }
}

function holdTableHeight(table) {
    if (!table || !table.tBodies.length || !table.parentElement) return;

    const held = heldRecord(table.parentElement, '_heldTable');
    held.table = table;

    alignTableColumns(table);

    const body = table.tBodies[0];
    const rows = [];
    for (let i = 0; i < body.rows.length; i++) {
        rows.push(body.rows[i]);
    }
    const fillers = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].classList.contains('row-filler')) fillers.push(rows[i]);
    }
    const message = rows.length === 1 && rows[0].cells.length === 1 && rows[0].cells[0].colSpan > 1 &&
        !rows[0].classList.contains('row-filler') ? rows[0] : null;

    setRowHeights(fillers, function () { return ''; });
    if (message) setRowHeights([message], function () { return ''; });
    const spacer = table.nextElementSibling;
    if (spacer && spacer.classList.contains('table-spacer')) spacer.remove();

    if (!table.getClientRects().length || tablesStacked()) return;

    const records = [];
    for (let i = 0; i < rows.length; i++) {
        if (!rows[i].classList.contains('row-filler') && !message) records.push(rows[i]);
    }
    if (records.length > 0) {
        let sum = 0;
        for (let i = 0; i < records.length; i++) {
            sum += records[i].getBoundingClientRect().height;
        }
        held.rowHeight = sum / records.length;
    }

    if (fillers.length > 0) {
        const height = Math.min(held.rowHeight, FILLER_ROW_HEIGHT);
        setRowHeights(fillers, function () { return height; });
        const drawn = fillers[0].getBoundingClientRect().height;
        if (Math.abs(drawn - height) >= 0.5) {
            setRowHeights(fillers, function () { return Math.max(0, 2 * height - drawn); });
        }
    }

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
            const room = document.createElement('div');
            room.className = 'table-spacer';
            room.setAttribute('aria-hidden', 'true');
            room.style.height = gap + 'px';
            table.after(room);
        }
    }

    if (holder.classList.contains('table-responsive')) holdBoxHeight(holder);
}

function holdBoxHeight(box) {
    if (!box) return;
    const held = heldRecord(box, '_heldBox');

    if (!box.getClientRects().length) return;
    if (tablesStacked()) { box.style.minHeight = ''; return; }

    held.tallest = Math.max(held.tallest, box.getBoundingClientRect().height);
    box.style.minHeight = held.tallest + 'px';
}
