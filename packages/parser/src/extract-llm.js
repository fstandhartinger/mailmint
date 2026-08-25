'use strict';
const { llmShim } = require('./log');

/**
 * Layer (b): one LLM call for whatever the rules could not settle.
 *
 * Three things matter here and all three are learned the hard way:
 *  - the token budget must be generous, because these are reasoning models and
 *    a small budget is spent entirely on hidden reasoning, returning "";
 *  - the model will wrap its JSON in a fence and add a sentence afterwards no
 *    matter how firmly you ask it not to, so the parser has to cope;
 *  - asking for `evidence` is what makes the anti-hallucination check possible,
 *    so it is required, not optional.
 */

/**
 * MailMint's own model order. shared/llm.js orders its chain by general
 * capability; this workload is narrow (strict JSON, short answers) and
 * measurement on real Stripe invoices put DeepSeek-V4-Flash level with Kimi-K3
 * on every field at roughly a third of the latency. Kimi stays second as the
 * accuracy-equal fallback. Mistral-Nemo is deliberately absent: it answered
 * fast and confidently wrong, which is the one failure mode that corrupts
 * confidence scores instead of surfacing as an error.
 */
const DEFAULT_CHAIN = [
  { provider: 'chutes', model: 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE' },
  { provider: 'chutes', model: 'moonshotai/Kimi-K3-TEE' },
  { provider: 'chutes', model: 'zai-org/GLM-5.2-TEE' },
  { provider: 'gemini', model: 'gemini-3-flash-preview' },
  { provider: 'openai', model: 'gpt-5-mini' },
];

const MIN_TOKENS = 2048;
const MAX_TEXT = 14000;
const MAX_TABLE_CHARS = 4000;

function describeField(f) {
  const bits = [`"${f.name}" (${f.type || 'string'}${f.required ? ', required' : ''})`];
  if (f.description) bits.push(`- ${f.description}`);
  if (f.hint) bits.push(`[hint: ${f.hint}]`);
  if (f.type === 'enum' && f.options) bits.push(`one of: ${JSON.stringify(f.options)}`);
  if (f.type === 'array' && f.items) {
    bits.push(`array of ${f.items.type || 'string'}`);
    if (f.items.type === 'object' && f.items.fields) {
      bits.push(`each object has: ${f.items.fields.map((x) => `${x.name}:${x.type || 'string'}`).join(', ')}`);
    }
  }
  if (f.type === 'object' && f.fields) bits.push(`object with: ${f.fields.map((x) => `${x.name}:${x.type || 'string'}`).join(', ')}`);
  if (f.type === 'currency') bits.push('return {"amount": <number>, "currency": "<ISO 4217>"}');
  if (f.type === 'date') bits.push('return YYYY-MM-DD');
  if (f.type === 'datetime') bits.push('return ISO-8601 UTC');
  return '- ' + bits.join(' ');
}

const SYSTEM = [
  'You extract structured data from email. You are precise and you never invent values.',
  'Rules:',
  '1. Answer with ONE JSON object and nothing else.',
  '2. Shape: {"fields":{"<name>":{"value":<value|null>,"confidence":<0..1>,"evidence":"<verbatim substring>"}}}',
  '3. `evidence` MUST be copied character-for-character from the message text you were given.',
  '   Never paraphrase it, never construct it. If you cannot copy one, use null and value null.',
  '4. If a value is not present in the message, use value null, confidence 0, evidence null.',
  '   Do not guess. Do not write "N/A", "unknown" or an empty string; use null.',
  '5. `confidence` is your own honest probability that the value is correct.',
  '6. Include every requested field exactly once, using the exact field name given.',
].join('\n');

function buildPrompt(fields, ctx) {
  const parts = [];
  parts.push(`SUBJECT: ${ctx.subject || '(none)'}`);
  if (ctx.from) parts.push(`FROM: ${ctx.from}`);
  if (ctx.date) parts.push(`SENT: ${ctx.date}`);
  parts.push(`DETECTED DOCUMENT TYPE: ${ctx.detected.type}`);

  const det = [];
  if (ctx.detected.amounts.length) det.push(`amounts: ${JSON.stringify(ctx.detected.amounts.slice(0, 12).map((a) => a.raw))}`);
  if (ctx.detected.dates.length) det.push(`dates: ${JSON.stringify(ctx.detected.dates.slice(0, 12).map((d) => `${d.raw} = ${d.value}`))}`);
  if (ctx.detected.ids.length) det.push(`ids: ${JSON.stringify(ctx.detected.ids.slice(0, 12).map((i) => `${i.kind}=${i.value}`))}`);
  if (det.length) parts.push('DETERMINISTIC DETECTIONS (already verified, prefer these):\n' + det.join('\n'));

  if (ctx.tables && ctx.tables.length) {
    let tblText = ctx.tables.map((t, i) =>
      `TABLE ${i} (${t.source}):\n${JSON.stringify(t.records.slice(0, 60))}`).join('\n');
    if (tblText.length > MAX_TABLE_CHARS) tblText = tblText.slice(0, MAX_TABLE_CHARS) + '\n…(truncated)';
    parts.push(tblText);
  }

  let body = ctx.stripped || ctx.text || '';
  if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT) + '\n…(truncated)';
  parts.push('MESSAGE TEXT (quoted replies and signature already removed):\n"""\n' + body + '\n"""');

  parts.push('FIELDS TO EXTRACT:\n' + fields.map(describeField).join('\n'));
  parts.push('Reply with the JSON object only.');
  return parts.join('\n\n');
}

/**
 * Pull the first complete JSON object out of a model reply.
 * Handles ```json fences, leading commentary and trailing prose.
 */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const direct = tryParse(s);
  if (direct) return direct;
  // Scan for the first balanced object, respecting strings and escapes.
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const cand = tryParse(s.slice(start, i + 1));
          if (cand) return cand;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s) {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { /* fall through */ }
  // One repair pass: trailing commas and single quotes around keys.
  try {
    const fixed = s.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
    const v = JSON.parse(fixed);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/**
 * @returns {{fields:Object, model:string|null, ms:number, attempts:number, ok:boolean, error:string|null}}
 */
async function llmExtract(fields, ctx, opts) {
  const o = opts || {};
  const log = o.log;
  const complete = o.complete;
  const started = Date.now();
  if (!fields.length) return { fields: {}, model: null, ms: 0, attempts: 0, ok: true, error: null };

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildPrompt(fields, ctx) },
  ];
  // Arrays and nested objects triple the output length, so the budget follows
  // the shape of the schema, not just the field count. Floor is MIN_TOKENS.
  const weight = fields.reduce((n, f) => n + (f.type === 'array' || f.type === 'object' ? 6 : 1), 0);
  const maxTokens = Math.max(MIN_TOKENS, Math.min(8192, 512 + weight * 384));

  try {
    const res = await complete(messages, { maxTokens, log: llmShim(log), chain: o.chain || DEFAULT_CHAIN });
    const parsed = extractJson(res.text);
    const ms = Date.now() - started;
    if (!parsed) {
      log.warn('parse.llm', { model: res.model, ms, attempts: (res.attempts || []).length, ok: false,
        error: 'model reply was not JSON', sample: String(res.text || '').slice(0, 200) });
      return { fields: {}, model: res.model, ms, attempts: (res.attempts || []).length, ok: false, error: 'non_json_reply' };
    }
    const bag = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : parsed;
    log.info('parse.llm', { model: res.model, ms, attempts: (res.attempts || []).length, ok: true,
      fields_requested: fields.length, fields_returned: Object.keys(bag).length });
    return { fields: bag, model: res.model, ms, attempts: (res.attempts || []).length, ok: true, error: null };
  } catch (e) {
    const ms = Date.now() - started;
    log.warn('parse.llm', { model: null, ms, attempts: (e.attempts || []).length, ok: false, error: e.message });
    return { fields: {}, model: null, ms, attempts: (e.attempts || []).length, ok: false, error: e.message };
  }
}

module.exports = { llmExtract, extractJson, buildPrompt, describeField, SYSTEM, MIN_TOKENS, DEFAULT_CHAIN };
