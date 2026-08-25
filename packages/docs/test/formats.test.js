'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractAttachment } = require('../src/index');
const { sniff } = require('../src/sniff');
const { extractCsv, sniffDelimiter, parseDelimited } = require('../src/csv');
const { extractXlsx } = require('../src/xlsx');
const { htmlTables, htmlToText, decodeText } = require('../src/plain');
const { makeXlsx, zipOf } = require('./mkpdf');

const opts = { ocr: false };

test('sniff trusts bytes over the declared type', () => {
  // The Zapier failure mode in the research: the signature image gets picked
  // because the label says so. A magic number cannot lie.
  const pdf = Buffer.from('%PDF-1.4\n...');
  assert.strictEqual(sniff(pdf, 'invoice.png', 'image/png').kind, 'pdf');
  assert.strictEqual(sniff(pdf, 'invoice.png', 'image/png').via, 'magic');
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n')]);
  assert.strictEqual(sniff(png, 'invoice.pdf', 'application/pdf').kind, 'image');
});

test('sniff separates xlsx, docx and a plain zip', () => {
  assert.strictEqual(sniff(makeXlsx([{ name: 'S', rows: [['a']] }]), 'b.xlsx', null).kind, 'spreadsheet');
  assert.strictEqual(sniff(zipOf([['word/document.xml', '<w:document/>']]), 'x.bin', null).kind, 'docx');
  assert.strictEqual(sniff(zipOf([['readme.txt', 'hi']]), 'x.zip', null).kind, 'archive');
});

test('sniff recognises a nested message', () => {
  const eml = Buffer.from('From: a@b.c\r\nTo: d@e.f\r\nSubject: hi\r\nDate: now\r\n\r\nbody\r\n');
  assert.strictEqual(sniff(eml, 'fwd.eml', null).kind, 'message');
  assert.strictEqual(sniff(eml, 'x.bin', 'message/rfc822').kind, 'message');
});

test('csv: the delimiter is sniffed, not assumed', () => {
  assert.strictEqual(sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.strictEqual(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.strictEqual(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  // The one that matters: a German export uses ';' *because* ',' is decimal.
  assert.strictEqual(sniffDelimiter('Artikel;Menge;Betrag\nSchraube;3;1.180,50'), ';');
});

test('csv: a German decimal survives extraction verbatim', () => {
  // "a german 1.180,50 coming out as 1180.50" is a 1000x error recorded in the
  // research. We never reformat a number; coercion is the parser's job.
  const { tables } = extractCsv('Artikel;Menge;Betrag\nSchraube;3;1.180,50\nMutter;10;4,50');
  assert.strictEqual(tables[0].records[0].Betrag, '1.180,50');
  assert.strictEqual(tables[0].row_count, 2);
});

test('csv: quoted fields keep their delimiters and newlines', () => {
  const { rows } = parseDelimited('a,b\n"Smith, John","line1\nline2"\n');
  assert.deepStrictEqual(rows[1], ['Smith, John', 'line1\nline2']);
});

test('csv: doubled quotes are one quote', () => {
  const { rows } = parseDelimited('a\n"He said ""hi"""\n');
  assert.strictEqual(rows[1][0], 'He said "hi"');
});

test('xlsx: sheets become tables with the CONTRACT shape', () => {
  const buf = makeXlsx([
    { name: 'Items', rows: [['Item', 'Qty', 'Amount'], ['Widget', 3, '27.00'], ['Bolt', 10, '4.50']] },
    { name: 'Notes', rows: [['Note', 'By'], ['Reviewed', 'AB'], ['Signed', 'CD']] },
  ]);
  const r = extractXlsx(buf);
  assert.strictEqual(r.tables.length, 2);
  assert.deepStrictEqual(r.tables[0].headers, ['Item', 'Qty', 'Amount']);
  assert.deepStrictEqual(r.tables[0].records[1], { Item: 'Bolt', Qty: '10', Amount: '4.50' });
  assert.strictEqual(r.tables[1].sheet, 'Notes');
});

test('xlsx: a gap in the middle of a row does not shift the columns', () => {
  // Excel omits empty cells entirely; the cell reference is the only truth.
  const buf = makeXlsx([{ name: 'S', rows: [['A', 'B', 'C'], ['1', '', '3'], ['4', '5', '6']] }]);
  const r = extractXlsx(buf);
  assert.deepStrictEqual(r.tables[0].rows[0], ['1', '', '3']);
  assert.strictEqual(r.tables[0].records[0].C, '3');
});

test('html: nested layout tables do not break the real one', () => {
  // Modern ESP mail nests tables several deep; a non-greedy regex closes on the
  // wrong tag every time that happens.
  const html = `<table><tr><td><table><tr><td>spacer</td></tr></table></td></tr></table>
    <table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widget</td><td>3</td></tr>
    <tr><td>Bolt</td><td>10</td></tr></table>`;
  const tables = htmlTables(html);
  const real = tables.find((t) => t.headers.includes('Item'));
  assert.ok(real, JSON.stringify(tables.map((t) => t.headers)));
  assert.strictEqual(real.row_count, 2);
  assert.strictEqual(real.records[1].Qty, '10');
});

test('html: entities and block tags render as readable text', () => {
  const text = htmlToText('<p>Total:&nbsp;&euro;1.180,50</p><p>Due&nbsp;soon</p>');
  assert.ok(text.includes('€1.180,50'), text);
  assert.strictEqual(text.split('\n').filter((l) => l.trim()).length, 2);
});

test('charset: cp1252 bytes are not left as mojibake', () => {
  // n8n's IMAP node turning a right quote into "â€™" is an open defect there
  // and a promise in our CONTRACT.
  const bytes = Buffer.from([0x49, 0x74, 0x92, 0x73, 0x20, 0x80, 0x35]);   // It’s €5
  const { text, charset } = decodeText(bytes, null);
  assert.strictEqual(text, 'It’s €5');
  assert.strictEqual(charset, 'windows-1252');
});

test('charset: a UTF-8 BOM is consumed, not emitted', () => {
  const { text } = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Grüße', 'utf8')]));
  assert.strictEqual(text, 'Grüße');
});

test('end to end: csv attachment', async () => {
  const r = await extractAttachment({ buffer: Buffer.from('Item,Qty\nWidget,3\n'), filename: 'a.csv' }, opts);
  assert.strictEqual(r.kind, 'csv');
  assert.strictEqual(r.tables[0].row_count, 1);
  assert.strictEqual(r.meta.extractor, 'csv');
  assert.strictEqual(r.meta.ocr, false);
  assert.strictEqual(r.pages, null);
});

test('end to end: an .eml attachment is handed back, not re-parsed here', async () => {
  const eml = Buffer.from('From: a@b.c\r\nTo: d@e.f\r\nSubject: fwd\r\nDate: x\r\n\r\ninner body\r\n');
  const r = await extractAttachment({ buffer: eml, filename: 'orig.eml', contentType: 'message/rfc822' }, opts);
  assert.strictEqual(r.kind, 'message');
  assert.ok(r.text.includes('inner body'));
  assert.ok(r.meta.warnings.includes('nested_message'));
});

test('end to end: docx text and tables', async () => {
  const doc = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Invoice 2291</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Widget</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>27.00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>';
  const r = await extractAttachment({ buffer: zipOf([['word/document.xml', doc]]), filename: 'a.docx' }, opts);
  assert.strictEqual(r.kind, 'docx');
  assert.ok(r.text.includes('Invoice 2291'));
  assert.strictEqual(r.tables[0].records[0].Amount, '27.00');
});

test('end to end: an unknown binary is labelled, not guessed at', async () => {
  const r = await extractAttachment({ buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), filename: 'x.bin' }, opts);
  assert.strictEqual(r.kind, 'unsupported');
  assert.ok(r.meta.warnings.some((w) => w.startsWith('unsupported_type:')), JSON.stringify(r.meta.warnings));
});
