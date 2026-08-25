'use strict';
// Configuration. Read from the environment ONCE, at startup, then frozen.
// Nothing in this package reads process.env outside this file.

const path = require('node:path');

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function str(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v;
}

function list(name, def) {
  const v = str(name, null);
  if (v === null) return def;
  return v.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function build(env = process.env) {
  const prev = process.env;
  if (env !== process.env) process.env = env;
  try {
    const cfg = {
      // --- listener -------------------------------------------------------
      host: str('SMTP_HOST', '0.0.0.0'),
      port: int('SMTP_PORT', 25),
      // What we announce in the banner / EHLO reply / Received header.
      hostname: str('SMTP_HOSTNAME', require('node:os').hostname()),

      // --- routing --------------------------------------------------------
      // Domains we accept mail FOR. Anything else is 550 5.7.1 relay denied.
      inboundDomains: list('INBOUND_DOMAINS', null) ||
        list('INBOUND_DOMAIN', null) ||
        ['parse.example.com'],

      // --- limits ---------------------------------------------------------
      maxMessageBytes: int('MAX_MESSAGE_BYTES', 26214400), // 26 MB, matches SIZE
      maxRecipients: int('MAX_RECIPIENTS', 100),
      maxSessionsPerIp: int('MAX_SESSIONS_PER_IP', 10),
      maxConcurrentSessions: int('MAX_CONCURRENT_SESSIONS', 500), // global in-flight cap
      sessionTimeoutMs: int('SESSION_TIMEOUT_MS', 300000), // 5 min
      maxErrorsPerSession: int('MAX_ERRORS_PER_SESSION', 20),
      maxLineBytes: int('MAX_LINE_BYTES', 4096), // RFC 5321 §4.5.3.1.6 is 1000; be generous
      maxUnknownRcptPerSession: int('MAX_UNKNOWN_RCPT_PER_SESSION', 10),

      // --- TLS ------------------------------------------------------------
      // STARTTLS is only advertised when BOTH paths are set and readable.
      tlsKeyPath: str('TLS_KEY_PATH', null),
      tlsCertPath: str('TLS_CERT_PATH', null),
      tlsCaPath: str('TLS_CA_PATH', null),
      tlsMinVersion: str('TLS_MIN_VERSION', 'TLSv1.2'),

      // --- API handoff ----------------------------------------------------
      apiUrl: str('API_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      internalSecret: str('INTERNAL_SECRET', null),
      apiTimeoutMs: int('API_TIMEOUT_MS', 15000),
      resolveTimeoutMs: int('RESOLVE_TIMEOUT_MS', 5000),
      resolvePositiveTtlMs: int('RESOLVE_POSITIVE_TTL_MS', 60000), // 60s
      resolveNegativeTtlMs: int('RESOLVE_NEGATIVE_TTL_MS', 10000), // 10s
      resolveCacheMax: int('RESOLVE_CACHE_MAX', 10000),

      // --- spool ----------------------------------------------------------
      spoolDir: str('SPOOL_DIR', path.join(process.cwd(), 'spool')),
      spoolDrainIntervalMs: int('SPOOL_DRAIN_INTERVAL_MS', 15000),
      spoolMaxAttempts: int('SPOOL_MAX_ATTEMPTS', 24),
      spoolKeepFailedDir: str('SPOOL_FAILED_DIR', null), // defaults to <spoolDir>/failed
      // fsync every spooled message before answering 250. This is the whole
      // point of the spool, and on a slow disk it is also the throughput
      // ceiling (~1 message per fsync pair). Turn it off only if you accept
      // losing the last few seconds of mail on a power cut.
      spoolFsync: bool('SPOOL_FSYNC', true),

      // --- authentication checks -----------------------------------------
      spfEnabled: bool('SPF_ENABLED', true),
      dkimEnabled: bool('DKIM_ENABLED', true),
      dmarcEnabled: bool('DMARC_ENABLED', true),
      authTimeoutMs: int('AUTH_TIMEOUT_MS', 10000),
      dnsServers: list('DNS_SERVERS', null),

      // --- logging --------------------------------------------------------
      logLevel: str('LOG_LEVEL', 'info'),
    };
    if (cfg.spoolKeepFailedDir === null) cfg.spoolKeepFailedDir = path.join(cfg.spoolDir, 'failed');
    cfg.tlsEnabled = Boolean(cfg.tlsKeyPath && cfg.tlsCertPath);
    return Object.freeze(cfg);
  } finally {
    if (env !== prev) process.env = prev;
  }
}

module.exports = { build, _helpers: { int, bool, str, list } };
