// cashier.js  --  CASHIER
// Loaded by: cashier-dashboard.html
// ------------------------------------------------------------------------
// ==========================================
// CASHIER MODULE
// ==========================================
let catalog = [];
let catalogLoaded = false;
let catalogMode = 'idle';     // 'idle' keeps the grid clean, 'all' shows everything
let cart = [];
let cashierSales = [];
let salesScope = 'Mine';
let lastReceipt = null;

// EIGHT ROWS
//
// Every table on this screen pages at eight. The number is not arbitrary: the
// register runs on the shop's counter machine, and eight rows is what fits
// above the fold there without the panel pushing the order summary off the
// side. A table that grows with the data turns the browser scrollbar into the
// only way back to the top of it.
const CASHIER_ROWS_PER_PAGE = 8;

// The refunds log pages at twelve. It is read back through rather than worked
// down, so the shorter page that suits the other tables only makes it longer.
const REFUND_ROWS_PER_PAGE = 12;

// The customer book, read once and searched in memory. A dropdown of every
// customer was the wrong control for a counter; the list behind the typing
// box is the same data doing a more useful job.
let customerDirectory = [];
let customerDirectoryLoaded = false;
let suggestHighlight = -1;

// A delivery filled in beside the order and written the moment the sale
// exists. Null until the cashier makes one.
let pendingDelivery = null;

// today's figures, kept so the refund card can open without asking again
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

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// the sidebar entry: opens a clean register and stays highlighted
function showRegister(event) {
    showCashierPanel('panel-pos', 'Point of Sale', event);

    const search = document.getElementById('catalog-search');
    if (search) search.value = '';

    catalogMode = 'idle';
    renderCatalogEmpty();
    renderCart();
}

// the logo: same screen, but it is not a menu choice, so nothing stays lit
function showCashierHome(event) {
    showRegister(event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));
}

// Tracking only, and deliberately empty until it is asked for. Reading every
// delivery in the shop to answer a question about one of them is a query
// nobody wanted; typing into the search box or pressing Load Data is the ask.
function showCashierDeliveries(event) {
    showCashierPanel('panel-delivery', 'Delivery Tracking', event);
}

function showRefunds(event) {
    showCashierPanel('panel-refund', 'Refunds', event);
    loadCatalogOptions();
    dataPanelOpen('cash-refunds');
}

function showCustomers(event) { showCashierPanel('panel-customers', 'Customers & Credit', event); }

function showSalesReport(event) {
    showCashierPanel('panel-salesreport', 'Sales Report', event);
    dataPanelOpen('cash-sales');
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
            <p>Nothing matches <kbd>${escapeHtml(keyword)}</kbd>. Archived products never appear here.</p>
            <button type="button" class="btn btn-accent" onclick="loadCatalogAll(event)">View All Products</button>
        </div>`;
}

function renderCatalog(rows, keyword) {
    const grid = catalogGrid();
    if (!grid) return;

    if (rows.length === 0) { renderCatalogNoMatch(keyword || ''); return; }

    // ==========================================
    // WHAT A CARD AT THE TILL SAYS
    //
    // Not the stock count. A running figure on every card is a number the
    // cashier cannot act on: they are not ordering stock, they are serving the
    // person in front of them, and the count only invites arithmetic about the
    // stockroom over a customer's head. It also puts the shop's inventory
    // position on the one screen that faces the shop floor. The clerk's and
    // the manager's screens are where that figure belongs and it is still on
    // both of them, unchanged.
    //
    // The one stock fact a card does have to carry is whether this can be sold
    // at all, because that changes what the cashier does next. A card greyed
    // out and unclickable with no reason given is a card somebody presses four
    // times and then reports as broken, so a product with none left says so in
    // words on the card itself rather than in a tooltip nobody hovers over at
    // a counter. Every other card says nothing about stock.
    // ==========================================
    setPill('catalog-count', rows.length + (rows.length === 1 ? ' product' : ' products'));
    grid.innerHTML = '<div class="product-grid">' + rows.map((p, i) => {
        const out = p.quantity_in_stock <= 0;
        return '<button type="button" class="product-card row-reveal' + (out ? ' is-out' : '') + '"' +
            ' style="animation-delay:' + Math.min(i, 12) * 26 + 'ms"' +
            (out ? ' disabled' : ' onclick="addToCart(' + p.product_id + ')"') + '>' +
            '<span class="prod-name">' + escapeHtml(p.product_name) + '</span>' +
            '<span class="prod-meta">' + escapeHtml(p.category_name || 'Uncategorised') + '</span>' +
            '<span class="prod-price">' + peso(p.price) + '</span>' +
            (out ? '<span class="prod-stock stock-out">Out of stock</span>' : '') +
            '</button>';
    }).join('') + '</div>';
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
    renderCatalog(catalog);
    loadCustomerOptions();
}

async function filterCatalog(keyword) {
    const text = keyword.trim().toLowerCase();

    if (text === '') {
        if (catalogMode === 'all') renderCatalog(catalog);
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
        loadCustomerOptions();
    }

    renderCatalog(catalog.filter((p) =>
        (p.product_name + ' ' + (p.category_name || '') + ' ' + (p.brand_name || ''))
            .toLowerCase().indexOf(text) !== -1
    ), keyword.trim());
}

// ==========================================
// THE PRODUCT ON A REFUND, TYPED RATHER THAN PICKED
//
// This was a <select> holding the whole catalogue. Finding one item in six
// hundred by scrolling, with a customer standing at the counter holding the
// thing they want to return, is slower than typing three letters of its name.
//
// It shares its shape with the customer box deliberately: same suggestion
// list, same arrow keys, same clear button, so a cashier who has learned one
// has learned the other. What it does not share is what happens to text that
// matches nothing. A customer typed and not found is a walk-in, which is a
// real answer. A product typed and not found is not a product, and a refund
// with no product has nowhere to move the stock to. So this field carries a
// second job: making "nothing chosen yet" impossible to read as "chosen".
// Until a product is picked there is no strip under the box, the strip is the
// only thing that says a choice was made, and the form refuses to send.
//
// The strip also carries the price, and picking a product fills the refund
// amount in from it. That is the practical reason to abandon the dropdown:
// the amount stops being a figure somebody types from memory.
// ==========================================
let refundProduct = null;
let refundSuggestHighlight = -1;

// What the amount box last had put into it by this code. Anything else in
// there was typed by a person, and a person's figure is never overwritten.
let refundAmountSuggested = null;

function refundProductBox() { return document.getElementById('refund-product'); }

function refundProductIdBox() {
    const form = document.getElementById('refund-form');
    return form ? form.elements.productId : null;
}

// Kept under its old name because showRefunds calls it: the refund screen
// still needs the catalogue in memory, it just no longer builds options out
// of it.
async function loadCatalogOptions() {
    if (!document.getElementById('refund-product')) return;
    await ensureCatalogLoaded(false);
}

async function onRefundProductInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('refund-product-clear');

    if (clear) clear.hidden = text === '';

    // the catalogue is fetched the first time somebody types, not on page load
    if (!catalogLoaded && text !== '') await ensureCatalogLoaded(false);

    // Typing after a choice unmakes the choice. Leaving the old product
    // selected while different text sits in the box is how a refund gets
    // filed against something nobody chose.
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

    // A product already chosen is not a search in progress.
    if (refundProduct && String(refundProduct.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    // Name matches first and matches that start with what was typed above the
    // ones that merely contain it, because the first three letters of a
    // product name is how anybody actually looks for one.
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
        // Brand and category are what separate two products whose names read
        // almost the same on a shelf label.
        // Brand and category and nothing else. What is on the shelf is not the
        // till's business here either: a refund is decided by what the customer
        // brought back, not by what is left in the stockroom.
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

// One place that decides what is chosen, so the hidden field, the strip, the
// verdict line and the suggested amount can never disagree about it.
function setRefundProduct(product) {
    refundProduct = product || null;

    const idBox = refundProductIdBox();
    if (idBox) idBox.value = product ? String(product.product_id) : '';

    renderRefundProductStrip();
    renderRefundProductVerdict();
    suggestRefundAmount();
}

// The strip is the whole answer to "have I chosen something yet". It borrows
// the credit strip's shape on purpose: same left rule, same label-and-figure
// rows, so it reads as the same kind of statement.
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

// WHERE THE FIGURE COMES FROM
//
// The amount used to be typed from memory, which is where a 4,500 refund on
// a 450 hammer comes from. Choosing the product and saying how many fills it
// in instead. It stays editable, because what a customer paid and what the
// shelf label says today are not always the same figure, and the note under
// the box says which of the two is currently in it.
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

    const quantity = parseInt(form.elements.quantity.value, 10) || 0;
    const suggested = Math.round(Number(refundProduct.price) * Math.max(quantity, 0) * 100) / 100;

    const current = parseFloat(field.value);
    const untouched = !field.value || current === 0 || current === refundAmountSuggested;

    // A figure a person typed is never overwritten, however wrong it looks.
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

    // Typing the suggested figure back in by hand is still the suggested
    // figure, so the note should not accuse them of overriding it.
    if (typed !== refundAmountSuggested) refundAmountSuggested = null;
    suggestRefundAmount();
}

// ==========================================
// THE CUSTOMER, TYPED RATHER THAN PICKED
//
// A dropdown of every customer in the book is the wrong control for a
// counter. The commonest case is somebody who is not in the book at all, and
// the second commonest is a regular whose name the cashier already knows how
// to spell, so scrolling a list is the slowest way to answer either. It is a
// box you type into now, and the book sits behind it as suggestions.
//
// Three outcomes, and the screen says which one is in force before the sale
// is completed rather than after:
//
//   A name picked from the suggestions is an account. The sale is booked
//   against it and the credit strip appears, because a credit decision made
//   after the total is rung up is made too late.
//
//   A name typed that matches nobody is a walk-in with a name. It goes on the
//   sale so the receipt can be reprinted next week for the person who bought
//   it, and the cashier is asked once, at checkout, whether to open an
//   account for them.
//
//   Nothing typed is a walk-in, as before.
// ==========================================
async function loadCustomerDirectory(force) {
    if (customerDirectoryLoaded && !force) return true;

    try {
        customerDirectory = await getJson('/api/records/customer');
        customerDirectoryLoaded = true;
        return true;
    } catch (error) {
        // Not fatal. A cash sale to a walk-in needs none of this, and
        // refusing to sell because the customer list did not load would stop
        // the queue over something that does not matter to it.
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

// Trimmed at both ends and collapsed in the middle. "Maria  Santos" and
// "Maria Santos" are the same customer, and a stray double space is how the
// same person ends up in the book twice.
function typedCustomerName() {
    const box = customerNameBox();
    return box ? box.value.trim().replace(/\s+/g, ' ') : '';
}

// The account whose name is in the box, if the text is still exactly one of
// them. Typing on after picking somebody is how a sale gets booked against
// the wrong account, so the id is dropped the moment the text stops matching.
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

    // the list is fetched the first time somebody types, not on page load
    if (!customerDirectoryLoaded && text !== '') await loadCustomerDirectory(false);

    const exact = customerMatchingTypedName();

    // An id that no longer agrees with the text is worse than no id: it books
    // the sale against somebody whose name is not on the screen.
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

    // Best first: a name that starts with what was typed is more likely to be
    // the one meant than a name that merely contains it. Six is what fits
    // under the box without covering the payment fields.
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

        // Why this suggestion is worth taking: a regular is a regular, and an
        // account that already owes money is the one fact a cashier wants
        // before the sale rather than after it.
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

// Arrow keys and Enter, because a cashier's hands are on the keyboard and
// reaching for the mouse to take the first suggestion is the slow path.
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

    // A delivery already filled in for the previous customer should follow
    // the change rather than quietly keep the old name on the manifest.
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

// One line under the box saying which of the three outcomes is in force. It
// is there so the answer arrives before the sale is completed rather than as
// a refusal afterwards.
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

// Kept under the old name because the boot sequence and the catalog loader
// both call it, and there is nothing gained by making them say something new.
async function loadCustomerOptions() {
    await loadCustomerDirectory(false);
}

// ---------- the cart ----------
function addToCart(productId) {
    const p = catalog.find((x) => x.product_id === productId);
    if (!p) return;

    const line = cart.find((l) => l.product_id === productId);
    const onHand = Number(p.quantity_in_stock);

    // THE BLOCK STILL HOLDS, IT JUST STOPS QUOTING THE STOCKROOM
    //
    // The cart is capped at what exists exactly as before. What changed is
    // what the cashier is told when they reach the cap: that the order already
    // has everything available, rather than a figure off the inventory. The
    // number is not lost — the line in the cart is showing it, because at the
    // moment the cap is hit the quantity on that line is what is on the shelf.
    if (line) {
        if (line.quantity + 1 > onHand) {
            notifyWarning('The order already has every ' + escapeHtml(p.product_name) +
                ' we can sell today. Take the rest off a delivery or a new order.',
                'That is all of it');
            return;
        }
        line.quantity += 1;
    } else {
        if (onHand < 1) {
            notifyWarning(p.product_name + ' is out of stock, so it cannot go on this sale.',
                'Nothing to sell');
            return;
        }
        cart.push({ product_id: p.product_id, name: p.product_name, price: Number(p.price),
                    unit: p.unit_name || '', quantity: 1, on_hand: onHand });
    }
    renderCart();
}

function changeCartQty(productId, delta) {
    const line = cart.find((l) => l.product_id === productId);
    if (!line) return;

    const next = line.quantity + delta;
    if (next <= 0) { removeCartLine(productId); return; }
    if (next > line.on_hand) {
        notifyWarning('The order already has every ' + line.name + ' we can sell today. ' +
            'Take the rest off a delivery or a new order.', 'That is all of it');
        return;
    }
    line.quantity = next;
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

    // Clearing the order clears the whole order. A delivery left attached to
    // an emptied cart is a booking waiting to be made for goods nobody chose.
    pendingDelivery = null;
    renderDeliveryAttached();
    await clearCustomer();
    renderCart();
}

// NO DISCOUNT BOX
//
// A free-text discount field beside the total is an amount anybody at the
// counter can take off any sale, with nothing recorded about why, and it
// prints on the receipt as though it were policy. Prices are what the shop
// charges; a genuine markdown belongs on the product, where a manager sets it
// once and every till charges the same figure.
//
// discount stays in these totals as a fixed zero rather than being torn out.
// The sales table, the receipt and every report still carry the column, older
// sales still hold real figures in it, and a manager screen that offers
// discounts later has the arithmetic already in place.
function cartTotals() {
    const form = document.getElementById('checkout-form');
    const gross = cart.reduce((sum, l) => sum + (l.price * l.quantity), 0);
    const discount = 0;
    const due = Math.max(gross - discount, 0);
    const tendered = form ? (parseFloat(form.elements.amountPaid.value) || 0) : 0;
    const method = form ? form.elements.paymentMethod.value : 'Cash';

    const onCredit = method === 'Credit';
    const onAccount = onCredit || method === 'COD';

    // Half now and half on the book. Capped at the bill, because there is no
    // change on a sale that is going on the book: anything over the total is
    // a typing slip, not a tip.
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
            '<span class="cart-unit">' + peso(l.price) + ' each</span>' +
            '</div>' +
            '<div class="cart-qty">' +
            '<button type="button" class="qty-btn" onclick="changeCartQty(' + l.product_id + ', -1)" aria-label="Less">&minus;</button>' +
            '<span class="qty-value">' + l.quantity + '</span>' +
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

    // A tender box and a down payment box on screen at once are two places to
    // type the same money into, so only one of them is ever shown.
    if (tender) tender.style.display = onAccount ? 'none' : 'block';
    if (down) down.style.display = onCredit ? 'block' : 'none';

    renderCart();
}

// ==========================================
// CREDIT AT THE COUNTER
//
// A cashier finding out about a credit limit when the till refuses the sale
// is a cashier finding out too late, with a customer watching. So the account
// is read when the customer is picked, and what it says is printed above the
// payment fields rather than raised as an error after the fact.
// ==========================================
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
        (c.credit_notes
            ? '<p class="credit-strip-note">' + escapeHtml(c.credit_notes) + '</p>' : '');
}

// What will happen if this sale is completed as it stands, in words, before
// the button is pressed rather than as a refusal after it.
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

// the quick-fill buttons under the down payment field
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

    // A settled-later sale needs an account, not a name. "Cruz" written on a
    // receipt is not something a collection can be chased against, so the
    // cashier is pointed at the account rather than allowed to proceed.
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

    // OPENING AN ACCOUNT, ASKED ONCE
    //
    // A name typed at the counter is either a one-off or a regular, and only
    // the person at the counter knows which. Creating an account for every
    // typed name fills the customer book with duplicates and typos; creating
    // none of them means the regular is still being retyped in six months.
    // So it is a question, asked at the moment the answer is known, and No is
    // a real answer: the name still goes on the sale either way.
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

    // A part-paid credit sale leaves money on the customer's account, and the
    // person pressing the button should have said that out loud before the
    // receipt prints. The server checks the limit and the standing again
    // whatever is answered here; this is so nobody is surprised by it.
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
        // Kept only when there is no account, because a named customer's name
        // already lives in the customers table and a second copy on the sale
        // is a copy that can drift.
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

        // The delivery is written against the sale that now exists. It is
        // done before the till is cleared, so that a delivery that fails to
        // book is reported while the details are still on screen rather than
        // discovered by a customer waiting at home.
        const booked = await bookAttachedDelivery(result.saleId);

        cart = [];
        form.elements.amountPaid.value = '0';
        if (form.elements.downPayment) form.elements.downPayment.value = '0';

        if (booked) { pendingDelivery = null; renderDeliveryAttached(); }

        // the account has moved, so the strip above the form is now out of date
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

// The counter's half of opening an account: the record, and nothing else. The
// server sets the limit to zero, so this cannot be used to lend money to
// anybody, which is why it is safe to put behind a Yes/No at the till.
//
// Returns the customer id on success, null when the cashier's answer produced
// no account, and false when the server refused, which stops the sale rather
// than quietly ringing it up as a walk-in.
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

    // Cancelling the phone question cancels opening the account, not the
    // sale: the name still goes on the receipt as a walk-in.
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
// ==========================================
// THE INVOICE
//
// Not "Official Receipt" any more. Under RR 7-2024 the primary document for a
// sale of goods is an Invoice, and an Official Receipt stopped being one on
// 1 July 2024. The OR- numbering stays, because the number is this system's
// own reference and renumbering would only break every record already filed
// under it.
//
// Three things had to change beyond the word. The shop's name was written
// into this file, which meant every installation printed the same shop. There
// was no TIN. And there was no tax breakdown at all, which is the part a BIR
// invoice exists to carry.
//
// THE VAT
//
// Philippine posted prices already include VAT. It is not added to the total,
// it is extracted from it, so a 213.50 sale is 190.62 of goods and 22.88 of
// VAT rather than 213.50 plus 25.62. The split is read off the sale rather
// than recalculated here, because the sale recorded what was actually charged
// on the day, and an invoice reprinted next year has to still say that.
//
// A non-VAT shop prints no VAT block. It charges no VAT, so a block of
// zeroes would be claiming the sale was taxed at nothing rather than that
// the shop is not VAT-registered, and those are different claims.
// ==========================================
let storeSettings = null;

async function loadStoreSettings(force) {
    if (storeSettings && !force) return storeSettings;

    try {
        storeSettings = await getJson('/api/store-settings');
    } catch (error) {
        // Not fatal, and not a reason to refuse to print. A placeholder header
        // on an invoice is visibly wrong, which is better than no invoice.
        storeSettings = null;
    }

    return storeSettings;
}

// The tax block at the foot of the invoice, in the shape the shop's own
// registration calls for.
function receiptTaxBlock(sale) {
    const registration = sale.tax_registration || 'VAT';
    const rate = Number(sale.vat_rate) || 0;

    if (registration !== 'VAT') {
        // Percentage tax is paid by the shop out of its own sales; it is not
        // charged to this customer and no figure for it belongs on their
        // invoice. What belongs is the base the shop will pay it on.
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

    // The header comes from the settings row so that one installation is one
    // shop. The label in front of the TIN is the shop's actual claim about
    // itself and has to agree with the tax block below.
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
            it.quantity + ' ' + escapeHtml(it.unit_name || '') + ' x ' + peso(it.unit_price) + '</span></td>' +
            '<td class="rc-amt">' + peso(it.subtotal) + '</td></tr>').join('') +
        '</tbody></table>' +
        '<div class="rc-rule"></div>' +
        '<div class="rc-totals">' +
        '<div><span>Subtotal</span><span>' + peso(s.total_amount) + '</span></div>' +
        // Only when there was one. Sales rung up before the discount box was
        // taken off the till still carry real figures here, and a receipt
        // that prints "Discount 0.00" on every sale trains everybody to stop
        // reading the line that matters.
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

// ==========================================
// MAKE A DELIVERY
//
// Booking a delivery used to be a second screen with a dropdown of every sale
// that had none yet. That meant finishing the sale, walking to another page,
// and finding the right receipt number again from a list of sixty, with the
// customer already gone. The delivery belongs to the order, so it is filled
// in beside the order and written the moment the sale exists.
//
// Nothing is sent while the cart is still open: there is no sale to attach a
// delivery to until the sale is rung up. What the form produces is a pending
// delivery held on this screen, shown above the buttons so it cannot be
// forgotten, and posted by handleCheckout the instant a sale id comes back.
// ==========================================
function todayIso() {
    // Local date, not the UTC slice off an ISO string. In Manila those are a
    // different day for eight hours out of every twenty-four, which would
    // book an evening delivery under tomorrow.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function deliveryFormFields() {
    const form = document.getElementById('make-delivery-form');
    return form ? form.elements : null;
}

// What the customer box and the customer's record already know, so the
// cashier is not retyping a name that is on the screen above.
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

    // A slot already in the past is almost always a typing slip in the year
    // or the month, and it is cheaper to query it here than to leave a driver
    // with a manifest dated last March.
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

// CANCEL DELIVERY
//
// The way back to the transaction, and the only one besides attaching. The
// form no longer closes on a stray click behind it or on Escape, because both
// of those threw away an address and a phone number that existed nowhere else
// and gave nothing back.
//
// It leaves whatever was already attached alone. Opening the form to change a
// booked slot and thinking better of it should not cancel the delivery: that
// is what Remove Delivery is for, and it only appears when there is something
// to remove.
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

// The strip above the buttons. A delivery the cashier cannot see is a
// delivery the cashier forgets they attached.
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

// Posted once the sale exists. A failure here does not undo the sale, which
// has already taken money and moved stock, so it is reported as the thing it
// is: goods sold, delivery not booked, book it from the customer's record.
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

// ==========================================
// DELIVERY TRACKING
//
// Read only, and empty until asked. Booking happens at the till now, so the
// only question this screen answers is "where is the one I booked", and
// reading every delivery in the shop to answer it is a query nobody wanted.
// Typing in the search box or pressing Load Data is the ask; Clear puts it
// back to empty.
// ==========================================
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

        match: (row, query) =>
            (String(row.customer_name || '') + ' ' +
             String(row.delivery_address || '') + ' ' +
             String(row.status || '') + ' ' +
             '#' + row.sale_id + ' #' + row.delivery_id).toLowerCase().indexOf(query) !== -1,

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

// "2026-09-05 14:30:00" is a database value, not a delivery slot a person
// reads. Midnight is what a date-only schedule became when the column was
// widened, so it is shown as a plain day rather than as "12:00 am".
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
// ==========================================
// RETURNS AND REFUNDS
//
// Two things are compulsory here and neither used to be.
//
// THE REMARKS. Not a word: a sentence. "Damaged" explains nothing three
// months later when somebody queries a write-off, and a stock count that
// disagrees with the system by two bags of cement is settled by reading
// these lines. The counter below the box says so while it is being typed
// rather than after the form is submitted.
//
// THE DISPOSITION. Where the goods actually go. It was a dropdown called
// "Goods Resalable" with a default already chosen, which meant it was
// answered by not being read, and a return filed with the wrong answer left
// the item unaccounted for: not on the shelf, not written off, still in a
// box behind the counter. Neither option is preselected now, on purpose.
// ==========================================
const MINIMUM_RETURN_REASON = 10;

function returnDisposition() {
    const picked = document.querySelector('input[name="disposition"]:checked');
    return picked ? picked.value : null;
}

// what this choice does to the stock count, said before the form is sent
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

// Counts up to the minimum rather than down from a maximum: the question is
// "have you said enough yet", not "how much room is left".
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

    // The product box is free text, so the check is on what was actually
    // chosen rather than on what is typed in it. A name half-typed and never
    // picked from the list is not a product.
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
        quantity: parseInt(form.elements.quantity.value, 10),
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

    // Writing stock off is not reversible from this screen, and the quantity
    // is the figure that gets typed wrong, so it is read back before it goes.
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
        // form.reset() puts the visible boxes back but knows nothing about the
        // hidden id, the strip or the suggested figure, and a stale strip over
        // an empty form is the next refund filed against the last one's product.
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

// Where the goods went, shown as a badge rather than a Yes/No under a column
// headed "Restocked", which reads as a question about the record instead of
// an answer about the goods.
function dispositionBadge(row) {
    const where = row.disposition || (row.restocked ? 'Return to Stock' : 'Write-Off');
    return where === 'Return to Stock'
        ? '<span class="badge badge-success">Back on shelf</span>'
        : '<span class="badge badge-danger">Written off</span>';
}

// ==========================================
// REFUNDS ISSUED
//
// Paged at eight like every other table here, and clearable, because the
// history under the form is context rather than the task: a cashier filing a
// refund wants the form, and the list is there to check the one they filed
// ten minutes ago.
// ==========================================
function buildRefundPanel() {
    createDataPanel({
        key: 'cash-refunds',
        tableId: 'refund-table',
        columns: 8,
        // The one table that pages at twelve rather than eight. It is a log
        // rather than a worklist: a cashier reading it is looking back through
        // what they filed today, and eight rows made that four pages.
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

        // Damage reports filed by the stockroom are a clerk's business. This
        // list is refunds, which is what this screen issues.
        load: async () => {
            const all = await getJson('/api/returns');
            return all.filter((r) => r.report_type === 'Refunded');
        },

        match: (row, query) =>
            (String(row.product_name || '') + ' ' +
             String(row.reason || '') + ' ' +
             String(row.status || '') + ' ' +
             '#' + row.return_id).toLowerCase().indexOf(query) !== -1,

        filter: (row, filters) => {
            if (filters.disposition === 'all') return true;
            const where = row.disposition || (row.restocked ? 'Return to Stock' : 'Write-Off');
            return where === filters.disposition;
        },

        // The whole row still opens the report, because that is the fast way
        // once you know it. The button is there because a row that only
        // responds to a click nobody told you about is a row nobody clicks.
        renderRow: (row, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 12) * 24 + 'ms" ' +
            'onclick="openRefundDetail(' + row.return_id + ')">' +
            '<td class="cell-id">#' + row.return_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(row.product_name) + '</td>' +
            '<td class="cell-num">' + row.quantity + ' ' + escapeHtml(row.unit_name || '') + '</td>' +
            '<td class="cell-num cell-due">' + peso(row.refund_amount) + '</td>' +
            '<td>' + dispositionBadge(row) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(row.return_date).slice(0, 10)) + '</td>' +
            '<td>' + statusBadge(row.status) + '</td>' +
            // Outlined, not filled. Twelve solid buttons down the right of a
            // table is a black column competing with the figures the table
            // exists to show; the button only has to be findable, and the
            // amounts are what should carry the weight.
            '<td class="cell-action">' +
                '<button type="button" class="btn btn-sm btn-ghost" ' +
                        'onclick="event.stopPropagation(); openRefundDetail(' + row.return_id + ')">' +
                    'View</button>' +
            '</td></tr>'
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

// kept under its old name: the refund form calls it after filing one
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
        detailField('Quantity', r.quantity + ' ' + escapeHtml(r.unit_name || '')) +
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

// ==========================================
// SALES REPORT
//
// Searchable, filterable, paged at eight, and clearable. "Mine" and "All" are
// a filter like the other two rather than a separate code path, so the search
// box and the dropdowns keep working whichever is chosen.
// ==========================================
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

        match: (row, query) =>
            (String(row.customer_name || '') + ' ' +
             String(row.payment_method || '') + ' ' +
             String(row.payment_status || '') + ' ' +
             String(row.transaction_status || '') + ' ' +
             row.sale_id + ' OR-' + String(row.sale_id).padStart(6, '0'))
                .toLowerCase().indexOf(query) !== -1,

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

// "Mine" is decided by staff id, not by matching a printed name. Two people
// can share a name; nobody shares an id.
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

// kept under its old name for the places that ask for a plain refresh
async function loadCashierSales() {
    const panel = getDataPanel('cash-sales');
    if (!panel) return;
    if (panel.state === 'closed') await panel.open();
    else await panel.refresh();
}

// ==========================================
// DAILY SUMMARY
//
// Today, and only today. A cashier reading this is standing in the shift it
// describes, so there is no day to choose and no picker to leave on the wrong
// date: every figure is bounded by this date at the server, which is what
// makes "gross sales" mean the shift rather than the year.
//
// Cash in drawer and change given are gone. Both were arithmetic on the same
// two columns the other cards already show, and a card that restates a figure
// is a card that competes with it for the reader's attention at exactly the
// moment they are counting money.
//
// Refunds opens. A total says money left the till; it does not say which item
// went back, and the item is the part that has to be accounted for.
// ==========================================
// The figures and the breakdown come from one call, so the panel is what
// fetches and the cards are drawn from what it got. Asking twice would let
// the four cards and the table below them disagree about the same minute.
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

    // The panel reports its own failure inside the table; the cards have to
    // say so themselves rather than sit on figures from an earlier minute.
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

        // A button rather than a card, because it opens. The count is on the
        // face so the card still answers the question without being pressed.
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

// The breakdown table, paged at eight like the rest. It reads from the
// summary already fetched rather than asking the server a second time.
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
            text: 'Press Refresh above to read today\'s takings.',
            button: 'Load Today'
        },

        load: async () => {
            const user = getCurrentUser();
            if (!user) return [];

            // Dropped first, so a failed read leaves no figures behind for
            // the cards to keep showing as though they were current.
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

// WHAT WENT BACK TODAY, ITEM BY ITEM
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

// ==========================================
// CUSTOMERS AND CREDIT
//
// The cashier's half of credit management. It changes nothing on its own: a
// cashier can read an account and ask a manager for more room, and that is
// the whole of it. Setting a limit is a manager's decision and the server
// refuses it here whatever this screen offers.
// ==========================================
const CASH_STANDING_TONE = { Good: 'badge-success', Watch: 'badge-warning', Hold: 'badge-danger' };
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
        filters: { standing: 'all' },

        gate: {
            title: 'No customers loaded',
            text: 'Search for a customer, or press Load Data to read every credit account.',
            button: 'Load Data'
        },

        load: () => getJson('/api/credit/customers'),

        match: (row, query) =>
            (row.customer_name + ' ' + (row.phone || '')).toLowerCase().indexOf(query) !== -1,

        filter: (row, filters) => filters.standing === 'all' || row.standing === filters.standing,

        renderRow: (row, index) => {
            const owed = Number(row.current_credit) || 0;
            const tone = CASH_STANDING_TONE[row.standing] || 'badge-neutral';

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openCustomerCredit(' + row.customer_id + ')">' +
                '<td class="cell-name">' + escapeHtml(row.customer_name) + '</td>' +
                '<td>' + escapeHtml(row.phone || 'Not set') + '</td>' +
                '<td class="cell-num">' + peso(row.credit_limit) + '</td>' +
                '<td class="cell-num' + (owed > 0 ? ' cell-due' : '') + '">' + peso(owed) + '</td>' +
                '<td class="cell-num">' + peso(row.available_credit) + '</td>' +
                '<td><span class="badge ' + tone + '">' +
                    escapeHtml(CASH_STANDING_WORD[row.standing] || row.standing) + '</span></td></tr>';
        }
    });
}

// Clear puts the table back to its closed state: the rows are forgotten and
// the gate returns. It is the counterpart to Load Data, and it exists because
// a credit table left open on a shared counter machine is somebody's balance
// on display to the next customer in the queue.
function clearCreditPanel() {
    const panel = getDataPanel('cash-credit');
    if (panel) panel.reset();

    const search = document.getElementById('customers-search');
    if (search) search.value = '';

    const standing = document.getElementById('customers-standing');
    if (standing) standing.value = 'all';
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
            detailField('Standing', '<span class="badge ' +
                (CASH_STANDING_TONE[c.standing] || 'badge-neutral') + '">' +
                escapeHtml(CASH_STANDING_WORD[c.standing] || c.standing) + '</span>') +
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

// Purchases beside payments. One says how good a customer they are, the other
// how good a payer, and neither answers the question on its own.
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

// The one thing a cashier can do about a limit: ask. It changes nothing until
// a manager decides it, which is the point: the queue moves on either way.
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
        // Every table on this screen is one of these, so they are all built
        // before anything is shown. Building a panel only draws its closed
        // state; none of them queries the database until it is asked to.
        buildCustomerPanel();
        buildDeliveryPanel();
        buildSalesPanel();
        buildRefundPanel();
        buildSummaryPanel();

        onReturnReasonInput();
        renderCustomerVerdict();
        renderRefundProductVerdict();
        renderDeliveryAttached();
        showCashierHome();
        loadCustomerDirectory(false);
        loadStoreSettings(false);
        loadNotifications();
    });

    // A click anywhere else closes the suggestion list. Without this it stays
    // open over the payment fields after the cashier has moved on.
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideCustomerSuggestions();
        hideRefundSuggestions();
    });
}
