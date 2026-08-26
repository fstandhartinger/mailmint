'use strict';
const { openZip } = require('./zip');
const { makeTable } = require('./tableshape');
const { decodeXml } = require('./xlsx');

/**
 * DOCX, best effort and clearly labelled as such.
 *
 * A .docx is a zip with `word/document.xml` inside; paragraphs are `<w:p>`,
 * runs are `<w:t>`, tables are `<w:tbl>/<w:tr>/<w:tc>`. That is enough for the
 * quoted use case ("PDFs, images, XML, Word docs … a consistent, AI-readable
 * format"). What it is NOT: styles, headers/footers, footnotes, tracked
 * changes, embedded objects or field codes. Those are absent, not silently
 * wrong, and the README says so.
 */
function extractDocx(buffer, { maxRows = 2000, maxTables = 40 } = {}) {
  const z = openZip(buffer);
  const xml = z.text('word/document.xml');
  if (!xml) return { text: '', tables: [], warnings: ['docx_unreadable'] };

  const tables = [];
  const tblRe = /<w:tbl>([\s\S]*?)<\/w:tbl>/g;
  let m;
  while ((m = tblRe.exec(xml)) !== null && tables.length < maxTables) {
    const rows = [];
    const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let r;
    while ((r = trRe.exec(m[1])) !== null) {
      const cells = [];
      const tcRe = /<w:tc>([\s\S]*?)<\/w:tc>/g;
      let c;
      while ((c = tcRe.exec(r[1])) !== null) cells.push(paraText(c[1]).replace(/\s+/g, ' ').trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((x) => x.length));
    if (width < 2) continue;
    const padded = rows.map((x) => { const o = x.slice(); while (o.length < width) o.push(''); return o; });
    const first = padded[0];
    const looksHeader = first.every((x) => !/^-?[\d.,]+$/.test(x)) && first.filter(Boolean).length >= 2;
    tables.push(makeTable('docx', tables.length,
      looksHeader ? first.map((x, i) => x || `col${i + 1}`) : first.map((_, i) => `col${i + 1}`),
      looksHeader ? padded.slice(1) : padded, maxRows));
  }

  // Body text: one line per <w:p>, with <w:br/> and <w:tab/> honoured.
  const paras = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let p;
  while ((p = pRe.exec(xml)) !== null) paras.push(paraText(p[1] || ''));
  return { text: paras.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tables, warnings: [] };
}

function paraText(frag) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(frag)) !== null) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

module.exports = { extractDocx };
