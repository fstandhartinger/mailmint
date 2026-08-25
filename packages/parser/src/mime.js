'use strict';
const crypto = require('node:crypto');
const { splitHeaders, headerValue, headerValues, parseParameters, parseAddressList, parseDate } = require('./headers');
const { decodeWords } = require('./rfc2047');
const { decodeBuffer } = require('./charset');
const { decodeTransfer } = require('./transfer');

/**
 * A from-scratch RFC 2045/2046/5322 parser. No mailparser, no dependencies.
 *
 * Everything below operates on Buffers until the last possible moment. Mail is
 * bytes: a base64 attachment, a latin-1 body and a utf-8 body all arrive as the
 * same octet stream and only the part headers say how to read them. Decoding
 * early is the single most common source of mojibake in mail parsers.
 */

const MAX_DEPTH = 20;
const MAX_PARTS = 500;
const MAX_TEXT_CHARS = 1000000;        // beyond this we truncate and flag
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Split an entity into [headerBlock, body] at the first blank line. */
function splitMessage(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (buf[i + 1] === 0x0a) return [buf.subarray(0, i), buf.subarray(i + 2)];
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return [buf.subarray(0, i), buf.subarray(i + 3)];
    }
  }
  return [buf, Buffer.alloc(0)];
}

/**
 * Split a multipart body on its boundary, returning the raw part buffers.
 * Tolerates: a missing final `--boundary--`, preamble and epilogue text, CRLF
 * or bare LF, and trailing whitespace after the boundary token — which some
 * senders add and which defeats naive `indexOf('--' + b + '\r\n')` code.
 */
function splitMultipart(body, boundary) {
  const delim = Buffer.from('--' + boundary, 'latin1');
  const parts = [];
  const marks = [];
  let idx = 0;
  while (idx <= body.length) {
    const at = body.indexOf(delim, idx);
    if (at === -1) break;
    if (at !== 0 && body[at - 1] !== 0x0a) { idx = at + 1; continue; }   // must start a line
    const after = at + delim.length;
    const isClose = body[after] === 0x2d && body[after + 1] === 0x2d;
    let p = after + (isClose ? 2 : 0);
    while (p < body.length && (body[p] === 0x20 || body[p] === 0x09)) p++;
    if (p < body.length && body[p] === 0x0d) p++;
    if (p < body.length && body[p] !== 0x0a) {
      // Seen in the wild (Stripe via SES): the CRLF after the delimiter is
      // missing and the part's headers start on the same line. Accept that,
      // but only when what follows really does look like a header, otherwise
      // any text containing the boundary string would split the message.
      const peek = body.subarray(after, after + 48).toString('latin1');
      if (!isClose && /^[A-Za-z][A-Za-z0-9-]{0,40}:/.test(peek)) {
        marks.push({ start: at, contentStart: after, close: false });
        idx = after;
        continue;
      }
      idx = at + 1; continue;                                           // not a real delimiter line
    }
    marks.push({ start: at, contentStart: Math.min(p + 1, body.length), close: isClose });
    idx = p + 1;
    if (isClose) break;
    if (marks.length > MAX_PARTS) break;
  }
  for (let i = 0; i < marks.length - 1; i++) {
    if (marks[i].close) break;
    let end = marks[i + 1].start;
    if (end > 0 && body[end - 1] === 0x0a) { end--; if (end > 0 && body[end - 1] === 0x0d) end--; }
    parts.push(body.subarray(marks[i].contentStart, end));
  }
  const last = marks[marks.length - 1];
  if (last && !last.close) parts.push(body.subarray(last.contentStart));
  return parts;
}

/** Parse one MIME entity (headers + body) into a node of the tree. */
function parseEntity(buf, depth, ctx) {
  const [headBuf, bodyBuf] = splitMessage(buf);
  const pairs = splitHeaders(headBuf.toString('latin1'));
  const ct = parseParameters(headerValue(pairs, 'content-type') || 'text/plain');
  const cd = parseParameters(headerValue(pairs, 'content-disposition') || '');
  const cte = (headerValue(pairs, 'content-transfer-encoding') || '7bit').trim().toLowerCase();
  const mimeType = (ct.value || 'text/plain').toLowerCase().replace(/\s+/g, '');
  const node = {
    pairs,
    mimeType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType) ? mimeType : 'text/plain',
    params: ct.params,
    disposition: (cd.value || '').toLowerCase() || null,
    dispParams: cd.params,
    encoding: cte,
    contentId: (headerValue(pairs, 'content-id') || '').trim().replace(/^<|>$/g, '') || null,
    children: [],
    raw: bodyBuf,
    content: null,
  };
  ctx.count++;
  if (node.mimeType.startsWith('multipart/') && depth < MAX_DEPTH && ctx.count < MAX_PARTS) {
    const boundary = node.params.boundary;
    if (boundary) {
      const chunks = splitMultipart(bodyBuf, boundary);
      for (const c of chunks) node.children.push(parseEntity(c, depth + 1, ctx));
      if (!chunks.length) ctx.warnings.push('multipart boundary not found; body treated as text');
    } else {
      ctx.warnings.push('multipart without boundary parameter');
    }
  }
  if (!node.children.length) node.content = decodeTransfer(bodyBuf, node.encoding);
  return node;
}

function isTextual(node) {
  return node.mimeType === 'text/plain' || node.mimeType === 'text/html';
}

/** Does this leaf represent a file rather than body text? */
function looksLikeAttachment(node) {
  if (node.disposition === 'attachment') return true;
  if (!isTextual(node)) return true;
  return !!(node.dispParams.filename || node.params.name);
}

function filenameOf(node) {
  let fn = node.dispParams.filename || node.params.name || null;
  if (fn) fn = decodeWords(fn);
  if (!fn) {
    const ext = { 'text/plain': 'txt', 'text/html': 'html', 'text/calendar': 'ics',
      'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
      'message/rfc822': 'eml', 'application/pgp-signature': 'asc' }[node.mimeType];
    fn = ext ? 'part.' + ext : null;
  }
  if (fn) fn = fn.replace(/[\r\n\t]/g, ' ').trim().slice(0, 255);
  return fn || null;
}

/**
 * Walk the tree collecting body text, html and attachments.
 *
 * For multipart/alternative we take the last textual sibling of each kind
 * rather than simply the last child, so that a sender who orders html before
 * plain does not cost us the plain text.
 */
function collect(node, out) {
  const type = node.mimeType;

  if (type.startsWith('multipart/')) {
    if (!node.children.length) {
      // Declared multipart but the boundary never appeared. Rather than lose
      // the body, read what is there as text.
      if (node.content && node.content.length) pushText(node, out);
      return;
    }
    if (type === 'multipart/alternative') {
      const textual = node.children.filter((c) => isTextual(c) && !looksLikeAttachment(c));
      const html = textual.filter((c) => c.mimeType === 'text/html').pop();
      const plain = textual.filter((c) => c.mimeType === 'text/plain').pop();
      const nested = node.children.filter((c) => c.mimeType.startsWith('multipart/'));
      if (plain) pushText(plain, out);
      if (html) pushHtml(html, out);
      for (const c of nested) collect(c, out);
      for (const c of node.children) {
        if (c === html || c === plain || nested.includes(c)) continue;
        addAttachment(c, out);       // calendar invites, signatures, stray parts
      }
      return;
    }
    for (const c of node.children) collect(c, out);
    return;
  }

  if (type === 'message/rfc822') { out.embedded.push(node); addAttachment(node, out); return; }
  if (looksLikeAttachment(node)) { addAttachment(node, out); return; }
  if (type === 'text/html') { pushHtml(node, out); return; }
  pushText(node, out);
}

function pushText(node, out) { out.textParts.push(decodeBuffer(node.content, node.params.charset)); }
function pushHtml(node, out) { out.htmlParts.push(decodeBuffer(node.content, node.params.charset)); }

function addAttachment(node, out) {
  const content = node.content || node.raw || Buffer.alloc(0);
  const size = content.length;
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const att = {
    id: 'att_' + sha.slice(0, 22),
    filename: filenameOf(node),
    content_type: node.mimeType,
    size,
    sha256: sha,
    inline: node.disposition === 'inline' || (!!node.contentId && node.disposition !== 'attachment'),
    content_id: node.contentId,
    url: null,
    content_base64: size <= MAX_ATTACHMENT_BYTES ? content.toString('base64') : null,
  };
  if (att.content_base64 === null) out.warnings.push('attachment_too_large:' + att.filename);
  out.attachments.push(att);
}

/** Join, normalise line endings and NBSP, and cap runaway bodies. */
function finishText(parts, warnings) {
  let s = parts.filter((x) => x != null && x !== '').join('\n\n');
  s = s.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/﻿/g, '');
  if (s.length > MAX_TEXT_CHARS) { s = s.slice(0, MAX_TEXT_CHARS); warnings.push('truncated_body'); }
  return s;
}

/**
 * Full structural parse of an RFC822 buffer. Deterministic and offline.
 */
function parseStructure(input, depth) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8');
  const ctx = { count: 0, warnings: [] };
  let work = buf;
  if (work.length > 5 && work.subarray(0, 5).toString('latin1') === 'From ') {
    const nl = work.indexOf(0x0a);                 // an mbox envelope line leaked in
    if (nl > 0 && nl < 1000) work = work.subarray(nl + 1);
  }
  const root = parseEntity(work, 0, ctx);
  const out = { textParts: [], htmlParts: [], attachments: [], embedded: [], warnings: ctx.warnings };
  collect(root, out);

  // No body at top level but an embedded message: "forwarded as attachment".
  if (!out.textParts.length && !out.htmlParts.length && out.embedded.length && (depth || 0) < 3) {
    const inner = parseStructure(out.embedded[0].content || out.embedded[0].raw, (depth || 0) + 1);
    if (inner.text) out.textParts.push(inner.text);
    if (inner.html) out.htmlParts.push(inner.html);
  }

  return {
    root,
    pairs: root.pairs,
    text: finishText(out.textParts, ctx.warnings),
    html: out.htmlParts.length ? finishText(out.htmlParts, ctx.warnings) : null,
    attachments: out.attachments,
    warnings: ctx.warnings,
  };
}

/** Build the §1 `headers` object from the ordered raw pairs. */
function buildHeaders(pairs) {
  const KNOWN = new Set(['message-id', 'date', 'subject', 'from', 'to', 'cc', 'reply-to',
    'in-reply-to', 'references', 'bcc']);
  const raw = {};
  for (const [k, v] of pairs) {
    if (KNOWN.has(k)) continue;
    const dec = decodeWords(v);
    if (raw[k] === undefined) raw[k] = dec;
    else if (Array.isArray(raw[k])) raw[k].push(dec);
    else raw[k] = [raw[k], dec];
  }
  const refs = headerValues(pairs, 'references').join(' ').match(/<[^>\s]+>/g) || [];
  return {
    message_id: (headerValue(pairs, 'message-id') || '').trim() || null,
    date: parseDate(headerValue(pairs, 'date')),
    subject: decodeWords(headerValue(pairs, 'subject') || '').replace(/\s+/g, ' ').trim() || null,
    from: parseAddressList(headerValue(pairs, 'from'))[0] || null,
    to: parseAddressList(headerValue(pairs, 'to')),
    cc: parseAddressList(headerValue(pairs, 'cc')),
    reply_to: parseAddressList(headerValue(pairs, 'reply-to')),
    in_reply_to: (headerValue(pairs, 'in-reply-to') || '').match(/<[^>\s]+>/)?.[0] || null,
    references: refs,
    raw,
  };
}

module.exports = { parseStructure, buildHeaders, splitMultipart, splitMessage, MAX_TEXT_CHARS };
