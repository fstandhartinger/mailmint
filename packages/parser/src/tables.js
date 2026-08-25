'use strict';
const { makeTable } = require('./html');

/**
 * Tables inside text/plain bodies.
 *
 * Two shapes occur in the wild and both matter:
 *   1. pipe-delimited  `| Item | Qty | Amount |`  (markdown-ish, ticketing systems)
 *   2. whitespace-aligned columns, which is what every plain-text invoice and
 *      every `column`-formatted report emits.
 *
 * The whitespace case is the interesting one. We find the character columns
 * that are blank on EVERY line of a candidate block and treat runs of two or
 * more such columns as the separators. That handles ragged right edges and
 * values containing single spaces, which a naive `split(/\s{2,}/)` per line
 * does not — that approach splits each line differently and the columns stop
 * lining up as soon as one cell is short.
 */

const MIN_ROWS = 2;

function extractTextTables(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const pipe = takePipeBlock(lines, i);
    if (pipe) { pushTable(out, pipe.headers, pipe.rows); i = pipe.end; continue; }
    const ws = takeAlignedBlock(lines, i);
    if (ws) { pushTable(out, ws.headers, ws.rows); i = ws.end; continue; }
    i++;
  }
  return out;
}

function pushTable(out, headers, rows) {
  if (!rows.length || headers.length < 2) return;
  out.push(makeTable('text', out.length, headers, rows));
}

function isPipeLine(l) {
  const t = l.trim();
  return t.includes('|') && (t.match(/\|/g) || []).length >= 2 && t.replace(/[|\s]/g, '') !== '';
}
function isPipeSeparator(l) {
  return /^[\s|:+-]+$/.test(l) && l.includes('-') && l.includes('|');
}

function takePipeBlock(lines, start) {
  let i = start;
  const block = [];
  while (i < lines.length && (isPipeLine(lines[i]) || (block.length && isPipeSeparator(lines[i])))) {
    block.push(lines[i]); i++;
  }
  if (block.length < MIN_ROWS) return null;
  const cells = block.filter((l) => !isPipeSeparator(l)).map(splitPipeRow);
  if (cells.length < MIN_ROWS) return null;
  const width = mode(cells.map((c) => c.length));
  if (width < 2) return null;
  const rows = cells.map((c) => { const r = c.slice(0, width); while (r.length < width) r.push(''); return r; });
  const hadSep = block.some(isPipeSeparator);
  if (hadSep || headerish(rows[0], rows.slice(1))) return { headers: rows[0], rows: rows.slice(1), end: i };
  return { headers: rows[0].map((_, k) => 'col' + (k + 1)), rows, end: i };
}

function splitPipeRow(l) {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function mode(arr) {
  const m = new Map();
  for (const a of arr) m.set(a, (m.get(a) || 0) + 1);
  let best = 0, bestN = 0;
  for (const [k, n] of m) if (n > bestN || (n === bestN && k > best)) { best = k; bestN = n; }
  return best;
}

function takeAlignedBlock(lines, start) {
  let i = start;
  const block = [];
  while (i < lines.length) {
    const l = lines[i].replace(/\t/g, '    ');
    if (l.trim() === '') break;
    if (l.trimEnd().length < 8) break;
    if (!/\s{2,}\S/.test(l)) break;                 // needs at least one wide gap
    if (/^\s*[>|]/.test(l)) break;                  // quoted text is not a table
    block.push(l); i++;
    if (block.length > 200) break;
  }
  if (block.length < MIN_ROWS + 1) return null;     // 1 header + 2 rows minimum
  const width = Math.max(...block.map((l) => l.length));
  const padded = block.map((l) => l.padEnd(width, ' '));
  // Columns blank on every line.
  const blank = [];
  for (let c = 0; c < width; c++) blank.push(padded.every((l) => l[c] === ' '));
  const seps = [];
  let runStart = -1;
  for (let c = 0; c <= width; c++) {
    if (c < width && blank[c]) { if (runStart === -1) runStart = c; continue; }
    if (runStart !== -1) { if (c - runStart >= 2 && runStart > 0) seps.push([runStart, c]); runStart = -1; }
  }
  if (!seps.length) return null;
  const bounds = [0];
  for (const [a, b] of seps) { bounds.push(a); bounds.push(b); }
  bounds.push(width);
  const spans = [];
  for (let k = 0; k < bounds.length; k += 2) spans.push([bounds[k], bounds[k + 1]]);
  const cols = spans.filter(([a, b]) => b > a);
  if (cols.length < 2) return null;
  const rows = padded.map((l) => cols.map(([a, b]) => l.slice(a, b).trim()));
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
  if (nonEmpty.length < MIN_ROWS + 1) return null;
  // Reject prose that happens to have a wide gap: at least half the data rows
  // must carry something numeric or short.
  const dataRows = nonEmpty.slice(1);
  const informative = dataRows.filter((r) => r.filter((c) => c !== '').length >= 2).length;
  if (informative < dataRows.length * 0.6) return null;
  if (headerish(nonEmpty[0], dataRows)) return { headers: nonEmpty[0], rows: dataRows, end: i };
  return null;                                       // no header row -> probably not a table
}

function headerish(first, rest) {
  if (!first) return false;
  const filled = first.filter((c) => c !== '');
  if (filled.length < 2) return false;
  if (filled.some((c) => /\d[\d.,]*\s*$/.test(c) && /^\W*[\d.,]+\W*$/.test(c))) return false;
  if (!filled.every((c) => /[A-Za-z]/.test(c))) return false;
  if (filled.some((c) => c.length > 40)) return false;
  const HEADERY = /(item|artikel|beschreibung|description|qty|menge|quantity|amount|betrag|price|preis|total|summe|date|datum|unit|sku|product|name|no\.?|number|nr|tax|vat|mwst|subtotal|rate|hours|status|position)/i;
  if (filled.some((c) => HEADERY.test(c))) return true;
  const numericRows = rest.filter((r) => r.some((c) => /\d/.test(c))).length;
  return rest.length > 0 && numericRows / rest.length >= 0.5;
}

module.exports = { extractTextTables };
