# MailMint — frozen internal contract (v1)

This file is the single source of truth that every builder codes against.
Do not change it without telling the lead. If you think it is wrong, say so; do not silently diverge.

Product: a customer gets a unique inbound email address. Mail sent there is parsed into
structured JSON and delivered by webhook, by polling, or into n8n.

Repo layout (monorepo, npm workspaces):

    mailmint/
      packages/parser/    pure library, no network except the shared LLM client
      packages/smtpd/     inbound SMTP server (runs on the mail VPS)
      packages/api/       REST API + dashboard (Express, Postgres)
      packages/n8n-node/  published separately as n8n-nodes-mailmint (ZERO runtime deps)
      docs/  ops/

## 0. Vocabulary

- **account** — a customer. Has API keys.
- **mailbox** — one inbound address, `<token>@<INBOUND_DOMAIN>`. Belongs to an account.
  `token` is 12 chars, base32 lowercase (Crockford, no i/l/o/u), e.g. `k7m2xq4h9bwz`.
  Mailboxes may also carry a human `slug` alias: `<slug>.<token>@domain` and
  `<token>+anything@domain` both route to the same mailbox.
- **message** — one received email.
- **schema** — the per-mailbox field definition the user wants extracted.
- **extraction** — the parsed result for one message against the mailbox schema.

## 1. The parse result — THE canonical JSON shape

Every path (webhook body, `GET /v1/messages/:id`, n8n node output) returns exactly this.

```jsonc
{
  "id": "msg_01JQ8Z3K4M5N6P7Q8R9S",       // ULID-ish, sortable, prefix msg_
  "mailbox": { "id": "mbx_...", "address": "k7m2xq4h9bwz@parse.example.com", "name": "Invoices" },
  "received_at": "2026-08-25T09:14:03.221Z",  // when OUR smtpd accepted it
  "envelope": {
    "from": "billing@acme.com",                // SMTP MAIL FROM (return-path)
    "to": ["k7m2xq4h9bwz@parse.example.com"],  // SMTP RCPT TO
    "helo": "mail-yw1-f watches.google.com",
    "remote_ip": "209.85.128.51",
    "tls": true
  },
  "headers": {                                  // decoded, RFC2047 unfolded
    "message_id": "<CAF...@mail.gmail.com>",
    "date": "2026-08-25T09:14:01.000Z",         // ISO or null if unparseable
    "subject": "Invoice INV-2291 from Acme Ltd",
    "from": { "name": "Acme Billing", "email": "billing@acme.com" },
    "to":   [ { "name": null, "email": "k7m2xq4h9bwz@parse.example.com" } ],
    "cc":   [], "reply_to": [],
    "in_reply_to": null, "references": [],
    "raw": { "x-mailer": "...", "list-unsubscribe": "..." }   // all other headers, lowercased keys
  },
  "body": {
    "text": "plain text body, quoted-printable decoded, charset-normalised to UTF-8",
    "html": "<html>…</html>",                   // null if absent
    "text_from_html": "text rendered from the html part when there is no text/plain",
    "stripped_text": "body with trailing quoted reply chain and signature removed",
    "language": "en"                             // best-effort, may be null
  },
  "attachments": [
    { "id": "att_...", "filename": "invoice.pdf", "content_type": "application/pdf",
      "size": 48213, "sha256": "…", "inline": false, "content_id": null,
      "url": "https://api.mailmint.…/v1/attachments/att_…",   // API-key auth, 7 day retention
      "content_base64": "…"                                    // only when ?include=attachments
    }
  ],
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass", "spam_score": 0.4 },
  //  spf  : pass|fail|softfail|neutral|none|temperror|permerror
  //         "none" on the Cloudflare intake path — Email Routing gives the worker no
  //         client IP, so SPF cannot be evaluated. We report none, never a guess.
  //  dkim : pass|fail|body_altered|none|temperror|permerror      <- see §1c
  //  dmarc: pass|fail|none|temperror|permerror
  "tables": [                                    // deterministic, from text/plain and html
    { "source": "html", "index": 0,
      "headers": ["Item","Qty","Amount"],
      "rows": [ ["Widget","3","$27.00"] ],
      "records": [ { "Item": "Widget", "Qty": "3", "Amount": "$27.00" } ] }
  ],
  "detected": {                                  // layer (a): deterministic, always present
    "type": "invoice",                           // invoice|receipt|order|shipping|form|calendar|generic
    "emails": ["billing@acme.com"], "urls": ["https://…"], "phones": ["+1 555 …"],
    "amounts": [ { "value": 31.50, "currency": "USD", "raw": "$31.50" } ],
    "dates":   [ { "value": "2026-09-08", "raw": "Sep 8, 2026" } ],
    "ids":     [ { "kind": "invoice_number", "value": "INV-2291" } ],
    "addresses": [ "…" ]
  },
  "fields": {                                    // layer (b): the user's schema, or {} if none
    "invoice_number": { "value": "INV-2291", "confidence": 0.97, "source": "llm",  "evidence": "Invoice INV-2291 from Acme Ltd" },
    "total":          { "value": 31.5,       "confidence": 0.99, "source": "rule", "evidence": "Total: $31.50" },
    "due_date":       { "value": null,       "confidence": 0.0,  "source": "none", "evidence": null }
  },
  "flags": ["low_confidence:due_date"],          // see §4
  "parse": {
    "request_id": "req_…",
    "schema_version": 3,                          // which version of the mailbox schema was used
    "model": "moonshotai/Kimi-K3-TEE",            // null when no LLM pass ran
    "llm_used": true,
    "timings_ms": { "total": 1421, "mime": 8, "deterministic": 21, "llm": 1380, "persist": 12 },
    "warnings": []
  },
  "raw_url": "https://api.mailmint.…/v1/messages/msg_…/raw"   // original RFC822, API-key auth
}
```

Rules that are NOT negotiable:
- `fields.*.value` is `null` when not found. Never invent. Never a guess string like "N/A".
- `confidence` is a float 0..1 and is **computed by us, never taken from the model**.
  See §1a. `source` may be `rule+llm` when both agreed independently.
- `source` is one of `rule` | `llm` | `header` | `attachment` | `none`.
- `evidence` is a verbatim substring of the input the value came from, or null.
  If the LLM returns evidence that is NOT a substring of the input, confidence is
  multiplied by 0.5 and `hallucinated_evidence:<field>` is added to flags. This is
  our anti-hallucination check and it must actually run.

## 1a. How confidence is computed  (amended 2026-08-25 by the lead)

No competitor returns a per-field confidence, an evidence span, or any provenance —
verified across 363 vendor help articles and two published API schemas. It is our
opening. But a raw model self-report is worthless: the best-articulated requirement
found in the forums came with the warning *"a model will report 0.95 on a PO code it
hallucinated."* So confidence is derived from signals we can VERIFY:

1. **Evidence check** (largest weight). `evidence` must be a verbatim substring of the
   input, normalised for whitespace and case. Failing this is near-disqualifying, not a
   soft penalty: flag `hallucinated_evidence:<field>`.
2. **Rule/LLM agreement.** Both layers run. Agreement → ~0.97 and `source: "rule+llm"`.
   Disagreement → keep the RULE's value, confidence ~0.5, flag
   `rule_llm_disagreement:<field>`. No competitor can detect this because none runs both.
3. **Arithmetic consistency** (invoices/receipts). Do the line items sum to the subtotal,
   and does subtotal + tax + shipping − discount equal the total? Reconciling raises
   confidence across the whole cluster; failing sets `arithmetic_mismatch`. This is what
   catches "40 rows in the mail, 1 row in the output" — the single most common silent
   failure in the category.
4. **Type, format and enum validity** after coercion.
5. **The model's self-report** — smallest weight, and it may only LOWER a score, never
   raise one above what the verifiable signals justify.

`confidence` must be **calibrated and the calibration published**: bucket every field by
reported confidence and report the measured correctness rate per bucket in BENCH.md. If
0.9+ fields are not right ~90% of the time, the formula is wrong and gets fixed.

## 1b. Four cases the incumbents fail, which we must not

Ranked by how often they appear across the n8n, Make and Zapier forums:

1. **Variable-row line items (~14 threads, #1 by volume and by "no answer exists").**
   `tables[].records` and `array`-of-`object` fields must return EVERY row. Emit
   `row_count`. A short or partial table is `table_truncated`, never a silently short
   array. Must survive >2 columns and wrapped rows.
2. **Data only in the PDF attachment (~13 threads).** Mailparser cannot read attachment
   contents; Docparser cannot read email bodies; Zapier can do neither and zips
   attachments together. We do body + attachment in one pass at one price.
   `attachments[].extracted` carries `{kind, text, pages, tables, meta}`.
3. **Re-parsing old mail (~8 threads, the hardest "no").** Zapier staff, verbatim:
   *"there is no way to replay them."* Mailparser caps at the last 300. We keep the
   original bytes and `POST /v1/messages/:id/reparse` works on any stored message with
   any schema, and re-delivery is a separate opt-in from re-parsing.
4. **Forwarded mail (~8 threads).** The real message is nested inside the forward and the
   original headers are normally unrecoverable. Unwrap it: `body.forwarded_from` carries
   the recovered original `{from, to, date, subject}` and parsing runs against the INNER
   message. Flag `forwarded` so the user knows.

## 1c. `dkim: "body_altered"` is not `dkim: "fail"`  (decided 2026-08-25 by the lead)

A DKIM signature can fail for two completely different reasons and they must not share
a code:

- the **signature or key** is wrong — someone forged the message, or the selector is gone
- the **body hash** does not match — the message was signed correctly and then *modified
  after signing*

The second is overwhelmingly benign and overwhelmingly common: forwarding, mailing
lists, and corporate security gateways that rewrite links all break the body hash while
leaving a perfectly legitimate message. **Half of our users will forward mail to us from
Gmail**, so charging our own happy path as suspicious would be self-inflicted.

Therefore `auth.dkim` carries `"body_altered"` as its own value. A user writing
`if (auth.dkim === "fail")` gets forgeries and does not get their colleague's forward.
Rules:
- `body_altered` does **not** set the `auth_fail:dkim` flag and does **not** raise the
  spam score. Measured: a forwarded body-altered message scores 2.4; a forged signature
  over the same message scores 3.9.
- It must be branchable **without** reading `auth_details`. The finer breakdown —
  `auth_details.dkim.failure_type` ∈ `body_hash | signature | key | policy | dns`, plus
  per-signature detail — stays available for anyone who wants it, but the top-level
  value is the one people will actually use.

This is the same lesson PDFMint learned twice: a quota you exhausted and a quota you
never had are different events, and so are a caller's error and ours. Collapsing them
into one code is always cheaper to write and always wrong to consume.

## 2. Field types in a schema

```jsonc
{ "name": "total", "type": "number", "description": "grand total incl. tax",
  "required": true, "hint": "labelled Total or Amount Due" }
```
`type` ∈ `string | number | integer | boolean | date | datetime | email | url | phone | currency | enum | array | object`
- `date` normalises to `YYYY-MM-DD`; `datetime` to ISO-8601 UTC.
- `currency` yields `{ "amount": 31.5, "currency": "USD" }`.
- `enum` requires `options: [...]`; a value outside the list becomes null + a flag.
- `array` requires `items: { type }`. `object` requires nested `fields: [...]`.
Coercion happens AFTER the LLM answers and a failed coercion sets value null,
confidence 0 and flag `type_error:<field>`.

## 3. Endpoints (all under `/v1`, auth `Authorization: Bearer mm_live_…`)

    POST   /v1/mailboxes                {name, schema?, webhook_url?}   -> mailbox
    GET    /v1/mailboxes                                                -> [mailbox]
    GET    /v1/mailboxes/:id
    PATCH  /v1/mailboxes/:id            {name?, schema?, webhook_url?, webhook_secret?}
    DELETE /v1/mailboxes/:id
    GET    /v1/messages?mailbox_id=&since=&cursor=&limit=&status=       -> {data:[…], next_cursor}
    GET    /v1/messages/:id?include=attachments
    GET    /v1/messages/:id/raw                                         -> message/rfc822
    GET    /v1/attachments/:id                                          -> the bytes
    POST   /v1/messages/:id/reparse     {schema?}    re-run parsing, useful while tuning
    POST   /v1/parse                    {raw_mime | {subject,text,html}, schema}  -> parse, store nothing
    GET    /v1/events?cursor=           polling feed for the n8n trigger; see §5
    POST   /v1/test/deliver             {mailbox_id, raw_mime}  inject a message as if received
    GET    /v1/usage
    GET    /healthz                     (no auth)

`POST /v1/parse` is the stateless endpoint: it lets anyone try the parser without an
address, and it is what the n8n *regular* node calls when given mail from another node.

## 4. Flags

`low_confidence:<field>` (<0.6) · `missing_required:<field>` · `type_error:<field>` ·
`rule_llm_disagreement:<field>` · `arithmetic_mismatch` · `table_truncated` · `forwarded` ·
`attachment_unreadable` · `ocr_used` · `dkim_body_altered` ·
`hallucinated_evidence:<field>` · `enum_violation:<field>` · `no_schema` ·
`llm_unavailable` · `attachment_too_large` · `truncated_body` · `spam_suspected` ·
`auth_fail:spf|dkim|dmarc`

A message with any flag still delivers. We never silently drop. `needs_review` is a
top-level boolean = true if any `low_confidence:` / `missing_required:` / `type_error:` /
`hallucinated_evidence:` flag is present.

## 5. Delivery

**Webhook** — POST the §1 object to `webhook_url`. Headers:
`x-mailmint-event: message.parsed`, `x-mailmint-delivery: dlv_…`,
`x-mailmint-signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`.
Retries at 0s, 30s, 2m, 10m, 1h, 6h (6 attempts) on non-2xx. 10s timeout.

**Polling** — `GET /v1/events?cursor=` returns `{events:[{id, type, cursor, message}], next_cursor}`.
Cursor is opaque and monotonic. This is what the n8n trigger polls. Events are kept 7 days.

## 6. Logging (mandatory, JSON lines to stdout)

Every log line: `{ts, level, request_id, event, ...}`. Required events:
`smtp.session`, `smtp.rejected`, `mail.received`, `parse.start`, `parse.stage`,
`parse.llm` (model, ms, attempts, ok), `parse.done` (timings_ms, field count, mean confidence,
flags), `parse.failed` (error, and the input SHA + a stored copy under ops/failures/),
`webhook.attempt`, `webhook.failed`, `api.request` (method, path, status, ms, account).
Never log a full body at info level. `parse.failed` stores the input for replay; that store
is not exposed by the API.

## 7. Non-negotiables

- LLM: use `/home/flori/Dev/pdfnode/shared/llm.js`. `maxTokens` NEVER below 1024 here.
- n8n node package: MIT, zero runtime dependencies, no `fs`, no `process.env`, one service only.
- Never commit a key or a real customer email body.
