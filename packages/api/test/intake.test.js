'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers');

let key;

before(async () => { await H.start(); ({ key } = await H.newAccount()); });
after(H.stop);

const withMessageId = (to, messageId, subject = 'Invoice INV-77 from Acme Ltd') => Buffer.from([
  'From: Acme Billing <billing@acme.com>',
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-Id: <${messageId}>`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '', 'Total: $31.50\r\n',
].join('\r\n'), 'utf8');

describe('delivery is exactly-once, whatever the sender does', () => {
  test('the same Message-ID twice makes one message, one event and one webhook', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const mb = await H.newMailbox(key, { webhook_url: url, schema: [{ name: 'total', type: 'number' }] });
    const mid = `dup-${crypto.randomBytes(6).toString('hex')}@acme.com`;
    const raw = withMessageId(mb.address, mid);

    const first = await H.deliver(mb, { raw, wait: true });
    assert.equal(first.res.status, 200);
    assert.ok(!first.json.duplicate);

    // The retry an SMTP sender makes when our 250 is lost on the way back.
    const second = await H.deliver(mb, { raw, wait: true });
    assert.equal(second.res.status, 200, 'a retry must be accepted, not refused');
    assert.equal(second.json.message_id, first.json.message_id, 'and must name the message we already have');
    assert.equal(second.json.duplicate, true);

    const { rows } = await H.query(`SELECT count(*)::int AS n FROM messages WHERE mailbox_id = $1`, [mb.id]);
    assert.equal(rows[0].n, 1, 'a second row is a customer workflow running twice');

    const events = await H.query(`SELECT count(*)::int AS n FROM events WHERE message_id = $1`, [first.json.message_id]);
    assert.equal(events.rows[0].n, 1, 'a poller must not see it twice either');

    const deliveries = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = $1`, [first.json.message_id]);
    assert.equal(deliveries.rows[0].n, 1);

    await H.flushWebhooks(first.json.message_id);
    assert.equal(listener.received.length, 1);
    await listener.close();
  });

  test('an explicit idempotency_key works when the mail carries no Message-ID', async () => {
    const mb = await H.newMailbox(key);
    const raw = Buffer.from(['From: a@b.example', `To: ${mb.address}`, 'Subject: No id', '', 'body'].join('\r\n'), 'utf8');
    const idk = `imap-${crypto.randomBytes(6).toString('hex')}`;

    const first = await H.internal('/internal/deliver', {
      envelope: { from: 'a@b.example', to: [mb.address], helo: null, remote_ip: null, tls: true, source: 'imap' },
      mailbox_token: mb.token, raw_mime: raw.toString('base64'), idempotency_key: idk, wait: true,
    });
    const second = await H.internal('/internal/deliver', {
      envelope: { from: 'a@b.example', to: [mb.address], helo: null, remote_ip: null, tls: true, source: 'imap' },
      mailbox_token: mb.token, raw_mime: raw.toString('base64'), idempotency_key: idk, wait: true,
    });
    assert.equal(second.json.message_id, first.json.message_id);
    assert.equal(second.json.duplicate, true);
    const { rows } = await H.query(`SELECT count(*)::int AS n FROM messages WHERE mailbox_id = $1`, [mb.id]);
    assert.equal(rows[0].n, 1);
  });

  test('the connector\'s own body shape is accepted as sent', async () => {
    // Exactly what packages/intake posts: mailbox_token, an envelope with nulls
    // where SMTP would have values, and source "imap".
    const mb = await H.newMailbox(key, { schema: [{ name: 'total', type: 'number' }] });
    const mid = `imapmsg-${crypto.randomBytes(6).toString('hex')}@gmail.com`;
    const { res, json } = await H.internal('/internal/deliver', {
      mailbox_token: mb.token,
      envelope: { from: 'billing@acme.com', to: [mb.address], helo: null, remote_ip: null, tls: true, source: 'imap' },
      raw_mime: withMessageId(mb.address, mid).toString('base64'),
      message_id: mid,
      wait: true,
    });
    assert.equal(res.status, 200);
    assert.match(json.message_id, /^msg_/);
    assert.equal(json.status, 'parsed');

    const got = await H.req(`/v1/messages/${json.message_id}`, { key });
    assert.equal(got.json.envelope.source, 'imap');
    assert.equal(got.json.envelope.remote_ip, null);
  });

  test('two mailboxes may both receive the same broadcast', async () => {
    const a = await H.newMailbox(key);
    const b = await H.newMailbox(key);
    const mid = `broadcast-${crypto.randomBytes(6).toString('hex')}@list.example`;
    const first = await H.deliver(a, { raw: withMessageId(a.address, mid), wait: true });
    const second = await H.deliver(b, { raw: withMessageId(b.address, mid), wait: true });
    assert.notEqual(second.json.message_id, first.json.message_id,
      'deduplication is scoped to one mailbox, not to the whole service');
  });
});

describe('connector state', () => {
  test('round-trips, and a cold start is not an error', async () => {
    const id = `conn-${crypto.randomBytes(6).toString('hex')}`;
    const cold = await H.req(`/internal/connector-state?connection_id=${id}`, {
      headers: { 'x-mailmint-internal': process.env.INTERNAL_SECRET },
    });
    assert.equal(cold.res.status, 200, 'a connection that has never reported is new, not broken');
    assert.equal(cold.json.state, null);

    const mb = await H.newMailbox(key);
    const state = { uidvalidity: 12345, last_uid: 908, seen: [crypto.createHash('sha256').update('x').digest('hex').slice(0, 16)] };
    const saved = await H.internal('/internal/connector-state', { connection_id: id, mailbox_token: mb.token, state });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.json.ok, true);

    const read = await H.req(`/internal/connector-state?connection_id=${id}`, {
      headers: { 'x-mailmint-internal': process.env.INTERNAL_SECRET },
    });
    assert.deepEqual(read.json.state, state);
    assert.equal(read.json.mailbox_id, mb.id);

    // Advancing the mark overwrites rather than accumulating.
    await H.internal('/internal/connector-state', { connection_id: id, state: { uidvalidity: 12345, last_uid: 940 } });
    const again = await H.req(`/internal/connector-state?connection_id=${id}`, {
      headers: { 'x-mailmint-internal': process.env.INTERNAL_SECRET },
    });
    assert.equal(again.json.state.last_uid, 940);
    assert.equal(again.json.mailbox_id, mb.id, 'the mailbox binding survives a state-only update');
  });

  test('it is behind the shared secret like everything else internal', async () => {
    const { res } = await H.req('/internal/connector-state?connection_id=x');
    assert.equal(res.status, 401);
    const post = await H.req('/internal/connector-state', { method: 'POST', body: { connection_id: 'x', state: {} } });
    assert.equal(post.res.status, 401);
  });

  test('an absurd state is refused rather than stored', async () => {
    const { res, json } = await H.internal('/internal/connector-state', {
      connection_id: 'fat', state: { blob: 'x'.repeat(300 * 1024) },
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'state_too_large');
  });
});

describe('forwarding confirmations', () => {
  test('a confirmation riding along with a delivery is stored and shown', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    const mid = `gm-${crypto.randomBytes(6).toString('hex')}@google.com`;
    await H.internal('/internal/deliver', {
      mailbox_token: mb.token,
      envelope: { from: 'forwarding-noreply@google.com', to: [mb.address], tls: true, source: 'imap' },
      raw_mime: withMessageId(mb.address, mid, 'Gmail Forwarding Confirmation').toString('base64'),
      wait: true,
      forwarding_confirmation: {
        provider: 'gmail', code: '839215',
        link: 'https://mail.google.com/mail/vf-confirm?c=839215',
        link_trusted: true, from: 'forwarding-noreply@google.com',
        subject: 'Gmail Forwarding Confirmation',
      },
    });
    const { rows } = await H.query(`SELECT * FROM forwarding_confirmations WHERE mailbox_id = $1`, [mb.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, '839215');
    assert.equal(rows[0].link_trusted, true);

    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.match(page.text, /839215/);
    assert.match(page.text, /Open the confirmation link/, 'a trusted link may be clickable');
  });

  test('an untrusted link is never rendered as a link', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    // What an attacker sends: a convincing subject and a link to their own host.
    await H.internal('/internal/forwarding-confirmation', {
      mailbox_token: mb.token,
      forwarding_confirmation: {
        provider: 'gmail', code: '000000',
        link: 'https://mail-google-com.evil.example/confirm?c=000000',
        link_trusted: false, subject: 'Gmail Forwarding Confirmation',
      },
    });
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.match(page.text, /not shown as clickable on purpose/);
    assert.equal(page.text.includes('href="https://mail-google-com.evil.example'), false,
      'an untrusted host must never become an anchor on a signed-in page');
    // It is still shown, as text, so the user can judge it.
    assert.match(page.text, /mail-google-com\.evil\.example/);
  });

  test('a javascript: link is downgraded even if the caller claimed it was trusted', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    await H.internal('/internal/forwarding-confirmation', {
      mailbox_token: mb.token,
      forwarding_confirmation: { provider: 'gmail', code: '1', link: 'javascript:alert(1)', link_trusted: true },
    });
    const { rows } = await H.query(`SELECT link_trusted FROM forwarding_confirmations WHERE mailbox_id = $1`, [mb.id]);
    assert.equal(rows[0].link_trusted, false, 'the scheme is re-checked here, not taken on trust');
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.equal(page.text.includes('href="javascript:'), false);
  });

  test('it can be dismissed', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key);
    await H.internal('/internal/forwarding-confirmation', {
      mailbox_token: mb.token, forwarding_confirmation: { provider: 'zoho', code: '555111' },
    });
    const { rows } = await H.query(`SELECT id FROM forwarding_confirmations WHERE mailbox_id = $1`, [mb.id]);
    const done = await H.req(`/dashboard/forwarding/${rows[0].id}/dismiss`, { method: 'POST', form: true, body: {}, cookie: account.cookie });
    assert.equal(done.res.status, 302);
    const page = await H.req(`/dashboard/mailboxes/${mb.id}`, { cookie: account.cookie });
    assert.equal(page.text.includes('555111'), false);
  });
});
