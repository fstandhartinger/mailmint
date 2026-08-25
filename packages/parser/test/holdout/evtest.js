const { parseMessage } = require('/home/flori/Dev/pdfnode/mailmint/packages/parser/src/index.js');
const fs=require('fs');
const raw=fs.readFileSync('/tmp/holdout/corpus/ho-hard-19-abstain.eml');
// stub LLM that fabricates a value AND fabricates the evidence span
function makeComplete(payload){
  return async ()=>({ ok:true, text: JSON.stringify(payload), model:'stub/liar' });
}
(async()=>{
 const schema=[{name:'invoice_number',type:'string'},{name:'total',type:'number'}];
 // case A: fabricated evidence (not in the message at all)
 let out=await parseMessage(raw,{schema, llm:true, complete:makeComplete({
   invoice_number:{value:'INV-99999',confidence:0.99,evidence:'Invoice INV-99999 total due immediately'},
   total:{value:12345.67,confidence:0.99,evidence:'Grand Total: $12,345.67'}})});
 console.log('A fabricated evidence ->', JSON.stringify(out.fields), '\n  flags:',JSON.stringify(out.flags),'needs_review',out.needs_review);
 // case B: NO evidence at all
 out=await parseMessage(raw,{schema, llm:true, complete:makeComplete({
   invoice_number:{value:'INV-99999',confidence:0.99,evidence:null},
   total:{value:12345.67,confidence:0.99,evidence:''}})});
 console.log('B no evidence ->', JSON.stringify(out.fields),'\n  flags:',JSON.stringify(out.flags));
 // case C: evidence is a REAL substring but the VALUE is invented
 out=await parseMessage(raw,{schema, llm:true, complete:makeComplete({
   invoice_number:{value:'INV-99999',confidence:0.99,evidence:'My extension is 4471.'},
   total:{value:12345.67,confidence:0.99,evidence:'Room 204 seats 12.'}})});
 console.log('C real evidence, invented value ->', JSON.stringify(out.fields),'\n  flags:',JSON.stringify(out.flags));
 // case D: 2-char evidence (short-circuit)
 out=await parseMessage(raw,{schema, llm:true, complete:makeComplete({
   invoice_number:{value:'INV-99999',confidence:0.99,evidence:'XZ'},
   total:{value:12345.67,confidence:0.99,evidence:'!!'}})});
 console.log('D 2-char evidence ->', JSON.stringify(out.fields),'\n  flags:',JSON.stringify(out.flags));
 // case E: evidence spanning the subject/body join (never contiguous in reality)
 out=await parseMessage(raw,{schema, llm:true, complete:makeComplete({
   invoice_number:{value:'INV-99999',confidence:0.99,evidence:'Re: notes from Thursday Hi - following up'},
   total:{value:12345.67,confidence:0.99,evidence:'Re: notes from Thursday Hi'}})});
 console.log('E cross-boundary evidence ->', JSON.stringify(out.fields),'\n  flags:',JSON.stringify(out.flags));
})();
