'use strict';
// MailMint inbound SMTP receiver — RFC 5321, with STARTTLS (RFC 3207),
// PIPELINING (RFC 2920), CHUNKING/BDAT (RFC 3030), 8BITMIME (RFC 6152),
// SMTPUTF8 (RFC 6531), SIZE (RFC 1870) and ENHANCEDSTATUSCODES (RFC 2034).
//
// Zero runtime dependencies: node:net, node:tls, node:crypto, node:dns only.

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const crypto = require('node:crypto');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');

const log = require('./log');
const { parsePath, routeRecipient } = require('./address');
const { receivedHeader } = require('./received');
const { authenticateWithDeadline, authenticationResultsHeader } = require('./auth');
const { DnsClient } = require('./auth/dns');

const CR = 13, LF = 10, DOT = 46;
const TERMINATOR = Buffer.from([CR, LF, DOT, CR, LF]);
// KMP failure function for "\r\n.\r\n"
const TERM_FAIL = [0, 0, 0, 0, 1, 2];

const S = {
  GREETING: 'greeting',
  COMMAND: 'command',
  DATA: 'data',
  BDAT: 'bdat',
  CLOSING: 'closing',
};

let seq = 0;
function queueId() {
  seq = (seq + 1) & 0xffff;
  return crypto.randomBytes(6).toString('hex').toUpperCase() + seq.toString(16).toUpperCase().padStart(4, '0');
}
function requestId() {
  return 'req_' + crypto.randomBytes(12).toString('hex');
}

// --------------------------------------------------------------- session ---

class Session {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.cfg = server.cfg;
    this.id = queueId();
    this.requestId = requestId();
    this.remoteIp = normaliseIp(socket.remoteAddress || '0.0.0.0');
    this.remotePort = socket.remotePort;
    this.reverseDns = null;
    this.state = S.GREETING;
    this.secure = Boolean(socket.encrypted);
    this.helo = null;
    this.esmtp = false;
    this.mailFrom = null;
    this.mailParams = null;
    this.smtputf8 = false;
    this.declaredSize = 0;
    this.recipients = [];
    this.errors = 0;
    this.unknownRcpt = 0;
    this.messages = 0;
    this.closed = false;
    this.startedAt = Date.now();

    this.buf = Buffer.alloc(0);
    this.pumping = false;

    // DATA state
    this.dataChunks = [];
    this.dataLen = 0;      // bytes accepted so far (may lag behind octets seen when oversize)
    this.dataOctets = 0;   // every octet seen, for the SIZE check
    this.termState = 0;
    this.dataOversize = false;

    // BDAT state
    this.bdatRemaining = 0;
    this.bdatLast = false;
    this.bdatChunks = [];
    this.bdatLen = 0;
    this.bdatOversize = false;
    this.bdatFailed = null;

    socket.setTimeout(this.cfg.sessionTimeoutMs);
    socket.on('timeout', () => this.onTimeout());
    socket.on('data', (c) => this.onData(c));
    socket.on('error', (e) => this.onError(e));
    socket.on('close', () => this.onClose());
  }

  // ------------------------------------------------------------- plumbing --

  reply(text) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(text.endsWith('\r\n') ? text : text + '\r\n');
  }

  /** Multi-line-safe reply. `lines` may be a string or array. */
  respond(code, enhanced, lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    let out = '';
    for (let i = 0; i < arr.length; i++) {
      const sep = i === arr.length - 1 ? ' ' : '-';
      const prefix = enhanced ? `${code}${sep}${enhanced} ` : `${code}${sep}`;
      out += prefix + arr[i] + '\r\n';
    }
    this.reply(out);
  }

  fail(code, enhanced, message, why) {
    this.errors++;
    log.info('smtp.rejected', {
      request_id: this.requestId, session: this.id, remote_ip: this.remoteIp,
      helo: this.helo, code, enhanced, reason: why || message,
      mail_from: this.mailFrom, errors: this.errors,
    });
    this.respond(code, enhanced, message);
    if (this.errors >= this.cfg.maxErrorsPerSession) {
      this.respond(421, '4.7.0', 'too many errors, closing connection');
      this.quit('too many errors');
    }
  }

  quit(reason) {
    this.closed = true;
    this.state = S.CLOSING;
    try { this.socket.end(); } catch { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 1000).unref();
    this.logSession(reason);
  }

  logSession(reason) {
    if (this._logged) return;
    this._logged = true;
    log.info('smtp.session', {
      request_id: this.requestId, session: this.id, remote_ip: this.remoteIp,
      helo: this.helo, tls: this.secure, messages: this.messages,
      errors: this.errors, ms: Date.now() - this.startedAt, reason,
    });
  }

  onTimeout() {
    this.respond(421, '4.4.2', `${this.cfg.hostname} timeout after ${Math.round(this.cfg.sessionTimeoutMs / 1000)}s`);
    this.quit('timeout');
  }

  onError(err) {
    if (!this.closed) {
      log.debug('smtp.socket_error', { request_id: this.requestId, session: this.id, error: err.message, code: err.code });
    }
    this.closed = true;
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  onClose() {
    this.closed = true;
    this.server._release(this);
    this.logSession('closed');
  }

  // ------------------------------------------------------------- greeting --

  async greet() {
    if (this.server.overloaded()) {
      this.respond(421, '4.3.2', `${this.cfg.hostname} too many concurrent connections, try again later`);
      this.quit('global cap');
      return;
    }
    if (this.server.tooManyFromIp(this.remoteIp)) {
      this.respond(421, '4.7.0', `${this.cfg.hostname} too many connections from ${this.remoteIp}`);
      this.quit('per-ip cap');
      return;
    }
    // reverse DNS is best-effort and must never delay the banner
    this.server.reverseLookup(this.remoteIp).then((n) => { this.reverseDns = n; }).catch(() => {});
    this.state = S.COMMAND;
    this.respond(220, null, `${this.cfg.hostname} ESMTP MailMint ready`);
  }

  // ------------------------------------------------------------ the pump --

  onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.cfg.maxMessageBytes + 1048576) {
      this.fail(552, '5.3.4', 'message too big', 'input buffer overrun');
      this.quit('input overrun');
      return;
    }
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) break;
        if (this.state === S.DATA) {
          if (!(await this.consumeData())) break;
          continue;
        }
        if (this.state === S.BDAT) {
          if (!(await this.consumeBdat())) break;
          continue;
        }
        const line = this.takeLine();
        if (line === null) break;
        await this.command(line);
      }
    } catch (err) {
      log.error('smtp.pump_error', { request_id: this.requestId, session: this.id, error: err.message, stack: err.stack });
      try { this.respond(451, '4.3.0', 'internal error'); } catch { /* ignore */ }
      this.quit('internal error');
    } finally {
      this.pumping = false;
    }
  }

  /** Pull one CRLF-terminated command line; null when incomplete. */
  takeLine() {
    const idx = this.buf.indexOf(LF);
    if (idx === -1) {
      if (this.buf.length > this.cfg.maxLineBytes) {
        this.fail(500, '5.5.6', 'line too long');
        this.buf = Buffer.alloc(0);
      }
      return null;
    }
    let end = idx;
    if (end > 0 && this.buf[end - 1] === CR) end--;
    const line = this.buf.subarray(0, end).toString('utf8');
    this.buf = this.buf.subarray(idx + 1);
    return line;
  }

  // ----------------------------------------------------------- commands ----

  async command(line) {
    if (this.state === S.GREETING) {
      this.fail(503, '5.5.1', 'bad sequence of commands');
      return;
    }
    const sp = line.indexOf(' ');
    const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1);

    switch (verb) {
      case 'EHLO': return this.cmdEhlo(rest, true);
      case 'HELO': return this.cmdEhlo(rest, false);
      case 'STARTTLS': return this.cmdStartTls(rest);
      case 'MAIL': return this.cmdMail(rest);
      case 'RCPT': return this.cmdRcpt(rest);
      case 'DATA': return this.cmdData(rest);
      case 'BDAT': return this.cmdBdat(rest);
      case 'RSET': return this.cmdRset();
      case 'NOOP': return this.respond(250, '2.0.0', 'OK');
      case 'QUIT':
        this.respond(221, '2.0.0', `${this.cfg.hostname} closing connection`);
        return this.quit('quit');
      case 'VRFY':
        // Never confirm or deny an address: address harvesting is exactly how
        // dictionary attacks against our token space would start.
        return this.respond(252, '2.5.2', 'cannot VRFY user, but will accept message and attempt delivery');
      case 'EXPN':
        return this.fail(502, '5.5.1', 'EXPN not supported');
      case 'HELP':
        return this.respond(214, '2.0.0', [
          'MailMint SMTP. Supported commands:',
          'EHLO HELO STARTTLS MAIL RCPT DATA BDAT RSET NOOP VRFY HELP QUIT',
          'Mail is accepted only for <token>@' + this.cfg.inboundDomains[0],
          'See https://mailmint.dev/docs/inbound',
        ]);
      case 'AUTH':
        return this.fail(502, '5.7.0', 'AUTH not supported: this is an inbound-only MX');
      default:
        return this.fail(500, '5.5.2', `command not recognised: ${verb.slice(0, 32)}`);
    }
  }

  cmdEhlo(arg, esmtp) {
    const domain = (arg || '').trim().split(/\s+/)[0];
    if (!domain) return this.fail(501, '5.5.4', `${esmtp ? 'EHLO' : 'HELO'} requires a domain address`);
    // A new EHLO resets any transaction in progress (RFC 5321 §4.1.4).
    this.resetTransaction();
    this.helo = domain;
    this.esmtp = esmtp;

    if (!esmtp) {
      return this.respond(250, null, `${this.cfg.hostname} Hello ${domain} [${this.remoteIp}]`);
    }
    const ext = [
      `${this.cfg.hostname} Hello ${domain} [${this.remoteIp}]`,
      `SIZE ${this.cfg.maxMessageBytes}`,
      '8BITMIME',
      'SMTPUTF8',
      'PIPELINING',
      'ENHANCEDSTATUSCODES',
      'CHUNKING',
    ];
    // Only advertise STARTTLS when we actually have a certificate, and never twice.
    if (this.server.tlsOptions && !this.secure) ext.splice(2, 0, 'STARTTLS');
    ext.push('HELP');
    return this.respond(250, null, ext);
  }

  cmdStartTls(arg) {
    if (!this.server.tlsOptions) return this.fail(454, '4.7.0', 'TLS not available');
    if (this.secure) return this.fail(503, '5.5.1', 'TLS already active');
    if (arg && arg.trim()) return this.fail(501, '5.5.4', 'STARTTLS takes no arguments');
    if (!this.helo) return this.fail(503, '5.5.1', 'send EHLO first');

    this.respond(220, '2.0.0', 'ready to start TLS');
    // Everything after STARTTLS on the plaintext channel must be discarded
    // (the "command injection" attack, CVE-2011-0411).
    this.buf = Buffer.alloc(0);
    const raw = this.socket;
    raw.removeAllListeners('data');
    raw.removeAllListeners('timeout');
    raw.removeAllListeners('error');
    raw.removeAllListeners('close');

    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext: this.server.secureContext,
      ...this.server.tlsOptions,
    });
    secure.on('secure', () => {
      this.socket = secure;
      this.secure = true;
      this.tlsInfo = { protocol: secure.getProtocol(), cipher: (secure.getCipher() || {}).name };
      // RFC 3207 §4.2: reset all state learned before TLS.
      this.helo = null;
      this.esmtp = false;
      this.resetTransaction();
      secure.setTimeout(this.cfg.sessionTimeoutMs);
      secure.on('timeout', () => this.onTimeout());
      secure.on('data', (c) => this.onData(c));
      secure.on('error', (e) => this.onError(e));
      secure.on('close', () => this.onClose());
      log.debug('smtp.starttls', {
        request_id: this.requestId, session: this.id,
        protocol: this.tlsInfo.protocol, cipher: this.tlsInfo.cipher,
      });
    });
    secure.on('error', (e) => this.onError(e));
  }

  cmdMail(rest) {
    if (!this.helo) return this.fail(503, '5.5.1', 'send EHLO/HELO first');
    if (this.mailFrom !== null) return this.fail(503, '5.5.1', 'nested MAIL command');
    const m = rest.match(/^FROM:\s*(.*)$/i);
    if (!m) return this.fail(501, '5.5.4', 'syntax: MAIL FROM:<address>');
    const parsed = parsePath(m[1], { allowNull: true });
    if (!parsed) return this.fail(501, '5.1.7', 'malformed reverse-path');

    const p = parsed.params;
    if (p.SIZE !== undefined && p.SIZE !== true) {
      const size = Number(p.SIZE);
      if (!Number.isFinite(size) || size < 0) return this.fail(501, '5.5.4', 'bad SIZE parameter');
      if (size > this.cfg.maxMessageBytes) {
        return this.fail(552, '5.3.4', `message size ${size} exceeds the ${this.cfg.maxMessageBytes} byte limit`);
      }
      this.declaredSize = size;
    }
    if (p.BODY !== undefined && p.BODY !== true) {
      const body = String(p.BODY).toUpperCase();
      if (!['7BIT', '8BITMIME'].includes(body)) return this.fail(501, '5.5.4', `unsupported BODY=${p.BODY}`);
    }
    this.smtputf8 = p.SMTPUTF8 === true || p.SMTPUTF8 !== undefined;
    for (const k of Object.keys(p)) {
      if (!['SIZE', 'BODY', 'SMTPUTF8', 'AUTH', 'RET', 'ENVID'].includes(k)) {
        return this.fail(555, '5.5.4', `unsupported parameter ${k}`);
      }
    }

    this.mailFrom = parsed.address;
    this.mailParams = p;
    this.recipients = [];
    this.respond(250, '2.1.0', `<${parsed.address}> sender ok`);
  }

  async cmdRcpt(rest) {
    if (this.mailFrom === null) return this.fail(503, '5.5.1', 'need MAIL before RCPT');
    const m = rest.match(/^TO:\s*(.*)$/i);
    if (!m) return this.fail(501, '5.5.4', 'syntax: RCPT TO:<address>');
    const parsed = parsePath(m[1]);
    if (!parsed || !parsed.address) return this.fail(501, '5.1.3', 'malformed forward-path');
    if (this.recipients.length >= this.cfg.maxRecipients) {
      return this.fail(452, '4.5.3', `too many recipients (max ${this.cfg.maxRecipients})`);
    }

    const addr = parsed.address;
    const route = routeRecipient(addr, this.cfg.inboundDomains);
    if (!route.ok) {
      if (route.reason === 'relay') {
        return this.fail(550, '5.7.1', `<${addr}> relay not permitted`, 'relay denied');
      }
      this.unknownRcpt++;
      if (this.unknownRcpt > this.cfg.maxUnknownRcptPerSession) {
        this.respond(550, '5.1.1', `<${addr}> unknown mailbox`);
        this.errors = this.cfg.maxErrorsPerSession;
        this.respond(421, '4.7.0', 'too many invalid recipients, closing connection');
        return this.quit('recipient probing');
      }
      return this.fail(550, '5.1.1', `<${addr}> unknown mailbox`, 'bad local-part form');
    }

    // does the mailbox exist?
    const res = await this.server.resolver.resolve(route.address, this.requestId);
    if (res.temporary) {
      return this.fail(451, '4.3.0', `<${addr}> temporary lookup failure, try again later`, 'resolver temp fail');
    }
    if (!res.exists) {
      this.unknownRcpt++;
      if (this.unknownRcpt > this.cfg.maxUnknownRcptPerSession) {
        this.respond(550, '5.1.1', `<${addr}> unknown mailbox`);
        this.respond(421, '4.7.0', 'too many invalid recipients, closing connection');
        return this.quit('recipient probing');
      }
      return this.fail(550, '5.1.1', `<${addr}> unknown mailbox`, 'no such mailbox');
    }
    if (this.recipients.some((r) => r.token === route.token)) {
      return this.respond(250, '2.1.5', `<${addr}> duplicate recipient ignored`);
    }
    this.recipients.push({ ...route, rcptTo: addr, mailbox: res.mailbox || null });
    this.respond(250, '2.1.5', `<${addr}> recipient ok`);
  }

  cmdData(rest) {
    if (rest && rest.trim()) return this.fail(501, '5.5.4', 'DATA takes no arguments');
    if (this.mailFrom === null) return this.fail(503, '5.5.1', 'need MAIL before DATA');
    if (!this.recipients.length) return this.fail(503, '5.5.1', 'need RCPT before DATA');
    if (this.bdatChunks.length) return this.fail(503, '5.5.1', 'cannot mix BDAT and DATA');

    this.state = S.DATA;
    this.dataChunks = [];
    this.dataLen = 0;
    this.dataOctets = 0;
    this.dataOversize = false;
    // Seed the terminator matcher as if a CRLF had just been seen, so a message
    // whose very first three bytes are ".\r\n" (an empty body) terminates.
    this.termState = 2;
    this.respond(354, null, 'start mail input; end with <CRLF>.<CRLF>');
  }

  /**
   * Consume DATA octets out of this.buf.
   * Returns true when the terminator was found (caller should keep pumping),
   * false when more input is needed.
   *
   * The terminator match is a running KMP state carried across TCP chunks, so
   * "\r\n." arriving in one packet and ".\r\n"'s tail in the next is detected.
   */
  async consumeData() {
    const b = this.buf;
    if (!b.length) return false;
    let state = this.termState;
    let found = -1;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      for (;;) {
        if (c === TERMINATOR[state]) { state++; break; }
        if (state === 0) break;
        state = TERM_FAIL[state];
      }
      if (state === TERMINATOR.length) { found = i; break; }
    }

    if (found === -1) {
      this.termState = state;
      this.appendData(b);
      this.buf = Buffer.alloc(0);
      return false;
    }

    // content length = (global index of terminator start) + 2, keeping the CRLF
    const contentLen = this.dataOctets + found - 2;
    this.appendData(b.subarray(0, found + 1));
    this.buf = b.subarray(found + 1);
    this.termState = 0;
    this.state = S.COMMAND;

    const raw = this.finishData(contentLen);
    await this.endOfMessage(raw, 'DATA');
    return true;
  }

  appendData(chunk) {
    this.dataOctets += chunk.length;
    if (this.dataOctets > this.cfg.maxMessageBytes + 5) {
      // Keep reading to find the terminator, but stop buying memory.
      this.dataOversize = true;
      return;
    }
    this.dataChunks.push(chunk);
    this.dataLen += chunk.length;
  }

  finishData(contentLen) {
    if (this.dataOversize) return null;
    const all = this.dataChunks.length === 1 ? this.dataChunks[0] : Buffer.concat(this.dataChunks, this.dataLen);
    this.dataChunks = [];
    const body = all.subarray(0, Math.max(0, contentLen));
    return unstuff(body);
  }

  // ------------------------------------------------------------- CHUNKING --

  cmdBdat(rest) {
    if (this.mailFrom === null) return this.fail(503, '5.5.1', 'need MAIL before BDAT');
    if (!this.recipients.length) return this.fail(503, '5.5.1', 'need RCPT before BDAT');
    const parts = (rest || '').trim().split(/\s+/).filter(Boolean);
    const size = Number(parts[0]);
    if (!Number.isInteger(size) || size < 0) return this.fail(501, '5.5.4', 'syntax: BDAT <size> [LAST]');
    if (parts.length > 2) return this.fail(501, '5.5.4', 'syntax: BDAT <size> [LAST]');
    if (parts.length === 2 && parts[1].toUpperCase() !== 'LAST') {
      return this.fail(501, '5.5.4', 'syntax: BDAT <size> [LAST]');
    }
    this.bdatLast = parts.length === 2;
    this.bdatRemaining = size;
    this.state = S.BDAT;
    // The pump takes it from here: it will read exactly `size` octets out of
    // the input buffer and then call finishBdatChunk().
  }

  /**
   * Read up to bdatRemaining raw octets from the input buffer.
   * Returns true when the chunk completed (keep pumping), false when we need
   * more input. RFC 3030: BDAT data is length-delimited, NOT dot-stuffed, and
   * has no <CRLF>.<CRLF> terminator.
   */
  async consumeBdat() {
    if (this.bdatRemaining > 0) {
      if (!this.buf.length) return false;
      const take = this.buf.subarray(0, Math.min(this.buf.length, this.bdatRemaining));
      this.buf = this.buf.subarray(take.length);
      this.bdatRemaining -= take.length;
      this.bdatLen += take.length;
      if (this.bdatLen > this.cfg.maxMessageBytes) {
        this.bdatOversize = true;
        this.bdatChunks = [];
      } else {
        this.bdatChunks.push(take);
      }
      if (this.bdatRemaining > 0) return false;
    }
    await this.finishBdatChunk();
    return true;
  }

  async finishBdatChunk() {
    this.state = S.COMMAND;
    if (this.bdatOversize) {
      const last = this.bdatLast;
      this.resetTransaction();
      this.fail(552, '5.3.4', `message exceeds the ${this.cfg.maxMessageBytes} byte limit`, 'oversize (BDAT)');
      this.bdatLast = last;
      return;
    }
    if (!this.bdatLast) {
      this.respond(250, '2.0.0', `${this.bdatLen} octets received`);
      return;
    }
    const raw = Buffer.concat(this.bdatChunks, this.bdatLen);
    this.bdatChunks = [];
    await this.endOfMessage(raw, 'BDAT');
  }

  // -------------------------------------------------------- end of message --

  async endOfMessage(rawBody, via) {
    const recipients = this.recipients;
    const mailFrom = this.mailFrom;
    const declaredSize = this.declaredSize;
    const oversize = rawBody === null || this.dataOversize || this.bdatOversize;
    this.resetTransaction();

    if (oversize) {
      return this.fail(552, '5.3.4',
        `message exceeds the ${this.cfg.maxMessageBytes} byte limit`, 'oversize');
    }
    if (declaredSize && rawBody.length > this.cfg.maxMessageBytes) {
      return this.fail(552, '5.3.4', `message exceeds the ${this.cfg.maxMessageBytes} byte limit`, 'oversize');
    }

    const messageRequestId = requestId();
    const receivedAt = new Date();
    const envelope = {
      from: mailFrom,
      to: recipients.map((r) => r.rcptTo),
      helo: this.helo,
      remote_ip: this.remoteIp,
      tls: this.secure,
    };

    log.info('mail.received', {
      request_id: messageRequestId, session: this.id, remote_ip: this.remoteIp,
      helo: this.helo, mail_from: mailFrom, rcpt_count: recipients.length,
      bytes: rawBody.length, tls: this.secure, via,
    });

    // --- authentication (SPF/DKIM/DMARC/spam) on the message AS RECEIVED ----
    let authResult;
    try {
      authResult = await authenticateWithDeadline(rawBody, envelope, {
        dns: this.server.dnsClient,
        spfEnabled: this.cfg.spfEnabled,
        dkimEnabled: this.cfg.dkimEnabled,
        dmarcEnabled: this.cfg.dmarcEnabled,
        timeoutMs: this.cfg.authTimeoutMs,
      });
    } catch (e) {
      log.error('mail.auth_error', { request_id: messageRequestId, error: e.message });
      authResult = {
        auth: { spf: 'temperror', dkim: 'temperror', dmarc: 'temperror', spam_score: 0 },
        flags: [], details: {}, timings_ms: {},
      };
    }

    // --- trace headers ------------------------------------------------------
    const trace =
      receivedHeader({
        helo: this.helo,
        remoteIp: this.remoteIp,
        reverseDns: this.reverseDns,
        hostname: this.cfg.hostname,
        id: this.id,
        tls: this.secure,
        tlsInfo: this.tlsInfo,
        esmtp: this.esmtp,
        smtputf8: this.smtputf8,
        forAddress: recipients.length === 1 ? recipients[0].rcptTo : null,
        date: receivedAt,
      }) +
      authenticationResultsHeader(this.cfg.hostname, authResult) +
      `Return-Path: <${mailFrom}>\r\n`;

    const raw = Buffer.concat([Buffer.from(trace, 'utf8'), rawBody]);

    const meta = {
      id: this.id + '-' + crypto.randomBytes(4).toString('hex'),
      request_id: messageRequestId,
      received_at: receivedAt.toISOString(),
      envelope,
      recipients: recipients.map((r) => ({
        address: r.address, token: r.token, slug: r.slug, tag: r.tag,
        rcpt_to: r.rcptTo, mailbox: r.mailbox,
      })),
      auth: authResult.auth,
      flags: authResult.flags,
      auth_details: authResult.details,
      via,
    };

    const outcome = await this.server.deliverer.handle(raw, meta);
    this.messages++;
    const [code, enhanced] = outcome.code.split(' ');
    this.respond(Number(code), enhanced, outcome.message);
    if (outcome.action !== 'accepted') {
      log.warn('smtp.rejected', {
        request_id: messageRequestId, session: this.id, code: outcome.code,
        reason: outcome.message, action: outcome.action,
      });
    }
  }

  cmdRset() {
    this.resetTransaction();
    this.respond(250, '2.0.0', 'OK');
  }

  resetTransaction() {
    this.mailFrom = null;
    this.mailParams = null;
    this.recipients = [];
    this.declaredSize = 0;
    this.smtputf8 = false;
    this.dataChunks = [];
    this.dataLen = 0;
    this.dataOctets = 0;
    this.dataOversize = false;
    this.termState = 0;
    this.bdatChunks = [];
    this.bdatLen = 0;
    this.bdatRemaining = 0;
    this.bdatLast = false;
    this.bdatOversize = false;
    if (this.state === S.DATA || this.state === S.BDAT) this.state = S.COMMAND;
  }
}

// ---------------------------------------------------------------- helpers ---

function normaliseIp(ip) {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip || '');
  return m ? m[1] : ip;
}

/**
 * RFC 5321 §4.5.2 transparency: a line that begins with '.' had an extra '.'
 * prepended by the sender. Remove exactly one.
 */
function unstuff(buf) {
  // fast path: nothing to do
  let needs = buf.length > 0 && buf[0] === DOT;
  if (!needs) {
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === DOT) { needs = true; break; }
    }
  }
  if (!needs) return buf;

  const out = Buffer.allocUnsafe(buf.length);
  let w = 0;
  let atLineStart = true;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (atLineStart && c === DOT) {
      atLineStart = false;
      continue; // drop the stuffing dot
    }
    out[w++] = c;
    atLineStart = c === LF;
  }
  return out.subarray(0, w);
}

// ----------------------------------------------------------------- server ---

class SmtpServer extends EventEmitter {
  constructor(cfg, deps = {}) {
    super();
    this.cfg = cfg;
    this.sessions = new Set();
    this.perIp = new Map();
    this.resolver = deps.resolver;
    this.deliverer = deps.deliverer;
    this.dnsClient = deps.dnsClient || new DnsClient({ servers: cfg.dnsServers, timeoutMs: cfg.authTimeoutMs });
    this.rdnsCache = new Map();
    this.tlsOptions = null;
    this.secureContext = null;
    this.stats = { connections: 0, accepted: 0, rejected: 0 };

    if (cfg.tlsEnabled) this.loadTls();

    this.server = net.createServer({ pauseOnConnect: false }, (sock) => this.onConnection(sock));
    this.server.on('error', (e) => this.emit('error', e));
  }

  loadTls() {
    try {
      const opts = {
        key: fs.readFileSync(this.cfg.tlsKeyPath),
        cert: fs.readFileSync(this.cfg.tlsCertPath),
        minVersion: this.cfg.tlsMinVersion,
        honorCipherOrder: true,
      };
      if (this.cfg.tlsCaPath) opts.ca = fs.readFileSync(this.cfg.tlsCaPath);
      this.secureContext = tls.createSecureContext(opts);
      this.tlsOptions = { minVersion: this.cfg.tlsMinVersion };
      log.info('smtp.tls_loaded', { cert: this.cfg.tlsCertPath });
    } catch (e) {
      // No certificate means no STARTTLS advertisement. It must NOT mean a
      // crash, and it must not mean advertising something we cannot do.
      this.tlsOptions = null;
      this.secureContext = null;
      log.error('smtp.tls_load_failed', { error: e.message, cert: this.cfg.tlsCertPath });
    }
  }

  overloaded() { return this.sessions.size > this.cfg.maxConcurrentSessions; }

  tooManyFromIp(ip) { return (this.perIp.get(ip) || 0) > this.cfg.maxSessionsPerIp; }

  onConnection(socket) {
    socket.setNoDelay(true);
    this.stats.connections++;
    const session = new Session(socket, this);
    this.sessions.add(session);
    this.perIp.set(session.remoteIp, (this.perIp.get(session.remoteIp) || 0) + 1);
    session.greet();
    this.emit('session', session);
  }

  _release(session) {
    if (!this.sessions.delete(session)) return;
    const n = (this.perIp.get(session.remoteIp) || 1) - 1;
    if (n <= 0) this.perIp.delete(session.remoteIp);
    else this.perIp.set(session.remoteIp, n);
  }

  async reverseLookup(ip) {
    const hit = this.rdnsCache.get(ip);
    if (hit && hit.exp > Date.now()) return hit.name;
    let name = null;
    try {
      const names = await dns.promises.reverse(ip);
      name = names && names.length ? names[0] : null;
    } catch { name = null; }
    if (this.rdnsCache.size > 5000) this.rdnsCache.clear();
    this.rdnsCache.set(ip, { name, exp: Date.now() + 600000 });
    return name;
  }

  listen(port = this.cfg.port, host = this.cfg.host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        const a = this.server.address();
        log.info('smtp.listening', {
          host: a.address, port: a.port, hostname: this.cfg.hostname,
          domains: this.cfg.inboundDomains, tls: Boolean(this.tlsOptions),
          max_message_bytes: this.cfg.maxMessageBytes,
        });
        resolve(a);
      });
    });
  }

  address() { return this.server.address(); }

  async close({ force = false } = {}) {
    await new Promise((resolve) => this.server.close(resolve));
    if (force) for (const s of this.sessions) { try { s.socket.destroy(); } catch { /* ignore */ } }
  }
}

module.exports = { SmtpServer, Session, unstuff, queueId, TERMINATOR, TERM_FAIL };
