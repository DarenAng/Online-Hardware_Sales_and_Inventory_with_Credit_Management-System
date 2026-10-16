// features.js -- which screens this menu holds
// Loaded by: the four staff dashboards (not the administrator's)
//
// A menu item names the screen it opens, <li data-feature="credit-requests">,
// and is hidden or shown by /api/me/features (Access Control on the
// administrator's page). Items held only by grant start hidden in the markup.
// This file shows and hides, and never grants: the server refuses the routes.

const featuresSetup = {
    home: null,             // () -- the page's own way back to its first screen
    onApply: null           // () -- after the marks are applied, for tabs inside a screen
};

let heldFeatureKeys = null;         // list of keys (no repeats), null until the server has answered

function configureFeatures(options) {
    Object.assign(featuresSetup, options || {});
}

// a copy of the list with every key only once
function uniqueKeys(list) {
    const keys = [];
    for (let i = 0; i < list.length; i++) {
        if (keys.indexOf(list[i]) === -1) {
            keys.push(list[i]);
        }
    }
    return keys;
}

// saves the keys in the browser tab, so the next page load can use them at once
function rememberFeatureKeys(keys) {
    try {
        sessionStorage.setItem('featureKeys', JSON.stringify(keys));
    } catch (error) {
        // private browsing mode: nothing is saved, which is fine
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

// ==========================================
// SHOWING AND HIDING THE MENU
// ==========================================
// data-feature="a, b" -> ['a', 'b']
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

// true when this person holds at least one of the keys
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

    // an <li> marked with the screen it opens, or an <a> inside one
    const marks = nav.querySelectorAll('[data-feature]');
    for (let i = 0; i < marks.length; i++) {
        const element = marks[i];
        const item = element.closest('li') || element;
        // data-access (read by subnav.js) wins over the switches
        if (item.hasAttribute('data-access') && typeof hasRole === 'function' &&
            !hasRole.apply(null, item.getAttribute('data-access').split(','))) continue;
        const keys = featureKeysOf(element);
        item.hidden = keys.length > 0 && !holdsAnyFeature(keys);
    }

    // a heading whose screens have all gone goes with them
    for (let m = 0; m < nav.children.length; m++) {
        const module = nav.children[m];
        if (module.tagName !== 'LI' || module.hasAttribute('data-feature')) continue;
        const sub = module.querySelector(':scope > .nav-sub');
        if (!sub) continue;

        // does this heading have any screens that are switched by a feature?
        const marked = sub.querySelectorAll(':scope > li[data-feature], :scope > li > a[data-feature]');
        if (marked.length === 0) continue;

        // is at least one of its screens still showing?
        let offered = false;
        const screens = sub.querySelectorAll(':scope > li');
        for (let s = 0; s < screens.length; s++) {
            if (!screens[s].hidden) {
                offered = true;
            }
        }
        module.hidden = !offered;
    }

    // other marked things on the page (not in the menu)
    const others = document.querySelectorAll('[data-feature]');
    for (let i = 0; i < others.length; i++) {
        const element = others[i];
        if (element.closest('.sidebar-nav')) continue;
        const keys = featureKeysOf(element);
        if (keys.length > 0) element.hidden = !holdsAnyFeature(keys);
    }

    if (typeof featuresSetup.onApply === 'function') featuresSetup.onApply();

    leaveWithdrawnScreen();

    if (typeof syncSubnav === 'function') syncSubnav();
}

// The open screen was just switched off: go back to the first and say so.
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
        module = item.parentElement.closest('li');   // the heading above it
    }
    const withdrawn = (item && item.hidden) || (module && module.hidden);
    if (!withdrawn) return;

    const name = link.cloneNode(true);
    const carets = name.querySelectorAll('.nav-caret');
    for (let i = 0; i < carets.length; i++) {
        carets[i].remove();
    }
    // runs of spaces and line breaks become one space
    const title = name.textContent.replace(/\s+/g, ' ').trim() || 'That screen';

    if (typeof closeModal === 'function') {
        const openModals = document.querySelectorAll('.modal.open');
        for (let i = 0; i < openModals.length; i++) {
            closeModal(openModals[i].id);
        }
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
        return;     // the session has ended, or the server is away; handled elsewhere
    }

    if (Array.isArray(answer.held)) {
        heldFeatureKeys = uniqueKeys(answer.held);
    } else {
        heldFeatureKeys = [];
    }
    rememberFeatureKeys(heldFeatureKeys);
    applyFeatureMarks();
}

// After the session check, and only on a page with a menu to shape.
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
