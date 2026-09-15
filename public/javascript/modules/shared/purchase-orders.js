// purchase-orders.js -- purchase orders, shared by the manager and the clerk
// Loaded by: manager-dashboard.html, inventory-dashboard.html
//
// The manager raises, prints and receives an order; the clerk only reads the
// history and the document. The server refuses a clerk on the other routes.
// The supplier and the materials are typed, not picked, so an order can buy
// from a new company or a product the shop has never stocked.
//
//   configurePurchaseOrders({
//       key: 'mgr-po',                  // the history panel's data-panel key
//       canCreate: true,                // does this page have the form
//       canReceive: true,               // does this page get Receive buttons
//       showPanel: showManagerPanel,    // (panelId, title) -- the page's own
//       afterChange: () => {}           // optional; caches to drop after a write
//   });
//   buildPurchaseOrderPanel();

const poSetup = {
    key: 'po',
    canCreate: false,
    canReceive: false,
    showPanel: null,
    historyPanelId: 'panel-po-history',
    historyTitle: 'Order History',
    gateText: 'Press Load Data for every order raised, or filter to the ones still pending.',
    afterChange: null
};

function configurePurchaseOrders(options) {
    Object.assign(poSetup, options || {});
}

function poShowPanel(panelId, title) {
    if (typeof poSetup.showPanel === 'function') poSetup.showPanel(panelId, title);
}

function poAfterChange() {
    if (typeof poSetup.afterChange === 'function') poSetup.afterChange();
    if (typeof loadNotifications === 'function') loadNotifications();
}

// ---------- the screens ----------
function showPurchaseOrderHistory(event) {
    if (event) event.preventDefault();
    poShowPanel(poSetup.historyPanelId, poSetup.historyTitle);
}

// opening the form fills the two lists the typed boxes read from
function showPurchaseOrders(event) {
    if (event) event.preventDefault();
    if (!poSetup.canCreate) { showPurchaseOrderHistory(); return; }

    poShowPanel('panel-po', 'New Purchase Order');
    loadPoSuppliers(false);
    ensurePoMaterials(false);
    if (poLineCount === 0) addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

// the picker's own copy of the material list; neither page's can be leaned on
let poMaterials = [];
let poMaterialsLoaded = false;

async function ensurePoMaterials(force) {
    if (poMaterialsLoaded && !force) return true;
    try {
        poMaterials = await getJson('/api/inventory/products?archived=false');
        poMaterialsLoaded = true;
        return true;
    } catch (error) {
        poMaterialsLoaded = false;
        return false;
    }
}

let poSupplier = null;          // the company on file, once one is chosen
let poSuppliers = [];
let poSuppliersLoaded = false;
let poSupplierHighlight = -1;
let poLineCount = 0;
let poDocument = null;          // the order currently being printed
let poReceiving = null;         // the order currently being counted in
let recvExtraCount = 0;

// Material picker shared by the order lines and the receiving sheet; each
// keeps its own state under an id.
const matPickers = {};

function matState(id) {
    if (!matPickers[id]) matPickers[id] = { productId: null, newName: '' };
    return matPickers[id];
}

function matBox(id) { return document.getElementById(id + '-box'); }

function materialPickerHtml(id, label) {
    return '' +
        '<div class="form-group">' +
            '<label for="' + id + '-box">' + escapeHtml(label || 'Material') + '</label>' +
            '<div class="suggest-wrap">' +
                '<input type="text" class="form-control" id="' + id + '-box" autocomplete="off" ' +
                       'placeholder="Type a material, or a new name" ' +
                       'role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
                       'aria-controls="' + id + '-list" ' +
                       'oninput="matInput(\'' + id + '\', this.value)" ' +
                       'onfocus="matInput(\'' + id + '\', this.value)" ' +
                       'onkeydown="matKey(\'' + id + '\', event)">' +
                '<ul class="suggest-list" id="' + id + '-list" role="listbox" hidden></ul>' +
            '</div>' +
            '<p class="pick-verdict" id="' + id + '-verdict"></p>' +
        '</div>' +
        makeCardHtml(id);
}

// the three facts a new material cannot be created without
function makeCardHtml(id) {
    return '' +
        '<div class="make-card" id="' + id + '-make" hidden>' +
            '<div class="make-card-stripe"></div>' +
            '<div class="make-card-body">' +
                '<h4>New material</h4>' +
                '<p class="make-card-sub" id="' + id + '-make-sub">' +
                    'This is not on the material list yet. Fill these in and it joins the list ' +
                    'when the order is sent.</p>' +
                '<div class="make-grid">' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-unit">Counted in</label>' +
                        '<input type="text" class="form-control" id="' + id + '-unit" ' +
                               'maxlength="20" placeholder="pcs, bag, kilogram">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-category">Category</label>' +
                        '<input type="text" class="form-control" id="' + id + '-category" ' +
                               'maxlength="50" placeholder="Fasteners, Cement">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-brand">Brand <span class="label-hint">optional</span></label>' +
                        '<input type="text" class="form-control" id="' + id + '-brand" maxlength="100">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-price">Selling price</label>' +
                        '<input type="number" class="form-control" id="' + id + '-price" ' +
                               'min="0" step="0.01" value="0.00">' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

async function matInput(id, value) {
    await ensurePoMaterials(false);
    const state = matState(id);
    const typed = String(value || '').trim();

    // typing after a choice unmakes the choice
    const chosen = state.productId
        ? poMaterials.find((p) => p.product_id === state.productId) : null;
    if (chosen && chosen.product_name !== typed) state.productId = null;

    state.newName = typed;
    renderMatSuggestions(id, typed);
    renderMatVerdict(id);
    renderPoTotals();
}

function renderMatSuggestions(id, text) {
    const list = document.getElementById(id + '-list');
    const box = matBox(id);
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    matState(id).highlight = -1;

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (query === '') { hide(); return; }

    const matches = poMaterials.filter((p) =>
        (p.product_name + ' ' + (p.category_name || '') + ' ' + (p.brand_name || ''))
            .toLowerCase().indexOf(query) !== -1).slice(0, 7);

    const exact = matches.some((p) => p.product_name.toLowerCase() === query);

    const rows = matches.map((p) =>
        '<li class="suggest-item" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="matPick(\'' + id + '\', ' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + p.quantity_in_stock + ' ' +
                    escapeHtml(p.unit_name || '') + '</span>' +
            '</span>' +
            '<span class="suggest-note">' + escapeHtml(p.category_name || 'No category') +
                ' · ' + peso(p.price) + '</span>' +
        '</li>').join('');

    // the way out of the list, unless the typed name is already a material
    const make = exact ? '' :
        '<li class="suggest-item is-make" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="matMakeNew(\'' + id + '\')">' +
            '<span class="make-mark" aria-hidden="true">+</span>' +
            '<span>Add <span class="make-quoted">' + escapeHtml(text) +
                '</span> as a new material</span>' +
        '</li>';

    if (rows === '' && make === '') { hide(); return; }

    list.innerHTML = rows + make;
    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function hideMatSuggestions(id) {
    const list = document.getElementById(id + '-list');
    const box = matBox(id);
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
}

function hideAllMatSuggestions() {
    document.querySelectorAll('.suggest-list[id$="-list"]').forEach((list) => {
        list.hidden = true;
        list.innerHTML = '';
    });
}

function matKey(id, event) {
    const list = document.getElementById(id + '-list');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    const state = matState(id);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        state.highlight = ((state.highlight === undefined ? -1 : state.highlight) + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === state.highlight));
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[state.highlight >= 0 ? state.highlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') hideMatSuggestions(id);
}

function matPick(id, productId) {
    const product = poMaterials.find((p) => p.product_id === productId);
    if (!product) return;

    const state = matState(id);
    state.productId = productId;
    state.newName = '';

    const box = matBox(id);
    if (box) box.value = product.product_name;

    const make = document.getElementById(id + '-make');
    if (make) make.hidden = true;

    hideMatSuggestions(id);
    renderMatVerdict(id);
    renderPoTotals();
}

function matMakeNew(id) {
    const state = matState(id);
    state.productId = null;

    const box = matBox(id);
    state.newName = box ? box.value.trim() : '';

    const make = document.getElementById(id + '-make');
    const sub = document.getElementById(id + '-make-sub');
    if (make) make.hidden = false;
    if (sub) {
        sub.textContent = '"' + state.newName + '" is not on the material list. Fill these in ' +
            'and it joins the list when this is sent.';
    }

    hideMatSuggestions(id);
    renderMatVerdict(id);

    const unit = document.getElementById(id + '-unit');
    if (unit) unit.focus();
}

function renderMatVerdict(id) {
    const box = document.getElementById(id + '-verdict');
    if (!box) return;

    const state = matState(id);
    const make = document.getElementById(id + '-make');
    const newMode = make && !make.hidden;

    if (state.productId) {
        const product = poMaterials.find((p) => p.product_id === state.productId);
        box.className = 'pick-verdict';
        box.textContent = product
            ? product.quantity_in_stock + ' ' + (product.unit_name || 'on hand') +
              ' on the shelf now.'
            : '';
        return;
    }

    if (newMode && state.newName !== '') {
        box.className = 'pick-verdict is-new';
        box.textContent = 'New material. It joins the list when this is sent.';
        return;
    }

    if (state.newName !== '') {
        box.className = 'pick-verdict is-stop';
        box.textContent = 'Nothing chosen yet. Pick one from the list, or add it as new.';
        return;
    }

    box.className = 'pick-verdict';
    box.textContent = '';
}

function matValue(id) {
    const state = matState(id);
    const make = document.getElementById(id + '-make');
    const newMode = make && !make.hidden;
    const field = (suffix) => {
        const element = document.getElementById(id + '-' + suffix);
        return element ? element.value.trim() : '';
    };

    if (state.productId) {
        return { productId: state.productId, ok: true, isNew: false };
    }

    if (newMode && state.newName !== '') {
        return {
            productId: null,
            newName: state.newName,
            unitName: field('unit'),
            categoryName: field('category'),
            brandName: field('brand'),
            price: parseFloat(field('price')) || 0,
            ok: true,
            isNew: true
        };
    }

    return { ok: false };
}

// ==========================================
// THE SUPPLIER BOX
// ==========================================
async function loadPoSuppliers(force) {
    if (poSuppliersLoaded && !force) return true;

    try {
        poSuppliers = await getJson('/api/records/supplier');
        poSuppliersLoaded = true;
        return true;
    } catch (error) {
        poSuppliersLoaded = false;
        return false;
    }
}

async function onSupplierInput(value) {
    if (!poSuppliersLoaded) await loadPoSuppliers(false);

    const typed = String(value || '').trim();
    if (poSupplier && poSupplier.name !== typed) poSupplier = null;

    // a name typed out in full is the same answer as one taken from the list;
    // the server matches it anyway
    if (!poSupplier && typed !== '') {
        poSupplier = poSuppliers.find((s) =>
            String(s.name).toLowerCase() === typed.toLowerCase()) || null;
    }

    renderSupplierSuggestions(typed);
    renderSupplierState();
}

function renderSupplierSuggestions(text) {
    const list = document.getElementById('po-supplier-list');
    const box = document.getElementById('po-supplier');
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    poSupplierHighlight = -1;

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (query === '') { hide(); return; }

    const matches = poSuppliers.filter((s) =>
        String(s.name).toLowerCase().indexOf(query) !== -1).slice(0, 6);

    if (matches.length === 1 && String(matches[0].name).toLowerCase() === query) {
        hide();
        return;
    }
    if (matches.length === 0) { hide(); return; }

    list.innerHTML = matches.map((s) =>
        '<li class="suggest-item" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="pickSupplier(' + s.id + ')">' +
            '<span class="suggest-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="suggest-note">' +
                escapeHtml(s.contact_person || 'No contact on file') +
                ' · ' + s.product_count + ' material(s) supplied</span>' +
        '</li>').join('');

    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function onSupplierKey(event) {
    const list = document.getElementById('po-supplier-list');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        poSupplierHighlight = (poSupplierHighlight + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === poSupplierHighlight));
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        const pick = items[poSupplierHighlight >= 0 ? poSupplierHighlight : 0];
        if (pick) pick.click();
        return;
    }

    if (event.key === 'Escape') {
        list.hidden = true;
        list.innerHTML = '';
    }
}

function pickSupplier(supplierId) {
    poSupplier = poSuppliers.find((s) => s.id === supplierId) || null;

    const box = document.getElementById('po-supplier');
    if (box && poSupplier) box.value = poSupplier.name;

    const list = document.getElementById('po-supplier-list');
    if (list) { list.hidden = true; list.innerHTML = ''; }

    renderSupplierState();
}

// nothing typed, a known company, or a new one
function renderSupplierState() {
    const box = document.getElementById('po-supplier');
    const known = document.getElementById('po-supplier-known');
    const card = document.getElementById('po-supplier-new');
    if (!box) return;

    const typed = box.value.trim();

    if (poSupplier) {
        if (known) {
            known.hidden = false;
            known.innerHTML =
                '<strong>' + escapeHtml(poSupplier.name) + '</strong> is already on file. ' +
                escapeHtml(poSupplier.contact_person || 'No contact person recorded') +
                (poSupplier.contact_number ? ' · ' + escapeHtml(poSupplier.contact_number) : '') +
                (poSupplier.address ? '<br>' + escapeHtml(poSupplier.address) : '');
        }
        if (card) card.hidden = true;
        return;
    }

    if (known) known.hidden = true;

    if (card) {
        card.hidden = typed === '';
        const sub = document.getElementById('po-supplier-new-sub');
        if (sub && typed !== '') {
            sub.textContent = '"' + typed + '" is not on file. These go on the printed order ' +
                'and are saved with the company, so the next order to them is already filled in.';
        }
    }
}

// ==========================================
// THE ORDER LINES
// ==========================================
function addPurchaseLine() {
    const box = document.getElementById('po-lines');
    if (!box) return;

    const index = poLineCount++;
    const pickerId = 'po-mat-' + index;

    const row = document.createElement('div');
    row.className = 'po-line';
    row.id = 'po-line-' + index;
    row.dataset.picker = pickerId;
    row.innerHTML =
        materialPickerHtml(pickerId, 'Material') +
        '<div class="form-group"><label for="po-qty-' + index + '">Quantity</label>' +
        '<input type="number" id="po-qty-' + index + '" class="form-control po-qty" min="1" value="1" ' +
               'oninput="renderPoTotals()"></div>' +
        '<div class="form-group"><label for="po-cost-' + index + '">Unit cost</label>' +
        '<input type="number" id="po-cost-' + index + '" class="form-control po-cost" min="0" step="0.01" ' +
               'value="0.00" oninput="renderPoTotals()"></div>' +
        '<div class="form-group"><label>Line total</label>' +
        '<p class="po-sum-value" id="po-line-total-' + index + '">0.00</p></div>' +
        '<button type="button" class="btn btn-sm btn-danger po-remove" ' +
                'onclick="removePurchaseLine(' + index + ')">Remove</button>';

    box.appendChild(row);
    renderPoTotals();
}

function removePurchaseLine(index) {
    const row = document.getElementById('po-line-' + index);
    if (!row) return;

    if (document.querySelectorAll('.po-line').length === 1) {
        notifyWarning('A purchase order needs at least one line.', 'Cannot remove');
        return;
    }

    delete matPickers[row.dataset.picker];
    row.remove();
    renderPoTotals();
}

// priced as it is typed; harmless on a page without the form
function renderPoTotals() {
    let total = 0;

    document.querySelectorAll('.po-line').forEach((row) => {
        const index = row.id.replace('po-line-', '');
        const qty = parseInt(row.querySelector('.po-qty').value, 10) || 0;
        const cost = parseFloat(row.querySelector('.po-cost').value) || 0;
        const line = qty * cost;
        total += line;

        const cell = document.getElementById('po-line-total-' + index);
        if (cell) cell.textContent = peso(line);
    });

    const sum = document.getElementById('po-total');
    if (sum) sum.textContent = peso(total);

    const count = document.getElementById('po-line-count');
    if (count) {
        const lines = document.querySelectorAll('.po-line').length;
        count.textContent = lines + (lines === 1 ? ' line' : ' lines');
    }
}

async function handleCreatePurchaseOrder(event) {
    event.preventDefault();

    const box = document.getElementById('po-supplier');
    const company = box ? box.value.trim() : '';

    if (company === '') {
        notifyWarning('Type the supplier company name this order goes to.', 'Order not sent');
        if (box) box.focus();
        return;
    }

    const rows = [...document.querySelectorAll('.po-line')];
    const items = [];

    for (const row of rows) {
        const picked = matValue(row.dataset.picker);

        if (!picked.ok) {
            notifyWarning('Every line needs a material. Pick one from the list, or add it as ' +
                'a new material.', 'Order not sent');
            const field = document.getElementById(row.dataset.picker + '-box');
            if (field) field.focus();
            return;
        }

        const quantity = parseInt(row.querySelector('.po-qty').value, 10);
        if (!quantity || quantity <= 0) {
            notifyWarning('Every line needs a quantity greater than zero.', 'Order not sent');
            return;
        }

        if (picked.isNew && picked.unitName === '') {
            notifyWarning('"' + picked.newName + '" needs a unit before it can be added. ' +
                'What is it counted in?', 'Order not sent');
            const field = document.getElementById(row.dataset.picker + '-unit');
            if (field) field.focus();
            return;
        }

        items.push({
            productId: picked.productId,
            newName: picked.newName,
            unitName: picked.unitName,
            categoryName: picked.categoryName,
            brandName: picked.brandName,
            price: picked.price,
            quantity: quantity,
            unitCost: parseFloat(row.querySelector('.po-cost').value) || 0
        });
    }

    const detail = (id) => {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    };

    try {
        const response = await fetch('/api/purchase-orders', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                supplierId: poSupplier ? poSupplier.id : null,
                supplierName: company,
                contactPerson: detail('po-supplier-contact'),
                contactNumber: detail('po-supplier-number'),
                supplierEmail: detail('po-supplier-email'),
                supplierAddress: detail('po-supplier-address'),
                items: items
            })
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        resetPurchaseOrderForm();

        poMaterialsLoaded = false;
        poSuppliersLoaded = false;
        await refreshPurchaseOrders();
        poAfterChange();

        // straight to the document: printing it is the next thing that happens
        if (result.poId) openPurchaseOrderDocument(result.poId);
    } catch (error) {
        notifyOffline();
    }
}

function resetPurchaseOrderForm() {
    poSupplier = null;

    const box = document.getElementById('po-supplier');
    if (box) box.value = '';

    ['po-supplier-contact', 'po-supplier-number', 'po-supplier-email', 'po-supplier-address']
        .forEach((id) => {
            const field = document.getElementById(id);
            if (field) field.value = '';
        });

    Object.keys(matPickers).forEach((key) => delete matPickers[key]);

    const lines = document.getElementById('po-lines');
    if (lines) lines.innerHTML = '';
    poLineCount = 0;
    addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

// The history. Receive is only offered to a page that counts deliveries in.
function buildPurchaseOrderPanel() {
    createDataPanel({
        key: poSetup.key,
        tableId: 'po-table',
        columns: 7,
        pagerId: 'po-pager',
        countPillId: 'po-count',
        idField: 'po_id',
        filters: { status: 'all' },

        gate: {
            title: 'No purchase orders loaded',
            text: poSetup.gateText,
            button: 'Load Data'
        },

        load: () => getJson('/api/purchase-orders'),

        match: (po, query) => prefixMatch([po.supplier_name, po.po_id, '#' + po.po_id], query),
        filter: (po, filters) => filters.status === 'all' || po.status === filters.status,

        renderRow: (po, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openPurchaseOrderDetail(' + po.po_id + ')">' +
            '<td class="cell-id">#' + po.po_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(po.supplier_name) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(po.order_date).slice(0, 10)) + '</td>' +
            '<td class="cell-num">' + po.line_count + '</td>' +
            '<td class="cell-num">' + peso(po.total_cost) + '</td>' +
            '<td>' + statusBadge(po.status) + '</td>' +
            '<td class="cell-action no-print" onclick="event.stopPropagation()">' +
                '<button type="button" class="btn btn-sm btn-ghost" ' +
                        'onclick="openPurchaseOrderDocument(' + po.po_id + ')">Open order</button>' +
                (poSetup.canReceive && po.status === 'Pending'
                    ? ' <button type="button" class="btn btn-sm btn-accent" ' +
                      'onclick="openReceiveOrder(' + po.po_id + ')">Receive</button>'
                    : '') +
            '</td></tr>'
    });
}

function purchaseOrderPanel() { return getDataPanel(poSetup.key); }

function findPurchaseOrder(poId) {
    const panel = purchaseOrderPanel();
    return panel ? panel.find(poId, 'po_id') : null;
}

async function refreshPurchaseOrders() {
    const panel = purchaseOrderPanel();
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function loadPurchaseOrders() { await refreshPurchaseOrders(); }

// The order as a printable document for a supplier with no login.
async function openPurchaseOrderDocument(poId) {
    poShowPanel('panel-po-doc', 'Purchase Order #' + poId);

    const box = document.getElementById('po-doc');
    if (box) box.innerHTML = '<p class="panel-sub">Opening order #' + poId + '.</p>';

    try {
        poDocument = await getJson('/api/purchase-orders/' + poId + '/document');
        renderPurchaseOrderDocument();
    } catch (error) {
        if (box) {
            box.innerHTML = '<p class="panel-sub">That order could not be opened. ' +
                'It may have been removed since this list was loaded.</p>';
        }
    }
}

function renderPurchaseOrderDocument() {
    const box = document.getElementById('po-doc');
    if (!box || !poDocument) return;

    const order = poDocument.order;
    const shop = poDocument.shop || {};
    const items = poDocument.items || [];

    const total = items.reduce((sum, item) => sum + Number(item.line_cost || 0), 0);
    const units = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const ordered = String(order.order_date || '').slice(0, 10);

    const lines = items.map((item, index) =>
        '<tr>' +
            '<td class="num">' + (index + 1) + '</td>' +
            '<td><strong>' + escapeHtml(item.product_name) + '</strong>' +
                (item.brand_name ? '<br><span class="po-doc-party-line">' +
                    escapeHtml(item.brand_name) + '</span>' : '') + '</td>' +
            '<td>' + escapeHtml(item.category_name || '--') + '</td>' +
            '<td class="num">' + item.quantity + ' ' + escapeHtml(item.unit_name || '') + '</td>' +
            '<td class="num">' + peso(item.unit_cost) + '</td>' +
            '<td class="num">' + peso(item.line_cost) + '</td>' +
        '</tr>').join('');

    box.innerHTML =
        '<div class="po-doc-actions no-print">' +
            '<button type="button" class="btn btn-accent" onclick="window.print()">Print this order</button>' +
            '<button type="button" class="btn btn-ghost" onclick="showPurchaseOrderHistory(event)">Back to history</button>' +
            (poSetup.canReceive && order.status === 'Pending'
                ? '<button type="button" class="btn btn-success" ' +
                  'onclick="openReceiveOrder(' + order.po_id + ')">Receive this delivery</button>'
                : '') +
        '</div>' +
        '<div class="po-doc">' +
            '<div class="po-doc-stripe"></div>' +
            '<div class="po-doc-inner">' +
                '<div class="po-doc-head">' +
                    '<div class="po-doc-shop">' +
                        '<div class="po-doc-shop-name">' + escapeHtml(shop.store_name || 'Hardware Store') + '</div>' +
                        '<div class="po-doc-shop-line">' + escapeHtml(shop.address || '') + '</div>' +
                        '<div class="po-doc-shop-line">' +
                            (shop.tin ? 'TIN ' + escapeHtml(shop.tin) : '') +
                            (shop.registration_type ? ' · ' + escapeHtml(shop.registration_type) : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="po-doc-kind">' +
                        '<div class="po-doc-kind-title">Purchase Order</div>' +
                        '<div class="po-doc-ref">#' + order.po_id + '</div>' +
                        '<div class="po-doc-date">Raised ' + escapeHtml(ordered) + '</div>' +
                        '<div class="po-doc-date">' + escapeHtml(order.status) + '</div>' +
                    '</div>' +
                '</div>' +

                '<div class="po-doc-parties">' +
                    '<div>' +
                        '<div class="po-doc-party-label">Order to</div>' +
                        '<div class="po-doc-party-name">' + escapeHtml(order.supplier_name) + '</div>' +
                        '<div class="po-doc-party-line">' +
                            escapeHtml(order.contact_person || 'Attention: Sales') + '</div>' +
                        '<div class="po-doc-party-line">' +
                            escapeHtml(order.contact_number || '') +
                            (order.supplier_email ? '<br>' + escapeHtml(order.supplier_email) : '') +
                            (order.supplier_address ? '<br>' + escapeHtml(order.supplier_address) : '') +
                        '</div>' +
                    '</div>' +
                    '<div>' +
                        '<div class="po-doc-party-label">Deliver to</div>' +
                        '<div class="po-doc-party-name">' + escapeHtml(shop.store_name || 'Hardware Store') + '</div>' +
                        '<div class="po-doc-party-line">' + escapeHtml(shop.address || '') + '</div>' +
                        '<div class="po-doc-party-line">Raised by ' +
                            escapeHtml(order.raised_by || 'Manager') + '</div>' +
                    '</div>' +
                '</div>' +

                '<table>' +
                    '<thead><tr>' +
                        '<th style="width:44px">No</th><th>Material</th><th>Category</th>' +
                        '<th style="width:110px">Quantity</th>' +
                        '<th style="width:110px">Unit cost</th>' +
                        '<th style="width:120px">Amount</th>' +
                    '</tr></thead>' +
                    '<tbody>' + (lines || '<tr><td colspan="6">No lines on this order.</td></tr>') + '</tbody>' +
                    '<tfoot><tr>' +
                        '<td colspan="3">' + items.length + ' line(s)</td>' +
                        '<td class="num">' + units + '</td>' +
                        '<td>Total</td>' +
                        '<td class="po-doc-total">' + peso(total) + '</td>' +
                    '</tr></tfoot>' +
                '</table>' +

                '<p class="po-doc-note">' +
                    'Please quote purchase order #' + order.po_id + ' on the delivery receipt and ' +
                    'the invoice. Goods are counted on arrival and anything short or damaged is ' +
                    'recorded against this order.' +
                    (shop.invoice_note ? '<br>' + escapeHtml(shop.invoice_note) : '') +
                '</p>' +

                '<div class="po-doc-signs">' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Prepared by</span>' +
                        escapeHtml(order.raised_by || 'Manager') + '</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Approved by</span>Manager</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Received by</span>' +
                        escapeHtml(order.supplier_name) + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// Receiving: what was ordered on the left, what came off the lorry typed on
// the right, and a way to add something that was never ordered.
async function openReceiveOrder(poId) {
    if (!poSetup.canReceive) return;

    poShowPanel('panel-po-receive', 'Receive Delivery');

    const box = document.getElementById('recv-lines');
    if (box) box.innerHTML = '<p class="panel-sub">Opening order #' + poId + '.</p>';

    recvExtraCount = 0;

    try {
        await ensurePoMaterials(false);
        const items = await getJson('/api/purchase-orders/' + poId + '/items');
        poReceiving = { poId: poId, items: items, order: findPurchaseOrder(poId) };
        renderReceiveSheet();
    } catch (error) {
        if (box) box.innerHTML = '<p class="panel-sub">That order could not be opened.</p>';
    }
}

function renderReceiveSheet() {
    const box = document.getElementById('recv-lines');
    if (!box || !poReceiving) return;

    const heading = document.getElementById('recv-heading');
    if (heading) {
        heading.textContent = 'Purchase Order #' + poReceiving.poId +
            (poReceiving.order ? ' · ' + poReceiving.order.supplier_name : '');
    }

    box.innerHTML = poReceiving.items.map((item, index) =>
        '<div class="recv-line" data-recv-index="' + index + '" data-product="' + item.product_id + '">' +
            '<div>' +
                '<div class="recv-name">' + escapeHtml(item.product_name) + '</div>' +
                '<div class="recv-meta">' + escapeHtml(item.category_name || 'No category') +
                    ' · ' + peso(item.unit_cost) + ' each</div>' +
            '</div>' +
            '<div>' +
                '<div class="recv-meta">Ordered</div>' +
                '<div class="recv-ordered">' + item.quantity + ' ' +
                    escapeHtml(item.unit_name || '') + '</div>' +
            '</div>' +
            '<div>' +
                '<label class="recv-meta" for="recv-qty-' + index + '">Arrived</label>' +
                '<input type="number" class="form-control recv-qty" id="recv-qty-' + index + '" ' +
                       'min="0" value="' + item.quantity + '" ' +
                       'oninput="renderReceiveVerdict(' + index + ', ' + item.quantity + ')">' +
            '</div>' +
            '<div class="recv-verdict is-exact" id="recv-verdict-' + index + '">As ordered</div>' +
        '</div>').join('');

    const extras = document.getElementById('recv-extras');
    if (extras) extras.innerHTML = '';
}

function renderReceiveVerdict(index, ordered) {
    const field = document.getElementById('recv-qty-' + index);
    const box = document.getElementById('recv-verdict-' + index);
    if (!field || !box) return;

    const arrived = parseInt(field.value, 10);

    if (isNaN(arrived) || arrived < 0) {
        box.className = 'recv-verdict is-short';
        box.textContent = 'Type how many arrived.';
        return;
    }

    if (arrived === ordered) {
        box.className = 'recv-verdict is-exact';
        box.textContent = 'As ordered';
        return;
    }

    if (arrived === 0) {
        box.className = 'recv-verdict is-short';
        box.textContent = 'Nothing arrived. This line comes off the order.';
        return;
    }

    if (arrived < ordered) {
        box.className = 'recv-verdict is-short';
        box.textContent = (ordered - arrived) + ' short of the order.';
        return;
    }

    box.className = 'recv-verdict is-over';
    box.textContent = (arrived - ordered) + ' more than ordered.';
}

// something on the lorry that is not on the order
function addReceiveExtra() {
    const box = document.getElementById('recv-extras');
    if (!box) return;

    const index = recvExtraCount++;
    const pickerId = 'recv-mat-' + index;

    const row = document.createElement('div');
    row.className = 'recv-line is-extra';
    row.id = 'recv-extra-' + index;
    row.dataset.picker = pickerId;
    row.innerHTML =
        materialPickerHtml(pickerId, 'Arrived, not on the order') +
        '<div class="form-group"><label for="recv-extra-qty-' + index + '">Quantity</label>' +
        '<input type="number" class="form-control recv-qty" id="recv-extra-qty-' + index + '" ' +
               'min="1" value="1"></div>' +
        '<div class="form-group"><label for="recv-extra-cost-' + index + '">Unit cost</label>' +
        '<input type="number" class="form-control recv-qty" id="recv-extra-cost-' + index + '" ' +
               'min="0" step="0.01" value="0.00"></div>' +
        '<button type="button" class="btn btn-sm btn-danger" ' +
                'onclick="removeReceiveExtra(' + index + ')">Remove</button>';

    box.appendChild(row);
}

function removeReceiveExtra(index) {
    const row = document.getElementById('recv-extra-' + index);
    if (!row) return;
    delete matPickers[row.dataset.picker];
    row.remove();
}

async function submitReceiveOrder() {
    if (!poReceiving) return;

    const received = poReceiving.items.map((item, index) => {
        const field = document.getElementById('recv-qty-' + index);
        return {
            productId: item.product_id,
            quantity: Math.max(0, parseInt(field ? field.value : item.quantity, 10) || 0)
        };
    });

    const extras = [...document.querySelectorAll('#recv-extras .recv-line')];

    for (const row of extras) {
        const index = row.id.replace('recv-extra-', '');
        const picked = matValue(row.dataset.picker);

        if (!picked.ok) {
            notifyWarning('An extra line has no material on it. Pick one, add it as new, or ' +
                'remove the line.', 'Nothing received');
            return;
        }

        if (picked.isNew && picked.unitName === '') {
            notifyWarning('"' + picked.newName + '" needs a unit before it can be added. ' +
                'What is it counted in?', 'Nothing received');
            return;
        }

        const quantity = parseInt(document.getElementById('recv-extra-qty-' + index).value, 10);
        if (!quantity || quantity <= 0) {
            notifyWarning('An extra line needs a quantity greater than zero.', 'Nothing received');
            return;
        }

        received.push({
            productId: picked.productId,
            newName: picked.newName,
            unitName: picked.unitName,
            categoryName: picked.categoryName,
            brandName: picked.brandName,
            quantity: quantity,
            unitCost: parseFloat(document.getElementById('recv-extra-cost-' + index).value) || 0
        });
    }

    const short = received.filter((line, i) =>
        i < poReceiving.items.length && line.quantity < poReceiving.items[i].quantity).length;

    const yes = await askConfirm(
        'The figures on this sheet go straight onto the shelf, and purchase order #' +
        poReceiving.poId + ' closes.' +
        (short > 0 ? ' ' + short + ' line(s) came up short and the order will be corrected to say so.' : ''),
        { title: 'Receive this delivery?', eyebrow: 'Purchase Orders', confirmLabel: 'Receive it' });

    if (!yes) return;

    try {
        const response = await fetch('/api/purchase-orders/' + poReceiving.poId + '/receive', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({ received: received })
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        poReceiving = null;
        poMaterialsLoaded = false;

        Object.keys(matPickers).forEach((key) => delete matPickers[key]);

        showPurchaseOrderHistory();
        await refreshPurchaseOrders();
        poAfterChange();
    } catch (error) {
        notifyOffline();
    }
}

// ==========================================
// ONE ORDER, IN A POPUP
// ==========================================
async function openPurchaseOrderDetail(poId) {
    const po = findPurchaseOrder(poId);
    if (!po) return;

    let items = [];
    try { items = await getJson('/api/purchase-orders/' + poId + '/items'); } catch (error) { items = []; }

    const summary = '<div class="detail-grid">' +
        detailField('Purchase Order', '#' + po.po_id) +
        detailField('Supplier', escapeHtml(po.supplier_name)) +
        detailField('Status', statusBadge(po.status)) +
        detailField('Ordered On', escapeHtml(String(po.order_date).slice(0, 16))) +
        detailField('Lines', String(po.line_count)) +
        detailField('Total Cost', peso(po.total_cost)) +
        '</div>';

    const contact = '<div class="detail-grid">' +
        detailField('Contact Person', escapeHtml(po.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(po.contact_number || 'Not set')) +
        detailField('Total Units', String(po.total_units)) +
        '</div>' +
        '<div class="detail-actions">' +
            '<button type="button" class="btn btn-ghost" onclick="closeModal(\'detail-modal\'); ' +
                'openPurchaseOrderDocument(' + po.po_id + ')">Open the printed order</button>' +
            (poSetup.canReceive && po.status === 'Pending'
                ? '<button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); ' +
                  'openReceiveOrder(' + po.po_id + ')">Count in the delivery</button>'
                : '') +
        '</div>' +
        (po.status === 'Pending'
            ? (poSetup.canReceive ? ''
                : '<p class="detail-note">Still waiting for the delivery. The manager receives ' +
                  'the order once the goods have been checked against it.</p>')
            : '<p class="detail-note">This order was already ' + escapeHtml(String(po.status).toLowerCase()) + '.</p>');

    const lines = detailTable(['Material', 'Qty', 'Unit Cost', 'Line Cost'],
        items.map((it) => [
            escapeHtml(it.product_name),
            it.quantity + ' ' + escapeHtml(it.unit_name || ''),
            peso(it.unit_cost),
            peso(it.line_cost)
        ]), [1, 2, 3]);

    openDetailModal('Purchase Order #' + po.po_id, po.supplier_name + ' · ' + po.status, 'P' + po.po_id, [
        { label: 'Summary', body: summary },
        { label: 'Lines (' + items.length + ')', body: lines },
        { label: 'Supplier', body: contact }
    ]);
}

// a click anywhere else closes whichever suggestion list is open
document.addEventListener('click', function (event) {
    if (event.target.closest('.suggest-wrap')) return;
    hideAllMatSuggestions();
});
