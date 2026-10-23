const os = require("os");
const passwords = require("../services/passwords");
const hashPassword = passwords.hashPassword;
const generatePassword = passwords.generatePassword;

async function main() {
  const email = String(process.argv[2] || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Name the account to recover, by the email it signs in with:");
    console.error("");
    console.error("    npm run recover-password -- someone@example.com");
    process.exitCode = 1;
    return;
  }

  const db = require("../database/connection").db;

  try {
    const rowsResult = await db.query(
      "SELECT u.user_id, u.staff_id, u.email, s.full_name, s.is_active, r.role_name\n" +
        "       FROM users u\n" +
        "       JOIN staff s ON s.staff_id = u.staff_id\n" +
        "       JOIN roles r ON r.role_id = s.role_id\n" +
        "       WHERE LOWER(u.email) = LOWER(?)\n" +
        "       LIMIT 1",
      [email]);
    const rows = rowsResult[0];

    if (rows.length === 0) {
      console.error("No account signs in with " + email + ". Check the spelling; nothing was changed.");
      process.exitCode = 1;
      return;
    }

    const user = rows[0];
    const password = generatePassword();

    await db.query("CALL sp_reset_user_password(?, ?, @status_code, @message)",
      [user.staff_id, await hashPassword(password)]);
    const outputRowsResult = await db.query("SELECT @status_code AS status_code, @message AS message");
    const outputRows = outputRowsResult[0];
    const output = outputRows[0];

    if (Number(output.status_code) !== 200) {
      console.error("The password was not changed: " + output.message);
      process.exitCode = 1;
      return;
    }

    await db.query(
      "UPDATE users SET failed_attempts = 0, held_until = NULL WHERE user_id = ?",
      [user.user_id]);

    await db.query(
      "INSERT INTO audit_logs (staff_id, role_name, ip_address, action, action_type, details, metadata)\n" +
        "       VALUES (NULL, NULL, NULL, 'RECOVER_PASSWORD', 'SECURITY', ?, ?)",
      ["Temporary password set for " + user.email + " with npm run recover-password on the server's " +
         "own computer (" + os.hostname() + "); any sign-in hold released",
       JSON.stringify({ staff_id: user.staff_id, email: user.email, host: os.hostname() })]);

    console.log("");
    console.log("  " + user.full_name + " (" + user.role_name + ")");
    console.log("  Signs in with:       " + user.email);
    console.log("  Temporary password:  " + password);
    console.log("");
    console.log("  This is shown once and is not stored anywhere it can be read back.");
    console.log("  It has to be changed on the next sign-in, and any sign-in hold is released.");
    if (!user.is_active) {
      console.log("  The account is deactivated: it cannot sign in until an administrator activates it.");
    }
    console.log("  A screen still signed in on the old password stays signed in until the server");
    console.log("  is restarted or that session ends; restart the server to end it now.");
    console.log("");
  } finally {
    await db.end();
  }
}

main().catch(function (error) {
  console.error("Recovering the password failed:", error.message);
  console.error("Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env at the project root,");
  console.error("and that public/database/2-stored-procedures.sql has been loaded.");
  process.exitCode = 1;
});
