-- Перенос прошлых оплат в историю пополнений.
--
-- До 2026-08-08 начисления шли прямым `tokens = tokens + N` мимо
-- add_user_tokens и следа в token_transactions не оставляли: в таблице было
-- 29 840 списаний и ноль покупок. Пользователь видел, как токены тают, но не
-- мог узнать, когда и откуда они пришли.
--
-- balance_after у перенесённых строк выставлен в 0 и помечен в метаданных как
-- reconstructed. Восстановить его нельзя: последовательность списаний между
-- оплатами известна не полностью, а выдуманное число выглядело бы как факт.
-- Эндпоинт истории по этому признаку отдаёт balanceAfter = null, и фронт
-- остаток за такие строки не показывает.
INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
SELECT p.user_id,
       'purchase',
       p.tokens,
       0,
       'Пополнение: ' || COALESCE(p.package_id, 'пакет'),
       jsonb_build_object(
         'payment_id',    p.payment_id,
         'provider',      COALESCE(p.provider, 'yookassa'),
         'amount',        p.amount,
         'currency',      COALESCE(p.currency, 'RUB'),
         'reconstructed', true
       ),
       COALESCE(p.completed_at, p.updated_at, p.created_at)
FROM payments p
WHERE p.status = 'succeeded'
  -- Идемпотентность: не дублируем то, что уже записано процедурой.
  AND NOT EXISTS (
    SELECT 1 FROM token_transactions t
     WHERE t.user_id = p.user_id
       AND t.transaction_type = 'purchase'
       AND t.metadata->>'payment_id' = p.payment_id
  );

-- Купоны — тем же порядком.
INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
SELECT r.user_id,
       'coupon',
       r.tokens_granted,
       0,
       'Промокод',
       jsonb_build_object('coupon_id', r.coupon_id, 'reconstructed', true),
       r.redeemed_at
FROM coupon_redemptions r
WHERE NOT EXISTS (
    SELECT 1 FROM token_transactions t
     WHERE t.user_id = r.user_id
       AND t.transaction_type = 'coupon'
       AND (t.metadata->>'coupon_id')::int = r.coupon_id
  );
