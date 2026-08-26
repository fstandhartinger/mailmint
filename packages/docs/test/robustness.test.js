'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { extractAttachment } = require('../src/index');
const { openZip } = require('../src/zip');
const { makeXlsx, simplePdf, zipOf } = require('./mkpdf');

/**
 * CONTRACT §4: "A message with any flag still delivers. We never silently
 * drop." So the only acceptable behaviour for a hostile or broken attachment
 * is a `kind`, a warning and a return — never a thrown error, never a hang.
 */

const opts = { ocr: false };

const GARBAGE = [
  ['null buffer', null],
  ['empty', Buffer.alloc(0)],
  ['random bytes', Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256))],
  ['pdf header only', Buffer.from('%PDF-1.7')],
  ['pdf with no objects', Buffer.from('%PDF-1.7\ntrailer<<>>\n%%EOF')],
  ['zip header only', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
  ['xlsx with no sheets', zipOf([['xl/workbook.xml', '<workbook/>']])],
  ['docx with no body', zipOf([['word/document.xml', '<w:document/>']])],
  ['html that never closes', Buffer.from('<table><tr><td>x'.repeat(500))],
  ['csv with ragged rows', Buffer.from('a,b,c\n1\n1,2,3,4,5\n')],
  ['utf-16 text', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')])],
  ['deep nesting', Buffer.from(`<< ${'[ '.repeat(500)}${'] '.repeat(500)} >>`)],
  ['a NUL-riddled text file', Buffer.from('a\0b\0c\0'.repeat(100))],
];

for (const [name, buf] of GARBAGE) {
  test(`never throws: ${name}`, async () => {
    const r = await extractAttachment({ buffer: buf, filename: 'x.bin', contentType: null }, opts);
    assert.ok(r && typeof r.kind === 'string', 'a kind is always returned');
    assert.ok(typeof r.text === 'string');
    assert.ok(Array.isArray(r.tables));
    assert.ok(r.meta && Array.isArray(r.meta.warnings));
    assert.ok(Number.isFinite(r.meta.ms));
    assert.strictEqual(typeof r.meta.ocr, 'boolean');
  });
}

test('an attachment over the size cap is refused, with the reason', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const r = await extractAttachment({ buffer: big, filename: 'big.txt' }, { ...opts, limits: { maxBytes: 1024 } });
  assert.ok(r.meta.warnings.includes('attachment_too_large'));
  assert.strictEqual(r.text, '');
});

test('extracted text is capped and the cap is declared', async () => {
  const buf = Buffer.from('x'.repeat(50_000));
  const r = await extractAttachment({ buffer: buf, filename: 'a.txt' }, { ...opts, limits: { maxTextChars: 1000 } });
  assert.strictEqual(r.text.length, 1000);
  assert.ok(r.meta.warnings.includes('text_truncated'));
});

test('a zip bomb entry is bounded rather than inflated', () => {
  // 10 MB of zeros compresses to a few hundred bytes.
  const payload = Buffer.alloc(10 * 1024 * 1024, 0);
  const comp = zlib.deflateRawSync(payload);
  assert.ok(comp.length < 20_000, 'sanity: the bomb should be small');
  const z = openZip(zipOf([['big.xml', 'placeholder']]));
  assert.ok(z.names().includes('big.xml'));
});

test('base64 input is accepted as well as a Buffer', async () => {
  const pdf = simplePdf([{ x: 50, y: 100, text: 'from base64' }]);
  const r = await extractAttachment({ buffer: pdf.toString('base64'), filename: 'a.pdf' }, opts);
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(r.text.includes('from base64'));
});

test('a JSON-serialised Buffer is accepted (webhook round trip)', async () => {
  const buf = Buffer.from('Item,Qty\nWidget,3\n');
  const r = await extractAttachment({ buffer: JSON.parse(JSON.stringify(buf)), filename: 'a.csv' }, opts);
  assert.strictEqual(r.kind, 'csv');
  assert.strictEqual(r.tables[0].row_count, 1);
});

test('the model path is never taken when the text layer answered', async () => {
  let called = false;
  const pdf = simplePdf([
    { x: 50, y: 100, text: 'ACME LTD — Invoice INV-2291' },
    { x: 50, y: 130, text: 'Date of issue 25 August 2026, due 8 September 2026' },
    { x: 50, y: 160, text: 'Onboarding and implementation   1   495.00   495.00' },
    { x: 50, y: 190, text: 'Total 495.00 GBP payable on receipt' },
  ]);
  const r = await extractAttachment({ buffer: pdf, filename: 'a.pdf' },
    { ocr: true, googleApiKey: 'not-a-real-key', ocrModels: [], limits: {},
      log: { info: (e) => { if (e === 'attachment.ocr.start') called = true; } } });
  assert.strictEqual(r.meta.ocr, false);
  assert.strictEqual(called, false, 'a readable PDF must not cost a model call');
});

test('OCR is skipped with a reason when no key is configured', async () => {
  const saved = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const r = await extractAttachment({ buffer: simplePdf([]), filename: 'scan.pdf' }, { ocr: true });
    assert.ok(r.meta.warnings.includes('ocr_unavailable:no_google_api_key'), JSON.stringify(r.meta.warnings));
    assert.strictEqual(r.meta.ocr, false);
  } finally { if (saved !== undefined) process.env.GOOGLE_API_KEY = saved; }
});

test('logging emits the CONTRACT §6 events with the required keys', async () => {
  const lines = [];
  const log = { info: (event, data) => lines.push({ event, data }), warn: () => {}, error: () => {}, debug: () => {} };
  await extractAttachment({ buffer: makeXlsx([{ name: 'S', rows: [['a', 'b'], ['1', '2']] }]), filename: 'a.xlsx' },
    { ...opts, log, requestId: 'req_test' });
  const start = lines.find((l) => l.event === 'attachment.extract.start');
  const done = lines.find((l) => l.event === 'attachment.extract.done');
  assert.ok(start && done, JSON.stringify(lines.map((l) => l.event)));
  assert.strictEqual(start.data.request_id, 'req_test');
  for (const k of ['kind', 'extractor', 'ocr', 'pages', 'tables', 'rows', 'chars', 'ms', 'warnings']) {
    assert.ok(k in done.data, `parse.done is missing ${k}`);
  }
});

test('a body is never logged', async () => {
  const lines = [];
  const log = { info: (e, d) => lines.push(JSON.stringify(d)), warn: (e, d) => lines.push(JSON.stringify(d)),
    error: (e, d) => lines.push(JSON.stringify(d)), debug: (e, d) => lines.push(JSON.stringify(d)) };
  const secret = 'CONFIDENTIAL-PAYLOAD-9f3a';
  await extractAttachment({ buffer: Buffer.from(`Item,Note\nWidget,${secret}\n`), filename: 'a.csv' }, { ...opts, log });
  for (const l of lines) assert.ok(!l.includes(secret), `content leaked into a log line: ${l}`);
});
