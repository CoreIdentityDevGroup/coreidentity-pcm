#!/usr/bin/env bash
# Sets up the isolated local Postgres this test suite expects (see
# env.setup.js: 127.0.0.1:15433, user/db pcm_app, password localtest).
#
# Previously this schema-dump step didn't exist anywhere in the repo --
# tests/env.setup.js's own comment claims "real schema, zero production
# data" but there was no script that actually produced that locally, and
# 3 of 4 test files couldn't run in a fresh checkout as a result (only
# pcm_clients existed; pcm_assets/pcm_forms/pcm_pehf did not). Fixed
# 2026-08-17 while adding the password-reset tests -- this script plus the
# four tests/pcm_*_schema.sql dumps (schema-only, --no-owner
# --no-privileges, zero rows) close that gap for the next person.
#
# Requires: docker, and read access to the real RDS instance to refresh
# the schema dumps (only needed when the schema changes -- the checked-in
# .sql files are enough to just run tests).
set -euo pipefail

docker rm -f pcm-test-db >/dev/null 2>&1 || true
docker run -d --name pcm-test-db -p 15433:5432 \
  -e POSTGRES_USER=pcm_app -e POSTGRES_PASSWORD=localtest -e POSTGRES_DB=pcm_clients \
  postgres:15-alpine >/dev/null

echo "waiting for postgres..."
until docker exec pcm-test-db pg_isready -U pcm_app >/dev/null 2>&1; do sleep 1; done

export PGPASSWORD=localtest
psql -h 127.0.0.1 -p 15433 -U pcm_app -d pcm_clients -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
psql -h 127.0.0.1 -p 15433 -U pcm_app -d pcm_clients -f "$(dirname "$0")/pcm_clients_schema.sql"

for db in pcm_assets pcm_forms pcm_pehf; do
  psql -h 127.0.0.1 -p 15433 -U pcm_app -d pcm_clients -c "CREATE DATABASE $db;"
  psql -h 127.0.0.1 -p 15433 -U pcm_app -d "$db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
  psql -h 127.0.0.1 -p 15433 -U pcm_app -d "$db" -f "$(dirname "$0")/${db}_schema.sql"
done

echo "done -- run: npm test"
