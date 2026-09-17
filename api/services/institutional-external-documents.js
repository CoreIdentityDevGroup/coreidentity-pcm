'use strict';
const {randomUUID}=require('node:crypto');
const fault=(status,message)=>Object.assign(new Error(message),{status});
const categories=['asset','kyc','kyb','pof','agreement','settlement','closing'];
function validate(body){
 if(!body||Object.keys(body).some(k=>!['revision','category','document_key','sha256'].includes(k)))throw fault(400,'Only reference metadata is accepted; never submit links, credentials or files');
 if(!Number.isInteger(body.revision)||!categories.includes(body.category)||typeof body.document_key!=='string'||!/^DOC-[A-Z0-9]{1,32}$/.test(body.document_key))throw fault(400,'Revision, known category and a reference such as DOC-001 required');
 if(body.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(body.sha256))throw fault(400,'Optional SHA-256 must be 64 lowercase hexadecimal characters');
 return {category:body.category,document_key:body.document_key,...(body.sha256?{declared_sha256:body.sha256}:{})};
}
function project(events,revision){
 const docs=[];
 for(const e of events){const p=e.payload;
  if(e.action==='external_document_registered')docs.push({...p,registered_by:e.actor,review_status:'pending_external_review',scan_status:'not_scanned',storage_verified:false,gate_eligible:false});
  if(e.action==='external_document_reviewed'){const d=docs.find(d=>d.id===p.document_id);if(d){d.review_status=p.outcome;d.reviewed_by=e.actor;d.reviewed_at=p.occurred_at;}}
 }
 return docs.map(d=>({...d,current_revision:d.revision===revision}));
}
async function history(c,row){return (await c.query("SELECT action,actor,payload FROM institutional.events WHERE asset_id=$1 AND action IN ('external_document_registered','external_document_reviewed') ORDER BY sequence",[row.asset_id])).rows;}
function writable(row,revision){if(row.stage==='completed')throw fault(409,'Closed transaction references are immutable');if(row.revision!==revision)throw fault(409,'Transaction changed; reload its current revision');}
async function register(c,row,user,body,event){
 writable(row,body?.revision);const value=validate(body),docs=project(await history(c,row),row.revision);
 const prior=docs.filter(d=>d.document_key===value.document_key);
 if(prior.some(d=>d.category!==value.category))throw fault(409,'Document category cannot change between versions');
 const version=prior.length+1,id=randomUUID();
 const item={id,...value,version,revision:row.revision,provider:'mega',locator:'CoreG/'+row.asset_id+'/'+value.document_key+'/v'+version};
 await event(c,row,user,'external_document_registered',item);
 return {...item,scan_status:'not_scanned',storage_verified:false,gate_eligible:false};
}
async function review(c,row,user,id,body,event){
 writable(row,body?.revision);
 if(!body||Object.keys(body).some(k=>!['revision','outcome'].includes(k))||!['reviewed_externally','rejected'].includes(body.outcome))throw fault(400,'Explicit external review outcome required');
 const docs=project(await history(c,row),row.revision),doc=docs.find(d=>d.id===id);
 if(!doc)throw fault(404,'External reference not found');
 if(!doc.current_revision||doc.registered_by===user.sub||doc.review_status!=='pending_external_review'||docs.some(d=>d.document_key===doc.document_key&&d.version>doc.version))throw fault(409,'A different reviewer must review the latest pending version in the current transaction revision');
 await event(c,row,user,'external_document_reviewed',{document_id:id,outcome:body.outcome,revision:row.revision});return {outcome:body.outcome,gate_eligible:false};
}
module.exports={validate,project,history,register,review};
