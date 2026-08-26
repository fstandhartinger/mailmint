'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { config } = require('./config');
const { log } = require('./log');
const ids = require('./ids');

/**
 * §5: attempts at 0s, 30s, 2m, 10m, 1h, 6h. Six attempts, 10s timeout each.
 * The schedule is the delay BEFORE attempt n+1, indexed from the attempt that
 * just failed, so SCHEDULE[0] is the wait after the first failure.
 */
const SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600];
const MAX_ATTEMPTS = SCHEDULE_SECONDS.length + 1; // 6

/**
 * Signs the body per §5: `t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`.
 *
 * The timestamp is inside the signed string, which is what makes a captured
 * request non-replayable: a receiver rejects anything older than its tolerance
 * and the attacker cannot re-stamp it without the secret.
 */
function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { header: `t=${timestamp},v1=${mac}`, timestamp, mac };
}

/** The verifier a customer would write, kept here so the tests can use ours honestly. */
function verify(secret, body, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=').map((s) => s.trim())));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(parts.v1), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Queues one delivery. The queue is a table, not an in-memory list: a redeploy
 * restarts this process, and a webhook that only lived in memory would be a
 * message the customer never learns about and cannot ask for again.
 */
async function enqueue({ messageId, accountId, url, endpointId = null }) {
  if (!url) return null;
  const id = ids.deliveryId();
  await query(
    `INSERT INTO webhook_deliveries (id, message_id, account_id, url, endpoint_id, attempt, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,0, now())`,
    [id, messageId, accountId, url, endpointId],
  );
  log.info('webhook.queued', { delivery_id: id, message_id: messageId, endpoint_id: endpointId, url });
  return id;
}

/**
 * Queues one delivery per ACTIVE endpoint on the mailbox.
 *
 * Fan-out rather than a single URL, because two workflows may legitimately want
 * the same mail and neither should be able to switch the other off. Each gets
 * its own delivery row, so a receiver that is down retries on its own schedule
 * without holding up the one that is up.
 */
async function enqueueForMailbox({ messageId, accountId, mailboxId }) {
  // eslint-disable-next-line global-require
  const endpoints = require('./webhook-endpoints');
  const active = await endpoints.activeFor(mailboxId);
  const queued = [];
  for (const e of active) {
    // eslint-disable-next-line no-await-in-loop
    const id = await enqueue({ messageId, accountId, url: e.url, endpointId: e.id });
    if (id) queued.push(id);
  }
  return queued;
}

/** Claims one due delivery. SKIP LOCKED so two workers never take the same row. */
function claim() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM webhook_deliveries
        WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) return null;
    await client.query(`UPDATE webhook_deliveries SET locked_at = now() WHERE id = $1`, [rows[0].id]);
    return rows[0];
  });
}

/**
 * 4xx means the receiver understood us and said no; retrying cannot change
 * that, and hammering a 404 for six hours is how a customer's logs fill with
 * our noise. 408 and 429 are the two that DO mean "later", so they retry.
 */
const retriable = (status) => !(status >= 400 && status < 500) || status === 408 || status === 429;

async function attemptOnce(delivery) {
  // The signing secret comes from the ENDPOINT when there is one, so rotating
  // one workflow's secret cannot invalidate another's. Deliveries queued before
  // endpoints existed fall back to the mailbox secret they were signed with.
  const { rows } = await query(
    `SELECT m.id, m.mailbox_id, m.account_id, mb.name AS mailbox_name, mb.token, mb.slug,
            COALESCE(e.secret, mb.webhook_secret) AS webhook_secret, e.id AS endpoint_id
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       LEFT JOIN webhook_endpoints e ON e.id = $2
      WHERE m.id = $1`,
    [delivery.message_id, delivery.endpoint_id || null],
  );
  if (!rows.length) {
    await query(`UPDATE webhook_deliveries SET failed_at = now(), error = $2 WHERE id = $1`,
      [delivery.id, 'message no longer exists']);
    return;
  }
  const meta = rows[0];
  // eslint-disable-next-line global-require
  const endpoints = require('./webhook-endpoints');

  // The body is built here rather than stored on the row so a re-parse that
  // corrected a field is what gets retried, not the version that failed.
  const { buildPayload } = require('./delivery-payload');
  const payload = await buildPayload(delivery.message_id);
  const body = JSON.stringify(payload);
  const attempt = delivery.attempt + 1;
  const { header, timestamp } = sign(meta.webhook_secret, body);
  const started = Date.now();

  let status = null;
  let error = null;
  try {
    const res = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MailMint-Webhook/1',
        'x-mailmint-event': 'message.parsed',
        'x-mailmint-delivery': delivery.id,
        ...(delivery.endpoint_id ? { 'x-mailmint-endpoint': delivery.endpoint_id } : {}),
        'x-mailmint-signature': header,
        'x-mailmint-timestamp': String(timestamp),
      },
      body,
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
    status = res.status;
    // The body is drained and discarded: leaving it unread keeps the socket
    // pinned until the GC gets to it, which under load is a file-descriptor leak.
    await res.text().catch(() => {});
  } catch (e) {
    error = e.name === 'TimeoutError' ? `timeout after ${config.webhookTimeoutMs}ms` : String(e.message || e);
  }

  const ok = status !== null && status >= 200 && status < 300;
  const ms = Date.now() - started;
  log.info('webhook.attempt', {
    delivery_id: delivery.id, message_id: delivery.message_id, account_id: Number(delivery.account_id),
    endpoint_id: delivery.endpoint_id || null,
    url: delivery.url, attempt, max_attempts: MAX_ATTEMPTS, status, ms, ok, error, bytes: body.length,
  });

  if (ok) {
    await query(
      `UPDATE webhook_deliveries SET attempt = $2, status_code = $3, delivered_at = now(),
              error = NULL, locked_at = NULL, next_attempt_at = NULL WHERE id = $1`,
      [delivery.id, attempt, status],
    );
    await endpoints.recordSuccess(delivery.endpoint_id, status);
    return;
  }

  const giveUp = attempt >= MAX_ATTEMPTS || (status !== null && !retriable(status));
  if (giveUp) {
    await query(
      `UPDATE webhook_deliveries SET attempt = $2, status_code = $3, error = $4,
              failed_at = now(), locked_at = NULL, next_attempt_at = NULL WHERE id = $1`,
      [delivery.id, attempt, status, error || `HTTP ${status}`],
    );
    log.warn('webhook.failed', {
      delivery_id: delivery.id, message_id: delivery.message_id, account_id: Number(delivery.account_id),
      endpoint_id: delivery.endpoint_id || null,
      url: delivery.url, attempts: attempt, status, error: error || `HTTP ${status}`,
      reason: attempt >= MAX_ATTEMPTS ? 'attempts_exhausted' : 'non_retriable_status',
    });
    // Only a delivery that has given up counts against the endpoint. One failed
    // attempt out of six is a hiccup, not a dead receiver.
    await endpoints.recordFailure(delivery.endpoint_id, status, error || `HTTP ${status}`);
    return;
  }

  const wait = SCHEDULE_SECONDS[attempt - 1];
  await query(
    `UPDATE webhook_deliveries SET attempt = $2, status_code = $3, error = $4, locked_at = NULL,
            next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id = $1`,
    [delivery.id, attempt, status, error || `HTTP ${status}`, String(wait)],
  );
}

/** The background worker. One tick, one delivery; back off when the queue is empty. */
function startWorker() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let claimed = null;
    try {
      claimed = await claim();
      if (claimed) await attemptOnce(claimed);
    } catch (e) {
      log.error('webhook.worker_error', { error: String(e.message || e) });
    } finally {
      if (!stopped) setTimeout(tick, claimed ? 10 : config.webhookPollMs).unref();
    }
  };
  setTimeout(tick, 200).unref();

  // A delivery locked by a process that then died would sit locked forever.
  // Nothing here trusts the lock for correctness — SKIP LOCKED does that — so
  // this only clears the flag for the dashboard's benefit.
  setInterval(() => {
    query(`UPDATE webhook_deliveries SET locked_at = NULL
            WHERE locked_at < now() - interval '5 minutes' AND delivered_at IS NULL AND failed_at IS NULL`)
      .catch(() => {});
  }, 60000).unref();

  return () => { stopped = true; };
}

module.exports = { sign, verify, enqueue, enqueueForMailbox, startWorker, attemptOnce, claim, SCHEDULE_SECONDS, MAX_ATTEMPTS, retriable };
