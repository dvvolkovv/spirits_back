import { parseEditorReply } from './blog-editor.parse';

describe('parseEditorReply', () => {
  it('чистый JSON разбирается', () => {
    const out = parseEditorReply('{"title":"З","body":"Т","imagePrompt":"сцена"}');
    expect(out).toEqual({ title: 'З', body: 'Т', imagePrompt: 'сцена' });
  });

  it('JSON в markdown-заборе разбирается', () => {
    const raw = 'Вот пост:\n```json\n{"title":"З","body":"Т","imagePrompt":"сцена"}\n```\nГотово.';
    expect(parseEditorReply(raw).title).toBe('З');
  });

  it('JSON без языка в заборе разбирается', () => {
    const raw = '```\n{"title":"З","body":"Т","imagePrompt":"сцена"}\n```';
    expect(parseEditorReply(raw).body).toBe('Т');
  });

  it('пустой ответ — ошибка, а не пустой пост', () => {
    expect(() => parseEditorReply('')).toThrow(/пустой ответ/i);
  });

  it('текст без JSON — ошибка', () => {
    expect(() => parseEditorReply('Извини, не могу помочь')).toThrow(/не нашёл json/i);
  });

  it('JSON без обязательного поля — ошибка с именем поля', () => {
    expect(() => parseEditorReply('{"title":"З","body":"Т"}')).toThrow(/imagePrompt/);
  });

  it('пробельные значения считаются отсутствующими', () => {
    expect(() => parseEditorReply('{"title":"  ","body":"Т","imagePrompt":"с"}')).toThrow(/title/);
  });
});

/**
 * Кейсы про Романа и Лиану упали на проде с «не нашёл JSON в ответе
 * редактора», и что редактор написал вместо поста, не узнал никто: сырой
 * ответ не сохранялся. Сообщение ошибки уходит в `last_error` поста — там его
 * и видно в админке.
 */
describe('parseEditorReply: причина отказа видна', () => {
  const errorOf = (raw: string): string => {
    try {
      parseEditorReply(raw);
    } catch (e: any) {
      return String(e.message);
    }
    throw new Error('ожидалась ошибка разбора');
  };

  it('текст без JSON — в ошибке начало сырого ответа', () => {
    const msg = errorOf('Уточните, кто такой Роман и что он умеет? Без этого кейс не написать.');
    expect(msg).toMatch(/не нашёл json/i);
    expect(msg).toContain('Уточните, кто такой Роман и что он умеет?');
  });

  it('битый JSON — в ошибке тоже начало ответа', () => {
    const msg = errorOf('{"title": "Двадцать дел", "body": оборвалось');
    expect(msg).toMatch(/не нашёл json/i);
    expect(msg).toContain('{"title": "Двадцать дел", "body": оборвалось');
  });

  it('JSON без поля — в ошибке и имя поля, и начало ответа', () => {
    const msg = errorOf('{"title":"З","body":"Т"}');
    expect(msg).toContain('imagePrompt');
    expect(msg).toContain('{"title":"З","body":"Т"}');
  });

  it('длинный ответ обрезан до начала: ~300 символов, а не весь текст', () => {
    const raw = 'а'.repeat(250) + 'НАЧАЛО_ВИДНО' + 'б'.repeat(100) + 'ХВОСТ_НЕ_ВИДЕН' + 'в'.repeat(5000);
    const msg = errorOf(raw);
    expect(msg).toContain('НАЧАЛО_ВИДНО');
    expect(msg).not.toContain('ХВОСТ_НЕ_ВИДЕН');
    expect(msg.length).toBeLessThanOrEqual(400);
  });

  it('ошибка — одна строка: в админке last_error показывается строкой', () => {
    const msg = errorOf('Я не понял задачу.\n\nПоясните,\r\nпожалуйста:\tкто это?');
    expect(msg).not.toMatch(/[\r\n\t]/);
    expect(msg).toContain('Я не понял задачу. Поясните, пожалуйста: кто это?');
  });

  it('обрезка не рвёт символ пополам', () => {
    // 299 букв и эмодзи на стыке: суррогатная пара, разрезанная посередине,
    // уехала бы в базу мусорным символом.
    const msg = errorOf('ж'.repeat(299) + '😀' + 'з'.repeat(50));
    expect(msg).toContain('😀');
    expect(msg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
