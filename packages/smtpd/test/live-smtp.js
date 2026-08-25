'use strict';
// A REAL SMTP conversation over a real TCP socket against a real listener.
//
//   node test/live-smtp.js
//
// Starts the smtpd on an ephemeral high port with a stand-in API behind it,
// then drives it with the hand-written client in helpers.js and prints the
// complete wire transcript. Exits non-zero if anything in the conversation
// does not go as it should.

const assert = require('node:assert');
const crypto = require('node:crypto');
const { startStack, SmtpClient } = require('./helpers');

const CHECKS = [];
function check(name, fn) { CHECKS.push({ name, fn }); }

function multipartMessage() {
  const boundary = '----=_MailMintLive_' + crypto.randomBytes(8).toString('hex');
  // A small but genuine PDF, so the attachment is a real file and not a blob.
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 50]/Contents 4 0 R' +
    '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 62>>stream\nBT /F1 12 Tf 10 20 Td (Invoice INV-2291 total $31.50) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const b64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');

  return [
    'Message-ID: <live-' + crypto.randomBytes(6).toString('hex') + '@client.example.org>',
    'Date: Tue, 25 Aug 2026 09:14:01 +0000',
    'From: "Acme Billing" <billing@acme.com>',
    'To: <k7m2xq4h9bwz@parse.example.com>',
    'Subject: Invoice INV-2291 from Acme Ltd',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    'This is a multi-part message in MIME format.',
    '--' + boundary,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Hallo Florian,',
    '',
    'anbei die Rechnung über 31,50 €. Zahlbar bis 08.09.2026.',
    '',
    '.a line that begins with a dot, to prove dot-stuffing round-trips',
    '..two dots as well',
    '',
    'Total: $31.50',
    '',
    '--' + boundary,
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

/** Apply RFC 5321 §4.5.2 transparency, as any real client must. */
function stuff(message) {
  return message.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function main() {
  const stack = await startStack({
    mailboxes: ['k7m2xq4h9bwz@parse.example.com'],
    env: { MAX_MESSAGE_BYTES: '26214400' },
  });
  console.log(`# smtpd listening on 127.0.0.1:${stack.port}`);
  console.log(`# fake API at ${stack.api.url}`);
  console.log(`# spool at ${stack.spoolDir}`);
  console.log('');

  const c = new SmtpClient({ port: stack.port, trace: true });
  let failures = 0;
  try {
    await c.connect();

    c.note('--- banner and capability negotiation ---');
    let r = await c.read();
    assert.strictEqual(r.code, 220, 'expected a 220 banner');

    r = await c.cmd('EHLO client.example.org');
    assert.strictEqual(r.code, 250);
    const caps = r.lines.map((l) => l.slice(4).toUpperCase());
    for (const want of ['8BITMIME', 'SMTPUTF8', 'PIPELINING', 'ENHANCEDSTATUSCODES', 'CHUNKING']) {
      assert.ok(caps.includes(want), `EHLO should advertise ${want}`);
    }
    assert.ok(caps.some((l) => l.startsWith('SIZE 26214400')), 'EHLO should advertise SIZE 26214400');
    assert.ok(!caps.includes('STARTTLS'), 'STARTTLS must not be advertised without a certificate');

    c.note('--- NOOP / HELP / VRFY ---');
    assert.strictEqual((await c.cmd('NOOP')).code, 250);
    assert.strictEqual((await c.cmd('HELP')).code, 214);
    assert.strictEqual((await c.cmd('VRFY postmaster')).code, 252);

    c.note('--- an unknown recipient is refused at RCPT, never bounced later ---');
    assert.strictEqual((await c.cmd('MAIL FROM:<billing@acme.com>')).code, 250);
    r = await c.cmd('RCPT TO:<nosuchmailbox@parse.example.com>');
    assert.strictEqual(r.code, 550);
    assert.ok(/5\.1\.1/.test(r.lines[0]), 'expected enhanced code 5.1.1');
    r = await c.cmd('RCPT TO:<k7m2xq4h9bwz@elsewhere.com>');
    assert.strictEqual(r.code, 550);
    assert.ok(/5\.7\.1/.test(r.lines[0]), 'relaying should be 5.7.1');
    assert.strictEqual((await c.cmd('RSET')).code, 250);

    c.note('--- pipelined MAIL+RCPT+DATA, one write, three replies ---');
    await c.write(
      'MAIL FROM:<billing@acme.com> SIZE=4096 BODY=8BITMIME\r\n' +
      'RCPT TO:<Invoices.K7M2XQ4H9BWZ+september@parse.example.com>\r\n' +
      'DATA\r\n');
    const rMail = await c.read();
    const rRcpt = await c.read();
    const rData = await c.read();
    assert.strictEqual(rMail.code, 250);
    assert.strictEqual(rRcpt.code, 250, 'slug.TOKEN+tag must route, case-insensitively');
    assert.strictEqual(rData.code, 354);

    c.note('--- the message body, deliberately split mid-terminator across two TCP writes ---');
    const message = multipartMessage();
    const stuffed = stuff(message);
    const onWire = Buffer.from(stuffed + (stuffed.endsWith('\r\n') ? '' : '\r\n') + '.\r\n', 'utf8');
    // Split so that the <CRLF>.<CRLF> terminator itself straddles two TCP writes:
    // the first write ends with "\r\n." and the second carries only "\r\n".
    const splitAt = onWire.length - 2;
    await c.write(onWire.subarray(0, splitAt), { silent: true });
    c.note(`wrote ${splitAt} bytes, ending ${JSON.stringify(onWire.subarray(splitAt - 4, splitAt).toString('utf8'))}`);
    await new Promise((res) => setTimeout(res, 120));
    await c.write(onWire.subarray(splitAt), { silent: true });
    c.note(`wrote the remaining ${onWire.length - splitAt} bytes ${JSON.stringify(onWire.subarray(splitAt).toString('utf8'))} - the terminator is split across the two writes`);

    r = await c.read();
    assert.strictEqual(r.code, 250, 'the message should be accepted');

    c.note('--- a second message in the same session, via CHUNKING/BDAT ---');
    assert.strictEqual((await c.cmd('MAIL FROM:<noreply@acme.com>')).code, 250);
    assert.strictEqual((await c.cmd('RCPT TO:<k7m2xq4h9bwz@parse.example.com>')).code, 250);
    const bdatBody = Buffer.from(
      'Subject: sent with BDAT\r\nFrom: <noreply@acme.com>\r\n' +
      'To: <k7m2xq4h9bwz@parse.example.com>\r\n\r\n' +
      'chunk one.\r\n', 'utf8');
    const bdatBody2 = Buffer.from('chunk two, and a .dotted line that is NOT stuffed here.\r\n', 'utf8');
    await c.write(`BDAT ${bdatBody.length}\r\n`);
    await c.write(bdatBody, { silent: true });
    r = await c.read();
    assert.strictEqual(r.code, 250);
    await c.write(`BDAT ${bdatBody2.length} LAST\r\n`);
    await c.write(bdatBody2, { silent: true });
    r = await c.read();
    assert.strictEqual(r.code, 250);

    c.note('--- QUIT ---');
    r = await c.cmd('QUIT');
    assert.strictEqual(r.code, 221);
    c.end();

    // ---- what actually arrived at the API -------------------------------
    await new Promise((res) => setTimeout(res, 200));
    console.log('');
    console.log('# ---------------- what the API received ----------------');
    assert.strictEqual(stack.api.delivered.length, 2, 'two messages should have been delivered');

    const first = stack.api.delivered[0];
    console.log('# envelope:', JSON.stringify(first.envelope));
    console.log('# recipients:', JSON.stringify(first.recipients.map((x) => ({
      address: x.address, token: x.token, slug: x.slug, tag: x.tag,
    }))));
    console.log('# auth:', JSON.stringify(first.auth));
    console.log('# size on the wire:', first.size, 'bytes');

    const raw = first.raw_mime.toString('utf8');
    console.log('# --- first 12 lines of the stored message ---');
    console.log(raw.split('\r\n').slice(0, 12).map((l) => '#   ' + l).join('\n'));

    check('Received: header prepended', () => assert.ok(/^Received: from client\.example\.org /.test(raw)));
    check('Received names our host', () => assert.ok(raw.includes('by mx-test.mailmint.local with ESMTP id ')));
    check('Authentication-Results stamped', () => assert.ok(/\r\nAuthentication-Results: mx-test\.mailmint\.local/.test(raw)));
    check('Return-Path stamped', () => assert.ok(raw.includes('\r\nReturn-Path: <billing@acme.com>\r\n')));
    check('envelope.from', () => assert.strictEqual(first.envelope.from, 'billing@acme.com'));
    check('envelope.helo', () => assert.strictEqual(first.envelope.helo, 'client.example.org'));
    check('envelope.tls false on a plain session', () => assert.strictEqual(first.envelope.tls, false));
    check('token extracted from slug.TOKEN+tag', () => assert.strictEqual(first.recipients[0].token, 'k7m2xq4h9bwz'));
    check('slug preserved', () => assert.strictEqual(first.recipients[0].slug, 'invoices'));
    check('tag preserved', () => assert.strictEqual(first.recipients[0].tag, 'september'));
    check('dot-unstuffing: the leading-dot line came back with one dot', () =>
      assert.ok(raw.includes('\r\n.a line that begins with a dot')));
    check('dot-unstuffing: the two-dot line came back with two dots', () =>
      assert.ok(raw.includes('\r\n..two dots as well')));
    check('8-bit body survived byte-for-byte', () =>
      assert.ok(first.raw_mime.includes(Buffer.from('31,50 \u20ac', 'utf8'))));
    check('body ends with the closing MIME boundary', () =>
      assert.ok(/--\r\n$/.test(raw)));
    check('the stored message is our trace headers + the original bytes, unchanged', () => {
      const original = Buffer.from(message, 'utf8');
      assert.ok(first.raw_mime.subarray(first.raw_mime.length - original.length).equals(original),
        'body round-trip is not byte-identical');
    });
    check('attachment intact: PDF header present', () =>
      assert.ok(Buffer.from(raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0]
        .replace(/\r\n/g, ''), 'base64').toString('latin1').startsWith('%PDF-1.4')));
    check('BDAT message delivered', () =>
      assert.ok(stack.api.delivered[1].raw_mime.toString('utf8').includes('chunk one.\r\nchunk two,')));
    check('BDAT data is not dot-unstuffed', () =>
      assert.ok(stack.api.delivered[1].raw_mime.toString('utf8').includes('a .dotted line')));
    check('spool drained: nothing left behind', () =>
      assert.strictEqual(stack.spool.sizeSync(), 0));

    console.log('');
    console.log('# ---------------- assertions ----------------');
    for (const { name, fn } of CHECKS) {
      try { fn(); console.log(`#   PASS  ${name}`); }
      catch (e) { failures++; console.log(`#   FAIL  ${name}: ${e.message}`); }
    }
  } catch (e) {
    failures++;
    console.error('\n# CONVERSATION FAILED:', e.message);
    console.error(e.stack);
  } finally {
    c.destroy();
    await stack.close();
  }

  console.log('');
  console.log(failures === 0
    ? '# RESULT: live SMTP conversation OK'
    : `# RESULT: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
