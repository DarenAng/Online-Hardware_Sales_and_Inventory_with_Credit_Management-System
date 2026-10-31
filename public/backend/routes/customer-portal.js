const helpers = require("../helpers");
const crypto = require("crypto");
const customerSessions = require("../customer-sessions");
const portalPassword = require("../portal-password");
const deliveryProcedures = require("../database/procedures/delivery-procedures");
const UNSAVED_NOTE = require("./qr-payments").UNSAVED_NOTE;

// The customer portal. A customer signs in with their User ID (the customer ID) and password, reads
// their own credit, payments and loyalty discount, and can pay a balance by QR.
//
// Every /api/portal route is PUBLIC to the staff rules in access-control.js. Each one except
// sign-in checks for a customer session itself (needsCustomer) and only ever uses
// request.customerId, which comes from that session and never from the address or the body.
//
// This file also holds the cashier's "Issue Portal Password" route and the code that writes a
// paid portal QR payment on its sale.
function registerCustomerPortalRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const writeAuditLog = deps.writeAuditLog;
  const hashPassword = deps.hashPassword;
  const verifyPassword = deps.verifyPassword;
  const passwordComplaint = deps.passwordComplaint;
  const publishChange = deps.publishChange;
  const qrPayments = deps.qrPayments;
  const LOGIN_MAX_ATTEMPTS = deps.LOGIN_MAX_ATTEMPTS;
  const LOGIN_HOLD_MINUTES = deps.LOGIN_HOLD_MINUTES;

  const GENERIC_SIGN_IN_ERROR = "Invalid user ID or password";

  const decoyHash = hashPassword(crypto.randomBytes(24).toString("hex"));

  function pesoText(value) {
    return "₱" + Number(value || 0).toLocaleString("en-PH",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // The audit log has no customer column, so a customer's entries have no staff id and the role "Customer".
  function who(request) {
    return { staffId: null, roleName: "Customer", request: request };
  }

  // ---- Sign-in tries (the same count and hold as the staff sign-in) ----

  const CUSTOMER_SELECT =
    "SELECT customer_id, last_name, full_name, is_archived, portal_password,\n" +
    "       IF(portal_held_until IS NOT NULL AND portal_held_until > NOW(), portal_held_until, NULL) AS held_until,\n" +
    "       TIMESTAMPDIFF(SECOND, NOW(), portal_held_until) AS held_for_seconds\n" +
    "FROM customers WHERE customer_id = ?";

  async function findCustomer(customerId) {
    const rowsResult = await db.query(CUSTOMER_SELECT, [customerId]);
    return rowsResult[0][0] || null;
  }

  // Counts one try. False means the limit was already reached.
  async function countTry(customer) {
    const countedResult = await db.query(
      "UPDATE customers\n" +
      "       SET portal_failed_attempts = IF(portal_held_until IS NULL, portal_failed_attempts + 1, 1),\n" +
      "           portal_held_until = NULL\n" +
      "       WHERE customer_id = ?\n" +
      "         AND (portal_held_until <= NOW() OR (portal_held_until IS NULL AND portal_failed_attempts < ?))",
      [customer.customer_id, LOGIN_MAX_ATTEMPTS]);
    return countedResult[0].affectedRows > 0;
  }

  async function clearTries(customerId) {
    await db.query(
      "UPDATE customers SET portal_failed_attempts = 0, portal_held_until = NULL WHERE customer_id = ?",
      [customerId]);
  }

  async function holdAccount(customer, attempts, request) {
    const heldResult = await db.query(
      "UPDATE customers SET portal_held_until = DATE_ADD(NOW(), INTERVAL ? MINUTE)\n" +
      "       WHERE customer_id = ? AND portal_held_until IS NULL AND portal_failed_attempts >= ?",
      [LOGIN_HOLD_MINUTES, customer.customer_id, LOGIN_MAX_ATTEMPTS]);
    if (heldResult[0].affectedRows === 0) return false;

    // The hold only blocks new sign-ins; a session the customer already has carries on,
    // so someone guessing a password cannot throw the real customer out.
    await writeAuditLog(who(request), "ACCOUNT_HELD",
      "Portal account of customer " + helpers.customerCode(customer.customer_id) + " (" + customer.full_name + ") held for " +
        LOGIN_HOLD_MINUTES + " minutes after " + LOGIN_MAX_ATTEMPTS + " wrong passwords in a row",
      { customer_id: customer.customer_id, attempts: attempts, hold_minutes: LOGIN_HOLD_MINUTES });
    return true;
  }

  function minutesLeft(seconds) {
    const minutes = Math.ceil(Number(seconds || 0) / 60);
    if (minutes < 1) return 1;
    return minutes;
  }

  function heldMessage(minutes) {
    let word = "minutes";
    if (minutes === 1) word = "minute";
    return "This account is held after " + LOGIN_MAX_ATTEMPTS + " wrong passwords in a row. " +
      "Try again in " + minutes + " " + word + ", or ask the store to issue a new portal password, " +
      "which releases it now.";
  }

  async function heldMinutesNow(customerId) {
    const rowsResult = await db.query(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(), portal_held_until) AS seconds FROM customers WHERE customer_id = ?",
      [customerId]);
    const row = rowsResult[0][0];
    if (row && row.seconds !== null && Number(row.seconds) > 0) {
      return minutesLeft(row.seconds);
    }
    return LOGIN_HOLD_MINUTES;
  }

  async function refuseHeld(customer, request, response, minutes) {
    await writeAuditLog(who(request), "LOGIN_FAILURE",
      "Portal sign-in refused for customer " + helpers.customerCode(customer.customer_id) + ": the account is held for " +
        minutes + " more minute(s)",
      { customer_id: customer.customer_id, reason: "held" });
    return response.status(423).json({ error: heldMessage(minutes), heldMinutes: minutes });
  }

  // A wrong try was counted already. Writes the audit entry and holds the account at the limit.
  async function afterWrongTry(customer, request, response, reason, answerText) {
    const countsResult = await db.query(
      "SELECT portal_failed_attempts FROM customers WHERE customer_id = ?", [customer.customer_id]);
    const row = countsResult[0][0];
    let counted = 1;
    if (row) counted = Number(row.portal_failed_attempts);
    const attempts = Math.min(Math.max(counted, 1), LOGIN_MAX_ATTEMPTS);

    await writeAuditLog(who(request), "LOGIN_FAILURE",
      "Portal sign-in refused for customer " + helpers.customerCode(customer.customer_id) + ": " + reason +
        " (" + attempts + " of " + LOGIN_MAX_ATTEMPTS + ")",
      { customer_id: customer.customer_id, reason: reason, attempts: attempts });

    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      await holdAccount(customer, attempts, request);
      return response.status(423).json({ error: heldMessage(LOGIN_HOLD_MINUTES), heldMinutes: LOGIN_HOLD_MINUTES });
    }

    return response.status(401).json({ error: answerText });
  }

  // ---- Who is asking ----

  // Wraps a portal route: needs a customer session, and sets request.customerId from it.
  function needsCustomer(handler) {
    return async function (request, response) {
      response.set("Cache-Control", "no-store");
      try {
        const state = await customerSessions.customerSessionState(request);
        if (!state.session) {
          return response.status(401).json({
            error: state.endedReason || "Your session has ended. Please sign in again.",
            signedOut: true
          });
        }

        const customer = await findCustomer(state.session.customerId);
        if (!customer || customer.is_archived || !customer.portal_password) {
          await customerSessions.endCustomerSession(request);
          customerSessions.clearCustomerCookie(response);
          return response.status(401).json({
            error: "Your session has ended. Please sign in again.", signedOut: true
          });
        }

        request.customerId = Number(customer.customer_id);
        request.customerName = customer.full_name;
        request.customerToken = state.session.token;
        await handler(request, response);
      } catch (error) {
        console.error("Customer portal " + request.method + " " + request.path + " failed:", error.message);
        if (!response.headersSent) {
          response.status(500).json({ error: "Something went wrong. Try again." });
        }
      }
    };
  }

  // ---- Sign in and out ----

  app.post("/api/portal/login", async function (request, response) {
    response.set("Cache-Control", "no-store");
    const body = request.body || {};
    const idText = String(body.customerId || "").trim();
    const password = body.password;

    if (!idText || !password) {
      return response.status(400).json({ error: "User ID and password are required" });
    }

    try {
      // The User ID is the customer code (C0003, c0003, C3) or just the number (3).
      const digitsText = idText.replace(/^[Cc]/, "");
      const customerId = Number(digitsText);
      let customer = null;
      if (/^\d{1,9}$/.test(digitsText) && customerId > 0) {
        customer = await findCustomer(customerId);
      }

      if (!customer || customer.is_archived || !customer.portal_password) {
        await verifyPassword(String(password), await decoyHash);
        await writeAuditLog(who(request), "LOGIN_FAILURE",
          "Portal sign-in refused for customer ID " + idText.slice(0, 12) + ": no portal account",
          { reason: "unknown_customer" });
        return response.status(401).json({ error: GENERIC_SIGN_IN_ERROR });
      }

      if (customer.held_until) {
        return await refuseHeld(customer, request, response, minutesLeft(customer.held_for_seconds));
      }

      if (!(await countTry(customer))) {
        await holdAccount(customer, LOGIN_MAX_ATTEMPTS, request);
        return await refuseHeld(customer, request, response, await heldMinutesNow(customer.customer_id));
      }

      if (!(await verifyPassword(String(password), customer.portal_password))) {
        return await afterWrongTry(customer, request, response, "wrong password", GENERIC_SIGN_IN_ERROR);
      }

      await clearTries(customer.customer_id);
      await writeAuditLog(who(request), "LOGIN",
        "Customer " + helpers.customerCode(customer.customer_id) + " (" + customer.full_name + ") signed in to the portal");

      const token = await customerSessions.startCustomerSession(customer.customer_id);
      customerSessions.setCustomerCookie(response, token);

      // Record any QR payment made earlier that never got written down.
      await settleQuietly(customer.customer_id);

      response.json({ customerId: customer.customer_id, name: customer.full_name });
    } catch (error) {
      console.error("Portal sign-in failed:", error.message);
      response.status(500).json({ error: "Unable to sign in. Try again." });
    }
  });

  app.post("/api/portal/logout", async function (request, response) {
    try {
      await customerSessions.endCustomerSession(request);
    } catch (error) {
      console.error("Portal sign-out failed:", error.message);
    }
    customerSessions.clearCustomerCookie(response);
    response.json({ message: "Signed out" });
  });

  // Who is signed in; the page uses it to decide between the portal and the sign-in page.
  app.get("/api/portal/me", needsCustomer(async function (request, response) {
    response.json({ customerId: request.customerId, name: request.customerName });
  }));

  // ---- Read-only screens ----

  app.get("/api/portal/account", needsCustomer(async function (request, response) {
    await settleQuietly(request.customerId);

    const rowsResult = await db.query(
      "SELECT customer_id, customer_name, credit_limit, current_credit, available_credit, standing\n" +
      "       FROM vw_customer_credit WHERE customer_id = ?",
      [request.customerId]);
    const row = rowsResult[0][0];
    if (!row) return response.status(404).json({ error: "Your account was not found." });

    // Same as the cashier's customer card: a customer on hold has nothing available.
    let available = Math.max(Number(row.available_credit) || 0, 0);
    if (row.standing === "Hold") available = 0;

    response.json({
      customerId: row.customer_id,
      name: row.customer_name,
      creditLimit: Number(row.credit_limit),
      balance: Number(row.current_credit),
      available: available,
      standing: row.standing
    });
  }));

  // Credit sales (Credit and COD, like the cashier's credit screens) with the 30-day due date.
  app.get("/api/portal/credits", needsCustomer(async function (request, response) {
    await settleQuietly(request.customerId);

    const rowsResult = await db.query(
      "SELECT s.sale_id, s.sale_date, s.payment_method, s.final_amount, s.penalty_amount, s.refunded_amount,\n" +
      "       s.amount_due, s.amount_paid,\n" +
      "       GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,\n" +
      "       DATE_ADD(DATE(s.sale_date), INTERVAL 30 DAY) AS due_date,\n" +
      "       CASE\n" +
      "         WHEN s.payment_status = 'Paid' THEN 'Paid'\n" +
      "         WHEN DATEDIFF(CURDATE(), DATE(s.sale_date)) > 30 THEN 'Overdue'\n" +
      "         ELSE s.payment_status\n" +
      "       END AS status\n" +
      "FROM sales s\n" +
      "WHERE s.customer_id = ? AND s.is_archived = FALSE AND s.payment_method IN ('Credit', 'COD')\n" +
      "ORDER BY s.sale_date DESC, s.sale_id DESC",
      [request.customerId]);
    response.json(rowsResult[0]);
  }));

  app.get("/api/portal/payments", needsCustomer(async function (request, response) {
    const rowsResult = await db.query(
      "SELECT p.payment_id, p.sale_id, p.amount, p.payment_method, p.reference_no, p.payment_date\n" +
      "FROM credit_payments p\n" +
      "WHERE p.customer_id = ?\n" +
      "ORDER BY p.payment_date DESC, p.payment_id DESC",
      [request.customerId]);
    response.json(rowsResult[0]);
  }));

  // The same logic as GET /api/customers/:customerId/loyalty in routes/manager.js.
  app.get("/api/portal/loyalty", needsCustomer(async function (request, response) {
    const rowsResult = await db.query(
      "SELECT last_month_paid, this_month_paid FROM vw_customer_loyalty WHERE customer_id = ?",
      [request.customerId]);
    const row = rowsResult[0][0];
    if (!row) return response.status(404).json({ error: "Your account was not found." });

    const settingsResult = await db.query(
      "SELECT loyalty_rate, loyalty_threshold FROM store_settings WHERE setting_id = 1");
    const settings = settingsResult[0][0] || { loyalty_rate: 2, loyalty_threshold: 5000 };

    const rate = Number(settings.loyalty_rate);
    const threshold = Number(settings.loyalty_threshold);
    const lastMonthPaid = Number(row.last_month_paid);
    const thisMonthPaid = Number(row.this_month_paid);
    response.json({
      rate: rate,
      threshold: threshold,
      lastMonthPaid: lastMonthPaid,
      thisMonthPaid: thisMonthPaid,
      qualifies: rate > 0 && lastMonthPaid >= threshold
    });
  }));

  // ---- Change the password (the same rules as a staff password) ----

  app.post("/api/portal/password", needsCustomer(async function (request, response) {
    const body = request.body || {};
    const current = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const again = String(body.confirmPassword || "");

    if (!current || !newPassword) {
      return response.status(400).json({ error: "Type your current password and the new one." });
    }
    const complaint = passwordComplaint(newPassword);
    if (complaint) {
      return response.status(400).json({ error: complaint });
    }
    if (newPassword !== again) {
      return response.status(400).json({ error: "The two new passwords are not the same." });
    }
    if (newPassword === current) {
      return response.status(400).json({ error: "The new password has to be different from the current one." });
    }

    const customer = await findCustomer(request.customerId);
    if (customer.held_until) {
      return await refuseHeld(customer, request, response, minutesLeft(customer.held_for_seconds));
    }
    if (!(await countTry(customer))) {
      await holdAccount(customer, LOGIN_MAX_ATTEMPTS, request);
      return await refuseHeld(customer, request, response, await heldMinutesNow(customer.customer_id));
    }

    if (!(await verifyPassword(current, customer.portal_password))) {
      return await afterWrongTry(customer, request, response, "wrong current password when changing it",
        "The current password is not right.");
    }

    await db.query(
      "UPDATE customers SET portal_password = ?, portal_password_set_at = NOW(), " +
      "portal_failed_attempts = 0, portal_held_until = NULL WHERE customer_id = ?",
      [await hashPassword(newPassword), customer.customer_id]);
    await customerSessions.endSessionsForCustomer(customer.customer_id, request.customerToken,
      "Your password was changed. Sign in again with the new one.");
    await writeAuditLog(who(request), "CUSTOMER_PASSWORD_CHANGED",
      "Customer " + helpers.customerCode(customer.customer_id) + " (" + customer.full_name + ") changed their portal password");

    response.json({ message: "Your password was changed." });
  }));

  // ---- Pay a balance by QR ----

  // What the page needs to know about one QR code.
  function qrAnswer(row) {
    let secondsLeft = 0;
    if (row.status === "pending") secondsLeft = Number(row.seconds_left);

    let problem = null;
    if (row.status === "paid" && row.sale_id === null && row.error_message === UNSAVED_NOTE) {
      problem = "Your payment of " + pesoText(row.amount) + " was received but could not be applied to " +
        helpers.orNumber(row.portal_sale_id) + ". The store will contact you about it.";
    }

    let errorMessage = null;
    if (row.status === "failed") errorMessage = row.error_message;

    return {
      id: row.qr_payment_id,
      status: row.status,
      amount: Number(row.amount),
      wallet: row.wallet,
      secondsLeft: secondsLeft,
      recorded: row.sale_id !== null,
      problem: problem,
      errorMessage: errorMessage
    };
  }

  async function ownQrRow(request, response) {
    const row = await qrPayments.readRow(Number(request.params.id));
    if (!row || Number(row.portal_customer_id) !== request.customerId) {
      response.status(404).json({ error: "That QR payment is not on record." });
      return null;
    }
    return row;
  }

  app.post("/api/portal/qr-payments", needsCustomer(async function (request, response) {
    const body = request.body || {};

    // Bring this customer's earlier codes up to date first, so a finished one does not block a new one.
    await settleQuietly(request.customerId);

    const made = await qrPayments.createForCustomer({
      customerId: request.customerId,
      saleId: body.saleId,
      wallet: body.wallet,
      amount: body.amount
    });
    response.status(made.status).json(made.body);
  }));

  app.get("/api/portal/qr-payments/:id", needsCustomer(async function (request, response) {
    let row = await ownQrRow(request, response);
    if (!row) return;

    row = await qrPayments.refresh(row, null);
    if (row.status === "paid") {
      await recordPortalPayment(row.qr_payment_id);
    }
    const checkError = row.checkError;
    row = await qrPayments.readRow(row.qr_payment_id);

    const answer = qrAnswer(row);
    if (checkError) answer.checkError = checkError;
    response.json(answer);
  }));

  app.post("/api/portal/qr-payments/:id/cancel", needsCustomer(async function (request, response) {
    let row = await ownQrRow(request, response);
    if (!row) return;

    row = await qrPayments.cancelRow(row, null, "Cancelled by the customer.");
    if (row.status === "paid") {
      await recordPortalPayment(row.qr_payment_id);
      row = await qrPayments.readRow(row.qr_payment_id);
    }
    response.json(qrAnswer(row));
  }));

  // ---- The cashier gives a customer a new portal password ----

  app.post("/api/customers/:customerId/portal-password", async function (request, response) {
    const customerId = Number(request.params.customerId);

    try {
      const customerResult = await db.query(
        "SELECT full_name FROM customers WHERE customer_id = ? AND is_archived = FALSE", [customerId]);
      const customer = customerResult[0][0];
      if (!customer) {
        return response.status(404).json({ error: "That customer was not found." });
      }

      const password = await portalPassword.issuePortalPassword(customerId);
      if (!password) {
        return response.status(404).json({ error: "That customer was not found." });
      }

      await writeAuditLog(request, "ISSUE_PORTAL_PASSWORD",
        "New portal password issued for " + customer.full_name + " (customer " + helpers.customerCode(customerId) + ")",
        { customer_id: customerId, issued_by_staff_id: getActorId(request) });

      response.set("Cache-Control", "no-store");
      response.json({
        customerId: customerId,
        name: customer.full_name,
        password: password,
        message: "A new portal password was issued for " + customer.full_name + "."
      });
    } catch (error) {
      console.error("Issue portal password failed:", error.message);
      response.status(500).json({ error: "Unable to issue the portal password" });
    }
  });

  // ---- A paid portal QR payment is always written on its sale, exactly once ----

  // It can run from many places (the page's status check, this app's PayMongo webhook, the
  // sweeps below) and any number of times. sp_record_credit_payment locks the qr_payments row
  // and refuses one that already has a sale_id, so the money goes on the sale once.
  async function recordPortalPayment(qrPaymentId) {
    const row = await qrPayments.readRow(qrPaymentId);
    if (!row || row.portal_customer_id === null || row.portal_sale_id === null) return;
    if (row.status !== "paid" || row.sale_id !== null) return;
    if (row.error_message === UNSAVED_NOTE) return;

    let qr;
    try {
      qr = await qrPayments.verifyForMoney(qrPaymentId, Number(row.amount), row.wallet, null, null, row.portal_sale_id);
    } catch (error) {
      if (error instanceof qrPayments.QrPaymentError) return;
      throw error;
    }

    try {
      const output = await deliveryProcedures.recordCreditPayment(
        [row.portal_sale_id, Number(row.amount), row.wallet, qr.reference || null, null, qr.id, null]
      );

      if (output.status_code !== 200) {
        console.error("Portal QR payment " + helpers.qrPaymentCode(qr.id) + " could not be recorded: " + output.message);

        // A server error may pass: leave the row as it is and the sweeps try again.
        // A refusal will not: mark it "refund needed" and tell the cashier and manager.
        if (output.status_code === 500) return;
        const again = await qrPayments.readRow(qr.id);
        if (again && again.sale_id !== null) return;

        await qrPayments.recordUnsaved(qr.id, null);
        await tellStaffUnsaved(row, qr.reference, output.message);
        return;
      }
      qrPayments.announceUsed(qr.id);
    } catch (error) {
      console.error("Recording portal QR payment " + helpers.qrPaymentCode(qr.id) + " failed:", error.message);
      return;
    } finally {
      qr.release();
    }

    await tellStaff(row, qr.reference);
  }

  // Adds an alert for the Cashier and Manager.
  async function addCustomerPaymentAlert(title, message) {
    await db.query(
      "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id) " +
      "SELECT role_id, 'Customer Payment', ?, ?, NULL FROM roles WHERE role_name IN ('Cashier', 'Manager')",
      [title.slice(0, 150), message]);
    publishChange("notifications", "portal payment needs handling", null);
  }

  // The money was taken but could not be put on the sale.
  async function tellStaffUnsaved(row, reference, why) {
    try {
      const customerResult = await db.query(
        "SELECT full_name FROM customers WHERE customer_id = ?", [row.portal_customer_id]);
      let name = "customer " + helpers.customerCode(row.portal_customer_id);
      if (customerResult[0][0]) name = customerResult[0][0].full_name;
      const orText = helpers.orNumber(row.portal_sale_id);

      await addCustomerPaymentAlert(
        "Customer portal payment needs a refund: " + pesoText(row.amount) + " from " + name,
        row.wallet + " QR payment of " + pesoText(row.amount) + " by " + name + " for " + orText +
          " was paid" + (reference ? " (reference " + reference + ")" : "") +
          " but could not be recorded: " + why + " It needs a refund or manual handling.");
    } catch (error) {
      console.error("Telling the cashier about an unrecorded portal payment failed:", error.message);
    }
  }

  async function tellStaff(row, reference) {
    try {
      const saleResult = await db.query(
        "SELECT GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due, c.full_name\n" +
        "       FROM sales s JOIN customers c ON c.customer_id = s.customer_id\n" +
        "       WHERE s.sale_id = ?",
        [row.portal_sale_id]);
      const sale = saleResult[0][0];

      let name = "a customer";
      if (sale && sale.full_name) name = sale.full_name;
      const orText = helpers.orNumber(row.portal_sale_id);

      const title = "Customer portal payment: " + pesoText(row.amount) + " from " + name;
      let message = row.wallet + " QR payment of " + pesoText(row.amount) + " on " + orText + ".";
      if (reference) {
        message += " Reference " + reference + ".";
      }
      if (sale && Number(sale.balance_due) > 0) {
        message += " " + pesoText(sale.balance_due) + " is still owed.";
      } else if (sale) {
        message += " The sale is now paid in full.";
      }

      await addCustomerPaymentAlert(title, message);
    } catch (error) {
      console.error("The portal payment was recorded, but telling the cashier failed:", error.message);
    }

    publishChange("sales", "portal payment " + row.portal_sale_id, null);
    publishChange("credit", "portal payment " + row.portal_sale_id, null);
    publishChange("notifications", "portal payment " + row.portal_sale_id, null);
  }

  // Whatever the provider says about this QR code, bring the books up to date.
  async function settleOne(qrPaymentId) {
    const row = await qrPayments.readRow(qrPaymentId);
    if (!row) return;
    await qrPayments.refresh(row, null);
    await recordPortalPayment(qrPaymentId);
  }

  // One customer's portal QR codes that are still open or paid but not yet written on a sale.
  async function settleOpenFor(customerId) {
    const rowsResult = await db.query(
      "SELECT qr_payment_id FROM qr_payments\n" +
      "       WHERE portal_customer_id = ? AND sale_id IS NULL AND status IN ('pending', 'paid')\n" +
      "         AND (error_message IS NULL OR error_message <> ?)\n" +
      "         AND created_at > DATE_SUB(NOW(), INTERVAL 2 DAY)\n" +
      "       ORDER BY qr_payment_id LIMIT 20",
      [customerId, UNSAVED_NOTE]);
    for (let i = 0; i < rowsResult[0].length; i++) {
      await settleOne(rowsResult[0][i].qr_payment_id);
    }
  }

  async function settleQuietly(customerId) {
    try {
      await settleOpenFor(customerId);
    } catch (error) {
      console.error("Settling the portal QR payments of customer " + helpers.customerCode(customerId) + " failed:", error.message);
    }
  }

  // Every customer's open portal QR codes. Run from the daily job and (off Vercel) a timer.
  async function settleAllOpen() {
    const rowsResult = await db.query(
      "SELECT qr_payment_id FROM qr_payments\n" +
      "       WHERE portal_customer_id IS NOT NULL AND sale_id IS NULL AND status IN ('pending', 'paid')\n" +
      "         AND (error_message IS NULL OR error_message <> ?)\n" +
      "         AND created_at > DATE_SUB(NOW(), INTERVAL 2 DAY)\n" +
      "       ORDER BY qr_payment_id LIMIT 50",
      [UNSAVED_NOTE]);
    for (let i = 0; i < rowsResult[0].length; i++) {
      try {
        await settleOne(rowsResult[0][i].qr_payment_id);
      } catch (error) {
        console.error("Settling portal QR payment " + helpers.qrPaymentCode(rowsResult[0][i].qr_payment_id) + " failed:", error.message);
      }
    }
  }

  // The moment a portal QR payment turns paid (webhook, status check, cancel), record it.
  qrPayments.onPaid(recordPortalPayment);

  return {
    settleAllOpen: settleAllOpen,
    removeExpiredCustomerSessions: customerSessions.removeExpiredCustomerSessions
  };
}

module.exports = { registerCustomerPortalRoutes: registerCustomerPortalRoutes };
