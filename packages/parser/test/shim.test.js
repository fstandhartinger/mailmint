'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { llmShim } = require('../src/log');

test('llmShim classifies skip, failure and other warnings into distinct events', () => {
  const events = [];
  const log = { warn: (event, data) => events.push([event, data]) };
  const shim = llmShim(log);

  shim.warn('[llm] skipping chutes/zai-org/GLM-5.2-TEE: utilization 0.88 >= 0.75');
  shim.warn('[llm] 1 chutes model(s) no longer offered; skipping');
  shim.warn('[llm] chutes/deepseek-ai/DeepSeek-V4-Flash-0731-TEE failed: no api key for chutes');
  shim.warn('[llm] utilization gate would drop every chutes model; keeping original order');

  assert.strictEqual(events[0][0], 'parse.llm.skipped', 'a saturation skip is not an attempt failure');
  assert.strictEqual(events[1][0], 'parse.llm.skipped', 'a removal skip is not an attempt failure');
  assert.strictEqual(events[2][0], 'parse.llm.attempt_failed', 'an actual failure stays an attempt failure');
  assert.strictEqual(events[3][0], 'parse.llm.warning');
  for (const [, data] of events) assert.strictEqual(typeof data.msg, 'string');
});

test('llmShim keeps failures classified even when their text resembles a skip', () => {
  const events = [];
  const log = { warn: (event, data) => events.push(event) };
  llmShim(log).warn('[llm] zai-org/GLM-5.2-TEE failed: upstream busy; skipping');
  assert.strictEqual(events[0], 'parse.llm.attempt_failed',
    'an actual model failure must never be reported as a skip');
});
