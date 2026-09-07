'use strict';
/**
 * C2/C3/C4 billing guards — the regression suite for the three faults found on
 * 2026-09-06 by walking the real customer journey:
 *
 *   C2  an account that already subscribed got a SECOND subscription instead of an
 *       upgrade, sibling products on the shared Stripe account could downgrade it,
 *       and a webhook that failed half way was swallowed as a duplicate on retry.
 *   C3  the dashboard printed "Payment received" because the URL said
 *       `?checkout=success`. A query parameter is not a receipt.
 *   C4  the Checkout page showed the portfolio's business name, so a buyer could
 *       not tell who was charging them.
 *
 * This file needs no database, no network and no Stripe key: src/billing.js is
 * loaded in a VM with mocked `stripe`, `./db` and `./config`, and every call it
 * makes is recorded. It therefore runs anywhere, including in CI and against a
 * copy of the file pulled out of a production container.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const BILLING = process.env.BILLING_UNDER_TEST || path.join(__dirname, '..', 'src', 'billing.js');
const SOURCE = fs.readFileSync(BILLING, 'utf8');
const PLAN_IDS = ['free', 'starter', 'pro', 'scale'];

function load(opts = {}) {
  const sizes = { free: 10, starter: 5000, pro: 50000, scale: 250000 };
  const PLANS = Object.fromEntries(PLAN_IDS.map((id) => [id, {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    credits: sizes[id],
    quota: sizes[id],
    priceUsd: { free: 0, starter: 9, pro: 29, scale: 99 }[id],
    stripePriceEnv: id === 'free' ? null : `STRIPE_PRICE_${id.toUpperCase()}`,
  }]));
  const priceOf = (id) => (id === 'free' ? null : `price_test_${id}`);

  const calls = { checkoutCreate: [], subUpdate: [], portal: [], expire: [], sessionRetrieve: null, subCancel: [] };
  /** Subscription bodies the test has fired events about, by id. */
  const firedSubjects = new Map();
  const dbUpdates = [];
  const seenEvents = new Set();
  let failDb = false;
  let subscriptions = JSON.parse(JSON.stringify(opts.subscriptions || []));
  let sessions = JSON.parse(JSON.stringify(opts.sessions || []));
  let seq = 0;

  const account = Object.assign({
    id: 71, email: 'guards@example.test', plan: 'free',
    credits_limit: PLANS.free.credits, credits_used: 0,
    quota_month: PLANS.free.quota, used_month: 0,
    stripe_customer_id: null, stripe_subscription_id: null,
  }, opts.account || {});

  const stripe = {
    customers: {
      retrieve: async (id) => ({ id, deleted: false }),
      create: async (args) => ({ id: `cus_new_${++seq}`, ...args }),
    },
    subscriptions: {
      list: async () => {
        if (opts.failAfterCustomer) throw new Error('injected Stripe outage after customer creation');
        return { data: subscriptions, has_more: false };
      },
      /**
       * What Stripe holds right now.
       *
       * A subscription a test seeded with addSubscription() is Stripe's current
       * truth and wins. Otherwise Stripe is assumed to agree with the event body
       * the test fired — which is what makes a test that only fires an event
       * mean what it says, rather than silently being told by this stub that
       * every unknown subscription is an active Pro one.
       */
      retrieve: async (id) => {
        if (opts.failRetrievePermanent) {
          const e = new Error(`No such subscription: ${id}`);
          e.code = 'resource_missing'; e.statusCode = 404;
          throw e;
        }
        if (opts.failRetrieve) throw new Error('injected Stripe outage on subscriptions.retrieve');
        return subscriptions.find((s) => s.id === id) || firedSubjects.get(id) || {
          id, customer: account.stripe_customer_id || 'cus_guards', status: 'active',
          metadata: {}, items: { data: [{ id: 'si_x', price: { id: priceOf('pro') } }] },
        };
      },
      cancel: async (id) => {
        calls.subCancel.push(id);
        subscriptions = subscriptions.map((x) => (x.id === id
          ? { ...x, status: 'incomplete_expired', latest_invoice: { ...(x.latest_invoice || {}), status: 'void' } }
          : x));
        return { id, status: 'incomplete_expired' };
      },
      update: async (id, args, options) => {
        calls.subUpdate.push({ id, args, options });
        const before = subscriptions.find((x) => x.id === id);
        const after = {
          ...before,
          items: { data: [{ ...before.items.data[0], price: { id: args.items[0].price } }] },
          latest_invoice: { hosted_invoice_url: 'https://invoice.invalid/i1' },
        };
        if (opts.pendingUpdate) after.pending_update = { expires_at: 1 };
        subscriptions = subscriptions.map((x) => (x.id === id ? after : x));
        return after;
      },
    },
    checkout: {
      sessions: {
        create: async (args, options) => {
          calls.checkoutCreate.push({ args, options });
          // Stripe replays the STORED body for a repeated idempotency key, and
          // that body still says `status: "open"` even when the session has since
          // been expired — measured 2026-09-06. So `create` always answers "open",
          // and `createStatuses` sets what a fresh RETRIEVE says, which is where
          // the truth shows up.
          const created = { id: `cs_${++seq}`, url: `https://checkout.invalid/cs_${seq}`, status: 'open', ...args };
          sessions.push({ ...created, status: (opts.createStatuses || [])[calls.checkoutCreate.length - 1] || 'open' });
          return created;
        },
        list: async () => ({ data: opts.openSessions || [], has_more: false }),
        expire: async (id) => { calls.expire.push(id); return { id, status: 'expired' }; },
        retrieve: async (id, options) => {
          calls.sessionRetrieve = options && options.expand;
          const found = sessions.find((x) => x.id === id);
          if (!found) {
            const e = new Error('No such checkout session');
            e.code = 'resource_missing'; e.statusCode = 404;
            throw e;
          }
          return found;
        },
      },
    },
    invoices: {
      retrieve: async (id) => {
        const found = subscriptions
          .map((sub) => sub.latest_invoice)
          .find((inv) => inv && typeof inv === 'object' && inv.id === id);
        if (found) return found;
        const e = new Error('No such invoice'); e.code = 'resource_missing'; e.statusCode = 404; throw e;
      },
    },
    billingPortal: { sessions: { create: async (args) => { calls.portal.push(args); return { url: 'https://portal.invalid' }; } } },
    webhooks: { constructEvent: (body) => body },
  };

  const runQuery = async (sql, args = []) => {
    const s = String(sql);
    if (/INSERT INTO stripe_events/i.test(s)) {
      if (seenEvents.has(args[0])) return { rowCount: 0, rows: [] };
      seenEvents.add(args[0]);
      return { rowCount: 1, rows: [] };
    }
    if (/^\s*SELECT/i.test(s)) {
      if (/WHERE\s+id\s*=/i.test(s)) return { rows: String(args[0]) === String(account.id) ? [{ ...account }] : [] };
      if (/stripe_customer_id\s*=\s*\$/i.test(s)) {
        return { rows: args[0] && args[0] === account.stripe_customer_id ? [{ ...account }] : [] };
      }
      return { rows: [{ ...account }] };
    }
    if (/UPDATE\s+accounts/i.test(s)) {
      if (failDb) throw new Error('injected DB failure');
      dbUpdates.push({ sql: s.replace(/\s+/g, ' ').trim(), args });
      for (const [, col, idx] of s.matchAll(/(\w+)\s*=\s*(?:COALESCE\([^,]+,\s*)?\$(\d+)/g)) {
        if (col === 'id') continue;
        if (col === 'stripe_customer_id' && /COALESCE/i.test(s) && account.stripe_customer_id) continue;
        account[col] = args[Number(idx) - 1];
      }
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };

  const tx = async (fn) => {
    const markers = new Set(seenEvents);
    const writes = dbUpdates.length;
    try {
      return await fn({ query: runQuery });
    } catch (e) {
      seenEvents.clear();
      markers.forEach((m) => seenEvents.add(m));
      dbUpdates.length = writes;         // ROLLBACK
      throw e;
    }
  };

  const expressMock = {
    Router: () => {
      const r = { _routes: {}, post: (p, ...h) => { r._routes[p] = h[h.length - 1]; }, get() {}, use() {} };
      return r;
    },
    raw: () => (req, res, next) => next && next(),
    json: () => (req, res, next) => next && next(),
  };
  const logStub = { info() {}, warn() {}, error() {}, debug() {} };
  const requireMock = (name) => {
    if (name === 'express') return expressMock;
    if (name === 'stripe') return function StripeCtor() { return stripe; };
    if (name === './config') {
      return {
        config: {
          publicUrl: 'https://product.invalid',
          billingEnabled: true,
          stripe: { secretKey: 'sk_test_guards', webhookSecret: 'whsec_guards' },
        },
        PLANS,
        planPriceId: priceOf,
        retentionFor: (p) => PLANS[p] || PLANS.free,
      };
    }
    if (name === './db') return { query: runQuery, tx, pool: {} };
    if (name === './log') return Object.assign({}, logStub, { log: logStub });
    if (name === './errors') {
      return {
        ApiError: class ApiError extends Error {
          constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
        },
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };

  const mod = { exports: {} };
  vm.runInNewContext(SOURCE, {
    require: requireMock, module: mod, exports: mod.exports,
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map,
    Promise, Error, RegExp, setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: BILLING });

  const api = mod.exports;
  const fireEvent = async (event) => {
    const subject = event && event.data && event.data.object;
    if (subject && typeof subject.id === 'string' && subject.id.startsWith('sub_') && subject.items) {
      firedSubjects.set(subject.id, subject);
    }
    if (typeof api.handleEvent === 'function') return api.handleEvent(event);
    const route = api.router._routes['/webhook'];
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json: (body) => resolve(body),
        send: (body) => resolve({ body }),
      };
      Promise.resolve(route({ body: event, get: () => 'sig' }, res, reject)).catch(reject);
    });
  };

  return {
    api, account, calls, dbUpdates, priceOf, PLANS, fireEvent,
    setFailDb: (v) => { failDb = v; },
    quota: () => (account.quota_month !== undefined && api.BRAND_NAME === 'MailMint' ? account.quota_month : account.credits_limit),
    addSubscription: (s) => subscriptions.push(s),
    setRetrieveFails: (v) => { opts.failRetrieve = v; },
    setRetrievePermanent: (v) => { opts.failRetrievePermanent = v; },
    addSession: (s) => sessions.push(s),
  };
}

const BRAND = load().api.BRAND_NAME;
const paying = (over = {}) => ({ plan: 'starter', stripe_customer_id: 'cus_guards', stripe_subscription_id: 'sub_existing', ...over });
const existingSub = (h, plan = 'starter') => ({
  id: 'sub_existing', customer: 'cus_guards', status: 'active',
  metadata: { account_id: '71', plan },
  items: { data: [{ id: 'si_existing', price: { id: h.priceOf(plan) }, quantity: 1 }] },
});

describe('C2 — an existing subscription is changed, never duplicated', () => {
  test('two upgrade clicks update the subscription and open no checkout', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second subscription must never be created');
    assert.ok(h.calls.subUpdate.length >= 1, 'the existing subscription must be updated');
  });

  test('duplicate clicks change the subscription once, without a replayable key', async () => {
    // This test used to require an idempotency key on the update and to assert that
    // two clicks shared it. That key is gone: measured on 2026-09-07 against the
    // deployed image, a key spanning a window replays its stored response, so a
    // third click in the same window reached nothing at Stripe at all. The property
    // that mattered — one change, not two — is kept by the row lock and the re-read.
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1,
      'the second click sees the price the first one set and changes nothing');
    assert.ok(!(h.calls.subUpdate[0].options || {}).idempotencyKey);
  });

  test('the upgrade is prorated, and a pending payment grants no quota yet', async () => {
    const h = load({ pendingUpdate: true, account: paying() });
    h.addSubscription(existingSub(h));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    const update = h.calls.subUpdate[0];
    assert.equal(update.args.proration_behavior, 'always_invoice');
    assert.equal(update.args.payment_behavior, 'pending_if_incomplete');
    assert.notEqual(h.quota(), h.PLANS.pro.credits, 'quota must not move before the invoice is paid');
    assert.match(out.url, /invoice|checkout=pending/, 'the customer is sent to the unpaid invoice');
  });

  test('a subscription that is not cleanly active goes to the billing portal', async () => {
    const h = load({ account: paying() });
    const sub = existingSub(h);
    sub.status = 'past_due';
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 0);
    assert.equal(h.calls.checkoutCreate.length, 0);
    assert.equal(h.calls.portal.length, 1);
  });
});

describe('C2 — a half-finished checkout leaves nothing broken behind', () => {
  test('an incomplete first payment still lets the buyer pay again', async () => {
    // Stripe keeps a failed first payment as `incomplete` for about a day. It
    // granted nothing, so parking the buyer in a billing portal for 24 hours
    // instead of a payment page was a revenue bug, not a safety measure.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = existingSub(h);
    sub.id = 'sub_incomplete';
    sub.status = 'incomplete';
    // An incomplete subscription always has its first invoice: the fixture used
    // to leave it out, which is not a state Stripe produces.
    sub.latest_invoice = {
      id: 'in_first', status: 'open', hosted_invoice_url: 'https://invoice.invalid/first',
      payments: { data: [{ payment: { payment_intent: { id: 'pi_first', status: 'requires_payment_method' } } }] },
    };
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer must get a payment page');
    assert.equal(h.calls.portal.length, 0);
  });

  test('a checkout that fails afterwards keeps the Stripe customer it created', async () => {
    // The customer is a real, permanent Stripe object holding the buyer's email.
    // Rolling its id back while the object survives mints a fresh orphan on every
    // retry, and nothing ever reclaims them.
    const h = load({ account: { stripe_customer_id: null }, failAfterCustomer: true });
    await assert.rejects(() => h.api.createCheckoutSession(h.account, 'pro'));
    assert.match(String(h.account.stripe_customer_id), /^cus_/,
      'the id must be committed even though the checkout failed');
  });
});

describe('B — an abandoned first attempt cannot become a second live subscription', () => {
  /**
   * Measured on 2026-09-06 against the deployed image (fff005e), Stripe test
   * mode: an abandoned $9 attempt sat `incomplete` with a payable invoice, the
   * buyer completed a $29 checkout next to it, and paying the abandoned invoice
   * afterwards left TWO active subscriptions — $38.00 a month — with the account
   * on the CHEAPER plan's quota, starter/5000 instead of pro/25000.
   *
   * DocMint had the identical defect and the identical numbers.
   */
  const incompleteSub = (h, plan = 'starter', over = {}) => ({
    id: 'sub_incomplete', customer: 'cus_guards', status: 'incomplete',
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_inc', price: { id: h.priceOf(plan) }, quantity: 1 }] },
    latest_invoice: {
      id: 'in_inc', status: 'open', hosted_invoice_url: 'https://invoice.invalid/pay-me',
      payments: { data: [{ payment: { payment_intent: { id: 'pi_inc', status: 'requires_payment_method' } } }] },
    },
    ...over,
  });

  test('asking for the same plan again finishes the payment already started', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'pro'));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second subscription must not be started');
    assert.match(out.url, /invoice\.invalid/, 'the buyer is sent to the invoice they already owe');
    assert.equal(h.calls.subCancel.length, 0);
  });

  test('changing plan cancels the abandoned attempt before opening a new checkout', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.subCancel, ['sub_incomplete'],
      'the abandoned invoice must stop being payable, or it can be paid later');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer still gets a payment page');
  });

  test('an abandoned attempt next to a live subscription is cancelled, not paid', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    h.addSubscription(incompleteSub(h, 'pro'));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.subCancel, ['sub_incomplete']);
    assert.equal(h.calls.checkoutCreate.length, 0, 'the live subscription is upgraded in place');
  });

  test('a payment that is still in flight is never cancelled', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'starter', {
      latest_invoice: {
        id: 'in_inc', status: 'open', hosted_invoice_url: 'https://invoice.invalid/pay-me',
        payments: { data: [{ payment: { payment_intent: { id: 'pi_inc', status: 'processing' } } }] },
      },
    }));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'a settling payment must not be voided');
    assert.equal(h.calls.checkoutCreate.length, 0);
    assert.match(out.url, /invoice\.invalid|portal\.invalid/);
  });

  test('an attempt whose invoice cannot be read is never replaced by a second one', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = incompleteSub(h, 'starter');
    sub.latest_invoice = 'in_gone';
    h.addSubscription(sub);
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'nothing is voided on a guess');
    assert.equal(h.calls.checkoutCreate.length, 0, 'and no second payable thing is created');
    assert.match(out.url, /portal\.invalid|invoice\.invalid/);
  });

  test("a sibling product's incomplete subscription is not ours to cancel", async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription({
      id: 'sub_sibling_incomplete', customer: 'cus_guards', status: 'incomplete',
      metadata: { account_id: '71' },
      items: { data: [{ id: 'si_s', price: { id: 'price_of_a_sibling_product' }, quantity: 1 }] },
      latest_invoice: { id: 'in_s', status: 'open', hosted_invoice_url: 'https://invoice.invalid/sibling', payments: { data: [] } },
    });
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'we only ever touch prices we sell');
    assert.equal(h.calls.checkoutCreate.length, 1);
  });
});

describe('D — a retry never hands back a dead checkout link', () => {
  /**
   * Measured on 2026-09-06 against the deployed image: Starter -> Pro -> Starter
   * inside half an hour returned the FIRST session, which the plan switch had
   * expired, so Stripe's page told the buyer the checkout had timed out and they
   * could not pay at all.
   *
   * A windowed idempotency key replays the response it stored, and the session in
   * it can be gone. Reading it back and retrying under a second deterministic key
   * does not help — DocMint measured that second key replaying a dead session of
   * its own — so checkout creation carries no key of ours.
   */
  test('creating a checkout carries no replayable key of ours', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 1);
    const options = h.calls.checkoutCreate[0].options || {};
    assert.ok(!options.idempotencyKey,
      'a windowed key replays whatever it stored, including a session that has since expired');
  });

  test('a second click on the same plan reuses the session that is still open', async () => {
    const open = {
      id: 'cs_open', mode: 'subscription', status: 'open',
      url: 'https://checkout.invalid/cs_open',
      metadata: { account_id: '71', plan: 'starter' },
    };
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, openSessions: [open] });
    const out = await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 0, 'no second session is created');
    assert.equal(out.id, 'cs_open');
  });

  test('a session left open for a DIFFERENT plan is expired, not handed over', async () => {
    const open = {
      id: 'cs_other', mode: 'subscription', status: 'open',
      url: 'https://checkout.invalid/cs_other',
      metadata: { account_id: '71', plan: 'pro' },
    };
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, openSessions: [open] });
    const out = await h.api.createCheckoutSession(h.account, 'starter');
    assert.deepEqual(h.calls.expire, ['cs_other']);
    assert.equal(h.calls.checkoutCreate.length, 1);
    assert.notEqual(out.id, 'cs_other');
  });
});

describe('C2 — one Stripe account serves several products', () => {
  test("a sibling product's cancellation cannot downgrade this account", async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_foreign', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_foreign', status: 'canceled', customer: 'cus_someone_else',
        metadata: { account_id: '71', plan: 'pro', service: 'other-product' },
        items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a paying customer must not be downgraded by another product');
    assert.equal(h.dbUpdates.length, 0, 'and nothing at all may be written');
  });

  test('an event for a different Stripe customer is not applied here', async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_wrongcustomer', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_of_another_customer', status: 'active', customer: 'cus_not_ours',
        metadata: { account_id: '71', plan: 'scale' },
        items: { data: [{ price: { id: h.priceOf('scale') } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a matching numeric id is not proof of ownership');
  });

  test('a stale subscription ending does not revoke the current one', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_new' }) });
    await h.fireEvent({
      id: 'evt_stale', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_old', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'starter' },
        items: { data: [{ price: { id: h.priceOf('starter') } }] },
      } },
    });
    assert.equal(h.account.plan, 'pro');
    assert.equal(h.account.stripe_subscription_id, 'sub_new');
  });

  test('cancelling the CURRENT subscription still downgrades, as it must', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_own_cancel', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_mine', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
        items: { data: [{ price: { id: h.priceOf('pro') } }] },
      } },
    });
    assert.equal(h.account.plan, 'free', 'the guards must not have made cancellation impossible');
  });
});

describe('E — the provider and the product must not disagree about the plan', () => {
  /**
   * PDFMint measured this on its copy of this code and reported it across; DocMint
   * measured it on its own. Measured HERE on the deployed MailMint image
   * (`30e513b`), a fresh subscription, three clicks inside ONE idempotency window:
   *
   *   click pro     -> stripe=pro      db=pro|25000
   *   click starter -> stripe=starter  db=starter|5000
   *   click pro     -> stripe=starter  db=starter|5000     <- the click did nothing
   *
   * The third click sends the first click's key again, Stripe replays its stored
   * response, nothing is changed at Stripe — and because the C5 read-back keeps the
   * product honest, the customer is simply told "your plan change has been sent"
   * while their plan does not change, for up to thirty minutes.
   */
  const active = (h, plan) => ({
    id: 'sub_live', customer: 'cus_guards', status: 'active',
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_live', price: { id: h.priceOf(plan) }, quantity: 1 }] },
  });

  test('an upgrade carries no key that a later click could replay', async () => {
    const h = load({ account: paying() });
    h.addSubscription(active(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1);
    assert.ok(!(h.calls.subUpdate[0].options || {}).idempotencyKey,
      'a windowed key replays the first response, so an identical later click never reaches Stripe');
  });

  test('clicking the plan the account is already on updates nothing at Stripe', async () => {
    const h = load({ account: paying({ plan: 'pro' }) });
    h.addSubscription(active(h, 'pro'));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 0);
    assert.equal(h.calls.checkoutCreate.length, 0);
    assert.match(out.url, /checkout=updated/);
  });

  test('a blip after Stripe has already changed the plan does not throw the change away', async () => {
    const h = load({ account: paying() });
    h.addSubscription(active(h, 'starter'));
    h.setRetrieveFails(true);
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1, 'Stripe was asked to change the plan');
    assert.equal(h.account.plan, 'pro', 'and the account holds what Stripe now charges for');
    assert.match(out.url, /checkout=updated/);
  });

  test('re-clicking the plan you are already on cannot 503 on a redundant read', async () => {
    const h = load({ account: paying({ plan: 'pro' }) });
    h.addSubscription(active(h, 'pro'));
    h.setRetrieveFails(true);
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.match(out.url, /checkout=updated/);
    assert.equal(h.account.plan, 'pro');
  });
});

describe('E — a read we could not make is not a fact we may act on', () => {
  /**
   * Measured on the deployed MailMint image with Stripe genuinely unreachable from
   * the container (`--add-host api.stripe.com:127.0.0.1`; nothing about the code
   * changed), delivering the genuine `customer.subscription.created` event whose
   * body says `incomplete`, as every one of them does:
   *
   *   before  starter|5000|sub_1UCqvx…      after  free|300|(cleared)
   *   HTTP 200, and the event id consumed
   *
   * The fallback to the event body existed so an outage would not leave a paying
   * customer with nothing. It did exactly that, told Stripe everything was fine so
   * nothing was retried, and consumed the event id so the retry would have been a
   * duplicate.
   */
  const body = (h, status) => ({
    id: 'sub_live', customer: 'cus_guards', status,
    metadata: { account_id: '71', plan: 'pro' },
    items: { data: [{ id: 'si_live', price: { id: h.priceOf('pro') }, quantity: 1 }] },
  });

  test('a stale "incomplete" body cannot downgrade a paid account when Stripe is down', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), failRetrieve: true });
    await assert.rejects(
      () => h.fireEvent({ id: 'evt_o1', type: 'customer.subscription.created', data: { object: body(h, 'incomplete') } }),
      'the delivery must fail so Stripe retries it',
    );
    assert.equal(h.account.plan, 'pro');
    assert.equal(h.account.stripe_subscription_id, 'sub_live');
  });

  test('and the event id is not consumed, so the retry still fulfils', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), failRetrieve: true });
    const event = { id: 'evt_o2', type: 'customer.subscription.updated', data: { object: body(h, 'incomplete') } };
    await assert.rejects(() => h.fireEvent(event));
    h.setRetrieveFails(false);
    h.addSubscription(body(h, 'active'));
    const retry = await h.fireEvent(event);
    assert.ok(!retry.duplicate, 'the marker must have rolled back with the failed transaction');
    assert.equal(h.account.plan, 'pro');
  });

  test('nor may an unverifiable body grant a plan', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, failRetrieve: true });
    await assert.rejects(
      () => h.fireEvent({ id: 'evt_o3', type: 'customer.subscription.updated', data: { object: body(h, 'active') } }),
    );
    assert.equal(h.account.plan, 'free');
  });

  test('a failure Stripe will never resolve is answered, but still writes nothing', async () => {
    // "No such subscription", a key in the wrong mode, a restricted key: retrying
    // for three days cannot fix any of them, and an endpoint that fails
    // continuously eventually gets disabled — which would take the deliveries that
    // DO work down with it. So this one is answered. It still writes nothing, and
    // it still does not consume the event id.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), failRetrievePermanent: true });
    const event = { id: 'evt_perm', type: 'customer.subscription.created', data: { object: body(h, 'incomplete') } };
    const out = await h.fireEvent(event);
    assert.equal(out.ignored, 'subscription_unverifiable');
    assert.equal(h.account.plan, 'pro', 'nothing decided from the body');

    h.setRetrievePermanent(false);
    h.addSubscription(body(h, 'active'));
    const again = await h.fireEvent(event);
    assert.ok(!again.duplicate, 'the event id was not consumed, so a redelivery still works');
  });

  test("a sibling product's event still costs nothing, outage or not", async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), failRetrieve: true });
    const out = await h.fireEvent({ id: 'evt_o4', type: 'customer.subscription.deleted', data: { object: {
      id: 'sub_of_another_product', customer: 'cus_guards', status: 'canceled', metadata: { account_id: '71' },
      items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    } } });
    assert.ok(out, 'answered, not retried forever');
    assert.equal(h.account.plan, 'pro');
  });
});

describe('C2 — a webhook that fails is retried for real', () => {
  const event = {
    id: 'evt_retry', type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_retry', payment_status: 'paid', subscription: 'sub_paid',
      client_reference_id: '71', customer: 'cus_guards',
      metadata: { account_id: '71', plan: 'pro' },
    } },
  };

  test('a failure rolls the idempotency marker back, so the retry fulfils', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    h.setFailDb(true);
    await assert.rejects(() => h.fireEvent(event));
    h.setFailDb(false);
    const retry = await h.fireEvent(event);
    assert.ok(!retry.duplicate, 'the retry must not be swallowed as a duplicate');
    assert.equal(h.account.plan, 'pro', 'the customer paid, so the plan must land');
  });

  test('a genuine duplicate delivery is still a no-op', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent(event);
    const writes = h.dbUpdates.length;
    const again = await h.fireEvent(event);
    assert.ok(again.duplicate, 'the second delivery is a duplicate');
    assert.equal(h.dbUpdates.length, writes, 'and writes nothing further');
  });

  test('an unpaid checkout session grants no plan', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_incomplete', customer: 'cus_guards', status: 'incomplete',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent({
      id: 'evt_unpaid', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_unpaid', payment_status: 'unpaid', subscription: 'sub_incomplete',
        client_reference_id: '71', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
      } },
    });
    assert.equal(h.account.plan, 'free');
  });
});

describe('C3 — a query parameter is not a receipt', () => {
  const priceOf = load().priceOf;
  const session = (over = {}) => ({
    id: 'cs_real', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    client_reference_id: '71', customer: 'cus_guards', subscription: 'sub_paid',
    line_items: { data: [{ price: { id: priceOf('pro') } }] },
    metadata: { account_id: '71', plan: 'pro' }, ...over,
  });

  test('the dashboard exposes a server-side verifier at all', () => {
    assert.equal(typeof load().api.verifyCheckoutReturn, 'function',
      'without this the page can only be trusting ?checkout=success');
  });

  test('a forged ?checkout=success on a free account claims nothing', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a forged ?checkout=success on an ALREADY-PAID account claims nothing', async () => {
    // An existing paid plan proves an earlier payment, never THIS checkout.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_old' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a real, paid, already-fulfilled session is confirmed', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'paid');
    assert.equal(out.ok, true);
  });

  test('paid but not yet fulfilled reads as activating, not as live quota', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'activating');
    assert.equal(out.ok, false);
  });

  test('an unpaid session reads as pending', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ payment_status: 'unpaid', status: 'open', subscription: null }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'pending');
  });

  test("another account's session is refused", async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ client_reference_id: '999', customer: 'cus_someone_else', metadata: { account_id: '999' } }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test("a SIBLING PRODUCT's paid session claims nothing here", async () => {
    // One Stripe account sells all three products and all three number their
    // accounts from 1, so a matching account id is not proof of anything.
    const h = load({ account: { stripe_customer_id: null } });
    h.addSession(session({
      customer: 'cus_of_the_other_product',
      line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test('an unknown session id is unverified, never paid', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_does_not_exist');
    assert.notEqual(out.state, 'paid');
  });
});

describe(`C4 — the Checkout page says ${BRAND}, not the portfolio's name`, () => {
  test('the session carries branding_settings.display_name', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.equal(args.branding_settings.display_name, BRAND);
  });

  test('the success URL hands the session id back so C3 can verify it', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.match(args.success_url, /\{CHECKOUT_SESSION_ID\}/);
  });
});

/**
 * C5 — Stripe delivers a purchase's four events CONCURRENTLY, and the event body
 * is a snapshot of the moment it was emitted, not of now.
 *
 * `customer.subscription.created` is emitted the instant the subscription
 * exists, which for a card payment is BEFORE the card is charged: its snapshot
 * says `status: "incomplete"` every time. Whether the customer keeps the plan
 * they paid for therefore came down to which of the four events happened to be
 * processed last. Observed on 2026-09-06 in a real test-mode purchase, in the
 * deployed logs, three accounts in a row:
 *
 *   account 20  completed(starter) after created(free)  -> starter   (lucky)
 *   account 21  created(free)      after completed      -> FREE      (paid $9)
 *
 * The account was left on the free plan with its subscription id cleared, while
 * Stripe held an active, paid subscription. A coin flip on every purchase.
 */
describe('C5 — a stale event body must not revoke a paid plan', () => {
  /** What Stripe puts in `customer.subscription.created` for a card payment. */
  const incompleteSnapshot = (h) => ({
    id: 'sub_existing', customer: 'cus_guards', status: 'incomplete',
    metadata: { account_id: '71' },
    items: { data: [{ id: 'si_existing', price: { id: h.priceOf('starter') }, quantity: 1 }] },
  });

  test('an "incomplete" snapshot arriving last does not undo the payment', async () => {
    const h = load({ account: paying({ plan: 'starter', stripe_subscription_id: 'sub_existing' }) });
    // Stripe's current truth: the payment went through.
    h.addSubscription(existingSub(h));

    await h.fireEvent({
      id: 'evt_created_late', type: 'customer.subscription.created',
      data: { object: incompleteSnapshot(h) },
    });

    assert.equal(h.account.plan, 'starter',
      'the plan the customer paid for must survive an out-of-order event body');
    assert.equal(h.account.stripe_subscription_id, 'sub_existing',
      'and the subscription id must not be cleared, or nothing can manage or cancel it later');
    assert.equal(h.quota(), h.PLANS.starter.quota);
  });

  test('the same snapshot arriving FIRST still grants the plan once Stripe is asked', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(existingSub(h));
    await h.fireEvent({
      id: 'evt_created_first', type: 'customer.subscription.created',
      data: { object: incompleteSnapshot(h) },
    });
    assert.equal(h.account.plan, 'starter', 'order must stop deciding the outcome in either direction');
  });

  test('a payment that really did fail still grants nothing', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    // Stripe's current truth: still incomplete, because the card was declined.
    h.addSubscription({ ...incompleteSnapshot(h) });
    await h.fireEvent({
      id: 'evt_declined', type: 'customer.subscription.created',
      data: { object: incompleteSnapshot(h) },
    });
    assert.equal(h.account.plan, 'free', 'an unpaid subscription must not entitle anyone');
    assert.equal(h.account.stripe_subscription_id, null);
  });

  test('a real cancellation still downgrades', async () => {
    const h = load({ account: paying({ plan: 'starter', stripe_subscription_id: 'sub_existing' }) });
    const canceled = { ...existingSub(h), status: 'canceled' };
    h.addSubscription(canceled);
    await h.fireEvent({
      id: 'evt_deleted', type: 'customer.subscription.deleted',
      data: { object: canceled },
    });
    assert.equal(h.account.plan, 'free', 'cancelling must still work');
    assert.equal(h.account.stripe_subscription_id, null);
  });

  test('if Stripe cannot be reached the event is NOT acted on, and stays retryable', async () => {
    // This test used to require the opposite — fall back to the event body, so that
    // "a Stripe outage must not mean a paid customer silently gets nothing". It was
    // written before the outage was simulated. When it was, on the deployed image
    // with Stripe genuinely unreachable, the fallback took a paying account from
    // starter/5000 to free/300 and answered HTTP 200, so nothing was ever retried.
    // The customer gets what they paid for on the redelivery instead.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }), failRetrieve: true });
    h.addSubscription(existingSub(h));
    const event = { id: 'evt_offline', type: 'customer.subscription.updated', data: { object: existingSub(h) } };
    await assert.rejects(() => h.fireEvent(event), 'the delivery fails so Stripe retries it');
    assert.equal(h.account.plan, 'free', 'nothing is written from a snapshot we cannot confirm');

    h.setRetrieveFails(false);
    const retry = await h.fireEvent(event);
    assert.ok(!retry.duplicate, 'and the retry is not swallowed');
    assert.equal(h.account.plan, 'starter', 'the paid plan lands, a little later');
  });
});
