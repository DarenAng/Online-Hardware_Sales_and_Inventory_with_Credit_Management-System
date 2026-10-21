function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ";";
  let current = "";
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const rest = sql.slice(index);

    if (current.trim() === "" && /^delimiter[ \t]+/i.test(rest)) {
      let lineEnd = rest.indexOf("\n");
      if (lineEnd === -1) {
        lineEnd = rest.length;
      }
      const line = rest.slice(0, lineEnd);
      delimiter = line.replace(/^delimiter[ \t]+/i, "").trim() || ";";
      index += line.length;
      current = "";
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      current += character;
      index += 1;

      while (index < sql.length) {
        if (sql[index] === "\\" && quote !== "`") {
          current += sql.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
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

    const isDashComment = rest.startsWith("--") &&
      (rest[2] === " " || rest[2] === "\t" || rest[2] === "\r" || rest[2] === "\n");
    if (isDashComment || character === "#") {
      const stop = sql.indexOf("\n", index);
      if (stop === -1) {
        index = sql.length;
      } else {
        index = stop + 1;
      }
      continue;
    }

    if (rest.startsWith("/*!")) {
      const stop = sql.indexOf("*/", index + 3);
      let inside = "";
      if (stop === -1) {
        inside = sql.slice(index + 3);
        index = sql.length;
      } else {
        inside = sql.slice(index + 3, stop);
        index = stop + 2;
      }
      current += " " + inside.replace(/^\d+/, "") + " ";
      continue;
    }

    if (rest.startsWith("/*")) {
      const stop = sql.indexOf("*/", index + 2);
      if (stop === -1) {
        index = sql.length;
      } else {
        index = stop + 2;
      }
      continue;
    }

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

module.exports = { splitSqlStatements: splitSqlStatements };
