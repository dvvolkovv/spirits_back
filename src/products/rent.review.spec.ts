/**
 * РЕВИЗИЯ СПИСАНИЯ АРЕНДЫ (задачи 2 и 3 куска 3). Сценарии придуманы
 * проверяющим, не исполнителем; задача каждого — снять деньги ДВАЖДЫ или снять
 * НЕ ТУ СУММУ.
 *
 * ОТДЕЛЬНАЯ ПЕРЕМЕННАЯ ОКРУЖЕНИЯ, И ЭТО НЕ ПРИДИРКА. Этот файл и
 * provisioning.integration.spec.ts чистят ОДНИ И ТЕ ЖЕ таблицы в своих
 * beforeEach, а jest гоняет сьюты параллельными процессами. В одной базе они
 * стирают фикстуры друг другу на середине: измерено 16.09.2026 — совместный
 * прогон на общей базе дал 19 красных из 19 при полностью исправном коде, то
 * есть прибор врал бы ровно так, как уже врал в этой работе десять раз.
 * Поэтому запуск здесь свой и база своя:
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS rent_review"
 *   sudo -u postgres psql -qc "CREATE DATABASE rent_review OWNER dv"
 *   RENT_REVIEW_PG_URL="postgres:///rent_review?host=/var/run/postgresql" \
 *     npx jest src/products/rent.review.spec.ts
 *
 * Без переменной файл пропускается целиком, и обычный `npx jest src/products`
 * остаётся ровно тем, чем был.
 *
 * ЧТО ВЫЯСНЕНО ЭТИМИ СЦЕНАРИЯМИ (16.09.2026, PostgreSQL 16):
 *   - списать дважды или списать не 50 000 не удалось ни одним способом;
 *   - замок на строке баланса берётся ПО-НАСТОЯЩЕМУ и РАНЬШЕ замка на строке
 *     продукта — снято из pg_locks в момент ожидания (R16 — то же самое с
 *     другой стороны: обратный порядок даёт настоящий deadlock);
 *   - учёт токенов совпадает с consume_user_tokens построчно (R14);
 *   - ЕДИНСТВЕННАЯ найденная дыра — чужая и старая: add_user_tokens читает
 *     баланс БЕЗ замка и пишет посчитанное значение целиком, поэтому
 *     пополнение, случившееся ровно в момент списания, ВОЗВРАЩАЕТ владельцу
 *     деньги за уже занятый месяц (R4). Дыра не в аренде: тот же танец с
 *     consume_user_tokens даёт тот же результат (R4-контроль).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { RENT_TOKENS, RentService } from './rent.service';

const PG = process.env.RENT_REVIEW_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('ревизия: списание аренды', () => {
  jest.setTimeout(120_000);

  let pool: Pool;
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 32 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }
    await pool.query(`DO $$ BEGIN
       CREATE TYPE transaction_type_enum AS ENUM
         ('purchase','consumed','bonus','refund','adjustment','coupon');
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_profiles_consolidated (
       id serial PRIMARY KEY,
       user_id text NOT NULL UNIQUE,
       tokens bigint NOT NULL DEFAULT 0,
       updated_at timestamptz DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS token_transactions (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id text NOT NULL,
       transaction_type transaction_type_enum NOT NULL,
       amount bigint NOT NULL,
       balance_after bigint NOT NULL,
       description text,
       metadata jsonb,
       created_at timestamptz DEFAULT now())`);
    // Обе процедуры сняты с прода дословно (\sf, 16.09.2026): гонка аренды с
    // ходом и с пополнением проверяется ТЕМ ЖЕ кодом, что работает на проде,
    // а не выдуманным UPDATE.
    await pool.query(`
      CREATE OR REPLACE FUNCTION consume_user_tokens(p_user_id text, p_amount bigint,
        p_description text DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS json
      LANGUAGE plpgsql AS $$
      DECLARE v_current_balance BIGINT; v_new_balance BIGINT; v_actual_amount BIGINT;
      BEGIN
        SELECT COALESCE(tokens,0) INTO v_current_balance FROM ai_profiles_consolidated
         WHERE user_id = p_user_id FOR UPDATE;
        IF v_current_balance IS NULL THEN
          INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES (p_user_id, 0)
            ON CONFLICT (user_id) DO NOTHING;
          SELECT COALESCE(tokens,0) INTO v_current_balance FROM ai_profiles_consolidated
           WHERE user_id = p_user_id FOR UPDATE;
        END IF;
        IF v_current_balance >= p_amount THEN v_actual_amount := p_amount;
        ELSE v_actual_amount := v_current_balance; END IF;
        IF v_current_balance <= 0 THEN
          RETURN json_build_object('success', false, 'tokens_used', 0);
        END IF;
        v_new_balance := v_current_balance - v_actual_amount;
        UPDATE ai_profiles_consolidated SET tokens = v_new_balance WHERE user_id = p_user_id;
        INSERT INTO token_transactions (id, user_id, transaction_type, amount, balance_after, description, metadata)
        VALUES (gen_random_uuid(), p_user_id, 'consumed', -v_actual_amount, v_new_balance, p_description, p_metadata);
        RETURN json_build_object('success', true, 'tokens_used', v_actual_amount, 'new_balance', v_new_balance);
      END; $$`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION add_user_tokens(p_user_id text, p_amount bigint,
        p_transaction_type transaction_type_enum, p_description text DEFAULT NULL,
        p_metadata jsonb DEFAULT NULL) RETURNS json
      LANGUAGE plpgsql AS $$
      DECLARE v_previous_balance BIGINT; v_new_balance BIGINT;
      BEGIN
        SELECT COALESCE(tokens,0) INTO v_previous_balance FROM ai_profiles_consolidated
         WHERE user_id = p_user_id;
        IF v_previous_balance IS NULL THEN v_previous_balance := 0; v_new_balance := GREATEST(0,p_amount);
        ELSE v_new_balance := GREATEST(0, v_previous_balance + p_amount); END IF;
        UPDATE ai_profiles_consolidated SET tokens = v_new_balance WHERE user_id = p_user_id;
        INSERT INTO token_transactions (id, user_id, transaction_type, amount, balance_after, description, metadata)
        VALUES (gen_random_uuid(), p_user_id, p_transaction_type, p_amount, v_new_balance, p_description, p_metadata);
        RETURN json_build_object('success', true, 'new_balance', v_new_balance);
      END; $$`);
  });

  afterAll(async () => {
    await pool?.query(
      'TRUNCATE products, product_provision_jobs, product_turns, ai_profiles_consolidated, token_transactions RESTART IDENTITY CASCADE',
    );
    await pool?.end();
  });

  beforeEach(() =>
    pool.query(
      'TRUNCATE products, product_provision_jobs, product_turns, ai_profiles_consolidated, token_transactions RESTART IDENTITY CASCADE',
    ),
  );

  let seq = 0;
  const rent = () => new RentService(pg as any);

  async function due(o: { slug?: string; status?: string; overdue?: string; userId?: string } = {}) {
    const slug = o.slug ?? `rv-${seq++}`;
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, created_at, paid_until)
       VALUES ($1, $2, $2, 'site', $3, '/p', md5(random()::text)||md5(random()::text), now(),
               date_trunc('milliseconds', now() - $4::interval))
       RETURNING id`,
      [o.userId ?? 'u-1', slug, o.status ?? 'running', o.overdue ?? '1 day'],
    );
    return { id: r.rows[0].id as string, slug };
  }

  const setBalance = (userId: string, tokens: number) =>
    pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET tokens = EXCLUDED.tokens`,
      [userId, tokens],
    );

  const balanceOf = async (u: string) =>
    Number(
      (await pool.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [u]))
        .rows[0]?.tokens ?? -1,
    );

  const ledgerOf = async (u: string) =>
    (await pool.query('SELECT * FROM token_transactions WHERE user_id = $1 ORDER BY created_at', [u]))
      .rows;

  const paidUntilOf = async (id: string) =>
    new Date(
      (await pool.query('SELECT paid_until FROM products WHERE id = $1', [id])).rows[0].paid_until,
    ).getTime();

  async function waitForLockWaiters(n: number) {
    const until = Date.now() + 20_000;
    for (;;) {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= n) return;
      if (Date.now() > until) throw new Error(`на замок встали ${r.rows[0].n} из ${n}`);
      await new Promise((res) => setTimeout(res, 40));
    }
  }

  // ─────────────────────────── одновременность ───────────────────────────

  it('R1. ПЯТЬ сборщиков, все гарантированно на замке — списание одно', async () => {
    // Два сборщика в батарее исполнителя. Прод сегодня в двух процессах, но
    // рестарт по одному, пересборка и ручной `pm2 start` дают три и больше.
    const p = await due({ slug: 'rv-five' });
    await setBalance('u-1', 500_000);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id='u-1' FOR UPDATE`);
      const all = Promise.all([0, 1, 2, 3, 4].map(() => rent().chargeRent(p.id)));
      await waitForLockWaiters(5);
      await holder.query('COMMIT');
      const outcomes = await all;

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await balanceOf('u-1')).toBe(450_000);
      expect(await ledgerOf('u-1')).toHaveLength(1);
      const months = ((await paidUntilOf(p.id)) - Date.now()) / 86_400_000;
      expect(months).toBeLessThan(32); // не уехал на пять месяцев вперёд
    } finally {
      holder.release();
    }
  });

  it('R2. ТРИ продукта одного владельца, денег ровно на два — платят двое, баланс не в минусе', async () => {
    const a = await due({ slug: 'rv-3a' });
    const b = await due({ slug: 'rv-3b' });
    const c = await due({ slug: 'rv-3c' });
    await setBalance('u-1', 100_000);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id='u-1' FOR UPDATE`);
      const all = Promise.all([a, b, c].map((p) => rent().chargeRent(p.id)));
      await waitForLockWaiters(3);
      await holder.query('COMMIT');
      const outcomes = await all;

      expect(outcomes.filter(Boolean)).toHaveLength(2);
      expect(await balanceOf('u-1')).toBe(0);
      expect(await ledgerOf('u-1')).toHaveLength(2);
      const paid = await pool.query(
        'SELECT count(*)::int AS n FROM products WHERE id = ANY($1) AND paid_until > now()',
        [[a.id, b.id, c.id]],
      );
      expect(paid.rows[0].n).toBe(2);
    } finally {
      holder.release();
    }
  });

  it('R3. аренда против НАСТОЯЩЕЙ consume_user_tokens (правка продукта) — без частичного расхода', async () => {
    // Списание за ход идёт через процедуру прода, а не через выдуманный UPDATE.
    const p = await due({ slug: 'rv-vs-turn' });
    await setBalance('u-1', 60_000);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT consume_user_tokens('u-1', 20000, 'product turn')`);
      const charge = rent().chargeRent(p.id);
      await waitForLockWaiters(1);
      await holder.query('COMMIT');
      const charged = await charge;

      expect(charged).toBe(false);
      expect(await balanceOf('u-1')).toBe(40_000);
      expect(await paidUntilOf(p.id)).toBeLessThan(Date.now());
      // В учёте ровно одна строка — за ход. Аренды там быть не должно.
      const led = await ledgerOf('u-1');
      expect(led).toHaveLength(1);
      expect(led[0].description).toBe('product turn');
    } finally {
      holder.release();
    }
  });

  // `it.failing`, а не `it`: тест ОБЯЗАН падать на сегодняшнем коде — это
  // зафиксированный дефект, а не сторож. Как обычный `it` он краснеет (снято
  // прогоном 16.09.2026: ожидалось 80 000, получено 130 000). Когда
  // add_user_tokens научится брать строку под замком, эта пара позеленеет и
  // `it.failing` упадёт — тогда её надо переписать в обычный `it`.
  it.failing('R4. ПОПОЛНЕНИЕ ровно в момент списания: деньги за аренду воскресают', async () => {
    // add_user_tokens — тот путь, которым приходит оплата YooKassa, купон,
    // реферальный бонус, возврат поддержки и правка админа. Он читает баланс
    // БЕЗ замка и пишет посчитанное значение ЦЕЛИКОМ. `FOR UPDATE` аренды от
    // такого писателя не защищает: замок держат только те, кто его берёт.
    //
    // Последовательность — ровно тело add_user_tokens, разложенное по шагам.
    const p = await due({ slug: 'rv-topup' });
    await setBalance('u-1', 100_000);

    const topper = await pool.connect();
    try {
      await topper.query('BEGIN');
      // шаг 1 процедуры: SELECT COALESCE(tokens,0) INTO v_previous_balance
      const prev = Number(
        (
          await topper.query(
            `SELECT COALESCE(tokens,0) AS t FROM ai_profiles_consolidated WHERE user_id='u-1'`,
          )
        ).rows[0].t,
      );
      // Аренда проходит целиком между чтением и записью пополнения.
      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(50_000);
      // шаг 2 процедуры: UPDATE ... SET tokens = v_new_balance
      await topper.query(`UPDATE ai_profiles_consolidated SET tokens = $1 WHERE user_id='u-1'`, [
        prev + 30_000,
      ]);
      await topper.query('COMMIT');
    } finally {
      topper.release();
    }

    // Ожидание: 50 000 (после аренды) + 30 000 = 80 000.
    expect(await balanceOf('u-1')).toBe(80_000);
  });

  it.failing('R4-контроль. ту же дыру даёт существующий путь: consume_user_tokens против пополнения', async () => {
    // Доказательство, что R4 — НЕ новый дефект аренды, а старая дыра
    // add_user_tokens. Тот же танец с процедурой списания за ход: она берёт
    // FOR UPDATE, и это её не спасает.
    await setBalance('u-1', 100_000);

    const topper = await pool.connect();
    try {
      await topper.query('BEGIN');
      const prev = Number(
        (
          await topper.query(
            `SELECT COALESCE(tokens,0) AS t FROM ai_profiles_consolidated WHERE user_id='u-1'`,
          )
        ).rows[0].t,
      );
      await pool.query(`SELECT consume_user_tokens('u-1', 50000, 'product turn')`);
      expect(await balanceOf('u-1')).toBe(50_000);
      await topper.query(`UPDATE ai_profiles_consolidated SET tokens = $1 WHERE user_id='u-1'`, [
        prev + 30_000,
      ]);
      await topper.query('COMMIT');
    } finally {
      topper.release();
    }

    expect(await balanceOf('u-1')).toBe(80_000);
  });

  it('R17. под давлением остаток в учёте не врёт: 100k → 50k → 0', async () => {
    // balance_after берётся из RETURNING того же UPDATE. Под EvalPlanQual
    // значение могло бы приехать из СНИМКА, а не из записанной строки, и
    // история показала бы два раза «осталось 50 000».
    const a = await due({ slug: 'rv-chain-a' });
    const b = await due({ slug: 'rv-chain-b' });
    await setBalance('u-1', 100_000);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id='u-1' FOR UPDATE`);
      const all = Promise.all([a, b].map((p) => rent().chargeRent(p.id)));
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      expect((await all).filter(Boolean)).toHaveLength(2);
    } finally {
      holder.release();
    }

    const led = await ledgerOf('u-1');
    expect(led.map((r: any) => Number(r.amount))).toEqual([-50_000, -50_000]);
    expect(led.map((r: any) => Number(r.balance_after)).sort((x, y) => y - x)).toEqual([50_000, 0]);
    expect(await balanceOf('u-1')).toBe(0);
  });

  it('R5. АРХИВАЦИЯ ровно в момент списания: с архивного не берут', async () => {
    const p = await due({ slug: 'rv-archive' });
    await setBalance('u-1', 120_000);

    const arch = await pool.connect();
    try {
      await arch.query('BEGIN');
      await arch.query(
        `UPDATE products SET archived_at = now(), status='archived' WHERE id=$1`,
        [p.id],
      );
      const charge = rent().chargeRent(p.id);
      await waitForLockWaiters(1);
      await arch.query('COMMIT');

      expect(await charge).toBe(false);
      expect(await balanceOf('u-1')).toBe(120_000);
      expect(await ledgerOf('u-1')).toEqual([]);
    } finally {
      arch.release();
    }
  });

  it('R6. ОТКАТ ПОСРЕДИ: падение записи в учёт не оставляет ни списания, ни месяца', async () => {
    // Оператор один, но частей в нём четыре. Если последняя падает (типа в
    // enum не стало, колонка ужалась, сработал триггер) — обязано откатиться
    // всё, иначе деньги сняты без следа в истории или месяц выдан бесплатно.
    const p = await due({ slug: 'rv-rollback' });
    await setBalance('u-1', 120_000);
    await pool.query(
      `ALTER TABLE token_transactions ADD CONSTRAINT rv_boom CHECK (description NOT LIKE '%rv-rollback%')`,
    );
    try {
      await expect(rent().chargeRent(p.id)).rejects.toThrow();

      expect(await balanceOf('u-1')).toBe(120_000);
      expect(await paidUntilOf(p.id)).toBeLessThan(Date.now());
      expect(await ledgerOf('u-1')).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE token_transactions DROP CONSTRAINT rv_boom');
    }
  });

  // ─────────────────────────── суммы и периоды ───────────────────────────

  it('R7. просрочка ПОЛТОРА МЕСЯЦА: месяц вперёд один раз, а не долг', async () => {
    // Дыра между сценариями 31 (три месяца) и 32 (два дня). Граница CASE стоит
    // ровно на месяце, и промежуток «больше месяца, но меньше двух» не
    // проверен ничем: срок остался бы в прошлом, а следующий оборот сборщика
    // списал бы второй раз за тот же календарный месяц.
    const p = await due({ slug: 'rv-45d', overdue: '45 days' });
    await setBalance('u-1', 200_000);

    expect(await rent().chargeRent(p.id)).toBe(true);
    expect(await balanceOf('u-1')).toBe(150_000);
    // Срок обязан уехать в БУДУЩЕЕ — иначе долг копится.
    expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
    // И второй оборот подряд ничего не находит.
    expect(await rent().chargeRent(p.id)).toBe(false);
    expect(await balanceOf('u-1')).toBe(150_000);
  });

  it('R8. просрочка РОВНО месяц: тоже уезжает в будущее', async () => {
    const p = await due({ slug: 'rv-30d', overdue: '1 month' });
    await setBalance('u-1', 200_000);

    expect(await rent().chargeRent(p.id)).toBe(true);
    expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
    expect(await rent().chargeRent(p.id)).toBe(false);
    expect(await balanceOf('u-1')).toBe(150_000);
  });

  it('R18. срок ещё не истёк на ТРИ дня — не списывается', async () => {
    // В сданной батарее ближняя граница «рано платить» стоит на десяти днях
    // (сценарий 24), а сборщик ходит раз в сутки. Между «завтра» и «через
    // десять дней» не сторожит ничего: льготный аванс в неделю прошёл бы мимо
    // всей батареи, а он означает списание за период, который ещё оплачен.
    const p = await due({ slug: 'rv-3d', overdue: '-3 days' });
    await setBalance('u-1', 500_000);

    expect(await rent().chargeRent(p.id)).toBe(false);
    expect(await balanceOf('u-1')).toBe(500_000);
  });

  it('R9. отрицательный баланс не углубляется', async () => {
    // На 2026-08-08 один пользователь был на −7 363 (прямые UPDATE в чате).
    const p = await due({ slug: 'rv-negative' });
    await setBalance('u-1', -7_363);

    expect(await rent().chargeRent(p.id)).toBe(false);
    expect(await balanceOf('u-1')).toBe(-7_363);
    expect(await paidUntilOf(p.id)).toBeLessThan(Date.now());
  });

  it('R10. статусы, которые НЕ платят: provisioning, stopped, failed, archived', async () => {
    for (const st of ['provisioning', 'stopped', 'failed', 'archived']) {
      await pool.query('TRUNCATE products, ai_profiles_consolidated, token_transactions CASCADE');
      const p = await due({ slug: `rv-st-${st}`, status: st });
      await setBalance('u-1', 500_000);
      expect([st, await rent().chargeRent(p.id)]).toEqual([st, false]);
      expect([st, await balanceOf('u-1')]).toEqual([st, 500_000]);
    }
  });

  it('R11. архивный продукт со статусом running не платит', async () => {
    // archived_at заполняется, статус меняется отдельно — в products.service
    // архивация идёт `SET archived_at = now()`, и в проде уже встречались
    // строки с archived_at и старым статусом.
    const p = await due({ slug: 'rv-arch-running' });
    await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [p.id]);
    await setBalance('u-1', 500_000);

    expect(await rent().chargeRent(p.id)).toBe(false);
    expect(await balanceOf('u-1')).toBe(500_000);
  });

  it('R12. несуществующий продукт — false и ни одной строки в учёте', async () => {
    await setBalance('u-1', 500_000);
    expect(await rent().chargeRent('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await balanceOf('u-1')).toBe(500_000);
    expect(await ledgerOf('u-1')).toEqual([]);
  });

  it('R13. СТО оборотов подряд списывают ровно один месяц', async () => {
    // Сборщик ходит по всем продуктам; идемпотентность внутри одного оборота
    // и между оборотами — разные свойства.
    const p = await due({ slug: 'rv-idem' });
    await setBalance('u-1', 5_000_000);

    let trues = 0;
    for (let i = 0; i < 100; i++) if (await rent().chargeRent(p.id)) trues++;

    expect(trues).toBe(1);
    expect(await balanceOf('u-1')).toBe(5_000_000 - RENT_TOKENS);
    expect(await ledgerOf('u-1')).toHaveLength(1);
  });

  it('R14. форма записи в учёт совпадает с consume_user_tokens', async () => {
    // Разъехавшийся тип или знак ломает отчёты молча. Сверяем не с догадкой, а
    // с тем, что пишет существующий путь на тех же данных.
    const p = await due({ slug: 'rv-shape' });
    await setBalance('u-1', 200_000);
    await pool.query(`SELECT consume_user_tokens('u-2', 50000, 'эталон')`);
    await setBalance('u-2', 200_000);
    await pool.query(`SELECT consume_user_tokens('u-2', 50000, 'эталон')`);

    expect(await rent().chargeRent(p.id)).toBe(true);

    const [mine] = await ledgerOf('u-1');
    const ref = (await ledgerOf('u-2')).pop();
    expect(mine.transaction_type).toBe(ref.transaction_type);
    expect(typeof mine.amount).toBe(typeof ref.amount);
    expect(Number(mine.amount)).toBe(Number(ref.amount));
    expect(Number(mine.balance_after)).toBe(await balanceOf('u-1'));
    expect(Number(ref.balance_after)).toBe(await balanceOf('u-2'));
  });

  // ─────────────────────────── замок и порядок ───────────────────────────

  it('R15. замок берётся на строку ИМЕННО того владельца, а не на первую попавшуюся', async () => {
    // Держим строку ЧУЖОГО владельца. Списание обязано пройти, не заметив.
    const p = await due({ slug: 'rv-lock-owner' });
    await setBalance('u-1', 120_000);
    await setBalance('u-9', 120_000);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id='u-9' FOR UPDATE`);
      const started = Date.now();
      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await balanceOf('u-1')).toBe(70_000);
    expect(await balanceOf('u-9')).toBe(120_000);
  });

  it('R16. ВЗАИМНАЯ БЛОКИРОВКА: обратный порядок замков даёт deadlock', async () => {
    // Списание берёт баланс, потом продукт. Любая чужая транзакция, берущая
    // продукт, а потом баланс, образует цикл. Проверяем, что это ПРАВДА
    // возможно на уровне СУБД — то есть что заявленный порядок обязателен, а
    // не «и так сойдёт».
    const p = await due({ slug: 'rv-deadlock' });
    await setBalance('u-1', 120_000);

    const other = await pool.connect();
    let deadlocked = false;
    try {
      await other.query('BEGIN');
      // Обратный порядок: сначала продукт.
      await other.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [p.id]);
      const charge = rent().chargeRent(p.id).catch((e: any) => {
        if (String(e.message).includes('deadlock')) deadlocked = true;
        return 'err';
      });
      await waitForLockWaiters(1).catch(() => undefined);
      // ...теперь баланс. Цикл замкнулся.
      await other
        .query(`SELECT 1 FROM ai_profiles_consolidated WHERE user_id='u-1' FOR UPDATE`)
        .catch((e: any) => {
          if (String(e.message).includes('deadlock')) deadlocked = true;
        });
      await other.query('COMMIT').catch(() => other.query('ROLLBACK').catch(() => undefined));
      await charge;
    } finally {
      other.release();
    }
    // Документируем факт: цикл разрешим только детектором deadlock в Postgres.
    expect(deadlocked).toBe(true);
  });
});
