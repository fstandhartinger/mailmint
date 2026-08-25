'use strict';
// Intake adapters. Every one turns a provider's webhook into exactly the same
// two things the SMTP path produces:
//
//     { rawMime: Buffer, envelope: { from, to[], helo, remote_ip, tls }, meta }
//
// so the parser and the API never learn how a message arrived.

const cloudflare = require('./cloudflare');
const mailgun = require('./mailgun');
const cloudmailin = require('./cloudmailin');
const generic = require('./generic');

const ADAPTERS = { cloudflare, mailgun, cloudmailin, generic };

function get(name) {
  const a = ADAPTERS[String(name || '').toLowerCase()];
  if (!a) throw new Error(`unknown intake adapter: ${name}`);
  return a;
}

module.exports = { ...ADAPTERS, get, ADAPTERS };
