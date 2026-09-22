'use strict';

/**
 * reaper.js — the retention wiring the consent record and the privacy page
 * promise: `reap()` must issue the 13-month deletes on the two statistics
 * tables, and a failure there must not take the product-data deletes down
 * with it (PRD VS-3 §3.5c). A refactor that dropped `applyRetention()` from
 * the reaper would otherwise go unnoticed until the tables grew for ever.
 *
 * NO database: src/db is replaced in require.cache by a recording stub BEFORE
 * anything requires it, so this file runs with no DATABASE_URL. analytics.js
 * requires ./db lazily and reaper.js destructures it once at load, so the
 * stub delegates to a per-test implementation — reinstalling the cache entry
 * between tests would not reach the reference reaper already took.
 */

process.env.LOG_LEVEL = 'error'; // keep the expected-failure warn lines out of the tap output

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_PATH = require.resolve('../src/db'); // resolves without executing db.js

let impl = async () => ({ rows: [], rowCount: 0 });
require.cache[DB_PATH] = {
  id: DB_PATH,
  filename: DB_PATH,
  loaded: true,
  exports: { query: (sql, params) => impl(sql, params) },
};

const { reap } = require('../src/reaper');

test('reap() issues both analytics retention deletes and returns their rowCount sum', async () => {
  const seen = [];
  impl = async (sql) => {
    const s = String(sql);
    seen.push(s);
    if (s.includes('analytics_visit_daily')) return { rows: [], rowCount: 5 };
    if (s.includes('analytics_events')) return { rows: [], rowCount: 7 };
    return { rows: [], rowCount: 1 };
  };
  const out = await reap();
  assert.ok(out && typeof out === 'object', 'reap() returned its counts object');
  assert.ok(
    seen.some((s) => s.includes('DELETE FROM analytics_visit_daily')),
    'a DELETE on analytics_visit_daily was issued',
  );
  assert.ok(
    seen.some((s) => s.includes('DELETE FROM analytics_events')),
    'a DELETE on analytics_events was issued',
  );
  assert.equal(out.analytics, 12, 'out.analytics is 5 deleted visit rows + 7 deleted event rows');
});

test('a failing analytics delete still returns the product counts, without out.analytics', async () => {
  impl = async (sql) => {
    const s = String(sql);
    if (s.includes('analytics_')) throw new Error('synthetic analytics failure');
    return { rows: [], rowCount: 2 };
  };
  const out = await reap();
  assert.ok(out && typeof out === 'object', 'reap() did not collapse to null');
  for (const key of ['blobs', 'events', 'messages', 'deliveries', 'reparse_jobs', 'sessions', 'usage']) {
    assert.equal(out[key], 2, `${key} was still reaped`);
  }
  assert.equal(out.analytics, undefined, 'the failed analytics step adds no count');
});
