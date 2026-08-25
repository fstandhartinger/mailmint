'use strict';
// Adapter for our own Cloudflare Email Worker (src/worker/cloudflare-email-worker.js).
//
// The worker streams the raw MIME as the request body and puts the envelope in
// X- headers, because that is the only thing a Worker can do cheaply: on the
// free plan an email handler that does real work hits EXCEEDED_CPU.
//
//   POST /inbound/cloudflare
//   content-type: message/rfc822
//   x-mailmint-secret:     <shared secret>
//   x-mailmint-from:       envelope MAIL FROM
//   x-mailmint-to:         envelope RCPT TO
//   x-mailmint-size:       message.rawSize
//   x-mailmint-worker:     <zone name>

const crypto = require('node:crypto');
const { readBody, headerOf, toCrlf, envelope } = require('./http');

async function parse(req, opts = {}) {
  if (opts.secret) {
    const given = headerOf(req, 'x-mailmint-secret') || '';
    if (!timingSafeEqual(given, opts.secret)) {
      throw Object.assign(new Error('bad or missing x-mailmint-secret'), { statusCode: 401 });
    }
  }
  const body = await readBody(req);
  if (!body.length) throw Object.assign(new Error('empty body'), { statusCode: 400 });

  const rawMime = toCrlf(body);
  const declared = Number(headerOf(req, 'x-mailmint-size') || 0);
  return {
    rawMime,
    envelope: envelope({
      from: headerOf(req, 'x-mailmint-from'),
      to: headerOf(req, 'x-mailmint-to'),
      helo: headerOf(req, 'x-mailmint-helo') || 'cloudflare-email-routing',
      remoteIp: headerOf(req, 'x-mailmint-remote-ip') || null,
      // Cloudflare terminates the SMTP session for us and requires TLS inbound.
      tls: true,
    }),
    meta: {
      source: 'cloudflare',
      zone: headerOf(req, 'x-mailmint-worker') || null,
      declared_size: Number.isFinite(declared) && declared > 0 ? declared : null,
      size_mismatch: Number.isFinite(declared) && declared > 0 && declared !== body.length,
    },
  };
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = { parse };
