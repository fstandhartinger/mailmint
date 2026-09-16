'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_CHAIN } = require('../src/extract-llm');

test('DEFAULT_CHAIN pins the full model order, Qwen3.8-27B right after GLM-5.2', () => {
  assert.deepStrictEqual(DEFAULT_CHAIN, [
    { provider: 'chutes', model: 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE' },
    { provider: 'chutes', model: 'moonshotai/Kimi-K3-TEE' },
    { provider: 'chutes', model: 'zai-org/GLM-5.2-TEE' },
    { provider: 'chutes', model: 'Qwen/Qwen3.8-27B-TEE' },
    { provider: 'gemini', model: 'gemini-3-flash-preview' },
    { provider: 'openai', model: 'gpt-5-mini' },
  ]);
});

test('Qwen/Qwen3.8-27B-TEE appears exactly once, immediately after zai-org/GLM-5.2-TEE', () => {
  const models = DEFAULT_CHAIN.map((e) => e.model);
  assert.strictEqual(models.filter((m) => m === 'Qwen/Qwen3.8-27B-TEE').length, 1);
  const glm = models.indexOf('zai-org/GLM-5.2-TEE');
  assert.strictEqual(models[glm + 1], 'Qwen/Qwen3.8-27B-TEE');
});

test('the non-Chutes tail is exactly gemini-3-flash-preview then gpt-5-mini, in that order', () => {
  const tail = DEFAULT_CHAIN.filter((e) => e.provider !== 'chutes');
  assert.deepStrictEqual(tail, [
    { provider: 'gemini', model: 'gemini-3-flash-preview' },
    { provider: 'openai', model: 'gpt-5-mini' },
  ]);
});
