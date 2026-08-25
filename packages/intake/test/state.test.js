'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { FileStateStore, ApiStateStore, FallbackStateStore, createStore, pushBounded, idHash, MAX_SEEN } = require('../src/state');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mailmint-state-')), 'state.json');

test('the file store round-trips and writes atomically', async () => {
  const file = tmp();
  const s = new FileStateStore(file);
  assert.deepEqual((await s.get('c1')).cursor, null);
  await s.set('c1', { validity: '12', cursor: '99', seen: ['a'], seen_message_ids: [] });
  const back = await s.get('c1');
  assert.equal(back.cursor, '99');
  assert.ok(back.updated_at);
  // No temp file is left lying around next to it.
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('several connections share one file without clobbering each other', async () => {
  const file = tmp();
  const s = new FileStateStore(file);
  await Promise.all([
    s.set('a', { cursor: '1' }), s.set('b', { cursor: '2' }), s.set('c', { cursor: '3' }),
  ]);
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(all.connections).sort(), ['a', 'b', 'c']);
  assert.equal(all.connections.b.cursor, '2');
});

test('the seen list is bounded and keeps the most recent entries', () => {
  const list = [];
  for (let i = 0; i < MAX_SEEN + 50; i += 1) pushBounded(list, `k${i}`);
  assert.equal(list.length, MAX_SEEN);
  assert.equal(list[list.length - 1], `k${MAX_SEEN + 49}`);
  assert.ok(!list.includes('k0'));
  // Re-seeing a key moves it to the end rather than duplicating it.
  pushBounded(list, list[10]);
  assert.equal(list.length, MAX_SEEN);
});

test('Message-IDs are stored as hashes, never in the clear', () => {
  const h = idHash('<Secret-Customer-ID@acme.example>');
  assert.equal(h.length, 24);
  assert.ok(!h.includes('acme'));
  // Case and whitespace insensitive, because servers are inconsistent.
  assert.equal(h, idHash('  <secret-customer-id@acme.example> '));
  assert.equal(idHash(null), null);
});

test('the API store falls back to the file when the endpoint is not deployed', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const warnings = [];
  const store = createStore({
    apiUrl: url, secret: 's', file: tmp(),
    logger: { warn: (e, f) => warnings.push({ e, f }), info() {}, error() {}, debug() {} },
  });
  assert.ok(store instanceof FallbackStateStore);
  const s = await store.get('c1');
  assert.equal(s.cursor, null);
  assert.equal(store.apiUsable, false);
  assert.equal(warnings[0].e, 'connector.state.api_unavailable');
  await store.set('c1', { cursor: '5' });
  assert.equal((await store.get('c1')).cursor, '5');
  await new Promise((r) => server.close(r));
});

test('the API store is used when the endpoint answers', async () => {
  const kept = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') {
        res.end(JSON.stringify({ state: kept.get(u.searchParams.get('connection_id')) || {} }));
      } else {
        const b = JSON.parse(Buffer.concat(chunks).toString());
        kept.set(b.connection_id, b.state);
        res.end('{"ok":true}');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = new ApiStateStore({ apiUrl: `http://127.0.0.1:${server.address().port}`, secret: 's' });
  await api.set('c9', { cursor: '77' });
  assert.equal((await api.get('c9')).cursor, '77');
  await new Promise((r) => server.close(r));
});
