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
const { computeConfidence, corroborates, sameValue, reconcile, deriveArrayFromTables } = require('./confidence');
const { pickLineItems } = require('./lineitems');
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

const RULE_ACCEPT = 0.9;      // a rule this confident means the field never reaches the model
const LOW_CONFIDENCE = 0.6;   // §4

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
  for (const t of extractTextTables(st.text || '')) tables.push({ ...t, index: tables.length });

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

/** The anti-hallucination check of §1. It must actually run, so it lives here. */
function evidenceIsReal(evidence, haystack) {
  if (evidence == null || evidence === '') return true;   // no claim made
  const e = normaliseWhitespace(evidence);
  if (e.length < 3) return true;
  return haystack.includes(e);
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
    const auth = readAuth(mime.headers.raw || {});
    timings.deterministic = Date.now() - tDet;
    log.debug('parse.stage', { request_id: requestId, stage: 'deterministic', ms: timings.deterministic,
      type: detected.type, tables: mime.tables.length, amounts: detected.amounts.length });

    // ---- fields -------------------------------------------------------------
    const schema = normaliseSchema(opts.schema);
    const fields = {};
    let llmUsed = false, model = null;

    const haystack = normaliseWhitespace([
      mime.headers.subject || '',
      mime.body.text || '',
      mime.body.text_from_html || '',
      mime.body.html || '',
      mime.tables.map((t) => [t.headers.join(' '), ...t.rows.map((r) => r.join(' '))].join(' ')).join(' '),
    ].join(' \n '));

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
        senderDomain, referenceYear, localeHint: hint === 'dmy' ? 'eu' : null,
        defaultCurrency: (detected.amounts[0] || {}).currency || null,
      };

      // -- phase 1: candidates from layer (a) ---------------------------------
      const cand = {};            // field name -> candidate record
      const unresolved = [];
      for (const f of schema) {
        const rec = { field: f, rule: null, derived: null, llm: null };
        try { rec.rule = ruleExtract(f, ruleCtx); } catch (e) { warnings.push(`rule failed for ${f.name}: ${e.message}`); }
        if ((f.type || '') === 'array') {
          // Reconcile every deterministic source. A verified row set beats
          // anything a model can be asked to transcribe: it carries every row,
          // at any row count, for free.
          const d = pickLineItems(f, ruleCtx, deriveArrayFromTables);
          if (d) rec.derived = d;
        }
        cand[f.name] = rec;
        const ruleStrong = rec.rule && rec.rule.confidence >= RULE_ACCEPT;
        if (!ruleStrong && !rec.derived) unresolved.push(f);
      }

      // -- phase 2: one LLM call for the rest ---------------------------------
      if (unresolved.length && opts.llm !== false) {
        const complete = opts.complete || sharedComplete();
        const res = await llmExtract(unresolved, {
          subject: mime.headers.subject,
          from: mime.headers.from ? (mime.headers.from.name ? `${mime.headers.from.name} <${mime.headers.from.email}>` : mime.headers.from.email) : null,
          date: mime.headers.date,
          detected,
          tables: mime.tables,
          stripped: mime.body.stripped_text,
          text: mime.body.text,
        }, { log, complete, chain: opts.chain });
        timings.llm = res.ms;
        model = res.model;
        llmUsed = res.ok;
        if (!res.ok) { pushFlag(flags, 'llm_unavailable'); warnings.push(`llm: ${res.error}`); }
        for (const f of unresolved) {
          const got = res.fields[f.name];
          if (got && typeof got === 'object' && !Array.isArray(got) && 'value' in got) cand[f.name].llm = got;
          else if (got !== undefined) cand[f.name].llm = { value: got, confidence: undefined, evidence: null };
        }
      }

      // -- phase 3: pick a value per field, then coerce ------------------------
      const picked = {};
      for (const f of schema) {
        picked[f.name] = pick(cand[f.name], ruleCtx, mime.tables, flags);
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

      // -- phase 4: verify arithmetic, then compute confidence -----------------
      const arith = reconcile(coerced, schema);
      if (arith.checked && !arith.ok) { pushFlag(flags, 'arithmetic_mismatch'); warnings.push(`arithmetic: ${arith.detail}`); }

      for (const f of schema) {
        const p = picked[f.name];
        const value = coerced[f.name];
        if (value === null) {
          fields[f.name] = { value: null, confidence: 0, source: typeOk[f.name] ? 'none' : p.source, evidence: typeOk[f.name] ? null : p.evidence };
          continue;
        }
        const evidenceGiven = p.evidence != null && String(p.evidence) !== '';
        const evidenceOk = evidenceGiven ? evidenceIsReal(p.evidence, haystack) : false;
        const inCluster = arith.checked && (arith.roles || []).length > 0 && isClusterField(f.name);
        const sig = {
          source: p.source,
          ruleConfidence: p.ruleConfidence,
          modelConfidence: p.modelConfidence,
          evidenceGiven, evidenceOk,
          corroborated: corroborates(value, ruleCtx),
          disagreement: p.disagreement,
          arithmetic: inCluster ? arith.ok : undefined,
        };
        const out = computeConfidence(sig);
        for (const fl of out.flags) pushFlag(flags, `${fl}:${f.name}`.replace('arithmetic_mismatch:' + f.name, 'arithmetic_mismatch'));
        fields[f.name] = { value, confidence: out.confidence, source: out.source, evidence: p.evidence == null ? null : String(p.evidence) };
      }

      for (const t of mime.tables) if (t.truncated) pushFlag(flags, 'table_truncated');

      for (const f of schema) {
        const v = fields[f.name] || emptyField();
        fields[f.name] = v;
        if (f.required && (v.value === null || v.value === undefined)) pushFlag(flags, `missing_required:${f.name}`);
        if (v.value !== null && v.confidence < LOW_CONFIDENCE) pushFlag(flags, `low_confidence:${f.name}`);
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
 * Choose between the rule value, the table-derived value and the model value.
 *
 * Agreement between two independent extractors is the strongest positive
 * signal available to us, and disagreement is a genuine warning that nobody
 * running only one extractor can even detect — so both are surfaced rather
 * than quietly resolved.
 */
function pick(rec, ctx, tables, flags) {
  const f = rec.field;
  const rule = rec.rule;
  const derived = rec.derived;
  const llm = rec.llm;
  const llmValue = llm && llm.value !== undefined ? llm.value : undefined;
  const modelConfidence = llm && typeof llm.confidence === 'number' ? llm.confidence : undefined;
  const llmEvidence = llm && llm.evidence != null ? String(llm.evidence) : null;

  // Array fields backed by a real table: the table is authoritative on length.
  if (derived) {
    const derivedLen = derived.rows.length;
    const llmLen = Array.isArray(llmValue) ? llmValue.length : -1;
    if (llmLen >= 0 && llmLen < derivedLen) pushFlag(flags, `array_incomplete:${f.name}`);
    if (derived.disagree) pushFlag(flags, `array_source_disagreement:${f.name}`);
    const agreeWithLlm = llmLen === derivedLen;
    // Two independent deterministic sources agreeing, or a row set that adds up
    // to the stated total, is a completeness proof the model cannot give us.
    const base = derived.agree || derived.anchored ? 0.97 : derived.disagree ? 0.75 : 0.95;
    return {
      value: derived.rows,
      source: agreeWithLlm ? 'rule+llm' : 'rule',
      evidence: derived.evidence,
      ruleConfidence: base,
      modelConfidence: agreeWithLlm ? modelConfidence : undefined,
      disagreement: false,
    };
  }

  const hasRule = rule && rule.value !== null && rule.value !== undefined;
  const hasLlm = llmValue !== undefined && llmValue !== null && llmValue !== '';

  // A FALLBACK is a guess, not a reading: the From display name is not the
  // vendor, it is where the mail came from. It answers only when nothing else
  // does, and it never counts as a disagreement — treating a guess as a second
  // opinion is how a correct model answer gets overruled by a mailbox name.
  if (hasRule && hasLlm && rule.fallback) {
    return { value: llmValue, source: 'llm', evidence: llmEvidence,
      ruleConfidence: undefined, modelConfidence, disagreement: false };
  }

  if (hasRule && hasLlm) {
    // Compare AFTER coercion. Before it, the rule's normalised "2026-09-08" is
    // string-compared against the model's "September 8, 2026" and every date
    // field in every invoice reports a disagreement it does not have. A false
    // needs_review is worse for us than a missing one: it teaches users to
    // ignore the one signal no competitor offers.
    if (sameValue(coerceForCompare(rule.value, f, ctx), coerceForCompare(llmValue, f, ctx))) {
      return { value: rule.value, source: 'rule+llm', evidence: rule.evidence || llmEvidence,
        ruleConfidence: rule.confidence, modelConfidence, disagreement: false };
    }
    // Keep the deterministic value: it is the one we can point at a label for.
    return { value: rule.value, source: rule.source, evidence: rule.evidence,
      ruleConfidence: rule.confidence, modelConfidence, disagreement: true };
  }
  if (hasRule) {
    return { value: rule.value, source: rule.source, evidence: rule.evidence,
      ruleConfidence: rule.confidence, modelConfidence: undefined, disagreement: false };
  }
  if (hasLlm) {
    return { value: llmValue, source: 'llm', evidence: llmEvidence,
      ruleConfidence: undefined, modelConfidence, disagreement: false };
  }
  return { value: null, source: 'none', evidence: null, ruleConfidence: undefined, modelConfidence: undefined, disagreement: false };
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
  for (const t of extractTextTables(parts.text || '')) tables.push({ ...t, index: tables.length });
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
