// ============================================================
// delivery.js -- Delivery module (delivery personnel)
// Loaded by: server.js only (from the routes folder). Never sent to a browser.
//
// Routes in this file:
//   GET  /api/deliveries                 every delivery (read by several roles)
//   GET  /api/deliveries/:id/items       what is being delivered
//   GET  /api/delivery/list              the driver's own deliveries
//   POST /api/delivery/:id/claim         a driver takes an unclaimed delivery
//   POST /api/delivery/:id/payment       money collected at the customer's door (any method)
//   GET  /api/delivery/summary           the driver's report for a date range
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in access-control.js have already checked the user's role.
// ============================================================

const deliveryProcedures = require("../database/procedures/delivery-procedures");
const cleanPaymentDetails = require("../payment-details").cleanPaymentDetails;

function registerDeliveryRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const publishChange = deps.publishChange;
  const isDateText = deps.isDateText;
  const DELIVERY_CONTACT_SQL = deps.DELIVERY_CONTACT_SQL;
  const DELIVERY_PHONE_SQL = deps.DELIVERY_PHONE_SQL;

  // Delivered and finished are different: a delivered order with money owed
  // sits at Pending Payment until the balance is cleared. Derived from
  // the sale's own figures, so there is no second flag to forget.
  const FULFILMENT_SQL =
    "\n  CASE" +
    "\n    WHEN d.status <> 'Delivered' THEN d.status" +
    "\n    WHEN GREATEST(s.amount_due - s.amount_paid, 0) > 0 THEN 'Pending Payment'" +
    "\n    ELSE 'Completed'" +
    "\n  END";

  app.get("/api/deliveries", async function (request, response) {
    const state = String(request.query.state || "all");

    const where = ["d.is_archived = FALSE"];
    const params = [];

    if (state !== "all") {
      where.push(FULFILMENT_SQL + " = ?");
      params.push(state);
    }

    try {
      const result = await db.query(
        // delivery_staff_id: a driver's card offers status buttons only on their own delivery
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.address_street, d.address_barangay, d.address_city, d.address_province, d.address_landmark, " +
        "d.scheduled_date, d.created_date, d.delivered_at, d.updated_at, d.delivery_staff_id, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        DELIVERY_PHONE_SQL + " AS customer_phone, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name, " +
        "s.final_amount, s.amount_due, s.amount_paid, s.payment_method, s.payment_status, " +
        "GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due, " +
        FULFILMENT_SQL + " AS fulfilment_state " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "LEFT JOIN customers c ON c.customer_id = s.customer_id " +
        "LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id " +
        "WHERE " + where.join(" AND ") + " " +
        "ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'), " +
        "d.scheduled_date",
        params
      );
      const rows = result[0];
      response.json(rows);
    } catch (error) {
      console.error("Deliveries failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // what is on the lorry: the sale's lines, for the delivery popup on every
  // screen. Read the way the receipt reads them, so 2 sacks shows as 2 sacks.
  // The driver's refund form also needs the product, the sale and how much
  // of the line has already been taken back (refunded_quantity, in the
  // shelf's own unit like base_quantity).
  app.get("/api/deliveries/:deliveryId/items", async function (request, response) {
    try {
      const result = await db.query(
        "SELECT COALESCE(si.sold_quantity, si.quantity) AS quantity, " +
        "COALESCE(si.sold_unit, u.unit_name) AS unit_name, " +
        "si.quantity AS base_quantity, u.unit_name AS base_unit, " +
        "si.unit_price, si.subtotal, p.product_name, " +
        "si.product_id, si.sale_id, " +
        "s.total_amount AS sale_total, s.final_amount AS sale_final, " +
        "(SELECT COALESCE(SUM(r.quantity), 0) FROM returned_items r " +
        "WHERE r.sale_id = si.sale_id AND r.product_id = si.product_id " +
        "AND r.report_type IN ('Refunded', 'Return')) AS refunded_quantity " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "JOIN sale_items si ON si.sale_id = d.sale_id " +
        "JOIN products p ON p.product_id = si.product_id " +
        "LEFT JOIN units u ON u.unit_id = p.unit_id " +
        "WHERE d.delivery_id = ? " +
        "ORDER BY si.sale_item_id",
        [request.params.deliveryId]
      );
      const rows = result[0];
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
  app.get("/api/delivery/list", async function (request, response) {
    // from the session, so one driver cannot pull up another's round
    const staffId = request.actor.staffId;

    try {
      const result = await db.query(
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.address_street, d.address_barangay, d.address_city, d.address_province, d.address_landmark, " +
        "d.scheduled_date, d.created_date, d.delivered_at, d.updated_at, d.delivery_staff_id, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        DELIVERY_PHONE_SQL + " AS customer_phone, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name, " +
        "s.final_amount, s.amount_due, s.amount_paid, s.payment_method, s.payment_status, " +
        "GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "LEFT JOIN customers c ON c.customer_id = s.customer_id " +
        "LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id " +
        "WHERE d.is_archived = FALSE " +
        "AND (d.delivery_staff_id = ? OR d.delivery_staff_id IS NULL) " +
        "ORDER BY FIELD(d.status, 'Out for Delivery', 'In Transit', 'Pending', 'Delayed', 'Failed', 'Delivered'), " +
        "d.scheduled_date",
        [staffId]
      );
      const rows = result[0];
      response.json(rows);
    } catch (error) {
      console.error("Delivery list failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // A driver takes an unclaimed delivery; the UPDATE only matches while nobody
  // else has it, so two drivers clicking at once cannot both win.
  app.post("/api/delivery/:deliveryId/claim", async function (request, response) {
    const staffId = request.actor.staffId;
    const deliveryId = Number(request.params.deliveryId);

    try {
      const updateResult = await db.query(
        "UPDATE deliveries SET delivery_staff_id = ? " +
        "WHERE delivery_id = ? AND is_archived = FALSE " +
        "AND status NOT IN ('Delivered', 'Failed') " +
        "AND (delivery_staff_id IS NULL OR delivery_staff_id = ?)",
        [staffId, deliveryId, staffId]
      );
      const result = updateResult[0];

      if (result.affectedRows === 0) {
        const checkResult = await db.query(
          "SELECT delivery_staff_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
          [deliveryId]
        );
        const rows = checkResult[0];
        if (rows.length === 0) {
          return response.status(404).json({ error: "Delivery not found" });
        }
        return response.status(409).json({ error: "Another driver has already taken this delivery." });
      }

      response.json({ message: "Delivery #" + deliveryId + " is now yours." });
    } catch (error) {
      console.error("Delivery claim failed:", error.message);
      response.status(500).json({ error: "Unable to take the delivery" });
    }
  });

  // Money collected at the customer's door, cash or not. The payment goes on the
  // sale itself (sp_record_credit_payment), so the cashier's lists, the receipt
  // and the manager's reports all read it from there. Then the cashier and the
  // manager are told, and every screen watching sales, credit and deliveries
  // reads again.
  // A cheque is collected with the same details the counter takes (account name and
  // number, bank, branch, date). The driver has no QR screen, so a bank transfer shown
  // at the door is only taken on the driver's word: the customer's bank, account name
  // and account number, and the bank's reference. It is not verified through PayMongo.
  const PAYMENT_METHODS = ["Cash", "GCash", "PayMaya", "Cheque", "Bank Transfer"];
  const REFERENCE_NEEDED = ["Cheque", "Bank Transfer"];

  // "\u20B1" is the peso sign, written as an escape to keep this file plain ASCII
  function pesoText(value) {
    return "\u20B1" + Number(value || 0).toLocaleString("en-PH",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  app.post("/api/delivery/:deliveryId/payment", async function (request, response) {
    const paymentMethod = request.body.paymentMethod;
    let referenceNo = "";
    if (typeof request.body.referenceNo === "string") {
      referenceNo = request.body.referenceNo.trim().replace(/\s+/g, " ");
    }

    if (!request.body.amount || !paymentMethod) {
      return response.status(400).json({ error: "Amount and payment method are required" });
    }
    // rounded to the centavo; it has to be more than nothing
    const amount = Math.round(Number(request.body.amount) * 100) / 100;
    if (!(amount > 0)) {
      return response.status(400).json({ error: "The amount received has to be more than zero." });
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return response.status(400).json({ error: "Pick how the customer paid: " + PAYMENT_METHODS.join(", ") + "." });
    }
    if (REFERENCE_NEEDED.includes(paymentMethod) && referenceNo === "") {
      let whichNumber = "transfer reference";
      if (paymentMethod === "Cheque") {
        whichNumber = "cheque number";
      }
      return response.status(400).json({
        error: "A " + paymentMethod.toLowerCase() + " payment needs its reference: the " + whichNumber +
               ". It is how the money is traced if it does not arrive."
      });
    }
    if (referenceNo.length > 60) {
      return response.status(400).json({ error: "A reference is at most 60 characters." });
    }

    // the bank and account behind a cheque or a bank transfer
    let payDetails = null;
    if (paymentMethod === "Cheque" || paymentMethod === "Bank Transfer") {
      const cleaned = cleanPaymentDetails(paymentMethod, request.body.paymentDetails);
      if (cleaned.problem) {
        return response.status(400).json({ error: cleaned.problem });
      }
      payDetails = JSON.stringify(cleaned.details);
    }

    try {
      const deliveryResult = await db.query(
        "SELECT d.sale_id, d.delivery_staff_id, s.payment_method FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id WHERE d.delivery_id = ? AND d.is_archived = FALSE",
        [request.params.deliveryId]
      );
      const rows = deliveryResult[0];

      if (rows.length === 0) {
        return response.status(404).json({ error: "Delivery not found" });
      }
      // money is taken only on a delivery this driver took
      if (Number(rows[0].delivery_staff_id) !== Number(request.actor.staffId)) {
        return response.status(403).json({ error: "Take this delivery before collecting on it." });
      }
      // a sale on account is paid at the counter by its due date, not at the door
      if (rows[0].payment_method !== "COD") {
        return response.status(409).json({
          error: "This sale is on account, so it is paid at the counter, not at the door."
        });
      }

      const saleId = rows[0].sale_id;
      // the procedure refuses more than the sale still owes, and a sale already paid
      const output = await deliveryProcedures.recordCreditPayment(
        [saleId, amount, paymentMethod, referenceNo || null, getActorId(request), null, payDetails]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // From here the money is recorded. Whatever goes wrong below (reading the
      // sale again, writing the alerts) is only logged: the driver is told the
      // payment was recorded, so it is never taken a second time.
      const deliveryId = Number(request.params.deliveryId);
      let sale = null;
      try {
        // what the sale owes now, for the answer and for the notification
        const saleResult = await db.query(
          "SELECT s.payment_status, s.amount_paid, GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due, " +
          "(SELECT full_name FROM staff WHERE staff_id = ?) AS driver_name " +
          "FROM sales s WHERE s.sale_id = ?",
          [request.actor.staffId, saleId]
        );
        sale = saleResult[0][0];

        let driverName = "the driver";
        if (sale && sale.driver_name) driverName = sale.driver_name;

        const title = "Payment collected on delivery #" + deliveryId + ": " + pesoText(amount) +
                      " by " + driverName;
        let message = paymentMethod + " payment of " + pesoText(amount) +
                      " on OR-" + String(saleId).padStart(6, "0") + ".";
        if (referenceNo !== "") {
          message += " Reference " + referenceNo + ".";
        }
        if (sale && Number(sale.balance_due) > 0) {
          message += " " + pesoText(sale.balance_due) + " is still owed.";
        } else if (sale) {
          message += " The sale is now paid in full.";
        }

        // the cashier and the manager are told, like the other alerts
        await db.query(
          "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id) " +
          "SELECT role_id, 'Delivery', ?, ?, ? FROM roles WHERE role_name IN ('Cashier', 'Manager')",
          [title.slice(0, 150), message, getActorId(request)]
        );
      } catch (error) {
        console.error("The delivery payment was recorded, but telling the cashier failed:", error.message);
      }

      // The deliveries scope goes out by itself on this address (scopeOf in
      // live-changes.js). The sale's figures, the credit lists and the bell moved too.
      const origin = request.headers["x-client-id"] || null;
      publishChange("sales", "delivery payment " + deliveryId, origin);
      publishChange("credit", "delivery payment " + deliveryId, origin);
      publishChange("notifications", "delivery payment " + deliveryId, origin);

      response.json({
        message: output.message,
        amount: amount,
        paymentStatus: sale ? sale.payment_status : null,
        amountPaid: sale ? sale.amount_paid : null,
        balanceDue: sale ? sale.balance_due : null
      });
    } catch (error) {
      console.error("Delivery payment failed:", error.message);
      response.status(500).json({ error: "Unable to record the payment" });
    }
  });

  app.get("/api/delivery/summary", async function (request, response) {
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
      const deliveriesResult = await db.query(
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.address_street, d.address_barangay, d.address_city, d.address_province, d.address_landmark, " +
        "d.scheduled_date, d.created_date, d.delivered_at, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        "s.final_amount, s.amount_due, s.amount_paid, s.payment_method, s.payment_status, " +
        "GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "LEFT JOIN customers c ON c.customer_id = s.customer_id " +
        "WHERE d.is_archived = FALSE " +
        "AND d.delivery_staff_id = ? " +
        "AND DATE(COALESCE(d.delivered_at, d.scheduled_date, d.updated_at)) BETWEEN ? AND ? " +
        "ORDER BY COALESCE(d.delivered_at, d.scheduled_date) DESC",
        [staffId, from, to]
      );
      const deliveries = deliveriesResult[0];

      const paymentsResult = await db.query(
        "SELECT cp.payment_id, cp.sale_id, cp.amount, cp.payment_method, " +
        "cp.reference_no, cp.payment_date, " +
        "(SELECT MIN(d2.delivery_id) FROM deliveries d2 WHERE d2.sale_id = cp.sale_id AND d2.is_archived = FALSE) AS delivery_id, " +
        "COALESCE(NULLIF(c.full_name, ''), 'Walk-in') AS customer_name " +
        "FROM credit_payments cp " +
        "LEFT JOIN customers c ON c.customer_id = cp.customer_id " +
        "WHERE cp.received_by_staff_id = ? " +
        "AND DATE(cp.payment_date) BETWEEN ? AND ? " +
        "ORDER BY cp.payment_date DESC",
        [staffId, from, to]
      );
      const payments = paymentsResult[0];

      // money owed is counted only against the driver actually carrying the order
      const openResult = await db.query(
        "SELECT COUNT(*) AS cod_count, " +
        "COALESCE(SUM(GREATEST(s.amount_due - s.amount_paid, 0)), 0) AS cod_due " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "WHERE d.is_archived = FALSE " +
        "AND d.delivery_staff_id = ? " +
        "AND s.payment_status <> 'Paid'",
        [staffId]
      );
      const openRows = openResult[0];
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

module.exports = { registerDeliveryRoutes: registerDeliveryRoutes };
