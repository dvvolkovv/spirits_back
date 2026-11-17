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

const task = (id: string, created: string) => ({
  id, title: `задача ${id}`, summary: '', status: 'active',
  created_at: created, last_active_at: created, claudemd: '', embedding: null,
});

// Архивная задача с тем же вектором, что у реплики: сходство 1 — выше порога
// recall, так что в вывод она не попадёт только из-за точки.
const VEC = [1, 0, 0];
const archivedTask = (id: string, created: string) => ({
  ...task(id, created), status: 'archived', embedding: VEC,
});

describe('buildContextForPrompt: точка «Чистого листа»', () => {
  it('без точки — задачи как раньше', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет')).toContain('задача old');
  });

  it('с точкой — задачи до неё не показываются', async () => {
    const svc = svcWith(
      [task('old', '2026-11-10T00:00:00Z'), task('new', '2026-11-17T09:00:00Z')],
      [],
    );
    const out = await svc.buildContextForPrompt('u1', 'привет', { since: new Date('2026-11-17T00:00:00Z') });
    expect(out).toContain('задача new');
    expect(out).not.toContain('задача old');
  });

  it('с точкой и без новых задач — пусто', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], []);
    expect(await svc.buildContextForPrompt('u1', 'привет', { since: new Date('2026-11-17T00:00:00Z') })).toBe('');
  });

  it('с точкой и без новых задач — платный эмбеддинг реплики не запрашивается', async () => {
    const svc = svcWith([task('old', '2026-11-10T00:00:00Z')], [archivedTask('arch-old', '2026-11-01T00:00:00Z')], VEC);
    await svc.buildContextForPrompt('u1', 'привет', { since: new Date('2026-11-17T00:00:00Z') });
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
      .buildContextForPrompt('u1', 'помнишь тот проект?', { since: new Date('2026-11-17T00:00:00Z') });
    expect(after).toContain('задача arch-new');
    expect(after).not.toContain('задача arch-old');
  });
});
