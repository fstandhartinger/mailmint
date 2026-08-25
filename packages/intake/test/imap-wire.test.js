'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  ResponseAssembler, classify, pairAttributes, bodyOf,
  parseInternalDate, formatSequenceSet, quote, parseRespCode, lex, parseValues,
} = require('../src/imap');

/** Feeds a wire dump through the assembler in fixed-size chunks. */
function feed(wire, chunkSize, opts = {}) {
  const asm = new ResponseAssembler(opts);
  const buf = Buffer.isBuffer(wire) ? wire : Buffer.from(wire, 'utf8');
  const out = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    for (const segs of asm.push(buf.subarray(i, i + chunkSize))) out.push(classify(segs));
  }
  return { responses: out, asm };
}

function fetchWire(body, { uid = 345, seq = 12 } = {}) {
  const b = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`* ${seq} FETCH (UID ${uid} INTERNALDATE "25-Aug-2026 09:14:03 +0000" FLAGS (\\Seen) RFC822.SIZE ${b.length} BODY[] {${b.length}}\r\n`, 'utf8'),
    b,
    Buffer.from(')\r\nA0003 OK Fetch completed (0.002 + 0.000 secs).\r\n', 'utf8'),
  ]);
}

test('literal is reassembled identically at every chunk size', () => {
  const body = 'From: a@b.test\r\nSubject: chunky\r\n\r\n'
    + `${'x'.repeat(50)}\r\n`.repeat(40)
    + 'end\r\n';
  const wire = fetchWire(body);
  for (const chunk of [1, 2, 3, 7, 13, 64, 511, 4096, wire.length]) {
    const { responses } = feed(wire, chunk);
    assert.equal(responses.length, 2, `chunk=${chunk}: expected FETCH + tagged OK`);
    const attrs = pairAttributes(responses[0].values);
    assert.equal(bodyOf(attrs).toString('utf8'), body, `chunk=${chunk}: body differs`);
    assert.equal(responses[1].kind, 'tagged');
    assert.equal(responses[1].status, 'OK');
  }
});

test('a body containing a line that looks like a tagged response does not end the command', () => {
  // This is the bug that a line-splitting client cannot survive: the message
  // itself contains "A0003 OK ...", which is exactly what the client is
  // waiting for from the server.
  const body = [
    'Message-ID: <evil@example.test>',
    'From: attacker@example.test',
    'Subject: A0003 OK Fetch completed',
    '',
    'A0003 OK Fetch completed (0.002 + 0.000 secs).',
    '* 99 EXISTS',
    '* 1 FETCH (UID 1 BODY[] {5}',
    'HELLO',
    ')',
    'A0004 BAD nothing to see here',
    '',
  ].join('\r\n');
  const wire = fetchWire(body);

  for (const chunk of [1, 5, 37, 4096]) {
    const { responses } = feed(wire, chunk);
    assert.equal(responses.length, 2, `chunk=${chunk}: the fake protocol inside the body was parsed as protocol`);
    const attrs = pairAttributes(responses[0].values);
    assert.equal(bodyOf(attrs).toString('utf8'), body);
    assert.equal(responses[1].tag, 'A0003');
  }
});

test('several literals in one response, and a zero-length literal', () => {
  const wire = '* 1 FETCH (UID 7 BODY[HEADER] {13}\r\nSubject: hi\r\n BODY[TEXT] {0}\r\n)\r\n';
  const { responses } = feed(wire, 3);
  assert.equal(responses.length, 1);
  const attrs = pairAttributes(responses[0].values);
  assert.equal(attrs['BODY[HEADER]'].toString('utf8'), 'Subject: hi\r\n');
  assert.equal(attrs['BODY[TEXT]'].length, 0);
});

test('LITERAL+ ({n+}) is framed exactly like a synchronising literal', () => {
  const wire = '* 1 FETCH (UID 7 BODY[] {5+}\r\nHELLO)\r\nA1 OK done\r\n';
  const { responses } = feed(wire, 2);
  assert.equal(responses.length, 2);
  assert.equal(bodyOf(pairAttributes(responses[0].values)).toString(), 'HELLO');
});

test('an oversized literal is truncated but the stream stays in sync', () => {
  const body = 'y'.repeat(5000);
  const wire = Buffer.concat([fetchWire(body), Buffer.from('* 13 EXISTS\r\n', 'utf8')]);
  const { responses } = feed(wire, 97, { maxLiteralBytes: 1000 });
  assert.equal(responses.length, 3);
  const b = bodyOf(pairAttributes(responses[0].values));
  assert.equal(b.length, 1000);
  assert.equal(b.imapSize, 5000);
  assert.equal(b.imapTruncated, true);
  // The point of consuming the rest: everything after it still parses.
  assert.equal(responses[1].status, 'OK');
  assert.equal(responses[2].name, 'EXISTS');
  assert.equal(responses[2].seq, 13);
});

test('a literal whose byte count spans several TCP reads is not split on newlines', () => {
  const body = 'line one\r\nline two\r\n\r\nline four\r\n';
  const wire = fetchWire(body);
  const asm = new ResponseAssembler();
  // Split exactly on a CRLF inside the literal.
  const cut = wire.indexOf(Buffer.from('line two'));
  assert.ok(cut > 0);
  assert.equal(asm.push(wire.subarray(0, cut)).length, 0);
  const rest = asm.push(wire.subarray(cut));
  assert.equal(rest.length, 2);
  assert.equal(bodyOf(pairAttributes(classify(rest[0]).values)).toString(), body);
});

test('untagged responses are classified', () => {
  const wire = [
    '* OK [CAPABILITY IMAP4rev1 IDLE LITERAL+] Dovecot ready.',
    '* CAPABILITY IMAP4rev1 IDLE X-GM-EXT-1',
    '* 231 EXISTS',
    '* 0 RECENT',
    '* SEARCH 1001 1002 1003',
    '* OK [UIDVALIDITY 1724500000] UIDs valid',
    '* OK [PERMANENTFLAGS (\\Answered \\Seen \\*)] Flags permitted.',
    '* BYE Logging out',
    'A0009 OK [READ-WRITE] SELECT completed',
    '+ idling',
    '',
  ].join('\r\n');
  const { responses } = feed(wire, 11);
  assert.equal(responses.length, 10);
  assert.equal(responses[0].code.name, 'CAPABILITY');
  assert.deepEqual(responses[1].values.slice(0, 2), ['IMAP4rev1', 'IDLE']);
  assert.equal(responses[2].name, 'EXISTS');
  assert.equal(responses[2].seq, 231);
  assert.deepEqual(responses[4].values, ['1001', '1002', '1003']);
  assert.equal(responses[5].code.args[0], '1724500000');
  assert.deepEqual(responses[6].code.args, ['\\Answered', '\\Seen', '\\*']);
  assert.equal(responses[8].kind, 'tagged');
  assert.equal(responses[8].code.name, 'READ-WRITE');
  assert.equal(responses[9].kind, 'continuation');
  assert.equal(responses[9].text, 'idling');
});

test('a bracketed section with spaces stays one atom', () => {
  const tokens = lex([{ t: 'text', s: '* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID FROM)] "x")' }]);
  const names = tokens.filter((t) => t.t === 'atom').map((t) => t.v);
  assert.ok(names.includes('BODY[HEADER.FIELDS (MESSAGE-ID FROM)]'), names.join('|'));
  const { values } = parseValues(tokens, 3);
  assert.equal(pairAttributes(values)['BODY[HEADER.FIELDS (MESSAGE-ID FROM)]'], 'x');
});

test('quoted strings with escapes, and NIL', () => {
  const { responses } = feed('* 1 FETCH (X "a \\"quoted\\" \\\\ value" Y NIL)\r\n', 4096);
  const attrs = pairAttributes(responses[0].values);
  assert.equal(attrs.X, 'a "quoted" \\ value');
  assert.equal(attrs.Y, null);
});

test('the parser tolerates a bare LF, which some servers still emit', () => {
  const { responses } = feed('* 5 EXISTS\n* 6 EXISTS\r\n', 1);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].seq, 5);
});

test('a run of bytes with no terminator is refused rather than buffered forever', () => {
  const asm = new ResponseAssembler({ maxLineBytes: 100 });
  assert.throws(() => asm.push(Buffer.alloc(200, 0x41)), /no line terminator/);
});

test('INTERNALDATE parsing', () => {
  assert.equal(parseInternalDate('25-Aug-2026 09:14:03 +0000').toISOString(), '2026-08-25T09:14:03.000Z');
  assert.equal(parseInternalDate('01-Feb-2026 10:20:30 +0100').toISOString(), '2026-02-01T09:20:30.000Z');
  assert.equal(parseInternalDate('garbage'), null);
});

test('sequence sets are compressed', () => {
  assert.equal(formatSequenceSet([1, 2, 3, 7, 9, 10]), '1:3,7,9:10');
  assert.equal(formatSequenceSet([5]), '5');
  assert.equal(formatSequenceSet([]), '');
  assert.equal(formatSequenceSet([3, 1, 2, 2]), '1:3');
});

test('astring quoting', () => {
  assert.equal(quote('INBOX'), 'INBOX');
  assert.equal(quote('INBOX/Sent Items'), '"INBOX/Sent Items"');
  assert.equal(quote('he said "hi"'), '"he said \\"hi\\""');
  assert.equal(quote(''), '""');
});

test('response codes', () => {
  assert.equal(parseRespCode('A1 NO [AUTHENTICATIONFAILED] nope').name, 'AUTHENTICATIONFAILED');
  assert.equal(parseRespCode('A1 OK done'), null);
});
