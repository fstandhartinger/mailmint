'use strict';

const { isMailboxToken } = require('./ids');

/**
 * Turns a recipient address into the mailbox token it routes to.
 *
 * The contract gives three spellings of the same mailbox, and all three have to
 * land on one row:
 *   k7m2xq4h9bwz@domain            the canonical form
 *   invoices.k7m2xq4h9bwz@domain   a human slug in front of it
 *   k7m2xq4h9bwz+anything@domain   sub-addressing, so a sender can tag mail
 *
 * The token is always the last dot-separated label of the local part with any
 * `+tag` removed. Putting the token last rather than first means the slug can
 * contain dots without the parse becoming ambiguous.
 */
function tokenFromAddress(address) {
  const raw = String(address || '').trim().replace(/^<|>$/g, '');
  const at = raw.lastIndexOf('@');
  if (at < 1) return null;
  const domain = raw.slice(at + 1).toLowerCase();
  let local = raw.slice(0, at).toLowerCase();
  const plus = local.indexOf('+');
  const tag = plus >= 0 ? local.slice(plus + 1) : null;
  if (plus >= 0) local = local.slice(0, plus);
  const labels = local.split('.').filter(Boolean);
  const token = labels.length ? labels[labels.length - 1] : null;
  if (!isMailboxToken(token)) return null;
  return { token, slug: labels.length > 1 ? labels.slice(0, -1).join('.') : null, tag, domain, address: raw.toLowerCase() };
}

/** The address a mailbox publishes, which is what the dashboard shows people. */
const addressFor = (mailbox, domain) => `${mailbox.token}@${domain}`;

/** The prettier alias, when the mailbox has a slug. */
const aliasFor = (mailbox, domain) => (mailbox.slug ? `${mailbox.slug}.${mailbox.token}@${domain}` : null);

/**
 * A slug is a display convenience, not an identifier: it is lowercased, spaces
 * become dashes, and anything else is dropped so it can never introduce a dot
 * that changes which label is the token.
 */
function slugify(name) {
  const s = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || null;
}

module.exports = { tokenFromAddress, addressFor, aliasFor, slugify };
