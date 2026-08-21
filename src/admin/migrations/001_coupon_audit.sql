-- Кто создал купон, кто его менял и кто удалил.
--
-- До этого не сохранялось ничего: `coupons` не знала автора, а удаление было
-- голым DELETE. 20.08.2026 из-за этого не удалось выяснить ни происхождение
-- купона id=4 (по нему один пользователь получил 3 000 000 токенов вместо
-- 1 000 000), ни кто стёр раздачи 37–39 по 5 000 000 — строки исчезли, а
-- coupon_redemptions осталась ссылаться в пустоту.
--
-- Снимок в аудите (code, token_amount, usage_count) делает историю удалённого
-- купона восстановимой: сам купон уходит, а чем он был — остаётся.

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS created_by text;

CREATE TABLE IF NOT EXISTS coupon_audit (
  id           serial PRIMARY KEY,
  coupon_id    integer,
  code         text NOT NULL,
  action       text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  actor        text,
  token_amount bigint,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_audit_coupon
  ON coupon_audit (coupon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coupon_audit_created
  ON coupon_audit (created_at DESC);
