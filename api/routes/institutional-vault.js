'use strict';
const router=require('express').Router(),multer=require('multer');
const store=require('../services/institutional-store'),vault=require('../services/institutional-vault');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20971520,files:1,fields:3}});
const run=fn=>async(req,res,next)=>{try{const result=await store.transaction(c=>fn(c,req));res.set('Cache-Control','no-store').json(result);}catch(e){if(e.status)res.status(e.status).json({error:e.message});else next(e);}};
router.post('/:id/documents',upload.single('file'),run(async(c,req)=>{
 const row=await store.record(c,req.params.id,req.user,['intermediary','compliance','legal','verifier','admin']);
 if(['kyc','kyb','pof'].includes(req.body.category))await store.membership(c,req.user,row.tenant_id,['compliance','legal']);
 return vault.upload(c,row,req.user,req.file,req.body.category,req.body.document_key);
}));
router.get('/:id/documents/:documentId/download',run(async(c,req)=>{const row=await store.record(c,req.params.id,req.user,['client','intermediary','compliance','legal','verifier','admin','auditor']);return vault.signedDownload(c,row,req.user,req.params.documentId);}));
module.exports=router;
