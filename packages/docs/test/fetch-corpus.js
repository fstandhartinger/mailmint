'use strict';
/**
 * Fetch the public benchmark corpus into `.local/corpus` (gitignored).
 *
 *   node test/fetch-corpus.js            # fetch what is missing
 *   node test/fetch-corpus.js --force    # re-fetch everything
 *
 * The documents are NOT committed: they are third-party files, some are tens of
 * megabytes, and a corpus that can be re-fetched from its source URL is more
 * honest than one frozen in a repository where nobody can check what it is.
 * Every entry below records where it came from and what it is there to test.
 *
 * Hand labels live next to the entry. They were written by reading the actual
 * document, not by copying our own output — a label derived from the thing
 * under test measures nothing.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { CORPUS } = require('./corpus');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DOCUMENTS = [
  {
    file: 'us-hillsdale-council-packet.pdf',
    url: 'https://www.cityofhillsdale.org/sites/default/files/fileattachments/mayor_and_city_council/meeting/packets/14762/packet.pdf',
    group: 'gov-invoice-register',
    note: 'City of Hillsdale MI council packet, 2025-08-14. Pages 3-14 are an accounts-payable '
      + 'invoice register: GL number, vendor, description, paid amount, check number, with per-department '
      + 'subtotals and per-fund totals. 158 pages; exercises the page cap.',
    labels: {
      page: 3,
      note: 'Hand-labelled from the printed page: four invoice lines from Fund 101.',
      rows: [
        ['101-000.000-231.105', 'DUE TO MMERS-RETIREMENT CONT.', 'MERS', 'RETIREMENT - JULY 2025', '22,916.72', '1209'],
        ['101-172.000-716.000', 'RETIREMENT', 'MERS', 'RETIREMENT - JULY 2025', '2,323.90', '1209'],
        ['101-175.000-802.000', 'SONIT NET ADMIN JULY 25', 'SONIT SYSTEMS, LLC', 'SONIT NET ADMIN JULY 25', '300.00', '111323'],
        ['101-175.000-806.000', 'LEGAL SERVICES', 'LOVINGER & THOMPSON, PC', 'LEGAL FEES', '1,132.50', '111294'],
      ],
    },
  },
  {
    file: 'us-hoodriver-council-packet.pdf',
    url: 'https://cityofhoodriver.gov/wp-content/uploads/Meetings/04-13-2026-City-Council-Packet-1.pdf',
    group: 'gov-acroform',
    note: 'City of Hood River OR council packet containing a COMPLETED OLCC liquor licence '
      + 'application: 31 AcroForm fields, 25 of them filled. The filled-form case.',
    labels: {
      fields: {
        'Premises Address': '107 Oak St',
        City: 'Hood River',
        County: 'OR',
        'Zip Code': '97031',
      },
      page: 47,
      note: 'Structural permit fee schedule, three fiscal-year columns.',
      rows: [
        ['Up to $500', '$71.25', '$85.50', '$89.78'],
        ['+ $/100 up to 2,000', '$3.13', '$3.76', '$3.95'],
        ['+ $/1000 up to 25,000', '$15.41', '$18.49', '$19.41'],
        ['+ $/1000 up to 50,000', '$11.40', '$13.68', '$14.36'],
      ],
    },
  },
  {
    file: 'edu-colorado-afr-2024.pdf',
    url: 'https://www.cu.edu/doc/fy2024cuafrpdf',
    group: 'edu-statement',
    note: 'University of Colorado FY2024 Annual Financial Report. Page 18 "Operating and '
      + 'Nonoperating Revenues" is a four-column table with two subtotal rows and a grand total.',
    labels: {
      page: 18,
      note: 'Figure 4, hand-labelled from the printed page. Amounts in thousands.',
      rows: [
        ['Student tuition and fees, net', '1,295,066', '1,224,562', '1,135,953'],
        ['Fee-for-service contracts', '212,975', '193,930', '176,265'],
        ['Grants and contracts', '1,469,490', '1,334,081', '1,236,401'],
        ['Sales and services of educational departments', '298,512', '285,454', '273,866'],
        ['Auxiliary enterprises, net', '371,328', '317,627', '277,453'],
        ['Health services', '1,632,326', '1,504,889', '1,392,075'],
        ['Other operating', '170,160', '151,734', '166,853'],
        ['Total Operating Revenues', '5,449,857', '5,012,277', '4,658,866'],
        ['Federal Pell Grant', '61,581', '56,390', '54,032'],
        ['State appropriations', '25,029', '16,113', '23,476'],
        ['State support for PERA pension', '1,541', '19,751', '7,603'],
        ['Gifts', '273,675', '241,894', '243,195'],
        ['Investment income (loss)', '404,215', '288,579', '(397,382)'],
        ['Other nonoperating, net', '32,355', '30,204', '(16,365)'],
        ['Total Nonoperating Revenues', '798,396', '658,532', '41,008'],
        ['Total Noncapital Revenues', '6,248,253', '5,670,809', '4,699,874'],
      ],
    },
  },
  {
    file: 'edu-alabama-afr-2024.pdf',
    url: 'https://afr.ua.edu/wp-content/uploads/2025/02/UA-AFR-FY24.pdf',
    group: 'edu-statement',
    note: 'University of Alabama FY2024 AFR. Page 8 condensed statements of net position: '
      + 'three numeric columns, several "Total ..." rows.',
    labels: {
      page: 8,
      note: 'Condensed Statements of Net Position, hand-labelled from the printed page.',
      rows: [
        ['Current assets', '962,454,665', '883,372,278', '866,432,195'],
        ['Capital assets, net', '2,917,944,457', '2,748,890,107', '2,578,423,035'],
        ['Other noncurrent assets', '2,466,267,518', '2,116,351,607', '1,779,807,553'],
        ['Total assets', '6,346,666,640', '5,748,613,992', '5,224,662,783'],
        ['Deferred outflows of resources', '437,529,679', '444,311,087', '344,140,710'],
        ['Current liabilities', '640,232,682', '601,771,356', '562,727,334'],
        ['Noncurrent liabilities', '2,260,685,098', '2,028,561,206', '1,903,816,313'],
        ['Total liabilities', '2,900,917,780', '2,630,332,562', '2,466,543,647'],
        ['Deferred inflows of resources', '318,795,583', '330,284,306', '377,201,632'],
        ['Net investment in capital assets', '1,852,845,703', '1,655,747,911', '1,460,484,243'],
      ],
    },
  },
  {
    file: 'edu-california-afr-2025.pdf',
    url: 'https://regents.universityofcalifornia.edu/regmeet/nov25/f3attach1.pdf',
    group: 'edu-statement',
    note: 'University of California Annual Financial Report 2024-25. Statements of Revenues, '
      + 'Expenses and Changes in Net Position: four numeric columns, many blank cells.',
  },
  {
    file: 'scan-cia-2page.pdf',
    url: 'https://archive.org/download/cia-readingroom-document-cia-rdp84-00499r000700130027-7/cia-rdp84-00499r000700130027-7.pdf',
    group: 'scanned',
    scanned: true,
    note: 'Declassified CIA CREST document, image-only. pdftotext yields one form feed per page '
      + 'and nothing else. This is the OCR path.',
  },
  {
    file: 'scan-cia-29page.pdf',
    url: 'https://archive.org/download/cia-readingroom-document-cia-rdp96-00788r001700210016-5/cia-rdp96-00788r001700210016-5.pdf',
    group: 'scanned',
    scanned: true,
    note: 'A 29-page typewritten scan, image-only. Exercises the OCR page cap.',
  },
  {
    file: 'de-ustg.pdf',
    url: 'https://www.gesetze-im-internet.de/ustg_1980/UStG.pdf',
    group: 'non-ascii',
    note: 'German VAT Act, published by the Bundesamt fuer Justiz. 98 pages, ~14k non-ASCII bytes: '
      + 'umlauts, sharp s, section signs. The mojibake test on a real document.',
  },
  {
    file: 'eu-greek-st9770.pdf',
    url: 'https://data.consilium.europa.eu/doc/document/ST-9770-2020-INIT/el/pdf',
    group: 'non-ascii',
    note: 'Council of the EU document ST 9770/2020, Greek. Non-Latin script, digitally signed.',
  },
  {
    file: 'eu-bulgarian-st9770.pdf',
    url: 'https://data.consilium.europa.eu/doc/document/ST-9770-2020-INIT/bg/pdf',
    group: 'non-ascii',
    note: 'The same Council document in Bulgarian: Cyrillic, and a translation pair with the Greek one.',
  },
  {
    file: 'us-irs-w9.pdf',
    url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    group: 'gov-acroform',
    note: 'IRS Form W-9, blank. The control for the filled-form case: an AcroForm whose fields '
      + 'have no values must yield no fields, not 60 empty ones.',
  },
  {
    file: 'us-patent-2000000.pdf',
    url: 'https://patentimages.storage.googleapis.com/pdfs/US2000000.pdf',
    group: 'scanned',
    note: 'A page-image PDF that DOES carry an OCR text layer. The control for the scan detector: '
      + 'it must not pay for a model call here.',
  },
];

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': UA, accept: 'application/pdf,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`http ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function main() {
  const force = process.argv.includes('--force');
  fs.mkdirSync(CORPUS, { recursive: true });
  const manifest = { fetched_at: new Date().toISOString(), documents: [] };
  for (const doc of DOCUMENTS) {
    const dest = path.join(CORPUS, doc.file);
    let buf = null;
    if (!force && fs.existsSync(dest)) {
      buf = fs.readFileSync(dest);
      process.stdout.write(`have  ${doc.file} (${buf.length} bytes)\n`);
    } else {
      try {
        buf = await get(doc.url);
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
        fs.writeFileSync(dest, buf);
        process.stdout.write(`fetch ${doc.file} (${buf.length} bytes)\n`);
      } catch (e) {
        process.stdout.write(`FAIL  ${doc.file}: ${e.message}\n`);
        continue;
      }
    }
    manifest.documents.push({ ...doc, bytes: buf.length });
  }
  fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write(`\n${manifest.documents.length}/${DOCUMENTS.length} documents in ${CORPUS}\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
