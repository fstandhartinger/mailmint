'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { config, retentionFor } = require('./config');
const { log } = require('./log');
const ids = require('./ids');
const { parseMessage, needsReview, meanConfidence, flagField } = require('./parser');
const { consumeQuota } = require('./auth');
const { addressFor } = require('./addresses');
const { notFound } = require('./errors');

/* ------------------------------------------------------------------ blobs */

/**
 * v1 keeps bytes in Postgres. Every blob carries its own expiry so the reaper is
 * a single indexed DELETE rather than a join across three tables, and so a
 * retention change applies to new mail without a backfill.
 *
 * Raw MIME lives longer than attachment bytes, and both depend on the plan. A
 * re-parse replays the ORIGINAL bytes, so how long raw survives is literally how
 * far back "re-parse my back catalogue" can reach; attachment blobs are the bulk
 * of the storage and are not needed for it, so they expire first.
 */
async function storeBlob(client, accountId, kind, buffer, contentType = 'application/octet-stream', plan = 'free') {
  const ref = ids.blobRef();
  await client.query(
    `INSERT INTO blobs (ref, account_id, kind, content_type, bytes, size, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)`,
    [ref, accountId, kind, contentType, buffer, buffer.length, String(retentionFor(plan, kind))],
  );
  return ref;
}

async function readBlob(ref) {
  if (!ref) return null;
  const { rows } = await query(`SELECT bytes, size, content_type FROM blobs WHERE ref = $1 AND expires_at > now()`, [ref]);
  return rows.length ? rows[0] : null;
}

/* ---------------------------------------------------------------- ingest */

/**
 * Persists a received message and NOTHING else. Deliberately small: this is the
 * synchronous half of /internal/deliver, and everything it does has to be
 * finished before the smtpd is told the mail is safe. Parsing, which can take
 * seconds and can fail, happens afterwards against the row this created.
 *
 * If the raw MIME is over the cap it is not stored, but the message row still
 * is: losing the bytes is recoverable, losing the fact that mail arrived is not.
 */
/**
 * §1c. Which authentication results are worth flagging, and which are not.
 *
 * `auth_fail:<mech>` means CHECKED AND FAILED. Three cases are deliberately not
 * that:
 *
 *  - **`dkim: "body_altered"`.** The signature is real and the key is right, but
 *    the body hash no longer matches because something changed the message after
 *    it was signed. Forwarding, mailing lists and corporate security gateways
 *    all do this routinely — and forwarding mail to us from Gmail is one of the
 *    two main ways people use this product. Treating our own happy path as
 *    suspicious would be a self-inflicted wound. It gets its own flag,
 *    `dkim_body_altered`, which says what happened without asserting anything
 *    went wrong, and it does not count towards needs_review.
 *  - **`spf: "none"`.** On the Cloudflare Email Routing path the worker never
 *    sees a client IP, so SPF cannot be evaluated at all. "Not checked" is not
 *    "checked and absent", and reporting it as a failure would be a false claim
 *    about what we know.
 *  - **`temperror` / `permerror`.** A DNS timeout or a broken record on the
 *    sender's side is an infrastructure problem, not evidence of forgery.
 */
const AUTH_MECHANISMS = ['spf', 'dkim', 'dmarc'];
const NOT_A_FAILURE = new Set(['pass', 'none', 'neutral', 'temperror', 'permerror', 'policy', null, undefined, '']);

function authFlags(envelope = {}) {
  const auth = envelope.auth && typeof envelope.auth === 'object' ? envelope.auth : envelope;
  const out = [];
  for (const mech of AUTH_MECHANISMS) {
    const v = auth[mech];
    if (mech === 'dkim' && v === 'body_altered') { out.push('dkim_body_altered'); continue; }
    if (NOT_A_FAILURE.has(v)) continue;
    out.push(`auth_fail:${mech}`);
  }
  return out;
}

/**
 * Pulls the sender's own Message-ID out of the head of the raw message.
 *
 * Only the head is scanned, and only the first 16 KB of it: this runs on the
 * synchronous half of every inbound delivery, where the SMTP session is waiting.
 * A full MIME parse here would put an LLM-shaped amount of work in front of a
 * socket that has to be released in milliseconds.
 */
function sniffMessageId(raw) {
  if (!raw || !raw.length) return null;
  const head = raw.subarray(0, Math.min(raw.length, 16384)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const headers = end < 0 ? head : head.slice(0, end);
  const m = /^message-id:[ \t]*(.+)$/im.exec(headers.replace(/\r?\n[ \t]+/g, ' '));
  if (!m) return null;
  const value = m[1].trim().replace(/^<|>$/g, '').trim();
  return value ? value.slice(0, 255) : null;
}

/**
 * Has this exact message already been accepted into this mailbox?
 *
 * Both inbound paths are at-least-once. An SMTP sender whose 250 is lost sends
 * the message again; the IMAP connector advances its high-water mark only after
 * a 2xx, so an interruption between "delivered" and "persisted" re-delivers.
 * Neither side can fix that on its own, and the receiver is the only place that
 * can — so it is fixed here, once, for every path.
 */
async function findDuplicate(mailboxId, sourceMessageId) {
  if (!sourceMessageId) return null;
  const { rows } = await query(
    `SELECT id, status FROM messages WHERE mailbox_id = $1 AND source_message_id = $2`,
    [mailboxId, sourceMessageId],
  );
  return rows[0] || null;
}

async function ingest({ mailbox, envelope = {}, raw, receivedAt, idempotencyKey, plan }) {
  const messageId = ids.messageId();
  // The caller's explicit key wins; otherwise the message's own Message-ID.
  const sourceMessageId = (idempotencyKey ? String(idempotencyKey).trim().slice(0, 255) : null)
    || sniffMessageId(raw);
  const size = raw ? raw.length : 0;
  const oversize = size > config.maxRawBytes;
  const flags = [];
  if (oversize) flags.push('attachment_too_large', 'truncated_body');
  const spamScore = envelope.spam_score === undefined || envelope.spam_score === null
    ? null : Number(envelope.spam_score);
  if (spamScore !== null && spamScore >= 5) flags.push('spam_suspected');
  flags.push(...authFlags(envelope));

  // The plan decides how long the bytes live. The caller usually already knows
  // it — /internal/resolve reads it when it resolves the mailbox — and asking
  // again would be a round trip on the path an SMTP session is waiting on.
  let effectivePlan = plan;
  if (!effectivePlan) {
    const { rows } = await query(`SELECT plan FROM accounts WHERE id = $1`, [mailbox.account_id]);
    effectivePlan = (rows[0] && rows[0].plan) || 'free';
  }

  /**
   * Blob and message in ONE statement, not a transaction.
   *
   * This runs while an SMTP session — or the IMAP connector — is blocked on the
   * response, and the database is a managed Postgres that may be on another
   * continent. Written the obvious way this was BEGIN, INSERT, INSERT, COMMIT:
   * four round trips plus a plan lookup, measured at a 1.2 s p50 from Europe to
   * a us-west-2 branch. As a single data-modifying CTE it is one round trip and
   * still atomic, because a statement is its own transaction.
   *
   * The blob's INSERT ... SELECT ... WHERE is how "store the bytes only if there
   * are bytes to store" is expressed without a second statement.
   */
  const { rows } = await query(
    `WITH new_blob AS (
       INSERT INTO blobs (ref, account_id, kind, content_type, bytes, size, expires_at)
       SELECT $1, $2, 'raw', 'message/rfc822', $3::bytea, octet_length($3::bytea),
              now() + ($4 || ' days')::interval
        WHERE $3::bytea IS NOT NULL
       RETURNING ref
     )
     INSERT INTO messages (id, mailbox_id, account_id, received_at, from_email, subject, size,
                           status, flags, raw_ref, spam_score, envelope, source_message_id, auth_details)
     VALUES ($5, $6, $7, COALESCE($8::timestamptz, now()), $9, NULL, $10,
             'received', $11, (SELECT ref FROM new_blob), $12, $13, $14, $15)
     -- The unique index is the real guard: two deliveries of the same message can
     -- race, and only the database can decide which one wins.
     ON CONFLICT (mailbox_id, source_message_id) WHERE source_message_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [ids.blobRef(), mailbox.account_id, raw && !oversize ? raw : null, String(retentionFor(effectivePlan, 'raw')),
      messageId, mailbox.id, mailbox.account_id, receivedAt || null,
      (envelope.from || '').slice(0, 320) || null, size, flags, spamScore,
      JSON.stringify(envelope), sourceMessageId,
      envelope.auth_details ? JSON.stringify(envelope.auth_details) : null],
  );

  if (!rows.length) {
    const existing = await findDuplicate(mailbox.id, sourceMessageId);
    // The CTE's blob was written even though the message was not — a data
    // modifying CTE runs whatever the main statement decides. It carries an
    // expiry so the reaper would get it eventually, but a duplicate should not
    // cost thirty days of storage.
    await query(
      `DELETE FROM blobs WHERE kind = 'raw' AND account_id = $1
        AND ref NOT IN (SELECT raw_ref FROM messages WHERE account_id = $1 AND raw_ref IS NOT NULL)
        AND created_at > now() - interval '1 minute'`,
      [mailbox.account_id],
    ).catch(() => {});
    log.info('mail.duplicate', {
      message_id: existing && existing.id, mailbox_id: mailbox.id,
      source_message_id: sourceMessageId, note: 'already accepted; not stored again',
    });
    return { ...(existing || {}), duplicate: true };
  }

  const row = rows[0];
  log.info('mail.received', {
    message_id: messageId, mailbox_id: mailbox.id, account_id: Number(mailbox.account_id),
    from: envelope.from || null, size, raw_stored: !oversize, spam_score: spamScore,
    source: envelope.source || 'smtp', source_message_id: sourceMessageId,
    // Visible on purpose. A message with neither an explicit idempotency key nor
    // a Message-ID header cannot be deduplicated, so a retry of it WILL produce
    // a second row. Rare — RFC 5322 says every message should carry one — but
    // when it bites, this line is how anyone finds out why.
    deduplicable: Boolean(sourceMessageId),
  });
  if (!sourceMessageId) {
    log.warn('mail.not_deduplicable', {
      message_id: messageId, mailbox_id: mailbox.id,
      note: 'no Message-ID header and no idempotency_key; a redelivery of this message would be stored twice',
    });
  }
  return row;
}

/* ----------------------------------------------------------------- parse */

/**
 * Runs the parser against a stored message and writes the result back.
 *
 * Quota is checked HERE, not at ingest: an account over its allowance still
 * gets its mail stored, indexed and delivered — it just does not get the LLM
 * pass. Bouncing a customer's mail because their invoice ran out is a way to
 * lose the customer and their sender's trust at the same time.
 */
async function parseStored(message, opts = {}) {
  const requestId = opts.requestId || ids.requestId();
  const started = Date.now();

  const { rows: mbRows } = await query(`SELECT * FROM mailboxes WHERE id = $1`, [message.mailbox_id]);
  const mailbox = mbRows[0];
  if (!mailbox) throw new Error(`mailbox ${message.mailbox_id} vanished under message ${message.id}`);

  let schema = mailbox.schema || [];
  let schemaVersion = mailbox.schema_version;
  if (opts.schema) {
    schema = opts.schema;
    schemaVersion = opts.schemaVersion ?? null;
  } else if (opts.schemaVersion) {
    const { rows } = await query(
      `SELECT schema, version FROM mailbox_schema_versions WHERE mailbox_id = $1 AND version = $2`,
      [mailbox.id, opts.schemaVersion],
    );
    if (!rows.length) {
      throw notFound('schema_version_not_found', `Mailbox ${mailbox.id} has no schema version ${opts.schemaVersion}.`, {
        hint: 'Versions start at 1 and increase every time the schema is changed.',
      });
    }
    schema = rows[0].schema;
    schemaVersion = rows[0].version;
  }

  const blob = await readBlob(message.raw_ref);
  const input = blob ? blob.bytes : { subject: message.subject, text: null, html: null };

  // The quota decision: over the line means no LLM, never a bounce.
  let billed = false;
  let quotaExceeded = false;
  if (opts.bill !== false) {
    const q = await consumeQuota(message.account_id, 1);
    billed = q.ok;
    quotaExceeded = !q.ok;
    if (!q.ok) {
      log.warn('quota.exceeded', {
        account_id: Number(message.account_id), message_id: message.id,
        used: q.used, limit: q.limit, plan: q.plan,
        note: 'message stored and delivered without an LLM pass',
      });
    }
  }

  log.info('parse.start', {
    message_id: message.id, mailbox_id: mailbox.id, account_id: Number(message.account_id),
    schema_version: schemaVersion, schema_fields: (schema || []).length,
    bytes: blob ? blob.size : 0, llm_allowed: !quotaExceeded,
  });

  let result;
  try {
    result = await parseMessage(input, {
      schema,
      schemaVersion,
      requestId,
      log,
      // The parser is told not to spend an LLM call, rather than being given one
      // and having the result thrown away. The deterministic layer still runs —
      // an over-quota customer keeps their rule hits and their detected values.
      llm: !quotaExceeded,
      // The authoritative verdict, so the parser does not re-read the
      // Authentication-Results header this pipeline stamped itself. It lives on
      // the stored row, which is what parseStored has.
      auth: (message.envelope && message.envelope.auth) || undefined,
    });
  } catch (e) {
    if (billed) await require('./auth').refundQuota(message.account_id, 1);
    const sha = blob ? crypto.createHash('sha256').update(blob.bytes).digest('hex') : null;
    await storeFailure(message.id, blob ? blob.bytes : null, e);
    log.error('parse.failed', {
      message_id: message.id, account_id: Number(message.account_id),
      error: String(e.message || e), input_sha256: sha, stored: 'ops/failures/',
    });
    await query(
      `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
      [message.id, JSON.stringify({ code: 'parse_failed', message: String(e.message || e).slice(0, 500) })],
    );
    throw e;
  }

  const flags = [...new Set([...(message.flags || []), ...(result.flags || [])])];
  if (quotaExceeded) flags.push('quota_exceeded');
  if (!schema || !schema.length) { if (!flags.includes('no_schema')) flags.push('no_schema'); }
  result.flags = [...new Set(flags)];
  result.parse = result.parse || {};
  result.parse.request_id = requestId;
  result.parse.schema_version = schemaVersion;

  const persistStart = Date.now();
  const stored = await persistResult(message, mailbox, result);
  result.parse.timings_ms.persist = Date.now() - persistStart;

  const mean = meanConfidence(result.fields);
  log.info('parse.done', {
    message_id: message.id, mailbox_id: mailbox.id, account_id: Number(message.account_id),
    schema_version: schemaVersion,
    model: result.parse.model || null,
    llm_used: Boolean(result.parse.llm_used),
    timings_ms: { ...result.parse.timings_ms, wall: Date.now() - started },
    field_count: Object.keys(result.fields || {}).length,
    mean_confidence: mean,
    flags: result.flags,
    needs_review: needsReview(result.flags),
    detected_type: (result.detected || {}).type || null,
    attachments: (result.attachments || []).length,
    billed,
  });

  await query(
    `INSERT INTO usage_events (account_id, mailbox_id, message_id, kind, billable, llm_used, model, duration_ms, ok, origin)
     VALUES ($1,$2,$3,'message',$4,$5,$6,$7,true,$8)`,
    [message.account_id, mailbox.id, message.id, billed, Boolean(result.parse.llm_used),
      result.parse.model || null, Date.now() - started, config.origin],
  ).catch(() => {});

  return { message: stored, mailbox, result, requestId };
}

/**
 * Writes the parse back: attachment rows and their bytes, the §1 object, the
 * derived flags, and the event that a poller will see. One transaction, because
 * an event whose message is not yet visible is a message the n8n trigger skips
 * forever.
 */
async function persistResult(message, mailbox, result) {
  const attachments = result.attachments || [];
  const { rows: planRows } = await query(`SELECT plan FROM accounts WHERE id = $1`, [message.account_id]);
  const plan = (planRows[0] && planRows[0].plan) || 'free';
  return tx(async (client) => {
    await client.query(`DELETE FROM attachments WHERE message_id = $1`, [message.id]);
    const rendered = [];
    for (const att of attachments) {
      const bytes = att.bytes && Buffer.isBuffer(att.bytes) ? att.bytes
        : (att.content_base64 ? Buffer.from(att.content_base64, 'base64') : null);
      // Parser ids are content-derived. The same logo or invoice can therefore
      // have the same parser id in several messages, while attachments.id is a
      // global primary key. Mint the storage id here so repeated bytes never
      // make an otherwise valid message fail with attachments_pkey.
      const id = ids.attachmentId();
      let storageRef = null;
      if (bytes && bytes.length <= config.maxAttachmentBytes) {
        storageRef = await storeBlob(client, message.account_id, 'attachment', bytes, att.content_type || 'application/octet-stream', plan);
      } else if (bytes) {
        result.flags = [...new Set([...(result.flags || []), 'attachment_too_large'])];
      }
      const size = att.size || (bytes ? bytes.length : 0);
      const sha = att.sha256 || (bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null);
      // §1b(2): whatever packages/docs lifted out of the file. Stored on the
      // attachment row, not inside messages.result, because a 40-page invoice's
      // text would otherwise be read on every list call that touches the message.
      const extracted = att.extracted && typeof att.extracted === 'object' ? att.extracted : null;
      await client.query(
        `INSERT INTO attachments (id, message_id, filename, content_type, size, sha256, storage_ref, inline, content_id, extracted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, message.id, att.filename || null, att.content_type || null, size, sha, storageRef,
          Boolean(att.inline), att.content_id || null, extracted ? JSON.stringify(extracted) : null],
      );
      rendered.push({
        id, filename: att.filename || null, content_type: att.content_type || null,
        size, sha256: sha, inline: Boolean(att.inline), content_id: att.content_id || null,
        ...(extracted ? { extracted } : {}),
      });
    }
    // Bytes never go into the JSONB column: the row is read on every list call.
    result.attachments = rendered;

    // The receiving edge — the smtpd, or the Cloudflare worker — is the only thing
    // that can actually evaluate SPF/DKIM/DMARC; the parser can only read what the
    // headers claim. Merge the edge's verdict in ONCE, here, so the stored result
    // is the single source of truth and the API, the webhook body and the
    // dashboard cannot end up saying different things about the same message.
    const edgeAuth = (message.envelope && message.envelope.auth) || null;
    if (edgeAuth) result.auth = { ...(result.auth || {}), ...edgeAuth };
    if (result.auth && (result.auth.spam_score === null || result.auth.spam_score === undefined)
        && message.spam_score !== null && message.spam_score !== undefined) {
      result.auth.spam_score = message.spam_score;
    }
    const review = needsReview(result.flags);
    const { rows } = await client.query(
      `UPDATE messages SET status = 'parsed', result = $2, flags = $3, needs_review = $4,
              subject = $5, from_email = COALESCE($6, from_email), schema_version = $7,
              spam_score = COALESCE($8, spam_score), error = NULL
       WHERE id = $1 RETURNING *`,
      [message.id, JSON.stringify(result), result.flags, review,
        (result.headers && result.headers.subject) || null,
        (result.headers && result.headers.from && result.headers.from.email) || null,
        result.parse.schema_version,
        (result.auth && typeof result.auth.spam_score === 'number') ? result.auth.spam_score : null],
    );
    return rows[0];
  });
}

/** §6: a failed parse keeps its input so it can be replayed. Never exposed by the API. */
async function storeFailure(messageId, bytes, error) {
  if (!bytes) return;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', '..', 'ops', 'failures');
    fs.mkdirSync(dir, { recursive: true });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(dir, `${messageId}.${sha}.eml`), bytes);
    fs.writeFileSync(path.join(dir, `${messageId}.${sha}.json`), JSON.stringify({
      message_id: messageId, error: String(error && error.message || error), at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    log.warn('parse.failed.store', { message_id: messageId, error: e.message });
  }
}

/* ---------------------------------------------------------------- events */

async function emitEvent(client, { accountId, mailboxId, type, messageId }) {
  const q = client || { query: (t, p) => query(t, p) };
  const { rows } = await q.query(
    `INSERT INTO events (account_id, mailbox_id, type, message_id) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [accountId, mailboxId, type, messageId],
  );
  log.info('event.emitted', { event_id: Number(rows[0].id), type, message_id: messageId, account_id: Number(accountId) });
  return rows[0];
}

/* -------------------------------------------------------------- rendering */

/**
 * The §1 object as the API serves it.
 *
 * URLs are built at read time from the host that asked, not stored, so the same
 * row serves a request to localhost during development and to the production
 * host afterwards without a rewrite.
 */
function renderResult(row, mailbox, opts = {}) {
  const { base, include = new Set(), exclude = new Set(), attachmentBytes = null } = opts;
  const result = row.result ? { ...row.result } : {};
  const root = (base || config.publicUrl || '').replace(/\/$/, '');
  result.id = row.id;
  result.mailbox = {
    id: mailbox ? mailbox.id : row.mailbox_id,
    address: mailbox ? addressFor(mailbox, config.inboundDomain) : null,
    name: mailbox ? mailbox.name : null,
  };
  result.received_at = new Date(row.received_at).toISOString();
  result.envelope = row.envelope && Object.keys(row.envelope).length ? row.envelope : (result.envelope || {});
  // Authentication is decided at the edge, by whatever accepted the connection —
  // the smtpd, or the Cloudflare worker. The parser can only guess from headers,
  // so the envelope's verdict wins where it has one.
  const edgeAuth = (row.envelope && row.envelope.auth) || null;
  if (edgeAuth) result.auth = { ...(result.auth || {}), ...edgeAuth };
  if (result.auth && row.spam_score !== null && row.spam_score !== undefined
      && (result.auth.spam_score === null || result.auth.spam_score === undefined)) {
    result.auth.spam_score = row.spam_score;
  }
  result.auth_details = row.auth_details || (row.envelope && row.envelope.auth_details) || null;
  result.flags = row.flags || result.flags || [];
  result.needs_review = row.needs_review;
  result.status = row.status;
  result.attachments = (result.attachments || []).map((a) => shapeAttachment(a, {
    root, include, exclude, bytes: attachmentBytes && attachmentBytes[a.id],
  }));
  result.raw_url = row.raw_ref ? `${root}/v1/messages/${row.id}/raw` : null;
  return result;
}

/**
 * Decides how much of an attachment travels in the body.
 *
 * `extracted.text` from a scanned 40-page invoice is megabytes. Sending it by
 * default would make every poll of the event feed expensive for the one user in
 * fifty who needs it, and dropping it by default would hide the feature from
 * everyone else. So the shape is always there — kind, pages, tables, meta and a
 * preview — and the full text is one query parameter away.
 */
function shapeAttachment(a, { root, include, exclude, bytes }) {
  const out = {
    ...a,
    url: `${root}/v1/attachments/${a.id}`,
    ...(include.has('attachments') && bytes ? { content_base64: bytes.toString('base64') } : {}),
  };
  if (!out.extracted || exclude.has('extracted')) {
    delete out.extracted;
    return out;
  }
  if (!include.has('extracted_text') && typeof out.extracted.text === 'string'
      && out.extracted.text.length > config.extractedTextPreview) {
    out.extracted = {
      ...out.extracted,
      text: out.extracted.text.slice(0, config.extractedTextPreview),
      text_length: out.extracted.text.length,
      text_truncated: true,
    };
  }
  return out;
}

/** The compact form used by GET /v1/messages, which must stay cheap to page. */
const renderSummary = (row) => ({
  id: row.id,
  mailbox_id: row.mailbox_id,
  received_at: new Date(row.received_at).toISOString(),
  from: row.from_email,
  subject: row.subject,
  size: row.size,
  status: row.status,
  needs_review: row.needs_review,
  flags: row.flags || [],
  spam_score: row.spam_score,
  fields: row.result && row.result.fields ? row.result.fields : {},
  attachments: (row.result && row.result.attachments ? row.result.attachments : []).map((a) => ({
    id: a.id, filename: a.filename, content_type: a.content_type, size: a.size,
    // Enough to tell whether the data someone wants is in the file, without
    // carrying the file's text through a list call.
    extracted: a.extracted ? { kind: a.extracted.kind, pages: a.extracted.pages || null,
      tables: Array.isArray(a.extracted.tables) ? a.extracted.tables.length : 0,
      text_length: typeof a.extracted.text === 'string' ? a.extracted.text.length : 0 } : null,
  })),
});

/**
 * The review queue's row: what is wrong, in which field, and the evidence the
 * value came from. Everything a person needs to decide "accept or fix" without
 * opening the message.
 */
function renderReviewRow(row) {
  const fields = (row.result && row.result.fields) || {};
  const issues = (row.flags || []).map((flag) => {
    const field = flagField(flag);
    const f = field ? fields[field] : null;
    return {
      flag,
      field,
      value: f ? f.value : undefined,
      confidence: f ? f.confidence : undefined,
      source: f ? f.source : undefined,
      evidence: f ? f.evidence : null,
    };
  }).filter((i) => needsReview([i.flag]));
  return { ...renderSummary(row), issues };
}

module.exports = {
  storeBlob, readBlob, ingest, parseStored, persistResult, emitEvent,
  renderResult, renderSummary, renderReviewRow, findDuplicate, sniffMessageId, authFlags,
};
