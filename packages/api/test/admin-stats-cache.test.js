'use strict';

/**
 * `/admin/stats` (the operator HTML page) must send `Cache-Control: no-store`
 * on the authorized answer, like both JSON operator endpoints already do —
 * and the 404 everyone else gets stays exactly as it is (PRD VS-3 §3.3).
 *
 * NO database: src/db is replaced in require.cache by a stub before anything
 * requires it, so this file runs with no DATABASE_URL. The stub answers the
 * one session/account join (`accountForSession` in src/auth.js) with a fake
 * documentation account and every statistics report query with no rows. The
 * app listens on an ephemeral loopback port that the test closes again.
 *
 * `MAILMINT_ADMIN_EMAILS` is read by config.js at load, so it is set before
 * anything under src/ is required.
 */

process.env.LOG_LEVEL = 'error';
process.env.MAILMINT_ADMIN_EMAILS = 'ops@example.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const DB_PATH = require.resolve('../src/db'); // resolves without executing db.js

const ACCOUNT = {
  id: 1,
  email: 'ops@example.test',
  plan: 'free',
  used_month: 0,
  quota_month: 300,
  // A period_start inside the current UTC month makes rollPeriod() in
  // src/auth.js return the row unchanged instead of issuing an UPDATE.
  period_start: new Date(),
  stripe_customer_id: null,
};

require.cache[DB_PATH] = {
  id: DB_PATH,
  filename: DB_PATH,
  loaded: true,
  exports: {
    query: async (sql) => {
      const s = String(sql);
      if (s.includes('FROM sessions') && s.includes('JOIN accounts')) {
        return { rows: [ACCOUNT], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
};

const { router } = require('../src/web');

test('/admin/stats: no-store for the operator, the ordinary 404 for everyone else', async (t) => {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The session cookie name is SESSION_COOKIE in src/web.js.
  const authed = await fetch(`${base}/admin/stats`, {
    headers: { cookie: 'mailmint_session=test' },
  });
  assert.equal(authed.status, 200, 'the admin-listed account sees the report');
  assert.equal(authed.headers.get('cache-control'), 'no-store',
    'operator HTML answers no cache, like the JSON endpoints');
  await authed.arrayBuffer(); // drain the body so the socket can close

  const anon = await fetch(`${base}/admin/stats`);
  assert.equal(anon.status, 404, 'no session: the same answer as for a URL with nothing behind it');
  assert.notEqual(anon.headers.get('cache-control'), 'no-store',
    'the 404 is untouched');
  await anon.arrayBuffer();
});
