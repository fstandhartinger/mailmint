#!/usr/bin/env node
'use strict';
// Entry point. Reads the environment once, wires the pieces, listens.

const config = require('./config');
const log = require('./log');
const { SmtpServer } = require('./server');
const { IntakeHttpServer } = require('./intake-http');
const { MailboxResolver } = require('./resolver');
const { Deliverer } = require('./deliver');
const { Spool } = require('./spool');
const { DnsClient } = require('./auth/dns');

async function main() {
  const cfg = config.build();
  log.setLevel(cfg.logLevel);

  if (!cfg.internalSecret) {
    log.error('smtp.config_error', { error: 'INTERNAL_SECRET is not set; the API will reject every call' });
  }

  const spool = new Spool(cfg);
  await spool.init();

  const resolver = new MailboxResolver(cfg);
  const deliverer = new Deliverer({
    ...cfg,
    spool,
    onApiFailure: process.env.ON_API_FAILURE === 'defer' ? 'defer' : 'accept',
  });
  const dnsClient = new DnsClient({ servers: cfg.dnsServers, timeoutMs: cfg.authTimeoutMs });

  const server = new SmtpServer(cfg, { resolver, deliverer, dnsClient });
  server.on('error', (e) => {
    log.error('smtp.server_error', { error: e.message, code: e.code });
    if (e.code === 'EACCES' || e.code === 'EADDRINUSE') process.exit(1);
  });

  await server.listen();

  // Webhook intake (Cloudflare Email Worker / Mailgun / CloudMailin / generic).
  // Optional: set INTAKE_HTTP_PORT to run it. It is the primary path when we do
  // not own a box with port 25.
  let intake = null;
  const intakePort = Number(process.env.INTAKE_HTTP_PORT || 0);
  if (intakePort > 0) {
    intake = new IntakeHttpServer(cfg, {
      resolver,
      deliverer,
      dnsClient,
      secrets: {
        cloudflare: { secret: cfg.internalSecret },
        generic: { secret: cfg.internalSecret },
        cloudmailin: { secret: process.env.CLOUDMAILIN_SECRET || null },
        mailgun: { signingKey: process.env.MAILGUN_SIGNING_KEY || null },
      },
    });
    await intake.listen(intakePort, process.env.INTAKE_HTTP_HOST || '0.0.0.0');
  }

  deliverer.start();
  // Drain whatever survived the last restart.
  deliverer.drain().then((s) => log.info('mail.spool_startup_drain', s)).catch(() => {});

  const shutdown = async (sig) => {
    log.info('smtp.shutdown', { signal: sig, sessions: server.sessions.size, spooled: spool.sizeSync() });
    deliverer.stop();
    try { await server.close(); } catch { /* ignore */ }
    if (intake) { try { await intake.close(); } catch { /* ignore */ } }
    // Give in-flight sessions a moment, then go.
    setTimeout(() => process.exit(0), 5000).unref();
    const wait = setInterval(() => {
      if (server.sessions.size === 0) { clearInterval(wait); process.exit(0); }
    }, 200);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('smtp.unhandled_rejection', { error: String(e && e.message || e) }));
  process.on('uncaughtException', (e) => {
    log.error('smtp.uncaught_exception', { error: e.message, stack: e.stack });
  });
}

if (require.main === module) {
  main().catch((e) => {
    log.error('smtp.boot_failed', { error: e.message, stack: e.stack });
    process.exit(1);
  });
}

module.exports = { main };
