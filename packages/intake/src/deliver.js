'use strict';

/**
 * The hand-off to the API: CONTRACT §3, `POST /internal/deliver`.
 *
 * The mark is only advanced on a 2xx from here, so this function's contract
 * back to the connector matters as much as the wire format:
 *
 *   resolves                -> the API owns the bytes now; advance
 *   throws with permanent   -> it will never work (unknown mailbox, malformed);
 *                              the connector decides to skip or to stop
 *   throws otherwise        -> transient; do NOT advance, try again later
 */

const { request, HttpError } = require('./http');
const { retry, delayFor } = require('./backoff');

class Deliverer {
  constructor({ apiUrl, secret, timeoutMs = 30000, attempts = 4, logger = null, wait = false }) {
    if (!apiUrl) throw new Error('deliver: apiUrl is required');
    if (!secret) throw new Error('deliver: the shared internal secret is required');
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.log = logger;
    this.wait = wait;
  }

  /** Cheap liveness + secret check, so a misconfigured connector fails loudly at start. */
  async ping() {
    const r = await request(`${this.apiUrl}/internal/ping`, {
      headers: { 'x-mailmint-internal': this.secret }, timeoutMs: this.timeoutMs,
    });
    return r.json || {};
  }

  async deliver({
    mailboxToken, raw, envelope, messageId = null, receivedAt = null,
    idempotencyKey = null, connector = null, forwarding = null, requestId = null,
  }) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const body = {
      mailbox_token: mailboxToken,
      raw_mime: buf.toString('base64'),
      encoding: 'base64',
      envelope,
      received_at: receivedAt,
      // Not consumed by the API yet. Sent because dedupe belongs on the side
      // that owns the database: if the same Message-ID arrives twice for the
      // same mailbox, only one message row should exist, and only the API can
      // enforce that. Until it does, the connector's own seen-set is the guard.
      message_id: messageId,
      idempotency_key: idempotencyKey || (messageId ? `${mailboxToken}:${messageId}` : null),
      source: (envelope && envelope.source) || 'imap',
      connector,
      ...(forwarding ? { forwarding_confirmation: forwarding } : {}),
      ...(this.wait ? { wait: true } : {}),
    };

    const started = Date.now();
    const res = await retry(async (attempt) => {
      try {
        return await request(`${this.apiUrl}/internal/deliver`, {
          method: 'POST',
          headers: {
            'x-mailmint-internal': this.secret,
            ...(body.idempotency_key ? { 'x-mailmint-idempotency-key': body.idempotency_key } : {}),
            ...(requestId ? { 'x-request-id': requestId } : {}),
          },
          json: body,
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        if (err instanceof HttpError && err.permanent && this.log) {
          this.log.error('connector.deliver.rejected', {
            status: err.status, message_id: messageId, attempt,
            error: typeof err.body === 'object' && err.body ? (err.body.error || err.message) : err.message,
          });
        }
        throw err;
      }
    }, {
      attempts: this.attempts,
      baseMs: 500,
      maxMs: 30000,
      onRetry: (err, attempt, ms) => {
        if (this.log) {
          this.log.warn('connector.deliver.retry', {
            attempt, in_ms: ms, message_id: messageId, error: err.message, status: err.status || null,
          });
        }
      },
    });

    return {
      ok: true,
      status: (res.json && res.json.status) || 'received',
      apiMessageId: (res.json && res.json.message_id) || null,
      ms: Date.now() - started,
      bytes: buf.length,
    };
  }
}

module.exports = { Deliverer, delayFor };
