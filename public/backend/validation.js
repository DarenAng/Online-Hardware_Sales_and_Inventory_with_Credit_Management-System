// ============================================================
// validation.js -- the rules a phone number, password, name and TIN must follow
// Loaded by: server.js (handed on to the route files), database/migrations.js and routes/shared.js.
// Never sent to a browser.
// ============================================================

const db = require("./database/connection").db;

// A staff phone number is stored as + country code and digits, +639171234567.
// The browser enforces the same rule as it is typed; it is enforced again here
// because this route is not the only way a row gets written. Any Philippine
// spelling (09171234567, 0917 123 4567, 639171234567) lands as +63...; under
// +63 a number must be ten digits starting 9. Blank stays blank.
const PHONE_MAX_DIGITS = 15;
const PHONE_MIN_DIGITS = 7;
const PH_CODE = "63";
const PH_NATIONAL_DIGITS = 10;

// Keeps only the digits of a phone number, and turns a leading 0 into 63.
// Example: "0917 123 4567" -> "639171234567"
function phoneDigitsAll(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");                              // remove everything that is not a digit
  text = text.replace(/^0+/, PH_CODE);                         // 0917... -> 63917...
  text = text.replace(new RegExp("^" + PH_CODE + "0+"), PH_CODE); // 630917... -> 63917...
  return text;
}

function phoneDigits(value) {
  return phoneDigitsAll(value).slice(0, PHONE_MAX_DIGITS);
}

// null when there is nothing to complain about, otherwise the one sentence
// the screen shows
function phoneComplaint(value) {
  const digits = phoneDigitsAll(value);

  if (digits === "") return null;               // optional, and left empty

  // only Philippine numbers are taken; any other code is refused with a reason
  if (digits.indexOf(PH_CODE) !== 0) {
    return "Only Philippine numbers are accepted: 09XX XXX XXXX, or +63 9XX XXX XXXX.";
  }

  const national = digits.slice(PH_CODE.length);
  if (national.length !== PH_NATIONAL_DIGITS) {
    return `A Philippine mobile number is ${PH_NATIONAL_DIGITS} digits after +63 ` +
           `(09XX XXX XXXX). That one has ${national.length}.`;
  }
  if (national[0] !== "9") {
    return "A Philippine mobile number starts with 09 (or +63 9).";
  }
  return null;
}

// What a password someone chooses must have. Each rule has the words used in
// the message and a test. The screens show the same list (format.js).
// It applies when a password is set; passwords already set still sign in.
const PASSWORD_RULES = [
  { need: "at least 8 characters", ok: (password) => password.length >= 8 },
  { need: "an uppercase letter", ok: (password) => /[A-Z]/.test(password) },
  { need: "a lowercase letter", ok: (password) => /[a-z]/.test(password) },
  { need: "a number", ok: (password) => /[0-9]/.test(password) },
  { need: "a symbol such as ! ? - + . $ %", ok: (password) => /[^A-Za-z0-9\s]/.test(password) },
  { need: "no spaces", ok: (password) => !/\s/.test(password) }
];

// null when the password follows every rule, otherwise the one sentence the
// screen shows
function passwordComplaint(password) {
  if (typeof password !== "string" || password === "") {
    return "Type a password.";
  }

  const missing = [];
  for (const rule of PASSWORD_RULES) {
    if (!rule.ok(password)) {
      missing.push(rule.need);
    }
  }

  if (missing.length === 0) return null;
  return "A password needs " + missing.join(", ") + ".";
}

// "0917 123 4567" -> "+639171234567" (an empty box stays empty: null)
function cleanPhone(value) {
  const digits = phoneDigits(value);
  if (digits === "") {
    return null;
  }
  return "+" + digits;
}

// Which staff member already has this phone number? Gives back their name
// and role, or null. Every role counts, active or archived, like the email
// check. Phones are stored as "+639171234567" (cleanPhone), so the typed
// number is cleaned the same way before comparing. staffId leaves out the
// account being edited.
async function findPhoneOwner(phone, staffId) {
  const stored = cleanPhone(phone);
  if (stored === null) return null;   // an empty box has no owner

  const [rows] = await db.query(
    `SELECT s.full_name, r.role_name FROM staff s
     JOIN roles r ON r.role_id = s.role_id
     WHERE s.phone = ? AND s.staff_id <> ?
     LIMIT 1`,
    [stored, Number(staffId) || 0]);
  return rows[0] || null;
}

// the sentence for a refused phone number; owner comes from findPhoneOwner
function phoneTakenMessage(owner) {
  return `That phone number is already used by ${owner.full_name} (${owner.role_name}). ` +
         "Each staff account needs its own phone number.";
}

// The whole middle name is stored; the initial is worked out where it is
// shown. Inner runs of spaces are collapsed, and an empty box stays empty.
function cleanMiddleName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");   // "Dela   Cruz" -> "Dela Cruz"
  if (trimmed === "") {
    return null;
  }
  return trimmed.slice(0, 100);
}

// A staff name is letters only (accents such as é and ñ count as letters),
// with single spaces between words. No numbers, no symbols.
// The sentence to say about a bad name, or null when it is fine.
// Example: nameComplaint("First name", "Juan2") -> "First name can only have letters..."
function nameComplaint(label, value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name === "") return null;   // a required name is checked as missing elsewhere
  if (!/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u.test(name)) {
    return `${label} can only have letters (accents like é and ñ are fine). No numbers or symbols.`;
  }
  return null;
}

// A TIN is nine digits and a branch code, 000-000-000-00000. An older
// three-digit branch code is widened with two zeros; nine digits alone mean
// the head office. All zeros is refused: that is the fresh-install placeholder.
const TIN_BASE_DIGITS = 9;
const TIN_BRANCH_DIGITS = 5;

// keeps only the digits of a TIN (at most 14 of them)
function tinDigitsOf(value) {
  let text = "";
  if (value !== null && value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\D/g, "");   // remove everything that is not a digit
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
    return `A TIN is ${TIN_BASE_DIGITS} digits and a branch code, written ` +
           `000-000-000-00000. That one has ${digits.length} digits.`;
  }
  // the first nine digits are all zeros
  if (/^0+$/.test(digits.slice(0, TIN_BASE_DIGITS))) {
    return "000-000-000 is the placeholder, not a TIN. Enter the number on the " +
           "shop's BIR certificate of registration.";
  }
  return null;
}

// "123456789" -> "123-456-789-00000"
function cleanTin(value) {
  const digits = tinDigitsOf(value);
  const base = digits.slice(0, TIN_BASE_DIGITS);
  const branch = digits.slice(TIN_BASE_DIGITS).padStart(TIN_BRANCH_DIGITS, "0");
  const whole = base + branch;
  return `${whole.slice(0, 3)}-${whole.slice(3, 6)}-${whole.slice(6, 9)}-${whole.slice(9)}`;
}

module.exports = {
  phoneComplaint, passwordComplaint, cleanPhone, findPhoneOwner, phoneTakenMessage,
  cleanMiddleName, nameComplaint, tinComplaint, cleanTin
};
