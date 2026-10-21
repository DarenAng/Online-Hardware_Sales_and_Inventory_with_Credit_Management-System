const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env"), quiet: true });

const IS_VERCEL = Boolean(process.env.VERCEL);

const TIME_ZONE = process.env.HARDWARE_TIME_ZONE || (IS_VERCEL ? "Asia/Manila" : "");
if (TIME_ZONE) process.env.TZ = TIME_ZONE;

function utcOffsetText() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const whole = Math.abs(minutes);
  return sign + String(Math.floor(whole / 60)).padStart(2, "0") + ":" + String(whole % 60).padStart(2, "0");
}
const DB_TIME_ZONE = process.env.DB_TIME_ZONE || utcOffsetText();

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || "hardware_db";
const DB_PORT = Number(process.env.DB_PORT) || 3306;

let DB_CONNECTION_LIMIT = 10;
if (IS_VERCEL) {
  DB_CONNECTION_LIMIT = 3;
}
if (Number(process.env.DB_CONNECTION_LIMIT) > 0) {
  DB_CONNECTION_LIMIT = Number(process.env.DB_CONNECTION_LIMIT);
}

const PLACEHOLDER_PASSWORDS = ["your_secure_password_here", "your-mysql-password"];

if (DB_PASSWORD === undefined || DB_PASSWORD === "") {
  console.warn("DB_PASSWORD is not set. Copy .env.example to .env at the project root and " +
               "fill in the MySQL password; the server will try to connect without one.");
} else if (PLACEHOLDER_PASSWORDS.includes(DB_PASSWORD)) {
  console.warn("DB_PASSWORD in .env is still the placeholder \"" + DB_PASSWORD + "\". " +
               "Put the real MySQL password there.");
}

function sslOptions() {
  let ca = process.env.DB_SSL_CA || "";
  if (!ca && process.env.DB_SSL_CA_FILE) {
    ca = fs.readFileSync(path.resolve(path.join(__dirname, "..", "..", ".."), process.env.DB_SSL_CA_FILE), "utf8");
  }
  if (!ca) return undefined;
  return { ca: cleanCertificate(ca), rejectUnauthorized: true };
}

function cleanCertificate(text) {
  const blocks = String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) return String(text).replace(/\\n/g, "\n");

  let result = "";
  for (let i = 0; i < blocks.length; i++) {
    const body = blocks[i]
      .replace("-----BEGIN CERTIFICATE-----", "")
      .replace("-----END CERTIFICATE-----", "")
      .replace(/\\n/g, "")
      .replace(/\s+/g, "");
    result += "-----BEGIN CERTIFICATE-----\n" + body.match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
  }
  return result;
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
  decimalNumbers: true
});

db.pool.on("connection", function (connection) {
  connection.query("SET time_zone = ?", [DB_TIME_ZONE], function (error) {
    if (error) console.error("Could not set the database time zone to " + DB_TIME_ZONE + ":", error.message);
  });
});

if (IS_VERCEL) {
  try {
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
  IS_VERCEL: IS_VERCEL,
  cleanCertificate: cleanCertificate
};
