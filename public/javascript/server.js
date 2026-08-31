const express = require("express");
const path = require("path");
const mysql = require("mysql2");

const app = express();
const port = 3000;

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "Password",
  database: "hardware_db",
  waitForConnections: true,
  connectionLimit: 10
});

db.getConnection((error, connection) => {
  if (error) {
    console.error("MySQL connection failed:", error.message);
    return;
  }

  console.log("Connected to MySQL");
  connection.release();
});

app.use(express.json());

app.get("/", (request, response) => {
  response.redirect("/Login.html");
});

app.use(express.static(path.join(__dirname, "..")));

app.post("/api/login", (request, response) => {
  const { email, password } = request.body;

  if (!email || !password) {
    return response.status(400).json({ error: "Email and password are required" });
  }

  db.query(
    "SELECT users.user_id, users.first_name, users.email, users.role_id, users.must_change_password, roles.role_name FROM users INNER JOIN roles ON users.role_id = roles.role_id WHERE users.email = ? AND users.password = ? LIMIT 1",
    [email, password],
    (error, results) => {
      if (error) {
        console.error("Login query failed:", error.message);
        return response.status(500).json({ error: "Unable to log in" });
      }

      if (results.length === 0) {
        return response.status(401).json({ error: "Invalid email or password" });
      }

      response.json({ message: "Login successful", user: results[0] });
    }
  );
});

app.post("/api/change-password", (request, response) => {
  const { userId, newPassword } = request.body;

  if (!userId || typeof newPassword !== "string" || newPassword.length < 8) {
    return response.status(400).json({ error: "Password must contain at least 8 characters" });
  }

  db.query(
    "UPDATE users SET password = ?, must_change_password = FALSE WHERE user_id = ? AND role_id IN (2, 3, 4, 5) AND must_change_password = TRUE",
    [newPassword, userId],
    (error, result) => {
      if (error) {
        console.error("Password update failed:", error.message);
        return response.status(500).json({ error: "Unable to change password" });
      }

      if (result.affectedRows === 0) {
        return response.status(403).json({ error: "Password change is not allowed" });
      }

      response.json({ message: "Password changed successfully" });
    }
  );
});

app.get("/api/products", (request, response) => {
  db.query("SELECT * FROM products", (error, results) => {
    if (error) {
      return response.status(500).json({ error: error.message });
    }

    response.json(results);
  });
});

app.get("/api/users", (request, response) => {
  db.query("SELECT users.user_id, users.first_name, users.email, roles.role_name FROM users LEFT JOIN roles ON users.role_id = roles.role_id", (error, results) => {
    if (error) {
      return response.status(500).json({ error: error.message });
    }
    response.json(results);
  });
});

app.post("/api/users", (request, response) => {
  const { firstName, email, roleId, password } = request.body;
  
  if (!email || !password || !roleId) {
    return response.status(400).json({ error: "Email, password and role are required" });
  }

  db.query(
    "INSERT INTO users (first_name, email, password, role_id, must_change_password) VALUES (?, ?, ?, ?, TRUE)",
    [firstName, email, password, roleId],
    (error, results) => {
      if (error) {
         if (error.code === 'ER_DUP_ENTRY') {
             return response.status(400).json({ error: "Email already exists" });
         }
        return response.status(500).json({ error: error.message });
      }
      response.json({ message: "User created successfully", userId: results.insertId });
    }
  );
});

db.query(
  "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name IN ('first_name', 'must_change_password', 'role_id')",
  (error, rows) => {
    if (error) {
      console.error("Unable to prepare first-login passwords:", error.message);
      return;
    }

    const resetFirstLoginFlags = () => {
      db.query(
        "UPDATE users SET first_name = CASE email WHEN 'admin@hardware.com' THEN 'Admin' WHEN 'manager@hardware.com' THEN 'Manager' WHEN 'clerk@hardware.com' THEN 'Clerk' WHEN 'cashier@hardware.com' THEN 'Cashier' WHEN 'delivery@hardware.com' THEN 'Delivery' ELSE first_name END, must_change_password = CASE WHEN COALESCE(role_id, 1) = 1 THEN FALSE ELSE TRUE END WHERE COALESCE(role_id, 1) IN (1, 2, 3, 4, 5)",
        (updateError) => {
          if (updateError) {
            console.error("Unable to reset first-login passwords:", updateError.message);
            return;
          }

          app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
          });
        }
      );
    };

    const existingColumns = rows.map((row) => row.column_name);
    const missingColumns = [];

    if (!existingColumns.includes("first_name")) {
      missingColumns.push("ADD COLUMN first_name VARCHAR(100) NOT NULL DEFAULT ''");
    }

    if (!existingColumns.includes("must_change_password")) {
      missingColumns.push("ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT TRUE");
    }

    if (!existingColumns.includes("role_id")) {
      missingColumns.push("ADD COLUMN role_id INT NOT NULL DEFAULT 1 AFTER must_change_password");
    }

    const addNextMissingColumn = (columnIndex) => {
      if (columnIndex === missingColumns.length) {
        resetFirstLoginFlags();
        return;
      }

      db.query(
        `ALTER TABLE users ${missingColumns[columnIndex]}`,
        (alterError) => {
          if (alterError) {
            if (alterError.code === "ER_DUP_FIELDNAME") {
              addNextMissingColumn(columnIndex + 1);
              return;
            }

            console.error("Unable to prepare first-login passwords:", alterError.message);
            return;
          }

          addNextMissingColumn(columnIndex + 1);
        }
      );
    };

    addNextMissingColumn(0);
  }
);