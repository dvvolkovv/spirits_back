import { ASK_RULE } from './ask-rule';

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
