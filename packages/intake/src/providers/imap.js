'use strict';

const { ImapClient, formatSequenceSet } = require('../imap');
const { parseHeaders } = require('../mime-lite');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The IMAP side of the provider interface.
 *
 * Tracking is by (UIDVALIDITY, UID): UIDs are only unique and only monotonic
 * *within* a UIDVALIDITY generation. A server is allowed to renumber everything
 * (a restore from backup, a mailbox recreated with the same name) and signal it
 * by bumping UIDVALIDITY, at which point "last UID = 4471" means nothing.
 */
class ImapProvider {
  constructor(conf = {}, deps = {}) {
    this.conf = conf;
    this.kind = 'imap';
    this.id = conf.id || `imap:${conf.user || ''}@${conf.host || ''}`;
    this.log = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.folder = conf.folder || 'INBOX';
    this.maxMessageBytes = conf.maxMessageBytes || DEFAULT_MAX_BYTES;
    this.markSeen = conf.markSeen !== false;
    this.unseenOnly = !!conf.unseenOnly;
    // 'new'  -> start at UIDNEXT: a brand new connection does not replay the
    //           customer's entire archive into their webhook.
    // 'all'  -> everything currently in the folder.
    // 'unseen' / {sinceDays:N} -> the obvious middles.
    this.initial = conf.initial || 'new';
    this.resyncLimit = conf.resyncLimit || 200;
    this.client = null;
    this.box = null;
    this.capabilities = { push: false };
  }

  async open() {
    this.client = new ImapClient({
      host: this.conf.host,
      port: this.conf.port,
      secure: this.conf.secure,
      starttls: this.conf.starttls,
      user: this.conf.user,
      pass: this.conf.pass,
      accessToken: this.conf.accessToken,
      tlsOptions: this.conf.tlsOptions,
      connectTimeoutMs: this.conf.connectTimeoutMs,
      commandTimeoutMs: this.conf.commandTimeoutMs,
      maxMessageBytes: this.maxMessageBytes,
      transcript: this.conf.transcript,
    });
    this.client.on('error', (err) => this.log.warn('imap.error', { connection: this.id, error: err.message }));
    const greeting = await this.client.connect();
    const auth = await this.client.login();
    this.box = await this.client.select(this.folder, { readOnly: this.conf.readOnly === true });
    this.capabilities.push = this.client.hasCapability('IDLE');
    this.log.info('imap.opened', {
      connection: this.id, host: this.conf.host, port: this.client.port, tls: this.client.secure,
      auth: auth.method, folder: this.folder, exists: this.box.exists,
      uidvalidity: this.box.uidvalidity, uidnext: this.box.uidnext,
      idle: this.capabilities.push, greeting: greeting.status,
    });
    return { validity: String(this.box.uidvalidity) };
  }

  get transcript() { return this.client ? this.client.transcript : null; }

  validity() { return this.box ? String(this.box.uidvalidity) : null; }

  async _reselect() {
    this.box = await this.client.select(this.folder, { readOnly: this.conf.readOnly === true });
    return this.box;
  }

  async list({ sinceCursor = null, limit = 50, resync = false, tail = false } = {}) {
    // Re-SELECT on every cycle: it is one round trip and it is the only way to
    // notice a UIDVALIDITY change that happened while we were asleep.
    await this._reselect();
    const validity = String(this.box.uidvalidity);
    let uids;

    if (resync || sinceCursor === null || sinceCursor === undefined) {
      uids = await this._initialUids({ resync });
    } else {
      const from = Number(sinceCursor) + 1;
      // `UID SEARCH UID n:*` is NOT "uid >= n". RFC 3501 says a range whose
      // second value is * matches at least the highest UID in the mailbox, so
      // when nothing new has arrived the server dutifully returns the last
      // message again. Filtering here is what stops that from being a
      // redelivery on every single poll.
      const found = await this.client.uidSearch(
        this.unseenOnly ? `UNSEEN UID ${from}:*` : `UID ${from}:*`,
      );
      uids = found.filter((u) => u > Number(sinceCursor));
    }

    uids.sort((a, b) => a - b);
    const more = uids.length > limit;
    // Delivery walks forward from the oldest unseen message; a scan ("where is
    // my confirmation code?") wants the newest instead.
    uids = tail ? uids.slice(-limit) : uids.slice(0, limit);
    if (!uids.length) return { validity, items: [], more: false };

    const metas = await this.client.uidFetchMeta(uids);
    const items = metas
      .filter((m) => m.uid !== null)
      .map((m) => ({
        key: `${validity}:${m.uid}`,
        uid: m.uid,
        cursor: String(m.uid),
        size: m.size,
        receivedAt: m.internaldate ? m.internaldate.toISOString() : null,
        flags: m.flags,
        from: null,
        subject: null,
      }))
      .sort((a, b) => a.uid - b.uid);
    return { validity, items, more };
  }

  async _initialUids({ resync }) {
    if (resync) {
      // A UIDVALIDITY bump means we cannot trust the old mark, but it does not
      // mean the mail is new. Take the tail of the mailbox and let the
      // connector's Message-ID set decide what has already been delivered.
      const all = await this.client.uidSearch('ALL');
      return all.slice(-this.resyncLimit);
    }
    if (this.initial === 'all') return this.client.uidSearch('ALL');
    if (this.initial === 'unseen' || this.unseenOnly) return this.client.uidSearch('UNSEEN');
    if (this.initial && typeof this.initial === 'object' && this.initial.sinceDays) {
      const d = new Date(Date.now() - this.initial.sinceDays * 86400000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return this.client.uidSearch(`SINCE ${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`);
    }
    // 'new': everything from now on, nothing from before.
    return [];
  }

  /** The cursor to store when a fresh connection starts in 'new' mode. */
  initialCursor() {
    if (this.initial === 'new' && this.box && this.box.uidnext) return String(this.box.uidnext - 1);
    return null;
  }

  async fetch(item) {
    if (item.size && item.size > this.maxMessageBytes) {
      return { raw: null, size: item.size, truncated: true, skipped: 'too_large' };
    }
    const [msg] = await this.client.uidFetch([item.uid], '(UID BODY.PEEK[])');
    if (!msg || !msg.body) {
      // The message was expunged between SEARCH and FETCH. Not an error.
      return { raw: null, size: item.size, truncated: false, skipped: 'vanished' };
    }
    return { raw: msg.body, size: msg.body.length, truncated: msg.truncated };
  }

  /** Header-only fetch: the Message-ID for a hundred messages costs one round trip. */
  async identify(items) {
    const uids = items.map((i) => i.uid).filter(Boolean);
    if (!uids.length) return items;
    const msgs = await this.client.uidFetch(
      uids, '(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)])',
    );
    const byUid = new Map();
    for (const m of msgs) {
      let headerBuf = null;
      for (const [k, v] of Object.entries(m.attrs || {})) {
        if (k.startsWith('BODY[HEADER.FIELDS') && Buffer.isBuffer(v)) headerBuf = v;
      }
      if (!headerBuf) continue;
      const h = parseHeaders(headerBuf.toString('utf8'));
      byUid.set(m.uid, {
        messageId: h['message-id'] ? h['message-id'][0].trim() : null,
        from: h.from ? h.from[0] : null,
        subject: h.subject ? h.subject[0] : null,
      });
    }
    for (const it of items) {
      const info = byUid.get(it.uid);
      if (info) Object.assign(it, info);
    }
    return items;
  }

  async acknowledge(items) {
    if (!this.markSeen || this.conf.readOnly === true) return false;
    const uids = items.map((i) => i.uid).filter(Boolean);
    if (!uids.length) return false;
    await this.client.markSeen(uids);
    this.log.debug('imap.marked_seen', { connection: this.id, uids: formatSequenceSet(uids) });
    return true;
  }

  waitForChange({ maxMs } = {}) {
    return this.client.waitForUpdate({
      maxMs: maxMs ?? this.conf.idleTimeoutMs ?? 29 * 60 * 1000,
      pollIntervalMs: this.conf.pollIntervalMs ?? 60000,
      idle: this.conf.idle !== false,
    });
  }

  stopWaiting() { if (this.client) this.client.stopIdle(); }

  async close() {
    if (!this.client) return;
    try { await this.client.logout(); } catch { /* already gone */ }
    this.client = null;
  }
}

module.exports = { ImapProvider };
