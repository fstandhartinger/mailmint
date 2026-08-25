'use strict';

const { query } = require('./db');
const { log } = require('./log');
const messages = require('./messages');
const webhooks = require('./webhooks');

/**
 * Everything that happens to a message AFTER it is safely on disk: parse it,
 * emit the event a poller will see, queue the webhook.
 *
 * Kept apart from the HTTP layer because three callers need exactly this and
 * must not drift: /internal/deliver (asynchronously), POST /v1/test/deliver
 * (synchronously, so the dashboard can show a result) and the reparse endpoint.
 *
 * It never throws at its callers. A parse that fails has already marked the
 * message `failed` and stored its input for replay; making the SMTP session or
 * the dashboard fail on top of that helps nobody.
 */
async function processMessage(message, opts = {}) {
  const type = opts.eventType || 'message.parsed';
  try {
    const out = await messages.parseStored(message, opts);
    await messages.emitEvent(null, {
      accountId: out.message.account_id,
      mailboxId: out.message.mailbox_id,
      type,
      messageId: out.message.id,
    });
    if (opts.deliver !== false && out.mailbox.webhook_url && !out.mailbox.paused) {
      await webhooks.enqueue({
        messageId: out.message.id,
        accountId: out.message.account_id,
        url: out.mailbox.webhook_url,
      });
    }
    return out;
  } catch (e) {
    log.error('pipeline.failed', { message_id: message.id, error: String(e.message || e) });
    // The message row survives with status 'failed', so it is still listed, still
    // fetchable, and still re-parsable once the cause is fixed.
    await messages.emitEvent(null, {
      accountId: message.account_id,
      mailboxId: message.mailbox_id,
      type: 'message.failed',
      messageId: message.id,
    }).catch(() => {});
    return { error: e };
  }
}

/** Fire-and-forget wrapper for the ingest path, which must return before this finishes. */
function processInBackground(message, opts = {}) {
  setImmediate(() => {
    log.withRequestId(opts.requestId || null, () => {
      processMessage(message, opts).catch((e) => log.error('pipeline.unhandled', { message_id: message.id, error: String(e) }));
    });
  });
}

/** Loads a message row by id, scoped to an account when one is given. */
async function loadMessage(id, accountId = null) {
  const { rows } = await query(
    accountId
      ? `SELECT * FROM messages WHERE id = $1 AND account_id = $2`
      : `SELECT * FROM messages WHERE id = $1`,
    accountId ? [id, accountId] : [id],
  );
  return rows[0] || null;
}

module.exports = { processMessage, processInBackground, loadMessage };
