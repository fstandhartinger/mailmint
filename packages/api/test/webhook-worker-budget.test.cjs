'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs');
const db=require('/app/packages/api/src/db'),hooks=require('/app/packages/api/src/webhooks'),ep=require('/app/packages/api/src/webhook-endpoints');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('database preparation cannot consume the HTTP lease budget',async()=>{
 let id,server,held,lock,attempt;const proof={};
 try{
  a.ok(process.env.DATABASE_URL.endsWith('/mailmint_delta_0909'));await require('/app/packages/api/src/migrate').migrate();
  id=(await db.query("INSERT INTO accounts(email,password_hash) VALUES('owned-budget0909@example.invalid','not-login') RETURNING id")).rows[0].id;
  const box=(await db.query("INSERT INTO mailboxes(id,account_id,token,name) VALUES('mb_budget0909',$1,'budget0909','Owned') RETURNING *",[id])).rows[0];
  await db.query("INSERT INTO messages(id,mailbox_id,account_id,status,result) VALUES('msg_budget0909',$1,$2,'parsed',$3)",[box.id,id,{fields:{}}]);
  server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{held=res})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const e=await ep.create(box,{url:'http://127.0.0.1:'+server.address().port+'/owned'});
  const dlv=await hooks.enqueue({messageId:'msg_budget0909',accountId:id,url:e.url,endpointId:e.id});const claimed=await hooks.claim();
  lock=await db.pool.connect();await lock.query('BEGIN');await lock.query('LOCK TABLE messages IN ACCESS EXCLUSIVE MODE');attempt=hooks.attemptOnce(claimed);await wait(1400);await lock.query('COMMIT');lock.release();lock=null;
  for(let i=0;i<100&&!held;i++)await wait(20);a.ok(held);
  const r=(await db.query("SELECT EXTRACT(EPOCH FROM (next_attempt_at-now()))*1000 remaining FROM webhook_deliveries WHERE id=$1",[dlv])).rows[0];proof.remainingAtHttpStart=Number(r.remaining);proof.expectedAtLeast=39000;held.end('ok');await attempt;attempt=null;a.ok(proof.remainingAtHttpStart>=39000,'DB preparation used up transport lease budget: '+proof.remainingAtHttpStart);
 }finally{
  if(lock){await lock.query('ROLLBACK');lock.release()}if(held&&!held.writableEnded)held.end('cleanup');if(attempt)await attempt.catch(()=>{});if(id)await db.query('DELETE FROM accounts WHERE id=$1 AND email=$2',[id,'owned-budget0909@example.invalid']);proof.remainingAccounts=(await db.query('SELECT count(*)::int n FROM accounts')).rows[0].n;a.equal(proof.remainingAccounts,0);if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await db.pool.end();fs.writeFileSync('/proof/budget-result.json',JSON.stringify(proof,null,2));
 }
});
