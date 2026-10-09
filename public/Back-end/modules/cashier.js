// ============================================================
// cashier.js -- the Cashier dashboard (the till)
// Loaded by: cashier-dashboard.html
//
// What is in this file, from top to bottom:
//   - switching screens (showRegister, showRefunds, showCustomers, ...)
//   - the product catalog on the left of the till, with search and filters
//   - refunds: picking the product, the amount, and filing the refund
//   - the customer box: typing a name, suggestions, picking a customer
//   - the cart: adding lines, sizes (e.g. sack / kg), quantities, totals
//   - paying: cash, cheque, e-wallet, bank transfer, credit or COD
//   - checkout (handleCheckout) and the printed receipt
//   - booking a delivery for the sale
//   - the lists: deliveries, refunds, sales report, daily summary
//   - the customer credit screen, and payments taken from a customer's card
//   - the page start-up code at the very bottom ("CASHIER PAGE BOOT")
// ============================================================
let catalog = [];
let catalogLoaded = false;
let catalogMode = 'idle';     // 'idle' keeps the grid clean, 'top' shows the first ten, 'all' shows everything
let cart = [];
let cashierSales = [];
let salesScope = 'Mine';
let lastReceipt = null;

// eight rows is what fits above the fold on the counter machine
const CASHIER_ROWS_PER_PAGE = 8;

// eight a page keeps the form and the log on one screen without scrolling
const REFUND_ROWS_PER_PAGE = 8;

// the customer book, read once and searched in memory behind the typing box
let customerDirectory = [];
let customerDirectoryLoaded = false;
let suggestHighlight = -1;

// a delivery filled in beside the order; written the moment the sale exists
let pendingDelivery = null;

let dailySummary = null;

function showCashierPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('cash-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// Opening a screen never unfolds the Point of Sale list: only the heading's
// caret does (shared/helpers.js sidebarHeading); the heading lights up on its
// own while a screen beneath it is the open one.

function showRegister(event) {
    showCashierPanel('panel-pos', 'Point of Sale', event);

    const search = document.getElementById('catalog-search');
    if (search) search.value = '';

    catalogMode = 'idle';
    renderCatalogEmpty();
    renderCart();
}

function showCashierHome(event) {
    showRegister(event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));
}

// tracking only; empty until the search box or Load Data asks
function showCashierDeliveries(event) {
    showCashierPanel('panel-delivery', 'Delivery Tracking', event);
}

// the refund form's product box needs the catalogue; the list waits to be asked
function showRefunds(event) {
    showCashierPanel('panel-refund', 'Refunds', event);
    loadCatalogOptions();
}

function showCustomers(event) { showCashierPanel('panel-customers', 'Customers Record', event); }

function showSalesReport(event) {
    showCashierPanel('panel-salesreport', 'Sales Report', event);
}

// the cashier's own QR codes; a row that paid for a sale opens its invoice
function showQrPayments(event) {
    showCashierPanel('panel-qrpayments', 'QR Payments', event);
}

function showDailySummary(event) {
    showCashierPanel('panel-summary', 'Daily Summary', event);
    loadDailySummary();
}

// ---------- product catalog ----------
async function ensureCatalogLoaded(force) {
    if (catalogLoaded && !force) return true;
    try {
        catalog = await apiGetProducts();
        catalogLoaded = true;
        return true;
    } catch (error) {
        catalogLoaded = false;
        return false;
    }
}

function catalogGrid() { return document.getElementById('catalog-grid'); }

function renderCatalogEmpty() {
    const grid = catalogGrid();
    if (!grid) return;
    setPill('catalog-count', 'Not loaded');
    grid.innerHTML = `
        <div class="empty-state">
            <div class="empty-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 6h15l-1.5 9h-12z"></path>
                    <path d="M6 6L5 3H2"></path>
                    <circle cx="9" cy="20" r="1.4"></circle>
                    <circle cx="18" cy="20" r="1.4"></circle>
                </svg>
            </div>
            <h4>No products loaded</h4>
            <p>Search above for what the customer is buying, or view the first ten products.</p>
            <button type="button" class="btn btn-accent" onclick="loadCatalogTop(event)">View Top 10 Rows</button>
        </div>`;
    holdBoxHeight(grid);
}

function renderCatalogNoMatch(keyword) {
    const grid = catalogGrid();
    if (!grid) return;
    setPill('catalog-count', '0 results');
    grid.innerHTML = `
        <div class="empty-state">
            <div class="empty-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path><path d="M8.5 11h5"></path>
                </svg>
            </div>
            <h4>No match found</h4>
            <p>${keyword ? "Nothing matches <kbd>" + escapeHtml(keyword) + "</kbd>" : "Nothing is left"}${
                catalogFilters.category !== "all"
                    ? " in the category picked above" : ""}. Archived and out-of-stock products never appear here.</p>
            <button type="button" class="btn btn-accent" onclick="loadCatalogTop(event)">View Top 10 Rows</button>
        </div>`;
    holdBoxHeight(grid);
}

// The catalog is a table, not a grid of cards. Pressing a row anywhere puts
// the product on the order; only in-stock products are listed.
const catalogFilters = { category: 'all' };

function setCatalogFilter(name, value) {
    catalogFilters[name] = value;
    // a filter is an ask, like the search
    if (!catalogLoaded || catalogMode === 'idle') {
        catalogMode = 'all';
        loadCatalogAll();
        return;
    }
    applyCatalogView();
}

// only products that can be sold are listed; out of stock ones stay off the table
function isCatalogAvailable(p) { return Number(p.quantity_in_stock) > 0; }

function catalogMatchesFilters(p) {
    if (!isCatalogAvailable(p)) return false;
    if (catalogFilters.category !== 'all' && String(p.category_name || 'Uncategorised') !== catalogFilters.category) return false;
    return true;
}

function fillCatalogCategories() {
    const select = document.getElementById('catalog-category');
    if (!select) return;

    // every category name of the products for sale, each one once, A to Z
    const names = [];
    for (const p of catalog) {
        if (!isCatalogAvailable(p)) continue;
        const name = String(p.category_name || 'Uncategorised');
        if (!names.includes(name)) {
            names.push(name);
        }
    }
    names.sort();
    const current = select.value;
    select.innerHTML = '<option value="all">Every category</option>' +
        names.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
    select.value = names.indexOf(current) !== -1 ? current : 'all';
    catalogFilters.category = select.value;
}

function applyCatalogView() {
    const box = document.getElementById('catalog-search');
    const text = searchText(box ? box.value : '');

    if (text === '' && catalogMode === 'idle') { renderCatalogEmpty(); return; }

    let rows = catalog.filter((p) =>
        catalogMatchesFilters(p) &&
        (text === '' || prefixMatch([p.product_name, p.category_name, p.brand_name], text)));
    if (text === '' && catalogMode === 'top') rows = rows.slice(0, CATALOG_TOP_ROWS);
    renderCatalog(rows, text);
}

// Ten rows at a time, with Previous and Next under the table. The page is
// kept while the same rows are redrawn (a line put on the order) and starts
// over when the search or a filter changes what is listed.
const CATALOG_PAGE_ROWS = 10;
const CATALOG_TOP_ROWS = 10;
let catalogShown = [];
let catalogShownKey = '';
let catalogPage = 1;

function catalogGo(delta) {
    catalogPage += delta;
    renderCatalog(catalogShown);
    const grid = catalogGrid();
    if (grid) grid.scrollTop = 0;
}

function renderCatalog(rows, keyword) {
    const grid = catalogGrid();
    if (!grid) return;

    if (rows.length === 0) { renderCatalogNoMatch(keyword || ''); return; }

    const key = rows.map((p) => p.product_id).join(',');
    if (key !== catalogShownKey) catalogPage = 1;
    catalogShown = rows;
    catalogShownKey = key;

    const pages = Math.max(1, Math.ceil(rows.length / CATALOG_PAGE_ROWS));
    catalogPage = Math.min(Math.max(1, catalogPage), pages);
    const start = (catalogPage - 1) * CATALOG_PAGE_ROWS;
    const slice = rows.slice(start, start + CATALOG_PAGE_ROWS);

    let pager;
    if (pages === 1) {
        pager = '<div class="pager is-single"><span class="pager-info">Showing all ' + rows.length +
              (rows.length === 1 ? ' product' : ' products') + '</span></div>';
    } else {
        pager = '<div class="pager"><span class="pager-info">Showing ' + (start + 1) + '&ndash;' +
              (start + slice.length) + ' of ' + rows.length + '</span>' +
              '<div class="pager-controls">' +
                  '<button type="button" class="btn btn-sm" onclick="catalogGo(-1)"' +
                      (catalogPage === 1 ? ' disabled' : '') + '>Previous</button>' +
                  '<span class="pager-page">Page ' + catalogPage + ' of ' + pages + '</span>' +
                  '<button type="button" class="btn btn-sm" onclick="catalogGo(1)"' +
                      (catalogPage === pages ? ' disabled' : '') + '>Next</button>' +
              '</div></div>';
    }

    // No stock count on a row at the till; every row listed is in stock. The
    // sizes a product also sells in are listed under its unit, and picked on
    // the order line.
    setPill('catalog-count', rows.length + (rows.length === 1 ? ' product' : ' products'));
    grid.innerHTML =
        '<table class="catalog-table" id="catalog-table">' +
        '<thead><tr><th>Product</th><th>Category</th><th>Brand</th><th>Sold By</th><th>Price</th></tr></thead>' +
        '<tbody>' + slice.map((p, i) => {
            const inCart = cart.find((l) => l.product_id === p.product_id);
            const sizes = sellingUnitsOf(p);
            return '<tr class="row-reveal row-clickable' + (inCart ? ' is-on-order' : '') + '"' +
                ' style="animation-delay:' + Math.min(i, 12) * 26 + 'ms"' +
                ' onclick="addToCart(' + p.product_id + ')"' +
                ' title="Press to put it on the order"' +
                ' data-product-row="' + p.product_id + '">' +
                '<td class="cell-name">' + escapeHtml(p.product_name) +
                    '<span class="on-order-mark" title="On the order"' + (inCart ? '' : ' hidden') + '>' +
                        (inCart ? escapeHtml(qtyText(inCart.quantity, inCart.unit)) + ' on order' : '') + '</span></td>' +
                '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
                '<td>' + escapeHtml(p.brand_name || '\u2014') + '</td>' +
                '<td class="cell-unit">' + escapeHtml(p.unit_name || '\u2014') +
                    (sizes.length > 0
                        ? '<span class="unit-sizes">also by the ' +
                          sizes.map((u) => escapeHtml(u.unit_name)).join(', ') + '</span>' : '') + '</td>' +
                '<td class="cell-num catalog-price">' + peso(p.price) +
                    (p.unit_name ? '<span class="price-per">per ' + escapeHtml(unitShort(p.unit_name)) + '</span>' : '') + '</td>' +
            '</tr>';
        }).join('') +
        // a short page is topped up to ten so the pager stays put (tables.js)
        fillerRows(CATALOG_PAGE_ROWS - slice.length, 5) +
        '</tbody></table>' + pager;

    holdTableHeight(document.getElementById('catalog-table'));
    holdBoxHeight(grid);
}

// the first ten products only, so the till does not list the whole catalog
function loadCatalogTop(event) { return loadCatalogView('top', event); }

function loadCatalogAll(event) { return loadCatalogView('all', event); }

async function loadCatalogView(mode, event) {
    if (event) event.preventDefault();
    showCashierPanel('panel-pos', 'Point of Sale');
    const link = document.querySelector('a[data-panel-link="panel-pos"]');
    if (link) link.classList.add('active');

    const search = document.getElementById('catalog-search');
    if (search) search.value = '';
    catalogMode = mode;

    const grid = catalogGrid();
    if (grid) grid.innerHTML = '<p class="table-empty">Loading catalog...</p>';

    if (!(await ensureCatalogLoaded(true))) {
        setPill('catalog-count', 'Offline');
        if (grid) grid.innerHTML = '<p class="table-empty">Cannot reach the server.</p>';
        return;
    }
    fillCatalogCategories();
    applyCatalogView();
    loadCustomerOptions();
}

// the catalog narrows as the cashier types; Escape clears
let catalogSearchTimer = null;

function onCatalogSearchInput(event) {
    if (!event || !event.target) return;
    const box = event.target;
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = setTimeout(() => filterCatalog(box.value), SEARCH_TYPING_DELAY_MS);
}

function onCatalogSearchKey(event) {
    if (!event || !event.target) return;

    if (event.key === 'Escape') {
        event.target.value = '';
        clearTimeout(catalogSearchTimer);
        filterCatalog('');
        return;
    }
    if (event.key !== 'Enter') return;

    event.preventDefault();
    clearTimeout(catalogSearchTimer);
    filterCatalog(event.target.value);
}

async function filterCatalog(keyword) {
    const text = searchText(keyword);

    if (text === '') {
        if (catalogMode !== 'idle') applyCatalogView();
        else renderCatalogEmpty();
        return;
    }

    if (!catalogLoaded) {
        const grid = catalogGrid();
        if (grid) grid.innerHTML = '<p class="table-empty">Searching catalog...</p>';
        if (!(await ensureCatalogLoaded(false))) {
            setPill('catalog-count', 'Offline');
            if (grid) grid.innerHTML = '<p class="table-empty">Cannot reach the server.</p>';
            return;
        }
        const box = document.getElementById('catalog-search');
        const latest = searchText(box ? box.value : text);
        if (latest !== text) return;
        fillCatalogCategories();
        loadCustomerOptions();
    }

    applyCatalogView();
}

// The refund product is typed, not picked, and shares the customer box's
// shape. Until a product is picked there is no strip under the box and the
// form refuses to send. Picking one fills the refund amount in.
let refundProduct = null;
let refundSuggestHighlight = -1;

// what the amount box last had put into it by this code; a typed figure is never overwritten
let refundAmountSuggested = null;

function refundProductBox() { return document.getElementById('refund-product'); }

function refundProductIdBox() {
    const form = document.getElementById('refund-form');
    return form ? form.elements.productId : null;
}

// kept under its old name because showRefunds calls it
async function loadCatalogOptions() {
    if (!document.getElementById('refund-product')) return;
    await ensureCatalogLoaded(false);
}

async function onRefundProductInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('refund-product-clear');

    if (clear) clear.hidden = text === '';

    if (!catalogLoaded && text !== '') await ensureCatalogLoaded(false);

    // typing after a choice unmakes the choice
    if (refundProduct && String(refundProduct.product_name).trim() !== text) {
        setRefundProduct(null);
    }

    renderRefundSuggestions(text);
    renderRefundProductVerdict();
}

function renderRefundSuggestions(text) {
    const list = document.getElementById('refund-suggest');
    const box = refundProductBox();
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    refundSuggestHighlight = -1;

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (searchText(query) === '' || catalog.length === 0) { hide(); return; }

    if (refundProduct && String(refundProduct.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    // names that start with the text come before a later word in the name
    const starts = [];
    const words = [];
    const other = [];

    catalog.forEach((p) => {
        const name = String(p.product_name || '').toLowerCase();

        if (name.startsWith(query)) starts.push(p);
        else if (startsAWord(name, query)) words.push(p);
        else if (prefixMatch([p.brand_name, p.category_name], query)) other.push(p);
    });

    const found = starts.concat(words, other).slice(0, 6);

    if (found.length === 0) { hide(); return; }

    list.innerHTML = found.map((p, i) => {
        // brand and category separate two products whose names read almost the same
        const meta = [p.category_name, p.brand_name].filter(Boolean).map(escapeHtml);

        return '<li class="suggest-item" role="option" id="refund-suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickRefundProduct(' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + peso(p.price) + '</span>' +
            '</span>' +
            (meta.length
                ? '<span class="suggest-note">' + meta.join(' &middot; ') + '</span>'
                : '') +
            '</li>';
    }).join('');

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideRefundSuggestions() {
    const list = document.getElementById('refund-suggest');
    const box = refundProductBox();
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    refundSuggestHighlight = -1;
}

function onRefundProductKey(event) {
    const list = document.getElementById('refund-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        refundSuggestHighlight = (refundSuggestHighlight + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === refundSuggestHighlight));
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[refundSuggestHighlight >= 0 ? refundSuggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideRefundSuggestions();
}

function pickRefundProduct(productId) {
    const found = catalog.find((p) => p.product_id === productId);
    if (!found) return;

    const box = refundProductBox();
    if (box) box.value = found.product_name;

    const clear = document.getElementById('refund-product-clear');
    if (clear) clear.hidden = false;

    hideRefundSuggestions();
    setRefundProduct(found);
}

function clearRefundProduct() {
    const box = refundProductBox();
    if (box) box.value = '';

    const clear = document.getElementById('refund-product-clear');
    if (clear) clear.hidden = true;

    hideRefundSuggestions();
    setRefundProduct(null);
    renderRefundProductVerdict();
    if (box) box.focus();
}

// one place decides what is chosen so the field, strip, verdict and amount agree
function setRefundProduct(product) {
    refundProduct = product || null;

    const idBox = refundProductIdBox();
    if (idBox) idBox.value = product ? String(product.product_id) : '';

    renderRefundProductStrip();
    renderRefundProductVerdict();
    suggestRefundAmount();
}

// the strip is the whole answer to "have I chosen something yet"
function renderRefundProductStrip() {
    const strip = document.getElementById('refund-product-strip');
    if (!strip) return;

    const p = refundProduct;
    if (!p) { strip.hidden = true; strip.innerHTML = ''; return; }

    const meta = [p.category_name, p.brand_name].filter(Boolean).map(escapeHtml).join(' &middot; ');

    strip.hidden = false;
    strip.innerHTML =
        '<p class="pick-strip-name">' + escapeHtml(p.product_name) + '</p>' +
        (meta ? '<p class="pick-strip-meta">' + meta + '</p>' : '') +
        '<div class="pick-strip-figures">' +
            '<span><span class="pick-strip-label">Sells for</span>' +
                '<span class="pick-strip-value">' + peso(p.price) + '</span></span>' +
        '</div>';
}

function renderRefundProductVerdict() {
    const box = document.getElementById('refund-product-verdict');
    if (!box) return;

    const typed = refundProductBox() ? refundProductBox().value.trim() : '';

    if (refundProduct) { box.textContent = ''; box.className = 'pick-verdict'; return; }

    if (typed === '') {
        box.className = 'pick-verdict';
        box.textContent = 'Type a few letters and choose from the list.';
        return;
    }

    box.className = 'pick-verdict is-stop';
    box.textContent = 'No product chosen yet. A refund moves stock, so it has to name a real product.';
}

// Choosing the product and saying how many fills the amount in. It stays
// editable; the note under the box says which figure is in it.
function suggestRefundAmount() {
    const form = document.getElementById('refund-form');
    const note = document.getElementById('refund-amount-source');
    if (!form) return;

    const field = form.elements.refundAmount;
    if (!field) return;

    if (!refundProduct) {
        if (note) { note.textContent = ''; note.className = 'amount-source'; }
        return;
    }

    const quantity = Number(form.elements.quantity.value) || 0;
    const suggested = Math.round(Number(refundProduct.price) * Math.max(quantity, 0) * 100) / 100;

    const current = parseFloat(field.value);
    const untouched = !field.value || current === 0 || current === refundAmountSuggested;

    if (untouched) {
        field.value = suggested.toFixed(2);
        refundAmountSuggested = suggested;
        if (note) {
            note.className = 'amount-source';
            note.textContent = quantity + ' at ' + peso(refundProduct.price) + '. Change it if the '
                + 'customer paid a different price.';
        }
        return;
    }

    if (note) {
        note.className = 'amount-source is-edited';
        note.textContent = 'Your figure. ' + quantity + ' at today\'s price would be '
            + peso(suggested) + '.';
    }
}

function onRefundQuantityInput() { suggestRefundAmount(); }

function onRefundAmountInput() {
    const form = document.getElementById('refund-form');
    if (!form) return;

    const typed = parseFloat(form.elements.refundAmount.value);

    // typing the suggested figure back in by hand is still the suggested figure
    if (typed !== refundAmountSuggested) refundAmountSuggested = null;
    suggestRefundAmount();
}

// The customer is typed, not picked. A name picked from the suggestions is
// an account (the credit strip appears); a name matching nobody is a walk-in
// with a name; nothing typed is a walk-in.
async function loadCustomerDirectory(force) {
    if (customerDirectoryLoaded && !force) return true;

    try {
        customerDirectory = await apiGetRecords('customer');
        customerDirectoryLoaded = true;
        return true;
    } catch (error) {
        // not fatal: a cash sale to a walk-in needs none of this
        customerDirectoryLoaded = false;
        return false;
    }
}

function customerNameBox() { return document.getElementById('customer-name'); }
function customerIdBox() {
    const form = document.getElementById('checkout-form');
    return form ? form.elements.customerId : null;
}

function selectedCustomerId() {
    const box = customerIdBox();
    return box && box.value ? parseInt(box.value, 10) : null;
}

// trimmed and collapsed: "Maria  Santos" and "Maria Santos" are one customer
function typedCustomerName() {
    const box = customerNameBox();
    return box ? box.value.trim().replace(/\s+/g, ' ') : '';
}

// the account whose name is in the box, only while the text still matches exactly
function customerMatchingTypedName() {
    const text = typedCustomerName().toLowerCase();
    if (text === '') return null;
    return customerDirectory.find((c) => String(c.name).trim().toLowerCase() === text) || null;
}

async function onCustomerInput(value) {
    const text = String(value || '').trim();
    const idBox = customerIdBox();
    const clear = document.getElementById('customer-clear');

    if (clear) clear.hidden = text === '';

    if (!customerDirectoryLoaded && text !== '') await loadCustomerDirectory(false);

    const exact = customerMatchingTypedName();

    // an id that no longer agrees with the text books the sale against the wrong account
    if (idBox) {
        const nextId = exact ? String(exact.id) : '';
        if (idBox.value !== nextId) {
            idBox.value = nextId;
            await onCustomerChange(nextId);
        }
    }

    renderCustomerSuggestions(text);
    renderCustomerVerdict();
}

function renderCustomerSuggestions(text) {
    const list = document.getElementById('customer-suggest');
    const box = customerNameBox();
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    suggestHighlight = -1;

    if (searchText(query) === '' || customerDirectory.length === 0) {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
        return;
    }

    // names that start with the text first; six fits under the box
    const starts = [];
    const words = [];

    customerDirectory.forEach((c) => {
        const name = String(c.name || '').toLowerCase();
        if (name.startsWith(query)) starts.push(c);
        else if (prefixMatch([name, c.phone], query)) words.push(c);
    });

    const found = starts.concat(words).slice(0, 6);

    if (found.length === 0) {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
        return;
    }

    list.innerHTML = found.map((c, i) => {
        const owed = Number(c.current_credit) || 0;
        const bought = Number(c.purchase_count) || 0;

        // a regular, or an account that already owes, is worth knowing before the sale
        const notes = [];
        if (bought > 0) notes.push(bought + (bought === 1 ? ' purchase' : ' purchases'));
        if (owed > 0) notes.push('owes ' + peso(owed));
        if (c.phone) notes.push(escapeHtml(c.phone));

        return '<li class="suggest-item" role="option" id="suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickCustomer(' + c.id + ')">' +
            '<span class="suggest-name">' + escapeHtml(c.name) + '</span>' +
            (notes.length
                ? '<span class="suggest-note">' + notes.join(' &middot; ') + '</span>'
                : '') +
            '</li>';
    }).join('');

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideCustomerSuggestions() {
    const list = document.getElementById('customer-suggest');
    const box = customerNameBox();
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    suggestHighlight = -1;
}

// arrow keys and Enter: a cashier's hands are on the keyboard
function onCustomerKey(event) {
    const list = document.getElementById('customer-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        suggestHighlight = (suggestHighlight + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === suggestHighlight));
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[suggestHighlight >= 0 ? suggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideCustomerSuggestions();
}

async function pickCustomer(customerId) {
    const found = customerDirectory.find((c) => c.id === customerId);
    if (!found) return;

    const nameBox = customerNameBox();
    const idBox = customerIdBox();

    if (nameBox) nameBox.value = found.name;
    if (idBox) idBox.value = String(found.id);

    const clear = document.getElementById('customer-clear');
    if (clear) clear.hidden = false;

    hideCustomerSuggestions();
    await onCustomerChange(String(found.id));
    renderCustomerVerdict();

    // a delivery already filled in for the previous customer follows the change
    if (pendingDelivery && !pendingDelivery.edited) fillDeliveryFromCustomer();
}

async function clearCustomer() {
    const nameBox = customerNameBox();
    const idBox = customerIdBox();

    if (nameBox) nameBox.value = '';
    if (idBox) idBox.value = '';

    const clear = document.getElementById('customer-clear');
    if (clear) clear.hidden = true;

    hideCustomerSuggestions();
    await onCustomerChange('');
    renderCustomerVerdict();
    if (nameBox) nameBox.focus();
}

// one line under the box saying which outcome is in force
function renderCustomerVerdict() {
    const box = document.getElementById('customer-verdict');
    if (!box) return;

    const typed = typedCustomerName();
    const id = selectedCustomerId();

    if (id) {
        box.className = 'customer-verdict is-good';
        box.textContent = 'On the books. This sale goes on their record.';
        return;
    }

    if (typed === '') {
        box.className = 'customer-verdict';
        box.textContent = 'Walk-in. Type a name if you have one.';
        return;
    }

    box.className = 'customer-verdict is-new';
    box.textContent = 'Not on the books yet. They are added to Customers Record when the sale is rung up.';
}

// kept under the old name because the boot sequence and the catalog loader call it
async function loadCustomerOptions() {
    await loadCustomerDirectory(false);
}

// ---------- the cart ----------
// One line per product. A line is counted in the unit chosen on it: the
// product's own (kilos, pieces) or one of the sizes the clerk listed for it
// (a sack of 25 kilos, a box of 10). Stock is always checked in the
// product's own unit, so 2 sacks ask the shelf for 50 kilos.
function sellingUnitsOf(product) {
    const list = Array.isArray(product.selling_units) ? product.selling_units : [];
    return list.filter((u) => u && u.unit_name && Number(u.units_per) > 0);
}

// "kg" for a kilogram, otherwise the unit's own name
function unitShort(unit) {
    const measure = measuredUnit(unit);
    return measure ? measure.short : String(unit || '').trim();
}

// the choices on a line: the product's own unit first, then the sizes, smallest up
function lineUnitChoices(line) {
    const own = { unit_name: line.base_unit || 'unit', units_per: 1, price: line.price, own: true };
    const sizes = line.sizes.slice().sort((a, b) => Number(a.units_per) - Number(b.units_per))
        .map((u) => ({
            unit_name: u.unit_name,
            units_per: Number(u.units_per),
            price: u.price === null || u.price === undefined
                ? Math.round(line.price * Number(u.units_per) * 100) / 100
                : Number(u.price),
            own: false
        }));
    return [own].concat(sizes);
}

function lineChoice(line) {
    const choices = lineUnitChoices(line);
    return choices.find((c) => c.unit_name.toLowerCase() === String(line.unit).toLowerCase()) || choices[0];
}

// the price of one of what the line is counted in
function lineUnitPrice(line) { return lineChoice(line).price; }

// what the line asks of the shelf, in the product's own unit
function lineBaseQty(line) {
    return Number((line.quantity * lineChoice(line).units_per).toFixed(3));
}

function lineSubtotal(line) {
    return Math.round(line.quantity * lineUnitPrice(line) * 100) / 100;
}

// the most of the chosen unit the shelf can give; a measured own unit can be a fraction
function lineCeiling(line) {
    const choice = lineChoice(line);
    const most = line.on_hand / choice.units_per;
    if (choice.own && isMeasuredUnit(line.base_unit)) return Math.floor(most * 1000) / 1000;
    return Math.floor(most);
}

// a fraction only on the product's own measured unit (2.5 kg); sizes are whole
function lineStep(line) {
    const choice = lineChoice(line);
    if (choice.own && isMeasuredUnit(line.base_unit)) return measuredUnit(line.base_unit).step;
    return 1;
}

function lineAllowsFraction(line) {
    const choice = lineChoice(line);
    return choice.own && isMeasuredUnit(line.base_unit);
}

function tellAllOfIt(line) {
    notifyWarning('The order already has every ' + line.name + ' we can sell today (' +
        qtyText(line.on_hand, line.base_unit) + '). Take the rest off a delivery or a new order.',
        'That is all of it');
}

// Pressing a product puts one of its own unit on the order, or one more if
// it is already there. The unit and the amount are changed on the line.
function addToCart(productId) {
    const p = catalog.find((x) => x.product_id === productId);
    if (!p) return;

    const onHand = Number(p.quantity_in_stock);
    if (onHand <= 0) {
        notifyWarning(p.product_name + ' is out of stock, so it cannot go on this sale.', 'Nothing to sell');
        return;
    }

    const line = cart.find((l) => l.product_id === productId);
    if (line) {
        const next = Number((line.quantity + lineStep(line)).toFixed(3));
        if (next > lineCeiling(line)) { tellAllOfIt(line); return; }
        line.quantity = next;
        renderCart();
        flashCartLine(productId);
        return;
    }

    const fresh = {
        product_id: p.product_id,
        name: p.product_name,
        price: Number(p.price),
        base_unit: p.unit_name || '',
        unit: p.unit_name || '',
        sizes: sellingUnitsOf(p),
        quantity: 1,
        on_hand: onHand
    };
    // a shelf holding less than one (0.4 kg of nails) still sells what it has
    if (onHand < 1) fresh.quantity = lineCeiling(fresh);
    cart.push(fresh);
    renderCart();
    flashCartLine(productId);
}

function flashCartLine(productId) {
    const row = document.querySelector('.cart-line[data-line="' + productId + '"]');
    if (!row) return;
    row.classList.add('is-added');
    setTimeout(() => row.classList.remove('is-added'), 500);
}

function changeCartQty(productId, delta) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;

    const next = Number((line.quantity + delta * lineStep(line)).toFixed(3));
    if (next <= 0) { removeCartLine(productId); return; }
    if (next > lineCeiling(line)) { tellAllOfIt(line); return; }
    line.quantity = next;
    renderCart();
}

// the amount box on a line: typed, then checked against the shelf when it is left
function onCartQtyInput(productId, value) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;

    const amount = Number(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(amount) || amount <= 0) return;   // settled on blur

    const rounded = lineAllowsFraction(line) ? Math.round(amount * 1000) / 1000 : Math.floor(amount);
    if (rounded <= 0) return;
    if (rounded > lineCeiling(line)) { tellAllOfIt(line); line.quantity = lineCeiling(line); renderCart(); return; }
    line.quantity = rounded;
    renderCartFigures();
}

function onCartQtyBlur(productId) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;
    if (!(line.quantity > 0)) line.quantity = Math.min(1, lineCeiling(line)) || 1;
    renderCart();
}

// Changing the unit keeps the count where it can: 3 boxes become 3 kilos,
// capped at what the shelf holds in the new size.
function changeCartUnit(productId, unitName) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;

    line.unit = unitName;
    const most = lineCeiling(line);
    if (most <= 0) {
        // not even one of that size on the shelf; go back to the product's own unit
        line.unit = line.base_unit;
        notifyWarning('There is not a whole ' + unitName + ' of ' + line.name + ' left (' +
            qtyText(line.on_hand, line.base_unit) + ' on the shelf).', 'Not enough for that size');
        renderCart();
        return;
    }
    if (!lineAllowsFraction(line)) line.quantity = Math.max(1, Math.floor(line.quantity));
    if (line.quantity > most) line.quantity = most;
    renderCart();
}

function removeCartLine(productId) {
    cart = cart.filter((l) => l.product_id !== productId);
    renderCart();
}

async function clearCart() {
    if (cart.length === 0) return;

    const yes = await askConfirm(
        'Every item on this order is taken off, and the amount entered goes back to zero.',
        { title: 'Clear the whole order?', eyebrow: 'Point of Sale', confirmLabel: 'Clear it', tone: 'danger' });

    if (!yes) return;

    cart = [];
    const form = document.getElementById('checkout-form');
    if (form) {
        form.elements.amountPaid.value = '';
        if (form.elements.downPayment) form.elements.downPayment.value = '';
    }

    // a delivery left attached to an emptied cart is a booking for goods nobody chose
    pendingDelivery = null;
    renderDeliveryAttached();
    await clearCustomer();
    renderCart();
}

// No discount box: a markdown belongs on the product, set by a manager.
// discount stays in these totals as a fixed zero because the sales table, the
// receipt and the reports still carry the column.
function cartTotals() {
    const form = document.getElementById('checkout-form');
    // the total of every line in the cart
    let gross = 0;
    for (const line of cart) {
        gross = gross + lineSubtotal(line);
    }
    const discount = 0;
    const due = Math.max(gross - discount, 0);
    let tendered = 0;        // the money the customer handed over
    let method = 'Cash';
    if (form) {
        tendered = parseFloat(form.elements.amountPaid.value) || 0;
        method = form.elements.paymentMethod.value;
    }

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    // half now and half on the book; capped at the bill because there is no change
    let rawDown;
    if (form && form.elements.downPayment) {
        rawDown = parseFloat(form.elements.downPayment.value) || 0;
    } else {
        rawDown = 0;
    }

    let down = 0;
    if (onCredit) {
        down = Math.max(0, Math.min(rawDown, due));   // between 0 and the amount due
    }

    // what goes on the customer's account (still owed after this sale)
    let onBook = 0;
    if (onCredit) {
        onBook = due - down;
    } else if (method === 'COD') {
        onBook = due;
    }

    return {
        gross: gross,
        discount: discount,
        due: due,
        tendered: tendered,
        change: Math.max(tendered - due, 0),
        method: method,
        onAccount: onAccount,
        onCredit: onCredit,
        down: down,
        onBook: onBook
    };
}

// the words under a line: "2 sacks = 50 kg" when the unit is a size, or the price of one
function cartLineNote(l) {
    const choice = lineChoice(l);
    if (choice.own) {
        return peso(choice.price) + ' per ' + escapeHtml(unitShort(l.base_unit) || 'unit');
    }
    return peso(choice.price) + ' per ' + escapeHtml(choice.unit_name) + ' \u00b7 ' +
        escapeHtml(qtyText(lineBaseQty(l), l.base_unit)) + ' off the shelf';
}

function renderCart() {
    const box = document.getElementById('cart-lines');
    if (!box) return;

    setPill('cart-count', cart.length + (cart.length === 1 ? ' item' : ' items'));

    if (cart.length === 0) {
        box.innerHTML = '<p class="cart-empty">No items yet. Press a product to put it on the order.</p>';
    } else {
        box.innerHTML = cart.map((l) => {
            const choices = lineUnitChoices(l);
            const chosen = lineChoice(l);
            let unitBox;
            if (choices.length > 1) {
                unitBox = '<select class="cart-unit-pick" aria-label="Sold by" title="The size this line is counted in" ' +
                          'onchange="changeCartUnit(' + l.product_id + ', this.value)">' +
                      choices.map((c) => '<option value="' + escapeHtml(c.unit_name) + '"' +
                          (c.unit_name === chosen.unit_name ? ' selected' : '') + '>' +
                          escapeHtml(c.own ? (unitShort(c.unit_name) || 'unit') : c.unit_name) +
                          (c.own ? '' : ' (' + escapeHtml(qtyText(c.units_per, l.base_unit)) + ')') +
                          '</option>').join('') +
                      '</select>';
            } else {
                unitBox = '<span class="cart-unit-fixed">' + escapeHtml(unitShort(l.base_unit) || 'unit') + '</span>';
            }

            return '<div class="cart-line" data-line="' + l.product_id + '">' +
                '<div class="cart-line-main">' +
                    '<span class="cart-name">' + escapeHtml(l.name) + '</span>' +
                    '<span class="cart-unit">' + cartLineNote(l) + '</span>' +
                '</div>' +
                '<button type="button" class="cart-remove" onclick="removeCartLine(' + l.product_id + ')" aria-label="Remove">&times;</button>' +
                '<div class="cart-qty">' +
                    '<button type="button" class="qty-btn" onclick="changeCartQty(' + l.product_id + ', -1)" aria-label="Less">&minus;</button>' +
                    '<input type="number" class="qty-input" inputmode="decimal" aria-label="Amount" ' +
                        'value="' + l.quantity + '" min="0" step="' + (lineAllowsFraction(l) ? '0.001' : '1') + '" ' +
                        'oninput="onCartQtyInput(' + l.product_id + ', this.value)" ' +
                        'onblur="onCartQtyBlur(' + l.product_id + ')" ' +
                        'onkeydown="if (event.key === \'Enter\') { event.preventDefault(); this.blur(); }">' +
                    '<button type="button" class="qty-btn" onclick="changeCartQty(' + l.product_id + ', 1)" aria-label="More">+</button>' +
                    unitBox +
                '</div>' +
                '<span class="cart-sub" data-line-sub="' + l.product_id + '">' + peso(lineSubtotal(l)) + '</span>' +
            '</div>';
        }).join('');
    }

    renderCartFigures();
    markCatalogRows();
}

// the catalog rows say what is already on the order, without being redrawn
function markCatalogRows() {
    document.querySelectorAll('#catalog-table tr[data-product-row]').forEach((row) => {
        const line = cart.find((l) => l.product_id === Number(row.dataset.productRow));
        row.classList.toggle('is-on-order', Boolean(line));
        const mark = row.querySelector('.on-order-mark');
        if (!mark) return;
        mark.hidden = !line;
        mark.textContent = line ? qtyText(line.quantity, line.unit) + ' on order' : '';
    });
}

// the figures alone, while an amount is being typed: rebuilding the line
// would take the cursor out of the box
function renderCartFigures() {
    cart.forEach((l) => {
        const sub = document.querySelector('[data-line-sub="' + l.product_id + '"]');
        if (sub) sub.textContent = peso(lineSubtotal(l));
        const row = document.querySelector('.cart-line[data-line="' + l.product_id + '"] .cart-unit');
        if (row) row.innerHTML = cartLineNote(l);
    });

    const t = cartTotals();
    const totals = document.getElementById('cart-totals');
    if (totals) {
        let html =
            '<div class="total-row"><span>Subtotal</span><span>' + peso(t.gross) + '</span></div>' +
            '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>';

        if (t.onCredit) {
            // credit: part paid now, the rest goes on the account
            html += '<div class="total-row"><span>Paid now</span><span>' + peso(t.down) + '</span></div>';
            if (t.onBook > 0) {
                html += '<div class="total-row total-short"><span>On account</span><span>' + peso(t.onBook) + '</span></div>';
            } else {
                html += '<div class="total-row total-change"><span>Paid in full</span><span>' + peso(t.onBook) + '</span></div>';
            }
        } else if (t.onAccount) {
            // cash on delivery: nothing is paid at the counter
            html += '<div class="total-row total-note"><span>Collected on delivery</span><span>' +
                    peso(t.due) + '</span></div>';
        } else {
            // paid now: show the money handed over, and the change (or how much is missing)
            html += '<div class="total-row"><span>Tendered</span><span>' + peso(t.tendered) + '</span></div>';
            if (t.tendered < t.due) {
                html += '<div class="total-row total-short"><span>Short by</span><span>' +
                        peso(t.due - t.tendered) + '</span></div>';
            } else {
                html += '<div class="total-row total-change"><span>Change</span><span>' +
                        peso(t.change) + '</span></div>';
            }
        }

        totals.innerHTML = html;
    }

    renderCreditVerdict(t);
    renderSalePaymentExtras(t);

    const button = document.getElementById('checkout-btn');
    if (button) {
        button.disabled = cart.length === 0 || (!t.onAccount && t.tendered < t.due);
        button.textContent = checkoutLabel(t);
    }

    // GCash or PayMaya taken now: the QR code is the other way to finish, and
    // needs no amount typed, as the code is for the bill (or the part paid) exactly
    const qrButton = document.getElementById('qr-pay-btn');
    if (qrButton) {
        qrButton.hidden = QR_METHODS.indexOf(methodTakenNow(t)) === -1;
        qrButton.disabled = cart.length === 0;
    }

    // a code on screen is for the old total; it is cancelled, not paid wrong
    qrAmountChanged('sale', t.onCredit ? t.down : t.due);
}

// The button says what pressing it does, so nobody books a sale to an
// account thinking they took the money for it.
function checkoutLabel(t) {
    if (t.method === 'COD') return 'Place COD Order';
    if (t.onCredit) {
        if (cart.length > 0 && t.onBook <= 0) return 'Complete Sale';
        return t.down > 0 ? 'Take Part Payment & Charge the Rest' : 'Charge to Account';
    }
    return 'Complete Sale';
}

// ---------- how the money arrives: its reference, and where a transfer goes ----------
// A cheque or a transfer is only money once it clears, and it is traced by its
// number, so those two need a reference before the sale is rung up. An
// e-wallet prints one too, taken when the cashier has it. Cash needs none.
const REFERENCE_REQUIRED = ['Cheque', 'Bank Transfer'];
const REFERENCE_OPTIONAL = ['GCash', 'PayMaya', 'PayPal'];

const REFERENCE_WORDS = {
    'Cheque':        { hint: 'required \u2014 the cheque number', placeholder: 'e.g. 001234' },
    'Bank Transfer': { hint: 'required \u2014 the bank\'s reference for the transfer', placeholder: 'e.g. FT2609230412' },
    'GCash':         { hint: 'optional \u2014 the GCash reference', placeholder: 'e.g. 1012 345 678901' },
    'PayMaya':       { hint: 'optional \u2014 the Maya reference', placeholder: 'e.g. 5A3F9C21' },
    'PayPal':        { hint: 'optional \u2014 the PayPal transaction ID', placeholder: 'e.g. 8TY12345AB678901C' }
};

// what the money taken today arrives by: the sale's own method, or on a
// Credit sale the part payment's; nothing is taken on COD, nor on credit
// with nothing paid now
function methodTakenNow(t) {
    if (t.onCredit) return t.down > 0 ? downPaymentMethod() : null;
    return t.method === 'COD' ? null : t.method;
}

function downPaymentMethod() {
    const form = document.getElementById('checkout-form');
    return form && form.elements.downPaymentMethod ? form.elements.downPaymentMethod.value : 'Cash';
}

// the reference typed, but only while the box is on screen
function saleReference() {
    const field = document.getElementById('sale-reference-field');
    const box = document.getElementById('sale-reference');
    return field && !field.hidden && box ? box.value.trim() : '';
}

// The shop's account, read from the settings the invoice uses. Asked for once
// when a transfer is first chosen; the box redraws when it arrives.
let bankSettingsAsked = false;

function bankSettingsReady(redraw) {
    if (storeSettings) return true;
    if (!bankSettingsAsked) {
        bankSettingsAsked = true;
        loadStoreSettings(false).then(redraw);
    }
    return false;
}

function bankBoxHtml(amount, note) {
    const shop = storeSettings || {};

    if (!shop.bank_account_number) {
        return '<p class="bank-box-title">No bank account on file</p>' +
            '<p class="bank-box-note">The shop\'s bank account has not been entered under Receipt ' +
            'Maintenance, so there is nowhere to tell the customer to send a transfer. Take another ' +
            'method, or ask the System Administrator to add the account.</p>';
    }

    return '<p class="bank-box-title">Send the transfer to</p>' +
        '<dl class="bank-box-grid">' +
            '<dt>Bank</dt><dd>' + escapeHtml(shop.bank_name) + '</dd>' +
            '<dt>Account name</dt><dd>' + escapeHtml(shop.bank_account_name) + '</dd>' +
            '<dt>Account number</dt><dd class="bank-box-number">' + escapeHtml(shop.bank_account_number) + '</dd>' +
            '<dt>Amount to send</dt><dd class="bank-box-amount">' + peso(amount) + '</dd>' +
        '</dl>' +
        (note ? '<p class="bank-box-note">' + note + '</p>' : '');
}

// the reference box and the bank account under the payment fields
function renderSalePaymentExtras(totals) {
    const t = totals || cartTotals();

    const taken = methodTakenNow(t);
    const field = document.getElementById('sale-reference-field');
    const words = REFERENCE_WORDS[taken];
    if (field) {
        field.hidden = !words;
        if (words) {
            const hint = document.getElementById('sale-reference-hint');
            if (hint) hint.textContent = words.hint;
            // not the browser's required: handleCheckout says which number it needs, in words
            const box = document.getElementById('sale-reference');
            if (box) box.placeholder = words.placeholder;
        }
    }

    const bank = document.getElementById('sale-bank-box');
    if (!bank) return;

    // on a credit sale the box follows the part payment's method even before
    // an amount is typed, so the cashier can read the account out as it is agreed
    const transfer = t.onCredit ? downPaymentMethod() === 'Bank Transfer' : t.method === 'Bank Transfer';
    bank.hidden = !transfer;
    if (!transfer) return;

    if (!bankSettingsReady(() => renderSalePaymentExtras())) {
        bank.innerHTML = '<p class="bank-box-note">Reading the shop\'s bank account...</p>';
        return;
    }

    const amount = t.onCredit ? t.down : t.due;
    bank.innerHTML = bankBoxHtml(amount,
        t.onCredit && amount <= 0
            ? 'Type what is paid now to see the amount to send.'
            : 'Once it is sent, type the bank\'s reference for it in the box below.');
}

// ---------- paying GCash or PayMaya by QR code ----------
// The customer scans a code instead of the cashier typing a reference. The
// code is made on the server (Connections/qr-payments.js) through PayMongo or
// its offline simulation, and holds the address of the page the customer pays
// on. The server is asked every three seconds, and at once when the live
// channel says a QR payment changed, whether it has been paid; only then is
// the sale or the payment sent, carrying the QR payment's id, and the server
// checks it again before recording anything.
const QR_METHODS = ['GCash', 'PayMaya'];
const QR_CHECK_MS = 3000;

// the code on screen, or null; one at a time
let qrSession = null;

// A QR payment the customer made that no sale took (the server refused the
// sale after the money was in: an item ran out). The next QR payment for the
// same amount uses it rather than charging the customer twice.
let qrPaidUnused = null;

const QR_APP_WORDS = { 'GCash': 'GCash', 'PayMaya': 'Maya' };

// a change to any QR payment: the code on screen is asked about straight away
if (typeof onLiveChange === 'function') {
    onLiveChange(['qr-payments'], () => { if (qrSession && !qrSession.over) checkQr(qrSession); });
}

// Pay by QR, beside Complete Sale: the same checkout, with the money taken by
// the code instead of typed in
function payByQr() {
    const form = document.getElementById('checkout-form');
    if (!form) return;
    return handleCheckout({ preventDefault: function () {}, target: form }, true);
}

// Shows a code for `amount` and waits. purpose is 'sale' or 'credit_payment'
// (then saleId is the sale being paid). Resolves to { id, reference, amount }
// once paid, or null when the cashier cancelled or chose another method (the
// reason already said on screen).
async function collectQrPayment(amount, what, method, purpose, saleId) {
    amount = Math.round(amount * 100) / 100;

    if (qrPaidUnused) {
        if (Math.abs(qrPaidUnused.amount - amount) < 0.005 && qrPaidUnused.wallet === method) {
            notifyInfo('The customer already paid ' + peso(amount) + ' by QR (' + qrPaidUnused.reference +
                '), so that payment is used. No new code is needed.', 'Using the earlier QR payment');
            return qrPaidUnused;
        }
        notifyWarning('A QR payment of ' + peso(qrPaidUnused.amount) + ' (' + qrPaidUnused.reference +
            ') was taken but never recorded. It is listed under QR Payments as needing a refund.',
            'An earlier QR payment is unused');
    }

    return new Promise((resolve) => {
        const session = {
            amount: amount, what: what, method: method,
            purpose: purpose || 'sale', saleId: saleId || null,
            id: null, resolve: resolve, ticker: null, poller: null, inflight: null,
            endsAt: 0, closing: false, over: false, done: false
        };
        qrSession = session;
        startQrCode(session);
    });
}

// Makes a code for the session (again, after New QR) and puts it on screen.
async function startQrCode(session) {
    session.id = null;
    session.over = false;
    session.closing = false;
    showQrCard(session, null);
    setQrStatus('Making the QR code...', '');
    if (!isModalOpen('qr-modal')) showModal('qr-modal');

    let made;
    try {
        const response = await apiCreateQrPayment({
            amount: session.amount, wallet: session.method,
            purpose: session.purpose, saleId: session.saleId
        });
        made = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, made)) {
                endQr(session, null);
                notifyError(made.error, 'No QR code');
            }
            return;
        }
    } catch (error) {
        endQr(session, null);
        notifyOffline();
        return;
    }
    if (session.done) return;

    session.id = made.id;
    session.endsAt = Date.now() + (Number(made.secondsLeft) || 600) * 1000;
    showQrCard(session, made);
    setQrStatus('Waiting for the customer to pay...', '');

    tickQr();
    session.ticker = setInterval(tickQr, 1000);
    session.poller = setInterval(() => { if (qrSession === session) checkQr(session); }, QR_CHECK_MS);
}

function isModalOpen(id) {
    const modal = document.getElementById(id);
    return Boolean(modal && modal.classList.contains('open'));
}

// the card's words, its badge, the code and the buttons; made is null while
// the code is being made
function showQrCard(session, made) {
    document.getElementById('qr-title').textContent = 'Pay by QR · ' + (QR_APP_WORDS[session.method] || session.method);
    document.getElementById('qr-sub').textContent = session.what;
    document.getElementById('qr-ask').textContent =
        'Ask the customer to scan the code with their phone\'s camera and pay with ' +
        (QR_APP_WORDS[session.method] || session.method) + '.';
    document.getElementById('qr-amount').textContent = peso(session.amount);

    const badge = made && made.badge;
    document.getElementById('qr-badge-line').hidden = !badge;
    document.getElementById('qr-badge').textContent = badge || '';

    const image = document.getElementById('qr-image');
    if (made) image.src = made.qrImage;
    else image.removeAttribute('src');

    const link = document.getElementById('qr-link');
    link.textContent = made ? made.payUrl : '';
    link.href = made ? made.payUrl : '#';
    link.parentElement.hidden = !made;

    document.getElementById('qr-clock').hidden = !made;
    document.querySelector('#qr-modal .qr-box').classList.remove('is-over');
    setQrButtons('waiting');
}

function setQrStatus(text, tone) {
    const box = document.getElementById('qr-status');
    if (!box) return;
    box.textContent = text;
    box.className = 'qr-status' + (tone ? ' ' + tone : '');
}

// waiting: Cancel. over (failed or ran out): Choose another method, New QR.
// busy: nothing can be pressed.
function setQrButtons(state) {
    const show = (id, visible, enabled) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.hidden = !visible;
        button.disabled = !enabled;
    };
    show('qr-cancel-btn', state !== 'over', state === 'waiting');
    show('qr-other-btn', state === 'over', true);
    show('qr-new-btn', state === 'over', true);
}

function stopQrTimers(session) {
    clearInterval(session.ticker);
    clearInterval(session.poller);
    session.ticker = null;
    session.poller = null;
}

// The card closes and the checking stops, whatever closed it; whoever is
// waiting on collectQrPayment hears the outcome.
function endQr(session, result) {
    if (session.done) return;
    session.done = true;
    stopQrTimers(session);
    if (qrSession === session) qrSession = null;
    closeModal('qr-modal');
    document.getElementById('qr-image').removeAttribute('src');
    session.resolve(result);
}

// Failed or ran out: the card stays, says why, and offers a new code or
// another way to pay. Nothing was recorded.
function qrOver(session, text) {
    stopQrTimers(session);
    session.over = true;
    document.querySelector('#qr-modal .qr-box').classList.add('is-over');
    document.getElementById('qr-clock').hidden = true;
    setQrStatus(text + ' Nothing was recorded.', 'is-stop');
    setQrButtons('over');
}

// paid: said on the card, which closes, and the sale or the payment goes on
function qrPaid(session, state) {
    stopQrTimers(session);
    session.over = true;
    setQrButtons('busy');
    setQrStatus('Payment received', 'is-good');
    // long enough to read before the card closes
    setTimeout(() => endQr(session, {
        id: session.id, reference: state.reference, amount: session.amount, wallet: session.method
    }), 700);
}

// One question to the server, acted on: paid, failed, ran out, or still
// waiting. A question already on its way is shared rather than sent twice.
// Gives back the status, or 'offline'.
function checkQr(session) {
    if (!session.id || session.done) return Promise.resolve('done');
    if (session.inflight) return session.inflight;

    session.inflight = apiGetQrPayment(session.id)
        .then((state) => {
            if (session.done || session.over) return state.status;

            if (state.status === 'paid') {
                qrPaid(session, state);
            } else if (state.status === 'failed') {
                qrOver(session, 'The payment failed' + (state.errorMessage ? ': ' + state.errorMessage : '.'));
            } else if (state.status === 'expired') {
                qrOver(session, 'The QR code expired before it was paid.');
            } else if (state.status === 'cancelled') {
                endQr(session, null);
            } else {
                // the server's clock decides; the countdown follows it
                session.endsAt = Date.now() + (Number(state.secondsLeft) || 0) * 1000;
                if (!session.closing) {
                    setQrStatus(state.checkError
                        ? 'The payment provider cannot be reached just now. Still trying...'
                        : 'Waiting for the customer to pay...', state.checkError ? 'is-stop' : '');
                }
            }
            return state.status;
        })
        .catch(() => {
            if (!session.done && !session.closing && !session.over) {
                setQrStatus('The server cannot be reached just now. Still trying...', 'is-stop');
            }
            return 'offline';
        })
        .finally(() => { session.inflight = null; });
    return session.inflight;
}

// The countdown is only the screen's: the server decides when the code has
// run out, so at zero it is asked at once.
function tickQr() {
    const session = qrSession;
    if (!session || session.closing || session.over) return;

    const left = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
    const clock = document.getElementById('qr-countdown');
    if (clock) {
        clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
        clock.parentElement.classList.toggle('is-ending', left <= 60);
    }
    if (left === 0) checkQr(session);
}

// Cancel asks the server to close the code, which looks once more first: a
// payment that already went through is recorded rather than abandoned.
async function cancelQrPayment(reason) {
    const session = qrSession;
    if (!session || session.closing || session.done) return;
    session.closing = true;
    stopQrTimers(session);
    setQrButtons('busy');
    setQrStatus('Making sure nothing was paid...', '');

    if (!session.id) { endQr(session, null); return; }
    if (session.inflight) await session.inflight;
    if (session.done) return;

    let ended = null;
    try {
        const response = await apiCancelQrPayment(session.id);
        ended = await response.json();
        if (!response.ok) {
            handleAuthFailure(response, ended);
            ended = null;
        }
    } catch (error) {
        ended = null;
    }

    if (ended && ended.status === 'paid') {
        notifyInfo('The customer had already paid, so the payment is being recorded.', 'Already paid');
        session.closing = false;
        qrPaid(session, ended);
        return;
    }
    if (!ended) {
        // the server did not answer; the code is left to run out on its own
        notifyWarning('The server could not be reached to cancel the QR code. It closes by itself when ' +
            'its time runs out; check QR Payments before taking the money another way.', 'Not cancelled');
    } else {
        notifyInfo(reason || 'The QR payment was cancelled, so nothing was recorded.', 'QR payment cancelled');
    }
    endQr(session, null);
}

// after a failed or expired code
function newQrCode() {
    const session = qrSession;
    if (!session || !session.over) return;
    startQrCode(session);
}

function chooseAnotherMethod() {
    const session = qrSession;
    if (!session) return;
    endQr(session, null);
    notifyInfo('Pick another payment method, or press Pay by QR to try again.', 'Nothing was recorded');
}

// The code is for one amount. If what is owed changes while it is on screen
// (the order or the payment typed), it is cancelled rather than paid wrong.
function qrAmountChanged(purpose, amountNow) {
    const session = qrSession;
    if (!session || session.purpose !== purpose || session.done || session.over || session.closing) return;
    if (Math.abs(Math.round(amountNow * 100) / 100 - session.amount) < 0.005) return;
    cancelQrPayment('The amount changed while the QR code was open, so the code was cancelled. ' +
        'Press Pay by QR again for the new amount.');
}

// Leaving the page with a code on screen: the browser asks first, and if the
// cashier goes anyway the checking stops with the page.
window.addEventListener('beforeunload', (event) => {
    if (!qrSession) return;
    event.preventDefault();
    event.returnValue = '';
});
window.addEventListener('pagehide', () => {
    if (qrSession) stopQrTimers(qrSession);
});

// After the customer has paid, a refusal from the server leaves the money in
// and nothing recorded. Unless the refusal was about the payment itself, it is
// kept for the next try and the cashier is told so.
function keepUnusedQr(qr, result) {
    const code = result && result.code;
    if (code === 'QR_USED' || code === 'QR_AMOUNT' || code === 'QR_NOT_PAID' ||
        code === 'QR_UNKNOWN' || code === 'QR_WALLET') return '';
    qrPaidUnused = qr;
    return ' The customer\'s QR payment of ' + peso(qr.amount) + ' (' + qr.reference + ') is kept: ' +
        'put things right and press Pay by QR again, and it is used without a new code. ' +
        'Until then QR Payments lists it as needing a refund.';
}

function onPaymentMethodChange(method) {
    const tender = document.getElementById('tender-field');
    const down = document.getElementById('downpayment-field');

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    // only one of the tender box and the down payment box is ever shown
    if (tender) tender.style.display = onAccount ? 'none' : 'block';
    if (down) down.style.display = onCredit ? 'block' : 'none';

    renderCart();
}

// Credit at the counter: the account is read when the customer is picked and
// printed above the payment fields rather than raised as an error after.
let selectedCustomerCredit = null;

async function onCustomerChange(customerId) {
    const strip = document.getElementById('credit-strip');
    selectedCustomerCredit = null;

    if (!customerId) {
        if (strip) strip.style.display = 'none';
        renderCart();
        return;
    }

    try {
        const data = await apiGetCreditCustomer(customerId);
        selectedCustomerCredit = data.credit;
        renderCreditStrip();
    } catch (error) {
        if (strip) strip.style.display = 'none';
    }

    renderCart();
}

function renderCreditStrip() {
    const strip = document.getElementById('credit-strip');
    if (!strip) return;

    const c = selectedCustomerCredit;
    if (!c) { strip.style.display = 'none'; return; }

    const owed = Number(c.current_credit) || 0;
    const available = Number(c.available_credit) || 0;

    let tone;
    if (c.standing === 'Hold') {
        tone = 'is-stop';
    } else if (c.standing === 'Watch' || available <= 0) {
        tone = 'is-watch';
    } else {
        tone = 'is-good';
    }

    let availableText = peso(available);
    if (c.standing === 'Hold') {
        availableText = 'Nothing &mdash; on hold';
    }

    // a short note: why the account is not in good standing, or the manager's notes
    let note = '';
    if (c.standing !== 'Good' && c.standing_reason) {
        note = '<p class="credit-strip-note">' + escapeHtml(c.standing_reason) + '</p>';
    } else if (c.credit_notes) {
        note = '<p class="credit-strip-note">' + escapeHtml(c.credit_notes) + '</p>';
    }

    strip.className = 'credit-strip ' + tone;
    strip.style.display = 'block';
    strip.innerHTML =
        '<div class="credit-strip-row">' +
            '<span class="credit-strip-label">Credit Limit</span>' +
            '<span class="credit-strip-value">' + peso(c.credit_limit) + '</span>' +
        '</div>' +
        '<div class="credit-strip-row">' +
            '<span class="credit-strip-label">Balance</span>' +
            '<span class="credit-strip-value">' + peso(owed) + '</span>' +
        '</div>' +
        '<div class="credit-strip-row credit-strip-main">' +
            '<span class="credit-strip-label">Available Balance</span>' +
            '<span class="credit-strip-value">' + availableText + '</span>' +
        '</div>' +
        note;
}

// what will happen if this sale is completed as it stands, before the button
function renderCreditVerdict(totals) {
    const box = document.getElementById('credit-verdict');
    if (!box) return;

    const t = totals || cartTotals();

    if (!t.onCredit) { box.textContent = ''; box.className = 'credit-verdict'; return; }

    if (!selectedCustomerCredit) {
        box.className = 'credit-verdict is-watch';
        box.textContent = 'A credit sale is settled later, so it has to be booked against a named customer.';
        return;
    }

    const c = selectedCustomerCredit;
    const available = Number(c.available_credit) || 0;
    const name = c.customer_name;

    if (t.onBook === 0) {
        box.className = 'credit-verdict is-good';
        box.innerHTML = 'Paid in full at the counter. Nothing goes on ' + escapeHtml(name) + "'s account.";
        return;
    }

    if (c.standing === 'Hold') {
        box.className = 'credit-verdict is-stop';
        box.innerHTML = escapeHtml(name) + ' is <strong>on hold</strong> and cannot take new credit. ' +
            'Take the full ' + peso(t.due) + ' now, or ask a manager to lift the hold.';
        return;
    }

    if (t.onBook > available) {
        const short = t.onBook - available;
        box.className = 'credit-verdict is-stop';
        box.innerHTML = 'Over the limit by <strong>' + peso(short) + '</strong>. ' +
            'Take at least ' + peso((t.down || 0) + short) + ' now, or ask for a higher limit ' +
            'from <kbd>Customers Record</kbd>.';
        return;
    }

    box.className = 'credit-verdict is-good';
    box.innerHTML = peso(t.onBook) + ' goes on ' + escapeHtml(name) + "'s account, leaving " +
        peso(available - t.onBook) + ' of their limit.';
}

function fillDownPayment(share) {
    const form = document.getElementById('checkout-form');
    if (!form || !form.elements.downPayment) return;

    const t = cartTotals();
    form.elements.downPayment.value = (t.due * share).toFixed(2);
    renderCart();
}

// ---------- checkout ----------
// viaQr: pressed as Pay by QR; the money is taken by the QR code
async function handleCheckout(event, viaQr) {
    event.preventDefault();
    if (cart.length === 0) {
        notifyWarning('Add at least one item before completing the sale.', 'The order is empty');
        return;
    }

    const form = event.target;
    const t = cartTotals();
    const typedName = typedCustomerName();

    // a settled-later sale needs a customer, not just a walk-in
    if (t.onAccount && !form.elements.customerId.value && typedName === '') {
        notifyWarning(
            'A ' + t.method + ' sale is settled later, so it has to be booked against a customer. '
            + 'Type their name.',
            'Name the customer');
        const box = customerNameBox();
        if (box) box.focus();
        return;
    }

    if (!t.onAccount && !viaQr && t.tendered < t.due) {
        notifyWarning('The amount entered is less than the amount due.', 'Sale not completed');
        return;
    }

    // a cheque or a transfer is traced by its number; the server refuses one without it too
    const taken = methodTakenNow(t);
    const reference = saleReference();
    if (REFERENCE_REQUIRED.indexOf(taken) !== -1 && reference === '') {
        notifyWarning(
            (t.onCredit ? 'The part payment is by ' + taken.toLowerCase() + ', so it' : 'A ' + taken.toLowerCase() + ' sale') +
            ' needs its reference: ' + (taken === 'Cheque' ? 'the cheque number' : 'the bank\'s reference for the transfer') +
            '. It is how the money is traced if it does not arrive.',
            'Reference needed');
        const box = document.getElementById('sale-reference');
        if (box) box.focus();
        return;
    }

    // A typed name that matches nobody goes on the books as it is rung up, so
    // every named buyer is in Customers Record without a second step.
    let customerId;
    if (form.elements.customerId.value) {
        customerId = parseInt(form.elements.customerId.value, 10);
    } else {
        customerId = null;
    }

    if (!customerId && typedName !== '') {
        const created = await createCustomerFromCounter(typedName);
        if (created === false) return;      // the server refused; nothing was sold
        customerId = created;
    }

    // a part-paid credit sale leaves money on the account; the server checks the limit again
    if (t.onCredit && t.onBook > 0) {
        let name;
        if (selectedCustomerCredit) {
            name = selectedCustomerCredit.customer_name;
        } else {
            name = 'this customer';
        }

        const yes = await askConfirm(
            peso(t.onBook) + ' of this sale goes on ' + name + "'s account.",
            {
                title: t.down > 0 ? 'Take part payment and book the rest?' : 'Put this sale on account?',
                eyebrow: 'Point of Sale',
                confirmLabel: t.down > 0 ? 'Take ' + peso(t.down) + ' and book the rest' : 'Book it to their account',
                detail: [
                    'Taken at the counter now: ' + peso(t.down) + '.',
                    'Added to what they owe: ' + peso(t.onBook) + '.',
                    'The receipt shows both, and the balance appears on their credit page.'
                ]
            });

        if (!yes) return;
    }

    // the name typed is kept only when there is no account;
    // a named customer already lives in the customers table
    let walkInName = null;
    if (!customerId) {
        walkInName = typedName || null;
    }

    // how much money is taken now
    let amountPaid = t.tendered;
    if (t.onCredit) {
        amountPaid = t.down;
    } else if (t.onAccount) {
        amountPaid = 0;
    } else if (viaQr) {
        // the code is for the bill exactly: no change
        amountPaid = t.due;
    }

    let downPaymentMethod = 'Cash';
    if (form.elements.downPaymentMethod) {
        downPaymentMethod = form.elements.downPaymentMethod.value;
    }

    // by QR code: the customer pays first, and the sale is sent only once the
    // payment is in
    let qr = null;
    if (viaQr) {
        if (QR_METHODS.indexOf(taken) === -1) return;
        qr = await collectQrPayment(amountPaid, t.onCredit ? 'Paid now on this credit sale' : 'For this sale', taken, 'sale');
        if (!qr) return;
    }

    // the cart lines; quantity is in the unit named, and a plain line names no unit
    const items = [];
    for (const l of cart) {
        let unit = null;
        if (!lineChoice(l).own) {
            unit = lineChoice(l).unit_name;
        }
        items.push({ product_id: l.product_id, quantity: l.quantity, unit: unit });
    }

    const data = {
        customerId: customerId,
        walkInName: walkInName,
        discount: t.discount,
        amountPaid: amountPaid,
        paymentMethod: t.method,
        downPaymentMethod: downPaymentMethod,
        referenceNo: qr ? null : reference || null,
        qrPaymentId: qr ? qr.id : null,
        items: items
    };

    try {
        const response = await apiSaveSale(data);
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                notifyError(result.error + (qr ? keepUnusedQr(qr, result) : ''), qr ? 'Sale not completed' : undefined);
            }
            return;
        }
        if (qr) qrPaidUnused = null;

        // the delivery is written against the sale before the till is cleared, so a
        // failure is reported while the details are still on screen
        const booked = await bookAttachedDelivery(result.saleId);

        // the sale stands; a reference the server could not keep is said, not hidden
        if (result.referenceNote) notifyWarning(result.referenceNote, 'Reference not saved');

        cart = [];
        form.elements.amountPaid.value = '';
        if (form.elements.downPayment) form.elements.downPayment.value = '';
        if (form.elements.referenceNo) form.elements.referenceNo.value = '';

        if (booked) { pendingDelivery = null; renderDeliveryAttached(); }

        if (customerId) {
            customerDirectoryLoaded = false;
            await loadCustomerDirectory(true);
            await onCustomerChange(String(customerId));
        } else {
            await clearCustomer();
        }

        catalogLoaded = false;
        renderCart();
        if (catalogMode !== 'idle') { await ensureCatalogLoaded(true); applyCatalogView(); }
        else renderCatalogEmpty();

        await openReceipt(result.saleId);
    } catch (error) {
        // the sale may or may not have been saved; trying again either uses
        // the payment or is told it is already on a sale
        if (qr) qrPaidUnused = qr;
        notifyOffline();
    }
}

// The counter's half of opening an account: the record only, limit zero,
// with the phone and address from the attached delivery when there is one.
// The server hands back an existing account when the name is already on the
// books. Returns the customer id, or false when the server refused (which
// stops the sale).
async function createCustomerFromCounter(fullName) {
    const parts = String(fullName).trim().split(/\s+/);
    const firstName = parts.shift();
    const lastName = parts.join(' ');

    try {
        const response = await apiCreateCustomer({
                firstName: firstName,
                lastName: lastName,
                phone: pendingDelivery && pendingDelivery.contactPhone ? pendingDelivery.contactPhone : '',
                address: pendingDelivery ? pendingDelivery.address : ''
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Account not created');
            return false;
        }

        if (result.created) notifySuccess(result.message, 'Customer recorded');

        customerDirectoryLoaded = false;
        await loadCustomerDirectory(true);

        const idBox = customerIdBox();
        if (idBox) idBox.value = String(result.customerId);
        await onCustomerChange(String(result.customerId));
        renderCustomerVerdict();

        return result.customerId;
    } catch (error) {
        notifyOffline();
        return false;
    }
}

// ---------- receipt ----------
// The invoice (RR 7-2024: an Official Receipt is no longer the primary
// document for goods). The OR- numbering stays as this system's reference.
// Posted prices include VAT, so it is extracted from the total, and the split
// is read off the sale as recorded on the day. A non-VAT shop prints no VAT
// block.
let storeSettings = null;

async function loadStoreSettings(force) {
    if (storeSettings && !force) return storeSettings;

    try {
        storeSettings = await apiGetStoreSettings();
    } catch (error) {
        // not fatal: a placeholder header is better than no invoice
        storeSettings = null;
    }

    return storeSettings;
}

function receiptTaxBlock(sale) {
    const registration = sale.tax_registration || 'VAT';
    const rate = Number(sale.vat_rate) || 0;

    if (registration !== 'VAT') {
        // percentage tax is paid by the shop, not charged to the customer; only the base is shown
        return '<div class="rc-tax">' +
            '<div><span>Sales Subject to Percentage Tax</span><span>' +
                peso(Number(sale.final_amount) - Number(sale.vat_exempt_sale || 0)) + '</span></div>' +
            '<div><span>Exempt Sales</span><span>' + peso(sale.vat_exempt_sale) + '</span></div>' +
            '</div>';
    }

    return '<div class="rc-tax">' +
        '<div><span>VATable Sale</span><span>' + peso(sale.vatable_sale) + '</span></div>' +
        '<div><span>VAT (' + rate.toFixed(0) + '%)</span><span>' + peso(sale.vat_amount) + '</span></div>' +
        '<div><span>VAT-Exempt Sale</span><span>' + peso(sale.vat_exempt_sale) + '</span></div>' +
        '<div><span>Zero-Rated Sale</span><span>' + peso(sale.zero_rated_sale) + '</span></div>' +
        '</div>';
}

// "3" or "3 (2 lines)"; a measured line counts as one item
// the number of pieces bought, shown beside Total Due; a measured line
// (kg, m) counts as one item
function receiptItemCount(items) {
    const list = Array.isArray(items) ? items : [];
    const units = pieceCount(list);
    return Number.isInteger(units) ? String(units) : units.toFixed(2);
}

async function openReceipt(saleId) {
    let data;
    try { data = await apiGetSale(saleId); }
    catch (error) {
        notifyWarning('The sale was saved, but the invoice could not be opened.', 'Invoice unavailable');
        return;
    }

    await loadStoreSettings(false);

    lastReceipt = data;
    const s = data.sale;
    const receiptNo = 'OR-' + String(s.sale_id).padStart(6, '0');

    // the header comes from the settings row so one installation is one shop
    const shop = storeSettings || {};

    document.getElementById('receipt-heading').textContent = 'Invoice ' + receiptNo;
    const itemsHtml = data.items.map((it) =>
            '<tr><td>' + escapeHtml(it.product_name) + '<br><span class="rc-qty">' +
            escapeHtml(qtyText(it.quantity, it.unit_name)) +
            // a size shows what it came to on the shelf: "2 sack (50 kg)"
            (it.base_unit && it.unit_name && it.base_unit !== it.unit_name
                ? ' (' + escapeHtml(qtyText(it.base_quantity, it.base_unit)) + ')' : '') +
            ' x ' + peso(it.unit_price) +
            (isMeasuredUnit(it.unit_name) ? '/' + escapeHtml(measuredUnit(it.unit_name).short) : '') + '</span></td>' +
            '<td class="rc-amt">' + peso(it.subtotal) + '</td></tr>').join('');

    const totals = [{ label: 'Subtotal', value: peso(s.total_amount) }];
    // only when there was one; older sales still carry real figures
    if (Number(s.discount) > 0) totals.push({ label: 'Discount', value: peso(s.discount) });
    totals.push({ label: 'Total Due', value: peso(s.final_amount), due: true });
    // a late-payment penalty, when one has been charged since the sale
    if (Number(s.penalty_amount) > 0) {
        totals.push({
            label: 'Late Penalty (' + penaltyRateWord(s.penalty_rate) + '/mo \u00d7 ' + s.penalty_months + ')',
            value: peso(s.penalty_amount)
        });
    }
    totals.push({ label: 'Tendered', value: peso(s.amount_paid) });
    totals.push({ label: 'Change', value: peso(s.change_given) });

    const paper = document.getElementById('receipt-paper');
    applyReceiptPaper(paper, shop);
    paper.innerHTML = receiptHtml(shop, {
        registration: s.tax_registration,
        receiptNo: receiptNo,
        meta: [
            { key: 'date', label: 'Date', value: s.sale_date },
            { key: 'cashier', label: 'Cashier', value: s.cashier_name },
            { key: 'customer', label: 'Customer', value: s.customer_name },
            { key: 'payment', label: 'Payment', value: s.payment_method },
            { key: 'reference', label: 'Reference', value: s.reference_no }
        ],
        itemsHtml: itemsHtml,
        itemCount: receiptItemCount(data.items),
        totals: totals,
        taxHtml: receiptTaxBlock(s),
        paid: s.payment_status === 'Paid',
        balanceText: s.payment_status.toUpperCase() + ' BALANCE ' + peso(saleAmountDue(s) - Number(s.amount_paid)),
        bankHtml: receiptBankBlock(shop, s, data.payments, receiptNo)
    });

    showModal('receipt-modal');
}

// The shop's account on the invoice: as a record when the sale was paid by
// transfer, and as the way to pay when it leaves a balance, with the invoice
// number to quote so the money can be matched to this sale when it lands.
function receiptBankBlock(shop, sale, payments, receiptNo) {
    if (!shop || !shop.bank_account_number) return '';

    const byTransfer = sale.payment_method === 'Bank Transfer' ||
        (payments || []).some((p) => p.payment_method === 'Bank Transfer');
    const balance = saleAmountDue(sale) - Number(sale.amount_paid);
    const owing = sale.payment_status !== 'Paid' && balance > 0.004;

    if (!byTransfer && !owing) return '';

    return '<div class="rc-rule"></div>' +
        '<div class="rc-bank">' +
            '<p class="rc-bank-head">' + (owing ? 'Pay the balance by bank transfer' : 'Paid by bank transfer') + '</p>' +
            '<div><span>Bank</span><span>' + escapeHtml(shop.bank_name) + '</span></div>' +
            '<div><span>Account name</span><span>' + escapeHtml(shop.bank_account_name) + '</span></div>' +
            '<div><span>Account no.</span><span>' + escapeHtml(shop.bank_account_number) + '</span></div>' +
            (owing
                ? '<p class="rc-bank-note">Quote <strong>' + escapeHtml(receiptNo) + '</strong> as the transfer ' +
                  'reference, so the payment is matched to this invoice.</p>'
                : '') +
        '</div>';
}

function printReceipt() {
    setReceiptPageSize(storeSettings || {});
    document.body.classList.add('printing-receipt');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-receipt'); }, 400);
}

// Make a delivery: filled in beside the order, held as pendingDelivery on
// this screen, and posted by handleCheckout once a sale id comes back.
// The booked date is not asked for: the server takes it from the sale.
function deliveryFormFields() {
    const form = document.getElementById('make-delivery-form');
    return form ? form.elements : null;
}

// what the customer box and record already know
function fillDeliveryFromCustomer() {
    const fields = deliveryFormFields();
    if (!fields) return;

    const id = selectedCustomerId();
    const account = id ? customerDirectory.find((c) => c.id === id) : null;

    fields.contactName.value = account ? account.name : typedCustomerName();
    phoneFill(fields.contactPhone, account && account.phone ? account.phone : '');
    fields.address.value = account && account.address ? account.address : '';
}

// The driver box: type to search the active drivers, pick one from the list.
// Left empty, the delivery stays open for any driver to take. The roster is
// read fresh each time the form opens, so a driver added or switched off since is right.
let driverRoster = [];
let driverSuggestHighlight = -1;
let pickedDriverName = null;

function driverIdField() {
    const fields = deliveryFormFields();
    return fields ? fields.driverStaffId : null;
}

function setDriverPick(driver) {
    const box = document.getElementById('dl-driver');
    const id = driverIdField();
    const clear = document.getElementById('driver-clear');

    pickedDriverName = driver ? driver.full_name : null;
    if (box) box.value = driver ? driver.full_name : '';
    if (id) id.value = driver ? String(driver.staff_id) : '';
    if (clear) clear.hidden = !driver;
}

async function fillDriverPicker(chosenId, chosenName) {
    setDriverPick(chosenId ? { staff_id: chosenId, full_name: chosenName } : null);
    hideDriverSuggestions();

    try {
        driverRoster = await apiGetDeliveryDrivers();
    } catch (error) {
        driverRoster = [];   // offline: the delivery can still be left open
    }
}

function onDriverInput(text) {
    const id = driverIdField();

    // typing over a picked name un-picks it
    if (id && id.value && text !== pickedDriverName) {
        id.value = '';
        pickedDriverName = null;
        const clear = document.getElementById('driver-clear');
        if (clear) clear.hidden = true;
    }

    renderDriverSuggestions(id && id.value ? '' : text);
}

// an empty box lists every driver; typing narrows it, first names first
function renderDriverSuggestions(text) {
    const list = document.getElementById('driver-suggest');
    const box = document.getElementById('dl-driver');
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    driverSuggestHighlight = -1;

    const found = query === ''
        ? driverRoster
        : driverRoster.filter((d) => String(d.full_name).toLowerCase().startsWith(query))
            .concat(driverRoster.filter((d) => {
                const name = String(d.full_name).toLowerCase();
                return !name.startsWith(query) && startsAWord(name, query);
            }));

    if (found.length === 0) {
        list.innerHTML = '<li class="suggest-item is-empty" role="option" aria-disabled="true">' +
            '<span class="suggest-note">' + (driverRoster.length === 0
                ? 'No active drivers to assign'
                : 'No driver by that name') + '</span></li>';
    } else {
        list.innerHTML = found.map((d, i) =>
            '<li class="suggest-item" role="option" id="driver-suggest-' + i + '" ' +
                'onmousedown="event.preventDefault()" ' +
                'onclick="pickDriver(' + d.staff_id + ')">' +
                '<span class="suggest-name">' + escapeHtml(d.full_name) + '</span>' +
            '</li>').join('');
    }

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideDriverSuggestions() {
    const list = document.getElementById('driver-suggest');
    const box = document.getElementById('dl-driver');
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    driverSuggestHighlight = -1;
}

function pickDriver(staffId) {
    const driver = driverRoster.find((d) => d.staff_id === staffId);
    if (!driver) return;
    setDriverPick(driver);
    hideDriverSuggestions();
}

function clearDriverPick() {
    setDriverPick(null);
    const box = document.getElementById('dl-driver');
    if (box) box.focus();
}

function onDriverKey(event) {
    const list = document.getElementById('driver-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item:not(.is-empty)');

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        driverSuggestHighlight = (driverSuggestHighlight + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === driverSuggestHighlight));
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[driverSuggestHighlight >= 0 ? driverSuggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape' || event.key === 'Tab') hideDriverSuggestions();
}

function openDeliveryForm() {
    const fields = deliveryFormFields();
    if (!fields) return;

    if (pendingDelivery) {
        fields.contactName.value = pendingDelivery.contactName;
        phoneFill(fields.contactPhone, pendingDelivery.contactPhone);
        fields.address.value = pendingDelivery.address;
        fields.scheduledDate.value = pendingDelivery.scheduledDate;
        fields.remarks.value = pendingDelivery.remarks;
    } else {
        fields.scheduledDate.value = '';
        fields.remarks.value = '';
        fillDeliveryFromCustomer();
    }
    fillDriverPicker(pendingDelivery ? pendingDelivery.driverId : null,
                     pendingDelivery ? pendingDelivery.driverName : null);

    const drop = document.getElementById('delivery-drop');
    if (drop) drop.hidden = !pendingDelivery;

    const sub = document.getElementById('delivery-modal-sub');
    if (sub) {
        if (cart.length === 0) {
            sub.textContent = 'Add items to the order first';
        } else {
            sub.textContent = 'Booked when you complete this sale';
        }
    }

    const verdict = document.getElementById('delivery-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }

    showModal('delivery-modal');
    setTimeout(() => { if (fields.contactName) fields.contactName.focus(); }, 60);
}

function saveDeliveryForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = deliveryFormFields();
    const verdict = document.getElementById('delivery-verdict');
    if (!fields) return;

    const complain = (text) => {
        if (verdict) {
            verdict.className = 'delivery-verdict is-stop';
            verdict.textContent = text;
        }
    };

    const contactName = fields.contactName.value.trim();
    const contactPhone = phoneToStore(fields.contactPhone);
    const phoneProblem = phoneComplaint(fields.contactPhone);
    const address = fields.address.value.trim();
    const scheduledDate = fields.scheduledDate.value;

    if (contactName === '') { complain('A delivery needs somebody to ask for at the gate.'); fields.contactName.focus(); return; }
    if (contactPhone === '') { complain('A driver who cannot ring ahead is a driver who comes back with the goods.'); fields.contactPhone.focus(); return; }
    if (phoneProblem) { complain(phoneProblem); fields.contactPhone.focus(); return; }
    if (address === '') { complain('A delivery needs somewhere to go.'); fields.address.focus(); return; }

    // a slot in the past is almost always a typing slip in the year or month
    if (scheduledDate && new Date(scheduledDate).getTime() < Date.now() - 60000) {
        complain('That slot has already passed. Check the date and time before attaching it.');
        fields.scheduledDate.focus();
        return;
    }

    // a name typed but never picked would silently leave the delivery open
    const driverBox = document.getElementById('dl-driver');
    const driverId = fields.driverStaffId && fields.driverStaffId.value ? Number(fields.driverStaffId.value) : null;
    const driverName = driverId && driverBox ? driverBox.value : null;
    if (!driverId && driverBox && driverBox.value.trim() !== '') {
        complain('Pick the driver from the list, or clear the box to leave the delivery open for any driver.');
        driverBox.focus();
        return;
    }

    pendingDelivery = {
        contactName: contactName,
        contactPhone: contactPhone,
        address: address,
        scheduledDate: scheduledDate,
        remarks: fields.remarks.value.trim(),
        driverId: driverId,
        driverName: driverName,
        edited: true
    };

    closeModal('delivery-modal');
    renderDeliveryAttached();
    notifyInfo('It will be booked when you complete this sale.', 'Delivery attached');
}

// Cancel closes the form and leaves whatever was already attached alone;
// Remove Delivery is what removes it.
function cancelDeliveryForm() {
    closeModal('delivery-modal');

    const verdict = document.getElementById('delivery-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

function dropDeliveryForm() {
    pendingDelivery = null;
    closeModal('delivery-modal');
    renderDeliveryAttached();
}

// the strip above the buttons
function renderDeliveryAttached() {
    const strip = document.getElementById('delivery-attached');
    const button = document.getElementById('make-delivery-btn');

    if (button) button.textContent = pendingDelivery ? 'Edit Delivery' : 'Make a Delivery';

    if (!strip) return;

    if (!pendingDelivery) { strip.hidden = true; strip.innerHTML = ''; return; }

    const d = pendingDelivery;
    strip.hidden = false;
    strip.innerHTML =
        '<div class="delivery-attached-head">' +
            '<span class="delivery-attached-title">Delivery attached</span>' +
            '<button type="button" class="delivery-attached-drop" onclick="dropDeliveryForm()" ' +
                    'aria-label="Remove the delivery">&times;</button>' +
        '</div>' +
        '<p class="delivery-attached-line"><strong>' + escapeHtml(d.contactName) + '</strong>' +
            ' &middot; ' + escapeHtml(phoneForDisplay(d.contactPhone)) + '</p>' +
        '<p class="delivery-attached-line">' + escapeHtml(d.address) + '</p>' +
        '<p class="delivery-attached-line delivery-attached-when">' +
            (d.scheduledDate
                ? 'Scheduled for ' + escapeHtml(String(d.scheduledDate).replace('T', ' '))
                : 'No slot agreed yet') +
        '</p>' +
        '<p class="delivery-attached-line">' +
            (d.driverId ? 'Driver: ' + escapeHtml(d.driverName) : 'Open for any driver to take') +
        '</p>';
}

// posted once the sale exists; a failure here does not undo the sale
async function bookAttachedDelivery(saleId) {
    if (!pendingDelivery) return true;

    const d = pendingDelivery;

    try {
        const response = await apiBookDelivery({
                saleId: saleId,
                address: d.address,
                contactName: d.contactName,
                contactPhone: d.contactPhone,
                scheduledDate: d.scheduledDate || null,
                remarks: d.remarks || null,
                driverStaffId: d.driverId || null
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                notifyError('Sale #' + saleId + ' went through, but the delivery did not book: ' +
                    (result.error || 'the server refused it') +
                    '. Book it again from this sale once that is sorted.',
                    'Sale saved, delivery not booked');
            }
            return false;
        }

        notifySuccess(result.message, 'Delivery created');
        return true;
    } catch (error) {
        notifyError('Sale #' + saleId + ' went through, but the delivery could not be sent to the ' +
            'server. Nothing is booked for it yet.', 'Sale saved, delivery not booked');
        return false;
    }
}

// Delivery tracking: read only, empty until the search box or Load Data asks.
function buildDeliveryPanel() {
    createDataPanel({
        key: 'cash-deliveries',
        tableId: 'cdel-table',
        columns: 6,
        pageSize: CASHIER_ROWS_PER_PAGE,
        pagerId: 'cdel-pager',
        idField: 'delivery_id',
        filters: { status: 'all' },

        gate: {
            title: 'No deliveries loaded',
            text: 'Search for a customer, an address or a sale number, or press Load Data to read them all.',
            button: 'Load Data'
        },

        load: () => apiGetDeliveries(),

        match: (row, query) => prefixMatch([
            row.customer_name, row.delivery_address, row.status,
            row.sale_id, '#' + row.sale_id, row.delivery_id, '#' + row.delivery_id
        ], query),

        filter: (row, filters) => filters.status === 'all' || row.status === filters.status,

        onLoaded: (rows) => renderDeliveryLegend(rows),

        renderRow: (row, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
            'onclick="openCashierDeliveryDetail(' + row.delivery_id + ')">' +
            '<td class="cell-id">#' + row.delivery_id + '</td>' +
            '<td class="cell-id">#' + row.sale_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
            '<td>' + escapeHtml(row.delivery_address) + '</td>' +
            '<td class="cell-id">' + escapeHtml(scheduleText(row.scheduled_date)) + '</td>' +
            '<td>' + statusBadge(row.status) + '</td></tr>'
    });
}

// midnight is what a date-only schedule became, so it is shown as a plain day
function scheduleText(stamp) {
    if (!stamp) return 'Not set';

    const text = String(stamp).replace('T', ' ');
    const day = text.slice(0, 10);
    const time = text.slice(11, 16);

    if (time === '' || time === '00:00') return day;
    return day + ' ' + time;
}

function renderDeliveryLegend(rows) {
    const legend = document.getElementById('cdel-legend');
    if (!legend) return;

    if (!rows || rows.length === 0) { legend.innerHTML = ''; return; }

    legend.innerHTML = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed'].map((stage) => {
        const count = rows.filter((d) => d.status === stage).length;
        return '<span class="track-chip"><span class="track-count">' + count + '</span>' + stage + '</span>';
    }).join('');
}

function clearDeliveryPanel() {
    const panel = getDataPanel('cash-deliveries');
    if (panel) panel.reset();

    const search = document.getElementById('cdel-search');
    if (search) search.value = '';

    const status = document.getElementById('cdel-status');
    if (status) status.value = 'all';

    const legend = document.getElementById('cdel-legend');
    if (legend) legend.innerHTML = '';
}

function openCashierDeliveryDetail(deliveryId) {
    const panel = getDataPanel('cash-deliveries');
    if (panel) showDeliveryRecord(panel.find(deliveryId));
}
// ---------- refunds ----------
// The remarks (a sentence, not a word) are compulsory. Where the goods go is
// not the counter's call: the refund is filed awaiting inspection, and the
// inventory clerk decides whether it can be sold again.
const MINIMUM_RETURN_REASON = 10;

// counts up to the minimum: "have you said enough yet"
function onReturnReasonInput() {
    const field = document.getElementById('return-reason');
    const counter = document.getElementById('reason-counter');
    if (!field || !counter) return;

    const length = field.value.trim().length;

    if (length === 0) {
        counter.className = 'reason-counter';
        counter.textContent = 'Required. One sentence saying what happened.';
    } else if (length < MINIMUM_RETURN_REASON) {
        counter.className = 'reason-counter is-short';
        counter.textContent = (MINIMUM_RETURN_REASON - length) +
            ' more character' + (MINIMUM_RETURN_REASON - length === 1 ? '' : 's') +
            ' before this is usable as a record.';
    } else {
        counter.className = 'reason-counter is-good';
        counter.textContent = 'That will read back on its own in three months.';
    }
}

async function handleIssueRefund(event) {
    event.preventDefault();
    const form = event.target;

    const reason = form.elements.reason.value.trim();

    // the check is on what was chosen, not what is typed
    if (!refundProduct || !form.elements.productId.value) {
        notifyWarning('Type a few letters of the product and choose it from the list. ' +
            'A refund moves stock, so it has to name a real product.', 'No product chosen');
        const box = refundProductBox();
        if (box) { box.focus(); box.select(); }
        renderRefundProductVerdict();
        return;
    }

    const data = {
        productId: parseInt(form.elements.productId.value, 10),
        saleId: form.elements.saleId.value ? parseInt(form.elements.saleId.value, 10) : null,
        reportType: 'Refunded',
        quantity: Number(form.elements.quantity.value),
        reason: reason,
        refundAmount: parseFloat(form.elements.refundAmount.value) || 0
    };

    if (reason.length < MINIMUM_RETURN_REASON) {
        notifyWarning('Say what happened, in a sentence. A write-off queried three months from ' +
            'now has to be explainable from this line alone.', 'The remarks are required');
        const field = document.getElementById('return-reason');
        if (field) field.focus();
        return;
    }

    if (!data.quantity || data.quantity <= 0) {
        notifyWarning('Quantity must be greater than zero.', 'Nothing was filed');
        return;
    }
    if (data.refundAmount <= 0) {
        notifyWarning('A refund has to be greater than zero.', 'Refund not issued');
        return;
    }

    try {
        const response = await apiFileReturn(data);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess('The goods are set aside for the stockroom. The clerk has been asked to inspect ' +
            'them and will put them back on the shelf or write them off.', 'Refund issued');

        form.reset();
        // form.reset() knows nothing about the hidden id, the strip or the suggested figure
        clearRefundProduct();
        refundAmountSuggested = null;
        onReturnReasonInput();
        catalogLoaded = false;
        await loadRefunds();
    } catch (error) {
        notifyOffline();
    }
}

// where the goods went, as a badge; nowhere yet while the stockroom has them
function refundWentTo(row) {
    if (row.disposition) return row.disposition;
    if (row.status === 'Open') return null;
    return row.restocked ? 'Return to Stock' : 'Write-Off';   // older records
}

function dispositionBadge(row) {
    const where = refundWentTo(row);
    if (where === null) return '<span class="badge badge-warning">Awaiting inspection</span>';

    if (where === 'Return to Stock') {
        return '<span class="badge badge-success">Back on shelf</span>';
    } else {
        return '<span class="badge badge-danger">Written off</span>';
    }
}

// Refunds issued: clearable, because the history is context rather than the task.
function buildRefundPanel() {
    createDataPanel({
        key: 'cash-refunds',
        tableId: 'refund-table',
        columns: 7,
        // a log rather than a worklist, so it pages longer
        pageSize: REFUND_ROWS_PER_PAGE,
        pagerId: 'refund-pager',
        idField: 'return_id',
        filters: { disposition: 'all' },

        gate: {
            title: 'No refunds loaded',
            text: 'Search for a product, or press Load Data to read the refunds on record.',
            button: 'Load Data'
        },

        // damage reports from the stockroom are a clerk's business; this is refunds
        load: async () => {
            const all = await apiGetReturns();
            return all.filter((r) => r.report_type === 'Refunded');
        },

        match: (row, query) => prefixMatch([
            row.product_name, row.reason, row.status, row.return_id, '#' + row.return_id
        ], query),

        filter: (row, filters) => {
            if (filters.disposition === 'all') return true;
            const where = refundWentTo(row);
            if (filters.disposition === 'awaiting') return where === null;
            return where === filters.disposition;
        },

        renderRow: (row, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 12) * 24 + 'ms" ' +
            'onclick="openRefundDetail(' + row.return_id + ')">' +
            '<td class="cell-id">#' + row.return_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.product_name) + '</td>' +
            '<td class="cell-num">' + escapeHtml(qtyText(row.quantity, row.unit_name)) + '</td>' +
            '<td class="cell-num cell-due">' + peso(row.refund_amount) + '</td>' +
            '<td>' + dispositionBadge(row) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(row.return_date).slice(0, 10)) + '</td>' +
            '<td>' + statusBadge(row.status) + '</td></tr>'
    });
}

function clearRefundPanel() {
    const panel = getDataPanel('cash-refunds');
    if (panel) panel.reset();

    const search = document.getElementById('refund-search');
    if (search) search.value = '';

    const where = document.getElementById('refund-disposition');
    if (where) where.value = 'all';
}

async function loadRefunds() {
    const panel = getDataPanel('cash-refunds');
    if (!panel) return;
    if (panel.state === 'closed') await panel.open();
    else await panel.refresh();
}

function openRefundDetail(returnId) {
    const panel = getDataPanel('cash-refunds');
    const r = panel ? panel.find(returnId) : null;
    if (!r) return;

    const body = '<div class="detail-grid">' +
        detailField('Refund ID', '#' + r.return_id) +
        detailField('Product', escapeHtml(r.product_name)) +
        detailField('Quantity', escapeHtml(qtyText(r.quantity, r.unit_name))) +
        detailField('Amount', peso(r.refund_amount)) +
        detailField('Goods Went', dispositionBadge(r)) +
        detailField('Status', statusBadge(r.status)) +
        '</div>';

    const ctx = '<div class="detail-grid">' +
        detailField('Issued By', escapeHtml(r.reported_by)) +
        detailField('Issued On', escapeHtml(r.return_date)) +
        detailField('From Sale', r.sale_id ? '#' + r.sale_id : '<span class="muted">Not from a sale</span>') +
        detailField('Inspected', r.inspected_by
            ? escapeHtml(r.inspected_by) + ' <span class="muted">' + escapeHtml(String(r.inspected_at || '').slice(0, 16)) + '</span>'
            : '<span class="muted">Not yet, the stockroom has it</span>') +
        '</div>' +
        '<p class="detail-note"><strong>Remarks</strong></p>' +
        '<p class="detail-note">' + escapeHtml(r.reason || 'No reason was recorded.') + '</p>' +
        (r.inspection_note
            ? '<p class="detail-note"><strong>Inspection</strong></p>' +
              '<p class="detail-note">' + escapeHtml(r.inspection_note) + '</p>' : '');

    openDetailModal('Refund #' + r.return_id, r.product_name, 'R' + r.return_id, [
        { label: 'Refund', body: body },
        { label: 'Details', body: ctx }
    ]);
}

// Sales report. "Mine" and "All" are a filter like the other two.
function buildSalesPanel() {
    createDataPanel({
        key: 'cash-sales',
        tableId: 'csales-table',
        columns: 6,
        pageSize: CASHIER_ROWS_PER_PAGE,
        pagerId: 'csales-pager',
        idField: 'sale_id',
        filters: { scope: 'Mine', method: 'all', status: 'all' },

        gate: {
            title: 'No sales loaded',
            text: 'Search for a customer or a receipt number, or press Load Data to read the sales on record.',
            button: 'Load Data'
        },

        load: async () => {
            cashierSales = await apiGetSales('');
            return cashierSales;
        },

        onLoaded: () => renderSalesScope(),

        match: (row, query) => prefixMatch([
            row.customer_name, row.payment_method, row.payment_status, row.transaction_status,
            row.sale_id, '#' + row.sale_id, 'OR-' + String(row.sale_id).padStart(6, '0')
        ], query),

        filter: (row, filters) => {
            if (!saleIsInScope(row, filters.scope)) return false;
            if (filters.method !== 'all' && row.payment_group !== filters.method) return false;
            if (filters.status !== 'all' && row.transaction_status !== filters.status) return false;
            return true;
        },

        renderRow: (row, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
            'onclick="openReceipt(' + row.sale_id + ')">' +
            '<td class="cell-id">OR-' + String(row.sale_id).padStart(6, '0') + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(row.sale_date).slice(0, 10)) + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
            '<td>' + escapeHtml(row.payment_method) + '</td>' +
            '<td>' + statusBadge(row.payment_status) + '</td>' +
            '<td class="cell-num">' + peso(row.final_amount) + '</td></tr>'
    });
}

// decided by staff id, not by name: two people can share a name
function saleIsInScope(row, scope) {
    if (scope === 'All') return true;
    const user = getCurrentUser();
    if (!user) return false;
    return row.cashier_staff_id === user.staff_id;
}

function renderSalesScope() {
    const box = document.getElementById('sales-scope');
    if (!box) return;

    box.innerHTML = ['Mine', 'All'].map((sc) => {
        const count = cashierSales.filter((s) => saleIsInScope(s, sc)).length;
        return '<button type="button" class="filter-chip' + (salesScope === sc ? ' active' : '') +
            '" onclick="setSalesScope(\'' + sc + '\')">' + (sc === 'Mine' ? 'My Sales' : 'All Sales') +
            ' <span class="chip-count">' + count + '</span></button>';
    }).join('');
}

function setSalesScope(scope) {
    salesScope = scope;
    renderSalesScope();
    dataPanelFilter('cash-sales', 'scope', scope);
}

function clearSalesPanel() {
    const panel = getDataPanel('cash-sales');
    if (panel) panel.reset();

    cashierSales = [];
    salesScope = 'Mine';

    const search = document.getElementById('csales-search');
    if (search) search.value = '';

    const method = document.getElementById('csales-method');
    if (method) method.value = 'all';

    const status = document.getElementById('csales-status');
    if (status) status.value = 'all';

    const scope = document.getElementById('sales-scope');
    if (scope) scope.innerHTML = '';
}

async function loadCashierSales() {
    const panel = getDataPanel('cash-sales');
    if (!panel) return;
    if (panel.state === 'closed') await panel.open();
    else await panel.refresh();
}

// Daily summary: today only, bounded at the server. The figures and the
// breakdown come from one call so the cards and the table cannot disagree.
async function loadDailySummary() {
    const grid = document.getElementById('summary-kpis');
    if (!grid) return;

    const user = getCurrentUser();
    if (!user) return;

    const panel = getDataPanel('cash-summary');
    if (!panel) return;

    // the four cards wait with a dash, so the table under them stays put
    grid.innerHTML = ['Transactions', 'Gross Sales', 'Collected', 'Refunds'].map((label) =>
        '<div class="kpi-card"><span class="kpi-label">' + label + '</span>' +
        '<span class="kpi-value">—</span><span class="kpi-note">Loading...</span></div>').join('');

    if (panel.state === 'closed' || panel.state === 'error') await panel.open();
    else await panel.refresh();

    // the cards have to say so themselves rather than sit on old figures
    if (!dailySummary) {
        grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Offline</span>' +
            '<span class="kpi-value">--</span>' +
            '<span class="kpi-note">Cannot reach the server</span></div>';
    }
}

function renderDailySummary() {
    const grid = document.getElementById('summary-kpis');
    const s = dailySummary;
    if (!grid || !s) return;

    const heading = document.getElementById('summary-day');
    if (heading) heading.textContent = summaryDayText(s.date);

    const refundCount = Number(s.refundCount) || 0;
    const refundItems = Number(s.refundItems) || 0;

    const cards = [
        '<div class="kpi-card"><span class="kpi-label">Transactions</span>' +
            '<span class="kpi-value">' + escapeHtml(String(s.saleCount)) + '</span>' +
            '<span class="kpi-note">rung up today</span></div>',

        '<div class="kpi-card"><span class="kpi-label">Gross Sales</span>' +
            '<span class="kpi-value">' + peso(s.gross) + '</span>' +
            '<span class="kpi-note">' +
                (Number(s.discounts) > 0
                    ? 'today, after discounts of ' + peso(s.discounts)
                    : 'billed today') + '</span></div>',

        '<div class="kpi-card"><span class="kpi-label">Collected</span>' +
            '<span class="kpi-value">' + peso(s.collected) + '</span>' +
            '<span class="kpi-note">taken at the counter today</span></div>',

        // a button rather than a card, because it opens
        '<button type="button" class="kpi-card' + (refundCount > 0 ? ' kpi-warn' : '') + '" ' +
                'onclick="openRefundsToday()">' +
            '<span class="kpi-go">Open</span>' +
            '<span class="kpi-label">Refunds</span>' +
            '<span class="kpi-value">' + peso(s.refundTotal) + '</span>' +
            '<span class="kpi-note">' +
                (refundCount === 0
                    ? 'nothing came back today'
                    : refundCount + (refundCount === 1 ? ' refund' : ' refunds') + ', ' +
                      refundItems + (refundItems === 1 ? ' item' : ' items') + ' &mdash; tap for the details') +
            '</span></button>'
    ];

    grid.innerHTML = cards.join('');
}

function summaryDayText(day) {
    if (!day) return 'Today';

    const when = new Date(String(day).slice(0, 10) + 'T00:00:00');
    if (isNaN(when.getTime())) return String(day).slice(0, 10);

    return when.toLocaleDateString('en-PH', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
}

// the breakdown table reads from the summary already fetched
function buildSummaryPanel() {
    createDataPanel({
        key: 'cash-summary',
        tableId: 'summary-table',
        columns: 3,
        pageSize: CASHIER_ROWS_PER_PAGE,
        pagerId: 'summary-pager',
        idField: 'payment_method',

        gate: {
            title: 'Nothing loaded yet',
            text: 'Press Load Today to read today\'s takings.',
            button: 'Load Today'
        },

        load: async () => {
            const user = getCurrentUser();
            if (!user) return [];

            // dropped first, so a failed read leaves no stale figures for the cards
            dailySummary = null;
            dailySummary = await apiGetDailySummary(user.staff_id);
            renderDailySummary();
            return dailySummary.methods || [];
        },

        renderRow: (row) =>
            '<tr><td class="cell-name">' + escapeHtml(row.payment_method) + '</td>' +
            '<td class="cell-num">' + row.sale_count + '</td>' +
            '<td class="cell-num">' + peso(row.total_amount) + '</td></tr>'
    });
}

function openRefundsToday() {
    const s = dailySummary;
    if (!s) return;

    const rows = s.refunds || [];
    const count = Number(s.refundCount) || 0;

    const sub = document.getElementById('refunds-today-sub');
    if (sub) sub.textContent = summaryDayText(s.date);

    const totals = document.getElementById('refunds-today-totals');
    if (totals) {
        totals.innerHTML =
            detailField('Refunds Issued', String(count)) +
            detailField('Items Returned', String(Number(s.refundItems) || 0)) +
            detailField('Total Refunded',
                '<span class="' + (Number(s.refundTotal) > 0 ? 'cell-due' : '') + '">' +
                peso(s.refundTotal) + '</span>');
    }

    const list = document.getElementById('refunds-today-list');
    if (list) {
        if (rows.length === 0) {
            list.innerHTML = '<p class="detail-empty">Nothing was refunded today.</p>';
        } else {
            list.innerHTML = '<div class="refund-lines">' + rows.map((r) =>
                    '<div class="refund-line">' +
                        '<div class="refund-line-main">' +
                            '<span class="refund-line-name">' + escapeHtml(r.product_name) + '</span>' +
                            '<span class="refund-line-meta">' +
                                r.quantity + ' ' + escapeHtml(r.unit_name || '') +
                                ' at ' + peso(r.unit_refund) + ' each' +
                                (r.sale_id ? ' &middot; from sale #' + r.sale_id : '') +
                            '</span>' +
                            (r.reason
                                ? '<span class="refund-line-reason">' + escapeHtml(r.reason) + '</span>'
                                : '') +
                        '</div>' +
                        '<div class="refund-line-side">' +
                            '<span class="refund-line-amount">' + peso(r.refund_amount) + '</span>' +
                            dispositionBadge(r) +
                        '</div>' +
                    '</div>').join('') + '</div>';
        }
    }

    showModal('refunds-today-modal');
}

// ==========================================
// DEBT PAYMENTS -- taken from the customer's card (Unpaid Sales tab), one
// sale at a time. The server records it through sp_record_credit_payment,
// which refuses more than the balance.
// ==========================================
const DEBT_TERM_DAYS = 30;

// days until the balance is due: negative once it is late
function debtDaysLeft(row) {
    return DEBT_TERM_DAYS - (Number(row.days_old) || 0);
}

function debtDueCell(row) {
    const left = debtDaysLeft(row);
    const date = new Date(String(row.due_date).slice(0, 10) + 'T00:00:00');
    let when;
    if (isNaN(date.getTime())) {
        when = String(row.due_date || '').slice(0, 10);
    } else {
        when = date.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    let tone;
    if (left < 0) {
        tone = 'badge-danger';
    } else if (left <= 7) {
        tone = 'badge-warning';
    } else {
        tone = 'badge-neutral';
    }

    let word;
    if (left < 0) {
        word = (-left) + (left === -1 ? ' day' : ' days') + ' overdue';
    } else if (left === 0) {
        word = 'due today';
    } else {
        word = 'due in ' + left + (left === 1 ? ' day' : ' days');
    }

    return '<span class="due-date">' + escapeHtml(when) + '</span> ' +
        '<span class="badge ' + tone + '">' + escapeHtml(word) + '</span>';
}

// the sale a payment is being taken against
let paymentSale = null;

function paymentFormFields() {
    const form = document.getElementById('payment-form');
    return form ? form.elements : null;
}

async function openPaymentForm(saleId) {
    let row = customerOpenSales.find((r) => r.sale_id === saleId) || null;

    // not among the card's rows: read the list for the one row
    if (!row) {
        try {
            const rows = await apiGetOpenSales();
            row = rows.find((r) => r.sale_id === saleId) || null;
        } catch (error) {
            notifyOffline();
            return;
        }
    }
    if (!row) {
        notifyInfo('That sale has nothing owing on it.', 'Nothing to pay');
        return;
    }

    paymentSale = row;

    const balance = Number(row.balance_due) || 0;
    document.getElementById('payment-title').textContent = 'Take a Payment';
    document.getElementById('payment-sub').textContent =
        row.customer_name + ' \u00b7 OR-' + String(row.sale_id).padStart(6, '0');
    document.getElementById('payment-avatar').textContent = initialsOf(row.customer_name);

    document.getElementById('payment-facts').innerHTML =
        detailField('Customer', escapeHtml(row.customer_name) +
            (row.phone ? ' <span class="muted">' + escapeHtml(row.phone) + '</span>' : '')) +
        detailField('Sale', escapeHtml(String(row.sale_date).slice(0, 10)) +
            ' <span class="muted">' + escapeHtml(row.payment_method) + '</span>') +
        detailField('Total', peso(row.final_amount) +
            (Number(row.penalty_amount) > 0
                ? ' <span class="muted">+ ' + peso(row.penalty_amount) + ' late penalty (' +
                  escapeHtml(penaltyRateWord(row.penalty_rate)) + ' a month, ' + row.penalty_months +
                  (Number(row.penalty_months) === 1 ? ' month' : ' months') + ' overdue)</span>' : '')) +
        detailField('Paid So Far', peso(row.amount_paid) +
            (Number(row.payment_count) > 0
                ? ' <span class="muted">' + row.payment_count + (row.payment_count === 1 ? ' payment' : ' payments') + '</span>' : '')) +
        detailField('Balance', '<span class="cell-due">' + peso(balance) + '</span>') +
        detailField('Due', debtDueCell(row));

    const fields = paymentFormFields();
    if (fields) {
        fields.amount.value = balance.toFixed(2);
        fields.amount.max = balance.toFixed(2);
        fields.paymentMethod.value = 'Cash';
        fields.referenceNo.value = '';
    }

    const button = document.getElementById('payment-save-btn');
    if (button) { button.disabled = false; button.textContent = 'Record the Payment'; }
    const qrButton = document.getElementById('payment-qr-btn');
    if (qrButton) qrButton.disabled = false;

    renderPaymentVerdict();
    showModal('payment-modal');
    setTimeout(() => { if (fields && fields.amount) { fields.amount.focus(); fields.amount.select(); } }, 60);
}

// Paid or cancelled, the form goes back to the customer's card it was opened
// from, read afresh so the balance on it is the new one.
function closePaymentForm() {
    paymentSale = null;
    closeModal('payment-modal');

    const customerId = paymentReturnCustomer;
    paymentReturnCustomer = null;
    if (customerId) openCustomerCredit(customerId, 'unpaid');
}

function fillPayment(share) {
    const fields = paymentFormFields();
    if (!fields || !paymentSale) return;
    const balance = Number(paymentSale.balance_due) || 0;
    fields.amount.value = (Math.round(balance * share * 100) / 100).toFixed(2);
    renderPaymentVerdict();
}

// where a transfer goes, on the Take a Payment card
function renderPaymentBankBox(amount) {
    const bank = document.getElementById('payment-bank-box');
    const fields = paymentFormFields();
    if (!bank || !fields) return;

    const transfer = fields.paymentMethod.value === 'Bank Transfer';
    bank.hidden = !transfer;
    if (!transfer) return;

    if (!bankSettingsReady(() => renderPaymentVerdict())) {
        bank.innerHTML = '<p class="bank-box-note">Reading the shop\'s bank account...</p>';
        return;
    }

    bank.innerHTML = bankBoxHtml(amount,
        amount > 0 ? 'Once it is sent, type the bank\'s reference for it in the reference box.'
                   : 'Type the amount to see what to send.');
}

// what the balance becomes if this is recorded, said before the button
function renderPaymentVerdict() {
    const box = document.getElementById('payment-verdict');
    const fields = paymentFormFields();
    if (!box || !fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = parseFloat(fields.amount.value) || 0;

    renderPaymentBankBox(Math.min(Math.max(amount, 0), balance));

    // GCash or PayMaya: the customer can pay by QR code instead of a typed reference
    const qrButton = document.getElementById('payment-qr-btn');
    if (qrButton) qrButton.hidden = QR_METHODS.indexOf(fields.paymentMethod.value) === -1;
    qrAmountChanged('credit_payment', amount);

    if (amount <= 0) {
        box.className = 'credit-verdict';
        box.textContent = 'Type what was handed over.';
        return;
    }
    if (amount > balance + 0.004) {
        box.className = 'credit-verdict is-stop';
        box.innerHTML = 'That is <strong>' + peso(amount - balance) + '</strong> more than is owed on this sale. ' +
            'Take ' + peso(balance) + ' and give the rest back, or put it against another sale.';
        return;
    }
    const left = balance - amount;
    if (left <= 0.004) {
        box.className = 'credit-verdict is-good';
        box.innerHTML = 'This clears the sale. ' + escapeHtml(paymentSale.customer_name) +
            ' owes nothing more on OR-' + String(paymentSale.sale_id).padStart(6, '0') + '.';
        return;
    }
    box.className = 'credit-verdict is-watch';
    box.innerHTML = peso(left) + ' stays on the account after this payment.';
}

// viaQr: pressed as Pay by QR; the money is taken by the QR code
async function handleTakePayment(event, viaQr) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = paymentFormFields();
    if (!fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = Math.round((parseFloat(fields.amount.value) || 0) * 100) / 100;
    const method = fields.paymentMethod.value;
    const reference = fields.referenceNo.value.trim();

    if (amount <= 0) {
        notifyWarning('Type the amount that was handed over.', 'Nothing to record');
        fields.amount.focus();
        return;
    }
    if (amount > balance + 0.004) {
        notifyWarning('A payment cannot be more than the ' + peso(balance) + ' still owed on this sale.',
            'Too much');
        fields.amount.focus();
        return;
    }
    if ((method === 'Cheque' || method === 'Bank Transfer') && reference === '') {
        notifyWarning('A ' + method.toLowerCase() + ' is traced by its number. Put it in the reference box.',
            'Reference needed');
        fields.referenceNo.focus();
        return;
    }

    const button = document.getElementById('payment-save-btn');
    const qrButton = document.getElementById('payment-qr-btn');
    const ready = () => {
        if (button) { button.disabled = false; button.textContent = 'Record the Payment'; }
        if (qrButton) qrButton.disabled = false;
    };

    // by QR code: the customer pays the code before anything is recorded
    let qr = null;
    if (viaQr) {
        if (QR_METHODS.indexOf(method) === -1) return;
        if (button) button.disabled = true;
        if (qrButton) qrButton.disabled = true;
        qr = await collectQrPayment(amount, 'Payment on OR-' + String(paymentSale.sale_id).padStart(6, '0'), method,
            'credit_payment', paymentSale.sale_id);
        if (!qr) { ready(); return; }
    }

    if (button) { button.disabled = true; button.textContent = 'Recording...'; }
    if (qrButton) qrButton.disabled = true;

    try {
        const response = await apiTakePayment(paymentSale.sale_id, {
            amount: amount,
            paymentMethod: method,
            referenceNo: qr ? null : reference || null,
            qrPaymentId: qr ? qr.id : null
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                notifyError(result.error + (qr ? keepUnusedQr(qr, result) : ''), 'Payment not recorded');
            }
            ready();
            return;
        }
        if (qr) qrPaidUnused = null;

        const left = balance - amount;
        notifySuccess(peso(amount) + ' taken from ' + paymentSale.customer_name + ' against OR-' +
            String(paymentSale.sale_id).padStart(6, '0') + '. ' +
            (left <= 0.004 ? 'The sale is paid in full.' : peso(left) + ' is still owed on it.'),
            'Payment recorded');

        closePaymentForm();

        // the credit book and a customer picked at the till follow
        const credit = getDataPanel('cash-credit');
        if (credit && credit.state === 'ready') await credit.refresh();
        const pickedId = selectedCustomerId();
        if (pickedId) await onCustomerChange(String(pickedId));
    } catch (error) {
        if (qr) qrPaidUnused = qr;
        notifyOffline();
        ready();
    }
}

// ==========================================
// PAYING FROM THE CUSTOMER'S CARD
// ==========================================
// the open card's customer, and their sales still owing (full rows for the payment form)
let openCustomerId = null;
let customerOpenSales = [];

// the card to go back to once the payment form closes
let paymentReturnCustomer = null;

// the administrator can switch payments off for the cashiers (debt-payments)
function canTakePayments() {
    return typeof holdsFeature !== 'function' || holdsFeature('debt-payments');
}

// Pay on one row: the card steps aside for the payment form (the two are
// not stacked) and comes back when it closes.
function payCustomerSale(saleId) {
    if (!openCustomer) return;
    paymentReturnCustomer = openCustomerId;
    closeModal('customer-modal');
    openPaymentForm(saleId);
}

// Take a Payment in the card's foot: one sale owing is opened at once;
// several are listed on the Unpaid Sales tab to pick from.
function payFromCustomerCard() {
    if (!openCustomer) return;
    if (customerOpenSales.length === 1) {
        payCustomerSale(customerOpenSales[0].sale_id);
    } else {
        showCustomerTab('unpaid');
    }
}

function renderCustomerUnpaid() {
    const box = document.getElementById('customer-unpaid');
    if (!box) return;

    const owed = sumOf(customerOpenSales, 'balance_due');
    const intro = customerOpenSales.length === 0
        ? ''
        : '<p class="panel-sub" style="margin-bottom: 12px;">' + peso(owed) + ' owed on ' +
          customerOpenSales.length + (customerOpenSales.length === 1 ? ' sale' : ' sales') +
          ', oldest first. Press the one the money is for.</p>';

    box.innerHTML = intro + pagedTable('cash-unpaid', ['Receipt', 'Sold', 'Balance', 'Due'],
        customerOpenSales.map((row) => [
            '<span class="cell-id">OR-' + String(row.sale_id).padStart(6, '0') + '</span>',
            escapeHtml(String(row.sale_date).slice(0, 10)) +
                ' <span class="muted">' + escapeHtml(row.payment_method) + '</span>',
            '<span class="cell-due">' + peso(row.balance_due) + '</span>' +
                (Number(row.penalty_amount) > 0
                    ? '<span class="cell-sub">incl. ' + peso(row.penalty_amount) + ' penalty</span>' : ''),
            debtDueCell(row)
        ]), [2], {
            empty: 'Nothing is owed on any sale.',
            noun: 'sale',
            // the row itself opens the payment form for that sale
            rowAttrs: (index) => 'class="row-clickable" title="Take a payment on this sale" ' +
                'onclick="payCustomerSale(' + customerOpenSales[index].sale_id + ')"'
        });
}

// Customers and credit: the cashier can read an account and ask a manager
// for more room. Setting a limit is refused by the server here.
const CASH_STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };

// The cashier's book reads by due date: oldest unpaid sale plus thirty days,
// the same thirty after which the standing turns to Watch (vw_customer_credit).
const CREDIT_TERM_DAYS = 30;

function creditDueDate(row) {
    if (row.oldest_debt_days === null || row.oldest_debt_days === undefined) return null;
    if (!(Number(row.current_credit) > 0)) return null;
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    due.setDate(due.getDate() - Number(row.oldest_debt_days) + CREDIT_TERM_DAYS);
    return due;
}

function creditDaysLeft(row) {
    const due = creditDueDate(row);
    if (!due) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due - today) / 86400000);
}

function creditDueCell(row) {
    const due = creditDueDate(row);
    if (!due) return '<span class="muted">No balance</span>';

    const left = creditDaysLeft(row);
    const date = due.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' });
    let tone;
    if (left < 0) {
        tone = 'badge-danger';
    } else if (left <= 7) {
        tone = 'badge-warning';
    } else {
        tone = 'badge-neutral';
    }

    let word;
    if (left < 0) {
        word = (-left) + (left === -1 ? ' day' : ' days') + ' overdue';
    } else if (left === 0) {
        word = 'due today';
    } else {
        word = 'due in ' + left + (left === 1 ? ' day' : ' days');
    }

    return '<span class="due-date">' + escapeHtml(date) + '</span> ' +
        '<span class="badge ' + tone + '" title="' + escapeHtml(row.standing_reason || '') + '">' +
        escapeHtml(word) + '</span>';
}
const CASH_STANDING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

let openCustomer = null;

function buildCustomerPanel() {
    createDataPanel({
        key: 'cash-credit',
        tableId: 'customers-table',
        columns: 6,
        pageSize: CASHIER_ROWS_PER_PAGE,
        pagerId: 'customers-pager',
        idField: 'customer_id',
        filters: { due: 'all' },

        gate: {
            title: 'No customers loaded',
            text: 'Search for a customer, or press Load Data to read every credit account.',
            button: 'Load Data'
        },

        load: () => apiGetCreditCustomers(),

        match: (row, query) => prefixMatch([row.customer_name, row.phone], query),

        filter: (row, filters) => {
            const owed = Number(row.current_credit) || 0;
            const left = creditDaysLeft(row);
            switch (filters.due) {
                case 'overdue': return left !== null && left < 0;
                case 'week':    return left !== null && left >= 0 && left <= 7;
                case 'owing':   return owed > 0;
                case 'clear':   return owed <= 0;
                default:        return true;
            }
        },

        renderRow: (row, index) => {
            const owed = Number(row.current_credit) || 0;

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openCustomerCredit(' + row.customer_id + ')">' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.phone || 'Not set') + '</td>' +
                '<td class="cell-num">' + peso(row.credit_limit) + '</td>' +
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) + '</td>' +
                '<td class="cell-num">' + peso(row.available_credit) + '</td>' +
                '<td class="cell-due-date">' + creditDueCell(row) + '</td></tr>';
        }
    });
}

// Clear forgets the rows: a credit table left open on a shared counter is
// somebody's balance on display to the next customer
function clearCreditPanel() {
    const panel = getDataPanel('cash-credit');
    if (panel) panel.reset();

    const search = document.getElementById('customers-search');
    if (search) search.value = '';

    const due = document.getElementById('customers-due');
    if (due) due.value = 'all';
}

// tab: which tab to open on ('account' unless asked; 'unpaid' after a payment,
// falling back to the account once nothing is owed)
async function openCustomerCredit(customerId, tab) {
    try {
        const data = await apiGetCustomerHistory(customerId);
        openCustomer = data;
        openCustomerId = customerId;

        const c = data.credit;
        const owed = Number(c.current_credit) || 0;

        // the sales still owing, read only when there is something to pay and
        // the role may take the money
        customerOpenSales = [];
        const payable = owed > 0 && canTakePayments();
        if (payable) {
            try {
                const open = await apiGetOpenSales();
                customerOpenSales = open.filter((r) => Number(r.customer_id) === Number(customerId));
            } catch (error) {
                customerOpenSales = [];
            }
        }

        document.getElementById('customer-modal-name').textContent = c.customer_name;
        document.getElementById('customer-sub').textContent =
            (c.phone || 'No phone on file') + ' · ' + (CASH_STANDING_WORD[c.standing] || c.standing);
        document.getElementById('customer-avatar').textContent = initialsOf(c.customer_name);

        document.getElementById('customer-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Balance', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Available Balance', c.standing === 'Hold'
                ? '<span class="cell-due">Nothing, on hold</span>'
                : peso(c.available_credit)) +
            detailField('Due Date', creditDueCell(c)) +
            detailField('Standing', '<span class="badge ' +
                (CASH_STANDING_TONE[c.standing] || 'badge-neutral') + '">' +
                escapeHtml(CASH_STANDING_WORD[c.standing] || c.standing) + '</span>') +
            detailField('Why', escapeHtml(c.standing_reason || '')) +
            detailField('Open Sales', String(c.open_sales) +
                (Number(c.overdue_sales) > 0
                    ? ' <span class="cell-due">' + c.overdue_sales + ' overdue</span>' : '')) +
            (Number(c.penalties_owed) > 0
                ? detailField('Late Penalties', '<span class="cell-due">' + peso(c.penalties_owed) +
                    '</span> <span class="muted">of the amount owed, at ' +
                    escapeHtml(penaltyRateWord(c.penalty_rate)) + ' a month</span>')
                : '') +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            (c.credit_notes
                ? detailField('Manager Note', escapeHtml(c.credit_notes))
                : '');

        renderCustomerHistory(data);
        renderCustomerUnpaid();

        // the Unpaid Sales tab and Take a Payment, only when there is something to pay
        const hasUnpaid = payable && customerOpenSales.length > 0;
        const unpaidTab = document.getElementById('customer-tab-unpaid');
        if (unpaidTab) unpaidTab.hidden = !hasUnpaid;
        const pay = document.getElementById('customer-pay-btn');
        if (pay) pay.hidden = !hasUnpaid;

        showCustomerTab(tab === 'unpaid' && hasUnpaid ? 'unpaid' : 'account');
        showModal('customer-modal');
    } catch (error) {
        notifyError('That customer could not be opened.', 'Nothing to show');
    }
}

// the account, the unpaid sales and the history, one tab each
function showCustomerTab(name) {
    ['account', 'unpaid', 'history'].forEach((each) => {
        const body = document.getElementById('customer-' + each + '-tab');
        if (body) body.style.display = name === each ? 'block' : 'none';
        const tab = document.getElementById('customer-tab-' + each);
        if (tab) tab.classList.toggle('active', name === each);
    });
}

// purchases beside payments, each paged with Previous and Next rather than
// scrolled, so every sale and every payment can be reached
function renderCustomerHistory(data) {
    const box = document.getElementById('customer-history');
    if (!box) return;

    const purchases = pagedTable('cash-purchases', ['Date', 'Sale', 'Amount', 'Balance'],
        data.purchases.map((p) => [
            escapeHtml(String(p.sale_date).slice(0, 10)),
            '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
            peso(p.final_amount) +
                (Number(p.penalty_amount) > 0
                    ? '<span class="cell-sub">+ ' + peso(p.penalty_amount) + ' penalty</span>' : ''),
            Number(p.balance_due) > 0
                ? '<span class="cell-due">' + peso(p.balance_due) + '</span>'
                : '<span class="muted">Paid</span>'
        ]), [2, 3], { empty: 'Nothing bought yet.', noun: 'sale' });

    const payments = pagedTable('cash-payments', ['Date', 'Amount', 'How'],
        data.payments.map((p) => [
            escapeHtml(String(p.payment_date).slice(0, 10)),
            peso(p.amount),
            escapeHtml(p.payment_method) +
                (p.sale_id ? ' <span class="muted">#' + p.sale_id + '</span>' : '')
        ]), [1], { empty: 'No payments recorded.', noun: 'payment' });

    box.innerHTML =
        '<div class="history-column">' +
            '<h4 class="history-head">Purchase History' +
            '<span class="history-total">' + peso(data.credit.total_purchase) + '</span></h4>' +
            purchases +
        '</div>' +
        '<div class="history-column">' +
            '<h4 class="history-head">Credit &amp; Payments' +
            '<span class="history-total">' +
                (Number(data.credit.current_credit) > 0
                    ? '<span class="cell-due">' + peso(data.credit.current_credit) + ' balance</span>'
                    : 'No balance') +
            '</span></h4>' +
            payments +
        '</div>';
}

// the one thing a cashier can do about a limit: ask
async function askForExtension() {
    if (!openCustomer) return;

    const c = openCustomer.credit;
    const current = Number(c.credit_limit) || 0;

    const waiting = (openCustomer.requests || [])
        .some((request) => request.status === 'Pending');

    if (waiting) {
        notifyWarning('A request for ' + c.customer_name + ' is already waiting for a manager. ' +
            'Adding another would not make it arrive sooner.', 'Already asked');
        return;
    }

    const asked = await askInput({
        title: 'Ask for a higher limit',
        eyebrow: 'Credit Management',
        message: c.customer_name + ' may currently owe up to ' + peso(current) + ' and owes ' +
                 peso(c.current_credit) + '. What should the new limit be? A manager decides it; ' +
                 'nothing changes until they do.',
        label: 'New limit',
        type: 'number',
        value: String(Math.round(current * 1.5)),
        confirmLabel: 'Next',
        check: (value) => {
            const number = Number(value);
            if (!value || !isFinite(number)) return 'Type a figure.';
            if (number <= current) return 'It has to be more than the current ' + peso(current) + '.';
            return null;
        }
    });

    if (asked === false || asked === null) return;

    const reason = await askInput({
        title: 'Why?',
        eyebrow: 'Credit Management',
        message: 'A manager reading this later will not have the customer in front of them. ' +
                 'One line is enough.',
        label: 'Reason',
        placeholder: 'Regular contractor, pays on the 15th, needs cement for a job this week.',
        confirmLabel: 'Send the request'
    });

    if (reason === false || reason === null) return;

    try {
        const response = await apiAskCreditExtension({
                customerId: c.customer_id,
                requestedLimit: Number(asked),
                reason: String(reason).trim()
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess(result.message, 'Request sent');
        closeModal('customer-modal');
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// CASHIER PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('cashier-dashboard.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        // building a panel only draws its closed state; none queries until asked
        buildCustomerPanel();
        buildDeliveryPanel();
        buildSalesPanel();
        buildQrPaymentsPanel({ key: 'cqr', prefix: 'cqr', openSale: openReceipt, byStaff: false });
        buildRefundPanel();
        buildSummaryPanel();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showCashierPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showCashierHome() });

        // Go to, on an opened alert: the screen that alert is about
        const creditAlert = { label: 'Customers Record', panelId: 'panel-customers',
                              open: () => showCustomers(), key: 'cash-credit' };
        configureNotificationTargets({
            'Delivery':       { label: 'Delivery Tracking', panelId: 'panel-delivery',
                                open: () => showCashierDeliveries(), key: 'cash-deliveries' },
            'Refund Report':  { label: 'Refunds', panelId: 'panel-refund',
                                open: () => showRefunds(), key: 'cash-refunds' },
            'Credit Request': creditAlert,
            'Late Penalty':   creditAlert
        });

        onReturnReasonInput();
        renderCustomerVerdict();
        renderRefundProductVerdict();
        renderDeliveryAttached();
        showCashierHome();
        // the customer book is fetched the first time somebody types; the store
        // details are read on arrival because they head every receipt
        loadStoreSettings(false);
        loadNotifications();
    });

    // a click anywhere else closes the suggestion list
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideCustomerSuggestions();
        hideRefundSuggestions();
        hideDriverSuggestions();
    });
}
