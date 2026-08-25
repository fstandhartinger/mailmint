'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseMime } = require('../src/index');
const { parseStructure, buildHeaders, splitMultipart } = require('../src/mime');
const { decodeWords } = require('../src/rfc2047');
const { decodeBuffer } = require('../src/charset');
const { decodeQuotedPrintable, decodeBase64 } = require('../src/transfer');
const { parseParameters, parseAddressList, parseDate, normaliseAddress } = require('../src/headers');

const CORPUS = path.join(__dirname, 'corpus');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-structure.json'), 'utf8'));
const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.eml')).sort();

test('corpus is large enough to be meaningful', () => {
  assert.ok(files.length >= 30, `expected >= 30 corpus files, found ${files.length}`);
  assert.ok(files.filter((f) => f.startsWith('real-')).length >= 15, 'expected real mailing-list messages');
});

test('every corpus message parses without throwing', () => {
  for (const f of files) {
    const buf = fs.readFileSync(path.join(CORPUS, f));
    assert.doesNotThrow(() => parseMime(buf), f);
  }
});

test('headers match an independent parser (python email.policy.default)', () => {
  for (const f of files) {
    const exp = EXPECTED[f];
    if (!exp) continue;
    const m = parseMime(fs.readFileSync(path.join(CORPUS, f)));
    assert.strictEqual(m.headers.subject, exp.subject, `subject of ${f}`);
    if (exp.from) {
      assert.strictEqual(m.headers.from && m.headers.from.email, exp.from.email, `from.email of ${f}`);
      assert.strictEqual(m.headers.from && m.headers.from.name, exp.from.name, `from.name of ${f}`);
    }
    if (exp.date) assert.strictEqual(m.headers.date, exp.date, `date of ${f}`);
    assert.strictEqual(m.headers.message_id, exp.message_id === null ? null : (exp.message_id || '').trim() || null, `message_id of ${f}`);
  }
});

test('attachments match the independent parser', () => {
  for (const f of files) {
    const exp = EXPECTED[f];
    if (!exp) continue;
    const m = parseMime(fs.readFileSync(path.join(CORPUS, f)));
    assert.strictEqual(m.attachments.length, exp.attachments.length, `attachment count of ${f}`);
    exp.attachments.forEach((a, i) => {
      assert.strictEqual(m.attachments[i].content_type, a.content_type, `att ${i} type of ${f}`);
      // text/* payloads: the reference parser normalises CRLF, we keep the
      // bytes as sent, so compare with line endings normalised on both sides.
      if (/^text\//.test(a.content_type)) {
        const ours = Buffer.from(m.attachments[i].content_base64, 'base64').toString('latin1').replace(/\r/g, '').length;
        assert.strictEqual(ours, a.size, `att ${i} size (text) of ${f}`);
      } else {
        assert.strictEqual(m.attachments[i].size, a.size, `att ${i} size of ${f}`);
      }
      if (a.filename) assert.strictEqual(m.attachments[i].filename, a.filename, `att ${i} filename of ${f}`);
    });
  }
});

test('a body is recovered whenever the source has one', () => {
  for (const f of files) {
    const exp = EXPECTED[f];
    if (!exp || (!exp.has_text && !exp.has_html)) continue;
    const m = parseMime(fs.readFileSync(path.join(CORPUS, f)));
    assert.ok((m.body.text && m.body.text.length) || (m.body.html && m.body.html.length), `no body for ${f}`);
    if (exp.has_html) assert.ok(m.body.html, `html missing for ${f}`);
  }
});

test('RFC2047: B and Q, both charsets, split multibyte, adjacent words', () => {
  assert.strictEqual(decodeWords('=?iso-8859-1?Q?P=E9rez?='), 'Pérez');
  assert.strictEqual(decodeWords('=?utf-8?q?Rechnung_f=C3=BCr_M=C3=A4rz?='), 'Rechnung für März');
  assert.strictEqual(decodeWords('=?UTF-8?B?5pel?= =?UTF-8?B?5pys?='), '日本');
  // one multi-byte character split across two encoded words
  assert.strictEqual(decodeWords('=?utf-8?B?4Zy=?= =?utf-8?B?jA==?='), 'ᜌ');
  assert.strictEqual(decodeWords('plain'), 'plain');
  assert.strictEqual(decodeWords('a =?utf-8?B?Yg==?= c'), 'a b c');
});

test('charset conversion covers the legacy encodings without iconv', () => {
  assert.strictEqual(decodeBuffer(Buffer.from([0x50, 0xE9, 0x72, 0x65, 0x7A]), 'iso-8859-1'), 'Pérez');
  assert.strictEqual(decodeBuffer(Buffer.from([0x93, 0xFA, 0x96, 0x7B]), 'shift_jis'), '日本');
  assert.strictEqual(decodeBuffer(Buffer.from('日本', 'utf8'), 'utf-8'), '日本');
  assert.strictEqual(decodeBuffer(Buffer.from([0x93]), 'windows-1252'), '“');
  // declared utf-8 that is not valid utf-8 falls back rather than mojibake-ing
  assert.strictEqual(decodeBuffer(Buffer.from([0xE9]), 'utf-8'), 'é');
});

test('quoted-printable: soft breaks, literal =, trailing whitespace, CRLF kept', () => {
  const out = decodeQuotedPrintable(Buffer.from('Gr=C3=BC=C3=9Fe=\r\n von Fl=\nori  \r\nx=3Dy a=Zb\r\n', 'latin1'));
  assert.strictEqual(out.toString('utf8'), 'Grüße von Flori\r\nx=y a=Zb\r\n');
});

test('base64 tolerates line wrapping and stray characters', () => {
  assert.strictEqual(decodeBase64(Buffer.from('SGVsbG8g\r\nV29ybGQ=')).toString(), 'Hello World');
});

test('RFC2231 filenames: continuation, extended, both, plus RFC2047 in a filename', () => {
  assert.strictEqual(parseParameters("attachment; filename*0*=utf-8''Rechnung%20; filename*1*=M%C3%A4rz.pdf").params.filename, 'Rechnung März.pdf');
  assert.strictEqual(parseParameters("attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf").params.filename, '日本.pdf');
  assert.strictEqual(parseParameters('inline; filename*0="long"; filename*1="name.txt"').params.filename, 'longname.txt');
  assert.strictEqual(parseParameters('attachment; filename="=?utf-8?B?5pel5pysLnBkZg==?="').params.filename, '日本.pdf');
});

test('address parsing keeps the local part case (RFC 5321 2.3.11)', () => {
  const one = parseAddressList('Sandbox as a Service <invoice+statements+acct_1RTNh0CozVR51Oga@STRIPE.com>');
  assert.deepStrictEqual(one, [{ name: 'Sandbox as a Service', email: 'invoice+statements+acct_1RTNh0CozVR51Oga@stripe.com' }]);
  assert.strictEqual(normaliseAddress('Mixed.Case@EXAMPLE.COM'), 'Mixed.Case@example.com');
});

test('address lists: quoted names with commas, groups, bare addresses, comments', () => {
  assert.deepStrictEqual(parseAddressList('"Doe, John" <j@d.com>, bare@x.org, Jane (the boss) <jane@y.io>'), [
    { name: 'Doe, John', email: 'j@d.com' },
    { name: null, email: 'bare@x.org' },
    { name: 'Jane (the boss)', email: 'jane@y.io' },
  ]);
});

test('date parsing handles obsolete zones and comments', () => {
  assert.strictEqual(parseDate('Sat, 19 Jul 2025 09:33:13 +0300'), '2025-07-19T06:33:13.000Z');
  assert.strictEqual(parseDate('Thu, 24 Jul 2025 03:02:15 -0400 (EDT)'), '2025-07-24T07:02:15.000Z');
  assert.strictEqual(parseDate('19 Jul 25 09:33 GMT'), '2025-07-19T09:33:00.000Z');
  assert.strictEqual(parseDate('not a date'), null);
});

test('multipart splitting tolerates missing terminator and trailing whitespace', () => {
  const body = Buffer.from('preamble\r\n--b  \r\nA\r\n--b\r\nB\r\n', 'latin1');
  const parts = splitMultipart(body, 'b').map((p) => p.toString());
  assert.deepStrictEqual(parts, ['A', 'B\r\n']);
});

test('a multipart whose boundary never appears still yields its body', () => {
  const m = parseMime(fs.readFileSync(path.join(CORPUS, 'fx-15-broken-boundary.eml')));
  assert.match(m.body.text, /Invoice number: BRK-0001/);
  assert.ok(m.warnings.some((w) => /boundary/.test(w)));
});

test('a delimiter with no CRLF after it (real Stripe via SES) still splits', () => {
  const raw = Buffer.from([
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="--==_x"',
    '',
    '----==_xContent-Type: text/plain',
    '',
    'hello',
    '----==_x',
    'Content-Type: text/html',
    '',
    '<p>hi</p>',
    '----==_x--',
    '',
  ].join('\r\n'), 'latin1');
  const m = parseMime(raw);
  assert.match(m.body.text, /hello/);
  assert.match(m.body.html, /<p>hi<\/p>/);
});

test('nested multipart with an RFC2231 filename', () => {
  const m = parseMime(fs.readFileSync(path.join(CORPUS, 'fx-16-nested-rfc2231.eml')));
  assert.strictEqual(m.attachments.length, 1);
  assert.strictEqual(m.attachments[0].filename, 'Quartalsabschluss März-Juni.pdf');
  assert.match(m.body.text, /ST-2026-Q2/);
});

test('inline image keeps its content-id and inline flag', () => {
  const m = parseMime(fs.readFileSync(path.join(CORPUS, 'fx-12-shipping-related-inline.eml')));
  const img = m.attachments.find((a) => a.content_type === 'image/png');
  assert.ok(img);
  assert.strictEqual(img.inline, true);
  assert.strictEqual(img.content_id, 'logo.brightloom@shipping');
});

test('hidden preheaders and tracking pixels are not body text', () => {
  const m = parseMime(fs.readFileSync(path.join(CORPUS, 'fx-01-stripe-receipt.eml')));
  assert.ok(!/Your receipt for \$82\.08/.test(m.body.text_from_html), 'preheader leaked into text');
  assert.match(m.body.text_from_html, /Receipt from Northwind Analytics/);
});

test('parseMime is pure: same input, same output', () => {
  const buf = fs.readFileSync(path.join(CORPUS, 'fx-05-invoice-pdf-attachment.eml'));
  const a = parseMime(buf); const b = parseMime(buf);
  assert.deepStrictEqual(JSON.stringify(a.headers), JSON.stringify(b.headers));
  assert.deepStrictEqual(JSON.stringify(a.tables), JSON.stringify(b.tables));
});
