const PDFDocument = require("pdfkit");

const INK = "#14181d";
const STEEL = "#4d5661";
const LINE = "#d5d8dd";
const CHROME = "#1b1f24";
const BRAND = "#f04e23";
const GO = "#d0400f";
const SIGNAL = "#f5b301";
const SIGNAL_DIM = "#fdf3d6";

function pdfText(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/₱/g, "PHP ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "?");
}

function peso(value) {
  return "PHP " + Number(value || 0).toLocaleString("en-PH",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quantityText(value) {
  const number = Number(value || 0);
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function priceCell(item) {
  if (!(Number(item.unit_cost) > 0)) return ["--", null];
  if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
    return [peso(Math.round(Number(item.unit_cost) * Number(item.pack_size) * 100) / 100), "per " + item.pack_name];
  }
  return [peso(item.unit_cost), "per " + (item.unit_name || "unit")];
}

function lineQuantity(item) {
  const unit = item.unit_name || "units";
  if (item.pack_name && Number(item.pack_size) > 0 && Number(item.pack_count) > 0) {
    return quantityText(item.pack_count) + " " + item.pack_name + " (" + quantityText(item.quantity) + " " + unit + ")";
  }
  return quantityText(item.quantity) + " " + unit;
}

function statusWords(order) {
  if (order.status === "For Approval") return "Pending Manager Approval";
  if (order.status === "Cancelled") return "Declined - Manager";
  if (order.status === "Pending") {
    if (order.supplier_response === "Accepted") return "Accepted";
    if (order.supplier_response === "Declined") return "Declined - Supplier";
    if (order.supplier_sent_at) return "Pending Supplier Confirmation";
    return "Approved";
  }
  return order.status || "";
}

function purchaseOrderPdf(details) {
  const order = details.order;
  const items = details.items || [];
  const shop = details.shop || {};

  const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true,
    info: { Title: "Purchase Order PO-" + String(order.po_id).padStart(6, "0"),
            Author: shop.store_name || "Lucelyn Hardware" } });

  const chunks = [];
  doc.on("data", function (chunk) {
    chunks.push(chunk);
  });
  const done = new Promise(function (resolve, reject) {
    doc.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const right = left + width;
  const bottom = function () {
    return doc.page.height - doc.page.margins.bottom;
  };

  const shopName = shop.store_name || "Lucelyn Hardware";
  const number = "PO-" + String(order.po_id).padStart(6, "0");
  const raised = String(order.order_date || "").slice(0, 10);

  doc.save();
  doc.rect(0, 0, doc.page.width, 8).clip();
  doc.rect(0, 0, doc.page.width, 8).fill(CHROME);
  for (let x = -10; x < doc.page.width + 10; x += 20) {
    doc.polygon([x, 8], [x + 10, 8], [x + 18, 0], [x + 8, 0]).fill(BRAND);
  }
  doc.restore();

  let y = 40;
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(pdfText(shopName), left, y, { width: width * 0.6 });
  doc.font("Helvetica").fontSize(9.5).fillColor(STEEL);
  if (shop.address) doc.text(pdfText(shop.address), { width: width * 0.6 });
  if (shop.tin) {
    doc.text(pdfText("TIN " + shop.tin + (shop.registration_type ? " · " + shop.registration_type : "")),
      { width: width * 0.6 });
  }
  const shopBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(11).fillColor(GO)
    .text("PURCHASE ORDER", left, y + 2, { width: width, align: "right", characterSpacing: 1.6 });
  doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text(number, { width: width, align: "right" });
  doc.font("Helvetica").fontSize(9.5).fillColor(STEEL)
    .text(pdfText("Raised " + raised), { width: width, align: "right" })
    .text(pdfText(statusWords(order)), { width: width, align: "right" });

  y = Math.max(shopBottom, doc.y) + 14;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(INK).stroke();
  y += 18;

  const half = (width - 24) / 2;
  const party = function (x, label, name, lines) {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(STEEL)
      .text(label, x, y, { width: half, characterSpacing: 1.2 });
    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(12.5).fillColor(INK).text(pdfText(name), { width: half });
    doc.font("Helvetica").fontSize(9.5).fillColor(STEEL);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line) doc.text(pdfText(line), { width: half });
    }
    return doc.y;
  };
  const supplierBottom = party(left, "ORDER TO", order.supplier_name || "Supplier",
    [order.contact_person, order.contact_number, order.supplier_email, order.supplier_address]);
  const shopPartyBottom = party(left + half + 24, "DELIVER TO", shopName,
    [shop.address, order.raised_by ? "Raised by " + order.raised_by : null]);
  y = Math.max(supplierBottom, shopPartyBottom) + 20;

  const columns = [
    { title: "NO", width: 28, align: "left" },
    { title: "MATERIAL", width: 0, align: "left" },
    { title: "CATEGORY", width: 78, align: "left" },
    { title: "QUANTITY", width: 92, align: "right" },
    { title: "UNIT PRICE", width: 82, align: "right" },
    { title: "AMOUNT", width: 84, align: "right" }
  ];
  let otherWidths = 0;
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    otherWidths += columns[columnIndex].width;
  }
  columns[1].width = width - otherWidths;
  const pad = 6;

  const heading = function () {
    doc.rect(left, y, width, 22).fill(CHROME);
    let x = left;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      doc.text(column.title, x + pad, y + 7.5,
        { width: column.width - pad * 2, align: column.align, lineBreak: false, characterSpacing: 0.8 });
      x += column.width;
    }
    y += 22;
  };
  heading();

  let units = 0;
  let total = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    units += Number(item.quantity || 0);
    total += Number(item.line_cost || 0);

    const cells = [
      [String(index + 1), null],
      [item.product_name, item.brand_name || null],
      [item.category_name || "--", null],
      [lineQuantity(item), null],
      priceCell(item),
      Number(item.line_cost) > 0 ? [peso(item.line_cost), null] : ["--", null]
    ];

    let height = 0;
    for (let position = 0; position < cells.length; position++) {
      const cell = cells[position];
      const inner = columns[position].width - pad * 2;
      doc.font(position === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
      let cellHeight = doc.heightOfString(pdfText(cell[0]), { width: inner });
      if (cell[1]) {
        doc.font("Helvetica").fontSize(8);
        cellHeight += 2 + doc.heightOfString(pdfText(cell[1]), { width: inner });
      }
      height = Math.max(height, cellHeight);
    }
    height += 16;

    if (y + height > bottom() - 40) {
      doc.addPage();
      y = doc.page.margins.top;
      heading();
    }

    let x = left;
    for (let position = 0; position < cells.length; position++) {
      const cell = cells[position];
      const column = columns[position];
      const inner = column.width - pad * 2;
      doc.font(position === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(INK)
        .text(pdfText(cell[0]), x + pad, y + 8, { width: inner, align: column.align });
      if (cell[1]) {
        doc.font("Helvetica").fontSize(8).fillColor(STEEL)
          .text(pdfText(cell[1]), x + pad, doc.y + 2, { width: inner, align: column.align });
      }
      x += column.width;
    }

    y += height;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
  }

  if (items.length === 0) {
    doc.font("Helvetica").fontSize(9.5).fillColor(STEEL).text("No lines on this order.", left + pad, y + 8);
    y += 28;
  }

  if (y + 40 > bottom()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.6).strokeColor(CHROME).stroke();
  let figures = 0;
  for (let columnIndex = 3; columnIndex < columns.length; columnIndex++) {
    figures += columns[columnIndex].width;
  }
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
    .text(items.length + " " + (items.length === 1 ? "line" : "lines") + (total > 0 ? " · any discount is settled on the invoice" : ""), left + pad, y + 10, { width: width - figures - pad * 2 });
  const labelBottom = doc.y;
  doc.font("Helvetica-Bold").fontSize(10)
    .text(quantityText(units), right - figures + pad, y + 10, { width: columns[3].width - pad * 2, align: "right" });
  doc.font("Helvetica-Bold").fontSize(13)
    .text(total > 0 ? peso(total) : "--", right - columns[5].width - 60, y + 8, { width: columns[5].width + 60 - pad, align: "right" });
  y = Math.max(labelBottom, doc.y) + 18;

  const note = "Please quote " + number + " on the delivery receipt and the invoice. Goods are counted on arrival " +
               "and anything short or damaged is recorded against this order." +
               (shop.invoice_note ? "\n" + shop.invoice_note : "");
  doc.font("Helvetica").fontSize(9.5);
  const noteHeight = doc.heightOfString(pdfText(note), { width: width - 32 }) + 22;
  if (y + noteHeight > bottom()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(left, y, width, noteHeight).fill(SIGNAL_DIM);
  doc.rect(left, y, 4, noteHeight).fill(SIGNAL);
  doc.fillColor(INK).text(pdfText(note), left + 18, y + 11, { width: width - 32 });
  y += noteHeight + 18;

  if (details.link && details.qr) {
    const boxHeight = 112;
    if (y + boxHeight > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(left, y, width, boxHeight).lineWidth(0.8).strokeColor(LINE).stroke();
    doc.image(details.qr, left + 10, y + 10, { width: 92, height: 92 });
    const textX = left + 118;
    const textWidth = width - 130;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(GO)
      .text("CHECK PRICES AND ACCEPT ONLINE", textX, y + 14, { width: textWidth, characterSpacing: 1 });
    doc.font("Helvetica").fontSize(9.5).fillColor(INK)
      .text("Scan the QR code with your phone's camera, or open the link below. Correct any price " +
            "that does not match yours, pick the day it ships, and accept, or tell us you cannot fill it.",
            textX, doc.y + 5, { width: textWidth });
    doc.font("Helvetica").fontSize(8).fillColor(GO)
      .text(pdfText(details.link), textX, doc.y + 6, { width: textWidth, link: details.link, underline: true });
    y += boxHeight;
  }
  y += 40;

  if (y + 50 > bottom()) {
    doc.addPage();
    y = doc.page.margins.top + 30;
  }
  const signWidth = (width - 2 * 24) / 3;
  const signatures = [
    ["Prepared by", order.raised_by || "Inventory Clerk"],
    ["Approved by", order.confirmed_by || "Manager"],
    ["Received by", order.supplier_name || "Supplier"]
  ];
  for (let index = 0; index < signatures.length; index++) {
    const sign = signatures[index];
    const x = left + index * (signWidth + 24);
    doc.moveTo(x, y).lineTo(x + signWidth, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(sign[0], x, y + 6, { width: signWidth });
    doc.font("Helvetica").fontSize(8.5).fillColor(STEEL).text(pdfText(sign[1]), x, doc.y + 1, { width: signWidth });
  }

  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor(STEEL)
      .text(pdfText(shopName + " · " + number + " · page " + (page + 1) + " of " + range.count),
        left, doc.page.height - 30, { width: width, align: "center", lineBreak: false });
    doc.page.margins.bottom = margin;
  }

  doc.end();
  return done;
}

module.exports = { purchaseOrderPdf: purchaseOrderPdf };
