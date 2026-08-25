# Pre-existing test failures in `packages/smtpd`

Measured 2026-08-25 with `npm test` in `packages/smtpd`:

    # tests 199   # pass 172   # fail 25   # skipped 2

**None of these are caused by the `body_altered` fix.** Verified by stashing that
change and re-running: the same tests fail, identically, with and without it.

## What passes

    dkim      43/43        dmarc     15/15
    spf       27/27        realmail   6/6
    spam      11/11        address   19/19
    auth-body-altered 2/2

The authentication layer — the part most recently changed — is entirely green.

## What fails, and how far I traced it

| Suite | Result | Symptom |
| --- | --- | --- |
| `adapters` | 15/16 | `webhook intake produces exactly what the SMTP path produces` → **404 unknown mailbox** |
| `spool` | 7/9 | SMTP answers **550** where the test expects 250, after a ~20 s wait |
| `starttls` | 3/4 | a message over STARTTLS does not arrive as expected |
| `protocol` | terminated | the suite does not finish inside 240 s on its own |

The `adapters` failure is the informative one. Its 404 comes from
`intake-http.js` → `ingest()` → `unknown mailbox`: the recipient the test
registered via `startStack({ mailboxes: [MBX] })` is not found by the resolver
the intake server was handed. The test exists precisely to assert that the
webhook intake and the SMTP path agree, so it is either catching a real
divergence between those two paths or a harness that wires the resolver
differently for each. **I did not determine which.**

The `spool` 550 is likely the same root cause seen from the SMTP side — a
recipient that will not resolve — but that is inference, not something I ran down.

Starting the real API on :3100 does **not** fix any of them; these suites use
their own in-process stack, not the deployed service.

## Why this file exists

`packages/smtpd` is the component whose honest gap is that it has never accepted
mail from the public internet. Shipping it while a quarter of its own suite is
red would make that gap worse, not better. Whoever picks this up should start
with the `adapters` divergence, because it questions the contract the whole
intake design rests on.

## `packages/api`

Measured 2026-08-25. **These suites need `DATABASE_URL`** — run them with
`set -a; . .env; set +a` first, or every suite fails at the hook with
"DATABASE_URL is not set; these tests need a real Postgres." That is a missing
environment, not a broken test, and it cost me a wrong conclusion once already.

| Suite | Result |
| --- | --- |
| `sender-auth` | 5/5 |
| `logging` | 7/7 |
| `auth` | 12/13 — `rejects mail for a domain it does not host` |

The `auth` failure is **pre-existing**: reverting `src/api.js` to the commit
before the DKIM change reproduces 12 pass / 1 fail exactly. It lives in the
internal API's domain resolution and has nothing to do with sender
authentication.

The remaining suites (`e2e`, `endpoints`, `intake`, `latency`, `mailboxes`,
`quota`, `reparse`, `webhooks`) run against the remote Neon database and did not
finish inside 15 minutes. **Their state is unknown**, and this file says so
rather than implying they pass.
