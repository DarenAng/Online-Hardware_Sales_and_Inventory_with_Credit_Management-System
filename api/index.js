// ============================================================
// api/index.js -- the way into the app on Vercel
//
// Vercel runs every file in api/ as a function. vercel.json sends every
// address that is not a static file (css, browser scripts, Bootstrap) here,
// and the Express app in public/Back-end/server.js answers it exactly as it
// does on a PC with npm start.
// ============================================================

module.exports = require("../public/Back-end/server.js");
