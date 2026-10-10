// data-panel.js -- lazy data panels and pagination
// Loaded by: all five dashboards
//
// A table starts closed (search bar + Load Data button), loads on demand and
// pages ten rows at a time. Usage:
//
//   const panel = createDataPanel({
//       key: 'admin-users',            // unique, used by the inline handlers
//       tableId: 'accounts-table',
//       columns: 5,                    // colspan for message rows
//       pagerId: 'accounts-pager',
//       countPillId: 'accounts-count', // optional
//       load: async () => [...],       // returns every row, once
//       match: (row, query) => true,   // optional free-text search
//       filter: (row, filters) => true,// optional dropdown filters
//       sort: (rows, filters) => rows, // optional
//       renderRow: (row, index) => '<tr>...</tr>',
//       gate: { title, text, button },  // what the closed state says
//       empty: { title, text },        // optional; a loaded table with no rows
//       loadOnFilter: false,           // optional; see dataPanelFilter
//       pagerInfo: false,              // optional; leave out the "Showing 1-8 of 24" caption
//       inputs: ['sales-from'],        // optional; ids of other boxes that decide what load() reads
//       remember: false                // optional; do not load this table again after a reload
//   });
//   panel.open(); panel.reset(); panel.search('pedro');
//   panel.setFilter('status', 'inactive'); panel.refresh();
//
// Every state change fires a 'datapanel:change' event on the document with
// the key, so Print/Export buttons can follow the table.

const DATA_PANEL_ROWS_PER_PAGE = 10;

// pages drawn out of sight when the rows arrive, to find the tallest one
const DATA_PANEL_PAGES_MEASURED = 20;

// every panel on the page, by key, for the inline handlers
const dataPanels = new Map();

function createDataPanel(config) {
    const panel = {
        key: config.key,
        config: config,
        pageSize: config.pageSize || DATA_PANEL_ROWS_PER_PAGE,
        state: 'closed',      // closed | loading | ready | error
        rows: [],             // everything load() returned
        visible: [],          // what survives the search and the filters
        page: 1,
        query: '',
        filters: Object.assign({}, config.filters || {})
    };

    // copy the functions below (body, open, render, ...) onto this panel,
    // so we can call panel.open(), panel.render() and so on.
    // Inside those functions, "this" means the panel they were called on.
    Object.assign(panel, dataPanelMethods);
    dataPanels.set(config.key, panel);

    panel.renderClosed();
    return panel;
}

function getDataPanel(key) {
    return dataPanels.get(key) || null;
}

const dataPanelMethods = {
    body() {
        const table = document.getElementById(this.config.tableId);
        return table ? table.querySelector('tbody') : null;
    },

    pager() {
        return this.config.pagerId ? document.getElementById(this.config.pagerId) : null;
    },

    // ---------- states ----------
    renderClosed() {
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
                // button: false when the screen has one Load Data of its own above the tables
                (gate.button === false ? '' :
                '<button type="button" class="btn btn-accent" ' +
                        'onclick="dataPanelOpen(\'' + this.key + '\')">' +
                    escapeHtml(gate.button || 'Load Data') +
                '</button>') +
            '</div></td></tr>';

        this.announce();
    },

    renderLoading() {
        const tbody = this.body();
        if (!tbody) return;

        this.state = 'loading';
        this.setCount('Loading');
        this.clearPager();
        tbody.innerHTML = '<tr><td colspan="' + this.config.columns +
            '" class="table-empty">Reading the database...</td></tr>';

        this.announce();
    },

    renderError(message) {
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

    renderNoMatches() {
        const tbody = this.body();
        if (!tbody) return;

        this.setCount('0 results');
        this.clearPager();

        // no search and no filter narrowed it: the table is simply empty,
        // and telling the reader to widen filters they never set is wrong
        const narrowed = Object.keys(this.filters).some((name) =>
            this.filters[name] !== undefined && this.filters[name] !== '' &&
            this.filters[name] !== 'all' && this.filters[name] !== (this.config.filters || {})[name]);

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

    basePageSize() {
        return this.config.pageSize || DATA_PANEL_ROWS_PER_PAGE;
    },

    // every state ends here, so this is where the table is held at the
    // height of its fullest page, once the listeners have touched the rows
    announce() {
        if (typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('datapanel:change', {
                detail: { key: this.key, state: this.state, rows: this.visible.length }
            }));
        }

        if (this.pageSize === this.basePageSize()) {
            holdTableHeight(document.getElementById(this.config.tableId));
        }

        // a table that is showing rows is written down as loaded
        if (this.state === 'ready') this.remember();
    },

    // A load asked for during a load is remembered and run when the current one
    // lands, and every load carries a ticket so a late answer is thrown away
    // rather than drawn over newer rows.
    async open() {
        if (this.state === 'loading') {
            this.reloadWanted = true;   // whoever asked gets their answer below
            return;
        }

        this.loadTicket = (this.loadTicket || 0) + 1;
        const ticket = this.loadTicket;

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
            this.renderError(error && error.handled ? error.message : null);
        } finally {
            if (ticket === this.loadTicket && this.reloadWanted) {
                this.reloadWanted = false;
                await this.open();
            }
        }
    },

    async refresh() {
        if (this.state === 'closed') return;
        const page = this.page;
        await this.open();
        this.goTo(page);
    },

    // closes the table on purpose, so it is not loaded again after a reload
    reset() {
        this.query = '';
        this.filters = Object.assign({}, this.config.filters || {});
        this.forget();
        this.renderClosed();
    },

    // ---------- staying loaded ----------
    // The search box above this table (its oninput names the panel's key)
    searchBox() {
        return document.querySelector('[oninput*="dataPanelSearchInput(\'' + this.key + '\'"]');
    },

    // Writes down that this table is loaded: the search text, the filters and
    // the boxes named in config.inputs, so they can be put back (see recall)
    remember() {
        if (this.config.remember === false) return;

        const box = this.searchBox();
        const inputs = {};
        (this.config.inputs || []).forEach((id) => {
            const field = document.getElementById(id);
            if (field) inputs[id] = field.value;
        });

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

    forget() {
        const all = readLoadedPanels();
        const page = thisPageName();
        if (!all[page]) return;
        delete all[page][this.key];
        writeLoadedPanels(all);
    },

    // Loads the table again the way it was left: the same search, filters and boxes
    async recall(saved) {
        this.query = searchText(saved.text);
        Object.assign(this.filters, saved.filters || {});

        const box = this.searchBox();
        if (box) box.value = saved.text || '';

        // before the load, because load() can read these boxes
        this.putBoxesBack(saved, false);
        await this.open();

        // after it, because a box filled from the rows has its options only now
        this.putBoxesBack(saved, true);
        if (this.state === 'ready') this.apply();
    },

    // Sets the filter dropdowns and the other boxes to what was saved. Once the
    // load is over, a filter whose choice is no longer in its dropdown goes back to its default.
    putBoxesBack(saved, loaded) {
        const filters = saved.filters || {};

        Object.keys(filters).forEach((name) => {
            const select = document.querySelector(
                '[onchange*="dataPanelFilter(\'' + this.key + '\', \'' + name + '\'"]');
            if (!select) return;

            const done = setBoxValue(select, filters[name]);
            if (loaded && !done) {
                const first = (this.config.filters || {})[name];
                this.filters[name] = first === undefined ? 'all' : first;
            }
        });

        const inputs = saved.inputs || {};
        Object.keys(inputs).forEach((id) => setBoxValue(document.getElementById(id), inputs[id]));
    },

    // ---------- searching and filtering ----------
    // Typing on a closed table also loads it.
    async search(text) {
        this.query = searchText(text);

        // the load that is running applies the newest query when it lands
        if (this.state === 'loading') return;

        if (this.state === 'closed' || this.state === 'error') {
            if (this.query === '') return;
            await this.open();
            return;
        }

        this.page = 1;
        this.apply();
    },

    setFilter(name, value) {
        this.filters[name] = value;
        this.page = 1;
        if (this.state === 'ready') this.apply();
    },

    apply() {
        const query = this.query.toLowerCase();
        const match = this.config.match;
        const filter = this.config.filter;

        this.visible = this.rows.filter((row) => {
            if (filter && !filter(row, this.filters)) return false;
            if (query === '') return true;
            return match ? match(row, query) : true;
        });

        // sort is applied to the filtered copy; loaded rows keep server order
        if (typeof this.config.sort === 'function') {
            const sorted = this.config.sort(this.visible.slice(), this.filters);
            if (Array.isArray(sorted)) this.visible = sorted;
        }

        const pages = Math.max(1, Math.ceil(this.visible.length / this.pageSize));
        if (this.page > pages) this.page = pages;

        this.render();
    },

    // ---------- drawing ----------
    render() {
        const tbody = this.body();
        if (!tbody) return;

        if (this.visible.length === 0) {
            this.renderNoMatches();
            return;
        }

        const start = (this.page - 1) * this.pageSize;
        const slice = this.drawRows(this.page);

        this.setCount(this.visible.length +
            (this.visible.length === 1 ? ' record' : ' records'));

        this.renderPager(start, slice.length);
        this.announce();
    },

    // puts one page's rows in the table and returns them
    drawRows(page) {
        const start = (page - 1) * this.pageSize;
        const slice = this.visible.slice(start, start + this.pageSize);

        // build the HTML of every row on this page
        let html = '';
        for (let index = 0; index < slice.length; index++) {
            html += this.config.renderRow(slice[index], start + index);
        }
        // a short page is topped up to a full one so the pager does not move
        // (holdTableHeight in tables.js); not while printing every row
        if (this.pageSize === this.basePageSize() && slice.length < this.pageSize) {
            html += fillerRows(this.pageSize - slice.length, this.config.columns);
        }
        this.body().innerHTML = html;
        return slice;
    },

    // A later page can hold longer rows that wrap. Each page is drawn and
    // measured before the browser paints, then the page being read is drawn
    // back, so page one already takes the room the tallest page needs.
    measurePages() {
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

    renderPager(start, shown) {
        const mount = this.pager();
        if (!mount) return;

        const total = this.visible.length;
        const pages = Math.max(1, Math.ceil(total / this.pageSize));

        // one page says nothing: there is nothing to turn
        if (pages === 1) {
            this.clearPager();
            return;
        }

        // a panel can leave the caption out; the empty span keeps the controls on the right
        const info = this.config.pagerInfo === false
            ? '<span class="pager-info"></span>'
            : '<span class="pager-info">Showing ' + (start + 1) + '&ndash;' + (start + shown) +
                ' of ' + total + '</span>';

        mount.classList.remove('is-single');
        mount.innerHTML =
            info +
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

    clearPager() {
        const mount = this.pager();
        if (mount) {
            mount.innerHTML = '';
            mount.classList.add('is-single');
        }
    },

    setCount(text) {
        if (!this.config.countPillId) return;
        const pill = document.getElementById(this.config.countPillId);
        if (pill) pill.textContent = text;
    },

    // ---------- moving between pages ----------
    goTo(page) {
        const pages = Math.max(1, Math.ceil(this.visible.length / this.pageSize));
        this.page = Math.min(Math.max(1, page), pages);
        this.render();

        const table = document.getElementById(this.config.tableId);
        if (table && typeof table.scrollIntoView === 'function') {
            const box = table.getBoundingClientRect();
            if (box.top < 0) table.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    },

    next() { this.goTo(this.page + 1); },
    prev() { this.goTo(this.page - 1); },

    find(id, idField) {
        const key = idField || this.config.idField || 'id';
        return this.rows.find((row) => String(row[key]) === String(id)) || null;
    }
};

// ---------- loaded tables stay loaded ----------
// A table that was loaded is loaded again after a reload, or after a visit to
// another page of the app, in the same browser tab. sessionStorage keeps, for
// each page and each panel key, the search text, the filters and the boxes
// named in config.inputs. A table that was never loaded is never saved, so it
// is never loaded by itself. Signing out forgets everything
// (forgetLoadedPanels in helpers.js). Storage can be blocked, so every
// access is wrapped and the page works the same without it.

// the file name of this page, such as "manager.html"
function thisPageName() {
    return window.location.pathname.split('/').pop().toLowerCase();
}

// everything remembered, as { "manager.html": { "mgr-credit": { text, filters, inputs } } }
function readLoadedPanels() {
    try {
        const all = JSON.parse(sessionStorage.getItem(LOADED_PANELS_KEY) || '{}');
        if (all && typeof all === 'object') return all;
    } catch (error) { /* blocked, or not readable */ }
    return {};
}

function writeLoadedPanels(all) {
    try {
        sessionStorage.setItem(LOADED_PANELS_KEY, JSON.stringify(all));
    } catch (error) { /* blocked: the table just starts closed next time */ }
}

// Sets a box to a value. A dropdown without that choice is left alone.
// True when the box now holds the value.
function setBoxValue(box, value) {
    if (!box) return false;

    if (box.tagName === 'SELECT') {
        const found = Array.from(box.options).some((option) => option.value === String(value));
        if (!found) return false;
    }
    box.value = value;
    return true;
}

// Loads again every table of this page that was loaded before.
function restoreLoadedPanels() {
    // only for somebody signed in; session.js sends everyone else to the sign-in page
    if (typeof getCurrentUser !== 'function' || !getCurrentUser()) return;

    const saved = readLoadedPanels()[thisPageName()] || {};
    Object.keys(saved).forEach((key) => {
        const panel = getDataPanel(key);
        if (panel && panel.config.remember !== false) panel.recall(saved[key]);
    });
}

// The page builds its tables in its own DOMContentLoaded handler. A timer
// of 0 runs after all of those handlers have finished, so the tables exist.
document.addEventListener('DOMContentLoaded', function () {
    setTimeout(restoreLoadedPanels, 0);
});

// ---------- the handlers the generated buttons call ----------
function dataPanelOpen(key) { const p = getDataPanel(key); if (p) p.open(); }
function dataPanelNext(key) { const p = getDataPanel(key); if (p) p.next(); }
function dataPanelPrev(key) { const p = getDataPanel(key); if (p) p.prev(); }

// Search runs as the text is typed, a moment after the last key so a word
// typed quickly is one search. Enter searches at once; Escape empties the box.
const SEARCH_TYPING_DELAY_MS = 220;
const searchTimers = new Map();

function dataPanelSearchInput(key, event) {
    const box = event && event.target;
    if (!box) return;

    clearTimeout(searchTimers.get(key));
    searchTimers.set(key, setTimeout(() => {
        searchTimers.delete(key);
        dataPanelSearch(key, box.value);
    }, SEARCH_TYPING_DELAY_MS));
}

function dataPanelSearchKey(key, event) {
    if (!event) return;

    if (event.key === 'Escape' && event.target && event.target.value !== '') {
        event.target.value = '';
        event.preventDefault();
        clearTimeout(searchTimers.get(key));
        dataPanelSearch(key, '');
        return;
    }

    if (event.key !== 'Enter') return;

    event.preventDefault();
    clearTimeout(searchTimers.get(key));
    dataPanelSearch(key, event.target ? event.target.value : '');
}

// runs the search now
function dataPanelSearch(key, text) {
    const panel = getDataPanel(key);
    if (panel) panel.search(text);
}

// Every search box in the system follows one rule: what is typed has to begin
// a word. One letter is enough, so "c" finds Carl and Mark Cole but not Lace
// or KC, and "ad" finds Adhesive and Wood Adhesive but not Shade or Thread.

// lower-cased and trimmed; '' when nothing is typed
function searchText(text) {
    return String(text || '').trim().toLowerCase();
}

// true when the query begins the value or any word inside it
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

// The query arrives already lower-cased and trimmed.
function prefixMatch(fields, query) {
    if (!query) return true;
    return fields.some((field) => startsAWord(field, query));
}

// On an open table this narrows what has arrived. On a closed table it loads
// the table by default; a panel with loadOnFilter: false only remembers the
// value until Load Data or the search box asks (the staff directory).
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
