'use strict';

const express = require('express');
const path = require('node:path');

const { config } = require('./config');
const { log } = require('./log');
const ids = require('./ids');
const { ApiError } = require('./errors');
const { migrate } = require('./migrate');
const { escapeHtml } = require('./html');
const api = require('./api');
const internal = require('./internal');
const web = require('./web');
const site = require('./site');   // static landing page + docs; serves '/' and '/docs'
const billing = require('./billing');
const webhooks = require('./webhooks');
const reparse = require('./reparse');
const { startReaper } = require('./reaper');
const { parserAvailable } = require('./parser');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * §6: one `api.request` line per request, with the request id that every other
 * line written while handling it also carries. The id is generated here and
 * bound into async-local storage, so a log line from a background parse started
 * by this request still names it.
 */
app.use((req, res, next) => {
  req.id = ids.requestId();
  res.set('X-Request-Id', req.id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log.info('api.request', {
      request_id: req.id,
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : req.path,
      status: res.statusCode,
      ms: Math.round(ms * 100) / 100,
      account: req.account ? Number(req.account.id) : null,
      key_prefix: req.account && req.account.key_prefix ? req.account.key_prefix : null,
      ip: req.ip,
      bytes: Number(res.get('content-length') || 0),
    });
  });
  log.withRequestId(req.id, next);
});

// Stripe verifies against the untouched body, so this mounts before the JSON parser.
app.use('/stripe', billing.router);

app.use(express.json({ limit: config.maxRequestBytes }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({
  ok: true,
  parser: parserAvailable(),
  inbound_domain: config.inboundDomain,
  internal_api: Boolean(config.internalSecret),
  billing: billing.enabled(),
}));

app.use('/internal', internal.router);
app.use('/v1', api.router);
app.use('/', site.router);   // static /, /docs, /quickstart, /n8n — must precede web.router
app.use('/', web.router);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use((req, res) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/internal/')) {
    return res.status(404).json({ error: {
      code: 'unknown_endpoint',
      message: `There is no ${req.method} ${req.path} endpoint.`,
      hint: 'The endpoint list is at /docs.',
      request_id: req.id,
    } });
  }
  return res.status(404).type('html').send(web.shell('Not found', `<main class="auth">
    <a class="logo" href="/">Mail<span>Mint</span></a><h1>Not found</h1>
    <p class="sub">There is nothing at <code>${escapeHtml(req.path)}</code>.</p>
    <p class="alt"><a href="/dashboard">Dashboard</a> · <a href="/docs">Docs</a></p></main>`));
});

const wantsHtml = (req) => !req.path.startsWith('/v1/') && !req.path.startsWith('/internal/')
  && !req.path.startsWith('/stripe/') && (req.get('accept') || '').includes('text/html');

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : (err && err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) log.error('api.error', { request_id: req.id, error: String(err && err.stack || err), path: req.path });
  else log.warn('api.rejected', { request_id: req.id, code: err.code || err.type || 'error', message: String(err.message || err), path: req.path });

  if (wantsHtml(req)) {
    return res.status(status).type('html').send(web.shell(status >= 500 ? 'Something went wrong' : 'That did not work', `
      <main class="auth"><a class="logo" href="/">Mail<span>Mint</span></a>
      <h1>${status >= 500 ? 'Something went wrong' : 'That did not work'}</h1>
      <p class="sub">${escapeHtml(status >= 500 ? 'This one is on us. Your mail is unaffected — nothing is ever dropped because a page failed.' : err.message)}</p>
      ${err.hint ? `<p class="sub">${escapeHtml(err.hint)}</p>` : ''}
      <p class="alt"><a href="/dashboard">Back to the dashboard</a> · <a href="/docs">Docs</a></p>
      <p class="alt small">Quote this if you get in touch: <code>${escapeHtml(req.id)}</code></p></main>`));
  }
  if (err instanceof ApiError) {
    const body = err.toJSON(req.id);
    if (body.error.docs && body.error.docs.startsWith('/')) body.error.docs = `${config.publicUrl}${body.error.docs}`;
    return res.status(status).json(body);
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: {
      code: 'request_too_large',
      message: `The request body is larger than the ${(config.maxRequestBytes / 1048576).toFixed(0)} MB limit.`,
      request_id: req.id,
    } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON.', request_id: req.id } });
  }
  return res.status(500).json({ error: {
    code: 'internal_error', message: 'Something went wrong on our side.', request_id: req.id,
  } });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { error: String(reason && reason.stack ? reason.stack : reason) });
});

async function main() {
  await migrate();
  startReaper();
  // The queue lives in the database, so any process pointed at that database
  // would otherwise pick up its deliveries — a developer's laptop included.
  // Only a process that says it is the worker runs one.
  if (process.env.WEBHOOK_WORKER !== '0') webhooks.startWorker();
  if (process.env.REPARSE_WORKER !== '0') reparse.startWorker();
  if (!parserAvailable()) {
    log.warn('boot.parser_missing', { note: 'mailmint-parser could not be required; parsing will fail or fall back' });
  }
  if (!config.internalSecret) {
    log.warn('boot.internal_disabled', { note: 'INTERNAL_SECRET is unset — /internal/* answers 503, so no mail can be delivered' });
  }
  const server = app.listen(config.port, () => {
    log.info('boot.listening', {
      port: config.port, public_url: config.publicUrl || null, inbound_domain: config.inboundDomain,
      origin: config.origin, webhook_worker: process.env.WEBHOOK_WORKER !== '0', billing: billing.enabled(),
    });
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;

  const shutdown = (sig) => {
    log.info('boot.shutdown', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { app, main };
