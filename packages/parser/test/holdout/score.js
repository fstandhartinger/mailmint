'use strict';
const fs=require('fs');
const file=process.argv[2]||require('path').join(__dirname,'results.json');
const R=JSON.parse(fs.readFileSync(file,'utf8'));
const hardLabels=JSON.parse(fs.readFileSync(require('path').join(__dirname,'labels-hard.json'),'utf8'));

function norm(v){
  if(v===null||v===undefined) return null;
  if(typeof v==='object'&&!Array.isArray(v)&&v.amount!==undefined) return v.amount;
  if(typeof v==='string') return v.trim();
  return v;
}
function eq(got,want,name){
  got=norm(got);
  if(want===null) return got===null;
  if(got===null) return false;
  if(typeof want==='number'){ const g=typeof got==='number'?got:parseFloat(String(got).replace(/[^0-9.\-]/g,'')); return Number.isFinite(g)&&Math.abs(g-want)<0.005; }
  if(name==='currency') return String(got).toUpperCase()===String(want).toUpperCase();
  if(name==='vendor'||name==='carrier'){ const a=String(got).toLowerCase().replace(/[^a-z0-9]/g,''),b=String(want).toLowerCase().replace(/[^a-z0-9]/g,''); return a.includes(b)||b.includes(a); }
  if(name==='attachment_filename') return String(got).replace(/\s+/g,' ')===String(want).replace(/\s+/g,' ');
  return String(got).replace(/\s+/g,' ').toLowerCase()===String(want).replace(/\s+/g,' ').toLowerCase();
}

let TP=0, FP=0, FN=0, correctAbstain=0, slots=0;
const buckets={'0.9-1.0':[],'0.7-0.9':[],'0.6-0.7':[],'0.0-0.6':[]};
const bySource={};
const errors=[];
const overconf=[];
let evGiven=0, evVerbatim=0, evMissing=0;
const lat=[]; let llmN=0, llmMs=[];
const lineItemRes=[];

for(const r of R){
  if(r.out.__crash){ errors.push({file:r.file, field:'*', crash:r.out.__crash}); continue; }
  lat.push(r.ms);
  if(r.out.parse.llm_used){ llmN++; llmMs.push(r.out.parse.timings_ms.llm); }
  const hay=[r.out.headers.subject||'', r.out.body.text||'', r.out.body.text_from_html||'', r.out.body.html||'',
    (r.out.tables||[]).map(t=>[t.headers.join(' '),...t.rows.map(x=>x.join(' '))].join(' ')).join(' ')]
    .join(' \n ').replace(/\s+/g,' ').trim().toLowerCase();
  for(const [name,want] of Object.entries(r.labels)){
    if(name==='line_items_count') continue;
    slots++;
    const f=r.out.fields[name];
    const got=f?f.value:null;
    const ok=eq(got,want,name);
    const returned = got!==null && got!==undefined;
    if(want===null){ if(!returned){correctAbstain++;} else {FP++; errors.push({file:r.file,field:name,got,want,conf:f.confidence,source:f.source,evidence:f.evidence});} }
    else if(!returned){ FN++; errors.push({file:r.file,field:name,got:null,want,conf:f?f.confidence:0,source:f?f.source:'none',miss:true}); }
    else if(ok){ TP++; }
    else { FP++; FN++; errors.push({file:r.file,field:name,got,want,conf:f.confidence,source:f.source,evidence:f.evidence}); }

    if(returned&&f){
      const b=f.confidence>=0.9?'0.9-1.0':f.confidence>=0.7?'0.7-0.9':f.confidence>=0.6?'0.6-0.7':'0.0-0.6';
      buckets[b].push(ok?1:0);
      (bySource[f.source]=bySource[f.source]||[]).push({ok, c:f.confidence});
      if(f.confidence>=0.9 && !ok) overconf.push({file:r.file,field:name,got,want,conf:f.confidence,source:f.source,evidence:f.evidence,flags:r.out.flags});
      if(f.evidence!=null&&f.evidence!==''){ evGiven++; const e=String(f.evidence).replace(/\s+/g,' ').trim().toLowerCase(); if(hay.includes(e)) evVerbatim++; else evMissing++; }
    }
  }
  // line items
  const lc = (hardLabels[r.file]||{}).labels ? hardLabels[r.file].labels.line_items_count : undefined;
  if(lc!==undefined){
    const li=r.out.fields.line_items;
    lineItemRes.push({file:r.file, want:lc, got:li&&Array.isArray(li.value)?li.value.length:(li&&li.value?'?':null), conf:li?li.confidence:null, source:li?li.source:null, flags:r.out.flags.filter(x=>/array|table|arith/.test(x))});
  }
}
const returned=TP+FP;
const present=TP+FN;
const P=returned?TP/returned:0, Rc=present?TP/present:0;
const allConf=[];
for(const r of R){ if(r.out.fields) for(const k of Object.keys(r.out.fields)){ const v=r.out.fields[k]; if(v.value!==null) allConf.push(v.confidence);} }
console.log('FILE:',file);
console.log(`slots=${slots} TP=${TP} FP=${FP} FN=${FN} correct_abstentions=${correctAbstain}`);
console.log(`precision=${(P*100).toFixed(1)}%  recall=${(Rc*100).toFixed(1)}%`);
console.log(`mean confidence (non-null)=${(allConf.reduce((a,b)=>a+b,0)/allConf.length).toFixed(3)}`);
lat.sort((a,b)=>a-b);
console.log(`latency mean=${Math.round(lat.reduce((a,b)=>a+b,0)/lat.length)}ms  median=${lat[Math.floor(lat.length/2)]}ms  p95=${lat[Math.floor(lat.length*0.95)]}ms  max=${lat[lat.length-1]}ms`);
console.log(`llm used on ${llmN}/${R.length} messages; mean llm ms=${llmMs.length?Math.round(llmMs.reduce((a,b)=>a+b,0)/llmMs.length):0}`);
console.log('\n-- CALIBRATION --');
for(const [k,v] of Object.entries(buckets)){ if(!v.length){console.log(`${k}  n=0`);continue;} const c=v.reduce((a,b)=>a+b,0); console.log(`${k}  n=${v.length}  correct=${c}  actual=${(100*c/v.length).toFixed(1)}%`); }
console.log('\n-- BY SOURCE --');
for(const [k,v] of Object.entries(bySource)){ const c=v.filter(x=>x.ok).length; console.log(`${k}  n=${v.length}  correct=${(100*c/v.length).toFixed(1)}%  meanconf=${(v.reduce((a,b)=>a+b.c,0)/v.length).toFixed(3)}`); }
console.log('\n-- EVIDENCE --');
console.log(`evidence given on ${evGiven} returned fields; verbatim substring: ${evVerbatim}; NOT a substring: ${evMissing}`);
console.log('\n-- OVERCONFIDENT (conf>=0.9 and WRONG) --');
for(const o of overconf) console.log(JSON.stringify(o));
console.log('\n-- LINE ITEMS --');
for(const l of lineItemRes) console.log(JSON.stringify(l));
console.log('\n-- ALL ERRORS --');
for(const e of errors) console.log(JSON.stringify(e));
