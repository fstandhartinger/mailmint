'use strict';
/**
 * One LLM client for every PDFMint-family service.
 *
 * Why this exists rather than each service rolling its own: the models we use
 * are REASONING models. They emit `reasoning_content` and spend max_tokens on
 * it before writing a single character of `content`. Ask for 10 tokens and you
 * get an empty string and a finish_reason of "length" — which looks exactly
 * like a broken key. That trap cost real time to find, so it is encoded here
 * once: MIN_TOKENS is a floor, not a suggestion.
 *
 * Chutes model ids change as their portfolio changes, so the chain is verified
 * against llm.chutes.ai/v1/models at startup rather than hard-trusted.
 */
const https = require('node:https');

const MIN_TOKENS = 512;          // below this a reasoning model returns nothing
const ATTEMPT_TIMEOUT_MS = 90_000;
const ALLOWED_EXTRA_PROVIDERS = new Set(['gemini', 'openai']);
const warnedDisabledProviders = new Set();
const UTILIZATION_TIMEOUT_MS = 5_000;      // hard bound on the utilization probe
const UTILIZATION_MAX_AGE_MS = 15 * 60_000; // older than this, a reading skips nothing
const UTILIZATION_TTL_MS = 120_000;        // default cache lifetime for a reading
let utilizationStarvationWarned = false;

function providerName(entry) {
  return String(entry && entry.provider || '').toLowerCase();
}

function enabledExtraProviders(env) {
  const raw = env && env.MAILMINT_LLM_EXTRA_PROVIDERS;
  return new Set(String(raw || '').split(',').map((p) => p.trim().toLowerCase())
    .filter((p) => ALLOWED_EXTRA_PROVIDERS.has(p)));
}

function effectiveChain(chain, env = process.env) {
  const enabled = enabledExtraProviders(env);
  return (chain || []).filter((entry) => {
    const provider = providerName(entry);
    return provider === 'chutes' || enabled.has(provider);
  });
}

function warnDisabledProviders(chain, effective, log) {
  const removed = new Set(chain.map((entry) => providerName(entry)));
  for (const provider of removed) {
    if (provider === 'chutes' || effective.some((entry) => providerName(entry) === provider)
      || warnedDisabledProviders.has(provider)) continue;
    const ep = ENDPOINTS[provider];
    if (!ep || !ep.key?.() || warnedDisabledProviders.has(provider)) continue;
    warnedDisabledProviders.add(provider);
    log.warn?.(`[llm] ${provider} provider disabled`);
  }
}

/** Ordered by capability, then cost. Each entry is tried until one answers. */
const CHAIN = [
  { provider: 'chutes', model: 'moonshotai/Kimi-K3-TEE' },
  { provider: 'chutes', model: 'zai-org/GLM-5.2-TEE' },
  { provider: 'chutes', model: 'Qwen/Qwen3.5-397B-A17B-TEE' },
  { provider: 'chutes', model: 'Qwen/Qwen3.8-27B-TEE' },
  { provider: 'chutes', model: 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE' },
  { provider: 'gemini', model: 'gemini-3-flash-preview' },
  { provider: 'gemini', model: 'gemini-flash-latest' },
  { provider: 'openai', model: 'gpt-5-mini' },
  { provider: 'openai', model: 'gpt-5' },
];

const ENDPOINTS = {
  chutes: { host: 'llm.chutes.ai', path: '/v1/chat/completions', key: () => process.env.CHUTES_API_KEY },
  openai: { host: 'api.openai.com', path: '/v1/chat/completions', key: () => process.env.OPENAI_API_KEY },
  gemini: { host: 'generativelanguage.googleapis.com', path: null, key: () => process.env.GOOGLE_API_KEY },
};

function post(host, path, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.end(data);
  });
}

/**
 * Which chutes models exist right now. Empty set means "could not check".
 *
 * Two things here were measured on 2026-09-07 while working out why
 * packages/api/test/reparse.test.js appeared to hang: this runs on EVERY
 * complete(), the POST is bounded at 20 s, and the GET that follows it had no
 * timeout at all — so a host that accepts the connection and never answers hangs
 * the caller for as long as the socket lives. In the test environment, where
 * there is no Chutes key, the whole probe is also pointless: callOnce() refuses a
 * keyless provider immediately, so nothing the probe learns can be used.
 */
async function liveChutesModels() {
  if (!process.env.CHUTES_API_KEY) return new Set();
  try {
    const r = await post('llm.chutes.ai', '/v1/models', {}, {}, 20_000).catch(() => null);
    if (r && r.status === 200) return new Set(JSON.parse(r.body).data.map((m) => m.id));
    const got = await new Promise((resolve) => {
      const req = https.get({ host: 'llm.chutes.ai', path: '/v1/models',
        headers: { authorization: `Bearer ${process.env.CHUTES_API_KEY}` } }, (res) => {
        let o = ''; res.on('data', (c) => { o += c; }); res.on('end', () => resolve(o));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(20_000, () => { req.destroy(); resolve(null); });
    });
    return got ? new Set(JSON.parse(got).data.map((m) => m.id)) : new Set();
  } catch { return new Set(); }
}

/**
 * Chutes utilization gate.
 *
 * A model that is already saturated (utilization_5m >= threshold) adds queue
 * latency to every extraction, so a busy chutes entry is skipped in favour of
 * the next one. The gate is fail-open by design: an outage of the utilization
 * API can never stop email processing, so no key, no reading, a stale reading
 * or a busy host all mean "skip nothing". And if the gate would drop EVERY
 * chutes entry, the original order is kept — better a busy model than no
 * extraction.
 *
 * The reading comes from GET https://api.chutes.ai/chutes/utilization (a JSON
 * array of {name, utilization_5m, rate_limit_ratio_5m, ...}). The `name` is
 * the chute name and is not always identical to the chain's model id, so
 * matching is case-insensitive on the full id first, then on the part after
 * the last "/". A model with no matching row is "unknown" and is never
 * skipped.
 */
function defaultUtilizationReader() {
  // No key means no network at all: the test suite runs keyless, and a probe
  // here would hang it (same lesson as liveChutesModels above).
  if (!process.env.CHUTES_API_KEY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get({ host: 'api.chutes.ai', path: '/chutes/utilization',
      headers: { authorization: `Bearer ${process.env.CHUTES_API_KEY}` } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { done({ rows: JSON.parse(out), at: Date.now() }); }
        catch { done(null); }
      });
    });
    req.on('error', () => done(null));
    req.setTimeout(UTILIZATION_TIMEOUT_MS, () => { req.destroy(); done(null); });
  });
}

// TEST-ONLY seam: swap in a fake reader (or restore the real one). Setting a
// reader clears the cache so each test starts clean. Production code never
// calls these.
let utilizationReader = defaultUtilizationReader;
let utilizationCache = null; // { reading, cachedAt }
function __setUtilizationReaderForTest(fn) {
  utilizationReader = fn;
  utilizationCache = null;
}
function __resetUtilizationForTest() {
  utilizationReader = defaultUtilizationReader;
  utilizationCache = null;
  utilizationStarvationWarned = false;
}

function utilizationTtlMs(env) {
  const ms = Number(env.MAILMINT_LLM_UTILIZATION_TTL_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : UTILIZATION_TTL_MS;
}

function utilizationThreshold(env) {
  const max = Number(env.MAILMINT_LLM_UTILIZATION_MAX);
  return Number.isFinite(max) && max > 0 && max <= 1 ? max : 0.75;
}

function validUtilizationReading(r) {
  return Boolean(r) && Array.isArray(r.rows) && Number.isFinite(r.at);
}

async function currentUtilizationReading(env) {
  const now = Date.now();
  if (utilizationCache && now - utilizationCache.cachedAt <= utilizationTtlMs(env)) {
    return utilizationCache.reading;
  }
  let reading = null;
  try { reading = await utilizationReader(); } catch { reading = null; }
  if (!validUtilizationReading(reading)) reading = null;
  // A failed probe is cached too: while the utilization API is down, every
  // extraction would otherwise wait up to UTILIZATION_TIMEOUT_MS for it again.
  utilizationCache = { reading, cachedAt: now };
  return reading;
}

function findUtilizationRow(rows, model) {
  if (!Array.isArray(rows)) return null;
  const id = String(model).toLowerCase();
  const short = id.slice(id.lastIndexOf('/') + 1);
  for (const row of rows) {
    if (String(row && row.name || '').toLowerCase() === id) return row;
  }
  for (const row of rows) {
    if (String(row && row.name || '').toLowerCase() === short) return row;
  }
  return null;
}

/**
 * Pure decision for one model: {status: 'skip'|'allow'|'unknown', utilization?}.
 * "unknown" (no matching row, or a non-numeric reading) never skips.
 */
function utilizationDecision(rows, model, threshold) {
  const row = findUtilizationRow(rows, model);
  if (!row) return { status: 'unknown' };
  const u = row.utilization_5m;
  // Only a real finite number decides; anything else (null, "", NaN) is
  // "unknown" and never skips — Number(null) === 0 would lie about health.
  if (typeof u !== 'number' || !Number.isFinite(u)) return { status: 'unknown' };
  return { status: u >= threshold ? 'skip' : 'allow', utilization: u };
}

/**
 * Apply the utilization gate to a chain that has already passed the provider
 * opt-in (effectiveChain) and the live-model filter (liveChutesModels).
 * Returns the chain to try; never throws, never drops a non-chutes entry.
 */
async function applyUtilizationGate(chain, log, env) {
  const chutesEntries = chain.filter((e) => providerName(e) === 'chutes');
  if (!chutesEntries.length) return chain;
  const reading = await currentUtilizationReading(env);
  if (!reading || Date.now() - reading.at > UTILIZATION_MAX_AGE_MS) return chain;
  const threshold = utilizationThreshold(env);
  const skipped = [];
  for (const entry of chutesEntries) {
    const d = utilizationDecision(reading.rows, entry.model, threshold);
    if (d.status === 'skip') skipped.push({ entry, utilization: d.utilization });
  }
  if (skipped.length === chutesEntries.length) {
    if (!utilizationStarvationWarned) {
      utilizationStarvationWarned = true;
      log.warn?.('[llm] utilization gate would drop every chutes model; keeping original order');
    }
    return chain;
  }
  const drop = new Set(skipped.map((s) => s.entry));
  for (const s of skipped) {
    log.warn?.(`[llm] skipping chutes/${s.entry.model}: utilization ${Number(s.utilization.toFixed(2))} >= ${threshold}`);
  }
  return chain.filter((e) => !drop.has(e));
}

async function callOnce(entry, messages, maxTokens, log) {
  const { provider, model } = entry;
  const ep = ENDPOINTS[provider];
  const key = ep.key();
  if (!key) throw new Error(`no api key for ${provider}`);
  const started = Date.now();

  if (provider === 'gemini') {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const contents = messages.filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const r = await post(ep.host, `/v1beta/models/${model}:generateContent?key=${key}`, {}, {
      contents,
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, MIN_TOKENS) },
    }, ATTEMPT_TIMEOUT_MS);
    if (r.status !== 200) throw new Error(`gemini ${r.status}: ${r.body.slice(0, 200)}`);
    const j = JSON.parse(r.body);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('');
    if (!text) throw new Error(`gemini empty (${j.candidates?.[0]?.finishReason})`);
    return { text, model, provider, ms: Date.now() - started };
  }

  const r = await post(ep.host, ep.path, { authorization: `Bearer ${key}` }, {
    model, messages,
    // The floor matters: reasoning models burn this budget before writing content.
    max_tokens: Math.max(maxTokens, MIN_TOKENS),
  }, ATTEMPT_TIMEOUT_MS);
  if (r.status !== 200) throw new Error(`${provider} ${r.status}: ${r.body.slice(0, 200)}`);
  const j = JSON.parse(r.body);
  const choice = j.choices?.[0] || {};
  const text = choice.message?.content || '';
  if (!text) {
    throw new Error(`${provider} returned no content (finish_reason=${choice.finish_reason}`
      + `${choice.message?.reasoning_content ? ', spent budget on reasoning — raise max_tokens' : ''})`);
  }
  return { text, model, provider, ms: Date.now() - started, reasoning: choice.message?.reasoning_content || null };
}

/**
 * Ask the chain. Returns {text, model, provider, ms, attempts}.
 * Every attempt is logged, including the failures — a silent fallback that
 * quietly lands on the weakest model is how quality regresses unnoticed.
 */
async function complete(messages, { maxTokens = 2048, log = console, chain = null } = {}) {
  const requestedChain = chain || CHAIN;
  const useChain = effectiveChain(requestedChain);
  warnDisabledProviders(requestedChain, useChain, log);
  const live = await liveChutesModels();
  const filteredChain = useChain.filter((e) =>
    e.provider !== 'chutes' || live.size === 0 || live.has(e.model));
  if (live.size && filteredChain.length < useChain.length) {
    log.warn?.(`[llm] ${useChain.length - filteredChain.length} chutes model(s) no longer offered; skipping`);
  }
  // Filter order: provider opt-in (effectiveChain) -> live models -> utilization.
  const gatedChain = await applyUtilizationGate(filteredChain, log, process.env);
  const attempts = [];
  for (const entry of gatedChain) {
    try {
      const res = await callOnce(entry, messages, maxTokens, log);
      attempts.push({ ...entry, ok: true, ms: res.ms });
      log.info?.(`[llm] ok ${entry.provider}/${entry.model} in ${res.ms}ms`
        + (attempts.length > 1 ? ` after ${attempts.length - 1} failure(s)` : ''));
      return { ...res, attempts };
    } catch (e) {
      attempts.push({ ...entry, ok: false, error: e.message });
      log.warn?.(`[llm] ${entry.provider}/${entry.model} failed: ${e.message}`);
    }
  }
  const err = new Error(`every model in the chain failed (${attempts.length} tried)`);
  err.attempts = attempts;
  throw err;
}

module.exports = {
  complete, effectiveChain, CHAIN, MIN_TOKENS, liveChutesModels,
  utilizationDecision,
  // TEST-ONLY seams (see above): never call from production code.
  __setUtilizationReaderForTest, __resetUtilizationForTest,
};
