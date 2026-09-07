// ==========================================================================
// THIS FILE HAS MOVED
//
// Everything that used to live here is now in javascript/modules/, one file
// per module, and each page loads only the files it needs:
//
//   modules/shared/           what every screen uses
//     helpers.js              the menu, tab switching, escaping, API headers
//     format.js               money, badges, dates, the one fetch
//     ui-kit.js               popup cards, and the ask card
//     tables.js               column alignment, and column names on a phone
//     modals.js               open, close, backdrop, Escape
//     detail-modal.js         the paged record popup
//     session.js              signing in, and the role guard
//     topbar.js               the bell and the account chip
//     my-account.js           my credentials
//     notifications.js        the alert list
//     deliveries.js           the delivery record, shared by three roles
//
//   modules/system-admin.js         system.html
//   modules/manager.js              manager-dashboard.html
//   modules/inventory-clerk.js      inventory-dashboard.html
//   modules/cashier.js              cashier-dashboard.html
//   modules/delivery-personnel.js   delivery.html
//
// No page loads this file any more. It is left in place so that anyone
// opening it, or following an old link, finds out where the code went.
// The version that held all 4,780 lines is in the project's git history:
//
//     git log --oneline -- public/javascript/app.js
//     git show <commit>:public/javascript/app.js > app-old.js
// ==========================================================================

console.warn(
    'app.js has been split into javascript/modules/. This file is a signpost ' +
    'and does nothing. Each page loads its own module files directly.'
);
