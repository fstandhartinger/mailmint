'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseMessage } = require('..');

/**
 * Messages that the parser once could not read.
 *
 * `packages/api/src/messages.js` parks a copy of anything that throws during
 * parsing under `ops/failures/`, which CONTRACT.md documents. On 2026-08-25 that
 * directory held 21 messages, every one of them recorded with the same error:
 *
 *     "error": "Invalid or unexpected token"
 *
 * They are plain-text invoices — nothing exotic. Whatever broke has since been
 * fixed, and all 21 now parse, but nothing was holding that fixed. Parked
 * failures that nobody replays are just litter with a timestamp.
 *
 * So they live here instead, as the corpus they always should have been. If any
 * of them ever throws again, this fails.
 */
const DIR = path.join(__dirname, 'regressions');
const messages = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.eml')) : [];

test('there is a regression corpus to run', () => {
  assert.ok(messages.length > 0, 'expected parked failure messages under test/regressions');
});

for (const name of messages) {
  test(`parses without throwing: ${name.slice(0, 28)}…`, async () => {
    const raw = fs.readFileSync(path.join(DIR, name));
    const result = await parseMessage(raw, {});
    assert.ok(result, 'a result comes back');
    assert.ok(result.headers && result.headers.subject,
      'the subject survives — these are the messages that used to die mid-parse');
    // Each of them is an invoice with a total; the parser should still see that.
    const amounts = (result.detected && result.detected.amounts) || [];
    assert.ok(amounts.length > 0, 'the invoice total is still detected');
  });
}
