'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Connector } = require('../src/connector');
const { FakeImapServer, makeMessage } = require('./fake-imap-server');
const { FakeApi } = require('./fake-api');

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mailmint-intake-')), 'state.json');
}

async function rig(opts = {}) {
  const messages = opts.messages || [
    makeMessage({ uid: 100, messageId: 'a@example.test', subject: 'one' }),
    makeMessage({ uid: 101, messageId: 'b@example.test', subject: 'two' }),
    makeMessage({ uid: 102, messageId: 'c@example.test', subject: 'three' }),
  ];
  const imap = new FakeImapServer({ messages, ...(opts.server || {}) });
  await imap.listen(0);
  const api = new FakeApi({ supportsState: opts.supportsState !== false, dedupe: opts.dedupe });
  await api.listen();
  const stateFile = opts.stateFile || tmpState();
  const conf = {
    id: 'conn_test',
    provider: 'imap',
    mailbox_token: 'k7m2xq4h9bwz',
    host: '127.0.0.1', port: imap.port, secure: false, starttls: false,
    user: imap.user, pass: imap.pass,
    initial: 'all',
    apiUrl: api.url, internalSecret: api.secret,
    stateFile,
    ...(opts.conf || {}),
  };
  const connector = new Connector(conf);
  return {
    imap, api, connector, stateFile, conf, messages,
    async close() { await connector.close().catch(() => {}); await imap.close(); await api.close(); },
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).connections.conn_test,
  };
}

test('delivers every message once, advances the mark, and does not repeat itself', async () => {
  const r = await rig();
  try {
    const first = await r.connector.runOnce();
    assert.equal(first.delivered, 3);
    assert.equal(r.api.delivered.length, 3);
    assert.deepEqual(r.api.delivered.map((d) => d.message_id),
      ['<a@example.test>', '<b@example.test>', '<c@example.test>']);
    assert.equal(r.api.delivered[0].mailbox_token, 'k7m2xq4h9bwz');
    assert.deepEqual(r.api.delivered[0].envelope, {
      from: 'sender@example.test',
      to: ['k7m2xq4h9bwz@parse.example.com'],
      helo: null, remote_ip: null, tls: true, source: 'imap',
    });
    assert.equal(r.api.delivered[0].raw.toString('utf8'), r.messages[0].raw.toString('utf8'));
    assert.equal(r.api.delivered[0].received_at, '2026-08-25T09:14:03.000Z');

    // The mark is at the last UID, and the state file says so on disk.
    assert.equal(r.state().cursor, '102');
    assert.equal(r.state().validity, String(r.imap.uidvalidity));

    const second = await r.connector.runOnce();
    assert.equal(second.delivered, 0);
    assert.equal(second.listed, 0, 'the server should not even be asked for old UIDs again');
    assert.equal(r.api.delivered.length, 3);

    // New mail arrives; only that one is delivered.
    r.imap.deliver({ uid: 103, messageId: 'd@example.test' });
    const third = await r.connector.runOnce();
    assert.equal(third.delivered, 1);
    assert.equal(r.api.delivered.length, 4);
    assert.equal(r.api.delivered[3].message_id, '<d@example.test>');
  } finally { await r.close(); }
});

test('a transient API failure stops the batch and loses nothing', async () => {
  const r = await rig();
  try {
    // First message goes through, the second fails every retry.
    let failB = true;
    const realDeliver = r.connector.deliverer.deliver.bind(r.connector.deliverer);
    r.connector.deliverer.deliver = async (args) => {
      if (args.messageId === '<b@example.test>' && failB) {
        const err = new Error('503 temporarily_unavailable');
        err.status = 503;
        throw err;
      }
      return realDeliver(args);
    };

    await assert.rejects(() => r.connector.runOnce(), /503|delivery failed/);
    assert.equal(r.api.delivered.length, 1, 'only the first message should have been delivered');
    // Crucially the mark is at 100, NOT at 102: the failure must not be skipped past.
    assert.equal(r.state().cursor, '100');

    failB = false;
    const retry = await r.connector.runOnce();
    assert.equal(retry.delivered, 2);
    assert.deepEqual(r.api.delivered.map((d) => d.message_id),
      ['<a@example.test>', '<b@example.test>', '<c@example.test>']);
    assert.equal(r.state().cursor, '102');
  } finally { await r.close(); }
});

test('a UIDVALIDITY change resyncs instead of redelivering the mailbox', async () => {
  const r = await rig();
  try {
    await r.connector.runOnce();
    assert.equal(r.api.delivered.length, 3);

    // The server is restored from backup: same three messages, new UIDs, new
    // UIDVALIDITY. A client that trusted its stored UID would deliver all
    // three again.
    r.imap.uidvalidity += 1;
    r.imap.messages = [
      makeMessage({ uid: 1, messageId: 'a@example.test', subject: 'one' }),
      makeMessage({ uid: 2, messageId: 'b@example.test', subject: 'two' }),
      makeMessage({ uid: 3, messageId: 'c@example.test', subject: 'three' }),
      makeMessage({ uid: 4, messageId: 'e@example.test', subject: 'genuinely new' }),
    ];

    let resynced = false;
    r.connector.on('resync', () => { resynced = true; });
    const after = await r.connector.runOnce();
    assert.ok(resynced, 'the connector should have noticed the UIDVALIDITY change');
    assert.equal(after.resynced, true);
    assert.equal(r.api.delivered.length, 4, 'only the genuinely new message should be delivered');
    assert.equal(r.api.delivered[3].message_id, '<e@example.test>');
    assert.equal(r.state().validity, String(r.imap.uidvalidity));
    assert.equal(r.state().cursor, '4');

    const idle = await r.connector.runOnce();
    assert.equal(idle.delivered, 0);
  } finally { await r.close(); }
});

test('the mark survives a process restart', async () => {
  const stateFile = tmpState();
  const r = await rig({ stateFile });
  try {
    await r.connector.runOnce();
    await r.connector.close();

    // A brand new Connector object, as if the process had been restarted.
    const again = new Connector({ ...r.conf });
    try {
      const cycle = await again.runOnce();
      assert.equal(cycle.delivered, 0);
      assert.equal(r.api.delivered.length, 3);
    } finally { await again.close(); }
  } finally { await r.close(); }
});

test('a message over the size cap is skipped loudly, not silently, and does not block the queue', async () => {
  const big = makeMessage({ uid: 200, messageId: 'big@example.test', text: 'x'.repeat(200000) });
  const r = await rig({
    messages: [makeMessage({ uid: 199, messageId: 'small1@example.test' }), big,
      makeMessage({ uid: 201, messageId: 'small2@example.test' })],
    conf: { maxMessageBytes: 50000 },
  });
  try {
    const cycle = await r.connector.runOnce();
    assert.equal(cycle.delivered, 2);
    assert.equal(cycle.skipped, 1);
    assert.deepEqual(r.api.delivered.map((d) => d.message_id), ['<small1@example.test>', '<small2@example.test>']);
    assert.equal(r.state().cursor, '201', 'the queue must not be wedged behind the oversized message');
  } finally { await r.close(); }
});

test('the same Message-ID arriving under a second UID is delivered once', async () => {
  const r = await rig({
    messages: [
      makeMessage({ uid: 300, messageId: 'dup@example.test' }),
      makeMessage({ uid: 301, messageId: 'dup@example.test' }),
      makeMessage({ uid: 302, messageId: 'unique@example.test' }),
    ],
  });
  try {
    const cycle = await r.connector.runOnce();
    assert.equal(cycle.delivered, 2);
    assert.equal(cycle.skipped, 1);
    assert.deepEqual(r.api.delivered.map((d) => d.message_id), ['<dup@example.test>', '<unique@example.test>']);
  } finally { await r.close(); }
});

test('delivered messages are marked \\Seen on the source, but only after delivery', async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.messages.map((m) => m.flags), [[], [], []]);
    await r.connector.runOnce();
    assert.deepEqual(r.messages.map((m) => m.flags), [['\\Seen'], ['\\Seen'], ['\\Seen']]);
  } finally { await r.close(); }
});

test('the mark is written through the API when the endpoint exists, and to a file when it does not', async () => {
  const withApi = await rig({ supportsState: true });
  try {
    await withApi.connector.runOnce();
    assert.equal(withApi.api.state.get('conn_test').cursor, '102');
    assert.equal(withApi.state().cursor, '102', 'the local copy is written too, so a switch-over loses nothing');
  } finally { await withApi.close(); }

  const withoutApi = await rig({ supportsState: false });
  try {
    await withoutApi.connector.runOnce();
    assert.equal(withoutApi.api.state.size, 0);
    assert.equal(withoutApi.state().cursor, '102');
    assert.equal(withoutApi.api.delivered.length, 3, 'a missing state endpoint must not stop mail');
  } finally { await withoutApi.close(); }
});

test('an unknown mailbox_token is fatal, not a retry loop', async () => {
  const r = await rig();
  r.api.knownTokens = ['someothertoken'];
  try {
    await assert.rejects(() => r.connector.runOnce(), /not known to the API/);
    assert.equal(r.state().cursor, null);
  } finally { await r.close(); }
});

test('a forwarding confirmation is detected, surfaced and still delivered', async () => {
  const gmail = makeMessage({
    uid: 400,
    messageId: 'gmailconfirm@mail.gmail.com',
    raw: [
      'Message-ID: <gmailconfirm@mail.gmail.com>',
      'From: Gmail Team <forwarding-noreply@google.com>',
      'To: k7m2xq4h9bwz@parse.example.com',
      'Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from user@example.test',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'user@example.test has requested to automatically forward mail to your email address',
      'k7m2xq4h9bwz@parse.example.com.',
      'Confirmation code: 123456789',
      '',
      'To allow user@example.test to automatically forward mail to your address,',
      'please click the link below:',
      '',
      'https://mail.google.com/mail/vf-%5BANGjdJ8example%5D-cWJqUeXaMpLe-Xz',
      '',
    ].join('\r\n'),
  });
  const r = await rig({ messages: [gmail] });
  try {
    const seen = [];
    r.connector.on('forwarding', (d) => seen.push(d));
    await r.connector.runOnce();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'gmail');
    assert.equal(seen[0].code, '123456789');
    assert.match(seen[0].link, /^https:\/\/mail\.google\.com\/mail\/vf-/);
    assert.equal(seen[0].link_trusted, true);
    assert.equal(seen[0].forward_from, 'user@example.test');

    // It rides along on the delivery, and is also pushed to the API endpoint.
    assert.equal(r.api.delivered.length, 1);
    assert.equal(r.api.delivered[0].forwarding.code, '123456789');
    assert.equal(r.api.forwarding.length, 1);
    assert.equal(r.api.forwarding[0].mailbox_token, 'k7m2xq4h9bwz');
  } finally { await r.close(); }
});

test('a fresh connection in the default mode starts at "now", not at the archive', async () => {
  const r = await rig({ conf: { initial: 'new' } });
  try {
    const cycle = await r.connector.runOnce();
    assert.equal(cycle.delivered, 0, 'three years of old mail must not be replayed into a webhook');
    assert.equal(r.state().cursor, '102');
    r.imap.deliver({ uid: 103, messageId: 'new@example.test' });
    const next = await r.connector.runOnce();
    assert.equal(next.delivered, 1);
  } finally { await r.close(); }
});

/** Waits for a condition instead of guessing at a sleep length. */
async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('run() keeps going: it drains, waits on IDLE, and picks up mail that arrives later', async () => {
  const r = await rig({ conf: { idleMs: 3000, initial: 'all' } });
  try {
    const delivered = [];
    r.connector.on('delivered', (d) => delivered.push(d));
    const loop = r.connector.run();
    assert.ok(await until(() => r.api.delivered.length === 3), 'initial drain');

    r.imap.deliver({ uid: 110, messageId: 'live1@example.test' });
    assert.ok(await until(() => r.api.delivered.length === 4), 'mail delivered while idling');

    r.imap.deliver({ uid: 111, messageId: 'live2@example.test' });
    assert.ok(await until(() => r.api.delivered.length === 5), 'second live delivery');

    r.connector.stop();
    await loop;
    assert.equal(delivered.length, 5);
    assert.equal(r.state().cursor, '111');
  } finally { await r.close(); }
});

test('mail that arrives while the connector is mid-batch is not left waiting for the idle timeout', async () => {
  // The nastiest timing case: the EXISTS notification lands while a FETCH is
  // in flight, so no IDLE is running to hear it. If the client forgets it, the
  // message sits in the mailbox until the 29 minute idle window expires.
  const r = await rig({ conf: { idleMs: 60000, initial: 'all' } });
  try {
    const loop = r.connector.run();
    assert.ok(await until(() => r.api.delivered.length === 3), 'initial drain');
    r.connector.provider.client.emit('untagged', { name: 'EXISTS', seq: 4 });
    r.connector.provider.client._unsolicitedUpdate = true;
    r.imap.deliver({ uid: 120, messageId: 'raced@example.test' });
    assert.ok(await until(() => r.api.delivered.length === 4, 10000),
      'the racing message should arrive in seconds, not in 29 minutes');
    r.connector.stop();
    await loop;
  } finally { await r.close(); }
});
