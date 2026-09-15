// mailer.js -- sending mail
// Loaded by: server.js only. Never sent to a browser.
//
// Speaks SMTP directly over net/tls (both ship inside Node) so nothing has to
// be installed. No queue, no retries: a send goes through or fails and says
// so, and the screen then shows the password instead.
const net = require("net");
const tls = require("tls");
const os = require("os");
const fs = require("fs");
const path = require("path");

// ==========================================
// SETUP - the mail account this system sends from
//
// The password is read from mail-password.txt in this folder (gitignored),
// one line, nothing else. No file or an empty one means mail is off and the
// password is shown on screen instead.
//
// Gmail: turn on 2-Step Verification, make an App Password (16 letters) at
// myaccount.google.com/apppasswords and put that in the file.
// Port 465 is TLS from the first byte (MAIL_SECURE true); port 587 upgrades
// with STARTTLS (MAIL_SECURE false). Port 25 is not offered.
// ==========================================
const MAIL_ENABLED = true;
const MAIL_HOST = "smtp.gmail.com";
const MAIL_PORT = 465;
const MAIL_SECURE = true;          // true on 465, false on 587
const MAIL_USER = "lucelyn.hardware.support@gmail.com";   // the full address, e.g. shop@gmail.com
const MAIL_PASSWORD = readPasswordFile();   // see WHERE THE PASSWORD GOES, above
const MAIL_FROM_NAME = "Lucelyn Hardware Support";

function readPasswordFile() {
  try {
    return fs.readFileSync(path.join(__dirname, "mail-password.txt"), "utf8").trim();
  } catch (error) {
    return "";
  }
}

// every step of the conversation is on a clock
const MAIL_TIMEOUT_MS = 20000;

// checked before a send so the screen can say "mail is not set up" rather
// than "the mail server refused"
function isMailConfigured() {
  // the test harness sets this so passwords come back to it, not to an inbox
  if (process.env.HARDWARE_MAIL_OFF === "1") return false;

  return MAIL_ENABLED === true &&
    typeof MAIL_USER === "string" && MAIL_USER.trim() !== "" &&
    typeof MAIL_PASSWORD === "string" && MAIL_PASSWORD.trim() !== "";
}

// SMTP replies can run to several lines; the last line has a space after the
// code ("250 text") where the earlier ones have a hyphen ("250-text").
function openConversation(socket) {
  let buffer = "";
  let waiting = null;      // { resolve, reject, timer }
  let closed = null;       // the error that closed it, once it has

  function fail(error) {
    closed = closed || error;
    if (waiting) {
      clearTimeout(waiting.timer);
      const reject = waiting.reject;
      waiting = null;
      reject(error);
    }
  }

  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    buffer += chunk;

    if (!/(^|\n)\d{3} [^\n]*\r?\n$/.test(buffer)) return;

    const reply = buffer;
    buffer = "";

    if (!waiting) return;   // an answer nobody asked for; nothing to do with it

    clearTimeout(waiting.timer);
    const resolve = waiting.resolve;
    waiting = null;
    resolve({ code: Number(reply.slice(0, 3)), text: reply.trim() });
  });

  socket.on("error", (error) => fail(error));
  socket.on("close", () => fail(new Error("The mail server closed the connection.")));

  // reads one reply; no line just waits (for the greeting)
  function say(line) {
    if (closed) return Promise.reject(closed);

    return new Promise((resolve, reject) => {
      waiting = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(
          () => fail(new Error("The mail server did not answer in time.")),
          MAIL_TIMEOUT_MS)
      };
      if (line !== undefined) socket.write(line + "\r\n");
    });
  }

  // an unexpected code is an error carrying what the server actually said
  async function expect(line, ...codes) {
    const reply = await say(line);
    if (codes.indexOf(reply.code) === -1) {
      throw new Error(reply.text.replace(/\s+/g, " "));
    }
    return reply;
  }

  return { say: say, expect: expect, socket: socket };
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: host, port: port, servername: host }, () => resolve(socket))
      : net.connect({ host: host, port: port }, () => resolve(socket));

    socket.setTimeout(MAIL_TIMEOUT_MS, () => {
      socket.destroy(new Error(`No answer from ${host}:${port}.`));
    });
    socket.once("error", reject);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: socket, servername: host }, () => resolve(secure));
    secure.once("error", reject);
  });
}

// Body is base64 so a generated password beginning with "." cannot end the
// message early.
function headerText(value) {
  const text = String(value).replace(/[\r\n]+/g, " ").trim();

  // a non-ASCII header has to be an encoded word
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return "=?UTF-8?B?" + Buffer.from(text, "utf8").toString("base64") + "?=";
}

function buildMessage(from, to, subject, body) {
  const encoded = Buffer.from(String(body), "utf8").toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

  const headers = [
    `From: ${headerText(MAIL_FROM_NAME)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${os.hostname()}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated"
  ];

  return headers.join("\r\n") + "\r\n\r\n" + encoded + "\r\n";
}

// Resolves when the server has accepted the message; rejects with what it
// said. Nothing is retried here.
async function sendMail({ to, subject, body }) {
  if (!isMailConfigured()) {
    throw new Error("Mail is not set up on this server. " +
      "Fill in the SETUP block at the top of public/javascript/mailer.js.");
  }

  const address = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(`"${address}" is not an address this can send to.`);
  }

  let socket = await connect(MAIL_HOST, MAIL_PORT, MAIL_SECURE);
  let smtp = openConversation(socket);

  try {
    await smtp.expect(undefined, 220);                    // the greeting
    await smtp.expect(`EHLO ${os.hostname()}`, 250);

    if (!MAIL_SECURE) {
      await smtp.expect("STARTTLS", 220);
      socket = await upgrade(socket, MAIL_HOST);
      smtp = openConversation(socket);                    // a new conversation on the wrapped socket
      await smtp.expect(`EHLO ${os.hostname()}`, 250);
    }

    // AUTH LOGIN is the one Gmail documents
    await smtp.expect("AUTH LOGIN", 334);
    await smtp.expect(Buffer.from(MAIL_USER, "utf8").toString("base64"), 334);
    await smtp.expect(Buffer.from(MAIL_PASSWORD, "utf8").toString("base64"), 235);

    await smtp.expect(`MAIL FROM:<${MAIL_USER}>`, 250);
    await smtp.expect(`RCPT TO:<${address}>`, 250, 251);
    await smtp.expect("DATA", 354);
    await smtp.expect(buildMessage(MAIL_USER, address, subject, body) + ".", 250);

    socket.write("QUIT\r\n");
    return true;
  } finally {
    socket.destroy();
  }
}

// The one message this system sends. No address and no link on purpose: a
// mail with a password and a link in it is the shape of phishing.
function firstPasswordMessage({ name, email, roleName, password, storeName }) {
  const shop = storeName || "the hardware shop";

  // the subject carries MAIL_FROM_NAME so it agrees with the sender line
  return {
    to: email,
    subject: `Your ${MAIL_FROM_NAME} sign-in details`,
    body:
      `Hello ${name},\n\n` +
      `An account has been created for you on the ${shop} sales and inventory ` +
      `system, as ${roleName}.\n\n` +
      `    Sign in with:  ${email}\n` +
      `    Password:      ${password}\n\n` +
      `The system will ask you to choose your own password the first time you ` +
      `sign in, and this one stops working the moment you do. Until then, treat ` +
      `it as you would a key to the shop.\n\n` +
      `Ask the person who set this up for the address of the system. It is not ` +
      `in this message on purpose: a mail with a password and a link in it is ` +
      `what a fake one looks like, so this system never sends one.\n\n` +
      `Nobody here will ever ask you for your password, by mail or otherwise.\n\n` +
      `-- \n` +
      `${MAIL_FROM_NAME}\n` +
      `This message was sent automatically. There is nobody at this address to reply to.\n`
  };
}

module.exports = { isMailConfigured, sendMail, firstPasswordMessage };
