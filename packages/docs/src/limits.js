'use strict';

/**
 * Hard caps. An attachment is attacker-controlled input: a 4 KB PDF can declare
 * 50,000 pages, a 200-byte zip can expand to a gigabyte, and a malformed font
 * table can send a parser into a long loop. Every limit here exists because the
 * alternative is an unbounded worker.
 *
 * Everything is overridable per call so the API service can be stricter than
 * the library default, never the other way round by accident.
 */
const DEFAULTS = {
  maxBytes: 25 * 1024 * 1024,     // matches the largest inbound attachment we accept
  maxPdfPages: 50,                // pages we will read text from
  maxOcrPages: 10,                // pages we will pay a model to look at
  maxOcrBytes: 8 * 1024 * 1024,   // inline-data ceiling for the Gemini request
  maxTextChars: 2_000_000,        // text we will hold and hand back
  maxTableRows: 2000,             // per table; beyond this `truncated` is set
  maxTables: 40,
  maxCells: 40_000,               // total positioned runs turned into cells
  totalMs: 45_000,                // wall clock for the whole extraction
  pdfMs: 20_000,                  // wall clock for the deterministic PDF pass
  ocrMs: 60_000,                  // wall clock for the model round trip
  minCharsPerPage: 40,            // below this a PDF page counts as "no text layer"
};

function resolveLimits(overrides) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** A monotonic deadline that every stage checks rather than trusting itself. */
function deadline(ms) {
  const at = Date.now() + ms;
  return {
    at,
    left: () => at - Date.now(),
    expired: () => Date.now() >= at,
  };
}

module.exports = { DEFAULTS, resolveLimits, deadline };
