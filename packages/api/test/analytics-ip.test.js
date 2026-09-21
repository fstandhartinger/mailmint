'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test, describe, before, after } = require('node:test');

if (process.env.MAILMINT_ANALYTICS_IP_TEST !== '1') {
  test('synthetic analytics IP integration requires explicit disposable-fixture opt-in', {
    skip: 'Set MAILMINT_ANALYTICS_IP_TEST=1 and MAILMINT_TEST_DATABASE_URL for a disposable loopback database',
  }, () => {});
} else {
  registerFixtureTests();
}

function registerFixtureTests() {
  let fixture;
  try {
    fixture = new URL(process.env.MAILMINT_TEST_DATABASE_URL);
  } catch {
    throw new Error('analytics IP tests require an explicit disposable loopback database URL');
  }
  if (!['postgres:', 'postgresql:'].includes(fixture.protocol)
      || fixture.hostname !== '127.0.0.1'
      || !fixture.port || fixture.port === '5432'
      || !/^\/mailmint_test_[a-z0-9_]+$/.test(fixture.pathname)
      || fixture.search || fixture.hash) {
    throw new Error('analytics IP fixture must use 127.0.0.1, a nondefault port and a mailmint_test_ database without URL options');
  }
  const expectedIdentity = {
    name: fixture.pathname.slice(1), address: '127.0.0.1', port: Number(fixture.port),
  };

  const marker = crypto.randomBytes(16).toString('hex');
  const adminEmail = `synthetic-ip-admin-${marker}@mailmint-test.example`;
  const memberEmail = `synthetic-ip-member-${marker}@mailmint-test.example`;
  process.env.ANALYTICS_EXCLUDE_IPS = '10.9.8.7,::ffff:10.9.8.8,  ::FFFF:10.9.8.9  ';
  process.env.MAILMINT_ADMIN_EMAILS = adminEmail.toUpperCase();
  process.env.LOG_LEVEL = 'error';

  const H = require('./helpers');

  const browserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  // What a real navigation carries; without it the request is not a page load
  // at all, which would mask what these cases are out to prove.
  const htmlAccept = 'text/html,application/xhtml+xml';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cases = [
    { name: 'mapped request matches plain exclusion', ip: '::ffff:10.9.8.7', expected: 0 },
    { name: 'plain request matches mapped exclusion', ip: '10.9.8.8', expected: 0 },
    { name: 'case and whitespace exclusion matches', ip: '::ffff:10.9.8.9', expected: 0 },
    { name: 'nonexcluded positive control inserts exactly one visit', ip: '203.0.113.41', expected: 1 },
    { name: 'QA header excludes a nonexcluded address', ip: '203.0.113.42', expected: 0, qa: true },
    { name: 'headless UA excludes a nonexcluded address', ip: '203.0.113.43', expected: 0, headless: true },
  ].map((entry, index) => {
    const ua = `${entry.headless ? browserUa.replace('Chrome/', 'HeadlessChrome/') : browserUa} Synthetic/${marker}-${index}`;
    // Visits are daily totals now, so each case marks its one request with a
    // unique referring host to key its row on.
    const host = `${marker}-${index}.example`;
    return { ...entry, ua, host };
  });

  /** The aggregate row a case's marked request produces, if any. */
  async function countVisits(entry) {
    const { rows } = await H.query(
      `SELECT views, visits FROM analytics_visit_daily WHERE referrer_host = $1`,
      [entry.host],
    );
    return rows[0] || { views: 0, visits: 0 };
  }

  /** Exact totals of the whole aggregate table over the report window. */
  async function databaseVisits() {
    const { rows } = await H.query(
      `SELECT COALESCE(sum(views), 0)::int AS views, COALESCE(sum(visits), 0)::int AS visits
         FROM analytics_visit_daily
        WHERE day > ((now() AT TIME ZONE 'utc')::date - 30)`,
    );
    return rows[0];
  }

  async function signup(email) {
    const { res } = await H.req('/signup', {
      method: 'POST', form: true,
      body: { email, password: crypto.randomBytes(24).toString('hex') },
      headers: { 'user-agent': `${browserUa} Synthetic/${marker}-account`, 'x-mailmint-qa': 'synthetic' },
    });
    assert.equal(res.status, 302, 'synthetic signup succeeds through the real form');
    const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
      .filter(Boolean).map((value) => value.split(';')[0]).join('; ');
    assert.ok(Boolean(cookie), 'synthetic signup returns a session');
    const { rows } = await H.query('SELECT id FROM accounts WHERE email = $1', [email]);
    assert.equal(rows.length, 1, 'synthetic account persisted');
    return { cookie };
  }

  /** The operator report's totals, which must equal what the database holds. */
  async function reportedVisits(cookie) {
    const { res, json } = await H.req('/admin/stats.json?days=30', { cookie });
    assert.equal(res.status, 200, 'allowlisted synthetic admin can read stats');
    assert.ok(Boolean(json && Array.isArray(json.days)), 'stats supplies daily rows');
    const rows = json.days;
    const totals = rows.reduce((total, row) => {
      assert.equal(typeof row.views, 'number');
      assert.equal(typeof row.visits, 'number');
      assert.equal(row.uniques, null, 'uniques are documented as not measured');
      return { views: total.views + row.views, visits: total.visits + row.visits };
    }, { views: 0, visits: 0 });
    return totals;
  }

  describe('synthetic analytics IP visits over loopback and real Postgres', { concurrency: false, timeout: 90000 }, () => {
    let ready = false;
    let admin;
    let member;
    let baseline;
    const visitBaselines = new Map();

    before(async () => {
      const connection = await H.query(
        'SELECT current_database() AS name, host(inet_server_addr()) AS address, inet_server_port() AS port',
      );
      assert.deepEqual(connection.rows[0], expectedIdentity);
      await H.start();
      ready = true;
      assert.equal(new URL(H.base).hostname, '127.0.0.1');
      assert.equal(require('../src/server').app.get('trust proxy'), 1);
      admin = await signup(adminEmail);
      member = await signup(memberEmail);
      await sleep(800);
      baseline = await databaseVisits();
      assert.deepEqual(await reportedVisits(admin.cookie), baseline, 'admin baseline matches actual database');
      for (const entry of cases) visitBaselines.set(entry, await countVisits(entry));
    });

    after(async () => {
      try {
        if (ready) {
          await sleep(800);
          await H.query(
            `DELETE FROM analytics_visit_daily WHERE referrer_host LIKE $1`,
            [`${marker}-%.example`],
          );
          await H.query(
            `DELETE FROM analytics_events
              WHERE account_id IN (SELECT id FROM accounts WHERE email = ANY($1::text[]))`,
            [[adminEmail, memberEmail]],
          );
          await H.query('DELETE FROM accounts WHERE email = ANY($1::text[])', [[adminEmail, memberEmail]]);
          const { rows } = await H.query(
            `SELECT (SELECT count(*)::int FROM accounts WHERE email = ANY($1::text[])) AS accounts,
                    (SELECT count(*)::int FROM analytics_visit_daily
                      WHERE referrer_host LIKE $2) AS visits`,
            [[adminEmail, memberEmail], `${marker}-%.example`],
          );
          assert.deepEqual(rows[0], { accounts: 0, visits: 0 }, 'only this run\'s synthetic fixtures are removed');
        }
      } finally {
        await H.stop();
      }
    });

    for (const entry of cases) {
      test(`synthetic ${entry.name}`, async (t) => {
        const beforeCount = await countVisits(entry);
        assert.equal(beforeCount.views, visitBaselines.get(entry).views, 'fixture baseline is unchanged before its request');
        const headers = {
          'user-agent': entry.ua, accept: htmlAccept, 'x-forwarded-for': entry.ip,
          referer: `https://www.${entry.host}/arrived?q=marker`,
        };
        if (entry.qa) headers['x-mailmint-qa'] = 'synthetic';
        const { res } = await H.req('/', { headers });
        assert.equal(res.status, 200, 'actual public page finishes successfully');
        if (entry.expected === 1) {
          await H.until(async () => (await countVisits(entry)).views > beforeCount.views, {
            timeoutMs: 5000, everyMs: 50, what: 'synthetic positive-control upsert',
          });
        }
        await sleep(800);
        const afterCount = await countVisits(entry);
        assert.equal(afterCount.views - beforeCount.views, entry.expected, 'actual visit row delta after observation interval');
        t.diagnostic(`synthetic visit baseline=${beforeCount.views} after=${afterCount.views} delta=${afterCount.views - beforeCount.views}`);
      });
    }

    test('synthetic admin stats show exactly the visit delta; anonymous and nonadmin return 404', async (t) => {
      const anonymous = await H.req('/admin/stats.json');
      assert.equal(anonymous.res.status, 404);
      const anonymousOperator = await H.req('/api/operator/visits');
      assert.equal(anonymousOperator.res.status, 404);
      const nonadmin = await H.req('/admin/stats.json', { cookie: member.cookie });
      assert.equal(nonadmin.res.status, 404);
      const current = await databaseVisits();
      const reported = await reportedVisits(admin.cookie);
      assert.deepEqual(reported, current, 'reported totals match the real database');
      assert.equal(current.views - baseline.views, 1, 'exactly one synthetic visit in aggregate');
      assert.equal(reported.views - baseline.views, 1, 'admin reports exactly the synthetic visit delta');
      for (const entry of cases) {
        assert.equal((await countVisits(entry)).views - visitBaselines.get(entry).views, entry.expected,
          'each synthetic fixture retains its exact delta at the final read');
      }
      t.diagnostic(`synthetic aggregate baseline=${baseline.views} after=${current.views} delta=${current.views - baseline.views}`);
    });
  });
}
