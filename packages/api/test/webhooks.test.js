'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { SCHEDULE_SECONDS, MAX_ATTEMPTS, retriable, sign, verify } = require('../src/webhooks');

let key;

before(async () => { await H.start(); ({ key } = await H.newAccount()); });
after(H.stop);

/**
 * Runs the worker's step against one message's deliveries. Targeted rather than
 * a plain claim(): the queue is global and the suite shares a database, so
 * draining it blindly would consume a retry another test left pending on
 * purpose and make both tests lie.
 */
const drain = (messageId) => H.flushWebhooks(messageId);

describe('the retry schedule', () => {
  test('is the one the contract names', () => {
    assert.deepEqual(SCHEDULE_SECONDS, [30, 120, 600, 3600, 21600]);
    assert.equal(MAX_ATTEMPTS, 6);
  });

  test('a 500 is retried and the next attempt is scheduled 30s out', async () => {
    const listener = H.webhookListener(() => 500);
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    await drain(json.message_id);

    const { rows } = await H.query(
      `SELECT attempt, status_code, error, next_attempt_at, delivered_at, failed_at,
              EXTRACT(EPOCH FROM (next_attempt_at - now()))::int AS in_seconds
         FROM webhook_deliveries WHERE message_id = $1`, [json.message_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].status_code, 500);
    assert.equal(rows[0].delivered_at, null);
    assert.equal(rows[0].failed_at, null);
    assert.ok(rows[0].in_seconds > 25 && rows[0].in_seconds <= 30, `next attempt in ${rows[0].in_seconds}s, expected ~30`);
    assert.equal(listener.received.length, 1);
    await listener.close();
  });

  test('a 404 is not retried at all — the receiver understood and said no', async () => {
    const listener = H.webhookListener(() => 404);
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    await drain(json.message_id);

    const { rows } = await H.query(
      `SELECT attempt, status_code, failed_at, next_attempt_at, error FROM webhook_deliveries WHERE message_id = $1`,
      [json.message_id],
    );
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].status_code, 404);
    assert.ok(rows[0].failed_at, 'a 404 must be given up on immediately');
    assert.equal(rows[0].next_attempt_at, null);
    await listener.close();
  });

  test('429 and 408 are the exceptions and do retry', () => {
    assert.equal(retriable(429), true);
    assert.equal(retriable(408), true);
    assert.equal(retriable(400), false);
    assert.equal(retriable(403), false);
    assert.equal(retriable(500), true);
    assert.equal(retriable(503), true);
  });

  test('a receiver that recovers gets the message on the retry', async () => {
    const listener = H.webhookListener((n) => (n === 0 ? 503 : 200));
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    await drain(json.message_id);
    // Pull the scheduled retry forward rather than waiting 30 real seconds; the
    // schedule itself is asserted above.
    await H.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE message_id = $1`, [json.message_id]);
    await drain(json.message_id);

    const { rows } = await H.query(`SELECT attempt, status_code, delivered_at FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(rows[0].attempt, 2);
    assert.equal(rows[0].status_code, 200);
    assert.ok(rows[0].delivered_at);
    assert.equal(listener.received.length, 2);
    await listener.close();
  });

  test('it gives up after six attempts', async () => {
    const listener = H.webhookListener(() => 500);
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await H.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE message_id = $1 AND failed_at IS NULL`, [json.message_id]);
      // eslint-disable-next-line no-await-in-loop
      await drain(json.message_id);
    }
    const { rows } = await H.query(`SELECT attempt, failed_at, error FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(rows[0].attempt, MAX_ATTEMPTS);
    assert.ok(rows[0].failed_at);
    assert.equal(listener.received.length, MAX_ATTEMPTS);
    await listener.close();
  });

  test('a receiver that hangs past the timeout counts as a failed attempt, not a hung worker', async () => {
    const http = require('node:http');
    const srv = http.createServer(() => { /* never responds */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/slow`;
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    const started = Date.now();
    await drain(json.message_id);
    const elapsed = Date.now() - started;
    const { rows } = await H.query(`SELECT attempt, status_code, error FROM webhook_deliveries WHERE message_id = $1`, [json.message_id]);
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].status_code, null);
    assert.match(rows[0].error, /timeout/i);
    assert.ok(elapsed < H.config.webhookTimeoutMs + 5000, `worker took ${elapsed}ms; the timeout is ${H.config.webhookTimeoutMs}ms`);
    srv.close();
  });

  test('a paused mailbox stores and lists mail but sends no webhook', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    await H.req(`/v1/mailboxes/${mb.id}`, { method: 'PATCH', key, body: { paused: true } });
    const { json } = await H.deliver(mb, { wait: true });
    await drain(json.message_id);
    assert.equal(listener.received.length, 0);
    const { json: got } = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.equal(got.id, json.message_id);
    await listener.close();
  });
});

describe('the signature', () => {
  test('round-trips, and rejects a tampered body, a wrong secret and a stale timestamp', () => {
    const body = JSON.stringify({ id: 'msg_1', fields: {} });
    const s = sign('sekrit', body);
    assert.match(s.header, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(verify('sekrit', body, s.header), true);
    assert.equal(verify('sekrit', `${body} `, s.header), false, 'a changed body must not verify');
    assert.equal(verify('other', body, s.header), false, 'a wrong secret must not verify');
    const stale = sign('sekrit', body, Math.floor(Date.now() / 1000) - 4000);
    assert.equal(verify('sekrit', body, stale.header), false, 'a replayed old signature must not verify');
  });
});
