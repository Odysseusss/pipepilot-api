BEGIN;

CREATE TABLE IF NOT EXISTS app_accounts (
  id BIGSERIAL PRIMARY KEY,
  auth_subject TEXT NOT NULL UNIQUE,
  normalized_email TEXT NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_accounts_normalized_email_idx
  ON app_accounts (normalized_email);

CREATE TABLE IF NOT EXISTS app_entitlements (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL UNIQUE REFERENCES app_accounts(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'annual_full')),
  status TEXT NOT NULL DEFAULT 'free',
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  paid_through TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  synchronized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_app_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  result TEXT
);

CREATE TABLE IF NOT EXISTS account_audit_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES app_accounts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
