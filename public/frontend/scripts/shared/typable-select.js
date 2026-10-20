// typable-select.js -- every filter dropdown can be typed in
// Loaded by: all five dashboards
//
// A <select> in a toolbar filter (.toolbar-field) gets a text box in front of
// it, like the Month box on Total Purchases: press it for the whole list, or
// type and the list narrows to the choices with a word starting with what was
// typed ("cr" finds "Credit approved" and "Credit payment"). Enter, a click or
// the arrow keys pick one; Escape puts the box back; the x returns to the first
// choice ("Every ...").
//
// The <select> stays in the page, out of sight, and still holds the value: a
// pick sets it and fires its change event, so every filter's own onchange (and
// tables.js) runs as before. Code that sets select.value, or fills the options
// again, is followed by the box. A <select> marked data-no-typing is left alone.

const TYPABLE_SELECTOR = '.toolbar-field select:not([multiple]):not([data-no-typing])';

let typableCount = 0;

// the words of a choice, for matching what is typed
function typableWords(text) {
    return String(text || '').toLowerCase().split(/[\s()\-\/,.]+/).filter(Boolean);
}

// every typed word starts one of the choice's words
function typableMatches(label, typed) {
    const typedWords = typableWords(typed);
    if (typedWords.length === 0) return true;
    const words = typableWords(label);
    for (let i = 0; i < typedWords.length; i++) {
        let found = false;
        for (let w = 0; w < words.length && !found; w++) {
            if (words[w].startsWith(typedWords[i])) found = true;
        }
        if (!found) return false;
    }
    return true;
}

function makeTypable(select) {
    if (!select || select.dataset.typable) return;
    select.dataset.typable = '1';
    typableCount++;

    const boxId = (select.id || 'typable-' + typableCount) + '-type';
    const listId = boxId + '-list';

    const wrap = document.createElement('div');
    wrap.className = 'suggest-wrap typable-wrap';

    const box = document.createElement('input');
    box.type = 'text';
    box.id = boxId;
    box.className = 'form-control typable-box';
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-autocomplete', 'list');
    box.setAttribute('aria-controls', listId);
    box.setAttribute('aria-expanded', 'false');
    if (select.title) box.title = select.title;

    const caret = document.createElement('span');
    caret.className = 'typable-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = '<span>&#9660;</span>';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'suggest-clear typable-clear';
    clear.tabIndex = -1;
    clear.setAttribute('aria-label', 'Show every choice');
    clear.innerHTML = '&times;';
    clear.hidden = true;

    const list = document.createElement('ul');
    list.className = 'suggest-list typable-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(box);
    wrap.appendChild(caret);
    wrap.appendChild(clear);
    wrap.appendChild(list);
    select.classList.add('typable-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // the label now names the box
    if (select.id) {
        const label = document.querySelector('label[for="' + select.id + '"]');
        if (label) label.htmlFor = boxId;
    }

    let shown = [];      // the options in the list now
    let active = -1;     // the one the arrow keys are on

    function currentLabel() {
        const option = select.options[select.selectedIndex];
        return option ? option.textContent.trim() : '';
    }

    // the box shows the choice in force (not while its list is open and being
    // typed in), and the x shows off the first choice
    function sync() {
        if (document.activeElement !== box || list.hidden) box.value = currentLabel();
        clear.hidden = select.selectedIndex <= 0 || select.disabled;
        box.disabled = select.disabled;
        wrap.hidden = select.hidden;
    }

    function hide() {
        list.hidden = true;
        box.setAttribute('aria-expanded', 'false');
        box.removeAttribute('aria-activedescendant');
        active = -1;
    }

    function setActive(index) {
        const items = list.querySelectorAll('.suggest-item[role="option"]');
        for (let i = 0; i < items.length; i++) items[i].classList.toggle('is-active', i === index);
        active = index;
        if (index >= 0 && items[index]) {
            box.setAttribute('aria-activedescendant', items[index].id);
            const item = items[index];
            if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
            else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
                list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
            }
        } else {
            box.removeAttribute('aria-activedescendant');
        }
    }

    // openAll: the whole list, with the choice in force in view
    function suggest(openAll) {
        const typed = openAll || box.value.trim() === currentLabel() ? '' : box.value;
        shown = [];
        for (let i = 0; i < select.options.length; i++) {
            const option = select.options[i];
            if (option.disabled || option.hidden) continue;
            if (typableMatches(option.textContent, typed)) shown.push(option);
        }

        list.textContent = '';
        if (shown.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'suggest-item is-empty';
            empty.innerHTML = '<span class="suggest-name">No choice matches</span>';
            list.appendChild(empty);
        }
        for (let i = 0; i < shown.length; i++) {
            const item = document.createElement('li');
            item.className = 'suggest-item' + (shown[i].selected ? ' is-current' : '');
            item.id = listId + '-' + i;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', shown[i].selected ? 'true' : 'false');
            const name = document.createElement('span');
            name.className = 'suggest-name';
            name.textContent = shown[i].textContent.trim();
            item.appendChild(name);
            // mousedown, so the pick lands before the box loses focus and closes the list
            item.addEventListener('mousedown', function (event) {
                event.preventDefault();
                pick(shown[i]);
            });
            list.appendChild(item);
        }

        list.hidden = false;
        box.setAttribute('aria-expanded', 'true');
        active = -1;
        const current = list.querySelector('.is-current');
        if (openAll && current) {
            list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2;
        } else {
            list.scrollTop = 0;
        }
        // typed text: the first match is ready for Enter
        if (!openAll && typed.trim() !== '' && shown.length > 0) setActive(0);
    }

    function pick(option) {
        hide();
        const changed = select.value !== option.value;
        select.value = option.value;
        box.value = currentLabel();
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
    }

    box.addEventListener('focus', function () {
        box.select();
        suggest(true);
    });
    box.addEventListener('click', function () {
        if (list.hidden) suggest(true);
    });
    box.addEventListener('input', function () { suggest(false); });
    box.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (list.hidden) { suggest(true); return; }
            if (shown.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            let next = active + step;
            if (next < 0) next = shown.length - 1;
            if (next >= shown.length) next = 0;
            setActive(next);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (!list.hidden && active >= 0 && shown[active]) pick(shown[active]);
            else if (!list.hidden && shown.length > 0 && box.value.trim() !== '') pick(shown[0]);
            else hide();
        } else if (event.key === 'Escape') {
            if (!list.hidden) event.stopPropagation();
            hide();
            box.value = currentLabel();
            box.select();
        } else if (event.key === 'Tab') {
            hide();
        }
    });
    // leaving the box: typed text that names a choice exactly picks it; anything else is put back
    box.addEventListener('blur', function () {
        const typed = box.value.trim().toLowerCase();
        hide();
        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].textContent.trim().toLowerCase() === typed && typed !== currentLabel().toLowerCase()) {
                pick(select.options[i]);
                return;
            }
        }
        box.value = currentLabel();
    });

    caret.addEventListener('mousedown', function (event) {
        event.preventDefault();
        if (list.hidden) box.focus();
        else hide();
    });
    clear.addEventListener('mousedown', function (event) { event.preventDefault(); });
    clear.addEventListener('click', function () {
        if (select.options.length > 0) pick(select.options[0]);
    });

    // the select is still the one the page's code talks to: follow it
    select.addEventListener('change', sync);
    const valueOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const indexOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    Object.defineProperty(select, 'value', {
        configurable: true,
        get: function () { return valueOf.get.call(this); },
        set: function (value) { valueOf.set.call(this, value); sync(); }
    });
    Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get: function () { return indexOf.get.call(this); },
        set: function (value) { indexOf.set.call(this, value); sync(); }
    });
    new MutationObserver(sync).observe(select, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['disabled', 'hidden', 'selected']
    });

    sync();
}

function makeTypableIn(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches(TYPABLE_SELECTOR)) makeTypable(root);
    const selects = root.querySelectorAll(TYPABLE_SELECTOR);
    for (let i = 0; i < selects.length; i++) makeTypable(selects[i]);
}

// the toolbars in the page, and any drawn later (the delivery schedule's)
document.addEventListener('DOMContentLoaded', function () {
    makeTypableIn(document.body);
    new MutationObserver(function (changes) {
        for (let i = 0; i < changes.length; i++) {
            const added = changes[i].addedNodes;
            for (let n = 0; n < added.length; n++) {
                if (added[n].nodeType === 1) makeTypableIn(added[n]);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
});
