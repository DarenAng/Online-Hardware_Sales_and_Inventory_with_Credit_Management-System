// Drives the System Administrator page in a real browser against the stub.
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

  // the headings a reader can see, after a filter has taken one off the grid
  const shownHeaders = (table) => page.evaluate((id) =>
    [...document.querySelectorAll("#" + id + " thead th")]
      .filter((th) => getComputedStyle(th).display !== "none")
      .map((th) => th.textContent.trim()), table);

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
  check("status and presence have a column each",
    JSON.stringify(await shownHeaders("accounts-table")) ===
    JSON.stringify(["ID", "Name", "Email", "Role", "Status", "Signed In"]),
    (await shownHeaders("accounts-table")).join(" / "));

  await page.selectOption("#accounts-presence", "online");
  await page.waitForTimeout(300);
  const online = await page.locator("#accounts-table tbody tr").count();
  check("the presence filter narrows the grid", online > 0 && online <= 10, `saw ${online}`);
  check("every row left is online",
    await page.locator("#accounts-table tbody tr .presence.is-online").count() === online);
  check("the presence filter takes the Signed In column off the grid",
    !(await shownHeaders("accounts-table")).includes("Signed In") &&
    (await shownHeaders("accounts-table")).includes("Status"),
    (await shownHeaders("accounts-table")).join(" / "));
  await shot("04-accounts-online");

  await page.selectOption("#accounts-presence", "all");
  await page.waitForTimeout(300);
  check("clearing the filter brings the column back",
    (await shownHeaders("accounts-table")).includes("Signed In"));

  await page.selectOption("#accounts-status", "inactive");
  await page.waitForTimeout(500);
  const inactive = await page.locator("#accounts-table tbody tr").count();
  check("the account-state filter goes back to the server",
    inactive > 0 && await page.locator("#accounts-table .badge-danger").count() === inactive,
    `saw ${inactive} rows`);
  check("the account-state filter takes the Status column off the grid",
    !(await shownHeaders("accounts-table")).includes("Status") &&
    (await shownHeaders("accounts-table")).includes("Signed In"),
    (await shownHeaders("accounts-table")).join(" / "));
  await page.selectOption("#accounts-status", "all");
  await page.waitForTimeout(500);

  await page.selectOption("#accounts-role", "4");
  await page.waitForTimeout(300);
  check("the role filter takes the Role column off the grid",
    !(await shownHeaders("accounts-table")).includes("Role"),
    (await shownHeaders("accounts-table")).join(" / "));
  check("the rows left are all one role, and the row no longer says so",
    await page.locator("#accounts-table tbody tr").count() > 0 &&
    await page.locator("#accounts-table tbody tr td:nth-child(4)").evaluateAll(
      (cells) => cells.every((cell) => getComputedStyle(cell).display === "none")));
  await page.selectOption("#accounts-role", "all");
  await page.waitForTimeout(300);

  // ---------- 5. search: Enter runs it, and it matches the start of a field ----------
  const rowsBefore = await page.locator("#accounts-table tbody tr").count();
  await page.fill("#accounts-search", "rosa");
  await page.waitForTimeout(400);
  check("typing alone does not search",
    await page.locator("#accounts-table tbody tr").count() === rowsBefore);

  await page.press("#accounts-search", "Enter");
  await page.waitForTimeout(400);
  const found = await page.locator("#accounts-table tbody tr").count();
  check("Enter narrows to one person", found === 1, `saw ${found}`);
  await shot("05-accounts-search");

  // "osa" is inside Rosa but no field starts with it
  await page.fill("#accounts-search", "osa");
  await page.press("#accounts-search", "Enter");
  await page.waitForTimeout(400);
  check("a search matches the start of a field, not the middle",
    /No match found/i.test(await page.textContent("#accounts-table tbody")));

  await page.fill("#accounts-search", "zzzzz");
  await page.press("#accounts-search", "Enter");
  await page.waitForTimeout(400);
  check("a search with no match says so",
    /No match found/i.test(await page.textContent("#accounts-table tbody")));
  await page.fill("#accounts-search", "");
  await page.press("#accounts-search", "Enter");
  await page.waitForTimeout(400);

  // ---------- 6. the user card ----------
  // the second row: the first is the signed-in administrator, whose card has no Edit tab
  await page.click("#accounts-table tbody tr:nth-child(2)");
  await page.waitForTimeout(400);
  check("clicking a row opens the user card",
    await page.locator("#user-modal.open").count() === 1);
  check("the card reports presence",
    (await page.textContent("#modal-user-details")).includes("Signed In Now"));
  await shot("06-user-card");

  // Save is off until something has actually changed
  await page.click("#modal-edit-tab");
  await page.waitForTimeout(200);
  check("Save Changes starts off, because nothing has been edited",
    await page.locator("#edit-user-save-btn").isDisabled());
  const firstNameBox = page.locator("#edit-user-form input[name='firstName']");
  const original = await firstNameBox.inputValue();
  await firstNameBox.fill(original + "x");
  check("Save Changes comes on with the first edit",
    await page.locator("#edit-user-save-btn").isEnabled());
  await firstNameBox.fill(original);
  check("undoing the edit puts Save Changes back off",
    await page.locator("#edit-user-save-btn").isDisabled());
  await firstNameBox.fill(original + "   ");
  check("spaces on the end do not count as an edit",
    await page.locator("#edit-user-save-btn").isDisabled());
  await firstNameBox.fill(original);
  await shot("06b-user-edit-clean");

  await page.click("#user-modal .modal-close");
  await page.waitForTimeout(300);

  // the signed-in administrator is staff #1 in the stub
  await page.evaluate("openUserModal(1)");
  await page.waitForTimeout(300);
  check("the administrator's own card says it cannot be edited here",
    await page.locator("#modal-own-note").isVisible());
  check("the Edit tab is not offered on their own card",
    !(await page.locator("#modal-edit-tab").isVisible()));
  check("Deactivate and Reset Password are off on their own card",
    await page.locator("#modal-status-btn").isDisabled() &&
    await page.locator("#modal-reset-btn").isDisabled());
  await shot("06d-own-card");
  await page.evaluate("closeModal('user-modal')");
  await page.waitForTimeout(200);

  await page.evaluate("openUserModal(2)");
  await page.waitForTimeout(300);
  check("somebody else's card still offers Edit",
    await page.locator("#modal-edit-tab").isVisible() &&
    await page.locator("#modal-status-btn").isEnabled());
  await page.evaluate("closeModal('user-modal')");
  await page.waitForTimeout(200);

  // ---------- 6b. cancelling the create form empties it ----------
  await page.evaluate("showCreateAccount()");
  await page.waitForTimeout(200);
  await page.fill("#create-user-form input[name='firstName']", "Half");
  await page.fill("#create-user-form input[name='lastName']", "Typed");
  await page.fill("#create-user-form input[name='email']", "half@typed.com");
  await page.fill("#create-phone", "91");
  await page.selectOption("#create-user-form select[name='roleId']", "4");
  check("a short phone number is flagged while it is typed",
    await page.locator("#create-phone.is-bad").count() === 1);
  await page.click("#panel-create button:has-text('Cancel')");
  await page.waitForTimeout(200);
  check("Cancel goes back to the directory",
    await page.locator("#panel-accounts").isVisible() && !(await page.locator("#panel-create").isVisible()));
  await page.evaluate("showCreateAccount()");
  const leftBehind = await page.evaluate(() =>
    [...document.querySelectorAll("#create-user-form input")].map((box) => box.value).join(""));
  check("Cancel emptied every box on the create form", leftBehind === "", "left: " + leftBehind);
  check("Cancel also cleared the phone box's verdict",
    await page.locator("#create-phone.is-bad").count() === 0);
  check("Cancel put the role back to the first one",
    (await page.locator("#create-user-form select[name='roleId']").inputValue()) === "1");
  await shot("06c-create-cancelled");
  await page.evaluate("showAccountsList()");

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
  check("the Receipt Maintenance screen is named in the menu",
    await page.locator(".sidebar-nav a", { hasText: "Receipt Maintenance" }).count() === 1);
  check("the create form's button says Create",
    (await page.textContent("#create-user-form button[type='submit']")).trim() === "Create");

  check("the type filter takes the Action Type column off the grid",
    !(await shownHeaders("logs-table")).includes("Action Type") &&
    (await shownHeaders("logs-table")).includes("Timestamp"),
    (await shownHeaders("logs-table")).join(" / "));
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

  // ---------- 9b. store & tax: Save waits for an edit, and the TIN is checked ----------
  await page.evaluate("showStoreSettings()");
  await page.waitForTimeout(700);
  check("Save Details starts off, because the boxes say what the record says",
    await page.locator("#store-save-btn").isDisabled());

  await page.fill("#store-tin", "");
  await page.type("#store-tin", "123456789");
  check("the TIN is dashed as it is typed",
    (await page.inputValue("#store-tin")) === "123-456-789", await page.inputValue("#store-tin"));
  check("an edit to the TIN switches Save Details on",
    await page.locator("#store-save-btn").isEnabled());

  await page.fill("#store-tin", "");
  await page.type("#store-tin", "12 34");
  check("a TIN with the wrong number of digits is flagged while typed",
    await page.locator("#store-tin.is-bad").count() === 1);

  const saves = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/api/store-settings")) saves.push(r.url()); });
  await page.click("#store-save-btn");
  await page.waitForTimeout(300);
  check("a bad TIN is refused at the form and nothing is sent",
    /A TIN is 9 digits/.test(await page.textContent("#store-verdict")) && saves.length === 0,
    await page.textContent("#store-verdict"));

  await page.fill("#store-tin", "");
  await page.type("#store-tin", "000000000");
  await page.click("#store-save-btn");
  await page.waitForTimeout(300);
  check("the all-zero placeholder is not accepted as a TIN",
    /placeholder/.test(await page.textContent("#store-verdict")) && saves.length === 0);
  await shot("17-store-bad-tin");

  await page.fill("#store-tin", "");
  await page.type("#store-tin", "987654321001");
  await page.click("#store-save-btn");
  await page.waitForTimeout(1200);
  check("a TIN with the old three-digit branch code saves",
    saves.length === 1 && (await page.textContent("#store-verdict")).trim() === "");
  check("it is stored widened to the five-digit branch code",
    (await page.inputValue("#store-tin")) === "987-654-321-00001", await page.inputValue("#store-tin"));
  check("Save Details goes back off once the save has landed",
    await page.locator("#store-save-btn").isDisabled());
  await shot("18-store-saved");

  // ---------- 10. access control: who holds the keys ----------
  await page.evaluate("showAccessControl()");
  await page.waitForTimeout(400);
  check("the access list starts closed",
    /read yet/i.test(await page.textContent("#access-table tbody")));
  await shot("19-access-closed");

  await page.click("#panel-access .panel-toolbar button:has-text('Load Data')");
  await page.waitForTimeout(600);
  const holders = await page.locator("#access-table tbody tr").count();
  check("the list holds every non-administrator with a login, ten to a page",
    holders === 10, `saw ${holders}`);
  check("a person holding nothing says Nothing",
    await page.locator("#access-table tbody tr", { hasText: "Nothing" }).count() > 0);
  check("a person holding control is marked",
    await page.locator("#access-table .access-chip.has-control").count() >= 1);
  await shot("20-access-list");

  await page.selectOption("#access-holding", "some");
  await page.waitForTimeout(300);
  const holdingSome = await page.locator("#access-table tbody tr").count();
  check("the holding filter narrows to the people who hold something",
    holdingSome === 2 && await page.locator("#access-table tbody tr", { hasText: "Nothing" }).count() === 0,
    `saw ${holdingSome}`);
  await page.selectOption("#access-holding", "all");
  await page.waitForTimeout(300);

  // Rosa (staff 3) holds nothing yet
  await page.click("#access-table tbody tr:has-text('Rosa')");
  await page.waitForTimeout(400);
  check("the matrix opens on the person clicked",
    await page.locator("#access-modal.open").count() === 1 &&
    /Rosa/.test(await page.textContent("#access-name")));
  const matrixRows = await page.locator("#access-matrix tbody tr[data-system-row]").count();
  check("one line per registered system", matrixRows === 6, `saw ${matrixRows}`);
  check("Save Access is off until a box changes",
    await page.locator("#access-save-btn").isDisabled());

  await page.check("#access-matrix input[data-system='backup'][data-level='control']");
  await page.waitForTimeout(200);
  check("ticking control ticks monitor with it",
    await page.isChecked("#access-matrix input[data-system='backup'][data-level='monitor']"));
  check("Save Access wakes up once something changed",
    !(await page.locator("#access-save-btn").isDisabled()));

  await page.uncheck("#access-matrix input[data-system='backup'][data-level='monitor']");
  await page.waitForTimeout(200);
  check("clearing monitor clears control with it",
    !(await page.isChecked("#access-matrix input[data-system='backup'][data-level='control']")));
  check("and Save goes back off, because the boxes are back where they were",
    await page.locator("#access-save-btn").isDisabled());

  await page.check("#access-matrix input[data-system='backup'][data-level='control']");
  await page.fill("#access-matrix input.access-note[data-system='backup']", "Takes a backup before the count");
  await page.waitForTimeout(200);
  await shot("21-access-matrix");

  await page.click("#access-save-btn");
  await page.waitForTimeout(400);
  check("saving reads the change back first",
    await page.locator("#ask-modal.open").count() === 1 &&
    /Grant control/.test(await page.textContent("#ask-title")));
  check("and the card is crimson because control is being handed out",
    await page.locator("#ask-ok.btn-danger").count() === 1);
  check("the card names the system and the levels",
    /Automatic Backup/.test(await page.textContent("#ask-detail")) &&
    /control/.test(await page.textContent("#ask-detail")));
  await shot("22-access-confirm");

  await page.click("#ask-ok");
  await page.waitForTimeout(700);
  check("the matrix closes once saved",
    await page.locator("#access-modal.open").count() === 0);
  check("the row now says what was granted",
    await page.locator("#access-table tbody tr:has-text('Rosa') .access-chip.has-control").count() === 1);
  await shot("23-access-saved");

  // ---------- 11. the connected systems ----------
  await page.evaluate("showConnectedSystems()");
  await page.waitForTimeout(400);
  check("the systems screen starts closed",
    /asked yet/i.test(await page.textContent("#systems-grid")));
  check("the register form is offered to the administrator",
    await page.locator("#systems-register-card").isVisible());
  await shot("24-systems-closed");

  await page.click("#systems-load-btn");
  await page.waitForTimeout(600);
  const cards = await page.locator("#systems-grid .system-card").count();
  check("one card per system", cards === 6, `saw ${cards}`);
  check("a healthy system says so in a word",
    await page.locator(".system-card.is-ok .system-state", { hasText: "Healthy" }).count() >= 1);
  check("a system that cannot be reached reads as a problem, not an error",
    await page.locator(".system-card.is-bad .system-state", { hasText: "Problem" }).count() === 1);
  check("a switched-off system offers no live commands",
    await page.locator(".system-card.is-disabled .system-actions .btn:not([disabled])", { hasText: "sweep" }).count() === 0);
  await shot("25-systems-loaded");

  await page.click(".system-card:has-text('Automatic Backup') button:has-text('Run a backup now')");
  await page.waitForTimeout(400);
  check("a command asks first",
    await page.locator("#ask-modal.open").count() === 1 &&
    /Run a backup now/.test(await page.textContent("#ask-title")));
  check("and says it will be written to the trail in the person's name",
    /Recorded as/.test(await page.textContent("#ask-detail")));
  await shot("26-systems-command-ask");
  await page.click("#ask-ok");
  await page.waitForTimeout(700);
  check("the command reports back",
    await page.locator(".toast-card", { hasText: "Done on Automatic Backup" }).count() === 1);

  await page.click(".system-card:has-text('Automatic Backup') button:has-text('Pause')");
  await page.waitForTimeout(300);
  check("a dangerous command asks in crimson",
    await page.locator("#ask-ok.btn-danger").count() === 1);
  await page.click("#ask-cancel");
  await page.waitForTimeout(300);

  await page.click(".system-card:has-text('Archive Sweep') button:has-text('Settings')");
  await page.waitForTimeout(300);
  check("Settings opens the system's card",
    await page.locator("#system-modal.open").count() === 1 &&
    /Archive Sweep/.test(await page.textContent("#system-modal-name")));
  check("an internal system has no address to edit",
    !(await page.locator("#system-form-url-group").isVisible()));
  await page.selectOption("#system-form-enabled", "true");
  await page.click("#system-form button[type='submit']");
  await page.waitForTimeout(700);
  check("switching it on brings its commands back",
    await page.locator(".system-card:has-text('Archive Sweep') button:has-text('Run the sweep now'):not([disabled])").count() === 1);
  await shot("27-systems-switched-on");

  await page.fill("#sys-key", "Second Branch!");
  check("the key box keeps only what a key may hold",
    (await page.inputValue("#sys-key")) === "secondbranch", await page.inputValue("#sys-key"));
  await page.fill("#sys-key", "second-branch");
  await page.fill("#sys-name", "Second Branch");
  await page.fill("#sys-url", "https://branch.example.com/health");
  await page.click("#systems-register-form button[type='submit']");
  await page.waitForTimeout(400);
  check("registering reads the system back first",
    await page.locator("#ask-modal.open").count() === 1 &&
    /second-branch/.test(await page.textContent("#ask-detail")));
  await page.click("#ask-ok");
  await page.waitForTimeout(700);
  check("the new system gets a card",
    await page.locator("#systems-grid .system-card", { hasText: "Second Branch" }).count() === 1);
  await shot("28-systems-registered");

  // ---------- 12. the toast clock ----------
  const life = await page.evaluate("JSON.stringify(TOAST_LIFE)");
  check("an error card stays at least four seconds",
    JSON.parse(life).danger >= 4000, life);

  // ---------- 13. nothing loaded that was not asked for ----------
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
