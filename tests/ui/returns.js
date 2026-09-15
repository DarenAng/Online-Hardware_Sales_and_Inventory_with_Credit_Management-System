// Drives the return form: a return cannot be filed without a sentence of
// reason or without a disposition, and neither disposition is preselected.
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

// only console lines this system caused: the font CDN and the favicon are noise
function isOurProblem(text) {
  return !/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(String(text));
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(bundled) ? { executablePath: bundled } : {});

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  await context.addInitScript(() => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: 4, user_id: 4, first_name: "Cashier", last_name: "User",
      full_name: "Cashier C. User", email: "cashier@hardware.com",
      role_name: "Cashier", must_change_password: false
    }));
  });

  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") if (isOurProblem(m.text())) problems.push("console: " + m.text()); });
  page.on("pageerror", (e) => problems.push("page error: " + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && isOurProblem(r.url())) problems.push(r.status() + " " + r.url());
  });

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  await page.goto(`${BASE}/cashier-dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  await page.evaluate("showRefunds()");
  await page.waitForTimeout(800);

  // ---------- nothing is chosen for you ----------
  check("neither disposition is preselected",
    await page.locator('input[name="disposition"]:checked').count() === 0);
  check("both options are offered with what they do",
    await page.locator(".disposition-option").count() === 2 &&
    (await page.textContent("#disposition-choice")).includes("stock count goes up") &&
    (await page.textContent("#disposition-choice")).includes("never goes back on the shelf"));
  check("the remarks box says it is required",
    (await page.textContent("#reason-counter")).includes("Required"));
  check("the old resalable dropdown is gone",
    await page.locator('select[name="restock"]').count() === 0);
  await shot("01-return-form");

  // ---------- the remarks are enforced while typing ----------
  await page.fill("#return-reason", "broken");
  await page.waitForTimeout(200);
  const short = await page.textContent("#reason-counter");
  check("a one-word reason is called short",
    /more character/.test(short), short);
  check("and it is marked, not just described",
    (await page.getAttribute("#reason-counter", "class")).includes("is-short"));
  await shot("02-reason-too-short");

  await page.fill("#return-reason", "Two tins arrived dented in the delivery and cannot be sold.");
  await page.waitForTimeout(200);
  check("a sentence is accepted",
    (await page.getAttribute("#reason-counter", "class")).includes("is-good"));

  // ---------- filing with no disposition is refused ----------
  // pickRefundProduct(id) is what the suggestion list calls
  const productId = await page.evaluate(
    "fetch('/api/inventory/products').then(r => r.json()).then(rows => rows[2].product_id)");
  await page.evaluate(`pickRefundProduct(${productId})`);
  await page.waitForTimeout(250);
  await page.fill('[name="quantity"]', "2");
  await page.fill('[name="refundAmount"]', "1500");
  await page.click('#refund-form button[type="submit"]');
  await page.waitForTimeout(600);

  check("filing with no disposition is refused",
    await page.locator("#disposition-choice.is-missing").count() === 1);
  check("and the refusal says why",
    /Where do the goods go/i.test(await page.textContent(".toast-deck")));
  await shot("03-no-disposition");

  // ---------- a short reason is refused at submit too ----------
  await page.check('input[value="Return to Stock"]');
  await page.waitForTimeout(300);
  check("choosing an option clears the warning",
    await page.locator("#disposition-choice.is-missing").count() === 0);
  check("Return to Stock says stock goes up",
    /Stock goes up/.test(await page.textContent("#disposition-verdict")));
  await shot("04-return-to-stock");

  // minlength makes the browser refuse first; the handler still checks
  await page.fill("#return-reason", "broken");
  await page.waitForTimeout(200);
  await page.evaluate("clearCards()");
  await page.click('#refund-form button[type="submit"]');
  await page.waitForTimeout(600);

  const blocked = await page.evaluate(`(function () {
      const field = document.getElementById('return-reason');
      return { valid: field.checkValidity(), reason: field.validationMessage };
  })()`);
  check("a short reason is refused at submit as well",
    blocked.valid === false, JSON.stringify(blocked));

  const handlerBlocks = await page.evaluate(`(function () {
      const form = document.getElementById('refund-form');
      form.noValidate = true;
      return true;
  })()`);
  await page.click('#refund-form button[type="submit"]');
  await page.waitForTimeout(600);
  check("and the handler refuses it too, in plain words",
    /remarks are required|in a sentence/i.test(await page.textContent(".toast-deck")) &&
    handlerBlocks);
  await page.evaluate("document.getElementById('refund-form').noValidate = false; clearCards();");

  await page.fill("#return-reason", "Two tins arrived dented in the delivery and cannot be sold.");
  await page.waitForTimeout(200);
  await page.evaluate("clearCards()");

  // ---------- a write-off is read back before it goes ----------
  await page.check('input[value="Write-Off"]');
  await page.waitForTimeout(300);
  check("Write-Off says the goods never come back",
    /never goes back on the shelf/.test(await page.textContent("#disposition-verdict")));
  check("and it wears the colour that means it stops something",
    (await page.getAttribute("#disposition-verdict", "class")).includes("is-stop"));
  await shot("05-write-off");

  await page.click('#refund-form button[type="submit"]');
  await page.waitForTimeout(700);
  check("a write-off asks before it happens",
    await page.locator("#ask-modal.open #ask-ok.btn-danger").count() === 1);
  check("it names the quantity and the product",
    /2 x /.test(await page.textContent("#ask-text")));
  check("it says what cannot be undone",
    await page.locator("#ask-detail li").count() === 3 &&
    /stock adjustment, not an undo/.test(await page.textContent("#ask-detail")));
  await shot("06-write-off-confirm");

  await page.click("#ask-ok");
  await page.waitForTimeout(900);

  check("the write-off is filed",
    /written off/i.test(await page.textContent(".toast-deck")));
  check("the form clears itself",
    (await page.inputValue("#return-reason")) === "" &&
    await page.locator('input[name="disposition"]:checked').count() === 0);

  // ---------- the list says where each one went ----------
  const rows = await page.locator("#refund-table tbody tr").count();
  check("the refund list has the new record", rows >= 3, `saw ${rows}`);

  const headers = await page.locator("#refund-table thead th").allTextContents();
  check("the column asks about the goods, not the record",
    headers.includes("Goods Went"), headers.join(" / "));
  check("each row says which way the goods went",
    await page.locator("#refund-table .badge:text-is('Written off')").count() >= 1 &&
    await page.locator("#refund-table .badge:text-is('Back on shelf')").count() >= 1);
  await shot("07-refund-list");

  await page.click("#refund-table tbody tr:first-child");
  await page.waitForTimeout(500);
  check("the record opens with its remarks",
    await page.locator("#detail-modal.open").count() === 1);

  await page.click("#detail-steps button:has-text('Details')");
  await page.waitForTimeout(300);
  check("the remarks are on the record",
    /Remarks/.test(await page.textContent("#detail-page")) &&
    /dented in the delivery/.test(await page.textContent("#detail-page")));
  await shot("08-return-record");

  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
