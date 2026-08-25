'use strict';

/**
 * Number and money parsing for text written by humans in any locale.
 *
 * The whole problem is that `1,234` means one thousand two hundred and
 * thirty-four in Boston and one point two three four in Berlin, and the same
 * email can contain both conventions. So we never assume a locale: we look at
 * the shape of the literal and only fall back to a locale hint when the shape
 * itself is genuinely ambiguous.
 */

const SYMBOLS = {
  '$': 'USD', 'US$': 'USD', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD',
  'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'R$': 'BRL',
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB',
  '₩': 'KRW', '₪': 'ILS', '₺': 'TRY', '₴': 'UAH', '฿': 'THB',
  '₱': 'PHP', '₫': 'VND', 'zł': 'PLN', 'Kč': 'CZK', 'kr': 'SEK',
  'R': 'ZAR', 'Fr': 'CHF', 'CHF': 'CHF',
};

const CODES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK',
  'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'RUB', 'UAH', 'INR', 'CNY', 'RMB', 'HKD',
  'SGD', 'KRW', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'ZAR',
  'AED', 'SAR', 'ILS', 'EGP', 'NGN', 'KES', 'ISK', 'HRK', 'RSD']);

const SYMBOL_ALT = '(?:US\\$|CA?\\$|AUD?\\$|NZ\\$|HK\\$|S\\$|R\\$|CHF|Fr\\.?|z\\u0142|K\\u010d|kr|[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20bd\\u20a9\\u20aa\\u20ba\\u20b4\\u0e3f\\u20b1\\u20ab])';
const CODE_ALT = '(?:' + [...CODES].join('|') + ')';
const GROUP = '[.,\\u00a0\\u202f\\u2019\\u2018\'\\s]';
const NUM = '\\d{1,3}(?:' + GROUP + '\\d{3})+(?:[.,]\\d{1,4})?|\\d+(?:[.,]\\d{1,4})?';
const SIGN = '(?:[-\\u2212]|\\()?[ \\u00a0]*';
const GAP = '[ \\u00a0\\u202f]{0,3}';

/**
 * The gap rules are load-bearing. `EUR     298,00` inside a whitespace-aligned
 * table is NOT "EUR 298" — the code belongs to the number on its left. So a
 * prefixed currency may be at most three spaces from its number, and a
 * suffixed one is rejected when digits follow within two spaces, which is what
 * distinguishes `Qty 1 $495.00` (one item at $495) from `74,50 EUR` (a price).
 */
const MONEY_RE = new RegExp(
  '(' + SIGN + ')(?:(' + SYMBOL_ALT + ')' + GAP + '(' + NUM + ')' +
  '|(' + CODE_ALT + ')' + GAP + '(' + NUM + ')' +
  '|(' + NUM + ')' + GAP + '(' + SYMBOL_ALT + '|' + CODE_ALT + ')(?![ \\u00a0\\u202f]{0,2}\\d))([-\\u2212)]?)', 'g');

/**
 * Turn a numeric literal into a Number.
 * Returns null when the literal is not actually a number.
 */
function parseNumber(raw, hint) {
  if (raw == null) return null;
  let s = String(raw).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }   // (31.50) accounting negative
  if (/^-/.test(s)) { negative = true; s = s.slice(1).trim(); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/[   ]/g, ' ');
  s = s.replace(/^[^\d]+/, '').replace(/[^\d.,'\s]+$/, '');
  s = s.replace(/[''\u2019\u2018\s](?=\d{3}\b)/g, '');                                   // 1'234 and 1 234
  if (!/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decSep = null;
  if (lastComma !== -1 && lastDot !== -1) {
    decSep = lastComma > lastDot ? ',' : '.';
  } else if (lastComma !== -1) {
    const after = s.length - lastComma - 1;
    const commas = (s.match(/,/g) || []).length;
    if (commas > 1) decSep = null;                    // 1,234,567 -> grouping
    else if (after === 3) decSep = hint === 'eu' ? null : null;  // 1,234 -> grouping either way
    else decSep = ',';
  } else if (lastDot !== -1) {
    const after = s.length - lastDot - 1;
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) decSep = null;
    else if (after === 3) decSep = hint === 'eu' ? null : (/^\d{1,3}\.\d{3}$/.test(s) ? null : '.');
    else decSep = '.';
  }
  let cleaned;
  if (decSep === ',') cleaned = s.replace(/\./g, '').replace(',', '.');
  else if (decSep === '.') cleaned = s.replace(/,/g, '');
  else cleaned = s.replace(/[.,]/g, '');
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

function normaliseCurrency(token) {
  if (!token) return null;
  const t = token.trim().replace(/\.$/, '');
  const up = t.toUpperCase();
  if (CODES.has(up)) return up === 'RMB' ? 'CNY' : up;
  if (SYMBOLS[t]) return SYMBOLS[t];
  if (SYMBOLS[up]) return SYMBOLS[up];
  return null;
}

/**
 * Find every monetary amount in a string.
 * A locale hint ('eu' | 'us' | null) only breaks genuine ties.
 */
function findAmounts(text, hint, opts) {
  const out = [];
  if (!text) return out;
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(text)) !== null) {
    // Groups: 1 leading sign, 2 symbol + 3 number, 4 code + 5 number,
    //         6 number + 7 trailing symbol/code, 8 trailing sign.
    const pre = (m[1] || '').trim();
    const post = (m[8] || '').trim();
    const token = m[2] || m[4] || m[7];
    const num = m[3] !== undefined ? m[3] : m[5] !== undefined ? m[5] : m[6];
    const currency = normaliseCurrency(token);
    if (!currency) continue;
    const value = parseNumber(num, currency === 'EUR' || currency === 'CHF' ? 'eu' : hint);
    if (value === null) continue;
    // Accounting negatives: -$5.00, ($5.00) and 45,00 EUR- are all minus.
    const neg = pre === '-' || pre === '\u2212' || pre === '(' || post === '-' || post === '\u2212';
    const raw = m[0].trim();
    const lead = m[0].length - m[0].replace(/^\s+/, '').length;
    out.push({ value: neg ? -Math.abs(value) : value, currency, raw, index: m.index + lead, end: m.index + m[0].length });
  }
  return opts && opts.dedupe === false ? out : dedupeAmounts(out);
}

function dedupeAmounts(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const k = a.value + '|' + a.currency;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

module.exports = { parseNumber, findAmounts, normaliseCurrency, MONEY_RE, SYMBOL_ALT, CODE_ALT, NUM };
