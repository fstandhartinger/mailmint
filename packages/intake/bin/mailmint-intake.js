#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */
const { load } = require('../src/config');
const { Connector, ConnectorPool } = require('../src/connector');
const { createProvider } = require('../src/providers');
const { ImapClient } = require('../src/imap');
const forwarding = require('../src/forwarding');
const { log } = require('../src/log');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `mailmint-intake <command>

  poll             one polling cycle for every configured connection, then exit
  watch            poll forever (IDLE where the server supports it)
  scan-forwarding  look for a forwarding confirmation code/link and print it
  probe            connect to an IMAP server, print capabilities and the transcript

Config: --config <file.json>, or env
  IMAP_HOST/IMAP_PORT/IMAP_USER/IMAP_PASS/IMAP_FOLDER/IMAP_INITIAL, or
  MAILTM_CREDENTIALS=<inbox.json>
  MAILBOX_TOKEN=<12-char mailmint token>  MAILMINT_API_URL=...  INTERNAL_SECRET=...
`;

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];

  if (!cmd || a.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

  if (cmd === 'probe') {
    const client = new ImapClient({
      host: a.host, port: a.port ? Number(a.port) : undefined,
      secure: a.tls !== '0' && a.tls !== false,
      user: a.user, pass: a.pass, accessToken: a.token,
      transcript: true,
      tlsOptions: a.insecure ? { rejectUnauthorized: false } : {},
    });
    const greeting = await client.connect();
    console.log('greeting:', greeting.status, greeting.text);
    console.log('capabilities:', (await client.capability()).join(' '));
    if (a.user) {
      await client.login();
      console.log('authenticated. post-auth capabilities:', [...client.capabilities].join(' '));
      const box = await client.select(a.folder || 'INBOX');
      console.log('mailbox:', JSON.stringify(box));
      const uids = await client.uidSearch('ALL');
      console.log(`uids: ${uids.length} (${uids.slice(-5).join(',')})`);
    }
    await client.logout();
    if (a.transcript) console.log(client.transcript.join('\n'));
    return;
  }

  const conf = load({ file: a.config });
  if (!conf.connections.length) { console.error('no connections configured'); process.exit(2); }

  if (cmd === 'scan-forwarding') {
    for (const c of conf.connections) {
      const provider = createProvider(c, { logger: log });
      await provider.open();
      const found = await forwarding.scan(provider, { limit: Number(a.limit || 25) });
      await provider.close();
      console.log(JSON.stringify({ connection: c.id, confirmations: found }, null, 2));
    }
    return;
  }

  if (cmd === 'poll') {
    const pool = new ConnectorPool(conf.connections, {});
    for (const c of pool.connectors) {
      try {
        let more = true;
        while (more) { const r = await c.runOnce({ limit: a.limit ? Number(a.limit) : undefined }); more = r.more; }
      } catch (err) {
        log.error('intake.poll_failed', { connection_id: c.id, error: err.message });
        process.exitCode = 1;
      } finally {
        await c.close().catch(() => {});
      }
    }
    console.log(JSON.stringify({ summaries: pool.summaries() }, null, 2));
    return;
  }

  if (cmd === 'watch') {
    const pool = new ConnectorPool(conf.connections, {});
    const shutdown = () => {
      log.info('intake.shutdown', { summaries: pool.summaries() });
      pool.stopAll();
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await pool.runAll();
    console.log(JSON.stringify({ summaries: pool.summaries() }, null, 2));
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  log.error('intake.failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
