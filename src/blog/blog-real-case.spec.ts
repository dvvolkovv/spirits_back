import {
  REAL_CASE_DUPLICATE, REAL_CASE_MAX_CHARS, REAL_CASE_MIN_CHARS,
  caseCommandStory, prepareRealCase, realCaseTopicKey,
} from './blog-real-case';
import { DEDUP_WINDOW_DAYS, normalizeTopicKey } from './blog-topic.service';

const STORY = 'Рассказчик — Дмитрий, основатель Linkeon. Роман прочитал полис КАСКО и нашёл франшизу на замену стекла.';

describe('prepareRealCase', () => {
  it('годный материал — реальный кейс: рубрика case, источник real, материал целиком в подсказке', () => {
    expect(prepareRealCase(`  ${STORY}\n`)).toEqual({
      ok: true,
      topic: { rubric: 'case', source: 'real', topicKey: realCaseTopicKey(STORY), topicHint: STORY },
    });
  });

  it('пусто и тема одной строкой — отказ с объяснением, что нужно', () => {
    for (const raw of ['', '   ', undefined, null, 'кейс про налоговую']) {
      const prep = prepareRealCase(raw);
      expect(prep.ok).toBe(false);
      if (prep.ok === false) {
        expect(prep.reason).toContain(String(REAL_CASE_MIN_CHARS));
        expect(prep.reason).toMatch(/что сделал ассистент/);
        expect(prep.reason).toMatch(/в чём суть/);
      }
    }
  });

  it('нижняя граница: 40 знаков годятся, 39 — нет', () => {
    expect(prepareRealCase('а'.repeat(REAL_CASE_MIN_CHARS)).ok).toBe(true);
    expect(prepareRealCase('а'.repeat(REAL_CASE_MIN_CHARS - 1)).ok).toBe(false);
  });

  it('длиннее 4000 знаков — отказ, а не обрезка', () => {
    const prep = prepareRealCase('а'.repeat(REAL_CASE_MAX_CHARS + 1));
    expect(prep.ok).toBe(false);
    if (prep.ok === false) {
      expect(prep.reason).toContain(String(REAL_CASE_MAX_CHARS));
      expect(prep.reason).toContain('сейчас 4001');
      expect(prep.reason).toMatch(/не буду/);
    }
    expect(prepareRealCase('а'.repeat(REAL_CASE_MAX_CHARS)).ok).toBe(true);
  });

  // `.length` считает эмодзи за два знака — и отказал бы истории ровно на пределе.
  it('знаки считаются символами, а не UTF-16', () => {
    const atLimit = 'а'.repeat(REAL_CASE_MAX_CHARS - 1) + '😀';
    expect(atLimit.length).toBe(REAL_CASE_MAX_CHARS + 1);
    expect(prepareRealCase(atLimit).ok).toBe(true);
  });

  // Админка шлёт JSON до 50 МБ: считать символы такого тела — сотни мегабайт
  // в процессе, который обслуживает живые чаты. Заведомо длинное отсекается раньше.
  it('заведомо длинное тело отклоняется без подсчёта символов', () => {
    const spy = jest.spyOn(Array, 'from');
    try {
      const prep = prepareRealCase('а'.repeat(REAL_CASE_MAX_CHARS * 3));
      expect(spy).not.toHaveBeenCalled();
      expect(prep.ok).toBe(false);
      if (prep.ok === false) expect(prep.reason).toContain(String(REAL_CASE_MAX_CHARS));
    } finally {
      spy.mockRestore();
    }
  });

  it('отказ на повтор называет то же окно, что у дедупликации', () => {
    expect(REAL_CASE_DUPLICATE).toBe(`такую историю уже заводили за последние ${DEDUP_WINDOW_DAYS} дней`);
  });
});

describe('realCaseTopicKey', () => {
  it('тот же текст — тот же ключ: повтор отсечёт дедупликация', () => {
    expect(realCaseTopicKey(STORY)).toBe(realCaseTopicKey(STORY));
  });

  // Материалы владельца начинаются одинаково — ключ по началу склеил бы разные истории.
  it('разные истории с одинаковым началом — разные ключи', () => {
    expect(realCaseTopicKey(`${STORY} Отказался от полиса.`))
      .not.toBe(realCaseTopicKey(`${STORY} Страховая вписала условие.`));
  });

  it('ключ переживает нормализацию addTopic без изменений', () => {
    const key = realCaseTopicKey(STORY);
    expect(key).toMatch(/^реальный-кейс-[0-9a-f]{12}$/);
    expect(normalizeTopicKey(key)).toBe(key);
  });
});

describe('caseCommandStory', () => {
  it('история — всё после команды; регистр и переносы строк сохранены', () => {
    expect(caseCommandStory('/case Дмитрий, основатель Linkeon.\nРоман прочитал полис.'))
      .toBe('Дмитрий, основатель Linkeon.\nРоман прочитал полис.');
  });

  it('история может начинаться со следующей строки', () => {
    expect(caseCommandStory('/case\nДмитрий рассказывает')).toBe('Дмитрий рассказывает');
  });

  it('команда с именем бота', () => {
    expect(caseCommandStory('/case@LinkeonAgentBot История')).toBe('История');
  });

  it('команда без истории — пустая строка, а не null: команда наша, просто пустая', () => {
    expect(caseCommandStory('/case')).toBe('');
    expect(caseCommandStory('/case   ')).toBe('');
  });

  it('другие команды и обычный текст — не наши', () => {
    expect(caseCommandStory('/cases история')).toBeNull();
    expect(caseCommandStory('/help')).toBeNull();
    expect(caseCommandStory('расскажи /case')).toBeNull();
    expect(caseCommandStory(undefined)).toBeNull();
  });

  it('регистр команды не важен, как и у остальных команд бота', () => {
    expect(caseCommandStory('/CASE История')).toBe('История');
  });

  it('неразрывный пробел после команды — тоже разделитель', () => {
    expect(caseCommandStory('/case История')).toBe('История');
  });

  it('имя бота без истории — пустая история; одинокая @ — не команда', () => {
    expect(caseCommandStory('/case@LinkeonAgentBot')).toBe('');
    expect(caseCommandStory('/case@')).toBeNull();
    expect(caseCommandStory('/case@bot,История')).toBe(',История');
  });

  // Telegram подсвечивает «/case» командой и в «/case: …», и в «/case«…»» —
  // без этого владелец упирался в «Не знаю такой команды», а /case в /help нет.
  it('пунктуация сразу после команды не делает её чужой', () => {
    expect(caseCommandStory('/case: История')).toBe('История');
    expect(caseCommandStory('/case«История»')).toBe('«История»');
  });

  it('реплика с тире в начале истории остаётся целой', () => {
    expect(caseCommandStory('/case\n— Роман, посмотри полис')).toBe('— Роман, посмотри полис');
  });

  it('продолжение имени команды — другая команда', () => {
    expect(caseCommandStory('/case_x История')).toBeNull();
  });
});
