'use strict';

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration: without it every connector that lost the same
 * upstream reconnects in the same millisecond, and the upstream stays down.
 */
function delayFor(attempt, opts = {}) {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 5 * 60 * 1000;
  const exp = Math.min(max, base * (2 ** Math.max(0, attempt - 1)));
  const jitter = opts.jitter === false ? exp : Math.random() * exp;
  return Math.max(opts.minMs ?? 0, Math.round(jitter));
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    if (signal.aborted) { clearTimeout(t); resolve(); return; }
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }
});

/** Retries `fn` until it succeeds, gives up, or hits a permanent error. */
async function retry(fn, opts = {}) {
  const attempts = opts.attempts ?? 5;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err && err.permanent) throw err;
      if (attempt === attempts) break;
      const ms = delayFor(attempt, opts);
      if (opts.onRetry) opts.onRetry(err, attempt, ms);
      await sleep(ms, opts.signal);
      if (opts.signal && opts.signal.aborted) throw lastErr;
    }
  }
  throw lastErr;
}

module.exports = { delayFor, sleep, retry };
