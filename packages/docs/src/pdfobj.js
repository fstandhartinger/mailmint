'use strict';
const zlib = require('node:zlib');

/**
 * A deliberately small, forgiving reader for the PDF *object graph*.
 *
 * This is NOT a second text extractor — pdf.js does that job and does it well.
 * What pdf.js does not give us is access to the raw font dictionaries, and that
 * is exactly where the single worst real-world defect lives: a Type0 font whose
 * /ToUnicode CMap maps a glyph to U+0000. See repair.js. To fix that we have to
 * be able to read /Font, /FontDescriptor, /FontFile2 and /ToUnicode ourselves.
 *
 * Strategy: never trust the cross-reference table. Scan the bytes for
 * `N G obj` and index what we find. That is what every real-world PDF tool
 * falls back to anyway, it survives incremental updates and broken xrefs, and
 * it costs one linear pass.
 */

const MAX_OBJECTS = 20000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

class PdfDoc {
  constructor(buf) {
    this.buf = buf;
    this.objects = new Map();     // num -> {num, gen, start, valueStart, streamStart, streamEnd, raw}
    this.cache = new Map();
    this.compressed = new Map();  // num -> {objstm, index}
    this.scan();
    this.indexObjectStreams();
  }

  scan() {
    const s = this.buf.toString('latin1');
    const re = /(?:^|[\s>\]})])(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/g;
    let m; let n = 0;
    while ((m = re.exec(s)) !== null && n < MAX_OBJECTS) {
      const num = Number(m[1]);
      const valueStart = m.index + m[0].length;
      // Later definitions win: an incrementally-updated PDF appends the new one.
      this.objects.set(num, { num, gen: Number(m[2]), valueStart });
      n++;
      re.lastIndex = valueStart;
    }
    this.src = s;
  }

  /** Objects stored inside /ObjStm containers are invisible to a byte scan. */
  indexObjectStreams() {
    for (const num of [...this.objects.keys()]) {
      let o;
      try { o = this.get(num); } catch { continue; }
      if (!o || o.dict == null || o.dict.Type !== 'ObjStm') continue;
      let data;
      try { data = this.streamData(num); } catch { continue; }
      if (!data) continue;
      const count = Number(o.dict.N) || 0;
      const first = Number(o.dict.First) || 0;
      const head = data.slice(0, first).toString('latin1');
      const nums = head.trim().split(/\s+/).map(Number);
      for (let i = 0; i < count && i * 2 + 1 < nums.length; i++) {
        const objNum = nums[i * 2];
        const off = nums[i * 2 + 1];
        if (this.objects.has(objNum)) continue;   // a real object always wins
        this.compressed.set(objNum, { data, at: first + off });
      }
    }
  }

  /** Parse object `num` lazily. Returns {dict|value, streamStart, streamEnd}. */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let res = null;
    const rec = this.objects.get(num);
    if (rec) {
      const p = new Lexer(this.src, rec.valueStart);
      const value = p.parseObject();
      p.skipWs();
      let streamStart = null; let streamEnd = null;
      if (this.src.startsWith('stream', p.pos)) {
        let q = p.pos + 6;
        if (this.src[q] === '\r') q++;
        if (this.src[q] === '\n') q++;
        streamStart = q;
        let len = value && typeof value === 'object' ? this.resolve(value.Length) : null;
        if (typeof len === 'number' && len >= 0 && streamStart + len <= this.buf.length) {
          streamEnd = streamStart + len;
          // Trust, but verify: a wrong /Length is common in generated PDFs.
          const tail = this.src.slice(streamEnd, streamEnd + 20);
          if (!/^\s*endstream/.test(tail)) streamEnd = null;
        }
        if (streamEnd == null) {
          const e = this.src.indexOf('endstream', streamStart);
          streamEnd = e < 0 ? this.buf.length : e;
          while (streamEnd > streamStart && /[\r\n]/.test(this.src[streamEnd - 1])) streamEnd--;
        }
      }
      res = { num, dict: value, streamStart, streamEnd };
    } else if (this.compressed.has(num)) {
      const { data, at } = this.compressed.get(num);
      const p = new Lexer(data.toString('latin1'), at);
      res = { num, dict: p.parseObject(), streamStart: null, streamEnd: null };
    }
    this.cache.set(num, res);
    return res;
  }

  /** Follow an indirect reference exactly one level at a time. */
  resolve(v) {
    let hops = 0;
    while (v && typeof v === 'object' && v.__ref !== undefined && hops++ < 32) {
      const o = this.get(v.__ref);
      v = o ? o.dict : null;
    }
    return v;
  }

  /** Raw (still encoded) stream bytes of object `num`. */
  rawStream(num) {
    const o = this.get(num);
    if (!o || o.streamStart == null) return null;
    if (o.streamEnd - o.streamStart > MAX_STREAM_BYTES) return null;
    return this.buf.subarray(o.streamStart, o.streamEnd);
  }

  /** Decoded stream bytes of object `num`, or null if we cannot decode it. */
  streamData(num) {
    const o = this.get(num);
    const raw = this.rawStream(num);
    if (!raw) return null;
    let filters = this.resolve(o.dict.Filter);
    if (!filters) return raw;
    if (!Array.isArray(filters)) filters = [filters];
    let parms = this.resolve(o.dict.DecodeParms) || this.resolve(o.dict.DP) || null;
    if (parms && !Array.isArray(parms)) parms = [parms];
    let data = raw;
    for (let i = 0; i < filters.length; i++) {
      data = applyFilter(String(filters[i]), data, this.resolve(parms ? parms[i] : null), this);
      if (data == null) return null;
    }
    return data;
  }

  /** Every object number whose dict looks like `pred(dict)`. */
  find(pred) {
    const out = [];
    const nums = new Set([...this.objects.keys(), ...this.compressed.keys()]);
    for (const num of nums) {
      let o; try { o = this.get(num); } catch { continue; }
      if (!o || !o.dict || typeof o.dict !== 'object' || Array.isArray(o.dict)) continue;
      try { if (pred(o.dict, o)) out.push(num); } catch { /* skip */ }
    }
    return out;
  }
}

function applyFilter(name, data, parms, doc) {
  switch (name) {
    case 'FlateDecode': case 'Fl': {
      let out = null;
      for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
        try { out = fn(data); break; } catch { /* next */ }
      }
      if (!out) {
        // Truncated streams are common; salvage what inflate managed to emit.
        try { out = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
      }
      return predictor(out, parms, doc);
    }
    case 'ASCIIHexDecode': case 'AHx': {
      const hex = data.toString('latin1').replace(/[^0-9a-fA-F>]/g, '').split('>')[0];
      return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
    }
    case 'ASCII85Decode': case 'A85': return a85(data);
    case 'LZWDecode': case 'LZW': return predictor(lzw(data), parms, doc);
    case 'RunLengthDecode': case 'RL': return runLength(data);
    default: return null;   // DCTDecode/JPX/CCITT: image data, not our business here
  }
}

function predictor(data, parms, doc) {
  if (!data || !parms) return data;
  const pred = Number(doc ? doc.resolve(parms.Predictor) : parms.Predictor) || 1;
  if (pred < 2) return data;
  const colors = Number(parms.Colors) || 1;
  const bpc = Number(parms.BitsPerComponent) || 8;
  const columns = Number(parms.Columns) || 1;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) return data;   // TIFF predictor: rare, and harmless to skip
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = Buffer.from(data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)));
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) row[i] = (row[i] + a) & 0xff;
      else if (ft === 2) row[i] = (row[i] + b) & 0xff;
      else if (ft === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

function a85(data) {
  const s = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').split('~>')[0];
  const out = []; let tuple = []; 
  for (const ch of s) {
    if (ch === 'z' && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) { pushTuple(out, tuple, 4); tuple = []; }
  }
  if (tuple.length > 1) {
    const n = tuple.length - 1;
    while (tuple.length < 5) tuple.push(84);
    pushTuple(out, tuple, n);
  }
  return Buffer.from(out);
}
function pushTuple(out, t, n) {
  let v = 0; for (const d of t) v = v * 85 + d;
  const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  for (let i = 0; i < n; i++) out.push(b[i]);
}

function lzw(data) {
  const out = []; let dict = []; const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; dict.length = 258; };
  reset();
  let width = 9, buf = 0, bits = 0, prev = null;
  for (const byte of data) {
    buf = (buf << 8) | byte; bits += 8;
    while (bits >= width) {
      const code = (buf >> (bits - width)) & ((1 << width) - 1); bits -= width;
      if (code === 256) { reset(); width = 9; prev = null; continue; }
      if (code === 257) { bits = 0; break; }
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat(prev[0]);
      else continue;
      out.push(...entry);
      if (prev) dict.push(prev.concat(entry[0]));
      prev = entry;
      if (dict.length + 1 >= (1 << width) && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

function runLength(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n; k++) out.push(data[i++]); }
    else { const b = data[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
  }
  return Buffer.from(out);
}

/** A PDF object lexer over a latin1 string. Numbers, names, strings, dicts, arrays, refs. */
class Lexer {
  constructor(s, pos) { this.s = s; this.pos = pos || 0; this.depth = 0; }
  skipWs() {
    for (;;) {
      while (this.pos < this.s.length && /[\s\0]/.test(this.s[this.pos])) this.pos++;
      if (this.s[this.pos] === '%') { while (this.pos < this.s.length && this.s[this.pos] !== '\n') this.pos++; continue; }
      return;
    }
  }
  parseObject() {
    if (this.depth > 64) return null;
    this.skipWs();
    const c = this.s[this.pos];
    if (c === undefined) return null;
    if (c === '<' && this.s[this.pos + 1] === '<') return this.parseDict();
    if (c === '<') return this.parseHexString();
    if (c === '(') return this.parseString();
    if (c === '[') return this.parseArray();
    if (c === '/') return this.parseName();
    if (c === ']' || c === '>' || c === ')' || c === '}') { this.pos++; return null; }
    return this.parseKeywordOrNumber();
  }
  parseName() {
    this.pos++; let out = '';
    while (this.pos < this.s.length && !/[\s\0/<>[\]()%]/.test(this.s[this.pos])) {
      let ch = this.s[this.pos++];
      if (ch === '#' && /[0-9a-fA-F]{2}/.test(this.s.slice(this.pos, this.pos + 2))) {
        ch = String.fromCharCode(parseInt(this.s.substr(this.pos, 2), 16)); this.pos += 2;
      }
      out += ch;
    }
    return out;
  }
  parseDict() {
    this.pos += 2; this.depth++;
    const d = {};
    for (;;) {
      this.skipWs();
      if (this.s.startsWith('>>', this.pos)) { this.pos += 2; break; }
      if (this.pos >= this.s.length) break;
      if (this.s[this.pos] !== '/') { this.pos++; continue; }
      const key = this.parseName();
      const val = this.parseObject();
      d[key] = val;
    }
    this.depth--;
    return d;
  }
  parseArray() {
    this.pos++; this.depth++;
    const a = [];
    for (;;) {
      this.skipWs();
      if (this.s[this.pos] === ']') { this.pos++; break; }
      if (this.pos >= this.s.length) break;
      const before = this.pos;
      const v = this.parseObject();
      if (this.pos === before) { this.pos++; continue; }
      a.push(v);
    }
    this.depth--;
    return a;
  }
  parseHexString() {
    this.pos++; let hex = '';
    while (this.pos < this.s.length && this.s[this.pos] !== '>') {
      const ch = this.s[this.pos++];
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    return { __hex: hex };
  }
  parseString() {
    this.pos++; let out = ''; let depth = 1;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos++];
      if (ch === '\\') {
        const n = this.s[this.pos++];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (map[n] !== undefined) out += map[n];
        else if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && this.s[this.pos] >= '0' && this.s[this.pos] <= '7') oct += this.s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (n === '\n') { /* line continuation */ }
        else out += n;
      } else if (ch === '(') { depth++; out += ch; }
      else if (ch === ')') { if (--depth === 0) break; out += ch; }
      else out += ch;
    }
    return { __str: out };
  }
  parseKeywordOrNumber() {
    const start = this.pos;
    while (this.pos < this.s.length && !/[\s\0/<>[\]()%]/.test(this.s[this.pos])) this.pos++;
    const tok = this.s.slice(start, this.pos);
    if (tok === '') { this.pos++; return null; }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^[+-]?[\d.]+$/.test(tok)) {
      // `12 0 R` is an indirect reference, not two numbers.
      const save = this.pos;
      const m = /^[ \t\r\n]+(\d+)[ \t\r\n]+R\b/.exec(this.s.slice(this.pos, this.pos + 24));
      if (m && /^\d+$/.test(tok)) { this.pos += m[0].length; return { __ref: Number(tok) }; }
      this.pos = save;
      const n = Number(tok);
      return Number.isFinite(n) ? n : 0;
    }
    return { __op: tok };
  }
}

module.exports = { PdfDoc, Lexer, applyFilter };
