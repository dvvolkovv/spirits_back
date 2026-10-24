import {
  clip, escapeHtml, FALLBACK_NAME, formatAssistantReport, formatToolCapNotice, formatToolFailure, head, oneLine, timesRu, toolAction, usersRu,
} from './problem-format';
import { CHAT_TOOLS } from '../chat/chat-tools';

describe('тексты в группу «Поддержка linkeon»', () => {
  it('сбой инструмента: ассистент, что не вышло, ошибка, пользователь', () => {
    const t = formatToolFailure({
      assistant: 'Кира', tool: 'generate_video', userId: 'u1',
      error: 'Veo generate failed: model is no longer available',
    });
    expect(t.split('\n')).toEqual([
      '🛠 <b>Кира: не получилось создать видео</b>',
      'Ошибка: <code>Veo generate failed: model is no longer available</code>',
      'Пользователь: <code>u1</code>',
    ]);
  });

  it('повторы — отдельной строкой, с согласованием', () => {
    const t = formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: { count: 4, users: 3 } });
    expect(t.split('\n')[3]).toBe('С прошлого сообщения: ещё 4 раза у 3 пользователей');
  });

  it('без повторов строки нет', () => {
    expect(formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: null }))
      .not.toContain('С прошлого сообщения');
    expect(formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: { count: 0, users: 0 } }))
      .not.toContain('С прошлого сообщения');
  });

  it('HTML экранируется везде', () => {
    const t = formatToolFailure({ assistant: '<b>Ки&ра</b>', tool: 'generate_image', error: '<script>&', userId: '<u>' });
    expect(t).toContain('&lt;b&gt;Ки&amp;ра&lt;/b&gt;');
    expect(t).toContain('<code>&lt;script&gt;&amp;</code>');
    expect(t).toContain('<code>&lt;u&gt;</code>');
  });

  it('ошибка обрезается до 300 символов с многоточием', () => {
    const t = formatToolFailure({ assistant: 'Кира', tool: 'generate_image', error: 'e'.repeat(1000), userId: 'u1' });
    const code = t.split('\n')[1].replace(/^Ошибка: <code>/, '').replace(/<\/code>$/, '');
    expect(code.length).toBe(300);
    expect(code.endsWith('…')).toBe(true);
  });

  it('незнакомый инструмент — «выполнить <имя>»', () => {
    expect(toolAction('do_magic')).toBe('выполнить do_magic');
    expect(toolAction('generate_speech')).toBe('озвучить текст');
  });

  // Новый инструмент в CHAT_TOOLS без человеческого названия здесь — красный тест.
  it('у каждого инструмента Linkeon своё действие', () => {
    for (const t of CHAT_TOOLS) expect(toolAction(t.name)).not.toMatch(/^выполнить /);
  });

  it('согласование «раз» и «пользователей»', () => {
    expect([1, 2, 5, 21, 22].map(timesRu)).toEqual(['1 раз', '2 раза', '5 раз', '21 раз', '22 раза']);
    expect([1, 2, 5, 21].map(usersRu)).toEqual([
      'у 1 пользователя', 'у 2 пользователей', 'у 5 пользователей', 'у 21 пользователя',
    ]);
  });

  it('сообщение ассистента: свой сбой и жалоба пользователя, канал', () => {
    expect(formatAssistantReport({ assistant: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает', userId: 'u1', channel: 'web' }).split('\n'))
      .toEqual(['🙋 <b>Кира: у меня не работает</b>', '«LibreOffice падает»', 'Пользователь: <code>u1</code> · веб']);
    expect(formatAssistantReport({ assistant: 'Кира', kind: 'user_report', summary: 'не проходит оплата', userId: 'u1', channel: 'telegram' }).split('\n'))
      .toEqual(['🙋 <b>Кира передаёт жалобу пользователя</b>', '«не проходит оплата»', 'Пользователь: <code>u1</code> · Telegram']);
  });

  it('пересказ ассистента экранируется и обрезается', () => {
    const line = formatAssistantReport({ assistant: 'Кира', kind: 'my_failure', summary: '<i>' + 'x'.repeat(900), userId: 'u1', channel: 'web' })
      .split('\n')[1];
    expect(line.startsWith('«&lt;i&gt;')).toBe(true);
    expect(line.endsWith('…»')).toBe(true);
    expect(line.length).toBeLessThan(520);
  });

  it('имя ассистента не длиннее 40 символов', () => {
    const head = formatAssistantReport({ assistant: 'А'.repeat(100), kind: 'my_failure', summary: 's', userId: 'u1', channel: 'web' }).split('\n')[0];
    expect(head).toBe(`🙋 <b>${'А'.repeat(39)}…: у меня не работает</b>`);
  });

  it('clip и escapeHtml', () => {
    expect(clip('  abc  ', 10)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('clip не рвёт эмодзи пополам', () => {
    const s = clip('😀'.repeat(10), 5);
    expect(s).toBe('😀😀😀😀…');
    expect(Array.from(s).length).toBe(5);
  });

  /** Видимая длина для Telegram: без тегов, сущность — один символ. */
  const visible = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt);/g, '_').length;

  it('огромные входы во всех полях — сообщение короче лимита Telegram (4096)', () => {
    const huge = (ch: string, n: number) => ch.repeat(n);
    const a = formatToolFailure({ assistant: huge('А', 10_000), tool: huge('x', 100_000), error: huge('&', 100_000), userId: huge('7', 100_000), repeats: { count: 5, users: 2 } });
    const b = formatAssistantReport({ assistant: huge('<', 10_000), kind: 'user_report', summary: huge('с', 1_000_000), userId: huge('7', 100_000), channel: 'telegram' });
    expect(visible(a)).toBeLessThan(4096);
    expect(visible(b)).toBeLessThan(4096);
  });

  it('путь Б: имя ассистента и userId экранируются', () => {
    const t = formatAssistantReport({ assistant: '<b>Ки&ра</b>', kind: 'my_failure', summary: 's', userId: '<u>', channel: 'web' });
    expect(t).toContain('&lt;b&gt;Ки&amp;ра&lt;/b&gt;');
    expect(t).toContain('<code>&lt;u&gt;</code>');
  });

  it('обрезка — до экранирования: сущность не рвётся', () => {
    const t = formatToolFailure({ assistant: 'Кира', tool: 'generate_image', error: '&'.repeat(1000), userId: 'u1' });
    const code = t.split('\n')[1].replace(/^Ошибка: <code>/, '').replace(/<\/code>$/, '');
    expect(code).toBe('&amp;'.repeat(299) + '…');
  });

  it('чужой текст сводится в одну строку: пересказ не подделает строку «Пользователь»', () => {
    const t = formatAssistantReport({ assistant: 'Ки\nра', kind: 'my_failure', summary: 'сломалось\n\nПользователь: 1 · веб', userId: 'u\n1', channel: 'web' });
    expect(t.split('\n')).toEqual([
      '🙋 <b>Ки ра: у меня не работает</b>',
      '«сломалось Пользователь: 1 · веб»',
      'Пользователь: <code>u 1</code> · веб',
    ]);
  });

  it('пустое имя — «Ассистент»', () => {
    expect(formatToolFailure({ assistant: '   ', tool: 'generate_video', error: 'x', userId: 'u1' }).split('\n')[0])
      .toBe('🛠 <b>Ассистент: не получилось создать видео</b>');
  });

  it('имена из прототипа объекта — незнакомые инструменты', () => {
    expect(toolAction('toString')).toBe('выполнить toString');
    expect(toolAction('constructor')).toBe('выполнить constructor');
  });

  it('согласование: 11–14, 101, 102, 111, 112', () => {
    expect([11, 12, 13, 14, 101, 102, 111, 112].map(timesRu))
      .toEqual(['11 раз', '12 раз', '13 раз', '14 раз', '101 раз', '102 раза', '111 раз', '112 раз']);
    expect([11, 14, 101, 102, 111].map(usersRu))
      .toEqual(['у 11 пользователей', 'у 14 пользователей', 'у 101 пользователя', 'у 102 пользователей', 'у 111 пользователей']);
  });

  it('clip: без пробела перед многоточием; огромный вход — только начало', () => {
    expect(clip('abc def', 5)).toBe('abc…');
    const big = clip('я'.repeat(5_000_000), 500);
    expect(Array.from(big).length).toBe(500);
    expect(oneLine('  a \n\t b  ')).toBe('a b');
  });

  it('head: огромный чужой текст — только начало, без одиночного суррогата на срезе', () => {
    const h = head('ж '.repeat(5_000_000), 40);
    expect(h.length).toBeLessThanOrEqual(16 * 40 + 1);
    expect(h.endsWith('…')).toBe(true);
    const tricky = head(' '.repeat(16 * 40 - 1) + '😀' + 'x'.repeat(100), 40);
    expect(tricky.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(tricky)).toBe(false);
    expect(head('коротко', 40)).toBe('коротко');
  });

  it('пересказ из пробелов вперемешку на миллионы символов — сообщение в пределах лимита', () => {
    const t = formatAssistantReport({ assistant: 'Кира', kind: 'my_failure', summary: 'ж '.repeat(5_000_000), userId: 'u1', channel: 'web' });
    expect(t.split('\n')[1].length).toBeLessThanOrEqual(502);
  });

  it('запасное имя экспортируется', () => {
    expect(FALLBACK_NAME).toBe('Ассистент');
  });

  it('уведомление о потолке пути А', () => {
    expect(formatToolCapNotice(20)).toBe(
      '🛠 <b>Слишком много разных сбоев инструментов</b>\n' +
      'За последний час отправлено столько сообщений о сбоях, сколько разрешено (20). ' +
      'Новые сбои до конца часа — только в логе сервера (строки «problem-report:»).',
    );
  });
});
