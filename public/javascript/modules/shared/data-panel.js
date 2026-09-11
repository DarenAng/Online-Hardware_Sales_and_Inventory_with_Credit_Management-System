// data-panel.js  --  LAZY DATA PANELS AND PAGINATION
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// WHY THIS FILE EXISTS
//
// Every table in this system used to fetch itself the moment its page opened.
// Five dashboards doing that at once is a burst of queries nobody asked for,
// and the person who opened the page to look up one customer waited for all
// of it. So a table now starts closed: it shows a search bar and a Load Data
// button, and it queries the database when it is told to and not before.
//
// The second job is paging. A grid that grows with the data pushes the rest
// of the page off the screen and turns the browser scrollbar into the only
// way back. Ten rows to a page, Previous and Next, and the panel is the same
// height whether it holds two rows or two hundred.
//
// One controller does both, because a table that loads on demand and a table
// that pages are the same table in two states, and thirty copies of this
// logic across five modules is thirty places for it to drift.
//
// USING IT
//
//   const panel = createDataPanel({
//       key: 'admin-users',            // unique, used by the inline handlers
//       tableId: 'accounts-table',     // the <table> it fills
//       columns: 5,                    // colspan for message rows; must match
//                                      // the number of <th> in that table
//       pagerId: 'accounts-pager',     // where Previous / Next are drawn
//       countPillId: 'accounts-count', // optional .pill showing the count
//       load: async () => [...],       // returns every row, once
//       match: (row, query) => true,   // optional free-text search
//       filter: (row, filters) => true,// optional dropdown filters
//       renderRow: (row, index) => '<tr>...</tr>',
//       gate: { title, text, button },  // what the closed state says
//       loadOnFilter: false            // optional; see dataPanelFilter below
//   });
//
//   panel.open();          // run load() and show page 1
//   panel.reset();         // back to the closed state, data forgotten
//   panel.search('pedro'); // free-text, re-pages from 1
//   panel.setFilter('status', 'inactive');
//   panel.refresh();       // re-run load(), keep the query and the filters
// ==========================================

const DATA_PANEL_ROWS_PER_PAGE = 10;

// every panel on the page, by key, so the buttons this file writes into the
// table can find their own panel from an inline handler
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

    Object.assign(panel, dataPanelMethods);
    dataPanels.set(config.key, panel);

    panel.renderClosed();
    return panel;
}

function getDataPanel(key) {
    return dataPanels.get(key) || null;
}

const dataPanelMethods = {
    // ---------- the parts of the page this panel owns ----------
    body() {
        const table = document.getElementById(this.config.tableId);
        return table ? table.querySelector('tbody') : null;
    },

    pager() {
        return this.config.pagerId ? document.getElementById(this.config.pagerId) : null;
    },

    // ---------- states ----------
    // A closed table is an invitation, not a blank box: it says what it holds
    // and which button fills it.
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
                '<button type="button" class="btn btn-accent" ' +
                        'onclick="dataPanelOpen(\'' + this.key + '\')">' +
                    escapeHtml(gate.button || 'Load Data') +
                '</button>' +
            '</div></td></tr>';
    },

    renderLoading() {
        const tbody = this.body();
        if (!tbody) return;

        this.state = 'loading';
        this.setCount('Loading');
        this.clearPager();
        tbody.innerHTML = '<tr><td colspan="' + this.config.columns +
            '" class="table-empty">Reading the database...</td></tr>';
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
    },

    renderNoMatches() {
        const tbody = this.body();
        if (!tbody) return;

        this.setCount('0 results');
        this.clearPager();

        const what = this.query
            ? 'Nothing matches <kbd>' + escapeHtml(this.query) + '</kbd>.'
            : 'Nothing here matches the filters you picked.';

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
    },

    // ==========================================
    // LOADING, AND THE TWO WAYS IT USED TO LIE
    //
    // Several of these panels send their filters to the server, so changing a
    // filter means another round trip. Somebody changing two filters in a row —
    // which is the ordinary way anybody uses a pair of dropdowns — starts a
    // second load while the first is still out. That produced two different
    // wrong answers, both of them silent:
    //
    // A DROPPED LOAD. This method used to return immediately if one was
    // already running. The second change was not queued, it was discarded, so
    // the dropdowns ended up saying "Pending Delivery" over a table still
    // showing everything. Nothing on the screen admitted it, and the reader's
    // next move is to trust the table.
    //
    // A LATE ANSWER. Even without the early return, two requests can come back
    // in the wrong order on a shop network, and the slower first one would
    // overwrite the newer rows it knew nothing about.
    //
    // So a load asked for during a load is remembered and run when the current
    // one lands, and every load carries a ticket number: an answer that is no
    // longer the newest is read and thrown away rather than drawn.
    // ==========================================
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

            // a newer load overtook this one; its answer is the current one
            if (ticket !== this.loadTicket) return;

            this.rows = Array.isArray(rows) ? rows : [];
            this.state = 'ready';
            this.page = 1;
            this.apply();

            if (typeof this.config.onLoaded === 'function') {
                this.config.onLoaded(this.rows, this);
            }
        } catch (error) {
            if (ticket !== this.loadTicket) return;
            this.renderError(error && error.handled ? error.message : null);
        } finally {
            // Anything asked for while this was in flight is answered now, with
            // whatever the filters say at this moment rather than what they said
            // when it was asked. That is the answer the reader is waiting for.
            if (ticket === this.loadTicket && this.reloadWanted) {
                this.reloadWanted = false;
                await this.open();
            }
        }
    },

    // re-reads from the server but keeps the search box and the filters
    async refresh() {
        if (this.state === 'closed') return;
        const page = this.page;
        await this.open();
        this.goTo(page);
    },

    reset() {
        this.query = '';
        this.filters = Object.assign({}, this.config.filters || {});
        this.renderClosed();
    },

    // ---------- searching and filtering ----------
    // The search box is also a way in: typing into a closed table loads it,
    // so nobody has to press Load Data first just to look one name up.
    async search(text) {
        this.query = String(text || '').trim();

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

    // works out what is visible, then draws the current page of it
    apply() {
        const query = this.query.toLowerCase();
        const match = this.config.match;
        const filter = this.config.filter;

        this.visible = this.rows.filter((row) => {
            if (filter && !filter(row, this.filters)) return false;
            if (query === '') return true;
            return match ? match(row, query) : true;
        });

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
        const slice = this.visible.slice(start, start + this.pageSize);

        tbody.innerHTML = slice
            .map((row, index) => this.config.renderRow(row, start + index))
            .join('');

        this.setCount(this.visible.length +
            (this.visible.length === 1 ? ' record' : ' records'));

        this.renderPager(start, slice.length);
    },

    renderPager(start, shown) {
        const mount = this.pager();
        if (!mount) return;

        const total = this.visible.length;
        const pages = Math.max(1, Math.ceil(total / this.pageSize));

        // one page of results does not need Previous and Next at all
        if (pages === 1) {
            mount.innerHTML = '<span class="pager-info">' +
                'Showing all ' + total + (total === 1 ? ' record' : ' records') + '</span>';
            mount.classList.add('is-single');
            return;
        }

        mount.classList.remove('is-single');
        mount.innerHTML =
            '<span class="pager-info">Showing ' + (start + 1) + '&ndash;' + (start + shown) +
                ' of ' + total + '</span>' +
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

        // a page change that scrolls the reader back to the top of the grid,
        // rather than leaving them halfway down the previous page's rows
        const table = document.getElementById(this.config.tableId);
        if (table && typeof table.scrollIntoView === 'function') {
            const box = table.getBoundingClientRect();
            if (box.top < 0) table.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    },

    next() { this.goTo(this.page + 1); },
    prev() { this.goTo(this.page - 1); },

    // the row behind a click, found by whatever the module calls its id
    find(id, idField) {
        const key = idField || this.config.idField || 'id';
        return this.rows.find((row) => String(row[key]) === String(id)) || null;
    }
};

// ---------- the handlers the generated buttons call ----------
function dataPanelOpen(key) { const p = getDataPanel(key); if (p) p.open(); }
function dataPanelNext(key) { const p = getDataPanel(key); if (p) p.next(); }
function dataPanelPrev(key) { const p = getDataPanel(key); if (p) p.prev(); }

// ==========================================
// THE SEARCH BOX, DEBOUNCED
//
// A search box wired straight to a filter runs it once per keystroke. That is
// free while the rows are already in memory and not free at all when the first
// keystroke is what fetches them, so the call is held back until the typing
// stops.
// ==========================================
const dataPanelTimers = new Map();

function dataPanelSearch(key, text, wait) {
    const existing = dataPanelTimers.get(key);
    if (existing) clearTimeout(existing);

    dataPanelTimers.set(key, setTimeout(() => {
        dataPanelTimers.delete(key);
        const panel = getDataPanel(key);
        if (panel) panel.search(text);
    }, wait === undefined ? 220 : wait));
}

// ==========================================
// PICKING A FILTER
//
// On a table that is already open this narrows what has arrived, which is the
// whole of it.
//
// On a CLOSED table there are two defensible answers and the panel says which
// one it wants. By default, picking a filter fills the table: on most screens
// somebody reaching for a dropdown on an empty table is asking to see the
// thing they just narrowed to, and making them press Load Data afterwards is
// a second step for no reason.
//
// A panel that sets loadOnFilter: false takes the other answer -- the value is
// remembered and nothing is read until Load Data or the search box asks. The
// staff directory does that, because it is the one screen where the filters
// are also how somebody sets up a query before running it, and a dropdown that
// fetches on the way past turns three deliberate choices into three queries.
// ==========================================
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
