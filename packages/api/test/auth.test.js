'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key; let accountId;

before(async () => { await H.start(); ({ key, accountId } = await H.newAccount()); });
after(H.stop);

describe('API keys', () => {
  test('no key, a wrong key and a foreign-looking key all fail with a usable message', async () => {
    const none = await H.req('/v1/mailboxes');
    assert.equal(none.res.status, 401);
    assert.equal(none.json.error.code, 'missing_api_key');
    assert.match(none.json.error.hint, /Authorization: Bearer/);

    const foreign = await H.req('/v1/mailboxes', { key: 'sk_live_something_else' });
    assert.equal(foreign.res.status, 401);
    assert.equal(foreign.json.error.code, 'invalid_api_key');
    assert.match(foreign.json.error.hint, /mm_live_/);

    const wrong = await H.req('/v1/mailboxes', { key: `${key.slice(0, -4)}zzzz` });
    assert.equal(wrong.res.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_api_key');
  });

  test('the key is stored hashed and salted, never in the clear', async () => {
    const { rows } = await H.query(`SELECT prefix, hash FROM api_keys WHERE account_id = $1`, [accountId]);
    for (const r of rows) {
      assert.match(r.hash, /^[0-9a-f]{24}\$[0-9a-f]{64}$/, 'hash column must be salt$sha256');
      assert.equal(r.hash.includes(key), false);
      assert.equal(key.startsWith(r.prefix), true);
    }
    // The secret half of the key must not be recoverable from what is stored.
    const secret = key.slice('mm_live_'.length);
    const all = JSON.stringify(rows);
    assert.equal(all.includes(secret), false);
  });

  test('a revoked key stops working on the very next request', async () => {
    const second = await require('../src/auth').issueApiKey(accountId, 'temp', 'live');
    assert.equal((await H.req('/v1/usage', { key: second })).res.status, 200);
    await require('../src/auth').revokeApiKey(accountId, second.slice(0, 16));
    assert.equal((await H.req('/v1/usage', { key: second })).res.status, 401);
  });

  test('the last key cannot be revoked, because that is a lockout', async () => {
    const solo = await H.newAccount();
    const { rows } = await H.query(`SELECT prefix FROM api_keys WHERE account_id = $1`, [solo.accountId]);
    await assert.rejects(
      () => require('../src/auth').revokeApiKey(solo.accountId, rows[0].prefix),
      /only key/i,
    );
  });
});

describe('the internal API', () => {
  test('is closed without the shared secret', async () => {
    const bare = await H.req('/internal/resolve', { method: 'POST', body: { to: 'x@y' } });
    assert.equal(bare.res.status, 401);
    const wrong = await H.req('/internal/resolve', {
      method: 'POST', body: { to: 'x@y' }, headers: { 'x-mailmint-internal': 'not-it' },
    });
    assert.equal(wrong.res.status, 401);
  });

  test('an API key is not a substitute for it', async () => {
    const { res } = await H.req('/internal/deliver', { method: 'POST', key, body: {} });
    assert.equal(res.status, 401);
  });

  // CONTRACT §3a: unknown is a 404 with the reason in `details`, never a 200
  // with a falsy `ok` and never a batch `results` array. This test asserted the
  // batch shape the endpoint deliberately dropped, so it failed against a
  // correct server.
  test('rejects mail for a domain it does not host', async () => {
    const mb = await H.newMailbox(key);
    const { res, json } = await H.internal('/internal/resolve', { to: `${mb.token}@somewhere-else.example` });
    assert.equal(res.status, 404);
    assert.equal(json.error.code, 'unknown_mailbox');
    assert.equal(json.error.details.reason, 'wrong_domain');
  });
});

describe('the signup path a stranger walks', () => {
  test('signup gives an address, a key and a working dashboard in one step', async () => {
    const account = await H.newAccount();
    const dash = await H.req('/dashboard', { cookie: account.cookie });
    assert.equal(dash.res.status, 200);
    assert.match(dash.text, new RegExp(`@${H.config.inboundDomain.replace(/\./g, '\\.')}`), 'the dashboard must show an inbound address');
    assert.match(dash.text, /mm_live_/, 'the key is shown once, on this page');

    // And the key it showed actually works.
    const boxes = await H.req('/v1/mailboxes', { key: account.key });
    assert.equal(boxes.res.status, 200);
    assert.equal(boxes.json.data.length, 1);
  });

  test('the key is shown once and never again', async () => {
    const account = await H.newAccount();
    const again = await H.req('/dashboard', { cookie: account.cookie });
    assert.equal(again.text.includes(account.key), false, 'a second load must not repeat the secret');
  });

  test('a duplicate email is refused, and a short password too', async () => {
    const account = await H.newAccount();
    const dup = await H.req('/signup', { method: 'POST', form: true, body: { email: account.email, password: 'testpassword123' } });
    assert.equal(dup.res.status, 409);
    const short = await H.req('/signup', { method: 'POST', form: true, body: { email: 'x@example.com', password: 'short' } });
    assert.equal(short.res.status, 400);
  });

  test('the dashboard renders a message with its parsed fields', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'total', type: 'number' }] });
    await H.deliver(mb, { wait: true });
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.equal(page.res.status, 200);
    assert.match(page.text, /Invoice INV-2291/);
    assert.match(page.text, /Full JSON/);
    assert.match(page.text, /Send a test email/);
  });

  test('the test-email panel produces a parsed message', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'total', type: 'number' }] });
    const sent = await H.req(`/dashboard/mailboxes/${mb.id}/test`, {
      method: 'POST', form: true, cookie: account.cookie,
      body: { from: 'a@b.example', subject: 'Test run', text: 'Total: $9.99' },
    });
    assert.equal(sent.res.status, 302);
    assert.match(sent.res.headers.get('location'), /tested=msg_/);
    const list = await H.req('/v1/messages', { key: account.key });
    assert.equal(list.json.data[0].subject, 'Test run');
    assert.equal(list.json.data[0].status, 'parsed');
  });

  test('mail content is escaped on the dashboard, because the sender is a stranger', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    await H.deliver(mb, { wait: true, subject: '<script>alert(1)</script>' });
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.equal(page.text.includes('<script>alert(1)</script>'), false, 'a subject line must never reach the page as markup');
    assert.match(page.text, /&lt;script&gt;/);
  });
});
