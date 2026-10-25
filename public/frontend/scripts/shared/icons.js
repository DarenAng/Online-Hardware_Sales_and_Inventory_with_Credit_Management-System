function setUpIcons() {
    const BUTTON_PHRASES = [
        ['sign in', 'log-in'],
        ['sign out', 'log-out'],
        ['log out', 'log-out'],
        ['change password', 'key-round'],
        ['credit settlement', 'banknote'],
        ['record the payment', 'banknote'],
        ['record payment', 'banknote'],
        ['back to', 'arrow-left'],
        ['mark resolved', 'square-check-big'],
        ['print / pdf', 'printer'],
        ['print pdf', 'file-text']
    ];

    const BUTTON_WORDS = {
        save: 'check', apply: 'check', confirm: 'circle-check-big',
        approve: 'circle-check', accept: 'circle-check',
        decline: 'circle-x', reject: 'circle-x',
        cancel: 'x', close: 'x',
        print: 'printer', spreadsheet: 'file-spreadsheet', excel: 'file-spreadsheet',
        export: 'download', download: 'download', upload: 'upload', import: 'upload',
        add: 'plus', new: 'plus', create: 'plus',
        edit: 'square-pen', update: 'square-pen',
        archive: 'archive', restore: 'rotate-ccw', reset: 'rotate-ccw',
        delete: 'trash-2', remove: 'trash-2',
        search: 'search', find: 'search', review: 'search', filter: 'filter', clear: 'eraser',
        load: 'rotate-cw', refresh: 'rotate-cw', reload: 'rotate-cw',
        back: 'arrow-left', previous: 'arrow-left', prev: 'arrow-left', next: 'arrow-right',
        send: 'send', submit: 'send', tell: 'message-circle-more',
        show: 'eye', view: 'eye', hide: 'eye-off',
        receive: 'package-open', void: 'ban', mark: 'square-check-big',
        backup: 'database-backup', generate: 'settings',
        pay: 'banknote', collect: 'hand-coins', record: 'book-plus',
        deliver: 'truck', dispatch: 'truck', assign: 'user-check',
        lock: 'lock', unlock: 'lock-open'
    };

    const TRAILING = ['next'];

    const KPI_ICONS = [
        [/refund/i, 'rotate-ccw'],
        [/collect/i, 'coins'],
        [/average/i, 'calculator'],
        [/units/i, 'package'],
        [/purchase/i, 'shopping-bag'],
        [/order/i, 'shopping-cart'],
        [/transaction/i, 'receipt'],
        [/sales|gross|income|revenue/i, 'trending-up'],
        [/credit|balance|receivable|unpaid/i, 'wallet'],
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
        for (let i = 0; i < BUTTON_PHRASES.length; i++) {
            const phrase = BUTTON_PHRASES[i][0];
            const icon = BUTTON_PHRASES[i][1];
            if (text === phrase || text.startsWith(phrase + ' ')) return icon;
        }
        const first = (text.match(/^[a-z]+/) || [''])[0];
        return BUTTON_WORDS[first] || null;
    }

    function setIcon(element, name, extraClass, atEnd) {
        let icon = element.querySelector(':scope > i.icon-auto');
        if (!name) {
            if (icon) icon.remove();
            return;
        }
        const className = 'icon icon-' + name + ' icon-auto' + (extraClass ? ' ' + extraClass : '');
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

    function sidebarIcon(label) {
        const wanted = label.replace(/\s+/g, ' ').trim().toLowerCase();
        const links = document.querySelectorAll('.sidebar-nav a');
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
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
        const match = icon.className.match(/(?:^|\s)icon-(?!auto\b)([a-z0-9-]+)/);
        return match ? match[1] : null;
    }

    function decorateButtons() {
        const buttons = document.querySelectorAll('button, a.btn');
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            if (button.closest('[data-no-icon], .sidebar-nav, .sidebar-brand')) continue;
            if (button.querySelector('svg, img, i.icon:not(.icon-auto)')) continue;
            if (button.classList.contains('subnav-tab')) {
                setIcon(button, sidebarIcon(button.textContent), 'tab-icon');
                continue;
            }
            const first = (words(button).match(/^[a-z]+/) || [''])[0];
            const atEnd = TRAILING.indexOf(first) !== -1 && !button.hasAttribute('data-icon');
            setIcon(button, iconForButton(button), atEnd ? 'btn-icon btn-icon-end' : 'btn-icon', atEnd);
        }
    }

    function decorateTitles() {
        const titles = document.querySelectorAll('.topbar-title');
        for (let i = 0; i < titles.length; i++) {
            const title = titles[i];
            let name = sidebarIcon(title.textContent);
            if (!name) {
                const active = document.querySelector('.sidebar-nav .nav-sub a.active .nav-icon') ||
                               document.querySelector('.sidebar-nav a.active .nav-icon');
                name = active ? iconName(active) : null;
            }
            let icon = title.previousElementSibling;
            if (!icon || !icon.classList.contains('title-icon')) {
                if (!name) continue;
                icon = document.createElement('i');
                icon.setAttribute('aria-hidden', 'true');
                title.parentNode.insertBefore(icon, title);
            }
            const className = name ? 'icon icon-' + name + ' title-icon' : 'icon title-icon';
            if (icon.className !== className) icon.className = className;
            icon.hidden = !name;
        }
    }

    function decorateCards() {
        const labels = document.querySelectorAll('.kpi-label');
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const text = label.textContent;
            let iconNameFound = null;
            for (let k = 0; k < KPI_ICONS.length; k++) {
                if (KPI_ICONS[k][0].test(text)) {
                    iconNameFound = KPI_ICONS[k][1];
                    break;
                }
            }
            setIcon(label, iconNameFound, 'kpi-icon');
        }
    }

    function decorate() {
        decorateButtons();
        decorateTitles();
        decorateCards();
    }

    let queued = false;
    function queue() {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(function () {
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
}

setUpIcons();
