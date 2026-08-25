'use strict';
// Shared HTTP plumbing for the webhook adapters. Zero dependencies: enough of
// multipart/form-data and urlencoded to read what mail providers actually POST.

const MAX_BODY = 30 * 1024 * 1024;

/** Read the whole request body. Accepts a Node stream, a Buffer, or a string. */
async function readBody(req, { maxBytes = MAX_BODY } = {}) {
  if (Buffer.isBuffer(req)) return req;
  if (typeof req === 'string') return Buffer.from(req, 'utf8');
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (typeof req.arrayBuffer === 'function') return Buffer.from(await req.arrayBuffer());
  if (typeof req.on !== 'function') throw new Error('adapter: cannot read a body from this request');

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, len)));
    req.on('error', reject);
  });
}

function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;   // fetch Headers
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function contentType(req) {
  return String(headerOf(req, 'content-type') || '').toLowerCase();
}

function boundaryOf(ct) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  return m ? (m[1] || m[2]).trim() : null;
}

/**
 * Parse multipart/form-data into { fields: {name: string}, files: {name: {filename, contentType, data}} }.
 * Field values are decoded as UTF-8; file parts keep their bytes.
 */
function parseMultipart(buf, boundary) {
  const fields = Object.create(null);
  const files = Object.create(null);
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  let pos = buf.indexOf(delim);
  if (pos === -1) return { fields, files };

  while (pos !== -1) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing --
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start, 'latin1');
    if (headerEnd === -1) break;
    const rawHeaders = buf.subarray(start, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    const bodyEnd = next === -1 ? buf.length : next - 2; // strip the CRLF before the delimiter
    const data = buf.subarray(bodyStart, Math.max(bodyStart, bodyEnd));

    const disp = /content-disposition:([^\r\n]*)/i.exec(rawHeaders);
    const partType = (/content-type:([^\r\n]*)/i.exec(rawHeaders) || [, ''])[1].trim();
    if (disp) {
      const nameM = /name="([^"]*)"/i.exec(disp[1]);
      const fileM = /filename="([^"]*)"/i.exec(disp[1]);
      const name = nameM ? nameM[1] : null;
      if (name) {
        if (fileM) files[name] = { filename: fileM[1], contentType: partType, data };
        else fields[name] = data.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

function parseUrlEncoded(buf) {
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
  return out;
}

/** Normalise anything into { fields, files, json, raw }. */
async function readForm(req) {
  const raw = await readBody(req);
  const ct = contentType(req);
  if (ct.startsWith('multipart/form-data')) {
    const b = boundaryOf(ct);
    if (!b) throw new Error('multipart body without a boundary');
    return { ...parseMultipart(raw, b), json: null, raw };
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    return { fields: parseUrlEncoded(raw), files: {}, json: null, raw };
  }
  if (ct.startsWith('application/json')) {
    let json = null;
    try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
    return { fields: {}, files: {}, json, raw };
  }
  return { fields: {}, files: {}, json: null, raw };
}

/** Line endings on the wire are CRLF; webhook bodies often are not. */
function toCrlf(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  return Buffer.from(s.replace(/\r\n|\r|\n/g, '\r\n'), 'latin1');
}

function stripAngles(a) {
  const s = String(a == null ? '' : a).trim();
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(stripAngles).filter(Boolean);
  return String(v).split(',').map(stripAngles).filter(Boolean);
}

/** Every adapter returns this shape. */
function envelope({ from, to, helo, remoteIp, tls }) {
  return {
    from: stripAngles(from || ''),
    to: asArray(to),
    helo: helo || null,
    remote_ip: remoteIp || null,
    tls: tls === undefined ? null : Boolean(tls),
  };
}

module.exports = {
  readBody, readForm, headerOf, contentType, boundaryOf,
  parseMultipart, parseUrlEncoded, toCrlf, envelope, stripAngles, asArray,
  MAX_BODY,
};
