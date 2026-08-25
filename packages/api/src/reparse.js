'use strict';

const { query, tx } = require('./db');
const { log } = require('./log');
const ids = require('./ids');
const { ApiError, bad, notFound } = require('./errors');
const { validateSchema } = require('./schema');
const messages = require('./messages');
const pipeline = require('./pipeline');
const webhooks = require('./webhooks');

/**
 * Bulk re-parse: run the parser again over stored messages, from the ORIGINAL
 * raw bytes.
 *
 * This is the thing the category cannot do. Zapier's own staff answer is "there
 * is no way to replay them"; Mailparser can re-dispatch the last 300, manually.
 * The fear underneath every one of those threads is the same: a sender changes
 * their layout and the automation silently breaks, and by the time anyone
 * notices, the mail that broke it is gone.
 *
 * Two design decisions carry the whole feature:
 *
 *  - **`redeliver` defaults to false.** Re-parsing five thousand messages must
 *    not fire five thousand webhooks at someone's production endpoint. Fixing
 *    your own data and re-notifying your downstream are different decisions and
 *    are made separately.
 *  - **`dry_run` shows the diff without writing.** Tuning a schema against real
 *    historical mail is the actual job. Doing it destructively, on data you
 *    cannot get back, is not a feature anyone can use.
 */
const MAX_LIMIT = 5000;
const MAX_DIFFS = 200;

async function create(account, mailbox, body = {}) {
  const params = {
    since: body.since ? new Date(body.since) : null,
    until: body.until ? new Date(body.until) : null,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || 500)),
    status: body.status || null,
    needs_review: body.needs_review === true || body.needs_review === 'true',
    flag: body.flag ? String(body.flag) : null,
  };
  for (const k of ['since', 'until']) {
    if (params[k] && Number.isNaN(params[k].getTime())) {
      throw bad('invalid_date', `"${body[k]}" is not a date.`, { hint: 'Use ISO-8601, e.g. 2026-08-01T00:00:00Z.' });
    }
    params[k] = params[k] ? params[k].toISOString() : null;
  }
  if (body.schema !== undefined) params.schema = validateSchema(body.schema);
  if (body.schema_version !== undefined) params.schema_version = Number(body.schema_version);

  const { rows: counted } = await query(selectSql(params, true), selectParams(mailbox.id, params));
  const total = counted[0].n;

  const id = `rpj_${ids.ulid()}`;
  await query(
    `INSERT INTO reparse_jobs (id, account_id, mailbox_id, dry_run, redeliver, params, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, account.id, mailbox.id, Boolean(body.dry_run), Boolean(body.redeliver), JSON.stringify(params), total],
  );
  log.info('reparse.queued', {
    job_id: id, mailbox_id: mailbox.id, account_id: Number(account.id),
    total, dry_run: Boolean(body.dry_run), redeliver: Boolean(body.redeliver),
  });
  return get(account.id, id);
}

function selectSql(params, count = false) {
  const where = ['mailbox_id = $1'];
  let n = 1;
  if (params.since) { n += 1; where.push(`received_at >= $${n}`); }
  if (params.until) { n += 1; where.push(`received_at <= $${n}`); }
  if (params.status) { n += 1; where.push(`status = $${n}`); }
  if (params.needs_review) where.push('needs_review');
  if (params.flag) { n += 1; where.push(`flags @> ARRAY[$${n}]::text[]`); }
  const sql = count
    ? `SELECT LEAST(count(*), ${params.limit})::int AS n FROM messages WHERE ${where.join(' AND ')}`
    : `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY received_at DESC LIMIT ${params.limit}`;
  return sql;
}

function selectParams(mailboxId, params) {
  const out = [mailboxId];
  if (params.since) out.push(params.since);
  if (params.until) out.push(params.until);
  if (params.status) out.push(params.status);
  if (params.flag) out.push(params.flag);
  return out;
}

async function get(accountId, id) {
  const { rows } = await query(`SELECT * FROM reparse_jobs WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!rows.length) {
    throw notFound('reparse_job_not_found', `There is no re-parse job "${id}" on this account.`, {
      hint: 'Job ids look like rpj_… and are returned by POST /v1/mailboxes/:id/reparse.',
      docs: '/docs#reparse',
    });
  }
  const j = rows[0];
  return {
    job_id: j.id,
    mailbox_id: j.mailbox_id,
    status: j.status,
    dry_run: j.dry_run,
    redeliver: j.redeliver,
    total: j.total,
    done: j.done,
    changed: j.changed,
    failed: j.failed,
    params: j.params,
    // A dry run's whole output is this list, so it is returned in full up to the
    // cap. A real run returns it too, because "what did that change" is the
    // question immediately after "did it work".
    diffs: j.diffs || [],
    diffs_truncated: (j.diffs || []).length >= MAX_DIFFS,
    error: j.error,
    created_at: new Date(j.created_at).toISOString(),
    started_at: j.started_at ? new Date(j.started_at).toISOString() : null,
    finished_at: j.finished_at ? new Date(j.finished_at).toISOString() : null,
  };
}

const list = (accountId, mailboxId = null) => query(
  mailboxId
    ? `SELECT * FROM reparse_jobs WHERE account_id = $1 AND mailbox_id = $2 ORDER BY created_at DESC LIMIT 20`
    : `SELECT * FROM reparse_jobs WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`,
  mailboxId ? [accountId, mailboxId] : [accountId],
).then((r) => r.rows);

/**
 * Field-by-field diff of one message's old and new result.
 *
 * Confidence is compared as well as value: a field whose value did not move but
 * whose confidence fell from 0.97 to 0.5 is exactly the case someone tuning a
 * schema needs to see, and it is invisible if you only diff values.
 */
function diffFields(before, after) {
  const oldFields = (before && before.fields) || {};
  const newFields = (after && after.fields) || {};
  const names = [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])];
  const changes = [];
  for (const name of names) {
    const a = oldFields[name] || {};
    const b = newFields[name] || {};
    const sameValue = JSON.stringify(a.value === undefined ? null : a.value)
      === JSON.stringify(b.value === undefined ? null : b.value);
    const sameConfidence = Math.abs((a.confidence || 0) - (b.confidence || 0)) < 0.005;
    if (sameValue && sameConfidence && (a.source || null) === (b.source || null)) continue;
    changes.push({
      field: name,
      before: { value: a.value === undefined ? null : a.value, confidence: a.confidence ?? null, source: a.source || null },
      after: { value: b.value === undefined ? null : b.value, confidence: b.confidence ?? null, source: b.source || null },
    });
  }
  const oldFlags = (before && before.flags) || [];
  const newFlags = (after && after.flags) || [];
  return {
    fields: changes,
    flags_added: newFlags.filter((f) => !oldFlags.includes(f)),
    flags_removed: oldFlags.filter((f) => !newFlags.includes(f)),
  };
}

/** Claims one queued job. SKIP LOCKED so two workers never take the same row. */
function claim() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM reparse_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) return null;
    await client.query(`UPDATE reparse_jobs SET status = 'running', started_at = now() WHERE id = $1`, [rows[0].id]);
    return rows[0];
  });
}

async function runJob(job) {
  const params = job.params || {};
  const { rows } = await query(selectSql(params), selectParams(job.mailbox_id, params));
  let done = 0;
  let changed = 0;
  let failed = 0;
  const diffs = [];

  for (const message of rows) {
    const before = message.result;
    const opts = {
      requestId: `req_${job.id}`,
      eventType: 'message.reparsed',
      // Re-notifying downstream is a separate decision from fixing our own data.
      deliver: false,
      // A re-parse of mail that was already paid for is not a second sale.
      bill: false,
    };
    if (params.schema) opts.schema = params.schema;
    else if (params.schema_version) opts.schemaVersion = params.schema_version;

    if (job.dry_run) {
      // Nothing is written, so this cannot be processMessage(): parse in
      // isolation and throw the result away after diffing it.
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await dryParse(message, opts);
        const diff = diffFields(before, out);
        if (diff.fields.length || diff.flags_added.length || diff.flags_removed.length) {
          changed += 1;
          if (diffs.length < MAX_DIFFS) diffs.push({ message_id: message.id, subject: message.subject, ...diff });
        }
      } catch (e) {
        failed += 1;
        log.warn('reparse.item_failed', { job_id: job.id, message_id: message.id, error: String(e.message || e) });
      }
    } else {
      // eslint-disable-next-line no-await-in-loop
      const out = await pipeline.processMessage(message, opts);
      if (out.error) {
        failed += 1;
      } else {
        const diff = diffFields(before, out.result);
        if (diff.fields.length || diff.flags_added.length || diff.flags_removed.length) {
          changed += 1;
          if (diffs.length < MAX_DIFFS) diffs.push({ message_id: message.id, subject: message.subject, ...diff });
        }
        if (job.redeliver && !out.mailbox.paused) {
          // eslint-disable-next-line no-await-in-loop
          await webhooks.enqueueForMailbox({
            messageId: message.id, accountId: job.account_id, mailboxId: message.mailbox_id,
          });
        }
      }
    }
    done += 1;
    if (done % 25 === 0) {
      // eslint-disable-next-line no-await-in-loop
      await query(`UPDATE reparse_jobs SET done = $2, changed = $3, failed = $4 WHERE id = $1`,
        [job.id, done, changed, failed]).catch(() => {});
    }
  }

  await query(
    `UPDATE reparse_jobs SET status = 'succeeded', done = $2, changed = $3, failed = $4,
            diffs = $5, finished_at = now() WHERE id = $1`,
    [job.id, done, changed, failed, JSON.stringify(diffs)],
  );
  log.info('reparse.done', {
    job_id: job.id, mailbox_id: job.mailbox_id, account_id: Number(job.account_id),
    total: job.total, done, changed, failed, dry_run: job.dry_run, redeliver: job.redeliver,
  });
}

/** Parses a stored message without persisting anything. Used only by dry runs. */
async function dryParse(message, opts) {
  const { rows } = await query(`SELECT * FROM mailboxes WHERE id = $1`, [message.mailbox_id]);
  const mailbox = rows[0];
  if (!mailbox) throw new Error('mailbox no longer exists');
  const blob = await messages.readBlob(message.raw_ref);
  if (!blob) {
    throw new ApiError(410, 'raw_unavailable', 'The original bytes for this message are no longer stored.');
  }
  let schema = mailbox.schema || [];
  let schemaVersion = mailbox.schema_version;
  if (opts.schema) { schema = opts.schema; schemaVersion = null; } else if (opts.schemaVersion) {
    const v = await query(`SELECT schema, version FROM mailbox_schema_versions WHERE mailbox_id = $1 AND version = $2`,
      [mailbox.id, opts.schemaVersion]);
    if (!v.rows.length) throw new Error(`no schema version ${opts.schemaVersion}`);
    schema = v.rows[0].schema; schemaVersion = v.rows[0].version;
  }
  const { parseMessage } = require('./parser');
  return parseMessage(blob.bytes, { schema, schemaVersion, requestId: opts.requestId, log });
}

/** Background worker. Same shape as the webhook worker: one tick, one job. */
function startWorker() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let job = null;
    try {
      job = await claim();
      if (job) await runJob(job);
    } catch (e) {
      log.error('reparse.failed', { job_id: job && job.id, error: String(e.message || e) });
      if (job) {
        await query(`UPDATE reparse_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
          [job.id, String(e.message || e).slice(0, 500)]).catch(() => {});
      }
    } finally {
      if (!stopped) setTimeout(tick, job ? 100 : 2000).unref();
    }
  };
  setTimeout(tick, 1000).unref();

  // A job left 'running' by a process that died is requeued once. Without this
  // the only recovery is an operator editing the table by hand.
  query(`UPDATE reparse_jobs SET status = 'queued', started_at = NULL
          WHERE status = 'running' AND started_at < now() - interval '30 minutes'`).catch(() => {});

  return () => { stopped = true; };
}

module.exports = { create, get, list, claim, runJob, startWorker, diffFields, MAX_LIMIT, MAX_DIFFS };
