const helpers = require("../helpers");
const crypto = require("crypto");
const db = require("../database/connection").db;
const sharedProcedures = require("../database/procedures/shared-procedures");
const roles = require("../roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const MANAGEMENT = roles.MANAGEMENT;
const ROLE_PAGES = roles.ROLE_PAGES;
const liveChanges = require("../live-changes");
const changesSince = liveChanges.changesSince;
const latestChangeVersion = liveChanges.latestChangeVersion;
const LIVE_POLL_SECONDS = liveChanges.LIVE_POLL_SECONDS;
const recordChange = liveChanges.recordChange;
const sessions = require("../sessions");
const PRESENCE_WINDOW_MS = sessions.PRESENCE_WINDOW_MS;
const endSessionsForStaff = sessions.endSessionsForStaff;
const removeExpiredSessions = sessions.removeExpiredSessions;
const renewSessionAfterPasswordChange = sessions.renewSessionAfterPasswordChange;
const getActorId = sessions.getActorId;
const featuresOf = require("../features").featuresOf;
const ROLES_MANAGED_BY_MANAGER = require("../features").ROLES_MANAGED_BY_MANAGER;
const USER_SELECT = require("../shared-sql").USER_SELECT;
const validation = require("../validation");
const phoneComplaint = validation.phoneComplaint;
const cleanPhone = validation.cleanPhone;
const findPhoneOwner = validation.findPhoneOwner;
const phoneTakenMessage = validation.phoneTakenMessage;
const cleanMiddleName = validation.cleanMiddleName;
const passwordComplaint = validation.passwordComplaint;
const writeAuditLog = require("../audit-log").writeAuditLog;
const passwords = require("../services/passwords");
const hashPassword = passwords.hashPassword;
const verifyPassword = passwords.verifyPassword;

function notOwnDetailsIfAdmin(request, response, next) {
  if (request.actor && request.actor.roleName === ADMIN) {
    return response.status(403).json({
      error: "A System Administrator's details are changed by another administrator, " +
             "not from this screen. Your password is still yours to change."
    });
  }
  next();
}

function notOwnCredentials(request, response, next) {
  if (request.actor && request.actor.roleName !== ADMIN) {
    return response.status(403).json({
      error: "Your password is not changed from this screen. Sign out and use " +
             "\"Forgot your password?\" on the sign-in page for a code sent to your " +
             "email, or ask a manager or the System Administrator to reset it."
    });
  }
  next();
}

const RECORD_QUERIES = {
  supplier: "SELECT sup.supplier_id AS id, sup.supplier_name AS name, sup.contact_person,\n" +
    "                    sup.contact_number, sup.email, sup.address,\n" +
    "                    COUNT(p.product_id) AS product_count\n" +
    "             FROM suppliers sup\n" +
    "             LEFT JOIN products p ON p.supplier_id = sup.supplier_id AND p.is_archived = FALSE\n" +
    "             WHERE sup.is_archived = FALSE\n" +
    "             GROUP BY sup.supplier_id, sup.supplier_name, sup.contact_person,\n" +
    "                      sup.contact_number, sup.email, sup.address\n" +
    "             ORDER BY sup.supplier_name",
  customer: "SELECT c.customer_id AS id, c.full_name AS name,\n" +
    "                    c.first_name, c.middle_name, c.last_name, c.phone, c.address, c.created_at,\n" +
    "                    c.address_street, c.address_barangay, c.address_city,\n" +
    "                    c.address_province, c.address_landmark,\n" +
    "                    COALESCE(v.credit_limit, 0) AS credit_limit,\n" +
    "                    COALESCE(v.total_purchase, 0) AS total_purchase,\n" +
    "                    COALESCE(v.current_credit, 0) AS current_credit,\n" +
    "                    COUNT(s.sale_id) AS purchase_count\n" +
    "             FROM customers c\n" +
    "             LEFT JOIN vw_customer_credit v ON v.customer_id = c.customer_id\n" +
    "             LEFT JOIN sales s ON s.customer_id = c.customer_id AND s.is_archived = FALSE\n" +
    "             WHERE c.is_archived = FALSE\n" +
    "             GROUP BY c.customer_id, c.first_name, c.middle_name, c.last_name, c.phone, c.address, c.created_at,\n" +
    "                      c.address_street, c.address_barangay, c.address_city,\n" +
    "                      c.address_province, c.address_landmark,\n" +
    "                      v.credit_limit, v.total_purchase, v.current_credit\n" +
    "             ORDER BY c.first_name",
  product: "SELECT p.product_id AS id, p.product_name AS name, p.description, p.price, p.last_cost, p.reorder_point, p.status,\n" +
    "                   p.category_id, p.brand_id, p.unit_id, p.supplier_id,\n" +
    "                   b.brand_name, c.category_name, u.unit_name, sup.supplier_name,\n" +
    "                   COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock, p.created_at\n" +
    "            FROM products p\n" +
    "            LEFT JOIN brands b ON b.brand_id = p.brand_id\n" +
    "            LEFT JOIN categories c ON c.category_id = p.category_id\n" +
    "            LEFT JOIN units u ON u.unit_id = p.unit_id\n" +
    "            LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id\n" +
    "            LEFT JOIN inventory i ON i.product_id = p.product_id\n" +
    "            WHERE p.is_archived = FALSE ORDER BY p.product_name",
  category: "SELECT c.category_id AS id, c.category_name AS name,\n" +
    "                    COUNT(p.product_id) AS product_count,\n" +
    "                    COALESCE(SUM(i.quantity_in_stock), 0) AS total_stock\n" +
    "             FROM categories c\n" +
    "             LEFT JOIN products p ON p.category_id = c.category_id AND p.is_archived = FALSE\n" +
    "             LEFT JOIN inventory i ON i.product_id = p.product_id\n" +
    "             WHERE c.is_archived = FALSE\n" +
    "             GROUP BY c.category_id, c.category_name ORDER BY c.category_name",
  brand: "SELECT b.brand_id AS id, b.brand_name AS name,\n" +
    "                 COUNT(p.product_id) AS product_count\n" +
    "          FROM brands b\n" +
    "          LEFT JOIN products p ON p.brand_id = b.brand_id AND p.is_archived = FALSE\n" +
    "          GROUP BY b.brand_id, b.brand_name ORDER BY b.brand_name",
  unit: "SELECT u.unit_id AS id, u.unit_name AS name,\n" +
    "                COUNT(p.product_id) AS product_count\n" +
    "         FROM units u\n" +
    "         LEFT JOIN products p ON p.unit_id = u.unit_id AND p.is_archived = FALSE\n" +
    "         WHERE u.is_archived = FALSE\n" +
    "         GROUP BY u.unit_id, u.unit_name ORDER BY u.unit_name"
};

const ARCHIVE_ROLES = {
  Inventory: [CLERK, ADMIN, MANAGER],
  Sales: MANAGEMENT,
  Delivery: MANAGEMENT,
  Staff: [ADMIN, MANAGER],
  Supplier: MANAGEMENT,
  Customer: MANAGEMENT,
  Category: [CLERK, ADMIN, MANAGER],
  Unit: [CLERK, ADMIN, MANAGER]
};

const ARCHIVABLE = ["Customer", "Inventory", "Unit", "Category", "Supplier", "Staff"];

const SIMPLE_ARCHIVES = {
  Supplier: {
    table: "suppliers", key: "supplier_id", name: "supplier_name",
    blocked: async function (id) {
      const open = await db.query(
        "SELECT COUNT(*) AS n FROM purchase_orders WHERE supplier_id = ? " +
        "AND status NOT IN ('Received', 'Cancelled')", [id]);
      if (Number(open[0][0].n) > 0) {
        return "This supplier has a purchase order that is not finished. Receive or cancel it first.";
      }
      return null;
    }
  },
  Customer: {
    table: "customers", key: "customer_id", name: "full_name",
    blocked: async function (id) {
      const owed = await db.query(
        "SELECT COUNT(*) AS n FROM sales WHERE customer_id = ? AND is_archived = FALSE " +
        "AND payment_status <> 'Paid'", [id]);
      if (Number(owed[0][0].n) > 0) {
        return "This customer still owes money on a sale. Collect it before archiving the account.";
      }
      return null;
    }
  },
  Category: {
    table: "categories", key: "category_id", name: "category_name",
    blocked: async function (id) {
      const used = await db.query(
        "SELECT COUNT(*) AS n FROM products WHERE category_id = ? AND is_archived = FALSE", [id]);
      if (Number(used[0][0].n) > 0) {
        return "Products are still filed under this category. Move or archive them first.";
      }
      return null;
    }
  },
  Unit: {
    table: "units", key: "unit_id", name: "unit_name",
    blocked: async function (id) {
      const used = await db.query(
        "SELECT COUNT(*) AS n FROM products WHERE unit_id = ? AND is_archived = FALSE", [id]);
      if (Number(used[0][0].n) > 0) {
        return "Products are still counted in this unit. Change or archive them first.";
      }
      return null;
    }
  }
};

async function setSimpleArchive(request, module, recordId, archive) {
  const plan = SIMPLE_ARCHIVES[module];
  const found = await db.query(
    "SELECT " + plan.name + " AS name FROM " + plan.table + " WHERE " + plan.key + " = ? AND is_archived = ?",
    [recordId, !archive]);
  if (found[0].length === 0) {
    return { status: 404, message: (archive ? "Active " : "Archived ") + module.toLowerCase() + " record not found." };
  }
  const name = found[0][0].name;

  if (archive) {
    const reason = await plan.blocked(recordId);
    if (reason) return { status: 409, message: reason };
    await db.query(
      "UPDATE " + plan.table + " SET is_archived = TRUE, archived_at = NOW(), archived_by_staff_id = ? " +
      "WHERE " + plan.key + " = ?", [getActorId(request), recordId]);
  } else {
    await db.query(
      "UPDATE " + plan.table + " SET is_archived = FALSE, archived_at = NULL, archived_by_staff_id = NULL " +
      "WHERE " + plan.key + " = ?", [recordId]);
  }

  await writeAuditLog(request, archive ? "ARCHIVE" : "RESTORE",
    module + " " + name + " (" + helpers.recordCode(module, recordId) + ") " + (archive ? "archived" : "restored"),
    { module: module, record_id: Number(recordId) });
  return { status: 200, message: archive ? "Record archived." : "Record restored." };
}

async function staffOutOfReach(request, recordId) {
  if (request.actor.roleName === ADMIN) return null;
  const found = await db.query(
    "SELECT r.role_name FROM staff s JOIN roles r ON r.role_id = s.role_id WHERE s.staff_id = ?", [recordId]);
  if (found[0].length === 0) return null;
  if (ROLES_MANAGED_BY_MANAGER.indexOf(found[0][0].role_name) === -1) {
    return "A manager can only archive cashier, inventory clerk and driver accounts.";
  }
  if (Number(recordId) === Number(getActorId(request))) {
    return "You cannot archive your own account.";
  }
  return null;
}

const ARCHIVE_SCOPES = {
  Inventory: ["inventory"],
  Sales: ["sales", "inventory", "deliveries"],
  Delivery: ["deliveries"],
  Staff: ["staff"],
  Supplier: ["inventory"],
  Customer: ["credit"],
  Category: ["inventory"],
  Unit: ["inventory"]
};

async function announceArchiveChange(request, module, what, recordId) {
  const scopes = ARCHIVE_SCOPES[module] || [];
  for (let i = 0; i < scopes.length; i++) {
    await recordChange(scopes[i], what + " " + module + " #" + recordId,
      request.headers["x-client-id"] || null);
  }
}

function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function registerSharedRoutes(app, deps) {
  const adminModule = deps.adminModule;
  const managerModule = deps.managerModule;
  const portalModule = deps.portalModule;

  app.get("/api/events/poll", async function (request, response) {
    const since = parseInt(request.query.since, 10);

    try {
      const result = await changesSince(since);
      response.set("Cache-Control", "no-store");
      response.json({
        version: result.version,
        changes: result.changes,
        gap: result.gap,
        pollMs: LIVE_POLL_SECONDS * 1000
      });
    } catch (error) {
      console.error("Reading live changes failed:", error.message);
      response.status(500).json({ error: "Unable to read what changed" });
    }
  });

  app.get("/api/events/status", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT COUNT(*) AS connections, COUNT(DISTINCT staff_id) AS people\n" +
          "         FROM user_sessions\n" +
          "         WHERE ended_reason IS NULL AND expires_at > ? AND last_seen > ?",
        [Date.now(), Date.now() - PRESENCE_WINDOW_MS]);
      const rows = rowsResult[0];
      const loggedResult = await db.query("SELECT COUNT(*) AS total FROM live_changes");
      const logged = loggedResult[0];

      response.json({
        version: await latestChangeVersion(),
        connections: Number(rows[0].connections),
        people: Number(rows[0].people),
        logged: Number(logged[0].total),
        pollSeconds: LIVE_POLL_SECONDS
      });
    } catch (error) {
      console.error("Reading the live status failed:", error.message);
      response.status(500).json({ error: "Unable to read the live status" });
    }
  });

  app.get("/api/me/access", function (request, response) {
    const actor = request.actor;

    response.json({
      staffId: actor.staffId,
      roleName: actor.roleName,
      page: ROLE_PAGES[actor.roleName] || "/Login.html",
      isAdmin: actor.roleName === ADMIN,
      isManagement: MANAGEMENT.includes(actor.roleName),
      canEditOwnDetails: actor.roleName !== ADMIN,
      canChangeOwnPassword: actor.roleName === ADMIN,
      canEditOwnEmail: false
    });
  });

  app.get("/api/me/features", async function (request, response) {
    try {
      const features = await featuresOf(request.actor.roleName);

      const heldKeys = [];
      for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        const feature = features[featureIndex];
        if (feature.held) {
          heldKeys.push(feature.key);
        }
      }

      response.json({
        roleName: request.actor.roleName,
        features: features,
        held: heldKeys
      });
    } catch (error) {
      console.error("Reading a role's screens failed:", error.message);
      response.status(500).json({ error: "Unable to read which screens you hold" });
    }
  });

  app.get("/api/me", async function (request, response) {
    try {
      const rowsResult = await db.query(USER_SELECT + " WHERE s.staff_id = ?", [request.actor.staffId]);
      const rows = rowsResult[0];

      if (rows.length === 0) {
        return response.status(404).json({ error: "Your staff record was not found." });
      }

      response.json(rows[0]);
    } catch (error) {
      console.error("Profile read failed:", error.message);
      response.status(500).json({ error: "Unable to load your account details" });
    }
  });

  app.put("/api/me", notOwnDetailsIfAdmin, async function (request, response) {
    const firstName = request.body.firstName;
    const middleName = request.body.middleName;
    const lastName = request.body.lastName;
    const phone = request.body.phone;
    const email = request.body.email;
    const actor = request.actor;

    if (!firstName || !lastName) {
      return response.status(400).json({ error: "First name and last name are required" });
    }

    if (email !== undefined && email !== null && String(email).trim() !== "" &&
        String(email).trim().toLowerCase() !== String(actor.email || "").toLowerCase()) {
      return response.status(403).json({
        error: "Your sign-in email is changed by the System Administrator from the staff directory."
      });
    }

    if (!phone || String(phone).trim() === "") {
      return response.status(400).json({ error: "A phone number is required" });
    }

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    try {
      const mineResult = await db.query("SELECT phone FROM staff WHERE staff_id = ?", [actor.staffId]);
      const mine = mineResult[0];
      const oldPhone = mine[0] ? mine[0].phone : null;
      if (cleanPhone(phone) !== oldPhone) {
        const phoneOwner = await findPhoneOwner(phone, actor.staffId);
        if (phoneOwner) {
          return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
        }
      }

      const output = await sharedProcedures.updateOwnAccount(
        [actor.staffId, String(firstName).trim(), cleanMiddleName(middleName),
         String(lastName).trim(), cleanPhone(phone),
         actor.roleId, actor.email || null]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      await writeAuditLog(request, "UPDATE_OWN_PROFILE", actor.email + " updated their own details");

      const rowsResult = await db.query(USER_SELECT + " WHERE s.staff_id = ?", [actor.staffId]);
      const rows = rowsResult[0];
      response.json({ message: "Your details were saved.", user: rows[0] });
    } catch (error) {
      console.error("Profile update failed:", error.message);
      response.status(500).json({ error: "Unable to save your details" });
    }
  });

  app.post("/api/me/password", notOwnCredentials, async function (request, response) {
    const currentPassword = request.body.currentPassword;
    const newPassword = request.body.newPassword;
    const actor = request.actor;

    if (typeof currentPassword !== "string" || currentPassword === "") {
      return response.status(400).json({ error: "Enter your current password" });
    }

    if (newPassword === currentPassword) {
      return response.status(400).json({ error: "The new password must be different from your current password" });
    }

    const complaint = passwordComplaint(newPassword);
    if (complaint) {
      return response.status(400).json({ error: complaint });
    }

    try {
      const rowsResult = await db.query("SELECT password FROM users WHERE staff_id = ?", [actor.staffId]);
      const rows = rowsResult[0];

      if (rows.length === 0) {
        return response.status(404).json({ error: "This account has no login yet." });
      }

      if (!(await verifyPassword(currentPassword, rows[0].password))) {
        return response.status(403).json({ error: "That is not your current password" });
      }

      await db.query(
        "UPDATE users SET password = ?, must_change_password = FALSE WHERE staff_id = ?",
        [await hashPassword(newPassword), actor.staffId]
      );

      await writeAuditLog(request, "CHANGE_OWN_PASSWORD",
        actor.email + " changed their own password; every other session on the old one was ended");

      await renewSessionAfterPasswordChange(request, response);
      response.json({ message: "Your password was changed." });
    } catch (error) {
      console.error("Own password change failed:", error.message);
      response.status(500).json({ error: "Unable to change your password" });
    }
  });

  app.get("/api/records/:type", async function (request, response) {
    const sql = RECORD_QUERIES[request.params.type];

    if (!sql) {
      return response.status(400).json({ error: "Unknown record type" });
    }

    try {
      const rowsResult = await db.query(sql);
      const rows = rowsResult[0];
      if (request.actor && request.actor.roleName === CASHIER) {
        for (let i = 0; i < rows.length; i++) delete rows[i].last_cost;
      }
      response.json(rows);
    } catch (error) {
      console.error("Records failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/archives", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT a.module, a.record_id, a.record_name, a.detail, a.archived_at,\n" +
          "       COALESCE(a.archived_by, 'System') AS archived_by\n" +
          "FROM vw_archives a\n" +
          "WHERE a.module IN ('Staff', 'Inventory')\n" +
          "UNION ALL\n" +
          "SELECT 'Supplier', x.supplier_id, x.supplier_name, x.contact_person, x.archived_at,\n" +
          "       COALESCE(a.full_name, 'System')\n" +
          "FROM suppliers x LEFT JOIN staff a ON a.staff_id = x.archived_by_staff_id WHERE x.is_archived = TRUE\n" +
          "UNION ALL\n" +
          "SELECT 'Customer', x.customer_id, x.full_name, x.phone, x.archived_at,\n" +
          "       COALESCE(a.full_name, 'System')\n" +
          "FROM customers x LEFT JOIN staff a ON a.staff_id = x.archived_by_staff_id WHERE x.is_archived = TRUE\n" +
          "UNION ALL\n" +
          "SELECT 'Category', x.category_id, x.category_name, NULL, x.archived_at,\n" +
          "       COALESCE(a.full_name, 'System')\n" +
          "FROM categories x LEFT JOIN staff a ON a.staff_id = x.archived_by_staff_id WHERE x.is_archived = TRUE\n" +
          "UNION ALL\n" +
          "SELECT 'Unit', x.unit_id, x.unit_name, NULL, x.archived_at,\n" +
          "       COALESCE(a.full_name, 'System')\n" +
          "FROM units x LEFT JOIN staff a ON a.staff_id = x.archived_by_staff_id WHERE x.is_archived = TRUE\n" +
          "ORDER BY archived_at DESC, module"
      );
      const rows = rowsResult[0];
      for (let i = 0; i < rows.length; i++) {
        const match = /^Stock (-?\d+(?:\.\d+)?)$/.exec(String(rows[i].detail || ""));
        if (rows[i].module === "Inventory" && match) rows[i].detail = "Stock " + String(Number(match[1]));
      }
      response.json(rows);
    } catch (error) {
      console.error("Archives failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/archives/restore", async function (request, response) {
    const module = request.body.module;
    const recordId = request.body.recordId;

    if (!module || !recordId) {
      return response.status(400).json({ error: "Module and record id are required" });
    }

    const allowed = ARCHIVE_ROLES[module];
    if (!allowed || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({ error: "Your role cannot restore " + module + " records." });
    }

    if (SIMPLE_ARCHIVES[module]) {
      try {
        const done = await setSimpleArchive(request, module, recordId, false);
        if (done.status !== 200) return response.status(done.status).json({ error: done.message });
        await announceArchiveChange(request, module, "restored", recordId);
        return response.json({ message: done.message });
      } catch (error) {
        console.error("Restore failed:", error.message);
        return response.status(500).json({ error: "Unable to restore the record" });
      }
    }

    if (module === "Staff") {
      const reason = await staffOutOfReach(request, recordId);
      if (reason) return response.status(403).json({ error: reason });
    }

    try {
      const output = await sharedProcedures.restoreArchive(
        [module, recordId, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      await announceArchiveChange(request, module, "restored", recordId);

      response.json({ message: output.message });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Unable to restore the record" });
    }
  });

  app.post("/api/sales/:saleId/void", async function (request, response) {
    const saleId = Number(request.params.saleId);
    if (!saleId) return response.status(400).json({ error: "Say which sale to void." });

    try {
      const output = await sharedProcedures.archiveRecord(["Sales", saleId, getActorId(request)]);
      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }
      await announceArchiveChange(request, "Sales", "voided", saleId);
      response.json({ message: output.message });
    } catch (error) {
      console.error("Void sale failed:", error.message);
      response.status(500).json({ error: "Unable to void the sale" });
    }
  });

  app.post("/api/archives/archive", async function (request, response) {
    const module = request.body.module;
    const recordId = request.body.recordId;

    if (!module || !recordId) {
      return response.status(400).json({ error: "Module and record id are required" });
    }

    if (!ARCHIVABLE.includes(module)) {
      return response.status(400).json({
        error: "Only customers, products, units, categories, suppliers and staff accounts can be archived."
      });
    }
    const allowed = ARCHIVE_ROLES[module];
    if (!allowed || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({ error: "Your role cannot archive " + module + " records." });
    }

    if (SIMPLE_ARCHIVES[module]) {
      try {
        const done = await setSimpleArchive(request, module, recordId, true);
        if (done.status !== 200) return response.status(done.status).json({ error: done.message });
        await announceArchiveChange(request, module, "archived", recordId);
        return response.json({ message: done.message });
      } catch (error) {
        console.error("Archive failed:", error.message);
        return response.status(500).json({ error: "Unable to archive the record" });
      }
    }

    if (module === "Staff") {
      const reason = await staffOutOfReach(request, recordId);
      if (reason) return response.status(403).json({ error: reason });
    }

    try {
      const output = await sharedProcedures.archiveRecord(
        [module, recordId, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (module === "Staff") {
        await endSessionsForStaff(recordId, null,
          "Your account was archived by " +
            (request.actor.roleName === ADMIN ? "the System Administrator." : "a manager."));
      }

      await announceArchiveChange(request, module, "archived", recordId);

      response.json({ message: output.message });
    } catch (error) {
      console.error("Archive failed:", error.message);
      response.status(500).json({ error: "Unable to archive the record" });
    }
  });

  app.get("/api/cron/daily", async function (request, response) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return response.status(503).json({ error: "CRON_SECRET is not set, so the daily job is switched off." });
    }
    if (!sameSecret(request.headers.authorization || "", "Bearer " + secret)) {
      return response.status(401).json({ error: "Not allowed" });
    }

    const steps = {
      penalties: function () { return managerModule.runPenaltySweep(); },
      archives: function () { return adminModule.runArchiveSweep(); },
      backup: function () { return adminModule.runDailyBackup(); },
      sessions: function () { return removeExpiredSessions(); },
      portalSessions: function () { return portalModule.removeExpiredCustomerSessions(); },
      portalPayments: function () { return portalModule.settleAllOpen(); },
      housekeeping: function () { return adminModule.removeExpiredDrafts(); }
    };
    const report = {};
    const stepNames = Object.keys(steps);
    for (let nameIndex = 0; nameIndex < stepNames.length; nameIndex++) {
      const name = stepNames[nameIndex];
      try {
        await steps[name]();
        report[name] = "ok";
      } catch (error) {
        console.error("Daily job, " + name + ":", error.message);
        report[name] = "failed: " + error.message;
      }
    }
    console.log("Daily job:", JSON.stringify(report));
    response.json(report);
  });
}

module.exports = { registerSharedRoutes: registerSharedRoutes };
