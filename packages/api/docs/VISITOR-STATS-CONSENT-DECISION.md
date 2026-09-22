# VS-1 — Consent decision for the visitor statistics (decision record)

Status: **decided by the PRD (mailmint-r2-efca4e00 §4, adopted from the Benchmark Heaven reference
CR-67.5); independent review: pending.**
Not legal advice. The source research behind the cited positions lives in the Benchmark Heaven record
(`/opt/model-market-comparison/ops/ux-2026-09-12/CR-67.5-CONSENT-DECISION.md`, with its verbatim-quote
draft); this record binds that research to the code actually shipped in MailMint, which implements the
same method.

## 1. What is implemented (the facts the decision rests on)

Code: `packages/api/src/analytics.js` (classification, counting, retention, report), `src/migrate.js`
(migration id 11: the aggregate table and the fold of the old per-view rows), `src/web.js`
(operator endpoints), `src/reaper.js` (periodic retention delete), `src/server.js` (middleware mount),
`public/privacy.html` (the disclosure). Tests: `test/analytics-unit.test.js`, `test/analytics.test.js`,
opt-in `test/analytics-ip.test.js`.

| Question | Answer from the code |
|---|---|
| Storage on / active reading from the device | **None.** No cookie, `localStorage`, `sessionStorage`, script, pixel, beacon, extra request, client hint, ETag or link decoration for statistics. The count happens only on the server, on the page request the browser already makes (`visitMiddleware` in `analytics.js`, mounted in `server.js`). The site's one functional cookie is the login session (`mailmint_session`, `web.js`), disclosed on `/privacy`; the counter does not read it. |
| Data used per request (in memory, then discarded) | Method, path, `Sec-Fetch-Dest`/`Accept`/`Sec-Purpose`/`Purpose` (full page load, not a prefetch?), the `User-Agent` string (bot/preview/AI-crawler regex only, never stored), `Referer` (reduced to the host name), `Sec-GPC`/`DNT` (objection), and the IP address — read only to match the `ANALYTICS_EXCLUDE_IPS` internal-traffic list, never stored and never hashed (`isInternalTraffic`, `normalizeIp` in `analytics.js`). The `req.ip` matched there is taken from the first proxy hop's `X-Forwarded-For`, which a client can forge; the only possible effect is that a client excludes itself (an under-count), never that a stranger is counted as internal — and IPv6 entries are compared in canonical form, so the spelling of an entry does not matter. Several of these headers are optional and not sent with every request. |
| Identifiers | **None.** No IP, no hash, no salt, no fingerprint, no session or account link. The former daily IP+UA HMAC (`visitor_hash`) was removed; migration id 11 folded the historical per-view rows into daily totals and deleted them, so no per-visitor row remains. Consequence: unique visitors are **not** measured (every report row carries `uniques: null`). |
| What is stored | Table `analytics_visit_daily(day, path, referrer_host, views, visits)` — daily totals only, primary key `(day, path, referrer_host)`. `path` is the page path with no query string; `referrer_host` is a host name without path or query, empty for direct/same-site arrivals. "views" = full page loads on public paths; "visits" = page loads without a same-site referrer. Account-level business events (`signup`, `trial_start`, `paid_conversion` in `analytics_events`, never joined with visits) carry the internal account number. |
| Where | The service's own Postgres on the same Hetzner server in Finland (EU) that runs the application — the database named by `DATABASE_URL`, same host per `/privacy#hosting`. No analytics vendor; the counter has no other integration. Hetzner is the hosting processor. |
| Retention | `analytics.applyRetention()` deletes `analytics_visit_daily` and `analytics_events` rows older than 13 months; `src/reaper.js` calls it on its existing periodic timer. 13 months is the documented, minimal window for year-over-year comparison. |
| Output | `GET /api/operator/visits?days=N` and `/admin/stats.json` (admin session + `MAILMINT_ADMIN_EMAILS` allowlist; 404 for everyone else; `Cache-Control: no-store`): daily totals, the top 25 pages and referrer hosts with at least 3 page loads in the period, and one "(other)" row combining everything else — the report never names a page or referrer with a single visit. The database holds exact daily rows, reachable only with the database credential. |
| Objection | Requests with `Sec-GPC: 1` or `DNT: 1` are not counted (tested). Email objection is offered on `/privacy#visitor-statistics`; because totals cannot be traced to a person, it is answered with an explanation and the GPC/DNT route rather than a per-person deletion (stated as such on the page). |

## 2. Decision

**(a) No consent is required under § 25 TDDDG, and no banner is added.**

- § 25(1) TDDDG covers *storing information on* or *accessing information stored in* the terminal
  equipment. The counter stores nothing and runs nothing on the device; it only evaluates HTTP headers
  of the page request the visitor makes. LfDI Baden-Württemberg (FAQ Cookies und Tracking, A.3.1)
  states that IP address and User-Agent sent automatically are not an "access" under § 25 and names
  local log analysis without third parties, data-minimal configuration and no merging of usage data as
  the model for consent-free reach measurement — this implementation is stricter still: the statistics
  store holds no IP, no hash and no log row, only daily aggregates. The service's separate request log
  (it contains the requester IP; see `/privacy#logs`) is not used for the statistics.
- DSK *OH Digitale Dienste* v1.2 (Nov 2024) keeps active reading via JavaScript and server-side
  fingerprint hashes (Rn. 23–24) as access; neither happens here — there is no hash. Rn. 88 names
  "bei jedem Abruf einer Seite den Zähler für diese Seite um Eins zu erhöhen" as the plain counting
  case, which is exactly what this counter does.
- EDPB Guidelines 2/2023 v2.0 (paras. 43, 54–55) bring header/IP-based **tracking and fingerprinting**
  into Art. 5(3) ePD. No identifier is derived and no visitor is recognised or tracked, which puts
  this counter outside those examples. The predecessor's daily IP+UA hash was rejected on precisely
  this ground and has been deleted rather than carried over.
- **Residual uncertainty (stated, not hidden):** the EDPB reading of "access" is broad and DSK v1.2
  Rn. 89–90 says reach measurement must be judged per configuration and is "nicht per se" part of the
  base service. The decision is therefore our documented assessment for exactly this configuration,
  and `/privacy#visitor-statistics` words it as "in our assessment". If a supervisory authority or
  court treats header evaluation as access requiring consent, the fallback is to switch the counter
  off (remove the middleware call), not to add a banner.
- GDPR: the persisted daily totals relate to no identifiable person. The transient processing of the
  request headers is based on Art. 6(1)(f) (own reach and capacity insight; no profile, no third
  party, reasonable expectation), with Art. 13 information on `/privacy#visitor-statistics` and an
  Art. 21 objection route (GPC/DNT, or email to the operator address on the page).

**Existing browser storage (outside the counter):** the `mailmint_session` login cookie and the
dashboard's own form state, disclosed on `/privacy#cookies`; none of it is read by the counter.

## 3. Conditions that would reopen this decision

Adding any of the following makes the statistics consent-relevant or needs a new record: client-side
script/beacon, cookie or storage for statistics, any IP-derived or hashed key (unique visitors),
`Accept-CH`, full referrer URLs or query strings, an external analytics provider, joining statistics
with accounts, longer retention.

## 4. Technical proof (for the verifier)

1. `cd packages/api && env -i PATH="$PATH" HOME="$HOME" LOG_LEVEL=error node --test test/analytics-unit.test.js`
   — classification (counted desktop Chrome, excluded headless/curl/QA/IP/GPC/DNT/prefetch/
   non-document/non-public), referrer host-only reduction, own-host/same-site handling, the ≥ 3 /
   top-25 fold, and that the module exports no `visitorHash`.
2. `env -i PATH="$PATH" HOME="$HOME" LOG_LEVEL=error MAILMINT_TEST_DATABASE_URL=postgres://…mailmint_test_… node --test --test-concurrency=1 test/analytics.test.js test/analytics-unit.test.js`
   — a real server against a disposable Postgres: a page view lands as one aggregate row (views+1,
   visits+1 from outside; views+1, visits+0 same-site), headless/QA/GPC/DNT record nothing, external
   referrers are stored host-only, `/api/operator/visits` 404s for anonymous and non-admin and 200s
   for the admin with `no-store` and the documented JSON shape, retention deletes a 14-month-old row
   and keeps a 12-month-old one, and migration 11 moves old-style visit rows into the totals.
3. No third-party request and no `Set-Cookie` for an anonymous page load (asserted by construction —
   the counter adds no client code; anonymous page loads reference only first-party assets. The
   landing page's web fonts — Inter and JetBrains Mono, SIL OFL 1.1 — are self-hosted under
   `/fonts` since 21 Sep 2026 (Google Fonts removed); enforced by `test/public-assets.test.js`).

## 5. Independent review

Pending — to be reviewed by a separate worker session against PRD mailmint-r2-efca4e00 (acceptance
A4), including the inherited IP normalization in `normalizeIp`/`isInternalTraffic` (open item
C16-ip-normalization).

Change 21 Sep 2026: Google Fonts removed from the landing page; fonts self-hosted under /fonts (VS-2, commit 34b644c).

Change 22 Sep 2026 (VS-3, commits 8223294 and c74a1a6): IPv6 exclusion entries and requester IPs are compared in canonical form;
a trailing slash on a public path counts under the stripped path; the `/admin/stats` HTML page sends
`Cache-Control: no-store` like the JSON endpoints; §2 now scopes the "no log row" statement to the
statistics store and states the `X-Forwarded-For` self-exclusion limit.
