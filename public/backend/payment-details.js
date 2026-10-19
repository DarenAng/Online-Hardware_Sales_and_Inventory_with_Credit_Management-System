// ============================================================
// payment-details.js -- the bank and account behind a cheque or a bank transfer, and the banks PayMongo can take a transfer from
// Loaded by: routes/cashier.js, routes/delivery.js and routes/qr-payments.js. Never sent to a browser.
//
// A cheque is recorded with the account name and account number printed on it,
// the bank and its branch, and the date written on it (the cheque number is the
// payment's reference). A bank transfer is recorded with the customer's bank,
// account name and account number. The browser checks the same rules as it is
// typed (scripts/shared/payment-details.js); they are checked again here, because
// the server is the one that has the last word.
// ============================================================

const helpers = require("./helpers");
const tidy = helpers.tidy;
const isDateText = helpers.isDateText;

// The banks a customer can pay from through PayMongo's online banking, with
// the PayMongo payment type each one goes through and the smallest payment it
// takes (PayMongo answers "parameter_below_minimum" below it). The browser has
// the same list (PAYMONGO_BANKS in scripts/shared/payment-details.js).
const PAYMONGO_BANKS = [
  { code: "bpi",       name: "BPI",       type: "dob",    minimum: 1 },
  { code: "ubp",       name: "UnionBank", type: "dob",    minimum: 1 },
  { code: "bdo",       name: "BDO",       type: "brankas", minimum: 100 },
  { code: "landbank",  name: "Landbank",  type: "brankas", minimum: 1 },
  { code: "metrobank", name: "Metrobank", type: "brankas", minimum: 1 }
];

function findBank(code) {
  for (let i = 0; i < PAYMONGO_BANKS.length; i++) {
    if (PAYMONGO_BANKS[i].code === code) return PAYMONGO_BANKS[i];
  }
  return null;
}

// "2026-10-20" for a day in local time (toISOString alone would give the UTC day)
function dayText(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// true when the text is a real calendar day ("2026-02-30" is not)
function isRealDay(text) {
  if (!isDateText(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// A cheque is stale six months after its date, and a date more than a year
// ahead is a typing mistake.
function chequeDateProblem(text) {
  if (text === "") return "Enter the date written on the cheque.";
  if (!isRealDay(text)) return "The cheque date is not a real date. Use the date picker, or write it as 2026-10-20.";

  const now = new Date();
  const earliest = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const latest = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  if (text < dayText(earliest)) return "That cheque is dated more than six months ago, so the bank will not take it (stale cheque).";
  if (text > dayText(latest)) return "That cheque is dated more than a year ahead. Check the date written on it.";
  return null;
}

// the account number, kept as digits only; null when it is not a believable one
function cleanAccountNumber(value) {
  const digits = String(value === null || value === undefined ? "" : value).replace(/[\s-]/g, "");
  if (!/^\d{6,20}$/.test(digits)) return null;
  return digits;
}

// null when the account name is fine, otherwise the one sentence to show
function accountNameProblem(name, whose) {
  if (name === "") return "Enter the account name" + whose + ".";
  if (name.length < 2) return "The account name is too short.";
  if (name.length > 100) return "The account name is at most 100 characters.";
  if (!/[A-Za-z]/.test(name)) return "The account name needs letters in it.";
  return null;
}

// The details of one payment, tidied and checked. method is "Cheque" or
// "Bank Transfer"; raw is what the request carried (it may be anything).
// Gives back { problem, details }: problem is null when all is well, and
// details is { bank, branch, accountName, accountNumber, chequeDate } for the
// procedure (a bank transfer has no branch or chequeDate: they are left out, as
// the procedure reads a missing key as nothing).
//
// A bank transfer paid through PayMongo has its details checked when the QR
// code is made (qr-payments.js), not here; this is for a transfer the driver
// is shown at the door, which is only taken on the driver's word.
function cleanPaymentDetails(method, raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const cheque = method === "Cheque";
  const whose = cheque ? " on the cheque" : "";

  const accountName = tidy(body.accountName);
  const accountNameComplaint = accountNameProblem(accountName, whose);
  if (accountNameComplaint) return { problem: accountNameComplaint, details: null };

  const accountNumber = cleanAccountNumber(body.accountNumber);
  if (accountNumber === null) {
    return { problem: "Enter the account number" + whose + ": 6 to 20 digits, no letters.", details: null };
  }

  const bank = tidy(body.bank);
  if (bank.length < 2) {
    return { problem: cheque ? "Enter the bank the cheque is drawn on." : "Enter the customer's bank.", details: null };
  }
  if (bank.length > 80) return { problem: "The bank is at most 80 characters.", details: null };

  const details = { bank: bank, accountName: accountName, accountNumber: accountNumber };
  if (cheque) {
    const branch = tidy(body.branch);
    if (branch.length < 2) return { problem: "Enter the bank's branch.", details: null };
    if (branch.length > 80) return { problem: "The branch is at most 80 characters.", details: null };

    const chequeDate = tidy(body.chequeDate);
    const dateComplaint = chequeDateProblem(chequeDate);
    if (dateComplaint) return { problem: dateComplaint, details: null };

    details.branch = branch;
    details.chequeDate = chequeDate;
  }

  return { problem: null, details: details };
}

module.exports = {
  PAYMONGO_BANKS: PAYMONGO_BANKS,
  findBank: findBank,
  cleanPaymentDetails: cleanPaymentDetails,
  cleanAccountNumber: cleanAccountNumber,
  accountNameProblem: accountNameProblem
};
