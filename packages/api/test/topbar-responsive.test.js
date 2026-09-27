'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

/**
 * The signed-in header at a 390 px viewport: "Sign out" must not wrap onto
 * two lines and the logo must not touch the Review link. The fix is CSS only —
 * nowrap on the nav's links and button at all widths, and a wrapping, gapped
 * header below 680 px. The desktop layout is asserted to stay untouched by
 * only ever adding rules.
 */

let account;

before(async () => {
  await H.start();
  account = await H.newAccount();
});
after(H.stop);

const css = () => fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Every `selector{declarations}` rule in the sheet; @media wrappers are skipped. */
const rules = (text) => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ selector: m[1], body: m[2] });
  return out;
};

/** The inner content of every `@media (max-width:680px){ ... }` block. */
const media680Blocks = (text) => {
  const blocks = [];
  const re = /@media\s*\(\s*max-width\s*:\s*680px\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return blocks;
};

/**
 * True when some rule in the sheet (or, with `media`, inside one of the
 * 680 px media blocks) has a selector list covering ALL of `selectors` and
 * declares every pattern in `decls`.
 */
const ruleCovers = (text, { selectors, decls, media = false }) => {
  const scopes = media ? media680Blocks(text) : [text];
  for (const scope of scopes) {
    for (const { selector, body } of rules(scope)) {
      const parts = selector.split(',').map(norm);
      if (!selectors.every((s) => parts.includes(norm(s)))) continue;
      if (decls.every((d) => d.test(body))) return true;
    }
  }
  return false;
};

test('nav links and the Sign out button never wrap, at any width', () => {
  assert.ok(ruleCovers(css(), {
    selectors: ['.topbar nav a', '.topbar nav button'],
    decls: [/white-space\s*:\s*nowrap/],
  }), 'app.css has a rule whose selector list covers .topbar nav a and .topbar nav button with white-space:nowrap');
});

test('below 680 px the header and its nav wrap with a gap', () => {
  const sheet = css();
  assert.ok(ruleCovers(sheet, {
    media: true,
    selectors: ['.topbar'],
    decls: [/flex-wrap\s*:\s*wrap/, /(^|;)\s*gap\s*:/],
  }), 'inside @media (max-width:680px) .topbar has flex-wrap:wrap and a gap declaration');
  assert.ok(ruleCovers(sheet, {
    media: true,
    selectors: ['.topbar nav'],
    decls: [/flex-wrap\s*:\s*wrap/, /(^|;)\s*gap\s*:/],
  }), 'inside @media (max-width:680px) .topbar nav has flex-wrap:wrap and a gap declaration');
});

test('the signed-in dashboard renders the full topbar', async () => {
  const { res, text } = await H.req('/dashboard', { cookie: account.cookie });
  assert.equal(res.status, 200);
  assert.ok(text.includes('<header class="topbar">'), 'the topbar header is present');
  assert.ok(text.includes('<a href="/dashboard/review">Review'), 'the Review link is present');
  assert.ok(text.includes('<a href="/docs">Docs'), 'the Docs link is present');
  assert.ok(text.includes('<a href="/docs/reference">Reference'), 'the Reference link is present');
  const nav = /<nav>[\s\S]*?<\/nav>/.exec(text);
  assert.ok(nav, 'the topbar nav is present');
  assert.ok(/<button[^>]*>Sign out<\/button>/.test(nav[0]), 'the Sign out button is inside the nav');
});
