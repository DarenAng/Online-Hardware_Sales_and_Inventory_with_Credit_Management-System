// subnav.js -- the submodule tab strip
// Loaded by: all five dashboards
//
// The left menu holds modules; the strip holds the screens inside the open
// module. Tabs are read from the menu itself (.sidebar-nav > li > .nav-sub),
// so a screen a role cannot reach never gets a tab. A module marked
//   <li data-access="Manager,Inventory Clerk">  is dropped for other roles
//   <li data-sidebar-dropdown>                  stays a dropdown, no strip
// If this file does not run the menu keeps its sub-lists and still works.

let subnavModules = [];
let subnavBuilt = false;

function subnavRoot() { return document.getElementById('subnav'); }

// ---------- reading the menu ----------
function readSubnavModules() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return [];

    let role = '';
    if (typeof getCurrentUser === 'function') {
        const user = getCurrentUser();
        if (user) {
            role = String(user.role_name || '');
        }
    }

    // May this role see the element? data-access="Manager,Cashier" lists the
    // roles that may; an element without data-access is for everyone.
    function allowed(element) {
        const list = element.getAttribute('data-access');
        if (!list) return true;
        for (const part of list.split(',')) {
            const name = part.trim();
            if (name !== '' && name.toLowerCase() === role.toLowerCase()) {
                return true;
            }
        }
        return false;
    }

    const modules = [];

    for (const item of Array.from(nav.children)) {
        if (item.tagName !== 'LI') continue;

        if (!allowed(item)) {
            item.hidden = true;
            continue;
        }

        if (item.hasAttribute('data-sidebar-dropdown')) continue;

        const parent = item.querySelector(':scope > a');
        if (!parent) continue;

        // the screens under this heading that this role may see
        const sub = item.querySelector(':scope > .nav-sub');
        const screens = [];
        if (sub) {
            for (const link of sub.querySelectorAll('li > a[data-panel-link]')) {
                if (allowed(link)) {
                    screens.push({
                        link: link,
                        panelId: link.getAttribute('data-panel-link'),
                        // one panel can hold several views (the four reports); see data-view
                        view: link.getAttribute('data-panel-view'),
                        name: subnavLabel(link)
                    });
                }
            }
        }

        modules.push({
            item: item,
            link: parent,
            // a module with a sub-list is named by its parent link
            name: subnavLabel(parent),
            screens: screens,
            panelId: parent.getAttribute('data-panel-link') || null
        });
    }

    return modules;
}

// The link's own words, without the caret.
function subnavLabel(link) {
    const copy = link.cloneNode(true);
    copy.querySelectorAll('.nav-caret').forEach((node) => node.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
}

// ---------- building the strip ----------
function buildSubnav() {
    if (subnavBuilt) return;

    const topbar = document.querySelector('.topbar');
    if (!topbar || document.getElementById('subnav')) return;

    subnavModules = readSubnavModules();
    if (subnavModules.length === 0) return;

    const strip = document.createElement('nav');
    strip.className = 'subnav';
    strip.id = 'subnav';
    strip.setAttribute('aria-label', 'Screens in this module');
    strip.hidden = true;
    topbar.insertAdjacentElement('afterend', strip);

    subnavBuilt = true;
    document.body.classList.add('has-subnav');

    // A module heading opens its current (or first) screen; a heading that
    // kept its list (data-sidebar-dropdown) keeps its own click.
    document.addEventListener('click', function (event) {
        const parent = event.target.closest('.sidebar-nav .nav-parent');
        if (parent && document.body.classList.contains('has-subnav')) {
            const module = subnavModules.find((m) => m.link === parent);
            const screens = module ? offeredScreens(module) : [];
            if (module && screens.length > 0) {
                event.preventDefault();
                const current = screens.find((s) => s.link.classList.contains('active'));
                (current || screens[0]).link.click();
                return;
            }
        }

        if (event.target.closest('.sidebar-nav a, .subnav-tab, .sidebar-brand')) {
            window.setTimeout(syncSubnav, 0);
        }
    });

    // Screens can also be opened by script (a finished purchase order opens its
    // print copy), so the panels themselves are watched.
    if (typeof MutationObserver === 'function') {
        const panels = document.querySelectorAll('[data-panel]');
        if (panels.length > 0) {
            let pending = null;
            const watcher = new MutationObserver(() => {
                window.clearTimeout(pending);
                pending = window.setTimeout(syncSubnav, 0);
            });
            panels.forEach((panel) => watcher.observe(panel, {
                attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-view']
            }));
        }
    }

    syncSubnav();
}

// features.js may hide screens in the menu after the strip has read it, so
// the strip reads the menu as it stands now.
function offeredScreens(module) {
    return module.screens.filter((screen) => {
        const item = screen.link.closest('li');
        return !(item && item.hidden);
    });
}

// ---------- which screen is open ----------
// A screen opened from inside another (a printed order) has no tab; it says
// which screen it belongs to with data-panel-of.
function visiblePanel() {
    const panels = document.querySelectorAll('[data-panel]');
    for (const panel of panels) {
        if (window.getComputedStyle(panel).display !== 'none') return panel;
    }
    return null;
}

function visiblePanelId() {
    const panel = visiblePanel();
    return panel ? (panel.getAttribute('data-panel-of') || panel.id) : null;
}

function visiblePanelView() {
    const panel = visiblePanel();
    return panel ? panel.getAttribute('data-view') : null;
}

function screenIsCurrent(screen, openPanelId, openView) {
    if (screen.panelId !== openPanelId) return false;
    return !screen.view || screen.view === openView;
}

function syncSubnav() {
    const strip = subnavRoot();
    if (!strip) return;

    const open = visiblePanelId();

    let module = subnavModules.find((m) =>
        m.screens.some((screen) => screen.panelId === open));

    // the module heading takes the current mark; the strip says which screen
    subnavModules.forEach((entry) => {
        if (entry.screens.length > 0) {
            entry.link.classList.toggle('active', entry === module);
        }
    });

    if (!module || offeredScreens(module).length < 2) {
        strip.hidden = true;
        strip.innerHTML = '';
        return;
    }

    renderSubnav(module, open);
}

function renderSubnav(module, openPanelId) {
    const strip = subnavRoot();
    if (!strip) return;

    const openView = visiblePanelView();

    strip.innerHTML = offeredScreens(module).map((screen, index) =>
        '<button type="button" class="subnav-tab' +
        (screenIsCurrent(screen, openPanelId, openView) ? ' is-current' : '') + '"' +
        (screenIsCurrent(screen, openPanelId, openView) ? ' aria-current="page"' : '') +
        ' data-subnav-panel="' + escapeHtml(screen.panelId) + '"' +
        ' onclick="openSubnavScreen(' + index + ')">' +
        escapeHtml(screen.name) +
        '</button>').join('');

    strip.hidden = false;
    strip.dataset.module = module.name;
    placeSubnav(strip);

    // on a phone the strip scrolls; keep the current tab in view
    const current = strip.querySelector('.subnav-tab.is-current');
    if (current && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

// One element, moved into the card of the open screen under its heading.
function placeSubnav(strip) {
    const panel = visiblePanel();
    if (!panel) return;

    const card = panel.matches('.card') ? panel : (panel.querySelector('.card') || panel);
    const head = card.querySelector(':scope > .panel-head');

    if (head) {
        if (head.nextElementSibling !== strip) head.insertAdjacentElement('afterend', strip);
    } else if (card.firstElementChild !== strip) {
        card.insertAdjacentElement('afterbegin', strip);
    }
}

function openSubnavScreen(index) {
    const open = visiblePanelId();
    const module = subnavModules.find((m) =>
        m.screens.some((screen) => screen.panelId === open));

    const screens = module ? offeredScreens(module) : [];
    if (!screens[index]) return;

    screens[index].link.click();
    window.setTimeout(syncSubnav, 0);
}

// built after the session check, so a page bouncing to sign-in never builds one
document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(buildSubnav, 0);
});
