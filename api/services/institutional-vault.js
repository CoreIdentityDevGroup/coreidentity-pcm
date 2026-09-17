'use strict';
const {Storage}=require('@google-cloud/storage');
const {randomUUID,createHash}=require('node:crypto');
const store=require('./institutional-store');
const storage=new Storage({projectId:process.env.GCP_PROJECT_ID});
function detect(buffer){
 if(buffer.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
 if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'image/jpeg';
 throw store.fault(415,'Only PDF, PNG and JPEG with recognized file signatures accepted');
}
async function inspectBucket(category){
 const pii=['kyc','kyb','pof'].includes(category);
 const name=pii?process.env.PCM_BUCKET_KYC_VAULT:process.env.PCM_BUCKET_ASSET_DOCS;
 if(!name||!process.env.PCM_VAULT_KMS_KEY||!process.env.PCM_KYC_KMS_KEY||process.env.PCM_KYC_KMS_KEY===process.env.PCM_VAULT_KMS_KEY)throw store.fault(503,'Distinct configured KYC and document encryption keys required');
 const bucket=storage.bucket(name);const [metadata]=await bucket.getMetadata();
 const key=pii?process.env.PCM_KYC_KMS_KEY:process.env.PCM_VAULT_KMS_KEY;
 if(metadata.iamConfiguration?.publicAccessPrevention!=='enforced'||metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled!==true||metadata.versioning?.enabled!==true||metadata.retentionPolicy?.isLocked!==true||metadata.encryption?.defaultKmsKeyName!==key)throw store.fault(503,'Vault privacy, versioning, locked retention or KMS evidence missing');
 const required=Number(process.env.PCM_VAULT_RETENTION_SECONDS);
 if(!Number.isSafeInteger(required)||required<1||Number(metadata.retentionPolicy.retentionPeriod)<required)throw store.fault(503,'Approved retention policy not configured or not met');
 return {bucket,key};
}
async function scan(buffer,mime){
 const url=process.env.PCM_MALWARE_SCANNER_URL, token=process.env.PCM_MALWARE_SCANNER_TOKEN;
 if(!url||!token||new URL(url).protocol!=='https:')throw store.fault(503,'Authenticated malware scanner not configured');
 const sha256=createHash('sha256').update(buffer).digest('hex');
 const response=await fetch(url,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':mime,'X-Content-SHA256':sha256},body:buffer,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw store.fault(503,'Malware scanner unavailable');
 const result=await response.json();
 if(result.status!=='clean'||result.sha256!==sha256||typeof result.reference!=='string'||!result.reference||typeof result.provider!=='string'||!result.provider)throw store.fault(422,'File not independently confirmed clean');
 return {...result,sha256};
}
async function upload(c,row,user,file,category,documentKey){
 if(!file?.buffer?.length||file.buffer.length>20971520)throw store.fault(400,'File between 1 byte and 20 MiB required');
 if(!['kyc','kyb','pof','asset','agreement','settlement','closing'].includes(category)||typeof documentKey!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(documentKey))throw store.fault(400,'Known category and stable document key required');
 const mime=detect(file.buffer);if(mime!==file.mimetype)throw store.fault(415,'Declared file type does not match contents');
 const checked=await scan(file.buffer,mime);
 const {bucket,key}=await inspectBucket(category);
 const id=randomUUID(),objectPath='institutional/'+row.tenant_id+'/'+row.asset_id+'/'+id;
 const object=bucket.file(objectPath);
 // Retention plus a temporary hold prevents lifecycle deletion even after minimum retention.
 await object.save(file.buffer,{resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},kmsKeyName:key,metadata:{contentType:mime,temporaryHold:true,metadata:{sha256:checked.sha256,scanReference:checked.reference}}});
 const [metadata]=await object.getMetadata();
 const generation=metadata.generation;
 if(!generation||metadata.temporaryHold!==true)throw store.fault(503,'Stored object generation or hold not confirmed');
 const version=await c.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM institutional.documents WHERE asset_id=$1 AND document_key=$2',[row.asset_id,documentKey]);
 // Caller holds the transaction row lock, serializing even first-version insertion.
 const result=await c.query('INSERT INTO institutional.documents(id,asset_id,document_key,version,category,storage_path,storage_generation,sha256,mime_type,size_bytes,scan_provider,scan_reference,scan_status,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,\'clean\',$13) RETURNING id,document_key,version,sha256,category',[id,row.asset_id,documentKey,version.rows[0].version,category,objectPath,generation,checked.sha256,mime,file.buffer.length,checked.provider,checked.reference,user.sub]);
 await store.event(c,row,user,'document_uploaded',{...result.rows[0],generation});return result.rows[0];
}
async function signedDownload(c,row,user,id){
 const r=await c.query('SELECT * FROM institutional.documents WHERE id=$1 AND asset_id=$2',[id,row.asset_id]);
 if(!r.rows.length)throw store.fault(404,'Document not found');
 const d=r.rows[0];
 if(['kyc','kyb','pof'].includes(d.category))await store.membership(c,user,row.tenant_id,['compliance','legal']);
 const {bucket}=await inspectBucket(d.category);
 const [url]=await bucket.file(d.storage_path,{generation:d.storage_generation}).getSignedUrl({version:'v4',action:'read',expires:Date.now()+60000,responseDisposition:'attachment',queryParams:{generation:d.storage_generation}});
 // Commit event before route exposes the capability. Storage access logs still required for actual reads.
 await store.event(c,row,user,'document_download_authorized',{document_id:id,version:d.version,generation:d.storage_generation,ttl_seconds:60});
 return {url,expires_in:60,sha256:d.sha256};
}
module.exports={detect,scan,inspectBucket,upload,signedDownload};
