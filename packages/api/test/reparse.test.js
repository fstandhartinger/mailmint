'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const reparse = require('../src/reparse');

let key; let accountId;

before(async () => { await H.start(); ({ key, accountId } = await H.newAccount()); });
after(H.stop);

/** The worker is not running in the suite, so jobs are stepped by hand. */
async function runJob(jobId) {
  const { rows } = await H.query(`SELECT * FROM reparse_jobs WHERE id = $1`, [jobId]);
  await H.query(`UPDATE reparse_jobs SET status = 'running', started_at = now() WHERE id = $1`, [jobId]);
  await reparse.runJob(rows[0]);
  return H.req(`/v1/reparse/${jobId}`, { key });
}

async function mailboxWithHistory(schema, n = 3) {
  const mb = await H.newMailbox(key, { schema });
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { json } = await H.deliver(mb, {
      wait: true,
      raw: H.rawMime({ to: mb.address, subject: `Invoice INV-90${i} from Acme Ltd`, text: `Invoice INV-90${i}\r\nTotal: $31.50\r\n` }),
    });
    ids.push(json.message_id);
  }
  return { mb, ids };
}

describe('bulk re-parse', () => {
  test('a dry run reports what would change and writes nothing', async () => {
    const { mb, ids } = await mailboxWithHistory([{ name: 'total', type: 'number' }]);
    const beforeRows = await H.query(`SELECT id, result FROM messages WHERE id = ANY($1)`, [ids]);
    const beforeFields = Object.fromEntries(beforeRows.rows.map((r) => [r.id, Object.keys(r.result.fields).sort()]));

    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, {
      method: 'POST', key,
      body: { dry_run: true, limit: 10, schema: [{ name: 'vendor', type: 'string' }] },
    });
    assert.equal(queued.res.status, 202);
    assert.match(queued.json.job_id, /^rpj_/);
    assert.equal(queued.json.total, ids.length);
    assert.equal(queued.json.dry_run, true);
    assert.match(queued.json.poll, /\/v1\/reparse\/rpj_/);

    const done = await runJob(queued.json.job_id);
    assert.equal(done.json.status, 'succeeded');
    assert.equal(done.json.done, ids.length);
    assert.equal(done.json.changed, ids.length, 'swapping the whole schema changes every message');
    assert.ok(done.json.diffs.length);

    const d = done.json.diffs[0];
    const vendor = d.fields.find((f) => f.field === 'vendor');
    assert.ok(vendor, `expected a diff for vendor, got ${JSON.stringify(d.fields.map((f) => f.field))}`);
    assert.equal(vendor.before.value, null);

    // And the point of a dry run: nothing moved.
    const afterRows = await H.query(`SELECT id, result FROM messages WHERE id = ANY($1)`, [ids]);
    for (const r of afterRows.rows) {
      assert.deepEqual(Object.keys(r.result.fields).sort(), beforeFields[r.id],
        'a dry run must not touch a stored result');
    }
  });

  test('a real run rewrites the stored results', async () => {
    const { mb, ids } = await mailboxWithHistory([{ name: 'total', type: 'number' }], 2);
    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, {
      method: 'POST', key, body: { limit: 10, schema: [{ name: 'vendor', type: 'string' }] },
    });
    await runJob(queued.json.job_id);
    const { rows } = await H.query(`SELECT result FROM messages WHERE id = ANY($1)`, [ids]);
    for (const r of rows) assert.deepEqual(Object.keys(r.result.fields), ['vendor']);
  });

  test('re-delivery is OFF by default — a back-catalogue re-parse fires no webhooks', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const { mb, ids } = await mailboxWithHistory([{ name: 'total', type: 'number' }], 3);
    await H.req(`/v1/mailboxes/${mb.id}`, { method: 'PATCH', key, body: { webhook_url: url } });
    // The deliveries queued by the original arrivals, before the URL was set: none.
    const baseline = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = ANY($1)`, [ids]);

    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, { method: 'POST', key, body: { limit: 10 } });
    const done = await runJob(queued.json.job_id);
    assert.equal(done.json.redeliver, false);
    const after = await H.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE message_id = ANY($1)`, [ids]);
    assert.equal(after.rows[0].n, baseline.rows[0].n,
      're-parsing must not queue a single webhook unless re-delivery was asked for by name');
    await listener.close();
  });

  test('re-delivery ON queues one webhook per changed message, and they verify', async () => {
    const listener = H.webhookListener();
    const url = await listener.listen();
    const { mb, ids } = await mailboxWithHistory([{ name: 'total', type: 'number' }], 2);
    const patched = await H.req(`/v1/mailboxes/${mb.id}`, { method: 'PATCH', key, body: { webhook_url: url } });
    const secret = patched.json.mailbox.webhook_secret;

    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, {
      method: 'POST', key, body: { limit: 10, redeliver: true, schema: [{ name: 'vendor', type: 'string' }] },
    });
    const done = await runJob(queued.json.job_id);
    assert.equal(done.json.redeliver, true);
    assert.equal(done.json.changed, 2);

    for (const id of ids) await H.flushWebhooks(id);
    assert.equal(listener.received.length, 2);
    for (const got of listener.received) {
      const check = H.verifySignatureIndependently(secret, got.body, got.headers['x-mailmint-signature']);
      assert.equal(check.ok, true, check.why);
      assert.deepEqual(Object.keys(JSON.parse(got.body).fields), ['vendor'], 're-delivery must carry the NEW result');
    }
    await listener.close();
  });

  test('a bulk re-parse costs no quota — the mail was already paid for', async () => {
    const { mb } = await mailboxWithHistory([{ name: 'total', type: 'number' }], 3);
    const before = await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId]);
    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, { method: 'POST', key, body: { limit: 10 } });
    await runJob(queued.json.job_id);
    const after = await H.query(`SELECT used_month FROM accounts WHERE id = $1`, [accountId]);
    assert.equal(after.rows[0].used_month, before.rows[0].used_month);
  });

  test('it can be narrowed to the messages that need review', async () => {
    const { mb } = await mailboxWithHistory([{ name: 'po_number', type: 'string', required: true }], 2);
    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, {
      method: 'POST', key, body: { needs_review: true, dry_run: true, limit: 10 },
    });
    assert.equal(queued.json.total, 2, 'both messages are missing the required field');

    const narrow = await H.req(`/v1/mailboxes/${mb.id}/reparse`, {
      method: 'POST', key, body: { flag: 'arithmetic_mismatch', dry_run: true, limit: 10 },
    });
    assert.equal(narrow.json.total, 0, 'no message carries that flag');
  });

  test('a job on someone else\'s account is not visible', async () => {
    const { mb } = await mailboxWithHistory([{ name: 'total', type: 'number' }], 1);
    const queued = await H.req(`/v1/mailboxes/${mb.id}/reparse`, { method: 'POST', key, body: { dry_run: true } });
    const stranger = await H.newAccount();
    const { res } = await H.req(`/v1/reparse/${queued.json.job_id}`, { key: stranger.key });
    assert.equal(res.status, 404);
  });
});

describe('the review queue', () => {
  test('needs_review and a specific flag are both filterable', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key, {
      schema: [{ name: 'total', type: 'number' }, { name: 'po_number', type: 'string', required: true }],
    });
    const { json } = await H.deliver(mb, { wait: true });

    const all = await H.req('/v1/messages', { key: account.key });
    assert.equal(all.json.data.length, 1);

    const review = await H.req('/v1/messages?needs_review=true', { key: account.key });
    assert.equal(review.json.data.length, 1);
    assert.equal(review.json.data[0].id, json.message_id);
    assert.equal(review.json.data[0].needs_review, true);

    const byFlag = await H.req('/v1/messages?flag=missing_required:po_number', { key: account.key });
    assert.equal(byFlag.json.data.length, 1);

    const noSuchFlag = await H.req('/v1/messages?flag=arithmetic_mismatch', { key: account.key });
    assert.equal(noSuchFlag.json.data.length, 0);
  });

  test('view=review says which flag, which field, and what the evidence was', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'po_number', type: 'string', required: true }] });
    await H.deliver(mb, { wait: true });
    const { json } = await H.req('/v1/messages?needs_review=true&view=review', { key: account.key });
    const row = json.data[0];
    assert.ok(Array.isArray(row.issues) && row.issues.length, JSON.stringify(row));
    const issue = row.issues.find((i) => i.flag === 'missing_required:po_number');
    assert.ok(issue);
    assert.equal(issue.field, 'po_number');
    assert.equal(issue.value, null);
    assert.equal(issue.evidence, null);
  });

  test('the dashboard review page shows the flagged field and its evidence', async () => {
    const account = await H.newAccount();
    const mb = await H.newMailbox(account.key, { schema: [{ name: 'po_number', type: 'string', required: true }] });
    await H.deliver(mb, { wait: true });
    const page = await H.req('/dashboard/review', { cookie: account.cookie });
    assert.equal(page.res.status, 200);
    assert.match(page.text, /missing_required:po_number/);
    assert.match(page.text, /Evidence in the message/);
    assert.match(page.text, /Re-parse with the current schema/);
  });

  test('needs_review counts the two flags nobody else can produce', () => {
    const { needsReview } = require('../src/parser');
    assert.equal(needsReview(['rule_llm_disagreement:total']), true);
    assert.equal(needsReview(['arithmetic_mismatch']), true);
    assert.equal(needsReview(['low_confidence:x']), true);
    assert.equal(needsReview(['hallucinated_evidence:x']), true);
    // These say something happened, not that a human must look.
    assert.equal(needsReview(['forwarded']), false);
    assert.equal(needsReview(['no_schema']), false);
    assert.equal(needsReview(['ocr_used']), false);
  });
});

describe('retention', () => {
  test('raw bytes outlive attachment bytes, because a re-parse needs the raw', async () => {
    const { PLANS } = require('../src/config');
    for (const p of Object.values(PLANS)) {
      assert.ok(p.rawDays > p.blobDays, `${p.id}: raw ${p.rawDays}d must outlive attachments ${p.blobDays}d`);
    }
    const mb = await H.newMailbox(key);
    const { json } = await H.deliver(mb, { wait: true });
    const { rows } = await H.query(
      `SELECT b.kind, EXTRACT(EPOCH FROM (b.expires_at - b.created_at))/86400 AS days
         FROM blobs b JOIN messages m ON m.raw_ref = b.ref WHERE m.id = $1`, [json.message_id],
    );
    assert.equal(rows.length, 1);
    assert.equal(Math.round(rows[0].days), PLANS.free.rawDays);
  });

  test('the docs quote the retention the code actually enforces', async () => {
    const { PLANS } = require('../src/config');
    const docs = await H.req('/docs');
    for (const p of Object.values(PLANS)) {
      assert.match(docs.text, new RegExp(`${p.rawDays} days`), `docs never mention ${p.id}'s ${p.rawDays} day window`);
    }
  });
});

describe('attachment extraction', () => {
  /**
   * packages/docs is being written separately; what is asserted here is the half
   * this service owns — that an `extracted` object survives a round trip through
   * the database and is shaped correctly on the way out. The extraction itself is
   * that package's test.
   */
  test('extracted survives storage and is trimmed unless asked for in full', async () => {
    const mb = await H.newMailbox(key);
    const { json } = await H.deliver(mb, { wait: true });
    const longText = 'x'.repeat(9000);
    const extracted = { kind: 'pdf', text: longText, pages: 4, tables: [{ headers: ['a'], rows: [['1']] }], meta: { extractor: 'test', ms: 12, ocr: false, warnings: [] } };

    const attId = `att_${require('../src/ids').ulid()}`;
    await H.query(
      `INSERT INTO attachments (id, message_id, filename, content_type, size, extracted)
       VALUES ($1,$2,'invoice.pdf','application/pdf',1234,$3)`,
      [attId, json.message_id, JSON.stringify(extracted)],
    );
    await H.query(
      `UPDATE messages SET result = jsonb_set(result, '{attachments}', $2::jsonb) WHERE id = $1`,
      [json.message_id, JSON.stringify([{ id: attId, filename: 'invoice.pdf', content_type: 'application/pdf', size: 1234, inline: false, content_id: null, extracted }])],
    );

    const { config } = require('../src/config');
    const dflt = await H.req(`/v1/messages/${json.message_id}`, { key });
    const a = dflt.json.attachments[0];
    assert.equal(a.extracted.kind, 'pdf');
    assert.equal(a.extracted.pages, 4);
    assert.equal(a.extracted.text.length, config.extractedTextPreview, 'the default must not carry megabytes of OCR text');
    assert.equal(a.extracted.text_truncated, true);
    assert.equal(a.extracted.text_length, 9000);

    const full = await H.req(`/v1/messages/${json.message_id}?include=extracted_text`, { key });
    assert.equal(full.json.attachments[0].extracted.text.length, 9000);

    const without = await H.req(`/v1/messages/${json.message_id}?exclude=extracted`, { key });
    assert.equal(without.json.attachments[0].extracted, undefined);

    // And the list view says enough to know whether the data is in the file.
    const list = await H.req(`/v1/messages?mailbox_id=${mb.id}`, { key });
    const summary = list.json.data.find((m) => m.id === json.message_id);
    assert.equal(summary.attachments[0].extracted.kind, 'pdf');
    assert.equal(summary.attachments[0].extracted.text_length, 9000);
    assert.equal(summary.attachments[0].extracted.text, undefined, 'a list call must never carry the text');
  });
});
