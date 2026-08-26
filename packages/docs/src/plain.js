'use strict';
const { makeTable } = require('./tableshape');

/**
 * Text and HTML attachments.
 *
 * Charset first. CONTRACT §1 promises UTF-8, and the research file records
 * mojibake out of n8n's IMAP node as an open, staff-acknowledged defect — so
 * `â€TM` in place of an apostrophe is a bug we are specifically not allowed to
 * ship. The order is: byte-order mark, declared charset, UTF-8 validity, then
 * Windows-1252 (never ISO-8859-1: real "latin1" mail is almost always cp1252,
 * and the difference is exactly the curly quotes and the euro sign).
 */

const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
  0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013,
  0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

function decodeText(buffer, charsetHint) {
  if (!buffer || !buffer.length) return { text: '', charset: 'utf-8' };
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), charset: 'utf-8' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), charset: 'utf-16le' };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: Buffer.from(buffer.subarray(2)).swap16().toString('utf16le'), charset: 'utf-16be' };
  }
  const hint = normaliseCharset(charsetHint);
  if (hint && hint !== 'utf-8') {
    if (hint === 'utf-16le' || hint === 'utf-16be') {
      const b = hint === 'utf-16be' ? Buffer.from(buffer).swap16() : buffer;
      return { text: b.toString('utf16le'), charset: hint };
    }
    if (hint === 'windows-1252' || hint === 'iso-8859-1') return { text: cp1252(buffer), charset: 'windows-1252' };
    if (Buffer.isEncoding(hint)) return { text: buffer.toString(hint), charset: hint };
  }
  if (isValidUtf8(buffer)) return { text: buffer.toString('utf8'), charset: 'utf-8' };
  return { text: cp1252(buffer), charset: 'windows-1252' };
}

function normaliseCharset(c) {
  if (!c || typeof c !== 'string') return null;
  const s = c.toLowerCase().replace(/["']/g, '').trim();
  if (/^utf-?8$/.test(s)) return 'utf-8';
  if (/^utf-?16-?le$/.test(s) || s === 'utf-16') return 'utf-16le';
  if (/^utf-?16-?be$/.test(s)) return 'utf-16be';
  if (/^(windows-?1252|cp-?1252|ansi)$/.test(s)) return 'windows-1252';
  if (/^(iso-?8859-?1|latin-?1|us-ascii|ascii)$/.test(s)) return 'iso-8859-1';
  return s;
}

function isValidUtf8(buf) {
  const s = buf.toString('utf8');
  return !s.includes('�');
}

function cp1252(buf) {
  let out = '';
  for (const b of buf) {
    if (b >= 0x80 && b <= 0x9f) out += String.fromCharCode(CP1252_HIGH[b - 0x80]);
    else out += String.fromCharCode(b);
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°',
  laquo: '«', raquo: '»', middot: '·', times: '×', divide: '÷' };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = ENTITIES[e] !== undefined ? ENTITIES[e] : ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK = /^(p|div|br|tr|li|h[1-6]|table|thead|tbody|section|article|header|footer|blockquote|pre|ul|ol|dl|dd|dt|hr|td|th)$/i;

function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (m, tag) => {
    if (/^(td|th)$/i.test(tag)) return '\t';
    return BLOCK.test(tag) ? '\n' : '';
  });
  s = decodeEntities(s);
  return s.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
}

/**
 * Tables out of an HTML attachment.
 *
 * Depth-tracked rather than regex-matched, because layout HTML nests tables
 * several deep and a non-greedy `<table>[\s\S]*?</table>` matches the wrong
 * closing tag every time that happens.
 */
function htmlTables(html, { maxRows = 2000, maxTables = 40, startIndex = 0 } = {}) {
  const tables = [];
  const src = String(html).replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  const stack = [];
  let m;
  let textStart = 0;
  const grids = [];
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!/^(table|tr|td|th|thead|tbody|tfoot)$/.test(tag)) continue;
    const selfClosing = /\/\s*$/.test(m[3]);
    if (!closing && !selfClosing) {
      if (tag === 'table') { stack.push({ tag, rows: [] }); grids.push(stack[stack.length - 1]); }
      else if (tag === 'tr') { const t = topOf(stack, 'table'); if (t) { const r = { tag, cells: [] }; t.rows.push(r); stack.push(r); } }
      else if (tag === 'td' || tag === 'th') {
        const r = topOf(stack, 'tr');
        if (r) { const c = { tag, start: m.index + m[0].length, header: tag === 'th' }; r.cells.push(c); stack.push(c); }
      }
      textStart = m.index + m[0].length;
    } else if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          if (tag === 'td' || tag === 'th') {
            const c = stack[i];
            c.text = htmlToText(src.slice(c.start, m.index)).replace(/\s+/g, ' ').trim();
          }
          stack.length = i;
          break;
        }
      }
    }
  }
  for (const g of grids) {
    // Close any cell left open by malformed markup.
    const rows = g.rows.map((r) => r.cells.map((c) => (c.text === undefined ? '' : c.text)))
      .filter((r) => r.length && r.some((c) => c !== ''));
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((r) => r.length));
    if (width < 2) continue;
    const padded = rows.map((r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; });
    const headerRow = g.rows[0] && g.rows[0].cells.every((c) => c.header) ? padded[0] : null;
    const headers = headerRow || (padded[0].every((c) => !/^-?[\d.,]+$/.test(c)) ? padded[0] : padded[0].map((_, i) => `col${i + 1}`));
    const body = headers === padded[0] ? padded.slice(1) : padded;
    if (!body.length) continue;
    if (tables.length >= maxTables) break;
    tables.push(makeTable('html', startIndex + tables.length, headers, body, maxRows));
  }
  return tables;
}

function topOf(stack, tag) {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) return stack[i];
  return null;
}

/** Fixed-width / whitespace-aligned blocks inside a plain text file. */
function textTables(text, { maxRows = 2000, maxTables = 40, startIndex = 0 } = {}) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const tables = [];
  let i = 0;
  while (i < lines.length && tables.length < maxTables) {
    const block = takePipeBlock(lines, i);
    if (block) {
      if (block.rows.length) tables.push(makeTable('text', startIndex + tables.length, block.headers, block.rows, maxRows));
      i = block.end;
      continue;
    }
    i++;
  }
  return tables;
}

function takePipeBlock(lines, start) {
  const rows = [];
  let i = start;
  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
    const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!/^[\s|:-]+$/.test(lines[i])) rows.push(cells);
    i++;
  }
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; });
  return { headers: padded[0].map((c, k) => c || `col${k + 1}`), rows: padded.slice(1), end: i };
}

module.exports = { decodeText, htmlToText, htmlTables, textTables, decodeEntities, cp1252, normaliseCharset };
