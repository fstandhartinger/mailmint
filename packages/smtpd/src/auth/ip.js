'use strict';
// IPv4/IPv6 parsing and CIDR matching, no dependencies.

function parseIPv4(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) return null;
    if (m[i + 1].length > 1 && m[i + 1][0] === '0') return null; // no octal-ish
    b[i] = n;
  }
  return b;
}

function parseIPv6(s) {
  if (typeof s !== 'string') return null;
  let str = s.trim();
  if (str.startsWith('[') && str.endsWith(']')) str = str.slice(1, -1);
  const pct = str.indexOf('%');
  if (pct !== -1) str = str.slice(0, pct);
  if (!str.includes(':')) return null;

  let v4tail = null;
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    v4tail = parseIPv4(tail);
    if (!v4tail) return null;
    str = str.slice(0, lastColon + 1) +
      ((v4tail[0] << 8 | v4tail[1]).toString(16)) + ':' + ((v4tail[2] << 8 | v4tail[3]).toString(16));
  }

  const dbl = str.indexOf('::');
  let head, back;
  if (dbl !== -1) {
    if (str.indexOf('::', dbl + 1) !== -1) return null;
    head = str.slice(0, dbl) ? str.slice(0, dbl).split(':') : [];
    back = str.slice(dbl + 2) ? str.slice(dbl + 2).split(':') : [];
  } else {
    head = str.split(':');
    back = [];
  }
  const groups = head.length + back.length;
  if (groups > 8) return null;
  if (dbl === -1 && groups !== 8) return null;
  const parts = head.concat(new Array(8 - groups).fill('0'), back);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = parts[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    b[i * 2] = n >> 8;
    b[i * 2 + 1] = n & 0xff;
  }
  return b;
}

/** Returns {family:4|6, bytes:Buffer, text:string} or null. */
function parseIP(s) {
  if (typeof s !== 'string') return null;
  let str = s.trim();
  // Node hands us IPv4-mapped IPv6 for v4 clients on a dual-stack socket.
  const mapped = str.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) str = mapped[1];
  const v4 = parseIPv4(str);
  if (v4) return { family: 4, bytes: v4, text: str };
  const v6 = parseIPv6(str);
  if (v6) return { family: 6, bytes: v6, text: str.toLowerCase() };
  return null;
}

function inCidr(ip, netText, prefix) {
  const net = parseIP(netText);
  if (!net || !ip) return false;
  if (net.family !== ip.family) return false;
  const bits = prefix === null || prefix === undefined
    ? (ip.family === 4 ? 32 : 128)
    : prefix;
  const max = ip.family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return false;
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (ip.bytes[i] !== net.bytes[i]) return false;
  const rem = bits & 7;
  if (rem) {
    const mask = 0xff << (8 - rem) & 0xff;
    if ((ip.bytes[full] & mask) !== (net.bytes[full] & mask)) return false;
  }
  return true;
}

/** SPF macro %{i}: dotted quad for v4, dot-separated nibbles for v6. */
function ipMacro(ip) {
  if (ip.family === 4) return ip.bytes.join('.');
  const nibbles = [];
  for (const byte of ip.bytes) {
    nibbles.push((byte >> 4).toString(16), (byte & 0xf).toString(16));
  }
  return nibbles.join('.');
}

/** Reverse-DNS name for an address. */
function reverseName(ip) {
  if (ip.family === 4) return `${ip.bytes[3]}.${ip.bytes[2]}.${ip.bytes[1]}.${ip.bytes[0]}.in-addr.arpa`;
  const nibbles = [];
  for (const byte of ip.bytes) nibbles.push((byte >> 4).toString(16), (byte & 0xf).toString(16));
  return nibbles.reverse().join('.') + '.ip6.arpa';
}

module.exports = { parseIP, parseIPv4, parseIPv6, inCidr, ipMacro, reverseName };
