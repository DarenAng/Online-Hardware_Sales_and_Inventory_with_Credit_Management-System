// passwords.js -- hashing and making passwords
// Loaded by: server.js, login.js and recover-password.js. Never sent to a browser.
//
// Kept apart from server.js so the recovery script run on the server's own
// computer hashes and generates exactly as the running system does.

const crypto = require("crypto");

// ==========================================
// PASSWORDS -- stored as scrypt hashes, format scrypt$<salt>$<hash>
// ==========================================
// crypto.scrypt normally uses a callback; promisify lets us use it with "await"
const util = require("util");
const scrypt = util.promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(plainText) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

const PASSWORD_ALPHABET =
  "ACDEFGHJKLMNPQRTUVWXY" +     // no B, I, O, S, Z
  "acdefghjkmnpqrtuvwxy" +      // no b, i, l, o, s, z
  "34679" +                     // no 0, 1, 2, 5, 8
  "!?-+.$%";
const PASSWORD_LENGTH = 14;

function generatePassword() {
  // randomInt is uniform; a modulo over a random byte is not
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }

  // It must follow the same password rules a person's own password must
  // (passwordComplaint in server.js): a small letter, a capital letter, a
  // digit and a symbol, and no spaces (the alphabet has none).
  // If one is missing, simply make a new password and check again.
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (!hasLower || !hasUpper || !hasDigit || !hasSymbol) {
    return generatePassword();
  }
  return password;
}

async function verifyPassword(plainText, stored) {
  // a row that was never hashed holds the password itself; the caller hashes it
  if (!isHashed(stored)) {
    return typeof stored === "string" && stored.length > 0 && stored === plainText;
  }

  // stored looks like "scrypt$<salt>$<hash>"; split it at the $ signs
  const parts = stored.split("$");
  const salt = parts[1];
  const expected = parts[2];
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const expectedBytes = Buffer.from(expected, "hex");

  if (expectedBytes.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBytes);   // constant time
}

module.exports = { hashPassword, isHashed, generatePassword, verifyPassword };
