'use strict';

const express = require('express');
const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const { log } = require('./log');
const { ApiError } = require('./errors');

/**
 * Stripe, written but dormant.
 *
 * TWO conditions have to hold before a single call reaches Stripe:
 * MAILMINT_BILLING=1 and a secret key in the environment. Neither is set
 * anywhere yet, on purpose — this code is finished so that going live is a
 * decision rather than a project, but no live Stripe object exists and none can
 * be created by running this. The plan/price mapping is by env var, so the
 * price ids are created once by hand in the Stripe dashboard and pasted in.
 *
 * The shape mirrors pdfmint-api's billing.js deliberately: same customer
 * healing, same webhook events, same portal. One thing to learn, not two.
 */
let stripe = null;
function client() {
  if (!config.billingEnabled || !config.stripe.secretKey) return null;
  if (!stripe) {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2025-01-27.acacia' });
  }
  return stripe;
}
const enabled = () => Boolean(client());

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const unavailable = () => new ApiError(503, 'billing_unavailable',
  'Billing is not switched on for this deployment.', {
    hint: `The free plan is ${PLANS.free.quota} emails a month and needs no card. Paid plans open when MAILMINT_BILLING is enabled.`,
  });

/**
 * A stored customer id is not permanent — it can be deleted in the Stripe
 * dashboard or come back `deleted: true`. Trusting it blindly is how the one
 * user who wants to pay meets a 500 and never tries again.
 */
async function isUsableCustomer(customerId) {
  if (!customerId) return false;
  try {
    const c = await client().customers.retrieve(customerId);
    return !c.deleted;
  } catch (e) {
    if (e && (e.code === 'resource_missing' || e.statusCode === 404 || /No such customer/i.test(e.message || ''))) return false;
    throw e;
  }
}

async function ensureCustomer(account) {
  if (await isUsableCustomer(account.stripe_customer_id)) return account.stripe_customer_id;
  const customer = await client().customers.create({
    email: account.email, metadata: { account_id: String(account.id), service: 'mailmint' },
  });
  await query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [account.id, customer.id]);
  return customer.id;
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw unavailable();
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Purchasable plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ') || 'none configured'}.`,
    });
  }
  return client().checkout.sessions.create({
    mode: 'subscription',
    customer: await ensureCustomer(account),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.publicUrl}/dashboard?checkout=success`,
    cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
    allow_promotion_codes: true,
    tax_id_collection: { enabled: true },
    billing_address_collection: 'auto',
    customer_update: { name: 'auto', address: 'auto' },
    client_reference_id: String(account.id),
    subscription_data: { metadata: { account_id: String(account.id), plan: planId } },
    metadata: { account_id: String(account.id), plan: planId },
  });
}

async function createPortalSession(account) {
  if (!enabled()) throw unavailable();
  if (!account.stripe_customer_id) {
    throw new ApiError(400, 'no_subscription', 'This account has never had a paid subscription.');
  }
  return client().billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${config.publicUrl}/dashboard`,
  });
}

/** Applies a plan change. The single place the quota column is allowed to move. */
async function applyPlan(accountId, planId, subscriptionId) {
  const plan = PLANS[planId] || PLANS.free;
  await query(
    `UPDATE accounts SET plan = $2, quota_month = $3, stripe_subscription_id = $4 WHERE id = $1`,
    [accountId, plan.id, plan.quota, subscriptionId || null],
  );
  log.info('billing.plan_applied', { account_id: Number(accountId), plan: plan.id, quota: plan.quota });
}

router.post('/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: { code: 'billing_unavailable' } });
  let event;
  try {
    event = client().webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    log.warn('billing.bad_signature', { error: e.message });
    return res.status(400).send(`signature: ${e.message}`);
  }
  // Stripe retries, so the same event arrives more than once. The primary key
  // is the idempotency guard; a duplicate is a no-op, not a second upgrade.
  const { rowCount } = await query(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return res.json({ received: true, duplicate: true });

  const obj = event.data.object;
  const accountId = Number(obj.metadata?.account_id || obj.client_reference_id || 0);
  log.info('billing.event', { type: event.type, stripe_event: event.id, account_id: accountId || null });
  if (!accountId) return res.json({ received: true });

  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
    await applyPlan(accountId, obj.metadata?.plan || 'starter', obj.subscription || obj.id);
  } else if (event.type === 'customer.subscription.deleted') {
    await applyPlan(accountId, 'free', null);
  }
  return res.json({ received: true });
}));

module.exports = { router, enabled, createCheckoutSession, createPortalSession, applyPlan, isUsableCustomer };
