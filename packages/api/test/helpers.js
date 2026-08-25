'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

/**
 * These tests run against a real Postgres — a Neon branch named `test` on the
 * `mailmint` project — a real HTTP server, a real webhook receiver and real
 * HMAC verification done with node:crypto rather than with our own signer.
 * Nothing here is mocked, and nothing asserts on the shape of the code.
 *
 * Set DATABASE_URL (or MAILMINT_TEST_DATABASE_URL) before running.
 */
process.env.INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'test-internal-secret';
process.env.INBOUND_DOMAIN = process.env.INBOUND_DOMAIN || 'parse.mailmint.test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
if (process.env.MAILMINT_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.MAILMINT_TEST_DATABASE_URL;
// The suite drives the worker by hand where it asserts on the retry schedule,
// so the background loop is off unless a test asks for it.
process.env.WEBHOOK_WORKER = '0';

const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const { query, pool } = require('../src/db');
const { config } = require('../src/config');
const webhooks = require('../src/webhooks');

let server = null;
let base = null;

async function start() {
  if (base) return base;
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set; these tests need a real Postgres.');
  await migrate();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stop() {
  if (server) {
    // fetch() keeps its connections alive, and server.close() waits for every
    // one of them. Without closeAllConnections() the suite finishes and then
    // sits there until the far end times out, which reads as a hang.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await pool.end().catch(() => {});
  // The parser's LLM call opens an outbound HTTPS socket that Node also keeps
  // alive by default. Same problem, other direction.
  require('node:https').globalAgent.destroy();
  require('node:http').globalAgent.destroy();
}

async function req(path, { method = 'GET', key, body, headers = {}, raw = false, form = false, cookie } = {}) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); } else {
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
  if (raw) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, text, json };
}

const internal = (path, body) => req(path, {
  method: 'POST', body, headers: { 'x-mailmint-internal': process.env.INTERNAL_SECRET },
});

/** Signs up through the real form, then reads the key off the dashboard once. */
async function newAccount() {
  const email = `t-${crypto.randomBytes(6).toString('hex')}@mailmint-test.example`;
  const { res } = await req('/signup', { method: 'POST', form: true, body: { email, password: 'testpassword123' } });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`signup set no session cookie (status ${res.status})`);
  const dash = await req('/dashboard', { cookie });
  const key = (dash.text.match(/mm_live_[A-Za-z0-9_-]{20,}/) || [])[0];
  if (!key) throw new Error(`the dashboard did not show a key (status ${dash.res.status})`);
  const { rows } = await query(`SELECT id FROM accounts WHERE email = $1`, [email]);
  return { email, key, cookie, accountId: Number(rows[0].id) };
}

async function newMailbox(key, opts = {}) {
  const { json, res } = await req('/v1/mailboxes', { method: 'POST', key, body: { name: 'Test', ...opts } });
  if (res.status !== 201) throw new Error(`could not create a mailbox: ${res.status} ${JSON.stringify(json)}`);
  return json.mailbox;
}

/**
 * A real HTTP receiver. `respond` decides the status per call, so a test can
 * make the first attempt fail and the second succeed and watch the queue do
 * the right thing.
 */
function webhookListener(respond = () => 200) {
  const received = [];
  const srv = http.createServer((r, res) => {
    let data = '';
    r.on('data', (c) => { data += c; });
    r.on('end', () => {
      const status = respond(received.length, r, data);
      received.push({ headers: r.headers, body: data, at: Date.now() });
      res.writeHead(status || 200, { 'Content-Type': 'text/plain' });
      res.end(status >= 200 && status < 300 ? 'ok' : 'no');
    });
  });
  return {
    received,
    async listen() {
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${srv.address().port}/hook`;
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

/**
 * Verifies a §5 signature from scratch — parsing the header and recomputing the
 * HMAC here rather than calling our own verify(), so a signer that is wrong in
 * a way our verifier agrees with still fails the test.
 */
function verifySignatureIndependently(secret, rawBody, header) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return { ok: false, why: `header does not match t=<unix>,v1=<64 hex>: ${header}` };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(m[1]));
  if (age > 300) return { ok: false, why: `timestamp is ${age}s away from now` };
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex');
  return { ok: expected === m[2], why: expected === m[2] ? null : 'digest mismatch', timestamp: Number(m[1]) };
}

const rawMime = ({ from = 'billing@acme.com', to, subject = 'Invoice INV-2291 from Acme Ltd', text = 'Total: $31.50\r\nDue: Sep 8, 2026\r\n', extra = [] } = {}) => Buffer.from([
  `From: Acme Billing <${from}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-Id: <${crypto.randomBytes(8).toString('hex')}@acme.com>`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  ...extra,
  '', text,
].join('\r\n'), 'utf8');

const deliver = (mailbox, opts = {}) => internal('/internal/deliver', {
  envelope: {
    from: opts.from || 'billing@acme.com',
    to: [opts.to || mailbox.address],
    helo: 'mail.acme.com', remote_ip: '209.85.128.51', tls: true,
    ...(opts.envelope || {}),
  },
  raw_mime: (opts.raw || rawMime({ to: mailbox.address, ...opts })).toString('base64'),
  ...(opts.wait ? { wait: true } : {}),
});

/**
 * Runs the webhook worker's inner step against ONE message's deliveries.
 *
 * The queue is global and the suite shares a database, so a plain claim() picks
 * up whatever is oldest — including a retry another test deliberately left
 * pending. Targeting the message makes each test's assertion about its own
 * delivery and nothing else.
 */
async function flushWebhooks(messageId, rounds = 1) {
  const done = [];
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await query(
      `SELECT * FROM webhook_deliveries
        WHERE message_id = $1 AND delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()`,
      [messageId],
    );
    if (!rows.length) return done;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await webhooks.attemptOnce(row);
      done.push(row.id);
    }
  }
  return done;
}

/** Polls until `fn` returns something truthy, or gives up. Background parses are async. */
async function until(fn, { timeoutMs = 15000, everyMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const percentile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

module.exports = {
  start, stop, req, internal, newAccount, newMailbox, webhookListener, flushWebhooks,
  verifySignatureIndependently, rawMime, deliver, until, percentile, query, webhooks, config,
  get base() { return base; },
};
