'use strict';
const { openZip } = require('./zip');

/**
 * What IS this attachment?
 *
 * Bytes first, then the declared Content-Type, then the filename — in that
 * order and for a documented reason. Mail clients label attachments wrongly all
 * the time (`application/octet-stream` for a PDF, `application/pdf` for the
 * cover image), and the research file records Zapier picking the signature
 * `image001.png` over the invoice. A magic number cannot lie about what it is.
 */

const SIGNATURES = [
  { kind: 'pdf', mime: 'application/pdf', test: (b) => b.length > 4 && b.toString('latin1', 0, 5) === '%PDF-' },
  { kind: 'image', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/png', test: (b) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { kind: 'image', mime: 'image/gif', test: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  { kind: 'image', mime: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { kind: 'image', mime: 'image/tiff', test: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) },
  { kind: 'image', mime: 'image/bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { kind: 'image', mime: 'image/heic', test: (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1)/.test(b.toString('latin1', 8, 12)) },
  { kind: 'ole', mime: 'application/x-ole-storage', test: (b) => b.readUInt32LE && b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 },
  { kind: 'rtf', mime: 'application/rtf', test: (b) => b.toString('latin1', 0, 5) === '{\\rtf' },
  { kind: 'gzip', mime: 'application/gzip', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
];

const EXT_KINDS = {
  pdf: 'pdf', csv: 'csv', tsv: 'csv', txt: 'text', log: 'text', md: 'text',
  html: 'html', htm: 'html', xml: 'xml', json: 'json',
  xlsx: 'spreadsheet', xlsm: 'spreadsheet', xls: 'ole', ods: 'ods',
  docx: 'docx', doc: 'ole', pptx: 'pptx',
  eml: 'message', mht: 'message', mhtml: 'message', msg: 'ole',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', tif: 'image',
  tiff: 'image', bmp: 'image', heic: 'image',
  zip: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
};

function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(filename || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * @returns {{kind, mime, ext, via, charset}}
 *   kind ∈ pdf|spreadsheet|csv|text|html|xml|json|image|message|docx|ods|pptx|
 *          ole|archive|rtf|empty|unknown
 */
function sniff(buffer, filename, contentType) {
  const ext = extOf(filename);
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  const charset = (/charset\s*=\s*([^;]+)/i.exec(String(contentType || '')) || [])[1] || null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return { kind: 'empty', mime: declared || null, ext, via: 'empty', charset };

  for (const sig of SIGNATURES) {
    let hit = false;
    try { hit = sig.test(buf); } catch { hit = false; }
    if (hit) return { kind: sig.kind, mime: sig.mime, ext, via: 'magic', charset };
  }

  // OOXML and every other zip look identical until you open them.
  if (buf.readUInt32LE(0) === 0x04034b50) {
    const z = openZip(buf);
    if (z.has('xl/workbook.xml')) return { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext, via: 'zip', charset };
    if (z.has('word/document.xml')) return { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext, via: 'zip', charset };
    if (z.has('ppt/presentation.xml')) return { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext, via: 'zip', charset };
    if (z.has('mimetype') && String(z.text('mimetype') || '').includes('opendocument.spreadsheet')) return { kind: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', ext, via: 'zip', charset };
    return { kind: 'archive', mime: 'application/zip', ext, via: 'zip', charset };
  }

  if (declared === 'message/rfc822' || ext === 'eml') return { kind: 'message', mime: 'message/rfc822', ext, via: declared ? 'content-type' : 'ext', charset };

  const head = buf.subarray(0, 4096).toString('latin1');
  if (/^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(head)) return { kind: 'html', mime: 'text/html', ext, via: 'sniff', charset };
  if (/^\s*<\?xml\b/i.test(head)) return { kind: 'xml', mime: 'application/xml', ext, via: 'sniff', charset };
  if (looksRfc822(head)) return { kind: 'message', mime: 'message/rfc822', ext, via: 'sniff', charset };

  if (declared) {
    if (declared === 'text/csv' || declared === 'text/tab-separated-values') return { kind: 'csv', mime: declared, ext, via: 'content-type', charset };
    if (declared === 'text/html') return { kind: 'html', mime: declared, ext, via: 'content-type', charset };
    if (declared === 'application/json') return { kind: 'json', mime: declared, ext, via: 'content-type', charset };
    if (declared.startsWith('text/')) return { kind: ext && EXT_KINDS[ext] === 'csv' ? 'csv' : 'text', mime: declared, ext, via: 'content-type', charset };
    if (declared.startsWith('image/')) return { kind: 'image', mime: declared, ext, via: 'content-type', charset };
  }

  if (ext && EXT_KINDS[ext]) return { kind: EXT_KINDS[ext], mime: declared || null, ext, via: 'ext', charset };

  if (isMostlyText(buf)) {
    const t = buf.subarray(0, 65536).toString('utf8');
    if (looksDelimited(t)) return { kind: 'csv', mime: 'text/csv', ext, via: 'sniff', charset };
    return { kind: 'text', mime: 'text/plain', ext, via: 'sniff', charset };
  }
  return { kind: 'unknown', mime: declared || 'application/octet-stream', ext, via: 'none', charset };
}

function looksRfc822(head) {
  const lines = head.split(/\r?\n/, 12);
  let hits = 0;
  for (const l of lines) {
    if (/^(from|to|subject|date|message-id|mime-version|received|return-path|content-type):/i.test(l)) hits++;
    else if (l.trim() === '') break;
  }
  return hits >= 3;
}

function isMostlyText(buf) {
  const n = Math.min(buf.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / n < 0.02;
}

function looksDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  if (lines.length < 2) return false;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return true;
  }
  return false;
}

module.exports = { sniff, extOf, isMostlyText, looksDelimited };
