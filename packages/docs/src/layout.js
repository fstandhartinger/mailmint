'use strict';

/**
 * Positioned runs -> lines -> segments.
 *
 * Two things make this harder than "group by y":
 *
 * 1. **Baseline drift.** Runs on one visual line rarely share a y. Mixed font
 *    sizes, superscripts and the rounding in the text matrix put them a point
 *    or two apart. A fixed epsilon either merges two lines of 7pt text or
 *    splits one line of 18pt text. So the tolerance is proportional to the
 *    glyph height of the runs being compared.
 *
 * 2. **Runs are not words.** Generators emit a separate run per kerning pair.
 *    Whether two runs are one word, two words, or two *columns* is decided by
 *    the gap between them measured in units of the current font size — which
 *    is the only scale-free measure available.
 */

/** Runs whose baselines are within tolerance form one line. */
function buildLines(runs) {
  const usable = runs.filter((r) => r.text && r.text.trim() !== '' && Math.abs(r.angle) < 0.08);
  const rotated = runs.length - usable.length;
  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const h = r.h || 10;
    const last = lines[lines.length - 1];
    // Half the glyph height, floored at 1pt: enough for drift, not enough to
    // swallow the next line, whose baseline is a full line-height away.
    const tol = Math.max(1, Math.min(h, last ? last.h : h) * 0.5);
    if (last && Math.abs(r.y - last.y) <= tol) {
      last.runs.push(r);
      last.h = Math.max(last.h, h);
      last.y = (last.y * (last.runs.length - 1) + r.y) / last.runs.length;
    } else {
      lines.push({ y: r.y, h, runs: [r] });
    }
  }
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    l.segments = segmentLine(l.runs);
    l.x0 = l.segments.length ? l.segments[0].x0 : 0;
    l.x1 = l.segments.length ? l.segments[l.segments.length - 1].x1 : 0;
    l.text = l.segments.map((s) => s.text).join('  ');
  }
  return { lines, rotated };
}

/** Adjacent runs separated by less than a space become one segment. */
function segmentLine(runs) {
  const segs = [];
  for (const r of runs) {
    const text = r.text;
    if (text.trim() === '' && !segs.length) continue;
    const last = segs[segs.length - 1];
    const x0 = r.x;
    const x1 = r.x + (r.w || 0);
    if (last) {
      const gap = x0 - last.x1;
      const size = Math.max(r.h || 0, last.h || 0) || 10;
      if (gap < size * 0.85) {
        // Same segment. Insert a space only if the glyphs are not touching and
        // neither side already supplies one.
        const needsSpace = gap > size * 0.16 && !/\s$/.test(last.text) && !/^\s/.test(text);
        last.text += (needsSpace ? ' ' : '') + text;
        last.x1 = Math.max(last.x1, x1);
        last.h = Math.max(last.h, r.h || 0);
        continue;
      }
    }
    if (text.trim() === '') continue;
    segs.push({ text, x0, x1, h: r.h || 10 });
  }
  for (const s of segs) s.text = s.text.replace(/\s+/g, ' ').trim();
  return segs.filter((s) => s.text !== '');
}

/**
 * Render lines back to text.
 *
 * Not decoration: this string is what the LLM layer and the deterministic rule
 * layer both read, and their answers depend on columns still looking like
 * columns. Indentation is reconstructed from x in units of the page's median
 * character width, which is the same thing `pdftotext -layout` does and the
 * reason its output is usable where a naive concatenation is not.
 */
function renderText(lines, pageWidth) {
  if (!lines.length) return '';
  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const charW = Math.max(2.2, medianH * 0.5);
  const maxCols = Math.max(40, Math.min(400, Math.ceil((pageWidth || 612) / charW)));
  const out = [];
  let prevY = null;
  for (const l of lines) {
    if (prevY !== null) {
      const blank = Math.round((l.y - prevY) / Math.max(medianH * 1.6, 1)) - 1;
      for (let i = 0; i < Math.min(3, blank); i++) out.push('');
    }
    prevY = l.y;
    let row = '';
    for (const s of l.segments) {
      const col = Math.max(0, Math.min(maxCols - 1, Math.round(s.x0 / charW)));
      if (col > row.length) row += ' '.repeat(col - row.length);
      else if (row.length && !/\s$/.test(row)) row += ' ';
      row += s.text;
    }
    out.push(row.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

module.exports = { buildLines, segmentLine, renderText };
