// inventory-clerk.js  --  INVENTORY CLERK
// Loaded by: inventory-dashboard.html
// ------------------------------------------------------------------------
// ==========================================
// INVENTORY MODULE
// ==========================================
let invProducts = [];
let invLoaded = false;
let invPurchaseOrders = [];
let invReturns = [];
let invArchived = [];
let returnFilter = 'All';
let poLineCount = 0;

// The material and the unit chosen on the adjustment form. Both are typed
// boxes rather than dropdowns, so what is chosen has to be held apart from
// what is in the box: text that matches nothing is not a choice.
let adjustMaterial = null;
let adjustSuggestHighlight = -1;

let invUnits = [];
let invUnitsLoaded = false;
let unitSuggestHighlight = -1;

function invBody() { return document.querySelector('#inv-table tbody'); }

function showInventoryPanel(panelId, title, event) {
    if (event) event.preventDefault();

    document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.style.display = panel.id === panelId ? 'block' : 'none';
    });
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('inv-page-title');
    if (heading) heading.textContent = title;

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// the logo comes back here, with an empty table
function showInventoryHome(event) {
    showInventoryPanel('panel-inventory', 'Inventory Management', event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));

    const search = document.getElementById('inv-search');
    if (search) search.value = '';

    // the panel is left closed; the banner is one small query and is the
    // reason this screen is the default one
    const panel = getDataPanel('clerk-materials');
    if (panel) panel.reset();

    loadStockBanner();
}

// Opening a screen fills the dropdowns it needs to be usable and nothing else.
// The tables on it stay closed until somebody asks, which is the point: five
// dashboards each fetching four or five tables on open is twenty queries fired
// for the one screen a person actually wanted.
function showAdjust(event) {
    showInventoryPanel('panel-adjust', 'Stock Adjustment', event);
    // The two typed boxes read from these, and both are cheap. Nothing else
    // on this screen queries anything.
    ensureInventoryLoaded(true);
    loadUnits(false);
    renderAdjustMaterialVerdict();
    renderAdjustPreview();
}

// History, on its own screen. It used to sit under the form, which meant the
// clerk who came to correct one figure scrolled past a hundred rows of it to
// reach the button.
function showAdjustmentHistory(event) {
    showInventoryPanel('panel-adjust-log', 'Adjustment History', event);
}

function showReorder(event) { showInventoryPanel('panel-reorder', 'Reorder Point Settings', event); }
// The form, on its own. What used to sit under it -- every order the shop has
// ever raised -- is a screen of its own now, one tab away.
function showPurchaseOrders(event) {
    showInventoryPanel('panel-po', 'New Purchase Order', event);
    loadSuppliers(false);
    ensureInventoryLoaded(false);
    if (poLineCount === 0) addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

function showPurchaseOrderHistory(event) {
    showInventoryPanel('panel-po-history', 'Order History', event);
}
function showReturns(event) { showInventoryPanel('panel-returns', 'Returned Items', event); }
function showDamageReport(event) { showInventoryPanel('panel-report', 'Make a Report', event); loadProductOptions(); }
function showInventoryArchive(event) { showInventoryPanel('panel-archive', 'Archive', event); }

// ---------- the material list ----------
async function ensureInventoryLoaded(force) {
    if (invLoaded && !force) return true;
    try {
        invProducts = await getJson('/api/inventory/products?archived=false');
        invLoaded = true;
        return true;
    } catch (error) {
        invLoaded = false;
        return false;
    }
}

// ==========================================
// THE MATERIAL LIST
//
// The one table on this page somebody opens the screen for, and it still
// starts closed: a clerk arriving to adjust one product's stock does not need
// the whole catalogue fetched first, and typing into the search box is itself
// a request to load it.
// ==========================================
function buildMaterialsPanel() {
    createDataPanel({
        key: 'clerk-materials',
        tableId: 'inv-table',
        columns: 6,
        pagerId: 'inv-pager',
        countPillId: 'inv-count',
        idField: 'product_id',
        filters: { status: 'all' },

        gate: {
            title: 'No materials loaded',
            text: 'Search above for one material, pick a stock status, or press Load Data ' +
                  'for the whole list. Archived materials never appear here.',
            button: 'Load Data'
        },

        load: async () => {
            invProducts = await getJson('/api/inventory/products?archived=false');
            invLoaded = true;
            return invProducts;
        },

        match: (p, query) =>
            (p.product_name + ' ' + (p.category_name || '') + ' ' + (p.supplier_name || '') +
             ' ' + p.stock_status).toLowerCase().indexOf(query) !== -1,

        filter: (p, filters) => filters.status === 'all' || p.stock_status === filters.status,

        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openMaterialDetail(' + p.product_id + ')">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td class="cell-num">' + p.reorder_point + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>'
    });
}

// "Material List" in the sidebar is the one menu item that means "show me
// everything", so it is the one place that opens the panel and fills it.
async function loadInventoryAll(event) {
    if (event) event.preventDefault();

    showInventoryPanel('panel-inventory', 'Inventory Management');

    const link = document.querySelector('a[data-panel-link="panel-inventory"]');
    if (link) link.classList.add('active');

    const panel = getDataPanel('clerk-materials');
    if (panel) await panel.open();

    loadStockBanner();
}

// ---------- the low stock banner ----------
async function loadStockBanner() {
    const box = document.getElementById('stock-banner');
    if (!box) return;

    try {
        const s = await getJson('/api/inventory/summary');
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
            '<button type="button" class="btn btn-sm" onclick="showReorder(event)">Review Reorder Points</button></div>';
    } catch (error) {
        box.innerHTML = '';
    }
}

// ---------- shared option lists ----------
async function loadProductOptions() {
    const selects = document.querySelectorAll('[data-product-select]');
    if (selects.length === 0) return;

    if (!(await ensureInventoryLoaded(true))) return;

    const options = invProducts.map((p) =>
        '<option value="' + p.product_id + '">' + escapeHtml(p.product_name) +
        ' (' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + ')</option>'
    ).join('');
    selects.forEach((s) => { s.innerHTML = options; });
}

async function loadSupplierOptions() {
    const selects = document.querySelectorAll('[data-supplier-select]');
    if (selects.length === 0) return;

    try {
        const rows = await getJson('/api/records/supplier');
        const options = rows.map((s) => '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
        selects.forEach((s) => { s.innerHTML = options; });
    } catch (error) {
        console.error('Unable to load suppliers:', error);
    }
}

// ==========================================
// STOCK ADJUSTMENT
//
// Two typed boxes where there used to be a dropdown and nothing at all.
//
// THE MATERIAL. A <select> holding six hundred materials is the wrong control
// for a stockroom: finding one by scrolling, while holding the thing you are
// counting, is slower than typing three letters of its name. It shares its
// shape with the pickers on the till so there is nothing new to learn, and it
// shares their rule too: text that matches nothing is not a choice. A stock
// adjustment moves a real figure on a real shelf, so the strip under the box
// is the only thing that says a material was chosen, and the form refuses to
// send without one.
//
// THE UNIT. A hardware shop counts almost nothing in the same unit twice, and
// the log recorded a bare figure: "+20" against Portland Cement is twenty of
// something nobody can name six months later. The clerk knows at the moment
// they type it. The list suggests what the shop already uses and accepts what
// it does not, because a clerk holding a sack of nails should not have to
// wait for somebody to open the database and add the word.
// ==========================================
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

    // Typing on after a choice unmakes it. Leaving the old material selected
    // under different text is how stock moves on the wrong shelf.
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

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (query.length < 1 || invProducts.length === 0) { hide(); return; }

    if (adjustMaterial && String(adjustMaterial.product_name).trim().toLowerCase() === query) {
        hide();
        return;
    }

    const starts = [];
    const contains = [];
    const other = [];

    invProducts.forEach((p) => {
        const name = String(p.product_name || '').toLowerCase();
        const meta = (String(p.brand_name || '') + ' ' + String(p.category_name || '')).toLowerCase();

        if (name.indexOf(query) === 0) starts.push(p);
        else if (name.indexOf(query) !== -1) contains.push(p);
        else if (meta.indexOf(query) !== -1) other.push(p);
    });

    const found = starts.concat(contains, other).slice(0, 6);
    if (found.length === 0) { hide(); return; }

    list.innerHTML = found.map((p, i) => {
        const stock = Number(p.quantity_in_stock);
        const meta = [p.category_name, p.brand_name].filter(Boolean).map(escapeHtml);

        // Stock on hand is the figure, because that is the one about to
        // change and the one the clerk is standing there checking.
        return '<li class="suggest-item" role="option" id="adjust-suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickAdjustMaterial(' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + stock + ' ' + escapeHtml(p.unit_name || '') + '</span>' +
            '</span>' +
            (meta.length ? '<span class="suggest-note">' + meta.join(' &middot; ') + '</span>' : '') +
            '</li>';
    }).join('');

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
        items.forEach((item, i) => item.classList.toggle('is-active', i === adjustSuggestHighlight));
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
    const found = invProducts.find((p) => p.product_id === productId);
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

// One place that decides what is chosen, so the hidden field, the strip, the
// unit box and the preview can never disagree about it.
function setAdjustMaterial(product) {
    adjustMaterial = product || null;

    const idBox = adjustProductIdBox();
    if (idBox) idBox.value = product ? String(product.product_id) : '';

    // The material's own unit is the right answer nine times out of ten, so
    // it is filled in rather than asked for. It stays editable, because the
    // tenth time is a material whose unit was wrong or never set.
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

    const meta = [p.category_name, p.brand_name].filter(Boolean).map(escapeHtml).join(' &middot; ');
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

function renderAdjustMaterialVerdict() {
    const box = document.getElementById('adjust-material-verdict');
    if (!box) return;

    const typed = adjustMaterialBox() ? adjustMaterialBox().value.trim() : '';

    if (adjustMaterial) { box.textContent = ''; box.className = 'pick-verdict'; return; }

    if (typed === '') {
        box.className = 'pick-verdict';
        box.textContent = 'Type a few letters and choose from the list.';
        return;
    }

    box.className = 'pick-verdict is-stop';
    box.textContent = 'No material chosen yet. An adjustment moves a real figure, so it has to name one.';
}

// ---------- the unit ----------
async function loadUnits(force) {
    if (invUnitsLoaded && !force) return true;

    try {
        invUnits = await getJson('/api/records/unit');
        invUnitsLoaded = true;
        return true;
    } catch (error) {
        // Not fatal. A unit left blank keeps whatever the material already
        // uses, so a failed lookup does not stop a clerk correcting stock.
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

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (invUnits.length === 0) { hide(); return; }

    // An empty box offers the whole short list. Unlike the material box there
    // are a dozen of these, not six hundred, so showing them costs nothing and
    // saves the clerk guessing what the shop already calls things.
    const matches = query === ''
        ? invUnits.slice(0, 8)
        : invUnits.filter((u) => String(u.name).toLowerCase().indexOf(query) !== -1).slice(0, 8);

    // A name that is already exactly right needs no list under it.
    if (matches.length === 1 && String(matches[0].name).toLowerCase() === query) { hide(); return; }
    if (matches.length === 0) { hide(); return; }

    list.innerHTML = matches.map((u, i) => {
        const used = Number(u.product_count) || 0;
        return '<li class="suggest-item" role="option" id="unit-suggest-' + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="pickAdjustUnit(' + JSON.stringify(String(u.name)).replace(/"/g, '&quot;') + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(u.name) + '</span>' +
                '<span class="suggest-figure">' + used + '</span>' +
            '</span></li>';
    }).join('');

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
        items.forEach((item, i) => item.classList.toggle('is-active', i === unitSuggestHighlight));
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

// Says what the typed unit is about to do: nothing, change what this material
// is counted in, or add a word to the shop's list. All three are fine, and
// all three should be said out loud before the button rather than discovered
// in the log afterwards.
function renderAdjustUnitVerdict() {
    const box = document.getElementById('adjust-unit-verdict');
    if (!box) return;

    const typed = adjustUnitBox() ? adjustUnitBox().value.trim() : '';

    if (typed === '') {
        box.className = 'unit-verdict';
        box.textContent = adjustMaterial
            ? 'Left empty, this stays counted in ' + (adjustMaterial.unit_name || 'whatever it uses now') + '.'
            : 'pcs, bag, kilogram, box. Anything the shop actually counts in.';
        return;
    }

    const known = invUnits.some((u) => String(u.name).toLowerCase() === typed.toLowerCase());
    const current = adjustMaterial ? String(adjustMaterial.unit_name || '') : '';
    const changing = adjustMaterial && current.toLowerCase() !== typed.toLowerCase();

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

// ---------- what this will do ----------
// The arithmetic, before the button. A Remove that would take the shelf below
// zero is the mistake worth catching here rather than as a refusal from the
// server after the clerk has walked away.
function renderAdjustPreview() {
    const box = document.getElementById('adjust-preview');
    const form = document.getElementById('adjust-form');
    if (!box || !form) return;

    const quantity = parseInt(form.elements.quantity.value, 10);

    if (!adjustMaterial || !Number.isFinite(quantity)) {
        box.textContent = '';
        box.className = 'adjust-preview';
        return;
    }

    const before = Number(adjustMaterial.quantity_in_stock) || 0;
    const type = form.elements.adjustmentType.value;
    const unit = (adjustUnitBox() && adjustUnitBox().value.trim()) || adjustMaterial.unit_name || '';

    let after = before;
    if (type === 'Add') after = before + quantity;
    else if (type === 'Remove') after = before - quantity;
    else after = quantity;

    if (after < 0) {
        box.className = 'adjust-preview is-stop';
        box.textContent = 'That would leave ' + after + ' on the shelf. Only ' + before + ' ' +
            unit + ' on hand.';
        return;
    }

    const reorder = Number(adjustMaterial.reorder_point) || 0;
    const low = after <= reorder;

    box.className = 'adjust-preview ' + (low ? 'is-watch' : 'is-good');
    box.textContent = adjustMaterial.product_name + ': ' + before + ' to ' + after + ' ' + unit + '.' +
        (low ? ' That is at or below its reorder point of ' + reorder + ', so the manager is told.' : '');
}

// ---------- the log ----------
// History rather than a working list, and on its own screen now: it used to
// sit under the form, so a clerk correcting one figure scrolled past a
// hundred rows they had not asked for to reach the button.
function buildAdjustmentsPanel() {
    createDataPanel({
        key: 'clerk-adjustments',
        tableId: 'adjust-table',
        columns: 8,
        pagerId: 'adjust-pager',
        countPillId: 'adjust-count',
        idField: 'adjustment_id',
        filters: { type: 'all' },

        gate: {
            title: 'The log is not loaded',
            text: 'Press Load Data for every stock movement on record, or search for one material.',
            button: 'Load Data'
        },

        load: () => getJson('/api/inventory/adjustments'),

        match: (a, query) =>
            (a.product_name + ' ' + a.adjusted_by + ' ' + a.reason + ' ' + (a.unit_name || ''))
                .toLowerCase().indexOf(query) !== -1,

        filter: (a, filters) => filters.type === 'all' || a.adjustment_type === filters.type,

        renderRow: (a, index) => {
            // The unit the entry itself recorded, not the material's unit
            // today. An entry filed in bags keeps saying bags even after the
            // material is switched to kilos, because that is what was counted.
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
            '<td>' + escapeHtml(a.adjusted_by) + '</td>' +
            '<td class="cell-action">' +
                '<button type="button" class="btn btn-sm btn-ghost" ' +
                        'onclick="event.stopPropagation(); openAdjustmentDetail(' + a.adjustment_id + ')">' +
                    'View</button>' +
            '</td></tr>';
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

// kept because the adjustment form refreshes the log after a save
async function loadAdjustments() {
    const panel = getDataPanel('clerk-adjustments');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function handleAdjustStock(event) {
    event.preventDefault();
    const form = event.target;

    // The material box is free text, so the check is on what was chosen
    // rather than on what is typed in it.
    if (!adjustMaterial || !form.elements.productId.value) {
        notifyWarning('Type a few letters of the material and choose it from the list. ' +
            'An adjustment moves a real figure, so it has to name one.', 'No material chosen');
        const box = adjustMaterialBox();
        if (box) { box.focus(); box.select(); }
        renderAdjustMaterialVerdict();
        return;
    }

    const unit = form.elements.unitName ? form.elements.unitName.value.trim() : '';

    const data = {
        productId: parseInt(form.elements.productId.value, 10),
        adjustmentType: form.elements.adjustmentType.value,
        quantity: parseInt(form.elements.quantity.value, 10),
        unitName: unit,
        reason: form.elements.reason.value.trim()
    };

    if (data.reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }

    // Changing what a material is counted in re-reads every figure already on
    // its shelf: 40 bags of cement and 40 kilos are not the same shop. It is
    // a legitimate correction and a bad accident, so it is read back first.
    const current = String(adjustMaterial.unit_name || '');
    if (unit !== '' && current !== '' && unit.toLowerCase() !== current.toLowerCase()) {
        const yes = await askConfirm(
            adjustMaterial.product_name + ' is counted in ' + current + ' and you are filing this in ' + unit + '.',
            {
                title: 'Change what this is counted in?',
                eyebrow: 'Stock Adjustment',
                confirmLabel: 'Count it in ' + unit,
                tone: 'danger',
                detail: [
                    'The ' + adjustMaterial.quantity_in_stock + ' already on the shelf will be read as ' +
                        unit + ' from now on, not converted.',
                    'Every screen that shows this material will say ' + unit + '.',
                    'Entries already in the log keep saying ' + current + ', because that is what they counted.'
                ]
            });

        if (!yes) return;
    }

    try {
        const response = await fetch('/api/inventory/adjust', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);

        form.elements.quantity.value = '';
        form.elements.reason.value = '';

        // form.reset() is not used here: it would clear the material too, and
        // a clerk correcting three figures on one delivery should not have to
        // find the same material three times. What must go is the stale copy
        // of its stock figure, which the reload below replaces.
        invLoaded = false;
        invUnitsLoaded = false;
        await ensureInventoryLoaded(true);
        await loadUnits(true);

        const again = invProducts.find((m) => m.product_id === data.productId);
        setAdjustMaterial(again || null);
        if (!again) clearAdjustMaterial();

        await loadProductOptions();
        await loadAdjustments();

        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- reorder point settings ----------
function buildReorderPanel() {
    createDataPanel({
        key: 'clerk-reorder',
        tableId: 'reorder-table',
        columns: 6,
        pagerId: 'reorder-pager',
        countPillId: 'reorder-count',
        idField: 'product_id',
        filters: { status: 'all' },

        gate: {
            title: 'No materials loaded',
            text: 'Search for a material, or press Load Data to set reorder points across the list.',
            button: 'Load Data'
        },

        load: () => getJson('/api/inventory/products?archived=false'),

        match: (p, query) => p.product_name.toLowerCase().indexOf(query) !== -1,
        filter: (p, filters) => filters.status === 'all' || p.stock_status === filters.status,

        renderRow: (p, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
            '<td class="cell-num">' + p.reorder_point + '</td>' +
            '<td><input type="number" min="0" class="form-control inline-input" ' +
                'id="reorder-input-' + p.product_id + '" value="' + p.reorder_point + '"></td>' +
            '<td>' + statusBadge(p.stock_status) + '</td>' +
            '<td class="cell-action"><button type="button" class="btn btn-sm btn-success" ' +
                'onclick="saveReorderPoint(' + p.product_id + ')">Save</button></td></tr>'
    });
}

async function loadReorderTable() {
    const panel = getDataPanel('clerk-reorder');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function saveReorderPoint(productId) {
    const input = document.getElementById('reorder-input-' + productId);
    if (!input) return;

    const value = parseInt(input.value, 10);
    if (isNaN(value) || value < 0) {
        notifyWarning('A reorder point cannot be negative.', 'Not saved');
        return;
    }

    try {
        const response = await fetch('/api/inventory/reorder/' + productId, {
            method: 'PUT', headers: apiHeaders(), body: JSON.stringify({ reorderPoint: value })
        });
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

// ==========================================
// PURCHASE ORDERS
//
// Four screens where there used to be one page with two cards stacked on it:
//
//   New Purchase Order   the form, and nothing else
//   Order History        every order raised, and what became of it
//   Receive Delivery     a count sheet, opened from a pending order
//   The order itself     the printable document that goes to the supplier
//
// WHY THE HISTORY IS ITS OWN SCREEN
//
// The form and a hundred rows of history were on one page, so a clerk raising
// an order scrolled past every order the shop had ever raised to reach the
// button that sends this one. Adjustment History was split off for the same
// reason and the same argument applies here: a working form and a reference
// list are two different jobs and neither is served by sharing a page.
//
// WHY THE SUPPLIER IS TYPED RATHER THAN PICKED
//
// A dropdown of suppliers can only ever offer the companies the shop has
// already bought from, which excludes the one case that matters: buying from
// somebody new. The box takes any company name, offers the ones on file as
// you type, and asks for contact details only when the name is a new one.
//
// WHY A MATERIAL CAN BE TYPED TOO
//
// Same argument, one step further in. Half the reason to raise a purchase
// order is to buy something the shop has not stocked before, and a picker
// that only offers what is already in the database cannot express that. So
// the last row of every material list is the way out of the list: it opens
// three small fields, and the material is created with the order.
// ==========================================

let poSupplier = null;          // the company on file, once one is chosen
let invSuppliers = [];
let invSuppliersLoaded = false;
let poSupplierHighlight = -1;
let poDocument = null;          // the order currently being printed
let poReceiving = null;         // the order currently being counted in
let recvExtraCount = 0;

// ==========================================
// THE MATERIAL PICKER
//
// Shared by the order lines and the receiving sheet, because the two screens
// ask the same question and should not answer it two different ways. Each
// picker keeps its own small piece of state under an id.
// ==========================================
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

// The three facts a new material cannot be created without, and nothing else.
// A price of nothing is allowed; a name of nothing is not, and the name is
// already in the box above.
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
    await ensureInventoryLoaded(false);
    const state = matState(id);
    const typed = String(value || '').trim();

    // typing after a choice unmakes the choice: the box and what it stands
    // for never disagree
    const chosen = state.productId
        ? invProducts.find((p) => p.product_id === state.productId) : null;
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

    const matches = invProducts.filter((p) =>
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

    // The way out of the list. It is always there unless the name typed is
    // already exactly a material on the books, because at that point there is
    // nothing to create.
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
    const product = invProducts.find((p) => p.product_id === productId);
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
        const product = invProducts.find((p) => p.product_id === state.productId);
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

// What the picker is worth to whoever is sending the form.
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
async function loadSuppliers(force) {
    if (invSuppliersLoaded && !force) return true;

    try {
        invSuppliers = await getJson('/api/records/supplier');
        invSuppliersLoaded = true;
        return true;
    } catch (error) {
        invSuppliersLoaded = false;
        return false;
    }
}

// kept under its old name because other screens call it to fill their own
// supplier dropdowns
async function loadSupplierOptions() {
    if (!(await loadSuppliers(true))) return;

    const selects = document.querySelectorAll('[data-supplier-select]');
    const options = invSuppliers.map((s) =>
        '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
    selects.forEach((select) => { select.innerHTML = options; });
}

async function onSupplierInput(value) {
    if (!invSuppliersLoaded) await loadSuppliers(false);

    const typed = String(value || '').trim();
    if (poSupplier && poSupplier.name !== typed) poSupplier = null;

    // A name typed out in full is the same answer as a name taken from the
    // list, and the screen has to agree: without this, typing "Vista Steel
    // Supply" exactly was answered with "a company the shop has not bought
    // from" while the server quietly matched it anyway. The screen said one
    // thing and the database did another.
    if (!poSupplier && typed !== '') {
        poSupplier = invSuppliers.find((s) =>
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

    const matches = invSuppliers.filter((s) =>
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
    poSupplier = invSuppliers.find((s) => s.id === supplierId) || null;

    const box = document.getElementById('po-supplier');
    if (box && poSupplier) box.value = poSupplier.name;

    const list = document.getElementById('po-supplier-list');
    if (list) { list.hidden = true; list.innerHTML = ''; }

    renderSupplierState();
}

// Three states, each with its own thing to say: nothing typed, a company the
// shop already deals with, and a company it does not.
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

// The order priced as it is typed, rather than after the supplier answers.
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

        invLoaded = false;
        invSuppliersLoaded = false;
        await loadPurchaseOrders();
        await loadNotifications();

        // Straight to the document. The order exists to be handed to somebody
        // who cannot see this system, so printing it is the next thing that
        // happens, not a thing to go and find.
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

// ==========================================
// THE HISTORY, ON ITS OWN SCREEN
// ==========================================
function buildPurchaseOrderPanel() {
    createDataPanel({
        key: 'clerk-po',
        tableId: 'po-table',
        columns: 7,
        pagerId: 'po-pager',
        countPillId: 'po-count',
        idField: 'po_id',
        filters: { status: 'all' },

        gate: {
            title: 'No purchase orders loaded',
            text: 'Press Load Data for every order raised, or filter to the ones still pending.',
            button: 'Load Data'
        },

        load: () => getJson('/api/purchase-orders'),

        match: (po, query) =>
            (po.supplier_name + ' #' + po.po_id).toLowerCase().indexOf(query) !== -1,
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
            '<td class="cell-action" onclick="event.stopPropagation()">' +
                '<button type="button" class="btn btn-sm btn-ghost" ' +
                        'onclick="openPurchaseOrderDocument(' + po.po_id + ')">Open order</button>' +
                (po.status === 'Pending'
                    ? ' <button type="button" class="btn btn-sm btn-accent" ' +
                      'onclick="openReceiveOrder(' + po.po_id + ')">Receive</button>'
                    : '') +
            '</td></tr>'
    });
}

async function loadPurchaseOrders() {
    const panel = getDataPanel('clerk-po');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

// ==========================================
// THE ORDER AS A DOCUMENT
//
// The supplier has no login and never will, so this screen is built to be
// printed and handed over. It is the only screen in the system that is.
// ==========================================
async function openPurchaseOrderDocument(poId) {
    showInventoryPanel('panel-po-doc', 'Purchase Order #' + poId);

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
            (order.status === 'Pending'
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
                            escapeHtml(order.raised_by || 'Inventory Clerk') + '</div>' +
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
                        escapeHtml(order.raised_by || 'Inventory Clerk') + '</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Approved by</span>Manager</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Received by</span>' +
                        escapeHtml(order.supplier_name) + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// ==========================================
// RECEIVING: THE COUNT SHEET
//
// What was ordered on the left, what actually came off the lorry typed on the
// right, and a way to add something that was never ordered at all. The old
// screen had one button that stocked the order exactly as written, which is
// only ever right by luck.
// ==========================================
async function openReceiveOrder(poId) {
    showInventoryPanel('panel-po-receive', 'Receive Delivery');

    const box = document.getElementById('recv-lines');
    if (box) box.innerHTML = '<p class="panel-sub">Opening order #' + poId + '.</p>';

    recvExtraCount = 0;

    try {
        await ensureInventoryLoaded(false);
        const items = await getJson('/api/purchase-orders/' + poId + '/items');
        const order = invPurchaseOrders.find((x) => x.po_id === poId) || null;
        poReceiving = { poId: poId, items: items, order: order };
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

// Something on the lorry that is not on the order. It gets the same picker as
// an order line, so a material nobody has ever typed in can still be booked
// in by the person holding it.
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
        invLoaded = false;

        showPurchaseOrderHistory();
        await loadPurchaseOrders();
        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// The old one-press receive, kept for the popup that still offers it: it
// sends an empty sheet, which the server reads as "exactly as ordered".
async function receivePurchaseOrder(poId) {
    const yes = await askConfirm(
        'The ordered quantities on purchase order #' + poId + ' go straight into stock, and the ' +
        'order is closed. To record a short or an extra delivery, use Count it in instead.',
        { title: 'Receive as ordered?', eyebrow: 'Purchase Orders', confirmLabel: 'Receive it' });

    if (!yes) return;

    try {
        const response = await fetch('/api/purchase-orders/' + poId + '/receive', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({ received: [] })
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        invLoaded = false;
        await loadPurchaseOrders();
        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- returns, damage and refunds ----------
function buildReturnsPanel() {
    createDataPanel({
        key: 'clerk-returns',
        tableId: 'returns-table',
        columns: 7,
        pagerId: 'returns-pager',
        countPillId: 'returns-count',
        idField: 'return_id',
        filters: { type: 'All', where: 'all' },

        gate: {
            title: 'No reports loaded',
            text: 'Press Load Data for every return, damage and refund on record.',
            button: 'Load Data'
        },

        load: () => getJson('/api/returns'),

        match: (r, query) =>
            (r.product_name + ' ' + (r.reason || '')).toLowerCase().indexOf(query) !== -1,

        filter: (r, filters) => {
            if (filters.type !== 'All' && r.report_type !== filters.type) return false;
            if (filters.where !== 'all' && returnWentTo(r) !== filters.where) return false;
            return true;
        },

        onLoaded: (rows) => renderReturnFilters(rows),

        renderRow: (r, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openReturnDetail(' + r.return_id + ')">' +
            '<td class="cell-id">#' + r.return_id + '</td>' +
            '<td>' + statusBadge(r.report_type) + '</td>' +
            '<td class="cell-name">' + escapeHtml(r.product_name) + '</td>' +
            '<td class="cell-num">' + r.quantity + ' ' + escapeHtml(r.unit_name || '') + '</td>' +
            '<td>' + returnDispositionBadge(r) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(r.return_date).slice(0, 10)) + '</td>' +
            '<td>' + statusBadge(r.status) + '</td></tr>'
    });
}

// Older records were filed before the disposition was written down, so it is
// read back off the restocked flag when it is missing rather than shown blank.
function returnWentTo(row) {
    return row.disposition || (row.restocked ? 'Return to Stock' : 'Write-Off');
}

function returnDispositionBadge(row) {
    return returnWentTo(row) === 'Return to Stock'
        ? '<span class="badge badge-success">Back on shelf</span>'
        : '<span class="badge badge-danger">Written off</span>';
}

async function loadReturns() {
    const panel = getDataPanel('clerk-returns');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

function renderReturnFilters(rows) {
    const box = document.getElementById('return-filters');
    if (!box) return;

    const types = ['All', 'Damaged', 'Refunded', 'Return'];

    box.innerHTML = types.map((type) => {
        const count = type === 'All'
            ? rows.length
            : rows.filter((r) => r.report_type === type).length;

        return '<button type="button" class="filter-chip' + (returnFilter === type ? ' active' : '') +
            '" onclick="setReturnFilter(\'' + type + '\')">' + type +
            ' <span class="chip-count">' + count + '</span></button>';
    }).join('');
}

function setReturnFilter(type) {
    returnFilter = type;

    const panel = getDataPanel('clerk-returns');
    if (panel) renderReturnFilters(panel.rows);

    dataPanelFilter('clerk-returns', 'type', type);
}

async function resolveReturn(reportId) {
    const yes = await askConfirm(
        'Report #' + reportId + ' moves out of the open list. The stock it already moved stays where it is.',
        { title: 'Mark this report resolved?', eyebrow: 'Returned Items', confirmLabel: 'Mark resolved' });

    if (!yes) return;

    try {
        const response = await fetch('/api/returns/' + reportId + '/resolve', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify({})
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }
        notifySuccess(result.message);
        await loadReturns();
    } catch (error) {
        notifyOffline();
    }
}

function onReportTypeChange(type) {
    const field = document.getElementById('refund-field');
    if (field) field.style.display = type === 'Damaged' ? 'none' : 'block';

    const form = document.getElementById('report-form');
    if (form) form.elements.restock.value = type === 'Damaged' ? 'false' : 'true';
}

async function handleFileReport(event) {
    event.preventDefault();
    const form = event.target;

    const data = {
        productId: parseInt(form.elements.productId.value, 10),
        saleId: form.elements.saleId.value ? parseInt(form.elements.saleId.value, 10) : null,
        reportType: form.elements.reportType.value,
        quantity: parseInt(form.elements.quantity.value, 10),
        reason: form.elements.reason.value.trim(),
        refundAmount: parseFloat(form.elements.refundAmount.value) || 0,
        restock: form.elements.restock.value === 'true'
    };

    if (data.reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }
    if (!data.quantity || data.quantity <= 0) {
        notifyWarning('Quantity must be greater than zero.', 'Nothing was filed');
        return;
    }

    try {
        const response = await fetch('/api/returns', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message + ' The manager has been notified.', 'Report filed');
        form.reset();
        onReportTypeChange(form.elements.reportType.value);
        invLoaded = false;
        await loadProductOptions();
        await loadStockBanner();
        await loadNotifications();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- archive ----------
function buildInventoryArchivePanel() {
    createDataPanel({
        key: 'clerk-archive',
        tableId: 'arch-table',
        columns: 6,
        pagerId: 'arch-pager',
        countPillId: 'arch-count',
        idField: 'product_id',

        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for materials that have been taken out of circulation.',
            button: 'Load Data'
        },

        load: () => getJson('/api/inventory/products?archived=true'),

        match: (p, query) =>
            (p.product_name + ' ' + (p.category_name || '')).toLowerCase().indexOf(query) !== -1,

        renderRow: (p, index) =>
            '<tr class="row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
            '<td class="cell-id">' + escapeHtml(p.archived_at || 'Unknown') + '</td>' +
            '<td class="cell-action"><button type="button" class="btn btn-sm btn-success" ' +
                'onclick="restoreMaterial(' + p.product_id + ')">Restore</button></td></tr>'
    });
}

async function loadInventoryArchive() {
    const panel = getDataPanel('clerk-archive');
    if (panel && panel.state !== 'closed') await panel.refresh();
}

async function archiveMaterial(productId) {
    const yes = await askConfirm(
        'It drops off the material list, out of the catalogue and out of the register until it is ' +
        'restored from the Archive screen. Nothing already sold is affected.',
        { title: 'Archive this material?', eyebrow: 'Inventory', confirmLabel: 'Archive it', tone: 'danger' });

    if (!yes) return;

    try {
        const response = await fetch('/api/archives/archive', {
            method: 'POST', headers: apiHeaders(),
            body: JSON.stringify({ module: 'Inventory', recordId: productId })
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess('It drops off the material list until it is restored.', 'Material archived');
        closeModal('detail-modal');
        invLoaded = false;

        for (const key of ['clerk-materials', 'clerk-archive', 'clerk-reorder']) {
            const panel = getDataPanel(key);
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

    try {
        const response = await fetch('/api/archives/restore', {
            method: 'POST', headers: apiHeaders(),
            body: JSON.stringify({ module: 'Inventory', recordId: productId })
        });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess('It is back on the material list.', 'Material restored');
        invLoaded = false;
        await loadInventoryArchive();
        await loadStockBanner();
    } catch (error) {
        notifyOffline();
    }
}

// ---------- popups ----------
function openMaterialDetail(productId) {
    const p = invProducts.find((x) => x.product_id === productId);
    if (!p) return;

    const stock = '<div class="detail-grid">' +
        detailField('Product ID', '#' + p.product_id) +
        detailField('Material', escapeHtml(p.product_name)) +
        detailField('On Hand', p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '')) +
        detailField('Reorder Point', String(p.reorder_point)) +
        detailField('Stock Status', statusBadge(p.stock_status)) +
        detailField('Suggested Order', p.suggested_order + ' ' + escapeHtml(p.unit_name || '')) +
        '</div>' +
        (p.stock_status !== 'In Stock'
            ? '<p class="detail-note detail-warn">This material is at or below its reorder point. The manager has been notified.</p>' : '');

    const pricing = '<div class="detail-grid">' +
        detailField('Unit Price', peso(p.price)) +
        detailField('Stock Value', peso(p.stock_value)) +
        detailField('Category', escapeHtml(p.category_name || 'Uncategorised')) +
        detailField('Brand', escapeHtml(p.brand_name || 'No brand')) +
        detailField('Product Status', statusBadge(p.status)) +
        detailField('Last Updated', escapeHtml(p.last_updated || 'Never')) +
        '</div>';

    const supplier = '<div class="detail-grid">' +
        detailField('Supplier', escapeHtml(p.supplier_name || 'No supplier')) +
        detailField('Contact Person', escapeHtml(p.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(p.contact_number || 'Not set')) +
        detailField('Added On', escapeHtml(p.created_at || 'Unknown')) +
        '</div>' +
        '<div class="detail-actions">' +
        '<button type="button" class="btn btn-danger" onclick="archiveMaterial(' + p.product_id + ')">Archive This Material</button>' +
        '</div>';

    openDetailModal(p.product_name, (p.category_name || 'Uncategorised') + ' · ' + p.stock_status,
        initialsOf(p.product_name), [
            { label: 'Stock', body: stock },
            { label: 'Pricing', body: pricing },
            { label: 'Supplier', body: supplier }
        ]);
}

// The row was read from invAdjustments, which nothing has filled since the
// log became a data panel: clicking a row opened nothing at all. The panel
// holds the rows, so the panel is what it asks.
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
        // The material may have been switched to a different unit since. The
        // entry keeps saying what it counted, so the popup says both rather
        // than letting the two silently disagree.
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

    openDetailModal('Adjustment #' + a.adjustment_id, a.product_name + ' · ' + a.adjustment_type,
        'A' + a.adjustment_id, [
            { label: 'Change', body: change },
            { label: 'Reason', body: why }
        ]);
}

async function openPurchaseOrderDetail(poId) {
    const po = invPurchaseOrders.find((x) => x.po_id === poId);
    if (!po) return;

    let items = [];
    try { items = await getJson('/api/purchase-orders/' + poId + '/items'); } catch (error) { items = []; }

    const summary = '<div class="detail-grid">' +
        detailField('Purchase Order', '#' + po.po_id) +
        detailField('Supplier', escapeHtml(po.supplier_name)) +
        detailField('Status', statusBadge(po.status)) +
        detailField('Ordered On', escapeHtml(po.order_date)) +
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
            (po.status === 'Pending'
                ? '<button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); ' +
                  'openReceiveOrder(' + po.po_id + ')">Count in the delivery</button>'
                : '') +
        '</div>' +
        (po.status === 'Pending' ? ''
            : '<p class="detail-note">This order was already received.</p>');

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

function openReturnDetail(returnId) {
    const r = invReturns.find((x) => x.return_id === returnId);
    if (!r) return;

    const report = '<div class="detail-grid">' +
        detailField('Report ID', '#' + r.return_id) +
        detailField('Type', statusBadge(r.report_type)) +
        detailField('Material', escapeHtml(r.product_name)) +
        detailField('Quantity', r.quantity + ' ' + escapeHtml(r.unit_name || '')) +
        detailField('Refund Amount', peso(r.refund_amount)) +
        detailField('Status', statusBadge(r.status)) +
        '</div>';

    const context = '<div class="detail-grid">' +
        detailField('Filed By', escapeHtml(r.reported_by)) +
        detailField('Filed On', escapeHtml(r.return_date)) +
        detailField('From Sale', r.sale_id ? '#' + r.sale_id : '<span class="muted">Not from a sale</span>') +
        detailField('Put Back on Shelf', r.restocked ? 'Yes' : 'No') +
        '</div>' +
        '<p class="detail-note">' + escapeHtml(r.reason || 'No reason given.') + '</p>' +
        (r.status === 'Open'
            ? '<div class="detail-actions"><button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); resolveReturn(' + r.return_id + ')">Mark Resolved</button></div>'
            : '');

    openDetailModal(r.report_type + ' Report #' + r.return_id, r.product_name + ' · ' + r.status,
        'R' + r.return_id, [
            { label: 'Report', body: report },
            { label: 'Details', body: context }
        ]);
}

// ==========================================
// INVENTORY PAGE BOOT
// ==========================================
if (window.location.pathname.toLowerCase().endsWith('inventory-dashboard.html')) {
    document.addEventListener('DOMContentLoaded', function () {
        // Six panels built, six closed states drawn, and one query fired: the
        // low-stock banner, which is the reason this screen is the default.
        buildMaterialsPanel();
        buildAdjustmentsPanel();
        buildReorderPanel();
        buildPurchaseOrderPanel();
        buildReturnsPanel();
        buildInventoryArchivePanel();

        showInventoryHome();
        loadNotifications();
    });

    // A click anywhere else closes whichever suggestion list is open. Without
    // this they hang over the fields below after the clerk has moved on.
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideAdjustSuggestions();
        hideUnitSuggestions();
        hideAllMatSuggestions();
    });
}
