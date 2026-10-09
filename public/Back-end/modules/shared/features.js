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

let heldFeatureKeys = null;         // Set of keys, null until the server has answered

function configureFeatures(options) {
    Object.assign(featuresSetup, options || {});
}

// saves the keys in the browser tab, so the next page load can use them at once
function rememberFeatureKeys(keys) {
    try {
        // Array.from turns the Set into a normal list, which JSON can save
        sessionStorage.setItem('featureKeys', JSON.stringify(Array.from(keys)));
    } catch (error) {
        // private browsing mode: nothing is saved, which is fine
    }
}

function recallFeatureKeys() {
    try {
        const stored = JSON.parse(sessionStorage.getItem('featureKeys') || 'null');
        if (Array.isArray(stored)) {
            return new Set(stored);
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
    for (const part of text.split(',')) {
        const key = part.trim();
        if (key !== '') {
            keys.push(key);
        }
    }
    return keys;
}

// true when this person holds at least one of the keys
function holdsAnyFeature(keys) {
    for (const key of keys) {
        if (holdsFeature(key)) {
            return true;
        }
    }
    return false;
}

function holdsFeature(key) {
    return heldFeatureKeys === null || heldFeatureKeys.has(key);
}

function applyFeatureMarks() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || heldFeatureKeys === null) return;

    // an <li> marked with the screen it opens, or an <a> inside one
    nav.querySelectorAll('[data-feature]').forEach((element) => {
        const item = element.closest('li') || element;
        // data-access (read by subnav.js) wins over the switches
        if (item.hasAttribute('data-access') && typeof hasRole === 'function' &&
            !hasRole.apply(null, item.getAttribute('data-access').split(','))) return;
        const keys = featureKeysOf(element);
        item.hidden = keys.length > 0 && !holdsAnyFeature(keys);
    });

    // a heading whose screens have all gone goes with them
    for (const module of Array.from(nav.children)) {
        if (module.tagName !== 'LI' || module.hasAttribute('data-feature')) continue;
        const sub = module.querySelector(':scope > .nav-sub');
        if (!sub) continue;

        // does this heading have any screens that are switched by a feature?
        const marked = sub.querySelectorAll(':scope > li[data-feature], :scope > li > a[data-feature]');
        if (marked.length === 0) continue;

        // is at least one of its screens still showing?
        let offered = false;
        for (const item of sub.querySelectorAll(':scope > li')) {
            if (!item.hidden) {
                offered = true;
            }
        }
        module.hidden = !offered;
    }

    // other marked things on the page (not in the menu)
    document.querySelectorAll('[data-feature]').forEach((element) => {
        if (element.closest('.sidebar-nav')) return;
        const keys = featureKeysOf(element);
        if (keys.length > 0) element.hidden = !holdsAnyFeature(keys);
    });

    if (typeof featuresSetup.onApply === 'function') featuresSetup.onApply();

    leaveWithdrawnScreen();

    if (typeof syncSubnav === 'function') syncSubnav();
}

// The open screen was just switched off: go back to the first and say so.
function leaveWithdrawnScreen() {
    if (heldFeatureKeys === null) return;

    const panels = document.querySelectorAll('[data-panel]');
    let open = null;
    for (const panel of panels) {
        if (window.getComputedStyle(panel).display !== 'none') { open = panel; break; }
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
    name.querySelectorAll('.nav-caret').forEach((node) => node.remove());
    const title = name.textContent.replace(/\s+/g, ' ').trim() || 'That screen';

    if (typeof closeModal === 'function') {
        document.querySelectorAll('.modal.open').forEach((modal) => closeModal(modal.id));
    }

    if (typeof featuresSetup.home === 'function') {
        featuresSetup.home();
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
        heldFeatureKeys = new Set(answer.held);
    } else {
        heldFeatureKeys = new Set();
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
        onLiveChange(['features'], () => refreshFeatures());
    }
}

document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(startFeatures, 0);
});
