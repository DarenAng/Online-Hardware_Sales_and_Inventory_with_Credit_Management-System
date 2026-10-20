// ============================================================
// inventory-clerk.js -- the Inventory Clerk dashboard
// Loaded by: inventory-dashboard.html
//
// What is in this file, from top to bottom:
//   - switching screens (showInventoryPanel and the show... functions)
//   - the material list (with its filters) and the low-stock banner
//   - stock adjustment: pick a material, an accepted purchase order or an open
//     returned item from Reference, see a preview, save
//   - adjustment history and reorder points
//   - returns and damage reports: inspect, return to stock or write off
//   - the material archive
//   - popups: one material, one adjustment, one return
//   - the page start-up code at the very bottom ("INVENTORY PAGE BOOT")
// (Purchase orders are in shared/purchase-orders.js.)
// ============================================================
let invProducts = [];
let invLoaded = false;

// what is chosen on the adjustment form; typed text that matches nothing is not a choice
let adjustMaterial = null;
let adjustSuggestHighlight = -1;

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

    // the Reference list holds the materials too, so it waits for them
    if (invLoaded) renderAttentionList();
    else attentionMessage('Loading...');
    ensureInventoryLoaded(true).then(afterMaterialsLoaded);
    loadReferenceRecords().then(renderAttentionList);
    renderAdjustForm();
}

function showAdjustmentHistory(event) {
    showInventoryPanel('panel-adjust-log', 'Adjustment History', event);
}

function showReorder(event) { showInventoryPanel('panel-reorder', 'Reorder Point Settings', event); }
function showReturns(event) { showInventoryPanel('panel-returns', 'Returned Items', event); }
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
        filters: { status: 'all', supplier: 'all', material: 'all', category: 'all' },

        gate: {
            title: 'No materials loaded',
            text: 'Search above for one material, pick a filter, or press Load Data ' +
                  'for the whole list. Archived materials never appear here.',
            button: 'Load Data'
        },

        load: async function () {
            invProducts = await apiGetProducts();
            invLoaded = true;
            return invProducts;
        },

        // this load replaces invProducts, so the Stock Adjustment list and the
        // Material filter are redrawn from it
        onLoaded: function () {
            fillMaterialNameFilter();
            if (adjustScreenOpen()) afterMaterialsLoaded(true);
        },

        match: function (p, query) {
            return prefixMatch([
                p.product_name, p.category_name, p.supplier_name, p.stock_status
            ], query);
        },

        filter: function (p, filters) {
            if (filters.status !== 'all' && p.stock_status !== filters.status) return false;
            if (filters.supplier !== 'all' && String(p.supplier_name || '') !== filters.supplier) return false;
            if (filters.material !== 'all' && String(p.product_id) !== filters.material) return false;
            if (filters.category !== 'all' && String(p.category_name || '') !== filters.category) return false;
            return true;
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

// ---------- the Material List filters ----------
// Supplier and Category come from Records; Material from the material list.
// Each keeps what is picked when its choices are filled again.
function setFilterOptions(selectId, firstLabel, choices) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const before = select.value;
    let html = '<option value="all">' + escapeHtml(firstLabel) + '</option>';
    let kept = false;
    for (let i = 0; i < choices.length; i++) {
        const value = String(choices[i].value);
        if (value === before) kept = true;
        html += '<option value="' + escapeHtml(value) + '">' + escapeHtml(choices[i].label) + '</option>';
    }
    select.innerHTML = html;
    select.value = kept ? before : 'all';
}

async function fillMaterialFilters() {
    try {
        const lists = await Promise.all([apiGetRecords('supplier'), apiGetRecords('category')]);
        const named = function (rows) {
            const choices = [];
            for (let i = 0; i < rows.length; i++) choices.push({ value: rows[i].name, label: rows[i].name });
            choices.sort(function (a, b) { return a.label.localeCompare(b.label); });
            return choices;
        };
        setFilterOptions('inv-supplier', 'Every supplier', named(lists[0]));
        setFilterOptions('inv-category', 'Every category', named(lists[1]));
    } catch (error) {
        // not fatal: the list still searches by supplier and category
    }

    if (await ensureInventoryLoaded(false)) fillMaterialNameFilter();
}

function fillMaterialNameFilter() {
    const choices = [];
    for (let i = 0; i < invProducts.length; i++) {
        choices.push({ value: invProducts[i].product_id, label: invProducts[i].product_name });
    }
    choices.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    setFilterOptions('inv-material', 'Every material', choices);
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
                    'maxlength="' + PRODUCT_NAME_MAX + '" placeholder="Input product">' +
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

    // the search text and the filters must not hide it
    const search = document.getElementById('inv-search');
    if (search) search.value = name;
    const filterBoxes = { status: 'inv-status', supplier: 'inv-supplier', material: 'inv-material', category: 'inv-category' };
    for (const filterName in filterBoxes) {
        const select = document.getElementById(filterBoxes[filterName]);
        if (select) select.value = 'all';
        panel.filters[filterName] = 'all';
    }
    panel.query = searchText(name);
    await panel.open();
    fillMaterialFilters();         // the new product's supplier, category and name
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

// ---------- the Reference list (Stock Adjustment) ----------
// The server marks every material Out of Stock, Low Stock or In Stock. It is
// the same rule that counts the banner above, so the materials are sorted by
// that mark: the ones that need stock come first.
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
    renderAdjustPreview();
}

// Somebody else moved stock (a sale, a return, another clerk): while this screen is
// open, read the materials, orders and returns again so the list, the strip and
// the banner stay true.
async function refreshAdjustScreen() {
    if (!adjustScreenOpen()) return;

    const loaded = await ensureInventoryLoaded(true);
    await loadReferenceRecords();
    if (loaded) afterMaterialsLoaded(true);
    else renderAttentionList();
    loadStockBanner();
}

// ---------- the Reference list's purchase orders and returned items ----------
// Accepted purchase orders (the supplier said yes; the goods are on their way)
// and returned items still Open. A failed load leaves that part of the list
// empty and says so; the materials still show.
let referencePos = [];
let referenceReturns = [];        // open returned items, grouped (see groupOpenReturns)
let referenceProblem = '';
let referenceSearch = '';
let referenceType = 'all';
let referencePage = 1;
const REFERENCE_PAGE_SIZE = 8;

async function loadReferenceRecords() {
    const problems = [];

    if (holdsFeature('purchase-orders')) {
        try {
            const orders = await apiGetPurchaseOrders();
            const accepted = [];
            for (let i = 0; i < orders.length; i++) {
                if (poStage(orders[i]) === 'Accepted') accepted.push(orders[i]);
            }
            referencePos = accepted;
        } catch (error) {
            problems.push('purchase orders');
        }
    } else {
        referencePos = [];
    }

    if (holdsFeature('returns')) {
        try {
            referenceReturns = groupOpenReturns(await apiGetReturns());
        } catch (error) {
            problems.push('returned items');
        }
    } else {
        referenceReturns = [];
    }

    referenceProblem = problems.length ? 'The ' + problems.join(' and ') + ' could not be loaded.' : '';
    dropStaleAdjustSource();
}

// Open returned items filed together are one return: the same sale, the same
// purchase order, or one report filed at the same moment by the same person.
function returnGroupKey(r) {
    if (r.sale_id) return r.report_type + '|sale|' + r.sale_id;
    if (r.po_id) return r.report_type + '|po|' + r.po_id;
    return r.report_type + '|at|' + String(r.return_date).slice(0, 19) + '|' + r.reported_by;
}

function groupOpenReturns(rows) {
    const groups = [];
    const byKey = {};
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.status !== 'Open') continue;
        const key = returnGroupKey(r);
        if (!byKey[key]) {
            byKey[key] = { key: key, type: r.report_type, saleId: r.sale_id, poId: r.po_id,
                           filedOn: r.return_date, filedBy: r.reported_by, items: [] };
            groups.push(byKey[key]);
        }
        byKey[key].items.push(r);
    }
    return groups;
}

function findReturnGroup(key) {
    for (let i = 0; i < referenceReturns.length; i++) {
        if (referenceReturns[i].key === key) return referenceReturns[i];
    }
    return undefined;
}

function findReferencePo(poId) {
    for (let i = 0; i < referencePos.length; i++) {
        if (Number(referencePos[i].po_id) === Number(poId)) return referencePos[i];
    }
    return undefined;
}

// "Refunded · Sale #45", "Missing · PO #12", or "Damaged · Report #31"
function returnGroupTitle(group) {
    let from;
    if (group.saleId) from = 'Sale #' + group.saleId;
    else if (group.poId) from = 'PO #' + group.poId;
    else from = 'Report #' + group.items[0].return_id;
    return group.type + ' · ' + from;
}

function returnGroupNames(group) {
    const names = [];
    for (let i = 0; i < group.items.length; i++) names.push(group.items[i].product_name);
    return names;
}

function onReferenceSearch(value) {
    referenceSearch = searchText(String(value || ''));
    referencePage = 1;
    renderAttentionList();
}

function onReferenceType(value) {
    referenceType = value || 'all';
    referencePage = 1;
    renderAttentionList();
}

// Previous and Next under the list, like the pager under every table
function turnReferencePage(step) {
    referencePage += step;
    renderAttentionList();
}

// one clickable row of the Reference list
function referenceRowHtml(onclick, label, name, kind, badgeClass, badgeText, note, picked) {
    return '<li>' +
        '<button type="button" class="attention-row' + (picked ? ' is-picked' : '') + '" ' +
            'aria-label="' + escapeHtml(label) + '" onclick="' + onclick + '">' +
        '<span class="attention-who">' +
            '<span class="attention-name">' + name + '</span>' +
            '<span class="attention-kind">' + kind + '</span>' +
        '</span>' +
        '<span class="attention-figures">' +
            (badgeText ? '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' : '') +
            (note ? '<span class="attention-reorder">' + note + '</span>' : '') +
        '</span>' +
        '</button></li>';
}

function renderAttentionList() {
    const list = document.getElementById('attention-list');
    const more = document.getElementById('attention-more');
    if (!list || !more) return;

    const query = referenceSearch;
    const rows = [];        // every row that matches, in order; one page of them is drawn

    // accepted purchase orders
    if (referenceType === 'all' || referenceType === 'po') {
        for (let i = 0; i < referencePos.length; i++) {
            const po = referencePos[i];
            if (query && !prefixMatch(['PO', String(po.po_id), 'PO #' + po.po_id, po.supplier_name], query)) continue;
            const picked = adjustSource && adjustSource.kind === 'po' && Number(adjustSource.po.po_id) === Number(po.po_id);
            const lines = Number(po.line_count) || 0;
            rows.push(referenceRowHtml('adjustFromPo(' + Number(po.po_id) + ')',
                'Receive purchase order ' + po.po_id,
                'PO #' + escapeHtml(String(po.po_id)),
                escapeHtml(po.supplier_name || 'No supplier'),
                '', '',
                lines ? lines + (lines === 1 ? ' item' : ' items') : 'PO',
                picked));
        }
    }

    // open returned items
    if (referenceType === 'all' || referenceType === 'return') {
        for (let i = 0; i < referenceReturns.length; i++) {
            const group = referenceReturns[i];
            const names = returnGroupNames(group);
            const words = [group.type, returnGroupTitle(group), group.filedBy].concat(names);
            if (query && !prefixMatch(words, query)) continue;
            const picked = adjustSource && adjustSource.kind === 'return' && adjustSource.group.key === group.key;
            rows.push(referenceRowHtml('adjustFromReturn(' + escapeHtml(JSON.stringify(group.key)) + ')',
                'Open returned item ' + returnGroupTitle(group),
                escapeHtml(returnGroupTitle(group)),
                joinEscaped(names.slice(0, 3), ', ') + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : ''),
                '', '',
                group.items.length + (group.items.length === 1 ? ' item' : ' items'),
                picked));
        }
    }

    // every material, out of stock first, then low, then the rest by name
    if (referenceType === 'all' || referenceType === 'material') {
        const materials = [];
        for (let i = 0; i < invProducts.length; i++) {
            const p = invProducts[i];
            if (query && !prefixMatch([p.product_name, p.brand_name, p.category_name, p.supplier_name], query)) continue;
            materials.push(p);
        }
        materials.sort(function (a, b) {
            const aShort = isShort(a);
            const bShort = isShort(b);
            if (aShort && bShort) return compareShort(a, b);
            if (aShort !== bShort) return aShort ? -1 : 1;
            return String(a.product_name).localeCompare(String(b.product_name));
        });

        for (let i = 0; i < materials.length; i++) {
            const p = materials[i];
            const unit = p.unit_name ? ' ' + escapeHtml(p.unit_name) : '';
            let badgeClass = 'badge-success';
            if (p.stock_status === 'Out of Stock') badgeClass = 'badge-danger';
            else if (p.stock_status === 'Low Stock') badgeClass = 'badge-warning';
            const picked = !adjustSource && adjustMaterial && adjustMaterial.product_id === p.product_id;
            rows.push(referenceRowHtml('adjustFromList(' + p.product_id + ')',
                'Adjust ' + p.product_name,
                escapeHtml(p.product_name),
                materialKindText(p),
                badgeClass, (Number(p.quantity_in_stock) || 0) + unit,
                'Reorder at ' + (Number(p.reorder_point) || 0),
                picked));
        }
    }

    let note = '';
    if (referenceProblem) note = '<li class="attention-empty">' + escapeHtml(referenceProblem) + '</li>';

    if (rows.length === 0) {
        let empty = 'Nothing to show.';
        if (query) empty = 'Nothing matches that search.';
        else if (referenceType === 'po') empty = 'No purchase order is waiting for its delivery.';
        else if (referenceType === 'return') empty = 'No returned item is open.';
        else if (referenceType === 'material' && !invLoaded) empty = 'Loading materials...';
        list.innerHTML = note + '<li class="attention-empty">' + escapeHtml(empty) + '</li>';
        more.hidden = true;
        more.innerHTML = '';
        return;
    }

    // eight rows a page, so the list fits its card without scrolling
    const pages = Math.max(1, Math.ceil(rows.length / REFERENCE_PAGE_SIZE));
    referencePage = Math.min(Math.max(1, referencePage), pages);
    const start = (referencePage - 1) * REFERENCE_PAGE_SIZE;
    list.innerHTML = note + rows.slice(start, start + REFERENCE_PAGE_SIZE).join('');

    if (pages > 1) {
        more.hidden = false;
        more.innerHTML =
            '<div class="pager-controls">' +
                '<button type="button" class="btn btn-sm" onclick="turnReferencePage(-1)"' +
                    (referencePage === 1 ? ' disabled' : '') + '>Previous</button>' +
                '<span class="pager-page">Page ' + referencePage + ' of ' + pages + '</span>' +
                '<button type="button" class="btn btn-sm" onclick="turnReferencePage(1)"' +
                    (referencePage === pages ? ' disabled' : '') + '>Next</button>' +
            '</div>';
    } else {
        more.hidden = true;
        more.innerHTML = '';
    }
}

// A material from the list: back to a single material, the same pick as
// choosing it from the suggestion list, for adding stock
function adjustFromList(productId) {
    const form = document.getElementById('adjust-form');

    // a quantity and reason typed for another material do not belong to this one
    if (form && (adjustSource || (adjustMaterial && adjustMaterial.product_id !== productId))) {
        form.elements.quantity.value = '';
        form.elements.reason.value = '';
    }

    setAdjustSource(null);
    const type = document.getElementById('adjust-type');
    if (type) type.value = 'Add';

    pickAdjustMaterial(productId);       // this also redraws the strip and the preview
    renderAttentionList();
    focusAdjustForm('adjust-qty');
}

// brings the form into view and puts the cursor in one of its boxes
function focusAdjustForm(fieldId) {
    const qty = document.getElementById(fieldId);
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

// ---------- the material box (Stock Adjustment) ----------
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

    // the material's own unit; it is not typed
    const unitBox = adjustUnitBox();
    if (unitBox) unitBox.value = product ? (product.unit_name || '') : '';

    renderAdjustMaterialStrip();
    renderAdjustMaterialVerdict();
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

// A quantity as typed, whole or fractional: 2.5 kilogram is 2.5, not 2. Three
// decimals is the width of the column it lands in; NaN when nothing readable.
function readQuantity(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text === '') return NaN;
    const number = Number(text);
    return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : NaN;
}

// Add and Remove move the shelf, so a quantity of nothing is not an adjustment
// (fractions are fine). Returns the words to show, or '' when the quantity is fine.
function adjustQuantityProblem(type, quantity) {
    return quantity <= 0 ? 'Add and Remove need a quantity greater than zero.' : '';
}

// ---------- what this will do ----------
// A strip: the material, then "40 pcs -> 45 pcs (+5)". A Remove that would
// take the shelf below zero is caught here.
function renderAdjustPreview() {
    const box = document.getElementById('adjust-preview');
    const form = document.getElementById('adjust-form');
    if (!box || !form) return;

    // an order or a return shows its figures line by line in its own table
    if (adjustSource) {
        renderSourcePreview(box);
        return;
    }

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
    const unit = adjustMaterial.unit_name || '';

    let after = type === 'Remove' ? before - quantity : before + quantity;
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

    if (adjustSource && adjustSource.kind === 'po') { await applyPoAdjustment(); return; }
    if (adjustSource && adjustSource.kind === 'return') { await applyReturnAdjustment(); return; }

    // the check is on what was chosen, not what is typed
    if (!adjustMaterial || !form.elements.productId.value) {
        notifyWarning('Type a few letters of the material and choose it from the list. ' +
            'An adjustment moves a real figure, so it has to name one.', 'No material chosen');
        const box = adjustMaterialBox();
        if (box) { box.focus(); box.select(); }
        renderAdjustMaterialVerdict(true);
        return;
    }

    const data = {
        productId: parseInt(form.elements.productId.value, 10),
        adjustmentType: form.elements.adjustmentType.value === 'Remove' ? 'Remove' : 'Add',
        quantity: readQuantity(form.elements.quantity.value),
        // the material's own unit: an adjustment never changes it
        unitName: adjustMaterial.unit_name || '',
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

    if (data.reason === '') {
        notifyWarning('Add remarks saying why this is being recorded.', 'Remarks are required');
        const reason = document.getElementById('adjust-reason');
        if (reason) reason.focus();
        return;
    }

    // what the preview already says in red (a Remove below zero) is not sent
    if (data.adjustmentType === 'Remove' && data.quantity > (Number(adjustMaterial.quantity_in_stock) || 0)) {
        notifyWarning('Only ' + adjustMaterial.quantity_in_stock + ' ' + (adjustMaterial.unit_name || '') +
            ' on hand.', 'Quantity not allowed');
        return;
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
        afterMaterialsLoaded(await ensureInventoryLoaded(true));

        const again = findProductById(data.productId);
        setAdjustMaterial(again || null);
        if (!again) clearAdjustMaterial();

        await afterStockMoved();
    } catch (error) {
        notifyOffline();
    }
}

// every screen that shows stock reads it again
async function afterStockMoved() {
    await loadAdjustments();
    const keys = ['clerk-materials', 'clerk-reorder', 'clerk-returns'];
    for (let i = 0; i < keys.length; i++) {
        const panel = getDataPanel(keys[i]);
        if (panel && panel.state === 'ready') await panel.refresh();
    }
    if (typeof refreshPurchaseOrders === 'function') {
        try { await refreshPurchaseOrders(); } catch (error) { /* the list reads again when opened */ }
    }
    await loadStockBanner();
    await loadNotifications();
}

// ---------- Stock Adjustment from a purchase order or a returned item ----------
// adjustSource: null for a single material; { kind: 'po', po, items } for an
// accepted purchase order; { kind: 'return', group } for an open return.
let adjustSource = null;
let adjustSourceLoading = 0;      // which pick is loading, so a slower earlier one is dropped

function setAdjustSource(source) {
    adjustSource = source || null;
    renderAdjustForm();
}

// shows the fields the pick needs: a material has the material box and its
// figures; an order or a return shows its items in a table instead
function renderAdjustForm() {
    const kind = adjustSource ? adjustSource.kind : 'material';
    const show = function (id, on) {
        const element = document.getElementById(id);
        if (element) element.hidden = !on;
    };

    show('adjust-material-field', kind === 'material');
    show('adjust-unit-field', kind === 'material');
    show('adjust-qty-field', kind === 'material');
    // an order is always added to stock, so it has no type to choose
    show('adjust-type-field', kind !== 'po');

    renderAdjustTypeOptions(kind);
    renderAdjustSource();
    renderAdjustLines();
    renderAdjustMaterialVerdict();
    renderAdjustPreview();

    const button = document.querySelector('#adjust-form button[type="submit"]');
    if (button) {
        let label = 'Apply Adjustment';
        if (kind === 'po') label = 'Receive into Stock';
        button.textContent = label;
    }
}

// a material: Add or Remove; a returned item: Add to stock or Discard Item
function renderAdjustTypeOptions(kind) {
    const select = document.getElementById('adjust-type');
    if (!select) return;

    const before = select.value;
    let options;
    if (kind === 'return') {
        options = [['Add', 'Add to stock'], ['Discard', 'Discard Item']];
    } else {
        options = [['Add', 'Add to stock'], ['Remove', 'Remove from stock']];
    }

    let html = '';
    let kept = false;
    for (let i = 0; i < options.length; i++) {
        if (options[i][0] === before) kept = true;
        html += '<option value="' + options[i][0] + '">' + options[i][1] + '</option>';
    }
    select.innerHTML = html;
    select.value = kept ? before : 'Add';
}

// the strip on top of the form: which order or return is being worked, and a way out
function renderAdjustSource() {
    const box = document.getElementById('adjust-source');
    if (!box) return;

    if (!adjustSource) { box.hidden = true; box.innerHTML = ''; return; }

    let title;
    let sub;
    if (adjustSource.kind === 'po') {
        const po = adjustSource.po;
        title = 'PO #' + escapeHtml(String(po.po_id)) + ' · ' + escapeHtml(po.supplier_name || '');
        sub = 'Accepted by the supplier. What arrived goes onto the shelf and the order is marked Received.';
    } else {
        const group = adjustSource.group;
        title = escapeHtml(returnGroupTitle(group));
        sub = 'Filed ' + escapeHtml(String(group.filedOn || '').slice(0, 10)) +
            (group.filedBy ? ' by ' + escapeHtml(group.filedBy) : '') + '. Add it back to stock, or discard it.';
    }

    box.hidden = false;
    box.innerHTML =
        '<div class="adjust-source-text">' +
            '<span class="adjust-source-eyebrow">' + (adjustSource.kind === 'po' ? 'Purchase order' : 'Returned item') + '</span>' +
            '<span class="adjust-source-title">' + title + '</span>' +
            '<span class="adjust-source-sub">' + sub + '</span>' +
        '</div>';
}

// Clear: empties the form and stays on the screen, back to a single material
function clearAdjustForm() {
    const form = document.getElementById('adjust-form');
    if (form) {
        form.elements.quantity.value = '';
        form.elements.reason.value = '';
    }
    adjustSourceLoading++;
    adjustSource = null;

    const box = adjustMaterialBox();
    if (box) box.value = '';
    const clear = document.getElementById('adjust-material-clear');
    if (clear) clear.hidden = true;
    hideAdjustSuggestions();
    setAdjustMaterial(null);

    const type = document.getElementById('adjust-type');
    if (type) type.value = 'Add';
    renderAdjustForm();
    renderAttentionList();
}

// ---------- leaving Stock Adjustment with work on the form ----------
// A purchase order or returned item picked, or a quantity or remarks typed,
// is work that leaving the screen would lose, so leaving asks first.
let adjustLeaveConfirmed = false;

function adjustFormHasWork() {
    if (!adjustScreenOpen()) return false;
    if (adjustSource) return true;
    const form = document.getElementById('adjust-form');
    if (!form) return false;
    return form.elements.quantity.value.trim() !== '' || form.elements.reason.value.trim() !== '';
}

// what counts as going to another screen: the menu (not the caret that only
// folds a heading), the banner's button, and an alert's Go to
function leavesAdjustScreen(target) {
    if (!target || target.closest('#panel-adjust')) return null;
    const menuLink = target.closest('.sidebar a');
    // Stock Adjustment's own menu entry stays on this screen
    if (menuLink && menuLink.dataset.panelLink === 'panel-adjust') return null;
    if (menuLink && !target.closest('.nav-caret')) return menuLink;
    const other = target.closest('#stock-banner .btn, [onclick^="goToNotification"]');
    return other || null;
}

async function guardAdjustLeave(event) {
    if (adjustLeaveConfirmed || !adjustFormHasWork()) return;
    const leaving = leavesAdjustScreen(event.target);
    if (!leaving) return;

    // hold the click until the clerk says what to do
    event.preventDefault();
    event.stopImmediatePropagation();

    const yes = await askConfirm('What is on the Stock Adjustment form has not been applied. Leaving clears it.', {
        title: 'Leave without applying?',
        eyebrow: 'Stock Adjustment',
        confirmLabel: 'Leave and clear',
        tone: 'danger'
    });
    if (!yes) return;

    clearAdjustForm();
    adjustLeaveConfirmed = true;
    try { leaving.click(); } finally { adjustLeaveConfirmed = false; }
}

// The items of the order or return: material, unit and quantity, in a table
// that scrolls on its own once it is longer than a few rows. An order's
// quantities are filled in from the order and can be changed to what arrived;
// a return's are what was filed.
function renderAdjustLines() {
    const box = document.getElementById('adjust-lines');
    if (!box) return;

    if (!adjustSource) { box.hidden = true; box.innerHTML = ''; return; }

    if (adjustSource.loading) {
        box.hidden = false;
        box.innerHTML = '<p class="detail-note">Opening the order...</p>';
        return;
    }

    let rows = '';
    let count = 0;
    if (adjustSource.kind === 'po') {
        const items = adjustSource.items;
        count = items.length;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            rows += '<tr>' +
                '<td class="cell-name">' + escapeHtml(item.product_name) +
                    '<span class="cell-sub">Ordered ' + escapeHtml(poQuantityText(item)) + '</span>' +
                    '<span class="adjust-line-note" id="adjust-line-note-' + i + '"></span></td>' +
                '<td>' + escapeHtml(item.unit_name || '') + '</td>' +
                '<td class="cell-num"><input type="number" class="form-control adjust-line-qty" ' +
                    'id="adjust-line-qty-' + i + '" min="0" step="1" value="' + Number(item.quantity) + '" ' +
                    'oninput="renderAdjustPreview()" aria-label="Quantity arrived: ' + escapeHtml(item.product_name) + '"></td>' +
                '</tr>';
        }
    } else {
        const items = adjustSource.group.items;
        count = items.length;
        for (let i = 0; i < items.length; i++) {
            const r = items[i];
            rows += '<tr>' +
                '<td class="cell-name">' + escapeHtml(r.product_name) +
                    '<span class="cell-sub">Report #' + r.return_id + ' · ' + returnLineWent(r) + '</span></td>' +
                '<td>' + escapeHtml(r.unit_name || '') + '</td>' +
                '<td class="cell-num">' + Number(r.quantity) + '</td>' +
                '</tr>';
        }
    }

    if (count === 0) {
        box.hidden = false;
        box.innerHTML = '<p class="detail-empty">There are no items on it.</p>';
        return;
    }

    box.hidden = false;
    box.innerHTML =
        '<p class="adjust-lines-head">' + count + (count === 1 ? ' item' : ' items') + '</p>' +
        '<div class="adjust-lines-scroll">' +
            '<table class="mini-table adjust-lines-table">' +
                '<thead><tr><th>Material</th><th>Unit</th><th class="col-num">Quantity</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table>' +
        '</div>';
}

// where a returned item's goods stand now, for its line in the table
function returnLineWent(r) {
    if (r.report_type === 'Missing') return 'never arrived';
    if (!r.disposition) return 'awaiting inspection';
    return r.disposition === 'Return to Stock' ? 'already back on the shelf' : 'already written off';
}

// What one returned item does to the shelf for the choice made. The goods end
// where the choice says: back on the shelf (Add) or not (Discard).
//   change: what this form moves itself with an adjustment (+ or -), 0 for none
//   verdict: sent to the inspection when the goods still wait for one
function returnLinePlan(r, choice) {
    const quantity = Number(r.quantity) || 0;
    const add = choice === 'Add';

    // a refund the counter took back: the inspection itself moves the stock
    if (r.report_type !== 'Missing' && !r.disposition) {
        return { verdict: add ? 'Return to Stock' : 'Write-Off', change: 0 };
    }
    // goods a delivery never brought: Add means they have come in since
    if (r.report_type === 'Missing') return { verdict: null, change: add ? quantity : 0 };
    // decided when it was filed: only a change of mind moves anything
    if (r.disposition === 'Return to Stock') return { verdict: null, change: add ? 0 : -quantity };
    return { verdict: null, change: add ? quantity : 0 };
}

function renderSourcePreview(box) {
    box.className = 'adjust-preview';
    box.textContent = '';
    if (!adjustSource || adjustSource.loading) return;

    if (adjustSource.kind === 'po') {
        const lines = poAdjustLines();
        let total = 0;
        let blank = false;
        let off = 0;
        for (let i = 0; i < lines.length; i++) {
            const state = poLineState(lines[i]);
            const note = document.getElementById('adjust-line-note-' + i);
            if (note) {
                note.className = 'adjust-line-note' + (state.kind ? ' is-' + state.kind : '');
                note.textContent = state.text;
            }
            if (state.kind === 'bad') blank = true;
            else if (lines[i].quantity > 0) total++;
            if (state.kind === 'under' || state.kind === 'over') off++;
        }
        if (blank) {
            box.className = 'adjust-preview is-stop';
            box.textContent = 'Every line needs a whole number of 0 or more. Type 0 for what did not arrive.';
            return;
        }
        box.className = 'adjust-preview is-good';
        box.innerHTML = '<span class="preview-name">PO #' + escapeHtml(String(adjustSource.po.po_id)) + '</span>' +
            '<span class="preview-figures">' + total + ' of ' + lines.length +
                (lines.length === 1 ? ' item' : ' items') + ' will be added to stock</span>' +
            (off > 0 ? '<span class="preview-note">' + off + (off === 1 ? ' item differs' : ' items differ') +
                ' from the order, so a Report is added to the order.</span>' : '');
        return;
    }

    const select = document.getElementById('adjust-type');
    const choice = select ? select.value : 'Add';
    const items = adjustSource.group.items;
    box.className = 'adjust-preview ' + (choice === 'Add' ? 'is-good' : 'is-down');
    box.innerHTML = '<span class="preview-name">' + escapeHtml(returnGroupTitle(adjustSource.group)) + '</span>' +
        '<span class="preview-figures">' + (choice === 'Add'
            ? 'Back on the shelf: ' + items.length + (items.length === 1 ? ' item' : ' items')
            : 'Discarded: ' + items.length + (items.length === 1 ? ' item' : ' items')) + '</span>' +
        '<span class="preview-note">The report' + (items.length === 1 ? ' is' : 's are') + ' then closed.</span>';
}

// One order line against what was ordered: kind is '' (as ordered), 'under',
// 'over' or 'bad' (not a whole number of 0 or more); text says so for the line.
function poLineState(line) {
    const quantity = line.quantity;
    if (!Number.isInteger(quantity) || quantity < 0) return { kind: 'bad', text: 'Type a whole number, 0 or more.' };
    const difference = quantity - Number(line.item.quantity);
    const unit = line.item.unit_name || '';
    if (difference < 0) return { kind: 'under', text: 'Under-delivery: ' + qtyText(-difference, unit) + ' missing' };
    if (difference > 0) return { kind: 'over', text: 'Over-delivery: ' + qtyText(difference, unit) + ' over' };
    return { kind: '', text: '' };
}

// what each line of the order says arrived, in the material's own unit
function poAdjustLines() {
    const lines = [];
    if (!adjustSource || adjustSource.kind !== 'po') return lines;
    for (let i = 0; i < adjustSource.items.length; i++) {
        const field = document.getElementById('adjust-line-qty-' + i);
        lines.push({ item: adjustSource.items[i], quantity: readQuantity(field ? field.value : adjustSource.items[i].quantity) });
    }
    return lines;
}

// An accepted purchase order from Reference: its items fill the form
async function adjustFromPo(poId) {
    const po = findReferencePo(poId);
    if (!po) return;

    const ticket = ++adjustSourceLoading;
    setAdjustMaterial(null);
    const box = adjustMaterialBox();
    if (box) box.value = '';
    setAdjustSource({ kind: 'po', po: po, items: [], loading: true });
    renderAttentionList();

    try {
        const items = await apiGetPurchaseOrderItems(poId);
        if (ticket !== adjustSourceLoading) return;       // another pick came after this one
        setAdjustSource({ kind: 'po', po: po, items: items });
        focusAdjustForm('adjust-line-qty-0');
    } catch (error) {
        if (ticket !== adjustSourceLoading) return;
        setAdjustSource(null);
        notifyError('That purchase order could not be opened. Try again.', 'Not opened');
    }
}

// An open returned item from Reference: its items fill the form
function adjustFromReturn(key) {
    const group = findReturnGroup(key);
    if (!group) return;

    adjustSourceLoading++;
    setAdjustMaterial(null);
    const box = adjustMaterialBox();
    if (box) box.value = '';
    const form = document.getElementById('adjust-form');
    if (form) form.elements.reason.value = '';
    const type = document.getElementById('adjust-type');
    if (type) type.value = 'Add';

    setAdjustSource({ kind: 'return', group: group });
    renderAttentionList();
    focusAdjustForm('adjust-type');
}

// after the lists are read again: an order received or a return closed by
// someone else is no longer on the form
function dropStaleAdjustSource() {
    if (!adjustSource || adjustSource.loading) return;

    if (adjustSource.kind === 'po' && !findReferencePo(adjustSource.po.po_id)) {
        notifyWarning('PO #' + adjustSource.po.po_id + ' is no longer waiting for its delivery.', 'Order closed');
        setAdjustSource(null);
    } else if (adjustSource.kind === 'return') {
        const fresh = findReturnGroup(adjustSource.group.key);
        if (!fresh) {
            notifyWarning(returnGroupTitle(adjustSource.group) + ' is no longer open.', 'Return closed');
            setAdjustSource(null);
        } else {
            adjustSource.group = fresh;
            renderAdjustLines();
            renderAdjustPreview();
        }
    }
}

// Receiving the order: the quantities on the form go onto the shelf, at the
// cost on the order, and the order is marked Received
async function applyPoAdjustment() {
    if (!adjustSource || adjustSource.loading) return;
    const po = adjustSource.po;
    const lines = poAdjustLines();

    if (lines.length === 0) { notifyWarning('This order has no items to add.', 'Nothing to add'); return; }

    const received = [];
    const differs = [];
    for (let i = 0; i < lines.length; i++) {
        const quantity = lines[i].quantity;
        const state = poLineState(lines[i]);
        if (state.kind === 'bad') {
            notifyWarning('Type how many of ' + lines[i].item.product_name + ' arrived, as a whole number, or 0.',
                'Quantity needed');
            const field = document.getElementById('adjust-line-qty-' + i);
            if (field) field.focus();
            return;
        }
        if (state.kind) differs.push(lines[i].item.product_name + ': ' + state.text);
        received.push({
            productId: lines[i].item.product_id,
            quantity: quantity,
            unitCost: Number(lines[i].item.unit_cost) || 0
        });
    }

    const form = document.getElementById('adjust-form');
    const remarks = form ? form.elements.reason.value.trim() : '';

    const yes = await askConfirm(
        'The quantities on the form go onto the shelf, and purchase order #' + po.po_id + ' is marked Received.' +
        (differs.length > 0 ? ' The delivery differs from the order, so a Report is added to the order.' : ''),
        { title: 'Add this delivery to stock?', eyebrow: 'Stock Adjustment', confirmLabel: 'Add to stock',
          detail: differs.length > 0 ? differs : undefined });
    if (!yes) return;

    try {
        const response = await apiReceivePurchaseOrder(po.po_id, received, Number(po.discount) || 0, remarks);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message + (differs.length > 0 ? ' A Report was added to the order.' : ''),
            'Delivery added to stock');
        if (form) form.elements.reason.value = '';
        if (typeof poMaterialsLoaded !== 'undefined') poMaterialsLoaded = false;
        setAdjustSource(null);

        invLoaded = false;
        await ensureInventoryLoaded(true);
        await loadReferenceRecords();
        afterMaterialsLoaded(invLoaded);
        await afterStockMoved();
    } catch (error) {
        notifyOffline();
    }
}

// Closing a return: each item goes back on the shelf or is discarded, then
// its report is closed. Items are sent one at a time; one that is refused
// stops the rest and says which.
async function applyReturnAdjustment() {
    if (!adjustSource) return;
    const group = adjustSource.group;
    const form = document.getElementById('adjust-form');
    const choice = form && form.elements.adjustmentType.value === 'Discard' ? 'Discard' : 'Add';
    const note = form ? form.elements.reason.value.trim() : '';
    const count = group.items.length;

    const yes = choice === 'Add'
        ? await askConfirm(count + (count === 1 ? ' item goes' : ' items go') + ' back on the shelf and ' +
            (count === 1 ? 'its report is' : 'their reports are') + ' closed.',
            { title: 'Add to stock?', eyebrow: 'Stock Adjustment', confirmLabel: 'Add to stock' })
        : await askDanger(count + (count === 1 ? ' item is' : ' items are') + ' discarded and ' +
            (count === 1 ? 'its report is' : 'their reports are') + ' closed.',
            { title: 'Discard these items?', eyebrow: 'Stock Adjustment', confirmLabel: 'Discard',
              detail: ['They never go back on the shelf and cannot be sold.'] });
    if (!yes) return;

    let done = 0;
    try {
        for (let i = 0; i < group.items.length; i++) {
            const r = group.items[i];
            const plan = returnLinePlan(r, choice);

            if (plan.change !== 0) {
                const moved = await apiAdjustStock({
                    productId: r.product_id,
                    adjustmentType: plan.change > 0 ? 'Add' : 'Remove',
                    quantity: Math.abs(plan.change),
                    unitName: r.unit_name || '',
                    reason: (choice === 'Add' ? 'Added to stock' : 'Discarded') + ' from ' + r.report_type +
                        ' report #' + r.return_id + (note ? ' - ' + note : '')
                });
                const movedResult = await moved.json();
                if (!moved.ok) {
                    if (!handleAuthFailure(moved, movedResult)) {
                        notifyError(r.product_name + ': ' + movedResult.error, 'Stopped at report #' + r.return_id);
                    }
                    break;
                }
            }

            const response = await apiResolveReturn(r.return_id, plan.verdict, note);
            const result = await response.json();
            if (!response.ok) {
                if (!handleAuthFailure(response, result)) {
                    notifyError(r.product_name + ': ' + result.error, 'Stopped at report #' + r.return_id);
                }
                break;
            }
            done++;
        }
    } catch (error) {
        notifyOffline();
    }

    if (done > 0) {
        notifySuccess(done + ' of ' + count + (count === 1 ? ' item' : ' items') +
            (choice === 'Add' ? ' added to stock.' : ' discarded.'), 'Return closed');
    }
    // all closed: back to a single material, before the lists are read again
    // (a source missing from them would be reported as closed by someone else)
    if (done === count) {
        if (form) form.elements.reason.value = '';
        setAdjustSource(null);
    }

    invLoaded = false;
    await ensureInventoryLoaded(true);
    await loadReferenceRecords();
    afterMaterialsLoaded(invLoaded);
    await afterStockMoved();
}

// ---------- reorder point settings ----------
// read only: the manager sets the points
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
            return '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
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
    // only Suppliers offer a sort; products, categories and units read A to Z
    const field = document.getElementById('records-sort-field');
    if (field) field.hidden = clerkRecordType !== 'supplier';
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
            { label: 'Overview', body: overview }
        ]);
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
        detailField('Unit', a.unit_name
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

    // who and when, then the reason under the figures: one page, no tabs
    const why = '<div class="detail-grid">' +
        detailField('Adjusted By', escapeHtml(a.adjusted_by)) +
        detailField('When', escapeHtml(a.created_at)) +
        '</div>' +
        '<h4 class="detail-subhead">Reason</h4>' +
        '<p class="detail-note">' + escapeHtml(a.reason || 'No reason given.') + '</p>';

    openDetailModal('Adjustment #' + a.adjustment_id, a.product_name + ' · ' + a.adjustment_type,
        'A' + a.adjustment_id, [
            { label: 'Change', body: change + why }
        ], '');
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
        '</div>';

    const awaiting = returnAwaiting(r);

    // goods waiting for inspection are added to stock or discarded on Stock
    // Adjustment (Reference, Returned Items); a report already decided can be
    // marked resolved here
    let inspection = '';
    if (!awaiting && r.status === 'Open') {
        inspection = '<div class="detail-actions"><button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); resolveReturn(' + r.return_id + ')">Mark Resolved</button></div>';
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
        fillMaterialFilters();
        unfoldSidebarAtOpenScreen();
        loadNotifications();
    });

    // going to another screen with work on the Stock Adjustment form asks first;
    // capture, so the menu's own handler waits for the answer
    document.addEventListener('click', guardAdjustLeave, true);

    // so does closing or reloading the page
    window.addEventListener('beforeunload', function (event) {
        if (!adjustFormHasWork()) return;
        event.preventDefault();
        event.returnValue = '';
    });

    // a click anywhere else closes whichever suggestion list is open
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideAdjustSuggestions();
    });
}
