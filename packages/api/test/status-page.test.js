'use strict';

/**
 * Public status page (/status) — PRD C10.
 *
 * No database needed: these tests exercise the site router's PAGES map and the
 * static files it serves directly, plus README cross-consistency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const README = path.join(__dirname, '..', '..', '..', 'README.md');
const { PAGES } = require('../src/site.js');

const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

test('/status is mapped in PAGES and its file exists', () => {
  assert.equal(PAGES['/status'], 'status.html', 'PAGES must map /status to status.html');
  assert.ok(
    fs.existsSync(path.join(PUBLIC_DIR, 'status.html')),
    'status.html must exist in packages/api/public',
  );
});

test('status page carries the required facts', () => {
  const html = read('status.html');
  const mustContain = [
    'no service level agreement',
    'Finland',
    'Hetzner',
    'mx.smooth-operator.online',
    'STARTTLS',
    "Let's Encrypt",
    'Last updated',
    'href="/healthz"',
    'href="/terms"',
    'href="/privacy"',
    'href="/impressum"',
  ];
  for (const needle of mustContain) {
    assert.ok(html.includes(needle), `status.html must contain "${needle}"`);
  }
});

test('status page makes no invented claims', () => {
  const html = read('status.html');
  assert.ok(!/9\d(\.\d+)?\s*%/.test(html), 'status.html must not publish an uptime percentage');
  assert.ok(!/all systems operational/i.test(html), 'status.html must not claim "all systems operational"');
  assert.ok(!html.includes('<script'), 'status.html must not contain any <script>');
});

test('status page makes no third-party requests', () => {
  const html = read('status.html');
  const ownHost = 'https://mailmint.app.mintapis.com/status';
  const urls = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  for (const url of urls) {
    if (/^https?:\/\//.test(url)) {
      assert.equal(url, ownHost, `status.html must not reference ${url}; only the own-host URL is allowed`);
    }
  }
});

test('status page is served by the application it describes', () => {
  const html = read('status.html');
  assert.ok(
    /served by (the|this) (application|app)/i.test(html),
    'status.html must say it is served by the application it describes',
  );
});

test('README stays consistent with the status page', () => {
  const readme = fs.readFileSync(README, 'utf8');
  for (const needle of ['/status', 'no service level agreement', 'Finland', "Let's Encrypt"]) {
    assert.ok(readme.includes(needle), `README.md must contain "${needle}"`);
  }
  assert.ok(!readme.includes('self-signed'), 'README.md must not mention a self-signed certificate');
});

test('status page matches the legal pages on shared claims', () => {
  const status = read('status.html');
  const terms = read('terms.html');
  const privacy = read('privacy.html');
  for (const needle of ['no service level agreement']) {
    assert.ok(
      status.includes(needle) && terms.includes(needle),
      `status.html and terms.html must both contain "${needle}"`,
    );
  }
  for (const needle of ['Finland', 'Hetzner']) {
    assert.ok(
      status.includes(needle) && privacy.includes(needle),
      `status.html and privacy.html must both contain "${needle}"`,
    );
  }
});
