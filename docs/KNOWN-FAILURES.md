# Test failures in `packages/smtpd` — resolved 2026-08-25

**All 25 failures were one stale test double.** `npm test` in `packages/smtpd` is
now:

    # tests 199   # pass 197   # fail 0   # skipped 2

## What was actually wrong

`test/helpers.js` `startFakeApi()` answered the **old** internal-resolve form:

    GET /internal/resolve?address=...   header x-mailmint-secret

while `src/resolver.js` and the real `packages/api` both implement CONTRACT §3a:

    POST /internal/resolve  {"to": "<full address>"}   header x-mailmint-internal

So every recipient lookup came back 404 and the stack rejected valid mailboxes —
**550 over SMTP, 404 over the webhook intake**. The production code was correct
throughout; only the stub had drifted.

That one mismatch accounted for all of it:

| Suite | Before | After |
| --- | --- | --- |
| `adapters` | 15/16 — "webhook intake produces exactly what the SMTP path produces" | **16/16** |
| `spool` | 7/9 — API-outage paths answered 550 | **9/9** |
| `starttls` | 3/4 | **4/4** |
| `protocol` | never finished inside 240 s | **41/41** |

The protocol suite was not slow. It was waiting on recipient lookups that could
never succeed.

## The lesson worth keeping

The failing test was named *"webhook intake produces exactly what the SMTP path
produces"*, and it was right to fail — both paths were being told the mailbox did
not exist. What it caught was not a divergence between the two intakes but a
divergence between the **test double and the contract it stands in for**.

`src/resolver.js` carries a comment saying exactly this: *"This is the seam that
was wrong; do not 'improve' it without changing §3a first."* The seam was fixed
in the production code and the stub was left behind.

**A fake that drifts from its contract does not fail loudly — it fails as the
thing it is faking.** When a whole suite goes red at once, suspect the double
before the code.
