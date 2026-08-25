'use strict';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3100),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',

  // The domain the smtpd accepts mail for. Every mailbox address is
  // `<token>@<inboundDomain>`, so this string is baked into everything a
  // customer copies out of the dashboard.
  inboundDomain: process.env.INBOUND_DOMAIN || 'parse.mailmint.dev',

  // Shared secret between the mail VPS (packages/smtpd) and this API. The smtpd
  // is the only caller of /internal/*, and it lives on a different host.
  internalSecret: process.env.INTERNAL_SECRET || '',

  // Storage. v1 keeps raw MIME and attachment bytes in Postgres bytea; there is
  // no object store yet on purpose. The caps are what stops one 90 MB newsletter
  // from being everyone's problem, and the TTLs are what stop the table growing
  // without bound.
  //
  // Raw MIME and attachment bytes have DIFFERENT lifetimes, deliberately. A
  // re-parse replays the original bytes, so raw has to outlive the moment
  // someone notices their sender changed a layout — that is weeks, not days.
  // Attachment blobs are the bulk of the storage and are not needed to re-parse
  // the body, so they go first. Both are per plan; see PLANS.
  maxRawBytes: num(process.env.MAX_RAW_BYTES, 25 * 1024 * 1024),
  maxAttachmentBytes: num(process.env.MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024),
  // Messages, events and the parsed JSON. Events are 7 days by contract §5.
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  eventRetentionDays: num(process.env.EVENT_RETENTION_DAYS, 7),
  // How much of an attachment's extracted text rides along in a message body by
  // default. The full text needs ?include=extracted_text.
  extractedTextPreview: num(process.env.EXTRACTED_TEXT_PREVIEW, 2000),
  maxRequestBytes: num(process.env.MAX_REQUEST_BYTES, 40 * 1024 * 1024),

  // Webhooks (§5).
  webhookTimeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10000),
  webhookPollMs: num(process.env.WEBHOOK_POLL_MS, 1000),

  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Identifies this deployment in usage_events, so a developer's laptop sharing
  // the database does not show up in the production numbers.
  origin: process.env.MAILMINT_ORIGIN
    || ((process.env.PUBLIC_URL || '').includes('onrender.com') ? 'production' : 'dev'),

  // Billing is written but dormant. Nothing touches Stripe until this is on AND
  // a secret key is present, so no live object can be created by accident.
  billingEnabled: process.env.MAILMINT_BILLING === '1',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },
};

/**
 * `quota` is parsed emails per calendar month. `rawDays` is how long the
 * original RFC822 bytes are kept — which is how far back a re-parse can reach —
 * and `blobDays` how long attachment bytes are kept.
 *
 * The numbers are set against what the incumbents charge: Mailparser is
 * $29.95/month for 250 emails (their own page prices a credit at $0.1198) and
 * Parseur is €49/month for 100. Our marginal cost per email is a fraction of a
 * cent, so pricing anywhere near that would be charging for scarcity we do not
 * have — and "$49/month is a blocker" is a documented reason people walk away
 * from this category rather than buying from anyone in it. Hence a free tier
 * that is enough to run a real low-volume workflow, and an entry plan that
 * beats the incumbent's entry price on both axes at once.
 */
const PLANS = {
  free:    { id: 'free',    name: 'Free',    quota: 300,    priceUsd: 0,   rawDays: 30,  blobDays: 7,  stripePriceEnv: null },
  starter: { id: 'starter', name: 'Starter', quota: 5000,   priceUsd: 9,   rawDays: 90,  blobDays: 30, stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  pro:     { id: 'pro',     name: 'Pro',     quota: 25000,  priceUsd: 29,  rawDays: 180, blobDays: 60, stripePriceEnv: 'STRIPE_PRICE_PRO' },
  scale:   { id: 'scale',   name: 'Scale',   quota: 150000, priceUsd: 99,  rawDays: 365, blobDays: 90, stripePriceEnv: 'STRIPE_PRICE_SCALE' },
};

/** Retention for one account, in days, by what is being kept. */
function retentionFor(plan, kind) {
  const p = PLANS[plan] || PLANS.free;
  if (kind === 'raw') return p.rawDays;
  if (kind === 'attachment') return p.blobDays;
  return config.retentionDays;
}

function planPriceId(planId) {
  const p = PLANS[planId];
  if (!p || !p.stripePriceEnv) return null;
  return process.env[p.stripePriceEnv] || null;
}

module.exports = { config, PLANS, planPriceId, retentionFor };
