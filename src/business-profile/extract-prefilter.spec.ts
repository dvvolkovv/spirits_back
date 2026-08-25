import { shouldSkipBusinessExtraction } from './extract-prefilter';

describe('business extraction prefilter', () => {
  it('пропускает дальше реплики с фактами о бизнесе', () => {
    const passing = [
      'у меня ИП на УСН доходы',
      'оборот примерно полтора миллиона в месяц',
      'нас четверо, я и три мастера',
      'работаю на себя, самозанятый',
      'клиенты — женщины 25-45 из нашего района',
      'открыли вторую точку в Казани',
      'выручка упала до 800 тысяч',
      'мы ООО, платим НДС',
    ];
    for (const m of passing) {
      expect(shouldSkipBusinessExtraction(m)).toBe(false);
    }
  });

  it('срезает вежливости и короткие реплики без фактов', () => {
    const skipped = [
      'привет',
      'спасибо, всё понятно',
      'ок',
      'ага',
      '',
      '   ',
      'да',
      'а можно ещё раз?',
    ];
    for (const m of skipped) {
      expect(shouldSkipBusinessExtraction(m)).toBe(true);
    }
  });

  it('срезает длинные реплики, в которых нет ни одного бизнес-маркера', () => {
    expect(shouldSkipBusinessExtraction(
      'Расскажи пожалуйста подробнее про то как обычно строится такой разговор и что мне стоит ожидать дальше',
    )).toBe(true);
  });

  it('не срезает длинную реплику с одним бизнес-маркером в конце', () => {
    expect(shouldSkipBusinessExtraction(
      'Долго думал что делать дальше и решил всё-таки посоветоваться, потому что у меня ИП',
    )).toBe(false);
  });

  it('не принимает «ип» внутри другого слова за форму бизнеса', () => {
    expect(shouldSkipBusinessExtraction('в принципе да, согласен с таким подходом')).toBe(true);
    expect(shouldSkipBusinessExtraction('это типичная ситуация для нашей отрасли')).toBe(true);
  });

  it('ловит «ИП» как отдельное слово в любом регистре и позиции', () => {
    expect(shouldSkipBusinessExtraction('у меня ИП')).toBe(false);
    expect(shouldSkipBusinessExtraction('ип уже открыл в прошлом году')).toBe(false);
    expect(shouldSkipBusinessExtraction('оформил ИП, что дальше?')).toBe(false);
  });
});
