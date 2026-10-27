/**
 * Накат миграции роликов — без базы. Живой повторный старт с открытой
 * пишущей транзакцией проверяет shorts.integration.spec.ts; здесь — то, что
 * живой прогон не видит: файл находится сервисом, катится при старте, его
 * форма не берёт лишних замков и не расходится с типами.
 */
import { ShortsSchemaService } from './shorts-schema.service';
import { ALLOWED_TRANSITIONS, SLOT_HOLDING_STATUSES, RUBRICS, ANGLES, YOUTUBE_MODES } from './shorts.types';
import { SETTINGS_DEFAULTS } from './shorts-settings.service';

async function applied(): Promise<string[]> {
  const queries: string[] = [];
  const pg = { query: jest.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }) };
  await new ShortsSchemaService(pg as any).onModuleInit();
  return queries.map((q) => q.replace(/--[^\n]*/g, ''));
}

async function appliedSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes('CREATE TABLE short_video'));
  if (!text) throw new Error('миграция 001 не применена');
  return text;
}

async function appliedSkitsSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes("hashtext('shorts/002')"));
  if (!text) throw new Error('миграция 002 не применена');
  return text;
}

async function appliedYoutubeSql(): Promise<string> {
  const text = (await applied()).find((q) => q.includes("hashtext('shorts/003')"));
  if (!text) throw new Error('миграция 003 не применена');
  return text;
}

describe('ShortsSchemaService', () => {
  it('катит 001 при старте модуля', async () => {
    expect(await appliedSql()).toContain('CREATE TABLE short_publication');
  });

  it('катит 002 после 001', async () => {
    const qs = await applied();
    const first = qs.findIndex((q) => q.includes('CREATE TABLE short_video'));
    const second = qs.findIndex((q) => q.includes("hashtext('shorts/002')"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('катит 003 после 002', async () => {
    const qs = await applied();
    const second = qs.findIndex((q) => q.includes("hashtext('shorts/002')"));
    const third = qs.findIndex((q) => q.includes("hashtext('shorts/003')"));
    expect(second).toBeGreaterThanOrEqual(0);
    expect(third).toBeGreaterThan(second);
  });

  it('не роняет старт, если база ответила ошибкой', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(new ShortsSchemaService(pg as any).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('текст 001_shorts.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/001'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый индекс — под IF to_regclass, а не голым CREATE INDEX IF NOT EXISTS', async () => {
    const sql = await appliedSql();
    const created = sql.match(/CREATE (UNIQUE )?INDEX/g) ?? [];
    const guarded = sql.match(/IF to_regclass\('public\.(uq|idx)_short_[a-z_]+'\) IS NULL THEN\s+CREATE (UNIQUE )?INDEX/g) ?? [];
    expect(created.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(created.length);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
  });

  it('слот держат ровно SLOT_HOLDING_STATUSES', async () => {
    const m = (await appliedSql()).match(/uq_short_video_slot ON short_video \(slot_at\)\s+WHERE status IN \(([^)]*)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
  });

  it('статусы в CHECK 001 — машина состояний без этапа animate', async () => {
    const m = (await appliedSql()).match(/status\s+text NOT NULL DEFAULT 'idea' CHECK \(status IN \(([\s\S]*?)\)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    const animate = ['animate_queued', 'animating'];
    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).filter((s) => !animate.includes(s)).sort());
  });

  it('строка настроек — под IF NOT EXISTS: обычный SELECT не ждёт чужую правку', async () => {
    expect(await appliedSql()).toMatch(/IF NOT EXISTS \(SELECT 1 FROM short_settings WHERE id = 1\) THEN\s+INSERT INTO short_settings/);
  });

  it('у каждой пары to_regclass/CREATE имя внутри to_regclass совпадает с именем создаваемого объекта, и незащищённых объектов нет', async () => {
    const sql = await appliedSql();
    const pairRe = /IF to_regclass\('public\.([a-zA-Z0-9_]+)'\) IS NULL THEN\s+CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s+([a-zA-Z0-9_]+)/g;
    const pairs = [...sql.matchAll(pairRe)].map((m) => [m[1], m[2]]);
    for (const [guarded, created] of pairs) {
      expect(created).toBe(guarded);
    }
    // Таблицы в этом файле защищены тем же to_regclass, что и индексы (другого
    // способа защиты в файле нет) — поэтому пары считаем по обоим видам
    // объектов и сверяем с общим числом CREATE TABLE/INDEX в файле.
    const totalCreated = (sql.match(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s+[a-zA-Z0-9_]+/g) ?? []).length;
    expect(pairs.length).toBe(totalCreated);
  });

  it('CHECK у rubric перечисляет ровно RUBRICS', async () => {
    const sql = await appliedSql();
    const m = sql.match(/rubric\s+text NOT NULL CHECK \(rubric IN \(([^)]*)\)\)/);
    const listed = (m?.[1].match(/'([a-z]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...RUBRICS].sort());
  });

  it('CHECK у angle перечисляет ровно ANGLES', async () => {
    const sql = await appliedSql();
    const m = sql.match(/CHECK \(angle IN \(([^)]*)\)\)/);
    const listed = (m?.[1].match(/'([a-z]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...ANGLES].sort());
  });
});

describe('текст 002_skits.sql', () => {
  it('весь файл — один DO-блок под своим advisory-локом и lock_timeout', async () => {
    const sql = (await appliedSkitsSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый ALTER TABLE — под проверкой каталога, без ADD COLUMN IF NOT EXISTS', async () => {
    const sql = await appliedSkitsSql();
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
    const adds = [...sql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)/g)];
    expect(adds.length).toBe(4);
    // Проверка каталога — той же таблицы и той же колонки, что добавляет ALTER под ней.
    for (const [, table, column] of adds) {
      expect(sql).toMatch(new RegExp(`table_name = '${table}' AND column_name = '${column}'\\) THEN\\s+ALTER TABLE ${table} ADD COLUMN ${column}`));
    }
    // CHECK статуса — по имени: определение читается под замком на таблицу.
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint\s+WHERE conrelid = 'public\.short_video'::regclass AND conname = 'short_video_status_002'\) THEN/);
  });

  it('новый CHECK статуса перечисляет ровно машину состояний', async () => {
    const m = (await appliedSkitsSql()).match(/ADD CONSTRAINT short_video_status_002 CHECK \(status IN \(([\s\S]*?)\)\)/);
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
  });

  it('формат ролика и настройки — только skit и chat; у ролика умолчание chat (формат пишет запуск), у настроек — skit', async () => {
    const sql = await appliedSkitsSql();
    expect(sql).toContain("ALTER TABLE short_video ADD COLUMN format text NOT NULL DEFAULT 'chat' CHECK (format IN ('skit', 'chat'));");
    expect(sql).not.toContain("SET DEFAULT 'skit'");
    expect(sql).toContain("ALTER TABLE short_settings ADD COLUMN format text NOT NULL DEFAULT 'skit'");
    expect(sql).toContain('ADD COLUMN max_omni_seconds int NOT NULL DEFAULT 48');
  });
});

describe('текст 003_youtube.sql', () => {
  it('весь файл — один DO-блок под advisory-локом и lock_timeout', async () => {
    const sql = (await appliedYoutubeSql()).trim();
    expect(sql.startsWith('DO $shorts$')).toBe(true);
    expect(sql.endsWith('$shorts$;')).toBe(true);
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('shorts/003'))");
    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
  });

  it('каждый ALTER TABLE — под проверкой information_schema, таблица — под to_regclass', async () => {
    const sql = await appliedYoutubeSql();
    const adds = [...sql.matchAll(/ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)/g)];
    expect(adds.map(([, t, c]) => `${t}.${c}`).sort()).toEqual(['short_publication.upload_session', 'short_settings.youtube_mode']);
    expect((sql.match(/ALTER TABLE/g) ?? []).length).toBe(adds.length);
    for (const [, table, column] of adds) {
      expect(sql).toMatch(
        new RegExp(
          `IF NOT EXISTS \\(SELECT 1 FROM information_schema\\.columns\\s+WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'\\) THEN\\s+ALTER TABLE ${table} ADD COLUMN ${column}`,
        ),
      );
    }
    expect(sql).toMatch(/IF to_regclass\('public\.short_youtube_account'\) IS NULL THEN\s+CREATE TABLE short_youtube_account/);
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
  });

  it('режимы в CHECK — ровно YOUTUBE_MODES, умолчание manual', async () => {
    const m = (await appliedYoutubeSql()).match(new RegExp(`youtube_mode text NOT NULL DEFAULT '${SETTINGS_DEFAULTS.youtubeMode}'\\s+CHECK \\(youtube_mode IN \\(([^)]*)\\)\\)`));
    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual([...YOUTUBE_MODES].sort());
  });
});
