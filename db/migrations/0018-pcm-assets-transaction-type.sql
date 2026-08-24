-- Adds transaction_type to pcm_assets (2026-08-24). The transaction-
-- centric system (pcm_transactions/pcm_transaction_stages) is retired --
-- this is asset-centric only, going forward. Run against the pcm_assets
-- database.
--
-- Vocabulary reused verbatim from the retired pcm_transactions.transaction_type
-- CHECK constraint (tests/pcm_clients_schema.sql) -- same three values,
-- same meaning, just recorded on the asset instead of a separate
-- transaction row.
--
-- Crypto's specific coin is NOT a new column -- pcm_assets.asset_subtype
-- already exists and has had zero callers (no UI or route has ever
-- created or advanced an asset). For a crypto transaction_type, this is
-- exactly what that column is for.
ALTER TABLE pcm_assets
  ADD COLUMN transaction_type text
    CHECK (transaction_type IS NULL OR transaction_type = ANY (ARRAY['crypto', 'cash', 'asset']));
