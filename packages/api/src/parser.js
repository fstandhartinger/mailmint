'use strict';

const { log } = require('./log');

/**
 * The only place in the API that knows the parser exists.
 *
 * `mailmint-parser` is a workspace sibling, so it is resolved lazily: the
 * package is under active development and a require at module load would take
 * the whole API down with it on a syntax error in a library the API only needs
 * on one code path.
 *
 * Contract: parseMessage(Buffer | {subject,text,html}, {schema, log, requestId})
 * resolves to the §1 object.
 */
let cached = null;

function loadParser() {
  if (cached) return cached;
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require('mailmint-parser');
  const fn = mod.parseMessage || (mod.default && mod.default.parseMessage);
  if (typeof fn !== 'function') throw new Error('mailmint-parser does not export parseMessage(input, opts)');
  cached = fn;
  return cached;
}

/** True when the parser package is importable. Used by /healthz. */
function parserAvailable() {
  try { loadParser(); return true; } catch { return false; }
}

/**
 * Runs the parser and guarantees a §1-shaped object comes back, whatever the
 * parser did. `flags`, `fields` and `parse.timings_ms` are load-bearing for
 * everything downstream — the webhook body, the n8n node, needs_review — so a
 * parser that omits one must not turn into a TypeError three modules away.
 */
async function parseMessage(input, opts = {}) {
  const started = Date.now();
  const fn = loadParser();
  const out = await fn(input, opts);
  if (!out || typeof out !== 'object') throw new Error('parser returned nothing');
  out.body = out.body || { text: null, html: null, text_from_html: null, stripped_text: null, language: null };
  out.headers = out.headers || {};
  out.attachments = Array.isArray(out.attachments) ? out.attachments : [];
  out.detected = out.detected || {};
  out.fields = out.fields && typeof out.fields === 'object' ? out.fields : {};
  out.tables = Array.isArray(out.tables) ? out.tables : [];
  out.auth = out.auth || {};
  out.flags = Array.isArray(out.flags) ? out.flags : [];
  out.parse = out.parse || {};
  out.parse.timings_ms = out.parse.timings_ms || {};
  if (out.parse.timings_ms.total === undefined) out.parse.timings_ms.total = Date.now() - started;
  if (out.parse.llm_used === undefined) out.parse.llm_used = Boolean(out.parse.model);
  if (out.parse.warnings === undefined) out.parse.warnings = [];
  return out;
}

/**
 * §4: needs_review is true when any flag says a human should look. Derived here
 * rather than trusted from the parser so the API, the dashboard's review queue
 * and the webhook body can never disagree about it.
 *
 * Two of these are ours alone. `rule_llm_disagreement` means the deterministic
 * layer and the model produced different answers for the same field — nobody
 * else runs both, so nobody else can even detect it. `arithmetic_mismatch`
 * means the line items do not add up to the total, which is what catches "40
 * rows in the mail, 1 row in the output": the failure that is otherwise silent
 * because every individual value looks plausible.
 */
const REVIEW_FIELD_FLAGS = /^(low_confidence|missing_required|type_error|hallucinated_evidence|enum_violation|rule_llm_disagreement):/;
const REVIEW_WHOLE_FLAGS = new Set(['arithmetic_mismatch', 'table_truncated', 'attachment_unreadable']);
const needsReview = (flags) => (flags || []).some(
  (f) => REVIEW_FIELD_FLAGS.test(String(f)) || REVIEW_WHOLE_FLAGS.has(String(f)),
);

/** The field a flag points at, or null for a whole-message flag. */
const flagField = (flag) => {
  const i = String(flag).indexOf(':');
  return i > 0 ? String(flag).slice(i + 1) : null;
};

/** Mean of the confidences actually present. Null when the schema was empty. */
function meanConfidence(fields) {
  const values = Object.values(fields || {})
    .map((f) => (f && typeof f.confidence === 'number' ? f.confidence : null))
    .filter((c) => c !== null);
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
}

module.exports = { parseMessage, parserAvailable, needsReview, flagField, meanConfidence, log };
