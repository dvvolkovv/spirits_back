import {
  clip, escapeHtml, formatAssistantReport, formatToolFailure, timesRu, toolAction, usersRu,
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
});
