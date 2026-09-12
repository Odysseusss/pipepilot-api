BEGIN;

ALTER TABLE app_accounts
  ADD COLUMN IF NOT EXISTS mailerlite_subscriber_id TEXT;

COMMIT;
