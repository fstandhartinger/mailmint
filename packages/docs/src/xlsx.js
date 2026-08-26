'use strict';
const { openZip } = require('./zip');
const { makeTable } = require('./tableshape');

/**
 * XLSX -> tables, without the `xlsx` package.
 *
 * The dependency was considered and declined. SheetJS's community build is
 * roughly 7 MB of parser covering XLS, XLSB, ODS, formulas, styles and dates,
 * has a documented prototype-pollution history, and we need one thing from it:
 * the cell text of each sheet. That is a zip reader plus two XML shapes, which
 * is what this file is — and it means the package's whole dependency budget
 * stays spent on pdf.js, where it buys something we could not write.
 *
 * Deliberate limitations, stated rather than hidden: no formula evaluation (we
 * take the cached value, which is what the file was saved with), and no date
 * style resolution beyond the built-in numeric formats.
 */

const MAX_ROWS = 20000;
const MAX_COLS = 256;

function isXlsx(buf) {
  if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return false;
  const z = openZip(buf);
  return z.has('xl/workbook.xml');
}

function extractXlsx(buffer, { maxRows = 2000, maxTables = 40 } = {}) {
  const warnings = [];
  const z = openZip(buffer);
  if (!z.has('xl/workbook.xml')) return { tables: [], text: '', sheets: [], warnings: ['not_xlsx'] };

  const shared = readSharedStrings(z);
  const rels = readRels(z.text('xl/_rels/workbook.xml.rels'));
  const wb = z.text('xl/workbook.xml') || '';
  const sheets = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(wb)) !== null) {
    const attrs = m[1];
    const name = decodeXml(attr(attrs, 'name') || `Sheet${sheets.length + 1}`);
    const rid = attr(attrs, 'r:id') || attr(attrs, 'id');
    let path = rid && rels[rid] ? rels[rid] : null;
    if (path && !path.startsWith('/')) path = `xl/${path.replace(/^\.\//, '')}`;
    else if (path) path = path.replace(/^\//, '');
    if (!path || !z.has(path)) path = `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, path, state: attr(attrs, 'state') || 'visible' });
  }
  if (!sheets.length) sheets.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml', state: 'visible' });

  const tables = [];
  const textParts = [];
  for (const sheet of sheets) {
    if (tables.length >= maxTables) { warnings.push('sheet_limit'); break; }
    const xml = z.text(sheet.path);
    if (xml == null) { warnings.push(`sheet_unreadable:${sheet.name}`); continue; }
    const grid = readSheet(xml, shared);
    if (!grid.length) continue;
    const trimmed = trimGrid(grid);
    if (!trimmed.length) continue;
    const { headers, rows } = splitHeader(trimmed);
    const t = makeTable('xlsx', tables.length, headers, rows, maxRows);
    t.sheet = sheet.name;
    tables.push(t);
    textParts.push(`# ${sheet.name}`);
    textParts.push(trimmed.map((r) => r.join('\t')).join('\n'));
    if (grid.length > MAX_ROWS) warnings.push(`row_limit:${sheet.name}`);
  }
  return { tables, text: textParts.join('\n\n'), sheets: sheets.map((s) => s.name), warnings };
}

function attr(s, name) {
  const m = new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(s);
  return m ? m[1] : null;
}

function readRels(xml) {
  const out = {};
  if (!xml) return out;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) out[id] = decodeXml(target);
  }
  return out;
}

/** sharedStrings.xml: one <si> per string, possibly split across <r> runs. */
function readSharedStrings(z) {
  const xml = z.text('xl/sharedStrings.xml');
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const parts = [];
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(m[1])) !== null) parts.push(decodeXml(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function readSheet(xml, shared) {
  const grid = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm;
  let count = 0;
  while ((rm = rowRe.exec(xml)) !== null && count < MAX_ROWS) {
    count++;
    const rowAttrs = rm[1] || rm[3] || '';
    const idx = Number(attr(rowAttrs, 'r')) - 1;
    const body = rm[2] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(body)) !== null) {
      const ca = cm[1] || '';
      const inner = cm[2] || '';
      const ref = attr(ca, 'r');
      const ci = ref ? colIndex(ref) : auto;
      auto = ci + 1;
      if (ci < 0 || ci >= MAX_COLS) continue;
      cells[ci] = cellValue(attr(ca, 't'), inner, shared);
    }
    const at = Number.isFinite(idx) && idx >= 0 && idx < MAX_ROWS ? idx : grid.length;
    for (let i = grid.length; i < at; i++) grid[i] = [];
    grid[at] = normaliseRow(cells);
  }
  return grid;
}

function cellValue(type, inner, shared) {
  if (type === 'inlineStr') {
    const parts = [];
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(inner)) !== null) parts.push(decodeXml(t[1]));
    return parts.join('');
  }
  const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  const raw = vm ? decodeXml(vm[1]) : '';
  if (type === 's') {
    const i = Number(raw);
    return Number.isInteger(i) && shared[i] !== undefined ? shared[i] : '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return raw;
  return raw;
}

function normaliseRow(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) out[i] = cells[i] === undefined ? '' : String(cells[i]);
  return out;
}

/** Drop the empty rows and columns Excel leaves around a used range. */
function trimGrid(grid) {
  let last = -1;
  for (let i = 0; i < grid.length; i++) if (grid[i] && grid[i].some((c) => c !== '')) last = i;
  if (last < 0) return [];
  const rows = grid.slice(0, last + 1).map((r) => r || []);
  let width = 0;
  for (const r of rows) for (let c = r.length - 1; c >= 0; c--) { if (r[c] !== '') { width = Math.max(width, c + 1); break; } }
  if (!width) return [];
  const kept = rows.map((r) => { const o = []; for (let c = 0; c < width; c++) o[c] = r[c] === undefined ? '' : r[c]; return o; });
  // Leading blank rows carry no information but do shift the header.
  let first = 0;
  while (first < kept.length && kept[first].every((c) => c === '')) first++;
  return kept.slice(first);
}

function splitHeader(grid) {
  const first = grid[0] || [];
  const rest = grid.slice(1);
  const named = first.filter((c) => c !== '').length;
  const looksHeader = named >= 2 && !first.some((c) => /^-?[\d.,]+$/.test(c) && c !== '') && rest.length >= 1;
  if (looksHeader) return { headers: first.map((c, i) => c || `col${i + 1}`), rows: rest };
  return { headers: first.map((_, i) => `col${i + 1}`), rows: grid };
}

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function safeChar(cp) {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

module.exports = { extractXlsx, isXlsx, decodeXml, colIndex, trimGrid };
