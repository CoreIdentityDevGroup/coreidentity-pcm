/**
 * CoreIdentity PCM — Agent Base Utilities
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

export function loadManifest(importMetaUrl) {
  const dir = dirname(fileURLToPath(importMetaUrl));
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

export function buildContext(overrides = {}) {
  return {
    trace_id:    crypto.randomUUID(),
    environment: process.env.NODE_ENV || 'development',
    vertical:    'private_capital_markets',
    timestamp:   new Date().toISOString(),
    ...overrides
  };
}
