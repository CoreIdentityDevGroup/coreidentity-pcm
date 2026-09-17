'use strict';
function assertConfiguration(env=process.env){
 if(env.NODE_ENV!=='production')return;
 const required=['PCM_IDP_ISSUER','PCM_IDP_AUDIENCE','PCM_MALWARE_SCANNER_URL','PCM_MALWARE_SCANNER_TOKEN','PCM_BUCKET_KYC_VAULT','PCM_BUCKET_ASSET_DOCS','PCM_VAULT_KMS_KEY','PCM_KYC_KMS_KEY','PCM_VAULT_RETENTION_SECONDS','SENTINEL_JWT_SECRET','SENTINEL_URL'];
 const missing=required.filter(k=>!env[k]);
 if(!env.PCM_IDP_PUBLIC_KEY&&!env.PCM_IDP_JWKS_URL)missing.push('PCM_IDP_PUBLIC_KEY or PCM_IDP_JWKS_URL');
 if(env.PCM_IDP_JWKS_URL&&new URL(env.PCM_IDP_JWKS_URL).protocol!=='https:')throw Error('PCM_IDP_JWKS_URL requires HTTPS');
 if(env.PCM_INSTITUTIONAL_CUTOVER!=='approved')missing.push('PCM_INSTITUTIONAL_CUTOVER');
 if(missing.length)throw Error('Institutional production cutover blocked; missing configuration: '+missing.join(', '));
 for(const key of ['PCM_IDP_ISSUER','PCM_MALWARE_SCANNER_URL','SENTINEL_URL'])if(new URL(env[key]).protocol!=='https:')throw Error(key+' requires HTTPS');
 if(env.PCM_KYC_KMS_KEY===env.PCM_VAULT_KMS_KEY||env.PCM_BUCKET_KYC_VAULT===env.PCM_BUCKET_ASSET_DOCS)throw Error('KYC storage and encryption keys must be segregated');
}
module.exports={assertConfiguration};
