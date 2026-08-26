'use strict';

const { log } = require('./log');

/**
 * DKIM for the stateless endpoint.
 *
 * `/v1/parse` used to return `auth: {spf: null, dkim: null, dmarc: null}` on
 * every request, including messages carrying perfectly good signatures. That was
 * not a limitation of the input: DKIM needs the message and DNS and nothing
 * else. It was structural — the verifiers live in `packages/smtpd/src/auth/`,
 * and this endpoint never called them. Meanwhile `/docs#auth` presents `auth` as
 * part of the parse output, so a customer pasting raw MIME had every reason to
 * expect a verdict and silently got nothing.
 *
 * SPF and DMARC stay unavailable here and always will: SPF needs the connecting
 * IP and the SMTP envelope, neither of which exists when someone posts bytes to
 * an HTTP endpoint. Rather than report that as `null` — which reads as "checked,
 * found nothing" — this returns `"unavailable"` with a reason, so the answer is
 * about what we know rather than about what we found.
 *
 * Resolved lazily, like the parser, so a broken sibling package cannot take the
 * whole API down on a path that does not need it.
 */
let cached = null;

function loadVerifier() {
  if (cached) return cached;
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require('../../smtpd/src/auth/dkim.js');
  if (typeof mod.verify !== 'function') throw new Error('dkim module does not export verify(raw, opts)');
  cached = mod.verify;
  return cached;
}

/** True when the DKIM verifier is importable. Reported on /healthz. */
function dkimAvailable() {
  try { loadVerifier(); return true; } catch { return false; }
}

/**
 * The one mapping rule that must match `smtpd/src/auth/index.js`: a body-hash
 * mismatch is `body_altered`, never `fail`. Forwarding is the happy path for
 * this product, and a plain `fail` here becomes `auth_fail:dkim` downstream and
 * drags every forwarded message into needs_review.
 */
function headlineFor(res) {
  return res.bodyAltered ? 'body_altered' : res.result;
}

/**
 * Verifies DKIM over a raw RFC822 buffer.
 *
 * Never throws and never rejects: a DNS timeout or a malformed signature on the
 * sender's side is their infrastructure problem, not a reason to fail someone's
 * parse request. Anything unexpected comes back as `temperror`, which
 * `authFlags()` already treats as "not a failure".
 */
async function verifyRaw(raw, { requestId = null, timeoutMs = 5000 } = {}) {
  const unavailable = {
    spf: 'unavailable', dkim: 'unavailable', dmarc: 'unavailable', spam_score: null,
    reason: 'SPF and DMARC need the SMTP envelope and the connecting IP, which a stateless HTTP request does not carry.',
  };
  if (!Buffer.isBuffer(raw) || !raw.length) return unavailable;

  let verify;
  try { verify = loadVerifier(); } catch (e) {
    log.warn('parse.dkim.unavailable', { request_id: requestId, error: String(e.message || e) });
    return unavailable;
  }

  try {
    const res = await Promise.race([
      verify(raw, { dnsTimeoutMs: timeoutMs }),
      new Promise((resolve) => setTimeout(() => resolve({ result: 'temperror', reason: 'DKIM lookup timed out', signatures: [] }), timeoutMs + 500)),
    ]);
    return {
      spf: 'unavailable',
      dkim: headlineFor(res),
      dmarc: 'unavailable',
      spam_score: null,
      reason: unavailable.reason,
      dkim_details: {
        result: res.result,
        reason: res.reason || null,
        body_altered: Boolean(res.bodyAltered),
        signatures: (res.signatures || []).map((s) => ({
          domain: s.domain, selector: s.selector, result: s.result,
          algorithm: s.algorithm, body_hash_matched: s.bodyHashMatched,
          failure_type: s.failureType || null,
        })),
      },
    };
  } catch (e) {
    log.warn('parse.dkim.failed', { request_id: requestId, error: String(e.message || e) });
    return { ...unavailable, dkim: 'temperror' };
  }
}

module.exports = { verifyRaw, dkimAvailable, headlineFor };
