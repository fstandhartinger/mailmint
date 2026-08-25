'use strict';

/**
 * CONTRACT §6 logging. JSON lines, `{ts, level, request_id, event, ...}`.
 *
 * This package is a library: it must never be chatty by default and must never
 * blow up because a host handed us an odd logger. Both are enforced here rather
 * than at every call site.
 */
function makeLogger(opts) {
  const o = opts || {};
  const sink = o.sink || ((line) => process.stdout.write(line + '\n'));
  const enabled = o.enabled !== false;
  const base = { ...(o.base || {}) };
  function emit(level, event, data) {
    if (!enabled) return;
    const rec = { ts: new Date().toISOString(), level,
      request_id: (data && data.request_id) || base.request_id || null, event };
    for (const [k, v] of Object.entries(base)) if (k !== 'request_id') rec[k] = v;
    for (const [k, v] of Object.entries(data || {})) if (k !== 'request_id') rec[k] = v;
    try { sink(JSON.stringify(rec)); } catch { /* logging must never break extraction */ }
  }
  return {
    debug: (e, d) => emit('debug', e, d),
    info: (e, d) => emit('info', e, d),
    warn: (e, d) => emit('warn', e, d),
    error: (e, d) => emit('error', e, d),
    child: (extra) => makeLogger({ ...o, base: { ...base, ...extra } }),
  };
}

/**
 * Accept whatever the host injects. Our call shape is `log.info(event, data)`.
 * `console` is special-cased because it wants one printable argument.
 */
function normaliseLogger(log) {
  if (!log) return makeLogger({ enabled: false });
  if (log === console || log.__consoleStyle) {
    const wrap = (level) => (event, data) => {
      const fn = log[level] || log.log || (() => {});
      try { fn.call(log, JSON.stringify({ ts: new Date().toISOString(), level, event, ...(data || {}) })); }
      catch { /* ignore */ }
    };
    return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'),
      child: () => normaliseLogger(log) };
  }
  const call = (level) => (event, data) => {
    const fn = typeof log[level] === 'function' ? log[level] : log.log;
    if (typeof fn !== 'function') return;
    try { fn.call(log, event, data); } catch { /* ignore */ }
  };
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error'),
    child: typeof log.child === 'function' ? (x) => normaliseLogger(log.child(x)) : () => normaliseLogger(log) };
}

module.exports = { makeLogger, normaliseLogger };
