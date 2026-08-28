import { buildAssistantsKeyboard, PAGE_SIZE } from './tg-assistants-keyboard';

const agents = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, name: `A${i + 1}` }));

describe('buildAssistantsKeyboard', () => {
  it('на первой странице PAGE_SIZE ассистентов и кнопка «дальше»', () => {
    const kb = buildAssistantsKeyboard(agents, 0, 'A3');
    const rows = kb.inline_keyboard;
    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(rows[rows.length - 1].map((b: any) => b.text)).toEqual(['Дальше →']);
  });

  it('текущий ассистент помечен галочкой', () => {
    const kb = buildAssistantsKeyboard(agents, 0, 'A3');
    const marked = kb.inline_keyboard.flat().filter((b: any) => b.text.startsWith('✓'));
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('✓ A3');
  });

  it('callback_data несёт имя ассистента', () => {
    const kb = buildAssistantsKeyboard(agents, 0, null);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('agent:A1');
  });

  it('последняя страница — только кнопка «назад»', () => {
    const lastPage = Math.ceil(agents.length / PAGE_SIZE) - 1;
    const kb = buildAssistantsKeyboard(agents, lastPage, null);
    const nav = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(nav.map((b: any) => b.text)).toEqual(['← Назад']);
  });

  it('страница за пределами списка не падает и отдаёт пустой список', () => {
    const kb = buildAssistantsKeyboard(agents, 99, null);
    expect(
      kb.inline_keyboard.flat().filter((b: any) => b.callback_data?.startsWith('agent:')),
    ).toHaveLength(0);
  });
});
