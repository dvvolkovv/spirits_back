import { BacklogService, shouldCreateBlogTopic, blogTopicFromBacklog } from './backlog.service';

describe('shouldCreateBlogTopic', () => {
  it('переход в done рождает тему', () => {
    expect(shouldCreateBlogTopic('in_progress', 'done')).toBe(true);
  });

  it('done → done повторно тему не рождает', () => {
    expect(shouldCreateBlogTopic('done', 'done')).toBe(false);
  });

  it('переход в любой другой статус тему не рождает', () => {
    expect(shouldCreateBlogTopic('proposed', 'approved')).toBe(false);
    expect(shouldCreateBlogTopic('in_progress', 'rejected')).toBe(false);
  });

  it('отсутствие прежнего статуса не рождает тему', () => {
    expect(shouldCreateBlogTopic(undefined, 'done')).toBe(false);
  });
});

describe('blogTopicFromBacklog', () => {
  it('подсказка собирается из заголовка и анализа', () => {
    const t = blogTopicFromBacklog('id1', 'Голосовой ввод', 'Длинный анализ фичи');
    expect(t.sourceRef).toBe('backlog:id1');
    expect(t.topicHint).toContain('Голосовой ввод');
    expect(t.topicHint).toContain('Длинный анализ');
  });

  it('анализ обрезается до 500 символов — в промпт не нужен весь отчёт', () => {
    const t = blogTopicFromBacklog('id1', 'Т', 'я'.repeat(2000));
    expect(t.topicHint.length).toBeLessThan(700);
  });

  it('пустой анализ не ломает подсказку', () => {
    expect(blogTopicFromBacklog('id1', 'Заголовок', '').topicHint).toContain('Заголовок');
  });
});

/**
 * Врезка в update(). Чистые хелперы выше ничего не говорят о том, вызваны ли
 * они вообще: вырежи весь блок из update() — и они останутся зелёными. Здесь
 * проверяется сама проводка.
 */
describe('update(): врезка темы для блога', () => {
  function makeService(prevStatus: string, nextStatus: string) {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const pg: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (/SELECT status, title, from_ticket_id/.test(sql)) {
          return { rows: [{ status: prevStatus, title: 'Старое имя', from_ticket_id: null }] };
        }
        if (/UPDATE backlog_items/.test(sql)) {
          return {
            rows: [{
              id: 'b-1', title: 'Голосовой ввод', analysis_md: 'Анализ фичи',
              status: nextStatus,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const svc = new BacklogService(pg, {} as any);
    return { svc, pg, queries, inserts: () => queries.filter((q) => /INSERT INTO blog_post/.test(q.sql)) };
  }

  it('закрытие задачи заводит тему в blog_post', async () => {
    const { svc, inserts } = makeService('in_progress', 'done');
    await svc.update('b-1', { status: 'done' as any });

    const ins = inserts();
    expect(ins).toHaveLength(1);
    expect(ins[0].params).toEqual(['backlog:b-1', 'голосовой-ввод', expect.stringContaining('Голосовой ввод')]);
    expect(ins[0].sql).toMatch(/'news'/);
    expect(ins[0].sql).toMatch(/'backlog'/);
    expect(ins[0].sql).toMatch(/'idea'/);
  });

  it('обычная правка уже закрытой задачи темы не плодит', async () => {
    const { svc, inserts } = makeService('done', 'done');
    await svc.update('b-1', { title: 'Голосовой ввод' });
    expect(inserts()).toHaveLength(0);
  });

  it('переход не в done темы не заводит', async () => {
    const { svc, inserts } = makeService('proposed', 'approved');
    await svc.update('b-1', { status: 'approved' as any });
    expect(inserts()).toHaveLength(0);
  });

  /**
   * Итем могут вернуть в работу и закрыть повторно — второго анонса в канале
   * быть не должно. Дедупликация BlogTopicService по topic_key здесь не
   * спасает: у неё окно 90 дней, а бэклог-итем живёт дольше. Защита — в самом
   * INSERT, по source_ref.
   */
  it('повторное закрытие защищено NOT EXISTS по source_ref', async () => {
    const { svc, inserts } = makeService('in_progress', 'done');
    await svc.update('b-1', { status: 'done' as any });

    const sql = inserts()[0].sql.replace(/\s+/g, ' ');
    expect(sql).toMatch(/WHERE NOT EXISTS \( SELECT 1 FROM blog_post WHERE source_ref = \$1 \)/);
    // Именно $1 — тот же плейсхолдер, что и у вставляемого source_ref.
    expect(inserts()[0].params[0]).toBe('backlog:b-1');
  });

  it('падение вставки темы не роняет закрытие задачи', async () => {
    const { svc, pg } = makeService('in_progress', 'done');
    const orig = pg.query;
    pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO blog_post/.test(sql)) throw new Error('blog_post не существует');
      return orig(sql, params);
    });

    const updated = await svc.update('b-1', { status: 'done' as any });
    expect(updated.status).toBe('done');
  });
});
