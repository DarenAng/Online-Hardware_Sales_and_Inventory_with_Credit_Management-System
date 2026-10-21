const crypto = require("crypto");
const mailer = require("../services/mailer");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const passwordResetMessage = mailer.passwordResetMessage;
const keepAlive = require("../live-changes").keepAlive;

function registerLoginRoutes(app, deps) {
  const db = deps.db;
  const writeAuditLog = deps.writeAuditLog;
  const hashPassword = deps.hashPassword;
  const isHashed = deps.isHashed;
  const verifyPassword = deps.verifyPassword;
  const startSession = deps.startSession;
  const setSessionCookie = deps.setSessionCookie;
  const endSession = deps.endSession;
  const endSessionsForStaff = deps.endSessionsForStaff;
  const renewSessionAfterPasswordChange = deps.renewSessionAfterPasswordChange;
  const clientIp = deps.clientIp;
  const DEFAULT_STORE_SETTINGS = deps.DEFAULT_STORE_SETTINGS;
  const LOGIN_MAX_ATTEMPTS = deps.LOGIN_MAX_ATTEMPTS;
  const LOGIN_HOLD_MINUTES = deps.LOGIN_HOLD_MINUTES;
  const SESSION_IDLE_MINUTES = deps.SESSION_IDLE_MINUTES;
  const passwordComplaint = deps.passwordComplaint;

  const LOGIN_SELECT =
    "SELECT u.user_id, u.staff_id, u.email, u.password, u.must_change_password,\n" +
      "            -- a hold that has run out wipes the count, so the account gets a full set of tries again\n" +
      "            IF(u.held_until IS NOT NULL AND u.held_until <= NOW(), 0, u.failed_attempts) AS failed_attempts,\n" +
      "            IF(u.held_until IS NOT NULL AND u.held_until > NOW(), u.held_until, NULL) AS held_until,\n" +
      "            TIMESTAMPDIFF(SECOND, NOW(), u.held_until) AS held_for_seconds,\n" +
      "            s.first_name, s.middle_name, s.last_name, s.full_name, s.is_active,\n" +
      "            r.role_id, r.role_name\n" +
      "     FROM users u\n" +
      "     JOIN staff s ON s.staff_id = u.staff_id\n" +
      "     JOIN roles r ON r.role_id = s.role_id";

  async function findLoginByExactEmail(address) {
    const rowsResult = await db.query(
      LOGIN_SELECT + " WHERE u.email = ? LIMIT 1",
      [address]);
    const rows = rowsResult[0];
    return rows[0] || null;
  }

  async function findLoginByGmailAlias(localWithoutDots) {
    const rowsResult = await db.query(
      LOGIN_SELECT + "\n" +
        "       WHERE LOWER(SUBSTRING_INDEX(u.email, '@', -1)) IN ('gmail.com', 'googlemail.com')\n" +
        "         AND REPLACE(SUBSTRING_INDEX(u.email, '@', 1), '.', '') = ?\n" +
        "       LIMIT 1",
      [localWithoutDots]);
    const rows = rowsResult[0];
    return rows[0] || null;
  }

  async function storePasswordHash(userId, hash) {
    await db.query(
      "UPDATE users SET password = ? WHERE user_id = ?",
      [hash, userId]);
  }

  async function recordSignIn(userId) {
    await db.query(
      "UPDATE users SET last_login = NOW(), failed_attempts = 0, held_until = NULL WHERE user_id = ?",
      [userId]);
  }

  async function countTry(user) {
    const countedResult = await db.query(
      "UPDATE users\n" +
        "       SET failed_attempts = IF(held_until IS NULL, failed_attempts + 1, 1),\n" +
        "           held_until = NULL\n" +
        "       WHERE user_id = ?\n" +
        "         AND (held_until <= NOW() OR (held_until IS NULL AND failed_attempts < ?))",
      [user.user_id, LOGIN_MAX_ATTEMPTS]);
    const counted = countedResult[0];
    return counted.affectedRows > 0;
  }

  async function clearTries(userId) {
    await db.query("UPDATE users SET failed_attempts = 0 WHERE user_id = ?", [userId]);
  }

  async function holdAccount(user, email, attempts, request) {
    const heldResult = await db.query(
      "UPDATE users SET held_until = DATE_ADD(NOW(), INTERVAL ? MINUTE)\n" +
        "       WHERE user_id = ? AND held_until IS NULL AND failed_attempts >= ?",
      [LOGIN_HOLD_MINUTES, user.user_id, LOGIN_MAX_ATTEMPTS]);
    const held = heldResult[0];
    if (held.affectedRows === 0) return false;

    await writeAuditLog(
      { staffId: user.staff_id, roleName: user.role_name, request: request },
      "ACCOUNT_HELD",
      email + " held for " + LOGIN_HOLD_MINUTES + " minutes after " +
        LOGIN_MAX_ATTEMPTS + " wrong passwords in a row",
      { email: String(email), attempts: attempts, hold_minutes: LOGIN_HOLD_MINUTES }
    );
    await endSessionsForStaff(user.staff_id, null,
      "This account was held after too many wrong passwords, so this screen was signed out.");
    return true;
  }

  function minutesLeft(seconds) {
    const minutes = Math.ceil(Number(seconds || 0) / 60);
    if (minutes < 1) {
      return 1;
    }
    return minutes;
  }

  function heldMessage(minutes) {
    return "This account is held after " + LOGIN_MAX_ATTEMPTS + " wrong passwords in a row. " +
      "Try again in " + minutes + " minute" + (minutes === 1 ? "" : "s") + ", or set a new password with " +
      "\"Forgot your password?\" below, which releases it now.";
  }

  async function heldMinutesNow(user) {
    const rowsResult = await db.query(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(), held_until) AS seconds FROM users WHERE user_id = ?",
      [user.user_id]);
    const rows = rowsResult[0];
    if (rows[0] && rows[0].seconds !== null && Number(rows[0].seconds) > 0) {
      return minutesLeft(rows[0].seconds);
    }
    return LOGIN_HOLD_MINUTES;
  }

  async function refuseHeld(user, email, request, response, minutes) {
    await writeAuditLog(
      { staffId: user.staff_id, roleName: user.role_name, request: request },
      "LOGIN_FAILURE",
      "Sign-in refused for " + email + ": the account is held for " + minutes + " more minute(s)",
      { email: String(email), reason: "held", held_until: user.held_until }
    );
    return response.status(423).json({ error: heldMessage(minutes), heldMinutes: minutes });
  }

  async function temporaryPasswordHash(userId) {
    const rowsResult = await db.query(
      "SELECT password FROM users WHERE user_id = ? AND must_change_password = TRUE",
      [userId]);
    const rows = rowsResult[0];
    if (rows.length > 0) {
      return rows[0].password;
    }
    return null;
  }

  async function saveChosenPassword(userId, hash) {
    const queryResult = await db.query(
      "UPDATE users\n" +
        "       SET password = ?, must_change_password = FALSE\n" +
        "       WHERE user_id = ? AND must_change_password = TRUE",
      [hash, userId]);
    const result = queryResult[0];
    return result.affectedRows > 0;
  }

  async function findLoginByEmail(email) {
    const address = String(email).trim();

    const exact = await findLoginByExactEmail(address);
    if (exact) return exact;

    const at = address.lastIndexOf("@");
    if (at < 1) return null;
    const domain = address.slice(at + 1).toLowerCase();
    if (domain !== "gmail.com" && domain !== "googlemail.com") return null;

    const local = address.slice(0, at).replace(/\./g, "");   
    return findLoginByGmailAlias(local);
  }

  async function passwordMatches(user, password) {
    if (await verifyPassword(password, user.password)) return true;

    const trimmed = String(password).trim();
    if (!user.must_change_password || trimmed === password) {
      return false;
    }
    return await verifyPassword(trimmed, user.password);
  }

  const decoyHash = hashPassword(crypto.randomBytes(24).toString("hex"));

  app.post("/api/login", async function (request, response) {
    const email = String(request.body.email || "").trim();
    const password = request.body.password;

    if (!email || !password) {
      return response.status(400).json({ error: "Email and password are required" });
    }

    try {
      const user = await findLoginByEmail(email);

      if (!user) {
        await verifyPassword(String(password), await decoyHash);
        await writeAuditLog(
          { staffId: null, request: request },
          "LOGIN_FAILURE",
          "Sign-in refused for " + email + ": no account with that email",
          { email: String(email), reason: "unknown_email" }
        );
        return response.status(401).json({ error: "Invalid email or password" });
      }

      if (user.held_until) {
        return await refuseHeld(user, email, request, response, minutesLeft(user.held_for_seconds));
      }

      if (!(await countTry(user))) {
        await holdAccount(user, email, LOGIN_MAX_ATTEMPTS, request);
        return await refuseHeld(user, email, request, response, await heldMinutesNow(user));
      }

      if (!(await passwordMatches(user, password))) {
        const countsResult = await db.query("SELECT failed_attempts FROM users WHERE user_id = ?", [user.user_id]);
        const counts = countsResult[0];
        const attempts = Math.min(Math.max(Number(counts[0] ? counts[0].failed_attempts : 0), 1), LOGIN_MAX_ATTEMPTS);

        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "LOGIN_FAILURE",
          "Sign-in refused for " + email + ": wrong password (" + attempts + " of " + LOGIN_MAX_ATTEMPTS + ")",
          { email: String(email), reason: "wrong_password", attempts: attempts }
        );

        if (attempts >= LOGIN_MAX_ATTEMPTS) {
          await holdAccount(user, email, attempts, request);
          return response.status(423).json({
            error: heldMessage(LOGIN_HOLD_MINUTES), heldMinutes: LOGIN_HOLD_MINUTES
          });
        }

        const left = LOGIN_MAX_ATTEMPTS - attempts;
        let warning = null;
        if (left === 1) {
          warning = "One more wrong password and the account is held for " + LOGIN_HOLD_MINUTES + " minutes.";
        }
        return response.status(401).json({
          error: "Invalid email or password",
          attemptsLeft: left,
          warning: warning
        });
      }

      if (!isHashed(user.password)) {
        await storePasswordHash(user.user_id, await hashPassword(user.password));
      }

      delete user.password;   

      if (!user.is_active) {
        await clearTries(user.user_id);
        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "LOGIN_FAILURE",
          "Sign-in refused for " + email + ": the account is deactivated",
          { email: String(email), reason: "deactivated" }
        );
        return response.status(403).json({ error: "This account is deactivated" });
      }

      await recordSignIn(user.user_id);
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN",
        user.email + " signed in"
      );

      const token = await startSession(user);

      const previous = await endSessionsForStaff(user.staff_id, token,
        "This account signed in on another device, so this screen was signed out.");
      if (previous > 0) {
        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "SESSION_REPLACED",
          user.email + " signed in again; " + previous + " earlier session" + (previous === 1 ? "" : "s") + " ended",
          { sessions_ended: previous }
        );
      }

      setSessionCookie(response, token);

      response.json({ message: "Login successful", user: user });
    } catch (error) {
      console.error("Login failed:", error.message);
      response.status(500).json({ error: "Unable to log in" });
    }
  });

  app.post("/api/logout", async function (request, response) {
    await writeAuditLog(request, "LOGOUT", request.actor.email + " signed out");

    await endSession(request);
    response.clearCookie("sid", { path: "/" });
    response.json({ message: "Signed out" });
  });

  app.post("/api/heartbeat", function (request, response) {
    response.json({
      ok: true,
      idleMinutes: SESSION_IDLE_MINUTES,
      staffId: request.actor.staffId,
      serverTime: new Date().toISOString()
    });
  });

  app.post("/api/change-password", async function (request, response) {
    const newPassword = request.body.newPassword;

    const userId = request.actor.userId;

    if (!userId) {
      return response.status(400).json({ error: "Password change is not allowed" });
    }

    const complaint = passwordComplaint(newPassword);
    if (complaint) {
      return response.status(400).json({ error: complaint });
    }

    try {
      const temporary = await temporaryPasswordHash(userId);
      let sameAsGiven = false;
      if (temporary !== null) {
        if (await verifyPassword(newPassword, temporary)) {
          sameAsGiven = true;
        } else if (newPassword.trim() !== newPassword &&
                   (await verifyPassword(newPassword.trim(), temporary))) {
          sameAsGiven = true;
        }
      }
      if (sameAsGiven) {
        return response.status(400).json({
          error: "Choose a password that is different from the temporary one you were given"
        });
      }

      const changed = await saveChosenPassword(userId, await hashPassword(newPassword));
      if (!changed) {
        return response.status(403).json({ error: "Password change is not allowed" });
      }

      await writeAuditLog(request, "CHANGE_OWN_PASSWORD",
        request.actor.email + " chose their own password on first sign-in");

      await renewSessionAfterPasswordChange(request, response);
      response.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Password update failed:", error.message);
      response.status(500).json({ error: "Unable to change password" });
    }
  });

  const RESET_CODE_MINUTES = 15;
  const RESET_MAX_TRIES = 5;
  const RESET_PER_HOUR = 5;

  const RESET_SENT =
    "If that address belongs to an account here, a six-digit code is on its way to it. " +
    "It stops working in " + RESET_CODE_MINUTES + " minutes. Only one code is sent a minute, " +
    "so give it a moment before asking again.";

  const RESET_NO_MAIL =
    "Codes are sent by email, and mail is not set up on this server, so no code can be sent. " +
    "Ask a manager to reset your password from Staff Passwords, or the System Administrator " +
    "from the staff directory.";

  const RESET_BAD_CODE =
    "That code is not right, or it has stopped working. A code lasts " + RESET_CODE_MINUTES + " " +
    "minutes and " + RESET_MAX_TRIES + " tries; ask for a new one if it has run out.";

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function sendResetCode(request, email) {
    const user = await findLoginByEmail(email);

    if (!user) {
      await writeAuditLog({ staffId: null, request: request },
        "PASSWORD_RESET_REFUSED",
        "A reset code was asked for " + email + ": no account with that email",
        { email: email, reason: "unknown_email" });
      return;
    }
    if (!user.is_active) {
      await writeAuditLog({ staffId: user.staff_id, request: request },
        "PASSWORD_RESET_REFUSED",
        "A reset code was asked for " + email + ": the account is deactivated",
        { email: email, reason: "deactivated" });
      return;
    }

    const recentRowsResult = await db.query(
      "SELECT SUM(created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)) AS last_minute,\n" +
        "              COUNT(*) AS last_hour\n" +
        "       FROM password_resets\n" +
        "       WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)",
      [user.user_id]);
    const recentRows = recentRowsResult[0];
    const recent = recentRows[0];

    if (Number(recent.last_minute) > 0 || Number(recent.last_hour) >= RESET_PER_HOUR) {
      let why = RESET_PER_HOUR + " were already sent this hour";
      if (Number(recent.last_minute) > 0) {
        why = "one was sent less than a minute ago";
      }
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_REFUSED",
        "A reset code for " + user.email + " was not sent: " + why,
        { email: user.email, reason: "too_many" });
      return;
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

    await db.query(
      "UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
      [user.user_id]);
    await db.query(
      "INSERT INTO password_resets (user_id, code_hash, expires_at, requested_ip)\n" +
        "       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)",
      [user.user_id, await hashPassword(code), RESET_CODE_MINUTES, clientIp(request)]);

    const settingsResult = await db.query("SELECT store_name FROM store_settings WHERE setting_id = 1");
    const settings = settingsResult[0];
    let storeName = DEFAULT_STORE_SETTINGS.store_name;
    if (settings[0] && settings[0].store_name) {
      storeName = settings[0].store_name;
    }

    try {
      await sendMail(passwordResetMessage({
        name: user.full_name, email: user.email, code: code,
        minutes: RESET_CODE_MINUTES, storeName: storeName
      }));
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_CODE_SENT",
        "A password reset code was emailed to " + user.email,
        { email: user.email, expires_in_minutes: RESET_CODE_MINUTES });
    } catch (error) {
      console.error("Sending a password reset code failed:", error.message);
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_CODE_FAILED",
        "A password reset code for " + user.email + " could not be sent: " + error.message,
        { email: user.email });
    }
  }

  app.post("/api/password-reset/request", async function (request, response) {
    const body = request.body || {};
    const email = String(body.email || "").trim();

    if (!looksLikeEmail(email)) {
      return response.status(400).json({ error: "Type the email address you sign in with." });
    }
    if (!isMailConfigured()) {
      return response.status(503).json({ error: RESET_NO_MAIL });
    }

    response.json({ message: RESET_SENT, minutes: RESET_CODE_MINUTES });

    keepAlive(sendResetCode(request, email).catch(function (error) {
      console.error("Password reset request failed:", error.message);
    }));
  });

  async function resetCodeMatches(request, user, code) {
    if (!user) {
      await verifyPassword(code, await decoyHash);
      return false;
    }

    const codesResult = await db.query(
      "SELECT reset_id, code_hash FROM password_resets\n" +
        "       WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() AND attempts < ?\n" +
        "       ORDER BY reset_id DESC LIMIT 1",
      [user.user_id, RESET_MAX_TRIES]);
    const codes = codesResult[0];

    if (codes.length === 0) {
      await verifyPassword(code, await decoyHash);
      return false;
    }

    const countedResult = await db.query(
      "UPDATE password_resets SET attempts = attempts + 1 WHERE reset_id = ? AND attempts < ?",
      [codes[0].reset_id, RESET_MAX_TRIES]);
    const counted = countedResult[0];

    if (counted.affectedRows === 0 || !(await verifyPassword(code, codes[0].code_hash))) {
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_WRONG_CODE",
        "A wrong password reset code was typed for " + user.email,
        { email: user.email });
      return false;
    }
    return true;
  }

  app.post("/api/password-reset/verify", async function (request, response) {
    const body = request.body || {};
    const email = String(body.email || "").trim();
    const code = String(body.code || "").replace(/\s+/g, "");   

    if (!looksLikeEmail(email)) {
      return response.status(400).json({ error: "Type the email address you sign in with." });
    }
    if (!/^\d{6}$/.test(code)) {   
      return response.status(400).json({ error: "The code is the six digits in the email." });
    }

    try {
      const user = await findLoginByEmail(email);

      if (!(await resetCodeMatches(request, user, code))) {
        return response.status(400).json({ error: RESET_BAD_CODE });
      }
      if (!user.is_active) {
        return response.status(403).json({ error: "This account is deactivated" });
      }

      response.json({ message: "Code accepted. Now type the password you want." });
    } catch (error) {
      console.error("Checking a password reset code failed:", error.message);
      response.status(500).json({ error: "Unable to check the code" });
    }
  });

  app.post("/api/password-reset/confirm", async function (request, response) {
    const body = request.body || {};
    const email = String(body.email || "").trim();
    const code = String(body.code || "").replace(/\s+/g, "");   
    const newPassword = body.newPassword;

    if (!looksLikeEmail(email)) {
      return response.status(400).json({ error: "Type the email address you sign in with." });
    }
    if (!/^\d{6}$/.test(code)) {   
      return response.status(400).json({ error: "The code is the six digits in the email." });
    }
    const complaint = passwordComplaint(newPassword);
    if (complaint) {
      return response.status(400).json({ error: complaint });
    }

    try {
      const user = await findLoginByEmail(email);

      if (!(await resetCodeMatches(request, user, code))) {
        return response.status(400).json({ error: RESET_BAD_CODE });
      }

      if (!user.is_active) {
        return response.status(403).json({ error: "This account is deactivated" });
      }

      await db.query(
        "UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
        [user.user_id]);

      await db.query(
        "UPDATE users\n" +
          "         SET password = ?, must_change_password = FALSE, failed_attempts = 0, held_until = NULL\n" +
          "         WHERE user_id = ?",
        [await hashPassword(newPassword), user.user_id]);

      await endSessionsForStaff(user.staff_id, null,
        "Your password was changed with a code sent to your email. Sign in with the new one.");

      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_BY_CODE",
        user.email + " set a new password with a code sent to their email; " +
          "every other session was ended and any sign-in hold released",
        { email: user.email });

      await recordSignIn(user.user_id);
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN",
        user.email + " signed in after setting a new password");

      delete user.password;   
      user.must_change_password = 0;
      user.failed_attempts = 0;
      user.held_until = null;
      user.held_for_seconds = null;

      const token = await startSession(user);
      setSessionCookie(response, token);

      response.json({ message: "Your password was changed.", user: user });
    } catch (error) {
      console.error("Password reset failed:", error.message);
      response.status(500).json({ error: "Unable to reset the password" });
    }
  });
}

module.exports = { registerLoginRoutes: registerLoginRoutes };