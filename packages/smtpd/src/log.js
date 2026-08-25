'use strict';
// JSON-lines logging to stdout. CONTRACT §6.
// Every line: {ts, level, request_id, event, ...}. Never a full body at info.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let threshold = LEVELS.info;
let sink = (line) => process.stdout.write(line + '\n');

function setLevel(level) {
  threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
}
function setSink(fn) { sink = fn; }

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const rec = { ts: new Date().toISOString(), level, request_id: null, event };
  if (fields) for (const k of Object.keys(fields)) rec[k] = fields[k];
  let line;
  try {
    line = JSON.stringify(rec, replacer);
  } catch {
    line = JSON.stringify({ ts: rec.ts, level: 'error', request_id: null, event: 'log.unserialisable', orig: event });
  }
  sink(line);
}

function replacer(key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}>`;
  return value;
}

const log = {
  setLevel,
  setSink,
  levels: LEVELS,
  debug: (event, f) => emit('debug', event, f),
  info: (event, f) => emit('info', event, f),
  warn: (event, f) => emit('warn', event, f),
  error: (event, f) => emit('error', event, f),
};

module.exports = log;
