// Checks the "closed until asked, ten rows a page" rule on the clerk and
// driver modules; the driver's own run is still loaded on arrival, but paged.
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

async function pageFor(browser, role, fullName, staffId, problems) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(([r, n, s]) => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: s, user_id: s, first_name: n.split(" ")[0], last_name: "User",
      full_name: n, email: "x@hardware.com", role_name: r, must_change_password: false
    }));
  }, [role, fullName, staffId]);

  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") if (isOurProblem(m.text())) problems.push(`[${role}] ` + m.text()); });
  page.on("pageerror", (e) => problems.push(`[${role}] page error: ` + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && isOurProblem(r.url())) problems.push(`[${role}] ` + r.status() + " " + r.url());
  });
  return { context, page };
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

  // ======================================================== CLERK
  const clerk = await pageFor(browser, "Inventory Clerk", "Clerk I. User", 3, problems);
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  const apiCalls = [];
  clerk.page.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.url()); });

  await clerk.page.goto(`${BASE}/inventory-dashboard.html`, { waitUntil: "domcontentloaded" });
  await clerk.page.waitForTimeout(900);

  // arriving fetches the low-stock banner and nothing else
  const tableCalls = apiCalls.filter((url) =>
    /inventory\/adjustments|purchase-orders|api\/returns|archived=true/.test(url));
  check("opening the clerk page loads no tables",
    tableCalls.length === 0, tableCalls.join(", "));

  check("the material list starts closed",
    /No materials loaded/i.test(await clerk.page.textContent("#inv-table tbody")));
  await shot(clerk.page, "01-clerk-closed");

  await clerk.page.click("#panel-inventory button:has-text('Load Data')");
  await clerk.page.waitForTimeout(700);
  const materials = await clerk.page.locator("#inv-table tbody tr:not(.row-filler)").count();
  check("materials page ten at a time", materials === 10, `saw ${materials}`);
  check("and the pager counts the rest",
    /of 18/.test(await clerk.page.textContent("#inv-pager")),
    await clerk.page.textContent("#inv-pager"));
  await shot(clerk.page, "02-clerk-materials");

  await clerk.page.selectOption("#inv-status", "Low Stock");
  await clerk.page.waitForTimeout(400);
  const low = await clerk.page.locator("#inv-table tbody tr:not(.row-filler)").count();
  check("the stock filter narrows the list",
    low > 0 && await clerk.page.locator("#inv-table .badge:text-is('Low Stock')").count() === low,
    `saw ${low}`);
  await clerk.page.selectOption("#inv-status", "all");
  await clerk.page.waitForTimeout(300);

  // each of the other five screens
  const screens = [
    ["showAdjust", "clerk-adjustments", "adjust-table", "the adjustment log"],
    ["showReorder", "clerk-reorder", "reorder-table", "reorder settings"],
    ["showPurchaseOrderHistory", "clerk-po", "po-table", "purchase orders"],
    ["showReturns", "clerk-returns", "returns-table", "returned items"],
    ["showInventoryArchive", "clerk-archive", "arch-table", "the material archive"]
  ];

  for (const [open, key, table, label] of screens) {
    await clerk.page.evaluate(`${open}()`);
    await clerk.page.waitForTimeout(350);
    check(`${label} starts closed`,
      /not loaded|No .* loaded|No reports loaded|No purchase orders loaded/i
        .test(await clerk.page.textContent(`#${table} tbody`)),
      (await clerk.page.textContent(`#${table} tbody`)).trim().slice(0, 60));

    await clerk.page.evaluate(`dataPanelOpen('${key}')`);
    await clerk.page.waitForTimeout(700);
    const rows = await clerk.page.locator(`#${table} tbody tr:not(.row-filler)`).count();
    check(`${label} loads and pages`, rows > 0 && rows <= 10, `saw ${rows}`);
  }
  await shot(clerk.page, "03-clerk-returns");

  // the clerk raises purchase orders; confirming is the manager's; once confirmed, the clerk counts the delivery in
  await clerk.page.evaluate("showPurchaseOrders()");
  await clerk.page.waitForTimeout(300);
  check("the clerk has the purchase order form, sent to the manager",
    await clerk.page.locator("#panel-po").isVisible() &&
    await clerk.page.locator("#po-form #po-supplier").count() === 1 &&
    /Send to the manager/.test(await clerk.page.textContent("#po-form button[type=submit]")));
  await clerk.page.evaluate("showPurchaseOrderHistory()");
  await clerk.page.waitForTimeout(300);
  const clerkStatuses = (await clerk.page.locator("#po-table tbody tr td:nth-child(6)").allTextContents()).map((t) => t.trim());
  check("the clerk's list puts the orders to count in first, with no buttons",
    /Waiting for delivery/.test(clerkStatuses[0]) &&
    await clerk.page.locator("#po-table tbody button").count() === 0 &&
    await clerk.page.locator("#po-table tbody tr.row-attention").count() > 0,
    clerkStatuses.join(" / "));
  await clerk.page.click("#po-table tbody tr.row-attention >> nth=0");
  await clerk.page.waitForTimeout(600);
  check("pressing an order waiting for delivery opens the receive form",
    await clerk.page.locator("#panel-po-receive").isVisible());
  await clerk.page.evaluate("showPurchaseOrderHistory()");
  await clerk.page.waitForTimeout(300);
  await clerk.page.evaluate("openPurchaseOrderDetail(200)");   // one still waiting for the manager
  await clerk.page.waitForTimeout(600);
  check("but no way to confirm one: a row still waiting opens the order's card, with nothing on it to press but the printed order",
    await clerk.page.locator("#detail-modal.open").count() === 1 &&
    await clerk.page.locator("#detail-modal button:has-text('Approve Order')").count() === 0 &&
    await clerk.page.locator("#detail-modal button:has-text('Decline')").count() === 0 &&
    await clerk.page.locator("#detail-modal button:has-text('Count In the Delivery')").count() === 0 &&
    await clerk.page.locator("#detail-modal button:has-text('Printed Order'):visible").count() === 1);
  await clerk.page.evaluate("closeModal('detail-modal')");
  await clerk.page.evaluate("openPurchaseOrderDetail(201)");   // one the manager has confirmed (Pending)
  await clerk.page.waitForTimeout(600);
  check("an order the manager has confirmed offers the clerk Count in the delivery, and nothing else",
    await clerk.page.locator("#detail-modal.open").count() === 1 &&
    await clerk.page.locator("#detail-modal button:has-text('Approve Order')").count() === 0 &&
    await clerk.page.locator("#detail-modal button:has-text('Count In the Delivery'):visible").count() === 1);
  await clerk.page.click("#detail-modal button:has-text('Count In the Delivery')");
  await clerk.page.waitForTimeout(600);
  check("which opens the count sheet on the clerk's page",
    await clerk.page.locator("#panel-po-receive").isVisible() &&
    await clerk.page.locator("#recv-lines .recv-line").count() > 0);
  await clerk.page.evaluate("showPurchaseOrderHistory()");
  await clerk.page.waitForTimeout(300);
  await clerk.page.evaluate("openPurchaseOrderDetail(200)");   // still waiting for the manager
  await clerk.page.waitForTimeout(600);

  await clerk.page.click("#detail-modal button:has-text('Printed Order')");
  await clerk.page.waitForTimeout(600);
  check("the printed order opens, with nothing on it to press but Print and Back",
    await clerk.page.locator("#po-doc .po-doc").count() === 1 &&
    await clerk.page.locator("#po-doc button:has-text('Receive')").count() === 0);
  await shot(clerk.page, "03b-clerk-order-reference");
  await clerk.page.evaluate("showPurchaseOrderHistory()");
  await clerk.page.waitForTimeout(200);

  // the returns list now says where the goods went
  await clerk.page.evaluate("showReturns()");
  await clerk.page.waitForTimeout(400);
  const headers = await clerk.page.locator("#returns-table thead th").allTextContents();
  check("the clerk's returns list says where the goods went",
    headers.includes("Goods Went"), headers.join(" / "));

  await clerk.page.selectOption("#returns-where", "Write-Off");
  await clerk.page.waitForTimeout(400);
  const written = await clerk.page.locator("#returns-table tbody tr:not(.row-filler)").count();
  check("and it can be filtered to the write-offs",
    written > 0 &&
    await clerk.page.locator("#returns-table .badge:text-is('Written off')").count() === written,
    `saw ${written}`);
  await shot(clerk.page, "04-clerk-writeoffs");

  await clerk.context.close();

  // ======================================================== DRIVER
  const driver = await pageFor(browser, "Delivery Personnel", "Delivery D. User", 5, problems);

  await driver.page.goto(`${BASE}/delivery.html`, { waitUntil: "domcontentloaded" });
  await driver.page.waitForTimeout(1000);

  // the driver's run waits to be asked, like every other table
  check("the driver's run starts closed",
    /not loaded/i.test(await driver.page.textContent("#dpend-table tbody")));
  await driver.page.click("#dpend-table tbody button:has-text('Load Data')");
  await driver.page.waitForTimeout(800);
  const pending = await driver.page.locator("#dpend-table tbody tr:not(.row-filler)").count();
  check("Load Data reads the driver's run", pending > 0, `saw ${pending}`);
  check("and it pages ten at a time", pending <= 10, `saw ${pending}`);
  await shot(driver.page, "05-driver-pending");

  await driver.page.fill("#dpend-search", "zzzz");
  await driver.page.press("#dpend-search", "Enter");
  await driver.page.waitForTimeout(500);
  check("the driver can search their own run",
    /No match found/i.test(await driver.page.textContent("#dpend-table tbody")));
  await driver.page.fill("#dpend-search", "");
  await driver.page.press("#dpend-search", "Enter");
  await driver.page.waitForTimeout(500);

  // one Load Data reads the run once and fills both lists (README,
  // "Tables that wait to be asked"), so the driver's own deliveries are
  // already there when Cash on Delivery is opened
  await driver.page.evaluate("showDeliveryCod()");
  await driver.page.waitForTimeout(400);
  check("the driver's deliveries were filled by the same Load Data",
    await driver.page.locator("#dcod-table tbody tr.row-clickable").count() > 0 &&
    /to collect/.test(await driver.page.textContent("#dcod-count")));
  await shot(driver.page, "06-driver-cod");

  // taking a delivery nobody has: the row says whose it is, the popup opens
  await driver.page.evaluate("showDeliveryHome()");
  await driver.page.waitForTimeout(400);
  const open = driver.page.locator("#dpend-table tbody tr:not(.row-filler)", { hasText: "Unassigned" }).first();
  check("a delivery nobody has taken is marked Unassigned", await open.count() === 1);
  if (await open.count() === 1) {
    const id = (await open.locator("td").first().textContent()).trim();
    await open.click();
    await driver.page.waitForTimeout(400);
    await driver.page.click("button:has-text('Take Delivery')");
    await driver.page.waitForTimeout(1200);
    check("taking it opens that delivery's popup",
      await driver.page.$eval("#detail-modal", (m) => m.classList.contains("open")) &&
      (await driver.page.textContent("#detail-title")).includes(id),
      await driver.page.textContent("#detail-title"));
    await shot(driver.page, "06b-driver-took-delivery");
    await driver.page.keyboard.press("Escape");
    await driver.page.waitForTimeout(300);
    const row = driver.page.locator("#dpend-table tbody tr:not(.row-filler)", { hasText: id });
    check("and its row now says Yours",
      await row.count() === 1 && /Yours/.test(await row.textContent()),
      await row.count() ? await row.textContent() : "row gone");
  }

  // the reports screen is the one that waits
  await driver.page.evaluate("showDeliveryReports()");
  await driver.page.waitForTimeout(500);
  check("the reports screen waits to be asked",
    /The report is not loaded/i.test(await driver.page.textContent("#drep-table tbody")));
  check("and offers Load Data in the table, with no button of its own above",
    await driver.page.locator("#drep-table button:has-text('Load Data')").count() === 1 &&
    await driver.page.locator("#panel-report .panel-toolbar button").count() === 0);
  await shot(driver.page, "07-driver-reports-closed");

  await driver.page.click("#drep-table button:has-text('Load Data')");
  await driver.page.waitForTimeout(900);
  check("the report loads when it is asked for",
    await driver.page.locator("#drep-legend .track-chip").count() > 1 &&
    await driver.page.locator("#drep-table tbody tr:not(.row-filler)").count() > 0);
  await shot(driver.page, "08-driver-reports");

  // picking both dates reads the report again, with no button to press
  let reread = 0;
  driver.page.on("request", (r) => { if (/\/api\/delivery\/summary/.test(r.url()) && r.method() === "GET") reread += 1; });
  await driver.page.fill("#drep-from", "2026-01-01");
  await driver.page.fill("#drep-to", "2026-12-31");
  await driver.page.waitForTimeout(900);
  check("filling in both dates reloads the report", reread > 0, `${reread} reads`);

  await driver.context.close();
  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
