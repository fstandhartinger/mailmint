'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trackPipelines } = require('./pipeline-tracker');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const log = { withRequestId: (id, fn) => fn() };

function fixture(processMessage, options = {}) {
  const foreign = [];
  const original = (message) => foreign.push(message.id);
  const pipeline = { processMessage, processInBackground: original };
  const tracker = trackPipelines({ pipeline, log, owns: (message) => message.mailbox_id === 7, ...options });
  return { pipeline, tracker, original, foreign };
}

test('scheduling registers work before execution and excludes foreign mailboxes', async () => {
  let called = false;
  const f = fixture(async () => { called = true; });
  try {
    assert.equal(f.pipeline.processInBackground({ id: 'one', mailbox_id: 7 }), undefined);
    f.pipeline.processInBackground({ id: 'foreign', mailbox_id: 8 });
    assert.equal(called, false);
    await f.tracker.drain(['one']);
    assert.equal(called, true);
    assert.deepEqual(f.foreign, ['foreign']);
    await assert.rejects(f.tracker.drain(['missing']), /untracked accepted message: missing/);
  } finally { f.tracker.restore(); }
  assert.equal(f.pipeline.processInBackground, f.original);
});

test('a failed pipeline does not close resources before its delayed peer settles', async () => {
  const peer = deferred();
  const failure = new Error('fixture parse failed');
  const f = fixture(async (message) => {
    if (message.id === 'failed') return { error: failure };
    await peer.promise;
    return {};
  });
  let stopped = false;
  try {
    f.pipeline.processInBackground({ id: 'failed', mailbox_id: 7 });
    f.pipeline.processInBackground({ id: 'peer', mailbox_id: 7 });
    const result = f.tracker.finish({ acceptedIds: ['failed', 'peer'], stop: async () => { stopped = true; } }).catch((error) => error);
    await turn();
    await turn();
    assert.equal(stopped, false);
    peer.resolve();
    const error = await result;
    assert.equal(stopped, true);
    assert.equal(error.errors[0].errors[0].cause, failure);
    assert.equal(f.pipeline.processInBackground, f.original);
  } finally { peer.resolve(); f.tracker.restore(); }
});

test('real processMessage failure waits for delayed failure-event emission', async () => {
  const pipeline = require('../src/pipeline');
  const messages = require('../src/messages');
  const actualLog = require('../src/log').log;
  const parse = messages.parseStored;
  const emit = messages.emitEvent;
  const errorLog = actualLog.error;
  const original = pipeline.processInBackground;
  const event = deferred();
  const entered = deferred();
  let stopped = false;
  let emitted = false;
  const failure = new Error('synthetic failure');
  messages.parseStored = async () => { throw failure; };
  messages.emitEvent = async (client, fields) => {
    assert.equal(fields.type, 'message.failed');
    entered.resolve();
    await event.promise;
    emitted = true;
  };
  actualLog.error = () => {};
  const tracker = trackPipelines({ pipeline, log: actualLog, owns: (message) => message.mailbox_id === 7 });
  try {
    pipeline.processInBackground({ id: 'failure-event', mailbox_id: 7, account_id: 1 });
    const result = tracker.finish({ acceptedIds: ['failure-event'], stop: async () => { assert.equal(emitted, true); stopped = true; } }).catch((error) => error);
    await entered.promise;
    assert.equal(stopped, false);
    event.resolve();
    const error = await result;
    assert.equal(error.errors[0].errors[0].cause, failure);
    assert.equal(stopped, true);
    assert.equal(pipeline.processInBackground, original);
  } finally {
    event.resolve();
    tracker.restore();
    messages.parseStored = parse;
    messages.emitEvent = emit;
    actualLog.error = errorLog;
  }
});

test('timeout identifies unresolved work, runs cleanup and restores instrumentation', async () => {
  const gate = deferred();
  const f = fixture(() => gate.promise, { timeoutMs: 10 });
  let stopped = false;
  try {
    f.pipeline.processInBackground({ id: 'pending', mailbox_id: 7 });
    await assert.rejects(f.tracker.finish({ acceptedIds: ['pending'], stop: async () => { stopped = true; } }), (error) => {
      assert.match(error.errors[0].message, /unresolved IDs: pending/);
      return true;
    });
    assert.equal(stopped, true);
    assert.equal(f.pipeline.processInBackground, f.original);
  } finally { gate.resolve(); await turn(); f.tracker.restore(); }
});

test('rejected pipeline and cleanup errors both survive', async () => {
  const failure = new Error('pipeline rejection');
  const cleanup = new Error('cleanup rejection');
  const f = fixture(async () => { throw failure; });
  f.pipeline.processInBackground({ id: 'reject', mailbox_id: 7 });
  await assert.rejects(f.tracker.finish({ acceptedIds: ['reject'], stop: async () => { throw cleanup; } }), (error) => {
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].errors[0].cause, failure);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  assert.equal(f.pipeline.processInBackground, f.original);
});
