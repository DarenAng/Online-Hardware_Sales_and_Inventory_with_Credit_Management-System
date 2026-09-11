// Checks public/javascript/mailer.js against a fake SMTP server that speaks
// the same dialogue Gmail does. It needs no database, no running application
// server and no internet, which is the point: the one thing in this system
// that talks to a machine outside the shop is also the one thing that cannot
// be tested by using the shop's own screens.
//
//     node tests/mailer.js
//
// The four things worth checking here are the four that break silently:
//
//   1. A multi-line reply. A server answers EHLO with several lines and only
//      the last one carries a space after the code. A parser that treats
//      every line as a reply of its own runs the rest of the conversation one
//      answer behind and hangs.
//   2. AUTH LOGIN. Two base64 lines, in order, each waiting for its 334.
//   3. A password that begins with a full stop. A line of a mail body that
//      begins with one ends the message early. The body is base64 so it
//      cannot happen; this is the test that says so.
//   4. What the letter actually says. It must carry the password and no link.
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAILER = path.join(__dirname, "..", "public", "javascript", "mailer.js");

const failures = [];
function ok(name, passed, note) {
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || !note ? "" : "  -- " + note}`);
  if (!passed) failures.push(name);
}

// ==========================================
// A FAKE SMTP SERVER
//
// Answers the way a real one does, and keeps the transcript so the test can
// say what was actually said rather than only that something worked.
// ==========================================
const transcript = [];
let dataMode = false;
let message = "";

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 fake.smtp ESMTP ready\r\n");

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;

    let index;
    while ((index = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      if (dataMode) {
        if (line === ".") {
          dataMode = false;
          socket.write("250 2.0.0 OK queued\r\n");
        } else {
          message += line + "\n";
        }
        continue;
      }

      transcript.push(line);
      const command = line.toUpperCase();

      if (command.startsWith("EHLO")) {
        // three lines for one reply: the case the parser has to get right
        socket.write("250-fake.smtp at your service\r\n");
        socket.write("250-SIZE 35882577\r\n");
        socket.write("250 AUTH LOGIN PLAIN\r\n");
      } else if (command === "AUTH LOGIN") {
        socket.write("334 VXNlcm5hbWU6\r\n");          // "Username:"
      } else if (command.startsWith("MAIL FROM")) {
        socket.write("250 2.1.0 OK\r\n");
      } else if (command.startsWith("RCPT TO")) {
        socket.write("250 2.1.5 OK\r\n");
      } else if (command === "DATA") {
        dataMode = true;
        socket.write("354 Go ahead\r\n");
      } else if (command === "QUIT") {
        socket.write("221 2.0.0 closing\r\n");
        socket.end();
      } else {
        // the two base64 credential lines land here: user, then password
        const credentials = transcript.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l));
        socket.write(credentials.length >= 2
          ? "235 2.7.0 Accepted\r\n"                   // "Password:"
          : "334 UGFzc3dvcmQ6\r\n");
      }
    }
  });
});

// ==========================================
// THE MAILER, POINTED AT THE FAKE
//
// The SETUP block at the top of mailer.js is edited in a copy rather than in
// the project's own file. A test that rewrites the file it is testing is a
// test that leaves a mail password in the repository the first time it fails
// halfway through.
//
// STARTTLS is taken out of the copy with it, because the fake server speaks
// no TLS. That leaves the second EHLO the upgrade is followed by, which is
// why the expected transcript below has two of them.
// ==========================================
function mailerPointedAt(port) {
  const source = fs.readFileSync(MAILER, "utf8")
    // matched by name rather than by value, so the test is the same whether
    // the machine it runs on has mail set up or not
    .replace(/^const MAIL_ENABLED = .*$/m, "const MAIL_ENABLED = true;")
    .replace(/^const MAIL_HOST = .*$/m, 'const MAIL_HOST = "127.0.0.1";')
    .replace(/^const MAIL_PORT = .*$/m, `const MAIL_PORT = ${port};`)
    .replace(/^const MAIL_SECURE = .*$/m, "const MAIL_SECURE = false;")
    .replace(/^const MAIL_USER = .*$/m, 'const MAIL_USER = "shop@example.com";')
    .replace(/^const MAIL_PASSWORD = .*$/m, 'const MAIL_PASSWORD = "apppassword";')
    .replace('      await smtp.expect("STARTTLS", 220);\n' +
             "      socket = await upgrade(socket, MAIL_HOST);\n" +
             "      smtp = openConversation(socket);                    " +
             "// a new conversation on the wrapped socket\n",
             "");

  const copy = path.join(os.tmpdir(), `mailer-under-test-${process.pid}.js`);
  fs.writeFileSync(copy, source);
  return { module: require(copy), file: copy };
}

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const under = mailerPointedAt(port);
  const { sendMail, firstPasswordMessage, isMailConfigured } = under.module;

  ok("mail reports itself configured once the SETUP block is filled in",
    isMailConfigured() === true);

  // a full stop first, on purpose: see note 3 at the top of this file
  const password = ".Kx7ratHmqe4$W";
  const letter = firstPasswordMessage({
    name: "Juan D. Cruz", email: "juan@example.com", roleName: "Cashier",
    password: password, storeName: "Lucelyn Hardware"
  });

  try {
    await sendMail(letter);
    ok("the message was accepted", true);
  } catch (error) {
    ok("the message was accepted", false, error.message);
  }

  const expectedOrder = ["EHLO", "EHLO", "AUTH LOGIN", null, null,
    "MAIL FROM:<shop@example.com>", "RCPT TO:<juan@example.com>", "DATA"];
  ok("a multi-line reply was read as one reply, and nothing derailed",
    transcript.length === expectedOrder.length &&
    expectedOrder.every((want, i) => want === null || transcript[i].startsWith(want)),
    JSON.stringify(transcript));

  ok("authenticated with AUTH LOGIN, user then password",
    transcript.includes("AUTH LOGIN") &&
    transcript.includes(Buffer.from("shop@example.com").toString("base64")) &&
    transcript.includes(Buffer.from("apppassword").toString("base64")),
    JSON.stringify(transcript));

  const [headers, encoded] = message.split("\n\n");
  ok("the subject names the shop",
    /Subject: Your Lucelyn Hardware sign-in details/.test(headers), headers);
  ok("the message declares itself base64 UTF-8 text",
    /Content-Transfer-Encoding: base64/.test(headers) && /charset=UTF-8/.test(headers),
    headers);

  const body = Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf8");
  ok("the password arrived intact", body.includes(password), body.slice(0, 200));
  ok("a password beginning with a full stop did not end the message early",
    body.includes("Nobody here will ever ask you for your password"), body.slice(-200));
  ok("the letter carries no link", !/https?:\/\//.test(body), body);

  // an address that cannot receive anything is refused before a socket is opened
  try {
    await sendMail({ to: "not-an-address", subject: "x", body: "y" });
    ok("an unusable address is refused", false, "it was accepted");
  } catch (error) {
    ok("an unusable address is refused", /is not an address/.test(error.message),
      error.message);
  }

  fs.unlinkSync(under.file);
  server.close();

  console.log("");
  console.log(failures.length === 0
    ? "mailer: all checks passed"
    : `mailer: ${failures.length} check(s) failed`);
  process.exit(failures.length === 0 ? 0 : 1);
});
