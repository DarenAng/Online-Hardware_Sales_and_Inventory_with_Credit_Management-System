// Screens by Role, end to end against the stub: the matrix switches a screen
// on and off, the menu follows over the live channel, and the counts are
// mirrored onto the heading and the top bar.
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

function isOurProblem(text) {
  return !/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(String(text));
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

  await tab.goto(`${BASE}/${page}`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(1400);
  return { context, tab };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(bundled) ? { executablePath: bundled } : {});

  const problems = [];
  const shot = (tab, name) => tab.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // every run starts from the pages' own menus
  await fetch(`${BASE}/api/test/features/reset`, { method: "POST" });

  // ---------- 1. the manager's counts, without opening anything ----------
  const manager = await screenFor(browser, "Manager", "Manager M. User", 2, "manager-dashboard.html", problems);
  const m = manager.tab;

  check("the Credit heading starts folded",
    (await m.locator("#credit-dropdown:visible").count()) === 0);
  check("the count on Extension Requests is mirrored onto the Credit heading while it is folded",
    (await m.locator("#credit-nav .nav-count-parent.is-waiting").textContent()).trim() === "2",
    await m.locator("#credit-nav").textContent());
  check("the Stocks heading carries the reorder count the same way",
    (await m.locator("#stocks-nav .nav-count-parent.is-waiting").textContent()).trim() === "3");
  check("the top bar adds every count on the menu up",
    (await m.locator("#pending-chip:visible").count()) === 1 &&
    (await m.locator("#pending-chip-count").textContent()).trim() === "10",
    await m.locator("#pending-chip").textContent());
  await shot(m, "01-manager-counts-folded");

  await m.click("#credit-nav");
  await m.waitForTimeout(300);
  check("opening the heading shows the item's own badge and steps the heading's copy aside",
    (await m.locator("#credit-request-count.is-waiting:visible").count()) === 1 &&
    (await m.locator("#credit-nav .nav-count-parent:visible").count()) === 0);
  await shot(m, "02-manager-counts-open");

  await m.click("#pending-chip");
  await m.waitForTimeout(300);
  const rows = await m.locator("#pending-drop:visible .pending-row").allTextContents();
  check("the chip opens to a list of what is waiting where",
    rows.length === 4 && rows.some((r) => /Extension Requests/.test(r) && /waiting for your decision/.test(r)),
    rows.join(" | "));
  await shot(m, "03-manager-waiting-list");

  await m.locator("#pending-drop .pending-row", { hasText: "Extension Requests" }).click();
  await m.waitForTimeout(400);
  check("a line on the list opens the screen it names",
    (await m.locator("#panel-credit-requests:visible").count()) === 1 &&
    (await m.locator("#pending-drop:visible").count()) === 0);

  check("the manager holds the Delivery Schedule by role, under the Deliveries heading",
    (await m.locator('#deliveries-dropdown li[data-feature="delivery-schedule"]:not([hidden])').count()) === 1 &&
    (await m.locator("#deliveries-nav .nav-count-parent.is-waiting").textContent()).trim() === "5" &&
    /not yet sent out/.test(await m.locator("#deliveries-nav .nav-count-parent").getAttribute("title")));
  check("every count says in words what it counts",
    /credit requests waiting for your decision/.test(await m.locator("#credit-request-count").getAttribute("title")));

  // ---------- 2. the cashier before anything is switched ----------
  const cashier = await screenFor(browser, "Cashier", "Cashier C. User", 4, "cashier-dashboard.html", problems);
  const c = cashier.tab;

  check("the cashier does not see the Delivery Schedule until it is granted",
    (await c.locator('.sidebar-nav li[data-feature="delivery-schedule"]:visible').count()) === 0);
  check("the cashier's Refunds item is under Point of Sale",
    (await c.locator('#pos-dropdown li[data-feature="refunds"]:not([hidden])').count()) === 1);

  // ---------- 3. the administrator's matrix ----------
  const admin = await screenFor(browser, "System Administrator", "Admin S. User", 1, "system.html", problems);
  const a = admin.tab;

  await a.click("#access-nav");
  await a.click('a[data-panel-link="panel-features"]');
  await a.waitForTimeout(800);

  const cells = await a.locator("#features-matrix .feature-box").count();
  check("the matrix is drawn from the catalogue", cells > 20, `${cells} switches`);
  check("a screen a dashboard cannot draw is a dash, not a switch",
    (await a.locator("#features-matrix .feature-cell.is-unavailable").count()) > 0);
  check("Save is dead until something moves",
    await a.locator("#features-save-btn").isDisabled());
  await shot(a, "04-admin-matrix");

  await a.locator('.feature-box[data-feature="delivery-schedule"][data-role-name="Cashier"]').check({ force: true });
  await a.locator('.feature-box[data-feature="refunds"][data-role-name="Cashier"]').uncheck({ force: true });
  await a.waitForTimeout(200);

  check("the word under a switch says what it now means",
    (await a.locator('.feature-box[data-feature="delivery-schedule"][data-role-name="Cashier"] ~ .feature-state').textContent()).trim() === "switched on" &&
    (await a.locator('.feature-box[data-feature="refunds"][data-role-name="Cashier"] ~ .feature-state').textContent()).trim() === "switched off");
  check("Save comes alive once something moves",
    !(await a.locator("#features-save-btn").isDisabled()));

  await a.click("#features-save-btn");
  await a.waitForTimeout(400);
  const askText = await a.locator("#ask-modal.open, .ask-card, .modal.open").first().textContent().catch(() => "");
  check("saving reads the changes back first, and says a screen is being taken away",
    /Refunds/.test(askText) && /Delivery Schedule/.test(askText) && /off/i.test(askText),
    askText.slice(0, 160));
  await shot(a, "05-admin-confirm");

  await a.locator("button", { hasText: /^Save screens$/ }).click();
  await a.waitForTimeout(1200);
  check("the matrix says how many switches differ from the pages",
    /2 changed/.test(await a.locator("#features-count").textContent()),
    await a.locator("#features-count").textContent());
  await shot(a, "06-admin-saved");

  // ---------- 4. the cashier's menu follows, with no reload ----------
  await c.waitForTimeout(1500);
  check("the cashier's menu now offers the Delivery Schedule",
    (await c.locator('.sidebar-nav li[data-feature="delivery-schedule"]:visible').count()) === 1);
  check("the Refunds item has left the Point of Sale list",
    (await c.locator('#pos-dropdown li[data-feature="refunds"]:not([hidden])').count()) === 0);
  check("the granted screen's count reaches the top bar",
    (await c.locator("#pending-chip:visible").count()) === 1 &&
    (await c.locator("#pending-chip-count").textContent()).trim() === "4");
  await shot(c, "07-cashier-granted");

  await c.click('a[data-panel-link="panel-delivery-schedule"]');
  await c.click("#schedule-load-btn");
  await c.waitForTimeout(800);
  check("the schedule draws on a page that never had it",
    (await c.locator("#panel-delivery-schedule:visible").count()) === 1 &&
    (await c.locator(".schedule-row").count()) > 0);
  await shot(c, "08-cashier-schedule");

  // ---------- 5. taken away while the cashier is on it ----------
  await fetch(`${BASE}/api/features/delivery-schedule/roles/4`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ granted: false })
  });
  await c.waitForTimeout(1500);
  check("a screen switched off while somebody is on it sends them home and says why",
    (await c.locator('.sidebar-nav li[data-feature="delivery-schedule"]:visible').count()) === 0 &&
    (await c.locator("#panel-delivery-schedule:visible").count()) === 0 &&
    (await c.locator(".toast-deck, .card-deck, body").textContent()).includes("switched off"));
  await shot(c, "09-cashier-withdrawn");

  await fetch(`${BASE}/api/test/features/reset`, { method: "POST" });

  await manager.context.close();
  await cashier.context.close();
  await admin.context.close();
  await browser.close();

  console.log("\n--- console problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
