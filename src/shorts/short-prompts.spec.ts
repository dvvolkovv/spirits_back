import { DIRECTOR_SYSTEM, WRITER_SYSTEM, buildDirectorMessage, buildWriterMessage, toAgents } from './short-prompts';

describe('системные промпты', () => {
  it('режиссёр знает подачи, предел вопроса и запреты', () => {
    for (const s of ['uncomfortable', 'roast', 'myth', 'calm', '450 знаков', 'персональных данных', 'политики и религии', 'Уже было', '"followups"']) {
      expect(DIRECTOR_SYSTEM).toContain(s);
    }
  });

  it('сценарист знает опору зацепки, финал от кода и все 15 правил', () => {
    for (const s of ['hookBox', 'Финальную реплику с названием сервиса добавит код', 'needsRecapture', '25 000 токенов']) {
      expect(WRITER_SYSTEM).toContain(s);
    }
    for (let n = 1; n <= 15; n++) expect(WRITER_SYSTEM).toContain(`\n${n}. `);
  });
});

describe('toAgents', () => {
  it('строки getAgents — id числом и профиль без пробелов по краям', () => {
    expect(toAgents([{ id: '10', name: 'Алексей', description: ' Юрист ' }])).toEqual([{ id: 10, name: 'Алексей', description: 'Юрист' }]);
  });
});

describe('buildDirectorMessage', () => {
  const assistants = [{ id: 10, name: 'Алексей', description: 'Юрист' }, { id: 22, name: 'Кира', description: 'Дизайнер' }];
  const base = {
    rubric: 'assistant' as const, angle: 'roast' as const, topicHint: null, fixedAssistant: null, assistants,
    recentQuestions: [], ownerNote: null, previousQuestion: null,
  };

  it('без заданного ассистента — список с профилями', () => {
    const m = buildDirectorMessage(base);
    expect(m).toContain('Подача: roast — Разнос');
    expect(m).toContain('10 — Алексей: Юрист');
    expect(m).toContain('22 — Кира: Дизайнер');
  });

  it('заданный ассистент, прошлая сцена, замечания и «уже было»', () => {
    const m = buildDirectorMessage({
      ...base, fixedAssistant: assistants[0], topicHint: 'Договор аренды',
      previousQuestion: 'Старый вопрос', ownerNote: 'Сценарист: нужен вопрос про субаренду', recentQuestions: ['Вопрос А'],
    });
    expect(m).toContain('Ассистент задан: 10 — Алексей: Юрист');
    expect(m).not.toContain('22 — Кира');
    expect(m).toContain('Тема: Договор аренды');
    expect(m).toContain('придумай другую:\nСтарый вопрос');
    expect(m).toContain('нужен вопрос про субаренду');
    expect(m).toContain('Уже было (не повторяй):\n- Вопрос А');
  });

  it('реальный кейс — пересказ истории без имён и сумм', () => {
    expect(buildDirectorMessage({ ...base, rubric: 'case', topicHint: 'История владельца' })).toMatch(/Реальная история владельца.*без имён/);
  });
});

describe('buildWriterMessage', () => {
  const base = {
    rubric: 'assistant' as const, angle: 'myth' as const, assistantName: 'Алексей', assistantDescription: 'Юрист',
    question: 'Можно ли не вернуть залог?', paragraphs: [{ n: 1, text: 'Первый.' }, { n: 2, text: 'Второй.' }],
    ownerNote: null, writerFeedback: null, previousScript: null, violations: [],
  };

  it('абзацы с номерами и вопрос', () => {
    const m = buildWriterMessage(base);
    expect(m).toContain('[1] Первый.\n[2] Второй.');
    expect(m).toContain('Спросили: Можно ли не вернуть залог?');
    expect(m).toContain('Подача: myth — ИИ против мифа');
  });

  it('замечания, пояснение студии, прошлый вариант и нарушения', () => {
    const m = buildWriterMessage({
      ...base,
      ownerNote: 'короче',
      writerFeedback: 'Озвучка заняла 63 с',
      previousScript: { hook: 'Старая зацепка', voice: 'madirus', speed: 1.1, lines: [{ id: 'a1', scene: 'answer', box: 1, text: 'Старая реплика' }], final: { assistantsCount: 18 } },
      violations: ['правило 6: стартовый подарок — «25 000 токенов», а не «бесплатно»'],
    });
    expect(m).toContain('Замечания владельца:\nкороче');
    expect(m).toContain('Студия: Озвучка заняла 63 с');
    expect(m).toContain('Старая зацепка');
    expect(m).toContain('[1] Старая реплика');
    expect(m).toContain('нарушил правила — исправь:\n- правило 6');
  });
});
