'use strict';
const { glyphNameToUnicode } = require('./glyphnames');

/**
 * /Encoding << /Differences [ 32 /space 128 /Euro /bullet ] >>
 *
 * The array is a run-length form: a number resets the code counter, every name
 * after it consumes the next code. Getting the reset wrong shifts an entire
 * font by one and produces text that looks like a Caesar cipher — a failure
 * mode that reads as "the PDF is corrupt" when it is really an off-by-one.
 */
function parseDifferences(arr) {
  const out = new Map();
  if (!Array.isArray(arr)) return out;
  let code = 0;
  for (const item of arr) {
    if (typeof item === 'number' && Number.isFinite(item)) { code = Math.max(0, Math.floor(item)); continue; }
    if (typeof item === 'string') { out.set(code, item); code++; continue; }
    // Anything else (a stray ref, a null) must not silently shift the run.
    if (item == null) { code++; continue; }
  }
  return out;
}

/** The same array, resolved through to characters. Unknown names are dropped. */
function differencesMap(arr) {
  const names = parseDifferences(arr);
  const out = new Map();
  for (const [code, name] of names) {
    const cp = glyphNameToUnicode(name);
    if (cp) out.set(code, String.fromCodePoint(cp));
  }
  return out;
}

module.exports = { parseDifferences, differencesMap };
