// Writes the two root certificates Azure Database for MySQL asks for into the project folder:
//   azure-ca.pem            for DB_SSL_CA_FILE on a PC
//   azure-ca-one-line.pem   the same on one line, to paste into Vercel as DB_SSL_CA
// The certificates come from the list built into Node.js, so nothing is downloaded.
// Run: node public/deployment/make-azure-ca.js

const fs = require("fs");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");

const NEEDED = ["DigiCert Global Root G2", "Microsoft RSA Root Certificate Authority 2017"];
const ROOT = path.join(__dirname, "..", "..");

function findCertificate(name) {
  for (let i = 0; i < tls.rootCertificates.length; i++) {
    const certificate = new crypto.X509Certificate(tls.rootCertificates[i]);
    const lines = certificate.subject.split("\n");
    if (lines.includes("CN=" + name)) return tls.rootCertificates[i].trim();
  }
  return null;
}

const found = [];
for (let i = 0; i < NEEDED.length; i++) {
  const pem = findCertificate(NEEDED[i]);
  if (!pem) {
    console.error("This Node.js does not carry the certificate \"" + NEEDED[i] + "\". Nothing was written.");
    process.exit(1);
  }
  found.push(pem);
}

const manyLines = found.join("\n") + "\n";
const oneLine = found.join("").replace(/\r?\n/g, "");

fs.writeFileSync(path.join(ROOT, "azure-ca.pem"), manyLines);
fs.writeFileSync(path.join(ROOT, "azure-ca-one-line.pem"), oneLine);

console.log("Wrote azure-ca.pem and azure-ca-one-line.pem in " + ROOT);
console.log("They hold: " + NEEDED.join(", ") + ".");
