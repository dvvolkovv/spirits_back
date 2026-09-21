import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { ReferralService } from './referral.service';

/**
 * РЕФЕРАЛЬНЫЕ НАЧИСЛЕНИЯ ДОЕЗЖАЮТ ДО РЕЕСТРА — против живого Postgres.
 *
 * Дефект: оба начисления программы писали баланс прямым
 * `UPDATE ... SET tokens = COALESCE(tokens,0) + $1`, мимо add_user_tokens и
 * мимо token_transactions. Токены появлялись у человека ниоткуда: «История
 * пополнений» пуста, админские отчёты недосчитывают, прогноз расхода считает
 * медиану по неполным данным. На проде так разошлись 320 000 токенов.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ИСПОЛНЯЕТ SQL, А НЕ МОКАЕТ ЕГО. Мок доказал бы форму
 * вызова — что в коде написано «add_user_tokens» — и ровно это же показал бы
 * при четырёх разных поломках: процедуры с таким именем нет в базе; она есть,
 * но с другой сигнатурой (перегрузка вместо замены); она отработала, а
 * транзакция вокруг откатилась; она отработала на НЕСУЩЕСТВУЮЩЕМ профиле, где
 * баланс не меняет, а строку в реестр пишет. Последнее — не выдумка: это
 * штатная ветка add_user_tokens, и именно на ней наивная замена прямого UPDATE
 * на процедуру превращает громкий отказ в молчаливую потерю комиссии. Отличить
 * эти случаи от починки может только настоящая база.
 *
 * ═══ ВТОРАЯ ПОЛОВИНА СТОРОЖА: СПРАШИВАЕМ У БАЗЫ, КТО ПИШЕТ В КОЛОНКУ ═══
 *
 * Текстовый сторож (tokens/balance-writes.guard.spec.ts) ищет обходы в
 * исходниках. Он необходим — ловит обход, который никто не покрыл тестом, — но
 * видит только то, что написано текстом: SQL из кусков, вызов из psql, триггер
 * соседней таблицы ему не видны. И ровно в этом он уже подвёл: прошлая
 * редакция искала одно написание правой части и пропустила пять обходов.
 *
 * Здесь вопрос задан БАЗЕ. На ai_profiles_consolidated повешен триггер
 * AFTER UPDATE FOR EACH ROW, записывающий КАЖДОЕ изменение колонки tokens —
 * кем бы и как бы оно ни было сделано. Написание запроса он не разбирает, и
 * обмануть его переносом приращения в COALESCE/GREATEST/алиас/переменную
 * нельзя в принципе.
 *
 * Сверка вынесена в afterEach, а не разложена по сценариям НАМЕРЕННО: так её
 * наследует каждый будущий сценарий этого файла, включая тот, который напишут
 * не вспомнив про реестр. Сценарий, которому расхождение положено по условию,
 * обязан объявить это явно — `expectImbalance()`.
 *
 * КАК ГОНЯТЬ. База обязана быть ОДНОРАЗОВОЙ — beforeEach делает TRUNCATE и
 * адрес не разбирает (гард на непустую базу — в beforeAll). Отдельная от
 * tok_race: jest гоняет файлы параллельными воркерами, и общая база значила бы,
 * что два спека делают TRUNCATE друг другу посреди сценария.
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS ref_acct"
 *   sudo -u postgres psql -qc "CREATE ROLE refacct LOGIN PASSWORD 'refacct'"
 *   sudo -u postgres psql -qc "CREATE DATABASE ref_acct OWNER refacct"
 *   REFERRAL_PG_URL=postgresql://refacct:refacct@127.0.0.1:5432/ref_acct npx jest src/referral
 *
 * Роль с паролем, а не `OWNER dv`: peer-аутентификация есть только у psql через
 * сокет, node-pg ходит по TCP и без пароля получает «client password must be a
 * string».
 *
 * КАК УВИДЕТЬ КРАСНОЕ. Вернуть в referral.service.ts прямой UPDATE вместо
 * creditTokens — покраснеют сверка в afterEach и сценарии про реестр, а
 * сценарии про баланс, отказы и идемпотентность останутся зелёными: они
 * стерегут неизменность поведения и обязаны молчать в обе стороны.
 */

const PG = process.env.REFERRAL_PG_URL;
const maybe = PG ? describe : describe.skip;

const TRUNCATE_ALL =
  'TRUNCATE ai_profiles_consolidated, token_transactions, balance_audit, ' +
  'referral_leaders, referral_referees, referral_commissions, ' +
  'referral_token_payouts, referral_withdrawals RESTART IDENTITY CASCADE';

maybe('Реферальные начисления против живого Postgres', () => {
  jest.setTimeout(120_000);

  let pool: Pool;
  let service: ReferralService;
  /** Сценарий объявил, что расхождение баланса с реестром здесь ожидаемо. */
  let imbalanceExpected = false;
  const expectImbalance = () => { imbalanceExpected = true; };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 10 });

    // Схема — теми же файлами, что и в проде. На ОТДЕЛЬНОМ соединении, которое
    // потом уничтожается (release(true)): внутри снимка есть
    // `set_config('search_path','',false)` — на всю сессию, и соединение
    // вернулось бы в пул с пустым search_path, после чего примерно каждый
    // второй запрос падает с «relation does not exist».
    const loader = await pool.connect();
    try {
      await loader.query(
        fs.readFileSync(path.join(__dirname, '..', 'base', 'migrations', '001_core_schema.sql'), 'utf8'),
      );
    } finally {
      loader.release(true);
    }

    const ok = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS t, current_setting('search_path') AS sp`,
    );
    if (!ok.rows[0].t) {
      throw new Error(`схема base/001 не накатилась (search_path=${ok.rows[0].sp})`);
    }

    // ГАРД НА ЧУЖУЮ БАЗУ. beforeEach делает TRUNCATE и адрес не разбирает, а на
    // той же ноде живёт база стенда test.linkeon.io с этими же таблицами: один
    // REFERRAL_PG_URL, скопированный не из той строки, сотрёт балансы и реестр
    // стенда без единого вопроса. Считается ДО первого TRUNCATE.
    for (const t of ['ai_profiles_consolidated', 'token_transactions', 'referral_referees']) {
      const n = await pool.query(`SELECT count(*) FROM ${t}`);
      if (Number(n.rows[0].count) > 0) {
        throw new Error(
          `REFERRAL_PG_URL указывает на НЕпустую базу (${t} не пуста) — нужна одноразовая, ` +
            'иначе TRUNCATE в beforeEach сотрёт чужие балансы (рецепт — в шапке файла)',
        );
      }
    }

    // Починка гонки в add_user_tokens (tokens/migrations/001) здесь не нужна:
    // проверяется учёт, а не блокировка. База получает то же определение, что
    // стоит на проде, — из снимка base/001.

    // ═══ ТРИГГЕР-НАБЛЮДАТЕЛЬ ═══
    // Живёт только в тестовой базе: в миграциях модулей его нет и быть не
    // должно. AFTER UPDATE FOR EACH ROW — видит итог каждого оператора,
    // независимо от того, как он написан.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS balance_audit (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        tokens_before bigint,
        tokens_after bigint
      )`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION balance_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $audit$
      BEGIN
        IF NEW.tokens IS DISTINCT FROM OLD.tokens THEN
          INSERT INTO balance_audit (user_id, tokens_before, tokens_after)
          VALUES (NEW.user_id, OLD.tokens, NEW.tokens);
        END IF;
        RETURN NULL;
      END
      $audit$`);
    await pool.query('DROP TRIGGER IF EXISTS balance_audit_trg ON ai_profiles_consolidated');
    await pool.query(`
      CREATE TRIGGER balance_audit_trg AFTER UPDATE ON ai_profiles_consolidated
      FOR EACH ROW EXECUTE FUNCTION balance_audit_fn()`);

    // Сервис — НАСТОЯЩИЙ, с адаптером под форму PgService. Копия его логики в
    // тесте проверяла бы копию.
    service = new ReferralService(
      {
        query: (sql: string, params?: any[]) => pool.query(sql, params),
        getClient: () => pool.connect(),
      } as any,
      undefined,
    );
    // onModuleInit заводит журналы программы и накатывает migrations/ —
    // ту же дозаливку, что поедет на прод.
    await service.onModuleInit();
  });

  afterAll(async () => {
    // ЗА СОБОЙ УБИРАЕМ: beforeAll требует пустые таблицы, иначе второй прогон в
    // той же базе падает целиком на гарде — и выглядит это как идеальная ловля
    // мутации, хотя врёт прибор.
    await pool?.query(TRUNCATE_ALL).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    imbalanceExpected = false;
    await pool.query(TRUNCATE_ALL);
  });

  // ═══ СВЕРКА, КОТОРУЮ НАСЛЕДУЕТ КАЖДЫЙ СЦЕНАРИЙ ═══
  afterEach(async () => {
    if (imbalanceExpected) return;
    const drift = await balanceDriftFromLedger();
    expect(drift).toEqual([]);
  });

  // ——— приборы ———

  let seq = 0;
  const newPhone = () => `7900${String(++seq).padStart(7, '0')}`;

  async function seedUser(tokens: number, userId = newPhone()): Promise<string> {
    await pool.query('INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)', [userId, tokens]);
    return userId;
  }

  async function seedLeader(userId: string, slug: string): Promise<string> {
    // Три параметра, а не `$1` дважды: колонки name/slug/user_phone объявлены
    // разной ширины, и Postgres на повторе отвечает «inconsistent types
    // deduced for parameter $1».
    const r = await pool.query(
      `INSERT INTO referral_leaders (name, slug, user_phone) VALUES ($1, $2, $3) RETURNING id`,
      [userId, slug, userId],
    );
    return r.rows[0].id;
  }

  async function seedCommission(leaderId: string, rub: number, refereePhone = newPhone()) {
    await pool.query(
      `INSERT INTO referral_commissions
              (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
       VALUES ($1, $2, $3, 1, $4, 10, $5)`,
      [leaderId, `pay-${++seq}`, refereePhone, rub * 10, rub],
    );
  }

  const balanceOf = async (userId: string): Promise<number | null> => {
    const r = await pool.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
    return r.rowCount === 0 ? null : Number(r.rows[0].tokens);
  };

  const ledgerOf = async (userId: string): Promise<any[]> => {
    const r = await pool.query(
      'SELECT * FROM token_transactions WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return r.rows;
  };

  /**
   * ОТВЕТ БАЗЫ на вопрос «кто изменил баланс и записано ли это». Для каждого
   * пользователя, которого триггер видел, сравниваются два числа: сколько
   * колонка суммарно сдвинулась и сколько движений записано в реестр.
   * Возвращает расхождения; пустой список — учёт сошёлся.
   */
  async function balanceDriftFromLedger(): Promise<any[]> {
    const r = await pool.query(`
      SELECT a.user_id,
             SUM(COALESCE(a.tokens_after, 0) - COALESCE(a.tokens_before, 0))::bigint AS moved,
             COALESCE((SELECT SUM(t.amount) FROM token_transactions t WHERE t.user_id = a.user_id), 0)::bigint AS recorded
        FROM balance_audit a
       GROUP BY a.user_id
      HAVING SUM(COALESCE(a.tokens_after, 0) - COALESCE(a.tokens_before, 0))
             <> COALESCE((SELECT SUM(t.amount) FROM token_transactions t WHERE t.user_id = a.user_id), 0)
    `);
    return r.rows.map((x: any) => ({
      user_id: x.user_id,
      moved: Number(x.moved),
      recorded: Number(x.recorded),
    }));
  }

  /** Взвести подрыв на COMMIT: строка в реестр уже ушла, транзакция не доедет. */
  async function armCommitFailure() {
    await pool.query(`
      CREATE OR REPLACE FUNCTION boom_fn() RETURNS trigger LANGUAGE plpgsql AS $boom$
      BEGIN RAISE EXCEPTION 'boom at commit'; END $boom$`);
    await pool.query(`
      CREATE CONSTRAINT TRIGGER boom_trg AFTER INSERT ON token_transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION boom_fn()`);
  }
  const disarmCommitFailure = () =>
    pool.query('DROP TRIGGER IF EXISTS boom_trg ON token_transactions');

  // ——— 1. Выплата комиссии токенами ———

  describe('payoutTokens', () => {
    async function seedPayable(rub = 200) {
      const userId = await seedUser(1_000);
      const leaderId = await seedLeader(userId, `pay-${seq}`);
      await seedCommission(leaderId, rub);
      return { userId, leaderId };
    }

    it('зачисляет токены на баланс', async () => {
      const { userId } = await seedPayable(200);

      const res = await service.payoutTokens(userId);

      expect(res.tokens).toBe(150_000); // 200 ₽ × 750
      expect(await balanceOf(userId)).toBe(151_000);
      expect(res.newBalance).toBe(151_000);
    });

    it('оставляет в реестре строку — тип, сумма, остаток после, описание', async () => {
      const { userId } = await seedPayable(200);

      await service.payoutTokens(userId);

      const rows = await ledgerOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].transaction_type).toBe('bonus');
      expect(Number(rows[0].amount)).toBe(150_000);
      expect(Number(rows[0].balance_after)).toBe(151_000);
      expect(rows[0].description).toBe('Реферальное вознаграждение: 200 ₽');
    });

    it('в реестре видно, что это реферальная выплата, и какая именно', async () => {
      // Тип 'bonus' один на все подарки — отличить выплату комиссии от
      // приветственного бонуса можно только по metadata. payout_id к тому же
      // служит ключом идемпотентности для дозаливки.
      const { userId, leaderId } = await seedPayable(200);

      await service.payoutTokens(userId);

      const [row] = await ledgerOf(userId);
      const payout = await pool.query('SELECT id FROM referral_token_payouts WHERE user_phone = $1', [userId]);
      expect(row.metadata.kind).toBe('referral_payout');
      expect(row.metadata.payout_id).toBe(payout.rows[0].id);
      expect(row.metadata.leader_id).toBe(leaderId);
      expect(Number(row.metadata.rub)).toBe(200);
      expect(Number(row.metadata.rate)).toBe(750);
    });

    it('комиссии помечены выплаченными, журнал выплат заполнен', async () => {
      const { userId } = await seedPayable(200);

      await service.payoutTokens(userId);

      const c = await pool.query('SELECT bool_and(paid_out) AS all_paid FROM referral_commissions');
      expect(c.rows[0].all_paid).toBe(true);
      const p = await pool.query('SELECT tokens, rate FROM referral_token_payouts WHERE user_phone = $1', [userId]);
      expect(Number(p.rows[0].tokens)).toBe(150_000);
    });

    it('НЕ ВЫПЛАЧИВАЕТ на отсутствующий профиль — иначе комиссия исчезает молча', async () => {
      // Главный сценарий этой починки. add_user_tokens на несуществующем
      // профиле отвечает success:true, баланс не трогает, а строку в реестр
      // пишет. Замена прямого UPDATE на процедуру «в лоб» превратила бы отказ
      // в тихую потерю: комиссии ушли бы в paid_out, в истории появилось бы
      // начисление, на балансе — ничего.
      const userId = newPhone(); // профиля нет
      const leaderId = await seedLeader(userId, `noprof-${seq}`);
      await seedCommission(leaderId, 200);

      await expect(service.payoutTokens(userId)).rejects.toThrow('Профиль не найден');

      expect(await ledgerOf(userId)).toHaveLength(0);
      expect(await balanceOf(userId)).toBeNull();
      const c = await pool.query('SELECT bool_or(paid_out) AS any_paid FROM referral_commissions');
      expect(c.rows[0].any_paid).toBe(false);
      const p = await pool.query('SELECT count(*) AS n FROM referral_token_payouts');
      expect(Number(p.rows[0].n)).toBe(0);
    });

    it('ниже порога — отказ, и в реестре пусто', async () => {
      const { userId } = await seedPayable(50); // < 100 ₽

      await expect(service.payoutTokens(userId)).rejects.toThrow('Минимум для вывода');

      expect(await ledgerOf(userId)).toHaveLength(0);
      expect(await balanceOf(userId)).toBe(1_000);
    });

    it('баланс и реестр едут одной транзакцией: падение на COMMIT не оставляет ни того, ни другого', async () => {
      const { userId } = await seedPayable(200);
      await armCommitFailure();
      try {
        await expect(service.payoutTokens(userId)).rejects.toThrow('boom at commit');
      } finally {
        await disarmCommitFailure();
      }

      expect(await balanceOf(userId)).toBe(1_000);
      expect(await ledgerOf(userId)).toHaveLength(0);
      const c = await pool.query('SELECT bool_or(paid_out) AS any_paid FROM referral_commissions');
      expect(c.rows[0].any_paid).toBe(false);
    });

    it('вторая выплата подряд не находит невыплаченных комиссий', async () => {
      const { userId } = await seedPayable(200);
      await service.payoutTokens(userId);

      await expect(service.payoutTokens(userId)).rejects.toThrow('Минимум для вывода');

      expect(await ledgerOf(userId)).toHaveLength(1);
    });
  });

  // ——— 2. Бонус приглашённому ———

  describe('register', () => {
    async function seedInviter(slug = `inv-${++seq}`) {
      const leaderUser = await seedUser(0);
      await seedLeader(leaderUser, slug);
      return { slug, leaderUser };
    }

    it('начисляет бонус на баланс', async () => {
      const { slug } = await seedInviter();
      const referee = await seedUser(5_000);

      const res = await service.register(referee, slug);

      expect(res).toMatchObject({ success: true, bonus_tokens: 20_000 });
      expect(await balanceOf(referee)).toBe(25_000);
    });

    it('оставляет в реестре строку с пометкой реферального бонуса', async () => {
      const { slug } = await seedInviter();
      const referee = await seedUser(5_000);

      await service.register(referee, slug);

      const rows = await ledgerOf(referee);
      expect(rows).toHaveLength(1);
      expect(rows[0].transaction_type).toBe('bonus');
      expect(Number(rows[0].amount)).toBe(20_000);
      expect(Number(rows[0].balance_after)).toBe(25_000);
      expect(rows[0].metadata.kind).toBe('referral_referee_bonus');
      expect(rows[0].metadata.slug).toBe(slug);
    });

    it('профиля нет — бонуса нет, и в реестре ничего: отметка не расходится с балансом', async () => {
      const { slug } = await seedInviter();
      const referee = newPhone(); // профиля нет

      const res = await service.register(referee, slug);

      expect(res).toMatchObject({ success: true, bonus_tokens: 0 });
      expect(await ledgerOf(referee)).toHaveLength(0);
      const rr = await pool.query('SELECT bonus_tokens FROM referral_referees WHERE referee_phone = $1', [referee]);
      expect(Number(rr.rows[0].bonus_tokens)).toBe(0);
    });

    it('повторная регистрация не начисляет второй раз', async () => {
      const { slug } = await seedInviter();
      const referee = await seedUser(5_000);
      await service.register(referee, slug);

      const again = await service.register(referee, slug);

      expect(again).toMatchObject({ success: false, error: 'Already registered' });
      expect(await balanceOf(referee)).toBe(25_000);
      expect(await ledgerOf(referee)).toHaveLength(1);
    });

    it('сам себя пригласить нельзя — ни токенов, ни строки', async () => {
      const leaderUser = await seedUser(5_000);
      const slug = `self-${++seq}`;
      await seedLeader(leaderUser, slug);

      const res = await service.register(leaderUser, slug);

      expect(res.success).toBe(false);
      expect(await balanceOf(leaderUser)).toBe(5_000);
      expect(await ledgerOf(leaderUser)).toHaveLength(0);
    });

    it('регистрация и бонус едут одной транзакцией: падение на COMMIT не оставляет ни рефери, ни токенов', async () => {
      // До починки это были три отдельных запроса на автокоммите, и обрыв
      // между ними оставлял рефери с bonus_tokens = 0 и уже начисленными
      // токенами — повторить выдачу нельзя («Already registered»), проверить
      // по журналу тоже.
      const { slug } = await seedInviter();
      const referee = await seedUser(5_000);
      await armCommitFailure();
      try {
        await expect(service.register(referee, slug)).rejects.toThrow('boom at commit');
      } finally {
        await disarmCommitFailure();
      }

      expect(await balanceOf(referee)).toBe(5_000);
      expect(await ledgerOf(referee)).toHaveLength(0);
      const rr = await pool.query('SELECT count(*) AS n FROM referral_referees WHERE referee_phone = $1', [referee]);
      expect(Number(rr.rows[0].n)).toBe(0);
    });

    it('чужой баланс не трогает', async () => {
      // Посторонний нужен физически: без него `WHERE user_id = $1 OR TRUE`
      // пережил бы весь файл зелёным — в каждом сценарии ровно один
      // пользователь, и «начислили всем» от «начислили нужному» неотличимо.
      const { slug } = await seedInviter();
      const referee = await seedUser(5_000);
      const bystander = await seedUser(777);

      await service.register(referee, slug);

      expect(await balanceOf(bystander)).toBe(777);
    });
  });

  // ——— 3. Дозаливка уже начисленного мимо реестра ———

  describe('дозаливка (migrations/002)', () => {
    /** Начисление «как до починки»: баланс двинулся, реестр не знает. */
    async function accrueOffLedger(userId: string, leaderId: string, tokens: number) {
      await pool.query(
        'UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2',
        [tokens, userId],
      );
      await pool.query(
        'INSERT INTO referral_referees (referee_phone, leader_id, bonus_tokens) VALUES ($1, $2, $3)',
        [userId, leaderId, tokens],
      );
    }

    const runBackfill = () => service.onModuleInit();

    it('восстанавливает строку по журналу программы: кому, сколько, когда', async () => {
      const leaderUser = await seedUser(0);
      const leaderId = await seedLeader(leaderUser, `bf-${++seq}`);
      const referee = await seedUser(25_000);
      await accrueOffLedger(referee, leaderId, 20_000);
      expect(await ledgerOf(referee)).toHaveLength(0);

      await runBackfill();

      const rows = await ledgerOf(referee);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(20_000);
      expect(rows[0].metadata.kind).toBe('referral_referee_bonus');
      expect(rows[0].metadata.leader_id).toBe(leaderId);
    });

    it('НЕ ТРОГАЕТ БАЛАНС — токены уже у людей, второй раз их выдавать нельзя', async () => {
      const leaderUser = await seedUser(0);
      const leaderId = await seedLeader(leaderUser, `bf-${++seq}`);
      const referee = await seedUser(25_000);
      await accrueOffLedger(referee, leaderId, 20_000);

      await runBackfill();

      expect(await balanceOf(referee)).toBe(45_000);
    });

    it('помечает строку восстановленной — API отдаст по ней null, а не выдуманный остаток', async () => {
      const leaderUser = await seedUser(0);
      const leaderId = await seedLeader(leaderUser, `bf-${++seq}`);
      const referee = await seedUser(25_000);
      await accrueOffLedger(referee, leaderId, 20_000);

      await runBackfill();

      const [row] = await ledgerOf(referee);
      expect(row.metadata.reconstructed).toBe(true);
    });

    it('идемпотентна: второй прогон не добавляет ни строки', async () => {
      const leaderUser = await seedUser(0);
      const leaderId = await seedLeader(leaderUser, `bf-${++seq}`);
      const referee = await seedUser(25_000);
      await accrueOffLedger(referee, leaderId, 20_000);

      await runBackfill();
      await runBackfill();
      await runBackfill();

      expect(await ledgerOf(referee)).toHaveLength(1);
    });

    it('не дублирует начисление, сделанное уже починенным кодом', async () => {
      const leaderUser = await seedUser(0);
      // Слаг в переменную, а не `fresh-${seq}` дважды: seedUser между вызовами
      // двигает счётчик, и register получал бы НЕСУЩЕСТВУЮЩУЮ ссылку. Тест при
      // этом падал честно, но по другой причине, чем проверяет.
      const slug = `fresh-${++seq}`;
      await seedLeader(leaderUser, slug);
      const referee = await seedUser(5_000);
      const reg = await service.register(referee, slug);
      expect(reg).toMatchObject({ success: true, bonus_tokens: 20_000 });

      await runBackfill();

      expect(await ledgerOf(referee)).toHaveLength(1);
      expect(await balanceOf(referee)).toBe(25_000);
    });

    it('восстанавливает и выплату комиссии — ключом служит id строки журнала', async () => {
      const leaderUser = await seedUser(1_000);
      const leaderId = await seedLeader(leaderUser, `pb-${++seq}`);
      await pool.query(
        `INSERT INTO referral_token_payouts (leader_id, user_phone, rub, tokens, rate, commission_ids)
         VALUES ($1, $2, 200, 150000, 750, ARRAY[]::uuid[])`,
        [leaderId, leaderUser],
      );

      await runBackfill();
      await runBackfill();

      const rows = await ledgerOf(leaderUser);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(150_000);
      expect(rows[0].metadata.kind).toBe('referral_payout');
      expect(rows[0].metadata.reconstructed).toBe(true);
    });

    it('человека без бонуса не трогает', async () => {
      const leaderUser = await seedUser(0);
      const leaderId = await seedLeader(leaderUser, `nb-${++seq}`);
      const referee = await seedUser(25_000);
      await pool.query(
        'INSERT INTO referral_referees (referee_phone, leader_id, bonus_tokens) VALUES ($1, $2, 0)',
        [referee, leaderId],
      );

      await runBackfill();

      expect(await ledgerOf(referee)).toHaveLength(0);
    });
  });

  // ——— 4. Прибор ———

  describe('прибор', () => {
    it('триггер видит прямое изменение баланса — иначе сверять нечего', async () => {
      // Если триггер отвалится (переименуют таблицу, забудут CREATE TRIGGER),
      // сверка в afterEach станет зелёной МГНОВЕННО и молча: смотреть будет не
      // на что. Здесь она обязана покраснеть.
      expectImbalance();
      const userId = await seedUser(1_000);

      await pool.query(
        'UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2',
        [20_000, userId],
      );

      expect(await balanceDriftFromLedger()).toEqual([
        { user_id: userId, moved: 20_000, recorded: 0 },
      ]);
    });

    it('сверка не ловится на написание запроса — узнаёт баланс и через алиас, и через переменную', async () => {
      // Ровно те написания, на которых прокалывался текстовый сторож.
      expectImbalance();
      const viaAlias = await seedUser(1_000);
      const viaGreatest = await seedUser(1_000);

      await pool.query('UPDATE ai_profiles_consolidated a SET tokens = a.tokens + 5 WHERE a.user_id = $1', [viaAlias]);
      await pool.query('UPDATE ai_profiles_consolidated SET tokens = GREATEST(0, tokens - 7) WHERE user_id = $1', [viaGreatest]);

      const drift = await balanceDriftFromLedger();
      expect(drift.sort((a, b) => a.user_id.localeCompare(b.user_id))).toEqual(
        [
          { user_id: viaAlias, moved: 5, recorded: 0 },
          { user_id: viaGreatest, moved: -7, recorded: 0 },
        ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
      );
    });

    it('сверка молчит на сходящемся учёте — иначе она краснела бы всегда', async () => {
      const userId = await seedUser(1_000);

      await pool.query(
        `SELECT add_user_tokens($1, 500, 'bonus'::transaction_type_enum, 'тест', NULL)`,
        [userId],
      );

      expect(await balanceDriftFromLedger()).toEqual([]);
    });
  });
});
