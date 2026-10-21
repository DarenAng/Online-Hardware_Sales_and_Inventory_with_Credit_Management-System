const DEFAULT_STORE_SETTINGS = {
  store_name: "Lucelyn Hardware",
  proprietor: null,
  address: "Set your address in System Administration",
  tin: "000-000-000-00000",
  registration_type: "VAT",
  vat_rate: "12.00",
  invoice_note: null,
  penalty_rate: "3.00",
  bank_name: null,
  bank_account_name: null,
  bank_account_number: null,
  receipt_layout: null,
  credit_terms: null,
  data_terms: null,
  refund_policy: null
};

const DEFAULT_CREDIT_TERMS = [
  "Every credit purchase is paid in full by its due date, shown on the receipt.",
  "A purchase paid late is charged the late-payment penalty for every month or part of a month it stays unpaid.",
  "The store may hold, lower or stop the customer's credit when payments are late or the limit is exceeded.",
  "The customer keeps every receipt and payment slip as proof of purchase and payment.",
  "The customer tells the store of any change of address or contact number.",
  "By signing, the customer confirms these details and accepts these terms."
].join("\n");

const DEFAULT_DATA_TERMS = [
  "The store collects the customer's name, address, contact number and purchase records only to sell, deliver, give credit and collect payment.",
  "This information is seen only by authorized staff and is not sold or shared, except with a courier or where the law requires.",
  "The customer may ask to see, correct or update it at any time.",
  "Handled under the Data Privacy Act of 2012 (RA 10173)."
].join("\n");

const DEFAULT_REFUND_POLICY = [
  "Returns within 3 days of purchase, with the receipt.",
  "Goods must be unused, undamaged and in their original packaging.",
  "Goods cut to size, mixed or specially ordered cannot be returned.",
  "A refund on a credit purchase first reduces the balance owed."
].join("\n");

const DEFAULT_RECEIPT_LAYOUT = {
  paperWidth: 80,
  fontSize: 12,
  title: "Sales Invoice",
  paidLabel: "PAID IN FULL",
  headerLines: [],
  footerLines: ["Thank you for your purchase"],
  show: {
    proprietor: true, cashier: true, customer: true, payment: true, reference: true,
    item_count: true, tax: true, bank: true, note: true
  }
};

function receiptLayoutFrom(raw) {
  let stored = raw;
  if (typeof raw === "string") {
    try {
      stored = JSON.parse(raw);
    } catch (error) {
      stored = null;
    }
  }
  if (!stored || typeof stored !== "object") stored = {};

  const tidy = function (value, max) {
    let textValue = value;
    if (value === null || value === undefined) textValue = "";
    return String(textValue).trim().replace(/\s+/g, " ").slice(0, max);
  };
  const lines = function (value, fallback) {
    if (!Array.isArray(value)) return fallback.slice();
    const kept = [];
    for (let i = 0; i < value.length; i++) {
      const line = tidy(value[i], 80);
      if (line !== "") {
        kept.push(line);
      }
    }
    return kept.slice(0, 10);
  };
  const text = function (value, fallback, max) {
    const cleaned = tidy(value, max);
    if (cleaned === "") return fallback;
    return cleaned;
  };

  const show = {};
  const showKeys = Object.keys(DEFAULT_RECEIPT_LAYOUT.show);
  for (let keyIndex = 0; keyIndex < showKeys.length; keyIndex++) {
    const key = showKeys[keyIndex];
    const wanted = stored.show && stored.show[key];
    if (typeof wanted === "boolean") {
      show[key] = wanted;
    } else {
      show[key] = DEFAULT_RECEIPT_LAYOUT.show[key];
    }
  }

  let paperWidth = DEFAULT_RECEIPT_LAYOUT.paperWidth;
  if ([58, 80].includes(Number(stored.paperWidth))) {
    paperWidth = Number(stored.paperWidth);
  }
  let fontSize = DEFAULT_RECEIPT_LAYOUT.fontSize;
  if ([11, 12, 13].includes(Number(stored.fontSize))) {
    fontSize = Number(stored.fontSize);
  }

  return {
    paperWidth: paperWidth,
    fontSize: fontSize,
    title: text(stored.title, DEFAULT_RECEIPT_LAYOUT.title, 40),
    paidLabel: DEFAULT_RECEIPT_LAYOUT.paidLabel,
    headerLines: lines(stored.headerLines, DEFAULT_RECEIPT_LAYOUT.headerLines),
    footerLines: lines(stored.footerLines, DEFAULT_RECEIPT_LAYOUT.footerLines),
    show: show
  };
}

module.exports = {
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS,
  DEFAULT_CREDIT_TERMS: DEFAULT_CREDIT_TERMS,
  DEFAULT_DATA_TERMS: DEFAULT_DATA_TERMS,
  DEFAULT_REFUND_POLICY: DEFAULT_REFUND_POLICY,
  DEFAULT_RECEIPT_LAYOUT: DEFAULT_RECEIPT_LAYOUT,
  receiptLayoutFrom: receiptLayoutFrom
};
