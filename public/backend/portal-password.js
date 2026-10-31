// Gives a customer a new portal password. Used when the cashier creates a customer and
// by the cashier's "Issue Portal Password" button. Returns the plain password once; only its hash is kept.
const db = require("./database/connection").db;
const passwords = require("./services/passwords");

async function issuePortalPassword(customerId) {
  const password = passwords.generatePortalPassword();
  const hash = await passwords.hashPassword(password);

  const savedResult = await db.query(
    "UPDATE customers\n" +
    "       SET portal_password = ?, portal_password_set_at = NOW(),\n" +
    "           portal_failed_attempts = 0, portal_held_until = NULL\n" +
    "       WHERE customer_id = ? AND is_archived = FALSE",
    [hash, customerId]);
  if (savedResult[0].affectedRows === 0) return null;

  // End the customer's open portal sessions (the portal is a separate app sharing this table).
  await db.query(
    "UPDATE customer_sessions SET ended_reason = ?, ended_at = ?\n" +
    "       WHERE customer_id = ? AND ended_reason IS NULL AND expires_at > ?",
    ["A new portal password was issued, so you were signed out. Sign in with the new one.",
     Date.now(), customerId, Date.now()]);
  return password;
}

module.exports = { issuePortalPassword: issuePortalPassword };
