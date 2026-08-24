-- Retire the transaction-centric system (2026-08-24). Todd's decision:
-- asset-centric only. Both tables confirmed empty live before this
-- migration was written: pcm_transactions 0 rows, pcm_transaction_stages
-- 0 rows, pcm_documents.transaction_id 0 non-null rows (pcm_documents
-- itself 0 rows). Run against the pcm_clients database (all three
-- objects live there).
--
-- Order matters for FK dependency: pcm_transaction_stages references
-- pcm_transactions, and pcm_documents.transaction_id references
-- pcm_transactions -- both must go before the table they point at.
-- Dropping the column takes its own FK constraint and index
-- (idx_pcm_documents_transaction) with it; no separate DROP CONSTRAINT/
-- DROP INDEX needed.
--
-- pcm_transactions itself held outbound FKs to pcm_asset_backings,
-- pcm_asset_types, pcm_banks, pcm_securities_instruments -- those
-- reference tables are untouched by this migration (the FK direction is
-- transactions -> references, not the reverse); Phase B wires them to
-- pcm_assets instead.
--
-- api/routes/documents.js updated in the same commit to stop
-- reading/writing transaction_id -- it was the one live route still
-- referencing the column (client_id-only lookups now, its only real
-- caller before this session already went away with
-- TransactionDocuments.jsx).
--
-- Wrapped in an explicit transaction (added 2026-08-24, after 0012's two
-- failed attempts against prod exposed the risk): without BEGIN/COMMIT,
-- each DROP/ALTER here autocommits individually, so a failure on the
-- second or third statement would leave the first one permanently
-- applied -- a genuinely partial, hand-fix-required state. Wrapping
-- means any failure rolls back everything, since DDL is transactional
-- in Postgres.
BEGIN;

DROP TABLE pcm_transaction_stages;
ALTER TABLE pcm_documents DROP COLUMN transaction_id;
DROP TABLE pcm_transactions;

COMMIT;
