const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const sqlScript = require("../backend/services/sql-script");
const splitSqlStatements = sqlScript.splitSqlStatements;
const connectionFile = require("../backend/database/connection");
const cleanCertificate = connectionFile.cleanCertificate;

const ROOT = path.join(__dirname, "..", "..");

function readArguments(argv) {
  const options = { env: ".env", database: null, yes: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--env") {
      i += 1;
      options.env = argv[i];
    } else if (word === "--database") {
      i += 1;
      options.database = argv[i];
    } else if (word === "--yes") {
      options.yes = true;
    } else {
      options.files.push(word);
    }
  }
  return options;
}

function sslOptions() {
  let ca = process.env.DB_SSL_CA || "";
  if (!ca && process.env.DB_SSL_CA_FILE) {
    ca = fs.readFileSync(path.resolve(ROOT, process.env.DB_SSL_CA_FILE), "utf8");
  }
  if (!ca) return undefined;
  return { ca: cleanCertificate(ca), rejectUnauthorized: true };
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  if (options.files.length === 0) {
    console.log("Usage: node public/deployment/load-sql.js [--env .env.aiven] [--database hardware_db] [--yes] FILE.sql ...");
    process.exit(1);
  }

  const envPath = path.resolve(ROOT, options.env);
  if (!fs.existsSync(envPath)) {
    console.error("No settings file at " + envPath + ".");
    process.exit(1);
  }
  dotenv.config({ path: envPath, override: true, quiet: true });

  const scripts = [];
  for (let fileIndex = 0; fileIndex < options.files.length; fileIndex++) {
    const file = options.files[fileIndex];
    const fullPath = path.resolve(process.cwd(), file);
    scripts.push({ file: file, sql: fs.readFileSync(fullPath, "utf8") });
  }

  for (let scriptIndex = 0; scriptIndex < scripts.length; scriptIndex++) {
    const script = scripts[scriptIndex];
    if (/drop\s+database/i.test(script.sql) && !options.yes) {
      console.error(script.file + " drops a whole database and puts the demo data back.");
      console.error("Add --yes if that is what you want. Nothing was run.");
      process.exit(1);
    }
  }

  const host = process.env.DB_HOST || "localhost";
  const port = Number(process.env.DB_PORT) || 3306;
  const connection = await mysql.createConnection({
    host: host,
    port: port,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    ssl: sslOptions()
  });
  console.log("Connected to " + host + ":" + port + (sslOptions() ? " over SSL" : "") + ".");

  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    if (options.database) {
      await connection.query("CREATE DATABASE IF NOT EXISTS " + mysql.escapeId(options.database));
      await connection.query("USE " + mysql.escapeId(options.database));
    }

    for (let scriptIndex = 0; scriptIndex < scripts.length; scriptIndex++) {
      const script = scripts[scriptIndex];
      const statements = splitSqlStatements(script.sql);
      console.log(script.file + ": " + statements.length + " statements");

      for (let i = 0; i < statements.length; i++) {
        try {
          await connection.query(statements[i]);
        } catch (error) {
          console.error("\nStatement " + (i + 1) + " of " + script.file + " failed: " + error.message);
          console.error(statements[i].slice(0, 300));
          process.exitCode = 1;
          return;
        }
        if ((i + 1) % 100 === 0) process.stdout.write("  " + (i + 1) + "...\r");
      }
      console.log("  done.          ");
    }

    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await connection.end();
  }
}

main().catch(function (error) {
  console.error("Failed:", error.message);
  process.exit(1);
});
