import { INTERRUPTED_TURN_NOTE, relayUndeliveredNote } from './interrupted-turn';

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
    expect(INTERRUPTED_TURN_NOTE).not.toContain('доведи до результата');
  });
});

describe('relayUndeliveredNote', () => {
  const carry = { message: 'посчитай смету', files: ['смета.xlsx', 'фото.jpg'] };

  it('говорит, что сообщение не дошло из-за обновления платформы', () => {
    const n = relayUndeliveredNote(carry);
    expect(n).toContain('не дошло');
    expect(n).toContain('платформа обновлялась');
  });

  it('цитирует текст недошедшего сообщения', () => {
    expect(relayUndeliveredNote(carry)).toContain('«посчитай смету»');
  });

  it('пустой или пробельный текст — без «Вот оно»', () => {
    expect(relayUndeliveredNote({ message: '', files: ['a.pdf'] })).not.toContain('Вот оно');
    expect(relayUndeliveredNote({ message: '  \n ', files: ['a.pdf'] })).not.toContain('Вот оно');
  });

  it('файлы перечисляются и просятся заново только когда они были', () => {
    const withFiles = relayUndeliveredNote(carry);
    expect(withFiles).toContain('смета.xlsx, фото.jpg');
    expect(withFiles).toContain('прислать их ещё раз');
    const noFiles = relayUndeliveredNote({ message: 'привет', files: [] });
    expect(noFiles).not.toContain('прислать их ещё раз');
    expect(noFiles).not.toContain('приложены');
  });

  it('не говорит «тот ход прерван» — ход не прерван, а не начинался', () => {
    expect(relayUndeliveredNote(carry)).not.toContain('тот ход прерван');
  });
});
