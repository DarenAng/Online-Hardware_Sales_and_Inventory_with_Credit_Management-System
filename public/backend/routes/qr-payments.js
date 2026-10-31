const os = require("os");
const QRCode = require("qrcode");
const qrPaymentProcedures = require("../database/procedures/qr-payment-procedures");
const paymentDetails = require("../payment-details");
const helpers = require("../helpers");

let QR_MINUTES = 10;
if (Number(process.env.QR_PAYMENT_MINUTES) > 0) {
  QR_MINUTES = Number(process.env.QR_PAYMENT_MINUTES);
}

const WALLETS = ["GCash", "PayMaya", "Bank Transfer"];

const PURPOSES = ["sale", "credit_payment"];

const UNSAVED_NOTE = "paid but sale not saved – refund needed";
const LATE_NOTE = "paid after the QR was closed – refund needed";

function pickProvider() {
  const chosen = String(process.env.PAYMENT_PROVIDER || "sim").trim().toLowerCase();
  if (chosen === "paymongo") return require("../services/qr-provider-paymongo");
  if (chosen !== "sim") {
    console.warn("PAYMENT_PROVIDER=" + chosen + " is not known (use paymongo or sim); using sim.");
  }
  return require("../services/qr-provider-sim");
}

function lanAddress() {
  const found = [];
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces);
  for (let nameIndex = 0; nameIndex < names.length; nameIndex++) {
    const items = interfaces[names[nameIndex]] || [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      const v4 = item.family === "IPv4" || item.family === 4;
      if (v4 && !item.internal) found.push(item.address);
    }
  }
  const rank = function (address) {
    if (address.startsWith("192.168.")) return 0;
    if (address.startsWith("10.")) return 1;
    return 2;
  };
  found.sort(function (a, b) {
    return rank(a) - rank(b);
  });
  return found[0] || null;
}

function siteBaseUrl(port) {
  const site = String(process.env.HARDWARE_SITE_URL || "").trim().replace(/\/+$/, "");
  if (site) return site;
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return "https://" + vercelHost;
  return "http://" + (lanAddress() || "localhost") + ":" + port;
}

class QrPaymentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function pesoText(value) {
  return Number(value).toFixed(2);
}

function qrRefusal(row, amountNow, wallet, forSaleId) {
  if (!row) {
    return { status: 404, code: "QR_UNKNOWN", message: "That QR payment is not on record. Make a new QR code." };
  }
  // A code made in the customer portal pays that one sale, and nothing else.
  if (row.portal_sale_id !== null && row.portal_sale_id !== undefined &&
      Number(row.portal_sale_id) !== Number(forSaleId)) {
    return { status: 409, code: "QR_PORTAL",
      message: "This QR payment was made in the customer portal for " + helpers.orNumber(row.portal_sale_id) + ", so it cannot be used for anything else. " +
               "Nothing was recorded." };
  }
  if (row.status !== "paid") {
    return { status: 409, code: "QR_NOT_PAID",
      message: "This QR payment has not been paid (it is " + row.status + "), so nothing was recorded." };
  }
  if (Math.round(Number(row.amount) * 100) !== Math.round(Number(amountNow) * 100)) {
    return { status: 409, code: "QR_AMOUNT",
      message: "The QR payment was for " + pesoText(row.amount) + " but " + pesoText(amountNow) + " is being taken now. " +
               "Nothing was recorded." };
  }
  if (wallet && row.wallet !== wallet) {
    return { status: 409, code: "QR_WALLET",
      message: "The QR payment was made with " + row.wallet + ", not " + wallet + ". Nothing was recorded." };
  }
  if (row.sale_id !== null && row.sale_id !== undefined) {
    return { status: 409, code: "QR_USED",
      message: "This QR payment is already recorded on " + helpers.orNumber(row.sale_id) + ". " +
               "One payment cannot pay for two things." };
  }
  return null;
}

function registerQrPaymentRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const publishChange = deps.publishChange;
  const CASHIER = deps.CASHIER;
  const DRIVER = deps.DRIVER;
  const port = deps.port;

  const provider = pickProvider();
  if (typeof provider.registerRoutes === "function") provider.registerRoutes(app, db);

  const baseUrl = siteBaseUrl(port);

  const ROW_SQL = "\n    SELECT q.*, st.full_name AS cashier_name,\n" +
    "           (q.status = 'pending' AND q.expires_at <= NOW()) AS is_due,\n" +
    "           GREATEST(TIMESTAMPDIFF(SECOND, NOW(), q.expires_at), 0) AS seconds_left\n" +
    "    FROM qr_payments q\n" +
    "    LEFT JOIN staff st ON st.staff_id = q.created_by_staff_id";

  async function readRow(id) {
    const rowsResult = await db.query(ROW_SQL + " WHERE q.qr_payment_id = ?", [id]);
    const rows = rowsResult[0];
    return rows[0] || null;
  }

  function shape(row) {
    return {
      id: row.qr_payment_id,
      status: row.status,
      amount: Number(row.amount),
      wallet: row.wallet,
      bankName: row.bank_name,
      accountName: row.account_name,
      accountNumber: row.account_number,
      purpose: row.purpose,
      reference: row.provider_payment_id,
      saleId: row.sale_id,
      errorMessage: row.error_message,
      mode: row.mode,
      provider: row.provider,
      staffId: row.created_by_staff_id,
      cashierName: row.cashier_name || null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      paidAt: row.paid_at,
      closedAt: row.closed_at
    };
  }

  // Things to do once a QR payment turns paid (the customer portal records its payments here).
  const paidListeners = [];

  function onPaid(listener) {
    paidListeners.push(listener);
  }

  async function setResult(id, status, paymentId, errorMessage, actorId) {
    const output = await qrPaymentProcedures.setQrPaymentResult(
      [id, status, paymentId || null, errorMessage || null, actorId || null]
    );
    if (Number(output.changed) === 1) {
      publishChange("qr-payments", "qr-payment " + id + " " + status, null);

      if (status === "paid" && errorMessage !== UNSAVED_NOTE) {
        for (let listenerIndex = 0; listenerIndex < paidListeners.length; listenerIndex++) {
          try {
            await paidListeners[listenerIndex](id);
          } catch (error) {
            console.error("Handling paid QR payment " + helpers.qrPaymentCode(id) + " failed:", error.message);
          }
        }
      }
    }
    return output;
  }

  const checking = {};

  function refresh(row, actorId) {
    if (!row || row.status !== "pending") return Promise.resolve(row);
    const id = row.qr_payment_id;
    if (checking[id] !== undefined) return checking[id];

    async function lookAtProvider() {
      let state;
      try {
        state = await provider.getStatus(row.provider_intent_id);
      } catch (error) {
        console.error("Checking QR payment " + helpers.qrPaymentCode(id) + " failed:", error.message);
        row.checkError = error.message;
        return row;
      }

      if (state.status === "paid" || state.status === "failed" || state.status === "expired") {
        await setResult(id, state.status, state.providerPaymentId, state.errorMessage, actorId);
      } else if (Number(row.is_due) === 1) {
        await provider.cancel(row.provider_intent_id);
        const last = await provider.getStatus(row.provider_intent_id).catch(function () {
          return state;
        });
        if (last.status === "paid") {
          await setResult(id, "paid", last.providerPaymentId, null, actorId);
        } else {
          await setResult(id, "expired", null, "Not paid within " + QR_MINUTES + " minutes.", actorId);
        }
      }
      return readRow(id);
    }

    const work = lookAtProvider().finally(function () {
      delete checking[id];
    });

    checking[id] = work;
    return work;
  }

  function mayTouch(request, row) {
    const ownOnly = request.actor.roleName === CASHIER || request.actor.roleName === DRIVER;
    return !ownOnly || Number(row.created_by_staff_id) === Number(request.actor.staffId);
  }

  app.post("/api/qr-payments", async function (request, response) {
    const body = request.body || {};
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const wallet = body.wallet;
    const purpose = body.purpose || "sale";
    const saleId = body.saleId ? Number(body.saleId) : null;

    if (!Number.isFinite(amount) || amount <= 0) {
      return response.status(400).json({ error: "Type the amount the QR code is for." });
    }
    if (!WALLETS.includes(wallet)) {
      return response.status(400).json({ error: "Only GCash, Maya and bank transfers can be paid by QR code." });
    }

    let bank = null;
    let accountName = null;
    let accountNumber = null;
    if (wallet === "Bank Transfer") {
      bank = paymentDetails.findBank(String(body.bankCode || ""));
      if (!bank) {
        return response.status(400).json({ error: "Pick the customer's bank from the list." });
      }
      if (amount < bank.minimum) {
        return response.status(400).json({
          error: bank.name + " takes transfers of " + pesoText(bank.minimum) + " or more. This one is " + pesoText(amount) + "."
        });
      }
      accountName = helpers.tidy(body.accountName);
      const nameProblem = paymentDetails.accountNameProblem(accountName, "");
      if (nameProblem) return response.status(400).json({ error: nameProblem });
      accountNumber = paymentDetails.cleanAccountNumber(body.accountNumber);
      if (accountNumber === null) {
        return response.status(400).json({ error: "Enter the account number: 6 to 20 digits, no letters." });
      }
    }
    if (!PURPOSES.includes(purpose)) {
      return response.status(400).json({ error: "A QR code is either for a sale or for a payment on a balance." });
    }
    if (provider.problem) {
      return response.status(503).json({ error: provider.problem });
    }

    let description = "Purchase at the counter";
    try {
      if (request.actor.roleName === DRIVER) {
        if (purpose !== "credit_payment" || !saleId) {
          return response.status(403).json({ error: "A driver makes a QR code only for a delivery being paid at the door." });
        }
        const ownResult = await db.query(
          "SELECT 1 FROM deliveries d JOIN sales s ON s.sale_id = d.sale_id\n" +
            "           WHERE d.sale_id = ? AND d.delivery_staff_id = ? AND d.is_archived = FALSE\n" +
            "             AND s.is_archived = FALSE LIMIT 1",
          [saleId, request.actor.staffId]);
        if (ownResult[0].length === 0) {
          return response.status(403).json({ error: "Take this delivery before collecting on it." });
        }
      }
      if (purpose === "credit_payment") {
        if (!saleId) return response.status(400).json({ error: "Say which sale the payment is for." });
        const salesResult = await db.query(
          "SELECT GREATEST(amount_due - amount_paid, 0) AS balance, is_archived\n" +
            "           FROM sales WHERE sale_id = ?", [saleId]);
        const sales = salesResult[0];
        if (sales.length === 0 || sales[0].is_archived) {
          return response.status(404).json({ error: "That sale is not on record." });
        }
        if (amount > Number(sales[0].balance) + 0.004) {
          return response.status(400).json({
            error: "Only " + pesoText(sales[0].balance) + " is owed on " + helpers.orNumber(saleId) + "."
          });
        }
        description = "Payment on " + helpers.orNumber(saleId);
      }

      const shopResult = await db.query("SELECT store_name FROM store_settings LIMIT 1");
      const shop = shopResult[0];
      if (shop.length > 0 && shop[0].store_name) description = shop[0].store_name + ": " + description;
    } catch (error) {
      console.error("QR payment checks failed:", error.message);
      return response.status(500).json({ error: "Unable to make the QR code. Try again." });
    }

    let made;
    try {
      made = await provider.createPayment({
        amount: amount,
        wallet: wallet,
        bank: bank,
        description: description,
        returnUrl: baseUrl + "/pay/done"
      });
    } catch (error) {
      console.error("Making a QR payment failed:", error.message);
      let said = error.message;
      if (bank && error.httpStatus >= 400 && error.httpStatus < 500) {
        said = bank.name + " could not be used for this transfer: " + error.message;
      }
      return response.status(error.httpStatus >= 400 && error.httpStatus < 500 ? 400 : 502)
        .json({ error: said });
    }

    try {
      const output = await qrPaymentProcedures.createQrPayment(
        [provider.name, provider.mode, made.providerIntentId, amount, wallet, purpose,
         Math.round(QR_MINUTES * 60), getActorId(request),
         purpose === "credit_payment" ? "for " + helpers.orNumber(saleId) : "for a sale",
         bank ? bank.code : null, bank ? bank.name : null, accountName, accountNumber, null, null]
      );
      if (output.status_code !== 201) {
        await provider.cancel(made.providerIntentId);
        return response.status(output.status_code).json({ error: output.message });
      }

      const row = await readRow(output.qr_payment_id);
      const qrImage = await QRCode.toDataURL(made.payUrl, { margin: 1, width: 260 });
      publishChange("qr-payments", "qr-payment " + row.qr_payment_id + " pending", request.headers["x-client-id"] || null);

      response.status(201).json({
        id: row.qr_payment_id,
        qrImage: qrImage,
        payUrl: made.payUrl,
        expiresAt: row.expires_at,
        secondsLeft: Number(row.seconds_left),
        mode: provider.mode,
        amount: amount,
        wallet: wallet,
        bankName: bank ? bank.name : null
      });
    } catch (error) {
      console.error("Saving a QR payment failed:", error.message);
      await provider.cancel(made.providerIntentId);
      if (/qr_payments/.test(error.message)) {
        return response.status(500).json({
          error: "The qr_payments table is missing. Run public/database/3-ADD-qr-payments.sql, then restart the server."
        });
      }
      response.status(500).json({ error: "Unable to make the QR code. Try again." });
    }
  });

  app.get("/api/qr-payments/:id", async function (request, response) {
    try {
      let row = await readRow(Number(request.params.id));
      if (!row || !mayTouch(request, row)) {
        return response.status(404).json({ error: "That QR payment is not on record." });
      }
      row = await refresh(row, getActorId(request));
      const answer = shape(row);
      answer.secondsLeft = row.status === "pending" ? Number(row.seconds_left) : 0;
      if (row.checkError) answer.checkError = row.checkError;
      response.json(answer);
    } catch (error) {
      console.error("QR payment check failed:", error.message);
      response.status(500).json({ error: "Unable to check the QR payment." });
    }
  });

  // Stops a pending QR code (or notices that it was paid just before). Returns the fresh row.
  async function cancelRow(row, actorId, note) {
    row = await refresh(row, actorId);

    if (row.status === "pending") {
      await provider.cancel(row.provider_intent_id);
      const last = await provider.getStatus(row.provider_intent_id).catch(function () {
        return { status: "pending" };
      });
      if (last.status === "paid") {
        await setResult(row.qr_payment_id, "paid", last.providerPaymentId, null, actorId);
      } else {
        await setResult(row.qr_payment_id, "cancelled", null, note, actorId);
      }
      row = await readRow(row.qr_payment_id);
    }
    return row;
  }

  app.post("/api/qr-payments/:id/cancel", async function (request, response) {
    try {
      let row = await readRow(Number(request.params.id));
      if (!row || !mayTouch(request, row)) {
        return response.status(404).json({ error: "That QR payment is not on record." });
      }
      row = await cancelRow(row, getActorId(request), "Cancelled by the cashier.");
      response.json(shape(row));
    } catch (error) {
      console.error("QR payment cancel failed:", error.message);
      response.status(500).json({ error: "Unable to cancel the QR payment." });
    }
  });

  app.post("/api/paymongo/webhook", async function (request, response) {
    if (typeof provider.parseWebhook !== "function") {
      return response.status(404).json({ error: "Webhooks are only used with PayMongo." });
    }

    let event;
    try {
      event = provider.parseWebhook(request.body, request.get("Paymongo-Signature"));
    } catch (error) {
      console.warn("PayMongo webhook refused:", error.message);
      return response.status(error.status || 400).json({ error: error.message });
    }

    try {
      const rowsResult = await db.query(ROW_SQL + " WHERE q.provider_intent_id = ?", [event.intentId || ""]);
      const rows = rowsResult[0];
      const row = rows[0];
      if (row && event.type === "payment.paid" && row.status !== "paid") {
        await setResult(row.qr_payment_id, "paid", event.paymentId,
          row.status === "pending" ? null : LATE_NOTE, null);
      } else if (row && event.type === "payment.failed" && row.status === "pending") {
        await setResult(row.qr_payment_id, "failed", event.paymentId, event.failedMessage, null);
      }
      response.json({ received: true });
    } catch (error) {
      console.error("PayMongo webhook failed:", error.message);
      response.status(500).json({ error: "Unable to record the event." });
    }
  });

  // The customer portal makes its own QR codes: no staff member, GCash or PayMaya only.
  // The checks are the staff route's (an amount above zero, no more than the balance).
  // input: customerId, saleId, wallet, amount. Returns { status, body }.
  async function createForCustomer(input) {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    const wallet = input.wallet;
    const saleId = Number(input.saleId);
    const orText = helpers.orNumber(saleId);

    if (!Number.isFinite(amount) || amount <= 0) {
      return { status: 400, body: { error: "Type the amount the QR code is for." } };
    }
    if (wallet !== "GCash" && wallet !== "PayMaya") {
      return { status: 400, body: { error: "Pick GCash or PayMaya." } };
    }
    // The simulator and PayMongo test keys let anyone "pay" for nothing, so a customer may only
    // get a code from live PayMongo, unless the owner set PORTAL_TEST_PAYMENTS=1 on purpose (a demo).
    const live = provider.name === "paymongo" && provider.mode === "live";
    if (!live && process.env.PORTAL_TEST_PAYMENTS !== "1") {
      return { status: 503, body: { error: "Paying by QR is not available yet." } };
    }
    if (provider.problem) {
      return { status: 503, body: { error: provider.problem } };
    }

    let description = "Payment on " + orText;
    try {
      const salesResult = await db.query(
        "SELECT GREATEST(amount_due - amount_paid, 0) AS balance\n" +
          "           FROM sales\n" +
          "           WHERE sale_id = ? AND customer_id = ? AND is_archived = FALSE\n" +
          "             AND payment_method IN ('Credit', 'COD')",
        [saleId, input.customerId]);
      const sale = salesResult[0][0];
      if (!sale) {
        return { status: 404, body: { error: "That sale is not on your account." } };
      }
      if (amount > Number(sale.balance) + 0.004) {
        return { status: 400, body: { error: "Only " + pesoText(sale.balance) + " is owed on " + orText + "." } };
      }

      const shopResult = await db.query("SELECT store_name FROM store_settings LIMIT 1");
      if (shopResult[0].length > 0 && shopResult[0][0].store_name) {
        description = shopResult[0][0].store_name + ": " + description;
      }
    } catch (error) {
      console.error("Portal QR checks failed:", error.message);
      return { status: 500, body: { error: "Unable to make the QR code. Try again." } };
    }

    let made;
    try {
      made = await provider.createPayment({
        amount: amount,
        wallet: wallet,
        bank: null,
        description: description,
        returnUrl: baseUrl + "/ohsicms-customer/"
      });
    } catch (error) {
      console.error("Making a portal QR payment failed:", error.message);
      let code = 502;
      if (error.httpStatus >= 400 && error.httpStatus < 500) code = 400;
      return { status: code, body: { error: error.message } };
    }

    try {
      const output = await qrPaymentProcedures.createQrPayment(
        [provider.name, provider.mode, made.providerIntentId, amount, wallet, "credit_payment",
         Math.round(QR_MINUTES * 60), null, "for " + orText + " (customer portal)",
         null, null, null, null, input.customerId, saleId]
      );
      // The procedure locks the sale, checks that no other code for it is open, and stores who the
      // code is for in the same insert, so the server can record it even if the page is closed.
      if (output.status_code !== 201) {
        await provider.cancel(made.providerIntentId);
        return { status: output.status_code, body: { error: output.message } };
      }

      const row = await readRow(output.qr_payment_id);
      const qrImage = await QRCode.toDataURL(made.payUrl, { margin: 1, width: 260 });
      publishChange("qr-payments", "qr-payment " + row.qr_payment_id + " pending", null);

      return {
        status: 201,
        body: {
          id: row.qr_payment_id,
          qrImage: qrImage,
          payUrl: made.payUrl,
          secondsLeft: Number(row.seconds_left),
          amount: amount,
          wallet: wallet
        }
      };
    } catch (error) {
      console.error("Saving a portal QR payment failed:", error.message);
      await provider.cancel(made.providerIntentId);
      return { status: 500, body: { error: "Unable to make the QR code. Try again." } };
    }
  }

  app.get("/pay/done", async function (request, response) {
    response.set("Cache-Control", "no-store");

    // A code made in the customer portal gets its own wording.
    try {
      const rowsResult = await db.query(
        "SELECT portal_customer_id FROM qr_payments WHERE provider_intent_id = ?",
        [String(request.query.payment_intent_id || "")]);
      if (rowsResult[0][0] && rowsResult[0][0].portal_customer_id !== null) {
        return response.send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
          "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Thank you</title>\n" +
          "<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f5f7;color:#1f2933}\n" +
          ".card{max-width:420px;margin:48px auto;background:#fff;border-radius:14px;padding:28px 20px;\n" +
          "box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center}p{color:#616e7c}</style></head>\n" +
          "<body><div class=\"card\"><h2>Payment sent</h2>\n" +
          "<p>Your payment was received. You can close this page.</p></div></body></html>");
      }
    } catch (error) {
      console.error("Reading the QR payment for /pay/done failed:", error.message);
    }

    response.send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Thank you</title>\n" +
      "<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f5f7;color:#1f2933}\n" +
      ".card{max-width:420px;margin:48px auto;background:#fff;border-radius:14px;padding:28px 20px;\n" +
      "box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center}p{color:#616e7c}</style></head>\n" +
      "<body><div class=\"card\"><h2>Payment sent</h2>\n" +
      "<p>The cashier's or the driver's screen shows whether the payment went through.</p></div></body></html>");
  });

  const claiming = {};

  // forSaleId is only given for a portal code, by the code that records it on its own sale.
  async function verifyForMoney(qrPaymentId, amountNow, wallet, actorId, typedAccount, forSaleId) {
    const id = Number(qrPaymentId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new QrPaymentError(400, "That QR payment number is not valid.", "QR_UNKNOWN");
    }
    if (claiming[id] === true) {
      throw new QrPaymentError(409, "This QR payment is being recorded on another sale right now.", "QR_USED");
    }
    claiming[id] = true;

    try {
      const row = await refresh(await readRow(id), actorId);
      const refusal = qrRefusal(row, amountNow, wallet, forSaleId);
      if (refusal) throw new QrPaymentError(refusal.status, refusal.message, refusal.code);
      if (wallet === "Bank Transfer") {
        const typed = typedAccount || {};
        const typedNumber = paymentDetails.cleanAccountNumber(typed.accountNumber);
        if (String(typed.bankCode || "") !== String(row.bank_code || "") || typedNumber === null ||
            typedNumber !== String(row.account_number || "")) {
          throw new QrPaymentError(409,
            "That transfer was paid from " + row.bank_name + " account " + row.account_number +
            ", not the bank and account on screen. Nothing was recorded.", "QR_ACCOUNT");
        }
      }
      return {
        id: id,
        reference: row.provider_payment_id,
        release: function () {
          delete claiming[id];
        }
      };
    } catch (error) {
      delete claiming[id];
      throw error;
    }
  }

  function announceUsed(qrPaymentId) {
    publishChange("qr-payments", "qr-payment " + qrPaymentId + " linked", null);
  }

  async function recordUnsaved(qrPaymentId, actorId) {
    try {
      const row = await readRow(qrPaymentId);
      if (row && row.sale_id !== null) return "QR_USED";
      await setResult(qrPaymentId, "paid", null, UNSAVED_NOTE, actorId);
    } catch (error) {
      console.error("Noting QR payment " + helpers.qrPaymentCode(qrPaymentId) + " as unsaved failed:", error.message);
    }
    return null;
  }

  function describe() {
    const lines = [];
    if (provider.problem) {
      lines.push("QR payments: " + provider.problem);
    } else if (provider.name === "sim") {
      lines.push("QR payments: SIMULATION (PAYMENT_PROVIDER=sim): no PayMongo, no real money.");
    } else {
      lines.push("QR payments: PayMongo, " + (provider.mode === "test" ? "TEST MODE (no real money)" : "LIVE (real money)") + ".");
    }
    if (process.env.VERCEL && provider.name === "sim") {
      lines.push("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      lines.push("WARNING: this server is on Vercel but QR payments are SIMULATED.");
      lines.push("A GCash, Maya or bank-transfer QR code takes no real money: pressing Pay on the");
      lines.push("simulated page marks it paid. Set PAYMENT_PROVIDER=paymongo (and the");
      lines.push("PayMongo keys) in the Vercel environment before real customers pay.");
      lines.push("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    }

    let where = " (this PC on the Wi-Fi; the phone must be on the same network).";
    if (process.env.HARDWARE_SITE_URL) where = " (HARDWARE_SITE_URL).";
    else if (process.env.VERCEL) where = " (this Vercel project's address).";
    lines.push("Phones reach this app at " + baseUrl + where);
    return lines;
  }

  return {
    readRow: readRow,
    refresh: refresh,
    cancelRow: cancelRow,
    onPaid: onPaid,
    createForCustomer: createForCustomer,
    verifyForMoney: verifyForMoney,
    announceUsed: announceUsed,
    recordUnsaved: recordUnsaved,
    QrPaymentError: QrPaymentError,
    describe: describe
  };
}

module.exports = {
  registerQrPaymentRoutes: registerQrPaymentRoutes,
  qrRefusal: qrRefusal,
  UNSAVED_NOTE: UNSAVED_NOTE,
  QR_MINUTES: QR_MINUTES
};
