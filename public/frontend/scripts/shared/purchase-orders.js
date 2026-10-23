const poSetup = {
    key: 'po',
    canCreate: false,
    canDecide: false,
    canReceive: false,
    showPanel: null,
    historyPanelId: 'panel-po-history',
    historyTitle: 'Order History',
    gateText: 'Press Load Data for every order raised, or filter to the ones still pending.',
    showLines: true,
    afterChange: null
};

function poFindProduct(products, productId) {
    for (let i = 0; i < products.length; i++) {
        if (products[i].product_id === productId) return products[i];
    }
    return undefined;
}

function poHas(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function poKeepFilled(items) {
    const kept = [];
    for (let i = 0; i < items.length; i++) {
        if (items[i]) kept.push(items[i]);
    }
    return kept;
}

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

function showPurchaseOrderHistory(event) {
    if (event) event.preventDefault();
    poShowPanel(poSetup.historyPanelId, poSetup.historyTitle);
}

function showPurchaseOrders(event) {
    if (event) event.preventDefault();
    if (!poSetup.canCreate) { showPurchaseOrderHistory(); return; }

    poShowPanel('panel-po', 'New Purchase Order');
    renderCriticalStocks();
    Promise.all([loadPoSuppliers(false), ensurePoMaterials(false)]).then(renderCriticalStocks);
    if (poLineCount === 0) addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

let poMaterials = [];
let poMaterialsLoaded = false;
let poMaterialsFailed = false;

async function ensurePoMaterials(force) {
    if (poMaterialsLoaded && !force) return true;
    try {
        poMaterials = await apiGetProducts();
        poMaterialsLoaded = true;
        poMaterialsFailed = false;
        return true;
    } catch (error) {
        poMaterialsLoaded = false;
        poMaterialsFailed = true;
        return false;
    }
}

async function matReload(id) {
    const list = document.getElementById(id + '-list');
    if (list && !list.hidden) {
        list.innerHTML = '<li class="suggest-head" role="presentation">Loading the material list...</li>';
    }
    await ensurePoMaterials(true);
    matOpen(id);
}

let poSupplier = null;
let poSuppliers = [];
let poSuppliersLoaded = false;
let poSupplierHighlight = -1;
let poSupplierCommitted = false;
let poLinesSupplierId = null;
let poLineCount = 0;
let poDocument = null;
let poReceiving = null;
let recvExtraCount = 0;

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
            '<div class="suggest-wrap mat-wrap">' +
                '<input type="text" class="form-control" id="' + id + '-box" autocomplete="off" ' +
                       'placeholder="Pick a material, or type a new name" ' +
                       'role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
                       'aria-controls="' + id + '-list" ' +
                       'oninput="matInput(\'' + id + '\', this.value)" ' +
                       'onfocus="matOpen(\'' + id + '\')" ' +
                       'onclick="matOpen(\'' + id + '\')" ' +
                       'onkeydown="matKey(\'' + id + '\', event)">' +
                '<button type="button" class="mat-caret" tabindex="-1" ' +
                        'aria-label="Show the materials this company supplies" ' +
                        'onmousedown="event.preventDefault()" ' +
                        'onclick="matToggle(\'' + id + '\')">' +
                    '<span aria-hidden="true">&#9662;</span>' +
                '</button>' +
                '<ul class="suggest-list" id="' + id + '-list" role="listbox" hidden></ul>' +
            '</div>' +
            '<div class="mat-desc" id="' + id + '-desc" hidden></div>' +
            '<p class="pick-verdict" id="' + id + '-verdict"></p>' +
        '</div>' +
        makeCardHtml(id);
}

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
                        '<label for="' + id + '-unit">Unit</label>' +
                        makeSuggestInputHtml(id, 'unit', 'maxlength="20" placeholder="pcs, bag, kilogram"') +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-category">Category</label>' +
                        makeSuggestInputHtml(id, 'category', 'maxlength="50" placeholder="Fasteners, Cement"') +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-brand">Brand <span class="label-hint">optional</span></label>' +
                        makeSuggestInputHtml(id, 'brand', 'maxlength="100"') +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="' + id + '-price">Price per unit</label>' +
                        '<input type="number" class="form-control" id="' + id + '-price" ' +
                               'min="0" step="0.01" value="0.00" ' +
                               'oninput="renderMatDesc(\'' + id + '\'); renderPoTotals()">' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

const MAKE_SUGGEST_COLUMN = { unit: 'unit_name', category: 'category_name', brand: 'brand_name' };
const MAKE_SUGGEST_LIMIT = 8;

function makeSuggestInputHtml(id, field, attributes) {
    const box = id + '-' + field;
    const at = '\'' + id + '\', \'' + field + '\'';
    return '' +
        '<div class="suggest-wrap">' +
            '<input type="text" class="form-control" id="' + box + '" ' + attributes + ' ' +
                   'autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
                   'aria-controls="' + box + '-list" ' +
                   'oninput="makeFieldInput(' + at + ')" ' +
                   'onfocus="makeSuggest(' + at + ')" ' +
                   'onclick="makeSuggest(' + at + ')" ' +
                   'onblur="makeSuggestHide(' + at + ')" ' +
                   'onkeydown="makeSuggestKey(' + at + ', event)">' +
            '<ul class="suggest-list" id="' + box + '-list" role="listbox" ' +
                'onmousedown="event.preventDefault()" hidden></ul>' +
        '</div>';
}

function makeKnownValues(field) {
    const column = MAKE_SUGGEST_COLUMN[field];
    const found = [];
    const byKey = {};

    for (let i = 0; i < poMaterials.length; i++) {
        const value = String(poMaterials[i][column] || '').trim();
        if (value === '') continue;
        const key = 'k:' + value.toLowerCase();
        if (byKey[key]) {
            byKey[key].count += 1;
        } else {
            byKey[key] = { value: value, count: 1 };
            found.push(byKey[key]);
        }
    }

    return found.sort(function (a, b) {
        return (b.count - a.count) || a.value.localeCompare(b.value);
    });
}

function makeSuggest(id, field) {
    const list = document.getElementById(id + '-' + field + '-list');
    const box = document.getElementById(id + '-' + field);
    if (!list || !box) return;

    if (!poMaterialsLoaded) {
        ensurePoMaterials(false).then(function (ok) {
            if (ok && document.activeElement === box) makeSuggest(id, field);
        });
    }

    const query = box.value.trim().toLowerCase();
    const known = makeKnownValues(field);

    let matches;
    if (query === '') {
        matches = known;
    } else {
        const starts = [];
        const words = [];
        for (let i = 0; i < known.length; i++) {
            if (known[i].value.toLowerCase().startsWith(query)) {
                starts.push(known[i]);
            }
            if (!known[i].value.toLowerCase().startsWith(query) && startsAWord(known[i].value, query)) {
                words.push(known[i]);
            }
        }
        matches = starts.concat(words);
    }
    matches = matches.slice(0, MAKE_SUGGEST_LIMIT);

    if (matches.length === 0 || (matches.length === 1 && matches[0].value.toLowerCase() === query)) {
        makeSuggestHide(id, field);
        return;
    }

    hideAllMatSuggestions(box.closest('.suggest-wrap'));

    let itemsHtml = '';
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        itemsHtml += '<li class="suggest-item" role="option" aria-selected="false" id="' + list.id + '-' + i + '" ' +
            'data-value="' + escapeHtml(m.value) + '" ' +
            'onclick="makeSuggestPick(\'' + id + '\', \'' + field + '\', this)">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(m.value) + '</span>' +
            '</span>' +
        '</li>';
    }
    list.innerHTML = itemsHtml;
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
    box.removeAttribute('aria-activedescendant');
}

function makeSuggestHide(id, field) {
    const list = document.getElementById(id + '-' + field + '-list');
    const box = document.getElementById(id + '-' + field);
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) {
        box.setAttribute('aria-expanded', 'false');
        box.removeAttribute('aria-activedescendant');
    }
}

function makeFieldChanged(id) {
    renderMatDesc(id);
    renderPoTotals();
}

function makeFieldInput(id, field) {
    makeSuggest(id, field);
    makeFieldChanged(id);
}

function makeSuggestPick(id, field, item) {
    const box = document.getElementById(id + '-' + field);
    if (box) box.value = item.dataset.value;
    makeSuggestHide(id, field);
    makeFieldChanged(id);
}

function makeSuggestKey(id, field, event) {
    const list = document.getElementById(id + '-' + field + '-list');
    const box = document.getElementById(id + '-' + field);

    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        if (event.key === 'ArrowDown') { event.preventDefault(); makeSuggest(id, field); }
        return;
    }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) {
        if (event.key === 'Enter') event.preventDefault();
        return;
    }

    let at = -1;
    for (let i = 0; i < items.length; i++) {
        if (items[i].classList.contains('is-active')) at = i;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (at === -1) {
            at = step > 0 ? 0 : items.length - 1;
        } else {
            at = (at + step + items.length) % items.length;
        }
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === at);
            items[i].setAttribute('aria-selected', i === at ? 'true' : 'false');
        }
        if (box) box.setAttribute('aria-activedescendant', items[at].id);
        if (items[at].scrollIntoView) items[at].scrollIntoView({ block: 'nearest' });
        return;
    }

    if (event.key === 'Enter') {
        event.preventDefault();
        if (at >= 0) items[at].click(); else makeSuggestHide(id, field);
        return;
    }

    if (event.key === 'Escape') makeSuggestHide(id, field);
}

async function matOpen(id) {
    await ensurePoMaterials(false);
    const state = matState(id);
    const box = matBox(id);
    const typed = box ? box.value.trim() : '';

    state.browseAll = typed === '' || Boolean(state.productId);
    renderMatSuggestions(id, typed);
}

function matToggle(id) {
    const list = document.getElementById(id + '-list');
    if (list && !list.hidden) { hideMatSuggestions(id); return; }
    const box = matBox(id);
    if (box) box.focus();
    matOpen(id);
}

async function matInput(id, value) {
    await ensurePoMaterials(false);
    const state = matState(id);
    const typed = String(value || '').trim();
    state.browseAll = false;

    let chosen;
    if (state.productId) {
        chosen = poFindProduct(poMaterials, state.productId);
    } else {
        chosen = null;
    }

    if (chosen && chosen.product_name !== typed) state.productId = null;

    state.newName = typed;
    renderMatSuggestions(id, typed);
    renderMatVerdict(id);
    syncPoLineUnits(id);
    renderPoTotals();
}

function renderMatSuggestions(id, text) {
    const list = document.getElementById(id + '-list');
    const box = matBox(id);
    if (!list) return;

    const state = matState(id);
    const query = String(text || '').trim().toLowerCase();
    state.highlight = -1;

    const hide = function () {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    const choices = matChoices(id);
    const typed = searchText(query);
    const browsing = typed === '' || state.browseAll === true;

    let matches;
    if (browsing) {
        matches = choices;
    } else {
        matches = [];
        for (let i = 0; i < choices.length; i++) {
            if (prefixMatch([choices[i].product_name, choices[i].category_name, choices[i].brand_name], typed)) {
                matches.push(choices[i]);
            }
        }
        matches = matches.slice(0, 7);
    }

    let exact = false;
    for (let i = 0; i < matches.length; i++) {
        if (matches[i].product_name.toLowerCase() === query) exact = true;
    }

    let rows = '';
    for (let i = 0; i < matches.length; i++) {
        const p = matches[i];
        rows += '<li class="suggest-item" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="matPick(\'' + id + '\', ' + p.product_id + ')">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="suggest-figure">' + p.quantity_in_stock + ' ' +
                    escapeHtml(p.unit_name || '') + '</span>' +
            '</span>' +
            '<span class="suggest-note">' + escapeHtml(p.category_name || 'No category') +
                ' · ' + peso(p.price) + '</span>' +
        '</li>';
    }

    let make;
    if (browsing || exact) {
        make = '';
    } else {
        make = '<li class="suggest-item is-make" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="matMakeNew(\'' + id + '\')">' +
            '<span class="make-mark" aria-hidden="true">+</span>' +
            '<span>Add <span class="make-quoted">' + escapeHtml(text) +
                '</span> as a new material</span>' +
        '</li>';
    }

    const head = matHeadHtml(id, browsing, matches.length);

    if (rows === '' && make === '' && head === '') { hide(); return; }

    list.innerHTML = head + rows + make;
    list.hidden = false;
    if (box) box.setAttribute('aria-expanded', 'true');
}

function matHeadHtml(id, browsing, count) {
    if (!browsing) return '';

    const line = function (text) {
        return '<li class="suggest-head" role="presentation">' + escapeHtml(text) + '</li>';
    };

    if (poMaterialsFailed) {
        return '<li class="suggest-item is-retry" role="option" onmousedown="event.preventDefault()" ' +
                'onclick="matReload(\'' + id + '\')">' +
            '<span class="suggest-name">The material list could not be loaded</span>' +
            '<span class="suggest-note">Press here to try again.</span>' +
        '</li>';
    }

    if (!matIsOrderLine(id)) {
        if (count === 0) {
            return line('Nothing is on the material list yet. Type a name to add it as new.');
        } else {
            return line(count + ' material' + (count === 1 ? '' : 's') + ' on the list');
        }
    }

    if (!poSupplier) {
        return line('A new company supplies nothing yet. Type a name and it joins the ' +
            'list as a new material.');
    }

    if (count === 0) {
        return line(poSupplier.name + ' has nothing on the list yet. Type a name to add it as new.');
    } else {
        return line(count + ' material' + (count === 1 ? '' : 's') + ' ' + poSupplier.name + ' supplies');
    }
}

function hideMatSuggestions(id) {
    const list = document.getElementById(id + '-list');
    const box = matBox(id);
    matState(id).browseAll = false;
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (box) box.setAttribute('aria-expanded', 'false');
}

function hideAllMatSuggestions(except) {
    const lists = document.querySelectorAll('.suggest-list[id$="-list"]');
    for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        if (except && except.contains(list)) continue;
        const id = list.id.replace(/-list$/, '');
        const box = document.getElementById(id + '-box') || document.getElementById(id);
        if (matPickers[id]) matPickers[id].browseAll = false;
        list.hidden = true;
        list.innerHTML = '';
        if (box) {
            box.setAttribute('aria-expanded', 'false');
            box.removeAttribute('aria-activedescendant');
        }
    }
}

function matKey(id, event) {
    const list = document.getElementById(id + '-list');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        if (event.key === 'ArrowDown') { event.preventDefault(); matOpen(id); }
        return;
    }

    if (event.key === 'Tab') { hideMatSuggestions(id); return; }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    const state = matState(id);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        state.highlight = ((state.highlight === undefined ? -1 : state.highlight) + step + items.length) % items.length;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === state.highlight);
        }
        const active = items[state.highlight];
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
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

function matIsOrderLine(id) { return String(id).indexOf('po-mat-') === 0; }

function matChoices(id) {
    if (!matIsOrderLine(id)) return poMaterials;
    if (poSupplier) {
        const supplied = [];
        for (let i = 0; i < poMaterials.length; i++) {
            if (poMaterials[i].supplier_id === poSupplier.id) supplied.push(poMaterials[i]);
        }
        return supplied;
    }
    return [];
}

function matPick(id, productId) {
    const product = poFindProduct(matChoices(id), productId);
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
    syncPoLineUnits(id);
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
            'and it joins the list when this is sent. The price goes on its record and is what ' +
            'this line is ordered at.';
    }

    hideMatSuggestions(id);
    renderMatVerdict(id);

    const unit = document.getElementById(id + '-unit');
    if (unit) unit.focus();
}

function renderMatDesc(id) {
    const box = document.getElementById(id + '-desc');
    if (!box) return;

    const hide = function () { box.hidden = true; box.innerHTML = ''; };
    const strip = function (facts, price, per) {
        return '<span class="mat-desc-line">' + escapeHtml(poKeepFilled(facts).join(' \u00B7 ')) + '</span>' +
            '<span class="mat-desc-price">' + peso(price) +
                '<span class="mat-desc-per">/ ' + escapeHtml(per) + '</span></span>';
    };

    const state = matState(id);
    let product;
    if (state.productId) {
        product = poFindProduct(poMaterials, state.productId);
    } else {
        product = null;
    }

    if (product) {
        const unit = product.unit_name || 'unit';
        let pack;
        if (product.pack_name && Number(product.pack_size) > 0) {
            pack = 'delivered by the ' + product.pack_name + ' of ' +
                  qtyText(Number(product.pack_size), unit);
        } else {
            pack = null;
        }

        box.hidden = false;
        box.innerHTML = strip([product.brand_name, product.category_name || 'No category',
            'counted in ' + unit, pack], product.price, unit);
        return;
    }

    const make = document.getElementById(id + '-make');
    if (!make || make.hidden || state.newName === '') { hide(); return; }

    const field = function (suffix) {
        const element = document.getElementById(id + '-' + suffix);
        return element ? element.value.trim() : '';
    };
    const unit = field('unit');
    box.hidden = false;
    box.innerHTML = strip([field('brand'), field('category') || 'No category',
        unit ? 'counted in ' + unit : 'no unit yet'],
        parseFloat(field('price')) || 0, unit || 'unit');
}

function renderMatVerdict(id) {
    renderMatDesc(id);

    const box = document.getElementById(id + '-verdict');
    if (!box) return;

    const state = matState(id);
    const make = document.getElementById(id + '-make');
    const newMode = make && !make.hidden;

    if (state.productId) {
        const product = poFindProduct(poMaterials, state.productId);
        box.className = 'pick-verdict';

        if (product) {
            box.textContent = product.quantity_in_stock + ' ' + (product.unit_name || 'on hand') +
                  ' on the shelf now.';
        } else {
            box.textContent = '';
        }

        return;
    }

    if (newMode && state.newName !== '') {
        box.className = 'pick-verdict';
        box.textContent = '';
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
    const field = function (suffix) {
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

async function loadPoSuppliers(force) {
    if (poSuppliersLoaded && !force) return true;

    try {
        poSuppliers = await apiGetRecords('supplier');
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
    poSupplierCommitted = false;

    if (!poSupplier && typed !== '') {
        poSupplier = null;
        for (let i = 0; i < poSuppliers.length; i++) {
            if (String(poSuppliers[i].name).toLowerCase() === typed.toLowerCase()) {
                poSupplier = poSuppliers[i];
                break;
            }
        }
    }

    renderSupplierSuggestions(typed);
    renderSupplierState();
}

function onSupplierLeave() {
    const box = document.getElementById('po-supplier');
    if (box && box.value.trim() !== '') poSupplierCommitted = true;
    renderSupplierState();
}

function renderSupplierSuggestions(text) {
    const list = document.getElementById('po-supplier-list');
    const box = document.getElementById('po-supplier');
    if (!list) return;

    const query = String(text || '').trim().toLowerCase();
    poSupplierHighlight = -1;

    const hide = function () {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (searchText(query) === '') { hide(); return; }

    const startsWithQuery = [];
    for (let i = 0; i < poSuppliers.length; i++) {
        if (startsAWord(poSuppliers[i].name, query)) startsWithQuery.push(poSuppliers[i]);
    }
    const matches = startsWithQuery.slice(0, 6);

    if (matches.length === 1 && String(matches[0].name).toLowerCase() === query) {
        hide();
        return;
    }
    if (matches.length === 0) { hide(); return; }

    let supplierItems = '';
    for (let i = 0; i < matches.length; i++) {
        const s = matches[i];
        supplierItems += '<li class="suggest-item" role="option" onmousedown="event.preventDefault()" ' +
            'onclick="pickSupplier(' + s.id + ')">' +
            '<span class="suggest-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="suggest-note">' +
                escapeHtml(s.contact_person || 'No contact on file') +
                ' · ' + s.product_count + ' material(s) supplied</span>' +
        '</li>';
    }
    list.innerHTML = supplierItems;

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
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === poSupplierHighlight);
        }
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
    poSupplier = null;
    for (let i = 0; i < poSuppliers.length; i++) {
        if (poSuppliers[i].id === supplierId) {
            poSupplier = poSuppliers[i];
            break;
        }
    }
    poSupplierCommitted = true;

    const box = document.getElementById('po-supplier');
    if (box && poSupplier) box.value = poSupplier.name;

    const list = document.getElementById('po-supplier-list');
    if (list) { list.hidden = true; list.innerHTML = ''; }

    renderSupplierState();
}

function poSupplierSettled() {
    return Boolean(poSupplier);
}

function renderPoLinesGate() {
    const lines = document.getElementById('po-lines');
    const lock = document.getElementById('po-lines-lock');
    const add = document.getElementById('po-add-line');
    if (!lines) return;

    const open = poSupplierSettled();
    const supplierId = poSupplier ? poSupplier.id : null;

    if (open && supplierId !== poLinesSupplierId) {
        let picked = false;
        const lineRows = document.querySelectorAll('.po-line');
        for (let i = 0; i < lineRows.length; i++) {
            if (matState(lineRows[i].dataset.picker).productId) {
                picked = true;
            }
        }
        if (picked) {
            resetPurchaseLines();
            notifyWarning('The company changed, so the materials picked for the other company ' +
                'were taken off the order.', 'Lines cleared');
        }
        poLinesSupplierId = supplierId;
    }

    lines.hidden = !open;
    if (lock) lock.hidden = open;
    if (add) {
        add.hidden = !open;
        add.classList.toggle('is-inactive', !open);
        add.setAttribute('aria-disabled', open ? 'false' : 'true');
    }
}

function resetPurchaseLines() {
    for (const key in matPickers) {
        if (matIsOrderLine(key)) delete matPickers[key];
    }

    const lines = document.getElementById('po-lines');
    if (lines) lines.innerHTML = '';
    poLineCount = 0;
    addPurchaseLine();
}

function renderCriticalStocks() {
    const list = document.getElementById('po-roster-list');
    if (!list) return;

    const filter = document.getElementById('po-roster-filter');
    const query = searchText(filter ? filter.value : '');

    if (!poMaterialsLoaded) {
        list.innerHTML = '<li class="po-roster-empty">' +
            (poMaterialsFailed ? 'The materials could not be loaded.' : 'Loading the materials...') + '</li>';
        return;
    }

    const critical = [];
    for (let i = 0; i < poMaterials.length; i++) {
        const p = poMaterials[i];
        if (p.stock_status !== 'Out of Stock' && p.stock_status !== 'Low Stock') continue;
        if (!prefixMatch([p.product_name, p.supplier_name, p.category_name, p.brand_name], query)) continue;
        critical.push(p);
    }
    const shortBy = function (p) { return (Number(p.reorder_point) || 0) - (Number(p.quantity_in_stock) || 0); };
    critical.sort(function (a, b) {
        const aOut = a.stock_status === 'Out of Stock' ? 0 : 1;
        const bOut = b.stock_status === 'Out of Stock' ? 0 : 1;
        if (aOut !== bOut) return aOut - bOut;
        if (shortBy(a) !== shortBy(b)) return shortBy(b) - shortBy(a);
        return String(a.product_name).localeCompare(String(b.product_name));
    });

    if (critical.length === 0) {
        list.innerHTML = '<li class="po-roster-empty">' +
            (query ? 'No critical material matches that.' : 'No material is low or out of stock.') + '</li>';
        return;
    }

    const onOrder = poOrderedProductIds();
    let html = '';
    for (let i = 0; i < critical.length; i++) {
        const p = critical[i];
        const out = p.stock_status === 'Out of Stock';
        const unit = p.unit_name || '';
        html += '<li class="po-roster-item' + (onOrder[p.product_id] ? ' is-active' : '') + '" role="button" tabindex="0" ' +
                'title="' + (onOrder[p.product_id] ? 'On this order' : 'Add it to the order') + '" ' +
                'onclick="addCriticalToOrder(' + p.product_id + ')" ' +
                'onkeydown="if (event.key === \'Enter\' || event.key === \' \') { event.preventDefault(); addCriticalToOrder(' + p.product_id + '); }">' +
            '<span class="po-roster-line">' +
                '<span class="po-roster-name">' + escapeHtml(p.product_name) + '</span>' +
                '<span class="badge ' + (out ? 'badge-danger' : 'badge-warning') + '">' +
                    escapeHtml(qtyText(Number(p.quantity_in_stock) || 0, unit)) + '</span>' +
            '</span>' +
            '<span class="po-roster-sub">' + escapeHtml(p.supplier_name || 'No supplier on file') +
                ' · reorder at ' + (Number(p.reorder_point) || 0) + '</span>' +
        '</li>';
    }
    list.innerHTML = html;
}

function poOrderedProductIds() {
    const ids = {};
    const rows = document.querySelectorAll('.po-line');
    for (let i = 0; i < rows.length; i++) {
        const state = matState(rows[i].dataset.picker);
        if (state.productId) ids[state.productId] = true;
    }
    return ids;
}

function criticalOrderQuantity(p) {
    let quantity = Math.ceil(Number(p.suggested_order) || 0);
    if (!(quantity > 0)) {
        quantity = Math.ceil((Number(p.reorder_point) || 0) - (Number(p.quantity_in_stock) || 0)) + 1;
    }
    return Math.max(1, quantity);
}

function addCriticalToOrder(productId) {
    const p = poFindProduct(poMaterials, productId);
    if (!p) return;

    if (!p.supplier_id) {
        notifyWarning(p.product_name + ' has no supplier on file, so it cannot be ordered from here. ' +
            'Ask the manager to give it one under Records, Products.', 'No supplier');
        return;
    }

    if (!poSupplier || poSupplier.id !== p.supplier_id) {
        let known = false;
        for (let i = 0; i < poSuppliers.length; i++) {
            if (poSuppliers[i].id === p.supplier_id) known = true;
        }
        if (!known) {
            notifyWarning(p.product_name + '\'s supplier is not on the supplier list.', 'Supplier not found');
            return;
        }
        pickSupplier(p.supplier_id);
    }

    const rows = document.querySelectorAll('.po-line');
    for (let i = 0; i < rows.length; i++) {
        if (matState(rows[i].dataset.picker).productId === productId) {
            rows[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
            const qty = rows[i].querySelector('.po-qty');
            if (qty) qty.focus({ preventScroll: true });
            return;
        }
    }

    let row = null;
    for (let i = 0; i < rows.length && !row; i++) {
        const state = matState(rows[i].dataset.picker);
        const box = matBox(rows[i].dataset.picker);
        if (!state.productId && !state.newName && !(box && box.value.trim())) row = rows[i];
    }
    if (!row) {
        addPurchaseLine();
        row = document.querySelector('.po-line');
    }
    if (!row) return;

    matPick(row.dataset.picker, productId);

    const index = row.id.replace('po-line-', '');
    const qty = document.getElementById('po-qty-' + index);
    const pack = poLineIn(row);
    if (qty) qty.value = pack ? Math.max(1, Math.ceil(criticalOrderQuantity(p) / pack.size)) : criticalOrderQuantity(p);
    renderPoTotals();

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (qty) qty.focus({ preventScroll: true });
}

function renderSupplierState() {
    const box = document.getElementById('po-supplier');
    const known = document.getElementById('po-supplier-known');
    const card = document.getElementById('po-supplier-new');
    if (!box) return;

    const typed = box.value.trim();
    renderCriticalStocks();

    if (poSupplier) {
        if (known) {
            known.hidden = false;
            known.innerHTML =
                '<strong>' + escapeHtml(poSupplier.name) + '</strong> is already on file. ' +
                escapeHtml(poSupplier.contact_person || 'No contact person recorded') +
                (poSupplier.contact_number ? ' · ' + escapeHtml(poSupplier.contact_number) : '') +
                (poSupplier.address ? '<br>' + escapeHtml(poSupplier.address) : '') +
                '<br>The lines below offer the ' + poSupplier.product_count +
                ' material(s) this company supplies.';
        }
        if (card) card.hidden = true;
        renderPoLinesGate();
        return;
    }

    if (known) known.hidden = true;

    if (card) {
        card.hidden = typed === '';
        const sub = document.getElementById('po-supplier-new-sub');
        if (sub && typed !== '') {
            sub.textContent = '"' + typed + '" is not on file. Only the manager can add a supplier: ' +
                'ask the manager to add it under Records, then pick it from the list.';
        }
    }
    renderPoLinesGate();
}

function addPurchaseLine(fromButton) {
    const box = document.getElementById('po-lines');
    if (!box) return;

    if (fromButton && !poSupplierSettled()) {
        notifyWarning('Name the supplier company first. The lines then offer what that company supplies.',
            'Company first');
        const supplier = document.getElementById('po-supplier');
        if (supplier) supplier.focus();
        return;
    }

    const index = poLineCount++;
    const pickerId = 'po-mat-' + index;

    const row = document.createElement('div');
    row.className = 'po-line';
    row.id = 'po-line-' + index;
    row.dataset.picker = pickerId;
    row.innerHTML =
        '<div class="po-line-head">' +
            '<span class="po-line-title" id="po-line-title-' + index + '">Line</span>' +
            '<button type="button" class="btn btn-sm btn-ghost po-remove" ' +
                    'onclick="removePurchaseLine(' + index + ')" aria-label="Remove this line">Remove</button>' +
        '</div>' +
        '<div class="po-line-fields">' +
            materialPickerHtml(pickerId, 'Material') +
            '<div class="form-group"><label for="po-qty-' + index + '" id="po-qty-label-' + index + '">Quantity</label>' +
            '<input type="number" id="po-qty-' + index + '" class="form-control po-qty" min="1" value="1" ' +
                   'oninput="renderPoTotals()">' +
            '<select id="po-in-' + index + '" class="form-control po-in" hidden onchange="renderPoTotals()"></select>' +
            '<p class="pick-verdict po-line-note" id="po-line-note-' + index + '"></p></div>' +
            '<div class="form-group"><label for="po-price-' + index + '" id="po-price-label-' + index + '">Unit price</label>' +
            '<input type="text" class="form-control po-cost" id="po-price-' + index + '" readonly tabindex="-1" ' +
                   'title="The price on file for this material. It is not typed on the order.">' +
            '<p class="pick-verdict po-line-amount" id="po-line-amount-' + index + '"></p></div>' +
            '<div class="form-group"><label for="po-line-total-' + index + '">Line total</label>' +
            '<input type="text" class="form-control po-cost po-line-total" id="po-line-total-' + index + '" ' +
                   'readonly tabindex="-1"></div>' +
        '</div>';

    box.insertBefore(row, box.firstChild);
    renderPoTotals();

    if (fromButton) {
        const field = matBox(pickerId);
        if (field) field.focus();
    }
}

function poLineRows() {
    const found = document.querySelectorAll('.po-line');
    const rows = [];
    for (let i = found.length - 1; i >= 0; i--) {
        rows.push(found[i]);
    }
    return rows;
}

function poLinePack(row) {
    const state = matState(row.dataset.picker);
    const product = state.productId ? poFindProduct(poMaterials, state.productId) : null;
    if (!product || !product.pack_name || !(Number(product.pack_size) > 0)) return null;
    return { name: product.pack_name, size: Number(product.pack_size), unit: product.unit_name || 'unit' };
}

function poLinePricing(row) {
    const id = row.dataset.picker;
    const state = matState(id);
    const pack = poLineIn(row);
    let product;
    if (state.productId) {
        product = poFindProduct(poMaterials, state.productId);
    } else {
        product = null;
    }

    const make = document.getElementById(id + '-make');
    const isNew = Boolean(make) && !make.hidden && state.newName !== '';
    const field = function (suffix) {
        const element = document.getElementById(id + '-' + suffix);
        return element ? element.value.trim() : '';
    };

    const unit = product ? (product.unit_name || 'unit') : (field('unit') || 'unit');
    let unitPrice;
    if (product) {
        unitPrice = Math.max(0, Number(product.price) || 0);
    } else if (isNew) {
        unitPrice = Math.max(0, parseFloat(field('price')) || 0);
    } else {
        unitPrice = 0;
    }

    return {
        chosen: Boolean(product) || isNew,
        isNew: isNew,
        unit: unit,
        unitPrice: unitPrice,
        per: pack ? pack.name : unit,
        perPrice: pack ? unitPrice * pack.size : unitPrice
    };
}

function poLineIn(row) {
    const select = row.querySelector('.po-in');
    const pack = poLinePack(row);
    return pack && select && !select.hidden && select.value === 'pack' ? pack : null;
}

function syncPoLineUnits(pickerId) {
    if (!/^po-mat-/.test(pickerId)) return;
    const row = document.getElementById('po-line-' + pickerId.replace('po-mat-', ''));
    if (!row) return;
    const index = row.id.replace('po-line-', '');
    const select = row.querySelector('.po-in');
    const qtyLabel = document.getElementById('po-qty-label-' + index);
    const pack = poLinePack(row);

    if (!pack) {
        if (select) { select.hidden = true; select.innerHTML = ''; }
        if (qtyLabel) qtyLabel.textContent = 'Quantity';
        return;
    }

    if (select) {
        const was = select.hidden ? 'pack' : select.value;
        select.innerHTML =
            '<option value="pack">' + escapeHtml(pack.name) + ' of ' + escapeHtml(qtyText(pack.size, pack.unit)) + '</option>' +
            '<option value="unit">' + escapeHtml(pack.unit) + '</option>';
        select.value = was;
        select.hidden = false;
    }
    const inPack = select && select.value === 'pack';
    if (qtyLabel) qtyLabel.textContent = inPack ? 'Quantity (' + pack.name + ')' : 'Quantity';
}

function removePurchaseLine(index) {
    const row = document.getElementById('po-line-' + index);
    if (!row) return;

    delete matPickers[row.dataset.picker];
    row.remove();
    renderPoTotals();
}

function renderPoTotals() {
    renderCriticalStocks();

    let goods = 0;
    let priced = 0;

    const lineRows = poLineRows();
    for (let position = 0; position < lineRows.length; position++) {
        const row = lineRows[position];
        const index = row.id.replace('po-line-', '');
        const qty = parseInt(row.querySelector('.po-qty').value, 10) || 0;
        const pack = poLineIn(row);
        const price = poLinePricing(row);
        const amount = qty > 0 ? qty * price.perPrice : 0;
        if (price.chosen) { goods += amount; priced += 1; }

        const title = document.getElementById('po-line-title-' + index);
        if (title) title.textContent = 'Line ' + (position + 1);

        const qtyLabel = document.getElementById('po-qty-label-' + index);
        if (qtyLabel) qtyLabel.textContent = pack ? 'Quantity (' + pack.name + ')' : 'Quantity';

        const note = document.getElementById('po-line-note-' + index);
        if (note) note.textContent = pack && qty > 0 ? '= ' + qtyText(qty * pack.size, pack.unit) : '';

        const priceLabel = document.getElementById('po-price-label-' + index);
        if (priceLabel) priceLabel.textContent = pack ? 'Price per ' + pack.name : 'Unit price';

        const priceField = document.getElementById('po-price-' + index);
        if (priceField) priceField.value = price.chosen ? peso(price.perPrice) : '';

        const unpriced = price.chosen && !(price.perPrice > 0);
        const totalField = document.getElementById('po-line-total-' + index);
        if (totalField) totalField.value = price.chosen && !unpriced ? peso(amount) : '';

        const amountBox = document.getElementById('po-line-amount-' + index);
        if (amountBox) {
            amountBox.className = 'pick-verdict po-line-amount' + (unpriced ? ' is-stop' : '');
            amountBox.textContent = unpriced ? 'No price on file for this one.' : '';
        }
    }

    const count = document.getElementById('po-line-count');
    if (count) {
        const lines = document.querySelectorAll('.po-line').length;
        count.textContent = lines + (lines === 1 ? ' line' : ' lines');
    }

    const total = document.getElementById('po-total');
    if (total) {
        if (priced === 0) {
            total.innerHTML = '';
        } else {
            total.innerHTML = '<div class="po-sum is-total">' +
                '<span class="po-sum-label">Order total, at the prices on file</span>' +
                '<span class="po-sum-value">' + peso(goods) + '</span>' +
            '</div>';
        }
    }
}

async function handleCreatePurchaseOrder(event) {
    event.preventDefault();

    const box = document.getElementById('po-supplier');
    const company = box ? box.value.trim() : '';

    if (company === '' || !poSupplierSettled()) {
        notifyWarning('Type the supplier company name this order goes to.', 'Order not sent');
        if (box) box.focus();
        return;
    }

    const numberBox = document.getElementById('po-supplier-number');
    if (!poSupplier && numberBox) {
        const problem = phoneComplaint(numberBox);
        if (problem) {
            notifyWarning(problem, 'Order not sent');
            numberBox.focus();
            return;
        }
    }

    const rows = poLineRows();
    const items = [];

    if (rows.length === 0) {
        notifyWarning('Add at least one material to the order.', 'Order not sent');
        return;
    }

    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const picked = matValue(row.dataset.picker);

        if (picked.ok && !picked.isNew &&
            !poFindProduct(matChoices(row.dataset.picker), picked.productId)) {
            notifyWarning('A line names a material ' + company + ' does not supply. ' +
                'Pick one from their list, or add it as new.', 'Order not sent');
            const field = document.getElementById(row.dataset.picker + '-box');
            if (field) field.focus();
            return;
        }

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
                'Fill in its Unit, like pcs or bag.', 'Order not sent');
            const field = document.getElementById(row.dataset.picker + '-unit');
            if (field) field.focus();
            return;
        }

        const pack = poLineIn(row);
        const pricing = poLinePricing(row);

        if (!(pricing.unitPrice > 0)) {
            notifyWarning(picked.isNew
                ? '"' + picked.newName + '" needs a price before it can be ordered. It goes on ' +
                  'the material\'s record and is what this line is ordered at.'
                : 'That material has no price on file, so the line cannot be priced. Put a price ' +
                  'on it in the Material List first.', 'Order not sent');
            const field = document.getElementById(
                row.dataset.picker + (picked.isNew ? '-price' : '-box'));
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
            quantity: pack ? Math.round(quantity * pack.size) : quantity,
            unitCost: pricing.unitPrice,
            packName: pack ? pack.name : null,
            packSize: pack ? pack.size : null,
            packCount: pack ? quantity : null
        });
    }

    const detail = function (id) {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    };

    try {
        const response = await apiCreatePurchaseOrder({
                supplierId: poSupplier ? poSupplier.id : null,
                supplierName: company,
                contactPerson: detail('po-supplier-contact'),
                contactNumber: (!poSupplier && numberBox) ? phoneToStore(numberBox) : '',
                supplierEmail: detail('po-supplier-email'),
                supplierAddress: detail('po-supplier-address'),
                items: items
            });
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        resetPurchaseOrderForm();

        poMaterialsLoaded = false;
        poSuppliersLoaded = false;
        Promise.all([loadPoSuppliers(true), ensurePoMaterials(true)]).then(renderCriticalStocks);
        await refreshPurchaseOrders();
        poAfterChange();

        if (result.poId) openPurchaseOrderDocument(result.poId);
    } catch (error) {
        notifyOffline();
    }
}

function resetPurchaseOrderForm() {
    poSupplier = null;
    poSupplierCommitted = false;
    poLinesSupplierId = null;

    const box = document.getElementById('po-supplier');
    if (box) box.value = '';

    const detailIds = ['po-supplier-contact', 'po-supplier-number', 'po-supplier-email', 'po-supplier-address'];
    for (let i = 0; i < detailIds.length; i++) {
        const field = document.getElementById(detailIds[i]);
        if (field) field.value = '';
    }

    for (const key in matPickers) {
        delete matPickers[key];
    }

    const lines = document.getElementById('po-lines');
    if (lines) lines.innerHTML = '';
    poLineCount = 0;
    addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

const PO_STATES = [
    { status: 'For Approval',                  label: 'Pending Manager Approval' },
    { status: 'Approved',                      label: 'Approved' },
    { status: 'Declined - Manager',            label: 'Declined - Manager' },
    { status: 'Pending Supplier Confirmation', label: 'Pending Supplier Confirmation' },
    { status: 'Accepted',                      label: 'Accepted' },
    { status: 'Declined - Supplier',           label: 'Declined - Supplier' },
    { status: 'Received',                      label: 'Received' }
];

function poStage(po) {
    if (po.status === 'Cancelled') return 'Declined - Manager';
    if (po.status !== 'Pending') return po.status;
    if (po.supplier_response === 'Accepted') return 'Accepted';
    if (po.supplier_response === 'Declined') return 'Declined - Supplier';
    if (po.supplier_sent_at) return 'Pending Supplier Confirmation';
    return 'Approved';
}

function poCanRefer(po) {
    return poStage(po) === 'Accepted';
}

function poStatusWord(stage) {
    let state = null;
    for (let i = 0; i < PO_STATES.length; i++) {
        if (PO_STATES[i].status === stage) {
            state = PO_STATES[i];
            break;
        }
    }
    return state ? state.label : statusWord(stage);
}

const PO_STAGE_TONES = {
    'For Approval': 'badge-warning',
    'Approved': 'badge-info',
    'Declined - Manager': 'badge-danger',
    'Pending Supplier Confirmation': 'badge-warning',
    'Accepted': 'badge-info',
    'Declined - Supplier': 'badge-danger',
    'Received': 'badge-success'
};

function poStatusBadge(po) {
    const stage = poStage(po);
    return '<span class="badge ' + (PO_STAGE_TONES[stage] || 'badge-neutral') + '">' +
        escapeHtml(poStatusWord(stage)) + '</span>';
}

function poNeedsMe(po) {
    const stage = poStage(po);
    return (poSetup.canDecide && stage === 'For Approval') ||
           (poSetup.canReceive && (stage === 'Approved' || stage === 'Accepted'));
}

function sortPurchaseOrders(rows) {
    return rows.sort(function (a, b) {
        return (Number(poNeedsMe(b)) - Number(poNeedsMe(a))) ||
            String(b.order_date).localeCompare(String(a.order_date)) ||
            (Number(b.po_id) - Number(a.po_id));
    });
}

function poValueCell(po) {
    if (po.status === 'Received') return peso(po.total_cost);
    if (po.status === 'Cancelled') return '<span class="muted">' + peso(po.goods_cost) + '</span>';
    return peso(po.goods_cost);
}

function poToSend(po) {
    return poStage(po) === 'Approved';
}

function poRowTitle(po) {
    if (poSetup.canReceive && poToSend(po)) return 'Print this order and send it to the supplier';
    if (poSetup.canDecide && po.status === 'For Approval') return 'Review this order';
    return 'Open this order';
}

function buildPurchaseOrderPanel() {
    createDataPanel({
        key: poSetup.key,
        tableId: 'po-table',
        columns: poSetup.showLines ? 6 : 5,
        pagerId: 'po-pager',
        idField: 'po_id',
        filters: { status: 'all' },

        gate: {
            title: 'No purchase orders loaded',
            text: poSetup.gateText,
            button: 'Load Data'
        },

        load: function () {
            return apiGetPurchaseOrders();
        },

        match: function (po, query) {
            return prefixMatch([po.supplier_name, po.po_id, '#' + po.po_id], query);
        },
        filter: function (po, filters) {
            return filters.status === 'all' || poStage(po) === filters.status;
        },
        sort: function (rows) {
            return sortPurchaseOrders(rows);
        },

        renderRow: function (po, index) {
            return '<tr class="row-clickable row-reveal' + (poNeedsMe(po) ? ' row-attention' : '') + '" ' +
                'style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'title="' + poRowTitle(po) + '" ' +
                'onclick="openPurchaseOrderDetail(' + po.po_id + ')">' +
            '<td class="cell-id">#' + po.po_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(po.supplier_name) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(po.order_date).slice(0, 10)) + '</td>' +
            (poSetup.showLines ? '<td class="cell-num">' + po.line_count + '</td>' : '') +
            '<td class="cell-num">' + poValueCell(po) + '</td>' +
            '<td>' + poStatusBadge(po) + '</td></tr>';
        }
    });
}

function purchaseOrderPanel() { return getDataPanel(poSetup.key); }

function findPurchaseOrder(poId) {
    const panel = purchaseOrderPanel();
    const totals = getDataPanel(PO_TOTALS_KEY);
    return (panel && panel.find(poId, 'po_id')) ||
           (totals && totals.find(poId, 'po_id')) || null;
}

async function refreshPurchaseOrders() {
    const panel = purchaseOrderPanel();
    if (panel && panel.state !== 'closed') await panel.refresh();
    const totals = getDataPanel(PO_TOTALS_KEY);
    if (totals && totals.state !== 'closed') await totals.refresh();
}

async function loadPurchaseOrders() { await refreshPurchaseOrders(); }

const PO_TOTALS_KEY = 'po-totals';

function poThisMonth() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function poMonthLabel(month) {
    const parts = String(month).split('-');
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return date.toLocaleString('en-PH', { month: 'long', year: 'numeric' });
}

function poOrderValue(po) {
    return Number(po.status === 'Received' ? po.total_cost : po.goods_cost) || 0;
}

function purchaseTotalsFilter(name, value) {
    dataPanelFilter(PO_TOTALS_KEY, name, value);
}

function renderPurchaseTotalsSuppliers(rows) {
    const select = document.getElementById('po-totals-supplier');
    if (!select) return;

    const suppliers = [];
    for (let i = 0; i < rows.length; i++) {
        const supplierId = String(rows[i].supplier_id);
        let supplier = null;
        for (let j = 0; j < suppliers.length; j++) {
            if (suppliers[j].id === supplierId) {
                supplier = suppliers[j];
                break;
            }
        }
        if (supplier === null) {
            suppliers.push({ id: supplierId, name: rows[i].supplier_name });
        } else {
            supplier.name = rows[i].supplier_name;
        }
    }
    suppliers.sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
    });

    const current = select.value;
    let supplierOptions = '';
    let currentStillListed = false;
    for (let i = 0; i < suppliers.length; i++) {
        supplierOptions += '<option value="' + escapeHtml(suppliers[i].id) + '">' +
            escapeHtml(suppliers[i].name) + '</option>';
        if (suppliers[i].id === current) currentStillListed = true;
    }
    select.innerHTML = '<option value="all">Every supplier</option>' + supplierOptions;
    select.value = currentStillListed ? current : 'all';
}

function poThisYear() {
    return String(new Date().getFullYear());
}

const PO_TOTALS_FIRST_YEAR = 2025;

function poFirstYear(rows) {
    let first = PO_TOTALS_FIRST_YEAR;
    for (let i = 0; i < rows.length; i++) {
        const year = Number(String(rows[i].order_date).slice(0, 4));
        if (year && year < first) first = year;
    }
    return first;
}

function poTotalsMonths(rows) {
    const months = [];
    const last = Number(poThisYear());
    for (let year = poFirstYear(rows || []); year <= last; year++) {
        for (let month = 1; month <= 12; month++) {
            months.push(year + '-' + String(month).padStart(2, '0'));
        }
    }
    return months;
}

function poMonthFromLabel(text) {
    const wanted = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const months = poTotalsMonths(purchaseOrderRowsLoaded());
    for (let i = 0; i < months.length; i++) {
        if (poMonthLabel(months[i]).toLowerCase() === wanted || months[i] === wanted) return months[i];
    }
    return null;
}

function purchaseOrderRowsLoaded() {
    const panel = getDataPanel(PO_TOTALS_KEY);
    return panel && panel.rows ? panel.rows : [];
}

let poMonthChoices = [];
let poMonthActive = -1;

function renderPurchaseTotalsMonths(rows) {
    const box = document.getElementById('po-totals-month');
    if (!box) return;

    poMonthChoices = poTotalsMonths(rows);
    const panel = getDataPanel(PO_TOTALS_KEY);
    const current = panel ? panel.filters.month : poThisMonth();
    if (document.activeElement !== box) {
        box.value = poMonthLabel(poMonthChoices.indexOf(current) !== -1 ? current : poThisMonth());
    }
    poMonthSyncClear();
}

function poMonthInUse() {
    const panel = getDataPanel(PO_TOTALS_KEY);
    return panel ? panel.filters.month : poThisMonth();
}

function poMonthMatches(text) {
    const typed = String(text || '').trim().toLowerCase();
    const months = poMonthChoices.length ? poMonthChoices : poTotalsMonths([]);
    if (typed === '' || typed === poMonthLabel(poMonthInUse()).toLowerCase()) return months;

    const words = typed.split(/\s+/);
    const found = [];
    for (let i = 0; i < months.length; i++) {
        const parts = poMonthLabel(months[i]).toLowerCase().split(' ');
        let fits = true;
        for (let w = 0; w < words.length && fits; w++) {
            const word = words[w];
            const startsName = parts[0].startsWith(word);
            const startsYear = /^\d+$/.test(word) && (parts[1].startsWith(word) || parts[1].slice(2).startsWith(word));
            if (!startsName && !startsYear) fits = false;
        }
        if (fits) found.push(months[i]);
    }
    return found;
}

function poMonthSyncClear() {
    const box = document.getElementById('po-totals-month');
    const clear = document.getElementById('po-totals-month-clear');
    if (box && clear) clear.hidden = box.value === '';
}

function poMonthClear() {
    const box = document.getElementById('po-totals-month');
    if (!box) return;
    box.value = '';
    box.focus();
    poMonthSuggest(false);
}

function poMonthFocus(box) {
    box.select();
    poMonthSuggest(true);
}

function poMonthClick(box) {
    const list = document.getElementById('po-totals-month-list');
    if (list && list.hidden) poMonthFocus(box);
}

function poMonthSuggest(openAll) {
    const box = document.getElementById('po-totals-month');
    const list = document.getElementById('po-totals-month-list');
    if (!box || !list) return;

    const matches = poMonthMatches(box.value);
    poMonthActive = -1;
    if (matches.length === 0) {
        list.innerHTML = '<li class="suggest-item is-empty"><span class="suggest-name">No month matches</span></li>';
    } else {
        const current = poMonthInUse();
        let html = '';
        for (let i = 0; i < matches.length; i++) {
            html += '<li class="suggest-item' + (matches[i] === current ? ' is-current' : '') + '" role="option" ' +
                'id="po-month-option-' + i + '" data-month="' + matches[i] + '" aria-selected="false" ' +
                'onmousedown="event.preventDefault(); poMonthPick(\'' + matches[i] + '\')">' +
                '<span class="suggest-name">' + escapeHtml(poMonthLabel(matches[i])) + '</span></li>';
        }
        list.innerHTML = html;
    }
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
    poMonthSyncClear();

    if (openAll) {
        const current = list.querySelector('.is-current');
        if (current) list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2;
    } else {
        list.scrollTop = 0;
    }
}

function poMonthHide() {
    const box = document.getElementById('po-totals-month');
    const list = document.getElementById('po-totals-month-list');
    if (list) list.hidden = true;
    poMonthSyncClear();
    if (box) {
        box.setAttribute('aria-expanded', 'false');
        box.removeAttribute('aria-activedescendant');
    }
    poMonthActive = -1;
}

function poMonthPick(month) {
    const box = document.getElementById('po-totals-month');
    if (box) box.value = poMonthLabel(month);
    poMonthHide();
    if (month !== poMonthInUse()) purchaseTotalsMonth(month);
}

function poMonthKey(event) {
    const list = document.getElementById('po-totals-month-list');
    const box = event.target;
    if (!list) return;
    const items = list.querySelectorAll('.suggest-item[data-month]');

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) { poMonthSuggest(true); return; }
        if (items.length === 0) return;
        poMonthActive += event.key === 'ArrowDown' ? 1 : -1;
        if (poMonthActive < 0) poMonthActive = items.length - 1;
        if (poMonthActive >= items.length) poMonthActive = 0;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('is-active', i === poMonthActive);
            items[i].setAttribute('aria-selected', i === poMonthActive ? 'true' : 'false');
        }
        items[poMonthActive].scrollIntoView({ block: 'nearest' });
        box.setAttribute('aria-activedescendant', items[poMonthActive].id);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (poMonthActive >= 0 && items[poMonthActive]) {
            poMonthPick(items[poMonthActive].dataset.month);
        } else if (items.length === 1 || poMonthFromLabel(box.value)) {
            poMonthPick(poMonthFromLabel(box.value) || items[0].dataset.month);
        } else if (items.length === 0) {
            notifyWarning('Pick a month from the list, like ' + poMonthLabel(poThisMonth()) + '.', 'No such month');
        }
    } else if (event.key === 'Escape') {
        box.value = poMonthLabel(poMonthInUse());
        poMonthHide();
    }
}

function poMonthBlur() {
    const box = document.getElementById('po-totals-month');
    if (!box) return;
    const month = poMonthFromLabel(box.value);
    poMonthHide();
    if (month) poMonthPick(month);
    else box.value = poMonthLabel(poMonthInUse());
}

function renderPurchaseTotalsYears(rows) {
    const select = document.getElementById('po-totals-year');
    if (!select) return;

    const years = [];
    const last = Number(poThisYear());
    for (let year = poFirstYear(rows); year <= last; year++) years.push(String(year));

    const panel = getDataPanel(PO_TOTALS_KEY);
    const current = panel ? panel.filters.year : poThisYear();

    let yearOptions = '';
    for (let i = 0; i < years.length; i++) {
        yearOptions += '<option value="' + years[i] + '">' + years[i] + '</option>';
    }
    select.innerHTML = yearOptions;
    select.value = years.indexOf(current) !== -1 ? current : poThisYear();
}

function syncPurchaseTotalsPeriod() {
    const panel = getDataPanel(PO_TOTALS_KEY);
    const period = panel ? panel.filters.period : 'month';

    const select = document.getElementById('po-totals-period');
    if (select) select.value = period;

    const monthField = document.getElementById('po-totals-month-field');
    const yearField = document.getElementById('po-totals-year-field');
    if (monthField) monthField.hidden = period !== 'month';
    if (yearField) yearField.hidden = period !== 'year';

    const dateFields = ['po-totals-from-field', 'po-totals-to-field'];
    for (let i = 0; i < dateFields.length; i++) {
        const field = document.getElementById(dateFields[i]);
        if (field) field.hidden = period !== 'custom';
    }
}

function clearPurchaseTotalsDates(panel) {
    const dateIds = ['po-totals-from', 'po-totals-to'];
    for (let i = 0; i < dateIds.length; i++) {
        const box = document.getElementById(dateIds[i]);
        if (box) box.value = '';
    }
    panel.filters.from = '';
    panel.filters.to = '';
}

function purchaseTotalsPeriod(value) {
    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;

    if (value === 'custom') {
        panel.filters.period = 'custom';
        syncPurchaseTotalsPeriod();
        const from = document.getElementById('po-totals-from');
        if (from) from.focus();
        return;
    }
    clearPurchaseTotalsDates(panel);

    const month = document.getElementById('po-totals-month');
    const year = document.getElementById('po-totals-year');
    panel.filters.month = (month && poMonthFromLabel(month.value)) || poThisMonth();
    panel.filters.year = year && year.value ? year.value : poThisYear();

    dataPanelFilter(PO_TOTALS_KEY, 'period', value);
    syncPurchaseTotalsPeriod();
}

function purchaseTotalsMonth(value) {
    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    clearPurchaseTotalsDates(panel);
    dataPanelFilter(PO_TOTALS_KEY, 'month', value);
}

function purchaseTotalsYear(value) {
    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    clearPurchaseTotalsDates(panel);
    dataPanelFilter(PO_TOTALS_KEY, 'year', value);
}

function purchaseTotalsShowAll() {
    const boxes = { 'po-totals-from': '', 'po-totals-to': '', 'po-totals-supplier': 'all' };
    for (const id in boxes) {
        const box = document.getElementById(id);
        if (box) box.value = boxes[id];
    }

    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    Object.assign(panel.filters, { period: 'all', supplier: 'all', from: '', to: '' });
    syncPurchaseTotalsPeriod();
    panel.page = 1;
    if (panel.state === 'ready') panel.apply();
    else if (panel.state !== 'loading') panel.open();
}

function renderPurchaseTotalsFigures() {
    const grid = document.getElementById('po-totals-kpis');
    if (!grid) return;

    const panel = getDataPanel(PO_TOTALS_KEY);
    const ready = panel && panel.state === 'ready';
    const orders = ready ? panel.visible : [];
    let total = 0;
    for (let i = 0; i < orders.length; i++) {
        total = total + poOrderValue(orders[i]);
    }
    const shown = function (text) {
        return ready ? text : '0';
    };

    const f = panel ? panel.filters : {};
    let covers = 'the orders the filters leave in';
    if (f.period === 'month' && f.month) covers = 'ordered in ' + escapeHtml(poMonthLabel(f.month));
    else if (f.period === 'year' && f.year) covers = 'ordered in ' + escapeHtml(f.year);

    const kpis = [
        ['Total Purchases', shown(peso(total)), covers],
        ['Orders', shown(orders.length.toLocaleString('en-PH')), orders.length === 1 ? 'purchase order' : 'purchase orders']
    ];

    let cards = '';
    for (let i = 0; i < kpis.length; i++) {
        const k = kpis[i];
        cards += '<div class="kpi-card">' +
        '<span class="kpi-label">' + k[0] + '</span>' +
        '<span class="kpi-value">' + escapeHtml(k[1]) + '</span>' +
        '<span class="kpi-note">' + k[2] + '</span></div>';
    }
    grid.innerHTML = cards;
}

function buildPurchaseTotalsPanel() {
    if (!document.getElementById('po-totals-table')) return;

    createDataPanel({
        key: PO_TOTALS_KEY,
        tableId: 'po-totals-table',
        columns: 4,
        pageSize: 8,
        pagerId: 'po-totals-pager',
        idField: 'po_id',
        filters: { period: 'month', month: poThisMonth(), year: poThisYear(), supplier: 'all', from: '', to: '' },
        inputs: ['po-totals-from', 'po-totals-to', 'po-totals-period', 'po-totals-month', 'po-totals-year', 'po-totals-supplier'],

        gate: {
            title: 'Total purchases not loaded',
            text: 'Press Load Data to add up this month\'s purchase orders.',
            button: 'Load Data'
        },
        empty: {
            title: 'Nothing ordered this month',
            text: 'No purchase order was raised this month. Pick another month above, or Every Year or All Time.'
        },

        load: function () {
            return apiGetPurchaseOrders();
        },

        filter: function (po, f) {
            const day = String(po.order_date).slice(0, 10);
            if (f.period === 'month' && day.slice(0, 7) !== f.month) return false;
            if (f.period === 'year' && day.slice(0, 4) !== f.year) return false;
            if (po.status === 'Cancelled') return false;
            if (f.supplier !== 'all' && String(po.supplier_id) !== String(f.supplier)) return false;
            if (f.from && day < f.from) return false;
            if (f.to && day > f.to) return false;
            return true;
        },
        sort: function (rows) {
            return rows.sort(function (a, b) {
                return String(b.order_date).localeCompare(String(a.order_date)) || (Number(b.po_id) - Number(a.po_id));
            });
        },
        onLoaded: function (rows) {
            const bought = [];
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].status !== 'Cancelled') bought.push(rows[i]);
            }
            renderPurchaseTotalsSuppliers(bought);
            renderPurchaseTotalsMonths(bought);
            renderPurchaseTotalsYears(bought);
            syncPurchaseTotalsPeriod();
        },

        renderRow: function (po, index) {
            return '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'title="Open this order" onclick="openPurchaseOrderDetail(' + po.po_id + ', true)">' +
            '<td class="cell-id">#' + po.po_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(po.supplier_name) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(po.order_date).slice(0, 10)) + '</td>' +
            '<td class="cell-num">' + peso(poOrderValue(po)) + '</td></tr>';
        }
    });

    renderPurchaseTotalsMonths([]);
    renderPurchaseTotalsYears([]);
    syncPurchaseTotalsPeriod();

    document.addEventListener('datapanel:change', function (event) {
        if (event.detail && event.detail.key === PO_TOTALS_KEY) renderPurchaseTotalsFigures();
    });
    renderPurchaseTotalsFigures();
}

function purchaseTotalsDates() {
    const from = document.getElementById('po-totals-from');
    const to = document.getElementById('po-totals-to');
    if (!from || !to) return;

    if (from.value && to.value && from.value > to.value) {
        notifyWarning('The start date is after the end date. Swap them and try again.',
            'That range runs backwards');
        return;
    }

    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    panel.filters.from = from.value;
    panel.filters.to = to.value;

    panel.filters.period = 'custom';
    syncPurchaseTotalsPeriod();
    panel.page = 1;
    if (panel.state === 'ready') panel.apply();
    else if (panel.state === 'closed' || panel.state === 'error') panel.open();
}

function poQuantityText(item) {
    const unit = item.unit_name || '';
    if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
        return qtyText(item.pack_count, item.pack_name) + ' (' + qtyText(item.quantity, unit) + ')';
    }
    return item.quantity + ' ' + unit;
}

async function printPurchaseOrder(poId) {
    try {
        poDocument = await apiGetPurchaseOrderDocument(poId);
    } catch (error) {
        notifyError('That order could not be opened for printing.', 'Nothing to print');
        return;
    }
    renderPurchaseOrderDocument();
    await poDocumentImagesReady();
    printPurchaseOrderNow();
}

function poDocumentImagesReady() {
    const box = document.getElementById('po-doc');
    const images = box ? Array.prototype.slice.call(box.querySelectorAll('img')) : [];
    const waits = images.map(function (image) {
        if (image.complete && image.naturalWidth > 0) return Promise.resolve();
        if (typeof image.decode === 'function') return image.decode().catch(function () {});
        return new Promise(function (resolve) {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
        });
    });
    const timeout = new Promise(function (resolve) { window.setTimeout(resolve, 2000); });
    return Promise.race([Promise.all(waits), timeout]);
}

const PO_PRINT_PAGE_STYLE_ID = 'po-print-page-style';

function printPurchaseOrderNow() {
    if (typeof finishCreditPrint === 'function') finishCreditPrint();
    document.body.classList.add('printing-po');

    const style = document.createElement('style');
    style.id = PO_PRINT_PAGE_STYLE_ID;
    style.textContent = '@media print { @page { size: A4; margin: 0; } }';
    document.head.appendChild(style);

    const title = document.title;
    if (poDocument && poDocument.order) document.title = 'Purchase Order #' + poDocument.order.po_id;

    let finished = false;
    const done = function () {
        if (finished) return;
        finished = true;
        document.body.classList.remove('printing-po');
        style.remove();
        document.title = title;
        window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    window.setTimeout(done, 1500);
}

async function openPurchaseOrderDocument(poId) {
    poShowPanel('panel-po-doc', 'Purchase Order #' + poId);

    const box = document.getElementById('po-doc');
    if (box) box.innerHTML = '<p class="panel-sub">Opening order #' + poId + '.</p>';

    try {
        poDocument = await apiGetPurchaseOrderDocument(poId);
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

    let units = 0;
    let goods = 0;
    for (let i = 0; i < items.length; i++) {
        units = units + Number(items[i].quantity || 0);
        goods = goods + Number(items[i].line_cost || 0);
    }
    const ordered = String(order.order_date || '').slice(0, 10);

    let lines = '';
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        lines += '<tr>' +
            '<td class="num">' + (index + 1) + '</td>' +
            '<td><strong>' + escapeHtml(item.product_name) + '</strong>' +
                (item.brand_name ? '<br><span class="po-doc-party-line">' +
                    escapeHtml(item.brand_name) + '</span>' : '') + '</td>' +
            '<td>' + escapeHtml(item.category_name || '--') + '</td>' +
            '<td class="num">' + escapeHtml(poQuantityText(item)) + '</td>' +
            '<td class="num">' + peso(item.unit_cost) +
                '<br><span class="po-doc-party-line">per ' +
                escapeHtml(item.unit_name || 'unit') + '</span></td>' +
            '<td class="num">' + peso(item.line_cost) + '</td>' +
        '</tr>';
    }

    box.innerHTML =
        '<div class="po-doc-actions no-print">' +
            '<button type="button" class="btn btn-accent" onclick="printPurchaseOrderNow()">Print PDF</button>' +
            '<button type="button" class="btn btn-ghost" onclick="showPurchaseOrderHistory(event)">Back to Purchase Orders</button>' +
            (poSetup.canReceive && order.status === 'Pending' && !order.supplier_response &&
             String(order.supplier_email || '').trim()
                ? '<button type="button" class="btn btn-ghost" onclick="sendPurchaseOrder(' + order.po_id + ')">' +
                  'Email to Supplier</button>'
                : '') +
        '</div>' +
        '<div class="po-doc">' +
            '<div class="po-doc-stripe"></div>' +
            '<div class="po-doc-inner">' +
                '<div class="po-doc-head">' +
                    '<div class="po-doc-shop">' +
                        '<div class="po-doc-shop-name">' + escapeHtml(shop.store_name || 'Lucelyn Hardware') + '</div>' +
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
                        '<div class="po-doc-date">' + escapeHtml(poStatusWord(poStage(order))) + '</div>' +
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
                        '<div class="po-doc-party-name">' + escapeHtml(shop.store_name || 'Lucelyn Hardware') + '</div>' +
                        '<div class="po-doc-party-line">' + escapeHtml(shop.address || '') + '</div>' +
                        '<div class="po-doc-party-line">Raised by ' +
                            escapeHtml(order.raised_by || 'Manager') + '</div>' +
                    '</div>' +
                '</div>' +

                '<table>' +
                    '<thead><tr>' +
                        '<th class="num" style="width:44px">No</th><th>Material</th><th>Category</th>' +
                        '<th class="num" style="width:150px">Quantity</th>' +
                        '<th class="num" style="width:110px">Unit price</th>' +
                        '<th class="num" style="width:120px">Amount</th>' +
                    '</tr></thead>' +
                    '<tbody>' + (lines || '<tr><td colspan="6">No lines on this order.</td></tr>') + '</tbody>' +
                    '<tfoot><tr>' +
                        '<td colspan="3">' + items.length + ' line(s) &middot; priced at the rates ' +
                            'on file for these materials; any discount is settled on the invoice</td>' +
                        '<td class="num">' + units + '</td>' +
                        '<td></td>' +
                        '<td class="num">' + peso(goods) + '</td>' +
                    '</tr></tfoot>' +
                '</table>' +

                (poDocument.supplier_link
                    ? '<div class="po-doc-answer">' +
                        '<img class="po-doc-qr" src="' + escapeHtml(poDocument.supplier_qr) + '" ' +
                            'alt="QR code to accept or decline this order">' +
                        '<div class="po-doc-answer-text">' +
                            '<div class="po-doc-answer-title">Check prices and accept online</div>' +
                            '<p>Scan the QR code with your phone\'s camera, or open the link below. Correct any price ' +
                            'that does not match yours, pick the day it ships, and accept, or tell us you cannot ' +
                            'fill it. No account needed.</p>' +
                            '<div class="po-doc-link">' + escapeHtml(poDocument.supplier_link) + '</div>' +
                        '</div>' +
                      '</div>'
                    : '') +

                '<div class="po-doc-signs">' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Prepared by</span>' +
                        escapeHtml(order.raised_by || 'Inventory Clerk') + '</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Approved by</span>' +
                        escapeHtml(order.confirmed_by || 'Manager') + '</div>' +
                    '<div class="po-doc-sign-rule"><span class="po-doc-sign-role">Received by</span>' +
                        escapeHtml(order.supplier_name) + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

async function openReceiveOrder(poId) {
    if (!poSetup.canReceive) return;
    const order = findPurchaseOrder(poId);
    if (order && !poCanRefer(order)) {
        notifyWarning('A purchase order can only be referred once the supplier has accepted it.', 'Not accepted yet');
        return;
    }

    poShowPanel('panel-po-receive', 'Receive Delivery');

    const box = document.getElementById('recv-lines');
    if (box) box.innerHTML = '<p class="panel-sub">Opening order #' + poId + '.</p>';

    recvExtraCount = 0;

    try {
        await ensurePoMaterials(false);
        const items = await apiGetPurchaseOrderItems(poId);
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

    let sheet = '';
    for (let index = 0; index < poReceiving.items.length; index++) {
        const item = poReceiving.items[index];
        sheet += '<div class="recv-line" data-recv-index="' + index + '" data-product="' + item.product_id + '">' +
            '<div>' +
                '<div class="recv-name">' + escapeHtml(item.product_name) + '</div>' +
                '<div class="recv-meta">' + escapeHtml(item.category_name || 'No category') + '</div>' +
            '</div>' +
            '<div>' +
                '<div class="recv-meta">Ordered</div>' +
                '<div class="recv-ordered">' + escapeHtml(poQuantityText(item)) + '</div>' +
            '</div>' +
            '<div>' +
                '<label class="recv-meta" for="recv-qty-' + index + '">Arrived' +
                    (recvPackOf(item) ? ' (' + escapeHtml(item.pack_name) + ')' : '') + '</label>' +
                '<input type="number" class="form-control recv-qty" id="recv-qty-' + index + '" ' +
                       'min="0" value="' + recvOrderedCount(item) + '" ' +
                       'oninput="renderReceiveVerdict(' + index + ', ' + recvOrderedCount(item) + ')">' +
            '</div>' +
            '<div>' +
                '<label class="recv-meta" for="recv-cost-' + index + '">Cost per ' +
                    escapeHtml(recvPackOf(item) ? item.pack_name : (item.unit_name || 'unit')) + '</label>' +
                '<input type="number" class="form-control recv-qty" id="recv-cost-' + index + '" ' +
                       'min="0" step="0.01" placeholder="0.00" ' +
                       'value="' + recvOrderedCost(item) + '">' +
            '</div>' +
            '<div class="recv-verdict is-exact" id="recv-verdict-' + index + '">As ordered</div>' +
        '</div>';
    }
    box.innerHTML = sheet;

    const extras = document.getElementById('recv-extras');
    if (extras) extras.innerHTML = '';
}

function receiveLineAmounts() {
    if (!poReceiving) return [];
    const amounts = [];
    for (let index = 0; index < poReceiving.items.length; index++) {
        const item = poReceiving.items[index];
        const qtyField = document.getElementById('recv-qty-' + index);
        const costField = document.getElementById('recv-cost-' + index);
        const counted = Math.max(0, parseInt(qtyField ? qtyField.value : recvOrderedCount(item), 10) || 0);
        const cost = Math.max(0, parseFloat(costField ? costField.value : 0) || 0);
        amounts.push({ counted: counted, cost: cost, amount: counted * cost });
    }
    return amounts;
}

function recvPackOf(item) {
    if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
        return { name: item.pack_name, size: Number(item.pack_size) };
    } else {
        return null;
    }
}
function recvOrderedCount(item) {
    const pack = recvPackOf(item);
    return pack ? Number(item.pack_count) : Number(item.quantity);
}

function recvOrderedCost(item) {
    const pack = recvPackOf(item);
    const unit = Number(item.unit_cost) || 0;
    if (!(unit > 0)) return '';
    return pack ? Math.round(unit * pack.size * 100) / 100 : unit;
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

    const amounts = receiveLineAmounts();
    const received = [];
    for (let i = 0; i < poReceiving.items.length; i++) {
        const item = poReceiving.items[i];
        const counted = amounts[i].counted;
        const pack = recvPackOf(item);
        received.push({
            productId: item.product_id,
            quantity: pack ? Math.round(counted * pack.size) : counted,
            unitCost: pack ? Math.round(amounts[i].cost / pack.size * 100) / 100 : amounts[i].cost
        });
    }
    const extras = document.querySelectorAll('#recv-extras .recv-line');

    for (let e = 0; e < extras.length; e++) {
        const row = extras[e];
        const index = row.id.replace('recv-extra-', '');
        const picked = matValue(row.dataset.picker);

        if (!picked.ok) {
            notifyWarning('An extra line has no material on it. Pick one, add it as new, or ' +
                'remove the line.', 'Nothing received');
            return;
        }

        if (picked.isNew && picked.unitName === '') {
            notifyWarning('"' + picked.newName + '" needs a unit before it can be added. ' +
                'Fill in its Unit, like pcs or bag.', 'Nothing received');
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

    let short = 0;
    for (let i = 0; i < received.length; i++) {
        if (i < poReceiving.items.length && received[i].quantity < poReceiving.items[i].quantity) short++;
    }

    const yes = await askConfirm(
        'The figures on this sheet go straight onto the shelf, and purchase order #' +
        poReceiving.poId + ' closes.' +
        (short > 0 ? ' ' + short + ' line(s) came up short and the order will be corrected to say so.' : ''),
        { title: 'Receive this delivery?', eyebrow: 'Purchase Orders', confirmLabel: 'Receive it' });

    if (!yes) return;

    try {
        const discount = poReceiving.order ? Number(poReceiving.order.discount) || 0 : 0;
        const response = await apiReceivePurchaseOrder(poReceiving.poId, received, discount);
        const result = await response.json();
        if (!response.ok) { if (!handleAuthFailure(response, result)) notifyError(result.error); return; }

        notifySuccess(result.message);
        poReceiving = null;
        poMaterialsLoaded = false;

        for (const key in matPickers) {
            delete matPickers[key];
        }

        showPurchaseOrderHistory();
        await refreshPurchaseOrders();
        poAfterChange();
    } catch (error) {
        notifyOffline();
    }
}

async function openPurchaseOrderDetail(poId, readOnly) {
    const po = findPurchaseOrder(poId);
    if (!po) return;

    const canDecide = poSetup.canDecide && !readOnly;
    const canReceive = poSetup.canReceive && !readOnly;

    let items = [];
    try { items = await apiGetPurchaseOrderItems(poId); } catch (error) { items = []; }

    let report = null;
    if (po.status === 'Received') {
        try { report = await apiGetPurchaseOrderReport(poId); } catch (error) { report = null; }
    }

    const waiting = po.status === 'For Approval';

    let orderedLines = Number(po.line_count) || 0;
    let orderedUnits = Number(po.total_units) || 0;
    if (items.length > 0) {
        orderedLines = items.length;
        orderedUnits = 0;
        for (let i = 0; i < items.length; i++) orderedUnits += Number(items[i].quantity) || 0;
    }

    let money;
    if (po.status === 'Received') {
        money = detailField('Goods Received', peso(po.goods_cost)) +
                detailField('Invoice Discount', peso(po.discount)) +
                detailField('Total Cost', '<strong>' + peso(po.total_cost) + '</strong>');
    } else if (Number(po.discount) > 0) {
        money = detailField('Goods', peso(po.goods_cost)) +
                detailField('Supplier Discount', peso(po.discount)) +
                detailField('Order Value', '<strong>' + peso(po.total_cost) + '</strong>');
    } else {
        money = detailField('Order Value', '<strong>' + peso(po.goods_cost) + '</strong>' +
                ' <span class="muted">before any invoice discount</span>');
    }

    const summary =
        '<div class="detail-grid">' +
        detailField('Supplier', escapeHtml(po.supplier_name)) +
        detailField('Status', poStatusBadge(po)) +
        detailField('Raised', escapeHtml(String(po.order_date).slice(0, 16)) +
            (po.raised_by ? ' <span class="muted">by ' + escapeHtml(po.raised_by) + '</span>' : '')) +
        (po.confirmed_at
            ? detailField(po.status === 'Cancelled' ? 'Declined by Manager' : 'Approved',
                escapeHtml(String(po.confirmed_at).slice(0, 16)) +
                (po.confirmed_by ? ' <span class="muted">by ' + escapeHtml(po.confirmed_by) + '</span>' : ''))
            : '') +
        (po.supplier_response
            ? detailField('Supplier ' + (po.supplier_response === 'Accepted' ? 'Accepted' : 'Declined'),
                escapeHtml(poWhen(po.supplier_responded_at)))
            : '') +
        (po.supplier_ship_date
            ? detailField('Delivery Schedule', escapeHtml(poShipDay(po.supplier_ship_date)))
            : '') +
        (po.status === 'Cancelled' && po.decision_note
            ? detailField('Manager\'s Remarks', escapeHtml(po.decision_note))
            : '') +
        (po.supplier_response === 'Declined' && po.supplier_note
            ? detailField('Supplier\'s Reason', escapeHtml(po.supplier_note))
            : '') +
        (po.status === 'Received'
            ? detailField('Received', po.received_at
                ? escapeHtml(poWhen(po.received_at))
                : '<span class="muted">Not recorded</span>')
            : '') +
        detailField('Items', orderedLines + (orderedLines === 1 ? ' line' : ' lines') +
            ' <span class="muted">' + orderedUnits + (orderedUnits === 1 ? ' unit' : ' units') + '</span>') +
        money +
        '</div>';

    let priced = false;
    for (let i = 0; i < items.length; i++) {
        if (Number(items[i].unit_cost) > 0) priced = true;
    }
    const unitCostCell = function (it) {
        if (it.unit_cost === null || it.unit_cost === undefined) return '<span class="muted">-</span>';
        const original = it.original_unit_cost;
        if (original === null || original === undefined || Number(original) === Number(it.unit_cost)) {
            return peso(it.unit_cost);
        }
        return '<s class="muted">' + peso(original) + '</s> ' + peso(it.unit_cost) +
            ' <span class="po-answer is-warn">supplier\'s price</span>';
    };
    let lines;
    const lineRows = [];
    if (priced) {
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            lineRows.push([
                escapeHtml(it.product_name), escapeHtml(poQuantityText(it)), unitCostCell(it),
                it.line_cost === null || it.line_cost === undefined ? '<span class="muted">-</span>' : peso(it.line_cost)
            ]);
        }
        lines = detailTable(['Material', 'Qty', 'Unit Cost', 'Line Cost'], lineRows, [1, 2, 3]);
    } else {
        for (let i = 0; i < items.length; i++) {
            lineRows.push([escapeHtml(items[i].product_name), escapeHtml(poQuantityText(items[i]))]);
        }
        lines = detailTable(['Material', 'Qty'], lineRows, [1]);
    }

    const contact = '<h4 class="detail-subhead">Supplier contact</h4>' +
        '<div class="detail-grid">' +
        detailField('Contact Person', escapeHtml(po.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(po.contact_number || 'Not set')) +
        detailField('Email', po.supplier_email ? escapeHtml(po.supplier_email) : '<span class="muted">None on file</span>') +
        '</div>';

    let foot = '<button type="button" class="btn btn-ghost" onclick="printPurchaseOrder(' + po.po_id + ')">' +
               (po.status === 'Pending' ? 'Print Purchase Order' : 'Print PDF') + '</button>';
    if (canDecide && waiting) {
        foot += '<button type="button" class="btn btn-danger" onclick="decidePurchaseOrder(' + po.po_id + ', false)">' +
                'Decline</button>' +
                '<button type="button" class="btn btn-success" onclick="decidePurchaseOrder(' + po.po_id + ', true)">' +
                'Approve Order</button>';
    }
    if (canReceive && po.status === 'Pending' && !po.supplier_response && po.supplier_email) {
        foot += '<button type="button" class="btn btn-ghost" onclick="sendPurchaseOrder(' + po.po_id + ')">' +
                (po.supplier_sent_at ? 'Email It Again' : 'Email to Supplier') + '</button>';
    }

    const pages = [
        { label: 'Order', body: '<div class="po-detail-layout">' +
            '<div class="po-detail-facts">' + summary + contact + '</div>' +
            '<div class="po-detail-lines"><h4 class="detail-subhead">Ordered Items</h4>' + lines + '</div>' +
          '</div>' }
    ];
    if (report && report.lines && report.lines.length > 0) {
        pages.push({ label: 'Report', body: poDeliveryReportHtml(report) });
    }
    openDetailModal('Purchase Order #' + po.po_id, po.supplier_name + ' · ' + poStatusWord(poStage(po)), 'P' + po.po_id,
        pages, foot, { wide: 'xl', scroll: true });
}

function poDeliveryReportHtml(report) {
    const rows = [];
    for (let i = 0; i < report.lines.length; i++) {
        const line = report.lines[i];
        const under = line.reason === 'Under-delivery';
        rows.push([
            escapeHtml(line.product_name),
            escapeHtml(qtyText(line.quantity, line.unit_name || '')) +
                ' <span class="muted">' + (under ? 'missing' : 'over') + '</span>',
            '<span class="badge ' + (under ? 'badge-warning' : 'badge-info') + '">' + escapeHtml(line.reason) + '</span>'
        ]);
    }

    return '<div class="po-report">' +
            '<div class="po-report-head">' +
                '<p><span class="po-report-label">Reported by:</span> ' +
                    (report.reported_by ? escapeHtml(report.reported_by) : '<span class="muted">Not recorded</span>') + '</p>' +
                '<p><span class="po-report-label">Date reported:</span> ' +
                    (report.reported_at ? escapeHtml(poWhen(report.reported_at)) : '<span class="muted">Not recorded</span>') + '</p>' +
            '</div>' +
            detailTable(['Material', 'Quantity', 'Reason'], rows, [1]) +
            '<p class="po-report-remarks"><span class="po-report-label">Remarks:</span> ' +
                (report.remarks ? escapeHtml(report.remarks) : '<span class="muted">None</span>') + '</p>' +
        '</div>';
}

async function decidePurchaseOrder(poId, approve) {
    if (!poSetup.canDecide) return;
    const po = findPurchaseOrder(poId);
    if (!po) return;

    let note = '';
    if (approve) {
        const yes = await askConfirm(
            'Order #' + po.po_id + ' to ' + po.supplier_name + ': ' + po.line_count + ' line(s), ' + po.total_units +
            ' unit(s). Once approved, the clerk prints it and sends it to the supplier, and counts the ' +
            'delivery in against it when it arrives.',
            {
                title: 'Approve this purchase order?',
                eyebrow: 'Purchase Orders',
                confirmLabel: 'Approve the order',
                detail: [
                    'The printed order carries a QR code and a link: ' + po.supplier_name +
                        ' scans it to accept or decline the order.',
                    'You are notified the moment the supplier answers.'
                ]
            });
        if (!yes) return;
    } else {
        const asked = await askInput({
            title: 'Decline this purchase order?',
            eyebrow: 'Purchase Orders',
            message: 'Order #' + po.po_id + ' to ' + po.supplier_name + ' is cancelled and the clerk is told why.',
            label: 'Remarks: why it is declined',
            placeholder: 'Say why it is declined and what the clerk should do instead',
            confirmLabel: 'Decline the order',
            tone: 'danger',
            check: function (value) {
                return String(value).trim().length < 5 ? 'Give a reason the clerk can act on.' : null;
            }
        });
        if (asked === false || asked === null) return;
        note = String(asked).trim();
    }

    try {
        const response = await apiDecidePurchaseOrder(poId, approve, note);
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }

        closeModal('detail-modal');
        notifySuccess(result.message, approve ? 'Order approved' : 'Order declined');
        await refreshPurchaseOrders();
        poAfterChange();
    } catch (error) {
        notifyOffline();
    }
}

async function sendPurchaseOrder(poId) {
    if (!poSetup.canReceive) return;
    const po = findPurchaseOrder(poId);
    if (!po || po.status !== 'Pending' || !po.supplier_email) return;

    const yes = await askConfirm(
        'Order #' + po.po_id + ' is emailed to ' + po.supplier_name + ' at ' + po.supplier_email + ', with the ' +
        'order as a PDF and the link to accept or decline it.',
        {
            title: po.supplier_sent_at ? 'Email this order again?' : 'Email this order to the supplier?',
            eyebrow: 'Purchase Orders',
            confirmLabel: 'Email it',
            detail: ['The manager is notified the moment the supplier answers.']
        });
    if (!yes) return;

    showWorking(sendingCard(po));

    try {
        const response = await apiSendPurchaseOrder(poId);
        const result = await response.json();
        if (!response.ok) {
            hideWorking();
            if (!handleAuthFailure(response, result)) notifyError(result.error, 'Not emailed');
            return;
        }

        await finishWorking('Order emailed');
        closeModal('detail-modal');
        notifySuccess(result.message, 'Order emailed');
        await refreshPurchaseOrders();
        poAfterChange();
    } catch (error) {
        hideWorking();
        notifyOffline();
    }
}

async function markPurchaseOrderSent(poId) {
    if (!poSetup.canReceive) return;
    const po = findPurchaseOrder(poId);
    if (!po || !poToSend(po)) return;

    const yes = await askConfirm(
        'Order #' + po.po_id + ' is marked as sent to ' + po.supplier_name + '. It then waits for the supplier ' +
        'to accept or decline it from the QR code or link on the order.',
        { title: 'Mark this order as sent?', eyebrow: 'Purchase Orders', confirmLabel: 'Mark as Sent' });
    if (!yes) return;

    try {
        const response = await apiMarkPurchaseOrderSent(poId);
        const result = await response.json();
        if (!response.ok) {
            if (!handleAuthFailure(response, result)) notifyError(result.error);
            return;
        }
        closeModal('detail-modal');
        notifySuccess(result.message, 'Order sent');
        await refreshPurchaseOrders();
        poAfterChange();
    } catch (error) {
        notifyOffline();
    }
}

function sendingCard(po) {
    return {
        title: 'Emailing the order',
        eyebrow: 'Purchase Orders',
        message: 'This can take a few seconds while the mail goes out. Keep this page open.',
        steps: ['Printing order #' + po.po_id + ' as a PDF',
                'Emailing it to ' + po.supplier_name + ' at ' + po.supplier_email]
    };
}

function poWhen(value) {
    return String(value || '').replace('T', ' ').slice(0, 16);
}

function poShipDay(value) {
    return String(value || '').replace('T', ' ').slice(0, 10);
}

document.addEventListener('click', function (event) {
    const active = document.activeElement;
    hideAllMatSuggestions(event.target.closest('.suggest-wrap') ||
        (active && active.closest ? active.closest('.suggest-wrap') : null));
});
