'use strict';
const requiredTables=['memberships','schemas','records','reviews','partners','documents','events','manifests','record_versions','transaction_access','legacy_locks','change_proposals','integrity_screenings'];
async function database(c){
 const role=(await c.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(!role||role.name!=='pcm_app'||role.rolsuper||role.rolbypassrls)throw Error('Runtime database role must be nonprivileged pcm_app');
 const owned=await c.query("SELECT 1 FROM pg_tables WHERE schemaname='institutional' AND tableowner=current_user");if(owned.rows.length)throw Error('Runtime must not own institutional tables');
 const rows=(await c.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='institutional' AND c.relkind='r'")).rows;
 for(const name of requiredTables)if(!rows.some(r=>r.relname===name))throw Error('Required institutional migration missing');
 for(const name of ['records','reviews','partners','documents','events','manifests','record_versions','change_proposals','integrity_screenings']){const row=rows.find(r=>r.relname===name);if(!row.relrowsecurity||!row.relforcerowsecurity)throw Error('Required row isolation is not enforced');}
 const triggers=(await c.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='institutional.integrity_screenings'::regclass AND NOT tgisinternal")).rows;
 if(!triggers.some(t=>t.tgname==='immutable_integrity_screenings'&&['O','A'].includes(t.tgenabled)))throw Error('Integrity evidence immutability missing');
 return {database_role:'restricted',migrations:'present',row_isolation:'enforced'};
}
async function check(){
 require('./institutional-config').assertConfiguration({...process.env,NODE_ENV:'production'});
 const db=require('./db');const connection=await db.assets.connect();let evidence;
 try{evidence=await database(connection);}finally{connection.release();}
 const vault=require('./institutional-vault');await vault.inspectBucket('kyc');await vault.inspectBucket('asset');
 if(process.env.PCM_IDP_JWKS_URL)await require('./institutional-identity').fetchKeys();
 return {...evidence,vault_configuration:'verified',checked_at:new Date().toISOString()};
}
module.exports={database,check,requiredTables};
