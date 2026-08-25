'use strict';
const { findAmounts, parseNumber } = require('./numbers');
const { findDates } = require('./dates');

/**
 * Deterministic, label-driven field extraction — layer (a) applied to the
 * user's schema.
 *
 * Every field we can satisfy here at >= 0.9 confidence is a field we do not
 * send to the model, which is most of the cost and most of the latency of a
 * parse. Transactional mail is templated, so labels work far more often than
 * people expect: "Total:", "Invoice #", "Bestellnummer:" are stable strings.
 */

/** Synonym table. Keys are matched against a normalised field name. */
const SYNONYMS = {
  total: ['total', 'total due', 'amount due', 'total amount', 'grand total', 'balance due',
    'amount', 'total paid', 'order total', 'gesamtbetrag', 'gesamtsumme', 'summe', 'betrag',
    'rechnungsbetrag', 'zu zahlen', 'endbetrag', 'montant total', 'importe total', 'total a pagar'],
  subtotal: ['subtotal', 'sub total', 'net amount', 'net total', 'zwischensumme', 'nettobetrag', 'netto'],
  tax: ['tax', 'vat', 'sales tax', 'gst', 'mwst', 'mehrwertsteuer', 'umsatzsteuer', 'ust', 'tva', 'iva'],
  shipping: ['shipping', 'delivery', 'postage', 'versand', 'versandkosten', 'frais de port'],
  discount: ['discount', 'rabatt', 'nachlass', 'coupon', 'promotion'],
  amount_paid: ['amount paid', 'paid', 'payment', 'gezahlt', 'bezahlt'],
  amount_remaining: ['amount remaining', 'balance', 'outstanding', 'offen', 'restbetrag'],
  invoice_number: ['invoice number', 'invoice no', 'invoice #', 'invoice id', 'invoice',
    'rechnungsnummer', 'rechnungs-nr', 'rechnungsnr', 'rechnung nr', 'facture', 'factura',
    'beleg-nr', 'belegnummer'],
  order_number: ['order number', 'order no', 'order #', 'order id', 'order', 'bestellnummer',
    'bestell-nr', 'auftragsnummer', 'auftrags-nr', 'numero de pedido', 'numero de commande'],
  receipt_number: ['receipt number', 'receipt no', 'receipt #', 'receipt', 'quittungsnummer', 'belegnummer'],
  customer_number: ['customer number', 'customer no', 'customer id', 'account number',
    'kundennummer', 'kunden-nr', 'kundennr'],
  tracking_number: ['tracking number', 'tracking no', 'tracking #', 'tracking id', 'tracking code',
    'sendungsnummer', 'sendungs-nr', 'paketnummer', 'awb', 'waybill'],
  po_number: ['po number', 'po #', 'purchase order', 'purchase order number', 'bestellreferenz'],
  reference: ['reference', 'reference number', 'ref', 'referenz', 'verwendungszweck'],
  vat_id: ['vat id', 'vat number', 'ust-idnr', 'ustidnr', 'umsatzsteuer-id', 'tva intracom'],
  due_date: ['due date', 'payment due', 'due on', 'due', 'pay by', 'payable by',
    'faelligkeitsdatum', 'fälligkeitsdatum', 'faellig am', 'fällig am', 'zahlbar bis',
    'date d\'echeance', 'fecha de vencimiento'],
  invoice_date: ['invoice date', 'date of invoice', 'issued', 'issue date', 'issued on', 'date',
    'rechnungsdatum', 'belegdatum', 'datum', 'ausstellungsdatum',
    'date de facture', 'date facture', 'fecha de factura', 'data fattura', 'datum factuur'],
  order_date: ['order date', 'ordered on', 'bestelldatum', 'bestellt am', 'date de commande'],
  payment_date: ['payment date', 'paid on', 'paid at', 'paid', 'date paid', 'charged on',
    'zahlungsdatum', 'bezahlt am', 'gezahlt am'],
  delivery_date: ['delivery date', 'estimated delivery', 'expected delivery', 'arriving',
    'lieferdatum', 'liefertermin', 'voraussichtliche zustellung', 'zustellung'],
  ship_date: ['ship date', 'shipped on', 'shipped', 'versanddatum', 'versendet am'],
  currency: ['currency', 'waehrung', 'währung'],
  vendor: ['vendor', 'supplier', 'merchant', 'seller', 'from', 'company', 'biller',
    'lieferant', 'haendler', 'händler', 'verkaeufer', 'verkäufer', 'firma'],
  customer_name: ['customer', 'customer name', 'bill to', 'billed to', 'sold to', 'kunde',
    'kundenname', 'rechnungsempfaenger', 'rechnungsempfänger'],
  carrier: ['carrier', 'shipped via', 'shipping carrier', 'versanddienstleister', 'versandart', 'transporteur'],
  status: ['status', 'payment status', 'zahlungsstatus', 'zustand'],
  quantity: ['quantity', 'qty', 'menge', 'anzahl', 'stueckzahl', 'stückzahl'],
  description: ['description', 'item', 'product', 'beschreibung', 'artikel', 'bezeichnung', 'leistung'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'telefon', 'handy'],
  name: ['name', 'full name', 'vollstaendiger name'],
  address: ['address', 'shipping address', 'billing address', 'adresse', 'lieferadresse', 'rechnungsadresse'],
  payment_method: ['payment method', 'paid with', 'payment', 'zahlungsart', 'zahlungsmethode'],
  subject: ['subject', 'betreff'],
  company: ['company', 'organisation', 'organization', 'firma', 'unternehmen'],
  message: ['message', 'comment', 'comments', 'nachricht', 'kommentar', 'anmerkung'],
};

/** field name -> `detected.ids` kind, when they line up. */
const ID_KIND_FOR = {
  invoice_number: 'invoice_number', invoice_no: 'invoice_number', invoice_id: 'invoice_number',
  invoicenumber: 'invoice_number', rechnungsnummer: 'invoice_number',
  order_number: 'order_number', order_no: 'order_number', order_id: 'order_number',
  ordernumber: 'order_number', bestellnummer: 'order_number',
  tracking_number: 'tracking_number', tracking_id: 'tracking_number', trackingnumber: 'tracking_number',
  sendungsnummer: 'tracking_number',
  customer_number: 'customer_number', customer_id: 'customer_number', kundennummer: 'customer_number',
  po_number: 'po_number', purchase_order: 'po_number',
  receipt_number: 'receipt_number', reference: 'reference', vat_id: 'vat_id', vat_number: 'vat_id',
};

function normName(n) { return String(n || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function humanise(n) { return normName(n).replace(/_/g, ' '); }

/** All the label strings worth looking for, most specific first. */
function labelsFor(field) {
  const key = normName(field.name);
  const out = [];
  const push = (s) => { const t = String(s || '').trim().toLowerCase(); if (t && t.length > 1 && !out.includes(t)) out.push(t); };
  // A hint names the label explicitly, so it outranks our own guesses.
  const hint = String(field.hint || '');
  for (const m of hint.matchAll(/(?:labell?ed|label|marked|called|named|beschriftet)\s+(?:as\s+)?["']?([A-Za-z][A-Za-z .#/-]{1,28}?)["']?(?=\s*(?:,|;|\.|$|\bor\b|\band\b|\boder\b))/gi)) push(m[1]);
  for (const m of hint.matchAll(/["'`]([^"'`]{2,30})["'`]/g)) push(m[1]);
  // A short hint is usually just the label itself: hint: "Gesamtbetrag".
  const bare = hint.trim();
  if (bare && bare.length <= 34 && bare.split(/\s+/).length <= 4
      && !/\b(labell?ed|label|marked|called|named|the|a|an|beschriftet|grand|including|incl)\b/i.test(bare)) {
    push(bare.replace(/[.:,;]+$/, ''));
  }
  if (SYNONYMS[key]) SYNONYMS[key].forEach(push);
  push(humanise(field.name));
  push(String(field.name || '').replace(/_/g, ''));
  for (const m of String(field.description || '').matchAll(/["'`]([^"'`]{2,30})["'`]/g)) push(m[1]);
  return orderLabels(out);
}

/**
 * Keep the authored order (best guess first) but make sure that within one
 * family the longer label is tried first, so `Total due:` is not swallowed by
 * the shorter `total` pattern failing to match it.
 */
function orderLabels(labels) {
  const groups = new Map();
  for (const l of labels) {
    const head = l.split(/\s+/)[0];
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(l);
  }
  const out = [];
  for (const g of groups.values()) { g.sort((a, b) => b.length - a.length); out.push(...g); }
  return out;
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The value pattern to look for after a label, by field type. */
function valuePattern(type) {
  switch (type) {
    case 'number': case 'integer': case 'currency':
      return '([-(]?[^\\S\\n]*(?:[A-Z]{3}[^\\S\\n]*)?[$\\u20ac\\u00a3\\u00a5\\u20b9]?[^\\S\\n]*-?\\d[\\d.,\'\\u00a0\\u2019 ]*(?:[.,]\\d{1,4})?[^\\S\\n]*(?:[A-Z]{3}|[$\\u20ac\\u00a3\\u00a5\\u20b9])?[^\\S\\n]*[-)]?)';
    case 'date': case 'datetime':
      return '([^\\n\\t]{4,60})';
    case 'email':
      return '([A-Za-z0-9!#$%&\'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)';
    case 'url':
      return '((?:https?://|www\\.)[^\\s<>"\']+)';
    default:
      return '([^\\n\\r\\t]{1,160})';
  }
}

/**
 * Find `Label: value` (or `Label` + wide gap + `value`) in a text surface.
 * Returns the best hit with its evidence string.
 */
function labelSearch(text, labels, type) {
  if (!text) return null;
  const vp = valuePattern(type);
  for (const label of labels) {
    const L = esc(label);
    const variants = [
      { re: new RegExp('(?:^|\\n|\\t|\\u2022|\\|)[^\\S\\n]{0,8}' + L + '\\s*[:\\uff1a]\\s*' + vp, 'i'), conf: 0.95 },
      { re: new RegExp('(?:^|\\n|\\t)[^\\S\\n]{0,8}' + L + '[ \\t]{2,}' + vp, 'i'), conf: 0.92 },
      { re: new RegExp('(?:^|\\n|\\t)[^\\S\\n]{0,8}' + L + '\\s*[#\\u2116]\\s*' + vp, 'i'), conf: 0.93 },
      { re: new RegExp('\\b' + L + '\\s*[:\\uff1a]\\s*' + vp, 'i'), conf: 0.9 },
      { re: new RegExp('\\b' + L + '\\s*[#\\u2116]\\s*' + vp, 'i'), conf: 0.88 },
      { re: new RegExp('(?:^|\\n)[^\\S\\n]{0,8}' + L + '[ \\t]*\\n[ \\t]*' + vp, 'i'), conf: 0.82 },
      // "Paid August 21, 2026" — a single space, no colon. Only safe for typed
      // fields, where the value pattern itself has to parse for the hit to count.
      ...(type === 'string' || type === 'enum' ? []
        : [{ re: new RegExp('(?:^|\\n|\\t|>)[^\\S\\n]{0,8}' + L + '[ \\t]' + vp, 'i'), conf: 0.78 }]),
    ];
    for (const v of variants) {
      const m = v.re.exec(text);
      if (!m) continue;
      const raw = (m[1] || '').trim().replace(/[.,;]$/, '');
      if (!raw) continue;
      if (/^(?:$|[-–—]$)/.test(raw)) continue;
      return { raw, confidence: v.conf, evidence: m[0].replace(/^[\n\t| ]+/, '').trim() };
    }
  }
  return null;
}

/**
 * Look a field up in the extracted tables.
 *
 * Two shapes matter and they are searched in that order:
 *  1. a LABEL CELL followed by a value cell in the same row — this is how
 *     `Total due | | $854.00` looks after an ESP's layout table is flattened;
 *  2. a named column, but only in a single-row table. In a multi-row table an
 *     `Amount` column heading does NOT answer "what is the total" — it would
 *     return the first line item, which is exactly the wrong answer.
 */
function tableSearch(tables, labels, type) {
  for (const label of labels) {
    for (const t of tables || []) {
      for (const row of t.rows) {
        const idx = row.findIndex((c) => String(c || '').trim().toLowerCase().replace(/[:\s]+$/, '') === label);
        if (idx === -1) continue;
        const v = row.slice(idx + 1).reverse().find((c) => String(c || '').trim() !== '');
        if (v === undefined) continue;
        return { raw: String(v).trim(), confidence: 0.9, evidence: `${row[idx]} ${v}`.replace(/\s+/g, ' ').trim() };
      }
    }
  }
  for (const label of labels) {
    for (const t of tables || []) {
      if (t.rows.length !== 1) continue;
      const key = t.headers.find((h) => String(h).trim().toLowerCase() === label);
      if (!key) continue;
      const v = t.records[0][key];
      if (v == null || String(v).trim() === '') continue;
      return { raw: String(v).trim(), confidence: 0.88, evidence: `${key}: ${v}` };
    }
  }
  return null;
}

/**
 * Try to satisfy one schema field deterministically.
 * @returns {{value:*, confidence:number, source:string, evidence:string}|null}
 */
function ruleExtract(field, ctx) {
  const type = (field.type || 'string').toLowerCase();
  const key = normName(field.name);
  const labels = labelsFor(field);

  // 1. A detected id of the matching kind is as good as it gets.
  const idKind = ID_KIND_FOR[key];
  if (idKind) {
    const hit = (ctx.detected.ids || []).find((i) => i.kind === idKind);
    if (hit) {
      return { value: hit.value, confidence: Math.min(0.95, hit.confidence + 0.05),
        source: 'rule', evidence: evidenceAround(ctx.searchable, hit.value) };
    }
  }

  // 2. Header-derived fields.
  if (ctx.headers) {
    if (/^(from_email|sender_email|sender|from)$/.test(key) && type === 'email' && ctx.headers.from) {
      return { value: ctx.headers.from.email, confidence: 0.98, source: 'header', evidence: ctx.headers.from.email };
    }
    if (/^(subject|betreff)$/.test(key) && ctx.headers.subject) {
      return { value: ctx.headers.subject, confidence: 0.97, source: 'header', evidence: ctx.headers.subject };
    }
    if (/^(vendor|merchant|supplier|seller|company|absender)$/.test(key) && ctx.headers.from
        && ctx.headers.from.name && !labelSearch(ctx.searchable, labels, type)) {
      // The From display name is a GUESS at the vendor, not a reading of one:
      // "Stackforge Billing" is a mailbox name, not a company name. Keep it
      // below the rule-accept threshold so the model gets a say, and keep the
      // published number honest about it.
      return { value: ctx.headers.from.name, confidence: 0.7, source: 'header',
        evidence: ctx.headers.from.name, fallback: true };
    }
    if (/^(received_at|sent_at|email_date|message_date)$/.test(key) && ctx.headers.date) {
      const v = type === 'date' ? ctx.headers.date.slice(0, 10) : ctx.headers.date;
      return { value: v, confidence: 0.95, source: 'header', evidence: ctx.headers.date };
    }
  }

  // 3. Labels, in the cleanest surface first.
  const surfaces = [ctx.stripped, ctx.text, ctx.htmlText, ctx.subject].filter(Boolean);
  let best = null;
  for (const s of surfaces) {
    const hit = labelSearch(s, labels, type);
    if (hit && (!best || hit.confidence > best.confidence)) { best = hit; break; }
  }
  if (!best) best = tableSearch(ctx.tables, labels, type);

  if (best) {
    const refined = refine(best, type, ctx);
    if (refined) return { ...refined, source: 'rule' };
  }

  // 4. Type-specific fallbacks that are still deterministic but weaker.
  if ((type === 'currency' || type === 'number') && /total|amount|betrag|summe/.test(key)) {
    const amounts = ctx.detected.amounts || [];
    if (amounts.length === 1) {
      return { value: type === 'currency' ? { amount: amounts[0].value, currency: amounts[0].currency } : amounts[0].value,
        confidence: 0.6, source: 'rule', evidence: amounts[0].raw, fallback: true };
    }
  }
  if (key === 'currency' && (ctx.detected.amounts || []).length) {
    const c = ctx.detected.amounts[0].currency;
    if (c) return { value: c, confidence: 0.85, source: 'rule', evidence: ctx.detected.amounts[0].raw };
  }
  return null;
}

/** Turn the raw label hit into a typed value, tightening confidence as we go. */
function refine(hit, type, ctx) {
  const raw = hit.raw;
  if (type === 'number' || type === 'integer' || type === 'currency') {
    const amounts = findAmounts(raw, ctx.localeHint);
    if (amounts.length) {
      const a = amounts[0];
      return { value: type === 'currency' ? { amount: a.value, currency: a.currency } : a.value,
        confidence: hit.confidence, evidence: hit.evidence };
    }
    const n = parseNumber(raw, ctx.localeHint);
    if (n === null) return null;
    if (type === 'currency') {
      const cur = (ctx.detected.amounts[0] || {}).currency || null;
      return { value: { amount: n, currency: cur }, confidence: hit.confidence - 0.05, evidence: hit.evidence };
    }
    return { value: n, confidence: hit.confidence, evidence: hit.evidence };
  }
  if (type === 'date' || type === 'datetime') {
    const dates = findDates(raw, { locale: ctx.senderDomain, referenceYear: ctx.referenceYear });
    if (!dates.length) return null;
    const d = dates[0];
    const conf = Math.min(hit.confidence, d.confidence + (d.ambiguous ? 0 : 0.02));
    return { value: raw, confidence: conf, evidence: hit.evidence };
  }
  if (type === 'string' || type === 'enum') {
    // "ST-2026-Q2. Balance: 2 480,00 EUR" is one line holding two fields.
    // Stop where the next label starts rather than swallowing it.
    const cut = raw.match(/^(.+?)(?:[.;]\s+|\s{2,}|\s\|\s)(?=[A-Za-zÄÖÜ][\w .\/-]{0,30}\s*[:\uff1a])/);
    if (cut && cut[1].trim().length >= 2) {
      return { value: cut[1].trim(), confidence: hit.confidence, evidence: hit.evidence };
    }
  }
  return { value: raw, confidence: hit.confidence, evidence: hit.evidence };
}

/**
 * A tight verbatim span containing the value and, where possible, its label.
 * This string is shown to a human deciding whether to trust the value, so it
 * must never end mid-word and must not sprawl past what it is evidence for.
 */
function evidenceAround(text, value) {
  if (!text || !value) return value || null;
  const i = text.indexOf(value);
  if (i === -1) return value;
  // Prefer the line the value sits on: that is where its label lives.
  let start = text.lastIndexOf('\n', i) + 1;
  let end = text.indexOf('\n', i + value.length);
  if (end === -1) end = text.length;
  if (end - start > 160) {
    start = Math.max(start, i - 70);
    end = Math.min(end, i + value.length + 40);
    while (start > 0 && /\S/.test(text[start - 1]) && i - start > 0) start--;   // snap left to a word start
    while (end < text.length && /\S/.test(text[end])) end++;                     // snap right to a word end
  }
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

module.exports = { ruleExtract, labelsFor, labelSearch, SYNONYMS, normName };
