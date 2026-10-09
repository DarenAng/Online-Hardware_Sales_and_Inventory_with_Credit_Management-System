// A stand-in for server.js with no database behind it: serves the real
// pages, css and browser scripts (the same three folders server.js serves) and answers the routes with invented rows, so the screens
// can be driven on a machine with no MySQL. tests/smoke.js covers the database.
//
//     node tests/ui/stub.js          then open http://localhost:3311
//     sh tests/ui/run-all.sh         to drive every screen and report
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));
// the project's own pages, so what is tested is what ships
const PUBLIC_DIR = process.env.PUBLIC_DIR ||
  path.join(__dirname, "..", "..", "public");

// the same three folders public/Back-end/server.js serves
app.use(express.static(path.join(PUBLIC_DIR, "Front-end")));
app.use("/modules", express.static(path.join(PUBLIC_DIR, "Back-end", "modules")));
app.use("/connections", (request, response, next) =>
  /^\/[a-z]+(-[a-z]+)*-connection\.js$/i.test(request.path) ? next() : response.status(404).send("Not found"),
  express.static(path.join(PUBLIC_DIR, "Back-end", "Connections")));
app.use("/vendor", express.static(path.join(PUBLIC_DIR, "vendor")));

// no favicon ships, so answer it rather than log a 404 on every load
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

// a mix of both kinds, so the row can say which it is
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

// one address, one account, whatever the role
app.get("/api/users/email-check", (request, response) => {
  const email = String(request.query.email || "").trim().toLowerCase();
  const staffId = Number(request.query.staffId) || 0;
  const owner = USERS.find((u) => String(u.email || "").toLowerCase() === email && u.staff_id !== staffId);
  response.json(owner ? { taken: true, roleName: owner.role_name } : { taken: false });
});

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

let autoBackupOn = true;

app.get("/api/backups", (request, response) =>
  response.json({
    files: BACKUPS,
    auto: {
      enabled: autoBackupOn, schedule: "daily", hour: 2, keep: 30,
      lastFileName: BACKUPS[1].fileName, lastAt: "2026-08-21T09:30:00.000Z",
      lastError: null, failures: 0
    },
    limits: { automatic: 30, manual: 20, manualCount: BACKUPS.filter((file) => !file.automatic).length }
  }));

app.put("/api/backups/auto", (request, response) => {
  autoBackupOn = request.body.enabled === true;
  response.json({ enabled: autoBackupOn, message: autoBackupOn ? "Automatic backup is on." : "Automatic backup is off." });
});

// Three alerts, served only once a suite asks (POST /api/test/alerts), since
// the other suites assume nothing pops up uninvited.
let alertsOn = false;
const NOTIFICATIONS = [
  { notification_id: 1, notif_type: "Out of Stock", title: "Portland Cement 40kg is out of stock",
    message: "Nothing left on the shelf. The last 6 bags went out on sale #1012 this morning.",
    is_read: 0, created_at: "2026-09-11 08:40:00", product_id: 6, product_name: "Portland Cement 40kg",
    from_name: "System", from_role: "Automatic" },
  { notification_id: 2, notif_type: "Purchase Order", title: "Purchase order #216 raised",
    message: "3 line(s) ordered, awaiting delivery. Check the goods against it when they arrive.",
    is_read: 0, created_at: "2026-09-10 16:05:00", product_id: null, product_name: null,
    from_name: "Manager M. User", from_role: "Manager" },
  { notification_id: 3, notif_type: "Damage Report", title: "2 Claw Hammer reported damaged",
    message: "Handles cracked in the box. Written off.",
    is_read: 1, created_at: "2026-09-09 11:20:00", product_id: 2, product_name: "Claw Hammer",
    from_name: "Clerk I. User", from_role: "Inventory Clerk" }
];

app.get("/api/notifications", (request, response) => response.json(alertsOn ? NOTIFICATIONS : []));
app.post("/api/test/alerts", (request, response) => {
  alertsOn = Boolean(request.body && request.body.on);
  NOTIFICATIONS.forEach((n, i) => { n.is_read = i === 2 ? 1 : 0; });
  response.json({ on: alertsOn });
});
app.post("/api/notifications/:id/read", (request, response) => {
  const n = NOTIFICATIONS.find((item) => item.notification_id === Number(request.params.id));
  if (n) n.is_read = 1;
  response.json({ message: "Marked as read" });
});
app.post("/api/notifications/read-all", (request, response) => {
  NOTIFICATIONS.forEach((n) => { n.is_read = 1; });
  response.json({ message: "All read" });
});
app.get("/api/me", (request, response) => response.json(USERS[0]));

app.get("/api/me/access", (request, response) => response.json({
  staffId: 1, roleName: "System Administrator", page: "/system.html", isAdmin: true,
  isManagement: true, canEditOwnDetails: false, canChangeOwnPassword: true, canEditOwnEmail: false
}));


// ==========================================================================
// SCREENS BY ROLE -- /api/me/* works the role out from the Referer
// ==========================================================================
const FEATURES = [
  ["pos", "New Transaction", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["refunds", "Refunds", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["sales-report", "Sales Report", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["qr-payments", "QR Payments", "Point of Sale", ["Cashier", "Manager"], ["Cashier", "Manager"]],
  ["daily-summary", "Daily Summary", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["credit", "Customer Credit", "Credit", ["Manager", "Cashier"], ["Manager", "Cashier"]],
  ["debt-payments", "Debt Payments", "Credit", ["Cashier"], ["Cashier"]],
  ["credit-requests", "Extension Requests", "Credit", ["Manager"], ["Manager"]],
  ["income", "Income", "Reports", ["Manager"], ["Manager"]],
  ["reports", "Reports", "Reports", ["Manager"], ["Manager"]],
  ["sales", "Sales", "Reports", ["Manager"], ["Manager"]],
  ["material-list", "Material List", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["stock-adjustment", "Stock Adjustment", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["adjustment-history", "Adjustment History", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["reorder-points", "Reorder Point", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["reorder-alerts", "Reorder Alerts", "Inventory", ["Manager"], ["Manager"]],
  ["stock-reports", "Stocks Overview", "Inventory", ["Manager"], ["Manager"]],
  ["returns", "Returned Items", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["damage-report", "Make a Report", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["purchase-orders", "Purchase Orders", "Inventory", ["Manager", "Inventory Clerk"], ["Manager", "Inventory Clerk"]],
  ["deliveries", "Delivery Tracking", "Deliveries", ["Manager", "Cashier"], ["Manager", "Cashier"]],
  ["delivery-runs", "Delivery Runs", "Deliveries", ["Delivery Personnel"], ["Delivery Personnel"]],
  ["delivery-reports", "Delivery Reports", "Deliveries", ["Delivery Personnel"], ["Delivery Personnel"]],
  ["delivery-schedule", "Delivery Schedule", "Deliveries",
    ["Manager", "Cashier", "Inventory Clerk", "Delivery Personnel"], ["Manager"]],
  ["records", "Records", "Records", ["Manager"], ["Manager"]],
  ["archives", "Archives", "Records", ["Manager", "Inventory Clerk"], ["Manager", "Inventory Clerk"]],
  ["staff-passwords", "Staff Passwords", "Staff", ["Manager"], ["Manager"]]
].map(([key, name, module, available, defaults]) => ({
  key, name, module, description: `The ${name} screen.`, available, defaults
}));

const FEATURE_ROLES = ROLES.filter((role) => role.role_name !== "System Administrator");

// as the server does: every screen is offered under every role, and only the
// defaults above decide what a role starts with
FEATURES.forEach((feature) => {
  feature.available = FEATURE_ROLES.map((role) => role.role_name);
});

// role name -> { feature key -> { granted, note, grantedBy, updatedAt } }
const FEATURE_OVERRIDES = {};

function featureCell(feature, roleName) {
  if (!feature.available.includes(roleName)) return { available: false, byDefault: false, held: false, overridden: false };
  const byDefault = feature.defaults.includes(roleName);
  const override = (FEATURE_OVERRIDES[roleName] || {})[feature.key] || null;
  const held = override ? override.granted : byDefault;
  return { available: true, byDefault, held, overridden: Boolean(override) && override.granted !== byDefault,
           note: override ? override.note : null, grantedBy: override ? override.grantedBy : null,
           updatedAt: override ? override.updatedAt : null };
}

function roleOfPage(request) {
  const page = String(request.headers.referer || "").toLowerCase();
  if (page.includes("manager.html")) return "Manager";
  if (page.includes("inventory-dashboard")) return "Inventory Clerk";
  if (page.includes("cashier-dashboard")) return "Cashier";
  if (page.includes("delivery.html")) return "Delivery Personnel";
  return "System Administrator";
}

app.get("/api/me/features", (request, response) => {
  const roleName = roleOfPage(request);
  const features = FEATURES
    .filter((feature) => feature.available.includes(roleName) || roleName === "System Administrator")
    .map((feature) => Object.assign({ key: feature.key, name: feature.name, module: feature.module },
      roleName === "System Administrator"
        ? { available: true, byDefault: true, held: true, overridden: false }
        : featureCell(feature, roleName)));
  response.json({ roleName, features, held: features.filter((f) => f.held).map((f) => f.key) });
});

app.get("/api/features", (request, response) => response.json({
  roles: FEATURE_ROLES,
  features: FEATURES.map((feature) => ({
    key: feature.key, name: feature.name, module: feature.module, description: feature.description,
    roles: Object.fromEntries(FEATURE_ROLES.map((role) => [role.role_name, featureCell(feature, role.role_name)]))
  }))
}));

app.put("/api/features/:key/roles/:roleId", (request, response) => {
  const feature = FEATURES.find((f) => f.key === request.params.key);
  const role = ROLES.find((r) => r.role_id === Number(request.params.roleId));
  const body = request.body || {};
  if (!feature) return response.status(404).json({ error: "No screen is listed under that name." });
  if (!role) return response.status(404).json({ error: "No such role." });
  if (typeof body.granted !== "boolean") return response.status(400).json({ error: "Say whether the screen is granted: true or false." });
  if (role.role_name === "System Administrator") {
    return response.status(403).json({ error: "The System Administrator holds every screen by role. Nothing here is granted or taken away." });
  }
  if (!feature.available.includes(role.role_name)) {
    return response.status(400).json({ error: `The ${role.role_name} dashboard has no ${feature.name} screen to show, so it cannot be granted there.` });
  }

  const byDefault = feature.defaults.includes(role.role_name);
  FEATURE_OVERRIDES[role.role_name] = FEATURE_OVERRIDES[role.role_name] || {};
  if (body.granted === byDefault) {
    delete FEATURE_OVERRIDES[role.role_name][feature.key];
  } else {
    FEATURE_OVERRIDES[role.role_name][feature.key] = {
      granted: body.granted, note: body.note || null, grantedBy: "Admin S. User", updatedAt: "2026-09-15 10:00:00"
    };
  }

  response.json({
    message: `${feature.name} is now ${body.granted ? "on" : "off"} the ${role.role_name} menu.`,
    changed: true,
    cell: featureCell(feature, role.role_name)
  });
});

// a way for a test to put the switches back
app.post("/api/test/features/reset", (request, response) => {
  for (const key of Object.keys(FEATURE_OVERRIDES)) delete FEATURE_OVERRIDES[key];
  response.json({ ok: true });
});
// ==========================================================================
// CREATING AN ACCOUNT IS TWO REQUESTS (review, then create from the draft)
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

// ==========================================================================
// STAFF PASSWORDS -- the manager's fallback; the same refusals as the server
// ==========================================================================
const FLOOR_ROLES = ["Cashier", "Inventory Clerk", "Delivery Personnel"];

app.get("/api/staff/passwords", (request, response) => {
  response.json(USERS
    .filter((u) => u.email && FLOOR_ROLES.includes(u.role_name) && !u.archived_at)
    .map((u) => ({
      staff_id: u.staff_id, full_name: u.full_name, is_active: u.is_active, role_name: u.role_name,
      email: u.email, must_change_password: u.must_change_password, last_login: u.last_login,
      held_until: u.staff_id % 6 === 2 ? "2026-09-23 10:15:00" : null
    })));
});

app.post("/api/staff/:id/reset-password", (request, response) => {
  const user = USERS.find((u) => u.staff_id === Number(request.params.id));
  if (!user) return response.status(404).json({ error: "Staff record not found" });
  if (!FLOOR_ROLES.includes(user.role_name)) {
    return response.status(403).json({
      error: "A manager resets the passwords of cashiers, inventory clerks and delivery personnel only."
    });
  }
  if (!user.email) return response.status(404).json({ error: "This staff member has no login account." });
  user.must_change_password = true;
  // odd ids stand in for a mail that could not go, so both outcomes are seen
  const emailed = user.staff_id % 2 === 0;
  response.json({
    message: "Password reset. The new one has to be changed on the next sign-in.",
    name: user.full_name, email: user.email, emailed: emailed,
    password: emailed ? undefined : "Stub7Pass!word",
    reason: emailed ? undefined : "Mail is not set up on this server, so the password could not be sent."
  });
});

// ==========================================================================
// FORGOT YOUR PASSWORD? -- 123456 is the code the stub "sends"
// ==========================================================================
app.post("/api/password-reset/request", (request, response) => {
  const email = String((request.body || {}).email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: "Type the email address you sign in with." });
  }
  response.json({
    message: "If that address belongs to an account here, a six-digit code is on its way to it. " +
             "It stops working in 15 minutes. Only one code is sent a minute, so give it a moment before asking again.",
    minutes: 15
  });
});

app.post("/api/password-reset/confirm", (request, response) => {
  const body = request.body || {};
  if (!/^\d{6}$/.test(String(body.code || ""))) {
    return response.status(400).json({ error: "The code is the six digits in the email." });
  }
  if (typeof body.newPassword !== "string" || body.newPassword.length < 8) {
    return response.status(400).json({ error: "The new password must contain at least 8 characters." });
  }
  if (body.code !== "123456") {
    return response.status(400).json({
      error: "That code is not right, or it has stopped working. A code lasts 15 minutes and 5 tries; ask for a new one if it has run out."
    });
  }
  response.json({ message: "Your password was changed. Sign in with the new one." });
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
    supplier_id: (index % 2) + 1,
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
  // every third delivered order still has money owed: the Pending Cash Collection case
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
    // the stub's driver is staff 5; every fifth delivery nobody has taken yet
    delivery_staff_id: index % 5 === 4 ? null : 5,
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

// everything staff filed, the way the manager's All Reports table reads it
const ACTIVITY = [
  ["SALE", "Cashier", "Sale #1042 for Pedro Penduko: 2,450.00 by Cash, Paid"],
  ["PAYMENT", "Cashier", "Pedro Penduko paid 1,000.00 on sale #1005 by Cash"],
  ["DAMAGE", "Inventory Clerk", "Claw Hammer x2: Casing cracked during unloading (Pending)"],
  ["REFUND", "Cashier", "Tox Screw Set 100pc x10 from sale #1010: Wrong gauge (Resolved)"],
  ["RETURN", "Inventory Clerk", "PVC Pipe 1/2\" x2 from sale #1007: Over-ordered (Resolved)"],
  ["STOCK_ADJUST", "Inventory Clerk", "Copper Wire 2.0mm: Recount 80 to 76 meter - Physical count"],
  ["DELIVERY", "Delivery Personnel", "Sale #1040 to Pedro Penduko: Delivered, delivered 18 Sep"],
  ["CREDIT_REQUEST", "Cashier", "Pedro Penduko: 50,000.00 to 60,000.00 - Bigger site (Approved)"],
  ["CREDIT_APPROVED", "Manager", "Pedro Penduko: request #9 approved at 60,000.00"],
  ["CREDIT_LIMIT", "Manager", "Maria Santos: limit 20,000.00, Good"]
];
app.get("/api/reports/activity", (request, response) => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const [kind, role, details] = ACTIVITY[index % ACTIVITY.length];
    const staff = USERS.find((user) => user.role_name === role) || USERS[index % USERS.length];
    const when = new Date(Date.UTC(2026, 8, 19, 17, 0) - index * 47 * 60000);
    return {
      kind: kind, happened_at: when.toISOString().slice(0, 19).replace("T", " "), ref: 900 - index,
      details: details, staff_name: staff.full_name, role_name: role
    };
  });
  response.json(rows);
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
  if (RUNG_UP[Number(request.params.id)]) {
    return response.json(Object.assign({}, RUNG_UP[Number(request.params.id)],
      { qrPayments: qrStubOfSale(Number(request.params.id)) }));
  }
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
    delivery: DELIVERIES.find((d) => d.sale_id === sale.sale_id) || null,
    qrPayments: qrStubOfSale(sale.sale_id)
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

app.put("/api/stocks/:id/price", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  if (!product) return response.status(404).json({ error: "That product was not found." });
  const price = Number(request.body.price);
  if (!Number.isFinite(price) || price < 0) return response.status(400).json({ error: "The price has to be a figure of zero or more." });
  product.price = Math.round(price * 100) / 100;
  product.stock_value = product.quantity_in_stock * product.price;
  response.json({ message: `${product.product_name} now sells at ${product.price.toFixed(2)}, from the next sale on.`, changed: true, price: product.price });
});

app.get("/api/deliveries", (request, response) => response.json(DELIVERIES));
// what is on the lorry, for the Items tab of the delivery popup
app.get("/api/deliveries/:id/items", (request, response) => {
  const delivery = DELIVERIES.find((d) => d.delivery_id === Number(request.params.id));
  if (!delivery) return response.status(404).json({ error: "Delivery not found" });
  response.json([
    { quantity: 2, unit_name: "sack", base_quantity: 100, base_unit: "kg",
      unit_price: 280, subtotal: 560, product_name: "Portland Cement" },
    { quantity: 5, unit_name: "piece", base_quantity: 5, base_unit: "piece",
      unit_price: 45, subtotal: 225, product_name: "Hollow Block 4in" }
  ]);
});
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
// ==========================================================================
const STANDINGS = ["Good", "Good", "Watch", "Good", "Hold", "Good", "Watch"];

// the same rules as vw_customer_credit
function standingOf(row) {
  const manual = row.manual_standing;
  const limit = Number(row.credit_limit), owed = Number(row.current_credit);
  const days = row.oldest_debt_days === null ? 0 : Number(row.oldest_debt_days);
  const note = row.credit_notes ? `: ${row.credit_notes}` : "";

  if (manual === "Hold") return ["Hold", `Put on hold by a manager${note}`];
  if (limit > 0 && owed > limit) return ["Hold", `Over the limit by ${(owed - limit).toFixed(2)}`];
  if (days > 90) return ["Hold", `Oldest unpaid sale is ${days} days old; the limit is 90`];
  if (manual === "Watch") return ["Watch", `Flagged by a manager${note}`];
  if (days > 30) return ["Watch", `Oldest unpaid sale is ${days} days old; watched past 30`];
  if (limit > 0 && owed >= limit * 0.75) return ["Watch", `Owes ${Math.round(owed / limit * 100)}% of the limit; watched from 75%`];
  return ["Good", owed > 0 ? "Owes within terms" : "Nothing owed"];
}

function applyStanding(row) {
  const [standing, reason] = standingOf(row);
  row.computed_standing = standingOf({ ...row, manual_standing: "Good" })[0];
  row.standing = standing;
  row.standing_reason = reason;
  return row;
}

// the late-payment policy: the shop's rate, and what the sweep has charged
const POLICY = { penalty_rate: "3.00", updated_at: "2026-09-01 09:00:00", updated_by: "Manager M. User" };

const CREDIT = RECORDS.customer.map((c, index) => {
  const limit = 10000 + index * 5000;
  // every third account owes something, and one of them is over its limit
  const owed = index % 3 === 0 ? Math.round(limit * (index === 6 ? 1.2 : 0.45)) : 0;
  const days = owed > 0 ? 5 + index * 9 : null;
  // an account past its due date carries the months of penalty the sweep charged it
  const months = days !== null && days > 30 ? Math.ceil((days - 30) / 30) : 0;
  const penalty = Math.round(owed * 0.03 * months * 100) / 100;

  return applyStanding({
    customer_id: c.id,
    customer_name: c.name,
    phone: c.phone,
    address: "Quezon City, Metro Manila",
    credit_limit: limit,
    manual_standing: STANDINGS[index % STANDINGS.length],
    credit_notes: STANDINGS[index % STANDINGS.length] === "Hold"
      ? "Cheque bounced in August. No new credit until it clears." : null,
    credit_updated_at: "2026-08-30 09:00:00",
    penalty_rate_override: index === 3 ? "1.00" : null,
    penalty_rate: index === 3 ? "1.00" : POLICY.penalty_rate,
    total_purchase: 20000 + index * 3100,
    current_credit: owed + penalty,
    penalties_owed: penalty,
    overdue_sales: penalty > 0 ? 1 : 0,
    available_credit: Math.max(limit - owed - penalty, 0),
    open_sales: owed > 0 ? 1 + (index % 3) : 0,
    oldest_debt_days: days,
    last_purchase: "2026-09-0" + ((index % 4) + 1) + " 10:00:00",
    last_payment: owed > 0 ? "2026-08-2" + (index % 9) + " 14:00:00" : null,
    pending_requests: index === 3 ? 1 : 0
  });
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

// every sale still owing, for the counter's Debt Payments screen
function openSaleRows() {
  return SALES.filter((s) => !s.is_archived && s.balance_due > 0).map((s, index) => {
    const credit = CREDIT[index % CREDIT.length];
    const daysOld = 5 + index * 9;
    const due = new Date(2026, 8, 17 - daysOld + 30);
    const method = s.payment_method === "COD" ? "COD" : "Credit";
    // a Credit sale past its due date was charged the penalty by the sweep
    if (s.penalty_amount === undefined) {
      s.penalty_months = method === "Credit" && daysOld > 30 ? Math.ceil((daysOld - 30) / 30) : 0;
      s.penalty_amount = Math.round((s.final_amount - s.amount_paid) * Number(credit.penalty_rate) / 100 * s.penalty_months * 100) / 100;
      s.penalty_rate = s.penalty_amount > 0 ? credit.penalty_rate : null;
      s.penalty_applied_at = s.penalty_amount > 0 ? "2026-09-17 06:00:00" : null;
      s.amount_due = Math.round((s.final_amount + s.penalty_amount) * 100) / 100;
      s.balance_due = Math.max(Math.round((s.amount_due - s.amount_paid) * 100) / 100, 0);
    }
    return {
      sale_id: s.sale_id, sale_date: s.sale_date, customer_id: credit.customer_id,
      customer_name: credit.customer_name, phone: credit.phone,
      payment_method: method, payment_status: s.payment_status,
      final_amount: s.final_amount, amount_paid: s.amount_paid, balance_due: s.balance_due,
      penalty_rate: s.penalty_rate, penalty_months: s.penalty_months, penalty_amount: s.penalty_amount,
      penalty_applied_at: s.penalty_applied_at, amount_due: s.amount_due,
      days_old: daysOld, due_date: due.toISOString().slice(0, 10),
      standing: credit.standing, payment_count: s.amount_paid > 0 ? 1 : 0,
      last_payment: s.amount_paid > 0 ? s.sale_date : null
    };
  });
}

app.get("/api/credit/open-sales", (request, response) => response.json(openSaleRows()));

app.post("/api/sales/:id/payment", async (request, response) => {
  const sale = SALES.find((s) => s.sale_id === Number(request.params.id));
  const body = request.body || {};
  if (!sale) return response.status(404).json({ error: "Sale not found, or it has no customer to bill." });
  if (!body.amount || !body.paymentMethod) return response.status(400).json({ error: "Amount and payment method are required" });
  const amount = Number(body.amount);
  if (amount <= 0) return response.status(400).json({ error: "Payment amount must be greater than zero." });
  if (amount > sale.balance_due + 0.004) {
    return response.status(400).json({ error: `Payment is larger than the balance due of ${sale.balance_due.toFixed(2)}` });
  }
  let qr = null;
  if (body.qrPaymentId) {
    if (!["GCash", "PayMaya"].includes(body.paymentMethod)) {
      return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash or PayMaya." });
    }
    const refused = await qrStubCheck(body.qrPaymentId, amount, body.paymentMethod);
    if (refused) return response.status(refused.status).json({ error: refused.message, code: refused.code });
    qr = QR_ROWS.get(Number(body.qrPaymentId));
    qrStubLink(qr, sale.sale_id);
  }
  sale.amount_paid = Math.round((sale.amount_paid + amount) * 100) / 100;
  const due = sale.amount_due !== undefined ? sale.amount_due : sale.final_amount;
  sale.balance_due = Math.max(Math.round((due - sale.amount_paid) * 100) / 100, 0);
  sale.payment_status = sale.balance_due <= 0 ? "Paid" : "Partial";
  sale.transaction_status = sale.balance_due <= 0 ? "Completed" : "Partial Credit";
  response.json({ message: "Payment recorded.", reference: qr ? qr.reference : null });
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

  const own = request.body.penaltyRate;
  if (own !== undefined && own !== null && String(own).trim() !== "" &&
      !(Number.isFinite(Number(own)) && Number(own) >= 1 && Number(own) <= 3)) {
    return response.status(400).json({ error: "A late-payment rate is 1 to 3 percent a month. Leave it blank for the shop's rate." });
  }
  credit.credit_limit = Number(request.body.creditLimit);
  credit.manual_standing = request.body.standing || "Good";
  credit.credit_notes = request.body.notes || null;
  credit.penalty_rate_override = own === undefined || own === null || String(own).trim() === "" ? null : Number(own).toFixed(2);
  credit.penalty_rate = credit.penalty_rate_override || POLICY.penalty_rate;
  credit.available_credit = Math.max(credit.credit_limit - credit.current_credit, 0);
  applyStanding(credit);

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

app.get("/api/credit/policy", (request, response) => {
  const open = openSaleRows().filter((s) => s.penalty_amount > 0);
  response.json({
    ...POLICY,
    own_rate_accounts: CREDIT.filter((c) => c.penalty_rate_override !== null).length,
    penalised_sales: open.length,
    penalties_owed: open.reduce((sum, s) => sum + s.penalty_amount, 0)
  });
});

app.put("/api/credit/policy", (request, response) => {
  const rate = Number((request.body || {}).penaltyRate);
  if (!Number.isFinite(rate) || rate < 1 || rate > 3) {
    return response.status(400).json({ error: "The late-payment rate is 1 to 3 percent a month. The default is 3." });
  }
  POLICY.penalty_rate = rate.toFixed(2);
  POLICY.updated_at = "2026-09-17 10:00:00";
  POLICY.updated_by = "Manager M. User";
  CREDIT.forEach((c) => { if (c.penalty_rate_override === null) c.penalty_rate = POLICY.penalty_rate; });
  response.json({
    message: `Saved. A credit sale past its due date is now charged ${rate.toFixed(2)}% of what is still unpaid on it, every month it stays overdue.`,
    penalty_rate: POLICY.penalty_rate
  });
});

app.get("/api/customers/:id/history", (request, response) => {
  const credit = CREDIT.find((c) => c.customer_id === Number(request.params.id));
  if (!credit) return response.status(404).json({ error: "Not found" });

  openSaleRows();   // stamps the penalties on the sales that carry one
  const purchases = SALES.slice(0, 9).map((s, i) => ({
    sale_id: s.sale_id, sale_date: s.sale_date, total_amount: s.total_amount,
    discount: 0, final_amount: s.final_amount, amount_paid: s.amount_paid,
    payment_method: s.payment_method, payment_status: s.payment_status,
    reference_no: null, is_archived: false,
    penalty_rate: s.penalty_rate || null, penalty_months: s.penalty_months || 0, penalty_amount: s.penalty_amount || 0,
    penalty_applied_at: s.penalty_applied_at || null,
    amount_due: s.amount_due !== undefined ? s.amount_due : s.final_amount,
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

// the sizes some products also sell in: product id -> [{unit_name, units_per, price}]
let UNIT_ID = 1;
const SELLING_UNITS = {};
STOCKS.forEach((p, index) => {
  if (index % 4 === 1) {
    SELLING_UNITS[p.product_id] = [
      { product_unit_id: UNIT_ID++, unit_name: "box", units_per: 10, price: p.price * 9 },
      { product_unit_id: UNIT_ID++, unit_name: "pallet", units_per: 100, price: null }
    ];
  } else if (index % 4 === 2) {
    SELLING_UNITS[p.product_id] = [
      { product_unit_id: UNIT_ID++, unit_name: "sack", units_per: 25, price: p.price * 23 }
    ];
  }
});

// the till's product grid
// the pack a material is delivered in, set from the material's card
app.put("/api/inventory/products/:id/pack", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  if (!product) return response.status(404).json({ error: "Product not found" });
  const name = String(request.body.packName || "").trim();
  const size = Number(request.body.packSize);
  if (name !== "" && !(size > 0)) return response.status(400).json({ error: "Say how much of the unit one pack holds, like 20." });
  product.pack_name = name || null; product.pack_size = name ? size : null;
  response.json({ message: name ? `${product.product_name} is delivered by the ${name} of ${size} ${product.unit_name}.` : `${product.product_name} is delivered by the ${product.unit_name} again.`, packName: product.pack_name, packSize: product.pack_size });
});

// the clerk's reorder point, set from the row's card
app.put("/api/inventory/reorder/:id", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  if (!product) return response.status(404).json({ error: "Not found" });
  const point = Number(request.body.reorderPoint);
  if (!Number.isInteger(point) || point < 0) return response.status(400).json({ error: "A reorder point cannot be negative." });
  product.reorder_point = point;
  response.json({ message: `${product.product_name} is now reordered at ${point}.` });
});

app.get("/api/inventory/products", (request, response) =>
  response.json(STOCKS.map((p) => ({
    product_id: p.product_id, product_name: p.product_name, price: p.price,
    quantity_in_stock: p.quantity_in_stock === 0 ? 40 : p.quantity_in_stock,
    unit_name: p.unit_name, category_name: p.category_name, brand_name: p.brand_name,
    reorder_point: p.reorder_point, status: "Active", is_archived: false,
    pack_name: p.pack_name || null, pack_size: p.pack_size || null,
    supplier_id: p.supplier_id, supplier_name: p.supplier_name,
    stock_status: p.stock_status === "Out of Stock" ? "In Stock" : p.stock_status,
    selling_units: SELLING_UNITS[p.product_id] || []
  }))));

app.get("/api/inventory/products/:id/units", (request, response) =>
  response.json(SELLING_UNITS[Number(request.params.id)] || []));

app.post("/api/inventory/products/:id/units", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  if (!product) return response.status(404).json({ error: "That material was not found." });
  const body = request.body || {};
  const name = String(body.unitName || "").trim();
  if (!name) return response.status(400).json({ error: "Name the size, like box or sack." });
  if (!(Number(body.unitsPer) > 0)) return response.status(400).json({ error: "Say how many of the product's own unit one of these holds." });
  if (name.toLowerCase() === String(product.unit_name).toLowerCase()) {
    return response.status(400).json({ error: `${product.product_name} is already kept by the ${product.unit_name}; add a bigger size, like box or sack.` });
  }
  const list = SELLING_UNITS[product.product_id] = SELLING_UNITS[product.product_id] || [];
  const price = body.price === null || body.price === undefined || body.price === "" ? null : Number(body.price);
  const found = list.find((u) => u.unit_name.toLowerCase() === name.toLowerCase());
  if (found) { found.units_per = Number(body.unitsPer); found.price = price; }
  else list.push({ product_unit_id: UNIT_ID++, unit_name: name, units_per: Number(body.unitsPer), price });
  list.sort((a, b) => a.units_per - b.units_per);
  response.json({ message: `${product.product_name} now sells by the ${name} (${body.unitsPer} ${product.unit_name}).`, units: list });
});

app.delete("/api/inventory/products/:id/units/:unitId", (request, response) => {
  const product = STOCKS.find((p) => p.product_id === Number(request.params.id));
  const list = SELLING_UNITS[Number(request.params.id)] || [];
  const index = list.findIndex((u) => u.product_unit_id === Number(request.params.unitId));
  if (!product || index === -1) return response.status(404).json({ error: "That size is not on the list." });
  const [gone] = list.splice(index, 1);
  response.json({ message: `${product.product_name} no longer sells by the ${gone.unit_name}.`, units: list });
});

// ringing a sale up: the lines are priced in the size they name
let NEXT_SALE = 2000;
const RUNG_UP = {};
app.post("/api/sales", async (request, response) => {
  const body = request.body || {};
  if (!body.paymentMethod || !Array.isArray(body.items) || body.items.length === 0) {
    return response.status(400).json({ error: "A payment method and at least one item are required" });
  }
  const items = [];
  for (const line of body.items) {
    const product = STOCKS.find((p) => p.product_id === Number(line.product_id));
    if (!product) return response.status(404).json({ error: `Product ID ${line.product_id} is invalid or inactive.` });
    const size = line.unit
      ? (SELLING_UNITS[product.product_id] || []).find((u) => u.unit_name.toLowerCase() === String(line.unit).toLowerCase())
      : null;
    if (line.unit && !size && String(line.unit).toLowerCase() !== String(product.unit_name).toLowerCase()) {
      return response.status(400).json({ error: `${product.product_name} is not sold by the ${line.unit}.` });
    }
    const per = size ? size.units_per : 1;
    const each = size ? (size.price === null ? Math.round(product.price * per * 100) / 100 : size.price) : product.price;
    items.push({
      product_name: product.product_name, quantity: Number(line.quantity),
      unit_name: size ? size.unit_name : product.unit_name,
      base_quantity: Number(line.quantity) * per, base_unit: product.unit_name,
      unit_price: each, subtotal: Math.round(Number(line.quantity) * each * 100) / 100
    });
  }
  const total = items.reduce((sum, it) => sum + it.subtotal, 0);
  const onAccount = body.paymentMethod === "Credit" || body.paymentMethod === "COD";
  const paid = onAccount ? Number(body.amountPaid) || 0 : Number(body.amountPaid) || 0;
  if (!onAccount && paid < total) return response.status(400).json({ error: "Amount paid is less than the total balance due." });
  // the same reference rule as the server: a cheque or a transfer taken today needs one
  const takenNow = body.paymentMethod === "Credit"
    ? (paid > 0 ? (body.downPaymentMethod || "Cash") : null)
    : (body.paymentMethod === "COD" ? null : body.paymentMethod);
  const reference = typeof body.referenceNo === "string" ? body.referenceNo.trim() : "";
  if (["Cheque", "Bank Transfer"].includes(takenNow) && reference === "") {
    return response.status(400).json({ error: `A ${takenNow.toLowerCase()} needs its reference.` });
  }
  // paid by QR code: the same check as the server, with the same rule
  let qr = null;
  if (body.qrPaymentId) {
    if (!["GCash", "PayMaya"].includes(takenNow)) {
      return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash or PayMaya." });
    }
    const refused = await qrStubCheck(body.qrPaymentId, paid, takenNow);
    if (refused) return response.status(refused.status).json({ error: refused.message, code: refused.code });
    qr = QR_ROWS.get(Number(body.qrPaymentId));
  }
  // a quantity of 9999 or more stands for an item that ran out after the money came in
  if (qr && body.items.some((line) => Number(line.quantity) >= 9999)) {
    qrStubSet(qr, "paid", null, QR_UNSAVED_NOTE);
    return response.status(409).json({ error: "Not enough stock for this item. Only 120 left." });
  }
  const saleId = NEXT_SALE++;
  RUNG_UP[saleId] = {
    sale: {
      sale_id: saleId, sale_date: "2026-09-17 10:15:00", total_amount: total, discount: 0, final_amount: total,
      amount_paid: onAccount ? paid : paid, change_given: onAccount ? 0 : paid - total,
      payment_method: body.paymentMethod,
      payment_status: paid >= total ? "Paid" : (paid > 0 ? "Partial" : "Unpaid"),
      customer_name: body.walkInName || (body.customerId ? (RECORDS.customer.find((c) => c.id === Number(body.customerId)) || {}).name : null) || "Walk-in",
      cashier_name: "Cashier C. User",
      reference_no: qr ? qr.reference
        : (["Cheque", "Bank Transfer", "GCash", "PayMaya", "PayPal"].includes(takenNow) && reference ? reference : null),
      tax_registration: "VAT", vat_rate: 12, vat_amount: Math.round(total * 12 / 112 * 100) / 100,
      vatable_sale: total - Math.round(total * 12 / 112 * 100) / 100, vat_exempt_sale: 0, zero_rated_sale: 0
    },
    items,
    payments: body.paymentMethod === "Credit" && paid > 0
      ? [{ amount: paid, payment_method: body.downPaymentMethod || "Cash", reference_no: "Down payment at counter",
           payment_date: "2026-09-17 10:15:00", received_by: "Cashier C. User" }]
      : [],
    delivery: null
  };
  if (qr) qrStubLink(qr, saleId);
  response.json({ message: "Sale transaction completed successfully.", saleId, referenceNote: null });
});

app.get("/api/sales/undelivered", (request, response) => response.json([]));

// every till screen reads this to head an invoice
const STORE = {
  setting_id: 1,
  store_name: "Stub Hardware & Supply",
  proprietor: "Stub S. Owner",
  address: "123 Rizal Avenue, Quezon City",
  tin: "123-456-789-00000",
  registration_type: "VAT",
  vat_rate: "12.00",
  invoice_note: "Thank you for your business.",
  get penalty_rate() { return POLICY.penalty_rate; },
  bank_name: "BDO Unibank",
  bank_account_name: "Stub Hardware & Supply",
  bank_account_number: "0012 3456 7890",
  updated_at: "2026-09-01 09:00:00",
  updated_by: "Admin S. User",
  receipt_layout: {
    paperWidth: 80, fontSize: 12, title: "Sales Invoice", paidLabel: "PAID IN FULL",
    headerLines: [], footerLines: ["Thank you for your purchase"],
    show: { proprietor: true, cashier: true, customer: true, payment: true, reference: true,
            item_count: true, tax: true, bank: true, note: true }
  }
};

app.get("/api/store-settings", (request, response) => response.json(STORE));

// refuses the same TIN shapes the real server refuses
app.put("/api/store-settings", (request, response) => {
  const body = request.body || {};
  const digits = String(body.tin || "").replace(/\D/g, "");

  if (![9, 12, 14].includes(digits.length) || /^0+$/.test(digits.slice(0, 9))) {
    return response.status(400).json({ error: "That is not a TIN the BIR would have issued." });
  }

  // all three bank boxes are required, as the server has it
  const bank = [body.bankName, body.bankAccountName, body.bankAccountNumber].map((v) => String(v || "").trim());
  if (bank.some((v) => v === "")) {
    return response.status(400).json({ error: "The bank, the account name and the account number are all required." });
  }
  Object.assign(STORE, { bank_name: bank[0], bank_account_name: bank[1], bank_account_number: bank[2] });
  if (body.receiptLayout && typeof body.receiptLayout === "object") STORE.receipt_layout = body.receiptLayout;

  Object.assign(STORE, {
    store_name: body.storeName,
    proprietor: body.proprietor || null,
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
    status: "Resolved", return_date: "2026-09-01 09:20:00", sale_id: 1002,
    product_id: 4, product_name: "Latex Paint White", unit_name: "liter",
    reported_by: "Ana Reyes", inspected_by: "Clerk I. User", inspected_at: "2026-09-01 15:00:00",
    inspection_note: "Both tins dented through, lids will not seal." },
  // taken back at the counter, waiting for the clerk to look at it
  { return_id: RETURN_ID++, report_type: "Refunded", quantity: 1,
    reason: "Customer said it was the wrong size, box unopened.",
    disposition: null, refund_amount: 450, restocked: false, awaiting_inspection: 1,
    status: "Open", return_date: "2026-09-04 10:10:00", sale_id: 1005,
    product_id: 2, product_name: "Claw Hammer", unit_name: "pcs",
    reported_by: "Cashier C. User", inspected_by: null, inspected_at: null, inspection_note: null }
];

app.post("/api/returns", (request, response) => {
  const reason = String(request.body.reason || "").trim();
  if (reason.length < 10) {
    return response.status(400).json({ error: "Say what happened, in a sentence." });
  }

  const type = request.body.reportType || "Refunded";
  const where = ["Return to Stock", "Write-Off"].includes(request.body.disposition)
    ? request.body.disposition
    : (request.body.restock === true ? "Return to Stock" : null);

  // a refund from the counter waits for the clerk; anything else says where the goods go
  if (!where && type !== "Refunded") {
    return response.status(400).json({ error: "Say where the goods go: Return to Stock, or Write-Off." });
  }

  const product = STOCKS.find((p) => p.product_id === Number(request.body.productId));
  const created = {
    return_id: RETURN_ID++, report_type: request.body.reportType || "Refunded",
    quantity: Number(request.body.quantity), reason,
    disposition: where, refund_amount: Number(request.body.refundAmount || 0),
    restocked: where === "Return to Stock", status: "Open", awaiting_inspection: where ? 0 : 1,
    inspected_by: null, inspected_at: null, inspection_note: null,
    return_date: "2026-09-04 12:30:00", sale_id: request.body.saleId || null,
    product_id: Number(request.body.productId),
    product_name: product ? product.product_name : "Product",
    unit_name: product ? product.unit_name : "pcs",
    reported_by: "Cashier C. User"
  };
  RETURNS.unshift(created);

  response.json({
    message: where
      ? `${created.report_type} filed for ${created.product_name}.`
      : `${created.report_type} report filed. The goods are set aside for the stockroom to inspect.`,
    reportId: created.return_id, disposition: where, awaitingInspection: where === null
  });
});

// the clerk's verdict on a refund from the counter, or simply closing a decided report
app.post("/api/returns/:id/resolve", (request, response) => {
  const report = RETURNS.find((r) => r.return_id === Number(request.params.id));
  if (!report) return response.status(404).json({ error: "Report not found." });
  if (report.status === "Resolved") return response.status(400).json({ error: "That report is already resolved." });

  const verdict = ["Return to Stock", "Write-Off"].includes((request.body || {}).disposition)
    ? request.body.disposition : null;
  const note = String((request.body || {}).note || "").trim() || null;

  if (!report.disposition) {
    if (!verdict) {
      return response.status(400).json({ error: "Say what the inspection found: Return to Stock if it can be sold again, or Write-Off if not." });
    }
    report.disposition = verdict;
    report.restocked = verdict === "Return to Stock";
    const stock = STOCKS.find((p) => p.product_id === report.product_id);
    if (stock && report.restocked) stock.quantity_in_stock += report.quantity;
  }
  report.status = "Resolved";
  report.awaiting_inspection = 0;
  report.inspected_by = "Clerk I. User";
  report.inspected_at = "2026-09-04 16:00:00";
  report.inspection_note = note;

  response.json({
    message: !verdict ? "Report marked resolved."
      : verdict === "Return to Stock"
        ? `${report.product_name} is back on the shelf: stock up by ${report.quantity}.`
        : `${report.product_name} is written off. It does not go back on the shelf.`,
    disposition: verdict
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

// ==========================================================================
// PURCHASE ORDERS
// ==========================================================================
// the printed order's QR code, made the way the server makes it
const QRCode = require("qrcode");

const PURCHASE_ORDERS = Array.from({ length: 17 }, (_, i) => ({
  po_id: 200 + i,
  supplier_id: (i % 2) + 1,
  supplier_name: i % 2 ? "Cebu Tool Co." : "Manila Hardware Supply",
  contact_person: i % 2 ? "Rina Ocampo" : "Ben Cruz",
  contact_number: "0917000" + String(2000 + i),
  order_date: `2026-08-${String(10 + (i % 19)).padStart(2, "0")} 08:00:00`,
  line_count: (i % 4) + 1,
  total_units: ((i % 4) + 1) * 12,
  goods_cost: 12000 + i * 2300, discount: i % 4 === 2 ? 500 : 0,
  total_cost: 12000 + i * 2300 - (i % 4 === 2 ? 500 : 0),
  status: ["For Approval", "Pending", "Received", "Cancelled"][i % 4],
  raised_by: "Clerk I. User",
  confirmed_by: i % 4 === 0 ? null : "Manager M. User",
  confirmed_at: i % 4 === 0 ? null : "2026-08-28 10:00:00",
  decision_note: i % 4 === 3 ? "Ordered elsewhere at a better price" : null,
  // most orders go to a supplier with an address to email; #204 and #212 do not,
  // so confirming them shows the manager what to do instead
  supplier_email: i % 8 === 4 ? null : (i % 2 ? "sales@cebu-tool.test" : "orders@manila-hardware.test"),
  // the approved orders here were already sent; one the manager approves now is still to print and send
  supplier_sent_at: i % 4 === 1 ? "2026-08-28 11:00:00" : null,
  supplier_response: null, supplier_responded_at: null, supplier_note: null
}));

function purchaseOrderLines(poId) {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(poId));
  if (!po) return [];
  if (po.items) return po.items;      // an order raised through the form keeps its own lines
  return Array.from({ length: po.line_count }, (_, i) => {
    const p = STOCKS[(poId + i) % STOCKS.length];
    return {
      product_id: p.product_id, product_name: p.product_name, unit_name: p.unit_name,
      category_name: p.category_name, brand_name: p.brand_name,
      quantity: 12, unit_cost: 250 + i * 10, line_cost: 12 * (250 + i * 10),
      quantity_in_stock: p.quantity_in_stock,
      pack_name: null, pack_size: null, pack_count: null
    };
  });
}

app.get("/api/purchase-orders", (request, response) => response.json(PURCHASE_ORDERS));
app.get("/api/purchase-orders/:id/items", (request, response) =>
  response.json(purchaseOrderLines(request.params.id)));
function supplierLink(po) {
  return `http://localhost:${PORT}/supplier-order.html?code=${"S".repeat(40)}${po.po_id}`;
}
app.get("/api/purchase-orders/:id/document", async (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (!po) return response.status(404).json({ error: "That purchase order does not exist" });
  response.json({
    order: Object.assign({ supplier_email: "sales@supplier.test", supplier_address: "Cebu City",
                           raised_by: "Manager M. User" }, po),
    items: purchaseOrderLines(po.po_id),
    shop: STORE,
    // an approved order's print carries the supplier's link and QR code
    supplier_link: po.status === "Pending" ? supplierLink(po) : undefined,
    supplier_qr: po.status === "Pending" ? await QRCode.toDataURL(supplierLink(po), { margin: 1 }) : undefined
  });
});
app.post("/api/purchase-orders",(request, response) => {
  const items = Array.isArray(request.body.items) ? request.body.items : [];
  const po = {
    po_id: 200 + PURCHASE_ORDERS.length,
    supplier_id: 1,
    supplier_name: request.body.supplierName || "Manila Hardware Supply",
    contact_person: request.body.contactPerson || "Ben Cruz",
    contact_number: request.body.contactNumber || "09170002000",
    order_date: "2026-09-11 09:00:00",
    line_count: items.length,
    total_units: items.reduce((sum, it) => sum + Number(it.quantity || 0), 0),
    goods_cost: 0, discount: 0, total_cost: 0,
    status: "For Approval", raised_by: "Clerk I. User", confirmed_by: null, confirmed_at: null, decision_note: null,
    items: items.map((it) => {
      const p = STOCKS.find((x) => x.product_id === Number(it.productId)) || {};
      return { product_id: Number(it.productId) || 0, product_name: p.product_name || it.newName || "New material",
               unit_name: p.unit_name || it.unitName || "", category_name: p.category_name || "", brand_name: p.brand_name || "",
               quantity: Number(it.quantity || 0), unit_cost: Number(it.unitCost || 0),
               line_cost: Number(it.quantity || 0) * Number(it.unitCost || 0), quantity_in_stock: p.quantity_in_stock || 0,
               pack_name: it.packName || null, pack_size: it.packSize || null, pack_count: it.packCount || null };
    })
  };
  PURCHASE_ORDERS.unshift(po);
  response.json({ message: `Purchase order #${po.po_id} sent to the manager to confirm.`, poId: po.po_id });
});
app.post("/api/purchase-orders/:id/decide", (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (!po) return response.status(404).json({ error: "Purchase order not found." });
  if (po.status !== "For Approval") return response.status(409).json({ error: `This purchase order is already ${po.status.toLowerCase()}.` });
  const approve = request.body.approve === true;
  po.status = approve ? "Pending" : "Cancelled";
  po.confirmed_by = "Manager M. User"; po.confirmed_at = "2026-09-19 10:00:00";
  po.decision_note = approve ? null : String(request.body.note || "");
  if (!approve) {
    return response.json({ message: `Purchase order #${po.po_id} declined.`, status: po.status });
  }
  // approving sends nothing: the clerk prints the order and sends it
  response.json({
    message: `Purchase order #${po.po_id} is approved. The clerk prints it and sends it to the supplier.`,
    status: po.status
  });
});
// the clerk emails an approved order to its supplier
app.post("/api/purchase-orders/:id/send", (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (!po) return response.status(404).json({ error: "That purchase order does not exist" });
  if (po.status !== "Pending") return response.status(409).json({ error: "Only an approved order is sent." });
  if (!po.supplier_email) {
    return response.status(400).json({ error: `${po.supplier_name} has no email address on file. Print the order and send it to them.` });
  }
  po.supplier_sent_at = "2026-09-19 11:00:00";
  const number = "PO-" + String(po.po_id).padStart(6, "0");
  response.json({
    message: `${number} was emailed to ${po.supplier_name} at ${po.supplier_email}, with the PDF and the link to accept or decline it.`,
    linked: true
  });
});
app.post("/api/purchase-orders/:id/receive", (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (po) {
    po.status = "Received";
    const sheet = Array.isArray(request.body.received) ? request.body.received : [];
    if (po.items) po.items.forEach((it) => {
      const line = sheet.find((s) => Number(s.productId) === it.product_id);
      if (line) { it.quantity = Number(line.quantity); it.unit_cost = Number(line.unitCost || 0); it.line_cost = it.quantity * it.unit_cost; }
    });
    po.goods_cost = (po.items || []).reduce((sum, it) => sum + it.line_cost, 0);
    po.discount = Number(request.body.discount || 0);
    po.total_cost = po.goods_cost - po.discount;
  }
  response.json({ message: `Purchase order #${request.params.id} received.`, lines: 1, extras: 0 });
});

app.get("/api/deliveries/drivers", (request, response) =>
  response.json([{ staff_id: 5, full_name: "Delivery D. User" }]));
app.get("/api/delivery/list", (request, response) => response.json(DELIVERIES));
app.post("/api/delivery/:id/claim", (request, response) => {
  const delivery = DELIVERIES.find((d) => d.delivery_id === Number(request.params.id));
  if (!delivery) return response.status(404).json({ error: "Delivery not found" });
  if (delivery.delivery_staff_id != null && delivery.delivery_staff_id !== 5) {
    return response.status(409).json({ error: "Another driver has already taken this delivery." });
  }
  delivery.delivery_staff_id = 5;          // the stub's one driver
  delivery.driver_name = "Delivery D. User";
  response.json({ message: `Delivery #${delivery.delivery_id} is now yours.` });
});
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
// THE LIVE CHANNEL -- a hello, then a change frame per write
// ==========================================================================
let stubVersion = 0;
const stubClients = new Set();

function stubScopeOf(pathname) {
  if (/^\/api\/(users|roles|staff)/.test(pathname)) return "staff";
  if (/^\/api\/(inventory|purchase-orders|stocks)/.test(pathname)) return "inventory";
  if (/^\/api\/returns/.test(pathname)) return "returns";
  if (/^\/api\/deliveries|^\/api\/delivery/.test(pathname)) return "deliveries";
  if (/^\/api\/(credit|customers)/.test(pathname)) return "credit";
  if (/^\/api\/sales/.test(pathname)) return "sales";
  if (/^\/api\/(backups|restore)/.test(pathname)) return "system";
  if (/^\/api\/archives/.test(pathname)) return "archives";
  if (/^\/api\/features/.test(pathname)) return "features";
  return null;
}

function stubPublish(scope, detail, origin) {
  if (!scope) return;
  stubVersion += 1;
  const change = { version: stubVersion, scope, detail: detail || null,
                   origin: origin || null, at: new Date().toISOString() };
  stubChanges.push(change);
  if (stubChanges.length > 200) stubChanges.shift();
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

// the same as the real server's: every screen asks what changed since its version
const stubChanges = [];
let stubLastPoll = 0;
app.get("/api/events/poll", (request, response) => {
  stubLastPoll = Date.now();
  const since = parseInt(request.query.since, 10);
  const changes = Number.isInteger(since) ? stubChanges.filter((change) => change.version > since) : [];
  response.json({ version: stubVersion, changes: changes, gap: false, pollMs: 1000 });
});

// a way for the test to announce a change as though another desktop made it
app.post("/api/test/change", (request, response) => {
  stubPublish(request.body.scope, request.body.detail || "test", request.body.origin || null);
  response.json({ ok: true, version: stubVersion });
});

app.get("/api/events/status", (request, response) =>
  response.json({ version: stubVersion, connections: Date.now() - stubLastPoll < 5000 ? 1 : 0,
                  people: Date.now() - stubLastPoll < 5000 ? 1 : 0, logged: stubVersion }));

// ==========================================================================
// QR PAYMENTS -- the same routes as Connections/qr-payments.js, kept in memory.
// The provider is the real offline simulation (qr-provider-sim.js, with its
// pay page at /pay-sim/:token), and the rule for recording money against a
// code and the counts are the server's own (qrRefusal, summarize), so the
// stub cannot drift from them. Nothing here reaches PayMongo.
// ==========================================================================
const qrSim = require(path.join(PUBLIC_DIR, "Back-end", "Connections", "qr-provider-sim"));
const { qrRefusal, summarize, UNSAVED_NOTE: QR_UNSAVED_NOTE } =
  require(path.join(PUBLIC_DIR, "Back-end", "Connections", "qr-payments"));
qrSim.registerRoutes(app);

const QR_ROWS = new Map();
let QR_NEXT = 1;
const QR_SECONDS = 600;
const stubNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// the manager's page asks as the manager; every other page as the cashier
const askedByManager = (request) => /manager\.html/.test(request.get("referer") || "");

function qrStubShape(row) {
  return {
    id: row.id, status: row.status, amount: row.amount, wallet: row.wallet, purpose: row.purpose,
    reference: row.reference, saleId: row.saleId, errorMessage: row.errorMessage, mode: "test", provider: "sim",
    staffId: row.staffId, cashierName: row.cashierName, createdAt: row.createdAt, paidAt: row.paidAt,
    closedAt: row.closedAt,
    secondsLeft: row.status === "pending" ? Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000)) : 0,
    badge: "SIMULATION"
  };
}

// the same rule as sp_set_qr_payment_result: a pending row closes once, and a
// closed one can still become paid
function qrStubSet(row, status, reference, message) {
  if (row.status !== "pending" && row.status !== status && status !== "paid") return;
  row.status = status;
  if (reference) row.reference = reference;
  row.errorMessage = message || null;
  if (status === "paid" && !row.paidAt) row.paidAt = stubNow();
  if (!row.closedAt) row.closedAt = stubNow();
  stubPublish("qr-payments", `qr-payment ${row.id} ${status}`, null);
}

async function qrStubRefresh(row) {
  if (!row || row.status !== "pending") return row;
  const state = await qrSim.getStatus(row.intentId);
  if (state.status !== "pending") {
    qrStubSet(row, state.status, state.providerPaymentId, state.errorMessage);
  } else if (Date.now() >= row.expiresAt) {
    await qrSim.cancel(row.intentId);
    qrStubSet(row, "expired", null, "Not paid within 10 minutes.");
  }
  return row;
}

async function qrStubCheck(id, amountNow, wallet) {
  const row = await qrStubRefresh(QR_ROWS.get(Number(id)));
  return qrRefusal(row ? { status: row.status, amount: row.amount, wallet: row.wallet, sale_id: row.saleId } : null,
    amountNow, wallet);
}

// what GET /api/sales/:id lists under qrPayments, as the server does
function qrStubOfSale(saleId) {
  return Array.from(QR_ROWS.values()).filter((row) => row.saleId === saleId).map((row) => ({
    qr_payment_id: row.id, status: row.status, amount: row.amount, wallet: row.wallet, purpose: row.purpose,
    provider: "sim", mode: "test", provider_payment_id: row.reference, paid_at: row.paidAt
  }));
}

function qrStubLink(row, saleId) {
  row.saleId = saleId;
  row.errorMessage = null;
  stubPublish("qr-payments", `qr-payment ${row.id} linked`, null);
}

app.post("/api/qr-payments", async (request, response) => {
  const body = request.body || {};
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return response.status(400).json({ error: "Type the amount the QR code is for." });
  }
  if (!["GCash", "PayMaya"].includes(body.wallet)) {
    return response.status(400).json({ error: "Only GCash and Maya can be paid by QR code." });
  }
  const made = await qrSim.createPayment({ amount, wallet: body.wallet, description: "Stub Hardware",
    returnUrl: `http://localhost:${PORT}/pay/done` });
  const manager = askedByManager(request);
  const row = {
    id: QR_NEXT++, intentId: made.providerIntentId, status: "pending", amount, wallet: body.wallet,
    purpose: body.purpose || "sale", reference: null, saleId: null, errorMessage: null,
    staffId: manager ? 2 : 4, cashierName: manager ? "Manager M. User" : "Cashier C. User",
    createdAt: stubNow(), paidAt: null, closedAt: null, expiresAt: Date.now() + QR_SECONDS * 1000
  };
  QR_ROWS.set(row.id, row);
  stubPublish("qr-payments", `qr-payment ${row.id} pending`, null);
  response.status(201).json(Object.assign(qrStubShape(row), {
    qrImage: await QRCode.toDataURL(made.payUrl, { margin: 1, width: 260 }), payUrl: made.payUrl
  }));
});

app.get("/api/qr-payments/:id", async (request, response) => {
  const row = await qrStubRefresh(QR_ROWS.get(Number(request.params.id)));
  if (!row) return response.status(404).json({ error: "That QR payment is not on record." });
  response.json(qrStubShape(row));
});

app.post("/api/qr-payments/:id/cancel", async (request, response) => {
  const row = await qrStubRefresh(QR_ROWS.get(Number(request.params.id)));
  if (!row) return response.status(404).json({ error: "That QR payment is not on record." });
  if (row.status === "pending") {
    await qrSim.cancel(row.intentId);
    qrStubSet(row, "cancelled", null, "Cancelled by the cashier.");
  }
  response.json(qrStubShape(row));
});

app.get("/api/qr-payments", async (request, response) => {
  for (const row of QR_ROWS.values()) await qrStubRefresh(row);
  let rows = Array.from(QR_ROWS.values()).reverse();
  if (!askedByManager(request)) rows = rows.filter((row) => row.staffId === 4);
  else if (request.query.staff) rows = rows.filter((row) => row.staffId === Number(request.query.staff));
  const summary = summarize(rows);
  const status = String(request.query.status || "all");
  const listed = status === "all" ? rows : rows.filter((row) => row.status === status);
  response.json({ rows: listed.map(qrStubShape), summary, badge: "SIMULATION" });
});

// for the tests: run a code's clock out without waiting ten minutes
app.post("/api/test/qr-payments/:id/expire", (request, response) => {
  const row = QR_ROWS.get(Number(request.params.id));
  if (!row) return response.status(404).json({ error: "not found" });
  row.expiresAt = Date.now();
  response.json({ ok: true });
});

app.get("/pay/done", (request, response) => response.send("<h2>You can return to the cashier</h2>"));
