'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A connection is a mailbox somewhere else plus the MailMint mailbox its mail
 * belongs in. Config comes from a JSON file (many connections, the real
 * deployment shape) or from the environment (one connection, which is what a
 * developer and a docker-compose service want).
 */
function fromEnv(env = process.env) {
  const conns = [];
  if (env.IMAP_HOST) {
    conns.push({
      id: env.INTAKE_ID || `imap:${env.IMAP_USER}@${env.IMAP_HOST}`,
      provider: 'imap',
      mailbox_token: env.MAILBOX_TOKEN,
      host: env.IMAP_HOST,
      port: env.IMAP_PORT ? Number(env.IMAP_PORT) : undefined,
      secure: env.IMAP_TLS === undefined ? undefined : env.IMAP_TLS !== '0',
      user: env.IMAP_USER,
      pass: env.IMAP_PASS,
      accessToken: env.IMAP_OAUTH_TOKEN || undefined,
      folder: env.IMAP_FOLDER || 'INBOX',
      initial: env.IMAP_INITIAL || 'new',
      markSeen: env.IMAP_MARK_SEEN !== '0',
      unseenOnly: env.IMAP_UNSEEN_ONLY === '1',
    });
  }
  if (env.MAILTM_CREDENTIALS || env.MAILTM_ADDRESS) {
    conns.push({
      id: env.INTAKE_ID || `mailtm:${env.MAILTM_ADDRESS || 'file'}`,
      provider: 'mailtm',
      mailbox_token: env.MAILBOX_TOKEN,
      credentialsFile: env.MAILTM_CREDENTIALS || undefined,
      address: env.MAILTM_ADDRESS || undefined,
      password: env.MAILTM_PASSWORD || undefined,
      token: env.MAILTM_TOKEN || undefined,
    });
  }
  return conns;
}

function load(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.file || env.MAILMINT_INTAKE_CONFIG;
  let conf = { connections: [] };
  if (file) {
    conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(conf.connections)) throw new Error(`${file}: expected {"connections":[...]}`);
  } else {
    conf.connections = fromEnv(env);
  }
  const apiUrl = opts.apiUrl || conf.api_url || env.MAILMINT_API_URL || env.API_URL || 'http://127.0.0.1:3100';
  const internalSecret = opts.internalSecret || conf.internal_secret || env.INTERNAL_SECRET || '';
  const stateFile = opts.stateFile || conf.state_file || env.INTAKE_STATE_FILE
    || path.join(process.cwd(), '.mailmint-intake-state.json');
  const connections = conf.connections.map((c) => ({
    apiUrl, internalSecret, stateFile, ...c,
  }));
  for (const c of connections) {
    if (!c.mailbox_token && !c.mailboxToken) {
      throw new Error(`connection "${c.id || '(unnamed)'}" has no mailbox_token: mail has to land in a MailMint mailbox`);
    }
  }
  return { apiUrl, internalSecret, stateFile, connections };
}

module.exports = { load, fromEnv };
