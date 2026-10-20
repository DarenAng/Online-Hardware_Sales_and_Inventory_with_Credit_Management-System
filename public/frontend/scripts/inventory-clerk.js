// ============================================================
// inventory-clerk.js -- the Inventory Clerk dashboard
// Loaded by: inventory-dashboard.html
//
// What is in this file, from top to bottom:
//   - switching screens (showInventoryPanel and the show... functions)
//   - the material list and the low-stock banner
//   - stock adjustment: pick a material and a unit, see a preview, save
//   - adjustment history and reorder points
//   - returns and damage reports: inspect, return to stock or write off
//   - Make a Report: several items in one report, or goods missing from a delivery
//     (checked against its purchase order, here and from Stock Adjustment)
//   - the material archive
//   - popups: one material (with its selling sizes and delivery pack),
//     one adjustment, one return
//   - the page start-up code at the very bottom ("INVENTORY PAGE BOOT")
// (Purchase orders are in shared/purchase-orders.js.)
// ============================================================
let invProducts = [];
let invLoaded = false;

// what is chosen on the adjustment form; typed text that matches nothing is not a choice
let adjustMaterial = null;
let adjustSuggestHighlight = -1;

let invUnits = [];
let invUnitsLoaded = false;
let unitSuggestHighlight = -1;

function invBody() { return document.querySelector('#inv-table tbody'); }

function showInventoryPanel(panelId, title, event) {
    if (event) event.preventDefault();

    const allPanels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < allPanels.length; i++) {
        const panel = allPanels[i];
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    }
    // a screen opened from another (the order form, from Purchase Orders) lights its menu entry
    const opened = document.getElementById(panelId);
    const litId = (opened && opened.getAttribute('data-panel-of')) || panelId;
    // a link naming a view (Records: Suppliers, Products...) lights only for that view
    const view = opened ? opened.dataset.view : undefined;
    const panelLinks = document.querySelectorAll('[data-panel-link]');
    for (let i = 0; i < panelLinks.length; i++) {
        const link = panelLinks[i];
        const wanted = link.dataset.panelView;
        link.classList.toggle('active', link.dataset.panelLink === litId && (!wanted || wanted === view));
    }

    const heading = document.getElementById('inv-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// Opening a screen never unfolds the Inventory Management list: only the
// heading's caret does (shared/helpers.js sidebarHeading); the heading lights
// up on its own while a screen beneath it is the open one.

function showInventoryHome(event) {
    showInventoryPanel('panel-inventory', 'Inventory Management', event);

    // the material list keeps whatever it had loaded; the banner is one small query
    loadStockBanner();
}

// Opening a screen fills the dropdowns it needs and nothing else.
function showAdjust(event) {
    showInventoryPanel('panel-adjust', 'Stock Adjustment', event);

    // Reference is its own switch in Access Control
    const referenceButton = document.getElementById('adjust-reference');
    if (referenceButton) referenceButton.hidden = !holdsFeature('po-reference');

    // the "Needs attention" list is drawn from the same material list, so it waits for it
    if (invLoaded) renderAttentionList();
    else attentionMessage('Loading materials...');
    ensureInventoryLoaded(true).then(afterMaterialsLoaded);
    loadUnits(false);
    renderAdjustMaterialVerdict();
    renderAdjustPreview();
}

function showAdjustmentHistory(event) {
    showInventoryPanel('panel-adjust-log', 'Adjustment History', event);
}

function showReorder(event) { showInventoryPanel('panel-reorder', 'Reorder Point Settings', event); }
function showReturns(event) { showInventoryPanel('panel-returns', 'Returned Items', event); }
function showDamageReport(event) {
    showInventoryPanel('panel-report', 'Make a Report', event);
    renderReportMaterialVerdict();
    renderReportItems();
}
function showInventoryArchive(event) { showInventoryPanel('panel-archive', 'Archive', event); }

// ---------- the material list ----------
async function ensureInventoryLoaded(force) {
    if (invLoaded && !force) return true;
    try {
        invProducts = await apiGetProducts();
        invLoaded = true;
        return true;
    } catch (error) {
        invLoaded = false;
        return false;
    }
}

// The material list starts closed like every other table; typing into the
// search box is itself a request to load it.
function buildMaterialsPanel() {
    createDataPanel({
        key: 'clerk-materials',
        tableId: 'inv-table',
        columns: 6,
        pagerId: 'inv-pager',
        idField: 'product_id',
        filters: { status: 'all' },

        gate: {
            title: 'No materials loaded',
            text: 'Search above for one material, pick a stock status, or press Load Data ' +
                  'for the whole list. Archived materials never appear here.',
            button: 'Load Data'
        },

        load: async function () {
            invProducts = await apiGetProducts();
            invLoaded = true;
            return invProducts;
        },

        // this load replaces invProducts, so the Stock Adjustment list is redrawn from it
        onLoaded: function () {
            if (adjustScreenOpen()) afterMaterialsLoaded(true);
        },

        match: function (p, query) {
            return prefixMatch([
                p.product_name, p.category_name, p.supplier_name, p.stock_status
            ], query);
        },

        filter: function (p, filters) {
            return filters.status === 'all' || p.stock_status === filters.status;
        },

        // a product with no price yet (just added, waiting for the manager) is
        // always on the top row, whatever the search, the filter or the page
        sort: function (rows) {
            return unpricedFirst(rows);
        },

        // the catalogue: what it is, who supplies it and what it sells for.
        // Reorder points have their own screen, so they are not repeated here.
        renderRow: function (p, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openMaterialDetail(' + p.product_id + ')" title="Open this material">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) +
                '<span class="cell-sub">' + materialKindText(p) + '</span></td>' +
            '<td>' + (p.supplier_name
                ? escapeHtml(p.supplier_name)
                : '<span class="muted">No supplier</span>') + '</td>' +
            '<td class="cell-num">' + priceOrBadge(p) +
                '<span class="cell-sub">per ' + escapeHtml(p.unit_name || 'unit') + '</span></td>' +
            '<td class="cell-num">' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>';
        }
    });
}

// The material in invProducts with this id, or undefined when there is none.
function findProductById(productId) {
    for (let i = 0; i < invProducts.length; i++) {
        if (invProducts[i].product_id === productId) return invProducts[i];
    }
    return undefined;
}

// Puts the names in a list into one string, each one made safe for HTML,
// with the separator between them.
function joinEscaped(names, separator) {
    let text = '';
    for (let i = 0; i < names.length; i++) {
        if (i > 0) text += separator;
        text += escapeHtml(names[i]);
    }
    return text;
}

// "Stanley · Hand Tools": brand then category, whichever are on file
function materialKindText(p) {
    const parts = [];
    if (p.brand_name) parts.push(p.brand_name);
    parts.push(p.category_name || 'Uncategorised');
    return joinEscaped(parts, ' &middot; ');
}

async function loadInventoryAll(event) {
    if (event) event.preventDefault();

    showInventoryPanel('panel-inventory', 'Inventory Management');

    const link = document.querySelector('a[data-panel-link="panel-inventory"]');
    if (link) link.classList.add('active');

    loadStockBanner();
}

// ---------- adding a new product ----------
// The Add New Product button on the Material List. The clerk names the product
// and says what it is. The price is the manager's: the product starts with
// "No price", the manager is told, and the till cannot sell it until it is
// priced. The first stock comes in by a delivery or a stock adjustment.
const PRODUCT_NAME_MAX = 150;
const BRAND_NAME_MAX = 100;
const REORDER_POINT_MAX = 100000;

// <option>s for a list of records ({ id, name }), with a first line that has no value
function recordOptions(rows, firstLine) {
    let html = '<option value="">' + escapeHtml(firstLine) + '</option>';
    for (let i = 0; i < rows.length; i++) {
        html += '<option value="' + escapeHtml(rows[i].name) + '">' + escapeHtml(rows[i].name) + '</option>';
    }
    return html;
}

async function openAddProduct() {
    if (!holdsFeature('product-add')) return;

    let categories = [];
    let units = [];
    let suppliers = [];
    let brands = [];
    try {
        const lists = await Promise.all([
            apiGetRecords('category'), apiGetRecords('unit'),
            apiGetRecords('supplier'), apiGetRecords('brand')
        ]);
        categories = lists[0];
        units = lists[1];
        suppliers = lists[2];
        brands = lists[3];
    } catch (error) {
        notifyOffline();
        return;
    }

    // only the manager adds a category or a unit (Records), so there is nothing to pick without them
    if (categories.length === 0 || units.length === 0) {
        notifyWarning('There is no category or unit on file yet. Ask the manager to add them under Records first.',
            'Cannot add a product yet');
        return;
    }

    let supplierOptions = '<option value="">No supplier</option>';
    for (let i = 0; i < suppliers.length; i++) {
        supplierOptions += '<option value="' + suppliers[i].id + '">' + escapeHtml(suppliers[i].name) + '</option>';
    }

    let brandList = '';
    for (let i = 0; i < brands.length; i++) {
        brandList += '<option value="' + escapeHtml(brands[i].name) + '"></option>';
    }

    const body =
        '<form id="add-product-form" onsubmit="saveNewProduct(event)" autocomplete="off" novalidate>' +
            '<div class="form-group">' +
                '<label for="new-product-name">Product name</label>' +
                '<input type="text" class="form-control" id="new-product-name" name="productName" ' +
                    'maxlength="' + PRODUCT_NAME_MAX + '" placeholder="Claw Hammer 16 oz">' +
            '</div>' +
            '<div class="grid-2">' +
                '<div class="form-group">' +
                    '<label for="new-product-category">Category</label>' +
                    '<select class="form-control" id="new-product-category" name="categoryName">' +
                        recordOptions(categories, 'Pick a category') + '</select>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="new-product-unit">Unit <span class="label-hint">what it is counted in</span></label>' +
                    '<select class="form-control" id="new-product-unit" name="unitName">' +
                        recordOptions(units, 'Pick a unit') + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="grid-2">' +
                '<div class="form-group">' +
                    '<label for="new-product-brand">Brand <span class="label-hint">optional</span></label>' +
                    '<input type="text" class="form-control" id="new-product-brand" name="brandName" ' +
                        'list="new-product-brands" maxlength="' + BRAND_NAME_MAX + '" placeholder="Pick one or type a new brand">' +
                    '<datalist id="new-product-brands">' + brandList + '</datalist>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="new-product-supplier">Supplier <span class="label-hint">optional</span></label>' +
                    '<select class="form-control" id="new-product-supplier" name="supplierId">' +
                        supplierOptions + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="form-group">' +
                '<label for="new-product-reorder">Reorder point <span class="label-hint">optional, 10 when left blank</span></label>' +
                '<input type="number" class="form-control" id="new-product-reorder" name="reorderPoint" ' +
                    'min="0" max="' + REORDER_POINT_MAX + '" step="1" placeholder="10">' +
            '</div>' +
            '<p class="detail-note">The manager sets the selling price, and the till cannot sell this product until ' +
                'then. It starts with nothing on the shelf: stock comes in by a delivery or a stock adjustment.</p>' +
            '<div class="detail-actions">' +
                '<button type="submit" class="btn btn-accent" id="new-product-save">Add Product</button>' +
                '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\')">Cancel</button>' +
            '</div>' +
        '</form>';

    openDetailModal('Add New Product', 'It starts with no price', '+',
        [{ label: 'New Product', body: body }], '', { scroll: true });

    const nameBox = document.getElementById('new-product-name');
    if (nameBox) nameBox.focus();
}

// Says what is wrong with the form, as { message, field }, or null when it can be sent
function checkNewProduct(form) {
    const name = form.elements.productName.value.trim();
    if (name === '') return { message: 'Type the product\'s name.', field: form.elements.productName };
    if (name.length > PRODUCT_NAME_MAX) {
        return { message: 'A product name is at most ' + PRODUCT_NAME_MAX + ' characters.', field: form.elements.productName };
    }
    if (form.elements.categoryName.value === '') {
        return { message: 'Pick the product\'s category.', field: form.elements.categoryName };
    }
    if (form.elements.unitName.value === '') {
        return { message: 'Pick the unit the product is counted in.', field: form.elements.unitName };
    }
    if (form.elements.brandName.value.trim().length > BRAND_NAME_MAX) {
        return { message: 'A brand name is at most ' + BRAND_NAME_MAX + ' characters.', field: form.elements.brandName };
    }

    const reorder = form.elements.reorderPoint.value.trim();
    if (reorder !== '') {
        const number = Number(reorder);
        if (!Number.isInteger(number) || number < 0 || number > REORDER_POINT_MAX) {
            return { message: 'The reorder point is a whole number from 0 to ' + REORDER_POINT_MAX + '.',
                     field: form.elements.reorderPoint };
        }
    }
    return null;
}

// the material already on the list with this name (any capitals), or undefined
function findProductByName(name) {
    const wanted = name.trim().toLowerCase();
    for (let i = 0; i < invProducts.length; i++) {
        if (String(invProducts[i].product_name).trim().toLowerCase() === wanted) return invProducts[i];
    }
    return undefined;
}

async function saveNewProduct(event) {
    event.preventDefault();
    const form = event.target;

    const problem = checkNewProduct(form);
    if (problem) {
        notifyWarning(problem.message, 'Check the form');
        problem.field.focus();
        return;
    }

    const name = form.elements.productName.value.trim().replace(/\s+/g, ' ');

    // the list may already be loaded: no need to ask the server about a name that is on it
    const same = findProductByName(name);
    if (same) {
        notifyWarning('"' + same.product_name + '" is already on the material list. Nothing was added.',
            'Already on the list');
        form.elements.productName.focus();
        return;
    }

    const button = document.getElementById('new-product-save');
    if (button) button.disabled = true;

    try {
        const response = await apiAddProduct({
            name: name,
            categoryName: form.elements.categoryName.value,
            unitName: form.elements.unitName.value,
            brandName: form.elements.brandName.value.trim(),
            supplierId: form.elements.supplierId.value,
            reorderPoint: form.elements.reorderPoint.value.trim()
        });
        const result = await response.json();

        if (button) button.disabled = false;
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Product not added');
            return;
        }

        // the name was already on file: the server added nothing, and says so
        if (!result.created) {
            notifyWarning(result.message, 'Already on file');
            form.elements.productName.focus();
            return;
        }

        closeModal('detail-modal');
        notifySuccess(result.message, 'Product added');
        showNewProductRow(name);
        loadStockBanner();
    } catch (error) {
        if (button) button.disabled = false;
        notifyOffline();
    }
}

// Reads the material list again with the new product searched for, so its row is the one on screen
async function showNewProductRow(name) {
    const panel = getDataPanel('clerk-materials');
    if (!panel) return;

    // the search text and the stock filter must not hide it
    const search = document.getElementById('inv-search');
    if (search) search.value = name;
    const status = document.getElementById('inv-status');
    if (status) status.value = 'all';
    panel.filters.status = 'all';
    panel.query = searchText(name);
    await panel.open();
}

// ---------- the low stock banner ----------
async function loadStockBanner() {
    const box = document.getElementById('stock-banner');
    if (!box) return;

    try {
        const s = await apiGetInventorySummary();
        const low = Number(s.lowStock);
        const out = Number(s.outOfStock);

        if (low === 0 && out === 0) {
            box.innerHTML = '<div class="banner banner-ok">Every material is above its reorder point.</div>';
            return;
        }

        const parts = [];
        if (out > 0) parts.push(out + (out === 1 ? ' material is out of stock' : ' materials are out of stock'));
        if (low > 0) parts.push(low + (low === 1 ? ' material is low' : ' materials are low'));

        box.innerHTML = '<div class="banner ' + (out > 0 ? 'banner-danger' : 'banner-warn') + '">' +
            '<span class="banner-text"><strong>Stock warning.</strong> ' + parts.join(' and ') +
            '. The manager has been notified.</span>' +
            '<button type="button" class="btn btn-sm" onclick="showReorder(event)">Review Reorder Point</button></div>';
    } catch (error) {
        box.innerHTML = '';
    }
}

// ---------- the "Needs attention" list (Stock Adjustment) ----------
// The server marks every material Out of Stock, Low Stock or In Stock. It is
// the same rule that counts the banner above, so the list follows that mark
// and the two always agree.
const ATTENTION_SHOWN = 10;

function isShort(p) {
    return p.stock_status === 'Out of Stock' || p.stock_status === 'Low Stock';
}

// how far under its reorder point a material is
function shortBy(p) {
    return (Number(p.reorder_point) || 0) - (Number(p.quantity_in_stock) || 0);
}

// out of stock first, then low; inside each, the one furthest under its point first
function compareShort(a, b) {
    const aRank = a.stock_status === 'Out of Stock' ? 0 : 1;
    const bRank = b.stock_status === 'Out of Stock' ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    if (shortBy(a) !== shortBy(b)) return shortBy(b) - shortBy(a);
    return String(a.product_name).localeCompare(String(b.product_name));
}

// one line of words where the list goes ("Loading...", "Everything is above...")
function attentionMessage(text) {
    const list = document.getElementById('attention-list');
    const more = document.getElementById('attention-more');
    if (list) list.innerHTML = '<li class="attention-empty">' + escapeHtml(text) + '</li>';
    if (more) { more.hidden = true; more.innerHTML = ''; }
}

// whether the Stock Adjustment screen is the one showing
function adjustScreenOpen() {
    const panel = document.getElementById('panel-adjust');
    return Boolean(panel) && panel.style.display === 'block';
}

// Once the materials are in: draw the list, and bring the material picked in the
// form up to date. Says so when they could not be loaded.
function afterMaterialsLoaded(loaded) {
    if (!loaded) {
        attentionMessage('The materials could not be loaded.');
        return;
    }

    refreshPickedMaterial();
    renderAttentionList();
}

// The picked material is a copy from an earlier load; swap in the fresh one so the
// strip and the preview's "before" figure are current. The unit box is left alone,
// because the clerk may be in the middle of typing it.
function refreshPickedMaterial() {
    if (!adjustMaterial) return;

    const fresh = findProductById(adjustMaterial.product_id);
    if (!fresh) return;

    adjustMaterial = fresh;
    renderAdjustMaterialStrip();
    renderAdjustUnitVerdict();
    renderAdjustPreview();
}

// Somebody else moved stock (a sale, a return, another clerk): while this screen is
// open, read the materials again so the list, the strip and the banner stay true.
async function refreshAdjustScreen() {
    if (!adjustScreenOpen()) return;

    const loaded = await ensureInventoryLoaded(true);
    if (loaded) afterMaterialsLoaded(true);
    loadStockBanner();
}

function renderAttentionList() {
    const list = document.getElementById('attention-list');
    const more = document.getElementById('attention-more');
    if (!list || !more) return;

    const short = [];
    for (let i = 0; i < invProducts.length; i++) {
        if (isShort(invProducts[i])) short.push(invProducts[i]);
    }
    short.sort(compareShort);

    if (short.length === 0) {
        attentionMessage('Everything is above its reorder point.');
        return;
    }

    let listHtml = '';
    const shown = short.slice(0, ATTENTION_SHOWN);
    for (let i = 0; i < shown.length; i++) {
        const p = shown[i];
        const out = p.stock_status === 'Out of Stock';
        const unit = p.unit_name ? ' ' + escapeHtml(p.unit_name) : '';

        // the whole row is the button (like a clickable table row); it is a
        // real <button> so the keyboard can reach it too
        listHtml += '<li>' +
            '<button type="button" class="attention-row" ' +
                'aria-label="Adjust ' + escapeHtml(p.product_name) + '" ' +
                'onclick="adjustFromList(' + p.product_id + ')">' +
            '<span class="attention-who">' +
                '<span class="attention-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="attention-kind">' + materialKindText(p) + '</span>' +
            '</span>' +
            '<span class="attention-figures">' +
                '<span class="badge ' + (out ? 'badge-danger' : 'badge-warning') + '" ' +
                    'title="' + (out ? 'Out of stock' : 'Low stock') + '">' +
                    (Number(p.quantity_in_stock) || 0) + unit + '</span>' +
                '<span class="attention-reorder">Reorder at ' + (Number(p.reorder_point) || 0) + '</span>' +
            '</span>' +
            '</button></li>';
    }
    list.innerHTML = listHtml;

    // more than fit here: the Reorder Point screen has them all
    if (short.length > ATTENTION_SHOWN) {
        more.hidden = false;
        more.innerHTML = '<button type="button" class="btn btn-ghost btn-sm" onclick="showReorder(event)">' +
            'See all ' + short.length + ' in Reorder Point</button>';
    } else {
        more.hidden = true;
        more.innerHTML = '';
    }
}

// "Adjust" on a row: the same pick as choosing it from the suggestion list, for adding stock
function adjustFromList(productId) {
    const form = document.getElementById('adjust-form');

    // a quantity and reason typed for another material do not belong to this one
    if (form && adjustMaterial && adjustMaterial.product_id !== productId) {
        form.elements.quantity.value = '';
        form.elements.reason.value = '';
    }

    const type = document.getElementById('adjust-type');
    if (type) type.value = 'Add';

    pickAdjustMaterial(productId);       // this also redraws the strip and the preview

    const qty = document.getElementById('adjust-qty');
    const card = document.querySelector('#panel-adjust .pair-form');

    if (card && qty && window.matchMedia('(max-width: 1279px)').matches) {
        // stacked layout: the form is above the list, so bring it into view;
        // preventScroll because that scroll is already taking us there
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        qty.focus({ preventScroll: true });
    } else if (qty) {
        // side by side: a plain focus scrolls the box into view on a short screen
        qty.focus();
    }
}

// ---------- the material boxes (Stock Adjustment, Make a Report) ----------
// what a typed query finds, best first: the name starts with it, then a word
// in the name does, then the brand or category; six at most
function findMaterials(query) {
    const starts = [];
    const words = [];
    const other = [];

    for (let i = 0; i < invProducts.length; i++) {
        const p = invProducts[i];
        const name = String(p.product_name || '').toLowerCase();

        if (name.startsWith(query)) starts.push(p);
        else if (startsAWord(name, query)) words.push(p);
        else if (prefixMatch([p.brand_name, p.category_name], query)) other.push(p);
    }

    return starts.concat(words, other).slice(0, 6);
}

// the dropdown's rows; a row calls pickFn with its product id
function materialSuggestHtml(found, idPrefix, pickFn) {
    let html = '';
    for (let i = 0; i < found.length; i++) {
        const p = found[i];
        const stock = Number(p.quantity_in_stock);
        const meta = [];
        if (p.category_name) meta.push(escapeHtml(p.category_name));
        if (p.brand_name) meta.push(escapeHtml(p.brand_name));

        // stock on hand is the figure about to change
        html += '<li class="suggest-item" role="option" id="' + idPrefix + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="' + pickFn + '(' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + stock + ' ' + escapeHtml(p.unit_name || '') + '</span>' +
            '</span>' +
            (meta.length ? '<span class="suggest-note">' + meta.join(' &middot; ') + '</span>' : '') +
            '</li>';
    }
    return html;
}

async function loadSupplierOptions() {
    const selects = document.querySelectorAll('[data-supplier-select]');
    if (selects.length === 0) return;

    try {
        const rows = await apiGetRecords('supplier');
        let options = '';
        for (let i = 0; i < rows.length; i++) {
            options += '<option value="' + rows[i].id + '">' + escapeHtml(rows[i].name) + '</option>';
        }
        for (let i = 0; i < selects.length; i++) {
            selects[i].innerHTML = options;
        }
    } catch (error) {
        console.error('Unable to load suppliers:', error);
    }
}

// Stock adjustment: two typed boxes. The material box shares the till's
// picker rule (text that matches nothing is not a choice); the unit box
// suggests what the shop already uses and accepts a new word.
function adjustMaterialBox() { return document.getElementById('adjust-material'); }
function adjustUnitBox() { return document.getElementById('adjust-unit'); }

function adjustProductIdBox() {
    const form = document.getElementById('adjust-form');
    return form ? form.elements.productId : null;
}

// ---------- the material ----------
async function onAdjustMaterialInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('adjust-material-clear');

    if (clear) clear.hidden = text === '';

    if (!invLoaded && text !== '') await ensureInventoryLoaded(false);

    // typing on after a choice unmakes it
    if (adjustMaterial && String(adjustMaterial.product_name).trim() !== text) {
        setAdjustMaterial(null);
    }

    renderAdjustSuggestions(text);
    renderAdjustMaterialVerdict();
}

function renderAdjustSuggestions(text) {
    const list = document.getElementById('adjust-suggest');
    const box = adjustMaterialBox();
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    adjustSuggestHighlight = -1;

    const hide = function () {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    // one letter is enough here: it matches the start of a word, so the list stays short
    if (query === '' || invProducts.length === 0) { hide(); return; }

    if (adjustMaterial && String(adjustMaterial.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    const found = findMaterials(query);
    if (found.length === 0) { hide(); return; }

    list.innerHTML = materialSuggestHtml(found, 'adjust-suggest-', 'pickAdjustMaterial');

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideAdjustSuggestions() {
    const list = document.getElementById('adjust-suggest');
    const box = adjustMaterialBox();
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    adjustSuggestHighlight = -1;
}

function onAdjustMaterialKey(event) {
    const list = document.getElementById('adjust-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        adjustSuggestHighlight = (adjustSuggestHighlight + step + items.length) % items.length;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === adjustSuggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[adjustSuggestHighlight >= 0 ? adjustSuggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideAdjustSuggestions();
}

function pickAdjustMaterial(productId) {
    const found = findProductById(productId);
    if (!found) return;

    const box = adjustMaterialBox();
    if (box) box.value = found.product_name;

    const clear = document.getElementById('adjust-material-clear');
    if (clear) clear.hidden = false;

    hideAdjustSuggestions();
    setAdjustMaterial(found);
}

function clearAdjustMaterial() {
    const box = adjustMaterialBox();
    if (box) box.value = '';

    const clear = document.getElementById('adjust-material-clear');
    if (clear) clear.hidden = true;

    hideAdjustSuggestions();
    setAdjustMaterial(null);
    if (box) box.focus();
}

// one place decides what is chosen so the field, strip, unit box and preview agree
function setAdjustMaterial(product) {
    adjustMaterial = product || null;

    const idBox = adjustProductIdBox();
    if (idBox) idBox.value = product ? String(product.product_id) : '';

    // the material's own unit is filled in but stays editable
    const unitBox = adjustUnitBox();
    if (unitBox) unitBox.value = product ? (product.unit_name || '') : '';

    renderAdjustMaterialStrip();
    renderAdjustMaterialVerdict();
    renderAdjustUnitVerdict();
    renderAdjustPreview();
}

function renderAdjustMaterialStrip() {
    const strip = document.getElementById('adjust-material-strip');
    if (!strip) return;

    const p = adjustMaterial;
    if (!p) { strip.hidden = true; strip.innerHTML = ''; return; }

    const metaParts = [];
    if (p.category_name) metaParts.push(p.category_name);
    if (p.brand_name) metaParts.push(p.brand_name);
    const meta = joinEscaped(metaParts, ' &middot; ');
    const stock = Number(p.quantity_in_stock);
    const reorder = Number(p.reorder_point) || 0;

    strip.hidden = false;
    strip.innerHTML =
        '<p class="pick-strip-name">' + escapeHtml(p.product_name) + '</p>' +
        (meta ? '<p class="pick-strip-meta">' + meta + '</p>' : '') +
        '<div class="pick-strip-figures">' +
            '<span><span class="pick-strip-label">On hand</span>' +
                '<span class="pick-strip-value">' + stock + ' ' + escapeHtml(p.unit_name || '') + '</span></span>' +
            '<span><span class="pick-strip-label">Reorder at</span>' +
                '<span class="pick-strip-value">' + reorder + '</span></span>' +
        '</div>';
}

function renderAdjustMaterialVerdict(insist) {
    const box = document.getElementById('adjust-material-verdict');
    if (!box) return;

    const typed = adjustMaterialBox() ? adjustMaterialBox().value.trim() : '';

    // quiet while the list is open; red only when nothing matches or the form was sent without a choice
    const list = document.getElementById('adjust-suggest');
    const listOpen = list && !list.hidden;

    box.className = 'pick-verdict';
    box.textContent = '';
    if (adjustMaterial || listOpen) return;

    if (insist) {
        box.className = 'pick-verdict is-stop';
        box.textContent = 'Choose a material from the list.';
    } else if (typed !== '') {
        box.className = 'pick-verdict is-stop';
        box.textContent = 'Nothing matches "' + typed + '". Try a name, brand, or category.';
    }
}

// ---------- the unit ----------
async function loadUnits(force) {
    if (invUnitsLoaded && !force) return true;

    try {
        invUnits = await apiGetRecords('unit');
        invUnitsLoaded = true;
        return true;
    } catch (error) {
        // not fatal: a blank unit keeps whatever the material already uses
        invUnitsLoaded = false;
        return false;
    }
}

async function onAdjustUnitInput(value) {
    if (!invUnitsLoaded) await loadUnits(false);
    renderUnitSuggestions(String(value || ''));
    renderAdjustUnitVerdict();
    renderAdjustPreview();
}

function renderUnitSuggestions(text) {
    const list = document.getElementById('unit-suggest');
    const box = adjustUnitBox();
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    unitSuggestHighlight = -1;

    const hide = function () {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (invUnits.length === 0) { hide(); return; }

    // an empty box offers the whole short list
    const typed = searchText(query);
    let matches;
    if (typed === '') {
        matches = invUnits.slice(0, 8);
    } else {
        matches = [];
        for (let i = 0; i < invUnits.length; i++) {
            if (startsAWord(invUnits[i].name, typed)) matches.push(invUnits[i]);
        }
        matches = matches.slice(0, 8);
    }

    if (matches.length === 1 && String(matches[0].name).toLowerCase() === query) { hide(); return; }
    if (matches.length === 0) { hide(); return; }

    let unitHtml = '';
    for (let i = 0; i < matches.length; i++) {
        const u = matches[i];
        const used = Number(u.product_count) || 0;
        unitHtml += '<li class="suggest-item" role="option" id="unit-suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickAdjustUnit(' + JSON.stringify(String(u.name)).replace(/"/g, '&quot;') + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(u.name) + '</span>' +
                '<span class="suggest-figure">' + used + '</span>' +
            '</span></li>';
    }
    list.innerHTML = unitHtml;

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideUnitSuggestions() {
    const list = document.getElementById('unit-suggest');
    const box = adjustUnitBox();
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    unitSuggestHighlight = -1;
}

function onAdjustUnitKey(event) {
    const list = document.getElementById('unit-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        unitSuggestHighlight = (unitSuggestHighlight + step + items.length) % items.length;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === unitSuggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[unitSuggestHighlight >= 0 ? unitSuggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideUnitSuggestions();
}

function pickAdjustUnit(name) {
    const box = adjustUnitBox();
    if (box) box.value = name;
    hideUnitSuggestions();
    renderAdjustUnitVerdict();
    renderAdjustPreview();
}

// Why a different unit cannot be filed, in the words of sp_adjust_stock; ''
// when it can. Only called when the typed unit differs from the current one.
function adjustUnitProblem() {
    const form = document.getElementById('adjust-form');
    const type = form ? form.elements.adjustmentType.value : '';
    const sizes = adjustMaterial && Array.isArray(adjustMaterial.selling_units) ? adjustMaterial.selling_units : [];

    if (type !== 'Recount') {
        return 'A different unit can only be set on a Recount. Leave Counted in empty, or choose Recount.';
    }
    if (sizes.length > 0) {
        return 'This material has selling sizes set up, so its unit cannot change. Fix the selling sizes first.';
    }
    return '';
}

// says what the typed unit is about to do before the button is pressed
function renderAdjustUnitVerdict() {
    const box = document.getElementById('adjust-unit-verdict');
    if (!box) return;

    const typed = adjustUnitBox() ? adjustUnitBox().value.trim() : '';

    if (typed === '') {
        box.className = 'unit-verdict';

        // with no material yet the placeholder already says what goes here
        box.textContent = adjustMaterial
            ? 'Left empty, this stays counted in ' + (adjustMaterial.unit_name || 'whatever it uses now') + '.'
            : '';

        return;
    }

    let known = false;
    for (let i = 0; i < invUnits.length; i++) {
        if (String(invUnits[i].name).toLowerCase() === typed.toLowerCase()) known = true;
    }
    const current = adjustMaterial ? String(adjustMaterial.unit_name || '') : '';
    const changing = adjustMaterial && current.toLowerCase() !== typed.toLowerCase();

    // the same rule as sp_adjust_stock: a different unit is only for a Recount,
    // and not for a material that already has a unit and also sells in other sizes
    const unitProblem = changing && current !== '' ? adjustUnitProblem() : '';
    if (unitProblem) {
        box.className = 'unit-verdict is-stop';
        box.textContent = unitProblem;
        return;
    }

    if (!known) {
        box.className = 'unit-verdict is-new';
        box.textContent = '"' + typed + '" is not on the list yet. Filing this adds it.';
        return;
    }

    if (changing) {
        box.className = 'unit-verdict is-new';
        box.textContent = adjustMaterial.product_name + ' is counted in ' +
            (current || 'nothing yet') + '. Filing this changes it to ' + typed + '.';
        return;
    }

    box.className = 'unit-verdict';
    box.textContent = '';
}

// A quantity as typed, whole or fractional: 2.5 kilogram is 2.5, not 2. Three
// decimals is the width of the column it lands in; NaN when nothing readable.
function readQuantity(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text === '') return NaN;
    const number = Number(text);
    return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : NaN;
}

// Add and Remove move the shelf, so a quantity of nothing is not an adjustment
// (fractions are fine); a recount may find the shelf empty, so it may be 0.
// Returns the words to show, or '' when the quantity is fine.
function adjustQuantityProblem(type, quantity) {
    if (type === 'Recount') {
        return quantity < 0 ? 'A recount cannot be below zero.' : '';
    }
    return quantity <= 0 ? 'Add and Remove need a quantity greater than zero.' : '';
}

// ---------- what this will do ----------
// A strip: the material, then "40 pcs -> 45 pcs (+5)". A Remove that would
// take the shelf below zero is caught here.
function renderAdjustPreview() {
    const box = document.getElementById('adjust-preview');
    const form = document.getElementById('adjust-form');
    if (!box || !form) return;

    const quantity = readQuantity(form.elements.quantity.value);

    if (!adjustMaterial || !Number.isFinite(quantity)) {
        box.textContent = '';
        box.className = 'adjust-preview';
        return;
    }

    const type = form.elements.adjustmentType.value;

    // the same rule, in the same words, as the server and sp_adjust_stock
    const quantityProblem = adjustQuantityProblem(type, quantity);
    if (quantityProblem) {
        box.className = 'adjust-preview is-stop';
        box.textContent = quantityProblem;
        return;
    }

    const before = Number(adjustMaterial.quantity_in_stock) || 0;
    const unit = (adjustUnitBox() && adjustUnitBox().value.trim()) || adjustMaterial.unit_name || '';

    let after = before;
    if (type === 'Add') after = before + quantity;
    else if (type === 'Remove') after = before - quantity;
    else after = quantity;
    after = Math.round(after * 1000) / 1000;      // 2.3 + 0.1 reads 2.4, not 2.4000000000000004

    if (after < 0) {
        box.className = 'adjust-preview is-stop';
        box.textContent = 'That would leave ' + after + ' on the shelf. Only ' + before + ' ' +
            unit + ' on hand.';
        return;
    }

    // the difference from what is on hand: +5, a real minus sign for -3, or none
    const change = Math.round((after - before) * 1000) / 1000;
    let changeText = 'no change';
    if (change > 0) changeText = '+' + change;
    else if (change < 0) changeText = '−' + Math.abs(change);

    // green when the shelf goes up, amber when it goes down; red is kept for what cannot be done
    let tone = '';
    if (change > 0) tone = ' is-good';
    else if (change < 0) tone = ' is-down';

    const reorder = Number(adjustMaterial.reorder_point) || 0;
    const low = after <= reorder;

    box.className = 'adjust-preview' + tone;
    box.innerHTML =
        '<span class="preview-name">' + escapeHtml(adjustMaterial.product_name) + '</span>' +
        '<span class="preview-figures">' + before + ' ' + escapeHtml(unit) + ' → ' +
            after + ' ' + escapeHtml(unit) + ' <strong>(' + changeText + ')</strong></span>' +
        (low ? '<span class="preview-note">That is at or below its reorder point of ' + reorder +
            ', so the manager is told.</span>' : '');
}

// ---------- the log ----------
function buildAdjustmentsPanel() {
    createDataPanel({
        key: 'clerk-adjustments',
        tableId: 'adjust-table',
        columns: 7,
        pagerId: 'adjust-pager',
        idField: 'adjustment_id',
        filters: { type: 'all' },

        gate: {
            title: 'The log is not loaded',
            text: 'Press Load Data for every stock movement on record, or type a material.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetStockAdjustments();
        },

        match: function (a, query) {
            return prefixMatch([a.product_name, a.adjusted_by, a.reason, a.unit_name], query);
        },

        filter: function (a, filters) {
            return filters.type === 'all' || a.adjustment_type === filters.type;
        },

        renderRow: function (a, index) {
            // the unit the entry recorded, not the material's unit today
            const unit = a.unit_name ? ' ' + escapeHtml(a.unit_name) : '';

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openAdjustmentDetail(' + a.adjustment_id + ')">' +
            '<td class="cell-id">' + escapeHtml(String(a.created_at).slice(0, 16)) + '</td>' +
            '<td class="cell-name">' + escapeHtml(a.product_name) + '</td>' +
            '<td>' + statusBadge(a.adjustment_type) + '</td>' +
            '<td class="cell-num">' + a.quantity_before + '</td>' +
            '<td class="cell-num ' + (a.quantity_change < 0 ? 'cell-due' : '') + '">' +
                (a.quantity_change > 0 ? '+' : '') + a.quantity_change + unit + '</td>' +
            '<td class="cell-num">' + a.quantity_after + '</td>' +
            '<td>' + escapeHtml(a.adjusted_by) + '</td></tr>';
        }
    });
}

function clearAdjustmentPanel() {
    const panel = getDataPanel('clerk-adjustments');
    if (panel) panel.reset();

    const search = document.getElementById('adjust-search');
    if (search) search.value = '';

    const type = document.getElementById('adjust-type-filter');
    if (type) type.value = 'all';
}

async function loadAdjustments() {
    const panel = getDataPanel('clerk-adjustments');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function handleAdjustStock(event) {
    event.preventDefault();
    const form = event.target;

    // the check is on what was chosen, not what is typed
    if (!adjustMaterial || !form.elements.productId.value) {
        notifyWarning('Type a few letters of the material and choose it from the list. ' +
            'An adjustment moves a real figure, so it has to name one.', 'No material chosen');
        const box = adjustMaterialBox();
        if (box) { box.focus(); box.select(); }
        renderAdjustMaterialVerdict(true);
        return;
    }

    const unit = form.elements.unitName ? form.elements.unitName.value.trim() : '';

    const data = {
        productId: parseInt(form.elements.productId.value, 10),
        adjustmentType: form.elements.adjustmentType.value,
        quantity: readQuantity(form.elements.quantity.value),
        unitName: unit,
        reason: form.elements.reason.value.trim()
    };

    const quantityProblem = Number.isFinite(data.quantity)
        ? adjustQuantityProblem(data.adjustmentType, data.quantity)
        : 'Enter a quantity.';
    if (quantityProblem) {
        notifyWarning(quantityProblem, 'Quantity not allowed');
        const qty = document.getElementById('adjust-qty');
        if (qty) { qty.focus(); qty.select(); }
        return;
    }

    if (data.reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }

    // changing the unit re-reads every figure on the shelf, so it is read back first
    const current = String(adjustMaterial.unit_name || '');
    if (unit !== '' && current !== '' && unit.toLowerCase() !== current.toLowerCase()) {
        // the server refuses these too; saying it here saves a round trip
        const unitProblem = adjustUnitProblem();
        if (unitProblem) {
            notifyWarning(unitProblem, 'Unit not changed');
            return;
        }

        const yes = await askConfirm(
            adjustMaterial.product_name + ' is counted in ' + current + ' and you are filing this in ' + unit + '.',
            {
                title: 'Change what this is counted in?',
                eyebrow: 'Stock Adjustment',
                confirmLabel: 'Count it in ' + unit,
                tone: 'danger',
                detail: [
                    'The ' + adjustMaterial.quantity_in_stock + ' ' + current + ' on the shelf is replaced by the ' +
                        'count you typed, in ' + unit + '. Nothing is converted.',
                    'Every screen that shows this material will say ' + unit + '.',
                    'Entries already in the log keep saying ' + current + ', because that is what they counted.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await apiAdjustStock(data);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);

        form.elements.quantity.value = '';
        form.elements.reason.value = '';

        // form.reset() would clear the material too; only the stale stock figure must go
        invLoaded = false;
        invUnitsLoaded = false;
        afterMaterialsLoaded(await ensureInventoryLoaded(true));    // a restocked material drops off the list
        await loadUnits(true);

        const again = findProductById(data.productId);
        setAdjustMaterial(again || null);
        if (!again) clearAdjustMaterial();

        await loadAdjustments();

        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- reorder point settings ----------
// a material's row is pressed and the new point is asked for in a card; no
// boxes or buttons sit in the table
function buildReorderPanel() {
    createDataPanel({
        key: 'clerk-reorder',
        tableId: 'reorder-table',
        columns: 5,
        pagerId: 'reorder-pager',
        idField: 'product_id',
        filters: { status: 'all' },

        gate: {
            title: 'No materials loaded',
            text: 'Search for a material, or press Load Data for the list, then press a material to set its reorder point.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetProducts();
        },

        match: function (p, query) {
            return prefixMatch([p.product_name], query);
        },
        filter: function (p, filters) {
            return filters.status === 'all' || p.stock_status === filters.status;
        },

        // the stock level against the point: a bar, the point itself, and what
        // an order would take to get back to comfortable
        renderRow: function (p, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="askReorderPoint(' + p.product_id + ')" title="Set the reorder point">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td class="cell-num">' + stockLevelBar(p) + '</td>' +
            '<td class="cell-num">' + p.reorder_point + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td class="cell-num">' + (suggestedOrderOf(p) > 0
                ? suggestedOrderOf(p) + ' ' + escapeHtml(p.unit_name || '')
                : '<span class="muted">None</span>') + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>';
        }
    });
}

// what an order would take to get back to twice the reorder point; the server
// sends it, and the same rule works it out if a row arrives without it
function suggestedOrderOf(p) {
    const sent = Number(p.suggested_order);
    if (Number.isFinite(sent) && p.suggested_order !== null && p.suggested_order !== undefined) return sent;
    return Math.max(0, (Number(p.reorder_point) || 0) * 2 - (Number(p.quantity_in_stock) || 0));
}

// On hand as a bar. The full bar is twice the reorder point (the level an
// order brings it back to); the tick marks the point itself.
function stockLevelBar(p) {
    const onHand = Number(p.quantity_in_stock) || 0;
    const point = Number(p.reorder_point) || 0;
    const full = Math.max(point * 2, onHand, 1);
    const width = Math.max(0, Math.min(100, Math.round(onHand / full * 100)));
    const tick = point > 0 ? Math.min(100, Math.round(point / full * 100)) : null;

    let tone = 'is-ok';
    if (p.stock_status === 'Out of Stock') tone = 'is-out';
    else if (p.stock_status === 'Low Stock') tone = 'is-low';

    return '<div class="stock-level ' + tone + '" title="' + onHand + ' on hand, reorder at ' + point + '">' +
            '<span class="stock-level-figure">' + onHand + ' ' + escapeHtml(p.unit_name || '') + '</span>' +
            '<span class="stock-level-track">' +
                '<span class="stock-level-fill" style="width:' + width + '%"></span>' +
                (tick !== null ? '<span class="stock-level-tick" style="left:' + tick + '%"></span>' : '') +
            '</span>' +
        '</div>';
}

async function loadReorderTable() {
    const panel = getDataPanel('clerk-reorder');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

// the card asks for the new point, reads it back, then saves it
async function askReorderPoint(productId) {
    const panel = getDataPanel('clerk-reorder');
    let p = null;
    if (panel) {
        for (let i = 0; i < panel.rows.length; i++) {
            if (panel.rows[i].product_id === productId) {
                p = panel.rows[i];
                break;
            }
        }
    }
    if (!p) return;

    const current = Number(p.reorder_point) || 0;
    const unit = p.unit_name ? ' ' + p.unit_name : '';

    // who to order it from, so the card answers "which company?" as well
    const supplier = p.supplier_name
        ? ['Supplier: ' + p.supplier_name]
            .concat(p.contact_person ? ['Contact: ' + p.contact_person] : [])
            .concat(p.contact_number ? ['Number: ' + p.contact_number] : [])
            .concat(p.supplier_email ? ['Email: ' + p.supplier_email] : [])
        : ['Supplier: None on file'];
    const suggested = suggestedOrderOf(p);

    const asked = await askInput({
        title: 'Set the reorder point',
        eyebrow: 'Reorder Point',
        message: p.product_name + ' is reordered at ' + current + unit + ', with ' + p.quantity_in_stock + unit +
                 ' on hand. When it falls to the new figure the manager is told to order more.',
        detail: supplier.concat(['Suggested order: ' + (suggested > 0 ? suggested + unit : 'None')]),
        label: 'Reorder at' + unit,
        type: 'number',
        value: String(current),
        placeholder: '0',
        confirmLabel: 'Save the point',
        check: function (value) {
            const typed = String(value).trim();
            // /^\d+$/ matches text made only of digits (a whole number, no sign or decimal point)
            if (typed === '' || !/^\d+$/.test(typed)) return 'Type a whole number of' + (unit || ' units') + ', like 12.';
            if (Number(typed) === current) return 'That is the point it already has.';
            return null;
        }
    });
    if (asked === false || asked === null) return;

    await saveReorderPoint(productId, Number(String(asked).trim()));
}

async function saveReorderPoint(productId, value) {
    if (!Number.isInteger(value) || value < 0) {
        notifyWarning('A reorder point cannot be negative.', 'Not saved');
        return;
    }

    try {
        const response = await apiSaveReorderPoint(productId, value);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        invLoaded = false;
        await loadReorderTable();
        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// The clerk raises a purchase order; the manager confirms it; once confirmed,
// the clerk counts the delivery in. Screens live in shared/purchase-orders.js.
function buildClerkPurchaseOrderPanel() {
    configurePurchaseOrders({
        key: 'clerk-po',
        canCreate: true,
        canDecide: false,
        canReceive: true,
        showPanel: showInventoryPanel,
        historyPanelId: 'panel-po-history',
        historyTitle: 'Purchase Orders',
        gateText: 'Press Load Data for every order raised, or filter to the ones still ' +
                  'waiting to be confirmed or delivered.',
        // a delivery counted in moves stock
        afterChange: async function () {
            const keys = ['clerk-materials', 'clerk-reorder'];
            for (let i = 0; i < keys.length; i++) {
                const panel = getDataPanel(keys[i]);
                if (panel && panel.state === 'ready') await panel.refresh();
            }
        }
    });
    buildPurchaseOrderPanel();
}

// ---------- returns, damage and refunds ----------
function buildReturnsPanel() {
    createDataPanel({
        key: 'clerk-returns',
        tableId: 'returns-table',
        columns: 7,
        pagerId: 'returns-pager',
        idField: 'return_id',
        filters: { type: 'All', where: 'all' },

        gate: {
            title: 'No reports loaded',
            text: 'Press Load Data for every return, damage and refund on record.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetReturns();
        },

        match: function (r, query) {
            return prefixMatch([r.product_name, r.reason], query);
        },

        filter: function (r, filters) {
            if (filters.type === 'To inspect') { if (!returnAwaiting(r)) return false; }
            else if (filters.type !== 'All' && r.report_type !== filters.type) return false;
            if (filters.where === 'awaiting') return returnAwaiting(r);
            if (filters.where !== 'all' && returnWentTo(r) !== filters.where) return false;
            return true;
        },

        renderRow: function (r, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openReturnDetail(' + r.return_id + ')">' +
            '<td class="cell-id">#' + r.return_id + '</td>' +
            '<td>' + statusBadge(r.report_type) + '</td>' +
            '<td class="cell-name">' + escapeHtml(r.product_name) + '</td>' +
            '<td class="cell-num">' + r.quantity + ' ' + escapeHtml(r.unit_name || '') + '</td>' +
            '<td>' + returnDispositionBadge(r) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(r.return_date).slice(0, 10)) + '</td>' +
            '<td>' + statusBadge(r.status) + '</td></tr>';
        }
    });
}

// a refund from the counter the clerk has not looked at yet (goods that never
// arrived have nothing to inspect)
function returnAwaiting(row) {
    return row.status === 'Open' && !row.disposition && row.report_type !== 'Missing';
}

// older records have no disposition; read it back off the restocked flag
function returnWentTo(row) {
    if (row.report_type === 'Missing') return 'Missing';
    if (row.disposition) return row.disposition;
    if (returnAwaiting(row)) return null;
    return row.restocked ? 'Return to Stock' : 'Write-Off';
}

function returnDispositionBadge(row) {
    const where = returnWentTo(row);
    if (where === null) return '<span class="badge badge-warning">Awaiting inspection</span>';
    if (where === 'Missing') return '<span class="badge badge-neutral">Never arrived</span>';

    if (where === 'Return to Stock') {
        return '<span class="badge badge-success">Back on shelf</span>';
    } else {
        return '<span class="badge badge-danger">Written off</span>';
    }
}

async function loadReturns() {
    const panel = getDataPanel('clerk-returns');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function resolveReturn(reportId) {
    const panel = getDataPanel('clerk-returns');
    const r = panel ? panel.find(reportId) : null;

    let words = 'Report #' + reportId + ' moves out of the open list. The stock it already moved stays where it is.';
    if (r && r.report_type === 'Missing') {
        words = 'Report #' + reportId + ' moves out of the open list. Use this once the supplier has made the ' +
            'missing goods good. Stock does not change here: the goods are counted in when they are received.';
    }

    const yes = await askConfirm(words,
        { title: 'Mark this report resolved?', eyebrow: 'Returned Items', confirmLabel: 'Mark resolved' });

    if (!yes) return;
    await sendReturnVerdict(reportId, null, '');
}

// The inspection: the clerk has looked at what the counter took back and says
// whether it can be sold again. Sellable puts it back on the shelf; not
// sellable writes it off. Either way the report closes.
async function inspectReturn(reportId, verdict) {
    const panel = getDataPanel('clerk-returns');
    const r = panel ? panel.find(reportId) : null;
    if (!r) return;

    const noteBox = document.getElementById('inspect-note');
    const note = noteBox ? noteBox.value.trim() : '';
    const what = r.quantity + ' ' + (r.unit_name || '') + ' ' + r.product_name;

    let yes;
    if (verdict === 'Return to Stock') {
        yes = await askConfirm(what.trim() + ' goes back on the shelf and the stock count goes up by ' + r.quantity + '.', {
                title: 'Can it be sold again?',
                eyebrow: 'Returned Items',
                confirmLabel: 'Yes, back on the shelf',
                detail: [
                    'The counter and the manager are told.',
                    'If it turns out to be faulty later, file a damage report.'
                ]
            });
    } else {
        yes = await askDanger(what.trim() + ' will be written off.', {
                title: 'Write these goods off?',
                eyebrow: 'Returned Items',
                confirmLabel: 'Write it off',
                detail: [
                    'It never goes back on the shelf and cannot be sold.',
                    'The stock count does not change: the sale already took it off.',
                    'The counter and the manager are told, with your note attached.'
                ]
            });
    }

    if (!yes) return;

    closeModal('detail-modal');
    await sendReturnVerdict(reportId, verdict, note);
}

async function sendReturnVerdict(reportId, verdict, note) {
    try {
        const response = await apiResolveReturn(reportId, verdict, note);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }
        notifySuccess(result.message, verdict ? 'Inspection recorded' : undefined);
        await loadReturns();
        // a verdict that put goods back moves stock
        if (verdict === 'Return to Stock') {
            const keys = ['clerk-materials', 'clerk-reorder'];
            for (let i = 0; i < keys.length; i++) {
                const panel = getDataPanel(keys[i]);
                if (panel && panel.state === 'ready') await panel.refresh();
            }
        }
    } catch (error) {
        notifyOffline();
    }
}

// ---------- Make a Report ----------
// One report can hold several items. Most types list materials (typed and
// picked, like Stock Adjustment's), each with its own quantity. A "Missing
// from delivery" report names a purchase order instead: its items come up as
// a checklist, and every ticked one goes into the report. One press of File
// Report files them all, or none of them if one is refused.
let reportItems = [];          // the materials listed so far: { productId, name, unit, onHand, quantity, refund }
let reportSuggestHighlight = -1;
let reportPo = null;           // the purchase order chosen for a Missing report: { po, items }
let reportPoTicks = {};        // product id -> quantity, to tick when the checklist is drawn

function reportMaterialBox() { return document.getElementById('report-material'); }
function reportTypeNow() {
    const box = document.getElementById('report-type');
    return box ? box.value : 'Damaged';
}

async function onReportMaterialInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('report-material-clear');
    if (clear) clear.hidden = text === '';

    if (!invLoaded && text !== '') await ensureInventoryLoaded(false);

    renderReportSuggestions(text);
    renderReportMaterialVerdict();
}

function renderReportSuggestions(text) {
    const list = document.getElementById('report-suggest');
    const box = reportMaterialBox();
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    reportSuggestHighlight = -1;

    let found = [];
    if (query !== '' && invProducts.length > 0) found = findMaterials(query);

    list.innerHTML = materialSuggestHtml(found, 'report-suggest-', 'pickReportMaterial');
    list.hidden = found.length === 0;
    if (box) box.setAttribute('aria-expanded', found.length > 0 ? 'true' : 'false');
}

function hideReportSuggestions() {
    const list = document.getElementById('report-suggest');
    const box = reportMaterialBox();
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
    reportSuggestHighlight = -1;
}

function onReportMaterialKey(event) {
    const list = document.getElementById('report-suggest');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        reportSuggestHighlight = (reportSuggestHighlight + step + items.length) % items.length;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === reportSuggestHighlight);
        }
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[reportSuggestHighlight >= 0 ? reportSuggestHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideReportSuggestions();
}

// a picked material goes onto the list; the box empties, ready for the next one
function pickReportMaterial(productId) {
    const found = findProductById(productId);
    if (!found) return;

    addReportItem(found);
    clearReportMaterial();
}

function clearReportMaterial(keepFocus) {
    const box = reportMaterialBox();
    if (box) box.value = '';

    const clear = document.getElementById('report-material-clear');
    if (clear) clear.hidden = true;

    hideReportSuggestions();
    renderReportMaterialVerdict();
    if (box && keepFocus !== false) box.focus();
}

function renderReportMaterialVerdict() {
    const box = document.getElementById('report-material-verdict');
    if (!box) return;

    const typed = reportMaterialBox() ? reportMaterialBox().value.trim() : '';
    const list = document.getElementById('report-suggest');
    const listOpen = list && !list.hidden;

    box.className = 'pick-verdict';
    box.textContent = '';
    if (typed === '' || listOpen) return;

    box.className = 'pick-verdict is-stop';
    box.textContent = 'Nothing matches "' + typed + '". Try a name, brand, or category.';
}

// ---------- the materials listed in this report ----------
function addReportItem(product) {
    let alreadyListed = false;
    for (let i = 0; i < reportItems.length; i++) {
        if (reportItems[i].productId === product.product_id) alreadyListed = true;
    }
    if (alreadyListed) {
        notifyWarning(product.product_name + ' is already in this report. Change its quantity in the list.', 'Already listed');
        return;
    }

    reportItems.push({
        productId: product.product_id,
        name: product.product_name,
        unit: product.unit_name || '',
        onHand: Number(product.quantity_in_stock),
        quantity: '1',
        refund: ''
    });
    renderReportItems();
}

function removeReportItem(index) {
    reportItems.splice(index, 1);
    renderReportItems();
}

// typing in a box only remembers the figure; the list is not drawn again, so the cursor stays
function setReportItemField(index, field, value) {
    if (reportItems[index]) reportItems[index][field] = value;
}

function renderReportItems() {
    const box = document.getElementById('report-items');
    if (!box) return;

    if (reportItems.length === 0) {
        box.innerHTML = '<p class="report-items-empty">No materials in this report yet. Type one above to add it.</p>';
        return;
    }

    // a refund amount goes with each item of a refund or a plain return
    const type = reportTypeNow();
    const withRefund = type === 'Refunded' || type === 'Return';

    let lines = '';
    for (let index = 0; index < reportItems.length; index++) {
        const item = reportItems[index];
        lines +=
            '<div class="report-line' + (withRefund ? ' has-refund' : '') + '">' +
                '<div>' +
                    '<div class="recv-name">' + escapeHtml(item.name) + '</div>' +
                    '<div class="recv-meta">' + item.onHand + ' ' + escapeHtml(item.unit) + ' on hand</div>' +
                '</div>' +
                '<div>' +
                    '<label class="recv-meta" for="report-qty-' + index + '">Quantity' +
                        (item.unit ? ' (' + escapeHtml(item.unit) + ')' : '') + '</label>' +
                    '<input type="number" class="form-control recv-qty" id="report-qty-' + index + '" ' +
                           'min="0.001" step="0.001" value="' + escapeHtml(item.quantity) + '" ' +
                           'oninput="setReportItemField(' + index + ', \'quantity\', this.value)">' +
                '</div>' +
                (withRefund
                    ? '<div>' +
                          '<label class="recv-meta" for="report-refund-' + index + '">Refund amount</label>' +
                          '<input type="number" class="form-control recv-qty" id="report-refund-' + index + '" ' +
                                 'min="0" step="0.01" placeholder="0.00" value="' + escapeHtml(item.refund) + '" ' +
                                 'oninput="setReportItemField(' + index + ', \'refund\', this.value)">' +
                      '</div>'
                    : '') +
                '<button type="button" class="btn btn-sm btn-danger" ' +
                        'onclick="removeReportItem(' + index + ')">Remove</button>' +
            '</div>';
    }

    box.innerHTML = '<div class="report-items-head">Items in this report ' +
        '<span class="chip-count">' + reportItems.length + '</span></div>' +
        lines;
}

// ---------- the purchase orders a delivery can be checked against ----------
// Approved orders still waiting for their delivery. Receiving an order
// corrects its lines to what arrived, so a received order has nothing left to
// check a delivery against.
let poChoices = [];

async function loadPoChoices() {
    const rows = await apiGetPurchaseOrders();
    poChoices = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].status === 'Pending') poChoices.push(rows[i]);
    }
    return poChoices;
}

// The approved order with this id from poChoices, or undefined when there is none.
function findPoChoice(poId) {
    for (let i = 0; i < poChoices.length; i++) {
        if (poChoices[i].po_id === poId) return poChoices[i];
    }
    return undefined;
}

// the <option> rows of a purchase order box; the order with this id is selected
function poChoiceOptions(selectedId) {
    let options = '';
    for (let i = 0; i < poChoices.length; i++) {
        const po = poChoices[i];
        options += '<option value="' + po.po_id + '"' + (po.po_id === selectedId ? ' selected' : '') + '>' +
            escapeHtml('PO #' + po.po_id + ' · ' + po.supplier_name + ' · ' +
                       poWhen(po.order_date).slice(0, 10) + ' · ' + poStatusWord(poStage(po))) +
            '</option>';
    }
    return options;
}

// ---------- Missing from delivery: the purchase order and its checklist ----------
function setReportPoVerdict(text, isStop) {
    const box = document.getElementById('report-po-verdict');
    if (!box) return;
    box.className = isStop ? 'pick-verdict is-stop' : 'pick-verdict';
    box.textContent = text;
}

async function loadReportPoChoices() {
    const select = document.getElementById('report-po');
    if (!select) return;

    try {
        await loadPoChoices();
    } catch (error) {
        setReportPoVerdict('The purchase orders could not be loaded. Try again.', true);
        return;
    }

    select.innerHTML = '<option value="">Choose a purchase order</option>' +
        poChoiceOptions(reportPo ? reportPo.po.po_id : null);
    setReportPoVerdict(poChoices.length === 0
        ? 'There is no approved purchase order waiting for its delivery.' : '', false);
}

async function onReportPoChange(value) {
    reportPo = null;
    reportPoTicks = {};
    renderReportPoLines();

    const poId = parseInt(value, 10);
    if (!poId) return;

    try {
        const items = await apiGetPurchaseOrderItems(poId);
        // another order may have been chosen while this one was loading
        const select = document.getElementById('report-po');
        if (select && parseInt(select.value, 10) !== poId) return;

        reportPo = { po: findPoChoice(poId), items: items };
        renderReportPoLines();
    } catch (error) {
        setReportPoVerdict('That purchase order could not be opened. Try again.', true);
    }
}

// The order's items as a checklist: tick the ones that did not arrive, and
// say how many.
function renderReportPoLines() {
    const box = document.getElementById('report-po-lines');
    if (!box) return;

    if (!reportPo) {
        box.innerHTML = '';
        return;
    }
    if (reportPo.items.length === 0) {
        box.innerHTML = '<p class="report-items-empty">This order has no items.</p>';
        return;
    }

    setReportPoVerdict('Tick every item that did not arrive and say how many.', false);

    let bodyRows = '';
    for (let index = 0; index < reportPo.items.length; index++) {
        const item = reportPo.items[index];
        const ticked = reportPoTicks[item.product_id] !== undefined;
        const howMany = ticked ? reportPoTicks[item.product_id] : item.quantity;
        bodyRows += '<tr>' +
                '<td class="report-tick"><input type="checkbox" id="report-po-tick-' + index + '"' +
                    (ticked ? ' checked' : '') + ' onchange="tickReportPo(' + index + ', this.checked)" ' +
                    'aria-label="Missing: ' + escapeHtml(item.product_name) + '"></td>' +
                '<td>' + escapeHtml(item.product_name) + '</td>' +
                '<td class="cell-num">' + escapeHtml(poQuantityText(item)) + '</td>' +
                '<td class="cell-num"><input type="number" class="form-control recv-qty" ' +
                    'id="report-po-qty-' + index + '" min="0.001" step="0.001" value="' + howMany + '"' +
                    (ticked ? '' : ' disabled') + ' aria-label="How many missing: ' + escapeHtml(item.product_name) + '"> ' +
                    '<span class="muted">' + escapeHtml(item.unit_name || '') + '</span></td>' +
                '</tr>';
    }

    box.innerHTML = '<div class="table-responsive"><table class="mini-table report-po-table">' +
        '<thead><tr>' +
            '<th class="report-tick"><input type="checkbox" id="report-po-all" ' +
                'onchange="tickAllReportPo(this.checked)" aria-label="Tick every item"></th>' +
            '<th>Material</th><th class="col-num">Ordered</th><th class="col-num">Missing</th>' +
        '</tr></thead><tbody>' +
        bodyRows +
        '</tbody></table></div>';
}

function tickReportPo(index, on) {
    const box = document.getElementById('report-po-qty-' + index);
    if (box) box.disabled = !on;
    if (on && reportPo) reportPoTicks[reportPo.items[index].product_id] = box ? box.value : 1;
    else if (reportPo) delete reportPoTicks[reportPo.items[index].product_id];
}

function tickAllReportPo(on) {
    if (!reportPo) return;
    for (let index = 0; index < reportPo.items.length; index++) {
        const tick = document.getElementById('report-po-tick-' + index);
        if (tick) tick.checked = on;
        tickReportPo(index, on);
    }
}

// ---------- the report type decides which parts of the form show ----------
function showReportSections(type) {
    const missing = type === 'Missing';

    document.getElementById('report-po-field').hidden = !missing;
    document.getElementById('report-material-field').hidden = missing;
    document.getElementById('report-sale-field').hidden = missing;
    document.getElementById('report-restock-field').hidden = missing;

    const form = document.getElementById('report-form');
    if (form) {
        form.elements.restock.value = type === 'Damaged' ? 'false' : 'true';
        form.elements.reason.placeholder = missing ? 'Short delivery' : 'Cracked';
    }

    // the refund box shows on a refund or a plain return
    renderReportItems();
}

function onReportTypeChange(type) {
    showReportSections(type);
    if (type === 'Missing') loadReportPoChoices();
}

// From the delivery check on Stock Adjustment: Make a Report opens on
// Missing from delivery, the order chosen and the short items ticked.
async function startMissingReport(po, items, shortLines) {
    const form = document.getElementById('report-form');
    if (!form) return;

    form.elements.reportType.value = 'Missing';
    showReportSections('Missing');

    reportPo = { po: po, items: items };
    reportPoTicks = {};
    for (let i = 0; i < shortLines.length; i++) {
        reportPoTicks[shortLines[i].item.product_id] = shortLines[i].shortBase;
    }

    await loadReportPoChoices();
    renderReportPoLines();

    if (form.elements.reason.value.trim() === '') {
        form.elements.reason.value = 'Short delivery';
    }
}

// ---------- File Report ----------
async function handleFileReport(event) {
    event.preventDefault();
    const form = event.target;
    const type = form.elements.reportType.value;
    const reason = form.elements.reason.value.trim();

    const data = {
        reportType: type,
        reason: reason,
        items: []
    };

    if (type === 'Missing') {
        if (!reportPo) {
            notifyWarning('Choose the purchase order the goods were missing from.', 'No purchase order');
            return;
        }
        data.poId = reportPo.po.po_id;

        for (let index = 0; index < reportPo.items.length; index++) {
            const item = reportPo.items[index];
            const tick = document.getElementById('report-po-tick-' + index);
            const howMany = document.getElementById('report-po-qty-' + index);
            if (tick && tick.checked) {
                data.items.push({ productId: item.product_id, quantity: readQuantity(howMany ? howMany.value : '') });
            }
        }
        if (data.items.length === 0) {
            notifyWarning('Tick at least one item that did not arrive.', 'Nothing to report');
            return;
        }
    } else {
        data.saleId = form.elements.saleId.value ? parseInt(form.elements.saleId.value, 10) : null;
        data.restock = form.elements.restock.value === 'true';

        if (reportItems.length === 0) {
            notifyWarning('Type a material\'s name and choose it from the list to add it to the report.', 'No material chosen');
            renderReportMaterialVerdict();
            return;
        }
        // a refund amount goes only with a refund or a plain return; a value typed
        // while one of those was chosen is not sent for a damage report
        const withRefund = type === 'Refunded' || type === 'Return';
        for (let i = 0; i < reportItems.length; i++) {
            const item = reportItems[i];
            data.items.push({
                productId: item.productId,
                quantity: readQuantity(item.quantity),
                refundAmount: withRefund ? (parseFloat(item.refund) || 0) : 0
            });
        }
    }

    if (reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }
    let badQuantity = false;
    for (let i = 0; i < data.items.length; i++) {
        if (!data.items[i].quantity || data.items[i].quantity <= 0) badQuantity = true;
    }
    if (badQuantity) {
        notifyWarning('Every item needs a quantity greater than zero.', 'Nothing was filed');
        return;
    }

    // a double press must not file the report twice
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;

    try {
        const response = await apiFileReportItems(data);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message + ' The manager has been notified.', 'Report filed');
        form.reset();
        reportItems = [];
        reportPo = null;
        reportPoTicks = {};
        clearReportMaterial(false);
        onReportTypeChange(form.elements.reportType.value);
        renderReportPoLines();
        // the stock figures have moved; the next search reads them afresh
        invLoaded = false;

        // The live channel skips this screen's own writes, so the lists that
        // show the new report (Returned Items) and the stock it moved read again here.
        const keys = ['clerk-returns', 'clerk-materials', 'clerk-reorder'];
        for (let i = 0; i < keys.length; i++) {
            const panel = getDataPanel(keys[i]);
            if (panel && panel.state === 'ready') await panel.refresh();
        }

        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    } finally {
        if (button) button.disabled = false;
    }
}

// ---------- Stock Adjustment: check a delivery against its purchase order ----------
// Read only: nothing here moves stock. Stock comes in when the delivery is
// received on its purchase order. What is short can be reported from here.
let poCheck = { poId: null, po: null, items: [] };

async function openPoCheck() {
    poCheck = { poId: null, po: null, items: [] };
    showPoCheckCard('<p class="detail-note">Loading the purchase orders...</p>');

    try {
        await loadPoChoices();
    } catch (error) {
        redrawPoCheck('<p class="detail-note detail-warn">The purchase orders could not be loaded. Close this and try again.</p>');
        return;
    }
    redrawPoCheck(poCheckPage());
}

// the card's one page; the card is still the open one while detailPages holds it
let poCheckPageObject = null;

function showPoCheckCard(body) {
    poCheckPageObject = { label: 'Check', body: body };

    // Make a Report is left out when the administrator has switched that screen off
    const reportButton = holdsFeature('damage-report')
        ? '<button type="button" class="btn btn-success" id="po-check-report" onclick="reportShortFromCheck()" disabled>Make a Report</button>'
        : '';

    openDetailModal('Check a Purchase Order', 'Compare a delivery with its order', 'PO',
        [poCheckPageObject],
        reportButton +
        '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\')">Close</button>',
        { wide: true, scroll: true });
}

// true while this card is the one open: it may have been closed, or another
// card opened, while a purchase order was loading
function poCheckIsOpen() {
    const modal = document.getElementById('detail-modal');
    return Boolean(modal && modal.classList.contains('open') &&
                   poCheckPageObject && detailPages[0] === poCheckPageObject);
}

// draws the card's page again without opening it again
function redrawPoCheck(body) {
    if (!poCheckIsOpen()) return;
    poCheckPageObject.body = body;
    renderDetailPage();
    updatePoCheckSummary();
}

function poCheckPage() {
    let html = '<p class="detail-note">This only compares the delivery with the order. It does not change ' +
        'the stock. When the delivery is counted in, press Receive on the purchase order.</p>' +
        '<div class="form-group">' +
            '<label for="check-po">Purchase order</label>' +
            '<select id="check-po" class="form-control" onchange="onPoCheckPick(this.value)">' +
                '<option value="">Choose a purchase order</option>' + poChoiceOptions(poCheck.poId) +
            '</select>' +
        '</div>';

    if (poChoices.length === 0) {
        html += '<p class="detail-note">There is no approved purchase order waiting for its delivery.</p>';
    }
    if (poCheck.po) html += poCheckLines();
    return html;
}

async function onPoCheckPick(value) {
    const poId = parseInt(value, 10);
    poCheck = { poId: poId || null, po: null, items: [] };

    if (poId) {
        poCheck.po = findPoChoice(poId) || null;
        try {
            const items = await apiGetPurchaseOrderItems(poId);
            // the card may have been closed, or another order chosen, while this one was loading
            if (!poCheckIsOpen() || poCheck.poId !== poId) return;
            poCheck.items = items;
        } catch (error) {
            redrawPoCheck(poCheckPage() + '<p class="detail-note detail-warn">That purchase order could not be opened. Try again.</p>');
            return;
        }
    }
    redrawPoCheck(poCheckPage());
}

// the order's items: what was ordered, a box for what arrived, and the check
function poCheckLines() {
    if (poCheck.items.length === 0) return '<p class="detail-empty">This order has no items.</p>';

    const rows = [];
    for (let index = 0; index < poCheck.items.length; index++) {
        const item = poCheck.items[index];
        const pack = recvPackOf(item);
        const unit = pack ? pack.name : (item.unit_name || '');
        rows.push([
            escapeHtml(item.product_name),
            escapeHtml(poQuantityText(item)),
            '<input type="number" class="form-control recv-qty" id="check-arrived-' + index + '" ' +
                   'min="0" step="1" value="' + recvOrderedCount(item) + '" ' +
                   'oninput="updatePoCheckLine(' + index + ')" ' +
                   'aria-label="Arrived: ' + escapeHtml(item.product_name) + '"> ' +
                   '<span class="muted">' + escapeHtml(unit) + '</span>',
            '<span class="recv-verdict is-exact" id="check-result-' + index + '">As ordered</span>'
        ]);
    }

    return detailTable(['Material', 'Ordered', 'Arrived', 'Check'], rows, [1, 2]) +
        '<p class="check-summary" id="check-summary" aria-live="polite"></p>';
}

// What one line came to: how many arrived against how many were ordered.
// "short" is in the line's own count (packs for a line ordered in packs);
// "shortBase" is the same in the material's unit, which is what a report holds.
function poCheckLineState(index) {
    const item = poCheck.items[index];
    const field = document.getElementById('check-arrived-' + index);
    const ordered = recvOrderedCount(item);
    const pack = recvPackOf(item);

    const typed = field ? field.value.trim() : '';
    const arrived = typed === '' ? ordered : Math.max(0, Number(typed) || 0);
    const short = typed === '' ? 0 : Math.max(0, ordered - arrived);

    return {
        item: item,
        ordered: ordered,
        arrived: arrived,
        blank: typed === '',
        short: short,
        shortBase: pack ? Math.round(short * pack.size * 1000) / 1000 : short
    };
}

function updatePoCheckLine(index) {
    const result = document.getElementById('check-result-' + index);
    if (result) {
        const state = poCheckLineState(index);
        const pack = recvPackOf(state.item);
        const unit = pack ? pack.name : (state.item.unit_name || '');

        if (state.blank) {
            result.className = 'recv-verdict is-exact';
            result.textContent = 'Type how many arrived.';
        } else if (state.short > 0) {
            result.className = 'recv-verdict is-short';
            result.textContent = 'Short by ' + qtyText(state.short, unit) +
                (pack ? ' (' + qtyText(state.shortBase, state.item.unit_name || '') + ')' : '');
        } else if (state.arrived > state.ordered) {
            result.className = 'recv-verdict is-over';
            result.textContent = qtyText(state.arrived - state.ordered, unit) + ' more than ordered';
        } else {
            result.className = 'recv-verdict is-exact';
            result.textContent = 'As ordered';
        }
    }
    updatePoCheckSummary();
}

// "Complete" or "N items short"; Make a Report works only when something is short
function updatePoCheckSummary() {
    const summary = document.getElementById('check-summary');
    const button = document.getElementById('po-check-report');

    let shortCount = 0;
    for (let index = 0; index < poCheck.items.length; index++) {
        if (poCheckLineState(index).short > 0) shortCount++;
    }

    if (summary) {
        if (shortCount === 0) {
            summary.className = 'check-summary is-complete';
            summary.textContent = 'Complete: every item arrived as ordered.';
        } else {
            summary.className = 'check-summary is-short';
            summary.textContent = shortCount + (shortCount === 1 ? ' item short.' : ' items short.');
        }
    }
    if (button) button.disabled = shortCount === 0;
}

// Make a Report: closes the card and opens the report with what is short
function reportShortFromCheck() {
    const shortLines = [];
    for (let index = 0; index < poCheck.items.length; index++) {
        const state = poCheckLineState(index);
        if (state.short > 0) shortLines.push(state);
    }
    if (shortLines.length === 0 || !poCheck.po) return;

    const po = poCheck.po;
    const items = poCheck.items;

    closeModal('detail-modal');
    showDamageReport();
    startMissingReport(po, items, shortLines);
}

// ---------- Stock Adjustment: the Reference card ----------
// A received purchase order, each line with what was ordered beside what
// arrived, so the clerk can see the right goods came in. Read only.
// choices: the received orders, newest first; data: the open order's reference;
// search: what is typed in the box above the list
let poReference = { poId: null, choices: [], data: null, search: '' };

// the card's one page; the card is still the open one while detailPages holds it
let poReferencePageObject = null;

// poId: optional; the order to open on (an Adjustment History entry names one).
// Without it the card opens on the newest received order.
async function openPoReference(poId) {
    poReference = { poId: poId || null, choices: [], data: null, search: '' };
    poReferencePageObject = { label: 'Reference', body: '<p class="detail-note">Loading the purchase orders...</p>' };
    openDetailModal('Purchase Order Reference', 'What was ordered beside what arrived', 'PO',
        [poReferencePageObject],
        '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\')">Close</button>',
        { wide: true, scroll: true });

    try {
        const rows = await apiGetPurchaseOrders();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].status === 'Received') poReference.choices.push(rows[i]);
        }
    } catch (error) {
        redrawPoReference('<p class="detail-note detail-warn">The purchase orders could not be loaded. Close this and try again.</p>');
        return;
    }

    if (!poReference.poId) poReference.poId = lastReceivedPoId(poReference.choices);
    await onPoReferencePick(poReference.poId);
}

// the order counted in most lately; an order received before the day was kept
// has none, and comes after every one that has it
function lastReceivedPoId(orders) {
    let latest = null;
    for (let i = 0; i < orders.length; i++) {
        const when = String(orders[i].received_at || '');
        if (latest === null || when > String(latest.received_at || '')) latest = orders[i];
    }
    return latest ? latest.po_id : null;
}

// true while this card is the one open: it may have been closed, or another
// card opened, while an order was loading
function poReferenceIsOpen() {
    const modal = document.getElementById('detail-modal');
    return Boolean(modal && modal.classList.contains('open') &&
                   poReferencePageObject && detailPages[0] === poReferencePageObject);
}

// draws the card's page again without opening it again
function redrawPoReference(body) {
    if (!poReferenceIsOpen()) return;
    poReferencePageObject.body = body;
    renderDetailPage();
    filterPoReference(poReference.search);   // a search typed before an order was picked still applies

    // the list scrolls on its own; keep the open order in view
    const picked = document.querySelector('.po-ref-list .is-picked');
    if (picked) picked.scrollIntoView({ block: 'nearest' });
}

async function onPoReferencePick(value) {
    const poId = parseInt(value, 10);
    poReference.poId = poId || null;
    poReference.data = null;

    if (poId) {
        redrawPoReference(poReferencePage('<p class="detail-note">Opening the order...</p>'));
        try {
            const data = await apiGetPurchaseOrderReference(poId);
            // the card may have been closed, or another order chosen, while this one was loading
            if (!poReferenceIsOpen() || poReference.poId !== poId) return;
            poReference.data = data;
        } catch (error) {
            redrawPoReference(poReferencePage('<p class="detail-note detail-warn">That purchase order could not be opened. Try again.</p>'));
            return;
        }
    }
    redrawPoReference(poReferencePage());
}

// Two columns: every received order on the left, the open one marked; the
// open order on the right. Clicking an order on the left opens it.
// message: optional, shown on the right instead of the order (loading, failed)
function poReferencePage(message) {
    if (poReference.choices.length === 0) {
        return '<p class="detail-note">No purchase order has been received yet. ' +
            'Press Receive on a purchase order when its delivery is counted in.</p>';
    }

    let list = '';
    for (let i = 0; i < poReference.choices.length; i++) {
        const po = poReference.choices[i];
        const picked = po.po_id === poReference.poId;
        // an order received before the day was kept has no date; its order date is shown
        const when = po.received_at
            ? 'Received ' + poWhen(po.received_at).slice(0, 10)
            : 'Ordered ' + poWhen(po.order_date).slice(0, 10);
        // what the search box matches: the number and the supplier
        const words = ('PO #' + po.po_id + ' ' + po.po_id + ' ' + po.supplier_name).toLowerCase();
        list += '<button type="button" class="po-ref-item' + (picked ? ' is-picked' : '') + '" ' +
                'data-search="' + escapeHtml(words) + '" ' +
                'onclick="onPoReferencePick(' + po.po_id + ')">' +
            '<span class="po-ref-no">PO #' + po.po_id + '</span>' +
            '<span class="po-ref-supplier">' + escapeHtml(po.supplier_name) + '</span>' +
            '<span class="po-ref-when">' + escapeHtml(when) + '</span>' +
            '</button>';
    }

    let main = message || '';
    if (!main && poReference.data) main = poReferenceDetails(poReference.data);
    if (!main) main = '<p class="detail-note">Pick an order on the left to see it.</p>';

    return '<div class="po-ref">' +
            '<div class="po-ref-side">' +
                '<p class="po-ref-head">Received orders (' + poReference.choices.length + ')</p>' +
                '<input type="search" class="form-control po-ref-search" id="po-ref-search" ' +
                    'placeholder="Search PO number or supplier" autocomplete="off" ' +
                    'value="' + escapeHtml(poReference.search) + '" oninput="filterPoReference(this.value)">' +
                '<div class="po-ref-list">' + list +
                    '<p class="po-ref-none" id="po-ref-none" hidden>No order matches that search.</p>' +
                '</div>' +
            '</div>' +
            '<div class="po-ref-main">' + main + '</div>' +
        '</div>';
}

// hides the orders the search does not match; the list is not drawn again,
// so the box keeps its cursor while typing
function filterPoReference(text) {
    poReference.search = text;
    const wanted = String(text || '').trim().toLowerCase();
    const items = document.querySelectorAll('.po-ref-list .po-ref-item');
    let shown = 0;
    for (let i = 0; i < items.length; i++) {
        const match = wanted === '' || items[i].getAttribute('data-search').indexOf(wanted) !== -1;
        items[i].hidden = !match;
        if (match) shown++;
    }
    const none = document.getElementById('po-ref-none');
    if (none) none.hidden = shown > 0;
}

// one fact beside another: "Ordered" over its date and who raised it
function poReferenceFact(label, when, who) {
    return '<div class="po-ref-fact">' +
            '<span class="po-ref-fact-label">' + label + '</span>' +
            '<span class="po-ref-fact-value">' + when + '</span>' +
            (who ? '<span class="po-ref-fact-who">by ' + escapeHtml(who) + '</span>' : '') +
        '</div>';
}

// the order's name, when it was ordered and received, a one-line verdict, then
// each material with what was ordered and what arrived
function poReferenceDetails(data) {
    const order = data.order;

    let rows = '';
    let differs = 0;
    for (let i = 0; i < data.lines.length; i++) {
        const line = data.lines[i];
        const check = poReferenceCheck(line, data.kept);
        if (check.differs) differs++;

        const ordered = line.ordered
            ? escapeHtml(poQuantityText(line.ordered))
            : '<span class="muted">' + (data.kept ? 'Not ordered' : 'Not recorded') + '</span>';
        const received = line.received
            ? escapeHtml(poQuantityText(line.received))
            : escapeHtml(qtyText(0, line.unit_name || ''));

        rows += '<tr' + (check.differs ? ' class="po-ref-differs"' : '') + '>' +
            '<td>' + escapeHtml(line.product_name) + '</td>' +
            '<td class="cell-num">' + ordered + '</td>' +
            '<td class="cell-num">' + received + '</td>' +
            '<td><span class="badge ' + check.badge + '">' + escapeHtml(check.text) + '</span></td>' +
            '</tr>';
    }

    // the verdict comes first, so the answer is read before the details
    let verdict;
    if (!data.kept) {
        verdict = '<p class="po-ref-verdict is-old"><i class="bi bi-info-circle" aria-hidden="true"></i>' +
            'Received before the system kept what was ordered, so only what arrived is shown.</p>';
    } else if (differs === 0) {
        verdict = '<p class="po-ref-verdict is-complete"><i class="bi bi-check-circle" aria-hidden="true"></i>' +
            'Complete: all ' + data.lines.length + (data.lines.length === 1 ? ' item' : ' items') +
            ' arrived as ordered.</p>';
    } else {
        verdict = '<p class="po-ref-verdict is-short"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i>' +
            differs + ' of ' + data.lines.length + ' items ' + (differs === 1 ? 'differs' : 'differ') +
            ' from the order. They are shaded below.</p>';
    }

    return '<h4 class="po-ref-title">PO #' + order.po_id + ' · ' + escapeHtml(order.supplier_name) + '</h4>' +
        '<div class="po-ref-facts">' +
            poReferenceFact('Ordered', escapeHtml(poWhen(order.order_date)), order.raised_by) +
            poReferenceFact('Received', order.received_at
                ? escapeHtml(poWhen(order.received_at))
                : '<span class="muted">Not recorded</span>', order.received_by) +
        '</div>' +
        verdict +
        '<div class="table-responsive"><table class="mini-table po-ref-table">' +
            '<thead><tr><th>Material</th><th class="col-num">Ordered</th><th class="col-num">Received</th><th>Check</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>';
}

// What one line came to, in the material's own unit: as ordered, short,
// more than ordered, not ordered at all, or did not arrive.
// badge: the colour of its label (green as ordered, amber short, red missing)
function poReferenceCheck(line, kept) {
    const unit = line.unit_name || '';
    if (!kept) return { text: 'Arrived', badge: 'badge-neutral', differs: false };
    if (!line.ordered) return { text: 'Not on the order', badge: 'badge-info', differs: true };
    if (!line.received) return { text: 'Did not arrive', badge: 'badge-danger', differs: true };

    const difference = Number(line.received.quantity) - Number(line.ordered.quantity);
    if (difference < 0) return { text: 'Short by ' + qtyText(-difference, unit), badge: 'badge-warning', differs: true };
    if (difference > 0) return { text: qtyText(difference, unit) + ' more than ordered', badge: 'badge-info', differs: true };
    return { text: 'As ordered', badge: 'badge-success', differs: false };
}

// ---------- archive ----------
function buildInventoryArchivePanel() {
    createDataPanel({
        key: 'clerk-archive',
        tableId: 'arch-table',
        columns: 5,
        pagerId: 'arch-pager',
        idField: 'product_id',

        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for materials that have been taken out of circulation.',
            button: 'Load Data'
        },

        load: function () {
            return apiGetArchivedProducts();
        },

        match: function (p, query) {
            return prefixMatch([p.product_name, p.category_name], query);
        },

        // a row opens a card with the material and the button that restores it
        renderRow: function (p, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openArchivedMaterial(' + p.product_id + ')" title="Open this material">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
            '<td class="cell-id">' + escapeHtml(p.archived_at || 'Unknown') + '</td></tr>';
        }
    });
}

// the card for an archived material; its foot holds the Restore button
function openArchivedMaterial(productId) {
    const panel = getDataPanel('clerk-archive');
    const p = panel ? panel.find(productId) : null;
    if (!p) return;

    const body = '<div class="detail-grid">' +
        detailField('Material', escapeHtml(p.product_name)) +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('On Hand', escapeHtml(String(p.quantity_in_stock))) +
        detailField('Archived On', escapeHtml(p.archived_at || 'Unknown')) +
        '</div>' +
        '<p class="detail-note">Restoring puts it back on the material list and makes it sellable again.</p>';

    const foot = '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\')">Cancel</button>' +
        '<button type="button" class="btn btn-success" id="restore-material-button" onclick="restoreMaterial(' + p.product_id + ')">Restore This Material</button>';

    openDetailModal(p.product_name, (p.category_name || 'Uncategorised') + ' · archived',
        initialsOf(p.product_name), [{ label: 'Archived Material', body: body }], foot);
}

// ---------- records: suppliers, products, categories and units ----------
// Categories and units are added here, by the inventory clerk alone (the server
// refuses any other role). Suppliers are the manager's to add.
let clerkRecordType = 'supplier';

const CLERK_RECORD_COLUMNS = {
    supplier: [['name', 'Supplier'], ['contact_person', 'Contact'], ['contact_number', 'Number'], ['email', 'Email'], ['product_count', 'Products']],
    product:  [['name', 'Product'], ['category_name', 'Category'], ['brand_name', 'Brand'], ['price', 'Price'], ['quantity_in_stock', 'On Hand']],
    category: [['name', 'Category'], ['product_count', 'Products'], ['total_stock', 'Total Stock']],
    unit:     [['name', 'Unit'], ['product_count', 'Products']]
};

const CLERK_RECORD_TITLES = {
    supplier: 'Suppliers', product: 'Products', category: 'Categories', unit: 'Units'
};

// the columns that hold a figure: right-aligned, and sortable by size
const CLERK_RECORD_NUMERIC = ['product_count', 'price', 'quantity_in_stock', 'total_stock'];

function showClerkRecords(event) { showClerkRecordType(clerkRecordType, event); }

function showClerkRecordType(type, event) {
    if (!CLERK_RECORD_COLUMNS[type]) type = 'supplier';
    const changed = type !== clerkRecordType;
    clerkRecordType = type;

    const card = document.getElementById('panel-records');
    if (card) card.dataset.view = type;
    showInventoryPanel('panel-records', 'Records', event);

    const title = document.getElementById('records-title');
    if (title) title.textContent = CLERK_RECORD_TITLES[type];

    writeClerkRecordHeaders();
    syncClerkRecordAddButton();
    if (changed) fillClerkRecordSort();

    const panel = getDataPanel('clerk-records');
    if (!panel || !changed) return;

    // a table already open loads the new kind at once; a closed one stays closed
    if (panel.state === 'ready') panel.open();
    else panel.reset();
}

function writeClerkRecordHeaders() {
    const table = document.getElementById('records-table');
    if (!table) return;

    const columns = CLERK_RECORD_COLUMNS[clerkRecordType];
    let headers = '';
    for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const style = CLERK_RECORD_NUMERIC.indexOf(column[0]) !== -1 ? ' class="cell-num"' : '';
        headers += '<th' + style + '>' + column[1] + '</th>';
    }
    table.querySelector('thead tr').innerHTML = headers;

    const panel = getDataPanel('clerk-records');
    if (panel) {
        panel.config.columns = columns.length;
        panel.resetHeaderSort();   // the headers changed: forget the sort, mark the new ones
    }
}

// Products sort by All (name), Category or Brand; the others by name
function fillClerkRecordSort() {
    const select = document.getElementById('records-sort');
    if (!select) return;

    let options;
    if (clerkRecordType === 'product') {
        options = [['name-asc', 'All'], ['category_name-asc', 'Category'], ['brand_name-asc', 'Brand']];
    } else {
        options = [['name-asc', 'Name, A to Z'], ['name-desc', 'Name, Z to A']];
    }

    let optionsHtml = '';
    for (let i = 0; i < options.length; i++) {
        optionsHtml += '<option value="' + options[i][0] + '">' + escapeHtml(options[i][1]) + '</option>';
    }
    select.innerHTML = optionsHtml;
    select.value = 'name-asc';
    // set without loading: a closed table stays closed
    const panel = getDataPanel('clerk-records');
    if (panel) panel.setFilter('sort', 'name-asc');
}

function sortClerkRecordRows(rows, order) {
    const value = String(order || 'name-asc');
    const descending = value.endsWith('-desc');
    // the sort order without its "-asc" or "-desc" ending
    const key = value.replace(/-(asc|desc)$/, '');

    return rows.sort(function (a, b) {
        const byName = String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
        let result = byName;
        if (key === 'category_name' || key === 'brand_name') {
            // A to Z by category or brand, the ones not set last, then by name
            const first = String(a[key] || '');
            const second = String(b[key] || '');
            if (first === '' && second !== '') result = 1;
            else if (second === '' && first !== '') result = -1;
            else result = first.localeCompare(second) || byName;
        }
        return descending ? -result : result;
    });
}

function buildClerkRecordsPanel() {
    createDataPanel({
        key: 'clerk-records',
        remember: false,   // which kind of record it holds is not kept, so it opens closed
        tableId: 'records-table',
        columns: 5,
        pagerId: 'records-pager',
        gate: {
            title: 'No records loaded',
            text: 'Press Load Data to see these records.',
            button: 'Load Data'
        },
        filters: { sort: 'name-asc' },
        load: function () {
            return apiGetRecords(clerkRecordType);
        },
        match: function (row, query) {
            // every value in the record (a plain object from the server)
            const values = [];
            for (const name in row) values.push(row[name]);
            return prefixMatch(values, query);
        },
        sort: function (rows, filters) {
            return sortClerkRecordRows(rows, filters.sort);
        },

        // a row opens a card with the whole record
        renderRow: function (row, index) {
            let cells = '';
            const columns = CLERK_RECORD_COLUMNS[clerkRecordType];
            for (let position = 0; position < columns.length; position++) {
                const column = columns[position];
                const value = row[column[0]];
                let shown;
                if (column[0] === 'price') shown = peso(value);
                else if (value === null || value === undefined || value === '') shown = '<span class="muted">Not set</span>';
                else shown = escapeHtml(value);

                let style = '';
                if (position === 0) style = 'cell-name';
                else if (CLERK_RECORD_NUMERIC.indexOf(column[0]) !== -1) style = 'cell-num';

                cells += '<td class="' + style + '">' + shown + '</td>';
            }

            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openClerkRecord(' + index + ')" title="Open this record">' +
                cells + '</tr>';
        }
    });
}

// ---------- adding a category or a unit (the clerk's alone) ----------
const CLERK_RECORD_ADDABLE = {
    category: { title: 'Add Category', label: 'Category name', max: 50 },
    unit:     { title: 'Add Unit', label: 'Unit name', max: 20 }
};

// the Add button names the kind on screen, and goes for suppliers and products
function syncClerkRecordAddButton() {
    const button = document.getElementById('clerk-records-add');
    if (!button) return;
    const kind = CLERK_RECORD_ADDABLE[clerkRecordType];
    button.hidden = !kind;
    if (kind) button.textContent = kind.title;
}

async function addClerkRecord() {
    const type = clerkRecordType;
    const kind = CLERK_RECORD_ADDABLE[type];
    if (!kind) return;

    const typed = await askInput({
        title: kind.title,
        eyebrow: 'Records',
        message: 'The name must not already be on file.',
        label: kind.label,
        confirmLabel: 'Save',
        check: function (value) {
            const name = String(value || '').trim();
            if (name === '') return kind.label + ' is required.';
            if (name.length > kind.max) return 'At most ' + kind.max + ' characters.';
            return null;
        }
    });
    if (typed === false || typed === null || typed === undefined) return;

    try {
        const response = await apiAddCategoryOrUnit(type, String(typed).trim());
        const body = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, body)) notifyError(body.error, 'Not added');
            return;
        }
        notifySuccess(body.message, kind.title.replace('Add ', '') + ' added');
        const panel = getDataPanel('clerk-records');
        if (panel) await panel.open();
    } catch (error) {
        notifyOffline();
    }
}

// the fields a record's card shows, in order
const CLERK_RECORD_FIELDS = {
    supplier: [['contact_person', 'Contact Person'], ['contact_number', 'Contact Number'], ['email', 'Email'],
               ['address', 'Address'], ['product_count', 'Products']],
    product:  [['category_name', 'Category'], ['brand_name', 'Brand'], ['unit_name', 'Unit'],
               ['supplier_name', 'Supplier'], ['price', 'Price'], ['quantity_in_stock', 'On Hand'],
               ['reorder_point', 'Reorder Point'], ['status', 'Status']],
    category: [['product_count', 'Products'], ['total_stock', 'Total Stock']],
    unit:     [['product_count', 'Products']]
};

function openClerkRecord(index) {
    const panel = getDataPanel('clerk-records');
    const row = panel ? panel.visible[index] : null;
    if (!row) return;

    let fields = '';
    const fieldList = CLERK_RECORD_FIELDS[clerkRecordType];
    for (let i = 0; i < fieldList.length; i++) {
        const field = fieldList[i];
        const value = row[field[0]];
        let shown;
        if (value === null || value === undefined || value === '') shown = '<span class="muted">Not set</span>';
        else if (field[0] === 'price') shown = peso(value);
        else if (field[0] === 'status') shown = statusBadge(String(value));
        else shown = escapeHtml(value);
        fields += detailField(field[1], shown);
    }

    const body = '<div class="detail-grid">' +
        detailField('Record ID', '#' + row.id) +
        detailField('Name', escapeHtml(row.name)) +
        fields + '</div>';

    // the plural title made singular: "Categories" becomes "Category", "Suppliers" becomes "Supplier"
    const kind = CLERK_RECORD_TITLES[clerkRecordType].replace(/ies$/, 'y').replace(/s$/, '');
    openDetailModal(row.name, kind + ' record', initialsOf(row.name), [{ label: 'Details', body: body }]);
}

async function archiveMaterial(productId) {
    const yes = await askConfirm(
        'Are you sure you want to archive this material? Once archived, it will no longer show in the POS ' +
        'or in Inventory. It moves to the Archive screen, where it can be restored at any time.',
        { title: 'Archive this material?', eyebrow: 'Inventory', confirmLabel: 'Archive it', tone: 'danger' });

    if (!yes) return;

    try {
        const response = await apiArchiveMaterial(productId);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess('It drops off the material list until it is restored.', 'Material archived');
        closeModal('detail-modal');
        invLoaded = false;

        const keys = ['clerk-materials', 'clerk-archive', 'clerk-reorder'];
        for (let i = 0; i < keys.length; i++) {
            const panel = getDataPanel(keys[i]);
            if (panel && panel.state === 'ready') await panel.refresh();
        }

        await loadStockBanner();
    } catch (error) {
        notifyOffline();
    }
}

async function restoreMaterial(productId) {
    const yes = await askConfirm(
        'It goes back onto the material list and becomes sellable again.',
        { title: 'Restore this material?', eyebrow: 'Inventory', confirmLabel: 'Restore it' });

    if (!yes) return;

    // the button stays off while the request is out, so it cannot be sent twice
    const button = document.getElementById('restore-material-button');
    if (button) button.disabled = true;

    try {
        const response = await apiRestoreMaterial(productId);
        const result = await response.json();
        if (!response.ok) {
            if (button) button.disabled = false;
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        notifySuccess('It is back on the material list.', 'Material restored');
        closeModal('detail-modal');
        invLoaded = false;

        // the material list and the reorder list read it again, as after archiving
        const keys = ['clerk-materials', 'clerk-archive', 'clerk-reorder'];
        for (let i = 0; i < keys.length; i++) {
            const panel = getDataPanel(keys[i]);
            if (panel && panel.state === 'ready') await panel.refresh();
        }

        await loadStockBanner();
    } catch (error) {
        if (button) button.disabled = false;
        notifyOffline();
    }
}

// ---------- popups ----------
function openMaterialDetail(productId) {
    const p = findProductById(productId);
    if (!p) return;

    const unit = escapeHtml(p.unit_name || '');

    // first page: who supplies it and how to reach them, then what it is
    let supplierBlock;
    if (p.supplier_name) {
        const phone = p.contact_number
            // /[^\d+]/g matches every character that is not a digit or a plus sign (so only digits and + stay in the phone link)
            ? '<a href="tel:' + escapeHtml(String(p.contact_number).replace(/[^\d+]/g, '')) + '">' +
              escapeHtml(p.contact_number) + '</a>'
            : '<span class="muted">Not set</span>';
        const email = p.supplier_email
            ? '<a href="mailto:' + escapeHtml(p.supplier_email) + '">' + escapeHtml(p.supplier_email) + '</a>'
            : '<span class="muted">Not set</span>';

        supplierBlock =
            '<div class="supplier-panel">' +
                '<p class="supplier-panel-eyebrow">Supplied by</p>' +
                '<p class="supplier-panel-name">' + escapeHtml(p.supplier_name) + '</p>' +
                '<div class="detail-grid">' +
                    detailField('Contact Person', p.contact_person ? escapeHtml(p.contact_person) : '<span class="muted">Not set</span>') +
                    detailField('Contact Number', phone) +
                    detailField('Email', email) +
                    detailField('Address', p.supplier_address ? escapeHtml(p.supplier_address) : '<span class="muted">Not set</span>') +
                '</div>' +
            '</div>';
    } else {
        supplierBlock = '<p class="detail-empty">No supplier on file for this material. Raising a purchase ' +
            'order for it from a company records one.</p>';
    }

    const overview = supplierBlock +
        '<div class="detail-grid">' +
            detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
            detailField('Brand', escapeHtml(p.brand_name || 'No brand')) +
            detailField('Unit Price', priceOrBadge(p) + ' <span class="muted">per ' + escapeHtml(p.unit_name || 'unit') + '</span>') +
            detailField('On Hand', p.quantity_in_stock + ' ' + unit + ' ' + statusBadge(p.stock_status)) +
        '</div>';

    const stock = '<div class="detail-grid">' +
        detailField('Product ID', '#' + p.product_id) +
        detailField('On Hand', p.quantity_in_stock + ' ' + unit) +
        detailField('Reorder Point', p.reorder_point + ' ' + unit) +
        detailField('Stock Status', statusBadge(p.stock_status)) +
        detailField('Suggested Order', p.suggested_order + ' ' + unit) +
        detailField('Stock Value', peso(p.stock_value)) +
        detailField('Last Updated', escapeHtml(p.last_updated || 'Never')) +
        detailField('Added On', escapeHtml(p.created_at || 'Unknown')) +
        '</div>' +
        (p.stock_status !== 'In Stock'
            ? '<p class="detail-note detail-warn">This material is at or below its reorder point. The manager has been notified.</p>' : '') +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-danger" onclick="archiveMaterial(' + p.product_id + ')">Archive This Material</button>' +
        '</div>';

    openDetailModal(p.product_name,
        (p.supplier_name ? p.supplier_name : 'No supplier') + ' · ' + (p.category_name || 'Uncategorised'),
        initialsOf(p.product_name), [
            { label: 'Stock', body: stock },
            { label: 'Overview', body: overview },
            { label: 'Selling Units', body: sellingUnitsPage(p) },
            { label: 'Delivered In', body: deliveryPackPage(p) }
        ]);
}

// ---------- the pack a material is delivered in ----------
// Nails are kept by the kilogram but arrive by the box, twenty kilogram to
// the box. The clerk sets that here; the order form and the receiving sheet
// then count in boxes and the shelf still moves in kilograms. It is not a
// selling size: the shop's own box of nails is on the Selling Units page.
function deliveryPackPage(p) {
    const own = p.unit_name || 'unit';
    const has = p.pack_name && Number(p.pack_size) > 0;

    let now;
    if (has) {
        now = '<p class="detail-note">Delivered by the <strong>' + escapeHtml(p.pack_name) + '</strong> of ' +
              escapeHtml(qtyText(p.pack_size, own)) + '. A purchase order for it is written in ' +
              escapeHtml(p.pack_name) + 'es and the delivery is counted in the same way; ' +
              escapeHtml(qtyText(p.pack_size, own)) + ' goes on the shelf for each one.</p>';
    } else {
        now = '<p class="detail-empty">Delivered by the ' + escapeHtml(own) + ': an order for it is written in ' +
              escapeHtml(own) + '. If the supplier sends it in a bigger pack, say so below.</p>';
    }

    return now +
        '<form class="unit-size-form" onsubmit="saveDeliveryPack(event, ' + p.product_id + ')" autocomplete="off">' +
            '<div class="unit-size-fields">' +
                '<div class="form-group">' +
                    '<label for="pack-name-' + p.product_id + '">Pack</label>' +
                    '<input type="text" class="form-control" id="pack-name-' + p.product_id + '" name="packName" ' +
                        'list="unit-size-names" maxlength="20" placeholder="box, sack, drum" ' +
                        'value="' + escapeHtml(p.pack_name || '') + '">' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="pack-size-' + p.product_id + '">Holds</label>' +
                    '<div class="unit-size-per">' +
                        '<input type="number" class="form-control" id="pack-size-' + p.product_id + '" name="packSize" ' +
                            'min="0.001" step="0.001" placeholder="20" value="' + (has ? Number(p.pack_size) : '') + '">' +
                        '<span class="unit-size-own">' + escapeHtml(own) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="detail-actions">' +
                '<button type="submit" class="btn btn-accent">' + (has ? 'Change the pack' : 'Set the pack') + '</button>' +
                (has ? '<button type="button" class="btn btn-ghost" onclick="clearDeliveryPack(' + p.product_id + ')">' +
                       'Delivered by the ' + escapeHtml(own) + ' again</button>' : '') +
            '</div>' +
        '</form>';
}

async function saveDeliveryPack(event, productId) {
    event.preventDefault();
    const form = event.target;
    const packName = form.elements.packName.value.trim();
    const packSize = Number(form.elements.packSize.value);

    if (packName === '') { notifyWarning('Name the pack: box, sack, drum.', 'No pack named'); form.elements.packName.focus(); return; }
    if (!Number.isFinite(packSize) || packSize <= 0) {
        notifyWarning('Say how much one ' + packName + ' holds, like 20.', 'No size given');
        form.elements.packSize.focus();
        return;
    }
    await putDeliveryPack(productId, packName, packSize);
}

async function clearDeliveryPack(productId) {
    await putDeliveryPack(productId, '', null);
}

async function putDeliveryPack(productId, packName, packSize) {
    try {
        const response = await apiSaveDeliveryPack(productId, packName, packSize);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message, 'Delivery pack saved');

        const p = findProductById(productId);
        if (p) {
            p.pack_name = result.packName;
            p.pack_size = result.packSize;
            const page = findDetailPage('Delivered In');
            if (page) {
                page.body = deliveryPackPage(p);
                if (detailPages[detailIndex] === page) renderDetailPage();
            }
        }
        if (typeof poMaterialsLoaded !== 'undefined') poMaterialsLoaded = false;   // the order form reads it afresh
    } catch (error) {
        notifyOffline();
    }
}

// ---------- the sizes a material also sells in ----------
// Stock stays in the material's own unit; a size here says one "sack" is 25
// of it, at its own price (or the unit price times 25 when none is typed).
// The till offers the sizes beside the unit. Sales already written keep
// their own copy, so removing a size changes nothing sold.
function sellingUnitsPage(p) {
    // (the table rows for the sizes are built by sizeRows, just below this function)
    const own = p.unit_name || 'unit';
    const sizes = Array.isArray(p.selling_units) ? p.selling_units : [];

    // the size names offered while typing a new size
    const sizeNames = ['box', 'pack', 'sack', 'bag', 'bundle', 'roll', 'set', 'dozen', 'pallet', 'length', 'sheet', 'gallon'];
    let sizeNameOptions = '';
    for (let i = 0; i < sizeNames.length; i++) {
        sizeNameOptions += '<option value="' + sizeNames[i] + '">';
    }

    let list;
    if (sizes.length === 0) {
        list = '<p class="detail-empty">Sold only by the ' + escapeHtml(own) + '. Add a bigger size below if it ' +
              'also goes out by the box, pack or sack.</p>';
    } else {
        list = '<div class="table-responsive"><table class="mini-table unit-sizes-table"><thead><tr>' +
              '<th>Size</th><th class="col-num">Holds</th><th class="col-num">Price</th></tr></thead><tbody>' +
              sizeRows(p, sizes, own) + '</tbody></table></div>';
    }

    return '<p class="detail-note">Kept by the <strong>' + escapeHtml(own) + '</strong> at ' + peso(p.price) +
        ' each. A size sells a fixed number of them at once, and stock still comes off by the ' +
        escapeHtml(own) + '.</p>' +
        list +
        '<form class="unit-size-form" onsubmit="addSellingUnit(event, ' + p.product_id + ')" autocomplete="off">' +
            '<div class="unit-size-fields">' +
                '<div class="form-group">' +
                    '<label for="size-name-' + p.product_id + '">Size</label>' +
                    '<input type="text" class="form-control" id="size-name-' + p.product_id + '" name="unitName" ' +
                        'list="unit-size-names" maxlength="20" placeholder="box, pack, sack" required>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="size-per-' + p.product_id + '">Holds</label>' +
                    '<div class="unit-size-per">' +
                        '<input type="number" class="form-control" id="size-per-' + p.product_id + '" name="unitsPer" ' +
                            'min="0.001" step="0.001" placeholder="25" required>' +
                        '<span class="unit-size-own">' + escapeHtml(own) + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="size-price-' + p.product_id + '">Price <span class="label-hint">optional</span></label>' +
                    '<input type="number" class="form-control" id="size-price-' + p.product_id + '" name="price" ' +
                        'min="0" step="0.01" placeholder="' + escapeHtml(own) + ' price x holds">' +
                '</div>' +
            '</div>' +
            '<datalist id="unit-size-names">' + sizeNameOptions + '</datalist>' +
            '<div class="detail-actions"><button type="submit" class="btn btn-accent">Add this size</button></div>' +
        '</form>';
}

// the table rows of the sizes a material sells in; a row removes its size
function sizeRows(p, sizes, own) {
    let rows = '';
    for (let i = 0; i < sizes.length; i++) {
        const u = sizes[i];
        const each = u.price === null || u.price === undefined
            ? Math.round(Number(p.price) * Number(u.units_per) * 100) / 100 : Number(u.price);
        rows += '<tr class="row-clickable" title="Press to stop selling by this size" ' +
            'onclick="removeSellingUnit(' + p.product_id + ', ' + Number(u.product_unit_id) + ')">' +
            '<td><strong>' + escapeHtml(u.unit_name) + '</strong></td>' +
            '<td class="cell-num">' + escapeHtml(qtyText(u.units_per, own)) + '</td>' +
            '<td class="cell-num">' + peso(each) +
                (u.price === null || u.price === undefined
                    ? ' <span class="muted" title="The unit price times what it holds">worked out</span>' : '') + '</td>' +
        '</tr>';
    }
    return rows;
}

// The page of the open card with this label, or undefined when it has none.
function findDetailPage(label) {
    for (let i = 0; i < detailPages.length; i++) {
        if (detailPages[i].label === label) return detailPages[i];
    }
    return undefined;
}

// the card is redrawn on its Selling Units page once the list comes back
function refreshSellingUnitsPage(productId, units) {
    const p = findProductById(productId);
    if (!p) return;
    p.selling_units = units;

    const page = findDetailPage('Selling Units');
    if (page) {
        page.body = sellingUnitsPage(p);
        if (detailPages[detailIndex] === page) renderDetailPage();
    }
}

async function addSellingUnit(event, productId) {
    event.preventDefault();
    const form = event.target;

    const unitName = form.elements.unitName.value.trim();
    const unitsPer = Number(form.elements.unitsPer.value);
    const price = form.elements.price.value.trim();

    if (unitName === '') { notifyWarning('Name the size: box, pack, sack.', 'No size named'); form.elements.unitName.focus(); return; }
    if (!(unitsPer > 0)) { notifyWarning('Say how many it holds.', 'Nothing to hold'); form.elements.unitsPer.focus(); return; }

    try {
        const response = await apiAddSellingUnit(productId, unitName, unitsPer, price);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error, 'Size not added'); return; }

        notifySuccess(result.message, 'Size added');
        refreshSellingUnitsPage(productId, result.units || []);
    } catch (error) {
        notifyOffline();
    }
}

async function removeSellingUnit(productId, unitId) {
    const p = findProductById(productId);
    let unit;
    if (p && Array.isArray(p.selling_units)) {
        unit = undefined;
        for (let i = 0; i < p.selling_units.length; i++) {
            if (Number(p.selling_units[i].product_unit_id) === unitId) {
                unit = p.selling_units[i];
                break;
            }
        }
    } else {
        unit = null;
    }

    const yes = await askConfirm(
        'The till stops offering it. Sales already written in it are not changed.',
        { title: 'Stop selling by the ' + (unit ? unit.unit_name : 'size') + '?', eyebrow: 'Inventory',
          confirmLabel: 'Remove the size', tone: 'danger' });
    if (!yes) return;

    try {
        const response = await apiRemoveSellingUnit(productId, unitId);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error, 'Size not removed'); return; }

        notifySuccess(result.message, 'Size removed');
        refreshSellingUnitsPage(productId, result.units || []);
    } catch (error) {
        notifyOffline();
    }
}

// the panel holds the rows, so the panel is what it asks
function openAdjustmentDetail(adjustmentId) {
    const panel = getDataPanel('clerk-adjustments');
    const a = panel ? panel.find(adjustmentId) : null;
    if (!a) return;

    const unit = a.unit_name ? ' ' + escapeHtml(a.unit_name) : '';

    const change = '<div class="detail-grid">' +
        detailField('Adjustment ID', '#' + a.adjustment_id) +
        detailField('Material', escapeHtml(a.product_name)) +
        detailField('Type', statusBadge(a.adjustment_type)) +
        detailField('Counted In', a.unit_name
            ? escapeHtml(a.unit_name)
            : '<span class="muted">Not recorded</span>') +
        detailField('Before', a.quantity_before + unit) +
        detailField('Change', (a.quantity_change > 0 ? '+' : '') + a.quantity_change + unit) +
        detailField('After', a.quantity_after + unit) +
        '</div>' +
        // the entry keeps saying what it counted even if the unit changed since
        (a.current_unit && a.unit_name &&
         String(a.current_unit).toLowerCase() !== String(a.unit_name).toLowerCase()
            ? '<p class="detail-note detail-warn">This material is counted in ' +
              escapeHtml(a.current_unit) + ' now. This entry counted ' +
              escapeHtml(a.unit_name) + ', and says so.</p>'
            : '');

    const why = '<div class="detail-grid">' +
        detailField('Adjusted By', escapeHtml(a.adjusted_by)) +
        detailField('When', escapeHtml(a.created_at)) +
        '</div><p class="detail-note">' + escapeHtml(a.reason) + '</p>';

    // stock that came in on a purchase order opens that order's Reference card,
    // when Purchase Order Reference is switched on in Access Control
    const fromOrder = /^Received on purchase order #(\d+)/.exec(a.reason || '');
    const footActions = fromOrder && holdsFeature('po-reference')
        ? '<button type="button" class="btn btn-ghost" onclick="openPoReference(' + Number(fromOrder[1]) + ')">Reference</button>'
        : '';

    openDetailModal('Adjustment #' + a.adjustment_id, a.product_name + ' · ' + a.adjustment_type,
        'A' + a.adjustment_id, [
            { label: 'Change', body: change },
            { label: 'Reason', body: why }
        ], footActions);
}

function openReturnDetail(returnId) {
    const panel = getDataPanel('clerk-returns');
    const r = panel ? panel.find(returnId) : null;
    if (!r) return;

    const missing = r.report_type === 'Missing';

    const report = '<div class="detail-grid">' +
        detailField('Report ID', '#' + r.return_id) +
        detailField('Type', statusBadge(r.report_type)) +
        detailField('Material', escapeHtml(r.product_name)) +
        detailField(missing ? 'Quantity Missing' : 'Quantity', r.quantity + ' ' + escapeHtml(r.unit_name || '')) +
        // goods that never arrived have no sale and no refund
        (missing ? detailField('Purchase Order', '#' + r.po_id) : detailField('Refund Amount', peso(r.refund_amount))) +
        detailField('Status', statusBadge(r.status)) +
        '</div>' +
        (missing && r.status === 'Open'
            ? '<p class="detail-note">These goods were ordered but never arrived. Mark the report resolved once the supplier has made it good.</p>'
            : '');

    const awaiting = returnAwaiting(r);

    // the inspection sits on the first tab, where a pressed row lands
    let inspection;
    if (awaiting) {
        inspection = '<p class="detail-note">The counter took this back and refunded it. Look at the goods: can they be sold again?</p>' +
              '<div class="form-group">' +
                  '<label for="inspect-note">What you found <span class="label-hint">optional</span></label>' +
                  '<input type="text" id="inspect-note" class="form-control" maxlength="255" ' +
                         'placeholder="Box unopened, seals intact." onclick="event.stopPropagation()">' +
              '</div>' +
              '<div class="detail-actions">' +
                  '<button type="button" class="btn btn-success" onclick="inspectReturn(' + r.return_id + ', \'Return to Stock\')">' +
                      'Sellable &mdash; back on the shelf</button>' +
                  '<button type="button" class="btn btn-danger" onclick="inspectReturn(' + r.return_id + ', \'Write-Off\')">' +
                      'Not sellable &mdash; write it off</button>' +
              '</div>';
    } else if (r.status === 'Open') {
        inspection = '<div class="detail-actions"><button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); resolveReturn(' + r.return_id + ')">Mark Resolved</button></div>';
    } else {
        inspection = '';
    }

    // what the Inspected field says when nobody has inspected the goods
    let notInspected;
    if (awaiting) {
        notInspected = 'Not yet';
    } else if (missing) {
        notInspected = 'Nothing to inspect';
    } else {
        notInspected = 'Decided when filed';
    }

    const context = '<div class="detail-grid">' +
        detailField('Filed By', escapeHtml(r.reported_by)) +
        detailField('Filed On', escapeHtml(r.return_date)) +
        (missing
            ? detailField('Purchase Order', '#' + r.po_id)
            : detailField('From Sale', r.sale_id ? '#' + r.sale_id : '<span class="muted">Not from a sale</span>')) +
        detailField('Goods Went', returnDispositionBadge(r)) +
        detailField('Inspected', r.inspected_by
            ? escapeHtml(r.inspected_by) + ' <span class="muted">' + escapeHtml(String(r.inspected_at || '').slice(0, 16)) + '</span>'
            : '<span class="muted">' + notInspected + '</span>') +
        '</div>' +
        '<p class="detail-note">' + escapeHtml(r.reason || 'No reason given.') + '</p>' +
        (r.inspection_note
            ? '<p class="detail-note"><strong>Inspection:</strong> ' + escapeHtml(r.inspection_note) + '</p>' : '');

    openDetailModal(r.report_type + ' Report #' + r.return_id,
        r.product_name + ' · ' + (awaiting ? 'Awaiting inspection' : r.status),
        'R' + r.return_id, [
            { label: 'Report', body: report + inspection },
            { label: 'Details', body: context }
        ]);
}

// ==========================================
// INVENTORY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('inventory-dashboard.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        // six panels built closed; only the low-stock banner queries
        buildMaterialsPanel();
        buildAdjustmentsPanel();
        buildReorderPanel();
        buildClerkPurchaseOrderPanel();
        buildReturnsPanel();
        buildInventoryArchivePanel();
        buildClerkRecordsPanel();
        writeClerkRecordHeaders();
        syncClerkRecordAddButton();
        fillClerkRecordSort();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({
            showPanel: function (panelId, title) {
                return showInventoryPanel(panelId, title);
            }
        });
        buildDeliverySchedulePanel();
        configureFeatures({
            home: function () {
                return showInventoryHome();
            }
        });

        // Go to, on an opened alert: the screen that alert is about
        const stockAlert = { label: 'Reorder Point', panelId: 'panel-reorder',
                             open: function () { return showReorder(); }, key: 'clerk-reorder', searchId: 'reorder-search' };
        const returnsAlert = { label: 'Returned Items', panelId: 'panel-returns',
                               open: function () { return showReturns(); }, key: 'clerk-returns' };
        configureNotificationTargets({
            'Low Stock':        stockAlert,
            'Out of Stock':     stockAlert,
            'Purchase Order':   { label: 'Purchase Orders', panelId: 'panel-po-history',
                                  open: function () { return showPurchaseOrderHistory(); }, key: 'clerk-po' },
            'Damage Report':    returnsAlert,
            'Refund Report':    returnsAlert,
            'Stock Adjustment': { label: 'Adjustment History', panelId: 'panel-adjust-log',
                                  open: function () { return showAdjustmentHistory(); }, key: 'clerk-adjustments' }
        });

        // the Stock Adjustment screen follows stock moved by other people (live-sync.js)
        onLiveChange(['inventory', 'sales', 'returns'], refreshAdjustScreen);

        showInventoryHome();
        unfoldSidebarAtOpenScreen();
        loadNotifications();
    });

    // a click anywhere else closes whichever suggestion list is open
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideAdjustSuggestions();
        hideUnitSuggestions();
    });
}
