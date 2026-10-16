// ============================================================
// vercel-build.js -- the build step on Vercel (see vercel.json)
//
// Vercel serves the files of one folder straight from its CDN, without
// starting the server. That folder must not be public/: it holds the server
// code and the SQL files. So this copies only what a browser may read into
// vercel-static/, at the same addresses the server uses:
//   public/frontend/css/          -> /css/
//   public/frontend/scripts/      -> /scripts/
//   public/frontend/connections/  -> /connections/
//   public/vendor/                -> /vendor/
// Nothing from public/backend/ goes in, and neither do the pages themselves
// (*.html): the server hands those out, because a dashboard is only shown to
// its own role.
// ============================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "vercel-static");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyFolder(from, to) {
  fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true });
  console.log("copied " + from + " -> /" + to + "/");
}

copyFolder("public/frontend/css", "css");
copyFolder("public/frontend/scripts", "scripts");
copyFolder("public/frontend/connections", "connections");
copyFolder("public/vendor", "vendor");
