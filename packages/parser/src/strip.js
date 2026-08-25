'use strict';

/**
 * Quoted-reply and signature removal.
 *
 * Users notice this more than anything else in a mail parser: leave the quoted
 * chain in and every extraction picks up last week's invoice number instead of
 * this week's. The rules below are ordered from most to least certain, and the
 * cut is always taken at the EARLIEST confident marker, because a reply chain
 * that starts a third of the way down still has quoted headers below it.
 */

/** Lines that announce "everything after this belongs to an older message". */
const HARD_DIVIDERS = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Urspr(?:ü|ue)ngliche Nachricht\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^-{2,}\s*Weitergeleitete Nachricht\s*-{2,}\s*$/i,
  /^-{2,}\s*Message d'origine\s*-{2,}\s*$/i,
  /^-{2,}\s*Mensaje original\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,                                  // Outlook's horizontal rule before the From: block
  /^\s*Begin forwarded message:\s*$/i,
  /^\s*Anfang der weitergeleiteten Nachricht:\s*$/i,
  /^={10,}\s*$/,
];

/**
 * "On <date> <someone> wrote:" attributions. These wrap across up to three
 * lines in practice, so the caller joins a small window before matching.
 */
const ATTRIBUTIONS = [
  /^\s*On\b[\s\S]{4,220}?\bwrote\s*:\s*$/i,
  /^\s*Am\b[\s\S]{4,220}?\bschrieb\b[\s\S]{0,120}?:\s*$/i,
  /^\s*Am\b[\s\S]{4,220}?\bschrieb\s*:\s*$/i,
  /^\s*Le\b[\s\S]{4,220}?\ba\s+(?:é|e)crit\s*:\s*$/i,
  /^\s*El\b[\s\S]{4,220}?\bescribi(?:ó|o)\s*:\s*$/i,
  /^\s*Op\b[\s\S]{4,220}?\bschreef\b[\s\S]{0,60}:\s*$/i,
  /^\s*[^\n]{0,120}\bwrote\s+on\s+[^\n]{4,80}:\s*$/i,
  /^\s*.{0,80}<[^@\s>]+@[^@\s>]+>\s+writes?\s*:\s*$/i,   // Gnus / mutt style
  /^\s*.{2,80}\bwrites?\s*:\s*$/i,
  /^\s*\*?From:\*?\s*.{2,200}$/i,                        // Outlook quoted-header block
];

/** The Outlook block is only a divider when Sent/To/Subject follow the From. */
function isOutlookHeaderBlock(lines, i) {
  if (!/^\s*\*?From:\*?\s/i.test(lines[i])) return false;
  const window = lines.slice(i + 1, i + 6).join('\n');
  return /^\s*\*?(Sent|Gesendet|Date|Datum|To|An|Subject|Betreff):/im.test(window);
}

const SIG_MARKERS = [
  /^\s*(?:Best|Kind|Warm)\s+regards\s*[,.!]?\s*$/i,
  /^\s*(?:Regards|Cheers|Thanks|Thank you|Sincerely|Yours(?: truly| sincerely)?|Best)\s*[,.!]?\s*$/i,
  /^\s*(?:Mit freundlichen Gr(?:ü|ue)(?:ß|ss)en|Viele Gr(?:ü|ue)(?:ß|ss)e|Beste Gr(?:ü|ue)(?:ß|ss)e|Liebe Gr(?:ü|ue)(?:ß|ss)e|LG|MfG|VG)\s*[,.!]?\s*$/i,
  /^\s*(?:Cordialement|Bien (?:à|a) vous|Saludos|Atentamente|Met vriendelijke groet)\s*[,.!]?\s*$/i,
  /^\s*Sent from my \w+/i,
  /^\s*Von meinem (?:iPhone|iPad|Android|Samsung)/i,
  /^\s*Get Outlook for \w+/i,
];

const SIG_CONTENT = [
  /^\s*(?:Tel|Phone|Mobile|Mobil|Fax|Cell|T|M|E)\s*[.:]\s*[+\d(]/i,
  /^\s*(?:USt-IdNr|Ust-ID|VAT|Amtsgericht|Handelsregister|HRB|Gesch(?:ä|ae)ftsf(?:ü|ue)hrer|Registered in)\b/i,
  /^\s*(?:www\.|https?:\/\/)\S+\s*$/i,
  /^\s*[\w.+-]+@[\w.-]+\.\w{2,}\s*$/,
  /^\s*(?:This (?:e-?mail|message) (?:and any|is) )/i,
  /^\s*(?:Diese E-Mail|Diese Nachricht) (?:kann|enth(?:ä|ae)lt|ist)/i,
];

/**
 * Remove the quoted chain. Returns { text, cut } where `cut` says whether
 * anything was removed.
 */
function stripQuotes(input) {
  const text = String(input || '');
  const lines = text.split('\n');
  let cut = lines.length;
  let reason = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const re of HARD_DIVIDERS) {
      if (re.test(line)) { if (i < cut) { cut = i; reason = 'divider'; } break; }
    }
    if (reason && cut === i) break;

    if (isOutlookHeaderBlock(lines, i)) { cut = i; reason = 'outlook'; break; }

    // Attribution lines wrap; try this line, then this + next, then + two.
    for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
      const joined = lines.slice(i, i + span).join(' ').replace(/\s+/g, ' ').trim();
      if (joined.length > 400) break;
      if (!/:\s*$/.test(joined) && span < 3) continue;
      if (!/:\s*$/.test(joined)) break;
      if (matchAttribution(joined)) { cut = i; reason = 'attribution'; break; }
    }
    if (reason === 'attribution') break;

    // A run of quoted lines that reaches the end of the message.
    if (/^\s*>/.test(line)) {
      let j = i;
      let sawText = false;
      while (j < lines.length) {
        const l = lines[j];
        if (/^\s*>/.test(l) || l.trim() === '') { if (/^\s*>/.test(l)) sawText = true; j++; continue; }
        break;
      }
      if (sawText && j >= lines.length) { cut = i; reason = 'quote-run'; break; }
      i = j - 1;
    }
  }

  let kept = lines.slice(0, cut);
  // Anything still prefixed with '>' inside the kept region is interleaved quoting.
  kept = kept.filter((l) => !/^\s*>/.test(l));
  // An attribution can sit directly above the cut with a blank line between.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  if (kept.length) {
    const lastJoined = kept.slice(Math.max(0, kept.length - 3)).join(' ').replace(/\s+/g, ' ').trim();
    if (/:\s*$/.test(lastJoined) && matchAttribution(lastJoined)) {
      kept = kept.slice(0, Math.max(0, kept.length - 3));
      while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    }
  }
  return { text: kept.join('\n'), cut: cut < lines.length, reason };
}

function matchAttribution(joined) {
  if (/^\s*\*?From:\*?\s/i.test(joined)) return false;   // handled by the Outlook rule only
  return ATTRIBUTIONS.some((re) => re.test(joined));
}

/**
 * Remove a trailing signature.
 *  - `-- ` on its own line is the RFC 3676 delimiter and is authoritative.
 *  - Otherwise look at the last few lines for a valediction or contact block.
 */
function stripSignature(input) {
  const text = String(input || '');
  const lines = text.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^--\s?$/.test(lines[i]) && i > 0) {
      return { text: lines.slice(0, i).join('\n').replace(/\s+$/, ''), cut: true, reason: 'delimiter' };
    }
  }

  // Heuristic: scan the tail for a valediction, then check what follows is short.
  const TAIL = Math.min(lines.length, 14);
  for (let i = lines.length - TAIL; i < lines.length; i++) {
    if (i < 1) continue;
    if (!SIG_MARKERS.some((re) => re.test(lines[i]))) continue;
    const after = lines.slice(i + 1).filter((l) => l.trim() !== '');
    if (after.length > 8) continue;
    if (after.some((l) => l.trim().length > 90)) continue;
    return { text: lines.slice(0, i).join('\n').replace(/\s+$/, ''), cut: true, reason: 'valediction' };
  }

  // Contact-details block at the very end with no valediction above it.
  let start = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const l = lines[i];
    if (l.trim() === '') { if (start !== -1) break; continue; }
    if (SIG_CONTENT.some((re) => re.test(l)) && l.trim().length < 120) { start = i; continue; }
    break;
  }
  if (start > 0) {
    const block = lines.slice(start).filter((l) => l.trim() !== '');
    if (block.length >= 2) {
      return { text: lines.slice(0, start).join('\n').replace(/\s+$/, ''), cut: true, reason: 'contact-block' };
    }
  }
  return { text: text.replace(/\s+$/, ''), cut: false, reason: null };
}

/** Both passes. Never returns empty when the input was not: if stripping ate
 *  everything we keep the original, because a wrong strip is worse than none. */
function strippedText(input) {
  const original = String(input || '');
  const q = stripQuotes(original);
  const s = stripSignature(q.text);
  let out = s.text.replace(/\n{3,}/g, '\n\n').trim();
  if (!out.trim() && original.trim()) {
    const q2 = stripQuotes(original);
    out = q2.text.trim() || original.trim();
  }
  return { text: out, quoteRemoved: q.cut, signatureRemoved: s.cut, reasons: [q.reason, s.reason].filter(Boolean) };
}

module.exports = { strippedText, stripQuotes, stripSignature };
