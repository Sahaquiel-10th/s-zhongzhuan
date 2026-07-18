ALTER TABLE usage_logs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN cache_creation_ephemeral_5m_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN cache_creation_ephemeral_1h_input_tokens INTEGER NOT NULL DEFAULT 0;

-- cached_input_tokens historically represented cache reads. Keep the explicit
-- field populated for old rows while retaining the legacy column/API alias.
UPDATE usage_logs SET cache_read_input_tokens = cached_input_tokens;
