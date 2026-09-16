'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { startStack, SmtpClient } = require('./helpers');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

function waitForClose(client) {
  if (client.closed || client.socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => client.socket.once('close', resolve));
}

function expectCloseWithin(closePromise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`close did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([closePromise, timeout]).finally(() => clearTimeout(timer));
}

test('close sends a shutdown reply and ends idle sessions within the grace period', { timeout: 3500 }, async (t) => {
  const stack = await startStack();
  const active = new SmtpClient({ port: stack.port });
  const idle = new SmtpClient({ port: stack.port });
  try {
    await Promise.all([active.connect(), idle.connect()]);
    const activeGreeting = await active.read();
    const idleGreeting = await idle.read();
    assert.strictEqual(activeGreeting.code, 220);
    assert.strictEqual(idleGreeting.code, 220);
    assert.strictEqual((await active.cmd('EHLO active.test')).code, 250);

    const closeStarted = Date.now();
    await expectCloseWithin(stack.server.close({ graceMs: 500 }), 2000);
    assert.ok(Date.now() - closeStarted < 2000);

    const [activeBye, idleBye] = await Promise.all([active.read(), idle.read()]);
    assert.strictEqual(activeBye.code, 421, 'EVERY idle session must get the 421 shutdown reply');
    assert.strictEqual(idleBye.code, 421, 'EVERY idle session must get the 421 shutdown reply');
    await Promise.all([waitForClose(active), waitForClose(idle)]);
    assert.strictEqual(stack.server.sessions.size, 0);
  } finally {
    active.destroy();
    idle.destroy();
    await expectCloseWithin(stack.close(), 2000);
  }
});

test('close refuses new connections on the old listener', async (t) => {
  const stack = await startStack();
  try {
    await expectCloseWithin(stack.server.close({ graceMs: 100 }), 2000);
    const outcome = await new Promise((resolve) => {
      const socket = net.createConnection({ port: stack.port, host: '127.0.0.1' });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish('connected'));
      socket.once('close', () => finish('closed'));
      socket.once('error', () => finish('error'));
      setTimeout(() => finish('timeout'), 500).unref();
    });
    assert.notStrictEqual(outcome, 'connected');
  } finally {
    await expectCloseWithin(stack.close(), 2000);
  }
});

test('close is bounded when an idle client never disconnects', { timeout: 3500 }, async (t) => {
  const stack = await startStack();
  const client = new SmtpClient({ port: stack.port, timeoutMs: 5000 });
  let closePromise;
  try {
    await client.connect();
    assert.strictEqual((await client.read()).code, 220);
    closePromise = stack.server.close({ graceMs: 100 });
    let timer;
    const bounded = Promise.race([
      closePromise.then(() => 'resolved'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('close remained pending after 3s')), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.strictEqual(await bounded, 'resolved');
  } finally {
    client.destroy();
    if (closePromise) await expectCloseWithin(closePromise, 2000);
    await expectCloseWithin(stack.close(), 2000);
  }
});

test('close lets a session mid-DATA finish within grace: 250, delivered, then ended', { timeout: 5000 }, async (t) => {
  const stack = await startStack({ mailboxes: [MBX] });
  const c = new SmtpClient({ port: stack.port });
  let closePromise;
  try {
    await c.connect();
    assert.strictEqual((await c.read()).code, 220);
    assert.strictEqual((await c.cmd('EHLO mid-data.test')).code, 250);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    assert.strictEqual((await c.cmd('DATA')).code, 354);

    // Shutdown starts while the session is in the middle of DATA.
    closePromise = stack.server.close({ graceMs: 1500 });

    // Finishing the message inside the grace window must still be accepted.
    await c.write('Subject: grace\r\n\r\nbody finished during grace\r\n.\r\n');
    const reply = await c.read();
    assert.strictEqual(reply.code, 250, 'a message completed within grace must be accepted');
    assert.strictEqual(stack.api.delivered.length, 1, 'the message must reach the deliverer');
    assert.ok(stack.api.delivered[0].raw_mime.toString().includes('body finished during grace'));

    // ...and only then is the drained session ended and close() settles, well
    // before the grace deadline.
    await waitForClose(c);
    await expectCloseWithin(closePromise, 1500);
    assert.strictEqual(stack.server.sessions.size, 0);
  } finally {
    c.destroy();
    if (closePromise) await closePromise.catch(() => {});
    await expectCloseWithin(stack.close(), 2000);
  }
});

test('close after a BDAT oversize 552 treats the session as idle: 421, settles early', { timeout: 8000 }, async (t) => {
  const stack = await startStack({ mailboxes: [MBX], env: { MAX_MESSAGE_BYTES: '4096' } });
  const c = new SmtpClient({ port: stack.port });
  let closePromise;
  try {
    await c.connect();
    assert.strictEqual((await c.read()).code, 220);
    assert.strictEqual((await c.cmd('EHLO oversize.test')).code, 250);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    const body = Buffer.alloc(9000, 0x61);
    await c.write(`BDAT ${body.length} LAST\r\n`);
    await c.write(body, { silent: true });
    assert.strictEqual((await c.read()).code, 552, 'oversize BDAT must be refused');

    // The 552 ended the transaction: on close() the session is idle, so it gets
    // the shutdown reply and close() must NOT burn the whole grace period.
    const closeStarted = Date.now();
    closePromise = stack.server.close({ graceMs: 5000 });
    const bye = await c.read();
    assert.strictEqual(bye.code, 421, 'an idle session after a failed BDAT must get 421');
    await expectCloseWithin(closePromise, 2000);
    assert.ok(Date.now() - closeStarted < 2000, 'close must settle well before the grace deadline');
    await waitForClose(c);
    assert.strictEqual(stack.server.sessions.size, 0);
  } finally {
    c.destroy();
    if (closePromise) await closePromise.catch(() => {});
    await expectCloseWithin(stack.close(), 2000);
  }
});

test('close destroys a session stuck in DATA at the deadline and stays bounded', { timeout: 5000 }, async (t) => {
  const stack = await startStack({ mailboxes: [MBX] });
  const c = new SmtpClient({ port: stack.port, timeoutMs: 5000 });
  let closePromise;
  try {
    await c.connect();
    assert.strictEqual((await c.read()).code, 220);
    assert.strictEqual((await c.cmd('EHLO stuck.test')).code, 250);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    assert.strictEqual((await c.cmd('DATA')).code, 354);
    await c.write('Subject: never finished\r\n\r\nno terminator ever follows', { silent: true });

    closePromise = stack.server.close({ graceMs: 500 });
    await expectCloseWithin(closePromise, 2000);
    await waitForClose(c);
    assert.ok(c.closed, 'a session that never finishes DATA must be destroyed at the deadline');
    assert.strictEqual(stack.api.delivered.length, 0, 'an unfinished message must not be delivered');
    assert.strictEqual(stack.server.sessions.size, 0);
  } finally {
    c.destroy();
    if (closePromise) await closePromise.catch(() => {});
    await expectCloseWithin(stack.close(), 2000);
  }
});
