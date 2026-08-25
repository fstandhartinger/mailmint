'use strict';

/**
 * The *minimum* MIME reading the connector needs, and nothing more.
 *
 * Real parsing is packages/parser's job and happens on the API side after
 * delivery. Intake only needs four things out of the raw bytes: who the
 * envelope sender should be, who it was addressed to, the Message-ID (our
 * idempotency key) and the subject (for logs and forwarding detection). Doing
 * that here with ~80 lines keeps this package at zero dependencies and keeps a
 * parser bug from being able to block intake.
 */

/** Splits raw RFC822 into a header block and the body, tolerating bare LF. */
function split(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let idx = buf.indexOf('\r\n\r\n');
  let skip = 4;
  const lf = buf.indexOf('\n\n');
  if (idx === -1 || (lf !== -1 && lf < idx)) { idx = lf; skip = 2; }
  if (idx === -1) return { head: buf.toString('utf8'), body: Buffer.alloc(0) };
  return { head: buf.subarray(0, idx).toString('utf8'), body: buf.subarray(idx + skip) };
}

/** Unfolded headers, lowercased keys, values in arrival order. */
function parseHeaders(headText) {
  const out = new Map();
  const lines = headText.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { current.value += ` ${line.trim()}`; continue; }
    const c = line.indexOf(':');
    if (c === -1) continue;
    current = { key: line.slice(0, c).trim().toLowerCase(), value: line.slice(c + 1).trim() };
    if (!out.has(current.key)) out.set(current.key, []);
    out.get(current.key).push(current);
  }
  const obj = {};
  for (const [k, v] of out) obj[k] = v.map((e) => e.value);
  return obj;
}

/** First bare address out of a header value: `"A B" <a@b.c>, d@e.f` -> a@b.c */
function firstAddress(value) {
  if (!value) return null;
  const angle = /<([^>]+@[^>]+)>/.exec(value);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = /([^\s<>,;:"()]+@[^\s<>,;:"()]+)/.exec(value);
  return bare ? bare[1].trim().toLowerCase() : null;
}

function allAddresses(value) {
  if (!value) return [];
  const out = [];
  const re = /([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  let m;
  while ((m = re.exec(value))) out.push(m[1].toLowerCase());
  return [...new Set(out)];
}

/** Decodes just enough RFC 2047 for subjects to be readable in a log line. */
function decodeWords(s) {
  if (!s || !s.includes('=?')) return s || '';
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (full, cs, enc, text) => {
    try {
      const charset = cs.split('*')[0].toLowerCase();
      let buf;
      if (enc.toUpperCase() === 'B') buf = Buffer.from(text, 'base64');
      else buf = Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      if (charset === 'utf-8' || charset === 'utf8') return buf.toString('utf8');
      if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'us-ascii') return buf.toString('latin1');
      return buf.toString('utf8');
    } catch { return full; }
  }).replace(/\?=\s+=\?/g, '?==?');
}

/** Everything intake needs from a raw message. */
function summarise(raw) {
  const { head, body } = split(raw);
  const h = parseHeaders(head);
  const first = (k) => (h[k] && h[k].length ? h[k][0] : null);
  const messageId = first('message-id');
  const to = [
    ...(h['delivered-to'] || []).flatMap(allAddresses),
    ...allAddresses(first('to')),
    ...allAddresses(first('x-original-to')),
  ];
  return {
    headers: h,
    messageId: messageId ? messageId.trim() : null,
    subject: decodeWords(first('subject')),
    from: firstAddress(first('from')),
    returnPath: firstAddress(first('return-path')),
    replyTo: firstAddress(first('reply-to')),
    to: [...new Set(to)],
    date: first('date'),
    bodyPreview: body.subarray(0, 4096).toString('utf8'),
  };
}

module.exports = { split, parseHeaders, firstAddress, allAddresses, decodeWords, summarise };

/* ------------------------------------------------ just enough body decoding */

function decodeTransfer(buf, encoding) {
  const enc = (encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const s = buf.toString('binary').replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '=' && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
        out.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(out);
  }
  return buf;
}

function toUtf8(buf, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return buf.toString('utf8');
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252' || cs === 'iso-8859-15') return buf.toString('latin1');
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}

function paramOf(value, name) {
  if (!value) return null;
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value);
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
}

/**
 * Walks a MIME tree and returns the text/plain and text/html parts.
 * Depth- and part-capped: a hostile message must not be able to make this run
 * forever, and we only ever need the top couple of levels for a confirmation.
 */
function extractText(raw, depth = 0, acc = { text: [], html: [], parts: 0 }) {
  if (depth > 6 || acc.parts > 200) return acc;
  acc.parts += 1;
  const { head, body } = split(raw);
  const h = parseHeaders(head);
  const ctype = (h['content-type'] && h['content-type'][0]) || 'text/plain';
  const cte = (h['content-transfer-encoding'] && h['content-transfer-encoding'][0]) || '7bit';
  const mime = ctype.split(';')[0].trim().toLowerCase();

  if (mime.startsWith('multipart/')) {
    const boundary = paramOf(ctype, 'boundary');
    if (!boundary) return acc;
    const sep = Buffer.from(`--${boundary}`);
    const pieces = [];
    let idx = body.indexOf(sep);
    while (idx !== -1) {
      const next = body.indexOf(sep, idx + sep.length);
      const start = idx + sep.length;
      if (body.subarray(start, start + 2).toString() === '--') break;   // closing delimiter
      const end = next === -1 ? body.length : next;
      pieces.push(body.subarray(start, end));
      if (next === -1) break;
      idx = next;
    }
    for (const p of pieces) {
      const trimmed = p[0] === 0x0d ? p.subarray(2) : (p[0] === 0x0a ? p.subarray(1) : p);
      extractText(trimmed, depth + 1, acc);
    }
    return acc;
  }

  const decoded = toUtf8(decodeTransfer(body, cte), paramOf(ctype, 'charset'));
  if (mime === 'text/html') acc.html.push(decoded);
  else if (mime.startsWith('text/')) acc.text.push(decoded);
  return acc;
}

/** Crude but sufficient: enough to find a code and a link in an HTML mail. */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports.decodeTransfer = decodeTransfer;
module.exports.toUtf8 = toUtf8;
module.exports.paramOf = paramOf;
module.exports.extractText = extractText;
module.exports.htmlToText = htmlToText;
