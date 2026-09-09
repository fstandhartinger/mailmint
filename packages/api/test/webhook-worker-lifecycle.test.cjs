'use strict';
// Requires the bounded own Docker/PG runner; no production credentials or network.
const {test}=require('node:test');
const a=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs');
const {spawn}=require('node:child_process');
const db=require('/app/packages/api/src/db');
const hooks=require('/app/packages/api/src/webhooks');
const ep=require('/app/packages/api/src/webhook-endpoints');
const {Pool}=require('/app/node_modules/pg');
const admin=new Pool({connectionString:'postgres://postgres:isolated-fixture-only@127.0.0.1:5432/mailmint_delta_0909'});
const proof={mode:'candidate overlay + exact baseline image, own real PG/HTTP, separate processes',cases:[],receipts:[],workers:[]};
const children=new Set();let account,box,endpoint,server,hold=false,status=200;const held=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(40);}throw Error('poll deadline');}
async function row(id){return(await admin.query('SELECT *,xmin::text AS row_version FROM webhook_deliveries WHERE id=$1',[id])).rows[0];}
async function queue(){return hooks.enqueue({messageId:'msg_owned_accept0909',accountId:account,url:endpoint.url,endpointId:endpoint.id});}
function seen(id){return proof.receipts.filter(r=>r.id===id);}
async function start({legacy=false,disabled=false}={}){
 const path=legacy?'/app/packages/api/src/webhooks-legacy.js':'/app/packages/api/src/webhooks.js';
 const env={...process.env,WEBHOOK_WORKER:disabled?'0':'1'};
 const c=spawn(process.execPath,['-e',`require(${JSON.stringify(path)}).startWorker();setInterval(()=>{},1000);console.log('READY')`],{env,stdio:['ignore','pipe','pipe']});
 children.add(c);const rec={pid:c.pid,legacy,disabled,logs:''};proof.workers.push(rec);
 for(const stream of [c.stdout,c.stderr])stream.on('data',d=>{rec.logs+=String(d)});
 return new Promise((resolve,reject)=>{c.stdout.on('data',d=>{if(String(d).includes('READY'))resolve(c)});c.once('error',reject)});
}
async function stop(c,signal='SIGTERM'){
 if(!c||c.exitCode!==null||c.signalCode!==null)return;
 const p=new Promise(r=>c.once('exit',(code,sig)=>{proof.workers.find(w=>w.pid===c.pid).exit={code,signal:sig};r()}));c.kill(signal);await p;children.delete(c);
}
function release(code=200){for(const res of held.splice(0))if(!res.destroyed){res.writeHead(code);res.end('owned')}}
async function setup(){
 a.ok(process.env.DATABASE_URL.endsWith('/mailmint_delta_0909'));a.equal(process.env.MAILMINT_BILLING,'0');
 await require('/app/packages/api/src/migrate').migrate();
 account=(await db.query("INSERT INTO accounts(email,password_hash) VALUES('owned-accept0909@example.invalid','not-login') RETURNING id")).rows[0].id;
 box=(await db.query("INSERT INTO mailboxes(id,account_id,token,name) VALUES('mb_owned_accept0909',$1,'ownedaccept0909','Owned acceptance') RETURNING *",[account])).rows[0];
 await db.query("INSERT INTO messages(id,mailbox_id,account_id,status,result) VALUES('msg_owned_accept0909',$1,$2,'parsed',$3)",[box.id,account,{fields:{total:{value:31.5,confidence:1}}}]);
 server=http.createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{proof.receipts.push({id:req.headers['x-mailmint-delivery'],time:new Date().toISOString(),hold,status,body:JSON.parse(b)});if(hold){held.push(res);return;}res.writeHead(status);res.end('owned')})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));endpoint=await ep.create(box,{url:'http://127.0.0.1:'+server.address().port+'/owned'});
}
async function clean(){
 await admin.query('ALTER ROLE qa LOGIN').catch(()=>{});for(const c of [...children])await stop(c);release();
 if(account)await admin.query('DELETE FROM accounts WHERE id=$1 AND email=$2',[account,'owned-accept0909@example.invalid']);
 proof.cleanup={};for(const t of ['accounts','mailboxes','messages','webhook_endpoints','webhook_deliveries','mailbox_schema_versions']){proof.cleanup[t]=(await admin.query('SELECT count(*)::int n FROM '+t)).rows[0].n;a.equal(proof.cleanup[t],0)}
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await db.pool.end();await admin.end();proof.finished=new Date().toISOString();fs.writeFileSync('/proof/acceptance-result.json',JSON.stringify(proof,null,2));
}
test('worker ownership, crash and staged rollout acceptance',async t=>{
 try{await setup();
  for(const staleStatus of [200,404,503])await t.test('superseded '+staleStatus+' ACK cannot overwrite current outcome',async()=>{
   hold=true;status=200;const id=await queue();const old=await hooks.claim();a.equal(old.id,id);const first=hooks.attemptOnce(old);await until(()=>seen(id).length===1);
   // Exact isolated-row supersession models recovery while an earlier HTTP response is held.
   await admin.query('UPDATE webhook_deliveries SET next_attempt_at=now(),locked_at=NULL WHERE id=$1',[id]);
   const next=await hooks.claim();a.equal(next.id,id);hold=false;status=staleStatus===200?503:200;await hooks.attemptOnce(next);const before=await row(id);
   release(staleStatus);await first;const after=await row(id);
   proof.cases.push({name:'stale '+staleStatus+' ACK fenced',id,before,after,actualRequests:seen(id).length,isolatedTimeAdvance:true});
   await admin.query('DELETE FROM webhook_deliveries WHERE id=$1',[id]);status=200;
   a.deepEqual(after,before,'stale ACK changed a newer persisted outcome');
  });
  if(process.env.QA_STALE_ONLY==='1') return;
  await t.test('reusing the same claimed object cannot start a concurrent attempt',async()=>{
   hold=true;const id=await queue();const claimed=await hooks.claim();const first=hooks.attemptOnce(claimed);await until(()=>seen(id).length===1);await hooks.attemptOnce(claimed);a.equal(seen(id).length,1);release(200);hold=false;await first;proof.cases.push({name:'same claim object cannot be reused',id});
  });
  await t.test('superseded pre-send owner sends nothing',async()=>{
   const id=await queue();const old=await hooks.claim();await admin.query('UPDATE webhook_deliveries SET next_attempt_at=now() WHERE id=$1',[id]);const next=await hooks.claim();await hooks.attemptOnce(old);a.equal(seen(id).length,0);await hooks.attemptOnce(next);a.equal(seen(id).length,1);a.ok((await row(id)).delivered_at);proof.cases.push({name:'pre-send supersession',id});
  });
  await t.test('SIGKILL in-flight recovers after real unmodified default lease with stable ID',async()=>{
   hold=true;const id=await queue();const c=await start();await until(()=>seen(id).length===1);const before=await row(id);const leaseSeconds=(new Date(before.next_attempt_at)-new Date(before.locked_at))/1000;a.equal(leaseSeconds,40);
   await stop(c,'SIGKILL');server.closeAllConnections();held.splice(0);hold=false;const replacement=await start();await delay(800);a.equal(seen(id).length,1,'lease replayed early');await until(async()=>(await row(id)).delivered_at,50000);await stop(replacement);a.equal(seen(id).length,2);a.ok(new Date(seen(id)[1].time)>=new Date(before.next_attempt_at));proof.cases.push({name:'real SIGKILL/default40s lease',id,before,after:await row(id),actualRequests:seen(id)});
  });
  await t.test('DB failure after HTTP receipt preserves retryable state; old ACK cannot reconnect unfenced',async()=>{
   hold=true;const id=await queue();const claimed=await hooks.claim();const attempted=hooks.attemptOnce(claimed).then(()=>({ok:true}),e=>({error:e.message}));await until(()=>seen(id).length===1);
   await admin.query('ALTER ROLE qa NOLOGIN');await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='qa'");release(200);const outcome=await attempted;a.ok(outcome.error);const before=await row(id);a.equal(before.attempt,0);a.equal(before.delivered_at,null);
   await admin.query('ALTER ROLE qa LOGIN');hold=false;const c=await start();await until(async()=>(await row(id)).delivered_at,50000);await stop(c);a.equal(seen(id).length,2);a.equal((await row(id)).attempt,1);proof.cases.push({name:'HTTP ACK then real DB connection failure',id,error:outcome.error,before,after:await row(id)});
  });
  await t.test('real 30-second retry survives worker replacement',async()=>{
   status=503;const id=await queue();const c=await start();await until(async()=>(await row(id)).attempt===1);await stop(c);const before=await row(id);status=200;const fresh=await start();await delay(700);a.equal(seen(id).length,1);await until(async()=>(await row(id)).delivered_at,40000);await stop(fresh);a.equal((await row(id)).attempt,2);a.ok(new Date(seen(id)[1].time)>=new Date(before.next_attempt_at));proof.cases.push({name:'unchanged actual30s retry',id,before,after:await row(id)});
  });
  await t.test('legacy worker starting after new lease respects persisted due deadline',async()=>{
   hold=true;const id=await queue();const fresh=await start();await until(()=>seen(id).length===1);const old=await start({legacy:true});await delay(1000);a.equal(seen(id).length,1);release(200);hold=false;await until(async()=>(await row(id)).delivered_at);await stop(old);await stop(fresh);proof.cases.push({name:'new lease first, legacy contender skips',id});
  });
  await t.test('staged disabled candidate coexists with old, preserves queue, activates after old exit',async()=>{
   hold=true;const id=await queue();const old=await start({legacy:true});await until(()=>seen(id).length===1);const disabled=await start({disabled:true});await delay(800);a.equal(seen(id).length,1);release(200);hold=false;await until(async()=>(await row(id)).delivered_at);await stop(old);
   const queued=await queue();await delay(800);a.equal(seen(queued).length,0);a.equal((await row(queued)).attempt,0);await stop(disabled);const fresh=await start();await until(async()=>(await row(queued)).delivered_at);await stop(fresh);a.equal(seen(queued).length,1);proof.cases.push({name:'safe disabled->native old exit->enabled sequence',oldDelivery:id,preservedQueue:queued});
  });
  await t.test('known gate: old owner first plus active new is incompatible, prohibit direct rolling activation',async()=>{
   hold=true;const id=await queue();const old=await start({legacy:true});await until(()=>seen(id).length===1);const fresh=await start();await until(()=>seen(id).length===2);a.equal(seen(id).length,2);release(200);hold=false;await until(async()=>(await row(id)).delivered_at);await stop(old);await stop(fresh);proof.cases.push({name:'DIRECT ACTIVE ROLLING IS UNSAFE; staged retirement REQUIRED',id,actualRequests:seen(id)});
  });
  await t.test('unsubscribe during held attempt cannot resurrect deleted delivery or touch sibling',async()=>{
   hold=true;const id=await queue();const c=await start();await until(()=>seen(id).length===1);const sibling=await ep.create(box,{url:endpoint.url+'/sibling'});await ep.remove(account,endpoint.id);a.equal(await row(id),undefined);release(200);hold=false;await delay(400);await stop(c);a.equal(await row(id),undefined);a.equal((await ep.get(account,sibling.id)).consecutive_failures,0);proof.cases.push({name:'inflight unsubscribe deletion retained',id,sibling:sibling.id});endpoint=sibling;
  });
  await t.test('completed rows not replayed after process restart',async()=>{
   const n=proof.receipts.length;const c=await start();await delay(700);await stop(c);a.equal(proof.receipts.length,n);proof.cases.push({name:'completed rows not replayed'});
  });
 }finally{await clean()}
});
