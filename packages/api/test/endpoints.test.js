'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const endpointsModel = require('../src/webhook-endpoints');

let key;

before(async () => { await H.start(); ({ key } = await H.newAccount()); });
after(H.stop);

describe('a mailbox has many webhook endpoints', () => {
  test('two registrations coexist and each gets its own secret', async () => {
    const a = H.webhookListener();
    const b = H.webhookListener();
    const urlA = await a.listen();
    const urlB = await b.listen();
    const mb = await H.newMailbox(key, { schema: [{ name: 'total', type: 'number' }] });

    const one = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, {
      method: 'POST', key, body: { url: urlA, description: 'invoice workflow' },
    });
    assert.equal(one.res.status, 201);
    assert.match(one.json.webhook.id, /^whe_/);
    assert.ok(one.json.webhook.secret, 'the secret is shown once, at creation');

    const two = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, {
      method: 'POST', key, body: { url: urlB, description: 'accounting workflow' },
    });
    assert.equal(two.res.status, 201);
    assert.notEqual(two.json.webhook.secret, one.json.webhook.secret,
      'each registration signs with its own secret, so rotating one cannot break the other');

    const listed = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { key });
    assert.equal(listed.json.data.length, 2);
    assert.equal(listed.json.data.some((e) => e.secret !== undefined), false,
      'a listing must not read secrets back');

    // One message, two deliveries, each verifying under its own secret.
    const { json } = await H.deliver(mb, { wait: true });
    await H.flushWebhooks(json.message_id);
    assert.equal(a.received.length, 1, 'endpoint A did not receive');
    assert.equal(b.received.length, 1, 'endpoint B did not receive');

    const checkA = H.verifySignatureIndependently(one.json.webhook.secret, a.received[0].body, a.received[0].headers['x-mailmint-signature']);
    const checkB = H.verifySignatureIndependently(two.json.webhook.secret, b.received[0].body, b.received[0].headers['x-mailmint-signature']);
    assert.equal(checkA.ok, true, checkA.why);
    assert.equal(checkB.ok, true, checkB.why);
    // And crossing them over must NOT verify, or the secrets are not really separate.
    assert.equal(H.verifySignatureIndependently(two.json.webhook.secret, a.received[0].body, a.received[0].headers['x-mailmint-signature']).ok, false);
    assert.equal(a.received[0].headers['x-mailmint-endpoint'], one.json.webhook.id);

    await a.close(); await b.close();
  });

  test('deleting one endpoint leaves the other delivering — the bug this replaces', async () => {
    const a = H.webhookListener();
    const b = H.webhookListener();
    const urlA = await a.listen();
    const urlB = await b.listen();
    const mb = await H.newMailbox(key);
    const one = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { method: 'POST', key, body: { url: urlA } });
    await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { method: 'POST', key, body: { url: urlB } });

    const gone = await H.req(`/v1/webhooks/${one.json.webhook.id}`, { method: 'DELETE', key });
    assert.equal(gone.res.status, 200);

    const { json } = await H.deliver(mb, { wait: true });
    await H.flushWebhooks(json.message_id);
    assert.equal(a.received.length, 0, 'the deleted endpoint must stop');
    assert.equal(b.received.length, 1, 'the other workflow must be untouched — this is the whole point');
    await a.close(); await b.close();
  });

  test('a paused endpoint is skipped, and resuming clears its failure count', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key);
    const e = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { method: 'POST', key, body: { url } });

    await H.req(`/v1/webhooks/${e.json.webhook.id}`, { method: 'PATCH', key, body: { active: false } });
    const first = await H.deliver(mb, { wait: true });
    await H.flushWebhooks(first.json.message_id);
    assert.equal(listener.received.length, 0);

    await H.req(`/v1/webhooks/${e.json.webhook.id}`, { method: 'PATCH', key, body: { active: true } });
    const second = await H.deliver(mb, { wait: true });
    await H.flushWebhooks(second.json.message_id);
    assert.equal(listener.received.length, 1);
    await listener.close();
  });

  test('mailbox.webhook_url still works, and is the first endpoint', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key);
    const patched = await H.req(`/v1/mailboxes/${mb.id}`, { method: 'PATCH', key, body: { webhook_url: url } });
    assert.equal(patched.json.mailbox.webhook_url, url);
    assert.equal(patched.json.mailbox.webhooks.length, 1);
    assert.equal(patched.json.mailbox.webhooks[0].url, url);
    // The alias secret must be the endpoint's, or a receiver following the old
    // documentation would verify against the wrong key.
    assert.equal(patched.json.mailbox.webhook_secret, patched.json.mailbox.webhooks[0].secret);

    const { json } = await H.deliver(mb, { wait: true });
    await H.flushWebhooks(json.message_id);
    const check = H.verifySignatureIndependently(
      patched.json.mailbox.webhook_secret, listener.received[0].body, listener.received[0].headers['x-mailmint-signature'],
    );
    assert.equal(check.ok, true, check.why);

    // Clearing it removes the endpoint rather than leaving a dead row behind.
    const cleared = await H.req(`/v1/mailboxes/${mb.id}`, { method: 'PATCH', key, body: { webhook_url: null } });
    assert.equal(cleared.json.mailbox.webhook_url, null);
    assert.equal(cleared.json.mailbox.webhooks.length, 0);
    await listener.close();
  });

  test('a mailbox created with webhook_url gets an endpoint, not a column', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    assert.equal(mb.webhooks.length, 1);
    assert.equal(mb.webhooks[0].url, url);
    await listener.close();
  });

  test('an endpoint that keeps failing is switched off rather than retried forever', async () => {
    const listener = H.webhookListener(() => 500);
    const url = await listener.listen();
    const mb = await H.newMailbox(key);
    const e = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { method: 'POST', key, body: { url } });
    const id = e.json.webhook.id;

    // Exhaust the endpoint's tolerance. Each iteration is one whole delivery
    // giving up, which is what counts — a single failed attempt does not.
    for (let i = 0; i < endpointsModel.MAX_CONSECUTIVE_FAILURES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await H.query(
        `UPDATE webhook_endpoints SET consecutive_failures = $2 WHERE id = $1`,
        [id, i],
      );
      // eslint-disable-next-line no-await-in-loop
      await require('../src/webhook-endpoints').recordFailure(id, 500, 'HTTP 500');
    }
    const after = await H.req(`/v1/webhooks/${id}`, { key });
    assert.equal(after.json.webhook.active, false);
    assert.ok(after.json.webhook.disabled_reason, 'the dashboard has to be able to say why');

    // And a disabled endpoint stops being delivered to.
    const { json } = await H.deliver(mb, { wait: true });
    const { rows } = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(rows[0].n, 0);
    await listener.close();
  });

  test('one account cannot touch another\'s endpoint', async () => {
    const mb = await H.newMailbox(key);
    const listener = H.webhookListener();
    const url = await listener.listen();
    const e = await H.req(`/v1/mailboxes/${mb.id}/webhooks`, { method: 'POST', key, body: { url } });
    const stranger = await H.newAccount();
    assert.equal((await H.req(`/v1/webhooks/${e.json.webhook.id}`, { key: stranger.key })).res.status, 404);
    assert.equal((await H.req(`/v1/webhooks/${e.json.webhook.id}`, { method: 'DELETE', key: stranger.key })).res.status, 404);
    await listener.close();
  });

  test('the dashboard lists endpoints and can add one', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    const added = await H.req(`/dashboard/mailboxes/${mb.id}/webhooks`, {
      method: 'POST', form: true, cookie: account.cookie,
      body: { url: 'https://example.com/hooks/one', description: 'n8n' },
    });
    assert.equal(added.res.status, 302);
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.match(page.text, /https:\/\/example\.com\/hooks\/one/);
    assert.match(page.text, /Add endpoint/);
  });
});

describe('sender authentication (§1c)', () => {
  const deliverWithAuth = (mb, auth, details) => H.internal('/internal/deliver', {
    mailbox_token: mb.token,
    envelope: {
      from: 'billing@acme.com', to: [mb.address], helo: 'mail.acme.com',
      remote_ip: '209.85.128.51', tls: true, auth, auth_details: details,
    },
    raw_mime: H.rawMime({ to: mb.address }).toString('base64'),
    wait: true,
  });

  test('dkim body_altered is not a failure and does not need review', async () => {
    const mb = await H.newMailbox(key);
    const { json } = await deliverWithAuth(mb,
      { spf: 'pass', dkim: 'body_altered', dmarc: 'pass', spam_score: 2.4 },
      { dkim: { failure_type: 'body_hash', domain: 'acme.com' } });

    const got = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.ok(got.json.flags.includes('dkim_body_altered'), JSON.stringify(got.json.flags));
    assert.equal(got.json.flags.includes('auth_fail:dkim'), false,
      'forwarded mail is our own happy path; it must not be marked as failing authentication');
    assert.equal(got.json.needs_review, false, JSON.stringify(got.json.flags));
    assert.equal(got.json.auth.dkim, 'body_altered');
    assert.equal(got.json.auth_details.dkim.failure_type, 'body_hash');
  });

  test('a genuine dkim failure IS flagged', async () => {
    const mb = await H.newMailbox(key);
    const { json } = await deliverWithAuth(mb,
      { spf: 'pass', dkim: 'fail', dmarc: 'fail', spam_score: 3.9 },
      { dkim: { failure_type: 'signature' } });
    const got = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.ok(got.json.flags.includes('auth_fail:dkim'));
    assert.ok(got.json.flags.includes('auth_fail:dmarc'));
    assert.equal(got.json.flags.includes('dkim_body_altered'), false);
  });

  test('spf none means "could not be checked", not "failed"', async () => {
    const mb = await H.newMailbox(key);
    // The Cloudflare Email Routing shape: no client IP, so SPF is unevaluable.
    const { json } = await deliverWithAuth(mb,
      { spf: 'none', dkim: 'pass', dmarc: 'pass' },
      { spf: { reason: 'no client ip available on this path' } });
    const got = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.equal(got.json.flags.some((f) => f.startsWith('auth_fail:')), false, JSON.stringify(got.json.flags));
    assert.equal(got.json.auth.spf, 'none');
  });

  test('temperror and permerror are infrastructure, not forgery', () => {
    const { authFlags } = require('../src/messages');
    assert.deepEqual(authFlags({ auth: { spf: 'temperror', dkim: 'permerror', dmarc: 'none' } }), []);
    assert.deepEqual(authFlags({ auth: { spf: 'fail' } }), ['auth_fail:spf']);
  });

  test('the dashboard explains body_altered instead of alarming about it', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    await H.internal('/internal/deliver', {
      mailbox_token: mb.token,
      envelope: { from: 'a@b.example', to: [mb.address], tls: true, auth: { spf: 'none', dkim: 'body_altered', dmarc: 'pass' } },
      raw_mime: H.rawMime({ to: mb.address }).toString('base64'),
      wait: true,
    });
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.match(page.text, /normal for forwarded mail/);
    assert.match(page.text, /not checked — no result was available/);
  });
});
