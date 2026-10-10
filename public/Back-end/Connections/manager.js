// ============================================================
// manager.js -- Manager module
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// What is in this file:
//   - reports: income, overview, daily tally, and CSV (Excel) exports
//   - the manager's dashboard numbers
//   - credit management: limits, extension requests, the late-payment rate
//     (the cashier reads some of the same routes)
//   - stocks: the reorder point and the selling price
//   - Staff Passwords: reset a staff password when the administrator is away
//   - the daily "late-payment penalty" sweep
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in server.js have already checked the user's role.
// ============================================================

function registerManagerRoutes(app, deps) {
  const {
    db, callProcedure, getActorId, writeAuditLog, fieldChanges, wordStartSearch,
    requireRole, MANAGER, LOW_STOCK_EFFECTIVE_SQL, isDateText, SALE_CUSTOMER_SQL,
    proceduresAreMissing, publishChange,
    CLERK, CASHIER, DRIVER, cleanPhone, phoneComplaint
  } = deps;
  const { sendWorkbook } = require("../spreadsheet");

  // ==========================================
  // MANAGER MODULE
  // ==========================================

  // Date ranges are counted back from today rather than snapped to calendar
  // boundaries: "this month" on the third would read as a collapse.
  const REPORT_RANGES = {
    daily:     { days: 1,   label: "Today" },
    weekly:    { days: 7,   label: "Last 7 days" },
    monthly:   { days: 30,  label: "Last 30 days" },
    quarterly: { days: 90,  label: "Last 90 days" },
    "six-month": { days: 182, label: "Last 6 months" },
    annual:    { days: 365, label: "Last 12 months" },
    all:       { days: null, label: "All time" }
  };

  // The calendar day this machine is having: toISOString() answers in UTC,
  // which disagreed with CURDATE() for the first eight hours of every day.
  function isoDay(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  // { from, to, label, bucket }; a custom pair always wins over a named range.
  // A custom pair that reaches past today is refused (error.status 400): no
  // sale has happened tomorrow, so the figures would only mislead.
  function resolveRange(query) {
    const from = String(query.from || "");
    const to = String(query.to || "");

    if (isDateText(from) && isDateText(to)) {
      // if the dates were typed the wrong way round, swap them
      let start = from;
      let end = to;
      if (from > to) {
        start = to;
        end = from;
      }
      const today = isoDay(new Date());

      if (end > today) {
        const error = new Error(
          `The income breakdown only covers days up to today (${today}); ${end} has not happened yet.`);
        error.status = 400;
        throw error;
      }

      return { from: start, to: end, label: `${start} to ${end}`, bucket: bucketFor(start, end) };
    }

    const name = String(query.range || "monthly").toLowerCase();
    const range = REPORT_RANGES[name] || REPORT_RANGES.monthly;
    const today = new Date();
    const end = isoDay(today);

    if (range.days === null) {
      return { from: "2000-01-01", to: end, label: range.label, bucket: "month" };
    }

    const start = new Date(today);
    start.setDate(start.getDate() - (range.days - 1));

    return {
      from: isoDay(start),
      to: end,
      label: range.label,
      bucket: bucketFor(isoDay(start), end)
    };
  }

  // the bucket follows the span: 365 columns is a smear, 2 is nothing
  function bucketFor(from, to) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (days <= 62) return "day";
    if (days <= 200) return "week";
    return "month";
  }

  const BUCKET_SQL = {
    day: "DATE(s.sale_date)",
    week: "DATE(DATE_SUB(s.sale_date, INTERVAL WEEKDAY(s.sale_date) DAY))",
    month: "DATE_FORMAT(s.sale_date, '%Y-%m-01')"
  };

  // The income breakdown: billed, collected (the headline), outstanding and
  // discounts. One function behind both the screen and the export.
  // The optional cashier filter: a staff id from the query (?cashier=3), or
  // null for every cashier. Anything that is not a whole number above 0 is ignored.
  function cashierFromQuery(query) {
    const id = Number(query.cashier);
    if (Number.isInteger(id) && id > 0) return id;
    return null;
  }

  async function incomeReport(range, cashierId) {
    const bucket = BUCKET_SQL[range.bucket] || BUCKET_SQL.day;
    const window = [`${range.from} 00:00:00`, `${range.to} 23:59:59`];

    // with a cashier chosen, every query below only counts that cashier's sales
    let cashierSql = "";
    if (cashierId !== null) {
      cashierSql = " AND s.cashier_staff_id = ?";
      window.push(cashierId);
    }

    {
      const [totalsRows] = await db.query(
        `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(s.total_amount), 0) AS gross,
              COALESCE(SUM(s.discount), 0) AS discounts,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(GREATEST(s.amount_due - s.amount_paid, 0)), 0) AS outstanding,
              -- the part of outstanding that is late-payment penalty rather than goods
              COALESCE(SUM(GREATEST(s.amount_due - s.amount_paid, 0) - GREATEST(s.final_amount - s.amount_paid, 0)), 0) AS penalties
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}`,
        window
      );

      const totals = totalsRows[0];

      const [unitsRows] = await db.query(
        `SELECT COALESCE(SUM(si.quantity), 0) AS units_sold
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}`,
        window
      );

      const units = unitsRows[0];

      const [series] = await db.query(
        `SELECT ${bucket} AS bucket,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}
       GROUP BY bucket
       ORDER BY bucket`,
        window
      );

      const [methods] = await db.query(
        `SELECT s.payment_method,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(GREATEST(s.amount_due - s.amount_paid, 0)), 0) AS outstanding
       FROM sales s
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}
       GROUP BY s.payment_method
       ORDER BY billed DESC`,
        window
      );

      const [products] = await db.query(
        `SELECT p.product_id, p.product_name, u.unit_name,
              COALESCE(SUM(si.quantity), 0) AS units_sold,
              COALESCE(SUM(si.subtotal), 0) AS revenue
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}
       GROUP BY p.product_id, p.product_name, u.unit_name
       ORDER BY revenue DESC
       LIMIT 10`,
        window
      );

      const [cashiers] = await db.query(
        `SELECT st.staff_id, st.full_name AS staff_name,
              COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.is_archived = FALSE AND s.sale_date BETWEEN ? AND ?${cashierSql}
       GROUP BY st.staff_id, st.full_name
       ORDER BY billed DESC`,
        window
      );

      // everyone who has rung up a sale, for the Cashier dropdown (whatever the period)
      const [cashierChoices] = await db.query(
        `SELECT DISTINCT st.staff_id, st.full_name
       FROM sales s
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.is_archived = FALSE
       ORDER BY st.full_name`
      );

      // the chosen cashier's name, so the screen, print and export can say who it is for
      let cashier = null;
      if (cashierId !== null) {
        cashier = { staff_id: cashierId, name: "Staff #" + cashierId };
        for (const choice of cashierChoices) {
          if (choice.staff_id === cashierId) cashier.name = choice.full_name;
        }
      }

      const saleCount = Number(totals.sale_count) || 0;

      // average bill per sale (0 when there were no sales, to avoid dividing by 0)
      let averageSale = 0;
      if (saleCount > 0) {
        averageSale = Number(totals.billed) / saleCount;
      }

      return {
        range: {
          from: range.from,
          to: range.to,
          label: range.label,
          bucket: range.bucket
        },
        totals: {
          saleCount: saleCount,
          unitsSold: Number(units.units_sold) || 0,
          gross: totals.gross,
          discounts: totals.discounts,
          billed: totals.billed,
          collected: totals.collected,
          outstanding: totals.outstanding,
          penalties: totals.penalties,
          averageSale: averageSale
        },
        series: series,
        methods: methods,
        products: products,
        cashiers: cashiers,
        cashier: cashier,
        cashierChoices: cashierChoices
      };
    }
  }

  app.get("/api/reports/income", async (request, response) => {
    try {
      const report = await incomeReport(resolveRange(request.query), cashierFromQuery(request.query));
      report.range.name = String(request.query.range || "custom");
      response.json(report);
    } catch (error) {
      if (error.status === 400) return response.status(400).json({ error: error.message });

      console.error("Income report failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // A period of one day (Today, or a custom pair with the same date twice) has
  // nothing to break down by day, so the by-day sheet is left out of its file.
  function isSingleDay(range) {
    return range.from === range.to;
  }

  // Exports are Excel workbooks (spreadsheet.js). The access table is what
  // stops a cashier exporting.
  const EXPORTS = {
    "payment-methods": {
      title: "payment-methods",
      headers: ["Method", "Sales", "Billed", "Collected", "Outstanding"],
      rows: function (data) {
        const rows = [];
        for (const m of data.methods) {
          rows.push([m.payment_method, m.sale_count, m.billed, m.collected, m.outstanding]);
        }
        return rows;
      }
    },
    "top-products": {
      title: "top-products",
      headers: ["Product", "Unit", "Units Sold", "Revenue"],
      rows: function (data) {
        const rows = [];
        for (const p of data.products) {
          rows.push([p.product_name, p.unit_name || "", p.units_sold, p.revenue]);
        }
        return rows;
      }
    },
    "staff-sales": {
      title: "staff-sales",
      headers: ["Staff", "Sales", "Billed", "Collected"],
      rows: function (data) {
        const rows = [];
        for (const c of data.cashiers) {
          rows.push([c.staff_name, c.sale_count, c.billed, c.collected]);
        }
        return rows;
      }
    },
    "income-series": {
      title: "income-over-time",
      headers: ["Period", "Sales", "Billed", "Collected"],
      rows: function (data) {
        const rows = [];
        for (const s of data.series) {
          rows.push([String(s.bucket).slice(0, 10), s.sale_count, s.billed, s.collected]);
        }
        return rows;
      }
    },
    "income-summary": {
      title: "income-summary",
      headers: ["Figure", "Value"],
      rows: function (data) {
        return [
        ["Range", data.range.label],
        ["From", data.range.from],
        ["To", data.range.to],
        ["Cashier", data.cashier ? data.cashier.name : "All cashiers"],
        ["Transactions", data.totals.saleCount],
        ["Units sold", data.totals.unitsSold],
        ["Billed", data.totals.billed],
        ["Collected", data.totals.collected],
        ["Outstanding", data.totals.outstanding],
        ["Average sale", data.totals.averageSale]
        ];
      }
    },

    // the whole income screen in one file
    "income-breakdown": {
      title: "income-breakdown",
      headers: [],
      rows: function (data) {
        const rows = [];
        rows.push(["Income breakdown", data.range.label, `${data.range.from} to ${data.range.to}`,
                   data.cashier ? "Cashier: " + data.cashier.name : "All cashiers"]);

        // one section = an empty line, the section name, its headers, then its rows
        function addSection(name, headers, body) {
          rows.push([]);
          rows.push([name]);
          rows.push(headers);
          for (const row of body) {
            rows.push(row);
          }
        }

        // .slice(3) skips the Range/From/To lines, which are already in the first line
        addSection("Summary", ["Figure", "Value"], EXPORTS["income-summary"].rows(data).slice(3));
        if (!isSingleDay(data.range)) {
          addSection("Over time", EXPORTS["income-series"].headers, EXPORTS["income-series"].rows(data));
        }
        addSection("By payment method", EXPORTS["payment-methods"].headers, EXPORTS["payment-methods"].rows(data));
        addSection("Best sellers", EXPORTS["top-products"].headers, EXPORTS["top-products"].rows(data));
        return rows;
      }
    }
  };

  // The income export as a workbook: the whole Sales Summary is a sheet per
  // table; a single table is one sheet. Money columns are kept as numbers.
  const EXPORT_MONEY = {
    "payment-methods": [2, 3, 4],
    "top-products": [3],
    "staff-sales": [2, 3],
    "income-series": [2, 3],
    "income-summary": []
  };

  function exportSheets(name, plan, data, range) {
    let subtitle = `${range.label}, ${range.from} to ${range.to}`;
    if (data.cashier) {
      subtitle += `, Cashier: ${data.cashier.name}`;
    } else {
      subtitle += ", All cashiers";
    }
    if (name !== "income-breakdown") {
      return [{ name: plan.title, title: plan.title.replace(/-/g, " "), subtitle: subtitle,
                headers: plan.headers, rows: plan.rows(data), money: EXPORT_MONEY[name] || [] }];
    }

    const summary = EXPORTS["income-summary"].rows(data).slice(3);
    const sheets = [
      { name: "Summary", title: "Sales Summary", subtitle: subtitle,
        headers: ["Figure", "Value"], rows: summary, money: [] },
      { name: "By Payment Method", title: "By Payment Method", subtitle: subtitle,
        headers: EXPORTS["payment-methods"].headers, rows: EXPORTS["payment-methods"].rows(data),
        money: EXPORT_MONEY["payment-methods"] },
      { name: "Best Sellers", title: "Best Sellers", subtitle: subtitle,
        headers: EXPORTS["top-products"].headers, rows: EXPORTS["top-products"].rows(data),
        money: EXPORT_MONEY["top-products"] }
    ];

    // the by-day sheet goes last, and only when the period has more than one day
    if (!isSingleDay(range)) {
      sheets.push({ name: "By Day", title: "Sales by Day", subtitle: subtitle,
        headers: EXPORTS["income-series"].headers, rows: EXPORTS["income-series"].rows(data),
        money: EXPORT_MONEY["income-series"] });
    }
    return sheets;
  }

  // A table on a report screen, saved as a workbook. The browser sends the
  // rows exactly as it drew them, so the file and the screen cannot disagree;
  // this only lays them out. Sizes are capped so nothing runaway reaches it.
  app.post("/api/reports/spreadsheet", async (request, response) => {
    const body = request.body || {};
    const sheets = Array.isArray(body.sheets) ? body.sheets.slice(0, 10) : [];
    if (sheets.length === 0) {
      return response.status(400).json({ error: "There is no table to save." });
    }

    const cleaned = sheets.map((sheet) => ({
      name: String(sheet.name || "Report").slice(0, 60),
      title: String(sheet.name || "Report").slice(0, 120),
      subtitle: "Saved " + new Date().toLocaleString("en-PH"),
      headers: (Array.isArray(sheet.headers) ? sheet.headers : []).slice(0, 40).map((h) => String(h).slice(0, 80)),
      rows: (Array.isArray(sheet.rows) ? sheet.rows : []).slice(0, 20000).map((row) =>
        (Array.isArray(row) ? row : []).slice(0, 40).map((cell) =>
          typeof cell === "number" ? cell : String(cell === null || cell === undefined ? "" : cell).slice(0, 2000))),
      money: (Array.isArray(sheet.money) ? sheet.money : []).filter((index) => Number.isInteger(index))
    }));

    const title = String(body.title || cleaned[0].name);
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      let total = 0;
      for (const sheet of cleaned) total += sheet.rows.length;
      await writeAuditLog(request, "EXPORT_REPORT", `${title} saved as a spreadsheet (${total} rows)`,
        { report: title, rows: total });
      await sendWorkbook(response, `${title}_${stamp}`, cleaned);
    } catch (error) {
      console.error("Spreadsheet export failed:", error.message);
      if (!response.headersSent) response.status(500).json({ error: "Unable to build the spreadsheet" });
      else response.end();
    }
  });

  // ==========================================
  // SUPPLIERS, CATEGORIES AND UNITS -- the manager's alone to add. The
  // stockroom picks from what is on file; a name it types that is not on file
  // is refused there (inventory-clerk.js).
  // ==========================================
  function tidyName(value, max) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
  }

  app.post("/api/suppliers", async (request, response) => {
    const body = request.body || {};
    const name = tidyName(body.name, 100);
    const email = String(body.email || "").trim().slice(0, 100);
    if (name === "") return response.status(400).json({ error: "The supplier needs a company name." });
    if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response.status(400).json({ error: "That email address does not look right." });
    }
    const phoneProblem = String(body.contactNumber || "").trim() === "" ? null : phoneComplaint(body.contactNumber);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    try {
      const [taken] = await db.query("SELECT supplier_id FROM suppliers WHERE LOWER(supplier_name) = LOWER(?)", [name]);
      if (taken.length > 0) return response.status(409).json({ error: `${name} is already on file.` });

      const [result] = await db.query(
        `INSERT INTO suppliers (supplier_name, contact_person, contact_number, email, address)
         VALUES (?, ?, ?, ?, ?)`,
        [name, tidyName(body.contactPerson, 100) || null, cleanPhone(body.contactNumber) || null,
         email || null, String(body.address || "").trim().slice(0, 255) || null]);
      await writeAuditLog(request, "CREATE_SUPPLIER", `Supplier ${name} added`,
        { supplier_id: result.insertId, name: name });
      response.status(201).json({ message: `${name} was added to the suppliers.`, id: result.insertId });
    } catch (error) {
      console.error("Adding a supplier failed:", error.message);
      response.status(500).json({ error: "Unable to add the supplier" });
    }
  });

  // categories and units are one name each, unique whatever the capitals
  function addNamedRecord(table, column, label, max) {
    return async (request, response) => {
      const name = tidyName((request.body || {}).name, max);
      if (name === "") return response.status(400).json({ error: `The ${label} needs a name.` });

      try {
        const [taken] = await db.query(`SELECT 1 FROM ${table} WHERE LOWER(${column}) = LOWER(?)`, [name]);
        if (taken.length > 0) return response.status(409).json({ error: `${name} is already on file.` });

        const [result] = await db.query(`INSERT INTO ${table} (${column}) VALUES (?)`, [name]);
        await writeAuditLog(request, "CREATE_" + label.toUpperCase(), `${label[0].toUpperCase() + label.slice(1)} ${name} added`,
          { id: result.insertId, name: name });
        response.status(201).json({ message: `${name} was added.`, id: result.insertId });
      } catch (error) {
        console.error(`Adding a ${label} failed:`, error.message);
        response.status(500).json({ error: `Unable to add the ${label}` });
      }
    };
  }

  app.post("/api/categories", addNamedRecord("categories", "category_name", "category", 50));
  app.post("/api/units", addNamedRecord("units", "unit_name", "unit", 20));

  app.get("/api/reports/export", async (request, response) => {
    const name = String(request.query.report || "");
    const plan = EXPORTS[name];

    if (!plan) {
      return response.status(400).json({
        error: `There is no report called "${name}". Try one of: ${Object.keys(EXPORTS).join(", ")}.`
      });
    }

    let range;
    try {
      range = resolveRange(request.query);
    } catch (error) {
      return response.status(error.status || 500).json({ error: error.message });
    }

    try {
      const data = await incomeReport(range, cashierFromQuery(request.query));
      const rows = plan.rows(data);

      let forWhom = "all cashiers";
      if (data.cashier) forWhom = "cashier " + data.cashier.name;

      await writeAuditLog(request, "EXPORT_REPORT",
        `${plan.title} exported for ${range.label}, ${forWhom}`,
        { report: name, from: range.from, to: range.to, cashier_staff_id: data.cashier ? data.cashier.staff_id : null, rows: rows.length });

      await sendWorkbook(response, `${plan.title}_${range.from}_to_${range.to}`, exportSheets(name, plan, data, range));
    } catch (error) {
      console.error("Report export failed:", error.message);
      response.status(500).json({ error: "Unable to build that export" });
    }
  });

  // The daily tally for a cashier or clerk: one day on the screen. A manager
  // sees the whole shop's day. canExport is a convenience, not the control.
  app.get("/api/reports/daily-tally", async (request, response) => {
    let day = null;
    if (isDateText(request.query.date)) {
      day = request.query.date;
    }
    const actor = request.actor;
    const wholeShop = actor.roleName === MANAGER;

    // the manager sees the whole shop; anyone else sees only their own sales
    let scope = "";
    let params = [day];
    if (!wholeShop) {
      scope = "AND s.cashier_staff_id = ?";
      params = [day, actor.staffId];
    }

    try {
      const [totalsRows] = await db.query(
        `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(s.discount), 0) AS discounts,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected,
              COALESCE(SUM(s.change_given), 0) AS change_given,
              COALESCE(SUM(CASE WHEN s.payment_method = 'Cash'
                                THEN s.amount_paid - s.change_given ELSE 0 END), 0) AS cash_drawer
       FROM sales s
       WHERE s.is_archived = FALSE AND DATE(s.sale_date) = COALESCE(?, CURDATE()) ${scope}`,
        params
      );

      const totals = totalsRows[0];

      const [methods] = await db.query(
        `SELECT s.payment_method, COUNT(*) AS sale_count,
              COALESCE(SUM(s.final_amount), 0) AS billed,
              COALESCE(SUM(LEAST(s.amount_paid, s.final_amount)), 0) AS collected
       FROM sales s
       WHERE s.is_archived = FALSE AND DATE(s.sale_date) = COALESCE(?, CURDATE()) ${scope}
       GROUP BY s.payment_method
       ORDER BY billed DESC`,
        params
      );

      let scopeName = "Your own sales";
      if (wholeShop) {
        scopeName = "Whole shop";
      }

      response.json({
        date: day,
        scope: scopeName,
        canExport: wholeShop,
        totals: totals,
        methods: methods
      });
    } catch (error) {
      console.error("Daily tally failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Dashboard headline numbers. Gross sales is what was billed and total income
  // what was collected; the difference is the outstanding balance.
  app.get("/api/manager/summary", async (request, response) => {
    try {
      const [salesRows] = await db.query(
        `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS gross_sales
       FROM sales WHERE is_archived = FALSE`
      );
      const sales = salesRows[0];
      // the tile opens Reorder Alerts, so it counts what that screen lists
      const [stockRows] = await db.query(
        `SELECT COUNT(*) AS product_count FROM products p WHERE p.is_archived = FALSE`
      );
      const stock = stockRows[0];
      const [lowStockRows] = await db.query(LOW_STOCK_EFFECTIVE_SQL,
        [SALES_WINDOW_DAYS, SALES_WINDOW_DAYS, SALES_WINDOW_DAYS]);
      const lowStock = lowStockRows[0];
      stock.low_stock = lowStock.n;
      const [deliveryRows] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('Pending','In Transit','Out for Delivery') THEN 1 ELSE 0 END), 0) AS in_progress,
              COALESCE(SUM(CASE WHEN status IN ('Delayed','Failed') THEN 1 ELSE 0 END), 0) AS problem
       FROM deliveries WHERE is_archived = FALSE`
      );

      const delivery = deliveryRows[0];

      const [incomeRows] = await db.query(
        `SELECT COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected,
              COALESCE(SUM(CASE WHEN DATE(sale_date) = CURDATE()
                                THEN LEAST(amount_paid, final_amount) ELSE 0 END), 0) AS collected_today
       FROM sales WHERE is_archived = FALSE`
      );

      const income = incomeRows[0];

      // owed is the goods and the late penalties together; penalties is the
      // penalty part alone, so billed - collected + penalties = owed
      const [creditsRows] = await db.query(
        `SELECT COUNT(*) AS open_accounts,
              COALESCE(SUM(GREATEST(amount_due - amount_paid, 0)), 0) AS owed,
              COALESCE(SUM(GREATEST(amount_due - amount_paid, 0) - GREATEST(final_amount - amount_paid, 0)), 0) AS penalties
       FROM sales
       WHERE is_archived = FALSE AND payment_status <> 'Paid'`
      );

      const credits = creditsRows[0];

      response.json({
        saleCount: sales.sale_count,
        grossSales: sales.gross_sales,
        totalIncome: income.collected,
        incomeToday: income.collected_today,
        pendingCredits: credits.owed,
        pendingPenalties: credits.penalties,
        pendingCreditCount: credits.open_accounts,
        productCount: stock.product_count,
        reorderAlerts: stock.low_stock,
        deliveriesInProgress: delivery.in_progress,
        deliveryProblems: delivery.problem
      });
    } catch (error) {
      console.error("Manager summary failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // REPORTS: payment method mix, receivables, loyal customers
  // Everything staff have filed, newest first, with who filed it: sales rung
  // up, credit payments taken, damage, refund and return reports, stock
  // adjustments, deliveries, purchase orders raised and the manager's decisions
  // on them, credit requests and their decisions, and credit limits set. Each
  // comes from its own table, so the report is complete on a database that
  // was seeded rather than lived in, and it reads the same rows the other
  // screens do.
  // a quantity without trailing zeros: 2.500 reads 2.5, 40.000 reads 40. The
  // CHARACTER SET keeps the text in the tables' own collation: a bare CAST
  // takes the connection's, and the UNION below refuses to mix the two.
  const qty = (column) =>
    `IF(${column} = FLOOR(${column}), CAST(FLOOR(${column}) AS CHAR CHARACTER SET utf8mb4), ` +
    `TRIM(TRAILING '0' FROM CAST(${column} AS CHAR CHARACTER SET utf8mb4)))`;
  const ACTIVITY_SQL = `
    SELECT a.kind, a.happened_at, a.ref, a.details,
           COALESCE(st.full_name, 'Not recorded') AS staff_name,
           COALESCE(r.role_name, '') AS role_name
    FROM (
      SELECT 'SALE' AS kind, s.sale_date AS happened_at, s.cashier_staff_id AS staff_id, s.sale_id AS ref,
             CONCAT('Sale #', s.sale_id, ' for ',
                    COALESCE(CONCAT(c.first_name, ' ', c.last_name), NULLIF(s.walk_in_name, ''), 'a walk-in customer'),
                    ': ', FORMAT(s.final_amount, 2), ' by ', s.payment_method, ', ', s.payment_status,
                    IF(s.is_archived, ' (voided)', '')) AS details
      FROM sales s LEFT JOIN customers c ON c.customer_id = s.customer_id
      UNION ALL
      SELECT 'PAYMENT', p.payment_date, p.received_by_staff_id, p.sale_id,
             CONCAT(COALESCE(CONCAT(c.first_name, ' ', c.last_name), 'Customer'), ' paid ', FORMAT(p.amount, 2),
                    ' on sale #', p.sale_id, ' by ', p.payment_method)
      FROM credit_payments p LEFT JOIN customers c ON c.customer_id = p.customer_id
      UNION ALL
      SELECT CASE ri.report_type WHEN 'Damaged' THEN 'DAMAGE' WHEN 'Refunded' THEN 'REFUND' ELSE 'RETURN' END,
             ri.return_date, ri.reported_by_staff_id, ri.return_id,
             CONCAT(pr.product_name, ' x', ${qty("ri.quantity")},
                    IF(ri.sale_id IS NULL, '', CONCAT(' from sale #', ri.sale_id)),
                    IF(ri.reason IS NULL OR ri.reason = '', '', CONCAT(': ', ri.reason)),
                    ' (', ri.status, ')')
      FROM returned_items ri JOIN products pr ON pr.product_id = ri.product_id
      UNION ALL
      SELECT 'STOCK_ADJUST', sa.created_at, sa.adjusted_by_staff_id, sa.adjustment_id,
             CONCAT(pr.product_name, ': ', sa.adjustment_type, ' ', ${qty("sa.quantity_before")}, ' to ',
                    ${qty("sa.quantity_after")},
                    IF(sa.unit_name IS NULL OR sa.unit_name = '', '', CONCAT(' ', sa.unit_name)),
                    IF(sa.reason IS NULL OR sa.reason = '', '', CONCAT(' - ', sa.reason)))
      FROM stock_adjustments sa JOIN products pr ON pr.product_id = sa.product_id
      UNION ALL
      SELECT 'DELIVERY', COALESCE(d.booked_date, d.scheduled_date, d.updated_at), d.delivery_staff_id, d.delivery_id,
             CONCAT('Sale #', d.sale_id, ' to ',
                    COALESCE(NULLIF(d.contact_name, ''), CONCAT(c.first_name, ' ', c.last_name),
                             NULLIF(s.walk_in_name, ''), 'the customer'),
                    ': ', d.status,
                    IF(d.delivered_at IS NULL, '', CONCAT(', delivered ', DATE_FORMAT(d.delivered_at, '%e %b'))))
      FROM deliveries d
      LEFT JOIN sales s ON s.sale_id = d.sale_id
      LEFT JOIN customers c ON c.customer_id = s.customer_id
      UNION ALL
      SELECT 'PURCHASE_ORDER', po.order_date, po.raised_by_staff_id, po.po_id,
             CONCAT('PO #', po.po_id, ' to ', sup.supplier_name, ': ',
                    (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.po_id), ' line(s) (', po.status, ')')
      FROM purchase_orders po JOIN suppliers sup ON sup.supplier_id = po.supplier_id
      UNION ALL
      SELECT IF(po.status = 'Cancelled', 'PO_DECLINED', 'PO_CONFIRMED'), po.confirmed_at, po.confirmed_by_staff_id, po.po_id,
             CONCAT('PO #', po.po_id, ' to ', sup.supplier_name,
                    IF(po.status = 'Cancelled', ' declined', ' confirmed'),
                    IF(po.decision_note IS NULL OR po.decision_note = '', '', CONCAT(' - ', po.decision_note)))
      FROM purchase_orders po JOIN suppliers sup ON sup.supplier_id = po.supplier_id
      WHERE po.confirmed_at IS NOT NULL
      UNION ALL
      SELECT 'CREDIT_REQUEST', cr.created_at, cr.requested_by_staff_id, cr.request_id,
             CONCAT(c.first_name, ' ', c.last_name, ': ', FORMAT(cr.previous_limit, 2), ' to ',
                    FORMAT(cr.requested_limit, 2),
                    IF(cr.reason IS NULL OR cr.reason = '', '', CONCAT(' - ', cr.reason)), ' (', cr.status, ')')
      FROM credit_requests cr JOIN customers c ON c.customer_id = cr.customer_id
      UNION ALL
      SELECT IF(cr.status = 'Approved', 'CREDIT_APPROVED', 'CREDIT_DECLINED'), cr.decided_at,
             cr.decided_by_staff_id, cr.request_id,
             CONCAT(c.first_name, ' ', c.last_name, ': request #', cr.request_id, ' ',
                    IF(cr.status = 'Approved', CONCAT('approved at ', FORMAT(cr.requested_limit, 2)), 'declined'),
                    IF(cr.decision_note IS NULL OR cr.decision_note = '', '', CONCAT(' - ', cr.decision_note)))
      FROM credit_requests cr JOIN customers c ON c.customer_id = cr.customer_id
      WHERE cr.decided_at IS NOT NULL
      UNION ALL
      SELECT 'CREDIT_LIMIT', cc.updated_at, cc.updated_by_staff_id, cc.customer_id,
             CONCAT(c.first_name, ' ', c.last_name, ': limit ', FORMAT(cc.credit_limit, 2), ', ', cc.standing)
      FROM customer_credits cc JOIN customers c ON c.customer_id = cc.customer_id
    ) a
    LEFT JOIN staff st ON st.staff_id = a.staff_id
    LEFT JOIN roles r ON r.role_id = st.role_id
    ORDER BY a.happened_at DESC
    LIMIT ?`;

  app.get("/api/reports/activity", async (request, response) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 500, 1), 2000);
    try {
      const [rows] = await db.query(ACTIVITY_SQL, [limit]);
      response.json(rows);
    } catch (error) {
      console.error("Activity report failed:", error.message);
      response.status(500).json({ error: "Unable to load the activity report" });
    }
  });

  app.get("/api/reports/overview", async (request, response) => {
    try {
      const [methods] = await db.query(
        `SELECT payment_method,
              COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS total_amount,
              COALESCE(SUM(CASE WHEN payment_status = 'Paid' THEN final_amount ELSE 0 END), 0) AS paid_amount,
              COALESCE(SUM(CASE WHEN payment_status <> 'Paid' THEN amount_due - amount_paid ELSE 0 END), 0) AS balance_due
       FROM sales WHERE is_archived = FALSE
       GROUP BY payment_method
       ORDER BY total_amount DESC`
      );

      const [unpaid] = await db.query(
        `SELECT s.sale_id, s.payment_method, s.payment_status, s.sale_date,
              s.final_amount, s.amount_paid,
              (s.amount_due - s.amount_paid) AS balance_due,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              st.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.is_archived = FALSE AND s.payment_status <> 'Paid'
       ORDER BY s.sale_date DESC`
      );

      const [loyal] = await db.query(
        `SELECT c.customer_id,
              TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
              c.phone,
              COUNT(s.sale_id) AS purchase_count,
              COALESCE(SUM(s.final_amount), 0) AS total_spent,
              COALESCE(SUM(CASE WHEN s.payment_status <> 'Paid' THEN s.amount_due - s.amount_paid ELSE 0 END), 0) AS balance_due,
              MAX(s.sale_date) AS last_purchase
       FROM customers c
       JOIN sales s ON s.customer_id = c.customer_id AND s.is_archived = FALSE
       GROUP BY c.customer_id, c.first_name, c.last_name, c.phone
       HAVING COUNT(s.sale_id) >= 2
       ORDER BY purchase_count DESC, total_spent DESC`
      );

      response.json({ methods, unpaid, loyal });
    } catch (error) {
      console.error("Reports overview failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // CREDIT MANAGEMENT
  //
  // Every balance is derived in vw_customer_credit from the sales themselves;
  // nothing about a balance is stored, so nothing can go stale.
  // ==========================================

  app.get("/api/credit/customers", async (request, response) => {
    const standing = String(request.query.standing || "all");
    const search = String(request.query.search || "").trim();

    const where = [];
    const params = [];

    if (["Good", "Watch", "Hold"].includes(standing)) {
      where.push("v.standing = ?");
      params.push(standing);
    }

    if (request.query.owing === "true") where.push("v.current_credit > 0");

    if (request.query.overLimit === "true") where.push("v.current_credit > v.credit_limit");

    if (search !== "") {
      where.push(wordStartSearch(["v.customer_name", "v.phone"], search, params));
    }

    let filter = "";
    if (where.length > 0) {
      filter = ` WHERE ${where.join(" AND ")}`;
    }

    try {
      const [rows] = await db.query(
        `SELECT v.*,
              (SELECT COUNT(*) FROM credit_requests r
               WHERE r.customer_id = v.customer_id AND r.status = 'Pending') AS pending_requests
       FROM vw_customer_credit v
       ${filter}
       ORDER BY v.current_credit DESC, v.customer_name`,
        params
      );
      response.json(rows);
    } catch (error) {
      console.error("Credit list failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Every sale still carrying a balance, oldest first: the counter's list of
  // what can be paid off. The due date is the sale plus the thirty-day term
  // that vw_customer_credit ages an account by; a Credit sale past it carries
  // the late penalty, and the balance is measured against the bill with the
  // penalty on it (amount_due).
  app.get("/api/credit/open-sales", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT s.sale_id, s.sale_date, s.customer_id,
              CONCAT(c.first_name, ' ', c.last_name) AS customer_name, c.phone,
              s.payment_method, s.payment_status, s.final_amount, s.amount_paid,
              s.penalty_rate, s.penalty_months, s.penalty_amount, s.penalty_applied_at, s.amount_due,
              GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,
              DATEDIFF(CURDATE(), DATE(s.sale_date)) AS days_old,
              DATE_ADD(DATE(s.sale_date), INTERVAL 30 DAY) AS due_date,
              cc.standing,
              (SELECT COUNT(*) FROM credit_payments cp WHERE cp.sale_id = s.sale_id) AS payment_count,
              (SELECT MAX(cp.payment_date) FROM credit_payments cp WHERE cp.sale_id = s.sale_id) AS last_payment
       FROM sales s
       JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN vw_customer_credit cc ON cc.customer_id = s.customer_id
       WHERE s.is_archived = FALSE
         AND s.customer_id IS NOT NULL
         AND s.amount_due - s.amount_paid > 0
       ORDER BY s.sale_date ASC`);
      response.json(rows);
    } catch (error) {
      console.error("Open sales failed:", error.message);
      response.status(500).json({ error: "Unable to read the balances due" });
    }
  });

  app.get("/api/credit/customers/:customerId", async (request, response) => {
    try {
      const [rows] = await db.query(
        "SELECT * FROM vw_customer_credit WHERE customer_id = ?",
        [request.params.customerId]
      );

      if (rows.length === 0) {
        return response.status(404).json({ error: "That customer was not found." });
      }

      const [requests] = await db.query(
        `SELECT r.*, rb.full_name AS requested_by, db.full_name AS decided_by
       FROM credit_requests r
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       WHERE r.customer_id = ?
       ORDER BY r.request_id DESC
       LIMIT 20`,
        [request.params.customerId]
      );

      response.json({ credit: rows[0], requests });
    } catch (error) {
      console.error("Credit read failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // penaltyRate: blank or null means the shop's late-payment rate applies to
  // this account; a number, 1 to 3 percent a month, is the manager's rate for
  // this account alone
  app.put("/api/credit/customers/:customerId/limit", requireRole(MANAGER), async (request, response) => {
    const { creditLimit, standing, notes, penaltyRate } = request.body;

    const limit = Number(creditLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      return response.status(400).json({
        error: "A credit limit cannot be negative. Use zero for a cash-only customer."
      });
    }

    let ownRate;
    if (penaltyRate === undefined || penaltyRate === null || String(penaltyRate).trim() === "") {
      ownRate = null;
    } else {
      ownRate = Number(penaltyRate);
    }

    if (ownRate !== null && (!Number.isFinite(ownRate) || ownRate < 1 || ownRate > 3)) {
      return response.status(400).json({
        error: "A late-payment rate is 1 to 3 percent a month. Leave it blank for the shop's rate."
      });
    }

    try {
      const [before] = await db.query(
        `SELECT customer_name, credit_limit, manual_standing AS standing, penalty_rate_override
         FROM vw_customer_credit WHERE customer_id = ?`,
        [request.params.customerId]
      );

      const output = await callProcedure(
        "CALL sp_set_credit_limit(?, ?, ?, ?, ?, ?, @status_code, @message)",
        [request.params.customerId, limit, standing || "Good", ownRate,
         notes || null, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // the values before the change (for the audit trail)
      let customerName = "Customer";
      let oldValues = null;
      if (before[0]) {
        customerName = before[0].customer_name;
        oldValues = {
          credit_limit: before[0].credit_limit,
          standing: before[0].standing,
          penalty_rate: before[0].penalty_rate_override
        };
      }

      let details = `${customerName} set to ${limit} (${standing || "Good"})`;
      if (ownRate !== null) {
        details += `, late-payment rate ${ownRate}%`;
      }

      await writeAuditLog(
        request,
        "UPDATE_CREDIT_LIMIT",
        details,
        {
          customer_id: Number(request.params.customerId),
          changes: fieldChanges(
            oldValues,
            { credit_limit: limit, standing: standing || "Good", penalty_rate: ownRate })
        }
      );

      response.json({ message: output.message });
    } catch (error) {
      console.error("Credit limit failed:", error.message);
      response.status(500).json({ error: "Unable to save the credit limit" });
    }
  });

  // ==========================================
  // THE LATE-PAYMENT POLICY
  //
  // 1 to 3 percent a month of the goods still unpaid, for every month (or
  // part of one) a credit sale is past its 30-day due date; the default is
  // 3. The manager may set another rate for the shop here, or for one
  // account on its credit terms. The charge itself is made by
  // sp_apply_late_penalties, run at startup and every hour.
  // ==========================================
  app.get("/api/credit/policy", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT cfg.penalty_rate, cfg.updated_at, st.full_name AS updated_by,
              (SELECT COUNT(*) FROM customer_credits WHERE penalty_rate IS NOT NULL) AS own_rate_accounts,
              (SELECT COUNT(*) FROM sales s
               WHERE s.is_archived = FALSE AND s.payment_status <> 'Paid' AND s.penalty_amount > 0) AS penalised_sales,
              (SELECT COALESCE(SUM(s.penalty_amount), 0) FROM sales s
               WHERE s.is_archived = FALSE AND s.payment_status <> 'Paid') AS penalties_owed
         FROM store_settings cfg
         LEFT JOIN staff st ON st.staff_id = cfg.updated_by_staff_id
         WHERE cfg.setting_id = 1`
      );
      response.json(rows[0] || { penalty_rate: "3.00", updated_at: null, updated_by: null,
                                 own_rate_accounts: 0, penalised_sales: 0, penalties_owed: 0 });
    } catch (error) {
      console.error("Penalty policy read failed:", error.message);
      response.status(500).json({ error: "Unable to read the late-payment policy" });
    }
  });

  app.put("/api/credit/policy", requireRole(MANAGER), async (request, response) => {
    const rate = Number((request.body || {}).penaltyRate);
    if (!Number.isFinite(rate) || rate < 1 || rate > 3) {
      return response.status(400).json({
        error: "The late-payment rate is 1 to 3 percent a month. The default is 3."
      });
    }

    try {
      const [before] = await db.query("SELECT penalty_rate FROM store_settings WHERE setting_id = 1");

      const output = await callProcedure(
        "CALL sp_set_penalty_policy(?, ?, @status_code, @message)",
        [rate, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      let oldValues = null;
      if (before[0]) {
        oldValues = { penalty_rate: before[0].penalty_rate };
      }

      await writeAuditLog(request, "UPDATE_PENALTY_POLICY",
        `Late-payment penalty set to ${rate}% a month of the unpaid balance`,
        { changes: fieldChanges(oldValues, { penalty_rate: rate }) });

      response.json({ message: output.message, penalty_rate: rate.toFixed(2) });
    } catch (error) {
      console.error("Penalty policy failed:", error.message);
      response.status(500).json({ error: "Unable to save the late-payment policy" });
    }
  });

  app.get("/api/credit/requests", async (request, response) => {
    const status = String(request.query.status || "all");

    const where = [];
    const params = [];

    if (["Pending", "Approved", "Declined"].includes(status)) {
      where.push("r.status = ?");
      params.push(status);
    }

    let whereText = "";
    if (where.length > 0) {
      whereText = "WHERE " + where.join(" AND ");
    }

    try {
      const [rows] = await db.query(
        `SELECT r.*,
              TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
              c.phone,
              rb.full_name AS requested_by,
              db.full_name AS decided_by,
              v.current_credit, v.standing
       FROM credit_requests r
       JOIN customers c ON c.customer_id = r.customer_id
       LEFT JOIN vw_customer_credit v ON v.customer_id = r.customer_id
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       ${whereText}
       ORDER BY FIELD(r.status, 'Pending', 'Approved', 'Declined'), r.request_id DESC
       LIMIT 200`,
        params
      );
      response.json(rows);
    } catch (error) {
      console.error("Credit requests failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/credit/requests", async (request, response) => {
    const { customerId, requestedLimit, reason } = request.body;

    const limit = Number(requestedLimit);
    if (!customerId || !Number.isFinite(limit) || limit <= 0) {
      return response.status(400).json({ error: "A customer and a requested limit are required" });
    }

    // A manager reading the request later does not have the customer in front
    // of them, so it always says why: not blank, and more than a word.
    const MINIMUM_REQUEST_REASON = 5;
    const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
    if (why.length < MINIMUM_REQUEST_REASON) {
      return response.status(400).json({
        error: "Say why the limit should go up, so the manager deciding it can see the reason " +
               `(at least ${MINIMUM_REQUEST_REASON} characters).`
      });
    }
    if (why.length > 255) {
      return response.status(400).json({ error: "The reason is at most 255 characters." });
    }

    try {
      const output = await callProcedure(
        "CALL sp_request_credit_extension(?, ?, ?, ?, @request_id, @status_code, @message)",
        [customerId, limit, why, getActorId(request)],
        ["request_id", "status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      await writeAuditLog(request, "CREDIT_REQUEST",
        `Extension to ${limit} asked for on customer #${customerId}`,
        { customer_id: Number(customerId), requested_limit: limit, reason: why });

      response.json({ message: output.message, requestId: output.request_id });
    } catch (error) {
      console.error("Credit request failed:", error.message);
      response.status(500).json({ error: "Unable to raise the request" });
    }
  });

  app.post("/api/credit/requests/:requestId/decide", requireRole(MANAGER), async (request, response) => {
    const approve = request.body.approve === true;
    const note = request.body.note;

    // declining says why or it does not happen
    if (!approve && (typeof note !== "string" || note.trim() === "")) {
      return response.status(400).json({
        error: "Say why the request was declined, so whoever asked knows what to tell the customer."
      });
    }

    try {
      const output = await callProcedure(
        "CALL sp_decide_credit_request(?, ?, ?, ?, @status_code, @message)",
        [request.params.requestId, approve, note || null, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      let action = "CREDIT_DECLINED";
      let word = "declined";
      if (approve) {
        action = "CREDIT_APPROVED";
        word = "approved";
      }
      await writeAuditLog(
        request,
        action,
        `Request #${request.params.requestId} ${word}`,
        { request_id: Number(request.params.requestId), approved: approve, note: note || null }
      );

      response.json({ message: output.message });
    } catch (error) {
      console.error("Credit decision failed:", error.message);
      response.status(500).json({ error: "Unable to record the decision" });
    }
  });

  // One customer in full: what they bought beside what they have paid.
  app.get("/api/customers/:customerId/history", async (request, response) => {
    const customerId = request.params.customerId;

    try {
      const [credit] = await db.query(
        "SELECT * FROM vw_customer_credit WHERE customer_id = ?", [customerId]);

      if (credit.length === 0) {
        return response.status(404).json({ error: "That customer was not found." });
      }

      const [purchases] = await db.query(
        `SELECT s.sale_id, s.sale_date, s.total_amount, s.discount, s.final_amount,
              s.amount_paid, s.payment_method, s.payment_status, s.reference_no,
              s.is_archived, s.penalty_rate, s.penalty_months, s.penalty_amount, s.penalty_applied_at, s.amount_due,
              GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,
              st.full_name AS cashier_name,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count,
              d.delivery_id, d.status AS delivery_status
       FROM sales s
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE s.customer_id = ?
       ORDER BY s.sale_date DESC`,
        [customerId]
      );

      const [payments] = await db.query(
        `SELECT p.payment_id, p.sale_id, p.amount, p.payment_method,
              p.reference_no, p.payment_date,
              COALESCE(st.full_name, 'Unknown') AS received_by
       FROM credit_payments p
       LEFT JOIN staff st ON st.staff_id = p.received_by_staff_id
       WHERE p.customer_id = ?
       ORDER BY p.payment_date DESC`,
        [customerId]
      );

      const [requests] = await db.query(
        `SELECT r.*, rb.full_name AS requested_by, db.full_name AS decided_by
       FROM credit_requests r
       LEFT JOIN staff rb ON rb.staff_id = r.requested_by_staff_id
       LEFT JOIN staff db ON db.staff_id = r.decided_by_staff_id
       WHERE r.customer_id = ?
       ORDER BY r.request_id DESC`,
        [customerId]
      );

      const [products] = await db.query(
        `SELECT p.product_name, u.unit_name,
              SUM(si.quantity) AS units, SUM(si.subtotal) AS spent,
              MAX(s.sale_date) AS last_bought
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE s.customer_id = ? AND s.is_archived = FALSE
       GROUP BY p.product_id, p.product_name, u.unit_name
       ORDER BY spent DESC
       LIMIT 10`,
        [customerId]
      );

      response.json({ credit: credit[0], purchases, payments, requests, products });
    } catch (error) {
      console.error("Customer history failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Open an account from Customers Record (the Add Customer form). The
  // procedure sets the limit to zero and the standing to Good; moving the limit
  // is manager-only. A name already on the books (any case, extra spaces
  // ignored) is refused with 409 -- the till no longer opens accounts by
  // typing a name, so this is the one place an account starts.
  app.post("/api/customers", async (request, response) => {
    const { firstName, lastName, phone, address } = request.body;

    if (!firstName || String(firstName).trim() === "") {
      return response.status(400).json({ error: "A customer needs a name" });
    }
    if (!address || String(address).trim() === "") {
      return response.status(400).json({ error: "A customer needs an address" });
    }

    const first = String(firstName).trim().replace(/\s+/g, " ").slice(0, 100);
    const last = String(lastName || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const fullName = (first + " " + last).trim();

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) {
      return response.status(400).json({ error: phoneProblem });
    }
    const phoneText = cleanPhone(phone) || "";

    try {
      const [same] = await db.query(
        `SELECT customer_id FROM customers
         WHERE LOWER(TRIM(CONCAT(first_name, ' ', last_name))) = LOWER(?)
         LIMIT 1`, [fullName]);
      if (same.length > 0) {
        return response.status(409).json({
          error: `${fullName} is already on the books. Find them in Customers Record instead of adding them again.`,
          customerId: same[0].customer_id
        });
      }

      const output = await callProcedure(
        "CALL sp_create_customer(?, ?, ?, ?, ?, @customer_id, @status_code, @message)",
        [first, last, phoneText, String(address || "").trim().slice(0, 500), getActorId(request)],
        ["customer_id", "status_code", "message"]
      );

      // 201: a new account. 200 would mean the procedure found the same name and
      // phone and handed that account back, which the check above has already refused
      if (output.status_code !== 201 && output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      const created = output.status_code === 201;
      if (created) {
        await writeAuditLog(request, "CREATE_CUSTOMER", `Customer ${fullName} added`,
          { customer_id: Number(output.customer_id), name: fullName,
            phone: phoneText || null, address: String(address || "").trim() || null });
      }

      response.status(output.status_code).json({
        message: created ? `${fullName} was added to Customers Record.` : output.message,
        customerId: output.customer_id,
        created: created
      });
    } catch (error) {
      console.error("Create customer failed:", error.message);
      response.status(500).json({ error: "Unable to create the customer" });
    }
  });

  // ==========================================
  // STOCKS, AND THE REORDER POINT THE SYSTEM WORKS OUT FOR ITSELF
  //
  //     ROP = (average daily sales x lead time) + safety stock
  //
  // Average daily sales is over a window of real trading (90 days), divided by
  // the days the shop has actually recorded sales. The effective reorder point
  // is the calculated one only when the product is set to Dynamic; otherwise
  // the typed figure, with the calculated one shown beside it.
  // ==========================================
  const SALES_WINDOW_DAYS = 90;

  app.get("/api/stocks", async (request, response) => {
    try {
      const [rows] = await db.query(
        `WITH window_days AS (
         SELECT GREATEST(
                  LEAST(?, COALESCE(DATEDIFF(CURDATE(), DATE(MIN(sale_date))) + 1, ?)),
                  1) AS days
         FROM sales
         WHERE is_archived = FALSE
       ),
       recent AS (
         SELECT si.product_id, COALESCE(SUM(si.quantity), 0) AS units
         FROM sale_items si
         JOIN sales s ON s.sale_id = si.sale_id
         WHERE s.is_archived = FALSE
           AND s.sale_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY si.product_id
       )
       SELECT p.product_id, p.product_name, p.price, p.reorder_point, p.status,
              p.lead_time_days, p.safety_stock, p.reorder_mode,
              COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock,
              i.last_updated,
              c.category_name, b.brand_name, u.unit_name,
              sup.supplier_name, sup.contact_person, sup.contact_number,
              (COALESCE(i.quantity_in_stock, 0) * p.price) AS stock_value,

              w.days AS window_days,
              COALESCE(rc.units, 0) AS units_sold_window,
              ROUND(COALESCE(rc.units, 0) / w.days, 3) AS avg_daily_sales,

              -- the formula, rounded up: half a bag of cement short is short
              CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                AS calculated_rop,

              CASE WHEN p.reorder_mode = 'Dynamic'
                   THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                   ELSE p.reorder_point
              END AS effective_rop,

              CASE
                WHEN COALESCE(i.quantity_in_stock, 0) = 0 THEN 'Out of Stock'
                WHEN COALESCE(i.quantity_in_stock, 0) <=
                     CASE WHEN p.reorder_mode = 'Dynamic'
                          THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                          ELSE p.reorder_point END
                THEN 'Low Stock'
                ELSE 'In Stock'
              END AS stock_status,

              -- order back up to twice the reorder point, so the next order is
              -- not due the week after this one arrives
              GREATEST(
                (CASE WHEN p.reorder_mode = 'Dynamic'
                      THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                      ELSE p.reorder_point END) * 2
                - COALESCE(i.quantity_in_stock, 0), 0) AS suggested_order,

              -- roughly how long what is on the shelf will last at the
              -- current rate. NULL when nothing is moving, because "forever"
              -- is not a number worth printing.
              CASE WHEN COALESCE(rc.units, 0) = 0 THEN NULL
                   ELSE ROUND(COALESCE(i.quantity_in_stock, 0) / (rc.units / w.days), 1)
              END AS days_of_cover

       FROM products p
       CROSS JOIN window_days w
       LEFT JOIN recent rc ON rc.product_id = p.product_id
       LEFT JOIN inventory i ON i.product_id = p.product_id
       LEFT JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN brands b ON b.brand_id = p.brand_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
       WHERE p.is_archived = FALSE
       ORDER BY (COALESCE(i.quantity_in_stock, 0) <=
                 CASE WHEN p.reorder_mode = 'Dynamic'
                      THEN CEIL((COALESCE(rc.units, 0) / w.days) * p.lead_time_days) + p.safety_stock
                      ELSE p.reorder_point END) DESC,
                p.product_name`,
        [SALES_WINDOW_DAYS, SALES_WINDOW_DAYS, SALES_WINDOW_DAYS]
      );
      response.json(rows);
    } catch (error) {
      console.error("Stocks failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // the manager sets the policy; the clerk sets a manual reorder point
  app.put("/api/stocks/:productId/reorder-policy", async (request, response) => {
    const { leadTimeDays, safetyStock, reorderMode, reorderPoint } = request.body;

    const lead = parseInt(leadTimeDays, 10);
    const safety = parseInt(safetyStock, 10);
    const mode = String(reorderMode || "Manual");

    if (!Number.isInteger(lead) || lead < 1 || lead > 365) {
      return response.status(400).json({ error: "Lead time must be between 1 and 365 days" });
    }
    if (!Number.isInteger(safety) || safety < 0 || safety > 1000000) {
      return response.status(400).json({ error: "Safety stock cannot be negative" });
    }
    if (mode !== "Manual" && mode !== "Dynamic") {
      return response.status(400).json({ error: "Reorder mode must be Manual or Dynamic" });
    }

    // a manual reorder point left out means "do not touch what is there"
    let manual;
    if (reorderPoint === undefined || reorderPoint === null || reorderPoint === "") {
      manual = null;
    } else {
      manual = parseInt(reorderPoint, 10);
    }

    if (manual !== null && (!Number.isInteger(manual) || manual < 0)) {
      return response.status(400).json({ error: "The reorder point cannot be negative" });
    }

    try {
      const [existing] = await db.query(
        `SELECT product_name, reorder_point, lead_time_days, safety_stock, reorder_mode
       FROM products WHERE product_id = ? AND is_archived = FALSE`,
        [request.params.productId]
      );

      if (existing.length === 0) {
        return response.status(404).json({ error: "That product was not found." });
      }

      const before = existing[0];

      await db.query(
        `UPDATE products
       SET lead_time_days = ?, safety_stock = ?, reorder_mode = ?,
           reorder_point = COALESCE(?, reorder_point)
       WHERE product_id = ?`,
        [lead, safety, mode, manual, request.params.productId]
      );

      // no manual figure typed means the reorder point stays as it was
      let newReorderPoint = manual;
      if (manual === null) {
        newReorderPoint = before.reorder_point;
      }

      await writeAuditLog(
        request,
        "UPDATE_REORDER_POLICY",
        `${before.product_name}: ${mode.toLowerCase()} reorder point, ${lead} day lead time`,
        {
          product_id: Number(request.params.productId),
          changes: fieldChanges(
            {
              lead_time_days: before.lead_time_days,
              safety_stock: before.safety_stock,
              reorder_mode: before.reorder_mode,
              reorder_point: before.reorder_point
            },
            {
              lead_time_days: lead,
              safety_stock: safety,
              reorder_mode: mode,
              reorder_point: newReorderPoint
            })
        }
      );

      response.json({ message: `Reorder policy updated for ${before.product_name}.` });
    } catch (error) {
      console.error("Reorder policy failed:", error.message);
      response.status(500).json({ error: "Unable to save the reorder policy" });
    }
  });

  // The selling price. Sales already written keep the price they were rung
  // up at (sale_items.unit_price), so a change here reaches the till and the
  // stock value from the next sale on, never the invoices behind it. A size
  // with its own price in product_units keeps it; one priced from the unit
  // follows the new figure on its own.
  app.put("/api/stocks/:productId/price", async (request, response) => {
    let price = NaN;   // NaN = "not a number"
    if (request.body) {
      price = Number(request.body.price);
    }

    if (!Number.isFinite(price) || price < 0) {
      return response.status(400).json({ error: "The price has to be a figure of zero or more." });
    }
    if (price > 99999999.99) {
      return response.status(400).json({ error: "That price is more than the column can hold." });
    }

    try {
      const [existing] = await db.query(
        "SELECT product_name, price FROM products WHERE product_id = ? AND is_archived = FALSE",
        [request.params.productId]
      );
      if (existing.length === 0) {
        return response.status(404).json({ error: "That product was not found." });
      }

      const before = existing[0];
      const rounded = Math.round(price * 100) / 100;

      if (Number(before.price) === rounded) {
        return response.json({ message: `${before.product_name} already sells at ${rounded.toFixed(2)}.`, changed: false });
      }

      await db.query("UPDATE products SET price = ? WHERE product_id = ?", [rounded, request.params.productId]);

      await writeAuditLog(
        request,
        "UPDATE_PRICE",
        `${before.product_name}: price ${Number(before.price).toFixed(2)} to ${rounded.toFixed(2)}`,
        {
          product_id: Number(request.params.productId),
          changes: fieldChanges({ price: Number(before.price) }, { price: rounded })
        }
      );

      response.json({
        message: `${before.product_name} now sells at ${rounded.toFixed(2)}, from the next sale on.`,
        changed: true, price: rounded
      });
    } catch (error) {
      console.error("Price change failed:", error.message);
      response.status(500).json({ error: "Unable to change the price" });
    }
  });
  // The late-payment sweep: once at startup and every hour after. The rule
  // is in sp_apply_late_penalties; here each run that charged something is
  // logged and announced on the live channel, so an open credit book redraws.
  const PENALTY_SWEEP_MS = 60 * 60 * 1000;

  async function runPenaltySweep() {
    if (await proceduresAreMissing()) return;   // nothing can be written anyway

    try {
      const output = await callProcedure(
        "CALL sp_apply_late_penalties(@applied, @total)", [],
        ["applied", "total"]);

      const applied = Number(output.applied) || 0;
      const total = Number(output.total) || 0;
      if (applied < 0) {
        console.error("Late-payment sweep failed inside the database; see the MySQL log.");
        return;
      }
      if (applied > 0) {
        console.log(`Late-payment sweep: ${applied} overdue ${applied === 1 ? "sale" : "sales"} charged ` +
          `a month's penalty, ${total.toFixed(2)} in all.`);
        publishChange("credit", "penalties", null);
        publishChange("sales", "penalties", null);
        publishChange("notifications", "penalties", null);
      }
    } catch (error) {
      console.error("Late-payment sweep failed:", error.message);
    }
  }

  function startPenaltySweep() {
    runPenaltySweep();
    const timer = setInterval(runPenaltySweep, PENALTY_SWEEP_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  return { startPenaltySweep, runPenaltySweep };
}

module.exports = { registerManagerRoutes };
