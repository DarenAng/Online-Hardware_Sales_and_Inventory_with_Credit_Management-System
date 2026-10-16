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

function subnavRoot() {
    return document.getElementById('subnav');
}

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
        const parts = list.split(',');
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i].trim();
            if (name !== '' && name.toLowerCase() === role.toLowerCase()) {
                return true;
            }
        }
        return false;
    }

    const modules = [];

    for (let i = 0; i < nav.children.length; i++) {
        const item = nav.children[i];
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
            const links = sub.querySelectorAll('li > a[data-panel-link]');
            for (let k = 0; k < links.length; k++) {
                const link = links[k];
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
    const carets = copy.querySelectorAll('.nav-caret');
    for (let i = 0; i < carets.length; i++) {
        carets[i].remove();
    }
    // runs of spaces and line breaks become one space
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
            let module = null;
            for (let i = 0; i < subnavModules.length; i++) {
                if (subnavModules[i].link === parent) {
                    module = subnavModules[i];
                    break;
                }
            }
            const screens = module ? offeredScreens(module) : [];
            if (module && screens.length > 0) {
                event.preventDefault();
                // the screen that is open now, or the first one
                let current = null;
                for (let i = 0; i < screens.length; i++) {
                    if (screens[i].link.classList.contains('active')) {
                        current = screens[i];
                        break;
                    }
                }
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
            const watcher = new MutationObserver(function () {
                window.clearTimeout(pending);
                pending = window.setTimeout(syncSubnav, 0);
            });
            for (let i = 0; i < panels.length; i++) {
                watcher.observe(panels[i], {
                    attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-view']
                });
            }
        }
    }

    syncSubnav();
}

// features.js may hide screens in the menu after the strip has read it, so
// the strip reads the menu as it stands now.
function offeredScreens(module) {
    const offered = [];
    for (let i = 0; i < module.screens.length; i++) {
        const screen = module.screens[i];
        const item = screen.link.closest('li');
        if (!(item && item.hidden)) offered.push(screen);
    }
    return offered;
}

// The module (menu heading) whose screens include this panel, or null.
function findSubnavModule(panelId) {
    for (let i = 0; i < subnavModules.length; i++) {
        const screens = subnavModules[i].screens;
        for (let k = 0; k < screens.length; k++) {
            if (screens[k].panelId === panelId) return subnavModules[i];
        }
    }
    return null;
}

// ---------- which screen is open ----------
// A screen opened from inside another (a printed order) has no tab; it says
// which screen it belongs to with data-panel-of.
function visiblePanel() {
    const panels = document.querySelectorAll('[data-panel]');
    for (let i = 0; i < panels.length; i++) {
        if (window.getComputedStyle(panels[i]).display !== 'none') return panels[i];
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

    const module = findSubnavModule(open);

    // the module heading takes the current mark; the strip says which screen
    for (let i = 0; i < subnavModules.length; i++) {
        const entry = subnavModules[i];
        if (entry.screens.length > 0) {
            entry.link.classList.toggle('active', entry === module);
        }
    }

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

    const offered = offeredScreens(module);
    let tabsHtml = '';
    for (let index = 0; index < offered.length; index++) {
        const screen = offered[index];
        tabsHtml += '<button type="button" class="subnav-tab' +
            (screenIsCurrent(screen, openPanelId, openView) ? ' is-current' : '') + '"' +
            (screenIsCurrent(screen, openPanelId, openView) ? ' aria-current="page"' : '') +
            ' data-subnav-panel="' + escapeHtml(screen.panelId) + '"' +
            ' onclick="openSubnavScreen(' + index + ')">' +
            escapeHtml(screen.name) +
            '</button>';
    }
    strip.innerHTML = tabsHtml;

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
    const module = findSubnavModule(open);

    const screens = module ? offeredScreens(module) : [];
    if (!screens[index]) return;

    screens[index].link.click();
    window.setTimeout(syncSubnav, 0);
}

// built after the session check, so a page bouncing to sign-in never builds one
document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(buildSubnav, 0);
});
