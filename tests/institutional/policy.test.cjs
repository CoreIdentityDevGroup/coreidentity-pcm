'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const p=require('../../api/services/institutional-policy');
const now=Date.parse('2026-09-16T12:00:00Z');
function fixture(family='precious_metals'){
 const spec=p.PACKAGES[family];const record={participants:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'person',legal_name:'Synthetic Test Person',roles:['applicant','asset_owner']}],participant_relationships:[],asset_family:family,instrument_type:'physical',transaction_structure:'sale',jurisdictions:['US'],revision:2,details:Object.fromEntries(spec.fields.map(f=>[f,'documented'])),regulatory:{classification:'physical',permitted_activity:'administration',permitted_compensation:'fixed',partner_required:true}};
 const approval={revision:2,outcome:'approved',evidence_document_id:'doc-1',proposed_by:'maker',approved_by:'checker',reviewed_at:'2026-09-16T11:00:00Z',expires_at:'2026-09-17T11:00:00Z'};
 const checks=[...require('../../api/services/institutional-participants').checks(record),...p.BASE,...spec.checks,'kyc','kyb','beneficial_ownership','aml','sanctions','regulatory_classification','permitted_activity','permitted_compensation'];
 const reviews=Object.fromEntries(checks.map(x=>[x,{...approval}]));
 const partners=['custodian','regulated_intermediary'].map(role=>({...approval,role,organization:'External institution',license_reference:'verified-reference',jurisdictions:['US']}));
 return {record,reviews,partners};
}
function evaluate(f){return p.evaluate(f.record,f.reviews,f.partners,undefined,now);}
test('canonical eight stages preserve asset before appraisal',()=>assert.deepEqual(p.STAGES,['intake','kyc_verification','collateralization','appraisal_review','monetization','securitization','tokenization','completed']));
test('complete evidence passes',()=>assert.equal(evaluate(fixture()).allowed,true));
for(const key of ['ownership','kyc','kyb','beneficial_ownership','aml','sanctions','regulatory_classification','permitted_activity','permitted_compensation'])test('missing '+key+' blocks',()=>{const f=fixture();delete f.reviews[key];assert.equal(evaluate(f).allowed,false);});
for(const [label,mutate]of Object.entries({expired:r=>r.expires_at='2026-09-15',invalid_expiry:r=>r.expires_at='invalid',same_reviewer:r=>r.approved_by='maker',old_revision:r=>r.revision=1,future_review:r=>r.reviewed_at='2026-09-18',rejected:r=>r.outcome='rejected',missing_document:r=>r.evidence_document_id=''}))test(label+' review blocks',()=>{const f=fixture();mutate(f.reviews.kyc);assert.equal(evaluate(f).allowed,false);});
test('new revision invalidates all prior approvals',()=>{const f=fixture();f.record.revision++;assert.equal(evaluate(f).allowed,false);});
test('unknown family blocks',()=>{const f=fixture();f.record.asset_family='invented';assert.equal(evaluate(f).allowed,false);});
test('unclassified never automatically activates',()=>assert.equal(evaluate(fixture('unclassified')).allowed,false));
test('isotopic package blocks unspecified or radioactive classifications',()=>{const f=fixture('isotopic_materials');assert.equal(evaluate(f).allowed,false);f.record.details.radiological_classification='radioactive';assert.equal(evaluate(f).allowed,false);});
test('stable nonhazardous isotopes still need specialist approvals',()=>{const f=fixture('isotopic_materials');f.record.details.radiological_classification='stable_nonradioactive';f.record.details.hazard_classification='nonhazardous';assert.equal(evaluate(f).allowed,true);delete f.reviews.specialist_classification;assert.equal(evaluate(f).allowed,false);});
test('mining technical report does not replace legal and financeability reviews',()=>{const f=fixture('mining');delete f.reviews.legal_title;delete f.reviews.monetization_financeability;assert.equal(evaluate(f).allowed,false);});
test('custody and regulated intermediary independently required',()=>{const f=fixture();f.partners=f.partners.filter(p=>p.role==='custodian');assert.equal(evaluate(f).allowed,false);});
test('CoreG custody forbidden',()=>{const f=fixture();f.partners[0].organization='CoreG';assert.equal(evaluate(f).allowed,false);});
test('partner jurisdiction mismatch blocks',()=>{const f=fixture();f.partners[0].jurisdictions=['CA'];assert.equal(evaluate(f).allowed,false);});
test('secrets rejected',()=>{const f=fixture();f.record.details.private_key='secret';assert.equal(evaluate(f).allowed,false);});
test('stable canonical hash ignores property insertion order',()=>assert.equal(p.digest({a:1,b:2}),p.digest({b:2,a:1})));
