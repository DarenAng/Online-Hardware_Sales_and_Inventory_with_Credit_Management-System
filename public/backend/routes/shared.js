// ============================================================
// shared.js -- the routes every signed-in role uses
// Loaded by: server.js only.
// Never sent to a browser.
//
// Routes in this file:
//   GET   /api/events/poll          what changed since a version (the live channel)
//   GET   /api/events/status        how many screens are connected
//   GET   /api/me/access            what the signed-in person is
//   GET   /api/me/features          the screens this person's menu holds
//   GET   /api/me                   My Account
//   PUT   /api/me                   change your own name and phone
//   POST  /api/me/password          change your own password (administrator only)
//   GET   /api/records/:type        suppliers, customers, products, categories, brands, units
//   GET   /api/archives             what has been put away
//   POST  /api/archives/archive     put a record away
//   POST  /api/archives/restore     bring one back
//   GET   /api/cron/daily           the daily job (Vercel Cron)
//
// The access rules in access-control.js have already checked the user's role
// before any of these routes run.
// ============================================================

const crypto = require("crypto");
const db = require("../database/connection").db;
const sharedProcedures = require("../database/procedures/shared-procedures");
const roles = require("../roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
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

// Refuses an administrator changing their own details from the My Account
// screen: another administrator makes those changes.
function notOwnDetailsIfAdmin(request, response, next) {
  if (request.actor && request.actor.roleName === ADMIN) {
    return response.status(403).json({
      error: "A System Administrator's details are changed by another administrator, " +
             "not from this screen. Your password is still yours to change."
    });
  }
  next();
}

// A credential (the sign-in email, the password, the role) is not changed by
// its own holder from here: a standard user edits name and phone only. A new
// password comes from "Forgot your password?" on the sign-in page, from a
// manager (counter, stockroom and delivery staff), or from the administrator.
// The administrator keeps the right to change their own password.
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

// RECORDS: one route, five record types
const RECORD_QUERIES = {
  supplier: "SELECT sup.supplier_id AS id, sup.supplier_name AS name, sup.contact_person,\n" +
    "                    sup.contact_number, sup.email, sup.address,\n" +
    "                    COUNT(p.product_id) AS product_count\n" +
    "             FROM suppliers sup\n" +
    "             LEFT JOIN products p ON p.supplier_id = sup.supplier_id AND p.is_archived = FALSE\n" +
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
    "             GROUP BY c.customer_id, c.first_name, c.middle_name, c.last_name, c.phone, c.address, c.created_at,\n" +
    "                      c.address_street, c.address_barangay, c.address_city,\n" +
    "                      c.address_province, c.address_landmark,\n" +
    "                      v.credit_limit, v.total_purchase, v.current_credit\n" +
    "             ORDER BY c.first_name",
  product: "SELECT p.product_id AS id, p.product_name AS name, p.price, p.reorder_point, p.status,\n" +
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
    "         GROUP BY u.unit_id, u.unit_name ORDER BY u.unit_name"
};

// Who may archive a kind of record, and who may bring it back. One list for
// both routes, so a role that cannot put a record away cannot restore it
// either (the route rule above lets a clerk reach both routes, so the kind of
// record is checked here). The procedure holds the rules for each kind.
const ARCHIVE_ROLES = {
  Inventory: [CLERK, ADMIN, MANAGER],
  Sales: MANAGEMENT,
  Delivery: MANAGEMENT,
  Staff: [ADMIN]
};

// The live channel files every /api/archives write under "archives" (see scopeOf in
// live-changes.js), which only the manager's Archives table reads. What an archive or a
// restore really moves is listed here, so the other screens (the material list, the
// till's catalogue, the sales and delivery lists, the staff list) read it again too.
const ARCHIVE_SCOPES = {
  Inventory: ["inventory"],
  Sales: ["sales", "inventory", "deliveries"],
  Delivery: ["deliveries"],
  Staff: ["staff"]
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

// adminModule and managerModule are what registerAdminRoutes and registerManagerRoutes
// gave back; the daily job runs their sweeps.
function registerSharedRoutes(app, deps) {
  const adminModule = deps.adminModule;
  const managerModule = deps.managerModule;

  // ==========================================
  // THE LIVE CHANNEL
  //
  // Every signed-in browser asks here every few seconds what changed since the
  // version it last saw. The first ask (no "since") only learns the version.
  // The access check ahead of it has already refreshed the session, so asking
  // also marks the person present. A browser further behind than the log is
  // told so (gap) and offered a reload.
  // ==========================================
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
        // screens that asked within the presence window
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

  // ==========================================
  // YOUR OWN ACCOUNT -- always the signed-in account; the role is not editable here
  // ==========================================
  // What the signed-in person is, for the screens to shape themselves around.
  // A convenience for the page and never a permission.
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

  // What this person's menu holds. A convenience
  // for the page; the access hook reads the same table for itself.
  app.get("/api/me/features", async function (request, response) {
    try {
      const features = await featuresOf(request.actor.roleName);

      // the keys of the screens this person has switched on
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

    // the email is a credential (see notOwnCredentials); refused rather than dropped
    if (email !== undefined && email !== null && String(email).trim() !== "" &&
        String(email).trim().toLowerCase() !== String(actor.email || "").toLowerCase()) {
      return response.status(403).json({
        error: "Your sign-in email is changed by the System Administrator from the staff directory."
      });
    }

    // the phone number is required on your own details
    if (!phone || String(phone).trim() === "") {
      return response.status(400).json({ error: "A phone number is required" });
    }

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    try {
      // a new phone number must not belong to another staff member; keeping
      // the one on file is always fine
      const mineResult = await db.query("SELECT phone FROM staff WHERE staff_id = ?", [actor.staffId]);
      const mine = mineResult[0];
      const oldPhone = mine[0] ? mine[0].phone : null;
      if (cleanPhone(phone) !== oldPhone) {
        const phoneOwner = await findPhoneOwner(phone, actor.staffId);
        if (phoneOwner) {
          return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
        }
      }

      // the role and the email are the ones on file, never from the browser
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

    // the old password typed in the new box from habit is refused before the
    // database is asked
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
      response.json(rows);
    } catch (error) {
      console.error("Records failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ARCHIVES
  app.get("/api/archives", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT module, record_id, record_name, detail, archived_at,\n" +
          "                COALESCE(archived_by, 'System') AS archived_by\n" +
          "         FROM vw_archives\n" +
          "         ORDER BY archived_at DESC, module"
      );
      const rows = rowsResult[0];
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

  app.post("/api/archives/archive", async function (request, response) {
    const module = request.body.module;
    const recordId = request.body.recordId;

    if (!module || !recordId) {
      return response.status(400).json({ error: "Module and record id are required" });
    }

    const allowed = ARCHIVE_ROLES[module];
    if (!allowed || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({ error: "Your role cannot archive " + module + " records." });
    }

    try {
      const output = await sharedProcedures.archiveRecord(
        [module, recordId, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // An archived staff member can no longer work, so any screen they have
      // open is signed out; it reads this reason on its next request.
      if (module === "Staff") {
        await endSessionsForStaff(recordId, null,
          "Your account was archived by the System Administrator.");
      }

      await announceArchiveChange(request, module, "archived", recordId);

      response.json({ message: output.message });
    } catch (error) {
      console.error("Archive failed:", error.message);
      response.status(500).json({ error: "Unable to archive the record" });
    }
  });

  // ==========================================
  // THE DAILY JOB -- on Vercel, where no timer runs between requests.
  // vercel.json calls it once a day; Vercel sends "Authorization: Bearer
  // <CRON_SECRET>", and without that secret nobody else can start it. On a PC
  // the same work runs on the timers started above.
  // ==========================================

  app.get("/api/cron/daily", async function (request, response) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return response.status(503).json({ error: "CRON_SECRET is not set, so the daily job is switched off." });
    }
    if (!sameSecret(request.headers.authorization || "", "Bearer " + secret)) {
      return response.status(401).json({ error: "Not allowed" });
    }

    // each step on its own, so one failing does not stop the rest
    const steps = {
      penalties: function () { return managerModule.runPenaltySweep(); },
      archives: function () { return adminModule.runArchiveSweep(); },
      backup: function () { return adminModule.runDailyBackup(); },
      sessions: function () { return removeExpiredSessions(); },
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
