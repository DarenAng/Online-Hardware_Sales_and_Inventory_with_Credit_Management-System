// A stand-in for server.js with no database behind it: serves the real
// public/ folder and answers the routes with invented rows, so the screens
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

app.use(express.static(PUBLIC_DIR));

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

// ==========================================================================
// THE CONNECTED SYSTEMS -- the stub always answers as the administrator
// ==========================================================================
const SYSTEMS = [
  { key: "database", name: "MySQL Database", kind: "Internal", enabled: true,
    description: "The hardware_db schema every screen reads and every procedure writes.",
    status: { state: "ok", summary: "Answering in 2 ms with all 30 stored procedures loaded.",
      facts: { "Server": "MySQL 8.0.36 on localhost", "Tables": "26", "Stored procedures": "30 of 30", "Round trip": "2 ms" } },
    actions: [{ key: "recount-procedures", label: "Re-count the stored procedures", hint: "", danger: false }] },
  { key: "backup", name: "Automatic Backup", kind: "Internal", enabled: true,
    description: "The rolling backup the server takes on its own and the folder it writes to.",
    status: { state: "ok", summary: "Running every 60 seconds; the last 60 are kept.",
      facts: { "Last automatic backup": "hardware_db_auto_2026-09-13_1030.sql (512 KB)", "Automatic files in the folder": "60 of 60", "Paused": "No" } },
    actions: [{ key: "run-now", label: "Run a backup now", hint: "", danger: false },
              { key: "pause", label: "Pause the automatic backup", hint: "", danger: true },
              { key: "resume", label: "Resume the automatic backup", hint: "", danger: false }] },
  { key: "archive-sweep", name: "Archive Sweep", kind: "Internal", enabled: false,
    description: "The nightly pass that puts away closed deliveries and dead stock.",
    status: { state: "ok", summary: "Runs at startup and once a day. 3 closed deliveries look due on the next pass.",
      facts: { "Interval": "every 24 hours", "Deliveries past 90 days": "3" } },
    actions: [{ key: "run-now", label: "Run the sweep now", hint: "", danger: false }] },
  { key: "live-sync", name: "Live Sync Channel", kind: "Internal", enabled: true,
    description: "The open connection every signed-in browser holds.",
    status: { state: "ok", summary: "4 open connections from 3 people; 412 changes announced since this server started.",
      facts: { "Open connections": "4", "People connected": "3", "Changes announced": "412" } },
    actions: [{ key: "resync-all", label: "Tell every screen to reload", hint: "", danger: true }] },
  { key: "mail", name: "Mail Relay", kind: "Internal", enabled: true,
    description: "The SMTP account first passwords are sent from.",
    status: { state: "off", summary: "Not set up on this server, so new and reset passwords are shown once on the administrator's screen instead.",
      facts: { "Configured": "No" } },
    actions: [{ key: "send-test", label: "Send a test message to my own address", hint: "", danger: false }] },
  { key: "courier", name: "Courier Tracking", kind: "External", enabled: true,
    description: "The courier's tracking API for deliveries beyond Nasugbu.", endpointUrl: "https://tracking.example.com/health",
    status: { state: "bad", summary: "Could not reach https://tracking.example.com/health: no answer within 5 seconds.",
      facts: { "Address": "https://tracking.example.com/health" } },
    actions: [{ key: "ping", label: "Ping it", hint: "", danger: false },
              { key: "send", label: "Send it a message", hint: "", danger: true, needsMessage: true }] }
];

const ALL_LEVELS = { monitor: true, manage: true, control: true };

// staff_id -> { system key -> grant }; two people hold something to begin with
const GRANTS = {
  2: { backup: { monitor: true, manage: false, control: true, note: "Takes a backup before the month-end count", grantedBy: "Admin S. User", grantedAt: "2026-05-02 09:15:00", updatedAt: "2026-05-02 09:15:00" } },
  7: { database: { monitor: true, manage: false, control: false, note: "", grantedBy: "Admin S. User", grantedAt: "2026-06-11 08:40:00", updatedAt: "2026-06-11 08:40:00" } }
};

function grantsOf(staffId) {
  return Object.entries(GRANTS[staffId] || {}).map(([key, grant]) => {
    const system = SYSTEMS.find((s) => s.key === key);
    return Object.assign({ key, name: system.name, kind: system.kind, enabled: system.enabled }, grant);
  });
}

app.get("/api/me/access", (request, response) => response.json({
  staffId: 1, roleName: "System Administrator", page: "/system.html", isAdmin: true,
  isManagement: true, canEditOwnDetails: false, canChangeOwnPassword: true, canEditOwnEmail: false,
  canReachSystems: true, systems: SYSTEMS.map((s) => Object.assign({ key: s.key, name: s.name }, ALL_LEVELS))
}));


// ==========================================================================
// SCREENS BY ROLE -- /api/me/* works the role out from the Referer
// ==========================================================================
const FEATURES = [
  ["pos", "New Transaction", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["refunds", "Refunds", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["sales-report", "Sales Report", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["daily-summary", "Daily Summary", "Point of Sale", ["Cashier"], ["Cashier"]],
  ["credit", "Customer Credit", "Credit", ["Manager", "Cashier"], ["Manager", "Cashier"]],
  ["credit-requests", "Extension Requests", "Credit", ["Manager"], ["Manager"]],
  ["income", "Income", "Reports", ["Manager"], ["Manager"]],
  ["reports", "Reports", "Reports", ["Manager"], ["Manager"]],
  ["sales", "Sales", "Reports", ["Manager"], ["Manager"]],
  ["material-list", "Material List", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["stock-adjustment", "Stock Adjustment", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["adjustment-history", "Adjustment History", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["reorder-points", "Reorder Points", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["reorder-alerts", "Reorder Alerts", "Inventory", ["Manager"], ["Manager"]],
  ["stock-reports", "Stock Reports", "Inventory", ["Manager"], ["Manager"]],
  ["returns", "Returned Items", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["damage-report", "Make a Report", "Inventory", ["Inventory Clerk"], ["Inventory Clerk"]],
  ["purchase-orders", "Purchase Orders", "Inventory", ["Manager", "Inventory Clerk"], ["Manager", "Inventory Clerk"]],
  ["deliveries", "Delivery Tracking", "Deliveries", ["Manager", "Cashier"], ["Manager", "Cashier"]],
  ["delivery-runs", "Delivery Runs", "Deliveries", ["Delivery Personnel"], ["Delivery Personnel"]],
  ["delivery-reports", "Delivery Reports", "Deliveries", ["Delivery Personnel"], ["Delivery Personnel"]],
  ["delivery-schedule", "Delivery Schedule", "Deliveries",
    ["Manager", "Cashier", "Inventory Clerk", "Delivery Personnel"], ["Manager"]],
  ["records", "Records", "Records", ["Manager"], ["Manager"]],
  ["archives", "Archives", "Records", ["Manager", "Inventory Clerk"], ["Manager", "Inventory Clerk"]]
].map(([key, name, module, available, defaults]) => ({
  key, name, module, description: `The ${name} screen.`, available, defaults
}));

const FEATURE_ROLES = ROLES.filter((role) => role.role_name !== "System Administrator");

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
  if (page.includes("manager-dashboard")) return "Manager";
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

// the counts the pages mirror onto their headings and into the top bar
const FEATURE_COUNTS = {
  "Manager": { "credit-requests": 2, "reorder-alerts": 3, "deliveries": 1, "delivery-schedule": 4 },
  "Inventory Clerk": { "reorder-points": 3, "returns": 2, "delivery-schedule": 4 },
  "Cashier": { "delivery-schedule": 4 },
  "Delivery Personnel": { "delivery-runs": 5, "delivery-schedule": 4 }
};

app.get("/api/me/counts", (request, response) => {
  const roleName = roleOfPage(request);
  const counts = {};
  for (const [key, count] of Object.entries(FEATURE_COUNTS[roleName] || {})) {
    const feature = FEATURES.find((f) => f.key === key);
    if (feature && featureCell(feature, roleName).held) counts[key] = count;
  }
  response.json(counts);
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
app.get("/api/systems", (request, response) =>
  response.json(SYSTEMS.map((s) => Object.assign({}, s, { access: ALL_LEVELS }))));

app.get("/api/systems/:key/status", (request, response) => {
  const system = SYSTEMS.find((s) => s.key === request.params.key);
  if (!system) return response.status(404).json({ error: "No connected system is registered under that name." });
  response.json(Object.assign({}, system, { access: ALL_LEVELS }));
});

app.post("/api/systems", (request, response) => {
  const body = request.body || {};
  if (SYSTEMS.some((s) => s.key === body.key)) {
    return response.status(409).json({ error: `A system is already registered as "${body.key}".` });
  }
  const system = { key: body.key, name: body.name, kind: "External", enabled: true, description: body.description || null,
    endpointUrl: body.endpointUrl, status: { state: "ok", summary: "Answering HTTP 200 in 41 ms.", facts: { "Address": body.endpointUrl } },
    actions: SYSTEMS[5].actions };
  SYSTEMS.push(system);
  response.json({ message: `${body.name} is registered.`, system: Object.assign({}, system, { access: ALL_LEVELS }) });
});

app.put("/api/systems/:key", (request, response) => {
  const system = SYSTEMS.find((s) => s.key === request.params.key);
  if (!system) return response.status(404).json({ error: "No connected system is registered under that name." });
  const body = request.body || {};
  if (body.name !== undefined) system.name = body.name;
  if (body.description !== undefined) system.description = body.description || null;
  if (body.enabled !== undefined) system.enabled = body.enabled === true;
  if (body.endpointUrl !== undefined && system.kind === "External") system.endpointUrl = body.endpointUrl;
  response.json({ message: `${system.name} was updated.`, system: Object.assign({}, system, { access: ALL_LEVELS }) });
});

app.post("/api/systems/:key/actions/:action", (request, response) => {
  const system = SYSTEMS.find((s) => s.key === request.params.key);
  if (!system) return response.status(404).json({ error: "No connected system is registered under that name." });
  if (!system.enabled) return response.status(409).json({ error: `${system.name} is switched off.` });
  const action = system.actions.find((a) => a.key === request.params.action);
  if (!action) return response.status(404).json({ error: `${system.name} has no command called "${request.params.action}".` });
  if (action.key === "pause") system.status.facts.Paused = "Yes";
  if (action.key === "resume") system.status.facts.Paused = "No";
  response.json({ system: system.key, action: action.key, ok: true, message: `"${action.label}" ran on ${system.name}.` });
});

app.get("/api/access/permissions", (request, response) =>
  response.json(USERS
    .filter((user) => user.user_id && user.role_name !== "System Administrator")
    .map((user) => Object.assign({}, user, { grants: grantsOf(user.staff_id) }))));

app.get("/api/access/users/:id", (request, response) => {
  const user = USERS.find((row) => row.staff_id === Number(request.params.id));
  if (!user) return response.status(404).json({ error: "Staff record not found" });
  response.json(Object.assign({}, user, { grants: grantsOf(user.staff_id) }));
});

app.put("/api/access/users/:id/systems/:key", (request, response) => {
  const staffId = Number(request.params.id);
  const user = USERS.find((row) => row.staff_id === staffId);
  const system = SYSTEMS.find((s) => s.key === request.params.key);
  if (!user) return response.status(404).json({ error: "Staff record not found" });
  if (!system) return response.status(404).json({ error: "No connected system is registered under that name." });
  if (staffId === 1) return response.status(403).json({ error: "You cannot change your own account from here." });

  const body = request.body || {};
  const monitor = body.monitor === true || body.manage === true || body.control === true;
  GRANTS[staffId] = GRANTS[staffId] || {};

  if (!monitor) {
    const had = Boolean(GRANTS[staffId][system.key]);
    delete GRANTS[staffId][system.key];
    return response.json({ message: `${user.full_name} no longer has any access to ${system.name}.`, changed: had, grant: null });
  }

  GRANTS[staffId][system.key] = {
    monitor: true, manage: body.manage === true, control: body.control === true,
    note: String(body.note || ""), grantedBy: "Admin S. User",
    grantedAt: "2026-09-13 10:00:00", updatedAt: "2026-09-13 10:00:00"
  };
  response.json({
    message: `${user.full_name} may now ${body.control ? "monitor and control" : "monitor"} ${system.name}.`,
    changed: true,
    grant: grantsOf(staffId).find((g) => g.key === system.key)
  });
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

const CREDIT = RECORDS.customer.map((c, index) => {
  const limit = 10000 + index * 5000;
  // every third account owes something, and one of them is over its limit
  const owed = index % 3 === 0 ? Math.round(limit * (index === 6 ? 1.2 : 0.45)) : 0;

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
    total_purchase: 20000 + index * 3100,
    current_credit: owed,
    available_credit: Math.max(limit - owed, 0),
    open_sales: owed > 0 ? 1 + (index % 3) : 0,
    oldest_debt_days: owed > 0 ? 5 + index * 9 : null,
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
  credit.manual_standing = request.body.standing || "Good";
  credit.credit_notes = request.body.notes || null;
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

// every till screen reads this to head an invoice
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

// refuses the same TIN shapes the real server refuses
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

// ==========================================================================
// PURCHASE ORDERS
// ==========================================================================
const PURCHASE_ORDERS = Array.from({ length: 17 }, (_, i) => ({
  po_id: 200 + i,
  supplier_id: (i % 2) + 1,
  supplier_name: i % 2 ? "Cebu Tool Co." : "Manila Hardware Supply",
  contact_person: i % 2 ? "Rina Ocampo" : "Ben Cruz",
  contact_number: "0917000" + String(2000 + i),
  order_date: `2026-08-${String(10 + (i % 19)).padStart(2, "0")} 08:00:00`,
  line_count: (i % 4) + 1,
  total_units: ((i % 4) + 1) * 12,
  total_cost: 12000 + i * 2300,
  status: ["Pending", "Received", "Cancelled"][i % 3]
}));

function purchaseOrderLines(poId) {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(poId));
  if (!po) return [];
  return Array.from({ length: po.line_count }, (_, i) => {
    const p = STOCKS[(poId + i) % STOCKS.length];
    return {
      product_id: p.product_id, product_name: p.product_name, unit_name: p.unit_name,
      category_name: p.category_name, brand_name: p.brand_name,
      quantity: 12, unit_cost: 250 + i * 10, line_cost: 12 * (250 + i * 10),
      quantity_in_stock: p.quantity_in_stock
    };
  });
}

app.get("/api/purchase-orders", (request, response) => response.json(PURCHASE_ORDERS));
app.get("/api/purchase-orders/:id/items", (request, response) =>
  response.json(purchaseOrderLines(request.params.id)));
app.get("/api/purchase-orders/:id/document", (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (!po) return response.status(404).json({ error: "That purchase order does not exist" });
  response.json({
    order: Object.assign({ supplier_email: "sales@supplier.test", supplier_address: "Cebu City",
                           raised_by: "Manager M. User" }, po),
    items: purchaseOrderLines(po.po_id),
    shop: STORE
  });
});
app.post("/api/purchase-orders", (request, response) => {
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
    total_cost: items.reduce((sum, it) => sum + Number(it.quantity || 0) * Number(it.unitCost || 0), 0),
    status: "Pending"
  };
  PURCHASE_ORDERS.unshift(po);
  response.json({ message: `Purchase order #${po.po_id} created.`, poId: po.po_id });
});
app.post("/api/purchase-orders/:id/receive", (request, response) => {
  const po = PURCHASE_ORDERS.find((p) => p.po_id === Number(request.params.id));
  if (po) po.status = "Received";
  response.json({ message: `Purchase order #${request.params.id} received.`, lines: 1, extras: 0 });
});

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
// THE LIVE CHANNEL -- a hello, then a change frame per write
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
  if (/^\/api\/access/.test(pathname)) return "access";
  if (/^\/api\/features/.test(pathname)) return "features";
  if (/^\/api\/systems/.test(pathname)) return "systems";
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
