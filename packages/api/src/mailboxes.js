'use strict';

const crypto = require('node:crypto');
const { query, tx } = require('./db');
const { config } = require('./config');
const { log } = require('./log');
const ids = require('./ids');
const { validateSchema } = require('./schema');
const { addressFor, aliasFor, slugify } = require('./addresses');
const { ApiError, bad, notFound } = require('./errors');

const MAX_MAILBOXES = Number(process.env.MAX_MAILBOXES_PER_ACCOUNT || 100);

function assertWebhookUrl(url) {
  if (url === undefined || url === null || url === '') return null;
  let parsed;
  try { parsed = new URL(String(url)); } catch {
    throw bad('invalid_webhook_url', `"${url}" is not a URL.`, {
      hint: 'It must be absolute, for example https://example.com/hooks/mailmint.',
      docs: '/docs#webhooks',
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw bad('invalid_webhook_url', `Webhook URLs must be http or https, not "${parsed.protocol}".`, { docs: '/docs#webhooks' });
  }
  return parsed.toString();
}

const publicMailbox = (mb, { includeSecret = false } = {}) => ({
  id: mb.id,
  name: mb.name,
  address: addressFor(mb, config.inboundDomain),
  alias: aliasFor(mb, config.inboundDomain),
  token: mb.token,
  slug: mb.slug,
  schema: mb.schema || [],
  schema_version: mb.schema_version,
  webhook_url: mb.webhook_url,
  ...(includeSecret ? { webhook_secret: mb.webhook_secret } : {}),
  forward_to: mb.forward_to,
  paused: mb.paused,
  created_at: new Date(mb.created_at).toISOString(),
});

async function create(accountId, { name, schema, webhook_url: webhookUrl, forward_to: forwardTo, slug } = {}) {
  const { rows: count } = await query(
    `SELECT count(*)::int AS n FROM mailboxes WHERE account_id = $1 AND deleted_at IS NULL`, [accountId],
  );
  if (count[0].n >= MAX_MAILBOXES) {
    throw new ApiError(409, 'too_many_mailboxes', `This account already has ${count[0].n} mailboxes, which is the limit.`, {
      hint: 'Delete one you are not using, or use +tag sub-addressing to route several senders into one mailbox.',
      docs: '/docs#mailboxes',
    });
  }
  const cleanName = String(name || 'Inbox').trim().slice(0, 80) || 'Inbox';
  const cleanSchema = validateSchema(schema);
  const url = assertWebhookUrl(webhookUrl);
  const id = ids.mailboxId();
  const token = ids.mailboxToken();
  const secret = crypto.randomBytes(24).toString('hex');
  // The slug is a convenience alias; a collision inside one account is not worth
  // an error, so the mailbox simply goes without one.
  let wantedSlug = slugify(slug || cleanName);

  const mb = await tx(async (client) => {
    if (wantedSlug) {
      const { rows } = await client.query(
        `SELECT 1 FROM mailboxes WHERE account_id = $1 AND slug = $2 AND deleted_at IS NULL`, [accountId, wantedSlug],
      );
      if (rows.length) wantedSlug = null;
    }
    const { rows } = await client.query(
      `INSERT INTO mailboxes (id, account_id, token, slug, name, schema, schema_version, webhook_url, webhook_secret, forward_to)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) RETURNING *`,
      [id, accountId, token, wantedSlug, cleanName, JSON.stringify(cleanSchema), url, secret, forwardTo || null],
    );
    await client.query(
      `INSERT INTO mailbox_schema_versions (mailbox_id, version, schema) VALUES ($1, 1, $2)`,
      [id, JSON.stringify(cleanSchema)],
    );
    return rows[0];
  });
  log.info('mailbox.created', {
    mailbox_id: id, account_id: Number(accountId), address: addressFor(mb, config.inboundDomain),
    schema_fields: cleanSchema.length, has_webhook: Boolean(url),
  });
  return mb;
}

async function list(accountId) {
  const { rows } = await query(
    `SELECT * FROM mailboxes WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [accountId],
  );
  return rows;
}

async function get(accountId, id) {
  const { rows } = await query(
    `SELECT * FROM mailboxes WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [id, accountId],
  );
  if (!rows.length) {
    throw notFound('mailbox_not_found', `There is no mailbox "${id}" on this account.`, {
      hint: 'List them with GET /v1/mailboxes. Mailbox ids look like mbx_….',
      docs: '/docs#mailboxes',
    });
  }
  return rows[0];
}

/**
 * A schema change mints a NEW version rather than overwriting the old one.
 *
 * Two things depend on that. A re-parse can be asked to use the schema that was
 * live when a message arrived, which is the only way to reproduce a result from
 * last week. And a user who has just broken their schema can roll back to the
 * one that worked, which they will need within about five minutes of their
 * first edit.
 */
async function update(accountId, id, patch = {}) {
  const mb = await get(accountId, id);
  const sets = [];
  const params = [id];
  let version = mb.schema_version;
  let newSchema = null;

  if (patch.name !== undefined) {
    params.push(String(patch.name).trim().slice(0, 80) || mb.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.schema !== undefined) {
    newSchema = validateSchema(patch.schema);
    version = mb.schema_version + 1;
    params.push(JSON.stringify(newSchema));
    sets.push(`schema = $${params.length}`);
    params.push(version);
    sets.push(`schema_version = $${params.length}`);
  }
  if (patch.webhook_url !== undefined) {
    params.push(assertWebhookUrl(patch.webhook_url));
    sets.push(`webhook_url = $${params.length}`);
  }
  if (patch.webhook_secret !== undefined) {
    const secret = String(patch.webhook_secret || '');
    if (secret && secret.length < 16) {
      throw bad('weak_webhook_secret', 'A webhook secret must be at least 16 characters.', {
        hint: 'Send an empty string to have a fresh 48-character one generated.',
        docs: '/docs#webhooks',
      });
    }
    params.push(secret || crypto.randomBytes(24).toString('hex'));
    sets.push(`webhook_secret = $${params.length}`);
  }
  if (patch.forward_to !== undefined) {
    params.push(patch.forward_to ? String(patch.forward_to).slice(0, 320) : null);
    sets.push(`forward_to = $${params.length}`);
  }
  if (patch.paused !== undefined) {
    params.push(Boolean(patch.paused));
    sets.push(`paused = $${params.length}`);
  }
  if (patch.slug !== undefined) {
    params.push(slugify(patch.slug));
    sets.push(`slug = $${params.length}`);
  }
  if (!sets.length) return mb;

  const updated = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE mailboxes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params,
    );
    if (newSchema) {
      await client.query(
        `INSERT INTO mailbox_schema_versions (mailbox_id, version, schema) VALUES ($1,$2,$3)
         ON CONFLICT (mailbox_id, version) DO UPDATE SET schema = EXCLUDED.schema`,
        [id, version, JSON.stringify(newSchema)],
      );
    }
    return rows[0];
  });
  log.info('mailbox.updated', {
    mailbox_id: id, account_id: Number(accountId), changed: Object.keys(patch),
    schema_version: updated.schema_version,
  });
  return updated;
}

/** Rolls the live schema back to an earlier version, as a new version. */
async function rollback(accountId, id, version) {
  const mb = await get(accountId, id);
  const { rows } = await query(
    `SELECT schema FROM mailbox_schema_versions WHERE mailbox_id = $1 AND version = $2`, [id, version],
  );
  if (!rows.length) {
    throw notFound('schema_version_not_found', `Mailbox ${id} has no schema version ${version}.`);
  }
  // Forward, never backward: the version counter only increases, so a message
  // parsed yesterday still names a version that means what it meant yesterday.
  return update(accountId, mb.id, { schema: rows[0].schema });
}

const versions = (mailboxId) => query(
  `SELECT version, schema, created_at FROM mailbox_schema_versions WHERE mailbox_id = $1 ORDER BY version DESC`,
  [mailboxId],
).then((r) => r.rows);

/**
 * Soft delete. The address stops resolving immediately, but the messages stay
 * readable until their retention runs out — a customer who deletes the wrong
 * mailbox has a few days to notice, and the token is never reissued.
 */
async function remove(accountId, id) {
  const mb = await get(accountId, id);
  await query(`UPDATE mailboxes SET deleted_at = now(), paused = true, slug = NULL WHERE id = $1`, [mb.id]);
  log.info('mailbox.deleted', { mailbox_id: mb.id, account_id: Number(accountId) });
  return { id: mb.id, deleted: true };
}

module.exports = { create, list, get, update, remove, rollback, versions, publicMailbox, assertWebhookUrl, MAX_MAILBOXES };
