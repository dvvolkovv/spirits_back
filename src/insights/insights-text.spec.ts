import { cleanLine, parseModelJson, PEOPLE_COUNT_RE } from './insights-text';

describe('cleanLine', () => {
  it('пропускает суть своими словами', () => {
    expect(cleanLine('  Не нашёл, где   завести бота ', 140)).toBe('Не нашёл, где завести бота');
  });

  it.each([
    'просит выгрузку за 2026 год',
    'пишет на почту a@b',
    'пишет «у меня магазин электротоваров и ничего не продаётся»',
    'пишет "у меня магазин электротоваров и ничего не продаётся"',
    'зовут [имя]',
    'оставил [телефон]',
  ])('отбрасывает похожее на цитату или утечку: %s', (s) => {
    expect(cleanLine(s, 140)).toBeNull();
  });

  it('короткое название раздела в кавычках проходит', () => {
    expect(cleanLine('ищет бота во вкладке «Telegram-боты», а не в «Продуктах»', 140)).toBe(
      'ищет бота во вкладке «Telegram-боты», а не в «Продуктах»',
    );
  });

  it('режет длинное с многоточием и не ломает символы', () => {
    const out = cleanLine('я'.repeat(200), 140)!;
    expect(Array.from(out)).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
  });

  it('не-строку отбрасывает', () => {
    expect(cleanLine(42, 140)).toBeNull();
    expect(cleanLine(undefined, 140)).toBeNull();
  });
});

describe('PEOPLE_COUNT_RE', () => {
  it.each([
    'у 4 человек',
    '3 пользователя',
    '2 разговора',
    'повторил 5 раз',
    '2 раза',
    'только один пользователь',
    'с этим столкнулись несколько человек',
    'двое клиентов спросили',
    'у трёх пользователей',
    'пара человек',
  ])('ловит «%s»', (s) => {
    expect(PEOPLE_COUNT_RE.test(s)).toBe(true);
  });
  it.each(['разговор обрывается', 'интеграция с 1С', 'Sonnet 4.5', 'пользователи путают два раздела', 'трудно найти кнопку'])(
    'не трогает «%s»',
    (s) => {
      expect(PEOPLE_COUNT_RE.test(s)).toBe(false);
    },
  );
});

describe('parseModelJson', () => {
  it('снимает ограду ```json', () => {
    expect(parseModelJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('находит JSON внутри прозы', () => {
    expect(parseModelJson('Вот ответ: {"findings": []} — готово')).toEqual({ findings: [] });
  });
  it('мусор — null', () => {
    expect(parseModelJson('не json')).toBeNull();
  });
});
