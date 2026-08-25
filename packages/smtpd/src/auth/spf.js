'use strict';
// SPF — RFC 7208. A real implementation: all/include/a/mx/ptr/ip4/ip6/exists,
// redirect=/exp=, macro expansion, the 10 term-lookup limit, the 2 void-lookup
// limit, and the 10-record caps on mx/ptr.
//
// checkHost() returns one of:
//   pass | fail | softfail | neutral | none | permerror | temperror

const { DnsClient } = require('./dns');
const { parseIP, inCidr, ipMacro, reverseName } = require('./ip');

const MAX_LOOKUPS = 10;
const MAX_VOID = 2;
const MAX_MX = 10;
const MAX_PTR = 10;

const QUALIFIERS = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };

class SpfPermError extends Error { constructor(m) { super(m); this.spf = 'permerror'; } }
class SpfTempError extends Error { constructor(m) { super(m); this.spf = 'temperror'; } }

/** Split an SPF record into terms; throws SpfPermError on syntax trouble. */
function parseRecord(record) {
  const terms = [];
  const parts = record.trim().split(/\s+/).slice(1); // drop "v=spf1"
  for (const raw of parts) {
    if (raw === '') continue;
    const mod = raw.match(/^([a-zA-Z][a-zA-Z0-9._-]*)=(.*)$/);
    if (mod) {
      terms.push({ kind: 'modifier', name: mod[1].toLowerCase(), value: mod[2] });
      continue;
    }
    let qualifier = '+';
    let body = raw;
    if (QUALIFIERS[body[0]]) { qualifier = body[0]; body = body.slice(1); }
    const m = body.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(?::(.*?))?(?:\/(\d{1,3})(?:\/\/(\d{1,3}))?)?$/);
    if (!m) throw new SpfPermError(`bad term: ${raw}`);
    const name = m[1].toLowerCase();
    const value = m[2] === undefined ? null : m[2];
    const cidr4 = m[3] === undefined ? null : Number(m[3]);
    const cidr6 = m[4] === undefined ? null : Number(m[4]);
    if (cidr4 !== null && cidr4 > 32 && name !== 'ip6') throw new SpfPermError(`bad cidr in ${raw}`);
    if (cidr6 !== null && cidr6 > 128) throw new SpfPermError(`bad cidr6 in ${raw}`);
    terms.push({ kind: 'mechanism', qualifier, name, value, cidr4, cidr6, raw });
  }
  return terms;
}

// ---------------------------------------------------------------- macros ---

const MACRO_RE = /%(\{([slodipvh])(\d*)(r?)([.\-+,/_=]*)\}|%|_|-)/gi;

function macroValue(letter, ctx) {
  switch (letter) {
    case 's': return ctx.sender;
    case 'l': return ctx.senderLocal;
    case 'o': return ctx.senderDomain;
    case 'd': return ctx.domain;
    case 'i': return ipMacro(ctx.ip);
    case 'p': return ctx.validatedPtr || 'unknown';
    case 'v': return ctx.ip.family === 4 ? 'in-addr' : 'ip6';
    case 'h': return ctx.helo || 'unknown';
    default: throw new SpfPermError(`unknown macro %{${letter}}`);
  }
}

function expandMacros(str, ctx) {
  if (!str || !str.includes('%')) return str;
  return str.replace(MACRO_RE, (all, body, letter, digits, rev, delims) => {
    if (all === '%%') return '%';
    if (all === '%_') return ' ';
    if (all === '%-') return '%20';
    const upper = letter === letter.toUpperCase() && /[A-Z]/.test(letter);
    let v = macroValue(letter.toLowerCase(), ctx);
    const seps = delims && delims.length ? delims : '.';
    let parts = String(v).split(new RegExp(`[${seps.replace(/[.\-\\\]]/g, '\\$&')}]`));
    if (rev) parts = parts.reverse();
    if (digits) {
      const n = Number(digits);
      if (n === 0) throw new SpfPermError('macro digit 0');
      if (parts.length > n) parts = parts.slice(parts.length - n);
    }
    v = parts.join('.');
    return upper ? encodeURIComponent(v) : v;
  });
}

// --------------------------------------------------------------- engine ---

class SpfEvaluator {
  constructor(opts) {
    this.dns = opts.dns;
    this.lookups = 0;
    this.voids = 0;
    this.deadline = Date.now() + (opts.timeoutMs ?? 10000);
    this.trace = [];
  }

  countLookup(what) {
    if (++this.lookups > MAX_LOOKUPS) throw new SpfPermError(`more than ${MAX_LOOKUPS} DNS lookups (${what})`);
    if (Date.now() > this.deadline) throw new SpfTempError('spf evaluation timed out');
  }

  countVoid() {
    if (++this.voids > MAX_VOID) throw new SpfPermError(`more than ${MAX_VOID} void lookups`);
  }

  async txt(name) {
    try { return await this.dns.txt(name); }
    catch (e) {
      if (e.temporary) throw new SpfTempError(`TXT ${name}: ${e.code}`);
      return [];
    }
  }

  async addresses(name) {
    try {
      const list = await this.dns.addresses(name);
      if (!list.length) this.countVoid();
      return list;
    } catch (e) {
      if (e.temporary) throw new SpfTempError(`A ${name}: ${e.code}`);
      this.countVoid();
      return [];
    }
  }

  /** check_host(ip, domain, sender) */
  async check(domain, ctx, depth = 0) {
    if (depth > 10) throw new SpfPermError('include/redirect nesting too deep');
    if (!domain || domain.length > 253) throw new SpfPermError('invalid domain');

    let records;
    try { records = await this.dns.txt(domain); }
    catch (e) {
      if (e.temporary) throw new SpfTempError(`TXT ${domain}: ${e.code}`);
      return { result: 'none', reason: `no TXT for ${domain}` };
    }
    const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    if (spf.length === 0) return { result: 'none', reason: `no v=spf1 record at ${domain}` };
    if (spf.length > 1) throw new SpfPermError(`${spf.length} SPF records at ${domain}`);

    const record = spf[0].trim();
    this.trace.push({ domain, record });
    const terms = parseRecord(record);
    const local = { ...ctx, domain };

    let redirect = null;
    let explanation = null;
    let sawAll = false;
    for (const t of terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect') {
          if (redirect !== null) throw new SpfPermError('duplicate redirect=');
          redirect = t.value;
        } else if (t.name === 'exp') {
          if (explanation !== null) throw new SpfPermError('duplicate exp=');
          explanation = t.value;
        }
        continue;
      }
      if (t.name === 'all') sawAll = true;
      const hit = await this.matches(t, local, depth);
      if (hit === 'MATCH') {
        const q = QUALIFIERS[t.qualifier];
        return { result: q, reason: `${t.raw} at ${domain}`, expDomain: explanation };
      }
      if (hit !== 'NOMATCH') return hit; // an include returned temp/permerror-ish result object
    }

    if (redirect !== null && !sawAll) {
      const target = expandMacros(redirect, local);
      this.countLookup('redirect');
      const r = await this.check(target, { ...ctx }, depth + 1);
      if (r.result === 'none') throw new SpfPermError(`redirect target ${target} has no SPF record`);
      return r;
    }
    return { result: 'neutral', reason: `default at ${domain}`, expDomain: explanation };
  }

  /** Returns 'MATCH' | 'NOMATCH' | a terminal result object. */
  async matches(t, ctx, depth) {
    const ip = ctx.ip;
    switch (t.name) {
      case 'all':
        return 'MATCH';

      case 'ip4': {
        if (!t.value) throw new SpfPermError('ip4 without address');
        const net = parseIP(t.value);
        if (!net || net.family !== 4) throw new SpfPermError(`bad ip4:${t.value}`);
        if (ip.family !== 4) return 'NOMATCH';
        return inCidr(ip, t.value, t.cidr4 === null ? 32 : t.cidr4) ? 'MATCH' : 'NOMATCH';
      }

      case 'ip6': {
        if (!t.value) throw new SpfPermError('ip6 without address');
        const net = parseIP(t.value);
        if (!net || net.family !== 6) throw new SpfPermError(`bad ip6:${t.value}`);
        if (ip.family !== 6) return 'NOMATCH';
        return inCidr(ip, t.value, t.cidr4 === null ? 128 : t.cidr4) ? 'MATCH' : 'NOMATCH';
      }

      case 'a': {
        this.countLookup('a');
        const target = t.value ? expandMacros(t.value, ctx) : ctx.domain;
        const addrs = await this.addresses(target);
        const bits = ip.family === 4 ? (t.cidr4 === null ? 32 : t.cidr4)
                                     : (t.cidr6 === null ? 128 : t.cidr6);
        for (const a of addrs) {
          const parsed = parseIP(a);
          if (parsed && parsed.family === ip.family && inCidr(ip, a, bits)) return 'MATCH';
        }
        return 'NOMATCH';
      }

      case 'mx': {
        this.countLookup('mx');
        const target = t.value ? expandMacros(t.value, ctx) : ctx.domain;
        let mxs;
        try { mxs = await this.dns.mx(target); }
        catch (e) {
          if (e.temporary) throw new SpfTempError(`MX ${target}: ${e.code}`);
          this.countVoid();
          return 'NOMATCH';
        }
        if (!mxs.length) this.countVoid();
        if (mxs.length > MAX_MX) throw new SpfPermError(`more than ${MAX_MX} MX records for ${target}`);
        const bits = ip.family === 4 ? (t.cidr4 === null ? 32 : t.cidr4)
                                     : (t.cidr6 === null ? 128 : t.cidr6);
        for (const mx of mxs.sort((x, y) => x.priority - y.priority)) {
          const addrs = await this.addresses(mx.exchange);
          for (const a of addrs) {
            const parsed = parseIP(a);
            if (parsed && parsed.family === ip.family && inCidr(ip, a, bits)) return 'MATCH';
          }
        }
        return 'NOMATCH';
      }

      case 'ptr': {
        // Deprecated by RFC 7208 §5.5 but still deployed.
        this.countLookup('ptr');
        const target = (t.value ? expandMacros(t.value, ctx) : ctx.domain).toLowerCase();
        let names;
        try { names = await this.dns.ptr(reverseName(ip)); }
        catch (e) {
          if (e.temporary) throw new SpfTempError(`PTR: ${e.code}`);
          return 'NOMATCH';
        }
        let checked = 0;
        for (const nameRaw of names) {
          if (checked++ >= MAX_PTR) break;
          const name = nameRaw.replace(/\.$/, '').toLowerCase();
          if (name !== target && !name.endsWith('.' + target)) continue;
          const addrs = await this.addresses(name);
          for (const a of addrs) {
            const parsed = parseIP(a);
            if (parsed && parsed.family === ip.family && parsed.bytes.equals(ip.bytes)) {
              ctx.validatedPtr = name;
              return 'MATCH';
            }
          }
        }
        return 'NOMATCH';
      }

      case 'exists': {
        if (!t.value) throw new SpfPermError('exists without domain');
        this.countLookup('exists');
        const target = expandMacros(t.value, ctx);
        try {
          const a = await this.dns.a(target); // exists is v4-only by spec
          if (!a.length) { this.countVoid(); return 'NOMATCH'; }
          return 'MATCH';
        } catch (e) {
          if (e.temporary) throw new SpfTempError(`exists ${target}: ${e.code}`);
          this.countVoid();
          return 'NOMATCH';
        }
      }

      case 'include': {
        if (!t.value) throw new SpfPermError('include without domain');
        this.countLookup('include');
        const target = expandMacros(t.value, ctx);
        const r = await this.check(target, ctx, depth + 1);
        if (r.result === 'pass') return 'MATCH';
        if (r.result === 'none') throw new SpfPermError(`include:${target} has no SPF record`);
        if (r.result === 'temperror' || r.result === 'permerror') return r;
        return 'NOMATCH'; // fail/softfail/neutral inside an include => no match
      }

      default:
        throw new SpfPermError(`unknown mechanism ${t.name}`);
    }
  }
}

/**
 * @param {object} o
 * @param {string} o.ip         client IP
 * @param {string} o.helo       HELO/EHLO name
 * @param {string} o.mailFrom   SMTP MAIL FROM ('' for the null sender)
 * @param {DnsClient} [o.dns]
 * @returns {Promise<{result, domain, reason, lookups, trace}>}
 */
async function checkHost(o) {
  const ip = parseIP(o.ip);
  const dnsClient = o.dns || new DnsClient({ timeoutMs: o.dnsTimeoutMs });
  if (!ip) return { result: 'permerror', domain: null, reason: `unparseable client ip ${o.ip}`, lookups: 0 };

  const mailFrom = o.mailFrom || '';
  let sender = mailFrom;
  let domain;
  if (mailFrom === '') {
    // RFC 7208 §2.4: null reverse path => check postmaster@<helo>
    domain = (o.helo || '').replace(/^\[|\]$/g, '').toLowerCase();
    sender = `postmaster@${domain}`;
  } else {
    const at = mailFrom.lastIndexOf('@');
    domain = at === -1 ? (o.helo || '') : mailFrom.slice(at + 1);
    domain = domain.toLowerCase();
  }
  if (!domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
    return { result: 'none', domain, reason: 'no usable sender domain', lookups: 0 };
  }
  const at = sender.lastIndexOf('@');
  const ctx = {
    ip,
    helo: o.helo || '',
    sender,
    senderLocal: at === -1 ? 'postmaster' : sender.slice(0, at),
    senderDomain: domain,
    validatedPtr: null,
  };

  const ev = new SpfEvaluator({ dns: dnsClient, timeoutMs: o.timeoutMs });
  try {
    const r = await ev.check(domain, ctx, 0);
    return { result: r.result, domain, reason: r.reason, lookups: ev.lookups, trace: ev.trace };
  } catch (e) {
    if (e.spf) return { result: e.spf, domain, reason: e.message, lookups: ev.lookups, trace: ev.trace };
    return { result: 'temperror', domain, reason: e.message, lookups: ev.lookups, trace: ev.trace };
  }
}

module.exports = { checkHost, parseRecord, expandMacros, SpfPermError, SpfTempError };
