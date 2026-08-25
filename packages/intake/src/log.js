'use strict';

/** JSON lines to stdout, per CONTRACT §6. Never a full body at info level. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function emit(level, event, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  if (line.request_id === undefined) line.request_id = null;
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const log = {
  debug: (event, f) => emit('debug', event, f),
  info: (event, f) => emit('info', event, f),
  warn: (event, f) => emit('warn', event, f),
  error: (event, f) => emit('error', event, f),
  /** A logger with fields baked in, for one connection. */
  child(base) {
    return {
      debug: (e, f) => emit('debug', e, { ...base, ...f }),
      info: (e, f) => emit('info', e, { ...base, ...f }),
      warn: (e, f) => emit('warn', e, { ...base, ...f }),
      error: (e, f) => emit('error', e, { ...base, ...f }),
      child: (more) => log.child({ ...base, ...more }),
    };
  },
};

module.exports = { log };
