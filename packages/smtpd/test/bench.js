'use strict';
// Throughput and memory benchmark.
//
//   node test/bench.js [--sessions 100] [--messages 1000] [--size 8192]
//
// Drives the real listener over real TCP sockets with the hand-written client.
// Authentication is off by default because it is dominated by DNS latency and
// would measure the network, not us; run with --auth to include it.

const os = require('node:os');
const { startStack, SmtpClient } = require('./helpers');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? Number(v) : true;
}

const SESSIONS = Number(arg('sessions', 100));
const MESSAGES = Number(arg('messages', 1000));
const SIZE = Number(arg('size', 8192));
const WITH_AUTH = process.argv.includes('--auth');

const MBX = 'k7m2xq4h9bwz@parse.example.com';

function message(size) {
  const filler = 'The quick brown fox jumps over the lazy dog. ';
  let body = '';
  while (body.length < size) body += filler;
  return Buffer.from(
    'Message-ID: <bench-' + Math.random().toString(36).slice(2) + '@bench.test>\r\n' +
    'Date: Tue, 25 Aug 2026 09:14:01 +0000\r\n' +
    'From: Bench <bench@acme.com>\r\n' +
    `To: <${MBX}>\r\n` +
    'Subject: benchmark\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    '\r\n' +
    body.slice(0, size) + '\r\n' +
    '.\r\n', 'utf8');
}

function mem(label, base) {
  const m = process.memoryUsage();
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  const delta = base ? ` (rss +${((m.rss - base.rss) / 1048576).toFixed(1)} MB)` : '';
  return `${label}: rss ${mb(m.rss)}, heapUsed ${mb(m.heapUsed)}, external ${mb(m.external)}${delta}`;
}

async function main() {
  console.log(`# node ${process.version} on ${os.type()} ${os.release()} — ` +
    `${os.cpus().length}x ${os.cpus()[0].model.trim()}`);
  console.log(`# sessions=${SESSIONS} messages=${MESSAGES} size=${SIZE}B auth=${WITH_AUTH}`);

  const stack = await startStack({
    mailboxes: [MBX],
    env: {
      MAX_SESSIONS_PER_IP: '100000',
      MAX_CONCURRENT_SESSIONS: '100000',
      SPF_ENABLED: String(WITH_AUTH),
      DKIM_ENABLED: String(WITH_AUTH),
      DMARC_ENABLED: String(WITH_AUTH),
    },
  });

  const payload = message(SIZE);
  const before = process.memoryUsage();
  console.log('#', mem('before'));

  // --- phase 1: open SESSIONS concurrent sessions and hold them open --------
  const t0 = Date.now();
  const clients = [];
  await Promise.all(Array.from({ length: SESSIONS }, async () => {
    const c = new SmtpClient({ port: stack.port, timeoutMs: 60000 });
    await c.connect();
    await c.read();
    await c.cmd('EHLO bench.test');
    clients.push(c);
  }));
  const connectMs = Date.now() - t0;
  if (global.gc) global.gc();
  const held = process.memoryUsage();
  console.log(`# ${SESSIONS} concurrent sessions established in ${connectMs} ms ` +
    `(${(connectMs / SESSIONS).toFixed(2)} ms each)`);
  console.log('#', mem(`with ${SESSIONS} sessions open`, before));
  console.log(`#   -> ${((held.rss - before.rss) / SESSIONS / 1024).toFixed(1)} KB rss per open session`);

  // --- phase 2: push MESSAGES through them ---------------------------------
  const perClient = Math.ceil(MESSAGES / clients.length);
  const t1 = Date.now();
  let sent = 0;
  let failed = 0;
  await Promise.all(clients.map(async (c) => {
    for (let i = 0; i < perClient; i++) {
      if (sent >= MESSAGES) return;
      sent++;
      try {
        await c.write(`MAIL FROM:<bench@acme.com>\r\nRCPT TO:<${MBX}>\r\nDATA\r\n`, { silent: true });
        await c.read(); await c.read();
        const d = await c.read();
        if (d.code !== 354) { failed++; continue; }
        await c.write(payload, { silent: true });
        const r = await c.read();
        if (r.code !== 250) failed++;
      } catch { failed++; }
    }
  }));
  const runMs = Date.now() - t1;
  const peak = process.memoryUsage();

  await Promise.all(clients.map(async (c) => { try { await c.cmd('QUIT'); } catch { /* ignore */ } c.destroy(); }));

  console.log('');
  console.log('# ---------------- results ----------------');
  console.log(`# messages accepted : ${stack.api.delivered.length} / ${MESSAGES} (${failed} failed)`);
  console.log(`# wall clock        : ${runMs} ms`);
  console.log(`# throughput        : ${(stack.api.delivered.length / (runMs / 1000)).toFixed(1)} messages/sec`);
  console.log(`# bytes/sec         : ${((stack.api.delivered.length * payload.length) / (runMs / 1000) / 1048576).toFixed(1)} MB/sec`);
  console.log(`# mean latency      : ${(runMs / Math.max(1, stack.api.delivered.length) * SESSIONS).toFixed(2)} ms per message per session`);
  console.log('#', mem('peak', before));
  console.log(`# peak rss delta    : ${((peak.rss - before.rss) / 1048576).toFixed(1)} MB`);

  await stack.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
