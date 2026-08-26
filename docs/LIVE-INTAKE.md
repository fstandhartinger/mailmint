# The SMTP path, proven on real internet mail — 2026-08-26

GOAL.md carried one honest gap for this component: *"our SMTP server has never
accepted mail from the public internet."* It has now.

## What runs

`mailmint-smtpd.service`, a systemd unit, `enabled` and `active`:

    /etc/systemd/system/mailmint-smtpd.service   ExecStart=node src/index.js
    /etc/mailmint-smtpd.env                      chmod 600, carries INTERNAL_SECRET
    /var/lib/mailmint/spool                      spool
    /var/log/mailmint-smtpd.log                  log

It binds `0.0.0.0:25` with `AmbientCapabilities=CAP_NET_BIND_SERVICE` — the
capability, not root — under `NoNewPrivileges`, `ProtectSystem=full` and
`ProtectHome=read-only`. `INBOUND_DOMAIN=smooth-operator.online`.

**Port 25 was never a Hetzner restriction.** Hetzner's inbound firewall is
allow-all; the local `ufw` was dropping it. Outbound 25 and 465 *are* blocked by
Hetzner, so this host can receive but not send — fine for intake, and it means no
bounces are emitted.

## Proof, from outside

MXToolbox connected from `18.209.86.113` — a third party on the public internet:

    220 smooth-operator.online ESMTP MailMint ready [281 ms]
    EHLO keeper-us-east-1d.mxtoolbox.com
    250-smooth-operator.online Hello keeper-us-east-1d.mxtoolbox.com [18.209.86.113]
    SMTP Open Relay   OK - Not an open relay
    SMTP Connection   0.398 seconds

It first flagged **no STARTTLS**. A certificate is now configured and the same
check reports **`SMTP TLS  OK - Supports TLS`**. A real delivery negotiated
**TLSv1.3 / TLS_AES_256_GCM_SHA384** and the session logged `tls: true`.

**The certificate is self-signed**, because Let's Encrypt cannot reach this host:
`smooth-operator.online` resolves to `75.2.60.5` / `99.83.231.61`, not to
`65.109.49.103`, so HTTP-01 fails. That is honest opportunistic TLS — every
normal MTA, Gmail included, will use it and none will reject the mail — but a
sender configured for strict DANE or MTA-STS would refuse it. Once the A record
points here, `certbot certonly --standalone -d smooth-operator.online` and
swapping the two paths in `/etc/mailmint-smtpd.env` upgrades it to a trusted one;
nothing else changes.

## The full chain, on real internet mail

**2026-08-26.** The MX record now points here — `smooth-operator.online MX 10
mx.smooth-operator.online`, and `mx.smooth-operator.online A 65.109.49.103`,
identical from 1.1.1.1, 8.8.8.8 and 9.9.9.9. Florian sent a message from his
Gmail to `9qtyv2e176dt@smooth-operator.online`. It reached this server the way a
stranger's mail would: Gmail looked up the MX and connected directly.

The smtpd log, verbatim:

    {"event":"mail.received","session":"643C3E1D82B30004",
     "remote_ip":"209.85.215.171","helo":"mail-pg1-f171.google.com",
     "mail_from":"florian.standhartinger@gmail.com","rcpt_count":1,
     "bytes":4747,"tls":true,"via":"BDAT"}
    {"event":"mail.delivered","status":200,"ms":75,"bytes":5284}
    {"event":"smtp.session","remote_ip":"209.85.215.171","tls":true,
     "messages":1,"errors":0,"ms":1150,"reason":"quit"}

`209.85.215.171` is Google's outbound MTA, not this host. Stored as
`msg_01m0yq5mhwen8na4qj1924wn3r`, `status: parsed`, `needs_review: false`,
flags `["no_schema"]`, 5284 bytes. The parser pulled `type: invoice`,
`invoice_number: INV-4242` and `128.50 EUR` out of the body in 3 ms with no LLM
call.

**And this is the delivery that settles the SPF question.** Every previous test
was relayed from this machine, so SPF softfailed — correctly, but it never
exercised the thing this path exists for. On a real MX delivery the verifier
sees the connecting IP and returns a genuine verdict:

    auth        {"spf":"pass","dkim":"pass","dmarc":"pass","spam_score":0}
    spf   pass  gmail.com — matched ip4:209.85.128.0/17 at _spf.google.com, 1 lookup
    dkim  pass  gmail.com selector 20251104, rsa-sha256, 2048-bit,
                relaxed/relaxed, body hash matched
    dmarc pass  policy none, aligned DKIM signature, spf+dkim alignment both true
    spam  0     -0.5 spf=pass, -0.5 dkim=pass, -1 dmarc=pass

That is `spf: "pass"` with the matching mechanism named — not `none`, not a
guess. INTAKE-DECISION.md claims SPF evaluation is the one thing this path has
that the Cloudflare Worker cannot offer. As of this delivery that claim is
demonstrated rather than asserted.

**No bounces, by construction.** Hetzner blocks outbound 25 and 465 from this
host, so the server can accept mail but cannot send any. A message to an unknown
mailbox is rejected during the SMTP session with a 5xx, which makes the *sending*
MTA generate the bounce — the correct behaviour anyway. But anything that would
require us to originate mail — a delayed bounce, a DSN, a notification — does not
happen and will not happen on this host. Do not build a feature that depends on
sending until that changes.

## Three real bugs this found

None of them could be found by unit tests, and all three were the same shape:
**the seam between two components, where each was tested against its own fake.**

| Bug | Effect |
| --- | --- |
| `deliver.js` sent `x-mailmint-internal-secret` | every delivery `401`'d; the API expects `x-mailmint-internal` |
| `deliver.js` sent `raw_mime_base64` | every delivery `400`'d; the API expects `raw_mime` |
| `auth/index.js` built the flag list from the raw verifier result | a forwarded message got `auth_fail:dkim` as well as `dkim_body_altered` |

`docs/CONTRACT.md` §3a **documents the first two by name** — it was written after
they cost the product once, `resolver.js` was fixed, and `deliver.js` was left
behind. The stub never checked the header and decoded the old field, so 199 tests
stayed green over a delivery path that could not work.

The stub now enforces `x-mailmint-internal` and decodes `raw_mime`. Reintroducing
the old header fails the suite: **24 pass / 1 fail with the bug, 25 / 0 with the
fix.**

## Still open

- **The certificate is self-signed.** Trusted cert needs the A record pointing
  here; see above.
- ~~A spurious `auth_fail:dkim`~~ — **found and fixed.** The pipeline stamps its
  own verdict into the message as an `Authentication-Results` header, which is
  what RFC 8601 is for, and the parser then read that header back to derive auth
  flags. It was reading our own homework. RFC 8601 has no `body_altered` value,
  so a forwarded message is correctly stamped `dkim=fail` — and came back out as
  `auth_fail:dkim` beside the `dkim_body_altered` the same message already
  carried.

  The parser now prefers a verdict the caller supplies and falls back to the
  header only for raw MIME that arrives without one; the pipeline passes the
  stored verdict through. Merged flags on a real delivery are now
  `["auth_fail:spf","dkim_body_altered","auth_fail:dmarc","no_schema"]`.

  Three isolated tests said each component was innocent. Only tracing the real
  delivery showed `from_parse` carrying the flag. **Reasoning about which
  component was at fault was slower and less reliable than printing what each
  one actually produced.**
- **MX still points at Namecheap's `eforward*` hosts**, so no stranger's mail
  reaches this server yet. Everything above was delivered to port 25 directly.
