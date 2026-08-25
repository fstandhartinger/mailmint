'use strict';

// §6 is graded by a log reader, so this file asserts on the actual bytes written
// to stdout. It must set the level before helpers.js pins it.
process.env.LOG_LEVEL = 'info';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * Tees stdout into an array. The real `process.stdout.write` still runs, so the
 * test output is unaffected and what is asserted on is exactly what a log
 * collector would receive.
 */
const lines = [];
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const line of s.split('\n')) {
    if (line.startsWith('{')) {
      try { lines.push(JSON.parse(line)); } catch { /* not one of ours */ }
    }
  }
  return original(chunk, ...rest);
};

const since = (n) => lines.slice(n);
const find = (from, event) => since(from).filter((l) => l.event === event);

let key; let mailbox; let mark;

before(async () => {
  await H.start();
  ({ key } = await H.newAccount());
  mailbox = await H.newMailbox(key, { name: 'Logs', schema: [{ name: 'total', type: 'number' }] });
});
after(() => { process.stdout.write = original; return H.stop(); });

describe('the log stream', () => {
  let messageId;

  test('every line is JSON with ts, level and event', async () => {
    mark = lines.length;
    await H.req('/v1/usage', { key });
    const recent = since(mark);
    assert.ok(recent.length, 'nothing was logged for a request');
    for (const l of recent) {
      assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/, JSON.stringify(l));
      assert.ok(['debug', 'info', 'warn', 'error'].includes(l.level), JSON.stringify(l));
      assert.ok(typeof l.event === 'string' && l.event.length, JSON.stringify(l));
    }
  });

  test('api.request carries method, path, status, ms, account and key prefix', async () => {
    mark = lines.length;
    await H.req('/v1/usage', { key });
    const [req] = find(mark, 'api.request');
    assert.ok(req, 'no api.request line was written');
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/v1/usage');
    assert.equal(req.status, 200);
    assert.equal(typeof req.ms, 'number');
    assert.equal(typeof req.account, 'number');
    assert.match(req.key_prefix, /^mm_live_/);
    assert.ok(req.request_id, 'every line needs a request_id');
  });

  test('a delivery writes mail.received, parse.start and parse.done, all under one request id', async () => {
    mark = lines.length;
    const { json } = await H.deliver(mailbox, { wait: true });
    messageId = json.message_id;

    const received = find(mark, 'mail.received').find((l) => l.message_id === messageId);
    assert.ok(received, 'no mail.received');
    assert.equal(received.mailbox_id, mailbox.id);
    assert.equal(typeof received.size, 'number');
    assert.equal(received.from, 'billing@acme.com');

    const start = find(mark, 'parse.start').find((l) => l.message_id === messageId);
    assert.ok(start, 'no parse.start');
    assert.equal(start.schema_fields, 1);

    const done = find(mark, 'parse.done').find((l) => l.message_id === messageId);
    assert.ok(done, 'no parse.done');
    // The four things the daily observer reads.
    assert.equal(typeof done.timings_ms, 'object');
    assert.equal(typeof done.timings_ms.total, 'number');
    assert.ok('model' in done, 'parse.done must name the model, or null when none ran');
    assert.equal(typeof done.field_count, 'number');
    assert.ok('mean_confidence' in done);
    assert.ok(Array.isArray(done.flags));
    assert.equal(typeof done.needs_review, 'boolean');

    // One request, one id, all the way through.
    assert.equal(received.request_id, start.request_id);
    assert.equal(start.request_id, done.request_id);
    assert.ok(received.request_id.startsWith('req_'));
  });

  test('webhook.attempt records the outcome of every attempt', async () => {
    const listener = H.webhookListener((n) => (n === 0 ? 500 : 200));
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    mark = lines.length;

    await H.flushWebhooks(json.message_id);
    await H.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE message_id = $1`, [json.message_id]);
    await H.flushWebhooks(json.message_id);

    const attempts = find(mark, 'webhook.attempt').filter((l) => l.message_id === json.message_id);
    assert.equal(attempts.length, 2, `expected two attempts, got ${attempts.length}`);
    assert.equal(attempts[0].attempt, 1);
    assert.equal(attempts[0].status, 500);
    assert.equal(attempts[0].ok, false);
    assert.equal(attempts[1].attempt, 2);
    assert.equal(attempts[1].ok, true);
    for (const a of attempts) {
      assert.equal(typeof a.ms, 'number');
      assert.equal(a.url, url);
      assert.match(a.delivery_id, /^dlv_/);
    }
    await listener.close();
  });

  test('webhook.failed is written when it gives up', async () => {
    const listener = H.webhookListener(() => 410);
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const { json } = await H.deliver(mb, { wait: true });
    mark = lines.length;
    await H.flushWebhooks(json.message_id);
    const [failed] = find(mark, 'webhook.failed').filter((l) => l.message_id === json.message_id);
    assert.ok(failed, 'giving up must be logged, not silent');
    assert.equal(failed.reason, 'non_retriable_status');
    assert.equal(failed.status, 410);
    await listener.close();
  });

  test('no body, no password and no key ever reaches the log', async () => {
    mark = lines.length;
    // A message with something that looks like a secret in it, and a signup with
    // a real password, both through the paths that log the most.
    await H.deliver(mailbox, {
      wait: true,
      raw: H.rawMime({ to: mailbox.address, subject: 'Secret', text: 'password: hunter2-do-not-log\r\nTotal: $1.00\r\n' }),
    });
    await H.req('/signup', { method: 'POST', form: true, body: { email: `log-${Date.now()}@example.com`, password: 'supersecret-password' } });

    const blob = JSON.stringify(since(mark));
    assert.equal(blob.includes('hunter2-do-not-log'), false, 'a message body reached the log');
    assert.equal(blob.includes('supersecret-password'), false, 'a password reached the log');
    assert.equal(/mm_live_[A-Za-z0-9_-]{20,}/.test(blob), false, 'a full API key reached the log');
  });

  test('a rejected request is logged at warn with its code, not swallowed', async () => {
    mark = lines.length;
    await H.req('/v1/mailboxes', { key: 'mm_live_definitely-not-a-key' });
    const [rejected] = find(mark, 'api.rejected');
    assert.ok(rejected, 'a 401 must leave a trace');
    assert.equal(rejected.level, 'warn');
    assert.equal(rejected.code, 'invalid_api_key');
  });
});
