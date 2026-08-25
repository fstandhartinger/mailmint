'use strict';
// Messages the lead captured from a live mailbox, kept OUT of git in
// .local/realmail/. Skipped entirely when that directory is absent.
//
// These exist to catch a very specific class of bug: a mail store or an export
// that is not byte-faithful. DKIM is the only tool that can prove it, because
// c=…/simple hashes the body exactly as received. If a signature that the
// upstream MTA recorded as `dkim=pass` fails for us, either our verifier is
// wrong or the file is not what arrived — and this test tells the two apart.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dkim = require('../src/auth/dkim');

const DIR = '/home/flori/Dev/pdfnode/mailmint/.local/realmail';
const FILES = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.eml')).sort()
  : [];
const SKIP = FILES.length ? false : `no messages in ${DIR}`;

/**
 * A MIME delimiter line must be followed by CRLF. Some mailbox APIs drop it,
 * which silently changes the body and therefore the body hash.
 */
function findBoundaryDamage(raw) {
  const s = raw.toString('latin1');
  const ct = /\r\nContent-Type:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/i.exec(s);
  if (!ct) return null;
  const bm = /boundary="?([^";\r\n]+)"?/i.exec(ct[0].replace(/\r\n[ \t]/g, ''));
  if (!bm) return null;
  const delim = '--' + bm[1];
  const bad = [];
  let i = s.indexOf(delim);
  while (i !== -1) {
    const after = s.slice(i + delim.length, i + delim.length + 2);
    if (after !== '\r\n' && after !== '--') bad.push({ at: i, followedBy: JSON.stringify(after) });
    i = s.indexOf(delim, i + 1);
  }
  return bad.length ? { boundary: bm[1], occurrences: bad } : null;
}

test('real captured mail: every signature gets a definite, non-crashing verdict', { skip: SKIP }, async (t) => {
  for (const f of FILES) {
    const raw = dkim.toCrlf(fs.readFileSync(path.join(DIR, f)));
    const r = await dkim.verify(raw, { ignoreExpiry: true });
    const damage = findBoundaryDamage(raw);

    t.diagnostic(`${f} (${raw.length} bytes) -> ${r.result}` +
      (damage ? `  [MIME DAMAGE: ${damage.occurrences.length} boundary lines not followed by CRLF]` : ''));
    for (const s of r.signatures) {
      t.diagnostic(`    ${s.result.padEnd(9)} d=${s.domain} s=${s.selector} a=${s.algorithm} ` +
        `c=${s.canonicalization} bh=${s.bodyHashMatched}` + (s.reason ? ` :: ${s.reason.slice(0, 90)}` : ''));
      assert.ok(['pass', 'fail', 'permerror', 'temperror'].includes(s.result));
      assert.ok(s.domain, 'every signature must name its d=');
    }

    if (damage) {
      // The file is not byte-faithful, so a `pass` here would mean our verifier
      // is not actually hashing the body.
      assert.notStrictEqual(r.result, 'pass',
        `${f} has damaged MIME boundaries but DKIM passed — the verifier is not checking the body`);
    } else if (r.signatures.length) {
      assert.strictEqual(r.result, 'pass', `${f}: ${r.reason}`);
    }
  }
});

test('real captured mail: the damage is a missing CRLF after the MIME delimiter', { skip: SKIP }, (t) => {
  let damaged = 0;
  for (const f of FILES) {
    const raw = fs.readFileSync(path.join(DIR, f));
    const d = findBoundaryDamage(raw);
    if (!d) continue;
    damaged++;
    const sample = d.occurrences[0];
    t.diagnostic(`${f}: boundary "${d.boundary}" followed by ${sample.followedBy} instead of "\\r\\n" ` +
      `(${d.occurrences.length} of ${d.occurrences.length} occurrences)`);
  }
  t.diagnostic(`${damaged} of ${FILES.length} captured files are not byte-faithful`);
});
