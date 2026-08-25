'use strict';
const { findAmounts } = require('./numbers');
const { normaliseAddress } = require('./headers');
const { findDates } = require('./dates');

/**
 * Layer (a): deterministic extraction. Runs on every message, costs nothing,
 * never calls out, and is what the rule engine and the LLM prompt are both
 * built on top of.
 */

const EMAIL_RE = /\b[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'\])}]+[^\s<>"'\])}.,;:!?]/gi;
const BARE_URL_RE = /\bwww\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s<>"']*)?/gi;

/** Phone numbers. Deliberately conservative: false positives here are worse
 *  than misses, because order numbers and dates look a lot like phone numbers. */
const PHONE_RE = /(?:(?:\+|00)\d{1,3}[\s.\-/]?)?(?:\(\d{2,5}\)[\s.\-/]?)?\d{2,5}(?:[\s.\-/]\d{2,6}){1,4}\b/g;

function uniq(a) { return [...new Set(a)]; }

function findEmails(text) {
  EMAIL_RE.lastIndex = 0;
  const out = (text.match(EMAIL_RE) || [])
    // Domain lowercased, local part left alone: see headers.normaliseAddress.
    .map((e) => normaliseAddress(e.replace(/^[.]+|[.]+$/g, '')))
    .filter((e) => /@/.test(e) && /\.[a-z]{2,}$/i.test(e) && e.length < 254);
  return uniq(out);
}

function findUrls(text, extra) {
  const raw = [...(text.match(URL_RE) || []), ...(extra || [])];
  const bare = (text.match(BARE_URL_RE) || []).map((u) => 'http://' + u);
  return uniq([...raw, ...bare].map((u) => u.replace(/[.,;:!?]+$/, '')))
    .filter((u) => u.length < 2048);
}

function findPhones(text) {
  PHONE_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + raw.length, m.index + raw.length + 12);
    if (/[\d)]$/.test(before.trim()) || /^\s*[\d]/.test(after)) continue;
    if (/[$€£¥]\s*$/.test(before)) continue;
    if (/^\s*(?:USD|EUR|GBP|%)/.test(after)) continue;
    if (/\b(?:19|20)\d\d[-/.]\d/.test(raw)) continue;                      // a date
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(raw)) continue;
    if (/^\d+[.,]\d{1,2}$/.test(raw)) continue;                            // an amount
    const looksPhone = /^\+|^00\d|\(|(?:\d[\s.\-/]){2,}/.test(raw)
      || /(?:tel|phone|mobile|mobil|fax|cell|call|hotline|telefon)[\s.:]{0,4}$/i.test(before);
    if (!looksPhone) continue;
    out.push(raw.replace(/\s+/g, ' '));
  }
  return uniq(out);
}

/** Labelled identifiers. The label carries the meaning, so we match on it. */
const ID_LABELS = [
  { kind: 'invoice_number', re: /\b(?:invoice|inv\.?|rechnung(?:s)?|facture|factura|fattura|faktura)[\s\-]*(?:number|no\.?|nr\.?|num\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{1,29})\b/gi },
  { kind: 'order_number', re: /\b(?:order|bestell(?:ung|nummer)?|auftrag(?:s)?|commande|pedido|ordine)[\s\-]*(?:number|no\.?|nr\.?|num\.?|id|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{1,29})\b/gi },
  { kind: 'tracking_number', re: /\b(?:tracking|sendungs(?:nummer)?|shipment|awb|waybill|track(?:ing)? id|colis)[\s\-]*(?:number|no\.?|nr\.?|id|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]{5,34})\b/gi },
  { kind: 'customer_number', re: /\b(?:customer|account|kunden(?:nummer)?|konto|client|cliente)[\s\-]*(?:number|no\.?|nr\.?|id|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{1,29})\b/gi },
  { kind: 'po_number', re: /\b(?:p\.?o\.?|purchase order)[\s\-]*(?:number|no\.?|nr\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{1,29})\b/gi },
  { kind: 'receipt_number', re: /\b(?:receipt|beleg|quittung|recibo|ricevuta)[\s\-]*(?:number|no\.?|nr\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{1,29})\b/gi },
  { kind: 'reference', re: /\b(?:reference|referenz|ref\.?|verwendungszweck)[\s\-]*(?:number|no\.?|nr\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._\/-]{2,29})\b/gi },
  { kind: 'vat_id', re: /\b(?:VAT|USt-?IdNr\.?|Ust-?ID|TVA|IVA)[\s\-]*(?:number|no\.?|nr\.?|#|id)?\s*[:#]?\s*([A-Z]{2}[A-Z0-9]{6,14})\b/gi },
];

/** Carrier-specific tracking shapes, recognisable without a label. */
const CARRIER_TRACKING = [
  { re: /\b1Z[0-9A-Z]{16}\b/g, carrier: 'ups' },
  { re: /\b(?:JJD|JVGL|GM)\d{10,20}\b/g, carrier: 'dhl' },
  { re: /\b\d{12}\b(?=[^\d])/g, carrier: 'fedex' },
];

const STOPWORDS = new Set(['NUMBER', 'NO', 'NR', 'ID', 'FOR', 'FROM', 'TO', 'IS', 'THE', 'AND',
  'OF', 'DATE', 'TOTAL', 'AT', 'ON', 'YOUR', 'OUR', 'HAS', 'BEEN', 'WAS', 'WE', 'YOU', 'IST',
  'DER', 'DIE', 'DAS', 'VON', 'FUER', 'UND', 'EINE', 'EINEN', 'IHRE', 'IHR', 'WURDE', 'HAT']);

function findIds(text) {
  const out = [];
  const seen = new Set();
  for (const { kind, re } of ID_LABELS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      let v = (m[1] || '').replace(/[.,;:]+$/, '');
      if (!v || v.length < 2) continue;
      // "INV-77211" must not become "77211": the label IS part of the id when
      // it is glued to it by a separator.
      const pre = m[0].slice(0, m[0].length - m[1].length);
      const glue = pre.match(/([A-Za-z]{2,10})([-\/])$/);
      if (glue && /^[0-9]/.test(v)) v = glue[1].toUpperCase() + glue[2] + v;
      if (STOPWORDS.has(v.toUpperCase())) continue;
      // Identifiers contain a digit. Without this the label regex happily
      // captures the next English word: "invoice illustration" -> "illustration".
      if (kind !== 'vat_id' && !/\d/.test(v)) continue;
      if (/^(?:number|no|nr|id)$/i.test(v)) continue;
      if (/^(?:19|20)\d{2}$/.test(v)) continue;            // a bare year is not an id
      if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(v)) continue;
      const key = kind + '|' + v;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, value: v, index: m.index, confidence: 0.9 });
    }
  }
  for (const { re, carrier } of CARRIER_TRACKING) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = 'tracking_number|' + m[0];
      if (seen.has(key)) continue;
      if (carrier === 'fedex' && !/track|shipment|sendung|versand|delivery/i.test(text)) continue;
      seen.add(key);
      out.push({ kind: 'tracking_number', value: m[0], index: m.index, confidence: carrier === 'fedex' ? 0.6 : 0.9, carrier });
    }
  }
  return out;
}

/** Postal addresses: a street line immediately above a locality line. */
const ZIP_LINE = [
  /^\s*[A-Za-zÀ-ÿ.'\- ]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\s*$/,       // Springfield, IL 62704
  /^\s*\d{5}\s+[A-Za-zÀ-ÿ.'\- ]{2,}\s*$/,                            // 80331 München
  /^\s*[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}\s*$/i,                   // SW1A 1AA
  /^\s*\d{4}\s+[A-Za-zÀ-ÿ.'\- ]{2,}\s*$/,                            // 1010 Wien
  /^\s*[A-Za-zÀ-ÿ.'\- ]+\s+\d{4}\s*[A-Z]{2}\s*$/,                    // Amsterdam 1012 AB
];
const STREET_LINE = /^\s*(?:\d+[A-Za-z]?[\s,]+[A-Za-zÀ-ÿ][^\n]{2,60}|[A-Za-zÀ-ÿ][^\n]{2,60}?\s+\d+[A-Za-z]?)\s*$/;

function findAddresses(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i], b = lines[i + 1];
    if (!STREET_LINE.test(a)) continue;
    if (a.trim().length < 6 || a.trim().length > 80) continue;
    if (!ZIP_LINE.some((re) => re.test(b))) continue;
    if (/[@]|https?:/.test(a + b)) continue;
    const before = i > 0 && lines[i - 1].trim() && lines[i - 1].trim().length < 60
      && !/[:;]$/.test(lines[i - 1].trim()) ? lines[i - 1].trim() + '\n' : '';
    const after = ZIP_LINE.some(() => false) ? '' : '';
    out.push((before + a.trim() + '\n' + b.trim() + after).trim());
  }
  return uniq(out);
}

/** Document type scoring. Keywords are weighted; structure breaks ties. */
const TYPE_KEYWORDS = {
  invoice: [[/\binvoice\b/gi, 3], [/\brechnung\b/gi, 3], [/\bfacture\b/gi, 3], [/\bfactura\b/gi, 3],
    [/\bamount due\b/gi, 3], [/\bdue date\b/gi, 2], [/\bf(?:ä|ae)llig(?:keit)?\b/gi, 2],
    [/\bpayment (?:is )?due\b/gi, 3], [/\bbill(?:ing)? (?:statement|period)\b/gi, 2],
    [/\bnet\s*\d{1,3}\b/gi, 1], [/\bpay (?:this )?invoice\b/gi, 3], [/\bzahlbar\b/gi, 2],
    [/\bust-?idnr\b/gi, 1], [/\bvat\b/gi, 1], [/\bsteuernummer\b/gi, 1],
    [/\u8acb\u6c42\u66f8/g, 4]],
  receipt: [[/\breceipt\b/gi, 3], [/\bbeleg\b/gi, 2], [/\bquittung\b/gi, 3],
    [/\bpayment (?:received|successful|confirmation)\b/gi, 3], [/\bthanks? for your payment\b/gi, 3],
    [/\byou (?:have been |were )?charged\b/gi, 3], [/\bpaid\b/gi, 1], [/\bzahlungseingang\b/gi, 3],
    [/\bcard ending\b/gi, 2], [/\btransaction id\b/gi, 2], [/\brefund(?:ed)?\b/gi, 1],
    [/\bbeleg-?nr\b/gi, 4], [/\bzahlungs(?:mittel|art|methode)\b/gi, 2], [/\btrinkgeld\b/gi, 2],
    [/\u9818\u53ce\u66f8/g, 4], [/\u304a\u652f\u6255\u3044/g, 2]],
  order: [[/\border confirmation\b/gi, 4], [/\bbestellbest(?:ä|ae)tigung\b/gi, 4],
    [/\bthank you for your order\b/gi, 4], [/\byour order\b/gi, 2], [/\border\s*#/gi, 2],
    [/\bbestellnummer\b/gi, 3], [/\bwe(?:'| ha)ve received your order\b/gi, 3],
    [/\bauftragsbest(?:ä|ae)tigung\b/gi, 3], [/\bconfirmaci(?:ó|o)n de pedido\b/gi, 3],
    [/\u6ce8\u6587\u756a\u53f7/g, 4], [/\u3054\u6ce8\u6587/g, 3]],
  shipping: [[/\bshipped\b/gi, 3], [/\bhas shipped\b/gi, 4], [/\btracking (?:number|code|id)\b/gi, 4],
    [/\bout for delivery\b/gi, 4], [/\bversand(?:best(?:ä|ae)tigung)?\b/gi, 3],
    [/\bsendungsnummer\b/gi, 4], [/\bdelivery (?:date|estimate|address)\b/gi, 2],
    [/\bin transit\b/gi, 3], [/\bpaket\b/gi, 2], [/\bzustellung\b/gi, 3], [/\bcarrier\b/gi, 2], [/\u767a\u9001/g, 3]],
  form: [[/\bform submission\b/gi, 4], [/\bnew submission\b/gi, 4], [/\bcontact form\b/gi, 4],
    [/\bkontaktformular\b/gi, 4], [/\bnew (?:lead|enquiry|inquiry)\b/gi, 3],
    [/\bsubmitted (?:the |a )?form\b/gi, 3], [/\banfrage (?:ü|ue)ber\b/gi, 3]],
  calendar: [[/\binvitation\b/gi, 3], [/\bcalendar\b/gi, 2], [/\bmeeting (?:invite|request)\b/gi, 4],
    [/\bwhen:\s/gi, 2], [/\bwhere:\s/gi, 2], [/\btermin(?:einladung)?\b/gi, 3],
    [/\brsvp\b/gi, 2], [/\bbesprechung\b/gi, 2]],
};

function detectType(ctx) {
  const hay = [ctx.subject || '', ctx.text || ''].join('\n');
  const subject = ctx.subject || '';
  const scores = {};
  for (const [type, rules] of Object.entries(TYPE_KEYWORDS)) {
    let s = 0;
    for (const [re, w] of rules) {
      re.lastIndex = 0;
      const n = (hay.match(re) || []).length;
      if (n) s += w * Math.min(n, 3);
      re.lastIndex = 0;
      if (re.test(subject)) s += w;                   // subject line counts double
    }
    scores[type] = s;
  }
  // Structure bonuses.
  if (ctx.attachments && ctx.attachments.some((a) => a.content_type === 'text/calendar')) scores.calendar += 8;
  if (ctx.attachments && ctx.attachments.some((a) => /invoice|rechnung|facture/i.test(a.filename || ''))) scores.invoice += 4;
  if (ctx.ids.some((i) => i.kind === 'tracking_number')) scores.shipping += 4;
  if (ctx.ids.some((i) => i.kind === 'invoice_number')) scores.invoice += 4;
  if (ctx.ids.some((i) => i.kind === 'order_number')) scores.order += 3;
  if (ctx.ids.some((i) => i.kind === 'receipt_number')) scores.receipt += 3;
  if (ctx.tables.length && ctx.amounts.length >= 2) { scores.invoice += 1; scores.order += 1; }
  if (!ctx.amounts.length) { scores.invoice -= 2; scores.receipt -= 2; scores.order -= 1; }

  let best = 'generic', bestScore = 0;
  for (const [t, s] of Object.entries(scores)) if (s > bestScore) { best = t; bestScore = s; }
  return bestScore >= 3 ? best : 'generic';
}

/**
 * Run the full deterministic pass.
 * `haystacks` is an object of the text surfaces we search.
 */
function detect(ctx) {
  const text = ctx.text || '';
  const subject = ctx.subject || '';
  const tableText = (ctx.tables || []).map((t) =>
    // `col1`, `col2`… are placeholders we invented; scanning them invents ids.
    [t.headers.filter((h) => !/^col\d+$/.test(h)).join(' '),
      ...t.rows.map((r) => r.join(' '))].join('\n')).join('\n');
  // A reply subject names the PREVIOUS message ("Re: Wrong total on INV-77211"),
  // so when the subject is a reply the body speaks first.
  const isReply = /^\s*(?:re|aw|antw|fwd?|wg|tr|rif)\s*[:\]]/i.test(subject || '');
  const searchable = (isReply ? [text, tableText, subject] : [subject, text, tableText]).filter(Boolean).join('\n');
  // URLs contain digits, slashes and words like "invoice"; every one of the
  // scanners below produces garbage if it is allowed to read them.
  const scannable = searchable.replace(URL_RE, ' ').replace(BARE_URL_RE, ' ');

  const amounts = findAmounts(scannable, ctx.localeHint === 'dmy' ? 'eu' : null);
  const dates = findDates(scannable, { locale: ctx.senderDomain, referenceYear: ctx.referenceYear });
  const ids = findIds(scannable);
  const emails = findEmails(searchable);
  const urls = findUrls(text + '\n' + subject, ctx.links);
  const phones = findPhones(scannable);
  const addresses = findAddresses(text);
  const type = detectType({ subject, text: scannable, attachments: ctx.attachments || [], ids, tables: ctx.tables || [], amounts });

  return { type, emails, urls, phones, amounts, dates, ids, addresses };
}

/** Project the internal detection onto the exact §1 shape. */
function toContractShape(d) {
  return {
    type: d.type,
    emails: d.emails,
    urls: d.urls,
    phones: d.phones,
    amounts: d.amounts.map((a) => ({ value: a.value, currency: a.currency, raw: a.raw })),
    dates: d.dates.map((x) => ({ value: x.value, raw: x.raw })),
    ids: d.ids.map((i) => ({ kind: i.kind, value: i.value })),
    addresses: d.addresses,
  };
}

module.exports = { detect, toContractShape, findEmails, findUrls, findPhones, findIds, findAddresses, detectType };
