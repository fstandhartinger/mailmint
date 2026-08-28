# n8n-nodes-mailmint

Turn an email into structured JSON — and **define the fields you want inside n8n**, on the
canvas, next to the workflow that consumes them.

Every other email parser makes you leave your automation tool, open their web app, upload a
sample, and click on the parts of it you want. Then you go back to n8n and receive whatever
they decided to send. This node does the whole thing in the node: name a field, give it a
type and a sentence of description, execute, see the value.

MailMint is the API behind it.

> ### Status
>
> Published on npm as [`n8n-nodes-mailmint`](https://www.npmjs.com/package/n8n-nodes-mailmint),
> and the API behind it is hosted at **https://mailmint.app.mintapis.com** — sign up there,
> copy the `mm_live_…` key from the dashboard, and the credential's Base URL default already
> points at it. You can also point it at a MailMint you run yourself.

---

## Install

In n8n: **Settings → Community Nodes → Install**, enter `n8n-nodes-mailmint`, confirm.

Self-hosted, from the command line:

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-mailmint
```

Then restart n8n.

The package has **zero runtime dependencies** — it uses n8n's own HTTP helper and nothing
else. It is published from
[this repository's GitHub Actions workflow](.github/workflows/publish.yml) with an npm
provenance attestation, so `npm audit signatures` verifies which commit built it.

## Credential

1. In n8n, add a **MailMint API** credential.
2. **API Key** — the key for your MailMint account. It starts with `mm_live_`.
3. **Base URL** — already filled in with `https://mailmint.app.mintapis.com`, the hosted
   service. Change it only if you run MailMint yourself; no trailing slash.
4. Save. The credential tests itself against `GET /v1/usage`, so you get a green tick before
   you build anything.

---

## First workflow, in five minutes — mail you already have

You do not need a MailMint address to start. If mail is already reaching n8n — through the
built-in **Email Trigger (IMAP)**, through Gmail, through anything — put a **MailMint** node
after it and it parses what arrives.

1. Add an **Email Trigger (IMAP)** node and point it at your mailbox. Any Format works.
2. Add a **MailMint** node after it. It opens on **Parse → Parse Email**, which is the
   default, with **Input: Automatic** — that is already correct. Automatic takes the raw
   `.eml` off the binary field when the IMAP node is set to RAW, and the
   `subject` / `textPlain` / `textHtml` fields off the JSON when it is set to Resolved or
   Simple. It will not mistake an attached PDF for the message.
3. Under **Fields**, click **Add Field** three times and fill them in:

   | Name | Type | Description | Hint |
   |---|---|---|---|
   | `invoice_number` | String | the invoice or reference number | labelled Invoice |
   | `total` | Number | grand total including tax | labelled Total or Amount Due |
   | `due_date` | Date | when payment is due | labelled Due |

4. **Execute step.**

You get back:

```json
{
  "invoice_number": "INV-2291",
  "total": 31.5,
  "due_date": "2026-09-08",
  "_needs_review": false,
  "_meta": {
    "subject": "Invoice INV-2291 from Acme Ltd",
    "from_email": "billing@acme.com",
    "received_at": "2026-08-25T09:14:03.221Z",
    "type": "invoice",
    "needs_review": false,
    "flags": [],
    "attachment_count": 1,
    "attachment_names": ["invoice.pdf"],
    "has_extracted_attachments": true
  }
}
```

That is **Simplify** at work — on by default, because the next node is nearly always a
Google Sheets, a Postgres or an IF. Turn it off and you get the full parse result: headers,
both bodies, tables, detected amounts and dates, and per-field confidence with the evidence
each value was read from.

The **Description** column is the single biggest lever on accuracy. Write it the way you
would explain the field to a new colleague, and put the label the mail actually uses in the
**Hint**.

---

## The schema editor

Every field you add maps onto a real type, and three of them take a second parameter:

| Type | What you get back | Extra |
|---|---|---|
| String, Email, URL, Phone Number | the text as written | |
| Number, Integer | a number | |
| Currency | `{ "amount": 31.5, "currency": "USD" }` | |
| Date | `2026-09-08` | |
| Date and Time | ISO-8601, UTC | |
| Boolean | `true` / `false` | |
| Enum | one of your values, or `null` | **Options**: comma separated |
| Array | a list | **Item Type** |
| Object | a nested object | **Sub-Fields**: a JSON array of field definitions |

A value that cannot be coerced comes back as `null` with a `type_error` flag. **It is never
invented, and never a guess string like "N/A".** A required field that is missing is still
`null` — it is flagged, not fabricated.

You can also point **Schema** at **From a Mailbox** to reuse the schema saved on one of your
MailMint mailboxes, or at **JSON** to compute it in an earlier node.

## Line items — one item per row

The most common complaint in this whole category is "the mail had forty rows and I got one".
Set **Output** to **One Item Per Line Item** and one email becomes one n8n item per invoice
line, with the header fields repeated on each:

```json
{ "invoice_number": "INV-2292", "total": 132,
  "Item": "Widget", "Qty": "3", "Amount": "$27.00",
  "_row_index": 0, "_row_count": 3, "_line_items_truncated": false }
```

It finds the rows on its own: an `array` field you defined first, then the largest table in
the body, then the largest table read out of an **attachment** — so an invoice whose detail
only exists inside the attached PDF still fans out. Name a specific one in **Line Items
From** if you want a particular table.

`_row_count` travels on every row and `_line_items_truncated` says so out loud when the
table came back short. A message with no rows still produces exactly one item, with
`_row_count: 0` — nothing is ever silently dropped. (With Simplify off the same item also
carries `line_item: null` and `line_item_count: 0`.)

It picks the rows carefully: an array **of objects** first, so a `tags` or `skus` field of
plain strings is not mistaken for the line items; then tables; and a list of plain strings
only when there is genuinely nothing else. If a row has a column with the same name as one
of your header fields — a per-line `total` alongside the invoice `total` — the row's value
wins for that row and the message-level one is kept, named, under `_shadowed`.

`pairedItem` is set on every row, so n8n can still trace all forty items back to the one
email they came from.

## Confidence, and routing what needs a human

Every field carries a confidence, the source it came from, and the **verbatim evidence** it
was read out of. Turn on **Options → Include Confidence**:

```json
"_confidence": {
  "total": { "confidence": 0.97, "source": "rule+llm", "evidence": "Total: $31.50" }
}
```

`_needs_review` sits at the top level of every simplified item. Turn on **Route Messages
Needing Review Separately** and the node grows a second output: anything with a missing
required field, a low-confidence value, a type it could not coerce, or evidence it could not
find in the mail goes down **Needs Review** instead of **Parsed**. No IF node, no expression.

Line items follow their message — forty rows from a doubtful invoice all go down the same
branch together.

## Attachments

The filenames, sizes, and **anything the parser read out of a PDF or a spreadsheet** are on
every simplified item already, under `_attachments`, with no option to turn on:

```json
"_attachments": [
  { "filename": "invoice.pdf", "content_type": "application/pdf", "size": 48213,
    "extracted": { "kind": "pdf", "pages": 1, "text": "…", "tables": [ … ] } }
]
```

The bytes are the one thing behind a switch (**Options → Include Attachment Bytes**),
because a single PDF is usually larger than the rest of the message put together. To get a
file as real n8n binary data, use **Message → Download Attachment**.

---

## Your own inbound address

For mail that should come *to* MailMint rather than through your own IMAP:

1. **MailMint → Mailbox → Create**, give it a name and a schema. The response carries the
   address, something like `k7m2xq4h9bwz@parse.mailmint.dev`.
2. Point whatever sends the mail at that address.
3. Add a **MailMint Trigger** to receive the parsed messages.

## MailMint Trigger

One node, two modes.

**Webhook** (the default) registers itself. On activation it sets the mailbox's
`webhook_url` to this workflow's URL and installs a signing secret it generates for you; on
deactivation it clears it. Every incoming delivery has its `x-mailmint-signature` HMAC
verified before the workflow runs — a body that does not verify is answered `401` and never
starts anything. Instant, and there is nothing to configure beyond picking the mailbox.

**Polling** is for an n8n the internet cannot reach. It reads `GET /v1/events` on your poll
schedule and remembers the cursor on the node. On first activation it seeds that cursor and
emits nothing, so switching a workflow on never floods it with a week of old mail. **Fetch
Test Event** in the editor returns your most recent real message without moving the cursor.

Each trigger registers **its own webhook endpoint** on the mailbox, with its own signing
secret, so two workflows can watch the same mailbox and neither can switch the other one
off: deactivating one deletes only the endpoint it created. Against an older MailMint that
carries a single `webhook_url` per mailbox, the node falls back to that field — and refuses
to activate if it is already pointing somewhere else, rather than quietly taking delivery
away from whatever is listening there.

n8n adds its own **Poll Times** section to any node that can poll, so it appears in both
modes. In Webhook mode it does nothing — ignore it. It cannot be hidden from inside a node.

**Fetch Test Event** in Polling mode returns your most recent real message without touching
the cursor, so you can see the output shape before any mail has arrived. In Webhook mode the
same button registers the editor's test URL with MailMint and waits for a real delivery —
send a mail to the address and it lands in the editor, signature checked.

Both modes take the same **Filters** — only messages needing review, only from a given
sender or domain, only for one mailbox — and the same **Output**, **Simplify** and
**Route Messages Needing Review Separately** settings as the main node.

## Operations

| Resource | Operation | What it does |
|---|---|---|
| **Parse** | Parse Email | Extract your fields from an email the workflow already has. Nothing is stored. |
| **Message** | Get | One parsed message by ID |
| | Get Many | List parsed messages, filtered by mailbox, date, or needs-review |
| | Get Raw | The original RFC822 message as binary `.eml` |
| | Download Attachment | One attachment as binary data |
| | Reparse | Re-run one message, optionally against a different schema |
| **Mailbox** | Create | A new inbound address with a schema on it |
| | Get Many | The addresses on your account |
| | Update | Name, schema, webhook URL, webhook secret |
| | Reparse Messages | Re-run **every** stored message after you fix the schema, with a **Dry Run** first |
| | Delete | |

**Reparse Messages** is worth knowing about. Zapier's answer to "can I replay old mail" is
*"there is no way to replay them"*, and Mailparser stops at the last 300. Fix your schema,
dry-run it to see what would change, then run it for real. Re-delivery is a separate switch
from re-parsing, so nobody accidentally fires a month of webhooks at their own workflow.

The main node is marked `usableAsTool`, so an **n8n AI Agent can call it directly**.

## Errors

Every failure carries the API's own message and its hint, plus what to click in n8n, and the
item index that failed. With **Settings → Continue On Fail** on, the failing item becomes:

```json
{ "error": { "code": "message_not_found", "message": "…", "hint": "…", "httpCode": "404" },
  "errorMessage": "…" }
```

so an IF node can branch on `{{ $json.error.code }}` instead of matching on a sentence.

## A note on `auth.dkim`

`_meta.dkim` passes the API's value straight through, and it has **three** meaningful states,
not two: `pass`, `fail`, and `body_altered`. `body_altered` means the message was signed
correctly and then modified afterwards — which is what forwarding, mailing lists and
corporate link-rewriting gateways all do to perfectly legitimate mail. Branch on
`_meta.dkim === 'fail'` when you want forgeries; that will not catch your colleague's
forward.

## Licence

[MIT](LICENSE.md)
