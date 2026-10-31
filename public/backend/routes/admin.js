const helpers = require("../helpers");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const zlib = require("zlib");
const express = require("express");
const mailer = require("../services/mailer");
const splitSqlStatements = require("../services/sql-script").splitSqlStatements;
const adminProcedures = require("../database/procedures/admin-procedures");
const migrateOneAtATime = require("../database/migrations").migrateOneAtATime;
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const firstPasswordMessage = mailer.firstPasswordMessage;

function emailedText(emailed, yesText) {
  if (emailed) {
    return yesText;
  }
  return " (password not emailed)";
}

function registerAdminRoutes(app, deps) {
  const db = deps.db;
  const getActorId = deps.getActorId;
  const writeAuditLog = deps.writeAuditLog;
  const fieldChanges = deps.fieldChanges;
  const wordStartSearch = deps.wordStartSearch;
  const requireRole = deps.requireRole;
  const publishChange = deps.publishChange;
  const ADMIN = deps.ADMIN;
  const USER_SELECT = deps.USER_SELECT;
  const withPresence = deps.withPresence;
  const notOwnAccount = deps.notOwnAccount;
  const endSessionsForStaff = deps.endSessionsForStaff;
  const hashPassword = deps.hashPassword;
  const generatePassword = deps.generatePassword;
  const phoneComplaint = deps.phoneComplaint;
  const cleanPhone = deps.cleanPhone;
  const cleanMiddleName = deps.cleanMiddleName;
  const findPhoneOwner = deps.findPhoneOwner;
  const phoneTakenMessage = deps.phoneTakenMessage;
  const nameComplaint = deps.nameComplaint;
  const tinComplaint = deps.tinComplaint;
  const cleanTin = deps.cleanTin;
  const DEFAULT_STORE_SETTINGS = deps.DEFAULT_STORE_SETTINGS;
  const DB_NAME = deps.DB_NAME;
  const sqlValue = deps.sqlValue;
  const sqlName = deps.sqlName;
  const EXPECTED_PROCEDURES = deps.EXPECTED_PROCEDURES;
  const countProcedures = deps.countProcedures;
  const SERVER_TABLES = deps.SERVER_TABLES;
  const IS_VERCEL = deps.IS_VERCEL;
  const proceduresAreMissing = deps.proceduresAreMissing;
  const proceduresLoadedCount = deps.proceduresLoadedCount;
  const forgetProcedureCount = deps.forgetProcedureCount;
  const loadProceduresIfMissing = deps.loadProceduresIfMissing;
  const FEATURES = deps.FEATURES;
  const FEATURE_ROLES = deps.FEATURE_ROLES;
  const findFeature = deps.findFeature;
  const featuresOf = deps.featuresOf;
  const forgetFeatureOverrides = deps.forgetFeatureOverrides;
  const receiptLayoutFrom = deps.receiptLayoutFrom;
  const ROLES_MANAGED_BY_MANAGER = deps.ROLES_MANAGED_BY_MANAGER;

  function staffNameProblem(firstName, middleName, lastName) {
    return nameComplaint("First name", firstName) ||
           nameComplaint("Middle name", middleName) ||
           nameComplaint("Last name", lastName);
  }

  app.get("/api/roles", async function (request, response) {
    try {
      const rowsResult = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");
      const rows = rowsResult[0];

      if (request.actor.roleName === ADMIN) {
        return response.json(rows);
      }

      const allowedRoles = [];
      for (let i = 0; i < rows.length; i++) {
        if (ROLES_MANAGED_BY_MANAGER.includes(rows[i].role_name)) {
          allowedRoles.push(rows[i]);
        }
      }
      response.json(allowedRoles);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  async function deliverFirstPassword(details) {
    const email = details.email;
    const name = details.name;
    const roleName = details.roleName;
    const password = details.password;

    if (!isMailConfigured()) {
      return {
        emailed: false,
        password: password,
        reason: "Mail is not set up on this server, so the password could not be sent."
      };
    }

    try {
      const rowsResult = await db.query(
        "SELECT store_name FROM store_settings WHERE setting_id = 1");
      const rows = rowsResult[0];
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
      console.error("Sending the first password failed:", error.message);
      return {
        emailed: false,
        password: password,
        reason: "The mail server refused the message: " + error.message
      };
    }
  }

  async function roleNameById(roleId) {
    const rowsResult = await db.query(
      "SELECT role_name FROM roles WHERE role_id = ?", [roleId]);
    const rows = rowsResult[0];
    return (rows[0] && rows[0].role_name) || "staff";
  }

  const DRAFT_LIFE_MS = 10 * 60 * 1000;
  const DRAFT_MAX = 200;

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
    await removeExpiredDrafts();

    const countedResult = await db.query("SELECT COUNT(*) AS total FROM account_drafts");
    const counted = countedResult[0];
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

  async function takeAccountDraft(draftId, staffId, kind) {
    const expired = { error: "That review has expired. Fill the form in again." };
    const id = String(draftId || "");
    if (id === "") return expired;

    const hash = draftHash(id);
    const rowsResult = await db.query(
      "SELECT staff_id, kind, payload, expires_at FROM account_drafts WHERE draft_hash = ?", [hash]);
    const rows = rowsResult[0];
    if (rows.length === 0) return expired;

    const removedResult = await db.query("DELETE FROM account_drafts WHERE draft_hash = ?", [hash]);
    const removed = removedResult[0];
    if (removed.affectedRows !== 1) return expired;

    const row = rows[0];
    if (Number(row.expires_at) <= Date.now()) return expired;
    if (row.staff_id !== staffId) {
      return { error: "That review belongs to another person's session." };
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

  async function sendManagedStaff(response) {
    try {
      let marks = "";
      for (let i = 0; i < ROLES_MANAGED_BY_MANAGER.length; i++) {
        marks += (i === 0 ? "?" : ", ?");
      }

      const rowsResult = await db.query(
        "SELECT s.staff_id, s.full_name, s.phone, s.is_active, r.role_name, " +
        "u.email, u.must_change_password, u.last_login, " +
        "IF(u.held_until IS NOT NULL AND u.held_until > NOW(), " +
        "CEIL(TIMESTAMPDIFF(SECOND, NOW(), u.held_until) / 60), NULL) AS minutes_left " +
        "FROM staff s " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "LEFT JOIN users u ON u.staff_id = s.staff_id " +
        "WHERE s.archived_at IS NULL AND r.role_name IN (" + marks + ") " +
        "ORDER BY s.staff_id",
        ROLES_MANAGED_BY_MANAGER);
      const rows = rowsResult[0];

      const staff = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        staff.push({
          staff_id: row.staff_id,
          full_name: row.full_name,
          role_name: row.role_name,
          email: row.email,
          phone: row.phone,
          is_active: row.is_active === 1 || row.is_active === true,
          has_login: row.email !== null,
          must_change_password: row.must_change_password === 1 || row.must_change_password === true,
          last_login: row.last_login,
          minutes_left: row.minutes_left === null ? null : Number(row.minutes_left)
        });
      }

      response.json(staff);
    } catch (error) {
      console.error("Loading the staff accounts failed:", error.message);
      response.status(500).json({ error: "Unable to load the staff accounts" });
    }
  }

  app.get("/api/users", async function (request, response) {
    if (request.actor.roleName !== ADMIN) {
      return sendManagedStaff(response);
    }

    const status = String(request.query.status || "all").toLowerCase();
    const search = String(request.query.search || "").trim();

    const where = [];
    const params = [];

    if (status === "archived") {
      where.push("s.archived_at IS NOT NULL");
    } else {
      where.push("s.archived_at IS NULL");
      if (status === "active") where.push("s.is_active = TRUE");
      else if (status === "inactive") where.push("s.is_active = FALSE");
    }

    if (search !== "") {
      where.push(wordStartSearch(["s.full_name", "u.email", "r.role_name"], search, params));
    }

    let filter = "";
    if (where.length > 0) {
      filter = " WHERE " + where.join(" AND ");
    }

    try {
      const rowsResult = await db.query("" + USER_SELECT + filter + " ORDER BY s.staff_id", params);
      const rows = rowsResult[0];
      response.json(await withPresence(rows));
    } catch (error) {
      console.error("Loading users failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/users/held", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT s.staff_id, s.full_name, r.role_name, u.email, " +
        "CEIL(TIMESTAMPDIFF(SECOND, NOW(), u.held_until) / 60) AS minutes_left " +
        "FROM users u " +
        "JOIN staff s ON s.staff_id = u.staff_id " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "WHERE u.held_until IS NOT NULL AND u.held_until > NOW() AND s.is_active = TRUE " +
        "ORDER BY u.held_until");
      const rows = rowsResult[0];

      const held = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const allowed = request.actor.roleName === ADMIN ||
                        ROLES_MANAGED_BY_MANAGER.includes(row.role_name);
        if (allowed) {
          held.push({
            staff_id: row.staff_id,
            full_name: row.full_name,
            role_name: row.role_name,
            email: row.email,
            minutes_left: Number(row.minutes_left)
          });
        }
      }

      response.json(held);
    } catch (error) {
      console.error("Loading held accounts failed:", error.message);
      response.status(500).json({ error: "Unable to load the accounts on hold" });
    }
  });

  app.get("/api/users/email-check", async function (request, response) {
    const email = String(request.query.email || "").trim().toLowerCase();
    const staffId = Number(request.query.staffId) || 0;
    if (email === "") return response.json({ taken: false });

    try {
      const rowsResult = await db.query(
        "SELECT r.role_name FROM users u " +
        "JOIN staff s ON s.staff_id = u.staff_id " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "WHERE LOWER(u.email) = ? AND u.staff_id <> ? " +
        "LIMIT 1",
        [email, staffId]);
      const rows = rowsResult[0];
      if (rows.length === 0) return response.json({ taken: false });
      response.json({ taken: true, roleName: rows[0].role_name });
    } catch (error) {
      console.error("Email check failed:", error.message);
      response.status(500).json({ error: "Unable to check the email address" });
    }
  });

  app.get("/api/users/phone-check", async function (request, response) {
    try {
      const owner = await findPhoneOwner(request.query.phone, request.query.staffId);
      if (!owner) return response.json({ taken: false });
      if (request.actor.roleName !== ADMIN) {
        return response.json({ taken: true, roleName: owner.role_name });
      }
      response.json({ taken: true, roleName: owner.role_name, name: owner.full_name });
    } catch (error) {
      console.error("Phone check failed:", error.message);
      response.status(500).json({ error: "Unable to check the phone number" });
    }
  });

  app.get("/api/users/:staffId", async function (request, response) {
    try {
      const rowsResult = await db.query(USER_SELECT + " WHERE s.staff_id = ?", [request.params.staffId]);
      const rows = rowsResult[0];

      if (rows.length === 0) {
        return response.status(404).json({ error: "Staff record not found" });
      }

      response.json(rows[0]);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  function phoneTaken(request, owner) {
    if (request.actor.roleName === ADMIN) return phoneTakenMessage(owner);
    return "That phone number is already used by another staff account (" + owner.role_name + "). " +
           "Each staff account needs its own phone number.";
  }

  app.post("/api/users/draft", async function (request, response) {
    const firstName = request.body.firstName;
    const middleName = request.body.middleName;
    const lastName = request.body.lastName;
    const phone = request.body.phone;
    const roleId = request.body.roleId;
    const email = request.body.email;
    const roleIdNumber = Number(roleId);

    if (!firstName || !lastName || !roleId || !email || !String(phone || "").trim()) {
      return response.status(400).json({ error: "Name, phone, role and email are required" });
    }

    const createNameProblem = staffNameProblem(firstName, middleName, lastName);
    if (createNameProblem) return response.status(400).json({ error: createNameProblem });

    const address = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    if (!/^\d+$/.test(String(roleId).trim()) || !Number.isSafeInteger(roleIdNumber) || roleIdNumber < 1) {
      return response.status(400).json({ error: "The selected role does not exist." });
    }

    try {
      const rolesResult = await db.query(
        "SELECT role_name FROM roles WHERE role_id = ?", [roleIdNumber]);
      const roles = rolesResult[0];
      if (roles.length === 0) {
        return response.status(400).json({ error: "The selected role does not exist." });
      }

      if (request.actor.roleName !== ADMIN && !ROLES_MANAGED_BY_MANAGER.includes(roles[0].role_name)) {
        return response.status(403).json({
          error: "You can only create a cashier, an inventory clerk or a delivery driver account."
        });
      }

      const takenResult = await db.query(
        "SELECT r.role_name FROM users u " +
        "JOIN staff s ON s.staff_id = u.staff_id " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "WHERE LOWER(u.email) = ?", [address]);
      const taken = takenResult[0];
      if (taken.length > 0) {
        return response.status(409).json({
          error: "The email " + address + " is already used by another account (" + taken[0].role_name + "). " +
                 "Each account needs its own email address, whatever its role."
        });
      }

      const phoneOwner = await findPhoneOwner(phone, 0);
      if (phoneOwner) {
        return response.status(409).json({ error: phoneTaken(request, phoneOwner) });
      }

      const details = {
        firstName: String(firstName).trim(),
        middleName: cleanMiddleName(middleName),
        lastName: String(lastName).trim(),
        phone: cleanPhone(phone),
        roleId: roleIdNumber,
        roleName: roles[0].role_name,
        email: address
      };

      const password = generatePassword();
      const draft = await newAccountDraft(request.actor.staffId, "staff", details, password);

      const fullName = details.firstName + " " + details.lastName;

      const answer = Object.assign({
        draftId: draft.draftId,
        expiresInSeconds: draft.expiresInSeconds,
        willEmail: isMailConfigured()
      }, details);
      answer.fullName = fullName;

      response.json(answer);
    } catch (error) {
      console.error("Account review failed:", error.message);
      response.status(500).json({ error: "Unable to prepare the account" });
    }
  });

  app.post("/api/users", async function (request, response) {
    const draftResult = await takeAccountDraft(request.body.draftId, request.actor.staffId, "staff");

    if (draftResult.error) return response.status(410).json({ error: draftResult.error });

    const draft = draftResult.draft;
    const details = draft.details;

    if (request.actor.roleName !== ADMIN && !ROLES_MANAGED_BY_MANAGER.includes(details.roleName)) {
      return response.status(403).json({
        error: "You can only create a cashier, an inventory clerk or a delivery driver account."
      });
    }

    try {
      const phoneOwner = await findPhoneOwner(details.phone, 0);
      if (phoneOwner) {
        return response.status(409).json({ error: phoneTaken(request, phoneOwner) });
      }

      const output = await adminProcedures.createStaffAccount(
        [details.firstName, details.middleName, details.lastName, details.phone,
         details.roleId, details.email, await hashPassword(draft.password)]
      );

      if (output.status_code !== 201) {
        return response.status(output.status_code).json({ error: output.message });
      }

      const createdResult = await db.query(
        "SELECT full_name FROM staff WHERE staff_id = ?", [output.staff_id]);
      const created = createdResult[0];
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

      await writeAuditLog(
        request,
        "CREATE_ACCOUNT",
        "Created account for " + details.email +
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
        password: delivery.password,
        reason: delivery.reason
      });
    } catch (error) {
      console.error("Create account failed:", error.message);
      response.status(500).json({ error: "Unable to create the account" });
    }
  });

  app.put("/api/users/:staffId", notOwnAccount, async function (request, response) {
    const firstName = request.body.firstName;
    const middleName = request.body.middleName;
    const lastName = request.body.lastName;
    const phone = request.body.phone;
    const roleId = request.body.roleId;
    const email = request.body.email;

    if (!firstName || !lastName || !roleId) {
      return response.status(400).json({ error: "Name and role are required" });
    }

    const editNameProblem = staffNameProblem(firstName, middleName, lastName);
    if (editNameProblem) return response.status(400).json({ error: editNameProblem });

    const phoneProblem = phoneComplaint(phone);
    if (phoneProblem) return response.status(400).json({ error: phoneProblem });

    const newEmail = String(email || "").trim().toLowerCase();
    if (newEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    try {
      if (newEmail !== "") {
        const takenResult = await db.query(
          "SELECT user_id FROM users WHERE LOWER(email) = ? AND staff_id <> ?",
          [newEmail, request.params.staffId]);
        const taken = takenResult[0];
        if (taken.length > 0) {
          return response.status(409).json({
            error: "The email " + newEmail + " is already used by another account. " +
                   "Each account needs its own email address, whatever its role."
          });
        }
      }

      const existingResult = await db.query(
        "SELECT s.first_name, s.middle_name, s.last_name, s.phone, " +
        "s.role_id, u.email " +
        "FROM staff s LEFT JOIN users u ON u.staff_id = s.staff_id " +
        "WHERE s.staff_id = ?",
        [request.params.staffId]
      );
      const existing = existingResult[0];
      const before = existing[0] || null;

      const oldPhone = before ? before.phone : null;
      if (cleanPhone(phone) !== oldPhone) {
        const phoneOwner = await findPhoneOwner(phone, request.params.staffId);
        if (phoneOwner) {
          return response.status(409).json({ error: phoneTakenMessage(phoneOwner) });
        }
      }

      const output = await adminProcedures.updateStaffAccount(
        [request.params.staffId, firstName, cleanMiddleName(middleName), lastName,
         cleanPhone(phone), roleId, newEmail || null]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

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
        "Updated staff " + helpers.staffCode(request.params.staffId),
        { staff_id: Number(request.params.staffId), changes: fieldChanges(before, after) }
      );
      response.json({ message: output.message });
    } catch (error) {
      console.error("Update account failed:", error.message);
      response.status(500).json({ error: "Unable to update the account" });
    }
  });

  app.patch("/api/users/:staffId/status", notOwnAccount, async function (request, response) {
    const isActive = request.body.isActive === true;

    try {
      const output = await adminProcedures.setStaffStatus(
        [request.params.staffId, isActive, request.actor.staffId]
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
        "Staff " + helpers.staffCode(request.params.staffId) + " was " + words + " the active list",
        { staff_id: Number(request.params.staffId),
          is_active: { before: !isActive, after: isActive } }
      );
      response.json({ message: output.message });
    } catch (error) {
      console.error("Status change failed:", error.message);
      response.status(500).json({ error: "Unable to change the account status" });
    }
  });

  app.post("/api/users/:staffId/account/draft", notOwnAccount, async function (request, response) {
    const email = request.body.email;
    const staffId = Number(request.params.staffId);

    if (!email) {
      return response.status(400).json({ error: "An email address is required" });
    }

    const address = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return response.status(400).json({ error: "That email address does not look right" });
    }

    try {
      const staffResult = await db.query(
        "SELECT s.staff_id, s.full_name, s.phone, s.middle_name, r.role_name, u.user_id " +
        "FROM staff s " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "LEFT JOIN users u ON u.staff_id = s.staff_id " +
        "WHERE s.staff_id = ?",
        [staffId]
      );
      const staff = staffResult[0];

      if (staff.length === 0) {
        return response.status(404).json({ error: "Staff record not found" });
      }
      if (staff[0].user_id) {
        return response.status(409).json({ error: "That person already has a login account." });
      }

      const takenResult = await db.query("SELECT user_id FROM users WHERE LOWER(email) = ?", [address]);
      const taken = takenResult[0];
      if (taken.length > 0) {
        return response.status(409).json({
          error: "The email " + address + " is already used by another account. " +
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

  app.post("/api/users/:staffId/account", notOwnAccount, async function (request, response) {
    const draftResult = await takeAccountDraft(request.body.draftId, request.actor.staffId, "login");

    if (draftResult.error) return response.status(410).json({ error: draftResult.error });

    const draft = draftResult.draft;
    const details = draft.details;

    if (details.staffId !== Number(request.params.staffId)) {
      return response.status(409).json({
        error: "That review was prepared for a different staff record."
      });
    }

    try {
      const output = await adminProcedures.createLoginForStaff(
        [details.staffId, details.email, await hashPassword(draft.password)]
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
        "Login created for staff " + helpers.staffCode(details.staffId) +
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

  async function resetStaffPassword(request, staffId, options) {
    const settings = options || {};
    const by = settings.by || "the administrator";

    const rowsResult = await db.query(
      "SELECT s.full_name, s.is_active, u.email, r.role_name " +
      "FROM staff s JOIN roles r ON r.role_id = s.role_id " +
      "LEFT JOIN users u ON u.staff_id = s.staff_id " +
      "WHERE s.staff_id = ?",
      [staffId]);
    const rows = rowsResult[0];

    if (rows.length === 0) return { status: 404, body: { error: "Staff record not found" } };

    if (!rows[0].is_active) {
      return { status: 409, body: { error: "This account is deactivated. Activate it before resetting its password." } };
    }

    if (settings.roles && settings.roles.indexOf(rows[0].role_name) === -1) {
      return { status: 403, body: { error: settings.refusal || "You cannot reset this account's password." } };
    }
    if (!rows[0].email) {
      return { status: 404, body: { error: "This staff member has no login account." } };
    }

    const password = generatePassword();
    const output = await adminProcedures.resetUserPassword(
      [staffId, await hashPassword(password)]
    );

    if (output.status_code !== 200) {
      return { status: output.status_code, body: { error: output.message } };
    }

    await endSessionsForStaff(Number(staffId), null,
      "Your password was reset by " + by + ". Sign in with the one that was sent to you.");

    const releasedResult = await db.query(
      "UPDATE users SET failed_attempts = 0, held_until = NULL " +
      "WHERE staff_id = ? AND (failed_attempts > 0 OR held_until IS NOT NULL)",
      [staffId]);
    const released = releasedResult[0];
    if (released.affectedRows > 0) {
      await writeAuditLog(request, "ACCOUNT_RELEASED",
        rows[0].email + " released from its sign-in hold by a password reset",
        { staff_id: Number(staffId), email: rows[0].email });
    }

    const delivery = await deliverFirstPassword({
      email: rows[0].email,
      name: rows[0].full_name,
      roleName: rows[0].role_name,
      password: password
    });

    await writeAuditLog(request, "RESET_PASSWORD",
      "Password reset for " + rows[0].email + " by " + by +
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

  app.post("/api/users/:staffId/reset-password", notOwnAccount, async function (request, response) {
    try {
      const result = await resetStaffPassword(request, request.params.staffId, { by: "the administrator" });
      response.status(result.status).json(result.body);
    } catch (error) {
      console.error("Password reset failed:", error.message);
      response.status(500).json({ error: "Unable to reset the password" });
    }
  });

  app.post("/api/users/:staffId/release-hold", notOwnAccount, async function (request, response) {
    const staffId = Number(request.params.staffId);
    try {
      const rowsResult = await db.query(
        "SELECT u.email, r.role_name, s.is_active " +
        "FROM users u " +
        "JOIN staff s ON s.staff_id = u.staff_id " +
        "JOIN roles r ON r.role_id = s.role_id " +
        "WHERE u.staff_id = ?",
        [staffId]);
      const rows = rowsResult[0];
      if (rows.length === 0) {
        return response.status(404).json({ error: "This staff member has no login account." });
      }

      const byAdmin = request.actor.roleName === ADMIN;
      if (!byAdmin && !ROLES_MANAGED_BY_MANAGER.includes(rows[0].role_name)) {
        return response.status(403).json({
          error: "You can only lift the hold on a cashier, an inventory clerk or a delivery driver."
        });
      }

      if (!byAdmin && !rows[0].is_active) {
        return response.status(409).json({ error: "This account is deactivated, so there is no hold to lift." });
      }

      const releasedResult = await db.query(
        "UPDATE users SET failed_attempts = 0, held_until = NULL " +
        "WHERE staff_id = ? AND held_until IS NOT NULL AND held_until > NOW()",
        [staffId]);
      const released = releasedResult[0];
      if (released.affectedRows === 0) {
        return response.status(409).json({ error: "This account is not on hold, so there is nothing to lift." });
      }

      let by = "the administrator";
      if (!byAdmin) {
        const whoResult = await db.query("SELECT full_name FROM staff WHERE staff_id = ?", [request.actor.staffId]);
        const who = whoResult[0];
        by = "the manager " + (who[0] ? who[0].full_name : request.actor.email);
      }

      await writeAuditLog(request, "ACCOUNT_RELEASED",
        rows[0].email + " released from its sign-in hold by " + by,
        { staff_id: staffId, email: rows[0].email });

      response.json({ message: "The hold is lifted. " + rows[0].email + " can sign in again now." });
    } catch (error) {
      console.error("Lifting a hold failed:", error.message);
      response.status(500).json({ error: "Unable to lift the hold" });
    }
  });

  function auditLogFilter(query) {
    const role = String(query.role || "all").trim();
    const search = String(query.search || "").trim();
    const from = String(query.from || "").trim();
    const to = String(query.to || "").trim();

    const where = [];
    const params = [];

    if (role !== "" && role !== "all") {
      where.push("COALESCE(l.role_name, r.role_name, 'System') = ?");
      params.push(role);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push("l.created_at >= ?");
      params.push(from + " 00:00:00");
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push("l.created_at <= ?");
      params.push(to + " 23:59:59");
    }

    if (search !== "") {
      where.push(wordStartSearch(["s.full_name", "l.action", "l.details", "l.ip_address"], search, params));
    }

    let filter = "";
    if (where.length > 0) {
      filter = " WHERE " + where.join(" AND ");
    }
    return { filter: filter, params: params, from: from, to: to, role: role };
  }

  async function auditLogRows(query, limit) {
    const chosen = auditLogFilter(query);
    const rowsResult = await db.query(
      "SELECT l.log_id, l.staff_id, l.action, l.action_type, " +
      "l.details, l.metadata, l.ip_address, l.created_at, " +
      "COALESCE(s.full_name, 'System') AS staff_name, " +
      "COALESCE(l.role_name, r.role_name, 'System') AS role_name " +
      "FROM audit_logs l " +
      "LEFT JOIN staff s ON s.staff_id = l.staff_id " +
      "LEFT JOIN roles r ON r.role_id = s.role_id " +
      chosen.filter +
      " ORDER BY l.log_id DESC " +
      "LIMIT ?",
      chosen.params.concat([limit])
    );
    const rows = rowsResult[0];
    return { rows: rows, chosen: chosen };
  }

  app.get("/api/audit-logs", async function (request, response) {
    const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 500, 1), 2000);

    try {
      const logResult = await auditLogRows(request.query, limit);
      response.json(logResult.rows);
    } catch (error) {
      console.error("Loading audit logs failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  const EXPORT_LIMIT = 10000;
  const AUDIT_TYPE_LABELS = {
    CREATE: "Create", UPDATE: "Update", DELETE: "Delete", VOID: "Void", RESTORE: "Restore",
    BACKUP: "Backup", LOGIN: "Sign in", LOGOUT: "Sign out", LOGIN_FAILURE: "Failed sign-in",
    SECURITY: "Security", PAYMENT: "Payment", ACCESS: "Access", OTHER: "Other"
  };

  function exportFilterText(chosen, search) {
    const parts = [];
    if (chosen.from) parts.push("from " + chosen.from);
    if (chosen.to) parts.push("to " + chosen.to);
    if (chosen.role !== "" && chosen.role !== "all") {
      parts.push(chosen.role + " entries only");
    }
    if (search) parts.push("matching \"" + search + "\"");
    if (parts.length === 0) return "All entries";
    const text = parts.join(", ");
    return text[0].toUpperCase() + text.slice(1);
  }

  function exportRowValues(row) {
    return [
      String(row.created_at || ""),
      String(row.staff_name || "") + (row.staff_id ? " " + helpers.staffCode(row.staff_id) : ""),
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
    sheet.getCell("A2").value = subtitle + " • " + rows.length + " entries • exported " + new Date().toLocaleString("en-PH");
    sheet.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF4D5661" } };

    const head = sheet.getRow(3);
    head.values = EXPORT_HEADINGS;
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.eachCell(function (cell) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B1F24" } };
    });
    sheet.autoFilter = { from: "A3", to: "F3" };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const added = sheet.addRow(exportRowValues(row));
      added.getCell(6).alignment = { wrapText: true, vertical: "top" };
    }

    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", "attachment; filename=\"" + fileName + ".xlsx\"");
    await workbook.xlsx.write(response);
    response.end();
  }

  function pdfText(value) {
    return String(value)
      .replace(/₱/g, "PHP ")
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "?");
  }

  function writeAuditPdf(response, rows, subtitle, fileName) {
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, bufferPages: true });

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", "attachment; filename=\"" + fileName + ".pdf\"");
    doc.pipe(response);

    const left = doc.page.margins.left;
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const widths = [100, 120, 95, 80, 72];
    let widthsTotal = 0;
    for (let i = 0; i < widths.length; i++) {
      widthsTotal += widths[i];
    }
    widths.push(usable - widthsTotal);
    const padding = 4;
    const bottom = function () { return doc.page.height - doc.page.margins.bottom - 14; };

    doc.font("Helvetica-Bold").fontSize(15).fillColor("#14181d").text("Audit Trail", left, doc.page.margins.top);
    doc.font("Helvetica").fontSize(9).fillColor("#4d5661")
      .text(pdfText(subtitle + " • " + rows.length + " entries • exported " + new Date().toLocaleString("en-PH")));
    doc.moveDown(0.6);

    const drawHeading = function () {
      const y = doc.y;
      doc.rect(left, y, usable, 18).fill("#1b1f24");
      let x = left;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff");
      for (let index = 0; index < EXPORT_HEADINGS.length; index++) {
        doc.text(EXPORT_HEADINGS[index], x + padding, y + 5, { width: widths[index] - padding * 2, lineBreak: false });
        x += widths[index];
      }
      doc.y = y + 18;
    };

    drawHeading();
    doc.font("Helvetica").fontSize(8.5);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const rowValues = exportRowValues(rows[rowIndex]);
      const values = [];
      for (let index = 0; index < rowValues.length; index++) {
        values.push(pdfText(rowValues[index]));
      }

      let tallest = doc.heightOfString(values[0], { width: widths[0] - padding * 2 });
      for (let index = 1; index < values.length; index++) {
        const cellHeight = doc.heightOfString(values[index], { width: widths[index] - padding * 2 });
        if (cellHeight > tallest) tallest = cellHeight;
      }
      const height = tallest + padding * 2;

      if (doc.y + height > bottom()) {
        doc.addPage();
        drawHeading();
        doc.font("Helvetica").fontSize(8.5);
      }

      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(left, y, usable, height).fill("#f3f4f6");
      let x = left;
      doc.fillColor("#14181d");
      for (let index = 0; index < values.length; index++) {
        doc.text(values[index], x + padding, y + padding, { width: widths[index] - padding * 2 });
        x += widths[index];
      }
      doc.y = y + height;
    }

    if (rows.length === 0) {
      doc.moveDown().fillColor("#4d5661").text("No entries match these filters.");
    }

    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      doc.font("Helvetica").fontSize(8).fillColor("#616b78").text(
        "Page " + (index + 1) + " of " + range.count,
        left, doc.page.height - doc.page.margins.bottom - 8,
        { width: usable, align: "right", lineBreak: false });
    }

    doc.end();
  }

  app.get("/api/audit-logs/export/:format", async function (request, response) {
    const format = request.params.format;
    if (format !== "xlsx" && format !== "pdf") {
      return response.status(400).json({ error: "Export as xlsx or pdf." });
    }

    try {
      const logResult = await auditLogRows(request.query, EXPORT_LIMIT);
      const rows = logResult.rows;
      const chosen = logResult.chosen;
      const search = String(request.query.search || "").trim();
      const subtitle = exportFilterText(chosen, search);
      const stamp = new Date();
      const fileName = "audit-trail_" + stamp.getFullYear() + "-" + twoDigits(stamp.getMonth() + 1) + "-" +
        twoDigits(stamp.getDate()) + "_" + twoDigits(stamp.getHours()) + twoDigits(stamp.getMinutes());

      await writeAuditLog(request, "EXPORT_AUDIT",
        "Exported " + rows.length + " audit entries as " + (format === "pdf" ? "PDF" : "Excel") + " (" + subtitle + ")");

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

  app.get("/api/audit-logs/types", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT action_type, COUNT(*) AS entries " +
        "FROM audit_logs " +
        "GROUP BY action_type " +
        "ORDER BY entries DESC"
      );
      const rows = rowsResult[0];
      response.json(rows);
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  const BACKUP_DIR = process.env.HARDWARE_BACKUP_DIR || path.join(__dirname, "..", "..", "..", "backups");
  const BACKUP_PREFIX = "hardware_db_backup_";
  const BACKUP_STORE_KIND = String(process.env.HARDWARE_BACKUP_STORE || (IS_VERCEL ? "database" : "folder"))
    .trim().toLowerCase() === "database" ? "database" : "folder";

  const AUTO_PREFIX = "hardware_db_auto_";

  const BACKUP_NAME =
    /^hardware_db_(backup|auto)_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;
  const AUTO_NAME = /^hardware_db_auto_\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sql$/;

  const AUTO_SWITCH_FILE = path.join(BACKUP_DIR, "auto-backup.json");

  const folderStore = {
    names: async function () {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const allNames = await fsp.readdir(BACKUP_DIR);
      const names = [];
      for (let i = 0; i < allNames.length; i++) {
        if (BACKUP_NAME.test(allNames[i])) names.push(allNames[i]);
      }
      return names;
    },
    list: async function () {
      const files = [];
      const names = await folderStore.names();
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const stats = await fsp.stat(path.join(BACKUP_DIR, name));
        files.push({ name: name, bytes: stats.size, createdAt: stats.mtime.toISOString() });
      }
      return files;
    },
    exists: async function (name) {
      return fs.existsSync(path.join(BACKUP_DIR, name));
    },
    writer: async function (name) {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const fullPath = path.join(BACKUP_DIR, name);
      const out = fs.createWriteStream(fullPath, { encoding: "utf8" });
      const close = function () { return new Promise(function (resolve) { return out.end(resolve); }); };
      return {
        write: function (text) {
          return new Promise(function (resolve, reject) {
            out.write(text, function (error) {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        },
        finish: async function () {
          await close();
          return (await fsp.stat(fullPath)).size;
        },
        abandon: async function () {
          await close();
        }
      };
    },
    readText: async function (name) {
      try {
        return await fsp.readFile(path.join(BACKUP_DIR, name), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    remove: async function (name) {
      try {
        await fsp.unlink(path.join(BACKUP_DIR, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    readSwitch: async function () {
      try {
        return JSON.parse(await fsp.readFile(AUTO_SWITCH_FILE, "utf8")).enabled !== false;
      } catch (error) {
        return true;
      }
    },
    writeSwitch: async function (enabled) {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.writeFile(AUTO_SWITCH_FILE,
        JSON.stringify({ enabled: enabled, changedAt: new Date().toISOString() }, null, 2) + "\n");
    },
    readError: async function () {
      return autoBackup.lastError;
    },
    writeError: async function () {}
  };

  async function readFlag(key) {
    const rowsResult = await db.query("SELECT flag_value FROM app_flags WHERE flag_key = ?", [key]);
    const rows = rowsResult[0];
    return rows.length > 0 ? rows[0].flag_value : null;
  }

  async function writeFlag(key, value) {
    await db.query(
      "INSERT INTO app_flags (flag_key, flag_value, updated_at) VALUES (?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE flag_value = VALUES(flag_value), updated_at = VALUES(updated_at)",
      [key, value === null ? null : String(value).slice(0, 255), Date.now()]);
  }

  const databaseStore = {
    names: async function () {
      const rowsResult = await db.query("SELECT file_name FROM backup_files");
      const rows = rowsResult[0];
      const names = [];
      for (let i = 0; i < rows.length; i++) {
        names.push(rows[i].file_name);
      }
      return names;
    },
    list: async function () {
      const rowsResult = await db.query("SELECT file_name, bytes, created_at FROM backup_files");
      const rows = rowsResult[0];
      const files = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        files.push({
          name: row.file_name,
          bytes: Number(row.bytes),
          createdAt: new Date(Number(row.created_at)).toISOString()
        });
      }
      return files;
    },
    exists: async function (name) {
      const rowsResult = await db.query("SELECT 1 FROM backup_files WHERE file_name = ?", [name]);
      const rows = rowsResult[0];
      return rows.length > 0;
    },
    writer: async function (name) {
      const parts = [];
      return {
        write: async function (text) {
          parts.push(text);
        },
        finish: async function () {
          const text = Buffer.from(parts.join(""), "utf8");
          await db.query(
            "INSERT INTO backup_files (file_name, bytes, created_at, content) VALUES (?, ?, ?, ?)",
            [name, text.length, Date.now(), zlib.gzipSync(text)]);
          return text.length;
        },
        abandon: async function () {}
      };
    },
    readText: async function (name) {
      const rowsResult = await db.query("SELECT content FROM backup_files WHERE file_name = ?", [name]);
      const rows = rowsResult[0];
      if (rows.length === 0) return null;
      return zlib.gunzipSync(rows[0].content).toString("utf8");
    },
    remove: async function (name) {
      const queryResult = await db.query("DELETE FROM backup_files WHERE file_name = ?", [name]);
      const result = queryResult[0];
      return result.affectedRows > 0;
    },
    readSwitch: async function () {
      return (await readFlag("auto_backup_enabled")) !== "0";
    },
    writeSwitch: async function (enabled) {
      await writeFlag("auto_backup_enabled", enabled ? "1" : "0");
    },
    readError: async function () {
      return await readFlag("auto_backup_error");
    },
    writeError: async function (message) {
      await writeFlag("auto_backup_error", message);
    }
  };

  const backupStore = BACKUP_STORE_KIND === "database" ? databaseStore : folderStore;

  function twoDigits(number) {
    return String(number).padStart(2, "0");
  }

  function backupFileName(when, prefix) {
    const date = when.getFullYear() + "-" + twoDigits(when.getMonth() + 1) + "-" + twoDigits(when.getDate());
    const time = twoDigits(when.getHours()) + twoDigits(when.getMinutes());
    return (prefix || BACKUP_PREFIX) + date + "_" + time + ".sql";
  }

  async function freeBackupName(when, prefix) {
    const base = backupFileName(when, prefix);
    let name = base;
    let counter = 2;

    while (await backupStore.exists(name)) {
      name = base.replace(/\.sql$/, "-" + counter + ".sql");
      counter += 1;
    }
    return name;
  }

  async function generatedColumnsOf(table) {
    const rowsResult = await db.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
      "AND (EXTRA LIKE '%STORED GENERATED%' OR EXTRA LIKE '%VIRTUAL GENERATED%')",
      [DB_NAME, table]
    );
    const rows = rowsResult[0];
    const names = [];
    for (let i = 0; i < rows.length; i++) {
      names.push(rows[i].COLUMN_NAME);
    }
    return names;
  }

  async function columnsOf(table) {
    const rowsResult = await db.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
      "ORDER BY ORDINAL_POSITION",
      [DB_NAME, table]
    );
    const rows = rowsResult[0];
    const names = [];
    for (let i = 0; i < rows.length; i++) {
      names.push(rows[i].COLUMN_NAME);
    }
    return names;
  }

  async function listBaseTables() {
    const rowsResult = await db.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' " +
      "ORDER BY TABLE_NAME",
      [DB_NAME]
    );
    const rows = rowsResult[0];
    const names = [];
    for (let i = 0; i < rows.length; i++) {
      if (!SERVER_TABLES.includes(rows[i].TABLE_NAME)) names.push(rows[i].TABLE_NAME);
    }
    return names;
  }

  async function listViews() {
    const rowsResult = await db.query(
      "SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS " +
      "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [DB_NAME]
    );
    const rows = rowsResult[0];

    const pending = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      pending.push({
        name: row.TABLE_NAME,
        definition: String(row.VIEW_DEFINITION || "").toLowerCase()
      });
    }

    const ordered = [];

    while (pending.length > 0) {
      let chosen = 0;
      for (let i = 0; i < pending.length; i++) {
        let usesPending = false;
        for (let j = 0; j < pending.length; j++) {
          const other = pending[j];
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

      ordered.push(pending[chosen].name);
      pending.splice(chosen, 1);
    }

    return ordered;
  }

  async function listProcedures() {
    const rowsResult = await db.query(
      "SELECT ROUTINE_NAME FROM information_schema.ROUTINES " +
      "WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' " +
      "ORDER BY ROUTINE_NAME",
      [DB_NAME]
    );
    const rows = rowsResult[0];
    const names = [];
    for (let i = 0; i < rows.length; i++) {
      names.push(rows[i].ROUTINE_NAME);
    }
    return names;
  }

  function stripDefiner(sql) {
    return String(sql).replace(/DEFINER\s*=\s*(`[^`]*`|"[^"]*")@(`[^`]*`|"[^"]*")\s*/gi, "");
  }

  async function turnOffAnsiQuotes(connection) {
    const rowsResult = await connection.query("SELECT @@SESSION.sql_mode AS mode");
    const oldMode = rowsResult[0][0].mode;
    const parts = String(oldMode).split(",");
    const kept = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "" && parts[i] !== "ANSI" && parts[i] !== "ANSI_QUOTES") {
        kept.push(parts[i]);
      }
    }
    await connection.query("SET SESSION sql_mode = ?", [kept.join(",")]);
    return oldMode;
  }

  async function writeBackupFile(prefix) {
    const now = new Date();
    const name = await freeBackupName(now, prefix);

    const tables = await listBaseTables();
    const views = await listViews();
    const procedures = await listProcedures();

    const out = await backupStore.writer(name);
    function write(text) {
      return out.write(text);
    }

    let rowTotal = 0;

    const showConnection = await db.getConnection();
    let oldMode = null;

    try {
      oldMode = await turnOffAnsiQuotes(showConnection);

      await write(
        "-- Lucelyn Hardware - full database backup\n" +
        "-- Database : " + DB_NAME + "\n" +
        "-- Taken on : " + now.toISOString() + "\n" +
        "-- Contains : " + tables.length + " tables, " + views.length + " views, " + procedures.length + " procedures\n" +
        "--\n" +
        "-- Restore from the Backup & Recovery screen, or run this file in\n" +
        "-- MySQL Workbench. It rebuilds every table and reloads every row.\n\n" +
        "SET FOREIGN_KEY_CHECKS = 0;\n" +
        "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n"
      );

      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        await write("DROP VIEW IF EXISTS " + sqlName(view) + ";\n");
      }
      await write("\n");

      for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const createdRowsResult = await showConnection.query("SHOW CREATE TABLE " + sqlName(table));
        const createdRows = createdRowsResult[0];
        const created = createdRows[0];
        await write("-- ----------------------------------------\n");
        await write("-- Table: " + table + "\n");
        await write("-- ----------------------------------------\n");
        await write("DROP TABLE IF EXISTS " + sqlName(table) + ";\n");
        await write(stripDefiner(created["Create Table"]) + ";\n\n");

        const skip = await generatedColumnsOf(table);
        const allColumns = await columnsOf(table);
        const columns = [];
        const quotedColumns = [];
        for (let c = 0; c < allColumns.length; c++) {
          if (!skip.includes(allColumns[c])) {
            columns.push(allColumns[c]);
            quotedColumns.push(sqlName(allColumns[c]));
          }
        }
        const columnList = quotedColumns.join(", ");

        let count = 0;
        let batch = [];
        const flush = async function () {
          if (batch.length === 0) return;
          await write("INSERT INTO " + sqlName(table) + " (" + columnList + ") VALUES\n");
          await write(batch.join(",\n") + ";\n");
          batch = [];
        };

        const connection = await db.getConnection();
        try {
          const stream = connection.connection
            .query("SELECT " + columnList + " FROM " + sqlName(table))
            .stream({ highWaterMark: 200 });
          for await (const row of stream) {
            const values = [];
            for (let c = 0; c < columns.length; c++) {
              values.push(sqlValue(row[columns[c]]));
            }
            batch.push("  (" + values.join(", ") + ")");
            count += 1;
            if (batch.length >= 100) await flush();
          }
          await flush();
        } finally {
          connection.release();
        }

        rowTotal += count;
        await write(count === 0 ? "-- no rows\n\n" : "-- " + count + " row(s)\n\n");
      }

      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        const createdRowsResult = await showConnection.query("SHOW CREATE VIEW " + sqlName(view));
        const createdRows = createdRowsResult[0];
        const created = createdRows[0];
        await write("-- View: " + view + "\n");
        await write(stripDefiner(created["Create View"]) + ";\n\n");
      }

      if (procedures.length > 0) {
        await write("-- ----------------------------------------\n");
        await write("-- Stored procedures\n");
        await write("-- ----------------------------------------\n");
        await write("DELIMITER //\n");

        for (let i = 0; i < procedures.length; i++) {
          const procedure = procedures[i];
          const createdRowsResult = await showConnection.query("SHOW CREATE PROCEDURE " + sqlName(procedure));
          const createdRows = createdRowsResult[0];
          const created = createdRows[0];
          const definition = stripDefiner(created["Create Procedure"])
            .replace(/^CREATE\s+PROCEDURE\s+"[^"]*"/i, "CREATE PROCEDURE " + sqlName(procedure));
          await write("DROP PROCEDURE IF EXISTS " + sqlName(procedure) + " //\n");
          await write(definition + " //\n\n");
        }

        await write("DELIMITER ;\n\n");
      }

      await write("SET FOREIGN_KEY_CHECKS = 1;\n");
    } catch (error) {
      await out.abandon();
      throw error;
    } finally {
      if (oldMode !== null) {
        await showConnection.query("SET SESSION sql_mode = ?", [oldMode]).catch(function () {});
      }
      showConnection.release();
    }

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

  let restoreInProgress = false;

  async function runSqlScript(sql) {
    const statements = splitSqlStatements(sql);

    if (statements.length === 0) {
      throw new Error("That file contains no SQL statements.");
    }

    const usesDoubleQuotes = /CREATE TABLE\s+"/i.test(sql);

    const connection = await db.getConnection();
    restoreInProgress = true;

    try {
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      if (usesDoubleQuotes) {
        await connection.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')");
      }

      for (let j = 0; j < statements.length; j++) {
        const statement = statements[j];
        if (/^use[\s`]/i.test(statement)) continue;
        if (touchesServerTable(statement) || isGtidLine(statement)) continue;
        if (/^create\s/i.test(statement)) {
          await connection.query(stripDefiner(statement));
        } else {
          await connection.query(statement);
        }

        if (usesDoubleQuotes && /^set\s+(session\s+)?sql_mode\s*=/i.test(statement)) {
          await connection.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')");
        }
      }

      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      return statements.length;
    } finally {
      restoreInProgress = false;
      connection.destroy();
    }
  }

  function touchesServerTable(statement) {
    const found = /^(?:drop\s+table\s+(?:if\s+exists\s+)?|create\s+table\s+(?:if\s+not\s+exists\s+)?|insert\s+(?:ignore\s+)?into\s+|replace\s+(?:into\s+)?|lock\s+tables\s+|alter\s+table\s+|truncate\s+(?:table\s+)?|delete\s+from\s+)(?:[`"]?\w+[`"]?\.)?[`"]?(\w+)/i.exec(statement);
    return found !== null && SERVER_TABLES.includes(found[1].toLowerCase());
  }

  function isGtidLine(statement) {
    return /^set\s+@@(session\.sql_log_bin|global\.gtid_purged)/i.test(statement);
  }

  function settingNumber(name, fallback, low, high) {
    const value = Number(process.env[name]);
    if (!Number.isInteger(value) || value < low || value > high) return fallback;
    return value;
  }
  const AUTO_HOUR = settingNumber("BACKUP_HOUR", 2, 0, 23);
  const KEEP_DAYS = settingNumber("BACKUP_KEEP_DAYS", 30, 1, 365);
  const MANUAL_LIMIT = settingNumber("BACKUP_MANUAL_LIMIT", 20, 1, 200);
  const AUTO_CHECK_MS = 10 * 60 * 1000;
  const AUTO_FIRST_CHECK_MS = 60 * 1000;

  async function backupNames() {
    const all = await backupStore.names();
    const automatic = [];
    const manual = [];
    for (let i = 0; i < all.length; i++) {
      if (AUTO_NAME.test(all[i])) automatic.push(all[i]);
      if (BACKUP_NAME.test(all[i]) && !AUTO_NAME.test(all[i])) manual.push(all[i]);
    }
    automatic.sort();
    manual.sort();
    return { automatic: automatic, manual: manual };
  }

  function backupStamp(name) {
    return name.replace(/^hardware_db_(backup|auto)_/, "");
  }

  async function removeOldBackups() {
    const storedNames = await backupStore.names();
    const names = [];
    for (let i = 0; i < storedNames.length; i++) {
      if (BACKUP_NAME.test(storedNames[i])) names.push(storedNames[i]);
    }
    if (names.length === 0) return 0;

    names.sort(function (left, right) { return backupStamp(left).localeCompare(backupStamp(right)); });
    const newest = names[names.length - 1];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const keepFrom = cutoff.getFullYear() + "-" + twoDigits(cutoff.getMonth() + 1) + "-" + twoDigits(cutoff.getDate());

    let removed = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name === newest) continue;
      if (backupStamp(name).slice(0, 10) < keepFrom) {
        await backupStore.remove(name);
        removed += 1;
      }
    }
    if (removed > 0) console.log("Deleted " + removed + " backup(s) older than " + KEEP_DAYS + " days.");
    return removed;
  }

  async function safeToRotate() {
    return !(await proceduresAreMissing());
  }

  const autoBackup = {
    enabled: true,
    running: false,
    lastFileName: null,
    lastAt: null,
    lastError: null,
    failures: 0
  };

  function todayStamp() {
    const now = new Date();
    return now.getFullYear() + "-" + twoDigits(now.getMonth() + 1) + "-" + twoDigits(now.getDate());
  }

  async function runAutoBackup() {
    if (!autoBackup.enabled || autoBackup.running) return "off or already running";

    if (restoreInProgress) return "a restore is running";

    autoBackup.running = true;

    try {
      const summary = await writeBackupFile(AUTO_PREFIX);
      if (await safeToRotate()) await removeOldBackups();

      autoBackup.lastFileName = summary.fileName;
      autoBackup.lastAt = summary.createdAt;
      if (autoBackup.lastError) console.log("The daily backup is working again (" + summary.fileName + ").");
      autoBackup.lastError = null;
      autoBackup.failures = 0;
      await backupStore.writeError(null);
      return "saved " + summary.fileName;
    } catch (error) {
      autoBackup.failures += 1;
      autoBackup.lastError = error.message;
      try {
        await backupStore.writeError(error.message);
      } catch (ignored) {  }

      if (autoBackup.failures === 1) {
        console.error("The daily backup failed:", error.message);
        try {
          await writeAuditLog(
            { staffId: null, request: null },
            "BACKUP_FAILED",
            "The daily backup failed: " + error.message
          );
        } catch (ignored) {  }
      }
      throw error;
    } finally {
      autoBackup.running = false;
    }
  }

  async function todayIsBackedUp() {
    const today = AUTO_PREFIX + todayStamp();
    const names = (await backupNames()).automatic;
    for (let i = 0; i < names.length; i++) {
      if (names[i].startsWith(today)) return true;
    }
    return false;
  }

  async function dailyBackupCheck() {
    if (!autoBackup.enabled || autoBackup.running) return;
    if (new Date().getHours() < AUTO_HOUR) return;

    try {
      if (await todayIsBackedUp()) return;
    } catch (error) {
      return;
    }

    try {
      await runAutoBackup();
    } catch (error) {
    }
  }

  async function runDailyBackup() {
    autoBackup.enabled = await backupStore.readSwitch();
    if (!autoBackup.enabled) return "switched off";
    if (await todayIsBackedUp()) return "today's is already saved";
    return await runAutoBackup();
  }

  async function startAutoBackup() {
    autoBackup.enabled = await backupStore.readSwitch();

    try {
      const names = (await backupNames()).automatic;
      if (names.length > 0) autoBackup.lastFileName = names[names.length - 1];
    } catch (error) {  }

    if (!autoBackup.enabled) {
      console.log("The daily backup is switched off. Turn it on from the Backup & Recovery screen.");
    } else {
      console.log("Daily backup at " + twoDigits(AUTO_HOUR) + ":00, deleting backups older than " + KEEP_DAYS + " days. " +
        "Up to " + MANUAL_LIMIT + " backups taken by hand are kept until deleted.");
    }

    const first = setTimeout(dailyBackupCheck, AUTO_FIRST_CHECK_MS);
    const timer = setInterval(dailyBackupCheck, AUTO_CHECK_MS);
    if (typeof first.unref === "function") first.unref();
    if (typeof timer.unref === "function") timer.unref();
  }

  const ARCHIVE_SWEEP_MS = 24 * 60 * 60 * 1000;

  async function runArchiveSweep() {
    if (await proceduresAreMissing()) return;

    try {
      const output = await adminProcedures.sweepArchives();

      const deliveries = Number(output.deliveries) || 0;
      const materials = Number(output.materials) || 0;
      if (deliveries < 0) {
        console.error("Archive sweep failed inside the database (" + output.err_no + "): " + output.err_text);
        return;
      }
      publishChange("staff", "sweep", null);
      publishChange("archives", "sweep", null);

      if (deliveries > 0 || materials > 0) {
        console.log("Archive sweep: put away " + deliveries + " closed " +
          (deliveries === 1 ? "delivery" : "deliveries") + " and " + materials + " idle " +
          (materials === 1 ? "material" : "materials") + ".");
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

  app.get("/api/features", async function (request, response) {
    try {
      const roleRowsResult = await db.query("SELECT role_id, role_name FROM roles ORDER BY role_id");
      const roleRows = roleRowsResult[0];

      const roles = [];
      for (let i = 0; i < roleRows.length; i++) {
        const row = roleRows[i];
        if (FEATURE_ROLES.includes(row.role_name)) {
          roles.push(row);
        }
      }

      const perRole = {};
      for (let j = 0; j < roles.length; j++) {
        const role = roles[j];
        perRole[role.role_name] = {};
        const roleFeatures = await featuresOf(role.role_name);
        for (let i = 0; i < roleFeatures.length; i++) {
          const f = roleFeatures[i];
          perRole[role.role_name][f.key] = f;
        }
      }

      const featureRows = [];
      for (let j = 0; j < FEATURES.length; j++) {
        const feature = FEATURES[j];
        const cells = {};
        for (let i = 0; i < roles.length; i++) {
          const role = roles[i];
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
          hosts: feature.available,
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

  async function roleFeature(roleName, featureKey) {
    const list = await featuresOf(roleName);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.key === featureKey) {
        return f;
      }
    }
    return undefined;
  }

  app.put("/api/features/:featureKey/roles/:roleId", async function (request, response) {
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
      const rolesResult = await db.query("SELECT role_id, role_name FROM roles WHERE role_id = ?", [roleId]);
      const roles = rolesResult[0];
      if (roles.length === 0) return response.status(404).json({ error: "No such role." });
      const role = roles[0];

      if (role.role_name === ADMIN) {
        return response.status(403).json({ error: "The System Administrator holds every screen by role. Nothing here is granted or taken away." });
      }

      const before = await roleFeature(role.role_name, feature.key);
      const byDefault = feature.defaults.includes(role.role_name);

      if (before.held === wanted && (wanted === byDefault || (before.note || "") === note)) {
        let holds = "do not hold";
        if (wanted) {
          holds = "hold";
        }
        return response.json({
          message: "Nothing changed: " + role.role_name + " accounts already " + holds + " " + feature.name + ".",
          changed: false
        });
      }

      if (wanted === byDefault) {
        await db.query("DELETE FROM role_feature_permissions WHERE role_id = ? AND feature_key = ?",
          [roleId, feature.key]);
      } else {
        await db.query(
          "INSERT INTO role_feature_permissions (role_id, feature_key, is_granted, note, granted_by_staff_id) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE is_granted = VALUES(is_granted), note = VALUES(note), " +
          "granted_by_staff_id = VALUES(granted_by_staff_id)",
          [roleId, feature.key, wanted, note || null, request.actor.staffId]);
      }
      forgetFeatureOverrides();

      let message;
      if (wanted && byDefault) {
        message = feature.name + " is now on the " + role.role_name + " menu again.";
      } else if (wanted) {
        message = feature.name + " is now on the " + role.role_name + " menu.";
      } else if (byDefault) {
        message = feature.name + " is off the " + role.role_name + " menu.";
      } else {
        message = feature.name + " is off the " + role.role_name + " menu again.";
      }

      if (before.held !== wanted) {
        let action = "REVOKE_SCREEN";
        let onOff = "off";
        if (wanted) {
          action = "GRANT_SCREEN";
          onOff = "on";
        }
        await writeAuditLog(request, action,
          feature.name + " switched " + onOff + " for " + role.role_name + " accounts",
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

  app.get("/api/backups", requireRole(ADMIN), async function (request, response) {
    try {
      const names = await backupNames();

      const files = [];
      const stored = await backupStore.list();
      for (let i = 0; i < stored.length; i++) {
        const file = stored[i];
        files.push({
          fileName: file.name,
          bytes: file.bytes,
          createdAt: file.createdAt,
          automatic: AUTO_NAME.test(file.name)
        });
      }

      files.sort(function (left, right) {
        return right.createdAt.localeCompare(left.createdAt);
      });

      const madeBy = {};
      try {
        const logsResult = await db.query(
          "SELECT a.action, a.details, s.full_name " +
          "FROM audit_logs a " +
          "LEFT JOIN staff s ON s.staff_id = a.staff_id " +
          "WHERE a.action IN ('BACKUP', 'RESTORE')"
        );
        const logs = logsResult[0];
        for (let i = 0; i < logs.length; i++) {
          const log = logs[i];
          const details = String(log.details || "");
          let fileName = null;
          if (log.action === "BACKUP") {
            fileName = details.split(" ")[0];
          } else {
            const found = /before it is (\S+)/.exec(details);
            if (found) fileName = found[1];
          }
          if (fileName) madeBy[fileName] = log.full_name || "A removed account";
        }
      } catch (error) {
        console.error("Reading who made the backups failed:", error.message);
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (madeBy[file.fileName]) {
          file.madeBy = madeBy[file.fileName];
        } else if (file.automatic) {
          file.madeBy = "System (daily backup)";
        } else {
          file.madeBy = null;
        }
      }

      autoBackup.enabled = await backupStore.readSwitch();
      let lastAuto = null;
      for (let i = 0; i < files.length; i++) {
        if (files[i].automatic) {
          lastAuto = files[i];
          break;
        }
      }
      const lastError = await backupStore.readError();

      let proceduresLoaded = proceduresLoadedCount();
      if (proceduresLoaded === null) proceduresLoaded = await countProcedures();

      response.json({
        files: files,
        auto: {
          enabled: autoBackup.enabled,
          schedule: "daily",
          hour: AUTO_HOUR,
          keep: KEEP_DAYS,
          lastFileName: lastAuto ? lastAuto.fileName : autoBackup.lastFileName,
          lastAt: lastAuto ? lastAuto.createdAt : autoBackup.lastAt,
          lastError: lastError,
          failures: lastError ? Math.max(autoBackup.failures, 1) : 0,
          store: BACKUP_STORE_KIND
        },
        limits: {
          keepDays: KEEP_DAYS,
          manual: MANUAL_LIMIT,
          manualCount: names.manual.length
        },
        procedures: {
          loaded: proceduresLoaded,
          expected: EXPECTED_PROCEDURES
        }
      });
    } catch (error) {
      console.error("Backup list failed:", error.message);
      response.status(500).json({ error: "Unable to read the backup folder" });
    }
  });

  app.put("/api/backups/auto", requireRole(ADMIN), async function (request, response) {
    const enabled = request.body && request.body.enabled;
    if (typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Say whether the daily backup is on or off." });
    }

    try {
      await backupStore.writeSwitch(enabled);
      autoBackup.enabled = enabled;

      if (enabled) {
        await writeAuditLog(request, "AUTO_BACKUP_ON",
          "Daily backup switched on (at " + twoDigits(AUTO_HOUR) + ":00, deleting backups older than " + KEEP_DAYS + " days)");
        if (!IS_VERCEL) dailyBackupCheck();
        response.json({
          message: "The daily backup is on. It runs every day at " + twoDigits(AUTO_HOUR) + ":00.",
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

  const BACKUP_COOLDOWN_MS = 5000;
  let manualBackupRunning = false;
  let lastManualBackupAt = 0;

  app.post("/api/backups", requireRole(ADMIN), async function (request, response) {
    if (manualBackupRunning) {
      return response.status(429).json({ error: "A backup is already being saved. Wait for it to finish." });
    }
    const waitMs = lastManualBackupAt + BACKUP_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      return response.status(429).json({
        error: "Wait " + Math.ceil(waitMs / 1000) + " more second(s) before running another backup."
      });
    }

    manualBackupRunning = true;
    try {
      const names = await backupNames();
      if (names.manual.length >= MANUAL_LIMIT) {
        return response.status(409).json({
          error: "There are already " + names.manual.length + " manual backups, the most this system keeps. " +
                 "Delete one you no longer need, then run the backup again."
        });
      }

      const summary = await writeBackupFile();

      await writeAuditLog(request, "BACKUP",
        summary.fileName + " (" + summary.tableCount + " tables, " + summary.rowCount + " rows)");

      const answer = Object.assign({ message: "Backup saved as " + summary.fileName + "." }, summary);
      response.json(answer);
    } catch (error) {
      console.error("Backup failed:", error.message);
      response.status(500).json({ error: "Unable to create the backup: " + error.message });
    } finally {
      manualBackupRunning = false;
      lastManualBackupAt = Date.now();
    }
  });

  app.get("/api/backups/:fileName", requireRole(ADMIN), async function (request, response) {
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

  app.delete("/api/backups/:fileName", requireRole(ADMIN), async function (request, response) {
    const name = request.params.fileName;

    if (!BACKUP_NAME.test(name)) {
      return response.status(400).json({ error: "That is not a backup file name." });
    }
    if (AUTO_NAME.test(name)) {
      return response.status(403).json({
        error: "That backup was made by the system, so it cannot be deleted. " +
               "The system removes it by itself once it is old enough."
      });
    }

    try {
      if (!(await backupStore.remove(name))) {
        return response.status(404).json({ error: "That backup is no longer saved." });
      }
      await writeAuditLog(request, "BACKUP_DELETE", name);
      response.json({ message: name + " deleted." });
    } catch (error) {
      console.error("Backup delete failed:", error.message);
      response.status(500).json({ error: "Unable to delete that backup" });
    }
  });

  async function restoreShortfall() {
    forgetFeatureOverrides();

    try {
      forgetProcedureCount();
      await migrateOneAtATime(runSqlScript);
      forgetFeatureOverrides();
      const total = await countProcedures();
      if (total >= EXPECTED_PROCEDURES) return "";

      return " WARNING: that backup did not carry the stored procedures -- this " +
        "database now has " + total + " of " + EXPECTED_PROCEDURES + " and nothing can be " +
        "saved until they are put back. Run " +
        "public/database/2-stored-procedures.sql. Your data is intact.";
    } catch (error) {
      console.error("Bringing the database up to date after a restore failed:", error.message);
      return " WARNING: the data is restored, but bringing the database up to date with this " +
        "version of the system failed (" + error.message + "). Restart the server: it repeats that work on start-up.";
    }
  }

  app.post("/api/backups/:fileName/restore", requireRole(ADMIN), async function (request, response) {
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

      safety = await writeBackupFile(AUTO_PREFIX);
      const count = await runSqlScript(text);
      await writeAuditLog(request, "RESTORE", "Restored from " + name + "; the database before it is " + safety.fileName);
      response.json({
        message: "Database restored from " + name + ". " + count + " statements ran. " +
          "The database as it was before is kept as " + safety.fileName + "." + (await restoreShortfall())
      });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Restore failed: " + error.message + restoreUndoNote(safety) });
    }
  });

  app.post("/api/restore", requireRole(ADMIN), express.json({ limit: "50mb" }), async function (request, response) {
    const sql = request.body && request.body.sql;

    if (typeof sql !== "string" || sql.trim() === "") {
      return response.status(400).json({ error: "The file is empty or is not a .sql backup." });
    }

    let safety = null;
    try {
      safety = await writeBackupFile(AUTO_PREFIX);
      const count = await runSqlScript(sql);
      await writeAuditLog(request, "RESTORE",
        "Restored from an uploaded .sql file; the database before it is " + safety.fileName);
      response.json({
        message: "Database restored. " + count + " statements ran. " +
          "The database as it was before is kept as " + safety.fileName + "." + (await restoreShortfall())
      });
    } catch (error) {
      console.error("Restore failed:", error.message);
      response.status(500).json({ error: "Restore failed: " + error.message + restoreUndoNote(safety) });
    }
  });

  function restoreUndoNote(safety) {
    if (safety) {
      return " The database may be part-way restored. To put it back as it was, restore " + safety.fileName + ".";
    } else {
      return "";
    }
  }

  app.get("/api/store-settings", async function (request, response) {
    try {
      const rowsResult = await db.query(
        "SELECT setting_id, store_name, proprietor, address, tin, registration_type, " +
        "vat_rate, invoice_note, penalty_rate, " +
        "bank_name, bank_account_name, bank_account_number, receipt_layout, updated_at, " +
        "st.full_name AS updated_by " +
        "FROM store_settings cfg " +
        "LEFT JOIN staff st ON st.staff_id = cfg.updated_by_staff_id " +
        "WHERE cfg.setting_id = 1"
      );
      const rows = rowsResult[0];

      const settings = Object.assign({}, rows[0] || DEFAULT_STORE_SETTINGS);
      settings.receipt_layout = receiptLayoutFrom(settings.receipt_layout);
      response.json(settings);
    } catch (error) {
      console.error("Store settings failed:", error.message);
      response.status(500).json({ error: error.message });
    }
  });

  function bankDetailsFrom(body) {
    function tidy(value, max) {
      return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
    }

    const bank = {
      bank_name: tidy(body.bankName, 100),
      bank_account_name: tidy(body.bankAccountName, 150),
      bank_account_number: tidy(body.bankAccountNumber, 50)
    };

    let filled = 0;
    if (bank.bank_name !== "") filled += 1;
    if (bank.bank_account_name !== "") filled += 1;
    if (bank.bank_account_number !== "") filled += 1;

    if (filled === 0) {
      return { bank: null };
    }
    if (filled < 3) {
      return { error: "The bank, the account name and the account number are all required." };
    }
    const digitCount = bank.bank_account_number.replace(/\D/g, "").length;
    if (!/^[0-9]+([ -][0-9]+)*$/.test(bank.bank_account_number) || digitCount < 10 || digitCount > 16) {
      return { error: "An account number is 10 to 16 digits, with one space or dash where the bank prints one. " +
                      "Copy it from the passbook or the bank's letter." };
    }
    return { bank: bank };
  }

  app.put("/api/store-settings", requireRole(ADMIN), async function (request, response) {
    const storeName = request.body.storeName;
    const proprietor = request.body.proprietor;
    const address = request.body.address;
    const tin = request.body.tin;
    const registrationType = request.body.registrationType;
    const vatRate = request.body.vatRate;
    const invoiceNote = request.body.invoiceNote;

    const tinProblem = tinComplaint(tin);
    if (tinProblem) return response.status(400).json({ error: tinProblem });

    const bankCheck = bankDetailsFrom(request.body);
    if (bankCheck.error) return response.status(400).json({ error: bankCheck.error });

    const sentLayout = request.body.receiptLayout;
    if (sentLayout !== undefined && (typeof sentLayout !== "object" || sentLayout === null)) {
      return response.status(400).json({ error: "The receipt layout was not understood." });
    }
    if (sentLayout && ![58, 80].includes(Number(sentLayout.paperWidth))) {
      return response.status(400).json({ error: "The paper width is 58 mm or 80 mm." });
    }

    const storedTin = cleanTin(tin);

    try {
      const existingResult = await db.query(
        "SELECT store_name, proprietor, address, tin, registration_type, vat_rate, invoice_note, " +
        "bank_name, bank_account_name, bank_account_number, receipt_layout " +
        "FROM store_settings WHERE setting_id = 1"
      );
      const existing = existingResult[0];

      const before = existing[0] || {};

      const output = await adminProcedures.updateStoreSettings(
        [String(storeName || "").trim().slice(0, 150),
         String(proprietor || "").trim().slice(0, 150),
         String(address || "").trim().slice(0, 255),
         storedTin,
         String(registrationType || "").trim().toUpperCase(),
         Number(vatRate) || 0,
         String(invoiceNote || "").trim().slice(0, 255),
         getActorId(request)]
      );

      if (output.status_code !== 200) {
        return response.status(output.status_code).json({ error: output.message });
      }

      let bankMessage = "";
      let bankChanged = false;
      const bankKeys = ["bank_name", "bank_account_name", "bank_account_number"];
      for (let i = 0; bankCheck.bank && i < bankKeys.length; i++) {
        const key = bankKeys[i];
        if ((before[key] || null) !== bankCheck.bank[key]) {
          bankChanged = true;
        }
      }
      if (bankChanged) {
        const bankOutput = await adminProcedures.updateStoreBankDetails(
          [bankCheck.bank.bank_name, bankCheck.bank.bank_account_name,
           bankCheck.bank.bank_account_number, getActorId(request)]
        );

        if (bankOutput.status_code !== 200) {
          return response.status(bankOutput.status_code).json({
            error: "The store details were saved, but the bank account was not: " + bankOutput.message
          });
        }
        bankMessage = " " + bankOutput.message;
      }

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
        "Store details and tax registration updated",
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
    startAutoBackup: startAutoBackup, startArchiveSweep: startArchiveSweep, runSqlScript: runSqlScript, resetStaffPassword: resetStaffPassword,
    runArchiveSweep: runArchiveSweep, runDailyBackup: runDailyBackup, removeExpiredDrafts: removeExpiredDrafts
  };
}

module.exports = { registerAdminRoutes: registerAdminRoutes };
