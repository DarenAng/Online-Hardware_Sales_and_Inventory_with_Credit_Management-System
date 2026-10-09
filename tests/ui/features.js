// Access Control, end to end against the stub: a role is picked at the top,
// its line of switches turns a screen on and off, the menu follows over the
// live channel, and the counts are mirrored onto the heading and the top bar.
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

  // ---------- 1. the manager's menu, as the page writes it ----------
  const manager = await screenFor(browser, "Manager", "Manager M. User", 2, "manager.html", problems);
  const m = manager.tab;

  check("the Credit heading starts folded",
    (await m.locator("#credit-dropdown:visible").count()) === 0);
  await shot(m, "01-manager-menu-folded");

  await m.click("#credit-nav");
  await m.waitForTimeout(300);
  check("opening the heading's caret shows the Extension Requests item",
    (await m.locator('#credit-dropdown a[data-panel-link="panel-credit-requests"]:visible').count()) === 1);
  await shot(m, "02-manager-menu-open");

  await m.click('a[data-panel-link="panel-credit-requests"]');
  await m.waitForTimeout(400);
  check("the menu item opens the screen it names",
    (await m.locator("#panel-credit-requests:visible").count()) === 1);

  check("the manager holds the Delivery Schedule by role, under the Deliveries heading",
    (await m.locator('#deliveries-dropdown li[data-feature="delivery-schedule"]:not([hidden])').count()) === 1);

  // ---------- 2. the cashier before anything is switched ----------
  const cashier = await screenFor(browser, "Cashier", "Cashier C. User", 4, "cashier-dashboard.html", problems);
  const c = cashier.tab;

  check("the cashier does not see the Delivery Schedule until it is granted",
    (await c.locator('.sidebar-nav li[data-feature="delivery-schedule"]:visible').count()) === 0);
  check("the cashier's Refunds item is under Point of Sale",
    (await c.locator('#pos-dropdown li[data-feature="refunds"]:not([hidden])').count()) === 1);

  // ---------- 3. the administrator's Access Control page ----------
  const admin = await screenFor(browser, "System Administrator", "Admin S. User", 1, "system.html", problems);
  const a = admin.tab;

  check("Access Control is one link in the menu, with no list under it",
    (await a.locator('.sidebar-nav a[data-panel-link="panel-features"]').count()) === 1 &&
    (await a.locator("#access-dropdown").count()) === 0);

  await a.click('a[data-panel-link="panel-features"]');
  await a.waitForTimeout(800);

  check("the top bar names the screen as the menu does",
    (await a.locator("#admin-page-title").textContent()).trim() === "Access Control");

  const cells = await a.locator("#features-matrix .feature-box").count();
  check("every role's switches are drawn from the catalogue", cells > 20, `${cells} switches`);
  check("only the picked role's line is showing",
    (await a.locator("#features-matrix .feature-strip:not([hidden])").count()) === 1);
  check("a screen a dashboard cannot draw is not on the role's line",
    (await a.locator('.feature-strip:not([hidden]) .feature-box[data-feature="delivery-runs"]').count()) === 0);
  check("Save is dead until something moves",
    await a.locator("#features-save-btn").isDisabled());
  await shot(a, "04-admin-manager-line");

  // pick the cashier from the roles down the right-hand column
  check("the roles are listed beside the screens",
    (await a.locator("#features-role .role-pick").count()) === 4);
  const cashierPick = a.locator("#features-role .role-pick", { hasText: "Cashier" });
  const cashierRoleId = await cashierPick.getAttribute("data-role");
  await cashierPick.click();
  await a.waitForTimeout(300);
  check("picking a role shows that role's screens",
    (await a.locator('.feature-strip:not([hidden])[data-role="' + cashierRoleId + '"]').count()) === 1 &&
    (await a.locator('.feature-strip:not([hidden]) .feature-box[data-feature="pos"]').count()) === 1 &&
    (await cashierPick.getAttribute("aria-selected")) === "true");
  await shot(a, "04b-admin-cashier-line");

  await a.locator('.feature-box[data-feature="delivery-schedule"][data-role-name="Cashier"]').check({ force: true });
  await a.locator('.feature-box[data-feature="refunds"][data-role-name="Cashier"]').uncheck({ force: true });
  await a.waitForTimeout(200);

  check("the word under a switch says what it now means",
    (await a.locator('.feature-box[data-feature="delivery-schedule"][data-role-name="Cashier"] ~ .feature-state').textContent()).trim() === "switched on" &&
    (await a.locator('.feature-box[data-feature="refunds"][data-role-name="Cashier"] ~ .feature-state').textContent()).trim() === "switched off");
  check("Save comes alive once something moves",
    !(await a.locator("#features-save-btn").isDisabled()));
  check("the role carries a mark while its changes are unsaved",
    (await a.locator('#features-role .role-pick[data-role="' + cashierRoleId + '"] .role-pick-mark:not([hidden])').count()) === 1);

  await a.click("#features-save-btn");
  await a.waitForTimeout(400);
  const askText = await a.locator("#ask-modal.open, .ask-card, .modal.open").first().textContent().catch(() => "");
  check("saving reads the changes back first, and says a screen is being taken away",
    /Refunds/.test(askText) && /Delivery Schedule/.test(askText) && /off/i.test(askText),
    askText.slice(0, 160));
  await shot(a, "05-admin-confirm");

  await a.locator("button", { hasText: /^Save screens$/ }).click();
  await a.waitForTimeout(1200);
  check("the switched screens say they differ from the role's default",
    await a.locator("#features-matrix .feature-state:not([hidden])").count() >= 1);
  await shot(a, "06-admin-saved");

  // ---------- 4. the cashier's menu follows, with no reload ----------
  await c.waitForTimeout(1500);
  check("the cashier's menu now offers the Delivery Schedule",
    (await c.locator('.sidebar-nav li[data-feature="delivery-schedule"]:visible').count()) === 1);
  check("the Refunds item has left the Point of Sale list",
    (await c.locator('#pos-dropdown li[data-feature="refunds"]:not([hidden])').count()) === 0);
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
