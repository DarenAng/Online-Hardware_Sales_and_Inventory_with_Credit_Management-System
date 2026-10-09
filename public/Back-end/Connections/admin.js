// ============================================================
// admin.js -- Admin module (System Administration)
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// What is in this file:
//   - staff accounts: create (in 2 steps: review, then confirm), edit,
//     activate/deactivate, reset password
//   - the audit trail (who did what, and when)
//   - backup and recovery: writing a .sql backup file, restoring one,
//     the daily automatic backup, and the daily archive sweep
//   - Access Control: which screens each role can open
//   - the store settings (name, address, TIN, VAT, bank details) and the
//     receipt's layout
//
// server.js passes in the database and its helpers ("deps"). The access
// rules in server.js have already checked the user's role.
// ============================================================
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");   // the same as fs, but works with "await"
const crypto = require("crypto");
const mailer = require("../mailer");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const firstPasswordMessage = mailer.firstPasswordMessage;

// the text added to an audit entry to say whether the password was emailed
function emailedText(emailed, yesText) {
  if (emailed) {
    return yesText;
  }
  return " (password not emailed)";
}

function registerAdminRoutes(app, deps) {
  const {
    db, callProcedure, getActorId, writeAuditLog, fieldChanges, searchPrefix,
    requireRole, publishChange, ADMIN, USER_SELECT, withPresence, notOwnAccount,
    endSessionsForStaff, hashPassword, generatePassword, phoneComplaint, cleanPhone, cleanMiddleName,
    tinComplaint, cleanTin, DEFAULT_STORE_SETTINGS, AUDIT_TYPES, DB_NAME, sqlValue,
    sqlName, EXPECTED_PROCEDURES, countProcedures, proceduresAreMissing, proceduresLoadedCount, forgetProcedureCount,
    FEATURES, FEATURE_ROLES, findFeature, featuresOf, forgetFeatureOverrides, receiptLayoutFrom
  } = deps;

  // ==========================================
  // LOOKUPS
  // ==========================================
  app.get("/api/roles", async (request, response) => {
    try {
      const [rows] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");
      response.json(rows);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  // (GET /api/products was removed; GET /api/inventory/products replaces it)

  // ==========================================
  // STAFF ACCOUNTS
  // ==========================================

  // Handing over a new password: by mail when it works, otherwise back to the
  // administrator's screen to be read out, with the reason. A password is
  // NEVER written to the audit trail on either path.
  async function deliverFirstPassword({ email, name, roleName, password }) {
    if (!isMailConfigured()) {
      return {
        emailed: false,
        password: password,
        reason: "Mail is not set up on this server, so the password could not be sent."
      };
    }

    try {
      const [rows] = await db.query(
        "SELECT store_name FROM store_settings WHERE setting_id = 1");
      const storeName = (rows[0] && rows[0].store_name) || DEFAULT_STORE_SETTINGS.store_name;

      await sendMail(firstPasswordMessage({
        name: name,
        email: email,
        roleName: roleName,
        password: password,
        storeName: storeName
      }));

      return { emailed: true };
    } catch (error) {
      // the reason is passed on: "Username and Password not accepted" is the diagnosis
      console.error("Sending the first password failed:", error.message);
      return {
        emailed: false,
        password: password,
        reason: `The mail server refused the message: ${error.message}`
      };
    }
  }

  async function roleNameById(roleId) {
    const [rows] = await db.query(
      "SELECT role_name FROM roles WHERE role_id = ?", [roleId]);
    return (rows[0] && rows[0].role_name) || "staff";
  }

  // Drafts: creating an account is two requests with a person reading the
  // details in between. The draft lives here, in memory, keyed by id and held
  // to one administrator, so what was confirmed on screen is what is written.
  // Drafts expire on their own.
  const accountDrafts = new Map();      // draftId -> { by, kind, details, password, expires }
  const DRAFT_LIFE_MS = 10 * 60 * 1000; // long enough to read a card, short enough to forget
  const DRAFT_MAX = 200;                // one runaway client cannot grow this without limit

  function newAccountDraft(staffId, kind, details, password) {
    // swept here rather than on a timer: the map only grows when it is being used
    const now = Date.now();

    // remove the drafts that have expired
    for (const id of Array.from(accountDrafts.keys())) {
      if (accountDrafts.get(id).expires <= now) {
        accountDrafts.delete(id);
      }
    }

    // still too many? remove the one that expires first
    if (accountDrafts.size >= DRAFT_MAX) {
      let oldestId = null;
      let oldestExpires = Infinity;
      for (const id of accountDrafts.keys()) {
        const expires = accountDrafts.get(id).expires;
        if (expires < oldestExpires) {
          oldestExpires = expires;
          oldestId = id;
        }
      }
      if (oldestId !== null) accountDrafts.delete(oldestId);
    }

    const draftId = crypto.randomBytes(18).toString("base64url");
    accountDrafts.set(draftId, {
      by: staffId,
      kind: kind,
      details: details,
      password: password,
      expires: now + DRAFT_LIFE_MS
    });

    return { draftId: draftId, expiresInSeconds: Math.round(DRAFT_LIFE_MS / 1000) };
  }

  // Reads a draft and removes it: a draft is good for one confirmation, so a
  // double-clicked button is not a second account.
  function takeAccountDraft(draftId, staffId, kind) {
    const draft = accountDrafts.get(String(draftId || ""));

    if (!draft) return { error: "That review has expired. Fill the form in again." };
    accountDrafts.delete(String(draftId));

    if (draft.expires <= Date.now()) {
      return { error: "That review has expired. Fill the form in again." };
    }
    if (draft.by !== staffId) {
      return { error: "That review belongs to another administrator's session." };
    }
    if (draft.kind !== kind) {
      return { error: "That review was for a different kind of account." };
    }

    return { draft };
  }

  // Every staff member, including anyone with no login, with presence. The
  // filters are applied here so a large directory need not travel in full.
  app.get("/api/users", async (request, response) => {
    const status = String(request.query.status || "all").toLowerCase();
    const search = String(request.query.search || "").trim();

    const where = [];
    const params = [];

    if (status === "active") where.push("s.is_active = TRUE");
    else if (status === "inactive") where.push("s.is_active = FALSE");

    // starts-with, not contains; see searchPrefix
    if (search !== "") {
      where.push("(s.full_name LIKE ? OR u.email LIKE ? OR r.role_name LIKE ?)");
      const like = searchPrefix(search);
      params.push(like, like, like);
    }

    let filter = "";
    if (where.length > 0) {
      filter = ` WHERE ${where.join(" AND ")}`;
    }

    try {
      const [rows] = await db.query(`${USER_SELECT}${filter} ORDER BY s.staff_id`, params);
      response.json(withPresence(rows));
    } catch (error) {
      console.error("Loading users failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // Is this address already signing in to an account? Every role counts,
  // active or archived. staffId leaves out the account being edited.
  app.get("/api/users/email-check", async (request, response) => {
    const email = String(request.query.email || "").trim().toLowerCase();
    const staffId = Number(request.query.staffId) || 0;
    if (email === "") return response.json({ taken: false });

    try {
      const [rows] = await db.query(
        `SELECT r.role_name FROM users u
         JOIN staff s ON s.staff_id = u.staff_id
         JOIN roles r ON r.role_id = s.role_id
         WHERE LOWER(u.email) = ? AND u.staff_id <> ?
         LIMIT 1`,
        [email, staffId]);
      if (rows.length === 0) return response.json({ taken: false });
      response.json({ taken: true, roleName: rows[0].role_name });
    } catch (error) {
      console.error("Email check failed:", error.message);
      response.status(500).json({ error: "Unable to check the email address" });
    }
  });

  app.get("/api/users/:staffId", async (request, response) => {
    try {
      const [rows] = await db.query(`${USER_SELECT} WHERE s.staff_id = ?`, [request.params.staffId]);

      if (rows.length === 0) {
        return response.status(404).json({ error: "Staff record not found" });
      }

      response.json(rows[0]);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  // Step 1 of 2: check everything, make the password, hand the account back to
  // be read. Nothing is in the database when this returns.
  app.post("/api/users/draft", async (request, response) => {
    const { firstName, middleName, lastName, phone, roleId, email } = request.body;

    if (!firstName || !lastName || !roleId || !email || !String(phone || "").trim()) {
      return response.status(400).json({ error: "Name, phone, role and email are required" });
    }

    // the email is where the password goes, so an address that cannot receive one is refused
    const address = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    try {
      const [roles] = await db.query(
        "SELECT role_name FROM roles WHERE role_id = ?", [roleId]);
      if (roles.length === 0) {
        return response.status(400).json({ error: "The selected role does not exist." });
      }

      // the procedure checks this too; checking here keeps the answer in front of the form
      const [taken] = await db.query(
        `SELECT r.role_name FROM users u
         JOIN staff s ON s.staff_id = u.staff_id
         JOIN roles r ON r.role_id = s.role_id
         WHERE LOWER(u.email) = ?`, [address]);
      if (taken.length > 0) {
        return response.status(409).json({
          error: `The email ${address} is already used by another account (${taken[0].role_name}). ` +
                 "Each account needs its own email address, whatever its role."
        });
      }

      const details = {
        firstName: String(firstName).trim(),
        middleName: cleanMiddleName(middleName),
        lastName: String(lastName).trim(),
        phone: cleanPhone(phone),
        roleId: Number(roleId),
        roleName: roles[0].role_name,
        email: address
      };

      const password = generatePassword();
      const draft = newAccountDraft(request.actor.staffId, "staff", details, password);

      // the name as the directory will spell it (same as staff.full_name),
      // e.g. "Juan D. Cruz"
      let fullName = details.firstName;
      if (details.middleName) {
        fullName += ` ${details.middleName[0].toUpperCase()}.`;
      }
      fullName += ` ${details.lastName}`;

      // the answer: the draft id, the password, and every field of "details"
      // (the one place a readable password crosses the wire on purpose)
      const answer = Object.assign({
        draftId: draft.draftId,
        expiresInSeconds: draft.expiresInSeconds,
        password: password,
        willEmail: isMailConfigured()
      }, details);
      answer.fullName = fullName;

      response.json(answer);
    } catch (error) {
      console.error("Account review failed:", error.message);
      response.status(500).json({ error: "Unable to prepare the account" });
    }
  });

  // Step 2 of 2: create it from the draft and send the password.
  app.post("/api/users", async (request, response) => {
    const draftResult = takeAccountDraft(request.body.draftId, request.actor.staffId, "staff");

    if (draftResult.error) return response.status(410).json({ error: draftResult.error });

    const draft = draftResult.draft;
    const details = draft.details;

    try {
      const output = await callProcedure(
        "CALL sp_create_staff_account(?, ?, ?, ?, ?, ?, ?, @staff_id, @status_code, @message)",
        [details.firstName, details.middleName, details.lastName, details.phone,
         details.roleId, details.email, await hashPassword(draft.password)],
        ["staff_id", "status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // read back so the mail greets the person by the name the directory shows
      const [created] = await db.query(
        "SELECT full_name FROM staff WHERE staff_id = ?", [output.staff_id]);
      let name = details.firstName;
      if (created[0] && created[0].full_name) {
        name = created[0].full_name;
      }

      const delivery = await deliverFirstPassword({
        email: details.email,
        name: name,
        roleName: details.roleName,
        password: draft.password
      });

      // whether the mail went is in the trail; the password never is
      await writeAuditLog(
        request,
        "CREATE_ACCOUNT",
        `Created account for ${details.email}` +
          emailedText(delivery.emailed, " and emailed the first password"),
        { staff_id: output.staff_id, email: details.email, role_id: details.roleId,
          name: name, password_emailed: delivery.emailed }
      );

      response.json({
        message: output.message,
        staffId: output.staff_id,
        name: name,
        email: details.email,
        emailed: delivery.emailed,
        password: delivery.password,   // absent when the mail went; see above
        reason: delivery.reason
      });
    } catch (error) {
      console.error("Create account failed:", error.message);
      response.status(500).json({ error: "Unable to create the account" });
    }
  });

  app.put("/api/users/:staffId", notOwnAccount, async (request, response) => {
    const { firstName, middleName, lastName, phone, roleId, email } = request.body;

    if (!firstName || !lastName || !roleId) {
      return response.status(400).json({ error: "Name and role are required" });
    }

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    const newEmail = String(email || "").trim().toLowerCase();
    if (newEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    try {
      if (newEmail !== "") {
        const [taken] = await db.query(
          "SELECT user_id FROM users WHERE LOWER(email) = ? AND staff_id <> ?",
          [newEmail, request.params.staffId]);
        if (taken.length > 0) {
          return response.status(409).json({
            error: `The email ${newEmail} is already used by another account. ` +
                   "Each account needs its own email address, whatever its role."
          });
        }
      }

      // read before writing, so the audit entry can say what changed
      const [existing] = await db.query(
        `SELECT s.first_name, s.middle_name, s.last_name, s.phone,
                s.role_id, u.email
         FROM staff s LEFT JOIN users u ON u.staff_id = s.staff_id
         WHERE s.staff_id = ?`,
        [request.params.staffId]
      );
      const before = existing[0] || null;

      const output = await callProcedure(
        "CALL sp_update_staff_account(?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
        [request.params.staffId, firstName, cleanMiddleName(middleName), lastName,
         cleanPhone(phone), roleId, newEmail || null],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // A session carries the role and the sign-in email, so a change to
      // either ends the person's sessions and they sign in again as who they
      // now are. A corrected name or phone number is not a reason to sign
      // anyone out.
      let roleChanged = false;
      let emailChanged = false;
      if (before) {
        roleChanged = Number(before.role_id) !== Number(roleId);
        if (email) {
          const newEmail = String(email).trim().toLowerCase();
          const oldEmail = String(before.email || "").trim().toLowerCase();
          emailChanged = newEmail !== oldEmail;
        }
      }

      if (!before || roleChanged || emailChanged) {
        let reason = "Your sign-in email was changed by the System Administrator. Sign in again with the new one.";
        if (roleChanged) {
          reason = "Your role was changed by the System Administrator. Sign in again to continue as that role.";
        }
        endSessionsForStaff(request.params.staffId, null, reason);
      }

      const after = {
        first_name: firstName,
        middle_name: cleanMiddleName(middleName),
        last_name: lastName,
        phone: cleanPhone(phone),
        role_id: Number(roleId),
        email: newEmail || null
      };

      await writeAuditLog(
        request,
        "UPDATE_ACCOUNT",
        `Updated staff #${request.params.staffId}`,
        { staff_id: Number(request.params.staffId), changes: fieldChanges(before, after) }
      );
      response.json({ message: output.message });
    } catch (error) {
      console.error("Update account failed:", error.message);
      response.status(500).json({ error: "Unable to update the account" });
    }
  });

  app.patch("/api/users/:staffId/status", notOwnAccount, async (request, response) => {
    const isActive = request.body.isActive === true;

    try {
      const output = await callProcedure(
        "CALL sp_set_staff_status(?, ?, ?, @status_code, @message)",
        [request.params.staffId, isActive, request.actor.staffId],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      if (!isActive) endSessionsForStaff(request.params.staffId);

      let action = "DEACTIVATE_ACCOUNT";
      let words = "removed from";
      if (isActive) {
        action = "ACTIVATE_ACCOUNT";
        words = "restored to";
      }
      await writeAuditLog(
        request,
        action,
        `Staff #${request.params.staffId} was ${words} the active list`,
        { staff_id: Number(request.params.staffId),
          is_active: { before: !isActive, after: isActive } }
      );
      response.json({ message: output.message });
    } catch (error) {
      console.error("Status change failed:", error.message);
      response.status(500).json({ error: "Unable to change the account status" });
    }
  });

  // A login for somebody who already has a staff record: the same two steps
  // and the same review card; only the address is asked for.
  app.post("/api/users/:staffId/account/draft", notOwnAccount, async (request, response) => {
    const { email } = request.body;
    const staffId = Number(request.params.staffId);

    if (!email) {
      return response.status(400).json({ error: "An email address is required" });
    }

    const address = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    try {
      const [staff] = await db.query(
        `SELECT s.staff_id, s.full_name, s.phone, s.middle_name, r.role_name, u.user_id
         FROM staff s
         JOIN roles r ON r.role_id = s.role_id
         LEFT JOIN users u ON u.staff_id = s.staff_id
         WHERE s.staff_id = ?`,
        [staffId]
      );

      if (staff.length === 0) {
        return response.status(404).json({ error: "Staff record not found" });
      }
      if (staff[0].user_id) {
        return response.status(409).json({ error: "That person already has a login account." });
      }

      const [taken] = await db.query("SELECT user_id FROM users WHERE LOWER(email) = ?", [address]);
      if (taken.length > 0) {
        return response.status(409).json({
          error: `The email ${address} is already used by another account. ` +
                 "Each account needs its own email address, whatever its role."
        });
      }

      const details = {
        staffId: staffId,
        fullName: staff[0].full_name,
        middleName: staff[0].middle_name,
        phone: staff[0].phone,
        roleName: staff[0].role_name,
        email: address
      };

      const password = generatePassword();
      const draft = newAccountDraft(request.actor.staffId, "login", details, password);

      // the answer: the draft id, the password, and every field of "details"
      const answer = Object.assign({
        draftId: draft.draftId,
        expiresInSeconds: draft.expiresInSeconds,
        password: password,
        willEmail: isMailConfigured()
      }, details);

      response.json(answer);
    } catch (error) {
      console.error("Login review failed:", error.message);
      response.status(500).json({ error: "Unable to prepare the login account" });
    }
  });

  app.post("/api/users/:staffId/account", notOwnAccount, async (request, response) => {
    const draftResult = takeAccountDraft(request.body.draftId, request.actor.staffId, "login");

    if (draftResult.error) return response.status(410).json({ error: draftResult.error });

    const draft = draftResult.draft;
    const details = draft.details;

    // a draft cannot be confirmed against a different person by changing the URL
    if (details.staffId !== Number(request.params.staffId)) {
      return response.status(409).json({
        error: "That review was prepared for a different staff record."
      });
    }

    try {
      const output = await callProcedure(
        "CALL sp_create_login_for_staff(?, ?, ?, @status_code, @message)",
        [details.staffId, details.email, await hashPassword(draft.password)],
        ["status_code", "message"]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      const delivery = await deliverFirstPassword({
        email: details.email,
        name: details.fullName || "there",
        roleName: details.roleName || "staff",
        password: draft.password
      });

      await writeAuditLog(
        request,
        "CREATE_LOGIN",
        `Login created for staff #${details.staffId}` +
          emailedText(delivery.emailed, " and the first password was emailed"),
        { staff_id: details.staffId, email: details.email,
          password_emailed: delivery.emailed }
      );

      response.json({
        message: output.message,
        name: details.fullName,
        email: details.email,
        emailed: delivery.emailed,
        password: delivery.password,
        reason: delivery.reason
      });
    } catch (error) {
      console.error("Create login failed:", error.message);
      response.status(500).json({ error: "Unable to create the login account" });
    }
  });

  // Resetting a password is the same machinery as the first one: the server
  // makes it, mails it, and every session the person holds is ended. Shared
  // with the manager's Staff Passwords screen (manager.js), which passes the
  // roles it may touch and who it is, so the two can never drift apart.
  // Resolves to { status, body } for the route to send.
  async function resetStaffPassword(request, staffId, options) {
    const settings = options || {};
    const by = settings.by || "the administrator";

    const [rows] = await db.query(
      `SELECT s.full_name, u.email, r.role_name
       FROM staff s JOIN roles r ON r.role_id = s.role_id
       LEFT JOIN users u ON u.staff_id = s.staff_id
       WHERE s.staff_id = ?`,
      [staffId]);

    if (rows.length === 0) return { status: 404, body: { error: "Staff record not found" } };

    // checked here, against the row about to be reset, and never taken from the screen
    if (settings.roles && settings.roles.indexOf(rows[0].role_name) === -1) {
      return { status: 403, body: { error: settings.refusal || "You cannot reset this account's password." } };
    }
    if (!rows[0].email) {
      return { status: 404, body: { error: "This staff member has no login account." } };
    }

    const password = generatePassword();
    const output = await callProcedure(
      "CALL sp_reset_user_password(?, ?, @status_code, @message)",
      [staffId, await hashPassword(password)],
      ["status_code", "message"]
    );

    if (output.status_code !== 200) {
      return { status: output.status_code, body: { error: output.message } };
    }

    endSessionsForStaff(Number(staffId), null,
      `Your password was reset by ${by}. Sign in with the one that was sent to you.`);

    // a reset is also the way to release a held account
    const [released] = await db.query(
      `UPDATE users SET failed_attempts = 0, held_until = NULL
       WHERE staff_id = ? AND (failed_attempts > 0 OR held_until IS NOT NULL)`,
      [staffId]);
    if (released.affectedRows > 0) {
      await writeAuditLog(request, "ACCOUNT_RELEASED",
        `${rows[0].email} released from its sign-in hold by a password reset`,
        { staff_id: Number(staffId), email: rows[0].email });
    }

    const delivery = await deliverFirstPassword({
      email: rows[0].email,
      name: rows[0].full_name,
      roleName: rows[0].role_name,
      password: password
    });

    await writeAuditLog(request, "RESET_PASSWORD",
      `Password reset for ${rows[0].email} by ${by}` +
        emailedText(delivery.emailed, " and the new one was emailed"),
      { staff_id: Number(staffId), email: rows[0].email,
        password_emailed: delivery.emailed });

    return {
      status: 200,
      body: {
        message: "Password reset. The new one has to be changed on the next sign-in.",
        name: rows[0].full_name,
        email: rows[0].email,
        emailed: delivery.emailed,
        password: delivery.password,
        reason: delivery.reason
      }
    };
  }

  app.post("/api/users/:staffId/reset-password", notOwnAccount, async (request, response) => {
    try {
      const result = await resetStaffPassword(request, request.params.staffId, { by: "the administrator" });
      response.status(result.status).json(result.body);
    } catch (error) {
      console.error("Password reset failed:", error.message);
      response.status(500).json({ error: "Unable to reset the password" });
    }
  });

  // ==========================================
  // AUDIT LOGS -- newest first, filtered by kind, date range and free text
  // ==========================================
  // the WHERE clause both the table and the export use, from the query string
  function auditLogFilter(query) {
    const actionType = String(query.actionType || "all").toUpperCase();
    const search = String(query.search || "").trim();
    const from = String(query.from || "").trim();
    const to = String(query.to || "").trim();

    const where = [];
    const params = [];

    if (actionType !== "ALL" && AUDIT_TYPES.includes(actionType)) {
      where.push("l.action_type = ?");
      params.push(actionType);
    }

    // a date is inclusive of the whole day
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push("l.created_at >= ?");
      params.push(`${from} 00:00:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push("l.created_at <= ?");
      params.push(`${to} 23:59:59`);
    }

    if (search !== "") {
      where.push("(s.full_name LIKE ? OR l.action LIKE ? OR l.details LIKE ? OR l.ip_address LIKE ?)");
      const like = searchPrefix(search);
      params.push(like, like, like, like);
    }

    let filter = "";
    if (where.length > 0) {
      filter = ` WHERE ${where.join(" AND ")}`;
    }
    return { filter, params, from, to, actionType };
  }

  async function auditLogRows(query, limit) {
    const chosen = auditLogFilter(query);
    const [rows] = await db.query(
      `SELECT l.log_id, l.staff_id, l.action, l.action_type,
              l.details, l.metadata, l.ip_address, l.created_at,
              COALESCE(s.full_name, 'System') AS staff_name,
              COALESCE(l.role_name, r.role_name, 'System') AS role_name
       FROM audit_logs l
       LEFT JOIN staff s ON s.staff_id = l.staff_id
       LEFT JOIN roles r ON r.role_id = s.role_id
       ${chosen.filter}
       ORDER BY l.log_id DESC
       LIMIT ?`,
      chosen.params.concat([limit])
    );
    return { rows, chosen };
  }

  app.get("/api/audit-logs", async (request, response) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 500, 1), 2000);

    try {
      const { rows } = await auditLogRows(request.query, limit);
      response.json(rows);
    } catch (error) {
      console.error("Loading audit logs failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // AUDIT EXPORT -- the trail, filtered exactly as the screen has it, as an
  // Excel workbook or a PDF. Up to EXPORT_LIMIT rows, newest first.
  // ==========================================
  const EXPORT_LIMIT = 10000;
  const AUDIT_TYPE_LABELS = {
    CREATE: "Create", UPDATE: "Update", DELETE: "Delete", VOID: "Void", RESTORE: "Restore",
    BACKUP: "Backup", LOGIN: "Sign in", LOGOUT: "Sign out", LOGIN_FAILURE: "Failed sign-in",
    SECURITY: "Security", PAYMENT: "Payment", ACCESS: "Access", OTHER: "Other"
  };

  // the filters as one line under the title, e.g. "From 2026-09-01 to 2026-09-30, Sign in only"
  function exportFilterText(chosen, search) {
    const parts = [];
    if (chosen.from) parts.push("from " + chosen.from);
    if (chosen.to) parts.push("to " + chosen.to);
    if (chosen.actionType !== "ALL" && AUDIT_TYPE_LABELS[chosen.actionType]) {
      parts.push(AUDIT_TYPE_LABELS[chosen.actionType] + " entries only");
    }
    if (search) parts.push(`matching "${search}"`);
    if (parts.length === 0) return "All entries";
    const text = parts.join(", ");
    return text[0].toUpperCase() + text.slice(1);
  }

  function exportRowValues(row) {
    return [
      String(row.created_at || ""),
      String(row.staff_name || "") + (row.staff_id ? ` #${row.staff_id}` : ""),
      String(row.role_name || ""),
      String(row.ip_address || "Not recorded"),
      AUDIT_TYPE_LABELS[row.action_type] || String(row.action_type || ""),
      String(row.details || row.action || "")
    ];
  }

  const EXPORT_HEADINGS = ["Timestamp", "User", "Role", "IP Address", "Action Type", "Detail"];

  async function writeAuditWorkbook(response, rows, subtitle, fileName) {
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Audit Trail", {
      views: [{ state: "frozen", ySplit: 3 }]
    });

    sheet.columns = [
      { width: 21 }, { width: 28 }, { width: 22 }, { width: 18 }, { width: 16 }, { width: 80 }
    ];
    sheet.mergeCells("A1:F1");
    sheet.getCell("A1").value = "Audit Trail";
    sheet.getCell("A1").font = { bold: true, size: 14 };
    sheet.mergeCells("A2:F2");
    sheet.getCell("A2").value = `${subtitle} • ${rows.length} entries • exported ${new Date().toLocaleString("en-PH")}`;
    sheet.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF4D5661" } };

    const head = sheet.getRow(3);
    head.values = EXPORT_HEADINGS;
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B1F24" } };
    });
    sheet.autoFilter = { from: "A3", to: "F3" };

    for (const row of rows) {
      const added = sheet.addRow(exportRowValues(row));
      added.getCell(6).alignment = { wrapText: true, vertical: "top" };
    }

    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}.xlsx"`);
    await workbook.xlsx.write(response);
    response.end();
  }

  // PDF's built-in fonts carry Latin-1 and a few marks; anything else becomes "?"
  function pdfText(value) {
    return String(value)
      .replace(/₱/g, "PHP ")
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "?");
  }

  function writeAuditPdf(response, rows, subtitle, fileName) {
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, bufferPages: true });

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}.pdf"`);
    doc.pipe(response);

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const widths = [100, 120, 95, 80, 72];
    widths.push(usable - widths.reduce((sum, width) => sum + width, 0));
    const padding = 4;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;

    doc.font("Helvetica-Bold").fontSize(15).fillColor("#14181d").text("Audit Trail", left, doc.page.margins.top);
    doc.font("Helvetica").fontSize(9).fillColor("#4d5661")
      .text(pdfText(`${subtitle} • ${rows.length} entries • exported ${new Date().toLocaleString("en-PH")}`));
    doc.moveDown(0.6);

    const drawHeading = () => {
      const y = doc.y;
      doc.rect(left, y, usable, 18).fill("#1b1f24");
      let x = left;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff");
      EXPORT_HEADINGS.forEach((heading, index) => {
        doc.text(heading, x + padding, y + 5, { width: widths[index] - padding * 2, lineBreak: false });
        x += widths[index];
      });
      doc.y = y + 18;
    };

    drawHeading();
    doc.font("Helvetica").fontSize(8.5);

    rows.forEach((row, rowIndex) => {
      const values = exportRowValues(row).map(pdfText);
      const height = Math.max(...values.map((value, index) =>
        doc.heightOfString(value, { width: widths[index] - padding * 2 }))) + padding * 2;

      if (doc.y + height > bottom()) {
        doc.addPage();
        drawHeading();
        doc.font("Helvetica").fontSize(8.5);
      }

      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(left, y, usable, height).fill("#f3f4f6");
      let x = left;
      doc.fillColor("#14181d");
      values.forEach((value, index) => {
        doc.text(value, x + padding, y + padding, { width: widths[index] - padding * 2 });
        x += widths[index];
      });
      doc.y = y + height;
    });

    if (rows.length === 0) {
      doc.moveDown().fillColor("#4d5661").text("No entries match these filters.");
    }

    // page numbers along the foot
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      doc.font("Helvetica").fontSize(8).fillColor("#616b78").text(
        `Page ${index + 1} of ${range.count}`,
        left, doc.page.height - doc.page.margins.bottom - 8,
        { width: usable, align: "right", lineBreak: false });
    }

    doc.end();
  }

  app.get("/api/audit-logs/export/:format", async (request, response) => {
    const format = request.params.format;
    if (format !== "xlsx" && format !== "pdf") {
      return response.status(400).json({ error: "Export as xlsx or pdf." });
    }

    try {
      const { rows, chosen } = await auditLogRows(request.query, EXPORT_LIMIT);
      const search = String(request.query.search || "").trim();
      const subtitle = exportFilterText(chosen, search);
      const stamp = new Date();
      const fileName = "audit-trail_" + stamp.getFullYear() + "-" + twoDigits(stamp.getMonth() + 1) + "-" +
        twoDigits(stamp.getDate()) + "_" + twoDigits(stamp.getHours()) + twoDigits(stamp.getMinutes());

      await writeAuditLog(request, "EXPORT_AUDIT",
        `Exported ${rows.length} audit entries as ${format === "pdf" ? "PDF" : "Excel"} (${subtitle})`);

      if (format === "xlsx") {
        await writeAuditWorkbook(response, rows, subtitle, fileName);
      } else {
        writeAuditPdf(response, rows, subtitle, fileName);
      }
    } catch (error) {
      console.error("Audit export failed:", error.message);
      if (!response.headersSent) {
        response.status(500).json({ error: "Unable to export the audit trail" });
      } else {
        response.end();
      }
    }
  });

  app.get("/api/audit-logs/types", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT action_type, COUNT(*) AS entries
         FROM audit_logs
         GROUP BY action_type
         ORDER BY entries DESC`
      );
      response.json(rows);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // BACKUP & RECOVERY
  //
  // A backup is a complete .sql file (schema, rows, views, procedures) written
  // into backups/ and named after the moment it was taken. It opens and runs in
  // MySQL Workbench.
  // ==========================================
  // HARDWARE_BACKUP_DIR in .env can point the backups to another folder
  const BACKUP_DIR = process.env.HARDWARE_BACKUP_DIR || path.join(__dirname, "..", "..", "..", "backups");
  const BACKUP_PREFIX = "hardware_db_backup_";

  // Two kinds, told apart by name: one somebody pressed the button for is kept
  // until deleted; an automatic one (the daily backup, and the copy taken just
  // before a restore) carries its own prefix and is the only kind the rotation
  // may delete.
  const AUTO_PREFIX = "hardware_db_auto_";

  // What a backup file name looks like, for example:
  //   hardware_db_backup_2026-09-18_1101.sql     (made by hand)
  //   hardware_db_auto_2026-09-18_1101-2.sql     (automatic, 2nd one that minute)
  const BACKUP_NAME =
    /^hardware_db_(backup|auto)_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;
  const AUTO_NAME = /^hardware_db_auto_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;

  async function ensureBackupFolder() {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
  }

  // 5 -> "05"
  function twoDigits(number) {
    return String(number).padStart(2, "0");
  }

  // e.g. "hardware_db_backup_2026-09-18_1101.sql"
  function backupFileName(when, prefix) {
    const date = when.getFullYear() + "-" + twoDigits(when.getMonth() + 1) + "-" + twoDigits(when.getDate());
    const time = twoDigits(when.getHours()) + twoDigits(when.getMinutes());
    return (prefix || BACKUP_PREFIX) + date + "_" + time + ".sql";
  }

  // a file name that is not taken yet (adds -2, -3, ... when needed)
  async function freeBackupPath(when, prefix) {
    await ensureBackupFolder();
    const base = backupFileName(when, prefix);
    let name = base;
    let counter = 2;

    while (fs.existsSync(path.join(BACKUP_DIR, name))) {
      name = base.replace(/\.sql$/, `-${counter}.sql`);
      counter += 1;
    }
    return { name: name, fullPath: path.join(BACKUP_DIR, name) };
  }

  // Generated columns cannot be written back; read from the catalogue so a
  // new one never breaks a restore. Only STORED and VIRTUAL generated
  // columns: MySQL 8 also marks every DEFAULT CURRENT_TIMESTAMP column
  // "DEFAULT_GENERATED", and those hold real dates (sale_date, payment_date)
  // that a restore must bring back.
  async function generatedColumnsOf(table) {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         AND (EXTRA LIKE '%STORED GENERATED%' OR EXTRA LIKE '%VIRTUAL GENERATED%')`,
      [DB_NAME, table]
    );
    return rows.map((row) => row.COLUMN_NAME);
  }

  // a table's columns in their order, read from the catalogue
  async function columnsOf(table) {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [DB_NAME, table]
    );
    return rows.map((row) => row.COLUMN_NAME);
  }

  async function listBaseTables() {
    const [rows] = await db.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [DB_NAME]
    );
    return rows.map((row) => row.TABLE_NAME);
  }

  // in the order they can be created: a view that names another view goes after it
  async function listViews() {
    const [rows] = await db.query(
      `SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [DB_NAME]
    );

    // the views still to be placed in order
    const pending = [];
    for (const row of rows) {
      pending.push({
        name: row.TABLE_NAME,
        definition: String(row.VIEW_DEFINITION || "").toLowerCase()
      });
    }

    const ordered = [];

    while (pending.length > 0) {
      // find a view that does not use any other view that is still pending
      let chosen = 0;
      for (let i = 0; i < pending.length; i++) {
        let usesPending = false;
        for (const other of pending) {
          if (other !== pending[i] &&
              pending[i].definition.includes("`" + other.name.toLowerCase() + "`")) {
            usesPending = true;
          }
        }
        if (!usesPending) {
          chosen = i;
          break;
        }
      }

      // take it out of "pending" and put it next in the order
      ordered.push(pending[chosen].name);
      pending.splice(chosen, 1);
    }

    return ordered;
  }

  async function listProcedures() {
    const [rows] = await db.query(
      `SELECT ROUTINE_NAME FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
       ORDER BY ROUTINE_NAME`,
      [DB_NAME]
    );
    return rows.map((row) => row.ROUTINE_NAME);
  }

  // A DEFINER names a MySQL account that may not exist on another computer,
  // so it is removed. Example: "DEFINER=`root`@`localhost` " -> ""
  function stripDefiner(sql) {
    return String(sql).replace(/DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*/gi, "");
  }

  // Writes the whole database to one .sql file. Pass AUTO_PREFIX for a rotating one.
  async function writeBackupFile(prefix) {
    const now = new Date();
    const file = await freeBackupPath(now, prefix);
    const name = file.name;
    const fullPath = file.fullPath;

    const tables = await listBaseTables();
    const views = await listViews();
    const procedures = await listProcedures();

    // "out" writes into the file bit by bit.
    // write(text) adds text to the file, and "await write(...)" waits until it is written.
    const out = fs.createWriteStream(fullPath, { encoding: "utf8" });
    function write(text) {
      return new Promise(function (resolve, reject) {
        out.write(text, function (error) {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    let rowTotal = 0;

    try {
      await write(
        `-- Lucelyn Hardware - full database backup\n` +
        `-- Database : ${DB_NAME}\n` +
        `-- Taken on : ${now.toISOString()}\n` +
        `-- Contains : ${tables.length} tables, ${views.length} views, ${procedures.length} procedures\n` +
        `--\n` +
        `-- Restore from the Backup & Recovery screen, or run this file in\n` +
        `-- MySQL Workbench. It rebuilds every table and reloads every row.\n\n` +
        `SET FOREIGN_KEY_CHECKS = 0;\n` +
        `SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n`
      );

      for (const view of views) {
        await write(`DROP VIEW IF EXISTS ${sqlName(view)};\n`);
      }
      await write("\n");

      for (const table of tables) {
        const [createdRows] = await db.query(`SHOW CREATE TABLE ${sqlName(table)}`);
        const created = createdRows[0];
        await write(`-- ----------------------------------------\n`);
        await write(`-- Table: ${table}\n`);
        await write(`-- ----------------------------------------\n`);
        await write(`DROP TABLE IF EXISTS ${sqlName(table)};\n`);
        await write(`${stripDefiner(created["Create Table"])};\n\n`);

        // the columns to save (generated columns are skipped: MySQL makes them itself)
        const skip = await generatedColumnsOf(table);
        const columns = (await columnsOf(table)).filter((column) => !skip.includes(column));
        const columnList = columns.map((column) => sqlName(column)).join(", ");

        // The rows are streamed from MySQL and written 100 at a time, so a large
        // table never sits in memory whole: INSERT INTO t (a, b) VALUES (1, 2), ...;
        let count = 0;
        let batch = [];
        const flush = async () => {
          if (batch.length === 0) return;
          await write(`INSERT INTO ${sqlName(table)} (${columnList}) VALUES\n`);
          await write(batch.join(",\n") + ";\n");
          batch = [];
        };

        const connection = await db.getConnection();
        try {
          const stream = connection.connection
            .query(`SELECT ${columnList} FROM ${sqlName(table)}`)
            .stream({ highWaterMark: 200 });
          for await (const row of stream) {
            batch.push("  (" + columns.map((column) => sqlValue(row[column])).join(", ") + ")");
            count += 1;
            if (batch.length >= 100) await flush();
          }
          await flush();
        } finally {
          connection.release();
        }

        rowTotal += count;
        await write(count === 0 ? `-- no rows\n\n` : `-- ${count} row(s)\n\n`);
      }

      for (const view of views) {
        const [createdRows] = await db.query(`SHOW CREATE VIEW ${sqlName(view)}`);
        const created = createdRows[0];
        await write(`-- View: ${view}\n`);
        await write(`${stripDefiner(created["Create View"])};\n\n`);
      }

      if (procedures.length > 0) {
        await write(`-- ----------------------------------------\n`);
        await write(`-- Stored procedures\n`);
        await write(`-- ----------------------------------------\n`);
        await write(`DELIMITER //\n`);

        for (const procedure of procedures) {
          const [createdRows] = await db.query(`SHOW CREATE PROCEDURE ${sqlName(procedure)}`);
          const created = createdRows[0];
          await write(`DROP PROCEDURE IF EXISTS ${sqlName(procedure)} //\n`);
          await write(`${stripDefiner(created["Create Procedure"])} //\n\n`);
        }

        await write(`DELIMITER ;\n\n`);
      }

      await write(`SET FOREIGN_KEY_CHECKS = 1;\n`);
    } finally {
      // close the file and wait until it is closed
      await new Promise(function (resolve) {
        out.end(resolve);
      });
    }

    const stats = await fsp.stat(fullPath);

    return {
      fileName: name,
      createdAt: now.toISOString(),
      bytes: stats.size,
      tableCount: tables.length,
      viewCount: views.length,
      procedureCount: procedures.length,
      rowCount: rowTotal
    };
  }

  // Splits the text of a .sql file into separate statements (like MySQL
  // Workbench does). It reads the text one character at a time:
  //   - "DELIMITER //" changes what ends a statement (used around procedures)
  //   - text inside quotes '...' "..." `...` is copied as it is
  //     (a ; inside quotes does not end a statement)
  //   - comments (-- ..., # ..., /* ... */) are skipped
  //   - the delimiter (normally ;) ends the current statement
  //   - any other character is added to the current statement
  function splitSqlStatements(sql) {
    const statements = [];
    let delimiter = ";";
    let current = "";
    let index = 0;

    while (index < sql.length) {
      const character = sql[index];
      const rest = sql.slice(index);

      // a "DELIMITER xx" line
      if (current.trim() === "" && /^delimiter[ \t]+/i.test(rest)) {
        let lineEnd = rest.indexOf("\n");
        if (lineEnd === -1) {
          lineEnd = rest.length;   // the last line of the file
        }
        const line = rest.slice(0, lineEnd);
        delimiter = line.replace(/^delimiter[ \t]+/i, "").trim() || ";";
        index += line.length;
        current = "";
        continue;
      }

      // text in quotes: copy everything up to the closing quote
      if (character === "'" || character === '"' || character === "`") {
        const quote = character;
        current += character;
        index += 1;

        while (index < sql.length) {
          // a backslash keeps the next character (e.g. \' inside '...')
          if (sql[index] === "\\" && quote !== "`") {
            current += sql.slice(index, index + 2);
            index += 2;
            continue;
          }
          if (sql[index] === quote) {
            // two quotes in a row ('') are a quote inside the text
            if (sql[index + 1] === quote) {
              current += quote + quote;
              index += 2;
              continue;
            }
            current += quote;
            index += 1;
            break;
          }
          current += sql[index];
          index += 1;
        }
        continue;
      }

      // a "-- comment" or "# comment": skip to the end of the line
      const isDashComment = rest.startsWith("--") &&
        (rest[2] === " " || rest[2] === "\t" || rest[2] === "\n");
      if (isDashComment || character === "#") {
        const stop = sql.indexOf("\n", index);
        if (stop === -1) {
          index = sql.length;
        } else {
          index = stop + 1;
        }
        continue;
      }

      // a "/* comment */": skip to the closing */
      if (rest.startsWith("/*")) {
        const stop = sql.indexOf("*/", index + 2);
        if (stop === -1) {
          index = sql.length;
        } else {
          index = stop + 2;
        }
        continue;
      }

      // the delimiter: the current statement is finished
      if (rest.startsWith(delimiter)) {
        if (current.trim() !== "") statements.push(current.trim());
        current = "";
        index += delimiter.length;
        continue;
      }

      current += character;
      index += 1;
    }

    if (current.trim() !== "") statements.push(current.trim());
    return statements;
  }

  // Runs a backup file back into the database on one connection. It cannot be
  // all-or-nothing: a dump is mostly DROP TABLE and CREATE TABLE, and MySQL
  // commits each of those on its own, so a file that fails halfway leaves the
  // tables it had reached rebuilt and the rest as they were. The routes below
  // therefore take a full backup first, and name it in their reply, so a
  // restore that went wrong is undone from the same screen. A restore raises
  // restoreInProgress and the backup timer stands down while it is up, so a
  // half-restored database is never dumped by the automatic backup.
  let restoreInProgress = false;

  async function runSqlScript(sql) {
    const statements = splitSqlStatements(sql);

    if (statements.length === 0) {
      throw new Error("That file contains no SQL statements.");
    }

    const connection = await db.getConnection();
    restoreInProgress = true;

    try {
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");

      for (const statement of statements) {
        // skip "USE some_database" so the file cannot switch to another database
        if (/^use[\s`]/i.test(statement)) continue;
        await connection.query(statement);
      }

      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      return statements.length;
    } finally {
      restoreInProgress = false;
      connection.release();
    }
  }

  // ==========================================
  // THE DAILY BACKUP
  //
  // One full backup a day, at BACKUP_HOUR (2 in the morning unless .env says
  // otherwise), not after every transaction: dumping the whole database on
  // every sale made a busy till lag. A check runs every few minutes and writes
  // the day's file once the hour has come; a server that was asleep or
  // restarted catches up on its next check. The newest AUTO_KEEP automatic
  // files are kept and older ones are deleted. Backups taken by hand are never
  // deleted by the system, and there can be at most MANUAL_LIMIT of them.
  // The hour is the server's clock: set TZ=Asia/Manila in .env on a cloud host.
  // ==========================================
  function settingNumber(name, fallback, low, high) {
    const value = Number(process.env[name]);
    if (!Number.isInteger(value) || value < low || value > high) return fallback;
    return value;
  }
  const AUTO_HOUR = settingNumber("BACKUP_HOUR", 2, 0, 23);
  const AUTO_KEEP = settingNumber("BACKUP_KEEP_DAYS", 30, 1, 365);
  const MANUAL_LIMIT = settingNumber("BACKUP_MANUAL_LIMIT", 20, 1, 200);
  const AUTO_CHECK_MS = 10 * 60 * 1000;     // how often the day's backup is looked for
  const AUTO_FIRST_CHECK_MS = 60 * 1000;    // a minute after start, so starting stays quick

  // The on/off switch lives in a small file beside the backups, so a server
  // restart does not quietly turn the backup back on for someone who switched it
  // off. Missing or unreadable means on, the safe default.
  const AUTO_SWITCH_FILE = path.join(BACKUP_DIR, "auto-backup.json");

  async function readAutoBackupSwitch() {
    try {
      const parsed = JSON.parse(await fsp.readFile(AUTO_SWITCH_FILE, "utf8"));
      return parsed.enabled !== false;
    } catch (error) {
      return true;
    }
  }

  async function writeAutoBackupSwitch(enabled) {
    await ensureBackupFolder();
    await fsp.writeFile(AUTO_SWITCH_FILE,
      JSON.stringify({ enabled: enabled, changedAt: new Date().toISOString() }, null, 2) + "\n");
  }

  // the backup files in the folder, by kind, oldest first (the stamp is year-first)
  async function backupNames() {
    await ensureBackupFolder();
    const all = await fsp.readdir(BACKUP_DIR);
    const automatic = all.filter((name) => AUTO_NAME.test(name)).sort();
    const manual = all.filter((name) => BACKUP_NAME.test(name) && !AUTO_NAME.test(name)).sort();
    return { automatic, manual };
  }

  // removes the oldest automatic backups until AUTO_KEEP remain; never touches a manual one
  async function rotateAutoBackups() {
    const names = (await backupNames()).automatic;
    if (names.length <= AUTO_KEEP) return 0;

    const doomed = names.slice(0, names.length - AUTO_KEEP);
    for (const name of doomed) {
      try {
        await fsp.unlink(path.join(BACKUP_DIR, name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;   // already gone is fine
      }
    }
    return doomed.length;
  }

  // A rotation is only safe if what it rolls over is known good. If the
  // database is missing procedures the backup is still written and nothing
  // is deleted, so the last good file is never rotated away.
  async function safeToRotate() {
    return !(await proceduresAreMissing());
  }

  // the state the Backup & Recovery screen reads, from the server not a constant
  const autoBackup = {
    enabled: true,         // the switch, read from AUTO_SWITCH_FILE at startup
    running: false,        // a dump is in flight right now
    lastFileName: null,
    lastAt: null,
    lastError: null,
    failures: 0
  };

  // "2026-09-18" for today on the server's clock
  function todayStamp() {
    const now = new Date();
    return now.getFullYear() + "-" + twoDigits(now.getMonth() + 1) + "-" + twoDigits(now.getDate());
  }

  async function runAutoBackup() {
    if (!autoBackup.enabled || autoBackup.running) return;

    // a dump taken halfway through a restore is a dump of neither database
    if (restoreInProgress) return;

    autoBackup.running = true;

    try {
      const summary = await writeBackupFile(AUTO_PREFIX);
      if (await safeToRotate()) await rotateAutoBackups();

      autoBackup.lastFileName = summary.fileName;
      autoBackup.lastAt = summary.createdAt;
      if (autoBackup.lastError) console.log(`The daily backup is working again (${summary.fileName}).`);
      autoBackup.lastError = null;
      autoBackup.failures = 0;
    } catch (error) {
      autoBackup.failures += 1;
      autoBackup.lastError = error.message;

      // said once when it starts failing, not on every check
      if (autoBackup.failures === 1) {
        console.error("The daily backup failed:", error.message);
        try {
          await writeAuditLog(
            { staffId: null, request: null },
            "BACKUP_FAILED",
            `The daily backup failed: ${error.message}`
          );
        } catch (ignored) { /* the database is the thing that is broken */ }
      }
    } finally {
      autoBackup.running = false;
    }
  }

  // writes today's backup once the hour has come, if today has none yet
  async function dailyBackupCheck() {
    if (!autoBackup.enabled || autoBackup.running) return;
    if (new Date().getHours() < AUTO_HOUR) return;

    try {
      const today = AUTO_PREFIX + todayStamp();
      const names = (await backupNames()).automatic;
      if (names.some((name) => name.startsWith(today))) return;
    } catch (error) {
      return;     // the folder cannot be read; the next check tries again
    }

    // a failed attempt waits for the next check rather than retrying at once
    await runAutoBackup();
  }

  async function startAutoBackup() {
    autoBackup.enabled = await readAutoBackupSwitch();

    // the screen names the last automatic file even before today's is written
    try {
      const names = (await backupNames()).automatic;
      if (names.length > 0) autoBackup.lastFileName = names[names.length - 1];
    } catch (error) { /* an empty or missing folder */ }

    if (!autoBackup.enabled) {
      console.log("The daily backup is switched off. Turn it on from the Backup & Recovery screen.");
    } else {
      console.log(`Daily backup at ${twoDigits(AUTO_HOUR)}:00, keeping the last ${AUTO_KEEP}. ` +
        `Up to ${MANUAL_LIMIT} backups taken by hand are kept until deleted.`);
    }

    const first = setTimeout(dailyBackupCheck, AUTO_FIRST_CHECK_MS);
    const timer = setInterval(dailyBackupCheck, AUTO_CHECK_MS);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  // The archive sweep: once at startup and once a day. The rules are in
  // sp_sweep_archives beside the manual ones in sp_archive_record; here it is
  // only announced on the live channel.
  const ARCHIVE_SWEEP_MS = 24 * 60 * 60 * 1000;

  async function runArchiveSweep() {
    if (await proceduresAreMissing()) return;   // nothing can be written anyway

    try {
      const output = await callProcedure(
        "CALL sp_sweep_archives(@deliveries, @materials)", [],
        ["deliveries", "materials"]);

      const deliveries = Number(output.deliveries) || 0;
      const materials = Number(output.materials) || 0;
      if (deliveries < 0) {
        console.error("Archive sweep failed inside the database; see the MySQL log.");
        return;
      }
      if (deliveries > 0 || materials > 0) {
        console.log(`Archive sweep: put away ${deliveries} closed ` +
          `${deliveries === 1 ? "delivery" : "deliveries"} and ${materials} idle ` +
          `${materials === 1 ? "material" : "materials"}.`);
        publishChange("archives", "sweep", null);
        if (deliveries > 0) publishChange("deliveries", "sweep", null);
        if (materials > 0) publishChange("inventory", "sweep", null);
      }
    } catch (error) {
      console.error("Archive sweep failed:", error.message);
    }
  }

  function startArchiveSweep() {
    runArchiveSweep();
    const timer = setInterval(runArchiveSweep, ARCHIVE_SWEEP_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  // Screens by role: read as a whole, written one cell at a time.
  app.get("/api/features", async (request, response) => {
    try {
      const [roleRows] = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");

      // the roles that appear as columns in the Access Control table
      const roles = [];
      for (const row of roleRows) {
        if (FEATURE_ROLES.includes(row.role_name)) {
          roles.push(row);
        }
      }

      // perRole[role name][screen key] = what that role has for that screen
      const perRole = {};
      for (const role of roles) {
        perRole[role.role_name] = {};
        const roleFeatures = await featuresOf(role.role_name);
        for (const f of roleFeatures) {
          perRole[role.role_name][f.key] = f;
        }
      }

      // one row per screen, with one cell per role
      const featureRows = [];
      for (const feature of FEATURES) {
        const cells = {};
        for (const role of roles) {
          const held = perRole[role.role_name][feature.key] || null;

          if (held) {
            cells[role.role_name] = { available: true, byDefault: held.byDefault, held: held.held, overridden: held.overridden,
                  note: held.note, grantedBy: held.grantedBy, updatedAt: held.updatedAt };
          } else {
            cells[role.role_name] = { available: false, byDefault: false, held: false, overridden: false };
          }
        }
        featureRows.push({
          key: feature.key,
          name: feature.name,
          module: feature.module,
          description: feature.description,
          roles: cells
        });
      }

      response.json({
        roles: roles,
        features: featureRows
      });
    } catch (error) {
      console.error("Listing screens by role failed:", error.message);
      response.status(500).json({ error: "Unable to list the screens by role" });
    }
  });

  // what one role has for one screen (from the list featuresOf gives back)
  async function roleFeature(roleName, featureKey) {
    const list = await featuresOf(roleName);
    for (const f of list) {
      if (f.key === featureKey) {
        return f;
      }
    }
    return undefined;
  }

  // Setting a cell back to the role's default removes the override row rather
  // than writing one that agrees with the page.
  app.put("/api/features/:featureKey/roles/:roleId", async (request, response) => {
    const feature = findFeature(request.params.featureKey);
    const roleId = Number(request.params.roleId);
    const body = request.body || {};
    const wanted = body.granted === true;
    const note = String(body.note || "").trim().slice(0, 255);

    if (!feature) return response.status(404).json({ error: "No screen is listed under that name." });
    if (typeof body.granted !== "boolean") {
      return response.status(400).json({ error: "Say whether the screen is granted: true or false." });
    }

    try {
      const [roles] = await db.query("SELECT role_id, role_name FROM roles WHERE role_id = ?", [roleId]);
      if (roles.length === 0) return response.status(404).json({ error: "No such role." });
      const role = roles[0];

      if (role.role_name === ADMIN) {
        return response.status(403).json({ error: "The System Administrator holds every screen by role. Nothing here is granted or taken away." });
      }
      if (!feature.available.includes(role.role_name)) {
        return response.status(400).json({
          error: `The ${role.role_name} dashboard has no ${feature.name} screen to show, so it cannot be granted there.`
        });
      }

      const before = await roleFeature(role.role_name, feature.key);
      const byDefault = feature.defaults.includes(role.role_name);

      if (before.held === wanted && (wanted === byDefault || (before.note || "") === note)) {
        let holds = "do not hold";
        if (wanted) {
          holds = "hold";
        }
        return response.json({
          message: `Nothing changed: ${role.role_name} accounts already ${holds} ${feature.name}.`,
          changed: false
        });
      }

      if (wanted === byDefault) {
        await db.query("DELETE FROM role_feature_permissions WHERE role_id = ? AND feature_key = ?",
          [roleId, feature.key]);
      } else {
        await db.query(
          `INSERT INTO role_feature_permissions (role_id, feature_key, is_granted, note, granted_by_staff_id)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE is_granted = VALUES(is_granted), note = VALUES(note),
                                   granted_by_staff_id = VALUES(granted_by_staff_id)`,
          [roleId, feature.key, wanted, note || null, request.actor.staffId]);
      }
      forgetFeatureOverrides();

      // "again" when the screen goes back to how the role has it by default
      let message;
      if (wanted && byDefault) {
        message = `${feature.name} is now on the ${role.role_name} menu again.`;
      } else if (wanted) {
        message = `${feature.name} is now on the ${role.role_name} menu.`;
      } else if (byDefault) {
        message = `${feature.name} is off the ${role.role_name} menu.`;
      } else {
        message = `${feature.name} is off the ${role.role_name} menu again.`;
      }

      if (before.held !== wanted) {
        let action = "REVOKE_SCREEN";
        let onOff = "off";
        if (wanted) {
          action = "GRANT_SCREEN";
          onOff = "on";
        }
        await writeAuditLog(request, action,
          `${feature.name} switched ${onOff} for ${role.role_name} accounts`,
          { role_id: roleId, role_name: role.role_name, feature_key: feature.key, feature_name: feature.name,
            by_default: byDefault,
            changes: fieldChanges({ held: before.held }, { held: wanted }), note: note || null });
      }

      const after = await roleFeature(role.role_name, feature.key);
      response.json({ message: message, changed: true, cell: after });
    } catch (error) {
      console.error("Switching a screen failed:", error.message);
      response.status(500).json({ error: "Unable to change that screen" });
    }
  });

  // The list, the daily backup's state and the limits. The folder's path on
  // the server is not sent: it is no business of a browser's.
  app.get("/api/backups", async (request, response) => {
    try {
      const names = await backupNames();

      // one entry per backup file in the folder
      const files = [];
      for (const name of names.automatic.concat(names.manual)) {
        const stats = await fsp.stat(path.join(BACKUP_DIR, name));
        files.push({
          fileName: name,
          bytes: stats.size,
          createdAt: stats.mtime.toISOString(),
          // so a row can say which kind it is
          automatic: AUTO_NAME.test(name)
        });
      }

      // newest first
      files.sort(function (left, right) {
        return right.createdAt.localeCompare(left.createdAt);
      });

      response.json({
        files: files,
        auto: {
          enabled: autoBackup.enabled,
          schedule: "daily",
          hour: AUTO_HOUR,
          keep: AUTO_KEEP,
          lastFileName: autoBackup.lastFileName,
          lastAt: autoBackup.lastAt,
          lastError: autoBackup.lastError,
          failures: autoBackup.failures
        },
        limits: {
          automatic: AUTO_KEEP,
          manual: MANUAL_LIMIT,
          manualCount: names.manual.length
        },
        // so the screen can say the one thing that stops every write
        procedures: {
          loaded: proceduresLoadedCount(),
          expected: EXPECTED_PROCEDURES
        }
      });
    } catch (error) {
      console.error("Backup list failed:", error.message);
      response.status(500).json({ error: "Unable to read the backup folder" });
    }
  });

  // The switch. Off stops the daily backup (nothing new is written, nothing
  // old is deleted); on writes today's at the next check if the hour has passed.
  app.put("/api/backups/auto", requireRole(ADMIN), async (request, response) => {
    const enabled = request.body && request.body.enabled;
    if (typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Say whether the daily backup is on or off." });
    }

    try {
      await writeAutoBackupSwitch(enabled);
      autoBackup.enabled = enabled;

      if (enabled) {
        await writeAuditLog(request, "AUTO_BACKUP_ON",
          `Daily backup switched on (at ${twoDigits(AUTO_HOUR)}:00, keeping the last ${AUTO_KEEP})`);
        dailyBackupCheck();
        response.json({
          message: `The daily backup is on. It runs every day at ${twoDigits(AUTO_HOUR)}:00.`,
          enabled: enabled
        });
      } else {
        await writeAuditLog(request, "AUTO_BACKUP_OFF", "Daily backup switched off");
        response.json({
          message: "The daily backup is off. Nothing new is saved until it is switched back on.",
          enabled: enabled
        });
      }
    } catch (error) {
      console.error("Changing the daily backup failed:", error.message);
      response.status(500).json({ error: "Unable to change the daily backup: " + error.message });
    }
  });

  // Run Backup Now. Backups taken by hand are kept until deleted, so there is
  // a limit to them: at the limit, an old one has to be deleted first.
  app.post("/api/backups", requireRole(ADMIN), async (request, response) => {
    try {
      const names = await backupNames();
      if (names.manual.length >= MANUAL_LIMIT) {
        return response.status(409).json({
          error: `There are already ${names.manual.length} manual backups, the most this system keeps. ` +
                 "Delete one you no longer need, then run the backup again."
        });
      }

      const summary = await writeBackupFile();

      await writeAuditLog(request, "BACKUP",
        `${summary.fileName} (${summary.tableCount} tables, ${summary.rowCount} rows)`);

      // the message plus every field of "summary" (fileName, bytes, ...)
      const answer = Object.assign({ message: `Backup saved as ${summary.fileName}.` }, summary);
      response.json(answer);
    } catch (error) {
      console.error("Backup failed:", error.message);
      response.status(500).json({ error: "Unable to create the backup: " + error.message });
    }
  });

  app.get("/api/backups/:fileName", async (request, response) => {
    const name = request.params.fileName;

    if (!BACKUP_NAME.test(name)) {
      return response.status(400).json({ error: "That is not a backup file name." });
    }

    const fullPath = path.join(BACKUP_DIR, name);

    if (!fs.existsSync(fullPath)) {
      return response.status(404).json({ error: "That backup is no longer in the folder." });
    }

    response.download(fullPath, name);
  });

  app.delete("/api/backups/:fileName", requireRole(ADMIN), async (request, response) => {
    const name = request.params.fileName;

    if (!BACKUP_NAME.test(name)) {
      return response.status(400).json({ error: "That is not a backup file name." });
    }

    try {
      await fsp.unlink(path.join(BACKUP_DIR, name));
      await writeAuditLog(request, "BACKUP_DELETE", name);
      response.json({ message: `${name} deleted.` });
    } catch (error) {
      if (error.code === "ENOENT") {
        return response.status(404).json({ error: "That backup is no longer in the folder." });
      }
      console.error("Backup delete failed:", error.message);
      response.status(500).json({ error: "Unable to delete that backup" });
    }
  });

  // A backup taken without procedures restores without error and leaves the
  // system unable to save, so the count is taken AFTER the restore and reported
  // with the success. Returns "" when all is well.
  async function restoreShortfall() {
    try {
      forgetProcedureCount();                  // force a fresh count
      const total = await countProcedures();
      if (total >= EXPECTED_PROCEDURES) return "";

      return ` WARNING: that backup did not carry the stored procedures -- this ` +
        `database now has ${total} of ${EXPECTED_PROCEDURES} and nothing can be ` +
        `saved until they are put back. Run ` +
        `public/database/2-RUN-SECOND-stored-procedures.sql. Your data is intact.`;
    } catch (error) {
      return "";
    }
  }

  app.post("/api/backups/:fileName/restore", requireRole(ADMIN), async (request, response) => {
    const name = request.params.fileName;

    if (!BACKUP_NAME.test(name)) {
      return response.status(400).json({ error: "That is not a backup file name." });
    }

    const fullPath = path.join(BACKUP_DIR, name);

    if (!fs.existsSync(fullPath)) {
      return response.status(404).json({ error: "That backup is no longer in the folder." });
    }

    let safety = null;
    try {
      // the database as it is now, kept in the same folder in case this has to be undone
      safety = await writeBackupFile(AUTO_PREFIX);
      const count = await runSqlScript(await fsp.readFile(fullPath, "utf8"));
      await writeAuditLog(request, "RESTORE", `Restored from ${name}; the database before it is ${safety.fileName}`);
      response.json({
        message: `Database restored from ${name}. ${count} statements ran. ` +
          `The database as it was before is kept as ${safety.fileName}.` + (await restoreShortfall())
      });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Restore failed: " + error.message + restoreUndoNote(safety) });
    }
  });

  app.post("/api/restore", requireRole(ADMIN), async (request, response) => {
    const sql = request.body && request.body.sql;

    if (typeof sql !== "string" || sql.trim() === "") {
      return response.status(400).json({ error: "The file is empty or is not a .sql backup." });
    }

    let safety = null;
    try {
      safety = await writeBackupFile(AUTO_PREFIX);
      const count = await runSqlScript(sql);
      await writeAuditLog(request, "RESTORE",
        `Restored from an uploaded .sql file; the database before it is ${safety.fileName}`);
      response.json({
        message: `Database restored. ${count} statements ran. ` +
          `The database as it was before is kept as ${safety.fileName}.` + (await restoreShortfall())
      });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Restore failed: " + error.message + restoreUndoNote(safety) });
    }
  });

  // A restore that stopped partway may have rebuilt some tables and not
  // others; the copy taken just before it is the way back.
  function restoreUndoNote(safety) {
    if (safety) {
      return ` The database may be part-way restored. To put it back as it was, restore ${safety.fileName}.`;
    } else {
      return "";
    }
  }

  app.get("/api/store-settings", async (request, response) => {
    try {
      const [rows] = await db.query(
        `SELECT setting_id, store_name, proprietor, address, tin, registration_type,
                vat_rate, invoice_note, penalty_rate,
                bank_name, bank_account_name, bank_account_number, receipt_layout, updated_at,
                st.full_name AS updated_by
         FROM store_settings cfg
         LEFT JOIN staff st ON st.staff_id = cfg.updated_by_staff_id
         WHERE cfg.setting_id = 1`
      );

      // a database mid-install has no row yet; the defaults keep the till printing
      const settings = Object.assign({}, rows[0] || DEFAULT_STORE_SETTINGS);
      settings.receipt_layout = receiptLayoutFrom(settings.receipt_layout);
      response.json(settings);
    } catch (error) {
      console.error("Store settings failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  // The account a bank transfer is sent to: all three boxes are required, as
  // the till shows it whenever Bank Transfer is chosen.
  function bankDetailsFrom(body) {
    // trims the text, turns many spaces into one, and cuts it to "max" characters
    function tidy(value, max) {
      return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
    }

    const bank = {
      bank_name: tidy(body.bankName, 100),
      bank_account_name: tidy(body.bankAccountName, 150),
      bank_account_number: tidy(body.bankAccountNumber, 50)
    };

    // how many of the three boxes were filled in
    let filled = 0;
    if (bank.bank_name !== "") filled += 1;
    if (bank.bank_account_name !== "") filled += 1;
    if (bank.bank_account_number !== "") filled += 1;

    if (filled < 3) {
      return { error: "The bank, the account name and the account number are all required." };
    }
    // digits, with spaces or dashes allowed in between, and at least 6 digits in total
    const digitCount = bank.bank_account_number.replace(/\D/g, "").length;
    if (!/^[0-9][0-9 -]*[0-9]$/.test(bank.bank_account_number) || digitCount < 6) {
      return { error: "An account number is digits, with spaces or dashes where the bank prints them. " +
                      "Copy it from the passbook or the bank's letter." };
    }
    return { bank: bank };
  }

  app.put("/api/store-settings", requireRole(ADMIN), async (request, response) => {
    const { storeName, proprietor, address, tin, registrationType, vatRate, invoiceNote } = request.body;

    // refused with the reason: this is printed at the head of every invoice
    const tinProblem = tinComplaint(tin);
    if (tinProblem) return response.status(400).json({ error: tinProblem });

    // checked before anything is saved, so a bad account number leaves the rest unsaved too
    const bankCheck = bankDetailsFrom(request.body);
    if (bankCheck.error) return response.status(400).json({ error: bankCheck.error });

    // the layout as sent, or as it stands when a screen sends none
    const sentLayout = request.body.receiptLayout;
    if (sentLayout !== undefined && (typeof sentLayout !== "object" || sentLayout === null)) {
      return response.status(400).json({ error: "The receipt layout was not understood." });
    }
    if (sentLayout && ![58, 80].includes(Number(sentLayout.paperWidth))) {
      return response.status(400).json({ error: "The paper width is 58 mm or 80 mm." });
    }

    const storedTin = cleanTin(tin);

    try {
      // read first, so the trail can say what stood before
      const [existing] = await db.query(
        `SELECT store_name, proprietor, address, tin, registration_type, vat_rate, invoice_note,
                bank_name, bank_account_name, bank_account_number, receipt_layout
         FROM store_settings WHERE setting_id = 1`
      );

      const before = existing[0] || {};

      const output = await callProcedure(
        "CALL sp_update_store_settings(?, ?, ?, ?, ?, ?, ?, ?, @status_code, @message)",
        [String(storeName || "").trim().slice(0, 150),
         String(proprietor || "").trim().slice(0, 150),
         String(address || "").trim().slice(0, 255),
         storedTin,
         String(registrationType || "").trim().toUpperCase(),
         Number(vatRate) || 0,
         String(invoiceNote || "").trim().slice(0, 255),
         getActorId(request)],
        ["status_code", "message"]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      // the bank account only when it moved; the procedure writes its own entry on the trail
      let bankMessage = "";
      // did any of the three bank fields change?
      let bankChanged = false;
      for (const key of ["bank_name", "bank_account_name", "bank_account_number"]) {
        if ((before[key] || null) !== bankCheck.bank[key]) {
          bankChanged = true;
        }
      }
      if (bankChanged) {
        const bankOutput = await callProcedure(
          "CALL sp_update_store_bank_details(?, ?, ?, ?, @status_code, @message)",
          [bankCheck.bank.bank_name, bankCheck.bank.bank_account_name,
           bankCheck.bank.bank_account_number, getActorId(request)],
          ["status_code", "message"]
        );

        if (bankOutput.status_code !== 200) {
          return response.status(bankOutput.status_code).json({
            error: "The store details were saved, but the bank account was not: " + bankOutput.message
          });
        }
        bankMessage = " " + bankOutput.message;
      }

      // the receipt's layout, cleaned by the same rules the reader uses
      let layoutBefore = null;
      let layoutAfter = null;
      if (sentLayout) {
        layoutBefore = JSON.stringify(receiptLayoutFrom(before.receipt_layout));
        layoutAfter = JSON.stringify(receiptLayoutFrom(sentLayout));
        if (layoutAfter !== layoutBefore) {
          await db.query("UPDATE store_settings SET receipt_layout = ? WHERE setting_id = 1", [layoutAfter]);
        }
      }

      await writeAuditLog(
        request,
        "UPDATE_STORE_SETTINGS",
        `Store details and tax registration updated`,
        {
          changes: fieldChanges(existing[0] || null, {
            store_name: String(storeName || "").trim().slice(0, 150),
            proprietor: String(proprietor || "").trim().slice(0, 150) || null,
            address: String(address || "").trim().slice(0, 255),
            tin: storedTin,
            registration_type: String(registrationType || "").trim().toUpperCase(),
            vat_rate: Number(vatRate) || 0,
            invoice_note: String(invoiceNote || "").trim().slice(0, 255)
          }),
          receipt_layout_changed: layoutAfter !== null && layoutAfter !== layoutBefore
        }
      );

      response.json({ message: output.message + bankMessage });
    } catch (error) {
      console.error("Save store settings failed:", error.message);
      response.status(500).json({ error: "Unable to save the store settings" });
    }
  });

  return { startAutoBackup, startArchiveSweep, runSqlScript, resetStaffPassword };
}

module.exports = { registerAdminRoutes };
