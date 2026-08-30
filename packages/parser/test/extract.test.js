'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseMime, parseMessage, evidenceIsReal } = require('../src/index');
const { strippedText } = require('../src/strip');
const { findAmounts, parseNumber } = require('../src/numbers');
const { findDates, toIsoDate } = require('../src/dates');
const { findIds, findPhones, detectType, findEmails } = require('../src/detect');
const { extractTextTables } = require('../src/tables');
const { extractHtmlTables, extractRepeatTables, htmlToText } = require('../src/html');
const { coerce } = require('../src/coerce');
const { computeConfidence, sameValue, reconcile } = require('../src/confidence');
const { fromText } = require('../src/lineitems');
const { extractJson } = require('../src/extract-llm');

const CORPUS = path.join(__dirname, 'corpus');
const read = (f) => fs.readFileSync(path.join(CORPUS, f));

// ---------------------------------------------------------------- stripping
test('quoted reply chains are removed, in several languages', () => {
  const en = strippedText('New text.\n\nOn Mon, Aug 4, 2026 at 10:12 AM Bob <b@x.com> wrote:\n> old\n> older');
  assert.strictEqual(en.text, 'New text.');
  assert.ok(en.quoteRemoved);

  const de = strippedText('Neuer Text.\n\nAm 04.08.2026 um 10:12 schrieb Klaus <k@x.de>:\n> alt');
  assert.strictEqual(de.text, 'Neuer Text.');

  const fr = strippedText('Nouveau.\n\nLe 4 août 2026 à 10:12, Marc <m@x.fr> a écrit :\n> ancien');
  assert.strictEqual(fr.text, 'Nouveau.');

  const orig = strippedText('Body.\n\n-----Original Message-----\nFrom: x\nold');
  assert.strictEqual(orig.text, 'Body.');

  const outlook = strippedText('Update.\n\nFrom: Jane <j@x.com>\nSent: Monday\nTo: me\nSubject: RE: thing\n\nold');
  assert.strictEqual(outlook.text, 'Update.');

  const fwd = strippedText('See below.\n\n---------- Forwarded message ---------\nFrom: x\nold');
  assert.strictEqual(fwd.text, 'See below.');
});

test('signatures are removed by delimiter and by heuristic', () => {
  assert.strictEqual(strippedText('Note.\n\n-- \nSig Line\nCompany GmbH').text, 'Note.');
  assert.strictEqual(strippedText('Note.\n\nBest regards,\nAnna\nTel.: +49 89 1').text, 'Note.');
  assert.strictEqual(strippedText('Note.\n\nMit freundlichen Grüßen\nAnna Muster').text, 'Note.');
  assert.strictEqual(strippedText('Note.\n\nSent from my iPhone').text, 'Note.');
});

test('stripping never empties a message that had content', () => {
  const only = strippedText('Best regards,\nAnna');
  assert.ok(only.text.length > 0);
  const quoted = strippedText('> everything is quoted\n> really');
  assert.ok(quoted.text.length > 0);
});

test('a reply chain does not leak last week\'s invoice into this week\'s fields', () => {
  const m = parseMime(read('fx-08-reply-chain-invoice.eml'));
  assert.match(m.body.stripped_text, /INV-77213/);
  assert.ok(!/INV-77211/.test(m.body.stripped_text), 'quoted invoice number survived stripping');
  assert.ok(!/1,980\.00/.test(m.body.stripped_text));
});

// ---------------------------------------------------------------- amounts
test('amounts across locales, symbols, codes and accounting negatives', () => {
  const got = findAmounts("Total $1,234.56 / 1.234,56 € / EUR 31.50 / -$5.00 / ($12.00) / CHF 1’234.50 / 99 USD / £12 / 1 234,50 € / 45,00 EUR- / ¥12,800 / 31,50EUR");
  const pairs = got.map((a) => `${a.value}${a.currency}`);
  for (const want of ['1234.56USD', '1234.56EUR', '31.5EUR', '-5USD', '-12USD', '1234.5CHF', '99USD', '12GBP', '1234.5EUR', '-45EUR', '12800JPY']) {
    assert.ok(pairs.includes(want), `missing ${want} in ${pairs.join(',')}`);
  }
});

test('a currency code in an aligned column belongs to the number on its left', () => {
  const got = findAmounts('2  Zusatzlizenz        4        74,50 EUR     298,00 EUR');
  assert.deepStrictEqual(got.map((a) => a.value), [74.5, 298]);
});

test('Qty 1 $495.00 is one item at 495, not one dollar', () => {
  assert.deepStrictEqual(findAmounts('Qty 1 $495.00').map((a) => a.value), [495]);
});

test('number parsing picks the decimal separator from the shape, not a locale', () => {
  assert.strictEqual(parseNumber('1,234.56'), 1234.56);
  assert.strictEqual(parseNumber('1.234,56'), 1234.56);
  assert.strictEqual(parseNumber('1 234,50'), 1234.5);
  assert.strictEqual(parseNumber('31,50'), 31.5);
  assert.strictEqual(parseNumber('1,234'), 1234);
  assert.strictEqual(parseNumber('not a number'), null);
});

// ---------------------------------------------------------------- dates
test('dates in the four shapes the brief calls out', () => {
  const d = findDates('Due Sep 8, 2026. Issued 2026-08-25. Also 8. September 2026 and 25/12/2026.');
  const vals = d.map((x) => x.value);
  assert.ok(vals.includes('2026-09-08'));
  assert.ok(vals.includes('2026-08-25'));
  assert.ok(vals.includes('2026-12-25'));
});

test('an ambiguous numeric date is resolved from other dates in the document', () => {
  const ctx = findDates('Ship 03/04/2026, order 25/12/2025', { locale: 'x.com' });
  assert.strictEqual(ctx[0].value, '2026-04-03');        // day-first, learned from 25/12
  assert.ok(ctx[0].ambiguous);
});

test('an ambiguous date with no context uses the sender TLD and lowers confidence', () => {
  const us = findDates('Invoice date 08/09/2026', { locale: 'acme.com' })[0];
  assert.ok(us.confidence <= 0.6, 'unresolvable ambiguity must not claim high confidence');
  const de = findDates('Rechnungsdatum 08.09.2026', { locale: 'acme.de' })[0];
  assert.strictEqual(de.value, '2026-09-08');
  assert.ok(de.confidence > us.confidence);
});

test('German long-form and ISO both normalise', () => {
  assert.strictEqual(toIsoDate('8. September 2026'), '2026-09-08');
  assert.strictEqual(toIsoDate('2026-09-08'), '2026-09-08');
  assert.strictEqual(toIsoDate('September 8, 2026'), '2026-09-08');
});

// ---------------------------------------------------------------- ids, phones, type
test('identifiers are found by label and never capture the next English word', () => {
  const ids = findIds('Invoice illustration follows. Invoice #IZ0P5L7Q-0065. Order number: SO-1.');
  assert.ok(!ids.some((i) => i.value === 'illustration'), 'captured a word as an id');
  assert.ok(ids.some((i) => i.kind === 'invoice_number' && i.value === 'IZ0P5L7Q-0065'));
});

test('carrier tracking shapes are recognised without a label', () => {
  assert.ok(findIds('Your parcel 1Z999AA10123456784 is on its way').some((i) => i.kind === 'tracking_number'));
});

test('phone detection does not swallow amounts, dates or order numbers', () => {
  assert.deepStrictEqual(findPhones('Tel: +1 555 123 4567'), ['+1 555 123 4567']);
  assert.deepStrictEqual(findPhones('Total $1,234.56 on 08/09/2026'), []);
});

test('email detection preserves the local part case', () => {
  assert.deepStrictEqual(findEmails('Write to Mixed.Case@EXAMPLE.COM'), ['Mixed.Case@example.com']);
});

test('document type detection over the corpus', () => {
  const want = {
    'fx-01-stripe-receipt.eml': 'receipt', 'fx-02-order-confirmation.eml': 'order',
    'fx-03-dhl-versand-latin1.eml': 'shipping', 'fx-04-rechnung-plaintext.eml': 'invoice',
    'fx-06-contact-form.eml': 'form', 'fx-07-calendar-invite.eml': 'calendar',
    'fx-12-shipping-related-inline.eml': 'shipping', 'fx-13-facture-francaise.eml': 'invoice',
    'fx-17-ride-receipt-de.eml': 'receipt',
  };
  for (const [f, type] of Object.entries(want)) {
    const m = parseMime(read(f));
    const got = detectType({ subject: m.headers.subject, text: m.body.stripped_text || m.body.text,
      attachments: m.attachments, ids: [], tables: m.tables, amounts: findAmounts(m.body.text) });
    assert.strictEqual(got, type, `${f} detected as ${got}`);
  }
});

// ---------------------------------------------------------------- tables
test('whitespace-aligned plain-text tables', () => {
  const t = extractTextTables('Item              Qty   Unit price   Amount\nBlue Widget         3       $9.00      $27.00\nRed Gadget          1       $4.50       $4.50');
  assert.strictEqual(t.length, 1);
  assert.deepStrictEqual(t[0].headers, ['Item', 'Qty', 'Unit price', 'Amount']);
  assert.strictEqual(t[0].records[0].Amount, '$27.00');
  assert.strictEqual(t[0].row_count, 2);
});

test('pipe-delimited plain-text tables', () => {
  const t = extractTextTables('| Product | Qty | Price |\n|---|---|---|\n| Kaffee | 2 | 8,00 EUR |\n| Tee | 1 | 3,50 EUR |');
  assert.deepStrictEqual(t[0].records, [
    { Product: 'Kaffee', Qty: '2', Price: '8,00 EUR' },
    { Product: 'Tee', Qty: '1', Price: '3,50 EUR' },
  ]);
});

test('prose with a wide gap is not mistaken for a table', () => {
  assert.strictEqual(extractTextTables('Hello there,\n\nThis is a paragraph  with a gap.\nAnother line here.\nAnd a third.').length, 0);
});

test('html tables: headers zipped with rows into records', () => {
  const t = extractHtmlTables('<table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody><tr><td>Widget &amp; Co</td><td>3</td><td>$27.00</td></tr></tbody></table>');
  assert.deepStrictEqual(t[0].records, [{ Item: 'Widget & Co', Qty: '3', Amount: '$27.00' }]);
});

test('a table with more than two columns survives (where Make breaks)', () => {
  const m = parseMime(read('fx-14-html-only-invoice.eml'));
  const t = m.tables.find((x) => x.headers.includes('Description') && x.headers.includes('Qty'));
  assert.ok(t, 'four-column invoice table not found');
  assert.strictEqual(t.headers.length, 4);
  assert.strictEqual(t.row_count, 3);
});

test('variable row counts come out complete: 1, 40 and 520 rows', () => {
  for (const [f, n] of [['fx-21-table-1-row.eml', 1], ['fx-19-table-40-rows.eml', 40], ['fx-20-table-520-rows.eml', 520]]) {
    const m = parseMime(read(f));
    const t = m.tables.filter((x) => x.headers.includes('Description')).sort((a, b) => b.row_count - a.row_count)[0];
    assert.ok(t, `${f}: no line-item table`);
    assert.strictEqual(t.row_count, n, `${f}: got ${t.row_count} rows, wanted ${n}`);
    assert.strictEqual(t.records.length, n);
    assert.strictEqual(t.truncated, false);
  }
});

test('repeating HTML structure finds line items that are not in a grid', () => {
  const html = ['<div>',
    ...[['Alpha', '$10.00'], ['Beta', '$20.00'], ['Gamma', '$30.00']].map(([d, a]) =>
      `<table><tr><td></td><td><span>${d}</span></td><td></td><td><span>${a}</span></td><td></td></tr></table>`),
    '</div>'].join('');
  const t = extractRepeatTables(html, 0);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].row_count, 3);
  assert.ok(t[0].headers.includes('Amount'));
});

// ---------------------------------------------------------------- line items
test('line items from the text/plain run, anchored by arithmetic', () => {
  const r = fromText('Invoice #A-1 Widget Qty 1 $10.00 Gadget Qty 2 $20.00 Sprocket Qty 1 $5.00 Total due $35.00 Amount paid $0.00');
  assert.strictEqual(r.rows.length, 3);
  assert.ok(r.anchored, 'the run summing to the stated total was not recognised');
  assert.deepStrictEqual(r.rows.map((x) => x.description), ['Widget', 'Gadget', 'Sprocket']);
  assert.deepStrictEqual(r.rows.map((x) => x.amount), [10, 20, 5]);
});

// ---------------------------------------------------------------- coercion
test('coercion per contract section 2', () => {
  const t = (v, f) => coerce(v, f, {});
  assert.deepStrictEqual(t('$1,234.56', { type: 'number' }), { ok: true, value: 1234.56 });
  assert.deepStrictEqual(t('1.234,56 EUR', { type: 'currency' }), { ok: true, value: { amount: 1234.56, currency: 'EUR' } });
  assert.deepStrictEqual(t('Sep 8, 2026', { type: 'date' }), { ok: true, value: '2026-09-08' });
  assert.deepStrictEqual(t('2026-09-08 15:30', { type: 'datetime' }), { ok: true, value: '2026-09-08T15:30:00.000Z' });
  assert.deepStrictEqual(t('yes', { type: 'boolean' }), { ok: true, value: true });
  assert.deepStrictEqual(t('www.x.com/a', { type: 'url' }), { ok: true, value: 'https://www.x.com/a' });
  assert.deepStrictEqual(t('paid', { type: 'enum', options: ['paid', 'open'] }), { ok: true, value: 'paid' });
  assert.strictEqual(t('nope', { type: 'enum', options: ['paid', 'open'] }).ok, false);
  assert.strictEqual(t('not a number', { type: 'number' }).ok, false);
  // the contract forbids inventing a placeholder
  assert.deepStrictEqual(t('N/A', { type: 'string' }), { ok: true, value: null });
  assert.deepStrictEqual(t('unknown', { type: 'string' }), { ok: true, value: null });
});

test('array of object coerces each element', () => {
  const f = { type: 'array', items: { type: 'object', fields: [{ name: 'description', type: 'string' }, { name: 'amount', type: 'number' }] } };
  assert.deepStrictEqual(coerce([{ description: 'Widget', amount: '27.00' }], f, {}),
    { ok: true, value: [{ description: 'Widget', amount: 27 }] });
});

// ---------------------------------------------------------------- confidence
test('confidence is computed, and the model may only lower it', () => {
  assert.strictEqual(computeConfidence({ source: 'llm', evidenceGiven: true, evidenceOk: true, corroborated: true, modelConfidence: 0.99 }).confidence, 0.93);
  assert.strictEqual(computeConfidence({ source: 'llm', evidenceGiven: true, evidenceOk: true, modelConfidence: 0.4 }).confidence, 0.4);
  const hall = computeConfidence({ source: 'llm', evidenceGiven: true, evidenceOk: false, modelConfidence: 0.99 });
  assert.ok(hall.confidence <= 0.3);
  assert.ok(hall.flags.includes('hallucinated_evidence'));
});

test('sameValue compares meaning, not surface form (no false disagreements)', () => {
  const { coerce: c } = require('../src/coerce');
  const norm = (v, f) => { const r = c(v, f, {}); return r.ok && r.value !== null ? (typeof r.value === 'string' ? r.value.toLowerCase() : r.value) : v; };
  const pairs = [
    ['September 8, 2026', '2026-09-08', { type: 'date' }],
    ['8. September 2026', '2026-09-08', { type: 'date' }],
    ['$854.00', 854, { type: 'currency' }],
    ['1.234,56 €', { amount: 1234.56, currency: 'EUR' }, { type: 'currency' }],
    ['USD', 'usd', { type: 'string' }],
  ];
  for (const [a, b, f] of pairs) {
    assert.ok(sameValue(norm(a, f), norm(b, f)), `${JSON.stringify(a)} vs ${JSON.stringify(b)} reported a disagreement`);
  }
  // a genuine day/month transposition MUST be caught
  assert.ok(!sameValue(norm('2026-09-08', { type: 'date' }), norm('2026-08-09', { type: 'date' })));
});

test('arithmetic reconciliation catches a dropped line item', () => {
  const schema = [{ name: 'line_items' }, { name: 'total' }];
  assert.strictEqual(reconcile({ line_items: [{ amount: 495 }, { amount: 297 }, { amount: 62 }], total: { amount: 854 } }, schema).ok, true);
  const bad = reconcile({ line_items: [{ amount: 495 }], total: { amount: 854 } }, schema);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.detail, /line_items_sum/);
});

test('the line-item money column may be called any name the column mapper accepts', () => {
  // Regression. reconcile() read `row.amount ?? row.total` and nothing else,
  // while mapColumns accepted `price`, `betrag`, `line total` and six more. A
  // schema using any of those summed to zero, never reconciled, and put
  // `arithmetic_mismatch` + needs_review on EVERY message.
  const schema = [{ name: 'line_items' }, { name: 'subtotal' }];
  for (const key of ['amount', 'total', 'line_total', 'price', 'preis', 'betrag', 'value', 'charge', 'montant']) {
    const rows = [{ description: 'a', unit_price: 27, [key]: 54 }, { description: 'b', unit_price: 6.5, [key]: 6.5 }];
    const r = reconcile({ line_items: rows, subtotal: 60.5 }, schema);
    assert.strictEqual(r.ok, true, `${key} should reconcile`);
    assert.strictEqual(r.checked, true, `${key} should actually be checked`);
  }
});

test('a per-unit rate is never mistaken for the line total', () => {
  const schema = [{ name: 'line_items' }, { name: 'subtotal' }];
  // Only unit prices in the rows: there is no line total to sum, so the check
  // must decline to run rather than report the message as inconsistent.
  const r = reconcile({ line_items: [{ description: 'a', unit_price: 27 }, { description: 'b', einzelpreis: 6.5 }], subtotal: 60.5 }, schema);
  assert.strictEqual(r.checked, false);
  assert.strictEqual(r.ok, true);
});

test('rows with no readable amount blame nobody', () => {
  const schema = [{ name: 'line_items' }, { name: 'subtotal' }];
  const r = reconcile({ line_items: [{ description: 'a', qty: 2 }, { description: 'b', qty: 1 }], subtotal: 60.5 }, schema);
  assert.strictEqual(r.checked, false, 'an unreadable row set is not evidence of a bad message');
  assert.strictEqual(r.ok, true);
});

test('the total equation is only checked when an adjustment term was extracted', () => {
  // subtotal and total differ only by a tax we were not asked to extract
  const r = reconcile({ subtotal: 1280, total: { amount: 1523.2 } }, [{ name: 'subtotal' }, { name: 'total' }]);
  assert.strictEqual(r.ok, true);
});

test('the evidence check actually runs', () => {
  const hay = 'total due $854.00 for invoice iz0p5l7q-0065';
  assert.strictEqual(evidenceIsReal('Total due $854.00', hay), true);
  assert.strictEqual(evidenceIsReal('Total   due   $854.00', hay), true);   // whitespace-normalised
  assert.strictEqual(evidenceIsReal('Total due $999.00', hay), false);
});

// ---------------------------------------------------------------- llm plumbing
test('model replies survive fences, prose and trailing commas', () => {
  assert.deepStrictEqual(extractJson('Sure! ```json\n{"fields":{"a":{"value":1}}}\n```\nHope that helps.'), { fields: { a: { value: 1 } } });
  assert.deepStrictEqual(extractJson('{"fields":{"a":{"value":"he said \\"hi\\""}}} trailing prose'), { fields: { a: { value: 'he said "hi"' } } });
  assert.deepStrictEqual(extractJson('{"fields":{"a":{"value":1,},},}'), { fields: { a: { value: 1 } } });
  assert.strictEqual(extractJson('nonsense'), null);
});

test('the MailMint model chain is ordered for this workload and excludes the fast-and-wrong model', () => {
  const { DEFAULT_CHAIN, MIN_TOKENS } = require('../src/extract-llm');
  assert.strictEqual(DEFAULT_CHAIN[0].model, 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE');
  assert.ok(!DEFAULT_CHAIN.some((e) => /Mistral-Nemo/i.test(e.model)));
  assert.ok(MIN_TOKENS >= 1024, 'contract section 7: never below 1024');
});

// ---------------------------------------------------------------- end to end
test('parseMessage never throws, whatever it is given', async () => {
  const junk = [Buffer.alloc(0), Buffer.from('not an email at all'), Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    'plain string', null, undefined, { subject: 'x' }, { text: null, html: null },
    Buffer.from('Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n')];
  for (const j of junk) {
    const r = await parseMessage(j, { schema: [{ name: 'total', type: 'currency', required: true }], llm: false });
    assert.ok(r && r.parse && r.fields, `no result for ${JSON.stringify(j)}`);
    assert.ok(Array.isArray(r.flags));
    assert.strictEqual(typeof r.needs_review, 'boolean');
  }
});

test('an empty schema flags no_schema and still returns detections', async () => {
  const r = await parseMessage(read('fx-04-rechnung-plaintext.eml'), { llm: false });
  assert.ok(r.flags.includes('no_schema'));
  assert.deepStrictEqual(r.fields, {});
  assert.strictEqual(r.detected.type, 'invoice');
  assert.ok(r.detected.amounts.length > 0);
});

test('the result carries every section of contract section 1', async () => {
  const r = await parseMessage(read('fx-05-invoice-pdf-attachment.eml'), {
    schema: [{ name: 'invoice_number', type: 'string', required: true }], llm: false, schemaVersion: 3,
  });
  for (const k of ['received_at', 'headers', 'body', 'attachments', 'auth', 'tables', 'detected', 'fields', 'flags', 'needs_review', 'parse']) {
    assert.ok(k in r, `missing ${k}`);
  }
  for (const k of ['text', 'html', 'text_from_html', 'stripped_text', 'language']) assert.ok(k in r.body, `body.${k}`);
  for (const k of ['request_id', 'schema_version', 'model', 'llm_used', 'timings_ms', 'warnings']) assert.ok(k in r.parse, `parse.${k}`);
  assert.strictEqual(r.parse.schema_version, 3);
  assert.strictEqual(r.parse.llm_used, false);
  assert.deepStrictEqual(r.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam_score: null });
  const f = r.fields.invoice_number;
  assert.deepStrictEqual(Object.keys(f).sort(), ['confidence', 'evidence', 'source', 'value']);
});

test('required fields that are absent are flagged and set needs_review', async () => {
  const r = await parseMessage(read('fx-06-contact-form.eml'), {
    schema: [{ name: 'invoice_number', type: 'string', required: true }], llm: false,
  });
  assert.ok(r.flags.includes('missing_required:invoice_number'));
  assert.strictEqual(r.needs_review, true);
  assert.strictEqual(r.fields.invoice_number.value, null);
  assert.strictEqual(r.fields.invoice_number.source, 'none');
});

test('a type error nulls the value, zeroes confidence and flags', async () => {
  const r = await parseMessage({ subject: 'x', text: 'Total: not-a-number-at-all' }, {
    schema: [{ name: 'total', type: 'number' }], llm: false,
  });
  assert.strictEqual(r.fields.total.value, null);
  assert.strictEqual(r.fields.total.confidence, 0);
});

test('structured logs carry ts, level, request_id and event', async () => {
  const lines = [];
  const log = { debug: (e, d) => lines.push(['debug', e, d]), info: (e, d) => lines.push(['info', e, d]),
    warn: (e, d) => lines.push(['warn', e, d]), error: (e, d) => lines.push(['error', e, d]) };
  const r = await parseMessage(read('fx-01-stripe-receipt.eml'), { schema: [{ name: 'total', type: 'currency' }], llm: false, log, requestId: 'req_test' });
  const events = lines.map((l) => l[1]);
  assert.ok(events.includes('parse.start'));
  assert.ok(events.includes('parse.done'));
  assert.ok(events.includes('parse.stage'));
  const done = lines.find((l) => l[1] === 'parse.done')[2];
  assert.ok('timings_ms' in done && 'flags' in done && 'mean_confidence' in done);
  assert.strictEqual(r.parse.request_id, 'req_test');
});

test('parse.failed is logged with the input sha256 when everything breaks', async () => {
  const lines = [];
  const log = { debug() {}, info() {}, warn() {}, error: (e, d) => lines.push([e, d]) };
  const boom = { get subject() { throw new Error('boom'); } };
  const r = await parseMessage(boom, { schema: [{ name: 'a', type: 'string', required: true }], llm: false, log });
  assert.ok(lines.some((l) => l[0] === 'parse.failed'));
  assert.ok(lines.find((l) => l[0] === 'parse.failed')[1].input_sha256.length === 64);
  assert.ok(r.parse.warnings.length > 0);
  assert.strictEqual(r.needs_review, true);
});

// -------------------------------------------- quoted vs. own document number
test('a number the message only quotes is marked, not adopted as its own', () => {
  const ids = findIds('Credit note CN-3390 against invoice INV-9921');
  const inv = ids.find((i) => i.kind === 'invoice_number');
  const cn = ids.find((i) => i.kind === 'credit_note_number');
  assert.strictEqual(inv.value, 'INV-9921');
  assert.ok(inv.referenced, 'INV-9921 sits behind "against" — it is the document being cancelled');
  assert.ok(inv.confidence < 0.9, 'a quoted id must not carry full confidence');
  assert.strictEqual(cn.value, 'CN-3390');
  assert.ok(!cn.referenced, "the credit note's own number is not a quotation");

  const de = findIds('Gutschrift Nr. 4900123456\nBezug: Rechnung 9100998877');
  assert.ok(de.find((i) => i.kind === 'invoice_number' && i.value === '9100998877').referenced);
  assert.strictEqual(de.find((i) => i.kind === 'credit_note_number').value, '4900123456');
});

test('an unquoted invoice number keeps full confidence', () => {
  const ids = findIds('Invoice INV-7781\nTotal: 120.00 EUR');
  const inv = ids.find((i) => i.kind === 'invoice_number');
  assert.strictEqual(inv.value, 'INV-7781');
  assert.ok(!inv.referenced);
  assert.strictEqual(inv.confidence, 0.9);
});

test('on a credit note, invoice_number reads the credit note, not the invoice it cancels', async () => {
  const raw = Buffer.from([
    'From: Vantage Media Ltd <accounts@vantagemedia.example>',
    'Subject: Credit note CN-3390 against invoice INV-9921',
    'Content-Type: text/plain', '',
    'Credit note CN-3390', 'Issued against invoice INV-9921.', 'Total: -525.00 USD', '',
  ].join('\n'));
  const out = await parseMessage(raw, { llm: false, schema: { fields: [{ name: 'invoice_number', type: 'string' }] } });
  assert.strictEqual(out.fields.invoice_number.value, 'CN-3390');
});

test('a quoted number is still answered when it is the only one, but not at 0.9', async () => {
  const raw = Buffer.from([
    'From: Ops <ops@x.example>', 'Subject: Payment reminder', 'Content-Type: text/plain', '',
    'Bezug: Rechnung 9100998877', 'Betrag: 100,00 EUR', '',
  ].join('\n'));
  const out = await parseMessage(raw, { llm: false, schema: { fields: [{ name: 'invoice_number', type: 'string' }] } });
  assert.strictEqual(out.fields.invoice_number.value, '9100998877');
  assert.ok(out.fields.invoice_number.confidence < 0.9,
    'the only candidate is a quotation — usable, but the model has to confirm it');
});

// --------------------------------------------- unanchored payment facts
/**
 * A message that nothing identifies as a document.
 *
 * The hold-out found this at 0.9+ three times: `$4.95` in a horoscope
 * newsletter came back as `total` and `USD`, and a domain-renewal notice gave
 * up its expiry date as `due_date`. Both extractors were reading the SAME lone
 * figure — layer (a) detects every number in any text, so a model value copied
 * out of the body is corroborated by construction. That is one sighting counted
 * twice, and >0.9 is sold as two independent ones.
 *
 * The model is stubbed rather than called: the point under test is what the
 * scorer does when the model AGREES, and a live model may or may not that day.
 */
function stubModel(fields) {
  return async () => ({ text: JSON.stringify({ fields }), model: 'stub', attempts: [] });
}

const MONEY_SCHEMA = [
  { name: 'total', type: 'number', description: 'the grand total payable' },
  { name: 'currency', type: 'string', description: 'ISO 4217 code' },
  { name: 'due_date', type: 'date', description: 'the date payment is due' },
];

test('a lone price in a message with no document context cannot reach 0.9', async () => {
  const mail = 'Subject: Your Daily Horoscope\n\nVenus is in retrograde. Get a One Month Forecast for only $4.95!\n';
  const out = await parseMessage(Buffer.from(mail), {
    schema: MONEY_SCHEMA,
    complete: stubModel({
      total: { value: 4.95, confidence: 0.95, evidence: 'a One Month Forecast for only $4.95!' },
      currency: { value: 'USD', confidence: 0.95, evidence: '$4.95' },
    }),
  });

  assert.strictEqual(out.detected.type, 'generic', 'nothing here says "document"');
  // The value is KEPT — silence would be a worse answer than a hedged one.
  assert.strictEqual(out.fields.total.value, 4.95);
  assert.ok(out.fields.total.confidence <= 0.85,
    `total must stay below the accept line, got ${out.fields.total.confidence}`);
  assert.ok(out.fields.currency.confidence <= 0.85,
    `currency must stay below the accept line, got ${out.fields.currency.confidence}`);
  assert.ok(out.flags.includes('no_document_context:total'),
    'the reason is published, not just the lower number');
});

test('a labelled total anchors the message, so its siblings keep their score', async () => {
  // The Portuguese invoice from the hold-out: no English type keyword, so the
  // detector calls it `generic` — but "Valor total:" is a real label, and once
  // one payment fact is read off a label the message IS a document.
  const mail = 'Subject: Fatura FT 2026/00417\n\nSegue em anexo a fatura FT 2026/00417.\n'
    + 'Valor total: 2.310,75 EUR\nData de vencimento: 06/09/2026\n';
  const out = await parseMessage(Buffer.from(mail), {
    schema: MONEY_SCHEMA,
    complete: stubModel({
      total: { value: 2310.75, confidence: 0.95, evidence: 'Valor total: 2.310,75 EUR' },
      currency: { value: 'EUR', confidence: 0.95, evidence: '2.310,75 EUR' },
    }),
  });

  assert.strictEqual(out.detected.type, 'generic', 'still no type keyword it knows');
  assert.ok(out.fields.total.confidence > 0.9,
    `a label-anchored total must keep its score, got ${out.fields.total.confidence}`);
  assert.ok(!out.flags.some((f) => f.startsWith('no_document_context')),
    'an anchored message is never treated as contextless');
});

test('the currency guess is unlabelled, so it may not anchor a message by itself', async () => {
  // `currency` falls back to "the first money symbol anywhere", with no label
  // behind it. Before it said so, that guess made the horoscope above look like
  // an anchored document and suppressed the cap on every other field in it.
  const { ruleExtract } = require('../src/rules');
  const out = ruleExtract({ name: 'currency', type: 'string' }, {
    searchable: 'only $4.95!', stripped: 'only $4.95!', text: 'only $4.95!', subject: '',
    headers: {}, tables: [], detected: { ids: [], amounts: [{ value: 4.95, currency: 'USD', raw: '$4.95' }] },
  });
  assert.strictEqual(out.value, 'USD', 'it still answers');
  assert.ok(out.unlabelled, 'and it declares that no label backed it');
});
