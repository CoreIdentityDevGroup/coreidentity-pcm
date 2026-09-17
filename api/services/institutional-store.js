'use strict';
const db=require('./db');
const policy=require('./institutional-policy');
function fault(status,message) {return Object.assign(new Error(message),{status});}
async function transaction(fn) {
 const c=await db.assets.connect();
 try {await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result;}
 catch(e){await c.query('ROLLBACK').catch(()=>{}); throw e;} finally{c.release();}
}
async function membership(c,user,tenant,roles) {
 await c.query("SELECT set_config('institutional.subject',$1,true)",[user?.sub||'']);
 if(!user?.sub || !Array.isArray(user.amr) || !user.amr.includes('mfa') || !Number.isFinite(user.auth_time) || Date.now()/1000-user.auth_time>3600 || user.auth_time>Date.now()/1000+30) throw fault(403,'Recent verified MFA required');
 const {rows}=await c.query('SELECT role FROM institutional.memberships WHERE subject=$1 AND tenant_id=$2 AND active=true',[user.sub,tenant]);
 if(!rows.length || (roles&&!roles.includes(rows[0].role))) throw fault(403,'Tenant role not authorized');
 return rows[0].role;
}
async function record(c,id,user,roles) {
 await c.query("SELECT set_config('institutional.subject',$1,true)",[user?.sub||'']);
 const {rows}=await c.query('SELECT * FROM institutional.records WHERE asset_id=$1 FOR UPDATE',[id]);
 if(!rows.length) throw fault(404,'Transaction not found');
 const role=await membership(c,user,rows[0].tenant_id,roles);
 if(['client','intermediary','verifier'].includes(role)) {
  const grant=await c.query('SELECT 1 FROM institutional.transaction_access WHERE asset_id=$1 AND subject=$2 AND active=true',[id,user.sub]);
  if(!grant.rows.length)throw fault(403,'Transaction access not granted');
 }
 return rows[0];
}
async function event(c,row,user,action,payload) {
 // Global writer lock serializes chain head, including first event.
 await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[row.tenant_id]);
 const last=await c.query('SELECT event_hash FROM institutional.events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 1',[row.tenant_id]);
 const previous=last.rows[0]?.event_hash||'0'.repeat(64);
 payload={...payload,occurred_at:new Date().toISOString()};
 const envelope={tenant_id:row.tenant_id,asset_id:row.asset_id||null,actor:user.sub,action,payload,previous_hash:previous};
 await c.query('INSERT INTO institutional.events(tenant_id,asset_id,actor,action,payload,previous_hash,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[envelope.tenant_id,envelope.asset_id,envelope.actor,action,payload,previous,policy.digest(envelope)]);
}
async function admission(c,row) {
 const integrity=await require('./institutional-integrity').gate(c,row);
 if(!integrity.allowed)return integrity;
 const pending=await c.query("SELECT 1 FROM institutional.change_proposals WHERE asset_id=$1 AND outcome='pending'",[row.asset_id]);
 if(pending.rows.length)return {allowed:false,blockers:['Sensitive changes require independent approval before processing continues']};
 const spec=await c.query('SELECT specification FROM institutional.schemas WHERE family=$1 AND version=$2 AND active=true',[row.asset_family,row.schema_version]);
 if(!spec.rows.length) return {allowed:false,blockers:['Asset schema is not activated']};
 const reviews=await c.query("SELECT r.* FROM institutional.reviews r JOIN institutional.documents d ON d.id=r.evidence_document_id AND d.asset_id=r.asset_id WHERE r.asset_id=$1 AND r.revision=$2",[row.asset_id,row.revision]);
 const partners=await c.query('SELECT p.* FROM institutional.partners p JOIN institutional.documents d ON d.id=p.evidence_document_id AND d.asset_id=p.asset_id WHERE p.asset_id=$1 AND p.revision=$2',[row.asset_id,row.revision]);
 const normalize=r=>({...r,reviewed_at:r.reviewed_at?.toISOString(),expires_at:r.expires_at?.toISOString()});
 return policy.evaluate({...row.payload,asset_family:row.asset_family,revision:row.revision},Object.fromEntries(reviews.rows.map(r=>[r.check_name,normalize(r)])),partners.rows.map(p=>({...p.payload,...normalize(p)})),spec.rows[0].specification);
}
async function requireAdmission(id,user) {
 return transaction(async c=>{
  const row=await record(c,id,user,['intermediary','compliance','legal','admin']);
  const decision=await admission(c,row);
  await event(c,row,user,'compliance_gate',decision);
  return decision;
 });
}
module.exports={fault,transaction,membership,record,event,admission,requireAdmission};
