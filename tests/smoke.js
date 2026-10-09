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

// Creating an account is two requests (review, then create from the draft).
// Runs both and hands back the reply of whichever step ended it; `review`
// is attached so a test can look at what the card would have said.
async function createAccount(cookie, details) {
  const review = await call(cookie, "POST", "/api/users/draft", details);
  if (review.status !== 200) return review;

  const created = await call(cookie, "POST", "/api/users",
    { draftId: review.body.draftId });
  created.review = review.body;
  return created;
}

// the credit checks run in the manager block but need the cashier's cookie
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
  let admin = sessions.admin.cookie;
  expect("admin", "GET roles",       await call(admin, "GET", "/api/roles"), [200]);
  expect("admin", "GET users",       await call(admin, "GET", "/api/users"), [200]);
  expect("admin", "GET users/1",     await call(admin, "GET", "/api/users/1"), [200]);
  expect("admin", "GET audit-logs",  await call(admin, "GET", "/api/audit-logs"), [200]);
  expect("admin", "GET archives",    await call(admin, "GET", "/api/archives"), [200]);

  console.log("== PRESENCE, FILTERS & THE WIDER AUDIT TRAIL ==");
  expect("admin", "POST heartbeat",       await call(admin, "POST", "/api/heartbeat"), [200]);
  expect("admin", "GET audit-logs/types", await call(admin, "GET", "/api/audit-logs/types"), [200]);

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

  // the database ships with five active accounts, so the archived one is made here
  const archived = await createAccount(admin, {
    firstName: "Former", lastName: "Clerk", roleId: 3, email: "former.clerk@hardware.com"
  });
  if (archived.status === 200) {
    await call(admin, "PATCH", `/api/users/${archived.body.staffId || archived.body.staff_id}/status`,
      { isActive: false });
  }

  const inactiveOnly = await call(admin, "GET", "/api/users?status=inactive");
  record("admin", "status=inactive filters",
    Array.isArray(inactiveOnly.body) &&
    inactiveOnly.body.every((row) => !row.is_active),
    "an active account came back from the inactive filter");

  record("admin", "archived staff carry a date and an archiver",
    Array.isArray(inactiveOnly.body) && inactiveOnly.body.length > 0 &&
    inactiveOnly.body.some((row) => row.archived_at && row.archived_by),
    "no archived row carried both archived_at and archived_by");

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

  // the automatic backup: the list has to say which kind each file is
  record("admin", "the backup list says whether the system backs itself up",
    listed.body && listed.body.auto && typeof listed.body.auto.enabled === "boolean" &&
    listed.body.auto.schedule === "daily" && Number.isInteger(listed.body.auto.hour) &&
    listed.body.auto.keep > 0 && listed.body.limits && listed.body.limits.manual > 0 &&
    listed.body.folder === undefined,
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

  // the whole middle name is stored; staff.full_name shortens it to an initial
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

  // the review hands back the password before the account exists; with mail
  // off it comes back again afterwards
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

  // the phone rule is checked over HTTP, the way anything that skips the form meets it
  const shortPhone = await call(admin, "POST", "/api/users/draft", {
    firstName: "Short", lastName: "Phone", roleId: 4,
    email: `short.${Date.now()}@hardware.com`, phone: "+63917123"
  });
  record("admin", "a Philippine number of the wrong length is refused with a reason",
    shortPhone.status === 400 && /10 digits after \+63/.test(shortPhone.body.error || ""),
    `${shortPhone.status} ${JSON.stringify(shortPhone.body)}`);

  // the 09 spelling is the one everybody writes, and it lands as +63
  const local = await call(admin, "POST", "/api/users/draft", {
    firstName: "Local", lastName: "Spelling", roleId: 4,
    email: `local.${Date.now()}@hardware.com`, phone: "0917 123 4567"
  });
  record("admin", "09XX XXX XXXX is stored as +639XXXXXXXXX",
    local.status === 200 && local.body.phone === "+639171234567",
    `${local.status} ${JSON.stringify(local.body && local.body.phone)}`);

  // ten digits after +63, so it clears the length rule and is refused by the other one
  const landline = await call(admin, "POST", "/api/users/draft", {
    firstName: "Land", lastName: "Line", roleId: 4,
    email: `land.${Date.now()}@hardware.com`, phone: "+63 817 123 4567"
  });
  record("admin", "a number that does not start 9 after +63 is refused",
    landline.status === 400 && /starts with 09/.test(landline.body.error || ""),
    `${landline.status} ${JSON.stringify(landline.body)}`);

  // a number from another country is refused
  const abroad = await call(admin, "POST", "/api/users/draft", {
    firstName: "From", lastName: "Abroad", roleId: 4,
    email: `abroad.${Date.now()}@hardware.com`, phone: "+1 (415) 555-1234"
  });
  record("admin", "a number with another country code is refused with the spellings taken",
    abroad.status === 400 && /Only Philippine numbers/.test(abroad.body.error || ""),
    `${abroad.status} ${JSON.stringify(abroad.body)}`);

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
    const reset = expect("admin", "POST reset-password", await call(admin, "POST",
      `/api/users/${newStaffId}/reset-password`, {}), [200]);
    record("admin", "the reset password came from the server",
      reset.body && typeof reset.body.password === "string" && reset.body.password.length >= 8,
      JSON.stringify(reset.body).slice(0, 120));
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
  record("manager", "every account carries its late-payment rate and penalties owed",
    Array.isArray(book.body) &&
    book.body.every((c) => Number.isFinite(Number(c.penalty_rate)) && c.penalties_owed !== undefined),
    "an account came back without penalty_rate or penalties_owed");

  // the late-payment policy: the manager sets it, the cashier only reads it
  const policy = await call(manager, "GET", "/api/credit/policy");
  expect("manager", "GET credit/policy", policy, [200]);
  record("manager", "the policy carries a rate of 1 to 3 percent a month",
    policy.body && Number(policy.body.penalty_rate) >= 1 && Number(policy.body.penalty_rate) <= 3,
    JSON.stringify(policy.body).slice(0, 120));
  expect("cashier", "GET credit/policy", await call(cashierCookieForCredit(sessions), "GET", "/api/credit/policy"), [200]);
  expect("cashier", "a cashier cannot set the late-payment rate",
    await call(cashierCookieForCredit(sessions), "PUT", "/api/credit/policy", { penaltyRate: 2 }), [403]);
  expect("manager", "a rate over 3 a month is refused",
    await call(manager, "PUT", "/api/credit/policy", { penaltyRate: 3.5 }), [400]);
  expect("manager", "a rate under 1 a month is refused",
    await call(manager, "PUT", "/api/credit/policy", { penaltyRate: 0.5 }), [400]);
  expect("manager", "PUT credit/policy", await call(manager, "PUT", "/api/credit/policy", { penaltyRate: 2.5 }), [200]);
  const changed = await call(manager, "GET", "/api/credit/policy");
  record("manager", "the new rate is what is read back",
    changed.body && Number(changed.body.penalty_rate) === 2.5, JSON.stringify(changed.body).slice(0, 80));
  // back to the default, so the sweep behaves as documented after this run
  expect("manager", "PUT credit/policy back to 3",
    await call(manager, "PUT", "/api/credit/policy", { penaltyRate: 3 }), [200]);

  // every open balance is measured against the bill with any penalty on it
  const open = await call(cashierCookieForCredit(sessions), "GET", "/api/credit/open-sales");
  expect("cashier", "GET credit/open-sales", open, [200]);
  record("cashier", "balance due = amount due (sale + penalty) - paid, on every open sale",
    Array.isArray(open.body) && open.body.every((s) =>
      Math.abs(Number(s.balance_due) -
        Math.max(Number(s.final_amount) + Number(s.penalty_amount) - Number(s.amount_paid), 0)) < 0.005 &&
      Math.abs(Number(s.amount_due) - (Number(s.final_amount) + Number(s.penalty_amount))) < 0.005),
    "an open sale's balance did not include its penalty");
  record("cashier", "a sale still inside its 30 days carries no penalty",
    Array.isArray(open.body) && open.body.every((s) => Number(s.days_old) > 30 || Number(s.penalty_amount) === 0),
    "a sale not yet due was charged a penalty");
  record("cashier", "a penalised sale has been charged one month for every 30 days (or part) past due",
    Array.isArray(open.body) && open.body.every((s) => Number(s.penalty_amount) === 0 ||
      Number(s.penalty_months) === Math.ceil((Number(s.days_old) - 30) / 30)),
    "a sale's penalty_months did not match its days past due");

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
  expect("manager", "PUT a credit limit with the account's own late-payment rate", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 99999, standing: "Good", penaltyRate: 1, notes: "Smoke test" }), [200]);
  const ownRate = await call(manager, "GET", `/api/credit/customers/${owing.customer_id}`);
  record("manager", "the account reads back its own rate",
    ownRate.body && ownRate.body.credit && Number(ownRate.body.credit.penalty_rate) === 1 &&
      Number(ownRate.body.credit.penalty_rate_override) === 1,
    JSON.stringify(ownRate.body && ownRate.body.credit && ownRate.body.credit.penalty_rate));
  expect("manager", "a rate over 3 a month on an account is refused", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 99999, standing: "Good", penaltyRate: 4 }), [400]);
  expect("manager", "blank puts the account back on the shop's rate", await call(manager, "PUT",
    `/api/credit/customers/${owing.customer_id}/limit`,
    { creditLimit: 99999, standing: "Good", penaltyRate: "", notes: "Smoke test" }), [200]);
  const shopRate = await call(manager, "GET", `/api/credit/customers/${owing.customer_id}`);
  record("manager", "the override is gone and the shop's rate reads through",
    shopRate.body && shopRate.body.credit && shopRate.body.credit.penalty_rate_override === null,
    JSON.stringify(shopRate.body && shopRate.body.credit && shopRate.body.credit.penalty_rate_override));
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

  // the stream never ends: opened, read until the first frame, then abandoned
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
  expect("manager", "the whole income screen exports as one file", await call(manager, "GET",
    "/api/reports/export?report=income-breakdown&range=monthly"), [200]);
  expect("manager", "export refuses an unknown report", await call(manager, "GET",
    "/api/reports/export?report=nonsense"), [400]);
  expect("manager", "GET daily-tally", await call(manager, "GET", "/api/reports/daily-tally"), [200]);

  console.log("== CLERK ==");
  let clerk = sessions.clerk.cookie;
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

  console.log("== PURCHASE ORDERS: RAISED AND RECEIVED BY THE CLERK, CONFIRMED BY THE MANAGER ==");
  // the clerk raises an order; only the manager confirms it
  expect("manager", "a manager cannot raise an order", await call(manager, "POST", "/api/purchase-orders", {
    supplierId: 1, items: [{ product_id: 2, quantity: 5, unit_cost: 300 }]
  }), [403]);
  const po = await call(clerk, "POST", "/api/purchase-orders", {
    supplierId: 1, items: [{ product_id: 2, quantity: 5, unit_cost: 300 }]
  });
  expect("clerk", "POST purchase-orders", po, [200]);
  expect("clerk", "GET purchase-orders", await call(clerk, "GET", "/api/purchase-orders"), [200]);
  if (po.body && po.body.poId) {
    expect("manager", "GET purchase-orders/:id/items",
      await call(manager, "GET", `/api/purchase-orders/${po.body.poId}/items`), [200]);
    expect("clerk", "GET purchase-orders/:id/document",
      await call(clerk, "GET", `/api/purchase-orders/${po.body.poId}/document`), [200]);
    expect("clerk", "a clerk cannot confirm an order",
      await call(clerk, "POST", `/api/purchase-orders/${po.body.poId}/decide`, { approve: true }), [403]);
    expect("clerk", "an order not yet confirmed cannot be received",
      await call(clerk, "POST", `/api/purchase-orders/${po.body.poId}/receive`), [400]);
    expect("manager", "POST decide PO",
      await call(manager, "POST", `/api/purchase-orders/${po.body.poId}/decide`, { approve: true }), [200]);
    expect("manager", "a manager cannot receive an order, only check it",
      await call(manager, "POST", `/api/purchase-orders/${po.body.poId}/receive`), [403]);
    expect("clerk", "POST receive PO, once the manager has confirmed it",
      await call(clerk, "POST", `/api/purchase-orders/${po.body.poId}/receive`), [200]);
    expect("clerk", "an order already received cannot be received again",
      await call(clerk, "POST", `/api/purchase-orders/${po.body.poId}/receive`), [400]);
  }
  // suppliers, categories and units are the manager's to add; the clerk picks from what is on file
  expect("clerk", "a clerk cannot add a supplier",
    await call(clerk, "POST", "/api/suppliers", { name: "Smoke Supplier" }), [403]);
  expect("clerk", "an order to a supplier not on file is refused",
    await call(clerk, "POST", "/api/purchase-orders", {
      supplierName: "Nobody On File Trading", items: [{ product_id: 2, quantity: 1, unit_cost: 300 }]
    }), [400]);
  expect("clerk", "a material in a category not on file is refused",
    await call(clerk, "POST", "/api/materials", { name: "Smoke Widget", categoryName: "No Such Category Here", unitName: "pcs" }), [400]);
  expect("manager", "the staff password screen is gone",
    await call(manager, "GET", "/api/staff/passwords"), [403, 404]);
  expect("manager", "a table saves as a spreadsheet",
    await call(manager, "POST", "/api/reports/spreadsheet", {
      title: "Smoke", sheets: [{ name: "Smoke", headers: ["A", "B"], rows: [["x", 1]] }]
    }), [200]);
  console.log("== RETURNS: REMARKS AND WHERE THE GOODS GO ==");

  expect("clerk", "a one-word reason is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "broken", refundAmount: 0, disposition: "Write-Off"
  }), [400]);

  expect("clerk", "an empty reason is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "   ", refundAmount: 0, disposition: "Write-Off"
  }), [400]);

  expect("clerk", "no disposition is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "Casing cracked during unloading from the truck.", refundAmount: 0
  }), [400]);

  expect("clerk", "an invented disposition is refused", await call(clerk, "POST", "/api/returns", {
    productId: 2, saleId: null, reportType: "Damaged", quantity: 1,
    reason: "Casing cracked during unloading from the truck.",
    refundAmount: 0, disposition: "Maybe"
  }), [400]);

  // a write-off with no sale behind it comes off the shelf; a return always goes back on
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
  record("clerk", "every return record says where the goods went, unless the stockroom still has it",
    Array.isArray(listed2.body) && listed2.body.length > 0 &&
    listed2.body.every((r) => ["Return to Stock", "Write-Off"].includes(r.disposition) ||
      (r.status === "Open" && r.disposition === null && Number(r.awaiting_inspection) === 1)),
    "a return came back with no disposition and is not awaiting inspection");
  record("clerk", "and every one carries its remarks",
    Array.isArray(listed2.body) &&
    listed2.body.every((r) => typeof r.reason === "string" && r.reason.trim().length > 0),
    "a return came back with no reason");

  const report = writeOff;
  if (report.body && report.body.reportId) {
    expect("clerk", "POST resolve return", await call(clerk, "POST", `/api/returns/${report.body.reportId}/resolve`), [200]);
  }

  // A refund from the counter is the clerk's to judge: the cashier files it
  // with nowhere for the goods to go, nothing moves, and the clerk's verdict
  // puts it back on the shelf or writes it off.
  const counterCookie = cashierCookieForCredit(sessions);
  const beforeRefund = await stockOf(2);
  const refund = await call(counterCookie, "POST", "/api/returns", {
    productId: 2, saleId: 1, reportType: "Refunded", quantity: 1,
    reason: "Customer brought it back unopened, wrong size for the job.",
    refundAmount: 250, disposition: "Return to Stock"   // the counter's word is ignored
  });
  expect("cashier", "POST a refund from the counter", refund, [200]);
  record("cashier", "the refund waits for inspection whatever the counter said",
    refund.body && refund.body.disposition === null && refund.body.awaitingInspection === true,
    JSON.stringify(refund.body).slice(0, 120));
  record("cashier", "nothing moves on the shelf until the clerk has looked",
    (await stockOf(2)) === beforeRefund, `${beforeRefund} -> ${await stockOf(2)}`);

  if (refund.body && refund.body.reportId) {
    const id = refund.body.reportId;
    expect("cashier", "a cashier cannot give the verdict",
      await call(counterCookie, "POST", `/api/returns/${id}/resolve`, { disposition: "Return to Stock" }), [403]);
    expect("clerk", "a verdict is required on a refund from the counter",
      await call(clerk, "POST", `/api/returns/${id}/resolve`, {}), [400]);
    expect("clerk", "an invented verdict is refused",
      await call(clerk, "POST", `/api/returns/${id}/resolve`, { disposition: "Maybe" }), [400]);
    const verdict = await call(clerk, "POST", `/api/returns/${id}/resolve`,
      { disposition: "Return to Stock", note: "Box unopened, seals intact." });
    expect("clerk", "POST the inspection verdict", verdict, [200]);
    record("clerk", "sellable goods go back on the count",
      (await stockOf(2)) === beforeRefund + 1, `${beforeRefund} -> ${await stockOf(2)}`);
    const after = (await call(clerk, "GET", "/api/returns")).body.find((r) => r.return_id === id);
    record("clerk", "the report records who inspected it and what they found",
      after && after.status === "Resolved" && after.disposition === "Return to Stock" &&
        after.inspected_by && after.inspection_note === "Box unopened, seals intact.",
      JSON.stringify(after).slice(0, 160));
    expect("clerk", "a verdict cannot be given twice",
      await call(clerk, "POST", `/api/returns/${id}/resolve`, { disposition: "Write-Off" }), [400]);
  }

  console.log("== CASHIER ==");
  const cashier = sessions.cashier.cookie;
  const cashierUser = sessions.cashier.user;
  expect("cashier", "GET inventory/products", await call(cashier, "GET", "/api/inventory/products?archived=false"), [200]);
  expect("cashier", "GET records/customer",   await call(cashier, "GET", "/api/records/customer"), [200]);
  expect("cashier", "GET sales/undelivered",  await call(cashier, "GET", "/api/sales/undelivered"), [200]);
  expect("cashier", "GET cashier/summary",    await call(cashier, "GET",
    `/api/cashier/summary?staffId=${cashierUser.staff_id}`), [200]);

  // hiding the button is not the control; the refusal is
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
      saleId: sale.body.saleId, address: "Smoke test address", scheduledDate: null, remarks: null,
      contactPhone: "09171234567"
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
  // billed, collected, late penalties and outstanding are one equation
  record("manager", "billed minus collected, plus late penalties, equals what is outstanding",
    Math.round((Number(summary.body.grossSales) - Number(summary.body.totalIncome) +
                Number(summary.body.pendingPenalties)) * 100)
      === Math.round(Number(summary.body.pendingCredits) * 100),
    `${summary.body.grossSales} - ${summary.body.totalIncome} + ${summary.body.pendingPenalties} vs ${summary.body.pendingCredits}`);

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
    expect("delivery", "PATCH before taking it refused", await call(driver, "PATCH",
      `/api/deliveries/${global.smokeDeliveryId}/status`, { status: "Out for Delivery" }), [409]);
    const before = await call(driver, "GET", "/api/delivery/list");
    const unclaimed = Array.isArray(before.body) &&
      before.body.find((d) => d.delivery_id === global.smokeDeliveryId);
    record("delivery", "a delivery nobody has taken is on the driver's list",
      Boolean(unclaimed) && unclaimed.delivery_staff_id === null,
      unclaimed ? `delivery_staff_id=${unclaimed.delivery_staff_id}` : "not listed");
    expect("delivery", "POST claim", await call(driver, "POST",
      `/api/delivery/${global.smokeDeliveryId}/claim`, {}), [200]);
    const after = await call(driver, "GET", "/api/delivery/list");
    const taken = Array.isArray(after.body) &&
      after.body.find((d) => d.delivery_id === global.smokeDeliveryId);
    record("delivery", "a taken delivery stays on the list as the driver's own",
      Boolean(taken) && Number(taken.delivery_staff_id) === Number(driverUser.staff_id),
      taken ? `delivery_staff_id=${taken.delivery_staff_id}` : "gone from the list");
    expect("delivery", "taking it again is harmless", await call(driver, "POST",
      `/api/delivery/${global.smokeDeliveryId}/claim`, {}), [200]);
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
    record(role, "cannot change their own sign-in email", stolen.status === 403,
      `${stolen.status} ${JSON.stringify(stolen.body)}`);

    const ownPassword = await call(cookie, "POST", "/api/me/password", {
      currentPassword: "not-my-password", newPassword: "brandnew12345"
    });
    record(role, "cannot change their own password from their screen", ownPassword.status === 403,
      `got ${ownPassword.status}`);
  }

  // the administrator keeps their own password, and the current one is asked for
  const adminWrong = await call(admin, "POST", "/api/me/password", {
    currentPassword: "not-my-password", newPassword: "brandnew12345"
  });
  record("admin", "own password change needs the current one", adminWrong.status === 403,
    `got ${adminWrong.status}`);
  // and a "new" password that is the current one is not a change
  const adminSame = await call(admin, "POST", "/api/me/password", {
    currentPassword: "admin123", newPassword: "admin123"
  });
  record("admin", "own password cannot be changed to itself", adminSame.status === 400,
    `got ${adminSame.status} ${JSON.stringify(adminSame.body)}`);
  const stillAdmin = await login("admin@hardware.com", "admin123");
  record("admin", "and the current one still signs in afterwards", stillAdmin.ok,
    `got ${stillAdmin.status}`);
  // an account holds one session at a time, so that sign-in ended the first one
  admin = stillAdmin.cookie;

  const clerkReset = await call(admin, "POST", "/api/users/3/reset-password", {});
  expect("admin", "POST reset-password for the clerk", clerkReset, [200]);
  const clerkPassword = clerkReset.body && clerkReset.body.password;
  const reLogin = await login("clerk@hardware.com", clerkPassword || "");
  record("clerk", "the reset password signs in", reLogin.ok, `got ${reLogin.status}`);
  // an account holds one session at a time, so that sign-in ended the clerk's first one
  if (reLogin.cookie) clerk = reLogin.cookie;
  record("clerk", "and has to be changed on that sign-in",
    reLogin.body && reLogin.body.user && reLogin.body.user.must_change_password === 1 ||
    reLogin.body && reLogin.body.user && reLogin.body.user.must_change_password === true,
    JSON.stringify(reLogin.body && reLogin.body.user).slice(0, 120));
  const oldLogin = await login("clerk@hardware.com", "clerk123");
  record("clerk", "old password refused", oldLogin.status === 401, `got ${oldLogin.status}`);
  // the first-sign-in screen cannot keep the temporary password as the chosen one
  const keepTemporary = await call(reLogin.cookie, "POST", "/api/change-password", {
    newPassword: clerkPassword || ""
  });
  record("clerk", "cannot choose the temporary password as their own", keepTemporary.status === 400,
    `got ${keepTemporary.status} ${JSON.stringify(keepTemporary.body)}`);
  const stillTemporary = await login("clerk@hardware.com", clerkPassword || "");
  record("clerk", "and is still on the temporary one, still to be changed",
    stillTemporary.ok && stillTemporary.body.user &&
    (stillTemporary.body.user.must_change_password === 1 || stillTemporary.body.user.must_change_password === true),
    `got ${stillTemporary.status}`);
  // settle the clerk on a password of their own and sign in with it, so the
  // checks below have a clerk session that is past the first-sign-in screen
  await call(stillTemporary.cookie, "POST", "/api/change-password", { newPassword: "clerkpass456" });
  const clerkSettled = await login("clerk@hardware.com", "clerkpass456");
  record("clerk", "the chosen password signs in", clerkSettled.ok, `got ${clerkSettled.status}`);
  clerk = clerkSettled.cookie;

  // Screens by role: a grant widens only the screen's own routes.
  console.log("== SCREENS BY ROLE ==");
  const catalogue = expect("admin", "GET features", await call(admin, "GET", "/api/features"), [200]);
  record("admin", "the catalogue has the four staff roles and every screen",
    Array.isArray(catalogue.body.roles) && catalogue.body.roles.length === 4 &&
    Array.isArray(catalogue.body.features) && catalogue.body.features.length >= 20,
    JSON.stringify(catalogue.body).slice(0, 160));
  const roleIdOf = (name) => (catalogue.body.roles.find((r) => r.role_name === name) || {}).role_id;

  expect("cashier", "GET features refused", await call(cashier, "GET", "/api/features"), [403]);
  expect("cashier", "PUT a switch refused",
    await call(cashier, "PUT", `/api/features/delivery-schedule/roles/${roleIdOf("Cashier")}`, { granted: true }), [403]);

  const managerMenu = expect("manager", "GET me/features", await call(manager, "GET", "/api/me/features"), [200]);
  record("manager", "holds the delivery schedule by role",
    managerMenu.body.held.includes("delivery-schedule") &&
    managerMenu.body.features.find((f) => f.key === "delivery-schedule").byDefault === true,
    JSON.stringify(managerMenu.body.held));

  const clerkMenu = await call(clerk, "GET", "/api/me/features");
  record("clerk", "does not hold the schedule to begin with",
    clerkMenu.status === 200 && !clerkMenu.body.held.includes("delivery-schedule"), JSON.stringify(clerkMenu.body.held));
  expect("clerk", "GET deliveries refused by role", await call(clerk, "GET", "/api/deliveries"), [403]);

  const screenGranted = expect("admin", "PUT grant the schedule to clerks",
    await call(admin, "PUT", `/api/features/delivery-schedule/roles/${roleIdOf("Inventory Clerk")}`,
      { granted: true, note: "Packs for the van" }), [200]);
  record("admin", "the grant answers with the cell as it now stands",
    screenGranted.body.changed === true && screenGranted.body.cell && screenGranted.body.cell.held === true && screenGranted.body.cell.overridden === true,
    JSON.stringify(screenGranted.body).slice(0, 200));
  const sameSwitch = await call(admin, "PUT", `/api/features/delivery-schedule/roles/${roleIdOf("Inventory Clerk")}`,
    { granted: true, note: "Packs for the van" });
  record("admin", "the same switch again changes nothing", sameSwitch.status === 200 && sameSwitch.body.changed === false, JSON.stringify(sameSwitch.body));

  const clerkAfter = await call(clerk, "GET", "/api/me/features");
  record("clerk", "now holds the schedule by grant, on the next request",
    clerkAfter.body.held.includes("delivery-schedule") &&
    clerkAfter.body.features.find((f) => f.key === "delivery-schedule").byDefault === false,
    JSON.stringify(clerkAfter.body.held));
  expect("clerk", "GET deliveries now allowed", await call(clerk, "GET", "/api/deliveries"), [200]);
  expect("clerk", "PATCH a delivery still refused: the grant widens only the screen's own routes",
    await call(clerk, "PATCH", "/api/deliveries/1/status", { status: "In Transit" }), [403]);

  const takenBack = expect("admin", "PUT take the schedule back from clerks",
    await call(admin, "PUT", `/api/features/delivery-schedule/roles/${roleIdOf("Inventory Clerk")}`, { granted: false }), [200]);
  record("admin", "back at the default, the override row is gone rather than kept",
    takenBack.body.cell && takenBack.body.cell.overridden === false, JSON.stringify(takenBack.body).slice(0, 200));
  expect("clerk", "GET deliveries refused again", await call(clerk, "GET", "/api/deliveries"), [403]);

  expect("cashier", "GET returns allowed by role", await call(cashier, "GET", "/api/returns"), [200]);
  expect("admin", "PUT switch Refunds off for cashiers",
    await call(admin, "PUT", `/api/features/refunds/roles/${roleIdOf("Cashier")}`, { granted: false }), [200]);
  const refusedReturns = await call(cashier, "GET", "/api/returns");
  record("cashier", "refused the returns once the screen is off, and told which screen",
    refusedReturns.status === 403 && /switched off/.test(String(refusedReturns.body.error)),
    JSON.stringify(refusedReturns.body));
  expect("cashier", "the other screens are untouched", await call(cashier, "GET", "/api/credit/customers"), [200]);
  expect("admin", "PUT switch Refunds back on",
    await call(admin, "PUT", `/api/features/refunds/roles/${roleIdOf("Cashier")}`, { granted: true }), [200]);
  expect("cashier", "GET returns allowed again", await call(cashier, "GET", "/api/returns"), [200]);

  expect("admin", "a screen the cashier's page cannot draw is refused",
    await call(admin, "PUT", `/api/features/income/roles/${roleIdOf("Cashier")}`, { granted: true }), [400]);
  expect("admin", "the administrator's own role is refused",
    await call(admin, "PUT", "/api/features/income/roles/1", { granted: false }), [403]);
  expect("admin", "an unknown screen is refused",
    await call(admin, "PUT", `/api/features/no-such-screen/roles/${roleIdOf("Cashier")}`, { granted: true }), [404]);
  expect("admin", "granted has to be true or false",
    await call(admin, "PUT", `/api/features/refunds/roles/${roleIdOf("Cashier")}`, { granted: "yes" }), [400]);

  const screenTrail = await call(admin, "GET", "/api/audit-logs?actionType=ACCESS");
  record("admin", "the switches are on the trail as ACCESS entries",
    Array.isArray(screenTrail.body) &&
    screenTrail.body.some((row) => row.action === "GRANT_SCREEN" && row.details.includes("Inventory Clerk")) &&
    screenTrail.body.some((row) => row.action === "REVOKE_SCREEN" && row.details.includes("Cashier")),
    JSON.stringify((screenTrail.body || []).slice(0, 2)).slice(0, 200));

  // Three wrong passwords in a row and the account is held; the right one is
  // refused while it is; an administrator's reset releases it at once.
  console.log("== THE SIGN-IN HOLD ==");
  const first = await login("delivery@hardware.com", "not-it-1");
  record("delivery", "first wrong password is a plain refusal", first.status === 401 && !first.body.warning,
    `${first.status} ${JSON.stringify(first.body).slice(0, 120)}`);
  const second = await login("delivery@hardware.com", "not-it-2");
  record("delivery", "the second warns that the next one holds the account",
    second.status === 401 && /One more wrong password/.test(second.body.warning || ""),
    `${second.status} ${JSON.stringify(second.body).slice(0, 120)}`);
  const third = await login("delivery@hardware.com", "not-it-3");
  record("delivery", "the third holds the account", third.status === 423 && /held/.test(third.body.error),
    `${third.status} ${JSON.stringify(third.body).slice(0, 120)}`);
  const rightButHeld = await login("delivery@hardware.com", "delivery123");
  record("delivery", "the right password is refused while held",
    rightButHeld.status === 423 && /minute/.test(rightButHeld.body.error),
    `${rightButHeld.status} ${JSON.stringify(rightButHeld.body).slice(0, 120)}`);

  const heldRow = await call(admin, "GET", "/api/users/5");
  record("admin", "the directory shows when the hold ends",
    heldRow.status === 200 && typeof heldRow.body.held_until === "string",
    JSON.stringify(heldRow.body && heldRow.body.held_until));
  const heldTrail = await call(admin, "GET", "/api/audit-logs?actionType=SECURITY");
  record("admin", "the hold is on the trail as a SECURITY entry",
    Array.isArray(heldTrail.body) && heldTrail.body.some((row) => row.action === "ACCOUNT_HELD"),
    JSON.stringify((heldTrail.body || []).slice(0, 2)).slice(0, 160));

  const release = expect("admin", "POST reset-password releases the hold",
    await call(admin, "POST", "/api/users/5/reset-password", {}), [200]);
  const released = await login("delivery@hardware.com", release.body.password || "");
  record("delivery", "and the new password signs in straight away", released.ok, `got ${released.status}`);
  const releasedRow = await call(admin, "GET", "/api/users/5");
  record("admin", "the hold is gone from the directory",
    releasedRow.status === 200 && releasedRow.body.held_until === null &&
    Number(releasedRow.body.failed_attempts) === 0,
    JSON.stringify({ held: releasedRow.body.held_until, attempts: releasedRow.body.failed_attempts }));

  console.log("== PRIVATE FILES ==");
  for (const file of ["/backend/server.js", "/backend/mailer.js", "/backend/mail-password.txt",
                      "/Back-end/server.js", "/Back-end/mail-password.txt", "/Back-end/Connections/database.js",
                      "/connections/admin.js", "/connections/database.js",
                      "/database/1-RUN-FIRST-database.sql",
                      "/database/2-RUN-SECOND-stored-procedures.sql", "/database/0-READ-ME-FIRST.md"]) {
    const page = await fetch(BASE + file);
    record("anon", `${file} not downloadable`, page.status === 404, `got ${page.status}`);
  }
  for (const file of ["/Login.html", "/css/general-ui.css", "/modules/shared/format.js", "/connections/shared-connection.js",
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
