'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { config } = require('./config');

/**
 * §6: JSON lines to stdout, one object per line, `request_id` on every line.
 *
 * A daily observer agent reads these, so the shape matters more than the
 * prose. Two rules that are easy to break and expensive to lose:
 *
 *  - `request_id` is carried in async-local storage, so a log line written by a
 *    background parse three ticks after the HTTP response still names the
 *    request that caused it. Passing it by hand through every function is how
 *    it goes missing exactly where you need it.
 *  - bodies never reach info level. `redact()` truncates anything that looks
 *    like content and drops the well-known secret keys outright.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] || LEVELS.info;

const store = new AsyncLocalStorage();

/** Runs `fn` with `requestId` attached to every log line it or its callees write. */
function withRequestId(requestId, fn) {
  return store.run({ requestId }, fn);
}

const currentRequestId = () => (store.getStore() || {}).requestId || null;

const SECRET_KEYS = /^(password|password_hash|authorization|api_key|apikey|secret|webhook_secret|token|hash|bytes|raw_mime|content_base64)$/i;
const MAX_STRING = 200;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '<deep>';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '<redacted>' : redact(v, depth + 1);
  }
  return out;
}

function write(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    request_id: (fields && fields.request_id) || currentRequestId(),
    event,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'request_id') continue;
      line[k] = k === 'error' && v instanceof Error ? String(v.message || v) : redact(v);
    }
  }
  // One write, one line: a partial line is worse than no line for a log reader.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const log = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  withRequestId,
  currentRequestId,
};

/**
 * The shared LLM client (shared/llm.js) logs through a console-like object.
 * This adapts it onto the JSON stream so an LLM fallback shows up in the same
 * place as everything else instead of as loose text.
 */
function llmLogger(stage = 'parse.llm') {
  return {
    info: (msg) => write('info', stage, { msg: String(msg) }),
    warn: (msg) => write('warn', stage, { msg: String(msg) }),
    error: (msg) => write('error', stage, { msg: String(msg) }),
    log: (msg) => write('info', stage, { msg: String(msg) }),
  };
}

module.exports = { log, llmLogger, redact };
