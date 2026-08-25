# mailmint-parser

Turns a raw RFC822 buffer into the canonical MailMint object of `docs/CONTRACT.md` §1.

Pure library. **Zero runtime dependencies** — the MIME parser, the HTML parser, the
charset handling, the table extraction and the money/date grammars are all written
here. The only outbound call is the optional LLM pass, and the client for that is
injected.

```js
const { parseMime, parseMessage } = require('mailmint-parser');

// Deterministic only. No network, no clock dependence, no model.
const { headers, body, attachments, tables } = parseMime(rawBuffer);

// Full parse against a user schema.
const result = await parseMessage(rawBuffer, {
  schema: [
    { name: 'invoice_number', type: 'string',   required: true, hint: 'labelled Invoice #' },
    { name: 'total',          type: 'currency', required: true },
    { name: 'due_date',       type: 'date' },
    { name: 'line_items',     type: 'array',
      items: { type: 'object', fields: [{ name: 'description', type: 'string' },
                                        { name: 'amount', type: 'number' }] } },
  ],
  log,                 // { info(event, data), warn(...), error(...), debug(...) }
  requestId: 'req_…',
  schemaVersion: 3,
});
```

`parseMessage` returns the §1 object minus `id`, `mailbox` and `envelope` — those
belong to the caller that received the message. It **never throws**: a catastrophic
failure still returns a valid §1 object with `parse.warnings` populated, the required
fields flagged, and a `parse.failed` log line carrying the input SHA-256.

## How it works

Two layers, in this order, because the order is the cost model.

**(a) Deterministic.** MIME → text/html/attachments; quoted reply chains and
signatures stripped; tables extracted from real HTML grids, from repeating HTML
structure, and from whitespace- and pipe-aligned plain text; amounts, dates, ids,
emails, phones, addresses and a document type detected. Then every schema field is
attempted with label-based rules. Anything answered at ≥ 0.90 never reaches a model.

**(b) One LLM call**, for the remaining fields only, with the stripped text, the
subject, the tables and the deterministic detections in the prompt, demanding strict
JSON with a verbatim `evidence` span per field.

Measured on the labelled corpus: layer (a) alone answers **91.6 %** of field slots at
**97.7 %** precision in **12 ms**. See `BENCH.md` for the full numbers, the calibration
table, and an honest list of what does not work.

## Confidence is computed, not reported

A model will state 0.95 on a value it invented, so its self-report is one input with
the smallest weight and it may only ever *lower* a score. The ceiling comes from
signals that can be checked: the evidence span is a verbatim substring of the input;
the rule and the model independently agree (`source: "rule+llm"`); the value
corroborates something layer (a) already found; the invoice arithmetic reconciles; the
value coerced cleanly to its declared type.

Fabricated evidence is near-disqualifying: the contract's ×0.5 runs and the result is
additionally capped at 0.3, with `hallucinated_evidence:<field>` flagged.

## Options

| option | meaning |
|---|---|
| `schema` | array of §2 field definitions, or `{ fields: [...] }`. Absent → `no_schema`. |
| `log` | injected structured logger, `log.info(event, data)`. Default is silent. |
| `requestId` | threaded through every log line and into `parse.request_id`. |
| `schemaVersion` | copied into `parse.schema_version`. |
| `complete` | LLM client; defaults to `shared/llm.js`'s `complete`. |
| `chain` | model chain override. Default is MailMint's own, headed by DeepSeek-V4-Flash. |
| `llm` | `false` runs layer (a) only. |
| `now` | fixes `received_at` for deterministic tests. |

## Layout

    src/charset.js     byte decoding, legacy encodings via TextDecoder, cp1252 C1 repair
    src/rfc2047.js     encoded words, B and Q, multibyte split across words
    src/headers.js     unfolding, RFC 2231 parameters, addresses, dates
    src/transfer.js    quoted-printable, base64, uuencode
    src/mime.js        the entity tree, boundary splitting, part collection
    src/html.js        HTML parser, html-to-text, grid tables, repeating-structure tables
    src/tables.js      whitespace-aligned and pipe-delimited text tables
    src/strip.js       quoted reply chains and signatures
    src/numbers.js     money and number grammar across locales
    src/dates.js       date grammar and ambiguity resolution
    src/detect.js      layer (a) detections and document type
    src/rules.js       label-driven extraction against the user schema
    src/lineitems.js   line items from text, and multi-source reconciliation
    src/confidence.js  the confidence model, arithmetic verification
    src/coerce.js      §2 type coercion
    src/extract-llm.js the single model call and its JSON recovery
    src/index.js       orchestration, flags, logging

## Tests

    npm test                       61 unit tests, fully offline, ~0.3 s
    node test/accuracy.js --no-llm deterministic accuracy against hand labels
    node test/accuracy.js          full pipeline (makes live model calls)
