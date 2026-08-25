'use strict';

const { Pool } = require('pg');
const { config } = require('./config');

if (!config.databaseUrl) {
  console.warn('[db] DATABASE_URL is not set — every authenticated request will fail.');
}

const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

/**
 * `sslmode` is stripped from the URL and the TLS decision made here instead.
 * pg is mid-way through changing what `sslmode=require` means — today it is an
 * alias for verify-full, tomorrow it will be libpq's weaker semantics — and it
 * prints a deprecation warning on every boot saying so. Deciding it in code
 * means the behaviour does not change under us when pg 9 lands.
 */
const connectionString = config.databaseUrl.replace(/([?&])sslmode=[^&]*&?/g, '$1').replace(/[?&]$/, '');

const pool = new Pool({
  connectionString,
  ssl: local ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
