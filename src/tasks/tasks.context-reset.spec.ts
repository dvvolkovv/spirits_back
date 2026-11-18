import { TasksService } from './tasks.service';

/**
 * «Чистый лист» (spec 2026-11-17-context-reset): после точки ассистент видит
 * только задачи, созданные позже неё. Таблица tasks общая для всех ассистентов
 * (колонки ассистента нет), поэтому отсечка — по created_at, через afterReset.
 *
 * pg — первый параметр конструктора TasksService; listActive и выборка
 * архивных различаются по условию на status в SQL. embed — приватный метод
 * сервиса (OpenAI), подменяется на экземпляре.
 */
function svcWith(active: any[], archived: any[], qVec: number[] | null = null) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/status = 'active'/.test(sql)) return { rows: active };
      if (/status = 'archived'/.test(sql)) return { rows: archived };
      return { rows: [] };
    }),
  };
  const svc = new TasksService(pg as any);
  // Без ключа OpenAI (qVec = null) ранжирования нет — активные идут по
  // свежести, recall архивных не делается.
  (svc as any).embed = jest.fn(async () => qVec);
  return svc;
}

// created_at — строка или Date: на проде pg отдаёт timestamptz как Date.
const task = (id: string, created: string | Date, embedding: number[] | null = null) => ({
  id, title: `задача ${id}`, summary: '', status: 'active',
  created_at: created, last_active_at: created, claudemd: '', embedding,
});

// Тот же вектор, что у реплики: сходство 1 — выше порога recall и первое
// место в ранжировании. ORTHO — сходство 0.
const VEC = [1, 0, 0];
const ORTHO = [0, 1, 0];
const archivedTask = (id: string, created: string) => ({
  ...task(id, created), status: 'archived', embedding: VEC,
});

const RESET = new Date('2026-11-17T00:00:00Z');

describe('buildContextForPrompt: точка «Чистого листа»', () => {
  it('без точки — задачи как раньше', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет')).toContain('задача old');
    // Так отвечает сервис точки, когда пользователь её не ставил.
    expect(await svc.buildContextForPrompt('u1', 'привет', { since: null })).toContain('задача old');
  });

  it('с точкой — задачи до неё не показываются', async () => {
    const svc = svcWith(
      [
        task('old', '2026-11-10T00:00:00Z'),
        task('old-date', new Date('2026-11-16T23:59:59Z')),
        task('new', '2026-11-17T09:00:00Z'),
        task('new-date', new Date('2026-11-17T00:00:01Z')),
      ],
      [],
    );
    const out = await svc.buildContextForPrompt('u1', 'привет', { since: RESET });
    expect(out).toContain('задача new');
    expect(out).toContain('задача new-date');
    expect(out).not.toContain('задача old');
  });

  it('с точкой и без новых задач — пусто', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет', { since: RESET })).toBe('');
  });

  it('с точкой и без новых задач — платный эмбеддинг реплики не запрашивается', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], [archivedTask('arch-old', '2026-11-01T00:00:00Z')], VEC);
    await svc.buildContextForPrompt('u1', 'привет', { since: RESET });
    expect((svc as any).embed).not.toHaveBeenCalled();
  });

  it('архивные: без точки recall поднимает обе, с точкой — только созданную после неё', async () => {
    const archived = [
      archivedTask('arch-old', '2026-11-01T00:00:00Z'),
      archivedTask('arch-new', '2026-11-17T09:00:00Z'),
    ];

    // Контроль: фикстура действительно проходит порог recall.
    const before = await svcWith([], archived, VEC).buildContextForPrompt('u1', 'помнишь тот проект?');
    expect(before).toContain('задача arch-old');
    expect(before).toContain('задача arch-new');

    const after = await svcWith([], archived, VEC)
      .buildContextForPrompt('u1', 'помнишь тот проект?', { since: RESET });
    expect(after).toContain('задача arch-new');
    expect(after).not.toContain('задача arch-old');
  });

  describe('старые задачи не вытесняют новую из топ-5 (фильтр — до ранжирования)', () => {
    // Шесть старых — больше TOP_ACTIVE; новая последней, как самая
    // «неудачная» и по сходству, и по месту в выборке.
    const olds = [1, 2, 3, 4, 5, 6].map((n) => task(`old${n}`, '2026-11-10T00:00:00Z', VEC));
    const fresh = task('new', '2026-11-17T09:00:00Z', ORTHO);

    it('ветка ранжирования по сходству', async () => {
      // Контроль: без точки новая в топ-5 не проходит.
      const before = await svcWith([...olds, fresh], [], VEC).buildContextForPrompt('u1', 'про проект');
      expect(before).not.toContain('задача new');

      const out = await svcWith([...olds, fresh], [], VEC).buildContextForPrompt('u1', 'про проект', { since: RESET });
      expect(out).toContain('задача new');
      expect(out).not.toContain('задача old');
    });

    it('ветка по свежести (без вектора)', async () => {
      const before = await svcWith([...olds, fresh], [], null).buildContextForPrompt('u1', 'про проект');
      expect(before).not.toContain('задача new');

      const out = await svcWith([...olds, fresh], [], null).buildContextForPrompt('u1', 'про проект', { since: RESET });
      expect(out).toContain('задача new');
      expect(out).not.toContain('задача old');
    });
  });

  it('после точки 1–5 новых активных и нет архивных — эмбеддинг не запрашивается', async () => {
    const svc = svcWith(
      [task('old', '2026-11-10T00:00:00Z', VEC), task('new1', '2026-11-17T09:00:00Z'), task('new2', '2026-11-17T10:00:00Z')],
      [],
      VEC,
    );
    const out = await svc.buildContextForPrompt('u1', 'про проект', { since: RESET });
    expect(out).toContain('задача new1');
    expect(out).toContain('задача new2');
    expect((svc as any).embed).not.toHaveBeenCalled();
  });

  it('без точки, когда вектор нужен, эмбеддинг запрашивается как раньше', async () => {
    // Больше TOP_ACTIVE активных — ранжирование по сходству.
    const many = svcWith([1, 2, 3, 4, 5, 6].map((n) => task(`t${n}`, '2026-11-10T00:00:00Z', VEC)), [], VEC);
    await many.buildContextForPrompt('u1', 'про проект');
    expect((many as any).embed).toHaveBeenCalledWith('про проект');

    // Архивная с эмбеддингом — recall.
    const recall = svcWith([task('a', '2026-11-10T00:00:00Z')], [archivedTask('arch', '2026-11-01T00:00:00Z')], VEC);
    await recall.buildContextForPrompt('u1', 'про проект');
    expect((recall as any).embed).toHaveBeenCalledWith('про проект');
  });
});

/**
 * Гонка извлечения: extractFromTurn идёт в фоне после ответа, до вставки
 * задачи проходят секунды–десятки секунд (Haiku, эмбеддинг). Задача из хода
 * до точки, вставленная после неё, не должна всплыть после точки — её
 * created_at обязан быть моментом хода.
 */
describe('extractFromTurn: created_at задачи — момент хода', () => {
  /** Проходит shouldSkipTaskExtraction: длиннее 25 символов, проектные слова. */
  const TASK_MESSAGE = 'нужно обсудить запуск Telegram-бота, дедлайн в пятницу';
  const CREATE = '{"action":"create","title":"Запуск бота","summary":"s","claudemd":"c","firstEventContent":"e"}';

  function extractHarness() {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        queries.push({ sql: s, params });
        if (s.startsWith('SELECT 1 FROM user_id')) return { rows: [{ n: 1 }], rowCount: 1 };
        if (s.startsWith('INSERT INTO tasks')) return { rows: [{ id: 'task-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    // LLM-мок — ClaudeCliService.text, как в tasks-account-deletion.adapter.spec.ts.
    const claude = { text: jest.fn(async () => CREATE) };
    const svc = new TasksService(pg as any, claude as any);
    (svc as any).embed = jest.fn(async () => null);
    return { svc, queries };
  }

  /**
   * Значение, которое INSERT INTO tasks пишет в колонку: выражение из VALUES
   * на позиции колонки; если в нём ровно один $N — подставляется параметр.
   */
  function insertedCreatedAt(queries: Array<{ sql: string; params: any[] }>) {
    const q = queries.find((x) => x.sql.startsWith('INSERT INTO tasks'));
    expect(q).toBeDefined();
    const m = /^INSERT INTO tasks \(([^)]*)\) VALUES \((.*)\) RETURNING/.exec(q!.sql);
    expect(m).not.toBeNull();
    const cols = m![1].split(',').map((c) => c.trim());
    const vals: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of m![2]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { vals.push(cur.trim()); cur = ''; } else cur += ch;
    }
    vals.push(cur.trim());
    const i = cols.indexOf('created_at');
    expect(i).toBeGreaterThanOrEqual(0);
    const expr = vals[i];
    const ref = /\$(\d+)/.exec(expr);
    return { expr, param: ref ? q!.params[Number(ref[1]) - 1] : undefined };
  }

  it('turnAt передан — created_at = момент хода, а не фоновой вставки', async () => {
    const { svc, queries } = extractHarness();
    const turnAt = new Date('2026-11-16T23:59:50Z');
    await svc.extractFromTurn('u1', '1', TASK_MESSAGE, 'ответ', turnAt);
    const { expr, param } = insertedCreatedAt(queries);
    expect(expr).toMatch(/now\(\)/); // запасное значение — now()
    expect(param).toBe(turnAt);
  });

  it('без turnAt — created_at по-прежнему now()', async () => {
    const { svc, queries } = extractHarness();
    await svc.extractFromTurn('u1', '1', TASK_MESSAGE, 'ответ');
    const { expr, param } = insertedCreatedAt(queries);
    expect(expr).toMatch(/now\(\)/);
    expect(param ?? null).toBeNull();
  });

  it('нечитаемый turnAt — created_at = now(), извлечение не падает', async () => {
    const { svc, queries } = extractHarness();
    await svc.extractFromTurn('u1', '1', TASK_MESSAGE, 'ответ', new Date('не дата'));
    const { param } = insertedCreatedAt(queries);
    expect(param ?? null).toBeNull();
  });
});
