'use strict';
const jwt=require('jsonwebtoken'),{createPublicKey}=require('node:crypto');
let cached=null,loading=null,lastAttempt=0;
function unavailable(){return Object.assign(new Error('Institutional identity provider unavailable'),{status:503});}
async function fetchKeys(env=process.env){
 const url=env.PCM_IDP_JWKS_URL;
 if(!url||new URL(url).protocol!=='https:'||new URL(url).username||new URL(url).password)throw unavailable();
 const now=Date.now();if(cached?.url===url&&cached.expires>now)return cached.keys;
 if(loading)return loading;
 if(now-lastAttempt<1000)throw unavailable();lastAttempt=now;
 loading=(async()=>{
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw unavailable();
  let raw='',size=0;for await(const chunk of r.body){size+=chunk.length;if(size>524288)throw unavailable();raw+=Buffer.from(chunk).toString('utf8');}
  const data=JSON.parse(raw);if(!Array.isArray(data.keys)||data.keys.length>50)throw unavailable();
  const keys=new Map();for(const k of data.keys){
   if(k.kty!=='RSA'||(k.use&&k.use!=='sig')||(k.alg&&k.alg!=='RS256')||(k.key_ops&&!k.key_ops.includes('verify')))continue;
   if(typeof k.kid!=='string'||!k.kid||keys.has(k.kid)||k.d)throw unavailable();
   const key=createPublicKey({key:k,format:'jwk'});if(key.asymmetricKeyDetails?.modulusLength<2048)throw unavailable();keys.set(k.kid,key);
  }
  if(!keys.size)throw unavailable();cached={url,keys,expires:Date.now()+60000};return keys;
 })();try{return await loading;}catch{throw unavailable();}finally{loading=null;}
}
async function verify(token,env=process.env){
 if(!env.PCM_IDP_ISSUER||!env.PCM_IDP_AUDIENCE)throw unavailable();
 let key=env.PCM_IDP_PUBLIC_KEY;
 if(env.PCM_IDP_JWKS_URL){
  const parsed=jwt.decode(token,{complete:true});if(parsed?.header.alg!=='RS256'||typeof parsed.header.kid!=='string')throw new jwt.JsonWebTokenError('Invalid key header');
  key=(await fetchKeys(env)).get(parsed.header.kid);if(!key)throw new jwt.JsonWebTokenError('Unknown signing key');
 }
 if(!key)throw unavailable();
 const claims=jwt.verify(token,key,{algorithms:['RS256'],issuer:env.PCM_IDP_ISSUER,audience:env.PCM_IDP_AUDIENCE});
 if(!Number.isFinite(claims.exp)||typeof claims.sub!=='string'||!claims.sub||!Number.isFinite(claims.auth_time)||claims.auth_time>Date.now()/1000+30||Date.now()/1000-claims.auth_time>3600||!Array.isArray(claims.amr)||!claims.amr.includes('mfa'))throw Object.assign(new Error('Recent verified MFA required'),{status:403});
 return claims;
}
module.exports={verify,fetchKeys};
