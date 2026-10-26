import { ShortsDirectorService } from './shorts-director.service';
import { StageFatalError } from './short-jobs';
import { DIRECTOR_SKIT_SYSTEM, DIRECTOR_SYSTEM } from './short-prompts';
import { MAX_SKIT_REWRITES } from './shorts-director.service';
import { rowToShort } from './shorts.types';

const AGENTS = [
  { id: 10, name: 'Алексей', description: 'Юрист — помогает разобраться в правовых вопросах' },
  { id: 22, name: 'Кира', description: 'Дизайнер' },
  { id: 30, name: 'Полина', description: 'Врач — консультирует по вопросам здоровья' },
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

  it('новая сцена — новый круг сценариста: прошлые съёмка, сценарий, подписи, отзыв студии и счёт переписок сбрасываются', async () => {
    // «Переснять», просьба сценариста о другой сцене и повтор с этапа режиссёра идут через эту запись.
    const { svc, pg } = setup();
    await svc.direct(video({
      writer_rounds: 2, writer_feedback: 'озвучка 63 с — сократи',
      script: { hook: 'Старая зацепка', voice: 'v', speed: 1, lines: [], final: { assistantsCount: 9 } },
      captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'T', description: 'D', tags: [] } },
    }));
    const [sql] = pg.query.mock.calls[1] as any[];
    expect(sql).toMatch(/SET status = 'capture_queued'/);
    expect(sql).toMatch(/writer_rounds = 0/);
    expect(sql).toMatch(/writer_feedback = NULL/);
    expect(sql).toMatch(/script = NULL/);
    expect(sql).toMatch(/captions = NULL/);
    expect(sql).toMatch(/capture = NULL/);
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

  it('провокационная подача, ассистент не задан, режиссёр выбрал ассистента здоровья — отклоняем', async () => {
    const health = { ...REPLY, assistantId: 30 };
    const { svc, pg } = setup(health);
    await expect(svc.direct(video({ angle: 'roast', assistant_id: null }))).rejects.toThrow(
      'режиссёр: выбрал ассистента здоровья «Полина» для провокационной подачи — здоровье только в calm',
    );
    expect(pg.query.mock.calls.some((call: any[]) => String(call[0]).includes('capture_queued'))).toBe(false);
  });

  it('та же ситуация в спокойной подаче — проходит', async () => {
    const health = { ...REPLY, assistantId: 30 };
    const { svc } = setup(health);
    await expect(svc.direct(video({ angle: 'calm', assistant_id: null }))).resolves.toBeUndefined();
  });
});

describe('ShortsDirectorService.direct — ролик со сценками', () => {
  const SKIT = {
    cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
    setting: 'a rented flat hallway, a tiny scuff on the wallpaper',
    opening: 'The goose stands in the doorway, the capybara holds a suitcase.',
    action: 'The goose points a wing at the scuff and hisses. The capybara takes out a phone.',
    lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
  };
  const LONG = { ...SKIT, lines: [{ hero: 'galina', text: 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.' }] };

  function skitSetup(replies: any[]) {
    const queue = [...replies];
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("scene->>'question'")) return { rows: [{ q: 'Вопрос из прошлого ролика' }] };
        if (sql.includes("scene->'skit'")) return { rows: [{ skit: { ...SKIT, setting: 'a kitchen', action: 'The cat stamps a paper.' } }, { skit: null }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const relay = { ask: jest.fn(async () => JSON.stringify(queue.shift())) };
    const agents = { getAgents: jest.fn(async () => AGENTS) };
    return { svc: new ShortsDirectorService(pg as any, relay as any, agents as any), pg, relay };
  }

  it('сцена и сценка 1 — из одного ответа; системный промпт сценок, прошлые сценки — режиссёру', async () => {
    const { svc, pg, relay } = skitSetup([{ ...REPLY, skit: SKIT }]);
    await svc.direct(video({ format: 'skit' }));
    const [system, message] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(DIRECTOR_SKIT_SYSTEM);
    expect(message).toContain('<<<СЦЕНКИ\n- a kitchen — The cat stamps a paper.\nСЦЕНКИ>>>');
    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
    expect(JSON.parse(update[1][1]).skit).toEqual(SKIT);
    // Прошлые сценки — только у роликов, где они есть.
    expect(pg.query.mock.calls.find(([sql]: [string]) => sql.includes("scene->'skit'"))[0]).toContain("scene ? 'skit'");
  });

  it('сценка нарушила правила — переписка с перечнем и прошлым вариантом; второй вариант записан', async () => {
    const { svc, pg, relay } = skitSetup([{ ...REPLY, skit: LONG }, { ...REPLY, skit: SKIT }]);
    await svc.direct(video({ format: 'skit' }));
    expect(relay.ask).toHaveBeenCalledTimes(2);
    const second = relay.ask.mock.calls[1][1] as string;
    expect(second).toContain('Сценка нарушила правила — исправь:\n- сценка 1 (конфликт): правило 17: реплика 1 — 13 слов, больше 12');
    expect(second).toContain('<<<СЦЕНКА 1\n');
    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
    expect(JSON.parse(update[1][1]).skit).toEqual(SKIT);
  });

  it(`нарушения и после ${MAX_SKIT_REWRITES} переписок — StageFatalError, ролик не записан`, async () => {
    const { svc, pg, relay } = skitSetup(Array.from({ length: MAX_SKIT_REWRITES + 1 }, () => ({ ...REPLY, skit: LONG })));
    await expect(svc.direct(video({ format: 'skit' }))).rejects.toThrow(StageFatalError);
    expect(relay.ask).toHaveBeenCalledTimes(MAX_SKIT_REWRITES + 1);
    expect(pg.query.mock.calls.some(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"))).toBe(false);
  });

  it('ответ без сценки у ролика со сценками — ошибка разбора (повтор этапа), а не сцена без сценки', async () => {
    const { svc } = skitSetup([REPLY]);
    await expect(svc.direct(video({ format: 'skit' }))).rejects.toThrow(/режиссёр: skit — объект/);
  });

  it('ролик «Только чат» — без сценки, без запроса прошлых сценок, прежний промпт', async () => {
    const { svc, pg, relay } = skitSetup([REPLY]);
    await svc.direct(video({ format: 'chat' }));
    expect(relay.ask.mock.calls[0][0]).toBe(DIRECTOR_SYSTEM);
    expect(pg.query.mock.calls.some(([sql]: [string]) => sql.includes("scene->'skit'"))).toBe(false);
    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
    expect('skit' in JSON.parse(update[1][1])).toBe(false);
  });
});
