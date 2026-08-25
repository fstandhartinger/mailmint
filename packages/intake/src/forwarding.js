'use strict';

/**
 * "I'll just forward my mail to MailMint."
 *
 * Every provider answers that with a confirmation email containing a code and a
 * link, sent to the *destination* address — i.e. to us. The user then has to go
 * digging in a dashboard they cannot see. Mailparser and Parseur both make you
 * hunt for it; surfacing it automatically is a small, real onboarding win and
 * costs one detector.
 *
 * Detection is deliberately layered:
 *   1. a per-provider rule (sender + subject + code/link shape) — high confidence
 *   2. a generic rule (any mail that says "forward" and "confirm" and has a
 *      code or a verification link) — lower confidence, still surfaced
 *
 * Security note: this is attacker-reachable. Anyone can send a mailbox a mail
 * that looks like a Gmail confirmation with a link to somewhere unpleasant, and
 * the whole point of this feature is that a human then clicks the link. So the
 * link's host is checked against the provider's own domains, and anything else
 * is returned with link_trusted:false for the dashboard to render as a warning
 * rather than a button.
 */

const { summarise, extractText, htmlToText, allAddresses } = require('./mime-lite');

const PROVIDERS = [
  {
    id: 'gmail',
    name: 'Gmail',
    from: [/(^|[<@.])forwarding-noreply@google\.com>?$/i, /@google\.com>?$/i],
    subject: [/gmail forwarding confirmation/i, /\(#\d{6,12}\).*forward/i],
    // Gmail's code is the same number that appears in the subject as (#nnnnnnnnn)
    code: [/\(#(\d{6,12})\)/, /confirmation code[:\s]+(\d{5,12})/i],
    link: [/https:\/\/mail\.google\.com\/mail\/[^\s"'<>]*vf-[^\s"'<>]*/i, /https:\/\/mail\.google\.com\/[^\s"'<>]+/i],
    hosts: ['mail.google.com', 'accounts.google.com'],
    who: [/receive mail from ([^\s<>]+@[^\s<>]+)/i, /forward mail from ([^\s<>]+@[^\s<>]+)/i],
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    from: [/@(outlook|hotmail|live|microsoft|microsoftonline)\.com>?$/i, /postmaster@/i],
    subject: [/verify your (forwarding|email) address/i, /confirm your (forwarding|email) address/i, /forwarding/i],
    code: [/(?:security|confirmation|verification) code[:\s]+([A-Z0-9][A-Z0-9-]{3,11})/i, /\b(\d{6,9})\b(?=[^\d]{0,40}code)/i],
    link: [/https:\/\/account\.live\.com\/[^\s"'<>]+/i, /https:\/\/[a-z0-9.-]*outlook\.(com|live\.com)\/[^\s"'<>]*verif[^\s"'<>]*/i],
    hosts: ['account.live.com', 'outlook.live.com', 'outlook.com', 'account.microsoft.com'],
    who: [/from ([^\s<>]+@[^\s<>]+)/i],
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    from: [/@zoho(mail)?\.(com|eu|in)>?$/i],
    subject: [/email forward(ing)? (confirmation|verification)/i, /confirm.*forward/i, /zoho mail.*(verif|confirm)/i],
    code: [/confirmation code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i, /verification code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i],
    link: [/https:\/\/(mail|accounts)\.zoho\.(com|eu|in)\/[^\s"'<>]+/i],
    hosts: ['mail.zoho.com', 'accounts.zoho.com', 'mail.zoho.eu', 'accounts.zoho.eu', 'mail.zoho.in'],
    who: [/from ([^\s<>]+@[^\s<>]+)/i],
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    from: [/@(fastmail|messagingengine)\.(com|fm)>?$/i],
    subject: [/confirm.*(forward|email address)/i, /verify.*(forward|email address)/i],
    code: [/confirmation code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i, /\bcode\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i],
    link: [/https:\/\/(www\.|app\.)?fastmail\.(com|fm)\/[^\s"'<>]*(verify|confirm)[^\s"'<>]*/i, /https:\/\/(www\.|app\.)?fastmail\.(com|fm)\/[^\s"'<>]+/i],
    hosts: ['www.fastmail.com', 'app.fastmail.com', 'fastmail.com', 'fastmail.fm'],
    who: [/from ([^\s<>]+@[^\s<>]+)/i],
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    from: [/@(icloud|apple|email\.apple)\.com>?$/i],
    subject: [/verify.*(email|forward)/i, /confirm.*(email|forward)/i],
    code: [/\b(\d{6})\b/],
    link: [/https:\/\/[a-z0-9.-]*apple\.com\/[^\s"'<>]+/i],
    hosts: ['appleid.apple.com', 'icloud.com', 'www.icloud.com'],
    who: [/from ([^\s<>]+@[^\s<>]+)/i],
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    from: [/@(yahoo|yahooinc)\.(com|co\.[a-z]{2}|de|fr)>?$/i],
    subject: [/verify.*(email|forward)/i, /confirm.*(email|forward)/i],
    code: [/verification code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,11})/i, /\b(\d{6,9})\b/],
    link: [/https:\/\/[a-z0-9.-]*yahoo\.com\/[^\s"'<>]+/i],
    hosts: ['login.yahoo.com', 'mail.yahoo.com', 'edit.yahoo.com'],
    who: [/from ([^\s<>]+@[^\s<>]+)/i],
  },
];

const GENERIC_CODE = [
  /confirmation code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i,
  /verification code\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/i,
  /\bcode\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})\b/i,
  /\(#(\d{6,12})\)/,
];
const GENERIC_LINK = /https?:\/\/[^\s"'<>]*(?:verif|confirm|activate|vf-)[^\s"'<>]*/i;
const FORWARD_HINT = /(forward(ing)?\s+(confirmation|request|verification)|confirm.*forward|verify.*forward|receive mail from)/i;

function firstMatch(patterns, text) {
  for (const re of patterns || []) {
    const m = re.exec(text);
    // Codes are captured; strip a trailing separator that the character class
    // may have swallowed ("Code: FM-7C2K9." -> "FM-7C2K9").
    if (m) return (m[1] !== undefined ? m[1] : m[0]).replace(/[-.:;,]+$/, '');
  }
  return null;
}

/** Like firstMatch but always the whole match — link patterns group alternatives. */
function firstWhole(patterns, text) {
  for (const re of patterns || []) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

function anyMatch(patterns, text) {
  return (patterns || []).some((re) => re.test(text));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Pulls every http(s) URL out of the plain text and the HTML hrefs. */
function collectLinks(plain, html) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  let m;
  while ((m = re.exec(plain))) out.push(m[0].replace(/[.,;:]+$/, ''));
  const hre = /href\s*=\s*["']([^"']+)["']/gi;
  while ((m = hre.exec(html || ''))) if (/^https?:/i.test(m[1])) out.push(m[1].replace(/&amp;/g, '&'));
  return [...new Set(out)];
}

/**
 * @param {Buffer|string|object} input raw RFC822, or an already-summarised message
 * @returns {object|null} a detection, or null when this is ordinary mail
 */
function detect(input) {
  let sum;
  let bodies;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    sum = summarise(raw);
    bodies = extractText(raw);
  } else {
    sum = input.summary || input;
    bodies = { text: [input.text || ''], html: [input.html || ''] };
  }

  const fromHeader = (sum.headers && sum.headers.from && sum.headers.from[0]) || sum.from || '';
  const subject = sum.subject || '';
  const plainRaw = (bodies.text || []).join('\n');
  const htmlRaw = (bodies.html || []).join('\n');
  const plain = plainRaw || htmlToText(htmlRaw);
  const haystack = `${subject}\n${plain}\n${htmlToText(htmlRaw)}`;
  const links = collectLinks(`${plain}\n${htmlToText(htmlRaw)}`, htmlRaw);

  let rule = null;
  let score = 0;
  for (const p of PROVIDERS) {
    let s = 0;
    if (anyMatch(p.from, fromHeader)) s += 2;
    if (anyMatch(p.subject, subject)) s += 2;
    if (FORWARD_HINT.test(haystack)) s += 1;
    if (s > score) { score = s; rule = p; }
  }

  const looksLikeForwarding = FORWARD_HINT.test(haystack) || /forward/i.test(subject);
  // A provider match on sender alone is not enough — Gmail sends plenty of mail.
  if (!(score >= 3 || (looksLikeForwarding && (GENERIC_LINK.test(haystack) || firstMatch(GENERIC_CODE, haystack))))) {
    return null;
  }

  const code = (rule && firstMatch(rule.code, haystack)) || firstMatch(GENERIC_CODE, haystack);
  let link = rule ? firstWhole(rule.link, `${plain}\n${htmlRaw}`) : null;
  if (!link) {
    link = links.find((u) => /verif|confirm|activate|vf-/i.test(u))
      || (rule ? links.find((u) => rule.hosts.includes(hostOf(u))) : null)
      || null;
  }
  if (link) link = link.replace(/&amp;/g, '&').replace(/[.,;:]+$/, '');

  const host = link ? hostOf(link) : null;
  const trusted = !!(rule && host && rule.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  const requester = rule ? firstMatch(rule.who, haystack) : null;

  const confidence = Math.min(1, (score >= 4 ? 0.95 : score === 3 ? 0.8 : 0.55)
    + (code ? 0.03 : -0.1) + (trusted ? 0.02 : -0.05));

  return {
    detected: true,
    provider: rule ? rule.id : 'generic',
    provider_name: rule ? rule.name : 'Unknown provider',
    confidence: Math.round(Math.max(0, confidence) * 100) / 100,
    code: code || null,
    link: link || null,
    link_host: host,
    link_trusted: trusted,
    links: links.slice(0, 10),
    forward_from: requester ? requester.toLowerCase() : (allAddresses(fromHeader)[0] || null),
    forwarded_to: (sum.to && sum.to[0]) || null,
    subject,
    from: sum.from || null,
    message_id: sum.messageId || null,
    date: sum.date || null,
    action: link
      ? (trusted ? 'click_link' : 'click_link_untrusted_host')
      : (code ? 'enter_code' : 'manual'),
    instructions: buildInstructions(rule ? rule.id : 'generic', code, link, trusted),
  };
}

function buildInstructions(providerId, code, link, trusted) {
  const where = {
    gmail: 'Gmail → Settings → See all settings → Forwarding and POP/IMAP',
    outlook: 'Outlook.com → Settings → Mail → Forwarding',
    zoho: 'Zoho Mail → Settings → Mail Accounts → Email Forwarding',
    fastmail: 'Fastmail → Settings → Forwarding',
    icloud: 'iCloud Mail → Settings → Forward my email to',
    yahoo: 'Yahoo Mail → Settings → Mailboxes → Forwarding',
    generic: 'your mail provider\'s forwarding settings',
  }[providerId] || 'your mail provider\'s forwarding settings';
  if (link && trusted) return `Click the confirmation link to finish setting up forwarding${code ? `, or paste code ${code} into ${where}` : ''}.`;
  if (link) return `A confirmation link was found but it does not point at ${providerId}. Do not click it unless you recognise the host. ${code ? `The code is ${code}; enter it in ${where}.` : ''}`.trim();
  if (code) return `Enter confirmation code ${code} in ${where}.`;
  return `This looks like a forwarding confirmation but no code or link could be extracted. Open the message and follow the instructions in ${where}.`;
}

/**
 * Scans a provider's recent mail for confirmations without delivering anything.
 * This is what the dashboard's "I set up forwarding, where's my code?" button
 * calls, and what the CLI's `scan-forwarding` runs.
 */
async function scan(provider, { limit = 25 } = {}) {
  const { items } = await provider.list({ sinceCursor: null, limit, resync: true, tail: true });
  const found = [];
  for (const item of items) {
    const { raw, skipped } = await provider.fetch(item);
    if (!raw || skipped) continue;
    const d = detect(raw);
    if (d) found.push({ ...d, source_key: item.key, received_at: item.receivedAt });
  }
  return found;
}

/**
 * Publishes a detection so the dashboard can render it.
 *
 * The endpoint does not exist in packages/api yet, so a 404 is reported, not
 * thrown: the connector must not stop delivering mail because a nice-to-have
 * side channel is missing. Until it lands, the same object also rides along on
 * POST /internal/deliver as `forwarding_confirmation`.
 */
async function publish(detection, { apiUrl, secret, mailboxToken, timeoutMs = 15000 }) {
  const { request } = require('./http');
  try {
    const r = await request(`${String(apiUrl).replace(/\/$/, '')}/internal/forwarding-confirmation`, {
      method: 'POST',
      headers: { 'x-mailmint-internal': secret },
      json: { mailbox_token: mailboxToken, confirmation: detection },
      timeoutMs,
    });
    return { published: true, status: r.status };
  } catch (err) {
    return { published: false, status: err.status || 0, reason: err.message };
  }
}

module.exports = { detect, scan, publish, PROVIDERS, collectLinks, buildInstructions, firstMatch, firstWhole };
