ALTER TABLE tenants ADD COLUMN balance_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_micros >= 0);
ALTER TABLE tenants ADD COLUMN reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0);

UPDATE tenants
   SET balance_micros = ROUND(balance_power * 1000000.0 / (SELECT power_per_cny FROM platform_settings WHERE id = 1)),
       reserved_micros = ROUND(reserved_power * 1000000.0 / (SELECT power_per_cny FROM platform_settings WHERE id = 1));

ALTER TABLE platform_settings ADD COLUMN customer_discount REAL NOT NULL DEFAULT 0.8
  CHECK (customer_discount > 0 AND customer_discount <= 1);

UPDATE platform_settings
   SET customer_discount = COALESCE((SELECT billing_factor FROM pricing_versions WHERE active = 1 LIMIT 1), 0.8)
 WHERE id = 1;

ALTER TABLE model_routes ADD COLUMN official_input_cny_per_million REAL NOT NULL DEFAULT 35 CHECK (official_input_cny_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN official_cached_input_cny_per_million REAL NOT NULL DEFAULT 3.5 CHECK (official_cached_input_cny_per_million >= 0);
ALTER TABLE model_routes ADD COLUMN official_output_cny_per_million REAL NOT NULL DEFAULT 210 CHECK (official_output_cny_per_million >= 0);

ALTER TABLE usage_logs ADD COLUMN official_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN charged_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN customer_discount REAL NOT NULL DEFAULT 1;
ALTER TABLE usage_logs ADD COLUMN official_input_price REAL;
ALTER TABLE usage_logs ADD COLUMN official_cached_input_price REAL;
ALTER TABLE usage_logs ADD COLUMN official_output_price REAL;

ALTER TABLE ledger_entries ADD COLUMN amount_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries ADD COLUMN balance_before_micros INTEGER;
ALTER TABLE ledger_entries ADD COLUMN balance_after_micros INTEGER;

ALTER TABLE recharge_orders ADD COLUMN credited_micros INTEGER NOT NULL DEFAULT 0;
UPDATE recharge_orders SET credited_micros = ROUND(amount_cny * 1000000);
