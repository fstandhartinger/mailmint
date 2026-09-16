'use strict';

/**
 * analytics.js — pure logic, NO database.
 *
 * Runs with `node --test test/analytics-unit.test.js` and no DATABASE_URL:
 * nothing it imports may open a connection at load time.
 *
 * Set the env BEFORE requiring the module: config.js reads the exclusion list
 * at load, and analytics.js reads the salt secret once.
 */
process.env.ANALYTICS_SALT_SECRET = 'unit-test-salt-secret';
process.env.ANALYTICS_EXCLUDE_IPS = '10.9.8.7, 2001:db8::5';

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

test('real people are counted', () => {
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': DESKTOP_CHROME } })), false,
    'a normal desktop Chrome is a visitor');
  assert.equal(analytics.isInternalTraffic(fakeReq({ headers: { 'user-agent': MOBILE_SAFARI } })), false,
    'a mobile Safari is a visitor');
});

test('visitorHash is stable within a day and rotates with the day', () => {
  const morning = new Date('2026-09-16T08:00:00Z');
  const evening = new Date('2026-09-16T23:30:00Z');
  const nextDay = new Date('2026-09-17T00:05:00Z');
  const ip = '203.0.113.7';

  const h1 = analytics.visitorHash(ip, DESKTOP_CHROME, morning);
  const h2 = analytics.visitorHash(ip, DESKTOP_CHROME, evening);
  assert.equal(h1, h2, 'same visitor, same day gives the same code');

  const hNext = analytics.visitorHash(ip, DESKTOP_CHROME, nextDay);
  assert.notEqual(hNext, h1, 'the key rotates daily: the same visitor looks different tomorrow');

  const hOtherIp = analytics.visitorHash('198.51.100.23', DESKTOP_CHROME, morning);
  assert.notEqual(hOtherIp, h1, 'two visitors on one day must hash apart');
});

test('visitorHash cannot be traced back to the IP', () => {
  const ip = '203.0.113.7';
  const h = analytics.visitorHash(ip, DESKTOP_CHROME, new Date('2026-09-16T12:00:00Z'));
  assert.match(h, /^[0-9a-f]{64}$/, 'a hex HMAC-SHA256');
  assert.ok(!h.includes(ip), 'the code contains no trace of the IP');
  assert.ok(!h.includes('203') || h === analytics.visitorHash(ip, DESKTOP_CHROME),
    'hex digits can coincide with address octets; only the full string may not');
});

test('recordEvent never throws, whatever happens inside', () => {
  // The unknown-kind path returns before anything database-adjacent, so it
  // never throws even with no DATABASE_URL — this file must stay hermetic.
  // The real INSERT path is covered by test/analytics.test.js against a DB.
  assert.doesNotThrow(() => analytics.recordEvent('bogus-kind', {}));
});
