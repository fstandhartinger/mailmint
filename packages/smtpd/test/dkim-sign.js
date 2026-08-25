'use strict';
// A DKIM signer, used only by the tests: it lets us round-trip canonicalisation
// forms that are rare in the wild (simple/simple, ed25519, l=) with freshly
// generated keys, and produce deliberately broken signatures.

const crypto = require('node:crypto');
const dkim = require('../src/auth/dkim');

function canonBody(body, mode) {
  return mode === 'relaxed' ? dkim.canonBodyRelaxed(body) : dkim.canonBodySimple(body);
}
function canonHeader(h, mode) {
  return mode === 'relaxed' ? dkim.canonHeaderRelaxed(h) : dkim.canonHeaderSimple(h);
}

/**
 * @param {Buffer|string} raw   message with CRLF line endings
 * @param {object} o  { privateKey, algorithm, domain, selector, headers, canonicalization, length, t, x, identity }
 * @returns {Buffer} the message with a DKIM-Signature header prepended
 */
function sign(raw, o) {
  const parsed = dkim.splitMessage(raw);
  const algorithm = o.algorithm || 'rsa-sha256';
  const hashAlg = algorithm.endsWith('sha1') ? 'sha1' : 'sha256';
  const [hCanon, bCanon] = (o.canonicalization || 'relaxed/relaxed').split('/');

  let body = canonBody(parsed.body, bCanon);
  const tags = [];
  tags.push(`v=1`, `a=${algorithm}`, `c=${hCanon}/${bCanon}`, `d=${o.domain}`, `s=${o.selector}`);
  if (o.identity) tags.push(`i=${o.identity}`);
  if (o.t !== undefined) tags.push(`t=${o.t}`);
  if (o.x !== undefined) tags.push(`x=${o.x}`);
  if (o.length !== undefined) {
    body = body.slice(0, o.length);
    tags.push(`l=${o.length}`);
  }
  const bh = crypto.createHash(hashAlg).update(dkim.strToBytes(body)).digest('base64');
  const headerNames = o.headers || ['from', 'to', 'subject', 'date', 'message-id'];
  tags.push(`h=${headerNames.join(':')}`);
  tags.push(`bh=${bh}`);

  const unsigned = `DKIM-Signature: ${tags.join('; ')}; b=`;
  const sigHeader = {
    name: 'DKIM-Signature',
    lowerName: 'dkim-signature',
    raw: unsigned + '\r\n',
    value: unsigned.slice(unsigned.indexOf(':') + 1) + '\r\n',
  };

  const used = new Map();
  let signed = '';
  for (const n of headerNames.map((x) => x.toLowerCase())) {
    const matches = parsed.headers.filter((h) => h.lowerName === n);
    const consumed = used.get(n) || 0;
    const idx = matches.length - 1 - consumed;
    used.set(n, consumed + 1);
    if (idx < 0) continue;
    signed += canonHeader(matches[idx], hCanon);
  }
  signed += canonHeader(
    { ...sigHeader, raw: unsigned, value: unsigned.slice(unsigned.indexOf(':') + 1) },
    hCanon).replace(/\r\n$/, '');

  const data = dkim.strToBytes(signed);
  const sig = algorithm.startsWith('ed25519')
    ? crypto.sign(null, data, o.privateKey)
    : crypto.sign(hashAlg, data, o.privateKey);

  const header = `${unsigned}${sig.toString('base64')}\r\n`;
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'latin1')]);
}

/** Generate a key pair plus the DNS TXT record that publishes it. */
function makeKey(type = 'rsa', bits = 2048) {
  if (type === 'ed25519') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const raw = spki.subarray(spki.length - 32);
    return { privateKey, publicKey, txt: `v=DKIM1; k=ed25519; p=${raw.toString('base64')}` };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey, txt: `v=DKIM1; k=rsa; p=${der.toString('base64')}` };
}

module.exports = { sign, makeKey };
