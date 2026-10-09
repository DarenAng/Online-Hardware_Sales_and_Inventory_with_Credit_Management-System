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
//   - the material archive
//   - popups: one material (with its selling sizes and delivery pack),
//     one adjustment, one return
//   - the page start-up code at the very bottom ("INVENTORY PAGE BOOT")
// (Purchase orders are in shared/purchase-orders.js.)
// ============================================================
let invProducts = [];
let invLoaded = false;
let returnFilter = 'All';

// what is chosen on the adjustment form; typed text that matches nothing is not a choice
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
    // a screen opened from another (the order form, from Purchase Orders) lights its menu entry
    const opened = document.getElementById(panelId);
    const litId = (opened && opened.getAttribute('data-panel-of')) || panelId;
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === litId);
    });

    const heading = document.getElementById('inv-page-title');
    if (heading) heading.textContent = title;

    leaveScreenFurniture();
}

// Opening a screen never unfolds the Inventory Management list: only the
// heading's caret does (shared/helpers.js sidebarHeading); the heading lights
// up on its own while a screen beneath it is the open one.

function showInventoryHome(event) {
    showInventoryPanel('panel-inventory', 'Inventory Management', event);
    document.querySelectorAll('[data-panel-link]').forEach((link) => link.classList.remove('active'));

    const search = document.getElementById('inv-search');
    if (search) search.value = '';

    // the panel stays closed; the banner is one small query
    const panel = getDataPanel('clerk-materials');
    if (panel) panel.reset();

    loadStockBanner();
}

// Opening a screen fills the dropdowns it needs and nothing else.
function showAdjust(event) {
    showInventoryPanel('panel-adjust', 'Stock Adjustment', event);
    ensureInventoryLoaded(true);
    loadUnits(false);
    renderAdjustMaterialVerdict();
    renderAdjustPreview();
}

function showAdjustmentHistory(event) {
    showInventoryPanel('panel-adjust-log', 'Adjustment History', event);
}

function showReorder(event) { showInventoryPanel('panel-reorder', 'Reorder Point Settings', event); }
function showReturns(event) { showInventoryPanel('panel-returns', 'Returned Items', event); }
function showDamageReport(event) { showInventoryPanel('panel-report', 'Make a Report', event); renderReportMaterialVerdict(); }
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

        load: async () => {
            invProducts = await apiGetProducts();
            invLoaded = true;
            return invProducts;
        },

        match: (p, query) => prefixMatch([
            p.product_name, p.category_name, p.supplier_name, p.stock_status
        ], query),

        filter: (p, filters) => filters.status === 'all' || p.stock_status === filters.status,

        // the catalogue: what it is, who supplies it and what it sells for.
        // Reorder points have their own screen, so they are not repeated here.
        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="openMaterialDetail(' + p.product_id + ')" title="Open this material">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) +
                '<span class="cell-sub">' + materialKindText(p) + '</span></td>' +
            '<td>' + (p.supplier_name
                ? escapeHtml(p.supplier_name)
                : '<span class="muted">No supplier</span>') + '</td>' +
            '<td class="cell-num">' + peso(p.price) +
                '<span class="cell-sub">per ' + escapeHtml(p.unit_name || 'unit') + '</span></td>' +
            '<td class="cell-num">' + p.quantity_in_stock + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>'
    });
}

// "Stanley · Hand Tools": brand then category, whichever are on file
function materialKindText(p) {
    const parts = [p.brand_name, p.category_name || 'Uncategorised'].filter(Boolean);
    return parts.map(escapeHtml).join(' &middot; ');
}

async function loadInventoryAll(event) {
    if (event) event.preventDefault();

    showInventoryPanel('panel-inventory', 'Inventory Management');

    const link = document.querySelector('a[data-panel-link="panel-inventory"]');
    if (link) link.classList.add('active');

    loadStockBanner();
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

// ---------- the material boxes (Stock Adjustment, Make a Report) ----------
// what a typed query finds, best first: the name starts with it, then a word
// in the name does, then the brand or category; six at most
function findMaterials(query) {
    const starts = [];
    const words = [];
    const other = [];

    invProducts.forEach((p) => {
        const name = String(p.product_name || '').toLowerCase();

        if (name.startsWith(query)) starts.push(p);
        else if (startsAWord(name, query)) words.push(p);
        else if (prefixMatch([p.brand_name, p.category_name], query)) other.push(p);
    });

    return starts.concat(words, other).slice(0, 6);
}

// the dropdown's rows; a row calls pickFn with its product id
function materialSuggestHtml(found, idPrefix, pickFn) {
    return found.map((p, i) => {
        const stock = Number(p.quantity_in_stock);
        const meta = [p.category_name, p.brand_name].filter(Boolean).map(escapeHtml);

        // stock on hand is the figure about to change
        return '<li class="suggest-item" role="option" id="' + idPrefix + i + '" ' +
            'onmousedown="event.preventDefault()" ' +
            'onclick="' + pickFn + '(' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + stock + ' ' + escapeHtml(p.unit_name || '') + '</span>' +
            '</span>' +
            (meta.length ? '<span class="suggest-note">' + meta.join(' &middot; ') + '</span>' : '') +
            '</li>';
    }).join('');
}

async function loadSupplierOptions() {
    const selects = document.querySelectorAll('[data-supplier-select]');
    if (selects.length === 0) return;

    try {
        const rows = await apiGetRecords('supplier');
        const options = rows.map((s) => '<option value="' + s.id + '">' + escapeHtml(s.name) + '</option>').join('');
        selects.forEach((s) => { s.innerHTML = options; });
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

    const hide = () => {
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

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (invUnits.length === 0) { hide(); return; }

    // an empty box (or one letter) offers the whole short list
    const typed = searchText(query);
    let matches;
    if (typed === '') {
        matches = invUnits.slice(0, 8);
    } else {
        matches = invUnits.filter((u) => startsAWord(u.name, typed)).slice(0, 8);
    }

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

// A quantity as typed, whole or fractional: 2.5 kilogram is 2.5, not 2. Three
// decimals is the width of the column it lands in; NaN when nothing readable.
function readQuantity(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text === '') return NaN;
    const number = Number(text);
    return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : NaN;
}

// ---------- what this will do ----------
// a Remove that would take the shelf below zero is caught here
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

    // a movement of nothing is not an adjustment
    if (quantity < 1) {
        box.className = 'adjust-preview is-stop';
        box.textContent = 'The quantity has to be at least 1.';
        return;
    }

    const before = Number(adjustMaterial.quantity_in_stock) || 0;
    const type = form.elements.adjustmentType.value;
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

    const reorder = Number(adjustMaterial.reorder_point) || 0;
    const low = after <= reorder;

    box.className = 'adjust-preview ' + (low ? 'is-watch' : 'is-good');
    box.textContent = adjustMaterial.product_name + ': ' + before + ' to ' + after + ' ' + unit + '.' +
        (low ? ' That is at or below its reorder point of ' + reorder + ', so the manager is told.' : '');
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

        load: () => apiGetStockAdjustments(),

        match: (a, query) => prefixMatch([a.product_name, a.adjusted_by, a.reason, a.unit_name], query),

        filter: (a, filters) => filters.type === 'all' || a.adjustment_type === filters.type,

        renderRow: (a, index) => {
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

    if (!Number.isFinite(data.quantity) || data.quantity < 1) {
        notifyWarning('Enter a quantity of at least 1. Nothing moves on the shelf otherwise.',
            'Quantity too small');
        const qty = document.getElementById('adjust-qty');
        if (qty) { qty.focus(); qty.select(); }
        return;
    }

    if (data.reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }

    // changing the unit re-reads every figure on the shelf, so it is read back first
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
        const response = await apiAdjustStock(data);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);

        form.elements.quantity.value = '';
        form.elements.reason.value = '';

        // form.reset() would clear the material too; only the stale stock figure must go
        invLoaded = false;
        invUnitsLoaded = false;
        await ensureInventoryLoaded(true);
        await loadUnits(true);

        const again = invProducts.find((m) => m.product_id === data.productId);
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

        load: () => apiGetProducts(),

        match: (p, query) => prefixMatch([p.product_name], query),
        filter: (p, filters) => filters.status === 'all' || p.stock_status === filters.status,

        // the stock level against the point: a bar, the point itself, and what
        // an order would take to get back to comfortable
        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="askReorderPoint(' + p.product_id + ')" title="Set the reorder point">' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + stockLevelBar(p) + '</td>' +
            '<td class="cell-num">' + p.reorder_point + ' ' + escapeHtml(p.unit_name || '') + '</td>' +
            '<td class="cell-num">' + (suggestedOrderOf(p) > 0
                ? suggestedOrderOf(p) + ' ' + escapeHtml(p.unit_name || '')
                : '<span class="muted">None</span>') + '</td>' +
            '<td>' + statusBadge(p.stock_status) + '</td></tr>'
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
    const p = panel ? panel.rows.find((row) => row.product_id === productId) : null;
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
        check: (value) => {
            const typed = String(value).trim();
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
        afterChange: async () => {
            for (const key of ['clerk-materials', 'clerk-reorder']) {
                const panel = getDataPanel(key);
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

        load: () => apiGetReturns(),

        match: (r, query) => prefixMatch([r.product_name, r.reason], query),

        filter: (r, filters) => {
            if (filters.type === 'To inspect') { if (!returnAwaiting(r)) return false; }
            else if (filters.type !== 'All' && r.report_type !== filters.type) return false;
            if (filters.where === 'awaiting') return returnAwaiting(r);
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

// a refund from the counter the clerk has not looked at yet
function returnAwaiting(row) {
    return row.status === 'Open' && !row.disposition;
}

// older records have no disposition; read it back off the restocked flag
function returnWentTo(row) {
    if (row.disposition) return row.disposition;
    if (returnAwaiting(row)) return null;
    return row.restocked ? 'Return to Stock' : 'Write-Off';
}

function returnDispositionBadge(row) {
    const where = returnWentTo(row);
    if (where === null) return '<span class="badge badge-warning">Awaiting inspection</span>';

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

function renderReturnFilters(rows) {
    const box = document.getElementById('return-filters');
    if (!box) return;

    // the worklist first: what the counter took back and nobody has looked at
    const types = ['To inspect', 'All', 'Damaged', 'Refunded', 'Return'];

    box.innerHTML = types.map((type) => {
        let count;
        if (type === 'All') {
            count = rows.length;
        } else if (type === 'To inspect') {
            count = rows.filter(returnAwaiting).length;
        } else {
            count = rows.filter((r) => r.report_type === type).length;
        }

        return '<button type="button" class="filter-chip' + (returnFilter === type ? ' active' : '') +
            (type === 'To inspect' && count > 0 ? ' track-chip-alert' : '') +
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
            for (const key of ['clerk-materials', 'clerk-reorder']) {
                const panel = getDataPanel(key);
                if (panel && panel.state === 'ready') await panel.refresh();
            }
        }
    } catch (error) {
        notifyOffline();
    }
}

// ---------- the report's material: typed and picked, like Stock Adjustment's ----------
let reportMaterial = null;
let reportSuggestHighlight = -1;

function reportMaterialBox() { return document.getElementById('report-material'); }

async function onReportMaterialInput(value) {
    const text = String(value || '').trim();
    const clear = document.getElementById('report-material-clear');
    if (clear) clear.hidden = text === '';

    if (!invLoaded && text !== '') await ensureInventoryLoaded(false);

    // typing on after a choice unmakes it
    if (reportMaterial && String(reportMaterial.product_name).trim() !== text) {
        setReportMaterial(null);
    }

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
    const chosen = reportMaterial && String(reportMaterial.product_name).trim().toLowerCase() === query;
    if (query !== '' && invProducts.length > 0 && !chosen) found = findMaterials(query);

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
        items.forEach((item, i) => item.classList.toggle('is-active', i === reportSuggestHighlight));
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

function pickReportMaterial(productId) {
    const found = invProducts.find((p) => p.product_id === productId);
    if (!found) return;

    const box = reportMaterialBox();
    if (box) box.value = found.product_name;

    const clear = document.getElementById('report-material-clear');
    if (clear) clear.hidden = false;

    hideReportSuggestions();
    setReportMaterial(found);
}

function clearReportMaterial(keepFocus) {
    const box = reportMaterialBox();
    if (box) box.value = '';

    const clear = document.getElementById('report-material-clear');
    if (clear) clear.hidden = true;

    hideReportSuggestions();
    setReportMaterial(null);
    if (box && keepFocus !== false) box.focus();
}

function setReportMaterial(product) {
    reportMaterial = product || null;

    const form = document.getElementById('report-form');
    if (form) form.elements.productId.value = product ? String(product.product_id) : '';

    renderReportMaterialVerdict();
}

function renderReportMaterialVerdict() {
    const box = document.getElementById('report-material-verdict');
    if (!box) return;

    const typed = reportMaterialBox() ? reportMaterialBox().value.trim() : '';

    if (reportMaterial) {
        box.className = 'pick-verdict';
        box.textContent = Number(reportMaterial.quantity_in_stock) + ' ' +
            (reportMaterial.unit_name || '') + ' on hand.';
        return;
    }

    const list = document.getElementById('report-suggest');
    const listOpen = list && !list.hidden;

    box.className = 'pick-verdict';
    box.textContent = '';
    if (typed === '' || listOpen) return;

    box.className = 'pick-verdict is-stop';
    box.textContent = 'Nothing matches "' + typed + '". Try a name, brand, or category.';
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
        quantity: readQuantity(form.elements.quantity.value),
        reason: form.elements.reason.value.trim(),
        refundAmount: parseFloat(form.elements.refundAmount.value) || 0,
        restock: form.elements.restock.value === 'true'
    };

    if (!reportMaterial || !data.productId) {
        notifyWarning('Type the material\'s name and choose it from the list.', 'No material chosen');
        renderReportMaterialVerdict();
        return;
    }
    if (data.reason === '') { notifyWarning('Say why this is being recorded.', 'A reason is required'); return; }
    if (!data.quantity || data.quantity <= 0) {
        notifyWarning('Quantity must be greater than zero.', 'Nothing was filed');
        return;
    }

    try {
        const response = await apiFileReturn(data);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message + ' The manager has been notified.', 'Report filed');
        form.reset();
        clearReportMaterial(false);
        onReportTypeChange(form.elements.reportType.value);
        // the stock figures have moved; the next search reads them afresh
        invLoaded = false;
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
        columns: 5,
        pagerId: 'arch-pager',
        idField: 'product_id',

        gate: {
            title: 'The archive is not loaded',
            text: 'Press Load Data for materials that have been taken out of circulation.',
            button: 'Load Data'
        },

        load: () => apiGetArchivedProducts(),

        match: (p, query) => prefixMatch([p.product_name, p.category_name], query),

        // a row is pressed to restore the material; restoreMaterial asks first
        renderRow: (p, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'onclick="restoreMaterial(' + p.product_id + ')" title="Restore this material">' +
            '<td class="cell-id">#' + p.product_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(p.product_name) + '</td>' +
            '<td>' + escapeHtml(p.category_name || 'Uncategorised') + '</td>' +
            '<td class="cell-num">' + p.quantity_in_stock + '</td>' +
            '<td class="cell-id">' + escapeHtml(p.archived_at || 'Unknown') + '</td></tr>'
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
        const response = await apiArchiveMaterial(productId);
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
        const response = await apiRestoreMaterial(productId);
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

    const unit = escapeHtml(p.unit_name || '');

    // first page: who supplies it and how to reach them, then what it is
    let supplierBlock;
    if (p.supplier_name) {
        const phone = p.contact_number
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
            detailField('Unit Price', peso(p.price) + ' <span class="muted">per ' + escapeHtml(p.unit_name || 'unit') + '</span>') +
            detailField('On Hand', p.quantity_in_stock + ' ' + unit + ' ' + statusBadge(p.stock_status)) +
        '</div>';

    const stock = '<div class="detail-grid">' +
        detailField('Product ID', '#' + p.product_id) +
        detailField('On Hand', p.quantity_in_stock + ' ' + unit) +
        detailField('Reorder Point', p.reorder_point + ' ' + unit) +
        detailField('Stock Status', statusBadge(p.stock_status)) +
        detailField('Suggested Order', p.suggested_order + ' ' + unit) +
        detailField('Stock Value', peso(p.stock_value)) +
        detailField('Product Status', statusBadge(p.status)) +
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
            { label: 'Overview', body: overview },
            { label: 'Stock', body: stock },
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

        const p = invProducts.find((x) => x.product_id === productId);
        if (p) {
            p.pack_name = result.packName;
            p.pack_size = result.packSize;
            const page = detailPages.find((entry) => entry.label === 'Delivered In');
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
    const own = p.unit_name || 'unit';
    const sizes = Array.isArray(p.selling_units) ? p.selling_units : [];

    let list;
    if (sizes.length === 0) {
        list = '<p class="detail-empty">Sold only by the ' + escapeHtml(own) + '. Add a bigger size below if it ' +
              'also goes out by the box, pack or sack.</p>';
    } else {
        list = '<div class="table-responsive"><table class="mini-table unit-sizes-table"><thead><tr>' +
              '<th>Size</th><th class="col-num">Holds</th><th class="col-num">Price</th></tr></thead><tbody>' +
              sizes.map((u) => {
                  const each = u.price === null || u.price === undefined
                      ? Math.round(Number(p.price) * Number(u.units_per) * 100) / 100 : Number(u.price);
                  return '<tr class="row-clickable" title="Press to stop selling by this size" ' +
                      'onclick="removeSellingUnit(' + p.product_id + ', ' + Number(u.product_unit_id) + ')">' +
                      '<td><strong>' + escapeHtml(u.unit_name) + '</strong></td>' +
                      '<td class="cell-num">' + escapeHtml(qtyText(u.units_per, own)) + '</td>' +
                      '<td class="cell-num">' + peso(each) +
                          (u.price === null || u.price === undefined
                              ? ' <span class="muted" title="The unit price times what it holds">worked out</span>' : '') + '</td>' +
                  '</tr>';
              }).join('') + '</tbody></table></div>';
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
            '<datalist id="unit-size-names">' +
                ['box', 'pack', 'sack', 'bag', 'bundle', 'roll', 'set', 'dozen', 'pallet', 'length', 'sheet', 'gallon']
                    .map((name) => '<option value="' + name + '">').join('') +
            '</datalist>' +
            '<div class="detail-actions"><button type="submit" class="btn btn-accent">Add this size</button></div>' +
        '</form>';
}

// the card is redrawn on its Selling Units page once the list comes back
function refreshSellingUnitsPage(productId, units) {
    const p = invProducts.find((x) => x.product_id === productId);
    if (!p) return;
    p.selling_units = units;

    const page = detailPages.find((entry) => entry.label === 'Selling Units');
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
    const p = invProducts.find((x) => x.product_id === productId);
    let unit;
    if (p && Array.isArray(p.selling_units)) {
        unit = p.selling_units.find((u) => Number(u.product_unit_id) === unitId);
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

    openDetailModal('Adjustment #' + a.adjustment_id, a.product_name + ' · ' + a.adjustment_type,
        'A' + a.adjustment_id, [
            { label: 'Change', body: change },
            { label: 'Reason', body: why }
        ]);
}

function openReturnDetail(returnId) {
    const panel = getDataPanel('clerk-returns');
    const r = panel ? panel.find(returnId) : null;
    if (!r) return;

    const report = '<div class="detail-grid">' +
        detailField('Report ID', '#' + r.return_id) +
        detailField('Type', statusBadge(r.report_type)) +
        detailField('Material', escapeHtml(r.product_name)) +
        detailField('Quantity', r.quantity + ' ' + escapeHtml(r.unit_name || '')) +
        detailField('Refund Amount', peso(r.refund_amount)) +
        detailField('Status', statusBadge(r.status)) +
        '</div>';

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

    const context = '<div class="detail-grid">' +
        detailField('Filed By', escapeHtml(r.reported_by)) +
        detailField('Filed On', escapeHtml(r.return_date)) +
        detailField('From Sale', r.sale_id ? '#' + r.sale_id : '<span class="muted">Not from a sale</span>') +
        detailField('Goods Went', returnDispositionBadge(r)) +
        detailField('Inspected', r.inspected_by
            ? escapeHtml(r.inspected_by) + ' <span class="muted">' + escapeHtml(String(r.inspected_at || '').slice(0, 16)) + '</span>'
            : '<span class="muted">' + (awaiting ? 'Not yet' : 'Decided when filed') + '</span>') +
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

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showInventoryPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showInventoryHome() });

        // Go to, on an opened alert: the screen that alert is about
        const stockAlert = { label: 'Reorder Point', panelId: 'panel-reorder',
                             open: () => showReorder(), key: 'clerk-reorder', searchId: 'reorder-search' };
        const returnsAlert = { label: 'Returned Items', panelId: 'panel-returns',
                               open: () => showReturns(), key: 'clerk-returns' };
        configureNotificationTargets({
            'Low Stock':        stockAlert,
            'Out of Stock':     stockAlert,
            'Purchase Order':   { label: 'Purchase Orders', panelId: 'panel-po-history',
                                  open: () => showPurchaseOrderHistory(), key: 'clerk-po' },
            'Damage Report':    returnsAlert,
            'Refund Report':    returnsAlert,
            'Stock Adjustment': { label: 'Adjustment History', panelId: 'panel-adjust-log',
                                  open: () => showAdjustmentHistory(), key: 'clerk-adjustments' }
        });

        showInventoryHome();
        loadNotifications();
    });

    // a click anywhere else closes whichever suggestion list is open
    document.addEventListener('click', function (event) {
        if (event.target.closest('.suggest-wrap')) return;
        hideAdjustSuggestions();
        hideUnitSuggestions();
    });
}
