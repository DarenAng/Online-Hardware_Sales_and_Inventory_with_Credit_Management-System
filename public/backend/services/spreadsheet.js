const ExcelJS = require("exceljs");

const MIN_WIDTH = 8;
const MAX_WIDTH = 60;

function sheetName(text, used) {
  let name = String(text || "Sheet").replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Sheet";
  let candidate = name;
  let counter = 2;
  while (used.indexOf(candidate.toLowerCase()) !== -1) {
    const suffix = " (" + counter + ")";
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    counter += 1;
  }
  used.push(candidate.toLowerCase());
  return candidate;
}

function cellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return String(value);
}

async function buildWorkbook(sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const used = [];

  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const sheet = sheets[sheetIndex];
    const headers = [];
    if (Array.isArray(sheet.headers)) {
      for (let i = 0; i < sheet.headers.length; i++) {
        headers.push(String(sheet.headers[i]));
      }
    }
    let rows = [];
    if (Array.isArray(sheet.rows)) {
      rows = sheet.rows;
    }
    let money = [];
    if (Array.isArray(sheet.money)) {
      money = sheet.money;
    }
    let columnCount = Math.max(headers.length, 1);
    for (let i = 0; i < rows.length; i++) {
      if (Array.isArray(rows[i]) && rows[i].length > columnCount) {
        columnCount = rows[i].length;
      }
    }

    const ws = workbook.addWorksheet(sheetName(sheet.name, used));

    let headerRow = 1;
    if (sheet.title) {
      ws.getCell(1, 1).value = String(sheet.title);
      ws.getCell(1, 1).font = { bold: true, size: 14 };
      headerRow = 2;
      if (sheet.subtitle) {
        ws.getCell(2, 1).value = String(sheet.subtitle);
        ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "FF4D5661" } };
        headerRow = 3;
      }
      headerRow += 1;
    }

    if (headers.length > 0) {
      const head = ws.getRow(headerRow);
      head.values = headers;
      head.font = { bold: true, color: { argb: "FFFFFFFF" } };
      head.alignment = { vertical: "middle" };
      head.height = 20;
      for (let column = 1; column <= headers.length; column += 1) {
        head.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B1F24" } };
      }
      ws.views = [{ state: "frozen", ySplit: headerRow }];
      ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: headers.length } };
    }

    const widths = new Array(columnCount).fill(MIN_WIDTH);
    for (let index = 0; index < headers.length; index++) {
      widths[index] = Math.max(widths[index], headers[index].length + 2);
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      let cells = [];
      if (Array.isArray(rows[rowIndex])) {
        cells = rows[rowIndex];
      }
      const added = ws.getRow(headerRow + 1 + rowIndex);
      for (let index = 0; index < cells.length; index++) {
        const cell = added.getCell(index + 1);
        cell.value = cellValue(cells[index]);
        const isMoneyNumber = typeof cell.value === "number" && money.includes(index);
        if (isMoneyNumber) cell.numFmt = "#,##0.00";
        let shown = String(cell.value).length;
        if (isMoneyNumber) {
          shown = cell.value.toFixed(2).length + 3;
        }
        widths[index] = Math.max(widths[index], Math.min(shown + 2, MAX_WIDTH));
        if (String(cell.value).length > MAX_WIDTH) cell.alignment = { wrapText: true, vertical: "top" };
      }
    }

    for (let index = 0; index < widths.length; index++) {
      ws.getColumn(index + 1).width = widths[index];
    }
  }

  return workbook;
}

async function sendWorkbook(response, fileName, sheets) {
  const workbook = await buildWorkbook(sheets);
  const safe = String(fileName || "report").replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "report";
  response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.setHeader("Content-Disposition", "attachment; filename=\"" + safe + ".xlsx\"");
  await workbook.xlsx.write(response);
  response.end();
}

module.exports = { buildWorkbook: buildWorkbook, sendWorkbook: sendWorkbook };
