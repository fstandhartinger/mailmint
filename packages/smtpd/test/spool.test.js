'use strict';
// The spool is the promise that we never lose mail. These tests break the API
// on purpose and check what survives.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { Spool } = require('../src/spool');
const { Deliverer } = require('../src/deliver');
const { startStack, SmtpClient } = require('./helpers');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

async function tmpSpool() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mailmint-spool-test-'));
  const spool = new Spool({ spoolDir: dir });
  await spool.init();
  return { dir, spool };
}

test('a spooled message is fsynced and readable back byte-for-byte', async () => {
  const { dir, spool } = await tmpSpool();
  try {
    const raw = Buffer.from('Subject: durable\r\n\r\n' + 'x'.repeat(5000) + '\r\n');
    const id = await spool.put(raw, { request_id: 'req_1', envelope: { from: 'a@b.com', to: [MBX] } });
    const back = await spool.read(id);
    assert.ok(back.raw.equals(raw));
    assert.strictEqual(back.meta.request_id, 'req_1');
    assert.strictEqual(back.meta.attempts, 0);
    assert.deepStrictEqual(await spool.list(), [id]);
    await spool.remove(id);
    assert.deepStrictEqual(await spool.list(), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a half-written entry is never picked up by the drainer', async () => {
  const { dir, spool } = await tmpSpool();
  try {
    // an .eml with no .json is exactly what a crash mid-put looks like
    await fsp.writeFile(path.join(dir, 'orphan.eml'), 'partial');
    assert.deepStrictEqual(await spool.list(), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('when the API is down the message stays on disk and is drained later', async () => {
  const { dir, spool } = await tmpSpool();
  let failing = true;
  const calls = [];
  const deliverer = new Deliverer({
    apiUrl: 'http://api.invalid',
    internalSecret: 's',
    spool,
    spoolDrainIntervalMs: 10_000,
    fetch: async () => {
      calls.push(Date.now());
      if (failing) throw new Error('ECONNREFUSED');
      return { status: 200, json: async () => ({ ok: true }), text: async () => 'ok' };
    },
  });

  try {
    const raw = Buffer.from('Subject: queued\r\n\r\nbody\r\n');
    const outcome = await deliverer.handle(raw, { request_id: 'req_x', envelope: {} });
    assert.strictEqual(outcome.action, 'accepted', 'we are durable, so we accept');
    assert.strictEqual(outcome.queued, true);
    assert.strictEqual((await spool.list()).length, 1);

    // still failing: the entry survives and its attempt count grows
    await spool.touch(outcome.spoolId, { next_attempt: 0 });
    let summary = await deliverer.drain();
    assert.strictEqual(summary.deferred, 1);
    assert.strictEqual((await spool.list()).length, 1);
    const meta = (await spool.read(outcome.spoolId)).meta;
    assert.ok(meta.attempts >= 2, `attempts should have grown, got ${meta.attempts}`);

    // API comes back
    failing = false;
    await spool.touch(outcome.spoolId, { next_attempt: 0 });
    summary = await deliverer.drain();
    assert.strictEqual(summary.delivered, 1);
    assert.deepStrictEqual(await spool.list(), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('after the retry budget the message is moved aside, not deleted', async () => {
  const { dir, spool } = await tmpSpool();
  const deliverer = new Deliverer({
    apiUrl: 'http://api.invalid', internalSecret: 's', spool,
    spoolMaxAttempts: 2,
    fetch: async () => { throw new Error('down'); },
  });
  try {
    const outcome = await deliverer.handle(Buffer.from('Subject: doomed\r\n\r\nx\r\n'), { request_id: 'r', envelope: {} });
    await spool.touch(outcome.spoolId, { next_attempt: 0, attempts: 1 });
    await deliverer.drain();
    assert.deepStrictEqual(await spool.list(), [], 'no longer in the live queue');
    const failed = await fsp.readdir(path.join(dir, 'failed'));
    assert.ok(failed.includes(`${outcome.spoolId}.eml`), 'the message itself is kept for replay');
    assert.ok(failed.includes(`${outcome.spoolId}.json`));
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'failed', `${outcome.spoolId}.json`), 'utf8'));
    assert.ok(meta.failed_reason);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a permanent API rejection is not retried forever', async () => {
  const { dir, spool } = await tmpSpool();
  const deliverer = new Deliverer({
    apiUrl: 'http://api.invalid', internalSecret: 's', spool,
    fetch: async () => ({ status: 404, json: async () => ({}), text: async () => 'no such mailbox' }),
  });
  try {
    const outcome = await deliverer.handle(Buffer.from('Subject: gone\r\n\r\nx\r\n'), { request_id: 'r', envelope: {} });
    assert.strictEqual(outcome.action, 'rejected');
    assert.strictEqual(outcome.code, '550 5.1.1');
    assert.deepStrictEqual(await spool.list(), [], 'nothing left queued');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('if the spool itself cannot be written we answer 451, never 250', async () => {
  // a regular FILE where the spool directory should be: mkdir gives ENOTDIR
  const blocker = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'mailmint-block-')), 'not-a-dir');
  await fsp.writeFile(blocker, 'this is a file, not a directory');
  const spool = new Spool({ spoolDir: path.join(blocker, 'spool') });
  const deliverer = new Deliverer({
    apiUrl: 'http://api.invalid', internalSecret: 's', spool,
    fetch: async () => ({ status: 200, json: async () => ({}), text: async () => '' }),
  });
  const outcome = await deliverer.handle(Buffer.from('Subject: x\r\n\r\ny\r\n'), { request_id: 'r', envelope: {} });
  assert.strictEqual(outcome.action, 'deferred');
  assert.strictEqual(outcome.code, '451 4.3.0');
});

test('ON_API_FAILURE=defer answers 451 4.3.0 and leaves nothing queued', async () => {
  const { dir, spool } = await tmpSpool();
  const deliverer = new Deliverer({
    apiUrl: 'http://api.invalid', internalSecret: 's', spool,
    onApiFailure: 'defer',
    fetch: async () => { throw new Error('down'); },
  });
  try {
    const outcome = await deliverer.handle(Buffer.from('Subject: x\r\n\r\ny\r\n'), { request_id: 'r', envelope: {} });
    assert.strictEqual(outcome.action, 'deferred');
    assert.strictEqual(outcome.code, '451 4.3.0');
    assert.deepStrictEqual(await spool.list(), [], 'defer mode must not leave a duplicate behind');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('over SMTP: an API outage in defer mode gives the sender 451', async () => {
  const stack = await startStack({ mailboxes: [MBX], onApiFailure: 'defer' });
  try {
    // break the API after the RCPT lookup has been cached
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    await c.cmd('EHLO client.test');
    await c.cmd('MAIL FROM:<a@b.com>');
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    await stack.api.close();
    await c.cmd('DATA');
    await c.write('Subject: outage\r\n\r\nbody\r\n.\r\n', { silent: true });
    const r = await c.read();
    assert.strictEqual(r.code, 451);
    assert.ok(r.lines[0].includes('4.3.0'));
    c.destroy();
  } finally {
    await stack.close().catch(() => {});
  }
});

test('over SMTP: an API outage in accept mode answers 250 and queues the message', async () => {
  const stack = await startStack({ mailboxes: [MBX], onApiFailure: 'accept' });
  try {
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    await c.cmd('EHLO client.test');
    await c.cmd('MAIL FROM:<a@b.com>');
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    await stack.api.close();
    await c.cmd('DATA');
    await c.write('Subject: outage\r\n\r\nbody\r\n.\r\n', { silent: true });
    const r = await c.read();
    assert.strictEqual(r.code, 250);
    assert.match(r.lines[0], /queued/);
    c.destroy();
    assert.strictEqual(stack.spool.sizeSync(), 1, 'the message is on disk, waiting');
  } finally {
    await stack.close().catch(() => {});
  }
});
