'use strict';

/**
 * analytics end-to-end — a real server, the real middleware chain, and a real
 * Postgres. Skipped without a database URL, like the other DB suites.
 *
 * The env must be set before helpers.js pulls in the server: config.js reads
 * its values once, at load.
 */
const crypto = require('node:crypto');

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

// Distinctive UAs per purpose, so each assertion is about exactly one request.
// Nothing else in the suite sends these strings.
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADLESS_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36';
// What a real navigation carries. Without it (fetch sends Accept: *\/* by
// default), the request is already not a page load, which would mask exactly
// what these tests are out to prove.
const HTML_ACCEPT = 'text/html,application/xhtml+xml';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visit counts are daily totals now, so every test marks its requests with a
// unique referring host it can key on: one row per (UTC day, path, host).
const RUN = crypto.randomBytes(6).toString('hex');
const refHost = (label) => `${label}.${RUN}.example`;
const refererOf = (label) => `https://www.${refHost(label)}/arrived/here?q=marker`;

/** Today's aggregate row for one (path, referrer host), or null. */
const dayRow = async (path, host) => {
  const { rows } = await H.query(
    `SELECT views, visits FROM analytics_visit_daily
      WHERE day = ((now() AT TIME ZONE 'utc')::date) AND path = $1 AND referrer_host = $2`,
    [path, host],
  );
  return rows[0] || null;
};

/** Waits for the fire-and-forget write of one marked request to land. */
const waitRow = async (label, min = {}) =>
  H.until(async () => {
    const row = await dayRow('/', refHost(label));
    return row && row.views >= (min.views ?? 1) && row.visits >= (min.visits ?? 1) ? row : null;
  }, { what: `the ${refHost(label)} row to land` });

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
    // The report test below asserts exact counts for today, and the direct/no-
    // referrer key ('/', '') is shared by every run against this database (the
    // marker rows are not). Today's totals are disposable; clear them once.
    await H.query(`DELETE FROM analytics_visit_daily WHERE day = ((now() AT TIME ZONE 'utc')::date)`);
  });
  after(H.stop);

  test('a page view by a real visitor is counted once, from outside', SKIP, async () => {
    const { res } = await H.req('/', {
      headers: { 'user-agent': DESKTOP_CHROME, accept: HTML_ACCEPT, referer: refererOf('counted') },
    });
    assert.equal(res.status, 200);
    const row = await waitRow('counted');
    assert.deepEqual({ views: row.views, visits: row.visits }, { views: 1, visits: 1 },
      'exactly one page load, and a visit because the referrer is external');
    assert.equal(row.visits, 1, 'an external arrival is a visit');
  });

  test('an external referrer is stored host-only', SKIP, async () => {
    // The request above came from https://www.<marker>/arrived/here?q=marker;
    // the row it produced carries neither www., path nor query.
    const row = await waitRow('counted');
    assert.ok(row, 'the row is there');
    const { rows } = await H.query(
      `SELECT count(*)::int AS n FROM analytics_visit_daily
        WHERE referrer_host LIKE '%arrived%' OR referrer_host LIKE 'www.%'
          OR referrer_host LIKE '%?%' OR path LIKE '%?%'`,
    );
    assert.equal(rows[0].n, 0, 'no full URL, no query, no www. anywhere in the totals');
  });

  test('machines and our own QA do not show up in the numbers', SKIP, async () => {
    const headless = await H.req('/', {
      headers: { 'user-agent': HEADLESS_CHROME, accept: HTML_ACCEPT, referer: refererOf('headless') },
    });
    assert.equal(headless.res.status, 200);
    const qa = await H.req('/', {
      headers: {
        'user-agent': MOBILE_SAFARI, accept: HTML_ACCEPT,
        'x-mailmint-qa': '42', referer: refererOf('qa'),
      },
    });
    assert.equal(qa.res.status, 200);
    // Give a (non-existent) write a fair chance to land, then assert silence.
    await sleep(800);
    assert.equal(await dayRow('/', refHost('headless')), null, 'headless Chrome recorded nothing');
    assert.equal(await dayRow('/', refHost('qa')), null, 'an x-mailmint-qa request recorded nothing');
    // And the real visitor's row from the previous tests is untouched.
    assert.deepEqual(await dayRow('/', refHost('counted')), { views: 1, visits: 1 });
  });

  test('DNT and Global Privacy Control requests are not counted', SKIP, async () => {
    for (const [label, header] of [['dnt', { dnt: '1' }], ['gpc', { 'sec-gpc': '1' }]]) {
      const { res } = await H.req('/', {
        headers: { 'user-agent': DESKTOP_CHROME, accept: HTML_ACCEPT, ...header, referer: refererOf(label) },
      });
      assert.equal(res.status, 200);
    }
    await sleep(800);
    assert.equal(await dayRow('/', refHost('dnt')), null, 'a DNT request recorded nothing');
    assert.equal(await dayRow('/', refHost('gpc')), null, 'a GPC request recorded nothing');
  });

  test('a same-site referrer counts a view but not a visit', SKIP, async () => {
    const before = await dayRow('/', '') || { views: 0, visits: 0 };
    const { res } = await H.req('/', {
      headers: {
        'user-agent': DESKTOP_CHROME, accept: HTML_ACCEPT,
        referer: 'https://mailmint.app.mintapis.com/docs?from=nav',
      },
    });
    assert.equal(res.status, 200);
    const row = await H.until(async () => {
      const r = await dayRow('/', '');
      return r && r.views === before.views + 1 ? r : null;
    }, { what: 'the same-site view to land' });
    assert.equal(row.visits, before.visits, 'arriving from the own site is not a visit');
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
    await H.until(async () => (await countForAccount('trial_start', accountId)) === 1, { what: 'trial_start event' });
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

  test('/api/operator/visits and /admin/stats.json answer only the operator', SKIP, async () => {
    const ua = { 'user-agent': DESKTOP_CHROME };

    // Logged out: not even a hint that the endpoints exist.
    assert.equal((await H.req('/api/operator/visits', { headers: ua })).res.status, 404,
      'logged-out gets the ordinary 404');
    assert.equal((await H.req('/admin/stats.json', { headers: ua })).res.status, 404,
      'the JSON view is gated the same way');

    // A normal account: the same answer on both.
    const muggle = await H.newAccount();
    assert.equal((await H.req('/api/operator/visits', { cookie: muggle.cookie, headers: ua })).res.status, 404,
      'a non-admin account gets the same 404');
    assert.equal((await H.req('/admin/stats.json', { cookie: muggle.cookie, headers: ua })).res.status, 404);
    assert.equal((await H.req('/admin/stats', { cookie: muggle.cookie, headers: ua })).res.status, 404,
      'the HTML view is gated the same way');

    // The allowlisted account (allowlisted in different case, see top) sees the counts.
    assert.ok(admin, 'the sign-up test ran first and left an admin session');
    const op = await H.req('/api/operator/visits?days=1', { cookie: admin.cookie, headers: ua });
    assert.equal(op.res.status, 200, `operator endpoint answered ${op.res.status}: ${op.text.slice(0, 200)}`);
    assert.equal(op.res.headers.get('cache-control'), 'no-store', 'operator data is never cached');
    assert.deepEqual(Object.keys(op.json).sort(), ['conversions', 'days', 'topPages', 'topReferrers'],
      'the documented report shape');
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(Array.isArray(op.json.days) && Array.isArray(op.json.topPages)
      && Array.isArray(op.json.topReferrers) && Array.isArray(op.json.conversions));
    const day = op.json.days.find((d) => d.date === today);
    assert.ok(day, 'today has counted page loads');
    assert.equal(day.uniques, null, 'unique visitors are not measured, and the report says so');
    assert.equal(day.views, 2, `today has our two counted page loads (got ${day.views})`);
    assert.equal(day.visits, 1, 'only the external arrival was a visit');
    const conv = op.json.conversions.find((c) => c.date === today);
    assert.ok(conv, 'today has account events');
    assert.ok(conv.signups >= 1, 'our counted sign-up is in the report');
    assert.ok(conv.trialStarts >= 1, 'our trial start is in the report');
    assert.ok(conv.paidConversions >= 1, 'our paid conversion is in the report');

    // /admin/stats.json returns the same object as the operator endpoint.
    const got = await H.req('/admin/stats.json?days=1', { cookie: admin.cookie, headers: ua });
    assert.equal(got.res.status, 200);
    assert.equal(got.res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(got.json, op.json, 'same report, same shape');

    // The admin page itself renders the numbers as HTML for a human.
    const html = await H.req('/admin/stats?days=1', { cookie: admin.cookie, headers: ua });
    assert.equal(html.res.status, 200);
    assert.ok(html.text.includes('Visitor statistics'), 'the HTML view carries its heading');
    assert.ok(html.text.includes('Top pages') && html.text.includes('Top referrers')
      && html.text.includes('Conversions'), 'the HTML view carries the report sections');
    assert.ok(html.text.includes(today), 'the daily table is rendered');
  });

  test('retention deletes a 14-month-old row and keeps a 12-month-old one', SKIP, async () => {
    const oldPath = `/retention-old-${RUN}`;
    const keepPath = `/retention-keep-${RUN}`;
    const monthsAgo = (n) => `((now() AT TIME ZONE 'utc')::date - interval '${n} months')::date`;
    await H.query(
      `INSERT INTO analytics_visit_daily (day, path, referrer_host, views, visits)
         VALUES (${monthsAgo(14)}, $1, '', 7, 7), (${monthsAgo(12)}, $2, '', 9, 9)`,
      [oldPath, keepPath],
    );
    // The business events share the same window.
    await H.query(
      `INSERT INTO analytics_events (kind, day, path)
         VALUES ('signup', ${monthsAgo(14)}, $1), ('signup', ${monthsAgo(12)}, $2)`,
      [oldPath, keepPath],
    );
    const deleted = await analytics.applyRetention();
    assert.ok(deleted >= 2, `retention reported its deletions (got ${deleted})`);
    const kept = async (path, table) => {
      const { rows } = await H.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE path = $1`, [path],
      );
      return rows[0].n;
    };
    assert.equal(await kept(oldPath, 'analytics_visit_daily'), 0, 'the 14-month totals are gone');
    assert.equal(await kept(keepPath, 'analytics_visit_daily'), 1, 'the 12-month totals stay');
    assert.equal(await kept(oldPath, 'analytics_events'), 0, 'the 14-month event is gone');
    assert.equal(await kept(keepPath, 'analytics_events'), 1, 'the 12-month event stays');
  });

  test('migration 11 folds old-style visit rows into the daily totals', SKIP, async () => {
    const { MIGRATIONS } = require('../src/migrate');
    const m11 = MIGRATIONS.find((m) => m.id === 11);
    assert.ok(m11, 'the fold migration ships with this build');
    const oldPath = `/docs/fold-${RUN}`;
    const oldDay = `((now() AT TIME ZONE 'utc')::date - 3)`;
    await H.query(
      `INSERT INTO analytics_events (kind, path, day, visitor_hash)
         VALUES ('visit', $1, ${oldDay}, 'fold-legacy-a'), ('visit', $1, ${oldDay}, 'fold-legacy-b')`,
      [oldPath],
    );
    // Re-run migration 11's fold and delete — exactly the statements that
    // shipped — against the legacy rows this test just inserted.
    for (const sql of m11.statements.slice(1)) await H.query(sql);
    const { rows } = await H.query(
      `SELECT views, visits FROM analytics_visit_daily
        WHERE day = ${oldDay} AND path = $1 AND referrer_host = ''`,
      [oldPath],
    );
    assert.deepEqual(rows, [{ views: 2, visits: 2 }],
      'both legacy page loads became one aggregate row');
    const { rows: leftovers } = await H.query(
      `SELECT count(*)::int AS n FROM analytics_events WHERE kind = 'visit' AND path = $1`,
      [oldPath],
    );
    assert.equal(leftovers[0].n, 0, 'the per-view rows are deleted after the fold');
  });
});
