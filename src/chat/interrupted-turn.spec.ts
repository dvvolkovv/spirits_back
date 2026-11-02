import { INTERRUPTED_TURN_NOTE } from './interrupted-turn';

describe('INTERRUPTED_TURN_NOTE', () => {
  it('говорит, что прошлый ход прерван и результат не дошёл', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('тот ход прерван');
    expect(INTERRUPTED_TURN_NOTE).toContain('до человека не дошёл');
  });

  it('статус-вопрос — продолжить работу, а не отвечать статусом и не начинать заново', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('продолжи прерванную работу');
    expect(INTERRUPTED_TURN_NOTE).toContain('не отвечай одним статусом');
    expect(INTERRUPTED_TURN_NOTE).toContain('не начинай заново');
  });

  it('новая задача — делать новое', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('делай новое');
  });
});
