'use strict';
const { makeTable } = require('./tableshape');

/**
 * Table reconstruction from positioned text.
 *
 * CONTRACT §1b calls variable-row line items the #1 failure in this category:
 * "n8n silently maps row 1 only", "Make breaks past 2 columns", "57 of 533
 * rows". So the requirements here are specific: every row, more than two
 * columns, wrapped cells, and an explicit `truncated` rather than a quietly
 * short array.
 *
 * The method is alignment, not thresholds:
 *
 *   1. Two consecutive lines belong to the same table when their segments
 *      *line up* — at least two columns where both lines have text in the same
 *      horizontal band. A vertical-gap heuristic cannot tell an invoice's
 *      double-spaced line items from the end of the table; alignment can.
 *
 *   2. Columns come from the vertical white gaps running through the whole
 *      block. That handles right-aligned money columns, which x-start
 *      clustering gets wrong, and any number of columns, which is where the
 *      incumbents fall over.
 *
 *   3. A trailing `Subtotal / Total / Amount due` stack is NOT a line item. It
 *      has a different shape (a label floating in the middle, one figure on the
 *      right), so step 1 separates it automatically, and we then re-attach it
 *      to the table it belongs to as `totals` instead of polluting `records`.
 */

const NUMERIC = /^[^\p{L}]*\d[\d\s.,'’]*[^\p{L}]*$/u;
const MONEYISH = /[\d][\d.,\s]*$/;
const TOTALS_LABEL = new RegExp(
  '^(sub[- ]?total|total|grand total|amount due|amount paid|balance( due)?|due|tax|vat|gst|hst|sales tax'
  + '|shipping|freight|handling|discount|rounding|net( total| amount)?|gross|subtotal'
  // German, French, Spanish, Italian, Dutch: the languages that actually turn up
  + '|zwischensumme|summe|gesamt(betrag|summe)?|nettobetrag|bruttobetrag|mwst\\.?|ust\\.?|umsatzsteuer'
  + '|rechnungsbetrag|zu zahlen(der betrag)?|endbetrag|versand(kosten)?|rabatt|steuer'
  + '|sous[- ]total|montant( du| total| à payer)?|tva|remise|frais de port'
  + '|importe( total)?|subtotal|iva|total a pagar|totale|imponibile|sconto'
  + '|totaal|btw|te betalen)\\b[\\s:.]*$', 'i');

function isNumericCell(s) { return Boolean(s) && NUMERIC.test(s.trim()) && /\d/.test(s); }

/**
 * @param {Array} lines   from layout.buildLines
 * @param {object} opts   {source, startIndex, maxRows, maxTables}
 */
function tablesFromLines(lines, opts = {}) {
  const maxRows = opts.maxRows || 2000;
  const maxTables = opts.maxTables || 40;
  const source = opts.source || 'pdf';
  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;

  const seeds = lines.map((l, i) => ({ ...l, li: i })).filter((l) => l.segments.length >= 2);
  const blocks = groupAligned(seeds, medianH);

  const built = [];
  for (const block of blocks) {
    const t = buildBlock(block, lines, medianH, maxRows);
    if (t) built.push(t);
  }

  // A totals stack that follows a table is part of that table.
  const out = [];
  for (let i = 0; i < built.length; i++) {
    const t = built[i];
    if (t.isTotalsBlock) {
      const host = out[out.length - 1];
      if (host && absorbs(host, t, medianH)) { host.totals.push(...t.totals); continue; }
    }
    out.push(t);
  }

  const tables = [];
  for (const t of out) {
    if (t.isTotalsBlock && !t.totals.length) continue;
    if (!qualifies(t)) continue;
    if (tables.length >= maxTables) break;
    const tbl = makeTable(source, (opts.startIndex || 0) + tables.length, t.headers, t.rows, maxRows);
    if (t.totals.length) tbl.totals = t.totals;
    if (t.page) tbl.page = t.page;
    tables.push(tbl);
  }
  return tables;
}

/** Consecutive lines whose segments line up in at least two columns. */
function groupAligned(seeds, medianH) {
  const blocks = [];
  let cur = [];
  for (const line of seeds) {
    if (!cur.length) { cur = [line]; continue; }
    const prev = cur[cur.length - 1];
    const vgap = line.y - prev.y;
    if (vgap > medianH * 8 || !aligned(prev, line)) { blocks.push(cur); cur = [line]; continue; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);
  return blocks.filter((b) => b.length >= 2);
}

function aligned(a, b) {
  let hits = 0;
  for (const s of a.segments) {
    for (const t of b.segments) {
      if (overlap(s, t) > 0 || Math.abs(s.x0 - t.x0) <= 2.5 || Math.abs(s.x1 - t.x1) <= 2.5) { hits++; break; }
    }
  }
  return hits >= 2 && hits >= Math.min(a.segments.length, b.segments.length) - 1;
}

function overlap(a, b) { return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0); }

/**
 * Columns are the vertical white corridors running through every line of the
 * block. Anything narrower than roughly one space is inside a cell, not
 * between two.
 */
function columnsOf(block, medianH) {
  const spans = [];
  for (const l of block) for (const s of l.segments) spans.push([s.x0, s.x1]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.5) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const minGap = Math.max(3, medianH * 0.6);
  const cols = [];
  for (const m of merged) {
    const last = cols[cols.length - 1];
    if (last && m[0] - last[1] < minGap) last[1] = Math.max(last[1], m[1]);
    else cols.push([m[0], m[1]]);
  }
  return cols;
}

function buildBlock(block, allLines, medianH, maxRows) {
  const cols = columnsOf(block, medianH);
  if (cols.length < 2) return null;

  // Pull in the single-segment lines that sit *between* the block's rows: those
  // are wrapped cells, and dropping them is how "40 rows in, 1 row out" starts.
  const first = block[0].li, last = block[block.length - 1].li;
  const seq = [];
  const seedSet = new Set(block.map((b) => b.li));
  for (let i = first; i <= last; i++) {
    const l = allLines[i];
    if (!l || !l.segments.length) continue;
    seq.push({ line: l, seed: seedSet.has(i) });
  }

  const rows = [];
  const meta = [];
  for (const { line, seed } of seq) {
    const cells = new Array(cols.length).fill('');
    for (const s of line.segments) {
      const ci = pickColumn(cols, s);
      if (ci < 0) continue;
      cells[ci] = cells[ci] ? `${cells[ci]} ${s.text}` : s.text;
    }
    const filled = cells.filter((c) => c !== '').length;
    if (!filled) continue;
    const onlyFirst = filled === 1 && cells[0] !== '';
    if (!seed && onlyFirst && rows.length) {
      // A continuation line: glue it onto the description of the row above.
      rows[rows.length - 1][0] = `${rows[rows.length - 1][0]} ${cells[0]}`.trim();
      continue;
    }
    rows.push(cells);
    meta.push({ y: line.y, x0: line.segments[0].x0, filled, labels: cells.filter(Boolean) });
  }
  if (rows.length < 2) return null;

  // Header: a first row that names things rather than counting them.
  let headers = null;
  const firstRow = rows[0];
  const named = firstRow.filter((c) => c !== '').length;
  const anyNumericLater = rows.slice(1).some((r) => r.some(isNumericCell));
  if (named >= 2 && !firstRow.some(isNumericCell) && anyNumericLater) {
    headers = firstRow.map((c, i) => c || `col${i + 1}`);
    rows.shift(); meta.shift();
  }
  if (!headers) headers = cols.map((_, i) => `col${i + 1}`);

  // A block that is nothing but a totals stack.
  const totalsOnly = rows.length >= 1 && rows.every((r, i) => looksTotals(r, meta[i]));
  const t = {
    headers, rows, meta, cols, totals: [],
    page: block[0].page, y0: block[0].y, y1: block[block.length - 1].y,
    x1: Math.max(...cols.map((c) => c[1])),
    isTotalsBlock: totalsOnly,
  };
  if (totalsOnly) { t.totals = rows.map(toTotal).filter(Boolean); t.rows = []; return t; }

  // Or a table with the totals stack sitting inside it.
  while (t.rows.length && looksTotals(t.rows[t.rows.length - 1], t.meta[t.meta.length - 1])) {
    const r = t.rows.pop(); t.meta.pop();
    const tot = toTotal(r);
    if (tot) t.totals.unshift(tot);
  }
  if (t.rows.length > maxRows) t.rows = t.rows.slice(0, maxRows);
  return t;
}

function pickColumn(cols, seg) {
  let best = -1, bestOv = 0;
  for (let i = 0; i < cols.length; i++) {
    const ov = Math.min(cols[i][1], seg.x1) - Math.max(cols[i][0], seg.x0);
    if (ov > bestOv) { bestOv = ov; best = i; }
  }
  if (best >= 0) return best;
  // No overlap at all: fall back to the nearest column by centre.
  const c = (seg.x0 + seg.x1) / 2;
  let nd = Infinity;
  for (let i = 0; i < cols.length; i++) {
    const d = Math.abs((cols[i][0] + cols[i][1]) / 2 - c);
    if (d < nd) { nd = d; best = i; }
  }
  return best;
}

/** "Subtotal … 854.00" is a summary, not a line item. */
function looksTotals(cells, m) {
  const filled = cells.map((c, i) => ({ c, i })).filter((x) => x.c !== '');
  if (filled.length < 1 || filled.length > 3) return false;
  const label = filled.find((x) => !isNumericCell(x.c));
  // "854.00", "$854.00" and "$854.00 USD" are all the figure; the trailing
  // currency word is why a plain numeric test is not enough here.
  const value = [...filled].reverse().find((x) => x !== label && /\d/.test(x.c));
  if (!label || !value || label.i === value.i) return false;
  if (label.i === 0 && filled.length > 2) return false;
  return TOTALS_LABEL.test(label.c.trim());
}

function toTotal(cells) {
  const filled = cells.map((c, i) => ({ c, i })).filter((x) => x.c !== '');
  const label = filled.find((x) => !isNumericCell(x.c));
  const value = [...filled].reverse().find((x) => x !== label && /\d/.test(x.c));
  if (!label || !value) return null;
  return { label: label.c.replace(/[\s:.]+$/, ''), value: value.c };
}

function absorbs(host, totalsBlock, medianH) {
  if (!host.rows.length) return false;
  if (totalsBlock.y0 - host.y1 > medianH * 8) return false;
  return Math.abs(totalsBlock.x1 - host.x1) <= Math.max(12, medianH * 2);
}

/**
 * Reject the false positives. A two-column block of aligned text is usually an
 * address pair or a label list, not a table; we only accept one when a column
 * is genuinely numeric, which is what makes it data.
 */
function qualifies(t) {
  if (!t.rows.length) return false;
  const cols = t.headers.length;
  if (cols >= 3) return t.rows.length >= 1;
  if (t.rows.length < 3) return false;
  for (let c = 0; c < cols; c++) {
    const vals = t.rows.map((r) => r[c]).filter(Boolean);
    if (vals.length >= 3 && vals.filter(isNumericCell).length / vals.length >= 0.6) return true;
  }
  return false;
}

module.exports = { tablesFromLines, isNumericCell, looksTotals, columnsOf, groupAligned, TOTALS_LABEL };
