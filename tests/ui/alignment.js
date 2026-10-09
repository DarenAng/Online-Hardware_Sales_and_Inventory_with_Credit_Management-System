// Checks that figures read down their column: on every screen of all five
// dashboards, with every table loaded, each numeric cell and the heading over
// it sit to the right. A numeric cell is one marked cell-num, or one that
// reads as an amount of money (₱1,200.00). It also checks the rule for typed
// amounts: a number box is right-aligned, and the order's − / + quantity box
// is not.
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

// only console lines this system caused: the font CDN and the favicon are noise
function isOurProblem(text) {
  return !/fonts\.(googleapis|gstatic)\.com|favicon|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(String(text));
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
  page.on("pageerror", (e) => problems.push(`[${role}] page error: ` + e.message));
  page.on("console", (m) => { if (m.type() === "error" && isOurProblem(m.text())) problems.push(`[${role}] ` + m.text()); });
  return { context, page };
}

const DASHBOARDS = [
  ["System Administrator", "Admin S. User", 1, "system.html"],
  ["Manager", "Manager M. User", 2, "manager.html"],
  ["Inventory Clerk", "Clerk I. User", 3, "inventory-dashboard.html"],
  ["Cashier", "Cashier C. User", 4, "cashier-dashboard.html"],
  ["Delivery Personnel", "Driver D. User", 5, "delivery.html"]
];

// every figure in the tables showing now, and whether it and its heading sit right
function misalignedFigures() {
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const right = (el) => ["right", "end"].includes(getComputedStyle(el).textAlign);
  const money = /^[−-]?\s?₱\s?-?[\d,]+(\.\d+)?$/;

  const wrong = new Set();
  let checked = 0;

  document.querySelectorAll("[data-panel] table").forEach((table) => {
    if (!shown(table) || !table.tHead || !table.tHead.rows.length || !table.tBodies.length) return;
    const heads = table.tHead.rows[0].cells;
    const name = table.id || (table.closest("[data-panel]") || {}).id || "a table";

    for (const row of table.tBodies[0].rows) {
      if (row.cells.length !== heads.length) continue;     // a "nothing loaded" row
      Array.from(row.cells).forEach((cell, index) => {
        if (!shown(cell) || cell.classList.contains("col-hidden")) return;
        const text = cell.textContent.trim().replace(/\s+/g, " ");
        if (!cell.classList.contains("cell-num") && !money.test(text)) return;

        checked += 1;
        const heading = heads[index];
        if (!right(cell)) {
          wrong.add(`${name}: "${text}" under "${heading.textContent.trim()}" is ${getComputedStyle(cell).textAlign}`);
        }
        if (!right(heading)) {
          wrong.add(`${name}: the heading "${heading.textContent.trim()}" over "${text}" is ${getComputedStyle(heading).textAlign}`);
        }
      });
    }
  });

  return { wrong: [...wrong], checked };
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(fs.existsSync(bundled) ? { executablePath: bundled } : {});
  const problems = [];

  for (const [role, fullName, staffId, file] of DASHBOARDS) {
    const { context, page } = await pageFor(browser, role, fullName, staffId, problems);
    await page.goto(`${BASE}/${file}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);

    // every menu entry the role holds, including the ones inside a folded list
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[data-panel-link]"))
        .map((link, index) => ({ index, held: !link.closest("[hidden]") &&
          !(link.closest("li") && getComputedStyle(link.closest("li")).display === "none") }))
        .filter((link) => link.held)
        .map((link) => link.index));

    let screens = 0;
    let figures = 0;
    const wrong = new Set();

    for (const index of links) {
      await page.evaluate((i) => document.querySelectorAll("a[data-panel-link]")[i].click(), index);
      await page.waitForTimeout(250);

      // Load Data (and the driver's Load Report) on whatever this screen shows
      const loaders = page.locator("[data-panel] button:visible", { hasText: /^\s*(Load Data|Load Report)\s*$/ });
      const count = await loaders.count();
      for (let n = 0; n < count; n += 1) {
        try { await loaders.nth(n).click({ timeout: 2000 }); } catch (error) { /* covered by a popup; skip */ }
      }
      if (count > 0) await page.waitForTimeout(600);

      // a popup opened by a screen would sit over the next one
      await page.evaluate(() => {
        document.querySelectorAll(".modal.open").forEach((modal) => modal.classList.remove("open"));
      });

      const found = await page.evaluate(misalignedFigures);
      found.wrong.forEach((line) => wrong.add(line));
      figures += found.checked;
      screens += 1;
    }

    await page.screenshot({ path: path.join(OUT, file.replace(".html", "") + ".png"), fullPage: true });

    check(`${file}: every screen was opened and loaded`, screens > 0, `${screens} screens`);
    check(`${file}: figures were found to check`, figures > 0, `${figures} figures`);
    check(`${file}: every figure and its heading sit to the right`,
      wrong.size === 0, [...wrong].slice(0, 6).join(" | "));

    // the typed-amount rule, on the till
    if (file === "cashier-dashboard.html") {
      const boxes = await page.evaluate(() => {
        const amount = document.getElementById("pay-amount");
        // a quantity box as the order draws one, to read the rule it gets
        const line = document.createElement("div");
        line.className = "cart-line";
        line.innerHTML = '<div class="cart-qty"><input type="number" class="qty-input" value="2"></div>';
        (document.getElementById("cart-lines") || document.body).appendChild(line);
        const qty = line.querySelector("input");
        const result = {
          amount: getComputedStyle(amount).textAlign,
          amountFigures: getComputedStyle(amount).fontVariantNumeric,
          qty: getComputedStyle(qty).textAlign
        };
        line.remove();
        return result;
      });
      check("a typed amount is right-aligned with tabular figures",
        boxes.amount === "right" && /tabular-nums/.test(boxes.amountFigures), JSON.stringify(boxes));
      check("the order's − / + quantity box keeps its own alignment",
        boxes.qty !== "right", JSON.stringify(boxes));
    }

    await context.close();
  }

  await browser.close();

  console.log("\n--- console problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
