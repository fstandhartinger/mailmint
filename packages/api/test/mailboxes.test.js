'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key;

before(async () => { await H.start(); ({ key } = await H.newAccount()); });
after(H.stop);

describe('mailboxes and schema versions', () => {
  test('a new mailbox gets a 12-character token and a publishable address', async () => {
    const mb = await H.newMailbox(key, { name: 'Invoices' });
    assert.match(mb.token, /^[0-9a-hjkmnp-tv-z]{12}$/, `token ${mb.token} is not Crockford base32 without i/l/o/u`);
    assert.equal(mb.address, `${mb.token}@${H.config.inboundDomain}`);
    assert.equal(mb.alias, `invoices.${mb.token}@${H.config.inboundDomain}`);
    assert.equal(mb.schema_version, 1);
    // A mailbox with no webhook endpoint has no signing secret to report — the
    // secret belongs to the endpoint now, not to the mailbox.
    assert.equal(mb.webhook_secret, null);
    assert.deepEqual(mb.webhooks, []);
  });

  test('tokens are unique across mailboxes', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const mb = await H.newMailbox(key);
      assert.equal(seen.has(mb.token), false);
      seen.add(mb.token);
    }
  });

  test('a bad schema is refused at write time, naming the field', async () => {
    const { res, json } = await H.req('/v1/mailboxes', {
      method: 'POST', key, body: { name: 'Bad', schema: [{ name: 'total amount', type: 'number' }] },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'invalid_schema');
    assert.match(json.error.message, /total amount/);

    const enumless = await H.req('/v1/mailboxes', {
      method: 'POST', key, body: { name: 'Bad2', schema: [{ name: 'state', type: 'enum' }] },
    });
    assert.equal(enumless.res.status, 400);
    assert.match(enumless.json.error.message, /options/);
  });

  test('every schema change mints a version, and an old one can be restored', async () => {
    const mb = await H.newMailbox(key, { schema: [{ name: 'total', type: 'number' }] });
    assert.equal(mb.schema_version, 1);

    const v2 = await H.req(`/v1/mailboxes/${mb.id}`, {
      method: 'PATCH', key, body: { schema: [{ name: 'total', type: 'number' }, { name: 'vendor', type: 'string' }] },
    });
    assert.equal(v2.json.mailbox.schema_version, 2);

    const { rows } = await H.query(
      `SELECT version, schema FROM mailbox_schema_versions WHERE mailbox_id = $1 ORDER BY version`, [mb.id],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].schema.length, 1);
    assert.equal(rows[1].schema.length, 2);
  });

  test('a message re-parsed against an OLD schema version gets that version\'s fields', async () => {
    const mb = await H.newMailbox(key, { schema: [{ name: 'total', type: 'number' }] });
    const { json: delivered } = await H.deliver(mb, { wait: true });

    const first = await H.req(`/v1/messages/${delivered.message_id}`, { key });
    assert.deepEqual(Object.keys(first.json.fields), ['total']);
    assert.equal(first.json.parse.schema_version, 1);

    await H.req(`/v1/mailboxes/${mb.id}`, {
      method: 'PATCH', key, body: { schema: [{ name: 'vendor', type: 'string' }] },
    });
    const now = await H.req(`/v1/messages/${delivered.message_id}/reparse`, { method: 'POST', key, body: {} });
    assert.deepEqual(Object.keys(now.json.fields), ['vendor'], 'a plain reparse uses the live schema');
    assert.equal(now.json.parse.schema_version, 2);

    // …and naming the old version reproduces the original result, which is the
    // only honest way to answer "what did you send me last week".
    const back = await H.req(`/v1/messages/${delivered.message_id}/reparse`, {
      method: 'POST', key, body: { schema_version: 1 },
    });
    assert.deepEqual(Object.keys(back.json.fields), ['total']);
    assert.equal(back.json.parse.schema_version, 1);
  });

  test('a reparse does not re-fire the webhook unless asked', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url, schema: [{ name: 'total', type: 'number' }] });
    const { json } = await H.deliver(mb, { wait: true });
    await H.req(`/v1/messages/${json.message_id}/reparse`, { method: 'POST', key, body: {} });
    const { rows } = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(rows[0].n, 1, 'a tuning session must not duplicate rows in the customer\'s database');

    await H.req(`/v1/messages/${json.message_id}/reparse`, { method: 'POST', key, body: { deliver: true } });
    const after = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(after.rows[0].n, 2);
    await listener.close();
  });

  test('a deleted mailbox stops resolving, and its messages are still readable', async () => {
    const mb = await H.newMailbox(key);
    const { json } = await H.deliver(mb, { wait: true });
    await H.req(`/v1/mailboxes/${mb.id}`, { method: 'DELETE', key });

    const resolved = await H.internal('/internal/resolve', { to: mb.address });
    assert.equal(resolved.json.ok, false);
    assert.equal(resolved.json.results[0].reason, 'unknown_mailbox');

    const still = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.equal(still.res.status, 200);

    const gone = await H.req(`/v1/mailboxes/${mb.id}`, { key });
    assert.equal(gone.res.status, 404);
  });

  test('one account cannot see another\'s mailbox or messages', async () => {
    const mine = await H.newMailbox(key);
    const { json } = await H.deliver(mine, { wait: true });
    const stranger = await H.newAccount();

    assert.equal((await H.req(`/v1/mailboxes/${mine.id}`, { key: stranger.key })).res.status, 404);
    assert.equal((await H.req(`/v1/messages/${json.message_id}`, { key: stranger.key })).res.status, 404);
    assert.equal((await H.req(`/v1/messages/${json.message_id}/raw`, { key: stranger.key })).res.status, 404);
    const events = await H.req('/v1/events', { key: stranger.key });
    assert.equal(events.json.events.length, 0);
  });
});

describe('the stateless parse endpoint', () => {
  test('parses without storing anything', async () => {
    const before = await H.query(`SELECT count(*)::int AS n FROM messages`);
    const { res, json } = await H.req('/v1/parse', {
      method: 'POST', key,
      body: { subject: 'Invoice INV-9', text: 'Total: $12.00', schema: [{ name: 'total', type: 'number' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(json.id, null);
    assert.equal(json.mailbox, null);
    assert.equal(json.raw_url, null);
    assert.ok('total' in json.fields);
    const after = await H.query(`SELECT count(*)::int AS n FROM messages`);
    assert.equal(after.rows[0].n, before.rows[0].n, 'POST /v1/parse must store nothing');
  });

  test('says what to send when the body is empty', async () => {
    const { res, json } = await H.req('/v1/parse', { method: 'POST', key, body: {} });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'missing_input');
    assert.ok(json.error.hint.includes('schema'));
  });

  test('takes raw MIME as well as parts', async () => {
    const raw = H.rawMime({ to: 'someone@example.com' });
    const { res, json } = await H.req('/v1/parse', {
      method: 'POST', key, body: { raw_mime: raw.toString('base64'), schema: [] },
    });
    assert.equal(res.status, 200);
    assert.equal(json.headers.subject, 'Invoice INV-2291 from Acme Ltd');
    assert.ok(json.flags.includes('no_schema'));
  });
});
