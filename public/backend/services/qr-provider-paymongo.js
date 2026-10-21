const crypto = require("crypto");

const API = "https://api.paymongo.com/v1";

const SECRET_KEY = String(process.env.PAYMONGO_SECRET_KEY || "").trim();

let mode = null;
if (SECRET_KEY.startsWith("sk_test_")) mode = "test";
if (SECRET_KEY.startsWith("sk_live_")) mode = "live";

let problem = null;
if (SECRET_KEY === "") {
  problem = "PayMongo is chosen (PAYMENT_PROVIDER=paymongo) but PAYMONGO_SECRET_KEY in .env is empty. " +
            "Paste the sk_test_ key from the PayMongo dashboard, or set PAYMENT_PROVIDER=sim.";
} else if (mode === null) {
  problem = "PAYMONGO_SECRET_KEY in .env does not look like a PayMongo secret key " +
            "(it should start with sk_test_ or sk_live_). Copy the Secret key, not the Public key.";
}

const LOG_RAW = mode === "test" || process.env.PAYMONGO_LOG === "1";

const lastLogged = new Map();

function logRaw(what, body) {
  if (!LOG_RAW) return;
  if (what.startsWith("GET ") && body && body.data && body.data.attributes) {
    const id = body.data.id;
    const status = body.data.attributes.status;
    if (lastLogged.get(id) === status) return;
    lastLogged.set(id, status);
    if (lastLogged.size > 500) lastLogged.delete(lastLogged.keys().next().value);
  }
  const text = JSON.stringify(body, function (key, value) {
    if (key === "client_key") return "(hidden)";
    return value;
  });
  console.log("[PayMongo " + what + "] " + text);
}

class PayMongoError extends Error {
  constructor(message, httpStatus, field) {
    super(message);
    this.httpStatus = httpStatus;
    this.field = field || null;
  }
}

async function call(method, pathname, attributes) {
  if (problem) throw new PayMongoError(problem, 500);

  const options = {
    method: method,
    headers: {
      Authorization: "Basic " + Buffer.from(SECRET_KEY + ":").toString("base64"),
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  };
  if (attributes) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({ data: { attributes: attributes } });
  }

  let response;
  try {
    response = await fetch(API + pathname, options);
  } catch (error) {
    throw new PayMongoError(
      "PayMongo could not be reached. Check this computer's internet connection, " +
      "or switch to PAYMENT_PROVIDER=sim for an offline demo.", 503);
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  logRaw(method + " " + pathname + " -> " + response.status, body);

  if (!response.ok) {
    const first = body && Array.isArray(body.errors) && body.errors[0] ? body.errors[0] : {};
    let message = first.detail || "PayMongo refused the request (HTTP " + response.status + ").";
    if (response.status === 401) {
      message = "PayMongo did not accept the secret key. Check PAYMONGO_SECRET_KEY in .env.";
    }
    const field = first.source && first.source.attribute ? first.source.attribute : null;
    throw new PayMongoError(message, response.status, field);
  }
  return body.data;
}

function toCentavos(pesos) {
  return Math.round(Number(pesos) * 100);
}

const WALLET_TYPES = { GCash: "gcash", PayMaya: "paymaya" };

const TEST_BANK_CODES = { bpi: "test_bank_one", ubp: "test_bank_two" };

function bankCodeFor(code) {
  if (mode === "test" && TEST_BANK_CODES[code]) return TEST_BANK_CODES[code];
  return code;
}

async function attach(intentId, methodId, returnUrl) {
  return call("POST", "/payment_intents/" + intentId + "/attach", {
    payment_method: methodId,
    return_url: returnUrl
  });
}

async function createPayment(options) {
  const amount = options.amount;
  const wallet = options.wallet;
  const bank = options.bank;
  const description = options.description;
  const returnUrl = options.returnUrl;

  let type = WALLET_TYPES[wallet];
  let allowed = ["gcash", "paymaya"];
  let methodAttributes = null;
  if (wallet === "Bank Transfer") {
    if (!bank) throw new PayMongoError("Pick the customer's bank.", 400);
    type = bank.type;
    allowed = [type];
    methodAttributes = { type: type, details: { bank_code: bankCodeFor(bank.code) } };
  }
  if (!type) throw new PayMongoError("Only GCash, Maya and bank transfers can be paid by QR code.", 400);

  const intent = await call("POST", "/payment_intents", {
    amount: toCentavos(amount),
    currency: "PHP",
    payment_method_allowed: allowed,
    description: description
  });

  let method;
  try {
    method = await call("POST", "/payment_methods", methodAttributes || { type: type });
  } catch (error) {
    await cancel(intent.id);
    throw error;
  }

  let attached;
  try {
    attached = await attach(intent.id, method.id, returnUrl);
  } catch (error) {
    const site = String(process.env.HARDWARE_SITE_URL || "").trim().replace(/\/+$/, "");
    const aboutReturnUrl = error.field === "return_url" || /return_url/i.test(error.message);
    if (!aboutReturnUrl) throw error;

    const fallback = site ? site + "/pay/done" : "";
    if (!fallback || fallback === returnUrl) {
      throw new PayMongoError(
        "PayMongo would not accept " + returnUrl + " as the page to return to (" + error.message + "). " +
        "Set HARDWARE_SITE_URL in .env to the shop's https address and restart the server.", 400);
    }
    console.warn("PayMongo refused return_url " + returnUrl + "; using HARDWARE_SITE_URL (" + fallback + ") instead.");
    attached = await attach(intent.id, method.id, fallback);
  }

  const next = attached.attributes.next_action;
  const payUrl = next && next.redirect ? next.redirect.url : null;
  if (!payUrl) {
    throw new PayMongoError(
      "PayMongo did not give a page to pay on (the payment is " + attached.attributes.status + "). Try again.", 502);
  }

  return { providerIntentId: intent.id, payUrl: payUrl, status: "pending" };
}

async function getStatus(providerIntentId) {
  const intent = await call("GET", "/payment_intents/" + encodeURIComponent(providerIntentId));
  const a = intent.attributes;
  const payments = Array.isArray(a.payments) ? a.payments : [];

  if (a.status === "succeeded") {
    let paid = payments[0];
    for (let i = 0; i < payments.length; i++) {
      if (payments[i].attributes && payments[i].attributes.status === "paid") {
        paid = payments[i];
        break;
      }
    }
    return {
      status: "paid",
      providerPaymentId: paid ? paid.id : null,
      errorMessage: null
    };
  }

  const failure = a.last_payment_error;
  if (failure || a.status === "awaiting_payment_method") {
    let failed;
    for (let i = 0; i < payments.length; i++) {
      if (payments[i].attributes && payments[i].attributes.status === "failed") {
        failed = payments[i];
      }
    }
    const why = (failed && failed.attributes) || failure || {};
    return {
      status: "failed",
      providerPaymentId: failed ? failed.id : null,
      errorMessage: why.failed_message || why.failed_code || "The customer's payment did not go through."
    };
  }

  if (a.status === "cancelled") {
    return { status: "expired", providerPaymentId: null, errorMessage: "PayMongo has closed this payment." };
  }

  return { status: "pending", providerPaymentId: null, errorMessage: null };
}

async function cancel(providerIntentId) {
  try {
    await call("POST", "/payment_intents/" + encodeURIComponent(providerIntentId) + "/cancel");
    return true;
  } catch (error) {
    if (LOG_RAW) console.log("[PayMongo] cancel " + providerIntentId + " not accepted: " + error.message);
    return false;
  }
}

const WEBHOOK_SECRET = String(process.env.PAYMONGO_WEBHOOK_SECRET || "").trim();
const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

function webhookRefusal(message, status) {
  const error = new Error(message);
  error.status = status || 400;
  return error;
}

function parseWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET) throw webhookRefusal("PAYMONGO_WEBHOOK_SECRET is not set in .env.", 503);
  if (!Buffer.isBuffer(rawBody)) throw webhookRefusal("The event's body could not be read.");

  const parts = {};
  const pieces = String(header || "").split(",");
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
    const piece = pieces[pieceIndex];
    const split = piece.indexOf("=");
    if (split > 0) parts[piece.slice(0, split).trim()] = piece.slice(split + 1).trim();
  }

  const sentAt = Number(parts.t);
  if (!Number.isInteger(sentAt)) throw webhookRefusal("The event has no signature.", 401);
  if (Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_MAX_AGE_SECONDS) {
    throw webhookRefusal("The event is more than five minutes old.", 401);
  }

  const received = String((mode === "live" ? parts.li : parts.te) || "");
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET)
    .update(parts.t + ".").update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw webhookRefusal("The event's signature does not match.", 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    throw webhookRefusal("The event is not JSON.");
  }
  logRaw("webhook", event);

  const attributes = event && event.data && event.data.attributes ? event.data.attributes : {};
  const payment = attributes.data || {};
  const paid = payment.attributes || {};
  return {
    type: attributes.type || null,
    intentId: paid.payment_intent_id || null,
    paymentId: payment.id || null,
    failedMessage: paid.failed_message || paid.failed_code || null
  };
}

module.exports = {
  name: "paymongo",
  mode: mode || "test",
  problem: problem,
  createPayment: createPayment,
  getStatus: getStatus,
  cancel: cancel,
  parseWebhook: parseWebhook
};
