'use strict';

/**
 * The poller: turns "a mailbox somewhere else" into "messages at
 * POST /internal/deliver", without ever losing one and without ever delivering
 * one twice.
 *
 * The rules that make that true, in order of importance:
 *
 *  1. Items are processed in ascending cursor order and the loop STOPS at the
 *     first transient failure. Skipping ahead past a failure is how mail gets
 *     lost, because the mark would move past a message that was never sent.
 *  2. The mark advances only after a 2xx, and it is persisted immediately —
 *     per message, not per batch.
 *  3. Because (2) is two operations that can be interrupted between, delivery
 *     is at-least-once, so every message also carries its Message-ID as an
 *     idempotency key, and the connector keeps its own bounded set of delivered
 *     keys and Message-ID hashes to catch the same case locally.
 *  4. A UIDVALIDITY change invalidates the mark but not the mailbox: we rescan
 *     and use the Message-ID set to work out what was already delivered,
 *     instead of replaying the customer's inbox into their webhook.
 */

const { EventEmitter } = require('node:events');
const { summarise } = require('./mime-lite');
const { createProvider } = require('./providers');
const { createStore, pushBounded, idHash, emptyState } = require('./state');
const { Deliverer } = require('./deliver');
const forwarding = require('./forwarding');
const { delayFor, sleep } = require('./backoff');
const { log: rootLog } = require('./log');

const DEFAULTS = {
  batchSize: 50,
  maxMessageBytes: 25 * 1024 * 1024,
  pollIntervalMs: 60000,
  idleMs: 29 * 60 * 1000,
  detectForwarding: true,
  maxConsecutiveFailures: 12,
};

class Connector extends EventEmitter {
  constructor(conf = {}, deps = {}) {
    super();
    if (!conf.id) throw new Error('connector: id is required');
    if (!conf.mailbox_token && !conf.mailboxToken) throw new Error(`connector ${conf.id}: mailbox_token is required`);
    this.conf = { ...DEFAULTS, ...conf };
    this.id = conf.id;
    this.mailboxToken = conf.mailbox_token || conf.mailboxToken;
    this.log = (deps.logger || rootLog).child({ connection_id: this.id, mailbox_token: this.mailboxToken });
    this.provider = deps.provider || createProvider(this.conf, { logger: this.log });
    this.deliverer = deps.deliverer || new Deliverer({
      apiUrl: conf.apiUrl, secret: conf.internalSecret, logger: this.log, wait: !!conf.wait,
    });
    this.store = deps.store || createStore({
      apiUrl: conf.apiUrl, secret: conf.internalSecret,
      file: conf.stateFile || `${process.cwd()}/.mailmint-intake-state.json`,
      logger: this.log,
    });
    this.opened = false;
    this.stopping = false;
    this.failures = 0;
    this.metrics = {
      delivered: 0, skipped: 0, bytes: 0, cycles: 0, errors: 0,
      lag_ms_total: 0, lag_samples: 0, lag_ms_max: 0,
      started_at: new Date().toISOString(),
    };
  }

  async open() {
    if (this.opened) return;
    await this.provider.open();
    this.opened = true;
  }

  async close() {
    this.stopping = true;
    if (this.provider.stopWaiting) this.provider.stopWaiting();
    if (this.opened) { await this.provider.close(); this.opened = false; }
  }

  /* ----------------------------------------------------------- one cycle */

  async runOnce({ limit } = {}) {
    const cycleStarted = Date.now();
    await this.open();
    this.metrics.cycles += 1;

    const state = { ...emptyState(), ...(await this.store.get(this.id)) };
    const batch = limit || this.conf.batchSize;

    let listing = await this.provider.list({ sinceCursor: state.cursor, limit: batch });
    let resynced = false;

    if (state.validity && listing.validity && listing.validity !== state.validity) {
      // The cursor space changed under us. The old mark is meaningless now.
      this.log.warn('connector.resync', {
        event_reason: 'validity_changed',
        old_validity: state.validity, new_validity: listing.validity,
        old_cursor: state.cursor,
        note: 'rescanning and using delivered Message-IDs to avoid re-delivery',
      });
      listing = await this.provider.list({ sinceCursor: null, limit: batch, resync: true });
      if (this.provider.identify) await this.provider.identify(listing.items);
      resynced = true;
      state.validity = listing.validity;
      state.cursor = null;
      this.emit('resync', { validity: listing.validity });
    }

    if (!state.validity) {
      state.validity = listing.validity;
      if (!listing.items.length && this.provider.initialCursor) {
        const c = this.provider.initialCursor();
        if (c) state.cursor = c;      // 'start from now', not 'replay the archive'
      }
      await this.store.set(this.id, state);
      this.log.info('connector.initialised', {
        validity: state.validity, cursor: state.cursor, pending: listing.items.length,
      });
    }

    const result = {
      listed: listing.items.length, delivered: 0, skipped: 0, failed: 0,
      more: !!listing.more, resynced, bytes: 0, lag_ms: [], stopped_early: false,
    };

    for (const item of listing.items) {
      if (this.stopping) { result.stopped_early = true; break; }
      const outcome = await this._handleItem(item, state, { resynced });
      if (outcome.status === 'delivered') {
        result.delivered += 1;
        result.bytes += outcome.bytes || 0;
        if (outcome.lagMs !== null && outcome.lagMs !== undefined) result.lag_ms.push(outcome.lagMs);
      } else if (outcome.status === 'skipped') {
        result.skipped += 1;
      } else {
        result.failed += 1;
        result.stopped_early = true;
        result.error = outcome.error;
        // Stop the batch here: the mark must not move past a message we could
        // not deliver.
        break;
      }
    }

    if (result.delivered && this.provider.acknowledge) {
      try { await this.provider.acknowledge(listing.items.slice(0, result.delivered + result.skipped)); }
      catch (err) { this.log.warn('connector.acknowledge_failed', { error: err.message }); }
    }

    result.ms = Date.now() - cycleStarted;
    result.cursor = state.cursor;
    this.log.info('connector.cycle', {
      listed: result.listed, delivered: result.delivered, skipped: result.skipped,
      failed: result.failed, bytes: result.bytes, ms: result.ms, cursor: result.cursor,
      more: result.more, resynced,
    });
    this.emit('cycle', result);
    if (result.failed) throw Object.assign(new Error(result.error || 'delivery failed'), { cycle: result });
    this.failures = 0;
    return result;
  }

  async _handleItem(item, state, { resynced }) {
    const seenKey = String(item.key);
    if (state.seen.includes(seenKey) && !resynced) {
      state.cursor = item.cursor;
      await this.store.set(this.id, state);
      return { status: 'skipped', reason: 'already_seen' };
    }

    if (item.size && item.size > this.conf.maxMessageBytes) {
      this.log.warn('connector.skipped', {
        reason: 'too_large', key: seenKey, size: item.size, cap: this.conf.maxMessageBytes,
      });
      state.cursor = item.cursor;
      pushBounded(state.seen, seenKey);
      await this.store.set(this.id, state);
      this.metrics.skipped += 1;
      return { status: 'skipped', reason: 'too_large' };
    }

    // Cheap identity check before pulling bytes, when the provider has it free.
    if (item.messageId && state.seen_message_ids.includes(idHash(item.messageId))) {
      this.log.info('connector.duplicate', { reason: 'message_id_seen', key: seenKey });
      state.cursor = item.cursor;
      pushBounded(state.seen, seenKey);
      await this.store.set(this.id, state);
      this.metrics.skipped += 1;
      return { status: 'skipped', reason: 'duplicate' };
    }

    let fetched;
    try {
      fetched = await this.provider.fetch(item);
    } catch (err) {
      this.log.error('connector.fetch_failed', { key: seenKey, error: err.message });
      this.metrics.errors += 1;
      return { status: 'failed', error: `fetch: ${err.message}` };
    }

    if (!fetched.raw) {
      this.log.warn('connector.skipped', { reason: fetched.skipped || 'empty', key: seenKey, size: item.size });
      state.cursor = item.cursor;
      pushBounded(state.seen, seenKey);
      await this.store.set(this.id, state);
      this.metrics.skipped += 1;
      return { status: 'skipped', reason: fetched.skipped || 'empty' };
    }

    const sum = summarise(fetched.raw);
    const messageId = item.messageId || sum.messageId;
    const hash = idHash(messageId);
    if (hash && state.seen_message_ids.includes(hash)) {
      this.log.info('connector.duplicate', { reason: 'message_id_seen', key: seenKey });
      state.cursor = item.cursor;
      pushBounded(state.seen, seenKey);
      await this.store.set(this.id, state);
      this.metrics.skipped += 1;
      return { status: 'skipped', reason: 'duplicate' };
    }

    let confirmation = null;
    if (this.conf.detectForwarding) {
      try { confirmation = forwarding.detect(fetched.raw); } catch (err) {
        this.log.warn('forwarding.detect_failed', { error: err.message });
      }
      if (confirmation) {
        this.log.info('forwarding.confirmation', {
          provider: confirmation.provider, code: confirmation.code,
          link_host: confirmation.link_host, link_trusted: confirmation.link_trusted,
          confidence: confirmation.confidence, action: confirmation.action,
        });
        state.forwarding = { ...confirmation, seen_at: new Date().toISOString() };
        this.emit('forwarding', confirmation);
        if (this.conf.apiUrl && this.conf.internalSecret) {
          const r = await forwarding.publish(confirmation, {
            apiUrl: this.conf.apiUrl, secret: this.conf.internalSecret, mailboxToken: this.mailboxToken,
          });
          if (!r.published) {
            this.log.debug('forwarding.publish_skipped', { status: r.status, reason: r.reason });
          }
        }
      }
    }

    const envelope = {
      from: sum.returnPath || sum.from || null,
      to: sum.to && sum.to.length ? sum.to : (item.to || []),
      helo: null,
      remote_ip: null,
      tls: true,                      // the hop we made to get it was TLS; the original hop is unknown
      source: this.provider.kind,
    };

    try {
      const res = await this.deliverer.deliver({
        mailboxToken: this.mailboxToken,
        raw: fetched.raw,
        envelope,
        messageId,
        receivedAt: item.receivedAt || null,
        idempotencyKey: `${this.id}:${state.validity}:${seenKey}`,
        connector: {
          connection_id: this.id, provider: this.provider.kind,
          key: seenKey, validity: state.validity, truncated: !!fetched.truncated,
        },
        forwarding: confirmation,
      });

      // Mark first, then persist: the order that turns a crash into at most one
      // duplicate instead of a lost message.
      state.cursor = item.cursor;
      pushBounded(state.seen, seenKey);
      if (hash) pushBounded(state.seen_message_ids, hash);
      state.stats = {
        ...(state.stats || {}),
        delivered: ((state.stats || {}).delivered || 0) + 1,
        last_delivered_at: new Date().toISOString(),
      };
      await this.store.set(this.id, state);

      const lagMs = item.receivedAt ? Date.now() - new Date(item.receivedAt).getTime() : null;
      this.metrics.delivered += 1;
      this.metrics.bytes += fetched.raw.length;
      if (lagMs !== null && Number.isFinite(lagMs)) {
        this.metrics.lag_samples += 1;
        this.metrics.lag_ms_total += lagMs;
        this.metrics.lag_ms_max = Math.max(this.metrics.lag_ms_max, lagMs);
      }
      this.log.info('connector.delivered', {
        key: seenKey, api_message_id: res.apiMessageId, status: res.status,
        bytes: fetched.raw.length, deliver_ms: res.ms, lag_ms: lagMs,
        from: envelope.from, message_id: messageId, subject_len: (sum.subject || '').length,
      });
      this.emit('delivered', { item, apiMessageId: res.apiMessageId, lagMs, bytes: fetched.raw.length });
      return { status: 'delivered', bytes: fetched.raw.length, lagMs };
    } catch (err) {
      this.metrics.errors += 1;
      if (err.permanent && err.status && err.status !== 404) {
        // The API will reject this message the same way forever (malformed,
        // too large). Refusing to move past it would wedge the whole mailbox,
        // so it is logged loudly and skipped — never silently dropped.
        this.log.error('connector.poison', {
          key: seenKey, status: err.status, error: err.message, message_id: messageId,
          note: 'permanently rejected by the API; advancing past it',
        });
        state.cursor = item.cursor;
        pushBounded(state.seen, seenKey);
        await this.store.set(this.id, state);
        this.metrics.skipped += 1;
        return { status: 'skipped', reason: 'rejected' };
      }
      if (err.status === 404) {
        // Wrong mailbox_token: a configuration error, not a message error.
        const fatal = Object.assign(new Error(`mailbox_token "${this.mailboxToken}" is not known to the API`), { fatal: true });
        this.log.error('connector.fatal', { error: fatal.message, status: 404 });
        this.emit('fatal', fatal);
        throw fatal;
      }
      this.log.warn('connector.deliver_failed', { key: seenKey, error: err.message, status: err.status || null });
      return { status: 'failed', error: err.message };
    }
  }

  /* ------------------------------------------------------------ the loop */

  /**
   * Runs until stop(). Drains, then waits for a change (IDLE where available,
   * interval polling where not), and backs off exponentially on failure.
   */
  async run({ signal } = {}) {
    this.stopping = false;
    if (signal) signal.addEventListener('abort', () => this.stop(), { once: true });
    while (!this.stopping) {
      try {
        let more = true;
        while (more && !this.stopping) {
          const r = await this.runOnce();
          more = r.more && !r.stopped_early;
        }
        this.failures = 0;
        if (this.stopping) break;
        const wait = await this.provider.waitForChange({ maxMs: this.conf.idleMs });
        this.log.debug('connector.wake', { reason: wait && wait.reason });
      } catch (err) {
        if (err.fatal) { this.emit('stopped', { reason: 'fatal', error: err.message }); return; }
        this.failures += 1;
        const ms = delayFor(this.failures, { baseMs: 2000, maxMs: this.conf.pollIntervalMs * 5 });
        this.log.warn('connector.backoff', {
          failures: this.failures, in_ms: ms, error: err.message,
          permanent: !!err.permanent,
        });
        if (err.permanent || this.failures >= this.conf.maxConsecutiveFailures) {
          this.log.error('connector.giving_up', { failures: this.failures, error: err.message });
          this.emit('stopped', { reason: 'too_many_failures', error: err.message });
          await this.close().catch(() => {});
          return;
        }
        // A broken connection has to be rebuilt, not reused.
        try { await this.provider.close(); } catch { /* already gone */ }
        this.opened = false;
        await sleep(ms);
      }
    }
    this.emit('stopped', { reason: 'requested' });
  }

  stop() {
    this.stopping = true;
    if (this.provider.stopWaiting) this.provider.stopWaiting();
  }

  summary() {
    const m = this.metrics;
    const mins = (Date.now() - new Date(m.started_at).getTime()) / 60000;
    return {
      ...m,
      messages_per_minute: mins > 0 ? Number((m.delivered / mins).toFixed(2)) : null,
      lag_ms_mean: m.lag_samples ? Math.round(m.lag_ms_total / m.lag_samples) : null,
    };
  }
}

/** Runs several connections side by side. */
class ConnectorPool {
  constructor(connections, deps = {}) {
    this.connectors = connections.map((c) => new Connector(c, deps));
  }

  runAll() { return Promise.all(this.connectors.map((c) => c.run())); }
  stopAll() { this.connectors.forEach((c) => c.stop()); }
  summaries() { return this.connectors.map((c) => ({ id: c.id, ...c.summary() })); }
}

module.exports = { Connector, ConnectorPool, DEFAULTS };
