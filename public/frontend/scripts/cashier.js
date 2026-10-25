let catalog = [];
let catalogLoaded = false;
let catalogMode = 'idle';
let cart = [];
let lastReceipt = null;

let customerDirectory = [];
let customerDirectoryLoaded = false;
let suggestHighlight = -1;

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

function showRegister(event) {
    showCashierPanel('panel-pos', 'Point of Sale', event);

    renderCart();
}

function showCashierHome(event) {
    showRegister(event);
}

function showCashierDeliveries(event) {
    showCashierPanel('panel-delivery', 'Delivery Tracking', event);
}

function showRefunds(event) {
    showCashierPanel('panel-refund', 'Refunds', event);
    loadCatalogOptions();
    loadRecentSales();
}

function showCustomers(event) { showCashierPanel('panel-customers', 'Customers Record', event); }

function showSalesReport(event) {
    showCashierPanel('panel-salesreport', 'Sales Report', event);
}

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

const catalogFilters = { category: 'all' };

function setCatalogFilter(name, value) {
    catalogFilters[name] = value;
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
    noPrice: 'No price yet. Ask the manager to set it; it cannot be sold until then.'
};

function findCartLine(productId) {
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].product_id === productId) return cart[i];
    }
    return undefined;
}

function findCatalogProduct(productId) {
    for (let i = 0; i < catalog.length; i++) {
        if (catalog[i].product_id === productId) return catalog[i];
    }
    return undefined;
}

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

function isCatalogAvailable(p) { return Number(p.quantity_in_stock) > 0; }

function catalogMatchesFilters(p) {
    if (!isCatalogAvailable(p)) return false;
    if (catalogFilters.category !== 'all' && String(p.category_name || 'Uncategorised') !== catalogFilters.category) return false;
    return true;
}

function fillCatalogCategories() {
    const select = document.getElementById('catalog-category');
    if (!select) return;

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

    setPill('catalog-count', rows.length + (rows.length === 1 ? ' product' : ' products'));
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
        fillerRows(CATALOG_PAGE_ROWS - slice.length, 5) +
        '</tbody></table>' + pager;

    holdTableHeight(document.getElementById('catalog-table'));
    holdBoxHeight(grid);
}

const CATALOG_HEADERS = ['Product', 'Category', 'Brand', 'Sold By', 'Price'];
const CATALOG_SORT_KEYS = [
    function (p) { return p.product_name || ''; },
    function (p) { return p.category_name || 'Uncategorised'; },
    function (p) { return p.brand_name || ''; },
    function (p) { return p.unit_name || ''; },
    function (p) { return isUnpriced(p) ? '' : Number(p.price); }
];
let catalogSort = null;

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

function sortCatalog(column) {
    if (catalogSort && catalogSort.column === column) catalogSort.descending = !catalogSort.descending;
    else catalogSort = { column: column, descending: false };
    catalogPage = 1;
    renderCatalog(catalogShown);
}

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

let refundProduct = null;
let refundSuggestHighlight = -1;

let refundAmountSuggested = null;

function refundProductBox() { return document.getElementById('refund-product'); }

function refundProductIdBox() {
    const form = document.getElementById('refund-form');
    return form ? form.elements.productId : null;
}

async function loadCatalogOptions() {
    if (!document.getElementById('refund-product')) return;
    await ensureCatalogLoaded(false);
}

async function onRefundProductInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('refund-product-clear');

    if (clear) clear.hidden = text === '';

    if (!catalogLoaded && text !== '') await ensureCatalogLoaded(false);

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

function setRefundProduct(product) {
    refundProduct = product || null;

    const idBox = refundProductIdBox();
    if (idBox) idBox.value = product ? String(product.product_id) : '';

    renderRefundProductStrip();
    renderRefundProductVerdict();
    suggestRefundAmount();
}

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

    if (typed !== refundAmountSuggested) refundAmountSuggested = null;
    suggestRefundAmount();
}

async function loadCustomerDirectory(force) {
    if (customerDirectoryLoaded && !force) return true;

    try {
        customerDirectory = await apiGetRecords('customer');
        customerDirectoryLoaded = true;
        return true;
    } catch (error) {
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

function typedCustomerName() {
    const box = customerNameBox();
    return box ? box.value.trim().replace(/\s+/g, ' ') : '';
}

function customerShortName(c) {
    return (String(c.first_name || '') + ' ' + String(c.last_name || '')).trim();
}

function customerSpelledName(c) {
    return (String(c.first_name || '') + ' ' + String(c.middle_name || '') + ' ' + String(c.last_name || '')).replace(/\s+/g, ' ').trim();
}

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

function findCustomer(customerId) {
    for (let i = 0; i < customerDirectory.length; i++) {
        if (customerDirectory[i].id === customerId) return customerDirectory[i];
    }
    return undefined;
}

async function pickCustomer(customerId) {
    let found = findCustomer(customerId);
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

function renderCustomerVerdict() {
    const box = document.getElementById('customer-verdict');
    if (!box) return;

    const typed = typedCustomerName();
    const id = selectedCustomerId();

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

    box.className = 'customer-verdict is-stop';
    if (offerAdd) {
        box.textContent = 'Not a customer on record. Press Add Customer to open their account, ' +
            'or clear the box for a walk-in.';
    } else {
        box.textContent = 'Not a customer on record. Add them under Customers Record first, then pick them here, ' +
            'or clear the box for a walk-in.';
    }
}

function canAddCustomers() {
    return typeof holdsFeature !== 'function' || holdsFeature('credit');
}

function addCustomerFromPayment() {
    openAddCustomer();
    addCustomerFor = 'sale';
    prefillAddCustomerName(typedCustomerName());
}

async function loadCustomerOptions() {
    await loadCustomerDirectory(false);
}

function sellingUnitsOf(product) {
    const list = Array.isArray(product.selling_units) ? product.selling_units : [];
    const usable = [];
    for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u && u.unit_name && Number(u.units_per) > 0) usable.push(u);
    }
    return usable;
}

function unitShort(unit) {
    const measure = measuredUnit(unit);
    return measure ? measure.short : String(unit || '').trim();
}

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

function lineUnitPrice(line) { return lineChoice(line).price; }

function lineBaseQty(line) {
    return Number((line.quantity * lineChoice(line).units_per).toFixed(3));
}

function lineSubtotal(line) {
    return Math.round(line.quantity * lineUnitPrice(line) * 100) / 100;
}

function lineCeiling(line) {
    const choice = lineChoice(line);
    const most = line.on_hand / choice.units_per;
    if (choice.own && isMeasuredUnit(line.base_unit)) return Math.floor(most * 1000) / 1000;
    return Math.floor(most);
}

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

function onCartQtyInput(productId, value) {
    const line = findCartLine(productId);
    if (!line) return;

    const amount = Number(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(amount) || amount <= 0) return;

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

function changeCartUnit(productId, unitName) {
    const line = findCartLine(productId);
    if (!line) return;

    line.unit = unitName;
    const most = lineCeiling(line);
    if (most <= 0) {
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

    pendingDelivery = null;
    renderDeliveryAttached();
    await clearCustomer();
    renderCart();
}

function loyaltyDiscountFor(gross, rate) {
    const centavos = Math.round(gross * 100);
    const hundredths = Math.round(Number(rate) * 100);
    return Math.floor((centavos * hundredths + 500000) / 1000000);
}

function loyaltyDiscountLabel() {
    if (!selectedCustomerLoyalty) return 'Loyalty Discount';
    return 'Loyalty Discount (' + loyaltyRateText(selectedCustomerLoyalty.rate) + ')';
}

function cartTotals() {
    const form = document.getElementById('checkout-form');
    let gross = 0;
    for (let i = 0; i < cart.length; i++) {
        gross = gross + lineSubtotal(cart[i]);
    }
    let tendered = 0;
    let method = 'Cash';
    if (form) {
        tendered = parseFloat(form.elements.amountPaid.value) || 0;
        method = form.elements.paymentMethod.value;
    }

    let discount = 0;
    if (selectedCustomerLoyalty && selectedCustomerLoyalty.qualifies && method !== 'Credit' && method !== 'COD') {
        discount = loyaltyDiscountFor(gross, selectedCustomerLoyalty.rate);
    }
    const due = Math.max(gross - discount, 0);

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    let rawDown;
    if (form && form.elements.downPayment) {
        rawDown = parseFloat(form.elements.downPayment.value) || 0;
    } else {
        rawDown = 0;
    }

    let down = 0;
    if (onCredit) {
        down = Math.max(0, Math.min(rawDown, due));
    }

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

function markCatalogRows() {
    const catalogRows = document.querySelectorAll('#catalog-table tr[data-product-row]');
    for (let i = 0; i < catalogRows.length; i++) {
        const row = catalogRows[i];
        if (row.classList.contains('is-unpriced')) continue;
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

function renderCartFigures() {
    for (let i = 0; i < cart.length; i++) {
        const l = cart[i];
        const sub = document.querySelector('[data-line-sub="' + l.product_id + '"]');
        if (sub) sub.textContent = peso(lineSubtotal(l));
        const row = document.querySelector('.cart-line[data-line="' + l.product_id + '"] .cart-unit');
        if (row) row.innerHTML = cartLineNote(l);
    }

    const t = cartTotals();

    const totals = document.getElementById('cart-totals');
    if (totals) {
        let html = '<div class="total-row"><span>Subtotal</span><span>' + peso(t.gross) + '</span></div>';
        if (t.discount > 0) {
            html += '<div class="total-row"><span>' + loyaltyDiscountLabel() + '</span><span>' + peso(t.discount) + '</span></div>';
        }
        html += '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>';
        totals.innerHTML = html;
    }

    const payTotals = document.getElementById('pay-totals');
    if (payTotals) {
        let html = '';
        if (t.discount > 0) {
            html += '<div class="total-row"><span>Subtotal</span><span>' + peso(t.gross) + '</span></div>';
            html += '<div class="total-row"><span>' + loyaltyDiscountLabel() + '</span><span>' + peso(t.discount) + '</span></div>';
        }
        html += '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>';

        if (t.onCredit) {
            html += '<div class="total-row"><span>Paid now</span><span>' + peso(t.down) + '</span></div>';
            if (t.amountOnAccount > 0) {
                html += '<div class="total-row total-short"><span>On account</span><span>' + peso(t.amountOnAccount) + '</span></div>';
            } else {
                html += '<div class="total-row total-change"><span>Paid in full</span><span>' + peso(t.amountOnAccount) + '</span></div>';
            }
        } else if (t.onAccount) {
            html += '<div class="total-row total-note"><span>Collected on delivery</span><span>' +
                    peso(t.due) + '</span></div>';
        } else if (t.method === 'Bank Transfer') {
            html += '<div class="total-row total-note"><span>Paid by bank transfer</span><span>' +
                    peso(t.due) + '</span></div>';
        } else if (t.tendered < t.due) {
            html += '<div class="total-row total-short"><span>Short by</span><span>' +
                    peso(t.due - t.tendered) + '</span></div>';
        } else {
            html += '<div class="total-row total-change"><span>Change</span><span>' +
                    peso(t.change) + '</span></div>';
        }

        payTotals.innerHTML = html;
    }

    const proceed = document.getElementById('proceed-btn');
    if (proceed) proceed.disabled = cart.length === 0;

    renderCreditVerdict(t);
    renderLoyaltyNote(t);
    renderSalePaymentExtras(t);

    const taken = methodTakenNow(t);
    const button = document.getElementById('checkout-btn');
    if (button) {
        button.disabled = cart.length === 0 || (!t.onAccount && t.tendered < t.due);
        button.hidden = QR_METHODS.indexOf(taken) !== -1;
        button.textContent = checkoutLabel(t);
    }

    const qrButton = document.getElementById('qr-pay-btn');
    if (qrButton) {
        qrButton.hidden = QR_METHODS.indexOf(taken) === -1;
        const short = !t.onAccount && t.method !== 'Bank Transfer' && t.tendered < t.due;
        qrButton.disabled = cart.length === 0 || short;
        qrButton.textContent = 'Pay by QR';
    }

    qrAmountChanged('sale', t.onCredit ? t.down : t.due);
}

function checkoutLabel(t) {
    if (t.method === 'COD') return 'Place COD Order';
    if (t.onCredit) {
        if (cart.length > 0 && t.amountOnAccount <= 0) return 'Complete Sale';
        return 'Charge to Account';
    }
    return 'Complete Sale';
}

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

function saleReference() {
    const field = document.getElementById('sale-reference-field');
    const box = document.getElementById('sale-reference');
    return field && !field.hidden && box ? box.value.trim() : '';
}

buildPaymentDetailsBox('sale-details-box', 'sale', true);
buildPaymentDetailsBox('payment-details-box', 'pay-debt', true);

function renderSalePaymentExtras(totals) {
    const t = totals || cartTotals();

    const taken = methodTakenNow(t);
    const field = document.getElementById('sale-reference-field');
    const words = null;
    if (field) {
        field.hidden = !words;
        const box = document.getElementById('sale-reference');
        if (words) {
            const hint = document.getElementById('sale-reference-hint');
            if (hint) hint.textContent = words.hint;
            if (box) box.placeholder = words.placeholder;
        } else if (box && box.value !== '') {
            box.value = '';
        }
    }

    let detailsFor = taken;
    if (t.onCredit) detailsFor = downPaymentMethod();
    showPaymentDetails('sale', detailsFor);
}

let catalogRefreshing = false;

async function refreshCatalogQuietly() {
    if (!catalogLoaded || catalogRefreshing) return;
    catalogRefreshing = true;
    try {
        catalog = await apiGetProducts();
        fillCatalogCategories();
        applyCatalogView();
    } catch (error) {
    } finally {
        catalogRefreshing = false;
    }
}

if (typeof onLiveChange === 'function') {
    onLiveChange(['inventory'], refreshCatalogQuietly);
}

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

    if (tender) tender.style.display = (onAccount || method === 'Bank Transfer') ? 'none' : 'block';
    if (down) down.style.display = onCredit ? 'block' : 'none';

    renderCart();
}

let selectedCustomerCredit = null;
let selectedCustomerLoyalty = null;

function renderLoyaltyNote(t) {
    const box = document.getElementById('loyalty-note');
    if (!box) return;

    const l = selectedCustomerLoyalty;
    if (!l || !(Number(l.rate) > 0)) {
        box.textContent = '';
        box.className = 'loyalty-note';
        return;
    }

    const rate = loyaltyRateText(l.rate);
    let text;
    if (l.qualifies) {
        text = rate + ' loyalty discount this month: paid ' + peso(l.lastMonthPaid) + ' last month.';
        if (t.onAccount) {
            text += ' It applies only to sales paid in full now, not to Credit or COD.';
        } else if (Number(l.thisMonthPaid) >= Number(l.threshold)) {
            text += ' Already paid enough this month to keep it next month.';
        }
        box.className = 'loyalty-note is-good';
    } else {
        const more = Number(l.threshold) - Number(l.thisMonthPaid);
        if (more > 0) {
            text = 'Paid ' + peso(l.thisMonthPaid) + ' this month: ' + peso(more) +
                ' more paid in full for the ' + rate + ' discount next month.';
        } else {
            text = 'Paid ' + peso(l.thisMonthPaid) + ' this month: the ' + rate + ' discount starts next month.';
        }
        box.className = 'loyalty-note';
    }
    box.textContent = text;
}

async function onCustomerChange(customerId) {
    const strip = document.getElementById('credit-strip');
    selectedCustomerCredit = null;
    selectedCustomerLoyalty = null;

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

    try {
        const loyalty = await apiGetCustomerLoyalty(customerId);
        if (String(selectedCustomerId()) === String(customerId)) selectedCustomerLoyalty = loyalty;
    } catch (error) {
        if (String(selectedCustomerId()) === String(customerId)) selectedCustomerLoyalty = null;
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

function checkoutCustomerName() {
    const id = selectedCustomerId();
    if (!id) return '';
    if (selectedCustomerCredit && selectedCustomerCredit.customer_name) return selectedCustomerCredit.customer_name;
    const found = findCustomer(id);
    if (found) return found.name;
    return typedCustomerName();
}

function checkoutQuestion(t, customerName) {
    const methodName = t.method === 'COD' ? 'Cash on Delivery' : t.method;
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
                confirmLabel = 'Confirm';
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

function focusBox(id) {
    const box = document.getElementById(id);
    if (box) box.focus();
}

async function handleCheckout(event, viaQr) {
    event.preventDefault();
    if (cart.length === 0) {
        notifyWarning('Add at least one item before completing the sale.', 'The order is empty');
        return;
    }

    const form = event.target;
    let t = cartTotals();
    const typedName = typedCustomerName();

    if (QR_METHODS.indexOf(methodTakenNow(t)) !== -1) viaQr = true;

    let customerId = null;
    if (form.elements.customerId.value) {
        customerId = parseInt(form.elements.customerId.value, 10);
    } else if (typedName !== '') {
        await loadCustomerDirectory(false);
        const exact = customerMatchingTypedName();
        if (exact) {
            customerId = exact.id;
            form.elements.customerId.value = String(exact.id);
            await onCustomerChange(String(exact.id));
            renderCustomerVerdict();
            t = cartTotals();
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

    if (pendingDelivery && !customerId && pendingDelivery.customerId) {
        customerId = pendingDelivery.customerId;
        await pickCustomer(customerId);
        t = cartTotals();
    }

    if (t.onAccount && !customerId) {
        notifyWarning(
            'A ' + t.method + ' sale is settled later, so it has to be charged to a customer. '
            + 'Pick them from the list.',
            'Name the customer');
        const box = customerNameBox();
        if (box) box.focus();
        return;
    }

    try {
        selectedCustomerLoyalty = customerId ? await apiGetCustomerLoyalty(customerId) : null;
    } catch (error) {
        notifyWarning('The loyalty discount could not be checked, so the sale was not rung up. Try again.',
            'Sale not completed');
        return;
    }
    t = cartTotals();
    renderCart();

    if (!t.onAccount && t.method !== 'Bank Transfer' && t.tendered < t.due) {
        notifyWarning('The amount entered is less than the amount due.', 'Sale not completed');
        return;
    }

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

    let amountPaid = t.tendered;
    if (t.onCredit) {
        amountPaid = t.down;
    } else if (t.onAccount) {
        amountPaid = 0;
    } else if (viaQr) {
        amountPaid = t.due;
    }

    let downPaymentMethod = 'Cash';
    if (form.elements.downPaymentMethod) {
        downPaymentMethod = form.elements.downPaymentMethod.value;
    }

    let qr = null;
    if (viaQr) {
        if (QR_METHODS.indexOf(taken) === -1) return;
        let qrWhat = 'For this sale';
        if (t.onCredit) qrWhat = 'Paid now on this credit sale';
        qr = await collectQrPayment(amountPaid, qrWhat, taken, 'sale', null, transferDetails);
        if (!qr) return;
    }

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

    const data = {
        customerId: customerId,
        walkInName: null,
        expectedDiscount: t.discount,
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

        const deliveryMade = await createAttachedDelivery(result.saleId);

        if (result.referenceNote) notifyWarning(result.referenceNote, 'Reference not saved');

        if (Number(result.discount) !== Number(t.discount)) {
            notifyWarning('The loyalty discount saved on this sale is ' + peso(result.discount) + ', not the ' +
                peso(t.discount) + ' the till showed. The invoice shows the saved figures.', 'Discount differs');
        }

        cart = [];
        form.elements.amountPaid.value = '';
        if (form.elements.downPayment) form.elements.downPayment.value = '0';
        if (form.elements.referenceNo) form.elements.referenceNo.value = '';
        clearPaymentDetails('sale');

        if (deliveryMade) { pendingDelivery = null; renderDeliveryAttached(); }

        if (customerId) {
            customerDirectoryLoaded = false;
            await loadCustomerDirectory(true);
        }

        if (!pendingDelivery) {
            await clearCustomer();
            form.elements.paymentMethod.value = 'Cash';
            onPaymentMethodChange('Cash');
        } else if (customerId) {
            await onCustomerChange(String(customerId));
        }

        catalogLoaded = false;
        renderCart();
        closeCheckoutModal();
        if (catalogMode !== 'idle') { await ensureCatalogLoaded(true); applyCatalogView(); }
        else renderCatalogEmpty();

        await openReceipt(result.saleId);
    } catch (error) {
        if (qr) qrPaidUnused = qr;
        notifyOffline();
    }
}

let storeSettings = null;

async function loadStoreSettings(force) {
    if (storeSettings && !force) return storeSettings;

    try {
        storeSettings = await apiGetStoreSettings();
    } catch (error) {
        storeSettings = null;
    }

    return storeSettings;
}

function receiptTaxBlock(sale) {
    const registration = sale.tax_registration || 'VAT';
    const rate = Number(sale.vat_rate) || 0;

    if (registration !== 'VAT') {
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

function receiptItemCount(items) {
    const list = Array.isArray(items) ? items : [];
    const units = pieceCount(list);
    return Number.isInteger(units) ? String(units) : units.toFixed(2);
}

function saleHasCustomer(s) {
    return Boolean(s.customer_id) || String(s.walk_in_name || '').trim() !== '';
}

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

    const shop = storeSettings || {};

    document.getElementById('receipt-heading').textContent = 'Invoice ' + receiptNo;
    document.getElementById('receipt-avatar').textContent = 'IN';
    document.getElementById('receipt-role').textContent = 'Sales invoice';
    document.getElementById('receipt-print-btn').textContent = 'Print Invoice';
    let itemsHtml = '';
    for (let i = 0; i < data.items.length; i++) {
        const it = data.items[i];
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
    if (Number(s.discount) > 0) totals.push({ label: 'Discount', value: peso(s.discount) });
    totals.push({ label: 'Total Due', value: peso(s.final_amount), due: true });
    if (Number(s.penalty_amount) > 0) {
        totals.push({
            label: 'Late Penalty (' + penaltyRateWord(s.penalty_rate) + '/mo \u00d7 ' + s.penalty_months + ')',
            value: peso(s.penalty_amount)
        });
    }
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
        detailsHtml: paymentDetailsReceiptHtml(paymentDetailItems(data), true)
    });

    renderVoidButton(fromReport ? data : null);
    showModal('receipt-modal');
}

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
        label: 'Reason', confirmLabel: 'Send Request', cancelLabel: 'Go back',
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

async function showPaymentReceipt(info) {
    await loadStoreSettings(false);
    const shop = storeSettings || {};

    const saleNumber = 'OR-' + String(info.saleId).padStart(6, '0');

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
        noInvoiceNote: true,
        footerLines: ['Thank you for your payment']
    });

    lastReceipt = null;
    renderVoidButton(null);

    showModal('receipt-modal');
}

function printReceipt() {
    if (typeof finishCreditPrint === 'function') finishCreditPrint();
    setReceiptPageSize(storeSettings || {});
    document.body.classList.add('printing-receipt');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-receipt'); }, 400);
}

function deliveryFormFields() {
    const form = document.getElementById('make-delivery-form');
    return form ? form.elements : null;
}

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

    const note = document.getElementById('dl-saved-address');
    if (note) {
        note.textContent = '';
        note.hidden = true;
    }
}

function clearDeliveryFilledBoxes() {
    fillDeliveryFromCustomer(null);
}

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
        box.textContent = '';
    } else if (typed === '') {
        box.className = 'customer-verdict';
        box.textContent = "Type the customer's name and pick them from the list.";
    } else {
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

    const exact = customerMatchingName(text);
    if (exact && idBox && idBox.value !== String(exact.id)) {
        await pickDeliveryCustomer(exact.id);
        return;
    }
    if (!exact && idBox && idBox.value !== '') {
        idBox.value = '';
        clearDeliveryFilledBoxes();
    }

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

function addCustomerFromDelivery() {
    const typed = typedDeliveryName();
    openAddCustomer();
    addCustomerFor = 'delivery';
    prefillAddCustomerName(typed);
}

function syncDeliveryToSaleCustomer(customerId) {
    if (!pendingDelivery || deliveryFormIsOpen) return;
    if (!customerId || pendingDelivery.customerId === Number(customerId)) return;

    const account = findCustomer(Number(customerId));
    if (!account) return;

    const saved = savedAddressParts(account);
    const phone = account.phone || '';

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

function fullDeliveryAddress(d) {
    let barangay = d.barangay;
    if (!/^(brgy|barangay|poblacion|zone|purok|sitio)\b/i.test(barangay)) barangay = 'Brgy. ' + barangay;

    let line = barangay + ', ' + d.city + ', ' + d.province;
    if (d.street) line = d.street + ', ' + line;
    if (d.landmark) line += ' (Landmark: ' + d.landmark + ')';
    return line;
}

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
        driverRoster = [];
    }
}

function onDriverInput(text) {
    const id = driverIdField();

    if (id && id.value && text !== pickedDriverName) {
        id.value = '';
        pickedDriverName = null;
        const clear = document.getElementById('driver-clear');
        if (clear) clear.hidden = true;
    }

    renderDriverSuggestions(id && id.value ? '' : text);
}

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

function onDeliveryFieldTyped(event) {
    const target = event.target;
    if (target && target.name && DELIVERY_ERROR_BOXES[target.name]) clearDeliveryFieldError(target.name);

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

    const form = document.getElementById('make-delivery-form');
    if (form && !form.dataset.typingWired) {
        form.addEventListener('input', onDeliveryFieldTyped);
        form.dataset.typingWired = 'yes';
    }

    showModal('delivery-modal');
    guardModal('delivery-modal', pendingDelivery ? 'your changes to the delivery' : 'the new delivery');
    setTimeout(function () { if (fields.contactName) fields.contactName.focus(); }, 60);
}

async function saveDeliveryForm(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = deliveryFormFields();
    if (!fields) return;

    clearDeliveryErrors();

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

    let firstBad = null;
    function complain(name, text) {
        showDeliveryFieldError(name, text);
        if (!firstBad) firstBad = fields[name];
    }

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
    if (street !== '' && street.length < 2) complain('street', 'The house number and street is too short; leave it empty if there is none.');
    if (barangay.length < 1) complain('barangay', 'Enter the barangay.');
    if (city.length < 2) complain('city', 'Enter the town or city.');
    if (province.length < 2) complain('province', 'Enter the province.');
    if (street.length > 150) complain('street', 'The house number and street is at most 150 characters.');
    if (barangay.length > 100) complain('barangay', 'The barangay is at most 100 characters.');
    if (city.length > 100) complain('city', 'The town or city is at most 100 characters.');
    if (province.length > 100) complain('province', 'The province is at most 100 characters.');
    if (landmark.length > 150) complain('landmark', 'The landmark is at most 150 characters.');
    if (fields.remarks.value.trim().length > 255) complain('remarks', 'The remarks are at most 255 characters.');

    if (!scheduledDate) {
        complain('scheduledDate', 'Pick the date and time of the delivery.');
    } else if (new Date(scheduledDate).getTime() < Date.now() - 60000) {
        complain('scheduledDate', 'That date has already passed. Check the date and time.');
    }

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
        address: fullDeliveryAddress({ street: street, barangay: barangay, city: city, province: province, landmark: landmark }),
        scheduledDate: scheduledDate,
        remarks: fields.remarks.value.trim(),
        driverId: driverId,
        driverName: driverName,
        edited: true
    };

    deliveryFormIsOpen = false;
    closeModal('delivery-modal');

    if (selectedCustomerId() !== customerId) await pickCustomer(customerId);
    renderCustomerVerdict();

    renderDeliveryAttached();
    notifyInfo('It will be created when you complete this sale.', 'Delivery attached');
}

async function cancelDeliveryForm() {
    if (!(await requestCloseModal('delivery-modal'))) return;
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

function buildDeliveryPanel() {
    createDataPanel({
        key: 'cash-deliveries',
        tableId: 'cdel-table',
        columns: 7,
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
                (row.payment_method === 'Credit'
                    ? '<td class="cell-num"><span class="muted">On account</span></td>'
                    : Number(row.balance_due) > 0
                        ? '<td class="cell-num cell-due">' + peso(row.balance_due) + '</td>'
                        : '<td class="cell-num"><span class="muted">Paid</span></td>') +
                '<td>' + statusBadge(row.status) + '</td></tr>';
        }
    });
}

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
async function handleIssueRefund(event) {
    event.preventDefault();
    const form = event.target;

    const reason = form.elements.reason.value.trim();

    if (isRefundMulti()) {
        await issueRefundForLines(form, reason);
        return;
    }

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
        const response = await apiFileRefund({
            saleId: data.saleId, reason: data.reason,
            items: [{ productId: data.productId, quantity: data.quantity, refundAmount: data.refundAmount }]
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

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
        clearRefundSale();
        catalogLoaded = false;
        await loadRecentSales();
    } catch (error) {
        notifyOffline();
    }
}

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
        const response = await apiFileRefund({ saleId: saleId, reason: reason, items: items });
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

function buildRecentSalesPanel() {
    createDataPanel({
        key: 'cash-recent-sales',
        tableId: 'recent-sales-table',
        columns: 6,
        pagerId: 'recent-sales-pager',
        idField: 'sale_id',
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

async function loadRecentSales() {
    const panel = getDataPanel('cash-recent-sales');
    if (!panel) return;
    if (panel.state === 'ready') await panel.refresh();
    else await panel.open();
}

let refundSale = null;

function floorCentavo(value) {
    return Math.floor(Number(value) * 100 + 1e-6) / 100;
}

function refundLinesFromSale(sale, items) {
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

function refundLineAmount(line, quantity) {
    return floorCentavo(line.paidPerUnit * quantity);
}

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

function markRefundSaleRow() {
    const rows = document.querySelectorAll('#recent-sales-table tbody tr');
    for (let i = 0; i < rows.length; i++) {
        const id = Number(rows[i].getAttribute('data-sale-id'));
        rows[i].classList.toggle('is-picked', Boolean(refundSale) && id === refundSale.saleId);
    }
}

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

function renderRefundForm() {
    const form = document.getElementById('refund-form');
    const multi = isRefundMulti();

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

function refundFormHasWork() {
    const form = document.getElementById('refund-form');
    if (!form || !panelShowing('panel-refund')) return false;
    const productBox = refundProductBox();
    return Boolean(refundSale) ||
        form.elements.reason.value.trim() !== '' ||
        form.elements.productId.value !== '' ||
        (productBox && productBox.value.trim() !== '') ||
        form.elements.saleId.value.trim() !== '' ||
        form.elements.quantity.value !== '1' ||
        form.elements.refundAmount.value !== '0';
}

function discardRefundForm() {
    const form = document.getElementById('refund-form');
    if (form) {
        form.elements.reason.value = '';
    }
    clearRefundSale();
}

async function cancelRefundForm(event) {
    if (event) event.preventDefault();
    if (refundFormHasWork() && !(await askDiscard('this refund'))) return;
    discardRefundForm();
    showCashierHome();
}

watchPanelLeave({
    panelId: 'panel-refund',
    hasWork: refundFormHasWork,
    what: function () { return 'this refund'; },
    discard: discardRefundForm
});

function buildSalesPanel() {
    createDataPanel({
        key: 'cash-sales',
        tableId: 'csales-table',
        columns: 6,
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

const DEBT_TERM_DAYS = 30;

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

let paymentSale = null;

function paymentFormFields() {
    const form = document.getElementById('payment-form');
    return form ? form.elements : null;
}

function findSaleRow(list, saleId) {
    for (let i = 0; i < list.length; i++) {
        if (list[i].sale_id === saleId) return list[i];
    }
    return null;
}

async function openPaymentForm(saleId) {
    let row = findSaleRow(customerOpenSales, saleId);

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
    guardModal('payment-modal', 'this payment');
    setTimeout(function () { if (fields && fields.amount) { fields.amount.focus(); fields.amount.select(); } }, 60);
}

async function cancelPaymentForm() {
    if (!(await requestCloseModal('payment-modal'))) return;
    closePaymentForm(true);
}

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

function renderPaymentVerdict() {
    const box = document.getElementById('payment-verdict');
    const fields = paymentFormFields();
    if (!box || !fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = parseFloat(fields.amount.value) || 0;

    showPaymentDetails('pay-debt', fields.paymentMethod.value);

    const qrButton = document.getElementById('payment-qr-btn');
    if (qrButton) {
        qrButton.hidden = QR_METHODS.indexOf(fields.paymentMethod.value) === -1;
        qrButton.textContent = 'Pay by QR';
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

async function handleTakePayment(event, viaQr) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const fields = paymentFormFields();
    if (!fields || !paymentSale) return;

    const balance = Number(paymentSale.balance_due) || 0;
    const amount = Math.round((parseFloat(fields.amount.value) || 0) * 100) / 100;
    const method = fields.paymentMethod.value;
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

    if (QR_METHODS.indexOf(method) !== -1) viaQr = true;

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

let openCustomerId = null;
let customerOpenSales = [];

let paymentReturnCustomer = null;
let paymentReturnPicker = false;

function canTakePayments() {
    return typeof holdsFeature !== 'function' || holdsFeature('debt-payments');
}

function payCustomerSale(saleId) {
    if (!openCustomer) return;
    paymentReturnCustomer = openCustomerId;
    paymentReturnPicker = false;
    closeModal('customer-modal');
    openPaymentForm(saleId);
}

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
            rowAttrs: function (index) {
                return 'class="row-clickable" title="Credit Settlement on this sale" ' +
                    'onclick="payCustomerSale(' + customerOpenSales[index].sale_id + ')"';
            }
        });
}

const CASH_RATING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };

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
const CASH_RATING_WORD = { Good: 'Good', Watch: 'Watch', Hold: 'On hold' };

let openCustomer = null;

function buildCustomerPanel() {
    createDataPanel({
        key: 'cash-credit',
        tableId: 'customers-table',
        columns: 3,
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

function clearCreditPanel() {
    const panel = getDataPanel('cash-credit');
    if (panel) panel.reset();

    const search = document.getElementById('customers-search');
    if (search) search.value = '';

    const due = document.getElementById('customers-due');
    if (due) due.value = 'all';
}

async function openCustomerCredit(customerId, tab) {
    try {
        const data = await apiGetCustomerHistory(customerId);
        openCustomer = data;
        openCustomerId = customerId;

        const c = data.credit;
        const owed = Number(c.current_credit) || 0;

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

        let available = Math.max(Number(c.available_credit) || 0, 0);
        if (c.standing === 'Hold') available = 0;
        const availableCell = '<span class="' + (available > 0 ? '' : 'cell-due') + '">' + peso(available) + '</span>';

        let penaltiesFact = '';
        if (Number(c.penalties_owed) > 0) {
            penaltiesFact = detailField('Late Penalties', '<span class="cell-due">' + peso(c.penalties_owed) +
                '</span> <span class="muted">of the amount owed, at ' +
                escapeHtml(penaltyRateWord(c.penalty_rate)) + ' a month</span>');
        }

        let loyalty = null;
        try {
            loyalty = await apiGetCustomerLoyalty(customerId);
        } catch (error) {
            loyalty = null;
        }

        document.getElementById('customer-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Balance', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Available Balance', availableCell) +
            detailField('Due Date', creditDueCell(c)) +
            detailField('Credit Rating', '<span class="badge ' +
                (CASH_RATING_TONE[c.standing] || 'badge-neutral') + '">' +
                escapeHtml(CASH_RATING_WORD[c.standing] || c.standing) + '</span>') +
            detailField('Open Sales', String(c.open_sales)) +
            penaltiesFact +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            detailField('Loyalty Discount', loyaltyFactHtml(loyalty)) +
            detailField('Address', c.address ? escapeHtml(c.address) : '<span class="muted">Not on file</span>');

        resetHistoryFilters();
        renderCustomerHistory();
        renderCustomerPayments();
        renderCustomerUnpaid();

        const hasUnpaid = payable && customerOpenSales.length > 0;
        const unpaidTab = document.getElementById('customer-tab-unpaid');
        if (unpaidTab) unpaidTab.hidden = !hasUnpaid;
        const pay = document.getElementById('customer-pay-btn');
        if (pay) pay.hidden = !hasUnpaid;

        document.getElementById('customer-print-card').hidden = !holdsFeature('customer-card-print');

        let open = 'account';
        if (tab === 'unpaid' && hasUnpaid) open = 'unpaid';
        else if (tab === 'history' || tab === 'payments') open = tab;
        showCustomerTab(open);
        showModal('customer-modal');
    } catch (error) {
        notifyError('That customer could not be opened.', 'Nothing to show');
    }
}

function printOpenCustomer(kind) {
    if (!openCustomerId) return;
    if (kind === 'card') {
        printCustomerCard(openCustomerId);
    } else {
        printCreditTerms(openCustomerId);
    }
}

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

function filterValue(id) {
    const box = document.getElementById(id);
    return box ? box.value : '';
}

function dayOfStamp(value) { return String(value || '').slice(0, 10); }

function dayInRange(day, from, to) {
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
}

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

    const onlyPaid = status === 'paid';
    const purchaseRows = [];
    for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        let penaltyNote = '';
        if (Number(p.penalty_amount) > 0) {
            penaltyNote = '<span class="cell-sub">+ ' + peso(p.penalty_amount) + ' penalty</span>';
        }
        const cells = [
            escapeHtml(dayOfStamp(p.sale_date)),
            '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
            peso(p.final_amount) + penaltyNote
        ];
        if (!onlyPaid) {
            let balanceCell = '<span class="muted">Paid</span>';
            if (Number(p.balance_due) > 0) balanceCell = '<span class="cell-due">' + peso(p.balance_due) + '</span>';
            cells.push(balanceCell);
        }
        purchaseRows.push(cells);
    }

    box.innerHTML = pagedTable('cash-purchases',
        onlyPaid ? ['Date', 'Sale', 'Amount'] : ['Date', 'Sale', 'Amount', 'Balance'],
        purchaseRows, onlyPaid ? [2] : [2, 3], {
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
        let receiptCell = '<span class="muted">-</span>';
        if (p.sale_id) receiptCell = '#' + p.sale_id;
        const cells = [escapeHtml(dayOfStamp(p.payment_date)), peso(p.amount)];
        if (how === 'all') cells.push(escapeHtml(p.payment_method));
        cells.push(receiptCell);
        paymentRows.push(cells);
    }

    box.innerHTML = pagedTable('cash-payments',
        how === 'all' ? ['Date', 'Amount', 'Method', 'Receipt'] : ['Date', 'Amount', 'Receipt'],
        paymentRows, [1], {
            empty: emptyHistoryNote('No payments recorded.', from, to, how !== 'all' || from || to)
        });
}

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
    guardModal('limit-modal', 'this credit limit request');
    setTimeout(function () { form.elements.requestedLimit.focus(); }, 60);
}

function renderLimitVerdict() {
    const verdict = document.getElementById('limit-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

async function cancelLimitForm() {
    if (!(await requestCloseModal('limit-modal'))) return;
    closeLimitForm();
}

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

let addCustomerFor = '';

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

function onAddCustomerTyped(event) {
    const target = event.target;
    if (target && target.name && ADD_CUSTOMER_ERROR_BOXES[target.name]) clearAddCustomerFieldError(target.name);

    const verdict = document.getElementById('add-customer-verdict');
    if (verdict) { verdict.textContent = ''; verdict.className = 'delivery-verdict'; }
}

function prefillAddCustomerName(typed) {
    const form = document.getElementById('add-customer-form');
    if (!form) return;

    const words = String(typed || '').trim().split(/\s+/);
    if (words[0] === '') return;
    form.elements.firstName.value = words.shift();
    form.elements.lastName.value = words.join(' ');
    guardModal('add-customer-modal', 'the new customer');
}

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

    if (!form.dataset.typingWired) {
        form.addEventListener('input', onAddCustomerTyped);
        form.dataset.typingWired = 'yes';
    }

    const save = document.getElementById('add-customer-save');
    if (save) save.disabled = false;

    showModal('add-customer-modal');
    guardModal('add-customer-modal', 'the new customer');
    setTimeout(function () { form.elements.firstName.focus(); }, 60);
}

async function cancelAddCustomer() {
    if (!(await requestCloseModal('add-customer-modal'))) return;
    addCustomerFor = '';
    editCustomerId = null;
    closeModal('add-customer-modal');
}

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
    guardModal('add-customer-modal', 'your changes to this customer');
}

async function handleAddCustomer(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const form = document.getElementById('add-customer-form');
    const verdict = document.getElementById('add-customer-verdict');
    if (!form) return;

    clearAddCustomerErrors();

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

    let newCustomerId = 0;
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

        customerDirectoryLoaded = false;

        const openedFor = addCustomerFor;
        addCustomerFor = '';
        if (openedFor === 'sale') {
            await loadCustomerDirectory(true);
            await pickCustomer(Number(result.customerId));
        } else if (openedFor === 'delivery') {
            await loadCustomerDirectory(true);
            await pickDeliveryCustomer(Number(result.customerId));
        }

        const panel = getDataPanel('cash-credit');
        if (panel) {
            if (panel.state === 'closed' || panel.state === 'error') await panel.open();
            else await panel.refresh();
        }

        newCustomerId = Number(result.customerId);
    } catch (error) {
        if (save) save.disabled = false;
        notifyOffline();
        return;
    }

    try {
        await offerCustomerCardPrint(newCustomerId, firstName + ' ' + lastName);
    } catch (error) {
        notifyError('The customer card could not be printed. Print it from the customer\'s card.');
    }
}

async function offerCustomerCardPrint(customerId, name) {
    if (!customerId || !holdsFeature('customer-card-print')) return;
    const yes = await askConfirm('Print the customer card for ' + name + ' now?', {
        title: 'Print the customer card?',
        eyebrow: 'New customer',
        confirmLabel: 'Print the card',
        cancelLabel: 'Not now'
    });
    if (yes) await printCustomerCard(customerId);
}

async function openCreditPaymentPicker() {
    if (!canTakePayments()) return;

    const search = document.getElementById('credit-pay-search');
    if (search) search.value = '';

    const list = document.getElementById('credit-pay-list');
    if (list) list.innerHTML = '<p class="detail-empty">Reading the customers...</p>';

    showModal('credit-pay-modal');
    setTimeout(function () { if (search) search.focus(); }, 60);

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

if (window.location.pathname.toLowerCase().endsWith('cashier-dashboard.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        buildCustomerPanel();
        buildDeliveryPanel();
        buildSalesPanel();
        buildRecentSalesPanel();

        configureDeliverySchedule({ showPanel: function (panelId, title) { showCashierPanel(panelId, title); } });
        buildDeliverySchedulePanel();
        configureFeatures({ home: function () { showCashierHome(); } });

        const creditAlert = { label: 'Customers Record', panelId: 'panel-customers',
                              open: function () { showCustomers(); }, key: 'cash-credit' };
        configureNotificationTargets({
            'Delivery':       { label: 'Delivery Tracking', panelId: 'panel-delivery',
                                open: function () { showCashierDeliveries(); }, key: 'cash-deliveries' },
            'Refund Report':  { label: 'Refunds', panelId: 'panel-refund',
                                open: function () { showRefunds(); } },
            'Credit Request': creditAlert,
            'Late Penalty':   creditAlert,
            'Void Request':   { label: 'Sales Report', panelId: 'panel-salesreport',
                                open: function () { showSalesReport(); }, key: 'cash-sales' }
        });

        renderCatalogEmpty();
        renderCustomerVerdict();
        renderRefundProductVerdict();
        renderDeliveryAttached();
        showCashierHome();
        unfoldSidebarAtOpenScreen();
        loadStoreSettings(false);
        loadNotifications();
    });

    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideCustomerSuggestions();
        hideRefundSuggestions();
        hideDriverSuggestions();
    });
}
