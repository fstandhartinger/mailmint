'use strict';

/**
 * Public assets — no third-party request on any public page (PRD VS-2 / VS-5).
 *
 * No database, no network. The consent record claims "no public page makes a
 * third-party request"; these tests enforce that claim end to end:
 *  (a) no public file (*.html, *.css, *.js) references fonts.googleapis.com / fonts.gstatic.com
 *  (b) no public HTML file loads any of script[src], link[href], img[src|srcset],
 *      source[src|srcset], iframe[src], video[src|poster], audio[src], track[src],
 *      embed[src], object[data] from an absolute (http(s):// or //) URL — house rule
 *      is relative-only, so for tags other than <link> an absolute URL fails even to
 *      our own host; for <link>, only rel="canonical"|"alternate" may be absolute and
 *      then only to the own host mailmint.app.mintapis.com. Attribute values may be
 *      double-quoted, single-quoted or unquoted, and a '>' inside a quoted value must
 *      not end the tag; browsers honour the first duplicate attribute, the checker
 *      keeps the first too; raw-text contents of <script>/<style> are not parsed for
 *      tags (nor are comments). EVERY srcset candidate URL is checked. Outbound
 *      <a href> links are fine.
 *  (c) inline style="…" attributes and <style> blocks in public HTML, plus every
 *      .css file under packages/api/public, must contain no url() with an absolute
 *      URL and no @import of an absolute URL (quoted, unquoted or url() form).
 *  (d) the server-rendered shell — src/web.js shell(), required WITHOUT a database
 *      and WITHOUT network — passes the same (b) and (c) checks.
 *  (e) the checker is pinned by fixtures: one per former blind spot the old
 *      regex scan could not see, each of which it MUST flag, plus a clean control.
 *  (f) public/index.html links /fonts/fonts.css
 *  (g) every url(...) in public/fonts/fonts.css is a /fonts/ path that exists, is
 *      non-empty and starts with the wOF2 magic bytes
 *  (h) both SIL OFL licence files exist and contain "SIL OPEN FONT LICENSE"
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
const CSS_FILES = ALL_FILES.filter((f) => f.endsWith('.css'));

/* --------------------------------------------------------- pure checkers */

// which attributes of which tags may trigger a network fetch when they hold a URL
const LOADED_ATTRS = {
  script: ['src'],
  link: ['href'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  iframe: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
  object: ['data'],
};

function isAbsoluteUrl(url) {
  return /^(https?:)?\/\//i.test(String(url).trim());
}

function hostOf(url) {
  const withScheme = /^https?:/i.test(url) ? url : `https:${url.startsWith('//') ? '' : '//'}${url}`;
  return new URL(withScheme).host;
}

/**
 * Walk opening tags of an HTML document, handling double-quoted, single-quoted
 * and unquoted attribute values; a '>' inside a quoted value does not end the
 * tag. Returns [{ name, attrs }] for every opening tag. Skips
 * <!-- comments --> (a browser parses nothing there, so nothing loads).
 */
function scanTags(html) {
  const tags = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 32));
    if (!m) { i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const attrs = {};
    let pos = lt + 1 + m[1].length;
    let closed = false;
    while (pos < n) {
      while (pos < n && /\s/.test(html[pos])) pos += 1;
      const ch = html[pos];
      if (ch === '>') { pos += 1; closed = true; break; }
      if (ch === '/') { pos += 1; continue; }
      if (ch === undefined) break;
      const nameStart = pos;
      while (pos < n && !/[\s=/]/.test(html[pos]) && html[pos] !== '>') pos += 1;
      if (pos === nameStart) { pos += 1; continue; }
      const attrName = html.slice(nameStart, pos).toLowerCase();
      let probe = pos;
      while (probe < n && /\s/.test(html[probe])) probe += 1;
      if (html[probe] === '=') {
        pos = probe + 1;
        while (pos < n && /\s/.test(html[pos])) pos += 1;
        const q = html[pos];
        if (q === '"' || q === "'") {
          const endQ = html.indexOf(q, pos + 1);
          if (endQ === -1) { if (attrs[attrName] === undefined) attrs[attrName] = html.slice(pos + 1); pos = n; }
          else { if (attrs[attrName] === undefined) attrs[attrName] = html.slice(pos + 1, endQ); pos = endQ + 1; }
        } else {
          const vStart = pos;
          while (pos < n && !/\s/.test(html[pos]) && html[pos] !== '>') pos += 1;
          if (attrs[attrName] === undefined) attrs[attrName] = html.slice(vStart, pos);
        }
      } else {
        if (attrs[attrName] === undefined) attrs[attrName] = '';
      }
    }
    tags.push({ name, attrs });
    if (!closed) break;
    i = pos;
    // Raw-text elements: browsers scan no tags inside <script>/<style>, so the
    // checker must not either — a JS string like '<img src="https://…">' in
    // inline script does not load anything, and an unterminated quote inside
    // raw text must not abort the scan of the rest of the document.
    if (closed && (name === 'script' || name === 'style')) {
      const rest = html.slice(i);
      const closeRe = new RegExp('</' + name + '\\s*>', 'i');
      const found = closeRe.exec(rest);
      if (!found) break;
      i += found.index + found[0].length;
    }
  }
  return tags;
}

/**
 * Every candidate URL of a srcset: split on commas, take the URL before the
 * width/density descriptor.
 */
function srcsetUrls(srcset) {
  return String(srcset)
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * CSS text must not pull an absolute URL: no url(<absolute>) and no @import of
 * an absolute URL in quoted, unquoted or url() form (the url() form is caught
 * by the url() scan itself).
 */
function cssViolations(css) {
  const out = [];
  const urlRe = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
  let m;
  while ((m = urlRe.exec(css)) !== null) {
    const url = m[2].trim();
    if (url && isAbsoluteUrl(url)) out.push(`url(${url})`);
  }
  const importRe = /@import\s*([^;{}]+)/gi;
  while ((m = importRe.exec(css)) !== null) {
    if (/url\(/i.test(m[1])) continue;
    const token = m[1].trim().split(/\s+/)[0].replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (token && isAbsoluteUrl(token)) out.push(`@import ${token}`);
  }
  return out;
}

/** Absolute third-party loads via resource tags (script/link/img/source/iframe/video/audio/track/embed/object). */
function tagViolations(html) {
  const out = [];
  for (const { name, attrs } of scanTags(html)) {
    for (const attr of LOADED_ATTRS[name] || []) {
      if (attrs[attr] === undefined) continue;
      const candidates = attr === 'srcset' ? srcsetUrls(attrs[attr]) : [attrs[attr]];
      for (const url of candidates) {
        if (!url || !isAbsoluteUrl(url)) continue;
        if (name === 'link') {
          const rel = (attrs.rel || '').toLowerCase();
          if (rel === 'canonical' || rel === 'alternate') {
            if (hostOf(url) !== OWN_HOST) {
              out.push(`<link rel="${rel}"> href ${url} — must point at ${OWN_HOST} only`);
            }
            continue;
          }
        }
        out.push(`<${name} ${attr}> loads absolute third-party URL ${url}`);
      }
    }
  }
  return out;
}

/** Absolute URLs inside inline style="…" attributes and <style> blocks. */
function cssInHtmlViolations(html) {
  const out = [];
  for (const { name, attrs } of scanTags(html)) {
    if (attrs.style) {
      for (const v of cssViolations(attrs.style)) out.push(`<${name} style> loads ${v}`);
    }
  }
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html)) !== null) {
    for (const v of cssViolations(m[1])) out.push(`<style> block loads ${v}`);
  }
  return out;
}

const htmlViolations = (html) => [...tagViolations(html), ...cssInHtmlViolations(html)];

/* --------------------------------------------------------------- fixtures */

/**
 * The checker must not be tautological: every fixture here exploits a blind
 * spot of the old `<tag [^>]*>` regex scan (or of quoted-only attribute
 * parsing) and MUST be flagged — for the right reason, i.e. the violation must
 * name the expected third-party URL. The control fixture is first-party only
 * and must stay clean.
 */
const MUST_FLAG = [
  { name: 'script with unquoted absolute src', html: '<script src=https://x.example/a.js></script>', expect: 'https://x.example/a.js' },
  { name: 'img with third-party srcset candidate', html: '<img srcset="/a.png 1x, https://x.example/b.png 2x">', expect: 'https://x.example/b.png' },
  { name: 'img whose quoted alt contains > before a third-party src', html: '<img alt="a>b" src="https://x.example/c.png">', expect: 'https://x.example/c.png' },
  { name: 'iframe with unquoted protocol-relative src', html: '<iframe src=//x.example></iframe>', expect: '//x.example' },
  { name: 'source with third-party srcset candidate', html: '<source srcset="/a.webp 1x, https://x.example/b.webp 2x">', expect: 'https://x.example/b.webp' },
  { name: 'video with absolute poster', html: '<video poster="https://x.example/p.jpg"></video>', expect: 'https://x.example/p.jpg' },
  { name: 'object with absolute data', html: '<object data="https://x.example/o"></object>', expect: 'https://x.example/o' },
  { name: 'audio with protocol-relative src', html: '<audio src="//x.example/a"></audio>', expect: '//x.example/a' },
  { name: 'track with protocol-relative src', html: '<track src="//x.example/t">', expect: '//x.example/t' },
  { name: 'embed with protocol-relative src', html: '<embed src="//x.example/e">', expect: '//x.example/e' },
  { name: 'inline style attribute with absolute url()', html: '<div style="background: url(https://x.example/bg.png)"></div>', expect: 'https://x.example/bg.png' },
  { name: 'style block with absolute url()', html: '<style>@font-face{src:url(https://x.example/f.woff2)}</style>', expect: 'https://x.example/f.woff2' },
  { name: 'standalone CSS with absolute url()', css: 'body{background:url(https://x.example/f.woff2)}', expect: 'https://x.example/f.woff2' },
  { name: 'standalone CSS with @import of an absolute URL', css: '@import "//x.example/x.css";', expect: '//x.example/x.css' },
];

const CONTROL = {
  name: 'control — first-party relative URLs only',
  html: '<link rel="canonical" href="/x"><script src="/docs.js"></script>'
    + '<img src="/screens/a.png" srcset="/a.png 1x, /b.png 2x">'
    + '<iframe src="/f"></iframe><video poster="/p.jpg"><source src="/v.webp" srcset="/v.webp 1x"></video>'
    + '<audio src="/a.mp3"></audio><track src="/t.vtt"><embed src="/e.svg"><object data="/o.swf"></object>'
    + '<div style="background:url(/bg.png)"></div><style>p{background:url(/bg.png)}</style>',
};

/* ------------------------------------------------------------- real files */

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

test('no public html file loads a third-party resource (full tag set, quoted+unquoted attrs, every srcset candidate)', () => {
  assert.ok(HTML_FILES.length > 0, 'expected html files under public/');
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    const violations = tagViolations(html);
    assert.deepEqual(violations, [], `${rel} must not load any third-party resource`);
  }
});

test('no public html file pulls an absolute URL via inline style or <style> block', () => {
  assert.ok(HTML_FILES.length > 0, 'expected html files under public/');
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    assert.deepEqual(cssInHtmlViolations(html), [], `${rel} must not reference absolute URLs in CSS`);
  }
});

test('no public css file pulls an absolute URL via url() or @import', () => {
  assert.ok(CSS_FILES.length > 0, 'expected css files under public/');
  for (const file of CSS_FILES) {
    const css = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC_DIR, file);
    assert.deepEqual(cssViolations(css), [], `${rel} must not reference absolute URLs`);
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

/* ------------------------------------------------- checker self-evidence */

test('the checker is not tautological: every blind-spot fixture is flagged, the control is clean', () => {
  for (const f of MUST_FLAG) {
    const violations = f.css ? cssViolations(f.css) : htmlViolations(f.html);
    assert.ok(
      violations.length > 0 && violations.some((v) => v.includes(f.expect)),
      `fixture "${f.name}" must be flagged for ${f.expect}, got: ${JSON.stringify(violations)}`,
    );
  }
  assert.deepEqual(htmlViolations(CONTROL.html), [], `fixture "${CONTROL.name}" must not be flagged`);
});

/* ------------------------------------------------------ server shell (d) */

test('server-rendered shell() makes no third-party request (required without DB, without network)', () => {
  // No database: DATABASE_URL is removed so db.js constructs its pool lazily
  // and never connects. No network is needed — verified: nothing in the
  // require chain dials out. PUBLIC_URL mirrors production so the canonical
  // link is actually rendered and scanned.
  delete process.env.DATABASE_URL;
  process.env.PUBLIC_URL = 'https://mailmint.app.mintapis.com';
  let web;
  try {
    web = require('../src/web.js');
  } catch (e) {
    assert.fail(`src/web.js must be requirable without DATABASE_URL and without network; threw: ${e.constructor.name}: ${e.message}`);
  }
  assert.equal(typeof web.shell, 'function', 'src/web.js must export shell()');
  const html = web.shell('Docs — MailMint', '<p>x</p>', { index: true, canonical: '/docs/reference' });
  // Prove the shell really rendered the pieces being scanned — otherwise a
  // pass on an empty string would be an empty tautology.
  assert.ok(
    html.includes('rel="canonical" href="https://mailmint.app.mintapis.com/docs/reference"'),
    'the canonical link must be rendered',
  );
  assert.ok(/<style\b/.test(html), 'app.css must be inlined into a <style> block');
  assert.ok(/<script\b/.test(html), 'the copy-button script must be present');
  assert.ok(html.includes('Impressum'), 'the legal footer must be present');
  assert.deepEqual(tagViolations(html), []);
  assert.deepEqual(cssInHtmlViolations(html), []);
});
