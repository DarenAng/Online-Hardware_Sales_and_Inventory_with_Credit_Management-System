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
    on: 'Already on the order. Change the amount with + and − on the order.',
    // a product the clerk added that the manager has not priced yet
    noPrice: 'No price yet. Ask the manager to set it; it cannot be sold until then.'
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
    const product = findCatalogProduct(productId);
    if (product && isUnpriced(product)) {
        notifyWarning(product.product_name + ' has no price yet, so it cannot be sold. Ask the manager to set the price.',
            'No price yet');
        return;
    }
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
    const slice = sortedCatalogRows(rows).slice(start, start + CATALOG_PAGE_ROWS);

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
        // no price yet: greyed and cannot be pressed (the server refuses it as well)
        const noPrice = isUnpriced(p);
        if (noPrice) {
            rowClass = ' is-unpriced';
            rowTitle = CATALOG_ROW_TITLE.noPrice;
            disabledAttr = ' aria-disabled="true"';
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
            '<td>' + escapeHtml(p.brand_name || '-') + '</td>' +
            '<td class="cell-unit">' + escapeHtml(p.unit_name || '-') + sizesHtml + '</td>' +
            '<td class="cell-num catalog-price">' +
                (noPrice ? '<span class="badge badge-warning">No price yet</span><span class="price-per">ask the manager</span>'
                         : peso(p.price) + perHtml) + '</td>' +
        '</tr>';
    }

    grid.innerHTML =
        '<table class="catalog-table" id="catalog-table">' +
        '<thead><tr>' + catalogHeaders() + '</tr></thead>' +
        '<tbody>' + rowsHtml +
        // a short page is topped up to ten so the pager stays put (tables.js)
        fillerRows(CATALOG_PAGE_ROWS - slice.length, 5) +
        '</tbody></table>' + pager;

    holdTableHeight(document.getElementById('catalog-table'));
    holdBoxHeight(grid);
}

// ---------- sorting the catalog by pressing a column header ----------
const CATALOG_HEADERS = ['Product', 'Category', 'Brand', 'Sold By', 'Price'];
const CATALOG_SORT_KEYS = [
    function (p) { return p.product_name || ''; },
    function (p) { return p.category_name || 'Uncategorised'; },
    function (p) { return p.brand_name || ''; },
    function (p) { return p.unit_name || ''; },
    function (p) { return isUnpriced(p) ? '' : Number(p.price); }
];
let catalogSort = null;    // { column, descending } once a header is pressed

function sortedCatalogRows(rows) {
    if (!catalogSort) return rows;
    const key = CATALOG_SORT_KEYS[catalogSort.column];
    const descending = catalogSort.descending;
    const indexed = rows.map(function (row, at) { return { row: row, value: key(row), at: at }; });
    indexed.sort(function (x, y) {
        const xEmpty = x.value === null || x.value === undefined || x.value === '';
        const yEmpty = y.value === null || y.value === undefined || y.value === '';
        if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
        const result = compareSortValues(x.value, y.value);
        return (descending ? -result : result) || x.at - y.at;
    });
    return indexed.map(function (item) { return item.row; });
}

function catalogHeaders() {
    let html = '';
    for (let i = 0; i < CATALOG_HEADERS.length; i++) {
        let state = 'none';
        if (catalogSort && catalogSort.column === i) state = catalogSort.descending ? 'descending' : 'ascending';
        html += '<th class="th-sortable" tabindex="0" aria-sort="' + state + '" title="Sort by ' + CATALOG_HEADERS[i] + '" ' +
            'onclick="sortCatalog(' + i + ')" ' +
            'onkeydown="if (event.key === \'Enter\' || event.key === \' \') { event.preventDefault(); sortCatalog(' + i + '); }">' +
            CATALOG_HEADERS[i] + '</th>';
    }
    return html;
}

// pressing a header sorts by it; pressing it again turns the order round
function sortCatalog(column) {
    if (catalogSort && catalogSort.column === column) catalogSort.descending = !catalogSort.descending;
    else catalogSort = { column: column, descending: false };
    catalogPage = 1;
    renderCatalog(catalogShown);
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
    // from a sale on the form: what the customer paid for it; otherwise today's price
    const saleLine = refundSaleLine(refundProduct.product_id);
    const suggested = saleLine
        ? refundLineAmount(saleLine, Math.max(quantity, 0))
        : Math.round(Number(refundProduct.price) * Math.max(quantity, 0) * 100) / 100;

    const current = parseFloat(field.value);
    const untouched = !field.value || current === 0 || current === refundAmountSuggested;

    if (untouched) {
        field.value = suggested.toFixed(2);
        refundAmountSuggested = suggested;
        if (note) {
            note.className = 'amount-source';
            note.textContent = saleLine
                ? 'What the customer paid for ' + quantity + ' on sale #' + refundSale.saleId + '.'
                : quantity + ' at ' + peso(refundProduct.price) + '. Change it if the customer paid a different price.';
        }
        return;
    }

    if (note) {
        note.className = 'amount-source is-edited';
        note.textContent = saleLine
            ? 'Your figure. The customer paid ' + peso(suggested) + ' for ' + quantity + '.'
            : 'Your figure. ' + quantity + ' at today\'s price would be ' + peso(suggested) + '.';
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

// first and last name only, without the middle name: "Maria Santos" for "Maria S. Santos"
function customerShortName(c) {
    return (String(c.first_name || '') + ' ' + String(c.last_name || '')).trim();
}

// the middle name written out: "Maria Reyes Santos" for "Maria R. Santos"
function customerSpelledName(c) {
    return (String(c.first_name || '') + ' ' + String(c.middle_name || '') + ' ' + String(c.last_name || '')).replace(/\s+/g, ' ').trim();
}

// The account a typed name stands for, or null. The name as the record writes it
// ("Maria R. Santos") comes first. The name with the middle name written out, and the
// first and last name alone, count only when exactly one customer has that spelling:
// with a Maria R. Santos and a Maria L. Santos on record, "Maria Santos" is nobody
// yet, and the list under the box is how the cashier says which.
function customerMatchingName(typed) {
    const text = String(typed || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (text === '') return null;

    const spellings = [
        function (c) { return String(c.name).trim().toLowerCase(); },
        function (c) { return customerSpelledName(c).toLowerCase(); },
        function (c) { return customerShortName(c).toLowerCase(); }
    ];
    for (let k = 0; k < spellings.length; k++) {
        const found = [];
        for (let i = 0; i < customerDirectory.length; i++) {
            if (spellings[k](customerDirectory[i]) === text) found.push(customerDirectory[i]);
        }
        if (found.length === 1) return found[0];
    }
    return null;
}

// the account whose name is in the box, only while the text still matches exactly
function customerMatchingTypedName() {
    return customerMatchingName(typedCustomerName());
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

// The suggestion list is drawn under the Payment card's customer box and under
// the delivery form's recipient box the same way; only the elements and the
// function a pick calls differ.
const CUSTOMER_PICKERS = {
    payment: { boxId: 'customer-name', listId: 'customer-suggest', pick: 'pickCustomer' },
    delivery: { boxId: 'dl-name', listId: 'dl-customer-suggest', pick: 'pickDeliveryCustomer' }
};

function renderCustomerSuggestions(text, where) {
    const picker = CUSTOMER_PICKERS[where || 'payment'];
    const list = document.getElementById(picker.listId);
    const box = document.getElementById(picker.boxId);
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
        else if (prefixMatch([name, customerShortName(c), customerSpelledName(c), c.phone], query)) words.push(c);
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
            'onclick="' + picker.pick + '(' + c.id + ')">' +
            '<span class="suggest-name">' + escapeHtml(c.name) + '</span>' +
            noteHtml +
            '</li>';
    }
    list.innerHTML = suggestHtml;

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideCustomerSuggestions(where) {
    const picker = CUSTOMER_PICKERS[where || 'payment'];
    const list = document.getElementById(picker.listId);
    const box = document.getElementById(picker.boxId);
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    suggestHighlight = -1;
}

// arrow keys and Enter: a cashier's hands are on the keyboard
function onCustomerKey(event) {
    customerSuggestKey(event, 'customer-suggest', 'payment');
}

function customerSuggestKey(event, listId, where) {
    const list = document.getElementById(listId);
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

    if (event.key === 'Escape') hideCustomerSuggestions(where);
}

// The customer in the directory with this id, or undefined
function findCustomer(customerId) {
    for (let i = 0; i < customerDirectory.length; i++) {
        if (customerDirectory[i].id === customerId) return customerDirectory[i];
    }
    return undefined;
}

async function pickCustomer(customerId) {
    let found = findCustomer(customerId);
    // a customer added a moment ago may not be in the list yet: load it again once
    if (!found) {
        customerDirectoryLoaded = false;
        await loadCustomerDirectory(true);
        found = findCustomer(customerId);
    }
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

    if (typed === '' && pendingDelivery) {
        box.className = 'customer-verdict is-good';
        box.textContent = 'The delivery is for ' + pendingDelivery.contactName + ', so this sale is saved under their name.';
        return;
    }

    if (typed === '') {
        box.className = 'customer-verdict';
        box.textContent = '';
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
    addCustomerFor = 'sale';
    prefillAddCustomerName(typedCustomerName());
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
    if (isUnpriced(p)) {
        notifyWarning(p.product_name + ' has no price yet, so it cannot be sold. Ask the manager to set the price.',
            'No price yet');
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
        if (form.elements.downPayment) form.elements.downPayment.value = '0';
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
        if (row.classList.contains('is-unpriced')) continue;   // it never goes on the order
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
        } else if (t.method === 'Bank Transfer') {
            // the customer pays through their bank: exactly the bill, so no change
            html += '<div class="total-row total-note"><span>Paid by bank transfer</span><span>' +
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

    // GCash, PayMaya and a bank transfer are only ever taken through PayMongo
    // (Pay by QR, Pay by Bank Transfer), so Complete Sale is not offered for them.
    const taken = methodTakenNow(t);
    const button = document.getElementById('checkout-btn');
    if (button) {
        button.disabled = cart.length === 0 || (!t.onAccount && t.tendered < t.due);
        button.hidden = QR_METHODS.indexOf(taken) !== -1;
        button.textContent = checkoutLabel(t);
    }

    // GCash, PayMaya or a bank transfer taken now: the QR code is the other way to
    // finish (the only way for a transfer), and needs no amount typed, as the code
    // is for the bill (or the part paid) exactly
    const qrButton = document.getElementById('qr-pay-btn');
    if (qrButton) {
        qrButton.hidden = QR_METHODS.indexOf(taken) === -1;
        qrButton.disabled = cart.length === 0;
        qrButton.textContent = taken === 'Bank Transfer' ? 'Pay by Bank Transfer' : 'Pay by QR';
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

// ---------- how the money arrives: its reference, and the bank and account ----------
// A cheque is only money once it clears, and it is traced by its number, so it
// needs one before the sale is rung up, with the account name and number printed
// on it, the bank and its branch, and the date (payment-details.js). A bank
// transfer is verified through PayMongo: the customer's bank and account are
// asked for, and the reference is PayMongo's own payment number, not typed.
// An e-wallet prints a reference too, taken when the cashier has it. Cash needs none.

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

// the boxes for a cheque's details and for a bank transfer's (payment-details.js)
buildPaymentDetailsBox('sale-details-box', 'sale', true);
buildPaymentDetailsBox('payment-details-box', 'pay-debt', true);

// the reference box and the cheque or bank-transfer boxes under the payment fields
function renderSalePaymentExtras(totals) {
    const t = totals || cartTotals();

    // A sale asks for no reference: not for an e-wallet, which is paid by QR
    // code, and not for a cheque, which is traced by its account, bank and date.
    // (The Credit Settlement card asks for none either.)
    const taken = methodTakenNow(t);
    const field = document.getElementById('sale-reference-field');
    const words = null;
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

    // The cheque or the transfer boxes follow the method taken now; on a credit
    // sale that is the part payment's, even before an amount is typed, so the
    // cashier can ask for the details as it is agreed.
    let detailsFor = taken;
    if (t.onCredit) detailsFor = downPaymentMethod();
    showPaymentDetails('sale', detailsFor);
}

// The inventory moved (somebody added a product, the manager set a price): when the
// catalogue is loaded it is read again and redrawn, so a product that was just priced
// stops being greyed without pressing Load Data. Only the catalogue is touched: the
// order, the customer and the payment boxes stay as they are.
let catalogRefreshing = false;

async function refreshCatalogQuietly() {
    if (!catalogLoaded || catalogRefreshing) return;
    catalogRefreshing = true;
    try {
        catalog = await apiGetProducts();
        fillCatalogCategories();
        applyCatalogView();
    } catch (error) {
        // the catalogue on screen stays as it was; the next change reads it again
    } finally {
        catalogRefreshing = false;
    }
}

if (typeof onLiveChange === 'function') {
    onLiveChange(['inventory'], refreshCatalogQuietly);
}

// Pay by QR, beside Complete Sale: the same checkout, with the money taken by
// the code instead of typed in
function payByQr() {
    const form = document.getElementById('checkout-form');
    if (!form) return;
    return handleCheckout({ preventDefault: function () {}, target: form }, true);
}

function onPaymentMethodChange(method) {
    const tender = document.getElementById('tender-field');
    const down = document.getElementById('downpayment-field');

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    // only one of the tender box and the down payment box is ever shown
    if (tender) tender.style.display = (onAccount || method === 'Bank Transfer') ? 'none' : 'block';
    if (down) down.style.display = onCredit ? 'block' : 'none';

    renderCart();
}

// Credit at the counter: the account is read when the customer is picked and
// printed above the payment fields rather than raised as an error after.
let selectedCustomerCredit = null;

async function onCustomerChange(customerId) {
    const strip = document.getElementById('credit-strip');
    selectedCustomerCredit = null;

    // a delivery already attached goes to the customer the sale is now for
    syncDeliveryToSaleCustomer(customerId);

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
        availableText = 'Nothing, on hold';
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

// the name the confirmation and the messages use for whoever the sale is for;
// '' when the sale is on no customer record
function checkoutCustomerName() {
    const id = selectedCustomerId();
    if (!id) return '';
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
    // a sale on no customer record says so, and the question names no one
    const detail = ['Customer: ' + (customerName || 'No record'), 'Amount due: ' + peso(t.due), 'Payment method: ' + methodName];

    let title = 'Complete this sale?';
    let message = 'Ring up this sale of ' + peso(t.due) + (customerName ? ' for ' + customerName : '') + '?';
    let confirmLabel = 'Complete Sale';

    if (t.method === 'COD') {
        title = 'Place this COD order?';
        message = 'Nothing is collected now; ' + peso(t.due) + ' goes on ' + customerName + "'s account until the delivery is paid.";
        confirmLabel = 'Place COD Order';
        detail.push('Balance: ' + peso(t.due));
    } else if (t.onCredit) {
        detail.push('Amount Paid: ' + peso(t.down) + (t.down > 0 ? ' by ' + downPaymentMethod() : ''));
        if (t.amountOnAccount > 0) {
            if (t.down > 0) {
                title = 'Take part payment and put the rest on account?';
                confirmLabel = 'Take ' + peso(t.down) + ' and put the rest on account';
            } else {
                title = 'Put this sale on account?';
                confirmLabel = 'Put it on their account';
            }
            message = peso(t.amountOnAccount) + ' of this sale goes on ' + customerName + "'s account.";
            detail.push('Balance: ' + peso(t.amountOnAccount));
        } else {
            detail.push('Balance: ' + peso(0));
        }
    } else if (t.method === 'Bank Transfer') {
        detail.push('Paid by bank transfer: ' + peso(t.due));
    } else {
        detail.push('Amount entered: ' + peso(t.tendered));
        detail.push('Change: ' + peso(t.change));
    }

    if (pendingDelivery) detail.push('Location: ' + pendingDelivery.address);

    return { title: title, message: message, confirmLabel: confirmLabel, detail: detail };
}

// puts the cursor in the box with this id
function focusBox(id) {
    const box = document.getElementById(id);
    if (box) box.focus();
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

    // GCash, PayMaya and a bank transfer are only taken through PayMongo, whichever
    // way the sale was sent (Enter too)
    if (QR_METHODS.indexOf(methodTakenNow(t)) !== -1) viaQr = true;

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

    // a delivery is for a customer on record: when the sale has none, it takes the delivery's
    if (pendingDelivery && !customerId && pendingDelivery.customerId) {
        customerId = pendingDelivery.customerId;
        await pickCustomer(customerId);
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

    // A cheque is taken with its account name, account number, bank, branch and
    // date; a bank transfer with the customer's bank and account. The server
    // refuses them missing too.
    const taken = methodTakenNow(t);
    let chequeDetails = null;
    let transferDetails = null;
    if (taken === 'Cheque') {
        const read = readChequeDetails('sale');
        if (read.problem) {
            notifyWarning(read.problem, 'Cheque details needed');
            focusBox(read.field);
            return;
        }
        chequeDetails = read.details;
    } else if (taken === 'Bank Transfer') {
        const read = readTransferDetails('sale');
        if (read.problem) {
            notifyWarning(read.problem, 'Bank details needed');
            focusBox(read.field);
            return;
        }
        transferDetails = read.details;

        // PayMongo refuses a transfer below the bank's smallest
        const bank = paymongoBank(transferDetails.bankCode);
        const transferAmount = t.onCredit ? t.down : t.due;
        if (bank && transferAmount < bank.minimum) {
            notifyWarning(bank.name + ' takes transfers of ' + peso(bank.minimum) + ' or more. This one is ' +
                peso(transferAmount) + '.', 'Too small for ' + bank.name);
            focusBox('sale-transfer-bank');
            return;
        }
    }

    const reference = saleReference();

    // Asked before anything is sent: the amount due, the method, and the change
    // or the balance that goes on the account. Paying by QR is its own
    // confirmation (the customer pays the code), except that a balance left on
    // the account is still asked about.
    if (!viaQr || (t.onCredit && t.amountOnAccount > 0) || transferDetails) {
        const question = checkoutQuestion(t, checkoutCustomerName());
        if (chequeDetails) {
            question.detail.push('Cheque: ' + chequeDetails.bank + ' \u00b7 dated ' + chequeDetails.chequeDate);
            question.detail.push('Account: ' + chequeDetails.accountName + ', ' + chequeDetails.accountNumber);
        }
        if (transferDetails) {
            question.detail.push('Customer\'s bank: ' + transferDetails.bank);
            question.detail.push('Account name: ' + transferDetails.accountName);
            question.detail.push('Account number: ' + transferDetails.accountNumber);
            question.confirmLabel = 'Make the QR code';
        }
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
        qr = await collectQrPayment(amountPaid, qrWhat, taken, 'sale', null, transferDetails);
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
        paymentDetails: chequeDetails || transferDetails,
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
        if (form.elements.downPayment) form.elements.downPayment.value = '0';
        if (form.elements.referenceNo) form.elements.referenceNo.value = '';
        clearPaymentDetails('sale');

        if (deliveryMade) { pendingDelivery = null; renderDeliveryAttached(); }

        // the balance changed, so the customer list is read again
        if (customerId) {
            customerDirectoryLoaded = false;
            await loadCustomerDirectory(true);
        }

        // the next sale starts clean: no customer and Cash, so nothing has to be
        // cleared by hand. A delivery that could not be created keeps its
        // customer, so the cashier can still see who it was for.
        if (!pendingDelivery) {
            await clearCustomer();
            form.elements.paymentMethod.value = 'Cash';
            onPaymentMethodChange('Cash');
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

// whether a sale names a customer: an account, or a name taken at the till
function saleHasCustomer(s) {
    return Boolean(s.customer_id) || String(s.walk_in_name || '').trim() !== '';
}

// fromReport: opened from Sales Report, where a sale of today can be asked to be voided
async function openReceipt(saleId, fromReport) {
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
    document.getElementById('receipt-avatar').textContent = 'IN';
    document.getElementById('receipt-role').textContent = 'Sales invoice';
    document.getElementById('receipt-print-btn').textContent = 'Print Invoice';
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
    // everything refunded on the sale, then the part of it that came off what the customer owed
    if (Number(s.returned_total) > 0) totals.push({ label: 'Refunded', value: '-' + peso(s.returned_total) });
    if (Number(s.refunded_amount) > 0) totals.push({ label: 'Taken off the balance', value: '-' + peso(s.refunded_amount) });
    totals.push({ label: 'Received Amount', value: peso(s.amount_paid) });
    totals.push({ label: 'Change', value: peso(s.change_given) });

    const paper = document.getElementById('receipt-paper');
    applyReceiptPaper(paper, shop);
    paper.innerHTML = receiptHtml(shop, {
        registration: s.tax_registration,
        receiptNo: receiptNo,
        meta: [
            { key: 'date', label: 'Date', value: s.sale_date },
            { key: 'cashier', label: 'Cashier', value: s.cashier_name },
            // a sale on no customer record leaves the line blank
            { key: 'customer', label: 'Customer', keepBlank: true,
              value: saleHasCustomer(s) ? s.customer_name : '' },
            { key: 'payment', label: 'Payment', value: s.payment_method },
            { key: 'reference', label: 'Reference', value: paymentReference(s.payment_method, s.reference_no) }
        ],
        itemsHtml: itemsHtml,
        itemCount: receiptItemCount(data.items),
        totals: totals,
        taxHtml: receiptTaxBlock(s),
        paid: s.payment_status === 'Paid',
        balanceText: s.payment_status.toUpperCase() + ' BALANCE ' + peso(saleAmountDue(s) - Number(s.amount_paid)),
        detailsHtml: paymentDetailsReceiptHtml(paymentDetailItems(data), true),
        bankHtml: receiptBankBlock(shop, s, receiptNo)
    });

    // a credit sale's invoice offers the terms page, when the role may print it
    const termsButton = document.getElementById('receipt-terms-btn');
    if (termsButton) {
        termsButton.hidden = !(s.payment_method === 'Credit' && s.customer_id && holdsFeature('credit-terms-print'));
    }

    renderVoidButton(fromReport ? data : null);
    showModal('receipt-modal');
}

// Request Void on the invoice: only from Sales Report, only for a sale of today
// not yet voided; while a request waits for the manager it reads Void Requested.
function renderVoidButton(data) {
    const button = document.getElementById('receipt-void-btn');
    if (!button) return;
    const s = data ? data.sale : null;
    if (!s || Number(s.is_archived) || Number(s.is_today) !== 1) {
        button.hidden = true;
        button.removeAttribute('data-sale-id');
        return;
    }
    const waiting = Boolean(data.voidRequest && data.voidRequest.status === 'Pending');
    button.hidden = false;
    button.disabled = waiting;
    button.textContent = waiting ? 'Void Requested' : 'Request Void';
    button.title = waiting ? 'Waiting for a manager to approve or decline it' : 'Ask a manager to void this sale';
    button.setAttribute('data-sale-id', String(s.sale_id));
}

async function requestVoidSale() {
    const button = document.getElementById('receipt-void-btn');
    const saleId = button ? Number(button.getAttribute('data-sale-id')) : 0;
    if (!saleId) return;
    const receiptNo = 'OR-' + String(saleId).padStart(6, '0');

    const typed = await askInput({
        title: 'Request a void?', eyebrow: 'Sales Report',
        message: receiptNo + ' is sent to a manager. Once they approve, the sale is voided and its goods go back on the shelf.',
        label: 'Reason', placeholder: 'Wrong items rung up', confirmLabel: 'Send Request', cancelLabel: 'Go back',
        check: function (value) {
            return String(value || '').trim() === '' ? 'Type why the sale should be voided.' : null;
        }
    });
    if (typeof typed !== 'string') return;

    try {
        const response = await apiRequestVoid(saleId, typed.trim());
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Request not sent');
            return;
        }
        notifySuccess(result.message + ' You are told here when they decide.', 'Void requested');
        if (button) { button.disabled = true; button.textContent = 'Void Requested'; }
        const panel = getDataPanel('cash-sales');
        if (panel && panel.state === 'ready') await panel.refresh();
    } catch (error) {
        notifyOffline();
    }
}

// The receipt of one Credit Settlement payment, on the invoice's own paper and head
// (receiptHtml, format.js): the date, who took it, whose it is, the sale it was put
// against, how it was paid, and what the sale owed before and after.
// info: { saleId, paymentId, paymentDate, cashierName, customerName, taxRegistration,
//         amount, method, reference, balanceBefore, balanceAfter }
async function showPaymentReceipt(info) {
    await loadStoreSettings(false);
    const shop = storeSettings || {};

    const saleNumber = 'OR-' + String(info.saleId).padStart(6, '0');

    // when the server could not send the payment's own number, the receipt does not
    // borrow the sale's invoice number
    let receiptNo = 'CS-UNNUMBERED';
    if (info.paymentId) receiptNo = 'CS-' + String(info.paymentId).padStart(6, '0');

    let paidAt = new Date().toLocaleString('en-PH');
    if (info.paymentDate) paidAt = String(info.paymentDate).slice(0, 19);

    let cashier = info.cashierName;
    if (!cashier && getCurrentUser()) cashier = staffName(getCurrentUser());

    let footText = 'BALANCE ' + peso(info.balanceAfter);
    if (Number(info.balanceAfter) <= 0.004) footText = 'SALE PAID IN FULL';

    document.getElementById('receipt-heading').textContent = 'Payment Receipt';
    document.getElementById('receipt-avatar').textContent = 'CS';
    document.getElementById('receipt-role').textContent = 'Credit Settlement';
    document.getElementById('receipt-print-btn').textContent = 'Print Receipt';

    const paper = document.getElementById('receipt-paper');
    applyReceiptPaper(paper, shop);
    paper.innerHTML = receiptHtml(shop, {
        registration: info.taxRegistration,
        receiptNo: receiptNo,
        title: 'CREDIT SETTLEMENT RECEIPT',
        meta: [
            { key: 'date', label: 'Date', value: paidAt },
            { key: 'cashier', label: 'Cashier', value: cashier },
            { key: 'customer', label: 'Customer', value: info.customerName },
            { label: 'Applied to', value: saleNumber },
            { key: 'payment', label: 'Method', value: info.method },
            { key: 'reference', label: 'Reference', value: paymentReference(info.method, info.reference) }
        ],
        totals: [
            { label: 'Balance Before', value: peso(info.balanceBefore) },
            { label: 'Amount Paid', value: peso(info.amount), due: true },
            { label: 'Balance After', value: peso(info.balanceAfter) }
        ],
        paid: false,
        balanceText: footText,
        detailsHtml: info.details
            ? paymentDetailsReceiptHtml([{ detail: info.details, reference: info.reference, label: info.method + ' details' }], true)
            : '',
        // a payment receipt, not a sales invoice: no invoice note, its own thanks
        noInvoiceNote: true,
        footerLines: ['Thank you for your payment']
    });

    // it is not a credit sale's invoice: no terms page to offer, nor a void
    lastReceipt = null;
    const termsButton = document.getElementById('receipt-terms-btn');
    if (termsButton) termsButton.hidden = true;
    renderVoidButton(null);

    showModal('receipt-modal');
}

// The shop's account on the invoice, as the way to pay when the sale leaves a
// balance, with the invoice number to quote so the money can be matched to this
// sale when it lands. (A transfer taken at the counter shows the customer's own
// bank and account instead: paymentDetailsReceiptHtml.)
function receiptBankBlock(shop, sale, receiptNo) {
    if (!shop || !shop.bank_account_number) return '';

    const balance = saleAmountDue(sale) - Number(sale.amount_paid);
    const owing = sale.payment_status !== 'Paid' && balance > 0.004;

    if (!owing) return '';

    const quoteHtml = '<p class="rc-bank-note">Quote <strong>' + escapeHtml(receiptNo) + '</strong> as the transfer ' +
        'reference, so the payment is matched to this invoice.</p>';

    return '<div class="rc-rule"></div>' +
        '<div class="rc-bank">' +
            '<p class="rc-bank-head">Pay the balance by bank transfer</p>' +
            '<div><span>Bank</span><span>' + escapeHtml(shop.bank_name) + '</span></div>' +
            '<div><span>Account name</span><span>' + escapeHtml(shop.bank_account_name) + '</span></div>' +
            '<div><span>Account no.</span><span>' + escapeHtml(shop.bank_account_number) + '</span></div>' +
            quoteHtml +
        '</div>';
}

// the Credit Terms and Conditions page for the customer of the invoice on screen
function printReceiptCreditTerms() {
    if (!lastReceipt || !lastReceipt.sale.customer_id) return;
    printCreditTerms(lastReceipt.sale.customer_id);
}

function printReceipt() {
    // a credit page still on the paper is put back first
    if (typeof finishCreditPrint === 'function') finishCreditPrint();
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

// ---------- the delivery's customer ----------
// The recipient is a customer on record, picked the way the Payment card picks
// one (the same suggestion list, the same "Not a customer on record" line with
// an Add Customer button). A pick fills the contact number and the address
// boxes from the customer's record; the cashier can still change any of them
// for this one delivery. The sale and its delivery share one customer: attaching the
// delivery puts the sale on its customer (a pick alone changes nothing outside this
// card, so Cancel leaves everything as it was), and picking another customer on the
// Payment card moves an attached delivery to them (syncDeliveryToSaleCustomer).
let deliveryFormIsOpen = false;

function deliveryCustomerIdBox() {
    const fields = deliveryFormFields();
    return fields ? fields.customerId : null;
}

function selectedDeliveryCustomerId() {
    const box = deliveryCustomerIdBox();
    return box && box.value ? parseInt(box.value, 10) : null;
}

function typedDeliveryName() {
    const fields = deliveryFormFields();
    return fields ? fields.contactName.value.trim().replace(/\s+/g, ' ') : '';
}

// A customer's address as the boxes want it. One added through Add Customer has
// its parts. One from before that has only the old one-line address: every box is
// left empty and the line is shown above them (oldLine), for the cashier to copy
// what is needed. It is not put into a box: it already says the barangay, town and
// province, so the joined address would say them twice.
function savedAddressParts(account) {
    const empty = { street: '', barangay: '', city: '', province: '', landmark: '', oldLine: '' };
    if (!account) return empty;

    const hasParts = account.address_barangay || account.address_city || account.address_province;
    if (hasParts) {
        return {
            street: account.address_street || '',
            barangay: account.address_barangay || '',
            city: account.address_city || '',
            province: account.address_province || '',
            landmark: account.address_landmark || '',
            oldLine: ''
        };
    }

    empty.oldLine = String(account.address || '').trim();
    return empty;
}

// what the customer record knows, put into the contact number and address boxes
function fillDeliveryFromCustomer(account) {
    const fields = deliveryFormFields();
    if (!fields) return;

    phoneFill(fields.contactPhone, account && account.phone ? account.phone : '');

    const saved = savedAddressParts(account);
    fields.street.value = saved.street;
    fields.barangay.value = saved.barangay;
    fields.city.value = saved.city;
    fields.province.value = saved.province;
    fields.landmark.value = saved.landmark;

    // an old one-line address is only shown; the boxes are for the cashier to fill in
    const note = document.getElementById('dl-saved-address');
    if (note) {
        if (saved.oldLine !== '') {
            note.textContent = 'This customer was saved with one address line: ' + saved.oldLine +
                '. Fill in the boxes below from it.';
            note.hidden = false;
        } else {
            note.textContent = '';
            note.hidden = true;
        }
    }
}

// What a customer pick filled in is taken out again: the number, the address boxes
// and the old-address note. Used when the name no longer says that customer.
function clearDeliveryFilledBoxes() {
    fillDeliveryFromCustomer(null);
}

// one line under the recipient box saying whether it is a customer on record
function renderDeliveryCustomerVerdict() {
    const box = document.getElementById('dl-customer-verdict');
    const addButton = document.getElementById('dl-customer-add-btn');
    if (!box) return;

    const typed = typedDeliveryName();
    const id = selectedDeliveryCustomerId();

    const offerAdd = !id && typed !== '' && canAddCustomers();
    if (addButton) addButton.hidden = !offerAdd;

    if (id) {
        box.className = 'customer-verdict is-good';
        box.textContent = 'A customer on record. Their number and address are filled in below.';
    } else if (typed === '') {
        box.className = 'customer-verdict';
        box.textContent = "Type the customer's name and pick them from the list.";
    } else {
        // a name that matches nobody is a stop until the account is opened
        box.className = 'customer-verdict is-stop';
        if (offerAdd) {
            box.textContent = 'Not a customer on record. Press Add Customer to open their account, ' +
                'or clear the box.';
        } else {
            box.textContent = 'Not a customer on record. Add them under Customers Record first, then pick them here.';
        }
    }
}

async function onDeliveryCustomerInput(value) {
    const text = String(value || '').trim();
    const idBox = deliveryCustomerIdBox();
    const clear = document.getElementById('dl-customer-clear');
    if (clear) clear.hidden = text === '';

    if (!customerDirectoryLoaded && text !== '') await loadCustomerDirectory(false);

    // a name that is exactly a customer on record is a pick; any other text is nobody
    const exact = customerMatchingName(text);
    if (exact && idBox && idBox.value !== String(exact.id)) {
        await pickDeliveryCustomer(exact.id);
        return;
    }
    // the text no longer says the customer that was picked: what the pick filled in goes too
    if (!exact && idBox && idBox.value !== '') {
        idBox.value = '';
        clearDeliveryFilledBoxes();
    }

    // a customer already picked needs no list under the box
    if (exact) hideCustomerSuggestions('delivery');
    else renderCustomerSuggestions(text, 'delivery');
    renderDeliveryCustomerVerdict();
}

function onDeliveryCustomerKey(event) {
    customerSuggestKey(event, 'dl-customer-suggest', 'delivery');
}

async function pickDeliveryCustomer(customerId) {
    const found = findCustomer(customerId);
    const fields = deliveryFormFields();
    if (!found || !fields) return;

    fields.contactName.value = found.name;
    fields.customerId.value = String(found.id);
    const clear = document.getElementById('dl-customer-clear');
    if (clear) clear.hidden = false;

    hideCustomerSuggestions('delivery');
    fillDeliveryFromCustomer(found);
    clearDeliveryErrors();
    renderDeliveryCustomerVerdict();
    // the sale moves to this customer only when the delivery is attached (saveDeliveryForm);
    // Cancel leaves the sale as it was
}

function clearDeliveryCustomer() {
    const fields = deliveryFormFields();
    if (!fields) return;

    fields.contactName.value = '';
    if (fields.customerId.value !== '') clearDeliveryFilledBoxes();
    fields.customerId.value = '';
    const clear = document.getElementById('dl-customer-clear');
    if (clear) clear.hidden = true;

    hideCustomerSuggestions('delivery');
    renderDeliveryCustomerVerdict();
    fields.contactName.focus();
}

// Add Customer from the delivery form: the card opens over it with the typed
// name filled in, and the new customer is picked once it is saved.
function addCustomerFromDelivery() {
    const typed = typedDeliveryName();
    openAddCustomer();
    addCustomerFor = 'delivery';
    prefillAddCustomerName(typed);
}

// The customer on the Payment card changed while a delivery is attached: the
// delivery goes to the same customer, with that customer's number and address
// (the date, the driver and the remarks stay). Not done while the delivery card
// is open: it is the one making the change.
function syncDeliveryToSaleCustomer(customerId) {
    if (!pendingDelivery || deliveryFormIsOpen) return;
    if (!customerId || pendingDelivery.customerId === Number(customerId)) return;

    const account = findCustomer(Number(customerId));
    if (!account) return;

    const saved = savedAddressParts(account);
    const phone = account.phone || '';

    // an address with a required part missing cannot stay attached: the delivery
    // is made again to finish it (an older customer has only the one line)
    const complete = phone !== '' && saved.barangay !== '' && saved.city !== '' && saved.province !== '';
    if (!complete) {
        pendingDelivery = null;
        renderDeliveryAttached();
        notifyWarning('The delivery was for another customer, and ' + account.name + ' has no complete ' +
            'number and address on record. Press Make a Delivery to fill it in.', 'Delivery removed');
        return;
    }

    pendingDelivery.customerId = account.id;
    pendingDelivery.contactName = account.name;
    pendingDelivery.contactPhone = phone;
    pendingDelivery.street = saved.street;
    pendingDelivery.barangay = saved.barangay;
    pendingDelivery.city = saved.city;
    pendingDelivery.province = saved.province;
    pendingDelivery.landmark = saved.landmark;
    pendingDelivery.address = fullDeliveryAddress(pendingDelivery);

    renderDeliveryAttached();
    notifyInfo('The delivery now goes to ' + account.name + '. Press Edit Delivery to check the address.',
        'Delivery moved');
}

// The whole address as one line, the way the server joins it: street, barangay,
// town or city, province, then the landmark in brackets.
function fullDeliveryAddress(d) {
    let barangay = d.barangay;
    if (!/^(brgy|barangay|poblacion|zone|purok|sitio)\b/i.test(barangay)) barangay = 'Brgy. ' + barangay;

    let line = barangay + ', ' + d.city + ', ' + d.province;
    if (d.street) line = d.street + ', ' + line;
    if (d.landmark) line += ' (Landmark: ' + d.landmark + ')';
    return line;
}

// The driver box: type to search the active drivers, pick one from the list.
// A delivery needs a driver, so the box cannot be left empty. The roster is
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
        driverRoster = [];   // offline: no one can be picked until the form is opened again
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

// The red words under each box of the delivery form, and the red edge on the box
const DELIVERY_ERROR_BOXES = {
    contactName: 'dl-name-error',
    contactPhone: 'dl-phone-error',
    street: 'dl-street-error',
    barangay: 'dl-barangay-error',
    city: 'dl-city-error',
    province: 'dl-province-error',
    landmark: 'dl-landmark-error',
    remarks: 'dl-remarks-error',
    scheduledDate: 'dl-scheduled-error'
};

function showDeliveryFieldError(name, text) {
    const fields = deliveryFormFields();
    const box = document.getElementById(DELIVERY_ERROR_BOXES[name]);
    if (box) {
        box.textContent = text;
        box.hidden = false;
    }
    if (fields && fields[name]) {
        fields[name].classList.add('is-bad');
        // the phone box sits in a frame that carries the red edge
        const frame = fields[name].closest('.phone-field');
        if (frame) frame.classList.add('is-bad');
    }
}

function clearDeliveryFieldError(name) {
    const fields = deliveryFormFields();
    const box = document.getElementById(DELIVERY_ERROR_BOXES[name]);
    if (box) {
        box.textContent = '';
        box.hidden = true;
    }
    if (fields && fields[name]) {
        fields[name].classList.remove('is-bad');
        const frame = fields[name].closest('.phone-field');
        if (frame) frame.classList.remove('is-bad');
    }
}

function clearDeliveryErrors() {
    for (const name in DELIVERY_ERROR_BOXES) clearDeliveryFieldError(name);

    const driverBox = document.getElementById('dl-driver-error');
    if (driverBox) { driverBox.textContent = ''; driverBox.hidden = true; }
    const driverInput = document.getElementById('dl-driver');
    if (driverInput) driverInput.classList.remove('is-bad');

    const verdict = document.getElementById('delivery-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

// typing in a box takes its own complaint away
function onDeliveryFieldTyped(event) {
    const target = event.target;
    if (target && target.name && DELIVERY_ERROR_BOXES[target.name]) clearDeliveryFieldError(target.name);

    // the line at the foot goes once the cashier starts putting things right
    const verdict = document.getElementById('delivery-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
    if (target && target.id === 'dl-driver') {
        const driverBox = document.getElementById('dl-driver-error');
        if (driverBox) { driverBox.textContent = ''; driverBox.hidden = true; }
        target.classList.remove('is-bad');
    }
}

async function openDeliveryForm() {
    const fields = deliveryFormFields();
    if (!fields) return;

    // the customer list is what the recipient box searches
    await loadCustomerDirectory(false);
    deliveryFormIsOpen = true;

    const note = document.getElementById('dl-saved-address');
    if (note) { note.textContent = ''; note.hidden = true; }

    if (pendingDelivery) {
        fields.contactName.value = pendingDelivery.contactName;
        fields.customerId.value = pendingDelivery.customerId ? String(pendingDelivery.customerId) : '';
        phoneFill(fields.contactPhone, pendingDelivery.contactPhone);
        fields.street.value = pendingDelivery.street;
        fields.barangay.value = pendingDelivery.barangay;
        fields.city.value = pendingDelivery.city;
        fields.province.value = pendingDelivery.province;
        fields.landmark.value = pendingDelivery.landmark;
        fields.scheduledDate.value = pendingDelivery.scheduledDate;
        fields.remarks.value = pendingDelivery.remarks;
    } else {
        fields.scheduledDate.value = '';
        fields.remarks.value = '';

        // the customer already chosen on the Payment card is the recipient; so is a name typed there
        const saleCustomer = selectedCustomerId() ? findCustomer(selectedCustomerId()) : null;
        if (saleCustomer) {
            fields.contactName.value = saleCustomer.name;
            fields.customerId.value = String(saleCustomer.id);
            fillDeliveryFromCustomer(saleCustomer);
        } else {
            fields.contactName.value = typedCustomerName();
            fields.customerId.value = '';
            fillDeliveryFromCustomer(null);
        }
    }
    hideCustomerSuggestions('delivery');
    const nameClear = document.getElementById('dl-customer-clear');
    if (nameClear) nameClear.hidden = fields.contactName.value === '';
    renderDeliveryCustomerVerdict();
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

    clearDeliveryErrors();

    // typing in any box clears that box's complaint (one listener, set once)
    const form = document.getElementById('make-delivery-form');
    if (form && !form.dataset.typingWired) {
        form.addEventListener('input', onDeliveryFieldTyped);
        form.dataset.typingWired = 'yes';
    }

    showModal('delivery-modal');
    setTimeout(function () { if (fields.contactName) fields.contactName.focus(); }, 60);
}

async function saveDeliveryForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = deliveryFormFields();
    if (!fields) return;

    clearDeliveryErrors();

    // many spaces become one, like the server does
    function tidy(box) { return box.value.trim().replace(/\s+/g, ' '); }

    const contactName = tidy(fields.contactName);
    const contactPhone = phoneToStore(fields.contactPhone);
    const phoneProblem = phoneComplaint(fields.contactPhone);
    const street = tidy(fields.street);
    const barangay = tidy(fields.barangay);
    const city = tidy(fields.city);
    const province = tidy(fields.province);
    const landmark = tidy(fields.landmark);
    const scheduledDate = fields.scheduledDate.value;

    // every box with a problem is marked at once; the first one gets the cursor
    let firstBad = null;
    function complain(name, text) {
        showDeliveryFieldError(name, text);
        if (!firstBad) firstBad = fields[name];
    }

    // the recipient is a customer on record, picked from the list (the hidden id is set only by a pick)
    const customerId = selectedDeliveryCustomerId();
    if (contactName === '') {
        complain('contactName', 'Pick the customer who receives the delivery.');
    } else if (!customerId) {
        complain('contactName', 'Pick the customer from the list, or press Add Customer if they are not on record.');
    }
    if (contactPhone === '') {
        complain('contactPhone', 'Enter a number the driver can call.');
    } else if (phoneProblem) {
        complain('contactPhone', phoneProblem);
    }
    // the barangay, town or city and province are needed; the house number and
    // street may be left out (not every house has them)
    if (street !== '' && street.length < 2) complain('street', 'The house number and street is too short; leave it empty if there is none.');
    if (barangay.length < 1) complain('barangay', 'Enter the barangay.');
    if (city.length < 2) complain('city', 'Enter the town or city.');
    if (province.length < 2) complain('province', 'Enter the province.');
    // the longest each may be is what the server accepts: a delivery refused there is
    // refused after the sale is saved, so it is stopped here
    if (street.length > 150) complain('street', 'The house number and street is at most 150 characters.');
    if (barangay.length > 100) complain('barangay', 'The barangay is at most 100 characters.');
    if (city.length > 100) complain('city', 'The town or city is at most 100 characters.');
    if (province.length > 100) complain('province', 'The province is at most 100 characters.');
    if (landmark.length > 150) complain('landmark', 'The landmark is at most 150 characters.');
    if (fields.remarks.value.trim().length > 255) complain('remarks', 'The remarks are at most 255 characters.');

    // a slot in the past is almost always a typing slip in the year or month
    if (scheduledDate && new Date(scheduledDate).getTime() < Date.now() - 60000) {
        complain('scheduledDate', 'That date has already passed. Check the date and time.');
    }

    // the driver is required, and has to be picked from the list: a name typed but never picked is not a driver
    const driverBox = document.getElementById('dl-driver');
    let driverId = null;
    if (fields.driverStaffId && fields.driverStaffId.value) driverId = Number(fields.driverStaffId.value);
    let driverName = null;
    if (driverId && driverBox) driverName = driverBox.value;
    if (!driverId && driverBox) {
        const driverError = document.getElementById('dl-driver-error');
        if (driverError) {
            driverError.textContent = 'Pick the driver who will deliver it.';
            if (driverBox.value.trim() !== '') driverError.textContent = 'Pick the driver from the list.';
            driverError.hidden = false;
        }
        driverBox.classList.add('is-bad');
        if (!firstBad) firstBad = driverBox;
    }

    if (firstBad) {
        firstBad.focus();
        const verdict = document.getElementById('delivery-verdict');
        if (verdict) {
            verdict.className = 'delivery-verdict is-stop';
            verdict.textContent = 'Fill in the boxes marked in red, then attach the delivery.';
        }
        return;
    }

    // the name is the customer's own, as it is on the record
    const account = findCustomer(customerId);
    pendingDelivery = {
        customerId: customerId,
        contactName: account ? account.name : contactName,
        contactPhone: contactPhone,
        street: street,
        barangay: barangay,
        city: city,
        province: province,
        landmark: landmark,
        // the whole address as one line, for the strip, the receipt and the old single address
        address: fullDeliveryAddress({ street: street, barangay: barangay, city: city, province: province, landmark: landmark }),
        scheduledDate: scheduledDate,
        remarks: fields.remarks.value.trim(),
        driverId: driverId,
        driverName: driverName,
        edited: true
    };

    deliveryFormIsOpen = false;
    closeModal('delivery-modal');

    // the sale is for the same customer as its delivery
    if (selectedCustomerId() !== customerId) await pickCustomer(customerId);
    renderCustomerVerdict();

    renderDeliveryAttached();
    notifyInfo('It will be created when you complete this sale.', 'Delivery attached');
}

// Cancel closes the form and leaves whatever was already attached alone;
// Remove Delivery is what removes it.
function cancelDeliveryForm() {
    deliveryFormIsOpen = false;
    closeModal('delivery-modal');
    clearDeliveryErrors();
}

function dropDeliveryForm() {
    pendingDelivery = null;
    deliveryFormIsOpen = false;
    closeModal('delivery-modal');
    renderDeliveryAttached();
    renderCustomerVerdict();
}

// the strip above the buttons
function renderDeliveryAttached() {
    const strip = document.getElementById('delivery-attached');
    const button = document.getElementById('make-delivery-btn');

    if (button) button.textContent = pendingDelivery ? 'Edit Delivery' : 'Make a Delivery';

    if (!strip) return;

    if (!pendingDelivery) { strip.hidden = true; strip.innerHTML = ''; return; }

    const d = pendingDelivery;

    let whenText = 'No date agreed yet';
    if (d.scheduledDate) whenText = 'Preferred date ' + escapeHtml(String(d.scheduledDate).replace('T', ' '));
    const driverText = 'Driver: ' + escapeHtml(d.driverName);

    let remarksLine = '';
    if (d.remarks) remarksLine = '<p class="delivery-attached-line">Remarks: ' + escapeHtml(d.remarks) + '</p>';

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
        '</p>' +
        remarksLine;
}

// posted once the sale exists; a failure here does not undo the sale
async function createAttachedDelivery(saleId) {
    if (!pendingDelivery) return true;

    const d = pendingDelivery;

    try {
        const response = await apiCreateDelivery({
                saleId: saleId,
                customerId: d.customerId,
                contactName: d.contactName,
                contactPhone: d.contactPhone,
                street: d.street,
                barangay: d.barangay,
                city: d.city,
                province: d.province,
                landmark: d.landmark || null,
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
        columns: 7,
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

        renderRow: function (row, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 8) * 28 + 'ms" ' +
                'onclick="openCashierDeliveryDetail(' + row.delivery_id + ')">' +
                '<td class="cell-id">#' + row.delivery_id + '</td>' +
                '<td class="cell-id">#' + row.sale_id + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.delivery_address) + '</td>' +
                '<td class="cell-id">' + escapeHtml(scheduleText(row.scheduled_date)) + '</td>' +
                // what the driver still has to collect; it falls as payments come in.
                // A sale on account is paid at the counter, so nothing is collected at the door.
                (row.payment_method === 'Credit'
                    ? '<td class="cell-num"><span class="muted">On account</span></td>'
                    : Number(row.balance_due) > 0
                        ? '<td class="cell-num cell-due">' + peso(row.balance_due) + '</td>'
                        : '<td class="cell-num"><span class="muted">Paid</span></td>') +
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

function clearDeliveryPanel() {
    const panel = getDataPanel('cash-deliveries');
    if (panel) panel.reset();

    const search = document.getElementById('cdel-search');
    if (search) search.value = '';

    const status = document.getElementById('cdel-status');
    if (status) status.value = 'all';
}

function openCashierDeliveryDetail(deliveryId) {
    const panel = getDataPanel('cash-deliveries');
    if (panel) showDeliveryRecord(panel.find(deliveryId));
}
// ---------- refunds ----------
// The reason is compulsory. Where the goods go is not the counter's call:
// the refund is filed awaiting inspection, and the inventory clerk decides
// whether it can be sold again.
async function handleIssueRefund(event) {
    event.preventDefault();
    const form = event.target;

    const reason = form.elements.reason.value.trim();

    // a sale of several items: every line with a quantity, in one report
    if (isRefundMulti()) {
        await issueRefundForLines(form, reason);
        return;
    }

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

    if (reason === '') {
        notifyWarning('Type the reason for the refund.', 'A reason is required');
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
        clearRefundSale();
        catalogLoaded = false;
        await loadRecentSales();
    } catch (error) {
        notifyOffline();
    }
}

// Issue Refund for a sale of several items: the lines with a quantity go in one
// report (POST /api/returns/batch); if the server refuses one, nothing is filed.
async function issueRefundForLines(form, reason) {
    const lines = refundTableLines();
    const items = [];
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.problem) {
            notifyWarning(l.line.name + ': ' + l.problem, 'Check the quantities');
            const box = document.getElementById('refund-line-qty-' + i);
            if (box) box.focus();
            return;
        }
        if (l.quantity > 0) {
            if (!(l.amount > 0)) {
                notifyWarning(l.line.name + ': that is too few to refund any money. Type a larger quantity, or 0.',
                    'Check the quantities');
                return;
            }
            items.push({ productId: l.line.productId, quantity: l.quantity, refundAmount: l.amount });
            total += l.amount;
        }
    }
    if (items.length === 0) {
        notifyWarning('Type how many of each item came back. Leave 0 for what did not.', 'Nothing to refund');
        const first = document.getElementById('refund-line-qty-0');
        if (first) first.focus();
        return;
    }
    if (reason === '') {
        notifyWarning('Type the reason for the refund.', 'A reason is required');
        const field = document.getElementById('return-reason');
        if (field) field.focus();
        return;
    }

    const saleId = refundSale.saleId;
    try {
        const response = await apiFileRefundBatch({
            reportType: 'Refunded', saleId: saleId, reason: reason, items: items
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error, 'Refund not issued'); return; }

        total = Math.round(total * 100) / 100;
        const offBalance = Number(result.offBalance) || 0;
        const cashBack = Math.round((total - offBalance) * 100) / 100;
        let balanceNote = '';
        if (offBalance > 0) balanceNote = ' ' + peso(offBalance) + ' came off what the customer owes on sale #' + saleId + '.';
        if (cashBack > 0) balanceNote += ' Hand back ' + peso(cashBack) + ' in cash.';
        notifySuccess(items.length + (items.length === 1 ? ' item' : ' items') + ' refunded on sale #' + saleId +
            '. The goods are set aside for the stockroom; the clerk has been asked to inspect them.' + balanceNote,
            'Refund issued');

        form.elements.reason.value = '';
        clearRefundSale();
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
            // everything refunded on the sale, the cash handed back as well as what came off the balance
            let refundedNote = '';
            if (Number(row.returned_total) > 0) {
                refundedNote = '<span class="cell-sub">refunded ' + peso(row.returned_total) + '</span>';
            }
            const picked = refundSale && refundSale.saleId === row.sale_id ? ' is-picked' : '';
            return '<tr class="row-clickable row-reveal' + picked + '" data-sale-id="' + row.sale_id + '" ' +
                'style="animation-delay:' + (index % 8) * 28 + 'ms" title="Refund from this sale" ' +
                'onclick="fillRefundFromSale(' + row.sale_id + ')">' +
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

// ---------- a sale picked from Sales in the Past 3 Days ----------
// Pressing a sale fills Issue a Refund in from it. A sale of one item fills
// the Product, Quantity, Refund amount and Sale ID boxes. A sale of several
// items puts them on the form as a table, like the clerk's Stock Adjustment for
// a purchase order: each line with how many came back (0 for none), and the
// refund for those pieces at what the customer paid for them.
//
// refundSale: { saleId, customerName, saleDate, method, lines: [...] } or null.
// Each line is one product (two lines of the same product on the receipt are
// added together, as the server counts them):
//   { productId, name, baseUnit, sold, left, paidPerUnit }
// counted in the product's own unit (what left the shelf), as a refund is.
let refundSale = null;

// money down to the centavo, never up: the server refuses a refund over what was paid
function floorCentavo(value) {
    return Math.floor(Number(value) * 100 + 1e-6) / 100;
}

function refundLinesFromSale(sale, items) {
    // the lines add up to total_amount; the customer paid final_amount, after the discount
    let afterDiscount = 1;
    if (Number(sale.total_amount) > 0) afterDiscount = Number(sale.final_amount) / Number(sale.total_amount);

    const lines = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let line = null;
        for (let k = 0; k < lines.length; k++) {
            if (lines[k].productId === it.product_id) line = lines[k];
        }
        if (!line) {
            line = { productId: it.product_id, name: it.product_name, baseUnit: it.base_unit || '',
                     sold: 0, worth: 0, refunded: Number(it.refunded_quantity) || 0 };
            lines.push(line);
        }
        line.sold += Number(it.base_quantity) || 0;
        line.worth += Number(it.subtotal) || 0;
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        line.left = Math.max(0, Math.round((line.sold - line.refunded) * 1000) / 1000);
        line.paidPerUnit = line.sold > 0 ? line.worth * afterDiscount / line.sold : 0;
    }
    return lines;
}

// the refund for this many pieces of the line, at what the customer paid
function refundLineAmount(line, quantity) {
    return floorCentavo(line.paidPerUnit * quantity);
}

// the line of the sale on the form for this product, or null
function refundSaleLine(productId) {
    if (!refundSale) return null;
    for (let i = 0; i < refundSale.lines.length; i++) {
        if (refundSale.lines[i].productId === productId) return refundSale.lines[i];
    }
    return null;
}

function isRefundMulti() {
    return Boolean(refundSale && refundSale.lines.length > 1);
}

async function fillRefundFromSale(saleId) {
    const form = document.getElementById('refund-form');
    if (!form) return;

    let data;
    try { data = await apiGetSale(saleId); }
    catch (error) {
        notifyWarning('The sale could not be read. Check the connection and try again.', 'Sale unavailable');
        return;
    }

    const s = data.sale;
    refundSale = {
        saleId: s.sale_id,
        customerName: s.customer_name,
        saleDate: String(s.sale_date).slice(0, 16),
        method: s.payment_method,
        lines: refundLinesFromSale(s, data.items || [])
    };
    form.elements.saleId.value = s.sale_id;

    if (refundSale.lines.length === 1) {
        // one item: the boxes are filled in, everything still left to refund
        const line = refundSale.lines[0];
        await ensureCatalogLoaded(false);
        if (findCatalogProduct(line.productId)) {
            form.elements.quantity.value = line.left > 0 ? String(line.left) : '1';
            form.elements.refundAmount.value = '0';
            refundAmountSuggested = null;
            pickRefundProduct(line.productId);
        } else {
            clearRefundProduct();
            notifyWarning(line.name + ' cannot be picked here, it may have been archived. ' +
                'Type the product by hand.', 'Product not filled in');
        }
    } else if (refundProduct) {
        clearRefundProduct();
    }

    renderRefundForm();
    markRefundSaleRow();

    const next = isRefundMulti() ? document.getElementById('refund-line-qty-0') : document.getElementById('return-reason');
    if (next) next.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// the sale on the form is shaded in the list beside it
function markRefundSaleRow() {
    const rows = document.querySelectorAll('#recent-sales-table tbody tr');
    for (let i = 0; i < rows.length; i++) {
        const id = Number(rows[i].getAttribute('data-sale-id'));
        rows[i].classList.toggle('is-picked', Boolean(refundSale) && id === refundSale.saleId);
    }
}

// Clear on the strip: the sale comes off the form, back to typing by hand
function clearRefundSale() {
    const form = document.getElementById('refund-form');
    refundSale = null;
    if (form) {
        form.elements.saleId.value = '';
        form.elements.quantity.value = '1';
        form.elements.refundAmount.value = '0';
    }
    refundAmountSuggested = null;
    clearRefundProduct();
    renderRefundForm();
    markRefundSaleRow();
}

// a Sale ID typed by hand is not the sale on the form any more
function onRefundSaleInput() {
    const form = document.getElementById('refund-form');
    if (!form || !refundSale) return;
    if (Number(form.elements.saleId.value) !== refundSale.saleId) {
        refundSale = null;
        renderRefundForm();
        markRefundSaleRow();
        suggestRefundAmount();
    }
}

// the strip, the table or the single boxes, and the preview, for what is on the form
function renderRefundForm() {
    const form = document.getElementById('refund-form');
    const multi = isRefundMulti();

    // the boxes for one item are off while the table is on the form, so the
    // browser does not ask for them
    const single = document.getElementById('refund-single');
    if (single) {
        single.hidden = multi;
        const boxes = single.querySelectorAll('input');
        for (let i = 0; i < boxes.length; i++) boxes[i].disabled = multi;
    }
    if (form && multi) form.elements.saleId.disabled = false;

    renderRefundSource();
    renderRefundLines();
    renderRefundPreview();
}

function renderRefundSource() {
    const box = document.getElementById('refund-source');
    if (!box) return;
    if (!refundSale) { box.hidden = true; box.innerHTML = ''; return; }

    const count = refundSale.lines.length;
    box.hidden = false;
    box.innerHTML =
        '<div class="adjust-source-text">' +
            '<span class="adjust-source-eyebrow">Sale</span>' +
            '<span class="adjust-source-title">#' + refundSale.saleId + ' · ' + escapeHtml(refundSale.customerName) + '</span>' +
            '<span class="adjust-source-sub">' + escapeHtml(refundSale.saleDate) + ' · ' + escapeHtml(refundSale.method) +
                ' · ' + count + (count === 1 ? ' item' : ' items') + '. The refund is at what the customer paid.</span>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-no-icon onclick="clearRefundSale()">Clear</button>';
}

function renderRefundLines() {
    const box = document.getElementById('refund-lines');
    if (!box) return;
    if (!isRefundMulti()) { box.hidden = true; box.innerHTML = ''; return; }

    let rows = '';
    for (let i = 0; i < refundSale.lines.length; i++) {
        const line = refundSale.lines[i];
        let sub = 'Bought ' + qtyText(line.sold, line.baseUnit);
        if (line.left < line.sold) sub += ' · ' + (line.left > 0 ? qtyText(line.left, line.baseUnit) + ' left to refund' : 'refunded in full');
        rows += '<tr>' +
            '<td class="cell-name">' + escapeHtml(line.name) +
                '<span class="cell-sub">' + escapeHtml(sub) + '</span>' +
                '<span class="adjust-line-note" id="refund-line-note-' + i + '"></span></td>' +
            '<td>' + escapeHtml(line.baseUnit) + '</td>' +
            '<td class="cell-num"><input type="number" class="form-control adjust-line-qty" ' +
                'id="refund-line-qty-' + i + '" min="0" max="' + line.left + '" step="any" value="0" ' +
                (line.left > 0 ? '' : 'disabled ') +
                'onfocus="this.select()" oninput="renderRefundPreview()" ' +
                'aria-label="How many came back: ' + escapeHtml(line.name) + '"></td>' +
            '</tr>';
    }

    const count = refundSale.lines.length;
    box.hidden = false;
    box.innerHTML =
        '<p class="adjust-lines-head">' + count + ' items</p>' +
        '<div class="adjust-lines-scroll">' +
            '<table class="mini-table adjust-lines-table">' +
                '<thead><tr><th>Product</th><th>Unit</th><th class="col-num">Quantity</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table>' +
        '</div>';
}

// what each line of a sale of several items will refund, read from the table
function refundTableLines() {
    const lines = [];
    if (!isRefundMulti()) return lines;
    for (let i = 0; i < refundSale.lines.length; i++) {
        const line = refundSale.lines[i];
        const box = document.getElementById('refund-line-qty-' + i);
        const text = box ? box.value.trim() : '0';
        const quantity = text === '' ? 0 : Number(text);
        let problem = '';
        if (!Number.isFinite(quantity) || quantity < 0) problem = 'Type 0 or more.';
        else if (quantity > line.left + 0.0005) problem = 'Only ' + qtyText(line.left, line.baseUnit) + ' can be refunded.';
        lines.push({ line: line, quantity: quantity, amount: problem ? 0 : refundLineAmount(line, quantity), problem: problem });
    }
    return lines;
}

function renderRefundPreview() {
    const box = document.getElementById('refund-preview');
    if (!box) return;
    box.className = 'adjust-preview';
    box.innerHTML = '';
    if (!isRefundMulti()) return;

    const lines = refundTableLines();
    let picked = 0;
    let total = 0;
    let bad = false;
    for (let i = 0; i < lines.length; i++) {
        const note = document.getElementById('refund-line-note-' + i);
        const l = lines[i];
        if (note) {
            if (l.problem) { note.className = 'adjust-line-note is-bad'; note.textContent = l.problem; }
            else if (l.quantity > 0) { note.className = 'adjust-line-note is-refund'; note.textContent = 'Refund ' + peso(l.amount); }
            else { note.className = 'adjust-line-note'; note.textContent = ''; }
        }
        if (l.problem) bad = true;
        else if (l.quantity > 0) { picked++; total += l.amount; }
    }

    if (bad) {
        box.className = 'adjust-preview is-stop';
        box.textContent = 'A quantity is more than can be refunded, or is not a number. Type 0 for what did not come back.';
        return;
    }
    box.className = 'adjust-preview is-good';
    box.innerHTML = '<span class="preview-name">Sale #' + refundSale.saleId + '</span>' +
        '<span class="preview-figures">' + picked + ' of ' + lines.length + ' items will be refunded' +
            (picked > 0 ? ': <strong>' + peso(Math.round(total * 100) / 100) + '</strong>' : '') + '</span>' +
        (picked === 0 ? '<span class="preview-note">Type how many of each item came back.</span>' : '');
}

// Cancel: the form is emptied, then back to the first screen
function cancelRefundForm(event) {
    const form = document.getElementById('refund-form');
    if (form) {
        form.elements.reason.value = '';
    }
    clearRefundSale();
    showCashierHome(event);
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
                'onclick="openReceipt(' + row.sale_id + ', true)">' +
                '<td class="cell-id">OR-' + String(row.sale_id).padStart(6, '0') + '</td>' +
                '<td class="cell-id">' + escapeHtml(String(row.sale_date).slice(0, 10)) + '</td>' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.payment_method) + '</td>' +
                '<td>' + statusBadge(row.payment_status) +
                    (row.void_request_id ? ' <span class="badge badge-danger">Void requested</span>' : '') + '</td>' +
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
    document.getElementById('payment-title').textContent = 'Credit Settlement';
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
    // two to a row; the seventh, Balance, runs the full width under the rest
    document.getElementById('payment-facts').innerHTML =
        detailField('Customer', escapeHtml(row.customer_name)) +
        detailField('Phone', row.phone ? escapeHtml(row.phone) : '<span class="muted">No phone on file</span>') +
        detailField('Sale Date', escapeHtml(String(row.sale_date).slice(0, 10))) +
        detailField('Due Date', debtDueCell(row)) +
        detailField('Amount Due', peso(row.final_amount) + penaltyNote) +
        detailField('Total Payment', peso(row.amount_paid)) +
        detailField('Balance', '<span class="cell-due">' + peso(balance) + '</span>');

    const fields = paymentFormFields();
    if (fields) {
        // starts at nothing: the cashier types what was handed over, or uses a quick fill
        fields.amount.value = '0';
        fields.amount.max = balance.toFixed(2);
        fields.paymentMethod.value = 'Cash';
        clearPaymentDetails('pay-debt');
    }

    const button = document.getElementById('payment-save-btn');
    if (button) { button.disabled = false; button.textContent = 'Confirm Payment'; }
    const qrButton = document.getElementById('payment-qr-btn');
    if (qrButton) qrButton.disabled = false;

    renderPaymentVerdict();
    showModal('payment-modal');
    setTimeout(function () { if (fields && fields.amount) { fields.amount.focus(); fields.amount.select(); } }, 60);
}

// Cancelled, the form goes back to where it was opened from: the customer's card
// (read afresh), or the Credit Payment list when it was opened straight from there.
// Paid, nothing opens behind it: the receipt is shown on its own.
function closePaymentForm(cancelled) {
    paymentSale = null;
    closeModal('payment-modal');

    const customerId = paymentReturnCustomer;
    const toPicker = paymentReturnPicker;
    paymentReturnCustomer = null;
    paymentReturnPicker = false;
    if (!cancelled) return;
    if (toPicker) openCreditPaymentPicker();
    else if (customerId) openCustomerCredit(customerId, 'unpaid');
}

function fillPayment(share) {
    const fields = paymentFormFields();
    if (!fields || !paymentSale) return;
    const balance = Number(paymentSale.balance_due) || 0;
    fields.amount.value = (Math.round(balance * share * 100) / 100).toFixed(2);
    renderPaymentVerdict();
}

// what the balance becomes if this is recorded, said before the button
function renderPaymentVerdict() {
    const box = document.getElementById('payment-verdict');
    const fields = paymentFormFields();
    if (!box || !fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = parseFloat(fields.amount.value) || 0;

    // the cheque's details, or the customer's bank and account for a transfer
    showPaymentDetails('pay-debt', fields.paymentMethod.value);

    // GCash, PayMaya and a bank transfer are only taken through PayMongo (the QR
    // code), so Confirm Payment is not offered for them.
    const isTransfer = fields.paymentMethod.value === 'Bank Transfer';
    const qrButton = document.getElementById('payment-qr-btn');
    if (qrButton) {
        qrButton.hidden = QR_METHODS.indexOf(fields.paymentMethod.value) === -1;
        qrButton.textContent = isTransfer ? 'Pay by Bank Transfer' : 'Pay by QR';
    }
    const saveButton = document.getElementById('payment-save-btn');
    if (saveButton) saveButton.hidden = QR_METHODS.indexOf(fields.paymentMethod.value) !== -1;
    qrAmountChanged('credit_payment', amount);

    if (amount <= 0) {
        box.className = 'credit-verdict';
        box.textContent = '';
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
    // no reference is asked for: a cheque is traced by its account, bank and date,
    // an e-wallet or transfer by its QR payment
    const reference = '';

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

    // a bank transfer is only taken through PayMongo, whichever way the form was sent (Enter too)
    // GCash, PayMaya and a bank transfer are only taken through PayMongo, whichever
    // way the form was sent (Enter too)
    if (QR_METHODS.indexOf(method) !== -1) viaQr = true;

    // A cheque is taken with its account name, account number, bank, branch and
    // date; a bank transfer with the customer's bank and account.
    let chequeDetails = null;
    let transferDetails = null;
    if (method === 'Cheque') {
        const read = readChequeDetails('pay-debt');
        if (read.problem) {
            notifyWarning(read.problem, 'Cheque details needed');
            focusBox(read.field);
            return;
        }
        chequeDetails = read.details;
    } else if (method === 'Bank Transfer') {
        const read = readTransferDetails('pay-debt');
        if (read.problem) {
            notifyWarning(read.problem, 'Bank details needed');
            focusBox(read.field);
            return;
        }
        transferDetails = read.details;

        // PayMongo refuses a transfer below the bank's smallest
        const bank = paymongoBank(transferDetails.bankCode);
        if (bank && amount < bank.minimum) {
            notifyWarning(bank.name + ' takes transfers of ' + peso(bank.minimum) + ' or more. This one is ' +
                peso(amount) + '.', 'Too small for ' + bank.name);
            focusBox('pay-debt-transfer-bank');
            return;
        }
    }

    const button = document.getElementById('payment-save-btn');
    const qrButton = document.getElementById('payment-qr-btn');
    function ready() {
        if (button) { button.disabled = false; button.textContent = 'Confirm Payment'; }
        if (qrButton) qrButton.disabled = false;
    }

    if (viaQr && QR_METHODS.indexOf(method) === -1) return;

    // Asked for every method, before a QR code is made or anything is sent. The
    // buttons are held while the question is open, so it cannot be asked twice.
    if (button) button.disabled = true;
    if (qrButton) qrButton.disabled = true;

    const saleNumber = 'OR-' + String(paymentSale.sale_id).padStart(6, '0');
    const details = [
        'Customer: ' + paymentSale.customer_name,
        'Sale: ' + saleNumber,
        'Amount: ' + peso(amount),
        'Method: ' + method
    ];
    if (!viaQr && reference !== '') details.push('Reference: ' + reference);
    if (chequeDetails) {
        details.push('Cheque: ' + chequeDetails.bank + ' \u00b7 dated ' + chequeDetails.chequeDate);
        details.push('Account: ' + chequeDetails.accountName + ', ' + chequeDetails.accountNumber);
    }
    if (transferDetails) {
        details.push('Customer\'s bank: ' + transferDetails.bank);
        details.push('Account name: ' + transferDetails.accountName);
        details.push('Account number: ' + transferDetails.accountNumber);
    }

    let question = 'The payment is recorded against this sale, and the balance goes down by this amount.';
    if (transferDetails) {
        question = 'A QR code and a link to the bank\'s page are made next. Nothing is recorded until the ' +
            'customer has approved the transfer in their bank.';
    } else if (viaQr) {
        question = 'A QR code is made next. Nothing is recorded until the customer has paid it.';
    }
    const yes = await askConfirm(question, {
        title: 'Record this payment?',
        eyebrow: 'Credit Settlement',
        confirmLabel: viaQr ? 'Make the QR code' : 'Record the payment',
        detail: details
    });
    if (!yes) { ready(); return; }

    // by QR code: the customer pays the code before anything is recorded
    let qr = null;
    if (viaQr) {
        qr = await collectQrPayment(amount, 'Payment on OR-' + String(paymentSale.sale_id).padStart(6, '0'), method,
            'credit_payment', paymentSale.sale_id, transferDetails);
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
            qrPaymentId: qr ? qr.id : null,
            paymentDetails: chequeDetails || transferDetails
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

        // The receipt is what the server recorded; when it did not send it, what
        // this card knew is enough to print one.
        let receiptInfo = result.receipt;
        if (!receiptInfo) {
            receiptInfo = {
                customerName: paymentSale.customer_name,
                method: method,
                reference: referenceNo,
                amount: amount,
                balanceBefore: balance,
                balanceAfter: Math.max(balance - amount, 0)
            };
        }
        receiptInfo.saleId = paymentSale.sale_id;

        clearPaymentDetails('pay-debt');
        closePaymentForm();
        await showPaymentReceipt(receiptInfo);

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
// true when the form was opened straight from the Credit Payment list: Cancel goes back there
let paymentReturnPicker = false;

// the administrator can switch payments off for the cashiers (debt-payments)
function canTakePayments() {
    return typeof holdsFeature !== 'function' || holdsFeature('debt-payments');
}

// Pay on one row: the card steps aside for the payment form (the two are
// not stacked) and comes back when it closes.
function payCustomerSale(saleId) {
    if (!openCustomer) return;
    paymentReturnCustomer = openCustomerId;
    paymentReturnPicker = false;
    closeModal('customer-modal');
    openPaymentForm(saleId);
}

// Credit Settlement in the card's foot opens the payment form on the oldest
// sale still owing (the top row of Unpaid Sales); pressing a row there pays
// that sale instead.
function payFromCustomerCard() {
    if (!openCustomer) return;
    if (customerOpenSales.length > 0) {
        payCustomerSale(customerOpenSales[0].sale_id);
    } else {
        showCustomerTab('unpaid');
    }
}

function renderCustomerUnpaid() {
    const box = document.getElementById('customer-unpaid');
    if (!box) return;

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

    box.innerHTML = pagedTable('cash-unpaid', ['Receipt', 'Sold', 'Balance', 'Due'],
        unpaidRows, [2], {
            empty: 'Nothing is owed on any sale.',
            // the row itself opens the payment form for that sale
            rowAttrs: function (index) {
                return 'class="row-clickable" title="Credit Settlement on this sale" ' +
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
        columns: 3,
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
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) + '</td>' +
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

        // the Unpaid Sales tab and Credit Settlement, only when there is something to pay
        const hasUnpaid = payable && customerOpenSales.length > 0;
        const unpaidTab = document.getElementById('customer-tab-unpaid');
        if (unpaidTab) unpaidTab.hidden = !hasUnpaid;
        const pay = document.getElementById('customer-pay-btn');
        if (pay) pay.hidden = !hasUnpaid;

        // the two prints, each switched on its own (Access Control)
        document.getElementById('customer-print-card').hidden = !holdsFeature('customer-card-print');
        // Print Terms and Conditions is not offered on the customer's card

        let open = 'account';
        if (tab === 'unpaid' && hasUnpaid) open = 'unpaid';
        else if (tab === 'history' || tab === 'payments') open = tab;
        showCustomerTab(open);
        showModal('customer-modal');
    } catch (error) {
        notifyError('That customer could not be opened.', 'Nothing to show');
    }
}

// Print Customer Card (the card alone) or Print Credit Terms (the terms page
// alone) for the customer whose card is open
function printOpenCustomer(kind) {
    if (!openCustomerId) return;
    if (kind === 'card') {
        printCustomerCard(openCustomerId);
    } else {
        printCreditTerms(openCustomerId);
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
// Purchase History and Credit Payments are a tab each, paged with Previous
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
        // the sale (receipt) the payment was put against
        let receiptCell = '<span class="muted">-</span>';
        if (p.sale_id) receiptCell = '#' + p.sale_id;
        paymentRows.push([
            escapeHtml(dayOfStamp(p.payment_date)),
            peso(p.amount),
            escapeHtml(p.payment_method),
            receiptCell
        ]);
    }

    box.innerHTML = pagedTable('cash-payments', ['Date', 'Amount', 'Method', 'Receipt'],
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

// an earlier complaint goes once the form is being fixed
function renderLimitVerdict() {
    const verdict = document.getElementById('limit-verdict');
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
    if (reason === '') {
        complain('Type the reason for the higher limit.', form.elements.reason);
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
// typed name). First name, last name, phone number, barangay, town or city
// and province are required; the middle name, the house number and street,
// and the landmark are optional. The server refuses a name already on the
// list, any case, and gives the account a credit limit of zero.
let addCustomerFor = '';   // 'sale': opened from the payment form, the new account goes on the sale; 'delivery': from the delivery form

// the boxes that have a red line of words under them
const ADD_CUSTOMER_ERROR_BOXES = {
    firstName: 'ac-first-error',
    lastName: 'ac-last-error',
    phone: 'ac-phone-error',
    street: 'ac-street-error',
    barangay: 'ac-barangay-error',
    city: 'ac-city-error',
    province: 'ac-province-error'
};

function showAddCustomerFieldError(name, text) {
    const form = document.getElementById('add-customer-form');
    const box = document.getElementById(ADD_CUSTOMER_ERROR_BOXES[name]);
    if (box) {
        box.textContent = text;
        box.hidden = false;
    }
    if (form && form.elements[name]) {
        form.elements[name].classList.add('is-bad');
        // the phone box sits in a frame that carries the red edge
        const frame = form.elements[name].closest('.phone-field');
        if (frame) frame.classList.add('is-bad');
    }
}

function clearAddCustomerFieldError(name) {
    const form = document.getElementById('add-customer-form');
    const box = document.getElementById(ADD_CUSTOMER_ERROR_BOXES[name]);
    if (box) {
        box.textContent = '';
        box.hidden = true;
    }
    if (form && form.elements[name]) {
        form.elements[name].classList.remove('is-bad');
        const frame = form.elements[name].closest('.phone-field');
        if (frame) frame.classList.remove('is-bad');
    }
}

function clearAddCustomerErrors() {
    for (const name in ADD_CUSTOMER_ERROR_BOXES) clearAddCustomerFieldError(name);

    const verdict = document.getElementById('add-customer-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

// typing in a box takes its own complaint away
function onAddCustomerTyped(event) {
    const target = event.target;
    if (target && target.name && ADD_CUSTOMER_ERROR_BOXES[target.name]) clearAddCustomerFieldError(target.name);

    const verdict = document.getElementById('add-customer-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

// a name typed on another card: the first word is the first name, the rest the last name
function prefillAddCustomerName(typed) {
    const form = document.getElementById('add-customer-form');
    if (!form) return;

    const words = String(typed || '').trim().split(/\s+/);
    if (words[0] === '') return;
    form.elements.firstName.value = words.shift();
    form.elements.lastName.value = words.join(' ');
}

// the same card adds a customer or edits one (editCustomerId set)
let editCustomerId = null;

function setAddCustomerMode(editing, name) {
    const title = document.getElementById('add-customer-title');
    const sub = document.getElementById('add-customer-sub');
    const avatar = document.getElementById('add-customer-avatar');
    const save = document.getElementById('add-customer-save');
    if (title) title.textContent = editing ? 'Edit Customer' : 'Add Customer';
    if (sub) sub.textContent = editing ? name : 'Opens an account at the counter';
    if (avatar) avatar.textContent = editing ? initialsOf(name) : '+';
    if (save) save.textContent = editing ? 'Save Changes' : 'Add Customer';
}

function openAddCustomer() {
    addCustomerFor = '';
    editCustomerId = null;
    setAddCustomerMode(false);

    const form = document.getElementById('add-customer-form');
    if (!form) return;

    form.reset();
    phoneFill(form.elements.phone, '');
    clearAddCustomerErrors();

    // typing in any box clears that box's complaint (one listener, set once)
    if (!form.dataset.typingWired) {
        form.addEventListener('input', onAddCustomerTyped);
        form.dataset.typingWired = 'yes';
    }

    const save = document.getElementById('add-customer-save');
    if (save) save.disabled = false;

    showModal('add-customer-modal');
    setTimeout(function () { form.elements.firstName.focus(); }, 60);
}

function cancelAddCustomer() {
    addCustomerFor = '';
    editCustomerId = null;
    closeModal('add-customer-modal');
}

// Edit Customer, from the customer's card: the same form, filled with what is
// on record (the name, phone and address parts are read from the records list)
async function editOpenCustomer() {
    if (!openCustomerId) return;
    let row = null;
    try {
        const rows = await apiGetRecords('customer');
        for (let i = 0; i < rows.length; i++) {
            if (Number(rows[i].id) === Number(openCustomerId)) { row = rows[i]; break; }
        }
    } catch (error) {
        notifyOffline();
        return;
    }
    if (!row) { notifyError('That customer could not be read.', 'Nothing to edit'); return; }

    openAddCustomer();
    editCustomerId = Number(openCustomerId);
    setAddCustomerMode(true, row.name);

    const form = document.getElementById('add-customer-form');
    form.elements.firstName.value = row.first_name || '';
    form.elements.middleName.value = row.middle_name || '';
    form.elements.lastName.value = row.last_name || '';
    phoneFill(form.elements.phone, row.phone || '');
    form.elements.street.value = row.address_street || '';
    form.elements.barangay.value = row.address_barangay || '';
    form.elements.city.value = row.address_city || '';
    form.elements.province.value = row.address_province || '';
    form.elements.landmark.value = row.address_landmark || '';
}

async function handleAddCustomer(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const form = document.getElementById('add-customer-form');
    const verdict = document.getElementById('add-customer-verdict');
    if (!form) return;

    clearAddCustomerErrors();

    // many spaces become one, like the server does
    function tidy(box) { return box.value.trim().replace(/\s+/g, ' '); }

    const firstName = tidy(form.elements.firstName);
    const middleName = tidy(form.elements.middleName);
    const lastName = tidy(form.elements.lastName);
    const phone = phoneToStore(form.elements.phone);
    const phoneProblem = phoneComplaint(form.elements.phone);
    const street = tidy(form.elements.street);
    const barangay = tidy(form.elements.barangay);
    const city = tidy(form.elements.city);
    const province = tidy(form.elements.province);
    const landmark = tidy(form.elements.landmark);

    // every box with a problem is marked at once; the first one gets the cursor
    let firstBad = null;
    function complain(name, text) {
        showAddCustomerFieldError(name, text);
        if (!firstBad) firstBad = form.elements[name];
    }

    if (firstName === '') complain('firstName', 'Enter the first name.');
    if (lastName === '') complain('lastName', 'Enter the last name.');
    if (phone === '') {
        complain('phone', 'Enter a phone number.');
    } else if (phoneProblem) {
        complain('phone', phoneProblem);
    }
    // the barangay, town or city and province are needed; the house number and
    // street may be left out (not every house has them)
    if (street !== '' && street.length < 2) complain('street', 'The house number and street is too short; leave it empty if there is none.');
    if (barangay.length < 1) complain('barangay', 'Enter the barangay.');
    if (city.length < 2) complain('city', 'Enter the town or city.');
    if (province.length < 2) complain('province', 'Enter the province.');

    if (firstBad) {
        firstBad.focus();
        if (verdict) {
            verdict.className = 'delivery-verdict is-stop';
            verdict.textContent = editCustomerId
                ? 'Fill in the boxes marked in red, then save the changes.'
                : 'Fill in the boxes marked in red, then add the customer.';
        }
        return;
    }

    const save = document.getElementById('add-customer-save');
    if (save) save.disabled = true;

    // editing a customer already on record
    if (editCustomerId) {
        const customerId = editCustomerId;
        try {
            const response = await apiEditCustomer(customerId, {
                firstName: firstName, middleName: middleName, lastName: lastName, phone: phone,
                street: street, barangay: barangay, city: city, province: province, landmark: landmark });
            const result = await response.json();
            if (!response.ok) {
                if (save) save.disabled = false;
                if (!handleAuthFailure(response, result) && verdict) {
                    verdict.className = 'delivery-verdict is-stop';
                    verdict.textContent = result.error || 'The changes were not saved.';
                }
                return;
            }
            editCustomerId = null;
            closeModal('add-customer-modal');
            notifySuccess(result.message, 'Customer saved');
            customerDirectoryLoaded = false;
            const panel = getDataPanel('cash-credit');
            if (panel && panel.state === 'ready') await panel.refresh();
            await openCustomerCredit(customerId);
        } catch (error) {
            if (save) save.disabled = false;
            notifyOffline();
        }
        return;
    }

    try {
        const response = await apiCreateCustomer({
                firstName: firstName, middleName: middleName, lastName: lastName, phone: phone,
                street: street, barangay: barangay, city: city, province: province, landmark: landmark });
        const result = await response.json();

        if (!response.ok) {
            if (save) save.disabled = false;
            if (!handleAuthFailure(response, result)) {
                if (verdict) { verdict.className = 'delivery-verdict is-stop'; verdict.textContent = result.error || 'The customer was not added.'; }
                form.elements.firstName.focus();
            }
            return;
        }

        closeModal('add-customer-modal');
        notifySuccess(result.message, 'Customer added');

        // the register's customer box reads the customer list afresh, and the list shows the new account
        customerDirectoryLoaded = false;

        // opened from the payment form: the new account is the sale's customer
        const openedFor = addCustomerFor;
        addCustomerFor = '';
        if (openedFor === 'sale') {
            await loadCustomerDirectory(true);
            await pickCustomer(Number(result.customerId));
        } else if (openedFor === 'delivery') {
            // opened from the delivery form: the new account is its recipient (and the sale's customer)
            await loadCustomerDirectory(true);
            await pickDeliveryCustomer(Number(result.customerId));
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

    if (isModalOpen('customer-modal') && customerOpenSales.length === 1) {
        payFromCustomerCard();
        paymentReturnPicker = true;
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
            'Late Penalty':   creditAlert,
            // a manager approved or declined a request to void a sale
            'Void Request':   { label: 'Sales Report', panelId: 'panel-salesreport',
                                open: function () { showSalesReport(); }, key: 'cash-sales' }
        });

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
