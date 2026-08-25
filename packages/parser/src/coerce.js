'use strict';
const { parseNumber, normaliseCurrency, findAmounts } = require('./numbers');
const { toIsoDate, toIsoDateTime } = require('./dates');
const { normaliseAddress } = require('./headers');

/**
 * §2 type coercion. Runs AFTER extraction, on whatever value came back from a
 * rule or the model. A failed coercion is not an error: it yields null plus a
 * `type_error:<field>` flag, because the contract says a message always
 * delivers and the consumer decides what to do about a bad field.
 */

const TRUE = new Set(['true', 'yes', 'y', 'ja', 'oui', 'si', '1', 'on', 'paid', 'confirmed', 'x']);
const FALSE = new Set(['false', 'no', 'n', 'nein', 'non', '0', 'off', 'unpaid', 'none']);

function coerce(value, field, opts) {
  const o = opts || {};
  const type = (field.type || 'string').toLowerCase();
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'string' && value.trim() === '') return { ok: true, value: null };
  // Models like to say "N/A" instead of nothing. The contract forbids that.
  if (typeof value === 'string' && /^(n\/?a|none|null|unknown|not (?:found|provided|specified|available)|-{1,3}|keine? angabe)$/i.test(value.trim())) {
    return { ok: true, value: null };
  }

  switch (type) {
    case 'string': {
      const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return { ok: true, value: s.replace(/\s+/g, ' ').trim() };
    }
    case 'number': {
      const n = typeof value === 'number' ? value : parseNumber(String(value), o.localeHint);
      return n === null || !isFinite(n) ? { ok: false } : { ok: true, value: n };
    }
    case 'integer': {
      const n = typeof value === 'number' ? value : parseNumber(String(value), o.localeHint);
      if (n === null || !isFinite(n)) return { ok: false };
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: true, value: Math.round(n) };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const s = String(value).trim().toLowerCase();
      if (TRUE.has(s)) return { ok: true, value: true };
      if (FALSE.has(s)) return { ok: true, value: false };
      return { ok: false };
    }
    case 'date': {
      const d = toIsoDate(value, { locale: o.senderDomain, referenceYear: o.referenceYear });
      return d ? { ok: true, value: d } : { ok: false };
    }
    case 'datetime': {
      const d = toIsoDateTime(value, { locale: o.senderDomain, referenceYear: o.referenceYear });
      return d ? { ok: true, value: d } : { ok: false };
    }
    case 'email': {
      const s = String(value).trim().replace(/^mailto:/i, '').replace(/^<|>$/g, '');
      const m = s.match(/[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
      return m ? { ok: true, value: normaliseAddress(m[0]) } : { ok: false };
    }
    case 'url': {
      let s = String(value).trim();
      if (/^www\./i.test(s)) s = 'https://' + s;
      try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? { ok: true, value: u.href } : { ok: false }; }
      catch { return { ok: false }; }
    }
    case 'phone': {
      const s = String(value).trim();
      const digits = s.replace(/[^\d]/g, '');
      if (digits.length < 6 || digits.length > 15) return { ok: false };
      const plus = /^\s*\+/.test(s) || /^00/.test(digits);
      return { ok: true, value: (plus ? '+' : '') + (/^00/.test(digits) && plus ? digits.slice(2) : digits) };
    }
    case 'currency': {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const amt = parseNumber(String(value.amount ?? value.value ?? ''), o.localeHint);
        const cur = normaliseCurrency(value.currency || value.code || '') || o.defaultCurrency || null;
        return amt === null ? { ok: false } : { ok: true, value: { amount: amt, currency: cur } };
      }
      const s = String(value);
      const found = findAmounts(s, o.localeHint);
      if (found.length) return { ok: true, value: { amount: found[0].value, currency: found[0].currency } };
      const n = parseNumber(s, o.localeHint);
      if (n === null) return { ok: false };
      return { ok: true, value: { amount: n, currency: o.defaultCurrency || null } };
    }
    case 'enum': {
      const options = field.options || [];
      if (!options.length) return { ok: false, enumViolation: true };
      const s = String(value).trim();
      const hit = options.find((op) => String(op).toLowerCase() === s.toLowerCase());
      if (hit !== undefined) return { ok: true, value: hit };
      const loose = options.find((op) => s.toLowerCase().includes(String(op).toLowerCase())
        || String(op).toLowerCase().includes(s.toLowerCase()));
      if (loose !== undefined) return { ok: true, value: loose };
      return { ok: false, enumViolation: true };
    }
    case 'array': {
      let arr = value;
      if (typeof arr === 'string') {
        const t = arr.trim();
        if (t.startsWith('[')) { try { arr = JSON.parse(t); } catch { arr = t.split(/\s*[,;\n]\s*/); } }
        else arr = t.split(/\s*[,;\n]\s*/).filter(Boolean);
      }
      if (!Array.isArray(arr)) arr = [arr];
      const itemField = field.items || { type: 'string' };
      const out = [];
      for (const el of arr) {
        const r = coerce(el, itemField, o);
        if (r.ok && r.value !== null) out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case 'object': {
      let obj = value;
      if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return { ok: false }; } }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false };
      const sub = field.fields || [];
      if (!sub.length) return { ok: true, value: obj };
      const out = {};
      for (const f of sub) {
        const r = coerce(obj[f.name], f, o);
        out[f.name] = r.ok ? r.value : null;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: true, value: typeof value === 'object' ? value : String(value) };
  }
}

module.exports = { coerce };
