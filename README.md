# MailMint

**Send an email to an address you were given. Get it back as structured JSON — with a
real SPF, DKIM and DMARC verdict on the message.**

Not "we scraped the body with a regex": MailMint runs its own inbound SMTP server, so
it sees the envelope and the raw RFC822 bytes, and can verify the DKIM signature over
the body it actually received. Every parse result carries
`auth: { spf, dkim, dmarc, spam_score }`, and when a check cannot be evaluated it says
`none` rather than guessing.

![The n8n node's parse output](docs/screens/06-parse-output.png)

## Honest status, 2026-08-26

**Not usable by a stranger yet.** The pieces work and are tested; the last step is a DNS
change nobody has made.

| Piece | State |
| --- | --- |
| `packages/smtpd` — inbound SMTP server | Runs, accepts real internet mail on port 25 with STARTTLS, verifies SPF/DKIM/DMARC |
| `packages/parser` — RFC822 → canonical JSON | Complete against the contract, tested |
| `packages/api` — REST API, webhooks, dashboard | Runs |
| `packages/n8n-node` — `n8n-nodes-mailmint` | Built, **not published to npm** |
| Public inbound address | **No.** The MX record still points elsewhere, so no stranger's mail reaches it |
| TLS certificate | Self-signed |

So: mail sent to the server is received, verified and parsed — that has been done with
real internet mail. Nobody outside can point mail at it, because the domain's MX record
has not been switched over.

## What the JSON looks like

Every path — webhook body, `GET /v1/messages/:id`, the n8n node's output — returns the
same shape. `docs/CONTRACT.md` is the frozen definition and the thing every package is
written against.

```jsonc
{
  "id": "msg_01JQ8Z3K4M5N6P7Q8R9S",
  "mailbox": { "address": "k7m2xq4h9bwz@parse.example.com", "name": "Invoices" },
  "received_at": "2026-08-25T09:14:03.221Z",
  "envelope": { "from": "billing@acme.com", "to": ["k7m2xq4h9bwz@parse.example.com"] },
  "auth":  { "spf": "pass", "dkim": "pass", "dmarc": "pass", "spam_score": 0.4 },
  "tables":   [ { "source": "html", "headers": ["Item","Qty","Amount"],
                  "records": [ { "Item": "Widget", "Qty": "3", "Amount": "$27.00" } ] } ],
  "detected": { "type": "invoice", "amounts": [ { "value": 31.50, "currency": "USD" } ] }
}
```

Three layers, deliberately separated: the envelope and authentication are facts from the
protocol; `tables` and `detected` are deterministic extraction from the body; anything
schema-driven on top is labelled and carries confidence flags. **A flagged message is
still delivered** — `needs_review` goes true, nothing is silently dropped.

## Layout

Monorepo, npm workspaces.

```
packages/parser/     pure library — RFC822 to the canonical JSON above
packages/smtpd/      the inbound SMTP server; zero runtime dependencies
packages/api/        REST API, webhook delivery, dashboard (Express + Postgres)
packages/intake/     IMAP polling and provider connectors, for hosts that own the MX
packages/docs/       attachment extraction — PDF text and tables, OCR
packages/n8n-node/   published separately as n8n-nodes-mailmint, zero runtime deps
docs/CONTRACT.md     the frozen contract. Read this before changing anything
ops/                 what it created, what it costs, and how to tear it down
```

## Running it

```bash
npm install
npm test -w packages/parser
npm test -w packages/smtpd
```

`docs/CONTRACT.md` is the single source of truth. `docs/COMPETITORS.md` is the honest
comparison against the parsers that already exist, written before this one was built.

## Related

- [PDFMint](https://github.com/fstandhartinger/pdfmint) — HTML, Markdown or a URL to PDF.
- [DocMint](https://github.com/fstandhartinger/docmint) — fill Word, Excel and
  PowerPoint templates from JSON.

Run by one person. Issues are read.
