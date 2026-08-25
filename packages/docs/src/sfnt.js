'use strict';
const { glyphNameToUnicode } = require('./glyphnames');

/**
 * Just enough TrueType/OpenType to answer one question: *which character is
 * glyph N?*
 *
 * That is the inverse of what a font is for, and it is the only way to recover
 * text from the very common real-world defect where a generator writes a
 * /ToUnicode entry of U+0000 (see repair.js). The embedded font still knows —
 * its `cmap` maps characters to glyphs, and its `post` table may name them.
 * We invert both.
 *
 * Only the tables we need are parsed. Anything unrecognised is skipped rather
 * than thrown on: a partially-readable font is still worth more than none.
 */

function u16(b, o) { return b[o] * 256 + b[o + 1]; }
function i16(b, o) { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; }
function u32(b, o) { return ((b[o] * 256 + b[o + 1]) * 256 + b[o + 2]) * 256 + b[o + 3]; }

function readTableDirectory(buf) {
  if (!buf || buf.length < 12) return null;
  let base = 0;
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    if (buf.length < 16) return null;
    base = u32(buf, 12);                   // first font in the collection
    if (base + 12 > buf.length) return null;
  }
  const numTables = u16(buf, base + 4);
  if (numTables > 512) return null;
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const p = base + 12 + i * 16;
    if (p + 16 > buf.length) break;
    const name = buf.toString('latin1', p, p + 4);
    const off = u32(buf, p + 8);
    const len = u32(buf, p + 12);
    if (off >= buf.length) continue;
    tables.set(name, buf.subarray(off, Math.min(buf.length, off + len)));
  }
  return tables;
}

/** Every (unicode -> gid) pair a cmap subtable declares. */
function readCmapSubtable(t, off, emit) {
  if (off + 4 > t.length) return;
  const format = u16(t, off);
  if (format === 0) {
    for (let c = 0; c < 256 && off + 6 + c < t.length; c++) emit(c, t[off + 6 + c]);
  } else if (format === 4) {
    const segX2 = u16(t, off + 6);
    const seg = segX2 >> 1;
    const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, rangeOffs = deltas + segX2;
    for (let i = 0; i < seg; i++) {
      if (rangeOffs + i * 2 + 2 > t.length) break;
      const end = u16(t, ends + i * 2), start = u16(t, starts + i * 2);
      const delta = i16(t, deltas + i * 2), ro = u16(t, rangeOffs + i * 2);
      if (start > end || end === 0xffff && start === 0xffff) continue;
      if (end - start > 20000) continue;
      for (let c = start; c <= end; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const gi = rangeOffs + i * 2 + ro + (c - start) * 2;
          if (gi + 2 > t.length) continue;
          g = u16(t, gi);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g) emit(c, g);
      }
    }
  } else if (format === 6) {
    const first = u16(t, off + 6), count = u16(t, off + 8);
    for (let i = 0; i < count && off + 10 + i * 2 + 2 <= t.length; i++) emit(first + i, u16(t, off + 10 + i * 2));
  } else if (format === 12) {
    const nGroups = u32(t, off + 12);
    if (nGroups > 200000) return;
    for (let i = 0; i < nGroups; i++) {
      const p = off + 16 + i * 12;
      if (p + 12 > t.length) break;
      const sc = u32(t, p), ec = u32(t, p + 4), sg = u32(t, p + 8);
      if (ec - sc > 20000) continue;
      for (let c = sc; c <= ec; c++) emit(c, sg + (c - sc));
    }
  }
}

/**
 * gid -> unicode string, built by inverting `cmap` (preferred) and `post`.
 * Where several characters share a glyph we keep the lowest non-PUA codepoint,
 * which is what a human reading the page would have seen.
 */
function reverseGlyphMap(fontBuf) {
  const tables = readTableDirectory(fontBuf);
  if (!tables) return new Map();
  const rev = new Map();
  const score = (c) => (c >= 0xe000 && c <= 0xf8ff ? 1e9 + c : c < 0x20 ? 1e8 + c : c);
  const put = (c, g) => {
    if (!g || !c) return;
    const cur = rev.get(g);
    if (cur === undefined || score(c) < score(cur)) rev.set(g, c);
  };

  const cmap = tables.get('cmap');
  if (cmap && cmap.length >= 4) {
    const n = u16(cmap, 2);
    for (let i = 0; i < n && 4 + i * 8 + 8 <= cmap.length; i++) {
      const p = 4 + i * 8;
      const plat = u16(cmap, p), enc = u16(cmap, p + 2), off = u32(cmap, p + 4);
      // (3,1)/(3,10)/(0,*) are unicode. (3,0) is a symbol map: the low byte is
      // the real code, which is how symbolic TrueType subsets address glyphs.
      const symbol = plat === 3 && enc === 0;
      if (!(plat === 0 || plat === 3 || (plat === 1 && enc === 0))) continue;
      readCmapSubtable(cmap, off, (c, g) => put(symbol ? (c & 0xff) || c : c, g));
    }
  }

  const post = tables.get('post');
  if (post && post.length > 32 && u32(post, 0) === 0x00020000) {
    const num = u16(post, 32);
    if (num <= 65535 && 34 + num * 2 <= post.length) {
      const idx = [];
      for (let i = 0; i < num; i++) idx.push(u16(post, 34 + i * 2));
      const names = [];
      let p = 34 + num * 2;
      while (p < post.length && names.length < 65535) {
        const len = post[p];
        names.push(post.toString('latin1', p + 1, p + 1 + len));
        p += 1 + len;
      }
      for (let g = 0; g < num; g++) {
        if (rev.has(g)) continue;
        const ix = idx[g];
        if (ix < 258) continue;                   // standard Macintosh order: covered by cmap
        const nm = names[ix - 258];
        const cp = nm ? glyphNameToUnicode(nm) : 0;
        if (cp) put(cp, g);
      }
    }
  }

  const out = new Map();
  for (const [g, c] of rev) out.set(g, String.fromCodePoint(c));
  return out;
}

module.exports = { reverseGlyphMap, readTableDirectory };
