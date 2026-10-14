var MAX_BODY_BYTES = 20000;
var WINDOW_MS = 10 * 60 * 1000;
var MAX_PER_WINDOW = 5;
var hits = global.__contactHits || (global.__contactHits = new Map());

var DEFAULT_TO = "Twentyfivehomomes@gmail.com";

function clientIp(req) {
  var fwd = req.headers["x-forwarded-for"];
  if (Array.isArray(fwd)) fwd = fwd[0];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function limited(ip) {
  var now = Date.now();
  var row = hits.get(ip);
  if (!row || now - row.start >= WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  row.count += 1;
  return row.count > MAX_PER_WINDOW;
}

function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return null;
    }
  }
  return null;
}

function validate(body) {
  var name = clean(body.name, 120);
  var email = clean(body.email, 200);
  var phone = clean(body.phone, 40);
  var message = clean(body.message, 5000);
  if (!name) return { error: "Enter your name." };
  if (!validEmail(email)) return { error: "Enter a valid email address." };
  if (phone && !/^[0-9+().\-\s]{3,40}$/.test(phone))
    return { error: "Enter a valid phone number, or leave it blank." };
  if (!message) return { error: "Enter a message." };
  return { value: { name: name, email: email, phone: phone, message: message } };
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "Method not allowed." });
    return;
  }

  var length = Number(req.headers["content-length"] || 0);
  if (length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "That message is too long." });
    return;
  }

  var body = readBody(req);
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "Enter your name, email, and message." });
    return;
  }

  if (limited(clientIp(req))) {
    res.status(429).json({
      ok: false,
      error: "Please wait a few minutes and try again.",
    });
    return;
  }

  if (clean(body.company, 200)) {
    res.status(200).json({ ok: true });
    return;
  }

  var checked = validate(body);
  if (checked.error) {
    res.status(400).json({ ok: false, error: checked.error });
    return;
  }

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      ok: false,
      error: "We couldn't send your message just now. Please try again shortly.",
    });
    return;
  }

  var enquiry = checked.value;
  var submitted = new Date();
  var when = submitted.toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    dateStyle: "full",
    timeStyle: "short",
  });
  var phoneLine = enquiry.phone || "Not provided";
  var text = [
    "New contact enquiry — 25 Homes",
    "",
    "Name: " + enquiry.name,
    "Email: " + enquiry.email,
    "Phone: " + phoneLine,
    "Submitted: " + when + " (Africa/Lagos)",
    "ISO: " + submitted.toISOString(),
    "",
    enquiry.message,
  ].join("\n");
  var html =
    "<h1>New contact enquiry — 25 Homes</h1>" +
    "<p><strong>Name:</strong> " +
    escapeHtml(enquiry.name) +
    "</p>" +
    "<p><strong>Email:</strong> " +
    escapeHtml(enquiry.email) +
    "</p>" +
    "<p><strong>Phone:</strong> " +
    escapeHtml(phoneLine) +
    "</p>" +
    "<p><strong>Submitted:</strong> " +
    escapeHtml(when) +
    " (Africa/Lagos)</p>" +
    "<p>" +
    escapeHtml(enquiry.message).replace(/\n/g, "<br>") +
    "</p>";

  var from = process.env.RESEND_FROM || "25 Homes <onboarding@resend.dev>";
  var to = process.env.CONTACT_TO || DEFAULT_TO;

  try {
    var response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from,
        to: [to],
        reply_to: enquiry.email,
        subject: "New Contact Enquiry — 25 Homes",
        html: html,
        text: text,
      }),
    });
    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: "We couldn't send your message just now. Please try again shortly.",
      });
      return;
    }
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: "We couldn't send your message just now. Please try again shortly.",
    });
    return;
  }

  res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.validate = validate;
module.exports.escapeHtml = escapeHtml;
