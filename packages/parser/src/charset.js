'use strict';
/**
 * Charset handling.
 *
 * Node's built-in TextDecoder (full ICU in Node 20) already knows every legacy
 * encoding we realistically meet in mail: iso-8859-*, windows-125*, koi8-*,
 * shift_jis, euc-jp, euc-kr, gb18030, big5. So there is no reason to take an
 * `iconv` dependency. What TextDecoder will NOT do is guess, and mail lies
 * about its charset constantly, so the mapping table and the fallback ladder
 * below are where the actual work is.
 */

/** Labels the WHATWG encoding registry does not know, mapped to ones it does. */
const ALIASES = new Map(Object.entries({
  'us-ascii': 'windows-1252',       // ascii + 8-bit garbage is nearly always cp1252
  'ascii': 'windows-1252',
  'ansi_x3.4-1968': 'windows-1252',
  'unknown-8bit': 'windows-1252',
  'x-unknown': 'windows-1252',
  'default': 'windows-1252',
  'iso-8859-1': 'windows-1252',     // per WHATWG: latin1 in mail means cp1252
  'latin1': 'windows-1252',
  'latin-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'iso_8859-1': 'windows-1252',
  'cp1252': 'windows-1252',
  'utf8': 'utf-8',
  'utf-8859-1': 'windows-1252',
  'utf-88': 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'ks_c_5601-1987': 'euc-kr',
  'ksc5601': 'euc-kr',
  'gb2312': 'gbk',
  'chinesebig5': 'big5',
  'x-sjis': 'shift_jis',
  'sjis': 'shift_jis',
  'iso-2022-jp-2': 'iso-2022-jp',
  'cp932': 'shift_jis',
  'utf-7': null,                    // handled specially below
}));

const decoderCache = new Map();

/**
 * Node's ICU maps windows-1252 straight through in the 0x80-0x9F range, so the
 * smart quotes and dashes Outlook emits arrive as C1 control characters. Mail
 * is full of them, so remap the range ourselves.
 */
const CP1252_C1 = ['\u20ac', '\u0081', '\u201a', '\u0192', '\u201e', '\u2026', '\u2020', '\u2021',
  '\u02c6', '\u2030', '\u0160', '\u2039', '\u0152', '\u008d', '\u017d', '\u008f',
  '\u0090', '\u2018', '\u2019', '\u201c', '\u201d', '\u2022', '\u2013', '\u2014',
  '\u02dc', '\u2122', '\u0161', '\u203a', '\u0153', '\u009d', '\u017e', '\u0178'];

function fixC1(str) {
  if (!/[\u0080-\u009f]/.test(str)) return str;
  return str.replace(/[\u0080-\u009f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80]);
}

function normaliseLabel(label) {
  if (!label) return 'utf-8';
  let l = String(label).trim().toLowerCase().replace(/^["']|["']$/g, '');
  l = l.replace(/^charset=/, '');
  if (ALIASES.has(l)) {
    const a = ALIASES.get(l);
    return a === null ? l : a;
  }
  return l;
}

/** UTF-7 is rare but Exchange still emits it; TextDecoder refuses it. */
function decodeUtf7(buf) {
  const s = buf.toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '+') { out += s[i]; continue; }
    const end = s.indexOf('-', i + 1);
    const stop = end === -1 ? s.length : end;
    const chunk = s.slice(i + 1, stop);
    if (chunk === '') { out += '+'; i = stop; continue; }
    try {
      const b = Buffer.from(chunk.replace(/,/g, '/') + '===', 'base64');
      for (let j = 0; j + 1 < b.length; j += 2) out += String.fromCharCode((b[j] << 8) | b[j + 1]);
    } catch { out += '+' + chunk; }
    i = stop;
  }
  return out;
}

function getDecoder(label) {
  if (decoderCache.has(label)) return decoderCache.get(label);
  let dec = null;
  try { dec = new TextDecoder(label, { fatal: false }); } catch { dec = null; }
  decoderCache.set(label, dec);
  return dec;
}

/**
 * Decode bytes to a JS string.
 * Ladder: declared charset -> utf-8 (if it validates) -> windows-1252.
 * A declared utf-8 that does not validate falls through to cp1252, because a
 * mislabelled cp1252 body is far more common than a genuinely broken utf-8 one.
 */
function decodeBuffer(buf, label) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  if (buf.length === 0) return '';
  const norm = normaliseLabel(label);
  if (norm === 'utf-7' || norm === 'unicode-1-1-utf-7' || norm === 'csunicode11utf7') return decodeUtf7(buf);

  // If the declared charset is a unicode one, check it really decodes cleanly.
  if (norm === 'utf-8') {
    const strict = getStrict('utf-8');
    if (strict) { try { return strict.decode(buf); } catch { /* fall through */ } }
    return fixC1(getDecoder('windows-1252').decode(buf));
  }
  const dec = getDecoder(norm);
  if (dec) return norm === 'windows-1252' ? fixC1(dec.decode(buf)) : dec.decode(buf);

  // Unknown label. Sniff: valid utf-8 -> utf-8, else cp1252.
  const strict = getStrict('utf-8');
  if (strict) { try { return strict.decode(buf); } catch { /* not utf-8 */ } }
  return fixC1(getDecoder('windows-1252').decode(buf));
}

const strictCache = new Map();
function getStrict(label) {
  if (strictCache.has(label)) return strictCache.get(label);
  let d = null;
  try { d = new TextDecoder(label, { fatal: true }); } catch { d = null; }
  strictCache.set(label, d);
  return d;
}

function isKnownCharset(label) {
  return !!getDecoder(normaliseLabel(label));
}

module.exports = { decodeBuffer, normaliseLabel, isKnownCharset, decodeUtf7 };
