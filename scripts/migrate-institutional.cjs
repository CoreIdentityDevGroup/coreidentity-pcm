'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');const {Client}=require('pg');
(async()=>{
 const root=path.resolve(__dirname,'..');
 if(process.env.PCM_MIGRATION_APPROVED!=='yes'||!process.env.PCM_MIGRATION_DATABASE_URL)throw Error('Explicit migration approval flag and administrator database URL required');
 const c=new Client({connectionString:process.env.PCM_MIGRATION_DATABASE_URL,ssl:{rejectUnauthorized:true,...(process.env.PCM_DB_CA_PEM?{ca:process.env.PCM_DB_CA_PEM}:{})}});
 await c.connect();try{
  const who=await c.query('SELECT current_user AS name');if(who.rows[0].name==='pcm_app')throw Error('Independent administrator required');
  for(const name of ['0026-institutional-foundation.sql','0027-institutional-history-isolation.sql','0028-institutional-row-policies.sql','0029-institutional-package-seeds.sql','0030-institutional-legacy-lock.sql','0031-institutional-four-eyes-changes.sql','0032-institutional-integrity-agent.sql'])await c.query(fs.readFileSync(path.join(root,'db/migrations',name),'utf8'));
 }finally{await c.end();}
 execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
})().catch(e=>{console.error('Migration failed:',e.message);process.exitCode=1;});
