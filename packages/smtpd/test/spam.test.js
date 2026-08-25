'use strict';
// The spam score is REPORTED, never enforced (CONTRACT §1 / §7). These tests
// pin the ordering — a clean authenticated message must always score below a
// forged one — rather than exact magic numbers.

const test = require('node:test');
const assert = require('node:assert');

const { score } = require('../src/auth/spam');
const { splitMessage } = require('../src/auth/dkim');

function scoreOf(raw, envelope, auth) {
  const p = splitMessage(Buffer.from(raw, 'utf8'));
  return score({ headers: p.headers, body: p.body, envelope, auth });
}

const CLEAN =
  'Message-ID: <clean@acme.com>\r\n' +
  'Date: ' + new Date().toUTCString() + '\r\n' +
  'From: Acme Billing <billing@acme.com>\r\n' +
  'To: <k7m2xq4h9bwz@parse.example.com>\r\n' +
  'Received: from mail.acme.com by mx.mailmint.dev; ' + new Date().toUTCString() + '\r\n' +
  'Subject: Invoice INV-2291\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  '\r\n' +
  'Hello,\r\n\r\nYour invoice INV-2291 for $31.50 is attached.\r\n\r\nAcme Ltd\r\n';

const GOOD_ENV = { from: 'billing@acme.com', helo: 'mail.acme.com', remote_ip: '192.0.2.9', tls: true };
const GOOD_AUTH = { spf: 'pass', dkim: 'pass', dmarc: 'pass', dmarcPolicy: 'reject' };

test('a clean, fully authenticated message scores 0', () => {
  const r = scoreOf(CLEAN, GOOD_ENV, GOOD_AUTH);
  assert.strictEqual(r.score, 0, JSON.stringify(r.reasons));
  assert.strictEqual(r.suspected, false);
});

test('the score is always clamped to 0..10', () => {
  const nightmare =
    'From: PayPal Security paypal@paypal.com <x@free-prize.zip>\r\n' +
    'Subject: URGENT!!! YOU HAVE WON THE LOTTERY - VERIFY YOUR ACCOUNT NOW!!!\r\n' +
    'X-Spam-Flag: YES\r\n' +
    'X-Priority: 1\r\n' +
    'Bcc: everyone@example.com\r\n' +
    '\r\n' +
    'Click here now http://1.2.3.4/steal and http://bit.ly/x to claim your prize.\r\n' +
    'Wire transfer your inheritance beneficiary fund. Confirm your password.\r\n' +
    '<script>steal()</script>\r\n';
  const r = scoreOf(nightmare, { from: 'x@evil.tld', helo: '1.2.3.4', tls: false },
    { spf: 'fail', dkim: 'fail', dmarc: 'fail', dmarcPolicy: 'reject' });
  assert.ok(r.score <= 10 && r.score >= 0);
  assert.strictEqual(r.score, 10);
  assert.strictEqual(r.suspected, true);
});

test('authentication failures dominate the score, as they should', () => {
  const clean = scoreOf(CLEAN, GOOD_ENV, GOOD_AUTH).score;
  const spfFail = scoreOf(CLEAN, GOOD_ENV, { ...GOOD_AUTH, spf: 'fail', dmarc: 'fail' }).score;
  const dmarcReject = scoreOf(CLEAN, GOOD_ENV,
    { spf: 'fail', dkim: 'fail', dmarc: 'fail', dmarcPolicy: 'reject' }).score;
  assert.ok(spfFail > clean);
  assert.ok(dmarcReject > spfFail, `${dmarcReject} should exceed ${spfFail}`);
});

test('a missing Message-ID, a missing Date and a bare-IP HELO all cost points', () => {
  const bare = 'From: <a@b.com>\r\nSubject: hi\r\n\r\nbody\r\n';
  const r = scoreOf(bare, { from: 'a@b.com', helo: '203.0.113.9', tls: false }, GOOD_AUTH);
  const rules = r.reasons.map((x) => x.rule);
  assert.ok(rules.includes('no-message-id'));
  assert.ok(rules.includes('no-date'));
  assert.ok(rules.includes('helo-is-bare-ip'));
  assert.ok(rules.includes('no-tls'));
  assert.ok(rules.includes('no-received-chain'));
});

test('a display name that impersonates a different address is flagged', () => {
  const spoof = CLEAN.replace('From: Acme Billing <billing@acme.com>',
    'From: "security@paypal.com" <attacker@evil.test>');
  const r = scoreOf(spoof, GOOD_ENV, GOOD_AUTH);
  assert.ok(r.reasons.some((x) => x.rule === 'display-name-spoofs-address'), JSON.stringify(r.reasons));
});

test('two From: headers is a strong signal', () => {
  const doubled = CLEAN.replace('From: Acme Billing <billing@acme.com>\r\n',
    'From: Acme Billing <billing@acme.com>\r\nFrom: <someone@else.test>\r\n');
  const r = scoreOf(doubled, GOOD_ENV, GOOD_AUTH);
  assert.ok(r.reasons.some((x) => x.rule === 'multiple-from-headers'));
});

test('a fake "Re:" with no In-Reply-To is noticed', () => {
  const fake = CLEAN.replace('Subject: Invoice INV-2291', 'Subject: Re: your payment');
  const r = scoreOf(fake, GOOD_ENV, GOOD_AUTH);
  assert.ok(r.reasons.some((x) => x.rule === 'fake-reply-subject'));
});

test('an unsubscribe link slightly REDUCES the score of legitimate bulk mail', () => {
  const bulk = CLEAN + '\r\nUnsubscribe: https://acme.com/unsub\r\n';
  const withUnsub = scoreOf(bulk, GOOD_ENV, GOOD_AUTH);
  assert.ok(withUnsub.reasons.some((x) => x.rule === 'body:has-unsubscribe' && x.points < 0));
});

test('the threshold for `spam_suspected` is 6, per CONTRACT §4', () => {
  const near = scoreOf(CLEAN, { from: 'a@b.com', helo: 'x', tls: false },
    { spf: 'fail', dkim: 'fail', dmarc: 'fail', dmarcPolicy: 'none' });
  assert.strictEqual(near.suspected, near.score > 6);
});

test('every reason carries its own point value, so a score can be explained', () => {
  const r = scoreOf(CLEAN, { from: 'a@b.com', helo: 'x', tls: false },
    { spf: 'none', dkim: 'none', dmarc: 'none' });
  assert.ok(r.reasons.length > 0);
  for (const reason of r.reasons) {
    assert.strictEqual(typeof reason.rule, 'string');
    assert.strictEqual(typeof reason.points, 'number');
  }
  const sum = r.reasons.reduce((a, b) => a + b.points, 0);
  assert.ok(Math.abs(sum - r.raw) < 0.02, `${sum} vs ${r.raw}`);
});

test('a huge body does not blow up the scorer', () => {
  const huge = CLEAN + 'x'.repeat(3_000_000);
  const t0 = Date.now();
  const r = scoreOf(huge, GOOD_ENV, GOOD_AUTH);
  assert.ok(Date.now() - t0 < 2000, 'scoring must stay fast on big mail');
  assert.ok(r.score >= 0);
});
