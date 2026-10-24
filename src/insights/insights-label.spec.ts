import { buildLabelPrompt, MAX_CONVERSATION_CHARS, parseLabels, renderConversation, type LabelInput } from './insights-label';
import type { Conversation } from './insights.types';

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  key: 'web:1',
  source: 'web',
  userId: 'u1',
  assistant: 'Роман',
  turns: [
    { role: 'user', text: 'Я Владимир, мой телефон +7 903 016-91-87' },
    { role: 'assistant', text: 'Здравствуйте!' },
  ],
  ...over,
});

describe('renderConversation', () => {
  it('обезличивает реплики человека', () => {
    const out = renderConversation(conv(), ['Владимир']);
    expect(out).toContain('Человек: Я [имя], мой телефон [телефон]');
    expect(out).not.toContain('Владимир');
    expect(out).not.toMatch(/903/);
  });

  it('длинный ответ ассистента — начало и конец', () => {
    const long = 'а'.repeat(400) + 'СЕРЕДИНА' + 'б'.repeat(400);
    const out = renderConversation(conv({ turns: [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: long }] }), []);
    expect(out).toContain('[…]');
    expect(out).not.toContain('СЕРЕДИНА');
  });

  it('разговор не длиннее потолка', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `реплика ${'х'.repeat(200)} ${i}` }));
    const out = renderConversation(conv({ turns }), []);
    expect(out.length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARS + 100);
    expect(out).toContain('[…дальше разговор обрезан…]');
  });
});

describe('buildLabelPrompt', () => {
  it('нумерует разговоры и называет ассистента', () => {
    const batch: LabelInput[] = [{ person: 1, conversation: conv() }, { person: 2, conversation: conv({ assistant: 'Кира' }) }];
    const out = buildLabelPrompt(batch, () => ['Владимир']);
    expect(out).toContain('Разговор 1 (ассистент «Роман»)');
    expect(out).toContain('Разговор 2 (ассистент «Кира»)');
    expect(out).not.toContain('u1');
  });
});

describe('parseLabels', () => {
  const batch: LabelInput[] = [{ person: 7, conversation: conv() }];

  it('человек и ассистент — из пачки, а не из ответа', () => {
    const out = parseLabels('[{"conv":1,"items":[{"type":"confused","about":"путает два вида ботов","severity":3}]}]', batch);
    expect(out).toEqual([{ person: 7, assistant: 'Роман', type: 'confused', about: 'путает два вида ботов', severity: 3 }]);
  });

  it('чужой тип, цитата и разговор вне пачки отбрасываются', () => {
    const out = parseLabels(
      JSON.stringify([
        { conv: 1, items: [{ type: 'other', about: 'x', severity: 2 }, { type: 'money', about: 'сказал «дорого»', severity: 2 }] },
        { conv: 5, items: [{ type: 'money', about: 'дорого', severity: 2 }] },
      ]),
      batch,
    );
    expect(out).toEqual([]);
  });

  it('тяжесть вне 1–3 — 2', () => {
    const out = parseLabels('[{"conv":1,"items":[{"type":"money","about":"не понял списание","severity":9}]}]', batch);
    expect(out?.[0].severity).toBe(2);
  });

  it('не массив — null, повод повторить', () => {
    expect(parseLabels('{"oops":1}', batch)).toBeNull();
    expect(parseLabels('нет', batch)).toBeNull();
  });
});
