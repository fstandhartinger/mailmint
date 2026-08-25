'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildLines } = require('../src/layout');
const { tablesFromLines, looksTotals, isNumericCell } = require('../src/pdftables');
const { makeTable } = require('../src/tableshape');

const run = (x, y, text, { w = null, h = 9 } = {}) =>
  ({ x, y, text, w: w === null ? text.length * h * 0.5 : w, h, angle: 0, eol: false, font: 'F1' });

/** Lay out a grid: rows of [text, x] pairs at successive y. */
function grid(rows, { y0 = 100, dy = 20 } = {}) {
  const runs = [];
  rows.forEach((cells, i) => {
    for (const [text, x, opts] of cells) runs.push(run(x, y0 + i * dy, text, opts || {}));
  });
  return buildLines(runs).lines;
}

/** Right-align a money cell the way an invoice does: x is the RIGHT edge. */
const money = (text, right, h = 9) => [text, right - text.length * h * 0.5, { h }];

test('four columns, three rows, header detected', () => {
  const lines = grid([
    [['Description', 30], ['Qty', 400], ['Unit price', 460], ['Amount', 550]],
    [['Onboarding and implementation', 30], ['1', 405], money('495.00', 582), money('495.00', 582 - 0)],
    [['Priority support', 30], ['2', 405], money('297.00', 582), money('594.00', 582)],
    [['API overage', 30], ['1', 405], money('62.00', 582), money('62.00', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.ok(t, 'a table was found');
  assert.deepStrictEqual(t.headers, ['Description', 'Qty', 'Unit price', 'Amount']);
  assert.strictEqual(t.row_count, 3);
  assert.strictEqual(t.truncated, false);
  assert.strictEqual(t.records[1].Description, 'Priority support');
  assert.strictEqual(t.records[1].Qty, '2');
});

test('a wrapped description line joins the row above instead of becoming a row', () => {
  // The #1 documented failure mode: 40 rows in the mail, 1 row in the output.
  const lines = grid([
    [['Item', 30], ['Qty', 400], ['Amount', 550]],
    [['Annual licence for the reporting', 30], ['1', 405], money('1,199.00', 582)],
    [['module, seats 1-25', 30]],
    [['Support', 30], ['1', 405], money('245.00', 582)],
    [['Training', 30], ['2', 405], money('900.00', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.strictEqual(t.row_count, 3, `wrapped line became its own row:\n${JSON.stringify(t.rows)}`);
  assert.strictEqual(t.rows[0][0], 'Annual licence for the reporting module, seats 1-25');
  assert.strictEqual(t.rows[1][0], 'Support');
});

test('the totals stack is not a line item', () => {
  const lines = grid([
    [['Description', 30], ['Qty', 400], ['Amount', 550]],
    [['Widget', 30], ['3', 405], money('27.00', 582)],
    [['Bolt', 30], ['10', 405], money('4.50', 582)],
    [['Subtotal', 320], money('31.50', 582)],
    [['VAT 19%', 320], money('5.99', 582)],
    [['Total', 320], money('37.49', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.strictEqual(t.row_count, 2, `totals leaked into records:\n${JSON.stringify(t.rows)}`);
  assert.deepStrictEqual(t.rows.map((r) => r[0]), ['Widget', 'Bolt']);
  assert.deepStrictEqual(t.totals.map((x) => x.label), ['Subtotal', 'VAT 19%', 'Total']);
  assert.strictEqual(t.totals[2].value, '37.49');
});

test('a two-column address block is not reported as a table', () => {
  const lines = grid([
    [['Acme Ltd', 30], ['Bill to', 300]],
    [['1 High Street', 30], ['MailMint Ltd', 300]],
    [['London', 30], ['12 Other Road', 300]],
  ]);
  assert.deepStrictEqual(tablesFromLines(lines), []);
});

test('a two-column table with a numeric column IS reported', () => {
  const lines = grid([
    [['Licence', 30], money('1199.00', 582)],
    [['Support', 30], money('245.00', 582)],
    [['Training', 30], money('900.00', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.ok(t);
  assert.strictEqual(t.row_count, 3);
});

test('rows are cut at the cap and the cut is declared, never silent', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([[`Item ${i}`, 30], ['1', 405], money(`${i}.00`, 582)]);
  const lines = grid([[['Item', 30], ['Qty', 400], ['Amount', 550]], ...rows]);
  const [t] = tablesFromLines(lines, { maxRows: 25 });
  assert.strictEqual(t.row_count, 25);
  assert.strictEqual(t.truncated, true);
  assert.strictEqual(t.total_rows, 40);
});

test('more than two columns survives — the case Make.com is documented to fail', () => {
  const lines = grid([
    [['SKU', 30], ['Description', 100], ['Qty', 330], ['Unit', 390], ['Tax', 460], ['Amount', 540]],
    [['A-1', 30], ['Widget', 100], ['3', 335], money('9.00', 430), ['19%', 465], money('27.00', 582)],
    [['B-2', 30], ['Bolt', 100], ['10', 335], money('0.45', 430), ['19%', 465], money('4.50', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.strictEqual(t.headers.length, 6, JSON.stringify(t.headers));
  assert.strictEqual(t.row_count, 2);
  assert.strictEqual(t.records[0].SKU, 'A-1');
  assert.strictEqual(t.records[1].Amount, '4.50');
});

test('headerless data still produces addressable columns', () => {
  const lines = grid([
    [['Widget', 30], ['3', 405], money('27.00', 582)],
    [['Bolt', 30], ['10', 405], money('4.50', 582)],
    [['Nut', 30], ['5', 405], money('1.25', 582)],
  ]);
  const [t] = tablesFromLines(lines);
  assert.deepStrictEqual(t.headers, ['col1', 'col2', 'col3']);
  assert.strictEqual(t.row_count, 3);
});

test('looksTotals recognises the label in several languages', () => {
  for (const label of ['Subtotal', 'Total', 'Amount due', 'Zwischensumme', 'Gesamtbetrag',
    'MwSt.', 'Sous-total', 'TVA', 'Importe total', 'Totaal', 'Balance due']) {
    assert.ok(looksTotals(['', label, '99.00']), `${label} should read as a totals row`);
  }
  assert.ok(!looksTotals(['', 'Consulting day rate', '3000.00']));
  assert.ok(!looksTotals(['Widget', '3', '27.00']));
});

test('isNumericCell accepts money and rejects prose', () => {
  for (const v of ['27.00', '$495.00', '1.180,50', '€3,244.00', '-12.5', '(31.50)', '19%']) {
    assert.ok(isNumericCell(v), `${v} is numeric`);
  }
  for (const v of ['Widget', 'Item 3', '3 seats', '', 'N/A']) {
    assert.ok(!isNumericCell(v), `${v} is not numeric`);
  }
});

test('makeTable is the CONTRACT §1 shape', () => {
  const t = makeTable('pdf', 0, ['A', 'B', 'A'], [['1', '2', '3'], ['4', '', '6']], 10);
  assert.deepStrictEqual(t.headers, ['A', 'B', 'A_2'], 'duplicate headers get distinct keys');
  assert.deepStrictEqual(t.records[1], { A: '4', B: null, A_2: '6' }, 'an empty cell is null, not ""');
  assert.strictEqual(t.row_count, 2);
  assert.strictEqual(t.truncated, false);
  assert.strictEqual(t.source, 'pdf');
  assert.strictEqual(t.index, 0);
});
