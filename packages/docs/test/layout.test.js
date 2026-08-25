'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildLines, segmentLine, renderText } = require('../src/layout');

/** A positioned run, with the defaults the PDF path would have produced. */
const run = (x, y, text, { w = null, h = 10, angle = 0 } = {}) =>
  ({ x, y, text, w: w === null ? text.length * h * 0.5 : w, h, angle, eol: false, font: 'F1' });

test('lines: baselines a fraction of a point apart are one line', () => {
  // Real generators emit exactly this: the same visual row, three different y.
  const { lines } = buildLines([
    run(30, 100.0, 'Description'),
    run(300, 100.4, 'Qty'),
    run(400, 99.6, 'Amount'),
  ]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].segments.length, 3);
});

test('lines: drift tolerance scales with glyph height, so big type does not split', () => {
  const { lines } = buildLines([
    run(30, 100, 'HEADING', { h: 24 }),
    run(300, 103, 'PAGE 1', { h: 24 }),      // 3pt apart, but 24pt type
  ]);
  assert.strictEqual(lines.length, 1, '24pt text 3pt apart is one line');

  const tight = buildLines([
    run(30, 100, 'row one', { h: 6 }),
    run(30, 104, 'row two', { h: 6 }),       // 4pt apart, 6pt type: two lines
  ]);
  assert.strictEqual(tight.lines.length, 2, '6pt text 4pt apart is two lines');
});

test('lines: a wide gap splits one line into separate segments (columns)', () => {
  const { lines } = buildLines([
    run(30, 100, 'Widget', { w: 40 }),
    run(300, 100, '3', { w: 6 }),
    run(400, 100, '27.00', { w: 30 }),
  ]);
  assert.deepStrictEqual(lines[0].segments.map((s) => s.text), ['Widget', '3', '27.00']);
});

test('segments: kerned runs rejoin into words, not columns', () => {
  // Generators split on kerning pairs; "In" "voice" is one word.
  const segs = segmentLine([
    run(30, 100, 'In', { w: 10 }),
    run(40, 100, 'voice', { w: 24 }),
    run(66.8, 100, 'number', { w: 30 }),     // a real space: ~0.28 em in Helvetica
  ]);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].text, 'Invoice number');
});

test('segments: touching runs are not given a phantom space', () => {
  const segs = segmentLine([run(30, 100, '$', { w: 6 }), run(36, 100, '495.00', { w: 30 })]);
  assert.strictEqual(segs[0].text, '$495.00');
});

test('lines: angled text is excluded and counted, never merged into a row', () => {
  const { lines, rotated } = buildLines([
    run(30, 100, 'Total'),
    run(300, 100, '99.00'),
    { ...run(200, 400, 'DRAFT COPY', { h: 40 }), angle: -0.7 },
  ]);
  assert.strictEqual(rotated, 1);
  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].text.includes('DRAFT'));
});

test('lines: blank runs never create an empty line', () => {
  const { lines } = buildLines([run(30, 100, '   '), run(30, 120, 'real')]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, 'real');
});

test('renderText keeps columns in column, which is what the rule layer reads', () => {
  const { lines } = buildLines([
    run(30, 100, 'Item', { w: 20 }), run(400, 100, 'Amount', { w: 34 }),
    run(30, 114, 'Widget', { w: 34 }), run(400, 114, '27.00', { w: 28 }),
  ]);
  const text = renderText(lines, 612);
  const [head, body] = text.split('\n').filter((l) => l.trim());
  assert.ok(head.indexOf('Amount') > 20, 'the right column stays right');
  assert.ok(Math.abs(head.indexOf('Amount') - body.indexOf('27.00')) <= 1,
    `columns must line up:\n${text}`);
});

test('renderText on nothing is an empty string, not a crash', () => {
  assert.strictEqual(renderText([], 612), '');
});
