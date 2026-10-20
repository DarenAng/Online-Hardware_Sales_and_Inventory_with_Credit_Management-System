// ============================================================
// qr-payments.js -- GCash, Maya and bank transfers paid by QR code, and the record of every try
// Loaded by: server.js only (from the routes folder). Never sent to a browser.
//
// Routes in this file:
//   POST /api/qr-payments                 make a QR code for an amount
//   GET  /api/qr-payments/:id             has it been paid? (the till asks every 3 seconds)
//   POST /api/qr-payments/:id/cancel      the cashier (or the driver) gives up on a code
//   GET  /api/qr-payments                 every attempt, with counts and the success rate
//   POST /api/paymongo/webhook            PayMongo telling us about a payment (optional)
//   GET  /pay/done                        where the customer's phone lands after paying
//
// Who takes the money is chosen here, once, from PAYMENT_PROVIDER in .env:
// qr-provider-paymongo.js (real PayMongo, test or live) or qr-provider-sim.js
// (offline). Both answer the same three calls, and nothing outside this file
// knows which one is in use.
//
// A bank transfer is paid the same way: the cashier gives the customer's bank
// (one PayMongo can take a transfer from), account name and account number, and
// the code opens that bank's own online-banking page, where the customer logs in
// and approves the transfer. The bank and account are kept on the qr_payments
// row, and copied to payment_details when the money is recorded.
//
// Every attempt is a row in qr_payments, written through procedures: made
// (pending), what became of it (paid, failed, expired, cancelled), and the
// sale it was recorded on (set inside sp_create_sale_transaction and
// sp_record_credit_payment, in the same transaction as the money). cashier.js
// asks verifyForMoney() first for a friendly message; the browser's word that
// it was paid is never taken, and the database refuses a payment used twice.
// ============================================================

const os = require("os");
const QRCode = require("qrcode");
const qrPaymentProcedures = require("../database/procedures/qr-payment-procedures");
const paymentDetails = require("../payment-details");
const helpers = require("../helpers");

// how long a code can be paid; QR_PAYMENT_MINUTES in .env
let QR_MINUTES = 10;
if (Number(process.env.QR_PAYMENT_MINUTES) > 0) {
  QR_MINUTES = Number(process.env.QR_PAYMENT_MINUTES);
}

const WALLETS = ["GCash", "PayMaya", "Bank Transfer"];
const PURPOSES = ["sale", "credit_payment"];

// written on a paid row whose sale could not be saved: money in, nothing recorded
const UNSAVED_NOTE = "paid but sale not saved – refund needed";
// written on a row closed on our side whose payment arrived anyway
const LATE_NOTE = "paid after the QR was closed – refund needed";

function pickProvider() {
  const chosen = String(process.env.PAYMENT_PROVIDER || "sim").trim().toLowerCase();
  if (chosen === "paymongo") return require("../services/qr-provider-paymongo");
  if (chosen !== "sim") {
    console.warn("PAYMENT_PROVIDER=" + chosen + " is not known (use paymongo or sim); using sim.");
  }
  return require("../services/qr-provider-sim");
}

// This PC's address on the Wi-Fi, so a phone on the same network can open the
// pages the QR code leads to. A home or shop network is 192.168.x.x or
// 10.x.x.x; 172.x is tried last because Hyper-V and WSL make adapters there.
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
  // 0 = tried first (192.168.x.x), 1 = then 10.x.x.x, 2 = everything else
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
  // on Vercel, the project's own address (its production domain, else this deployment's)
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return "https://" + vercelHost;
  return "http://" + (lanAddress() || "localhost") + ":" + port;
}

// An error carrying the HTTP status to answer with and a short code the till
// can act on, alongside the sentence for the cashier.
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

// The rule for recording money against a QR payment, in one place (the stub
// in tests/ui/stub.js uses it too): paid, for exactly the money taken now, by
// the same wallet, and on no sale yet. Gives back null or the refusal.
function qrRefusal(row, amountNow, wallet) {
  if (!row) {
    return { status: 404, code: "QR_UNKNOWN", message: "That QR payment is not on record. Make a new QR code." };
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
      message: "This QR payment is already recorded on OR-" + String(row.sale_id).padStart(6, "0") + ". " +
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

  // what a browser is told about one attempt
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

  // Every change is announced on the live channel and lands in audit_logs
  // (the procedure writes that entry in the same transaction).
  async function setResult(id, status, paymentId, errorMessage, actorId) {
    const output = await qrPaymentProcedures.setQrPaymentResult(
      [id, status, paymentId || null, errorMessage || null, actorId || null]
    );
    if (Number(output.changed) === 1) {
      publishChange("qr-payments", "qr-payment " + id + " " + status, null);
    }
    return output;
  }

  // One look at the provider for a code still waiting, shared by everyone
  // asking about it at that moment (the till, the cancel, a sale).
  // (an object: payment id -> the look in progress)
  const checking = {};

  function refresh(row, actorId) {
    if (!row || row.status !== "pending") return Promise.resolve(row);
    const id = row.qr_payment_id;
    if (checking[id] !== undefined) return checking[id];

    // the look at the provider; the work promise below starts it and tidies up after
    async function lookAtProvider() {
      let state;
      try {
        state = await provider.getStatus(row.provider_intent_id);
      } catch (error) {
        // the provider cannot be asked just now; the row stays as it is
        console.error("Checking QR payment #" + id + " failed:", error.message);
        row.checkError = error.message;
        return row;
      }

      if (state.status === "paid" || state.status === "failed" || state.status === "expired") {
        await setResult(id, state.status, state.providerPaymentId, state.errorMessage, actorId);
      } else if (Number(row.is_due) === 1) {
        // Out of time. It is closed at the provider first, then asked once
        // more: a customer who paid as the clock ran out has still paid.
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

  // a cashier or a driver sees and acts on their own codes; the manager on everyone's
  function mayTouch(request, row) {
    const ownOnly = request.actor.roleName === CASHIER || request.actor.roleName === DRIVER;
    return !ownOnly || Number(row.created_by_staff_id) === Number(request.actor.staffId);
  }

  // ---------- make a code ----------
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

    // A bank transfer names the customer's bank (one PayMongo supports) and
    // account. They are checked here, before anything is made at PayMongo.
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
      // a payment on a balance is checked against the sale before the
      // customer is asked to pay anything
      // a driver only takes money at the door: a payment on a COD sale whose
      // delivery they took
      if (request.actor.roleName === DRIVER) {
        if (purpose !== "credit_payment" || !saleId) {
          return response.status(403).json({ error: "A driver makes a QR code only for a delivery being paid at the door." });
        }
        const ownResult = await db.query(
          "SELECT 1 FROM deliveries d JOIN sales s ON s.sale_id = d.sale_id\n" +
            "           WHERE d.sale_id = ? AND d.delivery_staff_id = ? AND d.is_archived = FALSE\n" +
            "             AND s.payment_method = 'COD' LIMIT 1",
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
            error: "Only " + pesoText(sales[0].balance) + " is owed on OR-" + String(saleId).padStart(6, "0") + "."
          });
        }
        description = "Payment on OR-" + String(saleId).padStart(6, "0");
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
      // say which bank, so the cashier knows another one can be tried
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
         purpose === "credit_payment" ? "for OR-" + String(saleId).padStart(6, "0") : "for a sale",
         bank ? bank.code : null, bank ? bank.name : null, accountName, accountNumber]
      );
      if (output.status_code !== 201) {
        // not on record, so it must not be payable either
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
        // seconds left by the database's clock, so a till whose clock is off still counts down right
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

  // ---------- is it paid? ----------
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

  // ---------- the cashier gives up ----------
  // Looked at once more first: a payment that already went through is
  // answered as paid, and the till records it instead of abandoning it.
  app.post("/api/qr-payments/:id/cancel", async function (request, response) {
    try {
      let row = await readRow(Number(request.params.id));
      if (!row || !mayTouch(request, row)) {
        return response.status(404).json({ error: "That QR payment is not on record." });
      }
      row = await refresh(row, getActorId(request));

      if (row.status === "pending") {
        await provider.cancel(row.provider_intent_id);
        // closed at the provider, so this last look settles it
        const last = await provider.getStatus(row.provider_intent_id).catch(function () {
          return { status: "pending" };
        });
        if (last.status === "paid") {
          await setResult(row.qr_payment_id, "paid", last.providerPaymentId, null, getActorId(request));
        } else {
          await setResult(row.qr_payment_id, "cancelled", null, "Cancelled by the cashier.", getActorId(request));
        }
        row = await readRow(row.qr_payment_id);
      }
      response.json(shape(row));
    } catch (error) {
      console.error("QR payment cancel failed:", error.message);
      response.status(500).json({ error: "Unable to cancel the QR payment." });
    }
  });

  // ---------- PayMongo telling us (optional) ----------
  // The till's own checking is what confirms a payment; PayMongo cannot reach
  // a server on localhost. When the server is reachable, this catches what the
  // till would miss: a payment made after the code was closed on our side.
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
      // not one of ours (another app on the same PayMongo account): acknowledged, ignored
      if (row && event.type === "payment.paid" && row.status !== "paid") {
        await setResult(row.qr_payment_id, "paid", event.paymentId,
          row.status === "pending" ? null : LATE_NOTE, null);
      } else if (row && event.type === "payment.failed" && row.status === "pending") {
        await setResult(row.qr_payment_id, "failed", event.paymentId, event.failedMessage, null);
      }
      response.json({ received: true });
    } catch (error) {
      console.error("PayMongo webhook failed:", error.message);
      // a 5xx makes PayMongo send it again later
      response.status(500).json({ error: "Unable to record the event." });
    }
  });

  // ---------- where the customer's phone lands ----------
  app.get("/pay/done", function (request, response) {
    response.set("Cache-Control", "no-store");
    response.send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Thank you</title>\n" +
      "<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f5f7;color:#1f2933}\n" +
      ".card{max-width:420px;margin:48px auto;background:#fff;border-radius:14px;padding:28px 20px;\n" +
      "box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center}p{color:#616e7c}</style></head>\n" +
      "<body><div class=\"card\"><h2>Payment sent</h2>\n" +
      "<p>The cashier's or the driver's screen shows whether the payment went through.</p></div></body></html>");
  });

  // ---------- for cashier.js: money recorded against a QR payment ----------

  // In this server, two sales sent at the same moment with one payment are
  // stopped here with a friendly message. The database is the real guard: the
  // sale and payment procedures lock the qr_payments row and tie it to the sale
  // inside their own transaction.
  // (an object: payment id -> true while that payment is being recorded)
  const claiming = {};

  // Checked with the provider again before anything is saved. Gives back
  // { id, reference, release } or throws a QrPaymentError. release() must be
  // called once the sale is saved or has failed.
  // For a Bank Transfer, typedAccount is { bankCode, accountNumber } as the cashier
  // has them on screen now. The payment's details are copied from its own row when
  // the money is recorded, so it is only used when they are the same bank and account
  // (a paid transfer kept from an earlier try must not take another customer's place).
  async function verifyForMoney(qrPaymentId, amountNow, wallet, actorId, typedAccount) {
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
      const refusal = qrRefusal(row, amountNow, wallet);
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

  // The sale or payment procedure has tied the QR payment to the sale by now;
  // this only tells the open QR Payments screens to look again.
  function announceUsed(qrPaymentId) {
    publishChange("qr-payments", "qr-payment " + qrPaymentId + " linked", null);
  }

  // The money came in and the sale did not save: the row says a refund is owed.
  // Gives back "QR_USED" when the refusal was because the payment is already
  // recorded on another sale (this try lost the race to it), so the till does
  // not offer the payment for another try; otherwise null.
  async function recordUnsaved(qrPaymentId, actorId) {
    try {
      // a payment that is already recorded on a sale is not unsaved, so it
      // gets no refund note
      const row = await readRow(qrPaymentId);
      if (row && row.sale_id !== null) return "QR_USED";
      await setResult(qrPaymentId, "paid", null, UNSAVED_NOTE, actorId);
    } catch (error) {
      console.error("Noting QR payment #" + qrPaymentId + " as unsaved failed:", error.message);
    }
    return null;
  }

  // the lines for the terminal at start-up
  function describe() {
    const lines = [];
    if (provider.problem) {
      lines.push("QR payments: " + provider.problem);
    } else if (provider.name === "sim") {
      lines.push("QR payments: SIMULATION (PAYMENT_PROVIDER=sim): no PayMongo, no real money.");
    } else {
      lines.push("QR payments: PayMongo, " + (provider.mode === "test" ? "TEST MODE (no real money)" : "LIVE (real money)") + ".");
    }
    // Online, the simulation charges nobody, yet the till records the sale as
    // paid. PAYMENT_PROVIDER unset (or any value that is not "paymongo") ends
    // up as sim, which is exactly what provider.name tells.
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
