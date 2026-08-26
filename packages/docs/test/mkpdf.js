'use strict';
const zlib = require('node:zlib');

/**
 * A hand-rolled PDF writer, for tests only.
 *
 * Fixtures are built in code rather than committed as binaries so that every
 * one of them is readable, diffable and obviously minimal: when a table test
 * fails you can see the exact coordinates that produced it, which is not true
 * of a checked-in file someone generated in 2023.
 */
/**
 * @param {Array<string|Buffer>} bodies  object 1..N, in order. Object 1 must be
 *        the catalog. Buffers are used verbatim (that is how streams get in).
 */
function buildPdf(bodies) {
  let buf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets = [];
  for (let i = 0; i < bodies.length; i++) {
    offsets[i] = buf.length;
    const b = bodies[i];
    const chunk = Buffer.isBuffer(b)
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), b, Buffer.from('endobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${b}\nendobj\n`, 'latin1');
    buf = Buffer.concat([buf, chunk]);
  }
  const xrefAt = buf.length;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < bodies.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([buf, Buffer.from(xref, 'latin1')]);
}

function streamObj(dict, data, { deflate = false } = {}) {
  let body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  let extra = '';
  if (deflate) { body = zlib.deflateSync(body); extra = ' /Filter /FlateDecode'; }
  return Buffer.concat([
    Buffer.from(`<< ${dict}${extra} /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream\n', 'latin1'),
  ]);
}

/**
 * One page of text placed at exact coordinates.
 *
 * Object layout is fixed so the fixtures stay readable:
 *   1 Catalog · 2 Pages · 3 Font · 4 Contents · 5 Page · 6.. widget annotations
 *
 * @param {Array<{x:number,y:number,size?:number,text:string}>} items  y from the TOP
 */
function simplePdf(items, { width = 612, height = 792, rotate = 0, acroFields = null, encoding = null } = {}) {
  const ops = ['BT'];
  for (const it of items) {
    const size = it.size || 10;
    const esc = String(it.text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const tm = it.tm || [1, 0, 0, 1];
    ops.push(`/F1 ${size} Tf`, `${tm.join(' ')} ${it.x} ${height - it.y} Tm`, `(${esc}) Tj`);
  }
  ops.push('ET');

  const fields = acroFields || [];
  const annots = fields.map((_, i) => `${6 + i} 0 R`);
  const bodies = [];
  bodies[0] = `<< /Type /Catalog /Pages 2 0 R${fields.length ? ` /AcroForm << /Fields [${annots.join(' ')}] >>` : ''} >>`;
  bodies[1] = '<< /Type /Pages /Kids [5 0 R] /Count 1 >>';
  bodies[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${encoding ? ` /Encoding ${encoding}` : ''} >>`;
  bodies[3] = streamObj('', ops.join('\n'));
  bodies[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} `
    + '/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R'
    + `${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`;
  fields.forEach((f, i) => {
    bodies[5 + i] = `<< /Type /Annot /Subtype /Widget /FT /${f.type || 'Tx'} /T (${f.name}) `
      + `/V ${f.value === null ? '/Off' : `(${f.value})`} /Rect [0 0 100 20] /F 4 /P 5 0 R >>`;
  });
  return buildPdf(bodies);
}

/** A minimal, valid .xlsx built with zlib + a hand-written zip central directory. */
function makeXlsx(sheets) {
  const files = [];
  const shared = [];
  const idx = new Map();
  const sst = (v) => { if (!idx.has(v)) { idx.set(v, shared.length); shared.push(v); } return idx.get(v); };

  const sheetXmls = sheets.map((sheet) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        if (v === '' || v === null || v === undefined) return '';
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="s"><v>${sst(String(v))}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  files.push(['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>']);
  files.push(['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`]);
  sheetXmls.forEach((xml, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, xml]));
  files.push(['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`]);
  return zipOf(files);
}

function colName(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }
function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function zipOf(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { buildPdf, simplePdf, streamObj, makeXlsx, zipOf };
