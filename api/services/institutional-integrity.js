'use strict';
// Calls agent #12 without its legacy database side effects. The caller owns the
// record lock and transaction, including screening persistence and audit evidence.
const fs=require('node:fs');
const policy=require('./institutional-policy');
const agent=require('../../agents/instrument-integrity');
const enginePath=require.resolve('../../agents/instrument-integrity');
const typologyPath=require.resolve('../../agents/instrument-integrity/typologies/financial-instruments.json');
// Loaded engine and disk typology must match the release fingerprint; restart on deploy.
const loadedEngine=fs.readFileSync(enginePath,'utf8');
function fingerprint(){if(fs.readFileSync(enginePath,'utf8')!==loadedEngine)throw Error('Integrity engine changed; restart required');return policy.digest({adapter:fs.readFileSync(__filename,'utf8'),engine:loadedEngine,typology:fs.readFileSync(typologyPath,'utf8')});}
function context(row){
 const p=row.payload,d=p.details||{},i=p.integrity_input||{};
 const c={description:policy.canonical(p),instrument_type:p.instrument_type};
 for(const key of ['isin','cusip','swift_mt_type','swift_raw_message']){
  const values=[i[key],p[key],d[key]].filter(v=>v!==undefined&&v!==null);
  if(values.some(v=>typeof v!=='string'||!v.trim()||v.length>100000)||new Set(values).size>1)throw Error('Invalid or conflicting integrity input: '+key);
  if(values.length)c[key]=values[0];
 }
 // Existing securities package uses a generic identifier: recognize common lengths.
 if(typeof d.identifier==='string'){
  const value=d.identifier.trim();
  const key=value.length===12?'isin':value.length===9?'cusip':null;
  if(key){if(c[key]&&c[key]!==value)throw Error('Conflicting securities identifier');c[key]=value;}
 }
 return c;
}
async function screen(c,row,user){
 const existing=await c.query('SELECT * FROM institutional.integrity_screenings WHERE asset_id=$1 AND revision=$2',[row.asset_id,row.revision]);
 if(existing.rows.length)return existing.rows[0];
 const before=fingerprint();const input=context(row);
 const result=await agent.execute(input); // no db/client credentials are passed to the legacy agent
 if(before!==fingerprint())throw Error('Integrity engine changed during screening');
 if(!['blocked','pending_human_verification'].includes(result?.status))throw Error('Invalid integrity agent response');
 // Missing/unsupported SWIFT syntax is not an automated clearance.
 if((input.swift_mt_type||input.swift_raw_message)&&result.structural_validation?.swift?.checked!==true){
  result.status='blocked';result.action='HARD_BLOCK';result.instrument_integrity_status='blocked';
  result.message='SWIFT screening is incomplete or unsupported; correct the record through independent review';
 }
 result.scope='Financial-instrument typologies and supplied identifier/field checks only. No registry authentication, full SWIFT grammar, or nonfinancial fraud coverage. Independent counterparty verification remains required.';
 const r=await c.query('INSERT INTO institutional.integrity_screenings(asset_id,revision,record_hash,engine_hash,result,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[row.asset_id,row.revision,policy.digest(row.payload),before,result,user.sub]);
 await require('./institutional-store').event(c,row,user,'instrument_integrity_screened',{screening_id:r.rows[0].id,revision:row.revision,record_hash:r.rows[0].record_hash,engine_hash:before,status:result.status});
 return r.rows[0];
}
async function current(c,row){return (await c.query('SELECT * FROM institutional.integrity_screenings WHERE asset_id=$1 AND revision=$2',[row.asset_id,row.revision])).rows[0]||null;}
function screeningBlockers(row,s){
 if(!s)return ['Instrument integrity screening missing'];
 if(s.record_hash!==policy.digest(row.payload)||s.engine_hash!==fingerprint())return ['Instrument integrity screening stale; independently approve a new record revision and rescreen'];
 if(s.result.status!=='pending_human_verification')return ['Instrument integrity hard block; independent approval cannot override it'];
 return [];
}
async function gate(c,row){
 const s=await current(c,row);const blockers=screeningBlockers(row,s);
 if(!blockers.length){
  const r=(await c.query("SELECT r.* FROM institutional.reviews r JOIN institutional.documents d ON d.id=r.evidence_document_id AND d.asset_id=r.asset_id WHERE r.asset_id=$1 AND r.revision=$2 AND r.check_name='instrument_integrity'",[row.asset_id,row.revision])).rows[0];
  if(!r||r.integrity_attestation?.screening_id!==s.id||!policy.validReview(r,row.revision,Date.now()))blockers.push('Instrument integrity requires current independent-channel evidence and a separate compliance/legal approval');
 }
 return {allowed:!blockers.length,blockers,screening_id:s?.id||null,status:s?.result.status||'missing'};
}
module.exports={screen,current,gate,screeningBlockers,context,fingerprint};
