// ============================================================
// qr-provider-sim.js -- a SIMULATED payment provider, fully offline
// Loaded by: qr-payments.js only, when PAYMENT_PROVIDER=sim. Never sent to a browser.
//
// The same four things as qr-provider-paymongo.js (see there), so the rest of
// the app cannot tell them apart:
//   createPayment({ amount, wallet, description, returnUrl }) -> { providerIntentId, payUrl, status }
//   getStatus(providerIntentId) -> { status, providerPaymentId, errorMessage }
//   cancel(providerIntentId)
//   name, mode, problem
// and one more, registerRoutes(app), for the page the QR code opens:
//   GET  /pay-sim/:token    the simulated pay page, with Pay and Fail buttons
//   POST /pay-sim/:token    what the customer pressed
//
// No PayMongo, no GCash, no Maya, no internet and no money: the page says
// SIMULATION in plain words and carries none of their names' logos. It is for
// a demo when the internet is down, and for the tests. The payments live in
// the qr_sim_intents table, so the pay page works whichever copy of the
// server answers it (Vercel runs many) and survives a restart.
// ============================================================

const crypto = require("crypto");
const express = require("express");

// Where the codes are kept. qr-payments.js hands over the database through
// registerRoutes(app, db), and they go in qr_sim_intents. Without one (the
// UI test stub, which runs no MySQL) they are kept in memory instead.
let db = null;
const memory = new Map();   // intent id -> intent

// a day is far longer than any code lasts; a server left running for weeks
// should not keep every one
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

function randomId(prefix) {
  return `${prefix}_sim_${crypto.randomBytes(8).toString("hex")}`;
}

// a row of qr_sim_intents in the shape the code below reads
function intentFrom(row) {
  if (!row) return null;
  return {
    id: row.intent_id,
    token: row.token,
    amount: Number(row.amount),
    wallet: row.wallet,
    description: row.description || "",
    returnUrl: row.return_url,
    status: row.status,
    paymentId: row.payment_id,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at)
  };
}

const store = {
  async forgetBefore(time) {
    if (!db) {
      for (const [id, old] of memory) if (old.createdAt < time) memory.delete(id);
      return;
    }
    await db.query("DELETE FROM qr_sim_intents WHERE created_at < ?", [time]);
  },

  async add(intent) {
    if (!db) {
      memory.set(intent.id, Object.assign({}, intent));
      return;
    }
    await db.query(
      `INSERT INTO qr_sim_intents
         (intent_id, token, amount, wallet, description, return_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [intent.id, intent.token, intent.amount, intent.wallet, String(intent.description).slice(0, 255),
       intent.returnUrl, intent.status, intent.createdAt]);
  },

  // by "id" or by "token" (the secret in the pay page's address)
  async find(field, value) {
    const wanted = String(value || "");
    if (!db) {
      for (const intent of memory.values()) {
        if (intent[field] === wanted) return Object.assign({}, intent);
      }
      return null;
    }
    const [rows] = await db.query(
      `SELECT * FROM qr_sim_intents WHERE ${field === "token" ? "token" : "intent_id"} = ?`, [wanted]);
    return intentFrom(rows[0]);
  },

  // only a code still waiting can be settled, and only once: true if this one was
  async settle(id, status, paymentId, errorMessage) {
    if (!db) {
      const intent = memory.get(String(id || ""));
      if (!intent || intent.status !== "pending") return false;
      Object.assign(intent, { status, paymentId, errorMessage });
      return true;
    }
    const [result] = await db.query(
      `UPDATE qr_sim_intents SET status = ?, payment_id = ?, error_message = ?
       WHERE intent_id = ? AND status = 'pending'`,
      [status, paymentId, errorMessage, String(id || "")]);
    return result.affectedRows === 1;
  }
};

async function createPayment({ amount, wallet, description, returnUrl }) {
  const now = Date.now();
  await store.forgetBefore(now - FORGET_AFTER_MS);

  const intent = {
    id: randomId("pi"),
    token: crypto.randomBytes(18).toString("base64url"),
    amount: Math.round(Number(amount) * 100) / 100,
    wallet: wallet,
    description: description || "",
    returnUrl: returnUrl,
    status: "pending",
    paymentId: null,
    errorMessage: null,
    createdAt: now
  };
  await store.add(intent);

  // the page lives on this app, at the same address the customer returns to
  const origin = new URL(returnUrl).origin;
  return { providerIntentId: intent.id, payUrl: `${origin}/pay-sim/${intent.token}`, status: "pending" };
}

async function getStatus(providerIntentId) {
  const intent = await store.find("id", providerIntentId);
  if (!intent) {
    return {
      status: "expired",
      providerPaymentId: null,
      errorMessage: "The simulator no longer knows this code (it is more than a day old)."
    };
  }
  return { status: intent.status, providerPaymentId: intent.paymentId, errorMessage: intent.errorMessage };
}

// a cancelled or timed-out code can no longer be paid on its page
async function cancel(providerIntentId) {
  return await store.settle(providerIntentId, "expired", null, "The code was closed before it was paid.");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const WALLET_WORDS = { GCash: "GCash", PayMaya: "Maya" };

// a phone-sized page with nothing to load from elsewhere
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f5f7; color: #1f2933; }
  .banner { background: #b45309; color: #fff; text-align: center; padding: 12px 16px; font-weight: 700; letter-spacing: .04em; }
  .card { max-width: 420px; margin: 24px auto; background: #fff; border-radius: 14px; padding: 24px 20px;
          box-shadow: 0 2px 10px rgba(0,0,0,.08); text-align: center; }
  .amount { font-size: 2.2rem; font-weight: 700; margin: 8px 0; }
  .muted { color: #616e7c; font-size: .95rem; }
  form { margin: 0; }
  button { width: 100%; padding: 14px; font-size: 1.05rem; border: 0; border-radius: 10px; margin-top: 12px; cursor: pointer; }
  .pay { background: #15803d; color: #fff; } .fail { background: #e4e7eb; color: #9b1c1c; }
</style></head><body>
<div class="banner">SIMULATION &ndash; no real money moves</div>
<div class="card">${body}</div></body></html>`;
}

function registerRoutes(app, database) {
  db = database;

  app.get("/pay-sim/:token", async (request, response) => {
    const intent = await store.find("token", request.params.token);
    response.set("Cache-Control", "no-store");
    if (!intent) {
      return response.status(404).send(page("Unknown code",
        "<h2>This code is not known</h2><p class=\"muted\">It may be more than a day old. " +
        "Ask the cashier for a new QR code.</p>"));
    }

    const wallet = WALLET_WORDS[intent.wallet] || intent.wallet;
    if (intent.status !== "pending") {
      const words = { paid: "already paid", failed: "marked as failed", expired: "closed" }[intent.status];
      return response.send(page("Payment " + intent.status,
        `<h2>This payment is ${escapeHtml(words || intent.status)}</h2>` +
        "<p class=\"muted\">You can return to the cashier.</p>"));
    }

    response.send(page("Simulated payment",
      `<p class="muted">Simulated ${escapeHtml(wallet)} payment to Lucelyn Hardware</p>` +
      `<div class="amount">&#8369;${intent.amount.toFixed(2)}</div>` +
      (intent.description ? `<p class="muted">${escapeHtml(intent.description)}</p>` : "") +
      `<form method="post"><input type="hidden" name="result" value="paid">` +
      `<button class="pay" type="submit">Pay</button></form>` +
      `<form method="post"><input type="hidden" name="result" value="failed">` +
      `<button class="fail" type="submit">Fail</button></form>`));
  });

  // a plain form post, so the page works on any phone without scripts
  app.post("/pay-sim/:token", express.urlencoded({ extended: false, limit: "1kb" }), async (request, response) => {
    const intent = await store.find("token", request.params.token);
    if (!intent) return response.status(404).send(page("Unknown code", "<h2>This code is not known</h2>"));

    // only a code still waiting can be paid or failed, and only once
    const result = request.body && request.body.result;
    if (intent.status === "pending" && (result === "paid" || result === "failed")) {
      let paymentId = null;
      let errorMessage = null;
      if (result === "paid") {
        paymentId = randomId("pay");
      } else {
        errorMessage = "The customer pressed Fail on the simulated pay page.";
      }
      await store.settle(intent.id, result, paymentId, errorMessage);
    }

    // the same as PayMongo: back to the shop's return page once done
    const back = new URL(intent.returnUrl);
    back.searchParams.set("payment_intent_id", intent.id);
    response.redirect(303, back.toString());
  });
}

module.exports = {
  name: "sim",
  mode: "test",
  problem: null,
  createPayment,
  getStatus,
  cancel,
  registerRoutes
};
