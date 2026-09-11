// Drives the rebuilt Manager dashboard against the stub. Checks the things a
// screenshot cannot: that the KPI cards actually lead somewhere, that the
// income breakdown re-queries when the period changes, that the reports are
// isolated behind tabs, that the sales filters go to the server, that the
// reorder point follows the formula, and that a delivered order with money
// owed on it reads as Pending Cash Collection rather than Completed.
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") if (isOurProblem(m.text())) problems.push("console: " + m.text()); });
  page.on("pageerror", (e) => problems.push("page error: " + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && isOurProblem(r.url())) problems.push(r.status() + " " + r.url());
  });

  const apiCalls = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.url()); });

  await context.addInitScript(() => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: 2, user_id: 2, first_name: "Manager", last_name: "User",
      full_name: "Manager M. User", email: "manager@hardware.com",
      role_name: "Manager", must_change_password: false
    }));
  });

  await page.goto(`${BASE}/manager-dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ---------- 1. the dashboard, and its cards ----------
  const cards = await page.locator("#kpi-grid button.kpi-card").count();
  check("every dashboard card is clickable", cards === 5, `${cards} clickable of 5`);

  const labels = await page.locator("#kpi-grid .kpi-label").allTextContents();
  check("the five named figures are on the dashboard",
    ["Collected", "Outstanding", "Transactions", "Reorder Alerts", "Deliveries Moving"]
      .every((name) => labels.includes(name)), labels.join(" / "));
  await shot("01-dashboard");

  // ---------- 2. Collected opens the income breakdown, filled ----------
  await page.click("#kpi-grid button.kpi-card:has-text('Collected')");
  await page.waitForTimeout(900);

  check("the income card opens the income screen",
    await page.locator("#panel-income").isVisible());
  check("it arrives already loaded, not empty",
    await page.locator("#income-kpis .kpi-card").count() === 6);
  check("the chart is drawn",
    await page.locator("#income-chart .chart-col").count() > 0);
  check("the three income tables filled themselves",
    await page.locator("#income-methods-table tbody tr").count() > 0 &&
    await page.locator("#income-products-table tbody tr").count() > 0 &&
    await page.locator("#income-staff-table tbody tr").count() > 0);
  await shot("02-income");

  // ---------- 3. the period picker re-queries ----------
  const before = apiCalls.length;
  await page.click("#income-ranges button:has-text('Today')");
  await page.waitForTimeout(700);

  check("picking a period goes back to the server",
    apiCalls.slice(before).some((url) => url.includes("range=daily")),
    apiCalls.slice(before).join(", "));
  check("the active period is marked",
    (await page.locator("#income-ranges .filter-chip.active").textContent()).trim() === "Today");

  await page.fill("#income-from", "2026-07-01");
  await page.fill("#income-to", "2026-07-31");
  const beforeCustom = apiCalls.length;
  await page.click("button:has-text('Use these dates')");
  await page.waitForTimeout(700);
  check("a custom range is sent as two dates",
    apiCalls.slice(beforeCustom).some((url) => url.includes("from=2026-07-01") && url.includes("to=2026-07-31")));
  check("choosing custom dates clears the named period",
    await page.locator("#income-ranges .filter-chip.active").count() === 0);
  await shot("03-income-custom");

  // a manager keeps the export buttons
  check("a manager sees the export buttons",
    await page.locator("[data-export]").count() === 3);

  // ---------- 4. reports are isolated ----------
  await page.evaluate("showReports()");
  await page.waitForTimeout(400);

  const visibleTabs = await page.locator("#panel-reports .tab-content.active").count();
  check("only one report is on screen at a time", visibleTabs === 1);
  check("the other three are not merely below it",
    await page.locator("#report-unpaid").isVisible() === false);
  check("each report starts closed",
    /Not loaded/i.test(await page.textContent("#methods-count")));
  await shot("04-reports-closed");

  await page.click("button:has-text('Payment Methods')");
  await page.click("#report-methods button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("a report loads on request",
    await page.locator("#methods-table tbody tr").count() > 0);

  await page.click("#tab-btn-unpaid");
  await page.waitForTimeout(300);
  check("switching tab swaps the report",
    await page.locator("#report-unpaid").isVisible() &&
    !(await page.locator("#report-methods").isVisible()));

  await page.click("#report-unpaid button:has-text('Load Data')");
  await page.waitForTimeout(600);
  const unpaidRows = await page.locator("#unpaid-table tbody tr").count();
  check("receivables pages ten at a time", unpaidRows === 10, `saw ${unpaidRows}`);
  await shot("05-reports-receivables");

  // ---------- 5. Outstanding lands on the credit book, filtered to who owes ----------
  await page.evaluate("showManagerHome()");
  await page.waitForTimeout(600);
  await page.click("#kpi-grid button.kpi-card:has-text('Outstanding')");
  await page.waitForTimeout(800);
  check("the outstanding card opens the credit accounts, not the sales list",
    await page.locator("#panel-credit").isVisible() &&
    await page.locator("#credit-table tbody tr").count() > 0);
  check("and it arrives filtered to customers who owe",
    await page.inputValue("#credit-owing") === "owing");

  // ---------- 6. sales filters ----------
  await page.evaluate("showSales()");
  await page.waitForTimeout(300);
  check("the sales table starts closed",
    /No sales loaded/i.test(await page.textContent("#sales-table tbody")));

  await page.click("#panel-sales button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("sales page ten at a time",
    await page.locator("#sales-table tbody tr").count() === 10);

  const headers = await page.locator("#sales-table thead th").allTextContents();
  check("the status column is transaction status, not payment status",
    headers.includes("Status"));

  const beforeFilter = apiCalls.length;
  await page.selectOption("#sales-method", "Online Payment");
  await page.waitForTimeout(700);
  check("the payment-method filter goes to the server",
    apiCalls.slice(beforeFilter).some((url) => url.includes("method=Online%20Payment")),
    apiCalls.slice(beforeFilter).join(", "));

  const groups = await page.locator("#sales-table tbody tr td:nth-child(4)").allTextContents();
  check("only online payments come back",
    groups.length > 0 && groups.every((text) => text.includes("Online Payment")),
    groups.slice(0, 3).join(" / "));
  await shot("06-sales-online");

  await page.selectOption("#sales-method", "all");
  await page.selectOption("#sales-status", "Pending Delivery");
  await page.waitForTimeout(700);
  const statuses = await page.locator("#sales-table tbody tr td:nth-child(5)").allTextContents();
  check("the transaction-status filter works",
    statuses.length > 0 && statuses.every((text) => text.trim() === "Pending Delivery"),
    statuses.slice(0, 3).join(" / "));

  await page.selectOption("#sales-status", "Voided");
  await page.waitForTimeout(700);
  const voided = await page.locator("#sales-table tbody tr td:nth-child(5)").allTextContents();
  check("voided sales can be asked for", voided.length > 0 &&
    voided.every((text) => text.trim() === "Voided"), voided.join(" / "));
  await shot("07-sales-voided");

  // ---------- 7. stocks are two screens ----------
  await page.evaluate("showReorderAlerts()");
  await page.waitForTimeout(300);
  check("Reorder Alerts is its own screen",
    await page.locator("#panel-reorder").isVisible() &&
    !(await page.locator("#panel-stock-report").isVisible()));
  check("the formula is printed on the screen",
    /average daily sales/i.test(await page.textContent(".formula-note")));

  await page.click("#panel-reorder button:has-text('Load Data')");
  await page.waitForTimeout(700);
  const alertRows = await page.locator("#reorder-table tbody tr").count();
  check("reorder alerts load and page", alertRows > 0 && alertRows <= 10, `saw ${alertRows}`);
  check("each row says whether its point is manual or dynamic",
    await page.locator("#reorder-table tbody .badge:has-text('Dynamic')").count() +
    await page.locator("#reorder-table tbody .badge:has-text('Manual')").count() === alertRows);
  await shot("08-reorder-alerts");

  await page.selectOption("#reorder-mode-filter", "Dynamic");
  await page.waitForTimeout(400);
  const dynamicRows = await page.locator("#reorder-table tbody tr").count();
  check("the mode filter narrows the alerts",
    await page.locator("#reorder-table tbody .badge:has-text('Dynamic')").count() === dynamicRows);
  await page.selectOption("#reorder-mode-filter", "all");
  await page.waitForTimeout(400);

  await page.evaluate("showStockReport()");
  await page.waitForTimeout(300);
  check("Stock Report is a separate screen",
    await page.locator("#panel-stock-report").isVisible() &&
    !(await page.locator("#panel-reorder").isVisible()));

  await page.click("#panel-stock-report button:has-text('Load Data')");
  await page.waitForTimeout(700);
  check("the stock report pages ten at a time",
    await page.locator("#stocks-table tbody tr").count() === 10);
  check("total stock value is reported",
    /total value/.test(await page.textContent("#stock-value")));
  await shot("09-stock-report");

  // ---------- 8. the reorder policy, and its arithmetic ----------
  // deliberately a product that is still Manual, because switching one to
  // Dynamic is the move that has to be confirmed
  const manualRow = page.locator('#stocks-table tbody tr')
    .filter({ has: page.locator('td:nth-child(4) .badge:text-is("Manual")') }).first();
  check("there is a manual product to switch over", await manualRow.count() === 1);

  await manualRow.click();
  await page.waitForTimeout(500);
  check("a product opens with a Reorder Point page",
    (await page.textContent("#detail-steps")).includes("Reorder Point"));

  await page.click("#detail-steps button:has-text('Reorder Point')");
  await page.waitForTimeout(300);
  check("the formula is written out for this product",
    /safety =/.test(await page.textContent("#detail-page")));
  await shot("10-product-reorder");

  await page.click("#detail-page button:has-text('Change Reorder Policy')");
  await page.waitForTimeout(500);
  check("the policy editor opens",
    await page.locator("#policy-modal.open").count() === 1);

  // the preview has to follow what is typed, or nobody will trust the formula
  await page.fill("#policy-lead", "10");
  await page.fill("#policy-safety", "20");
  await page.waitForTimeout(200);

  const daily = await page.evaluate("Number(policyProduct.avg_daily_sales)");
  const expected = Math.ceil(daily * 10) + 20;
  const previewText = await page.textContent("#policy-preview");
  check("the preview computes (daily x lead) + safety",
    previewText.includes(String(expected)), `expected ${expected} in "${previewText.slice(0, 90)}"`);
  await shot("11-policy-editor");

  await page.selectOption("#policy-mode", "Dynamic");
  await page.waitForTimeout(200);
  check("switching to Dynamic says which figure will be used",
    /recalculated as sales change/.test(await page.textContent("#policy-preview")));

  await page.click("#policy-form button[type=submit]");
  await page.waitForTimeout(500);
  check("turning the formula on asks first",
    await page.locator("#ask-modal.open").count() === 1);
  check("it says what changes",
    await page.locator("#ask-detail li").count() === 3);
  await shot("12-policy-confirm");

  await page.click("#ask-ok");
  await page.waitForTimeout(900);
  check("the policy saves and the table refreshes",
    await page.locator("#policy-modal.open").count() === 0 &&
    await page.locator("#stocks-table tbody tr").count() === 10);

  // ---------- 9. deliveries: delivered is not the same as paid ----------
  await page.evaluate("showDeliveries()");
  await page.waitForTimeout(300);
  await page.click("#panel-deliveries button:has-text('Load Data')");
  await page.waitForTimeout(700);

  const fulfilment = await page.locator("#deliveries-table tbody tr td:nth-child(7)").allTextContents();
  check("deliveries show a fulfilment state",
    fulfilment.length === 10, `saw ${fulfilment.length}`);
  check("a delivered order with money owed is not Completed",
    (await page.textContent("#deliveries-table")).includes("Pending Cash Collection"));
  check("the stage counts are above the table",
    await page.locator("#track-legend .track-chip").count() > 0);
  await shot("13-deliveries");

  await page.click("#track-legend .track-chip:has-text('Pending Cash Collection')");
  await page.waitForTimeout(400);
  const owing = await page.locator("#deliveries-table tbody tr td:nth-child(7)").allTextContents();
  check("clicking a stage count filters to it",
    owing.length > 0 && owing.every((text) => text.trim() === "Pending Cash Collection"),
    owing.join(" / "));

  const balances = await page.locator("#deliveries-table tbody tr td:nth-child(6)").allTextContents();
  check("every one of them has a balance still owed",
    balances.every((text) => parseFloat(text.replace(/,/g, "")) > 0), balances.join(" / "));
  await shot("14-pending-cash");

  // ---------- 10. records and archives ----------
  await page.evaluate("showRecords()");
  await page.waitForTimeout(300);
  await page.click("#panel-records button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("records page ten at a time",
    await page.locator("#records-table tbody tr").count() === 10);

  await page.click("[data-record-tab='customer']");
  await page.waitForTimeout(700);
  const recordHeaders = await page.locator("#records-table thead th").allTextContents();
  check("changing the kind of record redraws the columns",
    recordHeaders.includes("Credit Limit"), recordHeaders.join(" / "));
  await shot("15-records");

  await page.evaluate("showArchives()");
  await page.waitForTimeout(300);
  await page.click("#panel-archives button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("archives page ten at a time",
    await page.locator("#archives-table tbody tr").count() === 10);
  check("no Restore button sits on an archive row",
    await page.locator("#archives-table tbody button").count() === 0);

  await page.click("#archives-table tbody tr:first-child");
  await page.waitForTimeout(400);
  check("an archive row opens the record first",
    await page.locator("#detail-modal.open").count() === 1 &&
    (await page.textContent("#detail-page")).includes("Restore This Record"));
  await shot("16-archive-entry");

  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
