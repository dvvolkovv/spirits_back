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

  it('уточнение задачи — продолжить прерванную работу с учётом уточнения', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('уточняет задачу');
    expect(INTERRUPTED_TURN_NOTE).toContain('с учётом уточнения');
  });

  it('новая задача — делать новое', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('делай новое');
  });

  it('без повтора «в папке результата … доведи до результата»', () => {
    const count = (hay: string, needle: string) => hay.split(needle).length - 1;
    expect(count(INTERRUPTED_TURN_NOTE, 'результата')).toBe(1);
  });
});
