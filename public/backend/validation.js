const db = require("./database/connection").db;

const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;
const PH_CODE = "63";
const PH_NATIONAL_DIGITS = 10;

function phoneDigitsAll(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");
  text = text.replace(/^0+/, PH_CODE);
  text = text.replace(new RegExp("^" + PH_CODE + "0+"), PH_CODE);
  return text;
}

function phoneDigits(value) {
  return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

function phoneComplaint(value) {
  const digits = phoneDigitsAll(value);

  if (digits === "") return null;

  if (digits.indexOf(PH_CODE) !== 0) {
    return "Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.";
  }

  const national = digits.slice(PH_CODE.length);
  if (national.length !== PH_NATIONAL_DIGITS) {
    return "A Philippine mobile number is " + PH_NATIONAL_DIGITS + " digits after +63 " +
           "(09XX XXX XXXX). That one has " + national.length + ".";
  }
  if (national[0] !== "9") {
    return "A Philippine mobile number starts with 09 (or +63 9).";
  }
  return null;
}

const PASSWORD_RULES = [
  { need: "at least 8 characters", ok: function (password) { return password.length >= 8; } },
  { need: "an uppercase letter", ok: function (password) { return /[A-Z]/.test(password); } },
  { need: "a lowercase letter", ok: function (password) { return /[a-z]/.test(password); } },
  { need: "a number", ok: function (password) { return /[0-9]/.test(password); } },
  { need: "a symbol such as ! ? - + . $ %", ok: function (password) { return /[^A-Za-z0-9\s]/.test(password); } },
  { need: "no spaces", ok: function (password) { return !/\s/.test(password); } }
];

function passwordComplaint(password) {
  if (typeof password !== "string" || password === "") {
    return "Type a password.";
  }

  const missing = [];
  for (let ruleIndex = 0; ruleIndex < PASSWORD_RULES.length; ruleIndex++) {
    const rule = PASSWORD_RULES[ruleIndex];
    if (!rule.ok(password)) {
      missing.push(rule.need);
    }
  }

  if (missing.length === 0) return null;
  return "A password needs " + missing.join(", ") + ".";
}

function cleanPhone(value) {
  const digits = phoneDigits(value);
  if (digits === "") {
    return null;
  }
  return "+" + digits;
}

async function findPhoneOwner(phone, staffId) {
  const stored = cleanPhone(phone);
  if (stored === null) return null;

  const result = await db.query(
    "SELECT s.full_name, r.role_name FROM staff s\n" +
    "     JOIN roles r ON r.role_id = s.role_id\n" +
    "     WHERE s.phone = ? AND s.staff_id <> ?\n" +
    "     LIMIT 1",
    [stored, Number(staffId) || 0]);
  const rows = result[0];
  return rows[0] || null;
}

function phoneTakenMessage(owner) {
  return "That phone number is already used by " + owner.full_name + " (" + owner.role_name + "). " +
         "Each staff account needs its own phone number.";
}

function cleanMiddleName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed === "") {
    return null;
  }
  return trimmed.slice(0, 100);
}

function nameComplaint(label, value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name === "") return null;
  if (!/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u.test(name)) {
    return label + " can only have letters (accents like é and ñ are fine). No numbers or symbols.";
  }
  return null;
}

const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

function tinDigitsOf(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");
  return text.slice(0, TIN_BASE_DIGITS + TIN_BRANCH_DIGITS);
}

function tinComplaint(value) {
  const digits = tinDigitsOf(value);

  if (digits === "") {
    return "The shop needs a TIN. It is printed on every invoice.";
  }
  if (digits.length !== TIN_BASE_DIGITS &&
      digits.length !== TIN_BASE_DIGITS + 3 &&
      digits.length !== TIN_BASE_DIGITS + TIN_BRANCH_DIGITS) {
    return "A TIN is " + TIN_BASE_DIGITS + " digits and a branch code, written " +
           "000-000-000-00000. That one has " + digits.length + " digits.";
  }
  if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
    return "000-000-000 is the placeholder, not a TIN. Enter the number on the " +
           "shop's BIR certificate of registration.";
  }
  return null;
}

function cleanTin(value) {
  const digits = tinDigitsOf(value);
  const base = digits.slice(0, TIN_BASE_DIGITS);
  const branch = digits.slice(TIN_BASE_DIGITS).padStart(TIN_BRANCH_DIGITS, "0");
  const whole = base + branch;
  return whole.slice(0, 3) + "-" + whole.slice(3, 6) + "-" + whole.slice(6, 9) + "-" + whole.slice(9);
}

module.exports = {
  phoneComplaint: phoneComplaint,
  passwordComplaint: passwordComplaint,
  cleanPhone: cleanPhone,
  findPhoneOwner: findPhoneOwner,
  phoneTakenMessage: phoneTakenMessage,
  cleanMiddleName: cleanMiddleName,
  nameComplaint: nameComplaint,
  tinComplaint: tinComplaint,
  cleanTin: cleanTin
};
