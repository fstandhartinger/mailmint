'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { request, HttpError } = require('../http');
const { sleep } = require('../backoff');

const API = 'https://api.mail.tm';
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * mail.tm — a real, live mailbox reachable over HTTPS instead of IMAP.
 *
 * It exists here for two reasons. It is what our end-to-end tests actually run
 * against (a real inbox holding real DKIM-signed mail from real senders), and
 * it is the second implementation of the provider interface, which is what
 * keeps that interface honest about the things that differ between sources:
 *
 *   - cursors are timestamps, not integers
 *   - identity is the server's own `msgid`, so no extra fetch is needed
 *   - there is no push, so waitForChange() is a sleep
 *   - the bearer token expires, so open() has to be able to re-authenticate
 */
class MailTmProvider {
  constructor(conf = {}, deps = {}) {
    this.conf = conf;
    this.kind = 'mailtm';
    this.id = conf.id || `mailtm:${conf.address || 'unknown'}`;
    this.log = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.base = conf.apiBase || API;
    this.address = conf.address || null;
    this.password = conf.password || null;
    this.token = conf.token || null;
    this.credentialsFile = conf.credentialsFile || null;
    this.maxMessageBytes = conf.maxMessageBytes || DEFAULT_MAX_BYTES;
    this.markSeen = conf.markSeen === true;          // opt-in: it mutates the inbox
    this.pollIntervalMs = conf.pollIntervalMs || 15000;
    this.maxPages = conf.maxPages || 5;
    this.accountId = null;
    this.capabilities = { push: false };
    this._waitAbort = null;
    this.transcript = conf.transcript ? [] : null;
  }

  _record(line) {
    if (!this.transcript) return;
    this.transcript.push(line);
    if (this.transcript.length > 200) this.transcript.shift();
  }

  async _loadCredentials() {
    if (!this.credentialsFile) return;
    const raw = await fsp.readFile(this.credentialsFile, 'utf8');
    const c = JSON.parse(raw);
    this.address = this.address || c.address;
    this.password = this.password || c.password;
    this.token = this.token || c.token;
  }

  async _saveToken() {
    if (!this.credentialsFile) return;
    try {
      const c = JSON.parse(await fsp.readFile(this.credentialsFile, 'utf8'));
      c.token = this.token;
      await fsp.writeFile(this.credentialsFile, JSON.stringify(c, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.warn('mailtm.token_not_persisted', { error: err.message });
    }
  }

  async _refreshToken() {
    if (!this.address || !this.password) {
      throw new HttpError('mail.tm token expired and no address/password is available to refresh it', { permanent: true });
    }
    const r = await request(`${this.base}/token`, {
      method: 'POST', json: { address: this.address, password: this.password }, timeoutMs: 20000,
    });
    this.token = r.json.token;
    this.accountId = r.json.id || this.accountId;
    this._record(`POST /token -> 200 (token refreshed)`);
    await this._saveToken();
    this.log.info('mailtm.token_refreshed', { connection: this.id });
    return this.token;
  }

  /** Every call goes through here so a 401 transparently costs one extra round trip, once. */
  async _api(path, opts = {}, retrying = false) {
    try {
      const r = await request(`${this.base}${path}`, {
        ...opts,
        headers: { authorization: `Bearer ${this.token}`, ...(opts.headers || {}) },
        timeoutMs: opts.timeoutMs ?? 30000,
      });
      this._record(`${opts.method || 'GET'} ${path} -> ${r.status} (${r.bytes} bytes)`);
      return r;
    } catch (err) {
      if (err.status === 401 && !retrying) {
        this._record(`${opts.method || 'GET'} ${path} -> 401, refreshing token`);
        await this._refreshToken();
        return this._api(path, opts, true);
      }
      throw err;
    }
  }

  async open() {
    await this._loadCredentials();
    if (!this.token && this.address && this.password) await this._refreshToken();
    const me = await this._api('/me');
    this.accountId = (me.json && me.json.id) || this.accountId;
    this.address = (me.json && me.json.address) || this.address;
    this.log.info('mailtm.opened', {
      connection: this.id, address: this.address, account: this.accountId,
      used: me.json && me.json.used, quota: me.json && me.json.quota,
    });
    return { validity: this.validity() };
  }

  /**
   * mail.tm ids are stable for the life of the account, so the account id is
   * the only thing that can invalidate a cursor — deleting and recreating the
   * address. That is the exact analogue of a UIDVALIDITY bump.
   */
  validity() { return this.accountId ? `acct:${this.accountId}` : null; }

  static _list(body) { return Array.isArray(body) ? body : (body && body['hydra:member']) || []; }

  static _cursor(m) { return `${m.createdAt}|${m.id}`; }

  async list({ sinceCursor = null, limit = 50, resync = false, tail = false } = {}) {
    const items = [];
    let more = false;
    for (let page = 1; page <= this.maxPages; page += 1) {
      const r = await this._api(`/messages?page=${page}`);
      const batch = MailTmProvider._list(r.json);
      if (!batch.length) break;
      let sawOld = false;
      for (const m of batch) {
        const cursor = MailTmProvider._cursor(m);
        if (sinceCursor && !resync && cursor <= sinceCursor) { sawOld = true; continue; }
        items.push({
          key: m.id,
          cursor,
          size: m.size,
          receivedAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
          from: m.from ? m.from.address : null,
          to: (m.to || []).map((t) => t.address),
          subject: m.subject || null,
          messageId: m.msgid || null,        // free: no extra request needed
          seen: !!m.seen,
        });
      }
      if (sawOld) break;                     // the API returns newest first
      if (batch.length < 30) break;
    }
    items.sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
    if (items.length > limit) {
      more = true;
      if (tail) items.splice(0, items.length - limit);
      else items.length = limit;
    }
    return { validity: this.validity(), items, more };
  }

  initialCursor() { return null; }   // 'start from everything present' is the useful default here

  async fetch(item) {
    if (item.size && item.size > this.maxMessageBytes) {
      return { raw: null, size: item.size, truncated: true, skipped: 'too_large' };
    }
    let r;
    try {
      r = await this._api(`/sources/${encodeURIComponent(item.key)}`);
    } catch (err) {
      if (err.status === 404) return { raw: null, size: item.size, truncated: false, skipped: 'vanished' };
      throw err;
    }
    const data = r.json && typeof r.json.data === 'string' ? r.json.data : r.text;
    const raw = Buffer.from(data, 'utf8');
    return { raw, size: raw.length, truncated: false };
  }

  /** Already known from the listing; nothing to do. */
  async identify(items) { return items; }

  async acknowledge(items) {
    if (!this.markSeen) return false;
    for (const it of items) {
      try {
        await this._api(`/messages/${encodeURIComponent(it.key)}`, {
          method: 'PATCH', json: { seen: true },
          headers: { 'content-type': 'application/merge-patch+json' },
        });
      } catch (err) {
        this.log.warn('mailtm.mark_seen_failed', { connection: this.id, id: it.key, error: err.message });
      }
    }
    return true;
  }

  /** No push channel: sleep, but interruptibly, so shutdown is immediate. */
  async waitForChange({ maxMs } = {}) {
    const ms = Math.min(maxMs ?? this.pollIntervalMs, this.pollIntervalMs);
    const ac = new AbortController();
    this._waitAbort = ac;
    await sleep(ms, ac.signal);
    this._waitAbort = null;
    return { reason: ac.signal.aborted ? 'stopped' : 'poll' };
  }

  stopWaiting() { if (this._waitAbort) this._waitAbort.abort(); }

  async close() { this.stopWaiting(); }

  /** Convenience for tests and the CLI. */
  static fromCredentialsFile(file, extra = {}) {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new MailTmProvider({ ...c, credentialsFile: file, ...extra });
  }
}

module.exports = { MailTmProvider };
