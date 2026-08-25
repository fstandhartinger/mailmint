'use strict';
// Ask the API whether a mailbox exists, at RCPT time.
//
// Two things matter here:
//  1. We reject unknown recipients at RCPT TO, never after DATA. Accept-then-
//     bounce is backscatter and gets our IP listed.
//  2. A dictionary attack must not become a denial of service against the API,
//     so answers are cached (positive 60s, negative 10s) and concurrent lookups
//     for the same address are coalesced into a single request.

const log = require('./log');

class MailboxResolver {
  constructor(opts) {
    this.apiUrl = opts.apiUrl;
    this.secret = opts.internalSecret;
    this.timeoutMs = opts.resolveTimeoutMs ?? 5000;
    this.positiveTtlMs = opts.resolvePositiveTtlMs ?? 60000;
    this.negativeTtlMs = opts.resolveNegativeTtlMs ?? 10000;
    this.max = opts.resolveCacheMax ?? 10000;
    this.cache = new Map();
    this.inflight = new Map();
    this.stats = { hit: 0, miss: 0, error: 0 };
    this._fetch = opts.fetch || globalThis.fetch;
  }

  _get(address) {
    const e = this.cache.get(address);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.cache.delete(address); return undefined; }
    this.cache.delete(address); this.cache.set(address, e);
    return e.value;
  }

  _set(address, value) {
    if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value);
    const ttl = value.exists ? this.positiveTtlMs : this.negativeTtlMs;
    this.cache.set(address, { value, exp: Date.now() + ttl });
  }

  invalidate(address) { this.cache.delete(address); }
  clear() { this.cache.clear(); }

  /**
   * @param {string} address canonical <token>@<domain>
   * @returns {Promise<{exists:boolean, mailbox?:object, temporary?:boolean, cached?:boolean}>}
   */
  async resolve(address, requestId) {
    const cached = this._get(address);
    if (cached) { this.stats.hit++; return { ...cached, cached: true }; }

    const pending = this.inflight.get(address);
    if (pending) return pending;

    const p = this._lookup(address, requestId).finally(() => this.inflight.delete(address));
    this.inflight.set(address, p);
    return p;
  }

  async _lookup(address, requestId) {
    this.stats.miss++;
    const url = `${this.apiUrl}/internal/resolve?address=${encodeURIComponent(address)}`;
    const started = Date.now();
    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mailmint-internal-secret': this.secret || '',
          'x-mailmint-request-id': requestId || '',
        },
        body: JSON.stringify({ address }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const ms = Date.now() - started;
      if (res.status === 200) {
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        const mailbox = (body && (body.mailbox || body)) || null;
        const value = { exists: true, mailbox };
        this._set(address, value);
        log.debug('smtp.resolve', { request_id: requestId, address, status: 200, ms, exists: true });
        return value;
      }
      if (res.status === 404 || res.status === 410) {
        const value = { exists: false };
        this._set(address, value);
        log.debug('smtp.resolve', { request_id: requestId, address, status: res.status, ms, exists: false });
        return value;
      }
      // 401/403 is our own misconfiguration; 5xx is the API being down.
      // Both are temporary from the sender's point of view: 451, they retry.
      this.stats.error++;
      log.warn('smtp.resolve', { request_id: requestId, address, status: res.status, ms, temporary: true });
      return { exists: false, temporary: true, status: res.status };
    } catch (err) {
      this.stats.error++;
      log.warn('smtp.resolve', {
        request_id: requestId, address, ms: Date.now() - started,
        temporary: true, error: err.name === 'TimeoutError' ? 'timeout' : err.message,
      });
      return { exists: false, temporary: true, error: err.message };
    }
  }
}

module.exports = { MailboxResolver };
