// icons.js -- the Bootstrap Icons that are put in by script
// Loaded by: every page, right after Bootstrap (icons from vendor/bootstrap-icons/)
//
// The sidebar and the sign-in fields have their icons written in the HTML.
// Everything else is drawn by the page scripts after the page loads, so the
// icons for those are added here, and added again whenever the page changes:
//
//   buttons          by the button's first words: "Save ..." gets a tick,
//                    "Print ..." a printer (BUTTON_PHRASES and BUTTON_WORDS)
//   the screen tabs  the same icon as the sidebar entry they copy
//   the page title   the icon of the sidebar entry for the screen showing
//   summary cards    by the card's label (KPI_ICONS)
//
// A button can choose its own icon or refuse one:
//   <button data-icon="star">        <button data-no-icon>
// data-no-icon on a container (a table, a form) refuses it for every button inside.
//
// The icons are empty <i> tags drawn by the icon font, so they add no text:
// button.textContent and every label a script reads stay exactly as they were.

(function () {
    // whole phrases first: "Sign in" and "Sign out" share a first word
    const BUTTON_PHRASES = [
        ['sign in', 'box-arrow-in-right'],
        ['sign out', 'box-arrow-right'],
        ['log out', 'box-arrow-right'],
        ['change password', 'key'],
        ['take a payment', 'cash'],
        ['record the payment', 'cash'],
        ['record payment', 'cash'],
        ['back to', 'arrow-left'],
        ['mark resolved', 'check2-square'],
        ['print / pdf', 'printer'],
        ['print pdf', 'file-earmark-pdf']
    ];

    const BUTTON_WORDS = {
        save: 'check2', apply: 'check2', confirm: 'check2-circle',
        approve: 'check-circle', accept: 'check-circle',
        decline: 'x-circle', reject: 'x-circle',
        cancel: 'x-lg', close: 'x-lg',
        print: 'printer', spreadsheet: 'file-earmark-spreadsheet', excel: 'file-earmark-spreadsheet',
        export: 'download', download: 'download', upload: 'upload', import: 'upload',
        add: 'plus-lg', new: 'plus-lg', create: 'plus-lg',
        edit: 'pencil-square', update: 'pencil-square',
        archive: 'archive', restore: 'arrow-counterclockwise', reset: 'arrow-counterclockwise',
        delete: 'trash', remove: 'trash',
        search: 'search', find: 'search', review: 'search', filter: 'funnel', clear: 'eraser',
        load: 'arrow-clockwise', refresh: 'arrow-clockwise', reload: 'arrow-clockwise',
        back: 'arrow-left', previous: 'arrow-left', prev: 'arrow-left', next: 'arrow-right',
        send: 'send', submit: 'send', tell: 'chat-dots',
        show: 'eye', view: 'eye', hide: 'eye-slash',
        receive: 'box-arrow-in-down', void: 'slash-circle', mark: 'check2-square',
        backup: 'database-down', generate: 'gear',
        pay: 'cash', collect: 'cash-coin', record: 'journal-plus',
        deliver: 'truck', dispatch: 'truck', assign: 'person-check',
        lock: 'lock', unlock: 'unlock'
    };

    // words whose icon reads better after them: "Next ->"
    const TRAILING = new Set(['next']);

    // a summary card's label, matched by the words in it
    const KPI_ICONS = [
        [/refund/i, 'arrow-counterclockwise'],
        [/collect/i, 'cash-stack'],
        [/average/i, 'calculator'],
        [/units/i, 'box-seam'],
        [/purchase/i, 'bag'],
        [/order/i, 'cart3'],
        [/transaction/i, 'receipt'],
        [/sales|gross|income|revenue/i, 'graph-up-arrow'],
        [/credit|balance|receivable|unpaid/i, 'wallet2'],
        [/stock|material/i, 'boxes'],
        [/deliver/i, 'truck'],
        [/offline/i, 'wifi-off']
    ];

    function words(element) {
        return element.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function iconForButton(button) {
        if (button.hasAttribute('data-icon')) return button.getAttribute('data-icon') || null;
        const text = words(button);
        for (const [phrase, icon] of BUTTON_PHRASES) {
            if (text === phrase || text.startsWith(phrase + ' ')) return icon;
        }
        const first = (text.match(/^[a-z]+/) || [''])[0];
        return BUTTON_WORDS[first] || null;
    }

    // Put icon `name` first inside `element`, or change or remove the one
    // already there. Only the icon this file added is ever touched.
    function setIcon(element, name, extraClass, atEnd) {
        let icon = element.querySelector(':scope > i.bi-auto');
        if (!name) {
            if (icon) icon.remove();
            return;
        }
        const className = 'bi bi-' + name + ' bi-auto' + (extraClass ? ' ' + extraClass : '');
        if (icon) {
            if (icon.className !== className) icon.className = className;
            return;
        }
        icon = document.createElement('i');
        icon.className = className;
        icon.setAttribute('aria-hidden', 'true');
        if (atEnd) element.appendChild(icon);
        else element.insertBefore(icon, element.firstChild);
    }

    // the icon a sidebar entry carries, found by the entry's words (a heading's
    // caret is not part of its words)
    function sidebarIcon(label) {
        const wanted = label.replace(/\s+/g, ' ').trim().toLowerCase();
        for (const link of document.querySelectorAll('.sidebar-nav a')) {
            const icon = link.querySelector('.nav-icon');
            if (!icon) continue;
            const caret = link.querySelector('.nav-caret');
            let text = words(link);
            if (caret) text = text.replace(words(caret), '').trim();
            if (text === wanted) return iconName(icon);
        }
        return null;
    }

    function iconName(icon) {
        const match = icon.className.match(/\bbi-(?!auto\b)([a-z0-9-]+)/);
        return match ? match[1] : null;
    }

    function decorateButtons() {
        document.querySelectorAll('button, a.btn').forEach((button) => {
            if (button.closest('[data-no-icon], .sidebar-nav, .sidebar-brand')) return;
            // a button that already shows a picture of its own keeps it
            if (button.querySelector('svg, img, i.bi:not(.bi-auto)')) return;
            if (button.classList.contains('subnav-tab')) {
                setIcon(button, sidebarIcon(button.textContent), 'tab-icon');
                return;
            }
            const first = (words(button).match(/^[a-z]+/) || [''])[0];
            const atEnd = TRAILING.has(first) && !button.hasAttribute('data-icon');
            setIcon(button, iconForButton(button), atEnd ? 'btn-icon btn-icon-end' : 'btn-icon', atEnd);
        });
    }

    // The title is a sibling icon, not one inside it: the page scripts set the
    // title with textContent, which would wipe an icon inside.
    function decorateTitles() {
        document.querySelectorAll('.topbar-title').forEach((title) => {
            let name = sidebarIcon(title.textContent);
            if (!name) {
                const active = document.querySelector('.sidebar-nav .nav-sub a.active .nav-icon') ||
                               document.querySelector('.sidebar-nav a.active .nav-icon');
                name = active ? iconName(active) : null;
            }
            let icon = title.previousElementSibling;
            if (!icon || !icon.classList.contains('title-icon')) {
                if (!name) return;
                icon = document.createElement('i');
                icon.setAttribute('aria-hidden', 'true');
                title.parentNode.insertBefore(icon, title);
            }
            const className = name ? 'bi bi-' + name + ' title-icon' : 'bi title-icon';
            if (icon.className !== className) icon.className = className;
            icon.hidden = !name;
        });
    }

    function decorateCards() {
        document.querySelectorAll('.kpi-label').forEach((label) => {
            const text = label.textContent;
            const match = KPI_ICONS.find(([pattern]) => pattern.test(text));
            setIcon(label, match ? match[1] : null, 'kpi-icon');
        });
    }

    function decorate() {
        decorateButtons();
        decorateTitles();
        decorateCards();
    }

    // Many changes arrive at once (a table of rows with buttons); one pass per
    // frame covers them all. The pass's own changes cause one more pass, which
    // finds nothing to do, so it never loops.
    let queued = false;
    function queue() {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(() => {
            queued = false;
            decorate();
        });
    }

    function start() {
        decorate();
        if (typeof MutationObserver === 'function') {
            new MutationObserver(queue).observe(document.body, {
                childList: true, subtree: true, characterData: true
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
