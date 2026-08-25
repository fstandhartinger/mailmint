'use strict';

const { query } = require('./db');
const { config, PLANS } = require('./config');
const { log } = require('./log');

/**
 * Retention, enforced in-process on a timer rather than by a cron somewhere
 * else. Storing other people's email in Postgres is only defensible because
 * this runs: a table nobody deletes from is a liability that grows.
 *
 * Three different windows, on purpose. Attachment bytes are the bulk of the
 * storage and go first. Raw MIME lives as long as the plan promises, because
 * that window IS how far back a re-parse can reach. Events are the shortest of
 * all, since a poller that is a week behind has bigger problems.
 */
/**
 * The retention CASE, built from PLANS so the reaper and the docs cannot drift.
 * A message row must outlive its raw bytes, never the other way round: a
 * re-parse needs both, and a row pointing at bytes that are gone is a 410 where
 * the customer expected their mail.
 */
function planIntervalSql(field) {
  const arms = Object.values(PLANS)
    .map((p) => `WHEN '${p.id}' THEN ${p[field]}`)
    .join(' ');
  return `(CASE a.plan ${arms} ELSE ${PLANS.free[field]} END || ' days')::interval`;
}

async function reap() {
  const started = Date.now();
  const out = {};
  try {
    // Blobs carry their own expiry, set from the plan when they were written, so
    // this is one indexed scan and it covers raw and attachment bytes alike.
    out.blobs = (await query(`DELETE FROM blobs WHERE expires_at < now()`)).rowCount;
    // Events go first: an event whose message has been deleted would be an event
    // the n8n trigger hands the user with a null body. Their window is the 7
    // days §5 promises, which is shorter than the message window on every plan.
    out.events = (await query(
      `DELETE FROM events WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(config.eventRetentionDays)],
    )).rowCount;
    out.messages = (await query(
      `DELETE FROM messages m USING accounts a
        WHERE a.id = m.account_id AND m.received_at < now() - ${planIntervalSql('rawDays')}`,
    )).rowCount;
    out.deliveries = (await query(
      `DELETE FROM webhook_deliveries WHERE created_at < now() - ($1 || ' days')::interval
        AND (delivered_at IS NOT NULL OR failed_at IS NOT NULL)`, [String(config.retentionDays)],
    )).rowCount;
    out.reparse_jobs = (await query(
      `DELETE FROM reparse_jobs WHERE finished_at < now() - interval '30 days'`,
    )).rowCount;
    out.sessions = (await query(`DELETE FROM sessions WHERE expires_at < now()`)).rowCount;
    out.usage = (await query(`DELETE FROM usage_events WHERE created_at < now() - interval '400 days'`)).rowCount;
  } catch (e) {
    log.warn('reaper.failed', { error: String(e.message || e) });
    return null;
  }
  const total = Object.values(out).reduce((a, b) => a + (b || 0), 0);
  if (total) {
    log.info('reaper.done', {
      ...out, ms: Date.now() - started,
      raw_days_by_plan: Object.fromEntries(Object.values(PLANS).map((p) => [p.id, p.rawDays])),
      event_retention_days: config.eventRetentionDays,
    });
  }
  return out;
}

function startReaper() {
  setInterval(() => { reap().catch(() => {}); }, 10 * 60 * 1000).unref();
  setTimeout(() => { reap().catch(() => {}); }, 20000).unref();
}

module.exports = { reap, startReaper };
