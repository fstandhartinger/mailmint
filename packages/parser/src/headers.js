'use strict';
const { decodeWords } = require('./rfc2047');
const { decodeBuffer } = require('./charset');

/**
 * Header block handling: unfolding, name/value splitting, structured parsers
 * for addresses, dates and parameterised values (Content-Type,
 * Content-Disposition) including RFC 2231 continuations and charset tagging.
 */

/**
 * Split a raw header block into ordered [name, rawValue] pairs.
 * Unfolds continuation lines (a line starting with SP/TAB belongs to the one
 * before it). The raw value keeps its original bytes-as-latin1 form so the
 * caller can still decode 8-bit header bytes with a declared charset.
 */
function splitHeaders(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line)) {
      if (cur) cur[1] += ' ' + line.replace(/^[ \t]+/, '');
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) {
      // Garbage line. Some MTAs emit a bare "From " envelope line; ignore.
      continue;
    }
    cur = [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).replace(/^[ \t]+/, '')];
    out.push(cur);
  }
  return out;
}

function headerValue(pairs, name) {
  const n = name.toLowerCase();
  for (const [k, v] of pairs) if (k === n) return v;
  return null;
}
function headerValues(pairs, name) {
  const n = name.toLowerCase();
  return pairs.filter(([k]) => k === n).map(([, v]) => v);
}

/**
 * Parse a parameterised header value: `type/sub; a=b; c*=utf-8''x; d*0="x"`.
 * Returns { value, params } with RFC 2231 continuations joined and
 * percent-decoded through their declared charset.
 */
function parseParameters(raw) {
  if (!raw) return { value: '', params: {} };
  const parts = splitSemis(String(raw));
  const value = (parts.shift() || '').trim();
  const collected = new Map(); // base -> {segments:Map(idx->{v,enc}), simple}
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"')) val = unquote(val);
    let ext = false, idx = null;
    const m = key.match(/^([^*]+?)(?:\*(\d+))?(\*)?$/);
    if (m && (m[2] !== undefined || m[3])) {
      key = m[1];
      idx = m[2] === undefined ? 0 : parseInt(m[2], 10);
      ext = !!m[3];
    }
    if (!collected.has(key)) collected.set(key, { segs: new Map(), plain: null });
    const slot = collected.get(key);
    if (idx === null) slot.plain = val;
    else slot.segs.set(idx, { v: val, ext });
  }
  const params = {};
  for (const [key, slot] of collected) {
    if (slot.segs.size === 0) { params[key] = decodeWords(slot.plain == null ? '' : slot.plain); continue; }
    const idxs = [...slot.segs.keys()].sort((a, b) => a - b);
    let charset = null, joined = '';
    for (const i of idxs) {
      const { v, ext } = slot.segs.get(i);
      if (ext) {
        if (i === idxs[0] && v.includes("'")) {
          const bits = v.split("'");
          charset = bits.shift() || null;
          bits.shift(); // language tag
          joined += bits.join("'");
        } else joined += v;
      } else {
        joined += v.replace(/%/g, '%25');
      }
    }
    if (charset === null) {
      // Some agents percent-encode the RFC2231 apostrophes themselves.
      const pre = joined.match(/^([\w.:-]*)(?:'|%27)[^']*?(?:'|%27)/);
      if (pre) { charset = pre[1] || null; joined = joined.slice(pre[0].length); }
    }
    params[key] = percentDecode(joined, charset);
  }
  return { value, params };
}

function percentDecode(str, charset) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '%' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 1, i + 3))) {
      bytes.push(parseInt(str.slice(i + 1, i + 3), 16)); i += 2;
    } else {
      const cp = str.codePointAt(i);
      if (cp > 0xff) { for (const b of Buffer.from(str[i], 'utf8')) bytes.push(b); }
      else bytes.push(cp);
      if (cp > 0xffff) i++;
    }
  }
  return decodeBuffer(Buffer.from(bytes), charset || 'utf-8');
}

/** Split on ';' but not inside quoted strings. */
function splitSemis(s) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q) { cur += c + (s[++i] || ''); continue; }
    if (c === '"') { q = !q; cur += c; continue; }
    if (c === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unquote(s) {
  s = s.trim();
  if (s.startsWith('"')) {
    let out = ''; let i = 1;
    for (; i < s.length; i++) {
      if (s[i] === '\\') { out += s[++i] || ''; continue; }
      if (s[i] === '"') break;
      out += s[i];
    }
    return out;
  }
  return s;
}

/**
 * Address list parser. Handles: display names quoted or bare, comments in
 * parentheses, angle-addr, groups (`Undisclosed: a@b, c@d;`), and the very
 * common bare address with no name.
 */
function parseAddressList(raw) {
  if (!raw) return [];
  const s = decodeWords(String(raw));
  const items = [];
  let cur = '', depth = 0, q = false, angle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q) { cur += c + (s[++i] || ''); continue; }
    if (c === '"') { q = !q; cur += c; continue; }
    if (!q && c === '(') { depth++; cur += c; continue; }
    if (!q && c === ')') { depth--; cur += c; continue; }
    if (!q && c === '<') { angle = true; cur += c; continue; }
    if (!q && c === '>') { angle = false; cur += c; continue; }
    if (!q && !depth && !angle && (c === ',' || c === ';')) { items.push(cur); cur = ''; continue; }
    cur += c;
  }
  items.push(cur);

  const out = [];
  for (let item of items) {
    item = item.trim();
    if (!item) continue;
    // group prefix "Name:" with no address after -> skip label
    const groupM = item.match(/^([^:<>@"]+):$/);
    if (groupM) continue;
    item = item.replace(/^[^:<>@"]+:\s*/, (mm) => (item.includes('@') && !item.includes('<') && !mm.includes('@') ? '' : mm));
    let name = null, email = null;
    const ang = item.match(/<([^<>]*)>/);
    if (ang) {
      email = ang[1].trim();
      name = item.slice(0, ang.index).trim();
    } else {
      const cm = item.match(/\(([^()]*)\)/);
      if (cm) { name = cm[1].trim(); item = (item.slice(0, cm.index) + item.slice(cm.index + cm[0].length)).trim(); }
      email = item.trim();
    }
    if (name) {
      name = unquote(name).replace(/\s+/g, ' ').trim();
      name = name.replace(/^\((.*)\)$/, '$1').trim();
      if (!name) name = null;
    }
    email = normaliseAddress(email);
    if (!email && !name) continue;
    if (email && !/@/.test(email)) {
      // "Name" with no address at all -> keep as name only
      if (!name) { name = email; }
      email = '';
    }
    out.push({ name: name || null, email: email || null });
  }
  return out;
}

/**
 * Trim quoting and lowercase the DOMAIN ONLY.
 * RFC 5321 2.3.11 makes the local part case-sensitive, and it is not academic:
 * Stripe puts a case-sensitive account id in it
 * (invoice+statements+acct_1RTNh0CozVR51Oga@stripe.com) and several ESPs put
 * routing tokens there. Lowercasing it corrupts reply routing silently.
 */
function normaliseAddress(raw) {
  let e = String(raw || '').replace(/^["'<\s]+|["'>\s]+$/g, '').trim();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  return e.slice(0, at) + '@' + e.slice(at + 1).toLowerCase();
}

const TZ = { ut: 0, gmt: 0, utc: 0, z: 0, est: -500, edt: -400, cst: -600, cdt: -500,
  mst: -700, mdt: -600, pst: -800, pdt: -700, cet: 100, cest: 200, met: 100, mest: 200,
  bst: 100, jst: 900, ist: 530 };

/** RFC 5322 date -> ISO string, or null. */
function parseDate(raw) {
  if (!raw) return null;
  let s = decodeWords(String(raw)).trim();
  s = s.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(.*)$/);
  if (m) {
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = MON[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      let year = parseInt(m[3], 10);
      if (year < 50) year += 2000; else if (year < 100) year += 1900;
      const d = Date.UTC(year, mon, parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6] || '0', 10));
      let off = 0;
      const z = (m[7] || '').trim();
      const zm = z.match(/^([+-])(\d{2})(\d{2})$/);
      if (zm) off = (zm[1] === '-' ? -1 : 1) * (parseInt(zm[2], 10) * 60 + parseInt(zm[3], 10));
      else if (z && TZ[z.toLowerCase()] !== undefined) {
        const t = TZ[z.toLowerCase()];
        off = (t < 0 ? -1 : 1) * (Math.floor(Math.abs(t) / 100) * 60 + (Math.abs(t) % 100));
      }
      const dt = new Date(d - off * 60000);
      if (!isNaN(dt)) return dt.toISOString();
    }
  }
  const fallback = new Date(s);
  if (!isNaN(fallback)) return fallback.toISOString();
  return null;
}

module.exports = { splitHeaders, headerValue, headerValues, parseParameters, parseAddressList, parseDate, unquote, splitSemis, normaliseAddress };
