'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const agent=require('../../agents/instrument-integrity'),integrity=require('../../api/services/institutional-integrity'),policy=require('../../api/services/institutional-policy');
test('agent 12 validates known identifiers and never auto-verifies',async()=>{
 assert.equal(agent.validateISIN('US0378331005').valid,true);assert.equal(agent.validateISIN('US0378331006').valid,false);
 assert.equal(agent.validateCUSIP('037833100').valid,true);assert.equal(agent.validateCUSIP('037833101').valid,false);
 const result=await agent.execute({description:'ordinary property sale'});assert.equal(result.status,'pending_human_verification');
 assert.equal((await agent.execute({isin:'US0378331006'})).status,'blocked');
});
test('all submitted facts are screened and conflicting identifier aliases fail closed',()=>{
 const row={payload:{details:{identifier:'US0378331006',description:'test'},instrument_type:'bond'}};
 assert.equal(integrity.context(row).isin,'US0378331006');assert.match(integrity.context(row).description,/test/);
 assert.throws(()=>integrity.context({payload:{details:{isin:'US0378331005'},integrity_input:{isin:'US0378331006'}}}),/conflicting/);
});
test('missing, changed facts, changed engine and hard blocks remain stopped',()=>{
 const row={payload:{description:'current'}};const s={record_hash:policy.digest(row.payload),engine_hash:integrity.fingerprint(),result:{status:'pending_human_verification'}};
 assert.equal(integrity.screeningBlockers(row,s).length,0);
 for(const candidate of [null,{...s,record_hash:'old'},{...s,engine_hash:'old'},{...s,result:{status:'blocked'}}])assert.ok(integrity.screeningBlockers(row,candidate).length);
});

test('unknown or incomplete SWIFT cannot be cleared by automated screening',async()=>{
 const store=require('../../api/services/institutional-store'),original=store.event;store.event=async()=>{};
 try{for(const integrity_input of [{swift_mt_type:'MT760'},{swift_mt_type:'MT999',swift_raw_message:':20:reference'},{swift_raw_message:':20:reference'}]){
  let result;const c={query:async(q,v)=>{if(q.startsWith('SELECT'))return {rows:[]};result=v[4];return {rows:[{id:'test',record_hash:v[2]}]};}};
  await integrity.screen(c,{asset_id:'test',revision:1,payload:{instrument_type:'bank instrument',integrity_input}},{sub:'maker'});
  assert.equal(result.status,'blocked');
 }}finally{store.event=original;}
});
test('expired or differently bound independent approval cannot clear the gate',async()=>{
 const row={asset_id:'test',revision:1,payload:{description:'current'}};
 const screening={id:'current-screen',record_hash:policy.digest(row.payload),engine_hash:integrity.fingerprint(),result:{status:'pending_human_verification'}};
 const valid={revision:1,outcome:'approved',evidence_document_id:'doc',proposed_by:'maker',approved_by:'checker',reviewed_at:new Date(Date.now()-1000),expires_at:new Date(Date.now()+60000),integrity_attestation:{screening_id:screening.id}};
 for(const review of [null,{...valid,expires_at:new Date(0)},{...valid,integrity_attestation:{screening_id:'other'}}]){
  const c={query:async q=>({rows:q.includes('integrity_screenings')?[screening]:review?[review]:[]})};assert.equal((await integrity.gate(c,row)).allowed,false);
 }
 const c={query:async q=>({rows:q.includes('integrity_screenings')?[screening]:[valid]})};assert.equal((await integrity.gate(c,row)).allowed,true);
});
