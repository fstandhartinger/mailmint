'use strict';

/**
 * Glyph name -> Unicode.
 *
 * Needed in two places: inverting a font's `post` table (sfnt.js) and resolving
 * a simple font's /Encoding /Differences array (differences.js). Both are how a
 * PDF says "this byte is the euro sign" without ever storing the character.
 *
 * The full Adobe Glyph List is ~4300 entries. Shipping it would be dead weight:
 * the algorithmic forms (`uniXXXX`, `uXXXXX`) cover everything modern, and the
 * table below covers the classic names that actually appear in invoices,
 * statements and forms — ASCII, Latin-1 accents, currency and punctuation.
 * Anything outside that returns 0 and the caller falls back rather than guessing.
 */

const NAMES = Object.create(null);

// ASCII, by their standard names.
const ASCII = ('space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft '
  + 'parenright asterisk plus comma hyphen period slash zero one two three four five six seven '
  + 'eight nine colon semicolon less equal greater question at').split(' ');
ASCII.forEach((n, i) => { NAMES[n] = 0x20 + i; });
for (let c = 0x41; c <= 0x5a; c++) NAMES[String.fromCharCode(c)] = c;
for (let c = 0x61; c <= 0x7a; c++) NAMES[String.fromCharCode(c)] = c;
Object.assign(NAMES, {
  bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
  grave: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
});

// The punctuation and symbols that actually turn up in documents.
Object.assign(NAMES, {
  quoteright: 0x2019, quoteleft: 0x2018, quotedblleft: 0x201c, quotedblright: 0x201d,
  quotesinglbase: 0x201a, quotedblbase: 0x201e, endash: 0x2013, emdash: 0x2014,
  bullet: 0x2022, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, guillemotleft: 0xab, guillemotright: 0xbb,
  fraction: 0x2044, minus: 0x2212, trademark: 0x2122, copyright: 0xa9, registered: 0xae,
  degree: 0xb0, plusminus: 0xb1, multiply: 0xd7, divide: 0xf7, notequal: 0x2260,
  lessequal: 0x2264, greaterequal: 0x2265, arrowright: 0x2192, arrowleft: 0x2190,
  fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04,
  nbspace: 0xa0, uni00A0: 0xa0, softhyphen: 0xad, hyphenminus: 0x2d,
  euro: 0x20ac, Euro: 0x20ac, sterling: 0xa3, yen: 0xa5, cent: 0xa2, currency: 0xa4,
  florin: 0x192, dollaroldstyle: 0x24, section: 0xa7, paragraph: 0xb6, periodcentered: 0xb7,
  brokenbar: 0xa6, exclamdown: 0xa1, questiondown: 0xbf, ordfeminine: 0xaa, ordmasculine: 0xba,
  onehalf: 0xbd, onequarter: 0xbc, threequarters: 0xbe, onesuperior: 0xb9, twosuperior: 0xb2,
  threesuperior: 0xb3, mu: 0xb5, logicalnot: 0xac, macron: 0xaf, acute: 0xb4, cedilla: 0xb8,
  dieresis: 0xa8, circumflex: 0x2c6, tilde: 0x2dc, breve: 0x2d8, dotaccent: 0x2d9,
  ring: 0x2da, ogonek: 0x2db, hungarumlaut: 0x2dd, caron: 0x2c7,
});

// Latin-1 and Latin Extended-A letters, spelled out the way the AGL does.
const ACCENTED = {
  Agrave: 0xc0, Aacute: 0xc1, Acircumflex: 0xc2, Atilde: 0xc3, Adieresis: 0xc4, Aring: 0xc5,
  AE: 0xc6, Ccedilla: 0xc7, Egrave: 0xc8, Eacute: 0xc9, Ecircumflex: 0xca, Edieresis: 0xcb,
  Igrave: 0xcc, Iacute: 0xcd, Icircumflex: 0xce, Idieresis: 0xcf, Eth: 0xd0, Ntilde: 0xd1,
  Ograve: 0xd2, Oacute: 0xd3, Ocircumflex: 0xd4, Otilde: 0xd5, Odieresis: 0xd6, Oslash: 0xd8,
  Ugrave: 0xd9, Uacute: 0xda, Ucircumflex: 0xdb, Udieresis: 0xdc, Yacute: 0xdd, Thorn: 0xde,
  germandbls: 0xdf, agrave: 0xe0, aacute: 0xe1, acircumflex: 0xe2, atilde: 0xe3, adieresis: 0xe4,
  aring: 0xe5, ae: 0xe6, ccedilla: 0xe7, egrave: 0xe8, eacute: 0xe9, ecircumflex: 0xea,
  edieresis: 0xeb, igrave: 0xec, iacute: 0xed, icircumflex: 0xee, idieresis: 0xef, eth: 0xf0,
  ntilde: 0xf1, ograve: 0xf2, oacute: 0xf3, ocircumflex: 0xf4, otilde: 0xf5, odieresis: 0xf6,
  oslash: 0xf8, ugrave: 0xf9, uacute: 0xfa, ucircumflex: 0xfb, udieresis: 0xfc, yacute: 0xfd,
  thorn: 0xfe, ydieresis: 0xff, dotlessi: 0x131, Lslash: 0x141, lslash: 0x142, OE: 0x152,
  oe: 0x153, Scaron: 0x160, scaron: 0x161, Ydieresis: 0x178, Zcaron: 0x17d, zcaron: 0x17e,
  Cacute: 0x106, cacute: 0x107, Ccaron: 0x10c, ccaron: 0x10d, Dcaron: 0x10e, dcaron: 0x10f,
  Ecaron: 0x11a, ecaron: 0x11b, Racute: 0x154, racute: 0x155, Rcaron: 0x158, rcaron: 0x159,
  Sacute: 0x15a, sacute: 0x15b, Tcaron: 0x164, tcaron: 0x165, Uring: 0x16e, uring: 0x16f,
  Zacute: 0x179, zacute: 0x17a, Zdotaccent: 0x17b, zdotaccent: 0x17c, Aogonek: 0x104,
  aogonek: 0x105, Eogonek: 0x118, eogonek: 0x119, Nacute: 0x143, nacute: 0x144,
  Amacron: 0x100, amacron: 0x101, Emacron: 0x112, emacron: 0x113, Imacron: 0x12a, imacron: 0x12b,
  Umacron: 0x16a, umacron: 0x16b, Gbreve: 0x11e, gbreve: 0x11f, Idotaccent: 0x130,
  Scedilla: 0x15e, scedilla: 0x15f, Abreve: 0x102, abreve: 0x103, Ohungarumlaut: 0x150,
  ohungarumlaut: 0x151, Uhungarumlaut: 0x170, uhungarumlaut: 0x171,
};
Object.assign(NAMES, ACCENTED);

/**
 * Resolve one glyph name. Returns a codepoint, or 0 when we genuinely do not
 * know — a caller must be able to tell "I know it is nothing" from "I know it
 * is U+0000", because the whole point of this module is fixing the latter.
 */
function glyphNameToUnicode(name) {
  if (!name || typeof name !== 'string') return 0;
  let n = name;
  const dot = n.indexOf('.');                       // `a.sc`, `one.oldstyle`
  if (dot > 0) n = n.slice(0, dot);
  if (n.includes('_')) n = n.split('_')[0];         // ligature component names
  if (NAMES[n] !== undefined) return NAMES[n];
  let m = /^uni([0-9A-Fa-f]{4,6})$/.exec(n);
  if (m) return parseInt(m[1].slice(0, 4), 16);
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  if (m) return parseInt(m[1], 16);
  m = /^(?:cid|g|G|glyph|index)(\d+)$/.exec(n);
  if (m) return 0;                                  // a glyph index is not a character
  if (n.length === 1) return n.charCodeAt(0);
  return 0;
}

module.exports = { glyphNameToUnicode, NAMES };
