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

**It flags one real gap: no STARTTLS.** No certificate is configured, so mail
arrives in plaintext. Senders that require TLS will refuse.

## The full chain, on a real Gmail message

A message genuinely sent by Gmail — two valid `DKIM-Signature` headers and its
`Received:` chain from `mail-pg1-x529.google.com` intact — delivered over port 25:

    smtpd   mail.delivered   status 200   bytes 5493
    api     internal.deliver msg_01m0yna21g1e6qryqmn1ydd8dc
    parsed  from: Florian Standhartinger <florian.standhartinger@gmail.com>
            subject: MailMint intake proof - real internet mail
    auth    {"spf":"softfail","dkim":"body_altered","dmarc":"fail","spam_score":2.7}
    dkim    body hash mismatch, computed UngkG4… vs signed 1sacOe…
    spf     softfail — "~all at _spf.google.com", 1 lookup

SPF softfails and DMARC fails **correctly**: the message was relayed from this
host, not from Google's outbound servers, so it does not match Gmail's SPF. DKIM
is `body_altered`, which is right for a message that has been through a forward.

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

- **No STARTTLS.** Needs a certificate for `smooth-operator.online`.
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
