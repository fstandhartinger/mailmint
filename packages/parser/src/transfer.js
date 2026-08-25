'use strict';
/** Content-Transfer-Encoding decoders. Buffer in, Buffer out. */

/**
 * Quoted-printable. Deliberately lenient, because real mail breaks the rules:
 *  - `=` followed by something that is not hex is kept literally (Outlook does
 *    this with stray equals signs in URLs).
 *  - a soft break may be `=\r\n`, `=\n`, or `=` at very end of input.
 *  - trailing whitespace before a hard line break is stripped (RFC 2045 §6.7
 *    rule 3) — otherwise signature detection sees phantom spaces.
 */
function decodeQuotedPrintable(buf) {
  const s = buf.toString('latin1');
  const out = Buffer.allocUnsafe(s.length);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */) {
      const a = s[i + 1], b = s[i + 2];
      if (a === '\n') { i += 1; continue; }
      if (a === '\r' && b === '\n') { i += 2; continue; }
      if (a === '\r' && b === undefined) { i += 1; continue; }
      if (a !== undefined && b !== undefined && isHex(a) && isHex(b)) {
        out[o++] = parseInt(a + b, 16); i += 2; continue;
      }
      if (a === undefined) continue;           // trailing soft break
      out[o++] = c; continue;                  // literal '='
    }
    if (c === 0x0a) {
      // Strip trailing whitespace of the line just written, but keep the CRLF
      // intact: quoted-printable is occasionally used for binary payloads and
      // rewriting their line endings would corrupt them.
      const hadCR = o > 0 && out[o - 1] === 0x0d;
      if (hadCR) o--;
      while (o > 0 && (out[o - 1] === 0x20 || out[o - 1] === 0x09)) o--;
      if (hadCR) out[o++] = 0x0d;
      out[o++] = 0x0a; continue;
    }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

function isHex(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

/** Base64. Strips everything outside the alphabet first; some senders wrap oddly. */
function decodeBase64(buf) {
  const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  return Buffer.from(clean, 'base64');
}

function decodeTransfer(buf, encoding) {
  const e = String(encoding || '7bit').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (e === 'base64') return decodeBase64(buf);
  if (e === 'quoted-printable') return decodeQuotedPrintable(buf);
  if (e === 'x-uuencode' || e === 'uuencode' || e === 'x-uue') return decodeUu(buf);
  return buf; // 7bit, 8bit, binary, or unknown -> pass through
}

function decodeUu(buf) {
  const lines = buf.toString('latin1').split(/\r?\n/);
  const out = [];
  let started = false;
  for (const line of lines) {
    if (!started) { if (/^begin\s+\d+\s/.test(line)) started = true; continue; }
    if (/^end\s*$/.test(line)) break;
    const len = (line.charCodeAt(0) - 32) & 63;
    if (len <= 0) continue;
    let bytes = [];
    for (let i = 1; i + 3 < line.length + 4; i += 4) {
      const c = [0, 1, 2, 3].map((k) => ((line.charCodeAt(i + k) || 32) - 32) & 63);
      bytes.push((c[0] << 2) | (c[1] >> 4), ((c[1] & 15) << 4) | (c[2] >> 2), ((c[2] & 3) << 6) | c[3]);
    }
    out.push(Buffer.from(bytes.slice(0, len)));
  }
  return Buffer.concat(out);
}

module.exports = { decodeTransfer, decodeQuotedPrintable, decodeBase64 };
