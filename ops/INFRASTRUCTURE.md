# Everything MailMint created, what it costs, and how to reap it

`ops/reap.sh --list | --suspend | --destroy` operates on all of it.
Written because infrastructure nobody wrote down is infrastructure that bills forever.

## Monthly cost, today

| What | Where | Plan | Cost |
|---|---|---:|---:|
| Webhook receiver used for intake testing | Render `mailmint-hookbin` (`srv-da6l0i710e5c73c2pj70`) | Free | **$0.00** |
| Database | Neon project `mailmint` (`crimson-king-93827945`) | Free tier | **$0.00** |
| Inbound mail routing | Cloudflare Email Routing (not yet enabled — needs a domain) | Free | **$0.00** |
| Email Worker | Cloudflare Workers (not yet deployed) | Free tier | **$0.00** |
| GitHub repos + Actions | `fstandhartinger/mailmint`, `fstandhartinger/n8n-nodes-mailmint` | public | $0.00 |
| npm package | `n8n-nodes-mailmint` | not yet published | $0.00 |
| Domain | **none bought** | — | $0.00 |
| Hetzner | SSH key only; server creation is blocked on the account | — | $0.00 |
| **Total right now** | | | **$0.00 / month** |

**What it costs once it is actually serving customers:**

| What | Plan | Cost |
|---|---|---:|
| API service | Render Starter, 512 MB, does not sleep | $7.00 |
| Database | Neon free tier | $0.00 |
| Inbound mail | Cloudflare Email Routing + Workers free tier | $0.00 |
| Domain | ~$10–35/year | ~$1–3 |
| LLM calls | see below | usage |
| **Total** | | **~$8–10 / month + LLM usage** |

The Render free tier sleeps after 15 minutes of inactivity and takes ~50 s to wake.
An inbound mail webhook cannot wait 50 s, so production needs Starter. Until then the
free tier is honest for a demo and costs nothing.

**LLM cost is the only variable.** One extraction is one call to
`deepseek-ai/DeepSeek-V4-Flash-0731-TEE` on Chutes with ~2–6k input tokens and ~500
output. The deterministic rules layer answers many fields without any model call at all —
`packages/parser/BENCH.md` reports the measured rules-only hit rate. For comparison,
Mailparser charges **$0.1198 per email** (their own pricing page) and does no AI at all.

## What exists, precisely

- **Render** — `mailmint-hookbin`, free plan, `https://mailmint-hookbin.onrender.com`.
  A request bin that stores raw inbound webhook payloads; used to prove the intake path.
- **Neon** — project `mailmint`, id `crimson-king-93827945`, free tier, in org
  `org-tiny-field-06906618`.
- **Hetzner** — SSH key `mailmint-ops` (id `117860154`) and nothing else. Server creation
  returns HTTP 403 `forbidden` on this account; see `docs/INTAKE-DECISION.md`. The
  matching private key is at `~/.ssh/mailmint_ed25519` on this machine and is not in git.
- **GitHub** — two public repos, plus an `NPM_TOKEN` secret on `n8n-nodes-mailmint`.
  **That secret is currently INVALID** — the `NPM_ACCESS_TOKEN` in this machine's
  environment returns 401 from `registry.npmjs.org`. Publishing will fail until it is
  replaced with a working npm automation token.
- **A disposable inbox** at mail.tm (`mm45462@emalupe.com`), free, used to receive real
  test mail. Credentials are in `.local/inbox.json`, which is gitignored. It is
  ephemeral and will expire; it is a test fixture, not part of the product.
- **Nothing else.** No VPS, no object storage, no queue, no CDN, no cron service, no
  load balancer, no GPU.

## Stripe — what was touched and what was undone

Real invoice emails were needed to test the parser against genuine mail, so real
invoices were issued from the existing live Stripe account ("Sandbox as a Service") to
the disposable inbox, and then reversed:

- created 1 customer, `cus_V8WVDfqvfZQNbn` — **deleted**
- 3 invoices with real line items in USD, EUR and GBP — **all voided**
- 9 earlier zero-total invoices created while getting the API call right — they
  finalised at $0.00 and Stripe marked them `paid`; **no money moved**
- 3 draft invoices — **deleted**; 25 orphaned invoice items — **deleted**

Net effect on the account: twelve invoice records exist in the history and nothing else.
No charge was created, no card was involved, no customer remains. Verified by
re-listing after cleanup.

A Neon organisation invitation was also sent to the disposable inbox to capture a second
real transactional email, and **revoked** immediately (`invitations` now returns `[]`).

## Reaping it

```bash
ops/reap.sh --list      # show everything, change nothing
ops/reap.sh --suspend   # stop Render billing, keep the data
ops/reap.sh --destroy   # delete the Render services, the Neon project and the SSH key
```

`--destroy` prints what it will remove and requires typing `DESTROY`. It deliberately
does **not** delete the GitHub repos and does **not** unpublish from npm: unpublishing
breaks anyone who installed the package, and after 72 hours npm refuses anyway.

## Parked parse failures

`packages/api/src/messages.js` copies anything that throws during parsing into
`ops/failures/` (CONTRACT.md §parse.failed). On 2026-08-25 that directory held 21
messages, all recorded with the same error — `Invalid or unexpected token` — on
plain-text invoices.

Every one of them was replayed through the current parser and **all 21 parse
cleanly**. Whatever broke had been fixed, and nobody had gone back to check.

They now live in `packages/parser/test/regressions/` and run on every
`npm test` in that package, so the fix is held in place. `ops/failures/` is empty
again, which is what it should look like.

**If this directory fills up, replay it before assuming it is stale.** A parked
failure nobody replays is litter with a timestamp.

## mailmint-api.service — added 2026-08-26

The API was found running as a bare `node` process with no unit behind it: PID
546654, started by hand in someone's shell. Two things were wrong with that.

**It would not have survived a reboot,** and the failure would have been quiet in
the worst way. `smtpd` delivers into `API_URL=http://127.0.0.1:3100`, so with the
API gone, port 25 keeps accepting mail and then has nowhere to put it. The
service looks up, the MX still answers, and mail is lost.

**It had inherited the whole developer shell** — `STRIPE_LIVE_SECRET_KEY`,
`GITHUB_PAT`, `ANTHROPIC_ADMIN_API_KEY`, `HETZNER_API_TOKEN` and about seventy
more. The unit uses `EnvironmentFile=` pointing at `packages/api/.env`, which is
mode 600 and gitignored, so the process now carries only the variables
`src/config.js` actually reads.

`SESSION_SECRET` was also absent, which meant `config.js` fell back to its literal
`dev-only-insecure-secret` for signing session cookies. A random one was generated
into `.env`. That invalidated existing sessions; there were no real users to lose.

    sudo cp ops/mailmint-api.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now mailmint-api

Verified on 2026-08-26, not assumed:

- `systemctl is-enabled` → `enabled`, `is-active` → `active`
- `SIGKILL` on the MainPID → came back on a new PID, `/healthz` `ok:true`
- a message sent to `<token>@smooth-operator.online` through `127.0.0.1:25`
  arrived in `messages` with `status: parsed`

**Still true and not fixed here:** the API listens on `127.0.0.1:3100` only. The
landing page, signup and billing code all exist under `packages/api/public` and
`src/billing.js`, but nothing is deployed publicly, so no stranger can reach any
of it. Deploying it is the next step and belongs on Sandy (Coolify is already
healthy on this box and owns :80/:443); the `sandy-deploy` MCP was installed at
16:10 on 2026-08-26, so a session started after that has the tools for it.
