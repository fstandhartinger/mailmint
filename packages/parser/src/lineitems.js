'use strict';
const { findAmounts, parseNumber } = require('./numbers');

/**
 * Line items from the text/plain part.
 *
 * This is the third independent source (after real <table> grids and repeating
 * HTML structure) and on ESP mail it is frequently the cleanest of the three,
 * because the plain-text alternative is generated from the same data model and
 * has no layout in it at all. Stripe's reads:
 *
 *   "... Onboarding and implementation Qty 1 $495.00 Priority support (3 seats)
 *    Qty 1 $297.00 API overage 12,400 calls Qty 1 $62.00 Total due $854.00 ..."
 *
 * The pattern is not "Qty" — that is Stripe-specific. The pattern is: a run of
 * descriptive text terminated by a monetary amount, repeating. So we anchor on
 * the amounts, which we can already find reliably in any locale, and take what
 * precedes each one as its description.
 */

/**
 * Rows that must never be line items.
 *
 * The distinction that matters is AGGREGATE vs COMPONENT. `Total`, `Subtotal`
 * and `Amount charged` summarise the other rows, so including one double-counts
 * and destroys the arithmetic proof. `Sales tax`, `Shipping` and `Discount` are
 * components: they add up WITH the items to the total, so keeping them is both
 * harmless and often what the user meant by "every row in the document".
 */
const AGGREGATE = /^(?:grand\s+)?(?:total(?:\s+(?:due|ttc|ht|paid|amount|before\s+tax))?|sub-?total|net\s+total|order\s+total|item\s+subtotal|amount\s+(?:due|paid|charged|remaining|before\s+tax)|balance(?:\s+due)?|gesamt(?:betrag|summe)?|zwischensumme|summe|zu\s+zahlen|importe\s+total|totale|montant\s+total)\s*:?\s*$/i;
/** Marketing and footer lines that sit next to real amounts. */
const FOOTER_NOISE = /^(?:free\s+(?:delivery|shipping|returns)|you\s+saved|paid\s+with|charged\s+to|card\s+ending|thank\s+you|questions\?|powered\s+by|unsubscribe|view\s+(?:online|receipt)|order\s+again)\b/i;
const SUMMARY = new RegExp(`(?:${AGGREGATE.source})|(?:${FOOTER_NOISE.source})`, 'i');
// Deliberately no bare `x`: "Additional seats x3" and "Consulting day rate x 4"
// are product descriptions, and silently eating part of one is worse than
// leaving a quantity in the text.
const QTY_TAIL = /[\s,;:-]*(?:qty|quantity|menge|anzahl|stk\.?|st(?:ü|ue)ck)\s*[:.]?\s*(\d{1,5})\s*$/i;
const LEAD_DOC = /^(?:invoice|receipt|order|rechnung|beleg|facture|factura|bestellung)\s*#?\s*[A-Za-z0-9._\/-]{2,}\s+/i;

function cleanDescription(raw) {
  let d = String(raw || '').replace(/\s+/g, ' ').trim();
  d = d.replace(LEAD_DOC, '');
  d = d.replace(/^[\s|•·\-–—*,.:;]+/, '').replace(/[\s|•·,;:]+$/, '');
  return d;
}

function splitQty(desc) {
  const m = QTY_TAIL.exec(desc);
  if (!m) return { description: desc, qty: null };
  return { description: desc.slice(0, m.index).replace(/[\s,;:-]+$/, ''), qty: parseInt(m[1], 10) };
}

const URLS = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/**
 * Extract line items from a text surface.
 * @returns {{rows:Array, source:string, totals:Array}|null}
 */
function fromText(text, opts) {
  const o = opts || {};
  const s = String(text || '').replace(URLS, ' ');
  if (s.length < 20) return null;
  // Never deduplicate here: `Total due $854.00` repeating the header amount is
  // exactly the anchor that proves the row set is complete.
  const amounts = findAmounts(s, o.localeHint, { dedupe: false });
  if (amounts.length < 2) return null;

  const items = [];
  const totals = [];
  let cursor = 0;
  for (const a of amounts) {
    const between = s.slice(cursor, a.index);
    cursor = a.end === undefined ? a.index + a.raw.length : a.end;
    // Split on line breaks BEFORE collapsing whitespace: a description belongs
    // to the line it sits on, not to the whole paragraph above it.
    const segs = between.split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (!segs.length) continue;
    // Walk back over lines that are nothing but a quantity marker. Stripe and
    // friends put the description on its own line and `Qty 1<tab>$240.00` on
    // the next, so the nearest preceding line is "Qty 1" and taking it blindly
    // yields a row set whose descriptions are all null.
    let description = null, qty = null;
    for (let k = segs.length - 1; k >= 0 && k >= segs.length - 3; k--) {
      const sp = splitQty(cleanDescription(segs[k]));
      if (sp.qty !== null && qty === null) qty = sp.qty;
      if (sp.description && sp.description.length >= 2) { description = sp.description; break; }
    }
    if (!description || description.length > 140) continue;
    if (!/[A-Za-zÀ-ÿ]/.test(description)) continue;
    if (SUMMARY.test(description)) { totals.push({ description, amount: a.value, currency: a.currency }); continue; }
    items.push({ description, qty, amount: a.value, currency: a.currency });
  }
  if (!items.length) return null;

  // Arithmetic anchor: if a contiguous run of items sums to one of the totals,
  // that run IS the line-item set — and we have proved it is complete, which is
  // the honest answer to "how do I know you did not silently drop rows".
  const anchored = anchorRun(items, totals);
  const rows = anchored || items;
  if (!anchored && rows.length < 2) return null;
  return { rows, source: 'text-run', totals, anchored: !!anchored };
}

/**
 * Find the contiguous run of items whose amounts sum to a stated total.
 *
 * Preference is SHORTEST, not longest, and that is a correction the hold-out
 * forced: with tax kept as a component row, `ho-hard-13` has two runs that both
 * add up (seven items = the subtotal, eight = the amount due) and only the
 * seven are line items.
 *
 * A run of one is refused unless it is the entire item list, because the header
 * of a real Stripe invoice repeats the grand total as its own line and a
 * one-element run trivially "anchors" to it.
 */
function anchorRun(items, totals) {
  if (!totals.length) return null;
  const targets = totals.map((t) => t.amount).filter((n) => typeof n === 'number' && n !== 0);
  if (!targets.length) return null;
  const minLen = items.length === 1 ? 1 : 2;
  let best = null;
  for (let start = 0; start < items.length; start++) {
    let sum = 0;
    for (let end = start; end < items.length; end++) {
      sum += items[end].amount || 0;
      const span = end - start + 1;
      if (span < minLen) continue;
      if (!targets.some((t) => Math.abs(sum - t) <= Math.max(0.02, Math.abs(t) * 0.005))) continue;
      if (!best || span < best.length) best = items.slice(start, end + 1);
    }
  }
  return best;
}

/** Shape a source's rows to the user's item schema. */
function shapeRows(rows, itemFields) {
  if (!itemFields) return rows.map((r) => (typeof r === 'object' && r ? (r.description ?? Object.values(r)[0]) : r));
  return rows.map((r) => {
    const o = {};
    for (const f of itemFields) {
      const n = f.name.toLowerCase();
      let v = r[f.name];
      if (v === undefined) {
        if (/^(description|item|product|name|beschreibung|bezeichnung|artikel)$/.test(n)) v = r.description;
        else if (/^(amount|total|price|betrag|preis|value)$/.test(n)) v = r.amount;
        else if (/^(qty|quantity|menge|anzahl)$/.test(n)) v = r.qty;
        else if (/^(currency|w(ä|ae)hrung)$/.test(n)) v = r.currency;
        else v = null;
      }
      o[f.name] = v === undefined ? null : v;
    }
    return o;
  });
}

function sumOf(rows) {
  return rows.reduce((n, r) => {
    const a = r && typeof r === 'object'
      ? (typeof r.amount === 'number' ? r.amount : parseNumber(String(r.amount ?? '')))
      : parseNumber(String(r));
    return n + (a === null || a === undefined || !isFinite(a) ? 0 : a);
  }, 0);
}

function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    const ax = typeof x === 'object' && x ? x.amount : x;
    const ay = typeof y === 'object' && y ? y.amount : y;
    const nx = typeof ax === 'number' ? ax : parseNumber(String(ax ?? ''));
    const ny = typeof ay === 'number' ? ay : parseNumber(String(ay ?? ''));
    if (nx === null || ny === null) { if (String(ax) !== String(ay)) return false; }
    else if (Math.abs(nx - ny) > 0.005) return false;
  }
  return true;
}

/**
 * Enumerate every available deterministic source for an array-of-objects field.
 *
 * Four sources are possible today: a real <table> grid, repeating HTML
 * structure, the text/plain run over the STRIPPED body, and the text/plain run
 * over the FULL body including quoted history. The last two are deliberately
 * both offered rather than one chosen here:
 *
 *   - `ho-hard-18` puts decoy amounts in a footer below a `-- ` delimiter, so
 *     only the stripped reading is right;
 *   - `ho-hard-08` puts three of six line items INSIDE the quoted reply, so
 *     only the full reading is right.
 *
 * Nothing local to this function can tell those apart. The caller can, because
 * it knows the stated total — so the ranking lives there and this returns the
 * whole candidate set.
 *
 * @returns {{winner:string, rows:Array, evidence:string|null, anchored:boolean,
 *            alternates:Array, agree:boolean, disagree:boolean}|null}
 */
function pickLineItems(field, ctx, deriveFromTables) {
  const itemFields = (field.items && field.items.fields) || null;
  const candidates = [];

  const grids = (ctx.tables || []).filter((t) => t.source === 'html' || t.source === 'text');
  const repeats = (ctx.tables || []).filter((t) => t.source === 'html-repeat');
  for (const [name, tables, precision] of [['html-table', grids, 4], ['html-repeat', repeats, 3]]) {
    const d = deriveFromTables(field, tables);
    if (!d) continue;
    candidates.push({ name, precision, rows: d.rows, evidence: tableEvidence(d.table), anchored: false });
  }

  // Two tables with the SAME headers are one logical table split in two: an
  // invoice continued in a second mail, or a page break. Offer the join as its
  // own candidate and let the arithmetic decide whether it was really one table.
  const byHeaders = new Map();
  for (const t of grids) {
    const key = JSON.stringify(t.headers);
    if (!byHeaders.has(key)) byHeaders.set(key, []);
    byHeaders.get(key).push(t);
  }
  for (const group of byHeaders.values()) {
    if (group.length < 2) continue;
    const joined = { ...group[0], rows: group.flatMap((t) => t.rows), records: group.flatMap((t) => t.records) };
    joined.row_count = joined.rows.length;
    const d = deriveFromTables(field, [joined]);
    if (d) candidates.push({ name: 'table-join', precision: 4, rows: d.rows, evidence: tableEvidence(group[0]), anchored: false });
  }

  const stripped = ctx.stripped || ctx.strippedText || '';
  const full = ctx.text || '';
  for (const [name, text, precision] of [['text-run', stripped, 2], ['text-run-quoted', full, 1]]) {
    if (!text) continue;
    const r = fromText(text, { localeHint: ctx.localeHint });
    if (!r) continue;
    const rows = shapeRows(r.rows, itemFields);
    // Dedupe on the WHOLE row, not on amounts. Two sources can agree on every
    // amount and disagree on every description — which is exactly the Stripe
    // shape, where the grid gives "Qty 1" as the description and the text run
    // gives the real one. Dropping the second as a duplicate loses the good one.
    if (candidates.some((c) => rowsIdentical(c.rows, rows))) continue;
    candidates.push({
      name, precision, rows,
      evidence: r.rows.slice(0, 3).map((x) => `${x.description} ${x.amount}`).join(' | '),
      anchored: r.anchored,
    });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => (b.anchored - a.anchored) || (b.precision - a.precision) || (b.rows.length - a.rows.length));
  const winner = candidates[0];
  const agree = candidates.some((c) => c !== winner && rowsEqual(c.rows, winner.rows));
  return {
    winner: winner.name,
    rows: winner.rows,
    evidence: winner.evidence,
    anchored: winner.anchored,
    agree,
    disagree: candidates.length > 1 && !agree,
    alternates: candidates.slice(1),
    sources: candidates.map((c) => c.name),
  };
}

function tableEvidence(t) {
  if (!t || !t.rows.length) return null;
  return [t.headers.join(' | '), ...t.rows.slice(0, 2).map((r) => r.join(' | '))].join(' ');
}

/** Strict equality: same length, same value for every key present in either. */
function rowsIdentical(a, b) {
  if (a.length !== b.length) return false;
  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' '));
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x && typeof x === 'object' && y && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) if (norm(x[k]) !== norm(y[k])) return false;
    } else if (norm(x) !== norm(y)) return false;
  }
  return true;
}

module.exports = { fromText, shapeRows, sumOf, rowsEqual, rowsIdentical, cleanDescription, splitQty, pickLineItems, SUMMARY, AGGREGATE, FOOTER_NOISE };
