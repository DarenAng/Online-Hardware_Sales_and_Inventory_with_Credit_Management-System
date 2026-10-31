const helpers = require("../helpers");
const deliveryProcedures = require("../database/procedures/delivery-procedures");
const cleanPaymentDetails = require("../payment-details").cleanPaymentDetails;

function registerDeliveryRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const writeAuditLog = deps.writeAuditLog;
  const publishChange = deps.publishChange;
  const isDateText = deps.isDateText;
  const DELIVERY_CONTACT_SQL = deps.DELIVERY_CONTACT_SQL;
  const DELIVERY_PHONE_SQL = deps.DELIVERY_PHONE_SQL;
  const qrPayments = deps.qrPayments;

  const FULFILMENT_SQL =
    "\n  CASE" +
    "\n    WHEN d.status <> 'Delivered' THEN d.status" +
    "\n    WHEN GREATEST(s.amount_due - s.amount_paid, 0) > 0 THEN 'Pending Payment'" +
    "\n    ELSE 'Completed'" +
    "\n  END";

  // How many times the driver has tried this delivery (delivered or failed)
  const ATTEMPT_COUNT_SQL =
    "(SELECT COUNT(*) FROM delivery_attempts da WHERE da.delivery_id = d.delivery_id)";

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
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.address_street, d.address_barangay, d.address_city, d.address_province, d.address_landmark, " +
        "d.scheduled_date, d.created_date, d.delivered_at, d.updated_at, d.delivery_staff_id, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        DELIVERY_PHONE_SQL + " AS customer_phone, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name, " +
        ATTEMPT_COUNT_SQL + " AS attempt_count, " +
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

  // Failed deliveries that are waiting for a new date (manager and inventory clerk)
  app.get("/api/deliveries/failed", async function (request, response) {
    try {
      const result = await db.query(
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.scheduled_date, d.created_date, d.delivered_at, d.updated_at, d.delivery_staff_id, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        DELIVERY_PHONE_SQL + " AS customer_phone, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name, " +
        ATTEMPT_COUNT_SQL + " AS attempt_count, " +
        "COALESCE((SELECT MAX(da.attempted_at) FROM delivery_attempts da " +
        "WHERE da.delivery_id = d.delivery_id AND da.outcome = 'Failed'), d.updated_at) AS failed_on, " +
        "s.final_amount, s.amount_due, s.amount_paid, s.payment_method, s.payment_status, " +
        "GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due " +
        "FROM deliveries d " +
        "JOIN sales s ON s.sale_id = d.sale_id " +
        "LEFT JOIN customers c ON c.customer_id = s.customer_id " +
        "LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id " +
        "WHERE d.is_archived = FALSE AND d.status = 'Failed' " +
        "ORDER BY failed_on DESC"
      );
      const rows = result[0];
      response.json(rows);
    } catch (error) {
      console.error("Failed deliveries failed:", error.message);
      response.status(500).json({ error: "Unable to read the failed deliveries" });
    }
  });

  app.get("/api/deliveries/:deliveryId/attempts", async function (request, response) {
    try {
      const result = await db.query(
        "SELECT da.attempt_no, da.outcome, da.reason, da.attempted_at, da.scheduled_date, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name " +
        "FROM delivery_attempts da " +
        "LEFT JOIN staff st ON st.staff_id = da.staff_id " +
        "WHERE da.delivery_id = ? " +
        "ORDER BY da.attempt_no",
        [request.params.deliveryId]
      );
      const rows = result[0];
      response.json(rows);
    } catch (error) {
      console.error("Delivery attempts failed:", error.message);
      response.status(500).json({ error: "Unable to read the delivery attempts" });
    }
  });

  // Give a failed delivery a new date and driver, and put it back to Pending
  app.post("/api/deliveries/:deliveryId/reschedule", async function (request, response) {
    const deliveryId = Number(request.params.deliveryId);
    const newDate = String(request.body.scheduledDate || "").trim();
    const driverId = request.body.driverStaffId ? Number(request.body.driverStaffId) : null;
    if (driverId !== null && !Number.isInteger(driverId)) {
      return response.status(400).json({ error: "That driver is not valid." });
    }

    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(newDate);
    const newTime = match ? new Date(match[1] + "T" + match[2]) : null;
    if (!match || isNaN(newTime.getTime())) {
      return response.status(400).json({ error: "Pick the new date and time of the delivery." });
    }
    const scheduled = match[1] + " " + match[2] + (match[3] || ":00");
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    if (newTime < oneMinuteAgo) {
      return response.status(400).json({ error: "The new date cannot be in the past." });
    }

    try {
      const rowsResult = await db.query(
        "SELECT status FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
        [deliveryId]
      );
      const rows = rowsResult[0];
      if (rows.length === 0) {
        return response.status(404).json({ error: "Delivery not found" });
      }
      if (rows[0].status !== "Failed") {
        return response.status(409).json({ error: "Only a failed delivery can be given a new date." });
      }

      let driverName = "no driver yet";
      if (driverId) {
        const driversResult = await db.query(
          "SELECT st.full_name FROM staff st " +
          "JOIN roles r ON r.role_id = st.role_id " +
          "WHERE st.staff_id = ? AND r.role_name = 'Delivery Personnel' " +
          "AND st.is_active = TRUE AND st.archived_at IS NULL",
          [driverId]
        );
        if (driversResult[0].length === 0) {
          return response.status(400).json({ error: "That driver is not an active delivery staff member." });
        }
        driverName = driversResult[0][0].full_name;
      }

      const updateResult = await db.query(
        "UPDATE deliveries SET status = 'Pending', scheduled_date = ?, delivery_staff_id = ? " +
        "WHERE delivery_id = ? AND status = 'Failed'",
        [scheduled, driverId, deliveryId]
      );
      if (updateResult[0].affectedRows === 0) {
        return response.status(409).json({ error: "This delivery is no longer failed." });
      }

      await writeAuditLog(request, "UPDATE_DELIVERY_SCHEDULE",
        "Delivery " + helpers.deliveryCode(deliveryId) + " given a new date, " + scheduled + ", with " + driverName,
        { delivery_id: deliveryId });

      let who = ", unassigned.";
      if (driverId) who = ", with " + driverName + ".";
      try {
        await db.query(
          "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id) " +
          "SELECT role_id, 'Delivery', ?, ?, ? FROM roles WHERE role_name = 'Delivery Personnel'",
          ["Delivery " + helpers.deliveryCode(deliveryId) + " rescheduled",
           "Delivery " + helpers.deliveryCode(deliveryId) + " is back on the list for " + scheduled.slice(0, 16) + who,
           getActorId(request)]
        );
      } catch (error) {
        console.error("The delivery was rescheduled, but telling the drivers failed:", error.message);
      }

      const origin = request.headers["x-client-id"] || null;
      publishChange("notifications", "delivery rescheduled " + deliveryId, origin);

      response.json({ message: "Delivery " + helpers.deliveryCode(deliveryId) + " is Pending again, for " + scheduled.slice(0, 16) + "." });
    } catch (error) {
      console.error("Reschedule failed:", error.message);
      response.status(500).json({ error: "Unable to reschedule the delivery" });
    }
  });

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

  app.get("/api/delivery/list", async function (request, response) {
    const staffId = request.actor.staffId;

    try {
      const result = await db.query(
        "SELECT d.delivery_id, d.sale_id, d.status, d.delivery_address, d.remarks, d.cashier_remarks, " +
        "d.address_street, d.address_barangay, d.address_city, d.address_province, d.address_landmark, " +
        "d.scheduled_date, d.created_date, d.delivered_at, d.updated_at, d.delivery_staff_id, " +
        DELIVERY_CONTACT_SQL + " AS customer_name, " +
        DELIVERY_PHONE_SQL + " AS customer_phone, " +
        "COALESCE(st.full_name, 'Unassigned') AS driver_name, " +
        ATTEMPT_COUNT_SQL + " AS attempt_count, " +
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

      response.json({ message: "Delivery " + helpers.deliveryCode(deliveryId) + " is now yours." });
    } catch (error) {
      console.error("Delivery claim failed:", error.message);
      response.status(500).json({ error: "Unable to take the delivery" });
    }
  });

  const PAYMENT_METHODS = ["Cash", "GCash", "PayMaya", "Cheque", "Bank Transfer"];
  const QR_METHODS = ["GCash", "PayMaya", "Bank Transfer"];

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
    const amount = Math.round(Number(request.body.amount) * 100) / 100;
    if (!(amount > 0)) {
      return response.status(400).json({ error: "The amount received has to be more than zero." });
    }
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return response.status(400).json({ error: "Pick how the customer paid: " + PAYMENT_METHODS.join(", ") + "." });
    }
    const qrPaymentId = request.body.qrPaymentId;
    if (paymentMethod === "Bank Transfer" && !qrPaymentId) {
      return response.status(400).json({ error: "A bank transfer is taken only by its QR code. Press Pay by QR." });
    }
    if (qrPaymentId && !QR_METHODS.includes(paymentMethod)) {
      return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash, PayMaya or bank transfer." });
    }
    if (referenceNo.length > 60) {
      return response.status(400).json({ error: "A reference is at most 60 characters." });
    }

    let payDetails = null;
    if (paymentMethod === "Cheque") {
      const cleaned = cleanPaymentDetails(paymentMethod, request.body.paymentDetails);
      if (cleaned.problem) {
        return response.status(400).json({ error: cleaned.problem });
      }
      payDetails = JSON.stringify(cleaned.details);
    }

    let qr = null;
    let recorded = false;
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
      if (Number(rows[0].delivery_staff_id) !== Number(request.actor.staffId)) {
        return response.status(403).json({ error: "Take this delivery before collecting on it." });
      }

      const saleId = rows[0].sale_id;

      if (qrPaymentId) {
        try {
          qr = await qrPayments.verifyForMoney(qrPaymentId, amount, paymentMethod, getActorId(request),
            request.body.paymentDetails);
        } catch (error) {
          if (!(error instanceof qrPayments.QrPaymentError)) throw error;
          return response.status(error.status).json({ error: error.message, code: error.code });
        }
        referenceNo = qr.reference || "";
      }

      const output = await deliveryProcedures.recordCreditPayment(
        [saleId, amount, paymentMethod, referenceNo || null, getActorId(request), qr ? qr.id : null, payDetails]
      );

      if (output.status_code !== 200) {
        let code;
        if (qr) code = await qrPayments.recordUnsaved(qr.id, getActorId(request));
        return response.status(output.status_code).json({ error: output.message, code: code || undefined });
      }
      recorded = true;
      if (qr) qrPayments.announceUsed(qr.id);

      const deliveryId = Number(request.params.deliveryId);
      let sale = null;
      try {
        const saleResult = await db.query(
          "SELECT s.payment_status, s.amount_paid, GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due, " +
          "(SELECT full_name FROM staff WHERE staff_id = ?) AS driver_name " +
          "FROM sales s WHERE s.sale_id = ?",
          [request.actor.staffId, saleId]
        );
        sale = saleResult[0][0];

        let driverName = "the driver";
        if (sale && sale.driver_name) driverName = sale.driver_name;

        const title = "Payment collected on delivery " + helpers.deliveryCode(deliveryId) + ": " + pesoText(amount) +
                      " by " + driverName;
        let message = paymentMethod + " payment of " + pesoText(amount) +
                      " on " + helpers.orNumber(saleId) + ".";
        if (referenceNo !== "") {
          message += " Reference " + referenceNo + ".";
        }
        if (sale && Number(sale.balance_due) > 0) {
          message += " " + pesoText(sale.balance_due) + " is still owed.";
        } else if (sale) {
          message += " The sale is now paid in full.";
        }

        await db.query(
          "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id) " +
          "SELECT role_id, 'Delivery', ?, ?, ? FROM roles WHERE role_name IN ('Cashier', 'Manager')",
          [title.slice(0, 150), message, getActorId(request)]
        );
      } catch (error) {
        console.error("The delivery payment was recorded, but telling the cashier failed:", error.message);
      }

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
      if (qr && !recorded) await qrPayments.recordUnsaved(qr.id, getActorId(request));
      if (!response.headersSent) response.status(500).json({ error: "Unable to record the payment" });
    } finally {
      if (qr) qr.release();
    }
  });

  app.get("/api/delivery/summary", async function (request, response) {
    const staffId = request.actor.staffId;

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
