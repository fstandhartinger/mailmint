'use strict';
const { makeTable } = require('./tableshape');

/**
 * Delimited text -> one table.
 *
 * Two details that separate this from `split(',')`:
 *
 * - **The delimiter is sniffed, not assumed.** A German Excel export is
 *   semicolon-delimited *because* its decimal separator is a comma. Assuming a
 *   comma there produces the `1.180,50 -> 1180.50` class of silent corruption
 *   the research calls out by name.
 * - **Quoted fields may contain the delimiter and newlines.** A state machine,
 *   not a regex, because an address field with a comma in it is the normal case.
 */

const DELIMS = [',', ';', '\t', '|'];

function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 20);
  if (!lines.length) return ',';
  let best = ','; let bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const nonZero = counts.filter((c) => c > 0).length;
    if (!nonZero) continue;
    const mode = counts.filter((c) => c > 0).sort((a, b) => a - b)[Math.floor(nonZero / 2)];
    // Consistency across lines matters more than raw frequency: a prose column
    // full of commas loses to a semicolon that appears exactly 6 times a line.
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 10 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line, d) {
  let n = 0; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') i++; else q = !q; }
    else if (!q && c === d) n++;
  }
  return n;
}

function parseDelimited(text, delimiter) {
  const d = delimiter || sniffDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === '') { quoted = true; field = ''; continue; }
    if (c === d) { row.push(field); field = ''; continue; }
    if (c === '\r') { if (text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows: rows.map((r) => r.map((f) => f.trim())), delimiter: d };
}

function extractCsv(text, { maxRows = 2000 } = {}) {
  const { rows, delimiter } = parseDelimited(text);
  const clean = rows.filter((r) => r.some((c) => c !== ''));
  if (!clean.length) return { tables: [], delimiter, warnings: ['empty'] };
  const width = Math.max(...clean.map((r) => r.length));
  const padded = clean.map((r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; });
  const first = padded[0];
  const looksHeader = width >= 2 && first.every((c) => !/^-?[\d.,]+$/.test(c)) && first.filter(Boolean).length >= 2;
  const headers = looksHeader ? first.map((c, i) => c || `col${i + 1}`) : first.map((_, i) => `col${i + 1}`);
  const body = looksHeader ? padded.slice(1) : padded;
  const t = makeTable('csv', 0, headers, body, maxRows);
  t.delimiter = delimiter;
  return { tables: [t], delimiter, warnings: [] };
}

module.exports = { extractCsv, parseDelimited, sniffDelimiter };
