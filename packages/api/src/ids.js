'use strict';

const crypto = require('node:crypto');

/**
 * Crockford base32, lowercase, with i/l/o/u removed — the alphabet the contract
 * names for mailbox tokens. Ambiguous characters are the whole point: a token
 * ends up hand-typed into an email client, so `1` and `l` must not both exist.
 */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

function randomBase32(n) {
  // Rejection-free because 32 divides 256 exactly, so masking 5 bits is uniform.
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i += 1) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/**
 * ULID-ish: 48 bits of millisecond timestamp then 80 bits of randomness, both
 * in Crockford base32. Lexical order equals time order, which is what makes
 * `ORDER BY id` a valid substitute for `ORDER BY received_at` and what lets a
 * cursor be a plain string comparison.
 */
function ulid(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + randomBase32(16);
}

const messageId = () => `msg_${ulid()}`;
const mailboxId = () => `mbx_${ulid()}`;
const attachmentId = () => `att_${ulid()}`;
const deliveryId = () => `dlv_${ulid()}`;
const blobRef = () => `blb_${ulid()}`;
const requestId = () => `req_${randomBase32(16)}`;

/** 12 chars, per the contract. 32^12 ≈ 1.2e18, so guessing one is not a threat model. */
const mailboxToken = () => randomBase32(12);

const isMailboxToken = (s) => typeof s === 'string' && /^[0-9a-hjkmnp-tv-z]{12}$/.test(s);

module.exports = {
  ulid, messageId, mailboxId, attachmentId, deliveryId, blobRef, requestId,
  mailboxToken, isMailboxToken, randomBase32, CROCKFORD,
};
