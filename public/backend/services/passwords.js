const crypto = require("crypto");

const util = require("util");
const scrypt = util.promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(plainText) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return "scrypt$" + salt + "$" + derived.toString("hex");
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

const PASSWORD_ALPHABET =
  "ACDEFGHJKLMNPQRTUVWXY" +
  "acdefghjkmnpqrtuvwxy" +
  "34679" +
  "!?-+.$%";
const PASSWORD_LENGTH = 14;

function generatePassword() {
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }

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
  if (!isHashed(stored)) {
    return typeof stored === "string" && stored.length > 0 && stored === plainText;
  }

  const parts = stored.split("$");
  const salt = parts[1];
  const expected = parts[2];
  const derived = await scrypt(plainText, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const expectedBytes = Buffer.from(expected, "hex");

  if (expectedBytes.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expectedBytes);
}

module.exports = {
  hashPassword: hashPassword,
  isHashed: isHashed,
  generatePassword: generatePassword,
  verifyPassword: verifyPassword
};
