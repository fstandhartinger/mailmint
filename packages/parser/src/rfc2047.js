'use strict';
const { decodeBuffer } = require('./charset');

/**
 * RFC 2047 encoded-words in header values.
 *
 * Two traps this handles that naive implementations get wrong:
 *  1. Adjacent encoded-words separated only by whitespace must have that
 *     whitespace DROPPED (RFC 2047 §6.2) — otherwise "=?..?B?..?= =?..?B?..?="
 *     that split a multi-byte character mid-way gains a stray space.
 *  2. A single multi-byte character may be split ACROSS two encoded words. So
 *     consecutive words with the same charset are concatenated at the BYTE
 *     level and decoded once, not decoded separately and then joined.
 */

const WORD = /=\?([^?\s]+?)(?:\*[^?]*)?\?([QqBb])\?([^?]*)\?=/g;

function decodeQ(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '_') { bytes.push(0x20); continue; }
    if (ch === '=' && i + 2 < str.length) {
      const hex = str.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeB(str) {
  const clean = str.replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(clean, 'base64');
}

/** Decode all encoded-words in a header value. */
function decodeWords(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.indexOf('=?') === -1) return s;

  // Tokenise into runs: literal text, or encoded word {charset, buf}.
  const tokens = [];
  let last = 0;
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(s)) !== null) {
    if (m.index > last) tokens.push({ lit: s.slice(last, m.index) });
    const enc = m[2].toUpperCase();
    let buf;
    try { buf = enc === 'B' ? decodeB(m[3]) : decodeQ(m[3]); } catch { buf = Buffer.from(m[3]); }
    tokens.push({ charset: m[1].toLowerCase(), buf });
    last = m.index + m[0].length;
  }
  if (last === 0) return s;
  if (last < s.length) tokens.push({ lit: s.slice(last) });

  // Drop whitespace-only literals sitting between two encoded words.
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.lit !== undefined && /^[ \t\r\n]*$/.test(t.lit)) {
      const prev = merged[merged.length - 1];
      const next = tokens[i + 1];
      if (prev && prev.charset !== undefined && next && next.charset !== undefined) continue;
    }
    merged.push(t);
  }

  // Concatenate byte-adjacent same-charset words before decoding.
  let out = '';
  for (let i = 0; i < merged.length; i++) {
    const t = merged[i];
    if (t.lit !== undefined) { out += t.lit; continue; }
    let buf = t.buf;
    while (i + 1 < merged.length && merged[i + 1].charset === t.charset) { buf = Buffer.concat([buf, merged[++i].buf]); }
    out += decodeBuffer(buf, t.charset);
  }
  return out;
}

module.exports = { decodeWords };
