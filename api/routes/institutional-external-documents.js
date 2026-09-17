'use strict';
const router=require('express').Router(),store=require('../services/institutional-store'),external=require('../services/institutional-external-documents');
// All external metadata, including identity document references, is restricted to compliance/legal.
const run=fn=>async(req,res,next)=>{res.set('Cache-Control','no-store');try{res.json(await store.transaction(async c=>{const row=await store.record(c,req.params.id,req.user,['compliance','legal']);return fn(c,row,req);}));}catch(e){if(e.status)res.status(e.status).json({error:e.message});else next(e);}};
router.get('/:id/external-documents',run(async(c,row,req)=>{const documents=external.project(await external.history(c,row),row.revision);await store.event(c,row,req.user,'external_documents_viewed',{});return {documents};}));
router.post('/:id/external-documents',run((c,row,req)=>external.register(c,row,req.user,req.body,store.event)));
router.post('/:id/external-documents/:documentId/review',run((c,row,req)=>external.review(c,row,req.user,req.params.documentId,req.body,store.event)));
module.exports=router;
