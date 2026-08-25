'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parsePath, splitAddress, routeRecipient, headerFromDomain, headerAddressCount,
} = require('../src/address');

const DOMAINS = ['parse.example.com', 'in.mailmint.dev'];

test('parsePath: plain path', () => {
  const r = parsePath('<a@b.com>');
  assert.strictEqual(r.address, 'a@b.com');
  assert.deepStrictEqual({ ...r.params }, {});
});

test('parsePath: tolerates the space many clients send after the colon', () => {
  assert.strictEqual(parsePath(' <a@b.com>').address, 'a@b.com');
});

test('parsePath: ESMTP parameters', () => {
  const r = parsePath('<a@b.com> SIZE=1234 BODY=8BITMIME SMTPUTF8');
  assert.strictEqual(r.address, 'a@b.com');
  assert.strictEqual(r.params.SIZE, '1234');
  assert.strictEqual(r.params.BODY, '8BITMIME');
  assert.strictEqual(r.params.SMTPUTF8, true);
});

test('parsePath: null reverse-path only when allowed', () => {
  assert.strictEqual(parsePath('<>', { allowNull: true }).address, '');
  assert.strictEqual(parsePath('<>'), null);
});

test('parsePath: source routes are accepted and ignored (RFC 5321 4.1.2)', () => {
  assert.strictEqual(parsePath('<@hop1.net,@hop2.net:real@b.com>').address, 'real@b.com');
});

test('parsePath: quoted local parts survive, including an @ inside quotes', () => {
  assert.strictEqual(parsePath('<"weird@local"@b.com>').address, '"weird@local"@b.com');
  assert.strictEqual(splitAddress('"weird@local"@b.com').local, '"weird@local"');
});

test('parsePath: rubbish is rejected', () => {
  for (const bad of ['a@b.com', '<a@b.com', '<<a@b.com>>', '<unclosed', '']) {
    assert.strictEqual(parsePath(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('routeRecipient: <token>@domain', () => {
  const r = routeRecipient('k7m2xq4h9bwz@parse.example.com', DOMAINS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.token, 'k7m2xq4h9bwz');
  assert.strictEqual(r.slug, null);
  assert.strictEqual(r.tag, null);
});

test('routeRecipient: <slug>.<token>@domain', () => {
  const r = routeRecipient('invoices.k7m2xq4h9bwz@parse.example.com', DOMAINS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.token, 'k7m2xq4h9bwz');
  assert.strictEqual(r.slug, 'invoices');
});

test('routeRecipient: <token>+tag@domain', () => {
  const r = routeRecipient('k7m2xq4h9bwz+sept-2026@parse.example.com', DOMAINS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tag, 'sept-2026');
});

test('routeRecipient: slug + token + tag together', () => {
  const r = routeRecipient('acme-invoices.k7m2xq4h9bwz+x@in.mailmint.dev', DOMAINS);
  assert.deepStrictEqual(
    [r.ok, r.slug, r.token, r.tag],
    [true, 'acme-invoices', 'k7m2xq4h9bwz', 'x']);
});

test('routeRecipient: case-insensitive in local part AND domain', () => {
  const r = routeRecipient('Invoices.K7M2XQ4H9BWZ@Parse.Example.COM', DOMAINS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.token, 'k7m2xq4h9bwz');
  assert.strictEqual(r.address, 'k7m2xq4h9bwz@parse.example.com');
});

test('routeRecipient: Crockford confusables fold (o->0, i/l->1) and never widen the alphabet', () => {
  assert.strictEqual(routeRecipient('k7m2xq4h9bwo@parse.example.com', DOMAINS).token, 'k7m2xq4h9bw0');
  assert.strictEqual(routeRecipient('k7m2xq4h9bwl@parse.example.com', DOMAINS).token, 'k7m2xq4h9bw1');
  // u is NOT a Crockford character and is not folded: it must be rejected
  assert.strictEqual(routeRecipient('k7m2xq4h9buz@parse.example.com', DOMAINS).ok, false);
});

test('routeRecipient: anything that is not a token is refused', () => {
  const bad = [
    'bob@parse.example.com',              // not 12 chars
    'k7m2xq4h9bw@parse.example.com',      // 11 chars
    'k7m2xq4h9bwzz@parse.example.com',    // 13 chars
    'k7m2xq4h9bw!@parse.example.com',     // bad character
    'postmaster@parse.example.com',
    'k7m2xq4h9bwz',                       // no domain
  ];
  for (const a of bad) assert.strictEqual(routeRecipient(a, DOMAINS).ok, false, a);
});

test('routeRecipient: a foreign domain is a relay attempt, not an unknown mailbox', () => {
  const r = routeRecipient('k7m2xq4h9bwz@gmail.com', DOMAINS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'relay');
});

test('routeRecipient: a bad slug is refused rather than silently dropped', () => {
  assert.strictEqual(routeRecipient('bad slug.k7m2xq4h9bwz@parse.example.com', DOMAINS).ok, false);
  assert.strictEqual(routeRecipient('-lead.k7m2xq4h9bwz@parse.example.com', DOMAINS).ok, false);
});

test('splitAddress: SMTPUTF8 addresses parse', () => {
  const r = splitAddress('jörg@exämple.de');
  assert.ok(r);
  assert.strictEqual(r.local, 'jörg');
  assert.strictEqual(r.domain, 'exämple.de');
});

test('splitAddress: address literals are accepted for MAIL FROM', () => {
  assert.deepStrictEqual(splitAddress('a@[192.0.2.1]'), { local: 'a', domain: '[192.0.2.1]' });
});

test('headerFromDomain / headerAddressCount', () => {
  assert.strictEqual(headerFromDomain('Acme Billing <billing@ACME.com>'), 'acme.com');
  assert.strictEqual(headerFromDomain('billing@acme.com'), 'acme.com');
  assert.strictEqual(headerFromDomain('"Comma, Inc" <a@b.co>'), 'b.co');
  assert.strictEqual(headerAddressCount('a <a@b.c>, d <e@f.g>'), 2);
  assert.strictEqual(headerAddressCount('"Comma, Inc" <a@b.co>'), 1);
});
