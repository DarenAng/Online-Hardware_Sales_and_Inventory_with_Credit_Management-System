// ============================================================
// login.js -- signing in and out, and passwords
// Loaded by: server.js only (from the connections folder). Never sent to a browser.
//
// Routes in this file:
//   POST /api/login                    sign in (with the "3 wrong tries = hold" rule)
//   POST /api/logout                   sign out
//   POST /api/heartbeat                "I am still here" ping from an open page
//   POST /api/change-password          choose your own password on first sign-in
//   POST /api/password-reset/request   "Forgot your password?" - email a 6-digit code
//   POST /api/password-reset/confirm   type the code and a new password
// ============================================================

const crypto = require("crypto");
const mailer = require("../mailer");
const isMailConfigured = mailer.isMailConfigured;
const sendMail = mailer.sendMail;
const passwordResetMessage = mailer.passwordResetMessage;

// Over https (Vercel) the cookie is marked Secure so it never travels in the
// clear; a PC in the shop serves plain http, where a Secure cookie would not
// be sent back at all. COOKIE_SECURE=1 forces it behind your own https proxy.
const SECURE_COOKIE = Boolean(process.env.VERCEL) || process.env.COOKIE_SECURE === "1";

function registerLoginRoutes(app, deps) {
  // take the helpers we need out of "deps" (sent to us by server.js)
  const {
    db, writeAuditLog,
    hashPassword, isHashed, verifyPassword,
    SESSION_HOURS, startSession, endSession, endSessionsForStaff,
    signOutAfterPasswordChange, clientIp, DEFAULT_STORE_SETTINGS,
    LOGIN_MAX_ATTEMPTS, LOGIN_HOLD_MINUTES
  } = deps;

  const LOGIN_SELECT =
    `SELECT u.user_id, u.staff_id, u.email, u.password, u.must_change_password,
            -- a hold that has run out wipes the count, so the account gets a full set of tries again
            IF(u.held_until IS NOT NULL AND u.held_until <= NOW(), 0, u.failed_attempts) AS failed_attempts,
            IF(u.held_until IS NOT NULL AND u.held_until > NOW(), u.held_until, NULL) AS held_until,
            TIMESTAMPDIFF(SECOND, NOW(), u.held_until) AS held_for_seconds,
            s.first_name, s.middle_name, s.last_name, s.full_name, s.is_active,
            r.role_id, r.role_name
     FROM users u
     JOIN staff s ON s.staff_id = u.staff_id
     JOIN roles r ON r.role_id = s.role_id`;

  // the account with exactly this address, or null
  async function findLoginByExactEmail(address) {
    const [rows] = await db.query(
      `${LOGIN_SELECT} WHERE u.email = ? LIMIT 1`,
      [address]);
    return rows[0] || null;
  }

  // Gmail ignores dots in the part before the @, so "j.doe" and "jdoe" are one
  // inbox; this finds the account whose dotless local part matches
  async function findLoginByGmailAlias(localWithoutDots) {
    const [rows] = await db.query(
      `${LOGIN_SELECT}
       WHERE LOWER(SUBSTRING_INDEX(u.email, '@', -1)) IN ('gmail.com', 'googlemail.com')
         AND REPLACE(SUBSTRING_INDEX(u.email, '@', 1), '.', '') = ?
       LIMIT 1`,
      [localWithoutDots]);
    return rows[0] || null;
  }

  // a readable password found on sign-in (from an old backup) is replaced with its hash
  async function storePasswordHash(userId, hash) {
    await db.query(
      "UPDATE users SET password = ? WHERE user_id = ?",
      [hash, userId]);
  }

  // a sign-in that worked also wipes the count of ones that did not
  async function recordSignIn(userId) {
    await db.query(
      "UPDATE users SET last_login = NOW(), failed_attempts = 0, held_until = NULL WHERE user_id = ?",
      [userId]);
  }

  // ==========================================
  // THE HOLD -- LOGIN_MAX_ATTEMPTS wrong passwords in a row and the account is
  // held for LOGIN_HOLD_MINUTES. A held account refuses even the right
  // password. The count is per account, not per machine, so a guess from a
  // second computer is still a guess; an address with no account is not
  // counted, there being nothing to hold. The hold is released by time, by a
  // sign-in that works once it has passed, or by an administrator resetting
  // the password.
  // ==========================================

  // one more wrong password; true when this one tipped the account into a hold
  async function countWrongPassword(user) {
    const attempts = Number(user.failed_attempts || 0) + 1;

    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      await db.query(
        `UPDATE users
         SET failed_attempts = ?, held_until = DATE_ADD(NOW(), INTERVAL ? MINUTE)
         WHERE user_id = ?`,
        [attempts, LOGIN_HOLD_MINUTES, user.user_id]);
      return true;
    }

    // the old, finished hold is cleared with it, or the next read would wipe this count too
    await db.query(
      "UPDATE users SET failed_attempts = ?, held_until = NULL WHERE user_id = ?",
      [attempts, user.user_id]);
    return false;
  }

  // seconds -> whole minutes, rounded up, and never less than 1
  function minutesLeft(seconds) {
    const minutes = Math.ceil(Number(seconds || 0) / 60);
    if (minutes < 1) {
      return 1;
    }
    return minutes;
  }

  function heldMessage(minutes) {
    return `This account is held after ${LOGIN_MAX_ATTEMPTS} wrong passwords in a row. ` +
      `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or set a new password with ` +
      `"Forgot your password?" below, which releases it now.`;
  }

  // the stored hash while the account is still on its system-made password; null once chosen
  async function temporaryPasswordHash(userId) {
    const [rows] = await db.query(
      "SELECT password FROM users WHERE user_id = ? AND must_change_password = TRUE",
      [userId]);
    if (rows.length > 0) {
      return rows[0].password;
    }
    return null;
  }

  // sets the chosen password and clears the first-sign-in flag; false when the
  // account was not on a temporary password, so nothing was changed
  async function saveChosenPassword(userId, hash) {
    const [result] = await db.query(
      `UPDATE users
       SET password = ?, must_change_password = FALSE
       WHERE user_id = ? AND must_change_password = TRUE`,
      [hash, userId]);
    return result.affectedRows > 0;
  }

  // ==========================================
  // ROUTES
  //
  // The address is always trimmed. A password is tried again with its edges
  // trimmed while the account is still on the system-made password (which never
  // contains a space); one a person chose is checked exactly as typed. Gmail
  // ignores dots, so an address that matches nothing is tried once more with
  // the dots removed, for the Google domains only.
  // ==========================================

  async function findLoginByEmail(email) {
    const address = String(email).trim();

    const exact = await findLoginByExactEmail(address);
    if (exact) return exact;

    const at = address.lastIndexOf("@");
    if (at < 1) return null;
    const domain = address.slice(at + 1).toLowerCase();
    if (domain !== "gmail.com" && domain !== "googlemail.com") return null;

    const local = address.slice(0, at).replace(/\./g, "");   // remove every "."
    return findLoginByGmailAlias(local);
  }

  // the password as typed, or with its edges trimmed while it is still the system-made one
  async function passwordMatches(user, password) {
    if (await verifyPassword(password, user.password)) return true;

    // only for a system-made password: try again without spaces at the start/end
    const trimmed = String(password).trim();
    if (!user.must_change_password || trimmed === password) {
      return false;
    }
    return await verifyPassword(trimmed, user.password);
  }

  // A hash nobody can sign in with. An address with no account is checked
  // against it, so that reply takes as long as a wrong password does; without
  // it the quick answer would say which addresses have accounts.
  const decoyHash = hashPassword(crypto.randomBytes(24).toString("hex"));

  app.post("/api/login", async (request, response) => {
    const email = String(request.body.email || "").trim();
    const password = request.body.password;

    if (!email || !password) {
      return response.status(400).json({ error: "Email and password are required" });
    }

    try {
      // checked here, not in the query: the column holds a hash
      const user = await findLoginByEmail(email);

      // both failures are logged; the reply, and the time it takes, stay the
      // same so nobody can tell which addresses exist
      if (!user) {
        await verifyPassword(String(password), await decoyHash);
        await writeAuditLog(
          { staffId: null, request: request },
          "LOGIN_FAILURE",
          `Sign-in refused for ${email}: no account with that email`,
          { email: String(email), reason: "unknown_email" }
        );
        return response.status(401).json({ error: "Invalid email or password" });
      }

      // a held account is refused before the password is even looked at, so
      // nothing learned from the reply says whether the guess was right
      if (user.held_until) {
        const minutes = minutesLeft(user.held_for_seconds);
        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "LOGIN_FAILURE",
          `Sign-in refused for ${email}: the account is held for ${minutes} more minute(s)`,
          { email: String(email), reason: "held", held_until: user.held_until }
        );
        return response.status(423).json({ error: heldMessage(minutes), heldMinutes: minutes });
      }

      if (!(await passwordMatches(user, password))) {
        const nowHeld = await countWrongPassword(user);
        const attempts = Number(user.failed_attempts || 0) + 1;

        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "LOGIN_FAILURE",
          `Sign-in refused for ${email}: wrong password (${attempts} of ${LOGIN_MAX_ATTEMPTS})`,
          { email: String(email), reason: "wrong_password", attempts: attempts }
        );

        if (nowHeld) {
          await writeAuditLog(
            { staffId: user.staff_id, roleName: user.role_name, request: request },
            "ACCOUNT_HELD",
            `${email} held for ${LOGIN_HOLD_MINUTES} minutes after ` +
              `${LOGIN_MAX_ATTEMPTS} wrong passwords in a row`,
            { email: String(email), attempts: attempts, hold_minutes: LOGIN_HOLD_MINUTES }
          );
          // whoever is at the screen is signed out too: the guesses may be theirs
          await endSessionsForStaff(user.staff_id, null,
            "This account was held after too many wrong passwords, so this screen was signed out.");
          return response.status(423).json({
            error: heldMessage(LOGIN_HOLD_MINUTES), heldMinutes: LOGIN_HOLD_MINUTES
          });
        }

        const left = LOGIN_MAX_ATTEMPTS - attempts;
        let warning = null;
        if (left === 1) {
          warning = `One more wrong password and the account is held for ${LOGIN_HOLD_MINUTES} minutes.`;
        }
        return response.status(401).json({
          error: "Invalid email or password",
          attemptsLeft: left,
          warning: warning
        });
      }

      // a database restored from an older backup can bring back readable passwords;
      // upgrade the row on the sign-in that proves it
      if (!isHashed(user.password)) {
        await storePasswordHash(user.user_id, await hashPassword(user.password));
      }

      delete user.password;   // never let the hash leave the server

      if (!user.is_active) {
        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "LOGIN_FAILURE",
          `Sign-in refused for ${email}: the account is deactivated`,
          { email: String(email), reason: "deactivated" }
        );
        return response.status(403).json({ error: "This account is deactivated" });
      }

      await recordSignIn(user.user_id);
      await writeAuditLog(
        { staffId: user.staff_id, roleName: user.role_name, request: request },
        "LOGIN",
        `${user.email} signed in`
      );

      const token = await startSession(user);

      // how many OTHER sessions this person already had open, now ended
      const previous = await endSessionsForStaff(user.staff_id, token,
        "This account signed in on another device, so this screen was signed out.");
      if (previous > 0) {
        await writeAuditLog(
          { staffId: user.staff_id, roleName: user.role_name, request: request },
          "SESSION_REPLACED",
          `${user.email} signed in again; ${previous} earlier session${previous === 1 ? "" : "s"} ended`,
          { sessions_ended: previous }
        );
      }

      response.cookie("sid", token, {
        httpOnly: true,                              // JavaScript on the page cannot read it
        sameSite: "strict",                          // not sent from another site
        secure: SECURE_COOKIE,                       // only over https (on Vercel)
        maxAge: SESSION_HOURS * 60 * 60 * 1000,
        path: "/"
      });

      // the profile is only for drawing the screen; nothing sent back is trusted
      response.json({ message: "Login successful", user });
    } catch (error) {
      console.error("Login failed:", error.message);
      response.status(500).json({ error: "Unable to log in" });
    }
  });

  app.post("/api/logout", async (request, response) => {
    await writeAuditLog(request, "LOGOUT", `${request.actor.email} signed out`);

    await endSession(request);
    response.clearCookie("sid", { path: "/" });
    response.json({ message: "Signed out" });
  });

  // Heartbeat: a page left open makes no requests, so the browser sends this
  // once a minute to stay present. The access check ahead of it refreshes the session.
  app.post("/api/heartbeat", (request, response) => {
    response.json({
      ok: true,
      staffId: request.actor.staffId,
      serverTime: new Date().toISOString()
    });
  });

  app.post("/api/change-password", async (request, response) => {
    const { newPassword } = request.body;

    // always the signed-in account, never one named in the body
    const userId = request.actor.userId;

    if (!userId || typeof newPassword !== "string" || newPassword.length < 8) {
      return response.status(400).json({ error: "Password must contain at least 8 characters" });
    }

    try {
      // choosing the temporary password again keeps it; checked here against the
      // stored hash because the screen never sees it
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
        `${request.actor.email} chose their own password on first sign-in`);

      await signOutAfterPasswordChange(request, response);
      response.json({ message: "Password changed successfully", signedOut: true });
    } catch (error) {
      console.error("Password update failed:", error.message);
      response.status(500).json({ error: "Unable to change password" });
    }
  });

  // ==========================================
  // FORGOT YOUR PASSWORD? -- a six-digit code by email, typed back here with
  // a new password. For when the administrator is not there to reset it.
  //
  // Only the code's scrypt hash is stored. A code lasts RESET_CODE_MINUTES,
  // dies after RESET_MAX_TRIES wrong tries, and is retired by the next one
  // sent. An account is sent at most one code a minute and RESET_PER_HOUR an
  // hour. The reply to a request is the same whether or not the address has
  // an account, and it is given before any mail goes, so neither the words
  // nor the time taken says which addresses exist.
  // ==========================================
  const RESET_CODE_MINUTES = 15;
  const RESET_MAX_TRIES = 5;
  const RESET_PER_HOUR = 5;

  const RESET_SENT =
    `If that address belongs to an account here, a six-digit code is on its way to it. ` +
    `It stops working in ${RESET_CODE_MINUTES} minutes. Only one code is sent a minute, ` +
    `so give it a moment before asking again.`;

  const RESET_NO_MAIL =
    "Codes are sent by email, and mail is not set up on this server, so no code can be sent. " +
    "Ask a manager to reset your password from Staff Passwords, or the System Administrator " +
    "from the staff directory.";

  const RESET_BAD_CODE =
    `That code is not right, or it has stopped working. A code lasts ${RESET_CODE_MINUTES} ` +
    `minutes and ${RESET_MAX_TRIES} tries; ask for a new one if it has run out.`;

  // a simple check for "something@something.something" (no spaces)
  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function sendResetCode(request, email) {
    const user = await findLoginByEmail(email);

    if (!user) {
      await writeAuditLog({ staffId: null, request: request },
        "PASSWORD_RESET_REFUSED",
        `A reset code was asked for ${email}: no account with that email`,
        { email: email, reason: "unknown_email" });
      return;
    }
    if (!user.is_active) {
      await writeAuditLog({ staffId: user.staff_id, request: request },
        "PASSWORD_RESET_REFUSED",
        `A reset code was asked for ${email}: the account is deactivated`,
        { email: email, reason: "deactivated" });
      return;
    }

    // how many codes were sent in the last minute and in the last hour
    const [recentRows] = await db.query(
      `SELECT SUM(created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)) AS last_minute,
              COUNT(*) AS last_hour
       FROM password_resets
       WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      [user.user_id]);
    const recent = recentRows[0];

    if (Number(recent.last_minute) > 0 || Number(recent.last_hour) >= RESET_PER_HOUR) {
      let why = `${RESET_PER_HOUR} were already sent this hour`;
      if (Number(recent.last_minute) > 0) {
        why = "one was sent less than a minute ago";
      }
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_REFUSED",
        `A reset code for ${user.email} was not sent: ` + why,
        { email: user.email, reason: "too_many" });
      return;
    }

    // a random number from 0 to 999999, written with 6 digits (e.g. 42 -> "000042")
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

    // a new code retires every older one still waiting
    await db.query(
      "UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
      [user.user_id]);
    await db.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at, requested_ip)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
      [user.user_id, await hashPassword(code), RESET_CODE_MINUTES, clientIp(request)]);

    const [settings] = await db.query("SELECT store_name FROM store_settings WHERE setting_id = 1");
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
        `A password reset code was emailed to ${user.email}`,
        { email: user.email, expires_in_minutes: RESET_CODE_MINUTES });
    } catch (error) {
      console.error("Sending a password reset code failed:", error.message);
      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_CODE_FAILED",
        `A password reset code for ${user.email} could not be sent: ${error.message}`,
        { email: user.email });
    }
  }

  app.post("/api/password-reset/request", async (request, response) => {
    const body = request.body || {};
    const email = String(body.email || "").trim();

    if (!looksLikeEmail(email)) {
      return response.status(400).json({ error: "Type the email address you sign in with." });
    }
    if (!isMailConfigured()) {
      return response.status(503).json({ error: RESET_NO_MAIL });
    }

    // answered first; the lookup and the mail happen after, whatever the address
    response.json({ message: RESET_SENT, minutes: RESET_CODE_MINUTES });

    sendResetCode(request, email).catch((error) => {
      console.error("Password reset request failed:", error.message);
    });
  });

  app.post("/api/password-reset/confirm", async (request, response) => {
    const body = request.body || {};
    const email = String(body.email || "").trim();
    const code = String(body.code || "").replace(/\s+/g, "");   // remove any spaces
    const newPassword = body.newPassword;

    if (!looksLikeEmail(email)) {
      return response.status(400).json({ error: "Type the email address you sign in with." });
    }
    if (!/^\d{6}$/.test(code)) {   // must be exactly 6 digits
      return response.status(400).json({ error: "The code is the six digits in the email." });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return response.status(400).json({ error: "The new password must contain at least 8 characters." });
    }

    try {
      const user = await findLoginByEmail(email);

      if (!user) {
        // as long as a wrong code takes, so the reply says nothing about the address
        await verifyPassword(code, await decoyHash);
        return response.status(400).json({ error: RESET_BAD_CODE });
      }

      const [codes] = await db.query(
        `SELECT reset_id, code_hash FROM password_resets
         WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() AND attempts < ?
         ORDER BY reset_id DESC LIMIT 1`,
        [user.user_id, RESET_MAX_TRIES]);

      if (codes.length === 0) {
        await verifyPassword(code, await decoyHash);
        return response.status(400).json({ error: RESET_BAD_CODE });
      }

      // the try is counted before the code is looked at, and only while tries
      // are left, so guesses sent side by side cannot get past the limit
      const [counted] = await db.query(
        "UPDATE password_resets SET attempts = attempts + 1 WHERE reset_id = ? AND attempts < ?",
        [codes[0].reset_id, RESET_MAX_TRIES]);

      if (counted.affectedRows === 0 || !(await verifyPassword(code, codes[0].code_hash))) {
        await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
          "PASSWORD_RESET_WRONG_CODE",
          `A wrong password reset code was typed for ${user.email}`,
          { email: user.email });
        return response.status(400).json({ error: RESET_BAD_CODE });
      }

      if (!user.is_active) {
        return response.status(403).json({ error: "This account is deactivated" });
      }

      // spent, whatever happens next; any older code still waiting goes with it
      await db.query(
        "UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
        [user.user_id]);

      // chosen by the person, so not a temporary one; the hold is released as an
      // administrator's reset releases it
      await db.query(
        `UPDATE users
         SET password = ?, must_change_password = FALSE, failed_attempts = 0, held_until = NULL
         WHERE user_id = ?`,
        [await hashPassword(newPassword), user.user_id]);

      await endSessionsForStaff(user.staff_id, null,
        "Your password was changed with a code sent to your email. Sign in with the new one.");

      await writeAuditLog({ staffId: user.staff_id, roleName: user.role_name, request: request },
        "PASSWORD_RESET_BY_CODE",
        `${user.email} set a new password with a code sent to their email; ` +
          "every session was ended and any sign-in hold released",
        { email: user.email });

      response.json({ message: "Your password was changed. Sign in with the new one." });
    } catch (error) {
      console.error("Password reset failed:", error.message);
      response.status(500).json({ error: "Unable to reset the password" });
    }
  });
}

module.exports = { registerLoginRoutes };