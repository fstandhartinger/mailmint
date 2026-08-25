'use strict';
// Handing a received message to the API.
//
// Order of operations on a successful DATA:
//   1. write the message to the spool and fsync it   <- durability point
//   2. POST it to {API_URL}/internal/deliver
//   3a. 2xx            -> drop the spool entry, answer 250
//   3b. 404/410        -> mailbox vanished between RCPT and DATA: 550 5.1.1
//   3c. anything else  -> the message stays in the spool
//        ON_API_FAILURE=accept (default): answer 250, the drainer retries.
//        ON_API_FAILURE=defer:            answer 451 4.3.0, the SENDER retries.
//   If step 1 itself fails we have nothing durable, so it is always 451 4.3.0.
//
// `accept` is the default because we are already durable at that point and a
// 451 there would produce a duplicate: the sender retries AND our drainer
// delivers. `defer` exists for operators who would rather never queue.

const log = require('./log');
const { Spool } = require('./spool');

const BACKOFF_MS = [0, 5e3, 15e3, 60e3, 300e3, 900e3, 3600e3, 6 * 3600e3];

class Deliverer {
  constructor(opts) {
    this.apiUrl = opts.apiUrl;
    this.secret = opts.internalSecret;
    this.timeoutMs = opts.apiTimeoutMs ?? 15000;
    this.spool = opts.spool || new Spool(opts);
    this.onApiFailure = opts.onApiFailure || 'accept';
    this.drainIntervalMs = opts.spoolDrainIntervalMs ?? 15000;
    this.maxAttempts = opts.spoolMaxAttempts ?? 24;
    this._fetch = opts.fetch || globalThis.fetch;
    this._timer = null;
    this._draining = false;
    this.stats = { delivered: 0, spooled: 0, drained: 0, failed: 0 };
  }

  async init() { await this.spool.init(); }

  /**
   * @returns {{action:'accepted'|'deferred'|'rejected', code, message, spoolId}}
   */
  async handle(raw, envelopeMeta) {
    const requestId = envelopeMeta.request_id;
    let spoolId;
    try {
      spoolId = await this.spool.put(raw, envelopeMeta);
    } catch (e) {
      log.error('mail.spool_failed', { request_id: requestId, error: e.message });
      return { action: 'deferred', code: '451 4.3.0', message: 'temporary local error, try again later' };
    }
    this.stats.spooled++;

    const res = await this.post(raw, envelopeMeta, requestId);
    if (res.ok) {
      await this.spool.remove(spoolId);
      this.stats.delivered++;
      return { action: 'accepted', code: '250 2.0.0', message: `OK id=${spoolId}`, spoolId, api: res.body };
    }
    if (res.permanent) {
      await this.spool.remove(spoolId);
      return {
        action: 'rejected',
        code: res.status === 404 || res.status === 410 ? '550 5.1.1' : '550 5.7.1',
        message: res.message || 'rejected by policy',
        spoolId,
      };
    }
    // temporary
    if (this.onApiFailure === 'defer') {
      await this.spool.remove(spoolId);
      return { action: 'deferred', code: '451 4.3.0', message: 'upstream unavailable, try again later', spoolId };
    }
    await this.spool.touch(spoolId, { attempts: 1, next_attempt: Date.now() + BACKOFF_MS[1] });
    log.warn('mail.spooled', { request_id: requestId, spool_id: spoolId, reason: res.message });
    return { action: 'accepted', code: '250 2.0.0', message: `queued id=${spoolId}`, spoolId, queued: true };
  }

  async post(raw, meta, requestId) {
    const url = `${this.apiUrl}/internal/deliver`;
    const body = JSON.stringify({
      id: meta.id,
      received_at: meta.received_at,
      envelope: meta.envelope,
      recipients: meta.recipients,
      auth: meta.auth,
      flags: meta.flags,
      auth_details: meta.auth_details,
      size: raw.length,
      raw_mime_base64: raw.toString('base64'),
    });
    const started = Date.now();
    try {
      const res = await this._fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mailmint-internal-secret': this.secret || '',
          'x-mailmint-request-id': requestId || '',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const ms = Date.now() - started;
      if (res.status >= 200 && res.status < 300) {
        let parsed = null;
        try { parsed = await res.json(); } catch { /* body optional */ }
        log.info('mail.delivered', { request_id: requestId, status: res.status, ms, bytes: raw.length });
        return { ok: true, status: res.status, body: parsed };
      }
      let text = '';
      try { text = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      const permanent = res.status === 404 || res.status === 410 || res.status === 413 || res.status === 422;
      log.warn('mail.deliver_failed', { request_id: requestId, status: res.status, ms, permanent, body: text });
      return { ok: false, status: res.status, permanent, message: `api ${res.status}` };
    } catch (err) {
      log.warn('mail.deliver_failed', {
        request_id: requestId, ms: Date.now() - started,
        error: err.name === 'TimeoutError' ? 'timeout' : err.message, permanent: false,
      });
      return { ok: false, status: 0, permanent: false, message: err.message };
    }
  }

  // ------------------------------------------------------------ drainer ---

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.drain().catch(() => {}); }, this.drainIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async drain() {
    if (this._draining) return { skipped: true };
    this._draining = true;
    const summary = { tried: 0, delivered: 0, deferred: 0, failed: 0 };
    try {
      const ids = await this.spool.list();
      for (const id of ids) {
        let entry;
        try { entry = await this.spool.read(id); }
        catch { continue; } // being written right now, or already gone
        const meta = entry.meta;
        if (meta.next_attempt && meta.next_attempt > Date.now()) continue;
        summary.tried++;
        const res = await this.post(entry.raw, meta, meta.request_id);
        if (res.ok) {
          await this.spool.remove(id);
          summary.delivered++; this.stats.drained++;
          log.info('mail.spool_drained', { spool_id: id, attempts: meta.attempts });
          continue;
        }
        const attempts = (meta.attempts || 0) + 1;
        if (res.permanent || attempts >= this.maxAttempts) {
          await this.spool.fail(id, res.message || `gave up after ${attempts} attempts`);
          summary.failed++; this.stats.failed++;
          log.error('mail.spool_gave_up', { spool_id: id, attempts, reason: res.message });
          continue;
        }
        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        await this.spool.touch(id, { attempts, next_attempt: Date.now() + delay, last_error: res.message });
        summary.deferred++;
      }
    } finally {
      this._draining = false;
    }
    return summary;
  }
}

module.exports = { Deliverer, BACKOFF_MS };
