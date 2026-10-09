// Checks how money that is not cash is secured: the checkout button says what
// it will do, a cheque or a transfer cannot be rung up without its
// reference, a transfer shows the shop's bank account at the till and on the
// invoice, the administrator's bank account is required (all three boxes),
// confirming a purchase order tells the manager whether the supplier was
// emailed it, and GCash or Maya paid by QR code (through the offline
// simulation, never PayMongo): paid makes the sale, failed, expired and
// cancelled make none, the server refuses an unpaid, wrong-amount or used
// code, and the QR Payments screens count it all.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3311";
const OUT = process.env.OUT ||
  path.join(__dirname, "..", "..", "shots", "ui", path.basename(__filename, ".js"));

const results = [];
function check(name, passed, note) {
  results.push({ name, passed });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || !note ? "" : "  -- " + note}`);
}

function isOurProblem(text) {
  return !/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(String(text));
}

async function pageFor(browser, role, fullName, staffId, problems) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(([r, n, s]) => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: s, user_id: s, first_name: n.split(" ")[0], last_name: "User",
      full_name: n, email: "x@hardware.com", role_name: r, must_change_password: false
    }));
  }, [role, fullName, staffId]);
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`[${role}] page error: ` + e.message));
  page.on("console", (m) => { if (m.type() === "error" && isOurProblem(m.text())) problems.push(`[${role}] ` + m.text()); });
  return { context, page };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(fs.existsSync(bundled) ? { executablePath: bundled } : {});
  const problems = [];
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ======================================================== THE TILL
  const till = await pageFor(browser, "Cashier", "Cashier C. User", 4, problems);
  const cashier = till.page;
  await cashier.goto(`${BASE}/cashier-dashboard.html`, { waitUntil: "domcontentloaded" });
  await cashier.waitForTimeout(800);
  await cashier.evaluate("showRegister()");
  await cashier.evaluate("loadCatalogAll()");
  await cashier.waitForTimeout(700);

  const label = async () => (await cashier.textContent("#checkout-btn")).trim();
  const receipt = async () => cashier.textContent("#receipt-paper");
  const closeReceipt = () => cashier.evaluate("closeModal('receipt-modal')");
  // a warning card from the last press can sit over the button; it is read before this
  const pressCheckout = async () => {
    await cashier.evaluate(() => document.querySelectorAll(".toast-card").forEach((card) => card.remove()));
    await cashier.click("#checkout-btn");
  };

  // ---------- the button says what it will do ----------
  await cashier.evaluate("addToCart(1); addToCart(2)");
  await cashier.waitForTimeout(300);
  check("paid at the counter, the button says Complete Sale", (await label()) === "Complete Sale");

  await cashier.selectOption("[name=paymentMethod]", "COD");
  await cashier.waitForTimeout(200);
  check("cash on delivery, the button says Place COD Order", (await label()) === "Place COD Order");
  check("no reference is asked for cash on delivery",
    !(await cashier.locator("#sale-reference-field").isVisible()));

  // ---------- a cheque needs its number ----------
  await cashier.selectOption("[name=paymentMethod]", "Cheque");
  await cashier.waitForTimeout(200);
  check("a cheque asks for its number",
    await cashier.locator("#sale-reference-field").isVisible() &&
    /required/.test(await cashier.textContent("#sale-reference-hint")));
  const due = await cashier.evaluate("cartTotals().due");
  await cashier.fill("#pay-amount", String(due));
  await cashier.waitForTimeout(200);

  let posted = 0;
  const countSales = (request) => { if (request.method() === "POST" && /\/api\/sales$/.test(request.url())) posted += 1; };
  cashier.on("request", countSales);
  await pressCheckout();
  await cashier.waitForTimeout(500);
  check("a cheque with no number is refused on the screen, before anything is sent",
    posted === 0 && /needs its reference/.test(await cashier.textContent(".toast-deck")));

  await cashier.fill("#sale-reference", "CHQ 001234");
  await pressCheckout();
  await cashier.waitForTimeout(900);
  check("with its number the sale goes through", posted === 1);
  check("and the invoice prints the reference", /CHQ 001234/.test(await receipt()));
  check("a cheque sale prints no bank block", !/bank transfer/i.test(await receipt()));
  await closeReceipt();
  cashier.off("request", countSales);

  // ---------- an e-wallet's reference is optional ----------
  await cashier.evaluate("addToCart(1)");
  await cashier.selectOption("[name=paymentMethod]", "GCash");
  await cashier.waitForTimeout(200);
  check("an e-wallet's reference is optional",
    await cashier.locator("#sale-reference-field").isVisible() &&
    /optional/.test(await cashier.textContent("#sale-reference-hint")));
  check("and the cheque's number was not left in the box", (await cashier.inputValue("#sale-reference")) === "");

  // ---------- a transfer shows where to send it ----------
  await cashier.selectOption("[name=paymentMethod]", "Bank Transfer");
  await cashier.waitForTimeout(400);
  const transferDue = await cashier.evaluate("cartTotals().due");
  const box = await cashier.textContent("#sale-bank-box");
  check("choosing Bank Transfer shows the shop's account",
    await cashier.locator("#sale-bank-box").isVisible() &&
    box.includes("BDO Unibank") && box.includes("0012 3456 7890"));
  check("with the amount to send",
    box.includes(await cashier.evaluate((n) => peso(n), transferDue)), box);
  await shot(cashier, "01-transfer-at-the-till");

  await cashier.fill("#pay-amount", String(transferDue));
  await cashier.fill("#sale-reference", "FT2609230412");
  await pressCheckout();
  await cashier.waitForTimeout(900);
  const paidByTransfer = await receipt();
  check("an invoice paid by transfer prints the account it went to",
    /Paid by bank transfer/i.test(paidByTransfer) && paidByTransfer.includes("0012 3456 7890"));
  await shot(cashier, "02-invoice-paid-by-transfer");
  await closeReceipt();

  // ---------- a balance left on account says how to pay it ----------
  const goodId = await cashier.evaluate(`
    fetch('/api/credit/customers?standing=Good').then((r) => r.json())
      .then((rows) => rows.length ? rows[0].customer_id : null)`);
  await cashier.evaluate("addToCart(1)");
  await cashier.evaluate(`pickCustomer(${goodId})`);
  await cashier.waitForTimeout(600);
  await cashier.selectOption("[name=paymentMethod]", "Credit");
  await cashier.click("button:has-text('Half')");
  await cashier.waitForTimeout(300);
  await pressCheckout();
  await cashier.waitForTimeout(500);
  await cashier.evaluate("closeAsk(true)");
  await cashier.waitForTimeout(900);
  const onAccount = await receipt();
  check("an invoice that leaves a balance prints the account to pay it into",
    /Pay the balance by bank transfer/i.test(onAccount) && onAccount.includes("0012 3456 7890"));
  check("and asks for the invoice number as the transfer reference",
    /Quote OR-\d{6} as the transfer reference/.test(onAccount));
  await shot(cashier, "03-invoice-balance");
  await closeReceipt();

  // ---------- Take a Payment by transfer, from the customer's card ----------
  await cashier.evaluate("showCustomers()");
  await cashier.evaluate((id) => openCustomerCredit(id), goodId);
  await cashier.waitForTimeout(700);
  check("the customer's card lists the sale still owing, with no Pay button on the row",
    await cashier.evaluate("customerOpenSales.length > 0") &&
    (await cashier.locator("#customer-unpaid button:has-text('Pay')").count()) === 0 &&
    await cashier.locator("#customer-tab-unpaid").isVisible());
  await cashier.click("#customer-tab-unpaid");
  await cashier.waitForTimeout(300);
  await shot(cashier, "04a-customer-unpaid-sales");
  await cashier.click("#customer-unpaid tbody tr:not(.row-filler)");
  await cashier.waitForTimeout(500);
  check("the Take a Payment card is labelled Payment method",
    (await cashier.textContent("label[for=pay-debt-method]")).trim() === "Payment method");
  await cashier.selectOption("#pay-debt-method", "Bank Transfer");
  await cashier.waitForTimeout(300);
  check("choosing Bank Transfer on the card shows the account",
    await cashier.locator("#payment-bank-box").isVisible() &&
    (await cashier.textContent("#payment-bank-box")).includes("0012 3456 7890"));
  await shot(cashier, "04-take-a-payment-transfer");
  await cashier.evaluate("closePaymentForm()");

  // ======================================================== PAY BY QR
  // The stub's provider is the offline simulation: its pay page, opened from
  // the code's address, stands in for the customer's phone. Nothing reaches PayMongo.
  const phone = await browser.newPage();
  const pressOnPhone = async (button) => {
    const link = await cashier.getAttribute("#qr-link", "href");
    await phone.goto(link, { waitUntil: "domcontentloaded" });
    await phone.click(`button:has-text('${button}')`);
    await phone.waitForLoadState("domcontentloaded");
  };
  const qrStatus = async () => (await cashier.textContent("#qr-status")).trim();
  const qrOpen = () => cashier.evaluate("document.getElementById('qr-modal').classList.contains('open')");
  const freshSale = async (method) => {
    await cashier.evaluate(() => document.querySelectorAll(".toast-card").forEach((card) => card.remove()));
    // closing the payment form brings the customer's card back over the till
    await cashier.evaluate("closeModal('customer-modal')");
    await cashier.evaluate("showRegister(); addToCart(1)");
    await cashier.selectOption("[name=paymentMethod]", method);
    await cashier.waitForTimeout(250);
  };

  let qrSales = 0;
  const countQrSales = (request) => {
    if (request.method() === "POST" && /\/api\/sales$/.test(request.url())) qrSales += 1;
  };
  cashier.on("request", countQrSales);

  // ---------- paid -> the sale is saved and linked ----------
  await freshSale("GCash");
  check("GCash shows a Pay by QR button beside Complete Sale",
    await cashier.locator("#qr-pay-btn").isVisible() && (await cashier.textContent("#qr-pay-btn")).trim() === "Pay by QR");
  const qrDue = await cashier.evaluate("cartTotals().due");
  await cashier.click("#qr-pay-btn");
  await cashier.waitForTimeout(800);
  check("the QR card opens with the amount, the wallet and a 10-minute countdown",
    await qrOpen() && (await cashier.textContent("#qr-amount")).includes(await cashier.evaluate((n) => peso(n), qrDue)) &&
    /GCash/.test(await cashier.textContent("#qr-title")) && /^(10:00|9:5\d)$/.test(await cashier.textContent("#qr-countdown")));
  check("it says SIMULATION, and shows the pay page's address as small text",
    (await cashier.textContent("#qr-badge")) === "SIMULATION" && await cashier.locator("#qr-badge").isVisible() &&
    /\/pay-sim\//.test(await cashier.textContent("#qr-link")));
  check("the code is a picture", /^data:image\/png/.test(await cashier.getAttribute("#qr-image", "src")));
  await shot(cashier, "07-qr-waiting");
  check("while it waits, no sale has been sent", qrSales === 0);

  await pressOnPhone("Pay");
  await cashier.waitForTimeout(4200);
  const qrInvoice = await receipt();
  check("once paid the card closes by itself and the invoice opens",
    !(await qrOpen()) && await cashier.evaluate("document.getElementById('receipt-modal').classList.contains('open')"));
  check("one sale was sent, carrying the payment, and the invoice prints its reference",
    qrSales === 1 && /pay_sim_[0-9a-f]+/.test(qrInvoice));
  check("the till is cleared for the next customer", (await cashier.evaluate("cart.length")) === 0);
  await shot(cashier, "08-qr-paid-invoice");
  await closeReceipt();

  // ---------- failed -> no sale, the reason, New QR or another method ----------
  await freshSale("PayMaya");
  await cashier.click("#qr-pay-btn");
  await cashier.waitForTimeout(800);
  check("Maya is named on the card", /Maya/.test(await cashier.textContent("#qr-title")));
  await pressOnPhone("Fail");
  await cashier.waitForTimeout(4200);
  check("a failed payment keeps the card open and says why",
    await qrOpen() && /payment failed/i.test(await qrStatus()) && /Nothing was recorded/.test(await qrStatus()));
  check("it offers New QR and Choose another method, and no Cancel",
    await cashier.locator("#qr-new-btn").isVisible() && await cashier.locator("#qr-other-btn").isVisible() &&
    !(await cashier.locator("#qr-cancel-btn").isVisible()));
  await shot(cashier, "09-qr-failed");
  await cashier.click("#qr-other-btn");
  await cashier.waitForTimeout(300);
  check("Choose another method closes the card, and no sale was sent", !(await qrOpen()) && qrSales === 1);

  // ---------- expired -> no sale; New QR makes another ----------
  await cashier.click("#qr-pay-btn");
  await cashier.waitForTimeout(800);
  const expiring = await cashier.evaluate("qrSession.id");
  const oldLink = await cashier.getAttribute("#qr-link", "href");
  await cashier.evaluate((id) => fetch(`/api/test/qr-payments/${id}/expire`, { method: "POST" }), expiring);
  await cashier.waitForTimeout(3600);
  check("a code not paid in time says it expired", await qrOpen() && /expired/i.test(await qrStatus()));
  await cashier.click("#qr-new-btn");
  await cashier.waitForTimeout(900);
  check("New QR makes a fresh code that is waiting again",
    (await cashier.getAttribute("#qr-link", "href")) !== oldLink && /Waiting/.test(await qrStatus()) &&
    await cashier.locator("#qr-cancel-btn").isVisible());

  // ---------- cancelled -> no sale ----------
  await cashier.click("#qr-cancel-btn");
  await cashier.waitForTimeout(900);
  check("Cancel closes the card and nothing is sent", !(await qrOpen()) && qrSales === 1);

  // ---------- the order changes while a code is up ----------
  await cashier.click("#qr-pay-btn");
  await cashier.waitForTimeout(800);
  const beforeChange = await cashier.evaluate("qrSession.id");
  await cashier.evaluate("cart[0].quantity += 1; renderCart()");
  await cashier.waitForTimeout(1200);
  const changed = await cashier.evaluate((id) => fetch(`/api/qr-payments/${id}`).then((r) => r.json()), beforeChange);
  check("changing the order while a code is up cancels that code",
    !(await qrOpen()) && changed.status === "cancelled" && /amount changed/.test(await cashier.textContent(".toast-deck")));
  check("and no sale was sent for it", qrSales === 1);
  await cashier.evaluate("cart = []; renderCart()");
  cashier.off("request", countQrSales);

  // ---------- the server refuses what is not paid, not this amount, or already used ----------
  const refusals = await cashier.evaluate(async () => {
    const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const line = [{ product_id: 1, quantity: 1, unit: null }];
    const price = (await fetch("/api/inventory/products").then((r) => r.json())).find((p) => p.product_id === 1).price;
    const sale = (qrPaymentId, amountPaid, extra) => post("/api/sales", Object.assign({
      paymentMethod: "GCash", amountPaid, items: line, qrPaymentId }, extra || {}));
    const pay = (made, result) => fetch(new URL(made.payUrl).pathname, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "result=" + result });

    const made = (await post("/api/qr-payments", { amount: price, wallet: "GCash", purpose: "sale" })).body;
    const unpaid = await sale(made.id, price);
    await pay(made, "paid");
    const wrong = await sale(made.id, price + 5);
    const first = await sale(made.id, price);
    const reused = await sale(made.id, price);

    const stranded = (await post("/api/qr-payments", { amount: price * 9999, wallet: "GCash", purpose: "sale" })).body;
    await pay(stranded, "paid");
    const soldOut = await sale(stranded.id, price * 9999, { items: [{ product_id: 1, quantity: 9999, unit: null }] });
    const strandedRow = await fetch(`/api/qr-payments/${stranded.id}`).then((r) => r.json());
    return { unpaid, wrong, first, reused, soldOut, strandedRow };
  });
  check("the server refuses a sale on an unpaid code", refusals.unpaid.body.code === "QR_NOT_PAID");
  check("the server refuses a different amount", refusals.wrong.body.code === "QR_AMOUNT");
  check("the paid code makes one sale", refusals.first.status === 200);
  check("the server refuses the same code a second time", refusals.reused.body.code === "QR_USED");
  check("a sale refused after the money came in leaves the code paid with a refund note",
    refusals.soldOut.status === 409 && refusals.strandedRow.status === "paid" &&
    /paid but sale not saved/.test(refusals.strandedRow.errorMessage || ""));

  // ---------- Take a Payment by QR, from the customer's card ----------
  await cashier.evaluate("showCustomers()");
  await cashier.evaluate((id) => openCustomerCredit(id), goodId);
  await cashier.waitForTimeout(700);
  await cashier.click("#customer-tab-unpaid");
  await cashier.waitForTimeout(300);
  await cashier.click("#customer-unpaid tbody tr:not(.row-filler)");
  await cashier.waitForTimeout(500);
  await cashier.fill("#pay-debt-amount", "50");
  await cashier.selectOption("#pay-debt-method", "GCash");
  await cashier.waitForTimeout(300);
  check("Take a Payment by GCash offers Pay by QR", await cashier.locator("#payment-qr-btn").isVisible());
  await cashier.click("#payment-qr-btn");
  await cashier.waitForTimeout(800);
  check("the card is for the payment typed, on that sale",
    (await cashier.textContent("#qr-amount")).includes(await cashier.evaluate(() => peso(50))) &&
    /Payment on OR-/.test(await cashier.textContent("#qr-sub")));
  await pressOnPhone("Pay");
  await cashier.waitForTimeout(4200);
  check("once paid, the payment is recorded", /Payment recorded|taken from/.test(await cashier.textContent(".toast-deck")));
  await phone.close();
  await cashier.evaluate("closeModal('customer-modal')");

  // ---------- the cashier's QR Payments screen ----------
  await cashier.evaluate(() => document.querySelectorAll(".toast-card").forEach((card) => card.remove()));
  await cashier.evaluate("showQrPayments()");
  await cashier.click("#panel-qrpayments button:has-text('Load Data')");
  await cashier.waitForTimeout(800);
  const listed = await cashier.evaluate(async () => {
    const answer = await fetch("/api/qr-payments").then((r) => r.json());
    const tiles = {};
    document.querySelectorAll("#cqr-kpis .kpi-card").forEach((card) => {
      tiles[card.querySelector(".kpi-label").textContent] = card.querySelector(".kpi-value").textContent;
    });
    const count = (status) => answer.rows.filter((r) => r.status === status).length;
    return { tiles, rows: answer.rows.length, paid: count("paid"), failed: count("failed"),
             expired: count("expired"), cancelled: count("cancelled"), pending: count("pending"),
             shown: document.querySelectorAll("#cqr-table tbody tr.row-clickable").length };
  });
  const finishedQr = listed.rows - listed.pending;
  const expectedRate = Math.round((listed.paid / finishedQr) * 1000) / 10 + "%";
  check("the tiles count every attempt and every ending",
    listed.tiles.Attempts === String(listed.rows) && listed.tiles.Paid === String(listed.paid) &&
    listed.tiles.Failed === String(listed.failed) && listed.tiles.Expired === String(listed.expired) &&
    listed.tiles.Cancelled === String(listed.cancelled), JSON.stringify(listed));
  check(`the success rate is paid out of finished attempts (${expectedRate})`,
    listed.tiles["Success Rate"] === expectedRate, listed.tiles["Success Rate"]);
  check("the list has paid, failed, expired and cancelled rows",
    listed.paid > 0 && listed.failed > 0 && listed.expired > 0 && listed.cancelled > 0 && listed.shown > 0);
  await cashier.selectOption("#cqr-status", "failed");
  await cashier.waitForTimeout(300);
  check("the status filter narrows the table",
    await cashier.evaluate(() => Array.from(document.querySelectorAll("#cqr-table tbody tr.row-clickable"))
      .every((row) => /Failed/.test(row.textContent))));
  await cashier.selectOption("#cqr-status", "paid");
  await cashier.waitForTimeout(300);
  await shot(cashier, "10-qr-payments-list");
  await cashier.evaluate(() => {
    const row = Array.from(document.querySelectorAll("#cqr-table tbody tr.row-clickable"))
      .find((tr) => /OR-\d{6}/.test(tr.textContent));
    if (row) row.click();
  });
  await cashier.waitForTimeout(800);
  check("a row that paid for a sale opens that sale's invoice",
    await cashier.evaluate("document.getElementById('receipt-modal').classList.contains('open')"));
  await closeReceipt();

  await till.context.close();

  // ======================================================== QR PAYMENTS, THE MANAGER'S
  {
    const qrMgr = await pageFor(browser, "Manager", "Manager M. User", 2, problems);
    const manager = qrMgr.page;
    await manager.goto(`${BASE}/manager.html`, { waitUntil: "domcontentloaded" });
    await manager.waitForTimeout(900);
    // ---------- the manager's QR Payments screen: everyone's ----------
    await manager.evaluate("showQrPayments()");
    await manager.click("#panel-qr-payments button:has-text('Load Data')");
    await manager.waitForTimeout(800);
    const managerQr = await manager.evaluate(() => ({
      rows: document.querySelectorAll("#mqr-table tbody tr.row-clickable").length,
      attempts: (Array.from(document.querySelectorAll("#mqr-kpis .kpi-card"))
        .find((card) => /Attempts/.test(card.textContent)) || {}).textContent || "",
      people: Array.from(document.querySelectorAll("#mqr-staff option")).map((o) => o.textContent),
      badge: document.getElementById("mqr-badge").textContent
    }));
    check("the manager's QR Payments lists the cashier's attempts, with a Cashier filter and the SIMULATION badge",
      managerQr.rows > 0 && managerQr.people.includes("Cashier C. User") && managerQr.badge === "SIMULATION",
      JSON.stringify(managerQr));
    await shot(manager, "11-manager-qr-payments");
    await manager.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#mqr-table tbody tr.row-clickable"))
        .find((tr) => /OR-\d{6}/.test(tr.textContent));
      if (row) row.click();
    });
    await manager.waitForTimeout(800);
    await manager.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("#detail-modal button"))
        .find((b) => /^QR Payment/.test(b.textContent.trim()));
      if (tab) tab.click();
    });
    await manager.waitForTimeout(300);
    check("a paid row opens the sale, whose detail shows its QR payment and reference",
      /Sale #\d+/.test(await manager.textContent("#detail-modal")) &&
      /pay_sim_[0-9a-f]+/.test(await manager.textContent("#detail-modal .modal-body")));
    await manager.evaluate("closeModal('detail-modal')");
    await qrMgr.context.close();
  }

  // ======================================================== RECEIPT MAINTENANCE
  const admin = await pageFor(browser, "System Administrator", "Admin S. User", 1, problems);
  await admin.page.goto(`${BASE}/system.html`, { waitUntil: "domcontentloaded" });
  await admin.page.waitForTimeout(800);
  await admin.page.evaluate("showStoreSettings()");
  await admin.page.waitForTimeout(600);
  check("Receipt Maintenance has the bank transfer details",
    await admin.page.locator("#store-bank").isVisible() &&
    (await admin.page.inputValue("#store-bank-account-number")) === "0012 3456 7890");

  let saved = 0;
  admin.page.on("request", (request) => { if (request.method() === "PUT" && /store-settings/.test(request.url())) saved += 1; });
  await admin.page.fill("#store-bank-account-name", "");
  await admin.page.waitForTimeout(200);
  await admin.page.click("#store-save-btn");
  await admin.page.waitForTimeout(400);
  check("an empty bank box is refused on the screen",
    saved === 0 && /required/.test(await admin.page.textContent("#store-verdict")));
  await shot(admin.page, "05-bank-half-filled");

  for (const id of ["#store-bank-name", "#store-bank-account-number"]) await admin.page.fill(id, "");
  await admin.page.click("#store-save-btn");
  await admin.page.waitForTimeout(400);
  check("all three empty is refused too: the bank details are required",
    saved === 0 && /required/.test(await admin.page.textContent("#store-verdict")));

  // fill the account back in, so the suites after this one find it where it was
  await admin.page.fill("#store-bank-name", "BDO Unibank");
  await admin.page.fill("#store-bank-account-name", "Stub Hardware & Supply");
  await admin.page.fill("#store-bank-account-number", "0012 3456 7890");
  await admin.page.click("#store-save-btn");
  await admin.page.waitForTimeout(600);
  check("the account the store had is still the one on file",
    (await admin.page.inputValue("#store-bank-account-number")) === "0012 3456 7890");
  await admin.context.close();

  // ======================================================== PURCHASE ORDERS
  const mgr = await pageFor(browser, "Manager", "Manager M. User", 2, problems);
  const manager = mgr.page;
  await manager.goto(`${BASE}/manager.html`, { waitUntil: "domcontentloaded" });
  await manager.waitForTimeout(900);
  await manager.evaluate("showPurchasing()");
  await manager.click("#panel-po-history button:has-text('Load Data')");
  await manager.waitForTimeout(700);

  // an order still waiting whose supplier has an address, and one whose supplier has none;
  // picked from the list because an earlier suite may have decided some already
  const [withEmail, withoutEmail] = await manager.evaluate(() => {
    const rows = purchaseOrderPanel().rows.filter((o) => o.status === "For Approval");
    const pick = (hasEmail) => (rows.find((o) => Boolean(o.supplier_email) === hasEmail) || {}).po_id || null;
    return [pick(true), pick(false)];
  });
  check("there are waiting orders of both kinds to confirm", withEmail !== null && withoutEmail !== null,
    `${withEmail} / ${withoutEmail}`);

  await manager.evaluate((id) => { decidePurchaseOrder(id, true); }, withEmail);   // not awaited: it waits on the dialog
  await manager.waitForTimeout(300);
  check("the confirm dialog says the order is emailed",
    /emailed to the supplier now/.test(await manager.textContent("#ask-text")) &&
    /@[a-z-]+\.test/.test(await manager.textContent("#ask-detail")));
  await manager.evaluate("closeAsk(true)");
  await manager.waitForTimeout(700);
  check("once confirmed the manager is told it was emailed",
    /was emailed to .+ at .+@/.test(await manager.textContent(".toast-deck")));

  await manager.evaluate((id) => { decidePurchaseOrder(id, true); }, withoutEmail);   // not awaited: it waits on the dialog
  await manager.waitForTimeout(300);
  check("with no address on file the dialog says to print it and send it",
    /no email address on file/.test(await manager.textContent("#ask-detail")));
  await manager.evaluate("closeAsk(true)");
  await manager.waitForTimeout(700);
  check("once confirmed the manager is told to send it themselves",
    /Send the order yourself/.test(await manager.textContent("#ask-title")) &&
    /Print the order/.test(await manager.textContent("#ask-detail")));
  await shot(manager, "06-po-not-emailed");
  await manager.evaluate("closeAsk(true)");
  await mgr.context.close();

  await browser.close();

  console.log("\n--- console problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
