'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const express=require('express'),request=require('supertest');
const p=require('../../api/services/institutional-policy');
const A='11111111-1111-4111-8111-111111111111',T='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
test('PostgreSQL migration and institutional API enforcement',async t=>{
 const pg=new PGlite();await pg.exec('CREATE ROLE pcm_app;CREATE TABLE pcm_assets(asset_id uuid PRIMARY KEY);');
 for(let i=0;i<2;i++)for(const name of ['0026-institutional-foundation.sql','0027-institutional-history-isolation.sql','0028-institutional-row-policies.sql','0029-institutional-package-seeds.sql','0030-institutional-legacy-lock.sql','0031-institutional-four-eyes-changes.sql','0032-institutional-integrity-agent.sql'])await pg.exec(fs.readFileSync(path.join(__dirname,'../../db/migrations',name),'utf8'));
 const pool={query:(q,v)=>pg.query(q,v),connect:async()=>({query:async(q,v)=>{const r=await pg.query(q,v);if(q==='BEGIN')await pg.exec('SET LOCAL ROLE pcm_app');return r;},release(){}})};
 require.cache[require.resolve('../../api/services/db')]={exports:{assets:pool}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={sub:req.headers['x-test-sub']||'admin',amr:req.headers['x-no-mfa']?[]:['mfa'],auth_time:Date.now()/1000};next();});app.use(require('../../api/routes/institutional'));app.use((err,req,res,next)=>res.status(500).json({error:err.message}));
 await pg.query('INSERT INTO pcm_assets VALUES($1)',[A]);
 await pg.query('INSERT INTO institutional.schemas(family,version,specification,active,proposed_by,approved_by) VALUES($1,1,$2,true,$3,$4) ON CONFLICT(family,version) DO UPDATE SET active=true,approved_by=EXCLUDED.approved_by',['real_assets',p.PACKAGES.real_assets,'one','two']);
 for(const [subject,tenant,role]of [['admin',T,'admin'],['maker',T,'verifier'],['checker',T,'compliance'],['outsider',OTHER,'admin'],['client',T,'client']])await pg.query('INSERT INTO institutional.memberships(subject,tenant_id,role)VALUES($1,$2,$3)',[subject,tenant,role]);
 const record={asset_family:'real_assets',instrument_type:'property',transaction_structure:'sale',jurisdictions:['US'],details:{description:'property',location:'US',title_provenance:'registry',insurance:'policy'}};
 await t.test('runtime readiness verifies migrated database and restricted role',async()=>{
  await pg.exec('SET ROLE pcm_app');try{await require('../../api/services/institutional-readiness').database(pool);}finally{await pg.exec('RESET ROLE');}
  await assert.rejects(require('../../api/services/institutional-readiness').database(pool),/nonprivileged/);
 });
 await t.test('registration enforces administrator membership',async()=>{await request(app).post('/transactions').set('x-test-sub','outsider').send({asset_id:A,tenant_id:T,schema_version:1,record}).expect(403);});
 await t.test('register transaction with initial snapshot',async()=>{await request(app).post('/transactions').send({asset_id:A,tenant_id:T,schema_version:1,record}).expect(200);assert.equal((await pg.query('SELECT * FROM institutional.record_versions')).rows.length,1);assert.equal((await pg.query('SELECT * FROM institutional.integrity_screenings')).rows[0].result.status,'pending_human_verification');});
 await t.test('screening retry is idempotent and tenant scoped',async()=>{
  await request(app).post('/transactions/'+A+'/integrity-screening').send({revision:1}).expect(200);
  await request(app).post('/transactions/'+A+'/integrity-screening').set('x-test-sub','outsider').send({revision:1}).expect(404);
  assert.equal((await pg.query('SELECT * FROM institutional.integrity_screenings')).rows.length,1);
 });
 await t.test('missing MFA denies even administrator',async()=>{await request(app).get('/transactions/'+A).set('x-no-mfa','true').expect(403);});
 await t.test('cross tenant read denied',async()=>{await request(app).get('/transactions/'+A).set('x-test-sub','outsider').expect(404);});
 await t.test('same tenant client needs transaction grant',async()=>{await request(app).get('/transactions/'+A).set('x-test-sub','client').expect(404);const r=await request(app).get('/transactions?tenant_id='+T).set('x-test-sub','client').expect(200);assert.equal(r.body.transactions.length,0);});
 await pg.query('INSERT INTO institutional.transaction_access(asset_id,subject)VALUES($1,$2)',[A,'maker']);
 await t.test('missing scanned evidence cannot be approved',async()=>{await request(app).post('/transactions/'+A+'/reviews').set('x-test-sub','maker').send({revision:1,check_name:'kyc',evidence_document_id:OTHER,expires_at:'2099-01-01'}).expect(422);});
 await pg.query("INSERT INTO institutional.documents(id,asset_id,document_key,version,category,storage_path,storage_generation,sha256,mime_type,size_bytes,scan_provider,scan_reference,scan_status,uploaded_by) VALUES($1,$2,'identity',1,'asset','private/object','1',$3,'application/pdf',10,'test-scanner','scan-proof','clean','maker')",[OTHER,A,'a'.repeat(64)]);
 const review=await request(app).post('/transactions/'+A+'/reviews').set('x-test-sub','maker').send({revision:1,check_name:'kyc',evidence_document_id:OTHER,expires_at:'2099-01-01'}).expect(200);
 await t.test('maker cannot self approve',async()=>{await pg.query("UPDATE institutional.memberships SET role='compliance' WHERE subject='maker'");await request(app).post('/transactions/'+A+'/reviews/'+review.body.id+'/decision').set('x-test-sub','maker').send({revision:1,outcome:'approved'}).expect(409);});
 await t.test('independent compliance reviewer approves',async()=>{await request(app).post('/transactions/'+A+'/reviews/'+review.body.id+'/decision').set('x-test-sub','checker').send({revision:1,outcome:'approved'}).expect(200);});
 await t.test('matching blocked without compliance evidence',async()=>{await request(app).get('/transactions/'+A+'/matches').expect(422);});
 await t.test('cannot stage-jump',async()=>{await request(app).post('/transactions/'+A+'/advance').send({revision:1,to_stage:'monetization'}).expect(422);});
 await t.test('incomplete first stage evidence blocks',async()=>{await request(app).post('/transactions/'+A+'/advance').send({revision:1,to_stage:'kyc_verification'}).expect(422);});
 await t.test('fact edit increments revision and retains prior snapshot',async()=>{const proposal=await request(app).put('/transactions/'+A).send({revision:1,record:{...record,details:{...record.details,location:'Canada'}}}).expect(200);assert.equal((await pg.query('SELECT revision FROM institutional.records')).rows[0].revision,1);await request(app).post('/transactions/'+A+'/changes/'+proposal.body.id+'/decision').set('x-test-sub','checker').send({revision:1,outcome:'approved'}).expect(200);assert.equal((await pg.query('SELECT * FROM institutional.record_versions')).rows.length,2);const r=await request(app).get('/transactions/'+A).expect(200);assert.equal(r.body.admission.allowed,false);assert.equal(r.body.transaction.revision,2);});
 await t.test('stale write rejected',async()=>{await request(app).put('/transactions/'+A).send({revision:1,record}).expect(409);});
 await t.test('legacy mutation blocked for admitted transaction',async()=>{await assert.rejects(pg.query('DELETE FROM pcm_assets WHERE asset_id=$1',[A]),/legacy mutation prohibited/);});
 await t.test('master transaction file includes immutable history',async()=>{const r=await request(app).post('/transactions/'+A+'/master-file').set('x-test-sub','checker').send({}).expect(200);assert.equal(r.body.payload.record_versions.length,2);assert.equal(r.body.payload.integrity_screenings.length,2);assert.equal(r.body.sha256,p.digest(r.body.payload));});
 await t.test('document overwrite/delete/truncate denied',async()=>{for(const sql of ['DELETE FROM institutional.documents','UPDATE institutional.documents SET version=2','TRUNCATE institutional.documents'])await assert.rejects(pg.exec(sql),/Append-only/);});
 await t.test('screenings cannot be modified or erased',async()=>{
  for(const sql of ['DELETE FROM institutional.integrity_screenings','UPDATE institutional.integrity_screenings SET revision=9','TRUNCATE institutional.integrity_screenings'])await assert.rejects(pg.exec(sql),/Append-only/);
 });
 await t.test('hardblock and screening failure cannot silently progress',async()=>{
  const B='44444444-4444-4444-8444-444444444444';await pg.query('INSERT INTO pcm_assets VALUES($1)',[B]);
  const blocked={...record,integrity_input:{isin:'US0378331006'}};
  await request(app).post('/transactions').send({asset_id:B,tenant_id:T,schema_version:1,record:blocked}).expect(200);
  const detail=await request(app).get('/transactions/'+B).expect(200);assert.equal(detail.body.integrity.result.status,'blocked');
  await request(app).post('/transactions/'+B+'/advance').send({revision:1,to_stage:'kyc_verification'}).expect(422);
  await request(app).get('/transactions/'+B+'/matches').expect(422);
  // DB also denies manufacturing a human integrity override for a hard block.
  await assert.rejects(pg.query("INSERT INTO institutional.reviews(asset_id,revision,check_name,proposed_by,outcome,evidence_document_id,expires_at,integrity_attestation)VALUES($1,1,'instrument_integrity','maker','pending',$2,'2099-01-01',$3)",[B,OTHER,{screening_id:detail.body.integrity.id,independent_channel:true,source:'Independent public directory',note:'Contacted institution through independent published channel'}]),/nonblocked/);
  const C='55555555-5555-4555-8555-555555555555';await pg.query('INSERT INTO pcm_assets VALUES($1)',[C]);
  const agent=require('../../agents/instrument-integrity'),original=agent.execute;agent.execute=async()=>{throw Error('Injected engine failure');};
  try{await request(app).post('/transactions').send({asset_id:C,tenant_id:T,schema_version:1,record}).expect(500);}finally{agent.execute=original;}
  assert.equal((await pg.query('SELECT * FROM institutional.records WHERE asset_id=$1',[C])).rows.length,0);
  await request(app).post('/transactions').send({asset_id:C,tenant_id:T,schema_version:1,record}).expect(200);
  const isolated=await pool.connect();await isolated.query('BEGIN');try{await isolated.query("SELECT set_config('institutional.subject','outsider',true)");assert.equal((await isolated.query('SELECT * FROM institutional.integrity_screenings')).rows.length,0);}finally{await isolated.query('ROLLBACK');}
 });
 await t.test('audit modification denied',async()=>{await assert.rejects(pg.exec('DELETE FROM institutional.events'),/Append-only/);});
 await t.test('application role cannot grant itself tenant membership',async()=>{await pg.exec('SET ROLE pcm_app');try{await assert.rejects(pg.query('INSERT INTO institutional.memberships(subject,tenant_id,role)VALUES($1,$2,$3)',['attacker',T,'admin']),/permission denied/);}finally{await pg.exec('RESET ROLE');}});
 await t.test('complete approved lifecycle preserves governance and closing evidence',async t=>{
  const complete={...record,participants:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'person',legal_name:'Synthetic Test Person',roles:['applicant','asset_owner']}],participant_relationships:[],regulatory:{classification:'physical',permitted_activity:'administration',permitted_compensation:'fixed',partner_required:true}};
  const proposed=await request(app).put('/transactions/'+A).send({revision:2,record:complete}).expect(200);
  await request(app).post('/transactions/'+A+'/changes/'+proposed.body.id+'/decision').set('x-test-sub','checker').send({revision:2,outcome:'approved'}).expect(200);
  const expires_at=new Date(Date.now()+12*3600*1000).toISOString();
  const checks=[...require('../../api/services/institutional-participants').checks(complete),...p.BASE,...p.PACKAGES.real_assets.checks,'kyc','kyb','beneficial_ownership','aml','sanctions','regulatory_classification','permitted_activity','permitted_compensation','closing_evidence','settlement','fees','agreements'];
  for(const check_name of checks){
   const r=await request(app).post('/transactions/'+A+'/reviews').set('x-test-sub','maker').send({revision:3,check_name,evidence_document_id:OTHER,expires_at}).expect(200);
   await request(app).post('/transactions/'+A+'/reviews/'+r.body.id+'/decision').set('x-test-sub','checker').send({revision:3,outcome:'approved'}).expect(200);
  }
  for(const role of ['custodian','regulated_intermediary']){
   const r=await request(app).post('/transactions/'+A+'/partners').send({revision:3,partner:{role,organization:'Independent test institution',license_reference:'test-license',jurisdictions:['US']},evidence_document_id:OTHER,expires_at}).expect(200);
   await request(app).post('/transactions/'+A+'/partners/'+r.body.id+'/decision').set('x-test-sub','checker').send({revision:3,outcome:'approved'}).expect(200);
  }
  await t.test('all other evidence cannot bypass missing independent integrity approval',async()=>{
   await request(app).post('/transactions/'+A+'/advance').set('x-test-sub','checker').send({revision:3,to_stage:'kyc_verification'}).expect(422);
   await request(app).get('/transactions/'+A+'/matches').expect(422);
  });
  const detail=await request(app).get('/transactions/'+A).expect(200);
  const integrityBody={revision:3,check_name:'instrument_integrity',evidence_document_id:OTHER,expires_at,integrity_attestation:{screening_id:detail.body.integrity.id,independent_channel:true,source:'Independent official institution directory',note:'Verified authority and counterparty through separately sourced contact; evidence attached'}};
  await request(app).post('/transactions/'+A+'/reviews').set('x-test-sub','maker').send({...integrityBody,integrity_attestation:{...integrityBody.integrity_attestation,independent_channel:false}}).expect(422);
  const ir=await request(app).post('/transactions/'+A+'/reviews').set('x-test-sub','maker').send(integrityBody).expect(200);
  await request(app).post('/transactions/'+A+'/reviews/'+ir.body.id+'/decision').set('x-test-sub','maker').send({revision:3,outcome:'approved'}).expect(409);
  await assert.rejects(pg.query("UPDATE institutional.reviews SET integrity_attestation=integrity_attestation||'{\"source\":\"swapped source\"}'::jsonb WHERE id=$1",[ir.body.id]),/immutable/);
  await request(app).post('/transactions/'+A+'/reviews/'+ir.body.id+'/decision').set('x-test-sub','checker').send({revision:3,outcome:'approved'}).expect(200);
  assert.equal((await request(app).get('/transactions/'+A).expect(200)).body.admission.allowed,true);
  let allowed=false;
  require.cache[require.resolve('../../api/services/governance')]={exports:{sentinelCheck:async()=>({allowed})}};
  await request(app).post('/transactions/'+A+'/advance').set('x-test-sub','checker').send({revision:3,to_stage:'kyc_verification'}).expect(503);
  assert.equal((await pg.query('SELECT stage FROM institutional.records WHERE asset_id=$1',[A])).rows[0].stage,'intake');
  allowed=true;
  for(const to_stage of p.STAGES.slice(1))await request(app).post('/transactions/'+A+'/advance').set('x-test-sub','checker').send({revision:3,to_stage}).expect(200);
  assert.equal((await pg.query('SELECT stage FROM institutional.records WHERE asset_id=$1',[A])).rows[0].stage,'completed');
  assert.equal((await pg.query('SELECT * FROM institutional.manifests')).rows.length,2);
  await request(app).put('/transactions/'+A).send({revision:3,record}).expect(409);
 });
 await pg.close();
});
