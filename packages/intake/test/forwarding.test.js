'use strict';

/**
 * Fixtures below are reconstructions of the real confirmation mails: the
 * sender, subject line, code wording and link shape are what each provider
 * actually sends, with every address replaced by example.test. No real
 * customer mail is committed to this repo (CONTRACT §7).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { detect } = require('../src/forwarding');

const mail = (headers, body, ctype = 'text/plain; charset=UTF-8') => Buffer.from(
  `${headers.join('\r\n')}\r\nContent-Type: ${ctype}\r\nMIME-Version: 1.0\r\n\r\n${body}`, 'utf8',
);

const GMAIL = mail([
  'Message-ID: <CAF-gmail-confirm@mail.gmail.com>',
  'From: Gmail Team <forwarding-noreply@google.com>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: (#987654321) Gmail Forwarding Confirmation - Receive Mail from accounts@example.test',
  'Date: Tue, 25 Aug 2026 09:14:01 +0000',
], [
  'accounts@example.test has requested to automatically forward mail to your',
  'email address k7m2xq4h9bwz@parse.example.com.',
  'Confirmation code: 987654321',
  '',
  'To allow accounts@example.test to automatically forward mail to your address,',
  'please click the link below to confirm the request:',
  '',
  'https://mail.google.com/mail/vf-%5BANGjdJ9RxAmPlE%5D-QwErTyUiOp-ZxCvBn',
  '',
  'Thanks for using Gmail!',
].join('\r\n'));

const OUTLOOK = mail([
  'Message-ID: <outlook-fwd@outlook.com>',
  'From: Microsoft account team <postmaster@outlook.com>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: Verify your forwarding email address',
], [
  'You are receiving this message because someone asked to forward mail from',
  'billing@example.test to this address.',
  '',
  'Verification code: 4821990',
  '',
  'Confirm here: https://account.live.com/forwardconfirm?id=4821990&mkt=en-US',
].join('\r\n'));

const ZOHO = mail([
  'Message-ID: <zoho-fwd@zohomail.com>',
  'From: Zoho Mail <mailer-daemon@zohomail.com>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: Zoho Mail - Email forwarding confirmation',
], [
  'invoices@example.test wants to forward emails to k7m2xq4h9bwz@parse.example.com.',
  '',
  'Confirmation Code : ZM8842LQ',
  '',
  'Click the link to confirm:',
  'https://mail.zoho.com/zm/ConfirmForward.do?code=ZM8842LQ&mode=verify',
].join('\r\n'));

const FASTMAIL = mail([
  'Message-ID: <fastmail-fwd@messagingengine.com>',
  'From: Fastmail <noreply@fastmail.com>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: Confirm your email forwarding request',
], [
  'A request was made to forward mail from ops@example.test to this address.',
  'Code: FM-7C2K9',
  'Confirm: https://www.fastmail.com/settings/confirm/verify?token=abc123def456',
].join('\r\n'));

const HTML_ONLY = mail([
  'Message-ID: <html-gmail@mail.gmail.com>',
  'From: Gmail Team <forwarding-noreply@google.com>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: (#112233445) Gmail Forwarding Confirmation - Receive Mail from html@example.test',
], [
  '<html><body><p>html@example.test has requested to automatically forward mail.</p>',
  '<p>Confirmation code: 112233445</p>',
  '<p><a href="https://mail.google.com/mail/vf-%5BANGjdJhtml%5D-abcdef">Confirm request</a></p>',
  '</body></html>',
].join('\r\n'), 'text/html; charset=UTF-8');

const SPOOFED = mail([
  'Message-ID: <spoof@evil.example>',
  'From: "Gmail Team" <forwarding-noreply@google.com.evil.example>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: (#000111222) Gmail Forwarding Confirmation - Receive Mail from victim@example.test',
], [
  'Confirmation code: 000111222',
  'Click to confirm: https://mail-google.evil.example/verify?id=000111222',
].join('\r\n'));

const ORDINARY = mail([
  'Message-ID: <normal@example.test>',
  'From: Acme Billing <billing@example.test>',
  'To: k7m2xq4h9bwz@parse.example.com',
  'Subject: Invoice INV-2291 from Acme Ltd',
], 'Your invoice is attached. Total: $31.50 due September 8, 2026.\r\n');

test('Gmail forwarding confirmation', () => {
  const d = detect(GMAIL);
  assert.ok(d, 'not detected');
  assert.equal(d.provider, 'gmail');
  assert.equal(d.code, '987654321');
  assert.equal(d.link, 'https://mail.google.com/mail/vf-%5BANGjdJ9RxAmPlE%5D-QwErTyUiOp-ZxCvBn');
  assert.equal(d.link_trusted, true);
  assert.equal(d.link_host, 'mail.google.com');
  assert.equal(d.forward_from, 'accounts@example.test');
  assert.equal(d.action, 'click_link');
  assert.ok(d.confidence >= 0.9, `confidence ${d.confidence}`);
  assert.match(d.instructions, /Click the confirmation link/);
});

test('Outlook forwarding confirmation', () => {
  const d = detect(OUTLOOK);
  assert.ok(d, 'not detected');
  assert.equal(d.provider, 'outlook');
  assert.equal(d.code, '4821990');
  assert.equal(d.link, 'https://account.live.com/forwardconfirm?id=4821990&mkt=en-US');
  assert.equal(d.link_trusted, true);
});

test('Zoho forwarding confirmation', () => {
  const d = detect(ZOHO);
  assert.ok(d, 'not detected');
  assert.equal(d.provider, 'zoho');
  assert.equal(d.code, 'ZM8842LQ');
  assert.match(d.link, /^https:\/\/mail\.zoho\.com\/zm\/ConfirmForward\.do/);
  assert.equal(d.link_trusted, true);
});

test('Fastmail forwarding confirmation', () => {
  const d = detect(FASTMAIL);
  assert.ok(d, 'not detected');
  assert.equal(d.provider, 'fastmail');
  assert.equal(d.code, 'FM-7C2K9');
  assert.equal(d.link, 'https://www.fastmail.com/settings/confirm/verify?token=abc123def456');
  assert.equal(d.link_trusted, true);
});

test('an HTML-only confirmation is read through the markup', () => {
  const d = detect(HTML_ONLY);
  assert.ok(d, 'not detected');
  assert.equal(d.provider, 'gmail');
  assert.equal(d.code, '112233445');
  assert.equal(d.link, 'https://mail.google.com/mail/vf-%5BANGjdJhtml%5D-abcdef');
  assert.equal(d.link_trusted, true);
});

test('a spoofed confirmation is surfaced but its link is marked untrusted', () => {
  // Anyone can send this mail. The dashboard must not render a one-click
  // button for a host that is not the provider's.
  const d = detect(SPOOFED);
  assert.ok(d, 'not detected');
  assert.equal(d.link_host, 'mail-google.evil.example');
  assert.equal(d.link_trusted, false);
  assert.equal(d.action, 'click_link_untrusted_host');
  assert.match(d.instructions, /Do not click it/);
});

test('ordinary mail is not a confirmation', () => {
  assert.equal(detect(ORDINARY), null);
});

test('a real DKIM-signed invoice from the live test inbox is not a false positive', (t) => {
  const dir = '/home/flori/Dev/pdfnode/mailmint/.local/realmail';
  if (!fs.existsSync(dir)) return t.skip('no local real-mail corpus (it is gitignored on purpose)');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.eml'));
  if (!files.length) return t.skip('no .eml fixtures present');
  for (const f of files) {
    const d = detect(fs.readFileSync(`${dir}/${f}`));
    assert.equal(d, null, `${f} was wrongly detected as a forwarding confirmation`);
  }
  return undefined;
});
