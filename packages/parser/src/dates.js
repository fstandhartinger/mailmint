'use strict';

/**
 * Date extraction and normalisation.
 *
 * `08/09/2026` is the hard case: it is 8 September in most of the world and
 * 9 August in the United States, and nothing in the literal tells you which.
 * Rather than picking a house style and being wrong half the time we:
 *   1. use the literal itself when one component is > 12,
 *   2. otherwise infer the convention from other, unambiguous dates in the
 *      same document,
 *   3. otherwise use a locale hint from the sender's domain TLD,
 *   4. otherwise fall back to day-first (the majority convention worldwide)
 *      and mark the result low-confidence so callers can see the doubt.
 */

const MONTHS = {
  jan: 1, january: 1, januar: 1, janvier: 1, enero: 1, gennaio: 1, ene: 1,
  feb: 2, february: 2, februar: 2, fevrier: 2, 'février': 2, febrero: 2, febbraio: 2, fev: 2,
  mar: 3, march: 3, 'märz': 3, marz: 3, maerz: 3, mars: 3, marzo: 3, marzo_it: 3,
  apr: 4, april: 4, avril: 4, abril: 4, aprile: 4, abr: 4,
  may: 5, mai: 5, mayo: 5, maggio: 5, mag: 5,
  jun: 6, june: 6, juni: 6, juin: 6, junio: 6, giugno: 6,
  jul: 7, july: 7, juli: 7, juillet: 7, julio: 7, luglio: 7,
  aug: 8, august: 8, aout: 8, 'août': 8, agosto: 8, ago: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, settembre: 9, set: 9,
  oct: 10, october: 10, oktober: 10, octobre: 10, octubre: 10, ottobre: 10, okt: 10, ott: 10,
  nov: 11, november: 11, novembre: 11, noviembre: 11,
  dec: 12, december: 12, dezember: 12, 'décembre': 12, decembre: 12, diciembre: 12, dicembre: 12,
  dez: 12, dic: 12,
};
const MONTH_ALT = Object.keys(MONTHS).filter((k) => !k.includes('_')).sort((a, b) => b.length - a.length).join('|');

const DAY_FIRST_TLDS = new Set(['de', 'at', 'ch', 'uk', 'fr', 'it', 'es', 'nl', 'be', 'pl', 'cz',
  'se', 'no', 'dk', 'fi', 'pt', 'gr', 'ie', 'au', 'nz', 'in', 'br', 'ar', 'ru', 'tr', 'za', 'eu']);
const MONTH_FIRST_TLDS = new Set(['us', 'ph']);

function pad(n) { return String(n).padStart(2, '0'); }
function valid(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function iso(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function year4(y) { const n = parseInt(y, 10); return y.length <= 2 ? (n < 70 ? 2000 + n : 1900 + n) : n; }

const PATTERNS = [
  // ISO 2026-09-08 (optionally with a time)
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?![\d-])/g,
    make: (m) => ({ y: +m[1], mo: +m[2], d: +m[3], conf: 0.99 }) },
  // 2026/09/08
  { re: /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g,
    make: (m) => ({ y: +m[1], mo: +m[2], d: +m[3], conf: 0.95 }) },
  // 8. September 2026 / 8 Sep 2026 / 8th September, 2026
  { re: new RegExp('\\b(\\d{1,2})\\.?(?:st|nd|rd|th)?\\s+(' + MONTH_ALT + ')\\.?,?\\s+(\\d{2,4})\\b', 'gi'),
    make: (m) => ({ y: year4(m[3]), mo: MONTHS[m[2].toLowerCase()], d: +m[1], conf: 0.98 }) },
  // September 8, 2026 / Sep 8 2026
  { re: new RegExp('\\b(' + MONTH_ALT + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2,4})\\b', 'gi'),
    make: (m) => ({ y: year4(m[3]), mo: MONTHS[m[1].toLowerCase()], d: +m[2], conf: 0.98 }) },
  // 8. September (no year) -- resolved against the message date by the caller
  { re: new RegExp('\\b(\\d{1,2})\\.\\s*(' + MONTH_ALT + ')\\b(?!\\s*\\d)', 'gi'),
    make: (m) => ({ y: null, mo: MONTHS[m[2].toLowerCase()], d: +m[1], conf: 0.7 }) },
  // numeric d/m/y or m/d/y, separators / . -
  { re: /\b(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})\b/g,
    make: (m) => ({ a: +m[1], b: +m[3], y: year4(m[4]), sep: m[2], numeric: true, conf: 0.9 }) },
];

/**
 * @param {string} text
 * @param {{locale?:string, referenceYear?:number}} opts
 * @returns {Array<{value:string, raw:string, index:number, confidence:number, ambiguous:boolean}>}
 */
function findDates(text, opts) {
  const o = opts || {};
  if (!text) return [];
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const parsed = p.make(m);
      if (!parsed) continue;
      hits.push({ ...parsed, raw: m[0], index: m.index });
    }
  }
  hits.sort((a, b) => a.index - b.index);

  // Pass 1: everything unambiguous, so we can learn the document's convention.
  let dayFirstVotes = 0, monthFirstVotes = 0;
  for (const h of hits) {
    if (!h.numeric) continue;
    if (h.a > 12 && h.b <= 12) dayFirstVotes++;
    else if (h.b > 12 && h.a <= 12) monthFirstVotes++;
    else if (h.sep === '.') dayFirstVotes += 0.5;        // 08.09.2026 is never US style
  }
  const tldHint = localeHint(o.locale);
  const docConvention = dayFirstVotes > monthFirstVotes ? 'dmy'
    : monthFirstVotes > dayFirstVotes ? 'mdy' : null;

  const out = [];
  const seen = new Set();
  for (const h of hits) {
    let y = h.y, mo = h.mo, d = h.d, conf = h.conf, ambiguous = false;
    if (h.numeric) {
      const aDay = h.a > 12, bDay = h.b > 12;
      let dmy;
      if (aDay && !bDay) { dmy = true; conf = 0.97; }
      else if (bDay && !aDay) { dmy = false; conf = 0.97; }
      else if (aDay && bDay) continue;                   // not a date at all
      else {
        ambiguous = true;
        dmy = docConvention ? docConvention === 'dmy'
          : tldHint ? tldHint === 'dmy'
          : h.sep === '.' ? true : true;
        conf = docConvention ? 0.8 : tldHint ? 0.72 : 0.55;
      }
      d = dmy ? h.a : h.b;
      mo = dmy ? h.b : h.a;
    }
    if (y === null) {
      y = o.referenceYear || new Date().getUTCFullYear();
      conf = Math.min(conf, 0.65);
    }
    if (!valid(y, mo, d)) continue;
    const value = iso(y, mo, d);
    const key = value + '|' + h.raw;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, raw: h.raw, index: h.index, confidence: conf, ambiguous });
  }
  // Overlapping matches: keep the longest/most specific at each position.
  return out.filter((a, i) => !out.some((b, j) =>
    j !== i && b.index <= a.index && b.index + b.raw.length >= a.index + a.raw.length
    && (b.raw.length > a.raw.length || (b.raw.length === a.raw.length && j < i))));
}

function localeHint(locale) {
  if (!locale) return null;
  const l = String(locale).toLowerCase();
  const tld = (l.match(/\.([a-z]{2,})$/) || [])[1];
  if (tld && DAY_FIRST_TLDS.has(tld)) return 'dmy';
  if (tld && MONTH_FIRST_TLDS.has(tld)) return 'mdy';
  if (tld === 'com' || tld === 'net' || tld === 'org' || tld === 'io') return null;
  if (/^de|^fr|^es|^it|^nl|^pt|^pl/.test(l)) return 'dmy';
  if (/^en-us|^us/.test(l)) return 'mdy';
  return null;
}

/** Coerce a single string to YYYY-MM-DD. Used by type coercion. */
function toIsoDate(input, opts) {
  if (input == null) return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m && valid(+m[1], +m[2], +m[3])) return s;
  const found = findDates(s, opts);
  if (found.length) return found[0].value;
  const d = new Date(s);
  if (!isNaN(d) && /\d{4}/.test(s)) return d.toISOString().slice(0, 10);
  return null;
}

/** Coerce to an ISO-8601 UTC datetime. */
function toIsoDateTime(input, opts) {
  if (input == null) return null;
  const s = String(input).trim();
  const direct = new Date(s);
  if (!isNaN(direct) && /\d{4}/.test(s) && /[:T]/.test(s)) return direct.toISOString();
  const day = toIsoDate(s, opts);
  if (!day) return isNaN(direct) ? null : direct.toISOString();
  const t = s.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!t) return day + 'T00:00:00.000Z';
  let hh = parseInt(t[1], 10);
  const ap = (t[4] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  const dt = new Date(`${day}T${pad(hh)}:${t[2]}:${t[3] || '00'}Z`);
  return isNaN(dt) ? day + 'T00:00:00.000Z' : dt.toISOString();
}

module.exports = { findDates, toIsoDate, toIsoDateTime, MONTHS, localeHint };
