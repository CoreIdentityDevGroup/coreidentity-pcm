// Phase 6.1 (SCRUB): points every DB pool at the isolated local test
// database (schema-dumped from live production, zero production data)
// instead of the real RDS instance. Loaded via jest's `setupFiles`,
// which runs before any test file (and therefore before api/services/db.js
// creates its Pool objects) so these env vars are in place at require time.
//
// SENTINEL_JWT_SECRET is deliberately left UNSET -- this is what makes
// the "Sentinel unavailable" test case real rather than mocked: with no
// secret, mintSentinelToken() throws, sentinelCheck() catches it and
// returns BLOCK_SENTINEL_UNAVAILABLE, exactly the real code path a
// production Sentinel outage would hit.
'use strict';

process.env.NODE_ENV = 'test';
process.env.PCM_DB_CLIENT_HOST = '127.0.0.1';
process.env.PCM_DB_CLIENT_PORT = '15433';
process.env.PCM_DB_CLIENT_NAME = 'pcm_clients';
process.env.PCM_DB_CLIENT_USER = 'pcm_app';
process.env.PCM_DB_CLIENT_PASSWORD = 'localtest';

process.env.PCM_DB_ASSET_HOST = '127.0.0.1';
process.env.PCM_DB_ASSET_PORT = '15433';
process.env.PCM_DB_ASSET_NAME = 'pcm_assets';
process.env.PCM_DB_ASSET_USER = 'pcm_app';
process.env.PCM_DB_ASSET_PASSWORD = 'localtest';

process.env.PCM_DB_FORMS_HOST = '127.0.0.1';
process.env.PCM_DB_FORMS_PORT = '15433';
process.env.PCM_DB_FORMS_NAME = 'pcm_forms';
process.env.PCM_DB_FORMS_USER = 'pcm_app';
process.env.PCM_DB_FORMS_PASSWORD = 'localtest';

process.env.PCM_DB_PEHF_HOST = '127.0.0.1';
process.env.PCM_DB_PEHF_PORT = '15433';
process.env.PCM_DB_PEHF_NAME = 'pcm_pehf';
process.env.PCM_DB_PEHF_USER = 'pcm_app';
process.env.PCM_DB_PEHF_PASSWORD = 'localtest';

process.env.JWT_SECRET = 'test-jwt-secret-not-a-real-secret';
delete process.env.SENTINEL_JWT_SECRET;
delete process.env.SENTINEL_URL;
