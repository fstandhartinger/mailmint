'use strict';

/**
 * A small IMAP4rev1 client with ZERO dependencies (node:net / node:tls only).
 *
 * Scope: enough of the protocol to be a reliable *poller*, not a full client.
 * That means CAPABILITY / LOGIN / AUTHENTICATE XOAUTH2 / STARTTLS / SELECT /
 * EXAMINE / UID SEARCH / UID FETCH / UID STORE / IDLE / LOGOUT, done correctly,
 * and nothing else.
 *
 * The part that actually matters, and the part naive clients get wrong, is
 * literals. An IMAP response is NOT a sequence of lines: a line may end with
 * `{1234}` (or `{1234+}`), after which exactly 1234 bytes follow that are NOT
 * subject to line framing at all, and then the line *continues*. A client that
 * splits the stream on CRLF will:
 *
 *   - truncate any message whose body contains a CRLF (i.e. all of them),
 *   - and, worse, desynchronise the moment a message body happens to contain a
 *     line that looks like a tagged response ("A0007 OK done"), because it will
 *     believe the command finished and start reading the rest of the body as
 *     protocol.
 *
 * So the assembler below is byte-exact: in literal mode it consumes precisely N
 * bytes and never looks for a newline. Everything else is built on top of that.
 */

const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const CRLF = '\r\n';
const DEFAULT_MAX_LITERAL = 25 * 1024 * 1024;

/* --------------------------------------------------------------- errors */

class ImapError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ImapError';
    this.code = opts.code || 'imap_error';
    /** permanent = retrying with the same config will fail the same way. */
    this.permanent = !!opts.permanent;
    this.response = opts.response || null;
  }
}
class ImapAuthError extends ImapError {
  constructor(message, opts = {}) {
    super(message, { code: 'imap_auth', permanent: true, ...opts });
    this.name = 'ImapAuthError';
  }
}
class ImapTimeoutError extends ImapError {
  constructor(message, opts = {}) {
    super(message, { code: 'imap_timeout', ...opts });
    this.name = 'ImapTimeoutError';
  }
}
class ImapProtocolError extends ImapError {
  constructor(message, opts = {}) {
    super(message, { code: 'imap_protocol', ...opts });
    this.name = 'ImapProtocolError';
  }
}

/* ------------------------------------------------------- the assembler */

/**
 * Turns a byte stream into complete IMAP responses, honouring literals.
 *
 * A response is emitted as an array of segments:
 *   { t: 'text', s: '<one line of protocol text>' }
 *   { t: 'lit',  buf: <Buffer>, size: <declared byte count>, truncated: bool }
 *
 * `size` is what the server declared; `buf.length` may be smaller when the
 * literal exceeded `maxLiteralBytes`. The bytes are still *consumed* in that
 * case — dropping them would desynchronise the connection, which is far worse
 * than a truncated message.
 */
class ResponseAssembler {
  constructor(opts = {}) {
    this.maxLiteralBytes = opts.maxLiteralBytes ?? DEFAULT_MAX_LITERAL;
    this.maxLineBytes = opts.maxLineBytes ?? (1024 * 1024);
    // Called with (declaredSize, isLiteralPlus) the moment a literal is
    // announced. A *client* ignores this; a *server* uses it to send the `+`
    // continuation the sender is waiting for. Same framing, both directions.
    this.onLiteralStart = opts.onLiteralStart || null;
    this.buf = Buffer.alloc(0);
    this.segments = [];
    this.mode = 'line';
    this.remaining = 0;
    this.declared = 0;
    this.kept = [];
    this.keptBytes = 0;
    this.truncated = false;
  }

  /** @returns {Array<Array<object>>} zero or more complete responses. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.mode === 'literal') {
        if (this.buf.length === 0) break;
        const take = Math.min(this.remaining, this.buf.length);
        const slice = this.buf.subarray(0, take);
        // Keep up to the cap, but always consume, so framing stays correct.
        if (this.keptBytes < this.maxLiteralBytes) {
          const room = this.maxLiteralBytes - this.keptBytes;
          if (slice.length <= room) {
            this.kept.push(Buffer.from(slice));
            this.keptBytes += slice.length;
          } else {
            this.kept.push(Buffer.from(slice.subarray(0, room)));
            this.keptBytes += room;
            this.truncated = true;
          }
        } else {
          this.truncated = true;
        }
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.remaining > 0) break;          // need more bytes
        this.segments.push({
          t: 'lit',
          buf: this.kept.length === 1 ? this.kept[0] : Buffer.concat(this.kept),
          size: this.declared,
          truncated: this.truncated,
        });
        this.kept = [];
        this.keptBytes = 0;
        this.truncated = false;
        this.mode = 'line';
        continue;
      }

      // line mode
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.buf.length > this.maxLineBytes) {
          throw new ImapProtocolError(
            `server sent ${this.buf.length} bytes with no line terminator (max ${this.maxLineBytes})`,
          );
        }
        break;
      }
      let end = nl;
      if (end > 0 && this.buf[end - 1] === 0x0d) end -= 1;  // tolerate a bare LF
      const line = this.buf.subarray(0, end).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);

      const m = /\{(\d+)(\+?)\}$/.exec(line);
      if (m) {
        this.segments.push({ t: 'text', s: line });
        this.declared = Number(m[1]);
        this.remaining = this.declared;
        this.mode = 'literal';
        if (this.onLiteralStart) this.onLiteralStart(this.declared, m[2] === '+');
        if (this.remaining === 0) {
          // `{0}` is legal and means an empty literal.
          this.segments.push({ t: 'lit', buf: Buffer.alloc(0), size: 0, truncated: false });
          this.mode = 'line';
        }
        continue;
      }

      this.segments.push({ t: 'text', s: line });
      out.push(this.segments);
      this.segments = [];
    }
    return out;
  }
}

/* ----------------------------------------------------------- the lexer */

/**
 * Flattens segments into IMAP tokens. Literals become Buffer tokens, so the
 * caller never has to care whether the server chose a literal or a quoted
 * string for a given value.
 */
function lex(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg.t === 'lit') {
      out.push({ t: 'literal', v: seg.buf, size: seg.size, truncated: seg.truncated });
      continue;
    }
    // A trailing `{123}` is the marker for the literal token that follows it.
    const s = seg.s.replace(/\{\d+\+?\}$/, '');
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i += 1; continue; }
      if (c === '(' || c === ')') { out.push({ t: c }); i += 1; continue; }
      if (c === '"') {
        let j = i + 1;
        let val = '';
        while (j < s.length) {
          if (s[j] === '\\') { val += s[j + 1]; j += 2; continue; }
          if (s[j] === '"') break;
          val += s[j];
          j += 1;
        }
        out.push({ t: 'string', v: val });
        i = j + 1;
        continue;
      }
      // Atom. `[` opens a bracketed section (BODY[HEADER.FIELDS (DATE)]),
      // inside which spaces and parens are part of the atom.
      let j = i;
      let depth = 0;
      let val = '';
      while (j < s.length) {
        const d = s[j];
        if (d === '[') { depth += 1; val += d; j += 1; continue; }
        if (d === ']') { depth -= 1; val += d; j += 1; continue; }
        if (depth > 0) { val += d; j += 1; continue; }
        if (d === ' ' || d === '\t' || d === '(' || d === ')') break;
        val += d;
        j += 1;
      }
      out.push({ t: 'atom', v: val });
      i = j;
    }
  }
  return out;
}

/** Turns a flat token list into nested JS values: Array | Buffer | string | null. */
function parseValues(tokens, start = 0, stopAtParen = false) {
  const out = [];
  let i = start;
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.t === '(') {
      const inner = parseValues(tokens, i + 1, true);
      out.push(inner.values);
      i = inner.next;
      continue;
    }
    if (tk.t === ')') {
      if (stopAtParen) return { values: out, next: i + 1 };
      i += 1;
      continue;
    }
    if (tk.t === 'literal') {
      const b = tk.v;
      b.imapSize = tk.size;
      b.imapTruncated = tk.truncated;
      out.push(b);
      i += 1;
      continue;
    }
    if (tk.t === 'atom' && tk.v.toUpperCase() === 'NIL') { out.push(null); i += 1; continue; }
    out.push(tk.v);
    i += 1;
  }
  return { values: out, next: i };
}

/** `* OK [UIDVALIDITY 1234] ...` -> { name: 'UIDVALIDITY', args: ['1234'], raw } */
function parseRespCode(text) {
  const m = /\[([^\]]*)\]/.exec(text);
  if (!m) return null;
  const inside = m[1];
  const sp = inside.indexOf(' ');
  const name = (sp === -1 ? inside : inside.slice(0, sp)).toUpperCase();
  const rest = sp === -1 ? '' : inside.slice(sp + 1);
  return { name, args: rest ? rest.replace(/^\(|\)$/g, '').split(/\s+/) : [], raw: inside };
}

/** Classifies one assembled response. */
function classify(segments) {
  const first = segments[0].t === 'text' ? segments[0].s : '';
  const tokens = lex(segments);
  if (first.startsWith('+')) {
    return { kind: 'continuation', text: first.slice(1).trim(), segments, tokens };
  }
  if (first.startsWith('* ') || first === '*') {
    const rest = first.slice(2);
    const sp = rest.indexOf(' ');
    const head = sp === -1 ? rest : rest.slice(0, sp);
    let name;
    let seq = null;
    let valueStart;
    if (/^\d+$/.test(head)) {
      seq = Number(head);
      const rest2 = rest.slice(sp + 1);
      const sp2 = rest2.indexOf(' ');
      name = (sp2 === -1 ? rest2 : rest2.slice(0, sp2)).toUpperCase();
      valueStart = 3;                                     // '*', seq, name
    } else {
      name = head.toUpperCase();
      valueStart = 2;                                     // '*', name
    }
    const { values } = parseValues(tokens, valueStart);
    return {
      kind: 'untagged', name, seq, values, tokens, segments, text: first,
      code: parseRespCode(first),
    };
  }
  const sp = first.indexOf(' ');
  const tag = sp === -1 ? first : first.slice(0, sp);
  const rest = first.slice(sp + 1);
  const sp2 = rest.indexOf(' ');
  const status = (sp2 === -1 ? rest : rest.slice(0, sp2)).toUpperCase();
  return {
    kind: 'tagged', tag, status, text: sp2 === -1 ? '' : rest.slice(sp2 + 1),
    segments, tokens, code: parseRespCode(first),
  };
}

/* ------------------------------------------------------------ helpers */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `01-Feb-2026 10:20:30 +0100` -> Date, or null. */
function parseInternalDate(s) {
  if (!s) return null;
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/.exec(String(s));
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return null;
  const iso = `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4]}:${m[5]}:${m[6]}${m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z'}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** [1,2,3,7,9,10] -> '1:3,7,9:10' — keeps command lines short. */
function formatSequenceSet(uids) {
  const list = [...new Set(uids.map(Number))].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return '';
  const parts = [];
  let start = list[0];
  let prev = list[0];
  for (let i = 1; i <= list.length; i += 1) {
    const cur = list[i];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(',');
}

/** IMAP astring: bare atom when safe, otherwise a quoted string. */
function quote(s) {
  const str = String(s);
  if (str === '') return '""';
  if (/^[A-Za-z0-9_.\-/]+$/.test(str)) return str;
  return `"${str.replace(/([\\"])/g, '\\$1')}"`;
}

/** Marks a value that must go out as an IMAP literal. */
const literal = (v) => ({ __literal: Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8') });

/** Pairs a FETCH attribute list: ['UID','12','FLAGS',[...]] -> {UID:'12',...}. */
function pairAttributes(values) {
  const list = Array.isArray(values[0]) && values.length === 1 ? values[0] : values;
  const out = {};
  for (let i = 0; i < list.length; i += 2) {
    const key = typeof list[i] === 'string' ? list[i].toUpperCase() : String(list[i]);
    out[key] = list[i + 1];
  }
  return out;
}

/** Finds a fetched body regardless of which section spelling came back. */
function bodyOf(attrs) {
  for (const k of Object.keys(attrs)) {
    if (k === 'RFC822' || k === 'BODY[]' || k === 'BODY[]<0>' || /^BODY\[\]/.test(k) || /^BODY\.PEEK\[\]/.test(k)) {
      return attrs[k];
    }
  }
  return null;
}

/* ------------------------------------------------------------- client */

class ImapClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host;
    this.port = opts.port || (opts.secure === false ? 143 : 993);
    this.secure = opts.secure !== undefined ? !!opts.secure : this.port === 993;
    this.starttls = opts.starttls === undefined ? 'auto' : opts.starttls;
    this.user = opts.user || opts.username || null;
    this.pass = opts.pass || opts.password || null;
    this.accessToken = opts.accessToken || null;   // XOAUTH2
    this.tlsOptions = opts.tlsOptions || {};
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 120000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 29 * 60 * 1000;  // RFC 2177 says re-issue < 30m
    this.maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_LITERAL;
    this.log = opts.logger || (() => {});
    this.clientId = opts.clientId || 'mailmint-intake';

    this.socket = null;
    this.capabilities = new Set();
    this.state = 'disconnected';   // disconnected | connected | authenticated | selected | logout
    this.selected = null;
    this.serverGreeting = null;
    this.transcript = opts.transcript ? [] : null;

    this._tagSeq = 0;
    this._pending = new Map();
    this._order = [];
    this._assembler = null;
    this._writeChain = Promise.resolve();
    this._continuationWaiters = [];
    this._closedErr = null;
    this._idling = false;
    this._stopIdle = null;
    /** Set when an EXISTS/EXPUNGE arrives while no IDLE is running. */
    this._unsolicitedUpdate = false;
    this.stats = { bytesIn: 0, bytesOut: 0, commands: 0, responses: 0 };
  }

  hasCapability(name) { return this.capabilities.has(String(name).toUpperCase()); }

  _record(dir, text) {
    if (!this.transcript) return;
    this.transcript.push(`${dir} ${text}`);
    if (this.transcript.length > 500) this.transcript.shift();
  }

  _nextTag() {
    this._tagSeq += 1;
    return `A${String(this._tagSeq).padStart(4, '0')}`;
  }

  /* ------------------------------------------------------- connection */

  async connect() {
    if (this.state !== 'disconnected') throw new ImapError('already connected');
    this._assembler = new ResponseAssembler({ maxLiteralBytes: this.maxMessageBytes });
    const greeting = new Promise((resolve, reject) => {
      this._greetingResolve = resolve;
      this._greetingReject = reject;
    });

    await new Promise((resolve, reject) => {
      const onErr = (err) => reject(new ImapError(`connect failed: ${err.message}`, { code: 'imap_connect' }));
      const timer = setTimeout(() => {
        if (this.socket) this.socket.destroy();
        reject(new ImapTimeoutError(`connect to ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      if (this.secure) {
        this.socket = tls.connect({
          host: this.host, port: this.port, servername: this.host, ...this.tlsOptions,
        }, done);
      } else {
        this.socket = net.connect({ host: this.host, port: this.port }, done);
      }
      this.socket.once('error', onErr);
    });

    this.socket.removeAllListeners('error');
    this._wire(this.socket);
    this.state = 'connected';
    this.serverGreeting = await greeting;
    return this.serverGreeting;
  }

  _wire(sock) {
    sock.setNoDelay(true);
    sock.on('data', (chunk) => {
      this.stats.bytesIn += chunk.length;
      let responses;
      try {
        responses = this._assembler.push(chunk);
      } catch (err) {
        this._destroy(err);
        return;
      }
      for (const segs of responses) {
        this.stats.responses += 1;
        let resp;
        try {
          resp = classify(segs);
        } catch (err) {
          this._destroy(new ImapProtocolError(`unparseable response: ${err.message}`));
          return;
        }
        this._record('S:', segs.map((s) => (s.t === 'text' ? s.s : `<${s.size} bytes>`)).join(''));
        try {
          this._dispatch(resp);
        } catch (err) {
          this._destroy(err);
          return;
        }
      }
    });
    sock.on('error', (err) => this._destroy(new ImapError(`socket error: ${err.message}`, { code: 'imap_socket' })));
    sock.on('close', () => {
      if (this.state !== 'logout') {
        this._destroy(this._closedErr || new ImapError('connection closed by server', { code: 'imap_closed' }));
      }
      this.state = 'disconnected';
      this.emit('close');
    });
  }

  _destroy(err) {
    if (this._greetingReject) { const r = this._greetingReject; this._greetingReject = null; this._greetingResolve = null; r(err); }
    for (const tag of [...this._order]) {
      const entry = this._pending.get(tag);
      if (!entry) continue;
      this._pending.delete(tag);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._order = [];
    for (const w of this._continuationWaiters.splice(0)) w.reject(err);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    // Only if someone is listening: every failure is already reported by
    // rejecting the pending command promises, and an unhandled 'error' event
    // would take the whole host process down for something already handled.
    if (this.state !== 'logout' && this.listenerCount('error') > 0) this.emit('error', err);
  }

  /* -------------------------------------------------------- dispatch */

  _dispatch(resp) {
    if (resp.kind === 'continuation') {
      const w = this._continuationWaiters.shift();
      if (w) { w.resolve(resp); return; }
      for (const tag of this._order) {
        const e = this._pending.get(tag);
        if (e && e.onContinuation) { e.onContinuation(resp); return; }
      }
      return;
    }

    if (resp.kind === 'untagged') {
      if (this.state === 'connected' && this._greetingResolve
          && (resp.name === 'OK' || resp.name === 'PREAUTH' || resp.name === 'BYE')) {
        const r = this._greetingResolve;
        this._greetingResolve = null;
        this._greetingReject = null;
        if (resp.code && resp.code.name === 'CAPABILITY') this._setCapabilities(resp.code.args);
        if (resp.name === 'PREAUTH') this.state = 'authenticated';
        if (resp.name === 'BYE') { this._closedErr = new ImapError(`server refused connection: ${resp.text}`, { permanent: true }); }
        r({ status: resp.name, text: resp.text, capabilities: [...this.capabilities] });
        return;
      }
      if (resp.name === 'CAPABILITY') {
        this._setCapabilities(resp.values.filter((v) => typeof v === 'string'));
      }
      if (resp.code && resp.code.name === 'CAPABILITY') this._setCapabilities(resp.code.args);
      if (resp.name === 'BYE') this._closedErr = new ImapError(`server said BYE: ${resp.text}`);

      // Mailbox-state notifications are always broadcast: they can arrive at any
      // time, including in the middle of an unrelated command.
      const isUpdate = resp.name === 'EXISTS' || resp.name === 'EXPUNGE' || resp.name === 'RECENT';
      if (isUpdate) {
        this.emit(resp.name.toLowerCase(), resp.seq, resp);
        this.emit('update', resp);
      }

      for (const tag of this._order) {
        const e = this._pending.get(tag);
        if (!e) continue;
        if (e.collect === 'all' || (e.collect && e.collect.includes(resp.name))) {
          e.untagged.push(resp);
          if (e.onUntagged) e.onUntagged(resp);
          return;
        }
      }
      // Nobody was expecting it. If mail arrived while we were busy fetching
      // the previous batch, the notification lands here and there is no IDLE
      // running to catch it. Remembering it is what stops that message from
      // waiting 29 minutes for the next idle timeout.
      if (isUpdate) this._unsolicitedUpdate = true;
      this.emit('untagged', resp);
      return;
    }

    // tagged
    const entry = this._pending.get(resp.tag);
    if (!entry) { this.emit('untagged', resp); return; }
    this._pending.delete(resp.tag);
    this._order = this._order.filter((t) => t !== resp.tag);
    if (entry.timer) clearTimeout(entry.timer);
    if (resp.code && resp.code.name === 'CAPABILITY') this._setCapabilities(resp.code.args);
    entry.resolve({
      status: resp.status, text: resp.text, code: resp.code,
      untagged: entry.untagged, ms: Date.now() - entry.started,
    });
  }

  _setCapabilities(list) {
    this.capabilities = new Set(
      (list || []).filter((x) => typeof x === 'string' && x && x !== 'CAPABILITY').map((x) => x.toUpperCase()),
    );
  }

  /* --------------------------------------------------------- commands */

  /**
   * Sends one tagged command. Commands without literals are written
   * immediately, without waiting for earlier ones to complete — that is the
   * pipelining. Commands *with* literals take the write lock, because their
   * bytes are interleaved with `+` continuations and must not race.
   */
  exec(parts, opts = {}) {
    if (this.state === 'disconnected') return Promise.reject(new ImapError('not connected'));
    const tag = this._nextTag();
    const list = Array.isArray(parts) ? parts : [parts];
    const name = String(list[0] || '').split(' ')[0].toUpperCase();
    return new Promise((resolve, reject) => {
      const entry = {
        tag,
        name,
        collect: opts.collect === undefined ? [] : opts.collect,
        onUntagged: opts.onUntagged || null,
        onContinuation: opts.onContinuation || null,
        untagged: [],
        started: Date.now(),
        resolve: (r) => {
          if (opts.throwOnNo !== false && r.status !== 'OK') {
            const err = new ImapError(`${name} failed: ${r.status} ${r.text}`, {
              code: `imap_${r.status.toLowerCase()}`,
              permanent: r.status === 'BAD',
              response: r,
            });
            reject(err);
            return;
          }
          resolve(r);
        },
        reject,
        timer: null,
      };
      const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._destroy(new ImapTimeoutError(`${name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this._pending.set(tag, entry);
      this._order.push(tag);
      this.stats.commands += 1;
      this._writeCommand(tag, list).catch((err) => {
        if (this._pending.delete(tag)) {
          this._order = this._order.filter((t) => t !== tag);
          if (entry.timer) clearTimeout(entry.timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Writes one command's bytes. Everything goes through a single chain so that
   * two commands can never interleave their bytes on the wire; a command with
   * no literal resolves its link of the chain immediately, which is what lets
   * the next command be written before the first one has answered.
   */
  _writeCommand(tag, list) {
    const run = async () => {
      let line = `${tag} `;
      for (const part of list) {
        if (part && part.__literal) {
          const buf = part.__literal;
          const plus = this.hasCapability('LITERAL+') || this.hasCapability('LITERAL-');
          line += `{${buf.length}${plus ? '+' : ''}}`;
          this._write(`${line}${CRLF}`);
          this._record('C:', `${line} <${buf.length} bytes>`);
          line = '';
          // Without LITERAL+ the server must say "+" before it will read the
          // bytes. Sending them early desynchronises the connection.
          if (!plus) await this._awaitContinuation();
          this._write(buf);
        } else {
          line += part;
        }
      }
      this._write(`${line}${CRLF}`);
      if (line) this._record('C:', line);
    };
    this._writeChain = this._writeChain.then(run, run);
    return this._writeChain;
  }

  _write(data) {
    if (!this.socket || this.socket.destroyed) throw new ImapError('socket is gone', { code: 'imap_closed' });
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.stats.bytesOut += buf.length;
    this.socket.write(buf);
  }

  _awaitContinuation(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      const t = setTimeout(() => {
        const idx = this._continuationWaiters.indexOf(w);
        if (idx >= 0) this._continuationWaiters.splice(idx, 1);
        reject(new ImapTimeoutError('server never sent the "+" continuation for a literal'));
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      this._continuationWaiters.push(w);
    });
  }

  /** Writes several commands back to back and awaits them all. */
  pipeline(commands) {
    return Promise.all(commands.map((c) => (Array.isArray(c) ? this.exec(c[0], c[1]) : this.exec(c))));
  }

  /* ---------------------------------------------------- conversation */

  async capability() {
    const r = await this.exec('CAPABILITY', { collect: ['CAPABILITY'] });
    for (const u of r.untagged) {
      if (u.name === 'CAPABILITY') this._setCapabilities(u.values.filter((v) => typeof v === 'string'));
    }
    return [...this.capabilities];
  }

  async upgradeTLS() {
    await this.exec('STARTTLS');
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    this.socket = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: this.host, ...this.tlsOptions }, () => resolve(s));
      s.once('error', reject);
    });
    this.socket.removeAllListeners('error');
    this._assembler = new ResponseAssembler({ maxLiteralBytes: this.maxMessageBytes });
    this._wire(this.socket);
    this.secure = true;
    // RFC 3501: capabilities before STARTTLS must be discarded.
    this.capabilities = new Set();
    await this.capability();
    return true;
  }

  /** CAPABILITY, optional STARTTLS, then LOGIN or AUTHENTICATE XOAUTH2. */
  async login() {
    if (!this.capabilities.size) await this.capability();
    if (!this.secure && this.starttls !== false) {
      if (this.hasCapability('STARTTLS')) {
        await this.upgradeTLS();
      } else if (this.starttls === true) {
        throw new ImapError('STARTTLS was required but the server does not advertise it', { permanent: true });
      }
    }
    if (this.state === 'authenticated') return { method: 'preauth' };
    if (this.hasCapability('LOGINDISABLED') && !this.accessToken) {
      throw new ImapAuthError('server advertises LOGINDISABLED and no OAuth token was supplied');
    }
    const method = this.accessToken ? 'xoauth2' : 'login';
    try {
      if (this.accessToken) await this._authXoauth2();
      else await this._authLogin();
    } catch (err) {
      if (err instanceof ImapError && (err.code === 'imap_no' || err.code === 'imap_bad')) {
        throw new ImapAuthError(`authentication failed: ${err.message}`, { response: err.response });
      }
      throw err;
    }
    this.state = 'authenticated';
    // Post-auth capabilities differ (IDLE is often only advertised then).
    if (!this.hasCapability('IDLE')) await this.capability();
    return { method, capabilities: [...this.capabilities] };
  }

  async _authLogin() {
    if (!this.user || this.pass === null) throw new ImapAuthError('user and password are required');
    // Non-ASCII or awkward passwords go out as literals rather than being
    // mangled into a quoted string.
    const needsLiteral = /[^\x20-\x7e]/.test(this.pass) || /[^\x20-\x7e]/.test(this.user);
    if (needsLiteral) {
      return this.exec(['LOGIN ', literal(this.user), ' ', literal(this.pass)]);
    }
    return this.exec(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
  }

  async _authXoauth2() {
    const sasl = Buffer.from(
      `user=${this.user}\x01auth=Bearer ${this.accessToken}\x01\x01`, 'utf8',
    ).toString('base64');
    if (this.hasCapability('SASL-IR')) {
      return this._runAuthenticate(`AUTHENTICATE XOAUTH2 ${sasl}`, null);
    }
    return this._runAuthenticate('AUTHENTICATE XOAUTH2', sasl);
  }

  /**
   * XOAUTH2 has an unusual failure mode: on a bad token the server replies with
   * a `+ <base64 json>` continuation rather than a tagged NO, and the client is
   * required to answer with an empty line before the NO arrives. Skipping that
   * leaves the connection wedged.
   */
  _runAuthenticate(command, initialResponse) {
    let errorPayload = null;
    return this.exec(command, {
      collect: [],
      onContinuation: (resp) => {
        if (initialResponse !== null && !errorPayload && resp.text === '') {
          this._write(`${initialResponse}${CRLF}`);
          initialResponse = null;
          return;
        }
        if (resp.text) {
          try { errorPayload = JSON.parse(Buffer.from(resp.text, 'base64').toString('utf8')); }
          catch { errorPayload = { raw: resp.text }; }
        }
        this._write(CRLF);   // acknowledge, so the server can send its NO
      },
    }).catch((err) => {
      if (errorPayload) {
        throw new ImapAuthError(
          `XOAUTH2 rejected: ${errorPayload.status || ''} ${errorPayload.schemes || ''}`.trim()
          || 'XOAUTH2 rejected', { response: errorPayload },
        );
      }
      throw err;
    });
  }

  async select(mailbox, opts = {}) {
    const cmd = opts.readOnly ? 'EXAMINE' : 'SELECT';
    const r = await this.exec(`${cmd} ${quote(mailbox)}`, {
      collect: ['OK', 'FLAGS', 'EXISTS', 'RECENT', 'LIST'],
    });
    const box = {
      name: mailbox,
      readOnly: !!opts.readOnly || (r.code && r.code.name === 'READ-ONLY'),
      exists: 0, recent: 0, uidvalidity: null, uidnext: null,
      flags: [], permanentFlags: [], highestmodseq: null,
    };
    for (const u of r.untagged) {
      if (u.name === 'EXISTS') box.exists = u.seq;
      else if (u.name === 'RECENT') box.recent = u.seq;
      else if (u.name === 'FLAGS') box.flags = (u.values[0] || []).map(String);
      else if (u.name === 'OK' && u.code) {
        if (u.code.name === 'UIDVALIDITY') box.uidvalidity = Number(u.code.args[0]);
        else if (u.code.name === 'UIDNEXT') box.uidnext = Number(u.code.args[0]);
        else if (u.code.name === 'PERMANENTFLAGS') box.permanentFlags = u.code.args;
        else if (u.code.name === 'HIGHESTMODSEQ') box.highestmodseq = u.code.args[0];
      }
    }
    if (box.uidvalidity === null) {
      throw new ImapProtocolError(`${cmd} ${mailbox} returned no UIDVALIDITY; refusing to poll a mailbox we cannot track`);
    }
    this.state = 'selected';
    this.selected = box;
    return box;
  }

  examine(mailbox) { return this.select(mailbox, { readOnly: true }); }

  async uidSearch(criteria) {
    const q = Array.isArray(criteria) ? criteria.join(' ') : String(criteria || 'ALL');
    const r = await this.exec(`UID SEARCH ${q}`, { collect: ['SEARCH', 'ESEARCH'] });
    const out = [];
    for (const u of r.untagged) {
      if (u.name === 'SEARCH') {
        for (const v of u.values) if (typeof v === 'string' && /^\d+$/.test(v)) out.push(Number(v));
      } else if (u.name === 'ESEARCH') {
        const idx = u.values.findIndex((v) => typeof v === 'string' && v.toUpperCase() === 'ALL');
        if (idx >= 0) {
          for (const chunk of String(u.values[idx + 1]).split(',')) {
            const [a, b] = chunk.split(':').map(Number);
            if (b === undefined) out.push(a);
            else for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.push(i);
          }
        }
      }
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  /**
   * `onMessage` is called per untagged FETCH, as it arrives, so a batch of
   * large messages is never all in memory at once.
   */
  async uidFetch(range, items, onMessage) {
    const set = Array.isArray(range) ? formatSequenceSet(range) : String(range);
    if (!set) return [];
    const itemStr = items || '(UID INTERNALDATE FLAGS RFC822.SIZE BODY.PEEK[])';
    const out = [];
    await this.exec(`UID FETCH ${set} ${itemStr}`, {
      collect: ['FETCH'],
      onUntagged: (u) => {
        const attrs = pairAttributes(u.values);
        const body = bodyOf(attrs);
        const msg = {
          seq: u.seq,
          uid: attrs.UID !== undefined ? Number(attrs.UID) : null,
          flags: Array.isArray(attrs.FLAGS) ? attrs.FLAGS.map(String) : [],
          size: attrs['RFC822.SIZE'] !== undefined ? Number(attrs['RFC822.SIZE']) : (body ? body.length : null),
          internaldate: parseInternalDate(attrs.INTERNALDATE),
          internaldateRaw: attrs.INTERNALDATE || null,
          body: Buffer.isBuffer(body) ? body : (body == null ? null : Buffer.from(String(body))),
          truncated: Buffer.isBuffer(body) ? !!body.imapTruncated : false,
          declaredSize: Buffer.isBuffer(body) ? body.imapSize : null,
          attrs,
        };
        out.push(msg);
        if (onMessage) onMessage(msg);
      },
    });
    return out;
  }

  /** Cheap pass: everything except the bytes, so the size cap is applied first. */
  uidFetchMeta(range) {
    return this.uidFetch(range, '(UID INTERNALDATE FLAGS RFC822.SIZE)');
  }

  uidStore(range, item, value) {
    const set = Array.isArray(range) ? formatSequenceSet(range) : String(range);
    if (!set) return Promise.resolve(null);
    const v = Array.isArray(value) ? `(${value.join(' ')})` : value;
    return this.exec(`UID STORE ${set} ${item} ${v}`, { collect: ['FETCH'] });
  }

  markSeen(uids) { return this.uidStore(uids, '+FLAGS.SILENT', ['\\Seen']); }

  noop() { return this.exec('NOOP', { collect: ['EXISTS', 'EXPUNGE', 'RECENT', 'FETCH'] }); }

  /**
   * Blocks until the mailbox changes, the deadline passes, or `stop()` is
   * called. Uses IDLE when the server has it; otherwise falls back to NOOP at
   * `pollIntervalMs`, which is what most cheap IMAP hosts force on us.
   */
  async waitForUpdate(opts = {}) {
    const maxMs = opts.maxMs ?? this.idleTimeoutMs;
    if (this._unsolicitedUpdate) {
      // Mail arrived while we were mid-command. Do not go to sleep on it.
      this._unsolicitedUpdate = false;
      return { reason: 'update', updates: [], deferred: true };
    }
    if (this.hasCapability('IDLE') && opts.idle !== false) return this.idle({ maxMs });
    return this._pollWait({ maxMs, intervalMs: opts.pollIntervalMs ?? 30000 });
  }

  async idle({ maxMs } = {}) {
    if (!this.hasCapability('IDLE')) throw new ImapError('server does not advertise IDLE', { permanent: true });
    const limit = maxMs ?? this.idleTimeoutMs;
    let reason = 'stopped';
    let idling = false;
    const updates = [];
    let timer = null;

    const stop = () => {
      if (!idling) return;
      idling = false;
      try { this._write(`DONE${CRLF}`); this._record('C:', 'DONE'); } catch { /* socket gone */ }
    };
    this._stopIdle = () => { reason = reason === 'stopped' ? 'stopped' : reason; stop(); };

    const p = this.exec('IDLE', {
      collect: ['EXISTS', 'EXPUNGE', 'RECENT', 'FETCH'],
      // IDLE's tagged OK only arrives after DONE, so its budget is the idle
      // window plus slack, never the ordinary command timeout.
      timeoutMs: limit + 60000,
      onContinuation: () => {
        idling = true;
        timer = setTimeout(() => { reason = 'timeout'; stop(); }, limit);
      },
      onUntagged: (u) => {
        updates.push({ name: u.name, seq: u.seq });
        if (u.name === 'EXISTS' || u.name === 'EXPUNGE' || u.name === 'RECENT') {
          reason = 'update';
          stop();
        }
      },
    });
    try {
      await p;
    } finally {
      if (timer) clearTimeout(timer);
      this._stopIdle = null;
    }
    return { reason, updates };
  }

  /** Ends an in-flight idle() early. */
  stopIdle() { if (this._stopIdle) this._stopIdle(); }

  async _pollWait({ maxMs, intervalMs }) {
    const deadline = Date.now() + maxMs;
    const before = this.selected ? this.selected.exists : 0;
    for (;;) {
      const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
      if (wait <= 0) return { reason: 'timeout', updates: [] };
      await new Promise((r) => { const t = setTimeout(r, wait); if (t.unref) t.unref(); });
      if (Date.now() >= deadline) return { reason: 'timeout', updates: [] };
      const r = await this.noop();
      const exists = r.untagged.filter((u) => u.name === 'EXISTS');
      if (exists.length) {
        if (this.selected) this.selected.exists = exists[exists.length - 1].seq;
        if (!before || exists[exists.length - 1].seq !== before) {
          return { reason: 'update', updates: exists.map((u) => ({ name: u.name, seq: u.seq })), polled: true };
        }
      }
    }
  }

  async logout() {
    if (this.state === 'disconnected' || this.state === 'logout') return;
    try {
      const p = this.exec('LOGOUT', { collect: ['BYE'], timeoutMs: 10000 });
      this.state = 'logout';
      await p;
    } catch { /* a server that just drops the socket on LOGOUT is common */ }
    this.close();
  }

  close() {
    this.state = 'logout';
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

module.exports = {
  ImapClient,
  ResponseAssembler,
  ImapError, ImapAuthError, ImapTimeoutError, ImapProtocolError,
  lex, parseValues, classify, parseRespCode,
  parseInternalDate, formatSequenceSet, quote, literal, pairAttributes, bodyOf,
};
