// Two browsers, one server: a change made on one machine reaching the other.
// Also checks that a table being read is NOT redrawn, and that a browser
// ignores the change it caused itself.
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

async function screenFor(browser, role, fullName, staffId, page, problems) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(([r, n, s]) => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: s, user_id: s, first_name: n.split(" ")[0], last_name: "User",
      full_name: n, email: "x@hardware.com", role_name: r, must_change_password: false
    }));
  }, [role, fullName, staffId]);

  const tab = await context.newPage();
  tab.on("console", (m) => { if (m.type() === "error") if (isOurProblem(m.text())) problems.push(`[${role}] ` + m.text()); });
  tab.on("pageerror", (e) => problems.push(`[${role}] page error: ` + e.message));

  // not networkidle: the live channel never goes idle
  await tab.goto(`${BASE}/${page}`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(1400);
  return { context, tab };
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
  const shot = (tab, name) => tab.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ---------- desktop one: the manager, watching the stock report ----------
  const one = await screenFor(browser, "Manager", "Manager M. User", 2,
    "manager-dashboard.html", problems);

  // the connection dot was removed; the state is read from liveState and the
  // server's count of open connections
  check("the screen is hearing about changes",
    (await one.tab.evaluate("liveState")) === "live",
    String(await one.tab.evaluate("liveState")));
  check("and the server sees the connection",
    Number(await one.tab.evaluate(
      "fetch('/api/events/status').then((r) => r.json()).then((d) => d.connections)")) >= 1);
  check("and nothing about it is printed on the top bar",
    (await one.tab.locator("#live-dot").count()) === 0,
    "the live indicator is still being drawn");
  await shot(one.tab, "01-connected");

  await one.tab.evaluate("showStockReport()");
  await one.tab.waitForTimeout(300);
  await one.tab.click("#panel-stock-report button:has-text('Load Data')");
  await one.tab.waitForTimeout(700);

  check("the stock report is loaded and on page one",
    (await one.tab.locator("#stocks-table tbody tr").count()) === 10 &&
    Number(await one.tab.evaluate("getDataPanel('mgr-stocks').page")) === 1);

  // counting refreshes rather than comparing a row: the test is that this screen looked again
  await one.tab.evaluate(`(function () {
      window.__managerRefreshes = 0;
      const panel = getDataPanel('mgr-stocks');
      const real = panel.refresh.bind(panel);
      panel.refresh = function () { window.__managerRefreshes += 1; return real(); };
  })()`);

  // ---------- desktop two: the clerk, changing stock ----------
  const two = await screenFor(browser, "Inventory Clerk", "Clerk I. User", 3,
    "inventory-dashboard.html", problems);

  check("the second screen is hearing about changes too",
    (await two.tab.evaluate("liveState")) === "live",
    String(await two.tab.evaluate("liveState")));

  const before = Number(await one.tab.evaluate("liveVersion"));

  // the clerk's machine changes a reorder policy — any inventory write will do
  await two.tab.evaluate(`fetch('/api/stocks/1/reorder-policy', {
      method: 'PUT', headers: apiHeaders(),
      body: JSON.stringify({ leadTimeDays: 9, safetyStock: 4, reorderMode: 'Dynamic' })
  }).then((r) => r.json())`);
  await two.tab.waitForTimeout(1200);

  const after = Number(await one.tab.evaluate("liveVersion"));
  check("a change on one desktop reaches the other",
    after > before, `version ${before} -> ${after}`);

  // the manager was not touching anything, so the table refreshed itself
  await one.tab.waitForTimeout(600);
  check("the untouched table refreshed itself",
    Number(await one.tab.evaluate("window.__managerRefreshes")) >= 1,
    `${await one.tab.evaluate("window.__managerRefreshes")} refresh(es)`);
  check("and it was not left with a note to press",
    await one.tab.locator("#stocks-pager .stale-note").count() === 0);
  check("and it said so without a popup",
    await one.tab.locator(".toast-deck .toast-card").count() === 0);
  await shot(one.tab, "02-refreshed");

  // ---------- a browser ignores its own writes ----------
  const ownBefore = await two.tab.evaluate(`(function () {
      window.__refreshes = 0;
      const panel = getDataPanel('clerk-materials');
      if (!panel) return -1;
      const real = panel.refresh.bind(panel);
      panel.refresh = function () { window.__refreshes += 1; return real(); };
      return 0;
  })()`);
  check("the clerk's materials panel is instrumented", ownBefore === 0);

  await two.tab.click("#panel-inventory button:has-text('Load Data')");
  await two.tab.waitForTimeout(700);

  await two.tab.evaluate(`fetch('/api/stocks/2/reorder-policy', {
      method: 'PUT', headers: apiHeaders(),
      body: JSON.stringify({ leadTimeDays: 6, safetyStock: 2, reorderMode: 'Manual' })
  }).then((r) => r.json())`);
  await two.tab.waitForTimeout(1200);

  check("a browser does not refresh on its own write",
    Number(await two.tab.evaluate("window.__refreshes")) === 0,
    `${await two.tab.evaluate("window.__refreshes")} refresh(es)`);

  // ...but the other desktop, which did not make it, does hear about it
  await one.tab.waitForTimeout(500);
  check("while the other desktop still hears about it",
    Number(await one.tab.evaluate("liveVersion")) > after);

  // ---------- a table being read is not redrawn underneath ----------
  await one.tab.evaluate("getDataPanel('mgr-stocks').goTo(2)");
  await one.tab.waitForTimeout(400);
  const pageTwo = await one.tab.textContent("#stocks-table tbody tr:first-child");

  await two.tab.evaluate(`fetch('/api/test/change', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'inventory', detail: 'a third machine' })
  })`);
  await one.tab.waitForTimeout(1200);

  check("a reader past page one is not redrawn under",
    (await one.tab.textContent("#stocks-table tbody tr:first-child")) === pageTwo);
  check("they are told instead, in the table's own footer",
    await one.tab.locator("#stocks-pager .stale-note").count() === 1);
  check("and the note says which records moved",
    /inventory records/.test(await one.tab.textContent("#stocks-pager .stale-note")));
  await shot(one.tab, "03-stale-note");

  await one.tab.click("#stocks-pager .stale-note button");
  await one.tab.waitForTimeout(900);
  check("pressing Refresh clears the note",
    await one.tab.locator("#stocks-pager .stale-note").count() === 0);
  await shot(one.tab, "04-after-refresh");

  // ---------- a popup open is also a person mid-task ----------
  await one.tab.evaluate("getDataPanel('mgr-stocks').goTo(1)");
  await one.tab.waitForTimeout(300);
  await one.tab.click("#stocks-table tbody tr:first-child");
  await one.tab.waitForTimeout(500);
  check("a record is open", await one.tab.locator("#detail-modal.open").count() === 1);

  await two.tab.evaluate(`fetch('/api/test/change', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'inventory', detail: 'while a popup is open' })
  })`);
  await one.tab.waitForTimeout(1200);

  check("nothing is redrawn while a popup is open",
    await one.tab.locator("#detail-modal.open").count() === 1 &&
    await one.tab.locator("#stocks-pager .stale-note").count() === 1);
  await shot(one.tab, "05-popup-protected");

  await one.tab.evaluate("closeModal('detail-modal')");

  // ---------- a lost connection ----------
  await one.tab.evaluate("liveSource.close(); setLiveIndicator('down', 'Offline');");
  await one.tab.waitForTimeout(400);
  check("a lost connection is noticed",
    (await one.tab.evaluate("liveState")) === "down",
    String(await one.tab.evaluate("liveState")));
  await shot(one.tab, "06-offline");

  await one.context.close();
  await two.context.close();
  await browser.close();

  console.log("\n--- console problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
