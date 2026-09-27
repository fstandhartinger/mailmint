'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let key;
let mailbox;
let domain;
let acmeAddr;
let globexAddr;
let plainAddr;

const deliverTo = (addr, from, subject) => H.internal('/internal/deliver', {
  envelope: { from, to: [addr], helo: 'mail.acme.com', remote_ip: '203.0.113.9', tls: true },
  raw_mime: H.rawMime({ from, to: addr, subject }).toString('base64'),
  wait: true,
});

const list = (qs, k = key) => H.req(`/v1/messages?mailbox_id=${mailbox.id}&${qs}`, { key: k });

before(async () => {
  await H.start();
  ({ key } = await H.newAccount());
  mailbox = await H.newMailbox(key);
  domain = H.config.inboundDomain;
  acmeAddr = `${mailbox.token}+acme@${domain}`;
  globexAddr = `${mailbox.token}+globex@${domain}`;
  plainAddr = `${mailbox.token}@${domain}`;
  const acme = await deliverTo(acmeAddr, 'billing@acme.example', 'Acme invoice 2291');
  const globex = await deliverTo(globexAddr, 'ops@globex.example', 'Globex invoice 2292');
  const plain = await deliverTo(plainAddr, 'hr@initech.example', 'Plain delivery');
  assert.equal(acme.res.status, 200);
  assert.equal(globex.res.status, 200);
  assert.equal(plain.res.status, 200);
});
after(H.stop);

test('to=+ACME (other case) returns exactly the acme message', async () => {
  const { json } = await list('to=%2BACME');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].from, 'billing@acme.example');
  assert.deepEqual(json.data[0].to, [acmeAddr]);
  assert.equal(json.data[0].tag, 'acme');
});

test('tag=globex and tag=GLOBEX both return exactly the globex message', async () => {
  const lower = await list('tag=globex');
  assert.equal(lower.json.data.length, 1);
  assert.equal(lower.json.data[0].from, 'ops@globex.example');
  assert.deepEqual(lower.json.data[0].to, [globexAddr]);
  assert.equal(lower.json.data[0].tag, 'globex');
  const upper = await list('tag=GLOBEX');
  assert.equal(upper.json.data.length, 1);
  assert.equal(upper.json.data[0].id, lower.json.data[0].id);
});

test('to=<token> returns all three, each with its to array and tag', async () => {
  const { json } = await list(`to=${mailbox.token}`);
  assert.equal(json.data.length, 3);
  const byFrom = Object.fromEntries(json.data.map((m) => [m.from, m]));
  for (const row of json.data) {
    assert.ok(Array.isArray(row.to), 'to must be an array');
    assert.ok(row.to.length >= 1, 'to must contain the delivered address');
  }
  assert.deepEqual(byFrom['billing@acme.example'].to, [acmeAddr]);
  assert.equal(byFrom['billing@acme.example'].tag, 'acme');
  assert.deepEqual(byFrom['ops@globex.example'].to, [globexAddr]);
  assert.equal(byFrom['ops@globex.example'].tag, 'globex');
  assert.deepEqual(byFrom['hr@initech.example'].to, [plainAddr]);
  assert.equal(byFrom['hr@initech.example'].tag, null);
});

test('to=50%25 matches the literal percent, nothing', async () => {
  const { json } = await list('to=50%25');
  assert.equal(json.data.length, 0);
});

test('to=_ and to=\\ match literally and find nothing', async () => {
  const underscore = await list('to=%5F');
  assert.equal(underscore.json.data.length, 0, 'no address contains an underscore');
  const backslash = await list('to=%5C');
  assert.equal(backslash.json.data.length, 0, 'no address contains a backslash');
});

test('a 201-char to and a 201-char tag are 400 query_too_long', async () => {
  const longTo = await list(`to=${'a'.repeat(201)}`);
  assert.equal(longTo.res.status, 400);
  assert.equal(longTo.json.error.code, 'query_too_long');
  const longTag = await list(`tag=${'b'.repeat(201)}`);
  assert.equal(longTag.res.status, 400);
  assert.equal(longTag.json.error.code, 'query_too_long');
});

test('to=<token> combined with from=<sender> is an AND', async () => {
  const { json } = await list(`to=${mailbox.token}&from=billing@acme.example`);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].from, 'billing@acme.example');
  assert.deepEqual(json.data[0].to, [acmeAddr]);
});

test('another account querying the same to= (no mailbox_id) sees 0 rows', async () => {
  const other = await H.newAccount();
  const { json } = await H.req(`/v1/messages?to=${mailbox.token}`, { key: other.key });
  assert.equal(json.data.length, 0);
});

test('an smtpd-style delivery (bare mailbox_token, +tag only in envelope.to) is found by tag=', async () => {
  const addr = `${mailbox.token}+initech@${domain}`;
  const { res } = await H.internal('/internal/deliver', {
    mailbox_token: mailbox.token,
    envelope: { from: 'sales@initech.example', to: [addr], helo: 'mail.initech.example', remote_ip: '203.0.113.10', tls: true },
    raw_mime: H.rawMime({ from: 'sales@initech.example', to: addr, subject: 'Initech quote 77' }).toString('base64'),
    wait: true,
  });
  assert.equal(res.status, 200);
  const { json } = await list('tag=initech');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].from, 'sales@initech.example');
  assert.deepEqual(json.data[0].to, [addr]);
  assert.equal(json.data[0].tag, 'initech');
});

test('a bare mailbox_token with a foreign +tag rcpt does not adopt the tag', async () => {
  const other = await H.newMailbox(key);
  const foreign = `${other.token}+globex2@${domain}`;
  const { res } = await H.internal('/internal/deliver', {
    mailbox_token: mailbox.token,
    envelope: { from: 'it@initech.example', to: [foreign], helo: 'mail.initech.example', remote_ip: '203.0.113.11', tls: true },
    raw_mime: H.rawMime({ from: 'it@initech.example', to: foreign, subject: 'Cross-tag delivery' }).toString('base64'),
    wait: true,
  });
  assert.equal(res.status, 200);
  const { json } = await list(`to=${encodeURIComponent(foreign)}`);
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].from, 'it@initech.example');
  assert.equal(json.data[0].tag, null);
});

test('a legacy row whose envelope.to is a plain string is found and wrapped', async () => {
  const { rows } = await H.query(
    `SELECT id FROM messages WHERE mailbox_id = $1 AND from_email = 'hr@initech.example'`,
    [mailbox.id],
  );
  assert.equal(rows.length, 1);
  await H.query(
    `UPDATE messages SET envelope = jsonb_set(envelope, '{to}', to_jsonb('legacy-rcpt@example.test'::text)) WHERE id = $1`,
    [rows[0].id],
  );
  const { json } = await list('to=legacy-rcpt');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].id, rows[0].id);
  assert.deepEqual(json.data[0].to, ['legacy-rcpt@example.test']);
  assert.equal(json.data[0].tag, null);
});

test('the openapi document lists to and tag on GET /messages and in MessageSummary', async () => {
  const { res, json } = await H.req('/openapi.json');
  assert.equal(res.status, 200);
  const names = json.paths['/messages'].get.parameters.map((p) => p.name);
  for (const name of ['to', 'tag']) {
    assert.ok(names.includes(name), `openapi must list ${name} on GET /messages`);
  }
  const summary = json.components.schemas.MessageSummary.properties;
  assert.ok(summary.to, 'MessageSummary must document to');
  assert.ok(summary.tag, 'MessageSummary must document tag');
  assert.equal(summary.to.type, 'array');
  assert.deepEqual(summary.to.items, { type: 'string' });
  assert.ok(Array.isArray(summary.tag.type) && summary.tag.type.includes('null'), 'tag must be nullable');
});
