'use strict';

/**
 * The public marketing and documentation site.
 *
 * These pages are plain static files in `packages/api/public/`. They would be
 * served by the existing `express.static` mount on their own — `/index.html`,
 * `/docs.html` and so on all work today — but `web.js` claims `/` and `/docs`
 * first, so without this router the landing page and the reference would sit
 * behind their file extensions while a placeholder answered the pretty URL.
 *
 * Kept as one file on purpose: `web.js` and `api.js` belong to someone else,
 * and the only change needed there is the two lines in `server.js` that mount
 * this ahead of `web.router`.
 *
 * `/` deliberately falls through when a session cookie is present, so a
 * signed-in visitor still gets `web.js`'s redirect to the dashboard rather than
 * a marketing page they have already bought.
 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'mailmint_session';

/** Pretty URL -> file. Everything else is left to express.static. */
const PAGES = {
  '/': 'index.html',
  '/docs': 'docs.html',
  '/quickstart': 'quickstart.html',
  '/n8n': 'n8n.html',
  // Comparison and category pages. Same chrome, same CSS, no build step: the
  // file name is the slug with `.html` on the end, exactly like the four above.
  '/email-parsing-api': 'email-parsing-api.html',
  '/mailparser-alternative': 'mailparser-alternative.html',
  '/parseur-alternative': 'parseur-alternative.html',
  '/zapier-email-parser-alternative': 'zapier-email-parser-alternative.html',
  '/docparser-alternative': 'docparser-alternative.html',
};

const hasSession = (req) => new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(req.headers.cookie || '');

function send(res, next, file) {
  const full = path.join(PUBLIC_DIR, file);
  // A missing page must not 500 — fall through and let the 404 handler answer.
  fs.access(full, fs.constants.R_OK, (err) => {
    if (err) return next();
    res.type('html');
    res.sendFile(full, { maxAge: '5m' }, (e) => { if (e) next(e); });
  });
}

for (const [url, file] of Object.entries(PAGES)) {
  router.get(url, (req, res, next) => {
    if (url === '/' && hasSession(req)) return next();
    return send(res, next, file);
  });
}

// Pricing lives in a section of the landing page rather than on a page of its
// own, but "/pricing" is what people type and what other pages link to, so it
// has to lead somewhere rather than 404.
router.get('/pricing', (req, res) => res.redirect(302, '/#pricing'));

// The .html forms redirect to the canonical pretty URL, so only one of the two
// ever ends up in a search index or in somebody's bookmark.
for (const [url, file] of Object.entries(PAGES)) {
  if (url === '/') continue;
  router.get(`/${file}`, (req, res) => res.redirect(301, url));
}

module.exports = { router, PAGES };
