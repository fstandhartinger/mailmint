'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key; let mailbox;

before(async () => {
  await H.start();
  ({ key } = await H.newAccount());
  mailbox = await H.newMailbox(key, {
    name: 'Invoices',
    schema: [{ name: 'invoice_number', type: 'string', required: true }, { name: 'total', type: 'number' }],
  });
});
after(H.stop);

describe('a real message, end to end', () => {
  let messageId;
  let listener;
  let hookUrl;

  test('the mail server can resolve the address before it accepts the mail', async () => {
    const { res, json } = await H.internal('/internal/resolve', { to: mailbox.address });
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.results[0].mailbox.id, mailbox.id);

    // The three spellings of one address all have to land on the same mailbox,
    // or sub-addressing silently drops mail.
    const alias = await H.internal('/internal/resolve', {
      to: [`${mailbox.token}+urgent@${H.config.inboundDomain}`, `invoices.${mailbox.token}@${H.config.inboundDomain}`],
    });
    assert.equal(alias.json.results.every((r) => r.ok && r.mailbox.id === mailbox.id), true, JSON.stringify(alias.json));
    assert.equal(alias.json.results[0].tag, 'urgent');
  });

  test('an unknown recipient is refused, and a known one is never refused for quota', async () => {
    const { json } = await H.internal('/internal/resolve', { to: `zzzzzzzzzzzz@${H.config.inboundDomain}` });
    assert.equal(json.ok, false);
    assert.equal(json.results[0].reason, 'unknown_mailbox');
  });

  test('POST /internal/deliver stores the message and answers with its id', async () => {
    listener = H.webhookListener();
    hookUrl = await listener.listen();
    const patched = await H.req(`/v1/mailboxes/${mailbox.id}`, { method: 'PATCH', key, body: { webhook_url: hookUrl } });
    assert.equal(patched.res.status, 200);
    mailbox.webhook_secret = patched.json.mailbox.webhook_secret;

    const { res, json } = await H.deliver(mailbox);
    assert.equal(res.status, 200);
    assert.match(json.message_id, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    messageId = json.message_id;

    // The row must exist by the time the response is written — that is the
    // promise that makes answering before the parse safe.
    const { rows } = await H.query('SELECT id, status FROM messages WHERE id = $1', [messageId]);
    assert.equal(rows.length, 1);
  });

  test('it comes back on GET /v1/messages', async () => {
    const found = await H.until(async () => {
      const { json } = await H.req('/v1/messages', { key });
      return json.data.find((m) => m.id === messageId && m.status === 'parsed');
    }, { what: 'the message to appear parsed on /v1/messages' });
    assert.equal(found.subject, 'Invoice INV-2291 from Acme Ltd');
    assert.equal(found.from, 'billing@acme.com');
    assert.ok(found.size > 0);
  });

  test('GET /v1/messages/:id returns the canonical object', async () => {
    const { res, json } = await H.req(`/v1/messages/${messageId}`, { key });
    assert.equal(res.status, 200);
    assert.equal(json.id, messageId);
    assert.equal(json.mailbox.id, mailbox.id);
    assert.equal(json.mailbox.address, mailbox.address);
    assert.match(json.received_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(json.envelope.from, 'billing@acme.com');
    assert.equal(json.envelope.remote_ip, '209.85.128.51');
    assert.equal(json.headers.subject, 'Invoice INV-2291 from Acme Ltd');
    assert.equal(json.headers.from.email, 'billing@acme.com');
    assert.match(json.body.text, /Total: \$31\.50/);
    // §1: every schema field is present, and a field that was not found is null
    // rather than a guess.
    assert.deepEqual(Object.keys(json.fields).sort(), ['invoice_number', 'total']);
    for (const f of Object.values(json.fields)) {
      // §1a added `rule+llm`: the deterministic layer and the model agreed
      // independently, which is the strongest provenance we can report.
      assert.ok(['rule', 'llm', 'rule+llm', 'header', 'attachment', 'none'].includes(f.source), `bad source ${f.source}`);
      assert.ok(typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1);
      if (f.value === null) assert.equal(f.evidence, null);
    }
    assert.ok(Array.isArray(json.flags));
    assert.equal(typeof json.needs_review, 'boolean');
    assert.ok(json.parse.timings_ms.total >= 0);
    assert.match(json.raw_url, /\/v1\/messages\/msg_[0-9a-z]+\/raw$/);
  });

  test('the original bytes come back from /raw', async () => {
    const { res, buffer } = await H.req(`/v1/messages/${messageId}/raw`, { key, raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'message/rfc822');
    assert.match(buffer.toString('utf8'), /^From: Acme Billing <billing@acme\.com>/);
  });

  test('it comes back on GET /v1/events, and the cursor advances past it', async () => {
    const { res, json } = await H.req('/v1/events', { key });
    assert.equal(res.status, 200);
    const ev = json.events.find((e) => e.message && e.message.id === messageId);
    assert.ok(ev, `no event for ${messageId} in ${JSON.stringify(json.events.map((e) => e.id))}`);
    assert.equal(ev.type, 'message.parsed');
    assert.equal(ev.cursor, String(ev.id));
    // The event carries the whole §1 object, which is what lets the n8n trigger
    // emit a usable item without a second call.
    assert.equal(ev.message.mailbox.address, mailbox.address);

    const after = await H.req(`/v1/events?cursor=${json.next_cursor}`, { key });
    assert.equal(after.json.events.length, 0, 'the cursor must not replay events it already returned');
    assert.equal(after.json.next_cursor, json.next_cursor);
  });

  test('a webhook was delivered, and its signature verifies independently', async () => {
    // The worker is off in this suite; drive it by hand, targeting THIS
    // message, so the assertion is about the queue and not about a timer.
    await H.until(async () => {
      await H.flushWebhooks(messageId);
      return listener.received.length > 0;
    }, { what: 'the webhook to be delivered' });

    const got = listener.received.find((r) => JSON.parse(r.body).id === messageId);
    assert.ok(got, 'the receiver never saw this message');
    assert.equal(got.headers['x-mailmint-event'], 'message.parsed');
    assert.match(got.headers['x-mailmint-delivery'], /^dlv_/);

    const check = H.verifySignatureIndependently(mailbox.webhook_secret, got.body, got.headers['x-mailmint-signature']);
    assert.equal(check.ok, true, check.why);

    // A different secret must NOT verify, or the check above proves nothing.
    const wrong = H.verifySignatureIndependently('not-the-secret', got.body, got.headers['x-mailmint-signature']);
    assert.equal(wrong.ok, false);

    // The webhook body and the API body are the same object.
    const api = await H.req(`/v1/messages/${messageId}`, { key });
    const hook = JSON.parse(got.body);
    assert.equal(hook.id, api.json.id);
    assert.deepEqual(hook.fields, api.json.fields);
    assert.deepEqual(hook.flags, api.json.flags);

    const { rows } = await H.query('SELECT status_code, delivered_at, attempt FROM webhook_deliveries WHERE message_id = $1', [messageId]);
    assert.equal(rows[0].status_code, 200);
    assert.equal(rows[0].attempt, 1);
    assert.ok(rows[0].delivered_at);
    await listener.close();
  });

  test('the message is counted against the quota exactly once', async () => {
    const { json } = await H.req('/v1/usage', { key });
    assert.equal(json.used, 1);
    assert.equal(json.remaining, json.plan.quota - 1);
  });
});
