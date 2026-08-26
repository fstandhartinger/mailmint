'use strict';

const crypto = require('node:crypto');
const { query } = require('./db');
const { log } = require('./log');
const { ApiError, notFound } = require('./errors');
const { assertWebhookUrl } = require('./mailboxes');

/**
 * Webhook endpoints, plural, per mailbox.
 *
 * A single `webhook_url` column is a shared mutable global. Two n8n
 * MailMintTrigger nodes pointed at one mailbox would overwrite each other's URL
 * on registration, and disabling one workflow would delete the other's
 * delivery — the second workflow simply stops receiving mail and nothing says
 * why. An endpoint is its own row with its own secret, so registrations are
 * independent and deleting one cannot touch another.
 *
 * `mailbox.webhook_url` still works and now reads and writes the FIRST endpoint,
 * so anything already written against it keeps working. The array is the model;
 * the column is a convenience.
 */

/**
 * How many whole deliveries may exhaust their retries in a row before the
 * endpoint is switched off.
 *
 * Each delivery is already six attempts over six hours, so ten of them is a
 * receiver that has been gone for days. Retrying into a black hole forever
 * costs us nothing visible and costs the customer their review queue filling
 * with failures they never see — switching it off and SAYING so is the useful
 * behaviour.
 */
const MAX_CONSECUTIVE_FAILURES = Number(process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES || 10);

const newId = () => `whe_${crypto.randomBytes(16).toString('hex')}`;
const newSecret = () => crypto.randomBytes(24).toString('hex');

const publicEndpoint = (e, { includeSecret = false } = {}) => ({
  id: e.id,
  mailbox_id: e.mailbox_id,
  url: e.url,
  description: e.description,
  active: e.active,
  ...(includeSecret ? { secret: e.secret } : {}),
  created_at: new Date(e.created_at).toISOString(),
  last_status: e.last_status,
  last_delivered_at: e.last_delivered_at ? new Date(e.last_delivered_at).toISOString() : null,
  last_error: e.last_error,
  consecutive_failures: e.consecutive_failures,
  disabled_at: e.disabled_at ? new Date(e.disabled_at).toISOString() : null,
  disabled_reason: e.disabled_reason,
});

async function create(mailbox, { url, description, secret } = {}) {
  const clean = assertWebhookUrl(url);
  if (!clean) {
    throw new ApiError(400, 'missing_url', 'A webhook endpoint needs a "url".', {
      hint: 'For example {"url": "https://example.com/hooks/mailmint"}.',
      docs: '/docs#webhooks',
    });
  }
  if (secret && String(secret).length < 16) {
    throw new ApiError(400, 'weak_webhook_secret', 'A webhook secret must be at least 16 characters.', {
      hint: 'Omit it and one will be generated for you.',
      docs: '/docs#webhooks',
    });
  }
  const { rows } = await query(
    `INSERT INTO webhook_endpoints (id, mailbox_id, account_id, url, secret, description)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [newId(), mailbox.id, mailbox.account_id, clean, secret || newSecret(),
      description ? String(description).slice(0, 200) : null],
  );
  log.info('webhook_endpoint.created', {
    endpoint_id: rows[0].id, mailbox_id: mailbox.id, account_id: Number(mailbox.account_id), url: clean,
  });
  return rows[0];
}

const listFor = (mailboxId) => query(
  `SELECT * FROM webhook_endpoints WHERE mailbox_id = $1 ORDER BY created_at, id`, [mailboxId],
).then((r) => r.rows);

/** Every endpoint a parsed message should be delivered to. */
const activeFor = (mailboxId) => query(
  `SELECT * FROM webhook_endpoints WHERE mailbox_id = $1 AND active AND disabled_at IS NULL
    ORDER BY created_at, id`, [mailboxId],
).then((r) => r.rows);

async function get(accountId, id) {
  const { rows } = await query(
    `SELECT * FROM webhook_endpoints WHERE id = $1 AND account_id = $2`, [id, accountId],
  );
  if (!rows.length) {
    throw notFound('webhook_not_found', `There is no webhook endpoint "${id}" on this account.`, {
      hint: 'List them with GET /v1/mailboxes/:id/webhooks. Endpoint ids look like whe_….',
      docs: '/docs#webhooks',
    });
  }
  return rows[0];
}

async function update(accountId, id, patch = {}) {
  const existing = await get(accountId, id);
  const sets = [];
  const params = [id];
  if (patch.url !== undefined) { params.push(assertWebhookUrl(patch.url)); sets.push(`url = $${params.length}`); }
  if (patch.description !== undefined) {
    params.push(patch.description ? String(patch.description).slice(0, 200) : null);
    sets.push(`description = $${params.length}`);
  }
  if (patch.secret !== undefined) {
    params.push(patch.secret ? String(patch.secret) : newSecret());
    sets.push(`secret = $${params.length}`);
  }
  if (patch.active !== undefined) {
    params.push(Boolean(patch.active));
    sets.push(`active = $${params.length}`);
    // Re-enabling clears the auto-disable: the operator is asserting the
    // receiver is back, and leaving the old count would switch it straight off
    // again on the next hiccup.
    if (patch.active) sets.push('consecutive_failures = 0, disabled_at = NULL, disabled_reason = NULL');
  }
  if (!sets.length) return existing;
  const { rows } = await query(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  log.info('webhook_endpoint.updated', { endpoint_id: id, changed: Object.keys(patch) });
  return rows[0];
}

async function remove(accountId, id) {
  const e = await get(accountId, id);
  await query(`DELETE FROM webhook_endpoints WHERE id = $1`, [e.id]);
  log.info('webhook_endpoint.deleted', { endpoint_id: e.id, mailbox_id: e.mailbox_id });
  return { id: e.id, deleted: true };
}

/** Called by the delivery worker after every finished delivery. */
async function recordSuccess(endpointId, status) {
  if (!endpointId) return;
  await query(
    `UPDATE webhook_endpoints SET last_status = $2, last_delivered_at = now(), last_error = NULL,
            consecutive_failures = 0 WHERE id = $1`,
    [endpointId, status],
  ).catch(() => {});
}

async function recordFailure(endpointId, status, error) {
  if (!endpointId) return;
  const { rows } = await query(
    `UPDATE webhook_endpoints
        SET last_status = $2, last_error = $3, consecutive_failures = consecutive_failures + 1
      WHERE id = $1 RETURNING mailbox_id, account_id, url, consecutive_failures, disabled_at`,
    [endpointId, status, error ? String(error).slice(0, 300) : null],
  ).catch(() => ({ rows: [] }));
  if (!rows.length || rows[0].disabled_at) return;
  if (rows[0].consecutive_failures < MAX_CONSECUTIVE_FAILURES) return;
  await query(
    `UPDATE webhook_endpoints SET active = false, disabled_at = now(), disabled_reason = $2 WHERE id = $1`,
    [endpointId, `${rows[0].consecutive_failures} deliveries in a row exhausted their retries`],
  ).catch(() => {});
  log.warn('webhook_endpoint.disabled', {
    endpoint_id: endpointId, mailbox_id: rows[0].mailbox_id, account_id: Number(rows[0].account_id),
    url: rows[0].url, consecutive_failures: rows[0].consecutive_failures,
    note: 'switched off after a long run of failures; re-enable it once the receiver is back',
  });
}

/**
 * The `mailbox.webhook_url` alias. Writing it edits the first endpoint, creates
 * one if there is none, and removes it when set to null.
 */
async function setAliasUrl(mailbox, url) {
  const [first] = await listFor(mailbox.id);
  if (!url) {
    if (first) await query(`DELETE FROM webhook_endpoints WHERE id = $1`, [first.id]);
    return null;
  }
  if (!first) return create(mailbox, { url, description: 'default' });
  const { rows } = await query(
    `UPDATE webhook_endpoints SET url = $2, active = true, consecutive_failures = 0,
            disabled_at = NULL, disabled_reason = NULL WHERE id = $1 RETURNING *`,
    [first.id, assertWebhookUrl(url)],
  );
  return rows[0];
}

async function setAliasSecret(mailbox, secret) {
  const [first] = await listFor(mailbox.id);
  if (!first) return null;
  const { rows } = await query(
    `UPDATE webhook_endpoints SET secret = $2 WHERE id = $1 RETURNING *`,
    [first.id, secret || newSecret()],
  );
  return rows[0];
}

module.exports = {
  create, listFor, activeFor, get, update, remove, publicEndpoint,
  recordSuccess, recordFailure, setAliasUrl, setAliasSecret,
  MAX_CONSECUTIVE_FAILURES, newSecret,
};
