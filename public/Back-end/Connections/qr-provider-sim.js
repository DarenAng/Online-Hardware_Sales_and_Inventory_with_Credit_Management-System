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
// memory, so a restart forgets them; a code on screen then reads as expired.
// ============================================================

const crypto = require("crypto");
const express = require("express");

// every payment made since the server started, by its intent id
const intents = new Map();
// the same payments by the secret in their pay page's address
const byToken = new Map();

// a day is far longer than any code lasts; a server left running for weeks
// should not keep every one
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

function randomId(prefix) {
  return `${prefix}_sim_${crypto.randomBytes(8).toString("hex")}`;
}

async function createPayment({ amount, wallet, description, returnUrl }) {
  const now = Date.now();
  for (const [id, old] of intents) {
    if (now - old.createdAt > FORGET_AFTER_MS) {
      intents.delete(id);
      byToken.delete(old.token);
    }
  }

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
  intents.set(intent.id, intent);
  byToken.set(intent.token, intent);

  // the page lives on this app, at the same address the customer returns to
  const origin = new URL(returnUrl).origin;
  return { providerIntentId: intent.id, payUrl: `${origin}/pay-sim/${intent.token}`, status: "pending" };
}

async function getStatus(providerIntentId) {
  const intent = intents.get(String(providerIntentId || ""));
  if (!intent) {
    return {
      status: "expired",
      providerPaymentId: null,
      errorMessage: "The simulator no longer knows this code (the server was restarted)."
    };
  }
  return { status: intent.status, providerPaymentId: intent.paymentId, errorMessage: intent.errorMessage };
}

// a cancelled or timed-out code can no longer be paid on its page
async function cancel(providerIntentId) {
  const intent = intents.get(String(providerIntentId || ""));
  if (!intent || intent.status !== "pending") return false;
  intent.status = "expired";
  intent.errorMessage = "The code was closed before it was paid.";
  return true;
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

function registerRoutes(app) {
  app.get("/pay-sim/:token", (request, response) => {
    const intent = byToken.get(request.params.token);
    response.set("Cache-Control", "no-store");
    if (!intent) {
      return response.status(404).send(page("Unknown code",
        "<h2>This code is not known</h2><p class=\"muted\">It may be from before the shop's server restarted. " +
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
  app.post("/pay-sim/:token", express.urlencoded({ extended: false, limit: "1kb" }), (request, response) => {
    const intent = byToken.get(request.params.token);
    if (!intent) return response.status(404).send(page("Unknown code", "<h2>This code is not known</h2>"));

    const result = request.body && request.body.result;
    if (intent.status === "pending" && (result === "paid" || result === "failed")) {
      intent.status = result;
      if (result === "paid") {
        intent.paymentId = randomId("pay");
      } else {
        intent.errorMessage = "The customer pressed Fail on the simulated pay page.";
      }
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
