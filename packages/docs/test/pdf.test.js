'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractAttachment } = require('../src/index');
const { extractPdf } = require('../src/pdf');
const { pdfDate } = require('../src/pdf');
const { resolveLimits } = require('../src/limits');
const { repairPdf } = require('../src/repair');
const { PdfDoc } = require('../src/pdfobj');
const { simplePdf, buildPdf, streamObj } = require('./mkpdf');
const { realInvoices, REAL_LABELS } = require('./corpus');

const opts = { ocr: false };

/** "$1,199.00" / "€1.199,00" -> "1199.00", so a label is currency-agnostic. */
function amount(cell) {
  const m = /([\d][\d.,\s']*)/.exec(String(cell || ''));
  if (!m) return null;
  let s = m[1].replace(/[\s']/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  const dec = Math.max(lastDot, lastComma);
  if (dec >= 0 && s.length - dec - 1 <= 2 && s.length - dec - 1 > 0) {
    s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  } else s = s.replace(/[.,]/g, '');
  return s;
}

test('a one-page PDF yields text, a page count and no OCR', async () => {
  const pdf = simplePdf([{ x: 50, y: 100, text: 'Invoice INV-2291' }, { x: 50, y: 130, text: 'Total 31.50' }]);
  const r = await extractAttachment({ buffer: pdf, filename: 'a.pdf' }, opts);
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.pages, 1);
  assert.ok(r.text.includes('INV-2291'));
  assert.strictEqual(r.meta.ocr, false);
  assert.strictEqual(r.meta.extractor, 'pdfjs+layout');
});

test('AcroForm values are read, and an unticked box is not a value', async () => {
  const pdf = simplePdf([{ x: 50, y: 100, text: 'see form' }], {
    acroFields: [
      { name: 'invoice_no', value: 'INV-2291' },
      { name: 'total', value: '31.50' },
      { name: 'agreed', type: 'Btn', value: null },
    ],
  });
  const r = await extractAttachment({ buffer: pdf, filename: 'form.pdf' }, opts);
  assert.deepStrictEqual(r.fields, { invoice_no: 'INV-2291', total: '31.50' });
  assert.strictEqual(r.meta.form_fields, 2);
});

test('page rotation is normalised, so a sideways page still reads left to right', async () => {
  // The real shape of a rotated page: the content is drawn turned in content
  // space and /Rotate puts it upright. Extracting without applying the page
  // rotation gives you a column of one-character "lines".
  const tm = [0, 1, -1, 0];
  const turned = simplePdf([
    { x: 100, y: 742, text: 'LEFT', tm },
    { x: 100, y: 400, text: 'RIGHT', tm },
  ], { rotate: 90 });
  const r = await extractAttachment({ buffer: turned, filename: 'landscape.pdf' }, opts);
  const line = r.text.split('\n').find((l) => l.includes('LEFT'));
  assert.ok(line, `LEFT not found in:\n${JSON.stringify(r.text)}`);
  assert.ok(line.includes('RIGHT'), `rotation split one row in two:\n${JSON.stringify(r.text)}`);
  assert.ok(line.indexOf('LEFT') < line.indexOf('RIGHT'));
  assert.ok(!r.meta.warnings.some((w) => w.startsWith('rotated_runs_skipped')),
    'upright-after-rotation text must not be discarded as angled');
});

test('a multi-page PDF is separated by form feeds and counted', async () => {
  const bodies = [];
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = '<< /Type /Pages /Kids [5 0 R 6 0 R 7 0 R] /Count 3 >>';
  bodies[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  bodies[3] = streamObj('', 'BT /F1 12 Tf 1 0 0 1 50 700 Tm (PAGE ONE) Tj ET');
  for (let i = 0; i < 3; i++) {
    bodies[4 + i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>';
  }
  const r = await extractAttachment({ buffer: buildPdf(bodies), filename: 'm.pdf' }, opts);
  assert.strictEqual(r.pages, 3);
  assert.strictEqual(r.text.split('\f').length, 3);
  assert.strictEqual(r.meta.pages_read, 3);
});

test('a page cap is honoured and declared', async () => {
  const bodies = [];
  const kids = [];
  for (let i = 0; i < 6; i++) kids.push(`${5 + i} 0 R`);
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 6 >>`;
  bodies[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  bodies[3] = streamObj('', 'BT /F1 12 Tf 1 0 0 1 50 700 Tm (X) Tj ET');
  for (let i = 0; i < 6; i++) {
    bodies[4 + i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>';
  }
  const r = await extractAttachment({ buffer: buildPdf(bodies), filename: 'm.pdf' },
    { ...opts, limits: { maxPdfPages: 2 } });
  assert.strictEqual(r.pages, 6, 'the real page count is still reported');
  assert.strictEqual(r.meta.pages_read, 2);
  assert.ok(r.meta.warnings.some((w) => w.startsWith('page_limit:')), JSON.stringify(r.meta.warnings));
});

test('a PDF with no text layer is flagged rather than returned as empty success', async () => {
  const blank = simplePdf([]);
  const r = await extractAttachment({ buffer: blank, filename: 'scan.pdf' }, opts);
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(r.meta.warnings.includes('pdf_no_text_layer'));
  assert.ok(r.meta.warnings.includes('ocr_disabled'));
});

test('a truncated PDF does not throw', async () => {
  const pdf = simplePdf([{ x: 50, y: 100, text: 'hello' }]);
  const r = await extractAttachment({ buffer: pdf.subarray(0, Math.floor(pdf.length / 2)), filename: 'broken.pdf' }, opts);
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(Array.isArray(r.meta.warnings));
});

test('pdfDate parses the PDF date syntax and refuses to guess', () => {
  assert.strictEqual(pdfDate("D:20260825081424+00'00'"), '2026-08-25T08:14:24.000Z');
  assert.strictEqual(pdfDate('D:20260825'), '2026-08-25T00:00:00.000Z');
  assert.strictEqual(pdfDate('nonsense'), null);
});

test('the object reader survives a wrong /Length', () => {
  const body = streamObj('/Type /Whatever', 'STREAMBODY');
  const bad = Buffer.from(body.toString('latin1').replace(/\/Length \d+/, '/Length 99999'), 'latin1');
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', bad];
  const doc = new PdfDoc(buildPdf(bodies));
  assert.strictEqual(doc.streamData(3).toString('latin1'), 'STREAMBODY');
});

test('repairPdf leaves a healthy PDF byte-identical', () => {
  const pdf = simplePdf([{ x: 50, y: 100, text: 'clean' }]);
  const r = repairPdf(pdf);
  assert.ok(r.buffer.equals(pdf));
  assert.strictEqual(r.repairs.length, 0);
});

/* ------------------------------------------------------------------------ */
/* Real documents. Skipped, not failed, when .local/ is not present — the     */
/* files carry a real address and phone number and are gitignored on purpose. */
/* ------------------------------------------------------------------------ */

const invoices = realInvoices();

test('real Stripe invoices: every line item, in every currency', { skip: invoices.length ? false : 'no .local/realmail' }, async () => {
  assert.strictEqual(invoices.length, 3, 'expected three real invoice mails');
  for (const inv of invoices) {
    const r = await extractAttachment({ buffer: inv.buffer, filename: inv.filename, contentType: 'application/pdf' }, opts);
    const id = (/Invoice number\s+(\S+)/.exec(r.text) || [])[1];
    const label = REAL_LABELS[id];
    assert.ok(label, `unrecognised invoice ${id} in ${inv.filename}`);

    const t = r.tables.find((x) => x.headers.includes('Description'));
    assert.ok(t, `no line-item table for ${id}: ${JSON.stringify(r.tables.map((x) => x.headers))}`);
    assert.strictEqual(t.row_count, label.rows.length, `row count for ${id}`);
    assert.strictEqual(t.truncated, false);

    label.rows.forEach((want, i) => {
      assert.strictEqual(t.rows[i][0], want[0], `${id} row ${i} description`);
      assert.strictEqual(t.rows[i][1], want[1], `${id} row ${i} qty`);
      assert.strictEqual(amount(t.rows[i][2]), want[2], `${id} row ${i} unit price`);
      assert.strictEqual(amount(t.rows[i][3]), want[3], `${id} row ${i} amount`);
    });

    // The totals block must be OUT of records and available separately.
    assert.ok(t.totals && t.totals.length, `${id} lost its totals`);
    const total = t.totals.find((x) => /^total$/i.test(x.label));
    assert.ok(total && amount(total.value) === label.total, `${id} total: ${JSON.stringify(t.totals)}`);
    for (const row of t.rows) {
      assert.ok(!/^(sub)?total|amount due/i.test(row[0]), `${id} swallowed a totals row: ${row[0]}`);
    }
  }
});

test('real invoices: the U+0000 ToUnicode defect is repaired', { skip: invoices.length ? false : 'no .local/realmail' }, async () => {
  // Stock pdf.js emits U+0000 here because the file literally says U+0000.
  for (const inv of invoices) {
    const r = await extractAttachment({ buffer: inv.buffer, filename: inv.filename }, opts);
    assert.ok(!r.text.includes(' '), `${inv.filename} still contains U+0000`);
    assert.ok(/Invoice number\s+IZ0P5L7Q-\d{4}/.test(r.text),
      `hyphen not recovered in ${inv.filename}: ${r.text.slice(0, 200)}`);
    assert.ok(r.meta.glyph_repairs > 0, 'the repair should have reported what it did');
  }
});

test('real invoices: accented and non-ASCII characters survive', { skip: invoices.length ? false : 'no .local/realmail' }, async () => {
  const texts = [];
  for (const inv of invoices) {
    const r = await extractAttachment({ buffer: inv.buffer, filename: inv.filename }, opts);
    texts.push(r.text);
  }
  const all = texts.join('\n');
  assert.ok(all.includes('ß'), 'German sharp s lost');
  assert.ok(all.includes('€') && all.includes('£') && all.includes('$'), 'a currency symbol was lost');
  assert.ok(!all.includes('�'), 'replacement characters present');
});
