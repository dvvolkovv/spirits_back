import { parseClientUi } from './client-ui';

describe('parseClientUi — что умеет клиент чата', () => {
  it('объект от веба: обе возможности', () => {
    expect(parseClientUi({ activity: true, ask: true })).toEqual({ activity: true, ask: true });
  });

  it('строка с JSON — так приходит multipart загрузки файла', () => {
    expect(parseClientUi('{"activity":true}')).toEqual({ activity: true, ask: false });
  });

  it('нет поля — клиент ничего нового не умеет (мобилка, старый веб)', () => {
    expect(parseClientUi(undefined)).toEqual({ activity: false, ask: false });
  });

  it('признаётся только строгое true', () => {
    expect(parseClientUi({ activity: 'true', ask: 1 })).toEqual({ activity: false, ask: false });
  });

  it('мусор равен отсутствию поля', () => {
    expect(parseClientUi('{not json')).toEqual({ activity: false, ask: false });
    expect(parseClientUi(42)).toEqual({ activity: false, ask: false });
    expect(parseClientUi(null)).toEqual({ activity: false, ask: false });
  });
});
