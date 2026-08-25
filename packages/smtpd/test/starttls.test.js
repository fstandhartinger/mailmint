'use strict';
// STARTTLS. The certificate is generated on the fly with openssl; if openssl is
// not on the box the whole file skips rather than pretending to pass.

const test = require('node:test');
const assert = require('node:assert');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

const { startStack, SmtpClient } = require('./helpers');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailmint-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=mx-test.mailmint.local',
    '-addext', 'subjectAltName=DNS:mx-test.mailmint.local',
  ], { stdio: 'ignore' });
  return { dir, key, cert };
}

let CERT = null;
try { CERT = makeCert(); } catch { CERT = null; }
const SKIP = CERT ? false : 'openssl is not available';

test('STARTTLS is advertised only when a certificate loads', { skip: SKIP }, async () => {
  const stack = await startStack({
    mailboxes: [MBX],
    env: { TLS_KEY_PATH: CERT.key, TLS_CERT_PATH: CERT.cert },
  });
  try {
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    const r = await c.cmd('EHLO client.test');
    assert.ok(r.lines.map((l) => l.slice(4)).includes('STARTTLS'));
    c.destroy();
  } finally { await stack.close(); }
});

test('a broken certificate path does not crash the server and does not advertise STARTTLS', { skip: SKIP }, async () => {
  const stack = await startStack({
    mailboxes: [MBX],
    env: { TLS_KEY_PATH: '/nonexistent/key.pem', TLS_CERT_PATH: '/nonexistent/cert.pem' },
  });
  try {
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    const r = await c.cmd('EHLO client.test');
    assert.ok(!r.lines.map((l) => l.slice(4)).includes('STARTTLS'));
    assert.strictEqual((await c.cmd('STARTTLS')).code, 454);
    c.destroy();
  } finally { await stack.close(); }
});

test('a full message is delivered over STARTTLS and envelope.tls is true', { skip: SKIP }, async () => {
  const stack = await startStack({
    mailboxes: [MBX],
    env: { TLS_KEY_PATH: CERT.key, TLS_CERT_PATH: CERT.cert },
  });
  try {
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    await c.cmd('EHLO client.test');
    const go = await c.cmd('STARTTLS');
    assert.strictEqual(go.code, 220);

    // Upgrade the very same socket, exactly as a real MTA does.
    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({
        socket: c.socket,
        servername: 'mx-test.mailmint.local',
        rejectUnauthorized: false,
      }, () => resolve(s));
      s.on('error', reject);
    });
    assert.ok(secure.getProtocol().startsWith('TLSv1.'), 'expected a real TLS session');

    // Drive the encrypted channel by hand: accumulate until a final
    // "NNN " line (as opposed to the "NNN-" continuation form) arrives.
    let pending = '';
    const say = (line) => new Promise((resolve, reject) => {
      const onData = (chunk) => {
        pending += chunk.toString('binary');
        const lines = pending.split('\r\n');
        if (lines.length < 2) return;
        const last = lines[lines.length - 2];
        if (!/^\d{3} /.test(last)) return;
        secure.removeListener('data', onData);
        const raw = pending;
        pending = '';
        resolve({ code: Number(last.slice(0, 3)), raw });
      };
      secure.on('data', onData);
      secure.once('error', reject);
      secure.write(line);
    });

    let r = await say('EHLO client.test\r\n');
    assert.strictEqual(r.code, 250);
    assert.ok(!r.raw.includes('STARTTLS'), 'STARTTLS must not be offered twice');

    r = await say('MAIL FROM:<billing@acme.com>\r\n');
    assert.strictEqual(r.code, 250);
    r = await say(`RCPT TO:<${MBX}>\r\n`);
    assert.strictEqual(r.code, 250);
    r = await say('DATA\r\n');
    assert.strictEqual(r.code, 354);
    r = await say('Subject: over tls\r\nFrom: <billing@acme.com>\r\n\r\nencrypted body\r\n.\r\n');
    assert.strictEqual(r.code, 250);
    r = await say('QUIT\r\n');
    assert.strictEqual(r.code, 221);
    secure.destroy();

    const d = stack.api.delivered[0];
    assert.strictEqual(d.envelope.tls, true, 'the envelope must record that TLS was used');
    const raw = d.raw_mime.toString();
    assert.match(raw, /with ESMTPS id /, 'the Received header must say ESMTPS');
    assert.match(raw, /\(version=TLSv1\.[23] cipher=/, 'and record the negotiated parameters');
    assert.ok(raw.endsWith('encrypted body\r\n'));
  } finally { await stack.close(); }
});

test('plaintext state is discarded at the TLS handshake (CVE-2011-0411)', { skip: SKIP }, async () => {
  const stack = await startStack({
    mailboxes: [MBX],
    env: { TLS_KEY_PATH: CERT.key, TLS_CERT_PATH: CERT.cert },
  });
  try {
    const c = new SmtpClient({ port: stack.port });
    await c.connect();
    await c.read();
    await c.cmd('EHLO client.test');
    // inject a command in the SAME segment as STARTTLS: it must be dropped
    await c.write('STARTTLS\r\nMAIL FROM:<injected@evil.test>\r\n');
    const r = await c.read();
    assert.strictEqual(r.code, 220);

    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: c.socket, rejectUnauthorized: false }, () => resolve(s));
      s.on('error', reject);
    });
    // If the injected MAIL FROM had survived we would get a reply here without asking.
    const surprise = await Promise.race([
      new Promise((res) => secure.once('data', (d) => res(d.toString()))),
      new Promise((res) => setTimeout(() => res(null), 400)),
    ]);
    assert.strictEqual(surprise, null, 'nothing sent before TLS may be executed after it');
    secure.destroy();
  } finally { await stack.close(); }
});

process.on('exit', () => {
  if (CERT) { try { fsp.rm(CERT.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});
