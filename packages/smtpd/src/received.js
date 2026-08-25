'use strict';
// Trace headers we stamp on every accepted message.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date-time, always in UTC (+0000). */
function rfc5322Date(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * Build the Received: header for one message. RFC 5321 §4.4.
 * @param {object} o
 * @param {string} o.helo        what the client said in EHLO/HELO
 * @param {string} o.remoteIp
 * @param {string|null} o.reverseDns
 * @param {string} o.hostname    us
 * @param {string} o.id          our queue id
 * @param {boolean} o.tls
 * @param {object|null} o.tlsInfo  { protocol, cipher }
 * @param {string|null} o.forAddress   single recipient, omitted when there are several
 * @param {boolean} o.smtputf8
 * @param {Date} [o.date]
 */
function receivedHeader(o) {
  const withProto = o.tls
    ? (o.smtputf8 ? 'UTF8SMTPS' : 'ESMTPS')
    : (o.esmtp ? (o.smtputf8 ? 'UTF8SMTP' : 'ESMTP') : 'SMTP');

  const fromPart = o.reverseDns
    ? `${o.helo} (${o.reverseDns} [${o.remoteIp}])`
    : `${o.helo} ([${o.remoteIp}])`;

  const lines = [];
  lines.push(`Received: from ${fromPart}`);
  lines.push(`\tby ${o.hostname} with ${withProto} id ${o.id}`);
  if (o.tls && o.tlsInfo) {
    lines.push(`\t(version=${o.tlsInfo.protocol} cipher=${o.tlsInfo.cipher})`);
  }
  if (o.forAddress) lines.push(`\tfor <${o.forAddress}>;`);
  else lines[lines.length - 1] += ';';
  lines.push(`\t${rfc5322Date(o.date || new Date())}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { receivedHeader, rfc5322Date };
