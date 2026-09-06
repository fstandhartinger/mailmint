'use strict';

const { query, tx } = require('./db');
const { log } = require('./log');
const pipeline = require('./pipeline');

/**
 * Messages that were accepted and then never parsed.
 *
 * `/internal/deliver` is deliberately two halves: write the row and the raw
 * bytes, answer 200 so the SMTP session is freed, then parse in the background.
 * The first half is durable — "after this, nothing can lose the mail" — but the
 * second half belongs to a *process*, and processes die. A deploy, an OOM or a
 * SIGKILL between the two leaves the row at `status = 'received'` for ever:
 * never parsed, so no event, so no webhook, so the customer's trigger simply
 * never fires and nothing anywhere says why. The bytes were safe; the work was
 * not.
 *
 * This is the other half of that promise. Nothing else in the service re-drives
 * a parse: the webhook queue reclaims its own rows and a stale reparse job is
 * requeued on start-up, but a stranded message had neither.
 */

/**
 * How long a message may sit in `received` before it is assumed abandoned.
 *
 * It has to exceed the longest a legitimate parse can take, because a message
 * re-driven while it is still being parsed would be parsed twice — two events,
 * two webhook deliveries. The LLM chain in shared/llm.js is nine models with a
 * 90 s timeout each, so the honest worst case is about 13½ minutes. Fifteen
 * clears it. This only ever delays messages orphaned by a crash, so a long,
 * safe number costs nothing that anyone sees.
 */
const RESUME_AFTER_MS = Number(process.env.RESUME_AFTER_MS || 900000);

/**
 * And how long is too long to bring one back.
 *
 * Delivering a customer's mail late is right; delivering a fortnight-old message
 * to a live n8n workflow the first time this ships is not, and neither is
 * re-parsing a message whose raw bytes the reaper has already collected. Older
 * than this, a stranded message is left exactly as it is and counted in the log,
 * so somebody can decide about it rather than have it decided by a deploy.
 */
const RESUME_MAX_AGE_MS = Number(process.env.RESUME_MAX_AGE_MS || 172800000);   // 48 h

/** How often to look. Cheap: one indexed query against a partial index. */
const SWEEP_EVERY_MS = Number(process.env.RESUME_SWEEP_MS || 60000);

/** At most this many per sweep, so a large backlog drains steadily rather than at once. */
const BATCH = Number(process.env.RESUME_BATCH || 5);

/**
 * A message that kills the process gets re-driven, which kills the process
 * again: a crash loop that takes the whole service down with it. After this
 * many attempts the message is marked `failed` and said so, which is visible,
 * re-parsable by hand, and cannot loop.
 */
const MAX_ATTEMPTS = Number(process.env.RESUME_MAX_ATTEMPTS || 3);

/**
 * Claims one stranded message. The counter is incremented INSIDE the claiming
 * transaction, so two processes sweeping at once cannot both take the same row.
 */
function claim() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM messages
        WHERE status = 'received'
          AND received_at < now() - ($1 || ' milliseconds')::interval
          AND received_at > now() - ($2 || ' milliseconds')::interval
        ORDER BY received_at
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [String(RESUME_AFTER_MS), String(RESUME_MAX_AGE_MS)],
    );
    if (!rows.length) return null;
    const row = rows[0];
    const attempts = Number(row.parse_attempts || 0) + 1;
    await client.query(`UPDATE messages SET parse_attempts = $2 WHERE id = $1`, [row.id, attempts]);
    return { ...row, parse_attempts: attempts };
  });
}

/** Gives up on a message, loudly, rather than re-driving it for ever. */
async function abandon(message) {
  await query(
    `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1 AND status = 'received'`,
    [message.id, JSON.stringify({
      code: 'parse_abandoned',
      message: `This message was accepted but its parse did not complete after ${MAX_ATTEMPTS} attempts.`,
      hint: 'The original bytes are still stored: POST /v1/messages/:id/reparse to try again.',
    })],
  );
  log.error('resume.abandoned', {
    message_id: message.id, account_id: Number(message.account_id),
    attempts: message.parse_attempts,
    note: 'marked failed so it stops being retried; the raw bytes are kept and it is re-parsable',
  });
  await require('./messages').emitEvent(null, {
    accountId: message.account_id, mailboxId: message.mailbox_id,
    type: 'message.failed', messageId: message.id,
  }).catch(() => {});
}

/** One pass. Returns how many messages it re-drove. */
async function sweep() {
  let done = 0;
  for (let i = 0; i < BATCH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const message = await claim();
    if (!message) break;
    if (message.parse_attempts > MAX_ATTEMPTS) {
      // eslint-disable-next-line no-await-in-loop
      await abandon(message);
      continue;
    }
    log.warn('resume.stranded', {
      message_id: message.id, account_id: Number(message.account_id),
      mailbox_id: message.mailbox_id, attempt: message.parse_attempts,
      received_at: new Date(message.received_at).toISOString(),
      note: 'accepted but never parsed; re-driving the parse',
    });
    // Not billed. The customer was charged, or was about to be, on the attempt
    // that died, and they got nothing for it — charging a second time for our
    // own crash is not defensible. Erring in their favour is the right side to
    // err on, and the number of messages this can touch is bounded by the crash.
    // eslint-disable-next-line no-await-in-loop
    await pipeline.processMessage(message, { bill: false });
    done += 1;
  }
  if (done) log.info('resume.swept', { resumed: done });
  await reportTooOld();
  return done;
}

/**
 * Stranded mail past the age bound. Never touched, only counted — silence about
 * it would be the same mistake in a different place.
 */
async function reportTooOld() {
  const { rows } = await query(
    `SELECT count(*)::int AS n, min(received_at) AS oldest FROM messages
      WHERE status = 'received' AND received_at <= now() - ($1 || ' milliseconds')::interval`,
    [String(RESUME_MAX_AGE_MS)],
  ).catch(() => ({ rows: [] }));
  if (rows.length && rows[0].n) {
    log.warn('resume.too_old', {
      count: rows[0].n, oldest: new Date(rows[0].oldest).toISOString(),
      max_age_ms: RESUME_MAX_AGE_MS,
      note: 'accepted but never parsed, and now older than the resume window; left untouched',
    });
  }
}

/**
 * The background sweeper. Same shape and the same gate as the other two workers:
 * a process only runs one if it says it is a worker, so a laptop pointed at the
 * production database does not quietly start parsing production's mail.
 */
function startWorker() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await sweep(); } catch (e) { log.error('resume.sweep_failed', { error: String(e.message || e) }); }
    if (!stopped) setTimeout(tick, SWEEP_EVERY_MS).unref();
  };
  // Not immediately at boot: a rolling deploy can have the old process still
  // finishing a parse while the new one starts, and the grace period is what
  // makes that safe, not the delay — but there is no reason to race it either.
  setTimeout(tick, 5000).unref();
  return () => { stopped = true; };
}

module.exports = { sweep, claim, abandon, reportTooOld, startWorker, RESUME_AFTER_MS, RESUME_MAX_AGE_MS, MAX_ATTEMPTS };
