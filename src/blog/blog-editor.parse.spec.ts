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
