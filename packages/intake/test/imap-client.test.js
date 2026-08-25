'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ImapClient, ImapAuthError } = require('../src/imap');
const { FakeImapServer, makeMessage } = require('./fake-imap-server');
const { selfSigned } = require('./selfsigned');

async function withServer(opts, fn) {
  const server = new FakeImapServer(opts);
  await server.listen(0);
  try { return await fn(server); } finally { await server.close(); }
}

function client(server, extra = {}) {
  return new ImapClient({
    host: '127.0.0.1', port: server.port, secure: false, starttls: false,
    user: server.user, pass: server.pass, transcript: true,
    connectTimeoutMs: 5000, commandTimeoutMs: 8000, ...extra,
  });
}

test('a full Dovecot conversation over a real socket, with hostile chunking', async () => {
  const messages = [
    makeMessage({ uid: 4001, subject: 'first' }),
    makeMessage({ uid: 4002, subject: 'second', flags: ['\\Seen'] }),
    // A message whose own body contains protocol-looking lines.
    makeMessage({
      uid: 4003,
      subject: 'A0006 OK trap',
      text: ['A0006 OK Fetch completed (0.002 + 0.000 secs).', '* 42 EXISTS', ')', ''].join('\r\n'),
    }),
  ];
  await withServer({ messages, chunkSize: 3 }, async (server) => {
    const c = client(server);
    const greeting = await c.connect();
    assert.equal(greeting.status, 'OK');
    assert.ok(c.hasCapability('IMAP4REV1'));

    const auth = await c.login();
    assert.equal(auth.method, 'login');
    assert.ok(c.hasCapability('IDLE'));

    const box = await c.select('INBOX');
    assert.equal(box.exists, 3);
    assert.equal(box.uidvalidity, server.uidvalidity);
    assert.equal(box.uidnext, 4004);

    const all = await c.uidSearch('ALL');
    assert.deepEqual(all, [4001, 4002, 4003]);

    const unseen = await c.uidSearch('UNSEEN');
    assert.deepEqual(unseen, [4001, 4003]);

    const fetched = await c.uidFetch([4001, 4003]);
    assert.equal(fetched.length, 2);
    assert.equal(fetched[0].uid, 4001);
    assert.equal(fetched[0].size, messages[0].raw.length);
    assert.equal(fetched[0].internaldate.toISOString(), '2026-08-25T09:14:03.000Z');
    assert.equal(fetched[1].body.toString('utf8'), messages[2].raw.toString('utf8'));
    assert.ok(fetched[1].body.includes('A0006 OK Fetch completed'));

    await c.markSeen([4001]);
    assert.ok(messages[0].flags.includes('\\Seen'));
    assert.deepEqual(await c.uidSearch('UNSEEN'), [4003]);

    await c.logout();
    // No CAPABILITY command was needed: the greeting carried [CAPABILITY ...],
    // and so did the LOGIN OK. Two saved round trips per poll.
    assert.equal(server.log.filter((l) => /CAPABILITY/.test(l)).length, 0, server.log.join('\n'));
    assert.ok(server.log.some((l) => /^A\d+ LOGIN /.test(l)), server.log.join('\n'));
    assert.ok(server.log.some((l) => /UID FETCH 4001,4003/.test(l)), server.log.join('\n'));
  });
});

test('UID SEARCH n:* returning the last message anyway does not become a redelivery', async () => {
  // RFC 3501's range rule means a server answers `UID 5000:*` with UID 4003
  // when 4003 is the highest. The provider filters; here we prove the server
  // really does answer that way, so the filter is not defending against a
  // hypothetical.
  const messages = [makeMessage({ uid: 4001 }), makeMessage({ uid: 4003 })];
  await withServer({ messages }, async (server) => {
    const c = client(server);
    await c.connect();
    await c.login();
    await c.select('INBOX');
    assert.deepEqual(await c.uidSearch('UID 5000:*'), [4003]);
    assert.deepEqual(await c.uidSearch('UID 4004:*'), [4003]);
    await c.logout();
  });
});

test('LOGIN with a non-ASCII password goes out as a synchronising literal', async () => {
  const pass = 'pässwörd mit ümlauten';
  await withServer({ pass, supportsLiteralPlus: false, messages: [] }, async (server) => {
    const c = client(server, { pass });
    await c.connect();
    await c.login();
    assert.equal(c.state, 'authenticated');
    // The server had to send "+ Ready for N bytes" twice for this to work.
    assert.ok(c.transcript.some((l) => /\{\d+\} <\d+ bytes>/.test(l)), c.transcript.join('\n'));
    await c.logout();
  });
});

test('LITERAL+ skips the continuation round trip', async () => {
  const pass = 'pässwörd';
  await withServer({ pass, supportsLiteralPlus: true, messages: [] }, async (server) => {
    const c = client(server, { pass });
    await c.connect();
    await c.login();
    assert.ok(c.transcript.some((l) => /\{\d+\+\}/.test(l)), c.transcript.join('\n'));
    await c.logout();
  });
});

test('AUTHENTICATE XOAUTH2 with SASL-IR (Gmail)', async () => {
  await withServer({
    dialect: 'gmail', messages: [makeMessage({ uid: 9001 })],
    user: 'someone@gmail.com', oauthToken: 'ya29.a0AfB_fake_token',
  }, async (server) => {
    const c = client(server, { user: 'someone@gmail.com', pass: null, accessToken: 'ya29.a0AfB_fake_token' });
    await c.connect();
    const auth = await c.login();
    assert.equal(auth.method, 'xoauth2');
    assert.ok(c.hasCapability('X-GM-EXT-1'));
    const box = await c.select('INBOX');
    assert.equal(box.exists, 1);
    await c.logout();
    assert.ok(server.log.some((l) => /^A000\d AUTHENTICATE XOAUTH2 /.test(l)), server.log.join('\n'));
  });
});

test('a rejected XOAUTH2 token is reported, not left hanging', async () => {
  await withServer({
    dialect: 'gmail', messages: [], user: 'someone@gmail.com', oauthToken: 'good-token',
  }, async (server) => {
    const c = client(server, { user: 'someone@gmail.com', pass: null, accessToken: 'expired-token' });
    await c.connect();
    await assert.rejects(() => c.login(), (err) => {
      assert.ok(err instanceof ImapAuthError, `expected ImapAuthError, got ${err.name}: ${err.message}`);
      assert.match(err.message, /XOAUTH2 rejected|401/);
      return true;
    });
    // The empty-line acknowledgement is what let the server send its NO.
    assert.ok(server.log.includes(''), JSON.stringify(server.log));
  });
});

test('a wrong password is a permanent error, not a retry loop', async () => {
  await withServer({ messages: [] }, async (server) => {
    const c = client(server, { pass: 'wrong' });
    await c.connect();
    await assert.rejects(() => c.login(), (err) => {
      assert.equal(err.name, 'ImapAuthError');
      assert.equal(err.permanent, true);
      return true;
    });
  });
});

test('STARTTLS upgrades the socket and rediscovers capabilities', async (t) => {
  const cert = selfSigned();
  if (!cert) return t.skip('openssl is not available');
  await withServer({
    messages: [makeMessage({ uid: 1 })], requireStartTls: true, tlsOptions: { key: cert.key, cert: cert.cert },
  }, async (server) => {
    const c = client(server, {
      starttls: true, tlsOptions: { rejectUnauthorized: false, servername: 'localhost' },
    });
    await c.connect();
    assert.equal(c.secure, false);
    await c.login();
    assert.equal(c.secure, true, 'the socket should be TLS after login');
    const box = await c.select('INBOX');
    assert.equal(box.exists, 1);
    await c.logout();
    assert.ok(server.log.some((l) => /STARTTLS/.test(l)));
  });
  return undefined;
});

test('IDLE wakes on new mail and re-issues on the 29 minute rule', async () => {
  await withServer({ messages: [makeMessage({ uid: 5001 })] }, async (server) => {
    const c = client(server);
    await c.connect();
    await c.login();
    await c.select('INBOX');
    assert.ok(c.hasCapability('IDLE'));

    const idling = c.idle({ maxMs: 5000 });
    await new Promise((r) => setTimeout(r, 120));
    server.deliver({ uid: 5002, subject: 'arrived while idling' });
    const res = await idling;
    assert.equal(res.reason, 'update');
    assert.ok(res.updates.some((u) => u.name === 'EXISTS'));
    assert.ok(server.log.includes('DONE'), server.log.join('\n'));

    // Nothing arrives: the client must give up on its own and re-issue, which
    // is what stops a NAT or the server's own 30 minute rule from silently
    // killing the connection.
    const t0 = Date.now();
    const timedOut = await c.idle({ maxMs: 200 });
    assert.equal(timedOut.reason, 'timeout');
    assert.ok(Date.now() - t0 >= 190);
    assert.equal(server.log.filter((l) => l === 'DONE').length, 2);

    assert.deepEqual(await c.uidSearch('UID 5002:*'), [5002]);
    await c.logout();
  });
});

test('without IDLE the client falls back to interval polling', async () => {
  await withServer({ messages: [makeMessage({ uid: 6001 })], supportsIdle: false }, async (server) => {
    const c = client(server);
    await c.connect();
    await c.login();
    await c.select('INBOX');
    assert.equal(c.hasCapability('IDLE'), false);

    const waiting = c.waitForUpdate({ maxMs: 3000, pollIntervalMs: 60 });
    await new Promise((r) => setTimeout(r, 100));
    server.messages.push(makeMessage({ uid: 6002 }));
    const res = await waiting;
    assert.equal(res.reason, 'update');
    assert.equal(res.polled, true);
    assert.ok(server.log.filter((l) => /NOOP/.test(l)).length >= 1);
    await c.logout();
  });
});

test('commands are pipelined: several tags go out before the first reply', async () => {
  await withServer({ messages: [makeMessage({ uid: 7001 }), makeMessage({ uid: 7002 })] }, async (server) => {
    const c = client(server);
    await c.connect();
    await c.login();
    await c.select('INBOX');
    const [a, b, d] = await Promise.all([c.uidSearch('ALL'), c.noop(), c.uidSearch('UNSEEN')]);
    assert.deepEqual(a, [7001, 7002]);
    assert.equal(b.status, 'OK');
    assert.deepEqual(d, [7001, 7002]);
    await c.logout();
  });
});

test('a server that vanishes mid-command rejects the promise instead of hanging', async () => {
  await withServer({ messages: [], dropAfter: 'SELECT' }, async (server) => {
    const c = client(server);
    c.on('error', () => {});
    await c.connect();
    await c.login();
    await assert.rejects(() => c.select('INBOX'), /closed|socket/i);
  });
});

test('a command that never gets an answer times out and kills the connection', async () => {
  await withServer({ messages: [], onCommand: () => {} }, async (server) => {
    server._uidSearch = () => {};   // swallow the command entirely
    const c = client(server, { commandTimeoutMs: 250 });
    c.on('error', () => {});
    await c.connect();
    await c.login();
    await c.select('INBOX');
    await assert.rejects(() => c.uidSearch('ALL'), /timed out/);
  });
});
