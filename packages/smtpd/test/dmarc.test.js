'use strict';
const test = require('node:test');
const assert = require('node:assert');

const dmarc = require('../src/auth/dmarc');
const { orgDomain } = require('../src/auth/psl');
const { DnsClient } = require('../src/auth/dns');
const { authenticate } = require('../src/auth');

const dns = (stub) => new DnsClient({ stub });
const txt = (...r) => r.map((x) => [x]);

test('orgDomain: plain, multi-label public suffixes and hosting suffixes', () => {
  assert.strictEqual(orgDomain('mail.example.com'), 'example.com');
  assert.strictEqual(orgDomain('example.com'), 'example.com');
  assert.strictEqual(orgDomain('a.b.c.example.co.uk'), 'example.co.uk');
  assert.strictEqual(orgDomain('shop.example.com.au'), 'example.com.au');
  assert.strictEqual(orgDomain('deep.sub.pages.dev'), 'sub.pages.dev');
  assert.strictEqual(orgDomain('localhost'), 'localhost');
});

test('alignment: relaxed matches the organisational domain, strict does not', () => {
  assert.ok(dmarc.aligned('mail.acme.com', 'acme.com', 'r'));
  assert.ok(!dmarc.aligned('mail.acme.com', 'acme.com', 's'));
  assert.ok(dmarc.aligned('acme.com', 'acme.com', 's'));
  assert.ok(!dmarc.aligned('acme-evil.com', 'acme.com', 'r'));
});

test('DMARC pass via an aligned DKIM signature', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'fail', domain: 'bounces.mailer.net' },
    dkim: { result: 'pass', signatures: [{ result: 'pass', domain: 'acme.com' }] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject; rua=mailto:x@acme.com') }),
  });
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.policy, 'reject');
  assert.strictEqual(r.alignment.dkim, true);
  assert.strictEqual(r.alignment.spf, false);
});

test('DMARC pass via an aligned SPF pass', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'pass', domain: 'mail.acme.com' },
    dkim: { result: 'none', signatures: [] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=quarantine') }),
  });
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.alignment.spf, true);
});

test('aspf=s rejects a subdomain SPF pass that relaxed alignment would accept', async () => {
  const base = {
    fromDomain: 'acme.com',
    spf: { result: 'pass', domain: 'mail.acme.com' },
    dkim: { result: 'none', signatures: [] },
  };
  const relaxed = await dmarc.evaluate({
    ...base, dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject; aspf=r') }),
  });
  const strict = await dmarc.evaluate({
    ...base, dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject; aspf=s') }),
  });
  assert.strictEqual(relaxed.result, 'pass');
  assert.strictEqual(strict.result, 'fail');
  assert.strictEqual(strict.disposition, 'reject');
});

test('adkim=s rejects a subdomain DKIM d=', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'none', domain: null },
    dkim: { result: 'pass', signatures: [{ result: 'pass', domain: 'mail.acme.com' }] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=none; adkim=s') }),
  });
  assert.strictEqual(r.result, 'fail');
  assert.strictEqual(r.disposition, 'none', 'p=none means no action, but still a fail');
});

test('a DKIM signature that FAILED cannot make DMARC pass, however well aligned', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'none', domain: null },
    dkim: { result: 'fail', signatures: [{ result: 'fail', domain: 'acme.com' }] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject') }),
  });
  assert.strictEqual(r.result, 'fail');
});

test('the organisational-domain fallback is used, and sp= then applies', async () => {
  const stub = { 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject; sp=quarantine') };
  const r = await dmarc.evaluate({
    fromDomain: 'news.acme.com',
    spf: { result: 'fail', domain: 'evil.net' },
    dkim: { result: 'none', signatures: [] },
    dns: dns(stub),
  });
  assert.strictEqual(r.policyDomain, 'acme.com');
  assert.strictEqual(r.policy, 'quarantine', 'sp= governs subdomains');
  assert.strictEqual(r.disposition, 'quarantine');
});

test('no DMARC record anywhere is "none"', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'nowhere.test',
    spf: { result: 'fail', domain: 'x' },
    dkim: { result: 'none', signatures: [] },
    dns: dns({}),
  });
  assert.strictEqual(r.result, 'none');
  assert.strictEqual(r.policy, null);
});

test('two DMARC records mean no usable policy', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'pass', domain: 'acme.com' },
    dkim: { result: 'none', signatures: [] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject', 'v=DMARC1; p=none') }),
  });
  assert.strictEqual(r.result, 'none');
});

test('a DNS failure is a temperror, never a silent pass', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com',
    spf: { result: 'pass', domain: 'acme.com' },
    dkim: { result: 'none', signatures: [] },
    dns: dns({ 'TXT:_dmarc.acme.com': 'ESERVFAIL' }),
  });
  assert.strictEqual(r.result, 'temperror');
});

test('more than one From: address cannot be evaluated and is a fail', async () => {
  const r = await dmarc.evaluate({
    fromDomain: 'acme.com', fromCount: 2,
    spf: { result: 'pass', domain: 'acme.com' },
    dkim: { result: 'pass', signatures: [{ result: 'pass', domain: 'acme.com' }] },
    dns: dns({ 'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject') }),
  });
  assert.strictEqual(r.result, 'fail');
  assert.match(r.reason, /multiple From/);
});

// ------------------------------------------------ the whole auth pipeline ---

test('authenticate() produces the CONTRACT §1 auth block and the §4 flags', async () => {
  const raw = Buffer.from(
    'From: Acme Billing <billing@acme.com>\r\n' +
    'To: <k7m2xq4h9bwz@parse.example.com>\r\n' +
    'Subject: Invoice\r\n' +
    'Date: Tue, 25 Aug 2026 09:14:01 +0000\r\n' +
    'Message-ID: <1@acme.com>\r\n\r\n' +
    'Total: $31.50\r\n', 'utf8');

  const stub = {
    'TXT:acme.com': txt('v=spf1 ip4:192.0.2.0/24 -all'),
    'TXT:_dmarc.acme.com': txt('v=DMARC1; p=reject'),
  };
  const good = await authenticate(raw, {
    from: 'billing@acme.com', to: [], helo: 'mail.acme.com', remote_ip: '192.0.2.9', tls: true,
  }, { dns: dns(stub) });
  assert.deepStrictEqual(Object.keys(good.auth).sort(), ['dkim', 'dmarc', 'spam_score', 'spf']);
  assert.strictEqual(good.auth.spf, 'pass');
  assert.strictEqual(good.auth.dkim, 'none');
  assert.strictEqual(good.auth.dmarc, 'pass');
  assert.strictEqual(typeof good.auth.spam_score, 'number');
  assert.deepStrictEqual(good.flags, []);

  const forged = await authenticate(raw, {
    from: 'billing@acme.com', to: [], helo: 'evil.example', remote_ip: '203.0.113.9', tls: false,
  }, { dns: dns(stub) });
  assert.strictEqual(forged.auth.spf, 'fail');
  assert.strictEqual(forged.auth.dmarc, 'fail');
  assert.ok(forged.flags.includes('auth_fail:spf'));
  assert.ok(forged.flags.includes('auth_fail:dmarc'));
  assert.ok(forged.auth.spam_score > good.auth.spam_score,
    'a DMARC-reject failure must score worse than a clean pass');
});

test('authenticate() survives a message with no headers at all', async () => {
  const r = await authenticate(Buffer.from('just a body, no headers\r\n'), {
    from: '', to: [], helo: 'x', remote_ip: '1.2.3.4', tls: false,
  }, { dns: dns({}) });
  assert.strictEqual(r.auth.dkim, 'none');
  assert.ok(typeof r.auth.spam_score === 'number');
});

test('LIVE: a real gmail message gets spf/dkim/dmarc all pass', { skip: process.env.MAILMINT_LIVE_DNS !== '1' }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-gmail-relaxed-relaxed.eml'));
  const r = await authenticate(raw, {
    from: 'git+bounces@vger.kernel.org', to: [], helo: 'mail-oi1-f180.google.com',
    remote_ip: '209.85.167.180', tls: true,
  }, {});
  assert.strictEqual(r.auth.dkim, 'pass');
});

test('authenticateWithDeadline degrades to temperror instead of stalling a session', async () => {
  const { authenticateWithDeadline } = require('../src/auth');
  const neverAnswers = {
    txt: () => new Promise(() => {}), a: () => new Promise(() => {}),
    addresses: () => new Promise(() => {}), mx: () => new Promise(() => {}),
    ptr: () => new Promise(() => {}),
  };
  const t0 = Date.now();
  const r = await authenticateWithDeadline(
    Buffer.from('From: <a@b.com>\r\n\r\nbody\r\n'),
    { from: 'a@b.com', helo: 'h', remote_ip: '1.2.3.4', tls: false },
    { dns: neverAnswers, deadlineMs: 300 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `should have given up quickly, took ${ms} ms`);
  assert.deepStrictEqual(r.auth, { spf: 'temperror', dkim: 'temperror', dmarc: 'temperror', spam_score: 0 });
  assert.match(r.details.spf.reason, /budget/);
});
