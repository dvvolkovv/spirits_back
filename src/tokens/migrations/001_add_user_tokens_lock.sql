-- Зачисление читает баланс ПОД ЗАМКОМ строки.
--
-- Определение из src/base/migrations/001_core_schema.sql (оно же живёт на
-- проде — сверено `SELECT prosrc FROM pg_proc`, текст совпадал дословно)
-- читало баланс обычным SELECT, без FOR UPDATE, и писало посчитанное значение
-- целиком:
--
--     SELECT COALESCE(tokens, 0) INTO v_previous_balance ...   -- без замка
--     v_new_balance := GREATEST(0, v_previous_balance + p_amount);
--     UPDATE ai_profiles_consolidated SET tokens = v_new_balance ...
--
-- Между этими двумя операторами помещается ЦЕЛИКОМ чужая транзакция. Замок
-- от такого писателя не защищает: его держат только те, кто его берёт, а
-- consume_user_tokens берёт FOR UPDATE и честно ждёт — но ждать некого, потому
-- что зачисление строку не заперло. Классическая потеря обновления:
--
--     было 100 000 → списание забрало 50 000 → пополнение на 30 000
--     записало 130 000 вместо 80 000
--
-- Пятьдесят тысяч токенов возвращены человеку за уже оказанную услугу. Бьёт по
-- ВСЕМ путям пополнения — ЮKassa, купон (и напрямую, и через SQL-процедуру
-- redeem_coupon), приветственный бонус, возврат поддержки, ручная правка
-- админом, возврат за видео, возвраты SMM.
--
-- ПОЧЕМУ FOR UPDATE, А НЕ ПРИРАЩЕНИЕ. Второй способ — не считать значение в
-- переменной, а нарастить его одним оператором
-- (`SET tokens = GREATEST(0, COALESCE(tokens,0) + p_amount)`), — потерю
-- обновления тоже закрывает. Он не подошёл по форме ответа: процедура обязана
-- вернуть `previous_balance`, а вывести его из нового баланса нельзя —
-- GREATEST(0, ...) обрезает отрицательный итог, и после обрезки
-- `new_balance - p_amount` это уже не то, что было до операции (обрезка живая:
-- через процедуру ходят отрицательные суммы, см. auth.service.ts). Отдельный
-- же SELECT ради previous_balance вернул бы ровно то незапертое чтение, от
-- которого мы уходим. FOR UPDATE к тому же делает процедуру симметричной
-- consume_user_tokens и складывает ОДНОВРЕМЕННЫЕ ЗАЧИСЛЕНИЯ: два пополнения,
-- прочитавшие один и тот же баланс, теряли одно из двух точно так же.
--
-- ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕ ЧИНИМ. Ветка «строки пользователя ещё нет»
-- оставлена дословно прежней: UPDATE не находит строку, баланс никуда не
-- записывается, а в token_transactions всё равно уезжает строка с
-- balance_after. Это отдельный дефект (и комментарий внутри неё, обещающий
-- «создаем запись», врёт — INSERT там никогда не было; на него же опирается
-- устаревший комментарий в support.service.ts). Чинить его здесь нельзя:
-- заведение профиля из процедуры зачисления — смена поведения, а не гонка, и
-- она поменяла бы ответ на вызовах, которые сегодня рассчитывают на отказ.
--
-- Идемпотентно: CREATE OR REPLACE. Имена и типы параметров обязаны совпадать с
-- исходными — Postgres не даёт переименовать параметр через OR REPLACE, а
-- смена типа завела бы ВТОРУЮ перегрузку рядом со старой, и вызовы разошлись
-- бы по ним молча.

CREATE OR REPLACE FUNCTION public.add_user_tokens(
    p_user_id text,
    p_amount bigint,
    p_transaction_type public.transaction_type_enum,
    p_description text DEFAULT NULL::text,
    p_metadata jsonb DEFAULT NULL::jsonb
) RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_previous_balance BIGINT;
    v_new_balance BIGINT;
    v_transaction_id UUID;
BEGIN
    -- Получаем текущий баланс С БЛОКИРОВКОЙ СТРОКИ — ровно как
    -- consume_user_tokens. Всё, что написано ниже, считается от значения,
    -- которое до нашего COMMIT никто не перепишет.
    SELECT COALESCE(tokens, 0) INTO v_previous_balance
    FROM ai_profiles_consolidated
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Если пользователь не найден — считаем от нуля. Строку здесь НЕ заводим:
    -- см. «чего сознательно не чиним» в шапке файла.
    IF v_previous_balance IS NULL THEN
        v_previous_balance := 0;
        v_new_balance := GREATEST(0, p_amount);
    ELSE
        v_new_balance := GREATEST(0, v_previous_balance + p_amount);
    END IF;

    -- Обновляем баланс в ai_profiles_consolidated
    UPDATE ai_profiles_consolidated
    SET tokens = v_new_balance
    WHERE user_id = p_user_id;

    -- Создаем запись транзакции
    INSERT INTO token_transactions (
        id,
        user_id,
        transaction_type,
        amount,
        balance_after,
        description,
        metadata
    )
    VALUES (
        gen_random_uuid(),
        p_user_id,
        p_transaction_type,
        p_amount,
        v_new_balance,
        p_description,
        p_metadata
    )
    RETURNING id INTO v_transaction_id;

    -- Возвращаем результат. ФОРМУ МЕНЯТЬ НЕЛЬЗЯ: эти пять ключей разбирают
    -- payments, support, video, smm и identity.
    RETURN json_build_object(
        'success', true,
        'transaction_id', v_transaction_id,
        'previous_balance', v_previous_balance,
        'new_balance', v_new_balance,
        'tokens_added', p_amount
    );
END;
$$;

COMMENT ON FUNCTION public.add_user_tokens(
    p_user_id text,
    p_amount bigint,
    p_transaction_type public.transaction_type_enum,
    p_description text,
    p_metadata jsonb
) IS 'Добавить токены пользователю и создать транзакцию. Баланс читается под FOR UPDATE — без замка параллельное списание терялось.';
