// ============================================================
// vercel-build.js -- the build step on Vercel (see vercel.json)
//
// Vercel serves the files of one folder straight from its CDN, without
// starting the server. That folder must not be public/: it holds the server
// code and the SQL files. So this copies only what a browser may read into
// vercel-static/, at the same addresses the server uses:
//   public/Front-end/css/                         -> /css/
//   public/Back-end/modules/                      -> /modules/
//   public/Back-end/Connections/*-connection.js   -> /connections/
//   public/vendor/                                -> /vendor/
// The pages themselves (*.html) are not copied: the server hands them out,
// because a dashboard is only shown to its own role.
// ============================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "vercel-static");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyFolder(from, to) {
  fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true });
  console.log(`copied ${from} -> /${to}/`);
}

copyFolder("public/Front-end/css", "css");
copyFolder("public/Back-end/modules", "modules");
copyFolder("public/vendor", "vendor");

// only the browser half of Connections/: plain "<name>-connection.js" files
const BROWSER_CONNECTION = /^[a-z]+(-[a-z]+)*-connection\.js$/i;
const connections = path.join(ROOT, "public", "Back-end", "Connections");
fs.mkdirSync(path.join(OUT, "connections"));
for (const name of fs.readdirSync(connections)) {
  if (!BROWSER_CONNECTION.test(name)) continue;
  fs.copyFileSync(path.join(connections, name), path.join(OUT, "connections", name));
  console.log(`copied public/Back-end/Connections/${name} -> /connections/${name}`);
}
