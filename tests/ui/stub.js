// ==========================================================================
// A STAND-IN FOR server.js, WITH NO DATABASE BEHIND IT
//
// It serves the real public/ folder and answers the routes the pages ask for
// with invented rows: 23 staff, 47 audit entries, 34 sales, 18 products, 21
// deliveries, 17 credit accounts. Enough of each that paging, filtering and
// the empty states are all real rather than theoretical.
//
// This exists so the front end can be driven end to end on a machine with no
// MySQL on it — a second laptop, a marking session, a coffee shop. It proves
// nothing about the database; tests/smoke.js does that. What it proves is
// that the screens behave, which is the half that is tedious to check by hand.
//
//     node tests/ui/stub.js          then open http://localhost:3311
//     sh tests/ui/run-all.sh         to drive every screen and report
// ==========================================================================
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));
// the project's own pages, so what is tested is what ships
const PUBLIC_DIR = process.env.PUBLIC_DIR ||
  path.join(__dirname, "..", "..", "public");

app.use(express.static(PUBLIC_DIR));

// The project ships no favicon, so every page load logs a 404 that has
// nothing to do with anything. Answered here rather than filtered out of the
// console, because a console with one line of known noise in it is a console
// people stop reading.
app.get("/favicon.ico", (request, response) => response.status(204).end());

// mirrors the real server: one hook, after any successful write
app.use((request, response, next) => {
  if (request.method !== "GET" && request.method !== "HEAD" &&
      !request.path.startsWith("/api/test/")) {
    response.on("finish", () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        stubPublish(stubScopeOf(request.path), `${request.method} ${request.path}`,
                    request.headers["x-client-id"] || null);
      }
    });
  }
  next();
});

const ROLES = [
  { role_id: 1, role_name: "System Administrator" },
  { role_id: 2, role_name: "Manager" },
  { role_id: 3, role_name: "Inventory Clerk" },
  { role_id: 4, role_name: "Cashier" },
  { role_id: 5, role_name: "Delivery Personnel" }
];

const FIRST = ["Pedro", "Juan", "Rosa", "Mark", "Ana", "Ben", "Cely", "Dino",
  "Elsa", "Fidel", "Gina", "Hector", "Ivy", "Jomar", "Kara", "Luis",
  "Mia", "Nico", "Olga", "Paolo", "Queenie", "Ramon", "Sofia"];
const LAST = ["Penduko", "Tamad", "Villamor", "Aguilar", "Reyes", "Cruz",
  "Santos", "Bautista", "Ocampo", "Mercado"];

const USERS = FIRST.map((first, index) => {
  const active = index % 7 !== 0;
  return {
    staff_id: index + 1,
    first_name: first,
    middle_name: index % 3 === 0 ? "Mendoza" : null,
    last_name: LAST[index % LAST.length],
    full_name: index % 3 === 0
      ? `${first} M. ${LAST[index % LAST.length]}`
      : `${first} ${LAST[index % LAST.length]}`,
    phone: "0917000" + String(1000 + index),
    is_active: active,
    staff_created_at: "2026-01-15 09:00:00",
    archived_at: active ? null : "2026-08-18 09:00:00",
    archived_by: active ? null : "Admin S. User",
    role_id: (index % 5) + 1,
    role_name: ROLES[index % 5].role_name,
    user_id: index % 9 === 3 ? null : index + 1,
    email: index % 9 === 3 ? null : `${first.toLowerCase()}@hardware.com`,
    must_change_password: index % 4 === 0,
    last_login: "2026-09-04 08:12:00",
    created_at: "2026-01-15 09:05:00",
    is_online: index % 5 === 0,
    seconds_idle: index % 5 === 0 ? 12 : 900
  };
});

const TYPES = ["CREATE", "UPDATE", "DELETE", "VOID", "LOGIN", "LOGOUT",
  "LOGIN_FAILURE", "BACKUP", "RESTORE", "SECURITY", "PAYMENT", "OTHER"];

const LOGS = Array.from({ length: 47 }, (_, index) => {
  const type = TYPES[index % TYPES.length];
  const staff = USERS[index % USERS.length];
  return {
    log_id: 500 - index,
    staff_id: type === "LOGIN_FAILURE" && index % 3 === 0 ? null : staff.staff_id,
    staff_name: type === "LOGIN_FAILURE" && index % 3 === 0 ? "System" : staff.full_name,
    role_name: staff.role_name,
    ip_address: index % 4 === 0 ? "127.0.0.1" : "192.168.1." + (20 + (index % 30)),
    action: type === "UPDATE" ? "UPDATE_ACCOUNT" : type,
    action_type: type,
    details: `Entry ${index + 1}: ${type.toLowerCase().replace("_", " ")} recorded for ${staff.full_name}`,
    metadata: type === "UPDATE"
      ? JSON.stringify({ staff_id: staff.staff_id, changes: {
          role_id: { before: 4, after: 2 },
          phone: { before: "09170001111", after: "09170002222" },
          middle_name: { before: null, after: "Mendoza" } } })
      : (type === "LOGIN_FAILURE"
          ? JSON.stringify({ email: "someone@hardware.com", reason: "wrong_password" })
          : null),
    created_at: `2026-09-0${(index % 4) + 1} ${String(8 + (index % 10)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`
  };
});

// A mix of both kinds, because the row has to say which it is and the drawer
// warns that an automatic one is on its way out of the folder.
const BACKUPS = Array.from({ length: 14 }, (_, index) => {
  const automatic = index % 3 !== 0;
  const prefix = automatic ? "hardware_db_auto_" : "hardware_db_backup_";
  return {
    fileName: `${prefix}2026-08-${String(20 + (index % 10)).padStart(2, "0")}_` +
              `${String(9 + index).padStart(2, "0")}30.sql`,
    bytes: 480000 + index * 12345,
    automatic: automatic
  };
});

app.post("/api/login", (request, response) =>
  response.json({ message: "ok", user: { staff_id: 1, role_name: "System Administrator" } }));
app.post("/api/logout", (request, response) => response.json({ message: "ok" }));
app.post("/api/heartbeat", (request, response) => response.json({ ok: true }));

app.get("/api/roles", (request, response) => response.json(ROLES));

app.get("/api/users", (request, response) => {
  const status = String(request.query.status || "all");
  let rows = USERS;
  if (status === "active") rows = USERS.filter((user) => user.is_active);
  if (status === "inactive") rows = USERS.filter((user) => !user.is_active);
  response.json(rows);
});

app.get("/api/audit-logs", (request, response) => {
  const type = String(request.query.actionType || "all").toUpperCase();
  response.json(type === "ALL" ? LOGS : LOGS.filter((log) => log.action_type === type));
});

app.get("/api/audit-logs/types", (request, response) =>
  response.json(TYPES.map((type) => ({ action_type: type, entries: 4 }))));

app.get("/api/backups", (request, response) =>
  response.json({
    folder: "C:/hardware/backups",
    files: BACKUPS,
    auto: {
      enabled: true, everySeconds: 60, keep: 60,
      lastFileName: BACKUPS[1].fileName, lastAt: "2026-08-21T09:30:00.000Z",
      lastError: null, failures: 0
    }
  }));

app.get("/api/notifications", (request, response) => response.json([]));
app.get("/api/me", (request, response) => response.json(USERS[0]));

// ==========================================================================
// CREATING AN ACCOUNT IS TWO REQUESTS
// The review step works the account out and makes a password; the second one
// creates it from the draft id. The stub keeps the drafts in a plain object
// because that is all the screens need to be driven through both steps.
// ==========================================================================
const DRAFTS = {};

app.post("/api/users/draft", (request, response) => {
  const body = request.body || {};
  const middle = String(body.middleName || "").trim();
  const draftId = "draft-" + Object.keys(DRAFTS).length;

  DRAFTS[draftId] = body;
  response.json({
    draftId: draftId,
    expiresInSeconds: 600,
    password: "Kx7ratHmqe4$Wn",
    willEmail: false,
    firstName: body.firstName,
    middleName: middle || null,
    lastName: body.lastName,
    phone: body.phone || null,
    roleId: body.roleId,
    roleName: (ROLES.find((r) => r.role_id === Number(body.roleId)) || {}).role_name || "Cashier",
    email: body.email,
    fullName: body.firstName + (middle ? " " + middle[0].toUpperCase() + "." : "") +
              " " + body.lastName
  });
});

app.post("/api/users", (request, response) => {
  const draft = DRAFTS[String((request.body || {}).draftId)];
  if (!draft) return response.status(410).json({ error: "That review has expired." });

  response.json({
    message: "Account created successfully.",
    staffId: 99,
    name: draft.firstName + " " + draft.lastName,
    email: draft.email,
    emailed: false,
    password: "Kx7ratHmqe4$Wn",
    reason: "Mail is not set up on this server, so the password could not be sent."
  });
});

// the Edit tab of the user card saves through this
app.put("/api/users/:id", (request, response) => {
  const user = USERS.find((row) => row.staff_id === Number(request.params.id));
  if (!user) return response.status(404).json({ error: "Staff record not found" });

  const body = request.body || {};
  user.first_name = body.firstName;
  user.middle_name = body.middleName || null;
  user.last_name = body.lastName;
  user.phone = body.phone || null;
  user.role_id = Number(body.roleId);
  user.role_name = (ROLES.find((r) => r.role_id === user.role_id) || {}).role_name || user.role_name;
  user.full_name = user.first_name +
    (user.middle_name ? " " + user.middle_name[0].toUpperCase() + "." : "") + " " + user.last_name;
  if (body.email) user.email = body.email;

  response.json({ message: "Account updated." });
});

app.patch("/api/users/:id/status", (request, response) => {
  const user = USERS.find((row) => row.staff_id === Number(request.params.id));
  if (user) user.is_active = request.body.isActive === true;
  response.json({ message: "Account status updated." });
});

const PORT = Number(process.env.PORT) || 3311;
app.listen(PORT, () => console.log(`stub serving ${PUBLIC_DIR} on http://localhost:${PORT}`));

// ==========================================================================
// MANAGER MODULE
// Enough rows to make paging, filtering and the chart real: 34 sales across
// three months, 18 products, 21 deliveries.
// ==========================================================================
const PRODUCTS = [
  "Cordless Drill 18V", "Claw Hammer", "PVC Pipe 1/2\"", "Latex Paint White",
  "Epoxy A & B", "Portland Cement 40kg", "Circuit Breaker 20A", "Angle Grinder",
  "Steel Nails 3in", "Plywood 3/4in", "Roof Sealant", "Copper Wire 2.0mm",
  "Ball Valve 1/2in", "Hacksaw Blade", "Concrete Hollow Block", "Paint Roller",
  "Extension Cord 5m", "Safety Goggles"
];
const METHODS = ["Cash", "COD", "Cheque", "GCash", "PayMaya", "Bank Transfer", "Credit"];
const GROUP = (m) => ["GCash", "PayMaya", "PayPal", "Bank Transfer"].includes(m) ? "Online Payment" : m;

const SALES = Array.from({ length: 34 }, (_, index) => {
  const method = METHODS[index % METHODS.length];
  const final = 500 + index * 437;
  const paid = index % 5 === 0 ? 0 : (index % 7 === 0 ? Math.round(final / 2) : final);
  const day = new Date(2026, 5 + Math.floor(index / 12), 1 + (index % 28));

  const voided = index % 17 === 16;
  const pendingDelivery = !voided && index % 6 === 2;
  const status = voided ? "Voided"
    : pendingDelivery ? "Pending Delivery"
    : (paid < final ? "Partial Credit" : "Completed");

  return {
    sale_id: 1000 + index,
    sale_date: day.toISOString().slice(0, 19).replace("T", " "),
    total_amount: final, discount: 0, final_amount: final,
    amount_paid: paid, change_given: 0,
    balance_due: Math.max(final - paid, 0),
    payment_method: method,
    payment_group: GROUP(method),
    payment_status: paid >= final ? "Paid" : (paid > 0 ? "Partial" : "Unpaid"),
    transaction_status: status,
    is_archived: voided,
    reference_no: null,
    cashier_staff_id: (index % 3) + 1,
    customer_name: FIRST[index % FIRST.length] + " " + LAST[index % LAST.length],
    cashier_name: USERS[index % 4].full_name,
    delivery_id: pendingDelivery ? 500 + index : null,
    delivery_status: pendingDelivery ? "In Transit" : null,
    item_count: 2
  };
});

const STOCKS = PRODUCTS.map((name, index) => {
  const onHand = index % 4 === 0 ? 0 : 3 + index * 7;
  const dynamic = index % 3 === 0;
  const daily = Number(((index % 9) * 0.4 + 0.2).toFixed(3));
  const lead = 5 + (index % 3) * 5;
  const safety = index % 5 * 3;
  const calculated = Math.ceil(daily * lead) + safety;
  const manual = 10 + index;
  const effective = dynamic ? calculated : manual;

  return {
    product_id: index + 1, product_name: name,
    price: 100 + index * 55, reorder_point: manual, status: "Active",
    lead_time_days: lead, safety_stock: safety,
    reorder_mode: dynamic ? "Dynamic" : "Manual",
    quantity_in_stock: onHand, last_updated: "2026-09-01 10:00:00",
    category_name: ["Hand Tools", "Power Tools", "Plumbing", "Electrical", "Construction Materials"][index % 5],
    brand_name: ["Makita", "DeWalt", "Stanley"][index % 3],
    unit_name: ["pcs", "bag", "meter"][index % 3],
    supplier_name: index % 2 ? "Cebu Tool Co." : "Manila Hardware Supply",
    contact_person: "Juan Dela Cruz", contact_number: "0917-123-4567",
    stock_value: onHand * (100 + index * 55),
    window_days: 90, units_sold_window: Math.round(daily * 90),
    avg_daily_sales: daily,
    calculated_rop: calculated, effective_rop: effective,
    stock_status: onHand === 0 ? "Out of Stock" : (onHand <= effective ? "Low Stock" : "In Stock"),
    suggested_order: Math.max(effective * 2 - onHand, 0),
    days_of_cover: daily === 0 ? null : Number((onHand / daily).toFixed(1))
  };
});

const DELIVERY_STATUS = ["Delivered", "Out for Delivery", "In Transit", "Pending", "Delayed", "Failed"];
const DELIVERIES = Array.from({ length: 21 }, (_, index) => {
  const status = DELIVERY_STATUS[index % DELIVERY_STATUS.length];
  const final = 1200 + index * 310;
  // every third delivered order still has money owed on it: the case the
  // whole Pending Cash Collection rule exists for
  const paid = status === "Delivered" && index % 3 === 0 ? 0 : final;
  const owed = Math.max(final - paid, 0);

  return {
    delivery_id: 500 + index, sale_id: 1000 + index, status,
    delivery_address: ["Quezon City", "Pasig City", "Caloocan City", "Taguig City"][index % 4] + ", Metro Manila",
    remarks: "Route note " + index,
    scheduled_date: "2026-09-0" + ((index % 9) + 1),
    delivered_at: status === "Delivered" ? "2026-09-02 14:30:00" : null,
    updated_at: "2026-09-03 08:00:00",
    customer_name: FIRST[index % FIRST.length] + " " + LAST[index % LAST.length],
    customer_phone: "0917-555-0000",
    driver_name: index % 5 === 4 ? "Unassigned" : "Delivery D. User",
    final_amount: final, amount_paid: paid,
    payment_method: METHODS[index % METHODS.length],
    payment_status: owed > 0 ? "Unpaid" : "Paid",
    balance_due: owed,
    fulfilment_state: status !== "Delivered" ? status
      : (owed > 0 ? "Pending Cash Collection" : "Completed")
  };
});

const ARCHIVE_MODULES = ["Staff", "Inventory", "Sales", "Delivery"];
const ARCHIVES = Array.from({ length: 23 }, (_, index) => ({
  module: ARCHIVE_MODULES[index % 4],
  record_id: index + 1,
  record_name: ARCHIVE_MODULES[index % 4] + " record " + (index + 1),
  detail: "Detail line " + index,
  archived_at: "2026-08-" + String(10 + (index % 19)).padStart(2, "0") + " 09:00:00",
  archived_by: "Manager M. User"
}));

const RECORDS = {
  supplier: Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, name: "Supplier " + (i + 1), contact_person: "Contact " + i,
    contact_number: "0917-000-000" + (i % 10), email: `s${i}@supply.ph`, product_count: i + 2
  })),
  customer: Array.from({ length: 17 }, (_, i) => ({
    id: i + 1, name: FIRST[i % FIRST.length] + " " + LAST[i % LAST.length],
    phone: "0922-333-44" + String(i).padStart(2, "0"),
    purchase_count: (i % 5) + 1, credit_limit: 10000 + i * 2500, current_credit: i * 700
  })),
  product: PRODUCTS.map((name, i) => ({
    id: i + 1, name, category_name: "Hand Tools", brand_name: "Makita",
    price: 100 + i * 55, quantity_in_stock: i * 7
  })),
  category: Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, name: ["Hand Tools", "Power Tools", "Plumbing", "Electrical", "Construction Materials"][i],
    product_count: 3 + i, total_stock: 40 + i * 12
  })),
  unit: Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, name: ["pcs", "bag", "liter", "meter", "box"][i], product_count: 2 + i
  }))
};

function money(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

app.get("/api/manager/summary", (request, response) => {
  const live = SALES.filter((s) => !s.is_archived);
  response.json({
    saleCount: live.length,
    grossSales: money(live, "final_amount"),
    totalIncome: money(live, "amount_paid"),
    incomeToday: 4820,
    pendingCredits: money(live, "balance_due"),
    pendingCreditCount: live.filter((s) => s.balance_due > 0).length,
    productCount: STOCKS.length,
    reorderAlerts: STOCKS.filter((p) => p.stock_status !== "In Stock").length,
    deliveriesInProgress: DELIVERIES.filter((d) => ["Pending", "In Transit", "Out for Delivery"].includes(d.status)).length,
    deliveryProblems: DELIVERIES.filter((d) => ["Delayed", "Failed"].includes(d.status)).length
  });
});

app.get("/api/reports/income", (request, response) => {
  const live = SALES.filter((s) => !s.is_archived);
  const billed = money(live, "final_amount");
  const collected = money(live, "amount_paid");

  const buckets = {};
  live.forEach((s) => {
    const key = String(s.sale_date).slice(0, 10);
    buckets[key] = buckets[key] || { bucket: key, sale_count: 0, billed: 0, collected: 0 };
    buckets[key].sale_count += 1;
    buckets[key].billed += s.final_amount;
    buckets[key].collected += s.amount_paid;
  });

  const methods = {};
  live.forEach((s) => {
    methods[s.payment_method] = methods[s.payment_method] ||
      { payment_method: s.payment_method, sale_count: 0, billed: 0, collected: 0, outstanding: 0 };
    methods[s.payment_method].sale_count += 1;
    methods[s.payment_method].billed += s.final_amount;
    methods[s.payment_method].collected += s.amount_paid;
    methods[s.payment_method].outstanding += s.balance_due;
  });

  response.json({
    range: {
      from: request.query.from || "2026-06-01",
      to: request.query.to || "2026-09-04",
      label: request.query.range === "daily" ? "Today" : "Last 30 days",
      bucket: "day",
      name: request.query.range || "custom"
    },
    totals: {
      saleCount: live.length, unitsSold: 1284,
      gross: billed, discounts: 1200, billed, collected,
      outstanding: billed - collected,
      averageSale: billed / live.length
    },
    series: Object.values(buckets).sort((a, b) => a.bucket.localeCompare(b.bucket)),
    methods: Object.values(methods).sort((a, b) => b.billed - a.billed),
    products: PRODUCTS.slice(0, 10).map((name, i) => ({
      product_id: i + 1, product_name: name, unit_name: "pcs",
      units_sold: 120 - i * 9, revenue: 48000 - i * 3600
    })),
    cashiers: USERS.slice(0, 6).map((u, i) => ({
      staff_id: u.staff_id, staff_name: u.full_name,
      sale_count: 12 - i, billed: 90000 - i * 8000, collected: 82000 - i * 8000
    }))
  });
});

app.get("/api/reports/overview", (request, response) => {
  const live = SALES.filter((s) => !s.is_archived);
  const methods = {};
  live.forEach((s) => {
    methods[s.payment_method] = methods[s.payment_method] ||
      { payment_method: s.payment_method, sale_count: 0, total_amount: 0, paid_amount: 0, balance_due: 0 };
    methods[s.payment_method].sale_count += 1;
    methods[s.payment_method].total_amount += s.final_amount;
    methods[s.payment_method].paid_amount += s.amount_paid;
    methods[s.payment_method].balance_due += s.balance_due;
  });

  response.json({
    methods: Object.values(methods),
    unpaid: live.filter((s) => s.balance_due > 0).map((s) => ({
      sale_id: s.sale_id, payment_method: s.payment_method, payment_status: s.payment_status,
      sale_date: s.sale_date, final_amount: s.final_amount, amount_paid: s.amount_paid,
      balance_due: s.balance_due, customer_name: s.customer_name, cashier_name: s.cashier_name
    })),
    loyal: RECORDS.customer.map((c, i) => ({
      customer_id: c.id, customer_name: c.name, phone: c.phone,
      purchase_count: c.purchase_count, total_spent: 12000 + i * 900,
      balance_due: i % 3 === 0 ? i * 400 : 0, last_purchase: "2026-08-2" + (i % 9)
    })),
    staffPerf: USERS.slice(0, 14).map((u, i) => ({
      staff_id: u.staff_id, staff_name: u.full_name, role_name: u.role_name,
      is_active: u.is_active, sale_count: 20 - i, total_sales: 150000 - i * 9000
    }))
  });
});

app.get("/api/sales", (request, response) => {
  const method = String(request.query.method || "all");
  const status = String(request.query.status || "all");

  let rows = status === "Voided" ? SALES.filter((s) => s.is_archived) : SALES.filter((s) => !s.is_archived);
  if (method !== "all") rows = rows.filter((s) => s.payment_group === method);
  if (status !== "all" && status !== "Voided") rows = rows.filter((s) => s.transaction_status === status);

  response.json(rows);
});

app.get("/api/sales/:id", (request, response) => {
  const sale = SALES.find((s) => s.sale_id === Number(request.params.id));
  if (!sale) return response.status(404).json({ error: "Sale not found" });

  response.json({
    sale: Object.assign({}, sale, { customer_phone: "0917-555-1212", customer_address: "Quezon City" }),
    items: [
      { product_name: "Portland Cement 40kg", quantity: 10, unit_name: "bag", unit_price: 260, subtotal: 2600 },
      { product_name: "Claw Hammer", quantity: 1, unit_name: "pcs", unit_price: 450, subtotal: 450 }
    ],
    payments: sale.amount_paid > 0
      ? [{ payment_date: sale.sale_date, amount: sale.amount_paid, payment_method: sale.payment_method,
           reference_no: null, received_by: sale.cashier_name }]
      : [],
    delivery: DELIVERIES.find((d) => d.sale_id === sale.sale_id) || null
  });
});

app.get("/api/stocks", (request, response) => response.json(STOCKS));

app.put("/api/stocks/:id/reorder-policy", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  if (!product) return response.status(404).json({ error: "Not found" });

  product.lead_time_days = Number(request.body.leadTimeDays);
  product.safety_stock = Number(request.body.safetyStock);
  product.reorder_mode = request.body.reorderMode;
  if (request.body.reorderPoint !== undefined) product.reorder_point = Number(request.body.reorderPoint);

  product.calculated_rop = Math.ceil(product.avg_daily_sales * product.lead_time_days) + product.safety_stock;
  product.effective_rop = product.reorder_mode === "Dynamic" ? product.calculated_rop : product.reorder_point;

  response.json({ message: `Reorder policy updated for ${product.product_name}.` });
});

app.get("/api/deliveries", (request, response) => response.json(DELIVERIES));
app.get("/api/records/:type", (request, response) =>
  response.json(RECORDS[request.params.type] || []));
app.get("/api/archives", (request, response) => response.json(ARCHIVES));

app.post("/api/archives/restore", (request, response) =>
  response.json({ message: "Restored." }));

app.get("/api/reports/export", (request, response) => {
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", 'attachment; filename="report.csv"');
  response.send("Method,Sales\r\nCash,12\r\n");
});

// ==========================================================================
// CREDIT MANAGEMENT
// Three standings, accounts over and under their limits, and one request
// already waiting, so every branch on both screens has something to show.
// ==========================================================================
const STANDINGS = ["Good", "Good", "Watch", "Good", "Hold", "Good", "Watch"];

const CREDIT = RECORDS.customer.map((c, index) => {
  const limit = 10000 + index * 5000;
  // every third account owes something, and one of them is over its limit
  const owed = index % 3 === 0 ? Math.round(limit * (index === 6 ? 1.2 : 0.45)) : 0;

  return {
    customer_id: c.id,
    customer_name: c.name,
    phone: c.phone,
    address: "Quezon City, Metro Manila",
    credit_limit: limit,
    standing: STANDINGS[index % STANDINGS.length],
    credit_notes: STANDINGS[index % STANDINGS.length] === "Hold"
      ? "Cheque bounced in August. No new credit until it clears." : null,
    credit_updated_at: "2026-08-30 09:00:00",
    total_purchase: 20000 + index * 3100,
    current_credit: owed,
    available_credit: Math.max(limit - owed, 0),
    open_sales: owed > 0 ? 1 + (index % 3) : 0,
    oldest_debt_days: owed > 0 ? 5 + index * 9 : null,
    last_purchase: "2026-09-0" + ((index % 4) + 1) + " 10:00:00",
    last_payment: owed > 0 ? "2026-08-2" + (index % 9) + " 14:00:00" : null,
    pending_requests: index === 3 ? 1 : 0
  };
});

let REQUEST_ID = 900;
const REQUESTS = [
  {
    request_id: REQUEST_ID++, customer_id: CREDIT[3].customer_id,
    customer_name: CREDIT[3].customer_name, phone: CREDIT[3].phone,
    previous_limit: CREDIT[3].credit_limit,
    requested_limit: CREDIT[3].credit_limit + 25000,
    reason: "Regular contractor, pays on the 15th, needs cement for a job this week.",
    status: "Pending", requested_by: "Cashier C. User", decided_by: null,
    decision_note: null, decided_at: null, created_at: "2026-09-03 11:20:00",
    current_credit: CREDIT[3].current_credit, standing: CREDIT[3].standing
  },
  {
    request_id: REQUEST_ID++, customer_id: CREDIT[1].customer_id,
    customer_name: CREDIT[1].customer_name, phone: CREDIT[1].phone,
    previous_limit: 15000, requested_limit: 30000,
    reason: "Bulk order for a subdivision job.",
    status: "Approved", requested_by: "Ana Reyes", decided_by: "Manager M. User",
    decision_note: "Cleared their August balance last week, good for it.",
    decided_at: "2026-08-28 16:05:00", created_at: "2026-08-28 10:00:00",
    current_credit: CREDIT[1].current_credit, standing: CREDIT[1].standing
  },
  {
    request_id: REQUEST_ID++, customer_id: CREDIT[4].customer_id,
    customer_name: CREDIT[4].customer_name, phone: CREDIT[4].phone,
    previous_limit: 30000, requested_limit: 60000,
    reason: "Asked for more room after the bounced cheque.",
    status: "Declined", requested_by: "Cashier C. User", decided_by: "Manager M. User",
    decision_note: "Not while the August cheque is outstanding.",
    decided_at: "2026-08-29 09:30:00", created_at: "2026-08-29 08:15:00",
    current_credit: CREDIT[4].current_credit, standing: CREDIT[4].standing
  }
];

app.get("/api/credit/customers", (request, response) => {
  const standing = String(request.query.standing || "all");
  let rows = CREDIT;
  if (["Good", "Watch", "Hold"].includes(standing)) rows = rows.filter((r) => r.standing === standing);
  if (request.query.owing === "true") rows = rows.filter((r) => r.current_credit > 0);
  response.json(rows);
});

app.get("/api/credit/customers/:id", (request, response) => {
  const credit = CREDIT.find((c) => c.customer_id === Number(request.params.id));
  if (!credit) return response.status(404).json({ error: "Not found" });
  response.json({
    credit,
    requests: REQUESTS.filter((r) => r.customer_id === credit.customer_id)
  });
});

app.put("/api/credit/customers/:id/limit", (request, response) => {
  const credit = CREDIT.find((c) => c.customer_id === Number(request.params.id));
  if (!credit) return response.status(404).json({ error: "Not found" });

  credit.credit_limit = Number(request.body.creditLimit);
  credit.standing = request.body.standing || "Good";
  credit.credit_notes = request.body.notes || null;
  credit.available_credit = Math.max(credit.credit_limit - credit.current_credit, 0);

  response.json({
    message: `Saved. ${credit.customer_name} may owe up to ${credit.credit_limit}.`
  });
});

app.get("/api/credit/requests", (request, response) => {
  const status = String(request.query.status || "all");
  response.json(status === "all" ? REQUESTS : REQUESTS.filter((r) => r.status === status));
});

app.post("/api/credit/requests", (request, response) => {
  const credit = CREDIT.find((c) => c.customer_id === Number(request.body.customerId));
  if (!credit) return response.status(404).json({ error: "Customer not found." });

  if (REQUESTS.some((r) => r.customer_id === credit.customer_id && r.status === "Pending")) {
    return response.status(409).json({
      error: `A request for ${credit.customer_name} is already waiting for a manager.`
    });
  }

  const created = {
    request_id: REQUEST_ID++, customer_id: credit.customer_id,
    customer_name: credit.customer_name, phone: credit.phone,
    previous_limit: credit.credit_limit,
    requested_limit: Number(request.body.requestedLimit),
    reason: request.body.reason || null, status: "Pending",
    requested_by: "Cashier C. User", decided_by: null, decision_note: null,
    decided_at: null, created_at: "2026-09-04 12:00:00",
    current_credit: credit.current_credit, standing: credit.standing
  };
  REQUESTS.unshift(created);
  credit.pending_requests = 1;

  response.json({
    message: `Request raised for ${credit.customer_name}. A manager will decide it.`,
    requestId: created.request_id
  });
});

app.post("/api/credit/requests/:id/decide", (request, response) => {
  const found = REQUESTS.find((r) => r.request_id === Number(request.params.id));
  if (!found) return response.status(404).json({ error: "That request no longer exists." });

  if (found.status !== "Pending") {
    return response.status(409).json({
      error: `This request was already ${found.status.toLowerCase()}.`
    });
  }

  const approve = request.body.approve === true;
  if (!approve && !String(request.body.note || "").trim()) {
    return response.status(400).json({ error: "Say why the request was declined." });
  }

  found.status = approve ? "Approved" : "Declined";
  found.decided_by = "Manager M. User";
  found.decision_note = request.body.note || null;
  found.decided_at = "2026-09-04 12:05:00";

  const credit = CREDIT.find((c) => c.customer_id === found.customer_id);
  if (credit) {
    credit.pending_requests = 0;
    if (approve) {
      credit.credit_limit = found.requested_limit;
      credit.available_credit = Math.max(credit.credit_limit - credit.current_credit, 0);
    }
  }

  response.json({
    message: approve
      ? `${found.customer_name} may now owe up to ${found.requested_limit}.`
      : `The request for ${found.customer_name} was declined.`
  });
});

app.get("/api/customers/:id/history", (request, response) => {
  const credit = CREDIT.find((c) => c.customer_id === Number(request.params.id));
  if (!credit) return response.status(404).json({ error: "Not found" });

  const purchases = SALES.slice(0, 9).map((s, i) => ({
    sale_id: s.sale_id, sale_date: s.sale_date, total_amount: s.total_amount,
    discount: 0, final_amount: s.final_amount, amount_paid: s.amount_paid,
    payment_method: s.payment_method, payment_status: s.payment_status,
    reference_no: null, is_archived: false,
    balance_due: s.balance_due, cashier_name: s.cashier_name,
    item_count: 2, delivery_id: null, delivery_status: null
  }));

  const payments = purchases.filter((p) => p.amount_paid > 0).map((p, i) => ({
    payment_id: 700 + i, sale_id: p.sale_id, amount: p.amount_paid,
    payment_method: p.payment_method === "Credit" ? "Cash" : p.payment_method,
    reference_no: null, payment_date: p.sale_date, received_by: p.cashier_name
  }));

  response.json({
    credit,
    purchases,
    payments,
    requests: REQUESTS.filter((r) => r.customer_id === credit.customer_id),
    products: PRODUCTS.slice(0, 5).map((name, i) => ({
      product_name: name, unit_name: "pcs",
      units: 40 - i * 6, spent: 12000 - i * 1500, last_bought: "2026-08-2" + i
    }))
  });
});

// the till's product grid
app.get("/api/inventory/products", (request, response) =>
  response.json(STOCKS.map((p) => ({
    product_id: p.product_id, product_name: p.product_name, price: p.price,
    quantity_in_stock: p.quantity_in_stock === 0 ? 40 : p.quantity_in_stock,
    unit_name: p.unit_name, category_name: p.category_name, brand_name: p.brand_name,
    reorder_point: p.reorder_point, status: "Active", is_archived: false,
    supplier_name: p.supplier_name,
    stock_status: p.stock_status === "Out of Stock" ? "In Stock" : p.stock_status
  }))));

app.get("/api/sales/undelivered", (request, response) => response.json([]));

// Every till screen reads this to head an invoice, so its absence here was a
// 404 in the console of every cashier page. That made the credit and returns
// suites report a problem they had not caused, and exit non-zero while every
// one of their own checks passed. A suite that goes red when nothing is wrong
// is a suite people stop reading, which is how the two genuinely stale checks
// above sat broken for as long as they did.
const STORE = {
  setting_id: 1,
  store_name: "Stub Hardware & Supply",
  address: "123 Rizal Avenue, Quezon City",
  tin: "123-456-789-00000",
  registration_type: "VAT",
  vat_rate: "12.00",
  invoice_note: "Thank you for your business.",
  updated_at: "2026-09-01 09:00:00",
  updated_by: "Admin S. User"
};

app.get("/api/store-settings", (request, response) => response.json(STORE));

// The Store & Tax form saves through this. The stub keeps the row in memory
// and refuses the same TIN shapes the real server refuses, so the screen's
// own check and the server's answer can both be driven.
app.put("/api/store-settings", (request, response) => {
  const body = request.body || {};
  const digits = String(body.tin || "").replace(/\D/g, "");

  if (![9, 12, 14].includes(digits.length) || /^0+$/.test(digits.slice(0, 9))) {
    return response.status(400).json({ error: "That is not a TIN the BIR would have issued." });
  }

  Object.assign(STORE, {
    store_name: body.storeName,
    address: body.address,
    tin: body.tin,
    registration_type: body.registrationType,
    vat_rate: String(Number(body.vatRate || 0).toFixed(2)),
    invoice_note: body.invoiceNote || null,
    updated_at: "2026-09-11 10:00:00"
  });

  response.json({ message: "Saved. Invoices now show a 12.00% VAT breakdown." });
});

app.get("/api/returns", (request, response) => response.json(RETURNS));
app.get("/api/cashier/summary", (request, response) =>
  response.json({ date: null, saleCount: 0, gross: 0, discounts: 0, collected: 0,
                  changeGiven: 0, cashDrawer: 0, refundCount: 0, refundTotal: 0, methods: [] }));

// returns and refunds
let RETURN_ID = 400;
const RETURNS = [
  { return_id: RETURN_ID++, report_type: "Refunded", quantity: 1,
    reason: "Wrong colour delivered, customer refunded on the spot.",
    disposition: "Return to Stock", refund_amount: 750, restocked: true,
    status: "Resolved", return_date: "2026-08-30 11:00:00", sale_id: 1008,
    product_id: 4, product_name: "Latex Paint White", unit_name: "liter",
    reported_by: "Cashier C. User" },
  { return_id: RETURN_ID++, report_type: "Refunded", quantity: 2,
    reason: "Two tins arrived dented in the delivery and cannot be sold.",
    disposition: "Write-Off", refund_amount: 1500, restocked: false,
    status: "Open", return_date: "2026-09-01 09:20:00", sale_id: 1002,
    product_id: 4, product_name: "Latex Paint White", unit_name: "liter",
    reported_by: "Ana Reyes" }
];

app.post("/api/returns", (request, response) => {
  const reason = String(request.body.reason || "").trim();
  if (reason.length < 10) {
    return response.status(400).json({ error: "Say what happened, in a sentence." });
  }

  const where = ["Return to Stock", "Write-Off"].includes(request.body.disposition)
    ? request.body.disposition
    : (request.body.restock === true ? "Return to Stock" : null);

  if (!where) {
    return response.status(400).json({ error: "Say where the goods go: Return to Stock, or Write-Off." });
  }

  const product = STOCKS.find((p) => p.product_id === Number(request.body.productId));
  const created = {
    return_id: RETURN_ID++, report_type: request.body.reportType || "Refunded",
    quantity: Number(request.body.quantity), reason,
    disposition: where, refund_amount: Number(request.body.refundAmount || 0),
    restocked: where === "Return to Stock", status: "Open",
    return_date: "2026-09-04 12:30:00", sale_id: request.body.saleId || null,
    product_id: Number(request.body.productId),
    product_name: product ? product.product_name : "Product",
    unit_name: product ? product.unit_name : "pcs",
    reported_by: "Cashier C. User"
  };
  RETURNS.unshift(created);

  response.json({
    message: `${created.report_type} filed for ${created.product_name}.`,
    reportId: created.return_id, disposition: where
  });
});

// clerk and driver screens
app.get("/api/inventory/adjustments", (request, response) =>
  response.json(Array.from({ length: 26 }, (_, i) => ({
    adjustment_id: 300 + i,
    product_id: (i % PRODUCTS.length) + 1,
    product_name: PRODUCTS[i % PRODUCTS.length],
    adjustment_type: ["Add", "Remove", "Recount"][i % 3],
    quantity_before: 20 + i, quantity_change: (i % 3 === 1 ? -1 : 1) * (i % 5 + 1),
    quantity_after: 20 + i + (i % 3 === 1 ? -1 : 1) * (i % 5 + 1),
    reason: "Adjustment note " + i,
    adjusted_by: "Clerk I. User",
    created_at: `2026-09-0${(i % 4) + 1} 09:${String(i % 60).padStart(2, "0")}:00`
  }))));

app.get("/api/purchase-orders", (request, response) =>
  response.json(Array.from({ length: 17 }, (_, i) => ({
    po_id: 200 + i,
    supplier_name: i % 2 ? "Cebu Tool Co." : "Manila Hardware Supply",
    order_date: `2026-08-${String(10 + (i % 19)).padStart(2, "0")} 08:00:00`,
    line_count: (i % 4) + 1,
    total_cost: 12000 + i * 2300,
    status: ["Pending", "Received", "Cancelled"][i % 3]
  }))));

app.get("/api/delivery/list", (request, response) => response.json(DELIVERIES));
app.get("/api/delivery/summary", (request, response) =>
  response.json({
    deliveries: DELIVERIES.slice(0, 12),
    payments: DELIVERIES.filter((d) => d.balance_due === 0).slice(0, 6).map((d, i) => ({
      payment_id: 800 + i, sale_id: d.sale_id, amount: d.final_amount,
      payment_method: "Cash", reference_no: null, payment_date: "2026-09-02 15:00:00"
    }))
  }));

app.get("/api/inventory/summary", (request, response) =>
  response.json({
    lowStock: STOCKS.filter((p) => p.stock_status === "Low Stock").length,
    outOfStock: STOCKS.filter((p) => p.stock_status === "Out of Stock").length,
    productCount: STOCKS.length,
    lowStockItems: STOCKS.filter((p) => p.stock_status !== "In Stock").slice(0, 5)
      .map((p) => ({ product_id: p.product_id, product_name: p.product_name,
                     quantity_in_stock: p.quantity_in_stock, reorder_point: p.effective_rop,
                     unit_name: p.unit_name, stock_status: p.stock_status }))
  }));

// ==========================================================================
// THE LIVE CHANNEL
// The same shape the real server sends, so the browser side can be driven
// without MySQL: a hello, then a change frame per write.
// ==========================================================================
let stubVersion = 0;
const stubClients = new Set();

function stubScopeOf(pathname) {
  if (/^\/api\/(users|roles)/.test(pathname)) return "staff";
  if (/^\/api\/(inventory|purchase-orders|stocks)/.test(pathname)) return "inventory";
  if (/^\/api\/returns/.test(pathname)) return "returns";
  if (/^\/api\/deliveries|^\/api\/delivery/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore)/.test(pathname)) return "system";
  if (/^\/api\/archives/.test(pathname)) return "archives";
  return null;
}

function stubPublish(scope, detail, origin) {
  if (!scope) return;
  stubVersion += 1;
  const change = { version: stubVersion, scope, detail: detail || null,
                   origin: origin || null, at: new Date().toISOString() };
  const frame = `id: ${change.version}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;
  for (const c of stubClients) { try { c.write(frame); } catch (e) { /* gone */ } }
}

app.get("/api/events", (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  response.write("retry: 3000\n\n");
  response.write(`event: hello\ndata: ${JSON.stringify(
    { clientId: "stub", version: stubVersion, caughtUp: true, scopes: [] })}\n\n`);

  stubClients.add(response);
  request.on("close", () => stubClients.delete(response));
});

// a way for the test to announce a change as though another desktop made it
app.post("/api/test/change", (request, response) => {
  stubPublish(request.body.scope, request.body.detail || "test", request.body.origin || null);
  response.json({ ok: true, version: stubVersion });
});

app.get("/api/events/status", (request, response) =>
  response.json({ version: stubVersion, connections: stubClients.size,
                  people: stubClients.size, logged: stubVersion }));
