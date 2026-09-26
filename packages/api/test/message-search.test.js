'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key;
let mailbox;

const deliver = (k, mb, from, subject) => H.req('/v1/test/deliver', {
  method: 'POST', key: k, body: { mailbox_id: mb.id, from, subject, text: 'Body.' },
});

const list = (qs, k = key) => H.req(`/v1/messages?mailbox_id=${mailbox.id}&${qs}`, { key: k });

before(async () => {
  await H.start();
  ({ key } = await H.newAccount());
  mailbox = await H.newMailbox(key);
  assert.equal((await deliver(key, mailbox, 'billing@acme.example', 'Invoice 100% paid')).res.status, 201);
  assert.equal((await deliver(key, mailbox, 'ops@globex.example', 'Invoice 1000 overdue')).res.status, 201);
  assert.equal((await deliver(key, mailbox, 'hr@initech.example', 'Weekly report')).res.status, 201);
});
after(H.stop);

test('from=ACME (other case) returns exactly the acme message', async () => {
  const { json } = await list('from=ACME');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].from, 'billing@acme.example');
  assert.equal(json.data[0].subject, 'Invoice 100% paid');
});

test('subject=invoice returns exactly the two invoices', async () => {
  const { json } = await list('subject=invoice');
  assert.equal(json.data.length, 2);
  assert.deepEqual(json.data.map((m) => m.subject).sort(), ['Invoice 100% paid', 'Invoice 1000 overdue']);
});

test('subject=100% matches the literal percent, not 1000', async () => {
  const { json } = await list('subject=100%25');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].subject, 'Invoice 100% paid');
});

test('until before all messages returns 0, until in the future returns all', async () => {
  const past = await list('until=2000-01-01T00:00:00Z');
  assert.equal(past.json.data.length, 0);
  const future = await list('until=2030-01-01T00:00:00Z');
  assert.equal(future.json.data.length, 3);
});

test('until=garbage is a 400 invalid_until', async () => {
  const { res, json } = await list('until=garbage');
  assert.equal(res.status, 400);
  assert.equal(json.error.code, 'invalid_until');
});

test('a 201-char from is a 400 query_too_long', async () => {
  const { res, json } = await list(`from=${'a'.repeat(201)}`);
  assert.equal(res.status, 400);
  assert.equal(json.error.code, 'query_too_long');
});

test('another account never sees these messages', async () => {
  const other = await H.newAccount();
  const mb2 = await H.newMailbox(other.key);
  const delivered = await deliver(other.key, mb2, 'billing@acme.example', 'Invoice 777 from the other tenant');
  assert.equal(delivered.res.status, 201);

  const mine = await list('subject=invoice');
  assert.equal(mine.json.data.length, 2, 'the first account still sees exactly its two invoices');
  assert.ok(mine.json.data.every((m) => m.id !== delivered.json.id), 'the other tenant\'s message must not leak in');

  const theirs = await H.req(`/v1/messages?mailbox_id=${mb2.id}&subject=invoice`, { key: other.key });
  assert.equal(theirs.json.data.length, 1, 'the second account sees only its own invoice');
  assert.equal(theirs.json.data[0].id, delivered.json.id);
});

test('the openapi document lists until, from and subject on GET /messages', async () => {
  const { res, json } = await H.req('/openapi.json');
  assert.equal(res.status, 200);
  const names = json.paths['/messages'].get.parameters.map((p) => p.name);
  for (const name of ['until', 'from', 'subject']) {
    assert.ok(names.includes(name), `openapi must list ${name} on GET /messages`);
  }
});
