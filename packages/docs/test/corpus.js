'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Where the accuracy harness gets real documents.
 *
 * Two sources, both OUTSIDE the repository and both optional:
 *
 *   .local/realmail/*.eml   real invoice mail, kept out of git deliberately —
 *                           it carries a real postal address and phone number
 *   .local/corpus/*.pdf     public documents fetched by `npm run corpus:fetch`
 *
 * `.local/` is gitignored on purpose. Everything here degrades to "skipped"
 * when the files are absent, so the committed suite still runs on a clean
 * clone and in CI. A benchmark that cannot run without private data is a
 * benchmark nobody re-runs.
 */

const REPO = path.resolve(__dirname, '../../..');
const REALMAIL = path.join(REPO, '.local/realmail');
const CORPUS = path.join(REPO, '.local/corpus');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** Every `application/pdf` part of an RFC822 message, decoded. */
function pdfAttachments(raw) {
  const text = raw.toString('latin1');
  const out = [];
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(text);
  const parts = boundary
    ? text.split(new RegExp(`--${boundary[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    : [text];
  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    if (!/content-type:\s*application\/pdf/i.test(head)) continue;
    if (!/content-transfer-encoding:\s*base64/i.test(head)) continue;
    const name = (/(?:file)?name\s*=\s*"?([^";\r\n]+)"?/i.exec(head) || [])[1] || 'attachment.pdf';
    const body = part.slice(sep).replace(/[^A-Za-z0-9+/=]/g, '');
    const buf = Buffer.from(body, 'base64');
    if (buf.length > 4 && buf.toString('latin1', 0, 5) === '%PDF-') out.push({ filename: name, buffer: buf });
  }
  return out;
}

/**
 * Hand labels for the three real Stripe invoices.
 *
 * Keyed by invoice number, which is inside the PDF, so no private path or
 * contact detail from those documents ever appears in this file.
 */
const REAL_LABELS = {
  'IZ0P5L7Q-0065': {
    // `exhaustive` means every data row of the table is listed here, so
    // precision is meaningful. Where a label covers only part of a page, only
    // recall and cell accuracy are.
    exhaustive: true, expect_totals_separated: true,
    currency: 'USD', total: '854.00',
    headers: ['Description', 'Qty', 'Unit price', 'Amount'],
    rows: [
      ['Onboarding and implementation', '1', '495.00', '495.00'],
      ['Priority support (3 seats)', '1', '297.00', '297.00'],
      ['API overage 12,400 calls', '1', '62.00', '62.00'],
    ],
    totals: { Subtotal: '854.00', Total: '854.00' },
  },
  'IZ0P5L7Q-0066': {
    exhaustive: true, expect_totals_separated: true,
    currency: 'EUR', total: '3244.00',
    rows: [
      ['Lizenz MailMint Server 2026', '1', '1199.00', '1199.00'],
      ['Wartung 12 Monate', '1', '245.00', '245.00'],
      ['Schulung (2 Tage vor Ort)', '1', '1800.00', '1800.00'],
    ],
    totals: { Total: '3244.00' },
  },
  'IZ0P5L7Q-0067': {
    exhaustive: true, expect_totals_separated: true,
    currency: 'GBP', total: '3127.50',
    rows: [
      ['Consulting day rate x 4', '1', '3000.00', '3000.00'],
      ['Travel expenses', '1', '127.50', '127.50'],
    ],
    totals: { Total: '3127.50' },
  },
};

/** @returns {Array<{id, filename, buffer, labels}>} — empty when .local is absent. */
function realInvoices() {
  if (!exists(REALMAIL)) return [];
  const out = [];
  for (const f of fs.readdirSync(REALMAIL).filter((n) => n.endsWith('.eml')).sort()) {
    let raw;
    try { raw = fs.readFileSync(path.join(REALMAIL, f)); } catch { continue; }
    for (const att of pdfAttachments(raw)) {
      out.push({ id: f, filename: att.filename, buffer: att.buffer, labels: null });
    }
  }
  return out;
}

/** Public documents fetched by test/fetch-corpus.js, plus their manifest entry. */
function publicCorpus() {
  const manifestPath = path.join(CORPUS, 'manifest.json');
  if (!exists(manifestPath)) return [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }
  const out = [];
  for (const entry of manifest.documents || []) {
    const p = path.join(CORPUS, entry.file);
    if (!exists(p)) continue;
    out.push({ ...entry, path: p, buffer: fs.readFileSync(p) });
  }
  return out;
}

module.exports = { realInvoices, publicCorpus, pdfAttachments, REAL_LABELS, REALMAIL, CORPUS, exists };
