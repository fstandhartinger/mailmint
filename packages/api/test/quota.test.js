'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key; let accountId;

before(async () => { await H.start(); ({ key, accountId } = await H.newAccount()); });
after(H.stop);

describe('quota', () => {
  test('mail over the quota is still accepted, stored, listed and delivered', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, {
      webhook_url: url,
      schema: [{ name: 'total', type: 'number' }],
    });
    // Put the account exactly on the line. Nothing about the code path changes
    // between "used its last one" and "used a thousand".
    await H.query(`UPDATE accounts SET used_month = quota_month WHERE id = $1`, [accountId]);

    const { res, json } = await H.deliver(mb, { wait: true });
    assert.equal(res.status, 200, 'mail is NEVER refused for quota');

    const got = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.equal(got.res.status, 200);
    assert.ok(got.json.flags.includes('quota_exceeded'), `flags were ${JSON.stringify(got.json.flags)}`);
    assert.equal(got.json.parse.llm_used, false, 'no LLM pass may run over the quota');
    assert.equal(got.json.parse.model, null, 'no model may be named when none ran');
    // The message still has the shape everything downstream depends on, and the
    // deterministic layer still ran — losing the quota does not mean losing the
    // rule hits, only the model.
    assert.ok('total' in got.json.fields);
    assert.ok(['rule', 'header', 'none'].includes(got.json.fields.total.source),
      `over quota a field may only come from the deterministic layer, got "${got.json.fields.total.source}"`);
    assert.ok(got.json.body.text.includes('$31.50'), 'the body still parsed');

    // And it still reaches the webhook: over quota is not a reason to go quiet.
    await H.flushWebhooks(json.message_id);
    assert.equal(listener.received.length, 1);
    await listener.close();

    // Nothing was billed for a parse that did not happen.
    const usage = await H.req('/v1/usage', { key });
    assert.equal(usage.json.used, usage.json.plan.quota);
    assert.equal(usage.json.remaining, 0);
  });

  test('the API endpoints DO refuse over the quota, with a 402 that says what to do', async () => {
    const { res, json } = await H.req('/v1/parse', {
      method: 'POST', key, body: { text: 'Total: $10', schema: [{ name: 'total', type: 'number' }] },
    });
    assert.equal(res.status, 402);
    assert.equal(json.error.code, 'quota_exceeded');
    assert.match(json.error.hint, /still received and stored/i);
  });

  test('a mm_test_ key parses but is never billed', async () => {
    const { rows } = await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId]);
    const before = rows[0].used_month;

    // Minted the way the dashboard's "test key" checkbox mints one.
    const testKey = await require('../src/auth').issueApiKey(accountId, 'ci', 'test');
    assert.match(testKey, /^mm_test_/);

    // The account is at its limit, and a live key is refused there — this one is not.
    const { res, json } = await H.req('/v1/parse', {
      method: 'POST', key: testKey, body: { text: 'Total: $10', schema: [{ name: 'total', type: 'number' }] },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.ok('total' in json.fields);

    const after = await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId]);
    assert.equal(after.rows[0].used_month, before, 'a test key must not move the counter');

    const usage = await H.req('/v1/usage', { key: testKey });
    assert.equal(usage.json.key_mode, 'test');
  });

  test('a fresh account starts on the free plan with the documented allowance', async () => {
    const other = await H.newAccount();
    const { json } = await H.req('/v1/usage', { key: other.key });
    assert.equal(json.plan.id, 'free');
    assert.equal(json.plan.quota, require('../src/config').PLANS.free.quota);
    assert.equal(json.used, 0);
    // The docs page quotes this number; if they disagree, one of them is lying
    // to a customer about what they are getting.
    const docs = await H.req('/docs');
    assert.match(docs.text, new RegExp(`The free plan is ${json.plan.quota} parsed emails a month`));
  });

  test('a re-parse of mail already paid for is not a second sale', async () => {
    const other = await H.newAccount();
    const mb = await H.newMailbox(other.key, { schema: [{ name: 'total', type: 'number' }] });
    const { json } = await H.deliver(mb, { wait: true });
    const before = await H.req('/v1/usage', { key: other.key });
    await H.req(`/v1/messages/${json.message_id}/reparse`, { method: 'POST', key: other.key, body: {} });
    const after = await H.req('/v1/usage', { key: other.key });
    assert.equal(after.json.used, before.json.used, 'a re-parse must not consume quota again');
  });
});
