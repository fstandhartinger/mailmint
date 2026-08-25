# Inbound mail through Cloudflare Email Routing

This is the **primary production intake path**. It needs no server, no port 25,
no IP reputation and no reverse DNS — Cloudflare accepts the mail and an Email
Worker streams it to MailMint. The SMTP server in `src/server.js` is the
alternative for self-hosters and for the day we want per-email cost of exactly
zero on our own metal.

Start to finish this is about fifteen minutes with a freshly bought domain.

---

## 0. What you need

- A domain you own, added to Cloudflare (any plan, Free is fine).
- Cloudflare must be the **authoritative DNS** for it: change the nameservers at
  your registrar to the two Cloudflare gives you. Email Routing cannot work on a
  domain that only proxies through Cloudflare.
- `node` and `npx` locally. No global install: `npx wrangler` is enough.

Decide the inbound domain now. A subdomain is cleaner than the apex because it
keeps your own mail out of the way:

    parse.example.com          <-- inbound addresses live here
    k7m2xq4h9bwz@parse.example.com

Email Routing is enabled per zone, and a **subdomain of a zone is covered by
that zone**, so enable it on `example.com` and route `*@parse.example.com`.

---

## 1. Turn on Email Routing (dashboard)

1. <https://dash.cloudflare.com> → pick the zone → **Email** in the sidebar →
   **Email Routing**.
2. Click **Get started**. Cloudflare shows the DNS records it needs:
   three `MX` records (`route1/2/3.mx.cloudflare.net`) and one `TXT` SPF record.
3. Click **Add records and enable**. Because Cloudflare runs the DNS, it writes
   them itself — nothing to copy.
4. Wait for the status to go green. It is usually seconds.

Verify from a terminal:

```bash
dig +short MX parse.example.com
# route1.mx.cloudflare.net.  ... etc
```

If that comes back empty, the MX records are on the apex only. Add them for the
subdomain too: **DNS → Records → Add record**, type `MX`, name `parse`,
mail server `route1.mx.cloudflare.net`, priority `62` (then `route2`/`89`,
`route3`/`24` — Cloudflare shows the exact priorities on the Email page).

---

## 2. Deploy the Worker

The worker is `src/worker/cloudflare-email-worker.js`, 87 lines, no
dependencies. It does one thing: stream `message.raw` to our endpoint.

```bash
cd packages/smtpd

# authenticate once
npx wrangler login

# deploy
npx wrangler deploy --config src/worker/wrangler.toml
```

`src/worker/wrangler.toml` is already in the repo:

```toml
name = "mailmint-email"
main = "cloudflare-email-worker.js"
compatibility_date = "2026-08-01"

[vars]
MAILMINT_ZONE = "parse.example.com"
```

Now give it its secrets. These are **not** in the toml and never in git:

```bash
npx wrangler secret put MAILMINT_ENDPOINT --config src/worker/wrangler.toml
# paste: https://api.example.com/inbound/cloudflare

npx wrangler secret put MAILMINT_SECRET --config src/worker/wrangler.toml
# paste the SAME value as INTERNAL_SECRET in the API's environment

# optional, while you are still learning to trust the pipeline:
npx wrangler secret put MAILMINT_ALSO_FORWARD_TO --config src/worker/wrangler.toml
# paste a verified destination address; every message is also delivered there
```

Check it is alive:

```bash
curl -s https://mailmint-email.<your-subdomain>.workers.dev/
# {"worker":"mailmint-email","configured":true}
```

A `503` with `"configured":false` means a secret is missing.

---

## 3. Point the catch-all at the Worker

This is the step that makes `<token>@parse.example.com` work for *any* token
without creating 200 individual rules.

**Dashboard → Email → Email Routing → Routing rules → Catch-all address**

1. Set **Action** to `Send to a Worker`.
2. Choose `mailmint-email`.
3. **Save** and make sure the catch-all toggle is **enabled**.

Or from the CLI:

```bash
npx wrangler email routing rules catch-all worker mailmint-email
npx wrangler email routing rules list
```

> The catch-all can target a Worker directly — that is exactly the property that
> makes our per-mailbox token scheme possible. Individual routing rules are
> capped at 200 per domain and verified destination addresses at 200 per
> account; the catch-all has no such limit because it never enumerates anything.

---

## 4. Test it

```bash
# from any mailbox you own
echo "Total: \$31.50" | mail -s "Invoice INV-2291" k7m2xq4h9bwz@parse.example.com
```

Then watch:

```bash
npx wrangler tail mailmint-email --config src/worker/wrangler.toml
```

and on the API side look for the `mail.received` log line with
`"source":"cloudflare"`.

You can also drive the endpoint directly, without any mail at all:

```bash
curl -X POST https://api.example.com/inbound/cloudflare \
  -H 'content-type: message/rfc822' \
  -H "x-mailmint-secret: $INTERNAL_SECRET" \
  -H 'x-mailmint-from: billing@acme.com' \
  -H 'x-mailmint-to: k7m2xq4h9bwz@parse.example.com' \
  --data-binary @some-message.eml
```

---

## 5. What the worker will and will not do

| Situation | HTTP from us | What the sender sees |
|---|---|---|
| delivered | 2xx | accepted |
| no such mailbox | 404 / 410 | `550 5.1.1 unknown mailbox`, **in session** |
| message too large | 413 | `552 5.3.4 message too large` |
| our API is down | 5xx / timeout | the worker throws → temporary failure → the sending MTA retries |
| bad secret | 401 / 403 | the worker throws → temporary failure, and we get an alert-worthy log |

Rejecting an unknown mailbox *during the SMTP session* rather than accepting and
bouncing later is deliberate: a bounce sent to a forged sender is backscatter,
and it is how a domain earns a blocklist entry.

---

## 6. Limits worth knowing before you design around them

- **25 MiB** maximum inbound message. Our own `MAX_MESSAGE_BYTES` is 26214400
  (25 MiB) to match; a bigger limit on our side would be a lie.
- **200 routing rules** per domain, **200 verified destination addresses** per
  account. We use neither — one catch-all to one Worker.
- **Workers free plan: 10 ms CPU per invocation.** A complex email handler dies
  with `EXCEEDED_CPU` and the message is lost. This is why the worker streams
  `message.raw` straight through and parses nothing. Do not add `postal-mime`.
  Do not read the stream into a buffer to "check" it. If you need something from
  the message, get it from `message.headers`, which is already parsed for you.
- Email Routing does not give the worker the sending IP, so **SPF cannot be
  evaluated on this path** — the adapter reports `spf: "none"` rather than
  guessing. DKIM and DMARC still work fully, because they are computed from the
  message itself. Cloudflare's own `Authentication-Results` header survives in
  the raw MIME if you want a second opinion.
- Only mail *to* the zone is handled. Email Routing is not an outbound relay.

---

## 7. Switching intake later

Nothing downstream knows which intake was used. To move to Mailgun or
CloudMailin, or back to our own SMTP server, point the provider at the matching
`/inbound/<adapter>` endpoint and change nothing else:

    /inbound/cloudflare     our Email Worker
    /inbound/mailgun        Mailgun route, "raw MIME" format, HMAC verified
    /inbound/cloudmailin    CloudMailin target, Raw or JSON format
    /inbound/generic        anything that can POST an .eml
    (SMTP :25)              packages/smtpd/src/server.js

Every one of them produces the same `{ rawMime, envelope }` and then goes
through the identical authentication, trace-header and spool path.
