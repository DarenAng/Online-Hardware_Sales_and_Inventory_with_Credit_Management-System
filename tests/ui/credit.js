// Drives Credit Management on both the manager's and the cashier's screens.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3311";
const OUT = process.env.OUT ||
  require("path").join(__dirname, "..", "..", "shots", "ui",
                       require("path").basename(__filename, ".js"));

const results = [];
function check(name, passed, note) {
  results.push({ name, passed });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || !note ? "" : "  -- " + note}`);
}

async function signedInPage(context, role, fullName, staffId) {
  await context.addInitScript(([r, n, s]) => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: s, user_id: s, first_name: n.split(" ")[0], last_name: "User",
      full_name: n, email: r.toLowerCase() + "@hardware.com",
      role_name: r, must_change_password: false
    }));
  }, [role, fullName, staffId]);

  return context.newPage();
}

// only console lines this system caused: the font CDN and the favicon are noise
function isOurProblem(text) {
  return !/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(String(text));
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(bundled) ? { executablePath: bundled } : {});

  const problems = [];
  const watch = (page, who) => {
    page.on("console", (m) => { if (m.type() === "error") if (isOurProblem(m.text())) problems.push(`[${who}] console: ` + m.text()); });
    page.on("pageerror", (e) => problems.push(`[${who}] page error: ` + e.message));
    page.on("response", (r) => {
      if (r.status() >= 400 && isOurProblem(r.url())) problems.push(`[${who}] ` + r.status() + " " + r.url());
    });
  };

  // ======================================================== MANAGER
  const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const manager = await signedInPage(managerContext, "Manager", "Manager M. User", 2);
  watch(manager, "manager");

  const shot = (page, name) =>
    page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  await manager.goto(`${BASE}/manager.html`, { waitUntil: "domcontentloaded" });
  await manager.waitForTimeout(700);

  check("the menu carries a Credit section",
    await manager.locator("#credit-dropdown a").count() === 2);

  await manager.evaluate("showCredit()");
  await manager.waitForTimeout(300);
  check("the credit book starts closed",
    /not loaded/i.test(await manager.textContent("#credit-table tbody")));

  await manager.click("#panel-credit button:has-text('Load Data')");
  await manager.waitForTimeout(700);

  const creditRows = await manager.locator("#credit-table tbody tr:not(.row-filler)").count();
  check("credit accounts page ten at a time", creditRows === 10, `saw ${creditRows}`);
  check("standing is shown on every row",
    await manager.locator("#credit-table tbody .badge").count() >= creditRows);
  check("an account over its limit says so",
    (await manager.textContent("#credit-table")).includes("Over by"));
  await shot(manager, "01-credit-book");

  await manager.selectOption("#credit-standing", "Hold");
  await manager.waitForTimeout(400);
  const held = await manager.locator("#credit-table tbody tr:not(.row-filler)").count();
  check("the standing filter narrows the book",
    held > 0 && await manager.locator("#credit-table tbody .badge:text-is('On hold')").count() === held,
    `saw ${held}`);
  await manager.selectOption("#credit-standing", "all");
  await manager.waitForTimeout(400);

  await manager.selectOption("#credit-owing", "over");
  await manager.waitForTimeout(400);
  check("the balance filter finds accounts over their limit",
    (await manager.textContent("#credit-table")).includes("Over by"));
  await manager.selectOption("#credit-owing", "all");
  await manager.waitForTimeout(400);

  // ---------- one account ----------
  await manager.click("#credit-table tbody tr:first-child");
  await manager.waitForTimeout(600);
  check("a row opens the credit card",
    await manager.locator("#credit-modal.open").count() === 1);

  const facts = await manager.textContent("#credit-facts");
  check("the card shows the credit limit, the balance and the available balance",
    facts.includes("Credit Limit") && facts.includes("Balance") && facts.includes("Available Balance") &&
    !facts.includes("Owed"));
  check("it says how old the oldest debt is", facts.includes("Oldest Debt"));

  // the preview has to follow the figure being typed
  const owed = await manager.evaluate("Number(creditCustomer.current_credit)");
  await manager.fill("#credit-limit-input", String(owed + 5000));
  await manager.waitForTimeout(200);
  const preview = await manager.textContent("#credit-preview");
  check("the preview says what the customer can still take",
    /can take another/.test(preview), preview.slice(0, 120));
  await shot(manager, "02-credit-card");

  // a limit under what is owed is legitimate and has to be said out loud
  await manager.fill("#credit-limit-input", String(Math.max(owed - 1000, 0)));
  await manager.waitForTimeout(200);
  check("a limit under the balance is called out",
    /more than this limit|no further credit/i.test(await manager.textContent("#credit-preview")));
  await shot(manager, "03-credit-under-balance");

  // putting an account on hold is a stop, and wears the dangerous tone
  await manager.selectOption("#credit-standing-input", "Hold");
  await manager.waitForTimeout(200);
  check("a hold says nothing can be taken at all",
    /no new credit at all/i.test(await manager.textContent("#credit-preview")));

  await manager.fill("#credit-limit-input", String(owed + 5000));
  await manager.click("button[type=submit][form=credit-form]");
  await manager.waitForTimeout(500);
  check("putting an account on hold asks first",
    await manager.locator("#ask-modal.open #ask-ok.btn-danger").count() === 1);
  check("it says what a hold does",
    await manager.locator("#ask-detail li").count() === 3);
  await shot(manager, "04-hold-confirm");
  await manager.evaluate("closeAsk(false)");
  await manager.waitForTimeout(300);

  // ---------- purchases beside payments ----------
  await manager.click("#credit-tab-history");
  await manager.waitForTimeout(700);
  const heads = await manager.locator("#credit-history .history-head").allTextContents();
  check("purchases and payments are side by side",
    heads.length >= 2 &&
    heads.some((h) => h.includes("Purchase History")) &&
    heads.some((h) => h.includes("Credit & Payments")), heads.join(" / "));

  const columns = await manager.evaluate(
    "getComputedStyle(document.getElementById('credit-history')).gridTemplateColumns.split(' ').length");
  check("they really are two columns, not stacked", columns === 2, `${columns} column(s)`);
  check("each history table pages with Previous and Next rather than scrolling",
    (await manager.locator("#credit-history .paged-pager").count()) === 2 &&
    (await manager.locator("#credit-modal .modal-pager").count()) === 0);
  await manager.click("#paged-mgr-purchases .paged-pager button:has-text('Next')");
  await manager.waitForTimeout(200);
  check("Next turns the purchases table to its second page",
    /Page 2 of/.test(await manager.textContent("#paged-mgr-purchases .paged-pager")));
  await shot(manager, "05-history-split");

  await manager.evaluate("closeModal('credit-modal')");
  await manager.waitForTimeout(300);

  // ---------- extension requests ----------
  await manager.evaluate("showCreditRequests()");
  await manager.waitForTimeout(300);
  await manager.click("#panel-credit-requests button:has-text('Load Data')");
  await manager.waitForTimeout(700);

  const pending = await manager.locator("#requests-table tbody tr:not(.row-filler)").count();
  check("pending requests are what the screen opens on", pending >= 1, `saw ${pending}`);
  await shot(manager, "06-requests");

  await manager.click("#requests-table tbody tr:first-child");
  await manager.waitForTimeout(500);
  check("a request opens with both limits and the reason",
    (await manager.textContent("#decide-facts")).includes("Requested Limit") &&
    (await manager.textContent("#decide-facts")).includes("Current Credit Limit") &&
    (await manager.textContent("#decide-reason")).includes("Reason given"));
  check("a pending request offers both decisions",
    await manager.locator("#decide-actions button").count() === 3);
  await shot(manager, "07-decide");

  // declining without a reason is refused before it reaches the server
  await manager.fill("#decide-note", "");
  await manager.click("#decide-actions button:has-text('Decline')");
  await manager.waitForTimeout(500);
  check("declining with no reason is refused",
    await manager.locator("#decide-modal.open").count() === 1 &&
    await manager.locator("#ask-modal.open").count() === 0);

  // approving raises the limit in the same move
  const requested = await manager.evaluate("Number(creditRequest.requested_limit)");
  const customerId = await manager.evaluate("creditRequest.customer_id");

  await manager.click("#decide-actions button:has-text('Approve')");
  await manager.waitForTimeout(500);
  check("approving asks first",
    await manager.locator("#ask-modal.open").count() === 1);
  check("it says what approving does",
    await manager.locator("#ask-detail li").count() === 3);
  await shot(manager, "08-approve-confirm");

  await manager.click("#ask-ok");
  await manager.waitForTimeout(900);
  check("the request closes after the decision",
    await manager.locator("#decide-modal.open").count() === 0);

  const raised = await manager.evaluate(
    `fetch('/api/credit/customers/${customerId}').then((r) => r.json()).then((d) => d.credit.credit_limit)`);
  check("approving raised the limit in the same move",
    Number(raised) === requested, `limit is ${raised}, asked for ${requested}`);
  await shot(manager, "09-requests-after");

  await managerContext.close();

  // ======================================================== CASHIER
  const cashierContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cashier = await signedInPage(cashierContext, "Cashier", "Cashier C. User", 4);
  watch(cashier, "cashier");

  await cashier.goto(`${BASE}/cashier-dashboard.html`, { waitUntil: "domcontentloaded" });
  await cashier.waitForTimeout(800);

  check("the till has a Customers Record screen",
    await cashier.locator("a:has-text('Customers Record')").count() === 1);

  // ---------- the account, read before the sale ----------
  await cashier.evaluate("showRegister()");
  await cashier.waitForTimeout(400);
  await cashier.evaluate("loadCatalogAll()");
  await cashier.waitForTimeout(700);

  await cashier.evaluate("addToCart(1); addToCart(1); addToCart(2)");
  await cashier.waitForTimeout(300);
  check("items go into the cart",
    await cashier.locator("#cart-lines .cart-line").count() === 2);

  // the customer picker is a type-ahead; pickCustomer(id) is the same call the
  // suggestion list makes
  const directory = await cashier.evaluate("customerDirectory.length");
  check("the customer directory is loaded", directory > 1, `${directory} customers`);

  // pick a customer whose account is on hold, then one who is good
  const holdId = await cashier.evaluate(`
    fetch('/api/credit/customers?standing=Hold').then((r) => r.json())
      .then((rows) => rows.length ? rows[0].customer_id : null)`);
  const goodId = await cashier.evaluate(`
    fetch('/api/credit/customers?standing=Good').then((r) => r.json())
      .then((rows) => rows.length ? rows[0].customer_id : null)`);

  await cashier.evaluate(`pickCustomer(${goodId})`);
  await cashier.waitForTimeout(600);
  check("picking a customer shows their credit before the sale",
    await cashier.locator("#credit-strip").isVisible() &&
    (await cashier.textContent("#credit-strip")).includes("Available Balance"));
  await shot(cashier, "10-credit-strip");

  // ---------- the part payment ----------
  await cashier.selectOption("[name=paymentMethod]", "Credit");
  await cashier.waitForTimeout(400);
  check("choosing Credit swaps the tender box for a down payment box",
    await cashier.locator("#downpayment-field").isVisible() &&
    !(await cashier.locator("#tender-field").isVisible()));

  await cashier.click("button:has-text('Half')");
  await cashier.waitForTimeout(300);

  const split = await cashier.evaluate("JSON.stringify(cartTotals())");
  const totals = JSON.parse(split);
  check("half now, half on the book",
    Math.abs(totals.down - totals.due / 2) < 0.02 &&
    Math.abs(totals.onBook - (totals.due - totals.down)) < 0.02,
    split);

  const totalsPanel = await cashier.textContent("#cart-totals");
  check("the totals panel names both halves",
    totalsPanel.includes("Paid now") && totalsPanel.includes("On account"), totalsPanel);
  check("the verdict says what goes on the account",
    /goes on .* account/.test(await cashier.textContent("#credit-verdict")));
  check("the part-payment method is labelled Payment method",
    (await cashier.textContent("label[for=pay-down-method]")).trim() === "Payment method");
  check("part paid, the button says it takes part and charges the rest",
    (await cashier.textContent("#checkout-btn")).trim() === "Take Part Payment & Charge the Rest",
    await cashier.textContent("#checkout-btn"));
  await shot(cashier, "11-part-payment");

  await cashier.click("button:has-text('All of it')");
  await cashier.waitForTimeout(300);
  check("paying it all leaves nothing on the account",
    /Nothing goes on/.test(await cashier.textContent("#credit-verdict")));
  check("paid in full on a credit sale, the button says Complete Sale",
    (await cashier.textContent("#checkout-btn")).trim() === "Complete Sale");

  await cashier.click("button:has-text('Nothing')");
  await cashier.waitForTimeout(300);
  check("nothing paid now, the button says Charge to Account",
    (await cashier.textContent("#checkout-btn")).trim() === "Charge to Account");

  // a part payment by transfer shows where to send it and asks for its reference
  await cashier.click("button:has-text('Half')");
  await cashier.selectOption("[name=downPaymentMethod]", "Bank Transfer");
  await cashier.waitForTimeout(300);
  check("a transfer shows the shop's bank account at the till",
    await cashier.locator("#sale-bank-box").isVisible() &&
    (await cashier.textContent("#sale-bank-box")).includes("Account number"));
  check("a transfer asks for its reference",
    await cashier.locator("#sale-reference-field").isVisible() &&
    /required/i.test(await cashier.textContent("#sale-reference-field label")));
  await cashier.selectOption("[name=downPaymentMethod]", "Cash");
  await cashier.click("button:has-text('Nothing')");
  await cashier.waitForTimeout(300);
  check("cash hides the reference box again",
    !(await cashier.locator("#sale-reference-field").isVisible()));

  // an account on hold has to say so at the counter, not at the server
  await cashier.evaluate(`pickCustomer(${holdId})`);
  await cashier.waitForTimeout(700);
  check("an account on hold is refused on the screen",
    /on hold/i.test(await cashier.textContent("#credit-verdict")));
  check("the strip turns red for a hold",
    (await cashier.getAttribute("#credit-strip", "class")).includes("is-stop"));
  await shot(cashier, "12-on-hold");

  // ---------- the confirmation before it is booked ----------
  await cashier.evaluate(`pickCustomer(${goodId})`);
  await cashier.waitForTimeout(600);
  await cashier.click("button:has-text('25%')");
  await cashier.waitForTimeout(300);
  await cashier.click("#checkout-btn");
  await cashier.waitForTimeout(600);

  check("booking to an account asks first",
    await cashier.locator("#ask-modal.open").count() === 1);
  check("it says how much is taken and how much is booked",
    await cashier.locator("#ask-detail li").count() === 3);
  await shot(cashier, "13-book-confirm");
  await cashier.evaluate("closeAsk(false)");
  await cashier.waitForTimeout(300);

  // ---------- customers and credit ----------
  await cashier.evaluate("showCustomers()");
  await cashier.waitForTimeout(300);
  check("the customer list starts closed",
    /No customers loaded/i.test(await cashier.textContent("#customers-table tbody")) &&
    /Not loaded/i.test(await cashier.textContent("#customers-count")));

  await cashier.click("#panel-customers button:has-text('Load Data')");
  await cashier.waitForTimeout(700);
  // the till pages at CASHIER_ROWS_PER_PAGE, read from the module rather than copied
  const pageSize = await cashier.evaluate("CASHIER_ROWS_PER_PAGE");
  const shown = await cashier.locator("#customers-table tbody tr:not(.row-filler)").count();
  check("customers page at the till's own page size",
    shown === pageSize, `${shown} rows, page size is ${pageSize}`);

  await cashier.click("#customers-table tbody tr:first-child");
  await cashier.waitForTimeout(700);
  check("a customer opens with purchases beside payments",
    await cashier.locator("#customer-modal.open").count() === 1 &&
    await cashier.locator("#customer-history .history-column").count() === 2);
  await cashier.click("#customer-tab-history");
  await cashier.waitForTimeout(400);
  check("the till's copy pages the history the same way",
    (await cashier.locator("#customer-history .paged-pager").count()) === 2 &&
    (await cashier.locator("#customer-modal .modal-pager").count()) === 0);
  await shot(cashier, "14-customer-history");

  // ---------- asking for more room ----------
  await cashier.click("button:has-text('Ask for a Higher Limit')");
  await cashier.waitForTimeout(500);
  check("asking for a higher limit opens a question",
    await cashier.locator("#ask-modal.open").count() === 1);

  const current = await cashier.evaluate("Number(openCustomer.credit.credit_limit)");
  await cashier.fill("#ask-input", String(current - 1));
  await cashier.click("#ask-ok");
  await cashier.waitForTimeout(400);
  check("a lower limit is refused as a request",
    await cashier.locator("#ask-error.show").count() === 1);
  await shot(cashier, "15-ask-limit");

  await cashier.fill("#ask-input", String(current + 20000));
  await cashier.click("#ask-ok");
  await cashier.waitForTimeout(500);
  check("it then asks why",
    /A manager reading this later/.test(await cashier.textContent("#ask-text")));

  await cashier.fill("#ask-input", "Regular contractor, pays on the 15th.");
  await cashier.click("#ask-ok");
  await cashier.waitForTimeout(800);
  check("the request is sent and the card closes",
    await cashier.locator("#customer-modal.open").count() === 0);

  const nowPending = await cashier.evaluate(`
    fetch('/api/credit/requests?status=Pending').then((r) => r.json()).then((rows) => rows.length)`);
  check("the manager now has it waiting", Number(nowPending) >= 1, `${nowPending} pending`);
  await shot(cashier, "16-request-sent");

  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
