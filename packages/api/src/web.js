'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const { config, PLANS, planPriceId } = require('./config');
const { query } = require('./db');
const { log } = require('./log');
const { escapeHtml, json, timeAgo } = require('./html');
const { flagField, needsReview } = require('./parser');
const {
  createAccount, verifyLogin, createSession, accountForSession, destroySession,
  issueApiKey, revokeApiKey, stashKeyForSession, takeKeyForSession,
} = require('./auth');
const mailboxes = require('./mailboxes');
const messages = require('./messages');
const pipeline = require('./pipeline');
const webhooks = require('./webhooks');
const reparse = require('./reparse');
const endpoints = require('./webhook-endpoints');
const billing = require('./billing');
const { validateSchema, TYPES } = require('./schema');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'mailmint_session';

const CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');

function shell(title, body, opts = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(opts.description || 'MailMint turns inbound email into structured JSON.')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body>${body}
<script>
document.addEventListener('click',(e)=>{
  const b=e.target.closest('.copy'); if(!b) return;
  const el=document.getElementById(b.dataset.target); if(!el) return;
  navigator.clipboard.writeText(el.textContent.trim());
  const t=b.textContent; b.textContent='Copied'; setTimeout(()=>{b.textContent=t;},1400);
});
</script></body></html>`;
}

function setSessionCookie(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https'),
    maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
}
function sessionIdFrom(req) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
const currentAccount = (req) => {
  const id = sessionIdFrom(req);
  return id ? accountForSession(id) : null;
};
const requireAccount = asyncRoute(async (req, res, next) => {
  req.account = await currentAccount(req);
  if (!req.account) return res.redirect('/login');
  return next();
});

const topbar = (badge = 0) => `<header class="topbar"><a class="logo" href="/dashboard">Mail<span>Mint</span></a>
  <nav><a href="/dashboard/review">Review${badge ? ` <span class="flag review">${badge}</span>` : ''}</a>
  <a href="/docs">Docs</a><a href="/docs/reference">Reference</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav></header>`;

/* ------------------------------------------------------------ auth pages */

function authForm(kind, error, values = {}) {
  const isSignup = kind === 'signup';
  return shell(isSignup ? 'Create your MailMint account' : 'Sign in to MailMint', `
<main class="auth">
  <a class="logo" href="/">Mail<span>Mint</span></a>
  <h1>${isSignup ? 'Create your account' : 'Sign in'}</h1>
  <p class="sub">${isSignup
    ? `You get an inbound email address straight away. ${PLANS.free.quota} parsed emails a month, free, no card.`
    : 'Welcome back.'}</p>
  ${isSignup ? '<p class="warnbox">There is no password reset and no confirmation email yet, so nothing can be sent to you if you forget it. Put the password in your password manager now.</p>' : ''}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/${kind}">
    <label>Email<input type="email" name="email" required autocomplete="email" value="${escapeHtml(values.email || '')}"></label>
    <label>Password<input type="password" name="password" required minlength="8" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></label>
    <button type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
  </form>
  <p class="alt">${isSignup ? 'Already have an account? <a href="/login">Sign in</a>' : 'No account yet? <a href="/signup">Create one</a>'}</p>
</main>`);
}

router.get('/', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  return res.type('html').send(shell('MailMint — inbound email to structured JSON', `
<main class="auth" style="max-width:640px">
  <a class="logo" href="/">Mail<span>Mint</span></a>
  <h1>Email in. JSON out.</h1>
  <p class="sub">You get an address like <code>k7m2xq4h9bwz@${escapeHtml(config.inboundDomain)}</code>.
    Anything sent to it is parsed into the fields you asked for and delivered by webhook,
    by polling, or into n8n.</p>
  <ol class="steps">
    <li>Create an account — an address is waiting when you land.</li>
    <li>Say which fields you want. Name, type, one line of description.</li>
    <li>Send it an email. The parsed JSON is on the page.</li>
  </ol>
  <form method="get" action="/signup"><button>Get an address</button></form>
  <p class="alt">${PLANS.free.quota} parsed emails a month, free, no card. <a href="/login">Sign in</a></p>
</main>`, { description: 'MailMint gives you an inbound email address and turns the mail sent to it into structured JSON.' }));
}));

router.get('/signup', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  return res.type('html').send(authForm('signup', null));
}));

router.get('/login', asyncRoute(async (req, res) => {
  if (await currentAccount(req)) return res.redirect('/dashboard');
  return res.type('html').send(authForm('login', null));
}));

router.post('/signup', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) {
    return res.status(400).type('html').send(authForm('signup', 'Enter an email address and a password of at least 8 characters.', { email }));
  }
  const normalised = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(normalised)) {
    return res.status(400).type('html').send(authForm('signup', 'That does not look like an email address.', { email }));
  }
  const { rows } = await query(`SELECT id FROM accounts WHERE email = $1`, [normalised]);
  if (rows.length) {
    return res.status(409).type('html').send(authForm('signup', 'That email already has an account. Sign in instead.', { email }));
  }
  const { account, apiKey } = await createAccount(normalised, password);
  // An address on the very first screen is the whole point. An account with no
  // mailbox would put an extra decision between signing up and seeing JSON.
  await mailboxes.create(account.id, { name: 'Inbox' });
  const sessionId = await createSession(account.id);
  setSessionCookie(res, sessionId);
  stashKeyForSession(sessionId, apiKey);
  log.info('account.created', { account_id: Number(account.id) });
  return res.redirect('/dashboard?welcome=1');
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const account = await verifyLogin(email || '', password || '');
  if (!account) return res.status(401).type('html').send(authForm('login', 'Wrong email or password.', { email }));
  setSessionCookie(res, await createSession(account.id));
  return res.redirect('/dashboard');
}));

router.post('/logout', asyncRoute(async (req, res) => {
  const id = sessionIdFrom(req);
  if (id) await destroySession(id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect('/');
}));

/* ------------------------------------------------------------- dashboard */

router.get('/dashboard', requireAccount, asyncRoute(async (req, res) => {
  const account = req.account;
  const boxes = await mailboxes.list(account.id);
  const { rows: keys } = await query(
    `SELECT prefix, name, created_at, last_used_at FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [account.id],
  );
  const { rows: recent } = await query(
    `SELECT id, mailbox_id, subject, from_email, status, needs_review, flags, received_at
       FROM messages WHERE account_id = $1 ORDER BY received_at DESC LIMIT 8`, [account.id],
  );
  const { rows: reviewCount } = await query(
    `SELECT count(*)::int AS n FROM messages WHERE account_id = $1 AND needs_review`, [account.id],
  );
  const fullKey = takeKeyForSession(sessionIdFrom(req));
  const plan = PLANS[account.plan] || PLANS.free;
  const pct = Math.min(100, Math.round((account.used_month / Math.max(1, account.quota_month)) * 100));
  const purchasable = Object.values(PLANS).filter((p) => planPriceId(p.id));
  const hasSchema = boxes.some((b) => (b.schema || []).length);
  const hasMail = recent.length > 0;

  res.type('html').send(shell('MailMint dashboard', `${topbar(reviewCount[0].n)}
<main>
  ${req.query.welcome ? '<div class="notice"><strong>Your address is live.</strong> Copy the API key below — it is shown once — then open your mailbox and send it an email.</div>' : ''}
  ${req.query.checkout === 'success' ? '<div class="notice ok"><strong>Payment received.</strong> Your new quota is shown below.</div>' : ''}
  ${req.query.checkout === 'cancelled' ? '<div class="notice">Checkout cancelled. Nothing was charged.</div>' : ''}
  ${req.query.err ? `<div class="error">${escapeHtml(String(req.query.err))}</div>` : ''}
  <h1>Dashboard</h1>

  <ol class="steps">
    <li class="done">Account created — you have an inbound address.</li>
    <li class="${hasSchema ? 'done' : ''}">${hasSchema ? 'Schema defined.' : 'Define the fields you want extracted — open a mailbox below.'}</li>
    <li class="${hasMail ? 'done' : ''}">${hasMail ? 'Mail received and parsed.' : 'Send an email to the address, or use the test panel on the mailbox page.'}</li>
  </ol>
  ${reviewCount[0].n ? `<div class="notice"><strong>${reviewCount[0].n} message${reviewCount[0].n === 1 ? '' : 's'} need${reviewCount[0].n === 1 ? 's' : ''} review.</strong>
    A field came back empty, disagreed with the rule layer, or did not add up.
    <a href="/dashboard/review">Open the review queue</a>.</div>` : ''}

  <section class="card">
    <div class="mbhead"><h2>Mailboxes</h2>
      <form method="post" action="/dashboard/mailboxes" class="inline" style="margin:0">
        <input type="text" name="name" placeholder="Invoices" maxlength="80" required>
        <button>New mailbox</button>
      </form></div>
    ${boxes.length ? `<table class="rows">
      <tr><th>Address</th><th>Name</th><th>Fields</th><th>Webhook</th><th></th></tr>
      ${boxes.map((b) => `<tr>
        <td><span class="addr">${escapeHtml(b.token)}@${escapeHtml(config.inboundDomain)}</span></td>
        <td>${escapeHtml(b.name)}</td>
        <td>${(b.schema || []).length || '<span class="muted">none</span>'}</td>
        <td>${b.webhook_url ? '<span class="ok">set</span>' : '<span class="muted">—</span>'}</td>
        <td><a href="/dashboard/mailboxes/${encodeURIComponent(b.id)}">Open</a></td></tr>`).join('')}
    </table>` : '<p class="muted">No mailboxes yet.</p>'}
  </section>

  <section class="card">
    <h2>API key</h2>
    ${fullKey ? `<p class="keybox"><code id="k">${escapeHtml(fullKey)}</code><button class="copy" data-target="k">Copy</button></p>
      <p class="muted small">Shown once and never again — not here, not by support. Store it now.
      A key starting <code>mm_test_</code> works everywhere a live key does but is never counted against your quota.</p>` : ''}
    <table class="rows">
      <tr><th>Key</th><th>Name</th><th>Created</th><th>Last used</th><th></th></tr>
      ${keys.map((k) => `<tr><td><code>${escapeHtml(k.prefix)}…</code></td><td>${escapeHtml(k.name)}</td>
        <td>${new Date(k.created_at).toISOString().slice(0, 10)}</td>
        <td>${k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</td>
        <td>${keys.length > 1 ? `<form method="post" action="/dashboard/keys/revoke" class="inline" style="margin:0"
          onsubmit="return confirm('Revoke ${escapeHtml(k.prefix)}…? Anything using it stops working immediately.')">
          <input type="hidden" name="prefix" value="${escapeHtml(k.prefix)}"><button class="link danger">Revoke</button></form>`
    : '<span class="muted">only key</span>'}</td></tr>`).join('')}
    </table>
    <form method="post" action="/dashboard/keys" class="inline">
      <input type="text" name="name" placeholder="n8n" maxlength="40">
      <label class="chk" style="flex-direction:row"><input type="checkbox" name="mode" value="test"> test key (never billed)</label>
      <button class="secondary">Create key</button>
    </form>
  </section>

  <section class="card">
    <h2>Usage this month</h2>
    <p class="big">${account.used_month.toLocaleString('en-US')} <span class="muted">of ${account.quota_month.toLocaleString('en-US')} parsed emails</span></p>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <p class="muted small">Plan: <strong>${escapeHtml(plan.name)}</strong>${plan.priceUsd ? ` — $${plan.priceUsd}/month` : ' — free'}. Resets on the 1st.
      Over the quota your mail is still received and stored; only the extraction pass stops.</p>
    ${recent.length ? `<table class="rows"><tr><th>When</th><th>From</th><th>Subject</th><th>Status</th></tr>
      ${recent.map((m) => `<tr><td>${timeAgo(m.received_at)}</td><td>${escapeHtml(m.from_email || '—')}</td>
        <td><a href="/dashboard/mailboxes/${encodeURIComponent(m.mailbox_id)}#${escapeHtml(m.id)}">${escapeHtml((m.subject || '(no subject)').slice(0, 60))}</a></td>
        <td>${m.status === 'parsed' ? (m.needs_review ? '<span class="flag review">needs review</span>' : '<span class="ok">parsed</span>') : `<span class="bad">${escapeHtml(m.status)}</span>`}</td></tr>`).join('')}
    </table>` : '<p class="muted">No mail yet.</p>'}
  </section>

  ${purchasable.length ? `<section class="card">
    <h2>Plan</h2>
    <div class="plans">${purchasable.map((p) => `<div class="plan${account.plan === p.id ? ' current' : ''}">
      <h3>${escapeHtml(p.name)}</h3><p class="price">$${p.priceUsd}<span>/mo</span></p>
      <p class="muted small">${p.quota.toLocaleString('en-US')} emails / month</p>
      ${account.plan === p.id ? '<p class="tag">Current plan</p>'
    : `<form method="post" action="/dashboard/checkout"><input type="hidden" name="plan" value="${p.id}"><button>Choose ${escapeHtml(p.name)}</button></form>`}
    </div>`).join('')}</div>
    ${account.stripe_customer_id ? '<form method="post" action="/dashboard/portal"><button class="secondary">Manage billing</button></form>' : ''}
  </section>` : `<section class="card"><h2>Plan</h2>
    <p class="muted">You are on <strong>${escapeHtml(plan.name)}</strong> — ${plan.quota.toLocaleString('en-US')} parsed emails a month.
    Paid plans are not open on this deployment yet.</p></section>`}

  <section class="card">
    <h2>Password</h2>
    ${req.query.pw === 'ok' ? '<div class="notice ok">Password changed.</div>' : ''}
    ${req.query.pw === 'wrong' ? '<div class="error">That is not your current password.</div>' : ''}
    ${req.query.pw === 'short' ? '<div class="error">The new password must be at least 8 characters.</div>' : ''}
    <p class="muted small">There is no password reset by email. Change it here while you are signed in.</p>
    <form method="post" action="/dashboard/password" class="inline">
      <label>Current<input type="password" name="current" required autocomplete="current-password"></label>
      <label>New<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
      <button class="secondary">Change password</button>
    </form>
  </section>
</main>`));
}));

/* -------------------------------------------------------- review queue */

/**
 * The review queue.
 *
 * The strongest single finding in the market research: almost nobody asks for
 * better accuracy in the abstract — they ask "how do I find out that it went
 * wrong". Every incumbent answers that with silence, so this page IS the
 * product surface for it. Newest first, the flagged field next to the exact
 * evidence string the value came from, and re-parse in one click.
 */
router.get('/dashboard/review', requireAccount, asyncRoute(async (req, res) => {
  const account = req.account;
  const flag = req.query.flag ? String(req.query.flag) : null;
  const params = [account.id];
  let clause = '';
  if (flag) { params.push(flag); clause = `AND m.flags @> ARRAY[$${params.length}]::text[]`; }
  const { rows } = await query(
    `SELECT m.*, mb.name AS mb_name, mb.token
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.account_id = $1 AND m.needs_review ${clause}
      ORDER BY m.received_at DESC LIMIT 50`,
    params,
  );
  // What is going wrong, in order of how often. This is the number that tells
  // someone whether to fix one sender or fix their schema.
  const { rows: byFlag } = await query(
    `SELECT f AS flag, count(*)::int AS n FROM messages m, unnest(m.flags) AS f
      WHERE m.account_id = $1 AND m.needs_review GROUP BY f ORDER BY n DESC LIMIT 12`,
    [account.id],
  );

  res.type('html').send(shell('Review queue — MailMint', `${topbar(rows.length)}
<main>
  ${req.query.saved ? '<div class="notice ok">Re-parsed.</div>' : ''}
  ${req.query.err ? `<div class="error">${escapeHtml(String(req.query.err))}</div>` : ''}
  <p class="small"><a href="/dashboard">&larr; Dashboard</a></p>
  <h1>Review queue</h1>
  <p class="muted">Messages where something is worth a human look: a required field came back
    empty, the rule layer and the model disagreed, the numbers did not add up, or the evidence
    for a value could not be found in the message.</p>

  ${byFlag.length ? `<section class="card"><h2>What is going wrong</h2>
    <p>${byFlag.map((f) => `<a class="flag${needsReview([f.flag]) ? ' review' : ''}" href="/dashboard/review?flag=${encodeURIComponent(f.flag)}">${escapeHtml(f.flag)} · ${f.n}</a>`).join(' ')}</p>
    ${flag ? `<p class="small"><a href="/dashboard/review">Clear filter (${escapeHtml(flag)})</a></p>` : ''}
  </section>` : ''}

  ${rows.length ? rows.map((m) => reviewCard(m)).join('') : `<section class="card">
    <p class="muted">Nothing needs review${flag ? ` with the flag ${escapeHtml(flag)}` : ''}. That is the good outcome.</p></section>`}
</main>`));
}));

function reviewCard(m) {
  const fields = (m.result && m.result.fields) || {};
  const issues = (m.flags || []).filter((f) => needsReview([f]));
  return `<section class="card" id="${escapeHtml(m.id)}">
    <div class="mbhead">
      <div><strong>${escapeHtml(m.subject || '(no subject)')}</strong>
        <span class="muted small">${escapeHtml(m.mb_name)} · from ${escapeHtml(m.from_email || 'unknown')} · ${timeAgo(m.received_at)}</span></div>
      <div>${issues.map((f) => `<span class="flag review">${escapeHtml(f)}</span>`).join('')}</div>
    </div>
    <table class="rows">
      <tr><th>Problem</th><th>Field</th><th>Value</th><th>Confidence</th><th>Evidence in the message</th></tr>
      ${issues.map((f) => {
    const name = flagField(f);
    const v = name ? (fields[name] || {}) : {};
    return `<tr>
        <td><code>${escapeHtml(String(f).split(':')[0])}</code></td>
        <td>${name ? `<code>${escapeHtml(name)}</code>` : '<span class="muted">whole message</span>'}</td>
        <td>${v.value === null || v.value === undefined ? '<span class="muted">null</span>' : escapeHtml(typeof v.value === 'object' ? JSON.stringify(v.value) : v.value)}</td>
        <td>${typeof v.confidence === 'number' ? v.confidence.toFixed(2) : '—'}</td>
        <td class="muted small">${v.evidence ? escapeHtml(String(v.evidence).slice(0, 120)) : '<em>none — the value was not traced to any text in the message</em>'}</td>
      </tr>`;
  }).join('')}
    </table>
    <details><summary>Full JSON</summary><pre><code>${json(m.result || {})}</code></pre></details>
    <form method="post" action="/dashboard/messages/${encodeURIComponent(m.id)}/reparse" class="inline">
      <input type="hidden" name="back" value="/dashboard/review">
      <button class="secondary">Re-parse with the current schema</button>
    </form>
  </section>`;
}

/* --------------------------------------------------------- mailbox page */

const TYPE_OPTIONS = [...TYPES];

function fieldEditor(schema) {
  const rows = (schema || []).map((f, i) => fieldRow(f, i)).join('');
  return `<div id="fields">${rows}</div>
  <button type="button" class="secondary" id="addfield">Add field</button>
  <template id="fieldtpl">${fieldRow({ name: '', type: 'string', description: '', required: false }, '__i__')}</template>
  <script>
  (function(){
    var box=document.getElementById('fields'), tpl=document.getElementById('fieldtpl');
    var n=box.querySelectorAll('.fieldrow').length;
    document.getElementById('addfield').addEventListener('click',function(){
      var html=tpl.innerHTML.split('__i__').join(String(n++));
      var d=document.createElement('div'); d.innerHTML=html; box.appendChild(d.firstElementChild);
    });
    box.addEventListener('click',function(e){
      var b=e.target.closest('.rmfield'); if(!b) return;
      b.closest('.fieldrow').remove();
    });
  })();
  </script>`;
}

const fieldRow = (f, i) => `<div class="fieldrow">
  <input type="text" name="f_${i}_name" value="${escapeHtml(f.name)}" placeholder="invoice_number" pattern="[A-Za-z_][A-Za-z0-9_]*">
  <select name="f_${i}_type">${TYPE_OPTIONS.map((t) => `<option value="${t}"${t === (f.type || 'string') ? ' selected' : ''}>${t}</option>`).join('')}</select>
  <input type="text" name="f_${i}_description" value="${escapeHtml(f.description || '')}" placeholder="what this field is, in one line">
  <label class="chk"><input type="checkbox" name="f_${i}_required" value="1"${f.required ? ' checked' : ''}> required</label>
  <button type="button" class="link danger rmfield">remove</button>
</div>`;

/** Rebuilds the schema array from the flat form fields the editor posts. */
function schemaFromForm(body) {
  const byIndex = new Map();
  for (const [k, v] of Object.entries(body || {})) {
    const m = /^f_(\w+)_(name|type|description|required|options)$/.exec(k);
    if (!m) continue;
    const entry = byIndex.get(m[1]) || {};
    entry[m[2]] = m[2] === 'required' ? Boolean(v) : String(v);
    byIndex.set(m[1], entry);
  }
  const list = [...byIndex.values()]
    .filter((f) => f.name && f.name.trim())
    .map((f) => ({
      name: f.name.trim(),
      type: f.type || 'string',
      description: f.description || '',
      required: Boolean(f.required),
      ...(f.type === 'enum' && f.options ? { options: String(f.options).split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    }));
  return validateSchema(list);
}

router.get('/dashboard/mailboxes/:id', requireAccount, asyncRoute(async (req, res) => {
  const account = req.account;
  const mb = await mailboxes.get(account.id, String(req.params.id));
  const { rows: msgs } = await query(
    `SELECT * FROM messages WHERE mailbox_id = $1 ORDER BY received_at DESC LIMIT 10`, [mb.id],
  );
  const versions = await mailboxes.versions(mb.id);
  const jobs = await reparse.list(account.id, mb.id);
  const { rows: confirmations } = await query(
    `SELECT * FROM forwarding_confirmations WHERE mailbox_id = $1 AND dismissed_at IS NULL
      ORDER BY created_at DESC LIMIT 3`, [mb.id],
  );
  const { rows: deliveries } = await query(
    `SELECT d.id, d.url, d.attempt, d.status_code, d.error, d.delivered_at, d.failed_at, d.next_attempt_at, d.created_at
       FROM webhook_deliveries d WHERE d.account_id = $1 AND d.message_id IN (SELECT id FROM messages WHERE mailbox_id = $2)
      ORDER BY d.created_at DESC LIMIT 8`, [account.id, mb.id],
  );
  const address = `${mb.token}@${config.inboundDomain}`;

  res.type('html').send(shell(`${mb.name} — MailMint`, `${topbar()}
<main>
  ${req.query.saved ? '<div class="notice ok">Saved.</div>' : ''}
  ${req.query.tested ? `<div class="notice ok"><strong>Test message parsed.</strong> It is the top message below.</div>` : ''}
  ${req.query.err ? `<div class="error">${escapeHtml(String(req.query.err))}</div>` : ''}
  <p class="small"><a href="/dashboard">&larr; Dashboard</a></p>
  <h1>${escapeHtml(mb.name)}</h1>

  <section class="card">
    <h2>Address</h2>
    <p class="keybox"><code id="addr" class="addr">${escapeHtml(address)}</code><button class="copy" data-target="addr">Copy</button></p>
    ${mb.slug ? `<p class="muted small">Also reachable as <code>${escapeHtml(mb.slug)}.${escapeHtml(address)}</code>, and as <code>${escapeHtml(mb.token)}+anything@${escapeHtml(config.inboundDomain)}</code>.</p>`
    : `<p class="muted small">Also reachable as <code>${escapeHtml(mb.token)}+anything@${escapeHtml(config.inboundDomain)}</code> — the tag comes back on the envelope.</p>`}
  </section>

  ${confirmations.map((c) => forwardingCard(mb, c)).join('')}

  <section class="card">
    <h2>Fields to extract <span class="muted small">(schema v${mb.schema_version})</span></h2>
    <p class="muted small">Name, type, and one line saying what it is. The description is what the model reads, so
      "grand total including tax" beats "total".</p>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/schema">
      ${fieldEditor(mb.schema)}
      <p><button>Save schema</button></p>
    </form>
    ${versions.length > 1 ? `<details><summary>${versions.length} versions — roll back</summary>
      <table class="rows"><tr><th>Version</th><th>When</th><th>Fields</th><th></th></tr>
      ${versions.map((v) => `<tr><td>v${v.version}</td><td>${timeAgo(v.created_at)}</td>
        <td>${(v.schema || []).map((f) => escapeHtml(f.name)).join(', ') || '<span class="muted">none</span>'}</td>
        <td>${v.version === mb.schema_version ? '<span class="tag">live</span>'
    : `<form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/rollback" class="inline" style="margin:0">
             <input type="hidden" name="version" value="${v.version}"><button class="link">Restore</button></form>`}</td></tr>`).join('')}
      </table></details>` : ''}
  </section>

  <section class="card">
    <h2>Webhooks</h2>
    <p class="muted small">Every parsed message is POSTed to each active endpoint below with
      <code>x-mailmint-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> — the HMAC-SHA256 of
      <code>"&lt;t&gt;." + rawBody</code> under that endpoint's own secret. Retries at 0s, 30s, 2m,
      10m, 1h, 6h. Each endpoint is independent: adding, rotating or deleting one never touches
      another, so two workflows can safely watch the same mailbox.</p>
    ${mb.endpoints.length ? `<table class="rows">
      <tr><th>URL</th><th>What for</th><th>Last</th><th>Secret</th><th></th></tr>
      ${mb.endpoints.map((e) => `<tr>
        <td style="word-break:break-all">${escapeHtml(e.url)}
          ${e.disabled_at ? `<br><span class="flag review">switched off</span> <span class="muted small">${escapeHtml(e.disabled_reason || '')}</span>` : ''}
          ${!e.active && !e.disabled_at ? '<br><span class="flag">paused</span>' : ''}</td>
        <td>${escapeHtml(e.description || '—')}</td>
        <td>${e.last_delivered_at ? `<span class="ok">${e.last_status}</span> ${timeAgo(e.last_delivered_at)}`
    : e.last_status ? `<span class="bad">${e.last_status}</span>` : '<span class="muted">never</span>'}
          ${e.consecutive_failures ? `<br><span class="muted small">${e.consecutive_failures} failed in a row</span>` : ''}</td>
        <td><code id="sec_${escapeHtml(e.id)}">${escapeHtml(e.secret)}</code>
          <button class="copy" data-target="sec_${escapeHtml(e.id)}">Copy</button></td>
        <td>
          <form method="post" action="/dashboard/webhooks/${encodeURIComponent(e.id)}/toggle" class="inline" style="margin:0">
            <button class="link">${e.active ? 'Pause' : 'Enable'}</button></form>
          <form method="post" action="/dashboard/webhooks/${encodeURIComponent(e.id)}/rotate" class="inline" style="margin:0"
            onsubmit="return confirm('Rotate this endpoint\'s secret? Anything verifying with the old one starts failing immediately.')">
            <button class="link">Rotate</button></form>
          <form method="post" action="/dashboard/webhooks/${encodeURIComponent(e.id)}/delete" class="inline" style="margin:0"
            onsubmit="return confirm('Delete this endpoint? Only this one stops receiving; the others are untouched.')">
            <button class="link danger">Delete</button></form>
        </td></tr>`).join('')}
    </table>` : '<p class="muted">No endpoints yet. Mail is still received and stored — you can poll for it, or add one here.</p>'}
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/webhooks" class="inline">
      <label style="flex:1 1 300px">URL<input type="url" name="url" style="width:100%" required
        placeholder="https://example.com/hooks/mailmint"></label>
      <label>What for<input type="text" name="description" placeholder="n8n invoice workflow" maxlength="200"></label>
      <button>Add endpoint</button>
    </form>
    <p class="muted small">An endpoint that fails ${endpoints.MAX_CONSECUTIVE_FAILURES} deliveries in a row
      — each already six attempts over six hours — is switched off rather than retried into a black hole.
      Enable it again once the receiver is back.</p>
    ${deliveries.length ? `<details><summary>Recent deliveries</summary><table class="rows">
      <tr><th>When</th><th>Attempt</th><th>Status</th><th>Result</th></tr>
      ${deliveries.map((d) => `<tr><td>${timeAgo(d.created_at)}</td><td>${d.attempt}</td><td>${d.status_code || '—'}</td>
        <td>${d.delivered_at ? '<span class="ok">delivered</span>'
    : d.failed_at ? `<span class="bad">gave up</span> <span class="muted small">${escapeHtml(d.error || '')}</span>`
      : '<span class="muted">retrying</span>'}</td></tr>`).join('')}
    </table></details>` : ''}
  </section>

  <section class="card">
    <h2>Re-parse the history</h2>
    <p class="muted small">Runs the parser again over mail already stored here, from the original
      bytes. Use it when a sender changes their layout: adjust the fields above, dry-run it to see
      exactly what would change, then run it for real.
      <strong>Re-delivery is separate</strong> — a re-parse does not fire your webhook unless you tick the box.</p>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/reparse" class="inline">
      <label>From<input type="date" name="since"></label>
      <label>To<input type="date" name="until"></label>
      <label>Limit<input type="number" name="limit" value="200" min="1" max="${reparse.MAX_LIMIT}"></label>
      <label class="chk" style="flex-direction:row"><input type="checkbox" name="needs_review" value="1"> only ones needing review</label>
      <button name="dry_run" value="1">Dry run</button>
      <button class="secondary" name="dry_run" value="" onclick="return confirm('Re-parse for real? Stored results will be overwritten.')">Run for real</button>
    </form>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/reparse" class="inline" style="margin-top:.2rem">
      <input type="hidden" name="redeliver" value="1"><input type="hidden" name="limit" value="200">
      <label class="chk" style="flex-direction:row"><input type="checkbox" name="confirm" value="1" required> yes, also re-send every one to my webhook</label>
      <button class="link danger">Re-parse and re-deliver</button>
    </form>
    ${jobs.length ? `<table class="rows"><tr><th>When</th><th>Kind</th><th>Status</th><th>Done</th><th>Changed</th><th></th></tr>
      ${jobs.map((j) => `<tr><td>${timeAgo(j.created_at)}</td>
        <td>${j.dry_run ? 'dry run' : (j.redeliver ? 'run + re-deliver' : 'run')}</td>
        <td>${j.status === 'succeeded' ? '<span class="ok">done</span>' : j.status === 'failed' ? `<span class="bad">failed</span>` : escapeHtml(j.status)}</td>
        <td>${j.done}/${j.total}</td><td>${j.changed}</td>
        <td><a href="/dashboard/reparse/${encodeURIComponent(j.id)}">Diff</a></td></tr>`).join('')}
    </table>` : ''}
  </section>

  <section class="card">
    <h2>Send a test email</h2>
    <p class="muted small">Injects a message exactly as the mail server would, and parses it now.
      Nothing leaves this machine — no mail is actually sent.</p>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/test">
      <div class="fieldrow" style="grid-template-columns:1fr 2fr">
        <input type="text" name="from" value="billing@acme-example.com" placeholder="from">
        <input type="text" name="subject" value="Invoice INV-2291 from Acme Ltd" placeholder="subject">
      </div>
      <textarea name="text" rows="6" style="width:100%;font-family:var(--mono);font-size:.82rem;padding:.6rem;border:1px solid var(--rule);border-radius:8px;background:var(--bg);color:var(--ink)">Hello,

Invoice INV-2291 is due.

Total: $31.50
Due: Sep 8, 2026

Thanks,
Acme Billing</textarea>
      <p><button>Send test email</button></p>
    </form>
  </section>

  <section class="card">
    <h2>Last messages</h2>
    ${msgs.length ? msgs.map((m) => renderMessageBlock(m)).join('') : `<p class="muted">Nothing yet. Send mail to
      <code>${escapeHtml(address)}</code>, or use the test panel above.</p>`}
  </section>

  <section class="card">
    <h2>Danger zone</h2>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/pause" class="inline">
      <button class="secondary">${mb.paused ? 'Resume' : 'Pause'} this mailbox</button>
    </form>
    <p class="muted small">${mb.paused ? 'Paused: mail is still accepted and stored, but no webhook is sent.' : 'Pausing stops webhooks. Mail keeps arriving and is still stored.'}</p>
    <form method="post" action="/dashboard/mailboxes/${encodeURIComponent(mb.id)}/delete" class="inline"
      onsubmit="return confirm('Delete this mailbox? The address stops working immediately.')">
      <button class="link danger">Delete mailbox</button></form>
  </section>
</main>`));
}));

/**
 * Shows the confirmation code a provider just emailed, so the user does not have
 * to go back to the mailbox they are in the middle of forwarding away.
 *
 * The link is the dangerous part. Anyone who learns a mailbox address can email
 * it a convincing fake "confirm your forwarding" message with a link to
 * anywhere, and this page is shown to a signed-in account holder. So an
 * untrusted link is printed as inert text inside a <code> element — never an
 * anchor, never auto-followed, and with the reason stated in plain language
 * rather than a badge the reader has to interpret.
 */
function forwardingCard(mb, c) {
  return `<section class="card">
    <h2>${escapeHtml(c.provider ? `${c.provider} sent a forwarding confirmation` : 'A forwarding confirmation arrived')}</h2>
    <p class="muted small">Received ${timeAgo(c.created_at)}${c.from_email ? ` from ${escapeHtml(c.from_email)}` : ''}.
      Paste the code back into the provider's forwarding settings to finish setting up
      <code>${escapeHtml(mb.token)}@${escapeHtml(config.inboundDomain)}</code>.</p>
    ${c.code ? `<p class="keybox"><code id="fwc_${escapeHtml(c.id)}">${escapeHtml(c.code)}</code>
      <button class="copy" data-target="fwc_${escapeHtml(c.id)}">Copy code</button></p>` : ''}
    ${c.link ? (c.link_trusted
    ? `<p class="small"><a href="${escapeHtml(c.link)}" rel="noopener noreferrer nofollow" target="_blank">Open the confirmation link</a></p>`
    : `<div class="warnbox"><strong>This link is not shown as clickable on purpose.</strong>
         It does not point at ${escapeHtml(c.provider || 'the provider')}'s own domain, and anyone who knows
         your address can email a fake confirmation. Read it, and only open it if you recognise it:
         <br><code>${escapeHtml(c.link)}</code></div>`) : ''}
    <form method="post" action="/dashboard/forwarding/${encodeURIComponent(c.id)}/dismiss" class="inline">
      <button class="secondary">Done with this</button></form>
  </section>`;
}

/**
 * Sender authentication, in words rather than in jargon.
 *
 * Two verdicts are stated carefully on purpose:
 *
 *  - **DKIM `body_altered`** is not a failure. The signature and the key are
 *    genuine; the body changed after signing, which is what forwarding, mailing
 *    lists and corporate gateways do as a matter of course. Since forwarding
 *    mail to us from Gmail is one of the two main ways this product is used,
 *    calling our own happy path "failed" would be both wrong and alarming.
 *  - **SPF `none`** means it could not be checked — on the Cloudflare Email
 *    Routing path the worker never sees a client IP — NOT that the check ran and
 *    found nothing. Those are different facts and the page says which one it is.
 */
const AUTH_WORDS = {
  pass: { text: 'passed', cls: 'ok' },
  fail: { text: 'failed', cls: 'bad' },
  softfail: { text: 'soft-failed', cls: 'bad' },
  body_altered: { text: 'signed, but the message was changed after signing (normal for forwarded mail)', cls: '' },
  none: { text: 'not checked — no result was available', cls: 'muted' },
  neutral: { text: 'neutral', cls: 'muted' },
  temperror: { text: 'could not be checked (temporary error)', cls: 'muted' },
  permerror: { text: 'could not be checked (the sender\'s record is broken)', cls: 'muted' },
};

function authLine(m) {
  // Merged, not "first one wins": the stored result already carries the edge's
  // verdict, but a message parsed before that merge existed only has it on the
  // envelope, and a row with `auth: {spf: null, ...}` would otherwise shadow it.
  const auth = { ...((m.envelope && m.envelope.auth) || {}), ...((m.result && m.result.auth) || {}) };
  for (const k of Object.keys(auth)) if (auth[k] === null || auth[k] === undefined) delete auth[k];
  if (!Object.keys(auth).length) return '';
  const parts = ['spf', 'dkim', 'dmarc']
    .filter((k) => auth[k] !== undefined && auth[k] !== null)
    .map((k) => {
      const w = AUTH_WORDS[auth[k]] || { text: String(auth[k]), cls: 'muted' };
      return `<span class="${w.cls}">${k.toUpperCase()} ${escapeHtml(w.text)}</span>`;
    });
  if (auth.spam_score !== undefined && auth.spam_score !== null) {
    parts.push(`<span class="muted">spam score ${Number(auth.spam_score).toFixed(1)}</span>`);
  }
  return parts.length ? `<p class="small muted">Sender authentication: ${parts.join(' · ')}</p>` : '';
}

function renderMessageBlock(m) {
  const result = m.result || {};
  const fields = result.fields || {};
  const names = Object.keys(fields);
  return `<div id="${escapeHtml(m.id)}" style="border-top:1px solid var(--rule);padding-top:.8rem;margin-top:.8rem">
    <div class="mbhead">
      <div><strong>${escapeHtml(m.subject || '(no subject)')}</strong>
        <span class="muted small">from ${escapeHtml(m.from_email || 'unknown')} · ${timeAgo(m.received_at)} · ${m.size} bytes</span></div>
      <div>${m.status === 'parsed' ? (m.needs_review ? '<span class="flag review">needs review</span>' : '<span class="ok">parsed</span>')
    : `<span class="bad">${escapeHtml(m.status)}</span>`}</div>
    </div>
    ${(m.flags || []).length ? `<p>${(m.flags || []).map((f) => `<span class="flag${needsReview([f]) ? ' review' : ''}">${escapeHtml(f)}</span>`).join('')}</p>` : ''}
    ${authLine(m)}
    ${names.length ? `<table class="rows"><tr><th>Field</th><th>Value</th><th>Confidence</th><th>Source</th><th>Evidence</th></tr>
      ${names.map((n) => {
    const f = fields[n] || {};
    return `<tr><td><code>${escapeHtml(n)}</code></td>
        <td>${f.value === null || f.value === undefined ? '<span class="muted">null</span>' : escapeHtml(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value)}</td>
        <td>${typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '—'}</td>
        <td class="muted">${escapeHtml(f.source || 'none')}</td>
        <td class="muted small">${escapeHtml(String(f.evidence || '').slice(0, 90))}</td></tr>`;
  }).join('')}</table>` : '<p class="muted small">No schema was set when this arrived, so no fields were extracted.</p>'}
    <details><summary>Full JSON</summary><pre><code>${json(result)}</code></pre></details>
    <form method="post" action="/dashboard/messages/${encodeURIComponent(m.id)}/reparse" class="inline" style="margin-top:.4rem">
      <button class="link">Re-parse with the current schema</button></form>
  </div>`;
}

/* -------------------------------------------------------- dashboard POSTs */

const back = (res, url, params = {}) => {
  const q = new URLSearchParams(params).toString();
  res.redirect(q ? `${url}?${q}` : url);
};

router.post('/dashboard/mailboxes', requireAccount, asyncRoute(async (req, res) => {
  const mb = await mailboxes.create(req.account.id, { name: req.body?.name });
  back(res, `/dashboard/mailboxes/${mb.id}`, { saved: 1 });
}));

router.post('/dashboard/mailboxes/:id/schema', requireAccount, asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  try {
    await mailboxes.update(req.account.id, id, { schema: schemaFromForm(req.body) });
    back(res, `/dashboard/mailboxes/${id}`, { saved: 1 });
  } catch (e) {
    back(res, `/dashboard/mailboxes/${id}`, { err: e.message });
  }
}));

router.post('/dashboard/mailboxes/:id/webhook', requireAccount, asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  try {
    await mailboxes.update(req.account.id, id, { webhook_url: req.body?.webhook_url || null });
    back(res, `/dashboard/mailboxes/${id}`, { saved: 1 });
  } catch (e) {
    back(res, `/dashboard/mailboxes/${id}`, { err: e.message });
  }
}));

router.post('/dashboard/mailboxes/:id/webhooks', requireAccount, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  try {
    await endpoints.create(mb, { url: req.body?.url, description: req.body?.description });
    back(res, `/dashboard/mailboxes/${mb.id}`, { saved: 1 });
  } catch (e) {
    back(res, `/dashboard/mailboxes/${mb.id}`, { err: e.message });
  }
}));

router.post('/dashboard/webhooks/:id/toggle', requireAccount, asyncRoute(async (req, res) => {
  const e = await endpoints.get(req.account.id, String(req.params.id));
  await endpoints.update(req.account.id, e.id, { active: !e.active });
  back(res, `/dashboard/mailboxes/${e.mailbox_id}`, { saved: 1 });
}));

router.post('/dashboard/webhooks/:id/rotate', requireAccount, asyncRoute(async (req, res) => {
  const e = await endpoints.get(req.account.id, String(req.params.id));
  await endpoints.update(req.account.id, e.id, { secret: '' });
  back(res, `/dashboard/mailboxes/${e.mailbox_id}`, { saved: 1 });
}));

router.post('/dashboard/webhooks/:id/delete', requireAccount, asyncRoute(async (req, res) => {
  const e = await endpoints.get(req.account.id, String(req.params.id));
  await endpoints.remove(req.account.id, e.id);
  back(res, `/dashboard/mailboxes/${e.mailbox_id}`, { saved: 1 });
}));

// Rotates the FIRST endpoint's secret — the mailbox-level alias. Kept so an old
// bookmark still does something sensible; the per-endpoint control is above.
router.post('/dashboard/mailboxes/:id/rotate', requireAccount, asyncRoute(async (req, res) => {
  await mailboxes.update(req.account.id, String(req.params.id), { webhook_secret: '' });
  back(res, `/dashboard/mailboxes/${req.params.id}`, { saved: 1 });
}));

router.post('/dashboard/mailboxes/:id/rollback', requireAccount, asyncRoute(async (req, res) => {
  await mailboxes.rollback(req.account.id, String(req.params.id), Number(req.body?.version));
  back(res, `/dashboard/mailboxes/${req.params.id}`, { saved: 1 });
}));

router.post('/dashboard/mailboxes/:id/pause', requireAccount, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  await mailboxes.update(req.account.id, mb.id, { paused: !mb.paused });
  back(res, `/dashboard/mailboxes/${mb.id}`, { saved: 1 });
}));

router.post('/dashboard/mailboxes/:id/delete', requireAccount, asyncRoute(async (req, res) => {
  await mailboxes.remove(req.account.id, String(req.params.id));
  back(res, '/dashboard');
}));

router.post('/dashboard/mailboxes/:id/test', requireAccount, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  const b = req.body || {};
  const raw = Buffer.from([
    `From: ${String(b.from || 'test@example.com').slice(0, 200)}`,
    `To: ${mb.token}@${config.inboundDomain}`,
    `Subject: ${String(b.subject || '(no subject)').slice(0, 300)}`,
    `Message-Id: <${Date.now()}.${Math.random().toString(36).slice(2)}@dashboard.mailmint>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '', String(b.text || ''),
  ].join('\r\n'), 'utf8');

  const message = await messages.ingest({
    mailbox: mb,
    envelope: { from: String(b.from || 'test@example.com'), to: [`${mb.token}@${config.inboundDomain}`], helo: 'dashboard', remote_ip: req.ip, tls: true, injected: true },
    raw,
  });
  if (message.duplicate) return back(res, `/dashboard/mailboxes/${mb.id}`, { tested: message.id });
  const out = await pipeline.processMessage(message, { requestId: req.id });
  return back(res, `/dashboard/mailboxes/${mb.id}`, out.error ? { err: `Stored, but parsing failed: ${out.error.message}` } : { tested: message.id });
}));

router.post('/dashboard/mailboxes/:id/reparse', requireAccount, asyncRoute(async (req, res) => {
  const mb = await mailboxes.get(req.account.id, String(req.params.id));
  const b = req.body || {};
  try {
    const job = await reparse.create(req.account, mb, {
      since: b.since || null,
      until: b.until ? `${b.until}T23:59:59Z` : null,
      limit: Number(b.limit) || 200,
      needs_review: b.needs_review === '1',
      dry_run: b.dry_run === '1',
      redeliver: b.redeliver === '1' && b.confirm === '1',
    });
    return back(res, `/dashboard/reparse/${job.job_id}`);
  } catch (e) {
    return back(res, `/dashboard/mailboxes/${mb.id}`, { err: e.message });
  }
}));

/**
 * The diff a dry run produced. This is the page that makes tuning a schema
 * against real historical mail safe rather than a leap of faith.
 */
router.get('/dashboard/reparse/:job_id', requireAccount, asyncRoute(async (req, res) => {
  const job = await reparse.get(req.account.id, String(req.params.job_id));
  const pending = job.status === 'queued' || job.status === 'running';
  res.type('html').send(shell('Re-parse — MailMint', `${topbar()}
<main>
  <p class="small"><a href="/dashboard/mailboxes/${encodeURIComponent(job.mailbox_id)}">&larr; Mailbox</a></p>
  <h1>${job.dry_run ? 'Dry run' : 'Re-parse'}</h1>
  ${pending ? '<meta http-equiv="refresh" content="2"><div class="notice">Running…  this page refreshes itself.</div>' : ''}
  <section class="card">
    <p class="big">${job.done} <span class="muted">of ${job.total} messages · ${job.changed} changed · ${job.failed} failed</span></p>
    <div class="meter"><i style="width:${job.total ? Math.round((job.done / job.total) * 100) : 0}%"></i></div>
    <p class="muted small">${job.dry_run
    ? 'Nothing was written. This is what would change if you ran it for real.'
    : `Stored results were updated.${job.redeliver ? ' Every changed message was re-sent to the webhook.' : ' Your webhook was NOT called.'}`}</p>
    ${job.error ? `<div class="error">${escapeHtml(job.error)}</div>` : ''}
  </section>
  ${job.diffs.length ? job.diffs.map((d) => `<section class="card">
    <strong>${escapeHtml(d.subject || '(no subject)')}</strong>
    <span class="muted small">${escapeHtml(d.message_id)}</span>
    ${d.fields.length ? `<table class="rows"><tr><th>Field</th><th>Before</th><th>After</th></tr>
      ${d.fields.map((f) => `<tr><td><code>${escapeHtml(f.field)}</code></td>
        <td>${fmtCell(f.before)}</td><td>${fmtCell(f.after)}</td></tr>`).join('')}
    </table>` : ''}
    ${d.flags_added.length ? `<p class="small">added ${d.flags_added.map((f) => `<span class="flag review">${escapeHtml(f)}</span>`).join('')}</p>` : ''}
    ${d.flags_removed.length ? `<p class="small">cleared ${d.flags_removed.map((f) => `<span class="flag">${escapeHtml(f)}</span>`).join('')}</p>` : ''}
  </section>`).join('') : (pending ? '' : '<section class="card"><p class="muted">Nothing changed.</p></section>')}
  ${job.diffs_truncated ? `<p class="muted small">Only the first ${reparse.MAX_DIFFS} changed messages are shown.</p>` : ''}
</main>`));
}));

const fmtCell = (side) => `${side.value === null || side.value === undefined ? '<span class="muted">null</span>'
  : escapeHtml(typeof side.value === 'object' ? JSON.stringify(side.value) : side.value)}
  <span class="muted small">${side.confidence === null ? '' : side.confidence.toFixed(2)} ${escapeHtml(side.source || '')}</span>`;

router.post('/dashboard/messages/:id/reparse', requireAccount, asyncRoute(async (req, res) => {
  const message = await pipeline.loadMessage(String(req.params.id), req.account.id);
  if (!message) return back(res, '/dashboard', { err: 'That message no longer exists.' });
  // Re-parsing is not re-delivering: someone fixing a schema on the review queue
  // must not fire a webhook at their own production endpoint by accident.
  const out = await pipeline.processMessage(message, { requestId: req.id, eventType: 'message.reparsed', deliver: false, bill: false });
  const to = String(req.body?.back || '').startsWith('/dashboard')
    ? String(req.body.back) : `/dashboard/mailboxes/${message.mailbox_id}`;
  return back(res, to, out.error ? { err: out.error.message } : { saved: 1 });
}));

router.post('/dashboard/forwarding/:id/dismiss', requireAccount, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `UPDATE forwarding_confirmations SET dismissed_at = now()
      WHERE id = $1 AND account_id = $2 RETURNING mailbox_id`,
    [String(req.params.id), req.account.id],
  );
  back(res, rows.length ? `/dashboard/mailboxes/${rows[0].mailbox_id}` : '/dashboard');
}));

router.post('/dashboard/keys', requireAccount, asyncRoute(async (req, res) => {
  const mode = req.body?.mode === 'test' ? 'test' : 'live';
  const key = await issueApiKey(req.account.id, String(req.body?.name || 'default').slice(0, 40), mode);
  stashKeyForSession(sessionIdFrom(req), key);
  back(res, '/dashboard');
}));

router.post('/dashboard/keys/revoke', requireAccount, asyncRoute(async (req, res) => {
  try {
    await revokeApiKey(req.account.id, String(req.body?.prefix || ''));
    back(res, '/dashboard');
  } catch (e) {
    back(res, '/dashboard', { err: e.message });
  }
}));

router.post('/dashboard/password', requireAccount, asyncRoute(async (req, res) => {
  const { current, next } = req.body || {};
  const ok = await bcrypt.compare(String(current || ''), req.account.password_hash);
  if (!ok) return back(res, '/dashboard', { pw: 'wrong' });
  if (!next || String(next).length < 8) return back(res, '/dashboard', { pw: 'short' });
  await query(`UPDATE accounts SET password_hash = $2 WHERE id = $1`, [req.account.id, await bcrypt.hash(String(next), 10)]);
  return back(res, '/dashboard', { pw: 'ok' });
}));

router.post('/dashboard/checkout', requireAccount, asyncRoute(async (req, res) => {
  const session = await billing.createCheckoutSession(req.account, String(req.body?.plan || ''));
  res.redirect(303, session.url);
}));

router.post('/dashboard/portal', requireAccount, asyncRoute(async (req, res) => {
  const session = await billing.createPortalSession(req.account);
  res.redirect(303, session.url);
}));

/* ------------------------------------------------------------------ docs */

/**
 * The generated API reference.
 *
 * The hand-written documentation site (`src/site.js`, `public/docs.html`) owns
 * `/docs`. This page is different in kind and worth keeping alongside it: every
 * number on it — the free allowance, the retention window per plan, the rate
 * limit, the failure tolerance before an endpoint is switched off — is
 * interpolated from the same constants the code enforces, so it is the one page
 * that CANNOT drift into telling a customer something untrue. The tests assert
 * that; they cannot assert it about prose.
 */
router.get('/docs/reference', asyncRoute(async (req, res) => {
  const example = webhooks.sign('your_webhook_secret', '{"id":"msg_…"}');
  res.type('html').send(shell('MailMint docs', `${topbar()}
<main>
  <h1>API reference</h1>
  <p class="muted">Every number on this page is read from the running configuration, so it says what
    this deployment actually enforces. The written guides are at <a href="/docs">/docs</a>.</p>
  <p class="muted">Base URL <code>${escapeHtml(config.publicUrl || `${req.protocol}://${req.get('host')}`)}</code>.
    Every call carries <code>Authorization: Bearer mm_live_…</code>.</p>

  <h2 id="authentication">Authentication</h2>
  <p>Keys are shown once, at creation. A key beginning <code>mm_test_</code> behaves identically
    but is never counted against your quota — use it in CI.</p>

  <h2 id="mailboxes">Mailboxes</h2>
  <pre><code>POST   /v1/mailboxes      {name, schema?, webhook_url?}
GET    /v1/mailboxes
GET    /v1/mailboxes/:id
PATCH  /v1/mailboxes/:id  {name?, schema?, webhook_url?, webhook_secret?}
DELETE /v1/mailboxes/:id</code></pre>
  <p>Each mailbox has an address <code>&lt;token&gt;@${escapeHtml(config.inboundDomain)}</code>.
    <code>slug.token@</code> and <code>token+tag@</code> reach the same mailbox.</p>

  <h2 id="schema">Schema</h2>
  <pre><code>{ "name": "total", "type": "number", "description": "grand total incl. tax",
  "required": true, "hint": "labelled Total or Amount Due" }</code></pre>
  <p>Types: <code>${TYPE_OPTIONS.join('</code>, <code>')}</code>.
    <code>enum</code> needs <code>options</code>; <code>array</code> needs <code>items</code>;
    <code>object</code> needs <code>fields</code>.</p>

  <h2 id="messages">Messages</h2>
  <pre><code>GET  /v1/messages?mailbox_id=&amp;since=&amp;cursor=&amp;limit=&amp;status=
                 &amp;needs_review=true&amp;flag=arithmetic_mismatch&amp;view=review
GET  /v1/messages/:id?include=attachments,extracted_text&amp;exclude=extracted
GET  /v1/messages/:id/raw
GET  /v1/attachments/:id
POST /v1/messages/:id/reparse  {schema?, schema_version?, deliver?}</code></pre>
  <p><code>needs_review=true</code> and <code>flag=</code> are indexed, so the review queue stays fast
    as a mailbox fills up. <code>view=review</code> adds, per message, which flag fired on which field
    and the evidence string the value came from.</p>
  <p><code>include=attachments</code> inlines the file bytes as base64.
    An attachment that was read by the extractor carries
    <code>extracted: {kind, text, pages, tables, meta}</code>; its <code>text</code> is truncated to
    ${config.extractedTextPreview} characters unless you ask for <code>include=extracted_text</code>,
    and <code>exclude=extracted</code> drops it entirely.</p>

  <h2 id="review">Finding what went wrong</h2>
  <p>Every field carries <code>confidence</code>, <code>source</code> and <code>evidence</code> — the
    verbatim substring of the message the value was taken from. A value whose evidence is not
    actually in the message is flagged <code>hallucinated_evidence</code> and its confidence is halved.
    A field where the rule layer and the model disagreed keeps the rule's answer and is flagged
    <code>rule_llm_disagreement</code>. Invoices whose line items do not add up to the total are
    flagged <code>arithmetic_mismatch</code>.</p>
  <p><code>needs_review</code> is true when any of those fired. The
    <a href="/dashboard/review">review queue</a> is the same query with a page around it.</p>

  <h2 id="reparse">Re-parsing old mail</h2>
  <pre><code>POST /v1/mailboxes/:id/reparse
  {since?, until?, limit?, status?, needs_review?, flag?,
   schema?, schema_version?, dry_run?, redeliver?}     -&gt; 202 {job_id, poll}
GET  /v1/reparse/:job_id   -&gt; {status, done, total, changed, diffs:[…]}</code></pre>
  <p>Runs the parser again over stored messages, from the ORIGINAL raw bytes. This is what a
    layout change from one of your senders is fixed with, weeks after it happened.</p>
  <ul>
    <li><strong><code>dry_run: true</code> writes nothing</strong> and returns a per-field diff of
      old and new value, confidence and source. Tune a schema against real historical mail without
      touching it.</li>
    <li><strong><code>redeliver</code> defaults to false.</strong> Re-parsing five thousand messages
      does not fire five thousand webhooks at your production endpoint. Fixing your data and
      re-notifying your downstream are separate decisions.</li>
    <li>It returns a job id immediately; poll it rather than holding the request open.</li>
  </ul>
  <p>How far back it reaches is how long the original bytes are kept — see retention below.</p>

  <h2 id="webhooks">Webhooks</h2>
  <pre><code>POST   /v1/mailboxes/:id/webhooks   {url, description?}  -&gt; {id, url, secret}
GET    /v1/mailboxes/:id/webhooks
GET    /v1/webhooks/:id
PATCH  /v1/webhooks/:id             {url?, description?, active?, secret?}
DELETE /v1/webhooks/:id</code></pre>
  <p>A mailbox has <strong>many</strong> endpoints, each with its own signing secret. Two workflows
    can watch one mailbox without touching each other: adding, pausing, rotating or deleting one
    endpoint never affects another. <code>mailbox.webhook_url</code> still works and is an alias for
    the first endpoint.</p>
  <p>Headers: <code>x-mailmint-event: message.parsed</code>, <code>x-mailmint-delivery: dlv_…</code>,
    <code>x-mailmint-endpoint: whe_…</code>,
    <code>x-mailmint-signature: ${escapeHtml(example.header.slice(0, 24))}…</code></p>
  <pre><code>const [t, v1] = header.split(',').map(p =&gt; p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(v1,'hex'))) reject();
if (Math.abs(Date.now()/1000 - Number(t)) &gt; 300) reject();   // replay window</code></pre>
  <p>Retries at 0s, 30s, 2m, 10m, 1h, 6h. 10s timeout. A 4xx other than 408 or 429 is not retried.
    An endpoint whose deliveries exhaust their retries ${endpoints.MAX_CONSECUTIVE_FAILURES} times in a
    row is switched off and flagged on the dashboard, rather than retried forever into a dead host.</p>

  <h2 id="auth">Sender authentication</h2>
  <p><code>auth</code> carries <code>spf</code>, <code>dkim</code>, <code>dmarc</code> and
    <code>spam_score</code>; <code>auth_details</code> carries the finer result when the receiving
    edge produced one. <code>dkim</code> is one of
    <code>pass</code>, <code>fail</code>, <code>body_altered</code>, <code>none</code>,
    <code>temperror</code>, <code>permerror</code>.</p>
  <p><strong><code>body_altered</code> is not a failure.</strong> The signature and key are genuine and
    the body changed after signing — which is what forwarding, mailing lists and corporate security
    gateways do routinely. It raises <code>dkim_body_altered</code>, never
    <code>auth_fail:dkim</code>, and never sets <code>needs_review</code>. Only a real
    <code>fail</code> does.</p>
  <p><strong><code>spf: "none"</code> means it could not be checked</strong>, not that it was checked
    and found nothing — mail arriving through Cloudflare Email Routing gives the receiving worker no
    client IP, so there is nothing to evaluate. It is not treated as a problem anywhere.</p>

  <h2 id="quota">Quota</h2>
  <p>The free plan is ${PLANS.free.quota} parsed emails a month, no card. Over the line, mail is
    still received, stored, listed and delivered — it is flagged <code>quota_exceeded</code>, and
    only the extraction pass is skipped. Your mail is never bounced, and nothing you have already
    received is taken away. Re-parsing something you have already paid for is free.</p>

  <h2 id="retention">Retention &amp; limits</h2>
  <table class="rows"><tr><th>Plan</th><th>Emails / month</th><th>Original bytes kept</th><th>Attachment bytes kept</th></tr>
    ${Object.values(PLANS).map((p) => `<tr><td>${escapeHtml(p.name)}${p.priceUsd ? ` — $${p.priceUsd}/mo` : ' — free'}</td>
      <td>${p.quota.toLocaleString('en-US')}</td><td>${p.rawDays} days</td><td>${p.blobDays} days</td></tr>`).join('')}
  </table>
  <p>The <strong>original bytes</strong> column is how far back <code>reparse</code> can reach, because
    a re-parse replays them. Attachment bytes expire sooner: they are the bulk of the storage and are
    not needed to re-parse a message body. Events are kept ${config.eventRetentionDays} days.</p>
  <p>Messages over ${(config.maxRawBytes / 1048576).toFixed(0)} MB are recorded but not stored raw;
    attachments over ${(config.maxAttachmentBytes / 1048576).toFixed(0)} MB are recorded but their
    bytes are not. Both cases are flagged, never silently dropped.</p>

  <h2 id="limits">Rate limits</h2>
  <p>${require('./ratelimit').REFILL_PER_MINUTE} API requests a minute per account, burst ${require('./ratelimit').CAPACITY}.
    Inbound mail is not rate limited.</p>
</main>`));
}));

module.exports = { router, shell, currentAccount, schemaFromForm };
