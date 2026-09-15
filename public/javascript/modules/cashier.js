// cashier.js -- cashier
// Loaded by: cashier-dashboard.html
let catalog = [];
let catalogLoaded = false;
let catalogMode = 'idle';     // 'idle' keeps the grid clean, 'all' shows everything
let cart = [];
let cashierSales = [];
let salesScope = 'Mine';
let lastReceipt = null;

// eight rows is what fits above the fold on the counter machine
const CASHIER_ROWS_PER_PAGE = 8;

// the refunds log is read back through, so it pages longer
const REFUND_ROWS_PER_PAGE = 12;

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

    // a screen listed under Point of Sale unfolds the list when a person opened it
    if (event && POS_PANELS.indexOf(panelId) !== -1) togglePosMenu(null, true);

    const heading = document.getElementById('cash-page-title');
    if (heading) heading.textContent = title;

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// Point of Sale folds its list open and shut
const POS_PANELS = ['panel-pos', 'panel-delivery', 'panel-refund'];

function togglePosMenu(event, force) { toggleSidebarMenu('pos-nav', 'pos-dropdown', event, force); }

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

function showCustomers(event) { showCashierPanel('panel-customers', 'Customers & Credit', event); }

function showSalesReport(event) {
    showCashierPanel('panel-salesreport', 'Sales Report', event);
}

function showDailySummary(event) {
    showCashierPanel('panel-summary', 'Daily Summary', event);
    loadDailySummary();
}

// ---------- product catalog ----------
async function ensureCatalogLoaded(force) {
    if (catalogLoaded && !force) return true;
    try {
        catalog = await getJson('/api/inventory/products?archived=false');
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
            <p>Search above for what the customer is buying, or load the whole catalog.</p>
            <button type="button" class="btn btn-accent" onclick="loadCatalogAll(event)">View All Products</button>
        </div>`;
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
                catalogFilters.category !== "all" || catalogFilters.stock !== "all"
                    ? " with the filters above set the way they are" : ""}. Archived products never appear here.</p>
            <button type="button" class="btn btn-accent" onclick="loadCatalogAll(event)">View All Products</button>
        </div>`;
}

// The catalog is a table, not a grid of cards. Only the Add button at the
// end of a row adds; pressing the row anywhere else opens the product.
const catalogFilters = { category: 'all', stock: 'all' };

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

function catalogMatchesFilters(p) {
    if (catalogFilters.category !== 'all' && String(p.category_name || 'Uncategorised') !== catalogFilters.category) return false;
    const out = Number(p.quantity_in_stock) <= 0;
    if (catalogFilters.stock === 'in' && out) return false;
    if (catalogFilters.stock === 'out' && !out) return false;
    return true;
}

function fillCatalogCategories() {
    const select = document.getElementById('catalog-category');
    if (!select) return;

    const names = [...new Set(catalog.map((p) => String(p.category_name || 'Uncategorised')))].sort();
    const current = select.value;
    select.innerHTML = '<option value="all">Every category</option>' +
        names.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
    select.value = names.indexOf(current) !== -1 ? current : 'all';
    catalogFilters.category = select.value;
}

function applyCatalogView() {
    const box = document.getElementById('catalog-search');
    const text = box ? box.value.trim().toLowerCase() : '';

    if (text === '' && catalogMode !== 'all') { renderCatalogEmpty(); return; }

    const rows = catalog.filter((p) =>
        catalogMatchesFilters(p) &&
        (text === '' || substringMatch([p.product_name, p.category_name, p.brand_name], text)));
    renderCatalog(rows, text);
}

function renderCatalog(rows, keyword) {
    const grid = catalogGrid();
    if (!grid) return;

    if (rows.length === 0) { renderCatalogNoMatch(keyword || ''); return; }

    // No stock count on a card at the till; the one stock fact it carries is
    // whether the product can be sold at all, said in words on the card.
    setPill('catalog-count', rows.length + (rows.length === 1 ? ' product' : ' products'));
    grid.innerHTML =
        '<table class="catalog-table" id="catalog-table">' +
        '<thead><tr><th>Product</th><th>Category</th><th>Brand</th><th>Price</th><th>Availability</th><th></th></tr></thead>' +
        '<tbody>' + rows.map((p, i) => {
            const out = Number(p.quantity_in_stock) <= 0;
            return '<tr class="row-reveal row-clickable' + (out ? ' is-out' : '') + '"' +
                ' style="animation-delay:' + Math.min(i, 12) * 26 + 'ms"' +
                ' onclick="openCatalogProduct(' + p.product_id + ')" title="Press to see the product">' +
                '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
                '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
                '<td>' + escapeHtml(p.brand_name || '\u2014') + '</td>' +
                '<td class="cell-num catalog-price">' + peso(p.price) + '</td>' +
                '<td>' + (out ? '<span class="badge badge-danger">Out of stock</span>'
                              : '<span class="badge badge-success">In stock</span>') + '</td>' +
                '<td class="cell-action">' +
                    '<button type="button" class="btn btn-sm' + (out ? '' : ' btn-accent') + '"' +
                    (out ? ' disabled' : ' onclick="event.stopPropagation(); addToCart(' + p.product_id + ')"') + '>' +
                    (out ? 'None left' : 'Add') + '</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
}

// ---------- one product, on a card ----------
function openCatalogProduct(productId) {
    const p = catalog.find((x) => x.product_id === productId);
    if (!p) return;

    const out = Number(p.quantity_in_stock) <= 0;
    const inCart = cart.find((l) => l.product_id === productId);

    const facts = '<div class="detail-grid">' +
        detailField('Product', escapeHtml(p.product_name)) +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('Brand', p.brand_name ? escapeHtml(p.brand_name) : '<span class="muted">Not set</span>') +
        detailField('Sold By', p.unit_name
            ? escapeHtml(p.unit_name) + (isMeasuredUnit(p.unit_name)
                ? ' <span class="muted">\u00b7 by measure, any amount</span>' : '')
            : '<span class="muted">Not set</span>') +
        detailField('Price', peso(p.price)) +
        detailField('Availability', out
            ? '<span class="badge badge-danger">Out of stock</span>'
            : '<span class="badge badge-success">In stock</span>') +
        (p.supplier_name ? detailField('Supplier', escapeHtml(p.supplier_name)) : '') +
        detailField('Product ID', '#' + p.product_id) +
        '</div>' +
        (inCart
            ? '<p class="detail-note">Already on the order: ' + escapeHtml(qtyText(inCart.quantity, p.unit_name)) +
              (isMeasuredUnit(p.unit_name) ? '. Adding asks for the amount to put on.' : '. Adding puts one more on.') + '</p>' : '') +
        '<div class="detail-actions">' +
        (out
            ? '<p class="detail-note detail-warn">None left to sell. The clerk is told when it is restocked.</p>'
            : '<button type="button" class="btn btn-accent" onclick="addFromProductCard(' + p.product_id + ')">Add to order</button>') +
        '</div>';

    openDetailModal(p.product_name, (p.category_name || 'Uncategorised') + ' \u00b7 ' + peso(p.price),
        initialsOf(p.product_name), [{ label: 'Product', body: facts }]);
}

function addFromProductCard(productId) {
    closeModal('detail-modal');
    addToCart(productId);
}

async function loadCatalogAll(event) {
    if (event) event.preventDefault();
    showCashierPanel('panel-pos', 'Point of Sale');
    const link = document.querySelector('a[data-panel-link="panel-pos"]');
    if (link) link.classList.add('active');

    const search = document.getElementById('catalog-search');
    if (search) search.value = '';
    catalogMode = 'all';

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

// Enter searches; Escape clears
function onCatalogSearchKey(event) {
    if (!event || !event.target) return;

    if (event.key === 'Escape') {
        event.target.value = '';
        filterCatalog('');
        return;
    }
    if (event.key !== 'Enter') return;

    event.preventDefault();
    filterCatalog(event.target.value);
}

async function filterCatalog(keyword) {
    const text = keyword.trim().toLowerCase();

    if (text === '') {
        if (catalogMode === 'all') applyCatalogView();
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
        const latest = box ? box.value.trim().toLowerCase() : text;
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

    if (query.length < 1 || catalog.length === 0) { hide(); return; }

    if (refundProduct && String(refundProduct.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    // names that start with the text come before ones that merely contain it
    const starts = [];
    const contains = [];
    const other = [];

    catalog.forEach((p) => {
        const name = String(p.product_name || '').toLowerCase();
        const meta = (String(p.brand_name || '') + ' ' + String(p.category_name || '')).toLowerCase();

        if (name.indexOf(query) === 0) starts.push(p);
        else if (name.indexOf(query) !== -1) contains.push(p);
        else if (meta.indexOf(query) !== -1) other.push(p);
    });

    const found = starts.concat(contains, other).slice(0, 6);

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
        customerDirectory = await getJson('/api/records/customer');
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

    if (query.length < 1 || customerDirectory.length === 0) {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
        return;
    }

    // names that start with the text first; six fits under the box
    const starts = [];
    const contains = [];

    customerDirectory.forEach((c) => {
        const name = String(c.name || '').toLowerCase();
        const phone = String(c.phone || '').toLowerCase();
        if (name.indexOf(query) === 0) starts.push(c);
        else if (name.indexOf(query) !== -1 || phone.indexOf(query) !== -1) contains.push(c);
    });

    const found = starts.concat(contains).slice(0, 6);

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
    box.textContent = 'Not on the books. The name is kept with the sale, and you will be '
        + 'asked whether to open an account.';
}

// kept under the old name because the boot sequence and the catalog loader call it
async function loadCustomerOptions() {
    await loadCustomerDirectory(false);
}

// ---------- the cart ----------
// A measured product (nails by the kilo) asks for the amount in a card first,
// with what is on the shelf as the ceiling; a counted one adds one at a time.
async function askMeasure(product, current) {
    const measure = measuredUnit(product.unit_name);
    const onHand = Number(product.quantity_in_stock);
    const answer = await askInput({
        title: 'How much ' + product.product_name + '?',
        eyebrow: 'By the ' + String(product.unit_name || '').toLowerCase(),
        message: peso(product.price) + ' per ' + String(product.unit_name || '') +
            '. Up to ' + qtyText(onHand, product.unit_name) + ' can be sold today.',
        label: 'Amount in ' + (measure ? measure.short : product.unit_name),
        value: current !== undefined ? String(current) : '',
        placeholder: measure ? 'e.g. 2.5' : '',
        confirmLabel: 'Put it on the order',
        check: (value) => {
            const amount = Number(String(value).replace(/,/g, '').trim());
            if (!Number.isFinite(amount) || amount <= 0) return 'Type the amount as a number, like 2.5.';
            if (amount > onHand) return 'Only ' + qtyText(onHand, product.unit_name) + ' can be sold today.';
            if (Math.round(amount * 1000) !== amount * 1000) return 'Three decimal places at most.';
            return null;
        }
    });
    if (answer === null || answer === undefined) return null;
    return Number(String(answer).replace(/,/g, '').trim());
}

async function addToCart(productId, quantity) {
    const p = catalog.find((x) => x.product_id === productId);
    if (!p) return;

    const line = cart.find((l) => l.product_id === productId);
    const onHand = Number(p.quantity_in_stock);

    // the answer replaces what the line had: "how much" is a total, not a step
    if (isMeasuredUnit(p.unit_name) && quantity === undefined) {
        if (onHand <= 0) {
            notifyWarning(p.product_name + ' is out of stock, so it cannot go on this sale.', 'Nothing to sell');
            return;
        }
        const amount = await askMeasure(p, line ? line.quantity : undefined);
        if (amount === null) return;
        if (line) line.quantity = amount;
        else cart.push({ product_id: p.product_id, name: p.product_name, price: Number(p.price),
                         unit: p.unit_name || '', quantity: amount, on_hand: onHand });
        renderCart();
        return;
    }
    const step = quantity === undefined ? 1 : Number(quantity);

    // capped at what exists; the cashier is told the order already has everything available
    if (line) {
        if (line.quantity + step > onHand) {
            notifyWarning('The order already has every ' + escapeHtml(p.product_name) +
                ' we can sell today. Take the rest off a delivery or a new order.',
                'That is all of it');
            return;
        }
        line.quantity = Number((line.quantity + step).toFixed(3));
    } else {
        if (onHand < step) {
            notifyWarning(p.product_name + ' is out of stock, so it cannot go on this sale.',
                'Nothing to sell');
            return;
        }
        cart.push({ product_id: p.product_id, name: p.product_name, price: Number(p.price),
                    unit: p.unit_name || '', quantity: step, on_hand: onHand });
    }
    renderCart();
}

function changeCartQty(productId, delta) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;

    const measure = measuredUnit(line.unit);
    const next = Number((line.quantity + delta * (measure ? measure.step : 1)).toFixed(3));
    if (next <= 0) { removeCartLine(productId); return; }
    if (next > line.on_hand) {
        notifyWarning('The order already has every ' + line.name + ' we can sell today. ' +
            'Take the rest off a delivery or a new order.', 'That is all of it');
        return;
    }
    line.quantity = next;
    renderCart();
}

async function retypeCartQty(productId) {
    const line = cart.find((l) => l.product_id === productId);
    const p = catalog.find((x) => x.product_id === productId);
    if (!line || !p) return;

    const amount = await askMeasure(p, line.quantity);
    if (amount === null) return;
    line.quantity = amount;
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
        form.elements.amountPaid.value = '0';
        if (form.elements.downPayment) form.elements.downPayment.value = '0';
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
    const gross = cart.reduce((sum, l) => sum + (l.price * l.quantity), 0);
    const discount = 0;
    const due = Math.max(gross - discount, 0);
    const tendered = form ? (parseFloat(form.elements.amountPaid.value) || 0) : 0;
    const method = form ? form.elements.paymentMethod.value : 'Cash';

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    // half now and half on the book; capped at the bill because there is no change
    const rawDown = form && form.elements.downPayment
        ? (parseFloat(form.elements.downPayment.value) || 0) : 0;
    const down = onCredit ? Math.max(0, Math.min(rawDown, due)) : 0;

    return {
        gross, discount, due, tendered,
        change: Math.max(tendered - due, 0),
        method, onAccount, onCredit,
        down: down,
        onBook: onCredit ? due - down : (method === 'COD' ? due : 0)
    };
}

function renderCart() {
    const box = document.getElementById('cart-lines');
    if (!box) return;

    setPill('cart-count', cart.length + (cart.length === 1 ? ' item' : ' items'));

    if (cart.length === 0) {
        box.innerHTML = '<p class="cart-empty">No items yet. Tap a product to add it.</p>';
    } else {
        box.innerHTML = cart.map((l) =>
            '<div class="cart-line">' +
            '<div class="cart-line-main">' +
            '<span class="cart-name">' + escapeHtml(l.name) + '</span>' +
            '<span class="cart-unit">' + peso(l.price) + (isMeasuredUnit(l.unit)
                ? ' per ' + escapeHtml(measuredUnit(l.unit).short) : ' each') + '</span>' +
            '</div>' +
            '<div class="cart-qty">' +
            '<button type="button" class="qty-btn" onclick="changeCartQty(' + l.product_id + ', -1)" aria-label="Less">&minus;</button>' +
            (isMeasuredUnit(l.unit)
                ? '<button type="button" class="qty-value qty-typed" onclick="retypeCartQty(' + l.product_id + ')" ' +
                  'title="Press to type the amount">' + escapeHtml(qtyText(l.quantity, l.unit)) + '</button>'
                : '<span class="qty-value">' + l.quantity + '</span>') +
            '<button type="button" class="qty-btn" onclick="changeCartQty(' + l.product_id + ', 1)" aria-label="More">+</button>' +
            '</div>' +
            '<span class="cart-sub">' + peso(l.price * l.quantity) + '</span>' +
            '<button type="button" class="cart-remove" onclick="removeCartLine(' + l.product_id + ')" aria-label="Remove">&times;</button>' +
            '</div>'
        ).join('');
    }

    const t = cartTotals();
    const totals = document.getElementById('cart-totals');
    if (totals) {
        totals.innerHTML =
            '<div class="total-row"><span>Subtotal</span><span>' + peso(t.gross) + '</span></div>' +
            '<div class="total-row total-due"><span>Amount Due</span><span>' + peso(t.due) + '</span></div>' +
            (t.onCredit
                ? '<div class="total-row"><span>Paid now</span><span>' + peso(t.down) + '</span></div>' +
                  '<div class="total-row ' + (t.onBook > 0 ? 'total-short' : 'total-change') + '">' +
                  '<span>' + (t.onBook > 0 ? 'On account' : 'Paid in full') + '</span><span>' +
                  peso(t.onBook) + '</span></div>'
                : t.onAccount
                ? '<div class="total-row total-note"><span>Collected on delivery</span><span>' +
                  peso(t.due) + '</span></div>'
                : '<div class="total-row"><span>Tendered</span><span>' + peso(t.tendered) + '</span></div>' +
                  '<div class="total-row ' + (t.tendered < t.due ? 'total-short' : 'total-change') + '"><span>' +
                  (t.tendered < t.due ? 'Short by' : 'Change') + '</span><span>' +
                  peso(t.tendered < t.due ? t.due - t.tendered : t.change) + '</span></div>');
    }

    renderCreditVerdict(t);

    const button = document.getElementById('checkout-btn');
    if (button) button.disabled = cart.length === 0 || (!t.onAccount && t.tendered < t.due);
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
        const data = await getJson('/api/credit/customers/' + customerId);
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

    const tone = c.standing === 'Hold' ? 'is-stop'
        : (c.standing === 'Watch' || available <= 0) ? 'is-watch' : 'is-good';

    strip.className = 'credit-strip ' + tone;
    strip.style.display = 'block';
    strip.innerHTML =
        '<div class="credit-strip-row">' +
            '<span class="credit-strip-label">Credit limit</span>' +
            '<span class="credit-strip-value">' + peso(c.credit_limit) + '</span>' +
        '</div>' +
        '<div class="credit-strip-row">' +
            '<span class="credit-strip-label">Already owes</span>' +
            '<span class="credit-strip-value">' + peso(owed) + '</span>' +
        '</div>' +
        '<div class="credit-strip-row credit-strip-main">' +
            '<span class="credit-strip-label">Can take on account</span>' +
            '<span class="credit-strip-value">' +
                (c.standing === 'Hold' ? 'Nothing &mdash; on hold' : peso(available)) +
            '</span>' +
        '</div>' +
        (c.standing !== 'Good' && c.standing_reason
            ? '<p class="credit-strip-note">' + escapeHtml(c.standing_reason) + '</p>'
            : c.credit_notes
            ? '<p class="credit-strip-note">' + escapeHtml(c.credit_notes) + '</p>' : '');
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
            'from <kbd>Customers &amp; Credit</kbd>.';
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
async function handleCheckout(event) {
    event.preventDefault();
    if (cart.length === 0) {
        notifyWarning('Add at least one item before completing the sale.', 'The order is empty');
        return;
    }

    const form = event.target;
    const t = cartTotals();
    const typedName = typedCustomerName();

    // a settled-later sale needs an account, not a name
    if (t.onAccount && !form.elements.customerId.value) {
        notifyWarning(
            typedName === ''
                ? 'A ' + t.method + ' sale is settled later, so it has to be booked against a '
                  + 'customer who has an account.'
                : typedName + ' has no account yet, and a ' + t.method + ' sale is settled later. '
                  + 'Open an account for them first, or take the payment now.',
            'Pick a customer with an account');
        const box = customerNameBox();
        if (box) box.focus();
        return;
    }

    if (!t.onAccount && t.tendered < t.due) {
        notifyWarning('The amount entered is less than the amount due.', 'Sale not completed');
        return;
    }

    // A typed name is asked about once at checkout: open an account or not.
    // No is a real answer; the name still goes on the sale.
    let customerId = form.elements.customerId.value
        ? parseInt(form.elements.customerId.value, 10) : null;

    if (!customerId && typedName !== '') {
        const open = await askConfirm(
            typedName + ' is not on the customer list.',
            {
                title: 'Open an account for ' + typedName + '?',
                eyebrow: 'Point of Sale',
                confirmLabel: 'Open an account',
                cancelLabel: 'Just this sale',
                detail: [
                    'An account keeps their purchase history and lets them be found by name next time.',
                    'It starts with no credit limit: they still pay at the counter until a manager sets one.',
                    'Answering no keeps the name on this receipt and creates nothing.'
                ]
            });

        if (open) {
            const created = await createCustomerFromCounter(typedName);
            if (created === false) return;      // the server refused; nothing was sold
            if (created) customerId = created;
        }
    }

    // a part-paid credit sale leaves money on the account; the server checks the limit again
    if (t.onCredit && t.onBook > 0) {
        const name = selectedCustomerCredit
            ? selectedCustomerCredit.customer_name : 'this customer';

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

    const data = {
        customerId: customerId,
        // kept only when there is no account; a named customer already lives in customers
        walkInName: customerId ? null : (typedName || null),
        discount: t.discount,
        amountPaid: t.onCredit ? t.down : (t.onAccount ? 0 : t.tendered),
        paymentMethod: t.method,
        downPaymentMethod: form.elements.downPaymentMethod
            ? form.elements.downPaymentMethod.value : 'Cash',
        items: cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity }))
    };

    try {
        const response = await fetch('/api/sales', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        // the delivery is written against the sale before the till is cleared, so a
        // failure is reported while the details are still on screen
        const booked = await bookAttachedDelivery(result.saleId);

        cart = [];
        form.elements.amountPaid.value = '0';
        if (form.elements.downPayment) form.elements.downPayment.value = '0';

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
        if (catalogMode === 'all') { await ensureCatalogLoaded(true); renderCatalog(catalog); }
        else renderCatalogEmpty();

        await openReceipt(result.saleId);
    } catch (error) {
        notifyOffline();
    }
}

// The counter's half of opening an account: the record only, limit zero.
// Returns the customer id, null when no account was made, or false when the
// server refused (which stops the sale).
async function createCustomerFromCounter(fullName) {
    const parts = String(fullName).trim().split(/\s+/);
    const firstName = parts.shift();
    const lastName = parts.join(' ');

    const phone = await askInput({
        title: 'Phone number',
        eyebrow: 'New customer',
        message: 'A number is how ' + fullName + ' is reached about a delivery or a balance. '
               + 'Leave it empty if they did not give one.',
        label: 'Phone',
        type: 'tel',
        placeholder: '09xx xxx xxxx',
        confirmLabel: 'Save the customer'
    });

    // cancelling the phone question cancels the account, not the sale
    if (phone === false || phone === null) return null;

    try {
        const response = await fetch('/api/customers', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                firstName: firstName,
                lastName: lastName,
                phone: String(phone).trim(),
                address: pendingDelivery ? pendingDelivery.address : ''
            })
        });
        const result = await response.json();

        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Account not created');
            return false;
        }

        notifySuccess(result.message, result.created ? 'Account opened' : 'Account found');

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
        storeSettings = await getJson('/api/store-settings');
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
function receiptItemCount(items) {
    const list = Array.isArray(items) ? items : [];
    const units = list.reduce((sum, it) =>
        sum + (isMeasuredUnit(it.unit_name) ? 1 : (Number(it.quantity) || 0)), 0);
    const lines = list.length;
    const count = Number.isInteger(units) ? String(units) : units.toFixed(2);
    return count + (lines > 0 && lines !== units ? ' (' + lines + (lines === 1 ? ' line)' : ' lines)') : '');
}

async function openReceipt(saleId) {
    let data;
    try { data = await getJson('/api/sales/' + saleId); }
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
    const tinLabel = (s.tax_registration || 'VAT') === 'VAT' ? 'VAT REG TIN' : 'NON-VAT REG TIN';

    document.getElementById('receipt-heading').textContent = 'Invoice ' + receiptNo;
    document.getElementById('receipt-paper').innerHTML =
        '<div class="rc-head">' +
        '<span class="rc-shop">' + escapeHtml(shop.store_name || 'Hardware Sales & Inventory') + '</span>' +
        (shop.address ? '<span class="rc-addr">' + escapeHtml(shop.address) + '</span>' : '') +
        '<span class="rc-addr">' + tinLabel + ': ' + escapeHtml(shop.tin || '000-000-000-00000') + '</span>' +
        '<span class="rc-line">Sales Invoice</span>' +
        '<span class="rc-no">' + receiptNo + '</span>' +
        '</div>' +
        '<div class="rc-meta">' +
        '<span>Date</span><span>' + escapeHtml(s.sale_date) + '</span>' +
        '<span>Cashier</span><span>' + escapeHtml(s.cashier_name) + '</span>' +
        '<span>Customer</span><span>' + escapeHtml(s.customer_name) + '</span>' +
        '<span>Payment</span><span>' + escapeHtml(s.payment_method) + '</span>' +
        (s.reference_no ? '<span>Reference</span><span>' + escapeHtml(s.reference_no) + '</span>' : '') +
        '</div>' +
        '<div class="rc-rule"></div>' +
        '<table class="rc-items"><tbody>' +
        data.items.map((it) =>
            '<tr><td>' + escapeHtml(it.product_name) + '<br><span class="rc-qty">' +
            escapeHtml(qtyText(it.quantity, it.unit_name)) + ' x ' + peso(it.unit_price) +
            (isMeasuredUnit(it.unit_name) ? '/' + escapeHtml(measuredUnit(it.unit_name).short) : '') + '</span></td>' +
            '<td class="rc-amt">' + peso(it.subtotal) + '</td></tr>').join('') +
        '</tbody></table>' +
        '<div class="rc-rule"></div>' +
        '<div class="rc-totals">' +
        '<div><span>Total Items Purchased</span><span>' + receiptItemCount(data.items) + '</span></div>' +
        '<div><span>Subtotal</span><span>' + peso(s.total_amount) + '</span></div>' +
        // only when there was one; older sales still carry real figures
        (Number(s.discount) > 0
            ? '<div><span>Discount</span><span>' + peso(s.discount) + '</span></div>' : '') +
        '<div class="rc-due"><span>Total Due</span><span>' + peso(s.final_amount) + '</span></div>' +
        '<div><span>Tendered</span><span>' + peso(s.amount_paid) + '</span></div>' +
        '<div><span>Change</span><span>' + peso(s.change_given) + '</span></div>' +
        '</div>' +
        '<div class="rc-rule"></div>' +
        receiptTaxBlock(s) +
        '<div class="rc-rule"></div>' +
        '<p class="rc-foot">' + escapeHtml(s.payment_status === 'Paid' ? 'PAID IN FULL' : s.payment_status.toUpperCase() + ' BALANCE ' + peso(Number(s.final_amount) - Number(s.amount_paid))) + '</p>' +
        (shop.invoice_note
            ? '<p class="rc-note">' + escapeHtml(shop.invoice_note) + '</p>' : '') +
        '<p class="rc-thanks">Thank you for your purchase</p>';

    showModal('receipt-modal');
}

function printReceipt() {
    document.body.classList.add('printing-receipt');
    window.print();
    setTimeout(function () { document.body.classList.remove('printing-receipt'); }, 400);
}

// Make a delivery: filled in beside the order, held as pendingDelivery on
// this screen, and posted by handleCheckout once a sale id comes back.
function todayIso() {
    // local date, not the UTC slice: Manila is a different day for eight hours
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

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
    fields.contactPhone.value = account && account.phone ? account.phone : '';
    fields.address.value = account && account.address ? account.address : '';
}

function openDeliveryForm() {
    const fields = deliveryFormFields();
    if (!fields) return;

    if (pendingDelivery) {
        fields.contactName.value = pendingDelivery.contactName;
        fields.contactPhone.value = pendingDelivery.contactPhone;
        fields.address.value = pendingDelivery.address;
        fields.bookedDate.value = pendingDelivery.bookedDate;
        fields.scheduledDate.value = pendingDelivery.scheduledDate;
        fields.remarks.value = pendingDelivery.remarks;
    } else {
        fields.bookedDate.value = todayIso();
        fields.scheduledDate.value = '';
        fields.remarks.value = '';
        fillDeliveryFromCustomer();
    }

    const drop = document.getElementById('delivery-drop');
    if (drop) drop.hidden = !pendingDelivery;

    const sub = document.getElementById('delivery-modal-sub');
    if (sub) {
        sub.textContent = cart.length === 0
            ? 'Add items to the order first'
            : 'Booked when you complete this sale';
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
    const contactPhone = fields.contactPhone.value.trim();
    const address = fields.address.value.trim();
    const bookedDate = fields.bookedDate.value;
    const scheduledDate = fields.scheduledDate.value;

    if (contactName === '') { complain('A delivery needs somebody to ask for at the gate.'); fields.contactName.focus(); return; }
    if (contactPhone === '') { complain('A driver who cannot ring ahead is a driver who comes back with the goods.'); fields.contactPhone.focus(); return; }
    if (address === '') { complain('A delivery needs somewhere to go.'); fields.address.focus(); return; }
    if (!bookedDate) { complain('Say which day this order was taken.'); fields.bookedDate.focus(); return; }

    // a slot in the past is almost always a typing slip in the year or month
    if (scheduledDate && new Date(scheduledDate).getTime() < Date.now() - 60000) {
        complain('That slot has already passed. Check the date and time before attaching it.');
        fields.scheduledDate.focus();
        return;
    }

    pendingDelivery = {
        contactName: contactName,
        contactPhone: contactPhone,
        address: address,
        bookedDate: bookedDate,
        scheduledDate: scheduledDate,
        remarks: fields.remarks.value.trim(),
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
            ' &middot; ' + escapeHtml(d.contactPhone) + '</p>' +
        '<p class="delivery-attached-line">' + escapeHtml(d.address) + '</p>' +
        '<p class="delivery-attached-line delivery-attached-when">' +
            'Booked ' + escapeHtml(d.bookedDate) + ' &middot; ' +
            (d.scheduledDate
                ? 'for ' + escapeHtml(String(d.scheduledDate).replace('T', ' '))
                : 'no slot agreed yet') +
        '</p>';
}

// posted once the sale exists; a failure here does not undo the sale
async function bookAttachedDelivery(saleId) {
    if (!pendingDelivery) return true;

    const d = pendingDelivery;

    try {
        const response = await fetch('/api/deliveries', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                saleId: saleId,
                address: d.address,
                contactName: d.contactName,
                contactPhone: d.contactPhone,
                bookedDate: d.bookedDate,
                scheduledDate: d.scheduledDate || null,
                remarks: d.remarks || null
            })
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

        notifySuccess(result.message, 'Delivery booked');
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
        countPillId: 'cdel-count',
        idField: 'delivery_id',
        filters: { status: 'all' },

        gate: {
            title: 'No deliveries loaded',
            text: 'Search for a customer, an address or a sale number, or press Load Data to read them all.',
            button: 'Load Data'
        },

        load: () => getJson('/api/deliveries'),

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
// The remarks (a sentence, not a word) and the disposition (where the goods
// go) are both compulsory, and neither is preselected.
const MINIMUM_RETURN_REASON = 10;

function returnDisposition() {
    const picked = document.querySelector('input[name="disposition"]:checked');
    return picked ? picked.value : null;
}

function onDispositionChange() {
    const box = document.getElementById('disposition-verdict');
    const choice = document.getElementById('disposition-choice');
    if (!box) return;

    const where = returnDisposition();
    if (choice) choice.classList.remove('is-missing');

    if (where === 'Return to Stock') {
        box.className = 'disposition-verdict is-good';
        box.textContent = 'Stock goes up by this quantity, and the item can be sold again.';
    } else if (where === 'Write-Off') {
        box.className = 'disposition-verdict is-stop';
        box.textContent = 'The item never goes back on the shelf. A manager is told, and the ' +
            'write-off is recorded against this product with your remarks attached.';
    } else {
        box.className = 'disposition-verdict';
        box.textContent = '';
    }
}

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

    const where = returnDisposition();
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
        refundAmount: parseFloat(form.elements.refundAmount.value) || 0,
        disposition: where
    };

    if (reason.length < MINIMUM_RETURN_REASON) {
        notifyWarning('Say what happened, in a sentence. A write-off queried three months from ' +
            'now has to be explainable from this line alone.', 'The remarks are required');
        const field = document.getElementById('return-reason');
        if (field) field.focus();
        return;
    }

    if (!where) {
        notifyWarning('Say whether these goods go back on the shelf or come off stock. ' +
            'Nothing is chosen for you, because the wrong answer here loses stock.',
            'Where do the goods go?');
        const choice = document.getElementById('disposition-choice');
        if (choice) {
            choice.classList.add('is-missing');
            choice.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
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

    // writing stock off is not reversible from here, so it is read back first
    if (where === 'Write-Off') {
        const name = refundProduct ? refundProduct.product_name : 'this product';

        const yes = await askDanger(
            data.quantity + ' x ' + name + ' will be written off.',
            {
                title: 'Write these goods off?',
                eyebrow: 'Returns',
                confirmLabel: 'Write it off',
                detail: [
                    'They do not go back on the shelf and cannot be sold.',
                    'A manager is notified, with your remarks attached.',
                    'Correcting this afterwards means a stock adjustment, not an undo.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await fetch('/api/returns', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(
            where === 'Return to Stock'
                ? 'The goods are back on the shelf and the manager has been notified.'
                : 'The goods are written off and the manager has been notified.',
            'Refund issued');

        form.reset();
        // form.reset() knows nothing about the hidden id, the strip or the suggested figure
        clearRefundProduct();
        refundAmountSuggested = null;
        onDispositionChange();
        onReturnReasonInput();
        catalogLoaded = false;
        await loadRefunds();
    } catch (error) {
        notifyOffline();
    }
}

// where the goods went, as a badge
function dispositionBadge(row) {
    const where = row.disposition || (row.restocked ? 'Return to Stock' : 'Write-Off');
    return where === 'Return to Stock'
        ? '<span class="badge badge-success">Back on shelf</span>'
        : '<span class="badge badge-danger">Written off</span>';
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
        countPillId: 'refund-count',
        idField: 'return_id',
        filters: { disposition: 'all' },

        gate: {
            title: 'No refunds loaded',
            text: 'Search for a product, or press Load Data to read the refunds on record.',
            button: 'Load Data'
        },

        // damage reports from the stockroom are a clerk's business; this is refunds
        load: async () => {
            const all = await getJson('/api/returns');
            return all.filter((r) => r.report_type === 'Refunded');
        },

        match: (row, query) => prefixMatch([
            row.product_name, row.reason, row.status, row.return_id, '#' + row.return_id
        ], query),

        filter: (row, filters) => {
            if (filters.disposition === 'all') return true;
            const where = row.disposition || (row.restocked ? 'Return to Stock' : 'Write-Off');
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
        '</div>' +
        '<p class="detail-note"><strong>Remarks</strong></p>' +
        '<p class="detail-note">' + escapeHtml(r.reason || 'No reason was recorded.') + '</p>';

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
        countPillId: 'csales-count',
        idField: 'sale_id',
        filters: { scope: 'Mine', method: 'all', status: 'all' },

        gate: {
            title: 'No sales loaded',
            text: 'Search for a customer or a receipt number, or press Load Data to read the sales on record.',
            button: 'Load Data'
        },

        load: async () => {
            cashierSales = await getJson('/api/sales');
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

    grid.innerHTML = '<div class="kpi-card"><span class="kpi-label">Loading</span><span class="kpi-value">...</span></div>';

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
        countPillId: 'summary-count',
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
            dailySummary = await getJson('/api/cashier/summary?staffId=' + user.staff_id);
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
        list.innerHTML = rows.length === 0
            ? '<p class="detail-empty">Nothing was refunded today.</p>'
            : '<div class="refund-lines">' + rows.map((r) =>
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

    showModal('refunds-today-modal');
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
    if (!due) return '<span class="muted">Nothing owed</span>';

    const left = creditDaysLeft(row);
    const date = due.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric' });
    const tone = left < 0 ? 'badge-danger' : left <= 7 ? 'badge-warning' : 'badge-neutral';
    const word = left < 0 ? (-left) + (left === -1 ? ' day' : ' days') + ' overdue'
        : left === 0 ? 'due today'
        : 'due in ' + left + (left === 1 ? ' day' : ' days');

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
        countPillId: 'customers-count',
        idField: 'customer_id',
        filters: { due: 'all' },

        gate: {
            title: 'No customers loaded',
            text: 'Search for a customer, or press Load Data to read every credit account.',
            button: 'Load Data'
        },

        load: () => getJson('/api/credit/customers'),

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

async function openCustomerCredit(customerId) {
    try {
        const data = await getJson('/api/customers/' + customerId + '/history');
        openCustomer = data;

        const c = data.credit;
        const owed = Number(c.current_credit) || 0;

        document.getElementById('customer-name').textContent = c.customer_name;
        document.getElementById('customer-sub').textContent =
            (c.phone || 'No phone on file') + ' · ' + (CASH_STANDING_WORD[c.standing] || c.standing);
        document.getElementById('customer-avatar').textContent = initialsOf(c.customer_name);

        document.getElementById('customer-facts').innerHTML =
            detailField('Credit Limit', peso(c.credit_limit)) +
            detailField('Currently Owed', '<span class="' + (owed > 0 ? 'cell-due' : '') + '">' +
                peso(owed) + '</span>') +
            detailField('Can Take Today', c.standing === 'Hold'
                ? '<span class="cell-due">Nothing, on hold</span>'
                : peso(c.available_credit)) +
            detailField('Due Date', creditDueCell(c)) +
            detailField('Standing', '<span class="badge ' +
                (CASH_STANDING_TONE[c.standing] || 'badge-neutral') + '">' +
                escapeHtml(CASH_STANDING_WORD[c.standing] || c.standing) + '</span>') +
            detailField('Why', escapeHtml(c.standing_reason || '')) +
            detailField('Open Sales', String(c.open_sales)) +
            detailField('Lifetime Purchases', peso(c.total_purchase)) +
            (c.credit_notes
                ? detailField('Manager Note', escapeHtml(c.credit_notes))
                : '');

        renderCustomerHistory(data);
        showModal('customer-modal');
    } catch (error) {
        notifyError('That customer could not be opened.', 'Nothing to show');
    }
}

// purchases beside payments
function renderCustomerHistory(data) {
    const box = document.getElementById('customer-history');
    if (!box) return;

    const purchases = data.purchases.length === 0
        ? '<p class="detail-empty">Nothing bought yet.</p>'
        : detailTable(['Date', 'Sale', 'Amount', 'Owed'],
            data.purchases.slice(0, 12).map((p) => [
                escapeHtml(String(p.sale_date).slice(0, 10)),
                '#' + p.sale_id + ' <span class="muted">' + escapeHtml(p.payment_method) + '</span>',
                peso(p.final_amount),
                Number(p.balance_due) > 0
                    ? '<span class="cell-due">' + peso(p.balance_due) + '</span>'
                    : '<span class="muted">Paid</span>'
            ]), [2, 3]);

    const payments = data.payments.length === 0
        ? '<p class="detail-empty">No payments recorded.</p>'
        : detailTable(['Date', 'Amount', 'How'],
            data.payments.slice(0, 12).map((p) => [
                escapeHtml(String(p.payment_date).slice(0, 10)),
                peso(p.amount),
                escapeHtml(p.payment_method)
            ]), [1]);

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
                    ? '<span class="cell-due">' + peso(data.credit.current_credit) + ' owed</span>'
                    : 'Nothing owed') +
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
        const response = await fetch('/api/credit/requests', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                customerId: c.customer_id,
                requestedLimit: Number(asked),
                reason: String(reason).trim()
            })
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
        buildRefundPanel();
        buildSummaryPanel();

        // offered only to a cashier holding a key to a connected system
        configureConnectedSystems({ showPanel: (panelId, title) => showCashierPanel(panelId, title) });
        buildConnectedSystemsPanel();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showCashierPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showCashierHome() });

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
    });
}
