'use strict';
// Shared test scaffolding: a fake API, a full smtpd stack, and a hand-written
// SMTP client that speaks over a real TCP socket (no libraries).

const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const config = require('../src/config');
const log = require('../src/log');
const { SmtpServer } = require('../src/server');
const { MailboxResolver } = require('../src/resolver');
const { Deliverer } = require('../src/deliver');
const { Spool } = require('../src/spool');
const { DnsClient } = require('../src/auth/dns');

log.setLevel(process.env.TEST_LOG_LEVEL || 'silent');

/** A stand-in for packages/api implementing just the two internal endpoints. */
function startFakeApi({ mailboxes = [], onDeliver = null, failWith = null } = {}) {
  const known = new Set(mailboxes.map((m) => m.toLowerCase()));
  const delivered = [];
  const calls = { resolve: 0, deliver: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/internal/resolve') {
      calls.resolve++;
      if (failWith) { res.writeHead(failWith); return res.end('nope'); }
      // CONTRACT §3a: POST {"to": "<full address>"}, header x-mailmint-internal.
      // This double used to answer the old GET ?address= form, so every resolve
      // came back 404 and the stack rejected valid recipients — 550 over SMTP,
      // 404 over the webhook intake. src/resolver.js and packages/api both
      // implement §3a; only this stub had drifted.
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        let to = '';
        try { to = String((JSON.parse(Buffer.concat(chunks).toString() || '{}') || {}).to || ''); }
        catch { to = ''; }
        const address = to.toLowerCase();
        if (address && known.has(address)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ mailbox: { id: 'mbx_' + address.split('@')[0], address, name: 'Test' } }));
        }
        res.writeHead(404);
        return res.end('{}');
      });
    }
    if (url.pathname === '/internal/deliver') {
      // §3a auth, checked here on purpose: this stub used to accept any headers,
      // so deliver.js sent x-mailmint-internal-secret for who knows how long and
      // every test passed while real deliveries 401'd.
      if ((req.headers['x-mailmint-internal'] || '') !== 'test-secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'x-mailmint-internal missing or wrong' } }));
      }
      calls.deliver++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (failWith) { res.writeHead(failWith); return res.end('nope'); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (e) { res.writeHead(400); return res.end(String(e)); }
        // §3a: the field is raw_mime, base64 unless encoding says utf8. This
        // stub decoded raw_mime_base64, which is the name the real API never
        // accepted — so the tests kept passing while live delivery 400'd.
        body.raw_mime = Buffer.from(
          body.raw_mime || body.raw_mime_base64 || '',
          body.encoding === 'utf8' ? 'utf8' : 'base64',
        );
        delivered.push(body);
        if (onDeliver) onDeliver(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_' + delivered.length, ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        delivered,
        calls,
        secret: 'test-secret',
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Boot a complete smtpd on an ephemeral high port, backed by the fake API. */
async function startStack(opts = {}) {
  const api = opts.api || await startFakeApi(opts);
  const spoolDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mailmint-spool-'));

  const env = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '0',
    SMTP_HOSTNAME: 'mx-test.mailmint.local',
    INBOUND_DOMAINS: 'parse.example.com',
    API_URL: api.url,
    INTERNAL_SECRET: api.secret,
    SPOOL_DIR: spoolDir,
    SPF_ENABLED: 'false',
    DKIM_ENABLED: 'false',
    DMARC_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    ...opts.env,
  };
  const cfg = config.build({ ...process.env, ...env });

  const spool = new Spool(cfg);
  await spool.init();
  const resolver = new MailboxResolver(cfg);
  const deliverer = new Deliverer({ ...cfg, spool, onApiFailure: opts.onApiFailure || 'accept' });
  const dnsClient = opts.dnsStub ? new DnsClient({ stub: opts.dnsStub }) : new DnsClient();

  const server = new SmtpServer(cfg, { resolver, deliverer, dnsClient });
  await server.listen(0, '127.0.0.1');
  const port = server.address().port;

  return {
    cfg, api, server, spool, spoolDir, resolver, deliverer, port,
    async close() {
      deliverer.stop();
      await server.close({ force: true });
      if (!opts.api) await api.close();
      await fsp.rm(spoolDir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ client ---

/**
 * A minimal SMTP client written directly on node:net, so the tests exercise a
 * real TCP conversation rather than a mocked socket.
 */
class SmtpClient {
  constructor({ port, host = '127.0.0.1', trace = false, timeoutMs = 20000 } = {}) {
    this.port = port;
    this.host = host;
    this.trace = trace;
    this.timeoutMs = timeoutMs;
    this.transcript = [];
    this.buf = '';
    this.waiters = [];
  }

  _log(dir, text) {
    for (const line of text.split(/\r\n/)) {
      if (line === '') continue;
      const rec = `${dir} ${line}`;
      this.transcript.push(rec);
      if (this.trace) console.log(rec);
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port: this.port, host: this.host }, () => resolve());
      this.socket.setTimeout(this.timeoutMs);
      this.socket.on('timeout', () => { this.socket.destroy(new Error('client timeout')); });
      this.socket.on('data', (c) => this._onData(c));
      this.socket.on('error', (e) => {
        for (const w of this.waiters.splice(0)) w.reject(e);
        reject(e);
      });
      this.socket.on('close', () => {
        this.closed = true;
        for (const w of this.waiters.splice(0)) w.reject(new Error('connection closed'));
      });
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('binary');
    this._drain();
  }

  _drain() {
    while (this.waiters.length) {
      const reply = this._takeReply();
      if (!reply) return;
      this._log('S:', reply.raw);
      this.waiters.shift().resolve(reply);
    }
  }

  /** A complete SMTP reply: lines "NNN-..." followed by a final "NNN ...". */
  _takeReply() {
    let consumed = 0;
    const lines = [];
    for (;;) {
      const nl = this.buf.indexOf('\r\n', consumed);
      if (nl === -1) return null;
      const line = this.buf.slice(consumed, nl);
      lines.push(line);
      consumed = nl + 2;
      if (/^\d{3} /.test(line) || line.length === 3) break;
    }
    const raw = this.buf.slice(0, consumed);
    this.buf = this.buf.slice(consumed);
    return { code: Number(lines[lines.length - 1].slice(0, 3)), lines, raw: raw.replace(/\r\n$/, '') };
  }

  /** Wait for the next complete reply. */
  read() {
    const reply = this._takeReply();
    if (reply) { this._log('S:', reply.raw); return Promise.resolve(reply); }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      setTimeout(() => reject(new Error('timed out waiting for reply')), this.timeoutMs).unref();
    });
  }

  /** Write raw bytes without waiting (used to test pipelining and split writes). */
  write(data, { silent = false } = {}) {
    // Strings go out as UTF-8 so SMTPUTF8 command lines are not mangled by the
    // test client itself; pass a Buffer when you need exact bytes.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (!silent) this._log('C:', buf.toString('utf8'));
    return new Promise((resolve, reject) => {
      this.socket.write(buf, (e) => (e ? reject(e) : resolve()));
    });
  }

  /** Send one command line and read the reply. */
  async cmd(line) {
    await this.write(line + '\r\n');
    return this.read();
  }

  note(text) {
    this.transcript.push(`#  ${text}`);
    if (this.trace) console.log(`#  ${text}`);
  }

  end() {
    try { this.socket.end(); } catch { /* ignore */ }
  }

  destroy() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

module.exports = { startFakeApi, startStack, SmtpClient };
