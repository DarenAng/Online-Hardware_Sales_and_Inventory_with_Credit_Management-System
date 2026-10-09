// A manual check of the PayMongo connection (not part of run-all.sh): makes one
// real TEST-MODE payment through public/Back-end/Connections/qr-provider-paymongo.js
// and prints the page to pay it on. Open that page, press Authorize or Fail,
// and this script prints what PayMongo reports. Nothing touches the database.
//
//     node tests/paymongo-check.js            GCash, 100.00
//     node tests/paymongo-check.js PayMaya 25
//
// It refuses to run with a live key: a live payment is real money.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const provider = require("../public/Back-end/Connections/qr-provider-paymongo");

const wallet = process.argv[2] === "PayMaya" ? "PayMaya" : "GCash";
const amount = Number(process.argv[3]) || 100;
const WAIT_SECONDS = 180;

(async function main() {
  if (provider.problem) {
    console.error(provider.problem);
    process.exit(1);
  }
  if (provider.mode !== "test") {
    console.error("This check only runs with a test key (sk_test_). A live key would move real money.");
    process.exit(1);
  }

  const site = String(process.env.HARDWARE_SITE_URL || "").trim().replace(/\/+$/, "");
  const returnUrl = (site || "http://localhost:" + (process.env.HARDWARE_PORT || 3000)) + "/pay/done";

  console.log(`Making a ${wallet} test payment of ${amount.toFixed(2)} (returns to ${returnUrl})...`);
  const made = await provider.createPayment({
    amount, wallet, description: "Lucelyn Hardware connection check", returnUrl
  });
  console.log("\nPayment intent:", made.providerIntentId);
  console.log("Open this page and press Authorize (or Fail):\n\n  " + made.payUrl + "\n");

  const started = Date.now();
  let last = null;
  while (Date.now() - started < WAIT_SECONDS * 1000) {
    const state = await provider.getStatus(made.providerIntentId);
    if (state.status !== last) {
      console.log(`status: ${state.status}` +
        (state.providerPaymentId ? `  payment ${state.providerPaymentId}` : "") +
        (state.errorMessage ? `  (${state.errorMessage})` : ""));
      last = state.status;
    }
    if (state.status !== "pending") process.exit(state.status === "paid" ? 0 : 2);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.log(`Still pending after ${WAIT_SECONDS} seconds; the connection works, nobody paid.`);
})().catch((error) => {
  console.error("PayMongo check failed:", error.message);
  process.exit(1);
});
