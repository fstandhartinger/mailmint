'use strict';
// Organisational-domain derivation for DMARC alignment (RFC 7489 §3.2).
//
// The full Public Suffix List is ~10k entries and a moving target; shipping a
// stale copy is worse than shipping a rule. So: default to "registered domain =
// last two labels", with an explicit table of the multi-label public suffixes
// that actually carry mail. If PSL_PATH points at a public_suffix_list.dat we
// load that instead and use it properly.

const fs = require('node:fs');

// Multi-label public suffixes seen on real mail. Second-level entries only;
// a domain under one of these needs three labels to be an org domain.
const MULTI = new Set([
  // generic
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz', 'geek.nz',
  'co.za', 'org.za', 'net.za', 'web.za', 'gov.za', 'ac.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'pe.kr', 'ac.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl', 'waw.pl',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua', 'kiev.ua',
  'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'com.pt', 'org.pt', 'edu.pt', 'gov.pt',
  'com.gr', 'net.gr', 'org.gr', 'edu.gr', 'gov.gr',
  'co.id', 'or.id', 'web.id', 'go.id', 'ac.id', 'sch.id',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'co.th', 'in.th', 'go.th', 'ac.th', 'or.th', 'net.th',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.bd', 'net.bd', 'org.bd', 'gov.bd', 'edu.bd',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'co.ke', 'or.ke', 'go.ke', 'ac.ke',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'com.ec', 'com.uy', 'com.ve', 'com.bo', 'com.py', 'com.do', 'com.gt',
  'co.cr', 'com.pa', 'com.cu', 'com.ni', 'com.sv', 'com.hn',
  'com.cy', 'com.mt', 'com.hr', 'com.ee', 'com.lv', 'com.lt',
  'co.at', 'or.at', 'ac.at', 'gv.at', 'priv.at',
  'co.hu', 'org.hu', 'gov.hu',
  'com.de', 'com.se', 'org.se', 'pp.se', 'a.se',
  'com.ua', 'net.ua',
  'gov.ie', 'co.ie',
  // hosting / user-content suffixes that behave like public suffixes for mail
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'appspot.com', 'cloudfunctions.net', 's3.amazonaws.com', 'firebaseapp.com',
  'azurewebsites.net', 'vercel.app', 'netlify.app', 'onrender.com', 'fly.dev',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'sharepoint.com',
]);

let pslRules = null;

function loadPsl(pathname) {
  const text = fs.readFileSync(pathname, 'utf8');
  const rules = { exact: new Set(), wildcard: new Set(), exception: new Set() };
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) rules.exception.add(line.slice(1).toLowerCase());
    else if (line.startsWith('*.')) rules.wildcard.add(line.slice(2).toLowerCase());
    else rules.exact.add(line.toLowerCase());
  }
  pslRules = rules;
  return rules;
}

if (process.env.PSL_PATH) {
  try { loadPsl(process.env.PSL_PATH); } catch { pslRules = null; }
}

/** The organisational domain: the registrable domain one label below the public suffix. */
function orgDomain(domain) {
  if (!domain) return null;
  const d = String(domain).toLowerCase().replace(/\.$/, '');
  const labels = d.split('.');
  if (labels.length <= 1) return d;

  if (pslRules) {
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      if (pslRules.exception.has(candidate)) return candidate;
      const parentWildcard = labels.slice(i + 1).join('.');
      if (pslRules.exact.has(candidate) || (parentWildcard && pslRules.wildcard.has(parentWildcard))) {
        return i === 0 ? candidate : labels.slice(i - 1).join('.');
      }
    }
    return labels.slice(-2).join('.');
  }

  if (labels.length >= 3) {
    const last2 = labels.slice(-2).join('.');
    if (MULTI.has(last2)) return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

module.exports = { orgDomain, loadPsl, MULTI };
