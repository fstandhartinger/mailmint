'use strict';
const zlib = require('node:zlib');

/**
 * A zip reader with exactly the features OOXML needs, and no more.
 *
 * We read the central directory rather than scanning local headers, because a
 * local header may carry sizes of zero with the real values in a trailing data
 * descriptor — a shape that spreadsheet exporters emit and that naive readers
 * silently truncate.
 *
 * Every entry is bounded. A zip bomb is a 200-byte attachment.
 */
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function findEocd(buf) {
  const start = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** @returns {Map<string,{offset:number,method:number,csize:number,size:number}>} */
function listEntries(buf) {
  const out = new Map();
  const eocd = findEocd(buf);
  if (eocd < 0) return out;
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) return out;   // zip64: not supported
  if (count > MAX_ENTRIES) count = MAX_ENTRIES;
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, { offset, method, csize, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, entry) {
  if (!entry) return null;
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const csize = entry.csize || 0;
  if (entry.size > MAX_ENTRY_BYTES || csize > MAX_ENTRY_BYTES) return null;
  const raw = buf.subarray(start, Math.min(buf.length, start + (csize || buf.length - start)));
  if (entry.method === 0) return raw.subarray(0, entry.size || raw.length);
  if (entry.method !== 8) return null;
  try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }); }
  catch {
    try { return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_ENTRY_BYTES }); }
    catch { return null; }
  }
}

function openZip(buf) {
  const entries = listEntries(buf);
  return {
    entries,
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read: (name) => readEntry(buf, entries.get(name)),
    text: (name) => { const b = readEntry(buf, entries.get(name)); return b ? b.toString('utf8') : null; },
  };
}

module.exports = { openZip, listEntries, readEntry };
