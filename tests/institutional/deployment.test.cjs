'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('production deploy is manual and cannot trigger on a main push',()=>{const source=fs.readFileSync(path.join(__dirname,'../../.github/workflows/deploy-pcm-api.yml'),'utf8');assert.ok(source.includes('  workflow_dispatch:'));assert.doesNotMatch(source,/^  push:/m);assert.ok(source.includes('python3 scripts/ci-institutional-preflight.py'));});
