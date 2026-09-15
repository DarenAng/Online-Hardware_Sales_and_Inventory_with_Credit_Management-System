// Two filter changes in a row start a second load while the first is out.
// The panel used to drop the second (dropdowns said one thing, the table
// another) and a late answer could overwrite newer rows. Both are silent,
// so they are provoked here several times over.
//
// Run through tests/ui/run-all.sh, which starts the stub first.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3311";
const SHOTS = path.join(__dirname, "..", "..", "shots", "ui");

const results = [];
function check(name, passed, note) {
  results.push({ name, passed });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || !note ? "" : "  -- " + note}`);
}

async function signedInPage(context, role, fullName, staffId) {
  await context.addInitScript(([r, n, s]) => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: s, user_id: s, first_name: n.split(" ")[0], last_name: "User",
      full_name: n, email: r.toLowerCase().replace(/ /g, "") + "@hardware.com",
      role_name: r, must_change_password: false
    }));
  }, [role, fullName, staffId]);

  return context.newPage();
}

(async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  // the same bundled Chromium the other suites use, when this machine has one
  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(bundled) ? { executablePath: bundled } : {});

  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await signedInPage(context, "Manager", "Manager User", 2);

  await page.goto(`${BASE}/manager-dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate("showSales()");
  await page.waitForTimeout(400);
  await page.evaluate("dataPanelOpen('mgr-sales')");
  await page.waitForTimeout(900);

  check("the sales table loads", await page.locator("#sales-table tbody tr").count() > 0);

  // ---------- two filter changes with no pause between them ----------
  // six runs: a race that only shows up sometimes slips past a single run
  let disagreed = 0;

  for (let run = 1; run <= 6; run += 1) {
    await page.selectOption("#sales-method", "all");
    await page.selectOption("#sales-status", "Pending Delivery");   // no wait between
    await page.waitForTimeout(900);

    const shown = await page.locator("#sales-table tbody tr td:nth-child(5)").allTextContents();
    const distinct = [...new Set(shown.map((text) => text.trim()))];
    const agrees = shown.length > 0 && distinct.length === 1 && distinct[0] === "Pending Delivery";

    if (!agrees) disagreed += 1;
    console.log(`       run ${run}: controls say "Pending Delivery", table shows ` +
      `${distinct.join(" / ") || "(nothing)"}`);

    await page.selectOption("#sales-status", "all");
    await page.waitForTimeout(700);
  }

  check("the table agrees with the filters after a fast pair of changes",
    disagreed === 0, `${disagreed} of 6 runs showed rows the filters excluded`);

  // ---------- and a burst of changes still settles on the last one ----------
  await page.selectOption("#sales-status", "Completed");
  await page.selectOption("#sales-status", "Voided");
  await page.selectOption("#sales-status", "Pending Delivery");
  await page.waitForTimeout(1200);

  const settled = await page.locator("#sales-table tbody tr td:nth-child(5)").allTextContents();
  const settledDistinct = [...new Set(settled.map((text) => text.trim()))];
  check("a burst of changes settles on the last one",
    settled.length > 0 && settledDistinct.length === 1 && settledDistinct[0] === "Pending Delivery",
    settledDistinct.join(" / ") || "(nothing)");

  await page.screenshot({ path: path.join(SHOTS, "filters-01-settled.png") });

  await browser.close();

  const failed = results.filter((r) => !r.passed);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
})();
