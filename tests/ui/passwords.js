// Checks the ways back in when a password is lost and the administrator is
// not there: "Forgot your password?" on the sign-in page (a code by email,
// then the code and a new password), and the manager's Staff Passwords
// screen, which lists counter, stockroom and delivery staff only.
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

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(fs.existsSync(bundled) ? { executablePath: bundled } : {});
  const problems = [];
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ======================================================== SIGN-IN PAGE
  const signInContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const login = await signInContext.newPage();
  login.on("pageerror", (e) => problems.push("[sign-in] page error: " + e.message));
  // the wrong code below is refused with a 400 on purpose; that one is not a problem
  login.on("console", (m) => {
    if (m.type() === "error" && isOurProblem(m.text()) && !/status of 400/.test(m.text())) problems.push("[sign-in] " + m.text());
  });

  await login.goto(`${BASE}/Login.html`, { waitUntil: "domcontentloaded" });
  await login.waitForTimeout(500);

  check("the sign-in page offers Forgot your password?",
    await login.locator("#forgot-link").isVisible());
  check("the second card starts hidden", !(await login.locator("#reset-card").isVisible()));

  await login.fill("#login-email", "pedro@hardware.com");
  await login.click("#forgot-link");
  await login.waitForTimeout(200);
  check("the link swaps the sign-in card for the reset card",
    await login.locator("#reset-card").isVisible() && !(await login.locator("#sign-in-card").isVisible()));
  check("the address already typed is carried over",
    (await login.inputValue("#reset-email")) === "pedro@hardware.com");
  await shot(login, "01-reset-email");

  await login.click("#reset-request-btn");
  await login.waitForTimeout(500);
  check("asking for a code gives the same reply for any address",
    /If that address belongs to an account here/.test(await login.textContent("#reset-alert")));
  check("the second step asks for the code and the new password",
    await login.locator("#reset-confirm-form").isVisible() &&
    !(await login.locator("#reset-request-form").isVisible()));
  await shot(login, "02-reset-code");

  // the screen checks the obvious before the server is asked
  await login.fill("#reset-code", "12345");
  await login.fill("#reset-new-password", "A-new-password-1");
  await login.fill("#reset-confirm-password", "A-new-password-1");
  await login.click("#reset-confirm-btn");
  await login.waitForTimeout(200);
  check("a code that is not six digits is refused on the screen",
    /six digits/.test(await login.textContent("#reset-alert")));

  await login.fill("#reset-code", "123456");
  await login.fill("#reset-confirm-password", "something-else");
  await login.click("#reset-confirm-btn");
  await login.waitForTimeout(200);
  check("two different passwords are refused on the screen",
    /do not match/.test(await login.textContent("#reset-alert")));

  await login.fill("#reset-code", "999999");
  await login.fill("#reset-new-password", "A-new-password-1");
  await login.fill("#reset-confirm-password", "A-new-password-1");
  await login.click("#reset-confirm-btn");
  await login.waitForTimeout(400);
  check("a wrong code is refused without saying whether the account exists",
    /not right, or it has stopped working/.test(await login.textContent("#reset-alert")));

  await login.fill("#reset-code", "123456");
  await login.fill("#reset-new-password", "A-new-password-1");
  await login.fill("#reset-confirm-password", "A-new-password-1");
  await login.click("#reset-confirm-btn");
  await login.waitForTimeout(400);
  check("the right code saves the password and returns to sign in",
    await login.locator("#sign-in-card").isVisible() && !(await login.locator("#reset-card").isVisible()));
  check("with the news beside the form and the address filled in",
    /password was changed/i.test(await login.textContent("#login-alert")) &&
    (await login.inputValue("#login-email")) === "pedro@hardware.com");
  await shot(login, "03-reset-done");

  await signInContext.close();

  // ======================================================== MANAGER
  const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await managerContext.addInitScript(() => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: 2, user_id: 2, first_name: "Manager", last_name: "User", full_name: "Manager M. User",
      email: "manager@hardware.com", role_name: "Manager", must_change_password: false
    }));
  });
  const manager = await managerContext.newPage();
  manager.on("pageerror", (e) => problems.push("[manager] page error: " + e.message));
  manager.on("console", (m) => { if (m.type() === "error" && isOurProblem(m.text())) problems.push("[manager] " + m.text()); });

  await manager.goto(`${BASE}/manager.html`, { waitUntil: "domcontentloaded" });
  await manager.waitForTimeout(900);

  check("the manager's menu has Staff Passwords",
    await manager.locator("a:has-text('Staff Passwords')").isVisible());

  await manager.click("a:has-text('Staff Passwords')");
  await manager.waitForTimeout(300);
  check("the list starts closed",
    /Not loaded/i.test(await manager.textContent("#staff-passwords-count")));

  await manager.click("#panel-staff-passwords button:has-text('Load Data')");
  await manager.waitForTimeout(600);
  const roles = await manager.$$eval("#staff-passwords-table tbody tr td:nth-child(2)",
    (cells) => [...new Set(cells.map((cell) => cell.textContent.trim()))]);
  check("it lists cashiers, clerks and drivers",
    roles.length > 0 && roles.every((role) => ["Cashier", "Inventory Clerk", "Delivery Personnel"].includes(role)),
    roles.join(", "));
  check("and never a Manager or an administrator",
    !roles.includes("Manager") && !roles.includes("System Administrator"));
  await shot(manager, "04-staff-passwords");

  // the server refuses a manager's account whatever the screen sends (asked from
  // outside the page, so the refusal is not a console error on it)
  const refused = (await managerContext.request.post(`${BASE}/api/staff/2/reset-password`, { data: {} })).status();
  check("resetting a Manager's password is refused", refused === 403, `status ${refused}`);

  // an odd id stands in for a mail that could not go: the password is shown once
  const oddId = await manager.evaluate(() => {
    const panel = getDataPanel("mgr-staff-passwords");
    const row = panel.rows.find((r) => r.staff_id % 2 === 1);
    return row ? row.staff_id : null;
  });
  await manager.evaluate((id) => { resetStaffPassword(id); }, oddId);
  await manager.waitForTimeout(300);
  check("a reset asks first", /Reset this password/.test(await manager.textContent("#ask-title")));
  await manager.click("#ask-ok");
  await manager.waitForTimeout(600);
  check("a password that could not be emailed is shown once to hand over",
    /not sent/.test(await manager.textContent("#ask-title")) &&
    /Stub7Pass!word/.test(await manager.textContent("#ask-detail")));
  await shot(manager, "05-staff-password-shown-once");
  await manager.evaluate("closeAsk(true)");

  await managerContext.close();
  await browser.close();

  console.log("\n--- console problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
