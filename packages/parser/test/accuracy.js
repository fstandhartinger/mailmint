'use strict';
/**
 * Accuracy harness.
 *
 * Runs the hand-labelled corpus through parseMessage and reports field-level
 * precision and recall, mean confidence, latency, how often the LLM was needed,
 * and — the number that matters most for the product claim — a CALIBRATION
 * table: for every confidence bucket, how often the value in it was actually
 * right. A confidence score nobody has checked is decoration.
 *
 *   node test/accuracy.js              full pipeline (rules, then one LLM call)
 *   node test/accuracy.js --no-llm     deterministic layer only
 *   node test/accuracy.js --only=fx-01 run a subset
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseMessage } = require('../src/index');
const { coerce } = require('../src/coerce');
const { labels } = require('./labels');

const argv = process.argv.slice(2);
const USE_LLM = !argv.includes('--no-llm');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const CORPUS = path.join(__dirname, 'corpus');
const JSON_OUT = (argv.find((a) => a.startsWith('--json=')) || '').slice(7);

function resolveFile(f) { return path.isAbsolute(f) ? f : path.join(CORPUS, f); }

/** Compare an extracted value with the hand label, on meaning not surface form. */
function matches(got, want, field) {
  if (want === null || want === undefined) return got === null || got === undefined;
  if (got === null || got === undefined) return false;
  const norm = (v) => {
    const c = coerce(v, field, {});
    const x = c.ok && c.value !== null ? c.value : v;
    return typeof x === 'string' ? x.trim().toLowerCase().replace(/\s+/g, ' ') : x;
  };
  const a = norm(got), b = norm(want);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((el, i) => deepish(el, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') return deepish(a, b);
  return String(a) === String(b);
}

function deepish(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');
  }
  const ka = Object.keys(b);
  return ka.every((k) => deepish(a[k], b[k]));
}

function derived(d, field) {
  if (!d) return null;
  return d.rows;
}

function bucketOf(c) {
  if (c >= 0.9) return '0.9-1.0';
  if (c >= 0.7) return '0.7-0.9';
  if (c >= 0.5) return '0.5-0.7';
  return '0.0-0.5';
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function pct(n, d) { return d === 0 ? '  n/a' : padL((100 * n / d).toFixed(1) + '%', 6); }

async function main() {
  const rows = [];
  const perField = new Map();
  const buckets = new Map();
  const bySource = new Map();
  const missingFiles = [];
  let llmCount = 0, total = 0, latencySum = 0, confSum = 0, confN = 0;
  let typeRight = 0, typeTotal = 0, ruleFields = 0, allFields = 0;

  for (const L of labels) {
    const file = resolveFile(L.file);
    if (ONLY && !file.includes(ONLY)) continue;
    if (!fs.existsSync(file)) { missingFiles.push(L.file); continue; }
    const buf = fs.readFileSync(file);
    const t0 = Date.now();
    const r = await parseMessage(buf, { schema: L.schema, llm: USE_LLM, quiet: true });
    const ms = Date.now() - t0;
    total++; latencySum += ms;
    if (r.parse.llm_used) llmCount++;
    if (L.type) { typeTotal++; if (r.detected.type === L.type) typeRight++; }

    const detail = [];
    for (const f of L.schema) {
      if (L.skipScore && L.skipScore.includes(f.name)) continue;
      const got = r.fields[f.name] || { value: null, confidence: 0, source: 'none' };
      const want = L.expected[f.name] === undefined ? null : L.expected[f.name];
      const ok = matches(got.value, want, f);
      allFields++;
      if (got.source === 'rule' || got.source === 'header') ruleFields++;

      const key = f.name;
      if (!perField.has(key)) perField.set(key, { tp: 0, fp: 0, fn: 0, tn: 0, conf: 0, n: 0 });
      const s = perField.get(key);
      if (want === null) { if (ok) s.tn++; else s.fp++; }
      else if (got.value === null) s.fn++;
      else if (ok) s.tp++;
      else { s.fp++; s.fn++; }
      if (got.value !== null) { s.conf += got.confidence; s.n++; confSum += got.confidence; confN++; }

      if (got.value !== null) {
        const b = bucketOf(got.confidence);
        if (!buckets.has(b)) buckets.set(b, { right: 0, wrong: 0 });
        buckets.get(b)[ok ? 'right' : 'wrong']++;
        const src = got.source;
        if (!bySource.has(src)) bySource.set(src, { right: 0, wrong: 0, conf: 0 });
        const bs = bySource.get(src);
        bs[ok ? 'right' : 'wrong']++; bs.conf += got.confidence;
      }
      detail.push({ field: f.name, ok, got: got.value, want, confidence: got.confidence, source: got.source });
    }
    rows.push({ file: path.basename(file), kind: L.kind, ms, llm: r.parse.llm_used, model: r.parse.model,
      llm_ms: r.parse.timings_ms.llm, type: r.detected.type, want_type: L.type,
      flags: r.flags, detail });
  }

  // ------------------------------------------------------------------ report
  const mode = USE_LLM ? 'rules + LLM' : 'rules only (--no-llm)';
  console.log(`\nMailMint parser accuracy — ${mode}`);
  console.log(`corpus: ${total} labelled messages (${rows.filter((r) => r.kind === 'real').length} real, ${rows.filter((r) => r.kind === 'fixture').length} fixtures)`);
  if (missingFiles.length) console.log(`skipped (not present): ${missingFiles.map((f) => path.basename(f)).join(', ')}`);

  console.log('\nPer message');
  console.log(pad('file', 40) + padL('ms', 7) + padL('llm ms', 8) + '  llm  ' + pad('model', 26) + pad('type', 10) + 'fields');
  console.log('-'.repeat(120));
  for (const r of rows) {
    const okN = r.detail.filter((d) => d.ok).length;
    const typeMark = r.want_type ? (r.type === r.want_type ? r.type : `${r.type}!=${r.want_type}`) : r.type;
    console.log(pad(r.file.slice(0, 39), 40) + padL(r.ms, 7) + padL(r.llm_ms || 0, 8) + '  ' + pad(r.llm ? 'yes' : 'no', 5)
      + pad((r.model || '-').replace(/-TEE$/, '').slice(0, 25), 26) + pad(typeMark.slice(0, 9), 10)
      + `${okN}/${r.detail.length}`
      + (okN < r.detail.length ? '  ' + r.detail.filter((d) => !d.ok).map((d) => d.field).join(',') : ''));
  }

  console.log('\nPer field');
  console.log(pad('field', 24) + padL('TP', 4) + padL('FP', 4) + padL('FN', 4) + padL('TN', 4)
    + padL('prec', 8) + padL('recall', 8) + padL('mean conf', 11));
  console.log('-'.repeat(70));
  let TP = 0, FP = 0, FN = 0, TN = 0;
  for (const [name, s] of [...perField.entries()].sort()) {
    TP += s.tp; FP += s.fp; FN += s.fn; TN += s.tn;
    console.log(pad(name.slice(0, 23), 24) + padL(s.tp, 4) + padL(s.fp, 4) + padL(s.fn, 4) + padL(s.tn, 4)
      + pct(s.tp, s.tp + s.fp) + '  ' + pct(s.tp, s.tp + s.fn) + '  '
      + padL(s.n ? (s.conf / s.n).toFixed(3) : '-', 9));
  }
  console.log('-'.repeat(70));
  console.log(pad('TOTAL', 24) + padL(TP, 4) + padL(FP, 4) + padL(FN, 4) + padL(TN, 4)
    + pct(TP, TP + FP) + '  ' + pct(TP, TP + FN) + '  ' + padL(confN ? (confSum / confN).toFixed(3) : '-', 9));

  console.log('\nCalibration — is the confidence number honest?');
  console.log(pad('bucket', 12) + padL('n', 6) + padL('correct', 9) + padL('actual', 8));
  console.log('-'.repeat(36));
  for (const b of ['0.9-1.0', '0.7-0.9', '0.5-0.7', '0.0-0.5']) {
    const s = buckets.get(b);
    if (!s) { console.log(pad(b, 12) + padL(0, 6) + padL('-', 9) + padL('-', 8)); continue; }
    const n = s.right + s.wrong;
    console.log(pad(b, 12) + padL(n, 6) + padL(s.right, 9) + pct(s.right, n));
  }

  console.log('\nBy source');
  console.log(pad('source', 12) + padL('n', 6) + padL('correct', 9) + padL('mean conf', 11));
  console.log('-'.repeat(40));
  for (const [src, s] of [...bySource.entries()].sort()) {
    const n = s.right + s.wrong;
    console.log(pad(src, 12) + padL(n, 6) + pct(s.right, n) + '   ' + padL((s.conf / n).toFixed(3), 9));
  }

  // ---------------------------------------------------- line-item sources
  const { fromText, shapeRows } = require('../src/lineitems');
  const { deriveArrayFromTables } = require('../src/confidence');
  const { parseMime } = require('../src/index');
  const srcStats = { 'html-table': { hit: 0, partial: 0, none: 0 }, 'html-repeat': { hit: 0, partial: 0, none: 0 }, 'text-run': { hit: 0, partial: 0, none: 0 } };
  const arrayCases = [];
  for (const L of labels) {
    const file = resolveFile(L.file);
    if (ONLY && !file.includes(ONLY)) continue;
    if (!fs.existsSync(file)) continue;
    const field = L.schema.find((f) => f.type === 'array' && Array.isArray(L.expected[f.name]));
    if (!field) continue;
    const want = L.expected[field.name];
    const m = parseMime(fs.readFileSync(file));
    const ctx = { tables: m.tables, text: m.body.text, strippedText: m.body.stripped_text };
    const grid = m.tables.filter((t) => t.source === 'html' || t.source === 'text');
    const repeat = m.tables.filter((t) => t.source === 'html-repeat');
    const per = {};
    per['html-table'] = derived(deriveArrayFromTables(field, grid), field);
    per['html-repeat'] = derived(deriveArrayFromTables(field, repeat), field);
    const tr = fromText(ctx.strippedText || ctx.text, {});
    per['text-run'] = tr ? shapeRows(tr.rows, field.items && field.items.fields) : null;
    const row = { file: path.basename(file) };
    for (const [name, rows] of Object.entries(per)) {
      const st = srcStats[name];
      if (!rows) { st.none++; row[name] = '-'; continue; }
      const c = coerce(rows, field, {});          // same coercion the pipeline applies
      const got = c.ok && Array.isArray(c.value) ? c.value : rows;
      const exact = got.length === want.length && want.every((w, i) => deepish(got[i], w));
      if (exact) { st.hit++; row[name] = 'exact'; }
      else { st.partial++; row[name] = got.length === want.length ? `${got.length} rows, differs` : `${got.length}/${want.length}`; }
    }
    arrayCases.push(row);
  }
  if (arrayCases.length) {
    console.log('\nLine items — did each independent source find the complete row set?');
    console.log(pad('file', 40) + pad('html-table', 17) + pad('html-repeat', 17) + pad('text-run', 16));
    console.log('-'.repeat(90));
    for (const r of arrayCases) console.log(pad(r.file.slice(0, 39), 40) + pad(r['html-table'], 17) + pad(r['html-repeat'], 17) + pad(r['text-run'], 16));
    console.log('-'.repeat(90));
    console.log(pad('exact / differs / absent', 40)
      + pad(`${srcStats['html-table'].hit} / ${srcStats['html-table'].partial} / ${srcStats['html-table'].none}`, 17)
      + pad(`${srcStats['html-repeat'].hit} / ${srcStats['html-repeat'].partial} / ${srcStats['html-repeat'].none}`, 17)
      + pad(`${srcStats['text-run'].hit} / ${srcStats['text-run'].partial} / ${srcStats['text-run'].none}`, 16));
  }

  const latAvg = total ? Math.round(latencySum / total) : 0;
  const llmRows = rows.filter((r) => r.llm);
  const llmAvg = llmRows.length ? Math.round(llmRows.reduce((n, r) => n + (r.llm_ms || 0), 0) / llmRows.length) : 0;
  console.log('\nSummary');
  console.log(`  precision                 ${pct(TP, TP + FP).trim()}   (${TP} correct of ${TP + FP} values returned)`);
  console.log(`  recall                    ${pct(TP, TP + FN).trim()}   (${TP} found of ${TP + FN} values present)`);
  console.log(`  correct abstentions       ${TN}   (label says "not present" and we returned null)`);
  console.log(`  document type accuracy    ${pct(typeRight, typeTotal).trim()}   (${typeRight}/${typeTotal})`);
  console.log(`  mean confidence           ${confN ? (confSum / confN).toFixed(3) : '-'}`);
  console.log(`  mean latency              ${latAvg} ms per message`);
  console.log(`  mean LLM latency          ${llmAvg} ms (over the ${llmRows.length} messages that needed one)`);
  console.log(`  messages needing the LLM  ${pct(llmCount, total).trim()}   (${llmCount}/${total})`);
  console.log(`  fields answered by rules  ${pct(ruleFields, allFields).trim()}   (${ruleFields}/${allFields})`);
  console.log('');

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ mode, total, TP, FP, FN, TN, buckets: Object.fromEntries(buckets),
      bySource: Object.fromEntries(bySource), perField: Object.fromEntries(perField), rows, latAvg, llmAvg,
      llmCount, ruleFields, allFields, typeRight, typeTotal, meanConf: confN ? confSum / confN : null }, null, 1));
  }
}

// `node --test test/` treats every .js file in a test directory as a test file.
// This one makes live model calls, so it must never run that way by accident.
if (process.env.NODE_TEST_CONTEXT) {
  require('node:test')('accuracy harness (run it directly: node test/accuracy.js)', { skip: true }, () => {});
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
