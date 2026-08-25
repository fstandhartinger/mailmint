'use strict';
// DKIM verification — RFC 6376 (+ RFC 8463 for ed25519-sha256).
// Supports a=rsa-sha256 | ed25519-sha256 | rsa-sha1(legacy, reported weak),
// c=simple/simple | relaxed/relaxed and the two mixed forms, l=, x=, t=.
//
// Everything here operates on a latin1 string view of the raw bytes so that
// 8-bit bodies hash byte-for-byte identically to what the sender signed.

const crypto = require('node:crypto');
const { DnsClient } = require('./dns');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ------------------------------------------------------------- utilities ---

/** Raw bytes -> a lossless 1-byte-per-char string. */
function bytesToStr(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
}
function strToBytes(str) {
  return Buffer.from(str, 'latin1');
}

/** Normalise bare LF to CRLF (archives and files store LF; SMTP carries CRLF). */
function toCrlf(input) {
  const s = bytesToStr(input);
  return strToBytes(s.replace(/\r\n|\r|\n/g, '\r\n'));
}

/**
 * Split a message into its header block and body.
 * Returns { headers: [{name, lowerName, raw}], body: string(latin1), headerEnd }
 * `raw` includes the trailing CRLF of the (possibly folded) field.
 */
function splitMessage(input) {
  const s = bytesToStr(input);
  let sep = s.indexOf('\r\n\r\n');
  let bodyStart, headerBlock;
  if (sep === -1) {
    // tolerate a header-only message
    headerBlock = s.endsWith('\r\n') ? s : s + '\r\n';
    bodyStart = s.length;
  } else {
    headerBlock = s.slice(0, sep + 2);
    bodyStart = sep + 4;
  }
  const headers = [];
  let i = 0;
  while (i < headerBlock.length) {
    let end = headerBlock.indexOf('\r\n', i);
    if (end === -1) end = headerBlock.length - 2;
    // consume continuation lines
    let next = end + 2;
    while (next < headerBlock.length && (headerBlock[next] === ' ' || headerBlock[next] === '\t')) {
      let e2 = headerBlock.indexOf('\r\n', next);
      if (e2 === -1) { e2 = headerBlock.length - 2; }
      next = e2 + 2;
    }
    const raw = headerBlock.slice(i, next);
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const name = raw.slice(0, colon);
      headers.push({ name, lowerName: name.trim().toLowerCase(), raw, value: raw.slice(colon + 1) });
    }
    i = next;
  }
  return { headers, body: s.slice(bodyStart), headerEnd: bodyStart };
}

// ------------------------------------------------------ canonicalisation ---

function canonHeaderSimple(h) {
  // exactly as received, including the trailing CRLF
  return h.raw.endsWith('\r\n') ? h.raw : h.raw + '\r\n';
}

function canonHeaderRelaxed(h) {
  const name = h.lowerName;
  let value = h.value;
  value = value.replace(/\r\n/g, '');       // unfold
  value = value.replace(/[ \t]+/g, ' ');    // collapse WSP runs
  value = value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return `${name}:${value}\r\n`;
}

function canonHeader(h, mode) {
  return mode === 'relaxed' ? canonHeaderRelaxed(h) : canonHeaderSimple(h);
}

function canonBodySimple(body) {
  if (body.length === 0) return '\r\n';
  let b = body;
  // strip all trailing empty lines, leave exactly one CRLF
  while (b.endsWith('\r\n\r\n')) b = b.slice(0, -2);
  if (!b.endsWith('\r\n')) b += '\r\n';
  return b;
}

function canonBodyRelaxed(body) {
  if (body.length === 0) return '';
  let b = body;
  b = b.replace(/[ \t]+/g, ' ');       // collapse WSP within lines
  b = b.replace(/[ \t]+\r\n/g, '\r\n'); // strip trailing WSP per line
  // ignore all empty lines at the end of the body
  b = b.replace(/(\r\n)+$/, '');
  if (b.length === 0) return '';
  return b + '\r\n';
}

function canonBody(body, mode) {
  return mode === 'relaxed' ? canonBodyRelaxed(body) : canonBodySimple(body);
}

// ------------------------------------------------------- signature parse ---

function parseTagList(value) {
  const tags = Object.create(null);
  const unfolded = value.replace(/\r\n/g, '');
  for (const part of unfolded.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k) tags[k] = v;
  }
  return tags;
}

function stripB64Ws(s) { return (s || '').replace(/[\s]/g, ''); }

/** Blank the b= value of a DKIM-Signature header, preserving everything else. */
function stripSignatureValue(raw) {
  // find "b=" at a tag boundary and delete its value up to the next ';'
  const re = /(;|^)([ \t\r\n]*)b[ \t]*=/;
  const colon = raw.indexOf(':');
  const name = raw.slice(0, colon + 1);
  let value = raw.slice(colon + 1);
  const m = value.match(re);
  if (!m) return raw;
  const start = m.index + m[0].length;
  let end = value.indexOf(';', start);
  if (end === -1) {
    // b= is the last tag: keep the field's own trailing CRLF, drop only the value
    end = value.endsWith('\r\n') ? value.length - 2 : value.length;
  }
  const tail = value.slice(end);
  value = value.slice(0, start) + tail;
  return name + value;
}

// -------------------------------------------------------------- key load ---

function publicKeyFromRecord(rec) {
  const p = stripB64Ws(rec.p);
  if (!p) { const e = new Error('key revoked (empty p=)'); e.dkim = 'fail'; throw e; }
  const der = Buffer.from(p, 'base64');
  const k = (rec.k || 'rsa').toLowerCase();
  if (k === 'ed25519') {
    if (der.length !== 32) { const e = new Error(`ed25519 key must be 32 bytes, got ${der.length}`); e.dkim = 'permerror'; throw e; }
    return {
      key: crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, der]),
        format: 'der',
        type: 'spki',
      }),
      type: 'ed25519',
      bits: 256,
    };
  }
  if (k !== 'rsa') { const e = new Error(`unsupported key type k=${k}`); e.dkim = 'permerror'; throw e; }
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    try {
      key = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
    } catch (e2) {
      const e = new Error(`unreadable RSA key: ${e2.message}`); e.dkim = 'permerror'; throw e;
    }
  }
  const bits = key.asymmetricKeyDetails ? key.asymmetricKeyDetails.modulusLength : null;
  return { key, type: 'rsa', bits };
}

async function fetchKeyRecords(dnsClient, selector, domain) {
  const name = `${selector}._domainkey.${domain}`;
  let txts;
  try {
    txts = await dnsClient.txt(name);
  } catch (e) {
    const err = new Error(`key lookup ${name}: ${e.code}`);
    err.dkim = e.temporary ? 'temperror' : 'permerror';
    throw err;
  }
  const recs = txts
    .map((t) => parseTagList(t))
    .filter((t) => !t.v || /^dkim1$/i.test(t.v));
  if (!recs.length) {
    const err = new Error(`no DKIM key record at ${name}`);
    err.dkim = 'permerror';
    throw err;
  }
  return recs;
}

// ------------------------------------------------------------- verify one ---

const HASH_FOR = { 'rsa-sha256': 'sha256', 'rsa-sha1': 'sha1', 'ed25519-sha256': 'sha256' };

async function verifySignature(sigHeader, parsed, opts) {
  const tags = parseTagList(sigHeader.value);
  const out = {
    result: 'permerror',
    reason: null,
    domain: tags.d || null,
    selector: tags.s || null,
    algorithm: (tags.a || '').toLowerCase() || null,
    identity: tags.i || null,
    canonicalization: (tags.c || 'simple/simple').toLowerCase(),
    headers: tags.h || null,
    keyBits: null,
    bodyHashMatched: null,
    weak: false,
  };

  try {
    if (tags.v !== '1') throw permerror(`unsupported DKIM version v=${tags.v}`);
    const a = (tags.a || '').toLowerCase();
    if (!HASH_FOR[a]) throw permerror(`unsupported algorithm a=${tags.a}`);
    if (a === 'rsa-sha1') out.weak = true;
    for (const req of ['b', 'bh', 'd', 'h', 's']) {
      if (!tags[req]) throw permerror(`missing required tag ${req}=`);
    }
    const hAlg = HASH_FOR[a];
    const hlist = tags.h.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!hlist.includes('from')) throw permerror('h= does not cover From');

    // i= must be the d= domain or a subdomain of it
    if (tags.i) {
      const at = tags.i.lastIndexOf('@');
      const idom = (at === -1 ? tags.i : tags.i.slice(at + 1)).toLowerCase().replace(/\.$/, '');
      const d = tags.d.toLowerCase();
      if (idom !== d && !idom.endsWith('.' + d)) throw permerror(`i=${tags.i} not within d=${tags.d}`);
    }

    // expiry
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    if (tags.x && /^\d+$/.test(tags.x)) {
      if (Number(tags.x) < now) {
        if (tags.t && /^\d+$/.test(tags.t) && Number(tags.t) > Number(tags.x)) {
          throw permerror('x= is before t=');
        }
        if (!opts.ignoreExpiry) throw fail(`signature expired at ${tags.x}`);
      }
    }
    if (tags.t && /^\d+$/.test(tags.t) && Number(tags.t) > now + 3600 && !opts.ignoreExpiry) {
      throw permerror('t= is in the future');
    }

    const [hCanon, bCanonRaw] = out.canonicalization.split('/');
    const bCanon = bCanonRaw || 'simple';
    if (!['simple', 'relaxed'].includes(hCanon) || !['simple', 'relaxed'].includes(bCanon)) {
      throw permerror(`unsupported c=${tags.c}`);
    }

    // ---- body hash ----
    let body = canonBody(parsed.body, bCanon);
    if (tags.l !== undefined && tags.l !== '') {
      if (!/^\d+$/.test(tags.l)) throw permerror(`bad l=${tags.l}`);
      const l = Number(tags.l);
      if (l < body.length) { body = body.slice(0, l); out.lengthLimited = true; }
      else if (l > body.length) out.lengthOverrun = true;
    }
    const bh = crypto.createHash(hAlg).update(strToBytes(body)).digest('base64');
    out.bodyHashMatched = bh === stripB64Ws(tags.bh);
    if (!out.bodyHashMatched) throw fail(`body hash mismatch (computed ${bh}, signed ${stripB64Ws(tags.bh)})`);

    // ---- header hash input ----
    // For each name in h=, take occurrences from the BOTTOM of the header block up.
    const used = new Map();
    let signedHeaders = '';
    for (const name of hlist) {
      const matches = parsed.headers.filter((h) => h.lowerName === name);
      const consumed = used.get(name) || 0;
      const idx = matches.length - 1 - consumed;
      used.set(name, consumed + 1);
      if (idx < 0) continue; // a null field: signs its absence, contributes nothing
      signedHeaders += canonHeader(matches[idx], hCanon);
    }
    // finally the DKIM-Signature itself, b= emptied, no trailing CRLF
    const selfRaw = stripSignatureValue(sigHeader.raw);
    const selfHeader = { ...sigHeader, raw: selfRaw, value: selfRaw.slice(selfRaw.indexOf(':') + 1) };
    let selfCanon = canonHeader(selfHeader, hCanon);
    selfCanon = selfCanon.replace(/\r\n$/, '');
    signedHeaders += selfCanon;

    // ---- key ----
    const records = opts.keyRecords || await fetchKeyRecords(opts.dns, tags.s, tags.d);
    const sig = Buffer.from(stripB64Ws(tags.b), 'base64');
    let lastErr = null;
    for (const rec of records) {
      let pub;
      try { pub = publicKeyFromRecord(rec); }
      catch (e) { lastErr = e; continue; }
      out.keyBits = pub.bits;
      if (pub.type === 'ed25519' && a !== 'ed25519-sha256') { lastErr = permerror('key is ed25519 but a= is not'); continue; }
      if (pub.type === 'rsa' && a.startsWith('ed25519')) { lastErr = permerror('key is rsa but a= is ed25519'); continue; }
      if (rec.h) {
        const allowed = rec.h.split(':').map((x) => x.trim().toLowerCase());
        if (!allowed.includes(hAlg)) { lastErr = permerror(`key forbids hash ${hAlg}`); continue; }
      }
      if (pub.type === 'rsa' && pub.bits && pub.bits < 1024) out.weak = true;

      const data = strToBytes(signedHeaders);
      let ok;
      if (pub.type === 'ed25519') {
        ok = crypto.verify(null, data, pub.key, sig);
      } else {
        ok = crypto.verify(hAlg, data, pub.key, sig);
      }
      if (ok) {
        out.result = 'pass';
        out.reason = null;
        return out;
      }
      lastErr = fail('signature did not verify against the published key');
    }
    throw lastErr || permerror('no usable key record');
  } catch (e) {
    out.result = e.dkim || 'permerror';
    out.reason = e.message;
    return out;
  }
}

function permerror(msg) { const e = new Error(msg); e.dkim = 'permerror'; return e; }
function fail(msg) { const e = new Error(msg); e.dkim = 'fail'; return e; }

/**
 * Verify every DKIM-Signature in a message.
 * @param {Buffer|string} raw   the raw RFC822 message (CRLF line endings)
 * @param {object} opts         { dns, maxSignatures, keyRecords, now, ignoreExpiry }
 * @returns {Promise<{result, signatures:[...], reason}>}
 *   result is the best outcome: pass > fail > temperror > permerror > none
 */
async function verify(raw, opts = {}) {
  const dnsClient = opts.dns || new DnsClient({ timeoutMs: opts.dnsTimeoutMs });
  const parsed = splitMessage(raw);
  const sigs = parsed.headers.filter((h) => h.lowerName === 'dkim-signature');
  if (!sigs.length) return { result: 'none', signatures: [], reason: 'no DKIM-Signature header' };

  const max = opts.maxSignatures ?? 5;
  const results = [];
  // Verify from the top down (the most recent signer signs first).
  for (const s of sigs.slice(0, max)) {
    results.push(await verifySignature(s, parsed, { ...opts, dns: dnsClient }));
  }
  const rank = { pass: 5, fail: 4, temperror: 3, permerror: 2, none: 1 };
  let best = results[0];
  for (const r of results) if (rank[r.result] > rank[best.result]) best = r;
  return {
    result: best.result,
    reason: best.reason,
    signatures: results,
    passed: results.filter((r) => r.result === 'pass'),
  };
}

module.exports = {
  verify, verifySignature, splitMessage, parseTagList, stripSignatureValue,
  canonHeaderRelaxed, canonHeaderSimple, canonBodyRelaxed, canonBodySimple,
  publicKeyFromRecord, toCrlf, bytesToStr, strToBytes,
};
