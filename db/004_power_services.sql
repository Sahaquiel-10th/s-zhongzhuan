ALTER TABLE model_routes ADD COLUMN service_mode TEXT NOT NULL DEFAULT 'self_service'
  CHECK (service_mode IN ('managed', 'self_service'));
ALTER TABLE model_routes ADD COLUMN customer_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (customer_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN customer_cached_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (customer_cached_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN customer_output_power_per_million REAL NOT NULL DEFAULT 0 CHECK (customer_output_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN reference_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (reference_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN reference_cached_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (reference_cached_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN reference_output_power_per_million REAL NOT NULL DEFAULT 0 CHECK (reference_output_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN upstream_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (upstream_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN upstream_cached_input_power_per_million REAL NOT NULL DEFAULT 0 CHECK (upstream_cached_input_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN upstream_output_power_per_million REAL NOT NULL DEFAULT 0 CHECK (upstream_output_power_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN pricing_version INTEGER NOT NULL DEFAULT 1 CHECK (pricing_version > 0);
ALTER TABLE model_routes ADD COLUMN pricing_label TEXT NOT NULL DEFAULT '当前价格';
ALTER TABLE model_routes ADD COLUMN pricing_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE model_routes
   SET reference_input_power_per_million = official_input_cny_per_million,
       reference_cached_input_power_per_million = official_cached_input_cny_per_million,
       reference_output_power_per_million = official_output_cny_per_million,
       customer_input_power_per_million = official_input_cny_per_million * (SELECT customer_discount FROM platform_settings WHERE id = 1),
       customer_cached_input_power_per_million = official_cached_input_cny_per_million * (SELECT customer_discount FROM platform_settings WHERE id = 1),
       customer_output_power_per_million = official_output_cny_per_million * (SELECT customer_discount FROM platform_settings WHERE id = 1);

ALTER TABLE customer_api_keys ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'self_service'
  CHECK (access_mode IN ('managed', 'self_service'));
ALTER TABLE customer_api_keys ADD COLUMN managed_route_id TEXT REFERENCES model_routes(id) ON DELETE SET NULL;

ALTER TABLE usage_logs ADD COLUMN service_mode TEXT;
ALTER TABLE usage_logs ADD COLUMN pricing_version_snapshot INTEGER;
ALTER TABLE usage_logs ADD COLUMN pricing_label_snapshot TEXT;
ALTER TABLE usage_logs ADD COLUMN customer_input_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN customer_cached_input_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN customer_output_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN reference_input_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN reference_cached_input_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN reference_output_power_price REAL;
ALTER TABLE usage_logs ADD COLUMN effective_billing_factor REAL;

CREATE TABLE pricing_notifications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES model_routes(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'pricing_changed' CHECK (type IN ('pricing_changed', 'announcement')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pricing_version INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notification_reads (
  notification_id TEXT NOT NULL REFERENCES pricing_notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX idx_notifications_tenant_created ON pricing_notifications(tenant_id, created_at DESC);

ALTER TABLE recharge_orders RENAME TO recharge_orders_legacy;

CREATE TABLE recharge_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_power_micros INTEGER NOT NULL CHECK (requested_power_micros > 0),
  amount_cny REAL,
  credited_micros INTEGER NOT NULL DEFAULT 0 CHECK (credited_micros >= 0),
  settlement_cny_per_power REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  payment_channel TEXT NOT NULL DEFAULT 'manual',
  external_order_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

INSERT INTO recharge_orders (
  id, tenant_id, requested_power_micros, amount_cny, credited_micros, status,
  payment_channel, external_order_id, created_at, paid_at
)
SELECT id, tenant_id, MAX(1, credited_micros), amount_cny, credited_micros, status,
       payment_channel, external_order_id, created_at, paid_at
  FROM recharge_orders_legacy;

DROP TABLE recharge_orders_legacy;
