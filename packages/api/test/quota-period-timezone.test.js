'use strict';

// Every connection this file opens runs in Europe/Berlin, which is what the
// production database is set to. node-postgres passes PGOPTIONS to the server
// at connect time, so this must be set before src/db builds its pool.
process.env.PGOPTIONS = `${process.env.PGOPTIONS || ''} -c TimeZone=Europe/Berlin`.trim();

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers');
const auth = require('../src/auth');
const billing = require('../src/billing');

/**
 * The monthly counter reset on EVERY request, so no plan limit was enforced.
 *
 * period_start was written as date_trunc('month', now() AT TIME ZONE 'UTC'), a
 * timestamp without zone. Stored into a TIMESTAMPTZ column it is read in the
 * session's zone: on a Europe/Berlin database "1 Nov 00:00" became 31 Oct 23:00
 * UTC. rollPeriod() compares UTC year and month, saw October, reset the counter
 * and wrote the same wrong instant again. A database in UTC hid all of it, which
 * is why this file pins the zone itself.
 */
describe('the quota month holds on a database that is not in UTC', () => {
  const monthStartUtc = () => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  };
  const row = async (id) => (await H.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];

  /** One billed API call: a real authenticated request (which rolls the period), then the charge. */
  async function request(key, accountId) {
    const usage = await H.req('/v1/usage', { key });
    assert.equal(usage.res.status, 200);
    return auth.consumeQuota(accountId, 1);
  }

  before(async () => {
    await H.start();
    const { rows } = await H.query('SHOW TimeZone');
    assert.equal(rows[0].TimeZone, 'Europe/Berlin', 'this file is only meaningful with a non-UTC session zone');
  });
  after(H.stop);

  test('a new account starts its period at 00:00 UTC on the 1st', async () => {
    const { accountId } = await H.newAccount();
    assert.equal(new Date((await row(accountId)).period_start).toISOString(), new Date(monthStartUtc()).toISOString());
  });

  test('N requests inside one month count N, and the free quota is enforced', async () => {
    const { key, accountId } = await H.newAccount();
    await H.query('UPDATE accounts SET quota_month = 3 WHERE id = $1', [accountId]);
    for (let i = 1; i <= 3; i += 1) {
      const r = await request(key, accountId);
      assert.equal(r.ok, true);
      assert.equal(Number(r.used), i, `request ${i} must be the ${i}th of the month, not the first again`);
    }
    assert.equal((await request(key, accountId)).ok, false, 'the fourth is over the quota');
    const usage = await H.req('/v1/usage', { key });
    assert.equal(usage.json.used, 3);
    assert.equal(usage.json.remaining, 0);
    assert.equal(usage.json.period_start, new Date(monthStartUtc()).toISOString());
  });

  test('an account still carrying the old, zone-shifted period start is corrected once and then counts', async () => {
    const { key, accountId } = await H.newAccount();
    // Exactly what the old code stored: a zone-less month start read as Berlin time.
    await H.query(
      `UPDATE accounts SET used_month = 7,
              period_start = (date_trunc('month', now() AT TIME ZONE 'UTC'))::timestamp AT TIME ZONE 'Europe/Berlin'
        WHERE id = $1`, [accountId],
    );
    assert.notEqual(new Date((await row(accountId)).period_start).getTime(), monthStartUtc(), 'the fixture must hold the shifted instant');

    assert.equal(Number((await request(key, accountId)).used), 1, 'the first request after the fix starts the month over');
    assert.equal(new Date((await row(accountId)).period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, accountId)).used), 2);
    assert.equal(Number((await request(key, accountId)).used), 3);
  });

  test('a real month change resets the counter exactly once', async () => {
    const { key, accountId } = await H.newAccount();
    await H.query(
      `UPDATE accounts SET used_month = 9,
              period_start = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC'
        WHERE id = $1`, [accountId],
    );
    assert.equal(Number((await request(key, accountId)).used), 1, 'the new month starts from zero');
    assert.equal(new Date((await row(accountId)).period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, accountId)).used), 2, 'and is not reset a second time');
  });

  test('invoice.paid inside the current month leaves the counter alone, and writes 00:00 UTC when the month did turn', async () => {
    const { key, accountId } = await H.newAccount();
    const customerId = `cus_test_tz_${crypto.randomBytes(6).toString('hex')}`;
    await H.query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1', [accountId, customerId]);
    await request(key, accountId);
    await request(key, accountId);

    await billing.handleEvent({ id: `evt_test_tz_${crypto.randomBytes(6).toString('hex')}`, type: 'invoice.paid', data: { object: { customer: customerId } } });
    assert.equal(Number((await row(accountId)).used_month), 2, 'a renewal inside the month must not reset');

    await H.query(
      `UPDATE accounts SET period_start = (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC'
        WHERE id = $1`, [accountId],
    );
    await billing.handleEvent({ id: `evt_test_tz_${crypto.randomBytes(6).toString('hex')}`, type: 'invoice.paid', data: { object: { customer: customerId } } });
    const after = await row(accountId);
    assert.equal(Number(after.used_month), 0);
    assert.equal(new Date(after.period_start).getTime(), monthStartUtc());
    assert.equal(Number((await request(key, accountId)).used), 1, 'the next request counts instead of resetting again');
  });
});
