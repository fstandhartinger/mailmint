'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers');
const resume = require('../src/resume');

/**
 * A message is written and answered for before it is parsed. If the process
 * dies in between, the row stays at `status = 'received'` — accepted, stored,
 * and then never parsed, never emitted as an event, never delivered. Nothing
 * used to notice.
 *
 * The crash is simulated the only way it can be from inside one process: the
 * row is put into exactly the state a crash leaves it in — `received`, with a
 * `received_at` older than the grace period — and the sweeper is asked to run.
 */

let key;
let accountId;

before(async () => { await H.start(); ({ key, accountId } = await H.newAccount()); });
after(H.stop);

/** Delivers a message and then rewinds it into the state a crash would leave. */
async function stranded(mailbox, { minutesAgo = 60, attempts = 0 } = {}) {
  const messageId = `stranded-${crypto.randomBytes(6).toString('hex')}@acme.com`;
  const r = await H.deliver(mailbox, {
    raw: H.rawMime({ to: mailbox.address, subject: 'Invoice INV-500', extra: [`Message-Id: <${messageId}>`] }),
    wait: true,
  });
  assert.equal(r.res.status, 200);
  const id = r.json.message_id;
  await H.query(
    `UPDATE messages SET status = 'received', result = NULL, flags = '{}', needs_review = false,
            parse_attempts = $2, received_at = now() - ($3 || ' minutes')::interval
      WHERE id = $1`,
    [id, attempts, String(minutesAgo)],
  );
  await H.query(`DELETE FROM events WHERE message_id = $1`, [id]);
  await H.query(`DELETE FROM webhook_deliveries WHERE message_id = $1`, [id]);
  return id;
}

const statusOf = async (id) => (await H.query(`SELECT status, error, parse_attempts FROM messages WHERE id = $1`, [id])).rows[0];

describe('a message accepted before a crash is still parsed afterwards', () => {
  test('the sweeper re-drives it, emits its event and queues its webhook', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url });
    const id = await stranded(mb);

    assert.equal((await statusOf(id)).status, 'received', 'precondition: it really is stranded');
    const resumed = await resume.sweep();
    assert.ok(resumed >= 1, 'the sweeper must find it');

    const row = await statusOf(id);
    assert.equal(row.status, 'parsed', 'a message that was accepted must end up parsed');
    assert.equal(row.parse_attempts, 1);

    const { rows: events } = await H.query(`SELECT type FROM events WHERE message_id = $1`, [id]);
    assert.deepEqual(events.map((e) => e.type), ['message.parsed'],
      'the poller and the n8n trigger only ever see what the event feed shows');

    const { rows: deliveries } = await H.query(`SELECT id FROM webhook_deliveries WHERE message_id = $1`, [id]);
    assert.equal(deliveries.length, 1, 'and the webhook is queued, not skipped');
    await H.flushWebhooks(id);
    assert.equal(listener.received.length, 1);
    await listener.close();
  });

  test('a message still inside the grace period is left alone', async () => {
    const mb = await H.newMailbox(key);
    const id = await stranded(mb, { minutesAgo: 1 });
    await resume.sweep();
    assert.equal((await statusOf(id)).status, 'received',
      'a parse that may still be running must not be started a second time');
    // Clean up so it does not haunt a later sweep in this suite.
    await H.query(`UPDATE messages SET status = 'parsed' WHERE id = $1`, [id]);
  });

  test('a resumed parse is not billed a second time', async () => {
    const mb = await H.newMailbox(key);
    const id = await stranded(mb);
    const before = (await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId])).rows[0].used_month;
    await resume.sweep();
    const after = (await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId])).rows[0].used_month;
    assert.equal(after, before,
      'the customer was already charged for the attempt that died and got nothing for it');
    assert.equal((await statusOf(id)).status, 'parsed');
  });

  test('mail too old to bring back is left exactly as it is', async () => {
    const mb = await H.newMailbox(key);
    const id = await stranded(mb, { minutesAgo: 60 * 24 * 30 });   // a month
    await resume.sweep();
    const row = await statusOf(id);
    assert.equal(row.status, 'received', 'a month-old message is not resurrected into a live workflow');
    assert.equal(row.parse_attempts, 0, 'and it is not even claimed, so the counter does not creep');
    await H.query(`DELETE FROM messages WHERE id = $1`, [id]);
  });

  test('a message that will not parse is abandoned rather than retried for ever', async () => {
    const mb = await H.newMailbox(key);
    const id = await stranded(mb, { attempts: resume.MAX_ATTEMPTS });
    // The suite shares a database, so the sweep may legitimately pick up other
    // rows as well. What matters is what happened to THIS one.
    await resume.sweep();
    const row = await statusOf(id);
    assert.notEqual(row.status, 'parsed', 'it must not be re-driven a fourth time');
    assert.equal(row.status, 'failed', 'it is marked failed, which is visible and stops the loop');
    assert.equal(row.error.code, 'parse_abandoned');
    assert.match(row.error.hint, /reparse/, 'and the way out is stated');

    const { rows: events } = await H.query(`SELECT type FROM events WHERE message_id = $1`, [id]);
    assert.deepEqual(events.map((e) => e.type), ['message.failed'],
      'giving up is itself an event, so a customer can see it happened');

    // The bytes are still there, so the operator's way out really works.
    const again = await H.req(`/v1/messages/${id}/reparse`, { method: 'POST', key, body: {} });
    assert.equal(again.res.status, 200, JSON.stringify(again.json));
    assert.equal((await statusOf(id)).status, 'parsed');
  });

  test('two sweepers running at once do not take the same message', async () => {
    const mb = await H.newMailbox(key);
    const id = await stranded(mb);
    const [a, b] = await Promise.all([resume.claim(), resume.claim()]);
    const got = [a, b].filter((m) => m && m.id === id);
    assert.equal(got.length, 1, 'exactly one claim may win');
    assert.equal(got[0].parse_attempts, 1, 'and the counter moves exactly once');
    await H.query(`UPDATE messages SET status = 'parsed' WHERE id = $1`, [id]);
  });
});
