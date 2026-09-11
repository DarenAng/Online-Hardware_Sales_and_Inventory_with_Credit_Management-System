// Exercises every API route as every role and reports what breaks.
// Run with the server already listening on BASE.
const BASE = process.env.BASE || "http://localhost:3000";

const ACCOUNTS = {
  admin:    ["admin@hardware.com", "admin123"],
  manager:  ["manager@hardware.com", "manager123"],
  clerk:    ["clerk@hardware.com", "clerk123"],
  cashier:  ["cashier@hardware.com", "cashier123"],
  delivery: ["delivery@hardware.com", "delivery123"]
};

const results = [];
function record(role, label, ok, detail) {
  results.push({ role, label, ok, detail });
  if (!ok) console.log(`  FAIL [${role}] ${label} -> ${detail}`);
}

async function login(email, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json();
  const setCookie = response.headers.get("set-cookie") || "";
  const sid = /sid=([^;]+)/.exec(setCookie);
  return { ok: response.ok, status: response.status, body, cookie: sid ? `sid=${sid[1]}` : null };
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

// ==========================================================================
// CREATING AN ACCOUNT IS TWO REQUESTS
//
// The review step works the account out -- including a password nobody typed
// -- and creates nothing. The second one creates it from the draft id, so
// what an administrator confirmed on screen is what ends up in the database.
//
// This helper runs both and hands back the reply of whichever step ended it,
// so a caller that only wants an account gets one, and a caller checking a
// refusal still sees the status the refusal came back with. `review` is
// attached so a test can look at what the card would have said.
// ==========================================================================
async function createAccount(cookie, details) {
  const review = await call(cookie, "POST", "/api/users/draft", details);
  if (review.status !== 200) return review;

  const created = await call(cookie, "POST", "/api/users",
    { draftId: review.body.draftId });
  created.review = review.body;
  return created;
}

// The credit checks run in the manager block but need a cashier's cookie, and
// the cashier session is opened further down the file. Reaching it through the
// sessions object rather than a second login keeps this to one sign-in each.
function cashierCookieForCredit(sessions) {
  return sessions.cashier ? sessions.cashier.cookie : null;
}

function expect(role, label, response, allowed) {
  const ok = allowed.includes(response.status);
  record(role, `${label} (${response.status})`, ok,
    ok ? "" : JSON.stringify(response.body).slice(0, 160));
  return response;
}

(async function main() {
  const sessions = {};

  console.log("== LOGIN ==");
  for (const [role, [email, password]] of Object.entries(ACCOUNTS)) {
    const out = await login(email, password);
    record(role, "login", out.ok && out.cookie, out.ok ? "" : JSON.stringify(out.body));
    sessions[role] = { cookie: out.cookie, user: out.body.user };
  }

  const bad = await login("admin@hardware.com", "wrong-password");
  record("admin", "bad password refused", bad.status === 401, `got ${bad.status}`);

  console.log("== ADMIN ==");
  const admin = sessions.admin.cookie;
  expect("admin", "GET roles",       await call(admin, "GET", "/api/roles"), [200]);
  expect("admin", "GET users",       await call(admin, "GET", "/api/users"), [200]);
  expect("admin", "GET users/1",     await call(admin, "GET", "/api/users/1"), [200]);
  expect("admin", "GET audit-logs",  await call(admin, "GET", "/api/audit-logs"), [200]);
  expect("admin", "GET archives",    await call(admin, "GET", "/api/archives"), [200]);

  console.log("== PRESENCE, FILTERS & THE WIDER AUDIT TRAIL ==");
  expect("admin", "POST heartbeat",       await call(admin, "POST", "/api/heartbeat"), [200]);
  expect("admin", "GET audit-logs/types", await call(admin, "GET", "/api/audit-logs/types"), [200]);

  // the directory says who is signed in, and the administrator doing the
  // asking is signed in by definition, so at least one row has to say so
  const directoryNow = await call(admin, "GET", "/api/users");
  record("admin", "directory reports presence",
    Array.isArray(directoryNow.body) &&
    directoryNow.body.some((row) => row.is_online === true),
    "no row came back marked online");

  const activeOnly = await call(admin, "GET", "/api/users?status=active");
  record("admin", "status=active filters",
    Array.isArray(activeOnly.body) && activeOnly.body.length > 0 &&
    activeOnly.body.every((row) => Boolean(row.is_active)),
    "an inactive account came back from the active filter");

  const inactiveOnly = await call(admin, "GET", "/api/users?status=inactive");
  record("admin", "status=inactive filters",
    Array.isArray(inactiveOnly.body) &&
    inactiveOnly.body.every((row) => !row.is_active),
    "an active account came back from the inactive filter");

  record("admin", "archived staff carry a date and an archiver",
    Array.isArray(inactiveOnly.body) && inactiveOnly.body.length > 0 &&
    inactiveOnly.body.some((row) => row.archived_at && row.archived_by),
    "no archived row carried both archived_at and archived_by");

  // the wrong-password attempt at the top of this run has to be in the trail,
  // with the address it came from
  const failures = await call(admin, "GET", "/api/audit-logs?actionType=LOGIN_FAILURE");
  record("admin", "failed sign-ins are recorded",
    Array.isArray(failures.body) && failures.body.length > 0,
    "the wrong-password attempt left no audit entry");
  record("admin", "audit entries carry an address and a role",
    Array.isArray(failures.body) && failures.body.length > 0 &&
    Boolean(failures.body[0].ip_address) && Boolean(failures.body[0].role_name),
    "an audit entry came back with no ip_address or role_name");

  const signIns = await call(admin, "GET", "/api/audit-logs?actionType=LOGIN");
  record("admin", "actionType narrows the trail",
    Array.isArray(signIns.body) && signIns.body.length > 0 &&
    signIns.body.every((row) => row.action_type === "LOGIN"),
    "the LOGIN filter returned another type");

  console.log("== BACKUP & RECOVERY ==");
  const made = expect("admin", "POST backups", await call(admin, "POST", "/api/backups"), [200]);
  const backupName = made.body && made.body.fileName;
  record("admin", "backup names itself by date",
    /^hardware_db_backup_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/.test(backupName || ""),
    String(backupName));
  record("admin", "backup covers every table",
    made.body && made.body.tableCount >= 21 && made.body.rowCount > 0,
    JSON.stringify(made.body).slice(0, 160));

  const listed = expect("admin", "GET backups", await call(admin, "GET", "/api/backups"), [200]);
  record("admin", "new backup is in the history",
    listed.body && listed.body.files.some((f) => f.fileName === backupName), "");

  // THE ONE THAT NOBODY PRESSES
  //
  // The whole system is written to its own file every minute and the oldest is
  // removed as the newest is written, so the folder settles at a fixed size
  // instead of filling the disk. A backup somebody took on purpose is never
  // rotated, and the list has to be able to say which kind each file is or
  // the drawer cannot warn that one of them is on its way out.
  record("admin", "the backup list says whether the system backs itself up",
    listed.body && listed.body.auto && typeof listed.body.auto.enabled === "boolean" &&
    listed.body.auto.everySeconds > 0 && listed.body.auto.keep > 0,
    JSON.stringify(listed.body && listed.body.auto));
  record("admin", "every backup says which kind it is",
    listed.body && listed.body.files.every((f) => typeof f.automatic === "boolean"), "");
  record("admin", "the backup taken by hand is not marked automatic",
    listed.body &&
    listed.body.files.some((f) => f.fileName === backupName && f.automatic === false), "");
  record("admin", "the automatic backup is not failing",
    listed.body && listed.body.auto && !listed.body.auto.lastError,
    String(listed.body && listed.body.auto && listed.body.auto.lastError));

  expect("admin", "download backup", await call(admin, "GET", `/api/backups/${backupName}`), [200]);
  expect("admin", "path traversal refused",
    await call(admin, "GET", "/api/backups/..%2F..%2Fpackage.json"), [400, 403, 404]);

  // change something, restore, and check the change is gone again
  await createAccount(admin, {
    firstName: "Wiped", lastName: "Away", roleId: 4,
    email: `wiped.${Date.now()}@hardware.com`
  });
  expect("admin", "restore from history",
    await call(admin, "POST", `/api/backups/${backupName}/restore`), [200]);
  const afterRestore = await call(admin, "GET", "/api/users");
  record("admin", "restore rolled the change back",
    Array.isArray(afterRestore.body) && !afterRestore.body.some((u) => u.first_name === "Wiped"),
    `${Array.isArray(afterRestore.body) ? afterRestore.body.length : "?"} staff after restore`);
  record("admin", "restore kept the stored procedures",
    (await call(admin, "GET", "/api/users")).status === 200, "");

  // THE MIDDLE NAME, AND THE INITIAL TAKEN OFF IT
  //
  // The column holds the whole middle name now; the rule that shortens it to
  // one letter lives in staff.full_name and nowhere else. Both halves are
  // checked here, because the whole point of the change is that they are
  // different things: "dela Cruz" goes in and "Juan D. Cruz" comes out.
  console.log("== MIDDLE NAME ==");
  const twinEmail = `twin.${Date.now()}@hardware.com`;
  const twin = await createAccount(admin, {
    firstName: "Juan", middleName: "  dela  Cruz ", lastName: "Cruz", phone: "09170001111",
    roleId: 3, email: twinEmail
  });
  expect("admin", "create with middle name", twin, [200]);
  const directory = await call(admin, "GET", "/api/users");
  const twinRow = Array.isArray(directory.body)
    ? directory.body.find((u) => u.staff_id === (twin.body && twin.body.staffId)) : null;
  record("admin", "the whole middle name is kept, trimmed and single-spaced",
    twinRow && twinRow.middle_name === "dela Cruz", JSON.stringify(twinRow || {}).slice(0, 140));
  record("admin", "a phone number typed as 09... is stored as +63...",
    twinRow && twinRow.phone === "+639170001111", String(twinRow && twinRow.phone));
  record("admin", "full name carries only the initial, in capitals",
    twinRow && twinRow.full_name === "Juan D. Cruz", twinRow ? twinRow.full_name : "missing");

  // no middle name is a name of two parts, not a name with a stray full stop
  const noMiddle = await createAccount(admin, {
    firstName: "Pedro", middleName: "   ", lastName: "Santos",
    roleId: 4, email: `nomiddle.${Date.now()}@hardware.com`
  });
  expect("admin", "create with no middle name", noMiddle, [200]);
  const afterNoMiddle = await call(admin, "GET", "/api/users");
  const noMiddleRow = Array.isArray(afterNoMiddle.body)
    ? afterNoMiddle.body.find((u) => u.staff_id === (noMiddle.body && noMiddle.body.staffId)) : null;
  record("admin", "a blank middle name stays blank and prints no initial",
    noMiddleRow && noMiddleRow.middle_name === null &&
    noMiddleRow.full_name === "Pedro Santos",
    JSON.stringify(noMiddleRow || {}).slice(0, 140));

  // THE REVIEW STEP, AND THE PASSWORD NOBODY TYPED
  //
  // Nothing was sent for the password, so the server has to have made one --
  // and it has to have shown it for checking BEFORE the account existed,
  // which is the whole point of the two steps. With mail switched off, which
  // is how the project ships, it comes back again afterwards to be handed
  // over.
  record("admin", "the review hands back the account before it is created",
    twin.review && twin.review.fullName === "Juan D. Cruz" &&
    twin.review.roleName === "Inventory Clerk" &&
    twin.review.phone === "+639170001111" &&
    typeof twin.review.password === "string",
    JSON.stringify(twin.review || {}).slice(0, 200));
  record("admin", "the password shown for checking is the one the account gets",
    twin.review && twin.body && twin.review.password === twin.body.password,
    "the password changed between the review and the account");
  record("admin", "a review cannot be confirmed twice",
    twin.review &&
    (await call(admin, "POST", "/api/users", { draftId: twin.review.draftId })).status === 410,
    "the same draft created a second account");
  record("admin", "a review created nothing on its own", await (async () => {
    const email = `never.${Date.now()}@hardware.com`;
    const draft = await call(admin, "POST", "/api/users/draft",
      { firstName: "Never", lastName: "Made", roleId: 4, email: email });
    if (draft.status !== 200) return false;
    const list = await call(admin, "GET", "/api/users");
    return Array.isArray(list.body) && !list.body.some((u) => u.email === email);
  })(), "a staff row appeared from the review step alone");

  record("admin", "the server made the first password without being given one",
    twin.body && twin.body.emailed === false && typeof twin.body.password === "string" &&
    twin.body.password.length >= 8,
    JSON.stringify(twin.body || {}).slice(0, 160));
  record("admin", "a generated password avoids the characters that get misread",
    twin.body && typeof twin.body.password === "string" &&
    !/[0O1lI2Z5S8B]/.test(twin.body.password),
    twin.body ? String(twin.body.password) : "missing");
  record("admin", "two accounts never get the same first password",
    twin.body && noMiddle.body && twin.body.password !== noMiddle.body.password, "");
  const trailAfterCreate = await call(admin, "GET", "/api/audit-logs?limit=60");
  record("admin", "the audit trail records the account, not the password",
    !JSON.stringify(trailAfterCreate.body || []).includes(String(twin.body && twin.body.password)),
    "a generated password was found in the audit trail");

  // the same name in a different role is fine, as long as the email differs
  const sameName = await createAccount(admin, {
    firstName: "Juan", middleName: "Pascual", lastName: "Cruz", phone: "09170002222",
    roleId: 4, email: `twin2.${Date.now()}@hardware.com`
  });
  expect("admin", "same name, different role, own email", sameName, [200]);

  const sameEmail = await createAccount(admin, {
    firstName: "Juan", middleName: "Xavier", lastName: "Cruz",
    roleId: 2, email: twinEmail
  });
  record("admin", "duplicate email explained clearly",
    sameEmail.status === 409 && /already signs in/.test(sameEmail.body.error || ""),
    `${sameEmail.status} ${JSON.stringify(sameEmail.body)}`);

  // an address that cannot receive a password is refused before the account exists
  const badAddress = await createAccount(admin, {
    firstName: "Nope", lastName: "Person", roleId: 4, email: "not-an-address"
  });
  record("admin", "an unusable email is refused", badAddress.status === 400,
    `${badAddress.status} ${JSON.stringify(badAddress.body)}`);

  // ONE SPELLING OF A PHONE NUMBER
  //
  // The browser prints +63 beside the box and drops everything that is not a
  // digit as it is typed. None of that is worth anything on its own, because
  // a browser is not where a rule lives -- so the same rule is checked here,
  // over HTTP, the way anything that skips the form would meet it.
  const shortPhone = await call(admin, "POST", "/api/users/draft", {
    firstName: "Short", lastName: "Phone", roleId: 4,
    email: `short.${Date.now()}@hardware.com`, phone: "+63917123"
  });
  record("admin", "a phone number of the wrong length is refused with a reason",
    shortPhone.status === 400 && /10 digits after \+63/.test(shortPhone.body.error || ""),
    `${shortPhone.status} ${JSON.stringify(shortPhone.body)}`);

  // ten digits, so it clears the length rule and is refused by the other one
  const landline = await call(admin, "POST", "/api/users/draft", {
    firstName: "Land", lastName: "Line", roleId: 4,
    email: `land.${Date.now()}@hardware.com`, phone: "8171234567"
  });
  record("admin", "a number that does not start 9 after +63 is refused",
    landline.status === 400 && /starts with 9/.test(landline.body.error || ""),
    `${landline.status} ${JSON.stringify(landline.body)}`);

  const lettersPhone = await call(admin, "POST", "/api/users/draft", {
    firstName: "Letters", lastName: "Phone", roleId: 4,
    email: `letters.${Date.now()}@hardware.com`, phone: "n/a"
  });
  record("admin", "letters in the phone box are dropped, never stored",
    lettersPhone.status === 200 && lettersPhone.body.phone === null,
    `${lettersPhone.status} ${JSON.stringify(lettersPhone.body)}`);

  for (const spelling of ["09171234567", "+639171234567", "639171234567", "0917 123 4567"]) {
    const draft = await call(admin, "POST", "/api/users/draft", {
      firstName: "Spelling", lastName: "Test", roleId: 4,
      email: `spell.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@hardware.com`,
      phone: spelling
    });
    record("admin", `"${spelling}" is stored as +639171234567`,
      draft.status === 200 && draft.body.phone === "+639171234567",
      `${draft.status} ${JSON.stringify(draft.body && draft.body.phone)}`);
  }

  const created = await createAccount(admin, {
    firstName: "Test", lastName: "Person", phone: "09171112222",
    roleId: 4, email: `test.person.${Date.now()}@hardware.com`
  });
  expect("admin", "POST users", created, [200]);
  const newStaffId = created.body && created.body.staffId;

  if (newStaffId) {
    expect("admin", "PUT users/:id", await call(admin, "PUT", `/api/users/${newStaffId}`, {
      firstName: "Test", lastName: "Person", phone: "09171112222", roleId: 4
    }), [200]);
    expect("admin", "POST reset-password", await call(admin, "POST",
      `/api/users/${newStaffId}/reset-password`, { newPassword: "another12345" }), [200]);
    expect("admin", "PATCH status off", await call(admin, "PATCH",
      `/api/users/${newStaffId}/status`, { isActive: false }), [200]);
    expect("admin", "PATCH status on", await call(admin, "PATCH",
      `/api/users/${newStaffId}/status`, { isActive: true }), [200]);
  }

  // duplicate email must be refused with a useful message
  const dup = await createAccount(admin, {
    firstName: "Admin", lastName: "User", phone: "09171112222",
    roleId: 2, email: "admin@hardware.com"
  });
  record("admin", "duplicate email refused", dup.status === 409,
    `${dup.status} ${JSON.stringify(dup.body)}`);

  console.log("== MANAGER ==");
  const manager = sessions.manager.cookie;
  expect("manager", "GET manager/summary",  await call(manager, "GET", "/api/manager/summary"), [200]);
  expect("manager", "GET reports/overview", await call(manager, "GET", "/api/reports/overview"), [200]);
  expect("manager", "GET stocks",           await call(manager, "GET", "/api/stocks"), [200]);
  expect("manager", "GET sales",            await call(manager, "GET", "/api/sales"), [200]);
  expect("manager", "GET sales/1",          await call(manager, "GET", "/api/sales/1"), [200]);
  expect("manager", "GET deliveries",       await call(manager, "GET", "/api/deliveries"), [200]);
  expect("manager", "GET archives",         await call(manager, "GET", "/api/archives"), [200]);
  expect("manager", "GET notifications",    await call(manager, "GET", "/api/notifications?roleId=2"), [200]);
  for (const type of ["supplier", "customer", "product", "category", "unit"]) {
    expect("manager", `GET records/${type}`, await call(manager, "GET", `/api/records/${type}`), [200]);
  }
  expect("manager", "GET users blocked", await call(manager, "GET", "/api/users"), [403]);

  console.log("== INCOME, FILTERS & THE REORDER FORMULA ==");

  // every named period the screen offers has to answer
  for (const range of ["daily", "weekly", "monthly", "quarterly", "six-month", "annual", "all"]) {
    expect("manager", `GET income ${range}`,
      await call(manager, "GET", `/api/reports/income?range=${range}`), [200]);
  }

  const income = await call(manager, "GET", "/api/reports/income?range=annual");
  record("manager", "income separates billed from collected",
    income.body && income.body.totals &&
    Number(income.body.totals.billed) >= Number(income.body.totals.collected),
    "collected came back larger than billed, which cannot happen");
  record("manager", "income carries a series, methods and products",
    income.body && Array.isArray(income.body.series) &&
    Array.isArray(income.body.methods) && Array.isArray(income.body.products),
    "one of the three breakdowns was missing");

  const custom = await call(manager, "GET", "/api/reports/income?from=2026-08-01&to=2026-08-31");
  record("manager", "a custom date pair is honoured",
    custom.body && custom.body.range &&
    custom.body.range.from === "2026-08-01" && custom.body.range.to === "2026-08-31",
    JSON.stringify(custom.body && custom.body.range));

  // the two derived columns the sales screen filters on
  const allSales = await call(manager, "GET", "/api/sales");
  record("manager", "every sale carries a transaction status",
    Array.isArray(allSales.body) && allSales.body.length > 0 &&
    allSales.body.every((s) => ["Completed", "Pending Delivery", "Partial Credit"].includes(s.transaction_status)),
    "a live sale came back without a usable transaction status");

  const online = await call(manager, "GET", "/api/sales?method=Online%20Payment");
  record("manager", "the four electronic methods answer as one group",
    Array.isArray(online.body) &&
    online.body.every((s) => ["GCash", "PayMaya", "PayPal", "Bank Transfer"].includes(s.payment_method)),
    "the Online Payment filter returned something that is not an electronic method");

  const partial = await call(manager, "GET", "/api/sales?status=Partial%20Credit");
  record("manager", "the transaction-status filter narrows",
    Array.isArray(partial.body) &&
    partial.body.every((s) => s.transaction_status === "Partial Credit"),
    "the Partial Credit filter returned another status");

  const voided = await call(manager, "GET", "/api/sales?status=Voided");
  record("manager", "voided sales are only returned when asked for",
    Array.isArray(voided.body) && voided.body.every((s) => s.is_archived) &&
    !allSales.body.some((s) => s.is_archived),
    "an archived sale appeared in the default list");

  // the formula, checked against its own inputs rather than a fixed number
  const stocks = await call(manager, "GET", "/api/stocks");
  const rows = Array.isArray(stocks.body) ? stocks.body : [];

  record("manager", "every product carries its reorder policy",
    rows.length > 0 && rows.every((p) =>
      p.lead_time_days !== undefined && p.safety_stock !== undefined &&
      p.reorder_mode !== undefined && p.avg_daily_sales !== undefined),
    "a product came back without a lead time, safety stock or mode");

  record("manager", "ROP = (average daily sales x lead time) + safety stock",
    rows.every((p) =>
      Number(p.calculated_rop) ===
      Math.ceil(Number(p.avg_daily_sales) * Number(p.lead_time_days)) + Number(p.safety_stock)),
    "a calculated reorder point did not match its own inputs");

  record("manager", "Manual products keep the number a person typed",
    rows.filter((p) => p.reorder_mode === "Manual")
        .every((p) => Number(p.effective_rop) === Number(p.reorder_point)),
    "a manual product was given the calculated figure");

  record("manager", "Dynamic products use the calculated one",
    rows.filter((p) => p.reorder_mode === "Dynamic")
        .every((p) => Number(p.effective_rop) === Number(p.calculated_rop)),
    "a dynamic product was left on its manual figure");

  const dynamicRow = rows.find((p) => p.reorder_mode === "Dynamic") || rows[0];
  if (dynamicRow) {
    expect("manager", "PUT reorder-policy", await call(manager, "PUT",
      `/api/stocks/${dynamicRow.product_id}/reorder-policy`,
      { leadTimeDays: 12, safetyStock: 6, reorderMode: "Dynamic" }), [200]);

    const after = await call(manager, "GET", "/api/stocks");
    const changed = after.body.find((p) => p.product_id === dynamicRow.product_id);
    record("manager", "a saved policy changes the reorder point",
      changed && Number(changed.lead_time_days) === 12 && Number(changed.safety_stock) === 6 &&
      Number(changed.calculated_rop) ===
        Math.ceil(Number(changed.avg_daily_sales) * 12) + 6,
      "the reorder point did not follow the new policy");

    expect("manager", "reorder-policy refuses a silly lead time", await call(manager, "PUT",
      `/api/stocks/${dynamicRow.product_id}/reorder-policy`,
      { leadTimeDays: 0, safetyStock: 6, reorderMode: "Manual" }), [400]);
  }

  // delivered and paid for are two different things
  const deliveries = await call(manager, "GET", "/api/deliveries");
  record("manager", "every delivery carries a fulfilment state",
    Array.isArray(deliveries.body) && deliveries.body.length > 0 &&
    deliveries.body.every((d) => Boolean(d.fulfilment_state)),
    "a delivery came back with no fulfilment state");

  record("manager", "a delivered order owing money is not Completed",
    (deliveries.body || []).every((d) =>
      !(d.status === "Delivered" && Number(d.balance_due) > 0) ||
      d.fulfilment_state === "Pending Cash Collection"),
    "a delivered order with a balance was reported as Completed");

  record("manager", "a delivered order paid in full is Completed",
    (deliveries.body || []).every((d) =>
      !(d.status === "Delivered" && Number(d.balance_due) === 0) ||
      d.fulfilment_state === "Completed"),
    "a paid, delivered order was not Completed");

  console.log("== CREDIT MANAGEMENT ==");
  const book = await call(manager, "GET", "/api/credit/customers");
  expect("manager", "GET credit/customers", book, [200]);
  record("manager", "the credit view derives what is left to spend",
    Array.isArray(book.body) && book.body.length > 0 &&
    book.body.every((c) =>
      Number(c.available_credit) ===
      Math.max(Number(c.credit_limit) - Number(c.current_credit), 0)),
    "available credit did not equal limit minus owed");
  record("manager", "every account carries a standing",
    Array.isArray(book.body) &&
    book.body.every((c) => ["Good", "Watch", "Hold"].includes(c.standing)),
    "an account came back with no standing");

  const creditCustomer = book.body[0];
  expect("manager", "GET one credit account",
    await call(manager, "GET", `/api/credit/customers/${creditCustomer.customer_id}`), [200]);

  // purchases beside payments
  const history = await call(manager, "GET", `/api/customers/${creditCustomer.customer_id}/history`);
  expect("manager", "GET customer history", history, [200]);
  record("manager", "history holds purchases and payments together",
    history.body && Array.isArray(history.body.purchases) &&
    Array.isArray(history.body.payments) && Array.isArray(history.body.requests),
    "one of the three halves was missing");

  // a limit under what is owed is legitimate: it stops the account growing
  const owing = book.body.find((c) => Number(c.current_credit) > 0) || creditCustomer;
  expect("manager", "PUT a credit limit", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 99999, standing: "Good", notes: "Smoke test" }), [200]);
  expect("manager", "a negative limit is refused", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: -1, standing: "Good" }), [400]);
  expect("manager", "an invented standing is refused", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 1000, standing: "Excellent" }), [400]);

  // an account on hold refuses new credit however much room the limit has
  await call(manager, "PUT", `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 500000, standing: "Hold", notes: "Smoke test hold" });

  const heldSale = await call(cashierCookieForCredit(sessions), "POST", "/api/sales", {
    customerId: owing.customer_id, discount: 0, amountPaid: 0,
    paymentMethod: "Credit", items: [{ product_id: 2, quantity: 1 }]
  });
  record("cashier", "a held account cannot take new credit",
    heldSale.status === 403, `got ${heldSale.status}: ${JSON.stringify(heldSale.body).slice(0, 120)}`);

  // ...but paying for it in full at the counter still goes through
  await call(manager, "PUT", `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 500000, standing: "Good", notes: "Smoke test released" });

  // part payment: some now, the rest on the book
  const partSale = await call(cashierCookieForCredit(sessions), "POST", "/api/sales", {
    customerId: owing.customer_id, discount: 0, amountPaid: 200,
    paymentMethod: "Credit", downPaymentMethod: "Cash",
    items: [{ product_id: 2, quantity: 2 }]
  });
  expect("cashier", "POST a part-paid credit sale", partSale, [200]);

  if (partSale.body && partSale.body.saleId) {
    const detail = await call(manager, "GET", `/api/sales/${partSale.body.saleId}`);
    const s = detail.body && detail.body.sale;
    record("cashier", "a part-paid sale is recorded as Partial",
      s && s.payment_status === "Partial" && Number(s.amount_paid) === 200,
      JSON.stringify(s && { status: s.payment_status, paid: s.amount_paid }));
    record("cashier", "the down payment appears in the payment history",
      detail.body && Array.isArray(detail.body.payments) &&
      detail.body.payments.some((p) => Number(p.amount) === 200),
      "no payment row was written for the down payment");
  }

  // extension requests
  const raised = await call(cashierCookieForCredit(sessions), "POST", "/api/credit/requests", {
    customerId: owing.customer_id, requestedLimit: 750000,
    reason: "Smoke test extension"
  });
  expect("cashier", "POST a credit request", raised, [200]);

  const duplicate = await call(cashierCookieForCredit(sessions), "POST", "/api/credit/requests", {
    customerId: owing.customer_id, requestedLimit: 800000, reason: "Second try"
  });
  record("cashier", "one pending request per customer",
    duplicate.status === 409, `got ${duplicate.status}`);

  expect("manager", "GET credit/requests",
    await call(manager, "GET", "/api/credit/requests?status=Pending"), [200]);

  if (raised.body && raised.body.requestId) {
    const id = raised.body.requestId;

    expect("manager", "declining needs a reason", await call(manager, "POST",
      `/api/credit/requests/${id}/decide`, { approve: false }), [400]);

    expect("manager", "POST a decision", await call(manager, "POST",
      `/api/credit/requests/${id}/decide`,
      { approve: true, note: "Smoke test approval" }), [200]);

    const after = await call(manager, "GET", `/api/credit/customers/${owing.customer_id}`);
    record("manager", "approving raises the limit in the same move",
      after.body && after.body.credit && Number(after.body.credit.credit_limit) === 750000,
      `limit is ${after.body && after.body.credit && after.body.credit.credit_limit}`);

    expect("manager", "a decided request cannot be decided twice", await call(manager, "POST",
      `/api/credit/requests/${id}/decide`,
      { approve: false, note: "Changed my mind" }), [409]);
  }

  expect("cashier", "setting a limit refused", await call(cashierCookieForCredit(sessions), "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 1, standing: "Good" }), [403]);
  expect("cashier", "deciding a request refused", await call(cashierCookieForCredit(sessions), "POST",
    "/api/credit/requests/1/decide", { approve: true }), [403]);

  console.log("== LIVE SYNC ==");

  // The stream never ends, which is the point, so it cannot be read with the
  // ordinary call helper: that waits for a body that will not arrive. It is
  // opened, read until the first frame, and then abandoned.
  async function readStream(cookie, ms) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);

    try {
      const response = await fetch(`${BASE}/api/events`, {
        headers: { Cookie: cookie || "" },
        signal: stop.signal
      });

      const type = response.headers.get("content-type") || "";
      const reader = response.body.getReader();
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value || new Uint8Array());

      stop.abort();
      return { status: response.status, type, text };
    } catch (error) {
      return { status: 0, type: "", text: "", error: error.name };
    } finally {
      clearTimeout(timer);
    }
  }

  const stream = await readStream(manager, 4000);
  record("manager", "the live channel opens",
    stream.status === 200, `status ${stream.status} ${stream.error || ""}`);
  record("manager", "and is sent as an event stream",
    stream.type.includes("text/event-stream"), stream.type);
  record("manager", "which opens with a hello and a version",
    /event: hello/.test(stream.text) && /"version"/.test(stream.text),
    stream.text.slice(0, 120).replace(/\n/g, " "));

  const anonStream = await readStream(null, 3000);
  record("anon", "a stranger cannot listen",
    anonStream.status === 401 || anonStream.status === 403,
    `status ${anonStream.status}`);

  const liveStatus = await call(manager, "GET", "/api/events/status");
  expect("manager", "GET events/status", liveStatus, [200]);
  record("manager", "the version moves when something is written",
    liveStatus.body && Number.isInteger(liveStatus.body.version),
    JSON.stringify(liveStatus.body));

  const versionBefore = liveStatus.body.version;
  await call(manager, "PUT", `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 123456, standing: "Good", notes: "Live sync check" });
  const versionAfter = (await call(manager, "GET", "/api/events/status")).body.version;
  record("manager", "a write bumps the version every listener sees",
    versionAfter > versionBefore, `${versionBefore} -> ${versionAfter}`);

  console.log("== WHO MAY TAKE A REPORT AWAY ==");
  expect("manager", "GET reports/export", await call(manager, "GET",
    "/api/reports/export?report=payment-methods&range=annual"), [200]);
  expect("manager", "export refuses an unknown report", await call(manager, "GET",
    "/api/reports/export?report=nonsense"), [400]);
  expect("manager", "GET daily-tally", await call(manager, "GET", "/api/reports/daily-tally"), [200]);

  console.log("== CLERK ==");
  const clerk = sessions.clerk.cookie;
  expect("clerk", "GET inventory/summary",     await call(clerk, "GET", "/api/inventory/summary"), [200]);
  expect("clerk", "GET inventory/products",    await call(clerk, "GET", "/api/inventory/products?archived=false"), [200]);
  expect("clerk", "GET inventory/products arch", await call(clerk, "GET", "/api/inventory/products?archived=true"), [200]);
  expect("clerk", "GET inventory/adjustments", await call(clerk, "GET", "/api/inventory/adjustments"), [200]);
  expect("clerk", "GET purchase-orders",       await call(clerk, "GET", "/api/purchase-orders"), [200]);
  expect("clerk", "GET purchase-orders/1/items", await call(clerk, "GET", "/api/purchase-orders/1/items"), [200]);
  expect("clerk", "GET returns",               await call(clerk, "GET", "/api/returns"), [200]);
  expect("clerk", "POST inventory/adjust",     await call(clerk, "POST", "/api/inventory/adjust", {
    productId: 2, adjustmentType: "Add", quantity: 3, reason: "Smoke test top-up"
  }), [200]);
  expect("clerk", "PUT reorder/2",             await call(clerk, "PUT", "/api/inventory/reorder/2", { reorderPoint: 20 }), [200]);
  const po = await call(clerk, "POST", "/api/purchase-orders", {
    supplierId: 1, items: [{ product_id: 2, quantity: 5, unit_cost: 300 }]
  });
  expect("clerk", "POST purchase-orders", po, [200]);
  if (po.body && po.body.poId) {
    expect("clerk", "POST receive PO", await call(clerk, "POST", `/api/purchase-orders/${po.body.poId}/receive`), [200]);
  }
  console.log("== RETURNS: REMARKS AND WHERE THE GOODS GO ==");

  // A word is not a reason. Three months from now a write-off queried against
  // a stock count has to be explainable from the line alone.
  expect("clerk", "a one-word reason is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "broken", refundAmount: 0, disposition: "Write-Off"
  }), [400]);

  expect("clerk", "an empty reason is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "   ", refundAmount: 0, disposition: "Write-Off"
  }), [400]);

  // Where the goods physically go is not optional and has no default: the
  // wrong answer here leaves stock unaccounted for.
  expect("clerk", "no disposition is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "Casing cracked during unloading from the truck.", refundAmount: 0
  }), [400]);

  expect("clerk", "an invented disposition is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "Casing cracked during unloading from the truck.",
    refundAmount: 0, disposition: "Maybe"
  }), [400]);

  // Where the goods go decides what happens to the count, and it is not
  // symmetrical. A write-off with no sale behind it was still on the shelf, so
  // it comes off. A return to stock always goes back on. The stock route
  // belongs to the manager, so the readings are taken with their session.
  const stockOf = async (productId) => {
    const rows = (await call(manager, "GET", "/api/stocks")).body;
    const row = (Array.isArray(rows) ? rows : []).find((p) => p.product_id === productId);
    return row ? Number(row.quantity_in_stock) : null;
  };

  const beforeWriteOff = await stockOf(2);

  const writeOff = await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "Casing cracked during unloading from the truck.",
    refundAmount: 0, disposition: "Write-Off"
  });
  expect("clerk", "POST a write-off", writeOff, [200]);
  record("clerk", "the disposition comes back on the record",
    writeOff.body && writeOff.body.disposition === "Write-Off",
    JSON.stringify(writeOff.body).slice(0, 120));

  const afterWriteOff = await stockOf(2);
  record("clerk", "a write-off with no sale takes the unit off the count",
    afterWriteOff === beforeWriteOff - 1,
    `${beforeWriteOff} -> ${afterWriteOff}`);

  const putBack = await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Return", quantity: 1,
    reason: "Customer changed their mind, box never opened.",
    refundAmount: 0, disposition: "Return to Stock"
  });
  expect("clerk", "POST a return to stock", putBack, [200]);

  const afterPutBack = await stockOf(2);
  record("clerk", "returning to stock puts the unit back on the count",
    afterPutBack === afterWriteOff + 1,
    `${afterWriteOff} -> ${afterPutBack}`);

  // the older callers that still send restock keep working
  const legacy = await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Return", quantity: 1,
    reason: "Filed the old way, with the restock flag rather than words.",
    refundAmount: 0, restock: true
  });
  expect("clerk", "the old restock flag still maps across", legacy, [200]);
  record("clerk", "and maps to Return to Stock",
    legacy.body && legacy.body.disposition === "Return to Stock",
    JSON.stringify(legacy.body).slice(0, 120));

  const listed2 = await call(clerk, "GET", "/api/returns");
  record("clerk", "every return record says where the goods went",
    Array.isArray(listed2.body) && listed2.body.length > 0 &&
    listed2.body.every((r) => ["Return to Stock", "Write-Off"].includes(r.disposition)),
    "a return came back with no disposition");
  record("clerk", "and every one carries its remarks",
    Array.isArray(listed2.body) &&
    listed2.body.every((r) => typeof r.reason === "string" && r.reason.trim().length > 0),
    "a return came back with no reason");

  const report = writeOff;
  if (report.body && report.body.reportId) {
    expect("clerk", "POST resolve return", await call(clerk, "POST", `/api/returns/${report.body.reportId}/resolve`), [200]);
  }

  console.log("== CASHIER ==");
  const cashier = sessions.cashier.cookie;
  const cashierUser = sessions.cashier.user;
  expect("cashier", "GET inventory/products", await call(cashier, "GET", "/api/inventory/products?archived=false"), [200]);
  expect("cashier", "GET records/customer",   await call(cashier, "GET", "/api/records/customer"), [200]);
  expect("cashier", "GET sales/undelivered",  await call(cashier, "GET", "/api/sales/undelivered"), [200]);
  expect("cashier", "GET cashier/summary",    await call(cashier, "GET",
    `/api/cashier/summary?staffId=${cashierUser.staff_id}`), [200]);

  // The reporting split: a cashier reads their own day on the screen and
  // cannot take anything off it. Hiding the button is not the control; this
  // is, so it is tested as a refusal rather than as a missing element.
  const tally = await call(cashier, "GET", "/api/reports/daily-tally");
  expect("cashier", "GET daily-tally", tally, [200]);
  record("cashier", "the tally is their own sales, not the shop's",
    tally.body && tally.body.scope === "Your own sales" && tally.body.canExport === false,
    JSON.stringify(tally.body && { scope: tally.body.scope, canExport: tally.body.canExport }));
  expect("cashier", "export refused", await call(cashier, "GET",
    "/api/reports/export?report=payment-methods"), [403]);
  expect("cashier", "income report refused", await call(cashier, "GET",
    "/api/reports/income?range=annual"), [403]);
  expect("cashier", "reorder policy refused", await call(cashier, "PUT",
    "/api/stocks/1/reorder-policy", { leadTimeDays: 7, safetyStock: 0, reorderMode: "Manual" }), [403]);
  const sale = await call(cashier, "POST", "/api/sales", {
    customerId: 1, discount: 0, amountPaid: 1000, paymentMethod: "Cash",
    items: [{ product_id: 2, quantity: 1 }]
  });
  expect("cashier", "POST sales", sale, [200]);
  if (sale.body && sale.body.saleId) {
    expect("cashier", "GET sale detail", await call(cashier, "GET", `/api/sales/${sale.body.saleId}`), [200]);
    const del = await call(cashier, "POST", "/api/deliveries", {
      saleId: sale.body.saleId, address: "Smoke test address", scheduledDate: null, remarks: null
    });
    expect("cashier", "POST deliveries", del, [200]);
    global.smokeDeliveryId = del.body && del.body.deliveryId;
  }
  const creditSale = await call(cashier, "POST", "/api/sales", {
    customerId: 1, discount: 0, amountPaid: 0, paymentMethod: "Credit",
    items: [{ product_id: 3, quantity: 2 }]
  });
  expect("cashier", "POST credit sale", creditSale, [200]);
  if (creditSale.body && creditSale.body.saleId) {
    expect("cashier", "POST sale payment", await call(cashier, "POST",
      `/api/sales/${creditSale.body.saleId}/payment`, { amount: 100, paymentMethod: "Cash" }), [200]);
  }
  // Cash on Delivery takes no money at the register: the driver collects it.
  const cod = await call(cashier, "POST", "/api/sales", {
    customerId: 1, discount: 0, amountPaid: 0, paymentMethod: "COD",
    items: [{ product_id: 2, quantity: 1 }]
  });
  expect("cashier", "POST COD sale", cod, [200]);
  if (cod.body && cod.body.saleId) {
    const detail = await call(cashier, "GET", `/api/sales/${cod.body.saleId}`);
    record("cashier", "COD sale is Unpaid, not Paid",
      detail.body.sale.payment_status === "Unpaid",
      `status=${detail.body.sale.payment_status}`);
  }
  if (creditSale.body && creditSale.body.saleId) {
    const detail = await call(cashier, "GET", `/api/sales/${creditSale.body.saleId}`);
    record("cashier", "credit sale is Partial after a part payment",
      detail.body.sale.payment_status === "Partial",
      `status=${detail.body.sale.payment_status}`);
  }
  const summary = await call(sessions.manager.cookie, "GET", "/api/manager/summary");
  record("manager", "pending credits count the unpaid sales",
    Number(summary.body.pendingCredits) > 0, `pendingCredits=${summary.body.pendingCredits}`);
  // the dashboard shows one receivables figure because these three are one
  // equation; if that ever stops holding, the collapsed card is lying
  record("manager", "billed minus collected equals what is outstanding",
    Math.round((Number(summary.body.grossSales) - Number(summary.body.totalIncome)) * 100)
      === Math.round(Number(summary.body.pendingCredits) * 100),
    `${summary.body.grossSales} - ${summary.body.totalIncome} vs ${summary.body.pendingCredits}`);

  expect("cashier", "oversell refused", await call(cashier, "POST", "/api/sales", {
    customerId: null, discount: 0, amountPaid: 999999, paymentMethod: "Cash",
    items: [{ product_id: 2, quantity: 99999 }]
  }), [400, 409]);
  expect("cashier", "GET stocks blocked", await call(cashier, "GET", "/api/stocks"), [403]);

  console.log("== DELIVERY ==");
  const driver = sessions.delivery.cookie;
  const driverUser = sessions.delivery.user;
  expect("delivery", "GET delivery/list", await call(driver, "GET",
    `/api/delivery/list?staffId=${driverUser.staff_id}`), [200]);
  expect("delivery", "GET delivery/summary", await call(driver, "GET",
    `/api/delivery/summary?staffId=${driverUser.staff_id}`), [200]);
  if (global.smokeDeliveryId) {
    expect("delivery", "PATCH out for delivery", await call(driver, "PATCH",
      `/api/deliveries/${global.smokeDeliveryId}/status`, { status: "Out for Delivery" }), [200]);
    expect("delivery", "PATCH delivered", await call(driver, "PATCH",
      `/api/deliveries/${global.smokeDeliveryId}/status`, { status: "Delivered" }), [200]);
    expect("delivery", "illegal transition refused", await call(driver, "PATCH",
      `/api/deliveries/${global.smokeDeliveryId}/status`, { status: "Pending" }), [400, 409]);
  }

  console.log("== YOUR OWN ACCOUNT ==");
  for (const role of ["manager", "clerk", "cashier", "delivery"]) {
    const cookie = sessions[role].cookie;
    const me = expect(role, "GET me", await call(cookie, "GET", "/api/me"), [200]);
    record(role, "me is my own record",
      me.body && me.body.staff_id === sessions[role].user.staff_id,
      JSON.stringify(me.body || {}).slice(0, 120));

    const saved = await call(cookie, "PUT", "/api/me", {
      firstName: me.body.first_name, middleName: "Quintana",
      lastName: me.body.last_name, phone: "09179998888", email: me.body.email
    });
    expect(role, "PUT me", saved, [200]);
    record(role, "own middle name saved in full",
      saved.body && saved.body.user && saved.body.user.middle_name === "Quintana",
      JSON.stringify(saved.body && saved.body.user || {}).slice(0, 140));
    record(role, "and shown as one initial",
      saved.body && saved.body.user &&
      saved.body.user.full_name === `${me.body.first_name} Q. ${me.body.last_name}`,
      String(saved.body && saved.body.user && saved.body.user.full_name));
    record(role, "own phone stored as +63",
      saved.body && saved.body.user && saved.body.user.phone === "+639179998888",
      String(saved.body && saved.body.user && saved.body.user.phone));

    const badOwnPhone = await call(cookie, "PUT", "/api/me", {
      firstName: me.body.first_name, lastName: me.body.last_name,
      phone: "12345", email: me.body.email
    });
    record(role, "a bad phone number on my own record is refused too",
      badOwnPhone.status === 400,
      `${badOwnPhone.status} ${JSON.stringify(badOwnPhone.body)}`);

    const stolen = await call(cookie, "PUT", "/api/me", {
      firstName: me.body.first_name, lastName: me.body.last_name,
      email: "admin@hardware.com"
    });
    record(role, "cannot take another account's email", stolen.status === 409,
      `${stolen.status} ${JSON.stringify(stolen.body)}`);

    const wrongCurrent = await call(cookie, "POST", "/api/me/password", {
      currentPassword: "not-my-password", newPassword: "brandnew12345"
    });
    record(role, "password change needs the current one", wrongCurrent.status === 403,
      `got ${wrongCurrent.status}`);
  }

  // a full round trip: change my own password, then sign in with the new one
  const clerkPassword = await call(sessions.clerk.cookie, "POST", "/api/me/password", {
    currentPassword: "clerk123", newPassword: "clerkchanged123"
  });
  expect("clerk", "POST me/password", clerkPassword, [200]);
  const reLogin = await login("clerk@hardware.com", "clerkchanged123");
  record("clerk", "new password signs in", reLogin.ok, `got ${reLogin.status}`);
  const oldLogin = await login("clerk@hardware.com", "clerk123");
  record("clerk", "old password refused", oldLogin.status === 401, `got ${oldLogin.status}`);

  console.log("== PRIVATE FILES ==");
  for (const file of ["/javascript/server.js", "/database/1-RUN-FIRST-database.sql",
                      "/database/2-RUN-SECOND-stored-procedures.sql", "/database/0-READ-ME-FIRST.md"]) {
    const page = await fetch(BASE + file);
    record("anon", `${file} not downloadable`, page.status === 404, `got ${page.status}`);
  }
  for (const file of ["/Login.html", "/css/style.css", "/javascript/app.js",
                      "/vendor/bootstrap/bootstrap.min.css", "/vendor/bootstrap/bootstrap.bundle.min.js"]) {
    const page = await fetch(BASE + file);
    record("anon", `${file} served`, page.status === 200, `got ${page.status}`);
  }

  console.log("== SESSION RULES ==");
  const anon = await call(null, "GET", "/api/users");
  record("anon", "no cookie refused", anon.status === 401, `got ${anon.status}`);
  const unknown = await call(admin, "GET", "/api/not-a-real-route");
  record("admin", "unknown route refused", unknown.status === 403 || unknown.status === 404, `got ${unknown.status}`);
  const out = await call(admin, "POST", "/api/logout", {});
  record("admin", "logout", out.status === 200, `got ${out.status}`);
  const afterLogout = await call(admin, "GET", "/api/users");
  record("admin", "session dead after logout", afterLogout.status === 401, `got ${afterLogout.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failures:");
    failed.forEach((f) => console.log(`  [${f.role}] ${f.label}: ${f.detail}`));
    process.exit(1);
  }
})();
