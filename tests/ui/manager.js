// Drives the Manager page against the stub.
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

  await page.goto(`${BASE}/manager.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ---------- 1. the reports are the first screen ----------
  check("signing in lands on the reports, not a dashboard",
    await page.locator("#panel-reports").isVisible() &&
    await page.locator("#panel-home, #kpi-grid").count() === 0 &&
    (await page.textContent("#manager-page-title")).trim() === "Reports");
  check("the Sales Summary is on the screen, and the other reports are put away",
    await page.locator("#report-summary").isVisible() &&
    !(await page.locator("#report-sales").isVisible()) &&
    !(await page.locator("#report-unpaid").isVisible()) &&
    !(await page.locator("#report-loyal").isVisible()) &&
    !(await page.locator("#report-all").isVisible()));
  check("Staff Performance is gone, and so is the per-staff sales table",
    await page.locator("#report-staff, #staff-table, #income-staff-table, #staff-count").count() === 0 &&
    !/Staff Performance|Who Sold It/.test(await page.textContent("body")));
  check("none of them loaded itself",
    apiCalls.filter((url) => /\/api\/reports\/(overview|activity|income)/.test(url)).length === 0 &&
    /Not loaded/i.test(await page.textContent("#income-pill")) &&
    /Not loaded/i.test(await page.textContent("#sales-count")) &&
    /Not loaded/i.test(await page.textContent("#all-count")) &&
    /Not loaded/i.test(await page.textContent("#unpaid-count")) &&
    /Not loaded/i.test(await page.textContent("#loyal-count")));
  const menu = (await page.locator(".sidebar-nav > li:not([hidden]) > a").allTextContents()).map((t) => t.trim());
  check("the menu holds one entry for every report and one for every stock report",
    menu[0] === "Reports" && menu[1] === "Stocks" && menu[2] === "Purchase Orders" &&
    await page.locator("#income-nav, #reports-dropdown, #stocks-dropdown, .sidebar-nav a:text-is('Sales')").count() === 0,
    menu.join(" / "));
  check("no folding list in the menu is open",
    (await page.locator(".sidebar-nav li[data-sidebar-dropdown] > .nav-sub:visible").count()) === 0);
  const groupLabels = (await page.locator("#panel-reports .view-nav-label").allTextContents()).map((t) => t.trim());
  const reportTabs = (await page.locator("#panel-reports .view-tab").allTextContents()).map((t) => t.trim());
  check("the tab bar groups the reports under Sales, Purchases, Customers and Activity",
    groupLabels.join(" / ") === "Sales / Purchases / Customers / Activity" &&
    reportTabs.join(" / ") === "Sales Summary / Sales Transactions / Total Purchases / Receivables / Repeat Customers / Activity Log",
    groupLabels.join(" / ") + " | " + reportTabs.join(" / "));
  check("the open tab is marked, and so is Reports in the menu",
    (await page.textContent("#panel-reports .view-tab.is-current")).trim() === "Sales Summary" &&
    await page.locator("#reports-nav.active").count() === 1);
  check("no strip is drawn over the page",
    await page.locator("#subnav").isHidden());

  // ---------- 1b. the activity log ----------
  await page.click("#panel-reports .view-tab:has-text('Activity Log')");
  await page.waitForTimeout(300);
  check("the Activity Log tab swaps the view on the screen",
    await page.locator("#report-all").isVisible() &&
    !(await page.locator("#report-summary").isVisible()) &&
    (await page.textContent("#panel-reports .view-tab.is-current")).trim() === "Activity Log");
  check("it has a search box and nothing else to set",
    await page.locator("#report-all #all-search").isVisible() &&
    await page.locator("#report-all .panel-toolbar select").count() === 0);
  await page.click("#report-all button:has-text('Load Data')");
  await page.waitForTimeout(700);
  const allRows = await page.locator("#all-table tbody tr:not(.row-filler)").count();
  check("the activity log fills with what staff have filed, eight a page, newest first",
    allRows === 8 && /records/.test(await page.textContent("#all-count")), `saw ${allRows}`);
  const kinds = (await page.locator("#all-table tbody tr td:nth-child(4)").allTextContents()).map((t) => t.trim());
  check("each row says who filed it and what kind of report it is, in plain words",
    (await page.locator("#all-table tbody tr td:nth-child(2)").allTextContents()).every((t) => t.trim() !== "") &&
    kinds.includes("Sale") && kinds.includes("Credit payment") && kinds.includes("Damage report") &&
    kinds.includes("Refund report") && !kinds.some((k) => /_/.test(k)),
    kinds.join(" / "));
  await page.fill("#all-search", "Damage");
  await page.press("#all-search", "Enter");
  await page.waitForTimeout(300);
  check("typing a kind of report narrows the table to it",
    (await page.locator("#all-table tbody tr td:nth-child(4)").allTextContents()).every((t) => t.trim() === "Damage report") &&
    await page.locator("#all-table tbody tr:not(.row-filler)").count() > 0);
  await page.fill("#all-search", "Copper");
  await page.press("#all-search", "Enter");
  await page.waitForTimeout(300);
  check("the search reads the details too",
    (await page.locator("#all-table tbody tr td:nth-child(5)").allTextContents()).every((t) => /Copper/i.test(t)) &&
    await page.locator("#all-table tbody tr:not(.row-filler)").count() > 0);
  await page.click("#report-all button:has-text('Clear')");
  await page.waitForTimeout(200);
  check("Clear empties the table and the search box, back to Not loaded",
    /Not loaded/i.test(await page.textContent("#all-count")) &&
    (await page.inputValue("#all-search")) === "" &&
    await page.locator("#all-table tbody tr td").count() === 1 &&
    await page.locator("#report-all [data-print-kind='pdf']").isDisabled());
  await page.click("#report-all button:has-text('Load Data')");
  await page.waitForTimeout(700);
  await shot("01b-reports-activity");

  // ---------- 2. the sales summary ----------
  await page.click("#panel-reports .view-tab:has-text('Sales Summary')");
  await page.waitForTimeout(300);
  await page.click("#income-products-table button:has-text('Load Data')");
  await page.waitForTimeout(900);
  check("Load Data on Best Sellers fills that table only",
    await page.locator("#income-products-table tbody tr.row-clickable, #income-products-table tbody td.cell-name").count() > 0 &&
    await page.locator("#income-methods-table button:has-text('Load Data')").count() === 1 &&
    await page.locator("#income-kpis .kpi-card").count() === 0);
  await page.click("#report-summary button:has-text('Load All')");
  await page.waitForTimeout(900);
  const kpiText = await page.textContent("#income-kpis");
  check("Load All fills the figures: Total Sales, Units Sold and Average Sale",
    await page.locator("#income-kpis .kpi-card").count() === 3 &&
    /Total Sales/.test(kpiText) &&
    !/Collected|Outstanding|Billed|Discounts/.test(kpiText));
  check("the chart is drawn: columns on a peso scale, with dates and a sentence saying what it shows",
    await page.locator("#income-chart .chart-col").count() > 0 &&
    await page.locator("#income-chart .chart-tick").count() >= 3 &&
    /^₱/.test((await page.locator("#income-chart .chart-tick").last().textContent()).trim()) &&
    await page.locator("#income-chart .chart-date").count() >= 2 &&
    /Collected ₱[\d,.]+ of the ₱[\d,.]+ billed/.test(await page.textContent("#income-chart-summary")));
  check("the chart fits its card: nothing to scroll sideways",
    await page.evaluate("(() => { const c = document.getElementById('income-chart'); return c.scrollWidth <= c.clientWidth + 1; })()"));
  const lastColumn = await page.getAttribute("#income-chart .chart-col >> nth=-1", "data-index");
  await page.hover(`#income-chart .chart-hit[data-index="${lastColumn}"]`);
  await page.waitForTimeout(200);
  check("pointing at a column reads out its day: billed, collected, not yet collected",
    await page.locator("#income-chart .chart-tip:visible").count() === 1 &&
    /billed/.test(await page.textContent("#income-chart .chart-tip")) &&
    /not yet collected/.test(await page.textContent("#income-chart .chart-tip")));
  await page.mouse.move(5, 5);
  check("both breakdowns filled themselves, side by side for the same period",
    await page.locator("#income-methods-table tbody tr:not(.row-filler)").count() > 0 &&
    await page.locator("#income-products-table tbody tr:not(.row-filler)").count() > 0 &&
    await page.locator("#income-methods-table").isVisible() &&
    await page.locator("#income-products-table").isVisible());
  check("the payment table fits its card without a sideways scroll",
    await page.evaluate("(() => { const box = document.getElementById('income-methods-table').closest('.table-responsive'); return box.scrollWidth <= box.clientWidth + 1; })()"));
  check("the summary has a Spreadsheet button and a Print button, live once loaded",
    await page.locator("#report-summary [data-print-kind='sheet']").count() === 1 &&
    await page.locator("#report-summary [data-print-kind='pdf']").count() === 1 &&
    await page.locator("#report-summary [data-print-kind='sheet']").isEnabled() &&
    await page.locator("#report-summary [data-print-kind='pdf']").isEnabled());
  await shot("02-sales-summary");

  // ---------- 3. the period picker re-queries ----------
  const before = apiCalls.length;
  await page.click("#income-ranges button:has-text('Today')");
  await page.waitForTimeout(700);

  check("picking a period goes back to the server",
    apiCalls.slice(before).some((url) => url.includes("range=daily")),
    apiCalls.slice(before).join(", "));
  check("the active period is marked",
    (await page.locator("#income-ranges .filter-chip.active").textContent()).trim() === "Today");

  const beforeCustom = apiCalls.length;
  await page.fill("#income-from", "2026-07-01");
  await page.waitForTimeout(300);
  check("one date alone waits for the other",
    !apiCalls.slice(beforeCustom).some((url) => url.includes("from=2026-07-01")));
  await page.fill("#income-to", "2026-07-31");
  await page.waitForTimeout(700);
  check("a custom range is sent as two dates once both are in",
    apiCalls.slice(beforeCustom).some((url) => url.includes("from=2026-07-01") && url.includes("to=2026-07-31")));
  check("choosing custom dates clears the named period",
    await page.locator("#income-ranges .filter-chip.active").count() === 0);
  await shot("03-summary-custom");

  check("a manager sees the export buttons",
    await page.locator("[data-export]").count() === 24);

  // ---------- 4. the reports, one view at a time ----------
  await page.click(".sidebar-brand");
  await page.waitForTimeout(400);

  check("the brand corner goes back to the reports, and only one of the six views shows",
    await page.locator("#panel-reports").isVisible() &&
    await page.locator("#panel-reports > .panel-view").count() === 6 &&
    await page.locator("#panel-reports > .panel-view:visible").count() === 1);
  check("each report has its own Print and Spreadsheet pair, dead until it loads",
    await page.locator("#panel-reports [data-print-kind='pdf']").count() === 6 &&
    await page.locator("#panel-reports [data-print-kind='sheet']").count() === 6 &&
    await page.locator("#panel-reports [data-print-kind='pdf']:enabled").count() === 2 &&
    await page.locator("#panel-reports [data-print-kind='sheet']:enabled").count() === 2);
  await shot("04-reports");

  await page.click("#panel-reports .view-tab:has-text('Receivables')");
  await page.waitForTimeout(300);
  check("choosing a tab swaps the view on the screen, and marks that tab alone",
    await page.locator("#report-unpaid").isVisible() &&
    !(await page.locator("#report-summary").isVisible()) &&
    await page.locator("#panel-reports .view-tab.is-current").count() === 1 &&
    (await page.textContent("#panel-reports .view-tab.is-current")).trim() === "Receivables");
  await page.click("#report-unpaid button:has-text('Load Data')");
  await page.waitForTimeout(600);
  const unpaidRows = await page.locator("#unpaid-table tbody tr:not(.row-filler)").count();
  check("receivables pages eight at a time, so the card stays above the fold", unpaidRows === 8, `saw ${unpaidRows}`);
  check("its own Print comes alive, and the next report's stays dead",
    await page.locator("#report-unpaid [data-print-kind='pdf']").isEnabled() &&
    await page.locator("#report-loyal [data-print-kind='pdf']").isDisabled() &&
    /Not loaded/i.test(await page.textContent("#loyal-count")));
  check("nothing scrolled: the card is at the top of the screen, under the tab bar",
    (await page.evaluate("window.scrollY")) === 0 &&
    (await page.evaluate("document.getElementById('report-unpaid').getBoundingClientRect().top")) < 200);
  await page.click("#panel-reports .view-tab:has-text('Repeat Customers')");
  await page.waitForTimeout(400);
  check("and so does the next tab",
    (await page.textContent("#panel-reports .view-tab.is-current")).trim() === "Repeat Customers" &&
    await page.locator("#report-loyal").isVisible() &&
    !(await page.locator("#report-unpaid").isVisible()));
  await page.click("#panel-reports .view-tab:has-text('Receivables')");
  await page.waitForTimeout(300);
  check("the report it loaded earlier is still loaded when it comes back",
    await page.locator("#unpaid-table tbody tr:not(.row-filler)").count() === 8);
  await shot("05-reports-receivables");

  // ---------- 5. the credit book, filtered to who owes ----------
  await page.evaluate("showCredit()");
  await page.waitForTimeout(300);
  await page.click("#panel-credit button:has-text('Load Data')");
  await page.waitForTimeout(800);
  await page.selectOption("#credit-owing", "owing");
  await page.waitForTimeout(400);
  check("the credit book opens and filters to customers who owe",
    await page.locator("#panel-credit").isVisible() &&
    await page.locator("#credit-table tbody tr:not(.row-filler)").count() > 0 &&
    await page.inputValue("#credit-owing") === "owing");

  // ---------- 6. sales filters ----------
  await page.evaluate("showSales()");
  await page.waitForTimeout(300);
  check("the sales table starts closed",
    /No sales loaded/i.test(await page.textContent("#sales-table tbody")));
  check("Spreadsheet and Print are dead over the closed table",
    await page.locator("#report-sales [data-print-kind='sheet']").isDisabled() &&
    await page.locator("#report-sales [data-print-kind='pdf']").isDisabled());

  await page.click("#report-sales button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("sales page ten at a time",
    await page.locator("#sales-table tbody tr:not(.row-filler)").count() === 10);
  check("and the two buttons come alive",
    await page.locator("#report-sales [data-print-kind='sheet']").isEnabled() &&
    await page.locator("#report-sales [data-print-kind='pdf']").isEnabled());

  // the spreadsheet holds every row that survived the filters, not the ten on the page
  const download = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await page.click("#report-sales [data-print-kind='sheet']");
  const file = await download;
  check("Spreadsheet saves a CSV", Boolean(file) && /\.csv$/.test(file.suggestedFilename()),
    file ? file.suggestedFilename() : "no download");
  if (file) {
    const text = require("fs").readFileSync(await file.path(), "utf8");
    const lines = text.trim().split(/\r?\n/);
    const total = await page.evaluate("getDataPanel('mgr-sales').visible.length");
    check("it carries a header and every visible row", lines.length === total + 1,
      `${lines.length} lines for ${total} rows`);
    check("the header is the table's own", /^\uFEFF?Sale,Date,Customer,Method,Status,Total$/.test(lines[0]), lines[0]);
  }

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

  // ---------- 7. stocks: one entry, every stock report a tab ----------
  await page.click("#stocks-nav");
  await page.waitForTimeout(300);
  check("the Stocks entry opens the whole inventory first",
    await page.locator("#stock-overview").isVisible() &&
    !(await page.locator("#stock-reorder").isVisible()) &&
    !(await page.locator("#stock-moves").isVisible()) &&
    (await page.textContent("#manager-page-title")).trim() === "Stocks" &&
    await page.locator("#stocks-nav.active").count() === 1);
  const stockTabs = (await page.locator("#panel-stocks .view-tab").allTextContents()).map((t) => t.trim());
  check("every stock report is a tab on the Stocks screen, not a list in the menu",
    stockTabs.join(" / ") === "Stocks Overview / Reorder Alerts / Stock Movements" &&
    await page.locator("#stocks-dropdown").count() === 0, stockTabs.join(" / "));

  await page.click("#panel-stocks .view-tab:has-text('Reorder Alerts')");
  await page.waitForTimeout(300);
  check("Reorder Alerts swaps in, and its tab is marked",
    await page.locator("#stock-reorder").isVisible() &&
    !(await page.locator("#stock-overview").isVisible()) &&
    (await page.textContent("#panel-stocks .view-tab.is-current")).trim() === "Reorder Alerts");
  check("the formula is printed on the screen",
    /average daily sales/i.test(await page.textContent("#stock-reorder .panel-sub")));
  await page.evaluate("showStocks()");
  await page.waitForTimeout(300);
  check("coming back to Stocks opens the tab last used",
    await page.locator("#stock-reorder").isVisible());

  await page.click("#stock-reorder button:has-text('Load Data')");
  await page.waitForTimeout(700);
  const alertRows = await page.locator("#reorder-table tbody tr:not(.row-filler)").count();
  check("reorder alerts load and page", alertRows > 0 && alertRows <= 10, `saw ${alertRows}`);
  check("each row says whether its point is manual or dynamic",
    await page.locator("#reorder-table tbody .badge:has-text('Dynamic')").count() +
    await page.locator("#reorder-table tbody .badge:has-text('Manual')").count() === alertRows);
  await shot("08-reorder-alerts");

  await page.selectOption("#reorder-mode-filter", "Dynamic");
  await page.waitForTimeout(400);
  const dynamicRows = await page.locator("#reorder-table tbody tr:not(.row-filler)").count();
  check("the mode filter narrows the alerts",
    await page.locator("#reorder-table tbody .badge:has-text('Dynamic')").count() === dynamicRows);
  await page.selectOption("#reorder-mode-filter", "all");
  await page.waitForTimeout(400);

  await page.evaluate("showStockReport()");
  await page.waitForTimeout(300);
  check("Stocks Overview is its own tab, and the tab bar marks it",
    await page.locator("#stock-overview").isVisible() &&
    !(await page.locator("#stock-reorder").isVisible()) &&
    (await page.textContent("#panel-stocks .view-tab.is-current")).trim() === "Stocks Overview");

  await page.click("#stock-overview button:has-text('Load Data')");
  await page.waitForTimeout(700);
  check("the stock report pages ten at a time",
    await page.locator("#stocks-table tbody tr:not(.row-filler)").count() === 10);
  check("total stock value is reported",
    /total value/.test(await page.textContent("#stock-value")));
  check("the status counts sit over the table",
    await page.locator("#stock-legend .track-chip").count() > 0);
  await page.click("#stock-legend .track-chip:has-text('Out of Stock')");
  await page.waitForTimeout(400);
  const outStatuses = await page.locator("#stocks-table tbody tr td:nth-child(7)").allTextContents();
  check("pressing a count filters the table to it, and sets the status box",
    outStatuses.length > 0 && outStatuses.every((t) => /Out of Stock/.test(t)) &&
    (await page.inputValue("#stocks-status")) === "Out of Stock", outStatuses.join(" / "));
  await page.selectOption("#stocks-status", "all");
  await page.waitForTimeout(400);
  check("the unit price is on the grid, and no buttons sit in the rows",
    await page.locator("#stocks-table thead th:nth-child(5):visible").count() === 1 &&
    (await page.textContent("#stocks-table thead th:nth-child(5)")).trim() === "Unit Price" &&
    await page.locator("#stocks-table tbody button").count() === 0);
  await page.click("#stocks-table tbody tr:first-child");
  await page.waitForTimeout(400);
  check("a row opens the product",
    await page.locator("#detail-modal.open").count() === 1);
  await page.click("#detail-modal .modal-tab:has-text('Pricing')");
  await page.waitForTimeout(300);
  check("its Pricing tab has Change Price",
    await page.locator("#detail-modal button:has-text('Change Price'):visible").count() === 1);
  await page.click("#detail-modal button:has-text('Change Price')");
  await page.waitForTimeout(400);
  check("Change Price asks for the new price",
    await page.locator("#ask-modal.open").count() === 1 &&
    /Change the price/.test(await page.textContent("#ask-modal")));
  await page.fill("#ask-modal input", "19.99");
  await page.click("#ask-modal button:has-text('Next')");
  await page.waitForTimeout(400);
  check("an ordinary price with two decimals is accepted",
    /to ₱19\.99/.test(await page.textContent("#ask-modal")));
  await page.click("#ask-modal button:has-text('Cancel')");
  await page.waitForTimeout(300);
  if (await page.locator("#detail-modal.open").count()) {
    await page.click("#detail-modal button:has-text('Close')");
    await page.waitForTimeout(300);
  }

  // ---------- 7b. the shelf, read by quantity ----------
  const onHand = async () => (await page.locator("#stocks-table tbody tr td:nth-child(3)").allTextContents())
    .map((text) => parseInt(text, 10));

  await page.selectOption("#stocks-sort", "stock-asc");
  await page.waitForTimeout(300);
  let figures = await onHand();
  check("the stock report sorts by what is on hand, lowest first",
    figures.every((n, i) => i === 0 || n >= figures[i - 1]), figures.join(" / "));

  await page.selectOption("#stocks-sort", "stock-desc");
  await page.waitForTimeout(300);
  figures = await onHand();
  check("and highest first",
    figures.every((n, i) => i === 0 || n <= figures[i - 1]), figures.join(" / "));

  await page.selectOption("#stocks-level", "none");
  await page.waitForTimeout(300);
  figures = await onHand();
  check("the quantity filter finds what has nothing on the shelf",
    figures.length > 0 && figures.every((n) => n === 0), figures.join(" / "));

  await page.selectOption("#stocks-level", "11-50");
  await page.waitForTimeout(300);
  figures = await onHand();
  check("and a band of quantities",
    figures.length > 0 && figures.every((n) => n >= 11 && n <= 50), figures.join(" / "));
  await shot("09-stock-report");

  await page.selectOption("#stocks-level", "all");
  await page.selectOption("#stocks-sort", "name");
  await page.waitForTimeout(300);

  // ---------- 8. the reorder policy, and its arithmetic ----------
  // a product still on Manual: switching to Dynamic is the move that asks
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

  await page.click("button[type=submit][form=policy-form]");
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
    await page.locator("#stocks-table tbody tr:not(.row-filler)").count() === 10);

  // ---------- 8a. stock movements: the stock side of the activity log ----------
  await page.click("#panel-stocks .view-tab:has-text('Stock Movements')");
  await page.waitForTimeout(300);
  await page.click("#stock-moves button:has-text('Load Data')");
  await page.waitForTimeout(700);
  const moveKinds = (await page.locator("#stock-moves-table tbody tr td:nth-child(2)").allTextContents()).map((t) => t.trim());
  check("stock movements list what staff filed about the shelf, and nothing else",
    moveKinds.length > 0 &&
    moveKinds.every((k) => /Stock adjustment|Damage report|Return report|Purchase order|Order confirmed|Order declined/.test(k)),
    moveKinds.join(" / "));
  await page.selectOption("#stock-moves-kind", "DAMAGE");
  await page.waitForTimeout(300);
  check("the kind filter narrows them",
    (await page.locator("#stock-moves-table tbody tr td:nth-child(2)").allTextContents())
      .every((t) => t.trim() === "Damage report"));
  await page.selectOption("#stock-moves-kind", "all");
  await shot("12b-stock-movements");

  // ---------- 8b. purchase orders: the clerk raises them, the manager confirms ----------
  await page.evaluate("showPurchaseOrders()");
  await page.waitForTimeout(400);
  check("the manager has no order form: the words land on the order list",
    await page.locator("#panel-po").count() === 0 &&
    await page.locator("#panel-po-history").isVisible() &&
    await page.locator("a[data-panel-link='panel-po']").count() === 0);

  await page.evaluate("showPurchaseOrderHistory()");
  await page.waitForTimeout(300);
  check("Print is dead over the unloaded history",
    await page.locator("#panel-po-history [data-print-kind='pdf']").isDisabled());
  await page.click("#panel-po-history button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("the order history pages ten at a time",
    await page.locator("#po-table tbody tr:not(.row-filler)").count() === 10);

  // Total Purchases: a report under Purchases in the Reports tab bar, not a
  // button on the order list; the figures follow the filters
  check("the order list carries no Total Purchases button; it is a report now",
    await page.locator("#panel-po-history button:has-text('Total Purchases')").count() === 0);
  await page.evaluate("showReport('report-purchases')");
  await page.waitForTimeout(300);
  const now = new Date();
  const thisMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  check("the Total Purchases tab shows its report, set to this month, and loads nothing by itself",
    await page.locator("#report-purchases").isVisible() &&
    (await page.textContent("#panel-reports .view-tab.is-current")).trim() === "Total Purchases" &&
    (await page.inputValue("#po-totals-month")) === thisMonth &&
    /Not loaded/i.test(await page.textContent("#po-totals-count")));
  await page.click("#po-totals-table button:has-text('Load Data')");
  await page.waitForTimeout(600);
  const kpiNumber = async (n) => Number((await page.textContent(
    `#po-totals-kpis .kpi-card:nth-child(${n}) .kpi-value`)).replace(/[^\d.]/g, ""));
  check("Load Data adds up the month, and the month list names how many orders each month holds",
    await page.locator("#po-totals-kpis .kpi-card").count() === 4 &&
    /Total Purchases/.test(await page.textContent("#po-totals-kpis")) &&
    (await page.locator("#po-totals-month option").allTextContents()).slice(1).every((t) => /\(\d+ orders?\)$/.test(t)));
  await page.click("#report-purchases button:has-text('Show All Purchases')");
  await page.waitForTimeout(300);
  const everyOrder = await kpiNumber(2);
  check("Show All Purchases lists every month's orders",
    everyOrder > 0 && (await page.inputValue("#po-totals-month")) === "all" &&
    everyOrder === parseInt(await page.textContent("#po-totals-count"), 10));
  check("no order status is shown or filtered, and nothing cancelled is listed",
    await page.locator("#po-totals-status").count() === 0 &&
    !(await page.locator("#po-totals-table thead").textContent()).includes("Status") &&
    await page.locator("#po-totals-table tbody .badge").count() === 0);
  // the newest month that holds orders (this month may hold none)
  const monthOptions = await page.$$eval("#po-totals-month option", (options) =>
    options.map((o) => ({ value: o.value, count: parseInt((o.textContent.match(/\((\d+) orders?\)/) || [])[1] || "0", 10) })));
  const busy = monthOptions.find((o) => o.value !== "all" && o.count > 0);
  const month = busy.value;
  const monthCount = busy.count;
  await page.selectOption("#po-totals-month", month);
  await page.waitForTimeout(300);
  const shownDates = [];
  const pages = Math.ceil(monthCount / 8);
  for (let p = 0; p < pages; p++) {
    shownDates.push(...(await page.locator("#po-totals-table tbody td:nth-child(3)").allTextContents()).map((d) => d.trim()));
    if (p < pages - 1) { await page.click("#po-totals-pager button:has-text('Next')"); await page.waitForTimeout(200); }
  }
  check("picking a month lists that month's purchases and nothing else",
    await kpiNumber(2) <= everyOrder && await kpiNumber(2) === monthCount &&
    shownDates.length === monthCount && shownDates.every((d) => d.startsWith(month)),
    `${month}: ${shownDates.length} rows, ${monthCount} in the list`);
  check("the rows carry the order, supplier, date and value only; no units",
    (await page.locator("#po-totals-table thead th").allTextContents()).map((t) => t.trim()).join(" / ") ===
      "PO / Supplier / Ordered / Order Value");
  await page.click("#po-totals-table tbody tr >> nth=0");
  await page.waitForSelector("#detail-modal.open", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const card = (await page.textContent("#detail-modal")) || "";
  check("pressing a row opens the order with its details: supplier, raised, confirmed, size, value, the materials",
    await page.locator("#detail-modal.open").count() === 1 &&
    ["Supplier", "Raised", "Confirmed", "Size", "What is ordered", "Material", "Qty"].every((word) => card.includes(word)),
    card.slice(0, 200));
  await page.evaluate("closeModal('detail-modal')");
  await page.evaluate("showPurchaseOrderHistory()");
  await page.waitForTimeout(300);
  const poStatuses = (await page.locator("#po-table tbody tr td:nth-child(6)").allTextContents()).map((t) => t.trim());
  const firstOther = poStatuses.findIndex((t) => !/Waiting for confirmation/.test(t));
  check("orders waiting for your confirmation sort first",
    /Waiting for confirmation/.test(poStatuses[0]) &&
    poStatuses.slice(firstOther).every((t) => !/Waiting for confirmation/.test(t)), poStatuses.join(" / "));
  check("no buttons or action words on the rows: the status column says where an order stands",
    await page.locator("#po-table tbody button").count() === 0 &&
    await page.locator("#po-table tbody tr:not(.row-filler) td").first().evaluate((td) =>
      td.parentElement.cells.length === 6));
  check("the Print pair is alive over the loaded history",
    await page.locator("#panel-po-history [data-print-kind='pdf']").isEnabled());
  check("the status counts sit over the table",
    await page.locator("#po-legend .track-chip").count() === 4 &&
    /Waiting for confirmation/.test(await page.textContent("#po-legend .track-chip-alert")));

  await page.click("#po-legend .track-chip:has-text('Waiting for confirmation')");
  await page.waitForTimeout(300);
  const waiting = await page.locator("#po-table tbody tr:not(.row-filler)").count();
  check("pressing a count filters to it, and sets the status box",
    waiting > 0 && (await page.inputValue("#po-status")) === "For Approval", `saw ${waiting}`);
  await page.click("#po-table tbody tr:first-child td:nth-child(2)");
  await page.waitForTimeout(500);
  check("pressing the row opens the order with its lines on the first page, and Approve and Decline in the foot",
    await page.locator("#detail-modal.open").count() === 1 &&
    /Purchase Order #/.test(await page.textContent("#detail-title")) &&
    /What is ordered/i.test(await page.textContent("#detail-page")) &&
    await page.locator("#detail-page table tbody tr:not(.row-filler)").count() > 0 &&
    await page.locator("#detail-modal .modal-foot button:has-text('Approve Order'):visible").count() === 1 &&
    await page.locator("#detail-modal .modal-foot button:has-text('Decline'):visible").count() === 1 &&
    /by Clerk/.test(await page.textContent("#detail-page")));
  await shot("12c-po-review");
  await page.click("#detail-modal button:has-text('Approve Order')");
  await page.waitForTimeout(300);
  await page.click("#ask-ok");
  await page.waitForTimeout(800);
  check("confirming moves the order to waiting for delivery, off the confirmation list",
    await page.locator("#detail-modal.open").count() === 0 &&
    await page.locator("#po-table tbody tr:not(.row-filler)").count() === waiting - 1);
  await page.selectOption("#po-status", "Pending");
  await page.waitForTimeout(300);
  await page.click("#po-table tbody tr:first-child td:nth-child(2)");
  await page.waitForTimeout(500);
  check("an approved order's card is for checking only: no Approve, and no Count In, which is the clerk's",
    await page.locator("#detail-modal button:has-text('Count In the Delivery')").count() === 0 &&
    await page.locator("#detail-modal button:has-text('Approve Order')").count() === 0 &&
    await page.locator("#panel-po-receive").count() === 0 &&
    /The clerk prints it and sends it to the supplier/.test(await page.textContent("#detail-modal")));
  await page.selectOption("#po-status", "all");
  await page.click("#detail-modal .modal-close");
  await page.waitForTimeout(200);
  await page.evaluate("openSaleDetail(1000)");
  await page.waitForTimeout(500);
  check("the order's buttons do not follow into the next popup",
    await page.locator("#detail-modal [data-detail-foot]").count() === 0);
  await page.click("#detail-modal .modal-close");
  await page.waitForTimeout(200);

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

  // ---------- 9b. an alert opens as a card of its own ----------
  await page.evaluate(`fetch('/api/test/alerts', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })`);
  await page.waitForTimeout(300);
  await page.evaluate("openNotifications()");
  await page.waitForTimeout(600);
  await page.evaluate("clearCards()");
  const alerts = await page.locator("#notif-list .notif-item").count();
  check("the bell lists the alerts", alerts === 3, `saw ${alerts}`);
  check("the unread ones are marked", await page.locator("#notif-list .notif-item.unread").count() === 2);

  await page.click("#notif-list .notif-item:has-text('Purchase order #216')");
  await page.waitForTimeout(600);
  check("pressing an alert opens it as a card",
    await page.locator("#notif-modal.open").count() === 1 &&
    (await page.textContent("#notif-modal-title")).includes("Purchase order #216"));
  check("the card is headed with what the alert is for",
    (await page.textContent("#notif-modal-kind")).trim() === "Purchase order" &&
    /order to a supplier/.test(await page.textContent("#notif-modal-sub")));
  check("it reads like a mail: sender and date on one line, the message under them",
    (await page.textContent(".mail-from-name")).trim() === "Manager M. User" &&
    /ago|Today|Yesterday/i.test(await page.textContent(".mail-when")) &&
    (await page.textContent(".mail-body")).includes("Check the goods against it"));
  check("the list behind the bell stepped aside",
    await page.locator("#notif-drop").isHidden());
  await shot("16b-alert-card");

  await page.click("#notif-modal-foot button:has-text('Close')");
  await page.waitForTimeout(300);
  await page.evaluate("openNotifications()");
  await page.waitForTimeout(500);
  check("opening an alert is what marks it read",
    await page.locator("#notif-list .notif-item.unread").count() === 1 &&
    !(await page.locator("#notif-list .notif-item:has-text('Purchase order #216')").evaluate(
      (el) => el.classList.contains("unread"))));
  await page.evaluate("closeNotifications()");
  await page.evaluate(`fetch('/api/test/alerts', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) })`);
  await page.waitForTimeout(300);

  // ---------- 10. records and archives ----------
  await page.evaluate("showRecords()");
  await page.waitForTimeout(300);
  await page.click("#panel-records button:has-text('Load Data')");
  await page.waitForTimeout(600);
  check("records page ten at a time",
    await page.locator("#records-table tbody tr:not(.row-filler)").count() === 10);

  check("the kinds of record fold open under Records in the menu, with the one showing marked",
    await page.locator("#records-dropdown a[data-panel-view]").count() === 5 &&
    (await page.textContent("#records-dropdown a.active")).trim() === "Suppliers");
  if (!(await page.locator("#records-dropdown").isVisible())) {
    await page.click("#records-nav");
    await page.waitForTimeout(200);
  }
  await page.click("#records-dropdown a:has-text('Customers')");
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
    await page.locator("#archives-table tbody tr:not(.row-filler)").count() === 10);
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
