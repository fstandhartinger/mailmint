'use strict';
const { findAmounts, parseNumber } = require('./numbers');
const { splitQty } = require('./lineitems');

/**
 * Confidence is COMPUTED, not reported.
 *
 * The competitive point of this product is that a number next to an extracted
 * field means something. A language model will happily report 0.95 on a
 * purchase-order code it invented, so its self-report is one input with the
 * smallest weight, and it may only ever LOWER a score — never raise one above
 * what the verifiable signals justify.
 *
 * Verifiable signals, in descending weight:
 *   1. the evidence span is a verbatim substring of the input,
 *   2. the deterministic rule and the model independently agree,
 *   3. the value corroborates something layer (a) already found,
 *   4. the invoice arithmetic reconciles,
 *   5. the value coerced cleanly to its declared type.
 */

const CEILING = {
  rule_llm_agree: 0.97,
  rule_label: 0.95,
  header: 0.97,
  llm_evidence_and_corroborated: 0.93,
  llm_evidence: 0.85,
  llm_corroborated: 0.8,
  llm_bare: 0.6,
  llm_no_evidence: 0.55,
  hallucinated: 0.3,
  disagreement: 0.5,
};

/** Does this value already appear in the deterministic detections or tables? */
function corroborates(value, ctx) {
  if (value === null || value === undefined) return false;
  const det = ctx.detected || {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (value.amount !== undefined) {
      return (det.amounts || []).some((a) => Math.abs(a.value - value.amount) < 0.005
        && (!value.currency || a.currency === value.currency));
    }
    return false;
  }
  if (typeof value === 'number') {
    return (det.amounts || []).some((a) => Math.abs(a.value - value) < 0.005);
  }
  const s = String(value).trim();
  if (s.length < 2) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && (det.dates || []).some((d) => d.value === s.slice(0, 10))) return true;
  if ((det.ids || []).some((i) => i.value === s)) return true;
  if ((det.emails || []).includes(s)) return true;
  if ((det.urls || []).some((u) => u === s)) return true;
  const norm = s.toLowerCase();
  for (const t of ctx.tables || []) {
    for (const row of t.rows) for (const cell of row) if (String(cell).trim().toLowerCase() === norm) return true;
  }
  return false;
}

/** Loose equality between a rule value and a model value of the same field. */
function sameValue(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = typeof a === 'number' ? a : parseNumber(String(a));
    const nb = typeof b === 'number' ? b : parseNumber(String(b));
    return na !== null && nb !== null && Math.abs(na - nb) < 0.005;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    if (a.amount !== undefined && b.amount !== undefined) {
      return Math.abs(a.amount - b.amount) < 0.005 && (!a.currency || !b.currency || a.currency === b.currency);
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === 'object' || typeof b === 'object') {
    const obj = typeof a === 'object' ? a : b;
    const other = typeof a === 'object' ? b : a;
    if (obj && obj.amount !== undefined) {
      const n = parseNumber(String(other));
      return n !== null && Math.abs(obj.amount - n) < 0.005;
    }
    return false;
  }
  const sa = String(a).trim().toLowerCase().replace(/\s+/g, ' ');
  const sb = String(b).trim().toLowerCase().replace(/\s+/g, ' ');
  if (sa === sb) return true;
  // dates: one side may still be the raw literal
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && sb.includes(sa.slice(0, 10))) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(sb) && sa.includes(sb.slice(0, 10))) return true;
  return false;
}

/**
 * The arithmetic verifier. For invoices and receipts this catches exactly the
 * failure the forums are full of: forty line items in, one line item out.
 * @returns {{checked:boolean, ok:boolean, detail:string|null}}
 */
function reconcile(values, schema) {
  const byRole = {};
  for (const f of schema) {
    const n = String(f.name).toLowerCase();
    const v = values[f.name];
    if (v === undefined || v === null) continue;
    const amt = toAmount(v);
    if (/^(line_items|items|positions|lines|line_item)$/.test(n) && Array.isArray(v)) { byRole.items = v; continue; }
    if (amt === null) continue;
    if (/(^|_)(sub_?total|net(_total)?|zwischensumme|netto)$/.test(n)) byRole.subtotal = amt;
    else if (/(^|_)(tax|vat|mwst|ust|umsatzsteuer|sales_tax)$/.test(n)) byRole.tax = amt;
    else if (/(^|_)(shipping|delivery_cost|versand(kosten)?|postage)$/.test(n)) byRole.shipping = amt;
    else if (/(^|_)(discount|rabatt|coupon)$/.test(n)) byRole.discount = amt;
    else if (/(^|_)(grand_total|total|order_total|amount_due|balance|gesamtbetrag|summe)$/.test(n)) byRole.total = amt;
  }

  const checks = [];
  if (byRole.items && byRole.items.length) {
    const sum = byRole.items.reduce((n, it) => {
      const a = it && typeof it === 'object' ? toAmount(it.amount !== undefined ? it.amount : it.total) : toAmount(it);
      return n + (a === null ? 0 : a);
    }, 0);
    const target = byRole.subtotal !== undefined ? byRole.subtotal : byRole.total;
    if (target !== undefined) checks.push({ name: 'line_items_sum', ok: close(sum, target), got: sum, want: target });
  }
  const hasAdjustment = byRole.tax !== undefined || byRole.shipping !== undefined || byRole.discount !== undefined;
  if (byRole.total !== undefined && byRole.subtotal !== undefined && hasAdjustment) {
    const calc = byRole.subtotal + (byRole.tax || 0) + (byRole.shipping || 0) - (byRole.discount || 0);
    checks.push({ name: 'total_equation', ok: close(calc, byRole.total), got: calc, want: byRole.total });
  }
  if (!checks.length) return { checked: false, ok: true, detail: null };
  const bad = checks.filter((c) => !c.ok);
  return {
    checked: true,
    ok: bad.length === 0,
    detail: bad.length ? bad.map((c) => `${c.name}: ${round2(c.got)} != ${round2(c.want)}`).join('; ') : null,
    roles: Object.keys(byRole),
  };
}

function close(a, b) { return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005); }
function round2(n) { return Math.round(n * 100) / 100; }

function toAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return v.amount !== undefined ? toAmount(v.amount) : null;
  const found = findAmounts(String(v));
  if (found.length) return found[0].value;
  return parseNumber(String(v));
}

/**
 * Turn the signals into the published number.
 * @param {object} sig
 * @returns {{confidence:number, source:string, flags:string[]}}
 */
function computeConfidence(sig) {
  const flags = [];
  let source = sig.source;
  let ceiling;

  if (source === 'header') {
    ceiling = Math.min(CEILING.header, sig.ruleConfidence || CEILING.header);
  } else if (source === 'rule') {
    ceiling = Math.min(CEILING.rule_label, sig.ruleConfidence || 0.9);
    if (sig.corroborated) ceiling = Math.min(0.97, ceiling + 0.02);
  } else if (source === 'rule+llm') {
    ceiling = CEILING.rule_llm_agree;
  } else {                       // llm
    if (sig.evidenceGiven && !sig.evidenceOk) {
      // The contract's x0.5 still runs; the cap makes it near-disqualifying,
      // because a fabricated citation is the strongest negative signal we have.
      ceiling = Math.min((sig.evidenceOk ? CEILING.llm_evidence : CEILING.llm_bare) * 0.5, CEILING.hallucinated);
      flags.push('hallucinated_evidence');
    } else if (sig.evidenceOk && sig.corroborated) ceiling = CEILING.llm_evidence_and_corroborated;
    else if (sig.evidenceOk) ceiling = CEILING.llm_evidence;
    else if (sig.corroborated) ceiling = CEILING.llm_corroborated;
    else if (!sig.evidenceGiven) ceiling = CEILING.llm_no_evidence;
    else ceiling = CEILING.llm_bare;
  }

  if (sig.disagreement) { ceiling = Math.min(ceiling, CEILING.disagreement); flags.push('rule_llm_disagreement'); }

  if (sig.arithmetic === true) ceiling = Math.min(0.98, ceiling + 0.03);
  else if (sig.arithmetic === false) { ceiling = ceiling * 0.8; flags.push('arithmetic_mismatch'); }

  // The model's own number may only pull the score down.
  let conf = ceiling;
  if (typeof sig.modelConfidence === 'number' && isFinite(sig.modelConfidence)) {
    conf = Math.min(conf, Math.max(0, Math.min(1, sig.modelConfidence)));
  }
  return { confidence: Math.max(0, Math.min(1, Math.round(conf * 1000) / 1000)), source, flags };
}

/**
 * Derive an array-of-objects field straight from an extracted table.
 * This is the 500-row answer: when a real data table exists, the deterministic
 * path carries every row and the model never gets the chance to return 57.
 */
function deriveArrayFromTables(field, tables) {
  const itemFields = (field.items && field.items.fields) || null;
  let best = null;
  for (const t of tables || []) {
    if (!t.records || t.records.length < 1) continue;

    const map = mapColumns(t.headers, itemFields);
    if (!map) continue;
    const rows = t.records.filter((rec) => !isSummaryRow(rec, map)).map((rec) => {
      if (!itemFields) return rec[map._single] !== undefined ? rec[map._single] : Object.values(rec)[0];
      const o = {};
      for (const f of itemFields) o[f.name] = map[f.name] !== undefined ? rec[map[f.name]] : null;
      // "Onboarding and implementation Qty 1" -> description + quantity.
      for (const f of itemFields) {
        if (!/^(description|item|product|name|beschreibung|bezeichnung|artikel)$/i.test(f.name)) continue;
        if (typeof o[f.name] !== 'string') continue;
        const split = splitQty(o[f.name]);
        o[f.name] = split.description;
        const qf = itemFields.find((x) => /^(qty|quantity|menge|anzahl)$/i.test(x.name));
        if (qf && split.qty !== null && (o[qf.name] === null || o[qf.name] === undefined || o[qf.name] === '')) o[qf.name] = split.qty;
      }
      return o;
    }).filter((r) => r !== null && r !== undefined && (typeof r !== 'object' || Object.values(r).some((v) => v !== null && v !== '')));
    if (!rows.length) continue;
    const named = t.headers.some((h) => !/^col\d+$/.test(h)) ? 1 : 0;
    const score = named * 10000 + rows.length;
    if (!best || score > best.score) best = { rows, table: t, score };
  }
  return best;
}

/** `Total`, `Subtotal`, `Amount due` rows sit inside line-item tables and are
 *  not line items; leaving them in breaks every arithmetic check downstream. */
const SUMMARY_ROW = /^\s*(?:grand\s+)?(?:total|sub-?total|amount\s+(?:due|paid|remaining)|balance(?:\s+due)?|gesamt(?:betrag|summe)?|zwischensumme|summe|zu\s+zahlen|total\s+(?:ttc|ht|due)|importe\s+total|totale)\s*:?\s*$/i;

function isSummaryRow(rec, map) {
  const descKey = map && map.description;
  const values = descKey && rec[descKey] !== undefined ? [rec[descKey]] : Object.values(rec);
  for (const v of values) {
    if (v == null) continue;
    if (SUMMARY_ROW.test(String(v))) return true;
  }
  return false;
}

const ROLE_PATTERNS = {
  description: /^(description|item|product|artikel|bezeichnung|beschreibung|leistung|charge|d(é|e)signation|name|position|service)$/i,
  amount: /^(amount|total|betrag|price|preis|sum|line total|montant|importe|value|charge)$/i,
  quantity: /^(qty|quantity|menge|anzahl|units|quantit(é|e))$/i,
  unit_price: /^(unit|unit price|rate|einzelpreis|prix unitaire|price each)$/i,
  sku: /^(sku|art\.?-?nr\.?|artikelnummer|code|item no\.?)$/i,
};

function mapColumns(headers, itemFields) {
  if (!itemFields) {
    const first = headers.find((h) => !/^col\d+$/.test(h));
    return first ? { _single: first } : null;
  }
  const map = {};
  let matched = 0;
  for (const f of itemFields) {
    const exact = headers.find((h) => String(h).trim().toLowerCase() === f.name.toLowerCase());
    if (exact) { map[f.name] = exact; matched++; continue; }
    const pat = ROLE_PATTERNS[f.name.toLowerCase()];
    if (pat) {
      const hit = headers.find((h) => pat.test(String(h).trim()));
      if (hit) { map[f.name] = hit; matched++; continue; }
    }
    if ((f.type || 'string') === 'number') {
      // Fall back to the rightmost column that looks monetary.
      const hit = [...headers].reverse().find((h) => /amount|total|betrag|price|preis|sum|montant/i.test(h));
      if (hit) { map[f.name] = hit; matched++; continue; }
    }
  }
  return matched >= Math.min(2, itemFields.length) ? map : null;
}

module.exports = { computeConfidence, corroborates, sameValue, reconcile, deriveArrayFromTables, CEILING, toAmount };
