// inventory-clerk.js -- inventory clerk
// Loaded by: inventory-dashboard.html
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
    document.querySelectorAll('[data-panel-link]').forEach((link) => {
        link.classList.toggle('active', link.dataset.panelLink === panelId);
    });

    const heading = document.getElementById('inv-page-title');
    if (heading) heading.textContent = title;

    // a screen listed under the folded heading unfolds it when a person opened it
    if (event && document.querySelector('#inventory-dropdown a[data-panel-link="' + panelId + '"]')) {
        toggleInventoryMenu(null, true);
    }

    const drop = document.getElementById('notif-drop');
    if (drop) drop.style.display = 'none';

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
}

// Inventory Management folds its list via shared/helpers.js's toggleSidebarMenu
function toggleInventoryMenu(event, force) { toggleSidebarMenu('inventory-nav', 'inventory-dropdown', event, force); }

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

// The material list starts closed like every other table; typing into the
// search box is itself a request to load it.
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

        match: (p, query) => prefixMatch([
            p.product_name, p.category_name, p.supplier_name, p.stock_status
        ], query),

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

        // stock on hand is the figure about to change
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

    // an empty box offers the whole short list
    const matches = query === ''
        ? invUnits.slice(0, 8)
        : invUnits.filter((u) => String(u.name).toLowerCase().indexOf(query) !== -1).slice(0, 8);

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
// a Remove that would take the shelf below zero is caught here
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
function buildAdjustmentsPanel() {
    createDataPanel({
        key: 'clerk-adjustments',
        tableId: 'adjust-table',
        columns: 7,
        pagerId: 'adjust-pager',
        countPillId: 'adjust-count',
        idField: 'adjustment_id',
        filters: { type: 'all' },

        gate: {
            title: 'The log is not loaded',
            text: 'Press Load Data for every stock movement on record, or type a material and press Enter.',
            button: 'Load Data'
        },

        load: () => getJson('/api/inventory/adjustments'),

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
        const response = await fetch('/api/inventory/adjust', {
            method: 'POST', headers: apiHeaders(), body: JSON.stringify(data)
        });
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

        match: (p, query) => prefixMatch([p.product_name], query),
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

// Purchase orders are raised and received by the manager; the clerk only
// reads them. Screens live in shared/purchase-orders.js.
function buildClerkPurchaseOrderPanel() {
    configurePurchaseOrders({
        key: 'clerk-po',
        canCreate: false,
        canReceive: false,
        showPanel: showInventoryPanel,
        historyPanelId: 'panel-po-history',
        historyTitle: 'Purchase Orders',
        gateText: 'Press Load Data for every order the manager has raised, or filter to ' +
                  'the ones still waiting for a delivery.'
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
        countPillId: 'returns-count',
        idField: 'return_id',
        filters: { type: 'All', where: 'all' },

        gate: {
            title: 'No reports loaded',
            text: 'Press Load Data for every return, damage and refund on record.',
            button: 'Load Data'
        },

        load: () => getJson('/api/returns'),

        match: (r, query) => prefixMatch([r.product_name, r.reason], query),

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

// older records have no disposition; read it back off the restocked flag
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

        match: (p, query) => prefixMatch([p.product_name, p.category_name], query),

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
        // six panels built closed; only the low-stock banner queries
        buildMaterialsPanel();
        buildAdjustmentsPanel();
        buildReorderPanel();
        buildClerkPurchaseOrderPanel();
        buildReturnsPanel();
        buildInventoryArchivePanel();

        // offered only to a clerk holding a key to a connected system
        configureConnectedSystems({ showPanel: (panelId, title) => showInventoryPanel(panelId, title) });
        buildConnectedSystemsPanel();

        // the schedule follows what the administrator switched on for this role
        configureDeliverySchedule({ showPanel: (panelId, title) => showInventoryPanel(panelId, title) });
        buildDeliverySchedulePanel();
        configureFeatures({ home: () => showInventoryHome() });

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
