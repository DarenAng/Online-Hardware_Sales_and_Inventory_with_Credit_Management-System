const DATA_PANEL_ROWS_PER_PAGE = 10;

const DATA_PANEL_PAGES_MEASURED = 20;

const dataPanels = {};

function createDataPanel(config) {
    const panel = {
        key: config.key,
        config: config,
        pageSize: config.pageSize || DATA_PANEL_ROWS_PER_PAGE,
        state: 'closed',
        rows: [],
        visible: [],
        page: 1,
        query: '',
        filters: Object.assign({}, config.filters || {}),
        headerSort: null
    };

    Object.assign(panel, dataPanelMethods);
    dataPanels[config.key] = panel;

    if (config.sortKeys === undefined || config.sortKeys === null) {
        config.autoSortKeys = true;
    }

    panel.renderClosed();
    if (config.sortKeys || config.autoSortKeys) wireHeaderSort(panel);
    return panel;
}

function wireHeaderSort(panel) {
    const table = document.getElementById(panel.config.tableId);
    const head = table ? table.querySelector('thead') : null;
    if (!head || head.dataset.sortWired) return;
    head.dataset.sortWired = '1';

    head.addEventListener('click', function (event) {
        const th = event.target.closest('th');
        if (!th || !head.contains(th)) return;
        const column = Array.prototype.indexOf.call(th.parentElement.children, th);
        panel.sortByColumn(column);
    });
    head.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const th = event.target.closest('th');
        if (!th) return;
        event.preventDefault();
        th.click();
    });
    markSortableHeaders(panel);
}

function markSortableHeaders(panel) {
    const table = document.getElementById(panel.config.tableId);
    if (panel.config.autoSortKeys && table) panel.config.sortKeys = autoSortKeys(panel, table);
    const keys = panel.config.sortKeys;
    if (!keys || !table) return;

    const heads = table.querySelectorAll('thead th');
    for (let i = 0; i < heads.length; i++) {
        const th = heads[i];
        const sortable = Boolean(keys[i]);
        th.classList.toggle('th-sortable', sortable);
        if (!sortable) {
            th.removeAttribute('aria-sort');
            th.removeAttribute('tabindex');
            continue;
        }
        th.tabIndex = 0;
        th.title = 'Sort by ' + th.textContent.trim();
        let state = 'none';
        if (panel.headerSort && panel.headerSort.column === i) {
            state = panel.headerSort.descending ? 'descending' : 'ascending';
        }
        th.setAttribute('aria-sort', state);
    }
}

function autoSortKeys(panel, table) {
    const heads = table.querySelectorAll('thead th');
    const keys = [];
    for (let i = 0; i < heads.length; i++) {
        const th = heads[i];
        const label = th.textContent.trim();
        if (label === '' || /^actions?$/i.test(label) || th.classList.contains('no-sort') ||
            th.querySelector('input, button, select')) {
            keys.push(null);
        } else {
            keys.push(autoSortKey(panel, i));
        }
    }
    return keys;
}

function autoSortKey(panel, column) {
    return function (row) {
        const cells = autoSortCells(panel, row);
        return column < cells.length ? cells[column] : '';
    };
}

let autoSortTemplate = null;

function autoSortCells(panel, row) {
    if (!panel.autoSortCache) panel.autoSortCache = new WeakMap();
    const cache = panel.autoSortCache;
    const isObject = row !== null && typeof row === 'object';
    if (isObject && cache.has(row)) return cache.get(row);

    if (!autoSortTemplate) autoSortTemplate = document.createElement('template');
    let html = '';
    try {
        html = panel.config.renderRow(row, 0) || '';
    } catch (error) {
        html = '';
    }
    autoSortTemplate.innerHTML = html;
    const tr = autoSortTemplate.content.querySelector('tr');
    const values = [];
    if (tr) {
        for (let i = 0; i < tr.children.length; i++) {
            values.push(autoSortValue(tr.children[i].textContent));
        }
    }
    autoSortTemplate.innerHTML = '';
    if (isObject) cache.set(row, values);
    return values;
}

function autoSortValue(text) {
    const shown = String(text || '').replace(/\s+/g, ' ').trim();
    if (shown === '' || /^(-|\u2014|\u2013|none|n\/a|not set)$/i.test(shown)) return '';

    const plain = shown.replace(/[\u20B1$,]/g, '').replace(/^PHP\s*/i, '');
    const number = plain.match(/^(-?\d+(?:\.\d+)?)\s*(%|[a-z.]+(?: [a-z.]+)?)?$/i);
    if (number) return Number(number[1]);

    const datePart = shown.split('\u00B7')[0].trim();
    if (/\b\d{4}\b/.test(datePart) &&
        (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(datePart) ||
         /^\d{4}-\d{2}-\d{2}/.test(datePart))) {
        const time = Date.parse(datePart);
        if (!isNaN(time)) return time;
    }
    return shown.toLowerCase();
}

function headerSortValue(key, row) {
    if (typeof key === 'function') return key(row);
    return row[key];
}

function compareSortValues(a, b) {
    const aEmpty = a === null || a === undefined || a === '';
    const bEmpty = b === null || b === undefined || b === '';
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : (aEmpty ? 1 : -1);

    const aNumber = typeof a === 'number' || (typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a.trim()));
    const bNumber = typeof b === 'number' || (typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b.trim()));
    if (aNumber && bNumber) return Number(a) - Number(b);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function getDataPanel(key) {
    return dataPanels[key] || null;
}

const dataPanelMethods = {
    body: function () {
        const table = document.getElementById(this.config.tableId);
        return table ? table.querySelector('tbody') : null;
    },

    pager: function () {
        return this.config.pagerId ? document.getElementById(this.config.pagerId) : null;
    },

    renderClosed: function () {
        const tbody = this.body();
        if (!tbody) return;

        this.state = 'closed';
        this.rows = [];
        this.visible = [];
        this.page = 1;

        const gate = this.config.gate || {};
        this.setCount(gate.pill || 'Not loaded');
        this.clearPager();

        tbody.innerHTML =
            '<tr><td colspan="' + this.config.columns + '">' +
            '<div class="empty-state">' +
                '<div class="empty-mark">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" ' +
                         'stroke-linecap="round" stroke-linejoin="round">' +
                        '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"></path>' +
                        '<path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"></path>' +
                        '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>' +
                    '</svg>' +
                '</div>' +
                '<h4>' + escapeHtml(gate.title || 'Nothing loaded yet') + '</h4>' +
                '<p>' + (gate.text || 'Search above, or press the button to read this from the database.') + '</p>' +
                (gate.button === false ? '' :
                '<button type="button" class="btn btn-accent" ' +
                        'onclick="dataPanelOpen(\'' + this.key + '\')">' +
                    escapeHtml(gate.button || 'Load Data') +
                '</button>') +
            '</div></td></tr>';

        this.announce();
    },

    renderLoading: function () {
        const tbody = this.body();
        if (!tbody) return;

        this.state = 'loading';
        this.setCount('Loading');
        this.clearPager();
        tbody.innerHTML = '<tr><td colspan="' + this.config.columns +
            '" class="table-empty">Reading the database...</td></tr>';

        this.announce();
    },

    renderError: function (message) {
        const tbody = this.body();
        if (!tbody) return;

        this.state = 'error';
        this.setCount('Offline');
        this.clearPager();
        tbody.innerHTML =
            '<tr><td colspan="' + this.config.columns + '">' +
            '<div class="empty-state">' +
                '<div class="empty-mark empty-mark-bad">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" ' +
                         'stroke-linecap="round" stroke-linejoin="round">' +
                        '<path d="M12 8v5"></path><path d="M12 16.5v.5"></path>' +
                        '<circle cx="12" cy="12" r="9"></circle>' +
                    '</svg>' +
                '</div>' +
                '<h4>That did not load</h4>' +
                '<p>' + escapeHtml(message || 'The server did not answer. Check that it is still running.') + '</p>' +
                '<button type="button" class="btn btn-accent" ' +
                        'onclick="dataPanelOpen(\'' + this.key + '\')">Try again</button>' +
            '</div></td></tr>';

        this.announce();
    },

    renderNoMatches: function () {
        const tbody = this.body();
        if (!tbody) return;

        this.setCount('0 results');
        this.clearPager();

        let narrowed = false;
        for (const name in this.filters) {
            if (this.filters[name] !== undefined && this.filters[name] !== '' &&
                this.filters[name] !== 'all' && this.filters[name] !== (this.config.filters || {})[name]) {
                narrowed = true;
                break;
            }
        }

        if (!this.query && !narrowed) {
            const empty = this.config.empty || {};
            const tbodyEmpty = this.body();
            tbodyEmpty.innerHTML =
                '<tr><td colspan="' + this.config.columns + '">' +
                '<div class="empty-state">' +
                    '<div class="empty-mark">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" ' +
                             'stroke-linecap="round" stroke-linejoin="round">' +
                            '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"></path>' +
                            '<path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"></path>' +
                        '</svg>' +
                    '</div>' +
                    '<h4>' + escapeHtml(empty.title || 'Nothing here yet') + '</h4>' +
                    '<p>' + (empty.text || 'The database has nothing to show for this table.') + '</p>' +
                '</div></td></tr>';
            this.announce();
            return;
        }

        let what;
        if (this.query) {
            what = 'Nothing matches <kbd>' + escapeHtml(this.query) + '</kbd>.';
        } else {
            what = 'Nothing here matches the filters you picked.';
        }

        tbody.innerHTML =
            '<tr><td colspan="' + this.config.columns + '">' +
            '<div class="empty-state">' +
                '<div class="empty-mark">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" ' +
                         'stroke-linecap="round" stroke-linejoin="round">' +
                        '<circle cx="11" cy="11" r="7"></circle>' +
                        '<path d="M20 20l-4.2-4.2"></path><path d="M8.5 11h5"></path>' +
                    '</svg>' +
                '</div>' +
                '<h4>No match found</h4>' +
                '<p>' + what + ' Check the spelling, or widen the filters.</p>' +
            '</div></td></tr>';

        this.announce();
    },

    basePageSize: function () {
        return this.config.pageSize || DATA_PANEL_ROWS_PER_PAGE;
    },

    announce: function () {
        if (typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('datapanel:change', {
                detail: { key: this.key, state: this.state, rows: this.visible.length }
            }));
        }

        if (this.pageSize === this.basePageSize()) {
            holdTableHeight(document.getElementById(this.config.tableId));
        }

        if (this.state === 'ready') this.remember();
    },

    open: async function () {
        if (this.state === 'loading') {
            this.reloadWanted = true;
            return;
        }

        this.loadTicket = (this.loadTicket || 0) + 1;
        const ticket = this.loadTicket;
        this.failedStatus = 0;

        this.renderLoading();

        try {
            const rows = await this.config.load();

            if (ticket !== this.loadTicket) return;

            this.rows = Array.isArray(rows) ? rows : [];
            this.state = 'ready';
            this.page = 1;
            this.apply();
            this.measurePages();

            if (typeof this.config.onLoaded === 'function') {
                this.config.onLoaded(this.rows, this);
            }
        } catch (error) {
            if (ticket !== this.loadTicket) return;
            this.failedStatus = (error && error.status) || 0;
            this.renderError(error && error.handled ? error.message : null);
        } finally {
            if (ticket === this.loadTicket && this.reloadWanted) {
                this.reloadWanted = false;
                await this.open();
            }
        }
    },

    refresh: async function () {
        if (this.state === 'closed') return;
        const page = this.page;
        await this.open();
        this.goTo(page);
    },

    reset: function () {
        this.query = '';
        this.filters = Object.assign({}, this.config.filters || {});
        this.forget();
        this.renderClosed();
    },

    searchBox: function () {
        return document.querySelector('[oninput*="dataPanelSearchInput(\'' + this.key + '\'"]');
    },

    remember: function () {
        if (this.config.remember === false) return;

        const box = this.searchBox();
        const inputs = {};
        const inputIds = this.config.inputs || [];
        for (let i = 0; i < inputIds.length; i++) {
            const field = document.getElementById(inputIds[i]);
            if (field) inputs[inputIds[i]] = field.value;
        }

        const all = readLoadedPanels();
        const page = thisPageName();
        if (!all[page]) all[page] = {};
        all[page][this.key] = {
            text: box ? box.value : this.query,
            filters: this.filters,
            inputs: inputs
        };
        writeLoadedPanels(all);
    },

    forget: function () {
        const all = readLoadedPanels();
        const page = thisPageName();
        if (!all[page]) return;
        delete all[page][this.key];
        writeLoadedPanels(all);
    },

    prepare: function (saved) {
        this.query = searchText(saved.text);
        Object.assign(this.filters, saved.filters || {});

        const box = this.searchBox();
        if (box) box.value = saved.text || '';

        this.putBoxesBack(saved, false);
    },

    finish: function (saved) {
        this.putBoxesBack(saved, true);
        if (this.state === 'ready') this.apply();
    },

    putBoxesBack: function (saved, loaded) {
        const filters = saved.filters || {};

        for (const name in filters) {
            const select = document.querySelector(
                '[onchange*="dataPanelFilter(\'' + this.key + '\', \'' + name + '\'"]');
            if (!select) continue;

            const done = setBoxValue(select, filters[name]);
            if (loaded && !done) {
                const first = (this.config.filters || {})[name];
                this.filters[name] = first === undefined ? 'all' : first;
            }
            if (select.dataset && select.dataset.filterTable && typeof syncFilteredColumns === 'function') {
                syncFilteredColumns(select.dataset.filterTable);
            }
        }

        const inputs = saved.inputs || {};
        for (const id in inputs) {
            setBoxValue(document.getElementById(id), inputs[id]);
        }
    },

    search: async function (text) {
        this.query = searchText(text);

        if (this.state === 'loading') return;

        if (this.state === 'closed' || this.state === 'error') {
            if (this.query === '') return;
            if (this.config.loadOnSearch === false) return;
            await this.open();
            return;
        }

        this.page = 1;
        this.apply();
    },

    setFilter: function (name, value) {
        this.filters[name] = value;
        this.page = 1;
        if (this.state === 'ready') this.apply();
    },

    apply: function () {
        const query = this.query.toLowerCase();
        const match = this.config.match;
        const filter = this.config.filter;

        this.visible = [];
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            if (filter && !filter(row, this.filters)) continue;
            if (query === '' || !match || match(row, query)) this.visible.push(row);
        }

        if (this.headerSort && this.config.sortKeys) {
            const key = this.config.sortKeys[this.headerSort.column];
            const descending = this.headerSort.descending;
            if (key) {
                this.autoSortCache = new WeakMap();
                const indexed = [];
                for (let i = 0; i < this.visible.length; i++) {
                    indexed.push({ row: this.visible[i], value: headerSortValue(key, this.visible[i]), at: i });
                }
                indexed.sort(function (x, y) {
                    const xEmpty = x.value === null || x.value === undefined || x.value === '';
                    const yEmpty = y.value === null || y.value === undefined || y.value === '';
                    if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
                    const result = compareSortValues(x.value, y.value);
                    return (descending ? -result : result) || x.at - y.at;
                });
                this.visible = [];
                for (let i = 0; i < indexed.length; i++) this.visible.push(indexed[i].row);
            }
        }

        const headerSorted = this.headerSort && this.config.autoSortKeys;
        if (typeof this.config.sort === 'function' && !headerSorted) {
            const sorted = this.config.sort(this.visible.slice(), this.filters);
            if (Array.isArray(sorted)) this.visible = sorted;
        }

        const pages = Math.max(1, Math.ceil(this.visible.length / this.pageSize));
        if (this.page > pages) this.page = pages;

        this.render();
    },

    sortByColumn: function (column) {
        const keys = this.config.sortKeys;
        if (!keys || !keys[column]) return;
        if (this.headerSort && this.headerSort.column === column) {
            this.headerSort.descending = !this.headerSort.descending;
        } else {
            this.headerSort = { column: column, descending: false };
        }
        markSortableHeaders(this);
        if (this.state === 'ready') {
            this.page = 1;
            this.apply();
        }
    },

    resetHeaderSort: function () {
        this.headerSort = null;
        markSortableHeaders(this);
    },

    render: function () {
        const tbody = this.body();
        if (!tbody) return;

        if (this.visible.length === 0) {
            this.renderNoMatches();
            return;
        }

        this.drawRows(this.page);

        this.setCount(this.visible.length +
            (this.visible.length === 1 ? ' record' : ' records'));

        this.renderPager();
        this.announce();
    },

    drawRows: function (page) {
        const start = (page - 1) * this.pageSize;
        const slice = this.visible.slice(start, start + this.pageSize);

        let html = '';
        for (let index = 0; index < slice.length; index++) {
            html += this.config.renderRow(slice[index], start + index);
        }
        if (this.pageSize === this.basePageSize() && slice.length < this.pageSize) {
            html += fillerRows(this.pageSize - slice.length, this.config.columns);
        }
        this.body().innerHTML = html;
        return slice;
    },

    measurePages: function () {
        const table = document.getElementById(this.config.tableId);
        if (!table || !table.getClientRects().length || this.pageSize !== this.basePageSize()) return;

        const pages = Math.min(Math.ceil(this.visible.length / this.pageSize), DATA_PANEL_PAGES_MEASURED);
        if (pages < 2) return;

        for (let page = 1; page <= pages; page += 1) {
            if (page === this.page) continue;
            this.drawRows(page);
            holdTableHeight(table);
        }
        this.drawRows(this.page);
        holdTableHeight(table);
    },

    renderPager: function () {
        const mount = this.pager();
        if (!mount) return;

        const total = this.visible.length;
        const pages = Math.max(1, Math.ceil(total / this.pageSize));

        if (pages === 1) {
            this.clearPager();
            return;
        }

        mount.classList.remove('is-single');
        mount.innerHTML =
            '<div class="pager-controls">' +
                '<button type="button" class="btn btn-sm" ' +
                        'onclick="dataPanelPrev(\'' + this.key + '\')"' +
                        (this.page === 1 ? ' disabled' : '') + '>Previous</button>' +
                '<span class="pager-page">Page ' + this.page + ' of ' + pages + '</span>' +
                '<button type="button" class="btn btn-sm" ' +
                        'onclick="dataPanelNext(\'' + this.key + '\')"' +
                        (this.page === pages ? ' disabled' : '') + '>Next</button>' +
            '</div>';
    },

    clearPager: function () {
        const mount = this.pager();
        if (mount) {
            mount.innerHTML = '';
            mount.classList.add('is-single');
        }
    },

    setCount: function (text) {
        if (!this.config.countPillId) return;
        const pill = document.getElementById(this.config.countPillId);
        if (pill) pill.textContent = text;
    },

    goTo: function (page) {
        const pages = Math.max(1, Math.ceil(this.visible.length / this.pageSize));
        this.page = Math.min(Math.max(1, page), pages);
        this.render();

        const table = document.getElementById(this.config.tableId);
        if (table && typeof table.scrollIntoView === 'function') {
            const box = table.getBoundingClientRect();
            if (box.top < 0) table.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    },

    next: function () {
        this.goTo(this.page + 1);
    },

    prev: function () {
        this.goTo(this.page - 1);
    },

    find: function (id, idField) {
        const key = idField || this.config.idField || 'id';
        for (let i = 0; i < this.rows.length; i++) {
            if (String(this.rows[i][key]) === String(id)) return this.rows[i];
        }
        return null;
    }
};

function thisPageName() {
    return window.location.pathname.split('/').pop().toLowerCase();
}

function readLoadedPanels() {
    try {
        const all = JSON.parse(sessionStorage.getItem(LOADED_PANELS_KEY) || '{}');
        if (all && typeof all === 'object') return all;
    } catch (error) {  }
    return {};
}

function writeLoadedPanels(all) {
    try {
        sessionStorage.setItem(LOADED_PANELS_KEY, JSON.stringify(all));
    } catch (error) {  }
}

function setBoxValue(box, value) {
    if (!box) return false;

    if (box.tagName === 'SELECT') {
        let found = false;
        for (let i = 0; i < box.options.length; i++) {
            if (box.options[i].value === String(value)) {
                found = true;
                break;
            }
        }
        if (!found) return false;
    }
    box.value = value;
    return true;
}

function screenIsHidden(panel) {
    const table = document.getElementById(panel.config.tableId);
    const screen = table ? table.closest('[data-panel]') : null;
    if (!screen) return false;

    const view = table.closest('.panel-view');
    const tab = view ? screen.querySelector('[data-view-tab="' + view.id + '"]') : null;
    if (tab && tab.hidden) return true;

    const link = document.querySelector('.sidebar-nav a[data-panel-link="' +
        (screen.getAttribute('data-panel-of') || screen.id) + '"]');
    if (!link) return false;

    const item = link.closest('li');
    const heading = item && item.parentElement ? item.parentElement.closest('li') : null;
    return Boolean((item && item.hidden) || (heading && heading.hidden));
}

let panelsRestored = false;

function tableIsShown(panel) {
    const table = document.getElementById(panel.config.tableId);
    return Boolean(table) && table.getClientRects().length > 0;
}

function openShownPanels() {
    if (!panelsRestored) return;
    for (const key in dataPanels) {
        const panel = dataPanels[key];
        if (panel.state !== 'closed' || panel.config.autoLoad === false) continue;
        if (tableIsShown(panel)) panel.open();
    }
}

async function restoreLoadedPanels() {
    if (typeof getCurrentUser !== 'function' || !getCurrentUser()) return;

    const saved = readLoadedPanels()[thisPageName()] || {};
    const panels = [];

    for (const key in saved) {
        const panel = getDataPanel(key);
        if (!panel || panel.config.remember === false) continue;

        if (screenIsHidden(panel)) {
            panel.forget();
            continue;
        }
        panel.prepare(saved[key]);
        panels.push(panel);
    }

    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        if (panel.state !== 'closed') continue;

        await panel.open();

        if (panel.state === 'error' && (panel.failedStatus === 401 || panel.failedStatus === 403)) {
            panel.forget();
        } else {
            panel.finish(saved[panel.key]);
        }
    }

    panelsRestored = true;
    openShownPanels();
}

document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
        setTimeout(restoreLoadedPanels, 0);
    }, 0);
});

function dataPanelOpen(key) {
    const p = getDataPanel(key);
    if (p) p.open();
}

function dataPanelNext(key) {
    const p = getDataPanel(key);
    if (p) p.next();
}

function dataPanelPrev(key) {
    const p = getDataPanel(key);
    if (p) p.prev();
}

const SEARCH_TYPING_DELAY_MS = 220;
const searchTimers = {};

function dataPanelSearchInput(key, event) {
    const box = event && event.target;
    if (!box) return;

    clearTimeout(searchTimers[key]);
    searchTimers[key] = setTimeout(function () {
        delete searchTimers[key];
        dataPanelSearch(key, box.value);
    }, SEARCH_TYPING_DELAY_MS);
}

function dataPanelSearchKey(key, event) {
    if (!event) return;

    if (event.key === 'Escape' && event.target && event.target.value !== '') {
        event.target.value = '';
        event.preventDefault();
        clearTimeout(searchTimers[key]);
        dataPanelSearch(key, '');
        return;
    }

    if (event.key !== 'Enter') return;

    event.preventDefault();
    clearTimeout(searchTimers[key]);
    dataPanelSearch(key, event.target ? event.target.value : '');
}

function dataPanelSearch(key, text) {
    const panel = getDataPanel(key);
    if (panel) panel.search(text);
}

function searchText(text) {
    return String(text || '').trim().toLowerCase();
}

function startsAWord(value, query) {
    if (value === null || value === undefined) return false;
    const text = String(value).trim().toLowerCase();

    let at = text.indexOf(query);
    while (at !== -1) {
        if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true;
        at = text.indexOf(query, at + 1);
    }
    return false;
}

function prefixMatch(fields, query) {
    if (!query) return true;
    for (let i = 0; i < fields.length; i++) {
        if (startsAWord(fields[i], query)) return true;
    }
    return false;
}

function dataPanelFilter(key, name, value) {
    const panel = getDataPanel(key);
    if (!panel) return;

    if (panel.state === 'closed' || panel.state === 'error') {
        panel.filters[name] = value;
        if (panel.config.loadOnFilter !== false) panel.open();
        return;
    }

    panel.setFilter(name, value);
}
