'use strict';
// Declaration is evidence to review, never an automatic real-world identity determination.
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const roles=['applicant','asset_owner','counterparty','beneficial_owner','controller','trustee','beneficiary','authorized_signatory'];
function validate(record){
 const ps=record.participants,edges=record.participant_relationships;const errors=[];
 if(!Array.isArray(ps)||!ps.length||ps.length>100)return ['A declared participant register (1–100 entries) is required'];
 if(!Array.isArray(edges)||edges.length>500)return ['Participant ownership/control relationships must be declared'];
 const ids=new Set();for(const p of ps){
  if(!p||!uuid(p.id)||ids.has(p.id)||!['person','entity'].includes(p.kind)||typeof p.legal_name!=='string'||!p.legal_name.trim()||p.legal_name.length>300||!Array.isArray(p.roles)||!p.roles.length||p.roles.some(r=>!roles.includes(r)))errors.push('Invalid or duplicate participant identity/role declaration');
  ids.add(p?.id);
 }
 if(errors.length)return [...new Set(errors)];
 for(const role of ['applicant','asset_owner'])if(!ps.some(p=>p?.roles?.includes(role)))errors.push('Participant role required: '+role);
 const links=new Map(),seen=new Set();for(const e of edges){
  if(!e||!ids.has(e.entity_id)||!ids.has(e.related_party_id)||e.entity_id===e.related_party_id||!['ownership','control','trustee','beneficiary'].includes(e.relationship)||ps.find(p=>p.id===e.entity_id)?.kind!=='entity'){errors.push('Invalid participant relationship');continue;}
  const key=[e.entity_id,e.related_party_id,e.relationship].join(':');if(seen.has(key))errors.push('Duplicate participant relationship');seen.add(key);
  if(e.relationship==='ownership'&&(!Number.isFinite(e.percent)||e.percent<=0||e.percent>100))errors.push('Ownership percentage must be greater than zero and at most 100');
  links.set(e.entity_id,[...(links.get(e.entity_id)||[]),e.related_party_id]);
 }
 for(const p of ps){
  if(p.kind==='entity'&&!links.has(p.id))errors.push('Entity ownership/control declaration required');
  const total=edges.filter(e=>e?.entity_id===p.id&&e.relationship==='ownership').reduce((n,e)=>n+(Number.isFinite(e.percent)?e.percent:0),0);if(total>100.000001)errors.push('Declared direct ownership exceeds 100 percent');
 }
 function cycle(id,stack,done){if(stack.has(id))return true;if(done.has(id))return false;stack.add(id);for(const child of links.get(id)||[])if(cycle(child,stack,done))return true;stack.delete(id);done.add(id);return false;}
 if([...ids].some(id=>cycle(id,new Set(),new Set())))errors.push('Cyclic ownership/control requires specialist resolution before admission');
 return [...new Set(errors)];
}
function checks(record){
 if(validate(record).length)return [];
 return ['participant_register',...record.participants.flatMap(p=>[p.kind==='person'?'kyc':'kyb','authority','aml','sanctions',...(p.kind==='entity'?['beneficial_ownership']:[])].map(check=>'party:'+p.id+':'+check))];
}
function gate(record,reviews,validReview,now){
 const blockers=validate(record);if(blockers.length)return blockers;
 for(const check of checks(record)){
  const r=reviews[check];if(!validReview(r,record.revision,now))blockers.push(check+': current independent participant approval required');
  if(check.endsWith(':sanctions')&&r&&(now-Date.parse(r.reviewed_at)>86400000||Date.parse(r.expires_at)-Date.parse(r.reviewed_at)>86400000))blockers.push(check+': sanctions evidence must be renewed within 24 hours');
 }
 return blockers;
}
module.exports={validate,checks,gate};
