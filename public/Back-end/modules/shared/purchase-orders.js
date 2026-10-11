// purchase-orders.js -- purchase orders, shared by the manager and the clerk
// Loaded by: manager.html, inventory-dashboard.html
//
// The clerk raises an order (For Approval) and prints it; the manager confirms
// or declines it (Pending or Cancelled); once confirmed, the clerk counts the
// delivery in (Received). The server refuses each role on the other's routes. The supplier and the
// materials are typed, not picked, so an order can buy from a new company or
// a product the shop has never stocked. The company comes first: the lines
// stay shut until one is settled, and then offer only what it supplies.
//
//   configurePurchaseOrders({
//       key: 'mgr-po',                  // the history panel's data-panel key
//       canCreate: true,                // does this page have the form (the clerk's)
//       canDecide: true,                // may this page confirm or decline (the manager's)
//       canReceive: true,               // may this page count a delivery in (the clerk's)
//       showPanel: showManagerPanel,    // (panelId, title) -- the page's own
//       afterChange: () => {}           // optional; caches to drop after a write
//   });
//   buildPurchaseOrderPanel();

const poSetup = {
    key: 'po',
    canCreate: false,
    canDecide: false,
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
    loadPoSuppliers(false).then(renderSupplierRoster);
    ensurePoMaterials(false);
    if (poLineCount === 0) addPurchaseLine();
    renderSupplierState();
    renderPoTotals();
}

// the picker's own copy of the material list; neither page's can be leaned on
let poMaterials = [];
let poMaterialsLoaded = false;
let poMaterialsFailed = false;   // the list did not arrive, which is not the same as an empty one

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

// the way back from a list that did not arrive
async function matReload(id) {
    const list = document.getElementById(id + '-list');
    if (list && !list.hidden) {
        list.innerHTML = '<li class="suggest-head" role="presentation">Loading the material list...</li>';
    }
    await ensurePoMaterials(true);
    matOpen(id);
}

let poSupplier = null;          // the company on file, once one is chosen
let poSuppliers = [];
let poSuppliersLoaded = false;
let poSupplierHighlight = -1;
let poSupplierCommitted = false; // a new company's name, once the box is left
let poLinesSupplierId = null;    // the company the lines were picked under
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

// Unit, Category and Brand each offer what the material list already uses, so
// a spelling is reused rather than invented twice. Nothing is forced: a word
// that is not offered is simply a new one. Price has nothing on the list worth
// offering (another material's price says nothing about this one), so it stays
// a plain number box.
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

// every spelling the material list uses for this field, once each, the most
// used first
function makeKnownValues(field) {
    const column = MAKE_SUGGEST_COLUMN[field];
    const found = new Map();   // lower-case spelling -> { value, count }

    for (const p of poMaterials) {
        const value = String(p[column] || '').trim();
        if (value === '') continue;
        const key = value.toLowerCase();
        if (found.has(key)) {
            found.get(key).count += 1;
        } else {
            found.set(key, { value: value, count: 1 });
        }
    }

    return Array.from(found.values()).sort((a, b) =>
        (b.count - a.count) || a.value.localeCompare(b.value));
}

// An empty box offers the common ones; typed text offers the ones that start
// with it, then the ones with a word that starts with it (at most 8).
function makeSuggest(id, field) {
    const list = document.getElementById(id + '-' + field + '-list');
    const box = document.getElementById(id + '-' + field);
    if (!list || !box) return;

    // the list is normally in hand by now; if not, offer again once it arrives
    if (!poMaterialsLoaded) {
        ensurePoMaterials(false).then((ok) => {
            if (ok && document.activeElement === box) makeSuggest(id, field);
        });
    }

    const query = box.value.trim().toLowerCase();
    const known = makeKnownValues(field);

    let matches;
    if (query === '') {
        matches = known;
    } else {
        const starts = known.filter((k) => k.value.toLowerCase().startsWith(query));
        const words = known.filter((k) => !k.value.toLowerCase().startsWith(query) && startsAWord(k.value, query));
        matches = starts.concat(words);
    }
    matches = matches.slice(0, MAKE_SUGGEST_LIMIT);

    // nothing to pick when the box already holds the only thing on offer
    if (matches.length === 0 || (matches.length === 1 && matches[0].value.toLowerCase() === query)) {
        makeSuggestHide(id, field);
        return;
    }

    // one list open at a time: the others (a material's, another box's) close first
    hideAllMatSuggestions(box.closest('.suggest-wrap'));

    list.innerHTML = matches.map((m, i) =>
        '<li class="suggest-item" role="option" aria-selected="false" id="' + list.id + '-' + i + '" ' +
            'data-value="' + escapeHtml(m.value) + '" ' +
            'onclick="makeSuggestPick(\'' + id + '\', \'' + field + '\', this)">' +
            '<span class="suggest-line">' +
                '<span class="suggest-name">' + escapeHtml(m.value) + '</span>' +
                '<span class="suggest-figure">' + m.count + ' material' + (m.count === 1 ? '' : 's') + '</span>' +
            '</span>' +
        '</li>').join('');
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

// what typing or picking a word changes on the line: the description under the
// material box and, through the unit, what the line is priced per
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

    // Enter never sends the form from these boxes, open list or not
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
    items.forEach((item, i) => { if (item.classList.contains('is-active')) at = i; });

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (at === -1) {
            at = step > 0 ? 0 : items.length - 1;
        } else {
            at = (at + step + items.length) % items.length;
        }
        items.forEach((item, i) => {
            item.classList.toggle('is-active', i === at);
            item.setAttribute('aria-selected', i === at ? 'true' : 'false');
        });
        if (box) box.setAttribute('aria-activedescendant', items[at].id);
        if (items[at].scrollIntoView) items[at].scrollIntoView({ block: 'nearest' });
        return;
    }

    // Enter takes the highlighted one; with none highlighted it keeps what was
    // typed (and does not send the form)
    if (event.key === 'Enter') {
        event.preventDefault();
        if (at >= 0) items[at].click(); else makeSuggestHide(id, field);
        return;
    }

    if (event.key === 'Escape') makeSuggestHide(id, field);
}

// Opening the box shows the whole list to read down -- everything the chosen
// company supplies -- rather than waiting for a name to be guessed at.
async function matOpen(id) {
    await ensurePoMaterials(false);
    const state = matState(id);
    const box = matBox(id);
    const typed = box ? box.value.trim() : '';

    state.browseAll = typed === '' || Boolean(state.productId);
    renderMatSuggestions(id, typed);
}

// the caret: shut it if it is open, open it if it is not
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

    // typing after a choice unmakes the choice
    let chosen;
    if (state.productId) {
        chosen = poMaterials.find((p) => p.product_id === state.productId);
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

    const hide = () => {
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
        // the products whose name, category or brand starts with what was typed (at most 7)
        matches = [];
        for (const p of choices) {
            if (prefixMatch([p.product_name, p.category_name, p.brand_name], typed)) {
                matches.push(p);
            }
        }
        matches = matches.slice(0, 7);
    }

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

    // the way out of the list, unless the list is only being read down or the
    // typed name is already a material
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

// Says whose list is being read down, so an empty one reads as a fact about
// the company rather than as a box that will not work.
function matHeadHtml(id, browsing, count) {
    if (!browsing) return '';

    const line = (text) =>
        '<li class="suggest-head" role="presentation">' + escapeHtml(text) + '</li>';

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

// Closing every open list has to leave each box saying it is closed: the
// caret reads that, and a box left claiming to be open with nothing under it
// is how a working picker looks broken.
function hideAllMatSuggestions(except) {
    document.querySelectorAll('.suggest-list[id$="-list"]').forEach((list) => {
        if (except && except.contains(list)) return;   // the box just clicked keeps its list
        const id = list.id.replace(/-list$/, '');
        // a material box is "<id>-box"; the New material card's boxes carry the id itself
        const box = document.getElementById(id + '-box') || document.getElementById(id);
        if (matPickers[id]) matPickers[id].browseAll = false;
        list.hidden = true;
        list.innerHTML = '';
        if (box) {
            box.setAttribute('aria-expanded', 'false');
            box.removeAttribute('aria-activedescendant');
        }
    });
}

function matKey(id, event) {
    const list = document.getElementById(id + '-list');
    if (!list || list.hidden) {
        if (event.key === 'Enter') event.preventDefault();
        if (event.key === 'ArrowDown') { event.preventDefault(); matOpen(id); }
        return;
    }

    // leaving the box by Tab leaves its list behind otherwise
    if (event.key === 'Tab') { hideMatSuggestions(id); return; }

    const items = list.querySelectorAll('.suggest-item');
    if (items.length === 0) return;

    const state = matState(id);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        state.highlight = ((state.highlight === undefined ? -1 : state.highlight) + step + items.length) % items.length;
        items.forEach((item, i) => item.classList.toggle('is-active', i === state.highlight));
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

// An order line offers only what the chosen company supplies; a new company
// supplies nothing yet, so every line on it is a new material. The receiving
// sheet is not narrowed: what arrived is what arrived.
function matIsOrderLine(id) { return String(id).indexOf('po-mat-') === 0; }

function matChoices(id) {
    if (!matIsOrderLine(id)) return poMaterials;
    if (poSupplier) return poMaterials.filter((p) => p.supplier_id === poSupplier.id);
    return [];
}

function matPick(id, productId) {
    const product = matChoices(id).find((p) => p.product_id === productId);
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

// What the material is, under the box: the facts the material list keeps on
// it, so a name taken off the list can be checked before it is ordered.
function renderMatDesc(id) {
    const box = document.getElementById(id + '-desc');
    if (!box) return;

    const hide = () => { box.hidden = true; box.innerHTML = ''; };
    const strip = (facts, price, per) =>
        '<span class="mat-desc-line">' + escapeHtml(facts.filter(Boolean).join(' \u00B7 ')) + '</span>' +
        '<span class="mat-desc-price">' + peso(price) +
            '<span class="mat-desc-per">/ ' + escapeHtml(per) + '</span></span>';

    const state = matState(id);
    let product;
    if (state.productId) {
        product = poMaterials.find((p) => p.product_id === state.productId);
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

    // a material being added: what was typed into the card above it
    const make = document.getElementById(id + '-make');
    if (!make || make.hidden || state.newName === '') { hide(); return; }

    const field = (suffix) => {
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
        const product = poMaterials.find((p) => p.product_id === state.productId);
        box.className = 'pick-verdict';

        if (product) {
            box.textContent = product.quantity_in_stock + ' ' + (product.unit_name || 'on hand') +
                  ' on the shelf now.';
        } else {
            box.textContent = '';
        }

        return;
    }

    // the New material card right under the line says this already
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
    poSupplierCommitted = false;      // still being typed

    // a name typed out in full is the same answer as one taken from the list;
    // the server matches it anyway
    if (!poSupplier && typed !== '') {
        poSupplier = poSuppliers.find((s) =>
            String(s.name).toLowerCase() === typed.toLowerCase()) || null;
    }

    renderSupplierSuggestions(typed);
    renderSupplierState();
}

// leaving the box with a name in it settles the company, known or new
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

    const hide = () => {
        list.hidden = true;
        list.innerHTML = '';
        if (box) box.setAttribute('aria-expanded', 'false');
    };

    if (searchText(query) === '') { hide(); return; }

    const matches = poSuppliers.filter((s) => startsAWord(s.name, query)).slice(0, 6);

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
    poSupplierCommitted = true;

    const box = document.getElementById('po-supplier');
    if (box && poSupplier) box.value = poSupplier.name;

    const list = document.getElementById('po-supplier-list');
    if (list) { list.hidden = true; list.innerHTML = ''; }

    renderSupplierState();
}

// the company is settled once one on file is chosen, or a new name is typed
// and the box left
// only a company already on file: a new supplier is the manager's to add
function poSupplierSettled() {
    return Boolean(poSupplier);
}

// The lines follow the company. Shut until one is settled; and when the
// company changes under lines that already name its materials, those lines
// go, because they belong to the other company.
function renderPoLinesGate() {
    const lines = document.getElementById('po-lines');
    const lock = document.getElementById('po-lines-lock');
    const add = document.getElementById('po-add-line');
    if (!lines) return;

    const open = poSupplierSettled();
    const supplierId = poSupplier ? poSupplier.id : null;

    if (open && supplierId !== poLinesSupplierId) {
        // has any line already got a material picked?
        let picked = false;
        for (const row of document.querySelectorAll('.po-line')) {
            if (matState(row.dataset.picker).productId) {
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
    Object.keys(matPickers).forEach((key) => { if (matIsOrderLine(key)) delete matPickers[key]; });

    const lines = document.getElementById('po-lines');
    if (lines) lines.innerHTML = '';
    poLineCount = 0;
    addPurchaseLine();
}

// The roster beside the form: every company on file, one click to order
// from it. Narrowed by the box above it; the chosen one is marked.
function renderSupplierRoster() {
    const list = document.getElementById('po-roster-list');
    const count = document.getElementById('po-roster-count');
    if (!list) return;

    const filter = document.getElementById('po-roster-filter');
    const query = searchText(filter ? filter.value : '');

    if (!poSuppliersLoaded) {
        list.innerHTML = '<li class="po-roster-empty">The list could not be loaded.</li>';
        if (count) count.textContent = 'Offline';
        return;
    }

    // the suppliers that match the search, sorted A to Z
    const rows = [];
    for (const s of poSuppliers) {
        if (prefixMatch([s.name, s.contact_person], query)) {
            rows.push(s);
        }
    }
    rows.sort(function (a, b) {
        // numeric: true sorts "Supplier 2" before "Supplier 10"
        return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    });

    if (count) count.textContent = poSuppliers.length + (poSuppliers.length === 1 ? ' company' : ' companies');

    if (rows.length === 0) {
        list.innerHTML = '<li class="po-roster-empty">' +
            (poSuppliers.length === 0 ? 'No suppliers on file yet.' : 'No company matches that.') + '</li>';
        return;
    }

    list.innerHTML = rows.map((s) => {
        const active = poSupplier && poSupplier.id === s.id;
        return '<li class="po-roster-item' + (active ? ' is-active' : '') + '" role="button" tabindex="0" ' +
                'onclick="chooseSupplierFromRoster(' + s.id + ')" ' +
                'onkeydown="if (event.key === \'Enter\' || event.key === \' \') { event.preventDefault(); chooseSupplierFromRoster(' + s.id + '); }">' +
            '<span class="po-roster-line">' +
                '<span class="po-roster-name">' + escapeHtml(s.name) + '</span>' +
                '<span class="po-roster-figure">' + s.product_count + ' material' +
                    (Number(s.product_count) === 1 ? '' : 's') + '</span>' +
            '</span>' +
            '<span class="po-roster-sub">' + escapeHtml(s.contact_person || 'No contact on file') +
                (s.contact_number ? ' · ' + escapeHtml(s.contact_number) : '') + '</span>' +
        '</li>';
    }).join('');
}

function chooseSupplierFromRoster(supplierId) {
    pickSupplier(supplierId);
    const first = document.querySelector('.po-line .form-control');
    if (first) first.focus();
}

// nothing typed, a known company, or a new one
function renderSupplierState() {
    const box = document.getElementById('po-supplier');
    const known = document.getElementById('po-supplier-known');
    const card = document.getElementById('po-supplier-new');
    if (!box) return;

    const typed = box.value.trim();
    renderSupplierRoster();

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

// ==========================================
// THE ORDER LINES
// ==========================================
// A new line goes on top, right under the Add button, so the clerk never scrolls
// past the lines already filled in. "Line N" counts in the order they were
// added (the newest, on top, has the highest number) and the order is sent
// oldest first: poLineRows() is the one place that order is read.
// fromButton: pressed by the clerk, which the shut lines refuse
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

    // one card per line: "Line 1" and Remove across the top, then the material,
    // how many, the price on file and what the line comes to, in one row
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
                   'placeholder="—" title="The price on file for this material. It is not typed on the order.">' +
            '<p class="pick-verdict po-line-amount" id="po-line-amount-' + index + '"></p></div>' +
            '<div class="form-group"><label for="po-line-total-' + index + '">Line total</label>' +
            '<input type="text" class="form-control po-cost po-line-total" id="po-line-total-' + index + '" ' +
                   'readonly tabindex="-1" placeholder="—"></div>' +
        '</div>';

    box.insertBefore(row, box.firstChild);
    renderPoTotals();

    // pressed by the clerk: straight into the new line's material box
    if (fromButton) {
        const field = matBox(pickerId);
        if (field) field.focus();
    }
}

// the lines as they were added, oldest first (the page shows them newest first)
function poLineRows() {
    return Array.from(document.querySelectorAll('.po-line')).reverse();
}

// A material delivered in a pack (a box of 20 kilogram) is ordered in that
// pack: the line offers the pack and the unit, and starts on the pack. What
// is sent to the server is always in the unit; the pack rides along so the
// printed order reads "20 box".
function poLinePack(row) {
    const state = matState(row.dataset.picker);
    const product = state.productId ? poMaterials.find((p) => p.product_id === state.productId) : null;
    if (!product || !product.pack_name || !(Number(product.pack_size) > 0)) return null;
    return { name: product.pack_name, size: Number(product.pack_size), unit: product.unit_name || 'unit' };
}

// The price the line is ordered at. A material on the list carries the price
// the shop has on file for it, and a material being added carries the one
// typed into its card; neither is typed onto the order itself. A line ordered
// in packs is priced by the pack, which is the unit price times what it holds.
function poLinePricing(row) {
    const id = row.dataset.picker;
    const state = matState(id);
    const pack = poLineIn(row);
    let product;
    if (state.productId) {
        product = poMaterials.find((p) => p.product_id === state.productId);
    } else {
        product = null;
    }

    const make = document.getElementById(id + '-make');
    const isNew = Boolean(make) && !make.hidden && state.newName !== '';
    const field = (suffix) => {
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

    if (document.querySelectorAll('.po-line').length === 1) {
        notifyWarning('A purchase order needs at least one line.', 'Cannot remove');
        return;
    }

    delete matPickers[row.dataset.picker];
    row.remove();
    renderPoTotals();
}

// Priced as it is built, off the prices on file rather than off anything
// typed here; harmless on a page without the form. This also keeps the line
// count and, on a line ordered in packs, says what the packs come to.
function renderPoTotals() {
    let goods = 0;
    let priced = 0;

    poLineRows().forEach((row, position) => {
        const index = row.id.replace('po-line-', '');
        const qty = parseInt(row.querySelector('.po-qty').value, 10) || 0;
        const pack = poLineIn(row);
        const price = poLinePricing(row);
        const amount = qty > 0 ? qty * price.perPrice : 0;
        if (price.chosen) { goods += amount; priced += 1; }

        // numbered as they were added, as they stand: removing line 2 of 3 leaves lines 1 and 2
        const title = document.getElementById('po-line-title-' + index);
        if (title) title.textContent = 'Line ' + (position + 1);

        const qtyLabel = document.getElementById('po-qty-label-' + index);
        if (qtyLabel) qtyLabel.textContent = pack ? 'Quantity (' + pack.name + ')' : 'Quantity';

        const note = document.getElementById('po-line-note-' + index);
        if (note) note.textContent = pack && qty > 0 ? '= ' + qtyText(qty * pack.size, pack.unit) : '';

        // "Unit price" normally; a line ordered in packs is priced by the pack
        const priceLabel = document.getElementById('po-price-label-' + index);
        if (priceLabel) priceLabel.textContent = pack ? 'Price per ' + pack.name : 'Unit price';

        const priceField = document.getElementById('po-price-' + index);
        if (priceField) priceField.value = price.chosen ? peso(price.perPrice) : '';

        const unpriced = price.chosen && !(price.perPrice > 0);
        const totalField = document.getElementById('po-line-total-' + index);
        if (totalField) totalField.value = price.chosen && !unpriced ? peso(amount) : '';

        // only a line that cannot be priced says anything under the price
        const amountBox = document.getElementById('po-line-amount-' + index);
        if (amountBox) {
            amountBox.className = 'pick-verdict po-line-amount' + (unpriced ? ' is-stop' : '');
            amountBox.textContent = unpriced ? 'No price on file for this one.' : '';
        }
    });

    const count = document.getElementById('po-line-count');
    if (count) {
        const lines = document.querySelectorAll('.po-line').length;
        count.textContent = lines + (lines === 1 ? ' line' : ' lines');
    }

    // nothing named yet is nothing to total
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

    // a new company's number must be a Philippine mobile; letters and symbols
    // never reach the box (onPhoneInput), and a short or foreign number is refused here
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

    for (const row of rows) {
        const picked = matValue(row.dataset.picker);

        // a material picked under another company cannot be on this order
        if (picked.ok && !picked.isNew &&
            !matChoices(row.dataset.picker).some((p) => p.product_id === picked.productId)) {
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

        // ordered in packs: the unit figure goes to the server, the pack is
        // remembered. The cost is the price on file, per unit, so the order is
        // priced before the company ever sees it.
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

    const detail = (id) => {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    };

    try {
        const response = await apiCreatePurchaseOrder({
                supplierId: poSupplier ? poSupplier.id : null,
                supplierName: company,
                contactPerson: detail('po-supplier-contact'),
                // the box is hidden for a company on file, so nothing left in it is sent
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
        loadPoSuppliers(true).then(renderSupplierRoster);
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
    poSupplierCommitted = false;
    poLinesSupplierId = null;

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

// The history. A row opens the order's card, where the lines are reviewed and
// the order is confirmed, declined, printed or counted in; an order that is
// accepted or on its way also has a Refer to PO button that opens the receive
// sheet. The words below are the ones the Status filter offers, and every
// badge and heading for an order uses the same. They are stages, not the
// database's status: the database says Pending from the manager's approval
// until the delivery is counted in, and the supplier's answer and ship date
// split that into the four middle stages.
const PO_STATES = [
    { status: 'For Approval', label: 'Waiting for confirmation' },
    { status: 'Pending',      label: 'Waiting for delivery' },
    { status: 'PO Accepted',  label: 'PO Accepted' },
    { status: 'On the way',   label: 'On the way' },
    { status: 'Received',     label: 'Received' },
    { status: 'Cancelled',    label: 'Cancelled' }
];

// the stage an order is in now: an approved order the supplier has accepted is
// PO Accepted, and On the way from the day the supplier said it ships (no ship
// date given: it stays PO Accepted). A declined or unanswered order stays Pending.
function poStage(po) {
    if (po.status !== 'Pending' || po.supplier_response !== 'Accepted') return po.status;

    const ships = String(po.supplier_ship_date || '').slice(0, 10);
    if (ships && ships <= todayDateValue()) return 'On the way';
    return 'PO Accepted';
}

// the goods are due at the store: the clerk checks them against the order
function poCanRefer(po) {
    const stage = poStage(po);
    return stage === 'PO Accepted' || stage === 'On the way';
}

function poStatusWord(stage) {
    const state = PO_STATES.find((s) => s.status === stage);
    return state ? state.label : statusWord(stage);
}

function poStatusBadge(po) {
    const stage = poStage(po);
    return statusBadge(stage, poStatusWord(stage));
}

// the orders this page has to act on sort first; newest first after that
function poNeedsMe(po) {
    return (poSetup.canDecide && po.status === 'For Approval') ||
           (poSetup.canReceive && po.status === 'Pending');
}

function sortPurchaseOrders(rows) {
    return rows.sort((a, b) =>
        (Number(poNeedsMe(b)) - Number(poNeedsMe(a))) ||
        String(b.order_date).localeCompare(String(a.order_date)) ||
        (Number(b.po_id) - Number(a.po_id)));
}

// the figure an order is worth: the invoice once received, the priced lines
// before (the card says so); a cancelled order's is greyed
function poValueCell(po) {
    if (po.status === 'Received') return peso(po.total_cost);
    if (po.status === 'Cancelled') return '<span class="muted">' + peso(po.goods_cost) + '</span>';
    return peso(po.goods_cost);
}

// an approved order the supplier has not answered and was not emailed is
// still to be printed and sent; after that it waits to be counted in
function poToSend(po) {
    return po.status === 'Pending' && !po.supplier_response && !po.supplier_sent_at;
}

// the status cell: the badge, and for the clerk a Refer to PO button on an
// order whose goods are due. The click stays on the button, so the row does
// not also open the order's card.
function poStatusCell(po) {
    if (!(poSetup.canReceive && poCanRefer(po))) return poStatusBadge(po);

    return '<span class="po-status-cell">' + poStatusBadge(po) +
        '<button type="button" class="btn btn-ghost btn-sm" title="Check the delivery against this order" ' +
        'onclick="event.stopPropagation(); openReceiveOrder(' + po.po_id + ')">Refer to PO</button></span>';
}

function poRowTitle(po) {
    if (poSetup.canReceive && poToSend(po)) return 'Print this order and send it to the supplier';
    if (poSetup.canDecide && po.status === 'For Approval') return 'Review this order';
    return 'Open this order';
}

// the status counts over the table; each one filters the table to itself
function renderPurchaseOrderLegend(rows) {
    const legend = document.getElementById('po-legend');
    if (!legend) return;

    legend.innerHTML = PO_STATES.map((state) => {
        const count = rows.filter((po) => poStage(po) === state.status).length;
        if (count === 0) return '';

        const mine = (poSetup.canDecide && state.status === 'For Approval') ||
                     (poSetup.canReceive && ['Pending', 'PO Accepted', 'On the way'].indexOf(state.status) !== -1);
        return '<button type="button" class="track-chip' + (mine ? ' track-chip-alert' : '') + '" data-state="' + state.status + '" ' +
            'onclick="filterPurchaseOrdersBy(\'' + state.status + '\')">' +
            '<span class="track-count">' + count + '</span>' + escapeHtml(state.label) + '</button>';
    }).join('');
}

function filterPurchaseOrdersBy(status) {
    const select = document.getElementById('po-status');
    if (select) select.value = status;
    // setting a value from here fires no change event, so the Status column
    // is shown or hidden the way the dropdown would have
    syncFilteredColumns('po-table');
    dataPanelFilter(poSetup.key, 'status', status);
}

function buildPurchaseOrderPanel() {
    createDataPanel({
        key: poSetup.key,
        tableId: 'po-table',
        columns: 6,
        pagerId: 'po-pager',
        idField: 'po_id',
        filters: { status: 'all' },

        gate: {
            title: 'No purchase orders loaded',
            text: poSetup.gateText,
            button: 'Load Data'
        },

        load: () => apiGetPurchaseOrders(),

        match: (po, query) => prefixMatch([po.supplier_name, po.po_id, '#' + po.po_id], query),
        filter: (po, filters) => filters.status === 'all' || poStage(po) === filters.status,
        sort: (rows) => sortPurchaseOrders(rows),
        onLoaded: (rows) => renderPurchaseOrderLegend(rows),

        renderRow: (po, index) =>
            '<tr class="row-clickable row-reveal' + (poNeedsMe(po) ? ' row-attention' : '') + '" ' +
                'style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'title="' + poRowTitle(po) + '" ' +
                'onclick="openPurchaseOrderDetail(' + po.po_id + ')">' +
            '<td class="cell-id">#' + po.po_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(po.supplier_name) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(po.order_date).slice(0, 10)) + '</td>' +
            '<td class="cell-num">' + po.line_count + '</td>' +
            '<td class="cell-num">' + poValueCell(po) + '</td>' +
            '<td>' + poStatusCell(po) + '</td></tr>'
    });
}

function purchaseOrderPanel() { return getDataPanel(poSetup.key); }

// an order opened from Total Purchases may not be on the history's loaded rows
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

// ---------- total purchases ----------
// What the shop has spent on orders, one month at a time (this month when it
// opens), narrowed further by supplier, or by two dates instead of a month.
// A cancelled order was never bought, so it is never listed or counted; the
// order's status is not shown here. The figures add up what the table lists.
const PO_TOTALS_KEY = 'po-totals';

// this month as the order dates write it: "2026-09"
function poThisMonth() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

// "2026-09" -> "September 2026"
function poMonthLabel(month) {
    const parts = String(month).split('-');
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return date.toLocaleString('en-PH', { month: 'long', year: 'numeric' });
}

// an order's worth, as the history shows it: the invoice once received,
// the priced lines before
function poOrderValue(po) {
    return Number(po.status === 'Received' ? po.total_cost : po.goods_cost) || 0;
}

function purchaseTotalsFilter(name, value) {
    dataPanelFilter(PO_TOTALS_KEY, name, value);
}

// the supplier list is whoever appears on the loaded orders
function renderPurchaseTotalsSuppliers(rows) {
    const select = document.getElementById('po-totals-supplier');
    if (!select) return;

    const names = new Map();
    rows.forEach((po) => names.set(String(po.supplier_id), po.supplier_name));
    const sorted = Array.from(names.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

    const current = select.value;
    select.innerHTML = '<option value="all">Every supplier</option>' +
        sorted.map((entry) => '<option value="' + escapeHtml(entry[0]) + '">' +
            escapeHtml(entry[1]) + '</option>').join('');
    select.value = names.has(current) ? current : 'all';
}

// every month that has an order, newest first, and this month even when it
// has none; each says how many orders it holds. This month is the one Clear
// goes back to.
function renderPurchaseTotalsMonths(rows) {
    const select = document.getElementById('po-totals-month');
    if (!select) return;

    const counts = new Map();
    counts.set(poThisMonth(), 0);
    rows.forEach((po) => {
        const month = String(po.order_date).slice(0, 7);
        counts.set(month, (counts.get(month) || 0) + 1);
    });
    const months = Array.from(counts.keys()).sort().reverse();

    const panel = getDataPanel(PO_TOTALS_KEY);
    const current = panel ? panel.filters.month : poThisMonth();

    select.innerHTML = '<option value="all">Every month</option>' +
        months.map((month) => {
            const count = counts.get(month);
            return '<option value="' + month + '"' + (month === poThisMonth() ? ' selected' : '') + '>' +
                escapeHtml(poMonthLabel(month)) + ' (' + count + (count === 1 ? ' order' : ' orders') + ')</option>';
        }).join('');
    select.value = counts.has(current) ? current : 'all';
}

// Show All Purchases: every month and every supplier, no dates, cancelled
// orders still left out (they were never bought); loads the list if needed
function purchaseTotalsShowAll() {
    const boxes = {
        'po-totals-from': '', 'po-totals-to': '',
        'po-totals-month': 'all', 'po-totals-supplier': 'all'
    };
    Object.keys(boxes).forEach((id) => {
        const box = document.getElementById(id);
        if (box) box.value = boxes[id];
    });

    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    Object.assign(panel.filters, { month: 'all', supplier: 'all', from: '', to: '' });
    panel.page = 1;
    if (panel.state === 'ready') panel.apply();
    else if (panel.state !== 'loading') panel.open();   // a load already running applies these when it lands
}

// a month replaces any dates typed, and the dates replace the month
function purchaseTotalsMonth(value) {
    ['po-totals-from', 'po-totals-to'].forEach((id) => {
        const box = document.getElementById(id);
        if (box) box.value = '';
    });

    const panel = getDataPanel(PO_TOTALS_KEY);
    if (!panel) return;
    panel.filters.from = '';
    panel.filters.to = '';
    dataPanelFilter(PO_TOTALS_KEY, 'month', value);
}

function renderPurchaseTotalsFigures() {
    const grid = document.getElementById('po-totals-kpis');
    if (!grid) return;

    // the cards stay while nothing is loaded, showing a dash, so the table
    // under them does not jump when the figures arrive
    const panel = getDataPanel(PO_TOTALS_KEY);
    const ready = panel && panel.state === 'ready';
    const orders = ready ? panel.visible : [];
    const total = orders.reduce((sum, po) => sum + poOrderValue(po), 0);
    const units = orders.reduce((sum, po) => sum + (Number(po.total_units) || 0), 0);
    const average = orders.length === 0 ? 0 : total / orders.length;
    const shown = (text) => ready ? text : '—';

    const month = panel ? panel.filters.month : null;
    const covers = (month && month !== 'all')
        ? 'ordered in ' + escapeHtml(poMonthLabel(month))
        : 'the orders the filters leave in';

    const kpis = [
        ['Total Purchases', shown(peso(total)), covers],
        ['Orders', shown(orders.length.toLocaleString('en-PH')), orders.length === 1 ? 'purchase order' : 'purchase orders'],
        ['Units Ordered', shown(units.toLocaleString('en-PH')), 'across every line'],
        ['Average Order', shown(peso(average)), 'per purchase order']
    ];

    grid.innerHTML = kpis.map((k) =>
        '<div class="kpi-card">' +
        '<span class="kpi-label">' + k[0] + '</span>' +
        '<span class="kpi-value">' + escapeHtml(k[1]) + '</span>' +
        '<span class="kpi-note">' + k[2] + '</span></div>'
    ).join('');
}

function buildPurchaseTotalsPanel() {
    if (!document.getElementById('po-totals-table')) return;

    createDataPanel({
        key: PO_TOTALS_KEY,
        tableId: 'po-totals-table',
        columns: 4,             // PO, supplier, date, value; the rest is on the order's card
        pageSize: 8,            // the manager's Reports tab: eight a page, like the other reports
        pagerId: 'po-totals-pager',
        idField: 'po_id',
        filters: { month: poThisMonth(), supplier: 'all', from: '', to: '' },
        inputs: ['po-totals-from', 'po-totals-to', 'po-totals-month', 'po-totals-supplier'],

        gate: {
            title: 'Total purchases not loaded',
            text: 'Press Load Data to add up this month\'s purchase orders.',
            button: 'Load Data'
        },
        // shown when the default month (this one) holds nothing
        empty: {
            title: 'Nothing ordered this month',
            text: 'No purchase order was raised this month. Pick another month above, or Every month.'
        },

        load: () => apiGetPurchaseOrders(),

        filter: (po, f) => {
            const day = String(po.order_date).slice(0, 10);
            if (f.month && f.month !== 'all' && day.slice(0, 7) !== f.month) return false;
            if (po.status === 'Cancelled') return false;
            if (f.supplier !== 'all' && String(po.supplier_id) !== String(f.supplier)) return false;
            if (f.from && day < f.from) return false;
            if (f.to && day > f.to) return false;
            return true;
        },
        sort: (rows) => rows.sort((a, b) =>
            String(b.order_date).localeCompare(String(a.order_date)) || (Number(b.po_id) - Number(a.po_id))),
        // the month and supplier lists count only what the report can list
        onLoaded: (rows) => {
            const bought = rows.filter((po) => po.status !== 'Cancelled');
            renderPurchaseTotalsSuppliers(bought);
            renderPurchaseTotalsMonths(bought);
        },

        renderRow: (po, index) =>
            '<tr class="row-clickable row-reveal" style="animation-delay:' + (index % 10) * 28 + 'ms" ' +
                'title="Open this order" onclick="openPurchaseOrderDetail(' + po.po_id + ')">' +
            '<td class="cell-id">#' + po.po_id + '</td>' +
            '<td class="cell-name">' + escapeHtml(po.supplier_name) + '</td>' +
            '<td class="cell-id">' + escapeHtml(String(po.order_date).slice(0, 10)) + '</td>' +
            '<td class="cell-num">' + peso(poOrderValue(po)) + '</td></tr>'
    });

    // before anything loads, the Month box already names this month
    renderPurchaseTotalsMonths([]);

    // the figures follow the table: every load, filter and Clear redraws them
    document.addEventListener('datapanel:change', (event) => {
        if (event.detail && event.detail.key === PO_TOTALS_KEY) renderPurchaseTotalsFigures();
    });
    renderPurchaseTotalsFigures();
}

// both dates are checked together, so a range that runs backwards is caught
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

    // dates typed stand in for the month
    if (from.value || to.value) {
        panel.filters.month = 'all';
        const month = document.getElementById('po-totals-month');
        if (month) month.value = 'all';
    }
    panel.page = 1;
    if (panel.state === 'ready') panel.apply();
    else if (panel.state === 'closed' || panel.state === 'error') panel.open();
}

// "20 box (400 kilogram)" for a line ordered in packs; "400 kilogram" otherwise
function poQuantityText(item) {
    const unit = item.unit_name || '';
    if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
        return qtyText(item.pack_count, item.pack_name) + ' (' + qtyText(item.quantity, unit) + ')';
    }
    return item.quantity + ' ' + unit;
}

// Print PDF on an order's card: the order is laid out as its document and
// the print dialogue opens at once (save as PDF, or print), without leaving
// the card or the list behind it.
async function printPurchaseOrder(poId) {
    try {
        poDocument = await apiGetPurchaseOrderDocument(poId);
    } catch (error) {
        notifyError('That order could not be opened for printing.', 'Nothing to print');
        return;
    }
    renderPurchaseOrderDocument();
    printPurchaseOrderNow();
}

// only the order's document reaches the paper (purchase-orders.css)
function printPurchaseOrderNow() {
    document.body.classList.add('printing-po');
    const done = () => {
        document.body.classList.remove('printing-po');
        window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
    window.setTimeout(done, 1500);
}

// The order as a printable document for a supplier with no login.
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

    // add up the quantities and the costs of all the lines
    let units = 0;
    let goods = 0;
    for (const item of items) {
        units = units + Number(item.quantity || 0);
        goods = goods + Number(item.line_cost || 0);
    }
    const ordered = String(order.order_date || '').slice(0, 10);

    const lines = items.map((item, index) =>
        '<tr>' +
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
        '</tr>').join('');

    box.innerHTML =
        '<div class="po-doc-actions no-print">' +
            '<button type="button" class="btn btn-accent" onclick="printPurchaseOrderNow()">Print PDF</button>' +
            '<button type="button" class="btn btn-ghost" onclick="showPurchaseOrderHistory(event)">Back to Purchase Orders</button>' +
            (poSetup.canReceive && order.status === 'Pending' && !order.supplier_response &&
             String(order.supplier_email || '').trim()
                ? '<button type="button" class="btn btn-ghost" onclick="sendPurchaseOrder(' + order.po_id + ')">' +
                  'Email to Supplier</button>'
                : '') +
            (poSetup.canReceive && order.status === 'Pending'
                ? '<button type="button" class="btn btn-success" ' +
                  'onclick="openReceiveOrder(' + order.po_id + ')">' +
                  (poCanRefer(order) ? 'Refer to PO' : 'Receive this delivery') + '</button>'
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

                // the supplier answers the approved order from this QR code or link
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

    box.innerHTML = poReceiving.items.map((item, index) =>
        '<div class="recv-line" data-recv-index="' + index + '" data-product="' + item.product_id + '">' +
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
        '</div>').join('');

    const extras = document.getElementById('recv-extras');
    if (extras) extras.innerHTML = '';
}

// What each line counted in and at what cost. A cost is per pack on a line
// ordered in packs, per unit otherwise.
function receiveLineAmounts() {
    if (!poReceiving) return [];
    return poReceiving.items.map((item, index) => {
        const qtyField = document.getElementById('recv-qty-' + index);
        const costField = document.getElementById('recv-cost-' + index);
        const counted = Math.max(0, parseInt(qtyField ? qtyField.value : recvOrderedCount(item), 10) || 0);
        const cost = Math.max(0, parseFloat(costField ? costField.value : 0) || 0);
        return { counted: counted, cost: cost, amount: counted * cost };
    });
}

// a line ordered in packs is counted in at the door in packs
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

// what the line was ordered at, per pack where it was ordered in packs; the
// invoice still wins, so this is only what the sheet opens on
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

    const amounts = receiveLineAmounts();
    const received = poReceiving.items.map((item, index) => {
        const counted = amounts[index].counted;
        const pack = recvPackOf(item);
        return {
            productId: item.product_id,
            // packs at the door become the unit on the shelf, and a cost per pack a cost per unit
            quantity: pack ? Math.round(counted * pack.size) : counted,
            unitCost: pack ? Math.round(amounts[index].cost / pack.size * 100) / 100 : amounts[index].cost
        };
    });
    const extras = document.querySelectorAll('#recv-extras .recv-line');

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

    const short = received.filter((line, i) =>
        i < poReceiving.items.length && line.quantity < poReceiving.items[i].quantity).length;

    const yes = await askConfirm(
        'The figures on this sheet go straight onto the shelf, and purchase order #' +
        poReceiving.poId + ' closes.' +
        (short > 0 ? ' ' + short + ' line(s) came up short and the order will be corrected to say so.' : ''),
        { title: 'Receive this delivery?', eyebrow: 'Purchase Orders', confirmLabel: 'Receive it' });

    if (!yes) return;

    try {
        // the discount the supplier gave from the order's link stays on the invoice
        const discount = poReceiving.order ? Number(poReceiving.order.discount) || 0 : 0;
        const response = await apiReceivePurchaseOrder(poReceiving.poId, received, discount);
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
    try { items = await apiGetPurchaseOrderItems(poId); } catch (error) { items = []; }

    const waiting = po.status === 'For Approval';

    // what happens next, in one line over the facts. Once the manager approves
    // an order, the clerk prints it and sends it to the supplier; the printed
    // order carries a QR code the supplier accepts or declines it with.
    let note = '';
    if (waiting && poSetup.canDecide) {
        note = '<p class="detail-note detail-warn po-next">Waiting for your decision. Approved, the clerk prints ' +
               'it and sends it to the supplier, whose copy carries a QR code to accept or decline it; declined, ' +
               'it is cancelled and the clerk is told why.</p>';
    } else if (waiting) {
        note = '<p class="detail-note po-next">Waiting for the manager to approve it. Once approved, print it ' +
               'and send it to the supplier.</p>';
    } else if (po.status === 'Pending' && po.supplier_response === 'Declined') {
        // the supplier said no from the link on the order: the delivery is not coming
        note = '<p class="detail-note detail-warn po-next">' + escapeHtml(po.supplier_name) +
               ' cannot fill this order' + (po.supplier_note ? ': ' + escapeHtml(po.supplier_note) : '.') +
               ' Order the materials from another supplier.</p>';
    } else if (po.status === 'Pending') {
        let byWhom = '';
        if (po.confirmed_by) {
            byWhom = ' by ' + escapeHtml(po.confirmed_by);
        }
        let emailed = '';
        if (po.supplier_sent_at) {
            emailed = ' Emailed to the supplier on ' + escapeHtml(poWhen(po.supplier_sent_at)) + '.';
        }

        let next;
        if (po.supplier_response === 'Accepted') {
            next = ' ' + escapeHtml(po.supplier_name) + ' accepted it' +
                   (po.supplier_ship_date ? ' and ships it ' + escapeHtml(poShipDay(po.supplier_ship_date)) : '') +
                   (po.supplier_note ? ' (' + escapeHtml(po.supplier_note) + ')' : '') + '. ' +
                   (poSetup.canReceive
                       ? 'Once the goods are at the store, press Refer to PO to check them against the order ' +
                         'and count them in.'
                       : 'The clerk receives it once the goods have been checked against it.');
        } else if (poSetup.canReceive) {
            next = ' Print it and send it to the supplier: the printed order carries a QR code for them to ' +
                   'accept or decline it.' + emailed + ' Count it in once the goods arrive.';
        } else {
            next = ' The clerk prints it and sends it to the supplier; you are told when the supplier answers.' +
                   emailed;
        }
        note = '<p class="detail-note po-next">Approved' + byWhom + '.' + next + '</p>';
    } else {
        let why = '';
        if (po.decision_note) {
            why = ': ' + escapeHtml(po.decision_note);
        }
        note = '<p class="detail-note po-next">This order was ' + escapeHtml(String(po.status).toLowerCase()) +
               why + '.</p>';
    }

    // the figures: the invoice once received, the priced lines before
    let money;
    if (po.status === 'Received') {
        money = detailField('Goods', peso(po.goods_cost)) +
                detailField('Invoice Discount', peso(po.discount)) +
                detailField('Total Cost', '<strong>' + peso(po.total_cost) + '</strong>');
    } else if (Number(po.discount) > 0) {
        // the supplier gave a discount when accepting it from the link
        money = detailField('Goods', peso(po.goods_cost)) +
                detailField('Supplier Discount', peso(po.discount)) +
                detailField('Order Value', '<strong>' + peso(po.total_cost) + '</strong>');
    } else {
        money = detailField('Order Value', '<strong>' + peso(po.goods_cost) + '</strong>' +
                ' <span class="muted">before any invoice discount</span>');
    }

    const summary = note +
        '<div class="detail-grid">' +
        detailField('Supplier', escapeHtml(po.supplier_name)) +
        detailField('Status', poStatusBadge(po)) +
        detailField('Raised', escapeHtml(String(po.order_date).slice(0, 16)) +
            (po.raised_by ? ' <span class="muted">by ' + escapeHtml(po.raised_by) + '</span>' : '')) +
        (po.confirmed_at
            ? detailField(po.status === 'Cancelled' ? 'Declined' : 'Approved',
                escapeHtml(String(po.confirmed_at).slice(0, 16)) +
                (po.confirmed_by ? ' <span class="muted">by ' + escapeHtml(po.confirmed_by) + '</span>' : ''))
            : '') +
        (po.supplier_response
            ? detailField('Supplier ' + (po.supplier_response === 'Accepted' ? 'Accepted' : 'Declined'),
                escapeHtml(poWhen(po.supplier_responded_at)))
            : '') +
        (po.supplier_ship_date
            ? detailField('Ships', escapeHtml(poShipDay(po.supplier_ship_date)) +
                ' <span class="muted">as the supplier said</span>')
            : '') +
        detailField('Items', po.line_count + (Number(po.line_count) === 1 ? ' line' : ' lines') +
            ' <span class="muted">' + po.total_units + (Number(po.total_units) === 1 ? ' unit' : ' units') + '</span>') +
        money +
        '</div>';

    // the lines themselves, so an order is read before it is confirmed
    const priced = items.some((item) => Number(item.unit_cost) > 0);
    // a price the supplier corrected from the link shows the shop's own struck through
    const unitCostCell = (it) => {
        const original = it.original_unit_cost;
        if (original === null || original === undefined || Number(original) === Number(it.unit_cost)) {
            return peso(it.unit_cost);
        }
        return '<s class="muted">' + peso(original) + '</s> ' + peso(it.unit_cost) +
            ' <span class="po-answer is-warn">supplier\'s price</span>';
    };
    let lines;
    if (priced) {
        lines = detailTable(['Material', 'Qty', 'Unit Cost', 'Line Cost'],
                items.map((it) => [
                    escapeHtml(it.product_name), escapeHtml(poQuantityText(it)), unitCostCell(it), peso(it.line_cost)
                ]), [1, 2, 3]);
    } else {
        lines = detailTable(['Material', 'Qty'],
                items.map((it) => [escapeHtml(it.product_name), escapeHtml(poQuantityText(it))]), [1]);
    }

    // how to reach the supplier, under the materials (the name is in the facts already)
    const contact = '<h4 class="detail-subhead">Supplier contact</h4>' +
        '<div class="detail-grid">' +
        detailField('Contact Person', escapeHtml(po.contact_person || 'Not set')) +
        detailField('Contact Number', escapeHtml(po.contact_number || 'Not set')) +
        detailField('Email', po.supplier_email ? escapeHtml(po.supplier_email) : '<span class="muted">None on file</span>') +
        '</div>';

    // the buttons sit in the popup's foot. An approved order's print carries
    // the supplier's QR code; the clerk prints it, or emails it with the same link.
    let foot = '<button type="button" class="btn btn-ghost" onclick="printPurchaseOrder(' + po.po_id + ')">' +
               (po.status === 'Pending' ? 'Print Purchase Order' : 'Print PDF') + '</button>';
    if (poSetup.canDecide && waiting) {
        foot += '<button type="button" class="btn btn-danger" onclick="decidePurchaseOrder(' + po.po_id + ', false)">' +
                'Decline</button>' +
                '<button type="button" class="btn btn-success" onclick="decidePurchaseOrder(' + po.po_id + ', true)">' +
                'Approve Order</button>';
    }
    if (poSetup.canReceive && po.status === 'Pending' && !po.supplier_response && po.supplier_email) {
        foot += '<button type="button" class="btn btn-ghost" onclick="sendPurchaseOrder(' + po.po_id + ')">' +
                (po.supplier_sent_at ? 'Email It Again' : 'Email to Supplier') + '</button>';
    }
    if (poSetup.canReceive && po.status === 'Pending') {
        foot += '<button type="button" class="btn btn-success" onclick="closeModal(\'detail-modal\'); ' +
                'openReceiveOrder(' + po.po_id + ')">' +
                (poCanRefer(po) ? 'Refer to PO' : 'Count In the Delivery') + '</button>';
    }

    // one wide page, never turned: the facts on the left, every material and
    // the supplier's contact on the right; a very long order scrolls instead
    openDetailModal('Purchase Order #' + po.po_id, po.supplier_name + ' · ' + poStatusWord(poStage(po)), 'P' + po.po_id, [
        { label: 'Order', body: '<div class="po-detail-layout">' +
            '<div class="po-detail-facts">' + summary + '</div>' +
            '<div class="po-detail-lines"><h4 class="detail-subhead">What is ordered</h4>' + lines + contact + '</div>' +
          '</div>' }
    ], foot, { wide: 'xl', scroll: true });
}

// The manager's decision. Approving asks once; declining asks for the reason,
// which is kept on the order and told to the clerk. Approving sends nothing:
// the clerk prints the order and sends it to the supplier.
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
            label: 'Why it is declined',
            placeholder: 'Say what the clerk should do instead',
            confirmLabel: 'Decline the order',
            tone: 'danger',
            check: (value) => String(value).trim().length < 5 ? 'Give a reason the clerk can act on.' : null
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

// The clerk emails an approved order to its supplier: the printed order as a
// PDF with the QR code and link to accept or decline it. Printing it and
// handing it over carries the same link.
async function sendPurchaseOrder(poId) {
    if (!poSetup.canReceive) return;
    const po = findPurchaseOrder(poId);
    // only an approved order goes to the supplier, and only to an address on file
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

    // the mail can take a few seconds, so the work card stays up until the server answers
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

function sendingCard(po) {
    return {
        title: 'Emailing the order',
        eyebrow: 'Purchase Orders',
        message: 'This can take a few seconds while the mail goes out. Keep this page open.',
        steps: ['Printing order #' + po.po_id + ' as a PDF',
                'Emailing it to ' + po.supplier_name + ' at ' + po.supplier_email]
    };
}

// "2026-10-08 15:00" from a date the server sent
function poWhen(value) {
    return String(value || '').replace('T', ' ').slice(0, 16);
}

// the day the supplier ships it: "Mon, Oct 12"
function poShipDay(value) {
    const day = new Date(String(value).slice(0, 10) + 'T00:00:00');
    if (Number.isNaN(day.getTime())) return String(value || '');
    return day.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
}

// A click closes every list but the one clicked into: two open at once is two
// answers to the same question. The box that has the focus counts as clicked
// into: a click on a list row that sends the focus to another box (a new
// material's Unit) must not close the list that box has just opened.
document.addEventListener('click', function (event) {
    const active = document.activeElement;
    hideAllMatSuggestions(event.target.closest('.suggest-wrap') ||
        (active && active.closest ? active.closest('.suggest-wrap') : null));
});
