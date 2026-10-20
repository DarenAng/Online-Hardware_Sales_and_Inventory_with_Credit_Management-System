// ============================================================
// features.js -- screens by role: which screens exist, and which roles hold them
// Loaded by: server.js (handed on to routes/admin.js) and access-control.js.
// Never sent to a browser.
// ============================================================

const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;
const roles = require("./roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const DRIVER = roles.DRIVER;

// ==========================================
// SCREENS BY ROLE
//
// Every entry is one screen: the roles whose page can draw it, the roles that
// hold it by role, and the routes it is made of. The administrator grants or
// revokes a screen per role; an override is one row in role_feature_permissions.
//
// Enforcement in the access hook:
//   revoked  a route is refused when every screen using it is off for the role
//   granted  a route the role table would refuse is allowed when the role
//            holds a screen needing it BY GRANT (not by default)
// Read from the database and cached in memory between writes.
// ==========================================
const FEATURES = [
  // --- selling and the counter ---
  { key: "pos", name: "New Transaction", module: "Point of Sale",
    description: "The register: ring a sale up, take the payment, create the delivery.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["POST", /^\/api\/sales$/], ["POST", /^\/api\/deliveries$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "refunds", name: "Refunds", module: "Point of Sale",
    description: "Take a sold item back and refund it at the counter; the stockroom inspects it before it can be sold again.",
    available: [CASHIER], defaults: [CASHIER],
    // the screen's "Sales in the Past 3 Days" list and a receipt's items
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/],
             ["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/]] },
  { key: "sales-report", name: "Sales Report", module: "Point of Sale",
    description: "The cashier's own sales, by day and by method.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "qr-payments", name: "QR Payments", module: "Point of Sale",
    description: "Every GCash, Maya and bank-transfer payment tried by QR code and how it ended, as a tab of Sales Transactions.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/qr-payments$/]] },
  { key: "daily-summary", name: "Daily Summary", module: "Point of Sale",
    description: "What the till took today.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/cashier\/summary$/]] },

  // --- credit ---
  { key: "credit", name: "Customer Credit", module: "Credit",
    description: "Every credit account and its credit rating; the cashier's copy adds customers and files extension requests, the manager's decides limits.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/customers$/], ["GET", /^\/api\/credit\/customers\/\d+$/],
             ["PUT", /^\/api\/credit\/customers\/\d+\/limit$/], ["GET", /^\/api\/customers\/\d+\/history$/],
             ["GET", /^\/api\/credit\/policy$/],
             ["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests$/],
             ["POST", /^\/api\/customers$/]] },
  { key: "debt-payments", name: "Credit Settlement", module: "Credit",
    description: "Credit Settlement: take a payment against what a customer still owes, sale by sale, from the customer's card, with a receipt for each payment.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/credit\/open-sales$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  // the three printed pieces of a credit account; each button is switched on its own
  { key: "credit-terms-print", name: "Print Credit Terms", module: "Credit",
    description: "Print the Credit Terms and Conditions page for a customer: the store, the customer, the credit limit, the due days and the late-payment rate, the terms and the signature lines. Offered on a credit sale's invoice and on the customer's card.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/terms\/\d+$/]] },
  { key: "customer-card-print", name: "Print Customer Card", module: "Credit",
    description: "Print a customer's card (details, credit limit, balance and rating) with the Credit Terms and Conditions page after it.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/card\/\d+$/]] },
  { key: "credit-terms-text", name: "Credit Terms Wording", module: "Credit",
    description: "Write the terms and conditions that are printed with every credit account (the wording only; the figures come from the account). It is a part of the Credit Maintenance screen, so that screen is needed as well.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/terms-text$/], ["PUT", /^\/api\/credit\/terms-text$/]] },
  // the manager's maintenance page for credit: the shop's late-payment rate (changing it is
  // this screen's alone; reading it is also part of Customer Credit) and, when Credit Terms
  // Wording is held too, the wording of the terms
  { key: "credit-maintenance", name: "Credit Maintenance", module: "Credit",
    description: "Set the late-payment rate the shop charges every credit account, 1 to 3 percent a month, and write the credit terms and conditions, on one page.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/policy$/], ["PUT", /^\/api\/credit\/policy$/]] },
  { key: "credit-requests", name: "Extension Requests", module: "Credit",
    description: "The queue of credit-limit requests waiting for a decision.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests\/\d+\/decide$/]] },

  // --- the manager's reporting ---
  { key: "income", name: "Income", module: "Reports",
    description: "Collected, billed, outstanding and discounts over any period.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/reports\/income$/]] },
  { key: "reports", name: "Reports", module: "Reports",
    description: "Everything staff have filed, plus payment methods, receivables, repeat customers and staff performance.",
    available: [MANAGER], defaults: [MANAGER],
    // the day's tally is the manager's side of the cashier's end-of-shift card
    routes: [["GET", /^\/api\/reports\/activity$/], ["GET", /^\/api\/reports\/overview$/],
             ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "sales", name: "Sales", module: "Reports",
    description: "Every sale rung up, with its lines and its payments.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },

  // --- stock ---
  { key: "material-list", name: "Material List", module: "Inventory",
    description: "Everything on the shelf, with what is in stock, the sizes each material sells in, and the pack it is delivered in.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/summary$/],
             ["POST", /^\/api\/inventory\/products\/\d+\/units$/],
             ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/],
             ["PUT", /^\/api\/inventory\/products\/\d+\/pack$/]] },
  // the Add New Product button on the Material List: a product with a name, a
  // category and a unit, and no price (the manager sets that). It tells the manager.
  { key: "product-add", name: "Add New Product", module: "Inventory",
    description: "Open a record for a product the shop has never stocked, from the Material List. It starts with no price and no stock; the manager is told and sets the price, and until then the till cannot sell it.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/materials$/]] },
  { key: "stock-adjustment", name: "Stock Adjustment", module: "Inventory",
    description: "Correct a stock figure by hand, and check a delivery against its purchase order.",
    available: [CLERK], defaults: [CLERK],
    // the two purchase order reads are for the delivery check; Purchase Orders holds them too
    routes: [["POST", /^\/api\/inventory\/adjust$/],
             ["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/]] },
  // the Reference button on Stock Adjustment and on a received entry in
  // Adjustment History; switched on and off by itself, apart from those screens
  { key: "po-reference", name: "Purchase Order Reference", module: "Inventory",
    description: "See a received purchase order with what was ordered beside what arrived, to check the right goods came in. Read only.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/reference$/]] },
  { key: "adjustment-history", name: "Adjustment History", module: "Inventory",
    description: "Every correction made, by whom and why.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/adjustments$/]] },
  { key: "reorder-points", name: "Reorder Point", module: "Inventory",
    description: "Where each material's reorder point sits, and the formula behind it.",
    available: [CLERK], defaults: [CLERK],
    routes: [["PUT", /^\/api\/inventory\/reorder\/\d+$/]] },
  { key: "reorder-alerts", name: "Reorder Alerts", module: "Inventory",
    description: "The materials at or under their reorder point today.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/reorder-policy$/]] },
  { key: "stock-reports", name: "Stocks Overview", module: "Inventory",
    description: "The whole inventory to read, sort and print, and where a product's selling price is set.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/price$/]] },
  // the strip across the manager's screens: how many products have no price yet, and a
  // button to the Stocks Overview where the price is set (that button also needs stock-reports)
  { key: "price-alert", name: "No-Price Alert", module: "Inventory",
    description: "An alert across the screens when products have no selling price yet, with a button to the Stocks Overview where the price is set.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks\/unpriced$/]] },
  { key: "returns", name: "Returned Items", module: "Inventory",
    description: "Returns and damage reports: inspecting what the counter took back, and putting it back on the shelf or writing it off.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/], ["POST", /^\/api\/returns\/\d+\/resolve$/]] },
  { key: "damage-report", name: "Make a Report", module: "Inventory",
    description: "Report damaged goods and take them off the shelf, or goods missing from a delivery.",
    available: [CLERK], defaults: [CLERK],
    // the two purchase order reads are for picking the order the missing goods were on
    routes: [["POST", /^\/api\/returns$/], ["POST", /^\/api\/returns\/batch$/],
             ["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/]] },
  { key: "purchase-orders", name: "Purchase Orders", module: "Inventory",
    description: "Orders to suppliers: the clerk raises one, the manager confirms it and counts the delivery in.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/],
             ["GET", /^\/api\/purchase-orders\/\d+\/document$/], ["POST", /^\/api\/purchase-orders$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/decide$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/receive$/]] },

  // --- deliveries ---
  { key: "deliveries", name: "Delivery Tracking", module: "Deliveries",
    description: "Every delivery created and where it has got to; the manager's copy can move one along.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/]] },
  { key: "delivery-runs", name: "Delivery Runs", module: "Deliveries",
    description: "The driver's own round: every active delivery in one list, how much is to be collected on each, and the status moves.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/list$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/],
             ["POST", /^\/api\/delivery\/\d+\/claim$/]] },
  // the Proceed to Payment button on a delivery's card; the payment goes on the sale,
  // to the cashier's and manager's screens and their alerts (routes/delivery.js)
  { key: "delivery-collect", name: "Collect Payment at the Door", module: "Deliveries",
    description: "Take cash, GCash, PayMaya, cheque or bank transfer from the customer on a delivery the driver took. It goes on the sale at once, and the cashier and manager are told.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["POST", /^\/api\/delivery\/\d+\/payment$/]] },
  { key: "delivery-refunds", name: "Refund at the Door", module: "Deliveries",
    description: "Record a refund for an item the customer turns away at the door; the stockroom inspects it before it can be sold again.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["POST", /^\/api\/returns$/]] },
  { key: "delivery-reports", name: "Delivery Reports", module: "Deliveries",
    description: "The driver's deliveries and collections over a period.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/summary$/]] },
  // drawn by script (shared/delivery-schedule.js), so every page can draw it
  { key: "delivery-schedule", name: "Delivery Schedule", module: "Deliveries",
    description: "Deliveries still to go out, by the day they are due: overdue, today, tomorrow, later.",
    available: [MANAGER, CASHIER, CLERK, DRIVER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/]] },

  // --- records ---
  { key: "records", name: "Records", module: "Records",
    description: "Suppliers, customers, products, categories and units. The clerk sees suppliers, products, categories and units, and cannot add any.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [] },
  { key: "archives", name: "Archives", module: "Records",
    description: "What has been put away, and restoring it.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/archives$/], ["POST", /^\/api\/archives\/archive$/], ["POST", /^\/api\/archives\/restore$/]] },

  // --- staff accounts ---
  // Off for everyone until the administrator switches it on for managers.
  // routes/admin.js still refuses an account or a hold on an administrator or a manager.
  { key: "account-management", name: "Account Management", module: "Staff",
    description: "See the cashier, inventory clerk and driver accounts, create new ones, and let the ones locked out after too many wrong passwords sign in again. Never an administrator or manager account.",
    available: [MANAGER], defaults: [],
    routes: [["GET", /^\/api\/roles$/], ["GET", /^\/api\/users$/],
             ["GET", /^\/api\/users\/email-check$/], ["GET", /^\/api\/users\/phone-check$/],
             ["POST", /^\/api\/users\/draft$/], ["POST", /^\/api\/users$/],
             ["POST", /^\/api\/users\/\d+\/release-hold$/]] }
];

const FEATURE_ROLES = [MANAGER, CLERK, CASHIER, DRIVER];   // the matrix's columns

// the roles whose accounts a manager may create and lift a sign-in hold on
// (the administrator may do both for any role)
const ROLES_MANAGED_BY_MANAGER = [CASHIER, CLERK, DRIVER];

// "available" is the list of dashboards that have a menu entry for the screen.
// Access Control only offers a switch where flipping it shows or hides
// something: a screen granted to a role whose page cannot draw it would save
// and then appear nowhere.

// finds a screen by its key, e.g. findFeature("pos"); null when there is none
function findFeature(key) {
  const wanted = String(key || "").toLowerCase();
  for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex++) {
    const feature = FEATURES[featureIndex];
    if (feature.key === wanted) {
      return feature;
    }
  }
  return null;
}

// every screen that uses this route (method + address)
function featuresCovering(method, pathname) {
  const found = [];
  for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex++) {
    const feature = FEATURES[featureIndex];
    for (let routeIndex = 0; routeIndex < feature.routes.length; routeIndex++) {
      const route = feature.routes[routeIndex];
      const routeMethod = route[0];
      const routePattern = route[1];
      if (routeMethod === method && routePattern.test(pathname)) {
        found.push(feature);
        break;   // this feature is counted once; go to the next feature
      }
    }
  }
  return found;
}

// the overrides, cached between writes:
// role name -> { feature key: { granted, note, grantedBy, grantedAt, updatedAt } }
// On Vercel a write on one copy of the server cannot clear another copy's
// cache, so there it is only trusted for a few seconds.
let featureOverrides = null;
let featureOverridesAt = 0;
const FEATURE_CACHE_MS = IS_VERCEL ? 10 * 1000 : Infinity;

async function loadFeatureOverrides() {
  if (featureOverrides && Date.now() - featureOverridesAt < FEATURE_CACHE_MS) return featureOverrides;

  const byRole = {};
  try {
    const result = await db.query(
      "SELECT r.role_name, p.feature_key, p.is_granted, p.note, " +
      "p.granted_at, p.updated_at, gb.full_name AS granted_by " +
      "FROM role_feature_permissions p " +
      "JOIN roles r ON r.role_id = p.role_id " +
      "LEFT JOIN staff gb ON gb.staff_id = p.granted_by_staff_id");
    const rows = result[0];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Object.prototype.hasOwnProperty.call(byRole, row.role_name)) {
        byRole[row.role_name] = {};
      }
      byRole[row.role_name][row.feature_key] = {
        granted: Boolean(row.is_granted),
        note: row.note,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        updatedAt: row.updated_at
      };
    }
  } catch (error) {
    // the table may not exist yet; then there are simply no overrides
  }

  featureOverrides = byRole;
  featureOverridesAt = Date.now();
  return byRole;
}

function forgetFeatureOverrides() {
  featureOverrides = null;
}

// what one role holds: the defaults with the overrides applied
async function featuresOf(roleName) {
  const allOverrides = await loadFeatureOverrides();
  let overrides = {};
  if (Object.prototype.hasOwnProperty.call(allOverrides, roleName)) {
    overrides = allOverrides[roleName];
  }

  const result = [];
  for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex++) {
    const feature = FEATURES[featureIndex];
    if (!feature.available.includes(roleName) && roleName !== ADMIN) {
      continue;   // this role can never have this screen
    }

    // does the role have this screen when nobody has changed anything?
    const byDefault = roleName === ADMIN || feature.defaults.includes(roleName);

    // has the administrator switched it on or off for this role?
    let override = null;
    if (Object.prototype.hasOwnProperty.call(overrides, feature.key)) {
      override = overrides[feature.key];
    }

    const item = {
      key: feature.key,
      name: feature.name,
      module: feature.module,
      held: byDefault,
      byDefault: byDefault,
      overridden: false,
      note: null,
      grantedBy: null,
      updatedAt: null
    };

    if (override) {
      item.held = override.granted;
      item.overridden = override.granted !== byDefault;
      item.note = override.note;
      item.grantedBy = override.grantedBy;
      item.updatedAt = override.updatedAt || override.grantedAt;
    }

    result.push(item);
  }
  return result;
}

// Everything held, and the part held by grant rather than by role. Each is
// an object with a true for every screen key it holds: { pos: true, ... }
async function heldFeatures(roleName) {
  const held = {};
  const granted = {};
  const list = await featuresOf(roleName);
  for (let i = 0; i < list.length; i++) {
    const feature = list[i];
    if (!feature.held) continue;
    held[feature.key] = true;
    if (!feature.byDefault) granted[feature.key] = true;
  }
  return { held: held, granted: granted };
}

module.exports = {
  FEATURES: FEATURES,
  FEATURE_ROLES: FEATURE_ROLES,
  ROLES_MANAGED_BY_MANAGER: ROLES_MANAGED_BY_MANAGER,
  findFeature: findFeature,
  featuresCovering: featuresCovering,
  featuresOf: featuresOf,
  heldFeatures: heldFeatures,
  forgetFeatureOverrides: forgetFeatureOverrides
};
