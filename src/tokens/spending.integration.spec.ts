import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { TokensSchemaService } from './tokens-schema.service';
import { SpendingService } from './spending.service';
import { classifySpend, spendCategorySql } from './spend-category';
import { SPEND_SAMPLES } from './spend-category.samples';

/**
 * Сводка расхода и перенос старых трат — против живого Postgres.
 *
 * Здесь проверяется то, чего не видят юнит-тесты: что CASE из
 * spendCategorySql в базе классифицирует так же, как classifySpend; что
 * граница месяца считается в поясе; что 002_backfill_spend_history.sql,
 * применённый ТЕМ ЖЕ TokensSchemaService, что и на проде, переносит нужное,
 * не трогает балансы и второй раз ничего не добавляет.
 *
 * КАК ГОНЯТЬ. База одноразовая — пересоздавать перед каждым прогоном
 * (снимок base/001 второй раз не накатывается):
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS spend_test"
 *   sudo -u postgres psql -qc "CREATE ROLE spendtest LOGIN PASSWORD 'spendtest'"   # один раз
 *   sudo -u postgres psql -qc "CREATE DATABASE spend_test OWNER spendtest"
 *   SPENDING_PG_URL=postgresql://spendtest:spendtest@127.0.0.1:5432/spend_test \
 *     npx jest src/tokens/spending.integration
 */
const PG = process.env.SPENDING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('сводка расхода и перенос старых трат — живой Postgres', () => {
  jest.setTimeout(120_000);
  let pool: Pool;
  const db = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params) }) as any;
  const migrate = () => new TokensSchemaService(db()).onModuleInit();

  const consumed = (userId: string, amount: number, at: string, description: string | null, metadata: object | null = null) =>
    pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, metadata, created_at)
       VALUES ($1, 'consumed', $2, 0, $3, $4, $5)`,
      [userId, amount, description, metadata ? JSON.stringify(metadata) : null, at],
    );

  const reconstructed = async () =>
    (await pool.query(
      `SELECT user_id, amount::int AS amount, description, metadata ->> 'source' AS source,
              metadata ->> 'source_id' AS source_id, balance_after::int AS balance_after,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at
         FROM token_transactions
        WHERE metadata ->> 'reconstructed' = 'true'
        ORDER BY source, created_at`,
    )).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    // Снимок base/001 — на отдельном соединении, которое затем уничтожается:
    // строка pg_dump `set_config('search_path', '', false)` оставляет его с
    // пустым search_path на всю сессию.
    const loader = await pool.connect();
    try {
      await loader.query(
        fs.readFileSync(path.join(__dirname, '..', 'base', 'migrations', '001_core_schema.sql'), 'utf8'),
      );
    } finally {
      loader.release(true);
    }
    await pool.query(
      fs.readFileSync(path.join(__dirname, '..', 'tg-bot', 'migrations', '001_tg_bot_schema.sql'), 'utf8'),
    );
    const n = await pool.query('SELECT count(*)::int AS n FROM token_transactions');
    if (n.rows[0].n !== 0) {
      throw new Error('SPENDING_PG_URL указывает на непустую базу — нужна одноразовая (рецепт в шапке)');
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE token_transactions, ai_profiles_consolidated, generated_images, video_jobs, tg_bot_messages, tg_bot_configs RESTART IDENTITY CASCADE',
    );
    await pool.query('DROP TABLE IF EXISTS video_jobs_expired_bak_20260728');
  });

  it('SQL-выражение категорий совпадает с classifySpend на всех образцах', async () => {
    for (const [i, [description, metadata]] of SPEND_SAMPLES.entries()) {
      await consumed('u-cls', -(i + 1), '2026-10-01T12:00:00Z', description, metadata);
    }
    const r = await pool.query(
      `SELECT description, metadata, ${spendCategorySql()} AS category FROM token_transactions WHERE user_id = 'u-cls'`,
    );
    expect(r.rows).toHaveLength(SPEND_SAMPLES.length);
    for (const row of r.rows) {
      expect(row.category).toBe(classifySpend(row.description, row.metadata));
    }
  });

  it('граница месяца — в поясе пользователя; неизвестный или пустой пояс — Москва', async () => {
    await consumed('u-tz', -1000, '2026-10-31T22:30:00Z', 'image');
    const svc = new SpendingService(db());
    expect((await svc.monthly('u-tz', 'Europe/Moscow'))[0].month).toBe('2026-11');
    expect((await svc.monthly('u-tz', 'UTC'))[0].month).toBe('2026-10');
    expect((await svc.monthly('u-tz', 'Nowhere/Atlantis'))[0].month).toBe('2026-11');
    expect((await svc.monthly('u-tz', undefined))[0].month).toBe('2026-11');
  });

  it('сводка: только списания этого пользователя, месяцы от нового к старому, категории по убыванию', async () => {
    await consumed('u-sum', -600, '2026-10-22T23:12:50Z', 'Ответ ассистента «Роман»', { taken: 'turn' });
    await consumed('u-sum', -400, '2026-10-22T23:14:05Z', 'Ответ ассистента «Роман»');
    await consumed('u-sum', -10000, '2026-06-27T18:17:48Z', 'image');
    await consumed('u-sum', -2000, '2026-06-27T18:20:00Z', null);
    await pool.query(
      `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description, created_at)
       VALUES ('u-sum', 'purchase', 200000, 200000, 'Пополнение', '2026-10-22T23:11:09Z')`,
    );
    await consumed('u-other', -999, '2026-10-01T00:00:00Z', 'image');

    expect(await new SpendingService(db()).monthly('u-sum', 'Europe/Moscow')).toEqual([
      { month: '2026-10', total: 1000, categories: [{ key: 'replies', tokens: 1000, count: 2 }] },
      {
        month: '2026-06',
        total: 12000,
        categories: [
          { key: 'images', tokens: 10000, count: 1 },
          { key: 'replies', tokens: 2000, count: 1 },
        ],
      },
    ]);
  });

  describe('перенос старых трат (002)', () => {
    async function seed() {
      await pool.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES
           ('u-a', 193807), ('u-b', 1000), ('u-c', 5000), ('u-d', 0)`,
      );
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at) VALUES
           (1, 'u-a', 'p', 'https://x/1.png', 10000, '2026-06-27T18:17:48Z'),
           (2, 'u-a', 'p', 'https://x/2.png', 10000, '2026-09-01T10:00:00Z'),
           (3, 'u-a', 'p', 'https://x/3.png', 0,     '2026-06-01T10:00:00Z'),
           (4, 'u-d', 'p', 'https://x/4.png', 10000, '2026-07-01T10:00:00Z')`,
      );
      // Уже записанное списание той же суммы у u-d в пределах двух минут — картинку 4 не переносить.
      await consumed('u-d', -10000, '2026-07-01T10:00:30Z', null);
      await pool.query(
        `INSERT INTO video_jobs (id, user_id, mode, model, quality, duration_sec, tokens_spent, status, created_at) VALUES
           ('00000000-0000-4000-8000-000000000001', 'u-a', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'ready',  '2026-05-06T03:02:36Z'),
           ('00000000-0000-4000-8000-000000000002', 'u-a', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'failed', '2026-05-06T02:35:00Z'),
           ('00000000-0000-4000-8000-000000000003', 'u-a', 'text2video',  'veo-3.1',    'std', 8, 90000, 'ready',  '2026-09-10T00:00:00Z')`,
      );
      await pool.query('CREATE TABLE video_jobs_expired_bak_20260728 (LIKE video_jobs INCLUDING DEFAULTS)');
      await pool.query(
        `INSERT INTO video_jobs_expired_bak_20260728 (id, user_id, mode, model, quality, duration_sec, tokens_spent, status, created_at)
         VALUES ('00000000-0000-4000-8000-000000000004', 'u-b', 'image2video', 'kling-v1-6', 'std', 5, 25000, 'ready', '2026-04-21T10:08:43Z')`,
      );
      const cfg = await pool.query(
        `INSERT INTO tg_bot_configs (owner_user_id, display_name, preset_agent_id, addressing_mode, voice_reply_mode, status)
         VALUES ('u-c', 'bot', 'roman', 'smart', 'never', 'active') RETURNING id`,
      );
      const configId = cfg.rows[0].id;
      await pool.query(
        `INSERT INTO tg_bot_messages (config_id, tg_chat_id, role, content, content_type, tokens_charged, created_at) VALUES
           ($1, 1, 'user',      'привет', 'text', 0,    '2026-08-01T00:00:00Z'),
           ($1, 1, 'assistant', 'ответ',  'text', 7000, '2026-08-01T00:00:10Z'),
           ($1, 1, 'assistant', 'ответ',  'text', 3000, '2026-08-12T00:00:00Z')`,
        [configId],
      );
    }

    const balances = async () =>
      (await pool.query('SELECT user_id, tokens::int AS tokens FROM ai_profiles_consolidated ORDER BY user_id')).rows;

    it('переносит только своё, до границы и не дублируя; балансы не трогает', async () => {
      await seed();
      const before = await balances();

      await migrate();

      expect(await reconstructed()).toEqual([
        { user_id: 'u-a', amount: -10000, description: 'image', source: 'generated_images', source_id: '1', balance_after: 0, at: '2026-06-27T18:17:48' },
        { user_id: 'u-c', amount: -7000, description: 'tg-bot', source: 'tg_bot_messages', source_id: '2', balance_after: 0, at: '2026-08-01T00:00:10' },
        { user_id: 'u-a', amount: -25000, description: 'Генерация видео', source: 'video_jobs', source_id: '00000000-0000-4000-8000-000000000001', balance_after: 0, at: '2026-05-06T03:02:36' },
        { user_id: 'u-b', amount: -25000, description: 'Генерация видео', source: 'video_jobs_expired_bak_20260728', source_id: '00000000-0000-4000-8000-000000000004', balance_after: 0, at: '2026-04-21T10:08:43' },
      ]);
      expect(await balances()).toEqual(before);
    });

    it('второй старт ничего не добавляет', async () => {
      await seed();
      await migrate();
      const first = await reconstructed();
      await migrate();
      expect(await reconstructed()).toEqual(first);
    });

    it('индекс журнала создан', async () => {
      await migrate();
      const r = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'token_transactions' AND indexname = 'idx_token_transactions_user_created'`,
      );
      expect(r.rowCount).toBe(1);
    });

    it('повторный старт не запирает журнал: открытое списание его не держит', async () => {
      // Голый CREATE INDEX IF NOT EXISTS берёт ShareLock на таблицу и при уже
      // существующем индексе и держит его до конца транзакции файла. Тогда
      // каждый старт API ждал бы любую открытую транзакцию со списанием, а все
      // списания после — ждали бы его. Ожидание здесь не пауза: при запирании
      // второй старт стоит, пока транзакция не закрыта, сколько бы ни ждали;
      // десять секунд — только чтобы прогон не висел.
      await migrate();
      const writer = await pool.connect();
      let timer: NodeJS.Timeout | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO token_transactions (user_id, transaction_type, amount, balance_after, description)
           VALUES ('u-open', 'consumed', -1, 0, 'image')`,
        );
        const second = migrate().then(() => 'done');
        const outcome = await Promise.race([
          second,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('blocked'), 10_000);
          }),
        ]);
        await writer.query('ROLLBACK');
        await second;
        expect(outcome).toBe('done');
      } finally {
        clearTimeout(timer);
        writer.release();
      }
    });

    it('нет резервной таблицы видео — остальные источники всё равно переносятся', async () => {
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at)
         VALUES (10, 'u-a', 'p', 'https://x/10.png', 5000, '2026-06-01T10:00:00Z')`,
      );
      await migrate();
      expect((await reconstructed()).map((r) => r.source)).toEqual(['generated_images']);
    });

    it('две картинки на одну сумму подряд переносятся обе — защита от дублей их не съедает', async () => {
      await pool.query(
        `INSERT INTO generated_images (id, user_id, prompt, image_url, tokens_spent, created_at) VALUES
           (20, 'u-a', 'p', 'https://x/20.png', 10000, '2026-06-27T20:37:47Z'),
           (21, 'u-a', 'p', 'https://x/21.png', 10000, '2026-06-27T20:37:57Z')`,
      );
      await migrate();
      expect((await reconstructed()).map((r) => r.source_id)).toEqual(['20', '21']);
    });

    it('перенесённое попадает в свои категории сводки', async () => {
      await seed();
      await migrate();
      expect(await new SpendingService(db()).monthly('u-a', 'UTC')).toEqual([
        { month: '2026-06', total: 10000, categories: [{ key: 'images', tokens: 10000, count: 1 }] },
        { month: '2026-05', total: 25000, categories: [{ key: 'video', tokens: 25000, count: 1 }] },
      ]);
    });
  });
});
