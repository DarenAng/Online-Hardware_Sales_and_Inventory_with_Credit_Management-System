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
copyFolder("public/frontend/ohsicms-customer", "ohsicms-customer");
