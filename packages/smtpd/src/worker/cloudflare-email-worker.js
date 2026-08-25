/**
 * MailMint — Cloudflare Email Worker.
 *
 * Deploy this on the zone that owns your inbound domain and point an Email
 * Routing catch-all rule at it. It receives mail Cloudflare has already
 * accepted over TLS and streams the raw MIME to MailMint.
 *
 * KEEP THIS DUMB. On the Workers free plan an email handler that does real work
 * fails with EXCEEDED_CPU, and there is no retry after that. So: no MIME
 * parsing, no attachment handling, no base64, no dependencies. Stream the body
 * through and let the server do the thinking. If you are tempted to "improve"
 * this file by adding postal-mime or reading message.raw into memory: don't.
 *
 * Secrets (wrangler secret put …):
 *   MAILMINT_ENDPOINT   https://api.mailmint.example/inbound/cloudflare
 *   MAILMINT_SECRET     the same value as INTERNAL_SECRET on the server
 */

export default {
  async email(message, env, ctx) {
    const endpoint = env.MAILMINT_ENDPOINT;
    const secret = env.MAILMINT_SECRET;
    if (!endpoint || !secret) {
      // Misconfiguration is ours, not the sender's: temp-fail so mail is retried.
      throw new Error('MAILMINT_ENDPOINT or MAILMINT_SECRET is not set');
    }

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'message/rfc822',
          'x-mailmint-secret': secret,
          'x-mailmint-from': message.from,
          'x-mailmint-to': message.to,
          'x-mailmint-size': String(message.rawSize),
          'x-mailmint-worker': env.MAILMINT_ZONE || 'cloudflare-email-routing',
          'x-mailmint-message-id': message.headers.get('message-id') || '',
        },
        // message.raw is a ReadableStream; passing it straight through means the
        // message is never fully resident in the isolate.
        body: message.raw,
        duplex: 'half',
      });
    } catch (err) {
      // Network trouble reaching us. Temp-fail: the sending MTA will retry.
      throw new Error(`mailmint unreachable: ${err && err.message ? err.message : err}`);
    }

    if (res.ok) {
      // Optionally keep a copy in a real mailbox while you are still trusting us.
      if (env.MAILMINT_ALSO_FORWARD_TO && message.canBeForwarded) {
        ctx.waitUntil(message.forward(env.MAILMINT_ALSO_FORWARD_TO).catch(() => {}));
      }
      return;
    }

    // 404/410 mean there is no such mailbox. Reject IN SESSION so the sender is
    // told immediately — never accept-then-bounce, that is backscatter.
    if (res.status === 404 || res.status === 410) {
      message.setReject(`550 5.1.1 <${message.to}> unknown mailbox`);
      return;
    }
    if (res.status === 413) {
      message.setReject('552 5.3.4 message too large');
      return;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('mailmint rejected our credentials');
    }

    // Anything else (5xx, timeout) is temporary. Throwing makes Cloudflare
    // temp-fail the message so the sending MTA retries it later.
    throw new Error(`mailmint returned ${res.status}`);
  },

  // A tiny health endpoint, so `curl https://<worker>.workers.dev/` tells you
  // the worker is deployed before you point real mail at it.
  async fetch(request, env) {
    const configured = Boolean(env.MAILMINT_ENDPOINT && env.MAILMINT_SECRET);
    return new Response(
      JSON.stringify({ worker: 'mailmint-email', configured }),
      { status: configured ? 200 : 503, headers: { 'content-type': 'application/json' } },
    );
  },
};
