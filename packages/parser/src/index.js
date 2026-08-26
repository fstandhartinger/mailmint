'use strict';
const crypto = require('node:crypto');
const { parseStructure, buildHeaders } = require('./mime');
const { htmlToText, extractHtmlTables, extractRepeatTables, extractLinks } = require('./html');
const { extractTextTables } = require('./tables');
const { strippedText } = require('./strip');
const { detect, toContractShape } = require('./detect');
const { detectLanguage } = require('./language');
const { ruleExtract } = require('./rules');
const { coerce } = require('./coerce');
const { llmExtract } = require('./extract-llm');
const { normaliseLogger, makeLogger } = require('./log');
const { computeConfidence, corroborates, sameValue, reconcile, deriveArrayFromTables, toAmount } = require('./confidence');
const { pickLineItems, rowsEqual } = require('./lineitems');
const { verify, surfacesOf: evidenceSurfaces, spanFor } = require('./evidence');
const { localeHint } = require('./dates');

/**
 * MailMint parser. Turns an RFC822 buffer into the canonical object of
 * docs/CONTRACT.md §1.
 *
 * Layer (a) is deterministic and always runs. Layer (b) is one LLM call, and
 * only for the schema fields layer (a) could not settle at >= 0.9 confidence.
 * That ordering is the whole cost model of the product: templated mail is
 * mostly solved by labels, and the model is there for the rest.
 */

/** The shared LLM client lives outside the workspace; resolve it lazily so the
 *  package still loads (and parseMime still works) where it is absent. */
let _complete = null;
function sharedComplete() {
  if (_complete) return _complete;
  const tries = ['../../../../shared/llm', '../../../shared/llm', 'pdfnode-shared/llm'];
  for (const t of tries) {
    try { _complete = require(t).complete; return _complete; } catch { /* next */ }
  }
  throw new Error('no LLM client available: pass options.complete');
}

const VERIFIED = 0.9;         // above this, two independent extractors must have agreed
const LOW_CONFIDENCE = 0.6;   // §4 — inclusive: 0.60 exactly is low, not fine

/** Deterministic-only parse. No network, no clock-dependent behaviour. */
function parseMime(input) {
  const st = parseStructure(input);
  const headers = buildHeaders(st.pairs);
  const html = st.html || null;
  const textFromHtml = html ? htmlToText(html) : null;
  const text = st.text || textFromHtml || '';
  const strip = strippedText(text);

  const tables = [];
  if (html) {
    for (const t of extractHtmlTables(html)) tables.push({ ...t, index: tables.length });
    // Repeating-structure groups: the only source that sees line items in the
    // nested-single-cell-table HTML every ESP actually sends.
    for (const t of extractRepeatTables(html, tables.length)) tables.push({ ...t, index: tables.length });
  }
  for (const t of textTablesIncludingQuoted(st.text || '')) tables.push({ ...t, index: tables.length });

  return {
    headers,
    body: {
      text,
      html,
      text_from_html: textFromHtml,
      stripped_text: strip.text,
      language: detectLanguage(strip.text || text),
    },
    attachments: st.attachments,
    tables,
    warnings: st.warnings,
    _strip: strip,
    _links: html ? extractLinks(html) : [],
  };
}

/**
 * Text tables, including any that live inside the quoted reply.
 *
 * A quoted table is still a table in this message, and it is sometimes the only
 * complete one: `ho-hard-08` splits a six-row invoice across two mails, three
 * rows visible and three behind `> `. Stripping the quote — which is right for
 * nearly everything else — loses half the invoice.
 */
function textTablesIncludingQuoted(text) {
  const out = extractTextTables(text);
  const seen = new Set(out.map((t) => JSON.stringify([t.headers, t.rows])));
  const dequoted = String(text || '').split('\n').map((l) => l.replace(/^\s*(?:>\s?)+/, '')).join('\n');
  if (dequoted !== text) {
    for (const t of extractTextTables(dequoted)) {
      const sig = JSON.stringify([t.headers, t.rows]);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ ...t, quoted: true });
    }
  }
  return out;
}

/** SPF/DKIM/DMARC and spam score, as far as the headers reveal them. */
function readAuth(raw) {
  const ar = [].concat(raw['authentication-results'] || []).join(' ');
  const get = (name) => {
    const m = new RegExp('\\b' + name + '=(\\w+)', 'i').exec(ar);
    return m ? m[1].toLowerCase() : null;
  };
  let spf = get('spf');
  if (!spf && raw['received-spf']) spf = (String(raw['received-spf']).match(/^\s*(\w+)/) || [])[1]?.toLowerCase() || null;
  const scoreRaw = raw['x-spam-score'] || raw['x-spamd-result'] || raw['x-spam-status'] || null;
  let spam = null;
  if (scoreRaw) {
    const m = String(scoreRaw).match(/(-?\d+(?:\.\d+)?)/);
    if (m) spam = parseFloat(m[1]);
  }
  if (spam === null && /^\s*yes/i.test(String(raw['x-spam-flag'] || ''))) spam = 10;
  return { spf: spf || null, dkim: get('dkim'), dmarc: get('dmarc'), spam_score: spam };
}

function normaliseWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The anti-hallucination check of §1 / §1a.1, kept as a named export because
 * callers and tests reach for it. The real work is in src/evidence.js; this is
 * the simple "is it verbatim in any one surface" question.
 */
function evidenceIsReal(evidence, surfacesOrHaystack) {
  if (evidence == null || evidence === '') return false;   // no claim is not a pass
  const e = normaliseWhitespace(evidence);
  if (e.length < 4) return false;
  if (typeof surfacesOrHaystack === 'string') return normaliseWhitespace(surfacesOrHaystack).includes(e);
  return (surfacesOrHaystack || []).some((x) => (typeof x === 'string' ? normaliseWhitespace(x) : x.text).includes(e));
}

/** Full check: verbatim in one surface AND actually supporting the value. */
function verifyEvidence(evidence, rawValue, coercedValue, field, surfaces) {
  return verify(evidence, rawValue, coercedValue, field, surfaces);
}

function emptyField() { return { value: null, confidence: 0, source: 'none', evidence: null }; }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * Full parse.
 * @param {Buffer|string|{subject?:string,text?:string,html?:string}} input
 * @param {{schema?:Array, log?:object, requestId?:string, complete?:Function,
 *          schemaVersion?:number, now?:Date, llm?:boolean}} options
 * @returns {Promise<object>} the §1 object minus id/mailbox/envelope
 */
async function parseMessage(input, options) {
  const opts = options || {};
  const t0 = Date.now();
  const requestId = opts.requestId || 'req_' + crypto.randomBytes(9).toString('hex');
  // §6 logging is mandatory for the service, but a library that writes to
  // stdout unasked is a menace, so the default is silent and the API/smtpd
  // packages inject their own logger.
  const log = opts.log ? normaliseLogger(opts.log) : makeLogger({ enabled: !!opts.verbose });
  const timings = { total: 0, mime: 0, deterministic: 0, llm: 0, persist: 0 };
  const warnings = [];
  const flags = [];

  let mime = null;
  try {
    log.info('parse.start', { request_id: requestId, bytes: Buffer.isBuffer(input) ? input.length : null });

    // ---- MIME ---------------------------------------------------------------
    const tMime = Date.now();
    if (input && typeof input === 'object' && !Buffer.isBuffer(input) && (input.text !== undefined || input.html !== undefined || input.subject !== undefined)) {
      mime = fromParts(input);
    } else {
      mime = parseMime(input);
    }
    timings.mime = Date.now() - tMime;
    log.debug('parse.stage', { request_id: requestId, stage: 'mime', ms: timings.mime,
      parts: mime.attachments.length, has_html: !!mime.body.html });
    for (const w of mime.warnings || []) {
      if (w === 'truncated_body') pushFlag(flags, 'truncated_body'); else warnings.push(w);
      if (w.startsWith('attachment_too_large')) pushFlag(flags, 'attachment_too_large');
    }

    // ---- deterministic ------------------------------------------------------
    const tDet = Date.now();
    const senderDomain = mime.headers.from && mime.headers.from.email
      ? mime.headers.from.email.split('@')[1] || null : null;
    const referenceYear = mime.headers.date ? new Date(mime.headers.date).getUTCFullYear()
      : (opts.now ? new Date(opts.now).getUTCFullYear() : new Date().getUTCFullYear());
    const hint = localeHint(senderDomain);
    // Detection reads the stripped body when stripping actually did something:
    // amounts and dates from last week's quoted invoice are not this message's.
    const full = mime.body.text || mime.body.text_from_html || '';
    const stripped = mime.body.stripped_text || '';
    const detectText = (mime._strip && mime._strip.quoteRemoved && stripped.length >= 80) ? stripped : full;
    const detected = detect({
      subject: mime.headers.subject,
      text: detectText,
      tables: mime.tables,
      attachments: mime.attachments,
      links: mime._links,
      senderDomain,
      referenceYear,
      localeHint: hint,
    });
    // Prefer a verdict the caller already computed over re-reading the
    // Authentication-Results header. The inbound pipeline stamps its OWN
    // verdict into that header, so re-deriving it read our own homework back:
    // a body-altered DKIM is stamped `dkim=fail` — correct per RFC 8601, which
    // has no body_altered value — and came back out as auth_fail:dkim, next to
    // the dkim_body_altered the same message already carried. readAuth stays as
    // the fallback for raw MIME that arrives with no verdict of ours.
    const auth = (opts && opts.auth && typeof opts.auth === 'object')
      ? { spf: null, dkim: null, dmarc: null, spam_score: null, ...opts.auth }
      : readAuth(mime.headers.raw || {});
    timings.deterministic = Date.now() - tDet;
    log.debug('parse.stage', { request_id: requestId, stage: 'deterministic', ms: timings.deterministic,
      type: detected.type, tables: mime.tables.length, amounts: detected.amounts.length });

    // ---- fields -------------------------------------------------------------
    const schema = normaliseSchema(opts.schema);
    const fields = {};
    let llmUsed = false, model = null;

    if (!schema.length) {
      pushFlag(flags, 'no_schema');
    } else {
      const ruleCtx = {
        detected,
        searchable: [mime.headers.subject || '', mime.body.stripped_text || '', mime.body.text || ''].join('\n'),
        stripped: mime.body.stripped_text,
        text: mime.body.text,
        htmlText: mime.body.text_from_html,
        subject: mime.headers.subject,
        tables: mime.tables,
        headers: mime.headers,
        attachments: mime.attachments,
        senderDomain, referenceYear, localeHint: hint === 'dmy' ? 'eu' : null,
        defaultCurrency: (detected.amounts[0] || {}).currency || null,
      };

      // -- phase 1: candidates from layer (a) ---------------------------------
      const cand = {};            // field name -> candidate record
      for (const f of schema) {
        const rec = { field: f, rule: null, derived: null, llm: null };
        try { rec.rule = ruleExtract(f, ruleCtx); } catch (e) { warnings.push(`rule failed for ${f.name}: ${e.message}`); }
        if ((f.type || '') === 'array') {
          const d = pickLineItems(f, ruleCtx, deriveArrayFromTables);
          if (d) rec.derived = d;
        }
        cand[f.name] = rec;
      }

      // -- phase 2: one LLM call, for EVERY field ------------------------------
      // §1a.2 says both layers run, and it has to be literally true. A rule that
      // is certain of itself is still one extractor: the two 0.97 errors the
      // hold-out found were both a confident label match on the wrong number
      // ("...against invoice INV-9921" when the document is credit note CN-3390).
      // Agreement is what earns a score above 0.9 — never a rule's own certainty.
      if (schema.length && opts.llm !== false) {
        const complete = opts.complete || sharedComplete();
        const res = await llmExtract(schema, {
          subject: mime.headers.subject,
          from: mime.headers.from ? (mime.headers.from.name ? `${mime.headers.from.name} <${mime.headers.from.email}>` : mime.headers.from.email) : null,
          date: mime.headers.date,
          detected,
          tables: mime.tables,
          stripped: mime.body.stripped_text,
          text: mime.body.text,
          forwardedFrom: mime.body.forwarded_from,
          attachments: mime.attachments,
        }, { log, complete, chain: opts.chain });
        timings.llm = res.ms;
        model = res.model;
        llmUsed = res.ok;
        if (!res.ok) { pushFlag(flags, 'llm_unavailable'); warnings.push(`llm: ${res.error}`); }
        for (const f of schema) {
          const got = res.fields[f.name];
          if (got && typeof got === 'object' && !Array.isArray(got) && 'value' in got) cand[f.name].llm = got;
          else if (got !== undefined) cand[f.name].llm = { value: got, confidence: undefined, evidence: null };
        }
      }

      // -- phase 3: pick a value per field, then coerce ------------------------
      const surfaces = evidenceSurfaces(mime);
      const picked = {};
      for (const f of schema) {
        picked[f.name] = (f.type || '') === 'array'
          ? pickArray(cand[f.name], ruleCtx, surfaces, flags)
          : pick(cand[f.name], ruleCtx, flags);
      }
      const coerced = {};
      const typeOk = {};
      for (const f of schema) {
        const p = picked[f.name];
        if (p.value === null || p.value === undefined) { coerced[f.name] = null; typeOk[f.name] = true; continue; }
        const c = coerce(p.value, f, ruleCtx);
        if (!c.ok) {
          if (c.enumViolation) pushFlag(flags, `enum_violation:${f.name}`);
          else pushFlag(flags, `type_error:${f.name}`);
          coerced[f.name] = null; typeOk[f.name] = false;
        } else { coerced[f.name] = c.value; typeOk[f.name] = true; }
      }

      // -- phase 4: verify arithmetic and structure, then compute confidence ----
      const arith = reconcile(coerced, schema);
      if (arith.checked && !arith.ok) { pushFlag(flags, 'arithmetic_mismatch'); warnings.push(`arithmetic: ${arith.detail}`); }

      for (const f of schema) {
        const p = picked[f.name];
        const value = coerced[f.name];
        if (value === null) {
          fields[f.name] = { value: null, confidence: 0, source: typeOk[f.name] ? 'none' : p.source, evidence: typeOk[f.name] ? null : p.evidence };
          continue;
        }
        const ev = verifyEvidence(p.evidence, p.value, value, f, surfaces);
        const inCluster = arith.checked && (arith.roles || []).length > 0 && isClusterField(f.name);
        const structural = Array.isArray(value) ? rowSanity(value, f) : null;
        if (structural && !structural.ok) warnings.push(`${f.name}: ${structural.reason}`);
        const sig = {
          source: p.source,
          ruleConfidence: p.ruleConfidence,
          modelConfidence: p.modelConfidence,
          evidenceGiven: ev.given,
          evidenceOk: ev.ok,
          corroborated: corroborates(value, ruleCtx),
          disagreement: p.disagreement,
          arithmetic: inCluster ? arith.ok : undefined,
          structural: structural ? structural.ok : undefined,
        };
        const out = computeConfidence(sig);
        for (const fl of out.flags) {
          pushFlag(flags, fl === 'arithmetic_mismatch' ? 'arithmetic_mismatch' : `${fl}:${f.name}`);
        }
        // An unverifiable citation is worse than none: do not publish it.
        const evidence = ev.given && !ev.ok ? null : (p.evidence == null ? null : String(p.evidence));
        fields[f.name] = { value, confidence: out.confidence, source: out.source, evidence };
      }

      for (const t of mime.tables) if (t.truncated) pushFlag(flags, 'table_truncated');

      for (const f of schema) {
        const v = fields[f.name] || emptyField();
        fields[f.name] = v;
        if (f.required && (v.value === null || v.value === undefined)) pushFlag(flags, `missing_required:${f.name}`);
        if (v.value !== null && v.confidence <= LOW_CONFIDENCE) pushFlag(flags, `low_confidence:${f.name}`);
      }
    }

    if (auth.spam_score !== null && auth.spam_score >= 5) pushFlag(flags, 'spam_suspected');
    for (const k of ['spf', 'dkim', 'dmarc']) {
      if (auth[k] && /^(fail|softfail|permerror|temperror)$/.test(auth[k])) pushFlag(flags, `auth_fail:${k}`);
    }

    const needsReview = flags.some((f) => /^(low_confidence|missing_required|type_error|hallucinated_evidence):/.test(f));
    timings.total = Date.now() - t0;

    const confidences = Object.values(fields).map((f) => f.confidence).filter((c) => typeof c === 'number');
    log.info('parse.done', { request_id: requestId, timings_ms: timings, fields: Object.keys(fields).length,
      mean_confidence: confidences.length ? round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null,
      flags, llm_used: llmUsed, type: detected.type });

    return {
      received_at: (opts.now ? new Date(opts.now) : new Date()).toISOString(),
      headers: mime.headers,
      body: mime.body,
      attachments: mime.attachments,
      auth,
      tables: mime.tables,
      detected: toContractShape(detected),
      fields,
      flags,
      needs_review: needsReview,
      parse: {
        request_id: requestId,
        schema_version: opts.schemaVersion === undefined ? null : opts.schemaVersion,
        model,
        llm_used: llmUsed,
        timings_ms: timings,
        warnings,
      },
    };
  } catch (err) {
    // §1 says a message always delivers. A crash here still returns a valid object.
    // The failure path must not be able to fail: serialising the input can
    // itself throw (a getter that raises, a circular structure), and that would
    // turn a handled parse error into an unhandled rejection.
    let raw;
    try {
      raw = Buffer.isBuffer(input) ? input
        : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input || {}) || '');
    } catch { raw = Buffer.from('<uninspectable input>'); }
    const digest = sha256(raw);
    timings.total = Date.now() - t0;
    try {
      log.error('parse.failed', { request_id: requestId, error: err.message, stack: (err.stack || '').split('\n').slice(0, 4).join(' | '), input_sha256: digest, bytes: raw.length });
    } catch { /* never rethrow from the failure path */ }
    warnings.push(`parse failed: ${err.message}`);
    return {
      received_at: new Date().toISOString(),
      headers: (mime && mime.headers) || emptyHeaders(),
      body: (mime && mime.body) || { text: '', html: null, text_from_html: null, stripped_text: '', language: null },
      attachments: (mime && mime.attachments) || [],
      auth: { spf: null, dkim: null, dmarc: null, spam_score: null },
      tables: (mime && mime.tables) || [],
      detected: { type: 'generic', emails: [], urls: [], phones: [], amounts: [], dates: [], ids: [], addresses: [] },
      fields: Object.fromEntries(normaliseSchema(opts.schema).map((f) => [f.name, emptyField()])),
      flags: dedupe([...flags, ...normaliseSchema(opts.schema).filter((f) => f.required).map((f) => `missing_required:${f.name}`)]),
      needs_review: true,
      parse: { request_id: requestId, schema_version: opts.schemaVersion === undefined ? null : opts.schemaVersion,
        model: null, llm_used: false, timings_ms: timings, warnings, input_sha256: digest },
    };
  }
}

/** Fields that participate in the invoice arithmetic cluster. */
function isClusterField(name) {
  return /(^|_)(sub_?total|net(_total)?|tax|vat|mwst|ust|shipping|versand|discount|rabatt|grand_total|total|order_total|amount_due|balance|gesamtbetrag|summe|line_items|items|positions|lines)$/i.test(String(name));
}

/**
 * Choose between the rule value and the model value for a scalar field.
 *
 * Agreement between two independent extractors is the only thing that buys a
 * score above 0.9. Disagreement is a genuine warning that nobody running a
 * single extractor can even detect, so it is surfaced rather than resolved.
 */
function pick(rec, ctx, flags) {
  const f = rec.field;
  const rule = rec.rule;
  const llm = rec.llm;
  const llmValue = llm && llm.value !== undefined ? llm.value : undefined;
  const modelConfidence = llm && typeof llm.confidence === 'number' ? llm.confidence : undefined;
  const llmEvidence = llm && llm.evidence != null ? String(llm.evidence) : null;

  const hasRule = rule && rule.value !== null && rule.value !== undefined;
  const hasLlm = llmValue !== undefined && llmValue !== null && llmValue !== '';

  // A FALLBACK is a guess, not a reading: the From display name is not the
  // vendor, it is where the mail came from. It answers only when nothing else
  // does, and it never counts as a disagreement — treating a guess as a second
  // opinion is how a correct model answer gets overruled by a mailbox name.
  if (hasRule && hasLlm && rule.fallback) {
    return { value: llmValue, source: 'llm', evidence: llmEvidence, modelConfidence, disagreement: false };
  }

  if (hasRule && hasLlm) {
    // Compare AFTER coercion. Before it, the rule's normalised "2026-09-08" is
    // string-compared against the model's "September 8, 2026" and every date
    // field reports a disagreement it does not have. A false needs_review is
    // worse for us than a missing one: it teaches users to ignore the one
    // signal no competitor offers.
    if (sameValue(coerceForCompare(rule.value, f, ctx), coerceForCompare(llmValue, f, ctx))) {
      return { value: rule.value, source: 'rule+llm', evidence: rule.evidence || llmEvidence,
        ruleConfidence: rule.confidence, modelConfidence, disagreement: false };
    }
    // Keep the deterministic value: it is the one we can point at a label for.
    return { value: rule.value, source: rule.source, evidence: rule.evidence,
      ruleConfidence: rule.confidence, modelConfidence, disagreement: true };
  }
  if (hasRule) {
    // Unconfirmed by the second extractor. Capped below 0.9 by computeConfidence.
    return { value: rule.value, source: rule.source, evidence: rule.evidence,
      ruleConfidence: rule.confidence, modelConfidence: undefined, disagreement: false };
  }
  if (hasLlm) {
    return { value: llmValue, source: 'llm', evidence: llmEvidence, modelConfidence, disagreement: false };
  }
  return { value: null, source: 'none', evidence: null, disagreement: false };
}

/**
 * Choose a row set for an array field.
 *
 * Candidates come from up to four independent extractors: a real <table> grid,
 * repeating HTML structure, the text/plain run, and the model. They are ranked
 * by PROOF, not by preference:
 *
 *   1. the amounts sum to a total stated elsewhere in the document — this is a
 *      completeness proof, and it is the only defence against the category's
 *      loudest failure ("40 rows in the mail, 1 row in the output");
 *   2. structural sanity (no null descriptions, no quantity copied from the
 *      amount, no summary or footer lines masquerading as items);
 *   3. source precision;
 *   4. length.
 *
 * The hold-out corpus is why (1) outranks source precision: in
 * `ho-hard-08` three of six line items exist only inside the quoted reply, so
 * the deterministic reading of the visible body is confidently and completely
 * wrong, and only the sum gives it away.
 */
function pickArray(rec, ctx, surfaces, flags) {
  const f = rec.field;
  const derived = rec.derived;
  const llm = rec.llm;
  const llmValue = llm && Array.isArray(llm.value) ? llm.value : null;
  const modelConfidence = llm && typeof llm.confidence === 'number' ? llm.confidence : undefined;

  const targets = arithmeticTargets(ctx);
  const candidates = [];
  if (derived) {
    candidates.push({ name: derived.winner || 'rule', kind: 'rule', rows: derived.rows,
      precision: 3, evidence: derived.evidence, anchored: derived.anchored });
    for (const alt of derived.alternates || []) {
      candidates.push({ name: alt.name, kind: 'rule', rows: alt.rows, precision: alt.precision, evidence: alt.evidence, anchored: alt.anchored });
    }
  }
  if (llmValue) candidates.push({ name: 'llm', kind: 'llm', rows: llmValue, precision: 2, evidence: llm.evidence || null, anchored: false });
  if (!candidates.length) return { value: null, source: 'none', evidence: null, disagreement: false };

  for (const c of candidates) {
    c.sane = rowSanity(c.rows, f).ok;
    c.sums = sumsTo(c.rows, targets);
    c.score = (c.sums ? 1000 : 0) + (c.sane ? 100 : 0) + c.precision * 10 + Math.min(c.rows.length, 9);
  }
  candidates.sort((a, b) => b.score - a.score);
  const win = candidates[0];

  const agreeing = candidates.filter((c) => c !== win && rowsEqual(c.rows, win.rows));
  const agreedAcrossKinds = agreeing.some((c) => c.kind !== win.kind);
  const shorter = candidates.filter((c) => c !== win && c.rows.length < win.rows.length);
  if (shorter.length && !win.sums) pushFlag(flags, `array_incomplete:${f.name}`);
  if (candidates.length > 1 && !agreeing.length) pushFlag(flags, `array_source_disagreement:${f.name}`);

  // Evidence must be a real span of a real surface, never a rendering of our
  // own data model. spanFor() goes and finds one.
  const first = win.rows[0];
  const needles = first && typeof first === 'object'
    ? Object.values(first).filter((v) => v !== null && v !== undefined && String(v).length >= 2).slice(0, 2)
    : [first];
  const evidence = spanFor(needles.map(String), surfaces) || null;

  // Two independent extractors agreeing, or a row set that provably adds up,
  // is a completeness claim we have earned. Anything else stays under 0.9.
  const base = (agreedAcrossKinds || win.sums) ? 0.97 : 0.88;
  return {
    value: win.rows,
    source: agreedAcrossKinds ? 'rule+llm' : (win.kind === 'llm' ? 'llm' : 'rule'),
    evidence,
    ruleConfidence: base,
    modelConfidence: win.kind === 'llm' || agreedAcrossKinds ? modelConfidence : undefined,
    disagreement: false,
  };
}

/** Amounts stated elsewhere that a complete row set ought to reproduce. */
function arithmeticTargets(ctx) {
  const out = [];
  for (const a of (ctx.detected && ctx.detected.amounts) || []) {
    if (typeof a.value === 'number' && a.value !== 0) out.push(a.value);
  }
  return out;
}

function sumsTo(rows, targets) {
  if (!rows || !rows.length || !targets.length) return false;
  const sum = rows.reduce((n, r) => {
    const a = r && typeof r === 'object' ? toAmount(r.amount !== undefined ? r.amount : r.total) : toAmount(r);
    return n + (a === null || a === undefined ? 0 : a);
  }, 0);
  if (!isFinite(sum) || sum === 0) return false;
  return targets.some((t) => Math.abs(sum - t) <= Math.max(0.02, Math.abs(t) * 0.005));
}

const SUMMARY_DESC = /^\s*(?:grand\s+)?(?:total|sub-?total|amount\s+(?:due|paid|charged|remaining|before\s+tax)|balance|tax|vat|mwst|ust|sales\s+tax|estimated\s+tax|shipping|versand|delivery|discount|rabatt|gesamt|zwischensumme|summe|tva|iva|free\s+delivery|you\s+saved|order\s+total|item\s+subtotal)\b/i;

/**
 * Structural sanity of a row set. These are cheap checks that turn a confident
 * wrong answer into a flagged one, which is the whole product.
 * @returns {{ok:boolean, reason:string|null}}
 */
function rowSanity(rows, field) {
  if (!Array.isArray(rows) || !rows.length) return { ok: true, reason: null };
  const objects = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  if (!objects.length) return { ok: true, reason: null };
  const keys = Object.keys(objects[0]);
  const descKey = keys.find((k) => /^(description|item|product|name|beschreibung|bezeichnung|artikel)$/i.test(k));
  const amtKey = keys.find((k) => /^(amount|total|price|betrag|preis|value)$/i.test(k));
  const qtyKey = keys.find((k) => /^(qty|quantity|menge|anzahl)$/i.test(k));

  let nullDesc = 0, qtyIsAmount = 0, summary = 0;
  for (const r of objects) {
    if (descKey) {
      const d = r[descKey];
      if (d === null || d === undefined || String(d).trim() === '') nullDesc++;
      else if (SUMMARY_DESC.test(String(d))) summary++;
    }
    if (qtyKey && amtKey) {
      const q = r[qtyKey], a = r[amtKey];
      if (q !== null && a !== null && q !== undefined && a !== undefined
          && Math.abs(Number(q) - Number(a)) < 0.005 && Math.abs(Number(a)) > 4) qtyIsAmount++;
    }
  }
  if (descKey && nullDesc >= Math.max(1, objects.length * 0.5)) {
    return { ok: false, reason: `${nullDesc}/${objects.length} rows have no description` };
  }
  if (qtyIsAmount >= Math.max(1, objects.length * 0.5)) {
    return { ok: false, reason: `${qtyIsAmount}/${objects.length} rows have quantity equal to amount` };
  }
  if (summary) return { ok: false, reason: `${summary} summary/footer row(s) extracted as line items` };
  return { ok: true, reason: null };
}

/** Normalise a value through the schema's own type so two extractors can be
 *  compared on meaning rather than on surface form. */
function coerceForCompare(value, field, ctx) {
  const c = coerce(value, field, ctx);
  if (!c.ok || c.value === null) return value;
  if (typeof c.value === 'string') return c.value.trim().toLowerCase().replace(/\s+/g, ' ');
  return c.value;
}

function round(n) { return Math.round(n * 1000) / 1000; }
function pushFlag(flags, f) { if (!flags.includes(f)) flags.push(f); }
function dedupe(a) { return [...new Set(a)]; }

function emptyHeaders() {
  return { message_id: null, date: null, subject: null, from: null, to: [], cc: [], reply_to: [],
    in_reply_to: null, references: [], raw: {} };
}

/** `POST /v1/parse` may hand us loose parts rather than raw MIME. */
function fromParts(parts) {
  const html = parts.html || null;
  const textFromHtml = html ? htmlToText(html) : null;
  const text = parts.text || textFromHtml || '';
  const strip = strippedText(text);
  const tables = [];
  if (html) {
    for (const t of extractHtmlTables(html)) tables.push({ ...t, index: tables.length });
    for (const t of extractRepeatTables(html, tables.length)) tables.push({ ...t, index: tables.length });
  }
  for (const t of textTablesIncludingQuoted(parts.text || '')) tables.push({ ...t, index: tables.length });
  const headers = emptyHeaders();
  headers.subject = parts.subject == null ? null : String(parts.subject);
  if (parts.from) {
    const m = String(parts.from).match(/<([^>]+)>/);
    headers.from = { name: m ? String(parts.from).slice(0, m.index).trim() || null : null,
      email: (m ? m[1] : String(parts.from)).trim().toLowerCase() };
  }
  return {
    headers,
    body: { text, html, text_from_html: textFromHtml, stripped_text: strip.text, language: detectLanguage(strip.text || text) },
    attachments: [], tables, warnings: [], _strip: strip, _links: html ? extractLinks(html) : [],
  };
}

function normaliseSchema(schema) {
  if (!schema) return [];
  const list = Array.isArray(schema) ? schema : Array.isArray(schema.fields) ? schema.fields : [];
  return list.filter((f) => f && f.name).map((f) => ({ ...f, name: String(f.name) }));
}

module.exports = { parseMime, parseMessage, evidenceIsReal, normaliseSchema };
