'use strict';

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const {
  complete,
  utilizationDecision,
  __setUtilizationReaderForTest,
  __resetUtilizationForTest,
} = require('../../../shared/llm');

const GLM = 'zai-org/GLM-5.2-TEE';
const QWEN = 'Qwen/Qwen3.8-27B-TEE';
const ENV_KEYS = ['CHUTES_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  'MAILMINT_LLM_EXTRA_PROVIDERS', 'MAILMINT_LLM_UTILIZATION_MAX', 'MAILMINT_LLM_UTILIZATION_TTL_MS'];

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

const QUIET = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function withWarnings() {
  const warnings = [];
  return { warnings, log: { ...QUIET, warn: (m) => warnings.push(m) } };
}

/**
 * Replaces the transport so no test can touch the network. Answers the
 * live-model probe (POST /v1/models) with the given model list and records
 * the `model` of every completion request.
 */
function stubNetwork({ models }) {
  const realRequest = https.request;
  const realGet = https.get;
  const calls = { request: 0, get: 0, completions: [] };
  const respond = (cb, status, body) => {
    setImmediate(() => {
      const payload = JSON.stringify(body);
      const res = {
        statusCode: status,
        resume() {},
        on(event, handler) {
          if (event === 'data') handler(payload);
          else if (event === 'end') handler();
          return this;
        },
      };
      cb(res);
    });
  };
  https.request = (opts, cb) => {
    calls.request += 1;
    return {
      on() { return this; },
      setTimeout() { return this; },
      destroy() {},
      end(data) {
        const body = data ? JSON.parse(data) : {};
        if (opts.path === '/v1/models') {
          respond(cb, 200, { data: models.map((m) => ({ id: m })) });
        } else {
          calls.completions.push(body.model);
          respond(cb, 200, { choices: [{ message: { content: '{"fields":{}}' } }] });
        }
      },
    };
  };
  https.get = () => { calls.get += 1; throw new Error('unexpected https.get'); };
  return {
    calls,
    total: () => calls.request + calls.get,
    restore() { https.request = realRequest; https.get = realGet; },
  };
}

const busyReading = (rows) => ({ at: Date.now(), rows });

test('a busy chutes model (0.878) is skipped and the next healthy one is called', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM, QWEN] });
  __setUtilizationReaderForTest(async () => busyReading([
    { name: GLM, utilization_5m: 0.878, rate_limit_ratio_5m: 0.651 },
    { name: QWEN, utilization_5m: 0.03, rate_limit_ratio_5m: 0.01 },
  ]));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { warnings, log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [
      { provider: 'chutes', model: GLM },
      { provider: 'chutes', model: QWEN },
    ],
    log,
  });
  assert.strictEqual(res.model, QWEN);
  assert.deepStrictEqual(net.calls.completions, [QWEN]);
  assert.ok(warnings.some((w) => w.startsWith(`[llm] skipping chutes/${GLM}`) && w.includes('0.88 >= 0.75')),
    JSON.stringify(warnings));
});

test('a healthy chutes model (0.03) is not skipped', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [QWEN] });
  __setUtilizationReaderForTest(async () => busyReading([
    { name: QWEN, utilization_5m: 0.03, rate_limit_ratio_5m: 0.01 },
  ]));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { warnings, log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [{ provider: 'chutes', model: QWEN }],
    log,
  });
  assert.strictEqual(res.model, QWEN);
  assert.deepStrictEqual(net.calls.completions, [QWEN]);
  assert.ok(!warnings.some((w) => w.includes('skipping')), JSON.stringify(warnings));
});

test('fail-open: an unreachable utilization API skips nothing', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM] });
  __setUtilizationReaderForTest(async () => { throw new Error('ECONNREFUSED'); });
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [{ provider: 'chutes', model: GLM }],
    log,
  });
  assert.strictEqual(res.model, GLM);
  assert.deepStrictEqual(net.calls.completions, [GLM]);
});

test('fail-open: a malformed reading skips nothing', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM] });
  __setUtilizationReaderForTest(async () => ({ at: Date.now(), rows: 'garbage, not an array' }));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [{ provider: 'chutes', model: GLM }],
    log,
  });
  assert.strictEqual(res.model, GLM);
  assert.deepStrictEqual(net.calls.completions, [GLM]);
});

test('fail-open: a stale reading (>15 min old) skips nothing', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM] });
  __setUtilizationReaderForTest(async () => ({
    at: Date.now() - 16 * 60_000,
    rows: [{ name: GLM, utilization_5m: 0.99, rate_limit_ratio_5m: 0.9 }],
  }));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [{ provider: 'chutes', model: GLM }],
    log,
  });
  assert.strictEqual(res.model, GLM);
  assert.deepStrictEqual(net.calls.completions, [GLM]);
});

test('every chutes model busy: original order kept, nothing dropped, no throw', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM, QWEN] });
  __setUtilizationReaderForTest(async () => busyReading([
    { name: GLM, utilization_5m: 0.9, rate_limit_ratio_5m: 0.8 },
    { name: QWEN, utilization_5m: 0.95, rate_limit_ratio_5m: 0.85 },
  ]));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { warnings, log } = withWarnings();
  const res = await complete([{ role: 'user', content: 'hi' }], {
    chain: [
      { provider: 'chutes', model: GLM },
      { provider: 'chutes', model: QWEN },
    ],
    log,
  });
  assert.strictEqual(res.model, GLM, 'first entry of the original order must be tried');
  assert.strictEqual(net.calls.completions[0], GLM);
  assert.ok(warnings.some((w) => w.includes('keeping original order')), JSON.stringify(warnings));
});

test('without CHUTES_API_KEY the gate performs no network call at all', async (t) => {
  const env = saveEnv(ENV_KEYS);
  delete process.env.CHUTES_API_KEY;
  const net = stubNetwork({ models: [] });
  __resetUtilizationForTest();
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  await assert.rejects(
    complete([{ role: 'user', content: 'hi' }], {
      chain: [{ provider: 'chutes', model: GLM }],
      log: QUIET,
    }),
    (err) => {
      assert.match(err.message, /^every model in the chain failed/);
      return true;
    },
  );
  assert.strictEqual(net.total(), 0, 'no https.request or https.get may happen without a key');
});

test('the gate consults the injected reader once per cache window', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [QWEN] });
  let reads = 0;
  __setUtilizationReaderForTest(async () => { reads += 1; return busyReading([]); });
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { log } = withWarnings();
  const opts = { chain: [{ provider: 'chutes', model: QWEN }], log };
  await complete([{ role: 'user', content: 'hi' }], opts);
  await complete([{ role: 'user', content: 'hi' }], opts);
  assert.strictEqual(reads, 1, 'the second complete() must hit the 120 s cache');
  assert.deepStrictEqual(net.calls.completions, [QWEN, QWEN]);
});

test('a failed utilization probe is cached: an outage does not re-probe every extraction', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [QWEN] });
  let reads = 0;
  __setUtilizationReaderForTest(async () => { reads += 1; throw new Error('ECONNREFUSED'); });
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const { log } = withWarnings();
  const opts = { chain: [{ provider: 'chutes', model: QWEN }], log };
  await complete([{ role: 'user', content: 'hi' }], opts);
  await complete([{ role: 'user', content: 'hi' }], opts);
  assert.strictEqual(reads, 1, 'the failed probe must be cached for the cache window');
  assert.deepStrictEqual(net.calls.completions, [QWEN, QWEN], 'fail-open: both extractions still ran');
});

test('MAILMINT_LLM_UTILIZATION_MAX overrides the threshold; invalid values fall back to 0.75', async (t) => {
  const env = saveEnv(ENV_KEYS);
  process.env.CHUTES_API_KEY = 'test-only-fake-key';
  const net = stubNetwork({ models: [GLM, QWEN] });
  __setUtilizationReaderForTest(async () => busyReading([
    { name: GLM, utilization_5m: 0.8, rate_limit_ratio_5m: 0.7 },
    { name: QWEN, utilization_5m: 0.03, rate_limit_ratio_5m: 0.01 },
  ]));
  t.after(() => { net.restore(); __resetUtilizationForTest(); restoreEnv(env); });

  const chain = [
    { provider: 'chutes', model: GLM },
    { provider: 'chutes', model: QWEN },
  ];
  const { log } = withWarnings();

  process.env.MAILMINT_LLM_UTILIZATION_MAX = '0.9';
  let res = await complete([{ role: 'user', content: 'hi' }], { chain, log });
  assert.strictEqual(res.model, GLM, '0.8 < 0.9 must not be skipped');

  process.env.MAILMINT_LLM_UTILIZATION_MAX = 'not-a-number';
  net.calls.completions.length = 0;
  res = await complete([{ role: 'user', content: 'hi' }], { chain, log });
  assert.strictEqual(res.model, QWEN, 'invalid threshold must fall back to 0.75 and skip 0.8');
});

test('utilizationDecision: case-insensitive id match, short-name fallback, unknown never skips', () => {
  const rows = [
    { name: 'ZAI-ORG/glm-5.2-tee', utilization_5m: 0.878 },
    { name: 'Qwen3.8-27B-TEE', utilization_5m: 0.99 },
    { name: 'other/model', utilization_5m: 0.1 },
    { name: 'null/model', utilization_5m: null },
  ];
  assert.strictEqual(utilizationDecision(rows, 'zai-org/GLM-5.2-TEE', 0.75).status, 'skip');
  assert.strictEqual(utilizationDecision(rows, 'Qwen/Qwen3.8-27B-TEE', 0.75).status, 'skip', 'matches on the part after the last /');
  assert.strictEqual(utilizationDecision(rows, 'Qwen/Qwen3.8-27B-TEE', 0.999).status, 'allow');
  assert.strictEqual(utilizationDecision(rows, 'other/model', 0.75).status, 'allow');
  assert.strictEqual(utilizationDecision(rows, 'nope/missing', 0.75).status, 'unknown');
  assert.strictEqual(utilizationDecision(rows, 'null/model', 0.75).status, 'unknown', 'null utilization is not a reading');
  assert.strictEqual(utilizationDecision('garbage', 'x', 0.75).status, 'unknown');
});
