import { newSceneNote } from './short-doctor';
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
    await expect(svc.write(video())).rejects.toMatchObject({ name: 'StageFatalError', code: 'rules' });
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('просит переснять — ролик к режиссёру с причиной в замечаниях', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    await svc.write(video({ owner_note: 'про субаренду' }));
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/SET status = 'directing'/);
    // Новая сцена — новый круг: отзыв студии о прошлой озвучке и счёт её переписок — заново.
    expect(sql).toMatch(/writer_feedback = NULL/);
    expect(sql).toMatch(/skit_feedback = NULL/);
    expect(sql).toMatch(/writer_rounds = 0/);
    expect(params[1]).toBe('про субаренду\nСценарист: нужен вопрос про субаренду');
  });

  it('уже дважды просил другую сцену — третий раз фатально, без записи', async () => {
    expect(MAX_RECAPTURES).toBe(2);
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    const note = 'про субаренду\nСценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду';
    const err = await svc.write(video({ owner_note: note })).catch((e) => e);
    expect(err).toBeInstanceOf(StageFatalError);
    expect(err).toMatchObject({ code: 'recapture' });
    expect(err.message).toBe('сценарист: уже дважды просил другую сцену — нужен взгляд владельца; последняя причина: нужен вопрос про субаренду');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('новое замечание владельца после просьб сценариста — счёт просьб заново', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    const note = 'Сценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду\nсделайте про субаренду с животными';
    await svc.write(video({ owner_note: note }));
    expect((pg.query.mock.calls[0] as any[])[0]).toMatch(/SET status = 'directing'/);
  });

  it('строка доктора «Сам: …» — не замечание владельца: счёт просьб сценариста не обнуляет', async () => {
    const { svc, pg } = setup([{ needsRecapture: true, reason: 'нужен вопрос про субаренду' }]);
    // Строка — как её пишет доктор (newSceneNote): тест не разойдётся с префиксом.
    const note = `про субаренду\nСценарист: нужен вопрос про субаренду\nСценарист: всё ещё не про субаренду\n${newSceneNote({ lastError: 'съёмка: ответ не годится', failedCode: 'answer_rejected' })}`;
    const err = await svc.write(video({ owner_note: note })).catch((e) => e);
    expect(err).toMatchObject({ name: 'StageFatalError', code: 'recapture' });
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('реальный кейс — с подписью в кадре вопроса', async () => {
    const { svc, pg } = setup([GOOD]);
    await svc.write(video({ rubric: 'case' }));
    expect(JSON.parse((pg.query.mock.calls[0] as any[])[1][1]).badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
  });

  it('нет съёмки — фатально', async () => {
    const { svc } = setup([GOOD]);
    await expect(svc.write(video({ capture: null }))).rejects.toMatchObject({ name: 'StageFatalError', code: 'no_scene' });
  });

  it('формат «Только чат» после отзыва о сценке: отзыв студии о сценке сценаристу чата не уходит', async () => {
    const { svc, relay } = setup([GOOD]);
    await svc.write(video({
      writer_feedback: 'сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи. Перепиши реплики и действие этой сценки.',
      skit_feedback: { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'x', reason: null },
    }));
    expect(relay.ask.mock.calls[0][1]).not.toContain('Студия:');
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

  it('круг по отзыву студии: сценки, которые модель всё же вернула с правкой, не берутся — отпечатки принятых', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const echo = {
      ...SKIT_GOOD,
      conflict: { ...CONFLICT, lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой.' }, CONFLICT.lines[1]] },
      punchline: { ...PUNCHLINE, action: `${PUNCHLINE.action} ` + 'She sighs.' },
    };
    const { svc, pg } = setup([echo]);
    await svc.write(skitVideo({
      writer_feedback: 'озвучка 29 с — сократи на 3 с',
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.conflict.fingerprint).toBe(accepted.conflict.fingerprint);
    expect(script.skits.punchline.fingerprint).toBe(accepted.punchline.fingerprint);
  });

  it('круг по замечанию (без отзыва студии) — переписанная развязка берётся', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const rewritten = { ...PUNCHLINE, action: 'The goose faints theatrically onto the suitcase.' };
    const { svc, pg } = setup([{ ...SKIT_GOOD, punchline: rewritten }]);
    await svc.write(skitVideo({
      owner_note: 'Развязка смешнее',
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.punchline.skit).toEqual(rewritten);
    expect(script.skits.punchline.fingerprint).not.toBe(accepted.punchline.fingerprint);
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

  const STUDIO_ABOUT_PUNCHLINE = {
    writer_feedback: 'сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи; в последнем не услышаны: реплика 2 (galina) «Га-га… ладно.», услышано: «нормальный износ не повреждение залог верните». Перепиши реплики и действие этой сценки.',
    skit_feedback: { kind: 'punchline', code: 'speech_mismatch', lines: [2], heard: 'нормальный износ не повреждение залог верните', reason: null },
  };

  it('отзыв студии о развязке: из ответа — только реплики и действие развязки; место, начало, герои — принятые, кадр не перерисуется, конфликт не переснимется', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const fresh = {
      ...PUNCHLINE,
      cast: [{ hero: 'galina', role: 'соседка' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'a completely different kitchen',
      opening: 'Everyone sits at a table.',
      action: 'The capybara speaks calmly, the goose nods and puts the keys on the table.',
      lines: [PUNCHLINE.lines[0], { hero: 'galina', text: 'Ладно, убедил. Забирай залог.' }],
    };
    // Конфликт в ответе — переписанный: по отзыву о развязке его брать нельзя, клип конфликта уже снят.
    const otherConflict = { ...CONFLICT, lines: [{ hero: 'galina', text: 'Обои потёрли! Весь залог мой!' }, CONFLICT.lines[1]] };
    const { svc, pg, relay } = setup([{ ...SKIT_GOOD, conflict: otherConflict, punchline: fresh }]);
    await svc.write(skitVideo({ ...STUDIO_ABOUT_PUNCHLINE, script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    expect(relay.ask.mock.calls[0][1]).toContain('Студия: сценка 2 (развязка): 2 клипа с этими репликами не прошли сверку речи');
    expect(relay.ask.mock.calls[0][1]).toContain('Сценка 2 (развязка), которую Omni не снял, — перепиши её реплики и действие:\n<<<СЦЕНКА 2\n');
    const [sql, params] = pg.query.mock.calls[0] as any[];
    expect(sql).toMatch(/skit_feedback = NULL/);
    const script = JSON.parse(params[1]);
    expect(script.skits.punchline.skit).toEqual({ ...PUNCHLINE, action: fresh.action, lines: fresh.lines });
    expect(script.skits.punchline.keyframeFingerprint).toBe(accepted.punchline.keyframeFingerprint);
    expect(script.skits.punchline.fingerprint).not.toBe(accepted.punchline.fingerprint);
    expect(script.skits.conflict.fingerprint).toBe(accepted.conflict.fingerprint);
  });

  it('отзыв студии о конфликте: переписываются реплики и действие конфликта; кадры обеих сценок и развязка — прежние', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const fresh = { ...CONFLICT, setting: 'a garage', action: 'The goose taps the scuff and frowns.', lines: [{ hero: 'galina', text: 'Обои испорчены! Залог не верну!' }, CONFLICT.lines[1]] };
    // Развязка в ответе — переписанная: по отзыву о конфликте её брать нельзя.
    const { svc, pg, relay } = setup([{ ...SKIT_GOOD, conflict: fresh, punchline: { ...PUNCHLINE, action: 'The goose faints theatrically onto the suitcase.' } }]);
    await svc.write(skitVideo({
      writer_feedback: 'сценка 1 (конфликт): фильтр Google 3 раза не пропустил клип (omni: отказ фильтра). Перепиши реплики и действие этой сценки.',
      skit_feedback: { kind: 'conflict', code: 'omni_rejected', lines: [], heard: null, reason: 'omni: отказ фильтра' },
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    expect(relay.ask.mock.calls[0][1]).toContain('Сценка 1 (конфликт) — открывает ролик; её Omni не снял — перепиши реплики и действие:');
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.conflict.skit).toEqual({ ...CONFLICT, action: fresh.action, lines: fresh.lines });
    expect(script.skits.conflict.keyframeFingerprint).toBe(accepted.conflict.keyframeFingerprint);
    expect(script.skits.conflict.fingerprint).not.toBe(accepted.conflict.fingerprint);
    expect(script.skits.punchline.keyframeFingerprint).toBe(accepted.punchline.keyframeFingerprint);
    expect(script.skits.punchline.fingerprint).toBe(accepted.punchline.fingerprint);
  });

  it('отзыв студии о конфликте, круг с нарушением: исходный конфликт — под «её Omni не снял», отвергнутый — «твоим прошлым вариантом»', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    // Борис не в составе сценки — нарушение сценки 1.
    const stranger = { ...CONFLICT, lines: [{ hero: 'boris', text: 'Обои испорчены!' }, CONFLICT.lines[1]] };
    const fixed = { ...CONFLICT, lines: [{ hero: 'galina', text: 'Обои испорчены! Залог не верну!' }, CONFLICT.lines[1]] };
    const { svc, pg, relay } = setup([{ ...SKIT_GOOD, conflict: stranger }, { ...SKIT_GOOD, conflict: fixed }]);
    await svc.write(skitVideo({
      writer_feedback: 'сценка 1 (конфликт): фильтр Google 3 раза не пропустил клип (omni: отказ фильтра). Перепиши реплики и действие этой сценки.',
      skit_feedback: { kind: 'conflict', code: 'omni_rejected', lines: [], heard: null, reason: 'omni: отказ фильтра' },
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    expect(relay.ask).toHaveBeenCalledTimes(2);
    const second = relay.ask.mock.calls[1][1] as string;
    const notShot = second.split('Сценка 1 (конфликт) — открывает ролик; её Omni не снял — перепиши реплики и действие:')[1].split('СЦЕНКА 1>>>')[0];
    expect(notShot).toContain('Обои потёрли! Залог мой!');
    expect(notShot).not.toContain('Обои испорчены!');
    expect(second).toContain('Твой прошлый вариант сценки 1 — исправь по нарушениям:\n<<<ПРОШЛАЯ СЦЕНКА 1\n');
    expect(second).toContain('говорит «boris», а его нет в составе');
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.conflict.skit.lines[0].text).toBe('Обои испорчены! Залог не верну!');
  });

  it('отзыв студии о сценке: прошлый вариант — перед моделью на следующем круге, база не сдвигается; тот же клип (точка в конце действия не в счёт) — нарушение', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const noBox = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [{ hero: 'kesha', text: 'Это износ.' }, { hero: 'galina', text: 'Ладно, убедил.' }] } };
    const sameClip = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, action: PUNCHLINE.action.replace(/\.$/, '') } };
    const fixed = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [PUNCHLINE.lines[0], { hero: 'galina', text: 'Ладно, убедил.' }] } };
    const { svc, pg, relay } = setup([noBox, sameClip, fixed]);
    await svc.write(skitVideo({ ...STUDIO_ABOUT_PUNCHLINE, script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    expect(relay.ask).toHaveBeenCalledTimes(3);
    const second = relay.ask.mock.calls[1][1] as string;
    expect(second).toContain('сценка 2 (развязка): правило 18');
    // Перед моделью — и её отвергнутый вариант, и то, что Omni не снял (база не сдвинулась на вариант круга).
    expect(second).toContain('Твой прошлый вариант сценки 2 — исправь по нарушениям:\n<<<ПРОШЛАЯ СЦЕНКА 2\n');
    expect(second).toContain('Это износ.');
    expect(second).toContain('Сценка 2 (развязка), которую Omni не снял, — перепиши её реплики и действие:');
    expect(second).toContain('Га-га… ладно.');
    // Отвергнутый вариант — только «твоим прошлым вариантом», без старого блока «Прошлый вариант сценки 2:».
    expect(second).not.toContain('Прошлый вариант сценки 2:');
    expect(relay.ask.mock.calls[2][1]).toContain('сценка 2 (развязка): отзыв студии — перепиши реплики и действие этой сценки (клип вышел бы тем же, что студия не смогла снять)');
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.punchline.skit.lines[1].text).toBe('Ладно, убедил.');
  });

  it('отзыв студии о сценке, а в ответе её нет — переписка с нарушением', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const { punchline, ...noPunchline } = SKIT_GOOD;
    const fixed = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [PUNCHLINE.lines[0], { hero: 'galina', text: 'Ладно, убедил.' }] } };
    const { svc, relay } = setup([noPunchline, fixed]);
    await svc.write(skitVideo({ ...STUDIO_ABOUT_PUNCHLINE, script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
    expect(relay.ask).toHaveBeenCalledTimes(2);
    expect(relay.ask.mock.calls[1][1]).toContain('сценка 2 (развязка): отзыв студии — перепиши реплики и действие этой сценки (в ответе её нет)');
    // Сценки в ответе не было — показывать «твоим прошлым вариантом» нечего.
    expect(relay.ask.mock.calls[1][1]).not.toContain('Твой прошлый вариант');
  });

  it('отзыв о сценке с испорченным видом — обычная переписка, а не падение', async () => {
    const accepted = planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any });
    const rewritten = { ...PUNCHLINE, action: 'The goose faints theatrically onto the suitcase.' };
    const { svc, pg } = setup([{ ...SKIT_GOOD, punchline: rewritten }]);
    await svc.write(skitVideo({
      writer_feedback: 'отзыв',
      skit_feedback: { kind: 'bogus', code: 'speech_mismatch', lines: [], heard: null, reason: null },
      script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted },
    }));
    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
    expect(script.skits.punchline.skit).toEqual(rewritten);
  });

  it('у ролика со сценками нет сценки 1 — StageFatalError: нужен режиссёр', async () => {
    const { svc, relay } = setup([SKIT_GOOD]);
    await expect(svc.write(video({ format: 'skit' }))).rejects.toThrow(/нет сценки 1/);
    await expect(svc.write(video({ format: 'skit' }))).rejects.toMatchObject({ code: 'no_conflict' });
    expect(relay.ask).not.toHaveBeenCalled();
  });
});
