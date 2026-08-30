'use strict';
/**
 * Pool several hold-out runs into one calibration table.
 *
 * A single run over 36 messages puts only a handful of values in the low
 * confidence buckets, and the model layer is not deterministic, so one run's
 * bottom two rows are noise dressed up as a measurement. This aggregates N
 * result files into one table and, for the headline rates, reports the spread
 * across runs as well as the pooled figure.
 *
 *   node test/holdout/score-pooled.js run1.json run2.json run3.json
 *
 * Scoring is identical to score.js — same eq(), same buckets — on purpose:
 * two scorers that disagree would make both numbers worthless.
 */
const fs = require('fs');
const path = require('path');
const hardLabels = JSON.parse(fs.readFileSync(path.join(__dirname, 'labels-hard.json'), 'utf8'));

function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v) && v.amount !== undefined) return v.amount;
  if (typeof v === 'string') return v.trim();
  return v;
}
function eq(got, want, name) {
  got = norm(got);
  if (want === null) return got === null;
  if (got === null) return false;
  if (typeof want === 'number') { const g = typeof got === 'number' ? got : parseFloat(String(got).replace(/[^0-9.\-]/g, '')); return Number.isFinite(g) && Math.abs(g - want) < 0.005; }
  if (name === 'currency') return String(got).toUpperCase() === String(want).toUpperCase();
  if (name === 'vendor' || name === 'carrier') { const a = String(got).toLowerCase().replace(/[^a-z0-9]/g, ''), b = String(want).toLowerCase().replace(/[^a-z0-9]/g, ''); return a.includes(b) || b.includes(a); }
  if (name === 'attachment_filename') return String(got).replace(/\s+/g, ' ') === String(want).replace(/\s+/g, ' ');
  return String(got).replace(/\s+/g, ' ').toLowerCase() === String(want).replace(/\s+/g, ' ').toLowerCase();
}
function bucketOf(c) { return c >= 0.9 ? '0.9-1.0' : c >= 0.7 ? '0.7-0.9' : c >= 0.6 ? '0.6-0.7' : '0.0-0.6'; }

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: score-pooled.js <results.json> [...]'); process.exit(2); }

const pooled = { '0.9-1.0': [], '0.7-0.9': [], '0.6-0.7': [], '0.0-0.6': [] };
const perRun = [];
const wrongAtHigh = new Map();   // how often a given (file,field) is wrong while reported >= 0.9
const flaky = new Map();         // (file,field) -> set of correctness outcomes

for (const f of files) {
  const R = JSON.parse(fs.readFileSync(f, 'utf8'));
  let TP = 0, FP = 0, FN = 0, abstain = 0, slots = 0, confSum = 0, confN = 0;
  const lat = [];
  for (const r of R) {
    if (r.out.__crash) continue;
    lat.push(r.ms);
    for (const [name, want] of Object.entries(r.labels)) {
      if (name === 'line_items_count') continue;
      slots++;
      const fl = r.out.fields[name];
      const got = fl ? fl.value : null;
      const returned = got !== null && got !== undefined;
      const ok = eq(got, want, name);
      if (want === null) { if (!returned) abstain++; else FP++; }
      else if (!returned) FN++;
      else if (ok) TP++;
      else { FP++; FN++; }
      if (returned && fl) {
        pooled[bucketOf(fl.confidence)].push(ok ? 1 : 0);
        confSum += fl.confidence; confN++;
        const key = r.file + ' :: ' + name;
        if (!flaky.has(key)) flaky.set(key, new Set());
        flaky.get(key).add(ok);
        if (fl.confidence >= 0.9 && !ok) wrongAtHigh.set(key, (wrongAtHigh.get(key) || 0) + 1);
      }
    }
  }
  lat.sort((a, b) => a - b);
  perRun.push({ file: path.basename(f), slots, TP, FP, FN, abstain,
    P: TP + FP ? TP / (TP + FP) : 0, R: TP + FN ? TP / (TP + FN) : 0,
    meanConf: confN ? confSum / confN : 0,
    latMean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
    latMedian: lat[Math.floor(lat.length / 2)] });
}

const f1 = (x) => (100 * x).toFixed(1) + '%';
console.log(`Pooled over ${files.length} run(s), 36 messages each.\n`);
console.log('-- PER RUN --');
for (const r of perRun) console.log(`${r.file.padEnd(16)} slots=${r.slots} TP=${r.TP} FP=${r.FP} FN=${r.FN} abst=${r.abstain}  P=${f1(r.P)} R=${f1(r.R)}  meanconf=${r.meanConf.toFixed(3)}  lat mean=${r.latMean}ms median=${r.latMedian}ms`);
const P = perRun.map((r) => r.P), Rr = perRun.map((r) => r.R);
const agg = (xs) => `${f1(Math.min(...xs))} – ${f1(Math.max(...xs))} (mean ${f1(xs.reduce((a, b) => a + b, 0) / xs.length)})`;
console.log(`\nprecision across runs: ${agg(P)}`);
console.log(`recall    across runs: ${agg(Rr)}`);

console.log('\n-- POOLED CALIBRATION --');
let n = 0, c = 0;
for (const [k, v] of Object.entries(pooled)) {
  if (!v.length) { console.log(`${k}  n=0`); continue; }
  const ok = v.reduce((a, b) => a + b, 0);
  n += v.length; c += ok;
  console.log(`${k}  n=${String(v.length).padStart(4)}  correct=${String(ok).padStart(4)}  actual=${(100 * ok / v.length).toFixed(1)}%`);
}
console.log(`total    n=${n}  correct=${c}`);

console.log('\n-- WRONG WHILE REPORTED >= 0.9 (per field, count of runs) --');
for (const [k, v] of [...wrongAtHigh].sort((a, b) => b[1] - a[1])) console.log(`${v}/${files.length}  ${k}`);

console.log('\n-- NOT STABLE ACROSS RUNS (right in one run, wrong in another) --');
for (const [k, v] of flaky) if (v.size > 1) console.log(`  ${k}`);
