// ============================================================
// database.js -- the connection to the MySQL database
// Loaded by: server.js and recover-password.js. Never sent to a browser.
//
// The settings come from the .env file in the project folder (on Vercel, from
// the project's Environment Variables):
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
//   DB_SSL_CA or DB_SSL_CA_FILE   the CA certificate of a cloud database (Aiven)
//   DB_CONNECTION_LIMIT           connections kept open at once (default 10)
// (copy .env.example to .env and fill it in).
//
// Use it like this in another file:
//   const database = require("./Connections/database");
//   const db = database.db;
//   const [rows] = await db.query("SELECT * FROM users");
// ============================================================

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

// read the .env file (it is three folders up: Connections -> Back-end -> public -> project)
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env"), quiet: true });

// true when running as a Vercel Function (Vercel sets VERCEL=1)
const IS_VERCEL = Boolean(process.env.VERCEL);

// The shop's clock. Every "today" in the code (the day's sales, the backup's
// name, the hour of the daily backup) reads Node's local time, and NOW() in
// MySQL reads the database's. A PC in the shop is already on Manila time; a
// cloud server runs on UTC, and Vercel will not let TZ be set in its settings,
// so it is set here, before any date is read. HARDWARE_TIME_ZONE overrides it.
const TIME_ZONE = process.env.HARDWARE_TIME_ZONE || (IS_VERCEL ? "Asia/Manila" : "");
if (TIME_ZONE) process.env.TZ = TIME_ZONE;

// "+08:00": the same clock for MySQL, as an offset it takes without time zone tables
function utcOffsetText() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const whole = Math.abs(minutes);
  return sign + String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
}
const DB_TIME_ZONE = process.env.DB_TIME_ZONE || utcOffsetText();

// Copy .env.example to .env and fill it in. Everything but the password has a
// local default; the password has none, so a missing one is said out loud below.
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "hardware_db";
const DB_PORT = Number(process.env.DB_PORT) || 3306;

// Each Vercel instance holds its own pool, and a free cloud database allows
// only so many connections, so the pool is kept small there.
const DB_CONNECTION_LIMIT = Number(process.env.DB_CONNECTION_LIMIT) > 0
  ? Number(process.env.DB_CONNECTION_LIMIT)
  : (IS_VERCEL ? 3 : 10);

// the placeholders a copied template still carries
const PLACEHOLDER_PASSWORDS = ["your_secure_password_here", "your-mysql-password"];

if (DB_PASSWORD === undefined || DB_PASSWORD === "") {
  console.warn("DB_PASSWORD is not set. Copy .env.example to .env at the project root and " +
               "fill in the MySQL password; the server will try to connect without one.");
} else if (PLACEHOLDER_PASSWORDS.includes(DB_PASSWORD)) {
  console.warn(`DB_PASSWORD in .env is still the placeholder "${DB_PASSWORD}". ` +
               "Put the real MySQL password there.");
}

// A cloud database (Aiven) only takes encrypted connections, signed by its own
// certificate authority. Its CA certificate is pasted whole into DB_SSL_CA
// (Vercel), or saved as a file named by DB_SSL_CA_FILE (a PC). Neither set
// means a plain connection, which is what a MySQL on this PC expects.
function sslOptions() {
  let ca = process.env.DB_SSL_CA || "";
  if (!ca && process.env.DB_SSL_CA_FILE) {
    ca = fs.readFileSync(path.resolve(path.join(__dirname, "..", "..", ".."), process.env.DB_SSL_CA_FILE), "utf8");
  }
  if (!ca) return undefined;

  // pasted on one line with \n written out: put the line breaks back
  ca = ca.replace(/\\n/g, "\n");
  return { ca: ca, rejectUnauthorized: true };
}

const db = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD || "",
  database: DB_NAME,
  ssl: sslOptions(),
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  maxIdle: DB_CONNECTION_LIMIT,
  idleTimeout: 60000,
  enableKeepAlive: true,
  queueLimit: 0,
  dateStrings: true,
  // DECIMAL columns arrive as numbers: 37.500 kg reads as 37.5
  decimalNumbers: true
});

// every new connection reads NOW() on the shop's clock, whatever the server's is
db.pool.on("connection", (connection) => {
  connection.query("SET time_zone = ?", [DB_TIME_ZONE], (error) => {
    if (error) console.error(`Could not set the database time zone to ${DB_TIME_ZONE}:`, error.message);
  });
});

// On Vercel, an instance can be frozen between requests; this closes idle
// connections before that happens, so the database is not left holding them.
if (IS_VERCEL) {
  try {
    // the callback pool underneath: the promise wrapper is not a type it knows
    require("@vercel/functions").attachDatabasePool(db.pool);
  } catch (error) {
    console.warn("Idle database connections are not released early:", error.message);
  }
}

module.exports = {
  db: db,
  DB_NAME: DB_NAME,
  DB_HOST: DB_HOST,
  DB_PORT: DB_PORT,
  IS_VERCEL: IS_VERCEL
};
