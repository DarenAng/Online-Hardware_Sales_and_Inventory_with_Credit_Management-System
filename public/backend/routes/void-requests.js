const helpers = require("../helpers");
const sharedProcedures = require("../database/procedures/shared-procedures");

const MOST_REASON = 255;

function receiptNo(saleId) {
  return helpers.orNumber(saleId);
}

function registerVoidRequestRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const publishChange = deps.publishChange;
  const CASHIER = deps.CASHIER;

  function announce(request, what) {
    const origin = request.headers["x-client-id"] || null;
    publishChange("sales", what, origin);
    publishChange("notifications", what, origin);
  }

  app.post("/api/sales/:saleId/void-request", async function (request, response) {
    const saleId = Number(request.params.saleId);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return response.status(400).json({ error: "Say which sale to void." });
    }
    const reason = typeof request.body.reason === "string" ? request.body.reason.trim() : "";
    if (reason === "") {
      return response.status(400).json({ error: "Type why the sale should be voided." });
    }
    if (reason.length > MOST_REASON) {
      return response.status(400).json({ error: "The reason is at most " + MOST_REASON + " characters." });
    }

    try {
      const salesResult = await db.query(
        "SELECT s.sale_id, s.is_archived, s.cashier_staff_id, s.final_amount,\n" +
          "       DATE(s.sale_date) = CURDATE() AS is_today,\n" +
          "       (SELECT full_name FROM staff WHERE staff_id = ?) AS asker\n" +
          "  FROM sales s WHERE s.sale_id = ?",
        [request.actor.staffId, saleId]
      );
      const sale = salesResult[0][0];
      if (!sale) return response.status(404).json({ error: "That sale is not on record." });
      if (sale.is_archived) return response.status(409).json({ error: "That sale is already voided." });
      if (Number(sale.is_today) !== 1) {
        return response.status(409).json({ error: "Only a sale made today can be voided." });
      }
      if (request.actor.roleName === CASHIER && Number(sale.cashier_staff_id) !== Number(request.actor.staffId)) {
        return response.status(403).json({ error: "Only the cashier who rang up the sale can ask to void it." });
      }

      const waitingResult = await db.query(
        "SELECT request_id FROM void_requests WHERE sale_id = ? AND status = 'Pending' LIMIT 1", [saleId]);
      if (waitingResult[0].length > 0) {
        return response.status(409).json({ error: "A void for this sale is already waiting for a manager." });
      }

      const inserted = await db.query(
        "INSERT INTO void_requests (sale_id, reason, requested_by_staff_id) VALUES (?, ?, ?)",
        [saleId, reason, getActorId(request)]
      );
      const requestId = inserted[0].insertId;

      await db.query(
        "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)\n" +
          "SELECT role_id, 'Void Request', ?, ?, ? FROM roles WHERE role_name = 'Manager'",
        [("Void requested for " + receiptNo(saleId)).slice(0, 150),
         (sale.asker || "A cashier") + " asks to void " + receiptNo(saleId) + " (" +
           Number(sale.final_amount).toFixed(2) + "): " + reason + ". Open it in Sales Transactions to decide.",
         getActorId(request)]
      );
      await db.query(
        "INSERT INTO audit_logs (staff_id, action, action_type, details) VALUES (?, 'VOID_REQUEST', 'CREATE', ?)",
        [getActorId(request), ("Asked to void " + receiptNo(saleId) + ": " + reason).slice(0, 255)]
      ).catch(function (error) { console.error("Void request audit failed:", error.message); });

      announce(request, "void request " + requestId);
      response.status(201).json({ message: "The void request for " + receiptNo(saleId) + " was sent to the manager.",
                                  requestId: requestId });
    } catch (error) {
      console.error("Void request failed:", error.message);
      response.status(500).json({ error: "Unable to send the void request" });
    }
  });

  app.get("/api/void-requests", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT vr.request_id, vr.sale_id, vr.reason, vr.status, vr.requested_at,\n" +
          "       st.full_name AS requested_by, s.final_amount, s.sale_date\n" +
          "  FROM void_requests vr\n" +
          "  JOIN sales s ON s.sale_id = vr.sale_id\n" +
          "  LEFT JOIN staff st ON st.staff_id = vr.requested_by_staff_id\n" +
          " WHERE vr.status = 'Pending'\n" +
          " ORDER BY vr.requested_at"
      );
      response.json(rowsResult[0]);
    } catch (error) {
      console.error("Void requests list failed:", error.message);
      response.status(500).json({ error: "Unable to read the void requests" });
    }
  });

  async function waitingRequest(requestId) {
    const rowsResult = await db.query(
      "SELECT vr.*, st.full_name AS requested_by FROM void_requests vr\n" +
        "  LEFT JOIN staff st ON st.staff_id = vr.requested_by_staff_id WHERE vr.request_id = ?",
      [requestId]
    );
    const row = rowsResult[0][0];
    if (!row) return { status: 404, error: "That void request is not on record." };
    if (row.status !== "Pending") return { status: 409, error: "That void request was already " + row.status.toLowerCase() + "." };
    return { row: row };
  }

  async function tellCashiers(request, title, message) {
    await db.query(
      "INSERT INTO notifications (target_role_id, notif_type, title, message, created_by_staff_id)\n" +
        "SELECT role_id, 'Void Request', ?, ?, ? FROM roles WHERE role_name = 'Cashier'",
      [title.slice(0, 150), message, getActorId(request)]
    );
  }

  app.post("/api/void-requests/:requestId/approve", async function (request, response) {
    const requestId = Number(request.params.requestId);
    const note = typeof request.body.note === "string" ? request.body.note.trim().slice(0, 255) : "";
    try {
      const found = await waitingRequest(requestId);
      if (found.error) return response.status(found.status).json({ error: found.error });
      const row = found.row;

      const taken = await db.query(
        "UPDATE void_requests SET status = 'Approved', decided_by_staff_id = ?, decided_at = NOW(),\n" +
          "       decision_note = ? WHERE request_id = ? AND status = 'Pending'",
        [getActorId(request), note || null, requestId]
      );
      if (!taken[0].affectedRows) {
        return response.status(409).json({ error: "Another manager has just decided this request." });
      }

      let output;
      try {
        output = await sharedProcedures.archiveRecord(["Sales", row.sale_id, getActorId(request)]);
      } catch (error) {
        output = { status_code: 500, message: "Unable to void the sale" };
        console.error("Void sale failed:", error.message);
      }
      if (output.status_code !== 200) {
        await db.query(
          "UPDATE void_requests SET status = 'Pending', decided_by_staff_id = NULL, decided_at = NULL,\n" +
            "       decision_note = NULL WHERE request_id = ?", [requestId]);
        return response.status(output.status_code).json({ error: output.message });
      }

      await tellCashiers(request, "Void approved for " + receiptNo(row.sale_id),
        receiptNo(row.sale_id) + " is voided, as " + (row.requested_by || "the cashier") + " asked." +
          (note ? " Manager's note: " + note : ""));
      announce(request, "void approved " + row.sale_id);
      publishChange("inventory", "void approved " + row.sale_id, request.headers["x-client-id"] || null);
      publishChange("deliveries", "void approved " + row.sale_id, request.headers["x-client-id"] || null);
      response.json({ message: output.message || (receiptNo(row.sale_id) + " is voided.") });
    } catch (error) {
      console.error("Void approve failed:", error.message);
      response.status(500).json({ error: "Unable to approve the void request" });
    }
  });

  app.post("/api/void-requests/:requestId/decline", async function (request, response) {
    const requestId = Number(request.params.requestId);
    const note = typeof request.body.note === "string" ? request.body.note.trim() : "";
    if (note === "") {
      return response.status(400).json({ error: "Type why the void is declined, so the cashier knows." });
    }
    if (note.length > 255) {
      return response.status(400).json({ error: "The note is at most 255 characters." });
    }
    try {
      const found = await waitingRequest(requestId);
      if (found.error) return response.status(found.status).json({ error: found.error });
      const row = found.row;

      const taken = await db.query(
        "UPDATE void_requests SET status = 'Declined', decided_by_staff_id = ?, decided_at = NOW(),\n" +
          "       decision_note = ? WHERE request_id = ? AND status = 'Pending'",
        [getActorId(request), note, requestId]
      );
      if (!taken[0].affectedRows) {
        return response.status(409).json({ error: "Another manager has just decided this request." });
      }

      await tellCashiers(request, "Void declined for " + receiptNo(row.sale_id),
        "The request to void " + receiptNo(row.sale_id) + " was declined: " + note);
      announce(request, "void declined " + row.sale_id);
      response.json({ message: "The void request for " + receiptNo(row.sale_id) + " was declined." });
    } catch (error) {
      console.error("Void decline failed:", error.message);
      response.status(500).json({ error: "Unable to decline the void request" });
    }
  });
}

module.exports = { registerVoidRequestRoutes: registerVoidRequestRoutes };
