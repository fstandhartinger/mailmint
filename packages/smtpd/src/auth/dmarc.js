'use strict';
// DMARC — RFC 7489. Look up _dmarc.<from-domain> (falling back to the
// organisational domain), evaluate SPF and DKIM alignment against the From:
// domain, honour p= / sp= / adkim= / aspf= / pct=.

const { DnsClient } = require('./dns');
const { orgDomain } = require('./psl');

function parseRecord(txt) {
  const tags = Object.create(null);
  for (const part of txt.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    tags[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return tags;
}

async function findRecord(dnsClient, fromDomain) {
  const tried = [];
  const candidates = [fromDomain];
  const org = orgDomain(fromDomain);
  if (org && org !== fromDomain) candidates.push(org);

  for (const d of candidates) {
    const name = `_dmarc.${d}`;
    tried.push(name);
    let txts;
    try { txts = await dnsClient.txt(name); }
    catch (e) {
      if (e.temporary) { const err = new Error(`DMARC lookup ${name}: ${e.code}`); err.temporary = true; throw err; }
      continue;
    }
    const recs = txts.filter((t) => /^\s*v\s*=\s*DMARC1\s*;/i.test(t));
    if (recs.length === 1) {
      return { owner: d, isOrgFallback: d !== fromDomain, tags: parseRecord(recs[0]), raw: recs[0], tried };
    }
    if (recs.length > 1) {
      // RFC 7489 §6.6.3: multiple records => the domain has no usable policy
      return { owner: d, error: 'multiple DMARC records', tried };
    }
  }
  return null;
}

/** strict alignment = exact match; relaxed = same organisational domain */
function aligned(childDomain, fromDomain, mode) {
  if (!childDomain || !fromDomain) return false;
  const a = childDomain.toLowerCase().replace(/\.$/, '');
  const b = fromDomain.toLowerCase().replace(/\.$/, '');
  if (a === b) return true;
  if (mode === 's') return false;
  return orgDomain(a) === orgDomain(b);
}

/**
 * @param {object} o
 * @param {string} o.fromDomain     domain of the RFC5322 From: header
 * @param {object} o.spf            { result, domain }  (domain = MAIL FROM domain)
 * @param {object} o.dkim           { signatures: [{result, domain}] }
 * @param {number} [o.fromCount]    number of addresses in From:
 * @param {DnsClient} [o.dns]
 */
async function evaluate(o) {
  const dnsClient = o.dns || new DnsClient();
  const out = {
    result: 'none',
    policy: null,
    disposition: 'none',
    domain: o.fromDomain || null,
    policyDomain: null,
    alignment: { spf: false, dkim: false },
    spfResult: o.spf ? o.spf.result : 'none',
    dkimResult: o.dkim ? o.dkim.result : 'none',
    reason: null,
  };

  if (!o.fromDomain) { out.reason = 'no usable From: domain'; return out; }
  if (o.fromCount && o.fromCount > 1) {
    // RFC 7489 §6.6.1: more than one From: address cannot be evaluated
    out.result = 'fail';
    out.reason = 'multiple From: addresses';
  }

  let rec;
  try { rec = await findRecord(dnsClient, o.fromDomain); }
  catch (e) { out.result = 'temperror'; out.reason = e.message; return out; }
  if (!rec) { out.reason = `no DMARC record for ${o.fromDomain}`; return out; }
  if (rec.error) { out.reason = rec.error; out.policyDomain = rec.owner; return out; }

  const tags = rec.tags;
  out.policyDomain = rec.owner;
  const adkim = (tags.adkim || 'r').toLowerCase();
  const aspf = (tags.aspf || 'r').toLowerCase();
  // sp= applies when the policy came from the organisational domain and the
  // From: domain is a subdomain of it.
  const policy = (rec.isOrgFallback && tags.sp ? tags.sp : tags.p || 'none').toLowerCase();
  out.policy = ['none', 'quarantine', 'reject'].includes(policy) ? policy : 'none';
  out.pct = tags.pct === undefined ? 100 : Math.max(0, Math.min(100, Number(tags.pct) || 0));

  // --- SPF alignment: MAIL FROM domain must align, and SPF must pass
  const spfDomain = o.spf && o.spf.domain;
  out.alignment.spf = Boolean(o.spf && o.spf.result === 'pass' && aligned(spfDomain, o.fromDomain, aspf));

  // --- DKIM alignment: at least one PASSING signature whose d= aligns
  const sigs = (o.dkim && o.dkim.signatures) || [];
  const alignedSig = sigs.find((s) => s.result === 'pass' && aligned(s.domain, o.fromDomain, adkim));
  out.alignment.dkim = Boolean(alignedSig);
  if (alignedSig) out.alignedDkimDomain = alignedSig.domain;

  if (out.result === 'fail' && out.reason === 'multiple From: addresses') {
    // already decided
  } else if (out.alignment.spf || out.alignment.dkim) {
    out.result = 'pass';
    out.reason = out.alignment.dkim ? 'aligned DKIM signature' : 'aligned SPF pass';
  } else {
    out.result = 'fail';
    const bits = [];
    if (out.spfResult !== 'pass') bits.push(`spf=${out.spfResult}`);
    else bits.push(`spf domain ${spfDomain} not aligned with ${o.fromDomain}`);
    if (!sigs.length) bits.push('no DKIM signature');
    else bits.push(`no aligned passing DKIM (${sigs.map((s) => `${s.domain}=${s.result}`).join(', ')})`);
    out.reason = bits.join('; ');
  }

  if (out.result === 'fail') {
    out.disposition = out.policy === 'none' ? 'none' : out.policy;
    // pct< 100 means only that share of failures gets the policy applied
    if (out.pct < 100 && Math.random() * 100 >= out.pct) out.disposition = 'none';
  }
  return out;
}

module.exports = { evaluate, parseRecord, findRecord, aligned, orgDomain };
