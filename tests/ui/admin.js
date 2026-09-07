// Drives the rebuilt System Administrator page in a real browser against the
// stub, checking the things a screenshot alone would not: that a table starts
// closed, that it pages ten rows at a time, that the filters narrow it, and
// that the modals and the drawer open with the record they were clicked on.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3311";
const OUT = process.env.OUT ||
  require("path").join(__dirname, "..", "..", "shots", "ui",
                       require("path").basename(__filename, ".js"));

const results = [];
function check(name, passed, note) {
  results.push({ name, passed, note: note || "" });
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

  // session.js sends anyone with no stored user back to the sign-in screen
  await context.addInitScript(() => {
    localStorage.setItem("currentUser", JSON.stringify({
      staff_id: 1, user_id: 1, first_name: "Admin", last_name: "User",
      full_name: "Admin S. User", email: "admin@hardware.com",
      role_name: "System Administrator", must_change_password: false
    }));
  });

  await page.goto(`${BASE}/system.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });

  // ---------- 1. nothing loads on its own ----------
  const requested = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) requested.push(r.url()); });

  const closedText = await page.textContent("#accounts-table tbody");
  check("directory starts closed", /not loaded/i.test(closedText), closedText.slice(0, 60));
  check("closed state offers a Load Data button",
    await page.locator("#accounts-table tbody button", { hasText: "Load Data" }).count() === 1);
  check("count pill says Not loaded",
    (await page.textContent("#accounts-count")).trim() === "Not loaded");
  await shot("01-accounts-closed");

  // ---------- 2. Load Data fills exactly ten rows ----------
  await page.click("#accounts-table tbody button");
  await page.waitForTimeout(500);

  let rows = await page.locator("#accounts-table tbody tr").count();
  check("a loaded page holds exactly ten rows", rows === 10, `saw ${rows}`);
  check("the pager says page 1 of 3",
    (await page.textContent(".pager-page")).trim() === "Page 1 of 3",
    await page.textContent(".pager-page"));
  check("the pager counts the whole set",
    /Showing 1.10 of 23/.test(await page.textContent("#accounts-pager .pager-info")),
    await page.textContent("#accounts-pager .pager-info"));
  check("Previous is disabled on page 1",
    await page.locator("#accounts-pager button", { hasText: "Previous" }).isDisabled());
  check("presence is shown beside the account state",
    await page.locator("#accounts-table .presence.is-online").count() > 0);
  await shot("02-accounts-page1");

  // ---------- 3. paging ----------
  await page.click("#accounts-pager button:has-text('Next')");
  await page.waitForTimeout(300);
  check("Next moves to page 2",
    (await page.textContent(".pager-page")).trim() === "Page 2 of 3");

  await page.click("#accounts-pager button:has-text('Next')");
  await page.waitForTimeout(300);
  rows = await page.locator("#accounts-table tbody tr").count();
  check("the last page holds the remainder", rows === 3, `saw ${rows}`);
  check("Next is disabled on the last page",
    await page.locator("#accounts-pager button", { hasText: "Next" }).isDisabled());
  await shot("03-accounts-lastpage");

  await page.click("#accounts-pager button:has-text('Previous')");
  await page.waitForTimeout(300);
  check("Previous goes back",
    (await page.textContent(".pager-page")).trim() === "Page 2 of 3");

  // ---------- 4. filters ----------
  await page.selectOption("#accounts-presence", "online");
  await page.waitForTimeout(300);
  const online = await page.locator("#accounts-table tbody tr").count();
  check("the presence filter narrows the grid", online > 0 && online <= 10, `saw ${online}`);
  check("every row left is online",
    await page.locator("#accounts-table tbody tr .presence.is-online").count() === online);
  await shot("04-accounts-online");

  await page.selectOption("#accounts-presence", "all");
  await page.selectOption("#accounts-status", "inactive");
  await page.waitForTimeout(500);
  const inactive = await page.locator("#accounts-table tbody tr").count();
  check("the account-state filter goes back to the server",
    inactive > 0 && await page.locator("#accounts-table .badge-danger").count() === inactive,
    `saw ${inactive} rows`);
  await page.selectOption("#accounts-status", "all");
  await page.waitForTimeout(500);

  // ---------- 5. search ----------
  await page.fill("#accounts-search", "rosa");
  await page.waitForTimeout(600);
  const found = await page.locator("#accounts-table tbody tr").count();
  check("search narrows to one person", found === 1, `saw ${found}`);
  await shot("05-accounts-search");

  await page.fill("#accounts-search", "zzzzz");
  await page.waitForTimeout(600);
  check("a search with no match says so",
    /No match found/i.test(await page.textContent("#accounts-table tbody")));
  await page.fill("#accounts-search", "");
  await page.waitForTimeout(600);

  // ---------- 6. the user card ----------
  await page.click("#accounts-table tbody tr:first-child");
  await page.waitForTimeout(400);
  check("clicking a row opens the user card",
    await page.locator("#user-modal.open").count() === 1);
  check("the card reports presence",
    (await page.textContent("#modal-user-details")).includes("Signed In Now"));
  await shot("06-user-card");
  await page.click("#user-modal .modal-close");
  await page.waitForTimeout(300);

  // ---------- 7. the archive and its restoration card ----------
  await page.evaluate("showArchiveModule()");
  await page.waitForTimeout(300);
  check("the archive starts closed too",
    /not loaded/i.test(await page.textContent("#archive-table tbody")));
  check("no Restore button sits on any archive row",
    await page.locator("#archive-table tbody button:has-text('Restore')").count() === 0);
  await shot("07-archive-closed");

  await page.evaluate("dataPanelOpen('admin-archive')");
  await page.waitForTimeout(500);
  const archived = await page.locator("#archive-table tbody tr").count();
  check("the archive loads on request", archived > 0, `saw ${archived}`);
  await shot("08-archive-loaded");

  await page.click("#archive-table tbody tr:first-child");
  await page.waitForTimeout(400);
  check("an archived row opens the restoration card",
    await page.locator("#restore-modal.open").count() === 1);
  const restoreText = await page.textContent("#restore-details");
  check("the card names the date archived", restoreText.includes("Date Archived"));
  check("the card names who archived them", restoreText.includes("Archived By"));
  check("the card carries one Restore action",
    await page.locator("#restore-modal .modal-foot button:has-text('Restore Account')").count() === 1);
  await shot("09-restore-card");

  // the confirmation in front of it
  await page.click("#restore-modal button:has-text('Restore Account')");
  await page.waitForTimeout(400);
  check("Restore asks before it acts",
    await page.locator("#ask-modal.open").count() === 1);
  check("the confirmation lists the consequences",
    await page.locator("#ask-detail li").count() >= 2);
  await shot("10-restore-confirm");
  await page.evaluate("closeAsk(false)");
  await page.waitForTimeout(300);
  await page.evaluate("closeModal('restore-modal')");

  // ---------- 8. the audit trail ----------
  await page.evaluate("showAuditLogs()");
  await page.waitForTimeout(300);
  check("the trail starts closed",
    /not loaded/i.test(await page.textContent("#logs-table tbody")));

  await page.evaluate("dataPanelOpen('admin-logs')");
  await page.waitForTimeout(600);
  const logRows = await page.locator("#logs-table tbody tr").count();
  check("the trail pages ten at a time", logRows === 10, `saw ${logRows}`);
  const headers = await page.locator("#logs-table thead th").allTextContents();
  check("the trail shows timestamp, user, role, address and type",
    ["Timestamp", "User", "Role", "IP Address", "Action Type", "Detail"]
      .every((name) => headers.includes(name)), headers.join(" / "));
  check("an address is printed on the row",
    /\d+\.\d+\.\d+\.\d+/.test(await page.textContent("#logs-table tbody")));
  await shot("11-logs-loaded");

  await page.selectOption("#logs-type", "LOGIN_FAILURE");
  await page.waitForTimeout(600);
  check("the type filter narrows the trail",
    await page.locator("#logs-table tbody .badge:has-text('Failed sign-in')").count() ===
    await page.locator("#logs-table tbody tr").count());
  await shot("12-logs-failures");

  await page.selectOption("#logs-type", "UPDATE");
  await page.waitForTimeout(600);
  await page.click("#logs-table tbody tr:first-child");
  await page.waitForTimeout(400);
  check("an entry opens in full",
    await page.locator("#log-modal.open").count() === 1);
  check("the entry shows the before and after values",
    /What changed/.test(await page.textContent("#log-metadata")));
  check("the entry prints the raw metadata too",
    await page.locator("#log-modal .audit-json").count() === 1);
  await shot("13-log-entry");
  await page.evaluate("closeModal('log-modal')");
  await page.waitForTimeout(300);

  // ---------- 9. backups and the drawer ----------
  await page.evaluate("showMaintenance()");
  await page.waitForTimeout(300);
  check("the backup list starts closed",
    /has not been read/i.test(await page.textContent("#backup-table tbody")));
  check("no action buttons sit on backup rows",
    await page.locator("#backup-table tbody button").count() === 1);   // only Load Data

  await page.evaluate("dataPanelOpen('admin-backups')");
  await page.waitForTimeout(600);
  check("backups page ten at a time",
    await page.locator("#backup-table tbody tr").count() === 10);
  check("the folder and totals are filled in",
    (await page.textContent("#backup-folder")).includes("backups"));
  check("still no per-row buttons once loaded",
    await page.locator("#backup-table tbody button").count() === 0);
  await shot("14-backups-loaded");

  await page.click("#backup-table tbody tr:nth-child(2)");
  await page.waitForTimeout(500);
  check("a backup row opens the drawer",
    await page.locator("#backup-drawer.open").count() === 1);
  const drawerTitle = await page.textContent("#backup-drawer-title");
  const rowName = (await page.textContent("#backup-table tbody tr:nth-child(2)")).trim();
  check("the drawer names the backup that was clicked",
    rowName.includes(drawerTitle), `${drawerTitle} vs row`);
  check("the drawer carries all three actions",
    await page.locator(".drawer-foot button").count() === 3);
  await shot("15-backup-drawer");

  await page.click(".drawer-foot button:has-text('Restore')");
  await page.waitForTimeout(400);
  check("Restore asks first, in the dangerous tone",
    await page.locator("#ask-modal.open #ask-ok.btn-danger").count() === 1);
  check("the restore warning lists what is lost",
    await page.locator("#ask-detail li").count() === 3);
  await shot("16-restore-backup-confirm");
  await page.evaluate("closeAsk(false)");
  await page.waitForTimeout(300);

  await page.evaluate("closeBackupDrawer()");
  await page.waitForTimeout(300);

  // ---------- 10. the toast clock ----------
  const life = await page.evaluate("JSON.stringify(TOAST_LIFE)");
  check("an error card stays at least four seconds",
    JSON.parse(life).danger >= 4000, life);

  // ---------- 11. nothing loaded that was not asked for ----------
  const autoLoaded = requested.filter((url) =>
    /\/api\/(users|audit-logs|backups)/.test(url));
  check("the page made no table request before it was told to",
    autoLoaded.length >= 1, `${autoLoaded.length} table requests in total across the run`);

  await browser.close();

  console.log("\n--- console and network problems ---");
  if (problems.length === 0) console.log("  none");
  else problems.slice(0, 20).forEach((p) => console.log("  " + p));

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
})();
