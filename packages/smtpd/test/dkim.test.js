'use strict';
// DKIM tests.
//
// The important ones are at the top: five REAL messages that travelled the
// public internet (public mailing-list archives), verified against the DKIM
// public keys their senders actually publish. The keys are snapshotted in
// fixtures/dkim-dns-snapshot.json so the suite is deterministic offline; set
// MAILMINT_LIVE_DNS=1 to re-verify against live DNS instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dkim = require('../src/auth/dkim');
const { DnsClient } = require('../src/auth/dns');
const { sign, makeKey } = require('./dkim-sign');

const FIX = path.join(__dirname, 'fixtures');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(FIX, 'dkim-dns-snapshot.json'), 'utf8'));
const LIVE = process.env.MAILMINT_LIVE_DNS === '1';

// RFC 6376 Appendix C prints this key pair in full; it exists to be used in
// examples and is not a secret belonging to anybody.
const RFC6376_PUBKEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDwIRP/UC3SBsEmGqZ9ZJW3/DkM' +
  'oGeLnQg1fWn7/zYtIxN2SnFCjxOCKG9v3b4jYfcTNh5ijSsq631uBItLa7od+v/R' +
  'tdC2UzJ1lWT947qR+Rcac2gbto/NMqJ0fzfVjH4OuKhitdY9tf6mcwGjaNBcWToI' +
  'MmPSPDdQPNUYckcQ2QIDAQAB';
const RFC6376_PRIVKEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIICXwIBAAKBgQDwIRP/UC3SBsEmGqZ9ZJW3/DkMoGeLnQg1fWn7/zYtIxN2SnFC',
  'jxOCKG9v3b4jYfcTNh5ijSsq631uBItLa7od+v/RtdC2UzJ1lWT947qR+Rcac2gb',
  'to/NMqJ0fzfVjH4OuKhitdY9tf6mcwGjaNBcWToIMmPSPDdQPNUYckcQ2QIDAQAB',
  'AoGBALmn+XwWk7akvkUlqb+dOxyLB9i5VBVfje89Teolwc9YJT36BGN/l4e0l6QX',
  '/1//6DWUTB3KI6wFcm7TWJcxbS0tcKZX7FsJvUz1SbQnkS54DJck1EZO/BLa5ckJ',
  'gAYIaqlA9C0ZwM6i58lLlPadX/rtHb7pWzeNcZHjKrjM461ZAkEA+itss2nRlmyO',
  'n1/5yDyCluST4dQfO8kAB3toSEVc7DeFeDhnC1mZdjASZNvdHS4gbLIA1hUGEF9m',
  '3hKsGUMMPwJBAPW5v/U+AWTADFCS22t72NUurgzeAbzb1HWMqO4y4+9Hpjk5wvL/',
  'eVYizyuce3/fGke7aRYw/ADKygMJdW8H/OcCQQDz5OQb4j2QDpPZc0Nc4QlbvMsj',
  '7p7otWRO5xRa6SzXqqV3+F0VpqvDmshEBkoCydaYwc2o6WQ5EBmExeV8124XAkEA',
  'qZzGsIxVP+sEVRWZmW6KNFSdVUpk3qzK0Tz/WjQMe5z0UunY9Ax9/4PVhp/j61bf',
  'eAYXunajbBSOLlx4D+TunwJBANkPI5S9iylsbLs6NkaMHV6k5ioHBBmgCak95JGX',
  'GMot/L2x0IYyMLAz6oLWh2hm7zwtb0CgOrPo1ke44hFYnfc=',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

function dnsFor(extra) {
  if (LIVE && !extra) return new DnsClient();
  return new DnsClient({ stub: { ...SNAPSHOT, ...(extra || {}) } });
}

const REAL = [
  ['real-gmail-relaxed-relaxed.eml', 'gmail.com', 'relaxed/relaxed', 'rsa-sha256'],
  ['real-fastmail-relaxed-relaxed.eml', 'fastmail.com', 'relaxed/relaxed', 'rsa-sha256'],
  ['real-gmx-relaxed-relaxed.eml', 'gmx.de', 'relaxed/relaxed', 'rsa-sha256'],
  ['real-peff-relaxed-header-only.eml', 'peff.net', 'relaxed', 'rsa-sha256'],
  ['real-80x24-relaxed-simple.eml', '80x24.org', 'relaxed/simple', 'rsa-sha256'],
];

// ------------------------------------------------------------- real mail ----

for (const [file, domain, canon, alg] of REAL) {
  test(`REAL signature verifies: ${file} (d=${domain}, c=${canon})`, async () => {
    const raw = fs.readFileSync(path.join(FIX, file));
    const r = await dkim.verify(raw, { dns: dnsFor(), ignoreExpiry: true });
    assert.strictEqual(r.result, 'pass', r.reason || '');
    const s = r.signatures[0];
    assert.strictEqual(s.domain, domain);
    assert.strictEqual(s.canonicalization, canon);
    assert.strictEqual(s.algorithm, alg);
    assert.strictEqual(s.bodyHashMatched, true);
    assert.ok(s.keyBits >= 1024, `expected a real key, got ${s.keyBits} bits`);
  });
}

test('REAL signature: one flipped body byte breaks the body hash', async () => {
  const raw = Buffer.from(fs.readFileSync(path.join(FIX, 'real-gmail-relaxed-relaxed.eml')));
  const sep = raw.indexOf('\r\n\r\n');
  const at = sep + 200;
  raw[at] = raw[at] === 0x61 ? 0x62 : 0x61;
  const r = await dkim.verify(raw, { dns: dnsFor(), ignoreExpiry: true });
  assert.strictEqual(r.result, 'fail');
  assert.match(r.reason, /body hash mismatch/);
});

test('REAL signature: a rewritten signed header breaks the signature', async () => {
  let raw = fs.readFileSync(path.join(FIX, 'real-80x24-relaxed-simple.eml')).toString('latin1');
  raw = raw.replace(/^Subject: .*$/m, 'Subject: an attacker changed this');
  const r = await dkim.verify(Buffer.from(raw, 'latin1'), { dns: dnsFor(), ignoreExpiry: true });
  assert.strictEqual(r.result, 'fail');
  assert.match(r.reason, /did not verify|body hash/);
});

test('REAL signature: a revoked key (empty p=) is a fail, not a pass', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'real-gmail-relaxed-relaxed.eml'));
  const r = await dkim.verify(raw, {
    dns: new DnsClient({ stub: { 'TXT:20251104._domainkey.gmail.com': [['v=DKIM1; k=rsa; p=']] } }),
    ignoreExpiry: true,
  });
  assert.strictEqual(r.result, 'fail');
});

test('REAL signature: a missing key record is a permerror', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'real-gmail-relaxed-relaxed.eml'));
  const r = await dkim.verify(raw, { dns: new DnsClient({ stub: {} }), ignoreExpiry: true });
  assert.strictEqual(r.result, 'permerror');
});

test('REAL signature: a DNS SERVFAIL is a temperror, so we can retry later', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'real-gmail-relaxed-relaxed.eml'));
  const r = await dkim.verify(raw, {
    dns: new DnsClient({ stub: { 'TXT:20251104._domainkey.gmail.com': 'ESERVFAIL' } }),
    ignoreExpiry: true,
  });
  assert.strictEqual(r.result, 'temperror');
});

// ------------------------------------------------------------ RFC vectors ---

const RFC8463_KEYS = {
  'TXT:brisbane._domainkey.football.example.com': [[
    'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=']],
  'TXT:test._domainkey.football.example.com': [[
    'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWRiGs5V6NpP3idY6' +
    'Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutACDfzwQ/BC/e/8uBsCR+yz1Lxj+PL6' +
    'lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3Ip3G+2kryOTIKT+l/K4w3QIDAQAB']],
};

test('RFC 8463 A.3: the published RSA signature verifies (h= repeats a header name)', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'rfc8463-ed25519.eml'));
  const r = await dkim.verify(raw, { dns: new DnsClient({ stub: RFC8463_KEYS }), ignoreExpiry: true });
  const rsa = r.signatures.find((s) => s.algorithm === 'rsa-sha256');
  assert.strictEqual(rsa.result, 'pass', rsa.reason || '');
  // h= is "from : to : subject : date : message-id : from : subject : date" — the
  // repeated names must resolve to "no such further occurrence", contributing nothing.
  assert.match(rsa.headers, /from : to : subject : date : message-id : from : subject : date/);
});

test('RFC 8463 A.3: the published ed25519 b= does NOT match (known RFC erratum)', async () => {
  // Documented deliberately. The RSA signature over the identical header set in
  // the same example verifies, so the canonicalisation is not in question; the
  // ed25519 b= printed in the RFC simply is not a signature over that message.
  const raw = fs.readFileSync(path.join(FIX, 'rfc8463-ed25519.eml'));
  const r = await dkim.verify(raw, { dns: new DnsClient({ stub: RFC8463_KEYS }), ignoreExpiry: true });
  const ed = r.signatures.find((s) => s.algorithm === 'ed25519-sha256');
  assert.strictEqual(ed.result, 'fail');
  assert.strictEqual(ed.bodyHashMatched, true, 'the body hash in the RFC IS correct');
});

test('ed25519-sha256 verifies with the RFC 8463 key pair when the signature is real', async () => {
  // Sign the RFC's own message with the RFC's own ed25519 private key
  // (RFC 8032 §7.1 test 1) and verify against the RFC's published p=.
  const seed = Buffer.from('nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=', 'base64');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  const original = fs.readFileSync(path.join(FIX, 'rfc8463-ed25519.eml')).toString('latin1');
  const body = original.slice(original.indexOf('From: Joe SixPack'));

  const signed = sign(Buffer.from(body, 'latin1'), {
    privateKey,
    algorithm: 'ed25519-sha256',
    domain: 'football.example.com',
    selector: 'brisbane',
    canonicalization: 'relaxed/relaxed',
    headers: ['from', 'to', 'subject', 'date', 'message-id'],
  });
  const r = await dkim.verify(signed, { dns: new DnsClient({ stub: RFC8463_KEYS }), ignoreExpiry: true });
  assert.strictEqual(r.result, 'pass', r.reason || '');
  assert.strictEqual(r.signatures[0].algorithm, 'ed25519-sha256');
});

// ------------------------------------------------- canonicalisation units ---

// RFC 6376 §3.4.5 "Canonicalization Examples (INFORMATIVE)" prints the exact
// expected output for one input in all three combinations. This is the check a
// sign-then-verify round trip cannot make: a round trip only proves that our
// canonicaliser agrees with itself, and a canonicaliser that is wrong in the
// same way on both sides passes it happily. These bytes come from the RFC.
//
//   A: <SP> X <CRLF>
//   B <SP> : <SP> Y <HTAB><CRLF>
//   <HTAB> Z <SP><SP><CRLF>
//   <CRLF>
//   <SP> C <SP><CRLF>
//   D <SP><HTAB><SP> E <CRLF>
//   <CRLF>
//   <CRLF>
const RFC6376_INPUT =
  'A: X\r\n' +
  'B : Y\t\r\n' +
  '\tZ  \r\n' +
  '\r\n' +
  ' C \r\n' +
  'D \t E\r\n' +
  '\r\n' +
  '\r\n';

test('RFC 6376 §3.4.5 example 1: relaxed header AND relaxed body', () => {
  const p = dkim.splitMessage(RFC6376_INPUT);
  assert.strictEqual(
    p.headers.map((h) => dkim.canonHeaderRelaxed(h)).join(''),
    'a:X\r\nb:Y Z\r\n');
  assert.strictEqual(dkim.canonBodyRelaxed(p.body), ' C\r\nD E\r\n');
});

test('RFC 6376 §3.4.5 example 2: simple header AND simple body', () => {
  const p = dkim.splitMessage(RFC6376_INPUT);
  assert.strictEqual(
    p.headers.map((h) => dkim.canonHeaderSimple(h)).join(''),
    'A: X\r\nB : Y\t\r\n\tZ  \r\n');
  assert.strictEqual(dkim.canonBodySimple(p.body), ' C \r\nD \t E\r\n');
});

test('RFC 6376 §3.4.5 example 3: relaxed header, simple body', () => {
  const p = dkim.splitMessage(RFC6376_INPUT);
  assert.strictEqual(
    p.headers.map((h) => dkim.canonHeaderRelaxed(h)).join(''),
    'a:X\r\nb:Y Z\r\n');
  assert.strictEqual(dkim.canonBodySimple(p.body), ' C \r\nD \t E\r\n');
});

test('RFC 6376 §3.4.3: the simple body edge cases the RFC spells out', () => {
  assert.strictEqual(dkim.canonBodySimple(''), '\r\n', 'an empty body is a single CRLF');
  assert.strictEqual(dkim.canonBodyRelaxed(''), '', 'relaxed canonicalises an empty body to nothing');
  assert.strictEqual(dkim.canonBodySimple('no trailing crlf'), 'no trailing crlf\r\n');
});

// ---- RFC 6376 Appendix A.2 -------------------------------------------------
// The worked example. Its printed body hash is an authoritative external check
// on our body canonicalisation — and it also catches a defect in the RFC.
test('RFC 6376 A.2: our RELAXED body canonicalisation reproduces the printed bh exactly', () => {
  const raw = fs.readFileSync(path.join(FIX, 'rfc6376-a2.eml'));
  const p = dkim.splitMessage(raw);
  const bh = crypto.createHash('sha256')
    .update(dkim.strToBytes(dkim.canonBodyRelaxed(p.body))).digest('base64');
  assert.strictEqual(bh, '2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=',
    'this value is printed in RFC 6376 A.2 and again in RFC 8463 A.3');
});

test('RFC 6376 A.2: the example declares c=simple/simple but publishes the RELAXED body hash', () => {
  // Not our bug, and worth pinning so nobody "fixes" the canonicaliser to match
  // a broken example. The body contains "game.<SP><SP>Are": simple keeps both
  // spaces, relaxed collapses them, so the two hashes MUST differ — and the one
  // the RFC prints under c=simple/simple is the relaxed one.
  const raw = fs.readFileSync(path.join(FIX, 'rfc6376-a2.eml'));
  const p = dkim.splitMessage(raw);
  assert.ok(p.body.includes('game.  Are'), 'the double space is what makes the two forms differ');

  const simple = crypto.createHash('sha256')
    .update(dkim.strToBytes(dkim.canonBodySimple(p.body))).digest('base64');
  const relaxed = crypto.createHash('sha256')
    .update(dkim.strToBytes(dkim.canonBodyRelaxed(p.body))).digest('base64');
  assert.notStrictEqual(simple, relaxed);
  assert.strictEqual(relaxed, '2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=');
  assert.strictEqual(simple, '4bLNXImK9drULnmePzZNEBleUanJCX5PIsDIFoH4KTQ=');
});

test('RFC 6376 A.2: the published signature therefore cannot verify, and we say why precisely', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'rfc6376-a2.eml'));
  // The key pair is printed in RFC 6376 Appendix C.
  const r = await dkim.verify(raw, {
    dns: new DnsClient({ stub: { 'TXT:brisbane._domainkey.example.com': [[`v=DKIM1; k=rsa; p=${RFC6376_PUBKEY}`]] } }),
    ignoreExpiry: true,
  });
  assert.strictEqual(r.result, 'fail');
  assert.strictEqual(r.failureType, 'body_hash');
  assert.match(r.reason, /body altered after signing/);
});

test('RFC 6376 Appendix C: signing A.2 properly with the RFC key pair does verify', async () => {
  // Proves the key material and our header canonicalisation are right; only the
  // RFC's own b= is wrong.
  const raw = fs.readFileSync(path.join(FIX, 'rfc6376-a2.eml')).toString('latin1');
  const body = raw.slice(raw.indexOf('Received: from client1'));
  const privateKey = crypto.createPrivateKey(RFC6376_PRIVKEY);
  const signed = sign(Buffer.from(body, 'latin1'), {
    privateKey, domain: 'example.com', selector: 'brisbane',
    canonicalization: 'simple/simple',
    headers: ['received', 'from', 'to', 'subject', 'date', 'message-id'],
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({ stub: { 'TXT:brisbane._domainkey.example.com': [[`v=DKIM1; k=rsa; p=${RFC6376_PUBKEY}`]] } }),
  });
  assert.strictEqual(r.result, 'pass', r.reason || '');
  assert.strictEqual(r.signatures[0].keyBits, 1024);
});

test('stripSignatureValue empties b= and leaves every other tag alone', () => {
  const raw = 'DKIM-Signature: v=1; a=rsa-sha256; d=x.com;\r\n\tb=AAAA\r\n\tBBBB; s=sel\r\n';
  const out = dkim.stripSignatureValue(raw);
  assert.ok(out.includes('b=;'), out);
  assert.ok(out.includes('s=sel'));
  assert.ok(!out.includes('AAAA'));
});

test('stripSignatureValue handles b= as the last tag with no trailing semicolon', () => {
  const raw = 'DKIM-Signature: v=1; d=x.com; b=AAAABBBB\r\n';
  const out = dkim.stripSignatureValue(raw);
  assert.strictEqual(out, 'DKIM-Signature: v=1; d=x.com; b=\r\n');
});

// ----------------------------------------------------- round-trip signing ---
//
// HONEST LIMIT OF WHAT FOLLOWS: signing with our own signer and verifying with
// our own verifier proves only that the two agree with each other. A
// canonicaliser that is wrong in the SAME way on both sides sails through every
// test below. These exist to cover combinations that are rare in the wild
// (simple/simple, ed25519, l=) and to prove that tampering is detected — not to
// prove correctness. Correctness is established above, by the five real
// signatures verified against the keys their senders publish, and by the
// RFC 6376 §3.4.5 and RFC 8463 A.3 vectors, which come from outside this repo.

const MSG =
  'From: Alice <alice@example.test>\r\n' +
  'To: Bob <bob@example.test>\r\n' +
  'Subject: canonicalisation round trip\r\n' +
  'Date: Tue, 25 Aug 2026 09:14:01 +0000\r\n' +
  'Message-ID: <round-trip@example.test>\r\n' +
  '\r\n' +
  'Line with trailing spaces   \r\n' +
  'Line\twith\ttabs\r\n' +
  '\r\n' +
  'Last line.\r\n\r\n\r\n';

for (const canon of ['relaxed/relaxed', 'simple/simple', 'relaxed/simple', 'simple/relaxed']) {
  test(`round trip with c=${canon} (rsa-sha256)`, async () => {
    const key = makeKey('rsa', 2048);
    const signed = sign(Buffer.from(MSG, 'latin1'), {
      privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
      canonicalization: canon,
    });
    const dnsStub = { 'TXT:sel._domainkey.example.test': [[key.txt]] };
    const r = await dkim.verify(signed, { dns: new DnsClient({ stub: dnsStub }) });
    assert.strictEqual(r.result, 'pass', r.reason || '');
    assert.strictEqual(r.signatures[0].canonicalization, canon);
  });
}

test('round trip with a freshly generated ed25519 key', async () => {
  const key = makeKey('ed25519');
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, algorithm: 'ed25519-sha256',
    domain: 'example.test', selector: 'ed', canonicalization: 'relaxed/relaxed',
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({ stub: { 'TXT:ed._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'pass', r.reason || '');
  assert.strictEqual(r.signatures[0].keyBits, 256);
});

test('simple body canonicalisation notices a single appended space', async () => {
  const key = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    canonicalization: 'simple/simple',
  });
  const tampered = Buffer.from(signed.toString('latin1').replace('Last line.', 'Last line. '), 'latin1');
  const r = await dkim.verify(tampered, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'fail');
});

test('relaxed body canonicalisation ignores that same trailing space', async () => {
  const key = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    canonicalization: 'relaxed/relaxed',
  });
  const tampered = Buffer.from(signed.toString('latin1').replace('Last line.\r\n', 'Last line.  \r\n'), 'latin1');
  const r = await dkim.verify(tampered, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'pass', r.reason || '');
});

test('l= only covers the prefix it claims', async () => {
  const key = makeKey('rsa', 2048);
  const body = dkim.canonBodyRelaxed(dkim.splitMessage(MSG).body);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    canonicalization: 'relaxed/relaxed', length: body.length,
  });
  const withExtra = Buffer.concat([signed, Buffer.from('appended by a list server\r\n', 'latin1')]);
  const dnsStub = { 'TXT:sel._domainkey.example.test': [[key.txt]] };
  const r = await dkim.verify(withExtra, { dns: new DnsClient({ stub: dnsStub }) });
  assert.strictEqual(r.result, 'pass', 'text appended after l= must not break the signature');
  assert.strictEqual(r.signatures[0].lengthLimited, true,
    'the verifier must report that it only hashed the l= prefix');
});

// ---------------------------------------------------------------- policy ----

test('a signature whose h= omits From is rejected outright', async () => {
  const key = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    headers: ['to', 'subject'],
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'permerror');
  assert.match(r.reason, /does not cover From/);
});

test('an expired signature (x= in the past) fails', async () => {
  const key = makeKey('rsa', 2048);
  const now = Math.floor(Date.now() / 1000);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    t: now - 7200, x: now - 3600,
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'fail');
  assert.match(r.reason, /expired/);
});

test('i= outside d= is a permerror (a classic spoofing attempt)', async () => {
  const key = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    identity: '@evil.test',
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'permerror');
  assert.match(r.reason, /not within/);
});

test('a message with no DKIM-Signature is "none", not "fail"', async () => {
  const r = await dkim.verify(Buffer.from(MSG, 'latin1'), { dns: new DnsClient({ stub: {} }) });
  assert.strictEqual(r.result, 'none');
  assert.deepStrictEqual(r.signatures, []);
});

test('with several signatures the best result wins and every one is reported', async () => {
  const good = makeKey('rsa', 2048);
  const bad = makeKey('rsa', 2048);
  let signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: good.privateKey, domain: 'example.test', selector: 'good',
  });
  signed = sign(signed, { privateKey: bad.privateKey, domain: 'other.test', selector: 'bad' });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({
      stub: {
        'TXT:good._domainkey.example.test': [[good.txt]],
        // publish the WRONG key for the second signer
        'TXT:bad._domainkey.other.test': [[good.txt]],
      },
    }),
  });
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.signatures.length, 2);
  assert.strictEqual(r.passed.length, 1);
  assert.strictEqual(r.passed[0].domain, 'example.test');
});

test('splitMessage: folded headers stay one field, and CRLF-less input is tolerated', () => {
  const p = dkim.splitMessage('A: one\r\n  continued\r\nB: two\r\n\r\nbody');
  assert.strictEqual(p.headers.length, 2);
  assert.strictEqual(p.headers[0].raw, 'A: one\r\n  continued\r\n');
  assert.strictEqual(p.body, 'body');
});

test('toCrlf normalises LF and CR endings without doubling existing CRLF', () => {
  assert.strictEqual(dkim.toCrlf('a\nb\r\nc\rd').toString(), 'a\r\nb\r\nc\r\nd');
});

// --------------------------------------------------- why a signature failed ---
//
// "The body changed after signing" and "this signature is forged" are different
// statements about the world. Mailing lists, forwarders and corporate security
// gateways rewrite bodies constantly, so the first one is routine; the second
// one is somebody claiming a domain they cannot sign for.

test('a body-hash failure is reported as body_altered, not as a bad signature', async () => {
  const key = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: key.privateKey, domain: 'example.test', selector: 'sel',
    canonicalization: 'relaxed/simple',
  });
  // what a mailing list does: append a footer
  const listed = Buffer.concat([signed, Buffer.from('--\r\nSent via example-list\r\n', 'latin1')]);
  const r = await dkim.verify(listed, {
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[key.txt]] } }),
  });
  assert.strictEqual(r.result, 'fail');
  assert.strictEqual(r.failureType, 'body_hash');
  assert.strictEqual(r.bodyAltered, true);
  assert.strictEqual(r.signatures[0].bodyHashMatched, false);
  assert.match(r.reason, /body altered after signing/);
});

test('a forged signature is reported as a signature failure, NOT as body_altered', async () => {
  const real = makeKey('rsa', 2048);
  const other = makeKey('rsa', 2048);
  const signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: other.privateKey, domain: 'example.test', selector: 'sel',
  });
  const r = await dkim.verify(signed, {
    // the domain publishes a DIFFERENT key from the one that signed
    dns: new DnsClient({ stub: { 'TXT:sel._domainkey.example.test': [[real.txt]] } }),
  });
  assert.strictEqual(r.result, 'fail');
  assert.strictEqual(r.failureType, 'signature');
  assert.strictEqual(r.bodyAltered, false, 'the body was fine; the signature was not');
  assert.strictEqual(r.signatures[0].bodyHashMatched, true);
});

test('a revoked key is a key failure, and a dead resolver is a dns failure', async () => {
  const raw = fs.readFileSync(path.join(FIX, 'real-gmail-relaxed-relaxed.eml'));
  const revoked = await dkim.verify(raw, {
    dns: new DnsClient({ stub: { 'TXT:20251104._domainkey.gmail.com': [['v=DKIM1; k=rsa; p=']] } }),
    ignoreExpiry: true,
  });
  assert.strictEqual(revoked.failureType, 'key');
  assert.strictEqual(revoked.bodyAltered, false);

  const broken = await dkim.verify(raw, {
    dns: new DnsClient({ stub: { 'TXT:20251104._domainkey.gmail.com': 'ESERVFAIL' } }),
    ignoreExpiry: true,
  });
  assert.strictEqual(broken.result, 'temperror');
  assert.strictEqual(broken.failureType, 'dns');
});

test('when one of two signers still verifies, body_altered stays false', async () => {
  const good = makeKey('rsa', 2048);
  const bad = makeKey('rsa', 2048);
  let signed = sign(Buffer.from(MSG, 'latin1'), {
    privateKey: good.privateKey, domain: 'example.test', selector: 'good',
    canonicalization: 'relaxed/relaxed',
  });
  signed = sign(signed, {
    privateKey: bad.privateKey, domain: 'other.test', selector: 'bad',
    canonicalization: 'relaxed/simple',
  });
  const r = await dkim.verify(signed, {
    dns: new DnsClient({
      stub: {
        'TXT:good._domainkey.example.test': [[good.txt]],
        'TXT:bad._domainkey.other.test': [[good.txt]],   // wrong key for the 2nd signer
      },
    }),
  });
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.bodyAltered, false);
});

test('spam scoring does not charge for a body-hash failure, but does for a forged one', () => {
  const { score } = require('../src/auth/spam');
  const base = { headers: [], body: '', envelope: { tls: true, helo: 'mail.acme.com', from: 'a@acme.com' } };
  const forwarded = score({ ...base, auth: { spf: 'pass', dkim: 'fail', dkimBodyAltered: true, dmarc: 'pass' } });
  const forged = score({ ...base, auth: { spf: 'pass', dkim: 'fail', dkimFailureType: 'signature', dmarc: 'pass' } });
  assert.ok(forged.score > forwarded.score,
    'a forged signature must cost more than a forwarded message');
  assert.ok(!forwarded.reasons.some((r) => r.rule === 'dkim=fail'),
    'forwarding must not be charged as spam');
});
