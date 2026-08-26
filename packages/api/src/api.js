'use strict';

const express = require('express');
const { query } = require('./db');
const { config, PLANS } = require('./config');
const { log } = require('./log');
const ids = require('./ids');
const { ApiError, bad, notFound } = require('./errors');
const { authenticate, requireQuota } = require('./auth');
const senderAuth = require('./sender-auth');
const { validateSchema } = require('./schema');
const mailboxes = require('./mailboxes');
const reparse = require('./reparse');
const endpoints = require('./webhook-endpoints');
const messages = require('./messages');
const pipeline = require('./pipeline');
const { parseMessage, needsReview, meanConfidence } = require('./parser');
const { rateLimit } = require('./ratelimit');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const authOnly = asyncRoute(async (req, res, next) => { req.account = await authenticate(req); next(); });
const withAuth = [authOnly, rateLimit];

/** The host the caller reached us on, so URLs in the body resolve for them. */
const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

/**
 * `?include=` adds the heavy things, `?exclude=` removes them.
 *
 * `attachments` inlines the file bytes as base64. `extracted_text` inlines the
 * FULL text lifted out of an attachment rather than the preview — a scanned
 * invoice's text is measured in megabytes, and paying for it on every poll to
 * serve the one caller in fifty who wants it is the wrong default.
 * `exclude=extracted` drops the extraction entirely.
 */
function includeSets(req) {
  const split = (v) => new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean));
  return { include: split(req.query.include), exclude: split(req.query.exclude) };
}

const MAX_LIMIT = 200;
function pageLimit(v, dflt = 25) {
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/* ------------------------------------------------------------- mailboxes */

router.post('/mailboxes', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.create(req.account.id, req.body || {});
  res.status(201).json({ mailbox: mailboxes.publicMailbox(mb, { includeSecret: true }) });
}));

router.get('/mailboxes', withAuth, asyncRoute(async (req, res) => {
  const rows = await mailboxes.list(req.account.id);
  res.json({ data: rows.map((m) => mailboxes.publicMailbox(m)), inbound_domain: config.inboundDomain });
}));

router.get('/mailboxes/:id', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  res.json({ mailbox: mailboxes.publicMailbox(mb, { includeSecret: true }) });
}));

router.patch('/mailboxes/:id', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.update(req.account.id, String(req.params.id), req.body || {});
  res.json({ mailbox: mailboxes.publicMailbox(mb, { includeSecret: true }) });
}));

router.delete('/mailboxes/:id', withAuth, asyncRoute(async (req, res) => {
  res.json(await mailboxes.remove(req.account.id, String(req.params.id)));
}));

/* --------------------------------------------------------- webhooks */

/**
 * A mailbox has many webhook endpoints.
 *
 * One `webhook_url` would make two n8n MailMintTrigger nodes on the same mailbox
 * silently clobber each other, and disabling one workflow would delete the
 * other's delivery. Each registration gets its own row and its own signing
 * secret, so they are independent. `mailbox.webhook_url` still works and is an
 * alias for the first endpoint.
 */
router.post('/mailboxes/:id/webhooks', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  const e = await endpoints.create(mb, req.body || {});
  // The secret is shown here and never again, like an API key.
  res.status(201).json({ webhook: endpoints.publicEndpoint(e, { includeSecret: true }) });
}));

router.get('/mailboxes/:id/webhooks', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  const rows = await endpoints.listFor(mb.id);
  res.json({ data: rows.map((e) => endpoints.publicEndpoint(e)) });
}));

router.get('/webhooks/:id', withAuth, asyncRoute(async (req, res) => {
  const e = await endpoints.get(req.account.id, String(req.params.id));
  res.json({ webhook: endpoints.publicEndpoint(e) });
}));

router.patch('/webhooks/:id', withAuth, asyncRoute(async (req, res) => {
  const e = await endpoints.update(req.account.id, String(req.params.id), req.body || {});
  res.json({ webhook: endpoints.publicEndpoint(e, { includeSecret: req.body && req.body.secret !== undefined }) });
}));

router.delete('/webhooks/:id', withAuth, asyncRoute(async (req, res) => {
  res.json(await endpoints.remove(req.account.id, String(req.params.id)));
}));

/* -------------------------------------------------------------- messages */

/**
 * Paged newest-first. The cursor is the message id, which is ULID-ish and so
 * sorts by time — that is what lets `id < cursor` be the whole pagination
 * condition, with no offset to drift as new mail arrives mid-page.
 */
router.get('/messages', withAuth, asyncRoute(async (req, res) => {
  const limit = pageLimit(req.query.limit);
  const where = ['m.account_id = $1'];
  const params = [req.account.id];
  if (req.query.mailbox_id) { params.push(String(req.query.mailbox_id)); where.push(`m.mailbox_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`m.status = $${params.length}`); }
  if (req.query.since) {
    const since = new Date(String(req.query.since));
    if (Number.isNaN(since.getTime())) throw bad('invalid_since', `"${req.query.since}" is not a date.`, { hint: 'Use an ISO-8601 timestamp, e.g. 2026-08-25T00:00:00Z.' });
    params.push(since.toISOString()); where.push(`m.received_at >= $${params.length}`);
  }
  if (req.query.cursor) { params.push(String(req.query.cursor)); where.push(`m.id < $${params.length}`); }
  // The review queue. "Almost nobody asks for better accuracy in the abstract —
  // they ask how do I find out that it went wrong", so this filter is a first
  // class query with its own partial index, not a client-side scan.
  if (req.query.needs_review !== undefined && req.query.needs_review !== 'false') where.push('m.needs_review');
  if (req.query.flag) {
    params.push(String(req.query.flag));
    where.push(`m.flags @> ARRAY[$${params.length}]::text[]`);
  }
  params.push(limit + 1);

  const { rows } = await query(
    `SELECT m.* FROM messages m WHERE ${where.join(' AND ')}
      ORDER BY m.received_at DESC, m.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  // ?view=review adds, per row, which flag fired on which field and the evidence
  // the value came from — enough to accept or fix without opening the message.
  const render = req.query.view === 'review' ? messages.renderReviewRow : messages.renderSummary;
  res.json({
    data: page.map(render),
    next_cursor: rows.length > limit ? page[page.length - 1].id : null,
  });
}));

router.get('/messages/:id', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, mb.token, mb.slug, mb.name AS mb_name, mb.id AS mb_id
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.id = $1 AND m.account_id = $2`,
    [String(req.params.id), req.account.id],
  );
  if (!rows.length) {
    throw notFound('message_not_found', `There is no message "${req.params.id}" on this account.`, {
      hint: 'Messages are kept for 7 days. List them with GET /v1/messages.',
      docs: '/docs#messages',
    });
  }
  const row = rows[0];
  const { include, exclude } = includeSets(req);
  let bytes = null;
  if (include.has('attachments')) {
    const { rows: atts } = await query(
      `SELECT a.id, b.bytes FROM attachments a LEFT JOIN blobs b ON b.ref = a.storage_ref WHERE a.message_id = $1`,
      [row.id],
    );
    bytes = Object.fromEntries(atts.filter((a) => a.bytes).map((a) => [a.id, a.bytes]));
  }
  res.json(messages.renderResult(row, { id: row.mb_id, token: row.token, slug: row.slug, name: row.mb_name }, {
    base: baseUrl(req), include, exclude, attachmentBytes: bytes,
  }));
}));

router.get('/messages/:id/raw', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT raw_ref FROM messages WHERE id = $1 AND account_id = $2`, [String(req.params.id), req.account.id],
  );
  if (!rows.length) throw notFound('message_not_found', `There is no message "${req.params.id}" on this account.`);
  const blob = await messages.readBlob(rows[0].raw_ref);
  if (!blob) {
    throw new ApiError(410, 'raw_unavailable', 'The original message is no longer stored.', {
      hint: `Raw MIME is kept for ${config.retentionDays} days, and a message over the size cap is never stored raw at all. The parsed JSON is still available.`,
      docs: '/docs#retention',
    });
  }
  res.set({
    'Content-Type': 'message/rfc822',
    'Content-Length': String(blob.size),
    'Content-Disposition': `attachment; filename="${String(req.params.id).replace(/[^\w.-]/g, '')}.eml"`,
  });
  res.end(blob.bytes);
}));

router.get('/attachments/:id', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT a.filename, a.content_type, a.storage_ref FROM attachments a
       JOIN messages m ON m.id = a.message_id
      WHERE a.id = $1 AND m.account_id = $2`,
    [String(req.params.id), req.account.id],
  );
  if (!rows.length) throw notFound('attachment_not_found', `There is no attachment "${req.params.id}" on this account.`);
  const blob = await messages.readBlob(rows[0].storage_ref);
  if (!blob) {
    throw new ApiError(410, 'attachment_unavailable', 'Those bytes are no longer stored.', {
      hint: `Attachments are kept for ${config.retentionDays} days, and anything over ${(config.maxAttachmentBytes / 1048576).toFixed(0)} MB is recorded but not stored.`,
      docs: '/docs#retention',
    });
  }
  res.set({
    'Content-Type': rows[0].content_type || 'application/octet-stream',
    'Content-Length': String(blob.size),
    'Content-Disposition': `attachment; filename="${String(rows[0].filename || 'attachment').replace(/["\\]/g, '')}"`,
  });
  res.end(blob.bytes);
}));

/**
 * Re-runs the parse. This is the endpoint people live in while they tune a
 * schema: change the fields, re-parse yesterday's real message, look at what
 * came out. It can also name an older schema version, which is the only honest
 * way to reproduce a result a customer is asking about.
 *
 * It does not re-fire the webhook unless asked. Re-delivering a message the
 * receiver already processed is how a tuning session turns into duplicate rows
 * in someone's database.
 */
router.post('/messages/:id/reparse', withAuth, asyncRoute(async (req, res) => {
  const message = await pipeline.loadMessage(String(req.params.id), req.account.id);
  if (!message) throw notFound('message_not_found', `There is no message "${req.params.id}" on this account.`);
  const body = req.body || {};
  // Never billed. The email was already paid for when it arrived, and the whole
  // point of re-parsing is that someone is fixing a schema against real mail —
  // charging per attempt would make people tune blind, which is the behaviour
  // every competitor's lack of a replay already forces.
  const opts = {
    requestId: req.id, eventType: 'message.reparsed', deliver: Boolean(body.deliver), bill: false,
  };
  if (body.schema !== undefined) opts.schema = validateSchema(body.schema);
  else if (body.schema_version !== undefined) opts.schemaVersion = Number(body.schema_version);

  const out = await pipeline.processMessage(message, opts);
  if (out.error) {
    throw new ApiError(502, 'parse_failed', `Re-parsing that message failed: ${out.error.message}`, {
      hint: 'The message itself is untouched and still holds its previous result.',
    });
  }
  const mb = out.mailbox;
  const { include, exclude } = includeSets(req);
  res.json(messages.renderResult(out.message, mb, { base: baseUrl(req), include, exclude }));
}));

/**
 * Re-parse a mailbox's stored history.
 *
 * The case this exists for: a sender changes their invoice layout, an
 * automation silently starts producing nulls, and it is noticed a fortnight
 * later. Everywhere else in this category the answer is "that mail is gone".
 * Here the original bytes are still on disk, so the fix is: adjust the schema,
 * dry-run it over last month to see the diff, then run it for real.
 *
 * `redeliver` defaults to false and `dry_run` writes nothing. Both defaults are
 * chosen so the dangerous thing has to be asked for by name.
 */
router.post('/mailboxes/:id/reparse', withAuth, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  const job = await reparse.create(req.account, mb, req.body || {});
  res.status(202).json({ ...job, poll: `${baseUrl(req)}/v1/reparse/${job.job_id}` });
}));

router.get('/reparse/:job_id', withAuth, asyncRoute(async (req, res) => {
  res.json(await reparse.get(req.account.id, String(req.params.job_id)));
}));

/* ------------------------------------------------------- stateless parse */

/**
 * Parse without an address and without storing anything. This is how someone
 * tries MailMint before they have signed anything up, and it is what the n8n
 * regular node calls when another node already fetched the mail.
 */
router.post('/parse', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const hasRaw = typeof body.raw_mime === 'string' && body.raw_mime.length;
  const hasParts = body.subject !== undefined || body.text !== undefined || body.html !== undefined;
  if (!hasRaw && !hasParts) {
    throw bad('missing_input', 'Send "raw_mime" (base64 or plain RFC822), or "subject"/"text"/"html".', {
      hint: 'Example: {"text":"Invoice INV-1, total $31.50","schema":[{"name":"total","type":"number"}]}.',
      docs: '/docs#parse',
    });
  }
  const schema = validateSchema(body.schema);
  const input = hasRaw
    ? (/^[A-Za-z0-9+/=\s]+$/.test(body.raw_mime) && !/^\s*[\w-]+:/.test(body.raw_mime)
      ? Buffer.from(body.raw_mime, 'base64')
      : Buffer.from(body.raw_mime, 'utf8'))
    : { subject: body.subject || null, text: body.text || null, html: body.html || null };
  if (Buffer.isBuffer(input) && input.length > config.maxRawBytes) {
    throw bad('too_large', `That message is ${(input.length / 1048576).toFixed(1)} MB, over the ${(config.maxRawBytes / 1048576).toFixed(0)} MB limit.`, { docs: '/docs#limits' });
  }

  await requireQuota(req.account, 1);
  const started = Date.now();
  const requestId = req.id;
  let result;
  try {
    result = await parseMessage(input, { schema, requestId, log });
  } catch (e) {
    log.error('parse.failed', { error: String(e.message || e), stateless: true, account_id: Number(req.account.id) });
    throw new ApiError(502, 'parse_failed', `Parsing failed: ${e.message}`, {
      hint: 'If this is a real message that another service handles fine, send it to support with this request id.',
    });
  }
  // DKIM is computable from the raw message alone, so a stateless parse can and
  // should answer it. SPF and DMARC cannot be: they need the envelope and the
  // connecting IP. Reporting all three as null made the honest gap look like a
  // finding of "nothing wrong".
  if (Buffer.isBuffer(input)) {
    result.auth = { ...(result.auth || {}), ...(await senderAuth.verifyRaw(input, { requestId })) };
    if (result.auth.dkim === 'body_altered' && !(result.flags || []).includes('dkim_body_altered')) {
      result.flags = [...(result.flags || []), 'dkim_body_altered'];
    }
  }

  result.id = null;
  result.mailbox = null;
  result.raw_url = null;
  result.needs_review = needsReview(result.flags);
  // Bytes never travel back out of the stateless endpoint; nothing stored them.
  result.attachments = (result.attachments || []).map(({ bytes, ...a }) => ({ ...a, url: null }));

  log.info('parse.done', {
    stateless: true, account_id: Number(req.account.id),
    model: result.parse.model || null, llm_used: Boolean(result.parse.llm_used),
    timings_ms: { ...result.parse.timings_ms, wall: Date.now() - started },
    field_count: Object.keys(result.fields || {}).length,
    mean_confidence: meanConfidence(result.fields),
    flags: result.flags, needs_review: result.needs_review,
  });
  query(`INSERT INTO usage_events (account_id, kind, billable, llm_used, model, duration_ms, ok, origin)
         VALUES ($1,'parse',$2,$3,$4,$5,true,$6)`,
  [req.account.id, req.account.key_mode !== 'test', Boolean(result.parse.llm_used),
    result.parse.model || null, Date.now() - started, config.origin]).catch(() => {});
  res.json(result);
}));

/* ---------------------------------------------------------------- events */

/**
 * The polling feed the n8n trigger lives on. `id` is a bigserial, so the cursor
 * is strictly monotonic and unique — a timestamp cursor would silently skip the
 * second of two events written in the same millisecond.
 */
router.get('/events', withAuth, asyncRoute(async (req, res) => {
  const limit = pageLimit(req.query.limit, 50);
  const cursor = req.query.cursor === undefined || req.query.cursor === '' ? 0 : Number(req.query.cursor);
  if (!Number.isFinite(cursor) || cursor < 0) {
    throw bad('invalid_cursor', `"${req.query.cursor}" is not a cursor.`, {
      hint: 'Pass back the next_cursor from the previous call, or omit it to start from the beginning of the retained window.',
      docs: '/docs#events',
    });
  }
  const params = [req.account.id, cursor];
  let mailboxClause = '';
  if (req.query.mailbox_id) { params.push(String(req.query.mailbox_id)); mailboxClause = `AND e.mailbox_id = $${params.length}`; }
  params.push(limit);

  // Every column of `e` is aliased. `m.*` carries its own `id` and `created_at`,
  // and an unaliased `e.id` is silently overwritten by it — which turned the
  // event cursor into a message id and made the poller loop forever.
  const { rows } = await query(
    `SELECT e.id AS event_id, e.type AS event_type, e.created_at AS event_created_at, e.message_id,
            m.*, mb.id AS mb_id, mb.token, mb.slug, mb.name AS mb_name
       FROM events e
       LEFT JOIN messages m ON m.id = e.message_id
       LEFT JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE e.account_id = $1 AND e.id > $2 ${mailboxClause}
      ORDER BY e.id ASC LIMIT $${params.length}`,
    params,
  );
  const base = baseUrl(req);
  const events = rows.map((r) => ({
    id: Number(r.event_id),
    type: r.event_type,
    cursor: String(r.event_id),
    created_at: new Date(r.event_created_at).toISOString(),
    message: r.message_id && r.mb_id
      ? messages.renderResult(
        { ...r, id: r.message_id },
        { id: r.mb_id, token: r.token, slug: r.slug, name: r.mb_name },
        { base, exclude: new Set(['extracted']) },
      )
      : null,
  }));
  res.json({
    events,
    next_cursor: events.length ? events[events.length - 1].cursor : String(cursor),
    has_more: events.length === limit,
  });
}));

/* ----------------------------------------------------------- test inject */

/**
 * Injects a message as if it had been received. Same code path as
 * /internal/deliver, and deliberately synchronous: a person clicking "send a
 * test email" wants the parsed JSON on the screen, not a promise about it.
 */
router.post('/test/deliver', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const mb = await mailboxes.get(req.account.id, String(body.mailbox_id || ''));
  const raw = body.raw_mime
    ? Buffer.from(String(body.raw_mime), /^[A-Za-z0-9+/=\s]+$/.test(body.raw_mime) && !/^\s*[\w-]+:/.test(body.raw_mime) ? 'base64' : 'utf8')
    : Buffer.from(buildTestMime(body, mb), 'utf8');
  if (raw.length > config.maxRawBytes) throw bad('too_large', `That message is over the ${(config.maxRawBytes / 1048576).toFixed(0)} MB limit.`);

  const message = await messages.ingest({
    mailbox: mb,
    envelope: {
      from: body.from || 'test@mailmint.dev',
      to: [`${mb.token}@${config.inboundDomain}`],
      helo: 'test.mailmint.dev', remote_ip: req.ip, tls: true, injected: true,
    },
    raw,
  });
  // The same Message-ID twice is one message, here as everywhere else.
  if (message.duplicate && message.id) {
    const existing = await pipeline.loadMessage(message.id, req.account.id);
    if (existing) return res.status(200).json(messages.renderResult(existing, mb, { base: baseUrl(req) }));
  }
  const out = await pipeline.processMessage(message, {
    requestId: req.id,
    deliver: body.deliver !== false,
    bill: req.account.key_mode !== 'test',
  });
  if (out.error) {
    throw new ApiError(502, 'parse_failed', `The message was stored but parsing failed: ${out.error.message}`, {
      details: { message_id: message.id },
    });
  }
  res.status(201).json(messages.renderResult(out.message, out.mailbox, { base: baseUrl(req) }));
}));

function buildTestMime(body, mb) {
  const from = body.from || 'billing@acme-example.com';
  const subject = body.subject || 'Invoice INV-2291 from Acme Ltd';
  const text = body.text || 'Hello,\n\nInvoice INV-2291 is attached below.\n\nTotal: $31.50\nDue: Sep 8, 2026\n\nThanks,\nAcme Billing\n';
  return [
    `From: ${from}`,
    `To: ${mb.token}@${config.inboundDomain}`,
    `Subject: ${subject}`,
    `Message-Id: <${ids.ulid()}@test.mailmint.dev>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '', text,
  ].join('\r\n');
}

/* ----------------------------------------------------------------- usage */

router.get('/usage', withAuth, asyncRoute(async (req, res) => {
  const plan = PLANS[req.account.plan] || PLANS.free;
  const { rows: counts } = await query(
    `SELECT
       count(*) FILTER (WHERE received_at >= date_trunc('month', now() AT TIME ZONE 'UTC'))::int AS this_month,
       count(*) FILTER (WHERE received_at >= now() - interval '24 hours')::int AS last_24h,
       count(*) FILTER (WHERE needs_review)::int AS needs_review,
       count(*)::int AS stored
     FROM messages WHERE account_id = $1`,
    [req.account.id],
  );
  const { rows: mb } = await query(
    `SELECT count(*)::int AS n FROM mailboxes WHERE account_id = $1 AND deleted_at IS NULL`, [req.account.id],
  );
  res.json({
    plan: { id: plan.id, name: plan.name, quota: req.account.quota_month, price_usd: plan.priceUsd },
    period_start: new Date(req.account.period_start).toISOString(),
    used: req.account.used_month,
    remaining: Math.max(0, req.account.quota_month - req.account.used_month),
    messages: counts[0],
    mailboxes: mb[0].n,
    retention_days: config.retentionDays,
    key_mode: req.account.key_mode,
  });
}));

module.exports = { router };
