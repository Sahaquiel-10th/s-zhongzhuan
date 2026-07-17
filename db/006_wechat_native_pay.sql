ALTER TABLE platform_settings ADD COLUMN recharge_cny_per_power REAL NOT NULL DEFAULT 7
  CHECK (recharge_cny_per_power > 0);

CREATE TABLE wechat_pay_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  recharge_order_id TEXT NOT NULL UNIQUE REFERENCES recharge_orders(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  out_trade_no TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  mch_id TEXT NOT NULL,
  requested_power_micros INTEGER NOT NULL CHECK (requested_power_micros > 0),
  cny_per_power_snapshot REAL NOT NULL CHECK (cny_per_power_snapshot > 0),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  code_url TEXT,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'pending', 'paid', 'expired', 'failed', 'closed')),
  wechat_transaction_id TEXT UNIQUE,
  failure_code TEXT,
  failure_message TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE INDEX idx_wechat_pay_tenant_created ON wechat_pay_orders(tenant_id, created_at DESC);
CREATE INDEX idx_wechat_pay_status_expires ON wechat_pay_orders(status, expires_at);
CREATE UNIQUE INDEX idx_ledger_recharge_reference_unique
  ON ledger_entries(reference_id) WHERE type = 'recharge';
