'use strict';
const {createHash}=require('node:crypto');
const STAGES=['intake','kyc_verification','collateralization','appraisal_review','monetization','securitization','tokenization','completed'];
const LABELS=['Intake','KYC','Asset/Collateral','Appraisal/Valuation','Monetization','Securitization','Tokenization','Completed'];
const BASE=['ownership','authority','provenance','custody','valuation','transferability'];
const PACKAGES={
 securities:{fields:['issuer','identifier','face_value','currency','coupon','maturity','restrictions','settlement_eligibility'],checks:['issuer_confirmation','custody_confirmation','securities_review']},
 bank_instruments:{fields:['issuing_bank','advising_bank','swift_bic','amount','currency','expiry','assignment_conditions'],checks:['authenticated_bank_confirmation','assignment_review']},
 precious_metals:{fields:['weight','unit','fineness','refinery','lot_serial','origin','supplier','vault','insurance'],checks:['assay','independent_vault_confirmation','lien_search','source_of_funds','supplier_aml']},
 precious_stones:{fields:['laboratory','report_number','carat','cut','clarity','color','origin','supplier','insurance'],checks:['laboratory_confirmation','chain_of_custody','source_of_funds','supplier_aml']},
 industrial_metals:{fields:['grade','purity','quantity','unit','chemical_form','physical_form','laboratory','warehouse','origin','logistics'],checks:['assay','warehouse_confirmation','export_review','hazard_review']},
 isotopic_materials:{fields:['element','isotope','abundance_enrichment','chemical_form','physical_form','quantity','unit','laboratory','radiological_classification','hazard_classification','transport_controls','export_controls'],checks:['laboratory_confirmation','specialist_classification','transport_authorization','export_authorization']},
 rare_minerals:{fields:['mineral','grade','quantity','unit','location','permits','export_restrictions'],checks:['assay','permit_confirmation','export_review']},
 mining:{fields:['project_name','owner_issuer','jurisdiction','claim_numbers','coordinates','qualified_persons','professional_associations','independence','site_inspection','report_effective_date','report_signing_date','resource_categories','reserves','grades','commodity_assumptions','environmental_permits','royalties_encumbrances','capex_opex'],checks:['technical_report','qp_credentials','legal_title','economic_feasibility','monetization_financeability']},
 real_assets:{fields:['description','location','title_provenance','insurance'],checks:['title_confirmation','lien_search','independent_appraisal']},
 digital_assets:{fields:['chain','asset_identifier','custodian','public_address','transfer_restrictions'],checks:['control_proof','chain_forensics','custodian_confirmation','digital_regulatory_review']},
 unclassified:{fields:['description'],checks:['specialist_classification']}
};
function canonical(value) {
 if(value instanceof Date) return JSON.stringify(value.toISOString());
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const present=v=>v!==undefined && v!==null && v!=='' && (!Array.isArray(v)||v.length>0);
function validateRecord(record, schema) {
 const errors=[];
 for(const key of ['asset_family','instrument_type','transaction_structure','jurisdictions']) if(!present(record[key])) errors.push(key+' required');
 if(!Array.isArray(record.jurisdictions)||record.jurisdictions.some(x=>typeof x!=='string'||!x.trim())) errors.push('jurisdictions must be nonempty strings');
 const spec=schema || PACKAGES[record.asset_family];
 if(!spec) errors.push('Unknown asset family');
 else for(const key of spec.fields) if(!present(record.details?.[key])) errors.push('details.'+key+' required');
 if(/private.?key|password|seed.?phrase|bank.?credential|api.?secret/i.test(JSON.stringify(record))) errors.push('Secrets are prohibited in transaction records');
 return errors;
}
function validReview(review, revision, now) {
 return review && review.revision===revision && review.outcome==='approved' && typeof review.evidence_document_id==='string' &&
 review.evidence_document_id.length>0 && Number.isFinite(Date.parse(review.expires_at)) && Date.parse(review.expires_at)>now &&
 Number.isFinite(Date.parse(review.reviewed_at)) && Date.parse(review.reviewed_at)<=now &&
 review.proposed_by && review.approved_by && review.proposed_by!==review.approved_by;
}
function evaluate(record, reviews, partners, schema, now=Date.now()) {
 const blockers=[...validateRecord(record,schema),...require('./institutional-participants').gate(record,reviews,validReview,now)];
 const required=[...BASE,...(schema||PACKAGES[record.asset_family]||{checks:[]}).checks,'kyc','kyb','beneficial_ownership','aml','sanctions','regulatory_classification','permitted_activity','permitted_compensation'];
 for(const check of required) if(!validReview(reviews[check],record.revision,now)) blockers.push(check+': current independent evidence approval required');
 const sanctions=reviews.sanctions;
 if(sanctions && (now-Date.parse(sanctions.reviewed_at)>86400000 || Date.parse(sanctions.expires_at)-Date.parse(sanctions.reviewed_at)>86400000)) blockers.push('Sanctions evidence must be renewed within 24 hours');
 const regulation=record.regulatory;
 if(!regulation || !present(regulation.classification) || !present(regulation.permitted_activity) || !present(regulation.permitted_compensation) || typeof regulation.partner_required!=='boolean') blockers.push('Regulatory determination incomplete');
 if(record.asset_family==='unclassified') blockers.push('Unclassified assets cannot monetize or match');
 // Restricted material processing stays stopped even after a specialist review.
 if(record.asset_family==='isotopic_materials' && (record.details?.radiological_classification!=='stable_nonradioactive' || record.details?.hazard_classification!=='nonhazardous')) blockers.push('Restricted or unclassified isotopic material: specialist-only hold');
 if(!Array.isArray(partners)||!partners.length) blockers.push('Independent custody partner required');
 else {
  if(!partners.some(p=>p.role==='custodian' && p.organization!=='CoreG')) blockers.push('CoreG cannot act as custodian');
  if(regulation?.partner_required && !partners.some(p=>p.role==='regulated_intermediary')) blockers.push('Regulated intermediary required');
  for(const p of partners) {
   if(!validReview(p,record.revision,now) || !p.organization || !p.license_reference || !Array.isArray(p.jurisdictions) || !record.jurisdictions?.every(j=>p.jurisdictions.includes(j))) blockers.push('Partner license, scope, jurisdiction or verification incomplete');
  }
 }
 return {allowed:blockers.length===0,blockers,revision:record.revision,record_hash:digest(record)};
}
module.exports={STAGES,LABELS,PACKAGES,BASE,canonical,digest,validateRecord,validReview,evaluate};
