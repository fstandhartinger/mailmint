# MailMint parser — measured accuracy

Everything below is output from `node test/accuracy.js`, run against hand-labelled
ground truth. Nothing here is estimated. Where the parser is wrong or blind, it says so.

Reproduce:

```
npm test                       # 61 unit tests, offline, ~0.3 s
node test/accuracy.js --no-llm # deterministic layer only
node test/accuracy.js          # full pipeline (makes live model calls)
```

Measured 2026-08-25, Node v20.19.4, model chain headed by
`deepseek-ai/DeepSeek-V4-Flash-0731-TEE` via `shared/llm.js`.

## The corpus

41 `.eml` files in `test/corpus/`, 324 KB.

| group | n | provenance |
|---|---|---|
| `real-*` | 20 | **Genuinely real messages** pulled from the public GNU mailing-list mbox archives (`https://lists.gnu.org/archive/mbox/{emacs-devel,bug-gnu-emacs,help-gnu-emacs,bug-gnulib}/2025-{03,07}`). 7,704 messages were downloaded and split; 20 were selected to span the MIME features below. Real DKIM, real Received chains, real reply chains, real signatures, real charsets. |
| `fx-*` | 21 | Constructed to reproduce the **MIME structure** of real vendor mail (payment receipt, order confirmation, parcel tracking, plain-text German invoice, invoice-with-PDF, contact form, calendar invite, reply chain, Outlook forward, Japanese receipt, pipe-table utility bill, `multipart/related` with an inline logo, French invoice, HTML-only invoice, deliberately broken boundary, deeply nested + RFC 2231 filename, German ride receipt, ambiguous dates, and 1/40/520-row line-item tables). Quoted-printable at scale, hidden preheader spans, tracking pixels, layout tables. |

4 further messages are **real delivered mail** (Stripe → Amazon SES → a real MX; two
valid DKIM signatures each) held in `.local/realmail/`, which is gitignored on
purpose and referenced by absolute path. The harness skips them if absent.

MIME features exercised across the committed corpus:

| feature | files | | feature | files |
|---|---|---|---|---|
| `multipart/alternative` | 19 | | quoted-printable | 26 |
| `multipart/mixed` | 9 | | base64 | 9 |
| `multipart/related` | 3 | | RFC 2047 encoded words | 13 |
| `multipart/signed` | 2 | | legacy charsets (latin-1 &c.) | 5 |
| attachments | 8 | | RFC 2231 filenames | 2 |
| inline `Content-ID` | 2 | | quoted reply chains | 19 |
| `-- ` signatures | 6 | | tables extracted | 13 |

Header, address, date and attachment expectations for **every** committed file are
checked against an independent implementation — Python's `email` module with
`policy.default` — in `test/expected-structure.json`. That is a real oracle, not
this parser's own output frozen in place.

## Headline numbers

22 labelled messages, 95 labelled field slots.

| | rules only (`--no-llm`) | rules + one LLM call |
|---|---|---|
| precision | **97.7 %** (85 / 87 returned) | **100.0 %** (94 / 94 returned) |
| recall | **90.4 %** (85 / 94 present) | **100.0 %** (94 / 94 present) |
| correct abstentions | 1 | 1 |
| document type accuracy | 100.0 % (22/22) | 100.0 % (22/22) |
| mean confidence | 0.911 | 0.942 |
| mean latency / message | **12 ms** | 1,516 ms |
| mean LLM latency | — | 2,522 ms over the 13 messages that needed one |
| messages needing the LLM | 0 % | **59.1 %** (13/22) |
| fields answered without a model | **91.6 %** (87/95) | 71.6 % (68/95) |

Read the two columns together. The deterministic layer alone answers 91.6 % of field
slots at 97.7 % precision in 12 ms, and it is what makes the median parse cheap. The
model closes the last 9 % — Japanese labels, a calendar organiser, a card's last four
digits, a vendor name that is nowhere written down — and costs 2.5 s when it runs.

(The 71.6 % in the right column is lower than the 91.6 % on the left because when a
model *is* called, fields it agrees with are re-sourced to `rule+llm`.)

## Calibration — is the confidence number honest?

Every extracted value bucketed by the confidence we published, against the hand label.

Rules only:

| bucket | n | correct | actual |
|---|---|---|---|
| 0.9–1.0 | 65 | 65 | **100.0 %** |
| 0.7–0.9 | 18 | 16 | 88.9 % |
| 0.5–0.7 | 4 | 4 | 100.0 % |
| 0.0–0.5 | 0 | — | — |

Full pipeline:

| bucket | n | correct | actual |
|---|---|---|---|
| 0.9–1.0 | 82 | 82 | **100.0 %** |
| 0.7–0.9 | 11 | 11 | 100.0 % |
| 0.5–0.7 | 0 | — | — |
| 0.0–0.5 | 1 | 1 | 100.0 % |

**Honest caveat: with zero errors in the full run this table cannot demonstrate a
declining curve.** What it does show is that nothing is *over*-confident: no value in
the 0.9+ bucket was wrong in either mode. The rules-only run is the more informative
one, because it contains errors: the two wrong values there both sat in the 0.7–0.9
band (the `vendor` guessed from the `From` display name), not in 0.9+. That is the
behaviour the formula is designed for — a guess must not be able to buy a high score.

Confidence is **computed, never reported**. The model's own number is one input and
it may only ever lower a score:

| source | n | correct | mean confidence |
|---|---|---|---|
| `rule` | 68 | 100.0 % | 0.958 |
| `rule+llm` (two independent extractors agreed) | 12 | 100.0 % | 0.917 |
| `llm` | 14 | 100.0 % | 0.884 |

The ceilings come from verifiable signals in this order: evidence is a verbatim
substring of the input; rule and model independently agree; the value corroborates
something layer (a) already found; the invoice arithmetic reconciles; the value
coerced cleanly. Fabricated evidence is near-disqualifying — CONTRACT §1's ×0.5 runs
*and* the result is capped at 0.3.

## Line items — the flagship case

The single loudest complaint in this market is "I got one row instead of forty". The
reason is structural, and it is worth stating precisely: **real HTML email does not
contain real tables.** The Stripe invoice in `.local/realmail/` has 61 `<table>` tags
and 78 `<tr>`, and its line items are not in a grid at all — each item is its own
nested single-cell table, which is what Outlook compatibility forces every ESP to
emit. A `<table>` → headers/rows extractor structurally cannot see them.

So line items are extracted from three independent deterministic sources and
reconciled. Measured, per source, on the five labelled line-item cases:

| file | `html-table` | `html-repeat` | `text-run` |
|---|---|---|---|
| fx-01 receipt (aligned text + real grid) | **exact** | — | 2 of 3 |
| fx-14 HTML-only invoice (real 4-col grid) | **exact** | — | 3 rows, differs |
| stripe USD (real mail) | — | **exact** | **exact** |
| stripe EUR, German descriptions (real mail) | — | **exact** | **exact** |
| stripe GBP (real mail) | — | **exact** | **exact** |
| **exact / differs / absent** | 2 / 0 / 3 | 3 / 0 / 2 | 3 / 2 / 0 |

No single source is above 3/5. **The reconciler is 5/5.** That is the whole argument
for running more than one extractor.

Reconciliation rules, in order: a row set whose amounts sum to the stated total wins
(arithmetic proof of completeness — `text-run` anchored on all three real invoices);
then source precision (a headed grid beats a repeat group beats a text run); then
length. When two sources agree independently, confidence goes to 0.97 and the
completeness claim is earned rather than asserted. When they disagree, the field is
flagged `array_source_disagreement:<name>` rather than silently resolved.

Variable row counts (`test/extract.test.js`):

| rows in the message | rows extracted | truncated |
|---|---|---|
| 1 | 1 | no |
| 40 | 40 | no |
| 520 | 520 | no |

The deterministic path carries all 520 rows and never reaches a model, so there is no
token limit to fall off. `tables[].row_count` and `tables[].truncated` are published so
a short array can never be silent; the cap is 5,000 rows, above which
`table_truncated` is flagged.

## Extraction rate by field

Full pipeline, all 100 % precision and recall except as noted. The interesting column
is mean confidence, because it shows what the parser thinks it knows.

| field | n | mean conf | field | n | mean conf |
|---|---|---|---|---|---|
| invoice_number | 11 | 0.970 | total | 18 | 0.965 |
| due_date | 11 | 0.970 | currency | 6 | 0.877 |
| line_items | 5 | 0.900 | vendor | 5 | 0.898 |
| delivery_date | 3 | 0.970 | invoice_date | 3 | 0.970 |
| order_number | 3 | 0.930 | tracking_number | 2 | 0.970 |
| receipt_number | 2 | 0.970 | carrier | 2 | 0.900 |

## What does not work

An honest list.

1. **PDF attachments are not read.** Every real Stripe invoice carries the same line
   items in a properly ruled PDF table, which would be the highest-precision source of
   all. `packages/docs` is being built for this; the parser has no hook wired to it
   yet. Until then a mail whose data lives *only* in the PDF yields nothing.
2. **A vendor name that is nowhere written in the body is a guess.** The `From`
   display name is a mailbox name ("Stackforge Billing"), not a company name. It is
   marked as a fallback, held below the rule-accept threshold, and handed to the model
   — but with no model, `vendor` is the one field that reliably goes wrong (60 %
   precision in the rules-only column; both of the two errors in that run).
3. **Truly ambiguous dates stay ambiguous.** `08/09/2026` from a `.com` sender with no
   other date in the document resolves day-first at confidence 0.55. That is a
   deliberate coin-flip with an honest number on it, not a solution.
4. **Non-Latin scripts get no deterministic rules.** The Japanese receipt needs the
   model for its order number and date; the label synonym tables are Latin-script only
   (en/de/fr/es/it/nl/pt). Detection keywords have a handful of CJK terms, no more.
5. **The calibration curve cannot yet show a decline**, because the full pipeline made
   no errors on this corpus. 95 field slots is enough to prove the pipeline is not
   over-confident and nowhere near enough to fit a reliability curve. This needs a
   corpus an order of magnitude larger with deliberately hard cases.
6. **`text-run` line items are shakier than the table sources** (2 of 5 exact-count but
   wrong content). It is anchored by arithmetic when a total is present; without a
   total it can pick up a stray amount as an item. It is never used when a headed grid
   exists.
7. **No spam/auth verification of our own.** `auth.*` is read from
   `Authentication-Results` if the upstream MTA wrote one. The parser does not verify
   DKIM. That belongs in `packages/smtpd`.
8. **Signature stripping is heuristic below the `-- ` delimiter.** A signature with no
   valediction and no contact block — just a name on a line — is kept. Erring that way
   is deliberate: a wrong strip loses content, a missed strip only adds noise.
9. **`multipart/signed` is passed through, not verified.** The signature part becomes an
   attachment; nothing checks it.
10. **Latency, when a model is needed, is 2.5 s** and that is the honest floor for this
    chain. Everything the rules layer can absorb is latency removed, which is why the
    rules-only hit rate is reported as a first-class number.

## Deviations from CONTRACT.md

Three additive extensions, none breaking the §1 shape:

- `tables[].row_count` and `tables[].truncated` — a consumer must be able to see that a
  table was complete. Requested by the lead; the alternative is a silently short array.
- `fields[].source` may be `"rule+llm"` when two independent extractors agreed. §1
  enumerates `rule | llm | header | attachment | none`; this is a strictly more
  informative value in the same slot.
- New flags: `rule_llm_disagreement:<field>`, `arithmetic_mismatch`,
  `array_incomplete:<field>`, `array_source_disagreement:<field>`, `table_truncated`.
  `needs_review` is still computed exactly as §4 specifies (from `low_confidence:`,
  `missing_required:`, `type_error:`, `hallucinated_evidence:`); a disagreement drives
  confidence to 0.5, which raises `low_confidence:` on its own, so `needs_review` stays
  correct without redefining it.

§1 says confidence is "the model's own stated confidence, clamped to [0,1]". Per the
lead's amendment, it is instead computed from verifiable signals, with the model's
self-report able only to lower it. The ×0.5 hallucinated-evidence rule that §1 requires
still runs; the result is additionally capped at 0.3.
