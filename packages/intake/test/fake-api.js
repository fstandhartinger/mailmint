'use strict';

/**
 * A stand-in for packages/api's /internal/* surface, matching CONTRACT §3:
 * the shared-secret header, the base64 raw_mime, and the {message_id, status}
 * answer. It records exactly what it was given so the tests can assert on the
 * bytes that crossed the boundary rather than on the connector's own opinion.
 */

const http = require('node:http');

class FakeApi {
  constructor(opts = {}) {
    this.secret = opts.secret || 'test-internal-secret';
    this.supportsState = opts.supportsState !== false;
    this.knownTokens = opts.knownTokens || null;    // null = accept any
    this.delivered = [];
    this.state = new Map();
    this.forwarding = [];
    this.requests = [];
    this._failures = [];                            // queue of statuses to return
    this.seq = 0;
    this.dedupe = opts.dedupe === true;
    this._byIdempotency = new Map();
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  /** Queue `count` responses with this status before working normally again. */
  failNext(count, status = 503) { for (let i = 0; i < count; i += 1) this._failures.push(status); }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address())));
  }

  get url() { return `http://127.0.0.1:${this.server.address().port}`; }

  close() { return new Promise((resolve) => this.server.close(resolve)); }

  _handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = body.length ? JSON.parse(body.toString('utf8')) : {};
      const url = new URL(req.url, 'http://x');
      this.requests.push({ method: req.method, path: url.pathname, ts: Date.now() });
      const send = (status, obj) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length });
        res.end(b);
      };

      if (req.headers['x-mailmint-internal'] !== this.secret) {
        return send(401, { error: 'unauthorized' });
      }
      if (url.pathname === '/internal/ping') return send(200, { ok: true, domain: 'parse.example.com' });

      if (url.pathname === '/internal/connector-state') {
        if (!this.supportsState) return send(404, { error: 'not_found' });
        if (req.method === 'GET') {
          return send(200, { state: this.state.get(url.searchParams.get('connection_id')) || {} });
        }
        this.state.set(json.connection_id, json.state);
        return send(200, { ok: true });
      }

      if (url.pathname === '/internal/forwarding-confirmation') {
        this.forwarding.push(json);
        return send(200, { ok: true });
      }

      if (url.pathname === '/internal/deliver') {
        if (this._failures.length) {
          const status = this._failures.shift();
          return send(status, { error: 'temporarily_unavailable' });
        }
        if (this.knownTokens && !this.knownTokens.includes(json.mailbox_token)) {
          return send(404, { error: 'unknown_mailbox' });
        }
        if (!json.raw_mime) return send(400, { error: 'missing_raw_mime' });
        const raw = Buffer.from(json.raw_mime, json.encoding === 'utf8' ? 'utf8' : 'base64');
        if (this.dedupe && json.idempotency_key && this._byIdempotency.has(json.idempotency_key)) {
          return send(200, { message_id: this._byIdempotency.get(json.idempotency_key), status: 'duplicate' });
        }
        this.seq += 1;
        const id = `msg_TEST${String(this.seq).padStart(6, '0')}`;
        if (json.idempotency_key) this._byIdempotency.set(json.idempotency_key, id);
        this.delivered.push({
          id,
          mailbox_token: json.mailbox_token,
          message_id: json.message_id,
          idempotency_key: json.idempotency_key,
          envelope: json.envelope,
          connector: json.connector,
          forwarding: json.forwarding_confirmation || null,
          received_at: json.received_at,
          raw,
          size: raw.length,
        });
        return send(200, { message_id: id, status: 'received' });
      }

      return send(404, { error: 'not_found' });
    });
  }
}

module.exports = { FakeApi };
