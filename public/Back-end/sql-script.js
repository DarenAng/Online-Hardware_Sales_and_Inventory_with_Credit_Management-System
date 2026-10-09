// ============================================================
// sql-script.js -- splitting a .sql file into statements
// Loaded by: Connections/admin.js (restoring a backup) and
// scripts/load-sql.js (loading a .sql file into a cloud database).
// Never sent to a browser.
// ============================================================

// Splits the text of a .sql file into separate statements (like MySQL
// Workbench does). It reads the text one character at a time:
//   - "DELIMITER //" changes what ends a statement (used around procedures)
//   - text inside quotes '...' "..." `...` is copied as it is
//     (a ; inside quotes does not end a statement)
//   - comments (-- ..., # ..., /* ... */) are skipped
//   - the delimiter (normally ;) ends the current statement
//   - any other character is added to the current statement
function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ";";
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const rest = sql.slice(index);

    // a "DELIMITER xx" line
    if (current.trim() === "" && /^delimiter[ \t]+/i.test(rest)) {
      let lineEnd = rest.indexOf("\n");
      if (lineEnd === -1) {
        lineEnd = rest.length;   // the last line of the file
      }
      const line = rest.slice(0, lineEnd);
      delimiter = line.replace(/^delimiter[ \t]+/i, "").trim() || ";";
      index += line.length;
      current = "";
      continue;
    }

    // text in quotes: copy everything up to the closing quote
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      current += character;
      index += 1;

      while (index < sql.length) {
        // a backslash keeps the next character (e.g. \' inside '...')
        if (sql[index] === "\\" && quote !== "`") {
          current += sql.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          // two quotes in a row ('') are a quote inside the text
          if (sql[index + 1] === quote) {
            current += quote + quote;
            index += 2;
            continue;
          }
          current += quote;
          index += 1;
          break;
        }
        current += sql[index];
        index += 1;
      }
      continue;
    }

    // a "-- comment" or "# comment": skip to the end of the line
    const isDashComment = rest.startsWith("--") &&
      (rest[2] === " " || rest[2] === "\t" || rest[2] === "\n");
    if (isDashComment || character === "#") {
      const stop = sql.indexOf("\n", index);
      if (stop === -1) {
        index = sql.length;
      } else {
        index = stop + 1;
      }
      continue;
    }

    // a "/* comment */": skip to the closing */
    if (rest.startsWith("/*")) {
      const stop = sql.indexOf("*/", index + 2);
      if (stop === -1) {
        index = sql.length;
      } else {
        index = stop + 2;
      }
      continue;
    }

    // the delimiter: the current statement is finished
    if (rest.startsWith(delimiter)) {
      if (current.trim() !== "") statements.push(current.trim());
      current = "";
      index += delimiter.length;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim() !== "") statements.push(current.trim());
  return statements;
}

module.exports = { splitSqlStatements };
