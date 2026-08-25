'use strict';
/**
 * Hand-labelled ground truth for the accuracy harness.
 *
 * Every `expected` value below was read off the message by a human, not
 * produced by the parser. Where a field genuinely is not in the message the
 * expected value is null — "correctly found nothing" is a real result and the
 * harness scores it.
 *
 * `real mail` entries live outside the repo (.local/ is gitignored: those are
 * genuine delivered messages and must never be committed). They are referenced
 * by absolute path and skipped when absent.
 */

const path = require('node:path');
const REALMAIL = path.resolve(__dirname, '../../../.local/realmail');

const INVOICE_SCHEMA = [
  { name: 'invoice_number', type: 'string', required: true, hint: 'labelled Invoice number or Invoice #' },
  { name: 'total', type: 'currency', required: true, hint: 'the grand total including tax' },
  { name: 'currency', type: 'string' },
  { name: 'due_date', type: 'date', hint: 'labelled Due date' },
  { name: 'vendor', type: 'string', description: 'the company issuing the invoice' },
];

const LINE_ITEM_SCHEMA = INVOICE_SCHEMA.concat([
  { name: 'line_items', type: 'array', description: 'one entry per invoice line',
    items: { type: 'object', fields: [{ name: 'description', type: 'string' }, { name: 'amount', type: 'number' }] } },
]);

const labels = [
  // ---- constructed fixtures, vendor-shaped -------------------------------
  {
    file: 'fx-01-stripe-receipt.eml', kind: 'fixture',
    schema: [
      { name: 'receipt_number', type: 'string', hint: 'labelled Receipt #' },
      { name: 'total', type: 'currency', required: true },
      { name: 'payment_date', type: 'date', hint: 'labelled Paid' },
      { name: 'card_last4', type: 'string', description: 'last four digits of the card charged' },
      { name: 'line_items', type: 'array', items: { type: 'object', fields: [{ name: 'description', type: 'string' }, { name: 'amount', type: 'number' }] } },
    ],
    expected: {
      receipt_number: '2451-8827',
      total: { amount: 82.08, currency: 'USD' },
      payment_date: '2026-08-21',
      card_last4: '4242',
      line_items: [
        { description: 'Pro plan (monthly)', amount: 49 },
        { description: 'Additional seats x3', amount: 27 },
        { description: 'Sales tax', amount: 6.08 },
      ],
    },
    type: 'receipt',
  },
  {
    file: 'fx-02-order-confirmation.eml', kind: 'fixture',
    schema: [
      { name: 'order_number', type: 'string', required: true },
      { name: 'order_date', type: 'date' },
      { name: 'total', type: 'currency', required: true, hint: 'labelled Order Total' },
      { name: 'estimated_tax', type: 'number', hint: 'labelled Estimated Tax' },
      { name: 'delivery_date', type: 'date', hint: 'labelled Arriving' },
    ],
    expected: {
      order_number: '114-7729183-4462618',
      order_date: '2026-08-19',
      total: { amount: 119.34, currency: 'USD' },
      estimated_tax: 9.35,
      delivery_date: '2026-08-22',
    },
    type: 'order',
  },
  {
    file: 'fx-03-dhl-versand-latin1.eml', kind: 'fixture',
    schema: [
      { name: 'tracking_number', type: 'string', required: true },
      { name: 'delivery_date', type: 'date', hint: 'Voraussichtliche Zustellung' },
      { name: 'order_number', type: 'string' },
      { name: 'carrier', type: 'string' },
    ],
    expected: {
      tracking_number: 'JJD000390009991234567',
      delivery_date: '2026-08-27',
      order_number: 'BST-2026-44817',
      carrier: 'DHL',
    },
    type: 'shipping',
  },
  {
    file: 'fx-04-rechnung-plaintext.eml', kind: 'fixture',
    schema: [
      { name: 'invoice_number', type: 'string', required: true, hint: 'Rechnungsnummer' },
      { name: 'invoice_date', type: 'date', hint: 'Rechnungsdatum' },
      { name: 'due_date', type: 'date', hint: 'labelled "Fällig am"' },
      { name: 'customer_number', type: 'string', hint: 'Kundennummer' },
      { name: 'total', type: 'currency', required: true, hint: 'Gesamtbetrag' },
      { name: 'net_total', type: 'number', hint: 'Zwischensumme' },
      { name: 'vat_id', type: 'string', hint: 'USt-IdNr' },
    ],
    expected: {
      invoice_number: 'RE-2026-00417',
      invoice_date: '2026-08-14',
      due_date: '2026-09-13',
      customer_number: 'K-88231',
      total: { amount: 1523.20, currency: 'EUR' },
      net_total: 1280,
      vat_id: 'DE812345678',
    },
    type: 'invoice',
  },
  {
    file: 'fx-05-invoice-pdf-attachment.eml', kind: 'fixture',
    schema: INVOICE_SCHEMA,
    expected: {
      invoice_number: 'INV-10428',
      total: { amount: 4812, currency: 'GBP' },
      currency: 'GBP',
      due_date: '2026-08-31',
      vendor: 'Ellinghurst Consulting Ltd',
    },
    type: 'invoice',
    attachments: [{ filename: 'Invoice INV-10428.pdf', content_type: 'application/pdf' }],
  },
  {
    file: 'fx-06-contact-form.eml', kind: 'fixture',
    schema: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'email', required: true },
      { name: 'phone', type: 'phone' },
      { name: 'company', type: 'string' },
      { name: 'message', type: 'string' },
    ],
    expected: {
      name: 'Hannah Vosloo',
      email: 'hannah.vosloo@gmail.com',
      phone: '+27215550134',
      company: 'Vosloo Interiors',
      message: null,   // free text; scored only for "did not invent a wrong one"
    },
    skipScore: ['message'],
    type: 'form',
  },
  {
    file: 'fx-07-calendar-invite.eml', kind: 'fixture',
    schema: [
      { name: 'event_title', type: 'string', required: true, hint: 'the meeting subject' },
      { name: 'start', type: 'datetime' },
      { name: 'location', type: 'string', hint: 'labelled Where' },
      { name: 'organizer', type: 'email' },
    ],
    expected: {
      event_title: 'Q3 pricing review',
      start: '2026-09-03T13:00:00.000Z',
      location: 'Meridian Labs HQ, Room 4.02',
      organizer: 'ilse.brandt@meridian-labs.io',
    },
    skipScore: ['start'],   // wall-clock vs UTC in the text part is genuinely ambiguous
    type: 'calendar',
  },
  {
    file: 'fx-08-reply-chain-invoice.eml', kind: 'fixture',
    schema: [
      { name: 'invoice_number', type: 'string', required: true },
      { name: 'total', type: 'currency', required: true },
      { name: 'due_date', type: 'date' },
    ],
    // The quoted chain contains INV-77211 / $1,980.00 / September 5. The
    // correct answer is the NEW message's values only.
    expected: {
      invoice_number: 'INV-77213',
      total: { amount: 2415.60, currency: 'USD' },
      due_date: '2026-09-12',
    },
    type: 'invoice',
  },
  {
    file: 'fx-09-outlook-forwarded-invoice.eml', kind: 'fixture',
    schema: INVOICE_SCHEMA,
    expected: {
      invoice_number: 'CC-2026-0912',
      total: { amount: 318.44, currency: 'GBP' },
      currency: 'GBP',
      due_date: '2026-09-03',
      vendor: 'Cloudcrest',
    },
    skipScore: ['vendor'],  // the forward makes the vendor ambiguous by design
    type: 'invoice',
  },
  {
    file: 'fx-10-japanese-receipt.eml', kind: 'fixture',
    schema: [
      { name: 'order_number', type: 'string', required: true },
      { name: 'total', type: 'currency', required: true },
      { name: 'order_date', type: 'date' },
    ],
    expected: {
      order_number: 'JP-2026-338271',
      total: { amount: 12800, currency: 'JPY' },
      order_date: '2026-08-18',
    },
    type: 'order',
  },
  {
    file: 'fx-11-utility-bill-pipes.eml', kind: 'fixture',
    schema: [
      { name: 'account_number', type: 'string', required: true },
      { name: 'total', type: 'currency', required: true, hint: 'labelled Amount due' },
      { name: 'due_date', type: 'date' },
      { name: 'bill_date', type: 'date' },
    ],
    expected: {
      account_number: '7729-4415-02',
      total: { amount: 142.54, currency: 'GBP' },
      due_date: '2026-09-01',
      bill_date: '2026-08-15',
    },
    type: 'invoice',
    tables: { minCount: 1, headers: ['Charge', 'Units', 'Rate', 'Amount'] },
  },
  {
    file: 'fx-12-shipping-related-inline.eml', kind: 'fixture',
    schema: [
      { name: 'tracking_number', type: 'string', required: true },
      { name: 'carrier', type: 'string' },
      { name: 'delivery_date', type: 'date', hint: 'Estimated delivery' },
      { name: 'total', type: 'currency', hint: 'Order total' },
    ],
    expected: {
      tracking_number: '1Z999AA10123456784',
      carrier: 'UPS',
      delivery_date: '2026-08-26',
      total: { amount: 214.90, currency: 'USD' },
    },
    type: 'shipping',
    attachments: [{ filename: 'logo.png', content_type: 'image/png', inline: true, content_id: 'logo.brightloom@shipping' }],
  },
  {
    file: 'fx-13-facture-francaise.eml', kind: 'fixture',
    schema: [
      { name: 'invoice_number', type: 'string', required: true, hint: 'Numéro de facture' },
      { name: 'invoice_date', type: 'date' },
      { name: 'due_date', type: 'date', hint: 'Échéance' },
      { name: 'total', type: 'currency', required: true, hint: 'Total TTC' },
      { name: 'customer_reference', type: 'string', hint: 'Référence client' },
    ],
    expected: {
      invoice_number: 'FA-2026-0731',
      invoice_date: '2026-07-31',
      due_date: '2026-08-30',
      total: { amount: 283.20, currency: 'EUR' },
      customer_reference: 'CLI-4471',
    },
    type: 'invoice',
  },
  {
    file: 'fx-14-html-only-invoice.eml', kind: 'fixture',
    schema: LINE_ITEM_SCHEMA.concat([{ name: 'po_number', type: 'string', hint: 'PO number' }]),
    expected: {
      invoice_number: '5A3C-0091',
      total: { amount: 1240, currency: 'USD' },
      currency: 'USD',
      due_date: '2026-09-07',
      vendor: 'Stackforge',
      po_number: 'PO-2026-118',
      line_items: [
        { description: 'Platform subscription — August 2026', amount: 900 },
        { description: 'Overage — 4,000,000 events', amount: 240 },
        { description: 'Support plan', amount: 100 },
      ],
    },
    type: 'invoice',
    tables: { minCount: 1, headers: ['Description', 'Qty', 'Unit', 'Amount'] },
  },
  {
    file: 'fx-15-broken-boundary.eml', kind: 'fixture',
    schema: [
      { name: 'invoice_number', type: 'string', required: true },
      { name: 'total', type: 'currency', required: true },
    ],
    expected: { invoice_number: 'BRK-0001', total: { amount: 10, currency: 'USD' } },
    type: 'invoice',
  },
  {
    file: 'fx-16-nested-rfc2231.eml', kind: 'fixture',
    schema: [
      { name: 'statement_number', type: 'string', required: true },
      { name: 'balance', type: 'currency', required: true },
    ],
    expected: { statement_number: 'ST-2026-Q2', balance: { amount: 2480, currency: 'EUR' } },
    type: 'generic',
    attachments: [{ filename: 'Quartalsabschluss März-Juni.pdf', content_type: 'application/pdf' }],
  },
  {
    file: 'fx-17-ride-receipt-de.eml', kind: 'fixture',
    schema: [
      { name: 'receipt_number', type: 'string', required: true, hint: 'Beleg-Nr' },
      { name: 'total', type: 'currency', required: true, hint: 'Gesamtbetrag' },
      { name: 'ride_date', type: 'date', hint: 'Fahrtdatum' },
      { name: 'tip', type: 'number', hint: 'Trinkgeld' },
    ],
    expected: {
      receipt_number: 'R-8827-4419',
      total: { amount: 27.84, currency: 'EUR' },
      ride_date: '2026-08-23',
      tip: 2,
    },
    type: 'receipt',
  },
  {
    file: 'fx-18-ambiguous-dates.eml', kind: 'fixture',
    schema: [
      { name: 'invoice_number', type: 'string', required: true },
      { name: 'invoice_date', type: 'date' },
      { name: 'due_date', type: 'date' },
      { name: 'total', type: 'currency', required: true },
    ],
    // The message contains 25/03/2026, which is only valid day-first, so the
    // whole document is day-first: 03/04/2026 is 3 April.
    expected: {
      invoice_number: 'AMB-2026-004',
      invoice_date: '2026-04-03',
      due_date: '2026-05-03',
      total: { amount: 560, currency: 'USD' },
    },
    type: 'invoice',
  },

  // ---- real delivered mail (not committed) --------------------------------
  {
    file: path.join(REALMAIL, 'stripe-6a8d4ee330e0bbc12a09763d.eml'), kind: 'real',
    schema: LINE_ITEM_SCHEMA,
    expected: {
      invoice_number: 'IZ0P5L7Q-0065',
      total: { amount: 854, currency: 'USD' },
      currency: 'USD',
      due_date: '2026-09-08',
      vendor: 'Sandbox as a Service',
      line_items: [
        { description: 'Onboarding and implementation', amount: 495 },
        { description: 'Priority support (3 seats)', amount: 297 },
        { description: 'API overage 12,400 calls', amount: 62 },
      ],
    },
    type: 'invoice',
  },
  {
    file: path.join(REALMAIL, 'stripe-6a8d4ee3873971d347227c49.eml'), kind: 'real',
    schema: LINE_ITEM_SCHEMA,
    expected: {
      invoice_number: 'IZ0P5L7Q-0066',
      total: { amount: 3244, currency: 'EUR' },
      currency: 'EUR',
      due_date: '2026-09-08',
      vendor: 'Sandbox as a Service',
      line_items: [
        { description: 'Lizenz MailMint Server 2026', amount: 1199 },
        { description: 'Wartung 12 Monate', amount: 245 },
        { description: 'Schulung (2 Tage vor Ort)', amount: 1800 },
      ],
    },
    type: 'invoice',
  },
  {
    file: path.join(REALMAIL, 'stripe-6a8d4eebf1624dcb11d44d01.eml'), kind: 'real',
    schema: LINE_ITEM_SCHEMA,
    expected: {
      invoice_number: 'IZ0P5L7Q-0067',
      total: { amount: 3127.5, currency: 'GBP' },
      currency: 'GBP',
      due_date: '2026-09-08',
      vendor: 'Sandbox as a Service',
      line_items: [
        { description: 'Consulting day rate x 4', amount: 3000 },
        { description: 'Travel expenses', amount: 127.5 },
      ],
    },
    type: 'invoice',
  },
  {
    file: path.join(REALMAIL, 'neon-invite.eml'), kind: 'real',
    schema: [
      { name: 'invite_url', type: 'url', required: true, description: 'the link that accepts the invitation' },
      { name: 'product', type: 'string', description: 'the product the invitation is for' },
      { name: 'total', type: 'currency', description: 'not present in this message' },
    ],
    expected: { invite_url: null, product: 'Neon', total: null },
    skipScore: ['invite_url'],   // several candidate links; not a fair single-answer field
    type: 'generic',
  },
];

module.exports = { labels, INVOICE_SCHEMA, LINE_ITEM_SCHEMA, REALMAIL };
