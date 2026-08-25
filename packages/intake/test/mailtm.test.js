'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { MailTmProvider } = require('../src/providers/mailtm');

/** A stand-in for api.mail.tm, including the expired-token path. */
function fakeMailTm(opts = {}) {
  const messages = opts.messages || [];
  const state = { validToken: 'tok-good', tokenCalls: 0, requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      state.requests.push(`${req.method} ${u.pathname}${u.search}`);
      const send = (status, obj) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length });
        res.end(b);
      };
      if (u.pathname === '/token') {
        state.tokenCalls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.password !== 'pw') return send(401, { message: 'bad credentials' });
        state.validToken = `tok-refreshed-${state.tokenCalls}`;
        return send(200, { token: state.validToken, id: 'acct-1' });
      }
      if (req.headers.authorization !== `Bearer ${state.validToken}`) {
        return send(401, { message: 'Expired JWT Token' });
      }
      if (u.pathname === '/me') return send(200, { id: 'acct-1', address: 'mm@example.test', used: 1, quota: 40 });
      if (u.pathname === '/messages') {
        const page = Number(u.searchParams.get('page') || 1);
        const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return send(200, sorted.slice((page - 1) * 30, page * 30));
      }
      const m = /^\/sources\/(.+)$/.exec(u.pathname);
      if (m) {
        const msg = messages.find((x) => x.id === m[1]);
        if (!msg) return send(404, { message: 'not found' });
        return send(200, { id: msg.id, data: msg.raw });
      }
      return send(404, { message: 'not found' });
    });
  });
  return { server, state, messages };
}

function msg(i, extra = {}) {
  const id = `id${i}`;
  const raw = [
    `Message-ID: <m${i}@example.test>`,
    'From: Sender <sender@example.test>',
    'To: mm@example.test',
    `Subject: message ${i}`,
    '', `body ${i}`, '',
  ].join('\r\n');
  return {
    id, msgid: `<m${i}@example.test>`, from: { address: 'sender@example.test' },
    to: [{ address: 'mm@example.test' }], subject: `message ${i}`, seen: false,
    size: raw.length, createdAt: `2026-08-25T08:0${i}:00+00:00`, raw, ...extra,
  };
}

async function withMailTm(opts, fn) {
  const f = fakeMailTm(opts);
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${f.server.address().port}`;
  try { return await fn(base, f); } finally { await new Promise((r) => f.server.close(r)); }
}

test('mail.tm provider lists, fetches and advances its cursor', async () => {
  await withMailTm({ messages: [msg(1), msg(2), msg(3)] }, async (base, f) => {
    const p = new MailTmProvider({ apiBase: base, address: 'mm@example.test', password: 'pw', token: 'tok-good' });
    const opened = await p.open();
    assert.equal(opened.validity, 'acct:acct-1');

    const first = await p.list({ sinceCursor: null, limit: 10 });
    assert.equal(first.items.length, 3);
    // Ascending, oldest first: the connector relies on that ordering to be
    // able to stop at the first failure.
    assert.deepEqual(first.items.map((i) => i.key), ['id1', 'id2', 'id3']);
    assert.equal(first.items[0].messageId, '<m1@example.test>');

    const raw = await p.fetch(first.items[0]);
    assert.match(raw.raw.toString('utf8'), /Subject: message 1/);

    const after = await p.list({ sinceCursor: first.items[2].cursor, limit: 10 });
    assert.equal(after.items.length, 0);

    f.messages.push(msg(4));
    const next = await p.list({ sinceCursor: first.items[2].cursor, limit: 10 });
    assert.deepEqual(next.items.map((i) => i.key), ['id4']);
    await p.close();
  });
});

test('an expired bearer token is refreshed transparently, once', async () => {
  await withMailTm({ messages: [msg(1)] }, async (base, f) => {
    const p = new MailTmProvider({ apiBase: base, address: 'mm@example.test', password: 'pw', token: 'tok-stale' });
    await p.open();
    assert.equal(f.state.tokenCalls, 1, 'exactly one refresh');
    const l = await p.list({ sinceCursor: null, limit: 10 });
    assert.equal(l.items.length, 1);
    assert.equal(f.state.tokenCalls, 1, 'the refreshed token is reused, not re-fetched');
    await p.close();
  });
});

test('a token that cannot be refreshed is a permanent error', async () => {
  await withMailTm({ messages: [] }, async (base) => {
    const p = new MailTmProvider({ apiBase: base, address: 'mm@example.test', password: 'wrong', token: 'stale' });
    await assert.rejects(() => p.open(), /401|bad credentials/);
  });
});

test('a message over the cap is reported rather than downloaded', async () => {
  await withMailTm({ messages: [msg(1)] }, async (base) => {
    const p = new MailTmProvider({ apiBase: base, address: 'mm@example.test', password: 'pw', token: 'tok-good', maxMessageBytes: 10 });
    await p.open();
    const { items } = await p.list({ sinceCursor: null, limit: 10 });
    const r = await p.fetch(items[0]);
    assert.equal(r.raw, null);
    assert.equal(r.skipped, 'too_large');
    await p.close();
  });
});

test('a message deleted between listing and fetching is not an error', async () => {
  await withMailTm({ messages: [msg(1)] }, async (base, f) => {
    const p = new MailTmProvider({ apiBase: base, address: 'mm@example.test', password: 'pw', token: 'tok-good' });
    await p.open();
    const { items } = await p.list({ sinceCursor: null, limit: 10 });
    f.messages.length = 0;
    const r = await p.fetch(items[0]);
    assert.equal(r.raw, null);
    assert.equal(r.skipped, 'vanished');
    await p.close();
  });
});
