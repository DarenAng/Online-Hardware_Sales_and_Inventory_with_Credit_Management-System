// ============================================================
// delivery.js -- Delivery module (delivery personnel)
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// Routes in this file:
//   GET  /api/deliveries                 every delivery (read by several roles)
//   GET  /api/deliveries/:id/items       what is being delivered
//   GET  /api/delivery/list              the driver's own deliveries
//   POST /api/delivery/:id/claim         a driver takes an unclaimed delivery
//   POST /api/delivery/:id/payment       cash collected at the customer's door
//   GET  /api/delivery/summary           the driver's report for a date range
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in server.js have already checked the user's role.
// ============================================================

function registerDeliveryRoutes(app, deps) {
  const {
    db, callProcedure, getActorId, isDateText, DELIVERY_CONTACT_SQL, DELIVERY_PHONE_SQL
  } = deps;

  // Delivered and finished are different: a delivered order with money owed
  // sits at Pending Cash Collection until the balance is cleared. Derived from
  // the sale's own figures, so there is no second flag to forget.
  const FULFILMENT_SQL = `
  CASE
    WHEN d.status <> 'Delivered' THEN d.status
    WHEN GREATEST(s.amount_due - s.amount_paid, 0) > 0 THEN 'Pending Cash Collection'
    ELSE 'Completed'
  END`;

  app.get("/api/deliveries", async (request, response) => {
    const state = String(request.query.state || "all");

    const where = ["d.is_archived = FALSE"];
    const params = [];

    if (state !== "all") {
      where.push(`${FULFILMENT_SQL} = ?`);
      params.push(state);
    }

    try {
      const [rows] = await db.query(
        `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at, d.updated_at,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              ${DELIVERY_PHONE_SQL} AS customer_phone,
              COALESCE(st.full_name, 'Unassigned') AS driver_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,
              ${FULFILMENT_SQL} AS fulfilment_state
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE ${where.join(" AND ")}
       ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'),
                d.scheduled_date`,
        params
      );
      response.json(rows);
    } catch (error) {
      console.error("Deliveries failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // what is on the lorry: the sale's lines, for the delivery popup on every
  // screen. Read the way the receipt reads them, so 2 sacks shows as 2 sacks.
  app.get("/api/deliveries/:deliveryId/items", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT COALESCE(si.sold_quantity, si.quantity) AS quantity,
              COALESCE(si.sold_unit, u.unit_name) AS unit_name,
              si.quantity AS base_quantity, u.unit_name AS base_unit,
              si.unit_price, si.subtotal, p.product_name
       FROM deliveries d
       JOIN sale_items si ON si.sale_id = d.sale_id
       JOIN products p ON p.product_id = si.product_id
       LEFT JOIN units u ON u.unit_id = p.unit_id
       WHERE d.delivery_id = ?
       ORDER BY si.sale_item_id`,
        [request.params.deliveryId]
      );
      response.json(rows);
    } catch (error) {
      console.error("Delivery items failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // DELIVERY PERSONNEL MODULE
  // ==========================================

  // deliveries assigned to this driver, plus any nobody claimed yet
  app.get("/api/delivery/list", async (request, response) => {
    // from the session, so one driver cannot pull up another's round
    const staffId = request.actor.staffId;

    try {
      const [rows] = await db.query(
        `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at, d.updated_at, d.delivery_staff_id,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              ${DELIVERY_PHONE_SQL} AS customer_phone,
              COALESCE(st.full_name, 'Unassigned') AS driver_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              (s.amount_due - s.amount_paid) AS balance_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id
       WHERE d.is_archived = FALSE
         AND (d.delivery_staff_id = ? OR d.delivery_staff_id IS NULL)
       ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'),
                d.scheduled_date`,
        [staffId]
      );
      response.json(rows);
    } catch (error) {
      console.error("Delivery list failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // A driver takes an unclaimed delivery; the UPDATE only matches while nobody
  // else has it, so two drivers clicking at once cannot both win.
  app.post("/api/delivery/:deliveryId/claim", async (request, response) => {
    const staffId = request.actor.staffId;
    const deliveryId = Number(request.params.deliveryId);

    try {
      const [result] = await db.query(
        `UPDATE deliveries SET delivery_staff_id = ?
       WHERE delivery_id = ? AND is_archived = FALSE
         AND status NOT IN ('Delivered', 'Failed')
         AND (delivery_staff_id IS NULL OR delivery_staff_id = ?)`,
        [staffId, deliveryId, staffId]
      );

      if (result.affectedRows === 0) {
        const [rows] = await db.query(
          "SELECT delivery_staff_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
          [deliveryId]
        );
        if (rows.length === 0) {
          return response.status(404).json({ error: "Delivery not found" });
        }
        return response.status(409).json({ error: "Another driver has already taken this delivery." });
      }

      response.json({ message: `Delivery #${deliveryId} is now yours.` });
    } catch (error) {
      console.error("Delivery claim failed:", error.message);
      response.status(500).json({ error: "Unable to take the delivery" });
    }
  });

  // cash on delivery collected at the door
  app.post("/api/delivery/:deliveryId/payment", async (request, response) => {
    const { amount, paymentMethod, referenceNo } = request.body;

    if (!amount || !paymentMethod) {
      return response.status(400).json({ error: "Amount and payment method are required" });
    }

    try {
      const [rows] = await db.query(
        "SELECT sale_id, delivery_staff_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
        [request.params.deliveryId]
      );

      if (rows.length === 0) {
        return response.status(404).json({ error: "Delivery not found" });
      }
      // money is taken only on a delivery this driver took
      if (Number(rows[0].delivery_staff_id) !== Number(request.actor.staffId)) {
        return response.status(403).json({ error: "Take this delivery before collecting on it." });
      }

      const output = await callProcedure(
        "CALL sp_record_credit_payment(?, ?, ?, ?, ?, @status_code, @message)",
        [rows[0].sale_id, amount, paymentMethod, referenceNo || null, getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Delivery payment failed:", error.message);
      response.status(500).json({ error: "Unable to record the payment" });
    }
  });

  app.get("/api/delivery/summary", async (request, response) => {
    const staffId = request.actor.staffId;   // this driver's own round, never another's

    // a missing or unreadable date means "no limit" on that side
    let from = "2000-01-01";
    let to = "2100-12-31";
    if (isDateText(request.query.from)) {
      from = request.query.from;
    }
    if (isDateText(request.query.to)) {
      to = request.query.to;
    }

    try {
      const [deliveries] = await db.query(
        `SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks,
              d.scheduled_date, d.booked_date, d.delivered_at,
              ${DELIVERY_CONTACT_SQL} AS customer_name,
              s.final_amount, s.amount_paid, s.payment_method, s.payment_status,
              (s.amount_due - s.amount_paid) AS balance_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       LEFT JOIN customers c ON c.customer_id = s.customer_id
       WHERE d.is_archived = FALSE
         AND d.delivery_staff_id = ?
         AND DATE(COALESCE(d.delivered_at, d.scheduled_date, d.updated_at)) BETWEEN ? AND ?
       ORDER BY COALESCE(d.delivered_at, d.scheduled_date) DESC`,
        [staffId, from, to]
      );

      const [payments] = await db.query(
        `SELECT cp.payment_id, cp.sale_id, cp.amount, cp.payment_method,
              cp.reference_no, cp.payment_date,
              COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), 'Walk-in') AS customer_name
       FROM credit_payments cp
       LEFT JOIN customers c ON c.customer_id = cp.customer_id
       WHERE cp.received_by_staff_id = ?
         AND DATE(cp.payment_date) BETWEEN ? AND ?
       ORDER BY cp.payment_date DESC`,
        [staffId, from, to]
      );

      // money owed is counted only against the driver actually carrying the order
      const [openRows] = await db.query(
        `SELECT COUNT(*) AS cod_count,
              COALESCE(SUM(s.amount_due - s.amount_paid), 0) AS cod_due
       FROM deliveries d
       JOIN sales s ON s.sale_id = d.sale_id
       WHERE d.is_archived = FALSE
         AND d.delivery_staff_id = ?
         AND s.payment_status <> 'Paid'`,
        [staffId]
      );
      const open = openRows[0];

      response.json({
        from: from,
        to: to,
        deliveries: deliveries,
        payments: payments,
        codCount: open.cod_count,
        codDue: open.cod_due
      });
    } catch (error) {
      console.error("Delivery summary failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerDeliveryRoutes };
