'use strict';

/**
 * Where the high-water mark lives.
 *
 * The mark is the only thing standing between "every message delivered exactly
 * once" and "the customer's webhook fires 400 times because the connector
 * restarted". It therefore gets written after EVERY successful delivery, not
 * once per batch: a crash in the middle of a batch of 50 must cost at most one
 * duplicate, not fifty.
 *
 * Two backends, same interface:
 *   - ApiStateStore   POST/GET {API_URL}/internal/connector-state — the real
 *                     home, so a connector can be restarted on another host.
 *   - FileStateStore  a local JSON file, written atomically (tmp + rename).
 * FallbackStateStore uses the API and silently degrades to the file when the
 * endpoint is not deployed yet, which is the case today.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { request } = require('./http');

const MAX_SEEN = 2000;

function emptyState() {
  return { validity: null, cursor: null, seen: [], seen_message_ids: [], updated_at: null, stats: {} };
}

/** Keeps the tail of a bounded FIFO, deduplicated. */
function pushBounded(list, value, max = MAX_SEEN) {
  if (value === null || value === undefined) return list;
  const v = String(value);
  const idx = list.indexOf(v);
  if (idx >= 0) list.splice(idx, 1);
  list.push(v);
  while (list.length > max) list.shift();
  return list;
}

/** Message-IDs are customer data; only a hash of one ever leaves this process. */
function idHash(messageId) {
  if (!messageId) return null;
  return crypto.createHash('sha256').update(String(messageId).trim().toLowerCase()).digest('hex').slice(0, 24);
}

class FileStateStore {
  constructor(file) {
    this.file = file;
    this.kind = 'file';
    this._chain = Promise.resolve();
    this._cache = null;
  }

  async _read() {
    if (this._cache) return this._cache;
    try {
      const txt = await fsp.readFile(this.file, 'utf8');
      this._cache = JSON.parse(txt);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this._cache = { version: 1, connections: {} };
    }
    if (!this._cache.connections) this._cache.connections = {};
    return this._cache;
  }

  async get(connectionId) {
    const all = await this._read();
    return { ...emptyState(), ...(all.connections[connectionId] || {}) };
  }

  async set(connectionId, state) {
    const run = async () => {
      const all = await this._read();
      all.connections[connectionId] = { ...state, updated_at: new Date().toISOString() };
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      // Atomic: a torn write here means the connector forgets where it was.
      await fsp.writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
      return all.connections[connectionId];
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  /** Best effort, for a crash path where async is not available. */
  setSync(connectionId, state) {
    const all = this._cache || { version: 1, connections: {} };
    all.connections[connectionId] = { ...state, updated_at: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch { /* nothing useful to do while dying */ }
  }
}

class ApiStateStore {
  constructor({ apiUrl, secret, timeoutMs = 15000 }) {
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.kind = 'api';
  }

  get _headers() { return { 'x-mailmint-internal': this.secret }; }

  async get(connectionId) {
    const r = await request(
      `${this.apiUrl}/internal/connector-state?connection_id=${encodeURIComponent(connectionId)}`,
      { headers: this._headers, timeoutMs: this.timeoutMs },
    );
    return { ...emptyState(), ...((r.json && (r.json.state || r.json)) || {}) };
  }

  async set(connectionId, state) {
    await request(`${this.apiUrl}/internal/connector-state`, {
      method: 'POST', headers: this._headers, timeoutMs: this.timeoutMs,
      json: { connection_id: connectionId, state },
    });
    return state;
  }
}

/**
 * API first, file second. The API endpoint is specified but not yet deployed;
 * rather than block intake on another package's release, we probe once and
 * remember. The file copy is always written too, so switching over later does
 * not lose the mark.
 */
class FallbackStateStore {
  constructor({ api, file, logger }) {
    this.api = api;
    this.file = file;
    this.log = logger;
    this.kind = 'fallback';
    this.apiUsable = api ? null : false;   // null = not probed yet
  }

  async get(connectionId) {
    if (this.api && this.apiUsable !== false) {
      try {
        const s = await this.api.get(connectionId);
        this.apiUsable = true;
        return s;
      } catch (err) {
        this.apiUsable = false;
        if (this.log) {
          this.log.warn('connector.state.api_unavailable', {
            connection_id: connectionId, status: err.status || null, error: err.message,
            note: 'falling back to the local state file',
          });
        }
      }
    }
    return this.file.get(connectionId);
  }

  async set(connectionId, state) {
    const local = await this.file.set(connectionId, state);
    if (this.api && this.apiUsable === true) {
      try { await this.api.set(connectionId, state); }
      catch (err) {
        this.apiUsable = false;
        if (this.log) this.log.warn('connector.state.api_write_failed', { connection_id: connectionId, error: err.message });
      }
    }
    return local;
  }
}

function createStore({ apiUrl, secret, file, logger }) {
  const fileStore = new FileStateStore(file);
  const api = apiUrl && secret ? new ApiStateStore({ apiUrl, secret }) : null;
  if (!api) return fileStore;
  return new FallbackStateStore({ api, file: fileStore, logger });
}

module.exports = {
  FileStateStore, ApiStateStore, FallbackStateStore, createStore,
  emptyState, pushBounded, idHash, MAX_SEEN,
};
