const featuresSetup = {
    home: null,
    onApply: null
};

let heldFeatureKeys = null;
let heldFeatureList = [];

const ROLE_PAGES = {
    'Manager': 'manager.html',
    'Inventory Clerk': 'inventory-dashboard.html',
    'Cashier': 'cashier-dashboard.html',
    'Delivery Personnel': 'delivery.html'
};

const PAGE_SCREENS = {
    'manager.html': ['income', 'sales', 'reports', 'stock-reports', 'reorder-alerts', 'purchase-orders',
                     'credit', 'credit-requests', 'deliveries', 'delivery-schedule', 'records',
                     'credit-maintenance', 'loyalty-discount', 'data-terms', 'refund-policy', 'archives', 'account-management'],
    'inventory-dashboard.html': ['material-list', 'stock-adjustment', 'adjustment-history', 'reorder-points',
                                 'purchase-orders', 'returns', 'records', 'archives', 'delivery-schedule'],
    'cashier-dashboard.html': ['pos', 'deliveries', 'refunds', 'credit', 'sales-report', 'delivery-schedule'],
    'delivery.html': ['delivery-runs', 'delivery-reports', 'delivery-schedule']
};

const PAGE_TITLES = {
    'manager.html': 'Manager',
    'inventory-dashboard.html': 'Inventory',
    'cashier-dashboard.html': 'Cashier',
    'delivery.html': 'Delivery'
};

function currentPageName() {
    return window.location.pathname.split('/').pop().toLowerCase();
}

function ownPageName() {
    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    return user ? String(ROLE_PAGES[user.role_name] || '').toLowerCase() : '';
}

function isVisitingPage() {
    return document.documentElement.classList.contains('is-visiting');
}

function foreignPageFor(feature) {
    const own = ownPageName();
    if ((PAGE_SCREENS[own] || []).indexOf(feature.key) !== -1) return null;
    const hosts = feature.hosts || [];
    for (let i = 0; i < hosts.length; i++) {
        const page = ROLE_PAGES[hosts[i]];
        if (page && (PAGE_SCREENS[page] || []).indexOf(feature.key) !== -1) return page;
    }
    return null;
}

function foreignScreens() {
    const list = [];
    for (let i = 0; i < heldFeatureList.length; i++) {
        const feature = heldFeatureList[i];
        if (!feature.held) continue;
        const page = foreignPageFor(feature);
        if (page) list.push({ key: feature.key, name: feature.name, page: page });
    }
    return list;
}

function renderMoreScreens() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    let block = document.getElementById('more-screens-nav');
    const screens = isVisitingPage() ? [] : foreignScreens();
    if (screens.length === 0) {
        if (block) block.remove();
        return;
    }

    let links = '';
    for (let i = 0; i < screens.length; i++) {
        const screen = screens[i];
        const target = screen.page + '#screen=' + encodeURIComponent(screen.key);
        links += '<li><a href="' + target + '" onclick="event.preventDefault(); event.stopPropagation(); ' +
            'window.location.href = \'' + target + '\'">' +
            '<i class="icon icon-external-link nav-icon" aria-hidden="true"></i>' +
            escapeHtml(screen.name) +
            ' <span class="nav-host">' + escapeHtml(PAGE_TITLES[screen.page] || '') + '</span></a></li>';
    }

    if (!block) {
        block = document.createElement('li');
        block.id = 'more-screens-nav';
        block.setAttribute('data-sidebar-dropdown', '');
        nav.appendChild(block);
    }
    block.innerHTML =
        '<a href="#" class="nav-parent" id="more-screens-head" ' +
            'onclick="toggleSidebarMenu(\'more-screens-head\', \'more-screens-list\', event)">' +
            '<i class="icon icon-layout-grid nav-icon" aria-hidden="true"></i>More Screens ' +
            '<span class="nav-caret" aria-hidden="true"><span>&#9660;</span></span></a>' +
        '<ul id="more-screens-list" class="nav-sub" style="display: none;">' + links + '</ul>';
}

function visitingKeys() {
    const keys = [];
    const page = currentPageName();
    const screens = foreignScreens();
    for (let i = 0; i < screens.length; i++) {
        if (screens[i].page === page) keys.push(screens[i].key);
    }
    return keys;
}

function renderVisitBar() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || document.getElementById('visit-back-nav')) return;
    const item = document.createElement('li');
    item.id = 'visit-back-nav';
    item.innerHTML = '<a href="' + escapeHtml(ownPageName()) + '" onclick="event.preventDefault(); event.stopPropagation(); ' +
        'window.location.href = \'' + escapeHtml(ownPageName()) + '\'">' +
        '<i class="icon icon-arrow-left nav-icon" aria-hidden="true"></i>Back to My Dashboard</a>';
    nav.insertBefore(item, nav.firstChild);
}

function openScreenByKey(key) {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return false;
    const marks = nav.querySelectorAll('[data-feature]');
    for (let i = 0; i < marks.length; i++) {
        if (featureKeysOf(marks[i]).indexOf(key) === -1) continue;
        const item = marks[i].closest('li') || marks[i];
        if (item.hidden) continue;
        const link = marks[i].tagName === 'A' ? marks[i] : item.querySelector('a');
        if (link) {
            link.click();
            return true;
        }
    }
    return false;
}

function openVisitedScreen() {
    const match = /screen=([\w-]+)/.exec(window.location.hash || '');
    const keys = visitingKeys();
    const wanted = match && keys.indexOf(match[1]) !== -1 ? match[1] : keys[0];
    if (wanted) openScreenByKey(wanted);
}

let visitOpened = false;

function configureFeatures(options) {
    Object.assign(featuresSetup, options || {});
}

function uniqueKeys(list) {
    const keys = [];
    for (let i = 0; i < list.length; i++) {
        if (keys.indexOf(list[i]) === -1) {
            keys.push(list[i]);
        }
    }
    return keys;
}

function rememberFeatureKeys(keys) {
    try {
        sessionStorage.setItem('featureKeys', JSON.stringify(keys));
    } catch (error) {
    }
}

function recallFeatureKeys() {
    try {
        const stored = JSON.parse(sessionStorage.getItem('featureKeys') || 'null');
        if (Array.isArray(stored)) {
            return uniqueKeys(stored);
        }
        return null;
    } catch (error) {
        return null;
    }
}

function featureKeysOf(element) {
    const text = String(element.getAttribute('data-feature') || '');
    const keys = [];
    const parts = text.split(',');
    for (let i = 0; i < parts.length; i++) {
        const key = parts[i].trim();
        if (key !== '') {
            keys.push(key);
        }
    }
    return keys;
}

function holdsAnyFeature(keys) {
    for (let i = 0; i < keys.length; i++) {
        if (holdsFeature(keys[i])) {
            return true;
        }
    }
    return false;
}

function holdsFeature(key) {
    return heldFeatureKeys === null || heldFeatureKeys.indexOf(key) !== -1;
}

function applyFeatureMarks() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || heldFeatureKeys === null) return;

    const visiting = isVisitingPage();
    const visitKeys = visiting ? visitingKeys() : [];
    if (visiting && heldFeatureList.length > 0 && visitKeys.length === 0) {
        window.location.replace(ownPageName() || 'Login.html');
        return;
    }

    const marks = nav.querySelectorAll('[data-feature]');
    for (let i = 0; i < marks.length; i++) {
        const element = marks[i];
        const item = element.closest('li') || element;
        if (item.hasAttribute('data-access') && typeof hasRole === 'function' &&
            !hasRole.apply(null, item.getAttribute('data-access').split(','))) continue;
        const keys = featureKeysOf(element);
        item.hidden = keys.length > 0 && !holdsAnyFeature(keys);
        if (visiting && keys.length > 0) {
            let offered = false;
            for (let k = 0; k < keys.length; k++) {
                if (visitKeys.indexOf(keys[k]) !== -1) offered = true;
            }
            item.hidden = !offered;
        }
    }

    for (let m = 0; m < nav.children.length; m++) {
        const module = nav.children[m];
        if (module.tagName !== 'LI' || module.hasAttribute('data-feature')) continue;
        const sub = module.querySelector(':scope > .nav-sub');
        if (!sub) continue;

        const marked = sub.querySelectorAll(':scope > li[data-feature], :scope > li > a[data-feature]');
        if (marked.length === 0) continue;

        let offered = false;
        const screens = sub.querySelectorAll(':scope > li');
        for (let s = 0; s < screens.length; s++) {
            if (!screens[s].hidden) {
                offered = true;
            }
        }
        module.hidden = !offered;
    }

    const others = document.querySelectorAll('[data-feature]');
    for (let i = 0; i < others.length; i++) {
        const element = others[i];
        if (element.closest('.sidebar-nav')) continue;
        const keys = featureKeysOf(element);
        if (keys.length > 0) element.hidden = !holdsAnyFeature(keys);
    }

    if (typeof featuresSetup.onApply === 'function') featuresSetup.onApply();

    renderMoreScreens();

    if (visiting && heldFeatureList.length > 0) {
        renderVisitBar();
        document.documentElement.classList.add('visit-ready');
        if (!visitOpened) {
            visitOpened = true;
            openVisitedScreen();
        }
    }

    leaveWithdrawnScreen();

    if (typeof syncSubnav === 'function') syncSubnav();
}

function leaveWithdrawnScreen() {
    if (heldFeatureKeys === null) return;

    const panels = document.querySelectorAll('[data-panel]');
    let open = null;
    for (let i = 0; i < panels.length; i++) {
        if (window.getComputedStyle(panels[i]).display !== 'none') {
            open = panels[i];
            break;
        }
    }
    if (!open) return;

    const panelId = open.getAttribute('data-panel-of') || open.id;
    const link = document.querySelector('.sidebar-nav a[data-panel-link="' + panelId + '"]');
    if (!link) return;

    const item = link.closest('li');
    let module = null;
    if (item) {
        module = item.parentElement.closest('li');
    }
    const withdrawn = (item && item.hidden) || (module && module.hidden);
    if (!withdrawn) return;

    const name = link.cloneNode(true);
    const carets = name.querySelectorAll('.nav-caret');
    for (let i = 0; i < carets.length; i++) {
        carets[i].remove();
    }
    const title = name.textContent.replace(/\s+/g, ' ').trim() || 'That screen';

    if (typeof closeModal === 'function') {
        const openModals = document.querySelectorAll('.modal.open');
        for (let i = 0; i < openModals.length; i++) {
            closeModal(openModals[i].id);
        }
    }

    if (isVisitingPage()) {
        openVisitedScreen();
        return;
    }

    if (typeof featuresSetup.home === 'function') {
        featuresSetup.home();
        if (typeof unfoldSidebarAtOpenScreen === 'function') unfoldSidebarAtOpenScreen();
    } else {
        const brand = document.querySelector('.sidebar-brand');
        if (brand) brand.click();
    }

    if (typeof notifyWarning === 'function') {
        notifyWarning(title + ' has been switched off for your role by the System Administrator, ' +
            'so this page has gone back to its first screen.', 'Screen withdrawn');
    }
}

async function refreshFeatures() {
    let answer;
    try {
        answer = await apiGetMyScreens();
    } catch (error) {
        return;
    }

    if (Array.isArray(answer.held)) {
        heldFeatureKeys = uniqueKeys(answer.held);
    } else {
        heldFeatureKeys = [];
    }
    heldFeatureList = Array.isArray(answer.features) ? answer.features : [];
    rememberFeatureKeys(heldFeatureKeys);
    applyFeatureMarks();
}

function startFeatures() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || !document.querySelector('[data-feature]')) return;
    if (typeof getCurrentUser === 'function' && !getCurrentUser()) return;

    const remembered = recallFeatureKeys();
    if (remembered) {
        heldFeatureKeys = remembered;
        applyFeatureMarks();
    }

    refreshFeatures();

    if (typeof onLiveChange === 'function') {
        onLiveChange(['features'], function () {
            refreshFeatures();
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(startFeatures, 0);
});
