// modals.js -- modals
// Loaded by: all five dashboards
function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('open');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
}

// A click on the backdrop does nothing: a misjudged click must not discard a
// form. Kept because seventeen modals name it from their markup.
function closeModalOnBackdrop(event, id) {
}

// Escape still closes a card unless it is marked data-modal-locked.
function isModalLocked(modal) {
    return !!modal && modal.hasAttribute('data-modal-locked');
}

// A card with something to lose can ask first. The guard is a function that
// answers true (or a promise of true) when the card may close; "Discard your
// changes?" is one. It is asked when a person closes the card (the x button
// or Escape, through requestCloseModal) and never when the page itself closes
// it with closeModal after an action, so a saved form is not questioned.
const modalCloseGuards = {};      // modal id -> guard
const modalCloseAsking = {};      // modal id -> a guard is being answered

function setModalCloseGuard(id, guard) {
    modalCloseGuards[id] = guard;
}

async function requestCloseModal(id) {
    const modal = document.getElementById(id);
    if (!modal || !modal.classList.contains('open')) return true;

    const guard = modalCloseGuards[id];
    if (guard) {
        if (modalCloseAsking[id]) return false;   // the question is already on screen
        modalCloseAsking[id] = true;
        let allowed = false;
        try { allowed = await guard(); } finally { modalCloseAsking[id] = false; }
        if (!allowed) return false;
    }
    closeModal(id);
    return true;
}

document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    // a question card (confirm, discard) is the one on top: Escape answers
    // "no" to it and leaves the cards beneath alone (and stops the page's other
    // Escape listeners, such as a drawer, from also reading this key)
    const question = document.getElementById('ask-modal');
    if (question && question.classList.contains('open') && typeof closeAsk === 'function') {
        closeAsk(false);
        event.stopImmediatePropagation();
        return;
    }

    document.querySelectorAll('.modal.open').forEach((modal) => {
        if (isModalLocked(modal)) return;
        if (modalCloseGuards[modal.id]) requestCloseModal(modal.id); else modal.classList.remove('open');
    });
});

// A card does not scroll (unless marked data-modal-scroll); content taller than the body is flowed into pages
// (browser column layout, one column per page) with a pager of its own under
// the content -- "Page 1 of 3" and Previous/Next -- never in the foot, which
// holds the card's actions only.
// Runs again when the card's content changes or the window resizes.
const PAGE_GAP = 48;   // wider than the body's side padding, so the next page never peeks in

function modalBodyOf(modal) {
    return modal.querySelector('.modal-body');
}

function unpaginateModal(modal) {
    const body = modalBodyOf(modal);
    const wrap = body && body.querySelector(':scope > .modal-pages');
    if (wrap) {
        while (wrap.firstChild) body.insertBefore(wrap.firstChild, wrap);
        wrap.remove();
    }
    const pager = modal.querySelector('.modal-pager');
    if (pager) pager.remove();
}

function paginateModal(modal, resetPage) {
    if (!modal || !modal.classList.contains('open')) {
        if (modal) { unpaginateModal(modal); delete modal._pages; }
        return;
    }
    const body = modalBodyOf(modal);
    if (!body) return;
    if (modalSizer) modalSizer.observe(body);

    const previous = modal._pages;
    unpaginateModal(modal);

    // a card marked data-modal-scroll keeps one page and scrolls its body
    if (modal.hasAttribute('data-modal-scroll')) { delete modal._pages; return; }

    if (body.scrollHeight <= body.clientHeight + 1) { delete modal._pages; return; }

    const style = getComputedStyle(body);
    const width  = body.clientWidth  - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = body.clientHeight - parseFloat(style.paddingTop)  - parseFloat(style.paddingBottom);
    if (width <= 0 || height <= 0) return;

    const wrap = document.createElement('div');
    wrap.className = 'modal-pages';
    while (body.firstChild) wrap.appendChild(body.firstChild);
    body.appendChild(wrap);
    wrap.style.height = height + 'px';
    wrap.style.columnGap = PAGE_GAP + 'px';

    // the furthest fragment says how many pages; measured on the same scale as
    // the rects because the opening animation scales the box
    const stride = width + PAGE_GAP;
    const wrapRect = wrap.getBoundingClientRect();
    const scale = wrapRect.width > 0 ? wrapRect.width / width : 1;
    let count = 1;
    Array.from(wrap.children).forEach((child) => {
        Array.from(child.getClientRects()).forEach((rect) => {
            if (rect.width === 0 && rect.height === 0) return;
            count = Math.max(count, Math.floor((rect.left - wrapRect.left + 1) / (stride * scale)) + 1);
        });
    });
    if (wrap.children.length === 0) {
        count = Math.max(count, Math.floor((wrap.scrollWidth - 1) / stride) + 1);
    }

    if (count <= 1) { unpaginateModal(modal); delete modal._pages; return; }

    let page = 0;
    if (!resetPage && previous) page = Math.min(previous.page, count - 1);
    modal._pages = { page, count, stride };

    // the pager sits right under the content it turns
    const pager = document.createElement('div');
    pager.className = 'modal-pager pager';
    pager.innerHTML =
        '<span class="pager-info" data-page-info></span>' +
        '<div class="pager-controls">' +
            '<button type="button" class="btn btn-sm" data-page-back aria-label="Previous page">Previous</button>' +
            '<button type="button" class="btn btn-sm" data-page-next aria-label="Next page">Next</button>' +
        '</div>';
    pager.querySelector('[data-page-back]').onclick = () => turnModalPage(modal, -1);
    pager.querySelector('[data-page-next]').onclick = () => turnModalPage(modal, 1);
    body.insertAdjacentElement('afterend', pager);

    showModalPage(modal);
}

function showModalPage(modal) {
    const state = modal._pages;
    const wrap = modal.querySelector('.modal-body > .modal-pages');
    const pager = modal.querySelector('.modal-pager');
    if (!state || !wrap || !pager) return;

    wrap.style.transform = 'translateX(-' + (state.page * state.stride) + 'px)';
    pager.querySelector('[data-page-info]').textContent = 'Page ' + (state.page + 1) + ' of ' + state.count;
    pager.querySelector('[data-page-back]').disabled = state.page === 0;
    pager.querySelector('[data-page-next]').disabled = state.page >= state.count - 1;
}

function turnModalPage(modal, direction) {
    const state = modal._pages;
    if (!state) return;
    const next = state.page + direction;
    if (next < 0 || next >= state.count) return;
    state.page = next;
    showModalPage(modal);
}

// ---- when to lay the pages out again ----
const pendingPaginate = new Map();   // modal -> go back to page one?

function schedulePaginate(modal, resetPage) {
    const already = pendingPaginate.has(modal);
    pendingPaginate.set(modal, !!resetPage || !!pendingPaginate.get(modal));
    if (already || pendingPaginate.size > 1) return;
    // a timeout rather than a frame: frames stop in a background tab
    setTimeout(() => {
        const batch = Array.from(pendingPaginate.entries());
        pendingPaginate.clear();
        // each entry is [modal, goBackToPageOne]
        for (const entry of batch) {
            paginateModal(entry[0], entry[1]);
        }
        modalWatcher.takeRecords();   // the layout's own edits are not a reason to lay out again
    });
}

const modalWatcher = new MutationObserver((records) => {
    records.forEach((record) => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target) return;

        if (record.type === 'attributes' && target.classList.contains('modal')) {
            if (record.attributeName === 'class') schedulePaginate(target, true);
            return;
        }
        const modal = target.closest('.modal');
        if (!modal || !modal.classList.contains('open')) return;
        if (target.closest('.modal-pager')) return;
        if (target.classList.contains('modal-pages')) return;   // the slide between pages

        // a whole page replaced starts from page one; smaller changes keep the page
        const body = modalBodyOf(modal);
        const wrap = body && body.querySelector(':scope > .modal-pages');
        const pageRoot = wrap || body;
        const topLevel = target.parentElement === pageRoot;

        // deep class changes are ignored: the table module restamps headers on every
        // move, which would lay the pages out for ever
        if (record.type === 'attributes' && record.attributeName === 'class' && !topLevel) return;

        const wholePage = target === body || target === wrap ||
            (topLevel && (record.type === 'attributes' || record.removedNodes.length > 0));
        schedulePaginate(modal, wholePage);
    });
});

modalWatcher.observe(document.documentElement, {
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden'],
});

// the body changing size is the signal, whatever changed it
let modalSizer;
if (typeof ResizeObserver === 'function') {
    modalSizer = new ResizeObserver((entries) => {
            entries.forEach((entry) => {
                const modal = entry.target.closest('.modal');
                if (modal && modal.classList.contains('open')) schedulePaginate(modal, false);
            });
        });
} else {
    modalSizer = null;
}

window.addEventListener('resize', () => {
    document.querySelectorAll('.modal.open').forEach((modal) => schedulePaginate(modal, false));
});
