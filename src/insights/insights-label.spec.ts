import {
  buildLabelPrompt,
  LABEL_BATCH,
  LABEL_SYSTEM,
  labelBatches,
  MAX_CONVERSATION_CHARS,
  parseLabels,
  renderConversation,
  type LabelInput,
} from './insights-label';
import type { Conversation } from './insights.types';
import { MAX_PROMPT_BYTES, promptBytes } from './prompt-size';

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

describe('labelBatches', () => {
  const noNames = () => [] as string[];
  const input = (n: number, text: string): LabelInput => ({
    person: n,
    conversation: conv({ key: `web:${n}`, userId: `u${n}`, turns: [{ role: 'user', text }] }),
  });

  it('короткие разговоры — по восемь в пачке, по порядку', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => input(i + 1, 'вопрос'));
    const batches = labelBatches(inputs, noNames);
    expect(batches.map((b) => b.length)).toEqual([LABEL_BATCH, LABEL_BATCH, 4]);
    expect(batches.flat()).toEqual(inputs);
  });

  it('длинные разговоры кириллицей — пачка вместе с инструкцией не длиннее предела', () => {
    const inputs = Array.from({ length: LABEL_BATCH }, (_, i) => input(i + 1, 'ж'.repeat(MAX_CONVERSATION_CHARS - 50)));
    // Одной пачкой такие восемь переходят предел аргумента Linux — так и было до разбиения по байтам.
    expect(promptBytes(LABEL_SYSTEM) + promptBytes(buildLabelPrompt(inputs, noNames))).toBeGreaterThan(128 * 1024);
    const batches = labelBatches(inputs, noNames);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(inputs);
    for (const b of batches) {
      expect(promptBytes(LABEL_SYSTEM) + promptBytes(buildLabelPrompt(b, noNames))).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    }
  });

  it('@ в тексте считается с обезвреживанием: пачка всё равно под пределом', () => {
    const inputs = Array.from({ length: LABEL_BATCH }, (_, i) => input(i + 1, '@'.repeat(MAX_CONVERSATION_CHARS - 50)));
    for (const b of labelBatches(inputs, noNames)) {
      expect(promptBytes(LABEL_SYSTEM) + promptBytes(buildLabelPrompt(b, noNames))).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    }
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
        { conv: 1, items: [{ type: 'other', about: 'x', severity: 2 }, { type: 'money', about: 'пишет «за что списали столько токенов вчера вечером»', severity: 2 }] },
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
