'use strict';
// Adapter for a Mailgun inbound route.
//
// Configure the route action as `store(notify="https://…/inbound/mailgun")` or
// `forward("https://…/inbound/mailgun")` with the "raw MIME" message format, so
// Mailgun posts multipart/form-data containing `body-mime` — the untouched
// message. We deliberately do NOT use Mailgun's parsed fields: the parser is
// ours, and their parse loses attachments' exact bytes.
//
// Every POST is authenticated with Mailgun's own HMAC:
//   signature = hex(HMAC-SHA256(key = signing key, msg = timestamp + token))

const crypto = require('node:crypto');
const { readForm, toCrlf, envelope } = require('./http');

const MAX_SKEW_SECONDS = 300;

function verifySignature({ timestamp, token, signature }, signingKey, { now = Date.now() } = {}) {
  if (!timestamp || !token || !signature) return { ok: false, reason: 'missing signature fields' };
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale timestamp' };
  const expected = crypto.createHmac('sha256', signingKey)
    .update(String(timestamp) + String(token))
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

async function parse(req, opts = {}) {
  const form = await readForm(req);
  const f = form.fields;

  if (opts.signingKey) {
    const v = verifySignature(
      { timestamp: f.timestamp, token: f.token, signature: f.signature },
      opts.signingKey, opts);
    if (!v.ok) throw Object.assign(new Error(`mailgun signature: ${v.reason}`), { statusCode: 401 });
  }

  // Prefer the untouched MIME. `body-mime` is the raw-MIME route format;
  // `message` is what store() hands back when fetched.
  let raw = f['body-mime'] || f.message || null;
  if (!raw && form.files && form.files['body-mime']) raw = form.files['body-mime'].data;
  if (!raw && form.files && form.files.message) raw = form.files.message.data;
  if (!raw) {
    throw Object.assign(
      new Error('no raw MIME in the payload: configure the Mailgun route for the raw MIME format'),
      { statusCode: 422 });
  }

  return {
    rawMime: toCrlf(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')),
    envelope: envelope({
      from: f.sender || f.from,
      to: f.recipient || f.to,
      helo: null,
      // Mailgun does not pass the client IP through; the auth results it
      // computed are in the raw headers we forward on.
      remoteIp: null,
      tls: null,
    }),
    meta: {
      source: 'mailgun',
      message_url: f['message-url'] || null,
      mailgun_spf: f['X-Mailgun-Spf'] || null,
      mailgun_dkim: f['X-Mailgun-Dkim-Check-Result'] || null,
    },
  };
}

module.exports = { parse, verifySignature };
