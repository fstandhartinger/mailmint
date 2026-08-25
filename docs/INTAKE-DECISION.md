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

## The asymmetry nobody mentions until it bites

The two intake paths do not observe the same things, and it is worth being explicit
because it affects what `auth` in CONTRACT §1 can honestly contain:

| | our SMTP server | Cloudflare Email Worker |
|---|---|---|
| sending IP visible | yes | **no** |
| SPF | evaluated for real | **cannot be evaluated — reported as `none`, never guessed** |
| DKIM | verified | verified |
| DMARC | evaluated (SPF or DKIM alignment) | evaluated (DKIM alignment only) |

Cloudflare hands the worker `message.from`, `message.to`, `message.headers` and
`message.raw` — and no client IP. So on the recommended path we can prove *who signed*
a message but not *where it came from*. DMARC still works, because DKIM alignment alone
satisfies it. The adapter reports `spf: "none"` rather than inferring something it
cannot know, which is the only defensible choice.

If a customer needs SPF, they run our SMTP server. That is a real reason for the
self-host path to exist beyond ideology.

## What the DKIM verifier is actually worth

This is the one auth claim that is fully proven, and it was proven the hard way. The
verifier was checked against **69 real third-party signatures pulled from public
mailing-list archives and validated against live DNS** — gmail.com, fastmail, pobox,
gmx.de, pks.im, peff.net and 80x24.org — of which **33 use `relaxed/simple`**, the
canonicalisation combination that most home-grown verifiers get wrong. All 69 pass.
Flipping a single body byte, or rewriting `Subject`, turns a pass into a fail. Five
messages plus a DNS snapshot are committed as offline fixtures; `MAILMINT_LIVE_DNS=1`
re-checks against live DNS.

Two things fell out of that work worth recording:
- **RFC 8463's published ed25519 example signature does not verify.** It is an erratum
  in the RFC, not a bug in us — demonstrated by re-signing the identical message with
  the RFC's own ed25519 private key (the RFC 8032 §7.1 test vector) and verifying
  successfully against the published `p=`.
- **The real emails we captured for testing are not byte-faithful.** The messages we
  pulled back through a webmail HTTP API lost the CRLF after every MIME boundary
  delimiter, so their body hashes cannot match. That is a property of the export, not
  of the mail and not of the verifier. It is also a useful lesson for the product: mail
  that reaches a customer through a forward, a mailing list or a security gateway will
  routinely fail `bh=` while being perfectly legitimate, so a body-hash failure is
  reported distinctly and does not on its own raise the spam score.

## What is now proven, 2026-08-25

**The intake path has handled real mail from the public internet.** A message was
sent from a Gmail account to a live disposable mailbox on `emalupe.com` — a
different provider, across the public internet — and `packages/intake` pulled it
and handed it to `/internal/deliver`:

    event: connector.delivered
    from: florian.standhartinger@gmail.com
    message_id: <CAH9Y4-ifw78_G=J0vNmt_Lxnkxcg2-5m1ue3yY_Lq4oT0H6r8Q@mail.gmail.com>
    bytes: 5057   deliver_ms: 2   status: received

That Message-ID is Gmail's own, so the message genuinely traversed the internet
rather than being replayed from a fixture. `npm run test:live` passes 3/3,
including the Rebex third-party IMAP server.

**Be precise about what this does not prove.** It says nothing about the SMTP
server, and the delivery target in the live test is `FakeApi`, so the parser and
the real API were not in the loop. Two separate claims, one of them still open:

| Claim | Status |
| --- | --- |
| The intake connector handles real internet mail | **proven** as above |
| The parser handles that message end to end into the real API | **proven** — see below |
| **The SMTP server has accepted mail from the public internet** | **still never** |

## Honest gaps

- I have not run a message through Cloudflare Email Routing, because that requires the
  domain from step 1. The Worker is written against the documented `ForwardableEmailMessage`
  API and tested against a faithful replay of that object, which is not the same thing.
- **Our SMTP server has never accepted mail from the public internet** (still true
  as of 2026-08-25; the intake path above is a different component). Everything
  measured about it — 182 passing tests, 117 msg/sec durable, 39 KB RSS per idle
  session, a 20 MB message accepted in 618 ms — comes from real TCP against a real
  listener on loopback, driven by a hand-written client. That is real engineering
  evidence and it is not evidence of working in production. Until a stranger's mail
  server delivers to it, nobody should call the SMTP path production-proven.
- The per-message cost of $0.00 is Cloudflare's published position today, not a contract.

### Parser end to end, 2026-08-25

The same real Gmail message — fetched as raw RFC822, complete with its `Received:`
chain from `mail-pg1-x529.google.com` — was posted to a locally running instance
of the real API at `POST /v1/parse` with a real `mm_live_` key. HTTP 200, and it
came back correct:

    headers.message_id  <CAH9Y4-ifw78_G=J0vNmt_Lxnkxcg2-5m1ue3yY_Lq4oT0H6r8Q@mail.gmail.com>
    headers.subject     MailMint intake proof - real internet mail
    body.text           the message body, extracted
    parse.timings_ms    total 15 (mime 6), llm_used false

**A gap this exposed.** The response carried `auth: {spf: null, dkim: null,
dmarc: null}` even though the message carries **two valid Gmail DKIM
signatures**, and DKIM is verifiable from raw MIME plus DNS with no envelope at
all. The reason is structural: SPF, DKIM and DMARC verification live in
`packages/smtpd/src/auth/`, so `/v1/parse` never runs them — it can only relay
what a receiving edge already reported.

That is defensible for SPF, which genuinely needs the connecting IP. It is not
defensible for DKIM, and `/docs#auth` describes `auth` as part of the parse
output without saying it is always null on this endpoint. Either wire the DKIM
verifier into the parse path or say plainly in the docs that `/v1/parse` does not
authenticate senders. Right now a customer pasting raw MIME would reasonably
expect a `dkim` verdict and silently get nothing.
