'use strict';

/**
 * First-party visitor statistics.
 *
 * What this is: a count, in our own database, of page views, sign-ups and paid
 * upgrades. What it deliberately is not: a tracker. Nothing is shared with a
 * third party, no cookie is set, and the only per-visitor value ever stored is
 * `visitor_hash` — a one-way HMAC of IP and user agent under a key derived
 * from the UTC day. That daily key is itself never stored, so the same visitor
 * hashes differently tomorrow and the IP cannot be recovered from the row.
 *
 * Loading this module must never touch the database: the unit tests import it
 * without a DATABASE_URL. The pg pool is therefore required lazily, on the
 * first call that actually writes or reads.
 */

const crypto = require('node:crypto');
const { config } = require('./config');
const { log } = require('./log');

const KINDS = new Set(['visit', 'signup', 'trial_start', 'paid_conversion']);

/**
 * Anything that is not a person reading the marketing site. Matched on the
 * user agent only — that is what every synthetic-check, bot and script tool
 * we care about actually sends. Also covers: an explicit QA header for our own
 * test runs, and a comma-separated IP allowlist from the environment for
 * machines we operate that look like browsers.
 */
const INTERNAL_UA = /headless|playwright|puppeteer|selenium|phantom|curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|undici|axios|go-http-client|java\/|okhttp|bot|crawl|spider|slurp|monitor|uptime|lighthouse|pingdom|scan/i;

function isInternalTraffic(req) {
  const headers = (req && req.headers) || {};
  const ua = headers['user-agent'];
  if (!ua || INTERNAL_UA.test(String(ua))) return true;
  if (headers['x-mailmint-qa'] !== undefined) return true;
  const ip = req && req.ip;
  if (ip && config.analyticsExcludeIps.includes(String(ip))) return true;
  return false;
}

/**
 * The key stays in this process. Prefer the env var so a fleet shares one
 * value; a random fallback (generated once, here) keeps a single-process
 * deployment working with no configuration at all — at the price of hashes
 * changing on restart, which only shifts day boundaries slightly.
 */
const processSecret = process.env.ANALYTICS_SALT_SECRET || crypto.randomBytes(32);

const utcDay = (d) => d.toISOString().slice(0, 10);

/** The per-day key, derived from the process secret. Never stored anywhere. */
function daySalt(date) {
  return crypto.createHmac('sha256', processSecret).update(utcDay(date)).digest();
}

/**
 * One-way daily code for one visitor. Contains no recoverable IP: it is the
 * HMAC of `ip|ua` under the day's key, and that key is HMAC of the date under
 * a secret that never leaves the process.
 */
function visitorHash(ip, ua, date = new Date()) {
  return crypto.createHmac('sha256', daySalt(date))
    .update(`${ip || ''}|${ua || ''}`, 'utf8')
    .digest('hex');
}

/**
 * Fire-and-forget by contract: analytics must never hold up or break the
 * request that produced it. Any failure lands in one warn log line with the
 * error message only — never the event contents, which are the point of the
 * exercise.
 */
function recordEvent(kind, { path = null, visitorHash: vh = null, accountId = null } = {}) {
  if (!KINDS.has(kind)) {
    // Faulty caller, not a fault — but it must also not stay silent.
    log.warn('analytics.record_failed', { message: `unknown event kind "${kind}"` });
    return;
  }
  Promise.resolve()
    // eslint-disable-next-line global-require
    .then(() => require('./db').query(
      `INSERT INTO analytics_events (kind, path, visitor_hash, account_id) VALUES ($1, $2, $3, $4)`,
      [kind, path || null, vh || null, accountId || null],
    ))
    .catch((e) => log.warn('analytics.record_failed', { message: String((e && e.message) || e) }));
}

/** The marketing-site pages a visit count means something for. */
const PUBLIC_PATHS = new Set([
  '/', '/docs', '/quickstart', '/n8n', '/signup', '/login',
  '/privacy', '/impressum', '/terms',
  '/email-parsing-api', '/mailparser-alternative', '/parseur-alternative',
  '/zapier-email-parser-alternative', '/docparser-alternative',
  '/parse-invoice-emails', '/parse-order-confirmation-emails',
  '/parse-shipping-notification-emails', '/parse-lead-emails',
]);

const isPublicPath = (p) => PUBLIC_PATHS.has(p) || p.startsWith('/docs/');

/**
 * Counts a page view for a real visitor on a public page. The decision happens
 * at `finish` — after the response has been handed to the socket — so counting
 * can never delay the answer, and a redirect or an error page is not a visit.
 */
function visitMiddleware(req, res, next) {
  if (req.method === 'GET' && isPublicPath(req.path)) {
    res.on('finish', () => {
      try {
        if (res.statusCode < 200 || res.statusCode > 299) return;
        if (isInternalTraffic(req)) return;
        recordEvent('visit', {
          path: req.path,
          visitorHash: visitorHash(req.ip, (req.headers || {})['user-agent'] || ''),
        });
      } catch { /* analytics must never throw at a request */ }
    });
  }
  return next();
}

/**
 * The reporting shape: one row per day per event kind for the last `days`
 * days, plus the number of distinct daily visitor codes for visits (a rough
 * "people, not views" number that resets every day by construction).
 */
async function stats(days = 30) {
  // eslint-disable-next-line global-require
  const { query } = require('./db');
  const { rows } = await query(
    `SELECT day, kind, count(*)::int AS events,
            count(DISTINCT visitor_hash) FILTER (WHERE kind = 'visit')::int AS visitors
       FROM analytics_events
      WHERE day > ((now() AT TIME ZONE 'utc')::date - $1::int)
      GROUP BY day, kind
      ORDER BY day DESC, kind`,
    [days],
  );
  return rows;
}

module.exports = { isInternalTraffic, visitorHash, recordEvent, visitMiddleware, stats, PUBLIC_PATHS };
