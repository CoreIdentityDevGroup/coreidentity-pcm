'use strict';
const router=require('express').Router();
const {randomUUID}=require('node:crypto');
const store=require('../services/institutional-store');
const policy=require('../services/institutional-policy');
const integrity=require('../services/institutional-integrity');
const EDIT=['intermediary','compliance','legal','admin'];
const REVIEW=['compliance','legal'];
const ALL=['client','intermediary','compliance','verifier','legal','admin','auditor'];
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const route=fn=>async(req,res,next)=>{try {res.json(await store.transaction(c=>fn(c,req)));}catch(e){if(e.status)res.status(e.status).json({error:e.message});else next(e);}};
function revision(row,req){if(req.body.revision!==row.revision)throw store.fault(409,'Transaction changed; reload current revision');}
async function evidence(c,row,id){if(!uuid(id))throw store.fault(400,'Evidence document ID required');const d=await c.query('SELECT id FROM institutional.documents WHERE id=$1 AND asset_id=$2',[id,row.asset_id]);if(!d.rows.length)throw store.fault(422,'Evidence must be a scanned document belonging to this transaction');}
router.get('/schemas',route(async(c,req)=>{
 await store.membership(c,req.user,req.query.tenant_id,ALL);
 const r=await c.query('SELECT family,version,specification FROM institutional.schemas WHERE active=true ORDER BY family,version');
 return {schemas:r.rows,stages:policy.STAGES.map((key,i)=>({key,label:policy.LABELS[i]})),governance:'Trust Infrastructure / AEG governs every stage'};
}));
router.get('/transactions',route(async(c,req)=>{
 const role=await store.membership(c,req.user,req.query.tenant_id,ALL);
 // Tenant list intentionally returns no KYC contents or document paths.
 return {transactions:(await c.query('SELECT asset_id,revision,asset_family,stage,updated_at FROM institutional.records r WHERE tenant_id=$1 AND ($2::boolean OR EXISTS(SELECT 1 FROM institutional.transaction_access a WHERE a.asset_id=r.asset_id AND a.subject=$3 AND a.active=true)) ORDER BY updated_at DESC LIMIT 100',[req.query.tenant_id,!['client','intermediary','verifier'].includes(role),req.user.sub])).rows};
}));
router.post('/transactions',route(async(c,req)=>{
 const {tenant_id,asset_id,schema_version,record}=req.body;
 if(!uuid(tenant_id)||!uuid(asset_id)||!Number.isInteger(schema_version)||!record)throw store.fault(400,'tenant_id, existing asset_id, schema_version and record required');
 // Only provisioned administrators can bind an existing asset into a tenant.
 await store.membership(c,req.user,tenant_id,['admin']);
 const schema=await c.query('SELECT specification FROM institutional.schemas WHERE family=$1 AND version=$2 AND active=true',[record.asset_family,schema_version]);
 if(!schema.rows.length)throw store.fault(422,'Approved schema required');
 const errors=policy.validateRecord(record,schema.rows[0].specification);
 if(errors.length)throw store.fault(422,errors.join('; '));
 const result=await c.query('INSERT INTO institutional.records(asset_id,tenant_id,schema_version,asset_family,payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[asset_id,tenant_id,schema_version,record.asset_family,record]);
 await store.event(c,result.rows[0],req.user,'transaction_registered',{revision:1,record_hash:policy.digest(record)});
 await integrity.screen(c,result.rows[0],req.user);
 return result.rows[0];
}));
router.get('/transactions/:id',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,ALL);
 await store.event(c,row,req.user,'transaction_viewed',{revision:row.revision});
 return {transaction:row,admission:await store.admission(c,row),integrity:await integrity.current(c,row),changes:(await c.query('SELECT * FROM institutional.change_proposals WHERE asset_id=$1 AND revision=$2 ORDER BY created_at',[row.asset_id,row.revision])).rows};
}));
router.put('/transactions/:id',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,EDIT);revision(row,req);
 if(row.stage==='completed')throw store.fault(409,'Closed transaction cannot be overwritten');
 const schema=await c.query('SELECT specification FROM institutional.schemas WHERE family=$1 AND version=$2 AND active=true',[row.asset_family,row.schema_version]);
 if(!schema.rows.length)throw store.fault(422,'Schema inactive');
 const record=req.body.record;
 if(record?.asset_family!==row.asset_family)throw store.fault(422,'Family changes require a separately admitted record');
 const errors=policy.validateRecord(record,schema.rows[0].specification);if(errors.length)throw store.fault(422,errors.join('; '));
 const proposed=await c.query('INSERT INTO institutional.change_proposals(asset_id,revision,payload,proposed_by)VALUES($1,$2,$3,$4)RETURNING id,revision,outcome',[row.asset_id,row.revision,record,req.user.sub]);
 await store.event(c,row,req.user,'sensitive_change_proposed',{id:proposed.rows[0].id,revision:row.revision,new_hash:policy.digest(record)});
 return proposed.rows[0];
}));
router.post('/transactions/:id/changes/:changeId/decision',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,REVIEW);revision(row,req);
 if(!['approved','rejected'].includes(req.body.outcome))throw store.fault(400,'Explicit decision required');
 const proposed=await c.query("UPDATE institutional.change_proposals SET outcome=$1,approved_by=$2,decided_at=now() WHERE id=$3 AND asset_id=$4 AND revision=$5 AND proposed_by<>$2 AND outcome='pending' RETURNING *",[req.body.outcome,req.user.sub,req.params.changeId,row.asset_id,row.revision]);
 if(!proposed.rows.length)throw store.fault(409,'Independent pending change review required');
 if(req.body.outcome==='approved'){
  const updated=await c.query('UPDATE institutional.records SET payload=$1,revision=revision+1,updated_at=now() WHERE asset_id=$2 RETURNING *',[proposed.rows[0].payload,row.asset_id]);
  await integrity.screen(c,updated.rows[0],req.user);
 }
 await store.event(c,row,req.user,'sensitive_change_decided',{id:req.params.changeId,outcome:req.body.outcome,old_revision:row.revision,approval_invalidated:req.body.outcome==='approved'});
 return {outcome:req.body.outcome,revision:row.revision+(req.body.outcome==='approved'?1:0)};
}));
router.post('/transactions/:id/reviews',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,['verifier',...EDIT]);revision(row,req);
 const {check_name,evidence_document_id,expires_at}=req.body;
 const schema=await c.query('SELECT specification FROM institutional.schemas WHERE family=$1 AND version=$2',[row.asset_family,row.schema_version]);
 const allowed=[...require('../services/institutional-participants').checks({...row.payload,revision:row.revision}),...policy.BASE,...schema.rows[0].specification.checks,'kyc','kyb','beneficial_ownership','aml','sanctions','regulatory_classification','permitted_activity','permitted_compensation','closing_evidence','settlement','fees','agreements','instrument_integrity'];
 if(!allowed.includes(check_name)||!Number.isFinite(Date.parse(expires_at))||Date.parse(expires_at)<=Date.now())throw store.fault(400,'Known check and future expiry required');
 await evidence(c,row,evidence_document_id);
 let attestation=null;
 if(check_name==='instrument_integrity'){
  const s=await integrity.current(c,row),blockers=integrity.screeningBlockers(row,s);if(blockers.length)throw store.fault(422,blockers.join('; '));
  const a=req.body.integrity_attestation;
  if(!a||a.screening_id!==s.id||a.independent_channel!==true||typeof a.source!=='string'||a.source.trim().length<10||a.source.length>2000||typeof a.note!=='string'||a.note.trim().length<20||a.note.length>4000)throw store.fault(422,'Current screening ID, independent channel source and verification note required');
  attestation={screening_id:s.id,independent_channel:true,source:a.source.trim(),note:a.note.trim()};
 }
 const r=await c.query("INSERT INTO institutional.reviews(asset_id,revision,check_name,proposed_by,outcome,evidence_document_id,expires_at,integrity_attestation) VALUES($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING *",[row.asset_id,row.revision,check_name,req.user.sub,evidence_document_id,expires_at,attestation]);
 await store.event(c,row,req.user,'review_proposed',{id:r.rows[0].id,check_name,revision:row.revision});return r.rows[0];
}));
router.post('/transactions/:id/reviews/:reviewId/decision',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,REVIEW);revision(row,req);
 if(!['approved','rejected'].includes(req.body.outcome))throw store.fault(400,'Explicit approved or rejected outcome required');
 const proposedReview=(await c.query('SELECT * FROM institutional.reviews WHERE id=$1 AND asset_id=$2 AND revision=$3',[req.params.reviewId,row.asset_id,row.revision])).rows[0];
 if(req.body.outcome==='approved'&&proposedReview?.check_name==='instrument_integrity'){
  const screening=await integrity.current(c,row);const blockers=integrity.screeningBlockers(row,screening);
  if(blockers.length||proposedReview.integrity_attestation?.screening_id!==screening.id)throw store.fault(422,'Current nonblocked integrity screening required');
 }
 const r=await c.query("UPDATE institutional.reviews SET outcome=$1,approved_by=$2,reviewed_at=now() WHERE id=$3 AND asset_id=$4 AND revision=$5 AND proposed_by<>$2 AND outcome='pending' AND expires_at>now() RETURNING *",[req.body.outcome,req.user.sub,req.params.reviewId,row.asset_id,row.revision]);
 if(!r.rows.length)throw store.fault(409,'Independent reviewer and current pending review required');
 await store.event(c,row,req.user,'review_decided',{id:req.params.reviewId,outcome:req.body.outcome,revision:row.revision});return r.rows[0];
}));
router.post('/transactions/:id/partners',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,EDIT);revision(row,req);
 const {partner,evidence_document_id,expires_at}=req.body;
 if(!partner||!['custodian','regulated_intermediary'].includes(partner.role)||!partner.organization||partner.organization==='CoreG'||!partner.license_reference||!Array.isArray(partner.jurisdictions)||!Number.isFinite(Date.parse(expires_at))||Date.parse(expires_at)<=Date.now())throw store.fault(400,'Independent partner, license, scope and expiry required');
 await evidence(c,row,evidence_document_id);
 const r=await c.query('INSERT INTO institutional.partners(asset_id,revision,payload,proposed_by,evidence_document_id,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[row.asset_id,row.revision,partner,req.user.sub,evidence_document_id,expires_at]);
 await store.event(c,row,req.user,'partner_proposed',{id:r.rows[0].id,revision:row.revision});return r.rows[0];
}));
router.post('/transactions/:id/partners/:partnerId/decision',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,REVIEW);revision(row,req);
 if(!['approved','rejected'].includes(req.body.outcome))throw store.fault(400,'Explicit outcome required');
 const r=await c.query("UPDATE institutional.partners SET outcome=$1,approved_by=$2,reviewed_at=now() WHERE id=$3 AND asset_id=$4 AND revision=$5 AND proposed_by<>$2 AND outcome='pending' AND expires_at>now() RETURNING *",[req.body.outcome,req.user.sub,req.params.partnerId,row.asset_id,row.revision]);
 if(!r.rows.length)throw store.fault(409,'Independent current partner review required');
 await store.event(c,row,req.user,'partner_decided',{id:req.params.partnerId,outcome:req.body.outcome});return r.rows[0];
}));
router.post('/transactions/:id/advance',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,EDIT);revision(row,req);
 const pending=await c.query("SELECT 1 FROM institutional.change_proposals WHERE asset_id=$1 AND outcome='pending'",[row.asset_id]);
 if(pending.rows.length)throw store.fault(422,'Pending sensitive change requires independent decision');
 const next=policy.STAGES[policy.STAGES.indexOf(row.stage)+1];
 if(!next||req.body.to_stage!==next)throw store.fault(422,'Canonical stages must advance one at a time');
 const integrityGate=await integrity.gate(c,row);
 if(!integrityGate.allowed)throw store.fault(422,integrityGate.blockers.join('; '));
 const gate=await store.admission(c,row);
 if(next==='kyc_verification'){
  const ps=require('../services/institutional-participants');
  const reviews=(await c.query('SELECT * FROM institutional.reviews WHERE asset_id=$1 AND revision=$2',[row.asset_id,row.revision])).rows;
  const blockers=ps.gate({...row.payload,revision:row.revision},Object.fromEntries(reviews.map(r=>[r.check_name,r])),policy.validReview,Date.now());
  if(blockers.length)throw store.fault(422,blockers.join('; '));
 }
 const earlyChecks = next==='kyc_verification' ? ['kyc','kyb','beneficial_ownership','aml','sanctions'] : next==='collateralization' ? ['ownership','authority','custody','provenance'] : next==='appraisal_review' ? ['valuation','transferability'] : [];
 if(earlyChecks.length){
  const checks=await c.query('SELECT * FROM institutional.reviews WHERE asset_id=$1 AND revision=$2 AND check_name=ANY($3::text[])',[row.asset_id,row.revision,earlyChecks]);
  if(checks.rows.length!==earlyChecks.length || checks.rows.some(r=>!policy.validReview({...r,reviewed_at:r.reviewed_at?.toISOString(),expires_at:r.expires_at?.toISOString()},row.revision,Date.now())))throw store.fault(422,'Stage evidence approvals incomplete or stale');
 }
 // From monetization onward all required checks are reevaluated in the same transaction/row lock.
 if(policy.STAGES.indexOf(next)>=4 && !gate.allowed)throw store.fault(422,gate.blockers.join('; '));
 if(next==='completed'){
  await store.membership(c,req.user,row.tenant_id,['compliance','legal']);
  const closure=await c.query("SELECT * FROM institutional.reviews WHERE asset_id=$1 AND revision=$2 AND check_name=ANY($3::text[])",[row.asset_id,row.revision,['closing_evidence','settlement','fees','agreements']]);
  if(closure.rows.length!==4 || closure.rows.some(r=>!policy.validReview({...r,reviewed_at:r.reviewed_at?.toISOString(),expires_at:r.expires_at?.toISOString()},row.revision,Date.now())))throw store.fault(422,'Independent closing, settlement, agreements and fee evidence required');
 }
 const governance=await require('../services/governance').sentinelCheck('INSTITUTIONAL_ADVANCE.'+next.toUpperCase(),'pcm:asset:'+row.asset_id,{tenant_id:row.tenant_id,revision:row.revision,actor:req.user.sub});
 if(!governance.allowed)throw store.fault(503,'Trust Infrastructure / AEG has not authorized advancement');
 await c.query('UPDATE institutional.records SET stage=$1,updated_at=now() WHERE asset_id=$2',[next,row.asset_id]);
 await store.event(c,row,req.user,'stage_advanced',{from:row.stage,to:next,revision:row.revision});
 if(next==='completed')await manifest(c,{...row,stage:next},req.user);
 return {stage:next,revision:row.revision};
}));
async function manifest(c,row,user){
 const docs=await c.query('SELECT * FROM institutional.documents WHERE asset_id=$1 ORDER BY document_key,version',[row.asset_id]);
 const reviews=await c.query('SELECT * FROM institutional.reviews WHERE asset_id=$1 ORDER BY revision,check_name',[row.asset_id]);
 const partners=await c.query('SELECT * FROM institutional.partners WHERE asset_id=$1 ORDER BY id',[row.asset_id]);
 const events=await c.query('SELECT * FROM institutional.events WHERE asset_id=$1 ORDER BY sequence',[row.asset_id]);
 const versions=await c.query('SELECT * FROM institutional.record_versions WHERE asset_id=$1 ORDER BY sequence',[row.asset_id]);
 const changes=await c.query('SELECT * FROM institutional.change_proposals WHERE asset_id=$1 ORDER BY created_at,id',[row.asset_id]);
 const schema=await c.query('SELECT family,version,specification FROM institutional.schemas WHERE family=$1 AND version=$2',[row.asset_family,row.schema_version]);
 const screenings=await c.query('SELECT * FROM institutional.integrity_screenings WHERE asset_id=$1 ORDER BY revision',[row.asset_id]);
 const payload={format:'CoreG-MTF-2',integrity_screenings:screenings.rows,transaction:row,schema:schema.rows[0],change_proposals:changes.rows,record_versions:versions.rows,documents:docs.rows,reviews:reviews.rows,partners:partners.rows,events:events.rows};
 const sha256=policy.digest(payload);
 const r=await c.query('INSERT INTO institutional.manifests(asset_id,revision,payload,sha256) VALUES($1,$2,$3,$4) RETURNING id,sha256,created_at',[row.asset_id,row.revision,payload,sha256]);
 await store.event(c,row,user,'master_file_sealed',{id:r.rows[0].id,sha256});return {...r.rows[0],payload};
}
router.post('/transactions/:id/master-file',route(async(c,req)=>{const row=await store.record(c,req.params.id,req.user,['compliance','legal']);return manifest(c,row,req.user);}));
router.get('/transactions/:id/events',route(async(c,req)=>{const row=await store.record(c,req.params.id,req.user,['compliance','legal','admin','auditor']);await store.event(c,row,req.user,'audit_viewed',{});return {events:(await c.query('SELECT * FROM institutional.events WHERE asset_id=$1 ORDER BY sequence',[row.asset_id])).rows};}));
router.get('/transactions/:id/matches',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,['intermediary','compliance','legal','admin']);
 const decision=await store.admission(c,row);
 if(!decision.allowed)throw store.fault(422,'Compliance Gate blocked matching: '+decision.blockers.join('; '));
 const result=await require('../services/db').pehf.query("SELECT fund_id,fund_name,jurisdiction FROM pcm_funds WHERE status='active' AND jurisdiction=ANY($1::text[]) ORDER BY fund_name LIMIT 20",[row.payload.jurisdictions]);
 await store.event(c,row,req.user,'matching_requested',{revision:row.revision,count:result.rows.length});
 return {candidates:result.rows,notice:'Candidates require separate counterparty admission before introduction or execution'};
}));
router.post('/transactions/:id/integrity-screening',route(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,EDIT);revision(row,req);
 if(row.stage==='completed')throw store.fault(409,'Closed evidence is immutable');
 return integrity.screen(c,row,req.user);
}));
router.use('/transactions',require('./institutional-external-documents'));
router.use('/transactions',require('./institutional-vault'));
module.exports=router;
