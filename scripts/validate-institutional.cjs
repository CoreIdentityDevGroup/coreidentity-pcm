'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
for(const dir of ['api/services','api/routes','api/middleware'])for(const name of fs.readdirSync(dir))if(name.endsWith('.js'))execFileSync(process.execPath,['--check',path.join(dir,name)],{stdio:'pipe'});
const p=require('../api/services/institutional-policy');if(p.STAGES.length!==8||new Set(p.STAGES).size!==8)throw Error('Invalid canonical lifecycle');
for(const [family,schema]of Object.entries(p.PACKAGES)){if(!schema.fields.length||!schema.checks.length)throw Error('Incomplete package '+family);}
console.log('Institutional source syntax, canonical lifecycle and package definitions validated');
