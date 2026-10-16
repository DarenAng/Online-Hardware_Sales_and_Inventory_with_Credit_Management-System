// ============================================================
// store-settings.js -- the shop's default settings, receipt layout and delivery areas
// Loaded by: server.js (handed on to the route files) and database/migrations.js.
// Never sent to a browser.
// ============================================================

const db = require("./database/connection").db;

// The text saved in store_settings.delivery_areas as a plain array of texts.
// Nothing saved yet, or a value that is not a list, reads as an empty list.
function deliveryAreasFrom(savedText) {
  if (!savedText) {
    return [];
  }

  try {
    const list = JSON.parse(savedText);
    if (Array.isArray(list)) {
      // keep only the texts
      const areas = [];
      for (let i = 0; i < list.length; i++) {
        if (typeof list[i] === "string") {
          areas.push(list[i]);
        }
      }
      return areas;
    }
  } catch (error) {
    // not valid JSON: treat it as no list
  }
  return [];
}

// The saved delivery areas, read from the database.
async function readDeliveryAreas() {
  const result = await db.query("SELECT delivery_areas FROM store_settings WHERE setting_id = 1");
  const rows = result[0];
  if (rows.length === 0) {
    return [];
  }
  return deliveryAreasFrom(rows[0].delivery_areas);
}

// Who the shop is and how it is registered. Above the 3,000,000 threshold a
// shop is VAT-registered with 12% inside its prices; below it charges no VAT.
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
  receipt_layout: null
};

// What the receipt looks like until the administrator changes it in Receipt
// Maintenance. Written into store_settings.receipt_layout by the migration,
// so the till and the preview read it from the database like everything else.
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

// The stored layout, checked and filled in from the defaults. Text that is not
// a layout (or a database from before the column) gives the defaults back.
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

  // text trimmed, each run of white space made one space, cut to max characters
  const tidy = function (value, max) {
    let textValue = value;
    if (value === null || value === undefined) textValue = "";
    return String(textValue).trim().replace(/\s+/g, " ").slice(0, max);
  };
  // a list of lines: each tidied to 80 characters, empty ones dropped, at most 10 kept
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
    // fixed wording, not a setting: it only prints on a sale that is fully paid
    paidLabel: DEFAULT_RECEIPT_LAYOUT.paidLabel,
    headerLines: lines(stored.headerLines, DEFAULT_RECEIPT_LAYOUT.headerLines),
    footerLines: lines(stored.footerLines, DEFAULT_RECEIPT_LAYOUT.footerLines),
    show: show
  };
}

module.exports = {
  DEFAULT_STORE_SETTINGS: DEFAULT_STORE_SETTINGS,
  DEFAULT_RECEIPT_LAYOUT: DEFAULT_RECEIPT_LAYOUT,
  receiptLayoutFrom: receiptLayoutFrom,
  deliveryAreasFrom: deliveryAreasFrom,
  readDeliveryAreas: readDeliveryAreas
};
