// ============================================================
// roles.js -- the five roles, and the page each one starts on
// Loaded by: server.js, sessions.js, features.js, access-control.js and routes/shared.js.
// Never sent to a browser.
// ============================================================

// the five roles, spelled exactly as the roles table spells them
const ADMIN = "System Administrator";
const MANAGER = "Manager";
const CLERK = "Inventory Clerk";
const CASHIER = "Cashier";
const DRIVER = "Delivery Personnel";

// the two halves of the shop: the office decides, the floor does
const MANAGEMENT = [ADMIN, MANAGER];
const STAFF = [CLERK, CASHIER, DRIVER];

// A dashboard page is served to its role only, checked here from the session
// cookie before the file server sees the request. No session goes to sign-in;
// the wrong role goes to its own dashboard.
const PAGE_ROLES = {
  "/system.html":              [ADMIN],
  "/manager.html":             [MANAGER],
  "/inventory-dashboard.html": [CLERK],
  "/cashier-dashboard.html":   [CASHIER],
  "/delivery.html":            [DRIVER]
};

// the home page of each role (the reverse of PAGE_ROLES)
const ROLE_PAGES = {};
ROLE_PAGES[ADMIN] = "/system.html";
ROLE_PAGES[MANAGER] = "/manager.html";
ROLE_PAGES[CLERK] = "/inventory-dashboard.html";
ROLE_PAGES[CASHIER] = "/cashier-dashboard.html";
ROLE_PAGES[DRIVER] = "/delivery.html";

module.exports = {
  ADMIN, MANAGER, CLERK, CASHIER, DRIVER, MANAGEMENT, STAFF, PAGE_ROLES, ROLE_PAGES
};
