'use strict';

const { query } = require('./db');
const { log } = require('./log');

/**
 * Numbered migrations. Each entry runs exactly once, inside its own
 * transaction, and is recorded in `schema_migrations`. Never edit an entry that
 * has shipped — add a new one. The number is the contract with every database
 * that has already applied it.
 */
const MIGRATIONS = [
  {
    id: 1,
    name: 'accounts, keys, sessions',
    statements: [
      `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
      `CREATE TABLE IF NOT EXISTS accounts (
         id            BIGSERIAL PRIMARY KEY,
         email         TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         plan          TEXT NOT NULL DEFAULT 'free',
         quota_month   INTEGER NOT NULL DEFAULT 100,
         used_month    INTEGER NOT NULL DEFAULT 0,
         -- The month the counter belongs to. Rolled forward lazily on read, so
         -- quota never needs a cron and never resets late for one timezone.
         period_start  TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now() AT TIME ZONE 'UTC'),
         stripe_customer_id     TEXT,
         stripe_subscription_id TEXT,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
         id           BIGSERIAL PRIMARY KEY,
         account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         prefix       TEXT NOT NULL,
         hash         TEXT UNIQUE NOT NULL,
         name         TEXT NOT NULL DEFAULT 'default',
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         last_used_at TIMESTAMPTZ,
         revoked_at   TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS api_keys_account_idx ON api_keys(account_id)`,
      `CREATE TABLE IF NOT EXISTS sessions (
         id         TEXT PRIMARY KEY,
         account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at TIMESTAMPTZ NOT NULL
       )`,
    ],
  },
  {
    id: 2,
    name: 'mailboxes and schema versions',
    statements: [
      `CREATE TABLE IF NOT EXISTS mailboxes (
         id             TEXT PRIMARY KEY,
         account_id     BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         token          TEXT UNIQUE NOT NULL,
         slug           TEXT,
         name           TEXT NOT NULL DEFAULT 'Inbox',
         schema         JSONB NOT NULL DEFAULT '[]'::jsonb,
         schema_version INTEGER NOT NULL DEFAULT 1,
         webhook_url    TEXT,
         webhook_secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
         forward_to     TEXT,
         paused         BOOLEAN NOT NULL DEFAULT false,
         created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         deleted_at     TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS mailboxes_account_idx ON mailboxes(account_id, created_at)`,
      // The slug is only an alias, so it need only be unique per account: two
      // customers may both want "invoices", and the token still disambiguates.
      `CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_slug_idx ON mailboxes(account_id, slug) WHERE slug IS NOT NULL AND deleted_at IS NULL`,
      // Every schema a mailbox has ever had. A re-parse can name an old version,
      // and a user who broke their schema can roll back to the one that worked.
      `CREATE TABLE IF NOT EXISTS mailbox_schema_versions (
         mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
         version    INTEGER NOT NULL,
         schema     JSONB NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (mailbox_id, version)
       )`,
    ],
  },
  {
    id: 3,
    name: 'blobs, messages, attachments',
    statements: [
      // v1 storage: raw MIME and attachment bytes live in Postgres. No object
      // store yet — one fewer credential, one fewer outage mode. Everything in
      // here expires, and the reaper enforces it.
      `CREATE TABLE IF NOT EXISTS blobs (
         ref          TEXT PRIMARY KEY,
         account_id   BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
         kind         TEXT NOT NULL,
         content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
         bytes        BYTEA NOT NULL,
         size         INTEGER NOT NULL,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at   TIMESTAMPTZ NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS blobs_expires_idx ON blobs(expires_at)`,
      `CREATE TABLE IF NOT EXISTS messages (
         id           TEXT PRIMARY KEY,
         mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
         account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         from_email   TEXT,
         subject      TEXT,
         size         INTEGER NOT NULL DEFAULT 0,
         status       TEXT NOT NULL DEFAULT 'received',
         result       JSONB,
         needs_review BOOLEAN NOT NULL DEFAULT false,
         flags        TEXT[] NOT NULL DEFAULT '{}',
         raw_ref      TEXT,
         spam_score   REAL,
         envelope     JSONB NOT NULL DEFAULT '{}'::jsonb,
         schema_version INTEGER,
         error        JSONB
       )`,
      // The hot path: "the last N messages in this mailbox".
      `CREATE INDEX IF NOT EXISTS messages_mailbox_time_idx ON messages(mailbox_id, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS messages_account_time_idx ON messages(account_id, received_at DESC)`,
      `CREATE TABLE IF NOT EXISTS attachments (
         id           TEXT PRIMARY KEY,
         message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
         filename     TEXT,
         content_type TEXT,
         size         INTEGER NOT NULL DEFAULT 0,
         sha256       TEXT,
         storage_ref  TEXT,
         inline       BOOLEAN NOT NULL DEFAULT false,
         content_id   TEXT,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id)`,
    ],
  },
  {
    id: 4,
    name: 'events, webhook deliveries, usage',
    statements: [
      // `id` IS the polling cursor. bigserial rather than a timestamp because a
      // cursor must be strictly monotonic and unique; two events in the same
      // millisecond would otherwise let a poller skip one.
      `CREATE TABLE IF NOT EXISTS events (
         id         BIGSERIAL PRIMARY KEY,
         account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE CASCADE,
         type       TEXT NOT NULL,
         message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      // The other hot path: "everything after cursor X for this account".
      `CREATE INDEX IF NOT EXISTS events_account_id_idx ON events(account_id, id)`,
      `CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at)`,
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
         id              TEXT PRIMARY KEY,
         message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
         account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         url             TEXT NOT NULL,
         attempt         INTEGER NOT NULL DEFAULT 0,
         status_code     INTEGER,
         error           TEXT,
         next_attempt_at TIMESTAMPTZ,
         delivered_at    TIMESTAMPTZ,
         failed_at       TIMESTAMPTZ,
         locked_at       TIMESTAMPTZ,
         created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS webhook_queue_idx ON webhook_deliveries(next_attempt_at)
         WHERE delivered_at IS NULL AND failed_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS webhook_message_idx ON webhook_deliveries(message_id)`,
      `CREATE TABLE IF NOT EXISTS usage_events (
         id          BIGSERIAL PRIMARY KEY,
         account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         mailbox_id  TEXT,
         message_id  TEXT,
         kind        TEXT NOT NULL,
         billable    BOOLEAN NOT NULL DEFAULT true,
         llm_used    BOOLEAN NOT NULL DEFAULT false,
         model       TEXT,
         duration_ms INTEGER,
         ok          BOOLEAN NOT NULL DEFAULT true,
         error_code  TEXT,
         origin      TEXT,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS usage_events_account_time_idx ON usage_events(account_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS stripe_events (
         id         TEXT PRIMARY KEY,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    ],
  },
  {
    id: 5,
    name: 'review queue, attachment extraction, bulk reparse',
    statements: [
      // §1b(2): what packages/docs lifted out of a PDF, CSV or scan. Kept on the
      // attachment row rather than inside messages.result so a 40-page invoice's
      // extracted text does not have to be read to list a mailbox.
      `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extracted JSONB`,
      // "How do I find out that it went wrong" is the question the whole product
      // answers, so the review queue has to stay fast as a mailbox fills up.
      `CREATE INDEX IF NOT EXISTS messages_review_idx ON messages(account_id, received_at DESC)
         WHERE needs_review`,
      // Filtering by one specific flag — arithmetic_mismatch, table_truncated —
      // is an array containment test, which is what GIN is for.
      `CREATE INDEX IF NOT EXISTS messages_flags_idx ON messages USING gin(flags)`,
      // §1b(3): re-parsing a back catalogue is the hardest "no" in the category.
      // It is a job because it can span thousands of messages and several
      // minutes, and the caller must not hold a socket open for it.
      `CREATE TABLE IF NOT EXISTS reparse_jobs (
         id           TEXT PRIMARY KEY,
         account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
         status       TEXT NOT NULL DEFAULT 'queued',
         dry_run      BOOLEAN NOT NULL DEFAULT false,
         redeliver    BOOLEAN NOT NULL DEFAULT false,
         params       JSONB NOT NULL DEFAULT '{}'::jsonb,
         total        INTEGER NOT NULL DEFAULT 0,
         done         INTEGER NOT NULL DEFAULT 0,
         changed      INTEGER NOT NULL DEFAULT 0,
         failed       INTEGER NOT NULL DEFAULT 0,
         diffs        JSONB NOT NULL DEFAULT '[]'::jsonb,
         error        TEXT,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         started_at   TIMESTAMPTZ,
         finished_at  TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS reparse_jobs_queue_idx ON reparse_jobs(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS reparse_jobs_account_idx ON reparse_jobs(account_id, created_at DESC)`,
      // Raw MIME now outlives attachment bytes (see PLANS.rawRetentionDays): a
      // re-parse works from the original bytes, so throwing them away after a
      // week would make the headline feature a lie. Blobs already carry their
      // own expiry, so existing raw blobs are extended in place rather than
      // waiting for new mail to arrive under the new rule.
      `UPDATE blobs SET expires_at = created_at + interval '30 days'
        WHERE kind = 'raw' AND expires_at < created_at + interval '30 days'`,
    ],
  },
  {
    id: 6,
    name: 'idempotent delivery, connector state, forwarding confirmations',
    statements: [
      // Every inbound path is at-least-once. The SMTP sender retries when our
      // 250 is lost on the way back; the IMAP connector advances its high-water
      // mark only after a 2xx, so an interruption between "delivered" and
      // "persisted" re-delivers. Neither side can fix that alone — the receiver
      // is the only place idempotency can live. Without this a customer's
      // workflow runs twice on one email, which is exactly the silent wrongness
      // this product exists to argue against.
      //
      // The key is the sender's own Message-ID (or whatever idempotency key the
      // caller supplies), scoped to the mailbox: two mailboxes may legitimately
      // both receive the same broadcast.
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_message_id TEXT`,
      // Partial, because mail without a Message-ID is legal and must still be
      // accepted — it simply cannot be deduplicated.
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_source_id_idx
         ON messages(mailbox_id, source_message_id) WHERE source_message_id IS NOT NULL`,
      // The IMAP connector's per-connection high-water mark. It lives here so the
      // connector itself is stateless and can be restarted or moved between
      // hosts without replaying an inbox.
      `CREATE TABLE IF NOT EXISTS connector_state (
         connection_id TEXT PRIMARY KEY,
         account_id    BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
         mailbox_id    TEXT REFERENCES mailboxes(id) ON DELETE CASCADE,
         state         JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS connector_state_mailbox_idx ON connector_state(mailbox_id)`,
      // Gmail, Outlook, Zoho, Fastmail, iCloud and Yahoo all send a confirmation
      // mail when a user points forwarding at an address. Every competitor makes
      // the user go hunting for it in the mailbox they just forwarded away.
      `CREATE TABLE IF NOT EXISTS forwarding_confirmations (
         id           TEXT PRIMARY KEY,
         account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
         provider     TEXT,
         code         TEXT,
         link         TEXT,
         -- False when the link host is not the provider's own domain. Anyone can
         -- email a fake "confirm your forwarding" to a mailbox, so this column
         -- decides whether the dashboard is allowed to render an anchor at all.
         link_trusted BOOLEAN NOT NULL DEFAULT false,
         from_email   TEXT,
         subject      TEXT,
         message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
         dismissed_at TIMESTAMPTZ,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS forwarding_confirmations_mailbox_idx
         ON forwarding_confirmations(mailbox_id, created_at DESC)`,
    ],
  },
];

async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
     id         INTEGER PRIMARY KEY,
     name       TEXT NOT NULL,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`);
  const { rows } = await query(`SELECT id FROM schema_migrations`);
  const done = new Set(rows.map((r) => Number(r.id)));
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // Each migration is one transaction: a half-applied migration is the one
    // failure mode that needs a human, so it must not be possible.
    const client = await require('./db').pool.connect();
    try {
      await client.query('BEGIN');
      for (const sql of m.statements) await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`, [m.id, m.name]);
      await client.query('COMMIT');
      applied += 1;
      log.info('migrate.applied', { migration: m.id, name: m.name });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      log.error('migrate.failed', { migration: m.id, name: m.name, error: e.message });
      throw e;
    } finally {
      client.release();
    }
  }
  log.info('migrate.done', { applied, total: MIGRATIONS.length });
}

module.exports = { migrate, MIGRATIONS };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
