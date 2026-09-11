// mailer.js  --  SENDING MAIL
// Loaded by: server.js only. Never sent to a browser.
// ------------------------------------------------------------------------
// ==========================================
// WHY THIS IS HAND-WRITTEN AND NOT A PACKAGE
//
// The system has one thing to say by email: here is the password for the
// account somebody just made for you. One message, to one address, in plain
// text, from one account. That is a few hundred lines of SMTP, and SMTP has
// not changed in thirty years.
//
// A mail package brings templating, attachments, queues, half a dozen
// transports and a dependency tree, all of which have to be installed on
// every machine this project is set up on and none of which this system
// uses. The passwords in here are already hashed with scrypt out of Node
// itself rather than with bcrypt off npm, for the same reason: a capstone
// that has to be handed to somebody and run should need npm install to
// fetch as little as possible.
//
// So this speaks SMTP directly, over tls, both of which ship inside Node.
//
// WHAT IT DELIBERATELY DOES NOT DO
// No queue, no retries, no bounce handling. A send either goes through
// while the administrator is looking at the screen or it fails and says so,
// and the screen then shows the password so the account is not stranded.
// Retrying in the background would mean a password sitting in memory
// waiting for a mail server, which is worse than telling somebody now.
// ==========================================
const net = require("net");
const tls = require("tls");
const os = require("os");
const fs = require("fs");
const path = require("path");

// ==========================================
// SETUP - the mail account this system sends from
//
// MAIL_ENABLED is false out of the box, and with it false nothing here is
// ever contacted: a new account's password is shown on the administrator's
// screen to be handed over instead. Turn it on once the four lines under it
// are filled in.
//
// WHERE THE PASSWORD GOES
// Not in this file. It is read from mail-password.txt, in this same folder,
// which holds the password and nothing else, on one line. That file is
// listed in .gitignore, so the password never lands in the repository the
// way the address and the host do -- a file that is pushed to GitHub is
// read by everybody the repository is ever shared with. With no such file,
// or an empty one, mail is off and the fallback (the password shown on
// screen) is used.
//
// FOR A GMAIL ACCOUNT
// The password in that file is not the password you sign in to Gmail with.
// Google refuses those over SMTP. Turn on 2-Step Verification on the
// account, then make an App Password (16 letters) at
// myaccount.google.com/apppasswords and put that in the file. Leave the
// host and port as they are.
//
// FOR ANYTHING ELSE
// Port 465 is TLS from the first byte, so MAIL_SECURE stays true. Port 587
// starts in the clear and is upgraded with STARTTLS, so set MAIL_SECURE to
// false for it. Both are handled below. Port 25 is not offered: it is
// unencrypted, and this connection carries a password.
// ==========================================
const MAIL_ENABLED = true;
const MAIL_HOST = "smtp.gmail.com";
const MAIL_PORT = 465;
const MAIL_SECURE = true;          // true on 465, false on 587
const MAIL_USER = "lucelyn.hardware.support@gmail.com";   // the full address, e.g. shop@gmail.com
const MAIL_PASSWORD = readPasswordFile();   // see WHERE THE PASSWORD GOES, above
const MAIL_FROM_NAME = "Lucelyn Hardware Support";

// the whole of mail-password.txt, trimmed; "" when there is no such file
function readPasswordFile() {
  try {
    return fs.readFileSync(path.join(__dirname, "mail-password.txt"), "utf8").trim();
  } catch (error) {
    return "";
  }
}

// A mail server that has stopped answering must not hold up the screen that
// is waiting on it, so every step of the conversation is on a clock.
const MAIL_TIMEOUT_MS = 20000;

// Whether there is anything to send with. Called before a send is attempted
// so the screen can say "shown here because mail is not set up" rather than
// "the mail server refused", which are different problems with different
// fixes.
function isMailConfigured() {
  return MAIL_ENABLED === true &&
    typeof MAIL_USER === "string" && MAIL_USER.trim() !== "" &&
    typeof MAIL_PASSWORD === "string" && MAIL_PASSWORD.trim() !== "";
}

// ==========================================
// ONE SMTP CONVERSATION
//
// SMTP is a sequence of lines: this end sends a command, that end answers
// with a three digit code. A reply can run to several lines, and the way to
// tell the last one is that the code is followed by a space rather than by a
// hyphen -- which is why this buffers rather than treating every line that
// arrives as an answer.
// ==========================================
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

    // The last line of a reply is "250 text"; every earlier line of the same
    // reply is "250-text". So the answer is complete once the buffer ends
    // with a line whose code is followed by a space. Anything short of that
    // is half an answer and is left in the buffer.
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

  // reads one reply. Passing no line just waits, which is what the greeting
  // at the start of the conversation needs.
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

  // the same thing, but a code other than the one expected is an error
  // carrying what the server actually said, because "535 Username and
  // Password not accepted" is the whole diagnosis and a generic
  // "mail failed" is none of it
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

// STARTTLS: the same socket, wrapped, once the server has agreed to it
function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: socket, servername: host }, () => resolve(secure));
    secure.once("error", reject);
  });
}

// ==========================================
// ONE MESSAGE
//
// Encoded as base64 UTF-8 rather than written into the body as it stands.
// That is not for the accents: it is because a line of a mail body that
// begins with a full stop ends the message early unless it is escaped, and a
// generated password can begin with anything. Base64 has no full stop in its
// alphabet, so the problem cannot arise.
// ==========================================
function headerText(value) {
  const text = String(value).replace(/[\r\n]+/g, " ").trim();

  // a header outside plain ASCII has to be an encoded word, or it arrives
  // as mojibake in half the mail clients in the world
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

// ==========================================
// SEND ONE
//
// Resolves when the server has accepted the message. Rejects with what the
// server said, or with what went wrong reaching it. The caller decides what
// to do about a rejection; nothing is retried here.
// ==========================================
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

    // AUTH LOGIN rather than AUTH PLAIN: every server that takes one takes
    // the other, and this one is the one Gmail documents.
    await smtp.expect("AUTH LOGIN", 334);
    await smtp.expect(Buffer.from(MAIL_USER, "utf8").toString("base64"), 334);
    await smtp.expect(Buffer.from(MAIL_PASSWORD, "utf8").toString("base64"), 235);

    await smtp.expect(`MAIL FROM:<${MAIL_USER}>`, 250);
    await smtp.expect(`RCPT TO:<${address}>`, 250, 251);
    await smtp.expect("DATA", 354);
    await smtp.expect(buildMessage(MAIL_USER, address, subject, body) + ".", 250);

    // the reply to QUIT is not worth waiting for: the message is accepted
    socket.write("QUIT\r\n");
    return true;
  } finally {
    socket.destroy();
  }
}

// ==========================================
// THE ONE MESSAGE THIS SYSTEM SENDS
//
// Kept here rather than in server.js so the wording of what a new member of
// staff receives is in one place and reads as a letter rather than as string
// concatenation in the middle of a route.
//
// It does not name the system's address, and it does not carry a link. A
// mail with a password and a link in it is the shape of every phishing
// message ever sent, and teaching staff that such a mail is normal is worse
// than making them ask a colleague for the address once.
// ==========================================
function firstPasswordMessage({ name, email, roleName, password, storeName }) {
  const shop = storeName || "the hardware shop";

  return {
    to: email,
    subject: `Your ${shop} sign-in details`,
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
      `${shop}\n` +
      `This message was sent automatically. There is nobody at this address to reply to.\n`
  };
}

module.exports = { isMailConfigured, sendMail, firstPasswordMessage };
