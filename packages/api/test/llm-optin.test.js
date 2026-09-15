'use strict';

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const { complete, effectiveChain } = require('../../../shared/llm');
const { extractAttachment, ocrEnabled } = require('../../docs/src/index');

const CHAIN = [
  { provider: 'chutes', model: 'chutes-model' },
  { provider: 'gemini', model: 'gemini-model' },
  { provider: 'openai', model: 'openai-model' },
];

function saveEnv(keys) {
  const saved = new Map();
  for (const key of keys) saved.set(key, process.env[key]);
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('effectiveChain keeps only Chutes unless extra providers are enabled', () => {
  assert.deepStrictEqual(effectiveChain(CHAIN, {}), [CHAIN[0]]);
  assert.deepStrictEqual(effectiveChain(CHAIN, { MAILMINT_LLM_EXTRA_PROVIDERS: 'gemini' }), CHAIN.slice(0, 2));
  assert.deepStrictEqual(
    effectiveChain(CHAIN, { MAILMINT_LLM_EXTRA_PROVIDERS: ' OpenAI , gemini ' }),
    CHAIN,
  );
  assert.deepStrictEqual(
    effectiveChain(CHAIN, { MAILMINT_LLM_EXTRA_PROVIDERS: 'unknown, GEMINI' }),
    CHAIN.slice(0, 2),
  );
});

test('complete filters disabled providers before any network call', async (t) => {
  const env = saveEnv(['CHUTES_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'MAILMINT_LLM_EXTRA_PROVIDERS']);
  const request = https.request;
  const get = https.get;
  let networkCalls = 0;
  https.request = () => { networkCalls += 1; throw new Error('network call'); };
  https.get = () => { networkCalls += 1; throw new Error('network call'); };
  t.after(() => {
    https.request = request;
    https.get = get;
    restoreEnv(env);
  });

  delete process.env.CHUTES_API_KEY;
  process.env.GOOGLE_API_KEY = 'fake-gemini-key';
  process.env.OPENAI_API_KEY = 'fake-openai-key';
  delete process.env.MAILMINT_LLM_EXTRA_PROVIDERS;

  const warnings = [];
  await assert.rejects(
    complete([{ role: 'user', content: 'hello' }], {
      chain: CHAIN.slice(1),
      log: { warn: (message) => warnings.push(message) },
    }),
    (err) => {
      assert.match(err.message, /^every model in the chain failed/);
      assert.strictEqual(err.attempts.length, 0);
      return true;
    },
  );
  assert.strictEqual(networkCalls, 0);
  assert.deepStrictEqual(warnings, ['[llm] gemini provider disabled', '[llm] openai provider disabled']);
});

test('ocrEnabled requires an explicit Gemini opt-in', () => {
  assert.strictEqual(ocrEnabled({}), false);
  assert.strictEqual(ocrEnabled({ MAILMINT_LLM_EXTRA_PROVIDERS: 'gemini' }), true);
  assert.strictEqual(ocrEnabled({ MAILMINT_LLM_EXTRA_PROVIDERS: ' OpenAI , gemini ' }), true);
  assert.strictEqual(ocrEnabled({ MAILMINT_LLM_EXTRA_PROVIDERS: 'unknown' }), false);
});

test('OCR is unavailable without the Gemini opt-in, even with an explicit key', async (t) => {
  const env = saveEnv(['GOOGLE_API_KEY', 'MAILMINT_LLM_EXTRA_PROVIDERS']);
  const request = https.request;
  let networkCalls = 0;
  https.request = () => { networkCalls += 1; throw new Error('network call'); };
  t.after(() => {
    https.request = request;
    restoreEnv(env);
  });

  process.env.GOOGLE_API_KEY = 'fake-gemini-key';
  delete process.env.MAILMINT_LLM_EXTRA_PROVIDERS;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = await extractAttachment(
    { buffer: png, filename: 'blank.png' },
    { ocr: true, log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
  );

  assert.ok(result.meta.warnings.includes('ocr_unavailable:gemini_not_enabled'), JSON.stringify(result.meta.warnings));
  assert.strictEqual(result.meta.ocr, false);
  assert.strictEqual(networkCalls, 0);
});
