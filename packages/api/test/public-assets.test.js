'use strict';

/**
 * Public assets — no third-party request on any public page (PRD VS-2, B2).
 *
 * No database, no network: walks packages/api/public on disk.
 *  (a) no public file (*.html, *.css, *.js) references fonts.googleapis.com / fonts.gstatic.com
 *  (b) no public HTML file loads a <script src>, <link href> (any rel) or <img src> from an
 *      absolute (http(s):// or //) host — outbound <a href> links are fine, and
 *      <link rel="canonical"|"alternate"> may point at the own host mailmint.app.mintapis.com only
 *  (c) public/index.html links /fonts/fonts.css
 *  (d) every url(...) in public/fonts/fonts.css is a /fonts/ path that exists, is non-empty
 *      and starts with the wOF2 magic bytes
 *  (e) both SIL OFL licence files exist and contain "SIL OPEN FONT LICENSE"
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts');
const OWN_HOST = 'mailmint.app.mintapis.com';

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(PUBLIC_DIR);
const HTML_FILES = ALL_FILES.filter((f) => f.endsWith('.html'));

function parseAttrs(tagText) {
  const attrs = {};
  const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRe.exec(tagText)) !== null) {
    attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function isAbsoluteUrl(url) {
  return /^(https?:)?\/\//i.test(url.trim());
}

function hostOf(url) {
  const withScheme = /^https?:/i.test(url) ? url : `https:${url.startsWith('//') ? '' : '//'}${url}`;
  return new URL(withScheme).host;
}

test('no public html/css/js file references Google Fonts hosts', () => {
  const files = ALL_FILES.filter((f) => /\.(html|css|js)$/i.test(f));
  assert.ok(files.length > 0, 'expected files under public/');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    assert.ok(
      !text.includes('fonts.googleapis.com') && !text.includes('fonts.gstatic.com'),
      `${rel} must not reference fonts.googleapis.com or fonts.gstatic.com`,
    );
  }
});

test('no public html file loads script/link/img from an absolute third-party URL', () => {
  assert.ok(HTML_FILES.length > 0, 'expected html files under public/');
  const tagRe = /<(script|link|img)\b[^>]*>/gi;
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = parseAttrs(m[0]);
      const url = tag === 'link' ? attrs.href : attrs.src;
      if (!url || !isAbsoluteUrl(url)) continue;
      const rel_attr = (attrs.rel || '').toLowerCase();
      if (tag === 'link' && (rel_attr === 'canonical' || rel_attr === 'alternate')) {
        assert.equal(
          hostOf(url),
          'mailmint.app.mintapis.com',
          `${rel}: <link rel="${rel_attr}"> may point at the own host mailmint.app.mintapis.com only, got ${url}`,
        );
        continue;
      }
      assert.fail(
        `${rel}: <${tag}> loads an absolute third-party URL (${url}) — public pages must reference first-party assets only`,
      );
    }
  }
});

test('index.html links the self-hosted fonts stylesheet', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(
    /<link\b[^>]*href=["']\/fonts\/fonts\.css["'][^>]*>/i.test(html),
    'index.html must contain a link to /fonts/fonts.css',
  );
});

test('every url() in fonts.css is a /fonts/ path to a real wOF2 file', () => {
  const cssPath = path.join(FONTS_DIR, 'fonts.css');
  assert.ok(fs.existsSync(cssPath), 'public/fonts/fonts.css must exist');
  const css = fs.readFileSync(cssPath, 'utf8');
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const urls = [];
  let m;
  while ((m = urlRe.exec(css)) !== null) urls.push(m[2]);
  assert.ok(urls.length > 0, 'fonts.css must reference at least one font file');
  for (const url of urls) {
    assert.ok(url.startsWith('/fonts/'), `fonts.css url must be a /fonts/ path, got ${url}`);
    const file = path.join(PUBLIC_DIR, url);
    assert.ok(fs.existsSync(file), `${url} referenced in fonts.css must exist on disk`);
    const buf = fs.readFileSync(file);
    assert.ok(buf.length > 0, `${url} must be non-empty`);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${url} must start with the wOF2 magic bytes`);
  }
  assert.ok(
    !/url\(\s*['"]?(https?:)?\/\//i.test(css),
    'fonts.css must not load any absolute URL',
  );
});

test('SIL OFL licence files for both font families exist', () => {
  for (const name of ['OFL-Inter.txt', 'OFL-JetBrainsMono.txt']) {
    const file = path.join(FONTS_DIR, name);
    assert.ok(fs.existsSync(file), `public/fonts/${name} must exist`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('SIL OPEN FONT LICENSE'), `${name} must contain "SIL OPEN FONT LICENSE"`);
  }
});
