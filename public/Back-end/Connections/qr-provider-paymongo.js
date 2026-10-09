// ============================================================
// qr-provider-paymongo.js -- GCash and Maya payments through PayMongo
// Loaded by: qr-payments.js only, when PAYMENT_PROVIDER=paymongo. Never sent
// to a browser: it holds the secret key.
//
// The same four things as qr-provider-sim.js, so qr-payments.js never needs
// to know which one it is talking to:
//   createPayment({ amount, wallet, description, returnUrl })
//       -> { providerIntentId, payUrl, status }
//   getStatus(providerIntentId)
//       -> { status: 'pending'|'paid'|'failed'|'expired', providerPaymentId, errorMessage }
//   cancel(providerIntentId)
//   name, mode, problem    which provider, 'test' or 'live', and what is wrong
//                          with the settings (null when nothing is)
// and parseWebhook(rawBody, signatureHeader), for /api/paymongo/webhook.
//
// A payment is three calls to https://api.paymongo.com/v1, all made here with
// the secret key: a payment intent for the amount, a payment method for the
// wallet, and the method attached to the intent. The attach answers with the
// page where the customer approves the payment (next_action.redirect.url);
// that page's address is what the QR code holds.
// ============================================================

const crypto = require("crypto");

const API = "https://api.paymongo.com/v1";

const SECRET_KEY = String(process.env.PAYMONGO_SECRET_KEY || "").trim();

// Test or live is in the key itself: sk_test_ moves no real money.
let mode = null;
if (SECRET_KEY.startsWith("sk_test_")) mode = "test";
if (SECRET_KEY.startsWith("sk_live_")) mode = "live";

// said at start-up and on the cashier's screen, instead of a crash later
let problem = null;
if (SECRET_KEY === "") {
  problem = "PayMongo is chosen (PAYMENT_PROVIDER=paymongo) but PAYMONGO_SECRET_KEY in .env is empty. " +
            "Paste the sk_test_ key from the PayMongo dashboard, or set PAYMENT_PROVIDER=sim.";
} else if (mode === null) {
  problem = "PAYMONGO_SECRET_KEY in .env does not look like a PayMongo secret key " +
            "(it should start with sk_test_ or sk_live_). Copy the Secret key, not the Public key.";
}

// The raw replies are printed while developing, so the field paths read below
// can be checked against what PayMongo really sends. The client_key in a
// payment intent lets a browser act on it, so it is blanked.
const LOG_RAW = mode === "test" || process.env.PAYMONGO_LOG === "1";

// The till asks every 3 seconds, so a status read is printed only when what
// it says has changed since the last one for that payment.
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
  const text = JSON.stringify(body, (key, value) => (key === "client_key" ? "(hidden)" : value));
  console.log(`[PayMongo ${what}] ${text}`);
}

// An error from PayMongo, with its own sentence (errors[0].detail) and the
// field it was about, so the caller can tell a bad return_url from the rest.
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
      // Basic auth: the secret key as the user name and no password
      Authorization: "Basic " + Buffer.from(SECRET_KEY + ":").toString("base64"),
      Accept: "application/json"
    },
    // a hung connection should not hold the cashier's screen forever
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
  logRaw(`${method} ${pathname} -> ${response.status}`, body);

  if (!response.ok) {
    const first = body && Array.isArray(body.errors) && body.errors[0] ? body.errors[0] : {};
    let message = first.detail || `PayMongo refused the request (HTTP ${response.status}).`;
    if (response.status === 401) {
      message = "PayMongo did not accept the secret key. Check PAYMONGO_SECRET_KEY in .env.";
    }
    const field = first.source && first.source.attribute ? first.source.attribute : null;
    throw new PayMongoError(message, response.status, field);
  }
  return body.data;
}

// PayMongo counts in centavos; the shop counts in pesos
function toCentavos(pesos) {
  return Math.round(Number(pesos) * 100);
}

// the type PayMongo names each wallet by
const WALLET_TYPES = { GCash: "gcash", PayMaya: "paymaya" };

async function attach(intentId, methodId, returnUrl) {
  return call("POST", `/payment_intents/${intentId}/attach`, {
    payment_method: methodId,
    return_url: returnUrl
  });
}

async function createPayment({ amount, wallet, description, returnUrl }) {
  const type = WALLET_TYPES[wallet];
  if (!type) throw new PayMongoError("Only GCash and Maya can be paid by QR code.", 400);

  // a) the amount and the wallets it may be paid with
  const intent = await call("POST", "/payment_intents", {
    amount: toCentavos(amount),
    currency: "PHP",
    payment_method_allowed: ["gcash", "paymaya"],
    description: description
  });

  // b) the wallet the customer pays from
  const method = await call("POST", "/payment_methods", { type: type });

  // c) the two together, and where the customer's phone goes once they approve.
  // PayMongo may refuse an address it cannot use (a plain-http LAN one); the
  // shop's public address (HARDWARE_SITE_URL) is tried once in its place.
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
        `PayMongo would not accept ${returnUrl} as the page to return to (${error.message}). ` +
        "Set HARDWARE_SITE_URL in .env to the shop's https address and restart the server.", 400);
    }
    console.warn(`PayMongo refused return_url ${returnUrl}; using HARDWARE_SITE_URL (${fallback}) instead.`);
    attached = await attach(intent.id, method.id, fallback);
  }

  const next = attached.attributes.next_action;
  const payUrl = next && next.redirect ? next.redirect.url : null;
  if (!payUrl) {
    throw new PayMongoError(
      `PayMongo did not give a page to pay on (the payment is ${attached.attributes.status}). Try again.`, 502);
  }

  return { providerIntentId: intent.id, payUrl: payUrl, status: "pending" };
}

async function getStatus(providerIntentId) {
  const intent = await call("GET", `/payment_intents/${encodeURIComponent(providerIntentId)}`);
  const a = intent.attributes;
  const payments = Array.isArray(a.payments) ? a.payments : [];

  if (a.status === "succeeded") {
    const paid = payments.find((p) => p.attributes && p.attributes.status === "paid") || payments[0];
    return {
      status: "paid",
      providerPaymentId: paid ? paid.id : null,
      errorMessage: null
    };
  }

  // A failed or abandoned attempt sends the intent back to waiting for a
  // payment method. The method was attached the moment the code was made, so
  // being back there always means this attempt is over. Checked against the
  // test API: the reason is on the failed payment (failed_message), while
  // last_payment_error stays null; both are read.
  const failure = a.last_payment_error;
  if (failure || a.status === "awaiting_payment_method") {
    const failed = payments.filter((p) => p.attributes && p.attributes.status === "failed").pop();
    const why = (failed && failed.attributes) || failure || {};
    return {
      status: "failed",
      providerPaymentId: failed ? failed.id : null,
      errorMessage: why.failed_message || why.failed_code || "The customer's payment did not go through."
    };
  }

  // closed by cancel() below, when the code ran out or the cashier cancelled it
  if (a.status === "cancelled") {
    return { status: "expired", providerPaymentId: null, errorMessage: "PayMongo has closed this payment." };
  }

  // awaiting_next_action (the customer has not approved yet) and processing
  return { status: "pending", providerPaymentId: null, errorMessage: null };
}

// Closes the payment at PayMongo, so the page in the QR code can no longer be
// paid (checked against the test API: the intent becomes "cancelled"). A
// refusal is only noted; qr-payments.js always checks a code before closing
// it, and a payment that still arrives later is caught there.
async function cancel(providerIntentId) {
  try {
    await call("POST", `/payment_intents/${encodeURIComponent(providerIntentId)}/cancel`);
    return true;
  } catch (error) {
    if (LOG_RAW) console.log(`[PayMongo] cancel ${providerIntentId} not accepted: ${error.message}`);
    return false;
  }
}

// ---------- the webhook (optional) ----------
// PayMongo signs every event it sends: the Paymongo-Signature header reads
// "t=<seconds>,te=<test signature>,li=<live signature>", each signature being
// HMAC-SHA256 of "<t>.<the raw body>" keyed with the webhook's secret. The raw
// body is needed byte for byte, which is why server.js reads this route with
// express.raw() rather than express.json().
const WEBHOOK_SECRET = String(process.env.PAYMONGO_WEBHOOK_SECRET || "").trim();
const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

function webhookRefusal(message, status) {
  const error = new Error(message);
  error.status = status || 400;
  return error;
}

// Gives back { type, intentId, paymentId, failedMessage }, or throws when the
// event cannot be trusted.
function parseWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET) throw webhookRefusal("PAYMONGO_WEBHOOK_SECRET is not set in .env.", 503);
  if (!Buffer.isBuffer(rawBody)) throw webhookRefusal("The event's body could not be read.");

  const parts = {};
  for (const piece of String(header || "").split(",")) {
    const split = piece.indexOf("=");
    if (split > 0) parts[piece.slice(0, split).trim()] = piece.slice(split + 1).trim();
  }

  const sentAt = Number(parts.t);
  if (!Number.isInteger(sentAt)) throw webhookRefusal("The event has no signature.", 401);
  // an old event replayed later is refused (and a clock far ahead, too)
  if (Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_MAX_AGE_SECONDS) {
    throw webhookRefusal("The event is more than five minutes old.", 401);
  }

  const received = String((mode === "live" ? parts.li : parts.te) || "");
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET)
    .update(`${parts.t}.`).update(rawBody).digest("hex");
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

  // data.attributes.type is the event ("payment.paid"); data.attributes.data
  // is the payment, which names its intent in attributes.payment_intent_id
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
  createPayment,
  getStatus,
  cancel,
  parseWebhook
};
