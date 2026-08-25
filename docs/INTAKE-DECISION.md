# How mail gets in: the options, what I measured, and what I chose

Every price and limit below was fetched from the vendor on 2026-08-25, not recalled.
Where I could not test something, it says so.

## The constraint I actually hit

I intended to run our own SMTP server, because receiving mail yourself takes the
per-message cost to zero. I could not:

```
POST https://api.hetzner.cloud/v1/servers
HTTP/2 403
{"error":{"code":"forbidden","message":"permission denied","details":{}}}
x-correlation-id: 19629e25ff51fdf4ca4b3e508f7064e0
```

The token is not the problem — with the same token I created and deleted a firewall
successfully, and listed images, prices and SSH keys. Server creation specifically is
blocked at the account level. Tried across `fsn1`, `hel1`, `nbg1` and across `cpx11`,
`cx23`, `cax11`, `debian-13`, `ubuntu-24.04`: identical 403 every time.

No other provider we hold a key for exposes inbound TCP port 25 — Render, Vercel and
E2B are HTTP-only; RunPod maps TCP to a random high port, and an MX record cannot
carry a port number. So **running our own MX is not available to me today.**

## The four candidates

| | Cloudflare Email Routing | Mailgun | CloudMailin | Our own SMTP |
|---|---|---|---|---|
| Cost of inbound | **$0** | $0 on the free plan | $0 up to 10k/mo | ~€6.53/mo for the VPS |
| Volume ceiling at that price | no documented inbound cap | free plan = 1 inbound route | 10,000/mo | hardware-bound |
| Max message size | **25 MiB** | 25 MB | **512 KB** on free, 2 MB at $25 | whatever we set |
| Needs our own domain | **yes** | sandbox domain issued at signup (untested) | no — address on their domain | yes |
| Needs a credit card | no | disputed, being tested | advertised "no card required" | n/a |
| Gives raw MIME | yes, `message.raw` stream | yes | yes | yes |
| Who eats spam/abuse | Cloudflare | Mailgun | CloudMailin | us |
| Single point of failure | Cloudflare's edge | Mailgun | CloudMailin | one VPS |

Sources: `developers.cloudflare.com/email-routing/limits/` and
`/email-routing/email-workers/runtime-api/`; `mailgun.com/pricing/`;
`cloudmailin.com/pricing`.

## The decision

**Production: Cloudflare Email Routing → an Email Worker → our `/internal/deliver`.**

Why, concretely:
- It is free at any volume we will plausibly reach, and inbound mail is the one cost
  that scales linearly with customer success. Mailparser sells 250 emails for $29.95
  (~$0.12/email). Our marginal cost on this path is **$0.00/email**. That spread is
  the entire business and this is the option that protects it.
- 25 MiB inbound. CloudMailin's free tier caps at 512 KB, which would have rejected
  three of the four real emails I tested with — the Stripe invoices are 88–93 KB, but
  a scanned-PDF invoice routinely exceeds 512 KB. A parser product that silently drops
  mail with big attachments is not a parser product.
- Catch-all can target a Worker directly, which is exactly what `<token>@parse.domain`
  needs — one rule covers every customer, and we never touch DNS again after setup.
- No server to run, patch or wake up at 3am.

**The Worker must stay stupid.** Cloudflare documents that email handlers on the
Workers *free* plan can fail with `EXCEEDED_CPU`. Ours streams `message.raw` to our API
and does nothing else — no MIME parsing, no dependencies. All the work happens in our
own service, where CPU is ours to spend.

**We still ship our own SMTP server** (`packages/smtpd`). Not as the default — as
the escape hatch. It is what a self-hosting or air-gapped customer runs, it is what we
switch to if Cloudflare ever changes terms, and building it is what forced us to
implement real SPF, DKIM and DMARC verification, which we now report on every message
whichever intake delivered it. It has never accepted mail from the public internet.

**We also ship adapters** for Mailgun, CloudMailin and a generic webhook, because a
customer who already runs one of those should not have to move.

**Day-one onboarding is `packages/intake`** — connect an existing IMAP mailbox, or set
up a Gmail forward. Every competitor offers this, and it is the only path that works
before anyone touches DNS. It is not a workaround; it is the feature that lets someone
try the product in two minutes.

## What a human must do to make the production path live

1. **Buy a domain.** `mailmint.io` and `mailmint.net` are taken (checked by whois);
   `mailmint.co` and `mailmint.email` appear free. Any domain works — the code takes
   it as config. Cost ~$10–35/year.
2. Point the domain's nameservers at Cloudflare (free plan is enough).
3. Cloudflare dashboard → Email → Email Routing → enable. It writes its own MX and TXT
   records.
4. `wrangler deploy` the worker in `packages/smtpd/src/worker/`, then
   `wrangler secret put MAILMINT_INTERNAL_SECRET` and set `MAILMINT_API_URL`.
5. Email Routing → catch-all → action "Send to a Worker" → pick the worker.
6. Set `INBOUND_DOMAIN` on the API to the domain.

Exact commands are in `packages/smtpd/ops/cloudflare-setup.md`.

## Honest gaps

- I have not run a message through Cloudflare Email Routing, because that requires the
  domain from step 1. The Worker is written against the documented `ForwardableEmailMessage`
  API and tested against a faithful replay of that object, which is not the same thing.
- The per-message cost of $0.00 is Cloudflare's published position today, not a contract.
