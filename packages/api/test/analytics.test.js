'use strict';

/**
 * analytics end-to-end — a real server, the real middleware chain, and a real
 * Postgres. Skipped without a database URL, like the other DB suites.
 *
 * The env must be set before helpers.js pulls in the server: config.js and
 * analytics.js both read their values once, at load.
 */
const crypto = require('node:crypto');

process.env.ANALYTICS_SALT_SECRET = 'db-test-salt-secret';
// The allowlist carries the admin email in a different case on purpose: the
// match must be case-insensitive (accounts are stored lowercased).
const ADMIN_EMAIL = `admin-${crypto.randomBytes(5).toString('hex')}@mailmint-test.example`;
process.env.MAILMINT_ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase();

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const analytics = require('../src/analytics');

const HAS_DB = Boolean(process.env.DATABASE_URL || process.env.MAILMINT_TEST_DATABASE_URL);
const SKIP = HAS_DB ? {} : { skip: 'needs DATABASE_URL' };

// Distinctive UAs per purpose, so each assertion can filter on exactly one
// visitor hash. Nothing else in the suite sends these strings.
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADLESS_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const countVisits = async (ua) => {
  const { rows } = await H.query(
    `SELECT count(*)::int AS n FROM analytics_events
      WHERE kind = 'visit' AND visitor_hash = $1`,
    [analytics.visitorHash('127.0.0.1', ua)],
  );
  return rows[0].n;
};

const countForAccount = async (kind, accountId) => {
  const { rows } = await H.query(
    `SELECT count(*)::int AS n FROM analytics_events WHERE kind = $1 AND account_id = $2`,
    [kind, accountId],
  );
  return rows[0].n;
};

describe('analytics', () => {
  let admin = null; // { cookie, accountId } once the sign-up test has run

  before(async () => {
    if (!HAS_DB) return;
    await H.start();
    // The visitor codes are deterministic within a day, so rows from an earlier
    // run against the same database would inflate the exact counts below.
    await H.query(`DELETE FROM analytics_events WHERE kind = 'visit' AND visitor_hash = ANY($1)`,
      [[DESKTOP_CHROME, HEADLESS_CHROME, MOBILE_SAFARI].map((ua) => analytics.visitorHash('127.0.0.1', ua))]);
  });
  after(H.stop);

  test('a page view by a real visitor is counted once', SKIP, async () => {
    const { res } = await H.req('/', { headers: { 'user-agent': DESKTOP_CHROME } });
    assert.equal(res.status, 200);
    const n = await H.until(async () => {
      const c = await countVisits(DESKTOP_CHROME);
      return c >= 1 && c;
    }, { what: 'the visit row to land' });
    assert.equal(n, 1, 'exactly one visit event for this visitor');
  });

  test('machines and our own QA do not show up in the numbers', SKIP, async () => {
    const headless = await H.req('/', { headers: { 'user-agent': HEADLESS_CHROME } });
    assert.equal(headless.res.status, 200);
    const qa = await H.req('/', { headers: { 'user-agent': MOBILE_SAFARI, 'x-mailmint-qa': '42' } });
    assert.equal(qa.res.status, 200);
    // Give a (non-existent) write a fair chance to land, then assert silence.
    await sleep(800);
    assert.equal(await countVisits(HEADLESS_CHROME), 0, 'headless Chrome recorded nothing');
    assert.equal(await countVisits(MOBILE_SAFARI), 0, 'an x-mailmint-qa request recorded nothing');
    // And the real visitor's count from the previous test is untouched.
    assert.equal(await countVisits(DESKTOP_CHROME), 1);
  });

  test('signing up counts a sign-up and a trial start', SKIP, async () => {
    // The admin account doubles as the sign-up source, so later tests have a
    // session to sign in with.
    const { res } = await H.req('/signup', {
      method: 'POST', form: true,
      body: { email: ADMIN_EMAIL, password: 'admin-test-password-123' },
      headers: { 'user-agent': DESKTOP_CHROME },
    });
    assert.equal(res.status, 302, 'a successful sign-up redirects to the dashboard');
    const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'the sign-up set a session cookie');
    const { rows } = await H.query(`SELECT id FROM accounts WHERE email = $1`, [ADMIN_EMAIL]);
    const accountId = Number(rows[0].id);

    await H.until(async () => (await countForAccount('signup', accountId)) === 1, { what: 'signup event' });
    assert.equal(await countForAccount('trial_start', accountId), 1, 'a new account starts a trial');
    admin = { cookie, accountId };
  });

  test('a free → paid plan change counts one paid conversion', SKIP, async () => {
    const { accountId } = await H.newAccount();
    const billing = require('../src/billing');

    await billing.applyPlan(accountId, 'starter', 'sub_test_paid');
    await H.until(async () => (await countForAccount('paid_conversion', accountId)) === 1,
      { what: 'paid_conversion event' });

    // A sideways move between two paid plans is not a new conversion.
    await billing.applyPlan(accountId, 'pro', 'sub_test_paid');
    await sleep(500);
    assert.equal(await countForAccount('paid_conversion', accountId), 1,
      'paid → paid must not count again');

    // Back on free and up again is a fresh conversion.
    await billing.applyPlan(accountId, 'free', null);
    await billing.applyPlan(accountId, 'starter', 'sub_test_paid');
    await H.until(async () => (await countForAccount('paid_conversion', accountId)) === 2,
      { what: 'the second conversion after another free stay' });
  });

  test('/admin/stats.json answers only the operator', SKIP, async () => {
    const ua = { 'user-agent': DESKTOP_CHROME };

    // Logged out: not even a hint that the endpoint exists.
    const anon = await H.req('/admin/stats.json', { headers: ua });
    assert.equal(anon.res.status, 404, 'logged-out gets the ordinary 404');

    // A normal account: the same answer.
    const muggle = await H.newAccount();
    const nonAdmin = await H.req('/admin/stats.json', { cookie: muggle.cookie, headers: ua });
    assert.equal(nonAdmin.res.status, 404, 'a non-admin account gets the same 404');
    const nonAdminHtml = await H.req('/admin/stats', { cookie: muggle.cookie, headers: ua });
    assert.equal(nonAdminHtml.res.status, 404, 'the HTML view is gated the same way');

    // The allowlisted account (allowlisted in different case, see top) sees the counts.
    assert.ok(admin, 'the sign-up test ran first and left an admin session');
    const got = await H.req('/admin/stats.json?days=1', { cookie: admin.cookie, headers: ua });
    assert.equal(got.res.status, 200, `stats answered ${got.res.status}: ${got.text.slice(0, 200)}`);
    const rows = got.json.rows;
    const today = new Date().toISOString().slice(0, 10);
    const rowFor = (kind) => rows.find((r) => r.kind === kind && r.day === today);
    assert.ok(rowFor('visit').events >= 1, 'today has at least our counted page view');
    assert.ok(rowFor('signup').events >= 1, 'today has our counted sign-up');
    assert.ok(rowFor('trial_start').events >= 1, 'today has our trial start');
    assert.equal(typeof rowFor('visit').visitors, 'number', 'visits carry a distinct-visitor count');

    // The admin page itself renders the numbers as HTML for a human.
    const html = await H.req('/admin/stats', { cookie: admin.cookie, headers: ua });
    assert.equal(html.res.status, 200);
    assert.ok(html.text.includes('Visitor statistics'), 'the HTML view carries its heading');
  });
});
