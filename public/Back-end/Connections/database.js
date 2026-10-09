// ============================================================
// database.js -- the connection to the MySQL database
// Loaded by: server.js and recover-password.js. Never sent to a browser.
//
// The settings come from the .env file in the project folder:
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// (copy .env.example to .env and fill it in).
//
// Use it like this in another file:
//   const database = require("./Connections/database");
//   const db = database.db;
//   const [rows] = await db.query("SELECT * FROM users");
// ============================================================

const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

// read the .env file (it is three folders up: Connections -> Back-end -> public -> project)
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env"), quiet: true });

// Copy .env.example to .env and fill it in. Everything but the password has a
// local default; the password has none, so a missing one is said out loud below.
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "hardware_db";
const DB_PORT = Number(process.env.DB_PORT) || 3306;

// the placeholders a copied template still carries
const PLACEHOLDER_PASSWORDS = ["your_secure_password_here", "your-mysql-password"];

if (DB_PASSWORD === undefined || DB_PASSWORD === "") {
  console.warn("DB_PASSWORD is not set. Copy .env.example to .env at the project root and " +
               "fill in the MySQL password; the server will try to connect without one.");
} else if (PLACEHOLDER_PASSWORDS.includes(DB_PASSWORD)) {
  console.warn(`DB_PASSWORD in .env is still the placeholder "${DB_PASSWORD}". ` +
               "Put the real MySQL password there.");
}

const db = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD || "",
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // DECIMAL columns arrive as numbers: 37.500 kg reads as 37.5
  decimalNumbers: true
});

module.exports = {
  db: db,
  DB_NAME: DB_NAME,
  DB_HOST: DB_HOST,
  DB_PORT: DB_PORT
};
