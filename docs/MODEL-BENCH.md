# Which model reads an invoice, measured

Run on 2026-08-25 by the lead, on **real email** — three Stripe invoices that were
actually sent through Amazon SES to a real MX and pulled back as raw MIME. Not fixtures.
USD, EUR (German line-item descriptions), GBP.

Task: from the `text/plain` part, extract `invoice_number`, `total`, `currency`,
`due_date` and a `line_items` **array**, each with a confidence and a verbatim evidence
substring, as strict JSON. `maxTokens` 2048 via `shared/llm.js`.

| model | fields correct | line-item arrays correct | avg latency | JSON failures |
|---|---|---|---:|---:|
| **deepseek-ai/DeepSeek-V4-Flash-0731-TEE** | **12/12** | **3/3** | **8,824 ms** | 0 |
| moonshotai/Kimi-K3-TEE | 12/12 | 3/3 | 25,620 ms | 0 |
| google/gemma-4-31B-turbo-TEE | 4/4 | 0/3 | 22,752 ms | 2 |
| zai-org/GLM-5.2-TEE | 0/0 | 0/3 | — | 3 (all) |
| Qwen/Qwen3.8-27B-TEE | 5/5 | not tested | 38,509 ms | 0 |
| Nemotron-3-Nano-Omni-30B-TEE | 9/10 | not tested | 10,375 ms | 0 |
| unsloth/Mistral-Nemo-Instruct-2407-TEE | **0/5** | not tested | 6,228 ms | 0 |
| Qwen/Qwen3.6-27B-TEE | — | — | 86,424 ms | timeout + JSON fail |
| moonshotai/Kimi-K2.6-TEE | — | — | 55,856 ms | timeout + JSON fail |

## What this changed

**The chain order in `shared/llm.js` is wrong for this workload.** It leads with
Kimi K3, which is the right call for general capability. For reading an invoice,
DeepSeek-V4-Flash matches it on every single field — including the German EUR invoice
and every line-item array — at roughly a third of the latency. MailMint therefore passes
its own `chain` to `complete()` rather than editing the shared client, which other
services depend on:

    deepseek-ai/DeepSeek-V4-Flash-0731-TEE → moonshotai/Kimi-K3-TEE → zai-org/GLM-5.2-TEE
      → gemini-3-flash-preview → gpt-5-mini

**Mistral-Nemo is excluded from the chain entirely.** It is the second-fastest model
tested and it got 0 of 5 fields right while answering fluently and in valid JSON. A
fallback that returns confident garbage is worse than one that errors, because it
reaches the customer wearing a confidence score.

**Asking for an array is what costs the time.** DeepSeek-Flash answered the four scalar
fields in ~2.1–2.9 s. Adding `line_items` tripled the output and took it to ~8.8 s. So
`maxTokens` scales with schema complexity, and the deterministic rules layer — which
skips the model entirely for fields it can resolve — is a latency feature, not only a
cost saving.

## Caveat

Three messages from one sender is a small sample. It is real mail, which makes it worth
more than thirty synthetic fixtures, but it is not a broad accuracy claim. The broader
measurement is in `packages/parser/BENCH.md`.
