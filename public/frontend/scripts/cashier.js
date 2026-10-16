// ============================================================
// cashier.js -- the Cashier dashboard (the till)
// Loaded by: cashier-dashboard.html
//
// What is in this file, from top to bottom:
//   - switching screens (showRegister, showRefunds, showCustomers, ...)
//   - the product catalog on the left of the till, with search and filters
//   - refunds: picking the product, the amount, and filing the refund; the
//     sales of the past three days beside the form, to refund from
//   - the customer box: typing a name, suggestions, picking a customer
//   - the cart: adding lines, sizes (e.g. sack / kg), quantities, totals
//   - the Payment window (Proceed to Payment): the customer, cash, cheque,
//     e-wallet, bank transfer, credit or COD
//   - checkout (handleCheckout) and the printed receipt
//   - scheduling a delivery for the sale
//   - the lists: deliveries, recent sales (for refunds), sales report
//   - the customer credit screen: adding a customer, the card with its
//     history tabs, asking for a higher limit, and payments taken from a
//     customer's card (or from the register, with Credit Payment)
//   - the page start-up code at the very bottom ("CASHIER PAGE BOOT")
// ============================================================
let catalog = [];
let catalogLoaded = false;
let catalogMode = 'idle';     // 'idle' keeps the grid clean, 'all' lists the whole catalog (ten a page)
let cart = [];
let lastReceipt = null;

// eight rows is what fits above the fold on the counter machine
const CASHIER_ROWS_PER_PAGE = 8;

// eight a page keeps the form and the list of recent sales on one screen without scrolling
const RECENT_SALES_ROWS_PER_PAGE = 8;

// the customer list, read once and searched in memory behind the typing box
let customerDirectory = [];
let customerDirectoryLoaded = false;
let suggestHighlight = -1;

// a delivery filled in in the Payment window; written the moment the sale exists
let pendingDelivery = null;

function showCashierPanel(panelId, title, event) {
    if (event) event.preventDefault();

    const panels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < panels.length; i++) {
        if (panels[i].id === panelId) {
            panels[i].style.display = 'block';
        } else {
            panels[i].style.display = 'none';
        }
    }
    const links = document.querySelectorAll('[data-panel-link]');
    for (let i = 0; i < links.length; i++) {
        links[i].classList.toggle('active', links[i].dataset.panelLink === panelId);
    }

    const heading = document.getElementById('cash-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// Opening a screen never unfolds the Point of Sale list: only the heading's
// caret does (shared/helpers.js sidebarHeading); the heading lights up on its
// own while a screen beneath it is the open one.

function showRegister(event) {
    showCashierPanel('panel-pos', 'Point of Sale', event);

    // the catalog keeps what it showed when the cashier left; the page draws
    // it empty once, when it starts
    renderCart();
}

function showCashierHome(event) {
    showRegister(event);
}

// tracking only; empty until the search box or Load Data asks
function showCashierDeliveries(event) {
    showCashierPanel('panel-delivery', 'Delivery Tracking', event);
}

// the refund form's product box needs the catalogue; the recent sales are read
// again every time this screen opens, so a sale just rung up is in the list
function showRefunds(event) {
    showCashierPanel('panel-refund', 'Refunds', event);
    loadCatalogOptions();
    loadRecentSales();
}

function showCustomers(event) { showCashierPanel('panel-customers', 'Customers Record', event); }

function showSalesReport(event) {
    showCashierPanel('panel-salesreport', 'Sales Report', event);
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
    grid.innerHTML = '\n' +
        '        <div class="empty-state">\n' +
        '            <div class="empty-mark">\n' +
        '                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">\n' +
        '                    <path d="M6 6h15l-1.5 9h-12z"></path>\n' +
        '                    <path d="M6 6L5 3H2"></path>\n' +
        '                    <circle cx="9" cy="20" r="1.4"></circle>\n' +
        '                    <circle cx="18" cy="20" r="1.4"></circle>\n' +
        '                </svg>\n' +
        '            </div>\n' +
        '            <h4>No products loaded</h4>\n' +
        '            <p>Search above for what the customer is buying, or press Load Data to list every product.</p>\n' +
        '            <button type="button" class="btn btn-accent" onclick="loadCatalogAll(event)">Load Data</button>\n' +
        '        </div>';
    holdBoxHeight(grid);
}

function renderCatalogNoMatch(keyword) {
    const grid = catalogGrid();
    if (!grid) return;
    setPill('catalog-count', '0 results');
    let nothingText = 'Nothing is left';
    if (keyword) nothingText = 'Nothing matches <kbd>' + escapeHtml(keyword) + '</kbd>';
    let categoryText = '';
    if (catalogFilters.category !== 'all') categoryText = ' in the category picked above';
    grid.innerHTML = '\n' +
        '        <div class="empty-state">\n' +
        '            <div class="empty-mark">\n' +
        '                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">\n' +
        '                    <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path><path d="M8.5 11h5"></path>\n' +
        '                </svg>\n' +
        '            </div>\n' +
        '            <h4>No match found</h4>\n' +
        '            <p>' + nothingText + categoryText + '. Archived and out-of-stock products never appear here.</p>\n' +
        '            <button type="button" class="btn btn-accent" onclick="loadCatalogAll(event)">Load Data</button>\n' +
        '        </div>';
    holdBoxHeight(grid);
}

// The catalog is a table, not a grid of cards. Pressing a row anywhere puts
// the product on the order; only in-stock products are listed. A product that
// is already on the order is greyed and cannot be pressed again: its amount is
// changed with + and - on the order (pressCatalogRow, markCatalogRows).
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

const CATALOG_ROW_TITLE = {
    off: 'Press to put it on the order',
    on: 'Already on the order. Change the amount with + and − on the order.'
};

// The order line for this product, or undefined when it is not on the order
function findCartLine(productId) {
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].product_id === productId) return cart[i];
    }
    return undefined;
}

// The catalog product with this id, or undefined
function findCatalogProduct(productId) {
    for (let i = 0; i < catalog.length; i++) {
        if (catalog[i].product_id === productId) return catalog[i];
    }
    return undefined;
}

// the click on a row: a product on the order is not added a second time; the
// line it is on lights up instead, so the cashier can see where to change it
function pressCatalogRow(productId) {
    if (findCartLine(productId)) {
        flashCartLine(productId);
        return;
    }
    addToCart(productId);
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
    for (let i = 0; i < catalog.length; i++) {
        const p = catalog[i];
        if (!isCatalogAvailable(p)) continue;
        const name = String(p.category_name || 'Uncategorised');
        if (!names.includes(name)) {
            names.push(name);
        }
    }
    names.sort();
    const current = select.value;
    let optionsHtml = '<option value="all">Every category</option>';
    for (let i = 0; i < names.length; i++) {
        optionsHtml += '<option value="' + escapeHtml(names[i]) + '">' + escapeHtml(names[i]) + '</option>';
    }
    select.innerHTML = optionsHtml;
    if (names.indexOf(current) !== -1) {
        select.value = current;
    } else {
        select.value = 'all';
    }
    catalogFilters.category = select.value;
}

function applyCatalogView() {
    const box = document.getElementById('catalog-search');
    const text = searchText(box ? box.value : '');

    if (text === '' && catalogMode === 'idle') { renderCatalogEmpty(); return; }

    const rows = [];
    for (let i = 0; i < catalog.length; i++) {
        const p = catalog[i];
        if (catalogMatchesFilters(p) &&
            (text === '' || prefixMatch([p.product_name, p.category_name, p.brand_name], text))) {
            rows.push(p);
        }
    }
    renderCatalog(rows, text);
}

// Ten rows at a time, with Previous and Next under the table. The page is
// kept while the same rows are redrawn (a line put on the order) and starts
// over when the search or a filter changes what is listed.
const CATALOG_PAGE_ROWS = 10;
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

    const ids = [];
    for (let i = 0; i < rows.length; i++) {
        ids.push(rows[i].product_id);
    }
    const key = ids.join(',');
    if (key !== catalogShownKey) catalogPage = 1;
    catalogShown = rows;
    catalogShownKey = key;

    const pages = Math.max(1, Math.ceil(rows.length / CATALOG_PAGE_ROWS));
    catalogPage = Math.min(Math.max(1, catalogPage), pages);
    const start = (catalogPage - 1) * CATALOG_PAGE_ROWS;
    const slice = rows.slice(start, start + CATALOG_PAGE_ROWS);

    // one page needs no pager; the count pill already says how many
    let pager = '';
    if (pages > 1) {
        pager = '<div class="pager">' +
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
    // the table rows, one for each product on this page
    let rowsHtml = '';
    for (let i = 0; i < slice.length; i++) {
        const p = slice[i];
        const inCart = findCartLine(p.product_id);
        const sizes = sellingUnitsOf(p);

        let rowClass = '';
        let rowTitle = CATALOG_ROW_TITLE.off;
        let disabledAttr = '';
        let markHidden = ' hidden';
        let markText = '';
        if (inCart) {
            rowClass = ' is-on-order';
            rowTitle = CATALOG_ROW_TITLE.on;
            disabledAttr = ' aria-disabled="true"';
            markHidden = '';
            markText = escapeHtml(qtyText(inCart.quantity, inCart.unit)) + ' on order';
        }

        let sizesHtml = '';
        if (sizes.length > 0) {
            const sizeNames = [];
            for (let s = 0; s < sizes.length; s++) {
                sizeNames.push(escapeHtml(sizes[s].unit_name));
            }
            sizesHtml = '<span class="unit-sizes">also by the ' + sizeNames.join(', ') + '</span>';
        }

        let perHtml = '';
        if (p.unit_name) perHtml = '<span class="price-per">per ' + escapeHtml(unitShort(p.unit_name)) + '</span>';

        rowsHtml += '<tr class="row-reveal row-clickable' + rowClass + '"' +
            ' style="animation-delay:' + Math.min(i, 12) * 26 + 'ms"' +
            ' onclick="pressCatalogRow(' + p.product_id + ')"' +
            ' title="' + rowTitle + '"' +
            disabledAttr +
            ' data-product-row="' + p.product_id + '">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) +
                '<span class="on-order-mark" title="On the order"' + markHidden + '>' + markText + '</span></td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td>' + escapeHtml(p.brand_name || '—') + '</td>' +
            '<td class="cell-unit">' + escapeHtml(p.unit_name || '—') + sizesHtml + '</td>' +
            '<td class="cell-num catalog-price">' + peso(p.price) + perHtml + '</td>' +
        '</tr>';
    }

    grid.innerHTML =
        '<table class="catalog-table" id="catalog-table">' +
        '<thead><tr><th>Product</th><th>Category</th><th>Brand</th><th>Sold By</th><th>Price</th></tr></thead>' +
        '<tbody>' + rowsHtml +
        // a short page is topped up to ten so the pager stays put (tables.js)
        fillerRows(CATALOG_PAGE_ROWS - slice.length, 5) +
        '</tbody></table>' + pager;

    holdTableHeight(document.getElementById('catalog-table'));
    holdBoxHeight(grid);
}

// Load Data: the whole catalog (in stock), ten a page like every other list
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
    catalogSearchTimer = setTimeout(function () { filterCatalog(box.value); }, SEARCH_TYPING_DELAY_MS);
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

    function hide() {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    }

    if (searchText(query) === '' || catalog.length === 0) { hide(); return; }

    if (refundProduct && String(refundProduct.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    // names that start with the text come before a later word in the name
    const starts = [];
    const words = [];
    const other = [];

    for (let i = 0; i < catalog.length; i++) {
        const p = catalog[i];
        const name = String(p.product_name || '').toLowerCase();

        if (name.startsWith(query)) starts.push(p);
        else if (startsAWord(name, query)) words.push(p);
        else if (prefixMatch([p.brand_name, p.category_name], query)) other.push(p);
    }

    const found = starts.concat(words, other).slice(0, 6);

    if (found.length === 0) { hide(); return; }

    let suggestHtml = '';
    for (let i = 0; i < found.length; i++) {
        const p = found[i];
        // brand and category separate two products whose names read almost the same
        const meta = [];
        if (p.category_name) meta.push(escapeHtml(p.category_name));
        if (p.brand_name) meta.push(escapeHtml(p.brand_name));

        let noteHtml = '';
        if (meta.length) noteHtml = '<span class="suggest-note">' + meta.join(' &middot; ') + '</span>';

        suggestHtml += '<li class="suggest-item" role="option" id="refund-suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickRefundProduct(' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + peso(p.price) + '</span>' +
            '</span>' +
            noteHtml +
            '</li>';
    }
    list.innerHTML = suggestHtml;

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
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === refundSuggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        let pickIndex = 0;
        if (refundSuggestHighlight >= 0) pickIndex = refundSuggestHighlight;
        const pick = items[pickIndex];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideRefundSuggestions();
}

function pickRefundProduct(productId) {
    const found = findCatalogProduct(productId);
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

    const metaParts = [];
    if (p.category_name) metaParts.push(escapeHtml(p.category_name));
    if (p.brand_name) metaParts.push(escapeHtml(p.brand_name));
    const meta = metaParts.join(' &middot; ');

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

// The customer is typed and picked. A name picked from the suggestions is an
// account (the credit strip appears); nothing typed is a walk-in. A name that
// matches nobody is refused (handleCheckout): the till does not open accounts,
// Customers Record does.
async function loadCustomerDirectory(force) {
    if (customerDirectoryLoaded && !force) return true;

    try {
        customerDirectory = await apiGetRecords('customer');
        customerDirectoryLoaded = true;
        return true;
    } catch (error) {
        // not fatal: a cash sale to a walk-in needs none of this (a typed name
        // cannot be checked against the customer list until it loads, and is refused then)
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
    for (let i = 0; i < customerDirectory.length; i++) {
        if (String(customerDirectory[i].name).trim().toLowerCase() === text) return customerDirectory[i];
    }
    return null;
}

async function onCustomerInput(value) {
    const text = String(value || '').trim();
    const idBox = customerIdBox();
    const clear = document.getElementById('customer-clear');

    if (clear) clear.hidden = text === '';

    if (!customerDirectoryLoaded && text !== '') await loadCustomerDirectory(false);

    const exact = customerMatchingTypedName();

    // an id that no longer agrees with the text puts the sale against the wrong account
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

    for (let i = 0; i < customerDirectory.length; i++) {
        const c = customerDirectory[i];
        const name = String(c.name || '').toLowerCase();
        if (name.startsWith(query)) starts.push(c);
        else if (prefixMatch([name, c.phone], query)) words.push(c);
    }

    const found = starts.concat(words).slice(0, 6);

    if (found.length === 0) {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
        return;
    }

    let suggestHtml = '';
    for (let i = 0; i < found.length; i++) {
        const c = found[i];
        const owed = Number(c.current_credit) || 0;
        const bought = Number(c.purchase_count) || 0;

        // a regular, or an account that already owes, is worth knowing before the sale
        const notes = [];
        if (bought > 0) notes.push(bought + (bought === 1 ? ' purchase' : ' purchases'));
        if (owed > 0) notes.push('owes ' + peso(owed));
        if (c.phone) notes.push(escapeHtml(c.phone));

        let noteHtml = '';
        if (notes.length) noteHtml = '<span class="suggest-note">' + notes.join(' &middot; ') + '</span>';

        suggestHtml += '<li class="suggest-item" role="option" id="suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickCustomer(' + c.id + ')">' +
            '<span class="suggest-name">' + escapeHtml(c.name) + '</span>' +
            noteHtml +
            '</li>';
    }
    list.innerHTML = suggestHtml;

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
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === suggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        let pickIndex = 0;
        if (suggestHighlight >= 0) pickIndex = suggestHighlight;
        const pick = items[pickIndex];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideCustomerSuggestions();
}

// The customer in the directory with this id, or undefined
function findCustomer(customerId) {
    for (let i = 0; i < customerDirectory.length; i++) {
        if (customerDirectory[i].id === customerId) return customerDirectory[i];
    }
    return undefined;
}

async function pickCustomer(customerId) {
    const found = findCustomer(customerId);
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

    // Add Customer shows only for a name that matches nobody
    const addButton = document.getElementById('customer-add-btn');
    const offerAdd = !id && typed !== '' && canAddCustomers();
    if (addButton) addButton.hidden = !offerAdd;

    if (id) {
        box.className = 'customer-verdict is-good';
        box.textContent = 'A customer on record. This sale is saved under their name.';
        return;
    }

    if (typed === '') {
        box.className = 'customer-verdict';
        box.textContent = 'Walk-in. To put the sale on a customer, type their name and pick them from the list.';
        return;
    }

    // a name that matches nobody is a stop until the account is opened
    box.className = 'customer-verdict is-stop';
    if (offerAdd) {
        box.textContent = 'Not a customer on record. Press Add Customer to open their account, ' +
            'or clear the box for a walk-in.';
    } else {
        box.textContent = 'Not a customer on record. Add them under Customers Record first, then pick them here, ' +
            'or clear the box for a walk-in.';
    }
}

// opening an account needs the Customers Record screen (POST /api/customers is part of it)
function canAddCustomers() {
    return typeof holdsFeature !== 'function' || holdsFeature('credit');
}

// Add Customer from the payment form: the form opens over it with the typed
// name filled in, and the new account is put on the sale once it is saved.
function addCustomerFromPayment() {
    openAddCustomer();
    addCustomerForSale = true;

    const form = document.getElementById('add-customer-form');
    if (form) form.elements.name.value = typedCustomerName();
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
    const usable = [];
    for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u && u.unit_name && Number(u.units_per) > 0) usable.push(u);
    }
    return usable;
}

// "kg" for a kilogram, otherwise the unit's own name
function unitShort(unit) {
    const measure = measuredUnit(unit);
    return measure ? measure.short : String(unit || '').trim();
}

// the choices on a line: the product's own unit first, then the sizes, smallest up
function lineUnitChoices(line) {
    const own = { unit_name: line.base_unit || 'unit', units_per: 1, price: line.price, own: true };
    const sorted = line.sizes.slice().sort(function (a, b) {
        return Number(a.units_per) - Number(b.units_per);
    });
    const sizes = [];
    for (let i = 0; i < sorted.length; i++) {
        const u = sorted[i];
        let sizePrice;
        if (u.price === null || u.price === undefined) {
            sizePrice = Math.round(line.price * Number(u.units_per) * 100) / 100;
        } else {
            sizePrice = Number(u.price);
        }
        sizes.push({
            unit_name: u.unit_name,
            units_per: Number(u.units_per),
            price: sizePrice,
            own: false
        });
    }
    return [own].concat(sizes);
}

function lineChoice(line) {
    const choices = lineUnitChoices(line);
    for (let i = 0; i < choices.length; i++) {
        if (choices[i].unit_name.toLowerCase() === String(line.unit).toLowerCase()) return choices[i];
    }
    return choices[0];
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
    const p = findCatalogProduct(productId);
    if (!p) return;

    const onHand = Number(p.quantity_in_stock);
    if (onHand <= 0) {
        notifyWarning(p.product_name + ' is out of stock, so it cannot go on this sale.', 'Nothing to sell');
        return;
    }

    const line = findCartLine(productId);
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
    setTimeout(function () { row.classList.remove('is-added'); }, 500);
}

function changeCartQty(productId, delta) {
    const line = findCartLine(productId);
    if (!line) return;

    const next = Number((line.quantity + delta * lineStep(line)).toFixed(3));
    if (next <= 0) { removeCartLine(productId); return; }
    if (next > lineCeiling(line)) { tellAllOfIt(line); return; }
    line.quantity = next;
    renderCart();
}

// the amount box on a line: typed, then checked against the shelf when it is left
function onCartQtyInput(productId, value) {
    const line = findCartLine(productId);
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
    const line = findCartLine(productId);
    if (!line) return;
    if (!(line.quantity > 0)) line.quantity = Math.min(1, lineCeiling(line)) || 1;
    renderCart();
}

// Changing the unit keeps the count where it can: 3 boxes become 3 kilos,
// capped at what the shelf holds in the new size.
function changeCartUnit(productId, unitName) {
    const line = findCartLine(productId);
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
    const remaining = [];
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].product_id !== productId) remaining.push(cart[i]);
    }
    cart = remaining;
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

    // a delivery left attached to an emptied cart is a delivery for goods nobody chose
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
    for (let i = 0; i < cart.length; i++) {
        gross = gross + lineSubtotal(cart[i]);
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

    // half now and half on account; capped at the bill because there is no change
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
    let amountOnAccount = 0;
    if (onCredit) {
        amountOnAccount = due - down;
    } else if (method === 'COD') {
        amountOnAccount = due;
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
        amountOnAccount: amountOnAccount
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
        let cartHtml = '';
        for (let n = 0; n < cart.length; n++) {
            const l = cart[n];
            const choices = lineUnitChoices(l);
            const chosen = lineChoice(l);
            let unitBox;
            if (choices.length > 1) {
                let optionsHtml = '';
                for (let k = 0; k < choices.length; k++) {
                    const c = choices[k];
                    let label = c.unit_name;
                    let sizeNote = '';
                    if (c.own) {
                        label = unitShort(c.unit_name) || 'unit';
                    } else {
                        sizeNote = ' (' + escapeHtml(qtyText(c.units_per, l.base_unit)) + ')';
                    }
                    optionsHtml += '<option value="' + escapeHtml(c.unit_name) + '"' +
                        (c.unit_name === chosen.unit_name ? ' selected' : '') + '>' +
                        escapeHtml(label) +
                        sizeNote +
                        '</option>';
                }
                unitBox = '<select class="cart-unit-pick" aria-label="Sold by" title="The size this line is counted in" ' +
                          'onchange="changeCartUnit(' + l.product_id + ', this.value)">' +
                          optionsHtml +
                          '</select>';
            } else {
                unitBox = '<span class="cart-unit-fixed">' + escapeHtml(unitShort(l.base_unit) || 'unit') + '</span>';
            }

            cartHtml += '<div class="cart-line" data-line="' + l.product_id + '">' +
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
        }
        box.innerHTML = cartHtml;
    }

    renderCartFigures();
    markCatalogRows();
}

// the catalog rows say what is already on the order, without being redrawn:
// a product on the order is greyed and cannot be pressed (pressCatalogRow)
function markCatalogRows() {
    const catalogRows = document.querySelectorAll('#catalog-table tr[data-product-row]');
    for (let i = 0; i < catalogRows.length; i++) {
        const row = catalogRows[i];
        const line = findCartLine(Number(row.dataset.productRow));
        row.classList.toggle('is-on-order', Boolean(line));
        row.title = CATALOG_ROW_TITLE[line ? 'on' : 'off'];
        if (line) row.setAttribute('aria-disabled', 'true');
        else row.removeAttribute('aria-disabled');
        const mark = row.querySelector('.on-order-mark');
        if (!mark) continue;
        mark.hidden = !line;
        mark.textContent = line ? qtyText(line.quantity, line.unit) + ' on order' : '';
    }
}

// the figures alone, while an amount is being typed: rebuilding the line
// would take the cursor out of the box
function renderCartFigures() {
    for (let i = 0; i < cart.length; i++) {
        const l = cart[i];
        const sub = document.querySelector('[data-line-sub="' + l.product_id + '"]');
        if (sub) sub.textContent = peso(lineSubtotal(l));
        const row = document.querySelector('.cart-line[data-line="' + l.product_id + '"] .cart-unit');
        if (row) row.innerHTML = cartLineNote(l);
    }

    const t = cartTotals();

    // the order's own box: what the lines come to, and nothing about payment
    const totals = document.getElementById('cart-totals');
    if (totals) {
        let html = '<div class="total-row"><span>Subtotal</span><span>' + peso(t.gross) + '</span></div>';
        // no discount box at the till; shown only if a total ever carries one
        if (t.discount > 0) {
            html += '<div class="total-row"><span>Discount</span><span>' + peso(t.discount) + '</span></div>';
        }
        html += '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>';
        totals.innerHTML = html;
    }

    // the Payment window's own figures: the amount due, then what becomes of it
    const payTotals = document.getElementById('pay-totals');
    if (payTotals) {
        let html = '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>';

        if (t.onCredit) {
            // credit: part paid now, the rest goes on the account
            html += '<div class="total-row"><span>Paid now</span><span>' + peso(t.down) + '</span></div>';
            if (t.amountOnAccount > 0) {
                html += '<div class="total-row total-short"><span>On account</span><span>' + peso(t.amountOnAccount) + '</span></div>';
            } else {
                html += '<div class="total-row total-change"><span>Paid in full</span><span>' + peso(t.amountOnAccount) + '</span></div>';
            }
        } else if (t.onAccount) {
            // cash on delivery: nothing is paid at the counter
            html += '<div class="total-row total-note"><span>Collected on delivery</span><span>' +
                    peso(t.due) + '</span></div>';
        } else if (t.tendered < t.due) {
            // paid now, and what was handed over does not cover it yet
            html += '<div class="total-row total-short"><span>Short by</span><span>' +
                    peso(t.due - t.tendered) + '</span></div>';
        } else {
            html += '<div class="total-row total-change"><span>Change</span><span>' +
                    peso(t.change) + '</span></div>';
        }

        payTotals.innerHTML = html;
    }

    // nothing to pay for until something is on the order
    const proceed = document.getElementById('proceed-btn');
    if (proceed) proceed.disabled = cart.length === 0;

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

// The button says what pressing it does, so nobody charges a sale to an
// account thinking they took the money for it.
function checkoutLabel(t) {
    if (t.method === 'COD') return 'Place COD Order';
    if (t.onCredit) {
        if (cart.length > 0 && t.amountOnAccount <= 0) return 'Complete Sale';
        if (t.down > 0) return 'Take Part Payment & Charge the Rest';
        return 'Charge to Account';
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
    if (t.onCredit) {
        if (t.down > 0) return downPaymentMethod();
        return null;
    }
    if (t.method === 'COD') return null;
    return t.method;
}

function downPaymentMethod() {
    const form = document.getElementById('checkout-form');
    if (form && form.elements.downPaymentMethod) return form.elements.downPaymentMethod.value;
    return 'Cash';
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

    // The reference is on screen only while the money taken now has a number to
    // trace it by (REFERENCE_WORDS): not for cash, not for cash on delivery, and
    // not for a credit sale with nothing paid now (taken is null then) or a part
    // payment in cash. When it goes, so does anything typed in it.
    const taken = methodTakenNow(t);
    const field = document.getElementById('sale-reference-field');
    const words = REFERENCE_WORDS[taken];
    if (field) {
        field.hidden = !words;
        const box = document.getElementById('sale-reference');
        if (words) {
            const hint = document.getElementById('sale-reference-hint');
            if (hint) hint.textContent = words.hint;
            // not the browser's required: handleCheckout says which number it needs, in words
            if (box) box.placeholder = words.placeholder;
        } else if (box && box.value !== '') {
            box.value = '';
        }
    }

    const bank = document.getElementById('sale-bank-box');
    if (!bank) return;

    // on a credit sale the box follows the part payment's method even before
    // an amount is typed, so the cashier can read the account out as it is agreed
    const transfer = t.onCredit ? downPaymentMethod() === 'Bank Transfer' : t.method === 'Bank Transfer';
    bank.hidden = !transfer;
    if (!transfer) return;

    if (!bankSettingsReady(function () { renderSalePaymentExtras(); })) {
        bank.innerHTML = '<p class="bank-box-note">Reading the shop\'s bank account...</p>';
        return;
    }

    const amount = t.onCredit ? t.down : t.due;
    let bankNote = 'Once it is sent, type the bank\'s reference for it in the box below.';
    if (t.onCredit && amount <= 0) bankNote = 'Type what is paid now to see the amount to send.';
    bank.innerHTML = bankBoxHtml(amount, bankNote);
}

// ---------- paying GCash or PayMaya by QR code ----------
// The customer scans a code instead of the cashier typing a reference. The
// code is made on the server (routes/qr-payments.js) through PayMongo or
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
    onLiveChange(['qr-payments'], function () { if (qrSession && !qrSession.over) checkQr(qrSession); });
}

// Pay by QR, beside Complete Sale: the same checkout, with the money taken by
// the code instead of typed in
function payByQr() {
    const form = document.getElementById('checkout-form');
    if (!form) return;
    return handleCheckout({ preventDefault: function () {}, target: form }, true);
}

// Shows a code for amount and waits. purpose is 'sale' or 'credit_payment'
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
            ') was taken but never recorded. The manager\'s QR Payments list shows it as needing a refund.',
            'An earlier QR payment is unused');
    }

    return new Promise(function (resolve) {
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
    session.poller = setInterval(function () { if (qrSession === session) checkQr(session); }, QR_CHECK_MS);
}

function isModalOpen(id) {
    const modal = document.getElementById(id);
    return Boolean(modal && modal.classList.contains('open'));
}

// the card's words, the code and the buttons; made is null while the code is
// being made. The page address the code holds is kept on the image
// (data-pay-url) for the tests, and is not shown.
function showQrCard(session, made) {
    document.getElementById('qr-title').textContent = 'Pay by QR · ' + (QR_APP_WORDS[session.method] || session.method);
    document.getElementById('qr-sub').textContent = session.what;
    document.getElementById('qr-ask').textContent =
        'Ask the customer to scan the code with their phone\'s camera and pay with ' +
        (QR_APP_WORDS[session.method] || session.method) + '.';
    document.getElementById('qr-amount').textContent = peso(session.amount);

    const image = document.getElementById('qr-image');
    if (made) {
        image.src = made.qrImage;
        image.setAttribute('data-pay-url', made.payUrl || '');
    } else {
        image.removeAttribute('src');
        image.removeAttribute('data-pay-url');
    }

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
    function show(id, visible, enabled) {
        const button = document.getElementById(id);
        if (!button) return;
        button.hidden = !visible;
        button.disabled = !enabled;
    }
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
    const image = document.getElementById('qr-image');
    image.removeAttribute('src');
    image.removeAttribute('data-pay-url');
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
    setTimeout(function () {
        endQr(session, {
            id: session.id, reference: state.reference, amount: session.amount, wallet: session.method
        });
    }, 700);
}

// One question to the server, acted on: paid, failed, ran out, or still
// waiting. A question already on its way is shared rather than sent twice.
// Gives back the status, or 'offline'.
function checkQr(session) {
    if (!session.id || session.done) return Promise.resolve('done');
    if (session.inflight) return session.inflight;

    session.inflight = apiGetQrPayment(session.id)
        .then(function (state) {
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
                    if (state.checkError) {
                        setQrStatus('The payment provider cannot be reached just now. Still trying...', 'is-stop');
                    } else {
                        setQrStatus('Waiting for the customer to pay...', '');
                    }
                }
            }
            return state.status;
        })
        .catch(function () {
            if (!session.done && !session.closing && !session.over) {
                setQrStatus('The server cannot be reached just now. Still trying...', 'is-stop');
            }
            return 'offline';
        })
        .finally(function () { session.inflight = null; });
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
            'its time runs out; ask the customer whether it went through before taking the money another way.', 'Not cancelled');
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
window.addEventListener('beforeunload', function (event) {
    if (!qrSession) return;
    event.preventDefault();
    event.returnValue = '';
});
window.addEventListener('pagehide', function () {
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
        'Until then the manager\'s QR Payments list shows it as needing a refund.';
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

    // a short note: why the credit rating is not Good, or the manager's notes
    let note = '';
    if (c.standing !== 'Good' && c.standing_reason) {
        note = '<p class="credit-strip-note">' + escapeHtml(c.standing_reason) + '</p>';
    } else if (c.credit_notes) {
        note = '<p class="credit-strip-note">' + escapeHtml(c.credit_notes) + '</p>';
    }

    strip.className = 'credit-strip ' + tone;
    strip.style.display = 'block';
    strip.innerHTML =
        // the rating in words as well as in the strip's colour
        '<div class="credit-strip-row">' +
            '<span class="credit-strip-label">Credit Rating</span>' +
            '<span class="credit-strip-value">' + escapeHtml(CASH_RATING_WORD[c.standing] || c.standing || '') + '</span>' +
        '</div>' +
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

    if (!t.onAccount) { box.textContent = ''; box.className = 'credit-verdict'; return; }

    if (!selectedCustomerCredit) {
        box.className = 'credit-verdict is-watch';
        if (t.onCredit) {
            box.textContent = 'A credit sale is settled later, so it has to be charged to a named customer.';
        } else {
            box.textContent = 'A COD order is paid on delivery, so it needs a named customer.';
        }
        return;
    }

    const c = selectedCustomerCredit;
    const available = Number(c.available_credit) || 0;
    const name = c.customer_name;

    // a COD order goes on the account for the whole bill, so it meets the same hold and limit
    if (!t.onCredit) {
        if (c.standing === 'Hold') {
            box.className = 'credit-verdict is-stop';
            box.innerHTML = escapeHtml(name) + ' is <strong>on hold</strong>, so a COD order cannot be placed. ' +
                'Take the full ' + peso(t.due) + ' now, or ask a manager to lift the hold.';
        } else if (t.amountOnAccount > available) {
            box.className = 'credit-verdict is-stop';
            box.innerHTML = 'This COD order is over the limit by <strong>' + peso(t.amountOnAccount - available) + '</strong>. ' +
                'Take payment now, or ask for a higher limit from <kbd>Customers Record</kbd>.';
        } else {
            box.className = 'credit-verdict is-good';
            box.innerHTML = peso(t.amountOnAccount) + ' goes on ' + escapeHtml(name) + "'s account until delivery, leaving " +
                peso(available - t.amountOnAccount) + ' of their limit.';
        }
        return;
    }

    if (t.amountOnAccount === 0) {
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

    if (t.amountOnAccount > available) {
        const short = t.amountOnAccount - available;
        box.className = 'credit-verdict is-stop';
        box.innerHTML = 'Over the limit by <strong>' + peso(short) + '</strong>. ' +
            'Take at least ' + peso((t.down || 0) + short) + ' now, or ask for a higher limit ' +
            'from <kbd>Customers Record</kbd>.';
        return;
    }

    box.className = 'credit-verdict is-good';
    box.innerHTML = peso(t.amountOnAccount) + ' goes on ' + escapeHtml(name) + "'s account, leaving " +
        peso(available - t.amountOnAccount) + ' of their limit.';
}

function fillDownPayment(share) {
    const form = document.getElementById('checkout-form');
    if (!form || !form.elements.downPayment) return;

    const t = cartTotals();
    form.elements.downPayment.value = (t.due * share).toFixed(2);
    renderCart();
}

// ---------- the Payment window ----------
// Proceed to Payment, under the order, opens the checkout form (the customer,
// the method, the amounts, the reference, a delivery). It is locked: it closes
// through Back to the Order, its x, or a finished sale, never by a stray click,
// so what was typed in it is not lost.
function openCheckoutModal() {
    if (cart.length === 0) {
        notifyWarning('Add at least one item before going to payment.', 'The order is empty');
        return;
    }

    renderCart();

    const sub = document.getElementById('checkout-sub');
    if (sub) sub.textContent = cart.length + (cart.length === 1 ? ' item' : ' items') + ' on the order';

    showModal('checkout-modal');
    setTimeout(function () {
        const amount = document.getElementById('pay-amount');
        if (isModalOpen('checkout-modal') && amount && amount.offsetParent !== null) amount.focus();
    }, 60);
}

function closeCheckoutModal() {
    hideCustomerSuggestions();
    closeModal('checkout-modal');
}

// the name the confirmation and the messages use for whoever the sale is for
function checkoutCustomerName() {
    const id = selectedCustomerId();
    if (!id) return 'Walk-in';
    if (selectedCustomerCredit && selectedCustomerCredit.customer_name) return selectedCustomerCredit.customer_name;
    const found = findCustomer(id);
    if (found) return found.name;
    return typedCustomerName();
}

// ---------- checkout ----------
// The question asked before a sale is rung up: what it comes to, how it is
// paid, and what the customer gets back or still owes. Its words follow the
// button that was pressed.
function checkoutQuestion(t, customerName) {
    const methodName = t.method === 'COD' ? 'Cash on Delivery' : t.method;
    const detail = ['Customer: ' + customerName, 'Amount due: ' + peso(t.due), 'Payment method: ' + methodName];

    let title = 'Complete this sale?';
    let message = 'Ring up this sale of ' + peso(t.due) + ' for ' + customerName + '?';
    let confirmLabel = 'Complete Sale';

    if (t.method === 'COD') {
        title = 'Place this COD order?';
        message = 'Nothing is collected now; ' + peso(t.due) + ' goes on ' + customerName + "'s account until the delivery is paid.";
        confirmLabel = 'Place COD Order';
        detail.push('Goes on account: ' + peso(t.due));
    } else if (t.onCredit) {
        detail.push('Paid now: ' + peso(t.down) + (t.down > 0 ? ' by ' + downPaymentMethod() : ''));
        if (t.amountOnAccount > 0) {
            if (t.down > 0) {
                title = 'Take part payment and put the rest on account?';
                confirmLabel = 'Take ' + peso(t.down) + ' and put the rest on account';
            } else {
                title = 'Put this sale on account?';
                confirmLabel = 'Put it on their account';
            }
            message = peso(t.amountOnAccount) + ' of this sale goes on ' + customerName + "'s account.";
            detail.push('Goes on account: ' + peso(t.amountOnAccount));
        } else {
            detail.push('Balance on account: ' + peso(0));
        }
    } else {
        detail.push('Amount entered: ' + peso(t.tendered));
        detail.push('Change: ' + peso(t.change));
    }

    if (pendingDelivery) detail.push('Delivery: to ' + pendingDelivery.address);

    return { title: title, message: message, confirmLabel: confirmLabel, detail: detail };
}

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

    // Walk-in is allowed (nothing typed). A name has to be a customer picked
    // from the list; the till does not open an account from a typed name.
    let customerId = null;
    if (form.elements.customerId.value) {
        customerId = parseInt(form.elements.customerId.value, 10);
    } else if (typedName !== '') {
        // the customer list may not have been read yet when the name was typed
        await loadCustomerDirectory(false);
        const exact = customerMatchingTypedName();
        if (exact) {
            customerId = exact.id;
            form.elements.customerId.value = String(exact.id);
            await onCustomerChange(String(exact.id));
            renderCustomerVerdict();
        } else {
            notifyWarning(
                '"' + typedName + '" is not a customer on record. Add them under Customers Record first, ' +
                'then pick them from the list here, or clear the box to ring this up as a walk-in.',
                'Not a customer yet');
            renderCustomerVerdict();
            const box = customerNameBox();
            if (box) box.focus();
            return;
        }
    }

    // a settled-later sale needs a customer, not just a walk-in
    if (t.onAccount && !customerId) {
        notifyWarning(
            'A ' + t.method + ' sale is settled later, so it has to be charged to a customer. '
            + 'Pick them from the list.',
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
        let referenceSubject = 'A ' + taken.toLowerCase() + ' sale';
        if (t.onCredit) referenceSubject = 'The part payment is by ' + taken.toLowerCase() + ', so it';
        let referenceWhat = 'the bank\'s reference for the transfer';
        if (taken === 'Cheque') referenceWhat = 'the cheque number';
        notifyWarning(
            referenceSubject +
            ' needs its reference: ' + referenceWhat +
            '. It is how the money is traced if it does not arrive.',
            'Reference needed');
        const box = document.getElementById('sale-reference');
        if (box) box.focus();
        return;
    }

    // An attached delivery goes to an area on the administrator's list, which
    // may have changed since it was attached. It is read again before any money
    // is taken, so the sale is never saved with a delivery that cannot be created.
    if (pendingDelivery && !(await attachedAreaIsStillListed())) return;

    // Asked before anything is sent: the amount due, the method, and the change
    // or the balance that goes on the account. Paying by QR is its own
    // confirmation (the customer pays the code), except that a balance left on
    // the account is still asked about.
    if (!viaQr || (t.onCredit && t.amountOnAccount > 0)) {
        const question = checkoutQuestion(t, checkoutCustomerName());
        const yes = await askConfirm(question.message, {
            title: question.title,
            eyebrow: 'Point of Sale',
            confirmLabel: question.confirmLabel,
            cancelLabel: 'Go back',
            detail: question.detail
        });

        if (!yes) return;
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
        let qrWhat = 'For this sale';
        if (t.onCredit) qrWhat = 'Paid now on this credit sale';
        qr = await collectQrPayment(amountPaid, qrWhat, taken, 'sale');
        if (!qr) return;
    }

    // the cart lines; quantity is in the unit named, and a plain line names no unit
    const items = [];
    for (let i = 0; i < cart.length; i++) {
        const l = cart[i];
        let unit = null;
        if (!lineChoice(l).own) {
            unit = lineChoice(l).unit_name;
        }
        items.push({ product_id: l.product_id, quantity: l.quantity, unit: unit });
    }

    let referenceNo = reference || null;
    if (qr) referenceNo = null;

    // no name goes with a walk-in: the customer is an account or nobody
    const data = {
        customerId: customerId,
        walkInName: null,
        discount: t.discount,
        amountPaid: amountPaid,
        paymentMethod: t.method,
        downPaymentMethod: downPaymentMethod,
        referenceNo: referenceNo,
        qrPaymentId: qr ? qr.id : null,
        items: items
    };

    try {
        const response = await apiSaveSale(data);
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                let errorText = result.error + '';
                let errorTitle;
                if (qr) {
                    errorText = result.error + keepUnusedQr(qr, result);
                    errorTitle = 'Sale not completed';
                }
                notifyError(errorText, errorTitle);
            }
            return;
        }
        if (qr) qrPaidUnused = null;

        // the delivery is written against the sale before the till is cleared, so a
        // failure is reported while the details are still on screen
        const deliveryMade = await createAttachedDelivery(result.saleId);

        // the sale stands; a reference the server could not keep is said, not hidden
        if (result.referenceNote) notifyWarning(result.referenceNote, 'Reference not saved');

        cart = [];
        form.elements.amountPaid.value = '';
        if (form.elements.downPayment) form.elements.downPayment.value = '';
        if (form.elements.referenceNo) form.elements.referenceNo.value = '';

        if (deliveryMade) { pendingDelivery = null; renderDeliveryAttached(); }

        if (customerId) {
            customerDirectoryLoaded = false;
            await loadCustomerDirectory(true);
            await onCustomerChange(String(customerId));
        } else {
            await clearCustomer();
        }

        catalogLoaded = false;
        renderCart();
        closeCheckoutModal();
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
    let itemsHtml = '';
    for (let i = 0; i < data.items.length; i++) {
        const it = data.items[i];
        // a size shows what it came to on the shelf: "2 sack (50 kg)"
        let shelfNote = '';
        if (it.base_unit && it.unit_name && it.base_unit !== it.unit_name) {
            shelfNote = ' (' + escapeHtml(qtyText(it.base_quantity, it.base_unit)) + ')';
        }
        let perUnit = '';
        if (isMeasuredUnit(it.unit_name)) perUnit = '/' + escapeHtml(measuredUnit(it.unit_name).short);

        itemsHtml += '<tr><td>' + escapeHtml(it.product_name) + '<br><span class="rc-qty">' +
            escapeHtml(qtyText(it.quantity, it.unit_name)) +
            shelfNote +
            ' x ' + peso(it.unit_price) +
            perUnit + '</span></td>' +
            '<td class="rc-amt">' + peso(it.subtotal) + '</td></tr>';
    }

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
    // refunds that came off what the customer owed
    if (Number(s.refunded_amount) > 0) totals.push({ label: 'Refunded', value: '-' + peso(s.refunded_amount) });
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

    let byTransfer = sale.payment_method === 'Bank Transfer';
    const paymentList = payments || [];
    for (let i = 0; i < paymentList.length; i++) {
        if (paymentList[i].payment_method === 'Bank Transfer') byTransfer = true;
    }
    const balance = saleAmountDue(sale) - Number(sale.amount_paid);
    const owing = sale.payment_status !== 'Paid' && balance > 0.004;

    if (!byTransfer && !owing) return '';

    let quoteHtml = '';
    if (owing) {
        quoteHtml = '<p class="rc-bank-note">Quote <strong>' + escapeHtml(receiptNo) + '</strong> as the transfer ' +
            'reference, so the payment is matched to this invoice.</p>';
    }

    return '<div class="rc-rule"></div>' +
        '<div class="rc-bank">' +
            '<p class="rc-bank-head">' + (owing ? 'Pay the balance by bank transfer' : 'Paid by bank transfer') + '</p>' +
            '<div><span>Bank</span><span>' + escapeHtml(shop.bank_name) + '</span></div>' +
            '<div><span>Account name</span><span>' + escapeHtml(shop.bank_account_name) + '</span></div>' +
            '<div><span>Account no.</span><span>' + escapeHtml(shop.bank_account_number) + '</span></div>' +
            quoteHtml +
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
// The date it is created on is not asked for: the server takes it from the sale.
function deliveryFormFields() {
    const form = document.getElementById('make-delivery-form');
    return form ? form.elements : null;
}

// what the customer box and record already know
function fillDeliveryFromCustomer() {
    const fields = deliveryFormFields();
    if (!fields) return;

    const id = selectedCustomerId();
    let account = null;
    if (id) account = findCustomer(id);

    fields.contactName.value = account ? account.name : typedCustomerName();
    phoneFill(fields.contactPhone, account && account.phone ? account.phone : '');

    // The saved address only helps pick the area: the area on the list that
    // appears in it is chosen. The house number and street stay for the cashier.
    chooseDeliveryArea(fields, areaInAddress(account && account.address ? account.address : ''));
    fields.street.value = '';
}

// The places the shop delivers to (System Admin, Delivery Area). They are read
// each time the form opens, so a change made there since is right here.
let deliveryAreaList = [];
// true when the last read of the list failed, so the form says "connection"
// and not "no area is set"
let deliveryAreasUnreadable = false;

async function loadDeliveryAreaChoices() {
    const select = document.getElementById('dl-area');
    const note = document.getElementById('delivery-area-note');
    if (!select) return;

    let problem = '';
    try {
        const body = await apiGetDeliveryAreas();
        deliveryAreaList = body.areas || [];
        deliveryAreasUnreadable = false;
        if (deliveryAreaList.length === 0) {
            problem = 'No delivery area is set. Ask the administrator to add one in System Admin › Receipt Maintenance.';
        }
    } catch (error) {
        deliveryAreaList = [];
        deliveryAreasUnreadable = true;
        // error.status is set when the server answered but said no
        if (error.status) {
            problem = 'The server did not give the delivery areas. Ask the administrator to restart the server.';
        } else {
            problem = 'The delivery areas could not be read. Check the connection and try again.';
        }
    }

    let areaOptions = '<option value="">Choose an area</option>';
    for (let i = 0; i < deliveryAreaList.length; i++) {
        const area = deliveryAreaList[i];
        areaOptions += '<option value="' + escapeHtml(area) + '">' + escapeHtml(area) + '</option>';
    }
    select.innerHTML = areaOptions;
    if (note) note.textContent = problem;
}

// The area on the list whose text appears in the address (any letter case), or ''.
// When more than one appears ("Antipolo" and "Brgy. San Isidro, Antipolo City"),
// the longest is the most exact one.
function areaInAddress(address) {
    const text = String(address || '').toLowerCase();
    if (text === '') return '';

    let found = '';
    for (let i = 0; i < deliveryAreaList.length; i++) {
        const area = deliveryAreaList[i];
        if (text.includes(area.toLowerCase()) && area.length > found.length) {
            found = area;
        }
    }
    return found;
}

// selects an area in the box; one no longer on the list leaves "Choose an area"
function chooseDeliveryArea(fields, area) {
    const wanted = String(area || '').toLowerCase();
    let found;
    for (let i = 0; i < deliveryAreaList.length; i++) {
        if (deliveryAreaList[i].toLowerCase() === wanted) {
            found = deliveryAreaList[i];
            break;
        }
    }
    fields.area.value = found || '';
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

    let found;
    if (query === '') {
        found = driverRoster;
    } else {
        // drivers whose name starts with the text, then those with a later word that does
        const startsWith = [];
        const laterWord = [];
        for (let i = 0; i < driverRoster.length; i++) {
            const d = driverRoster[i];
            const name = String(d.full_name).toLowerCase();
            if (name.startsWith(query)) {
                startsWith.push(d);
            } else if (startsAWord(name, query)) {
                laterWord.push(d);
            }
        }
        found = startsWith.concat(laterWord);
    }

    if (found.length === 0) {
        let emptyText = 'No driver by that name';
        if (driverRoster.length === 0) emptyText = 'No active drivers to assign';
        list.innerHTML = '<li class="suggest-item is-empty" role="option" aria-disabled="true">' +
            '<span class="suggest-note">' + emptyText + '</span></li>';
    } else {
        let driverHtml = '';
        for (let i = 0; i < found.length; i++) {
            const d = found[i];
            driverHtml += '<li class="suggest-item" role="option" id="driver-suggest-' + i + '" ' +
                'onmousedown="event.preventDefault()" ' +
                'onclick="pickDriver(' + d.staff_id + ')">' +
                '<span class="suggest-name">' + escapeHtml(d.full_name) + '</span>' +
            '</li>';
        }
        list.innerHTML = driverHtml;
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
    let driver;
    for (let i = 0; i < driverRoster.length; i++) {
        if (driverRoster[i].staff_id === staffId) {
            driver = driverRoster[i];
            break;
        }
    }
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
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === driverSuggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        let pickIndex = 0;
        if (driverSuggestHighlight >= 0) pickIndex = driverSuggestHighlight;
        const pick = items[pickIndex];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape' || event.key === 'Tab') hideDriverSuggestions();
}

// true while the form waits for the area list, so a double click does not open it twice
let deliveryFormOpening = false;

async function openDeliveryForm() {
    const fields = deliveryFormFields();
    if (!fields || deliveryFormOpening) return;

    // the area box is filled before anything is chosen in it
    deliveryFormOpening = true;
    try {
        await loadDeliveryAreaChoices();
    } finally {
        deliveryFormOpening = false;
    }

    if (pendingDelivery) {
        fields.contactName.value = pendingDelivery.contactName;
        phoneFill(fields.contactPhone, pendingDelivery.contactPhone);
        chooseDeliveryArea(fields, pendingDelivery.area);
        fields.street.value = pendingDelivery.street;
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
            sub.textContent = 'Created when you complete this sale';
        }
    }

    const verdict = document.getElementById('delivery-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }

    showModal('delivery-modal');
    setTimeout(function () { if (fields.contactName) fields.contactName.focus(); }, 60);
}

function saveDeliveryForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = deliveryFormFields();
    const verdict = document.getElementById('delivery-verdict');
    if (!fields) return;

    function complain(text) {
        if (verdict) {
            verdict.className = 'delivery-verdict is-stop';
            verdict.textContent = text;
        }
    }

    const contactName = fields.contactName.value.trim();
    const contactPhone = phoneToStore(fields.contactPhone);
    const phoneProblem = phoneComplaint(fields.contactPhone);
    const area = fields.area.value;
    // many spaces become one, like the server does
    const street = fields.street.value.trim().replace(/\s+/g, ' ');
    const scheduledDate = fields.scheduledDate.value;

    if (contactName === '') { complain('A delivery needs somebody to ask for at the gate.'); fields.contactName.focus(); return; }
    if (contactPhone === '') { complain('A driver who cannot ring ahead is a driver who comes back with the goods.'); fields.contactPhone.focus(); return; }
    if (phoneProblem) { complain(phoneProblem); fields.contactPhone.focus(); return; }

    // with no area on the list, no delivery can be attached at all; the note
    // above the address already says why and what to do, so this stays short
    if (deliveryAreaList.length === 0) {
        if (deliveryAreasUnreadable) {
            complain('A delivery cannot be attached until the delivery areas can be read.');
        } else {
            complain('A delivery cannot be attached until a delivery area is set.');
        }
        return;
    }
    if (area === '') { complain('Choose the area the delivery goes to.'); fields.area.focus(); return; }
    if (street.length < 3 || street.length > 120) {
        complain('Enter the house number and street (3 to 120 characters).');
        fields.street.focus();
        return;
    }

    // a slot in the past is almost always a typing slip in the year or month
    if (scheduledDate && new Date(scheduledDate).getTime() < Date.now() - 60000) {
        complain('That slot has already passed. Check the date and time before attaching it.');
        fields.scheduledDate.focus();
        return;
    }

    // a name typed but never picked would silently leave the delivery open
    const driverBox = document.getElementById('dl-driver');
    let driverId = null;
    if (fields.driverStaffId && fields.driverStaffId.value) driverId = Number(fields.driverStaffId.value);
    let driverName = null;
    if (driverId && driverBox) driverName = driverBox.value;
    if (!driverId && driverBox && driverBox.value.trim() !== '') {
        complain('Pick the driver from the list, or clear the box to leave the delivery open for any driver.');
        driverBox.focus();
        return;
    }

    pendingDelivery = {
        contactName: contactName,
        contactPhone: contactPhone,
        area: area,
        street: street,
        // shown on the strip and the confirm card: the street, then the area
        address: street + ', ' + area,
        scheduledDate: scheduledDate,
        remarks: fields.remarks.value.trim(),
        driverId: driverId,
        driverName: driverName,
        edited: true
    };

    closeModal('delivery-modal');
    renderDeliveryAttached();
    notifyInfo('It will be created when you complete this sale.', 'Delivery attached');
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

    let whenText = 'No slot agreed yet';
    if (d.scheduledDate) whenText = 'Scheduled for ' + escapeHtml(String(d.scheduledDate).replace('T', ' '));
    let driverText = 'Open for any driver to take';
    if (d.driverId) driverText = 'Driver: ' + escapeHtml(d.driverName);

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
            whenText +
        '</p>' +
        '<p class="delivery-attached-line">' +
            driverText +
        '</p>';
}

// true when the area of the attached delivery is still on the list; if not, says what to do
async function attachedAreaIsStillListed() {
    try {
        const body = await apiGetDeliveryAreas();
        deliveryAreaList = body.areas || [];
        deliveryAreasUnreadable = false;
    } catch (error) {
        // error.status is set when the server answered but said no
        if (error.status) {
            notifyError('The server answered but did not give the delivery areas, so the sale was stopped. ' +
                'Nothing has been charged. Ask the administrator to restart the server.', 'Delivery areas not read');
        } else {
            notifyOffline();
        }
        return false;
    }

    const wanted = String(pendingDelivery.area).toLowerCase();
    for (let i = 0; i < deliveryAreaList.length; i++) {
        if (deliveryAreaList[i].toLowerCase() === wanted) return true;
    }

    notifyWarning('The delivery area "' + pendingDelivery.area + '" is no longer on the list. ' +
        'Press Edit Delivery and choose the area again, or remove the delivery. Nothing has been charged.',
        'Delivery area changed');
    return false;
}

// posted once the sale exists; a failure here does not undo the sale
async function createAttachedDelivery(saleId) {
    if (!pendingDelivery) return true;

    const d = pendingDelivery;

    try {
        const response = await apiCreateDelivery({
                saleId: saleId,
                area: d.area,
                street: d.street,
                contactName: d.contactName,
                contactPhone: d.contactPhone,
                scheduledDate: d.scheduledDate || null,
                remarks: d.remarks || null,
                driverStaffId: d.driverId || null
            });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                notifyError('Sale #' + saleId + ' went through, but its delivery was not created: ' +
                    (result.error || 'the server refused it') +
                    '. The sale is saved and paid as rung up; tell the manager so the delivery is arranged.',
                    'Sale saved, delivery not created');
            }
            return false;
        }

        notifySuccess(result.message, 'Delivery created');
        return true;
    } catch (error) {
        notifyError('Sale #' + saleId + ' went through, but the delivery could not be sent to the ' +
            'server, so no delivery exists for it yet. Tell the manager so it is arranged.',
            'Sale saved, delivery not created');
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

        load: function () {
            return apiGetDeliveries();
        },

        match: function (row, query) {
            return prefixMatch([
                row.customer_name, row.delivery_address, row.status,
                row.sale_id, '#' + row.sale_id, row.delivery_id, '#' + row.delivery_id
            ], query);
        },

        filter: function (row, filters) {
            return filters.status === 'all' || row.status === filters.status;
        },

        onLoaded: function (rows) {
            renderDeliveryLegend(rows);
        },

        renderRow: function (row, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
                'onclick="openCashierDeliveryDetail(' + row.delivery_id + ')">' +
                '<td class="cell-id">#' + row.delivery_id + '</td>' +
                '<td class="cell-id">#' + row.sale_id + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.delivery_address) + '</td>' +
                '<td class="cell-id">' + escapeHtml(scheduleText(row.scheduled_date)) + '</td>' +
                '<td>' + statusBadge(row.status) + '</td></tr>';
        }
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

    const stages = ['Pending', 'In Transit', 'Out for Delivery', 'Delivered', 'Delayed'];
    let chips = '';
    for (let s = 0; s < stages.length; s++) {
        let count = 0;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].status === stages[s]) count++;
        }
        chips += '<span class="track-chip"><span class="track-count">' + count + '</span>' + stages[s] + '</span>';
    }
    legend.innerHTML = chips;
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

        // where the money went: off what the customer owes first, the rest is cash to hand back
        const offBalance = Number(result.offBalance) || 0;
        const cashBack = Math.round((data.refundAmount - offBalance) * 100) / 100;
        let balanceNote = '';
        if (offBalance > 0) {
            balanceNote = ' ' + peso(offBalance) + ' came off what the customer owes on sale #' + data.saleId + '.';
        }
        if (cashBack > 0) {
            balanceNote = balanceNote + ' Hand back ' + peso(cashBack) + ' in cash.';
        }
        notifySuccess('The goods are set aside for the stockroom. The clerk has been asked to inspect ' +
            'them and will put them back on the shelf or write them off.' + balanceNote, 'Refund issued');

        form.reset();
        // form.reset() knows nothing about the hidden id, the strip or the suggested figure
        clearRefundProduct();
        refundAmountSuggested = null;
        onReturnReasonInput();
        catalogLoaded = false;
        await loadRecentSales();
    } catch (error) {
        notifyOffline();
    }
}

// Sales in the Past 3 Days (beside the refund form): the receipts a refund can
// be made from. The server sends every cashier's sales (a customer can bring a
// refund to any counter) from today and the
// two days before, newest first. A voided sale is left out: it did not happen,
// so there is nothing to refund on it. The list reads on its own whenever the
// Refunds screen opens (showRefunds), so there is no Load Data button.
function buildRecentSalesPanel() {
    createDataPanel({
        key: 'cash-recent-sales',
        tableId: 'recent-sales-table',
        columns: 6,
        pageSize: RECENT_SALES_ROWS_PER_PAGE,
        pagerId: 'recent-sales-pager',
        idField: 'sale_id',
        // it is small and is read again on every visit, so it is not remembered
        remember: false,

        gate: {
            title: 'No sales loaded',
            text: 'The sales of the past three days are read when this screen opens.',
            button: 'Load Data'
        },

        empty: {
            title: 'No sales in the past 3 days',
            text: 'A refund needs a receipt number. For an older sale, type its number in the form.'
        },

        load: function () {
            return apiGetRecentSales();
        },

        match: function (row, query) {
            return prefixMatch([
                row.customer_name, row.sale_id, '#' + row.sale_id, 'OR-' + String(row.sale_id).padStart(6, '0')
            ], query);
        },

        renderRow: function (row, index) {
            let refundedNote = '';
            if (Number(row.refunded_amount) > 0) {
                refundedNote = '<span class="cell-sub">refunded ' + peso(row.refunded_amount) + '</span>';
            }
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
                'onclick="openRecentSale(' + row.sale_id + ')">' +
                '<td class="cell-id">#' + row.sale_id + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(row.sale_date).slice(0, 16)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td class="cell-num">' + row.item_count + '</td>' +
                '<td class="cell-num">' + peso(row.final_amount) + refundedNote + '</td>' +
                '<td>' + statusBadge(row.payment_status) +
                    '<span class="cell-sub">' + escapeHtml(row.payment_method) + '</span></td></tr>';
        }
    });
}

// reads the list now: opens it the first time, reads it again after that
async function loadRecentSales() {
    const panel = getDataPanel('cash-recent-sales');
    if (!panel) return;
    if (panel.state === 'ready') await panel.refresh();
    else await panel.open();
}

// the receipt open in the popup: its lines, and the line the cashier pressed
let recentSale = null;

async function openRecentSale(saleId) {
    let data;
    try { data = await apiGetSale(saleId); }
    catch (error) {
        notifyWarning('The receipt could not be opened. Check the connection and try again.', 'Receipt unavailable');
        return;
    }

    const s = data.sale;
    recentSale = { saleId: s.sale_id, items: data.items, picked: -1 };

    let refundedText = '<span class="muted">Nothing yet</span>';
    if (Number(s.refunded_amount) > 0) refundedText = peso(s.refunded_amount);

    const facts = '<div class="detail-grid">' +
        detailField('Date', escapeHtml(String(s.sale_date).slice(0, 16))) +
        detailField('Customer', escapeHtml(s.customer_name)) +
        detailField('Rung Up By', escapeHtml(s.cashier_name)) +
        detailField('Total', peso(s.final_amount)) +
        detailField('Payment', escapeHtml(s.payment_method) + ' ' + statusBadge(s.payment_status)) +
        detailField('Refunded Already', refundedText) +
        '</div>';

    const body = facts +
        '<h4 class="detail-subhead">Items</h4>' +
        '<p class="detail-note" id="recent-sale-pick">Press an item to fill the Product box with it.</p>' +
        recentSaleItemsTable();

    openDetailModal('Receipt #' + s.sale_id, s.customer_name + ' · ' + String(s.sale_date).slice(0, 16),
        'R' + s.sale_id, [{ label: 'Receipt', body: body }],
        '<button type="button" class="btn btn-success" onclick="refundFromRecentSale()">Refund from this receipt</button>',
        { wide: true });
}

// the lines of the open receipt; the pressed line is shaded
function recentSaleItemsTable() {
    const rows = [];
    for (let i = 0; i < recentSale.items.length; i++) {
        const it = recentSale.items[i];
        let refundedCell = '<span class="muted">None</span>';
        if (Number(it.refunded_quantity) > 0) {
            refundedCell = escapeHtml(qtyText(it.refunded_quantity, it.base_unit)) +
                '<span class="cell-sub">' + peso(it.refunded_amount) + '</span>';
        }
        rows.push([
            escapeHtml(it.product_name),
            escapeHtml(qtyText(it.quantity, it.unit_name)),
            peso(it.unit_price),
            peso(it.subtotal),
            refundedCell
        ]);
    }

    return pagedTable('recent-sale-items', ['Product', 'Qty', 'Unit Price', 'Total', 'Refunded'], rows,
        [1, 2, 3, 4], {
            empty: 'This receipt has no items.',
            pageSize: 8,
            rowAttrs: function (index) {
                return 'class="row-clickable" title="Refund this item" ' +
                    'onclick="pickRecentSaleItem(' + index + ')"' +
                    (index === recentSale.picked ? ' style="background: var(--go-dim);"' : '');
            }
        });
}

// pressing a line chooses it; pressing it again lets it go
function pickRecentSaleItem(index) {
    if (!recentSale) return;

    recentSale.picked = recentSale.picked === index ? -1 : index;

    const hint = document.getElementById('recent-sale-pick');
    if (hint) {
        if (recentSale.picked === -1) {
            hint.textContent = 'Press an item to fill the Product box with it.';
        } else {
            hint.textContent = 'Chosen: ' + recentSale.items[index].product_name + '. It goes into the Product box.';
        }
    }
    pagedTableGo('recent-sale-items', 0);
}

// true when the open receipt has a line for this product
function receiptHasProduct(productId) {
    for (let i = 0; i < recentSale.items.length; i++) {
        if (recentSale.items[i].product_id === productId) return true;
    }
    return false;
}

// puts the receipt number (and the pressed item) into the refund form, closes
// the popup, and moves the cursor to the next box still empty
async function refundFromRecentSale() {
    if (!recentSale) return;
    const form = document.getElementById('refund-form');
    if (!form) return;

    let line = null;
    if (recentSale.picked !== -1) line = recentSale.items[recentSale.picked];
    form.elements.saleId.value = recentSale.saleId;
    closeModal('detail-modal');

    if (line) {
        await ensureCatalogLoaded(false);
        // the product may be gone from the catalogue (archived): say so
        if (findCatalogProduct(line.product_id)) {
            pickRefundProduct(line.product_id);
        } else {
            clearRefundProduct();
            notifyWarning(line.product_name + ' cannot be picked here, it may have been archived. ' +
                'Type the product by hand.', 'Product not filled in');
        }
    } else if (refundProduct && !receiptHasProduct(refundProduct.product_id)) {
        // a product chosen earlier that is not on this receipt would be refunded against it
        clearRefundProduct();
    }

    let next = document.getElementById('return-reason');
    if (!refundProduct) next = refundProductBox();
    else if (!(Number(form.elements.quantity.value) > 0)) next = form.elements.quantity;
    else if (!(Number(form.elements.refundAmount.value) > 0)) next = form.elements.refundAmount;

    if (next) next.focus();
}

// Sales report. The server sends a cashier their own sales and no others, so
// there is no Mine / All switch: whatever is loaded is theirs.
function buildSalesPanel() {
    createDataPanel({
        key: 'cash-sales',
        tableId: 'csales-table',
        columns: 6,
        pageSize: CASHIER_ROWS_PER_PAGE,
        pagerId: 'csales-pager',
        idField: 'sale_id',
        filters: { method: 'all', status: 'all' },

        gate: {
            title: 'No sales loaded',
            text: 'Search for a customer or a receipt number, or press Load Data to read your sales.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetSales('');
        },

        match: function (row, query) {
            return prefixMatch([
                row.customer_name, row.payment_method, row.payment_status, row.transaction_status,
                row.sale_id, '#' + row.sale_id, 'OR-' + String(row.sale_id).padStart(6, '0')
            ], query);
        },

        filter: function (row, filters) {
            if (filters.method !== 'all' && row.payment_group !== filters.method) return false;
            if (filters.status !== 'all' && row.transaction_status !== filters.status) return false;
            return true;
        },

        renderRow: function (row, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
                'onclick="openReceipt(' + row.sale_id + ')">' +
                '<td class="cell-id">OR-' + String(row.sale_id).padStart(6, '0') + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(row.sale_date).slice(0, 10)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.payment_method) + '</td>' +
                '<td>' + statusBadge(row.payment_status) + '</td>' +
                '<td class="cell-num">' + peso(row.final_amount) + '</td></tr>';
        }
    });
}

function clearSalesPanel() {
    const panel = getDataPanel('cash-sales');
    if (panel) panel.reset();

    const search = document.getElementById('csales-search');
    if (search) search.value = '';

    const method = document.getElementById('csales-method');
    if (method) method.value = 'all';

    const status = document.getElementById('csales-status');
    if (status) status.value = 'all';
}

async function loadCashierSales() {
    const panel = getDataPanel('cash-sales');
    if (!panel) return;
    if (panel.state === 'closed') await panel.open();
    else await panel.refresh();
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

// the row in this list for the sale, or null
function findSaleRow(list, saleId) {
    for (let i = 0; i < list.length; i++) {
        if (list[i].sale_id === saleId) return list[i];
    }
    return null;
}

async function openPaymentForm(saleId) {
    let row = findSaleRow(customerOpenSales, saleId);

    // not among the card's rows: read the list for the one row
    if (!row) {
        try {
            const rows = await apiGetOpenSales();
            row = findSaleRow(rows, saleId);
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

    let penaltyNote = '';
    if (Number(row.penalty_amount) > 0) {
        let monthWord = ' months';
        if (Number(row.penalty_months) === 1) monthWord = ' month';
        penaltyNote = ' <span class="muted">+ ' + peso(row.penalty_amount) + ' late penalty (' +
            escapeHtml(penaltyRateWord(row.penalty_rate)) + ' a month, ' + row.penalty_months +
            monthWord + ' overdue)</span>';
    }
    let paymentCountNote = '';
    if (Number(row.payment_count) > 0) {
        let paymentWord = ' payments';
        if (row.payment_count === 1) paymentWord = ' payment';
        paymentCountNote = ' <span class="muted">' + row.payment_count + paymentWord + '</span>';
    }

    document.getElementById('payment-facts').innerHTML =
        detailField('Customer', escapeHtml(row.customer_name) +
            (row.phone ? ' <span class="muted">' + escapeHtml(row.phone) + '</span>' : '')) +
        detailField('Sale', escapeHtml(String(row.sale_date).slice(0, 10)) +
            ' <span class="muted">' + escapeHtml(row.payment_method) + '</span>') +
        detailField('Total', peso(row.final_amount) + penaltyNote) +
        detailField('Paid So Far', peso(row.amount_paid) + paymentCountNote) +
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
    setTimeout(function () { if (fields && fields.amount) { fields.amount.focus(); fields.amount.select(); } }, 60);
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

    if (!bankSettingsReady(function () { renderPaymentVerdict(); })) {
        bank.innerHTML = '<p class="bank-box-note">Reading the shop\'s bank account...</p>';
        return;
    }

    let bankNote = 'Type the amount to see what to send.';
    if (amount > 0) bankNote = 'Once it is sent, type the bank\'s reference for it in the reference box.';
    bank.innerHTML = bankBoxHtml(amount, bankNote);
}

// what the balance becomes if this is recorded, said before the button
function renderPaymentVerdict() {
    const box = document.getElementById('payment-verdict');
    const fields = paymentFormFields();
    if (!box || !fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = parseFloat(fields.amount.value) || 0;

    renderPaymentBankBox(Math.min(Math.max(amount, 0), balance));

    // The reference is on screen only for a method that has a number to trace it
    // by (REFERENCE_WORDS): not for cash. When it goes, so does anything typed.
    const refField = document.getElementById('payment-ref-field');
    const words = REFERENCE_WORDS[fields.paymentMethod.value];
    if (refField) {
        refField.hidden = !words;
        if (words) {
            const hint = document.getElementById('payment-ref-hint');
            if (hint) hint.textContent = words.hint;
            fields.referenceNo.placeholder = words.placeholder;
        } else if (fields.referenceNo.value !== '') {
            fields.referenceNo.value = '';
        }
    }

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
    function ready() {
        if (button) { button.disabled = false; button.textContent = 'Record the Payment'; }
        if (qrButton) qrButton.disabled = false;
    }

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

    let referenceNo = reference || null;
    if (qr) referenceNo = null;

    try {
        const response = await apiTakePayment(paymentSale.sale_id, {
            amount: amount,
            paymentMethod: method,
            referenceNo: referenceNo,
            qrPaymentId: qr ? qr.id : null
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) {
                let errorText = result.error + '';
                if (qr) errorText = result.error + keepUnusedQr(qr, result);
                notifyError(errorText, 'Payment not recorded');
            }
            ready();
            return;
        }
        if (qr) qrPaidUnused = null;

        const left = balance - amount;
        let leftText = peso(left) + ' is still owed on it.';
        if (left <= 0.004) leftText = 'The sale is paid in full.';
        notifySuccess(peso(amount) + ' taken from ' + paymentSale.customer_name + ' against OR-' +
            String(paymentSale.sale_id).padStart(6, '0') + '. ' +
            leftText,
            'Payment recorded');

        closePaymentForm();

        // the credit list and a customer picked at the till follow
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
    let intro = '';
    if (customerOpenSales.length !== 0) {
        let saleWord = ' sales';
        if (customerOpenSales.length === 1) saleWord = ' sale';
        intro = '<p class="panel-sub" style="margin-bottom: 12px;">' + peso(owed) + ' owed on ' +
            customerOpenSales.length + saleWord +
            ', oldest first. Press the one the money is for.</p>';
    }

    const unpaidRows = [];
    for (let i = 0; i < customerOpenSales.length; i++) {
        const row = customerOpenSales[i];
        let penaltyNote = '';
        if (penaltyInBalance(row) > 0) {
            penaltyNote = '<span class="cell-sub">incl. ' + peso(penaltyInBalance(row)) + ' penalty</span>';
        }
        unpaidRows.push([
            '<span class="cell-id">OR-' + String(row.sale_id).padStart(6, '0') + '</span>',
            escapeHtml(String(row.sale_date).slice(0, 10)) +
                ' <span class="muted">' + escapeHtml(row.payment_method) + '</span>',
            '<span class="cell-due">' + peso(row.balance_due) + '</span>' + penaltyNote,
            debtDueCell(row)
        ]);
    }

    box.innerHTML = intro + pagedTable('cash-unpaid', ['Receipt', 'Sold', 'Balance', 'Due'],
        unpaidRows, [2], {
            empty: 'Nothing is owed on any sale.',
            // the row itself opens the payment form for that sale
            rowAttrs: function (index) {
                return 'class="row-clickable" title="Take a payment on this sale" ' +
                    'onclick="payCustomerSale(' + customerOpenSales[index].sale_id + ')"';
            }
        });
}

// Customers and credit: the cashier can read an account and ask a manager
// for more room. Setting a limit is refused by the server here.
const CASH_RATING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };

// The cashier's list reads by due date: oldest unpaid sale plus thirty days,
// the same thirty after which the credit rating turns to Watch (vw_customer_credit).
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
// a customer's Credit Rating (the data still calls it "standing")
const CASH_RATING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

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

        load: function () {
            return apiGetCreditCustomers();
        },

        match: function (row, query) {
            return prefixMatch([row.customer_name, row.phone], query);
        },

        filter: function (row, filters) {
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

        renderRow: function (row, index) {
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
// falling back to the account once nothing is owed; 'history' or 'payments')
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
                customerOpenSales = [];
                for (let i = 0; i < open.length; i++) {
                    if (Number(open[i].customer_id) === Number(customerId)) customerOpenSales.push(open[i]);
                }
            } catch (error) {
                customerOpenSales = [];
            }
        }

        document.getElementById('customer-modal-name').textContent = c.customer_name;
        document.getElementById('customer-sub').textContent =
            (c.phone || 'No phone on file') + ' · Credit Rating: ' + (CASH_RATING_WORD[c.standing] || c.standing);
        document.getElementById('customer-avatar').textContent = initialsOf(c.customer_name);

        let availableCell = peso(c.available_credit);
        if (c.standing === 'Hold') availableCell = '<span class="cell-due">Nothing, on hold</span>';

        let overdueNote = '';
        if (Number(c.overdue_sales) > 0) overdueNote = ' <span class="cell-due">' + c.overdue_sales + ' overdue</span>';

        let penaltiesFact = '';
        if (Number(c.penalties_owed) > 0) {
            penaltiesFact = detailField('Late Penalties', '<span class="cell-due">' + peso(c.penalties_owed) +
                '</span> <span class="muted">of the amount owed, at ' +
                escapeHtml(penaltyRateWord(c.penalty_rate)) + ' a month</span>');
        }

        let noteFact = '';
        if (c.credit_notes) noteFact = detailField('Manager Note', escapeHtml(c.credit_notes));

        document.getElementById('customer-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Balance', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Available Balance', availableCell) +
            detailField('Due Date', creditDueCell(c)) +
            detailField('Credit Rating', '<span class="badge ' +
                (CASH_RATING_TONE[c.standing] || 'badge-neutral') + '">' +
                escapeHtml(CASH_RATING_WORD[c.standing] || c.standing) + '</span>') +
            detailField('Why', escapeHtml(c.standing_reason || '')) +
            detailField('Open Sales', String(c.open_sales) + overdueNote) +
            penaltiesFact +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            detailField('Address', c.address ? escapeHtml(c.address) : '<span class="muted">Not on file</span>') +
            noteFact;

        resetHistoryFilters();
        renderCustomerHistory();
        renderCustomerPayments();
        renderCustomerUnpaid();

        // the Unpaid Sales tab and Take a Payment, only when there is something to pay
        const hasUnpaid = payable && customerOpenSales.length > 0;
        const unpaidTab = document.getElementById('customer-tab-unpaid');
        if (unpaidTab) unpaidTab.hidden = !hasUnpaid;
        const pay = document.getElementById('customer-pay-btn');
        if (pay) pay.hidden = !hasUnpaid;

        let open = 'account';
        if (tab === 'unpaid' && hasUnpaid) open = 'unpaid';
        else if (tab === 'history' || tab === 'payments') open = tab;
        showCustomerTab(open);
        showModal('customer-modal');
    } catch (error) {
        notifyError('That customer could not be opened.', 'Nothing to show');
    }
}

// the account, the unpaid sales, the purchases and the payments, one tab each
function showCustomerTab(name) {
    const tabNames = ['account', 'unpaid', 'history', 'payments'];
    for (let i = 0; i < tabNames.length; i++) {
        const each = tabNames[i];
        const body = document.getElementById('customer-' + each + '-tab');
        if (body) body.style.display = name === each ? 'block' : 'none';
        const tab = document.getElementById('customer-tab-' + each);
        if (tab) tab.classList.toggle('active', name === each);
    }
}

// ---------- the history tabs ----------
// Purchase History and Credit & Payments are a tab each, paged with Previous
// and Next rather than scrolled, and filtered in the browser over the rows
// the card already loaded (openCustomer): a date range on both, the sale's
// status on purchases and the method on payments. Changing a filter starts
// the table again at its first page.
function filterValue(id) {
    const box = document.getElementById(id);
    return box ? box.value : '';
}

// "2026-09-05 10:00:00" -> "2026-09-05"; the day is what the date boxes compare
function dayOfStamp(value) { return String(value || '').slice(0, 10); }

function dayInRange(day, from, to) {
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
}

// the sentence under a filtered table that has no rows
function emptyHistoryNote(nothing, from, to, filtered) {
    if (from && to && from > to) return 'The From date is after the To date.';
    if (filtered) return 'Nothing matches these filters.';
    return nothing;
}

function renderCustomerHistory() {
    const box = document.getElementById('customer-history');
    if (!box || !openCustomer) return;

    const from = filterValue('hist-from');
    const to = filterValue('hist-to');
    const status = filterValue('hist-status') || 'all';

    const rows = [];
    for (let i = 0; i < openCustomer.purchases.length; i++) {
        const p = openCustomer.purchases[i];
        if (!dayInRange(dayOfStamp(p.sale_date), from, to)) continue;
        const owing = Number(p.balance_due) > 0;
        if (status === 'owing' && !owing) continue;
        if (status === 'paid' && owing) continue;
        rows.push(p);
    }

    const total = document.getElementById('customer-history-total');
    if (total) total.textContent = peso(openCustomer.credit.total_purchase);

    const purchaseRows = [];
    for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        let penaltyNote = '';
        if (Number(p.penalty_amount) > 0) {
            penaltyNote = '<span class="cell-sub">+ ' + peso(p.penalty_amount) + ' penalty</span>';
        }
        let balanceCell = '<span class="muted">Paid</span>';
        if (Number(p.balance_due) > 0) balanceCell = '<span class="cell-due">' + peso(p.balance_due) + '</span>';
        purchaseRows.push([
            escapeHtml(dayOfStamp(p.sale_date)),
            '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
            peso(p.final_amount) + penaltyNote,
            balanceCell
        ]);
    }

    box.innerHTML = pagedTable('cash-purchases', ['Date', 'Sale', 'Amount', 'Balance'],
        purchaseRows, [2, 3], {
            empty: emptyHistoryNote('Nothing bought yet.', from, to, status !== 'all' || from || to)
        });
}

function renderCustomerPayments() {
    const box = document.getElementById('customer-payments');
    if (!box || !openCustomer) return;

    const from = filterValue('pay-from');
    const to = filterValue('pay-to');
    const how = filterValue('pay-how') || 'all';

    const rows = [];
    for (let i = 0; i < openCustomer.payments.length; i++) {
        const p = openCustomer.payments[i];
        if (dayInRange(dayOfStamp(p.payment_date), from, to) && (how === 'all' || p.payment_method === how)) {
            rows.push(p);
        }
    }

    const c = openCustomer.credit;
    const total = document.getElementById('customer-payments-total');
    if (total) {
        if (Number(c.current_credit) > 0) {
            total.innerHTML = '<span class="cell-due">' + peso(c.current_credit) + ' balance</span>';
        } else {
            total.innerHTML = 'No balance';
        }
    }

    const paymentRows = [];
    for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        paymentRows.push([
            escapeHtml(dayOfStamp(p.payment_date)),
            peso(p.amount),
            escapeHtml(p.payment_method) +
                (p.sale_id ? ' <span class="muted">#' + p.sale_id + '</span>' : '')
        ]);
    }

    box.innerHTML = pagedTable('cash-payments', ['Date', 'Amount', 'How'],
        paymentRows, [1], {
            empty: emptyHistoryNote('No payments recorded.', from, to, how !== 'all' || from || to)
        });
}

// a card just opened: the filters start empty, and the method list is the
// methods this customer has actually paid by
function resetHistoryFilters() {
    const filterIds = ['hist-from', 'hist-to', 'pay-from', 'pay-to'];
    for (let i = 0; i < filterIds.length; i++) {
        const box = document.getElementById(filterIds[i]);
        if (box) box.value = '';
    }
    const status = document.getElementById('hist-status');
    if (status) status.value = 'all';

    const how = document.getElementById('pay-how');
    if (how) {
        const methods = [];
        for (let i = 0; i < openCustomer.payments.length; i++) {
            const p = openCustomer.payments[i];
            if (p.payment_method && methods.indexOf(p.payment_method) === -1) methods.push(p.payment_method);
        }
        methods.sort();
        let methodOptions = '<option value="all">All</option>';
        for (let i = 0; i < methods.length; i++) {
            methodOptions += '<option value="' + escapeHtml(methods[i]) + '">' + escapeHtml(methods[i]) + '</option>';
        }
        how.innerHTML = methodOptions;
        how.value = 'all';
    }
}

// ---------- asking for a higher limit ----------
// One form: the new limit and why. The reason is required, here and at the
// server. The customer's card steps aside while the form is up (the form
// would otherwise sit beneath it) and comes back if the request is dropped.
const MINIMUM_LIMIT_REASON = 5;
let limitReturnCustomer = null;

function askForExtension() {
    if (!openCustomer) return;

    const c = openCustomer.credit;
    const current = Number(c.credit_limit) || 0;

    let waiting = false;
    const requestList = openCustomer.requests || [];
    for (let i = 0; i < requestList.length; i++) {
        if (requestList[i].status === 'Pending') waiting = true;
    }

    if (waiting) {
        notifyWarning('A request for ' + c.customer_name + ' is already waiting for a manager. ' +
            'Adding another would not make it arrive sooner.', 'Already asked');
        return;
    }

    limitReturnCustomer = c.customer_id;

    document.getElementById('limit-sub').textContent = c.customer_name;
    document.getElementById('limit-intro').textContent =
        c.customer_name + ' may currently owe up to ' + peso(current) + ' and owes ' + peso(c.current_credit) +
        '. A manager decides the new limit; nothing changes until they do.';

    const form = document.getElementById('limit-form');
    form.elements.requestedLimit.value = current > 0 ? String(Math.round(current * 1.5)) : '';
    form.elements.reason.value = '';

    const send = document.getElementById('limit-send');
    if (send) send.disabled = false;

    renderLimitVerdict();
    closeModal('customer-modal');
    showModal('limit-modal');
    setTimeout(function () { form.elements.requestedLimit.focus(); }, 60);
}

// counts up to the minimum: "have you said enough yet"
function renderLimitVerdict() {
    const form = document.getElementById('limit-form');
    const counter = document.getElementById('limit-counter');
    const verdict = document.getElementById('limit-verdict');
    if (!form || !counter) return;

    const length = form.elements.reason.value.trim().length;

    if (length === 0) {
        counter.className = 'reason-counter';
        counter.textContent = 'Required. One line is enough: a manager reading this later will not have the customer in front of them.';
    } else if (length < MINIMUM_LIMIT_REASON) {
        counter.className = 'reason-counter is-short';
        counter.textContent = (MINIMUM_LIMIT_REASON - length) + ' more character' +
            (MINIMUM_LIMIT_REASON - length === 1 ? '' : 's') + ' before this can be sent.';
    } else {
        counter.className = 'reason-counter is-good';
        counter.textContent = 'That will do.';
    }

    // an earlier complaint goes once the form is being fixed
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

// Cancel puts the customer's card back, read afresh
function closeLimitForm() {
    closeModal('limit-modal');
    const customerId = limitReturnCustomer;
    limitReturnCustomer = null;
    if (customerId) openCustomerCredit(customerId);
}

async function handleLimitRequest(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!openCustomer) return;

    const c = openCustomer.credit;
    const current = Number(c.credit_limit) || 0;
    const form = document.getElementById('limit-form');
    const verdict = document.getElementById('limit-verdict');

    function complain(text, field) {
        if (verdict) { verdict.className = 'delivery-verdict is-stop'; verdict.textContent = text; }
        if (field) field.focus();
    }

    const typed = form.elements.requestedLimit.value;
    const requested = Number(typed);
    const reason = form.elements.reason.value.trim().replace(/\s+/g, ' ');

    if (typed === '' || !isFinite(requested)) {
        complain('Type the limit you are asking for.', form.elements.requestedLimit);
        return;
    }
    if (requested <= current) {
        complain('It has to be more than the current ' + peso(current) + '.', form.elements.requestedLimit);
        return;
    }
    if (reason.length < MINIMUM_LIMIT_REASON) {
        complain('Say why the limit should go up (at least ' + MINIMUM_LIMIT_REASON + ' characters). ' +
            'The manager deciding it will not have the customer in front of them.', form.elements.reason);
        return;
    }

    const send = document.getElementById('limit-send');
    if (send) send.disabled = true;

    try {
        const response = await apiAskCreditExtension({
                customerId: c.customer_id,
                requestedLimit: requested,
                reason: reason
            });
        const result = await response.json();

        if (!response.ok) {
            if (send) send.disabled = false;
            if (!handleAuthFailure(response, result)) complain(result.error || 'The request was not sent.');
            return;
        }

        notifySuccess(result.message, 'Request sent');
        limitReturnCustomer = null;
        closeModal('limit-modal');
    } catch (error) {
        if (send) send.disabled = false;
        notifyOffline();
    }
}

// ---------- Add Customer ----------
// The one place an account is opened (the till no longer opens one from a
// typed name). Name is required; the server refuses a name already on the
// list, any case, and gives the account a credit limit of zero.
let addCustomerForSale = false;   // opened from the payment form: the new account goes on the sale

function openAddCustomer() {
    addCustomerForSale = false;

    const form = document.getElementById('add-customer-form');
    if (!form) return;

    form.reset();
    phoneFill(form.elements.phone, '');

    const verdict = document.getElementById('add-customer-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
    const save = document.getElementById('add-customer-save');
    if (save) save.disabled = false;

    showModal('add-customer-modal');
    setTimeout(function () { form.elements.name.focus(); }, 60);
}

function cancelAddCustomer() {
    addCustomerForSale = false;
    closeModal('add-customer-modal');
}

async function handleAddCustomer(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const form = document.getElementById('add-customer-form');
    const verdict = document.getElementById('add-customer-verdict');
    if (!form) return;

    function complain(text, field) {
        if (verdict) { verdict.className = 'delivery-verdict is-stop'; verdict.textContent = text; }
        if (field) field.focus();
    }

    // "Maria  Santos" and "Maria Santos" are one customer
    const name = form.elements.name.value.trim().replace(/\s+/g, ' ');
    const phone = phoneToStore(form.elements.phone);
    const phoneProblem = phoneComplaint(form.elements.phone);
    const address = form.elements.address.value.trim();

    if (name === '') { complain('A customer needs a name.', form.elements.name); return; }
    if (phoneProblem) { complain(phoneProblem, form.elements.phone); return; }
    if (address === '') { complain('A customer needs an address.', form.elements.address); return; }

    // the first word is the first name, the rest the surname
    const parts = name.split(' ');
    const firstName = parts.shift();
    const lastName = parts.join(' ');

    const save = document.getElementById('add-customer-save');
    if (save) save.disabled = true;

    try {
        const response = await apiCreateCustomer({
                firstName: firstName, lastName: lastName, phone: phone, address: address });
        const result = await response.json();

        if (!response.ok) {
            if (save) save.disabled = false;
            if (!handleAuthFailure(response, result)) {
                complain(result.error || 'The customer was not added.', form.elements.name);
            }
            return;
        }

        closeModal('add-customer-modal');
        notifySuccess(result.message, 'Customer added');

        // the register's customer box reads the customer list afresh, and the list shows the new account
        customerDirectoryLoaded = false;

        // opened from the payment form: the new account is the sale's customer
        if (addCustomerForSale) {
            addCustomerForSale = false;
            await loadCustomerDirectory(true);
            await pickCustomer(Number(result.customerId));
        }

        const panel = getDataPanel('cash-credit');
        if (panel) {
            if (panel.state === 'closed' || panel.state === 'error') await panel.open();
            else await panel.refresh();
        }
    } catch (error) {
        if (save) save.disabled = false;
        notifyOffline();
    }
}

// ---------- Credit Payment, from the register ----------
// Takes a payment against a customer's balance without going to Customers
// Record: pick who owes, and the card's own flow follows -- the card opens on
// Unpaid Sales, a sale opens the payment form, and the form offers Pay by QR.
// A customer owing on one sale only goes straight to that sale's form.
async function openCreditPaymentPicker() {
    if (!canTakePayments()) return;

    const search = document.getElementById('credit-pay-search');
    if (search) search.value = '';

    const list = document.getElementById('credit-pay-list');
    if (list) list.innerHTML = '<p class="detail-empty">Reading the customers...</p>';

    showModal('credit-pay-modal');
    setTimeout(function () { if (search) search.focus(); }, 60);

    // read fresh: a balance paid a moment ago must not be offered again
    const loaded = await loadCustomerDirectory(true);
    if (!loaded && list) {
        list.innerHTML = '<p class="detail-empty">The customers could not be read. Check the connection and try again.</p>';
        return;
    }
    renderCreditPayList();
}

function renderCreditPayList() {
    const list = document.getElementById('credit-pay-list');
    const search = document.getElementById('credit-pay-search');
    if (!list) return;

    const owing = [];
    for (let i = 0; i < customerDirectory.length; i++) {
        if (Number(customerDirectory[i].current_credit) > 0) owing.push(customerDirectory[i]);
    }
    if (owing.length === 0) {
        list.innerHTML = '<p class="detail-empty">Nobody owes anything right now.</p>';
        return;
    }

    const query = searchText(search ? search.value : '');
    const found = [];
    for (let i = 0; i < owing.length; i++) {
        if (query === '' || prefixMatch([owing[i].name, owing[i].phone], query)) found.push(owing[i]);
    }
    found.sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
    });

    if (found.length === 0) {
        list.innerHTML = '<p class="detail-empty">Nobody who owes matches <kbd>' + escapeHtml(query) + '</kbd>.</p>';
        return;
    }

    let payHtml = '';
    for (let i = 0; i < found.length; i++) {
        const c = found[i];
        payHtml += '<button type="button" class="credit-pay-item" onclick="pickCreditPayCustomer(' + c.id + ')">' +
            '<span><span class="credit-pay-name">' + escapeHtml(c.name) + '</span>' +
                '<span class="credit-pay-meta">' + escapeHtml(c.phone || 'No phone on file') + '</span></span>' +
            '<span class="credit-pay-owes">owes ' + peso(c.current_credit) + '</span>' +
        '</button>';
    }
    list.innerHTML = payHtml;
}

async function pickCreditPayCustomer(customerId) {
    closeModal('credit-pay-modal');
    await openCustomerCredit(customerId, 'unpaid');

    if (isModalOpen('customer-modal') && customerOpenSales.length === 1) payFromCustomerCard();
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
        buildRecentSalesPanel();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: function (panelId, title) { showCashierPanel(panelId, title); } });
        buildDeliverySchedulePanel();
        configureFeatures({ home: function () { showCashierHome(); } });

        // Go to, on an opened alert: the screen that alert is about
        const creditAlert = { label: 'Customers Record', panelId: 'panel-customers',
                              open: function () { showCustomers(); }, key: 'cash-credit' };
        configureNotificationTargets({
            'Delivery':       { label: 'Delivery Tracking', panelId: 'panel-delivery',
                                open: function () { showCashierDeliveries(); }, key: 'cash-deliveries' },
            'Refund Report':  { label: 'Refunds', panelId: 'panel-refund',
                                open: function () { showRefunds(); } },
            'Credit Request': creditAlert,
            'Late Penalty':   creditAlert
        });

        onReturnReasonInput();
        renderCatalogEmpty();
        renderCustomerVerdict();
        renderRefundProductVerdict();
        renderDeliveryAttached();
        showCashierHome();
        unfoldSidebarAtOpenScreen();
        // the customer list is fetched the first time somebody types; the store
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
