// ============================================================
// spreadsheet.js -- reports as Excel workbooks (.xlsx)
// Loaded by: Connections/manager.js
//
// Every report a manager takes off a screen is written here: one worksheet
// per table, a title and a line saying what it covers, a dark header row that
// stays put while scrolling, and each column as wide as what it holds, so the
// file opens readable rather than squeezed into Excel's default widths.
// Money is stored as a number with two decimals, so it adds up in Excel.
// ============================================================
const ExcelJS = require("exceljs");

const MIN_WIDTH = 8;       // characters
const MAX_WIDTH = 60;      // a long detail wraps instead of running off the screen

// "Receivables / March" -> "Receivables - March": Excel refuses : \ / ? * [ ] in a sheet name
function sheetName(text, used) {
  let name = String(text || "Sheet").replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Sheet";
  let candidate = name;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = " (" + counter + ")";
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// a cell as Excel should hold it: a number when it is one, otherwise the text
function cellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return String(value);
}

// sheets: [{ name, title?, subtitle?, headers: [..], rows: [[..], ..], money?: [column indexes] }]
async function buildWorkbook(sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const used = new Set();

  for (const sheet of sheets) {
    const headers = Array.isArray(sheet.headers) ? sheet.headers.map(String) : [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const money = new Set(Array.isArray(sheet.money) ? sheet.money : []);
    const columnCount = Math.max(headers.length, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)), 1);

    const ws = workbook.addWorksheet(sheetName(sheet.name, used));

    // the title, and what the table covers
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
      headerRow += 1;   // a blank line before the table
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

    // the widest thing in each column decides its width
    const widths = new Array(columnCount).fill(MIN_WIDTH);
    headers.forEach((text, index) => { widths[index] = Math.max(widths[index], text.length + 2); });

    rows.forEach((row, rowIndex) => {
      const cells = Array.isArray(row) ? row : [];
      const added = ws.getRow(headerRow + 1 + rowIndex);
      cells.forEach((value, index) => {
        const cell = added.getCell(index + 1);
        cell.value = cellValue(value);
        if (typeof cell.value === "number" && money.has(index)) cell.numFmt = "#,##0.00";
        const shown = typeof cell.value === "number" && money.has(index)
          ? cell.value.toFixed(2).length + 3
          : String(cell.value).length;
        widths[index] = Math.max(widths[index], Math.min(shown + 2, MAX_WIDTH));
        if (String(cell.value).length > MAX_WIDTH) cell.alignment = { wrapText: true, vertical: "top" };
      });
    });

    widths.forEach((width, index) => { ws.getColumn(index + 1).width = width; });
  }

  return workbook;
}

// sends the workbook as a download
async function sendWorkbook(response, fileName, sheets) {
  const workbook = await buildWorkbook(sheets);
  const safe = String(fileName || "report").replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "report";
  response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.setHeader("Content-Disposition", `attachment; filename="${safe}.xlsx"`);
  await workbook.xlsx.write(response);
  response.end();
}

module.exports = { buildWorkbook, sendWorkbook };
