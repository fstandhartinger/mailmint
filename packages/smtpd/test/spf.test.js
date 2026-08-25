'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { checkHost, parseRecord, expandMacros } = require('../src/auth/spf');
const { DnsClient } = require('../src/auth/dns');
const { parseIP, inCidr, ipMacro, reverseName } = require('../src/auth/ip');

function dns(stub) { return new DnsClient({ stub }); }
const txt = (...records) => records.map((r) => [r]);

// ------------------------------------------------------------------- ip ----

test('parseIP handles v4, v6, compressed v6 and v4-mapped v6', () => {
  assert.strictEqual(parseIP('192.0.2.1').family, 4);
  assert.strictEqual(parseIP('2001:db8::1').family, 6);
  assert.strictEqual(parseIP('::ffff:192.0.2.1').family, 4, 'v4-mapped must become v4');
  assert.strictEqual(parseIP('::1').bytes.toString('hex'), '0'.repeat(31) + '1');
  assert.strictEqual(parseIP('2001:db8::192.0.2.1').bytes.subarray(12).toString('hex'), 'c0000201');
  assert.strictEqual(parseIP('999.0.0.1'), null);
  assert.strictEqual(parseIP('1:2:3:4:5:6:7:8:9'), null);
  assert.strictEqual(parseIP('nonsense'), null);
});

test('inCidr masks on the right bit boundary', () => {
  const ip = parseIP('209.85.167.180');
  assert.ok(inCidr(ip, '209.85.128.0', 17));
  assert.ok(!inCidr(ip, '209.85.128.0', 19), '209.85.128.0/19 stops at .159');
  assert.ok(inCidr(ip, '209.85.167.180', 32));
  const v6 = parseIP('2a00:1450:4013:c01::1a');
  assert.ok(inCidr(v6, '2a00:1450:4000::', 36));
  assert.ok(!inCidr(v6, '2a01:1450:4000::', 36));
  assert.ok(!inCidr(v6, '209.85.128.0', 17), 'families must never match across');
});

test('the %{i} macro and the reverse name follow the RFC', () => {
  assert.strictEqual(ipMacro(parseIP('192.0.2.3')), '192.0.2.3');
  assert.strictEqual(ipMacro(parseIP('2001:db8::1')).split('.').length, 32);
  assert.strictEqual(reverseName(parseIP('192.0.2.3')), '3.2.0.192.in-addr.arpa');
  assert.ok(reverseName(parseIP('2001:db8::1')).endsWith('.ip6.arpa'));
});

// -------------------------------------------------------------- parsing ----

test('parseRecord splits mechanisms, qualifiers, CIDRs and modifiers', () => {
  const terms = parseRecord('v=spf1 +a -mx:mail.example.com ~ip4:10.0.0.0/8 ?include:x.com redirect=y.com -all');
  assert.deepStrictEqual(terms.map((t) => t.name), ['a', 'mx', 'ip4', 'include', 'redirect', 'all']);
  assert.strictEqual(terms[4].kind, 'modifier');
  assert.strictEqual(terms[1].qualifier, '-');
  assert.strictEqual(terms[1].value, 'mail.example.com');
  assert.strictEqual(terms[2].cidr4, 8);
  assert.strictEqual(terms[4].name, 'redirect');
});

test('macro expansion follows RFC 7208 §7.2', () => {
  const ctx = {
    ip: parseIP('192.0.2.3'), helo: 'mx.example.org', sender: 'strong-bad@email.example.com',
    senderLocal: 'strong-bad', senderDomain: 'email.example.com', domain: 'email.example.com',
  };
  assert.strictEqual(expandMacros('%{s}', ctx), 'strong-bad@email.example.com');
  assert.strictEqual(expandMacros('%{o}', ctx), 'email.example.com');
  assert.strictEqual(expandMacros('%{d4}', ctx), 'email.example.com');
  assert.strictEqual(expandMacros('%{d2}', ctx), 'example.com');
  assert.strictEqual(expandMacros('%{l}', ctx), 'strong-bad');
  assert.strictEqual(expandMacros('%{l-}', ctx), 'strong.bad');
  assert.strictEqual(expandMacros('%{ir}.%{v}._spf.%{d2}', ctx), '3.2.0.192.in-addr._spf.example.com');
  assert.strictEqual(expandMacros('%%%_%-', ctx), '% %20');
});

// ------------------------------------------------------------ evaluation ---

test('ip4 mechanism: pass and the fall-through to ~all', async () => {
  const stub = { 'TXT:example.com': txt('v=spf1 ip4:192.0.2.0/24 ~all') };
  assert.strictEqual((await checkHost({ ip: '192.0.2.7', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '198.51.100.1', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'softfail');
});

test('every "all" qualifier maps to the right result', async () => {
  for (const [record, want] of [
    ['v=spf1 -all', 'fail'],
    ['v=spf1 ~all', 'softfail'],
    ['v=spf1 ?all', 'neutral'],
    ['v=spf1 +all', 'pass'],
    ['v=spf1 all', 'pass'],
    ['v=spf1', 'neutral'],
  ]) {
    const r = await checkHost({
      ip: '203.0.113.9', helo: 'x', mailFrom: 'a@example.com',
      dns: dns({ 'TXT:example.com': txt(record) }),
    });
    assert.strictEqual(r.result, want, record);
  }
});

test('no SPF record at all is "none", and a broken resolver is "temperror"', async () => {
  assert.strictEqual((await checkHost({
    ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns({}),
  })).result, 'none');
  assert.strictEqual((await checkHost({
    ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns({ 'TXT:example.com': 'ESERVFAIL' }),
  })).result, 'temperror');
});

test('two SPF records is a permerror', async () => {
  const r = await checkHost({
    ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com',
    dns: dns({ 'TXT:example.com': txt('v=spf1 -all', 'v=spf1 +all') }),
  });
  assert.strictEqual(r.result, 'permerror');
});

test('a mechanism / a:host / a with CIDR', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 a a:other.com/24 -all'),
    'A:example.com': ['192.0.2.10'],
    'A:other.com': ['198.51.100.5'],
  };
  assert.strictEqual((await checkHost({ ip: '192.0.2.10', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '198.51.100.200', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '203.0.113.1', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('mx mechanism resolves every exchange', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 mx -all'),
    'MX:example.com': [{ priority: 20, exchange: 'mx2.example.com' }, { priority: 10, exchange: 'mx1.example.com' }],
    'A:mx1.example.com': ['192.0.2.1'],
    'A:mx2.example.com': ['192.0.2.2'],
  };
  for (const ip of ['192.0.2.1', '192.0.2.2']) {
    assert.strictEqual((await checkHost({ ip, helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass', ip);
  }
  assert.strictEqual((await checkHost({ ip: '192.0.2.3', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('include: a pass inside the include is a match, a fail inside it is not', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 include:sender.net -all'),
    'TXT:sender.net': txt('v=spf1 ip4:203.0.113.0/24 -all'),
  };
  assert.strictEqual((await checkHost({ ip: '203.0.113.5', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '10.0.0.1', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('include: pointing at a domain with no SPF record is a permerror', async () => {
  const r = await checkHost({
    ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com',
    dns: dns({ 'TXT:example.com': txt('v=spf1 include:nothing.net -all') }),
  });
  assert.strictEqual(r.result, 'permerror');
});

test('redirect= is followed when there is no "all"', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 redirect=_spf.example.com'),
    'TXT:_spf.example.com': txt('v=spf1 ip4:192.0.2.0/24 -all'),
  };
  assert.strictEqual((await checkHost({ ip: '192.0.2.9', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '10.0.0.1', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('redirect= is ignored when an "all" is present', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 ~all redirect=_spf.example.com'),
    'TXT:_spf.example.com': txt('v=spf1 +all'),
  };
  assert.strictEqual((await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'softfail');
});

test('exists: with macro expansion', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 exists:%{ir}.%{v}._spf.%{d} -all'),
    'A:4.3.2.1.in-addr._spf.example.com': ['127.0.0.1'],
  };
  assert.strictEqual((await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '5.6.7.8', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('ptr: only a forward-confirmed name matches', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 ptr -all'),
    'PTR:4.3.2.1.in-addr.arpa': ['mail.example.com'],
    'A:mail.example.com': ['1.2.3.4'],
  };
  assert.strictEqual((await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');

  const lying = {
    ...stub,
    'A:mail.example.com': ['9.9.9.9'],   // PTR claims us, forward lookup disagrees
  };
  assert.strictEqual((await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(lying) })).result, 'fail');
});

test('the 10 DNS-lookup limit is enforced with a permerror', async () => {
  const stub = { 'TXT:example.com': txt('v=spf1 ' + Array.from({ length: 12 }, (_, i) => `include:i${i}.net`).join(' ') + ' -all') };
  for (let i = 0; i < 12; i++) stub[`TXT:i${i}.net`] = txt('v=spf1 -all');
  const r = await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) });
  assert.strictEqual(r.result, 'permerror');
  assert.match(r.reason, /more than 10 DNS lookups/);
  assert.strictEqual(r.lookups, 11);
});

test('the 2 void-lookup limit is enforced', async () => {
  const stub = { 'TXT:example.com': txt('v=spf1 a:one.test a:two.test a:three.test -all') };
  const r = await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) });
  assert.strictEqual(r.result, 'permerror');
  assert.match(r.reason, /void lookups/);
});

test('more than 10 MX records is a permerror', async () => {
  const stub = {
    'TXT:example.com': txt('v=spf1 mx -all'),
    'MX:example.com': Array.from({ length: 11 }, (_, i) => ({ priority: i, exchange: `mx${i}.example.com` })),
  };
  const r = await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) });
  assert.strictEqual(r.result, 'permerror');
});

test('an unknown mechanism is a permerror, not a silent skip', async () => {
  const r = await checkHost({
    ip: '1.2.3.4', helo: 'x', mailFrom: 'a@example.com',
    dns: dns({ 'TXT:example.com': txt('v=spf1 frobnicate:x -all') }),
  });
  assert.strictEqual(r.result, 'permerror');
});

test('an unknown modifier is ignored, as the RFC requires', async () => {
  const r = await checkHost({
    ip: '192.0.2.1', helo: 'x', mailFrom: 'a@example.com',
    dns: dns({ 'TXT:example.com': txt('v=spf1 whatever=1 ip4:192.0.2.1 -all') }),
  });
  assert.strictEqual(r.result, 'pass');
});

test('a null reverse path is checked as postmaster@<helo>', async () => {
  const stub = { 'TXT:bounce.example.com': txt('v=spf1 ip4:192.0.2.0/24 -all') };
  const r = await checkHost({ ip: '192.0.2.5', helo: 'bounce.example.com', mailFrom: '', dns: dns(stub) });
  assert.strictEqual(r.result, 'pass');
  assert.strictEqual(r.domain, 'bounce.example.com');
});

test('an unusable sender domain gives "none" rather than an exception', async () => {
  for (const from of ['a@localhost', 'no-at-sign', 'a@[192.0.2.1]']) {
    const r = await checkHost({ ip: '1.2.3.4', helo: 'localhost', mailFrom: from, dns: dns({}) });
    assert.ok(['none', 'permerror'].includes(r.result), `${from} -> ${r.result}`);
  }
});

test('an unparseable client IP is a permerror', async () => {
  const r = await checkHost({ ip: 'not-an-ip', helo: 'x', mailFrom: 'a@example.com', dns: dns({}) });
  assert.strictEqual(r.result, 'permerror');
});

test('IPv6 senders are matched against ip6 mechanisms', async () => {
  const stub = { 'TXT:example.com': txt('v=spf1 ip6:2001:db8::/32 -all') };
  assert.strictEqual((await checkHost({ ip: '2001:db8:1::5', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '2001:db9::5', helo: 'x', mailFrom: 'a@example.com', dns: dns(stub) })).result, 'fail');
});

test('a realistic Google-shaped record with nested includes resolves', async () => {
  const stub = {
    'TXT:gmail.test': txt('v=spf1 redirect=_spf.google.test'),
    'TXT:_spf.google.test': txt('v=spf1 include:_netblocks.google.test include:_netblocks2.google.test ~all'),
    'TXT:_netblocks.google.test': txt('v=spf1 ip4:209.85.128.0/17 ip4:64.233.160.0/19 ~all'),
    'TXT:_netblocks2.google.test': txt('v=spf1 ip6:2a00:1450:4000::/36 ~all'),
  };
  assert.strictEqual((await checkHost({ ip: '209.85.167.180', helo: 'mail-oi1-f180.google.test', mailFrom: 'a@gmail.test', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '2a00:1450:4013:c01::1a', helo: 'x', mailFrom: 'a@gmail.test', dns: dns(stub) })).result, 'pass');
  assert.strictEqual((await checkHost({ ip: '1.2.3.4', helo: 'x', mailFrom: 'a@gmail.test', dns: dns(stub) })).result, 'softfail');
});

// --------------------------------------------------------------- live DNS ---

test('LIVE: gmail.com passes for a real Google outbound IP', { skip: process.env.MAILMINT_LIVE_DNS !== '1' }, async () => {
  const r = await checkHost({ ip: '209.85.167.180', helo: 'mail-oi1-f180.google.com', mailFrom: 'someone@gmail.com' });
  assert.strictEqual(r.result, 'pass');
});
