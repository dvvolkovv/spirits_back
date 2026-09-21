import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MiscService } from '../misc/misc.service';
import { TgBillingService } from '../tg-bot/tg-billing.service';
import { TokenAccountingService } from '../scheduler/token-accounting.service';

/**
 * ЗАПАСНЫЕ ПУТИ СПИСАНИЯ ТОЖЕ ДОЕЗЖАЮТ ДО РЕЕСТРА — против живого Postgres.
 *
 * Три места списывают токены прямым UPDATE, если consume_user_tokens почему-то
 * недоступна: MiscService.deductTokens, TgBillingService.deduct и ночной
 * TokenAccountingService.processTokenTasks. Все три до 21.09.2026 уводили
 * списание мимо token_transactions — тот же дефект учёта, что в реферальных
 * начислениях, только на расходной стороне. Нашлись они не чтением кода: их
 * показал переписанный сторож (balance-writes.guard), когда перестал искать
 * одно написание правой части.
 *
 * ПОЧЕМУ НЕ МОКОМ. Рядом лежит misc.service.deduct.spec.ts, и он проверяет
 * текст запроса: `expect(upd.sql).toMatch(/GREATEST\(0, tokens - \$1\)/)`.
 * Такой тест одинаково зелен и когда пол работает, и когда SQL не выполняется
 * вовсе, и когда INSERT в реестр стоит в тексте, но отваливается на
 * NOT NULL balance_after, и когда списалось меньше запрошенного, а метод
 * отрапортовал полной суммой. Здесь всё это различимо, потому что запросы
 * действительно исполняются.
 *
 * КАК ВОСПРОИЗВОДИТСЯ «ПРОЦЕДУРЫ НЕТ». Не подменой объекта и не флагом в коде:
 * из тестовой базы просто УДАЛЯЕТСЯ consume_user_tokens. Дальше catch-ветка
 * срабатывает по той же причине, по какой сработала бы на проде, — Postgres
 * отвечает «function does not exist».
 *
 * КАК ГОНЯТЬ (база одноразовая, своя — jest гоняет файлы параллельно, и общая
 * база значила бы TRUNCATE посреди чужого сценария):
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS fb_deduct"
 *   sudo -u postgres psql -qc "CREATE DATABASE fb_deduct OWNER refacct"
 *   FALLBACK_PG_URL=postgresql://refacct:refacct@127.0.0.1:5432/fb_deduct npx jest src/tokens
 */

const PG = process.env.FALLBACK_PG_URL;
const maybe = PG ? describe : describe.skip;

const TRUNCATE_ALL =
  'TRUNCATE ai_profiles_consolidated, token_transactions, token_consumption_tasks ' +
  'RESTART IDENTITY CASCADE';

maybe('Запасные пути списания против живого Postgres', () => {
  jest.setTimeout(120_000);

  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });

    // release(true): внутри снимка есть `set_config('search_path','',false)` —
    // на всю сессию. Соединение вернулось бы в пул с пустым search_path.
    const loader = await pool.connect();
    try {
      await loader.query(
        fs.readFileSync(path.join(__dirname, '..', 'base', 'migrations', '001_core_schema.sql'), 'utf8'),
      );
    } finally {
      loader.release(true);
    }

    const ok = await pool.query(`SELECT to_regclass('public.ai_profiles_consolidated') AS t`);
    if (!ok.rows[0].t) throw new Error('схема base/001 не накатилась');

    // ГАРД НА ЧУЖУЮ БАЗУ — считается ДО первого TRUNCATE. На этой же ноде
    // живёт база стенда с теми же таблицами.
    for (const t of ['ai_profiles_consolidated', 'token_transactions']) {
      const n = await pool.query(`SELECT count(*) FROM ${t}`);
      if (Number(n.rows[0].count) > 0) {
        throw new Error(`FALLBACK_PG_URL указывает на НЕпустую базу (${t} не пуста) — нужна одноразовая`);
      }
    }

    // ═══ ПРОЦЕДУРЫ НЕТ ═══ Ровно то состояние, ради которого написан catch.
    await pool.query('DROP FUNCTION IF EXISTS consume_user_tokens(text, bigint, text, jsonb)');
    await pool.query('DROP FUNCTION IF EXISTS consume_user_tokens(text, bigint, text)');
    const left = await pool.query(
      `SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'consume_user_tokens'`,
    );
    // Без этой проверки прогон, в котором процедура УЦЕЛЕЛА, был бы зелёным и
    // не проверял бы запасной путь вовсе — списывала бы процедура.
    if (Number(left.rows[0].n) !== 0) {
      throw new Error('прибор сломан: consume_user_tokens осталась в базе, catch-ветка не сработает');
    }
  });

  afterAll(async () => {
    await pool?.query(TRUNCATE_ALL).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_ALL);
  });

  let seq = 0;
  const pg = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params) }) as any;

  async function seedUser(tokens: number): Promise<string> {
    const userId = `fb-user-${++seq}`;
    await pool.query('INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)', [userId, tokens]);
    return userId;
  }
  const balanceOf = async (u: string) =>
    Number((await pool.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [u])).rows[0].tokens);
  const ledgerOf = async (u: string) =>
    (await pool.query('SELECT * FROM token_transactions WHERE user_id = $1 ORDER BY id', [u])).rows;

  describe('MiscService.deductTokens', () => {
    const svc = () => new MiscService(null as any, pg(), null as any, null as any);

    it('списывает с баланса', async () => {
      const u = await seedUser(10_000);
      await svc().deductTokens(u, 3_000, 'картинка');
      expect(await balanceOf(u)).toBe(7_000);
    });

    it('оставляет строку в реестре — сумма, остаток после, описание', async () => {
      const u = await seedUser(10_000);
      await svc().deductTokens(u, 3_000, 'картинка');

      const rows = await ledgerOf(u);
      expect(rows).toHaveLength(1);
      expect(rows[0].transaction_type).toBe('consumed');
      expect(Number(rows[0].amount)).toBe(-3_000);
      expect(Number(rows[0].balance_after)).toBe(7_000);
      expect(rows[0].description).toBe('картинка');
    });

    it('не уводит баланс в минус', async () => {
      const u = await seedUser(1_000);
      await svc().deductTokens(u, 5_000);
      expect(await balanceOf(u)).toBe(0);
    });

    it('возвращает СПИСАННОЕ, а не запрошенное, когда баланса не хватило', async () => {
      // Прежняя редакция возвращала `amount` всегда: вызывающий считал услугу
      // оплаченной целиком, хотя пол забрал только остаток.
      const u = await seedUser(1_000);
      expect(await svc().deductTokens(u, 5_000)).toBe(1_000);
    });

    it('в реестр уезжает фактическое списание, а не запрошенное', async () => {
      const u = await seedUser(1_000);
      await svc().deductTokens(u, 5_000);

      const rows = await ledgerOf(u);
      expect(Number(rows[0].amount)).toBe(-1_000);
      expect(Number(rows[0].balance_after)).toBe(0);
    });

    it('баланс сходится с реестром', async () => {
      const u = await seedUser(10_000);
      await svc().deductTokens(u, 3_000);
      await svc().deductTokens(u, 2_500);

      const sum = await pool.query(
        'SELECT COALESCE(sum(amount), 0) AS s FROM token_transactions WHERE user_id = $1', [u]);
      expect(10_000 + Number(sum.rows[0].s)).toBe(await balanceOf(u));
    });

    it('несуществующий профиль не заводит строку в реестре', async () => {
      expect(await svc().deductTokens('fb-ghost', 1_000)).toBe(0);
      expect(await ledgerOf('fb-ghost')).toHaveLength(0);
    });

    it('чужой баланс не трогает', async () => {
      const target = await seedUser(10_000);
      const bystander = await seedUser(555);
      await svc().deductTokens(target, 3_000);
      expect(await balanceOf(bystander)).toBe(555);
    });
  });

  describe('TgBillingService.deduct', () => {
    const svc = () => new TgBillingService(pg(), null as any);

    it('списывает и оставляет строку в реестре', async () => {
      const u = await seedUser(10_000);

      const left = await svc().deduct(u, 4_000);

      expect(left).toBe(6_000);
      const rows = await ledgerOf(u);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(-4_000);
      expect(Number(rows[0].balance_after)).toBe(6_000);
      expect(rows[0].metadata.kind).toBe('tg_bot_fallback_deduct');
    });

    it('пол работает, и в реестре лежит фактическое списание', async () => {
      const u = await seedUser(1_500);

      expect(await svc().deduct(u, 9_000)).toBe(0);

      expect(Number((await ledgerOf(u))[0].amount)).toBe(-1_500);
    });

    it('нулевое списание не пишет ничего', async () => {
      const u = await seedUser(10_000);
      await svc().deduct(u, 0);
      expect(await ledgerOf(u)).toHaveLength(0);
      expect(await balanceOf(u)).toBe(10_000);
    });
  });

  describe('TokenAccountingService.processTokenTasks', () => {
    const svc = () => new TokenAccountingService(pg(), null as any);

    async function seedTask(userId: string, tokens: number) {
      await pool.query(
        `INSERT INTO token_consumption_tasks (execution_id, user_id, status, tokens_to_consume, metadata)
         VALUES ($1, $2, 'pending', $3, $4::jsonb)`,
        [++seq, userId, tokens, JSON.stringify({ durationMs: 120_000 })],
      );
    }

    it('списывает по задаче и оставляет строку в реестре', async () => {
      const u = await seedUser(50_000);
      await seedTask(u, 12_000);

      await svc().processTokenTasks();

      expect(await balanceOf(u)).toBe(38_000);
      const rows = await ledgerOf(u);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(-12_000);
      expect(Number(rows[0].balance_after)).toBe(38_000);
      // Описание считает сам сервис (explainCharge) — оно должно доехать.
      expect(rows[0].description).toContain('мин работы');
    });

    it('помечает задачу выполненной', async () => {
      const u = await seedUser(50_000);
      await seedTask(u, 12_000);

      await svc().processTokenTasks();

      const t = await pool.query(`SELECT status FROM token_consumption_tasks WHERE user_id = $1`, [u]);
      expect(t.rows[0].status).toBe('completed');
    });

    it('второй оборот не списывает повторно — задача уже не pending', async () => {
      const u = await seedUser(50_000);
      await seedTask(u, 12_000);

      await svc().processTokenTasks();
      await svc().processTokenTasks();

      expect(await balanceOf(u)).toBe(38_000);
      expect(await ledgerOf(u)).toHaveLength(1);
    });
  });
});
