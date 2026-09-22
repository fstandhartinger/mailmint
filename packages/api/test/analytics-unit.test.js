'use strict';

/**
 * analytics.js — pure logic, NO database.
 *
 * Runs with `node --test test/analytics-unit.test.js` and no DATABASE_URL:
 * nothing it imports may open a connection at load time.
 *
 * Set the env BEFORE requiring the module: config.js reads the exclusion list
 * and PUBLIC_URL at load, and both feed analytics' internal-traffic and
 * same-site decisions.
 */
process.env.PUBLIC_URL = 'https://mailmint.example.test';
// Deliberately NOT canonical: 2001:0DB8:0:0::a is 2001:db8::a written with an
// uppercase group and explicit zeros — matching must not depend on spelling.
process.env.ANALYTICS_EXCLUDE_IPS = '10.9.8.7, 2001:db8::5, 2001:0DB8:0:0::a';

const test = require('node:test');
const assert = require('node:assert/strict');

const analytics = require('../src/analytics');

const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADLESS_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36';

const fakeReq = ({ headers = {}, ip = '203.0.113.7' } = {}) => ({ headers, ip });

/** A request shaped like a normal browser page load: a countable one. */
const countable = ({ headers = {}, ip = '203.0.113.7', path = '/', method = 'GET' } = {}) => ({
  method, path, ip,
  headers: { 'user-agent': DESKTOP_CHROME, accept: 'text/html,application/xhtml+xml', ...headers },
});

test('machine traffic is excluded from the counts', () => {
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': HEADLESS_CHROME } })), true,
    'a headless browser is not a visitor');
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': 'curl/8.7.1' } })), true,
    'curl is not a visitor');
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: {} })), true,
    'a missing user agent is not a visitor');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME, 'x-mailmint-qa': '1' },
  })), true, 'our own QA header opts out even with a browser UA');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '10.9.8.7',
  })), true, 'an ANALYTICS_EXCLUDE_IPS entry opts out even with a browser UA');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '2001:db8::5',
  })), true, 'the exclusion list also honours IPv6');
});

test('a mapped-IPv4 request matches its plain-IPv4 exclusion entry', () => {
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '::ffff:10.9.8.7',
  })), true, '::ffff:10.9.8.7 is the same internal host as 10.9.8.7');
});

test('a plain-IPv4 request matches a mapped-IPv4 exclusion entry', () => {
  process.env.ANALYTICS_EXCLUDE_IPS = '::ffff:10.9.8.7';
  delete require.cache[require.resolve('../src/analytics')];
  delete require.cache[require.resolve('../src/config')];
  try {
    const fresh = require('../src/analytics');
    assert.equal(fresh.isInternalTraffic(fakeReq({
      headers: { 'user-agent': DESKTOP_CHROME }, ip: '10.9.8.7',
    })), true, '10.9.8.7 is the same internal host as ::ffff:10.9.8.7');
    assert.equal(fresh.classifyRequest(countable({ ip: '10.9.8.7' })), null,
      'classification uses the same normalization, both directions');
  } finally {
    process.env.ANALYTICS_EXCLUDE_IPS = '10.9.8.7, 2001:db8::5, 2001:0DB8:0:0::a';
    delete require.cache[require.resolve('../src/analytics')];
    delete require.cache[require.resolve('../src/config')];
  }
});

test('a missing client IP never throws and never matches', () => {
  const req = { headers: { 'user-agent': DESKTOP_CHROME } };
  assert.doesNotThrow(() => analytics.isInternalTraffic(req));
  assert.equal(analytics.isInternalTraffic(req), false,
    'no IP means the exclusion list cannot match');
});

test('IPv6 exclusion entries match in any valid spelling', () => {
  // The list at the top of this file: 10.9.8.7, 2001:db8::5, 2001:0DB8:0:0::a.
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '2001:0db8:0000::5',
  })), true, '2001:0db8:0000::5 is 2001:db8::5 written out long');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '2001:DB8:0:0:0:0:0:5',
  })), true, 'uppercase fully-expanded groups are still 2001:db8::5');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '2001:db8::a',
  })), true, 'the list entry 2001:0DB8:0:0::a is 2001:db8::a written non-canonically');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '::FFFF:10.9.8.7',
  })), true, 'the uppercase mapped form is still 10.9.8.7');
  assert.equal(analytics.isInternalTraffic(fakeReq({
    headers: { 'user-agent': DESKTOP_CHROME }, ip: '2001:db8::6',
  })), false, 'a neighbouring IPv6 is not in the list');
});

test('normalizeIp canonicalizes (RFC 5952) and never throws', () => {
  const { normalizeIp } = analytics;
  assert.equal(normalizeIp('10.9.8.7'), '10.9.8.7', 'IPv4 stays as written');
  assert.equal(normalizeIp('::FFFF:10.9.8.7'), '10.9.8.7', 'the mapped form unwraps, any case');
  assert.equal(normalizeIp('::ffff:10.9.8.7'), '10.9.8.7');
  assert.equal(normalizeIp('2001:0DB8:0:0::5'), '2001:db8::5', 'uppercase and padded groups strip');
  assert.equal(normalizeIp('2001:db8:0:0:0:0:0:5'), '2001:db8::5', 'expanded compresses again');
  assert.equal(normalizeIp('::'), '::', 'the unspecified address survives');
  assert.equal(normalizeIp('2001:db8:0:1:0:0:0:1'), '2001:db8:0:1::1',
    'only the longest zero run compresses');
  assert.equal(normalizeIp('2001:0:0:1:0:0:1:1'), '2001::1:0:0:1:1',
    'on a tie the first run compresses');
  assert.equal(normalizeIp('  2001:DB8::5  '), '2001:db8::5', 'surrounding space is trimmed first');
  for (const bad of [null, undefined, 0, 12345, NaN, {}, [], 'not-an-ip', '::ffff:not-an-ip', '1:2:3:4:5:6:7:8:9']) {
    assert.doesNotThrow(() => normalizeIp(bad), `input ${String(bad)} must not throw`);
  }
  assert.equal(normalizeIp(null), '');
  assert.equal(normalizeIp(12345), '12345');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1%eth0',
    'a zone id degrades to a plain string that matches nothing');
  assert.equal(normalizeIp('NoT-An-Ip '), 'not-an-ip',
    'garbage degrades to a trimmed lowercase string');
});

test('real people are counted', () => {
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': DESKTOP_CHROME } })), false,
    'a normal desktop Chrome is a visitor');
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': MOBILE_SAFARI } })), false,
    'a mobile Safari is a visitor');
});

test('a desktop Chrome page load on a public path is classified for counting', () => {
  assert.deepEqual(analytics.classifyRequest(countable()),
    { path: '/', referrerHost: '', visit: true }, 'no referer: a visit from outside');
  assert.deepEqual(analytics.classifyRequest(countable({
    headers: { 'sec-fetch-dest': 'document', accept: '*/*' },
  })), { path: '/', referrerHost: '', visit: true },
  'a document request counts even without an HTML Accept');
  assert.deepEqual(analytics.classifyRequest(countable({
    headers: { referer: 'https://mailmint.example.test/docs' },
  })), { path: '/', referrerHost: '', visit: false },
  'the PUBLIC_URL host is the own site: a view, not a visit');
  assert.deepEqual(analytics.classifyRequest(countable({
    headers: { referer: 'http://localhost:3000/' },
  })), { path: '/', referrerHost: '', visit: false }, 'localhost is the own site');
});

test('machine traffic is not counted as a page view', () => {
  assert.equal(analytics.classifyRequest(countable({ headers: { 'user-agent': HEADLESS_CHROME } })), null,
    'a headless browser records nothing');
  assert.equal(analytics.classifyRequest(countable({ headers: { 'user-agent': 'curl/8.7.1' } })), null,
    'curl records nothing');
  assert.equal(analytics.classifyRequest(countable({ headers: { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' } })), null,
    'an AI crawler records nothing');
  assert.equal(analytics.classifyRequest(countable({ headers: { 'x-mailmint-qa': '1' } })), null,
    'our QA header opts out');
});

test('excluded IPs are not counted, mapped IPv4 in both directions', () => {
  assert.equal(analytics.classifyRequest(countable({ ip: '10.9.8.7' })), null,
    'a plain exclusion entry excludes a plain request');
  assert.equal(analytics.classifyRequest(countable({ ip: '::ffff:10.9.8.7' })), null,
    'a plain exclusion entry excludes a mapped request');
});

test('DNT and Global Privacy Control requests are not counted', () => {
  assert.equal(analytics.classifyRequest(countable({ headers: { dnt: '1' } })), null, 'DNT is honoured');
  assert.equal(analytics.classifyRequest(countable({ headers: { 'sec-gpc': '1' } })), null, 'GPC is honoured');
});

test('prefetch and prerender are not page views', () => {
  assert.equal(analytics.classifyRequest(countable({ headers: { 'sec-purpose': 'prefetch' } })), null);
  assert.equal(analytics.classifyRequest(countable({ headers: { 'sec-purpose': 'prerender' } })), null);
  assert.equal(analytics.classifyRequest(countable({ headers: { purpose: 'prefetch' } })), null,
    'the legacy header is honoured too');
});

test('only full page loads are counted', () => {
  assert.equal(analytics.classifyRequest(countable({ headers: { 'sec-fetch-dest': 'image' } })), null,
    'a subresource request is not a view');
  assert.equal(analytics.classifyRequest(countable({ headers: { 'sec-fetch-dest': 'empty' } })), null,
    'a fetch() call is not a view');
  assert.equal(analytics.classifyRequest(countable({ headers: { accept: 'application/json' } })), null,
    'without Sec-Fetch-Dest, a non-HTML Accept is not a view');
  assert.equal(analytics.classifyRequest(countable({ method: 'POST' })), null,
    'a POST is not a view');
});

test('non-public paths are not counted', () => {
  assert.equal(analytics.classifyRequest(countable({ path: '/dashboard' })), null,
    'the app behind the login is not counted');
  assert.equal(analytics.classifyRequest(countable({ path: '/no-such-page' })), null,
    'a 404 path is not counted');
  assert.ok(analytics.classifyRequest(countable({ path: '/docs/reference' })),
    'the public docs subtree is counted');
});

test('pagePath strips trailing slashes, never the root itself', () => {
  const { pagePath } = analytics;
  assert.equal(pagePath('/quickstart/'), '/quickstart');
  assert.equal(pagePath('/docs/x//'), '/docs/x', 'multiple trailing slashes collapse');
  assert.equal(pagePath('/docs/api/'), '/docs/api');
  assert.equal(pagePath('/'), '/', 'the root stays the root');
  assert.equal(pagePath('/quickstart'), '/quickstart', 'an already-clean path is untouched');
  assert.equal(pagePath('//'), '//', 'a path of only slashes is not turned into the root');
  assert.equal(analytics.classifyRequest(countable({ path: '//' })), null,
    '// was not public before VS-3 and still is not');
});

test('a trailing-slash page load is counted under the canonical path', () => {
  assert.deepEqual(analytics.classifyRequest(countable({ path: '/quickstart/' })),
    { path: '/quickstart', referrerHost: '', visit: true },
    '/quickstart/ is served by Express and must count as /quickstart');
  assert.deepEqual(analytics.classifyRequest(countable({ path: '/docs/api/' })),
    { path: '/docs/api', referrerHost: '', visit: true },
    '/docs/api/ counts as /docs/api');
  assert.deepEqual(analytics.classifyRequest(countable({ path: '/' })),
    { path: '/', referrerHost: '', visit: true }, 'the root is unchanged');
  assert.equal(analytics.classifyRequest(countable({ path: '/unknown/' })), null,
    'stripping does not make an unknown path public');
});

test('an external referrer is reduced to its host, path and query dropped', () => {
  const hit = analytics.classifyRequest(countable({
    headers: { referer: 'https://WWW.SearchEngine.example/search?q=secret&token=hush#frag' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: 'searchengine.example', visit: true },
    'host only: lowercased, www. stripped, no path, no query');
  const long = `${'a'.repeat(120)}.example`;
  assert.equal(analytics.classifyRequest(countable({
    headers: { referer: `https://${long}/x` },
  })).referrerHost.length, 100, 'the stored host name is capped at 100 characters');
});

test('a same-site referrer is a view but never a visit', () => {
  for (const own of ['mailmint.app.mintapis.com', 'mailmint.example.test', '127.0.0.1']) {
    const hit = analytics.classifyRequest(countable({
      headers: { referer: `https://${own}/docs?x=1` },
    }));
    assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false }, `${own} is the own site`);
  }
});

test('a missing or invalid referer counts as a visit with no referrer', () => {
  assert.deepEqual(analytics.classifyRequest(countable()),
    { path: '/', referrerHost: '', visit: true });
  assert.deepEqual(analytics.classifyRequest(countable({
    headers: { referer: 'not-a-url' },
  })), { path: '/', referrerHost: '', visit: true },
  'an unparseable referer is treated as arriving from outside');
});

test('rows below the threshold and beyond the top fold into one (other) row', () => {
  const rows = [];
  for (let v = 30; v >= 1; v -= 1) rows.push({ path: `/p${v}`, views: v, visits: v });
  const folded = analytics.fold(rows, 'views', 'path', ['views', 'visits']);
  assert.equal(folded.length, 26, 'the top 25 plus one (other)');
  assert.deepEqual(folded.slice(0, 2), [
    { path: '/p30', views: 30, visits: 30 }, { path: '/p29', views: 29, visits: 29 },
  ], 'the strongest pages stay, in order');
  assert.deepEqual(folded[25], { path: '(other)', views: 15, visits: 15 },
    'views 5+4+3 (beyond the top) and 2+1 (below the threshold) are folded together');
  assert.ok(!folded.some((r) => r.path === '/p1'), 'no single-visit page is named');
});

test('the referrer fold keys on visits, not views', () => {
  const folded = analytics.fold(
    [{ host: 'big.example', visits: 10 }, { host: 'small.example', visits: 2 }],
    'visits', 'host', ['visits'],
  );
  assert.deepEqual(folded, [
    { host: 'big.example', visits: 10 }, { host: '(other)', visits: 2 },
  ], 'a host with fewer visits than the threshold is folded');
});

test('the module exports no per-visitor code', () => {
  assert.equal('visitorHash' in analytics, false, 'visitorHash is gone');
  assert.equal(analytics.RETENTION_MONTHS, 13);
  assert.equal(analytics.MIN_REPORT_COUNT, 3);
});

test('recordEvent never throws, whatever happens inside', () => {
  // The unknown-kind path returns before anything database-adjacent, so it
  // never throws even with no DATABASE_URL — this file must stay hermetic.
  // The real INSERT path is covered by test/analytics.test.js against a DB.
  assert.doesNotThrow(() => analytics.recordEvent('bogus-kind', {}));
  assert.doesNotThrow(() => analytics.recordEvent('visit', {}),
    'visits enter the aggregate table, not recordEvent');
});
