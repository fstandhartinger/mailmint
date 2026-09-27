'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

/**
 * The one-time reveal of a new API key must survive more than one API process:
 * the POST that mints the key and the GET that shows it may land on different
 * containers. These tests drive the real sign-up and dashboard over HTTP, then
 * poke the store directly for the properties a browser cannot see — that the
 * row is ciphertext, single use, per session and short-lived.
 */

const KEY_RE = /mm_(?:live|test)_[A-Za-z0-9_-]{20,}/;
const auth = () => require('../src/auth');

let account;

before(async () => { await H.start(); account = await H.newAccount(); });
after(H.stop);

const pendingRows = async (sessionId) => (
  await H.query(`SELECT ciphertext, created_at FROM pending_key_reveals WHERE session_id = $1`, [sessionId])
).rows;

describe('the dashboard shows a new key exactly once', () => {
  test('after sign-up, the first dashboard load shows the full key and the second does not', async () => {
    // newAccount() has already made the first load and read the key off it.
    assert.match(account.key, /^mm_live_/);
    const again = await H.req('/dashboard', { cookie: account.cookie });
    assert.equal(again.res.status, 200);
    assert.equal(again.text.includes(account.key), false);
    assert.equal(KEY_RE.test(again.text), false);
  });

  for (const mode of ['live', 'test']) {
    test(`Create key (${mode}) shows the new key on the next dashboard load, once`, async () => {
      const made = await H.req('/dashboard/keys', {
        method: 'POST', cookie: account.cookie, form: true, body: { name: `reveal-${mode}`, mode },
      });
      assert.equal(made.res.status, 302);
      // The redirect itself never carries the key.
      assert.equal(KEY_RE.test(made.res.headers.get('location') || ''), false);

      const first = await H.req('/dashboard', { cookie: account.cookie });
      const shown = (first.text.match(KEY_RE) || [])[0];
      assert.ok(shown, 'the first load after Create key shows the key');
      assert.equal(shown.startsWith(`mm_${mode}_`), true);
      // It is a real, working key.
      assert.equal((await H.req('/v1/usage', { key: shown })).res.status, 200);

      const second = await H.req('/dashboard', { cookie: account.cookie });
      assert.equal(second.text.includes(shown), false);
    });
  }
});

describe('the pending-key store', () => {
  let accountId;
  before(async () => { ({ accountId } = await H.newAccount()); });

  const fresh = async () => {
    const sessionId = await auth().createSession(accountId);
    const key = auth().newApiKey('live');
    return { sessionId, key };
  };

  test('a fresh module (no shared memory) can take what another stashed, once', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);

    // Drop auth.js from the cache and load it again: the new module shares
    // nothing in memory with the one that stashed, as a second process would.
    const before = auth();
    delete require.cache[require.resolve('../src/auth')];
    const other = require('../src/auth');
    assert.notEqual(other, before);

    assert.equal(await other.takeKeyForSession(sessionId), key);
    assert.equal(await other.takeKeyForSession(sessionId), null);
  });

  test('the stored row is ciphertext, not the key', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);
    const rows = await pendingRows(sessionId);
    assert.equal(rows.length, 1);
    const { ciphertext } = rows[0];
    assert.equal(ciphertext.startsWith('v1.'), true);
    assert.equal(ciphertext.split('.').length, 4);
    assert.equal(ciphertext.includes(key), false);
    assert.equal(ciphertext.includes(key.slice('mm_live_'.length)), false);
    assert.equal(await auth().takeKeyForSession(sessionId), key);
  });

  test('another session cannot take it, and trying does not consume it', async () => {
    const { sessionId, key } = await fresh();
    const { sessionId: stranger } = await fresh();
    await auth().stashKeyForSession(sessionId, key);

    assert.equal(await auth().takeKeyForSession(stranger), null);
    assert.equal((await pendingRows(sessionId)).length, 1);
    assert.equal(await auth().takeKeyForSession(sessionId), key);
  });

  test('no session id means no key and no query', async () => {
    assert.equal(await auth().takeKeyForSession(null), null);
    assert.equal(await auth().takeKeyForSession(''), null);
  });

  test('a row older than ten minutes is not revealed, and is gone afterwards', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);
    await H.query(
      `UPDATE pending_key_reveals SET created_at = now() - interval '11 minutes' WHERE session_id = $1`, [sessionId],
    );
    assert.equal(await auth().takeKeyForSession(sessionId), null);
    assert.equal((await pendingRows(sessionId)).length, 0);
  });

  test('stale rows of other sessions are purged when anyone stashes', async () => {
    const stale = await fresh();
    await auth().stashKeyForSession(stale.sessionId, stale.key);
    await H.query(
      `UPDATE pending_key_reveals SET created_at = now() - interval '11 minutes' WHERE session_id = $1`, [stale.sessionId],
    );
    const other = await fresh();
    await auth().stashKeyForSession(other.sessionId, other.key);
    assert.equal((await pendingRows(stale.sessionId)).length, 0);
    assert.equal(await auth().takeKeyForSession(other.sessionId), other.key);
  });

  test('logging out removes the pending row with the session', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);
    assert.equal((await pendingRows(sessionId)).length, 1);
    await auth().destroySession(sessionId);
    assert.equal((await pendingRows(sessionId)).length, 0);
  });

  test('two concurrent takes on the same session: exactly one gets the key', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);
    const results = await Promise.all([auth().takeKeyForSession(sessionId), auth().takeKeyForSession(sessionId)]);
    assert.deepEqual(results.filter((r) => r !== null), [key]);
  });

  test('a newer stash on the same session replaces the older key', async () => {
    const { sessionId, key: older } = await fresh();
    const newer = auth().newApiKey('test');
    await auth().stashKeyForSession(sessionId, older);
    await auth().stashKeyForSession(sessionId, newer);
    assert.equal((await pendingRows(sessionId)).length, 1);
    assert.equal(await auth().takeKeyForSession(sessionId), newer);
    assert.equal(await auth().takeKeyForSession(sessionId), null);
  });

  test('a changed server secret yields null, not an error or the ciphertext', async () => {
    const { sessionId, key } = await fresh();
    await auth().stashKeyForSession(sessionId, key);
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = `rotated-${Date.now()}`;
    try {
      assert.equal(await auth().takeKeyForSession(sessionId), null);
    } finally {
      if (saved === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved;
    }
    assert.equal((await pendingRows(sessionId)).length, 0);
  });
});
