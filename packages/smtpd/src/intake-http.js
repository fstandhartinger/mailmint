'use strict';
// Webhook intake. The same pipeline as the SMTP path — authenticate, stamp the
// trace headers, spool, hand to the API — but fed by a provider's HTTP POST
// instead of a TCP session.
//
//   POST /inbound/cloudflare
//   POST /inbound/mailgun
//   POST /inbound/cloudmailin
//   POST /inbound/generic
//   GET  /healthz
//
// Run it instead of, or alongside, the SMTP listener. Nothing downstream can
// tell which intake a message came through.

const http = require('node:http');
const crypto = require('node:crypto');

const log = require('./log');
const adapters = require('./adapters');
const { routeRecipient } = require('./address');
const { receivedHeader } = require('./received');
const { authenticateWithDeadline, authenticationResultsHeader } = require('./auth');

class IntakeHttpServer {
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.resolver = deps.resolver;
    this.deliverer = deps.deliverer;
    this.dnsClient = deps.dnsClient;
    this.secrets = deps.secrets || {};
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  async onRequest(req, res) {
    const requestId = 'req_' + crypto.randomBytes(12).toString('hex');
    const started = Date.now();
    const url = new URL(req.url, 'http://internal');

    const finish = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      log.info('api.request', {
        request_id: requestId, method: req.method, path: url.pathname,
        status, ms: Date.now() - started, account: null,
      });
    };

    if (url.pathname === '/healthz') return finish(200, { ok: true });
    const m = /^\/inbound\/([a-z]+)\/?$/.exec(url.pathname);
    if (!m) return finish(404, { error: 'not found' });
    if (req.method !== 'POST') return finish(405, { error: 'use POST' });

    let adapter;
    try { adapter = adapters.get(m[1]); }
    catch { return finish(404, { error: `unknown adapter ${m[1]}` }); }

    try {
      const parsed = await adapter.parse(req, this.secrets[m[1]] || {});
      const outcome = await this.ingest(parsed, requestId, m[1]);
      return finish(outcome.status, outcome.body);
    } catch (err) {
      const status = err.statusCode || 500;
      log.warn('smtp.rejected', {
        request_id: requestId, source: m[1], status, reason: err.message,
      });
      return finish(status, { error: err.message });
    }
  }

  /** Shared with the SMTP path in spirit: same checks, same output. */
  async ingest(parsed, requestId, source) {
    const { rawMime, envelope } = parsed;
    if (!rawMime || !rawMime.length) return { status: 400, body: { error: 'empty message' } };
    if (rawMime.length > this.cfg.maxMessageBytes) {
      return { status: 413, body: { error: 'message too large' } };
    }

    // Resolve every recipient, exactly as RCPT TO would.
    const recipients = [];
    const unknown = [];
    for (const addr of envelope.to) {
      const route = routeRecipient(addr, this.cfg.inboundDomains);
      if (!route.ok) { unknown.push(addr); continue; }
      const found = await this.resolver.resolve(route.address, requestId);
      if (found.temporary) return { status: 503, body: { error: 'mailbox lookup failed, retry' } };
      if (!found.exists) { unknown.push(addr); continue; }
      recipients.push({ ...route, rcptTo: addr, mailbox: found.mailbox || null });
    }
    if (!recipients.length) {
      // 404 so the Cloudflare worker can reject in session instead of bouncing.
      return { status: 404, body: { error: 'unknown mailbox', addresses: unknown } };
    }

    const receivedAt = new Date();
    log.info('mail.received', {
      request_id: requestId, source, mail_from: envelope.from,
      rcpt_count: recipients.length, bytes: rawMime.length, tls: envelope.tls,
    });

    let authResult;
    try {
      authResult = await authenticateWithDeadline(rawMime, envelope, {
        dns: this.dnsClient,
        // Without a client IP there is nothing to check SPF against, and a
        // guessed answer is worse than an honest "none".
        spfEnabled: this.cfg.spfEnabled && Boolean(envelope.remote_ip),
        dkimEnabled: this.cfg.dkimEnabled,
        dmarcEnabled: this.cfg.dmarcEnabled,
        timeoutMs: this.cfg.authTimeoutMs,
      });
    } catch (e) {
      log.error('mail.auth_error', { request_id: requestId, error: e.message });
      authResult = {
        auth: { spf: 'temperror', dkim: 'temperror', dmarc: 'temperror', spam_score: 0 },
        flags: [], details: {}, timings_ms: {},
      };
    }

    const id = crypto.randomBytes(8).toString('hex').toUpperCase();
    const trace =
      receivedHeader({
        helo: envelope.helo || source,
        remoteIp: envelope.remote_ip || 'unknown',
        reverseDns: null,
        hostname: this.cfg.hostname,
        id,
        tls: envelope.tls === true,
        tlsInfo: null,
        esmtp: true,
        smtputf8: false,
        forAddress: recipients.length === 1 ? recipients[0].rcptTo : null,
        date: receivedAt,
      }) +
      authenticationResultsHeader(this.cfg.hostname, authResult) +
      `Return-Path: <${envelope.from}>\r\n` +
      `X-MailMint-Intake: ${source}\r\n`;

    const raw = Buffer.concat([Buffer.from(trace, 'utf8'), rawMime]);
    const meta = {
      id: `${id}-${crypto.randomBytes(4).toString('hex')}`,
      request_id: requestId,
      received_at: receivedAt.toISOString(),
      envelope,
      recipients: recipients.map((r) => ({
        address: r.address, token: r.token, slug: r.slug, tag: r.tag,
        rcpt_to: r.rcptTo, mailbox: r.mailbox,
      })),
      auth: authResult.auth,
      flags: authResult.flags,
      auth_details: authResult.details,
      via: source,
    };

    const outcome = await this.deliverer.handle(raw, meta);
    if (outcome.action === 'accepted') return { status: 200, body: { ok: true, id: meta.id } };
    if (outcome.action === 'rejected') return { status: 400, body: { error: outcome.message } };
    return { status: 503, body: { error: outcome.message } };
  }

  listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        const a = this.server.address();
        log.info('intake.listening', { host: a.address, port: a.port });
        resolve(a);
      });
    });
  }

  address() { return this.server.address(); }
  close() { return new Promise((r) => this.server.close(r)); }
}

module.exports = { IntakeHttpServer };
