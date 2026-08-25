'use strict';

/**
 * The CONTRACT §1 table shape, in one place.
 *
 * `headers`, `rows`, `records`, `row_count`, `truncated`. `row_count` is the
 * count of rows we ACTUALLY return and `truncated` says whether there were
 * more — CONTRACT §1b is explicit that a short array without that signal is
 * the failure mode we exist to fix, so the cap is applied here rather than
 * being left to each caller to remember.
 */
function makeTable(source, index, headers, rows, maxRows = 2000) {
  const total = rows.length;
  const truncated = total > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;

  const seen = new Map();
  const keys = headers.map((h, i) => {
    let k = String(h == null ? '' : h).replace(/\s+/g, ' ').trim() || `col${i + 1}`;
    if (seen.has(k)) { const n = seen.get(k) + 1; seen.set(k, n); k = `${k}_${n}`; } else seen.set(k, 1);
    return k;
  });

  const records = kept.map((r) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = r[i] === undefined || r[i] === '' ? null : r[i]; });
    return o;
  });

  const table = { source, index, headers: keys, rows: kept, records, row_count: kept.length, truncated };
  if (truncated) table.total_rows = total;
  return table;
}

module.exports = { makeTable };
