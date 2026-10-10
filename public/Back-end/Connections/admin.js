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
const zlib = require("zlib");
const mailer = require("../mailer");
const { splitSqlStatements } = require("../sql-script");
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
    db, callProcedure, getActorId, writeAuditLog, fieldChanges, wordStartSearch,
    requireRole, publishChange, ADMIN, USER_SELECT, withPresence, notOwnAccount,
    endSessionsForStaff, hashPassword, generatePassword, phoneComplaint, cleanPhone, cleanMiddleName,
    findPhoneOwner, phoneTakenMessage,
    tinComplaint, cleanTin, DEFAULT_STORE_SETTINGS, AUDIT_TYPES, DB_NAME, sqlValue,
    sqlName, EXPECTED_PROCEDURES, countProcedures, SERVER_TABLES, IS_VERCEL, proceduresAreMissing, proceduresLoadedCount, forgetProcedureCount,
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
  // details in between. The draft is kept in account_drafts (any copy of the
  // server may answer the second request), held to one administrator, so what
  // was confirmed on screen is what is written. Drafts expire on their own.
  //
  // The draft holds the new account's first password, so the row is sealed:
  // it is filed under the SHA-256 of its id and encrypted with a key made from
  // the id. Only the administrator's screen holds the id, so the table alone
  // gives away nothing.
  const DRAFT_LIFE_MS = 10 * 60 * 1000; // long enough to read a card, short enough to forget
  const DRAFT_MAX = 200;                // one runaway client cannot grow this without limit

  function draftHash(draftId) {
    return crypto.createHash("sha256").update("draft-id:" + draftId).digest("hex");
  }

  function draftKey(draftId) {
    return crypto.createHash("sha256").update("draft-key:" + draftId).digest();
  }

  function sealDraft(draftId, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", draftKey(draftId), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  function openDraft(draftId, sealed) {
    const raw = Buffer.from(sealed, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", draftKey(draftId), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text);
  }

  async function removeExpiredDrafts() {
    await db.query("DELETE FROM account_drafts WHERE expires_at <= ?", [Date.now()]);
  }

  async function newAccountDraft(staffId, kind, details, password) {
    // swept here rather than on a timer: the table only grows when it is being used
    await removeExpiredDrafts();

    // still too many? remove the ones that expire first
    const [counted] = await db.query("SELECT COUNT(*) AS total FROM account_drafts");
    const extra = Number(counted[0].total) - DRAFT_MAX + 1;
    if (extra > 0) {
      await db.query("DELETE FROM account_drafts ORDER BY expires_at LIMIT ?", [extra]);
    }

    const draftId = crypto.randomBytes(18).toString("base64url");
    await db.query(
      "INSERT INTO account_drafts (draft_hash, staff_id, kind, payload, expires_at) VALUES (?, ?, ?, ?, ?)",
      [draftHash(draftId), staffId, kind,
       sealDraft(draftId, { details: details, password: password }), Date.now() + DRAFT_LIFE_MS]);

    return { draftId: draftId, expiresInSeconds: Math.round(DRAFT_LIFE_MS / 1000) };
  }

  // Reads a draft and removes it: a draft is good for one confirmation, so a
  // double-clicked button is not a second account (only the request whose
  // DELETE removed the row goes on).
  async function takeAccountDraft(draftId, staffId, kind) {
    const expired = { error: "That review has expired. Fill the form in again." };
    const id = String(draftId || "");
    if (id === "") return expired;

    const hash = draftHash(id);
    const [rows] = await db.query(
      "SELECT staff_id, kind, payload, expires_at FROM account_drafts WHERE draft_hash = ?", [hash]);
    if (rows.length === 0) return expired;

    const [removed] = await db.query("DELETE FROM account_drafts WHERE draft_hash = ?", [hash]);
    if (removed.affectedRows !== 1) return expired;

    const row = rows[0];
    if (Number(row.expires_at) <= Date.now()) return expired;
    if (row.staff_id !== staffId) {
      return { error: "That review belongs to another administrator's session." };
    }
    if (row.kind !== kind) {
      return { error: "That review was for a different kind of account." };
    }

    let sealed;
    try {
      sealed = openDraft(id, row.payload);
    } catch (error) {
      return expired;
    }

    return {
      draft: { by: row.staff_id, kind: row.kind, details: sealed.details, password: sealed.password }
    };
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

    // a word starts with the text, not contains; see wordStartSearch
    if (search !== "") {
      where.push(wordStartSearch(["s.full_name", "u.email", "r.role_name"], search, params));
    }

    let filter = "";
    if (where.length > 0) {
      filter = ` WHERE ${where.join(" AND ")}`;
    }

    try {
      const [rows] = await db.query(`${USER_SELECT}${filter} ORDER BY s.staff_id`, params);
      response.json(await withPresence(rows));
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

  // Is this phone number already on a staff account? Every role counts,
  // active or archived. staffId leaves out the account being edited.
  app.get("/api/users/phone-check", async (request, response) => {
    try {
      const owner = await findPhoneOwner(request.query.phone, request.query.staffId);
      if (!owner) return response.json({ taken: false });
      response.json({ taken: true, roleName: owner.role_name, name: owner.full_name });
    } catch (error) {
      console.error("Phone check failed:", error.message);
      response.status(500).json({ error: "Unable to check the phone number" });
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

      // each staff member has their own phone number
      const phoneOwner = await findPhoneOwner(phone, 0);
      if (phoneOwner) {
        return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
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
      const draft = await newAccountDraft(request.actor.staffId, "staff", details, password);

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
    const draftResult = await takeAccountDraft(request.body.draftId, request.actor.staffId, "staff");

    if (draftResult.error) return response.status(410).json({ error: draftResult.error });

    const draft = draftResult.draft;
    const details = draft.details;

    try {
      // the draft may be minutes old: someone else could have taken the number since
      const phoneOwner = await findPhoneOwner(details.phone, 0);
      if (phoneOwner) {
        return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
      }

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

      // A phone number may be left empty, but a new one must be free. A number
      // that is not being changed is not checked, so an older record that
      // already shares one can still be saved.
      const oldPhone = before ? before.phone : null;
      if (cleanPhone(phone) !== oldPhone) {
        const phoneOwner = await findPhoneOwner(phone, request.params.staffId);
        if (phoneOwner) {
          return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
        }
      }

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
        await endSessionsForStaff(request.params.staffId, null, reason);
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

      if (!isActive) await endSessionsForStaff(request.params.staffId);

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
      const draft = await newAccountDraft(request.actor.staffId, "login", details, password);

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
    const draftResult = await takeAccountDraft(request.body.draftId, request.actor.staffId, "login");

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

    await endSessionsForStaff(Number(staffId), null,
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
      where.push(wordStartSearch(["s.full_name", "l.action", "l.details", "l.ip_address"], search, params));
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
  // A backup is a complete .sql file (schema, rows, views, procedures) named
  // after the moment it was taken. It opens and runs in MySQL Workbench.
  //
  // Where the files are kept (HARDWARE_BACKUP_STORE in .env):
  //   folder    the backups/ folder on this PC (or HARDWARE_BACKUP_DIR). The default on a PC.
  //   database  the backup_files table, gzipped. The default on Vercel, whose
  //             disk is wiped between requests. Download a copy now and then:
  //             a backup kept inside the database it backs up is lost with it.
  // ==========================================
  // HARDWARE_BACKUP_DIR in .env can point the backups to another folder
  const BACKUP_DIR = process.env.HARDWARE_BACKUP_DIR || path.join(__dirname, "..", "..", "..", "backups");
  const BACKUP_PREFIX = "hardware_db_backup_";
  const BACKUP_STORE_KIND = String(process.env.HARDWARE_BACKUP_STORE || (IS_VERCEL ? "database" : "folder"))
    .trim().toLowerCase() === "database" ? "database" : "folder";

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

  // The two stores answer the same calls:
  //   names()            every backup's file name
  //   list()             [{ name, bytes, createdAt }]
  //   exists(name)       true or false
  //   writer(name)       { write(text), finish() -> bytes, abandon() }
  //   readText(name)     the file's text, or null when it is gone
  //   remove(name)       true, or false when it was already gone
  //   readSwitch() / writeSwitch(enabled)   the daily backup's on/off switch
  //   readError() / writeError(message)     why the last daily backup failed

  // the on/off switch lives in a small file beside the backups, so a server
  // restart does not quietly turn the backup back on for someone who switched
  // it off. Missing or unreadable means on, the safe default.
  const AUTO_SWITCH_FILE = path.join(BACKUP_DIR, "auto-backup.json");

  const folderStore = {
    async names() {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      return (await fsp.readdir(BACKUP_DIR)).filter((name) => BACKUP_NAME.test(name));
    },
    async list() {
      const files = [];
      for (const name of await this.names()) {
        const stats = await fsp.stat(path.join(BACKUP_DIR, name));
        files.push({ name: name, bytes: stats.size, createdAt: stats.mtime.toISOString() });
      }
      return files;
    },
    async exists(name) {
      return fs.existsSync(path.join(BACKUP_DIR, name));
    },
    async writer(name) {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const fullPath = path.join(BACKUP_DIR, name);
      const out = fs.createWriteStream(fullPath, { encoding: "utf8" });
      const close = () => new Promise((resolve) => out.end(resolve));
      return {
        // "await write(...)" waits until the text is in the file
        write(text) {
          return new Promise((resolve, reject) => {
            out.write(text, (error) => (error ? reject(error) : resolve()));
          });
        },
        async finish() {
          await close();
          return (await fsp.stat(fullPath)).size;
        },
        async abandon() {
          await close();
        }
      };
    },
    async readText(name) {
      try {
        return await fsp.readFile(path.join(BACKUP_DIR, name), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(name) {
      try {
        await fsp.unlink(path.join(BACKUP_DIR, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;   // already gone
        throw error;
      }
    },
    async readSwitch() {
      try {
        return JSON.parse(await fsp.readFile(AUTO_SWITCH_FILE, "utf8")).enabled !== false;
      } catch (error) {
        return true;
      }
    },
    async writeSwitch(enabled) {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.writeFile(AUTO_SWITCH_FILE,
        JSON.stringify({ enabled: enabled, changedAt: new Date().toISOString() }, null, 2) + "\n");
    },
    // one server, so its memory is enough
    async readError() {
      return autoBackup.lastError;
    },
    async writeError() {}
  };

  async function readFlag(key) {
    const [rows] = await db.query("SELECT flag_value FROM app_flags WHERE flag_key = ?", [key]);
    return rows.length > 0 ? rows[0].flag_value : null;
  }

  async function writeFlag(key, value) {
    await db.query(
      `INSERT INTO app_flags (flag_key, flag_value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE flag_value = VALUES(flag_value), updated_at = VALUES(updated_at)`,
      [key, value === null ? null : String(value).slice(0, 255), Date.now()]);
  }

  const databaseStore = {
    async names() {
      const [rows] = await db.query("SELECT file_name FROM backup_files");
      return rows.map((row) => row.file_name);
    },
    async list() {
      const [rows] = await db.query("SELECT file_name, bytes, created_at FROM backup_files");
      return rows.map((row) => ({
        name: row.file_name,
        bytes: Number(row.bytes),
        createdAt: new Date(Number(row.created_at)).toISOString()
      }));
    },
    async exists(name) {
      const [rows] = await db.query("SELECT 1 FROM backup_files WHERE file_name = ?", [name]);
      return rows.length > 0;
    },
    // gathered in memory and saved gzipped in one row: a shop's backup is a
    // few hundred kilobytes of text and squeezes to a tenth of that
    async writer(name) {
      const parts = [];
      return {
        async write(text) {
          parts.push(text);
        },
        async finish() {
          const text = Buffer.from(parts.join(""), "utf8");
          await db.query(
            "INSERT INTO backup_files (file_name, bytes, created_at, content) VALUES (?, ?, ?, ?)",
            [name, text.length, Date.now(), zlib.gzipSync(text)]);
          return text.length;
        },
        async abandon() {}
      };
    },
    async readText(name) {
      const [rows] = await db.query("SELECT content FROM backup_files WHERE file_name = ?", [name]);
      if (rows.length === 0) return null;
      return zlib.gunzipSync(rows[0].content).toString("utf8");
    },
    async remove(name) {
      const [result] = await db.query("DELETE FROM backup_files WHERE file_name = ?", [name]);
      return result.affectedRows > 0;
    },
    async readSwitch() {
      return (await readFlag("auto_backup_enabled")) !== "0";
    },
    async writeSwitch(enabled) {
      await writeFlag("auto_backup_enabled", enabled ? "1" : "0");
    },
    // many copies of the server, so the one that ran the job writes it down
    async readError() {
      return await readFlag("auto_backup_error");
    },
    async writeError(message) {
      await writeFlag("auto_backup_error", message);
    }
  };

  const backupStore = BACKUP_STORE_KIND === "database" ? databaseStore : folderStore;

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
  async function freeBackupName(when, prefix) {
    const base = backupFileName(when, prefix);
    let name = base;
    let counter = 2;

    while (await backupStore.exists(name)) {
      name = base.replace(/\.sql$/, `-${counter}.sql`);
      counter += 1;
    }
    return name;
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
    // the server's own tables (sign-ins, the backups themselves) are not shop data
    return rows.map((row) => row.TABLE_NAME).filter((name) => !SERVER_TABLES.includes(name));
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
    const name = await freeBackupName(now, prefix);

    const tables = await listBaseTables();
    const views = await listViews();
    const procedures = await listProcedures();

    // "out" writes into the file bit by bit (see the two stores above).
    // write(text) adds text to the file, and "await write(...)" waits until it is written.
    const out = await backupStore.writer(name);
    function write(text) {
      return out.write(text);
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
    } catch (error) {
      await out.abandon();
      throw error;
    }

    // close the file (or save the row) and wait until it is done
    const bytes = await out.finish();

    return {
      fileName: name,
      createdAt: now.toISOString(),
      bytes: bytes,
      tableCount: tables.length,
      viewCount: views.length,
      procedureCount: procedures.length,
      rowCount: rowTotal
    };
  }

  // splitSqlStatements (in ../sql-script.js) turns the text of a .sql file
  // into separate statements, the way MySQL Workbench does.

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
  // every sale made a busy till lag. On a PC a check runs every few minutes
  // and writes the day's file once the hour has come; a server that was asleep
  // or restarted catches up on its next check. On Vercel nothing runs between
  // requests, so the daily job (/api/cron/daily, at the hour vercel.json sets)
  // calls runDailyBackup instead. The newest AUTO_KEEP automatic files are
  // kept and older ones are deleted. Backups taken by hand are never deleted
  // by the system, and there can be at most MANUAL_LIMIT of them.
  // The hour is the shop's clock (HARDWARE_TIME_ZONE, Asia/Manila on Vercel).
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

  // the backup files, by kind, oldest first (the stamp is year-first)
  async function backupNames() {
    const all = await backupStore.names();
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
      await backupStore.remove(name);   // already gone is fine
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
    enabled: true,         // the switch, read from the store at startup
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
    if (!autoBackup.enabled || autoBackup.running) return "off or already running";

    // a dump taken halfway through a restore is a dump of neither database
    if (restoreInProgress) return "a restore is running";

    autoBackup.running = true;

    try {
      const summary = await writeBackupFile(AUTO_PREFIX);
      if (await safeToRotate()) await rotateAutoBackups();

      autoBackup.lastFileName = summary.fileName;
      autoBackup.lastAt = summary.createdAt;
      if (autoBackup.lastError) console.log(`The daily backup is working again (${summary.fileName}).`);
      autoBackup.lastError = null;
      autoBackup.failures = 0;
      await backupStore.writeError(null);
      return `saved ${summary.fileName}`;
    } catch (error) {
      autoBackup.failures += 1;
      autoBackup.lastError = error.message;
      try {
        await backupStore.writeError(error.message);
      } catch (ignored) { /* the database is the thing that is broken */ }

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
      throw error;
    } finally {
      autoBackup.running = false;
    }
  }

  // true when today's automatic backup is already saved
  async function todayIsBackedUp() {
    const today = AUTO_PREFIX + todayStamp();
    const names = (await backupNames()).automatic;
    return names.some((name) => name.startsWith(today));
  }

  // writes today's backup once the hour has come, if today has none yet
  async function dailyBackupCheck() {
    if (!autoBackup.enabled || autoBackup.running) return;
    if (new Date().getHours() < AUTO_HOUR) return;

    try {
      if (await todayIsBackedUp()) return;
    } catch (error) {
      return;     // the folder cannot be read; the next check tries again
    }

    // a failed attempt waits for the next check rather than retrying at once
    try {
      await runAutoBackup();
    } catch (error) {
      // already recorded on autoBackup and in the audit trail
    }
  }

  // The daily job's part (Vercel): the switch is read fresh, because another
  // copy of the server may have changed it, and the hour is the job's own.
  async function runDailyBackup() {
    autoBackup.enabled = await backupStore.readSwitch();
    if (!autoBackup.enabled) return "switched off";
    if (await todayIsBackedUp()) return "today's is already saved";
    return await runAutoBackup();
  }

  async function startAutoBackup() {
    autoBackup.enabled = await backupStore.readSwitch();

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

      // one entry per backup file in the store
      const files = [];
      for (const file of await backupStore.list()) {
        files.push({
          fileName: file.name,
          bytes: file.bytes,
          createdAt: file.createdAt,
          // so a row can say which kind it is
          automatic: AUTO_NAME.test(file.name)
        });
      }

      // newest first
      files.sort(function (left, right) {
        return right.createdAt.localeCompare(left.createdAt);
      });

      // Read from the store rather than this copy's memory: on Vercel the
      // daily job ran on another copy of the server.
      autoBackup.enabled = await backupStore.readSwitch();
      const lastAuto = files.find((file) => file.automatic) || null;
      const lastError = await backupStore.readError();

      response.json({
        files: files,
        auto: {
          enabled: autoBackup.enabled,
          schedule: "daily",
          hour: AUTO_HOUR,
          keep: AUTO_KEEP,
          lastFileName: lastAuto ? lastAuto.fileName : autoBackup.lastFileName,
          lastAt: lastAuto ? lastAuto.createdAt : autoBackup.lastAt,
          lastError: lastError,
          failures: lastError ? Math.max(autoBackup.failures, 1) : 0,
          // where the files are kept: "folder" (this PC) or "database" (Vercel)
          store: BACKUP_STORE_KIND
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
      await backupStore.writeSwitch(enabled);
      autoBackup.enabled = enabled;

      if (enabled) {
        await writeAuditLog(request, "AUTO_BACKUP_ON",
          `Daily backup switched on (at ${twoDigits(AUTO_HOUR)}:00, keeping the last ${AUTO_KEEP})`);
        // on Vercel the daily job does it; a copy of the server may stop once this answer is sent
        if (!IS_VERCEL) dailyBackupCheck();
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

    try {
      const text = await backupStore.readText(name);
      if (text === null) {
        return response.status(404).json({ error: "That backup is no longer saved." });
      }

      response.attachment(name);
      response.type("application/sql");
      response.send(text);
    } catch (error) {
      console.error("Backup download failed:", error.message);
      response.status(500).json({ error: "Unable to read that backup" });
    }
  });

  app.delete("/api/backups/:fileName", requireRole(ADMIN), async (request, response) => {
    const name = request.params.fileName;

    if (!BACKUP_NAME.test(name)) {
      return response.status(400).json({ error: "That is not a backup file name." });
    }

    try {
      if (!(await backupStore.remove(name))) {
        return response.status(404).json({ error: "That backup is no longer saved." });
      }
      await writeAuditLog(request, "BACKUP_DELETE", name);
      response.json({ message: `${name} deleted.` });
    } catch (error) {
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

    let safety = null;
    try {
      const text = await backupStore.readText(name);
      if (text === null) {
        return response.status(404).json({ error: "That backup is no longer saved." });
      }

      // the database as it is now, kept beside the others in case this has to be undone
      safety = await writeBackupFile(AUTO_PREFIX);
      const count = await runSqlScript(text);
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

  return {
    startAutoBackup, startArchiveSweep, runSqlScript, resetStaffPassword,
    // the daily job on Vercel (server.js, /api/cron/daily)
    runArchiveSweep, runDailyBackup, removeExpiredDrafts
  };
}

module.exports = { registerAdminRoutes };
