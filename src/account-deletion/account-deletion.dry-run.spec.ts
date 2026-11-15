import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { Client, Pool } from 'pg';
import { randomUUID } from 'crypto';

// Внешние границы подменены ДО импорта модулей: dry-run не обязан их вызывать,
// но шпионы доказывают это, а не полагаются на отсутствие импортов. Фабрики
// лёгкие — тяжёлые цепочки (aws-sdk, grammy, products-DI) в спек не грузятся.
jest.mock('../common/services/storage.service', () => ({
  StorageService: class StorageService {
    async delete(): Promise<void> { /* цель шпиона */ }
    async deleteConfirmed(): Promise<'deleted' | 'absent'> { return 'absent'; }
  },
}));
jest.mock('../tg-bot/tg-grammy.client', () => ({
  TgGrammyClient: class TgGrammyClient {
    async leaveChat(): Promise<void> { /* цель шпиона */ }
  },
}));
jest.mock('../products/host.controller', () => ({
  HostController: class HostController {
    async poll(): Promise<unknown> { return undefined; }
  },
}));

import { HostController } from '../products/host.controller';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import {
  DryRunApplyError,
  dryRunAccountDeletion,
  parseDryRunArgs,
} from './account-deletion.dry-run';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRegistry } from './account-deletion.registry';
import { ACCOUNT_DELETION_RETENTION_MS } from './account-deletion.safe';

/**
 * Task 21 — строгий dry-run очистки аккаунтов: прогноз плана удаления БЕЗ
 * побочных эффектов.
 *
 * Контракт:
 *  - dryRunAccountDeletion использует ТОЛЬКО selectDeletionCandidates +
 *    readExistingOrigin + AccountDeletionPlanner.collect с полным каталогом
 *    DELETION_DISCOVERERS;
 *  - persist не вызывается (план не пишется в account_deletion_jobs);
 *  - адаптеры/реестр не исполняются (getExecutor не вызывается);
 *  - миграции не запускаются (schema_migrations не появляется);
 *  - внешние клиенты (MinIO, Telegram, products-host) не вызываются;
 *  - весь SQL — SELECT (в PG-варианте дополнительно BEGIN READ ONLY:
 *    любая попытка записи — ошибка 25006 от самого сервера);
 *  - отчёт — только возвращаемая сводка: никаких файлов и списков
 *    userId/deletionId в выдаче.
 *
 * Отклонение от скетча плана (задокументировано в вердикте задачи): collect
 * ВСЕГДА добавляет core-задачу первым job'ом, поэтому jobsByType фикстуры —
 * {account.core.purge:1, product.purge:1}, а не {product.purge:1}; origin
 * берётся из СУЩЕСТВУЮЩИХ строк (readExistingOrigin): core.immediate нет —
 * 'merge', как у jobs.originOf.
 */

const USER = 'u-dryrun';
const DELETION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const VIDEO_ID = '11111111-2222-3333-4444-555555555555';
const DELETED_AT = new Date(Date.now() - 40 * 24 * 3600 * 1000);

jest.setTimeout(120_000);

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const WRITE_WORDS_RE =
  /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM)\b/i;

/** Шпионы на прототипах: dry-run не создаёт ни адаптеров, ни клиентов. */
const persistSpy = jest.spyOn(AccountDeletionPlanner.prototype, 'persist');
const getExecutorSpy = jest.spyOn(AccountDeletionRegistry.prototype, 'getExecutor');
const storageDeleteSpy = jest.spyOn(StorageService.prototype, 'delete');
const leaveChatSpy = jest.spyOn(TgGrammyClient.prototype, 'leaveChat');
const hostPollSpy = jest.spyOn(HostController.prototype, 'poll');

/**
 * Read-only рекордер: пишет каждый SQL в calls и раздаёт фикстуры одного
 * удалённого аккаунта — purged-продукт (product.purge без stop) и маркер
 * [VIDEO_JOB:uuid] в истории без строки владения (skip owner_unverifiable
 * БЕЗ job'ов — канонический объект чистят Task 12/13). Gate-запросы
 * `SELECT 1 FROM user_id u ...` пусты: gate-only discoverers молчат.
 * Префикс-диспетчеридут от начала нормализованного SQL, поэтому
 * `SELECT 1 FROM user_identities ...` gate-регуляркой не матчится (\b).
 */
function readOnlyPgRecorder(
  calls: string[],
  options: { origin?: 'explicit' | 'merge' } = {},
) {
  return {
    query: async (sql: string, params: any[] = []) => {
      calls.push(sql);
      const norm = normalize(sql);
      if (norm.startsWith('SELECT internal_id,deletion_id,deleted_at FROM user_id')) {
        return {
          rows: [{ internal_id: USER, deletion_id: DELETION_ID, deleted_at: DELETED_AT }],
          rowCount: 1,
        };
      }
      if (norm.startsWith('SELECT 1 FROM account_deletion_jobs')) {
        return options.origin === 'explicit'
          ? { rows: [{ '?column?': 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/^SELECT 1 FROM user_id u\b/.test(norm)) {
        return { rows: [], rowCount: 0 };
      }
      if (norm.startsWith('SELECT p.id,p.slug,p.host_id,p.purged_at')) {
        return {
          rows: [{ id: 'p-1', slug: 'demo', host_id: null, purged_at: new Date() }],
          rowCount: 1,
        };
      }
      if (norm.startsWith('SELECT h.id, h.content')) {
        const lastId = Number(params[1] ?? 0);
        if (lastId === 0) {
          return {
            rows: [{ id: 10, content: `Смотри: [VIDEO_JOB:${VIDEO_ID}]` }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('dryRunAccountDeletion — collect без побочных эффектов (Task 21, unit)', () => {
  it('dry-run использует collect, но не persist/адаптеры/миграции/внешние клиенты', async () => {
    const calls: string[] = [];
    const db = readOnlyPgRecorder(calls);

    const result = await dryRunAccountDeletion(db as any, {
      retentionMs: ACCOUNT_DELETION_RETENTION_MS,
    });

    expect(result).toEqual({
      accounts: 1,
      jobsByType: { 'account.core.purge': 1, 'product.purge': 1 },
      skipsByReason: { owner_unverifiable: 1 },
    });

    // План только СОБИРАЕТСЯ: никакой персистенции и исполнения.
    expect(persistSpy).not.toHaveBeenCalled();
    expect(getExecutorSpy).not.toHaveBeenCalled();
    // Внешние клиенты не вызываются.
    expect(storageDeleteSpy).not.toHaveBeenCalled();
    expect(leaveChatSpy).not.toHaveBeenCalled();
    expect(hostPollSpy).not.toHaveBeenCalled();

    // Весь SQL — только SELECT.
    expect(calls.length).toBeGreaterThan(0);
    for (const sql of calls) {
      expect(normalize(sql).toUpperCase().startsWith('SELECT')).toBe(true);
      expect(WRITE_WORDS_RE.test(sql)).toBe(false);
    }
  });

  it('существующий core.immediate → origin explicit: account.core.immediate вместо purge', async () => {
    const calls: string[] = [];
    const db = readOnlyPgRecorder(calls, { origin: 'explicit' });

    const result = await dryRunAccountDeletion(db as any, {
      retentionMs: ACCOUNT_DELETION_RETENTION_MS,
    });

    expect(result).toEqual({
      accounts: 1,
      jobsByType: { 'account.core.immediate': 1, 'product.purge': 1 },
      skipsByReason: { owner_unverifiable: 1 },
    });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('кандидатов нет → нулевая сводка одним запросом', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };

    const result = await dryRunAccountDeletion(db as any, { retentionMs: 1000 });

    expect(result).toEqual({ accounts: 0, jobsByType: {}, skipsByReason: {} });
    expect(calls.length).toBe(1);
  });
});

describe('parseDryRunArgs — CLI строго read-only (Task 21)', () => {
  it('пустой argv → дефолтный retention', () => {
    expect(parseDryRunArgs([])).toEqual({ retentionMs: ACCOUNT_DELETION_RETENTION_MS });
  });

  it('--retention-ms=N → явный retention', () => {
    expect(parseDryRunArgs(['--retention-ms=3600000'])).toEqual({ retentionMs: 3600000 });
    expect(parseDryRunArgs(['--retention-ms=0'])).toEqual({ retentionMs: 0 });
  });

  it('некорректный --retention-ms → ошибка', () => {
    expect(() => parseDryRunArgs(['--retention-ms=abc'])).toThrow();
    expect(() => parseDryRunArgs(['--retention-ms=-5'])).toThrow();
    expect(() => parseDryRunArgs(['--retention-ms='])).toThrow();
  });

  it('любой --apply → DryRunApplyError("dry-run only")', () => {
    expect(() => parseDryRunArgs(['--apply'])).toThrow(DryRunApplyError);
    expect(() => parseDryRunArgs(['--apply'])).toThrow(/dry-run only/);
    expect(() => parseDryRunArgs(['--retention-ms=1', '--apply'])).toThrow(DryRunApplyError);
    expect(() => parseDryRunArgs(['--apply', '--retention-ms=1'])).toThrow(DryRunApplyError);
  });

  it('неизвестный аргумент → ошибка', () => {
    expect(() => parseDryRunArgs(['--force'])).toThrow();
    expect(() => parseDryRunArgs(['apply'])).toThrow();
  });
});

describe('scripts/account-deletion-dry-run.ts — spawn без БД (Task 21)', () => {
  const repo = path.resolve(__dirname, '..', '..');

  it('--apply → код 2 и "dry-run only" в stderr, без подключения к БД', () => {
    // Прецедент — src/chat/relay-fs-key-map.spec.ts: ts-node spawn без Nest.
    // Аргументы разбираются ДО создания pg.Client: DATABASE_URL не нужен,
    // живая/прод БД в тесте не участвует.
    const res = spawnSync(process.execPath, [
      require.resolve('ts-node/dist/bin'),
      '-P', path.join(repo, 'tsconfig.json'),
      path.join(repo, 'scripts', 'account-deletion-dry-run.ts'),
      '--apply',
    ], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', TS_NODE_TRANSPILE_ONLY: '1' },
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('dry-run only');
    // T21-M1 (ревью Task 21): контракт отказа — «stdout ПУСТ», а не «нет
    // маркера»: отказная ветка не должна печатать ничего, даже частичную
    // сводку или предупреждение.
    expect(res.stdout).toBe('');
  });
});

/**
 * T21-I1 (ревью Task 21) — drift-guard рукописных зеркал.
 *
 * selectDeletionCandidates (account-deletion.dry-run.ts) повторяет
 * предикаты/cutoff/ORDER BY jobs.dueAccounts, readExistingOrigin —
 * побайтово jobs.originOf. Сейчас фрагменты идентичны, но правка одной
 * стороны молча разъехалась бы с другой, и прогноз dry-run (Gate C)
 * разошёлся бы с фактическим планом воркера. Guard читает оба источника
 * как текст и сравнивает нормализованные WHERE/ORDER-фрагменты: любое
 * расхождение предикатов, cutoff или порядка — красный тест. Единственное
 * разрешённое отличие dueAccounts — keyset-предикат курсора батча (у
 * dry-run курсора нет: прогноз выбирает всех кандидатов одной выборкой).
 * Номера параметров ($N) нормализуются: стороны сознательно нумеруют их
 * по-разному (у воркера есть LIMIT/курсор, у зеркала — только retention).
 */
describe('drift-guard: зеркала dry-run ↔ jobs (T21-I1)', () => {
  const jobsSource = readFileSync(
    path.join(__dirname, 'account-deletion.jobs.ts'), 'utf8',
  );
  const dryRunSource = readFileSync(
    path.join(__dirname, 'account-deletion.dry-run.ts'), 'utf8',
  );

  function extractSql(source: string, marker: string): string {
    const templates = source.match(/`[^`]*`/g) ?? [];
    const hits = templates.filter((template) => template.includes(marker));
    if (hits.length !== 1) {
      throw new Error(`SQL-шаблон по маркеру не найден или неоднозначен: ${marker}`);
    }
    return hits[0].slice(1, -1);
  }

  function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }

  function whereConditions(sql: string): string[] {
    const norm = normalizeSql(sql);
    const start = norm.indexOf(' WHERE ');
    if (start < 0) throw new Error('WHERE не найден');
    const rest = norm.slice(start + ' WHERE '.length);
    const end = rest.indexOf(' ORDER BY ');
    const body = end >= 0 ? rest.slice(0, end) : rest;
    return body.split(' AND ').map((clause) => clause.trim().replace(/\$\d+/g, '$'));
  }

  function orderByFragment(sql: string): string {
    const norm = normalizeSql(sql);
    const start = norm.indexOf(' ORDER BY ');
    if (start < 0) throw new Error('ORDER BY не найден');
    const rest = norm.slice(start + ' ORDER BY '.length);
    const end = rest.indexOf(' LIMIT ');
    return (end >= 0 ? rest.slice(0, end) : rest).trim();
  }

  it('originOf ↔ readExistingOrigin — идентичный нормализованный SQL', () => {
    const marker = "resource_type='account.core.immediate'";
    expect(normalizeSql(extractSql(dryRunSource, marker)))
      .toBe(normalizeSql(extractSql(jobsSource, marker)));
  });

  it('dueAccounts ↔ selectDeletionCandidates — те же предикаты (кроме keyset-курсора) и ORDER BY', () => {
    const worker = extractSql(jobsSource, 'deleted_at::text AS deleted_at_cursor');
    const dryRun = extractSql(dryRunSource, 'FROM user_id');
    const workerConditions = whereConditions(worker);
    const dryRunConditions = whereConditions(dryRun);

    // Каждый предикат зеркала (включая cutoff) присутствует у воркера.
    for (const condition of dryRunConditions) {
      expect(workerConditions).toContain(condition);
    }
    // Единственное отличие воркера — keyset-предикат курсора.
    const extra = workerConditions.filter((c) => !dryRunConditions.includes(c));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('(deleted_at,internal_id) >');

    expect(orderByFragment(dryRun)).toBe(orderByFragment(worker));
  });
});

const PG = process.env.PROVISIONING_PG_URL;
const maybePg = PG ? describe : describe.skip;
const SCHEMA = `account_deletion_dryrun_spec_${process.pid}`;

maybePg('dryRunAccountDeletion — BEGIN READ ONLY против настоящей Postgres (Task 21, PG)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 2,
      options: `-c search_path=${SCHEMA}`,
    });

    // user_id + account_deletion_jobs — настоящая миграция модуля
    // (прецедент — account-deletion.coordinator.pg.spec.ts).
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text,
        update_date timestamptz DEFAULT now()
      )
    `);
    await pool.query(readFileSync(
      'src/account-deletion/migrations/001_account_deletion.sql',
      'utf8',
    ));

    // Stub-набор таблиц discovery ВСЕГО каталога: колонки — ровно те, что
    // читают discovery-запросы 25 адаптеров. Пустые таблицы → jobs нет.
    await pool.query(`
      CREATE TABLE routine_pushes (id text PRIMARY KEY, user_id text);
      CREATE TABLE push_subscriptions (user_id text);
      CREATE TABLE tg_bot_configs (id text PRIMARY KEY, tg_chat_id text, owner_user_id text);
      CREATE TABLE custom_agents (id text PRIMARY KEY, owner_user_id text);
      CREATE TABLE products (
        id text PRIMARY KEY, slug text NOT NULL, host_id text,
        purged_at timestamptz, user_id text
      );
      CREATE TABLE calendar_connections (user_id text, provider text);
      CREATE TABLE calendar_proposals (id text PRIMARY KEY, user_id text, event jsonb);
      CREATE TABLE trip_calendars (user_id text);
      CREATE TABLE linkeon_tasks (user_id text);
      CREATE TABLE day_framing (user_id text);
      CREATE TABLE user_identities (user_id text, provider text, provider_refresh_token text);
      CREATE TABLE zoom_connections (user_id text);
      CREATE TABLE talerid_connections (user_id text);
      CREATE TABLE voice_calls (
        id text PRIMARY KEY, user_id text, room_name text, status text,
        external_bot_id text, transcript jsonb, summary text
      );
      CREATE TABLE meeting_rooms (code text, closed_at timestamptz);
      CREATE TABLE custom_chat_history (id serial PRIMARY KEY, session_id text, content text);
      CREATE TABLE generated_images (id bigserial PRIMARY KEY, user_id text);
      CREATE TABLE video_jobs (id uuid PRIMARY KEY, user_id text, kling_task_id text);
      CREATE TABLE speech_clips (id uuid PRIMARY KEY, user_id text);
      CREATE TABLE speech_listens (id uuid PRIMARY KEY, user_id text);
      CREATE TABLE user_voice (user_id text, elevenlabs_voice_id text);
      CREATE TABLE voice_call_jobs (call_id text, question text, answer text);
      CREATE TABLE action_plans (summary text, items jsonb);
      CREATE TABLE tasks (summary text, claudemd text);
      CREATE TABLE task_events (content text);
      CREATE TABLE smm_campaign (
        id uuid PRIMARY KEY, user_id text, is_linkeon_official boolean DEFAULT false
      );
      CREATE TABLE smm_social_account (user_id text);
      CREATE TABLE smm_oauth_state (user_id text);
      CREATE TABLE smm_billing_ledger (user_id text);
      CREATE TABLE smm_premium_generation (user_id text);
      CREATE TABLE smm_publication (video_id uuid, external_post_id text);
      CREATE TABLE smm_video (id uuid PRIMARY KEY, scenario_id uuid);
      CREATE TABLE smm_scenario (id uuid PRIMARY KEY, campaign_id uuid);
    `);

    // Сид: удалённое поколение (40 дней — за пределами retention), purged-
    // продукт (product.purge без stop) и tg-конфиг (telegram.stop+purge).
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ($1,'deleted', now() - interval '40 days', $2)`,
      ['u-dryrun-pg', randomUUID()],
    );
    await pool.query(
      `INSERT INTO products (id,slug,host_id,purged_at,user_id)
       VALUES ('p-pg-1','demo',NULL,now(),'u-dryrun-pg')`,
    );
    await pool.query(
      `INSERT INTO tg_bot_configs (id,tg_chat_id,owner_user_id)
       VALUES ('tg-pg-1','-1001','u-dryrun-pg')`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  async function tableCounts() {
    const r = await pool.query(`SELECT
      (SELECT count(*) FROM user_id)::int AS users,
      (SELECT count(*) FROM account_deletion_jobs)::int AS jobs,
      (SELECT count(*) FROM products)::int AS products,
      (SELECT count(*) FROM tg_bot_configs)::int AS tg`);
    return r.rows[0];
  }

  it('read-only транзакция: только SELECT, данные/схема/файлы не тронуты', async () => {
    const countsBefore = await tableCounts();
    const cwdBefore = readdirSync(process.cwd()).slice().sort();

    // Выделенный клиент с явной read-only транзакцией: любая попытка записи
    // (включая DDL) — ошибка сервера 25006, а не соглашение кода.
    const client = new Client({
      connectionString: PG,
      options: `-c search_path=${SCHEMA}`,
    });
    await client.connect();

    const calls: string[] = [];
    let recording = false;
    const db = {
      query: (sql: string, params?: any[]) => {
        // Рекордер собирает только planner-запросы после начала транзакции.
        if (recording) calls.push(sql);
        return client.query(sql, params as any[]);
      },
    };

    let summary: Awaited<ReturnType<typeof dryRunAccountDeletion>>;
    await client.query('BEGIN READ ONLY');
    try {
      recording = true;
      summary = await dryRunAccountDeletion(db, {
        retentionMs: ACCOUNT_DELETION_RETENTION_MS,
      });
    } finally {
      recording = false;
      await client.query('ROLLBACK');
      await client.end();
    }

    // Прогноз: кандидат один; core — merge-ветка (строк задач нет); продукт
    // purged → только purge; tg-конфиг → stop+purge. Полная карта jobsByType
    // сознательно НЕ фиксируется: gate-only discoverers в PG дают jobs при
    // пройденном gate, и полная фиксация связала бы тест со всеми 25
    // адаптерами (ловушка drift-тестов каталога).
    expect(summary.accounts).toBe(1);
    expect(summary.jobsByType['account.core.purge']).toBe(1);
    expect(summary.jobsByType['product.purge']).toBe(1);
    expect(summary.jobsByType['telegram.stop']).toBe(1);
    expect(summary.jobsByType['telegram.purge']).toBe(1);
    expect(summary.skipsByReason).toEqual({});

    // Весь SQL транзакции — SELECT (BEGIN/ROLLBACK — вне рекордера).
    expect(calls.length).toBeGreaterThan(0);
    for (const sql of calls) {
      expect(normalize(sql).toUpperCase().startsWith('SELECT')).toBe(true);
    }

    // Никаких изменений: строки четырёх контрольных таблиц, schema_migrations
    // (dry-run не запускает миграции) и состав cwd (отчёт не пишется файлом).
    expect(await tableCounts()).toEqual(countsBefore);
    const migrations = await pool.query(`SELECT to_regclass('schema_migrations') AS reg`);
    expect(migrations.rows[0].reg).toBeNull();
    expect(readdirSync(process.cwd()).slice().sort()).toEqual(cwdBefore);
  });
});
