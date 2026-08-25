'use strict';
// A small, explainable spam score in the range 0..10.
// CONTRACT §1: we REPORT this, we never reject on it. Above 6 the pipeline adds
// the `spam_suspected` flag (§4).
//
// Deliberately conservative: authentication carries most of the weight because
// it is the only signal that is hard to forge.

const { orgDomain } = require('./psl');

const SUSPICIOUS_TLDS = new Set([
  'zip', 'mov', 'top', 'xyz', 'click', 'link', 'work', 'gq', 'cf', 'tk', 'ml',
  'buzz', 'rest', 'cam', 'quest', 'monster', 'sbs', 'cfd', 'bond',
]);

const PHRASES = [
  [/\bviagra\b|\bcialis\b/i, 1.5, 'pharma'],
  [/\bcrypto|bitcoin|usdt|binance\b/i, 0.4, 'crypto'],
  [/\b(you (have )?won|winner|lottery|prize claim)\b/i, 1.2, 'lottery'],
  [/\b(wire transfer|western union|bank transfer urgent)\b/i, 1.0, 'wire'],
  [/\b(nigerian?|inheritance|next of kin|beneficiary fund)\b/i, 1.0, 'advance-fee'],
  [/\b(verify your account|confirm your password|account (will be )?suspended)\b/i, 1.2, 'phish'],
  [/\b(click here (now|immediately)|act now|limited time offer|risk[- ]free)\b/i, 0.6, 'urgency'],
  [/\b(no obligation|money[- ]back guarantee|100% (free|satisfied))\b/i, 0.5, 'marketing'],
  [/\b(unsubscribe|opt[- ]out)\b/i, -0.3, 'has-unsubscribe'],
];

function headerMap(headers) {
  const m = new Map();
  for (const h of headers) {
    const v = h.value.replace(/\r\n[ \t]+/g, ' ').trim();
    if (!m.has(h.lowerName)) m.set(h.lowerName, []);
    m.get(h.lowerName).push(v);
  }
  return m;
}

/**
 * @param {object} o
 * @param {Array}  o.headers   from dkim.splitMessage()
 * @param {string} o.body      raw body (latin1 view is fine)
 * @param {object} o.auth      { spf, dkim, dmarc, dmarcPolicy }
 * @param {object} o.envelope  { from, helo, remote_ip, tls }
 * @returns {{score:number, reasons:[{rule, points}]}}
 */
function score(o) {
  const reasons = [];
  let s = 0;
  const add = (points, rule) => { if (points) { s += points; reasons.push({ rule, points: round(points) }); } };

  const H = headerMap(o.headers || []);
  const first = (n) => (H.get(n) ? H.get(n)[0] : null);
  const auth = o.auth || {};

  // ---- authentication (the heavy signals) --------------------------------
  switch (auth.spf) {
    case 'fail': add(2.0, 'spf=fail'); break;
    case 'softfail': add(1.0, 'spf=softfail'); break;
    case 'none': add(0.8, 'spf=none'); break;
    case 'permerror': add(0.5, 'spf=permerror'); break;
    case 'temperror': add(0.2, 'spf=temperror'); break;
    case 'pass': add(-0.5, 'spf=pass'); break;
    default: break;
  }
  switch (auth.dkim) {
    case 'fail':
      // A body-hash failure means an intermediary rewrote the body. Every
      // forwarded message, every mailing list and every corporate security
      // gateway does that, and half our users will forward mail to us from
      // Gmail. Charging it as spam would punish our own happy path. A failure
      // of the SIGNATURE, on the other hand, is somebody claiming a domain
      // they cannot sign for, and that stays expensive.
      if (auth.dkimBodyAltered || auth.dkimFailureType === 'body_hash') {
        add(0, 'dkim=fail (body altered in transit, not charged)');
      } else {
        add(1.5, 'dkim=fail');
      }
      break;
    case 'none': add(0.8, 'dkim=none'); break;
    case 'permerror': add(0.5, 'dkim=permerror'); break;
    case 'pass': add(-0.5, 'dkim=pass'); break;
    default: break;
  }
  if (auth.dmarc === 'fail') {
    add(auth.dmarcPolicy === 'reject' ? 3.0 : auth.dmarcPolicy === 'quarantine' ? 2.0 : 1.2,
      `dmarc=fail p=${auth.dmarcPolicy || 'none'}`);
  } else if (auth.dmarc === 'pass') {
    add(-1.0, 'dmarc=pass');
  }

  // ---- transport ---------------------------------------------------------
  if (o.envelope && o.envelope.tls === false) add(0.5, 'no-tls');
  if (o.envelope && o.envelope.helo) {
    const helo = String(o.envelope.helo).toLowerCase();
    if (/^\[?\d{1,3}(\.\d{1,3}){3}\]?$/.test(helo)) add(0.6, 'helo-is-bare-ip');
    else if (!helo.includes('.')) add(0.8, 'helo-not-fqdn');
    else if (/^(localhost|localdomain|friend|user|pc|desktop)\b/.test(helo)) add(1.0, 'helo-generic');
  }

  // ---- headers -----------------------------------------------------------
  if (!first('message-id')) add(1.0, 'no-message-id');
  else if (!/^<[^>]+@[^>]+>$/.test(first('message-id'))) add(0.4, 'malformed-message-id');
  if (!first('date')) add(0.6, 'no-date');
  else {
    const d = Date.parse(first('date'));
    if (Number.isNaN(d)) add(0.4, 'unparseable-date');
    else {
      const skew = Math.abs(Date.now() - d);
      if (skew > 30 * 24 * 3600e3) add(0.5, 'date-skew>30d');
    }
  }
  if (!first('from')) add(1.5, 'no-from');
  if ((H.get('from') || []).length > 1) add(1.5, 'multiple-from-headers');
  if ((H.get('subject') || []).length > 1) add(1.0, 'multiple-subject-headers');

  const subject = first('subject') || '';
  if (/^\s*$/.test(subject)) add(0.3, 'empty-subject');
  const letters = subject.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) add(0.6, 'shouting-subject');
  if ((subject.match(/[!]/g) || []).length >= 3) add(0.4, 'exclamation-storm');
  if (/[Ѐ-ӿ]/.test(subject) && /[A-Za-z]/.test(subject)) add(0.5, 'mixed-script-subject');
  if (/^(re|fwd?):/i.test(subject) && !first('in-reply-to') && !first('references')) {
    add(0.5, 'fake-reply-subject');
  }

  // envelope-from vs header-from mismatch (only meaningful without DMARC pass)
  const fromHeader = first('from') || '';
  const fh = fromHeader.match(/<([^>]+)>/);
  const headerFrom = (fh ? fh[1] : fromHeader).trim().toLowerCase();
  const envFrom = ((o.envelope && o.envelope.from) || '').toLowerCase();
  if (envFrom && headerFrom.includes('@')) {
    const a = orgDomain(envFrom.split('@').pop());
    const b = orgDomain(headerFrom.split('@').pop());
    if (a && b && a !== b && auth.dmarc !== 'pass') add(0.7, 'envelope/header from mismatch');
  }
  // display name that looks like a different address ("PayPal <x@evil.tld>")
  const display = fromHeader.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  if (/@/.test(display) && fh && !display.toLowerCase().includes(headerFrom)) {
    add(1.2, 'display-name-spoofs-address');
  }

  if (first('x-priority') === '1' || /^high$/i.test(first('importance') || '')) add(0.2, 'high-priority');
  if (first('precedence') && /bulk|junk/i.test(first('precedence'))) add(0.3, 'precedence-bulk');
  if (first('x-spam-flag') && /^yes$/i.test(first('x-spam-flag'))) add(2.5, 'upstream-x-spam-flag');
  if (!first('received')) add(0.5, 'no-received-chain');
  if (first('bcc')) add(0.4, 'bcc-header-present');
  if ((first('to') || '').toLowerCase() === 'undisclosed-recipients:;') add(0.5, 'undisclosed-recipients');

  // ---- body --------------------------------------------------------------
  const body = String(o.body || '');
  const sample = body.length > 200000 ? body.slice(0, 200000) : body;
  for (const [re, points, name] of PHRASES) {
    if (re.test(subject) || re.test(sample)) add(points, `body:${name}`);
  }
  const urls = sample.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  if (urls.length > 40) add(0.6, 'many-urls');
  let shorteners = 0, ipUrls = 0, oddTld = 0;
  for (const u of urls.slice(0, 200)) {
    let host;
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (/^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy)$/.test(host)) shorteners++;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ipUrls++;
    const tld = host.split('.').pop();
    if (SUSPICIOUS_TLDS.has(tld)) oddTld++;
  }
  if (shorteners) add(Math.min(1.0, 0.4 * shorteners), 'url-shorteners');
  if (ipUrls) add(Math.min(1.5, 0.8 * ipUrls), 'bare-ip-urls');
  if (oddTld) add(Math.min(1.2, 0.4 * oddTld), 'suspicious-tld-urls');

  // html-only mail with no text alternative is mildly spammy
  const ctype = (first('content-type') || '').toLowerCase();
  if (/^text\/html/.test(ctype)) add(0.3, 'html-only');
  if (/<script|onerror=|onload=/i.test(sample)) add(1.2, 'script-in-body');
  if (/style=["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(sample)) add(0.6, 'hidden-text');

  const visible = sample.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (visible.length < 15 && (urls.length > 0 || /<img/i.test(sample))) add(0.8, 'image-or-link-only');

  const clamped = Math.max(0, Math.min(10, s));
  return {
    score: round(clamped),
    raw: round(s),
    suspected: clamped > 6,
    reasons: reasons.sort((a, b) => b.points - a.points),
  };
}

function round(n) { return Math.round(n * 100) / 100; }

module.exports = { score };
