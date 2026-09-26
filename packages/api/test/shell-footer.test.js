'use strict';

/**
 * The server-rendered shell (`shell()` in src/web.js) appends a legal footer to
 * every page it renders — login, signup, dashboard, 404. Like the static pages
 * in packages/api/public, that footer must link the legal pages and /status.
 *
 * No database is needed: requiring ../src/web only reads its own files and the
 * public assets it renders with; it does not open a connection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { shell } = require('../src/web');

test("every server-rendered page's footer links the legal and status pages", () => {
  const html = shell('t', '<p>x</p>');
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  assert.ok(footer.length > 0, 'the shell must render a non-empty footer block');
  for (const href of ['/impressum', '/privacy', '/terms', '/status']) {
    assert.ok(footer.includes(`href="${href}"`), `shell footer must link ${href}`);
  }
  const impressum = footer.indexOf('/impressum');
  const privacy = footer.indexOf('/privacy');
  const terms = footer.indexOf('/terms');
  const status = footer.indexOf('/status');
  assert.ok(
    impressum < privacy && privacy < terms && terms < status,
    'the links must be ordered Impressum < Privacy < Terms < Status, like the static pages',
  );
});
