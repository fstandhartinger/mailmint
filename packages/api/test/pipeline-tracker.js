'use strict';

function trackPipelines({ pipeline, log, owns, timeoutMs = 15000 }) {
  const original = pipeline.processInBackground;
  const jobs = new Map();
  let restored = false;

  pipeline.processInBackground = function tracked(message, opts = {}) {
    if (!owns(message)) return original.call(this, message, opts);
    const id = String(message.id);
    const job = { settled: false, error: null, promise: null };
    jobs.set(id, job);
    job.promise = new Promise((resolve) => {
      setImmediate(() => {
        Promise.resolve().then(() => log.withRequestId(opts.requestId || null,
          () => pipeline.processMessage(message, opts)))
          .then((out) => { if (out && out.error) job.error = out.error; },
            (error) => { job.error = error; })
          .finally(() => { job.settled = true; resolve(); });
      });
    });
    return undefined;
  };

  function restore() {
    if (!restored) {
      pipeline.processInBackground = original;
      restored = true;
    }
  }

  async function drain(acceptedIds = []) {
    const errors = [];
    for (const id of acceptedIds) {
      if (!jobs.has(String(id))) errors.push(new Error(`untracked accepted message: ${id}`));
    }
    let timer;
    try {
      await Promise.race([
        (async () => {
          while ([...jobs.values()].some((job) => !job.settled)) {
            await Promise.all([...jobs.values()].map((job) => job.promise));
          }
        })(),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const unresolved = [];
    for (const [id, job] of jobs) {
      if (!job.settled) unresolved.push(id);
      if (job.error) errors.push(new Error(`pipeline failed: ${id}`, { cause: job.error }));
    }
    if (unresolved.length) errors.push(new Error(`pipeline drain timed out; unresolved IDs: ${unresolved.join(', ')}`));
    if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
  }

  async function finish({ acceptedIds = [], stop }) {
    const errors = [];
    try {
      try { await drain(acceptedIds); } catch (error) { errors.push(error); }
      try { await stop(); } catch (error) { errors.push(error); }
    } finally {
      restore();
    }
    if (errors.length) throw new AggregateError(errors, 'pipeline fixture teardown failed');
  }

  return { drain, finish, restore };
}

module.exports = { trackPipelines };
