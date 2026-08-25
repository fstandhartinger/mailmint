'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { ApiError } = require('./errors');
const { PLANS } = require('./config');

const LIVE_PREFIX = 'mm_live_';
const TEST_PREFIX = 'mm_test_';

/**
 * Keys are stored as sha256 of the key plus a per-key salt, never in the clear.
 *
 * sha256 rather than bcrypt because this runs on the hot path of every API call
 * and the input is 24 bytes of CSPRNG output, not a human password — there is
 * no dictionary to slow an attacker down against, so the cost factor buys
 * nothing and costs latency on every request. The salt is per key and stored
 * with it, so two accounts that somehow minted the same key still hash apart
 * and a stolen table cannot be attacked with one precomputed set.
 *
 * Passwords are a different problem and do use bcrypt, below.
 */
function newApiKey(mode = 'live') {
  const prefix = mode === 'test' ? TEST_PREFIX : LIVE_PREFIX;
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

const keyMode = (key) => (String(key).startsWith(TEST_PREFIX) ? 'test' : 'live');

function hashKey(key, salt) {
  return crypto.createHash('sha256').update(`${salt}:${key}`, 'utf8').digest('hex');
}

/**
 * The stored `hash` column is `salt$digest`. Lookup cannot be a plain index hit
 * because the salt is per row, so the visible prefix — 16 characters, which is
 * not enough to reconstruct the key — narrows the scan to the handful of rows
 * that could possibly match, and the digest decides.
 */
const keyPrefixOf = (key) => String(key).slice(0, 16);

async function issueApiKey(accountId, name = 'default', mode = 'live') {
  const key = newApiKey(mode);
  const salt = crypto.randomBytes(12).toString('hex');
  await query(
    `INSERT INTO api_keys (account_id, prefix, hash, name) VALUES ($1, $2, $3, $4)`,
    [accountId, keyPrefixOf(key), `${salt}$${hashKey(key, salt)}`, String(name).slice(0, 60)],
  );
  return key;
}

async function createAccount(email, password) {
  const normalised = String(email).trim().toLowerCase();
  const hash = await bcrypt.hash(String(password), 10);
  const { rows } = await query(
    `INSERT INTO accounts (email, password_hash, plan, quota_month) VALUES ($1, $2, 'free', $3) RETURNING *`,
    [normalised, hash, PLANS.free.quota],
  );
  const account = rows[0];
  const apiKey = await issueApiKey(account.id, 'default', 'live');
  return { account, apiKey };
}

async function verifyLogin(email, password) {
  const { rows } = await query(`SELECT * FROM accounts WHERE email = $1`, [String(email).trim().toLowerCase()]);
  if (!rows.length) return null;
  const ok = await bcrypt.compare(String(password), rows[0].password_hash);
  return ok ? rows[0] : null;
}

/** Rolls the monthly window forward lazily, so quota needs no cron. */
async function rollPeriod(account) {
  const start = new Date(account.period_start);
  const now = new Date();
  if (start.getUTCFullYear() === now.getUTCFullYear() && start.getUTCMonth() === now.getUTCMonth()) return account;
  const { rows } = await query(
    `UPDATE accounts SET used_month = 0, period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
     WHERE id = $1 RETURNING *`,
    [account.id],
  );
  return rows[0] || account;
}

function extractKey(req) {
  const header = req.get('authorization');
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  const xkey = req.get('x-api-key');
  return xkey ? xkey.trim() : null;
}

async function authenticate(req) {
  const key = extractKey(req);
  if (!key) {
    throw new ApiError(401, 'missing_api_key', 'No API key was sent with this request.', {
      hint: 'Send the header "Authorization: Bearer mm_live_…". Your key is on the dashboard at /dashboard.',
      docs: '/docs#authentication',
    });
  }
  if (!key.startsWith(LIVE_PREFIX) && !key.startsWith(TEST_PREFIX)) {
    throw new ApiError(401, 'invalid_api_key', 'That does not look like a MailMint API key.', {
      hint: 'MailMint keys start with "mm_live_" (or "mm_test_" for a key that parses but is never billed). Keys are shown once; create another at /dashboard if you no longer have yours.',
      docs: '/docs#authentication',
    });
  }
  const { rows } = await query(
    `SELECT k.id AS key_id, k.hash, k.prefix, a.* FROM api_keys k JOIN accounts a ON a.id = k.account_id
     WHERE k.prefix = $1 AND k.revoked_at IS NULL`,
    [keyPrefixOf(key)],
  );
  // Constant-time over the candidate rows: the digest decides, and comparing it
  // with timingSafeEqual keeps the comparison from leaking a prefix match.
  let matched = null;
  for (const row of rows) {
    const [salt, digest] = String(row.hash).split('$');
    if (!salt || !digest) continue;
    const candidate = Buffer.from(hashKey(key, salt), 'hex');
    const stored = Buffer.from(digest, 'hex');
    if (candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored)) { matched = row; break; }
  }
  if (!matched) {
    throw new ApiError(401, 'invalid_api_key', 'This API key is not valid, or it has been revoked.', {
      hint: 'Keys cannot be read back after they are created. Make a new one at /dashboard; a revoked key stops working on the very next request.',
      docs: '/docs#authentication',
    });
  }
  const { key_id: keyId, hash, prefix, ...account } = matched;
  // Fire and forget: last_used_at is for the dashboard, not for correctness.
  query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyId]).catch(() => {});
  const rolled = await rollPeriod(account);
  rolled.key_prefix = prefix;
  rolled.key_mode = keyMode(key);
  return rolled;
}

async function revokeApiKey(accountId, prefix) {
  const { rows: live } = await query(
    `SELECT prefix FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL`, [accountId],
  );
  if (live.length <= 1) {
    throw new ApiError(409, 'last_key', 'This is the only key on the account, so revoking it would lock you out.', {
      hint: 'Create a replacement key first, then revoke this one.',
      docs: '/docs#authentication',
    });
  }
  const { rowCount } = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE account_id = $1 AND prefix = $2 AND revoked_at IS NULL`,
    [accountId, prefix],
  );
  return rowCount;
}

/**
 * Takes `n` from this month's quota if there is room.
 *
 * Returns `{ok:false}` rather than throwing, because the caller that matters
 * most — /internal/deliver — must NOT bounce the mail when the answer is no.
 * The message is stored and flagged; only the LLM pass is skipped.
 */
async function consumeQuota(accountId, n = 1) {
  const { rows } = await query(
    `UPDATE accounts SET used_month = used_month + $2
      WHERE id = $1 AND used_month + $2 <= quota_month
      RETURNING used_month, quota_month, plan`,
    [accountId, n],
  );
  if (rows.length) {
    const r = rows[0];
    return { ok: true, used: r.used_month, limit: r.quota_month, remaining: r.quota_month - r.used_month, plan: r.plan };
  }
  const { rows: cur } = await query(`SELECT used_month, quota_month, plan FROM accounts WHERE id = $1`, [accountId]);
  const a = cur[0] || { used_month: 0, quota_month: 0, plan: 'free' };
  return { ok: false, used: a.used_month, limit: a.quota_month, remaining: 0, plan: a.plan };
}

const refundQuota = (accountId, n = 1) => query(
  `UPDATE accounts SET used_month = GREATEST(0, used_month - $2) WHERE id = $1`, [accountId, n],
).catch(() => {});

/** The API-key form of the same check, which SHOULD refuse rather than degrade. */
async function requireQuota(account, n = 1) {
  if (account.key_mode === 'test') return { ok: true, test: true, remaining: null };
  const r = await consumeQuota(account.id, n);
  if (!r.ok) {
    throw new ApiError(402, 'quota_exceeded',
      `You have used all ${r.limit} emails included in your ${r.plan} plan this month.`, {
        hint: 'Mail sent to your addresses is still received and stored — it is only the parsing that stops. The quota resets on the 1st; upgrade at /dashboard to raise it now.',
        docs: '/docs#quota',
        details: { plan: r.plan, used: r.used, limit: r.limit },
      });
  }
  return r;
}

/* ---------------------------------------------------------------- sessions */

async function createSession(accountId) {
  const id = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [id, accountId]);
  return id;
}

/**
 * A freshly minted key is handed to the dashboard once, through the session
 * rather than the URL. A key in a query string ends up in browser history, in
 * Referer headers, and in every proxy log between here and the user.
 */
const pendingKeys = new Map();
const stashKeyForSession = (sessionId, key) => {
  pendingKeys.set(sessionId, { key, at: Date.now() });
  setTimeout(() => pendingKeys.delete(sessionId), 10 * 60 * 1000).unref();
};
function takeKeyForSession(sessionId) {
  const e = pendingKeys.get(sessionId);
  if (!e) return null;
  pendingKeys.delete(sessionId);
  return Date.now() - e.at < 10 * 60 * 1000 ? e.key : null;
}

async function accountForSession(sessionId) {
  if (!sessionId) return null;
  const { rows } = await query(
    `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  return rows.length ? rollPeriod(rows[0]) : null;
}

const destroySession = (id) => query(`DELETE FROM sessions WHERE id = $1`, [id]).catch(() => {});

/**
 * Constant-time comparison of the shared secret that guards /internal/*.
 * `!==` on a secret leaks its length and its first differing byte to anyone who
 * can time the response, and the mail VPS calls this on every message.
 */
function internalSecretMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  // Hash both first so the compare is over equal-length buffers and the length
  // of the presented value stays hidden.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = {
  LIVE_PREFIX, TEST_PREFIX, newApiKey, keyMode, issueApiKey, createAccount, verifyLogin,
  authenticate, revokeApiKey, consumeQuota, refundQuota, requireQuota, rollPeriod,
  createSession, accountForSession, destroySession, stashKeyForSession, takeKeyForSession,
  internalSecretMatches,
};
