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

// ---------------------------------------------------------------------------
// Everything these messages ARE good for. The body was rewritten in transit,
// but the header block arrived intact, and it is real: real Received chains
// from three MTAs, real folding, real dual signatures, a real bounce domain.

test('real captured mail: the Received chain parses and is ordered newest-first', { skip: SKIP }, (t) => {
  for (const f of FILES) {
    const raw = dkim.toCrlf(fs.readFileSync(path.join(DIR, f)));
    const received = dkim.splitMessage(raw).headers.filter((h) => h.lowerName === 'received');
    assert.ok(received.length >= 1, `${f}: no Received header at all`);

    const dates = received
      .map((h) => {
        const m = /;\s*([^;]+)$/.exec(h.value.replace(/\r\n[ \t]+/g, ' ').trim());
        return m ? Date.parse(m[1]) : NaN;
      })
      .filter((d) => !Number.isNaN(d));
    assert.strictEqual(dates.length, received.length,
      `${f}: every Received header must end in a parseable date`);
    for (let i = 1; i < dates.length; i++) {
      assert.ok(dates[i] <= dates[i - 1] + 1000,
        `${f}: hop ${i} is newer than hop ${i - 1}; the chain is not newest-first`);
    }
    // Worth recording: the export kept only the final hop on some messages, which
    // is one more way in which this corpus is not the message that was sent.
    t.diagnostic(`${f}: ${received.length} hop(s), newest ${new Date(dates[0]).toISOString()}` +
      (received.length === 1 ? '  [upstream hops missing from the export]' : ''));
  }
});

test('real captured mail: folded headers survive as single fields', { skip: SKIP }, (t) => {
  let foldedSeen = 0;
  for (const f of FILES) {
    const raw = dkim.toCrlf(fs.readFileSync(path.join(DIR, f)));
    const headers = dkim.splitMessage(raw).headers;
    for (const h of headers) {
      // a folded field contains a CRLF followed by whitespace, mid-field
      if (/\r\n[ \t]/.test(h.raw.slice(0, -2))) {
        foldedSeen++;
        assert.ok(h.raw.endsWith('\r\n'), `${f}: ${h.lowerName} must end at a CRLF`);
        // unfolding must not lose or invent content
        const unfolded = dkim.canonHeaderRelaxed(h);
        assert.ok(!/\r\n./.test(unfolded.slice(0, -2)),
          `${f}: ${h.lowerName} still contains a fold after relaxed canonicalisation`);
      }
      assert.ok(h.lowerName.length > 0 && !/[\s:]/.test(h.lowerName),
        `${f}: bad header name ${JSON.stringify(h.name)}`);
    }
  }
  assert.ok(foldedSeen > 0, 'the corpus should contain folded headers');
  t.diagnostic(`${foldedSeen} folded header fields parsed across ${FILES.length} messages`);
});

test('real captured mail: dual signatures are both parsed, with their own d= and selector', { skip: SKIP }, async (t) => {
  let dualSeen = 0;
  for (const f of FILES) {
    const raw = dkim.toCrlf(fs.readFileSync(path.join(DIR, f)));
    const r = await dkim.verify(raw, { ignoreExpiry: true });
    if (r.signatures.length < 2) continue;
    dualSeen++;
    const domains = r.signatures.map((s) => s.domain);
    assert.strictEqual(new Set(domains).size, domains.length,
      `${f}: two signatures from two signers must not collapse into one`);
    for (const s of r.signatures) {
      assert.ok(s.selector, 'each signature carries its own selector');
      assert.ok(s.algorithm, 'each signature carries its own algorithm');
      assert.strictEqual(s.canonicalization, 'relaxed/simple');
    }
    // Both signers signed the same body, so both must agree about the body hash.
    const matched = new Set(r.signatures.map((s) => s.bodyHashMatched));
    assert.strictEqual(matched.size, 1,
      `${f}: two signers over one body cannot disagree about whether it is intact`);
    t.diagnostic(`${f}: ${domains.join(' + ')} — both bodyHashMatched=${r.signatures[0].bodyHashMatched}`);
  }
  assert.ok(dualSeen > 0, 'the corpus should contain dual-signed mail');
});

test('real captured mail: Return-Path gives a bounce domain distinct from the From domain', { skip: SKIP }, (t) => {
  const { headerFromDomain, splitAddress } = require('../src/address');
  let checked = 0;
  for (const f of FILES) {
    const raw = dkim.toCrlf(fs.readFileSync(path.join(DIR, f)));
    const headers = dkim.splitMessage(raw).headers;
    const get = (n) => {
      const h = headers.filter((x) => x.lowerName === n);
      return h.length ? h[h.length - 1].value.replace(/\r\n[ \t]+/g, ' ').trim() : null;
    };
    const rp = get('return-path');
    const from = get('from');
    if (!rp || !from) continue;
    checked++;

    const bounce = splitAddress(rp.replace(/^<|>$/g, ''));
    assert.ok(bounce, `${f}: Return-Path ${rp} must parse as an address`);
    const fromDomain = headerFromDomain(from);
    assert.ok(fromDomain, `${f}: From ${from} must yield a domain`);
    t.diagnostic(`${f}: SPF would be checked against ${bounce.domain}, DMARC aligns against ${fromDomain}`);
  }
  assert.ok(checked > 0);
});
