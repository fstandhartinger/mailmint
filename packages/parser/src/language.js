'use strict';
/** Best-effort language guess from function words. Cheap, and honest about it. */
const MARKERS = {
  en: ['the', 'and', 'you', 'your', 'for', 'with', 'this', 'that', 'have', 'from', 'please', 'will', 'been', 'invoice', 'thanks'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'sie', 'ihre', 'für', 'mit', 'wir', 'bitte', 'auf', 'eine', 'rechnung', 'werden'],
  fr: ['le', 'la', 'les', 'et', 'est', 'vous', 'pour', 'avec', 'nous', 'votre', 'dans', 'une', 'que', 'facture', 'merci'],
  es: ['el', 'la', 'los', 'que', 'de', 'para', 'con', 'una', 'por', 'su', 'gracias', 'factura', 'usted', 'como'],
  it: ['il', 'la', 'che', 'per', 'con', 'una', 'del', 'sono', 'grazie', 'fattura', 'della', 'nel'],
  nl: ['de', 'het', 'een', 'van', 'is', 'voor', 'met', 'wij', 'uw', 'niet', 'dank', 'factuur'],
  pt: ['de', 'que', 'para', 'com', 'uma', 'não', 'obrigado', 'fatura', 'você', 'seu'],
};

function detectLanguage(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ');
  if (s.trim().length < 24) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 8) return null;
  const counts = {};
  for (const [lang, markers] of Object.entries(MARKERS)) {
    let n = 0;
    for (const w of words) if (markers.includes(w)) n++;
    counts[lang] = n / words.length;
  }
  let best = null, bestScore = 0;
  for (const [lang, sc] of Object.entries(counts)) if (sc > bestScore) { best = lang; bestScore = sc; }
  return bestScore >= 0.012 ? best : null;
}
module.exports = { detectLanguage };
