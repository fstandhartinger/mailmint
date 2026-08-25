'use strict';
// The lowest-common-denominator adapter: any system that can POST a raw MIME
// message. The envelope comes from X- headers or the query string; if neither
// is present it is recovered from the message's own Return-Path/To headers so
// that even `curl --data-binary @message.eml` works.

const crypto = require('node:crypto');
const { readForm, headerOf, toCrlf, envelope } = require('./http');
const { splitMessage } = require('../auth/dkim');
const { headerFromDomain } = require('../address');

async function parse(req, opts = {}) {
  if (opts.secret) {
    const given = headerOf(req, 'x-mailmint-secret') || '';
    const A = Buffer.from(String(given));
    const B = Buffer.from(String(opts.secret));
    if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) {
      throw Object.assign(new Error('bad or missing x-mailmint-secret'), { statusCode: 401 });
    }
  }

  const form = await readForm(req);
  let raw = null;
  let env = {};

  if (form.json) {
    raw = form.json.raw_mime_base64
      ? Buffer.from(form.json.raw_mime_base64, 'base64')
      : (form.json.raw_mime || form.json.raw || form.json.message || null);
    env = form.json.envelope || {};
  } else if (form.files && form.files.message) {
    raw = form.files.message.data;
  } else if (form.fields && (form.fields.message || form.fields.raw)) {
    raw = form.fields.message || form.fields.raw;
  } else {
    raw = form.raw;
  }
  if (!raw || !raw.length) throw Object.assign(new Error('empty body'), { statusCode: 400 });
  const rawMime = toCrlf(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'));

  const url = new URL(req.url || '/', 'http://internal');
  let from = env.from || headerOf(req, 'x-mailmint-from') || url.searchParams.get('from');
  let to = env.to || headerOf(req, 'x-mailmint-to') || url.searchParams.getAll('to').join(',');

  if (!from || !to) {
    // last resort: read the message's own headers
    const parsed = splitMessage(rawMime);
    const get = (n) => {
      const h = parsed.headers.filter((x) => x.lowerName === n);
      return h.length ? h[h.length - 1].value.replace(/\r\n[ \t]+/g, ' ').trim() : null;
    };
    if (!from) {
      const rp = get('return-path');
      from = rp || get('from') || '';
      if (from && !from.includes('@')) from = '';
      if (from && headerFromDomain(from)) {
        const m = from.match(/<([^>]*)>/);
        from = m ? m[1] : from;
      }
    }
    if (!to) {
      const dt = get('delivered-to') || get('x-original-to') || get('to') || '';
      const m = dt.match(/<([^>]*)>/);
      to = m ? m[1] : dt;
    }
  }

  return {
    rawMime,
    envelope: envelope({
      from,
      to,
      helo: env.helo || headerOf(req, 'x-mailmint-helo') || null,
      remoteIp: env.remote_ip || headerOf(req, 'x-mailmint-remote-ip') ||
        headerOf(req, 'x-forwarded-for') || null,
      tls: env.tls === undefined ? null : env.tls,
    }),
    meta: { source: headerOf(req, 'x-mailmint-source') || 'generic' },
  };
}

module.exports = { parse };
