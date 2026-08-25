'use strict';

/**
 * /ToUnicode CMap parsing and (re)serialisation.
 *
 * A CMap is PostScript-flavoured, but the ToUnicode subset that matters is
 * tiny: `begincodespacerange`, `beginbfchar` and `beginbfrange`. The parser is
 * deliberately literal about the three forms bfrange can take, because the
 * third one — an explicit array of destinations — is the one hand-rolled
 * parsers usually get wrong, and it is exactly what ligature-heavy and
 * accented documents use.
 *
 *   <lo> <hi> <dstStart>          contiguous run
 *   <lo> <hi> [<d0> <d1> ...]     per-code destinations
 *   <src> <dst>                   single code (bfchar)
 *
 * Destinations are UTF-16BE and may be multi-code-unit (a ligature glyph maps
 * to two characters).
 */

const MAX_RANGE = 65536;

function hexToStr(hex) {
  let out = '';
  for (let i = 0; i < hex.length; i += 4) {
    const unit = parseInt(hex.substr(i, 4).padEnd(4, '0'), 16);
    if (!Number.isFinite(unit)) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

/**
 * @returns {{ map: Map<number,string>, byteLengths: Set<number>, ranges: number }}
 *          `map` is source code -> destination string. Codes are integers, so a
 *          2-byte Identity-H code and a 1-byte simple-font code look the same;
 *          `byteLengths` records what the codespace declared so callers can tell.
 */
function parseCMap(text) {
  const map = new Map();
  const byteLengths = new Set();
  let ranges = 0;
  const s = String(text);

  const csr = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m;
  while ((m = csr.exec(s)) !== null) {
    const hexes = m[1].match(/<([0-9a-fA-F]*)>/g) || [];
    for (const h of hexes) byteLengths.add(Math.max(1, Math.floor((h.length - 2) / 2)));
  }

  const bfc = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfc.exec(s)) !== null) {
    const toks = tokenize(m[1]);
    for (let i = 0; i + 1 < toks.length; i += 2) {
      const src = toks[i], dst = toks[i + 1];
      if (src.t !== 'hex' || (dst.t !== 'hex' && dst.t !== 'name')) continue;
      map.set(parseInt(src.v, 16), dst.t === 'hex' ? hexToStr(dst.v) : dst.v);
    }
  }

  const bfr = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfr.exec(s)) !== null) {
    const toks = tokenize(m[1]);
    let i = 0;
    while (i + 2 < toks.length) {
      const lo = toks[i], hi = toks[i + 1], dst = toks[i + 2];
      if (lo.t !== 'hex' || hi.t !== 'hex') { i++; continue; }
      const a = parseInt(lo.v, 16), b = parseInt(hi.v, 16);
      if (!(b >= a) || b - a > MAX_RANGE) { i += 3; continue; }
      ranges++;
      if (dst.t === 'array') {
        for (let k = 0; k <= b - a && k < dst.v.length; k++) {
          if (dst.v[k].t === 'hex') map.set(a + k, hexToStr(dst.v[k].v));
        }
      } else if (dst.t === 'hex') {
        const base = hexToStr(dst.v);
        // Only the LAST UTF-16 unit increments across the range.
        const head = base.slice(0, -1);
        const tail = base.length ? base.charCodeAt(base.length - 1) : 0;
        for (let k = 0; k <= b - a; k++) map.set(a + k, head + String.fromCharCode((tail + k) & 0xffff));
      }
      i += 3;
    }
  }
  return { map, byteLengths, ranges };
}

/** `<AB12>`, `[<..> <..>]`, `/name`. Anything else is skipped. */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '<') {
      const e = src.indexOf('>', i);
      if (e < 0) break;
      out.push({ t: 'hex', v: src.slice(i + 1, e).replace(/[^0-9a-fA-F]/g, '') });
      i = e + 1;
    } else if (c === '[') {
      const e = src.indexOf(']', i);
      const inner = src.slice(i + 1, e < 0 ? src.length : e);
      out.push({ t: 'array', v: tokenize(inner) });
      i = e < 0 ? src.length : e + 1;
    } else if (c === '/') {
      let j = i + 1;
      while (j < src.length && !/[\s/<>[\]]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i + 1, j) });
      i = j;
    } else i++;
  }
  return out;
}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const strToHex = (s) => [...s].map((ch) => hex4(ch.charCodeAt(0))).join('');

/**
 * Render a CMap back to PostScript, as compactly as we can while staying valid.
 * repair.js has to fit the result inside the byte budget of the stream it is
 * replacing, so compactness is a correctness requirement here, not a nicety.
 */
function serialiseCMap(map, { codeBytes = 2 } = {}) {
  const codes = [...map.keys()].filter((k) => Number.isInteger(k) && k >= 0).sort((a, b) => a - b);
  const pad = codeBytes * 2;
  const lines = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange',
    `<${'0'.repeat(pad)}> <${'F'.repeat(pad)}>`,
    'endcodespacerange',
  ];
  for (let i = 0; i < codes.length; i += 100) {
    const chunk = codes.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const c of chunk) {
      lines.push(`<${c.toString(16).toUpperCase().padStart(pad, '0')}><${strToHex(map.get(c))}>`);
    }
    lines.push('endbfchar');
  }
  lines.push('endcmap CMapName currentdict /CMap defineresource pop end end');
  return lines.join('\n');
}

module.exports = { parseCMap, serialiseCMap, hexToStr, strToHex, tokenize };
