'use strict';
// On-disk spool. Every accepted message is written here BEFORE we answer 250,
// so an API outage — or a kill -9 — cannot lose mail.
//
// Layout:
//   <SPOOL_DIR>/<id>.eml     raw MIME
//   <SPOOL_DIR>/<id>.json    envelope + attempt bookkeeping (written last)
//   <SPOOL_DIR>/failed/…     entries that exhausted their retries
//
// The .json is written after the .eml has been fsynced and is what the drainer
// scans for, so a half-written entry is never picked up.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const log = require('./log');

function newId() {
  // time-sortable: ms in base36 + randomness
  return Date.now().toString(36).padStart(9, '0') + '-' + crypto.randomBytes(8).toString('hex');
}

class Spool {
  constructor(opts) {
    this.dir = opts.spoolDir;
    this.failedDir = opts.spoolKeepFailedDir || path.join(this.dir, 'failed');
    this.maxAttempts = opts.spoolMaxAttempts ?? 24;
    this.fsync = opts.spoolFsync !== false;
    this.ready = false;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(this.failedDir, { recursive: true });
    this.ready = true;
  }

  /** Durably write one message. Returns the spool id. Throws if it cannot. */
  async put(raw, meta) {
    if (!this.ready) await this.init();
    const id = meta.id || newId();
    const eml = path.join(this.dir, `${id}.eml`);
    const json = path.join(this.dir, `${id}.json`);

    const tmpEml = eml + '.tmp';
    const fh = await fsp.open(tmpEml, 'w', 0o600);
    try {
      await fh.writeFile(raw);
      if (this.fsync) await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpEml, eml);

    const record = { id, attempts: 0, next_attempt: 0, created_at: new Date().toISOString(), ...meta };
    const tmpJson = json + '.tmp';
    const jh = await fsp.open(tmpJson, 'w', 0o600);
    try {
      await jh.writeFile(JSON.stringify(record));
      if (this.fsync) await jh.sync();
    } finally {
      await jh.close();
    }
    await fsp.rename(tmpJson, json);
    return id;
  }

  async remove(id) {
    await Promise.allSettled([
      fsp.unlink(path.join(this.dir, `${id}.json`)),
      fsp.unlink(path.join(this.dir, `${id}.eml`)),
    ]);
  }

  async read(id) {
    const meta = JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), 'utf8'));
    const raw = await fsp.readFile(path.join(this.dir, `${id}.eml`));
    return { meta, raw };
  }

  async list() {
    if (!this.ready) await this.init();
    const names = await fsp.readdir(this.dir);
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
  }

  async touch(id, patch) {
    const p = path.join(this.dir, `${id}.json`);
    const meta = JSON.parse(await fsp.readFile(p, 'utf8'));
    Object.assign(meta, patch);
    await fsp.writeFile(p + '.tmp', JSON.stringify(meta), { mode: 0o600 });
    await fsp.rename(p + '.tmp', p);
    return meta;
  }

  async fail(id, reason) {
    const src = path.join(this.dir, `${id}.json`);
    const srcEml = path.join(this.dir, `${id}.eml`);
    try {
      const meta = JSON.parse(await fsp.readFile(src, 'utf8'));
      meta.failed_reason = reason;
      meta.failed_at = new Date().toISOString();
      await fsp.writeFile(path.join(this.failedDir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
      await fsp.rename(srcEml, path.join(this.failedDir, `${id}.eml`));
      await fsp.unlink(src);
    } catch (e) {
      log.error('spool.fail_error', { spool_id: id, error: e.message });
    }
  }

  /** Bytes currently queued — cheap health signal for the log line. */
  sizeSync() {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).length;
    } catch { return 0; }
  }
}

module.exports = { Spool, newId };
