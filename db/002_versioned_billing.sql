CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  power_per_cny INTEGER NOT NULL DEFAULT 1000 CHECK (power_per_cny > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO platform_settings (id, power_per_cny) VALUES (1, 1000);

CREATE TABLE IF NOT EXISTS pricing_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  version INTEGER NOT NULL UNIQUE,
  reference_input_cny_per_million REAL NOT NULL DEFAULT 35,
  reference_output_cny_per_million REAL NOT NULL DEFAULT 210,
  customer_input_cny_per_million REAL NOT NULL,
  customer_output_cny_per_million REAL NOT NULL,
  billing_factor REAL NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO pricing_versions (
  version,
  customer_input_cny_per_million,
  customer_output_cny_per_million,
  billing_factor,
  label,
  active
) VALUES (1, 28, 168, 0.8, '优惠期', 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_one_active ON pricing_versions(active) WHERE active = 1;

ALTER TABLE usage_logs ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN billable_input_tokens REAL NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN base_power INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN rated_power INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN billing_factor REAL NOT NULL DEFAULT 1;
ALTER TABLE usage_logs ADD COLUMN pricing_version INTEGER;
ALTER TABLE usage_logs ADD COLUMN reference_input_cny_per_million REAL;
ALTER TABLE usage_logs ADD COLUMN reference_output_cny_per_million REAL;
ALTER TABLE usage_logs ADD COLUMN customer_input_cny_per_million REAL;
ALTER TABLE usage_logs ADD COLUMN customer_output_cny_per_million REAL;
ALTER TABLE usage_logs ADD COLUMN pricing_label TEXT;
ALTER TABLE usage_logs ADD COLUMN metadata_json TEXT;

ALTER TABLE ledger_entries ADD COLUMN balance_before INTEGER;
ALTER TABLE ledger_entries ADD COLUMN balance_after INTEGER;
