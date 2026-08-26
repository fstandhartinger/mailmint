'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { verifyRaw, headlineFor } = require('../src/sender-auth');

/**
 * `/v1/parse` used to answer `auth: {spf: null, dkim: null, dmarc: null}` for
 * every request, including messages carrying good signatures. That was not a
 * limit of the input — DKIM needs the message and DNS and nothing else — it was
 * that the verifiers live in the smtpd package and this endpoint never called
 * them, while /docs#auth advertised `auth` as part of the parse output.
 */
const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'forwarded-gmail.eml'));

test('a real signed message gets a DKIM verdict, not null', async () => {
  const a = await verifyRaw(RAW);
  assert.equal(a.dkim, 'body_altered',
    'a forwarded Gmail message is body-altered, which is not a failure');
  assert.equal(a.dkim_details.body_altered, true);
  assert.equal(a.dkim_details.result, 'fail', 'the underlying verifier result is still reported');
  const sig = a.dkim_details.signatures[0];
  assert.equal(sig.domain, 'gmail.com');
  assert.equal(sig.body_hash_matched, false);
  assert.equal(sig.failure_type, 'body_hash', 'nothing but the body hash is wrong');
});

test('SPF and DMARC say "unavailable", never null', async () => {
  const a = await verifyRaw(RAW);
  assert.equal(a.spf, 'unavailable');
  assert.equal(a.dmarc, 'unavailable');
  assert.match(a.reason, /envelope|connecting IP/i,
    'and the response says why, rather than leaving a bare null to be misread as "checked, nothing wrong"');
});

test('an unsigned message is "none", and that is not a failure', async () => {
  const plain = Buffer.from('From: a@b.example\r\nTo: c@d.example\r\nSubject: hi\r\n\r\nbody\r\n');
  const a = await verifyRaw(plain);
  assert.equal(a.dkim, 'none');
});

test('an empty or non-buffer input degrades to unavailable, never throws', async () => {
  for (const input of [null, undefined, '', Buffer.alloc(0), 42]) {
    const a = await verifyRaw(input);
    assert.equal(a.dkim, 'unavailable', `input ${JSON.stringify(input)} must not throw`);
  }
});

test('the headline mapping matches smtpd/src/auth/index.js exactly', () => {
  assert.equal(headlineFor({ result: 'fail', bodyAltered: true }), 'body_altered');
  assert.equal(headlineFor({ result: 'fail', bodyAltered: false }), 'fail');
  assert.equal(headlineFor({ result: 'pass', bodyAltered: false }), 'pass');
  assert.equal(headlineFor({ result: 'none' }), 'none');
});
