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

// the same rule, for the administrator's own profile screen
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
  supplier: `SELECT sup.supplier_id AS id, sup.supplier_name AS name, sup.contact_person,
                    sup.contact_number, sup.email, sup.address,
                    COUNT(p.product_id) AS product_count
             FROM suppliers sup
             LEFT JOIN products p ON p.supplier_id = sup.supplier_id AND p.is_archived = FALSE
             GROUP BY sup.supplier_id, sup.supplier_name, sup.contact_person,
                      sup.contact_number, sup.email, sup.address
             ORDER BY sup.supplier_name`,
  customer: `SELECT c.customer_id AS id, TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS name,
                    c.first_name, c.last_name, c.phone, c.address, c.created_at,
                    COALESCE(v.credit_limit, 0) AS credit_limit,
                    COALESCE(v.total_purchase, 0) AS total_purchase,
                    COALESCE(v.current_credit, 0) AS current_credit,
                    COUNT(s.sale_id) AS purchase_count
             FROM customers c
             LEFT JOIN vw_customer_credit v ON v.customer_id = c.customer_id
             LEFT JOIN sales s ON s.customer_id = c.customer_id AND s.is_archived = FALSE
             GROUP BY c.customer_id, c.first_name, c.last_name, c.phone, c.address, c.created_at,
                      v.credit_limit, v.total_purchase, v.current_credit
             ORDER BY c.first_name`,
  product: `SELECT p.product_id AS id, p.product_name AS name, p.price, p.reorder_point, p.status,
                   b.brand_name, c.category_name, u.unit_name, sup.supplier_name,
                   COALESCE(i.quantity_in_stock, 0) AS quantity_in_stock, p.created_at
            FROM products p
            LEFT JOIN brands b ON b.brand_id = p.brand_id
            LEFT JOIN categories c ON c.category_id = p.category_id
            LEFT JOIN units u ON u.unit_id = p.unit_id
            LEFT JOIN suppliers sup ON sup.supplier_id = p.supplier_id
            LEFT JOIN inventory i ON i.product_id = p.product_id
            WHERE p.is_archived = FALSE ORDER BY p.product_name`,
  category: `SELECT c.category_id AS id, c.category_name AS name,
                    COUNT(p.product_id) AS product_count,
                    COALESCE(SUM(i.quantity_in_stock), 0) AS total_stock
             FROM categories c
             LEFT JOIN products p ON p.category_id = c.category_id AND p.is_archived = FALSE
             LEFT JOIN inventory i ON i.product_id = p.product_id
             GROUP BY c.category_id, c.category_name ORDER BY c.category_name`,
  brand: `SELECT b.brand_id AS id, b.brand_name AS name,
                 COUNT(p.product_id) AS product_count
          FROM brands b
          LEFT JOIN products p ON p.brand_id = b.brand_id AND p.is_archived = FALSE
          GROUP BY b.brand_id, b.brand_name ORDER BY b.brand_name`,
  unit: `SELECT u.unit_id AS id, u.unit_name AS name,
                COUNT(p.product_id) AS product_count
         FROM units u
         LEFT JOIN products p ON p.unit_id = u.unit_id AND p.is_archived = FALSE
         GROUP BY u.unit_id, u.unit_name ORDER BY u.unit_name`
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

function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// adminModule and managerModule are what registerAdminRoutes and registerManagerRoutes
// gave back; the daily job runs their sweeps.
function registerSharedRoutes(app, deps) {
  const { adminModule, managerModule } = deps;

  // ==========================================
  // THE LIVE CHANNEL
  //
  // Every signed-in browser asks here every few seconds what changed since the
  // version it last saw. The first ask (no "since") only learns the version.
  // The access check ahead of it has already refreshed the session, so asking
  // also marks the person present. A browser further behind than the log is
  // told so (gap) and offered a reload.
  // ==========================================
  app.get("/api/events/poll", async (request, response) => {
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

  app.get("/api/events/status", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT COUNT(*) AS connections, COUNT(DISTINCT staff_id) AS people
         FROM user_sessions
         WHERE ended_reason IS NULL AND expires_at > ? AND last_seen > ?`,
        [Date.now(), Date.now() - PRESENCE_WINDOW_MS]);
      const [logged] = await db.query("SELECT COUNT(*) AS total FROM live_changes");

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
  app.get("/api/me/access", (request, response) => {
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
  app.get("/api/me/features", async (request, response) => {
    try {
      const features = await featuresOf(request.actor.roleName);

      // the keys of the screens this person has switched on
      const heldKeys = [];
      for (const feature of features) {
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

  app.get("/api/me", async (request, response) => {
    try {
      const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [request.actor.staffId]);

      if (rows.length === 0) {
        return response.status(404).json({ error: "Your staff record was not found." });
      }

      response.json(rows[0]);
    } catch (error) {
      console.error("Profile read failed:", error.message);
      response.status(500).json({ error: "Unable to load your account details" });
    }
  });

  app.put("/api/me", notOwnDetailsIfAdmin, async (request, response) => {
    const { firstName, middleName, lastName, phone, email } = request.body;
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
      const [mine] = await db.query("SELECT phone FROM staff WHERE staff_id = ?", [actor.staffId]);
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

      await writeAuditLog(request, "UPDATE_OWN_PROFILE", `${actor.email} updated their own details`);

      const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [actor.staffId]);
      response.json({ message: "Your details were saved.", user: rows[0] });
    } catch (error) {
      console.error("Profile update failed:", error.message);
      response.status(500).json({ error: "Unable to save your details" });
    }
  });

  app.post("/api/me/password", notOwnCredentials, async (request, response) => {
    const { currentPassword, newPassword } = request.body;
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
      const [rows] = await db.query("SELECT password FROM users WHERE staff_id = ?", [actor.staffId]);

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
        `${actor.email} changed their own password; every other session on the old one was ended`);

      await renewSessionAfterPasswordChange(request, response);
      response.json({ message: "Your password was changed." });
    } catch (error) {
      console.error("Own password change failed:", error.message);
      response.status(500).json({ error: "Unable to change your password" });
    }
  });

  app.get("/api/records/:type", async (request, response) => {
    const sql = RECORD_QUERIES[request.params.type];

    if (!sql) {
      return response.status(400).json({ error: "Unknown record type" });
    }

    try {
      const [rows] = await db.query(sql);
      response.json(rows);
    } catch (error) {
      console.error("Records failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ARCHIVES
  app.get("/api/archives", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT module, record_id, record_name, detail, archived_at,
                COALESCE(archived_by, 'System') AS archived_by
         FROM vw_archives
         ORDER BY archived_at DESC, module`
      );
      response.json(rows);
    } catch (error) {
      console.error("Archives failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/archives/restore", async (request, response) => {
    const { module, recordId } = request.body;

    if (!module || !recordId) {
      return response.status(400).json({ error: "Module and record id are required" });
    }

    const allowed = ARCHIVE_ROLES[module];
    if (!allowed || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({ error: `Your role cannot restore ${module} records.` });
    }

    try {
      const output = await sharedProcedures.restoreArchive(
        [module, recordId, getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      response.json({ message: output.message });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Unable to restore the record" });
    }
  });

  app.post("/api/archives/archive", async (request, response) => {
    const { module, recordId } = request.body;

    if (!module || !recordId) {
      return response.status(400).json({ error: "Module and record id are required" });
    }

    const allowed = ARCHIVE_ROLES[module];
    if (!allowed || !allowed.includes(request.actor.roleName)) {
      return response.status(403).json({ error: `Your role cannot archive ${module} records.` });
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

  app.get("/api/cron/daily", async (request, response) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return response.status(503).json({ error: "CRON_SECRET is not set, so the daily job is switched off." });
    }
    if (!sameSecret(request.headers.authorization || "", `Bearer ${secret}`)) {
      return response.status(401).json({ error: "Not allowed" });
    }

    // each step on its own, so one failing does not stop the rest
    const steps = {
      penalties: () => managerModule.runPenaltySweep(),
      archives: () => adminModule.runArchiveSweep(),
      backup: () => adminModule.runDailyBackup(),
      sessions: () => removeExpiredSessions(),
      housekeeping: () => adminModule.removeExpiredDrafts()
    };
    const report = {};
    for (const name of Object.keys(steps)) {
      try {
        await steps[name]();
        report[name] = "ok";
      } catch (error) {
        console.error(`Daily job, ${name}:`, error.message);
        report[name] = "failed: " + error.message;
      }
    }
    console.log("Daily job:", JSON.stringify(report));
    response.json(report);
  });
}

module.exports = { registerSharedRoutes };
