import { MAX_RECAPTURES, ShortsWriterService } from './shorts-writer.service';
import { StageFatalError } from './short-jobs';
import { WRITER_SKIT_SYSTEM, WRITER_SYSTEM } from './short-prompts';
import { planSkits } from './short-skit-prompts';
import { rowToShort } from './shorts.types';

const PARAGRAPHS = [
  { n: 1, text: 'Залог возвращается в течение 7 дней после выезда.' },
  { n: 2, text: 'Опасная фраза: «залог не возвращается при досрочном выезде».' },
  { n: 3, text: 'Нормальный износ не является повреждением — впишите это в договор.' },
];
const GOOD = {
  hook: 'Хозяин может оставить залог себе?',
  hookBox: 2,
  question: 'Я Алексей, юрист. Меня спросили, как снять квартиру и не потерять залог при выезде.',
  lines: [
    { box: 2, text: 'Ищите в договоре опасную фразу: «залог не возвращается при досрочном выезде». Увидели — просите переписать этот пункт.' },
    { box: 3, text: 'Впишите прямо: нормальный износ не является повреждением. Тогда за потёртый пол и выцветшие обои удержать деньги не получится.' },
    { box: 1, text: 'И договоритесь о сроке: залог возвращается в течение 7 дней после выезда — так и запишите в договоре аренды.' },
  ],
  captions: {
    telegram: 'Юрист разобрал, как не потерять залог при аренде.',
    vk: '',
    youtube: { title: 'Как не потерять залог при аренде', description: 'Три пункта договора, которые сберегут залог.', tags: ['аренда', 'залог'] },
  },
};
// 18 активных ассистентов: число в финале — из этого списка.
const AGENTS = [{ id: 10, name: 'Алексей', description: 'Юрист' }, ...Array.from({ length: 17 }, (_, i) => ({ id: 100 + i, name: `А${i}`, description: '' }))];

function video(over: Record<string, any> = {}) {
  return rowToShort({
    id: 'ab12cd34-0000-4000-8000-000000000000', rubric: 'assistant', angle: 'uncomfortable', source: 'catalog',
    topic_key: 'assistant-10', title: 'Залог при аренде', slug: 'zalog_ab12', assistant_id: 10, status: 'writing', attempts: 1,
    scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Как не потерять залог?', followups: [] },
    capture: { paragraphs: PARAGRAPHS, answerText: PARAGRAPHS.map((p) => p.text).join('\n'), boxes: [] },
    ...over,
  });
}

function setup(replies: any[]) {
  const queue = [...replies];
  const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
  const relay = { ask: jest.fn(async () => JSON.stringify(queue.shift())) };
  const agents = { getAgents: jest.fn(async () => AGENTS) };
  const settings = { get: jest.fn(async () => ({ narratorVoice: 'alena' })) };
  return { svc: new ShortsWriterService(pg as any, relay as any, agents as any, settings as any), pg, relay };
}

describe('ShortsWriterService.write', () => {
  const OLD = process.env.SHORTS_LINK_BASE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SHORTS_LINK_BASE;
    else process.env.SHORTS_LINK_BASE = OLD;
  });

  it('честный ответ — сценарий и подписи, ролик в очередь сборки', async () => {
    process.env.SHORTS_LINK_BASE = 'https://test.linkeon.io';
    const { svc, pg, relay } = setup([GOOD]);
    await svc.write(video());

    const [system, message, sessionId] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(WRITER_SYSTEM);
    expect(message).toContain('[2] Опасная фраза');
    expect(sessionId).toMatch(/^short-write-ab12cd34-0000-4000-8000-000000000000-[0-9a-f-]{36}$/);

    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/SET status = \$6/);
    expect(params[5]).toBe('render_queued');
    expect(sql).toMatch(/writer_rounds = writer_rounds \+ 1/);
    const script = JSON.parse(params[1]);
    expect(script.voice).toBe('madirus');
    expect(script.lines[script.lines.length - 1]).toEqual({ id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' });
    expect(script.final).toEqual({ assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' });
    const captions = JSON.parse(params[2]);
    expect(captions.telegram).toContain('https://test.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_zalog_ab12');
    expect(captions.youtube.description).toContain('utm_source=youtube');
  });

  it('нарушение правил — переписка с перечнем, второй вариант проходит', async () => {
    const bad = { ...GOOD, captions: { ...GOOD.captions, telegram: 'Попробуйте бесплатно!' } };
    const { svc, pg, relay } = setup([bad, GOOD]);
    await svc.write(video());
    expect(relay.ask).toHaveBeenCalledTimes(2);
    expect((relay.ask.mock.calls[1] as any[])[1]).toMatch(/нарушил правила — исправь:\n- правило 6/);
    // Отвергнутый вариант — перед сценаристом: в первом запросе прошлого нет, во втором он есть,
    // целиком — с метками реплик и подписями, на которые ссылаются нарушения.
    expect((relay.ask.mock.calls[0] as any[])[1]).not.toContain('Прошлый вариант:');
    const second = (relay.ask.mock.calls[1] as any[])[1];
    expect(second).toContain('Прошлый вариант:');
    expect(second).toContain('a1 [');
    expect(second).toContain('подпись telegram: Попробуйте бесплатно!');
    expect((pg.query.mock.calls[0] as any[])[1][5]).toBe('render_queued');
  });

  it('первый круг после отзыва студии — прошлый сценарий из базы, без его подписей (они уже с хвостом)', async () => {
    const { svc, relay } = setup([GOOD]);
    const script = { hook: 'Старая зацепка', voice: 'madirus', speed: 1.1, lines: [{ id: 'a1', scene: 'answer', box: 1, text: 'Старая реплика' }], final: { assistantsCount: 18 } };
    await svc.write(video({ script, captions: { telegram: 'Старая подпись\n\nhttps://ссылка', vk: '', youtube: { title: 'T', description: '', tags: [] } }, writer_feedback: 'Озвучка заняла 63 с' }));
    const first = (relay.ask.mock.calls[0] as any[])[1];
    expect(first).toContain('a1 [1]: Старая реплика');
    expect(first).toContain('Студия: Озвучка заняла 63 с');
    expect(first).not.toContain('подпись telegram:');
  });

  it('три варианта подряд с нарушениями — фатально, без записи', async () => {
    const bad = { ...GOOD, captions: { ...GOOD.captions, telegram: 'Попробуйте бесплатно!' } };
    const { svc, pg } = setup([bad, bad, bad]);
    await expect(svc.write(video())).rejects.toBeInstanceOf(StageFatalError);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('просит переснять — ролик к режиссёру с причиной в замечаниях', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    await svc.write(video({ owner_note: 'про субаренду' }));
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/SET status = 'directing'/);
    // Новая сцена — новый круг: отзыв студии о прошлой озвучке и счёт её переписок — заново.
    expect(sql).toMatch(/writer_feedback = NULL/);
    expect(sql).toMatch(/writer_rounds = 0/);
    expect(params[1]).toBe('про субаренду\nСценарист: нужен вопрос про субаренду');
  });

  it('уже дважды просил другую сцену — третий раз фатально, без записи', async () => {
    expect(MAX_RECAPTURES).toBe(2);
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    const note = 'про субаренду\nСценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду';
    const err = await svc.write(video({ owner_note: note })).catch((e) => e);
    expect(err).toBeInstanceOf(StageFatalError);
    expect(err.message).toBe('сценарист: уже дважды просил другую сцену — нужен взгляд владельца; последняя причина: нужен вопрос про субаренду');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('новое замечание владельца после просьб сценариста — счёт просьб заново', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    const note = 'Сценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду\nсделайте про субаренду с животными';
    await svc.write(video({ owner_note: note }));
    expect((pg.query.mock.calls[0] as any[])[0]).toMatch(/SET status = 'directing'/);
  });

  it('реальный кейс — с подписью в кадре вопроса', async () => {
    const { svc, pg } = setup([GOOD]);
    await svc.write(video({ rubric: 'case' }));
    expect(JSON.parse((pg.query.mock.calls[0] as any[])[1][1]).badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
  });

  it('нет съёмки — фатально', async () => {
    const { svc } = setup([GOOD]);
    await expect(svc.write(video({ capture: null }))).rejects.toBeInstanceOf(StageFatalError);
  });
});

describe('ShortsWriterService.write — ролик со сценками', () => {
  const CONFLICT = {
    cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
    setting: 'a rented flat hallway, a tiny scuff on the wallpaper',
    opening: 'The goose stands in the doorway, the capybara holds a suitcase.',
    action: 'The goose points a wing at the scuff and hisses. The capybara takes out a phone.',
    lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
  };
  const PUNCHLINE = {
    cast: [{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }],
    setting: 'the same hallway',
    opening: 'The capybara holds up the phone, the goose freezes.',
    action: 'The capybara speaks calmly, the goose drops the keys and lowers her wings.',
    lines: [{ hero: 'kesha', text: 'Нормальный износ — не повреждение. Залог верните.', box: 3 }, { hero: 'galina', text: 'Га-га… ладно.' }],
  };
  const SKIT_GOOD = {
    hook: 'Весь залог — за потёртые обои?',
    hookBox: 3,
    question: 'Я Алексей, юрист. Меня спросили, может ли хозяйка оставить весь залог себе.',
    lines: [{ box: 3, text: 'Нормальный износ не является повреждением — впишите это в договор аренды.' }],
    punchline: PUNCHLINE,
    captions: GOOD.captions,
  };
  const skitVideo = (over: Record<string, any> = {}) =>
    video({ format: 'skit', scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Как не потерять залог?', followups: [], skit: CONFLICT }, ...over });

  it('развязка и промпты обеих сценок — в сценарии; ролик — на оживление, а не на сборку', async () => {
    const { svc, pg, relay } = setup([SKIT_GOOD]);
    await svc.write(skitVideo());
    const [system, message] = relay.ask.mock.calls[0] as any[];
    expect(system).toBe(WRITER_SKIT_SYSTEM);
    expect(message).toContain('Сценка 1 (конфликт) — открывает ролик:\n<<<СЦЕНКА 1\ncast: galina — хозяйка квартиры, kesha — жилец');
    const [, params] = pg.query.mock.calls[0] as any[];
    expect(params[5]).toBe('animate_queued');
    const script = JSON.parse(params[1]);
    expect(script.lines.map((l: any) => l.id)).toEqual(['q', 'a1', 'f']);
    expect(script.skits).toEqual(JSON.parse(JSON.stringify(planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any }))));
  });

  it('конфликт, переписанный по замечанию, заменяет сценку режиссёра', async () => {
    const rewritten = { ...CONFLICT, lines: [{ hero: 'galina', text: 'Обои потёрли! Весь залог мой!' }, CONFLICT.lines[1]] };
    const { svc, pg } = setup([{ ...SKIT_GOOD, conflict: rewritten }]);
    await svc.write(skitVideo({ owner_note: 'Галина должна злиться сильнее' }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.conflict.skit).toEqual(rewritten);
  });

  it('круг по замечанию: конфликт и принятая развязка — из сценария, а не из сцены', async () => {
    const accepted = planSkits({ conflict: { ...CONFLICT, setting: 'an accepted hallway' } as any, punchline: PUNCHLINE as any });
    const { svc, relay } = setup([SKIT_GOOD]);
    await svc.write(skitVideo({ script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    const message = relay.ask.mock.calls[0][1] as string;
    expect(message).toContain('setting: an accepted hallway');
    expect(message).toContain('Принятая сценка 2 (развязка) — не пиши punchline, если замечания и нарушения её не касаются:\n<<<ПРИНЯТАЯ СЦЕНКА 2\n');
    expect(message).not.toContain('Прошлый вариант сценки 2');
  });

  it('отзыв студии о длине: развязку сценарист не повторяет — принятая остаётся, её отпечаток тот же, клип не переснимется', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const { punchline, ...noPunchline } = SKIT_GOOD;
    const { svc, pg } = setup([noPunchline]);
    await svc.write(skitVideo({
      writer_feedback: 'озвучка 29 с — сократи на 3 с',
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.punchline.fingerprint).toBe(accepted.punchline.fingerprint);
    expect(script.skits.conflict.fingerprint).toBe(accepted.conflict.fingerprint);
  });

  it('без принятой развязки ответ без punchline — ошибка разбора (повтор этапа)', async () => {
    const { punchline, ...noPunchline } = SKIT_GOOD;
    const { svc } = setup([noPunchline]);
    await expect(svc.write(skitVideo())).rejects.toThrow('сценарист: нет сценки 2 — развязки (punchline)');
  });

  it('у skit без спланированных сценок реплики зацепки нет и в отвергнутом варианте', async () => {
    const noBox = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [{ hero: 'kesha', text: 'Это износ.' }, PUNCHLINE.lines[1]] } };
    const { svc, relay } = setup([noBox, SKIT_GOOD]);
    await svc.write(skitVideo());
    const second = relay.ask.mock.calls[1][1] as string;
    expect(second).toContain(`Прошлый вариант:\nзацепка: ${SKIT_GOOD.hook} (hookBox 3)`);
    expect(second).not.toContain('реплики hook быть не должно');
    // Отвергнутая развязка — «прошлым вариантом», не принятой.
    expect(second).toContain('Прошлый вариант сценки 2:\n<<<СЦЕНКА 2\n');
    expect(second).not.toContain('ПРИНЯТАЯ');
  });

  it('развязка без box — переписка с перечнем; второй вариант проходит', async () => {
    const noBox = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [{ hero: 'kesha', text: 'Это износ.' }, PUNCHLINE.lines[1]] } };
    const { svc, pg, relay } = setup([noBox, SKIT_GOOD]);
    await svc.write(skitVideo());
    expect(relay.ask).toHaveBeenCalledTimes(2);
    expect(relay.ask.mock.calls[1][1]).toContain('сценка 2 (развязка): правило 18');
    expect((pg.query.mock.calls[0] as any[])[1][5]).toBe('animate_queued');
  });

  it('у ролика со сценками нет сценки 1 — StageFatalError: нужен режиссёр', async () => {
    const { svc, relay } = setup([SKIT_GOOD]);
    await expect(svc.write(video({ format: 'skit' }))).rejects.toThrow(/нет сценки 1/);
    expect(relay.ask).not.toHaveBeenCalled();
  });
});
