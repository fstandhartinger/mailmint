'use strict';

/**
 * Legal pages (/impressum, /privacy, /terms) — PRD C4 + C14(c).
 *
 * No database needed: these tests exercise the site router's PAGES map and the
 * static files it serves directly (site.js exports { router, PAGES } and is
 * mounted ahead of web.router in server.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { PAGES } = require('../src/site.js');

const LEGAL_PAGES = [
  { url: '/impressum', file: 'impressum.html', mustContain: ['productivity-boost.com Betriebs UG', 'HRB 8453'] },
  { url: '/privacy', file: 'privacy.html', mustContain: ['Chutes', 'Stripe', 'Hetzner', 'Google'] },
  { url: '/terms', file: 'terms.html', mustContain: ['Last updated'] },
];

test('each legal page is mapped in PAGES and its file exists', () => {
  for (const p of LEGAL_PAGES) {
    assert.equal(PAGES[p.url], p.file, `PAGES must map ${p.url} to ${p.file}`);
    assert.ok(
      fs.existsSync(path.join(PUBLIC_DIR, p.file)),
      `${p.file} must exist in packages/api/public`,
    );
  }
});

test('legal pages carry their required facts', () => {
  for (const p of LEGAL_PAGES) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, p.file), 'utf8');
    for (const needle of p.mustContain) {
      assert.ok(html.includes(needle), `${p.file} must contain "${needle}"`);
    }
  }
});

test('every public page with a footer links all three legal pages', () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter((n) => n.endsWith('.html'));
  const withFooter = files.filter((n) =>
    fs.readFileSync(path.join(PUBLIC_DIR, n), 'utf8').includes('<footer'),
  );
  assert.ok(withFooter.length > 0, 'expected at least one public page with a footer');
  for (const file of withFooter) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const href of ['/impressum', '/privacy', '/terms']) {
      assert.ok(
        html.includes(`href="${href}"`),
        `${file} footer must link ${href}`,
      );
    }
  }
});

test('privacy page makes no compliance claims we cannot back up', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'privacy.html'), 'utf8');
  assert.ok(!/GDPR-compliant/i.test(html), 'privacy.html must not claim GDPR compliance');
  assert.ok(!/DSGVO-konform/i.test(html), 'privacy.html must not claim DSGVO conformity');
});
