import { extractJsonObject, parseDirectorReply, parseWriterReply } from './short-parse';

describe('extractJsonObject', () => {
  it('берёт объект из забора и из обвязки', () => {
    expect(extractJsonObject('Вот:\n```json\n{"a":1}\n```', 'x')).toEqual({ a: 1 });
    expect(extractJsonObject('Конечно! {"a":2} Удачи', 'x')).toEqual({ a: 2 });
  });

  it('без объекта — ошибка с началом ответа', () => {
    expect(() => extractJsonObject('Извините, не могу', 'режиссёр')).toThrow(/режиссёр: не нашёл JSON.*Извините, не могу/);
    expect(() => extractJsonObject('[1,2]', 'x')).toThrow(/не нашёл JSON/);
    expect(() => extractJsonObject('', 'x')).toThrow(/пустой ответ/);
  });
});

describe('parseDirectorReply', () => {
  const ids = new Set([10, 22]);
  const free = { assistantIds: ids, fixedAssistantId: null };
  const ok = {
    assistantId: 10,
    question: 'Хозяин квартиры не возвращает залог — что делать?',
    followups: ['Москва, договор на 11 месяцев'],
    title: 'Залог при аренде',
  };

  it('нормальный ответ', () => {
    expect(parseDirectorReply(JSON.stringify(ok), free)).toEqual(ok);
  });

  it('ассистент не из списка и не тот, что задан темой', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, assistantId: 5 }), free)).toThrow(/ассистента 5 нет/);
    expect(() => parseDirectorReply(JSON.stringify(ok), { assistantIds: ids, fixedAssistantId: 22 })).toThrow(/задана для 22/);
  });

  it('длина вопроса и персональные данные', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: 'Коротко?' }), free)).toThrow(/длина вопроса 8/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: 'я'.repeat(451) }), free)).toThrow(/длина вопроса 451/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: `${ok.question} Телефон +7 000 000-00-00` }), free)).toThrow(/персональные данные/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: `${ok.question} Пишите на ivan@example.com` }), free)).toThrow(/персональные данные/);
  });

  it('без уточнения на встречный вопрос и без названия — ошибка', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, followups: [] }), free)).toThrow(/уточнения/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, title: '' }), free)).toThrow(/названия/);
  });
});

describe('parseWriterReply', () => {
  const w = {
    hook: 'Хозяин может оставить залог себе?',
    hookBox: 2,
    question: 'Я Алексей, юрист.',
    lines: [{ box: 2, text: 'Первая.' }, { box: 3, text: 'Вторая.' }],
    captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'YT', description: 'D', tags: ['аренда'] } },
  };

  it('нормальный ответ', () => {
    const r = parseWriterReply(JSON.stringify(w));
    expect(r.needsRecapture).toBe(false);
    expect(r.hookBox).toBe(2);
    expect(r.lines).toEqual(w.lines);
    expect(r.captions.youtube.tags).toEqual(['аренда']);
  });

  it('hookBox пустой — null; vk без текста — как telegram', () => {
    const r = parseWriterReply(JSON.stringify({ ...w, hookBox: null, captions: { ...w.captions, vk: '' } }));
    expect(r.hookBox).toBeNull();
    expect(r.captions.vk).toBe('TG');
  });

  it('просьба переснять — только с причиной', () => {
    expect(parseWriterReply('{"needsRecapture": true, "reason": "нужен вопрос про субаренду"}'))
      .toMatchObject({ needsRecapture: true, reason: 'нужен вопрос про субаренду' });
    expect(() => parseWriterReply('{"needsRecapture": true}')).toThrow(/не объяснил/);
  });

  it('реплика без номера абзаца — ошибка', () => {
    expect(() => parseWriterReply(JSON.stringify({ ...w, lines: [{ text: 'без номера' }] }))).toThrow(/box/);
  });

  it('нет зацепки или заголовка YouTube — ошибка', () => {
    expect(() => parseWriterReply(JSON.stringify({ ...w, hook: '' }))).toThrow(/зацепк/);
    expect(() => parseWriterReply(JSON.stringify({ ...w, captions: { ...w.captions, youtube: { ...w.captions.youtube, title: '' } } }))).toThrow(/YouTube/);
  });
});
