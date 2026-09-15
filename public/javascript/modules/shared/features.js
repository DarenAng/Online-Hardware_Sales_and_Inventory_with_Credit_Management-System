// features.js -- which screens this menu holds, and what is waiting on them
// Loaded by: the four staff dashboards (not the administrator's)
//
// A menu item names the screen it opens, <li data-feature="credit-requests">,
// and is hidden or shown by /api/me/features (Screens by Role on the
// administrator's page). Items held only by grant start hidden in the markup.
// This file shows and hides, and never grants: the server refuses the routes.
//
// A badge <span class="nav-count" data-count-for="credit-requests"> carries
// the number waiting; it is mirrored onto the folded heading and into one
// top-bar chip. Numbers come from /api/me/counts and the live channel.

const featuresSetup = {
    home: null              // () -- the page's own way back to its first screen
};

let heldFeatureKeys = null;         // Set of keys, null until the server has answered
let featureCounts = {};             // key -> number, as last answered

function configureFeatures(options) {
    Object.assign(featuresSetup, options || {});
}

function rememberFeatureKeys(keys) {
    try { sessionStorage.setItem('featureKeys', JSON.stringify([...keys])); } catch (error) { /* private mode */ }
}

function recallFeatureKeys() {
    try {
        const stored = JSON.parse(sessionStorage.getItem('featureKeys') || 'null');
        return Array.isArray(stored) ? new Set(stored) : null;
    } catch (error) {
        return null;
    }
}

// ==========================================
// SHOWING AND HIDING THE MENU
// ==========================================
function featureKeysOf(element) {
    return String(element.getAttribute('data-feature') || '')
        .split(',').map((key) => key.trim()).filter(Boolean);
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
        item.hidden = keys.length > 0 && !keys.some(holdsFeature);
    });

    // a heading whose screens have all gone goes with them
    [...nav.children].forEach((module) => {
        if (module.tagName !== 'LI' || module.hasAttribute('data-feature')) return;
        const sub = module.querySelector(':scope > .nav-sub');
        if (!sub) return;

        const marked = [...sub.querySelectorAll(':scope > li[data-feature], :scope > li > a[data-feature]')]
            .map((element) => element.closest('li'));
        if (marked.length === 0) return;

        const offered = [...sub.querySelectorAll(':scope > li')].some((item) => !item.hidden);
        module.hidden = !offered;
    });

    document.querySelectorAll('[data-feature]').forEach((element) => {
        if (element.closest('.sidebar-nav')) return;
        const keys = featureKeysOf(element);
        if (keys.length > 0) element.hidden = !keys.some(holdsFeature);
    });

    leaveWithdrawnScreen();
    mirrorFeatureCounts();

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
    const module = item ? item.parentElement.closest('li') : null;
    const withdrawn = (item && item.hidden) || (module && module.hidden);
    if (!withdrawn) return;

    const name = link.cloneNode(true);
    name.querySelectorAll('.nav-caret, .nav-count').forEach((node) => node.remove());
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
        answer = await getJson('/api/me/features');
    } catch (error) {
        return;     // the session has ended, or the server is away; handled elsewhere
    }

    heldFeatureKeys = new Set(Array.isArray(answer.held) ? answer.held : []);
    rememberFeatureKeys(heldFeatureKeys);
    applyFeatureMarks();

    refreshFeatureCounts();
}

// ==========================================
// THE COUNTS
// ==========================================
// every count carries its meaning in words: tooltip, top-bar list, heading
const COUNT_MEANINGS = {
    'credit-requests':   ['credit request waiting for your decision', 'credit requests waiting for your decision'],
    'reorder-alerts':    ['material at or below its reorder point', 'materials at or below their reorder point'],
    'reorder-points':    ['material at or below its reorder point', 'materials at or below their reorder point'],
    'returns':           ['returned item still to be resolved', 'returned items still to be resolved'],
    'deliveries':        ['delivery booked but not yet sent out', 'deliveries booked but not yet sent out'],
    'delivery-runs':     ['delivery waiting to go out on your run', 'deliveries waiting to go out on your run'],
    'delivery-schedule': ['delivery due today or overdue', 'deliveries due today or overdue']
};

function countMeaning(key, count) {
    const words = COUNT_MEANINGS[key];
    if (!words) return count + ' waiting';
    return count + ' ' + (count === 1 ? words[0] : words[1]);
}

function badgeMeaning(badge) {
    const count = badgeCount(badge);
    const key = badge.getAttribute('data-count-for');
    return count > 0 ? countMeaning(key, count) : '';
}

function writeFeatureCount(key, count) {
    document.querySelectorAll('.nav-count[data-count-for="' + key + '"]').forEach((badge) => {
        badge.textContent = count > 0 ? String(count) : '';
        badge.classList.toggle('is-waiting', count > 0);
    });
}

function explainBadges() {
    document.querySelectorAll('.sidebar-nav .nav-count[data-count-for]').forEach((badge) => {
        const meaning = badgeMeaning(badge);
        badge.title = meaning;
        badge.setAttribute('aria-label', meaning);
    });
}

async function refreshFeatureCounts() {
    if (!document.querySelector('.nav-count[data-count-for]')) return;

    try {
        featureCounts = await getJson('/api/me/counts');
    } catch (error) {
        return;
    }

    document.querySelectorAll('.nav-count[data-count-for]').forEach((badge) => {
        const key = badge.getAttribute('data-count-for');
        writeFeatureCount(key, Number(featureCounts[key]) || 0);
    });

    mirrorFeatureCounts();
}

function badgeCount(badge) {
    const value = parseInt(String(badge.textContent || '').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function badgeLabel(badge) {
    const link = badge.closest('a');
    if (!link) return '';
    const copy = link.cloneNode(true);
    copy.querySelectorAll('.nav-caret, .nav-count').forEach((node) => node.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
}

// the counts on the menu as a list; a badge inside a hidden item does not count
function waitingOnMenu() {
    const rows = [];
    document.querySelectorAll('.sidebar-nav .nav-count:not(.nav-count-parent)').forEach((badge) => {
        const item = badge.closest('li');
        const module = item ? item.parentElement.closest('li') : null;
        if ((item && item.hidden) || (module && module.hidden)) return;

        const count = badgeCount(badge);
        if (count === 0) return;

        rows.push({
            badge: badge, count: count, label: badgeLabel(badge), link: badge.closest('a'),
            meaning: badge.hasAttribute('data-count-for') ? countMeaning(badge.getAttribute('data-count-for'), count) : count + ' waiting'
        });
    });
    return rows;
}

let mirrorPending = null;

// every heading gets the sum under it, the top bar the sum of everything
function mirrorFeatureCounts() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;

    explainBadges();
    const waiting = waitingOnMenu();

    [...nav.children].forEach((module) => {
        if (module.tagName !== 'LI') return;
        const heading = module.querySelector(':scope > .nav-parent');
        const sub = module.querySelector(':scope > .nav-sub');
        if (!heading || !sub) return;

        const under = waiting.filter((row) => sub.contains(row.badge));
        const total = under.reduce((sum, row) => sum + row.count, 0);
        const spelledOut = under.map((row) => row.meaning).join('; ');

        let mirror = heading.querySelector(':scope > .nav-count-parent');
        if (!mirror && total > 0) {
            mirror = document.createElement('span');
            mirror.className = 'nav-count nav-count-parent';
            const caret = heading.querySelector(':scope > .nav-caret');
            if (caret) heading.insertBefore(mirror, caret);
            else heading.appendChild(mirror);
        }
        if (mirror) {
            mirror.textContent = total > 0 ? String(total) : '';
            mirror.classList.toggle('is-waiting', total > 0);
            mirror.title = spelledOut;
            mirror.setAttribute('aria-label', spelledOut);
        }
    });

    renderPendingChip(waiting);
}

// The chip in the top bar: one figure for the menu and a list under it.
// Pressing a line presses the menu item.
function buildPendingChip() {
    const corner = document.querySelector('.topbar .topbar-right');
    if (!corner || document.getElementById('pending-chip')) return;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pending-chip';
    chip.id = 'pending-chip';
    chip.hidden = true;
    chip.setAttribute('aria-haspopup', 'true');
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('onclick', 'togglePendingDrop(event)');
    chip.innerHTML = '<span class="pending-chip-count" id="pending-chip-count">0</span>' +
        '<span class="pending-chip-word">waiting</span>';

    const bell = corner.querySelector('.bell');
    if (bell) corner.insertBefore(chip, bell);
    else corner.insertBefore(chip, corner.firstChild);

    const drop = document.createElement('div');
    drop.className = 'pending-drop';
    drop.id = 'pending-drop';
    drop.hidden = true;
    drop.innerHTML = '<div class="pending-drop-head"><span class="eyebrow">Waiting for you</span>' +
        '<span class="pending-drop-hint">Press a line to open that screen.</span></div>' +
        '<div class="pending-drop-list" id="pending-drop-list"></div>';

    const main = corner.closest('.main-content') || document.body;
    const topbar = corner.closest('.topbar');
    if (topbar) topbar.insertAdjacentElement('afterend', drop);
    else main.appendChild(drop);
}

function renderPendingChip(waiting) {
    const chip = document.getElementById('pending-chip');
    const figure = document.getElementById('pending-chip-count');
    const list = document.getElementById('pending-drop-list');
    if (!chip || !figure || !list) return;

    const total = waiting.reduce((sum, row) => sum + row.count, 0);
    figure.textContent = String(total);
    chip.hidden = total === 0;
    chip.title = total === 0 ? '' : waiting.map((row) => row.meaning).join('; ');
    chip.setAttribute('aria-label', total === 0 ? '' : total + ' things waiting for you: ' + chip.title);

    if (total === 0) closePendingDrop();

    list.innerHTML = waiting.map((row, index) =>
        '<button type="button" class="pending-row" onclick="openPendingRow(' + index + ')">' +
        '<span class="pending-row-text">' +
            '<span class="pending-row-label">' + escapeHtml(row.label) + '</span>' +
            '<span class="pending-row-meaning">' + escapeHtml(row.meaning) + '</span>' +
        '</span>' +
        '<span class="pending-row-count">' + row.count + '</span>' +
        '</button>').join('');
}

function openPendingRow(index) {
    const row = waitingOnMenu()[index];
    closePendingDrop();
    if (row && row.link) row.link.click();
}

function togglePendingDrop(event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const drop = document.getElementById('pending-drop');
    if (!drop) return;
    if (drop.hidden) openPendingDrop();
    else closePendingDrop();
}

function openPendingDrop() {
    const drop = document.getElementById('pending-drop');
    const chip = document.getElementById('pending-chip');
    if (!drop) return;

    if (typeof closeNotifications === 'function') closeNotifications();
    if (typeof closeAccountMenu === 'function') closeAccountMenu();

    drop.hidden = false;
    if (chip) chip.setAttribute('aria-expanded', 'true');
}

function closePendingDrop() {
    const drop = document.getElementById('pending-drop');
    const chip = document.getElementById('pending-chip');
    if (drop) drop.hidden = true;
    if (chip) chip.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function (event) {
    if (!event.target.closest('#pending-drop') && !event.target.closest('#pending-chip')) closePendingDrop();
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closePendingDrop();
});

// After the session check, and only on a page with a menu to shape.
function startFeatures() {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || !document.querySelector('[data-feature], .nav-count[data-count-for]')) return;
    if (typeof getCurrentUser === 'function' && !getCurrentUser()) return;

    const remembered = recallFeatureKeys();
    if (remembered) {
        heldFeatureKeys = remembered;
        applyFeatureMarks();
    }

    buildPendingChip();

    // module scripts write the same badges; the mirrors follow whichever wrote last
    if (typeof MutationObserver === 'function') {
        const watcher = new MutationObserver(function () {
            window.clearTimeout(mirrorPending);
            mirrorPending = window.setTimeout(mirrorFeatureCounts, 0);
        });
        nav.querySelectorAll('.nav-count:not(.nav-count-parent)').forEach((badge) => {
            watcher.observe(badge, { childList: true, characterData: true, subtree: true });
        });
    }

    refreshFeatures();

    if (typeof onLiveChange === 'function') {
        onLiveChange(['features'], () => refreshFeatures());

        let countRefresh = null;
        onLiveChange(['credit', 'inventory', 'deliveries', 'returns', 'sales'], () => {
            window.clearTimeout(countRefresh);
            countRefresh = window.setTimeout(refreshFeatureCounts, 500);
        });
    }
}

document.addEventListener('DOMContentLoaded', function () {
    window.setTimeout(startFeatures, 0);
});
