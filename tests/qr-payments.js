// QR payments against the real server and database, with the simulated
// provider so nothing ever reaches PayMongo. Start the server with
//     PAYMENT_PROVIDER=sim QR_PAYMENT_MINUTES=0.1
// (a code lasts six seconds, so one can be watched expire), then
//     BASE=http://localhost:3000 node tests/qr-payments.js
// run-all.sh does both.
//
// Paid -> the sale is saved and linked; failed, expired and cancelled -> no
// sale and the row keeps its status; the server refuses an unpaid, a
// wrong-amount, a wrong-wallet and an already-used payment; a sale that fails
// after the money came in leaves the row paid with a refund note; the counts
// and the success rate add up.
const BASE = process.env.BASE || "http://localhost:3000";

const results = [];
function check(name, passed, note) {
  results.push({ name, passed });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || note === undefined ? "" : "  -- " + note}`);
}

async function login(email, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const sid = /sid=([^;]+)/.exec(response.headers.get("set-cookie") || "");
  return sid ? `sid=${sid[1]}` : null;
}

async function call(cookie, method, path, payload) {
  const response = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = text; }
  return { status: response.status, body };
}

// the customer's phone on the simulated page: Pay or Fail
async function pressOnPhone(payUrl, result) {
  const path = new URL(payUrl).pathname;
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "result=" + result,
    redirect: "manual"
  });
  return response.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async function main() {
  const cashier = await login("cashier@hardware.com", "cashier123");
  const manager = await login("manager@hardware.com", "manager123");
  const clerk = await login("clerk@hardware.com", "clerk123");
  check("cashier, manager and clerk can sign in", Boolean(cashier && manager && clerk));

  // one product in stock, sold one at a time, so a sale's total is its price
  const products = (await call(cashier, "GET", "/api/inventory/products")).body;
  const product = products.find((p) => Number(p.quantity_in_stock) >= 5 && Number(p.price) >= 20);
  const price = Number(product.price);
  const oneOf = [{ product_id: product.product_id, quantity: 1, unit: null }];
  const saleBody = (extra) => Object.assign({
    customerId: null, walkInName: null, discount: 0, amountPaid: price,
    paymentMethod: "GCash", downPaymentMethod: "Cash", referenceNo: null, items: oneOf
  }, extra);
  const salesNow = async () => (await call(manager, "GET", "/api/sales")).body.length;

  const seen = {};   // id -> the status it ended on, for the counts at the end
  async function makeQr(cookie, amount, wallet, extra) {
    const made = await call(cookie, "POST", "/api/qr-payments",
      Object.assign({ amount, wallet: wallet || "GCash", purpose: "sale" }, extra || {}));
    if (made.status === 201) seen[made.body.id] = { status: "pending", cookie };
    return made;
  }
  async function look(id) {
    const state = await call(seen[id] ? seen[id].cookie : manager, "GET", `/api/qr-payments/${id}`);
    if (state.status === 200 && seen[id]) seen[id].status = state.body.status;
    return state;
  }

  // ---------- a code is made ----------
  const first = await makeQr(cashier, price);
  check("a cashier makes a QR code (201)", first.status === 201, JSON.stringify(first.body));
  check("it is a picture of the pay page's address",
    /^data:image\/png;base64,/.test(first.body.qrImage) && /\/pay-sim\/[A-Za-z0-9_-]+$/.test(first.body.payUrl));
  check("the simulation says so: badge SIMULATION, mode test",
    first.body.badge === "SIMULATION" && first.body.mode === "test");
  check("it counts down from the server's clock", first.body.secondsLeft > 0 && first.body.secondsLeft <= 6);

  const page = await fetch(first.body.payUrl.replace(/^https?:\/\/[^/]+/, BASE));
  const pageText = await page.text();
  check("the phone's page opens without signing in, says SIMULATION, and names no real provider",
    page.status === 200 && /SIMULATION/.test(pageText) && !/paymongo|gcash\.com|maya\.ph/i.test(pageText));

  check("waiting, it reads pending", (await look(first.body.id)).body.status === "pending");

  // ---------- the server never takes the browser's word ----------
  let before = await salesNow();
  const unpaid = await call(cashier, "POST", "/api/sales", saleBody({ qrPaymentId: first.body.id }));
  check("a sale on an unpaid code is refused (409 QR_NOT_PAID)",
    unpaid.status === 409 && unpaid.body.code === "QR_NOT_PAID", JSON.stringify(unpaid.body));
  check("and no sale was saved", (await salesNow()) === before);

  check("the customer presses Pay on the phone", (await pressOnPhone(first.body.payUrl, "paid")) === 303);
  const paid = await look(first.body.id);
  check("the code reads paid, with the provider's payment number",
    paid.body.status === "paid" && /^pay_sim_/.test(paid.body.reference || ""), JSON.stringify(paid.body));

  const wrongAmount = await call(cashier, "POST", "/api/sales",
    saleBody({ amountPaid: price + 1, qrPaymentId: first.body.id }));
  check("a different amount is refused (409 QR_AMOUNT)",
    wrongAmount.status === 409 && wrongAmount.body.code === "QR_AMOUNT", JSON.stringify(wrongAmount.body));

  const wrongWallet = await call(cashier, "POST", "/api/sales",
    saleBody({ paymentMethod: "PayMaya", qrPaymentId: first.body.id }));
  check("a different wallet is refused (409 QR_WALLET)",
    wrongWallet.status === 409 && wrongWallet.body.code === "QR_WALLET", JSON.stringify(wrongWallet.body));

  const cashSale = await call(cashier, "POST", "/api/sales",
    saleBody({ paymentMethod: "Cash", qrPaymentId: first.body.id }));
  check("a QR payment cannot pay a cash sale (400)", cashSale.status === 400);

  // ---------- paid -> the sale is saved and linked ----------
  before = await salesNow();
  const sold = await call(cashier, "POST", "/api/sales", saleBody({ qrPaymentId: first.body.id }));
  check("with the code paid, the sale goes through", sold.status === 200 && sold.body.saleId, JSON.stringify(sold.body));
  check("one sale was saved", (await salesNow()) === before + 1);
  const detail = await call(cashier, "GET", `/api/sales/${sold.body.saleId}`);
  check("the sale's reference is the provider's payment number",
    detail.body.sale.reference_no === paid.body.reference, detail.body.sale.reference_no);
  check("the sale detail lists its QR payment as paid",
    Array.isArray(detail.body.qrPayments) && detail.body.qrPayments.length === 1 &&
    detail.body.qrPayments[0].status === "paid");
  check("the code now names the sale", (await look(first.body.id)).body.saleId === sold.body.saleId);

  before = await salesNow();
  const again = await call(cashier, "POST", "/api/sales", saleBody({ qrPaymentId: first.body.id }));
  check("using it a second time is refused (409 QR_USED)",
    again.status === 409 && again.body.code === "QR_USED", JSON.stringify(again.body));
  check("and no second sale was saved", (await salesNow()) === before);

  // ---------- failed -> no sale, the row stays failed ----------
  const failing = await makeQr(cashier, price, "PayMaya");
  await pressOnPhone(failing.body.payUrl, "failed");
  const failed = await look(failing.body.id);
  check("the customer presses Fail: the code reads failed, with a reason",
    failed.body.status === "failed" && Boolean(failed.body.errorMessage), JSON.stringify(failed.body));
  before = await salesNow();
  const onFailed = await call(cashier, "POST", "/api/sales",
    saleBody({ paymentMethod: "PayMaya", qrPaymentId: failing.body.id }));
  check("a sale on a failed code is refused, and none is saved",
    onFailed.status === 409 && (await salesNow()) === before);
  check("the failed row keeps its status", (await look(failing.body.id)).body.status === "failed");

  // ---------- cancelled -> no sale ----------
  const giveUp = await makeQr(cashier, price);
  const cancelled = await call(cashier, "POST", `/api/qr-payments/${giveUp.body.id}/cancel`);
  check("the cashier cancels a waiting code", cancelled.status === 200 && cancelled.body.status === "cancelled",
    JSON.stringify(cancelled.body));
  seen[giveUp.body.id].status = "cancelled";
  await pressOnPhone(giveUp.body.payUrl, "paid");
  check("a cancelled code can no longer be paid on the phone", (await look(giveUp.body.id)).body.status === "cancelled");
  const onCancelled = await call(cashier, "POST", "/api/sales", saleBody({ qrPaymentId: giveUp.body.id }));
  check("a sale on a cancelled code is refused", onCancelled.status === 409);

  // ---------- expired -> no sale ----------
  const late = await makeQr(cashier, price);
  await sleep(7000);
  const expired = await look(late.body.id);
  check("a code not paid in time reads expired", expired.body.status === "expired", JSON.stringify(expired.body));
  await pressOnPhone(late.body.payUrl, "paid");
  check("and paying it afterwards changes nothing", (await look(late.body.id)).body.status === "expired");
  const onExpired = await call(cashier, "POST", "/api/sales", saleBody({ qrPaymentId: late.body.id }));
  check("a sale on an expired code is refused", onExpired.status === 409);

  // ---------- paid, then the sale cannot be saved ----------
  const stranded = await makeQr(cashier, price * 100000);
  await pressOnPhone(stranded.body.payUrl, "paid");
  await look(stranded.body.id);
  const tooMany = await call(cashier, "POST", "/api/sales", saleBody({
    amountPaid: price * 100000, qrPaymentId: stranded.body.id,
    items: [{ product_id: product.product_id, quantity: 100000, unit: null }]
  }));
  const strandedRow = await look(stranded.body.id);
  check("a sale refused after the money came in is not saved", tooMany.status !== 200, JSON.stringify(tooMany.body));
  check("the row stays paid and says a refund is needed",
    strandedRow.body.status === "paid" && /paid but sale not saved/.test(strandedRow.body.errorMessage || "") &&
    strandedRow.body.saleId === null, JSON.stringify(strandedRow.body));

  // ---------- a payment on a balance ----------
  const open = (await call(cashier, "GET", "/api/credit/open-sales")).body
    .find((s) => Number(s.balance_due) >= 50);
  const tooMuch = await call(cashier, "POST", "/api/qr-payments",
    { amount: Number(open.balance_due) + 100, wallet: "GCash", purpose: "credit_payment", saleId: open.sale_id });
  check("a code for more than is owed is refused before anything is made", tooMuch.status === 400);
  const towards = await makeQr(cashier, 50, "GCash", { purpose: "credit_payment", saleId: open.sale_id });
  await pressOnPhone(towards.body.payUrl, "paid");
  await look(towards.body.id);
  const took = await call(cashier, "POST", `/api/sales/${open.sale_id}/payment`,
    { amount: 50, paymentMethod: "GCash", referenceNo: null, qrPaymentId: towards.body.id });
  check("a payment on a balance by QR is recorded, with the provider's reference",
    took.status === 200 && /^pay_sim_/.test(took.body.reference || ""), JSON.stringify(took.body));
  const tookAgain = await call(cashier, "POST", `/api/sales/${open.sale_id}/payment`,
    { amount: 50, paymentMethod: "GCash", referenceNo: null, qrPaymentId: towards.body.id });
  check("and the same code cannot pay it twice (QR_USED)", tookAgain.body.code === "QR_USED");

  // ---------- who may see what ----------
  const managers = await makeQr(manager, price);
  check("the manager can make a code too", managers.status === 201);
  const notMine = await call(cashier, "GET", `/api/qr-payments/${managers.body.id}`);
  check("a cashier cannot open another person's code", notMine.status === 404);
  const clerkTry = await call(clerk, "POST", "/api/qr-payments", { amount: 50, wallet: "GCash", purpose: "sale" });
  check("an inventory clerk cannot make one (403)", clerkTry.status === 403);
  await call(manager, "POST", `/api/qr-payments/${managers.body.id}/cancel`);
  seen[managers.body.id].status = "cancelled";

  // ---------- the counts and the success rate ----------
  const everyone = await call(manager, "GET", "/api/qr-payments");
  const expected = { attempts: 0, pending: 0, paid: 0, failed: 0, expired: 0, cancelled: 0 };
  for (const id of Object.keys(seen)) { expected.attempts += 1; expected[seen[id].status] += 1; }
  const finished = expected.attempts - expected.pending;
  const rate = Math.round((expected.paid / finished) * 1000) / 10;
  const s = everyone.body.summary;
  check("the manager's list counts every attempt and every ending",
    s.attempts === expected.attempts && s.paid === expected.paid && s.failed === expected.failed &&
    s.expired === expected.expired && s.cancelled === expected.cancelled, JSON.stringify({ s, expected }));
  check(`the success rate is paid out of finished attempts (${rate}%)`, s.successRate === rate, String(s.successRate));

  const mine = await call(cashier, "GET", "/api/qr-payments?staff=" + 2);
  check("a cashier's list is their own, whatever the address asks for",
    mine.body.rows.length === expected.attempts - 1 && mine.body.rows.every((r) => r.id !== managers.body.id));
  const onlyPaid = await call(manager, "GET", "/api/qr-payments?status=paid");
  check("the status filter narrows the list but not the tiles",
    onlyPaid.body.rows.every((r) => r.status === "paid") && onlyPaid.body.summary.attempts === expected.attempts);

  // ---------- everything is on the trail ----------
  const admin = await login("admin@hardware.com", "admin123");
  const trail = await call(admin, "GET", "/api/audit-logs?type=PAYMENT");
  const rows = Array.isArray(trail.body) ? trail.body : (trail.body.rows || trail.body.logs || []);
  const actions = new Set(rows.map((r) => r.action));
  check("made, paid, failed, expired, cancelled and linked are all in the audit trail",
    ["QR_PAYMENT_CREATED", "QR_PAYMENT_PAID", "QR_PAYMENT_FAILED", "QR_PAYMENT_EXPIRED",
     "QR_PAYMENT_CANCELLED", "QR_PAYMENT_LINKED"].every((a) => actions.has(a)), [...actions].join(","));

  // ---------- the public pages ----------
  const done = await fetch(BASE + "/pay/done?payment_intent_id=x");
  check("the return page opens without signing in", done.status === 200 && /return to the cashier/.test(await done.text()));
  const hook = await fetch(BASE + "/api/paymongo/webhook", { method: "POST", body: "{}" });
  check("the PayMongo webhook is off while the simulation is in use (404)", hook.status === 404);

  const failedChecks = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
  process.exit(failedChecks.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
