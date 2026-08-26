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

/** Which chutes models exist right now. Empty set means "could not check". */
async function liveChutesModels() {
  try {
    const r = await post('llm.chutes.ai', '/v1/models', {}, {}, 20_000).catch(() => null);
    if (r && r.status === 200) return new Set(JSON.parse(r.body).data.map((m) => m.id));
    const got = await new Promise((resolve) => {
      https.get({ host: 'llm.chutes.ai', path: '/v1/models',
        headers: { authorization: `Bearer ${process.env.CHUTES_API_KEY}` } }, (res) => {
        let o = ''; res.on('data', (c) => { o += c; }); res.on('end', () => resolve(o));
      }).on('error', () => resolve(null));
    });
    return got ? new Set(JSON.parse(got).data.map((m) => m.id)) : new Set();
  } catch { return new Set(); }
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
  const live = await liveChutesModels();
  const useChain = (chain || CHAIN).filter((e) =>
    e.provider !== 'chutes' || live.size === 0 || live.has(e.model));
  if (live.size && useChain.length < (chain || CHAIN).length) {
    log.warn?.(`[llm] ${(chain || CHAIN).length - useChain.length} chutes model(s) no longer offered; skipping`);
  }
  const attempts = [];
  for (const entry of useChain) {
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

module.exports = { complete, CHAIN, MIN_TOKENS, liveChutesModels };
