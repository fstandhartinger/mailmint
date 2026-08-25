'use strict';

const { query } = require('./db');
const { config } = require('./config');
const { renderResult } = require('./messages');

/**
 * The webhook body is byte-for-byte the §1 object that GET /v1/messages/:id
 * returns. One shape, three transports — that promise is only true if there is
 * one function building it, so there is.
 *
 * There is no request to take a host from here, so URLs come from PUBLIC_URL.
 * A deployment with no PUBLIC_URL set emits relative URLs rather than a wrong
 * absolute one; a wrong host in a customer's stored payload is worse than a
 * path they can resolve themselves.
 */
async function buildPayload(messageId) {
  const { rows } = await query(
    `SELECT m.*, mb.id AS mb_id, mb.token, mb.slug, mb.name AS mb_name
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = $1`,
    [messageId],
  );
  if (!rows.length) throw new Error(`message ${messageId} no longer exists`);
  const row = rows[0];
  const mailbox = { id: row.mb_id, token: row.token, slug: row.slug, name: row.mb_name };
  return renderResult(row, mailbox, { base: config.publicUrl });
}

module.exports = { buildPayload };
