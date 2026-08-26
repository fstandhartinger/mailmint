'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseMessage } = require('..');

/**
 * The inbound pipeline stamps its OWN verdict into the message as an
 * `Authentication-Results` header, because that is what RFC 8601 is for. The
 * parser then used to read that header back and derive auth flags from it —
 * reading our own homework.
 *
 * It matters for exactly one value. RFC 8601 has no `body_altered`, so a
 * forwarded message whose body hash no longer matches is stamped `dkim=fail`,
 * which is correct. Re-deriving from that produced `auth_fail:dkim` sitting next
 * to the `dkim_body_altered` the same message already carried — the headline
 * saying "not a failure" and the flag beside it saying "authentication failed".
 *
 * Found on a real Gmail message delivered over port 25 on 2026-08-26.
 */
const STAMPED = Buffer.from([
  'From: Someone <someone@gmail.com>',
  'To: token@smooth-operator.online',
  'Subject: forwarded invoice',
  'Authentication-Results: mx.example.com;',
  '\tspf=softfail smtp.mailfrom=gmail.com;',
  '\tdkim=fail header.d=gmail.com header.s=20251104;',
  '\tdmarc=fail (p=none) header.from=gmail.com',
  '',
  'Invoice INV-7, total $12.00',
  '',
].join('\r\n'));

test('a supplied verdict wins over the stamped header', async () => {
  const r = await parseMessage(STAMPED, {
    auth: { spf: 'softfail', dkim: 'body_altered', dmarc: 'fail', spam_score: 2.7 },
  });
  assert.ok(!r.flags.includes('auth_fail:dkim'),
    'body_altered must never come back as an authentication failure');
  assert.equal(r.auth.dkim, 'body_altered', 'the supplied verdict is the one reported');
});

test('with no verdict supplied, the header is still the fallback', async () => {
  const r = await parseMessage(STAMPED, {});
  assert.equal(r.auth.dkim, 'fail', 'raw MIME with no verdict still reads the header');
  assert.ok(r.flags.includes('auth_fail:dkim'),
    'and a plain fail there is a real failure');
});

test('a supplied verdict does not invent flags of its own', async () => {
  const r = await parseMessage(STAMPED, {
    auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam_score: 0 },
  });
  assert.deepEqual(r.flags.filter((f) => f.startsWith('auth_fail:')), [],
    'a clean verdict produces no auth failures');
});
