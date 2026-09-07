// subnav.js  --  THE SUBMODULE STRIP
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// TWO LEVELS, EACH WITH ONE JOB
//
// The menu on the left is how a person gets anywhere in the system. It holds
// the modules -- Inventory Management, Credit, Point of Sale -- and it is the
// same list all day, so it can be learned once and then used without reading.
//
// The strip across the top holds the screens inside whichever module is open,
// and nothing else. It changes as you move, and on a module that has only one
// screen it is not there at all.
//
// Before this, both levels held both things: every screen was listed in the
// menu under its module, and the top bar held only a title. That is one list
// doing two jobs, and it grows until the menu is the length of the page.
//
// WHERE THE TABS COME FROM
//
// Not from a second list written out in each dashboard. They are read from
// the menu that is already in the page: a module is an <li> in .sidebar-nav,
// and its screens are the links in the .nav-sub underneath it. One source,
// so the two levels cannot drift apart, and a screen added to the menu gets
// its tab for free.
//
// It also means access is handled in one place rather than two. A screen a
// role cannot open is not written into that role's menu, so no tab for it is
// ever built -- the strip is generated from what the person can actually
// reach rather than filtered afterwards, which is the version that cannot
// leak. A module can also be marked in the markup:
//
//     <li data-access="Manager,Inventory Clerk">
//
// and it is dropped, from the menu and the strip both, for anybody else.
//
// IF THIS FILE DOES NOT RUN
//
// The menu keeps its sub-lists and the system works exactly as it did. The
// sub-lists are only folded away once the strip has actually been built, by
// a class this file puts on <body>, so a script that fails to load costs a
// tab strip rather than the ability to navigate.
// ==========================================

let subnavModules = [];
let subnavBuilt = false;

function subnavRoot() { return document.getElementById('subnav'); }

// ---------- reading the menu ----------
function readSubnavModules() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return [];

    const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
    const role = user ? String(user.role_name || '') : '';

    const allowed = (element) => {
        const list = element.getAttribute('data-access');
        if (!list) return true;
        return list.split(',').map((name) => name.trim()).filter(Boolean)
            .some((name) => name.toLowerCase() === role.toLowerCase());
    };

    const modules = [];

    [...nav.children].forEach((item) => {
        if (item.tagName !== 'LI') return;

        if (!allowed(item)) {
            item.hidden = true;
            return;
        }

        const parent = item.querySelector(':scope > a');
        if (!parent) return;

        const sub = item.querySelector(':scope > .nav-sub');
        const screens = sub
            ? [...sub.querySelectorAll('li > a[data-panel-link]')].filter(allowed)
            : [];

        screens.forEach((link) => {
            const li = link.closest('li');
            if (li && !allowed(link)) li.hidden = true;
        });

        modules.push({
            item: item,
            link: parent,
            // a module with a sub-list is named by its parent link; a module
            // that is one screen is named by that screen
            name: subnavLabel(parent),
            screens: screens.map((link) => ({
                link: link,
                panelId: link.getAttribute('data-panel-link'),
                name: subnavLabel(link),
                countSource: link.querySelector('.nav-count')
            })),
            panelId: parent.getAttribute('data-panel-link') || null
        });
    });

    return modules;
}

// The link's own words, without the caret glyph or the count riding on it.
function subnavLabel(link) {
    const copy = link.cloneNode(true);
    copy.querySelectorAll('.nav-caret, .nav-count').forEach((node) => node.remove());
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

    // A module heading in the menu now opens its first screen rather than
    // folding a list nobody can see any more.
    document.addEventListener('click', function (event) {
        const parent = event.target.closest('.sidebar-nav .nav-parent');
        if (parent && document.body.classList.contains('has-subnav')) {
            const module = subnavModules.find((m) => m.link === parent);
            if (module && module.screens.length > 0) {
                event.preventDefault();
                module.screens[0].link.click();
                return;
            }
        }

        // any navigation at all, from either level, re-reads where we are
        if (event.target.closest('.sidebar-nav a, .subnav-tab, .sidebar-brand')) {
            window.setTimeout(syncSubnav, 0);
        }
    });

    // A screen can also be opened by a script rather than by a click -- a
    // finished purchase order opens its own printed copy, for one -- and the
    // strip has to follow that too. Watching the panels themselves catches
    // every route into a screen, including the ones added later, where
    // watching for clicks only catches the two routes that exist today.
    if (typeof MutationObserver === 'function') {
        const panels = document.querySelectorAll('[data-panel]');
        if (panels.length > 0) {
            let pending = null;
            const watcher = new MutationObserver(() => {
                window.clearTimeout(pending);
                pending = window.setTimeout(syncSubnav, 0);
            });
            panels.forEach((panel) => watcher.observe(panel, {
                attributes: true, attributeFilter: ['style', 'hidden', 'class']
            }));
        }
    }

    // counts are written into the menu by each module's own script; the tab
    // carries the same figure rather than a second copy of the logic
    const counts = subnavModules
        .flatMap((m) => m.screens)
        .map((s) => s.countSource)
        .filter(Boolean);

    if (counts.length > 0 && typeof MutationObserver === 'function') {
        const watcher = new MutationObserver(() => syncSubnavCounts());
        counts.forEach((node) => watcher.observe(node, {
            childList: true, characterData: true, subtree: true
        }));
    }

    syncSubnav();
}

// ---------- which screen is open ----------
// A screen opened from inside another one -- a printed order, a count sheet --
// has no tab of its own and should not blank the strip while it is open. It
// says which screen it belongs to with data-panel-of, and the strip goes on
// showing that one as current.
function visiblePanelId() {
    const panels = document.querySelectorAll('[data-panel]');
    for (const panel of panels) {
        if (window.getComputedStyle(panel).display !== 'none') {
            return panel.getAttribute('data-panel-of') || panel.id;
        }
    }
    return null;
}

function syncSubnav() {
    const strip = subnavRoot();
    if (!strip) return;

    const open = visiblePanelId();

    let module = subnavModules.find((m) =>
        m.screens.some((screen) => screen.panelId === open));

    // The module scripts mark the open screen's own link, which is inside a
    // sub-list nobody can see any more. So the module heading takes the mark
    // instead: the menu says which module, the strip says which screen.
    subnavModules.forEach((entry) => {
        if (entry.screens.length > 0) {
            entry.link.classList.toggle('active', entry === module);
        }
    });

    // A module that is a single screen has no strip of its own, and neither
    // does a screen that belongs to no module at all.
    if (!module || module.screens.length < 2) {
        strip.hidden = true;
        strip.innerHTML = '';
        return;
    }

    renderSubnav(module, open);
}

function renderSubnav(module, openPanelId) {
    const strip = subnavRoot();
    if (!strip) return;

    strip.innerHTML = module.screens.map((screen, index) =>
        '<button type="button" class="subnav-tab' +
        (screen.panelId === openPanelId ? ' is-current' : '') + '"' +
        (screen.panelId === openPanelId ? ' aria-current="page"' : '') +
        ' data-subnav-panel="' + escapeHtml(screen.panelId) + '"' +
        ' onclick="openSubnavScreen(' + index + ')">' +
        escapeHtml(screen.name) +
        (screen.countSource ? '<span class="subnav-count" data-subnav-count="' +
            escapeHtml(screen.panelId) + '"></span>' : '') +
        '</button>').join('');

    strip.hidden = false;
    strip.dataset.module = module.name;
    syncSubnavCounts();

    // On a phone the strip scrolls, and the tab you just took can be off the
    // right-hand edge of it. Nothing else moves; only the strip scrolls.
    const current = strip.querySelector('.subnav-tab.is-current');
    if (current && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

function syncSubnavCounts() {
    const strip = subnavRoot();
    if (!strip) return;

    strip.querySelectorAll('[data-subnav-count]').forEach((slot) => {
        const panelId = slot.getAttribute('data-subnav-count');
        const screen = subnavModules
            .flatMap((m) => m.screens)
            .find((s) => s.panelId === panelId);

        const text = screen && screen.countSource
            ? screen.countSource.textContent.trim() : '';

        slot.textContent = text;
        slot.hidden = text === '';
    });
}

function openSubnavScreen(index) {
    const open = visiblePanelId();
    const module = subnavModules.find((m) =>
        m.screens.some((screen) => screen.panelId === open));

    if (!module || !module.screens[index]) return;

    // the tab presses the menu item, so there is exactly one route into a
    // screen and nothing to keep in step
    module.screens[index].link.click();
    window.setTimeout(syncSubnav, 0);
}

// The strip is built after the session has been checked, so a page that
// bounces to the sign-in screen never builds one.
document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(buildSubnav, 0);
});
