const helpers = require("./helpers");
const tidy = helpers.tidy;
const isDateText = helpers.isDateText;

const PAYMONGO_BANKS = [
  { code: "bpi",       name: "BPI",       type: "dob",    minimum: 1 },
  { code: "ubp",       name: "UnionBank", type: "dob",    minimum: 1 }
];

function findBank(code) {
  for (let i = 0; i < PAYMONGO_BANKS.length; i++) {
    if (PAYMONGO_BANKS[i].code === code) return PAYMONGO_BANKS[i];
  }
  return null;
}

function dayText(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isRealDay(text) {
  if (!isDateText(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function chequeDateProblem(text) {
  if (text === "") return "Enter the date written on the cheque.";
  if (!isRealDay(text)) return "The cheque date is not a real date. Use the date picker, or write it as 2026-10-20.";

  const now = new Date();
  const earliest = now;
  const latest = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  if (text < dayText(earliest)) return "A cheque cannot be dated before today. Pick today or a later date.";
  if (text > dayText(latest)) return "That cheque is dated more than a year ahead. Check the date written on it.";
  return null;
}

function cleanAccountNumber(value) {
  const digits = String(value === null || value === undefined ? "" : value).replace(/[\s-]/g, "");
  if (!/^\d{6,20}$/.test(digits)) return null;
  return digits;
}

function accountNameProblem(name, whose) {
  if (name === "") return "Enter the account name" + whose + ".";
  if (name.length < 2) return "The account name is too short.";
  if (name.length > 100) return "The account name is at most 100 characters.";
  if (!/[A-Za-z]/.test(name)) return "The account name needs letters in it.";
  return null;
}

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
    if (branch.length > 80) return { problem: "The branch is at most 80 characters.", details: null };

    const chequeDate = tidy(body.chequeDate);
    const dateComplaint = chequeDateProblem(chequeDate);
    if (dateComplaint) return { problem: dateComplaint, details: null };

    if (branch !== "") details.branch = branch;
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
