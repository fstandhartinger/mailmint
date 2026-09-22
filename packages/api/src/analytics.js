'use strict';

/**
 * First-party visitor statistics, aggregate and identifier-free.
 *
 * What this is: a count, in our own database, of the page loads we serve
 * anyway, plus sign-ups and paid upgrades. What it deliberately is not: a
 * tracker. Nothing is written to or read from the visitor's device for this —
 * no cookie, no storage, no script. No identifier is derived either: the IP
 * address and user agent are read only to filter automated and internal
 * traffic, and are neither stored nor hashed. What is stored are daily totals
 * per page and referring host name. Unique visitors are therefore not
 * measured; "visits" counts page loads that arrived from outside the site (no
 * same-site referrer). The counting decision happens at `finish` — after the
 * response has been handed to the socket — so it can never delay the answer.
 *
 * Loading this module must never touch the database: the unit tests import it
 * without a DATABASE_URL. The pg pool is therefore required lazily, on the
 * first call that actually writes or reads.
 */

const net = require('node:net');
const { config } = require('./config');
const { log } = require('./log');

/**
 * Business events only — a visit is written to analytics_visit_daily, never
 * here, so no per-visitor row of any kind exists.
 */
const KINDS = new Set(['signup', 'trial_start', 'paid_conversion']);

/** Days of aggregate statistics the reaper keeps before deleting them. */
const RETENTION_MONTHS = 13;
/** The operator report never shows a page or referrer row with fewer page loads than this (no single-visit facts). */
const MIN_REPORT_COUNT = 3;
/** Report rows beyond the top N fold into one "(other)" row. */
const REPORT_TOP = 25;

/**
 * Anything that is not a person reading the marketing site. Matched on the
 * user agent only — that is what every synthetic-check, bot, link-preview and
 * AI-crawler tool we care about actually sends. Also covers: an explicit QA
 * header for our own test runs, and a comma-separated IP allowlist from the
 * environment for machines we operate that look like browsers. The user agent
 * is read only for this test and never stored.
 */
const INTERNAL_UA = /headless|playwright|puppeteer|selenium|phantom|curl|wget|python|aiohttp|httpx|node-fetch|undici|axios|go-http-client|java\/|okhttp|bot|crawl|spider|slurp|preview|fetch|scan|monitor|uptime|lighthouse|pingdom|libwww|facebookexternalhit|embedly|quora|whatsapp|telegram|discord|skype|vkshare|w3c_validator|gptbot|chatgpt|claude|anthropic|perplexity|bytespider|ccbot|amazonbot|applebot|bingpreview/i;

/**
 * Expand a validated IPv6 string into its eight 16-bit groups.
 * Precondition: `ip` is lowercase and `net.isIPv6(ip)` holds, so the split
 * logic below only has to cover the grammar that validator accepts — a
 * single `::`, hextets of 1–4 hex digits, and at most one trailing
 * dotted-quad for the low 32 bits.
 */
const expandIpv6 = (ip) => {
  let s = ip;
  let tail = [];
  const v4 = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, v4.index);
  }
  const [leftRaw, rightRaw] = s.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  return [...left, ...Array(8 - left.length - right.length - tail.length).fill(0), ...right, ...tail];
};

/**
 * Re-compress eight groups to the RFC 5952 canonical spelling: lowercase,
 * leading zeros stripped, and the LONGEST run of two or more zero groups
 * reduced to `::` (the first such run when several tie).
 */
const compressIpv6 = (groups) => {
  let bestStart = -1;
  let bestLen = 1; // strict: a lone zero group is never compressed
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
};

/** RFC 4291 IPv4-mapped form: 80 zero bits, then 0xffff, then the IPv4. */
const mappedV4 = (groups) => groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0);

/**
 * One spelling per IP, so the internal-traffic exclusion list cannot be
 * bypassed — or silently broken — by writing the same address two ways:
 * IPv4 stays as written; an IPv4-mapped IPv6 (`::ffff:a.b.c.d`, any case)
 * unwraps to the plain IPv4; every other IPv6 is rewritten to the RFC 5952
 * canonical form, so `2001:0DB8:0:0::5`, `2001:db8::5` and
 * `2001:db8:0:0:0:0:0:5` all compare equal. Anything that is not an IP at
 * all — null, a number, garbage, a zone id like `fe80::1%eth0` — degrades
 * to a trimmed lowercase string that simply matches nothing. This runs on
 * every request, so it must never throw.
 */
const normalizeIp = (value) => {
  let lower;
  try {
    lower = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  } catch { return ''; }
  if (net.isIPv4(lower)) return lower;
  if (lower.startsWith('::ffff:') && net.isIPv4(lower.slice(7))) return lower.slice(7);
  // A zone id names one interface of one machine, not an address the
  // exclusion list can carry: keep it a plain string.
  if (lower.includes('%')) return lower;
  if (net.isIPv6(lower)) {
    try {
      const groups = expandIpv6(lower);
      if (mappedV4(groups)) {
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
      }
      return compressIpv6(groups);
    } catch { return lower; }
  }
  return lower;
};

function isInternalTraffic(req) {
  const headers = (req && req.headers) || {};
  const ua = headers['user-agent'];
  if (!ua || INTERNAL_UA.test(String(ua))) return true;
  if (headers['x-mailmint-qa'] !== undefined) return true;
  const ip = normalizeIp(req && req.ip);
  if (ip && config.analyticsExcludeIps.some((entry) => normalizeIp(entry) === ip)) return true;
  return false;
}

/** Referring hosts that mean "this page was reached from within this site". */
const OWN_HOSTS = new Set(['mailmint.app.mintapis.com', 'localhost', '127.0.0.1']);

/** The host of PUBLIC_URL counts as our own site too, whatever it is deployed as. */
const hostOf = (value) => {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};
if (config.publicUrl) {
  const own = hostOf(config.publicUrl);
  if (own) OWN_HOSTS.add(own);
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

/**
 * `/quickstart/` is the same page as `/quickstart`: Express serves both (its
 * routing is not strict), so a trailing slash must not drop the page load on
 * the floor. Trailing slashes (one or more) are stripped from any path
 * longer than `/`; `/` itself stays `/`.
 */
const pagePath = (p) => {
  const s = String(p || '/');
  return s.length > 1 ? s.replace(/\/+$/, '') || '/' : s;
};

const isPublicPath = (p) => {
  const path = pagePath(p);
  return PUBLIC_PATHS.has(path) || path.startsWith('/docs/');
};

/**
 * Decide whether one incoming request is a page view to count, and what to
 * file it under. Pure — no database, no side effects — so the unit tests can
 * run it against bare request objects. Returns null for anything that is not
 * a countable full page load.
 */
function classifyRequest(req) {
  if (!req || req.method !== 'GET') return null;
  const path = pagePath(req.path);
  if (!isPublicPath(path)) return null;
  const headers = (req && req.headers) || {};
  // Objection signals the browser already sends: Global Privacy Control and
  // Do Not Track.
  if (headers['sec-gpc'] === '1' || headers['dnt'] === '1') return null;
  // Browser prefetch/prerender of a document is not a view.
  if (/prefetch|prerender/i.test(`${headers['sec-purpose'] || ''} ${headers['purpose'] || ''}`)) return null;
  // Only full page loads: a document request, or — when the header is absent
  // from an older browser — a navigation-shaped Accept.
  const dest = headers['sec-fetch-dest'];
  if (dest ? dest !== 'document' : !String(headers.accept || '').includes('text/html')) return null;
  if (isInternalTraffic(req)) return null;
  const ref = headers.referer;
  const refHost = ref ? hostOf(ref) : null;
  const sameSite = refHost !== null && OWN_HOSTS.has(refHost);
  return {
    path,
    referrerHost: refHost && !sameSite ? refHost.slice(0, 100) : '',
    visit: !sameSite,
  };
}

/** UTC calendar day of a timestamp, YYYY-MM-DD — the `day` everywhere here. */
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Fire-and-forget by contract: analytics must never hold up or break the
 * request that produced it. Any failure lands in one warn log line with the
 * error message only — never the event contents, which are the point of the
 * exercise.
 */
function recordEvent(kind, { path = null, accountId = null } = {}) {
  if (!KINDS.has(kind)) {
    // Faulty caller, not a fault — but it must also not stay silent.
    log.warn('analytics.record_failed', { message: `unknown event kind "${kind}"` });
    return;
  }
  Promise.resolve()
    // eslint-disable-next-line global-require
    .then(() => require('./db').query(
      `INSERT INTO analytics_events (kind, path, account_id) VALUES ($1, $2, $3)`,
      [kind, path || null, accountId || null],
    ))
    .catch((e) => log.warn('analytics.record_failed', { message: String((e && e.message) || e) }));
}

/** One increment into the daily totals. Views +1, visits +1 only from outside. */
function countVisit(hit) {
  Promise.resolve()
    // eslint-disable-next-line global-require
    .then(() => require('./db').query(
      `INSERT INTO analytics_visit_daily (day, path, referrer_host, views, visits)
         VALUES ($1::date, $2, $3, 1, $4::int)
       ON CONFLICT (day, path, referrer_host)
         DO UPDATE SET views = analytics_visit_daily.views + 1,
                       visits = analytics_visit_daily.visits + EXCLUDED.visits`,
      [utcDay(), hit.path, hit.referrerHost, hit.visit ? 1 : 0],
    ))
    .catch((e) => log.warn('analytics.record_failed', { message: String((e && e.message) || e) }));
}

/**
 * Counts a page view for a real visitor on a public page. The 2xx check and
 * the counting both sit at `finish` — after the response has been handed to
 * the socket — so counting can never delay the answer, and a redirect or an
 * error page is not a visit.
 */
function visitMiddleware(req, res, next) {
  if (req.method === 'GET' && isPublicPath(req.path)) {
    res.on('finish', () => {
      try {
        if (res.statusCode < 200 || res.statusCode > 299) return;
        const hit = classifyRequest(req);
        if (hit) countVisit(hit);
      } catch { /* analytics must never throw at a request */ }
    });
  }
  return next();
}

/** Delete aggregate rows older than the retention period. Returns the rows deleted. */
async function applyRetention() {
  // eslint-disable-next-line global-require
  const { query } = require('./db');
  const visits = (await query(
    `DELETE FROM analytics_visit_daily
      WHERE day < ((now() AT TIME ZONE 'utc')::date - interval '${RETENTION_MONTHS} months')`,
  )).rowCount;
  const events = (await query(
    `DELETE FROM analytics_events
      WHERE day < ((now() AT TIME ZONE 'utc')::date - interval '${RETENTION_MONTHS} months')`,
  )).rowCount;
  return visits + events;
}

/**
 * The fold the operator report uses: the top rows that clear MIN_REPORT_COUNT,
 * everything else — below the threshold or beyond the top — combined into one
 * "(other)" row, so no single-visit fact is ever named. Pure, for the unit
 * tests.
 */
function fold(rows, countKey, label, keys) {
  const shown = rows.filter((r) => r[countKey] >= MIN_REPORT_COUNT).slice(0, REPORT_TOP);
  const rest = rows.filter((r) => !shown.includes(r));
  if (!rest.length) return shown;
  const other = { [label]: '(other)' };
  for (const k of keys) other[k] = rest.reduce((acc, r) => acc + r[k], 0);
  return [...shown, other];
}

/**
 * Aggregate report for the operator: totals per UTC day (unique visitors are
 * not measured — counting them would need an identifier), the top pages and
 * referring hosts with at least MIN_REPORT_COUNT page loads plus one "(other)"
 * row for the rest, and the account-level business events per day.
 */
async function visitReport(days = 30) {
  const n = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  // eslint-disable-next-line global-require
  const { query } = require('./db');
  const since = `((now() AT TIME ZONE 'utc')::date - ${n - 1})`;
  const [daily, pages, referrers, conversions] = await Promise.all([
    query(`SELECT to_char(day, 'YYYY-MM-DD') AS date, sum(views)::int AS views, sum(visits)::int AS visits
             FROM analytics_visit_daily WHERE day >= ${since} GROUP BY day ORDER BY day`),
    query(`SELECT path, sum(views)::int AS views, sum(visits)::int AS visits
             FROM analytics_visit_daily WHERE day >= ${since} GROUP BY path ORDER BY views DESC`),
    query(`SELECT referrer_host AS host, sum(visits)::int AS visits
             FROM analytics_visit_daily WHERE day >= ${since} AND referrer_host <> ''
             GROUP BY referrer_host ORDER BY visits DESC`),
    query(`SELECT to_char(day, 'YYYY-MM-DD') AS date,
                  count(*) FILTER (WHERE kind = 'signup')::int AS signups,
                  count(*) FILTER (WHERE kind = 'trial_start')::int AS trial_starts,
                  count(*) FILTER (WHERE kind = 'paid_conversion')::int AS paid_conversions
             FROM analytics_events WHERE day >= ${since} GROUP BY day ORDER BY day`),
  ]);
  return {
    days: daily.rows.map((r) => ({ date: r.date, views: r.views, visits: r.visits, uniques: null })),
    topPages: fold(pages.rows, 'views', 'path', ['views', 'visits']),
    topReferrers: fold(referrers.rows, 'visits', 'host', ['visits']),
    conversions: conversions.rows.map((r) => ({
      date: r.date, signups: r.signups, trialStarts: r.trial_starts, paidConversions: r.paid_conversions,
    })),
  };
}

module.exports = {
  RETENTION_MONTHS, MIN_REPORT_COUNT,
  isInternalTraffic, classifyRequest, recordEvent, visitMiddleware,
  PUBLIC_PATHS, applyRetention, visitReport, fold,
  normalizeIp, pagePath,
};
