const helpers = require("../helpers");
const net = require("net");
const tls = require("tls");
const os = require("os");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

function setting(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value.trim();
}

function flag(name, fallback) {
  const value = setting(name, "");
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readPasswordFile() {
  try {
    return fs.readFileSync(path.join(__dirname, "mail-password.txt"), "utf8").trim();
  } catch (error) {
    return "";
  }
}

const MAIL_HOST = setting("MAIL_HOST", "");
const MAIL_PORT = Number(setting("MAIL_PORT", "465"));
const MAIL_SECURE = flag("MAIL_SECURE", MAIL_PORT === 465);
const MAIL_USER = setting("MAIL_USER", "");
const MAIL_PASSWORD = setting("MAIL_PASSWORD", "") || readPasswordFile();
const MAIL_FROM_NAME = setting("MAIL_FROM_NAME", "");
const MAIL_TIMEOUT_MS = Number(setting("MAIL_TIMEOUT_MS", "20000"));

function isMailConfigured() {
  if (process.env.HARDWARE_MAIL_OFF === "1") return false;

  return MAIL_HOST !== "" && Number.isInteger(MAIL_PORT) && MAIL_PORT > 0 &&
    MAIL_USER !== "" && MAIL_PASSWORD !== "";
}

function openConversation(socket) {
  let buffer = "";
  let waiting = null;
  let closed = null;

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

  socket.on("data", function (chunk) {
    buffer += chunk;

    if (!/(^|\n)\d{3} [^\n]*\r?\n$/.test(buffer)) return;

    const reply = buffer;
    buffer = "";

    if (!waiting) return;

    clearTimeout(waiting.timer);
    const resolve = waiting.resolve;
    waiting = null;
    resolve({ code: Number(reply.slice(0, 3)), text: reply.trim() });
  });

  socket.on("error", function (error) {
    fail(error);
  });
  socket.on("close", function () {
    fail(new Error("The mail server closed the connection."));
  });

  function say(line) {
    if (closed) return Promise.reject(closed);

    return new Promise(function (resolve, reject) {
      waiting = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          fail(new Error("The mail server did not answer in time."));
        }, MAIL_TIMEOUT_MS)
      };
      if (line !== undefined) socket.write(line + "\r\n");
    });
  }

  async function expect(line, codes) {
    const reply = await say(line);
    if (codes.indexOf(reply.code) === -1) {
      throw new Error(reply.text.replace(/\s+/g, " "));
    }
    return reply;
  }

  return { say: say, expect: expect, socket: socket };
}

function connect(host, port, secure) {
  return new Promise(function (resolve, reject) {
    let socket;
    if (secure) {
      socket = tls.connect({ host: host, port: port, servername: host }, function () {
        resolve(socket);
      });
    } else {
      socket = net.connect({ host: host, port: port }, function () {
        resolve(socket);
      });
    }

    socket.setTimeout(MAIL_TIMEOUT_MS, function () {
      socket.destroy(new Error("No answer from " + host + ":" + port + "."));
    });
    socket.once("error", reject);
  });
}

function upgrade(socket, host) {
  return new Promise(function (resolve, reject) {
    const secure = tls.connect({ socket: socket, servername: host }, function () {
      resolve(secure);
    });
    secure.once("error", reject);
  });
}

function headerText(value) {
  const text = String(value).replace(/[\r\n]+/g, " ").trim();

  if (/^[\x20-\x7e]*$/.test(text)) return text;

  return "=?UTF-8?B?" + Buffer.from(text, "utf8").toString("base64") + "?=";
}

function base64Lines(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return buffer.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function mimePart(headers, content) {
  return headers.join("\r\n") + "\r\n\r\n" + content + "\r\n";
}

function buildMessage(from, fromName, to, subject, body, html, images, attachments) {
  const randomPart = Math.random().toString(36).slice(2);
  const domain = from.split("@")[1] || os.hostname();
  const messageId = "<" + Date.now() + "." + randomPart + "@" + domain + ">";

  const headers = [
    "From: " + headerText(fromName || from) + " <" + from + ">",
    "To: <" + to + ">",
    "Subject: " + headerText(subject),
    "Date: " + (new Date().toUTCString()),
    "Message-ID: " + messageId,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated"
  ];

  const textHeaders = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  let layer;

  if (!html) {
    layer = [textHeaders, base64Lines(body)];
  } else {
    const htmlPart = [["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"],
      base64Lines(html)];

    let htmlLayer = htmlPart;
    const pictures = images || [];
    if (pictures.length > 0) {
      const related = "rel-" + randomPart;
      let content = "--" + related + "\r\n" + mimePart(htmlPart[0], htmlPart[1]);
      for (let imageIndex = 0; imageIndex < pictures.length; imageIndex++) {
        const image = pictures[imageIndex];
        content += "--" + related + "\r\n" + mimePart([
          "Content-Type: " + image.contentType + "; name=\"" + image.filename + "\"",
          "Content-Transfer-Encoding: base64",
          "Content-ID: <" + image.cid + ">",
          "Content-Disposition: inline; filename=\"" + image.filename + "\""
        ], base64Lines(image.content));
      }
      htmlLayer = [["Content-Type: multipart/related; type=\"text/html\"; boundary=\"" + related + "\""],
        content + "--" + related + "--"];
    }

    const alternative = "alt-" + randomPart;
    layer = [["Content-Type: multipart/alternative; boundary=\"" + alternative + "\""],
      "--" + alternative + "\r\n" + mimePart(textHeaders, base64Lines(body)) +
      "--" + alternative + "\r\n" + mimePart(htmlLayer[0], htmlLayer[1]) +
      "--" + alternative + "--"];
  }

  const files = attachments || [];
  if (files.length > 0) {
    const mixed = "mix-" + randomPart;
    let content = "--" + mixed + "\r\n" + mimePart(layer[0], layer[1]);
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      content += "--" + mixed + "\r\n" + mimePart([
        "Content-Type: " + file.contentType + "; name=\"" + file.filename + "\"",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; filename=\"" + file.filename + "\""
      ], base64Lines(file.content));
    }
    layer = [["Content-Type: multipart/mixed; boundary=\"" + mixed + "\""], content + "--" + mixed + "--"];
  }

  return mimePart(headers.concat(layer[0]), layer[1]);
}

async function sendMail(message) {
  const to = message.to;
  const subject = message.subject;
  const body = message.body;
  const fromName = message.fromName;

  if (!isMailConfigured()) {
    throw new Error("Mail is not set up on this server. " +
      "Fill in the MAIL_ settings in .env at the project root.");
  }

  const address = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error("\"" + address + "\" is not an address this can send to.");
  }

  let socket = await connect(MAIL_HOST, MAIL_PORT, MAIL_SECURE);
  let smtp = openConversation(socket);

  try {
    await smtp.expect(undefined, [220]);
    await smtp.expect("EHLO " + os.hostname(), [250]);

    if (!MAIL_SECURE) {
      await smtp.expect("STARTTLS", [220]);
      socket = await upgrade(socket, MAIL_HOST);
      smtp = openConversation(socket);
      await smtp.expect("EHLO " + os.hostname(), [250]);
    }

    const userBase64 = Buffer.from(MAIL_USER, "utf8").toString("base64");
    const passwordBase64 = Buffer.from(MAIL_PASSWORD, "utf8").toString("base64");
    await smtp.expect("AUTH LOGIN", [334]);
    await smtp.expect(userBase64, [334]);
    await smtp.expect(passwordBase64, [235]);

    await smtp.expect("MAIL FROM:<" + MAIL_USER + ">", [250]);
    await smtp.expect("RCPT TO:<" + address + ">", [250, 251]);
    await smtp.expect("DATA", [354]);
    const fullMessage = buildMessage(MAIL_USER, fromName, address, subject, body,
      message.html, message.images, message.attachments);
    await smtp.expect(fullMessage + ".", [250]);

    socket.write("QUIT\r\n");
    return true;
  } finally {
    socket.destroy();
  }
}

function firstPasswordMessage(details) {
  const name = details.name;
  const email = details.email;
  const roleName = details.roleName;
  const password = details.password;
  const shop = details.storeName || "the hardware shop";
  const sender = MAIL_FROM_NAME || shop;

  return {
    to: email,
    fromName: sender,
    subject: "Your " + sender + " sign-in details",
    body:
      "Hello " + name + ",\n\n" +
      "An account has been created for you on the " + shop + " sales and inventory " +
      "system, as " + roleName + ".\n\n" +
      "    Sign in with:  " + email + "\n" +
      "    Password:      " + password + "\n\n" +
      "The system will ask you to choose your own password the first time you " +
      "sign in, and this one stops working the moment you do. Until then, treat " +
      "it as you would a key to the shop.\n\n" +
      "Ask the person who set this up for the address of the system. It is not " +
      "in this message on purpose: a mail with a password and a link in it is " +
      "what a fake one looks like, so this system never sends one.\n\n" +
      "Nobody here will ever ask you for your password, by mail or otherwise.\n\n" +
      "-- \n" +
      sender + "\n" +
      "This message was sent automatically. There is nobody at this address to reply to.\n"
  };
}

function passwordResetMessage(details) {
  const name = details.name;
  const email = details.email;
  const code = details.code;
  const minutes = details.minutes;
  const shop = details.storeName || "the hardware shop";
  const sender = MAIL_FROM_NAME || shop;

  return {
    to: email,
    fromName: sender,
    subject: "Your " + sender + " password reset code",
    body:
      "Hello " + name + ",\n\n" +
      "Somebody asked to set a new password for " + email + " on the " + shop + " sales " +
      "and inventory system. If it was you, type this code on the sign-in page, " +
      "under \"Forgot your password?\":\n\n" +
      "    Code:  " + code + "\n\n" +
      "It stops working in " + minutes + " minutes, after five wrong tries, or as soon " +
      "as a newer code is sent.\n\n" +
      "If it was not you, do nothing: your password stays as it is. Tell the " +
      "manager or the system administrator if these keep arriving.\n\n" +
      "Nobody here will ever ask you for this code, by mail or otherwise.\n\n" +
      "-- \n" +
      sender + "\n" +
      "This message was sent automatically. There is nobody at this address to reply to.\n"
  };
}

function money(value) {
  return Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quantityText(value) {
  const number = Number(value || 0);
  if (Number.isInteger(number)) {
    return String(number);
  }
  let text = number.toFixed(3);
  text = text.replace(/0+$/, "");
  text = text.replace(/\.$/, "");
  return text;
}

function htmlText(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function siteAddress(fallback) {
  const address = setting("HARDWARE_SITE_URL", "") || String(fallback || "");
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(address)) return "";
  return address.replace(/\/+$/, "") + "/";
}

function supplierOrderLink(fallback, code) {
  const site = siteAddress(fallback);
  if (!site || !code) return "";
  return site + "supplier-order.html?code=" + encodeURIComponent(code);
}

function qrPng(link) {
  return QRCode.toBuffer(link, {
    width: 320, margin: 1, errorCorrectionLevel: "M",
    color: { dark: MAIL_CHROME, light: "#ffffff" }
  });
}

const MAIL_INK = "#14181d";
const MAIL_STEEL = "#4d5661";
const MAIL_LINE = "#d5d8dd";
const MAIL_PAPER = "#edeef0";
const MAIL_CHROME = "#1b1f24";
const MAIL_BRAND = "#f04e23";
const MAIL_GO = "#d0400f";
const MAIL_FONT = "Arial, Helvetica, sans-serif";

async function purchaseOrderMessage(details) {
  const order = details.order;
  const items = details.items || [];
  const shop = details.shop;

  let shopName = "the hardware shop";
  let shopAddress = "the shop's address";
  if (shop && shop.store_name) shopName = shop.store_name;
  if (shop && shop.address) shopAddress = shop.address;

  const sender = MAIL_FROM_NAME || shopName;
  const number = helpers.poNumber(order.po_id);
  const date = String(order.order_date || "").slice(0, 10);
  const fileName = number + ".pdf";

  const link = details.link || "";

  let total = 0;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    total = total + Number(item.line_cost || 0);
  }
  let lineWord = "lines";
  if (items.length === 1) {
    lineWord = "line";
  }
  const priced = total > 0;

  let greeting = "Hello";
  if (order.contact_person) {
    greeting = "Hello " + order.contact_person;
  }

  let nextStepText;
  if (link) {
    nextStepText =
      "Once you have read it, open this link to answer. There you can " +
      (priced ? "correct any price that does not match yours" : "type your price for each line") +
      ", tell us the day it ships, and accept the order (or tell us you cannot fill it). " +
      "Our manager is told the moment you answer:\n\n    " + link + "\n\n";
  } else {
    nextStepText = "Once you have read it, contact " + shopName + " to confirm the order.\n\n";
  }

  const body =
    greeting + ",\n\n" +
    shopName + " would like to place purchase order " + number + " with " + order.supplier_name + ". " +
    "The full order is attached as " + fileName + ": open it to see every material, quantity and price.\n\n" +
    "    Purchase order:   " + number + "\n" +
    "    Date:             " + date + "\n" +
    "    Lines:            " + items.length + "\n" +
    "    Total:            " + (priced ? "PHP " + money(total) : "--") + "\n" +
    "    Deliver to:       " + shopName + ", " + shopAddress + "\n\n" +
    nextStepText +
    "Please quote " + number + " on the delivery receipt and the invoice.\n\n" +
    "-- \n" +
    sender + "\n" +
    "This message was sent automatically. To reply, contact the shop directly.\n";

  const images = [];
  if (link) {
    images.push({
      cid: "qr-" + order.po_id + "@lucelyn-hardware",
      filename: "order-link-qr.png",
      contentType: "image/png",
      content: await qrPng(link)
    });
  }

  const attachments = [];
  if (details.pdf) {
    attachments.push({ filename: fileName, contentType: "application/pdf", content: details.pdf });
  }

  const label = "font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;" +
                "color:" + MAIL_STEEL + ";padding-bottom:4px;";
  const fact = function (name, value, strong) {
    let valueStyle = "font-size:15px;";
    if (strong) {
      valueStyle = "font-size:18px;font-weight:bold;";
    }
    return "<td valign=\"top\" width=\"50%\" style=\"padding:12px 14px;border:1px solid " + MAIL_LINE + ";font-size:14px;\">" +
      "<div style=\"" + label + "\">" + name + "</div>" +
      "<div style=\"" + valueStyle + "\">" + value + "</div>" +
    "</td>";
  };
  const button = "display:inline-block;background:" + MAIL_GO + ";color:#ffffff;text-decoration:none;" +
                 "font-weight:bold;font-size:15px;padding:12px 22px;border-radius:3px;";

  let answerHtml;
  if (link) {
    answerHtml = "<tr><td style=\"padding:24px 28px 0;\">" +
          "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" " +
            "style=\"border:1px solid " + MAIL_LINE + ";\"><tr>" +
            "<td valign=\"middle\" width=\"150\" style=\"padding:16px;\">" +
              "<img src=\"cid:" + images[0].cid + "\" width=\"140\" height=\"140\" alt=\"QR code for the order's page\" " +
                "style=\"display:block;width:140px;height:140px;border:0;\">" +
            "</td>" +
            "<td valign=\"middle\" style=\"padding:16px 18px 16px 4px;font-size:14px;line-height:1.55;\">" +
              "<div style=\"" + label + "\">Answer in a minute, no account needed</div>" +
              "<div style=\"margin-bottom:14px;\">Scan the code with your phone's camera, or press the button. " +
                "On the order's page you can " +
                (priced ? "<strong>correct a price</strong> that does not match yours, "
                        : "<strong>type your price</strong> for each line, ") +
                "<strong>pick the day it ships</strong>, and accept it, or tell us you cannot fill it. " +
                "Our manager is told the moment you answer.</div>" +
              "<a href=\"" + htmlText(link) + "\" style=\"" + button + "\">" +
                (priced ? "Check prices and accept" : "Set prices and accept") + "</a>" +
            "</td>" +
          "</tr></table>" +
          "<div style=\"margin-top:8px;font-size:11.5px;color:" + MAIL_STEEL + ";word-break:break-all;\">" +
            "If the button does not work, open: <a href=\"" + htmlText(link) + "\" style=\"color:" + MAIL_GO + ";\">" +
            htmlText(link) + "</a></div>" +
        "</td></tr>";
  } else {
    answerHtml = "<tr><td style=\"padding:22px 28px 0;font-size:14px;line-height:1.55;\">" +
          "Once you have read it, contact " + htmlText(shopName) + " to confirm the order." +
        "</td></tr>";
  }

  const html =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + htmlText(number) + "</title></head>" +
    "<body style=\"margin:0;padding:0;background:" + MAIL_PAPER + ";\">" +
    "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:" + MAIL_PAPER + ";\">" +
    "<tr><td align=\"center\" style=\"padding:24px 12px;\">" +

    "<table role=\"presentation\" width=\"640\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" " +
      "style=\"width:100%;max-width:640px;background:#ffffff;border:1px solid " + MAIL_LINE + ";" +
      "font-family:" + MAIL_FONT + ";color:" + MAIL_INK + ";\">" +

      "<tr><td style=\"height:6px;line-height:6px;font-size:0;background:" + MAIL_BRAND + ";\">&nbsp;</td></tr>" +
      "<tr><td style=\"background:" + MAIL_CHROME + ";padding:22px 28px;\">" +
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>" +
          "<td valign=\"middle\" style=\"font-family:" + MAIL_FONT + ";\">" +
            "<div style=\"font-size:21px;font-weight:bold;color:#ffffff;\">" + htmlText(shopName) + "</div>" +
            "<div style=\"font-size:12px;color:#aab1ba;margin-top:4px;\">" + htmlText(shopAddress) + "</div>" +
          "</td>" +
          "<td valign=\"middle\" align=\"right\" style=\"font-family:" + MAIL_FONT + ";white-space:nowrap;\">" +
            "<div style=\"font-size:11px;font-weight:bold;letter-spacing:2px;color:" + MAIL_BRAND + ";\">PURCHASE ORDER</div>" +
            "<div style=\"font-size:22px;font-weight:bold;color:#ffffff;margin-top:2px;\">" + htmlText(number) + "</div>" +
            "<div style=\"font-size:12px;color:#aab1ba;margin-top:2px;\">" + htmlText(date) + "</div>" +
          "</td>" +
        "</tr></table>" +
      "</td></tr>" +

      "<tr><td style=\"padding:28px 28px 4px;font-size:15px;line-height:1.6;\">" +
        "<p style=\"margin:0 0 12px;\">" + htmlText(greeting) + ",</p>" +
        "<p style=\"margin:0;\">" + htmlText(shopName) + " would like to place purchase order " +
          "<strong>" + htmlText(number) + "</strong> with <strong>" + htmlText(order.supplier_name) + "</strong>. " +
          "The full order is attached as a PDF: open it to see every material, quantity and price.</p>" +
      "</td></tr>" +

      "<tr><td style=\"padding:18px 28px 0;\">" +
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" " +
          "style=\"background:" + MAIL_PAPER + ";border-left:4px solid " + MAIL_BRAND + ";\"><tr>" +
          "<td style=\"padding:12px 14px;font-size:14px;line-height:1.5;\">" +
            "<strong>&#128206; " + htmlText(fileName) + "</strong>" +
            "<span style=\"color:" + MAIL_STEEL + ";\"> &middot; attached to this email</span>" +
          "</td>" +
        "</tr></table>" +
      "</td></tr>" +

      "<tr><td style=\"padding:18px 28px 0;\">" +
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border-collapse:collapse;\">" +
          "<tr>" + (fact("Purchase order", htmlText(number))) + (fact("Date", htmlText(date))) + "</tr>" +
          "<tr>" + fact("Lines", items.length + " " + lineWord) + (fact("Total", priced ? "&#8369;" + money(total) : "--", true)) + "</tr>" +
        "</table>" +
      "</td></tr>" +

      answerHtml +

      "<tr><td style=\"padding:20px 28px 0;\">" +
        "<div style=\"background:#fdf3d6;border-left:4px solid #f5b301;padding:12px 14px;" +
          "font-size:13px;line-height:1.55;\">" +
          "Please quote <strong>" + htmlText(number) + "</strong> on the delivery receipt and the invoice. " +
          "If a price or a quantity has changed, say so on the delivery receipt and the stockroom will " +
          "count the delivery in against it." +
        "</div>" +
      "</td></tr>" +

      "<tr><td style=\"padding:28px 28px 26px;font-size:12px;line-height:1.5;color:" + MAIL_STEEL + ";\">" +
        "<div style=\"border-top:1px solid " + MAIL_LINE + ";padding-top:14px;\">" +
          "<strong style=\"color:" + MAIL_INK + ";\">" + htmlText(sender) + "</strong><br>" +
          "This message was sent automatically. To reply, contact the shop directly." +
        "</div>" +
      "</td></tr>" +

    "</table>" +
    "</td></tr></table></body></html>";

  return {
    to: order.supplier_email,
    fromName: sender,
    subject: "Purchase order " + number + " from " + shopName,
    body: body,
    html: html,
    images: images,
    attachments: attachments
  };
}

module.exports = {
  isMailConfigured: isMailConfigured,
  sendMail: sendMail,
  firstPasswordMessage: firstPasswordMessage,
  passwordResetMessage: passwordResetMessage,
  purchaseOrderMessage: purchaseOrderMessage,
  supplierOrderLink: supplierOrderLink,
  qrPng: qrPng
};
