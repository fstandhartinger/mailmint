'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A throwaway self-signed cert for the STARTTLS test. Returns null if openssl is absent. */
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailmint-imap-tls-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    ], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return {
    key: fs.readFileSync(path.join(dir, 'k.pem')),
    cert: fs.readFileSync(path.join(dir, 'c.pem')),
    dir,
  };
}

module.exports = { selfSigned };
