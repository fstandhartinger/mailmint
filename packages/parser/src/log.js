'use strict';

/**
 * §6 logging. JSON lines on stdout, one object per line, always carrying
 * {ts, level, request_id, event}. Callers may inject their own logger; this is
 * the default so the library is never silent by accident and never chatty by
 * default either.
 */
function makeLogger(opts) {
  const o = opts || {};
  const sink = o.sink || ((line) => process.stdout.write(line + '\n'));
  const enabled = o.enabled !== false;
  const base = { ...(o.base || {}) };

  function emit(level, event, data) {
    if (!enabled) return;
    const rec = { ts: new Date().toISOString(), level, request_id: (data && data.request_id) || base.request_id || null, event };
    for (const [k, v] of Object.entries(data || {})) if (k !== 'request_id') rec[k] = v;
    try { sink(JSON.stringify(rec)); } catch { /* logging must never break parsing */ }
  }
  return {
    debug: (event, data) => emit('debug', event, data),
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    child: (extra) => makeLogger({ ...o, base: { ...base, ...extra } }),
  };
}

/**
 * Accept whatever logger the host injects.
 *
 * The contract's shape is `log.info(event, data)`. We call it that way for any
 * object that offers the methods — sniffing `fn.length` to guess the intended
 * signature was a bug: `info(){ ... }` written with no declared parameters is
 * perfectly normal and was being misread as console-style.
 */
function normaliseLogger(log) {
  if (!log) return makeLogger({ enabled: false });
  if (log === console || log.__consoleStyle) return consoleAdapter(log);
  const call = (level) => (event, data) => {
    const fn = typeof log[level] === 'function' ? log[level] : log.log;
    if (typeof fn !== 'function') return;
    try { fn.call(log, event, data); } catch { /* logging must never break parsing */ }
  };
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error'),
    child: typeof log.child === 'function' ? (x) => normaliseLogger(log.child(x)) : () => normaliseLogger(log) };
}

function consoleAdapter(log) {
  const wrap = (level) => (event, data) => {
    const fn = log[level] || log.log || (() => {});
    try { fn.call(log, JSON.stringify({ ts: new Date().toISOString(), level, event, ...(data || {}) })); }
    catch { /* ignore */ }
  };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), child: () => consoleAdapter(log) };
}

/** The shared LLM client speaks console-style `log.info('string')`. */
function llmShim(log) {
  return {
    info: (msg) => log.debug('parse.llm.trace', { msg: String(msg) }),
    warn: (msg) => log.warn('parse.llm.attempt_failed', { msg: String(msg) }),
    error: (msg) => log.error('parse.llm.error', { msg: String(msg) }),
  };
}

module.exports = { makeLogger, normaliseLogger, llmShim };
