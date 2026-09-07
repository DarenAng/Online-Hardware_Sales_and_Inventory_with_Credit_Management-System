// Expects a freshly loaded database (the two files in public/database/, in order).
// Signs in as every role, walks every screen, and saves a screenshot of each.
// Console errors and failed requests are reported, because a screen that looks
// right while the console is full of errors is not right.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.env.OUT || path.join(__dirname, "..", "shots", "current");

const TOURS = {
  admin: {
    email: "admin@hardware.com", password: "admin123", page: "system.html",
    steps: [
      // Every table on this page now starts closed, so each screen is worth
      // two shots: what it looks like before anybody asks for data, and what
      // it looks like after.
      ["accounts-closed", "showAccountsList()"],
      ["accounts", "showAllUsers()"],
      ["create", "showCreateAccount()"],
      ["archive-closed", "showArchiveModule()"],
      ["archive", "dataPanelOpen('admin-archive')"],
      ["logs-closed", "showAuditLogs()"],
      ["logs", "dataPanelOpen('admin-logs')"],
      ["backup-closed", "showMaintenance()"],
      ["backup", "dataPanelOpen('admin-backups')"]
    ]
  },
  manager: {
    email: "manager@hardware.com", password: "manager123", page: "manager-dashboard.html",
    steps: [
      ["home", "showManagerHome()"],
      // the income breakdown the Total Income card opens, over two periods
      ["income", "openIncomeFromCard()"],
      ["income-year", "pickIncomeRange('annual')"],
      ["reports", "showReports()"],
      ["reports-methods", "dataPanelOpen('mgr-methods')"],
      ["reports-receivables", "openReceivables()"],
      ["sales-closed", "showSales()"],
      ["sales", "dataPanelOpen('mgr-sales')"],
      ["reorder-alerts", "(showReorderAlerts(), dataPanelOpen('mgr-reorder'))"],
      ["stock-report", "(showStockReport(), dataPanelOpen('mgr-stocks'))"],
      ["credit", "(showCredit(), dataPanelOpen('mgr-credit'))"],
      ["credit-requests", "(showCreditRequests(), dataPanelOpen('mgr-requests'))"],
      ["deliveries", "(showDeliveries(), dataPanelOpen('mgr-deliveries'))"],
      ["records", "(showRecords(), dataPanelOpen('mgr-records'))"],
      ["archives", "(showArchives(), dataPanelOpen('mgr-archives'))"]
    ]
  },
  clerk: {
    email: "clerk@hardware.com", password: "clerk123", page: "inventory-dashboard.html",
    steps: [
      ["materials-closed", "showInventoryHome()"],
      ["materials", "loadInventoryAll()"],
      ["adjust", "(showAdjust(), dataPanelOpen('clerk-adjustments'))"],
      ["reorder", "(showReorder(), dataPanelOpen('clerk-reorder'))"],
      ["purchase-orders", "(showPurchaseOrders(), dataPanelOpen('clerk-po'))"],
      ["returns", "(showReturns(), dataPanelOpen('clerk-returns'))"],
      ["report", "showDamageReport()"],
      ["archive", "(showInventoryArchive(), dataPanelOpen('clerk-archive'))"]
    ]
  },
  cashier: {
    email: "cashier@hardware.com", password: "cashier123", page: "cashier-dashboard.html",
    steps: [
      ["register", "loadCatalogAll()"],
      ["customers", "(showCustomers(), dataPanelOpen('cash-credit'))"],
      ["deliveries", "showCashierDeliveries()"],
      ["refunds", "showRefunds()"],
      ["sales-report", "showSalesReport()"],
      ["daily-summary", "showDailySummary()"]
    ]
  },
  delivery: {
    email: "delivery@hardware.com", password: "delivery123", page: "delivery.html",
    steps: [
      ["pending", "showDeliveryHome()"],
      ["active", "showDeliveryActive()"],
      ["cod", "showDeliveryCod()"],
      ["reports-closed", "showDeliveryReports()"],
      ["reports", "loadDeliveryReport()"]
    ]
  }
};

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // this container ships its own Chromium, so nothing is downloaded
  const bundled = "/opt/pw-browsers/chromium";
  const browser = await chromium.launch(
    fs.existsSync(bundled) ? { executablePath: bundled } : {}
  );
  const problems = [];

  for (const [role, tour] of Object.entries(TOURS)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();

    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`[${role}] console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`[${role}] page error: ${error.message}`));
    page.on("requestfailed", (request) =>
      problems.push(`[${role}] request failed: ${request.url()}`));
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("favicon")) {
        problems.push(`[${role}] ${response.status()} ${response.url()}`);
      }
    });

    await page.goto(`${BASE}/Login.html`, { waitUntil: "networkidle" });
    if (role === "admin") await page.screenshot({ path: path.join(OUT, "00-login.png") });

    await page.fill('input[name="email"]', tour.email);
    await page.fill('input[name="password"]', tour.password);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1200);

    // every demo account except the administrator has to pick a real password
    // on its first sign-in, so the tour goes through that screen too
    if (page.url().includes("change-password.html")) {
      if (role === "manager") {
        await page.screenshot({ path: path.join(OUT, "00-change-password.png") });
      }
      const fresh = `${role}pass123`;
      await page.fill('input[name="newPassword"]', fresh);
      await page.fill('input[name="confirmPassword"]', fresh);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(1200);
    }

    if (!page.url().includes(tour.page)) {
      problems.push(`[${role}] did not reach ${tour.page}, stopped at ${page.url()}`);
      await context.close();
      continue;
    }
    await page.waitForTimeout(900);

    let index = 1;
    for (const [label, call] of tour.steps) {
      try {
        // A step is an expression, and several of them take arguments now, so
        // it is evaluated as written rather than having "()" peeled off the
        // end of it. The result is wrapped in a resolved promise, so a step
        // that loads a table is actually waited for instead of being
        // photographed halfway through, and .then() hands Playwright a value
        // it can serialise either way.
        await page.evaluate(`Promise.resolve(${call}).then(function () {})`);
      } catch (error) {
        problems.push(`[${role}] ${label}: ${error.message}`);
      }
      await page.waitForTimeout(700);
      await page.screenshot({
        path: path.join(OUT, `${role}-${String(index).padStart(2, "0")}-${label}.png`),
        fullPage: true
      });
      index += 1;
    }

    // the pieces that are the same on every module are captured once, on the
    // manager screen, because they are built by the same code everywhere
    if (role === "manager") {
      await page.evaluate("showManagerHome()");
      await page.waitForTimeout(500);

      await page.click("#account-chip");
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, "shared-01-account-menu.png") });

      await page.evaluate("void openMyAccount('view')");
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, "shared-02-credentials.png") });

      await page.evaluate("showAccountTab('edit')");
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, "shared-03-edit-credentials.png") });

      await page.evaluate("showAccountTab('password')");
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, "shared-04-change-password.png") });

      await page.evaluate("closeModal('account-modal')");
      await page.waitForTimeout(300);

      await page.evaluate(`void askConfirm('This is what a confirmation looks like now.',
        { title: 'Restore this backup?', eyebrow: 'Recovery', mark: '!',
          confirmLabel: 'Restore this backup', tone: 'danger' })`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, "shared-05-ask-card.png") });
      await page.evaluate("closeAsk(false)");
      await page.waitForTimeout(300);

      await page.evaluate(`void askInput({ title: 'Reset this password', eyebrow: 'Accounts Management',
        message: 'Give this person a temporary password.', label: 'Temporary password',
        type: 'password', confirmLabel: 'Reset password' })`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, "shared-06-ask-input.png") });
      await page.evaluate("closeAsk(null)");
      await page.waitForTimeout(300);

      await page.evaluate(`(function () {
        notifySuccess('The backup file holds every table, view and procedure.', 'Backup saved');
        notifyWarning('Only 4 pcs of Circuit Breaker 20A left in stock.', 'Not enough stock');
        notifyError('That email already signs in to another account.', 'Account not created');
      })()`);
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, "shared-07-notification-cards.png") });

      // a long page, scrolled to the bottom: the menu and the top bar have to
      // still be there
      await page.evaluate("clearCards(); showReports();");
      await page.waitForTimeout(1200);
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, "shared-09-scrolled.png") });
      await page.evaluate("window.scrollTo(0, 0)");
      await page.evaluate("showManagerHome()");
      await page.waitForTimeout(700);

      await page.evaluate("void toggleNotifications()");
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, "shared-08-alert-panel.png") });
    }

    await context.close();
  }

  await browser.close();

  console.log(`Screenshots written to ${OUT}`);
  if (problems.length === 0) {
    console.log("No console errors, page errors or failed requests.");
  } else {
    console.log(`\n${problems.length} problem(s):`);
    [...new Set(problems)].forEach((problem) => console.log("  " + problem));
  }
})();
