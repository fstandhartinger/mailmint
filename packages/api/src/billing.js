'use strict';

const express = require('express');
const { config, PLANS, planPriceId } = require('./config');
const { query, tx } = require('./db');
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
    stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2025-01-27.acacia',
  // Bounded on purpose. The checkout path makes several sequential Stripe
  // calls while it holds a database connection and a row lock, and the pool
  // is small. With the library's defaults (80 s, two retries) one Stripe
  // slowdown would hold every connection long enough to take the whole
  // service down, not just billing.
  timeout: 10000,
  maxNetworkRetries: 1,
});
  }
  return stripe;
}
const enabled = () => Boolean(client());

// The name a buyer sees at the top of the Stripe Checkout page.
const BRAND_NAME = 'MailMint';

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

async function ensureCustomer(account, run = query) {
  if (await isUsableCustomer(account.stripe_customer_id)) return account.stripe_customer_id;
  const customer = await client().customers.create({
    email: account.email, metadata: { account_id: String(account.id), service: 'mailmint' },
  });
  await run(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [account.id, customer.id]);
  return customer.id;
}

/** Maps a Stripe price id back to one of our plans. Anything else is not ours. */
function planForPriceId(priceId) {
  for (const id of Object.keys(PLANS)) {
    if (planPriceId(id) === priceId) return PLANS[id];
  }
  return null;
}

/**
 * The invoice behind an abandoned first attempt, and whether its payment is
 * still settling.
 *
 * A settling payment must never be voided: the buyer may be on the 3-D Secure
 * step in another tab, and voiding an invoice whose charge is completing is how
 * money is taken for nothing.
 *
 * Where the intent lives depends on the API version, measured on 2026-09-06: on
 * the version this client pins (2025-01-27.acacia) `invoice.payment_intent` is
 * there; on the account's newer default it is gone and the intent sits under
 * `payments.data[].payment.payment_intent`. Both expansions are accepted by both
 * versions, so both are asked for and whichever answers is used — otherwise a
 * future default-version bump silently turns this guard off.
 *
 * `requires_action` and `requires_payment_method` are NOT settling: they are the
 * abandoned 3-D Secure and the declined card, which is exactly what this clears.
 */
const SETTLING = ['processing', 'requires_capture', 'succeeded'];

async function abandonedInvoice(sub) {
  const id = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
  if (!id) return null;
  try {
    const invoice = await client().invoices.retrieve(id, {
      expand: ['payment_intent', 'payments.data.payment.payment_intent'],
    });
    const intents = [
      invoice.payment_intent,
      ...(invoice.payments?.data || []).map((entry) => entry.payment?.payment_intent),
    ].filter((intent) => intent && typeof intent === 'object');
    return {
      url: invoice.hosted_invoice_url || null,
      status: invoice.status,
      inFlight: intents.some((intent) => SETTLING.includes(intent.status)),
    };
  } catch (e) {
    // Unreadable is treated as "do not touch": the caller then routes the buyer
    // to the attempt they already have rather than opening a second one.
    log.warn('billing.abandoned_invoice_unreadable', { subscription: sub.id, message: e.message });
    return null;
  }
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw unavailable();
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Purchasable plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ') || 'none configured'}.`,
    });
  }
  const stripe = client();
  // The Stripe customer is created and committed in its OWN short transaction.
  // Inside the long one below, any later failure rolled the stored id back while
  // the Stripe object survived — so every failed checkout during a Stripe incident
  // minted another orphaned customer carrying the buyer's email address, and
  // nothing ever reclaimed them.
  //
  // These are two transactions, so the lock taken here is released before the one
  // below starts — an earlier version of this comment claimed otherwise, and that
  // claim was false. What keeps two simultaneous clicks to one customer is that
  // BOTH transactions take the row lock and re-read the row under it: the second
  // click blocks here, then reads the customer id the first one committed.
  const customerId = await tx(async (tclient) => {
    const run = tclient.query.bind(tclient);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    if (!rows[0]) throw new ApiError(404, 'account_not_found', 'Account not found.');
    return ensureCustomer(rows[0], run);
  });
  // Serialize clicks across all instances, and re-read the authoritative row:
  // two quick clicks on "Choose Pro" used to open two checkouts and could end in
  // two subscriptions on one account, both charged.
  return tx(async (tclient) => {
    const run = tclient.query.bind(tclient);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    account = rows[0];
    if (!account) throw new ApiError(404, 'account_not_found', 'Account not found.');

    // An account that already subscribes is UPGRADED in place. Sending it through
    // Checkout again creates a second subscription next to the first and bills
    // both.
    const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (listed.has_more) throw new ApiError(409, 'billing_review_required', 'Please manage subscriptions through the billing portal.');
    // `incomplete` means the very first payment has not cleared. Stripe leaves
    // it that way for about a day before expiring it, and it never granted
    // anything — treating it as "current" sent a buyer whose 3-D Secure failed
    // to a billing portal with nothing to manage, for 24 hours, instead of
    // letting them simply pay again.
    const current = listed.data.filter((sub) => !['canceled', 'incomplete', 'incomplete_expired'].includes(sub.status)
      && sub.items.data.some((item) => planForPriceId(item.price.id)));
    if (current.length > 1) throw new ApiError(409, 'multiple_subscriptions', 'Multiple subscriptions exist. Contact support before changing your plan.');

    // An `incomplete` subscription grants nothing, but its first invoice stays
    // PAYABLE for about a day — so ignoring it and opening a second checkout is
    // how one buyer ends up paying for two. Measured on 2026-09-06 in test mode
    // against this code: an abandoned $9 attempt, a completed $29 checkout, then
    // the abandoned invoice paid afterwards = two active subscriptions, $38 a
    // month, and the account left on the CHEAPER plan's quota because the later
    // event won. DocMint had the same defect and the same numbers.
    //
    // The buyer must still be able to pay. What they must not be able to do is
    // pay twice for one intention.
    const abandoned = listed.data.filter((sub) => sub.status === 'incomplete'
      && sub.items.data.some((item) => planForPriceId(item.price.id)));
    let finish = null;     // the attempt to hand the buyer back to
    let blocked = false;   // ...or one we may not judge, which also forbids a second
    for (const sub of abandoned) {
      const item = sub.items.data.find((entry) => planForPriceId(entry.price.id));
      // eslint-disable-next-line no-await-in-loop
      const attempt = await abandonedInvoice(sub);
      if (attempt && attempt.status !== 'open') continue;   // nothing payable is left
      const samePlan = Boolean(item && item.price.id === priceId && !current.length);
      if (samePlan || !attempt || attempt.inFlight) {
        blocked = true;
        if (!finish && attempt && attempt.url) finish = attempt;
        continue;
      }
      // They changed their mind. Cancelling an incomplete subscription voids its
      // open invoice, and Stripe then refuses a late payment outright — measured:
      // "Voided invoices cannot be paid."
      // eslint-disable-next-line no-await-in-loop
      await stripe.subscriptions.cancel(sub.id);
      log.info('billing.abandoned_attempt_cancelled', {
        account: account.id, subscription: sub.id, price: item && item.price.id,
      });
    }
    if (blocked) {
      return finish
        ? { url: finish.url }
        : stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
    }

    if (current.length) {
      const sub = current[0];
      const item = sub.items.data.find((entry) => planForPriceId(entry.price.id));
      // Anything not cleanly active (past_due, unpaid, incomplete, a pending
      // change) is a billing problem, not an upgrade. The portal is where those
      // are solved; guessing here is how a card gets charged twice.
      if (!['active', 'trialing'].includes(sub.status) || sub.pending_update) {
        return stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
      }
      if (item.price.id === priceId) {
        await applySubscription(sub, run);
        return { url: `${config.publicUrl}/dashboard?checkout=updated` };
      }
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId, quantity: item.quantity || 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
      }, { idempotencyKey: `mailmint-upgrade-${sub.id}-${item.price.id}-${priceId}-${Math.floor(Date.now() / 1800000)}` });
      // A pending update is an UNPAID upgrade: Stripe keeps the old price until
      // the prorated invoice clears, so the entitlement stays where it is.
      if (updated.pending_update) {
        const invoiceUrl = updated.latest_invoice?.hosted_invoice_url;
        return { url: invoiceUrl || `${config.publicUrl}/dashboard?checkout=pending` };
      }
      await applySubscription(updated, run);
      return { url: `${config.publicUrl}/dashboard?checkout=updated` };
    }

    // Reuse the open session so a double click cannot create two subscriptions.
    const open = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
    if (open.has_more) throw new ApiError(409, 'billing_review_required', 'Please contact support before starting another checkout.');
    for (const session of open.data) {
      if (session.mode !== 'subscription' || session.metadata?.account_id !== String(account.id)) continue;
      if (session.metadata.plan === planId) return session;
      await stripe.checkout.sessions.expire(session.id);
    }
    const payload = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // The session id comes back so the dashboard can VERIFY the payment with
      // Stripe instead of believing `?checkout=success`. See verifyCheckoutReturn.
      success_url: `${config.publicUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
      // One Stripe account sells several products, so its business name is the
      // portfolio's ("Amazing AI Apps") and a MailMint buyer had no idea who was
      // charging them. This overrides the name on THIS session only; the legal
      // entity, receipts, statement descriptor and support details are
      // account-level and deliberately untouched.
      branding_settings: { display_name: BRAND_NAME },
      allow_promotion_codes: true,
      tax_id_collection: { enabled: true },
      billing_address_collection: 'auto',
      customer_update: { name: 'auto', address: 'auto' },
      client_reference_id: String(account.id),
      subscription_data: { metadata: { account_id: String(account.id), plan: planId, service: 'mailmint' } },
      metadata: { account_id: String(account.id), plan: planId, service: 'mailmint' },
    };
    // No idempotency key here, and that is the fix rather than an omission.
    //
    // A key that spans a window replays the response it stored, and the session
    // in that response can be GONE — choosing another plan expires it. Measured
    // on 2026-09-06 against the deployed image: Starter, then Pro, then Starter
    // again handed the buyer the expired Starter session, and Stripe's page told
    // them the checkout had timed out. The replayed body is no help either: it
    // still says `status: "open"` while a fresh retrieve says `expired`, and
    // keying the retry on the dead session's id only moves the problem, because
    // that key is replayable too — DocMint measured exactly that.
    //
    // What actually stops two sessions is above this line: the account row is
    // locked for the whole of this transaction, and the second click finds and
    // returns the first click's OPEN session. The Stripe client still generates
    // its own key per request, so an SDK network retry cannot duplicate anything.
    const session = await stripe.checkout.sessions.create(payload);
    if (session.status && session.status !== 'open') {
      log.warn('billing.fresh_session_not_open', { session: session.id, status: session.status });
    }
    return session;
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
async function applyPlan(accountId, planId, subscriptionId, run = query, customerId = null) {
  const plan = PLANS[planId] || PLANS.free;
  // The customer id is bound here as well as at checkout, the way PDFMint and
  // DocMint do it. An account that acquired a subscription some other way used to
  // keep a null customer id for ever, which put it permanently outside the
  // ownership guard in applySubscription.
  await run(
    `UPDATE accounts SET plan = $2, quota_month = $3, stripe_subscription_id = $4,
            stripe_customer_id = COALESCE(stripe_customer_id, $5)
      WHERE id = $1`,
    [accountId, plan.id, plan.quota, subscriptionId || null, customerId || null],
  );
  log.info('billing.plan_applied', { account_id: Number(accountId), plan: plan.id, quota: plan.quota });
}

/**
 * Decides what a Stripe subscription means for one of our accounts, and applies
 * it. Everything that used to be taken on trust from `metadata` is checked here.
 *
 * The old version read `metadata.plan` and wrote it straight to the quota column.
 * One Stripe account serves PDFMint, DocMint and MailMint, every endpoint on it
 * receives every event, and all three number their accounts from 1 — so a
 * cancelled DocMint subscription tagged `account_id: 71` silently downgraded
 * MailMint account 71. The price, not the metadata, says whose subscription it is.
 */
async function applySubscription(subscription, run = query, { refresh = true } = {}) {
  const accountId = subscription.metadata?.account_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  // A price we cannot map is a sibling product's. Checked on the event body
  // before anything else, because a foreign subscription must not cause us to
  // lock one of our account rows or to call Stripe at all.
  if (!planForPriceId(subscription.items?.data?.[0]?.price?.id)) {
    log.warn('billing.foreign_price_ignored', {
      subscription: subscription.id, price: subscription.items?.data?.[0]?.price?.id,
    });
    return { ignored: 'foreign_price' };
  }

  let target = null;
  if (accountId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]);
    target = rows[0] || null;
  }
  if (!target && customerId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE stripe_customer_id = $1 FOR UPDATE`, [customerId]);
    target = rows[0] || null;
  }
  if (!target) {
    log.warn('billing.subscription_unknown_account', { subscription: subscription.id, customer: customerId });
    return { ignored: 'unknown_account' };
  }

  // The numeric id alone is not proof of ownership; the subscription must sit on
  // the Stripe customer this account is bound to.
  if (customerId && target.stripe_customer_id && target.stripe_customer_id !== customerId) {
    log.warn('billing.foreign_customer_ignored', { subscription: subscription.id, customer: customerId, account_id: target.id });
    return { ignored: 'foreign_customer' };
  }

  /**
   * The event body is a SNAPSHOT of the moment Stripe emitted it, and Stripe
   * delivers a purchase's four events concurrently and in no particular order.
   * `customer.subscription.created` is emitted the instant the subscription
   * exists — which for a card payment is before the card is charged — so its
   * body says `status: "incomplete"` every single time. Acted on as written,
   * and processed last, it set a paying customer back to `free` and cleared the
   * subscription id. Observed happening on 2026-09-06.
   *
   * So the status and the price are read from Stripe as they are NOW, after the
   * account row is locked, which is what makes the outcome independent of
   * delivery order. Stripe says the same thing to every one of the four events;
   * their snapshots do not.
   *
   * A failure here falls back to the snapshot. An outage must not mean a paying
   * customer silently gets nothing — the snapshot is what this used to do in all
   * cases, so the fallback is no worse than before and is loud in the log.
   */
  let current = subscription;
  if (refresh && subscription.id) {
    try {
      const fresh = await client().subscriptions.retrieve(String(subscription.id));
      if (fresh && fresh.id) {
        // Metadata is ours and may only exist on the body we were handed (the
        // checkout path stamps account_id onto it from client_reference_id).
        current = { ...fresh, metadata: { ...(subscription.metadata || {}), ...(fresh.metadata || {}) } };
        if (fresh.status !== subscription.status) {
          log.info('billing.subscription_refreshed', {
            subscription: subscription.id, event_said: subscription.status, stripe_says: fresh.status,
          });
        }
      }
    } catch (e) {
      log.warn('billing.subscription_refresh_failed', {
        subscription: subscription.id, error: String(e.message || e),
        note: 'falling back to the event body, which may be out of date',
      });
    }
  }

  const priceId = current.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId);
  const active = ['active', 'trialing', 'past_due'].includes(current.status);
  if (!plan) {
    log.warn('billing.foreign_price_ignored', { subscription: current.id, price: priceId });
    return { ignored: 'foreign_price' };
  }

  // A cancellation only speaks for the subscription it names. An older one ending
  // must not revoke the one the customer is paying for now.
  if (!active && target.stripe_subscription_id && target.stripe_subscription_id !== subscription.id) {
    log.warn('billing.stale_subscription_ignored', {
      subscription: subscription.id, status: current.status,
      account_id: target.id, current: target.stripe_subscription_id,
    });
    return { ignored: 'stale_subscription' };
  }

  await applyPlan(target.id, active ? plan.id : 'free', active ? subscription.id : null, run, customerId);
  return { applied: active ? plan.id : 'free' };
}

async function handleEvent(event) {
  // The idempotency marker and the fulfilment share one transaction. Written
  // separately, a marker that survived a failed fulfilment turned Stripe's retry
  // into `{duplicate:true}` — the customer had paid and nothing was ever applied.
  return tx(async (tclient) => {
    const run = tclient.query.bind(tclient);
    const { rowCount } = await run(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
    if (!rowCount) return { duplicate: true };

    const obj = event.data.object;
    log.info('billing.event', { type: event.type, stripe_event: event.id });

    switch (event.type) {
      case 'checkout.session.completed': {
        // A completed session is not a paid session. Asynchronous methods finish
        // later, and some finish as a failure; fulfilling here would hand out the
        // quota for a payment that never arrives.
        if (!['paid', 'no_payment_required'].includes(obj.payment_status)) {
          log.warn('billing.session_unpaid', { session: obj.id, payment_status: obj.payment_status });
          break;
        }
        if (obj.subscription) {
          const sub = await client().subscriptions.retrieve(String(obj.subscription));
          if (!sub.metadata?.account_id && obj.client_reference_id) {
            sub.metadata = { ...(sub.metadata || {}), account_id: obj.client_reference_id };
          }
          // Already fetched, and the account_id patched onto it would be lost by
          // a second fetch.
          await applySubscription(sub, run, { refresh: false });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(obj, run);
        break;
      case 'invoice.paid': {
        // A renewal starts a new period, but only once the calendar month has
        // actually turned; the monthly roll already resets the counter on the 1st.
        const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
        if (customerId) {
          await run(
            `UPDATE accounts SET used_month = 0, period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
              WHERE stripe_customer_id = $1 AND period_start < date_trunc('month', now() AT TIME ZONE 'UTC')`,
            [customerId],
          );
        }
        break;
      }
      default:
        break;
    }
    return { handled: event.type };
  });
}

/**
 * C3 — what a return from Checkout is actually allowed to claim.
 *
 * `?checkout=success` is a query parameter. Anyone can type it, a bookmark keeps
 * it, and a shared link carries it. It is not evidence of anything. Neither is
 * "this account is on a paid plan": that only says some earlier payment worked,
 * not that the checkout the customer just came back from was paid.
 *
 * So the page asks Stripe. It resolves the session id that Stripe itself put in
 * the URL, checks the session belongs to this account, checks Stripe considers it
 * paid, and checks our own fulfilment has landed. "Payment received" is returned
 * for exactly one state; everything else gets neutral, honest text.
 */
const CHECKOUT_RETURN = {
  paid: { ok: true, message: 'Payment received. Your new quota is live — it is shown below.' },
  activating: { ok: false, message: 'Payment confirmed. We are activating your plan now — this usually takes a few seconds. Reload this page to see it.' },
  pending: { ok: false, message: 'This checkout is not confirmed yet. Nothing has been charged or activated; your plan below is unchanged.' },
  expired: { ok: false, message: 'That checkout link has expired. Nothing was charged. Choose a plan below to start again.' },
  foreign: { ok: false, message: 'We could not match that checkout to this account. Your plan below is unchanged.' },
  unverified: { ok: false, message: 'We could not confirm a payment for this link. Your plan below is unchanged — if you have just paid, reload in a moment.' },
};

async function verifyCheckoutReturn(account, sessionId) {
  const state = (name, extra = {}) => ({ state: name, ...CHECKOUT_RETURN[name], ...extra });
  // No session id (an old bookmark, a hand-typed URL, a forged link) proves nothing.
  if (!sessionId || typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return state('unverified', { reason: 'no_session_id' });
  }
  if (!enabled()) return state('unverified', { reason: 'billing_disabled' });

  let session;
  try {
    session = await client().checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  } catch (e) {
    log.warn('billing.checkout_return_unverifiable', { session: sessionId, error: e.message });
    return state('unverified', { reason: 'lookup_failed' });
  }

  const claimed = session.client_reference_id || session.metadata?.account_id;
  const sessionCustomer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (String(claimed || '') !== String(account.id)) return state('foreign', { reason: 'account_mismatch' });
  if (account.stripe_customer_id && sessionCustomer && sessionCustomer !== account.stripe_customer_id) {
    return state('foreign', { reason: 'customer_mismatch' });
  }
  // All three products live on ONE Stripe account and all three number their
  // accounts from 1, so a matching account id is not proof either: a sibling
  // product's genuinely paid session would otherwise be accepted here and tell
  // someone who has paid US nothing that their payment is being activated. The
  // line item has to be a price we sell.
  const lineItems = session.line_items?.data || [];
  if (!lineItems.length || !lineItems.some((item) => planForPriceId(item.price?.id))) {
    return state('foreign', { reason: 'not_our_price' });
  }
  if (session.status === 'expired') return state('expired');
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) {
    return state('pending', { reason: `payment_status=${session.payment_status}` });
  }

  // Stripe says paid. That still does not mean OUR side has applied it — the
  // webhook may not have landed. Claiming a live quota before the row moved is
  // the same lie in a different place.
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const fulfilled = account.plan !== 'free' && (!subId || account.stripe_subscription_id === subId);
  return fulfilled ? state('paid') : state('activating');
}

router.post('/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: { code: 'billing_unavailable' } });
  let event;
  try {
    event = client().webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    log.warn('billing.bad_signature', { error: e.message });
    return res.status(400).json({ error: { code: 'invalid_signature' } });
  }
  const out = await handleEvent(event);
  return res.json({ received: true, ...out });
}));

module.exports = {
  router, enabled, createCheckoutSession, createPortalSession, applyPlan, applySubscription,
  handleEvent, isUsableCustomer, verifyCheckoutReturn, BRAND_NAME,
};
