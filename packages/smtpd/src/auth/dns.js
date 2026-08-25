'use strict';
// Tiny DNS facade: caching, timeouts, and one uniform error shape so SPF/DKIM/DMARC
// can tell "no such record" (none) apart from "resolver broke" (temperror).
// Every lookup goes through here so tests can swap in a fixture resolver.

const dns = require('node:dns');

const NXLIKE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENOENT']);

class DnsError extends Error {
  constructor(code, name, type) {
    super(`dns ${type} ${name}: ${code}`);
    this.code = code;
    this.dnsName = name;
    this.dnsType = type;
    this.temporary = !NXLIKE.has(code);
  }
}

class DnsClient {
  /**
   * @param {object} opts
   * @param {string[]} [opts.servers]      override resolver addresses
   * @param {number}   [opts.timeoutMs]
   * @param {number}   [opts.cacheMax]
   * @param {number}   [opts.cacheTtlMs]
   * @param {object}   [opts.stub]         { 'TXT:name': [...], ... } for tests
   */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.cacheMax = opts.cacheMax ?? 5000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 300000;
    this.stub = opts.stub || null;
    this.cache = new Map();
    this.queries = 0;
    if (opts.stub) {
      this.resolver = null;
    } else {
      this.resolver = new dns.promises.Resolver({ timeout: this.timeoutMs, tries: 2 });
      if (opts.servers && opts.servers.length) this.resolver.setServers(opts.servers);
    }
  }

  _cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) { this.cache.delete(key); return undefined; }
    // LRU-ish: refresh insertion order
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  _cacheSet(key, value, err) {
    if (this.cache.size >= this.cacheMax) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    this.cache.set(key, { value, err, exp: Date.now() + this.cacheTtlMs });
  }

  async query(type, name) {
    const n = String(name).replace(/\.$/, '').toLowerCase();
    const key = `${type}:${n}`;
    const hit = this._cacheGet(key);
    if (hit) {
      if (hit.err) throw hit.err;
      return hit.value;
    }
    this.queries++;
    let value, err;
    try {
      value = await this._raw(type, n);
    } catch (e) {
      err = e instanceof DnsError ? e : new DnsError(e.code || 'ESERVFAIL', n, type);
    }
    // Never cache a temporary failure — retrying is the whole point.
    if (!err || !err.temporary) this._cacheSet(key, value, err);
    if (err) throw err;
    return value;
  }

  async _raw(type, n) {
    if (this.stub) {
      const key = `${type}:${n}`;
      if (!(key in this.stub)) throw new DnsError('ENOTFOUND', n, type);
      const v = this.stub[key];
      if (typeof v === 'string') throw new DnsError(v, n, type);
      return v;
    }
    const r = this.resolver;
    switch (type) {
      case 'TXT': return await r.resolveTxt(n);
      case 'A': return await r.resolve4(n);
      case 'AAAA': return await r.resolve6(n);
      case 'MX': return await r.resolveMx(n);
      case 'PTR': return await r.resolvePtr(n);
      case 'CNAME': return await r.resolveCname(n);
      default: throw new DnsError('EBADTYPE', n, type);
    }
  }

  /** TXT with the per-record chunks joined, which is what every mail RFC wants. */
  async txt(name) {
    const rows = await this.query('TXT', name);
    return rows.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  }

  async a(name) { return this.query('A', name); }
  async aaaa(name) { return this.query('AAAA', name); }
  async mx(name) { return this.query('MX', name); }
  async ptr(name) { return this.query('PTR', name); }

  /** Resolve both families, tolerating absence of either. */
  async addresses(name) {
    const out = [];
    for (const fn of ['a', 'aaaa']) {
      try { out.push(...(await this[fn](name))); }
      catch (e) { if (e.temporary) throw e; }
    }
    return out;
  }
}

module.exports = { DnsClient, DnsError };
