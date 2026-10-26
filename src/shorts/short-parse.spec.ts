import { MAX_QUESTION_CHARS, MIN_QUESTION_CHARS, extractJsonObject, parseDirectorReply, parseSkit, parseWriterReply } from './short-parse';

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

  it('ответ-массив без забора — та же ошибка, что с забором', () => {
    expect(() => extractJsonObject('[{"assistantId":10,"question":"x"}]', 'x')).toThrow(/не нашёл JSON/);
    expect(() => extractJsonObject('[{"a":1},{"b":2}]', 'x')).toThrow(/не нашёл JSON/);
  });

  it('несколько заборов — берётся последний, который разбирается в объект', () => {
    const raw = 'Пример: ```json\n{"not":"this"}\n``` Мой ответ: ```json\n{"a":42}\n```';
    expect(extractJsonObject(raw, 'x')).toEqual({ a: 42 });
  });

  it('несколько заборов — если последний не объект, берётся предыдущий разбирающийся', () => {
    const raw = 'Так: ```json\n{"a":1}\n``` А если так: ```json\n[1,2]\n```';
    expect(extractJsonObject(raw, 'x')).toEqual({ a: 1 });
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
    expect(parseDirectorReply(JSON.stringify(ok), free)).toEqual({ ...ok, skit: null });
  });

  it('ролик со сценками — сценка 1 полями; без неё ответ не годится', () => {
    const skit = {
      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'a hallway', opening: 'The goose blocks the door.', action: 'The goose hisses.',
      lines: [{ hero: 'galina', text: 'Залог мой!' }],
    };
    expect(parseDirectorReply(JSON.stringify({ ...ok, skit }), { ...free, skit: true }).skit).toEqual(skit);
    expect(() => parseDirectorReply(JSON.stringify(ok), { ...free, skit: true })).toThrow(/режиссёр: skit — объект/);
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

  it('телефоны РФ и СНГ в вопросе и уточнении — персональные данные', () => {
    for (const phone of ['+7 (999) 123-45-67', '8 800 555 35 35', '89991234567', '+375 29 123 45 67', '+380 67 123 45 67', '8(912)345-67-89']) {
      expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: `${ok.question} Звоните: ${phone}` }), free)).toThrow(/персональные данные/);
      expect(() => parseDirectorReply(JSON.stringify({ ...ok, followups: [`Мой номер ${phone}`] }), free)).toThrow(/персональными данными/);
    }
  });

  it('крупные суммы и диапазоны — не телефон', () => {
    for (const sum of ['120 000 000', '1 200 000 - 1 500 000', '7 500 000 рублей', '800 000 000', '7 300 000-7 500 000', '8 000 000 000']) {
      const question = `Бюджет на квартиру ${sum} — хватит на двушку?`;
      const r = parseDirectorReply(JSON.stringify({ ...ok, question, followups: [`Готов потратить ${sum}`] }), free);
      expect(r.question).toBe(question);
    }
  });

  it('без уточнения на встречный вопрос и без названия — ошибка', () => {
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, followups: [] }), free)).toThrow(/уточнения/);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, title: '' }), free)).toThrow(/названия/);
  });

  it('границы длины вопроса: ровно MIN/MAX проходят, на единицу меньше/больше — ошибка', () => {
    const minOk = 'а'.repeat(MIN_QUESTION_CHARS);
    const minShort = 'а'.repeat(MIN_QUESTION_CHARS - 1);
    const maxOk = 'а'.repeat(MAX_QUESTION_CHARS);
    const maxLong = 'а'.repeat(MAX_QUESTION_CHARS + 1);
    expect(parseDirectorReply(JSON.stringify({ ...ok, question: minOk }), free).question).toBe(minOk);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: minShort }), free)).toThrow(/длина вопроса/);
    expect(parseDirectorReply(JSON.stringify({ ...ok, question: maxOk }), free).question).toBe(maxOk);
    expect(() => parseDirectorReply(JSON.stringify({ ...ok, question: maxLong }), free)).toThrow(/длина вопроса/);
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

  it('ролик со сценками: развязка обязательна, пока нет принятой; конфликт — только если переписан', () => {
    const punchline = {
      cast: [{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }],
      setting: 'the same hallway', opening: 'The capybara holds up the phone.', action: 'The goose drops the keys.',
      lines: [{ hero: 'kesha', text: 'Это износ.', box: '3' }, { hero: 'galina', text: 'Га-га… ладно.' }],
    };
    const r = parseWriterReply(JSON.stringify({ ...w, punchline }), { skit: true });
    expect(r.skits.conflict).toBeNull();
    expect(r.skits.punchline?.lines).toEqual([{ hero: 'kesha', text: 'Это износ.', box: 3 }, { hero: 'galina', text: 'Га-га… ладно.' }]);
    const conflict = { ...punchline, lines: [{ hero: 'galina', text: 'Залог мой!' }] };
    expect(parseWriterReply(JSON.stringify({ ...w, punchline, conflict }), { skit: true }).skits.conflict?.lines).toEqual([{ hero: 'galina', text: 'Залог мой!' }]);
    expect(() => parseWriterReply(JSON.stringify(w), { skit: true })).toThrow('сценарист: нет сценки 2 — развязки (punchline)');
    expect(() => parseWriterReply(JSON.stringify({ ...w, punchline: 'a hallway' }), { skit: true })).toThrow(/сценарист: punchline — объект/);
    // С принятой развязкой сценарист её не повторяет: null — остаётся принятая, её клип не переснимается.
    expect(parseWriterReply(JSON.stringify(w), { skit: true, acceptedPunchline: true }).skits).toEqual({ conflict: null, punchline: null });
    // «Не меняю» модели — null, пустая строка, false, пустой объект — это не сценка.
    for (const empty of [null, '', false, {}]) {
      expect(parseWriterReply(JSON.stringify({ ...w, punchline, conflict: empty }), { skit: true }).skits.conflict).toBeNull();
      expect(parseWriterReply(JSON.stringify({ ...w, punchline: empty }), { skit: true, acceptedPunchline: true }).skits.punchline).toBeNull();
    }
    // Без формата skit сценки не разбираются вовсе.
    expect(parseWriterReply(JSON.stringify({ ...w, punchline })).skits).toEqual({ conflict: null, punchline: null });
  });

  it('нет зацепки или заголовка YouTube — ошибка', () => {
    expect(() => parseWriterReply(JSON.stringify({ ...w, hook: '' }))).toThrow(/зацепк/);
    expect(() => parseWriterReply(JSON.stringify({ ...w, captions: { ...w.captions, youtube: { ...w.captions.youtube, title: '' } } }))).toThrow(/YouTube/);
  });
});

describe('parseSkit', () => {
  it('поля — строками без пробелов по краям, id героя — строчными; пустой box — нет box; кривой box — ошибка с местом', () => {
    const s = parseSkit({
      cast: [{ hero: ' Kesha ', role: ' жилец ' }],
      setting: ' a hallway ', opening: 'o', action: 'a',
      lines: [{ hero: 'KESHA', text: ' Спокойно. ', box: '' }, { hero: 'kesha', text: 'Да', box: null }],
    }, 'режиссёр', 'skit');
    expect(s).toEqual({
      cast: [{ hero: 'kesha', role: 'жилец' }],
      setting: 'a hallway', opening: 'o', action: 'a',
      lines: [{ hero: 'kesha', text: 'Спокойно.' }, { hero: 'kesha', text: 'Да' }],
    });
    expect(() => parseSkit({ lines: [{ hero: 'kesha', text: 'x', box: 'три' }] }, 'сценарист', 'punchline'))
      .toThrow('сценарист: punchline, реплика 1 — box должен быть номером абзаца');
    expect(() => parseSkit([], 'режиссёр', 'skit')).toThrow(/объект/);
  });

  it('нехватку полей не прячет: пустые строки и массивы уходят на проверку правил', () => {
    expect(parseSkit({}, 'режиссёр', 'skit')).toEqual({ cast: [], setting: '', opening: '', action: '', lines: [] });
  });
});
