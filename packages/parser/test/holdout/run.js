'use strict';
const fs=require('fs'), path=require('path');
const { parseMessage } = require('../../src/index.js');
const { pick } = require('./schemas.js');
const CORPUS=require('path').join(__dirname,'corpus');
const hardLabels=JSON.parse(fs.readFileSync(path.join(__dirname,'labels-hard.json'),'utf8'));

// per-file schema: exactly the labelled fields, plus line_items where a count is labelled
const EXTRA={
 'ho-hard-01-sum-mismatch.eml':['line_items'],
 'ho-hard-06-credit-note.eml':['line_items'],
 'ho-hard-07-discount-preheader.eml':['line_items'],
 'ho-hard-08-items-across-quote.eml':['line_items'],
 'ho-hard-09-gb18030.eml':['line_items'],
 'ho-hard-12-preheader-total.eml':['line_items'],
 'ho-hard-13-stripe-shape.eml':['line_items'],
 'ho-hard-16-fr-base64-latin1.eml':['line_items'],
 'ho-hard-17-40-rows-text.eml':['line_items'],
 'ho-hard-18-footer-decoys.eml':['line_items'],
};
const REAL_SCHEMA=['invoice_number','total','due_date','currency'];

function schemaFor(file, labels){
  if(file.startsWith('ho-real-')) return pick(...REAL_SCHEMA);
  const names=Object.keys(labels).filter(k=>k!=='line_items_count'&&k!=='attachment_filename');
  const extra=(EXTRA[file]||[]);
  return pick(...names, ...extra, ...(labels.attachment_filename!==undefined?['attachment_filename']:[]));
}

const jobs=[];
for(const f of fs.readdirSync(CORPUS).sort()){
  if(!f.endsWith('.eml')) continue;
  let labels;
  if(f.startsWith('ho-real-')) labels={invoice_number:null,total:null,due_date:null,currency:null};
  else labels=hardLabels[f].labels;
  jobs.push({file:f, labels, schema:schemaFor(f,labels)});
}

(async()=>{
  const results=[];
  const useLlm = process.argv.includes('--no-llm') ? false : true;
  for(const j of jobs){
    const raw=fs.readFileSync(path.join(CORPUS,j.file));
    const t0=Date.now();
    let out;
    try{ out=await parseMessage(raw,{schema:j.schema, requestId:'ho_'+j.file, llm:useLlm}); }
    catch(e){ out={__crash:e.message, __stack:(e.stack||'').split('\n').slice(0,5)}; }
    results.push({file:j.file, labels:j.labels, ms:Date.now()-t0, out});
    process.stderr.write(`${j.file} ${Date.now()-t0}ms\n`);
  }
  fs.writeFileSync(process.argv.includes('--no-llm')?path.join(__dirname,'results-norules.json'):path.join(__dirname,'results.json'), JSON.stringify(results,null,1));
})();
