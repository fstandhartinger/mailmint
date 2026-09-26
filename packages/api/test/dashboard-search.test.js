'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

/**
 * The mailbox page's search form, exercised the way a browser exercises it:
 * deliver real messages, open the page with query parameters, and assert on
 * the rendered HTML. Invalid values must never 500 and never filter — they
 * show an inline error and the plain list.
 */

let account;
let mb;

const deliver = (from, subject) => H.req('/v1/test/deliver', {
  method: 'POST', key: account.key, body: { mailbox_id: mb.id, from, subject, text: 'Body.' },
});

const page = (qs) => H.req(`/dashboard/mailboxes/${mb.id}${qs ? `?${qs}` : ''}`, { cookie: account.cookie });

before(async () => {
  await H.start();
  account = await H.newAccount();
  mb = await H.newMailbox(account.key);
  assert.equal((await deliver('billing@acme.example', 'Invoice 100% paid')).res.status, 201);
  assert.equal((await deliver('ops@globex.example', 'Invoice 1000 overdue')).res.status, 201);
  assert.equal((await deliver('hr@initech.example', 'Weekly report')).res.status, 201);
});
after(H.stop);

test('from=ACME (other case) matches only the acme sender', async () => {
  const { res, text } = await page('from=ACME');
  assert.equal(res.status, 200);
  assert.ok(text.includes('billing@acme.example'), 'the acme sender is shown');
  assert.ok(!text.includes('globex'), 'globex is not shown');
  assert.ok(!text.includes('initech'), 'initech is not shown');
  assert.ok(text.includes('Matching messages'), 'the heading switches to Matching messages');
  assert.ok(!text.includes('Last messages'), 'the old heading is gone');
});

test('subject=invoice matches both invoices, not the report', async () => {
  const { res, text } = await page('subject=invoice');
  assert.equal(res.status, 200);
  assert.ok(text.includes('Invoice 100% paid'));
  assert.ok(text.includes('Invoice 1000 overdue'));
  assert.ok(!text.includes('Weekly report'), 'the report is not an invoice');
  assert.ok(text.includes('2 messages match.'));
});

test('subject=100% matches the literal percent, not 1000', async () => {
  const { res, text } = await page('subject=100%25');
  assert.equal(res.status, 200);
  assert.ok(text.includes('Invoice 100% paid'));
  assert.ok(!text.includes('Invoice 1000 overdue'), '% must be a literal, not a wildcard');
});

test('until before all messages matches nothing; since today matches all', async () => {
  const past = await page('until=2000-01-01');
  assert.equal(past.res.status, 200);
  assert.ok(past.text.includes('No messages match this search.'));
  const today = new Date().toISOString().slice(0, 10);
  const all = await page(`since=${today}`);
  assert.equal(all.res.status, 200);
  assert.ok(all.text.includes('billing@acme.example'));
  assert.ok(all.text.includes('ops@globex.example'));
  assert.ok(all.text.includes('hr@initech.example'));
  assert.ok(all.text.includes('3 messages match.'));
});

test('since=garbage is a 200 with an inline error and the plain list', async () => {
  const { res, text } = await page('since=garbage');
  assert.equal(res.status, 200);
  assert.ok(text.includes('role="alert"'), 'an inline error is shown');
  assert.ok(text.includes('Last messages'), 'the plain list is unchanged');
  assert.ok(!text.includes('Matching messages'));
});

test('since=2026-02-31 is not a calendar day: inline error, no filter', async () => {
  const { res, text } = await page('since=2026-02-31');
  assert.equal(res.status, 200);
  assert.ok(text.includes('role="alert"'), 'an inline error is shown');
  assert.ok(text.includes('Last messages'), 'the plain list is unchanged');
});

test('a 201-char from is a 200 with an inline error', async () => {
  const { res, text } = await page(`from=${'a'.repeat(201)}`);
  assert.equal(res.status, 200);
  assert.ok(text.includes('role="alert"'), 'an inline error is shown');
  assert.ok(text.includes('over 200 characters'));
  assert.ok(text.includes('Last messages'), 'the plain list is unchanged');
});

test('a subject search is echoed escaped, never as raw markup', async () => {
  const { res, text } = await page('subject=%3Cscript%3Ex%3C%2Fscript%3E');
  assert.equal(res.status, 200);
  assert.ok(!text.includes('<script>x</script>'), 'raw script markup must not reach the page');
  assert.ok(text.includes('&lt;script&gt;'), 'the value is echoed HTML-escaped');
});

test('another account gets a non-200 and never the acme sender', async () => {
  const other = await H.newAccount();
  const { res, text } = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: other.cookie });
  assert.ok(res.status >= 400, `expected a 4xx for a foreign mailbox, got ${res.status}`);
  assert.ok(!text.includes('billing@acme.example'), 'no sender of the other tenant leaks');
});

test('no parameters: the old list and a search form with all four inputs', async () => {
  const { res, text } = await page('');
  assert.equal(res.status, 200);
  assert.ok(text.includes('<h2>Last messages</h2>'));
  assert.ok(!text.includes('Matching messages'));
  const m = /<form method="get"[^>]*class="search"[^>]*>[\s\S]*?<\/form>/.exec(text);
  assert.ok(m, 'the search form is present');
  for (const name of ['from', 'subject', 'since', 'until']) {
    assert.ok(new RegExp(`name="${name}"`).test(m[0]), `the form has an input named ${name}`);
  }
});

test('repeated from parameters are a 200 with an inline error', async () => {
  const { res, text } = await page('from=a&from=b');
  assert.equal(res.status, 200);
  assert.ok(text.includes('role="alert"'), 'an inline error is shown');
  assert.ok(text.includes('Last messages'), 'the plain list is unchanged');
});

test('subject=INV_2 does not match INV22 (underscore is literal)', async () => {
  assert.equal((await deliver('ops@globex.example', 'INV22 test')).res.status, 201);
  const { res, text } = await page('subject=INV_2');
  assert.equal(res.status, 200);
  assert.ok(text.includes('Matching messages'));
  assert.ok(!text.includes('INV22'), 'a LIKE underscore must not act as a single-char wildcard');
  assert.ok(text.includes('No messages match this search.'));
});

test('the search form has a heading, a styled fieldrow and a separated button', async () => {
  const { res, text } = await page('');
  assert.equal(res.status, 200);
  assert.ok(text.includes('<h2>Search messages</h2>'), 'the search section has a heading');
  const m = /<form method="get"[^>]*class="search"[^>]*>[\s\S]*?<\/form>/.exec(text);
  assert.ok(m, 'the search form is present');
  const form = m[0];
  const row = /<div class="fieldrow">[\s\S]*?<\/div>/.exec(form);
  assert.ok(row, 'the inputs are wrapped in a fieldrow');
  for (const name of ['from', 'subject', 'since', 'until']) {
    assert.ok(new RegExp(`name="${name}"`).test(row[0]), `the ${name} input sits inside the fieldrow`);
  }
  assert.ok(form.includes('<p><button>Search</button></p>'), 'the button is separated from the fields');
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  assert.ok(css.includes('.search .fieldrow{grid-template-columns:1.2fr 1.5fr 1fr 1fr}'), 'the desktop grid rule is present');
  assert.ok(css.includes('@media (max-width:680px){.search .fieldrow{grid-template-columns:1fr 1fr}}'), 'the phone grid rule is present');
});
