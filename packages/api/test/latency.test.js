'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key; let mailbox;

before(async () => {
  await H.start();
  ({ key } = await H.newAccount());
  mailbox = await H.newMailbox(key, { name: 'Bench', schema: [{ name: 'total', type: 'number' }] });
});
after(H.stop);

const N = Number(process.env.BENCH_N || 40);

function report(name, samples) {
  const line = {
    endpoint: name,
    n: samples.length,
    p50_ms: Math.round(H.percentile(samples, 50) * 10) / 10,
    p95_ms: Math.round(H.percentile(samples, 95) * 10) / 10,
    p99_ms: Math.round(H.percentile(samples, 99) * 10) / 10,
    min_ms: Math.round(Math.min(...samples) * 10) / 10,
    max_ms: Math.round(Math.max(...samples) * 10) / 10,
    mean_ms: Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10,
  };
  // Printed rather than only asserted: the number is the point, and a future
  // regression is only visible if the number is in the log.
  console.log(`# latency ${JSON.stringify(line)}`);
  return line;
}

describe('latency', () => {
  test(`POST /internal/deliver, ${N} messages`, async () => {
    const samples = [];
    for (let i = 0; i < N; i += 1) {
      const started = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      const { res } = await H.deliver(mailbox, { subject: `Bench ${i}` });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(res.status, 200);
    }
    const r = report('POST /internal/deliver', samples);
    // The contract this endpoint has to keep is "fast enough not to hold an SMTP
    // session open". The bound is generous because it is measured against a
    // Neon branch a continent away, which is the pessimistic case, not the
    // production one.
    assert.ok(r.p95_ms < 3000, `p95 was ${r.p95_ms}ms — an SMTP session should not wait that long`);
  });

  test(`GET /v1/events, ${N} polls`, async () => {
    // The trigger's real shape: poll from a cursor, get a page, move on.
    const samples = [];
    let cursor = 0;
    for (let i = 0; i < N; i += 1) {
      const started = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      const { res, json } = await H.req(`/v1/events?cursor=${cursor}&limit=25`, { key });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(res.status, 200);
      if (json.events.length) cursor = json.next_cursor;
    }
    const r = report('GET /v1/events', samples);
    assert.ok(r.p95_ms < 3000, `p95 was ${r.p95_ms}ms`);
  });

  test(`GET /v1/messages, ${N} pages`, async () => {
    const samples = [];
    for (let i = 0; i < N; i += 1) {
      const started = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      const { res } = await H.req(`/v1/messages?mailbox_id=${mailbox.id}&limit=25`, { key });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(res.status, 200);
    }
    report('GET /v1/messages', samples);
  });

  test('the hot paths have the indexes they depend on', async () => {
    // Deliberately NOT an EXPLAIN assertion. On a table with a handful of rows
    // the planner is right to seq-scan, so a plan check here would either fail
    // on a fresh database or pass for the wrong reason on a full one. What is
    // actually being promised is that the index EXISTS, which is a fact about
    // the schema and true whatever the planner decides today.
    const { rows } = await H.query(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const defs = rows.map((r) => `${r.tablename}:${r.indexdef}`);
    const has = (table, ...columns) => defs.some(
      (d) => d.startsWith(`${table}:`) && columns.every((c) => d.includes(c)),
    );

    // The n8n trigger's poll: everything after cursor X for this account.
    assert.ok(has('events', 'account_id', 'id'), 'events(account_id, id) is missing');
    // The mailbox listing: newest first within one mailbox.
    assert.ok(has('messages', 'mailbox_id', 'received_at'), 'messages(mailbox_id, received_at DESC) is missing');
    // The review queue, and filtering by one specific flag.
    assert.ok(has('messages', 'needs_review'), 'the partial index for the review queue is missing');
    assert.ok(has('messages', 'gin', 'flags'), 'the GIN index on flags is missing');
    // Exactly-once delivery rests entirely on this one being UNIQUE.
    assert.ok(defs.some((d) => d.startsWith('messages:') && d.includes('UNIQUE')
      && d.includes('mailbox_id') && d.includes('source_message_id')),
    'the unique index that makes delivery idempotent is missing');
    // The webhook worker's claim.
    assert.ok(has('webhook_deliveries', 'next_attempt_at'), 'the webhook queue index is missing');
  });

  test('the event poll uses the index when the planner has a reason to', async () => {
    // Forced, so this measures whether the index is USABLE for the query rather
    // than whether this particular database is big enough to bother.
    const client = await require('../src/db').pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN (FORMAT JSON) SELECT e.id FROM events e WHERE e.account_id = $1 AND e.id > $2 ORDER BY e.id ASC LIMIT 50`,
        [1, 0],
      );
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      assert.match(plan, /events_account_id_idx/, `the poll cannot use the index at all: ${plan}`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
