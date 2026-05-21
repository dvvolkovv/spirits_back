-- 001_core_schema.sql
-- Baseline схема Linkeon backend.
--
-- Сгенерировано: pg_dump --schema-only --no-owner --no-privileges с прода
-- (212.113.106.202, БД linkeon, порт 5433). Заменяет reverse-engineered
-- версию от 2026-05-21 которая пропускала ai_profiles_consolidated и др.
--
-- Регенерация (когда схема прода меняется):
--   ssh dvolkov@212.113.106.202 'PGPASSWORD=linkeon_pass_2026 pg_dump \
--     -h 127.0.0.1 -p 5433 -U linkeon -d linkeon \
--     --schema-only --no-owner --no-privileges' \
--     > src/base/migrations/001_core_schema.sql
--   # затем добавить эту шапку обратно
--
-- Идемпотентность: pg_dump использует CREATE TABLE без IF NOT EXISTS, поэтому
-- migrate-runner отметит этот файл как applied (через schema_migrations)
-- и больше не запустит. Для свежих БД (provision-test.sh) — применяется ОДИН раз.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: payment_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status_enum AS ENUM (
    'pending',
    'succeeded',
    'canceled',
    'failed'
);


--
-- Name: task_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_status_enum AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed'
);


--
-- Name: transaction_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transaction_type_enum AS ENUM (
    'purchase',
    'consumed',
    'bonus',
    'refund',
    'adjustment',
    'coupon'
);


--
-- Name: add_user_tokens(text, bigint, public.transaction_type_enum, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_tokens(p_user_id text, p_amount bigint, p_transaction_type public.transaction_type_enum, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT NULL::jsonb) RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_previous_balance BIGINT;
    v_new_balance BIGINT;
    v_transaction_id UUID;
BEGIN
    -- Получаем текущий баланс
    SELECT COALESCE(tokens, 0) INTO v_previous_balance
    FROM ai_profiles_consolidated
    WHERE user_id = p_user_id;

    -- Если пользователь не найден, создаем запись
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

    -- Возвращаем результат
    RETURN json_build_object(
        'success', true,
        'transaction_id', v_transaction_id,
        'previous_balance', v_previous_balance,
        'new_balance', v_new_balance,
        'tokens_added', p_amount
    );
END;
$$;


--
-- Name: FUNCTION add_user_tokens(p_user_id text, p_amount bigint, p_transaction_type public.transaction_type_enum, p_description text, p_metadata jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_user_tokens(p_user_id text, p_amount bigint, p_transaction_type public.transaction_type_enum, p_description text, p_metadata jsonb) IS 'Добавить токены пользователю и создать транзакцию';


--
-- Name: calculate_tokens_cost(bigint, bigint, numeric, bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_tokens_cost(p_input_tokens bigint, p_output_tokens bigint, p_assistant_coeff numeric, p_service_cost bigint, p_is_premium boolean DEFAULT false) RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_tokens_spent NUMERIC;
BEGIN
    -- Формула: ((input_tokens * 1.0) + (output_tokens * 1.3)) * assistant_coefficient + service_cost
    v_tokens_spent := ((p_input_tokens * 1.0) + (p_output_tokens * 1.3)) * p_assistant_coeff + p_service_cost;
    
    -- Применение скидки Premium (30% скидка = умножение на 0.7)
    IF p_is_premium THEN
        v_tokens_spent := v_tokens_spent * 0.7;
    END IF;
    
    -- Округление вверх
    RETURN CEIL(v_tokens_spent);
END;
$$;


--
-- Name: FUNCTION calculate_tokens_cost(p_input_tokens bigint, p_output_tokens bigint, p_assistant_coeff numeric, p_service_cost bigint, p_is_premium boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.calculate_tokens_cost(p_input_tokens bigint, p_output_tokens bigint, p_assistant_coeff numeric, p_service_cost bigint, p_is_premium boolean) IS 'Расчет стоимости токенов по формуле';


--
-- Name: consume_user_tokens(text, bigint, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_user_tokens(p_user_id text, p_amount bigint, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT NULL::jsonb) RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_current_balance BIGINT;
    v_new_balance BIGINT;
    v_actual_amount BIGINT;
    v_transaction_id UUID;
BEGIN
    -- Получаем текущий баланс с блокировкой строки
    SELECT COALESCE(tokens, 0) INTO v_current_balance
    FROM ai_profiles_consolidated
    WHERE user_id = p_user_id
    FOR UPDATE;

    -- Если пользователь не найден, создаем его с нулевым балансом
    IF v_current_balance IS NULL THEN
        INSERT INTO ai_profiles_consolidated (user_id, tokens)
        VALUES (p_user_id, 0)
        ON CONFLICT (user_id) DO NOTHING;

        -- Получаем баланс снова после создания
        SELECT COALESCE(tokens, 0) INTO v_current_balance
        FROM ai_profiles_consolidated
        WHERE user_id = p_user_id
        FOR UPDATE;
    END IF;

    -- Определяем фактическое количество токенов для списания
    IF v_current_balance >= p_amount THEN
        v_actual_amount := p_amount;
    ELSE
        v_actual_amount := v_current_balance;
    END IF;

    -- Если баланс уже ноль, возвращаем ошибку
    IF v_current_balance <= 0 THEN
        RETURN json_build_object(
            'success', false,
            'error', 'INSUFFICIENT_TOKENS',
            'message', 'Баланс равен нулю',
            'current_balance', 0,
            'required', p_amount,
            'tokens_used', 0
        );
    END IF;

    -- Списание токенов
    v_new_balance := v_current_balance - v_actual_amount;

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
        'consumed',
        -v_actual_amount,
        v_new_balance,
        p_description,
        p_metadata
    )
    RETURNING id INTO v_transaction_id;

    -- Возвращаем результат
    IF v_actual_amount < p_amount THEN
        RETURN json_build_object(
            'success', true,
            'transaction_id', v_transaction_id,
            'previous_balance', v_current_balance,
            'new_balance', v_new_balance,
            'tokens_used', v_actual_amount,
            'tokens_requested', p_amount,
            'tokens_shortage', p_amount - v_actual_amount,
            'message', format('Списано %s токенов из запрошенных %s. Баланс обнулен.', v_actual_amount, p_amount)
        );
    ELSE
        RETURN json_build_object(
            'success', true,
            'transaction_id', v_transaction_id,
            'previous_balance', v_current_balance,
            'new_balance', v_new_balance,
            'tokens_used', v_actual_amount
        );
    END IF;
END;
$$;


--
-- Name: FUNCTION consume_user_tokens(p_user_id text, p_amount bigint, p_description text, p_metadata jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.consume_user_tokens(p_user_id text, p_amount bigint, p_description text, p_metadata jsonb) IS 'Списать токены с проверкой баланса. Автоматически создает пользователя, если его нет.';


--
-- Name: format_search_query(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.format_search_query(input_query text) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Разбиваем запрос на слова и соединяем через OR
  RETURN array_to_string(
    string_to_array(trim(input_query), ' '), 
    ' | '
  );
END;
$$;


--
-- Name: generate_create_table_statement(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_create_table_statement(p_table_name character varying) RETURNS text
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_table_ddl   text;
    column_record record;
BEGIN
    FOR column_record IN 
        SELECT 
            b.nspname as schema_name,
            b.relname as table_name,
            a.attname as column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as column_type,
            CASE WHEN 
                (SELECT substring(pg_catalog.pg_get_expr(d.adbin, d.adrelid) for 128)
                 FROM pg_catalog.pg_attrdef d
                 WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) IS NOT NULL THEN
                'DEFAULT '|| (SELECT substring(pg_catalog.pg_get_expr(d.adbin, d.adrelid) for 128)
                              FROM pg_catalog.pg_attrdef d
                              WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef)
            ELSE
                ''
            END as column_default_value,
            CASE WHEN a.attnotnull = true THEN 
                'NOT NULL'
            ELSE
                'NULL'
            END as column_not_null,
            a.attnum as attnum,
            e.max_attnum as max_attnum
        FROM 
            pg_catalog.pg_attribute a
            INNER JOIN 
             (SELECT c.oid,
                n.nspname,
                c.relname
              FROM pg_catalog.pg_class c
                   LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname ~ ('^('||p_table_name||')$')
                AND pg_catalog.pg_table_is_visible(c.oid)
              ORDER BY 2, 3) b
            ON a.attrelid = b.oid
            INNER JOIN 
             (SELECT 
                  a.attrelid,
                  max(a.attnum) as max_attnum
              FROM pg_catalog.pg_attribute a
              WHERE a.attnum > 0 
                AND NOT a.attisdropped
              GROUP BY a.attrelid) e
            ON a.attrelid=e.attrelid
        WHERE a.attnum > 0 
          AND NOT a.attisdropped
        ORDER BY a.attnum
    LOOP
        IF column_record.attnum = 1 THEN
            v_table_ddl:='CREATE TABLE '||column_record.schema_name||'.'||column_record.table_name||' (';
        ELSE
            v_table_ddl:=v_table_ddl||',';
        END IF;

        IF column_record.attnum <= column_record.max_attnum THEN
            v_table_ddl:=v_table_ddl||chr(10)||
                     '    '||column_record.column_name||' '||column_record.column_type||' '||column_record.column_default_value||' '||column_record.column_not_null;
        END IF;
    END LOOP;

    v_table_ddl:=v_table_ddl||');';
    RETURN v_table_ddl;
END;
$_$;


--
-- Name: n8n_trigger_function_ab43a95a_b0bc_4900_abb9_8c814503a5cc(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.n8n_trigger_function_ab43a95a_b0bc_4900_abb9_8c814503a5cc() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin perform pg_notify('n8n_channel_ab43a95a_b0bc_4900_abb9_8c814503a5cc', row_to_json(new)::text); return null; end; $$;


--
-- Name: redeem_coupon(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redeem_coupon(p_user_id text, p_coupon_code text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_coupon_id integer;
  v_token_amount bigint;
  v_is_active boolean;
  v_result json;
BEGIN
  SELECT id, token_amount, is_active INTO v_coupon_id, v_token_amount, v_is_active
  FROM coupons WHERE UPPER(code) = UPPER(p_coupon_code);

  IF v_coupon_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'coupon_not_found');
  END IF;
  IF NOT v_is_active THEN
    RETURN json_build_object('success', false, 'error', 'coupon_inactive');
  END IF;
  IF EXISTS(SELECT 1 FROM coupon_redemptions WHERE coupon_id = v_coupon_id AND user_id = p_user_id) THEN
    RETURN json_build_object('success', false, 'error', 'coupon_already_used');
  END IF;

  INSERT INTO coupon_redemptions (coupon_id, user_id, tokens_granted)
  VALUES (v_coupon_id, p_user_id, v_token_amount);

  UPDATE coupons SET usage_count = usage_count + 1 WHERE id = v_coupon_id;

  v_result := add_user_tokens(p_user_id, v_token_amount, 'coupon'::transaction_type_enum,
    'Купон: ' || p_coupon_code,
    json_build_object('coupon_code', p_coupon_code, 'coupon_id', v_coupon_id)::jsonb);

  RETURN json_build_object('success', true, 'tokens_granted', v_token_amount,
    'new_balance', (v_result->>'new_balance')::bigint);
END;
$$;


--
-- Name: search_profiles(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_profiles(search_query text, result_limit integer DEFAULT 10) RETURNS TABLE(user_id text, profile_data json, relevance_score real)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.user_id::text,
    p.params as profile_data,
    ts_rank(
      to_tsvector('russian', 
        COALESCE(p.params->>'user nickname', '') || ' ' ||
        COALESCE(p.params->>'profile info', '') || ' ' ||
        COALESCE(p.params->>'person values', '') || ' ' ||
        COALESCE(p.params->>'beliefs', '') || ' ' ||
        COALESCE(p.params->>'desires', '') || ' ' ||
        COALESCE(p.params->>'intents', '')
      ),
      plainto_tsquery('russian', search_query)
    ) as relevance_score
  FROM "ai-profiles" p
  WHERE to_tsvector('russian', 
    COALESCE(p.params->>'user nickname', '') || ' ' ||
    COALESCE(p.params->>'profile info', '') || ' ' ||
    COALESCE(p.params->>'person values', '') || ' ' ||
    COALESCE(p.params->>'beliefs', '') || ' ' ||
    COALESCE(p.params->>'desires', '') || ' ' ||
    COALESCE(p.params->>'intents', '')
  ) @@ plainto_tsquery('russian', search_query)
  ORDER BY relevance_score DESC
  LIMIT result_limit;
END;
$$;


--
-- Name: search_profiles_json_string(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_profiles_json_string(search_query text, result_limit integer DEFAULT 10) RETURNS TABLE(user_id text, profile_data json, match_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    latest.user_id::text,
    latest.params as profile_data,
    (
      CASE WHEN latest.params::text ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END
    ) as match_count
  FROM (
    SELECT DISTINCT ON (p.user_id)
      p.user_id,
      p.params,
      p.created_at
    FROM "ai-profiles" p
    WHERE p.params::text ILIKE '%' || search_query || '%'
    ORDER BY p.user_id, p.created_at DESC
  ) latest
  ORDER BY match_count DESC, latest.user_id
  LIMIT result_limit;
END;
$$;


--
-- Name: search_profiles_simple(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_profiles_simple(search_query text, result_limit integer DEFAULT 10) RETURNS TABLE(user_id text, profile_data json, match_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.user_id::text,
    p.params as profile_data,
    (
      CASE WHEN COALESCE(p.params->>'user nickname', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END +
      CASE WHEN COALESCE(p.params->>'profile info', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END +
      CASE WHEN COALESCE(p.params->>'person values', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END +
      CASE WHEN COALESCE(p.params->>'beliefs', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END +
      CASE WHEN COALESCE(p.params->>'desires', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END +
      CASE WHEN COALESCE(p.params->>'intents', '') ILIKE '%' || search_query || '%' THEN 1 ELSE 0 END
    ) as match_count
  FROM "ai-profiles" p
  WHERE 
    COALESCE(p.params->>'user nickname', '') ILIKE '%' || search_query || '%' OR
    COALESCE(p.params->>'profile info', '') ILIKE '%' || search_query || '%' OR
    COALESCE(p.params->>'person values', '') ILIKE '%' || search_query || '%' OR
    COALESCE(p.params->>'beliefs', '') ILIKE '%' || search_query || '%' OR
    COALESCE(p.params->>'desires', '') ILIKE '%' || search_query || '%' OR
    COALESCE(p.params->>'intents', '') ILIKE '%' || search_query || '%'
  ORDER BY match_count DESC
  LIMIT result_limit;
END;
$$;


--
-- Name: search_profiles_tsquery(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_profiles_tsquery(search_query text, result_limit integer DEFAULT 10) RETURNS TABLE(user_id text, profile_data json, relevance_score real)
    LANGUAGE plpgsql
    AS $$
DECLARE
  formatted_query text;
BEGIN
  -- Форматируем запрос для to_tsquery
  formatted_query := format_search_query(search_query);
  
  RETURN QUERY
  SELECT 
    p.user_id::text,
    p.params as profile_data,
    ts_rank(
      to_tsvector('russian', 
        COALESCE(p.params->>'user nickname', '') || ' ' ||
        COALESCE(p.params->>'profile info', '') || ' ' ||
        COALESCE(p.params->>'person values', '') || ' ' ||
        COALESCE(p.params->>'beliefs', '') || ' ' ||
        COALESCE(p.params->>'desires', '') || ' ' ||
        COALESCE(p.params->>'intents', '')
      ),
      to_tsquery('russian', formatted_query)
    ) as relevance_score
  FROM "ai-profiles" p
  WHERE to_tsvector('russian', 
    COALESCE(p.params->>'user nickname', '') || ' ' ||
    COALESCE(p.params->>'profile info', '') || ' ' ||
    COALESCE(p.params->>'person values', '') || ' ' ||
    COALESCE(p.params->>'beliefs', '') || ' ' ||
    COALESCE(p.params->>'desires', '') || ' ' ||
    COALESCE(p.params->>'intents', '')
  ) @@ to_tsquery('russian', formatted_query)
  ORDER BY relevance_score DESC
  LIMIT result_limit;
END;
$$;


--
-- Name: trg_smm_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_smm_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_token_consumption_tasks_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_token_consumption_tasks_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    model_id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    parameters text,
    parameter_mappings text,
    visualization_settings text,
    public_uuid character(36),
    made_public_by_id integer,
    creator_id integer,
    archived boolean DEFAULT false NOT NULL,
    entity_id character(21)
);


--
-- Name: TABLE action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.action IS 'An action is something you can do, such as run a readwrite query';


--
-- Name: COLUMN action.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.created_at IS 'The timestamp of when the action was created';


--
-- Name: COLUMN action.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.updated_at IS 'The timestamp of when the action was updated';


--
-- Name: COLUMN action.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.type IS 'Type of action';


--
-- Name: COLUMN action.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.model_id IS 'The associated model';


--
-- Name: COLUMN action.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.name IS 'The name of the action';


--
-- Name: COLUMN action.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.description IS 'The description of the action';


--
-- Name: COLUMN action.parameters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.parameters IS 'The saved parameters for this action';


--
-- Name: COLUMN action.parameter_mappings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.parameter_mappings IS 'The saved parameter mappings for this action';


--
-- Name: COLUMN action.visualization_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.visualization_settings IS 'The UI visualization_settings for this action';


--
-- Name: COLUMN action.public_uuid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.public_uuid IS 'Unique UUID used to in publically-accessible links to this Action.';


--
-- Name: COLUMN action.made_public_by_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.made_public_by_id IS 'The ID of the User who first publically shared this Action.';


--
-- Name: COLUMN action.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.creator_id IS 'The user who created the action';


--
-- Name: COLUMN action.archived; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.archived IS 'Whether or not the action has been archived';


--
-- Name: COLUMN action.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.action.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: action_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.action ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.action_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    name text,
    system_prompt text,
    description text,
    category character varying DEFAULT 'business'::character varying,
    display_name text
);


--
-- Name: agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agents_id_seq OWNED BY public.agents.id;


--
-- Name: ai-profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ai-profiles" (
    id integer NOT NULL,
    user_id text,
    params json,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai-profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."ai-profiles_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai-profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."ai-profiles_id_seq" OWNED BY public."ai-profiles".id;


--
-- Name: ai_profiles_consolidated; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_profiles_consolidated (
    id integer NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    preferred_agent character varying,
    isadmin boolean DEFAULT false,
    tokens bigint DEFAULT 0 NOT NULL,
    email text,
    profile_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: COLUMN ai_profiles_consolidated.tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_profiles_consolidated.tokens IS 'Баланс токенов пользователя (дефолт: 20000)';


--
-- Name: ai_profiles_consolidated_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_profiles_consolidated_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_profiles_consolidated_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_profiles_consolidated_id_seq OWNED BY public.ai_profiles_consolidated.id;


--
-- Name: api_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key (
    id integer NOT NULL,
    user_id integer,
    key character varying(254) NOT NULL,
    key_prefix character varying(7) NOT NULL,
    creator_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(254) NOT NULL,
    updated_by_id integer NOT NULL,
    scope character varying(64)
);


--
-- Name: TABLE api_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.api_key IS 'An API Key';


--
-- Name: COLUMN api_key.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.id IS 'The ID of the API Key itself';


--
-- Name: COLUMN api_key.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.user_id IS 'The ID of the user who this API Key acts as';


--
-- Name: COLUMN api_key.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.key IS 'The hashed API key';


--
-- Name: COLUMN api_key.key_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.key_prefix IS 'The first 7 characters of the unhashed key';


--
-- Name: COLUMN api_key.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.creator_id IS 'The ID of the user that created this API key';


--
-- Name: COLUMN api_key.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.created_at IS 'The timestamp when the key was created';


--
-- Name: COLUMN api_key.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.updated_at IS 'The timestamp when the key was last updated';


--
-- Name: COLUMN api_key.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.name IS 'The user-defined name of the API key.';


--
-- Name: COLUMN api_key.updated_by_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.updated_by_id IS 'The ID of the user that last updated this API key';


--
-- Name: COLUMN api_key.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_key.scope IS 'The scope of the API key, if applicable';


--
-- Name: api_key_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.api_key ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.api_key_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: application_permissions_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_permissions_revision (
    id integer NOT NULL,
    before text NOT NULL,
    after text NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    remark text
);


--
-- Name: application_permissions_revision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.application_permissions_revision ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.application_permissions_revision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    topic character varying(32) NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    end_timestamp timestamp with time zone,
    user_id integer,
    model character varying(32),
    model_id integer,
    details text NOT NULL
);


--
-- Name: TABLE audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_log IS 'Used to store application events for auditing use cases';


--
-- Name: COLUMN audit_log.topic; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.topic IS 'The topic of a given audit event';


--
-- Name: COLUMN audit_log."timestamp"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log."timestamp" IS 'The time an event was recorded';


--
-- Name: COLUMN audit_log.end_timestamp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.end_timestamp IS 'The time an event ended, if applicable';


--
-- Name: COLUMN audit_log.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.user_id IS 'The user who performed an action or triggered an event';


--
-- Name: COLUMN audit_log.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.model IS 'The name of the model this event applies to (e.g. Card, Dashboard), if applicable';


--
-- Name: COLUMN audit_log.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.model_id IS 'The ID of the model this event applies to, if applicable';


--
-- Name: COLUMN audit_log.details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.details IS 'A JSON map with metadata about the event';


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_identity (
    id integer NOT NULL,
    user_id integer NOT NULL,
    provider character varying(50) NOT NULL,
    credentials text,
    metadata text,
    provider_id character varying(255),
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE auth_identity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_identity IS 'Stores authentication credentials for users. A user can have multiple auth identities.';


--
-- Name: COLUMN auth_identity.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.id IS 'Integer primary key';


--
-- Name: COLUMN auth_identity.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.user_id IS 'Foreign key to core_user';


--
-- Name: COLUMN auth_identity.provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.provider IS 'Authentication provider type (password, google, ldap, saml, jwt, support)';


--
-- Name: COLUMN auth_identity.credentials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.credentials IS 'JSON object containing provider-specific credentials';


--
-- Name: COLUMN auth_identity.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.metadata IS 'JSON object containing provider-specific metadata';


--
-- Name: COLUMN auth_identity.provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.provider_id IS 'Provider-specific identifier (email for password/Google, DN for LDAP, subject for SAML/JWT)';


--
-- Name: COLUMN auth_identity.last_used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.last_used_at IS 'Timestamp of last successful authentication';


--
-- Name: COLUMN auth_identity.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.expires_at IS 'Timestamp when this authentication method expires (null = never expires)';


--
-- Name: COLUMN auth_identity.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.created_at IS 'Timestamp when this identity was created';


--
-- Name: COLUMN auth_identity.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_identity.updated_at IS 'Timestamp when this identity was last updated';


--
-- Name: auth_identity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_identity ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_identity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bookmark_ordering; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookmark_ordering (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(255) NOT NULL,
    item_id integer NOT NULL,
    ordering integer NOT NULL
);


--
-- Name: bookmark_ordering_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bookmark_ordering ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bookmark_ordering_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cache_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache_config (
    id integer NOT NULL,
    model character varying(32) NOT NULL,
    model_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    strategy text NOT NULL,
    config text NOT NULL,
    state text,
    invalidated_at timestamp with time zone,
    next_run_at timestamp with time zone,
    refresh_automatically boolean DEFAULT false
);


--
-- Name: TABLE cache_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cache_config IS 'Cache Configuration';


--
-- Name: COLUMN cache_config.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.id IS 'Unique ID';


--
-- Name: COLUMN cache_config.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.model IS 'Name of an entity model';


--
-- Name: COLUMN cache_config.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.model_id IS 'ID of the said entity';


--
-- Name: COLUMN cache_config.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.created_at IS 'Timestamp when the config was inserted';


--
-- Name: COLUMN cache_config.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.updated_at IS 'Timestamp when the config was updated';


--
-- Name: COLUMN cache_config.strategy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.strategy IS 'caching strategy name';


--
-- Name: COLUMN cache_config.config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.config IS 'caching strategy configuration';


--
-- Name: COLUMN cache_config.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.state IS 'state for strategies needing to keep some data between runs';


--
-- Name: COLUMN cache_config.invalidated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.invalidated_at IS 'indicates when a cache was invalidated last time for schedule-based strategies';


--
-- Name: COLUMN cache_config.next_run_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.next_run_at IS 'keeps next time to run for schedule-based strategies';


--
-- Name: COLUMN cache_config.refresh_automatically; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cache_config.refresh_automatically IS 'Whether or not we should automatically refresh cache results when a cache expires';


--
-- Name: cache_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cache_config ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cache_config_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: card_bookmark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_bookmark (
    id integer NOT NULL,
    user_id integer NOT NULL,
    card_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: card_bookmark_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.card_bookmark ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.card_bookmark_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: card_label; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_label (
    id integer NOT NULL,
    card_id integer NOT NULL,
    label_id integer NOT NULL
);


--
-- Name: card_label_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.card_label ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.card_label_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: channel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    type character varying(32) NOT NULL,
    details text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.channel IS 'Channel configurations';


--
-- Name: COLUMN channel.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.id IS 'Unique ID';


--
-- Name: COLUMN channel.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.name IS 'channel name';


--
-- Name: COLUMN channel.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.description IS 'channel description';


--
-- Name: COLUMN channel.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.type IS 'Channel type';


--
-- Name: COLUMN channel.details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.details IS 'Channel details, used to store authentication information or channel-specific settings';


--
-- Name: COLUMN channel.active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.active IS 'whether the channel is active';


--
-- Name: COLUMN channel.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.created_at IS 'Timestamp when the channel was inserted';


--
-- Name: COLUMN channel.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel.updated_at IS 'Timestamp when the channel was updated';


--
-- Name: channel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.channel ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.channel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: channel_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_template (
    id integer NOT NULL,
    name character varying(64) NOT NULL,
    channel_type character varying(64) NOT NULL,
    details text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE channel_template; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.channel_template IS 'custom template for the channel';


--
-- Name: COLUMN channel_template.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel_template.name IS 'the name of the template';


--
-- Name: COLUMN channel_template.channel_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel_template.channel_type IS 'the channel type of the template';


--
-- Name: COLUMN channel_template.details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel_template.details IS 'the details of the template';


--
-- Name: COLUMN channel_template.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel_template.created_at IS 'The timestamp of when the template was created';


--
-- Name: COLUMN channel_template.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channel_template.updated_at IS 'The timestamp of when the template was last updated';


--
-- Name: channel_template_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.channel_template ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.channel_template_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: chat_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_user character varying,
    to_user character varying,
    created_at timestamp with time zone DEFAULT now(),
    text character varying
);


--
-- Name: chat_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_user_id text NOT NULL,
    to_user_id text NOT NULL,
    intro_message text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT chat_requests_check CHECK ((from_user_id <> to_user_id)),
    CONSTRAINT chat_requests_intro_message_check CHECK ((char_length(intro_message) <= 500)),
    CONSTRAINT chat_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'withdrawn'::text])))
);


--
-- Name: cloud_migration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_migration (
    id integer NOT NULL,
    external_id text NOT NULL,
    upload_url text NOT NULL,
    state character varying(32) DEFAULT 'init'::character varying NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE cloud_migration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cloud_migration IS 'Migrate to cloud directly from Metabase';


--
-- Name: COLUMN cloud_migration.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.id IS 'Unique ID';


--
-- Name: COLUMN cloud_migration.external_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.external_id IS 'Matching ID in Cloud for this migration';


--
-- Name: COLUMN cloud_migration.upload_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.upload_url IS 'URL where the backup will be uploaded to';


--
-- Name: COLUMN cloud_migration.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.state IS 'Current state of the migration: init, setup, dump, upload, done, error, cancelled';


--
-- Name: COLUMN cloud_migration.progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.progress IS 'Number between 0 to 100 representing progress as a percentage';


--
-- Name: COLUMN cloud_migration.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.created_at IS 'Timestamp when the config was inserted';


--
-- Name: COLUMN cloud_migration.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cloud_migration.updated_at IS 'Timestamp when the config was updated';


--
-- Name: cloud_migration_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cloud_migration ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cloud_migration_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    archived boolean DEFAULT false NOT NULL,
    location character varying(254) DEFAULT '/'::character varying NOT NULL,
    personal_owner_id integer,
    slug character varying(510) NOT NULL,
    namespace character varying(254),
    authority_level character varying(255),
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type character varying(256),
    is_sample boolean DEFAULT false NOT NULL,
    archive_operation_id character(36),
    archived_directly boolean,
    is_remote_synced boolean DEFAULT false
);


--
-- Name: COLUMN collection.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.created_at IS 'Timestamp of when this Collection was created.';


--
-- Name: COLUMN collection.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.type IS 'This is used to differentiate instance-analytics collections from all other collections.';


--
-- Name: COLUMN collection.is_sample; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.is_sample IS 'Is the collection part of the sample content?';


--
-- Name: COLUMN collection.archive_operation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.archive_operation_id IS 'The UUID of the trash operation. Each time you trash a collection subtree, you get a unique ID.';


--
-- Name: COLUMN collection.archived_directly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.archived_directly IS 'Whether the item was trashed independently or as a subcollection';


--
-- Name: COLUMN collection.is_remote_synced; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.collection.is_remote_synced IS 'Indicates if this collection is synced from a remote source';


--
-- Name: collection_bookmark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_bookmark (
    id integer NOT NULL,
    user_id integer NOT NULL,
    collection_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collection_bookmark_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.collection_bookmark ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.collection_bookmark_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collection_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.collection ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.collection_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: collection_permission_graph_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_permission_graph_revision (
    id integer NOT NULL,
    before text NOT NULL,
    after text NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    remark text
);


--
-- Name: collection_permission_graph_revision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.collection_permission_graph_revision ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.collection_permission_graph_revision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment (
    id integer NOT NULL,
    parent_comment_id integer,
    target_type character varying(50) DEFAULT 'document'::character varying NOT NULL,
    target_id integer NOT NULL,
    child_target_id text,
    creator_id integer NOT NULL,
    content text NOT NULL,
    is_resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    content_html text
);


--
-- Name: TABLE comment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.comment IS 'Comments on various entities (documents, dashboards, etc.)';


--
-- Name: COLUMN comment.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.id IS 'Primary key for comment table';


--
-- Name: COLUMN comment.parent_comment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.parent_comment_id IS 'ID of the parent comment for threading (null for root comments)';


--
-- Name: COLUMN comment.target_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.target_type IS 'Type of entity being commented on';


--
-- Name: COLUMN comment.target_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.target_id IS 'ID of the entity being commented on';


--
-- Name: COLUMN comment.child_target_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.child_target_id IS 'Sub-entity ID (e.g., document block node ID)';


--
-- Name: COLUMN comment.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.creator_id IS 'User who created this comment';


--
-- Name: COLUMN comment.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.content IS 'The comment content';


--
-- Name: COLUMN comment.is_resolved; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.is_resolved IS 'Whether this comment thread is resolved';


--
-- Name: COLUMN comment.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.created_at IS 'Timestamp when comment was created';


--
-- Name: COLUMN comment.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.updated_at IS 'Timestamp when comment was last updated';


--
-- Name: COLUMN comment.deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.deleted_at IS 'Soft delete timestamp (null if not deleted)';


--
-- Name: COLUMN comment.content_html; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment.content_html IS 'HTML-rendered version of the comment content';


--
-- Name: comment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.comment ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.comment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comment_reaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_reaction (
    id integer NOT NULL,
    comment_id integer NOT NULL,
    user_id integer NOT NULL,
    emoji character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE comment_reaction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.comment_reaction IS 'Store reactions (emojis) on comments';


--
-- Name: COLUMN comment_reaction.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment_reaction.id IS 'Primary key for comment_reaction table';


--
-- Name: COLUMN comment_reaction.comment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment_reaction.comment_id IS 'ID of the comment being reacted to';


--
-- Name: COLUMN comment_reaction.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment_reaction.user_id IS 'User who added this reaction';


--
-- Name: COLUMN comment_reaction.emoji; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment_reaction.emoji IS 'Unicode emoji (supports compound emojis)';


--
-- Name: COLUMN comment_reaction.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.comment_reaction.created_at IS 'Timestamp when reaction was added';


--
-- Name: comment_reaction_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.comment_reaction ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.comment_reaction_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: connection_impersonations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection_impersonations (
    id integer NOT NULL,
    db_id integer NOT NULL,
    group_id integer NOT NULL,
    attribute text
);


--
-- Name: TABLE connection_impersonations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.connection_impersonations IS 'Table for holding connection impersonation policies';


--
-- Name: COLUMN connection_impersonations.db_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_impersonations.db_id IS 'ID of the database this connection impersonation policy affects';


--
-- Name: COLUMN connection_impersonations.group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_impersonations.group_id IS 'ID of the permissions group this connection impersonation policy affects';


--
-- Name: COLUMN connection_impersonations.attribute; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_impersonations.attribute IS 'User attribute associated with the database role to use for this connection impersonation policy';


--
-- Name: connection_impersonations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.connection_impersonations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.connection_impersonations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: contact_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_requests (
    id integer NOT NULL,
    requester_id integer NOT NULL,
    target_id integer NOT NULL,
    message text,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: contact_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_requests_id_seq OWNED BY public.contact_requests.id;


--
-- Name: content_translation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_translation (
    id integer NOT NULL,
    locale character varying(5) NOT NULL,
    msgid text NOT NULL,
    msgstr text NOT NULL
);


--
-- Name: TABLE content_translation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.content_translation IS 'Content translations';


--
-- Name: COLUMN content_translation.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_translation.id IS 'Unique ID';


--
-- Name: COLUMN content_translation.locale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_translation.locale IS 'Locale';


--
-- Name: COLUMN content_translation.msgid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_translation.msgid IS 'The raw string';


--
-- Name: COLUMN content_translation.msgstr; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.content_translation.msgstr IS 'The translation';


--
-- Name: content_translation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.content_translation ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.content_translation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: core_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.core_session (
    id character varying(254) NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    anti_csrf_token text,
    key_hashed character varying(254) NOT NULL,
    auth_identity_id integer,
    expires_at timestamp with time zone
);


--
-- Name: COLUMN core_session.key_hashed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_session.key_hashed IS 'Hashed version of the session key';


--
-- Name: COLUMN core_session.auth_identity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_session.auth_identity_id IS 'Foreign key to auth_identity - tracks which auth method was used for login';


--
-- Name: COLUMN core_session.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_session.expires_at IS 'Timestamp when this session expires (from auth_identity or calculated)';


--
-- Name: core_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.core_user (
    id integer NOT NULL,
    email public.citext NOT NULL,
    first_name character varying(254),
    last_name character varying(254),
    password character varying(254),
    password_salt character varying(254) DEFAULT 'default'::character varying,
    date_joined timestamp with time zone NOT NULL,
    last_login timestamp with time zone,
    is_superuser boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    reset_token character varying(254),
    reset_triggered bigint,
    is_qbnewb boolean DEFAULT true NOT NULL,
    login_attributes text,
    updated_at timestamp with time zone,
    sso_source character varying(254),
    locale character varying(5),
    is_datasetnewb boolean DEFAULT true NOT NULL,
    settings text,
    type character varying(64) DEFAULT 'personal'::character varying NOT NULL,
    entity_id character(21),
    deactivated_at timestamp with time zone,
    tenant_id integer,
    jwt_attributes text,
    deactivated_with_tenant boolean
);


--
-- Name: COLUMN core_user.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.type IS 'The type of user';


--
-- Name: COLUMN core_user.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.entity_id IS 'NanoID tag for each user';


--
-- Name: COLUMN core_user.deactivated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.deactivated_at IS 'The timestamp at which a user was deactivated';


--
-- Name: COLUMN core_user.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.tenant_id IS 'The ID of the tenant for this user';


--
-- Name: COLUMN core_user.jwt_attributes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.jwt_attributes IS 'JSON object containing attributes set through jwt';


--
-- Name: COLUMN core_user.deactivated_with_tenant; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.core_user.deactivated_with_tenant IS 'if this user and its tenant are both deactivated, represents whether the user was deactivated
*with* the tenant (in which case it should be reactivated when the tenant is reactivated)
or was deactivated independently.';


--
-- Name: core_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.core_user ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.core_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: coupon_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_redemptions (
    id integer NOT NULL,
    coupon_id integer NOT NULL,
    user_id text NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now(),
    tokens_granted bigint NOT NULL
);


--
-- Name: coupon_redemptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupon_redemptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupon_redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupon_redemptions_id_seq OWNED BY public.coupon_redemptions.id;


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupons (
    id integer NOT NULL,
    code text NOT NULL,
    token_amount bigint DEFAULT 60000 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: coupons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupons_id_seq OWNED BY public.coupons.id;


--
-- Name: custom_chat_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_chat_history (
    id integer NOT NULL,
    session_id text NOT NULL,
    sender_type character varying(10) NOT NULL,
    agent integer,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    message_type character varying(20) DEFAULT 'text'::character varying NOT NULL,
    tokens_used integer DEFAULT 0,
    CONSTRAINT custom_chat_history_message_type_check CHECK (((message_type)::text = ANY (ARRAY[('text'::character varying)::text, ('image'::character varying)::text]))),
    CONSTRAINT custom_chat_history_sender_type_check CHECK (((sender_type)::text = ANY (ARRAY[('ai'::character varying)::text, ('human'::character varying)::text])))
);


--
-- Name: TABLE custom_chat_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.custom_chat_history IS 'Таблица для хранения истории чатов с поддержкой AI и человеческих сообщений';


--
-- Name: COLUMN custom_chat_history.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.id IS 'Уникальный идентификатор записи (автоинкремент)';


--
-- Name: COLUMN custom_chat_history.session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.session_id IS 'Идентификатор сессии чата';


--
-- Name: COLUMN custom_chat_history.sender_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.sender_type IS 'Тип сообщения: ai или human';


--
-- Name: COLUMN custom_chat_history.agent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.agent IS 'ID агента (может быть NULL для человеческих сообщений)';


--
-- Name: COLUMN custom_chat_history.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.content IS 'Содержимое сообщения';


--
-- Name: COLUMN custom_chat_history.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.custom_chat_history.created_at IS 'Время создания записи';


--
-- Name: custom_chat_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_chat_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_chat_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_chat_history_id_seq OWNED BY public.custom_chat_history.id;


--
-- Name: dashboard_bookmark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_bookmark (
    id integer NOT NULL,
    user_id integer NOT NULL,
    dashboard_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_bookmark_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dashboard_bookmark ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dashboard_bookmark_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dashboard_favorite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_favorite (
    id integer NOT NULL,
    user_id integer NOT NULL,
    dashboard_id integer NOT NULL
);


--
-- Name: dashboard_favorite_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dashboard_favorite ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dashboard_favorite_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dashboard_tab; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_tab (
    id integer NOT NULL,
    dashboard_id integer NOT NULL,
    name text NOT NULL,
    "position" integer NOT NULL,
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dashboard_tab; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dashboard_tab IS 'Join table connecting dashboard to dashboardcards';


--
-- Name: COLUMN dashboard_tab.dashboard_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab.dashboard_id IS 'The dashboard that a tab is on';


--
-- Name: COLUMN dashboard_tab.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab.name IS 'Displayed name of the tab';


--
-- Name: COLUMN dashboard_tab."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab."position" IS 'Position of the tab with respect to others tabs in dashboard';


--
-- Name: COLUMN dashboard_tab.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: COLUMN dashboard_tab.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab.created_at IS 'The timestamp at which the tab was created';


--
-- Name: COLUMN dashboard_tab.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dashboard_tab.updated_at IS 'The timestamp at which the tab was last updated';


--
-- Name: dashboard_tab_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dashboard_tab ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dashboard_tab_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dashboardcard_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboardcard_series (
    id integer NOT NULL,
    dashboardcard_id integer NOT NULL,
    card_id integer NOT NULL,
    "position" integer NOT NULL
);


--
-- Name: dashboardcard_series_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dashboardcard_series ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dashboardcard_series_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: data_edit_undo_chain; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_edit_undo_chain (
    id integer NOT NULL,
    batch_num integer NOT NULL,
    table_id integer NOT NULL,
    row_pk text NOT NULL,
    user_id integer NOT NULL,
    scope text NOT NULL,
    undoable boolean DEFAULT true NOT NULL,
    raw_before text,
    raw_after text,
    undone boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE data_edit_undo_chain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.data_edit_undo_chain IS 'Store the state necessary to power undo / redo.';


--
-- Name: COLUMN data_edit_undo_chain.batch_num; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.batch_num IS 'Batch number for grouped changes (global increment)';


--
-- Name: COLUMN data_edit_undo_chain.table_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.table_id IS 'Reference to the table being modified';


--
-- Name: COLUMN data_edit_undo_chain.row_pk; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.row_pk IS 'PK of the row being modified, potentially composite. Stored as a sorted JSON map.';


--
-- Name: COLUMN data_edit_undo_chain.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.user_id IS 'ID of the user who made the change';


--
-- Name: COLUMN data_edit_undo_chain.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.scope IS 'Identifies where the changes were made from';


--
-- Name: COLUMN data_edit_undo_chain.undoable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.undoable IS 'Identifies whether a change can be undo';


--
-- Name: COLUMN data_edit_undo_chain.raw_before; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.raw_before IS 'Value of the field before the change';


--
-- Name: COLUMN data_edit_undo_chain.raw_after; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.raw_after IS 'Value of the field after the change';


--
-- Name: COLUMN data_edit_undo_chain.undone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.undone IS 'Whether this change has been undone';


--
-- Name: COLUMN data_edit_undo_chain.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.created_at IS 'The timestamp of when the change was created';


--
-- Name: COLUMN data_edit_undo_chain.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_edit_undo_chain.updated_at IS 'The timestamp of when the change was updated';


--
-- Name: data_edit_undo_chain_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.data_edit_undo_chain ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.data_edit_undo_chain_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: data_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_permissions (
    id integer NOT NULL,
    group_id integer NOT NULL,
    perm_type character varying(64) NOT NULL,
    db_id integer NOT NULL,
    schema_name character varying(254),
    table_id integer,
    perm_value character varying(64) NOT NULL
);


--
-- Name: TABLE data_permissions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.data_permissions IS 'A table to store database and table permissions';


--
-- Name: COLUMN data_permissions.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.id IS 'The ID of the permission';


--
-- Name: COLUMN data_permissions.group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.group_id IS 'The ID of the associated permission group';


--
-- Name: COLUMN data_permissions.perm_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.perm_type IS 'The type of the permission (e.g. "data", "collection", "download"...)';


--
-- Name: COLUMN data_permissions.db_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.db_id IS 'A database ID, for DB and table-level permissions';


--
-- Name: COLUMN data_permissions.schema_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.schema_name IS 'A schema name, for table-level permissions';


--
-- Name: COLUMN data_permissions.table_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.table_id IS 'A table ID';


--
-- Name: COLUMN data_permissions.perm_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_permissions.perm_value IS 'The value this permission is set to.';


--
-- Name: data_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.data_permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.data_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: databasechangelog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.databasechangelog (
    id character varying(255) NOT NULL,
    author character varying(255) NOT NULL,
    filename character varying(255) NOT NULL,
    dateexecuted timestamp without time zone NOT NULL,
    orderexecuted integer NOT NULL,
    exectype character varying(10) NOT NULL,
    md5sum character varying(35),
    description character varying(255),
    comments character varying(255),
    tag character varying(255),
    liquibase character varying(20),
    contexts character varying(255),
    labels character varying(255),
    deployment_id character varying(10)
);


--
-- Name: db_router; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.db_router (
    id integer NOT NULL,
    database_id integer NOT NULL,
    user_attribute character varying(254) NOT NULL
);


--
-- Name: TABLE db_router; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.db_router IS 'Configuration for Database Routers. Currently just holds which user attribute each
configured router database should use to choose a mirror database to route to.';


--
-- Name: COLUMN db_router.database_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.db_router.database_id IS 'The ID of the database this is for.';


--
-- Name: COLUMN db_router.user_attribute; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.db_router.user_attribute IS 'The user attribute used to redirect users to a different database.';


--
-- Name: db_router_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.db_router ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.db_router_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dependency (
    id integer NOT NULL,
    from_entity_type character varying(20) NOT NULL,
    from_entity_id integer NOT NULL,
    to_entity_type character varying(20) NOT NULL,
    to_entity_id integer NOT NULL
);


--
-- Name: TABLE dependency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dependency IS 'A table to track dependencies between Metabase entities';


--
-- Name: COLUMN dependency.from_entity_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dependency.from_entity_type IS 'The type of the dependent entity';


--
-- Name: COLUMN dependency.from_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dependency.from_entity_id IS 'The ID of the dependent entity';


--
-- Name: COLUMN dependency.to_entity_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dependency.to_entity_type IS 'The type of the entity depended on';


--
-- Name: COLUMN dependency.to_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dependency.to_entity_id IS 'The ID of the entity depended on';


--
-- Name: dependency_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dependency ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dependency_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dimension; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dimension (
    id integer NOT NULL,
    field_id integer NOT NULL,
    name character varying(254) NOT NULL,
    type character varying(254) NOT NULL,
    human_readable_field_id integer,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    entity_id character(21)
);


--
-- Name: dimension_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dimension ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dimension_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document (
    id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    document text,
    content_type text NOT NULL,
    creator_id integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    collection_id integer,
    archived boolean DEFAULT false NOT NULL,
    archived_directly boolean DEFAULT false,
    entity_id character(21),
    last_viewed_at timestamp with time zone DEFAULT now() NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    collection_position integer,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL,
    public_uuid character(36),
    made_public_by_id integer
);


--
-- Name: TABLE document; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document IS 'Documents table';


--
-- Name: COLUMN document.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.id IS 'Unique ID';


--
-- Name: COLUMN document.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.name IS 'Document name';


--
-- Name: COLUMN document.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.created_at IS 'The timestamp of when the document was created';


--
-- Name: COLUMN document.document; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.document IS 'content of the document';


--
-- Name: COLUMN document.content_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.content_type IS 'the content_type of the document column';


--
-- Name: COLUMN document.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.creator_id IS 'User who created this document';


--
-- Name: COLUMN document.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.updated_at IS 'The timestamp of when the document was updated';


--
-- Name: COLUMN document.collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.collection_id IS 'What collection I live in. Null if it''s Our Analytics.';


--
-- Name: COLUMN document.archived; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.archived IS 'Has this document been archived?';


--
-- Name: COLUMN document.archived_directly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.archived_directly IS 'Was this thing trashed directly';


--
-- Name: COLUMN document.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.entity_id IS 'Random NanoID tag for unique identity';


--
-- Name: COLUMN document.last_viewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.last_viewed_at IS 'Timestamp of when this document was last viewed';


--
-- Name: COLUMN document.view_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.view_count IS 'Keeps a running count of document views';


--
-- Name: COLUMN document.collection_position; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.collection_position IS 'Collection position used for pinning documents. Higher numbers = pinned, null = not pinned.';


--
-- Name: COLUMN document.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: COLUMN document.public_uuid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.public_uuid IS 'UUID for publicly-accessible version of this document';


--
-- Name: COLUMN document.made_public_by_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document.made_public_by_id IS 'ID of the user who made this document public';


--
-- Name: document_bookmark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_bookmark (
    id integer NOT NULL,
    user_id integer NOT NULL,
    document_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE document_bookmark; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_bookmark IS 'Store user bookmarks for documents';


--
-- Name: COLUMN document_bookmark.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_bookmark.id IS 'Unique ID';


--
-- Name: COLUMN document_bookmark.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_bookmark.user_id IS 'User who bookmarked the document';


--
-- Name: COLUMN document_bookmark.document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_bookmark.document_id IS 'The document that was bookmarked';


--
-- Name: COLUMN document_bookmark.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_bookmark.created_at IS 'The timestamp when the bookmark was created';


--
-- Name: document_bookmark_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.document_bookmark ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.document_bookmark_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.document ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.document_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dozvon_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dozvon_calls (
    id bigint NOT NULL,
    campaign_id bigint NOT NULL,
    contact_name text,
    phone text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    transcript text,
    summary text,
    recording_url text,
    duration_sec integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tokens_spent bigint DEFAULT 0 NOT NULL
);


--
-- Name: dozvon_calls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dozvon_calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dozvon_calls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dozvon_calls_id_seq OWNED BY public.dozvon_calls.id;


--
-- Name: dozvon_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dozvon_campaigns (
    id bigint NOT NULL,
    user_id text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    task_text text,
    call_plan jsonb,
    summary jsonb,
    voice_id text,
    system_prompt text,
    scheduled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text DEFAULT 'Новая задача'::text
);


--
-- Name: dozvon_campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dozvon_campaigns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dozvon_campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dozvon_campaigns_id_seq OWNED BY public.dozvon_campaigns.id;


--
-- Name: dozvon_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dozvon_contacts (
    id bigint NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dozvon_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dozvon_contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dozvon_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dozvon_contacts_id_seq OWNED BY public.dozvon_contacts.id;


--
-- Name: dozvon_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dozvon_pricing (
    id integer NOT NULL,
    setup_fee integer DEFAULT 2000 NOT NULL,
    per_minute_fee integer DEFAULT 3000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dozvon_pricing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dozvon_pricing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dozvon_pricing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dozvon_pricing_id_seq OWNED BY public.dozvon_pricing.id;


--
-- Name: dozvon_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dozvon_settings (
    user_id text NOT NULL,
    voice_id text DEFAULT 'default'::text NOT NULL,
    system_prompt text,
    agent_name text DEFAULT 'Алина'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: field_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_usage (
    id integer NOT NULL,
    field_id integer NOT NULL,
    query_execution_id integer NOT NULL,
    used_in character varying(25) NOT NULL,
    filter_op character varying(25),
    aggregation_function character varying(25),
    breakout_temporal_unit character varying(25),
    breakout_binning_strategy character varying(25),
    breakout_binning_num_bins integer,
    breakout_binning_bin_width integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE field_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.field_usage IS 'Used to store field usage during query execution';


--
-- Name: COLUMN field_usage.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.id IS 'Unique ID';


--
-- Name: COLUMN field_usage.field_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.field_id IS 'ID of the field';


--
-- Name: COLUMN field_usage.query_execution_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.query_execution_id IS 'referenced query execution';


--
-- Name: COLUMN field_usage.used_in; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.used_in IS 'which part of the query the field was used in';


--
-- Name: COLUMN field_usage.filter_op; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.filter_op IS 'filter''s operator that applied to the field';


--
-- Name: COLUMN field_usage.aggregation_function; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.aggregation_function IS 'the aggregation function that field applied to';


--
-- Name: COLUMN field_usage.breakout_temporal_unit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.breakout_temporal_unit IS 'temporal unit options of the breakout';


--
-- Name: COLUMN field_usage.breakout_binning_strategy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.breakout_binning_strategy IS 'the strategy of breakout';


--
-- Name: COLUMN field_usage.breakout_binning_num_bins; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.breakout_binning_num_bins IS 'The numbin option of breakout';


--
-- Name: COLUMN field_usage.breakout_binning_bin_width; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.breakout_binning_bin_width IS 'The numbin option of breakout';


--
-- Name: COLUMN field_usage.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.field_usage.created_at IS 'The time a field usage was recorded';


--
-- Name: field_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.field_usage ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.field_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: findmate_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.findmate_histories (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: findmate_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.findmate_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: findmate_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.findmate_histories_id_seq OWNED BY public.findmate_histories.id;


--
-- Name: game_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_sessions (
    id integer NOT NULL,
    user_id text NOT NULL,
    session_type text NOT NULL,
    current_sphere text,
    cards_shown jsonb DEFAULT '[]'::jsonb,
    session_state text DEFAULT 'active'::text,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    last_activity timestamp with time zone DEFAULT now()
);


--
-- Name: game_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.game_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: game_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.game_sessions_id_seq OWNED BY public.game_sessions.id;


--
-- Name: generated_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_images (
    id integer NOT NULL,
    user_id text NOT NULL,
    prompt text NOT NULL,
    image_url text NOT NULL,
    tokens_spent integer DEFAULT 5000,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: generated_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generated_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generated_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generated_images_id_seq OWNED BY public.generated_images.id;


--
-- Name: glossary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.glossary (
    id integer NOT NULL,
    term character varying(255) NOT NULL,
    definition text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    creator_id integer DEFAULT 13371338 NOT NULL
);


--
-- Name: TABLE glossary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.glossary IS 'Table to store glossary terms and their definitions';


--
-- Name: COLUMN glossary.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.id IS 'Primary key identifier for glossary entries';


--
-- Name: COLUMN glossary.term; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.term IS 'The glossary term or phrase being defined';


--
-- Name: COLUMN glossary.definition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.definition IS 'The detailed definition or explanation of the term';


--
-- Name: COLUMN glossary.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.created_at IS 'Timestamp when comment was created';


--
-- Name: COLUMN glossary.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.updated_at IS 'Timestamp when comment was last updated';


--
-- Name: COLUMN glossary.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.glossary.creator_id IS 'User who created this glossary entry';


--
-- Name: glossary_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.glossary ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.glossary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sandboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandboxes (
    id integer NOT NULL,
    group_id integer NOT NULL,
    table_id integer NOT NULL,
    card_id integer,
    attribute_remappings text,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN sandboxes.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sandboxes.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: group_table_access_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sandboxes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.group_table_access_policy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: http_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.http_action (
    action_id integer NOT NULL,
    template text NOT NULL,
    response_handle text,
    error_handle text
);


--
-- Name: TABLE http_action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.http_action IS 'An http api call type of action';


--
-- Name: COLUMN http_action.action_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.http_action.action_id IS 'The related action';


--
-- Name: COLUMN http_action.template; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.http_action.template IS 'A template that defines method,url,body,headers required to make an api call';


--
-- Name: COLUMN http_action.response_handle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.http_action.response_handle IS 'A program to take an api response and transform to an appropriate response for emitters';


--
-- Name: COLUMN http_action.error_handle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.http_action.error_handle IS 'A program to take an api response to determine if an error occurred';


--
-- Name: implicit_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.implicit_action (
    action_id integer NOT NULL,
    kind text NOT NULL
);


--
-- Name: TABLE implicit_action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.implicit_action IS 'An action with dynamic parameters based on the underlying model';


--
-- Name: COLUMN implicit_action.action_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.implicit_action.action_id IS 'The associated action';


--
-- Name: COLUMN implicit_action.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.implicit_action.kind IS 'The kind of implicit action create/update/delete';


--
-- Name: label; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.label (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    slug character varying(254) NOT NULL,
    icon character varying(128)
);


--
-- Name: label_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.label ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.label_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: llm_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_pricing (
    id integer NOT NULL,
    model character varying(255) NOT NULL,
    completion_token_price numeric(20,10) NOT NULL,
    prompt_token_price numeric(20,10) NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE llm_pricing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.llm_pricing IS 'Таблица для хранения цен на LLM модели из OpenRouter';


--
-- Name: COLUMN llm_pricing.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.llm_pricing.model IS 'Идентификатор модели (например, openai/gpt-4)';


--
-- Name: COLUMN llm_pricing.completion_token_price; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.llm_pricing.completion_token_price IS 'Цена за токен completion в долларах';


--
-- Name: COLUMN llm_pricing.prompt_token_price; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.llm_pricing.prompt_token_price IS 'Цена за токен prompt в долларах';


--
-- Name: COLUMN llm_pricing.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.llm_pricing.updated_at IS 'Время последнего обновления записи';


--
-- Name: COLUMN llm_pricing.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.llm_pricing.created_at IS 'Время создания записи';


--
-- Name: llm_pricing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.llm_pricing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_pricing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.llm_pricing_id_seq OWNED BY public.llm_pricing.id;


--
-- Name: login_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_history (
    id integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer NOT NULL,
    session_id character varying(254),
    device_id character(36) NOT NULL,
    device_description text NOT NULL,
    ip_address text NOT NULL
);


--
-- Name: login_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.login_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.login_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabase_cluster_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_cluster_lock (
    lock_name character varying(254) NOT NULL
);


--
-- Name: TABLE metabase_cluster_lock; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabase_cluster_lock IS 'A table to allow metabase instances to take locks across a cluster';


--
-- Name: COLUMN metabase_cluster_lock.lock_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_cluster_lock.lock_name IS 'a single column that can be used to a lock across a cluster';


--
-- Name: metabase_database; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_database (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    details text NOT NULL,
    engine character varying(254) NOT NULL,
    is_sample boolean DEFAULT false NOT NULL,
    is_full_sync boolean DEFAULT true NOT NULL,
    points_of_interest text,
    caveats text,
    metadata_sync_schedule character varying(254) DEFAULT '0 50 * * * ? *'::character varying NOT NULL,
    cache_field_values_schedule character varying(254) DEFAULT NULL::character varying,
    timezone character varying(254),
    is_on_demand boolean DEFAULT false NOT NULL,
    auto_run_queries boolean DEFAULT true NOT NULL,
    refingerprint boolean,
    cache_ttl integer,
    initial_sync_status character varying(32) DEFAULT 'complete'::character varying NOT NULL,
    creator_id integer,
    settings text,
    dbms_version text,
    is_audit boolean DEFAULT false NOT NULL,
    uploads_enabled boolean DEFAULT false NOT NULL,
    uploads_schema_name text,
    uploads_table_prefix text,
    is_attached_dwh boolean DEFAULT false NOT NULL,
    router_database_id integer,
    provider_name character varying(100)
);


--
-- Name: COLUMN metabase_database.dbms_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.dbms_version IS 'A JSON object describing the flavor and version of the DBMS.';


--
-- Name: COLUMN metabase_database.is_audit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.is_audit IS 'Only the app db, visible to admins via auditing should have this set true.';


--
-- Name: COLUMN metabase_database.uploads_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.uploads_enabled IS 'Whether uploads are enabled for this database';


--
-- Name: COLUMN metabase_database.uploads_schema_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.uploads_schema_name IS 'The schema name for uploads';


--
-- Name: COLUMN metabase_database.uploads_table_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.uploads_table_prefix IS 'The prefix for upload table names';


--
-- Name: COLUMN metabase_database.is_attached_dwh; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.is_attached_dwh IS 'This is an attached data warehouse, do not serialize it and hide its details from the UI';


--
-- Name: COLUMN metabase_database.router_database_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.router_database_id IS 'The ID of the primary database for this mirror database.';


--
-- Name: COLUMN metabase_database.provider_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_database.provider_name IS 'The name of the hosting provider for the database (e.g., AWS RDS, Azure).';


--
-- Name: metabase_database_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabase_database ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabase_database_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabase_field; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_field (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    name character varying(254) NOT NULL,
    base_type character varying(255) NOT NULL,
    semantic_type character varying(255),
    active boolean DEFAULT true NOT NULL,
    description text,
    preview_display boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    table_id integer NOT NULL,
    parent_id integer,
    display_name character varying(254),
    visibility_type character varying(32) DEFAULT 'normal'::character varying NOT NULL,
    fk_target_field_id integer,
    last_analyzed timestamp with time zone,
    points_of_interest text,
    caveats text,
    fingerprint text,
    fingerprint_version integer DEFAULT 0 NOT NULL,
    database_type text NOT NULL,
    has_field_values text,
    settings text,
    database_position integer DEFAULT 0 NOT NULL,
    custom_position integer DEFAULT 0 NOT NULL,
    effective_type character varying(255),
    coercion_strategy character varying(255),
    nfc_path character varying(254),
    database_required boolean DEFAULT false NOT NULL,
    json_unfolding boolean DEFAULT false NOT NULL,
    database_is_auto_increment boolean DEFAULT false NOT NULL,
    database_indexed boolean,
    database_partitioned boolean,
    is_defective_duplicate boolean DEFAULT false NOT NULL,
    unique_field_helper integer GENERATED ALWAYS AS (
CASE
    WHEN (is_defective_duplicate = true) THEN NULL::integer
    ELSE
    CASE
        WHEN (parent_id IS NULL) THEN 0
        ELSE parent_id
    END
END) STORED,
    database_is_pk boolean,
    database_is_nullable boolean,
    database_is_generated boolean,
    database_default text
);


--
-- Name: COLUMN metabase_field.json_unfolding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.json_unfolding IS 'Enable/disable JSON unfolding for a field';


--
-- Name: COLUMN metabase_field.database_is_auto_increment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_is_auto_increment IS 'Indicates this field is auto incremented';


--
-- Name: COLUMN metabase_field.database_indexed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_indexed IS 'If the database supports indexing, this column indicate whether or not a field is indexed, or is the 1st column in a composite index';


--
-- Name: COLUMN metabase_field.database_partitioned; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_partitioned IS 'Whether the table is partitioned by this field';


--
-- Name: COLUMN metabase_field.is_defective_duplicate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.is_defective_duplicate IS 'Indicates whether column is a defective duplicate field that should never have been created.';


--
-- Name: COLUMN metabase_field.database_is_pk; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_is_pk IS 'Whether or not the field is part of the primary key (not user editable like semantic_type)';


--
-- Name: COLUMN metabase_field.database_is_nullable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_is_nullable IS 'Whether or not the field will accept nulls';


--
-- Name: COLUMN metabase_field.database_is_generated; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_is_generated IS 'Whether or not the column is computed and will not accept writes';


--
-- Name: COLUMN metabase_field.database_default; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field.database_default IS 'The dialect specific column default expression';


--
-- Name: metabase_field_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabase_field ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabase_field_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabase_field_user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_field_user_settings (
    field_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    semantic_type character varying(254),
    description text,
    display_name character varying(254),
    visibility_type character varying(32),
    fk_target_field_id integer,
    has_field_values text,
    effective_type character varying(255),
    coercion_strategy character varying(255),
    caveats text,
    points_of_interest text,
    nfc_path character varying(254),
    json_unfolding boolean,
    settings text
);


--
-- Name: TABLE metabase_field_user_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabase_field_user_settings IS 'Mirror table of metabase_field to keep track of user-set values (only settable fields are mirrored)';


--
-- Name: COLUMN metabase_field_user_settings.field_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.field_id IS 'The related Field';


--
-- Name: COLUMN metabase_field_user_settings.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.created_at IS 'The timestamp of when the user setting was created';


--
-- Name: COLUMN metabase_field_user_settings.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.updated_at IS 'The timestamp of when the user setting was updated';


--
-- Name: COLUMN metabase_field_user_settings.semantic_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.semantic_type IS 'User-set semantic_type for the Field';


--
-- Name: COLUMN metabase_field_user_settings.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.description IS 'User-set description for the Field';


--
-- Name: COLUMN metabase_field_user_settings.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.display_name IS 'User-set display_name for the Field';


--
-- Name: COLUMN metabase_field_user_settings.visibility_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.visibility_type IS 'User-set visibility_type for the Field';


--
-- Name: COLUMN metabase_field_user_settings.fk_target_field_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.fk_target_field_id IS 'User-set fk_target_field_id for the Field';


--
-- Name: COLUMN metabase_field_user_settings.has_field_values; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.has_field_values IS 'User-set has_field_values for the Field';


--
-- Name: COLUMN metabase_field_user_settings.effective_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.effective_type IS 'User-set effective_type for the Field';


--
-- Name: COLUMN metabase_field_user_settings.coercion_strategy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.coercion_strategy IS 'User-set coercion_strategy for the Field';


--
-- Name: COLUMN metabase_field_user_settings.caveats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.caveats IS 'User-set caveats for the Field';


--
-- Name: COLUMN metabase_field_user_settings.points_of_interest; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.points_of_interest IS 'User-set points_of_interest for the Field';


--
-- Name: COLUMN metabase_field_user_settings.nfc_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.nfc_path IS 'User-set nfc_path for the Field';


--
-- Name: COLUMN metabase_field_user_settings.json_unfolding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.json_unfolding IS 'User-set json_unfolding for the Field';


--
-- Name: COLUMN metabase_field_user_settings.settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_field_user_settings.settings IS 'User-set settings for the Field';


--
-- Name: metabase_fieldvalues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_fieldvalues (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    "values" text,
    human_readable_values text,
    field_id integer NOT NULL,
    has_more_values boolean DEFAULT false,
    type character varying(32) DEFAULT 'full'::character varying NOT NULL,
    hash_key text,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN metabase_fieldvalues.last_used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_fieldvalues.last_used_at IS 'Timestamp of when these FieldValues were last used.';


--
-- Name: metabase_fieldvalues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabase_fieldvalues ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabase_fieldvalues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabase_table; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabase_table (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    name character varying(256) NOT NULL,
    description text,
    entity_type character varying(254),
    active boolean NOT NULL,
    db_id integer NOT NULL,
    display_name character varying(256),
    visibility_type character varying(254),
    schema character varying(254),
    points_of_interest text,
    caveats text,
    show_in_getting_started boolean DEFAULT false NOT NULL,
    field_order character varying(254) DEFAULT 'database'::character varying NOT NULL,
    initial_sync_status character varying(32) DEFAULT 'complete'::character varying NOT NULL,
    is_upload boolean DEFAULT false NOT NULL,
    database_require_filter boolean,
    estimated_row_count bigint,
    view_count integer DEFAULT 0 NOT NULL,
    is_defective_duplicate boolean DEFAULT false NOT NULL,
    unique_table_helper character varying(254) GENERATED ALWAYS AS (
CASE
    WHEN (is_defective_duplicate = true) THEN NULL::character varying
    ELSE COALESCE(schema, ''::character varying)
END) STORED,
    deactivated_at timestamp with time zone,
    archived_at timestamp with time zone,
    is_writable boolean,
    data_authority character varying(20) DEFAULT 'unconfigured'::character varying NOT NULL,
    data_source character varying(254),
    data_layer character varying(254),
    owner_email text,
    owner_user_id integer,
    collection_id integer,
    is_published boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN metabase_table.is_upload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.is_upload IS 'Was the table created from user-uploaded (i.e., from a CSV) data?';


--
-- Name: COLUMN metabase_table.database_require_filter; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.database_require_filter IS 'If true, the table requires a filter to be able to query it';


--
-- Name: COLUMN metabase_table.estimated_row_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.estimated_row_count IS 'The estimated row count';


--
-- Name: COLUMN metabase_table.view_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.view_count IS 'Keeps a running count of card views';


--
-- Name: COLUMN metabase_table.is_defective_duplicate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.is_defective_duplicate IS 'Indicates whether the table is a defective duplicate that should never have been created.';


--
-- Name: COLUMN metabase_table.deactivated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.deactivated_at IS 'The timestamp when the table was deactivated (active changed from true to false)';


--
-- Name: COLUMN metabase_table.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.archived_at IS 'The timestamp when the table was marked for archiving';


--
-- Name: COLUMN metabase_table.is_writable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.is_writable IS 'true if current connection can insert, update and delete rows from this table';


--
-- Name: COLUMN metabase_table.data_authority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.data_authority IS 'Indicates the data authority status - unconfigured, authoritative, computed, or ingested';


--
-- Name: COLUMN metabase_table.data_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.data_source IS 'The origin type of the data (e.g. metabase-transform)';


--
-- Name: COLUMN metabase_table.data_layer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.data_layer IS 'The (new) enum for visibility class';


--
-- Name: COLUMN metabase_table.owner_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.owner_email IS 'An optional email address of the ''owner'' of this table, exclusive with owner_user_id.';


--
-- Name: COLUMN metabase_table.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.owner_user_id IS 'An (metabase) user id of the ''owner'' of this table, exclusive with owner_email.';


--
-- Name: COLUMN metabase_table.collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.collection_id IS 'The collection this table is published to (null if not published or published to root)';


--
-- Name: COLUMN metabase_table.is_published; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabase_table.is_published IS 'Whether this table is published';


--
-- Name: metabase_table_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabase_table ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabase_table_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabot (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    use_verified_content boolean DEFAULT false,
    collection_id integer
);


--
-- Name: TABLE metabot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabot IS 'Metabot configuration';


--
-- Name: COLUMN metabot.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.name IS 'The name of the metabot';


--
-- Name: COLUMN metabot.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.description IS 'Description of the metabot';


--
-- Name: COLUMN metabot.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.entity_id IS 'Random NanoID tag for unique identity';


--
-- Name: COLUMN metabot.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.created_at IS 'The timestamp of when the metabot was created';


--
-- Name: COLUMN metabot.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.updated_at IS 'The timestamp of when the metabot was updated';


--
-- Name: COLUMN metabot.use_verified_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.use_verified_content IS 'Whether this metabot should only use verified content';


--
-- Name: COLUMN metabot.collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot.collection_id IS 'ID of the collection this metabot can access';


--
-- Name: metabot_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabot_conversation (
    id character varying(36) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer NOT NULL,
    summary text,
    state text
);


--
-- Name: TABLE metabot_conversation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabot_conversation IS 'Table to store metabot conversation messages';


--
-- Name: COLUMN metabot_conversation.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_conversation.id IS 'Conversation UUID';


--
-- Name: COLUMN metabot_conversation.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_conversation.created_at IS 'created_at';


--
-- Name: COLUMN metabot_conversation.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_conversation.user_id IS 'Reference to user having the conversation';


--
-- Name: COLUMN metabot_conversation.summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_conversation.summary IS 'Auto-generated summary for the conversation';


--
-- Name: COLUMN metabot_conversation.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_conversation.state IS 'Metabot conversation state';


--
-- Name: metabot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabot ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabot_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabot_message (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    profile_id text NOT NULL,
    role character varying(20) NOT NULL,
    data text NOT NULL,
    usage text,
    total_tokens integer NOT NULL,
    conversation_id character varying(36) NOT NULL
);


--
-- Name: TABLE metabot_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabot_message IS 'Table to store metabot conversation messages';


--
-- Name: COLUMN metabot_message.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.id IS 'Autoincrement PK';


--
-- Name: COLUMN metabot_message.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.created_at IS 'created_at';


--
-- Name: COLUMN metabot_message.profile_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.profile_id IS 'ai-service profile used to perform the conversation';


--
-- Name: COLUMN metabot_message.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.role IS 'Role of the sender';


--
-- Name: COLUMN metabot_message.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.data IS 'Full message content';


--
-- Name: COLUMN metabot_message.usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.usage IS 'Can be null for user messages; {"<model-name>": {"prompt": 1, "completion": 2}}';


--
-- Name: COLUMN metabot_message.total_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.total_tokens IS 'A sum of all prompt+completion from `usage`';


--
-- Name: COLUMN metabot_message.conversation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_message.conversation_id IS 'Reference to a conversation';


--
-- Name: metabot_message_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabot_message ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabot_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metabot_prompt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metabot_prompt (
    id integer NOT NULL,
    model character varying(32) NOT NULL,
    card_id integer NOT NULL,
    entity_id character(21),
    prompt text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metabot_id integer NOT NULL
);


--
-- Name: TABLE metabot_prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.metabot_prompt IS 'Prompts of a metabot entity';


--
-- Name: COLUMN metabot_prompt.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.model IS 'The type of the entity this prompt is about';


--
-- Name: COLUMN metabot_prompt.card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.card_id IS 'The ID of the model or metric this prompt is about';


--
-- Name: COLUMN metabot_prompt.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.entity_id IS 'Random NanoID tag for unique identity';


--
-- Name: COLUMN metabot_prompt.prompt; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.prompt IS 'The text of the prompt';


--
-- Name: COLUMN metabot_prompt.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.created_at IS 'The timestamp of when the prompt was created';


--
-- Name: COLUMN metabot_prompt.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.updated_at IS 'The timestamp of when the prompt was updated';


--
-- Name: COLUMN metabot_prompt.metabot_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.metabot_prompt.metabot_id IS 'The metabot this prompt is associated with';


--
-- Name: metabot_prompt_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metabot_prompt ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metabot_prompt_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metaphor_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metaphor_cards (
    id integer NOT NULL,
    category text NOT NULL,
    image_url text NOT NULL,
    card_number integer NOT NULL,
    description text,
    keywords jsonb,
    created_at timestamp with time zone DEFAULT now(),
    filename text
);


--
-- Name: metaphor_cards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metaphor_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metaphor_cards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metaphor_cards_id_seq OWNED BY public.metaphor_cards.id;


--
-- Name: metric; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metric (
    id integer NOT NULL,
    table_id integer NOT NULL,
    creator_id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    archived boolean DEFAULT false NOT NULL,
    definition text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    points_of_interest text,
    caveats text,
    how_is_this_calculated text,
    show_in_getting_started boolean DEFAULT false NOT NULL,
    entity_id character(21)
);


--
-- Name: metric_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metric ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metric_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: metric_important_field; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metric_important_field (
    id integer NOT NULL,
    metric_id integer NOT NULL,
    field_id integer NOT NULL
);


--
-- Name: metric_important_field_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.metric_important_field ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.metric_important_field_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: model_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_index (
    id integer NOT NULL,
    model_id integer,
    pk_ref text NOT NULL,
    value_ref text NOT NULL,
    schedule text NOT NULL,
    state text NOT NULL,
    indexed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    creator_id integer NOT NULL
);


--
-- Name: TABLE model_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.model_index IS 'Used to keep track of which models have indexed columns.';


--
-- Name: COLUMN model_index.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.model_id IS 'The ID of the indexed model.';


--
-- Name: COLUMN model_index.pk_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.pk_ref IS 'Serialized JSON of the primary key field ref.';


--
-- Name: COLUMN model_index.value_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.value_ref IS 'Serialized JSON of the label field ref.';


--
-- Name: COLUMN model_index.schedule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.schedule IS 'The cron schedule for when value syncing should happen.';


--
-- Name: COLUMN model_index.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.state IS 'The status of the index: initializing, indexed, error, overflow.';


--
-- Name: COLUMN model_index.indexed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.indexed_at IS 'When the status changed';


--
-- Name: COLUMN model_index.error; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.error IS 'The error message if the status is error.';


--
-- Name: COLUMN model_index.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.created_at IS 'The timestamp of when these changes were made.';


--
-- Name: COLUMN model_index.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index.creator_id IS 'ID of the user who created the event';


--
-- Name: model_index_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.model_index ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.model_index_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: model_index_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_index_value (
    model_index_id integer,
    model_pk bigint NOT NULL,
    name text NOT NULL
);


--
-- Name: TABLE model_index_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.model_index_value IS 'Used to keep track of the values indexed in a model';


--
-- Name: COLUMN model_index_value.model_index_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index_value.model_index_id IS 'The ID of the indexed model.';


--
-- Name: COLUMN model_index_value.model_pk; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index_value.model_pk IS 'The primary key of the indexed value';


--
-- Name: COLUMN model_index_value.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_index_value.name IS 'The label to display identifying the indexed value.';


--
-- Name: moderation_review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moderation_review (
    id integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(255),
    text text,
    moderated_item_id integer NOT NULL,
    moderated_item_type character varying(255) NOT NULL,
    moderator_id integer NOT NULL,
    most_recent boolean NOT NULL
);


--
-- Name: moderation_review_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.moderation_review ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.moderation_review_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: n8n_chat_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.n8n_chat_histories (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: n8n_chat_histories_avia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.n8n_chat_histories_avia (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: n8n_chat_histories_avia_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.n8n_chat_histories_avia_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_chat_histories_avia_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.n8n_chat_histories_avia_id_seq OWNED BY public.n8n_chat_histories_avia.id;


--
-- Name: n8n_chat_histories_cop; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.n8n_chat_histories_cop (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: n8n_chat_histories_cop_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.n8n_chat_histories_cop_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_chat_histories_cop_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.n8n_chat_histories_cop_id_seq OWNED BY public.n8n_chat_histories_cop.id;


--
-- Name: n8n_chat_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.n8n_chat_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_chat_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.n8n_chat_histories_id_seq OWNED BY public.n8n_chat_histories.id;


--
-- Name: n8n_chat_histories_travel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.n8n_chat_histories_travel (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: n8n_chat_histories_travel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.n8n_chat_histories_travel_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_chat_histories_travel_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.n8n_chat_histories_travel_id_seq OWNED BY public.n8n_chat_histories_travel.id;


--
-- Name: n8n_chat_histories_yasha; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.n8n_chat_histories_yasha (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: n8n_chat_histories_yasha_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.n8n_chat_histories_yasha_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: n8n_chat_histories_yasha_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.n8n_chat_histories_yasha_id_seq OWNED BY public.n8n_chat_histories_yasha.id;


--
-- Name: native_query_snippet; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.native_query_snippet (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    content text NOT NULL,
    creator_id integer NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    collection_id integer,
    entity_id character(21),
    template_tags text,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN native_query_snippet.template_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.native_query_snippet.template_tags IS 'Template tags for the snippet';


--
-- Name: COLUMN native_query_snippet.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.native_query_snippet.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: native_query_snippet_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.native_query_snippet ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.native_query_snippet_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification (
    id integer NOT NULL,
    payload_type character varying(64) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    internal_id character varying(254),
    payload_id integer,
    creator_id integer
);


--
-- Name: TABLE notification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification IS 'join table that connect notification subscriptions and notification handlers';


--
-- Name: COLUMN notification.payload_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.payload_type IS 'the type of the payload';


--
-- Name: COLUMN notification.active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.active IS 'whether the notification is active';


--
-- Name: COLUMN notification.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.created_at IS 'The timestamp of when the notification was created';


--
-- Name: COLUMN notification.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.updated_at IS 'The timestamp of when the notification was updated';


--
-- Name: COLUMN notification.internal_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.internal_id IS 'the internal id of the notification';


--
-- Name: COLUMN notification.payload_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.payload_id IS 'the internal id of the notification';


--
-- Name: COLUMN notification.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification.creator_id IS 'the id of the creator';


--
-- Name: notification_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_card (
    id integer NOT NULL,
    card_id integer,
    send_once boolean DEFAULT false NOT NULL,
    send_condition character varying(32) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_card; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_card IS 'Card related notifications';


--
-- Name: COLUMN notification_card.card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_card.card_id IS 'the card that the alert is connected to';


--
-- Name: COLUMN notification_card.send_once; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_card.send_once IS 'whether the alert should only run once';


--
-- Name: COLUMN notification_card.send_condition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_card.send_condition IS 'the condition of the alert';


--
-- Name: COLUMN notification_card.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_card.created_at IS 'The timestamp of when the recipient was created';


--
-- Name: COLUMN notification_card.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_card.updated_at IS 'The timestamp of when the recipient was updated';


--
-- Name: notification_card_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification_card ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_card_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_handler; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_handler (
    id integer NOT NULL,
    channel_type character varying(64) NOT NULL,
    notification_id integer NOT NULL,
    channel_id integer,
    template_id integer,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_handler; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_handler IS 'which channel to send the notification to';


--
-- Name: COLUMN notification_handler.channel_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.channel_type IS 'the type of the channel, like :channel/email, :channel/slack';


--
-- Name: COLUMN notification_handler.notification_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.notification_id IS 'the notification that the handler is connected to';


--
-- Name: COLUMN notification_handler.channel_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.channel_id IS 'the channel that the handler is connected to';


--
-- Name: COLUMN notification_handler.template_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.template_id IS 'the template that the handler is connected to';


--
-- Name: COLUMN notification_handler.active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.active IS 'whether the handler is active';


--
-- Name: COLUMN notification_handler.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.created_at IS 'The timestamp of when the handler was created';


--
-- Name: COLUMN notification_handler.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_handler.updated_at IS 'The timestamp of when the handler was updated';


--
-- Name: notification_handler_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification_handler ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_handler_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_recipient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_recipient (
    id integer NOT NULL,
    notification_handler_id integer NOT NULL,
    type character varying(64) NOT NULL,
    user_id integer,
    permissions_group_id integer,
    details text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_recipient; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_recipient IS 'who should receive the notification';


--
-- Name: COLUMN notification_recipient.notification_handler_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.notification_handler_id IS 'the handler that the recipient is connected to';


--
-- Name: COLUMN notification_recipient.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.type IS 'the type of the recipient';


--
-- Name: COLUMN notification_recipient.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.user_id IS 'a user if the recipient has type user';


--
-- Name: COLUMN notification_recipient.permissions_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.permissions_group_id IS 'a permissions group if the recipient has type permissions_group';


--
-- Name: COLUMN notification_recipient.details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.details IS 'custom details for the recipient';


--
-- Name: COLUMN notification_recipient.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.created_at IS 'The timestamp of when the recipient was created';


--
-- Name: COLUMN notification_recipient.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_recipient.updated_at IS 'The timestamp of when the recipient was updated';


--
-- Name: notification_recipient_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification_recipient ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_recipient_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_subscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_subscription (
    id integer NOT NULL,
    notification_id integer NOT NULL,
    type character varying(64) NOT NULL,
    event_name character varying(64),
    created_at timestamp with time zone NOT NULL,
    cron_schedule character varying(128),
    ui_display_type character varying(32)
);


--
-- Name: TABLE notification_subscription; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_subscription IS 'which type of trigger a notification is subscribed to';


--
-- Name: COLUMN notification_subscription.notification_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.notification_id IS 'the notification that the subscription is connected to';


--
-- Name: COLUMN notification_subscription.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.type IS 'the type of the subscription';


--
-- Name: COLUMN notification_subscription.event_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.event_name IS 'the event name of subscriptions with type :notification-subscription/system-event';


--
-- Name: COLUMN notification_subscription.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.created_at IS 'The timestamp of when the subscription was created';


--
-- Name: COLUMN notification_subscription.cron_schedule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.cron_schedule IS 'the cron schedule for the subscription';


--
-- Name: COLUMN notification_subscription.ui_display_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_subscription.ui_display_type IS 'the display of the subscription, used for the UI only';


--
-- Name: notification_subscription_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification_subscription ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: olya_chat_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.olya_chat_histories (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: olya_chat_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.olya_chat_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: olya_chat_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.olya_chat_histories_id_seq OWNED BY public.olya_chat_histories.id;


--
-- Name: parameter_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parameter_card (
    id integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    card_id integer NOT NULL,
    parameterized_object_type character varying(32) NOT NULL,
    parameterized_object_id integer NOT NULL,
    parameter_id character varying(36) NOT NULL
);


--
-- Name: TABLE parameter_card; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.parameter_card IS 'Join table connecting cards to entities (dashboards, other cards, etc.) that use the values generated by the card for filter values';


--
-- Name: COLUMN parameter_card.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.updated_at IS 'most recent modification time';


--
-- Name: COLUMN parameter_card.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.created_at IS 'creation time';


--
-- Name: COLUMN parameter_card.card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.card_id IS 'ID of the card generating the values';


--
-- Name: COLUMN parameter_card.parameterized_object_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.parameterized_object_type IS 'Type of the entity consuming the values (dashboard, card, etc.)';


--
-- Name: COLUMN parameter_card.parameterized_object_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.parameterized_object_id IS 'ID of the entity consuming the values';


--
-- Name: COLUMN parameter_card.parameter_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parameter_card.parameter_id IS 'The parameter ID';


--
-- Name: parameter_card_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.parameter_card ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.parameter_card_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    payment_id text NOT NULL,
    package_id text,
    amount numeric(10,2) NOT NULL,
    tokens bigint NOT NULL,
    status public.payment_status_enum DEFAULT 'pending'::public.payment_status_enum NOT NULL,
    payment_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);


--
-- Name: peer_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.peer_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_a_id text NOT NULL,
    user_b_id text NOT NULL,
    request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    CONSTRAINT peer_conversations_check CHECK ((user_a_id < user_b_id))
);


--
-- Name: peer_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.peer_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_id text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT peer_messages_content_check CHECK ((char_length(content) <= 4000))
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id integer NOT NULL,
    object character varying(254) NOT NULL,
    group_id integer NOT NULL,
    perm_value character varying(64),
    perm_type character varying(64),
    collection_id integer
);


--
-- Name: COLUMN permissions.perm_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.perm_value IS 'The value of the permission';


--
-- Name: COLUMN permissions.perm_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.perm_type IS 'The type of the permission';


--
-- Name: COLUMN permissions.collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.collection_id IS 'The linked collection, if applicable';


--
-- Name: permissions_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions_group (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    entity_id character(21),
    magic_group_type character varying(254),
    is_tenant_group boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN permissions_group.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions_group.entity_id IS 'NanoID tag for each user';


--
-- Name: COLUMN permissions_group.magic_group_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions_group.magic_group_type IS 'The magic_group_type of the permissions_group';


--
-- Name: COLUMN permissions_group.is_tenant_group; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions_group.is_tenant_group IS 'true iff this is a Tenant Group';


--
-- Name: permissions_group_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.permissions_group ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.permissions_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: permissions_group_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions_group_membership (
    id integer NOT NULL,
    user_id integer NOT NULL,
    group_id integer NOT NULL,
    is_group_manager boolean DEFAULT false NOT NULL
);


--
-- Name: permissions_group_membership_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.permissions_group_membership ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.permissions_group_membership_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: permissions_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions_revision (
    id integer NOT NULL,
    before text NOT NULL,
    after text NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    remark text
);


--
-- Name: permissions_revision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.permissions_revision ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.permissions_revision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: persisted_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persisted_info (
    id integer NOT NULL,
    database_id integer NOT NULL,
    card_id integer,
    question_slug text NOT NULL,
    table_name text NOT NULL,
    definition text,
    query_hash text,
    active boolean DEFAULT false NOT NULL,
    state text NOT NULL,
    refresh_begin timestamp with time zone NOT NULL,
    refresh_end timestamp with time zone,
    state_change_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    creator_id integer
);


--
-- Name: persisted_info_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.persisted_info ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.persisted_info_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse (
    id integer NOT NULL,
    creator_id integer NOT NULL,
    name character varying(254),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    skip_if_empty boolean DEFAULT false NOT NULL,
    alert_condition character varying(254),
    alert_first_only boolean,
    alert_above_goal boolean,
    collection_id integer,
    collection_position smallint,
    archived boolean DEFAULT false,
    dashboard_id integer,
    parameters text NOT NULL,
    entity_id character(21),
    disable_links boolean DEFAULT false
);


--
-- Name: COLUMN pulse.disable_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pulse.disable_links IS 'Whether to disable email subscription links';


--
-- Name: pulse_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_card (
    id integer NOT NULL,
    pulse_id integer NOT NULL,
    card_id integer NOT NULL,
    "position" integer NOT NULL,
    include_csv boolean DEFAULT false NOT NULL,
    include_xls boolean DEFAULT false NOT NULL,
    dashboard_card_id integer,
    entity_id character(21),
    format_rows boolean DEFAULT true,
    pivot_results boolean DEFAULT false
);


--
-- Name: COLUMN pulse_card.format_rows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pulse_card.format_rows IS 'Whether or not to apply formatting to the rows of the export';


--
-- Name: COLUMN pulse_card.pivot_results; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pulse_card.pivot_results IS 'Whether or not to apply pivot processing to the rows of the export';


--
-- Name: pulse_card_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_card ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pulse_card_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_channel; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_channel (
    id integer NOT NULL,
    pulse_id integer NOT NULL,
    channel_type character varying(32) NOT NULL,
    details text NOT NULL,
    schedule_type character varying(32) NOT NULL,
    schedule_hour integer,
    schedule_day character varying(64),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    schedule_frame character varying(32),
    enabled boolean DEFAULT true NOT NULL,
    entity_id character(21),
    channel_id integer
);


--
-- Name: COLUMN pulse_channel.channel_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pulse_channel.channel_id IS 'The channel ID';


--
-- Name: pulse_channel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_channel ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pulse_channel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_channel_recipient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_channel_recipient (
    id integer NOT NULL,
    pulse_channel_id integer NOT NULL,
    user_id integer NOT NULL
);


--
-- Name: pulse_channel_recipient_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_channel_recipient ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pulse_channel_recipient_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.pulse_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: python_library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.python_library (
    id integer NOT NULL,
    path character varying(254) NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE python_library; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.python_library IS 'Store Python library code for user modules in transforms';


--
-- Name: COLUMN python_library.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.python_library.id IS 'Primary key for python_library';


--
-- Name: COLUMN python_library.path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.python_library.path IS 'Path identifier for the library';


--
-- Name: COLUMN python_library.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.python_library.source IS 'Python source code for user modules';


--
-- Name: COLUMN python_library.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.python_library.created_at IS 'When the record was created';


--
-- Name: COLUMN python_library.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.python_library.updated_at IS 'When the record was last updated';


--
-- Name: python_library_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.python_library ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.python_library_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: qrtz_blob_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_blob_triggers (
    sched_name character varying(120) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    blob_data bytea
);


--
-- Name: qrtz_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_calendars (
    sched_name character varying(120) NOT NULL,
    calendar_name character varying(200) NOT NULL,
    calendar bytea NOT NULL
);


--
-- Name: qrtz_cron_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_cron_triggers (
    sched_name character varying(120) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    cron_expression character varying(120) NOT NULL,
    time_zone_id character varying(80)
);


--
-- Name: qrtz_fired_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_fired_triggers (
    sched_name character varying(120) NOT NULL,
    entry_id character varying(95) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    instance_name character varying(200) NOT NULL,
    fired_time bigint NOT NULL,
    sched_time bigint,
    priority integer NOT NULL,
    state character varying(16) NOT NULL,
    job_name character varying(200),
    job_group character varying(200),
    is_nonconcurrent boolean,
    requests_recovery boolean
);


--
-- Name: qrtz_job_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_job_details (
    sched_name character varying(120) NOT NULL,
    job_name character varying(200) NOT NULL,
    job_group character varying(200) NOT NULL,
    description character varying(250),
    job_class_name character varying(250) NOT NULL,
    is_durable boolean NOT NULL,
    is_nonconcurrent boolean NOT NULL,
    is_update_data boolean NOT NULL,
    requests_recovery boolean NOT NULL,
    job_data bytea
);


--
-- Name: qrtz_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_locks (
    sched_name character varying(120) NOT NULL,
    lock_name character varying(40) NOT NULL
);


--
-- Name: qrtz_paused_trigger_grps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_paused_trigger_grps (
    sched_name character varying(120) NOT NULL,
    trigger_group character varying(200) NOT NULL
);


--
-- Name: qrtz_scheduler_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_scheduler_state (
    sched_name character varying(120) NOT NULL,
    instance_name character varying(200) NOT NULL,
    last_checkin_time bigint NOT NULL,
    checkin_interval bigint NOT NULL
);


--
-- Name: qrtz_simple_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_simple_triggers (
    sched_name character varying(120) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    repeat_count bigint NOT NULL,
    repeat_interval bigint NOT NULL,
    times_triggered bigint NOT NULL
);


--
-- Name: qrtz_simprop_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_simprop_triggers (
    sched_name character varying(120) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    str_prop_1 character varying(512),
    str_prop_2 character varying(512),
    str_prop_3 character varying(512),
    int_prop_1 integer,
    int_prop_2 integer,
    long_prop_1 bigint,
    long_prop_2 bigint,
    dec_prop_1 numeric(13,4),
    dec_prop_2 numeric(13,4),
    bool_prop_1 boolean,
    bool_prop_2 boolean
);


--
-- Name: qrtz_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qrtz_triggers (
    sched_name character varying(120) NOT NULL,
    trigger_name character varying(200) NOT NULL,
    trigger_group character varying(200) NOT NULL,
    job_name character varying(200) NOT NULL,
    job_group character varying(200) NOT NULL,
    description character varying(250),
    next_fire_time bigint,
    prev_fire_time bigint,
    priority integer,
    trigger_state character varying(16) NOT NULL,
    trigger_type character varying(8) NOT NULL,
    start_time bigint NOT NULL,
    end_time bigint,
    calendar_name character varying(200),
    misfire_instr smallint,
    job_data bytea
);


--
-- Name: query; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query (
    query_hash bytea NOT NULL,
    average_execution_time integer NOT NULL,
    query text
);


--
-- Name: query_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_action (
    action_id integer NOT NULL,
    database_id integer NOT NULL,
    dataset_query text NOT NULL,
    legacy_query text
);


--
-- Name: TABLE query_action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.query_action IS 'A readwrite query type of action';


--
-- Name: COLUMN query_action.action_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_action.action_id IS 'The related action';


--
-- Name: COLUMN query_action.database_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_action.database_id IS 'The associated database';


--
-- Name: COLUMN query_action.dataset_query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_action.dataset_query IS 'The MBQL writeback query';


--
-- Name: COLUMN query_action.legacy_query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_action.legacy_query IS 'Legacy MBQL version of the query (serialized as JSON) for existing Query Actions created before v57, to support rollbacks to v56. This column should be removed in v58.';


--
-- Name: query_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_cache (
    query_hash bytea NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    results bytea NOT NULL
);


--
-- Name: query_execution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_execution (
    id integer NOT NULL,
    hash bytea NOT NULL,
    started_at timestamp with time zone NOT NULL,
    running_time integer NOT NULL,
    result_rows integer NOT NULL,
    native boolean NOT NULL,
    context character varying(32),
    error text,
    executor_id integer,
    card_id integer,
    dashboard_id integer,
    pulse_id integer,
    database_id integer,
    cache_hit boolean,
    action_id integer,
    is_sandboxed boolean,
    cache_hash bytea,
    embedding_client character varying(254),
    embedding_version character varying(254),
    parameterized boolean
);


--
-- Name: COLUMN query_execution.action_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.action_id IS 'The ID of the action associated with this query execution, if any.';


--
-- Name: COLUMN query_execution.is_sandboxed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.is_sandboxed IS 'Is query from a sandboxed user';


--
-- Name: COLUMN query_execution.cache_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.cache_hash IS 'Hash of normalized query, calculated in middleware.cache';


--
-- Name: COLUMN query_execution.embedding_client; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.embedding_client IS 'Used by the embedding team to track SDK usage';


--
-- Name: COLUMN query_execution.embedding_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.embedding_version IS 'Used by the embedding team to track SDK version usage';


--
-- Name: COLUMN query_execution.parameterized; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_execution.parameterized IS 'Whether or not the query has parameters with non-nil values';


--
-- Name: query_execution_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.query_execution ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.query_execution_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: query_field; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_field (
    id integer NOT NULL,
    card_id integer NOT NULL,
    field_id integer,
    explicit_reference boolean DEFAULT true NOT NULL,
    "column" character varying(254) NOT NULL,
    "table" character varying(254),
    table_id integer,
    schema character varying(254)
);


--
-- Name: TABLE query_field; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.query_field IS 'Fields used by a card''s query';


--
-- Name: COLUMN query_field.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.id IS 'PK';


--
-- Name: COLUMN query_field.card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.card_id IS 'referenced card';


--
-- Name: COLUMN query_field.field_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.field_id IS 'referenced field';


--
-- Name: COLUMN query_field.explicit_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.explicit_reference IS 'Is the Field referenced directly or via a wildcard';


--
-- Name: COLUMN query_field."column"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field."column" IS 'name of the table or card being referenced';


--
-- Name: COLUMN query_field."table"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field."table" IS 'name of the table or card being referenced';


--
-- Name: COLUMN query_field.table_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.table_id IS 'track the table directly, in case the field does not exist';


--
-- Name: COLUMN query_field.schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_field.schema IS 'name of the schema of the table being referenced';


--
-- Name: query_field_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.query_field ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.query_field_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: query_table; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_table (
    id integer NOT NULL,
    card_id integer NOT NULL,
    table_id integer,
    schema character varying(254),
    "table" character varying(254) NOT NULL
);


--
-- Name: TABLE query_table; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.query_table IS 'Tables used by a card''s query';


--
-- Name: COLUMN query_table.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_table.id IS 'PK';


--
-- Name: COLUMN query_table.card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_table.card_id IS 'referenced card';


--
-- Name: COLUMN query_table.table_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_table.table_id IS 'referenced field';


--
-- Name: COLUMN query_table.schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_table.schema IS 'name of the schema of the table being referenced';


--
-- Name: COLUMN query_table."table"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.query_table."table" IS 'name of the table or card being referenced';


--
-- Name: query_table_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.query_table ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.query_table_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_chat_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_chat_history (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: realtime_chat_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.realtime_chat_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: realtime_chat_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.realtime_chat_history_id_seq OWNED BY public.realtime_chat_history.id;


--
-- Name: recent_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recent_views (
    id integer NOT NULL,
    user_id integer NOT NULL,
    model character varying(16) NOT NULL,
    model_id integer NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    context character varying(256) DEFAULT 'view'::character varying NOT NULL
);


--
-- Name: TABLE recent_views; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recent_views IS 'Used to store recently viewed objects for each user';


--
-- Name: COLUMN recent_views.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recent_views.user_id IS 'The user associated with this view';


--
-- Name: COLUMN recent_views.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recent_views.model IS 'The name of the model that was viewed';


--
-- Name: COLUMN recent_views.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recent_views.model_id IS 'The ID of the model that was viewed';


--
-- Name: COLUMN recent_views."timestamp"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recent_views."timestamp" IS 'The time a view was recorded';


--
-- Name: COLUMN recent_views.context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recent_views.context IS 'The contextual action that netted a recent view.';


--
-- Name: recent_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.recent_views ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.recent_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: referral_commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_commissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    leader_id uuid NOT NULL,
    payment_id character varying(255),
    referee_phone character varying(20),
    commission_level smallint,
    payment_amount_rub numeric(10,2),
    commission_pct numeric(5,2),
    commission_rub numeric(10,2),
    paid_out boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: referral_leaders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_leaders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    user_phone character varying(20),
    parent_leader_id uuid,
    level smallint DEFAULT 1,
    commission_pct numeric(5,2) DEFAULT 10,
    parent_commission_pct numeric(5,2) DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT referral_leaders_level_check CHECK ((level = ANY (ARRAY[1, 2]))),
    CONSTRAINT referral_leaders_slug_check CHECK (((slug)::text ~ '^[a-z0-9-]+$'::text))
);


--
-- Name: referral_referees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_referees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referee_phone character varying(20) NOT NULL,
    leader_id uuid NOT NULL,
    registered_at timestamp with time zone DEFAULT now()
);


--
-- Name: remote_sync_object; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_sync_object (
    id integer NOT NULL,
    model_type character varying(32) NOT NULL,
    model_id integer NOT NULL,
    status character varying(32) NOT NULL,
    status_changed_at timestamp with time zone NOT NULL,
    model_name character varying(255) NOT NULL,
    model_collection_id integer,
    model_display character varying(50)
);


--
-- Name: TABLE remote_sync_object; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.remote_sync_object IS 'Track remote sync objects';


--
-- Name: COLUMN remote_sync_object.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.id IS 'Primary key identifier for remote-sync objects';


--
-- Name: COLUMN remote_sync_object.model_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.model_type IS 'Type of model';


--
-- Name: COLUMN remote_sync_object.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.model_id IS 'ID of the model';


--
-- Name: COLUMN remote_sync_object.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.status IS 'Status of the object';


--
-- Name: COLUMN remote_sync_object.status_changed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.status_changed_at IS 'When the status changed';


--
-- Name: COLUMN remote_sync_object.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.model_name IS 'Copy of the name from the object being sync''ed';


--
-- Name: COLUMN remote_sync_object.model_collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.model_collection_id IS 'Copy of the collection from the object being sync''ed';


--
-- Name: COLUMN remote_sync_object.model_display; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_object.model_display IS 'Copy of the display field from the object being sync''ed';


--
-- Name: remote_sync_object_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.remote_sync_object ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.remote_sync_object_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: remote_sync_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_sync_task (
    id integer NOT NULL,
    sync_task_type character varying(24) NOT NULL,
    progress double precision,
    cancelled boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    last_progress_report_at timestamp with time zone DEFAULT now() NOT NULL,
    initiated_by integer,
    error_message text,
    version character varying(50)
);


--
-- Name: TABLE remote_sync_task; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.remote_sync_task IS 'Table to track remote sync tasks and their progress';


--
-- Name: COLUMN remote_sync_task.sync_task_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.sync_task_type IS 'Type of the sync task';


--
-- Name: COLUMN remote_sync_task.progress; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.progress IS 'Progress percentage of the sync task (0.0 to 1.0)';


--
-- Name: COLUMN remote_sync_task.cancelled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.cancelled IS 'Whether the sync task was cancelled';


--
-- Name: COLUMN remote_sync_task.started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.started_at IS 'Timestamp when the sync task started';


--
-- Name: COLUMN remote_sync_task.ended_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.ended_at IS 'Timestamp when the sync task ended';


--
-- Name: COLUMN remote_sync_task.last_progress_report_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.last_progress_report_at IS 'Timestamp of the last progress update';


--
-- Name: COLUMN remote_sync_task.initiated_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.initiated_by IS 'ID of the user who initiated the sync task';


--
-- Name: COLUMN remote_sync_task.error_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.error_message IS 'error message if this task failed';


--
-- Name: COLUMN remote_sync_task.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.remote_sync_task.version IS 'Version that was imported or exported (ex the Git SHA)';


--
-- Name: remote_sync_task_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.remote_sync_task ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.remote_sync_task_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: report_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_card (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    display character varying(254) NOT NULL,
    dataset_query text NOT NULL,
    visualization_settings text NOT NULL,
    creator_id integer NOT NULL,
    database_id integer NOT NULL,
    table_id integer,
    query_type character varying(16),
    archived boolean DEFAULT false NOT NULL,
    collection_id integer,
    public_uuid character(36),
    made_public_by_id integer,
    enable_embedding boolean DEFAULT false NOT NULL,
    embedding_params text,
    cache_ttl integer,
    result_metadata text,
    collection_position smallint,
    entity_id character(21),
    parameters text,
    parameter_mappings text,
    collection_preview boolean DEFAULT true NOT NULL,
    metabase_version character varying(100),
    type character varying(16) DEFAULT 'question'::character varying NOT NULL,
    initially_published_at timestamp with time zone,
    cache_invalidated_at timestamp with time zone,
    last_used_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    archived_directly boolean DEFAULT false NOT NULL,
    dataset_query_metrics_v2_migration_backup text,
    source_card_id integer,
    dashboard_id integer,
    card_schema integer DEFAULT 20 NOT NULL,
    document_id integer,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL,
    legacy_query text,
    embedding_type character varying(50)
);


--
-- Name: COLUMN report_card.metabase_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.metabase_version IS 'Metabase version used to create the card.';


--
-- Name: COLUMN report_card.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.type IS 'The type of card, could be ''question'', ''model'', ''metric''';


--
-- Name: COLUMN report_card.initially_published_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.initially_published_at IS 'The timestamp when the card was first published in a static embed';


--
-- Name: COLUMN report_card.cache_invalidated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.cache_invalidated_at IS 'An invalidation time that can supersede cache_config.invalidated_at';


--
-- Name: COLUMN report_card.last_used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.last_used_at IS 'The timestamp of when the card is last used';


--
-- Name: COLUMN report_card.view_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.view_count IS 'Keeps a running count of card views';


--
-- Name: COLUMN report_card.archived_directly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.archived_directly IS 'Was this thing trashed directly';


--
-- Name: COLUMN report_card.dataset_query_metrics_v2_migration_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.dataset_query_metrics_v2_migration_backup IS 'The copy of dataset_query before the metrics v2 migration';


--
-- Name: COLUMN report_card.source_card_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.source_card_id IS 'The ID of the model or question this card is based on';


--
-- Name: COLUMN report_card.dashboard_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.dashboard_id IS 'The dashboard that owns the card, if it is a dashboard-internal card.';


--
-- Name: COLUMN report_card.card_schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.card_schema IS 'Arbitrary revision number for how we store queries in report_card';


--
-- Name: COLUMN report_card.document_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.document_id IS 'Associates cards with a particular document';


--
-- Name: COLUMN report_card.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: COLUMN report_card.legacy_query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.legacy_query IS 'Legacy MBQL version of the query (serialized as JSON) for existing Cards created before v57, to support rollbacks to v56. This column should be removed in v58.';


--
-- Name: COLUMN report_card.embedding_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_card.embedding_type IS 'The type of embedding for this card';


--
-- Name: report_card_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.report_card ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.report_card_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: report_cardfavorite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_cardfavorite (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    card_id integer NOT NULL,
    owner_id integer NOT NULL
);


--
-- Name: report_cardfavorite_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.report_cardfavorite ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.report_cardfavorite_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: report_dashboard; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_dashboard (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    creator_id integer NOT NULL,
    parameters text NOT NULL,
    points_of_interest text,
    caveats text,
    show_in_getting_started boolean DEFAULT false NOT NULL,
    public_uuid character(36),
    made_public_by_id integer,
    enable_embedding boolean DEFAULT false NOT NULL,
    embedding_params text,
    archived boolean DEFAULT false NOT NULL,
    "position" integer,
    collection_id integer,
    collection_position smallint,
    cache_ttl integer,
    entity_id character(21),
    auto_apply_filters boolean DEFAULT true NOT NULL,
    width character varying(16) DEFAULT 'fixed'::character varying NOT NULL,
    initially_published_at timestamp with time zone,
    view_count integer DEFAULT 0 NOT NULL,
    archived_directly boolean DEFAULT false NOT NULL,
    last_viewed_at timestamp with time zone DEFAULT now() NOT NULL,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL,
    embedding_type character varying(50)
);


--
-- Name: COLUMN report_dashboard.auto_apply_filters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.auto_apply_filters IS 'Whether or not to auto-apply filters on a dashboard';


--
-- Name: COLUMN report_dashboard.width; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.width IS 'The value of the dashboard''s width setting can be fixed or full. New dashboards will be set to fixed';


--
-- Name: COLUMN report_dashboard.initially_published_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.initially_published_at IS 'The timestamp when the dashboard was first published in a static embed';


--
-- Name: COLUMN report_dashboard.view_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.view_count IS 'Keeps a running count of dashboard views';


--
-- Name: COLUMN report_dashboard.archived_directly; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.archived_directly IS 'Was this thing trashed directly';


--
-- Name: COLUMN report_dashboard.last_viewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.last_viewed_at IS 'Timestamp of when this dashboard was last viewed';


--
-- Name: COLUMN report_dashboard.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: COLUMN report_dashboard.embedding_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboard.embedding_type IS 'The type of embedding for this dashboard';


--
-- Name: report_dashboard_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.report_dashboard ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.report_dashboard_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: report_dashboardcard; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_dashboardcard (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    size_x integer NOT NULL,
    size_y integer NOT NULL,
    "row" integer NOT NULL,
    col integer NOT NULL,
    card_id integer,
    dashboard_id integer NOT NULL,
    parameter_mappings text NOT NULL,
    visualization_settings text NOT NULL,
    entity_id character(21),
    action_id integer,
    dashboard_tab_id integer,
    inline_parameters text
);


--
-- Name: COLUMN report_dashboardcard.action_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboardcard.action_id IS 'The related action';


--
-- Name: COLUMN report_dashboardcard.dashboard_tab_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboardcard.dashboard_tab_id IS 'The referenced tab id that dashcard is on, it''s nullable for dashboard with no tab';


--
-- Name: COLUMN report_dashboardcard.inline_parameters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_dashboardcard.inline_parameters IS 'JSON array of parameter IDs that should be displayed inline with this card';


--
-- Name: report_dashboardcard_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.report_dashboardcard ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.report_dashboardcard_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revision (
    id integer NOT NULL,
    model character varying(16) NOT NULL,
    model_id integer NOT NULL,
    user_id integer NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    object text NOT NULL,
    is_reversion boolean DEFAULT false NOT NULL,
    is_creation boolean DEFAULT false NOT NULL,
    message text,
    most_recent boolean DEFAULT false NOT NULL,
    metabase_version character varying(100)
);


--
-- Name: COLUMN revision.most_recent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.revision.most_recent IS 'Whether a revision is the most recent one';


--
-- Name: COLUMN revision.metabase_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.revision.metabase_version IS 'Metabase version used to create the revision.';


--
-- Name: revision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.revision ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.revision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sales_chat_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_chat_histories (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: sales_chat_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_chat_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_chat_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_chat_histories_id_seq OWNED BY public.sales_chat_histories.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_chat_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_chat_histories (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    message jsonb NOT NULL
);


--
-- Name: search_chat_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.search_chat_histories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_chat_histories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.search_chat_histories_id_seq OWNED BY public.search_chat_histories.id;


--
-- Name: search_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_history (
    id integer NOT NULL,
    user_id character varying(15) NOT NULL,
    search_query text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    respond_at timestamp with time zone,
    response text
);


--
-- Name: TABLE search_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.search_history IS 'История поисковых запросов пользователей';


--
-- Name: COLUMN search_history.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.id IS 'Уникальный идентификатор записи';


--
-- Name: COLUMN search_history.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.user_id IS 'Телефонный номер пользователя (до 15 цифр)';


--
-- Name: COLUMN search_history.search_query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.search_query IS 'Текст поискового запроса';


--
-- Name: COLUMN search_history.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.created_at IS 'Время создания запроса';


--
-- Name: COLUMN search_history.respond_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.respond_at IS 'Время выдачи ответа';


--
-- Name: COLUMN search_history.response; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_history.response IS 'Текст ответа на запрос';


--
-- Name: search_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.search_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.search_history_id_seq OWNED BY public.search_history.id;


--
-- Name: search_index__spejsxn5twd6_rkikxpd8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_index__spejsxn5twd6_rkikxpd8 (
    id bigint NOT NULL,
    search_vector tsvector NOT NULL,
    with_native_query_vector tsvector NOT NULL,
    model character varying(32) NOT NULL,
    display_data text NOT NULL,
    legacy_input text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    model_updated_at timestamp with time zone,
    is_published boolean,
    pinned boolean,
    collection_id integer,
    official_collection boolean,
    name text NOT NULL,
    has_temporal_dim boolean,
    last_edited_at timestamp with time zone,
    dashboardcard_count integer,
    non_temporal_dim_ids text,
    dashboard_id integer,
    last_editor_id integer,
    model_id text,
    display_type text,
    last_viewed_at timestamp with time zone,
    database_id integer,
    creator_id integer,
    view_count integer,
    model_created_at timestamp with time zone,
    verified boolean
);


--
-- Name: search_index__spejsxn5twd6_rkikxpd8_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_index__spejsxn5twd6_rkikxpd8 ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.search_index__spejsxn5twd6_rkikxpd8_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_index__xp3rraru6uf9j0zn2b0c7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_index__xp3rraru6uf9j0zn2b0c7 (
    id bigint NOT NULL,
    search_vector tsvector NOT NULL,
    with_native_query_vector tsvector NOT NULL,
    model character varying(32) NOT NULL,
    display_data text NOT NULL,
    legacy_input text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    model_updated_at timestamp with time zone,
    is_published boolean,
    pinned boolean,
    collection_id integer,
    official_collection boolean,
    name text NOT NULL,
    has_temporal_dim boolean,
    last_edited_at timestamp with time zone,
    dashboardcard_count integer,
    non_temporal_dim_ids text,
    dashboard_id integer,
    last_editor_id integer,
    model_id text,
    display_type text,
    last_viewed_at timestamp with time zone,
    database_id integer,
    creator_id integer,
    view_count integer,
    model_created_at timestamp with time zone,
    verified boolean
);


--
-- Name: search_index__xp3rraru6uf9j0zn2b0c7_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_index__xp3rraru6uf9j0zn2b0c7 ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.search_index__xp3rraru6uf9j0zn2b0c7_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_index_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_index_metadata (
    id integer NOT NULL,
    engine character varying(64) NOT NULL,
    version character varying(254) NOT NULL,
    index_name character varying(254) NOT NULL,
    status character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lang_code character varying(10) DEFAULT 'en'::character varying NOT NULL
);


--
-- Name: TABLE search_index_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.search_index_metadata IS 'Each entry corresponds to some queryable index, and contains metadata about it.';


--
-- Name: COLUMN search_index_metadata.engine; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.engine IS 'The kind of search engine which this index belongs to.';


--
-- Name: COLUMN search_index_metadata.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.version IS 'Used to determine metabase compatibility. Format may depend on engine in future.';


--
-- Name: COLUMN search_index_metadata.index_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.index_name IS 'The name by which the given engine refers to this particular index, e.g. table name.';


--
-- Name: COLUMN search_index_metadata.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.status IS 'One of ''pending'', ''active'', or ''retired''';


--
-- Name: COLUMN search_index_metadata.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.created_at IS 'The timestamp of when the index was created';


--
-- Name: COLUMN search_index_metadata.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.updated_at IS 'The timestamp of when the index status was updated';


--
-- Name: COLUMN search_index_metadata.lang_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.search_index_metadata.lang_code IS 'Language code the data in the index is in';


--
-- Name: search_index_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.search_index_metadata ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.search_index_metadata_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: secret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret (
    id integer NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    creator_id integer,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    name character varying(254) NOT NULL,
    kind character varying(254) NOT NULL,
    source character varying(254),
    value bytea NOT NULL
);


--
-- Name: secret_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.secret ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.secret_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: segment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment (
    id integer NOT NULL,
    table_id integer NOT NULL,
    creator_id integer NOT NULL,
    name character varying(254) NOT NULL,
    description text,
    archived boolean DEFAULT false NOT NULL,
    definition text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    points_of_interest text,
    caveats text,
    show_in_getting_started boolean DEFAULT false NOT NULL,
    entity_id character(21),
    dependency_analysis_version integer DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN segment.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.segment.dependency_analysis_version IS 'Version number for dependency analysis to track when dependencies need recalculation';


--
-- Name: segment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.segment ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.segment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: semantic_search_token_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.semantic_search_token_tracking (
    id integer NOT NULL,
    model_name character varying(256) NOT NULL,
    request_type character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    total_tokens integer NOT NULL
);


--
-- Name: TABLE semantic_search_token_tracking; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.semantic_search_token_tracking IS 'Token usage tracking info for semantic search';


--
-- Name: COLUMN semantic_search_token_tracking.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_search_token_tracking.id IS 'Unique ID of a request';


--
-- Name: COLUMN semantic_search_token_tracking.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_search_token_tracking.model_name IS 'Name of model used for embeddings generation';


--
-- Name: COLUMN semantic_search_token_tracking.request_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_search_token_tracking.request_type IS 'Type of request, possibly index or query';


--
-- Name: COLUMN semantic_search_token_tracking.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_search_token_tracking.created_at IS 'Datetime of insertion';


--
-- Name: COLUMN semantic_search_token_tracking.total_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_search_token_tracking.total_tokens IS 'Total tokens value as per OpenAI compatible API';


--
-- Name: semantic_search_token_tracking_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.semantic_search_token_tracking ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.semantic_search_token_tracking_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequences (
    name character varying(50) NOT NULL,
    next_val bigint NOT NULL
);


--
-- Name: TABLE sequences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sequences IS 'A table for generating atomic sequence numbers';


--
-- Name: COLUMN sequences.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequences.name IS 'The name of the sequence';


--
-- Name: COLUMN sequences.next_val; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequences.next_val IS 'The next value in this sequence';


--
-- Name: service_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_health (
    service text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    latency_ms integer,
    last_check_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    details jsonb,
    CONSTRAINT service_health_status_check CHECK ((status = ANY (ARRAY['healthy'::text, 'degraded'::text, 'down'::text, 'unknown'::text])))
);


--
-- Name: setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setting (
    key character varying(254) NOT NULL,
    value text NOT NULL
);


--
-- Name: short_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.short_codes (
    phone character varying(20),
    short_code character varying(6),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: smm_billing_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_billing_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    video_id uuid,
    amount integer NOT NULL,
    op text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_billing_ledger_op_check CHECK ((op = ANY (ARRAY['charge'::text, 'refund'::text])))
);


--
-- Name: smm_campaign; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_campaign (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    conversation_id uuid,
    topic text,
    source_mode text NOT NULL,
    requested_count integer NOT NULL,
    status text DEFAULT 'drafting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_linkeon_official boolean DEFAULT false NOT NULL,
    CONSTRAINT smm_campaign_requested_count_check CHECK (((requested_count > 0) AND (requested_count <= 20))),
    CONSTRAINT smm_campaign_source_mode_check CHECK ((source_mode = ANY (ARRAY['auto'::text, 'topic'::text, 'trends'::text]))),
    CONSTRAINT smm_campaign_status_check CHECK ((status = ANY (ARRAY['drafting'::text, 'approved'::text, 'done'::text, 'cancelled'::text])))
);


--
-- Name: smm_creator_campaign; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_creator_campaign (
    campaign_id uuid NOT NULL,
    cta_handle text NOT NULL,
    cta_label text DEFAULT 'Подписывайся'::text NOT NULL,
    voice_gender text NOT NULL,
    genre text DEFAULT 'dialog'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    logo_url text,
    cta_slogan text,
    publish_caption text,
    bg_color text,
    bg_image_url text,
    CONSTRAINT smm_creator_campaign_genre_check CHECK ((genre = ANY (ARRAY['dialog'::text, 'monologue'::text, 'fact_explanation'::text]))),
    CONSTRAINT smm_creator_campaign_voice_gender_check CHECK ((voice_gender = ANY (ARRAY['male'::text, 'female'::text])))
);


--
-- Name: smm_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    video_id uuid,
    publication_id uuid,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: smm_music_track; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_music_track (
    id text NOT NULL,
    title text NOT NULL,
    mood text NOT NULL,
    duration_sec integer NOT NULL,
    storage_key text NOT NULL,
    license text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_music_track_mood_check CHECK ((mood = ANY (ARRAY['dramatic'::text, 'inspiring'::text, 'calm'::text, 'uplifting'::text, 'tense'::text, 'neutral'::text])))
);


--
-- Name: smm_oauth_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_oauth_state (
    state text NOT NULL,
    user_id text NOT NULL,
    platform text NOT NULL,
    redirect_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_oauth_state_platform_check CHECK ((platform = ANY (ARRAY['vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text])))
);


--
-- Name: smm_premium_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_premium_generation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid,
    user_id text NOT NULL,
    genre text NOT NULL,
    scene_count integer NOT NULL,
    tokens_charged integer NOT NULL,
    tokens_refunded integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    internal_cost_cents integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: smm_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_pricing (
    id text NOT NULL,
    tokens_cost integer NOT NULL,
    display_name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_pricing_id_check CHECK ((id = ANY (ARRAY['economy'::text, 'premium'::text]))),
    CONSTRAINT smm_pricing_tokens_cost_check CHECK ((tokens_cost > 0))
);


--
-- Name: smm_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_publication (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    platform text NOT NULL,
    scheduled_at timestamp with time zone,
    status text DEFAULT 'scheduled'::text NOT NULL,
    publish_job_id text,
    external_url text,
    external_post_id text,
    caption text,
    error_message text,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_publication_platform_check CHECK ((platform = ANY (ARRAY['telegram'::text, 'vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text]))),
    CONSTRAINT smm_publication_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: smm_scenario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_scenario (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    title text NOT NULL,
    assistant_role text NOT NULL,
    dialog jsonb NOT NULL,
    mood text NOT NULL,
    broll_prompts jsonb DEFAULT '[]'::jsonb NOT NULL,
    music_track_id text,
    tts_tier text DEFAULT 'premium'::text NOT NULL,
    status text DEFAULT 'pending_review'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tts_voice_id text,
    premium_genre text,
    kling_scene_count integer DEFAULT 0 NOT NULL,
    scenes_json jsonb,
    CONSTRAINT premium_genre_check CHECK (((premium_genre IS NULL) OR (premium_genre = ANY (ARRAY['surreal'::text, 'pov'::text, 'cinematic'::text])))),
    CONSTRAINT smm_scenario_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'regenerating'::text]))),
    CONSTRAINT smm_scenario_tts_tier_check CHECK ((tts_tier = ANY (ARRAY['economy'::text, 'premium'::text])))
);


--
-- Name: smm_social_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_social_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text,
    platform text NOT NULL,
    display_name text NOT NULL,
    credentials jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_social_account_platform_check CHECK ((platform = ANY (ARRAY['telegram'::text, 'vk'::text, 'youtube'::text, 'tiktok'::text, 'instagram'::text]))),
    CONSTRAINT smm_social_account_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: smm_video; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.smm_video (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    render_job_id text,
    render_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    mp4_url text,
    duration_sec integer,
    size_bytes bigint,
    error_message text,
    tokens_charged integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smm_video_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'rendering'::text, 'ready'::text, 'failed'::text, 'approved'::text, 'rejected'::text, 'escape_hatch_offered'::text, 'cancelled'::text])))
);


--
-- Name: support_access_grant_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_access_grant_log (
    id integer NOT NULL,
    user_id integer,
    ticket_number character varying(100),
    notes character varying(255),
    grant_start_timestamp timestamp with time zone NOT NULL,
    grant_end_timestamp timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE support_access_grant_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.support_access_grant_log IS 'Store support access grant requests and their lifecycle for audit purposes';


--
-- Name: COLUMN support_access_grant_log.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.id IS 'Unique identifier for the grant';


--
-- Name: COLUMN support_access_grant_log.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.user_id IS 'ID of the admin user who created this grant';


--
-- Name: COLUMN support_access_grant_log.ticket_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.ticket_number IS 'Support ticket number associated with this grant';


--
-- Name: COLUMN support_access_grant_log.notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.notes IS 'Additional notes associated with this grant';


--
-- Name: COLUMN support_access_grant_log.grant_start_timestamp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.grant_start_timestamp IS 'When the grant becomes active (UTC)';


--
-- Name: COLUMN support_access_grant_log.grant_end_timestamp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.grant_end_timestamp IS 'When the grant expires (UTC)';


--
-- Name: COLUMN support_access_grant_log.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.revoked_at IS 'When the grant was manually revoked (UTC), null if not revoked';


--
-- Name: COLUMN support_access_grant_log.revoked_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.revoked_by_user_id IS 'ID of the admin user who revoked this grant';


--
-- Name: COLUMN support_access_grant_log.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.created_at IS 'When this record was created (UTC)';


--
-- Name: COLUMN support_access_grant_log.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_access_grant_log.updated_at IS 'When this record was last updated (UTC)';


--
-- Name: support_access_grant_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.support_access_grant_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.support_access_grant_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: support_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    action text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['ai'::text, 'owner'::text, 'system'::text])))
);


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    sender_type text NOT NULL,
    sender_id text,
    content text NOT NULL,
    metadata jsonb,
    visible_to_user boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'ai'::text, 'owner'::text, 'system'::text])))
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    status text DEFAULT 'ai_handling'::text NOT NULL,
    urgency text,
    topic text,
    escalation_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT support_tickets_status_check CHECK ((status = ANY (ARRAY['ai_handling'::text, 'escalated'::text, 'owner_handling'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT support_tickets_urgency_check CHECK ((urgency = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text])))
);


--
-- Name: table_privileges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.table_privileges (
    table_id integer NOT NULL,
    role character varying(255),
    "select" boolean DEFAULT false NOT NULL,
    update boolean DEFAULT false NOT NULL,
    insert boolean DEFAULT false NOT NULL,
    delete boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE table_privileges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.table_privileges IS 'Table for user and role privileges by table';


--
-- Name: COLUMN table_privileges.table_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges.table_id IS 'Table ID';


--
-- Name: COLUMN table_privileges.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges.role IS 'Role name. NULL indicates the privileges are the current user''s';


--
-- Name: COLUMN table_privileges."select"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges."select" IS 'Privilege to select from the table';


--
-- Name: COLUMN table_privileges.update; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges.update IS 'Privilege to update records in the table';


--
-- Name: COLUMN table_privileges.insert; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges.insert IS 'Privilege to insert records into the table';


--
-- Name: COLUMN table_privileges.delete; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.table_privileges.delete IS 'Privilege to delete records from the table';


--
-- Name: task_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_events (
    id bigint NOT NULL,
    task_id uuid NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    agent_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_events_kind_check CHECK ((kind = ANY (ARRAY['user_message'::text, 'agent_response'::text, 'note'::text, 'milestone'::text, 'decision'::text, 'status_change'::text])))
);


--
-- Name: task_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.task_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: task_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.task_events_id_seq OWNED BY public.task_events.id;


--
-- Name: task_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_history (
    id integer NOT NULL,
    task character varying(254) NOT NULL,
    db_id integer,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ended_at timestamp with time zone,
    duration integer,
    task_details text,
    status character varying(21) DEFAULT 'started'::character varying NOT NULL
);


--
-- Name: COLUMN task_history.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_history.status IS 'the status of task history, could be started, failed, success, unknown';


--
-- Name: task_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.task_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.task_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    claudemd text DEFAULT ''::text NOT NULL,
    claudemd_locked boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding double precision[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'done'::text])))
);


--
-- Name: telegram_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_prefs (
    chat_id bigint NOT NULL,
    mode text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_prefs_mode_check CHECK ((mode = ANY (ARRAY['text'::text, 'voice'::text, 'both'::text])))
);


--
-- Name: telegram_prefs_yasha; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_prefs_yasha (
    chat_id bigint NOT NULL,
    mode text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_prefs_yasha_mode_check CHECK ((mode = ANY (ARRAY['text'::text, 'voice'::text, 'both'::text])))
);


--
-- Name: tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    slug character varying(254) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    attributes text,
    tenant_collection_id integer NOT NULL
);


--
-- Name: TABLE tenant; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tenant IS 'Tenants (collections of external users). A user can be in exactly zero or one tenants.';


--
-- Name: COLUMN tenant.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.id IS 'the ID of the tenant';


--
-- Name: COLUMN tenant.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.name IS 'the unique name of the tenant';


--
-- Name: COLUMN tenant.slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.slug IS 'the slugified version of this tenant''s name';


--
-- Name: COLUMN tenant.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.is_active IS 'Whether the tenant is active or not';


--
-- Name: COLUMN tenant.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.updated_at IS 'The timestamp of when the tenant was updated';


--
-- Name: COLUMN tenant.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.created_at IS 'The timestamp of when the tenant was created';


--
-- Name: COLUMN tenant.attributes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.attributes IS 'JSON object containing custom tenant attributes';


--
-- Name: COLUMN tenant.tenant_collection_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant.tenant_collection_id IS 'The ID of the collection';


--
-- Name: tenant_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tenant ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.tenant_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: timeline; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timeline (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255),
    icon character varying(128) NOT NULL,
    collection_id integer,
    archived boolean DEFAULT false NOT NULL,
    creator_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    "default" boolean DEFAULT false NOT NULL,
    entity_id character(21)
);


--
-- Name: timeline_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timeline_event (
    id integer NOT NULL,
    timeline_id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255),
    "timestamp" timestamp with time zone NOT NULL,
    time_matters boolean NOT NULL,
    timezone character varying(255) NOT NULL,
    icon character varying(128) NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    creator_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: timeline_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.timeline_event ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.timeline_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: timeline_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.timeline ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.timeline_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: token_consumption_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_consumption_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    execution_id integer NOT NULL,
    user_id text NOT NULL,
    status public.task_status_enum DEFAULT 'pending'::public.task_status_enum NOT NULL,
    agent_id integer,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    tokens_to_consume bigint DEFAULT 0,
    error_message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);


--
-- Name: TABLE token_consumption_tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.token_consumption_tasks IS 'Очередь задач на асинхронное списание токенов';


--
-- Name: COLUMN token_consumption_tasks.execution_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_consumption_tasks.execution_id IS 'ID выполнения workflow из n8n execution_data';


--
-- Name: COLUMN token_consumption_tasks.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_consumption_tasks.user_id IS 'user_id из ai_profiles_consolidated (sessionId)';


--
-- Name: COLUMN token_consumption_tasks.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_consumption_tasks.status IS 'Статус задачи: pending, processing, completed, failed';


--
-- Name: COLUMN token_consumption_tasks.tokens_to_consume; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_consumption_tasks.tokens_to_consume IS 'Итоговое количество токенов для списания (после расчета)';


--
-- Name: token_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    tokens bigint NOT NULL,
    price_rub numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE token_packages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.token_packages IS 'Тарифы (пакеты токенов) для оплаты пользователями';


--
-- Name: COLUMN token_packages.code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_packages.code IS 'Код пакета: starter, extended, professional';


--
-- Name: COLUMN token_packages.tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_packages.tokens IS 'Количество токенов в пакете';


--
-- Name: COLUMN token_packages.price_rub; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.token_packages.price_rub IS 'Цена пакета в рублях';


--
-- Name: token_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    transaction_type public.transaction_type_enum NOT NULL,
    amount bigint NOT NULL,
    balance_after bigint NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tour_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tour_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying,
    reuqest_id character varying,
    created_at timestamp with time zone DEFAULT now(),
    hotels_found integer,
    tours_found integer,
    time_passed integer,
    min_price integer,
    max_price integer,
    intents json,
    search_result jsonb,
    user_id uuid
);


--
-- Name: transform; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    source text NOT NULL,
    target text NOT NULL,
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dependency_analysis_version smallint DEFAULT 0 NOT NULL,
    source_type character varying(32) NOT NULL,
    creator_id integer DEFAULT 13371338 NOT NULL
);


--
-- Name: TABLE transform; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform IS 'The main table for Transform entities';


--
-- Name: COLUMN transform.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.id IS 'Unique ID';


--
-- Name: COLUMN transform.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.name IS 'Name';


--
-- Name: COLUMN transform.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.description IS 'the description of the transform';


--
-- Name: COLUMN transform.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.source IS 'JSON of source';


--
-- Name: COLUMN transform.target; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.target IS 'JSON of target';


--
-- Name: COLUMN transform.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: COLUMN transform.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.created_at IS 'The timestamp of when the transform was created';


--
-- Name: COLUMN transform.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.updated_at IS 'The timestamp of when the transform was updated';


--
-- Name: COLUMN transform.dependency_analysis_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.dependency_analysis_version IS 'Version of the dependency analysis for this entity.';


--
-- Name: COLUMN transform.source_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.source_type IS 'The type of transform ("python", "native", or "mbql")';


--
-- Name: COLUMN transform.creator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform.creator_id IS 'User who created this transform';


--
-- Name: transform_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_job (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    schedule text NOT NULL,
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    built_in_type character varying(255),
    ui_display_type character varying(32) DEFAULT 'cron/raw'::character varying NOT NULL
);


--
-- Name: TABLE transform_job; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_job IS 'Jobs that execute transforms based on tags';


--
-- Name: COLUMN transform_job.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.id IS 'Unique ID';


--
-- Name: COLUMN transform_job.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.name IS 'The name of the transform job.';


--
-- Name: COLUMN transform_job.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.description IS 'A description of the transform job.';


--
-- Name: COLUMN transform_job.schedule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.schedule IS 'Cron expression for job schedule';


--
-- Name: COLUMN transform_job.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.entity_id IS 'NanoID identifier for the job';


--
-- Name: COLUMN transform_job.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.created_at IS 'The timestamp this transform job was created.';


--
-- Name: COLUMN transform_job.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.updated_at IS 'The timestamp this transform job was last updated.';


--
-- Name: COLUMN transform_job.built_in_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.built_in_type IS 'Type of the built-in transform job: hourly, daily, weekly, monthly.';


--
-- Name: COLUMN transform_job.ui_display_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job.ui_display_type IS 'The display type of the schedule, used for the UI only; "cron/raw" or "cron/builder".';


--
-- Name: transform_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_job ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_job_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_job_run (
    id integer NOT NULL,
    job_id bigint NOT NULL,
    run_method character varying(255) NOT NULL,
    status character varying(50) NOT NULL,
    is_active boolean,
    start_time timestamp with time zone DEFAULT now() NOT NULL,
    end_time timestamp with time zone,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE transform_job_run; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_job_run IS 'Table to track transform job executions and their status in the app database';


--
-- Name: COLUMN transform_job_run.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.id IS 'Unique ID';


--
-- Name: COLUMN transform_job_run.job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.job_id IS 'Identifier for the transform job';


--
-- Name: COLUMN transform_job_run.run_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.run_method IS 'Method used to execute the transform job';


--
-- Name: COLUMN transform_job_run.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.status IS 'Current status of the transform job (running, completed, failed, etc.)';


--
-- Name: COLUMN transform_job_run.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.is_active IS 'True only for currently running jobs, null for the others';


--
-- Name: COLUMN transform_job_run.start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.start_time IS 'When the transform job started';


--
-- Name: COLUMN transform_job_run.end_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.end_time IS 'When the tranform job completed (null if still running)';


--
-- Name: COLUMN transform_job_run.message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.message IS 'Human-readable message about the run; may contain error message in case status is error';


--
-- Name: COLUMN transform_job_run.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.created_at IS 'The timestamp this transform job run was created.';


--
-- Name: COLUMN transform_job_run.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_run.updated_at IS 'The timestamp this transform job run was last updated.';


--
-- Name: transform_job_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_job_run ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_job_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_job_transform_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_job_transform_tag (
    id integer NOT NULL,
    job_id integer NOT NULL,
    tag_id integer NOT NULL,
    entity_id character(21),
    "position" integer NOT NULL
);


--
-- Name: TABLE transform_job_transform_tag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_job_transform_tag IS 'Join table for jobs and tags';


--
-- Name: COLUMN transform_job_transform_tag.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_transform_tag.id IS 'Unique ID';


--
-- Name: COLUMN transform_job_transform_tag.job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_transform_tag.job_id IS 'The id of the transform job.';


--
-- Name: COLUMN transform_job_transform_tag.tag_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_transform_tag.tag_id IS 'The id of the transform tag.';


--
-- Name: COLUMN transform_job_transform_tag.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_transform_tag.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: COLUMN transform_job_transform_tag."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_job_transform_tag."position" IS 'The ordering position of this tag for the job.';


--
-- Name: transform_job_transform_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_job_transform_tag ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_job_transform_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_run (
    id integer NOT NULL,
    transform_id integer NOT NULL,
    run_method character varying(255) NOT NULL,
    status character varying(50) NOT NULL,
    is_active boolean,
    start_time timestamp with time zone DEFAULT now() NOT NULL,
    end_time timestamp with time zone,
    message text
);


--
-- Name: TABLE transform_run; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_run IS 'Table to track transform executions and their status in the app database';


--
-- Name: COLUMN transform_run.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.id IS 'Unique ID';


--
-- Name: COLUMN transform_run.transform_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.transform_id IS 'Identifier for the transform';


--
-- Name: COLUMN transform_run.run_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.run_method IS 'Method used to execute the transform job';


--
-- Name: COLUMN transform_run.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.status IS 'Current status of the transform job (running, completed, failed, etc.)';


--
-- Name: COLUMN transform_run.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.is_active IS 'True only for currently running jobs, null for the others';


--
-- Name: COLUMN transform_run.start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.start_time IS 'When the transform job started';


--
-- Name: COLUMN transform_run.end_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.end_time IS 'When the transform job completed (null if still running)';


--
-- Name: COLUMN transform_run.message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run.message IS 'Human-readable message about the run; may contain error message in case status is error';


--
-- Name: transform_run_cancelation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_run_cancelation (
    run_id integer NOT NULL,
    "time" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE transform_run_cancelation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_run_cancelation IS 'Table to track the cancelation of transform job executions';


--
-- Name: COLUMN transform_run_cancelation.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run_cancelation.run_id IS 'The transform_run ID';


--
-- Name: COLUMN transform_run_cancelation."time"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_run_cancelation."time" IS 'The time of the request';


--
-- Name: transform_run_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_run ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_tag (
    id integer NOT NULL,
    name character varying(254) NOT NULL,
    entity_id character(21),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    built_in_type character varying(255)
);


--
-- Name: TABLE transform_tag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_tag IS 'Tags for grouping transforms';


--
-- Name: COLUMN transform_tag.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.id IS 'Unique ID';


--
-- Name: COLUMN transform_tag.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.name IS 'The name of the transform tag.';


--
-- Name: COLUMN transform_tag.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: COLUMN transform_tag.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.created_at IS 'The time the transform tag was created.';


--
-- Name: COLUMN transform_tag.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.updated_at IS 'The time the transform tag was last updated.';


--
-- Name: COLUMN transform_tag.built_in_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_tag.built_in_type IS 'Type of the built-in transform tag: hourly, daily, weekly, monthly.';


--
-- Name: transform_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_tag ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transform_transform_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transform_transform_tag (
    id integer NOT NULL,
    transform_id integer NOT NULL,
    tag_id integer NOT NULL,
    entity_id character(21),
    "position" integer NOT NULL
);


--
-- Name: TABLE transform_transform_tag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transform_transform_tag IS 'Join table for transforms and tags';


--
-- Name: COLUMN transform_transform_tag.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_transform_tag.id IS 'Unique ID';


--
-- Name: COLUMN transform_transform_tag.transform_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_transform_tag.transform_id IS 'The id of the transform.';


--
-- Name: COLUMN transform_transform_tag.tag_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_transform_tag.tag_id IS 'The id of the tag.';


--
-- Name: COLUMN transform_transform_tag.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_transform_tag.entity_id IS 'Random NanoID tag for unique identity.';


--
-- Name: COLUMN transform_transform_tag."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transform_transform_tag."position" IS 'The relative UI ordering of this tag on the transform';


--
-- Name: transform_transform_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.transform_transform_tag ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transform_transform_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    blocker_id text NOT NULL,
    blocked_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_blocks_check CHECK ((blocker_id <> blocked_id))
);


--
-- Name: user_id; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_id (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    primary_phone text,
    primary_email text,
    contacts json,
    create_date timestamp without time zone DEFAULT now(),
    update_date timestamp without time zone DEFAULT now(),
    state text,
    internal_id character varying NOT NULL
);


--
-- Name: user_key_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_key_value (
    id integer NOT NULL,
    user_id integer NOT NULL,
    namespace character varying(254) NOT NULL,
    key character varying(254) NOT NULL,
    value text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: TABLE user_key_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_key_value IS 'A simple key value store for each user.';


--
-- Name: COLUMN user_key_value.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.user_id IS 'The ID of the user this KV-pair is for';


--
-- Name: COLUMN user_key_value.namespace; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.namespace IS 'The namespace for this KV, e.g. "dashboard-filters" or "nobody-knows"';


--
-- Name: COLUMN user_key_value.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.key IS 'The key';


--
-- Name: COLUMN user_key_value.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.value IS 'The value, serialized JSON';


--
-- Name: COLUMN user_key_value.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.created_at IS 'When this row was created';


--
-- Name: COLUMN user_key_value.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.updated_at IS 'When this row was last updated';


--
-- Name: COLUMN user_key_value.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_value.expires_at IS 'If set, when this row expires';


--
-- Name: user_key_value_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_key_value ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_key_value_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_parameter_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_parameter_value (
    id integer NOT NULL,
    user_id integer NOT NULL,
    parameter_id character varying(36) NOT NULL,
    value text,
    dashboard_id integer
);


--
-- Name: TABLE user_parameter_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_parameter_value IS 'Table holding last set value of a parameter per user';


--
-- Name: COLUMN user_parameter_value.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_parameter_value.user_id IS 'ID of the User who has set the parameter value';


--
-- Name: COLUMN user_parameter_value.parameter_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_parameter_value.parameter_id IS 'The parameter ID';


--
-- Name: COLUMN user_parameter_value.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_parameter_value.value IS 'Value of the parameter';


--
-- Name: COLUMN user_parameter_value.dashboard_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_parameter_value.dashboard_id IS 'The ID of the dashboard';


--
-- Name: user_parameter_value_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_parameter_value ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_parameter_value_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    telegram_username text,
    location_city text,
    intents json,
    available_destinations json,
    location_city_code integer,
    id uuid DEFAULT gen_random_uuid()
);


--
-- Name: user_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id text NOT NULL,
    target_id text NOT NULL,
    reason text NOT NULL,
    context_type text,
    context_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_reports_check CHECK ((reporter_id <> target_id))
);


--
-- Name: v_alerts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_alerts AS
 WITH parsed_cron AS (
         SELECT n_1.id,
            ns.cron_schedule,
            ns.ui_display_type,
            split_part((ns.cron_schedule)::text, ' '::text, 2) AS minutes,
            split_part((ns.cron_schedule)::text, ' '::text, 3) AS hours,
            split_part((ns.cron_schedule)::text, ' '::text, 4) AS day_of_month,
            split_part((ns.cron_schedule)::text, ' '::text, 6) AS day_of_week
           FROM (public.notification n_1
             JOIN public.notification_subscription ns ON ((n_1.id = ns.notification_id)))
          WHERE (((n_1.payload_type)::text = 'notification/card'::text) AND ((ns.type)::text = 'notification-subscription/cron'::text))
        ), schedule_info AS (
         SELECT parsed_cron.id,
                CASE
                    WHEN ((parsed_cron.ui_display_type)::text = 'cron/raw'::text) THEN 'custom'::text
                    WHEN ((parsed_cron.minutes ~ '^\*$'::text) OR (parsed_cron.minutes ~ '^\d+/\d+$'::text)) THEN 'by the minute'::text
                    WHEN ((parsed_cron.day_of_month <> '*'::text) AND ((parsed_cron.day_of_week = '?'::text) OR (parsed_cron.day_of_week ~ '^\d#1$'::text) OR (parsed_cron.day_of_week ~ '^\dL$'::text))) THEN 'monthly'::text
                    WHEN ((parsed_cron.day_of_week <> '?'::text) AND (parsed_cron.day_of_week <> '*'::text)) THEN 'weekly'::text
                    WHEN (parsed_cron.hours <> '*'::text) THEN 'daily'::text
                    ELSE 'hourly'::text
                END AS schedule_type,
                CASE
                    WHEN (parsed_cron.day_of_week ~ '^1'::text) THEN 'sun'::text
                    WHEN (parsed_cron.day_of_week ~ '^2'::text) THEN 'mon'::text
                    WHEN (parsed_cron.day_of_week ~ '^3'::text) THEN 'tue'::text
                    WHEN (parsed_cron.day_of_week ~ '^4'::text) THEN 'wed'::text
                    WHEN (parsed_cron.day_of_week ~ '^5'::text) THEN 'thu'::text
                    WHEN (parsed_cron.day_of_week ~ '^6'::text) THEN 'fri'::text
                    WHEN (parsed_cron.day_of_week ~ '^7'::text) THEN 'sat'::text
                    ELSE NULL::text
                END AS schedule_day,
                CASE
                    WHEN (parsed_cron.hours = '*'::text) THEN NULL::integer
                    WHEN (parsed_cron.hours ~ '^\d+$'::text) THEN (parsed_cron.hours)::integer
                    WHEN (parsed_cron.hours ~ '^(\d+)/\d+$'::text) THEN ("substring"(parsed_cron.hours, '^(\d+)/\d+$'::text))::integer
                    ELSE NULL::integer
                END AS schedule_hour
           FROM parsed_cron
        ), agg_recipients AS (
         SELECT nr.notification_handler_id,
            string_agg((cu.email)::text, ','::text) AS recipients,
            ( SELECT string_agg(nr2.details, ','::text) AS string_agg
                   FROM public.notification_recipient nr2
                  WHERE ((nr2.notification_handler_id = nr.notification_handler_id) AND ((nr2.type)::text = 'notification-recipient/raw-value'::text))) AS recipient_external
           FROM (public.notification_recipient nr
             LEFT JOIN public.core_user cu ON (((nr.user_id = cu.id) AND ((nr.type)::text = 'notification-recipient/user'::text))))
          GROUP BY nr.notification_handler_id
        )
 SELECT n.id AS entity_id,
    ('notification_'::text || n.id) AS entity_qualified_id,
    n.created_at,
    n.updated_at,
    n.creator_id,
    nc.card_id,
    ('card_'::text || nc.card_id) AS card_qualified_id,
        CASE
            WHEN ((nc.send_condition)::text = 'has_result'::text) THEN 'rows'::text
            WHEN ((nc.send_condition)::text = ANY (ARRAY[('goal_above'::character varying)::text, ('goal_below'::character varying)::text])) THEN 'goal'::text
            ELSE NULL::text
        END AS alert_condition,
    si.schedule_type,
    si.schedule_day,
    si.schedule_hour,
    (NOT n.active) AS archived,
    nh.channel_type AS recipient_type,
    ar.recipients,
    ar.recipient_external
   FROM ((((public.notification n
     JOIN public.notification_card nc ON ((n.payload_id = nc.id)))
     JOIN schedule_info si ON ((n.id = si.id)))
     LEFT JOIN public.notification_handler nh ON ((n.id = nh.notification_id)))
     LEFT JOIN agg_recipients ar ON ((nh.id = ar.notification_handler_id)))
  WHERE ((n.payload_type)::text = 'notification/card'::text);


--
-- Name: v_audit_log; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_audit_log AS
 SELECT id,
        CASE
            WHEN ((topic)::text = 'card-create'::text) THEN 'card-create'::character varying
            WHEN ((topic)::text = 'card-delete'::text) THEN 'card-delete'::character varying
            WHEN ((topic)::text = 'card-update'::text) THEN 'card-update'::character varying
            WHEN ((topic)::text = 'pulse-create'::text) THEN 'subscription-create'::character varying
            WHEN ((topic)::text = 'pulse-delete'::text) THEN 'subscription-delete'::character varying
            ELSE topic
        END AS topic,
    "timestamp",
    NULL::text AS end_timestamp,
    COALESCE(user_id, 0) AS user_id,
    lower((model)::text) AS entity_type,
    model_id AS entity_id,
        CASE
            WHEN ((model)::text = 'Dataset'::text) THEN ('card_'::text || model_id)
            WHEN (model_id IS NULL) THEN NULL::text
            ELSE ((lower((model)::text) || '_'::text) || model_id)
        END AS entity_qualified_id,
    details
   FROM public.audit_log
  WHERE ((topic)::text <> ALL (ARRAY[('card-read'::character varying)::text, ('card-query'::character varying)::text, ('dashboard-read'::character varying)::text, ('dashboard-query'::character varying)::text, ('table-read'::character varying)::text]));


--
-- Name: v_content; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_content AS
 SELECT action.id AS entity_id,
    ('action_'::text || action.id) AS entity_qualified_id,
    'action'::text AS entity_type,
    action.created_at,
    action.updated_at,
    action.creator_id,
    action.name,
    action.description,
    NULL::integer AS collection_id,
    action.made_public_by_id AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    action.archived,
    action.type AS action_type,
    action.model_id AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM public.action
UNION
 SELECT collection.id AS entity_id,
    ('collection_'::text || collection.id) AS entity_qualified_id,
    'collection'::text AS entity_type,
    collection.created_at,
    NULL::timestamp with time zone AS updated_at,
    NULL::integer AS creator_id,
    collection.name,
    collection.description,
    NULL::integer AS collection_id,
    NULL::integer AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    collection.archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
        CASE
            WHEN ((collection.authority_level)::text = 'official'::text) THEN true
            ELSE false
        END AS collection_is_official,
        CASE
            WHEN (collection.personal_owner_id IS NOT NULL) THEN true
            ELSE false
        END AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM public.collection
UNION
 SELECT report_card.id AS entity_id,
    ('card_'::text || report_card.id) AS entity_qualified_id,
    report_card.type AS entity_type,
    report_card.created_at,
    report_card.updated_at,
    report_card.creator_id,
    report_card.name,
    report_card.description,
    report_card.collection_id,
    report_card.made_public_by_id AS made_public_by_user,
    report_card.enable_embedding AS is_embedding_enabled,
        CASE
            WHEN moderation.is_verified THEN true
            ELSE false
        END AS is_verified,
    report_card.archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    report_card.display AS question_viz_type,
    ('database_'::text || report_card.database_id) AS question_database_id,
        CASE
            WHEN ((report_card.query_type)::text = 'native'::text) THEN true
            ELSE false
        END AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM (public.report_card
     LEFT JOIN ( SELECT (((moderation_review.moderated_item_type)::text || '_'::text) || moderation_review.moderated_item_id) AS entity_qualified_id,
                CASE
                    WHEN ((moderation_review.status)::text = 'verified'::text) THEN true
                    ELSE false
                END AS is_verified
           FROM public.moderation_review
          WHERE moderation_review.most_recent) moderation ON ((('card_'::text || report_card.id) = moderation.entity_qualified_id)))
UNION
 SELECT report_dashboard.id AS entity_id,
    ('dashboard_'::text || report_dashboard.id) AS entity_qualified_id,
    'dashboard'::text AS entity_type,
    report_dashboard.created_at,
    report_dashboard.updated_at,
    report_dashboard.creator_id,
    report_dashboard.name,
    report_dashboard.description,
    report_dashboard.collection_id,
    report_dashboard.made_public_by_id AS made_public_by_user,
    report_dashboard.enable_embedding AS is_embedding_enabled,
        CASE
            WHEN moderation.is_verified THEN true
            ELSE false
        END AS is_verified,
    report_dashboard.archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM (public.report_dashboard
     LEFT JOIN ( SELECT (((moderation_review.moderated_item_type)::text || '_'::text) || moderation_review.moderated_item_id) AS entity_qualified_id,
                CASE
                    WHEN ((moderation_review.status)::text = 'verified'::text) THEN true
                    ELSE false
                END AS is_verified
           FROM public.moderation_review
          WHERE moderation_review.most_recent) moderation ON ((('dashboard_'::text || report_dashboard.id) = moderation.entity_qualified_id)))
UNION
 SELECT document.id AS entity_id,
    ('document_'::text || document.id) AS entity_qualified_id,
    'document'::text AS entity_type,
    document.created_at,
    document.updated_at,
    document.creator_id,
    document.name,
    NULL::text AS description,
    document.collection_id,
    NULL::integer AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    document.archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM public.document
UNION
 SELECT event.id AS entity_id,
    ('event_'::text || event.id) AS entity_qualified_id,
    'event'::text AS entity_type,
    event.created_at,
    event.updated_at,
    event.creator_id,
    event.name,
    event.description,
    timeline.collection_id,
    NULL::integer AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    event.archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    event."timestamp" AS event_timestamp
   FROM (public.timeline_event event
     LEFT JOIN public.timeline ON ((event.timeline_id = timeline.id)))
UNION
 SELECT transform.id AS entity_id,
    ('transform_'::text || transform.id) AS entity_qualified_id,
    'transform'::text AS entity_type,
    transform.created_at,
    transform.updated_at,
    transform.creator_id,
    transform.name,
    transform.description,
    NULL::integer AS collection_id,
    NULL::integer AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    false AS archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM public.transform
UNION
 SELECT glossary.id AS entity_id,
    ('glossary_'::text || glossary.id) AS entity_qualified_id,
    'glossary'::text AS entity_type,
    glossary.created_at,
    glossary.updated_at,
    glossary.creator_id,
    glossary.term AS name,
    glossary.definition AS description,
    NULL::integer AS collection_id,
    NULL::integer AS made_public_by_user,
    NULL::boolean AS is_embedding_enabled,
    NULL::boolean AS is_verified,
    false AS archived,
    NULL::text AS action_type,
    NULL::integer AS action_model_id,
    NULL::boolean AS collection_is_official,
    NULL::boolean AS collection_is_personal,
    NULL::text AS question_viz_type,
    NULL::text AS question_database_id,
    NULL::boolean AS question_is_native,
    NULL::timestamp without time zone AS event_timestamp
   FROM public.glossary;


--
-- Name: v_dashboardcard; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_dashboardcard AS
 SELECT id AS entity_id,
    concat('dashboardcard_', id) AS entity_qualified_id,
    concat('dashboard_', dashboard_id) AS dashboard_qualified_id,
    concat('dashboardtab_', dashboard_tab_id) AS dashboardtab_id,
    concat('card_', card_id) AS card_qualified_id,
    created_at,
    updated_at,
    size_x,
    size_y,
    visualization_settings,
    parameter_mappings
   FROM public.report_dashboardcard;


--
-- Name: v_databases; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_databases AS
 SELECT id AS entity_id,
    concat('database_', id) AS entity_qualified_id,
    created_at,
    updated_at,
    name,
    description,
    engine AS database_type,
    metadata_sync_schedule,
    cache_field_values_schedule,
    timezone,
    is_on_demand,
    auto_run_queries,
    cache_ttl,
    creator_id,
    dbms_version AS db_version
   FROM public.metabase_database
  WHERE (id <> 13371337);


--
-- Name: v_fields; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_fields AS
 SELECT id AS entity_id,
    ('field_'::text || id) AS entity_qualified_id,
    created_at,
    updated_at,
    name,
    display_name,
    description,
    base_type,
    visibility_type,
    fk_target_field_id,
    has_field_values,
    active,
    table_id
   FROM public.metabase_field;


--
-- Name: v_group_members; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_group_members AS
 SELECT permissions_group_membership.user_id,
    permissions_group.id AS group_id,
    permissions_group.name AS group_name
   FROM (public.permissions_group_membership
     LEFT JOIN public.permissions_group ON ((permissions_group_membership.group_id = permissions_group.id)))
UNION
 SELECT 0 AS user_id,
    0 AS group_id,
    'Anonymous users'::character varying AS group_name;


--
-- Name: v_query_log; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_query_log AS
 SELECT query_execution.id AS entity_id,
    query_execution.started_at,
    ((query_execution.running_time)::double precision / (1000)::double precision) AS running_time_seconds,
    query_execution.result_rows,
    query_execution.native AS is_native,
    query_execution.context AS query_source,
    query_execution.error,
    COALESCE(query_execution.executor_id, 0) AS user_id,
    query_execution.card_id,
    ('card_'::text || query_execution.card_id) AS card_qualified_id,
    query_execution.dashboard_id,
    ('dashboard_'::text || query_execution.dashboard_id) AS dashboard_qualified_id,
    query_execution.pulse_id,
    query_execution.database_id,
    ('database_'::text || query_execution.database_id) AS database_qualified_id,
    query_execution.cache_hit,
    query_execution.action_id,
    ('action_'::text || query_execution.action_id) AS action_qualified_id,
    query.query
   FROM (public.query_execution
     LEFT JOIN public.query ON ((query_execution.hash = query.query_hash)));


--
-- Name: v_subscriptions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_subscriptions AS
 WITH agg_recipients AS (
         SELECT pulse_channel_recipient.pulse_channel_id,
            string_agg((core_user.email)::text, ','::text) AS recipients
           FROM (public.pulse_channel_recipient
             LEFT JOIN public.core_user ON ((pulse_channel_recipient.user_id = core_user.id)))
          GROUP BY pulse_channel_recipient.pulse_channel_id
        )
 SELECT pulse.id AS entity_id,
    ('pulse_'::text || pulse.id) AS entity_qualified_id,
    pulse.created_at,
    pulse.updated_at,
    pulse.creator_id,
    pulse.archived,
    ('dashboard_'::text || pulse.dashboard_id) AS dashboard_qualified_id,
    pulse_channel.schedule_type,
    pulse_channel.schedule_day,
    pulse_channel.schedule_hour,
    pulse_channel.channel_type AS recipient_type,
    agg_recipients.recipients,
    pulse_channel.details AS recipient_external,
    pulse.parameters
   FROM ((public.pulse
     LEFT JOIN public.pulse_channel ON ((pulse.id = pulse_channel.pulse_id)))
     LEFT JOIN agg_recipients ON ((pulse_channel.id = agg_recipients.pulse_channel_id)))
  WHERE (pulse.alert_condition IS NULL);


--
-- Name: v_tables; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_tables AS
 SELECT id AS entity_id,
    ('table_'::text || id) AS entity_qualified_id,
    created_at,
    updated_at,
    name,
    display_name,
    description,
    active,
    db_id AS database_id,
    schema,
    is_upload,
    entity_type,
    visibility_type,
    estimated_row_count,
    view_count,
    owner_email,
    owner_user_id
   FROM public.metabase_table;


--
-- Name: v_tasks; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_tasks AS
 SELECT id,
    task,
    status,
    ('database_'::text || db_id) AS database_qualified_id,
    started_at,
    ended_at,
    ((duration)::double precision / (1000)::double precision) AS duration_seconds,
    task_details AS details
   FROM public.task_history;


--
-- Name: v_users; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_users AS
 SELECT core_user.id AS user_id,
    ('user_'::text || core_user.id) AS entity_qualified_id,
    core_user.type,
        CASE
            WHEN ((core_user.type)::text = 'api-key'::text) THEN NULL::public.citext
            ELSE core_user.email
        END AS email,
    core_user.first_name,
    core_user.last_name,
    COALESCE((((core_user.first_name)::text || ' '::text) || (core_user.last_name)::text), (core_user.first_name)::text, (core_user.last_name)::text) AS full_name,
    core_user.date_joined,
    core_user.last_login,
    core_user.updated_at,
    core_user.is_superuser AS is_admin,
    core_user.is_active,
    core_user.sso_source,
    core_user.locale
   FROM public.core_user
UNION
 SELECT 0 AS user_id,
    'user_0'::text AS entity_qualified_id,
    'anonymous'::character varying AS type,
    NULL::public.citext AS email,
    'External'::character varying AS first_name,
    'User'::character varying AS last_name,
    'External User'::text AS full_name,
    NULL::timestamp with time zone AS date_joined,
    NULL::timestamp with time zone AS last_login,
    NULL::timestamp with time zone AS updated_at,
    false AS is_admin,
    NULL::boolean AS is_active,
    NULL::character varying AS sso_source,
    NULL::character varying AS locale;


--
-- Name: view_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view_log (
    id integer NOT NULL,
    user_id integer,
    model character varying(16) NOT NULL,
    model_id integer NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    metadata text,
    has_access boolean,
    context character varying(32),
    embedding_client character varying(254),
    embedding_version character varying(254)
);


--
-- Name: COLUMN view_log.has_access; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.view_log.has_access IS 'Whether the user who initiated the view had read access to the item being viewed.';


--
-- Name: COLUMN view_log.context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.view_log.context IS 'The context of the view, can be collection, question, or dashboard. Only for cards.';


--
-- Name: COLUMN view_log.embedding_client; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.view_log.embedding_client IS 'Used by the embedding team to track SDK usage';


--
-- Name: COLUMN view_log.embedding_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.view_log.embedding_version IS 'Used by the embedding team to track SDK version usage';


--
-- Name: v_view_log; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_view_log AS
 SELECT id,
    "timestamp",
    COALESCE(user_id, 0) AS user_id,
    model AS entity_type,
    model_id AS entity_id,
    (((model)::text || '_'::text) || model_id) AS entity_qualified_id
   FROM public.view_log;


--
-- Name: video_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    mode text NOT NULL,
    model text NOT NULL,
    quality text NOT NULL,
    duration_sec integer NOT NULL,
    prompt text,
    negative_prompt text,
    cfg_scale numeric(3,1),
    source_image_url text,
    source_video_id uuid,
    camera_type text,
    camera_config jsonb,
    audio_url text,
    tokens_spent bigint NOT NULL,
    kling_task_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    video_url text,
    thumbnail_url text,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: view_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.view_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.view_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.agents_id_seq'::regclass);


--
-- Name: ai-profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ai-profiles" ALTER COLUMN id SET DEFAULT nextval('public."ai-profiles_id_seq"'::regclass);


--
-- Name: ai_profiles_consolidated id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_profiles_consolidated ALTER COLUMN id SET DEFAULT nextval('public.ai_profiles_consolidated_id_seq'::regclass);


--
-- Name: contact_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_requests ALTER COLUMN id SET DEFAULT nextval('public.contact_requests_id_seq'::regclass);


--
-- Name: coupon_redemptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions ALTER COLUMN id SET DEFAULT nextval('public.coupon_redemptions_id_seq'::regclass);


--
-- Name: coupons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons ALTER COLUMN id SET DEFAULT nextval('public.coupons_id_seq'::regclass);


--
-- Name: custom_chat_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_chat_history ALTER COLUMN id SET DEFAULT nextval('public.custom_chat_history_id_seq'::regclass);


--
-- Name: dozvon_calls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_calls ALTER COLUMN id SET DEFAULT nextval('public.dozvon_calls_id_seq'::regclass);


--
-- Name: dozvon_campaigns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_campaigns ALTER COLUMN id SET DEFAULT nextval('public.dozvon_campaigns_id_seq'::regclass);


--
-- Name: dozvon_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_contacts ALTER COLUMN id SET DEFAULT nextval('public.dozvon_contacts_id_seq'::regclass);


--
-- Name: dozvon_pricing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_pricing ALTER COLUMN id SET DEFAULT nextval('public.dozvon_pricing_id_seq'::regclass);


--
-- Name: findmate_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findmate_histories ALTER COLUMN id SET DEFAULT nextval('public.findmate_histories_id_seq'::regclass);


--
-- Name: game_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_sessions ALTER COLUMN id SET DEFAULT nextval('public.game_sessions_id_seq'::regclass);


--
-- Name: generated_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_images ALTER COLUMN id SET DEFAULT nextval('public.generated_images_id_seq'::regclass);


--
-- Name: llm_pricing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_pricing ALTER COLUMN id SET DEFAULT nextval('public.llm_pricing_id_seq'::regclass);


--
-- Name: metaphor_cards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metaphor_cards ALTER COLUMN id SET DEFAULT nextval('public.metaphor_cards_id_seq'::regclass);


--
-- Name: n8n_chat_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.n8n_chat_histories ALTER COLUMN id SET DEFAULT nextval('public.n8n_chat_histories_id_seq'::regclass);


--
-- Name: n8n_chat_histories_avia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.n8n_chat_histories_avia ALTER COLUMN id SET DEFAULT nextval('public.n8n_chat_histories_avia_id_seq'::regclass);


--
-- Name: n8n_chat_histories_cop id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.n8n_chat_histories_cop ALTER COLUMN id SET DEFAULT nextval('public.n8n_chat_histories_cop_id_seq'::regclass);


--
-- Name: n8n_chat_histories_travel id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.n8n_chat_histories_travel ALTER COLUMN id SET DEFAULT nextval('public.n8n_chat_histories_travel_id_seq'::regclass);


--
-- Name: n8n_chat_histories_yasha id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.n8n_chat_histories_yasha ALTER COLUMN id SET DEFAULT nextval('public.n8n_chat_histories_yasha_id_seq'::regclass);


--
-- Name: olya_chat_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.olya_chat_histories ALTER COLUMN id SET DEFAULT nextval('public.olya_chat_histories_id_seq'::regclass);


--
-- Name: realtime_chat_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_chat_history ALTER COLUMN id SET DEFAULT nextval('public.realtime_chat_history_id_seq'::regclass);


--
-- Name: sales_chat_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_chat_histories ALTER COLUMN id SET DEFAULT nextval('public.sales_chat_histories_id_seq'::regclass);


--
-- Name: search_chat_histories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_chat_histories ALTER COLUMN id SET DEFAULT nextval('public.search_chat_histories_id_seq'::regclass);


--
-- Name: search_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history ALTER COLUMN id SET DEFAULT nextval('public.search_history_id_seq'::regclass);


--
-- Name: task_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_events ALTER COLUMN id SET DEFAULT nextval('public.task_events_id_seq'::regclass);


--
-- Name: ai_profiles_consolidated ai_profiles_consolidated_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_profiles_consolidated
    ADD CONSTRAINT ai_profiles_consolidated_user_id_key UNIQUE (user_id);


--
-- Name: chat_requests chat_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_requests
    ADD CONSTRAINT chat_requests_pkey PRIMARY KEY (id);


--
-- Name: contact_requests contact_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_requests
    ADD CONSTRAINT contact_requests_pkey PRIMARY KEY (id);


--
-- Name: dozvon_calls dozvon_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_calls
    ADD CONSTRAINT dozvon_calls_pkey PRIMARY KEY (id);


--
-- Name: dozvon_campaigns dozvon_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_campaigns
    ADD CONSTRAINT dozvon_campaigns_pkey PRIMARY KEY (id);


--
-- Name: dozvon_contacts dozvon_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_contacts
    ADD CONSTRAINT dozvon_contacts_pkey PRIMARY KEY (id);


--
-- Name: dozvon_pricing dozvon_pricing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_pricing
    ADD CONSTRAINT dozvon_pricing_pkey PRIMARY KEY (id);


--
-- Name: dozvon_settings dozvon_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_settings
    ADD CONSTRAINT dozvon_settings_pkey PRIMARY KEY (user_id);


--
-- Name: generated_images generated_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_images
    ADD CONSTRAINT generated_images_pkey PRIMARY KEY (id);


--
-- Name: peer_conversations peer_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peer_conversations
    ADD CONSTRAINT peer_conversations_pkey PRIMARY KEY (id);


--
-- Name: peer_messages peer_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peer_messages
    ADD CONSTRAINT peer_messages_pkey PRIMARY KEY (id);


--
-- Name: referral_referees referral_referees_referee_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_referees
    ADD CONSTRAINT referral_referees_referee_phone_key UNIQUE (referee_phone);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: service_health service_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_health
    ADD CONSTRAINT service_health_pkey PRIMARY KEY (service);


--
-- Name: smm_billing_ledger smm_billing_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_billing_ledger
    ADD CONSTRAINT smm_billing_ledger_pkey PRIMARY KEY (id);


--
-- Name: smm_campaign smm_campaign_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_campaign
    ADD CONSTRAINT smm_campaign_pkey PRIMARY KEY (id);


--
-- Name: smm_creator_campaign smm_creator_campaign_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_creator_campaign
    ADD CONSTRAINT smm_creator_campaign_pkey PRIMARY KEY (campaign_id);


--
-- Name: smm_event_log smm_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_event_log
    ADD CONSTRAINT smm_event_log_pkey PRIMARY KEY (id);


--
-- Name: smm_music_track smm_music_track_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_music_track
    ADD CONSTRAINT smm_music_track_pkey PRIMARY KEY (id);


--
-- Name: smm_oauth_state smm_oauth_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_oauth_state
    ADD CONSTRAINT smm_oauth_state_pkey PRIMARY KEY (state);


--
-- Name: smm_premium_generation smm_premium_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_premium_generation
    ADD CONSTRAINT smm_premium_generation_pkey PRIMARY KEY (id);


--
-- Name: smm_pricing smm_pricing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_pricing
    ADD CONSTRAINT smm_pricing_pkey PRIMARY KEY (id);


--
-- Name: smm_publication smm_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_publication
    ADD CONSTRAINT smm_publication_pkey PRIMARY KEY (id);


--
-- Name: smm_publication smm_publication_video_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_publication
    ADD CONSTRAINT smm_publication_video_id_platform_key UNIQUE (video_id, platform);


--
-- Name: smm_scenario smm_scenario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_scenario
    ADD CONSTRAINT smm_scenario_pkey PRIMARY KEY (id);


--
-- Name: smm_social_account smm_social_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_social_account
    ADD CONSTRAINT smm_social_account_pkey PRIMARY KEY (id);


--
-- Name: smm_video smm_video_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_video
    ADD CONSTRAINT smm_video_pkey PRIMARY KEY (id);


--
-- Name: smm_video smm_video_scenario_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_video
    ADD CONSTRAINT smm_video_scenario_id_key UNIQUE (scenario_id);


--
-- Name: support_events support_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_events
    ADD CONSTRAINT support_events_pkey PRIMARY KEY (id);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: task_events task_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (blocker_id, blocked_id);


--
-- Name: user_id user_id_internal_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_id
    ADD CONSTRAINT user_id_internal_id_key UNIQUE (internal_id);


--
-- Name: user_reports user_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reports
    ADD CONSTRAINT user_reports_pkey PRIMARY KEY (id);


--
-- Name: video_jobs video_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_jobs
    ADD CONSTRAINT video_jobs_pkey PRIMARY KEY (id);


--
-- Name: idx_chat_requests_from_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_requests_from_status ON public.chat_requests USING btree (from_user_id, status, created_at DESC);


--
-- Name: idx_chat_requests_to_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_requests_to_status ON public.chat_requests USING btree (to_user_id, status, created_at DESC);


--
-- Name: idx_contact_req_pending_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contact_req_pending_unique ON public.contact_requests USING btree (requester_id, target_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_contact_req_requester; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_req_requester ON public.contact_requests USING btree (requester_id, created_at DESC);


--
-- Name: idx_contact_req_target_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_req_target_status ON public.contact_requests USING btree (target_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_coupons_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_coupons_code ON public.coupons USING btree (code);


--
-- Name: idx_custom_chat_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_chat_session ON public.custom_chat_history USING btree (session_id, created_at);


--
-- Name: idx_dozvon_calls_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_calls_campaign_id ON public.dozvon_calls USING btree (campaign_id);


--
-- Name: idx_dozvon_calls_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_calls_status ON public.dozvon_calls USING btree (status);


--
-- Name: idx_dozvon_campaigns_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_campaigns_scheduled ON public.dozvon_campaigns USING btree (scheduled_at) WHERE ((scheduled_at IS NOT NULL) AND (status = 'scheduled'::text));


--
-- Name: idx_dozvon_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_campaigns_status ON public.dozvon_campaigns USING btree (status);


--
-- Name: idx_dozvon_campaigns_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_campaigns_user_id ON public.dozvon_campaigns USING btree (user_id);


--
-- Name: idx_dozvon_contacts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dozvon_contacts_user_id ON public.dozvon_contacts USING btree (user_id);


--
-- Name: idx_gen_images_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gen_images_user ON public.generated_images USING btree (user_id, created_at DESC);


--
-- Name: idx_peer_conversations_user_a_last; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peer_conversations_user_a_last ON public.peer_conversations USING btree (user_a_id, last_message_at DESC NULLS LAST);


--
-- Name: idx_peer_conversations_user_b_last; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peer_conversations_user_b_last ON public.peer_conversations USING btree (user_b_id, last_message_at DESC NULLS LAST);


--
-- Name: idx_peer_messages_conv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peer_messages_conv_created ON public.peer_messages USING btree (conversation_id, created_at DESC);


--
-- Name: idx_peer_messages_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_peer_messages_unread ON public.peer_messages USING btree (conversation_id, sender_id) WHERE (read_at IS NULL);


--
-- Name: idx_premium_gen_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_premium_gen_user_created ON public.smm_premium_generation USING btree (user_id, created_at DESC);


--
-- Name: idx_premium_gen_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_premium_gen_video ON public.smm_premium_generation USING btree (video_id);


--
-- Name: idx_smm_campaign_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_campaign_user_created ON public.smm_campaign USING btree (user_id, created_at DESC);


--
-- Name: idx_smm_event_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_event_log_created ON public.smm_event_log USING btree (created_at DESC);


--
-- Name: idx_smm_event_log_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_event_log_publication ON public.smm_event_log USING btree (publication_id, created_at DESC) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_smm_event_log_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_event_log_video ON public.smm_event_log USING btree (video_id, created_at DESC) WHERE (video_id IS NOT NULL);


--
-- Name: idx_smm_ledger_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_ledger_user_created ON public.smm_billing_ledger USING btree (user_id, created_at DESC);


--
-- Name: idx_smm_ledger_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_ledger_video ON public.smm_billing_ledger USING btree (video_id);


--
-- Name: idx_smm_oauth_state_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_oauth_state_created ON public.smm_oauth_state USING btree (created_at);


--
-- Name: idx_smm_publication_publish_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_publication_publish_job ON public.smm_publication USING btree (publish_job_id) WHERE (publish_job_id IS NOT NULL);


--
-- Name: idx_smm_publication_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_publication_scheduled ON public.smm_publication USING btree (scheduled_at) WHERE (status = 'scheduled'::text);


--
-- Name: idx_smm_publication_user_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_publication_user_scheduled ON public.smm_publication USING btree (status, scheduled_at);


--
-- Name: idx_smm_scenario_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_scenario_campaign ON public.smm_scenario USING btree (campaign_id, created_at);


--
-- Name: idx_smm_social_account_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_social_account_user_platform ON public.smm_social_account USING btree (user_id, platform);


--
-- Name: idx_smm_video_render_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_video_render_job ON public.smm_video USING btree (render_job_id) WHERE (render_job_id IS NOT NULL);


--
-- Name: idx_smm_video_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_smm_video_status ON public.smm_video USING btree (status) WHERE (status = ANY (ARRAY['queued'::text, 'rendering'::text, 'failed'::text]));


--
-- Name: idx_support_events_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_events_ticket ON public.support_events USING btree (ticket_id, created_at);


--
-- Name: idx_support_messages_ticket_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_messages_ticket_created ON public.support_messages USING btree (ticket_id, created_at);


--
-- Name: idx_support_tickets_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_status_updated ON public.support_tickets USING btree (status, updated_at DESC);


--
-- Name: idx_support_tickets_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_user_created ON public.support_tickets USING btree (user_id, created_at DESC);


--
-- Name: idx_task_events_task_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_events_task_created ON public.task_events USING btree (task_id, created_at DESC);


--
-- Name: idx_tasks_status_archive_candidate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_status_archive_candidate ON public.tasks USING btree (status, last_active_at) WHERE (status = 'active'::text);


--
-- Name: idx_tasks_user_status_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_user_status_recent ON public.tasks USING btree (user_id, status, last_active_at DESC);


--
-- Name: idx_token_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_tasks_status ON public.token_consumption_tasks USING btree (status);


--
-- Name: idx_user_blocks_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_id);


--
-- Name: idx_user_reports_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_reports_target ON public.user_reports USING btree (target_id, created_at DESC);


--
-- Name: idx_video_jobs_active_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_video_jobs_active_status ON public.video_jobs USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: idx_video_jobs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_video_jobs_user_created ON public.video_jobs USING btree (user_id, created_at DESC);


--
-- Name: uniq_chat_requests_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_chat_requests_pending ON public.chat_requests USING btree (from_user_id, to_user_id) WHERE (status = 'pending'::text);


--
-- Name: uniq_peer_conversations_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_peer_conversations_pair ON public.peer_conversations USING btree (user_a_id, user_b_id);


--
-- Name: uniq_support_tickets_active_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_support_tickets_active_per_user ON public.support_tickets USING btree (user_id) WHERE (status = ANY (ARRAY['ai_handling'::text, 'escalated'::text, 'owner_handling'::text]));


--
-- Name: uq_smm_ledger_refund_per_video; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_smm_ledger_refund_per_video ON public.smm_billing_ledger USING btree (video_id) WHERE (op = 'refund'::text);


--
-- Name: smm_creator_campaign smm_creator_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_creator_updated_at BEFORE UPDATE ON public.smm_creator_campaign FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_campaign smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_campaign FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_pricing smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_pricing FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_publication smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_publication FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_scenario smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_scenario FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_social_account smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_social_account FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: smm_video smm_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smm_updated_at BEFORE UPDATE ON public.smm_video FOR EACH ROW EXECUTE FUNCTION public.trg_smm_set_updated_at();


--
-- Name: dozvon_calls dozvon_calls_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dozvon_calls
    ADD CONSTRAINT dozvon_calls_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.dozvon_campaigns(id) ON DELETE CASCADE;


--
-- Name: peer_conversations peer_conversations_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peer_conversations
    ADD CONSTRAINT peer_conversations_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.chat_requests(id) ON DELETE SET NULL;


--
-- Name: peer_messages peer_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.peer_messages
    ADD CONSTRAINT peer_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.peer_conversations(id) ON DELETE CASCADE;


--
-- Name: smm_billing_ledger smm_billing_ledger_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_billing_ledger
    ADD CONSTRAINT smm_billing_ledger_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.smm_video(id) ON DELETE SET NULL;


--
-- Name: smm_creator_campaign smm_creator_campaign_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_creator_campaign
    ADD CONSTRAINT smm_creator_campaign_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.smm_campaign(id) ON DELETE CASCADE;


--
-- Name: smm_event_log smm_event_log_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_event_log
    ADD CONSTRAINT smm_event_log_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.smm_publication(id) ON DELETE SET NULL;


--
-- Name: smm_event_log smm_event_log_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_event_log
    ADD CONSTRAINT smm_event_log_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.smm_video(id) ON DELETE SET NULL;


--
-- Name: smm_premium_generation smm_premium_generation_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_premium_generation
    ADD CONSTRAINT smm_premium_generation_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.smm_video(id) ON DELETE CASCADE;


--
-- Name: smm_publication smm_publication_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_publication
    ADD CONSTRAINT smm_publication_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.smm_video(id) ON DELETE CASCADE;


--
-- Name: smm_scenario smm_scenario_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_scenario
    ADD CONSTRAINT smm_scenario_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.smm_campaign(id) ON DELETE CASCADE;


--
-- Name: smm_video smm_video_scenario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.smm_video
    ADD CONSTRAINT smm_video_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES public.smm_scenario(id) ON DELETE CASCADE;


--
-- Name: support_events support_events_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_events
    ADD CONSTRAINT support_events_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: support_messages support_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: task_events task_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: video_jobs video_jobs_source_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_jobs
    ADD CONSTRAINT video_jobs_source_video_id_fkey FOREIGN KEY (source_video_id) REFERENCES public.video_jobs(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


