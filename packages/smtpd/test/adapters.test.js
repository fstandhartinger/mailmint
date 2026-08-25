'use strict';
// The adapters exist so that intake can move between our own SMTP server,
// Cloudflare Email Routing, Mailgun and CloudMailin without the parser or the
// API learning anything about it. These tests hold them to exactly one shape.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');

const adapters = require('../src/adapters');
const { parseMultipart } = require('../src/adapters/http');
const { startStack } = require('./helpers');
const { IntakeHttpServer } = require('../src/intake-http');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

const MESSAGE =
  'Message-ID: <adapter-test@acme.com>\r\n' +
  'Date: Tue, 25 Aug 2026 09:14:01 +0000\r\n' +
  'From: Acme Billing <billing@acme.com>\r\n' +
  `To: <${MBX}>\r\n` +
  'Subject: Invoice INV-2291\r\n' +
  '\r\n' +
  'Total: $31.50\r\n';

/** A stand-in for an http.IncomingMessage. */
function fakeReq({ method = 'POST', url = '/', headers = {}, body = Buffer.alloc(0) }) {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return stream;
}

function multipart(parts) {
  const boundary = '----test' + crypto.randomBytes(6).toString('hex');
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"` +
      (p.filename ? `; filename="${p.filename}"` : '') + '\r\n' +
      (p.contentType ? `Content-Type: ${p.contentType}\r\n` : '') + '\r\n', 'latin1'));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ------------------------------------------------------------- multipart ----

test('the multipart parser keeps binary parts byte-exact', () => {
  const bin = crypto.randomBytes(1024);
  const { body, contentType } = multipart([
    { name: 'timestamp', value: '1787654321' },
    { name: 'message', filename: 'x.eml', contentType: 'message/rfc822', value: bin },
  ]);
  const boundary = /boundary=(.*)$/.exec(contentType)[1];
  const { fields, files } = parseMultipart(body, boundary);
  assert.strictEqual(fields.timestamp, '1787654321');
  assert.ok(files.message.data.equals(bin));
  assert.strictEqual(files.message.filename, 'x.eml');
});

// ------------------------------------------------------------ cloudflare ----

test('cloudflare: raw body + X- headers become rawMime + envelope', async () => {
  const r = await adapters.cloudflare.parse(fakeReq({
    headers: {
      'content-type': 'message/rfc822',
      'x-mailmint-secret': 's3cret',
      'x-mailmint-from': 'billing@acme.com',
      'x-mailmint-to': MBX,
      'x-mailmint-size': String(Buffer.byteLength(MESSAGE)),
      'x-mailmint-worker': 'parse.example.com',
    },
    body: MESSAGE,
  }), { secret: 's3cret' });

  assert.ok(r.rawMime.equals(Buffer.from(MESSAGE, 'utf8')));
  assert.deepStrictEqual(r.envelope, {
    from: 'billing@acme.com', to: [MBX],
    helo: 'cloudflare-email-routing', remote_ip: null, tls: true,
  });
  assert.strictEqual(r.meta.size_mismatch, false);
});

test('cloudflare: a wrong or missing secret is a 401', async () => {
  for (const secret of ['wrong', undefined]) {
    await assert.rejects(
      () => adapters.cloudflare.parse(fakeReq({
        headers: secret ? { 'x-mailmint-secret': secret } : {}, body: MESSAGE,
      }), { secret: 's3cret' }),
      (e) => e.statusCode === 401);
  }
});

test('cloudflare: LF-only input is normalised to CRLF', async () => {
  const r = await adapters.cloudflare.parse(fakeReq({
    headers: { 'x-mailmint-from': 'a@b.com', 'x-mailmint-to': MBX },
    body: 'Subject: lf only\nFrom: <a@b.com>\n\nbody\n',
  }), {});
  assert.strictEqual(r.rawMime.toString(), 'Subject: lf only\r\nFrom: <a@b.com>\r\n\r\nbody\r\n');
});

// --------------------------------------------------------------- mailgun ----

test('mailgun: a correctly signed raw-MIME POST is accepted', async () => {
  const key = 'key-0123456789abcdef';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  const { body, contentType } = multipart([
    { name: 'timestamp', value: timestamp },
    { name: 'token', value: token },
    { name: 'signature', value: signature },
    { name: 'sender', value: 'billing@acme.com' },
    { name: 'recipient', value: MBX },
    { name: 'body-mime', value: MESSAGE },
  ]);
  const r = await adapters.mailgun.parse(
    fakeReq({ headers: { 'content-type': contentType }, body }), { signingKey: key });
  assert.ok(r.rawMime.toString().includes('Invoice INV-2291'));
  assert.strictEqual(r.envelope.from, 'billing@acme.com');
  assert.deepStrictEqual(r.envelope.to, [MBX]);
});

test('mailgun: a forged signature is rejected', async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { body, contentType } = multipart([
    { name: 'timestamp', value: timestamp },
    { name: 'token', value: 'tok' },
    { name: 'signature', value: 'f'.repeat(64) },
    { name: 'body-mime', value: MESSAGE },
  ]);
  await assert.rejects(
    () => adapters.mailgun.parse(
      fakeReq({ headers: { 'content-type': contentType }, body }), { signingKey: 'key-x' }),
    (e) => e.statusCode === 401 && /signature mismatch/.test(e.message));
});

test('mailgun: a replayed old signature is rejected on the timestamp', async () => {
  const key = 'key-x';
  const timestamp = String(Math.floor(Date.now() / 1000) - 4000);
  const token = 'tok';
  const signature = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  const v = adapters.mailgun.verifySignature({ timestamp, token, signature }, key);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /stale/);
});

test('mailgun: a route configured without raw MIME gets a clear 422', async () => {
  const { body, contentType } = multipart([
    { name: 'sender', value: 'a@b.com' },
    { name: 'recipient', value: MBX },
    { name: 'body-plain', value: 'only the parsed text' },
  ]);
  await assert.rejects(
    () => adapters.mailgun.parse(fakeReq({ headers: { 'content-type': contentType }, body }), {}),
    (e) => e.statusCode === 422 && /raw MIME/.test(e.message));
});

// ----------------------------------------------------------- cloudmailin ----

test('cloudmailin: the JSON format', async () => {
  const payload = {
    envelope: {
      from: 'billing@acme.com', to: MBX, helo_domain: 'mail.acme.com',
      remote_ip: '192.0.2.9', tls: true, spf: { result: 'pass', domain: 'acme.com' },
    },
    raw_message: MESSAGE,
  };
  const r = await adapters.cloudmailin.parse(fakeReq({
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), {});
  assert.ok(r.rawMime.toString().includes('Invoice INV-2291'));
  assert.deepStrictEqual(r.envelope, {
    from: 'billing@acme.com', to: [MBX], helo: 'mail.acme.com', remote_ip: '192.0.2.9', tls: true,
  });
  assert.deepStrictEqual(r.meta.reported_spf, { result: 'pass', domain: 'acme.com' });
});

test('cloudmailin: the raw multipart format', async () => {
  const { body, contentType } = multipart([
    { name: 'envelope[from]', value: 'billing@acme.com' },
    { name: 'envelope[to]', value: MBX },
    { name: 'envelope[remote_ip]', value: '192.0.2.9' },
    { name: 'envelope[tls]', value: 'true' },
    { name: 'message', filename: 'message.eml', contentType: 'message/rfc822', value: MESSAGE },
  ]);
  const r = await adapters.cloudmailin.parse(
    fakeReq({ headers: { 'content-type': contentType }, body }), {});
  assert.ok(r.rawMime.toString().includes('Invoice INV-2291'));
  assert.strictEqual(r.envelope.remote_ip, '192.0.2.9');
  assert.strictEqual(r.envelope.tls, true);
});

test('cloudmailin: the shared secret is checked when configured', async () => {
  await assert.rejects(
    () => adapters.cloudmailin.parse(fakeReq({
      headers: { 'content-type': 'application/json' }, body: '{}',
    }), { secret: 'abc' }),
    (e) => e.statusCode === 401);
});

// --------------------------------------------------------------- generic ----

test('generic: a bare raw MIME POST works, envelope recovered from the message', async () => {
  const withReturnPath = 'Return-Path: <bounce@acme.com>\r\n' +
    `Delivered-To: ${MBX}\r\n` + MESSAGE;
  const r = await adapters.generic.parse(fakeReq({
    headers: { 'content-type': 'message/rfc822' }, body: withReturnPath,
  }), {});
  assert.strictEqual(r.envelope.from, 'bounce@acme.com');
  assert.deepStrictEqual(r.envelope.to, [MBX]);
});

test('generic: explicit headers win over the message contents', async () => {
  const r = await adapters.generic.parse(fakeReq({
    headers: {
      'content-type': 'message/rfc822',
      'x-mailmint-from': 'real@sender.com',
      'x-mailmint-to': MBX,
      'x-forwarded-for': '203.0.113.7',
    },
    body: MESSAGE,
  }), {});
  assert.strictEqual(r.envelope.from, 'real@sender.com');
  assert.strictEqual(r.envelope.remote_ip, '203.0.113.7');
});

test('generic: the JSON envelope + base64 form', async () => {
  const r = await adapters.generic.parse(fakeReq({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelope: { from: 'a@b.com', to: [MBX], helo: 'h', remote_ip: '1.2.3.4', tls: false },
      raw_mime_base64: Buffer.from(MESSAGE).toString('base64'),
    }),
  }), {});
  assert.ok(r.rawMime.toString().includes('Invoice INV-2291'));
  assert.strictEqual(r.envelope.helo, 'h');
  assert.strictEqual(r.envelope.tls, false);
});

test('every adapter returns the identical shape', async () => {
  for (const name of ['cloudflare', 'mailgun', 'cloudmailin', 'generic']) {
    assert.strictEqual(typeof adapters.get(name).parse, 'function', name);
  }
  assert.throws(() => adapters.get('nope'), /unknown intake adapter/);
});

// ---------------------------------------------------- end to end over HTTP ---

test('webhook intake produces exactly what the SMTP path produces', async () => {
  const stack = await startStack({ mailboxes: [MBX] });
  const intake = new IntakeHttpServer(stack.cfg, {
    resolver: stack.resolver,
    deliverer: stack.deliverer,
    dnsClient: stack.server.dnsClient,
    secrets: { cloudflare: { secret: 'shared' } },
  });
  await intake.listen(0, '127.0.0.1');
  const port = intake.address().port;

  try {
    const res = await post(port, '/inbound/cloudflare', {
      'content-type': 'message/rfc822',
      'x-mailmint-secret': 'shared',
      'x-mailmint-from': 'billing@acme.com',
      'x-mailmint-to': MBX,
    }, MESSAGE);
    assert.strictEqual(res.status, 200);

    const d = stack.api.delivered[0];
    assert.strictEqual(d.envelope.from, 'billing@acme.com');
    assert.deepStrictEqual(d.envelope.to, [MBX]);
    assert.strictEqual(d.recipients[0].token, 'k7m2xq4h9bwz');
    assert.deepStrictEqual(Object.keys(d.auth).sort(), ['dkim', 'dmarc', 'spam_score', 'spf']);
    const raw = d.raw_mime.toString();
    assert.match(raw, /^Received: from cloudflare-email-routing /);
    assert.ok(raw.includes('X-MailMint-Intake: cloudflare\r\n'));
    assert.ok(raw.endsWith(MESSAGE), 'the original bytes must be preserved verbatim');

    // an unknown mailbox is a 404 so the worker can reject in session
    const missing = await post(port, '/inbound/cloudflare', {
      'content-type': 'message/rfc822',
      'x-mailmint-secret': 'shared',
      'x-mailmint-from': 'billing@acme.com',
      'x-mailmint-to': 'zzzzzzzzzzzz@parse.example.com',
    }, MESSAGE);
    assert.strictEqual(missing.status, 404);

    const badSecret = await post(port, '/inbound/cloudflare',
      { 'x-mailmint-secret': 'nope' }, MESSAGE);
    assert.strictEqual(badSecret.status, 401);

    const health = await post(port, '/healthz', {}, '', 'GET');
    assert.strictEqual(health.status, 200);
  } finally {
    await intake.close();
    await stack.close();
  }
});

function post(port, path, headers, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
