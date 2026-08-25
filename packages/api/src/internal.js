'use strict';

const express = require('express');
const { query } = require('./db');
const { config } = require('./config');
const { log } = require('./log');
const { ApiError, bad } = require('./errors');
const { internalSecretMatches } = require('./auth');
const { tokenFromAddress } = require('./addresses');
const ids = require('./ids');
const messages = require('./messages');
const pipeline = require('./pipeline');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The mail VPS is the only caller here, and it is on a different host, so the
 * guard is a shared secret rather than a network ACL. Compared in constant time:
 * `!==` on a secret leaks its first differing byte to anyone who can time the
 * response, and this endpoint is hit on every single inbound message.
 */
function requireInternal(req, res, next) {
  if (!config.internalSecret) {
    return next(new ApiError(503, 'internal_not_configured',
      'INTERNAL_SECRET is not set on this deployment, so the internal API is closed.', {
        hint: 'Set the same INTERNAL_SECRET on the API and on the smtpd.',
      }));
  }
  if (!internalSecretMatches(req.get('x-mailmint-internal'), config.internalSecret)) {
    log.warn('internal.unauthorized', { path: req.path, ip: req.ip });
    return next(new ApiError(401, 'unauthorized', 'The x-mailmint-internal header is missing or wrong.'));
  }
  return next();
}

router.use(requireInternal);

/**
 * Which mailbox, if any, a recipient address belongs to.
 *
 * The smtpd calls this at RCPT TO so it can refuse unknown recipients during the
 * SMTP conversation, which is the only point at which a refusal is cheap and
 * the sender is told immediately. Answering after DATA means either accepting
 * mail we cannot route or generating a bounce, and generating bounces for
 * addresses that never existed is how a mail server earns a spam reputation.
 */
async function resolveOne(address) {
  const parsed = tokenFromAddress(address);
  if (!parsed) return { address, ok: false, reason: 'malformed_address' };
  if (parsed.domain !== config.inboundDomain.toLowerCase()) {
    return { address, ok: false, reason: 'wrong_domain', expected: config.inboundDomain };
  }
  // The whole mailbox row, not just the routing columns: /internal/deliver needs
  // it a moment later, and asking twice would be a second round trip on the path
  // an SMTP session is blocked on. The extra columns are stripped before this is
  // serialised — the smtpd has no business knowing a webhook secret.
  const { rows } = await query(
    `SELECT mb.*, a.plan, a.used_month, a.quota_month
       FROM mailboxes mb JOIN accounts a ON a.id = mb.account_id
      WHERE mb.token = $1 AND mb.deleted_at IS NULL`,
    [parsed.token],
  );
  if (!rows.length) return { address, ok: false, reason: 'unknown_mailbox' };
  const mb = rows[0];
  return {
    row: mb,
    address,
    ok: true,
    tag: parsed.tag,
    // Carried out so /internal/deliver does not have to ask again on the path an
    // SMTP session is waiting on; it decides how long the raw bytes are kept.
    plan: mb.plan,
    mailbox: {
      id: mb.id, token: mb.token, slug: mb.slug, name: mb.name,
      account_id: Number(mb.account_id), paused: mb.paused, forward_to: mb.forward_to,
    },
    // Not a reason to refuse — mail is always accepted — but the smtpd logs it
    // and it is what tells an operator why parses stopped.
    over_quota: Number(mb.used_month) >= Number(mb.quota_month),
  };
}

router.post('/resolve', asyncRoute(async (req, res) => {
  const list = req.body && (Array.isArray(req.body.to) ? req.body.to
    : req.body.to ? [req.body.to] : (req.body.rcpt ? [req.body.rcpt] : []));
  if (!list || !list.length) {
    throw bad('missing_recipient', 'Send {"to": "token@domain"} or {"to": ["a@…","b@…"]}.');
  }
  const resolved = await Promise.all(list.slice(0, 50).map(resolveOne));
  // `row` is the internal handle; it never leaves this process.
  const results = resolved.map(({ row, ...rest }) => rest);
  const accepted = results.filter((r) => r.ok);
  log.info('internal.resolve', {
    asked: results.length, accepted: accepted.length,
    reasons: results.filter((r) => !r.ok).map((r) => r.reason),
  });
  res.json({ ok: accepted.length > 0, results, domain: config.inboundDomain });
}));

/**
 * Accepts one received message.
 *
 * The order is deliberate and load-bearing:
 *   1. resolve the mailbox        — a failure here is the smtpd's to report
 *   2. write the row and the raw  — after this, nothing can lose the mail
 *   3. answer 200 {message_id}    — the SMTP session is freed
 *   4. parse, event, webhook      — on our own time, in the background
 *
 * Parsing can take seconds (an LLM call) and can fail. Holding an SMTP session
 * open for it means the sender's queue backs up on us, and a timeout there
 * turns into a retry, which turns into a duplicate. So the response goes out as
 * soon as the bytes are durable.
 *
 * `wait: true` runs the parse inline instead, which is what POST /v1/test/deliver
 * and the dashboard's test panel use so a human sees a result immediately.
 */
router.post('/deliver', asyncRoute(async (req, res) => {
  const started = Date.now();
  const body = req.body || {};
  const envelope = body.envelope || {};
  const rcpts = Array.isArray(envelope.to) ? envelope.to : (envelope.to ? [envelope.to] : []);
  const target = body.mailbox_token || body.token || rcpts[0];
  if (!target) {
    throw bad('missing_recipient', 'Send envelope.to (the SMTP RCPT TO) or mailbox_token.');
  }

  const resolved = target.includes('@') ? await resolveOne(target)
    : await resolveOne(`${target}@${config.inboundDomain}`);
  if (!resolved.ok) {
    log.warn('internal.deliver.unroutable', { to: target, reason: resolved.reason });
    throw new ApiError(404, 'unknown_mailbox', `No mailbox answers to "${target}".`, {
      hint: 'The local part is a 12-character token, optionally prefixed with a slug and a dot, optionally suffixed with +tag.',
      details: { reason: resolved.reason },
    });
  }

  const raw = body.raw_mime !== undefined && body.raw_mime !== null
    ? (Buffer.isBuffer(body.raw_mime) ? body.raw_mime
      : Buffer.from(String(body.raw_mime), body.encoding === 'utf8' ? 'utf8' : 'base64'))
    : null;
  if (!raw || !raw.length) throw bad('missing_raw_mime', 'Send raw_mime, base64-encoded (or encoding:"utf8" for plain text).');

  const mailbox = resolved.row;

  const message = await messages.ingest({
    mailbox,
    envelope: { ...envelope, to: rcpts.length ? rcpts : [resolved.address], tag: resolved.tag },
    raw,
    receivedAt: body.received_at || null,
    plan: resolved.plan,
    // The connector sends the original Message-ID on every call; the SMTP path
    // has it in the headers. Either way it is what makes this endpoint safe to
    // call twice with the same mail.
    idempotencyKey: body.idempotency_key || body.message_id || null,
  });

  // Already seen. Answer with the id we gave it the first time and do nothing
  // else: no second row, no second event, no second webhook. A caller retrying
  // after a lost response gets the same answer it should have got, and the
  // customer's workflow runs once.
  if (message.duplicate) {
    log.info('internal.deliver.duplicate', {
      message_id: message.id, mailbox_id: mailbox.id, account_id: Number(mailbox.account_id),
      idempotency_key: body.idempotency_key || body.message_id || null, total_ms: Date.now() - started,
    });
    return res.json({ message_id: message.id, status: message.status || 'received', duplicate: true });
  }

  if (body.forwarding_confirmation) {
    await recordForwardingConfirmation(mailbox, message, body.forwarding_confirmation).catch((e) => {
      log.warn('forwarding.record_failed', { mailbox_id: mailbox.id, error: String(e.message || e) });
    });
  }

  const persistedMs = Date.now() - started;

  if (body.wait) {
    const out = await pipeline.processMessage(message, { requestId: req.id });
    log.info('internal.deliver', {
      message_id: message.id, mailbox_id: mailbox.id, account_id: Number(mailbox.account_id),
      bytes: raw.length, persisted_ms: persistedMs, total_ms: Date.now() - started, inline_parse: true,
    });
    return res.json({ message_id: message.id, status: out.error ? 'failed' : 'parsed' });
  }

  // Answer first, parse after. The row exists, so nothing is lost if this
  // process dies between the two.
  res.json({ message_id: message.id, status: 'received' });
  log.info('internal.deliver', {
    message_id: message.id, mailbox_id: mailbox.id, account_id: Number(mailbox.account_id),
    bytes: raw.length, persisted_ms: persistedMs, total_ms: Date.now() - started, inline_parse: false,
  });
  pipeline.processInBackground(message, { requestId: req.id });
  return undefined;
}));

/* --------------------------------------------------- connector state */

/**
 * The IMAP connector's per-connection high-water mark — UIDVALIDITY plus last
 * UID, or a provider cursor.
 *
 * It lives here rather than in a file next to the connector so the connector is
 * stateless: it can be restarted, redeployed or moved to another host without
 * replaying somebody's inbox from the beginning. The connector already stores
 * Message-IDs in it as truncated SHA-256 rather than in the clear, and nothing
 * here undoes that — the column is opaque JSON to this service.
 */
router.post('/connector-state', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const connectionId = String(body.connection_id || '').trim();
  if (!connectionId) throw bad('missing_connection_id', 'Send {"connection_id": "...", "state": {...}}.');
  if (body.state === undefined || body.state === null || typeof body.state !== 'object') {
    throw bad('missing_state', 'Send the high-water mark in "state" as an object.');
  }
  const serialised = JSON.stringify(body.state);
  const MAX_STATE_BYTES = 256 * 1024;
  if (Buffer.byteLength(serialised) > MAX_STATE_BYTES) {
    throw bad('state_too_large', `Connector state is ${Buffer.byteLength(serialised)} bytes, over the ${MAX_STATE_BYTES} limit.`, {
      hint: 'A high-water mark should be small. If you are accumulating seen-ids, prune them.',
    });
  }
  // The mailbox is optional: a connection can be registered before it has been
  // pointed at one, and losing the cursor because of that would be worse than
  // storing it unattached.
  let mailboxId = null;
  let accountId = null;
  if (body.mailbox_token || body.mailbox_id) {
    const { rows } = await query(
      body.mailbox_id
        ? `SELECT id, account_id FROM mailboxes WHERE id = $1 AND deleted_at IS NULL`
        : `SELECT id, account_id FROM mailboxes WHERE token = $1 AND deleted_at IS NULL`,
      [String(body.mailbox_id || body.mailbox_token)],
    );
    if (rows.length) { mailboxId = rows[0].id; accountId = rows[0].account_id; }
  }
  const { rows } = await query(
    `INSERT INTO connector_state (connection_id, account_id, mailbox_id, state)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (connection_id) DO UPDATE
       SET state = EXCLUDED.state,
           mailbox_id = COALESCE(EXCLUDED.mailbox_id, connector_state.mailbox_id),
           account_id = COALESCE(EXCLUDED.account_id, connector_state.account_id),
           updated_at = now()
     RETURNING connection_id, mailbox_id, updated_at`,
    [connectionId, accountId, mailboxId, serialised],
  );
  log.info('internal.connector_state.saved', {
    connection_id: connectionId, mailbox_id: rows[0].mailbox_id, bytes: Buffer.byteLength(serialised),
  });
  res.json({ ok: true, connection_id: rows[0].connection_id, updated_at: rows[0].updated_at });
}));

router.get('/connector-state', asyncRoute(async (req, res) => {
  const connectionId = String(req.query.connection_id || '').trim();
  if (!connectionId) throw bad('missing_connection_id', 'Pass ?connection_id=...');
  const { rows } = await query(
    `SELECT connection_id, mailbox_id, state, updated_at FROM connector_state WHERE connection_id = $1`,
    [connectionId],
  );
  // A connection that has never reported is not an error — it is a cold start,
  // and answering 404 would make the connector treat "new" as "broken".
  if (!rows.length) return res.json({ connection_id: connectionId, state: null, updated_at: null });
  return res.json(rows[0]);
}));

/* -------------------------------------------- forwarding confirmations */

/**
 * The confirmation mail Gmail, Outlook, Zoho, Fastmail, iCloud and Yahoo send
 * when someone points forwarding at a MailMint address.
 *
 * Every competitor makes the user go and find that mail in the mailbox they
 * have just forwarded away from. Surfacing the code on the page they are
 * already looking at is a small, real onboarding win.
 *
 * SECURITY: this is attacker-reachable. Anyone who learns a mailbox address can
 * email it a convincing fake "confirm your forwarding" message. The detector
 * marks `link_trusted: false` when the link's host is not the provider's own
 * domain, and that flag is honoured all the way to the page: an untrusted link
 * is rendered as inert text, never as an anchor, and nothing here ever follows
 * a link itself.
 */
async function recordForwardingConfirmation(mailbox, message, conf) {
  const link = conf.link ? String(conf.link).slice(0, 2000) : null;
  let trusted = Boolean(conf.link_trusted);
  if (link) {
    // Belt and braces: re-check the scheme here rather than trusting the caller
    // to have done it. A javascript: or data: URL must never reach the page as
    // anything but text, whatever the sender claimed about it.
    try {
      const u = new URL(link);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') trusted = false;
    } catch { trusted = false; }
  }
  const { rows } = await query(
    `INSERT INTO forwarding_confirmations
       (id, account_id, mailbox_id, provider, code, link, link_trusted, from_email, subject, message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [`fwc_${ids.ulid()}`, mailbox.account_id, mailbox.id,
      conf.provider ? String(conf.provider).slice(0, 40) : null,
      conf.code ? String(conf.code).slice(0, 64) : null,
      link, trusted,
      conf.from ? String(conf.from).slice(0, 320) : null,
      conf.subject ? String(conf.subject).slice(0, 300) : null,
      message ? message.id : null],
  );
  log.info('forwarding.confirmation', {
    id: rows[0].id, mailbox_id: mailbox.id, provider: conf.provider || null,
    has_code: Boolean(conf.code), has_link: Boolean(link), link_trusted: trusted,
  });
  return rows[0].id;
}

/** Standalone form, for a confirmation that arrived without a message body to store. */
router.post('/forwarding-confirmation', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const target = body.mailbox_token || body.mailbox_id || body.to;
  if (!target) throw bad('missing_mailbox', 'Send mailbox_token, mailbox_id or to.');
  const { rows } = await query(
    body.mailbox_id
      ? `SELECT * FROM mailboxes WHERE id = $1 AND deleted_at IS NULL`
      : `SELECT * FROM mailboxes WHERE token = $1 AND deleted_at IS NULL`,
    [String(body.mailbox_id || (String(target).includes('@')
      ? (tokenFromAddress(target) || {}).token : target))],
  );
  if (!rows.length) throw new ApiError(404, 'unknown_mailbox', `No mailbox answers to "${target}".`);
  const conf = body.forwarding_confirmation || body;
  const id = await recordForwardingConfirmation(rows[0], body.message_id ? { id: body.message_id } : null, conf);
  res.json({ ok: true, id });
}));

/** Lets the smtpd check the API is reachable and holds the same secret. */
router.get('/ping', (req, res) => res.json({ ok: true, domain: config.inboundDomain }));

module.exports = { router, resolveOne, recordForwardingConfirmation };
