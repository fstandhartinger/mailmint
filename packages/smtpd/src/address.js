'use strict';
// SMTP address / path parsing and MailMint mailbox-token extraction.
// CONTRACT §0: token is 12 chars, Crockford base32 lowercase (no i/l/o/u).
// Routable forms:  <token>@domain        <slug>.<token>@domain
//                  <token>+tag@domain    <slug>.<token>+tag@domain

// Crockford base32 alphabet, lowercased: 0-9 a b c d e f g h j k m n p q r s t v w x y z
const TOKEN_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
const TOKEN_LEN = 12;
// A slug is a human alias. Keep it conservative: letters, digits, - and _.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Domain labels. Non-ASCII is allowed so SMTPUTF8 / U-label domains survive; we
// never *route* on a non-ASCII domain (inboundDomains are ASCII) but MAIL FROM may use one.
const LABEL_CHAR = '[a-z0-9\\u0080-\\uffff]';
const LABEL_MID = '[a-z0-9\\u0080-\\uffff-]';
const DOMAIN_RE = new RegExp(
  `^(?=.{1,253}$)(?:${LABEL_CHAR}(?:${LABEL_MID}{0,61}${LABEL_CHAR})?\\.)+` +
  `[a-z\\u0080-\\uffff](?:${LABEL_MID}{0,61}[a-z0-9\\u0080-\\uffff])?$`
);

// Crockford decoding treats o/O as 0 and i/I/l/L as 1. A *valid* token can never
// contain o, i or l, so folding them in is lossless and it forgives human typos.
function normaliseToken(s) {
  return s.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
}

/**
 * Parse the <path> out of a `MAIL FROM:` / `RCPT TO:` argument.
 * Returns { address, params } or null when the syntax is bad.
 * `address` is '' for the null reverse-path <>.
 */
function parsePath(arg, { allowNull = false } = {}) {
  if (typeof arg !== 'string') return null;
  // Some clients send `MAIL FROM: <a@b>` with a space. RFC forbids it; the world does it.
  const s = arg.replace(/^\s+/, '');
  if (!s.startsWith('<')) return null;
  let i = 1;
  let inQuote = false;
  let out = '';
  for (; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\') {
        if (i + 1 >= s.length) return null;
        out += c + s[++i];
        continue;
      }
      if (c === '"') { inQuote = false; out += c; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inQuote = true; out += c; continue; }
    if (c === '>') break;
    if (c === '<') return null;
    out += c;
  }
  if (inQuote || i >= s.length || s[i] !== '>') return null;
  const rest = s.slice(i + 1);

  // RFC 5321 §4.1.2: a source route (@a,@b:user@d) MUST be accepted and ignored.
  if (out.startsWith('@')) {
    const colon = out.indexOf(':');
    if (colon === -1) return null;
    out = out.slice(colon + 1);
  }

  const params = parseParams(rest);
  if (params === null) return null;
  if (out === '') {
    if (!allowNull) return null;
    return { address: '', params };
  }
  return { address: out, params };
}

function parseParams(rest) {
  const params = Object.create(null);
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) params[p.toUpperCase()] = true;
    else params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return params;
}

/** Split an addr-spec into { local, domain }; null when malformed. */
function splitAddress(address) {
  if (typeof address !== 'string' || address.length === 0 || address.length > 320) return null;
  // Find the LAST unquoted '@'.
  let inQuote = false;
  let at = -1;
  for (let i = 0; i < address.length; i++) {
    const c = address[i];
    if (c === '\\' && inQuote) { i++; continue; }
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === '@' && !inQuote) at = i;
  }
  if (at <= 0 || at === address.length - 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();
  if (local.length > 64) return null;
  if (domain.startsWith('[')) {
    // address literal — legal for MAIL FROM, never one of our inbound domains
    if (!domain.endsWith(']')) return null;
    return { local, domain };
  }
  if (!DOMAIN_RE.test(domain)) return null;
  return { local, domain };
}

/**
 * Decide whether a recipient is routable to a MailMint mailbox.
 * @param {string} address  addr-spec (no angle brackets)
 * @param {string[]} inboundDomains  domains we are authoritative for
 * @returns {{ok:true, token, slug, tag, local, domain, address}} |
 *          {ok:false, reason:'syntax'|'relay'|'form'}
 */
function routeRecipient(address, inboundDomains) {
  const parts = splitAddress(address);
  if (!parts) return { ok: false, reason: 'syntax' };
  const { domain } = parts;
  if (!inboundDomains.includes(domain)) return { ok: false, reason: 'relay', domain };

  let local = parts.local;
  if (local.startsWith('"') && local.endsWith('"') && local.length >= 2) {
    local = local.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  local = local.toLowerCase();

  // strip +tag (first plus wins, everything after is the tag)
  let tag = null;
  const plus = local.indexOf('+');
  if (plus !== -1) {
    tag = local.slice(plus + 1);
    local = local.slice(0, plus);
  }

  let slug = null;
  let tokenPart = local;
  const dot = local.lastIndexOf('.');
  if (dot !== -1) {
    slug = local.slice(0, dot);
    tokenPart = local.slice(dot + 1);
    if (!SLUG_RE.test(slug)) return { ok: false, reason: 'form' };
  }
  if (tokenPart.length !== TOKEN_LEN) return { ok: false, reason: 'form' };
  const token = normaliseToken(tokenPart);
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'form' };

  return {
    ok: true,
    token,
    slug,
    tag,
    local: parts.local,
    domain,
    address: `${token}@${domain}`,          // canonical mailbox address
    original: `${parts.local}@${domain}`,
  };
}

/** Very small header-address parser, used for the DMARC From: domain. */
function headerFromDomain(headerValue) {
  if (!headerValue) return null;
  let v = String(headerValue).replace(/\r?\n[ \t]+/g, ' ').trim();
  // take the last <...> if present
  const m = v.match(/<([^<>]*)>\s*$/);
  if (m) v = m[1];
  else v = v.split(/[,;]/)[0].trim();
  const parts = splitAddress(v.trim());
  return parts ? parts.domain : null;
}

/** Count comma-separated addresses in a From: header (DMARC: >1 is a fail). */
function headerAddressCount(headerValue) {
  if (!headerValue) return 0;
  const v = String(headerValue).replace(/\r?\n[ \t]+/g, ' ');
  let depth = 0, inQuote = false, n = 1;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inQuote) { if (c === '\\') i++; else if (c === '"') inQuote = false; continue; }
    if (c === '"') inQuote = true;
    else if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

module.exports = {
  TOKEN_RE, TOKEN_LEN, DOMAIN_RE, SLUG_RE,
  parsePath, parseParams, splitAddress, routeRecipient, normaliseToken,
  headerFromDomain, headerAddressCount,
};
