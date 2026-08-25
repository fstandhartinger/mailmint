'use strict';
// Adapter for CloudMailin.
//
// Set the target's format to "Raw" (multipart/form-data with a `message` part)
// or "JSON" (which carries `envelope` plus, on the raw target, `raw_message`).
// Both shapes are handled; the raw one is preferred because it is lossless.
//
// Optional Basic-auth or a shared secret in the URL is CloudMailin's own way of
// authenticating the POST; we additionally accept an X-CloudMailin-Secret.

const crypto = require('node:crypto');
const { readForm, headerOf, toCrlf, envelope } = require('./http');

async function parse(req, opts = {}) {
  if (opts.secret) {
    const given = headerOf(req, 'x-cloudmailin-secret') || headerOf(req, 'x-mailmint-secret') || '';
    const A = Buffer.from(String(given));
    const B = Buffer.from(String(opts.secret));
    if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) {
      throw Object.assign(new Error('bad or missing CloudMailin secret'), { statusCode: 401 });
    }
  }

  const form = await readForm(req);
  const j = form.json;

  if (j) {
    const env = j.envelope || {};
    const raw = j.raw_message || j.raw || j.message || null;
    if (!raw) {
      throw Object.assign(
        new Error('no raw message in the JSON payload: use CloudMailin\'s raw JSON format'),
        { statusCode: 422 });
    }
    return {
      rawMime: toCrlf(Buffer.from(String(raw), 'utf8')),
      envelope: envelope({
        from: env.from,
        to: env.to || env.recipients,
        helo: env.helo_domain || env.helo || null,
        remoteIp: env.remote_ip || null,
        tls: env.tls === undefined ? null : env.tls,
      }),
      meta: { source: 'cloudmailin', reported_spf: env.spf || null, format: 'json' },
    };
  }

  const f = form.fields;
  const raw = (form.files && form.files.message && form.files.message.data) || f.message || f.plain || null;
  if (!raw) throw Object.assign(new Error('no `message` part in the CloudMailin payload'), { statusCode: 422 });

  return {
    rawMime: toCrlf(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')),
    envelope: envelope({
      from: f['envelope[from]'] || f.from,
      to: f['envelope[to]'] || f.to,
      helo: f['envelope[helo_domain]'] || null,
      remoteIp: f['envelope[remote_ip]'] || null,
      tls: f['envelope[tls]'] === undefined ? null : f['envelope[tls]'] === 'true',
    }),
    meta: { source: 'cloudmailin', format: 'multipart' },
  };
}

module.exports = { parse };
