const db = require("./database/connection").db;
const IS_VERCEL = require("./database/connection").IS_VERCEL;
const roles = require("./roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const DRIVER = roles.DRIVER;

const FEATURES = [
  { key: "pos", name: "New Transaction", module: "Point of Sale",
    description: "The register: ring a sale up, take the payment, create the delivery.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["POST", /^\/api\/sales$/], ["POST", /^\/api\/deliveries$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "refunds", name: "Refunds", module: "Point of Sale",
    description: "Take a sold item back and refund it at the counter; the stockroom inspects it before it can be sold again.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/returns$/], ["POST", /^\/api\/returns$/],
             ["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/]] },
  { key: "sales-report", name: "Sales Report", module: "Point of Sale",
    description: "The cashier's own sales, by day and by method.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "daily-summary", name: "Daily Summary", module: "Point of Sale",
    description: "What the till took today.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/cashier\/summary$/]] },

  { key: "credit", name: "Customer Credit", module: "Credit",
    description: "Every credit account and its credit rating; the cashier's copy adds and edits customers and files extension requests, the manager's reads them and decides limits.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/customers$/], ["GET", /^\/api\/credit\/customers\/\d+$/],
             ["PUT", /^\/api\/credit\/customers\/\d+\/limit$/], ["GET", /^\/api\/customers\/\d+\/history$/],
             ["GET", /^\/api\/credit\/policy$/],
             ["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests$/],
             ["POST", /^\/api\/customers$/], ["PUT", /^\/api\/customers\/\d+$/]] },
  { key: "debt-payments", name: "Credit Settlement", module: "Credit",
    description: "Credit Settlement: take a payment against what a customer still owes, sale by sale, from the customer's card, with a receipt for each payment.",
    available: [CASHIER], defaults: [CASHIER],
    routes: [["GET", /^\/api\/credit\/open-sales$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "credit-terms-print", name: "Print Credit Terms", module: "Credit",
    description: "Print the Credit Terms and Conditions page for a customer: the store, the customer, the credit limit, the due days and the late-payment rate, the terms and the signature lines. Offered on a credit sale's invoice and on the customer's card.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/terms\/\d+$/]] },
  { key: "customer-card-print", name: "Print Customer Card", module: "Credit",
    description: "Print a customer's physical card, true size to cut out (front: the store, the customer and the credit limit; back: the credit policy, customer data terms and refund policy), with the Credit Terms and Conditions page after it.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/credit\/card\/\d+$/]] },
  { key: "credit-terms-text", name: "Credit Policy", module: "Policy Maintenance",
    description: "Write the credit policy printed with every credit account and on the back of the customer card (the wording only; the figures come from the account). It is a part of the Credit Maintenance screen, so that screen is needed as well.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/policies$/], ["PUT", /^\/api\/policies\/credit$/]] },
  { key: "data-terms", name: "Customer Data Terms", module: "Policy Maintenance",
    description: "Write the terms and conditions on how the store collects, keeps and uses a customer's personal data, printed on the back of the customer card.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/policies$/], ["PUT", /^\/api\/policies\/data-terms$/]] },
  { key: "refund-policy", name: "Refund Policy", module: "Policy Maintenance",
    description: "Write the store's refund policy, printed on the back of the customer card.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/policies$/], ["PUT", /^\/api\/policies\/refund$/]] },
  { key: "credit-maintenance", name: "Credit Maintenance", module: "Policy Maintenance",
    description: "Set the late-payment rate the shop charges every credit account, 1 to 3 percent a month, and write the credit policy, on one page under Policy Maintenance.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/policy$/], ["PUT", /^\/api\/credit\/policy$/]] },
  { key: "credit-requests", name: "Extension Requests", module: "Credit",
    description: "The queue of credit-limit requests waiting for a decision.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/credit\/requests$/], ["POST", /^\/api\/credit\/requests\/\d+\/decide$/]] },

  { key: "income", name: "Income", module: "Reports",
    description: "Collected, billed, outstanding and discounts over any period.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/reports\/income$/]] },
  { key: "reports", name: "Reports", module: "Reports",
    description: "Everything staff have filed, plus payment methods, receivables, repeat customers and staff performance.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/reports\/activity$/], ["GET", /^\/api\/reports\/overview$/],
             ["GET", /^\/api\/reports\/daily-tally$/]] },
  { key: "sales", name: "Sales", module: "Reports",
    description: "Every sale rung up, with its lines and its payments.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/sales$/], ["GET", /^\/api\/sales\/\d+$/], ["POST", /^\/api\/sales\/\d+\/payment$/],
             ["POST", /^\/api\/sales\/\d+\/void$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },

  { key: "material-list", name: "Material List", module: "Inventory",
    description: "Everything on the shelf, with what is in stock, the sizes each material sells in, and the pack it is delivered in.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/summary$/],
             ["POST", /^\/api\/inventory\/products\/\d+\/units$/],
             ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/],
             ["PUT", /^\/api\/inventory\/products\/\d+\/pack$/]] },
  { key: "product-add", name: "Add New Product", module: "Inventory",
    description: "Open a record for a product the shop has never stocked, from the Material List. It starts with no price and no stock; the manager is told and sets the price, and until then the till cannot sell it.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/materials$/]] },
  { key: "stock-adjustment", name: "Stock Adjustment", module: "Inventory",
    description: "Correct a stock figure by hand, and check a delivery against its purchase order.",
    available: [CLERK], defaults: [CLERK],
    routes: [["POST", /^\/api\/inventory\/adjust$/],
             ["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/]] },
  { key: "po-reference", name: "Purchase Order Reference", module: "Inventory",
    description: "See a received purchase order with what was ordered beside what arrived, to check the right goods came in. Read only.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/reference$/]] },
  { key: "adjustment-history", name: "Adjustment History", module: "Inventory",
    description: "Every correction made, by whom and why.",
    available: [CLERK], defaults: [CLERK],
    routes: [["GET", /^\/api\/inventory\/adjustments$/]] },
  { key: "reorder-points", name: "Reorder Point", module: "Inventory",
    description: "See each material's reorder point: the stock level that puts it on the reorder list.",
    available: [CLERK], defaults: [CLERK],
    routes: [] },
  { key: "reorder-alerts", name: "Reorder Alerts", module: "Inventory",
    description: "The materials at or under their reorder point today.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/reorder-policy$/]] },
  { key: "stock-reports", name: "Stocks Overview", module: "Inventory",
    description: "The whole inventory to read, sort and print, and where a product's selling price is set.",
    available: [MANAGER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/stocks$/], ["PUT", /^\/api\/stocks\/\d+\/price$/]] },
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
    routes: [["POST", /^\/api\/returns$/], ["POST", /^\/api\/returns\/batch$/],
             ["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/]] },
  { key: "purchase-orders", name: "Purchase Orders", module: "Inventory",
    description: "Orders to suppliers: the clerk raises one, the manager confirms it and counts the delivery in.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/purchase-orders$/], ["GET", /^\/api\/purchase-orders\/\d+\/items$/],
             ["GET", /^\/api\/purchase-orders\/\d+\/document$/], ["POST", /^\/api\/purchase-orders$/],
             ["GET", /^\/api\/purchase-orders\/\d+\/reports$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/decide$/],
             ["POST", /^\/api\/purchase-orders\/\d+\/receive$/]] },

  { key: "deliveries", name: "Delivery History", module: "Deliveries",
    description: "Every delivery created and where it has got to. The manager's copy is to read only.",
    available: [MANAGER, CASHIER], defaults: [MANAGER, CASHIER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/]] },
  { key: "delivery-runs", name: "Delivery Runs", module: "Deliveries",
    description: "The driver's own round: every active delivery in one list, how much is to be collected on each, and the status moves.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/list$/], ["GET", /^\/api\/deliveries\/\d+\/items$/],
             ["PATCH", /^\/api\/deliveries\/\d+\/status$/],
             ["POST", /^\/api\/delivery\/\d+\/claim$/]] },
  { key: "delivery-collect", name: "Collect Payment at the Door", module: "Deliveries",
    description: "Take cash, GCash, PayMaya, cheque or bank transfer from the customer on a delivery the driver took. It goes on the sale at once, and the cashier and manager are told.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["POST", /^\/api\/delivery\/\d+\/payment$/],
             ["POST", /^\/api\/qr-payments$/], ["GET", /^\/api\/qr-payments\/\d+$/],
             ["POST", /^\/api\/qr-payments\/\d+\/cancel$/]] },
  { key: "delivery-refunds", name: "Refund at the Door", module: "Deliveries",
    description: "Record a refund for an item the customer turns away at the door; the stockroom inspects it before it can be sold again.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["POST", /^\/api\/returns$/]] },
  { key: "delivery-reports", name: "Delivery Reports", module: "Deliveries",
    description: "The driver's deliveries and collections over a period.",
    available: [DRIVER], defaults: [DRIVER],
    routes: [["GET", /^\/api\/delivery\/summary$/]] },
  { key: "delivery-schedule", name: "Delivery Schedule", module: "Deliveries",
    description: "Deliveries still to go out, by the day they are due: overdue, today, tomorrow, later.",
    available: [MANAGER, CASHIER, CLERK, DRIVER], defaults: [MANAGER],
    routes: [["GET", /^\/api\/deliveries$/], ["GET", /^\/api\/deliveries\/\d+\/items$/]] },

  { key: "records", name: "Records", module: "Records",
    description: "Suppliers, customers, products, categories and units. The manager edits suppliers, reads customers (only the cashier edits a customer), prices products and archives records (only the clerk edits a product); the clerk alone adds categories and units.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["POST", /^\/api\/categories$/], ["POST", /^\/api\/units$/],
             ["PUT", /^\/api\/suppliers\/\d+$/],
             ["PUT", /^\/api\/stocks\/\d+\/price$/]] },
  { key: "archives", name: "Archives", module: "Records",
    description: "What has been put away, and restoring it.",
    available: [MANAGER, CLERK], defaults: [MANAGER, CLERK],
    routes: [["GET", /^\/api\/archives$/], ["POST", /^\/api\/archives\/archive$/], ["POST", /^\/api\/archives\/restore$/]] },

  { key: "account-management", name: "Account Management", module: "Staff",
    description: "See the cashier, inventory clerk and driver accounts, create new ones, and let the ones locked out after too many wrong passwords sign in again. Never an administrator or manager account.",
    available: [MANAGER], defaults: [],
    routes: [["GET", /^\/api\/roles$/], ["GET", /^\/api\/users$/],
             ["GET", /^\/api\/users\/email-check$/], ["GET", /^\/api\/users\/phone-check$/],
             ["POST", /^\/api\/users\/draft$/], ["POST", /^\/api\/users$/],
             ["POST", /^\/api\/users\/\d+\/release-hold$/]] }
];

const FEATURE_ROLES = [MANAGER, CLERK, CASHIER, DRIVER];

const ROLES_MANAGED_BY_MANAGER = [CASHIER, CLERK, DRIVER];

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
        break;
      }
    }
  }
  return found;
}

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
  }

  featureOverrides = byRole;
  featureOverridesAt = Date.now();
  return byRole;
}

function forgetFeatureOverrides() {
  featureOverrides = null;
}

async function featuresOf(roleName) {
  const allOverrides = await loadFeatureOverrides();
  let overrides = {};
  if (Object.prototype.hasOwnProperty.call(allOverrides, roleName)) {
    overrides = allOverrides[roleName];
  }

  const result = [];
  for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex++) {
    const feature = FEATURES[featureIndex];

    const byDefault = roleName === ADMIN || feature.defaults.includes(roleName);

    let override = null;
    if (Object.prototype.hasOwnProperty.call(overrides, feature.key)) {
      override = overrides[feature.key];
    }

    const item = {
      key: feature.key,
      name: feature.name,
      module: feature.module,
      hosts: feature.available,
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
