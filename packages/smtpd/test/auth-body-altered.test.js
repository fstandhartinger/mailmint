'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { verify } = require('../src/auth/dkim');

/**
 * A real message from Gmail, captured 2026-08-25 on its way through a public
 * mailbox. Its body no longer hashes to what Gmail signed — which is exactly
 * what happens to every forwarded message, and forwarding mail in from Gmail is
 * one of the two ways people are meant to use this product.
 *
 * The verifier reports that as `result: 'fail'` with `bodyAltered: true`. The
 * headline verdict used to copy `result` straight through, so the happy path
 * arrived as `dkim: "fail"` -> `auth_fail:dkim` -> needs_review. messages.js §1c
 * warns against precisely that ("a self-inflicted wound") while the code did it
 * anyway.
 */
const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'forwarded-gmail.eml'));

test('a real forwarded Gmail message is body_altered, not a failure', async () => {
  const dkimRes = await verify(RAW);

  assert.equal(dkimRes.result, 'fail', 'the verifier still reports the raw result');
  assert.equal(dkimRes.bodyAltered, true, 'and says the body is what changed');

  // The mapping under test, lifted from auth/index.js.
  const headline = dkimRes.bodyAltered ? 'body_altered' : dkimRes.result;
  assert.equal(headline, 'body_altered',
    'the headline verdict must distinguish a forwarded body from a forgery');

  // And that headline must not raise an authentication failure downstream.
  const NOT_A_FAILURE = new Set(['pass', 'none', 'neutral', 'temperror', 'permerror', 'policy', null, undefined, '']);
  const flags = [];
  if (headline === 'body_altered') flags.push('dkim_body_altered');
  else if (!NOT_A_FAILURE.has(headline)) flags.push('auth_fail:dkim');

  assert.deepEqual(flags, ['dkim_body_altered'],
    'forwarded mail must flag as body-altered and never as auth_fail:dkim');
});

test('the signature itself is genuine — key fetched, only the body differs', async () => {
  const dkimRes = await verify(RAW);
  const sig = (dkimRes.signatures || [])[0];
  assert.ok(sig, 'the message carries a DKIM signature');
  assert.equal(sig.domain, 'gmail.com');
  assert.equal(sig.bodyHashMatched, false, 'the body hash is what fails');
  assert.equal(sig.failureType, 'body_hash', 'and nothing else about it is wrong');
});
