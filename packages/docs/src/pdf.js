'use strict';
const { repairPdf } = require('./repair');
const { PdfDoc } = require('./pdfobj');

/**
 * PDF -> positioned text runs, metadata and AcroForm values.
 *
 * The deliberate design decision here is that the primitive we produce is a
 * *run with coordinates*, not a string. Everything valuable downstream —
 * column detection, "is this row a line item or the totals block", wrapped
 * cells — is a geometry question, and geometry cannot be recovered from a flat
 * string once it has been thrown away. `pdftotext -layout` reconstructs an
 * approximation with spaces; we keep the real numbers.
 *
 * pdf.js does the hard part (stream filters, font programs, CID decoding,
 * shaping) and it is the only dependency in this package worth its weight.
 * What it does not do, we do around it:
 *   - /ActualText and U+0000 /ToUnicode entries: see repair.js.
 *   - page rotation: normalised through the viewport transform so that
 *     downstream code only ever sees left-to-right, top-to-bottom coordinates.
 */

let pdfjsPromise = null;
function loadPdfjs() {
  // pdf.js is ESM-only from v4. A cached dynamic import keeps this module CJS.
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => import('pdfjs-dist/build/pdf.mjs'));
  }
  return pdfjsPromise;
}

const MAX_RUNS_PER_PAGE = 20000;

async function extractPdf(buffer, { limits, log, requestId, deadline } = {}) {
  const warnings = [];
  const t0 = Date.now();

  let repaired = { buffer, repairs: [], textFixes: new Map(), warnings: [] };
  try { repaired = repairPdf(buffer); } catch (e) { warnings.push(`repair_failed:${e.message}`); }
  for (const w of repaired.warnings) warnings.push(w);
  const repairMs = Date.now() - t0;

  const pdfjs = await loadPdfjs();
  const t1 = Date.now();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(repaired.buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    // A password-protected or structurally broken file is a normal outcome, not
    // an exception the caller should have to catch.
    const err = new Error(e && e.name === 'PasswordException' ? 'pdf_encrypted' : `pdf_open_failed:${e.message}`);
    err.code = e && e.name === 'PasswordException' ? 'pdf_encrypted' : 'pdf_open_failed';
    throw err;
  }

  const declaredPages = doc.numPages;
  const readPages = Math.min(declaredPages, limits.maxPdfPages);
  if (readPages < declaredPages) warnings.push(`page_limit:${readPages}/${declaredPages}`);

  const pages = [];
  let runCount = 0;
  for (let i = 1; i <= readPages; i++) {
    if (deadline && deadline.expired()) { warnings.push(`pdf_deadline_at_page:${i}`); break; }
    let page;
    try { page = await doc.getPage(i); }
    catch (e) { warnings.push(`page_failed:${i}:${e.message}`); continue; }
    try {
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const runs = [];
      for (const item of content.items) {
        if (item.type) continue;                      // marked-content marker
        if (!item.str) continue;
        if (runs.length >= MAX_RUNS_PER_PAGE) { warnings.push(`run_limit:page${i}`); break; }
        const m = pdfjs.Util.transform(viewport.transform, item.transform);
        const angle = Math.atan2(m[1], m[0]);
        const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]) || 0;
        const w = item.width || 0;
        runs.push({
          text: item.str,
          x: round(m[4]),
          y: round(m[5]),
          w: round(w),
          h: round(size),
          angle: round(angle, 3),
          eol: Boolean(item.hasEOL),
          font: item.fontName || null,
        });
      }
      runCount += runs.length;
      pages.push({ index: i, width: round(viewport.width), height: round(viewport.height),
        rotation: page.rotate || 0, runs });
    } catch (e) {
      warnings.push(`page_text_failed:${i}:${e.message}`);
      pages.push({ index: i, width: 0, height: 0, rotation: 0, runs: [] });
    } finally {
      try { page.cleanup(); } catch { /* ignore */ }
    }
  }

  let info = {}; let metadata = null;
  try {
    const md = await doc.getMetadata();
    info = md.info || {};
    metadata = md.metadata ? md.metadata.getAll() : null;
  } catch (e) { warnings.push(`metadata_failed:${e.message}`); }

  const form = await readAcroForm(doc, repaired.buffer, warnings);

  try { await doc.destroy(); } catch { /* ignore */ }

  // Safety net for the rare case where the CMap could not be patched in place.
  if (repaired.textFixes.size) {
    const chars = [...new Set([...repaired.textFixes.values()])];
    if (chars.length === 1) {
      for (const p of pages) for (const r of p.runs) r.text = r.text.replace(/\u0000/g, chars[0]);
      warnings.push('cmap_repaired_textually');
    }
  }

  return {
    pages,
    declaredPages,
    runCount,
    info: cleanInfo(info),
    xmp: metadata,
    form,
    repairs: repaired.repairs,
    warnings,
    timings: { repair: repairMs, pdfjs: Date.now() - t1 },
  };
}

/**
 * AcroForm values.
 *
 * Worth the trouble: a form-filled invoice or claim carries its values in the
 * field dictionary, where they are exact. The rendered appearance stream is a
 * picture of the same value and is what text extraction sees — often clipped,
 * sometimes absent entirely for fields the viewer was expected to draw.
 */
async function readAcroForm(doc, buffer, warnings) {
  const out = {};
  try {
    const objs = await doc.getFieldObjects();
    if (objs) {
      for (const [name, arr] of Object.entries(objs)) {
        for (const f of arr || []) {
          const v = normaliseFieldValue(f);
          if (v !== null && v !== '') { out[name] = v; break; }
        }
      }
    }
  } catch (e) { warnings.push(`acroform_failed:${e.message}`); }

  if (Object.keys(out).length) return out;

  // pdf.js only reports fields it considers part of a real AcroForm. Some
  // generators emit widget annotations with values and no /AcroForm entry;
  // read those straight out of the object graph rather than lose them.
  try {
    const raw = new PdfDoc(buffer);
    for (const num of raw.find((d) => d.FT !== undefined || (d.Subtype === 'Widget' && d.T !== undefined))) {
      const d = raw.get(num).dict;
      const name = pdfString(raw.resolve(d.T));
      const value = raw.resolve(d.V);
      if (!name) continue;
      const v = typeof value === 'string' ? value : pdfString(value);
      if (v !== null && v !== '') out[name] = v;
    }
  } catch { /* best effort */ }
  return out;
}

function pdfString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v !== 'object') return null;
  let bytes = null;
  if (v.__str !== undefined) bytes = Buffer.from(v.__str, 'latin1');
  else if (v.__hex !== undefined) bytes = Buffer.from(v.__hex.length % 2 ? v.__hex + '0' : v.__hex, 'hex');
  if (!bytes) return null;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('latin1');
}

function normaliseFieldValue(f) {
  if (!f) return null;
  const v = f.value;
  if (v == null) return null;
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').join(', ') || null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v).trim();
  if (!s || s === 'Off') return null;
  return s;
}

function cleanInfo(info) {
  const out = {};
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer',
    'CreationDate', 'ModDate', 'PDFFormatVersion', 'Language', 'IsAcroFormPresent', 'IsXFAPresent']) {
    const v = info[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  if (typeof out.CreationDate === 'string') out.created_at = pdfDate(out.CreationDate);
  if (typeof out.ModDate === 'string') out.modified_at = pdfDate(out.ModDate);
  return out;
}

/** `D:20260825081424+00'00'` -> ISO-8601, or null. Never guess a timezone. */
function pdfDate(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+-Z])(\d{2})'?(\d{2})?)?/.exec(String(s));
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, tzh, tzm = '00'] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  iso += tz === 'Z' || !tz ? 'Z' : `${tz}${tzh}:${tzm}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : 0);

module.exports = { extractPdf, pdfDate, loadPdfjs };
