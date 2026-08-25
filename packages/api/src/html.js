'use strict';

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Everything a customer supplies — a mailbox name, a subject line, a field
 * value the parser lifted out of a stranger's email — goes through here before
 * it reaches the page. The dangerous input on this dashboard is not the
 * account holder's own typing; it is the body of mail sent to them by someone
 * they have never met.
 */
const escapeHtml = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => MAP[c]);

/** Pretty JSON, escaped, for a <pre> block. */
const json = (v) => escapeHtml(JSON.stringify(v, null, 2));

const timeAgo = (d) => {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

module.exports = { escapeHtml, json, timeAgo };
