// ============================================================
// cashier.js -- Cashier module (the till)
// Loaded by: server.js only (from the routes folder). Never sent to a browser.
//
// Routes in this file:
//   GET   /api/sales                       the list of sales, with filters (a cashier gets only their own); days=3 for the past three days
//   POST  /api/sales                       ring up a new sale
//   POST  /api/deliveries                  create a delivery for a sale
//   PATCH /api/deliveries/:id/status       move a delivery to its next status
//   GET   /api/sales/undelivered           sales that have no delivery yet
//   GET   /api/cashier/summary             the cashier's end-of-shift numbers
//   GET   /api/sales/:id                   one sale in full
//   POST  /api/sales/:id/payment           credit settlement: take a payment on a sale that still owes money (the answer carries the receipt)
//
// GCash, PayMaya or a bank transfer paid by QR code arrives with a QR payment
// id. It is checked again with the provider (qr-payments.js) before anything
// is recorded, and is used once: its payment id becomes the sale's reference.
// A bank transfer is only ever taken this way (verified through PayMongo).
//
// A cheque arrives with its account name, account number, bank, branch and date
// (paymentDetails, checked by payment-details.js). They are saved with the money,
// in the same transaction, by the procedures (payment_details table).
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in access-control.js have already checked the user's role before any of
// these routes run.
// ============================================================

const cashierProcedures = require("../database/procedures/cashier-procedures");
const helpers = require("../helpers");
const tidy = helpers.tidy;
const buildFullAddress = helpers.buildFullAddress;
const addressPartsFrom = helpers.addressPartsFrom;
const addressPartsProblem = helpers.addressPartsProblem;
const cleanPaymentDetails = require("../payment-details").cleanPaymentDetails;

// Where a delivery can go from each status: one step at a time. Delayed and
// Failed can only happen once the delivery is Out for Delivery; a Delayed
// delivery goes back out or fails. The browser has the same list
// (NEXT_DELIVERY_STATUS in scripts/shared/deliveries.js) to pick the buttons.
const NEXT_DELIVERY_STATUS = {
  "Pending":          ["In Transit"],
  "In Transit":       ["Out for Delivery"],
  "Out for Delivery": ["Delivered", "Delayed", "Failed"],
  "Delayed":          ["Out for Delivery", "Failed"],
  "Failed":           ["Pending"],
  "Delivered":        []
};
const ALL_DELIVERY_STATUSES = Object.keys(NEXT_DELIVERY_STATUS);

// the methods a customer can pay by scanning the QR code (a bank transfer opens
// the customer's bank page instead of a wallet)
const QR_METHODS = ["GCash", "PayMaya", "Bank Transfer"];

// said when a bank transfer is sent without a PayMongo payment behind it
const TRANSFER_BY_QR_ONLY =
  "A bank transfer is taken through PayMongo: use Pay by Bank Transfer, and the customer approves " +
  "it in their bank. Nothing was recorded.";

function registerCashierRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const DRIVER = deps.DRIVER;
  const CASHIER = deps.CASHIER;
  const isDateText = deps.isDateText;
  const SALE_CUSTOMER_SQL = deps.SALE_CUSTOMER_SQL;
  const phoneComplaint = deps.phoneComplaint;
  const cleanPhone = deps.cleanPhone;
  const qrPayments = deps.qrPayments;

  // ==========================================
  // THE SALES LIST
  //
  // Two derived filters: PAYMENT GROUP (the four electronic methods answer as
  // one) and TRANSACTION STATUS, which follows payment_status directly:
  //   Voided           archived; it did not happen
  //   Paid             nothing is owed on it
  //   Partially Paid   some money taken, the rest still owed
  //   Unpaid           nothing taken yet
  // Where the goods are (a delivery on the road) is the sale's delivery status.
  // ==========================================
  const SALE_STATUS_SQL = "\n  CASE\n" +
    "    WHEN s.is_archived = TRUE THEN 'Voided'\n" +
    "    WHEN s.payment_status = 'Paid' THEN 'Paid'\n" +
    "    WHEN s.payment_status = 'Partial' THEN 'Partially Paid'\n" +
    "    ELSE 'Unpaid'\n" +
    "  END";

  const PAYMENT_GROUP_SQL = "\n  CASE\n" +
    "    WHEN s.payment_method IN ('GCash','PayMaya','PayPal','Bank Transfer') THEN 'Online Payment'\n" +
    "    ELSE s.payment_method\n" +
    "  END";

  app.get("/api/sales", async function (request, response) {
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

    // days=3 is the Refunds screen's list: today and the two days before.
    // Only that exact list (not voided sales) is shown for every cashier.
    const days = parseInt(request.query.days, 10);
    const recentList = days === 3 && status === "all";

    // A cashier's Sales Report is their own sales and no one else's: the staff
    // id comes from the session, never from the request, so a query string
    // cannot widen it. The manager's view of every sale is unchanged. (One
    // sale is still opened by its number, GET /api/sales/:id, from a refund
    // or a customer's card, whoever rang it up.) The Refunds screen's
    // recent list shows every cashier's sales, since a customer may bring a
    // refund to any counter.
    if (request.actor && request.actor.roleName === CASHIER && !recentList) {
      where.push("s.cashier_staff_id = ?");
      params.push(request.actor.staffId);
    }

    if (method !== "all") {
      where.push(PAYMENT_GROUP_SQL + " = ?");
      params.push(method);
    }

    if (status !== "all" && status !== "Voided") {
      where.push(SALE_STATUS_SQL + " = ?");
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
        error: "Sales only go up to today (" + today + "); " + future + " has not happened yet."
      });
    }

    if (isDateText(from)) { where.push("s.sale_date >= ?"); params.push(from + " 00:00:00"); }
    if (isDateText(to))   { where.push("s.sale_date <= ?"); params.push(to + " 23:59:59"); }

    // days=3 means today and the two days before it. CURDATE() is the
    // database's own date, so the days follow the time zone the server set.
    if (recentList) {
      where.push("s.sale_date >= CURDATE() - INTERVAL ? DAY");
      params.push(days - 1);
    }

    try {
      const rowsResult = await db.query(
        "SELECT s.sale_id, s.sale_date, s.total_amount, s.discount, s.final_amount,\n" +
          "              s.amount_paid, s.change_given, s.payment_method, s.payment_status, s.reference_no,\n" +
          "              s.cashier_staff_id, s.is_archived, s.refunded_amount,\n" +
          "              GREATEST(s.amount_due - s.amount_paid, 0) AS balance_due,\n" +
          "              " + PAYMENT_GROUP_SQL + " AS payment_group,\n" +
          "              " + SALE_STATUS_SQL + " AS transaction_status,\n" +
          "              d.delivery_id, d.status AS delivery_status,\n" +
          "              " + SALE_CUSTOMER_SQL + " AS customer_name,\n" +
          "              st.full_name AS cashier_name,\n" +
          "              DATE(s.sale_date) = CURDATE() AS is_today,\n" +
          "              (SELECT vr.request_id FROM void_requests vr\n" +
          "                WHERE vr.sale_id = s.sale_id AND vr.status = 'Pending' LIMIT 1) AS void_request_id,\n" +
          "              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count,\n" +
          // everything refunded or returned on the sale, including the cash handed back
          // (refunded_amount above is only the part that came off what the customer owed)
          "              (SELECT COALESCE(SUM(r.refund_amount), 0) FROM returned_items r\n" +
          "                WHERE r.sale_id = s.sale_id AND r.report_type IN ('Refunded', 'Return')) AS returned_total\n" +
          "       FROM sales s\n" +
          "       LEFT JOIN customers c ON c.customer_id = s.customer_id\n" +
          "       JOIN staff st ON st.staff_id = s.cashier_staff_id\n" +
          "       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE\n" +
          "       WHERE " + where.join(" AND ") + "\n" +
          "       ORDER BY s.sale_date DESC, s.sale_id DESC",
        params
      );
      const rows = rowsResult[0];
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
  // and it is traced by its number: a cheque by the cheque number (with its
  // account, bank and date, below). A bank transfer needs none typed: its
  // reference is PayMongo's own payment number. The e-wallets print a
  // reference too, taken when the cashier has it.
  // A sale asks for no reference now (a cheque is traced by its account, bank
  // and date; an e-wallet is paid by QR code). One sent is still kept.
  const REFERENCE_REQUIRED = [];
  const REFERENCE_OPTIONAL = ["Cheque", "GCash", "PayMaya", "PayPal"];

  // Ring up a sale. The procedure deducts stock, checks the limit and standing,
  // and decides paid, part paid or on account. downPaymentMethod is how the
  // money on a Credit sale actually arrived.
  app.post("/api/sales", async function (request, response) {
    const customerId = request.body.customerId;
    const walkInName = request.body.walkInName;
    const discount = request.body.discount;
    const amountPaid = request.body.amountPaid;
    const paymentMethod = request.body.paymentMethod;
    const items = request.body.items;
    const downPaymentMethod = request.body.downPaymentMethod;
    const referenceNo = request.body.referenceNo;
    const qrPaymentId = request.body.qrPaymentId;
    const typedDetails = request.body.paymentDetails;

    if (!paymentMethod || !Array.isArray(items) || items.length === 0) {
      return response.status(400).json({ error: "A payment method and at least one item are required" });
    }

    // a negative discount would raise the bill above the item prices; refused
    // before any QR payment below is checked or spent on it
    if (Number(discount) < 0) {
      return response.status(400).json({ error: "Discount cannot be negative." });
    }

    // A product with no price yet (price 0: the clerk added it and the manager
    // has not priced it) cannot be sold. Refused before any QR payment below
    // is checked or spent on it.
    const ids = [];
    for (let i = 0; i < items.length; i++) {
      const id = Number(items[i] && items[i].product_id);
      if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) {
      try {
        const marks = ids.map(function () { return "?"; }).join(", ");
        const unpricedResult = await db.query(
          "SELECT product_name FROM products WHERE product_id IN (" + marks + ") " +
          "AND (price IS NULL OR price <= 0) ORDER BY product_name", ids);
        const unpriced = unpricedResult[0];
        if (unpriced.length > 0) {
          const names = unpriced.map(function (row) { return row.product_name; }).join(", ");
          return response.status(400).json({
            error: names + (unpriced.length === 1 ? " has" : " have") +
                   " no price yet, so it cannot be sold. Ask the manager to set the price."
          });
        }
      } catch (error) {
        console.error("Checking the item prices failed:", error.message);
        return response.status(500).json({ error: "Unable to check the item prices" });
      }
    }

    // A walk-in is a sale with no customer and no name. A name is only ever a
    // customer picked from the customer list, sent as customerId: a bare name
    // opens no account at the till any more, so it is refused here, before any
    // QR payment below is checked or spent on it.
    let typedName = "";
    if (typeof walkInName === "string") {
      typedName = walkInName.trim();
    }
    if (typedName !== "" && !customerId) {
      return response.status(400).json({
        error: "\"" + typedName.slice(0, 80) + "\" is not a customer on record. " +
               "Add them under Customers Record first, then pick them from the list " +
               "(or leave the customer empty for a walk-in)."
      });
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
      let what = "A " + takenNow.toLowerCase() + " sale";
      if (paymentMethod === "Credit") {
        what = "The part payment is by " + takenNow.toLowerCase() + ", so it";
      }

      return response.status(400).json({
        error: what + " needs its reference: the cheque number. " +
               "It is how the money is traced if it does not arrive."
      });
    }
    if (reference.length > 60) {
      return response.status(400).json({ error: "A reference is at most 60 characters." });
    }

    // A cheque is recorded with the account name and number printed on it, the
    // bank, its branch and the date written on it. Refused before any QR payment
    // below is checked or spent on it.
    let payDetails = null;
    if (takenNow === "Cheque") {
      const cleaned = cleanPaymentDetails("Cheque", typedDetails);
      if (cleaned.problem) {
        return response.status(400).json({ error: cleaned.problem });
      }
      payDetails = JSON.stringify(cleaned.details);
    }

    // a bank transfer is verified through PayMongo, so it has a QR payment behind it
    if (takenNow === "Bank Transfer" && !qrPaymentId) {
      return response.status(400).json({ error: TRANSFER_BY_QR_ONLY });
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
        return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash, PayMaya or bank transfer." });
      }
      try {
        qr = await qrPayments.verifyForMoney(qrPaymentId, Number(amountPaid) || 0, takenNow, getActorId(request), typedDetails);
      } catch (error) {
        if (!(error instanceof qrPayments.QrPaymentError)) throw error;
        return response.status(error.status).json({ error: error.message, code: error.code });
      }
      // the payment's own number, whatever was typed
      keptReference = qr.reference || "";
    }
    let saleId = null;

    try {
      const output = await cashierProcedures.recordSale(
        [customerId || null, null, getActorId(request), discount || 0, amountPaid || 0,
         paymentMethod, JSON.stringify(items), downMethod, qr ? qr.id : null, payDetails]
      );

      if (output.status_code !== 200) {
        // Refused (an item ran out) after the customer paid: the row stays
        // paid and says a refund is owed, written before the till is answered.
        // The payment can still be used on the next try.
        let code;
        if (qr) code = await qrPayments.recordUnsaved(qr.id, getActorId(request));
        return response.status(output.status_code).json({ error: output.message, code: code || undefined });
      }
      saleId = output.sale_id;
      // the procedure has tied the QR payment to the sale in its own transaction;
      // this only tells the open QR Payments screens
      if (qr) qrPayments.announceUsed(qr.id);

      // The sale exists by now and is not undone over its reference: a failure
      // here is said on the screen, and the invoice prints without it.
      let referenceNote = null;
      if (keptReference !== "") {
        try {
          const saved = await cashierProcedures.setSaleReference(
            [output.sale_id, keptReference, getActorId(request)]
          );
          if (saved.status_code === 500) {
            // callProcedure already logged why; the screen is told what still stands
            referenceNote = "The sale was saved, but its reference was not. Write it on the invoice by hand.";
          } else if (saved.status_code !== 200) {
            referenceNote = saved.message;
          }
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

    if (isDateText(text)) return text + " 00:00:00";

    return null;
  }

  // the drivers a cashier can hand a delivery to when creating it
  app.get("/api/deliveries/drivers", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT st.staff_id, st.full_name\n" +
          "       FROM staff st\n" +
          "       JOIN roles r ON r.role_id = st.role_id\n" +
          "       WHERE r.role_name = ? AND st.is_active = TRUE AND st.archived_at IS NULL\n" +
          "       ORDER BY st.full_name",
        [DRIVER]
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Drivers list failed:", error.message);
      response.status(500).json({ error: "Unable to read the drivers" });
    }
  });

  app.post("/api/deliveries", async function (request, response) {
    const saleId = request.body.saleId;
    const typedAddress = request.body.address;
    const scheduledDate = request.body.scheduledDate;
    const remarks = request.body.remarks;
    const contactName = request.body.contactName;
    const contactPhone = request.body.contactPhone;
    // the driver who will deliver it: required
    const driverId = request.body.driverStaffId ? Number(request.body.driverStaffId) : null;

    if (!saleId) {
      return response.status(400).json({ error: "A sale is required" });
    }
    if (!driverId) {
      return response.status(400).json({ error: "Pick the driver who will deliver it." });
    }

    // The address comes in parts (house and street, barangay, town or city,
    // province, landmark). A caller that sends only the single line is still
    // taken (many spaces become one), so nothing older breaks.
    const parts = addressPartsFrom(request.body);
    const partsGiven = parts.street !== "" || parts.barangay !== "" || parts.city !== "" || parts.province !== "";

    let address;
    if (partsGiven) {
      if (tidy(contactName) === "") {
        return response.status(400).json({ error: "Enter the recipient's name: the person the driver asks for." });
      }
      const problem = addressPartsProblem(parts, "delivery address");
      if (problem) return response.status(400).json({ error: problem });
      address = buildFullAddress(parts);
    } else {
      address = tidy(typedAddress);
      if (address.length < 5 || address.length > 255) {
        return response.status(400).json({
          error: "Enter the delivery address: house no., street, barangay, town or city, province."
        });
      }
    }
    if (String(remarks || "").length > 255) {
      return response.status(400).json({ error: "The remarks are at most 255 characters." });
    }

    if (!String(contactPhone || "").trim()) {
      return response.status(400).json({ error: "A delivery needs a phone number the driver can call" });
    }
    const phoneProblem = phoneComplaint(contactPhone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    if (!String(scheduledDate || "").trim()) {
      return response.status(400).json({ error: "Pick the date and time of the delivery." });
    }
    const scheduled = toMysqlDateTime(scheduledDate);

    // a schedule typed but not understood must not become "unscheduled" silently
    if (scheduledDate && !scheduled) {
      return response.status(400).json({
        error: "The scheduled date and time could not be read. Use the picker rather than typing it."
      });
    }

    // trimmed and cut to the size of the database column; empty becomes null
    const contact = tidy(contactName).slice(0, 150) || null;
    const phone = cleanPhone(contactPhone);

    try {
      // checked before the delivery is made, so a bad pick never leaves a half-made delivery
      let driverName = null;
      if (driverId) {
        const driversResult = await db.query(
          "SELECT st.full_name FROM staff st\n" +
            "         JOIN roles r ON r.role_id = st.role_id\n" +
            "         WHERE st.staff_id = ? AND r.role_name = ? AND st.is_active = TRUE AND st.archived_at IS NULL",
          [driverId, DRIVER]
        );
        const drivers = driversResult[0];
        if (drivers.length === 0) {
          return response.status(400).json({ error: "That driver is not an active delivery staff member." });
        }
        driverName = drivers[0].full_name;
      }

      // dated the day the order was taken: the sale's own date
      const saleRowsResult = await db.query(
        "SELECT DATE_FORMAT(sale_date, '%Y-%m-%d') AS sale_day, customer_id FROM sales WHERE sale_id = ?",
        [saleId]
      );
      const saleRows = saleRowsResult[0];
      let orderDay = null;
      if (saleRows.length > 0) {
        orderDay = saleRows[0].sale_day;

        // a delivery is for a customer on record: the driver collects and the
        // balance is kept against an account, so a walk-in sale cannot have one
        if (saleRows[0].customer_id === null) {
          return response.status(400).json({
            error: "A delivery is for a customer on record. Put this sale under a customer first."
          });
        }

        // the name, number and address sent are the sale's customer's: the browser
        // names that customer, and it has to be the one the sale was rung up for
        if (Number(request.body.customerId) !== Number(saleRows[0].customer_id)) {
          return response.status(400).json({
            error: "The delivery is for a different customer than the sale. Pick the sale's customer as the recipient."
          });
        }
      }

      const output = await cashierProcedures.createDelivery(
        [saleId, address, scheduled, remarks || null, contact, phone, orderDay, getActorId(request), driverId]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // The delivery exists, with the whole address as one line. The parts go in
      // their own columns now; if that fails the delivery still stands and every
      // screen still reads the line, so it is only logged.
      if (partsGiven) {
        try {
          await db.query(
            "UPDATE deliveries SET address_street = ?, address_barangay = ?, address_city = ?, " +
            "address_province = ?, address_landmark = ? WHERE delivery_id = ?",
            [parts.street || null, parts.barangay, parts.city, parts.province, parts.landmark || null, output.delivery_id]
          );
        } catch (error) {
          console.error("Saving the delivery address parts failed:", error.message);
        }
      }

      // the procedure keeps the cashier's note apart from the later status notes
      // and assigns the driver in the same transaction as the delivery itself

      response.json({
        message: driverId
          ? "Delivery #" + output.delivery_id + " created and assigned to " + driverName + "."
          : "Delivery #" + output.delivery_id + " created.",
        deliveryId: output.delivery_id
      });
    } catch (error) {
      console.error("Create delivery failed:", error.message);
      response.status(500).json({ error: "Unable to create the delivery" });
    }
  });

  // The one route that moves a delivery; the procedure decides what each role may do.
  app.patch("/api/deliveries/:deliveryId/status", async function (request, response) {
    const status = request.body.status;
    const remarks = request.body.remarks;
    const actor = request.actor;

    if (!status) {
      return response.status(400).json({ error: "A status is required" });
    }

    // a delay has to say why: the reason is saved as the delivery's remarks
    if (status === "Delayed" && String(remarks || "").trim().length < 5) {
      return response.status(400).json({ error: "Say why the delivery is delayed (at least 5 characters)." });
    }

    try {
      const rowsResult = await db.query(
        "SELECT status, delivery_staff_id FROM deliveries WHERE delivery_id = ? AND is_archived = FALSE",
        [request.params.deliveryId]
      );
      const rows = rowsResult[0];
      if (rows.length === 0) {
        return response.status(404).json({ error: "Delivery not found" });
      }
      const delivery = rows[0];

      // a driver moves only a delivery they took (POST /api/delivery/:id/claim)
      if (actor.roleName === DRIVER) {
        if (delivery.delivery_staff_id === null) {
          return response.status(409).json({ error: "Take this delivery before updating it." });
        }
        if (Number(delivery.delivery_staff_id) !== Number(actor.staffId)) {
          return response.status(403).json({ error: "This delivery is assigned to another driver." });
        }
      }

      // One step at a time. The same status again, a status that does not
      // exist and a delivery that is already Delivered are left to the
      // procedure, which has its own message for each.
      const nextSteps = NEXT_DELIVERY_STATUS[delivery.status];
      if (nextSteps && nextSteps.length > 0 && status !== delivery.status
          && ALL_DELIVERY_STATUSES.includes(status) && !nextSteps.includes(status)) {
        return response.status(400).json({
          error: "A delivery cannot go from " + delivery.status + " to " + status + ". " +
                 "From " + delivery.status + " it can go to: " + nextSteps.join(", ") + "."
        });
      }

      const output = await cashierProcedures.updateDeliveryStatus(
        [request.params.deliveryId, status, remarks || null, actor.staffId, actor.roleId]
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

  app.get("/api/sales/undelivered", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT s.sale_id, s.final_amount, s.sale_date, s.payment_method,\n" +
          "              " + SALE_CUSTOMER_SQL + " AS customer_name,\n" +
          "              COALESCE(c.address, '') AS customer_address\n" +
          "       FROM sales s\n" +
          "       LEFT JOIN customers c ON c.customer_id = s.customer_id\n" +
          "       LEFT JOIN deliveries d ON d.sale_id = s.sale_id AND d.is_archived = FALSE\n" +
          "       WHERE s.is_archived = FALSE AND d.delivery_id IS NULL\n" +
          "       ORDER BY s.sale_id DESC\n" +
          "       LIMIT 60"
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      console.error("Undelivered sales failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // End of shift: one cashier, one day (today by default), every figure bounded
  // by DATE(sale_date). Refunds come back line by line.
  app.get("/api/cashier/summary", async function (request, response) {
    // the session's shift, always; a staff id in the URL is ignored
    const staffId = request.actor.staffId;

    // an unreadable date means today (null = today in the SQL below)
    let day = null;
    if (isDateText(request.query.date)) {
      day = request.query.date;
    }

    try {
      const totalRowsResult = await db.query(
        // collected is what stayed in the drawer, not amount_paid (which includes the note they broke)
        "SELECT COUNT(*) AS sale_count,\n" +
          "              COALESCE(SUM(final_amount), 0) AS gross,\n" +
          "              COALESCE(SUM(discount), 0) AS discounts,\n" +
          "              COALESCE(SUM(LEAST(amount_paid, final_amount)), 0) AS collected\n" +
          "       FROM sales\n" +
          "       WHERE cashier_staff_id = ? AND is_archived = FALSE\n" +
          "         AND DATE(sale_date) = COALESCE(?, CURDATE())",
        [staffId, day]
      );
      const totalRows = totalRowsResult[0];
      const totals = totalRows[0];

      const methodsResult = await db.query(
        "SELECT payment_method, COUNT(*) AS sale_count, COALESCE(SUM(final_amount), 0) AS total_amount\n" +
          "       FROM sales\n" +
          "       WHERE cashier_staff_id = ? AND is_archived = FALSE\n" +
          "         AND DATE(sale_date) = COALESCE(?, CURDATE())\n" +
          "       GROUP BY payment_method\n" +
          "       ORDER BY total_amount DESC",
        [staffId, day]
      );
      const methods = methodsResult[0];

      const refundRowsResult = await db.query(
        "SELECT COUNT(*) AS refund_count, COALESCE(SUM(refund_amount), 0) AS refund_total,\n" +
          "              COALESCE(SUM(quantity), 0) AS refund_items\n" +
          "       FROM returned_items\n" +
          "       WHERE reported_by_staff_id = ? AND report_type = 'Refunded'\n" +
          "         AND DATE(return_date) = COALESCE(?, CURDATE())",
        [staffId, day]
      );
      const refundRows = refundRowsResult[0];
      const refunds = refundRows[0];

      // what actually went back, capped
      const refundLinesResult = await db.query(
        "SELECT r.return_id, r.quantity, r.refund_amount, r.reason, r.disposition,\n" +
          "              r.return_date, r.sale_id,\n" +
          "              p.product_name, u.unit_name,\n" +
          "              CASE WHEN r.quantity > 0 THEN r.refund_amount / r.quantity ELSE r.refund_amount END\n" +
          "                AS unit_refund\n" +
          "       FROM returned_items r\n" +
          "       JOIN products p ON p.product_id = r.product_id\n" +
          "       LEFT JOIN units u ON u.unit_id = p.unit_id\n" +
          "       WHERE r.reported_by_staff_id = ? AND r.report_type = 'Refunded'\n" +
          "         AND DATE(r.return_date) = COALESCE(?, CURDATE())\n" +
          "       ORDER BY r.return_date DESC\n" +
          "       LIMIT 100",
        [staffId, day]
      );
      const refundLines = refundLinesResult[0];

      const stampRowsResult = await db.query(
        "SELECT COALESCE(?, CURDATE()) AS day", [day]
      );
      const stampRows = stampRowsResult[0];
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

  app.get("/api/sales/:saleId", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT s.*, " + SALE_CUSTOMER_SQL + " AS customer_name,\n" +
          "              DATE(s.sale_date) = CURDATE() AS is_today,\n" +
          "              c.phone AS customer_phone, c.address AS customer_address,\n" +
          "              st.full_name AS cashier_name,\n" +
          // everything refunded or returned on the sale (the cash handed back as well); the
          // sale's own refunded_amount is only the part that came off what the customer owed
          "              (SELECT COALESCE(SUM(r.refund_amount), 0) FROM returned_items r\n" +
          "                WHERE r.sale_id = s.sale_id AND r.report_type IN ('Refunded', 'Return')) AS returned_total\n" +
          "       FROM sales s\n" +
          "       LEFT JOIN customers c ON c.customer_id = s.customer_id\n" +
          "       JOIN staff st ON st.staff_id = s.cashier_staff_id\n" +
          "       WHERE s.sale_id = ?",
        [request.params.saleId]
      );
      const rows = rowsResult[0];

      if (rows.length === 0) {
        return response.status(404).json({ error: "Sale not found" });
      }

      // quantity and unit_name are what the customer was charged for (2 sacks);
      // base_quantity and base_unit are what left the shelf (50 kg).
      // refunded_quantity and refunded_amount are what has already been
      // refunded of this product on this sale, counted in base_unit (the
      // Refunds screen shows it beside each line).
      const itemsResult = await db.query(
        "SELECT COALESCE(si.sold_quantity, si.quantity) AS quantity,\n" +
          "              COALESCE(si.sold_unit, u.unit_name) AS unit_name,\n" +
          "              si.quantity AS base_quantity, u.unit_name AS base_unit,\n" +
          "              si.unit_price, si.subtotal, p.product_name, si.product_id,\n" +
          "              (SELECT COALESCE(SUM(r.quantity), 0) FROM returned_items r\n" +
          "                WHERE r.sale_id = si.sale_id AND r.product_id = si.product_id\n" +
          "                  AND r.report_type IN ('Refunded', 'Return')) AS refunded_quantity,\n" +
          "              (SELECT COALESCE(SUM(r.refund_amount), 0) FROM returned_items r\n" +
          "                WHERE r.sale_id = si.sale_id AND r.product_id = si.product_id\n" +
          "                  AND r.report_type IN ('Refunded', 'Return')) AS refunded_amount\n" +
          "       FROM sale_items si\n" +
          "       JOIN products p ON p.product_id = si.product_id\n" +
          "       LEFT JOIN units u ON u.unit_id = p.unit_id\n" +
          "       WHERE si.sale_id = ?",
        [request.params.saleId]
      );
      const items = itemsResult[0];

      const paymentsResult = await db.query(
        "SELECT cp.payment_id, cp.amount, cp.payment_method, cp.reference_no, cp.payment_date,\n" +
          "              st.full_name AS received_by\n" +
          "       FROM credit_payments cp\n" +
          "       LEFT JOIN staff st ON st.staff_id = cp.received_by_staff_id\n" +
          "       WHERE cp.sale_id = ?\n" +
          "       ORDER BY cp.payment_date",
        [request.params.saleId]
      );
      const payments = paymentsResult[0];

      const deliveryResult = await db.query(
        "SELECT d.delivery_id, d.status, d.delivery_address, d.scheduled_date, d.delivered_at, d.remarks, d.cashier_remarks,\n" +
          "              st.full_name AS driver_name\n" +
          "       FROM deliveries d\n" +
          "       LEFT JOIN staff st ON st.staff_id = d.delivery_staff_id\n" +
          "       WHERE d.sale_id = ?",
        [request.params.saleId]
      );
      const delivery = deliveryResult[0];

      // the GCash, Maya or bank-transfer codes paid towards this sale, with PayMongo's
      // reference and who took them (only paid ones: the rest are not payments)
      const qrPaidResult = await db.query(
        "SELECT q.qr_payment_id, q.status, q.amount, q.wallet, q.bank_name, q.purpose, q.provider, q.mode,\n" +
          "              q.provider_payment_id, q.paid_at, q.created_at, st.full_name AS received_by\n" +
          "         FROM qr_payments q\n" +
          "         LEFT JOIN staff st ON st.staff_id = q.created_by_staff_id\n" +
          "        WHERE q.sale_id = ? AND q.status = 'paid' ORDER BY q.qr_payment_id",
        [request.params.saleId]
      );
      const qrPaid = qrPaidResult[0];

      // the bank and account behind each cheque or bank transfer; payment_id says
      // which payment on the account it belongs to (null: the sale's own payment)
      const detailsResult = await db.query(
        "SELECT detail_id, payment_id, method, account_name, account_number, bank_name, branch,\n" +
          "              DATE_FORMAT(cheque_date, '%Y-%m-%d') AS cheque_date, qr_payment_id\n" +
          "         FROM payment_details WHERE sale_id = ? ORDER BY detail_id",
        [request.params.saleId]
      );

      // the latest request to void the sale (waiting, approved or declined), if any
      const voidResult = await db.query(
        "SELECT vr.request_id, vr.reason, vr.status, vr.requested_at, vr.decided_at, vr.decision_note,\n" +
          "       rq.full_name AS requested_by, dc.full_name AS decided_by\n" +
          "  FROM void_requests vr\n" +
          "  LEFT JOIN staff rq ON rq.staff_id = vr.requested_by_staff_id\n" +
          "  LEFT JOIN staff dc ON dc.staff_id = vr.decided_by_staff_id\n" +
          " WHERE vr.sale_id = ? ORDER BY vr.request_id DESC LIMIT 1",
        [request.params.saleId]
      );

      response.json({ sale: rows[0], items: items, payments: payments, delivery: delivery[0] || null,
                      qrPayments: qrPaid, paymentDetails: detailsResult[0],
                      voidRequest: voidResult[0][0] || null });
    } catch (error) {
      console.error("Sale detail failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/sales/:saleId/payment", async function (request, response) {
    const amount = request.body.amount;
    const paymentMethod = request.body.paymentMethod;
    const referenceNo = request.body.referenceNo;
    const qrPaymentId = request.body.qrPaymentId;
    const typedDetails = request.body.paymentDetails;

    if (!amount || !paymentMethod) {
      return response.status(400).json({ error: "Amount and payment method are required" });
    }

    // the same rules as a sale: a cheque comes with its account, bank and date,
    // and a bank transfer only through a PayMongo payment
    let reference = referenceNo || null;
    let payDetails = null;
    // the same as a sale, no reference is required: a cheque is traced by its
    // account, bank and date
    if (paymentMethod === "Cheque") {
      const cleaned = cleanPaymentDetails("Cheque", typedDetails);
      if (cleaned.problem) {
        return response.status(400).json({ error: cleaned.problem });
      }
      payDetails = JSON.stringify(cleaned.details);
    }
    if (paymentMethod === "Bank Transfer" && !qrPaymentId) {
      return response.status(400).json({ error: TRANSFER_BY_QR_ONLY });
    }

    // a QR payment is checked here and used once
    let qr = null;
    if (qrPaymentId) {
      if (!QR_METHODS.includes(paymentMethod)) {
        return response.status(400).json({ error: "A QR payment can only pay for money taken by GCash, PayMaya or bank transfer." });
      }
      try {
        qr = await qrPayments.verifyForMoney(qrPaymentId, Number(amount) || 0, paymentMethod, getActorId(request), typedDetails);
      } catch (error) {
        if (!(error instanceof qrPayments.QrPaymentError)) throw error;
        return response.status(error.status).json({ error: error.message, code: error.code });
      }
      reference = qr.reference;
    }
    let recorded = false;

    try {
      const output = await cashierProcedures.recordCreditPayment(
        [request.params.saleId, amount, paymentMethod, reference, getActorId(request), qr ? qr.id : null, payDetails]
      );

      if (output.status_code !== 200) {
        // the customer paid and nothing was recorded: said on the row first
        let code;
        if (qr) code = await qrPayments.recordUnsaved(qr.id, getActorId(request));
        return response.status(output.status_code).json({ error: output.message, code: code || undefined });
      }
      recorded = true;
      if (qr) qrPayments.announceUsed(qr.id);

      // What the payment receipt prints: the payment as it was recorded, who took
      // it, and what the sale owes now. The receipt can still be drawn without it,
      // so a failed read here only leaves it out.
      let receipt = null;
      try {
        const receiptResult = await db.query(
          "SELECT cp.payment_id, cp.payment_date, cp.reference_no, st.full_name AS cashier_name,\n" +
            "       s.tax_registration, GREATEST(s.amount_due - s.amount_paid, 0) AS balance_after,\n" +
            "       " + SALE_CUSTOMER_SQL + " AS customer_name\n" +
            "       FROM credit_payments cp\n" +
            "       JOIN sales s ON s.sale_id = cp.sale_id\n" +
            "       LEFT JOIN customers c ON c.customer_id = s.customer_id\n" +
            "       LEFT JOIN staff st ON st.staff_id = cp.received_by_staff_id\n" +
            "       WHERE cp.sale_id = ? AND cp.received_by_staff_id = ?\n" +
            "       ORDER BY cp.payment_id DESC LIMIT 1",
          [request.params.saleId, getActorId(request)]
        );
        if (receiptResult[0].length > 0) {
          const row = receiptResult[0][0];
          const balanceAfter = Number(row.balance_after);
          const detailsResult = await db.query(
            "SELECT method, account_name, account_number, bank_name, branch,\n" +
              "       DATE_FORMAT(cheque_date, '%Y-%m-%d') AS cheque_date\n" +
              "       FROM payment_details WHERE payment_id = ? ORDER BY detail_id LIMIT 1",
            [row.payment_id]
          );
          receipt = {
            details: detailsResult[0][0] || null,
            paymentId: row.payment_id,
            paymentDate: row.payment_date,
            cashierName: row.cashier_name,
            customerName: row.customer_name,
            taxRegistration: row.tax_registration,
            amount: Number(amount),
            method: paymentMethod,
            reference: row.reference_no,
            balanceBefore: Math.round((balanceAfter + Number(amount)) * 100) / 100,
            balanceAfter: balanceAfter
          };
        }
      } catch (error) {
        console.error("Reading the payment for its receipt failed:", error.message);
      }

      response.json({ message: output.message, reference: qr ? qr.reference : null, receipt: receipt });
    } catch (error) {
      console.error("Payment failed:", error.message);
      if (qr && !recorded) await qrPayments.recordUnsaved(qr.id, getActorId(request));
      if (!response.headersSent) response.status(500).json({ error: "Unable to record the payment" });
    } finally {
      if (qr) qr.release();
    }
  });
}

module.exports = { registerCashierRoutes: registerCashierRoutes };
