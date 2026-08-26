'use strict';
// One call that produces the CONTRACT §1 `auth` block plus the flags of §4.

const { DnsClient } = require('./dns');
const spf = require('./spf');
const dkim = require('./dkim');
const dmarc = require('./dmarc');
const spam = require('./spam');
const { headerFromDomain, headerAddressCount } = require('../address');

/**
 * @param {Buffer} raw          the raw RFC822 message, CRLF line endings
 * @param {object} envelope     { from, to, helo, remote_ip, tls }
 * @param {object} opts         { dns, spfEnabled, dkimEnabled, dmarcEnabled, timeoutMs, spfResult }
 * @returns {Promise<{auth, flags, details, timings_ms}>}
 */
async function authenticate(raw, envelope, opts = {}) {
  const dnsClient = opts.dns || new DnsClient({ servers: opts.dnsServers, timeoutMs: opts.dnsTimeoutMs });
  const t0 = Date.now();
  const parsed = dkim.splitMessage(raw);

  const fromHeaders = parsed.headers.filter((h) => h.lowerName === 'from');
  const fromValue = fromHeaders.length ? fromHeaders[fromHeaders.length - 1].value : null;
  const fromDomain = headerFromDomain(fromValue);
  const fromCount = headerAddressCount(fromValue);

  // --- SPF (may have been computed already at MAIL FROM time) -------------
  let spfRes;
  const tSpf = Date.now();
  if (opts.spfResult) {
    spfRes = opts.spfResult;
  } else if (opts.spfEnabled === false) {
    spfRes = { result: 'none', domain: null, reason: 'spf disabled' };
  } else {
    spfRes = await spf.checkHost({
      ip: envelope.remote_ip,
      helo: envelope.helo,
      mailFrom: envelope.from,
      dns: dnsClient,
      timeoutMs: opts.timeoutMs,
    });
  }
  const spfMs = Date.now() - tSpf;

  // --- DKIM ---------------------------------------------------------------
  const tDkim = Date.now();
  let dkimRes;
  if (opts.dkimEnabled === false) {
    dkimRes = { result: 'none', signatures: [], reason: 'dkim disabled' };
  } else {
    try {
      dkimRes = await dkim.verify(raw, { dns: dnsClient, maxSignatures: opts.maxSignatures ?? 5 });
    } catch (e) {
      dkimRes = { result: 'temperror', signatures: [], reason: e.message };
    }
  }
  const dkimMs = Date.now() - tDkim;

  // --- DMARC --------------------------------------------------------------
  const tDmarc = Date.now();
  let dmarcRes;
  if (opts.dmarcEnabled === false) {
    dmarcRes = { result: 'none', policy: null, reason: 'dmarc disabled', alignment: { spf: false, dkim: false } };
  } else {
    try {
      dmarcRes = await dmarc.evaluate({
        fromDomain, fromCount, spf: spfRes, dkim: dkimRes, dns: dnsClient,
      });
    } catch (e) {
      dmarcRes = { result: 'temperror', policy: null, reason: e.message, alignment: { spf: false, dkim: false } };
    }
  }
  const dmarcMs = Date.now() - tDmarc;

  // --- spam ---------------------------------------------------------------
  const spamRes = spam.score({
    headers: parsed.headers,
    body: parsed.body,
    envelope,
    auth: {
      spf: spfRes.result,
      dkim: dkimRes.result,
      dkimFailureType: dkimRes.failureType || null,
      dkimBodyAltered: Boolean(dkimRes.bodyAltered),
      dmarc: dmarcRes.result,
      dmarcPolicy: dmarcRes.policy,
    },
  });

  const flags = [];
  if (spfRes.result === 'fail') flags.push('auth_fail:spf');
  // Same rule as the headline below, and it has to be applied HERE too: this
  // list is built from the raw verifier result, so a forwarded message was
  // getting BOTH dkim_body_altered and auth_fail:dkim — the headline said "not a
  // failure" while the flags next to it said "authentication failed". Proven on a
  // real Gmail message delivered over port 25 on 2026-08-26.
  if (dkimRes.result === 'fail') {
    flags.push(dkimRes.bodyAltered ? 'dkim_body_altered' : 'auth_fail:dkim');
  }
  if (dmarcRes.result === 'fail') flags.push('auth_fail:dmarc');
  if (spamRes.suspected) flags.push('spam_suspected');

  // A body-hash mismatch is the ONLY thing wrong when a message is forwarded, and
  // forwarding is the happy path for this product. The verifier reports that as
  // result 'fail' with bodyAltered set, but the headline verdict is what
  // authFlags() reads, and a plain 'fail' there becomes auth_fail:dkim and drags
  // the message into needs_review. That is the self-inflicted wound messages.js
  // warns about, so the distinction has to survive into the headline.
  const dkimHeadline = dkimRes.bodyAltered ? 'body_altered' : dkimRes.result;

  return {
    // exactly the CONTRACT §1 shape
    auth: {
      spf: spfRes.result,
      dkim: dkimHeadline,
      dmarc: dmarcRes.result,
      spam_score: spamRes.score,
    },
    flags,
    details: {
      spf: { result: spfRes.result, domain: spfRes.domain, reason: spfRes.reason, lookups: spfRes.lookups },
      dkim: {
        result: dkimRes.result,
        reason: dkimRes.reason,
        // 'body_hash' | 'signature' | 'key' | 'policy' | 'dns' | null
        failure_type: dkimRes.failureType || null,
        // true when the ONLY thing wrong is that the body no longer hashes to
        // what was signed. That is what forwarding, mailing lists and security
        // gateways do; it is not evidence of forgery.
        body_altered: Boolean(dkimRes.bodyAltered),
        signatures: (dkimRes.signatures || []).map((s) => ({
          result: s.result, domain: s.domain, selector: s.selector,
          algorithm: s.algorithm, canonicalization: s.canonicalization,
          keyBits: s.keyBits, weak: s.weak, reason: s.reason,
          failure_type: s.failureType || null,
          body_hash_matched: s.bodyHashMatched,
        })),
      },
      dmarc: {
        result: dmarcRes.result, policy: dmarcRes.policy, disposition: dmarcRes.disposition,
        policyDomain: dmarcRes.policyDomain, alignment: dmarcRes.alignment, reason: dmarcRes.reason,
      },
      spam: spamRes,
      from_domain: fromDomain,
    },
    timings_ms: { spf: spfMs, dkim: dkimMs, dmarc: dmarcMs, total: Date.now() - t0 },
  };
}

/**
 * The Authentication-Results header we stamp on the message (RFC 8601).
 */
function authenticationResultsHeader(hostname, result) {
  const d = (result && result.details) || {};
  if (!d.spf || !d.dkim || !d.dmarc) {
    const a = (result && result.auth) || {};
    return `Authentication-Results: ${hostname}; spf=${a.spf || 'none'}; ` +
      `dkim=${a.dkim || 'none'}; dmarc=${a.dmarc || 'none'}\r\n`;
  }
  const parts = [];
  parts.push(`spf=${d.spf.result}${d.spf.domain ? ` smtp.mailfrom=${d.spf.domain}` : ''}`);
  if (d.dkim.signatures.length) {
    for (const s of d.dkim.signatures) {
      parts.push(`dkim=${s.result}${s.keyBits ? ` (${s.keyBits}-bit key)` : ''}` +
        ` header.d=${s.domain} header.s=${s.selector} header.a=${s.algorithm}`);
    }
  } else {
    parts.push('dkim=none');
  }
  parts.push(`dmarc=${d.dmarc.result}${d.dmarc.policy ? ` (p=${d.dmarc.policy})` : ''}` +
    `${d.from_domain ? ` header.from=${d.from_domain}` : ''}`);
  return `Authentication-Results: ${hostname};\r\n\t${parts.join(';\r\n\t')}\r\n`;
}

/**
 * authenticate() with a hard wall-clock deadline. DNS is the slow part and a
 * pathological resolver must not be able to hold an SMTP session open: past the
 * deadline we report temperror and move on. Mail is never delayed by more than
 * this, and a temperror is honest — it says "ask again", not "this was fine".
 */
async function authenticateWithDeadline(raw, envelope, opts = {}) {
  const budget = opts.deadlineMs ?? ((opts.timeoutMs ?? 10000) * 2);
  let timer;
  // NOT unref'd: while we are deciding, this work must keep the process alive.
  const bail = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budget); });
  try {
    const result = await Promise.race([authenticate(raw, envelope, opts), bail]);
    if (result) return result;
  } catch (e) {
    return degraded(`authentication error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  return degraded(`authentication exceeded its ${budget} ms budget`);
}

function degraded(reason) {
  return {
    auth: { spf: 'temperror', dkim: 'temperror', dmarc: 'temperror', spam_score: 0 },
    flags: [],
    details: {
      spf: { result: 'temperror', domain: null, reason, lookups: 0 },
      dkim: { result: 'temperror', reason, signatures: [] },
      dmarc: { result: 'temperror', policy: null, alignment: { spf: false, dkim: false }, reason },
      spam: { score: 0, raw: 0, suspected: false, reasons: [] },
      from_domain: null,
    },
    timings_ms: {},
  };
}

module.exports = {
  authenticate, authenticateWithDeadline, authenticationResultsHeader,
  spf, dkim, dmarc, spam, DnsClient,
};
