'use strict';
const { findAmounts, parseNumber } = require('./numbers');
const { toIsoDate } = require('./dates');

/**
 * The anti-hallucination check of CONTRACT §1 / §1a.1.
 *
 * It runs on EVERY source, not only on `llm`. A rule can synthesise an evidence
 * string just as easily as a model can — the hold-out corpus caught this build
 * publishing `"Description | Amount Q3 display campaign … | -450.00"` at 0.98,
 * a string the message never contained, because it was assembled from a table
 * we had already parsed.
 *
 * Three holes the hold-out demonstrated, all closed here:
 *  1. a short evidence string used to pass automatically. Now nothing passes
 *     for being short; too short simply fails.
 *  2. the haystack used to be subject+text+html joined together, so a span
 *     straddling the subject→body seam "verified" although it existed nowhere
 *     contiguously. Each surface is now checked separately.
 *  3. a real-but-irrelevant quote used to launder an invented value:
 *     {"value":"INV-99999","evidence":"My extension is 4471."} passed. The
 *     evidence must now actually SUPPORT the value — that is the entire point
 *     of an evidence span.
 */

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The separate text surfaces a value may legitimately have come from. */
function surfacesOf(mime) {
  const out = [];
  const push = (label, text) => { const n = norm(text); if (n.length > 1) out.push({ label, text: n, raw: String(text || '') }); };
  push('subject', mime.headers && mime.headers.subject);
  push('text', mime.body && mime.body.text);
  push('text_from_html', mime.body && mime.body.text_from_html);
  push('html', mime.body && mime.body.html);
  const fw = mime.body && mime.body.forwarded_from;
  if (fw) push('forwarded_from', [fw.subject, fw.from && fw.from.email, fw.date].filter(Boolean).join(' '));
  for (const a of mime.attachments || []) push('attachment_filename', a.filename);
  // Each table separately: a span may not straddle two of them either.
  for (const t of mime.tables || []) {
    push(`table:${t.index}`, [t.headers.join(' '), ...t.rows.map((r) => r.join(' '))].join(' '));
  }
  return out;
}

/** Every plausible textual form of a value, for the "does it support it" test. */
function valueForms(rawValue, coercedValue) {
  const forms = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    const s = norm(v);
    if (s.length >= 1) forms.add(s);
  };
  for (const v of [rawValue, coercedValue]) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (v.amount !== undefined) { add(v.amount); add(numberForms(v.amount)); }
      continue;
    }
    if (Array.isArray(v)) continue;
    add(v);
    if (typeof v === 'number') for (const f of numberForms(v)) add(f);
    else {
      const n = parseNumber(String(v));
      if (n !== null) for (const f of numberForms(n)) add(f);
    }
  }
  return [...forms].filter(Boolean);
}

/** 1234.5 -> "1234.5", "1234.50", "1,234.50", "1.234,50", "1234,50", "1234" */
function numberForms(n) {
  if (typeof n !== 'number' || !isFinite(n)) return [];
  const a = Math.abs(n);
  const fixed = a.toFixed(2);
  const plain = String(a);
  const int = String(Math.trunc(a));
  const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const euro = fixed.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d),)/g, '.');
  return [plain, fixed, int, grouped, euro, fixed.replace('.', ',')].map(norm);
}

/**
 * @returns {{given:boolean, ok:boolean, reason:string|null, surface:string|null}}
 */
function verify(evidence, rawValue, coercedValue, field, surfaces) {
  if (evidence === null || evidence === undefined || String(evidence).trim() === '') {
    return { given: false, ok: false, reason: null, surface: null };
  }
  const e = norm(evidence);
  // No free pass for being short. Two characters cannot be evidence of anything.
  if (e.length < 4) return { given: true, ok: false, reason: 'too_short', surface: null };

  const hit = surfaces.find((s) => s.text.includes(e));
  if (!hit) return { given: true, ok: false, reason: 'not_verbatim', surface: null };

  // The span must actually support the value it is cited for.
  if (coercedValue !== null && coercedValue !== undefined && !Array.isArray(coercedValue)) {
    if (!supports(e, rawValue, coercedValue, field)) {
      return { given: true, ok: false, reason: 'value_absent', surface: hit.label };
    }
  }
  return { given: true, ok: true, reason: null, surface: hit.label };
}

function supports(e, rawValue, coercedValue, field) {
  const forms = valueForms(rawValue, coercedValue);
  for (const f of forms) if (f.length >= 2 && e.includes(f)) return true;

  const type = (field && field.type) || 'string';
  // A date's evidence is nearly always the human form: value 2026-09-08 cited
  // as "Due September 8, 2026". Re-read the span and see if it yields the value.
  if (type === 'date' || type === 'datetime') {
    const iso = String(coercedValue).slice(0, 10);
    const back = toIsoDate(e, {});
    if (back === iso) return true;
    const { findDates } = require('./dates');
    if (findDates(e, {}).some((d) => d.value === iso)) return true;
  }
  if (type === 'number' || type === 'integer' || type === 'currency') {
    const want = typeof coercedValue === 'object' && coercedValue ? coercedValue.amount : coercedValue;
    const n = typeof want === 'number' ? want : parseNumber(String(want));
    if (n === null) return false;
    if (findAmounts(e, null, { dedupe: false }).some((a) => Math.abs(a.value - n) < 0.005)) return true;
    const bare = parseNumber(e);
    if (bare !== null && Math.abs(bare - n) < 0.005) return true;
    return false;
  }
  if (type === 'currency' || (field && field.name === 'currency')) return true;   // the code itself
  // Short codes and single tokens: a one- or two-character value cannot be checked.
  return forms.every((f) => f.length < 2);
}

/**
 * Find the tightest REAL span in one of the surfaces that covers all needles.
 * Used to build evidence for values that came out of a parsed structure, where
 * the obvious string ("a | b | c") exists only inside our own data model.
 */
function spanFor(needles, surfaces, maxLen) {
  const cap = maxLen || 240;
  const wanted = needles.map(norm).filter((n) => n.length >= 2);
  if (!wanted.length) return null;
  let best = null;
  for (const s of surfaces) {
    if (s.label === 'html') continue;                 // markup is not readable evidence
    let from = 0, lo = -1, hi = -1, all = true;
    for (const n of wanted) {
      const at = s.text.indexOf(n, from);
      if (at === -1) { all = false; break; }
      if (lo === -1) lo = at;
      hi = at + n.length;
      from = at;
    }
    if (!all || lo === -1) continue;
    if (hi - lo > cap) continue;
    if (!best || hi - lo < best.len) best = { text: s.text.slice(lo, hi), len: hi - lo };
  }
  if (best) return best.text;
  // Fall back to a span around the first needle alone.
  for (const s of surfaces) {
    if (s.label === 'html') continue;
    const at = s.text.indexOf(wanted[0]);
    if (at === -1) continue;
    return s.text.slice(at, Math.min(s.text.length, at + Math.min(cap, wanted[0].length + 60)));
  }
  return null;
}

module.exports = { verify, surfacesOf, spanFor, valueForms, norm };
