import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { TokensSchemaService } from './tokens-schema.service';

/**
 * ПОТЕРЯ ЗАЧИСЛЕНИЯ В add_user_tokens — против живого Postgres.
 *
 * Дефект: процедура читала баланс без замка и записывала посчитанное значение
 * целиком. Пополнение, начавшееся до списания и закончившееся после, возвращает
 * человеку деньги за уже оказанную услугу:
 *
 *     было 100 000 → списание забрало 50 000 → пополнение на 30 000
 *     записало 130 000 вместо 80 000
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ИСПОЛНЯЕТ SQL, А НЕ СТОРОЖИТ ЕГО ТЕКСТ. Сторож на тексте
 * есть рядом (tokens-schema.spec.ts) и он полезен, но подтвердить починку не
 * может ни в каком виде: `FOR UPDATE` в теле процедуры — подстрока, а не
 * поведение. Точно так же выглядел бы `FOR UPDATE` в закомментированной
 * строке, в другой ветке IF, во ВТОРОМ чтении после первого незапертого или в
 * запросе к соседней таблице. Ни одну из этих четырёх подделок текстовый
 * сторож не отличает от починки, и каждая оставляет прод ровно таким, каким он
 * был.
 *
 * ПОЧЕМУ ОЖИДАНИЕ НЕ НА ПАУЗЕ. Между чтением баланса и его записью в исходной
 * процедуре стоят два соседних оператора — окно измеряется микросекундами.
 * Тест вида «начать пополнение, поспать 50 мс, списать» зеленеет или краснеет
 * по воле планировщика и на загруженной ноде врёт в обе стороны. Здесь окно
 * открыто ЯВНО и держится столько, сколько нужно:
 *
 *   - на ai_profiles_consolidated повешен ЗАТВОР — триггер BEFORE UPDATE
 *     FOR EACH STATEMENT. Уровень STATEMENT выбран не для краткости: он
 *     срабатывает до того, как оператор коснётся хоть одной строки и возьмёт
 *     хоть один замок, то есть строго в зазоре «баланс уже прочитан, но ещё не
 *     записан». Построчный BEFORE UPDATE туда не годится — он приезжает, когда
 *     строка уже найдена сканом, и закрывал бы окно, которое должен открыть;
 *   - затвор срабатывает только в той сессии, где взведён GUC `race.gate`, —
 *     иначе он держал бы и списание, и весь остальной прогон;
 *   - держит его advisory-лок, взятый ТЕСТОМ. Не pg_sleep: сон это та же пауза,
 *     только переехавшая в базу. Лок снимается явно, когда вторая половина
 *     сценария измеримо доехала до нужного состояния.
 *
 * Состояние «доехала» читается из pg_stat_activity по pid бэкенда: ожидание
 * построено на наблюдаемом факте (бэкенд стоит на Lock), а не на истёкшем
 * времени. Таймауты в ожиданиях — только чтобы прогон не висел вечно; их
 * срабатывание это всегда ошибка прибора, и текст ошибки об этом говорит.
 *
 * КАК ГОНЯТЬ. База обязана быть ОДНОРАЗОВОЙ — beforeEach делает TRUNCATE и
 * адрес не разбирает (гард на непустую базу — в beforeAll):
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS tok_race"
 *   sudo -u postgres psql -qc "CREATE ROLE tokrace LOGIN PASSWORD 'tokrace'"
 *   sudo -u postgres psql -qc "CREATE DATABASE tok_race OWNER tokrace"
 *   TOKENS_PG_URL=postgresql://tokrace:tokrace@127.0.0.1:5432/tok_race npx jest src/tokens
 *
 * Роль с паролем, а не `OWNER dv`: на тестовой ноде peer-аутентификация есть
 * только у psql через сокет, node-pg ходит по TCP и без пароля получает
 * «client password must be a string».
 *
 * КАК УВИДЕТЬ КРАСНОЕ. Починка целиком лежит в одном файле, и раннер миграций
 * переживает его отсутствие (warn + skipping). Значит, «до починки» — это
 * прогон без него, на определении из base/001, то есть на том самом тексте,
 * что стоит сегодня на проде:
 *
 *   rm src/tokens/migrations/001_add_user_tokens_lock.sql && npx jest src/tokens
 *
 * Измерено на PostgreSQL 16, тестовая нода:
 *
 *   с починкой:  Test Suites: 6 passed, 6 total | Tests: 69 passed, 69 total
 *   без неё:     Test Suites: 2 failed, 4 passed, 6 total
 *                Tests:       9 failed, 60 passed, 69 total
 *
 * Из девяти красных шесть — соседний сторож текста (файла нет, читать нечего),
 * а по делу краснеют РОВНО ТРИ сценария гонки:
 *
 *   списание внутри пополнения  ждали 80 000,  получили 130 000
 *   баланс сходится с реестром  ждали 130 000, получили 80 000
 *   два пополнения складываются ждали 137 000, получили 130 000
 *
 * Остальные пятьдесят с лишним — те, что стерегут НЕИЗМЕННОСТЬ поведения
 * (форма ответа, обрезка нулём, отсутствующая строка профиля, реестр,
 * redeem_coupon), — зелёные в обоих прогонах. Это и есть их работа: они
 * обязаны молчать и до починки, и после, а заговорить только если починка
 * поменяла что-то ещё.
 */

// Без адреса базы файл пропускается целиком, чтобы обычный прогон не требовал
// Postgres. На тестовой ноде отрабатывает за секунды.
const PG = process.env.TOKENS_PG_URL;
const maybe = PG ? describe : describe.skip;

/** Ключ затвора. Произвольный, лишь бы не совпал с боевыми ключами PgService. */
const GATE_KEY = 918273645;

/**
 * Что сносится перед каждым сценарием. coupons и coupon_redemptions — в том же
 * списке: купон переживает сценарий, и повторный прогон получал бы
 * `coupon_already_used` вместо зачисления, оставаясь при этом зелёным ровно до
 * второго запуска в той же базе.
 */
const TRUNCATE_ALL =
  'TRUNCATE ai_profiles_consolidated, token_transactions, coupons, coupon_redemptions ' +
  'RESTART IDENTITY CASCADE';

maybe('add_user_tokens против живого Postgres', () => {
  jest.setTimeout(120_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 12 });

    // Схема накатывается ТЕМИ ЖЕ файлами, что и в проде: сначала снимок
    // base/001 (в нём сломанное определение add_user_tokens — ровно то, что
    // стоит на проде), следом — миграция модуля с починкой. Порядок повторяет
    // боевой: CREATE OR REPLACE поверх уже существующей процедуры.
    //
    // На ОТДЕЛЬНОМ соединении, которое потом уничтожается (release(true)), а не
    // через pool.query. Внутри снимка есть строка pg_dump
    // `SELECT pg_catalog.set_config('search_path', '', false)` — третий
    // аргумент false значит «на всю сессию, а не на транзакцию». Соединение,
    // накатившее схему, возвращается в пул с ПУСТЫМ search_path, и дальше
    // примерно каждый второй запрос падает с «relation
    // ai_profiles_consolidated does not exist» — в зависимости от того, какое
    // соединение выдал пул. Наступали: 21 упавший тест, все с этой ошибкой и
    // ни один по делу.
    const loader = await pool.connect();
    try {
      await loader.query(
        fs.readFileSync(
          path.join(__dirname, '..', 'base', 'migrations', '001_core_schema.sql'),
          'utf8',
        ),
      );
    } finally {
      loader.release(true);
    }

    // Схема действительно доехала. Без этой проверки пустой search_path (или
    // снимок, применившийся наполовину) выглядел бы как «таблицы нет», а
    // «таблицы нет» гард ниже читает как «база пустая, всё в порядке».
    const ok = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS t, current_setting('search_path') AS sp`,
    );
    if (!ok.rows[0].t) {
      throw new Error(
        `схема base/001 не накатилась: ai_profiles_consolidated нет (search_path=${ok.rows[0].sp})`,
      );
    }

    // ГАРД НА ЧУЖУЮ БАЗУ. beforeEach делает TRUNCATE и адрес не разбирает, а на
    // той же ноде живёт база стенда test.linkeon.io с этими же таблицами: один
    // TOKENS_PG_URL, скопированный не из той строки, сотрёт баланс и реестр
    // транзакций стенда без единого вопроса. Считается ДО первого TRUNCATE.
    for (const t of ['ai_profiles_consolidated', 'token_transactions']) {
      const n = await pool.query(`SELECT count(*) FROM ${t}`);
      if (Number(n.rows[0].count) > 0) {
        throw new Error(
          `TOKENS_PG_URL указывает на НЕпустую базу (${t} не пуста) — нужна одноразовая, ` +
            'иначе TRUNCATE в beforeEach сотрёт чужие балансы (рецепт — в шапке файла)',
        );
      }
    }

    // ЗАТВОР. Живёт только в тестовой базе: в миграциях модуля его нет и быть
    // не должно.
    await pool.query(`
      CREATE OR REPLACE FUNCTION race_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$
      BEGIN
        IF current_setting('race.gate', true) = 'on' THEN
          PERFORM pg_advisory_xact_lock(${GATE_KEY});
        END IF;
        RETURN NULL;
      END
      $gate$;
    `);
    await pool.query('DROP TRIGGER IF EXISTS race_gate_trg ON ai_profiles_consolidated');
    await pool.query(`
      CREATE TRIGGER race_gate_trg BEFORE UPDATE ON ai_profiles_consolidated
      FOR EACH STATEMENT EXECUTE FUNCTION race_gate()
    `);

    // Починка накатывается ТЕМ ЖЕ сервисом, что и на проде, — не копией SQL в
    // тесте. Копия разошлась бы с миграцией молча, и файл проверял бы
    // процедуру, которой на сервере нет.
    await new TokensSchemaService({
      query: (sql: string, params?: any[]) => pool.query(sql, params),
    } as any).onModuleInit();
  });

  afterAll(async () => {
    // ЗА СОБОЙ УБИРАЕМ: beforeAll требует пустые таблицы, иначе ВТОРОЙ прогон в
    // той же одноразовой базе падает целиком на гарде — и выглядит это как
    // идеальная ловля мутации, хотя врёт прибор.
    await pool?.query(TRUNCATE_ALL);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_ALL);
  });

  // ——— приборы ———

  let seq = 0;
  const newUser = () => `race-user-${++seq}`;

  async function seedUser(tokens: number): Promise<string> {
    const userId = newUser();
    await pool.query('INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)', [
      userId,
      tokens,
    ]);
    return userId;
  }

  const balanceOf = async (userId: string): Promise<number | null> => {
    const r = await pool.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [
      userId,
    ]);
    return r.rowCount === 0 ? null : Number(r.rows[0].tokens);
  };

  /** Сумма движений по реестру. Ответ на «а сходится ли баланс с историей». */
  const ledgerSum = async (userId: string): Promise<number> => {
    const r = await pool.query(
      'SELECT COALESCE(sum(amount), 0) AS s FROM token_transactions WHERE user_id = $1',
      [userId],
    );
    return Number(r.rows[0].s);
  };

  /** node-pg отдаёт json объектом, но на старом драйвере — строкой. */
  const parse = (raw: any) => (typeof raw === 'string' ? JSON.parse(raw) : raw);

  const credit = (
    c: PoolClient | Pool,
    userId: string,
    amount: number,
    type = 'purchase',
    description = 'тест',
  ) =>
    c
      .query(`SELECT add_user_tokens($1, $2, '${type}', $3, NULL) AS res`, [
        userId,
        amount,
        description,
      ])
      .then((r) => parse(r.rows[0].res));

  const consume = (c: PoolClient | Pool, userId: string, amount: number) =>
    c
      .query('SELECT consume_user_tokens($1, $2, $3, NULL) AS res', [userId, amount, 'тест'])
      .then((r) => parse(r.rows[0].res));

  /**
   * Ждать ВЫПОЛНЕНИЯ УСЛОВИЯ, а не времени. Опрос раз в 20 мс; дедлайн нужен
   * исключительно чтобы прогон не висел вечно, и его срабатывание — поломка
   * прибора, о чём и сообщает текст.
   */
  async function until(what: string, cond: () => Promise<boolean>, ms = 15_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) {
        throw new Error(`прибор сломан: не дождались «${what}» за ${ms} мс`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const pidOf = async (c: PoolClient) =>
    Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

  /** Бэкенд стоит на замке — наблюдаемый факт, не догадка по часам. */
  async function blockedOn(pid: number, waitEvent?: string): Promise<boolean> {
    const r = await pool.query(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (r.rowCount === 0) return false;
    const { wait_event_type, wait_event } = r.rows[0];
    if (wait_event_type !== 'Lock') return false;
    return waitEvent ? wait_event === waitEvent : true;
  }

  /**
   * Сценарий «пополнение обняло вторую операцию».
   *
   * Пополнение читает баланс, застревает в затворе ПЕРЕД записью, вторая
   * операция проходит целиком, затвор открывается, пополнение дописывает своё.
   * Возвращает ответы обеих процедур.
   */
  async function creditStraddling(
    userId: string,
    creditAmount: number,
    second: (c: PoolClient) => Promise<any>,
  ): Promise<{ credit: any; second: any }> {
    const gate = await pool.connect();
    const creditC = await pool.connect();
    const secondC = await pool.connect();
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);

      const creditPid = await pidOf(creditC);
      const secondPid = await pidOf(secondC);

      await creditC.query('BEGIN');
      await creditC.query(`SET LOCAL race.gate = 'on'`);
      const creditP = credit(creditC, userId, creditAmount);

      // Пополнение уже прочитало баланс и стоит на затворе. Это не «прошло
      // столько-то миллисекунд», это состояние бэкенда в pg_stat_activity.
      await until(
        'пополнение встало в затвор перед записью баланса',
        () => blockedOn(creditPid, 'advisory'),
      );

      // Вторая операция — целиком в открытом окне. Не дожидаемся: на
      // ПОЧИНЕННОЙ процедуре она честно упирается в замок строки и доедет
      // только после COMMIT пополнения. На сломанной — пролетает насквозь.
      let secondDone = false;
      const secondP = second(secondC).then((r) => {
        secondDone = true;
        return r;
      });

      await until(
        'вторая операция либо прошла, либо упёрлась в замок строки',
        async () => secondDone || (await blockedOn(secondPid)),
      );

      await gate.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);

      const creditRes = await creditP;
      await creditC.query('COMMIT');
      const secondRes = await secondP;
      return { credit: creditRes, second: secondRes };
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      gate.release();
      await creditC.query('ROLLBACK').catch(() => undefined);
      creditC.release();
      secondC.release();
    }
  }

  // ——— 1. Гонка: пополнение против списания ———

  it('списание, прошедшее внутри пополнения, не отменяется зачислением', async () => {
    const userId = await seedUser(100_000);

    await creditStraddling(userId, 30_000, (c) => consume(c, userId, 50_000));

    // 100 000 − 50 000 + 30 000. До починки здесь 130 000: списание стёрто.
    expect(await balanceOf(userId)).toBe(80_000);
  });

  it('баланс сходится с реестром после такой гонки', async () => {
    const userId = await seedUser(100_000);

    await creditStraddling(userId, 30_000, (c) => consume(c, userId, 50_000));

    // Отдельная проверка от предыдущей: там измеряется баланс, здесь — что
    // «История пополнений» и баланс рассказывают одно и то же. Сломать это
    // можно порознь.
    expect(100_000 + (await ledgerSum(userId))).toBe(await balanceOf(userId));
  });

  // ——— 2. Гонка: два пополнения ———

  it('два одновременных пополнения складываются, ни одно не теряется', async () => {
    const userId = await seedUser(100_000);

    await creditStraddling(userId, 30_000, (c) => credit(c, userId, 7_000, 'bonus'));

    // До починки — 130 000: второе пополнение прочитано и стёрто.
    expect(await balanceOf(userId)).toBe(137_000);
  });

  // ——— 3. Обратная сторона: обычное пополнение не сломано ———

  it('обычное пополнение прибавляет к балансу', async () => {
    const userId = await seedUser(1_000);

    const res = await credit(pool, userId, 25_000, 'bonus', 'Приветственный бонус');

    expect(res.new_balance).toBe(26_000);
    expect(await balanceOf(userId)).toBe(26_000);
  });

  it('форма ответа не изменилась — те же пять ключей и те же значения', async () => {
    const userId = await seedUser(1_000);

    const res = await credit(pool, userId, 25_000);

    expect(Object.keys(res).sort()).toEqual(
      ['new_balance', 'previous_balance', 'success', 'tokens_added', 'transaction_id'].sort(),
    );
    expect(res.success).toBe(true);
    expect(res.previous_balance).toBe(1_000);
    expect(res.new_balance).toBe(26_000);
    expect(res.tokens_added).toBe(25_000);
    expect(res.transaction_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('пишет строку в token_transactions — тип, сумма, баланс после, описание', async () => {
    const userId = await seedUser(1_000);

    const res = await credit(pool, userId, 25_000, 'coupon', 'Купон WELCOME');

    const r = await pool.query('SELECT * FROM token_transactions WHERE user_id = $1', [userId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].id).toBe(res.transaction_id);
    expect(r.rows[0].transaction_type).toBe('coupon');
    expect(Number(r.rows[0].amount)).toBe(25_000);
    expect(Number(r.rows[0].balance_after)).toBe(26_000);
    expect(r.rows[0].description).toBe('Купон WELCOME');
  });

  it('чужой баланс не трогает', async () => {
    // Посторонний нужен физически, а не для полноты: без него `WHERE user_id =
    // p_user_id OR TRUE` в UPDATE переживает ВЕСЬ этот файл зелёным — каждый
    // сценарий работает ровно с одним пользователем, и «обновили всех» от
    // «обновили нужного» не отличается ничем. На проде та же правка одним
    // пополнением переписала бы баланс всей базы.
    const target = await seedUser(1_000);
    const bystander = await seedUser(555);

    await credit(pool, target, 25_000);

    expect(await balanceOf(bystander)).toBe(555);
  });

  it('метаданные доезжают до реестра', async () => {
    const userId = await seedUser(0);

    await pool.query(
      `SELECT add_user_tokens($1, $2, 'purchase', $3, $4::jsonb)`,
      [userId, 50_000, 'ЮKassa', JSON.stringify({ payment_id: 'pay-1' })],
    );

    const r = await pool.query('SELECT metadata FROM token_transactions WHERE user_id = $1', [
      userId,
    ]);
    expect(r.rows[0].metadata).toEqual({ payment_id: 'pay-1' });
  });

  // ——— 4. Обратная сторона: строки пользователя ещё нет ———

  it('строки пользователя нет — отвечает успехом от нуля и профиль не заводит', async () => {
    const userId = newUser();

    const res = await credit(pool, userId, 25_000);

    // Поведение прежнее, дословно: UPDATE не находит строку, профиль не
    // появляется, ответ считается от нуля. Чинить это здесь нельзя — см.
    // «чего сознательно не чиним» в шапке миграции. Тест закрепляет то, что
    // есть, чтобы починка гонки не поменяла заодно и это.
    expect(res.success).toBe(true);
    expect(res.previous_balance).toBe(0);
    expect(res.new_balance).toBe(25_000);
    expect(await balanceOf(userId)).toBeNull();
  });

  it('строки пользователя нет — строка в реестре всё равно пишется', async () => {
    const userId = newUser();

    await credit(pool, userId, 25_000);

    const r = await pool.query('SELECT count(*) AS n FROM token_transactions WHERE user_id = $1', [
      userId,
    ]);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  // ——— 5. Обратная сторона: баланс не уходит в минус ———

  it('отрицательная правка больше баланса обрезается нулём, а не уводит в минус', async () => {
    const userId = await seedUser(10_000);

    // Именно так ходит админская правка баланса (auth.service.ts): сумма может
    // быть отрицательной, и уйти ниже нуля она не должна.
    const res = await credit(pool, userId, -25_000, 'adjustment', 'Правка админом');

    expect(res.new_balance).toBe(0);
    expect(res.previous_balance).toBe(10_000);
    expect(await balanceOf(userId)).toBe(0);
  });

  it('отрицательная правка меньше баланса просто вычитается', async () => {
    const userId = await seedUser(10_000);

    const res = await credit(pool, userId, -4_000, 'adjustment');

    expect(res.new_balance).toBe(6_000);
    expect(await balanceOf(userId)).toBe(6_000);
  });

  it('списание по-прежнему не уводит баланс в минус', async () => {
    const userId = await seedUser(1_000);

    const res = await consume(pool, userId, 5_000);

    expect(res.success).toBe(true);
    expect(await balanceOf(userId)).toBe(0);
  });

  // ——— 6. Обратная сторона: соседние процедуры ———

  it('redeem_coupon, зовущая add_user_tokens изнутри базы, по-прежнему работает', async () => {
    // Купон — единственный путь пополнения, который ходит в add_user_tokens не
    // из TypeScript, а из соседней SQL-процедуры. Ошибка в сигнатуре при
    // CREATE OR REPLACE (новая перегрузка вместо замены) видна только отсюда:
    // вызовы из TS уехали бы на починенную, а redeem_coupon — на старую.
    const userId = await seedUser(1_000);
    await pool.query(
      `INSERT INTO coupons (code, token_amount, is_active) VALUES ('RACE50', 50000, true)`,
    );

    const res = parse((await pool.query(`SELECT redeem_coupon($1, 'RACE50') AS res`, [userId])).rows[0].res);

    expect(res.success).toBe(true);
    expect(await balanceOf(userId)).toBe(51_000);
  });

  it('перегрузок add_user_tokens ровно одна', async () => {
    const r = await pool.query(
      `SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'add_user_tokens'`,
    );
    expect(Number(r.rows[0].n)).toBe(1);
  });

  // ——— 7. Прибор ———

  it('затвор действительно держит — без него измерять нечего', async () => {
    // Если триггер отвалится (переименуют таблицу, забудут CREATE TRIGGER),
    // все сценарии гонки выше станут зелёными МГНОВЕННО и молча: пополнение
    // пролетит насквозь, вторая операция уедет следом, сумма сойдётся. Здесь
    // проверяется сам прибор.
    const userId = await seedUser(100_000);
    const gate = await pool.connect();
    const c = await pool.connect();
    try {
      await gate.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);
      const pid = await pidOf(c);
      await c.query('BEGIN');
      await c.query(`SET LOCAL race.gate = 'on'`);
      const p = credit(c, userId, 1);

      await until('затвор поймал пополнение', () => blockedOn(pid, 'advisory'));
      // Баланс ещё НЕ записан: пополнение стоит перед своим UPDATE.
      expect(await balanceOf(userId)).toBe(100_000);

      await gate.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);
      await p;
      await c.query('COMMIT');
      expect(await balanceOf(userId)).toBe(100_001);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      gate.release();
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
