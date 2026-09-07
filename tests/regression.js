// The bugs that were found and fixed, each one held down by a check.
//
// smoke.js asks whether every route answers. This file asks whether the
// answers are right, which is a different question and the one the following
// six defects all got past:
//
//   A  the guard on the server's own source and the SQL folder was testing the
//      raw text of the address bar while the file server was testing the
//      decoded, collapsed path, so "//javascript/server.js" handed the
//      database password to anybody who asked, signed in or not
//   B  a sale validated stock line by line and deducted line by line, so one
//      material on two lines sold twice the shelf and left the count negative
//   C  the end-of-shift Collected figure summed what customers handed over
//      rather than what stayed in the drawer, so a broken note read as takings
//   D  a staff id in the address bar decided whose shift or whose round came
//      back, so one cashier could read another's takings by editing a number
//   E  report ranges were resolved against the UTC calendar while every SQL
//      comparison used the machine's own, so "Today" meant yesterday until
//      eight in the morning Philippine time
//   F  the two routes acting on your own account, and the one that changes the
//      shop's tax registration, wrote audit entries with no role and no address
//
// Expects a freshly loaded database (the two files in public/database/, in
// order) and the server already listening on BASE.
const BASE = process.env.BASE || "http://localhost:3000";

let passed = 0;
const failures = [];

function record(label, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label} -> ${detail}`);
  }
}

async function login(email, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json();
  const sid = /sid=([^;]+)/.exec(response.headers.get("set-cookie") || "");
  return { status: response.status, body, cookie: sid ? `sid=${sid[1]}` : null };
}

async function call(cookie, method, path, payload) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  let body = null;
  const text = await response.text();
  try { body = JSON.parse(text); } catch (error) { body = text.slice(0, 200); }
  return { status: response.status, body };
}

// Every demo account except the administrator has to pick a real password on
// its first sign-in, so signing in is two steps rather than one.
async function signIn(email, demoPassword, chosenPassword) {
  let session = await login(email, demoPassword);

  if (session.body.user && session.body.user.must_change_password) {
    await call(session.cookie, "POST", "/api/change-password", { newPassword: chosenPassword });
    session = await login(email, chosenPassword);
  }
  return session;
}

(async function main() {
  // ==========================================
  // A. THE FILES THAT ARE NOT FOR DOWNLOADING
  //
  // server.js carries the database password and public/database/ carries the
  // whole schema. Both sit under the folder the pages are served from, so the
  // only thing keeping them private is the guard, and a guard is only worth
  // what its worst spelling is worth.
  // ==========================================
  console.log("== THE FILES THAT ARE NOT FOR DOWNLOADING ==");

  const spellings = [
    "/javascript/server.js",
    "//javascript/server.js",
    "///javascript/server.js",
    "/javascript//server.js",
    "/javascript/%73erver.js",
    "/javascript%2fserver.js",
    "/javascript/../javascript/server.js",
    "/database/1-RUN-FIRST-database.sql",
    "//database/1-RUN-FIRST-database.sql",
    "/%64atabase/1-RUN-FIRST-database.sql",
    "/database//2-RUN-SECOND-stored-procedures.sql"
  ];

  for (const spelling of spellings) {
    const response = await fetch(BASE + spelling);
    const text = await response.text();
    const leaked = text.includes("DB_PASSWORD") || text.includes("CREATE TABLE") ||
                   text.includes("CREATE PROCEDURE");
    record(`refused ${spelling}`, response.status === 404 && !leaked,
      leaked ? `${response.status}, and it handed over the file` : `got ${response.status}`);
  }

  for (const wanted of ["/Login.html", "/javascript/app.js", "/css/style.css",
                        "/javascript/modules/shared/session.js", "/favicon.ico"]) {
    const response = await fetch(BASE + wanted);
    record(`still served ${wanted}`, response.status === 200, `got ${response.status}`);
  }

  // ==========================================
  // THE SESSIONS THE REST OF THE FILE WORKS THROUGH
  // ==========================================
  const admin    = await signIn("admin@hardware.com",    "admin123",    "adminpass123");
  const manager  = await signIn("manager@hardware.com",  "manager123",  "managerpass123");
  const cashier  = await signIn("cashier@hardware.com",  "cashier123",  "cashierpass123");
  const driver   = await signIn("delivery@hardware.com", "delivery123", "driverpass123");

  // The second cashier in the demo data, and a second driver of our own: the
  // demo's other driver is deactivated on purpose and cannot sign in.
  await call(admin.cookie, "POST", "/api/users/6/reset-password", { newPassword: "anapass1234" });
  const otherCashier = await signIn("ana.reyes@hardware.com", "anapass1234", "anapass5678");

  await call(admin.cookie, "POST", "/api/users", {
    firstName: "Probe", lastName: "Driver", roleId: 5,
    email: "probe.driver@hardware.com", password: "probedriver1"
  });
  const otherDriver = await signIn("probe.driver@hardware.com", "probedriver1", "probedriver2");

  record("every account used by this file signed in",
    [admin, manager, cashier, driver, otherCashier, otherDriver].every((s) => s.cookie),
    "one of the sign-ins did not produce a session");

  // ==========================================
  // B. ONE MATERIAL, TWO LINES, ONE SHELF
  //
  // The shelf a line is weighed against is the same shelf every other line
  // naming that material is weighed against, so the question is what the whole
  // receipt asks for and not what one line asks for.
  // ==========================================
  console.log("== ONE MATERIAL, TWO LINES, ONE SHELF ==");

  const products = (await call(cashier.cookie, "GET", "/api/inventory/products")).body;
  const material = products.find((row) => Number(row.quantity_in_stock) > 10);
  const onShelf = Number(material.quantity_in_stock);

  const doubled = await call(cashier.cookie, "POST", "/api/sales", {
    walkInName: "Regression Probe", discount: 0, amountPaid: 99999999, paymentMethod: "Cash",
    items: [{ product_id: material.product_id, quantity: onShelf },
            { product_id: material.product_id, quantity: onShelf }]
  });
  record("two lines asking for the whole shelf are refused", doubled.status === 400,
    `${doubled.status} ${JSON.stringify(doubled.body).slice(0, 140)}`);

  const untouched = (await call(cashier.cookie, "GET", "/api/inventory/products"))
    .body.find((row) => row.product_id === material.product_id);
  record("the refused sale left the count where it was",
    Number(untouched.quantity_in_stock) === onShelf,
    `${untouched.quantity_in_stock}, was ${onShelf}`);

  const split = await call(cashier.cookie, "POST", "/api/sales", {
    walkInName: "Regression Probe", discount: 0, amountPaid: 99999999, paymentMethod: "Cash",
    items: [{ product_id: material.product_id, quantity: 2 },
            { product_id: material.product_id, quantity: 3 }]
  });
  const afterSplit = (await call(cashier.cookie, "GET", "/api/inventory/products"))
    .body.find((row) => row.product_id === material.product_id);
  record("a basket that does fit still sells, and deducts each line once",
    split.status === 200 && Number(afterSplit.quantity_in_stock) === onShelf - 5,
    `${split.status}, count ${afterSplit.quantity_in_stock}, expected ${onShelf - 5}`);

  // ==========================================
  // C. WHAT STAYED IN THE DRAWER
  //
  // A hundred thousand handed over against a bill of a hundred and twenty is a
  // hundred and twenty collected. The card a drawer is balanced against has to
  // agree with the manager's tally for the same cashier on the same day.
  // ==========================================
  console.log("== WHAT STAYED IN THE DRAWER ==");

  await call(cashier.cookie, "POST", "/api/sales", {
    walkInName: "Regression Probe", discount: 0, amountPaid: 100000, paymentMethod: "Cash",
    items: [{ product_id: material.product_id, quantity: 1 }]
  });

  const shift = (await call(cashier.cookie, "GET", "/api/cashier/summary")).body;
  const tally = (await call(manager.cookie, "GET", "/api/reports/daily-tally")).body;

  record("collected leaves out the change handed back",
    Number(shift.collected) < 100000, `collected ${shift.collected}`);
  record("the cashier's card and the manager's tally agree",
    Number(shift.collected).toFixed(2) === Number(tally.totals.collected).toFixed(2),
    `cashier ${shift.collected}, tally ${tally.totals.collected}`);

  // ==========================================
  // D. YOUR OWN FIGURES ARE YOUR OWN
  //
  // The staff id in the address bar is ignored on all three of these routes.
  // The session decides, the same way it decides which alerts the bell shows.
  // ==========================================
  console.log("== YOUR OWN FIGURES ARE YOUR OWN ==");

  const cashierStaffId = cashier.body.user.staff_id;

  const peeking = await call(otherCashier.cookie, "GET",
    `/api/cashier/summary?staffId=${cashierStaffId}`);
  record("a cashier naming another cashier's id still gets their own shift",
    peeking.status === 200 && Number(peeking.body.saleCount) === 0,
    `${peeking.status}, saleCount ${peeking.body.saleCount}`);

  const own = await call(cashier.cookie, "GET", `/api/cashier/summary?staffId=${cashierStaffId}`);
  record("a cashier still sees their own shift",
    own.status === 200 && Number(own.body.saleCount) > 0,
    `${own.status}, saleCount ${own.body.saleCount}`);

  const driverStaffId = driver.body.user.staff_id;
  const driverRound = await call(driver.cookie, "GET", `/api/delivery/list?staffId=${driverStaffId}`);
  const peekedRound = await call(otherDriver.cookie, "GET", `/api/delivery/list?staffId=${driverStaffId}`);
  record("a driver naming another driver's id still gets their own round",
    peekedRound.status === 200 && driverRound.status === 200 &&
    peekedRound.body.length !== driverRound.body.length,
    `peeked ${peekedRound.body.length} rows, own round ${driverRound.body.length} rows`);

  const peekedSummary = await call(otherDriver.cookie, "GET",
    `/api/delivery/summary?staffId=${driverStaffId}`);
  record("the driver's report answers for whoever is signed in",
    peekedSummary.status === 200, `got ${peekedSummary.status}`);

  // ==========================================
  // E. TODAY MEANS TODAY
  //
  // The report ranges are worked out in JavaScript; every figure they bound is
  // worked out in SQL. Both have to mean the same calendar day, or the manager
  // and the cashier are looking at different days on the same morning.
  // ==========================================
  console.log("== TODAY MEANS TODAY ==");

  const databaseToday = String(shift.date).slice(0, 10);
  const today = (await call(manager.cookie, "GET", "/api/reports/income?range=daily")).body;
  record("the manager's Today is the database's today",
    today.range.from === databaseToday && today.range.to === databaseToday,
    `report ${today.range.from}..${today.range.to}, database ${databaseToday}`);

  const week = (await call(manager.cookie, "GET", "/api/reports/income?range=weekly")).body;
  record("a seven day range ends on the database's today",
    week.range.to === databaseToday, `report ends ${week.range.to}, database ${databaseToday}`);

  // ==========================================
  // F. AN ENTRY THAT CAN ANSWER FOR ITSELF
  //
  // An audit entry with no role and no address records that something happened
  // without recording who was in a position to do it or where from, which is
  // most of what an audit is opened for.
  // ==========================================
  console.log("== AN ENTRY THAT CAN ANSWER FOR ITSELF ==");

  await call(admin.cookie, "PUT", "/api/store-settings", {
    storeName: "Regression Hardware", address: "1 Probe Street",
    tin: "111-222-333-00000", registrationType: "VAT", vatRate: 12, invoiceNote: "probe"
  });
  await call(manager.cookie, "PUT", "/api/me", {
    firstName: "Manager", middleInitial: "M", lastName: "User", phone: "09171234567"
  });
  await call(manager.cookie, "POST", "/api/me/password", {
    currentPassword: "managerpass123", newPassword: "managerpass456"
  });

  const trail = (await call(admin.cookie, "GET", "/api/audit-logs?limit=400")).body;
  const complete = (action) => {
    const entry = trail.find((row) => row.action === action);
    return entry && entry.role_name && entry.role_name !== "System" && entry.ip_address;
  };

  record("changing the shop's tax registration is written down",
    !!trail.find((row) => row.action === "UPDATE_STORE_SETTINGS"), "no entry for it");
  record("that entry names the role and the machine", complete("UPDATE_STORE_SETTINGS"),
    JSON.stringify(trail.find((row) => row.action === "UPDATE_STORE_SETTINGS") || {}).slice(0, 140));
  record("editing your own details names the role and the machine",
    complete("UPDATE_OWN_PROFILE"),
    JSON.stringify(trail.find((row) => row.action === "UPDATE_OWN_PROFILE") || {}).slice(0, 140));
  record("changing your own password names the role and the machine",
    complete("CHANGE_OWN_PASSWORD"),
    JSON.stringify(trail.find((row) => row.action === "CHANGE_OWN_PASSWORD") || {}).slice(0, 140));

  // ==========================================
  console.log("");
  if (failures.length === 0) {
    console.log(`${passed}/${passed} checks passed.`);
  } else {
    console.log(`${passed}/${passed + failures.length} checks passed, ${failures.length} failed:`);
    failures.forEach((failure) => console.log(`  ${failure.label} -> ${failure.detail}`));
    process.exitCode = 1;
  }
})();
