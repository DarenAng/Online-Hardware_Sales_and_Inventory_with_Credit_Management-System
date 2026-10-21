const crypto = require("crypto");
const express = require("express");

let db = null;
const memory = {};

const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

function randomId(prefix) {
  return prefix + "_sim_" + crypto.randomBytes(8).toString("hex");
}

function intentFrom(row) {
  if (!row) return null;
  return {
    id: row.intent_id,
    token: row.token,
    amount: Number(row.amount),
    wallet: row.wallet,
    bankName: row.bank_name || "",
    description: row.description || "",
    returnUrl: row.return_url,
    status: row.status,
    paymentId: row.payment_id,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at)
  };
}

const store = {
  forgetBefore: async function (time) {
    if (!db) {
      for (const id in memory) {
        if (memory[id].createdAt < time) {
          delete memory[id];
        }
      }
      return;
    }
    await db.query("DELETE FROM qr_sim_intents WHERE created_at < ?", [time]);
  },

  add: async function (intent) {
    if (!db) {
      memory[intent.id] = Object.assign({}, intent);
      return;
    }
    await db.query(
      "INSERT INTO qr_sim_intents\n" +
        "         (intent_id, token, amount, wallet, bank_name, description, return_url, status, created_at)\n" +
        "       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [intent.id, intent.token, intent.amount, intent.wallet, intent.bankName || null,
       String(intent.description).slice(0, 255), intent.returnUrl, intent.status, intent.createdAt]);
  },

  find: async function (field, value) {
    const wanted = String(value || "");
    if (!db) {
      for (const id in memory) {
        const intent = memory[id];
        if (intent[field] === wanted) return Object.assign({}, intent);
      }
      return null;
    }
    const rowsResult = await db.query(
      "SELECT * FROM qr_sim_intents WHERE " + (field === "token" ? "token" : "intent_id") + " = ?", [wanted]);
    const rows = rowsResult[0];
    return intentFrom(rows[0]);
  },

  settle: async function (id, status, paymentId, errorMessage) {
    if (!db) {
      const key = String(id || "");
      let intent;
      if (Object.prototype.hasOwnProperty.call(memory, key)) {
        intent = memory[key];
      }
      if (!intent || intent.status !== "pending") return false;
      Object.assign(intent, { status: status, paymentId: paymentId, errorMessage: errorMessage });
      return true;
    }
    const queryResult = await db.query(
      "UPDATE qr_sim_intents SET status = ?, payment_id = ?, error_message = ?\n" +
        "       WHERE intent_id = ? AND status = 'pending'",
      [status, paymentId, errorMessage, String(id || "")]);
    const result = queryResult[0];
    return result.affectedRows === 1;
  }
};

async function createPayment(options) {
  const amount = options.amount;
  const wallet = options.wallet;
  const bank = options.bank;
  const description = options.description;
  const returnUrl = options.returnUrl;
  const now = Date.now();
  await store.forgetBefore(now - FORGET_AFTER_MS);

  const intent = {
    id: randomId("pi"),
    token: crypto.randomBytes(18).toString("base64url"),
    amount: Math.round(Number(amount) * 100) / 100,
    wallet: wallet,
    bankName: bank ? bank.name : "",
    description: description || "",
    returnUrl: returnUrl,
    status: "pending",
    paymentId: null,
    errorMessage: null,
    createdAt: now
  };
  await store.add(intent);

  const origin = new URL(returnUrl).origin;
  return { providerIntentId: intent.id, payUrl: origin + "/pay-sim/" + intent.token, status: "pending" };
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

async function cancel(providerIntentId) {
  return await store.settle(providerIntentId, "expired", null, "The code was closed before it was paid.");
}

function escapeHtml(text) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, function (c) {
    return replacements[c];
  });
}

const WALLET_WORDS = { GCash: "GCash", PayMaya: "Maya", "Bank Transfer": "bank transfer" };

function page(title, body) {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<meta name=\"robots\" content=\"noindex\"><title>" + escapeHtml(title) + "</title>\n" +
    "<style>\n" +
    "  body { margin: 0; font-family: system-ui, sans-serif; background: #f4f5f7; color: #1f2933; }\n" +
    "  .banner { background: #b45309; color: #fff; text-align: center; padding: 12px 16px; font-weight: 700; letter-spacing: .04em; }\n" +
    "  .card { max-width: 420px; margin: 24px auto; background: #fff; border-radius: 14px; padding: 24px 20px;\n" +
    "          box-shadow: 0 2px 10px rgba(0,0,0,.08); text-align: center; }\n" +
    "  .amount { font-size: 2.2rem; font-weight: 700; margin: 8px 0; }\n" +
    "  .muted { color: #616e7c; font-size: .95rem; }\n" +
    "  form { margin: 0; }\n" +
    "  button { width: 100%; padding: 14px; font-size: 1.05rem; border: 0; border-radius: 10px; margin-top: 12px; cursor: pointer; }\n" +
    "  .pay { background: #15803d; color: #fff; } .fail { background: #e4e7eb; color: #9b1c1c; }\n" +
    "</style></head><body>\n" +
    "<div class=\"banner\">SIMULATION &ndash; no real money moves</div>\n" +
    "<div class=\"card\">" + body + "</div></body></html>";
}

function registerRoutes(app, database) {
  db = database;

  app.get("/pay-sim/:token", async function (request, response) {
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
        "<h2>This payment is " + escapeHtml(words || intent.status) + "</h2>" +
        "<p class=\"muted\">You can return to the cashier.</p>"));
    }

    let who = "Simulated " + wallet + " payment to Lucelyn Hardware";
    if (intent.wallet === "Bank Transfer" && intent.bankName) {
      who = "Simulated online banking: " + intent.bankName + " transfer to Lucelyn Hardware";
    }

    response.send(page("Simulated payment",
      "<p class=\"muted\" id=\"sim-who\">" + escapeHtml(who) + "</p>" +
      "<div class=\"amount\">&#8369;" + intent.amount.toFixed(2) + "</div>" +
      (intent.description ? "<p class=\"muted\">" + escapeHtml(intent.description) + "</p>" : "") +
      "<form method=\"post\"><input type=\"hidden\" name=\"result\" value=\"paid\">" +
      "<button class=\"pay\" type=\"submit\">Pay</button></form>" +
      "<form method=\"post\"><input type=\"hidden\" name=\"result\" value=\"failed\">" +
      "<button class=\"fail\" type=\"submit\">Fail</button></form>"));
  });

  app.post("/pay-sim/:token", express.urlencoded({ extended: false, limit: "1kb" }), async function (request, response) {
    const intent = await store.find("token", request.params.token);
    if (!intent) return response.status(404).send(page("Unknown code", "<h2>This code is not known</h2>"));

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

    const back = new URL(intent.returnUrl);
    back.searchParams.set("payment_intent_id", intent.id);
    response.redirect(303, back.toString());
  });
}

module.exports = {
  name: "sim",
  mode: "test",
  problem: null,
  createPayment: createPayment,
  getStatus: getStatus,
  cancel: cancel,
  registerRoutes: registerRoutes
};
