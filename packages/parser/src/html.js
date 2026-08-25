'use strict';

/**
 * A small forgiving HTML parser plus the two things we need from it:
 * readable plain text, and data tables.
 *
 * Written by hand rather than pulled in as a dependency because email HTML is
 * its own dialect: Outlook conditional comments, layout tables nested six deep,
 * hidden preheader spans, and tracking pixels. A general purpose html-to-text
 * converter treats all of that as content and the result is unusable.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dd', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
const DROP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'base']);
// Implicit-close rules: opening key closes an open element in the value set.
const CLOSES = {
  li: new Set(['li']), p: new Set(['p']), tr: new Set(['tr', 'td', 'th']),
  td: new Set(['td', 'th']), th: new Set(['td', 'th']), dd: new Set(['dd', 'dt']),
  dt: new Set(['dd', 'dt']), option: new Set(['option']),
  thead: new Set(['td', 'th', 'tr']), tbody: new Set(['td', 'th', 'tr', 'thead']),
  tfoot: new Set(['td', 'th', 'tr', 'tbody', 'thead']),
};

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwnj: '',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥',
  cent: '¢', deg: '°', plusmn: '±', times: '×', divide: '÷',
  laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à',
  ccedil: 'ç', ntilde: 'ñ', aacute: 'á', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ecirc: 'ê', ocirc: 'ô', acirc: 'â', ucirc: 'û',
  aring: 'å', oslash: 'ø', aelig: 'æ', check: '✓', star: '★',
};

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = ENTITIES[body] !== undefined ? ENTITIES[body] : ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].toLowerCase();
    if (!name || name === '/') continue;
    const v = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    attrs[name] = decodeEntities(v);
  }
  return attrs;
}

/** Parse HTML into a tree of {tag, attrs, children} / {text}. */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const src = String(html || '');
  let i = 0;
  const top = () => stack[stack.length - 1];

  const pushText = (t) => { if (t) top().children.push({ text: t }); };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(decodeEntities(src.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)>/.exec(src.slice(lt));
    if (!m) { pushText('<'); i = lt + 1; continue; }
    const [full, closing, rawTag, attrSrc, selfClose] = m;
    const tag = rawTag.toLowerCase();
    i = lt + full.length;

    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      continue;
    }

    const closeSet = CLOSES[tag];
    if (closeSet) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (closeSet.has(stack[k].tag)) { stack.length = k; break; }
        if (stack[k].tag === 'table') break;   // never escape the current table
      }
    }
    const node = { tag, attrs: parseAttrs(attrSrc), children: [] };
    top().children.push(node);
    if (RAW.has(tag)) {
      const close = new RegExp('</\\s*' + tag + '\\s*>', 'i');
      const rest = src.slice(i);
      const cm = close.exec(rest);
      const body = cm ? rest.slice(0, cm.index) : rest;
      node.children.push({ text: body });
      i += cm ? cm.index + cm[0].length : rest.length;
      continue;
    }
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  return root;
}

/** Preheader spans, tracking pixels and mso-hidden blocks are not content. */
function isHidden(node) {
  const a = node.attrs || {};
  if (a.hidden !== undefined) return true;
  const style = (a.style || '').toLowerCase().replace(/\s+/g, '');
  if (!style) return false;
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  if (/mso-hide:all/.test(style)) return true;
  if (/max-height:0/.test(style) && /overflow:hidden/.test(style)) return true;
  if (/font-size:0(px|pt|em)?[;:]?/.test(style) && /line-height:0/.test(style)) return true;
  return false;
}

function isTrackingPixel(node) {
  if (node.tag !== 'img') return false;
  const a = node.attrs || {};
  const w = parseInt(a.width, 10), h = parseInt(a.height, 10);
  return (w === 1 && h === 1) || (w === 0 || h === 0);
}

/**
 * Render a node tree to plain text.
 * `keepHidden` exists for the table pass, which does want hidden cells (an
 * amount hidden for mobile layout is still the amount).
 */
function renderText(node, opts) {
  const out = [];
  const o = opts || {};
  walk(node, out, o, 0);
  let s = out.join('');
  s = s.replace(/\u00a0/g, ' ');
  s = s.split('\n').map((l) => {
    let x = l.replace(/[ ]{2,}/g, ' ').replace(/\t{2,}/g, '\t');
    x = x.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return /^[\s]*$/.test(x) ? '' : x;
  }).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function walk(node, out, o, depth) {
  if (node.text !== undefined) { out.push(node.text.replace(/\s+/g, ' ')); return; }
  const tag = node.tag;
  if (DROP.has(tag)) return;
  if (!o.keepHidden && (isHidden(node) || isTrackingPixel(node))) return;
  if (depth > 60) return;

  if (tag === 'br') { out.push('\n'); return; }
  if (tag === 'hr') { out.push('\n---\n'); return; }
  if (tag === 'img') {
    const alt = (node.attrs.alt || '').trim();
    if (alt) out.push(alt + ' ');
    return;
  }
  if (tag === 'td' || tag === 'th') {
    for (const c of node.children) walk(c, out, o, depth + 1);
    out.push('\t');
    return;
  }
  if (tag === 'tr') { for (const c of node.children) walk(c, out, o, depth + 1); out.push('\n'); return; }
  if (tag === 'li') { out.push('\n- '); for (const c of node.children) walk(c, out, o, depth + 1); return; }

  const block = BLOCK.has(tag) || tag === '#root';
  if (block) out.push('\n');
  for (const c of node.children) walk(c, out, o, depth + 1);
  if (block) out.push('\n');
}

function textOf(node) {
  const out = [];
  walk(node, out, { keepHidden: true }, 0);
  return out.join('').replace(/[\t\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findAll(node, pred, acc) {
  acc = acc || [];
  if (node.children) {
    for (const c of node.children) {
      if (c.tag && pred(c)) acc.push(c);
      findAll(c, pred, acc);
    }
  }
  return acc;
}

/**
 * Extract data tables from HTML.
 *
 * The discriminator is TEXT-BEARING CELLS PER ROW, not the absence of nested
 * tables. Measured on a real Stripe invoice: 61 <table> tags, 78 <tr>, and only
 * 29 rows carrying more than one text-bearing cell — and those 29 rows are
 * exactly the content. Every ESP nests tables for Outlook compatibility, so a
 * rule that rejects nesting rejects the data, which is very likely why "I got
 * one row instead of forty" is the loudest complaint in this market.
 */
function extractHtmlTables(html) {
  const root = parseHtml(html);
  const tables = findAll(root, (n) => n.tag === 'table');
  const out = [];
  const seen = new Set();
  for (const t of tables) {
    const built = buildTable(t, out.length);
    if (!built) continue;
    const sig = JSON.stringify([built.headers, built.rows]);
    if (seen.has(sig)) continue;                    // the same grid reached twice
    seen.add(sig);
    out.push(built);
  }
  return out;
}

/** One <table> to a data table, or null when it is only layout. */
function buildTable(t, index) {
  const rows = collectRows(t);
  if (rows.length < 2) return null;
  const grid = rows.map((r) => r.cells.map((c) => textOf(c).replace(/\s+/g, ' ').trim()));
  const kept = [];
  const keptSource = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i].filter((c) => c !== '').length < 2) continue;   // spacer or single-cell banner
    kept.push(grid[i]);
    keptSource.push(rows[i]);
  }
  if (kept.length < 2) return null;
  const maxW = Math.max(...kept.map((r) => r.length));
  if (maxW < 2) return null;
  const norm = kept.map((r) => { const c = r.slice(0, maxW); while (c.length < maxW) c.push(''); return c; });
  if (!norm.some((r) => r.some((c) => c))) return null;

  const thIdx = keptSource.findIndex((r) => r.cells.length >= 2 && r.cells.every((c) => c.tag === 'th'));
  let headers, body;
  if (thIdx >= 0) { headers = norm[thIdx]; body = norm.filter((_, i) => i !== thIdx); }
  else if (looksLikeHeaderRow(norm[0], norm.slice(1))) { headers = norm[0]; body = norm.slice(1); }
  else { headers = norm[0].map((_, i) => 'col' + (i + 1)); body = norm; }
  if (!body.length) return null;
  return makeTable('html', index, headers, body);
}


/**
 * Repeating-structure extraction — the source that actually works on modern
 * email HTML.
 *
 * Real ESP mail does not put line items in a grid. Stripe gives each item its
 * OWN single-row nested table so that Outlook renders it; so do Shopify, DHL
 * and Amazon. A `<table>` -> headers/rows extractor structurally cannot see
 * them. What IS visible is that the same DOM shape repeats once per item.
 *
 * So: fingerprint every candidate block by its cell shape, group runs of
 * identical fingerprints, and treat each repetition as a row. The fingerprint
 * deliberately ignores the text, so a missing value does not split a group.
 */
function extractRepeatTables(html, startIndex) {
  const root = parseHtml(html);
  const units = [];
  (function rec(n, depth) {
    for (const c of n.children || []) {
      if (!c.tag) continue;
      if (c.tag === 'table') {
        const u = unitOf(c);
        if (u) { units.push(u); continue; }        // do not recurse into a matched unit
      }
      if (depth < 40) rec(c, depth + 1);
    }
  })(root, 0);

  const out = [];
  let i = 0;
  while (i < units.length) {
    let j = i + 1;
    while (j < units.length && units[j].sig === units[i].sig) j++;
    const run = units.slice(i, j);
    i = j;
    if (run.length < 2) continue;
    const rows = run.map((u) => u.cells);
    const distinct = new Set(rows.map((r) => r.join('|')));
    if (distinct.size < 2) continue;               // repeated spacers, not data
    const width = rows[0].length;
    if (width < 2) continue;
    const headers = labelColumns(rows, width);
    out.push({ ...makeTable('html-repeat', startIndex + out.length, headers, rows) });
  }
  return out;
}

/** A candidate repeat unit: a table with exactly one text-bearing row. */
function unitOf(table) {
  const rows = collectRows(table);
  const grids = rows.map((r) => r.cells.map((c) => textOf(c).replace(/\s+/g, ' ').trim()));
  const informative = grids.filter((g) => g.filter((x) => x !== '').length >= 2);
  if (informative.length !== 1) return null;
  const cells = informative[0];
  if (cells.length < 2 || cells.length > 12) return null;
  const filled = cells.map((c) => (c === '' ? '0' : /^[^A-Za-z]*[\d.,]+[^A-Za-z]*$/.test(c) ? 'n' : 't')).join('');
  const cls = (table.attrs && table.attrs.class ? String(table.attrs.class) : '').replace(/\s+/g, ' ').trim();
  return { sig: cells.length + ':' + filled.replace(/n/g, 'x').replace(/t/g, 'x') + ':' + cls, cells };
}

/** Name the synthesised columns after what they hold. */
function labelColumns(rows, width) {
  const headers = [];
  for (let c = 0; c < width; c++) {
    const vals = rows.map((r) => r[c] || '').filter(Boolean);
    if (!vals.length) { headers.push('col' + (c + 1)); continue; }
    const money = vals.filter((v) => /[$\u20ac\u00a3\u00a5\u20b9]|\b(?:USD|EUR|GBP|JPY|CHF)\b/.test(v)).length;
    const numeric = vals.filter((v) => /^\d+$/.test(v)).length;
    if (money >= vals.length * 0.6) headers.push('Amount');
    else if (numeric >= vals.length * 0.6) headers.push('Qty');
    else headers.push('Description');
  }
  const seen = new Map();
  return headers.map((h) => {
    if (!seen.has(h)) { seen.set(h, 1); return h; }
    const n = seen.get(h) + 1; seen.set(h, n); return h + '_' + n;
  });
}

/** Rows belonging to THIS table, not to a table nested inside one of its cells. */
function collectRows(table) {
  const rows = [];
  (function rec(n, depth) {
    for (const c of n.children || []) {
      if (!c.tag) continue;
      if (c.tag === 'table') continue;                       // nested table: not ours
      if (c.tag === 'tr') { rows.push({ cells: directCells(c) }); continue; }
      if (depth < 6) rec(c, depth + 1);
    }
  })(table, 0);
  return rows.filter((r) => r.cells.length);
}

function directCells(tr) {
  const cells = [];
  (function rec(n, depth) {
    for (const c of n.children || []) {
      if (!c.tag) continue;
      if (c.tag === 'td' || c.tag === 'th') { cells.push(c); continue; }
      if (c.tag === 'table' || c.tag === 'tr') continue;
      if (depth < 4) rec(c, depth + 1);
    }
  })(tr, 0);
  return cells;
}

/** First row is a header when it is wordy and the rows below are not. */
function looksLikeHeaderRow(first, rest) {
  if (!first || !first.length) return false;
  const numericish = (c) => /^[^A-Za-z]*[\d.,]+[^A-Za-z]*$/.test(c) && /\d/.test(c);
  const firstNumeric = first.filter(numericish).length;
  if (firstNumeric > 0) return false;
  if (!first.every((c) => c === '' || /[A-Za-z]/.test(c))) return false;
  if (first.filter((c) => c !== '').length < 2) return false;
  if (first.some((c) => c.length > 60)) return false;
  const restNumeric = rest.length ? rest.filter((r) => r.some(numericish)).length / rest.length : 0;
  const HEADERY = /(item|description|qty|quantity|amount|price|total|date|unit|sku|product|name|no\.?|number|tax|vat|subtotal|rate|hours|status)/i;
  if (first.some((c) => HEADERY.test(c))) return true;
  return restNumeric >= 0.5;
}

const MAX_TABLE_ROWS = 5000;

/**
 * Build the §1 table object. `row_count` is additive to the contract shape on
 * purpose: a consumer needs to be able to see that a table was complete, and a
 * silently short array is the single most-complained-about failure in every
 * competing product.
 */
function makeTable(source, index, headers, rows) {
  const truncated = rows.length > MAX_TABLE_ROWS;
  if (truncated) rows = rows.slice(0, MAX_TABLE_ROWS);
  const seen = new Map();
  const keys = headers.map((h, i) => {
    let k = (h || '').trim() || 'col' + (i + 1);
    if (seen.has(k)) { const n = seen.get(k) + 1; seen.set(k, n); k = k + '_' + n; } else seen.set(k, 1);
    return k;
  });
  const records = rows.map((r) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = r[i] === undefined ? null : r[i]; });
    return o;
  });
  return { source, index, headers, rows, records, row_count: rows.length, truncated };
}

/** All hrefs in the document, in order, deduplicated. */
function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
    if (/^(https?|mailto|tel):/i.test(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

function htmlToText(html) {
  if (!html) return '';
  return renderText(parseHtml(html), {});
}

module.exports = { parseHtml, htmlToText, extractHtmlTables, extractRepeatTables, extractLinks, decodeEntities, textOf, makeTable, renderText, MAX_TABLE_ROWS };
