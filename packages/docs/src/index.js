'use strict';
const { resolveLimits, deadline } = require('./limits');
const { normaliseLogger } = require('./log');
const { sniff } = require('./sniff');
const { extractPdf } = require('./pdf');
const { buildLines, renderText } = require('./layout');
const { tablesFromLines } = require('./pdftables');
const { extractXlsx } = require('./xlsx');
const { extractCsv } = require('./csv');
const { decodeText, htmlToText, htmlTables, textTables } = require('./plain');
const { extractDocx } = require('./docx');
const { makeTable } = require('./tableshape');
const gemini = require('./gemini');

/**
 * mailmint-docs — attachment content extraction.
 *
 * Why this package exists, from the market research the CONTRACT is built on:
 * Mailparser cannot read attachment contents at all; Docparser (same company)
 * reads PDFs but cannot read email bodies; Zapier reads neither and zips
 * attachments together so you cannot address one. "The data is only in the PDF"
 * is the second most common complaint across the n8n, Make and Zapier forums,
 * and every one of those threads ends in "go buy a second product".
 *
 * The contract of this module is small and total:
 *
 *   await extractAttachment({buffer, filename, contentType}, {log, requestId, schema})
 *     -> { kind, text, pages, tables, fields?, meta:{extractor, ms, ocr, warnings} }
 *
 * It NEVER throws. An attachment that cannot be read is a `kind` and a warning,
 * because a message with an unreadable attachment must still deliver
 * (CONTRACT §4: "A message with any flag still delivers").
 */

const VERSION = require('../package.json').version;

async function extractAttachment(attachment, options = {}) {
  const started = Date.now();
  const opts = options || {};
  const log = normaliseLogger(opts.log);
  const requestId = opts.requestId || null;
  const limits = resolveLimits(opts.limits);
  const dl = deadline(limits.totalMs);
  const warnings = [];
  const timings = {};

  const buffer = toBuffer(attachment && attachment.buffer);
  const filename = attachment && attachment.filename ? String(attachment.filename) : null;
  const contentType = attachment && attachment.contentType ? String(attachment.contentType) : null;

  const type = safe(() => sniff(buffer, filename, contentType), { kind: 'unknown', mime: contentType, ext: null, via: 'error' });

  log.info('attachment.extract.start', { request_id: requestId, filename, content_type: contentType,
    bytes: buffer.length, detected: type.kind, detected_via: type.via });

  const base = {
    kind: 'unsupported', text: '', pages: null, tables: [],
    meta: { extractor: 'none', ms: 0, ocr: false, warnings,
      detected_type: type.kind, detected_via: type.via, mime: type.mime, filename, bytes: buffer.length,
      version: VERSION, timings_ms: timings },
  };

  if (!buffer.length) {
    base.kind = 'empty';
    warnings.push('empty_attachment');
    return finish(base, started, log, requestId);
  }
  if (buffer.length > limits.maxBytes) {
    base.kind = type.kind === 'unknown' ? 'unsupported' : type.kind;
    warnings.push('attachment_too_large');
    return finish(base, started, log, requestId);
  }

  try {
    const out = await dispatch(type, buffer, { opts, log, requestId, limits, dl, warnings, timings, filename });
    Object.assign(base, out);
    base.meta.warnings = warnings;
  } catch (err) {
    // A crash in an extractor is a warning on one attachment, never a failed
    // message. The stack goes to the log; the caller gets a code.
    const code = err && err.code ? err.code : 'extract_failed';
    warnings.push(`${code}:${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
    log.error('attachment.extract.failed', { request_id: requestId, filename, detected: type.kind, error: code,
      message: err && err.message, stack: (err && err.stack ? err.stack : '').split('\n').slice(0, 4).join(' | ') });
    base.kind = type.kind === 'unknown' ? 'unsupported' : type.kind;
  }
  return finish(base, started, log, requestId);
}

function finish(result, started, log, requestId) {
  result.meta.ms = Date.now() - started;
  log.info('attachment.extract.done', { request_id: requestId, kind: result.kind,
    extractor: result.meta.extractor, ocr: result.meta.ocr, pages: result.pages,
    tables: result.tables.length, rows: result.tables.reduce((n, t) => n + t.row_count, 0),
    chars: result.text ? result.text.length : 0, ms: result.meta.ms,
    timings_ms: result.meta.timings_ms, warnings: result.meta.warnings });
  return result;
}

async function dispatch(type, buffer, ctx) {
  switch (type.kind) {
    case 'pdf': return fromPdf(buffer, ctx);
    case 'spreadsheet': return fromXlsx(buffer, ctx);
    case 'csv': return fromCsv(buffer, type, ctx);
    case 'html': return fromHtml(buffer, type, ctx);
    case 'xml': case 'json': case 'text': return fromText(buffer, type, ctx);
    case 'docx': return fromDocx(buffer, ctx);
    case 'image': return fromImage(buffer, type, ctx);
    case 'message': return fromMessage(buffer, type, ctx);
    default:
      ctx.warnings.push(`unsupported_type:${type.kind}${type.mime ? ':' + type.mime : ''}`);
      return { kind: 'unsupported', text: '', pages: null, tables: [],
        meta: { ...ctx.metaBase, extractor: 'none', ocr: false } };
  }
}

/* ------------------------------------------------------------------ PDF -- */

async function fromPdf(buffer, ctx) {
  const { limits, dl, warnings, timings, log, requestId, opts } = ctx;
  const t0 = Date.now();
  const pdfDeadline = deadline(Math.min(limits.pdfMs, Math.max(1000, dl.left())));
  let doc;
  try {
    doc = await extractPdf(buffer, { limits, log, requestId, deadline: pdfDeadline });
  } catch (err) {
    // Encrypted or structurally broken: the model can often still read it.
    warnings.push(err.code || 'pdf_open_failed');
    const ocr = await maybeOcr(buffer, 'application/pdf', ctx, null);
    if (ocr) return ocr;
    return { kind: 'pdf', text: '', pages: null, tables: [],
      meta: { extractor: 'pdfjs', ocr: false, error: err.code || 'pdf_open_failed' } };
  }
  timings.pdf_repair = doc.timings.repair;
  timings.pdf_text = doc.timings.pdfjs;
  for (const w of doc.warnings) warnings.push(w);

  const t1 = Date.now();
  const pageTexts = [];
  let tables = [];
  let rotatedRuns = 0;
  for (const page of doc.pages) {
    const { lines, rotated } = buildLines(page.runs);
    rotatedRuns += rotated;
    pageTexts.push(renderText(lines, page.width));
    if (tables.length < limits.maxTables) {
      const t = tablesFromLines(lines, { source: 'pdf', startIndex: tables.length,
        maxRows: limits.maxTableRows, maxTables: limits.maxTables - tables.length });
      for (const x of t) x.page = page.index;
      tables = tables.concat(t);
    }
  }
  if (rotatedRuns) warnings.push(`rotated_runs_skipped:${rotatedRuns}`);
  timings.layout = Date.now() - t1;

  let text = pageTexts.join('\n\f\n');
  if (text.length > limits.maxTextChars) { text = text.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }

  const chars = text.replace(/\s/g, '').length;
  const readPages = Math.max(1, doc.pages.length);
  const scanned = chars < limits.minCharsPerPage * readPages;

  const fields = { ...doc.form };
  const meta = {
    extractor: 'pdfjs+layout', ocr: false,
    page_count: doc.declaredPages, pages_read: doc.pages.length, runs: doc.runCount,
    chars, info: doc.info, form_fields: Object.keys(doc.form).length,
    glyph_repairs: doc.repairs.length,
  };
  if (doc.repairs.length) {
    meta.glyph_repair_detail = doc.repairs.slice(0, 20).map((r) => ({ font: r.font, cid: r.cid, char: r.char, via: r.via }));
  }

  if (scanned) {
    warnings.push('pdf_no_text_layer');
    const ocr = await maybeOcr(buffer, 'application/pdf', ctx, doc.declaredPages);
    if (ocr) {
      // Keep whatever the text layer did give us; the model output is primary.
      ocr.fields = { ...fields, ...(ocr.fields || {}) };
      ocr.meta = { ...meta, ...ocr.meta };
      ocr.pages = doc.declaredPages;
      return ocr;
    }
  }

  const result = { kind: 'pdf', text, pages: doc.declaredPages, tables, meta };
  if (Object.keys(fields).length) result.fields = fields;
  return result;
}

/* ------------------------------------------------------- model fallback -- */

/**
 * The paid path. Reached only when the deterministic one produced nothing —
 * CONTRACT §7 economics: never spend an LLM call on a document whose text layer
 * already answered.
 */
async function maybeOcr(buffer, mimeType, ctx, pageCount) {
  const { limits, dl, warnings, timings, log, requestId, opts } = ctx;
  if (opts.ocr === false) { warnings.push('ocr_disabled'); return null; }
  const apiKey = opts.googleApiKey || process.env.GOOGLE_API_KEY;
  if (!apiKey) { warnings.push('ocr_unavailable:no_google_api_key'); return null; }
  if (buffer.length > limits.maxOcrBytes) { warnings.push('ocr_skipped:too_large'); return null; }
  if (dl.expired()) { warnings.push('ocr_skipped:deadline'); return null; }

  const capped = Number.isFinite(pageCount) && pageCount > limits.maxOcrPages;
  if (capped) warnings.push(`ocr_page_cap:${limits.maxOcrPages}/${pageCount}`);

  const t0 = Date.now();
  log.info('attachment.ocr.start', { request_id: requestId, mime: mimeType, bytes: buffer.length,
    pages: pageCount ?? null, page_cap: capped ? limits.maxOcrPages : null });
  const res = await gemini.readDocument(buffer, mimeType, {
    apiKey,
    schema: opts.schema || null,
    maxPages: capped ? limits.maxOcrPages : null,
    timeoutMs: Math.min(limits.ocrMs, Math.max(2000, dl.left())),
    models: opts.ocrModels,
  });
  timings.ocr = Date.now() - t0;

  if (!res.ok) {
    warnings.push(`ocr_failed:${String(res.error).slice(0, 160)}`);
    log.warn('attachment.ocr.failed', { request_id: requestId, error: res.error, ms: timings.ocr });
    return null;
  }
  log.info('attachment.ocr.done', { request_id: requestId, model: res.model, ms: res.ms,
    chars: res.text.length, tables: res.tables.length, truncated: res.truncated });

  const tables = [];
  for (const t of res.tables.slice(0, limits.maxTables)) {
    const headers = Array.isArray(t.headers) && t.headers.length ? t.headers.map(String) : null;
    const rows = (Array.isArray(t.rows) ? t.rows : []).filter(Array.isArray)
      .map((r) => r.map((c) => (c == null ? '' : String(c))));
    if (!rows.length) continue;
    const width = Math.max(headers ? headers.length : 0, ...rows.map((r) => r.length));
    const pad = (r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; };
    tables.push(makeTable('ocr', tables.length,
      headers ? pad(headers) : Array.from({ length: width }, (_, i) => `col${i + 1}`),
      rows.map(pad), limits.maxTableRows));
  }
  if (res.truncated) warnings.push('ocr_response_truncated');
  if (capped) warnings.push('table_truncated');

  let text = res.text || '';
  if (text.length > limits.maxTextChars) { text = text.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }

  const out = {
    kind: mimeType === 'application/pdf' ? 'pdf' : 'image',
    text, pages: Number.isFinite(pageCount) ? pageCount : res.pages, tables,
    meta: { extractor: `gemini:${res.model}`, ocr: true, model: res.model, ocr_ms: res.ms,
      ocr_pages_sent: capped ? limits.maxOcrPages : (pageCount ?? null),
      language: res.language || null },
  };
  if (res.fields && Object.keys(res.fields).length) out.fields = res.fields;
  return out;
}

/* -------------------------------------------------------- other formats -- */

function fromXlsx(buffer, ctx) {
  const { limits, warnings } = ctx;
  const r = extractXlsx(buffer, { maxRows: limits.maxTableRows, maxTables: limits.maxTables });
  for (const w of r.warnings) warnings.push(w);
  let text = r.text;
  if (text.length > limits.maxTextChars) { text = text.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  return { kind: 'spreadsheet', text, pages: r.sheets.length, tables: r.tables,
    meta: { extractor: 'xlsx', ocr: false, sheets: r.sheets } };
}

function fromCsv(buffer, type, ctx) {
  const { limits, warnings } = ctx;
  const { text, charset } = decodeText(buffer, type.charset);
  const r = extractCsv(text, { maxRows: limits.maxTableRows });
  for (const w of r.warnings) warnings.push(w);
  let out = text;
  if (out.length > limits.maxTextChars) { out = out.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  return { kind: 'csv', text: out, pages: null, tables: r.tables,
    meta: { extractor: 'csv', ocr: false, charset, delimiter: r.delimiter } };
}

function fromHtml(buffer, type, ctx) {
  const { limits, warnings } = ctx;
  const declared = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString('latin1'));
  const { text: html, charset } = decodeText(buffer, type.charset || (declared ? declared[1] : null));
  const tables = htmlTables(html, { maxRows: limits.maxTableRows, maxTables: limits.maxTables });
  let text = htmlToText(html);
  if (text.length > limits.maxTextChars) { text = text.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  return { kind: 'html', text, pages: null, tables,
    meta: { extractor: 'html', ocr: false, charset } };
}

function fromText(buffer, type, ctx) {
  const { limits, warnings } = ctx;
  const { text, charset } = decodeText(buffer, type.charset);
  let out = text;
  if (out.length > limits.maxTextChars) { out = out.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  const tables = type.kind === 'text' ? textTables(out, { maxRows: limits.maxTableRows, maxTables: limits.maxTables }) : [];
  return { kind: type.kind, text: out, pages: null, tables,
    meta: { extractor: type.kind, ocr: false, charset } };
}

function fromDocx(buffer, ctx) {
  const { limits, warnings } = ctx;
  const r = extractDocx(buffer, { maxRows: limits.maxTableRows, maxTables: limits.maxTables });
  for (const w of r.warnings) warnings.push(w);
  let text = r.text;
  if (text.length > limits.maxTextChars) { text = text.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  return { kind: 'docx', text, pages: null, tables: r.tables, meta: { extractor: 'docx', ocr: false } };
}

async function fromImage(buffer, type, ctx) {
  const ocr = await maybeOcr(buffer, type.mime || 'image/png', ctx, 1);
  if (ocr) return ocr;
  return { kind: 'image', text: '', pages: 1, tables: [],
    meta: { extractor: 'none', ocr: false, mime: type.mime } };
}

/**
 * `.eml` / `message/rfc822`.
 *
 * We hand it straight back rather than parse it: the MIME parser lives in
 * `mailmint-parser`, the caller already has it, and a nested message must be
 * parsed with the same code path as the outer one or the two disagree.
 * CONTRACT §1b(4) — forwarded mail — depends on that being true.
 */
function fromMessage(buffer, type, ctx) {
  const { limits, warnings } = ctx;
  const { text, charset } = decodeText(buffer, type.charset);
  let out = text;
  if (out.length > limits.maxTextChars) { out = out.slice(0, limits.maxTextChars); warnings.push('text_truncated'); }
  warnings.push('nested_message');
  return { kind: 'message', text: out, pages: null, tables: [],
    meta: { extractor: 'passthrough', ocr: false, charset, note: 'parse with mailmint-parser' } };
}

/* --------------------------------------------------------------- utils -- */

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return Buffer.alloc(0);
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

module.exports = {
  extractAttachment,
  // exported for tests and for callers that want one stage
  sniff,
  extractPdf,
  buildLines,
  renderText,
  tablesFromLines,
  extractXlsx,
  extractCsv,
  makeTable,
  gemini,
  VERSION,
};
