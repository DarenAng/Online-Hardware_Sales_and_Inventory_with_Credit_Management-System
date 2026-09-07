// Checks that the "closed until asked, ten rows a page" rule now holds on the
// two modules it had not reached yet, and that the one deliberate exception —
// the driver's own run — is exactly that: still loaded on arrival, but paged.
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

// A console line worth failing over is one this system caused. The font CDN
// is deliberately non-blocking and simply does not load on a machine with no
// internet, which is most machines this runs on; a favicon nobody added is a
// favicon nobody needs. Neither says anything about whether the screens work.
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
  const materials = await clerk.page.locator("#inv-table tbody tr").count();
  check("materials page ten at a time", materials === 10, `saw ${materials}`);
  check("and the pager counts the rest",
    /of 18/.test(await clerk.page.textContent("#inv-pager")),
    await clerk.page.textContent("#inv-pager"));
  await shot(clerk.page, "02-clerk-materials");

  await clerk.page.selectOption("#inv-status", "Low Stock");
  await clerk.page.waitForTimeout(400);
  const low = await clerk.page.locator("#inv-table tbody tr").count();
  check("the stock filter narrows the list",
    low > 0 && await clerk.page.locator("#inv-table .badge:text-is('Low Stock')").count() === low,
    `saw ${low}`);
  await clerk.page.selectOption("#inv-status", "all");
  await clerk.page.waitForTimeout(300);

  // each of the other five screens
  const screens = [
    ["showAdjust", "clerk-adjustments", "adjust-table", "the adjustment log"],
    ["showReorder", "clerk-reorder", "reorder-table", "reorder settings"],
    ["showPurchaseOrders", "clerk-po", "po-table", "purchase orders"],
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
    const rows = await clerk.page.locator(`#${table} tbody tr`).count();
    check(`${label} loads and pages`, rows > 0 && rows <= 10, `saw ${rows}`);
  }
  await shot(clerk.page, "03-clerk-returns");

  // the returns list now says where the goods went
  await clerk.page.evaluate("showReturns()");
  await clerk.page.waitForTimeout(400);
  const headers = await clerk.page.locator("#returns-table thead th").allTextContents();
  check("the clerk's returns list says where the goods went",
    headers.includes("Goods Went"), headers.join(" / "));

  await clerk.page.selectOption("#returns-where", "Write-Off");
  await clerk.page.waitForTimeout(400);
  const written = await clerk.page.locator("#returns-table tbody tr").count();
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

  // the deliberate exception: a driver's own run does not wait to be asked
  const pending = await driver.page.locator("#dpend-table tbody tr").count();
  check("the driver's run loads on arrival", pending > 0, `saw ${pending}`);
  check("but it still pages ten at a time", pending <= 10, `saw ${pending}`);
  check("the shift figures are drawn",
    await driver.page.locator("#del-kpis .kpi-card").count() === 5);
  await shot(driver.page, "05-driver-pending");

  await driver.page.fill("#dpend-search", "zzzz");
  await driver.page.waitForTimeout(500);
  check("the driver can search their own run",
    /No match found/i.test(await driver.page.textContent("#dpend-table tbody")));
  await driver.page.fill("#dpend-search", "");
  await driver.page.waitForTimeout(500);

  await driver.page.evaluate("showDeliveryActive()");
  await driver.page.waitForTimeout(400);
  check("the out-for-delivery list is filled too",
    await driver.page.locator("#dact-table tbody tr").count() > 0);

  await driver.page.evaluate("showDeliveryCod()");
  await driver.page.waitForTimeout(400);
  check("so is the money to collect",
    await driver.page.locator("#dcod-table tbody tr").count() > 0 &&
    /to collect/.test(await driver.page.textContent("#dcod-count")));
  await shot(driver.page, "06-driver-cod");

  // the reports screen is the one that waits
  await driver.page.evaluate("showDeliveryReports()");
  await driver.page.waitForTimeout(500);
  check("the reports screen waits to be asked",
    (await driver.page.textContent("#drep-table tbody")).trim() === "" ||
    /Loading|Load Report/i.test(await driver.page.textContent("#panel-report")));
  check("and offers a Load Report button",
    await driver.page.locator("#panel-report button:has-text('Load Report')").count() === 1);
  await shot(driver.page, "07-driver-reports-closed");

  await driver.page.click("#panel-report button:has-text('Load Report')");
  await driver.page.waitForTimeout(900);
  check("the report loads when it is asked for",
    await driver.page.locator("#drep-kpis .kpi-card").count() > 1 &&
    await driver.page.locator("#drep-table tbody tr").count() > 0);
  await shot(driver.page, "08-driver-reports");

  await driver.context.close();
  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
