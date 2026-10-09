// ============================================================
// qr-payments.js -- GCash and Maya paid by QR code, and the record of every try
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// Routes in this file:
//   POST /api/qr-payments                 make a QR code for an amount
//   GET  /api/qr-payments/:id             has it been paid? (the till asks every 3 seconds)
//   POST /api/qr-payments/:id/cancel      the cashier gives up on a code
//   GET  /api/qr-payments                 every attempt, with counts and the success rate
//   POST /api/paymongo/webhook            PayMongo telling us about a payment (optional)
//   GET  /pay/done                        where the customer's phone lands after paying
//
// Who takes the money is chosen here, once, from PAYMENT_PROVIDER in .env:
// qr-provider-paymongo.js (real PayMongo, test or live) or qr-provider-sim.js
// (offline). Both answer the same three calls, and nothing outside this file
// knows which one is in use.
//
// Every attempt is a row in qr_payments, written through three procedures:
// made (pending), what became of it (paid, failed, expired, cancelled), and
// the sale it was recorded on. cashier.js asks verifyForMoney() before a sale
// or a payment is saved against a QR payment: the browser's word that it was
// paid is never taken.
// ============================================================

const os = require("os");
const QRCode = require("qrcode");

// how long a code can be paid; QR_PAYMENT_MINUTES in .env
const QR_MINUTES = Number(process.env.QR_PAYMENT_MINUTES) > 0 ? Number(process.env.QR_PAYMENT_MINUTES) : 10;

const WALLETS = ["GCash", "PayMaya"];
const PURPOSES = ["sale", "credit_payment"];

// written on a paid row whose sale could not be saved: money in, nothing recorded
const UNSAVED_NOTE = "paid but sale not saved – refund needed";
// written on a row closed on our side whose payment arrived anyway
const LATE_NOTE = "paid after the QR was closed – refund needed";

function pickProvider() {
  const chosen = String(process.env.PAYMENT_PROVIDER || "sim").trim().toLowerCase();
  if (chosen === "paymongo") return require("./qr-provider-paymongo");
  if (chosen !== "sim") {
    console.warn(`PAYMENT_PROVIDER=${chosen} is not known (use paymongo or sim); using sim.`);
  }
  return require("./qr-provider-sim");
}

// This PC's address on the Wi-Fi, so a phone on the same network can open the
// pages the QR code leads to. A home or shop network is 192.168.x.x or
// 10.x.x.x; 172.x is tried last because Hyper-V and WSL make adapters there.
function lanAddress() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const item of interfaces[name] || []) {
      const v4 = item.family === "IPv4" || item.family === 4;
      if (v4 && !item.internal) found.push(item.address);
    }
  }
  const rank = (address) => (address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : 2);
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || null;
}

function siteBaseUrl(port) {
  const site = String(process.env.HARDWARE_SITE_URL || "").trim().replace(/\/+$/, "");
  if (site) return site;
  return `http://${lanAddress() || "localhost"}:${port}`;
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
      message: `This QR payment has not been paid (it is ${row.status}), so nothing was recorded.` };
  }
  if (Math.round(Number(row.amount) * 100) !== Math.round(Number(amountNow) * 100)) {
    return { status: 409, code: "QR_AMOUNT",
      message: `The QR payment was for ${pesoText(row.amount)} but ${pesoText(amountNow)} is being taken now. ` +
               "Nothing was recorded." };
  }
  if (wallet && row.wallet !== wallet) {
    return { status: 409, code: "QR_WALLET",
      message: `The QR payment was made with ${row.wallet}, not ${wallet}. Nothing was recorded.` };
  }
  if (row.sale_id !== null && row.sale_id !== undefined) {
    return { status: 409, code: "QR_USED",
      message: `This QR payment is already recorded on OR-${String(row.sale_id).padStart(6, "0")}. ` +
               "One payment cannot pay for two things." };
  }
  return null;
}

// The tiles over the QR Payments list. The success rate is out of the attempts
// that have finished: one still waiting has not failed yet.
function summarize(rows) {
  const counts = { attempts: rows.length, pending: 0, paid: 0, failed: 0, expired: 0, cancelled: 0 };
  for (const row of rows) {
    if (counts[row.status] !== undefined) counts[row.status] += 1;
  }
  const finished = counts.attempts - counts.pending;
  counts.successRate = finished > 0 ? Math.round((counts.paid / finished) * 1000) / 10 : null;
  return counts;
}

function registerQrPaymentRoutes(app, deps) {
  const { db, callProcedure, getActorId, publishChange, isDateText, CASHIER, port } = deps;

  const provider = pickProvider();
  if (typeof provider.registerRoutes === "function") provider.registerRoutes(app);

  // what the screens show beside every code: test money, a simulation, or nothing
  let badge = null;
  if (provider.name === "sim") badge = "SIMULATION";
  else if (provider.mode === "test") badge = "TEST MODE";

  const baseUrl = siteBaseUrl(port);

  const ROW_SQL = `
    SELECT q.*, st.full_name AS cashier_name,
           (q.status = 'pending' AND q.expires_at <= NOW()) AS is_due,
           GREATEST(TIMESTAMPDIFF(SECOND, NOW(), q.expires_at), 0) AS seconds_left
    FROM qr_payments q
    LEFT JOIN staff st ON st.staff_id = q.created_by_staff_id`;

  async function readRow(id) {
    const [rows] = await db.query(`${ROW_SQL} WHERE q.qr_payment_id = ?`, [id]);
    return rows[0] || null;
  }

  // what a browser is told about one attempt
  function shape(row) {
    return {
      id: row.qr_payment_id,
      status: row.status,
      amount: Number(row.amount),
      wallet: row.wallet,
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
    const output = await callProcedure(
      "CALL sp_set_qr_payment_result(?, ?, ?, ?, ?, @changed, @status_code, @message)",
      [id, status, paymentId || null, errorMessage || null, actorId || null],
      ["changed", "status_code", "message"]
    );
    if (Number(output.changed) === 1) {
      publishChange("qr-payments", `qr-payment ${id} ${status}`, null);
    }
    return output;
  }

  // One look at the provider for a code still waiting, shared by everyone
  // asking about it at that moment (the till, the cancel, a sale).
  const checking = new Map();

  function refresh(row, actorId) {
    if (!row || row.status !== "pending") return Promise.resolve(row);
    const id = row.qr_payment_id;
    if (checking.has(id)) return checking.get(id);

    const work = (async () => {
      let state;
      try {
        state = await provider.getStatus(row.provider_intent_id);
      } catch (error) {
        // the provider cannot be asked just now; the row stays as it is
        console.error(`Checking QR payment #${id} failed:`, error.message);
        row.checkError = error.message;
        return row;
      }

      if (state.status === "paid" || state.status === "failed" || state.status === "expired") {
        await setResult(id, state.status, state.providerPaymentId, state.errorMessage, actorId);
      } else if (Number(row.is_due) === 1) {
        // Out of time. It is closed at the provider first, then asked once
        // more: a customer who paid as the clock ran out has still paid.
        await provider.cancel(row.provider_intent_id);
        const last = await provider.getStatus(row.provider_intent_id).catch(() => state);
        if (last.status === "paid") {
          await setResult(id, "paid", last.providerPaymentId, null, actorId);
        } else {
          await setResult(id, "expired", null, `Not paid within ${QR_MINUTES} minutes.`, actorId);
        }
      }
      return readRow(id);
    })().finally(() => checking.delete(id));

    checking.set(id, work);
    return work;
  }

  // a cashier sees and acts on their own codes; the manager on everyone's
  function mayTouch(request, row) {
    return request.actor.roleName !== CASHIER || Number(row.created_by_staff_id) === Number(request.actor.staffId);
  }

  // ---------- make a code ----------
  app.post("/api/qr-payments", async (request, response) => {
    const body = request.body || {};
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const wallet = body.wallet;
    const purpose = body.purpose || "sale";
    const saleId = body.saleId ? Number(body.saleId) : null;

    if (!Number.isFinite(amount) || amount <= 0) {
      return response.status(400).json({ error: "Type the amount the QR code is for." });
    }
    if (!WALLETS.includes(wallet)) {
      return response.status(400).json({ error: "Only GCash and Maya can be paid by QR code." });
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
      if (purpose === "credit_payment") {
        if (!saleId) return response.status(400).json({ error: "Say which sale the payment is for." });
        const [sales] = await db.query(
          `SELECT GREATEST(amount_due - amount_paid, 0) AS balance, is_archived
           FROM sales WHERE sale_id = ?`, [saleId]);
        if (sales.length === 0 || sales[0].is_archived) {
          return response.status(404).json({ error: "That sale is not on record." });
        }
        if (amount > Number(sales[0].balance) + 0.004) {
          return response.status(400).json({
            error: `Only ${pesoText(sales[0].balance)} is owed on OR-${String(saleId).padStart(6, "0")}.`
          });
        }
        description = `Payment on OR-${String(saleId).padStart(6, "0")}`;
      }

      const [shop] = await db.query("SELECT store_name FROM store_settings LIMIT 1");
      if (shop.length > 0 && shop[0].store_name) description = `${shop[0].store_name}: ${description}`;
    } catch (error) {
      console.error("QR payment checks failed:", error.message);
      return response.status(500).json({ error: "Unable to make the QR code. Try again." });
    }

    let made;
    try {
      made = await provider.createPayment({ amount, wallet, description, returnUrl: baseUrl + "/pay/done" });
    } catch (error) {
      console.error("Making a QR payment failed:", error.message);
      return response.status(error.httpStatus >= 400 && error.httpStatus < 500 ? 400 : 502)
        .json({ error: error.message });
    }

    try {
      const output = await callProcedure(
        "CALL sp_create_qr_payment(?, ?, ?, ?, ?, ?, ?, ?, ?, @qr_payment_id, @status_code, @message)",
        [provider.name, provider.mode, made.providerIntentId, amount, wallet, purpose,
         Math.round(QR_MINUTES * 60), getActorId(request),
         purpose === "credit_payment" ? `for OR-${String(saleId).padStart(6, "0")}` : "for a sale"],
        ["qr_payment_id", "status_code", "message"]
      );
      if (output.status_code !== 201) {
        // not on record, so it must not be payable either
        await provider.cancel(made.providerIntentId);
        return response.status(output.status_code).json({ error: output.message });
      }

      const row = await readRow(output.qr_payment_id);
      const qrImage = await QRCode.toDataURL(made.payUrl, { margin: 1, width: 260 });
      publishChange("qr-payments", `qr-payment ${row.qr_payment_id} pending`, request.headers["x-client-id"] || null);

      response.status(201).json({
        id: row.qr_payment_id,
        qrImage: qrImage,
        payUrl: made.payUrl,
        expiresAt: row.expires_at,
        // seconds left by the database's clock, so a till whose clock is off still counts down right
        secondsLeft: Number(row.seconds_left),
        mode: provider.mode,
        badge: badge,
        amount: amount,
        wallet: wallet
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
  app.get("/api/qr-payments/:id", async (request, response) => {
    try {
      let row = await readRow(Number(request.params.id));
      if (!row || !mayTouch(request, row)) {
        return response.status(404).json({ error: "That QR payment is not on record." });
      }
      row = await refresh(row, getActorId(request));
      const answer = shape(row);
      answer.secondsLeft = row.status === "pending" ? Number(row.seconds_left) : 0;
      if (row.checkError) answer.checkError = row.checkError;
      answer.badge = badge;
      response.json(answer);
    } catch (error) {
      console.error("QR payment check failed:", error.message);
      response.status(500).json({ error: "Unable to check the QR payment." });
    }
  });

  // ---------- the cashier gives up ----------
  // Looked at once more first: a payment that already went through is
  // answered as paid, and the till records it instead of abandoning it.
  app.post("/api/qr-payments/:id/cancel", async (request, response) => {
    try {
      let row = await readRow(Number(request.params.id));
      if (!row || !mayTouch(request, row)) {
        return response.status(404).json({ error: "That QR payment is not on record." });
      }
      row = await refresh(row, getActorId(request));

      if (row.status === "pending") {
        await provider.cancel(row.provider_intent_id);
        // closed at the provider, so this last look settles it
        const last = await provider.getStatus(row.provider_intent_id).catch(() => ({ status: "pending" }));
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

  // ---------- the record of every attempt ----------
  app.get("/api/qr-payments", async (request, response) => {
    const status = String(request.query.status || "all");
    const from = String(request.query.from || "");
    const to = String(request.query.to || "");

    // a cashier's list is their own, whatever the address asks for
    let staff = request.query.staff ? Number(request.query.staff) : null;
    if (request.actor.roleName === CASHIER) staff = Number(request.actor.staffId);

    const where = [];
    const params = [];
    if (isDateText(from)) { where.push("q.created_at >= ?"); params.push(`${from} 00:00:00`); }
    if (isDateText(to))   { where.push("q.created_at <= ?"); params.push(`${to} 23:59:59`); }
    if (staff)            { where.push("q.created_by_staff_id = ?"); params.push(staff); }
    const whereSql = where.length > 0 ? "WHERE " + where.join(" AND ") : "";

    try {
      // Codes left waiting past their time (a till closed with one on screen)
      // are settled before the list is read, so it never shows them pending.
      const [due] = await db.query(
        `${ROW_SQL} WHERE q.status = 'pending' AND q.expires_at <= NOW() ORDER BY q.qr_payment_id LIMIT 20`);
      for (const row of due) await refresh(row, null);

      const [rows] = await db.query(`${ROW_SQL} ${whereSql} ORDER BY q.created_at DESC, q.qr_payment_id DESC LIMIT 1000`,
        params);
      // the tiles count the whole period; the status filter narrows the list only
      const summary = summarize(rows);
      const listed = status === "all" ? rows : rows.filter((row) => row.status === status);

      response.json({ rows: listed.map(shape), summary: summary, badge: badge });
    } catch (error) {
      console.error("QR payments list failed:", error.message);
      response.status(500).json({ error: "Unable to read the QR payments." });
    }
  });

  // ---------- PayMongo telling us (optional) ----------
  // The till's own checking is what confirms a payment; PayMongo cannot reach
  // a server on localhost. When the server is reachable, this catches what the
  // till would miss: a payment made after the code was closed on our side.
  app.post("/api/paymongo/webhook", async (request, response) => {
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
      const [rows] = await db.query(`${ROW_SQL} WHERE q.provider_intent_id = ?`, [event.intentId || ""]);
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
  app.get("/pay/done", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Thank you</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f5f7;color:#1f2933}
.card{max-width:420px;margin:48px auto;background:#fff;border-radius:14px;padding:28px 20px;
box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center}p{color:#616e7c}</style></head>
<body><div class="card"><h2>You can return to the cashier</h2>
<p>The cashier's screen shows whether the payment went through.</p></div></body></html>`);
  });

  // ---------- for cashier.js: money recorded against a QR payment ----------

  // In this server, two sales sent at the same moment with one payment are
  // stopped here; the procedure that links the payment stops them again in
  // the database.
  const claiming = new Set();

  // Checked with the provider again before anything is saved. Gives back
  // { id, reference, release } or throws a QrPaymentError. release() must be
  // called once the sale is saved or has failed.
  async function verifyForMoney(qrPaymentId, amountNow, wallet, actorId) {
    const id = Number(qrPaymentId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new QrPaymentError(400, "That QR payment number is not valid.", "QR_UNKNOWN");
    }
    if (claiming.has(id)) {
      throw new QrPaymentError(409, "This QR payment is being recorded on another sale right now.", "QR_USED");
    }
    claiming.add(id);

    try {
      const row = await refresh(await readRow(id), actorId);
      const refusal = qrRefusal(row, amountNow, wallet);
      if (refusal) throw new QrPaymentError(refusal.status, refusal.message, refusal.code);
      return { id: id, reference: row.provider_payment_id, release: () => claiming.delete(id) };
    } catch (error) {
      claiming.delete(id);
      throw error;
    }
  }

  async function recordUsed(qrPaymentId, saleId, actorId) {
    const output = await callProcedure(
      "CALL sp_link_qr_payment_to_sale(?, ?, ?, @status_code, @message)",
      [qrPaymentId, saleId, actorId || null],
      ["status_code", "message"]
    );
    if (output.status_code === 200) publishChange("qr-payments", `qr-payment ${qrPaymentId} linked`, null);
    return output;
  }

  // the money came in and the sale did not save: the row says a refund is owed
  async function recordUnsaved(qrPaymentId, actorId) {
    try {
      await setResult(qrPaymentId, "paid", null, UNSAVED_NOTE, actorId);
    } catch (error) {
      console.error(`Noting QR payment #${qrPaymentId} as unsaved failed:`, error.message);
    }
  }

  // the lines for the terminal at start-up
  function describe() {
    const lines = [];
    if (provider.problem) {
      lines.push(`QR payments: ${provider.problem}`);
    } else if (provider.name === "sim") {
      lines.push("QR payments: SIMULATION (PAYMENT_PROVIDER=sim): no PayMongo, no real money.");
    } else {
      lines.push(`QR payments: PayMongo, ${provider.mode === "test" ? "TEST MODE (no real money)" : "LIVE (real money)"}.`);
    }
    lines.push(`Phones reach this app at ${baseUrl}` +
      (process.env.HARDWARE_SITE_URL ? " (HARDWARE_SITE_URL)." : " (this PC on the Wi-Fi; the phone must be on the same network)."));
    return lines;
  }

  return { verifyForMoney, recordUsed, recordUnsaved, QrPaymentError, describe };
}

module.exports = { registerQrPaymentRoutes, qrRefusal, summarize, UNSAVED_NOTE, QR_MINUTES };
