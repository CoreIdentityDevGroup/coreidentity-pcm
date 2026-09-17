'use strict';
const jwt=require('jsonwebtoken');
async function authenticate(req,res,next){
 try {
  if(!req.headers.authorization?.startsWith('Bearer ')) return res.status(401).json({error:'Bearer token required'});
  const token=req.headers.authorization.slice(7);
  let decoded;
  if(req.originalUrl.startsWith('/api/v2/institutional')){
   decoded=await require('../services/institutional-identity').verify(token);
  }else{
   if(!process.env.JWT_SECRET)throw Error('JWT_SECRET not configured');
   decoded=jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});
  }
  req.user=decoded;next();
 }catch(e){if(e.status)return res.status(e.status).json({error:e.message});if(['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(e.name))return res.status(401).json({error:'Invalid or expired token'});next(e);}
}
module.exports={authenticate};
