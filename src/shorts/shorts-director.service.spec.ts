import { ShortsDirectorService } from './shorts-director.service';
import { StageFatalError } from './short-jobs';
import { DIRECTOR_SYSTEM } from './short-prompts';
import { rowToShort } from './shorts.types';

const AGENTS = [
  { id: 10, name: 'Алексей', description: 'Юрист — помогает разобраться в правовых вопросах' },
  { id: 22, name: 'Кира', description: 'Дизайнер' },
];
const REPLY = {
  assistantId: 10,
  question: 'Хозяин квартиры не возвращает залог — что делать?',
  followups: ['Москва, договор на 11 месяцев'],
  title: 'Залог при аренде',
};

function video(over: Record<string, any> = {}) {
  return rowToShort({
    id: 'ab12cd34-0000-4000-8000-000000000000', rubric: 'assistant', angle: 'uncomfortable', source: 'catalog',
    topic_key: 'assistant-10', topic_hint: 'Ассистент «Алексей»', assistant_id: 10, status: 'directing', attempts: 1,
    ...over,
  });
}

function setup(reply: any = REPLY, updated = 1) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("scene->>'question'")) return { rows: [{ q: 'Вопрос из прошлого ролика' }] };
      return { rows: [], rowCount: updated };
    }),
  };
  const relay = { ask: jest.fn(async () => (typeof reply === 'string' ? reply : JSON.stringify(reply))) };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  return { svc: new ShortsDirectorService(pg as any, relay as any, agents as any), pg, relay, agents };
}

describe('ShortsDirectorService.direct', () => {
  it('сцена из ответа режиссёра, ролик — в очередь съёмки', async () => {
    const { svc, pg, relay } = setup();
    await svc.direct(video());

    const [system, message, sessionId] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(DIRECTOR_SYSTEM);
    expect(message).toContain('Ассистент задан: 10 — Алексей');
    expect(message).toContain('- Вопрос из прошлого ролика');
    expect(sessionId).toMatch(/^short-direct-ab12cd34-0000-4000-8000-000000000000-[0-9a-f-]{36}$/);

    const [sql, params] = pg.query.mock.calls[1] as any[];
    expect(sql).toMatch(/SET status = 'capture_queued'/);
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'directing' AND attempts = \$6/);
    expect(params[5]).toBe(1);
    expect(JSON.parse(params[1])).toEqual({
      kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: REPLY.question, followups: REPLY.followups,
    });
    expect(params[2]).toBe(10);
    expect(params[3]).toBe('zalog_pri_arende_ab12');
    expect(params[4]).toBe('Залог при аренде');
  });

  it('слаг уже есть — не меняется (метки ролика постоянны)', async () => {
    const { svc, pg } = setup();
    await svc.direct(video({ slug: 'old_slug_ab12' }));
    expect((pg.query.mock.calls[1] as any[])[1][3]).toBe('old_slug_ab12');
  });

  it('пересъёмка: прошлый вопрос и замечания уходят режиссёру', async () => {
    const { svc, relay } = setup();
    await svc.direct(video({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Старый вопрос', followups: [] },
      owner_note: 'Сценарист: нужен вопрос про субаренду',
    }));
    const message = (relay.ask.mock.calls[0] as any[])[1];
    expect(message).toContain('придумай другую:\n<<<ВОПРОС\nСтарый вопрос\nВОПРОС>>>');
    expect(message).toContain('нужен вопрос про субаренду');
  });

  it('ассистент темы больше не активен — фатально, повтор не поможет', async () => {
    const { svc } = setup();
    await expect(svc.direct(video({ assistant_id: 99 }))).rejects.toBeInstanceOf(StageFatalError);
  });

  it('кривой ответ режиссёра — обычная ошибка: этап повторится', async () => {
    const { svc } = setup('Извините, не могу');
    await expect(svc.direct(video())).rejects.toThrow(/режиссёр: не нашёл JSON/);
  });

  it('ролик ушёл из directing, пока думал режиссёр — без ошибки', async () => {
    const { svc } = setup(REPLY, 0);
    await expect(svc.direct(video())).resolves.toBeUndefined();
  });
});
