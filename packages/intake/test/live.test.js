'use strict';

/**
 * The real-server tests. They exercise the same code paths as the fake-server
 * suite against actual remote mailboxes, which is the only way to find out
 * that a server does something the RFC allows but nobody expects.
 *
 * Each one skips itself when its dependency is absent, so `npm test` still
 * works on a machine with no credentials and no network:
 *
 *   mail.tm   needs .local/inbox.json (gitignored; a live disposable inbox)
 *   Rebex     needs outbound TCP to test.rebex.net:993 (a public test server)
 *
 * Neither test writes to the remote mailbox: mail.tm is polled with markSeen
 * off, and Rebex is EXAMINEd read-only.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { Connector } = require('../src/connector');
const { MailTmProvider } = require('../src/providers/mailtm');
const { FakeApi } = require('./fake-api');

const CREDS = process.env.MAILTM_CREDENTIALS
  || path.resolve(__dirname, '../../../.local/inbox.json');
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mailmint-live-')), 'state.json');

function reachable(host, port, ms = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('LIVE mail.tm: real messages are pulled and handed to /internal/deliver', async (t) => {
  if (!fs.existsSync(CREDS)) return t.skip('no live inbox credentials at .local/inbox.json');
  if (!await reachable('api.mail.tm', 443)) return t.skip('api.mail.tm is not reachable');

  const api = new FakeApi({ supportsState: false });
  await api.listen();
  const c = new Connector({
    id: 'live-mailtm', provider: 'mailtm', mailbox_token: 'k7m2xq4h9bwz',
    credentialsFile: CREDS, markSeen: false,
    apiUrl: api.url, internalSecret: api.secret,
    stateFile: tmpState(), batchSize: 3,
  });
  try {
    let cycle = await c.runOnce();
    assert.ok(cycle.listed > 0, 'the live inbox should not be empty');
    assert.equal(cycle.failed, 0);
    assert.ok(api.delivered.length > 0);
    while (cycle.more) cycle = await c.runOnce();   // batchSize is 3; drain the rest

    const first = api.delivered[0];
    assert.equal(first.mailbox_token, 'k7m2xq4h9bwz');
    assert.equal(first.envelope.source, 'mailtm');
    assert.ok(first.raw.length > 100, 'the raw RFC822 should be the real message');
    assert.match(first.raw.toString('utf8'), /^(received|return-path|from|dkim-signature|message-id):/im);
    assert.ok(first.message_id && first.message_id.includes('@'), 'a real Message-ID rides along for dedupe');

    // Idempotency: a second pass over the same mailbox delivers nothing.
    const before = api.delivered.length;
    const again = await c.runOnce();
    assert.equal(again.delivered, 0);
    assert.equal(api.delivered.length, before);
  } finally {
    await c.close();
    await api.close();
  }
  return undefined;
});

test('LIVE mail.tm: the provider interface behaves the same as the IMAP one', async (t) => {
  if (!fs.existsSync(CREDS)) return t.skip('no live inbox credentials');
  if (!await reachable('api.mail.tm', 443)) return t.skip('api.mail.tm is not reachable');
  const p = MailTmProvider.fromCredentialsFile(CREDS);
  try {
    const { validity } = await p.open();
    assert.match(validity, /^acct:/);
    const { items } = await p.list({ sinceCursor: null, limit: 2 });
    assert.ok(items.length > 0);
    for (const it of items) {
      assert.ok(it.key && it.cursor && it.size > 0, JSON.stringify(it));
      assert.ok(it.receivedAt, 'receivedAt is what the delivery latency is measured from');
    }
    // Ascending order is a contract the connector depends on.
    assert.deepEqual(
      [...items].sort((a, b) => (a.cursor < b.cursor ? -1 : 1)).map((i) => i.key),
      items.map((i) => i.key),
    );
    const fetched = await p.fetch(items[0]);
    assert.ok(Buffer.isBuffer(fetched.raw));
    assert.equal(fetched.raw.length, fetched.size);
  } finally { await p.close(); }
  return undefined;
});

test('LIVE Rebex: a third-party IMAP server with no IDLE, read-only', async (t) => {
  if (!await reachable('test.rebex.net', 993)) return t.skip('test.rebex.net:993 is not reachable');

  const api = new FakeApi({ supportsState: false });
  await api.listen();
  const c = new Connector({
    id: 'live-rebex', provider: 'imap', mailbox_token: 'k7m2xq4h9bwz',
    host: 'test.rebex.net', port: 993, secure: true,
    tlsOptions: { rejectUnauthorized: false },
    user: 'demo', pass: 'password',
    initial: 'all', readOnly: true, markSeen: false,
    apiUrl: api.url, internalSecret: api.secret, stateFile: tmpState(),
  });
  try {
    const cycle = await c.runOnce();
    assert.ok(cycle.delivered >= 1, 'the public test mailbox has messages in it');
    assert.equal(cycle.failed, 0);
    // This server does not advertise IDLE, which is exactly why the fallback
    // exists: most cheap IMAP hosting is like this.
    assert.equal(c.provider.capabilities.push, false);
    assert.equal(c.provider.client.selected.readOnly, true, 'EXAMINE, so no flags are touched');
    const again = await c.runOnce();
    assert.equal(again.delivered, 0);
  } finally {
    await c.close();
    await api.close();
  }
  return undefined;
});
