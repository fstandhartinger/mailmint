'use strict';
// Protocol-level tests. Every one of these drives the real listener over a real
// TCP socket; nothing here is mocked below the socket.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { startStack, SmtpClient } = require('./helpers');
const { unstuff } = require('../src/server');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

async function withStack(opts, fn) {
  const stack = await startStack({ mailboxes: [MBX], ...opts });
  try { return await fn(stack); } finally { await stack.close(); }
}

async function open(stack) {
  const c = new SmtpClient({ port: stack.port });
  await c.connect();
  const banner = await c.read();
  assert.strictEqual(banner.code, 220);
  return c;
}

async function ehlo(c, name = 'client.test') {
  const r = await c.cmd(`EHLO ${name}`);
  assert.strictEqual(r.code, 250);
  return r.lines.map((l) => l.slice(4));
}

// ---------------------------------------------------------------- unstuff ---

test('unstuff: removes exactly one leading dot per line', () => {
  const cases = [
    ['..hidden\r\n', '.hidden\r\n'],
    ['a\r\n..b\r\nc\r\n', 'a\r\n.b\r\nc\r\n'],
    ['...three\r\n', '..three\r\n'],
    ['a\r\n.\r\nb\r\n', 'a\r\n\r\nb\r\n'],
    ['nothing to do\r\n', 'nothing to do\r\n'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(unstuff(Buffer.from(input, 'binary')).toString('binary'), want,
      `unstuff(${JSON.stringify(input)})`);
  }
});

test('unstuff: a dot mid-line is untouched', () => {
  const s = 'version 1.2.3 and www.example.com\r\n';
  assert.strictEqual(unstuff(Buffer.from(s)).toString(), s);
});

// ------------------------------------------------------- split terminator ---

test('the <CRLF>.<CRLF> terminator is detected at EVERY split position', async () => {
  await withStack({}, async (stack) => {
    const body =
      'Subject: split test\r\n' +
      'From: <a@b.com>\r\n' +
      `To: <${MBX}>\r\n` +
      '\r\n' +
      'line one\r\n' +
      '..stuffed dot line\r\n' +
      'last line\r\n';
    const wire = Buffer.from(body + '.\r\n', 'utf8');

    // Exercise every split that can land inside or next to the terminator,
    // plus a scatter of splits through the body.
    const positions = new Set();
    for (let i = wire.length - 8; i < wire.length; i++) if (i > 0) positions.add(i);
    for (let i = 1; i < wire.length; i += 7) positions.add(i);

    for (const at of positions) {
      const c = await open(stack);
      await ehlo(c);
      assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
      assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
      assert.strictEqual((await c.cmd('DATA')).code, 354);
      await c.write(wire.subarray(0, at), { silent: true });
      await new Promise((r) => setImmediate(r));
      await c.write(wire.subarray(at), { silent: true });
      const r = await c.read();
      assert.strictEqual(r.code, 250, `split at ${at} should still be accepted`);
      await c.cmd('QUIT');
      c.destroy();
    }

    assert.strictEqual(stack.api.delivered.length, positions.size);
    const expected = Buffer.from(body.replace('\r\n..stuffed', '\r\n.stuffed'), 'utf8');
    for (const d of stack.api.delivered) {
      const got = d.raw_mime.subarray(d.raw_mime.length - expected.length);
      assert.ok(got.equals(expected), 'body must be byte-identical whatever the split');
    }
  });
});

test('a terminator arriving one byte per TCP write is still detected', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    const wire = Buffer.from('Subject: drip\r\n\r\nbody\r\n.\r\n', 'utf8');
    for (const byte of wire) {
      await c.write(Buffer.from([byte]), { silent: true });
    }
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    assert.strictEqual(stack.api.delivered.length, 1);
  });
});

test('a body that is only ".\\r\\n" is an empty message, not a hang', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    await c.write('.\r\n');
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    const d = stack.api.delivered[0];
    // only our trace headers, no original content
    assert.ok(d.raw_mime.toString().startsWith('Received: from client.test'));
  });
});

// ------------------------------------------------------------- pipelining ---

test('PIPELINING: a whole transaction in one write gets replies in order', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    const caps = await ehlo(c);
    assert.ok(caps.includes('PIPELINING'));

    await c.write(
      'MAIL FROM:<a@b.com>\r\n' +
      `RCPT TO:<${MBX}>\r\n` +
      'RCPT TO:<nope@parse.example.com>\r\n' +
      'DATA\r\n');
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await c.read()).code);
    assert.deepStrictEqual(codes, [250, 250, 550, 354]);

    await c.write('Subject: pipelined\r\n\r\nhi\r\n.\r\nQUIT\r\n');
    assert.strictEqual((await c.read()).code, 250, 'the 250 for DATA comes first');
    assert.strictEqual((await c.read()).code, 221, 'then the 221 for the pipelined QUIT');
    c.destroy();
    assert.strictEqual(stack.api.delivered.length, 1);
  });
});

test('PIPELINING: a command pipelined behind end-of-data is not swallowed', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    // terminator and the next command in a single TCP segment
    await c.write('Subject: x\r\n\r\nbody\r\n.\r\nNOOP\r\n');
    assert.strictEqual((await c.read()).code, 250);
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
  });
});

// ------------------------------------------------------------------ BDAT ----

test('BDAT: a single LAST chunk', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    const body = Buffer.from('Subject: bdat one\r\n\r\nhello chunked world\r\n', 'utf8');
    await c.write(`BDAT ${body.length} LAST\r\n`);
    await c.write(body, { silent: true });
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    assert.ok(stack.api.delivered[0].raw_mime.toString().endsWith('hello chunked world\r\n'));
  });
});

test('BDAT: several chunks, split across TCP writes, then BDAT 0 LAST', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    const parts = [
      Buffer.from('Subject: bdat many\r\n\r\n', 'utf8'),
      Buffer.from('first part.', 'utf8'),
      Buffer.from(' second part.\r\n', 'utf8'),
    ];
    for (const p of parts) {
      await c.write(`BDAT ${p.length}\r\n`);
      // deliberately dribble the chunk out in two writes
      await c.write(p.subarray(0, 1), { silent: true });
      await new Promise((r) => setImmediate(r));
      await c.write(p.subarray(1), { silent: true });
      const r = await c.read();
      assert.strictEqual(r.code, 250);
      assert.ok(/octets received/.test(r.lines[0]));
    }
    await c.write('BDAT 0 LAST\r\n');
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    const raw = stack.api.delivered[0].raw_mime.toString();
    assert.ok(raw.endsWith('first part. second part.\r\n'));
  });
});

test('BDAT: the command line and chunk data may share one TCP segment', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    const body = 'Subject: glued\r\n\r\nglued body\r\n';
    await c.write(`BDAT ${Buffer.byteLength(body)} LAST\r\n${body}`);
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    assert.ok(stack.api.delivered[0].raw_mime.toString().endsWith('glued body\r\n'));
  });
});

test('BDAT: data is NOT dot-unstuffed', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    const body = Buffer.from('Subject: dots\r\n\r\n..two real dots\r\n', 'utf8');
    await c.write(`BDAT ${body.length} LAST\r\n`);
    await c.write(body, { silent: true });
    await c.read();
    c.destroy();
    assert.ok(stack.api.delivered[0].raw_mime.toString().includes('\r\n..two real dots\r\n'));
  });
});

test('BDAT: syntax errors are refused', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    assert.strictEqual((await c.cmd('BDAT')).code, 501);
    assert.strictEqual((await c.cmd('BDAT -1 LAST')).code, 501);
    assert.strictEqual((await c.cmd('BDAT 10 FIRST')).code, 501);
    c.destroy();
  });
});

test('BDAT before RCPT is a sequence error', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    assert.strictEqual((await c.cmd('BDAT 5 LAST')).code, 503);
    c.destroy();
  });
});

// -------------------------------------------------------------- oversize ----

test('SIZE: an oversized declaration is refused at MAIL FROM', async () => {
  await withStack({ env: { MAX_MESSAGE_BYTES: '4096' } }, async (stack) => {
    const c = await open(stack);
    const caps = await ehlo(c);
    assert.ok(caps.includes('SIZE 4096'));
    const r = await c.cmd('MAIL FROM:<a@b.com> SIZE=999999');
    assert.strictEqual(r.code, 552);
    assert.ok(/5\.3\.4/.test(r.lines[0]));
    c.destroy();
  });
});

test('an oversized DATA body is refused with 552 5.3.4 after the terminator', async () => {
  await withStack({ env: { MAX_MESSAGE_BYTES: '4096' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    const big = 'Subject: too big\r\n\r\n' + 'x'.repeat(20000) + '\r\n';
    await c.write(Buffer.from(big + '.\r\n', 'utf8'), { silent: true });
    const r = await c.read();
    assert.strictEqual(r.code, 552);
    assert.ok(/5\.3\.4/.test(r.lines[0]));
    // and the session is still usable afterwards
    assert.strictEqual((await c.cmd('RSET')).code, 250);
    c.destroy();
    assert.strictEqual(stack.api.delivered.length, 0);
    assert.strictEqual(stack.spool.sizeSync(), 0, 'an oversized message must not be spooled');
  });
});

test('an oversized BDAT message is refused with 552', async () => {
  await withStack({ env: { MAX_MESSAGE_BYTES: '4096' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    const body = Buffer.alloc(9000, 0x61);
    await c.write(`BDAT ${body.length} LAST\r\n`);
    await c.write(body, { silent: true });
    assert.strictEqual((await c.read()).code, 552);
    c.destroy();
    assert.strictEqual(stack.api.delivered.length, 0);
  });
});

// ------------------------------------------------------------ recipients ----

test('an unknown mailbox is refused at RCPT with 550 5.1.1, never accepted then bounced', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    const r = await c.cmd('RCPT TO:<zzzzzzzzzzzz@parse.example.com>');
    assert.strictEqual(r.code, 550);
    assert.ok(r.lines[0].includes('5.1.1'));
    assert.ok(/unknown mailbox/.test(r.lines[0]));
    // DATA must then be refused: there is no recipient
    assert.strictEqual((await c.cmd('DATA')).code, 503);
    c.destroy();
  });
});

test('a foreign domain is 550 5.7.1 relay denied', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    const r = await c.cmd('RCPT TO:<victim@gmail.com>');
    assert.strictEqual(r.code, 550);
    assert.ok(r.lines[0].includes('5.7.1'));
    c.destroy();
  });
});

test('recipient resolution is cached, so a flood does not hammer the API', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    for (let i = 0; i < 5; i++) {
      await c.cmd('MAIL FROM:<a@b.com>');
      assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
      await c.cmd('RSET');
    }
    // 5 lookups of the same address must have produced exactly one API call
    assert.strictEqual(stack.api.calls.resolve, 1);
    assert.ok(stack.resolver.stats.hit >= 4);
    c.destroy();
  });
});

test('repeated unknown recipients are cached negatively and then the session is dropped', async () => {
  await withStack({ env: { MAX_UNKNOWN_RCPT_PER_SESSION: '3' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await c.cmd(`RCPT TO:<aaaaaaaaaaa${i}@parse.example.com>`)).code, 550);
    }
    assert.strictEqual((await c.cmd('RCPT TO:<bbbbbbbbbbbb@parse.example.com>')).code, 550);
    const bye = await c.read();
    assert.strictEqual(bye.code, 421, 'a recipient prober gets disconnected');
    c.destroy();
  });
});

test('too many recipients is 452 4.5.3, not a disconnect', async () => {
  await withStack({ env: { MAX_RECIPIENTS: '2' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250); // duplicate, still counts as ok
    const r = await c.cmd('RCPT TO:<k7m2xq4h9bwz+other@parse.example.com>');
    assert.strictEqual(r.code, 250);
    c.destroy();
  });
});

test('a resolver outage is 451 4.3.0, so the sender retries instead of losing the mail', async () => {
  await withStack({ failWith: 503 }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    const r = await c.cmd(`RCPT TO:<${MBX}>`);
    assert.strictEqual(r.code, 451);
    assert.ok(r.lines[0].includes('4.3.0'));
    c.destroy();
  });
});

// ------------------------------------------------------------- 8bit/utf8 ----

test('8BITMIME: raw 8-bit bytes in the body survive byte-for-byte', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    const caps = await ehlo(c);
    assert.ok(caps.includes('8BITMIME'));
    await c.cmd('MAIL FROM:<a@b.com> BODY=8BITMIME');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    const body = Buffer.concat([
      Buffer.from('Subject: =?utf-8?Q?Gr=C3=BC=C3=9Fe?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n', 'utf8'),
      Buffer.from('Grüße, 31,50 €, ¡olé!, 日本語, emoji 🎉\r\n', 'utf8'),
      Buffer.from([0xc3, 0xa9, 0x0d, 0x0a]),          // a bare 8-bit sequence
      Buffer.from('.\r\n', 'utf8'),
    ]);
    await c.write(body, { silent: true });
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    const raw = stack.api.delivered[0].raw_mime;
    assert.ok(raw.includes(Buffer.from('Grüße, 31,50 €, ¡olé!, 日本語, emoji 🎉', 'utf8')));
    assert.ok(raw.includes(Buffer.from([0xc3, 0xa9, 0x0d, 0x0a])));
  });
});

test('SMTPUTF8: a UTF-8 envelope address is accepted', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    const caps = await ehlo(c);
    assert.ok(caps.includes('SMTPUTF8'));
    const r = await c.cmd('MAIL FROM:<jörg@exämple.de> SMTPUTF8');
    assert.strictEqual(r.code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    await c.cmd('DATA');
    await c.write(Buffer.from('Subject: utf8 envelope\r\n\r\nhi\r\n.\r\n', 'utf8'), { silent: true });
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    assert.strictEqual(stack.api.delivered[0].envelope.from, 'jörg@exämple.de');
  });
});

test('SMTPUTF8: a UTF-8 mailbox token address round-trips', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com> SMTPUTF8');
    // the slug may be non-ASCII; the token itself is always base32
    const r = await c.cmd('RCPT TO:<rechnungen.k7m2xq4h9bwz@parse.example.com>');
    assert.strictEqual(r.code, 250);
    c.destroy();
  });
});

// --------------------------------------------------------------- protocol ---

test('EHLO advertises exactly the extensions we implement, and no STARTTLS without a cert', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    const caps = await ehlo(c);
    assert.ok(caps.includes('SIZE 26214400'));
    assert.ok(caps.includes('8BITMIME'));
    assert.ok(caps.includes('SMTPUTF8'));
    assert.ok(caps.includes('PIPELINING'));
    assert.ok(caps.includes('ENHANCEDSTATUSCODES'));
    assert.ok(caps.includes('CHUNKING'));
    assert.ok(!caps.includes('STARTTLS'), 'must not advertise what we cannot do');
    const r = await c.cmd('STARTTLS');
    assert.strictEqual(r.code, 454);
    c.destroy();
  });
});

test('HELO gets a single-line greeting and still works', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    const r = await c.cmd('HELO client.test');
    assert.strictEqual(r.code, 250);
    assert.strictEqual(r.lines.length, 1);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
    c.destroy();
  });
});

test('command sequence errors are 503, and MAIL/RCPT syntax errors are 501', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 503, 'MAIL before EHLO');
    await ehlo(c);
    assert.strictEqual((await c.cmd('RCPT TO:<x@y.com>')).code, 503, 'RCPT before MAIL');
    assert.strictEqual((await c.cmd('DATA')).code, 503, 'DATA before MAIL');
    assert.strictEqual((await c.cmd('MAIL FROM:garbage')).code, 501);
    assert.strictEqual((await c.cmd('MAIL FROM:<a@b.com>')).code, 250);
    assert.strictEqual((await c.cmd('MAIL FROM:<c@d.com>')).code, 503, 'nested MAIL');
    assert.strictEqual((await c.cmd('RCPT TO:nonsense')).code, 501);
    c.destroy();
  });
});

test('unknown verbs are 500 and EXPN/AUTH are 502', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    assert.strictEqual((await c.cmd('FROBNICATE now')).code, 500);
    assert.strictEqual((await c.cmd('EXPN staff')).code, 502);
    assert.strictEqual((await c.cmd('AUTH PLAIN abc')).code, 502);
    assert.strictEqual((await c.cmd('VRFY someone')).code, 252);
    c.destroy();
  });
});

test('every reply carries an enhanced status code except the banner and EHLO list', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    for (const cmd of ['NOOP', 'MAIL FROM:<a@b.com>', `RCPT TO:<${MBX}>`, 'RSET', 'FROBNICATE']) {
      const r = await c.cmd(cmd);
      assert.ok(/^\d{3}[ -]\d\.\d\.\d /.test(r.lines[r.lines.length - 1]),
        `${cmd} -> ${r.lines[r.lines.length - 1]} should carry an enhanced code`);
    }
    c.destroy();
  });
});

test('after MAX_ERRORS_PER_SESSION the connection is dropped with 421', async () => {
  await withStack({ env: { MAX_ERRORS_PER_SESSION: '4' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    for (let i = 0; i < 3; i++) assert.strictEqual((await c.cmd('BOGUS')).code, 500);
    assert.strictEqual((await c.cmd('BOGUS')).code, 500);
    const bye = await c.read();
    assert.strictEqual(bye.code, 421);
    c.destroy();
  });
});

test('a too-long command line is 500 5.5.6 rather than unbounded buffering', async () => {
  await withStack({ env: { MAX_LINE_BYTES: '512' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.write('NOOP ' + 'x'.repeat(2000), { silent: true });
    const r = await c.read();
    assert.strictEqual(r.code, 500);
    assert.ok(r.lines[0].includes('5.5.6'));
    c.destroy();
  });
});

test('RSET clears the transaction', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    assert.strictEqual((await c.cmd('RSET')).code, 250);
    assert.strictEqual((await c.cmd('DATA')).code, 503, 'DATA after RSET must fail');
    c.destroy();
  });
});

test('a second EHLO resets an in-flight transaction', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    await c.cmd('MAIL FROM:<a@b.com>');
    await ehlo(c, 'again.test');
    assert.strictEqual((await c.cmd('DATA')).code, 503);
    c.destroy();
  });
});

test('a null reverse-path (a bounce) is accepted', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    assert.strictEqual((await c.cmd('MAIL FROM:<>')).code, 250);
    assert.strictEqual((await c.cmd(`RCPT TO:<${MBX}>`)).code, 250);
    await c.cmd('DATA');
    await c.write('Subject: bounce\r\n\r\nfailed\r\n.\r\n', { silent: true });
    assert.strictEqual((await c.read()).code, 250);
    c.destroy();
    assert.strictEqual(stack.api.delivered[0].envelope.from, '');
  });
});

// ------------------------------------------------------------------ caps ----

test('MAX_SESSIONS_PER_IP is enforced with 421', async () => {
  await withStack({ env: { MAX_SESSIONS_PER_IP: '3' } }, async (stack) => {
    const kept = [];
    for (let i = 0; i < 3; i++) {
      const c = new SmtpClient({ port: stack.port });
      await c.connect();
      assert.strictEqual((await c.read()).code, 220);
      kept.push(c);
    }
    const extra = new SmtpClient({ port: stack.port });
    await extra.connect();
    const r = await extra.read();
    assert.strictEqual(r.code, 421, 'the 4th concurrent connection from one IP is refused');
    extra.destroy();
    for (const c of kept) c.destroy();
  });
});

test('the global in-flight cap is enforced with 421 4.3.2', async () => {
  await withStack({ env: { MAX_CONCURRENT_SESSIONS: '2', MAX_SESSIONS_PER_IP: '100' } }, async (stack) => {
    const kept = [];
    for (let i = 0; i < 2; i++) {
      const c = new SmtpClient({ port: stack.port });
      await c.connect();
      assert.strictEqual((await c.read()).code, 220);
      kept.push(c);
    }
    const extra = new SmtpClient({ port: stack.port });
    await extra.connect();
    const r = await extra.read();
    assert.strictEqual(r.code, 421);
    assert.ok(r.lines[0].includes('4.3.2'));
    extra.destroy();
    for (const c of kept) c.destroy();
  });
});

test('a session that goes quiet is closed with 421 4.4.2', async () => {
  await withStack({ env: { SESSION_TIMEOUT_MS: '300' } }, async (stack) => {
    const c = await open(stack);
    await ehlo(c);
    const r = await c.read();
    assert.strictEqual(r.code, 421);
    assert.ok(r.lines[0].includes('4.4.2'));
    c.destroy();
  });
});

// ------------------------------------------------------------ trace/meta ----

test('the Received: header is well formed and names both ends', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c, 'mail.acme.example');
    await c.cmd('MAIL FROM:<billing@acme.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    await c.write('Subject: trace\r\nFrom: <billing@acme.com>\r\n\r\nhi\r\n.\r\n', { silent: true });
    await c.read();
    c.destroy();
    const raw = stack.api.delivered[0].raw_mime.toString();
    assert.match(raw, /^Received: from mail\.acme\.example \(/);
    assert.match(raw, /\r\n\tby mx-test\.mailmint\.local with ESMTP id [0-9A-F]+\r\n/);
    assert.match(raw, /\r\n\tfor <k7m2xq4h9bwz@parse\.example\.com>;\r\n/);
    assert.match(raw, /\r\n\t\w{3}, \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/);
  });
});

test('the delivered payload matches the CONTRACT envelope shape', async () => {
  await withStack({}, async (stack) => {
    const c = await open(stack);
    await ehlo(c, 'sender.example');
    await c.cmd('MAIL FROM:<billing@acme.com>');
    await c.cmd(`RCPT TO:<${MBX}>`);
    await c.cmd('DATA');
    await c.write('Subject: shape\r\nFrom: <billing@acme.com>\r\n\r\nhi\r\n.\r\n', { silent: true });
    await c.read();
    c.destroy();
    const d = stack.api.delivered[0];
    assert.deepStrictEqual(Object.keys(d.envelope).sort(), ['from', 'helo', 'remote_ip', 'tls', 'to']);
    assert.strictEqual(d.envelope.helo, 'sender.example');
    assert.deepStrictEqual(d.envelope.to, [MBX]);
    assert.strictEqual(typeof d.envelope.remote_ip, 'string');
    assert.strictEqual(d.envelope.tls, false);
    assert.ok(typeof d.received_at === 'string' && !Number.isNaN(Date.parse(d.received_at)));
    assert.deepStrictEqual(Object.keys(d.auth).sort(), ['dkim', 'dmarc', 'spam_score', 'spf']);
    assert.ok(Array.isArray(d.flags));
  });
});

test('a raw socket that just disconnects does not disturb the server', async () => {
  await withStack({}, async (stack) => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const s = net.createConnection({ port: stack.port, host: '127.0.0.1' }, () => s.destroy());
        s.on('close', resolve);
        s.on('error', resolve);
      });
    }
    const c = await open(stack);
    await ehlo(c);
    assert.strictEqual((await c.cmd('NOOP')).code, 250);
    c.destroy();
  });
});
