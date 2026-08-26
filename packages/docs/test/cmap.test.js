'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCMap, serialiseCMap, hexToStr } = require('../src/cmap');
const { parseDifferences, differencesMap } = require('../src/differences');
const { glyphNameToUnicode } = require('../src/glyphnames');
const { reverseGlyphMap } = require('../src/sfnt');
const { decodePdfText } = require('../src/repair');

test('cmap: bfchar maps single codes', () => {
  const { map } = parseCMap(`
    1 begincodespacerange <0000> <FFFF> endcodespacerange
    2 beginbfchar
    <0003> <0041>
    <0004> <00E4>
    endbfchar`);
  assert.strictEqual(map.get(3), 'A');
  assert.strictEqual(map.get(4), 'ä');
});

test('cmap: bfrange increments only the last UTF-16 unit', () => {
  const { map } = parseCMap('4 beginbfrange <0010> <0013> <0041> endbfrange');
  assert.deepStrictEqual([map.get(0x10), map.get(0x11), map.get(0x12), map.get(0x13)], ['A', 'B', 'C', 'D']);
});

test('cmap: bfrange with an explicit destination array', () => {
  // The form hand-rolled parsers get wrong. Destinations are NOT contiguous.
  const { map } = parseCMap('1 beginbfrange <0020> <0022> [<0041> <005A> <0030>] endbfrange');
  assert.strictEqual(map.get(0x20), 'A');
  assert.strictEqual(map.get(0x21), 'Z');
  assert.strictEqual(map.get(0x22), '0');
});

test('cmap: a destination may be several code units (ligature)', () => {
  const { map } = parseCMap('1 beginbfchar <00FB> <00660069> endbfchar');
  assert.strictEqual(map.get(0xfb), 'fi');
});

test('cmap: codespace byte width is reported', () => {
  const one = parseCMap('1 begincodespacerange <00> <FF> endcodespacerange');
  const two = parseCMap('1 begincodespacerange <0000> <FFFF> endcodespacerange');
  assert.deepStrictEqual([...one.byteLengths], [1]);
  assert.deepStrictEqual([...two.byteLengths], [2]);
});

test('cmap: U+0000 destinations survive parsing so the repair can find them', () => {
  // This is the real defect from the Stripe invoice: the generator kept the
  // glyph and wrote U+0000 as its meaning.
  const { map } = parseCMap('2 beginbfchar <0544> <0000> <0545> <002D> endbfchar');
  assert.strictEqual(map.get(0x544).charCodeAt(0), 0);
  assert.strictEqual(map.get(0x545), '-');
});

test('cmap: round-trips through serialise', () => {
  const src = new Map([[1, 'A'], [2, 'ä'], [0x544, '-'], [0x1000, 'fi']]);
  const { map } = parseCMap(serialiseCMap(src, { codeBytes: 2 }));
  assert.deepStrictEqual([...map.entries()].sort((a, b) => a[0] - b[0]), [...src.entries()].sort((a, b) => a[0] - b[0]));
});

test('cmap: serialised form is compact enough to fit the stream it replaces', () => {
  // repair.js can only patch in place if the recompressed CMap fits the
  // original byte budget, so compactness is a correctness property.
  const big = new Map();
  for (let i = 0; i < 300; i++) big.set(i, String.fromCharCode(0x41 + (i % 26)));
  const out = serialiseCMap(big);
  assert.ok(out.length < 300 * 24, `serialised cmap unexpectedly large: ${out.length}`);
  assert.ok(out.includes('endcodespacerange') && out.includes('endcmap'));
});

test('cmap: garbage input yields an empty map rather than throwing', () => {
  for (const junk of ['', 'beginbfchar', '<<>>', 'beginbfrange <FF> endbfrange', null]) {
    const { map } = parseCMap(junk);
    assert.ok(map instanceof Map);
  }
});

test('hexToStr decodes UTF-16BE, padding a short trailing unit', () => {
  assert.strictEqual(hexToStr('00410042'), 'AB');
  assert.strictEqual(hexToStr('0041'), 'A');
});

test('differences: a number resets the code counter', () => {
  const m = parseDifferences([32, 'space', 'exclam', 128, 'Euro', 'bullet']);
  assert.strictEqual(m.get(32), 'space');
  assert.strictEqual(m.get(33), 'exclam');
  assert.strictEqual(m.get(128), 'Euro');
  assert.strictEqual(m.get(129), 'bullet');
  assert.strictEqual(m.get(34), undefined);
});

test('differences: resolves to characters, dropping names we do not know', () => {
  const m = differencesMap([128, 'Euro', 'germandbls', 'uni20AC', 'g42', 'notarealglyph']);
  assert.strictEqual(m.get(128), '€');
  assert.strictEqual(m.get(129), 'ß');
  assert.strictEqual(m.get(130), '€');
  assert.strictEqual(m.get(131), undefined, 'a glyph index is not a character');
  assert.strictEqual(m.get(132), undefined);
});

test('differences: an off-by-one here shifts a whole font, so nulls do not shift', () => {
  const m = parseDifferences([65, 'A', null, 'C']);
  assert.strictEqual(m.get(65), 'A');
  assert.strictEqual(m.get(67), 'C');
});

test('glyph names: algorithmic forms and the classic table', () => {
  assert.strictEqual(glyphNameToUnicode('uni00E4'), 0xe4);
  assert.strictEqual(glyphNameToUnicode('u1F600'), 0x1f600);
  assert.strictEqual(glyphNameToUnicode('adieresis'), 0xe4);
  assert.strictEqual(glyphNameToUnicode('one.oldstyle'), 0x31);
  assert.strictEqual(glyphNameToUnicode('cid1348'), 0);
  assert.strictEqual(glyphNameToUnicode(''), 0);
});

test('sfnt: a non-font buffer yields an empty map instead of throwing', () => {
  assert.strictEqual(reverseGlyphMap(Buffer.from('not a font at all')).size, 0);
  assert.strictEqual(reverseGlyphMap(Buffer.alloc(0)).size, 0);
});

test('ActualText decodes UTF-16BE with a BOM', () => {
  assert.strictEqual(decodePdfText({ __hex: 'FEFF002D' }), '-');
  assert.strictEqual(decodePdfText({ __str: 'plain' }), 'plain');
  assert.strictEqual(decodePdfText(null), null);
});
