'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

class HttpError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = opts.status || 0;
    this.body = opts.body || null;
    this.code = opts.code || 'http_error';
    /** 4xx (other than 408/429) will fail identically on a retry. */
    this.permanent = opts.permanent !== undefined ? opts.permanent
      : (this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429);
  }
}

/**
 * One request, JSON in / JSON out, with a real timeout on the whole exchange.
 * `http.request`'s own `timeout` option only covers socket inactivity, which is
 * not the same thing as "this call is taking too long".
 */
function request(url, opts = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json), 'utf8')
    : (opts.body ? Buffer.from(opts.body) : null);
  const headers = {
    accept: 'application/json',
    'user-agent': opts.userAgent || 'mailmint-intake/1.0',
    ...(payload ? { 'content-type': opts.contentType || 'application/json', 'content-length': payload.length } : {}),
    ...(opts.headers || {}),
  };
  const timeoutMs = opts.timeoutMs ?? 30000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: `${u.pathname}${u.search}`, method: opts.method || (payload ? 'POST' : 'GET'), headers,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > (opts.maxResponseBytes ?? 64 * 1024 * 1024)) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        if ((res.headers['content-type'] || '').includes('json')) {
          try { json = JSON.parse(text); } catch { /* leave null; text is kept */ }
        }
        const out = { status: res.statusCode, headers: res.headers, text, json, bytes: raw.length, raw };
        if (opts.throwOnError !== false && (res.statusCode < 200 || res.statusCode >= 300)) {
          finish(reject, new HttpError(
            `${opts.method || 'GET'} ${u.pathname} -> ${res.statusCode} ${(json && (json.error || json.message)) || text.slice(0, 300)}`,
            { status: res.statusCode, body: json || text },
          ));
          return;
        }
        finish(resolve, out);
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new HttpError(`request to ${u.host}${u.pathname} timed out after ${timeoutMs}ms`, { code: 'timeout' }));
    }, timeoutMs);
    req.on('error', (err) => finish(reject, new HttpError(`${err.message}`, { code: err.code || 'network' , permanent: false })));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request, HttpError };
