// ============================================================
// cashier.js -- Cashier module (the till)
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// Routes in this file:
//   GET   /api/sales                       the list of sales, with filters
//   POST  /api/sales                       ring up a new sale
//   POST  /api/deliveries                  book a delivery for a sale
//   PATCH /api/deliveries/:id/status       move a delivery to its next status
//   GET   /api/sales/undelivered           sales that have no delivery yet
//   GET   /api/cashier/summary             the cashier's end-of-shift numbers
//   GET   /api/sales/:id                   one sale in full
//   POST  /api/sales/:id/payment           take a payment on a sale that still owes money
//
// GCash or PayMaya paid by QR code arrives with a QR payment id. It is
// checked again with the provider (qr-payments.js) before anything is
// recorded, and is used once: its payment id becomes the sale's reference.
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in server.js have already checked the user's role before any of
// these routes run.
// ============================================================

// the methods a customer can pay by scanning the QR code
const QR_METHODS = ["GCash", "PayMaya"];

function registerCashierRoutes(app, deps) {
  const {
    db, callProcedure, getActorId, DRIVER, isDateText, SALE_CUSTOMER_SQL,
    phoneComplaint, cleanPhone, qrPayments
  } = deps;

  // ==========================================
  // THE SALES LIST
  //
  // Two derived filters: PAYMENT GROUP (the four electronic methods answer as
  // one) and TRANSACTION STATUS, which is not payment_status:
  //   Voided           archived; it did not happen
  //   Pending Delivery goods booked out and not yet arrived
  //   Partial Credit   money still owed
  //   Completed        paid, and collected or delivered
  // ==========================================
  const SALE_STATUS_SQL = `
  CASE
    WHEN s.is_archived = TRUE THEN 'Voided'
    WHEN d.delivery_id IS NOT NULL AND d.status <> 'Delivered' THEN 'Pending Delivery'
    WHEN s.payment_status <> 'Paid' THEN 'Partial Credit'
    ELSE 'Completed'
  END`;

  const PAYMENT_GROUP_SQL = `
  CASE
    WHEN s.payment_method IN ('GCash','PayMaya','PayPal','Bank Transfer') THEN 'Online Payment'
    ELSE s.payment_method
  END`;

  app.get("/api/sales", async (request, response) => {
    const method = String(request.query.method || "all");
    const status = String(request.query.status || "all");
    const from = String(request.query.from || "");
    const to = String(request.query.to || "");

    // a voided sale is archived, so it is outside the default list
    // "where" collects the conditions; they are joined with AND at the end.
    // "params" holds the values for the ? marks, in the same order.
    const where = [];
    const params = [];

    if (status === "Voided") {
      where.push("s.is_archived = TRUE");
    } else {
      where.push("s.is_archived = FALSE");
    }

    if (method !== "all") {
      where.push(`${PAYMENT_GROUP_SQL} = ?`);
      params.push(method);
    }

    if (status !== "all" && status !== "Voided") {
      where.push(`${SALE_STATUS_SQL} = ?`);
      params.push(status);
    }

    // no sale has happened tomorrow: a future date is refused, not answered
    // with an empty list. The day is local: toISOString() alone is UTC.
    // today's date as "YYYY-MM-DD" in local time
    // (toISOString() alone would give the UTC date, which can be a day off)
    const now = new Date();
    const localTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    const today = localTime.toISOString().slice(0, 10);

    // was a date after today typed in "from" or "to"?
    let future = null;
    if (isDateText(from) && from > today) {
      future = from;
    } else if (isDateText(to) && to > today) {
      future = to;
    }
    if (future) {
      return response.status(400).json({
        error: `Sales only go up to today (${today}); ${future} has not happened yet.`
      });
    }

    if (isDateText(from)) { where.push("s.sale_date >= ?"); params.push(`${from} 00:00:00`); }
    if (isDateText(to))   { where.push("s.sale_date <= ?"); params.push(`${to} 23:59:59`); }

    try {
      const [rows] = await db.query(
        `SELECT s.sale_id, s.sale_date, s.total_amount, s.discount, s.final_amount,
              s.amount_paid, s.change_given, s.payment_method, s.payment_status, s.reference_no,
              s.cashier_staff_id, s.is_archived,
              GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,
              ${PAYMENT_GROUP_SQL} AS payment_group,
              ${SALE_STATUS_SQL} AS transaction_status,
              d.delivery_id, d.status AS delivery_status,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              st.full_name AS cashier_name,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE ${where.join(" AND ")}
       ORDER BY s.sale_date DESC`,
        params
      );
      response.json(rows);
    } catch (error) {
      console.error("Sales list failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // CASHIER MODULE
  // ==========================================

  // Money that is not handed over in notes is only collected once it clears,
  // and it is traced by its number: a cheque by the cheque number, a transfer
  // by the bank's reference. Those two cannot be rung up without one. The
  // e-wallets print a reference too, taken when the cashier has it.
  const REFERENCE_REQUIRED = ["Cheque", "Bank Transfer"];
  const REFERENCE_OPTIONAL = ["GCash", "PayMaya", "PayPal"];

  // The money is saved by now and is not undone over the link: a failure here
  // is logged, and the sale still carries the payment's reference.
  async function linkQrPayment(qr, saleId, request) {
    try {
      const linked = await qrPayments.recordUsed(qr.id, saleId, getActorId(request));
      if (linked.status_code !== 200) {
        console.error(`QR payment #${qr.id} was not linked to sale #${saleId}: ${linked.message}`);
      }
    } catch (error) {
      console.error(`Linking QR payment #${qr.id} to sale #${saleId} failed:`, error.message);
    }
  }

  // Ring up a sale. The procedure deducts stock, checks the limit and standing,
  // and decides paid, part paid or on the book. downPaymentMethod is how the
  // money on a Credit sale actually arrived.
  app.post("/api/sales", async (request, response) => {
    const { customerId, walkInName, discount, amountPaid, paymentMethod, items, downPaymentMethod, referenceNo,
            qrPaymentId } = request.body;

    if (!paymentMethod || !Array.isArray(items) || items.length === 0) {
      return response.status(400).json({ error: "A payment method and at least one item are required" });
    }

    const TENDER_METHODS = ["Cash", "Cheque", "GCash", "PayMaya", "PayPal", "Bank Transfer"];
    let downMethod = "Cash";
    if (TENDER_METHODS.includes(downPaymentMethod)) {
      downMethod = downPaymentMethod;
    }

    // how the money taken today arrived: the sale's own method, or on a Credit
    // sale the part payment's; nothing is taken on COD or on credit with nothing down
    let takenNow;
    if (paymentMethod === "Credit") {
      if (Number(amountPaid) > 0) {
        takenNow = downMethod;
      } else {
        takenNow = null;
      }
    } else if (paymentMethod === "COD") {
      takenNow = null;
    } else {
      takenNow = paymentMethod;
    }

    // the reference number, with extra spaces removed
    let reference = "";
    if (typeof referenceNo === "string") {
      reference = referenceNo.trim().replace(/\s+/g, " ");
    }

    if (REFERENCE_REQUIRED.includes(takenNow) && reference === "") {
      let what = `A ${takenNow.toLowerCase()} sale`;
      if (paymentMethod === "Credit") {
        what = `The part payment is by ${takenNow.toLowerCase()}, so it`;
      }

      let whichNumber = "transfer reference from the bank";
      if (takenNow === "Cheque") {
        whichNumber = "cheque number";
      }

      return response.status(400).json({
        error: `${what} needs its reference: the ${whichNumber}. ` +
               "It is how the money is traced if it does not arrive."
      });
    }
    if (reference.length > 60) {
      return response.status(400).json({ error: "A reference is at most 60 characters." });
    }

    // kept only where it means something: a reference typed against cash is dropped
    let keptReference;
    if (REFERENCE_REQUIRED.includes(takenNow) || REFERENCE_OPTIONAL.includes(takenNow)) {
      keptReference = reference;
    } else {
      keptReference = "";
    }

    // Paid by QR code: the payment is checked here, never taken on the
    // browser's word, for the money taken now (on a Credit sale, the part paid)
    let qr = null;
    if (qrPaymentId) {
      if (!QR_METHODS.includes(takenNow)) {
        return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash or PayMaya." });
      }
      try {
        qr = await qrPayments.verifyForMoney(qrPaymentId, Number(amountPaid) || 0, takenNow, getActorId(request));
      } catch (error) {
        if (!(error instanceof qrPayments.QrPaymentError)) throw error;
        return response.status(error.status).json({ error: error.message, code: error.code });
      }
      // the payment's own number, whatever was typed
      keptReference = qr.reference || "";
    }
    let saleId = null;

    // trimmed and capped to the column (150) rather than failing the sale
    let typedName;
    if (typeof walkInName === "string") {
      typedName = walkInName.trim().slice(0, 150);
    } else {
      typedName = "";
    }

    try {
      const output = await callProcedure(
        "CALL sp_create_sale_transaction(?, ?, ?, ?, ?, ?, ?, ?, @sale_id, @status_code, @message)",
        [customerId || null, typedName || null, getActorId(request), discount || 0, amountPaid || 0,
         paymentMethod, JSON.stringify(items), downMethod],
        ["sale_id", "status_code", "message"]
      );

      if (output.status_code !== 200) {
        // Refused (an item ran out) after the customer paid: the row stays
        // paid and says a refund is owed, written before the till is answered.
        // The payment can still be used on the next try.
        if (qr) await qrPayments.recordUnsaved(qr.id, getActorId(request));
        return response.status(output.status_code).json({ error: output.message });
      }
      saleId = output.sale_id;
      if (qr) await linkQrPayment(qr, saleId, request);

      // The sale exists by now and is not undone over its reference: a failure
      // here is said on the screen, and the invoice prints without it.
      let referenceNote = null;
      if (keptReference !== "") {
        try {
          const saved = await callProcedure(
            "CALL sp_set_sale_reference(?, ?, ?, @status_code, @message)",
            [output.sale_id, keptReference, getActorId(request)],
            ["status_code", "message"]
          );
          if (saved.status_code !== 200) referenceNote = saved.message;
        } catch (error) {
          console.error("Saving the sale reference failed:", error.message);
          referenceNote = "The sale was saved, but its reference was not. Write it on the invoice by hand.";
        }
      }

      response.json({ message: output.message, saleId: output.sale_id, referenceNote: referenceNote });
    } catch (error) {
      console.error("Create sale failed:", error.message);
      if (qr && !saleId) await qrPayments.recordUnsaved(qr.id, getActorId(request));
      if (!response.headersSent) response.status(500).json({ error: "Unable to complete the sale" });
    } finally {
      if (qr) qr.release();
    }
  });

  // "2026-09-05T14:30" from datetime-local becomes "2026-09-05 14:30"; any other
  // shape is dropped so nothing reaches a DATETIME column unparsed
  function toMysqlDateTime(value) {
    const text = String(value || "").trim();
    if (text === "") return null;

    // "YYYY-MM-DD" then "T" or a space, then "HH:MM", then maybe ":SS"
    // match[1] = the date, match[2] = the time, match[3] = the seconds (if any)
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(text);
    if (match) {
      const seconds = match[3] || ":00";
      return match[1] + " " + match[2] + seconds;
    }

    if (isDateText(text)) return `${text} 00:00:00`;

    return null;
  }

  // the drivers a cashier can hand a delivery to at booking time
  app.get("/api/deliveries/drivers", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT st.staff_id, st.full_name
       FROM staff st
       JOIN roles r ON r.role_id = st.role_id
       WHERE r.role_name = ? AND st.is_active = TRUE AND st.archived_at IS NULL
       ORDER BY st.full_name`,
        [DRIVER]
      );
      response.json(rows);
    } catch (error) {
      console.error("Drivers list failed:", error.message);
      response.status(500).json({ error: "Unable to read the drivers" });
    }
  });

  app.post("/api/deliveries", async (request, response) => {
    const { saleId, address, scheduledDate, remarks, contactName, contactPhone } = request.body;
    // optional: empty leaves the delivery open for any driver to take
    const driverId = request.body.driverStaffId ? Number(request.body.driverStaffId) : null;

    if (!saleId || !address) {
      return response.status(400).json({ error: "A sale and a delivery address are required" });
    }

    if (!String(contactPhone || "").trim()) {
      return response.status(400).json({ error: "A delivery needs a phone number the driver can call" });
    }
    const phoneProblem = phoneComplaint(contactPhone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    const scheduled = toMysqlDateTime(scheduledDate);

    // a schedule typed but not understood must not become "unscheduled" silently
    if (scheduledDate && !scheduled) {
      return response.status(400).json({
        error: "The scheduled date and time could not be read. Use the picker rather than typing it."
      });
    }

    // trimmed and cut to the size of the database column; empty becomes null
    const contact = (contactName || "").trim().slice(0, 150) || null;
    const phone = cleanPhone(contactPhone);

    try {
      // checked before booking, so a bad pick never leaves a half-made delivery
      let driverName = null;
      if (driverId) {
        const [drivers] = await db.query(
          `SELECT st.full_name FROM staff st
         JOIN roles r ON r.role_id = st.role_id
         WHERE st.staff_id = ? AND r.role_name = ? AND st.is_active = TRUE AND st.archived_at IS NULL`,
          [driverId, DRIVER]
        );
        if (drivers.length === 0) {
          return response.status(400).json({ error: "That driver is not an active delivery staff member." });
        }
        driverName = drivers[0].full_name;
      }

      // booked on the day the order was taken: the sale's own date
      const [saleRows] = await db.query(
        "SELECT DATE_FORMAT(sale_date, '%Y-%m-%d') AS sale_day FROM sales WHERE sale_id = ?",
        [saleId]
      );
      const booked = saleRows.length > 0 ? saleRows[0].sale_day : null;

      const output = await callProcedure(
        "CALL sp_create_delivery(?, ?, ?, ?, ?, ?, ?, ?, @delivery_id, @status_code, @message)",
        [saleId, address, scheduled, remarks || null, contact, phone, booked, getActorId(request)],
        ["delivery_id", "status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (driverId) {
        await db.query("UPDATE deliveries SET delivery_staff_id = ? WHERE delivery_id = ?",
          [driverId, output.delivery_id]);
      }

      response.json({
        message: driverId
          ? `Delivery #${output.delivery_id} created and assigned to ${driverName}.`
          : `Delivery #${output.delivery_id} created.`,
        deliveryId: output.delivery_id
      });
    } catch (error) {
      console.error("Book delivery failed:", error.message);
      response.status(500).json({ error: "Unable to book the delivery" });
    }
  });

  // The one route that moves a delivery; the procedure decides what each role may do.
  app.patch("/api/deliveries/:deliveryId/status", async (request, response) => {
    const { status, remarks } = request.body;
    const actor = request.actor;

    if (!status) {
      return response.status(400).json({ error: "A status is required" });
    }

    try {
      // a driver moves only a delivery they took (POST /api/delivery/:id/claim)
      if (actor.roleName === DRIVER) {
        const [rows] = await db.query(
          "SELECT delivery_staff_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
          [request.params.deliveryId]
        );
        if (rows.length === 0) {
          return response.status(404).json({ error: "Delivery not found" });
        }
        if (rows[0].delivery_staff_id === null) {
          return response.status(409).json({ error: "Take this delivery before updating it." });
        }
        if (Number(rows[0].delivery_staff_id) !== Number(actor.staffId)) {
          return response.status(403).json({ error: "This delivery is assigned to another driver." });
        }
      }

      const output = await callProcedure(
        "CALL sp_update_delivery_status(?, ?, ?, ?, ?, @status_code, @message)",
        [request.params.deliveryId, status, remarks || null, actor.staffId, actor.roleId],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Delivery status failed:", error.message);
      response.status(500).json({ error: "Unable to update the delivery" });
    }
  });

  app.get("/api/sales/undelivered", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT s.sale_id, s.final_amount, s.sale_date, s.payment_method,
              ${SALE_CUSTOMER_SQL} AS customer_name,
              COALESCE(c.address, '') AS customer_address
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE
       WHERE s.is_archived = FALSE AND d.delivery_id IS NULL
       ORDER BY s.sale_id DESC
       LIMIT 60`
      );
      response.json(rows);
    } catch (error) {
      console.error("Undelivered sales failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // End of shift: one cashier, one day (today by default), every figure bounded
  // by DATE(sale_date). Refunds come back line by line.
  app.get("/api/cashier/summary", async (request, response) => {
    // the session's shift, always; a staff id in the URL is ignored
    const staffId = request.actor.staffId;

    // an unreadable date means today (null = today in the SQL below)
    let day = null;
    if (isDateText(request.query.date)) {
      day = request.query.date;
    }

    try {
      const [totalRows] = await db.query(
        // collected is what stayed in the drawer, not amount_paid (which includes the note they broke)
        `SELECT COUNT(*) AS sale_count,
              COALESCE(SUM(final_amount), 0) AS gross,
              COALESCE(SUM(discount), 0) AS discounts,
              COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected
       FROM sales
       WHERE cashier_staff_id = ? AND is_archived = FALSE
         AND DATE(sale_date) = COALESCE(?, CURDATE())`,
        [staffId, day]
      );
      const totals = totalRows[0];

      const [methods] = await db.query(
        `SELECT payment_method, COUNT(*) AS sale_count, COALESCE(SUM(final_amount), 0) AS total_amount
       FROM sales
       WHERE cashier_staff_id = ? AND is_archived = FALSE
         AND DATE(sale_date) = COALESCE(?, CURDATE())
       GROUP BY payment_method
       ORDER BY total_amount DESC`,
        [staffId, day]
      );

      const [refundRows] = await db.query(
        `SELECT COUNT(*) AS refund_count, COALESCE(SUM(refund_amount), 0) AS refund_total,
              COALESCE(SUM(quantity), 0) AS refund_items
       FROM returned_items
       WHERE reported_by_staff_id = ? AND report_type = 'Refunded'
         AND DATE(return_date) = COALESCE(?, CURDATE())`,
        [staffId, day]
      );
      const refunds = refundRows[0];

      // what actually went back, capped
      const [refundLines] = await db.query(
        `SELECT r.return_id, r.quantity, r.refund_amount, r.reason, r.disposition,
              r.return_date, r.sale_id,
              p.product_name, u.unit_name,
              CASE WHEN r.quantity > 0 THEN r.refund_amount / r.quantity ELSE r.refund_amount END
                AS unit_refund
       FROM returned_items r
       JOIN products p ON p.product_id = r.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE r.reported_by_staff_id = ? AND r.report_type = 'Refunded'
         AND DATE(r.return_date) = COALESCE(?, CURDATE())
       ORDER BY r.return_date DESC
       LIMIT 100`,
        [staffId, day]
      );

      const [stampRows] = await db.query(
        "SELECT COALESCE(?, CURDATE()) AS day", [day]
      );
      const stamp = stampRows[0];

      response.json({
        // the day the figures are for, resolved server side
        date: stamp.day,
        saleCount: totals.sale_count,
        gross: totals.gross,
        discounts: totals.discounts,
        collected: totals.collected,
        refundCount: refunds.refund_count,
        refundItems: refunds.refund_items,
        refundTotal: refunds.refund_total,
        refunds: refundLines,
        methods: methods
      });
    } catch (error) {
      console.error("Cashier summary failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sales/:saleId", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT s.*, ${SALE_CUSTOMER_SQL} AS customer_name,
              c.phone AS customer_phone, c.address AS customer_address,
              st.full_name AS cashier_name
       FROM sales s
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       JOIN staff st ON st.staff_id = s.cashier_staff_id
       WHERE s.sale_id = ?`,
        [request.params.saleId]
      );

      if (rows.length === 0) {
        return response.status(404).json({ error: "Sale not found" });
      }

      // quantity and unit_name are what the customer was charged for (2 sacks);
      // base_quantity and base_unit are what left the shelf (50 kg)
      const [items] = await db.query(
        `SELECT COALESCE(si.sold_quantity, si.quantity) AS quantity,
              COALESCE(si.sold_unit, u.unit_name) AS unit_name,
              si.quantity AS base_quantity, u.unit_name AS base_unit,
              si.unit_price, si.subtotal, p.product_name
       FROM sale_items si
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE si.sale_id = ?`,
        [request.params.saleId]
      );

      const [payments] = await db.query(
        `SELECT cp.amount, cp.payment_method, cp.reference_no, cp.payment_date,
              st.full_name AS received_by
       FROM credit_payments cp
       LEFT JOIN staff st ON st.staff_id = cp.received_by_staff_id
       WHERE cp.sale_id = ?
       ORDER BY cp.payment_date`,
        [request.params.saleId]
      );

      const [delivery] = await db.query(
        `SELECT d.delivery_id, d.status, d.delivery_address, d.scheduled_date, d.delivered_at, d.remarks,
              st.full_name AS driver_name
       FROM deliveries d
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE d.sale_id = ?`,
        [request.params.saleId]
      );

      // the GCash or Maya codes paid towards this sale, with PayMongo's reference
      const [qrPaid] = await db.query(
        `SELECT qr_payment_id, status, amount, wallet, purpose, provider, mode, provider_payment_id, paid_at
         FROM qr_payments WHERE sale_id = ? ORDER BY qr_payment_id`,
        [request.params.saleId]
      );

      response.json({ sale: rows[0], items: items, payments: payments, delivery: delivery[0] || null,
                      qrPayments: qrPaid });
    } catch (error) {
      console.error("Sale detail failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/sales/:saleId/payment", async (request, response) => {
    const { amount, paymentMethod, referenceNo, qrPaymentId } = request.body;

    if (!amount || !paymentMethod) {
      return response.status(400).json({ error: "Amount and payment method are required" });
    }

    // the same rule as a sale: a QR payment is checked here and used once
    let reference = referenceNo || null;
    let qr = null;
    if (qrPaymentId) {
      if (!QR_METHODS.includes(paymentMethod)) {
        return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash or PayMaya." });
      }
      try {
        qr = await qrPayments.verifyForMoney(qrPaymentId, Number(amount) || 0, paymentMethod, getActorId(request));
      } catch (error) {
        if (!(error instanceof qrPayments.QrPaymentError)) throw error;
        return response.status(error.status).json({ error: error.message, code: error.code });
      }
      reference = qr.reference;
    }
    let recorded = false;

    try {
      const output = await callProcedure(
        "CALL sp_record_credit_payment(?, ?, ?, ?, ?, @status_code, @message)",
        [request.params.saleId, amount, paymentMethod, reference, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        // the customer paid and nothing was recorded: said on the row first
        if (qr) await qrPayments.recordUnsaved(qr.id, getActorId(request));
        return response.status(output.status_code).json({ error: output.message });
      }
      recorded = true;
      if (qr) await linkQrPayment(qr, request.params.saleId, request);

      response.json({ message: output.message, reference: qr ? qr.reference : null });
    } catch (error) {
      console.error("Payment failed:", error.message);
      if (qr && !recorded) await qrPayments.recordUnsaved(qr.id, getActorId(request));
      if (!response.headersSent) response.status(500).json({ error: "Unable to record the payment" });
    } finally {
      if (qr) qr.release();
    }
  });
}

module.exports = { registerCashierRoutes };
