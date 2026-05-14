-- 004_smm_refund_unique.sql
-- Defense-in-depth: at most one refund per video. If a race condition
-- ever causes two concurrent refunds to slip past the application-level
-- idempotency check, the DB will reject the second INSERT with a
-- unique-violation error.
CREATE UNIQUE INDEX IF NOT EXISTS uq_smm_ledger_refund_per_video
  ON smm_billing_ledger (video_id)
  WHERE op = 'refund';
