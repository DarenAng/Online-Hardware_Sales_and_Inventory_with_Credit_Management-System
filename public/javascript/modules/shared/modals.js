// modals.js  --  MODALS
// Loaded by: all five dashboards
// ------------------------------------------------------------------------
// ==========================================
// MODALS
// ==========================================
function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('open');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
}

function closeModalOnBackdrop(event, id) {
    if (event.target === event.currentTarget) closeModal(id);
}

// ==========================================
// THE POPUPS THAT DO NOT CLOSE BY ACCIDENT
//
// A backdrop click and Escape are both good ways out of a popup somebody is
// only reading: the record they opened is still on the server, and reopening
// it costs a click. They are the wrong way out of a popup somebody has been
// typing into. A misjudged click beside the delivery form threw away an
// address and a phone number that only existed in that box, with no undo and
// no warning, and the fix is not to warn about it but to stop the stray click
// counting as an answer at all.
//
// A modal marked data-modal-locked therefore ignores both, and has to be
// closed by one of its own buttons. It is opt-in rather than the default,
// because every read-only popup in the system is better off dismissable.
// ==========================================
function isModalLocked(modal) {
    return !!modal && modal.hasAttribute('data-modal-locked');
}

document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    document.querySelectorAll('.modal.open').forEach((modal) => {
        if (!isModalLocked(modal)) modal.classList.remove('open');
    });
});
