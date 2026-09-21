-- Дозаливка реферальных начислений, прошедших мимо реестра токенов.
--
-- ЧТО СЛУЧИЛОСЬ. Оба начисления программы писали баланс прямым
-- `UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1` —
-- мимо add_user_tokens и мимо token_transactions. Токены на балансе есть,
-- строки движения нет. Замер на проде 21.09.2026:
--
--     referral_referees (bonus_tokens > 0)   16 строк, 320 000 токенов,
--                                            16 человек, 20.06 — 01.09.2026
--     referral_token_payouts                  0 строк,       0 токенов
--
--     из 16 человек у всех строка профиля на месте,
--     ни у одного нет в token_transactions ничего похожего
--     (совпадений по сумме в ±1 час от регистрации — ноль).
--
-- ПОЧЕМУ ВОССТАНОВИМО ТОЧНО, А НЕ ПО ОЦЕНКЕ. Сама программа вела свои журналы
-- параллельно балансу, и запись в них делалась только когда UPDATE нашёл
-- строку профиля (в register — `if (bal.rows.length)`, в payoutTokens — отказ
-- с откатом всей транзакции). То есть `referral_referees.bonus_tokens > 0` и
-- строка в `referral_token_payouts` — это не намерение начислить, а
-- свидетельство состоявшегося движения баланса: кому, сколько и когда. Ровно
-- те три поля, которых не хватает реестру.
--
-- БАЛАНС ЗДЕСЬ НЕ ТРОГАЕТСЯ НИ ОДНИМ ОПЕРАТОРОМ, и это главное. Токены УЖЕ
-- лежат у людей — расходится не баланс, а его объяснение. Позвать на этих же
-- данных add_user_tokens значило бы выдать 320 000 токенов ВТОРОЙ раз.
--
-- balance_after = 0 и metadata.reconstructed = true — по образцу дозаливки от
-- 20.08.2026 (97 строк уже лежат на проде в такой форме). Остаток на тот
-- момент восстановить нельзя, и API отдаёт по этой метке null, а не выдумку:
-- history.controller.ts, `r.metadata?.reconstructed ? null : ...`.
--
-- ИДЕМПОТЕНТНОСТЬ — на ключе, а не на факте существования файла.
--   бонус рефери: один на человека (UNIQUE referral_referees.referee_phone),
--                 ключ = user_id + metadata->>'kind';
--   выплата:      их у лидера много, ключ = metadata->>'payout_id' (id строки
--                 referral_token_payouts; боевой путь кладёт его в metadata,
--                 см. payoutTokens).
-- Повторный прогон на уже дозалитой базе вставляет ноль строк. Начисления,
-- сделанные ПОСЛЕ починки, попадают под тот же ключ и тоже пропускаются —
-- поэтому файл можно оставить в накатке навсегда.

INSERT INTO token_transactions
       (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
SELECT rr.referee_phone,
       'bonus'::transaction_type_enum,
       rr.bonus_tokens,
       0,
       'Реферальный бонус за регистрацию по приглашению',
       jsonb_build_object('kind', 'referral_referee_bonus',
                          'leader_id', rr.leader_id,
                          'reconstructed', true),
       rr.registered_at
  FROM referral_referees rr
 WHERE rr.bonus_tokens > 0
   AND NOT EXISTS (SELECT 1 FROM token_transactions t
                    WHERE t.user_id = rr.referee_phone
                      AND t.metadata->>'kind' = 'referral_referee_bonus');

INSERT INTO token_transactions
       (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
SELECT p.user_phone,
       'bonus'::transaction_type_enum,
       p.tokens,
       0,
       'Реферальное вознаграждение: ' || p.rub || ' ₽',
       jsonb_build_object('kind', 'referral_payout',
                          'payout_id', p.id,
                          'leader_id', p.leader_id,
                          'rub', p.rub,
                          'rate', p.rate,
                          'commission_ids', to_jsonb(p.commission_ids),
                          'reconstructed', true),
       p.created_at
  FROM referral_token_payouts p
 WHERE NOT EXISTS (SELECT 1 FROM token_transactions t
                    WHERE t.metadata->>'payout_id' = p.id::text);
