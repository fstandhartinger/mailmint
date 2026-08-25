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

const SUMMARY = /^(?:grand\s+)?(?:total(?:\s+(?:due|ttc|ht|paid|amount|before\s+tax))?|sub-?total|amount\s+(?:due|paid|remaining|before\s+tax)|balance(?:\s+due)?|tax|vat|mwst|ust|sales\s+tax|estimated\s+tax|shipping(?:\s*(?:&|and)\s*handling)?|versand(?:kosten)?|gesamt(?:betrag|summe)?|zwischensumme|summe|zu\s+zahlen|umsatzsteuer|mehrwertsteuer|importe\s+total|totale|net\s+total|discount|rabatt|trinkgeld|tip|item\s+subtotal)\b/i;
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
    const { description, qty } = splitQty(cleanDescription(segs[segs.length - 1]));
    if (!description || description.length < 2 || description.length > 140) continue;
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

function anchorRun(items, totals) {
  if (!totals.length) return null;
  const targets = totals.map((t) => t.amount).filter((n) => typeof n === 'number' && n !== 0);
  if (!targets.length) return null;
  let best = null;
  for (let start = 0; start < items.length; start++) {
    let sum = 0;
    for (let end = start; end < items.length; end++) {
      sum += items[end].amount || 0;
      const span = end - start + 1;
      if (!targets.some((t) => Math.abs(sum - t) <= Math.max(0.02, Math.abs(t) * 0.005))) continue;
      if (!best || span > best.length) best = items.slice(start, end + 1);
    }
  }
  return best && best.length >= 1 ? best : null;
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
 * Reconcile every available source for an array-of-objects field.
 *
 * Four sources are possible: a real <table> grid, repeating HTML structure,
 * the text/plain run, and (when packages/docs lands) the PDF attachment.
 * Agreement between two independent extractors is the strongest completeness
 * signal we have; arithmetic anchoring against the stated total is the second.
 * Nobody else in this market runs more than one, which is why "I got 57 of 533
 * rows and it said nothing" is a thing that happens to people.
 *
 * @returns {{rows:Array, sources:string[], agree:boolean, anchored:boolean, evidence:string|null}|null}
 */
function pickLineItems(field, ctx, deriveFromTables) {
  const itemFields = (field.items && field.items.fields) || null;
  const candidates = [];

  const table = deriveFromTables(field, ctx.tables);
  if (table) {
    candidates.push({
      name: table.table.source === 'html-repeat' ? 'html-repeat' : table.table.source + '-table',
      precision: table.table.headers.every((h) => /^col\d+$/.test(h)) ? 2 : 3,
      rows: table.rows,
      evidence: tableEvidence(table.table),
      anchored: false,
    });
  }

  const text = fromText(ctx.strippedText || ctx.text, { localeHint: ctx.localeHint });
  if (text) {
    candidates.push({
      name: 'text-run', precision: 1,
      rows: shapeRows(text.rows, itemFields),
      evidence: text.rows.slice(0, 3).map((r) => `${r.description} ${r.amount}`).join(' | '),
      anchored: text.anchored,
    });
  }
  if (!candidates.length) return null;

  // Arithmetic anchoring beats raw precision: a row set that adds up to the
  // stated total has proved itself complete.
  candidates.sort((a, b) => (b.anchored - a.anchored) || (b.precision - a.precision) || (b.rows.length - a.rows.length));
  const winner = candidates[0];
  const agree = candidates.length > 1 && candidates.some((c) => c !== winner && rowsEqual(c.rows, winner.rows));
  return {
    rows: winner.rows,
    sources: candidates.map((c) => c.name),
    winner: winner.name,
    agree,
    anchored: winner.anchored,
    evidence: winner.evidence,
    disagree: candidates.length > 1 && !agree,
  };
}

function tableEvidence(t) {
  if (!t || !t.rows.length) return null;
  return [t.headers.join(' | '), ...t.rows.slice(0, 2).map((r) => r.join(' | '))].join(' ');
}

module.exports = { fromText, shapeRows, sumOf, rowsEqual, cleanDescription, splitQty, pickLineItems, SUMMARY };
