'use strict';

/**
 * The provider interface.
 *
 * Everything below the connector is a *source of raw RFC822 with a cursor*.
 * Two real implementations exist (IMAP over a socket, mail.tm over HTTPS) and
 * they were written together on purpose: an abstraction proven by exactly one
 * implementation is not an abstraction, it is a rename.
 *
 *   kind            'imap' | 'mailtm'
 *   id              stable identifier for logs
 *   capabilities    { push: bool }   — push means waitForChange() can block
 *                                      cheaply instead of sleeping
 *
 *   async open()                       connect + authenticate + select
 *   async list({sinceCursor, limit, resync})
 *        -> { validity, items: [Item], more }
 *        Items are ASCENDING by cursor. `validity` identifies the generation of
 *        the cursor space; when it changes, every stored cursor is meaningless.
 *   async fetch(item)   -> { raw: Buffer, size, truncated }
 *   async identify(items)              fill item.messageId as cheaply as possible
 *   async acknowledge(items)           mark seen / whatever the source calls it
 *   async waitForChange({maxMs})       -> { reason: 'update'|'timeout'|'poll' }
 *   async close()
 *
 *   Item = { key, cursor, size, receivedAt, from, subject, messageId? }
 *     key     dedupe identity within one validity generation
 *     cursor  opaque to the connector; only ever compared by the provider
 */

const { ImapProvider } = require('./imap');
const { MailTmProvider } = require('./mailtm');

const REGISTRY = { imap: ImapProvider, mailtm: MailTmProvider };

function createProvider(conf, deps = {}) {
  const kind = (conf.provider || conf.kind || 'imap').toLowerCase();
  const Klass = REGISTRY[kind];
  if (!Klass) {
    throw new Error(`unknown provider "${kind}"; known providers are ${Object.keys(REGISTRY).join(', ')}`);
  }
  return new Klass(conf, deps);
}

module.exports = { createProvider, REGISTRY, ImapProvider, MailTmProvider };
