'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{generateKeyPairSync}=require('node:crypto'),jwt=require('jsonwebtoken');
const participants=require('../../api/services/institutional-participants'),policy=require('../../api/services/institutional-policy');
const P='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',E='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const record=()=>({revision:1,participants:[{id:P,kind:'person',legal_name:'Synthetic Person',roles:['applicant','beneficial_owner']},{id:E,kind:'entity',legal_name:'Synthetic Entity',roles:['asset_owner']}],participant_relationships:[{entity_id:E,related_party_id:P,relationship:'ownership',percent:100}]});
test('participant graph includes each declared person/entity evidence requirement',()=>{const r=record();assert.deepEqual(participants.validate(r),[]);assert.ok(participants.checks(r).includes('party:'+P+':sanctions'));assert.ok(participants.checks(r).includes('party:'+E+':beneficial_ownership'));assert.equal(participants.checks(r).length,10);});
for(const [name,mutate]of Object.entries({missing:r=>delete r.participants,malformed:r=>r.participants=[null],duplicate:r=>r.participants.push(r.participants[0]),unknown_owner:r=>r.participant_relationships[0].related_party_id='unknown',over_100:r=>r.participant_relationships[0].percent=101,entity_without_control:r=>r.participant_relationships=[],self_cycle:r=>r.participant_relationships[0].related_party_id=E}))test('participant '+name+' blocks',()=>{const r=record();mutate(r);assert.ok(participants.validate(r).length);});
test('participant-specific evidence cannot be replaced by transaction-wide approval',()=>{assert.ok(participants.gate(record(),{kyc:{outcome:'approved'}},policy.validReview,Date.now()).length);});
test('participant sanctions expiry and revision changes invalidate approval',()=>{const r=record(),now=Date.now(),review={revision:1,outcome:'approved',evidence_document_id:'doc',proposed_by:'maker',approved_by:'checker',reviewed_at:new Date(now-1000),expires_at:new Date(now+3600000)};const reviews=Object.fromEntries(participants.checks(r).map(k=>[k,{...review}]));assert.deepEqual(participants.gate(r,reviews,policy.validReview,now),[]);reviews['party:'+P+':sanctions'].expires_at=new Date(now+172800000);assert.ok(participants.gate(r,reviews,policy.validReview,now).length);r.revision=2;assert.ok(participants.gate(r,reviews,policy.validReview,now).length);});
test('JWKS key rotation, cache expiry, unknown key, MFA and outage are enforced',async()=>{
 const identity=require('../../api/services/institutional-identity');const first=generateKeyPairSync('rsa',{modulusLength:2048}),second=generateKeyPairSync('rsa',{modulusLength:2048});
 const env={PCM_IDP_ISSUER:'https://id.example',PCM_IDP_AUDIENCE:'coreg',PCM_IDP_JWKS_URL:'https://id.example/jwks'};
 const fetch=global.fetch,dateNow=Date.now;let now=dateNow(),mode='first',calls=0;Date.now=()=>now;
 global.fetch=async()=>{calls++;if(mode==='outage')throw Error('outage');const pair=mode==='first'?first:second;return new Response(JSON.stringify({keys:[{...pair.publicKey.export({format:'jwk'}),kid:mode,alg:'RS256',use:'sig'}]}));};
 const token=(pair,kid,claims={})=>jwt.sign({sub:'alice',amr:['mfa'],auth_time:Math.floor(now/1000),...claims},pair.privateKey,{algorithm:'RS256',keyid:kid,issuer:env.PCM_IDP_ISSUER,audience:env.PCM_IDP_AUDIENCE,expiresIn:3600});
 try{
  const old=token(first,'first');assert.equal((await identity.verify(old,env)).sub,'alice');await identity.verify(old,env);assert.equal(calls,1);
  await assert.rejects(identity.verify(token(first,'unknown'),env),/Unknown signing key/);
  await assert.rejects(identity.verify(token(first,'first',{amr:['pwd']}),env),/MFA/);
  mode='second';now+=61000;assert.equal((await identity.verify(token(second,'second'),env)).sub,'alice');await assert.rejects(identity.verify(old,env),/Unknown signing key/);
  mode='outage';now+=61000;await assert.rejects(identity.verify(token(second,'second'),env),/unavailable/);
 }finally{global.fetch=fetch;Date.now=dateNow;}
});
test('production configuration allows rotating JWKS but requires provider evidence',()=>{
 const {assertConfiguration}=require('../../api/services/institutional-config');assert.throws(()=>assertConfiguration({NODE_ENV:'production'}),/blocked/);
 const env={NODE_ENV:'production',PCM_IDP_JWKS_URL:'https://id.example/jwks',PCM_IDP_ISSUER:'https://id.example',PCM_IDP_AUDIENCE:'coreg',PCM_MALWARE_SCANNER_URL:'https://scan.example',PCM_MALWARE_SCANNER_TOKEN:'test',PCM_BUCKET_KYC_VAULT:'kyc',PCM_BUCKET_ASSET_DOCS:'docs',PCM_KYC_KMS_KEY:'one',PCM_VAULT_KMS_KEY:'two',PCM_VAULT_RETENTION_SECONDS:'123',SENTINEL_JWT_SECRET:'test',SENTINEL_URL:'https://governance.example',PCM_INSTITUTIONAL_CUTOVER:'approved'};assert.doesNotThrow(()=>assertConfiguration(env));assert.throws(()=>assertConfiguration({...env,PCM_IDP_JWKS_URL:'http://bad.example'}),/HTTPS/);
});
