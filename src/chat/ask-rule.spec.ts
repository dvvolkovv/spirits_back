import { ASK_RULE } from './ask-rule';

// Тесты на конкретные формулировки ниже — не хрупкость, а намеренная защита:
// это единственное место, проверяющее, что правило не разойдётся молча с
// парсером фронта (askBlock.ts) и с правилом «один вопрос» у части ассистентов.
describe('ASK_RULE', () => {
  it('пример в правиле — валидный JSON того формата, что разбирает фронт', () => {
    const m = /```ask\n([\s\S]*?)\n```/.exec(ASK_RULE);
    expect(m).not.toBeNull();
    const q = JSON.parse(m![1]).questions[0];
    expect(typeof q.question).toBe('string');
    expect(typeof q.header).toBe('string');
    expect(typeof q.multi).toBe('boolean');
    expect(q.options.length).toBeGreaterThanOrEqual(2);
  });

  it('«Свой вариант» модель не пишет — его добавляет фронт', () => {
    expect(ASK_RULE).toMatch(/Свой вариант.*добавляется сам/);
  });

  it('не спорит с правилом «один вопрос» там, где оно есть (Маша)', () => {
    expect(ASK_RULE).toMatch(/только один вопрос.*в карточке тоже один/);
  });
});
