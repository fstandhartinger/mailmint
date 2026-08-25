'use strict';

/**
 * A fake IMAP server over a real socket.
 *
 * The point is that the tests are *socket* tests: bytes go over TCP, framing
 * happens for real, and responses can be written in awkward chunk sizes to
 * reproduce the boundary bugs that only ever show up against a real server.
 * The dialogue below is copied from Dovecot 2.3 and from imap.gmail.com — the
 * capability strings, the response text, the order of untagged lines.
 *
 * Command framing on this side reuses the client's own ResponseAssembler,
 * because IMAP literals are symmetric: `LOGIN {5}` from a client is framed
 * exactly like `BODY[] {5}` from a server. Using one implementation for both
 * directions is also how the literal handling gets tested in both directions.
 */

const net = require('node:net');
const tls = require('node:tls');
const { ResponseAssembler } = require('../src/imap');

const DOVECOT_CAPS = 'IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ AUTH=PLAIN AUTH=LOGIN';
const DOVECOT_PREAUTH_CAPS = 'IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS AUTH=PLAIN';
const GMAIL_CAPS = 'IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584';
const GMAIL_PREAUTH_CAPS = 'IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 XYZZY SASL-IR AUTH=XOAUTH2 AUTH=PLAIN AUTH=PLAIN-CLIENTTOKEN AUTH=OAUTHBEARER AUTH=XOAUTH';

let uidSeq = 1000;

function makeMessage(opts = {}) {
  uidSeq += 1;
  const body = opts.raw !== undefined ? opts.raw : [
    `Message-ID: <${opts.messageId || `m${uidSeq}@example.test`}>`,
    `From: ${opts.from || 'Sender Name <sender@example.test>'}`,
    'To: k7m2xq4h9bwz@parse.example.com',
    `Subject: ${opts.subject || `Test message ${uidSeq}`}`,
    'Date: Tue, 25 Aug 2026 09:14:01 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.text || 'Hello.',
    '',
  ].join('\r\n');
  return {
    uid: opts.uid !== undefined ? opts.uid : uidSeq,
    flags: opts.flags || [],
    internaldate: opts.internaldate || '25-Aug-2026 09:14:03 +0000',
    raw: Buffer.from(body, 'utf8'),
  };
}

class FakeImapServer {
  constructor(opts = {}) {
    this.dialect = opts.dialect || 'dovecot';
    this.messages = opts.messages || [];
    this.uidvalidity = opts.uidvalidity || 1724500000;
    this.user = opts.user || 'user@example.test';
    this.pass = opts.pass || 'correct horse';
    this.oauthToken = opts.oauthToken || null;
    this.chunkSize = opts.chunkSize || 0;       // 0 = write whole responses
    this.chunkDelayMs = opts.chunkDelayMs || 0;
    this.supportsIdle = opts.supportsIdle !== false;
    this.supportsLiteralPlus = opts.supportsLiteralPlus !== false;
    this.requireStartTls = !!opts.requireStartTls;
    this.tlsOptions = opts.tlsOptions || null;
    this.secure = !!opts.secure;
    this.log = [];                               // every command the server saw
    this.connections = 0;
    this.onCommand = opts.onCommand || null;     // hook for tests
    this.dropAfter = opts.dropAfter || null;     // command name to die on
    this.server = null;
    this.sockets = new Set();
  }

  capabilityString(authenticated) {
    if (this.dialect === 'gmail') {
      let c = authenticated ? GMAIL_CAPS : GMAIL_PREAUTH_CAPS;
      if (!this.supportsIdle) c = c.replace(' IDLE', '');
      return c;
    }
    let c = authenticated ? DOVECOT_CAPS : DOVECOT_PREAUTH_CAPS;
    if (!this.supportsIdle) c = c.replace(' IDLE', '');
    if (!this.supportsLiteralPlus) c = c.replace(' LITERAL+', '');
    if (!this.requireStartTls) c = c.replace(' STARTTLS', '');
    return c;
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      const handler = (sock) => this._session(sock);
      this.server = this.secure && this.tlsOptions
        ? tls.createServer(this.tlsOptions, handler)
        : net.createServer(handler);
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address()));
    });
  }

  get port() { return this.server.address().port; }

  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }

  _session(sock) {
    this.connections += 1;
    this.sockets.add(sock);
    const st = {
      authenticated: false, selected: null, idling: false, idleTag: null,
      pendingLiteral: null, sock, secure: this.secure,
    };
    sock._st = st;
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    this._attach(sock, st);
    this._write(sock, `* OK [CAPABILITY ${this.capabilityString(false)}] Dovecot (Ubuntu) ready.`);
  }

  _attach(sock, st) {
    const asm = new ResponseAssembler({
      maxLiteralBytes: 64 * 1024 * 1024,
      onLiteralStart: (size, plus) => {
        // The sending side is blocked until it hears this, unless it used
        // LITERAL+ ("{N+}") and did not wait.
        if (!plus) this._write(sock, `+ Ready for ${size} bytes of literal data`);
      },
    });
    st.asm = asm;
    sock.on('data', (chunk) => {
      // DONE terminates IDLE and is NOT a tagged command.
      if (st.idling) {
        const text = chunk.toString('utf8');
        if (/^DONE\r?\n/i.test(text)) {
          st.idling = false;
          this.log.push('DONE');
          this._write(sock, `${st.idleTag} OK Idle completed.`);
          const rest = text.replace(/^DONE\r?\n/i, '');
          if (rest) asm.push(Buffer.from(rest, 'utf8')).forEach((r) => this._command(sock, st, r));
          return;
        }
      }
      let responses;
      try { responses = asm.push(chunk); } catch (err) { sock.destroy(err); return; }
      for (const r of responses) this._command(sock, st, r);
    });
  }

  /**
   * Queued per socket. Responses must not interleave just because the server
   * is writing them three bytes at a time: a real server's TCP stream is one
   * ordered sequence of bytes, and without the queue the test would be
   * exercising garbage rather than chunking.
   */
  _write(sock, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(`${data}\r\n`, 'utf8');
    if (!sock._q) sock._q = [];
    sock._q.push(buf);
    this._drain(sock);
  }

  _drain(sock) {
    if (sock._draining) return;
    sock._draining = true;
    const step = () => {
      if (sock.destroyed || !sock._q.length) { sock._draining = false; return; }
      const buf = sock._q[0];
      // Deliberately awful chunking: the client must not care where TCP splits.
      const n = this.chunkSize ? Math.min(this.chunkSize, buf.length) : buf.length;
      sock.write(buf.subarray(0, n));
      if (n >= buf.length) sock._q.shift();
      else sock._q[0] = buf.subarray(n);
      if (!this.chunkSize) {
        sock._draining = false;
        if (sock._q.length) this._drain(sock);
        return;
      }
      if (this.chunkDelayMs) setTimeout(step, this.chunkDelayMs);
      else setImmediate(step);
    };
    step();
  }

  /** Raw bytes with no trailing CRLF added (used to build FETCH responses). */
  _writeRaw(sock, buf) { this._write(sock, Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')); }

  _command(sock, st, segments) {
    const line = segments.filter((s) => s.t === 'text').map((s) => s.s).join(' ');
    const literals = segments.filter((s) => s.t === 'lit').map((s) => s.buf);
    const firstLine = segments[0].t === 'text' ? segments[0].s : '';
    const sp = firstLine.indexOf(' ');
    const tag = firstLine.slice(0, sp);
    const rest = firstLine.slice(sp + 1);
    const name = rest.split(' ')[0].toUpperCase();
    const upper = rest.toUpperCase();
    this.log.push(line.replace(/(LOGIN\s+\S+\s+).*/i, '$1<redacted>'));
    if (this.onCommand) this.onCommand(name, rest, st);
    if (this.dropAfter && this.dropAfter === name) { sock.destroy(); return; }

    switch (name) {
      case 'CAPABILITY':
        this._write(sock, `* CAPABILITY ${this.capabilityString(st.authenticated)}`);
        this._write(sock, `${tag} OK Pre-login capabilities listed, post-login capabilities have more.`);
        return;

      case 'STARTTLS': {
        if (!this.tlsOptions) { this._write(sock, `${tag} NO STARTTLS not configured`); return; }
        this._write(sock, `${tag} OK Begin TLS negotiation now.`);
        sock.removeAllListeners('data');
        const secured = new tls.TLSSocket(sock, { isServer: true, ...this.tlsOptions });
        secured.on('error', () => {});
        this.sockets.add(secured);
        st.secure = true;
        this._attach(secured, st);
        st.sock = secured;
        return;
      }

      case 'LOGIN': {
        const [u, p] = literals.length >= 2
          ? [literals[0].toString('utf8'), literals[1].toString('utf8')]
          : parseLoginArgs(rest);
        if (u === this.user && p === this.pass) {
          st.authenticated = true;
          this._write(sock, `${tag} OK [CAPABILITY ${this.capabilityString(true)}] Logged in`);
        } else {
          this._write(sock, `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.`);
        }
        return;
      }

      case 'AUTHENTICATE': {
        const mech = rest.split(/\s+/)[1] || '';
        const ir = rest.split(/\s+/)[2] || null;
        if (mech.toUpperCase() !== 'XOAUTH2') { this._write(sock, `${tag} NO Unsupported mechanism`); return; }
        const finish = (blob) => {
          const decoded = Buffer.from(blob || '', 'base64').toString('utf8');
          const m = /user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01/.exec(decoded);
          if (m && this.oauthToken && m[2] === this.oauthToken && m[1] === this.user) {
            st.authenticated = true;
            this._write(sock, `${tag} OK ${this.user} authenticated (Success)`);
          } else {
            // Gmail's real failure shape: a continuation carrying JSON, then a
            // NO only after the client answers with an empty line.
            const err = Buffer.from(JSON.stringify({ status: '401', schemes: 'Bearer', scope: 'https://mail.google.com/' })).toString('base64');
            st.awaitingOauthAck = tag;
            this._write(sock, `+ ${err}`);
          }
        };
        if (ir) { finish(ir); return; }
        st.oauthPending = finish;
        this._write(sock, '+ ');
        return;
      }

      case 'SELECT':
      case 'EXAMINE': {
        if (!st.authenticated) { this._write(sock, `${tag} NO Not authenticated`); return; }
        const box = rest.split(' ').slice(1).join(' ').replace(/^"|"$/g, '');
        st.selected = box;
        const msgs = this.messages;
        st.reportedExists = msgs.length;
        this._write(sock, '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
        this._write(sock, '* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.');
        this._write(sock, `* ${msgs.length} EXISTS`);
        this._write(sock, '* 0 RECENT');
        this._write(sock, `* OK [UIDVALIDITY ${this.uidvalidity}] UIDs valid`);
        this._write(sock, `* OK [UIDNEXT ${(msgs.length ? Math.max(...msgs.map((m) => m.uid)) : 0) + 1}] Predicted next UID`);
        this._write(sock, `${tag} OK [${name === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${name} completed`);
        return;
      }

      case 'UID': {
        const sub = rest.split(/\s+/)[1].toUpperCase();
        if (sub === 'SEARCH') return this._uidSearch(sock, tag, rest);
        if (sub === 'FETCH') return this._uidFetch(sock, tag, rest);
        if (sub === 'STORE') return this._uidStore(sock, tag, rest);
        this._write(sock, `${tag} BAD Unknown UID command`);
        return;
      }

      case 'NOOP':
        // A real server reports mailbox changes it has not yet told this
        // session about. For a client with no IDLE, that is the only signal
        // new mail ever gives.
        if (st.selected && st.reportedExists !== this.messages.length) {
          st.reportedExists = this.messages.length;
          this._write(sock, `* ${this.messages.length} EXISTS`);
        }
        this._write(sock, `${tag} OK NOOP completed`);
        return;

      case 'IDLE':
        if (!this.supportsIdle) { this._write(sock, `${tag} BAD Unknown command IDLE`); return; }
        st.idling = true;
        st.idleTag = tag;
        this._write(sock, '+ idling');
        if (this.onIdle) this.onIdle(sock, st);
        return;

      case 'LOGOUT':
        this._write(sock, '* BYE Logging out');
        this._write(sock, `${tag} OK Logout completed.`);
        setTimeout(() => sock.destroy(), 20);
        return;

      default:
        // The empty line a client sends to acknowledge an XOAUTH2 error.
        if (firstLine === '' && st.awaitingOauthAck) {
          const t = st.awaitingOauthAck;
          st.awaitingOauthAck = null;
          this._write(sock, `${t} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`);
          return;
        }
        if (st.oauthPending && !firstLine.includes(' ')) {
          const f = st.oauthPending;
          st.oauthPending = null;
          f(firstLine);
          return;
        }
        void upper;
        this._write(sock, `${tag} BAD Error in IMAP command received by server.`);
    }
  }

  _matching(spec) {
    const uids = this.messages.map((m) => m.uid);
    if (!uids.length) return [];
    const max = Math.max(...uids);
    const out = new Set();
    for (const part of spec.split(',')) {
      const [aRaw, bRaw] = part.split(':');
      const a = aRaw === '*' ? max : Number(aRaw);
      const b = bRaw === undefined ? a : (bRaw === '*' ? max : Number(bRaw));
      // RFC 3501: "a range whose second value is * always includes the highest
      // UID", even when the first value is greater than it. This is the quirk
      // that makes `UID SEARCH UID n:*` return the last message forever.
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (const u of uids) if (u >= lo && u <= hi) out.add(u);
    }
    return [...out].sort((x, y) => x - y);
  }

  _uidSearch(sock, tag, rest) {
    const criteria = rest.replace(/^UID\s+SEARCH\s+/i, '').trim();
    let uids;
    if (/^ALL$/i.test(criteria)) uids = this.messages.map((m) => m.uid);
    else if (/^UNSEEN/i.test(criteria)) uids = this.messages.filter((m) => !m.flags.includes('\\Seen')).map((m) => m.uid);
    else {
      const m = /UID\s+(\S+)/i.exec(criteria);
      uids = m ? this._matching(m[1]) : this.messages.map((x) => x.uid);
      if (/UNSEEN/i.test(criteria)) {
        const unseen = new Set(this.messages.filter((x) => !x.flags.includes('\\Seen')).map((x) => x.uid));
        uids = uids.filter((u) => unseen.has(u));
      }
    }
    this._write(sock, `* SEARCH${uids.length ? ` ${uids.join(' ')}` : ''}`);
    this._write(sock, `${tag} OK Search completed (0.001 + 0.000 secs).`);
  }

  _uidFetch(sock, tag, rest) {
    const m = /^UID\s+FETCH\s+(\S+)\s+(.*)$/i.exec(rest);
    const uids = this._matching(m[1]);
    const items = m[2].toUpperCase();
    for (const uid of uids) {
      const msg = this.messages.find((x) => x.uid === uid);
      const seq = this.messages.indexOf(msg) + 1;
      const parts = [`UID ${uid}`];
      if (items.includes('INTERNALDATE')) parts.push(`INTERNALDATE "${msg.internaldate}"`);
      if (items.includes('FLAGS')) parts.push(`FLAGS (${msg.flags.join(' ')})`);
      if (items.includes('RFC822.SIZE')) parts.push(`RFC822.SIZE ${msg.raw.length}`);

      const headerOnly = /BODY(\.PEEK)?\[HEADER\.FIELDS/.test(items);
      const wantsBody = /BODY(\.PEEK)?\[\]/.test(items) || items.includes('RFC822 ');
      if (headerOnly) {
        const fields = /HEADER\.FIELDS\s*\(([^)]*)\)/.exec(items)[1].split(/\s+/).map((f) => f.toLowerCase());
        const head = msg.raw.toString('utf8').split(/\r\n\r\n/)[0].split(/\r\n/);
        const kept = [];
        let keep = false;
        for (const l of head) {
          if (/^[ \t]/.test(l)) { if (keep) kept.push(l); continue; }
          keep = fields.includes(l.split(':')[0].toLowerCase());
          if (keep) kept.push(l);
        }
        const blob = Buffer.from(`${kept.join('\r\n')}\r\n\r\n`, 'utf8');
        this._writeRaw(sock, Buffer.concat([
          Buffer.from(`* ${seq} FETCH (${parts.join(' ')} BODY[HEADER.FIELDS (${fields.map((f) => f.toUpperCase()).join(' ')})] {${blob.length}}\r\n`, 'utf8'),
          blob,
          Buffer.from(')\r\n', 'utf8'),
        ]));
      } else if (wantsBody) {
        this._writeRaw(sock, Buffer.concat([
          Buffer.from(`* ${seq} FETCH (${parts.join(' ')} BODY[] {${msg.raw.length}}\r\n`, 'utf8'),
          msg.raw,
          Buffer.from(')\r\n', 'utf8'),
        ]));
      } else {
        this._write(sock, `* ${seq} FETCH (${parts.join(' ')})`);
      }
    }
    this._write(sock, `${tag} OK Fetch completed (0.002 + 0.000 secs).`);
  }

  _uidStore(sock, tag, rest) {
    const m = /^UID\s+STORE\s+(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\((.*)\)/i.exec(rest);
    if (!m) { this._write(sock, `${tag} BAD Invalid STORE`); return; }
    const uids = this._matching(m[1]);
    const flags = m[3].split(/\s+/).filter(Boolean);
    for (const uid of uids) {
      const msg = this.messages.find((x) => x.uid === uid);
      if (m[2].startsWith('+')) for (const f of flags) if (!msg.flags.includes(f)) msg.flags.push(f);
      else if (m[2].startsWith('-')) msg.flags = msg.flags.filter((f) => !flags.includes(f));
      else msg.flags = flags;
    }
    this._write(sock, `${tag} OK Store completed (0.001 + 0.000 secs).`);
  }

  /** Test helper: deliver new mail and, if a client is idling, tell it. */
  deliver(msg) {
    const m = makeMessage(msg);
    this.messages.push(m);
    for (const sock of this.sockets) {
      if (sock.destroyed) continue;
      if (sock._st) sock._st.reportedExists = this.messages.length;
      this._write(sock, `* ${this.messages.length} EXISTS`);
    }
    return m;
  }
}

function parseLoginArgs(rest) {
  const out = [];
  const s = rest.replace(/^LOGIN\s+/i, '');
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

module.exports = { FakeImapServer, makeMessage, DOVECOT_CAPS, GMAIL_CAPS };
