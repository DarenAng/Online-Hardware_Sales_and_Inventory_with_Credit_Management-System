function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('open');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
}

function closeModalOnBackdrop(event, id) {
}

function isModalLocked(modal) {
    return Boolean(modal) && modal.hasAttribute('data-modal-locked');
}

const modalCloseGuards = {};
const modalCloseAsking = {};

function setModalCloseGuard(id, guard) {
    modalCloseGuards[id] = guard;
}

async function requestCloseModal(id) {
    const modal = document.getElementById(id);
    if (!modal || !modal.classList.contains('open')) return true;

    const guard = modalCloseGuards[id];
    if (guard) {
        if (modalCloseAsking[id]) return false;
        modalCloseAsking[id] = true;
        let allowed = false;
        try { allowed = await guard(); } finally { modalCloseAsking[id] = false; }
        if (!allowed) return false;
    }
    closeModal(id);
    return true;
}

const formStarts = {};

function formSnapshot(root) {
    if (!root) return '';
    const boxes = root.querySelectorAll('input, select, textarea');
    let text = '';
    for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.type === 'button' || box.type === 'submit' || box.hasAttribute('data-untracked')) continue;
        if (box.type === 'checkbox' || box.type === 'radio') {
            text += (box.id || box.name) + '=' + box.checked + '\n';
        } else {
            text += (box.id || box.name) + '=' + box.value + '\n';
        }
    }
    return text;
}

function rememberForm(key, root) {
    formStarts[key] = formSnapshot(root);
}

function formChanged(key, root) {
    return formStarts[key] !== undefined && formStarts[key] !== formSnapshot(root);
}

function askDiscard(what) {
    return askConfirm('Are you sure you want to discard ' + what + '? What you entered will be lost.', {
        title: 'Discard ' + what + '?',
        eyebrow: 'Unsaved work',
        mark: '!',
        tone: 'danger',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing'
    });
}

function guardModal(id, what, alsoChanged) {
    const modal = document.getElementById(id);
    if (!modal) return;
    rememberForm(id, modal);
    setModalCloseGuard(id, function () {
        if (!formChanged(id, modal) && !(alsoChanged && alsoChanged())) return true;
        return askDiscard(typeof what === 'function' ? what() : what);
    });
}

function unguardModal(id) {
    delete modalCloseGuards[id];
    delete formStarts[id];
}

function panelShowing(panelId) {
    const panel = document.getElementById(panelId);
    return Boolean(panel) && panel.style.display !== 'none';
}

function watchPanelLeave(options) {
    let passing = false;
    document.addEventListener('click', async function (event) {
        if (passing || !event.target.closest || !options.hasWork()) return;

        const link = event.target.closest('.sidebar a, #notif-modal .modal-foot .btn, #stock-banner .btn');
        if (!link || link.classList.contains('nav-parent') || event.target.closest('.nav-caret')) return;
        if (link.dataset.panelLink === options.panelId) return;
        if (event.target.closest('#' + options.panelId)) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        if (!(await askDiscard(options.what()))) return;

        options.discard();
        passing = true;
        try { link.click(); } finally { passing = false; }
    }, true);

    window.addEventListener('beforeunload', function (event) {
        if (!localStorage.getItem('currentUser')) return;
        if (!options.hasWork()) return;
        event.preventDefault();
        event.returnValue = '';
    });
}

document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    const question = document.getElementById('ask-modal');
    if (question && question.classList.contains('open') && typeof closeAsk === 'function') {
        closeAsk(false);
        event.stopImmediatePropagation();
        return;
    }

    const openModals = document.querySelectorAll('.modal.open');
    for (let i = 0; i < openModals.length; i++) {
        const modal = openModals[i];
        if (isModalLocked(modal)) continue;
        if (modalCloseGuards[modal.id]) {
            requestCloseModal(modal.id);
        } else {
            modal.classList.remove('open');
        }
    }
});

const PAGE_GAP = 48;

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

function modalBodyFits(body) {
    return body.scrollHeight <= body.clientHeight + 1;
}

function boxBeingTypedIn(modal) {
    const active = document.activeElement;
    if (!active || !modal.contains(active)) return null;
    if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT') {
        return active;
    }
    return null;
}

function paginateModal(modal, resetPage) {
    const typing = modal && modal.classList.contains('open') ? boxBeingTypedIn(modal) : null;
    if (typing && !resetPage) return;

    layoutModalPages(modal, resetPage);

    if (typing && document.activeElement !== typing) {
        typing.focus({ preventScroll: true });
    }
}

function layoutModalPages(modal, resetPage) {
    if (!modal || !modal.classList.contains('open')) {
        if (modal) {
            unpaginateModal(modal);
            delete modal._pages;
            const box = modal.querySelector('.modal-box');
            if (box) box.classList.remove('modal-roomy');
        }
        return;
    }
    const body = modalBodyOf(modal);
    if (!body) return;
    if (modalSizer) modalSizer.observe(body);

    const previous = modal._pages;
    unpaginateModal(modal);

    if (modal.hasAttribute('data-modal-scroll')) { delete modal._pages; return; }

    if (modalBodyFits(body)) { delete modal._pages; return; }

    const box = modal.querySelector('.modal-box');
    if (box && !box.classList.contains('modal-roomy')) {
        box.classList.add('modal-roomy');
        if (modalBodyFits(body)) { delete modal._pages; return; }
    }

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

    const stride = width + PAGE_GAP;
    const wrapRect = wrap.getBoundingClientRect();
    const scale = wrapRect.width > 0 ? wrapRect.width / width : 1;
    let count = 1;
    for (let c = 0; c < wrap.children.length; c++) {
        const rects = wrap.children[c].getClientRects();
        for (let r = 0; r < rects.length; r++) {
            const rect = rects[r];
            if (rect.width === 0 && rect.height === 0) continue;
            count = Math.max(count, Math.floor((rect.left - wrapRect.left + 1) / (stride * scale)) + 1);
        }
    }
    if (wrap.children.length === 0) {
        count = Math.max(count, Math.floor((wrap.scrollWidth - 1) / stride) + 1);
    }

    if (count <= 1) { unpaginateModal(modal); delete modal._pages; return; }

    let page = 0;
    if (!resetPage && previous) page = Math.min(previous.page, count - 1);
    modal._pages = { page: page, count: count, stride: stride };

    const pager = document.createElement('div');
    pager.className = 'modal-pager pager';
    pager.innerHTML =
        '<span class="pager-info" data-page-info></span>' +
        '<div class="pager-controls">' +
            '<button type="button" class="btn btn-sm" data-page-back aria-label="Previous page">Previous</button>' +
            '<button type="button" class="btn btn-sm" data-page-next aria-label="Next page">Next</button>' +
        '</div>';
    pager.querySelector('[data-page-back]').onclick = function () {
        turnModalPage(modal, -1);
    };
    pager.querySelector('[data-page-next]').onclick = function () {
        turnModalPage(modal, 1);
    };
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

const pendingModals = [];

function schedulePaginate(modal, resetPage) {
    let entry = null;
    for (let i = 0; i < pendingModals.length; i++) {
        if (pendingModals[i].modal === modal) {
            entry = pendingModals[i];
            break;
        }
    }
    const already = entry !== null;
    if (!already) {
        entry = { modal: modal, reset: false };
        pendingModals.push(entry);
    }
    entry.reset = Boolean(resetPage) || entry.reset;
    if (already || pendingModals.length > 1) return;
    setTimeout(function () {
        const batch = pendingModals.slice();
        pendingModals.length = 0;
        for (let i = 0; i < batch.length; i++) {
            paginateModal(batch[i].modal, batch[i].reset);
        }
        modalWatcher.takeRecords();
    });
}

const modalWatcher = new MutationObserver(function (records) {
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target) continue;

        if (record.type === 'attributes' && target.classList.contains('modal')) {
            if (record.attributeName === 'class') schedulePaginate(target, true);
            continue;
        }
        const modal = target.closest('.modal');
        if (!modal || !modal.classList.contains('open')) continue;
        if (target.closest('.modal-pager')) continue;
        if (target.classList.contains('modal-pages')) continue;

        const body = modalBodyOf(modal);
        const wrap = body && body.querySelector(':scope > .modal-pages');
        const pageRoot = wrap || body;
        const topLevel = target.parentElement === pageRoot;

        if (record.type === 'attributes' && record.attributeName === 'class' && !topLevel) continue;

        const wholePage = target === body || target === wrap ||
            (topLevel && (record.type === 'attributes' || record.removedNodes.length > 0));
        schedulePaginate(modal, wholePage);
    }
});

modalWatcher.observe(document.documentElement, {
    childList: true, characterData: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden'],
});

let modalSizer;
if (typeof ResizeObserver === 'function') {
    modalSizer = new ResizeObserver(function (entries) {
        for (let i = 0; i < entries.length; i++) {
            const modal = entries[i].target.closest('.modal');
            if (modal && modal.classList.contains('open')) schedulePaginate(modal, false);
        }
    });
} else {
    modalSizer = null;
}

window.addEventListener('resize', function () {
    const openModals = document.querySelectorAll('.modal.open');
    for (let i = 0; i < openModals.length; i++) {
        schedulePaginate(openModals[i], false);
    }
});

document.addEventListener('focusout', function (event) {
    const modal = event.target.closest ? event.target.closest('.modal.open') : null;
    if (modal) schedulePaginate(modal, false);
});
