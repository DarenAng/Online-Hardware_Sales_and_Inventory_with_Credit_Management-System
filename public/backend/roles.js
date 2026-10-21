const ADMIN = "System Administrator";
const MANAGER = "Manager";
const CLERK = "Inventory Clerk";
const CASHIER = "Cashier";
const DRIVER = "Delivery Personnel";

const MANAGEMENT = [ADMIN, MANAGER];
const STAFF = [CLERK, CASHIER, DRIVER];

const PAGE_ROLES = {
  "/system.html":              [ADMIN],
  "/manager.html":             [MANAGER],
  "/inventory-dashboard.html": [CLERK],
  "/cashier-dashboard.html":   [CASHIER],
  "/delivery.html":            [DRIVER]
};

const ROLE_PAGES = {};
ROLE_PAGES[ADMIN] = "/system.html";
ROLE_PAGES[MANAGER] = "/manager.html";
ROLE_PAGES[CLERK] = "/inventory-dashboard.html";
ROLE_PAGES[CASHIER] = "/cashier-dashboard.html";
ROLE_PAGES[DRIVER] = "/delivery.html";

module.exports = {
  ADMIN: ADMIN,
  MANAGER: MANAGER,
  CLERK: CLERK,
  CASHIER: CASHIER,
  DRIVER: DRIVER,
  MANAGEMENT: MANAGEMENT,
  STAFF: STAFF,
  PAGE_ROLES: PAGE_ROLES,
  ROLE_PAGES: ROLE_PAGES
};
