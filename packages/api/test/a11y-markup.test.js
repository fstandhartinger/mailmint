'use strict';

/**
 * A11y markup guards — PRD C7 + C8.
 *
 * No database needed: these tests read the static public HTML files and the
 * dashboard templates in src/web.js as text and assert the structural rules
 * the axe run on the live site found broken:
 *
 *  - every role="tab" carries aria-selected and aria-controls,
 *  - a role="tablist" contains only tabs as direct children (the landing
 *    page's copy button used to sit inside the tablist),
 *  - every aria-controls target exists on the page,
 *  - app.css defines .table-scroll with overflow-x (C7: tables scroll inside
 *    a keyboard-reachable wrapper instead of widening the page at 390 px),
 *  - every table.rows rendered by web.js sits inside such a wrapper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WEB_JS = path.join(__dirname, '..', 'src', 'web.js');

const HTML_FILES = fs.readdirSync(PUBLIC_DIR).filter((n) => n.endsWith('.html'));

/** Content between a tablist's opening tag and its matching closing tag. */
function tablistInner(html, openTagEnd) {
  let depth = 1;
  let i = openTagEnd;
  while (i < html.length) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close === -1) throw new Error('unbalanced divs after tablist');
    if (open !== -1 && open < close) {
      depth += 1;
      i = open + 4;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(openTagEnd, close);
      i = close + 6;
    }
  }
  throw new Error('unbalanced divs after tablist');
}

test('every public page: role="tab" elements carry aria-selected and aria-controls', () => {
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const tabs = [...html.matchAll(/<(?:button|a)\b[^>]*\brole="tab"[^>]*>/g)];
    for (const m of tabs) {
      assert.match(m[0], /aria-selected="(?:true|false)"/, `${file}: tab lacks aria-selected: ${m[0]}`);
      assert.match(m[0], /aria-controls="\S+"/, `${file}: tab lacks aria-controls: ${m[0]}`);
    }
  }
});

test('every public page: tablists contain only tabs as direct children', () => {
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const tablists = [...html.matchAll(/<div\b[^>]*\brole="tablist"[^>]*>/g)];
    for (const list of tablists) {
      const inner = tablistInner(html, list.index + list[0].length);
      const tabs = [...inner.matchAll(/<(?:button|a)\b[^>]*\brole="tab"[^>]*>[\s\S]*?<\/(?:button|a)>/g)];
      assert.ok(tabs.length > 0, `${file}: tablist has no tabs`);
      let lastEnd = 0;
      for (const t of tabs) {
        const between = inner.slice(lastEnd, t.index);
        assert.ok(!between.includes('<'),
          `${file}: non-tab element inside tablist before a tab: ${JSON.stringify(between.trim().slice(0, 80))}`);
        lastEnd = t.index + t[0].length;
      }
      const after = inner.slice(lastEnd);
      assert.ok(!after.includes('<'),
        `${file}: non-tab element inside tablist after the last tab: ${JSON.stringify(after.trim().slice(0, 80))}`);
    }
  }
});

test('every public page: each tab aria-controls points at an existing element', () => {
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const m of html.matchAll(/<(?:button|a)\b[^>]*\brole="tab"[^>]*>/g)) {
      const target = /aria-controls="([^"]+)"/.exec(m[0])[1];
      assert.ok(html.includes(`id="${target}"`), `${file}: tab points at missing id "${target}"`);
    }
  }
});

test('app.css defines .table-scroll with overflow-x (C7)', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8');
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x\s*:\s*auto/,
    'app.css must define .table-scroll with overflow-x:auto');
});

test('web.js: every table.rows is wrapped in a labelled, focusable .table-scroll (C7)', () => {
  const src = fs.readFileSync(WEB_JS, 'utf8');
  const tables = [...src.matchAll(/<table class="rows">/g)];
  assert.ok(tables.length > 0, 'expected at least one table.rows in web.js');
  for (const m of tables) {
    const before = src.slice(0, m.index);
    const wrapperStart = before.lastIndexOf('<div class="table-scroll"');
    assert.notEqual(wrapperStart, -1, 'table.rows not wrapped in .table-scroll');
    const wrapper = src.slice(wrapperStart, m.index);
    const afterOpen = wrapper.replace(/^<div class="table-scroll"[^>]*>/, '');
    assert.ok(!afterOpen.includes('<'), 'unexpected markup between .table-scroll and the table');
    assert.match(wrapper, /tabindex="0"/, 'table-scroll wrapper must be keyboard focusable');
    assert.match(wrapper, /aria-label="[^"]+"/, 'table-scroll wrapper must name the table');
  }
});
